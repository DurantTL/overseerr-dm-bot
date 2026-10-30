#!/usr/bin/env node
'use strict';
// PH sync progress and stall reporter. Report-only: GETs to the local Syncthing REST API, one
// statfs of the media drive, then a log line and a JSON report on PH. It never writes to
// Syncthing (no POST, pause, resume, rescan or restart) and never touches media files.
//
// Runs from PH's root cron every 15 minutes:  /opt/ph-sync-reporter/ph-sync-report.js
// Config comes from a root-only env file (default /etc/ph-sync-reporter.env, mode 600), never
// from the command line, so the Syncthing key is not visible in `ps` or the crontab.
// Node.js stdlib only (PH already runs Node.js 24 for the tier agent). See README.md.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_ENV_FILE = '/etc/ph-sync-reporter.env';
const DEFAULTS = {
  SYNCTHING_URL: 'http://127.0.0.1:8384',
  PH_SYNC_MEDIA_PATH: '/mnt/media',
  PH_SYNC_LOG_DIR: '/var/log/ph-sync-reporter',
  PH_SYNC_STATE_DIR: '/var/lib/ph-sync-reporter',
  PH_SYNC_KEEP_DAYS: '60',
  PH_SYNC_STALL_WINDOW_MINUTES: '120',
  PH_SYNC_STALL_MIN_MB: '100',
};
const HTTP_TIMEOUT_MS = 10000;
const RUN_TIMEOUT_MS = 120000;
const LOCK_STALE_MS = 10 * 60 * 1000;
const MB = 1000 * 1000;
// Syncthing (lib/fs/tempname.go): ".syncthing.<name>.tmp", or a SHA-256 of the base name when
// the base name is longer than 145 bytes.
const TEMP_PREFIX = '.syncthing.';
const TEMP_MAX_BASE = 160 - TEMP_PREFIX.length - '.tmp'.length;

class ReportError extends Error {
  constructor(message, reason) {
    super(message);
    this.reason = reason || 'error';
  }
}

// ---------------------------------------------------------------------------------------------
// Config

function parseEnvFile(text) {
  const out = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, '');
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && ((value[0] === '"' && value.endsWith('"')) || (value[0] === "'" && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

// Same two forms as the tier agent's TIER_FOLDERS, so the value can be copied from
// /etc/tier-agent.env: JSON [{"id":"…","path":"…"}] or compact "id:path;id:path".
function parseFolders(raw) {
  const text = String(raw || '').trim();
  if (!text) throw new ReportError('PH_SYNC_FOLDERS is not set', 'config');
  let folders;
  if (text.startsWith('[')) {
    let list;
    try { list = JSON.parse(text); } catch (_e) { throw new ReportError('PH_SYNC_FOLDERS is not valid JSON', 'config'); }
    if (!Array.isArray(list)) throw new ReportError('PH_SYNC_FOLDERS JSON must be a list', 'config');
    folders = list.map(f => ({ id: String((f && (f.id ?? f.folderId)) || ''), path: String((f && (f.path ?? f.root)) || '') }));
  } else {
    folders = text.split(';').map(s => s.trim()).filter(Boolean).map(pair => {
      const i = pair.indexOf(':');
      if (i < 1) throw new ReportError(`PH_SYNC_FOLDERS entry must be id:path (got "${pair}")`, 'config');
      return { id: pair.slice(0, i).trim(), path: pair.slice(i + 1).trim() };
    });
  }
  const seen = new Set();
  for (const f of folders) {
    if (!/^[A-Za-z0-9._-]+$/.test(f.id)) throw new ReportError(`PH_SYNC_FOLDERS has an invalid folder id "${f.id}"`, 'config');
    if (!path.isAbsolute(f.path)) throw new ReportError(`PH_SYNC_FOLDERS path for ${f.id} must be absolute`, 'config');
    if (seen.has(f.id)) throw new ReportError(`PH_SYNC_FOLDERS lists ${f.id} twice`, 'config');
    seen.add(f.id);
    f.path = path.resolve(f.path);
  }
  if (!folders.length) throw new ReportError('PH_SYNC_FOLDERS lists no folders', 'config');
  return folders;
}

function isLoopbackHost(hostname) {
  const h = String(hostname).replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h === '::1' || /^127\.\d+\.\d+\.\d+$/.test(h);
}

// The heartbeat is off unless BOTH the URL and the token are set. It never goes to the bot's
// uptime ingest (up/down samples only; sync progress there would pollute uptime_samples).
function heartbeatConfig(vars) {
  const url = String(vars.BOT_HEARTBEAT_URL || '').trim();
  const token = String(vars.BOT_HEARTBEAT_TOKEN || '').trim();
  if (!url && !token) return { enabled: false, note: 'off' };
  if (!url) return { enabled: false, note: 'off (BOT_HEARTBEAT_URL not set)' };
  if (!token) return { enabled: false, note: 'off (BOT_HEARTBEAT_TOKEN not set)' };
  let parsed;
  try { parsed = new URL(url); } catch (_e) { throw new ReportError('BOT_HEARTBEAT_URL is not a valid URL', 'config'); }
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLoopbackHost(parsed.hostname))) {
    throw new ReportError('BOT_HEARTBEAT_URL must be https (plain http only to this machine)', 'config');
  }
  if (/\/api\/uptime(\/|$)/i.test(parsed.pathname)) {
    throw new ReportError('BOT_HEARTBEAT_URL must not be the uptime ingest; sync progress is not an up/down sample', 'config');
  }
  return { enabled: true, url: parsed.toString(), token, note: 'on' };
}

function positiveNumber(vars, name) {
  const n = Number(vars[name]);
  if (!Number.isFinite(n) || n <= 0) throw new ReportError(`${name} must be a positive number`, 'config');
  return n;
}

function buildConfig(fileVars) {
  const vars = { ...DEFAULTS, ...Object.fromEntries(Object.entries(fileVars).filter(([, v]) => v !== '')) };
  const apiKey = String(vars.SYNCTHING_API_KEY || '').trim();
  if (!apiKey) throw new ReportError('SYNCTHING_API_KEY is not set in the env file', 'config');
  let stUrl;
  try { stUrl = new URL(vars.SYNCTHING_URL); } catch (_e) { throw new ReportError('SYNCTHING_URL is not a valid URL', 'config'); }
  if (stUrl.protocol !== 'https:' && !(stUrl.protocol === 'http:' && isLoopbackHost(stUrl.hostname))) {
    throw new ReportError('SYNCTHING_URL must be on this machine (http://127.0.0.1:8384) or https', 'config');
  }
  return {
    syncthingUrl: stUrl.toString().replace(/\/+$/, ''),
    apiKey,
    folders: parseFolders(vars.PH_SYNC_FOLDERS),
    mediaPath: path.resolve(vars.PH_SYNC_MEDIA_PATH),
    logDir: path.resolve(vars.PH_SYNC_LOG_DIR),
    stateDir: path.resolve(vars.PH_SYNC_STATE_DIR),
    keepDays: positiveNumber(vars, 'PH_SYNC_KEEP_DAYS'),
    stallWindowMs: positiveNumber(vars, 'PH_SYNC_STALL_WINDOW_MINUTES') * 60 * 1000,
    stallMinBytes: positiveNumber(vars, 'PH_SYNC_STALL_MIN_MB') * MB,
    heartbeat: heartbeatConfig(vars),
  };
}

// The env file holds the Syncthing key, so it must be readable by its owner only (like
// /etc/tier-agent.env). Refusing a loose file is louder than quietly using it.
function readEnvFile(file) {
  let st;
  try { st = fs.statSync(file); } catch (_e) { throw new ReportError(`env file ${file} not found`, 'config'); }
  if (!st.isFile()) throw new ReportError(`env file ${file} is not a file`, 'config');
  if (st.mode & 0o077) throw new ReportError(`env file ${file} must be readable by its owner only (chmod 600)`, 'config');
  if (typeof process.getuid === 'function' && process.getuid() === 0 && st.uid !== 0) {
    throw new ReportError(`env file ${file} must be owned by root`, 'config');
  }
  return parseEnvFile(fs.readFileSync(file, 'utf8'));
}

// ---------------------------------------------------------------------------------------------
// Syncthing (GET only)

function failureReason(err) {
  if (err instanceof ReportError) return err.reason;
  if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) return 'timeout';
  const code = err && ((err.cause && err.cause.code) || err.code);
  return code ? String(code) : 'network_error';
}

async function stGet(cfg, route) {
  let res;
  try {
    res = await fetch(`${cfg.syncthingUrl}${route}`, {
      method: 'GET',
      headers: { 'X-API-Key': cfg.apiKey, accept: 'application/json' },
      redirect: 'manual',
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
  } catch (err) {
    const reason = failureReason(err);
    throw new ReportError(`Syncthing API unreachable at ${cfg.syncthingUrl} (${reason})`, reason);
  }
  const pathOnly = route.split('?')[0];
  if (res.status === 401 || res.status === 403) {
    throw new ReportError(`Syncthing rejected the API key on GET ${pathOnly} (HTTP ${res.status})`, 'auth_rejected_check_key');
  }
  if (!res.ok) throw new ReportError(`Syncthing GET ${pathOnly} answered HTTP ${res.status}`, `http_${res.status}`);
  let text;
  try { text = await res.text(); } catch (err) {
    const reason = failureReason(err);
    throw new ReportError(`Syncthing GET ${pathOnly} broke off mid-answer (${reason})`, reason);
  }
  try {
    const body = JSON.parse(text);
    if (body && typeof body === 'object') return body;
  } catch (_e) { /* fall through */ }
  throw new ReportError(`Syncthing GET ${pathOnly} did not answer with JSON`, 'unexpected_response_not_json');
}

const num = v => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);

// Bytes already on disk for the files Syncthing is pulling right now, from their temp files.
// Allocated blocks, not the apparent size: blocks arrive out of order, so a temp file's length
// can jump to the full size long before its data is there. Unknown (null) when not readable.
function tempBytesFor(folder, progress) {
  const root = folder.path;
  let bytes = 0;
  let found = 0;
  let newest = 0;
  for (const item of progress) {
    const name = item && typeof item.name === 'string' ? item.name : '';
    if (!name) continue;
    const target = path.resolve(root, name);
    if (target !== root && !target.startsWith(root + path.sep)) continue; // never leave the folder root
    const base = path.basename(target);
    const tempBase = Buffer.byteLength(base) > TEMP_MAX_BASE
      ? `${TEMP_PREFIX}${crypto.createHash('sha256').update(base).digest('hex')}.tmp`
      : `${TEMP_PREFIX}${base}.tmp`;
    let st;
    try { st = fs.statSync(path.join(path.dirname(target), tempBase)); } catch (_e) { continue; }
    if (!st.isFile()) continue;
    found++;
    bytes += typeof st.blocks === 'number' ? st.blocks * 512 : st.size;
    newest = Math.max(newest, st.mtimeMs);
  }
  return { items: progress.length, tempFiles: found, tempBytes: bytes, lastTempWriteAt: newest ? new Date(newest).toISOString() : null };
}

async function readFolder(cfg, folder) {
  const enc = encodeURIComponent(folder.id);
  let conf;
  try {
    conf = await stGet(cfg, `/rest/config/folders/${enc}`);
  } catch (err) {
    if (err.reason === 'http_404') throw new ReportError(`folder ${folder.id} is not in Syncthing's config`, 'folder_missing');
    throw err;
  }
  const status = await stGet(cfg, `/rest/db/status?folder=${enc}`);
  const label = typeof conf.label === 'string' && conf.label.trim() ? conf.label.trim().replace(/[^\x20-\x7e]/g, '?').slice(0, 40) : folder.id;
  // Syncthing has no "paused" state: a paused folder has no runner, so db/status answers with
  // state "" and need counts from the database that mean nothing. Its need is unknown, never 0.
  // A folder that is not paused but has no runner either (it failed to start) is the same: unknown.
  if (conf.paused === true || status.state === '') {
    const state = conf.paused === true ? 'paused' : 'not-running';
    return { id: folder.id, label, state, paused: conf.paused === true, needBytes: null, needItems: null, needDeletes: null, inProgress: null };
  }
  if (typeof status.state !== 'string') throw new ReportError(`db/status for ${folder.id} has no state`, 'unexpected_response_shape');
  const needBytes = num(status.needBytes);
  if (needBytes === null) throw new ReportError(`db/status for ${folder.id} has no needBytes`, 'unexpected_response_shape');
  const needItems = num(status.needTotalItems) ?? (['needFiles', 'needDirectories', 'needSymlinks', 'needDeletes']
    .map(k => num(status[k])).reduce((a, b) => (a === null || b === null ? null : a + b), 0));
  const record = {
    id: folder.id,
    label,
    state: status.state,
    paused: false,
    needBytes,
    needItems,
    needDeletes: num(status.needDeletes),
    inProgress: null,
  };
  if (status.state === 'error' && typeof status.error === 'string' && status.error) {
    record.error = status.error.replace(/[^\x20-\x7e]/g, '?').slice(0, 200);
  }
  if (needBytes > 0) {
    // db/need answers {page, perpage, progress, queued, rest}; there is no "files" key. Only
    // "progress" (the files being pulled now) is used. Supplementary: a surprise here leaves
    // inProgress unknown instead of failing the run.
    try {
      const need = await stGet(cfg, `/rest/db/need?folder=${enc}&page=1&perpage=100`);
      if (Array.isArray(need.progress)) record.inProgress = tempBytesFor(folder, need.progress);
    } catch (err) {
      if (err.reason === 'auth_rejected_check_key') throw err;
    }
  }
  return record;
}

// ---------------------------------------------------------------------------------------------
// Disk

// The media drive's numbers, as df shows them (Size, Avail, Use%). Refuses a path that is not
// its own mount: an unmounted /mnt/media is a plain directory on the system disk, and its
// free space would be the wrong disk's.
function readDisk(mediaPath, fsImpl = fs) {
  let st;
  let parent;
  try {
    st = fsImpl.statSync(mediaPath);
    parent = fsImpl.statSync(path.dirname(mediaPath));
  } catch (_e) {
    throw new ReportError(`media path ${mediaPath} not found`, 'media_missing');
  }
  if (mediaPath !== path.dirname(mediaPath) && st.dev === parent.dev) {
    throw new ReportError(`nothing is mounted at ${mediaPath} (media drive missing?)`, 'media_not_mounted');
  }
  const s = fsImpl.statfsSync(mediaPath);
  return diskFromStatfs(mediaPath, s);
}

function diskFromStatfs(mediaPath, s) {
  const totalBytes = s.blocks * s.bsize;
  const freeBytes = s.bavail * s.bsize;
  const used = (s.blocks - s.bfree) * s.bsize;
  const usedPercent = used + freeBytes > 0 ? Math.ceil((used * 100) / (used + freeBytes)) : 0; // df's Use%
  return { path: mediaPath, totalBytes, freeBytes, usedPercent };
}

// ---------------------------------------------------------------------------------------------
// Stall logic

// One folder's stall verdict from its history (oldest first; the current sample last).
// Rules:
//  - paused (or not running): need unknown, stall unknown (null). Never read as progress.
//  - needBytes 0: converged (or only deletes/folders left): not stalled.
//  - need GREW since the previous sample: new content from the master, not a stall; the
//    window restarts from that sample.
//  - otherwise stalled when "still to download" (needBytes minus bytes already in temp files)
//    moved less than minBytes since the sample at least windowMs old. Until the folder has
//    that much unbroken history, it is "warming-up" (not stalled).
function evaluateStall(history, opts) {
  const now = history[history.length - 1];
  if (!now || now.need === null) return { stalled: null, status: now && now.paused ? 'paused' : 'need-unknown', movedBytes: null };
  if (now.need === 0) return { stalled: false, status: now.items ? 'finishing' : 'converged', movedBytes: null };
  let start = history.length - 1;
  let grew = false;
  while (start > 0) {
    const prev = history[start - 1];
    if (prev.need === null || prev.need === 0) break;
    if (prev.need < history[start].need) { grew = true; break; }
    start--;
  }
  // Two minutes of slack, so eight 15-minute runs make a 2-hour window despite cron jitter.
  const cutoff = now.t - opts.windowMs + 2 * 60 * 1000;
  let base = null;
  for (let i = history.length - 1; i >= start; i--) {
    if (history[i].t <= cutoff) { base = history[i]; break; }
  }
  if (!base) return { stalled: false, status: grew ? 'new-content' : 'warming-up', movedBytes: null, windowStart: new Date(history[start].t).toISOString() };
  const useTemp = base.temp !== null && now.temp !== null && base.temp !== undefined && now.temp !== undefined;
  const movedBytes = useTemp ? (base.need - base.temp) - (now.need - now.temp) : base.need - now.need;
  return {
    stalled: movedBytes < opts.minBytes,
    status: movedBytes < opts.minBytes ? 'stalled' : 'progressing',
    movedBytes,
    windowStart: new Date(base.t).toISOString(),
  };
}

function sampleFor(record, t) {
  return {
    t,
    paused: record.paused,
    need: record.needBytes,
    items: record.needItems,
    temp: record.inProgress ? record.inProgress.tempBytes : null,
  };
}

// ---------------------------------------------------------------------------------------------
// Formatting

function fmtBytes(n) {
  if (n === null || n === undefined) return '?';
  const sign = n < 0 ? '-' : '';
  const a = Math.abs(n);
  if (a >= 1024 ** 4) return `${sign}${(a / 1024 ** 4).toFixed(2)} TiB`;
  if (a >= 1024 ** 3) return `${sign}${(a / 1024 ** 3).toFixed(1)} GiB`;
  if (a >= 1024 ** 2) return `${sign}${(a / 1024 ** 2).toFixed(1)} MiB`;
  if (a === 0) return '0';
  return `${sign}${(a / 1024).toFixed(1)} KiB`;
}

function localStamp(date) {
  const off = -date.getTimezoneOffset();
  const local = new Date(date.getTime() + off * 60000).toISOString().slice(0, 19);
  const sign = off >= 0 ? '+' : '-';
  const hh = String(Math.floor(Math.abs(off) / 60)).padStart(2, '0');
  const mm = String(Math.abs(off) % 60).padStart(2, '0');
  return `${local}${sign}${hh}:${mm}`;
}

const localDate = date => localStamp(date).slice(0, 10);

function formatLogLine(report) {
  const parts = report.folders.map(f => {
    if (f.needBytes === null) return `${f.label} ${f.state} (need ?)`;
    const flag = f.stall.stalled ? ' STALLED' : '';
    return `${f.label} ${fmtBytes(f.needBytes)} ${f.state}${flag}`;
  });
  const t = report.totals;
  const total = t.totalNeedBytes === null ? `>=${fmtBytes(t.knownNeedBytes)} (some need unknown)` : fmtBytes(t.totalNeedBytes);
  const after = t.freeAfterDownloadsBytes === null ? '?' : fmtBytes(t.freeAfterDownloadsBytes);
  return `${localStamp(new Date(report.at))} OK need: ${parts.join(' | ')} | total ${total} | free ${fmtBytes(report.disk.freeBytes)} | after downloads ${after} | stall ${report.stalled ? 'YES' : 'no'}`;
}

// ---------------------------------------------------------------------------------------------
// Files

function ensureDir(dir, mode) {
  fs.mkdirSync(dir, { recursive: true, mode });
}

function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o640 });
  fs.renameSync(tmp, file);
}

function appendLine(file, line) {
  fs.appendFileSync(file, `${line}\n`, { mode: 0o640 });
}

function paths(cfg, date) {
  const day = localDate(date);
  return {
    log: path.join(cfg.logDir, `sync-${day}.log`),
    reports: path.join(cfg.stateDir, 'reports'),
    jsonl: path.join(cfg.stateDir, 'reports', `sync-${day}.jsonl`),
    latest: path.join(cfg.stateDir, 'latest.json'),
    state: path.join(cfg.stateDir, 'state.json'),
    lock: path.join(cfg.stateDir, 'run.lock'),
  };
}

// Dated files older than keepDays go, so the reporter can never fill PH's disk.
function pruneOld(dir, prefix, ext, keepDays, now) {
  let names;
  try { names = fs.readdirSync(dir); } catch (_e) { return; }
  const cutoff = now.getTime() - keepDays * 86400000;
  for (const name of names) {
    const m = name.match(/^(.+)-(\d{4}-\d{2}-\d{2})(\.[a-z]+)$/);
    if (!m || m[1] !== prefix || m[3] !== ext) continue;
    const t = Date.parse(`${m[2]}T00:00:00Z`);
    if (Number.isFinite(t) && t < cutoff) { try { fs.unlinkSync(path.join(dir, name)); } catch (_e) { /* next run retries */ } }
  }
}

function loadState(file) {
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (s && typeof s === 'object' && s.folders && typeof s.folders === 'object') return s;
  } catch (_e) { /* first run or unreadable: start fresh */ }
  return { folders: {} };
}

function takeLock(file, now) {
  try {
    fs.writeFileSync(file, String(process.pid), { flag: 'wx', mode: 0o640 });
    return true;
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
  let age = Infinity;
  try { age = now.getTime() - fs.statSync(file).mtimeMs; } catch (_e) { /* vanished */ }
  if (age < LOCK_STALE_MS) return false;
  fs.writeFileSync(file, String(process.pid), { mode: 0o640 });
  return true;
}

// ---------------------------------------------------------------------------------------------
// One run

async function sendHeartbeat(hb, report) {
  try {
    const res = await fetch(hb.url, {
      method: 'POST',
      headers: { authorization: `Bearer ${hb.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(report),
      redirect: 'manual',
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    return res.ok ? 'sent' : `failed (HTTP ${res.status})`;
  } catch (err) {
    return `failed (${failureReason(err)})`;
  }
}

// Measures everything first; nothing is written unless every folder and the disk were read.
async function measure(cfg, now, fsImpl) {
  const folders = [];
  for (const folder of cfg.folders) folders.push(await readFolder(cfg, folder));
  const disk = readDisk(cfg.mediaPath, fsImpl);
  return { folders, disk, at: now };
}

function buildReport(cfg, measured, state) {
  const t = measured.at.getTime();
  const nextState = { folders: {} };
  const transitions = [];
  const folders = measured.folders.map(rec => {
    const prev = state.folders[rec.id] || {};
    const keepAfter = t - cfg.stallWindowMs * 2;
    const history = (Array.isArray(prev.history) ? prev.history : []).filter(s => s && s.t >= keepAfter && s.t < t);
    history.push(sampleFor(rec, t));
    const stall = evaluateStall(history, { windowMs: cfg.stallWindowMs, minBytes: cfg.stallMinBytes });
    const wasStalled = prev.stalled === true;
    let stalledSince = wasStalled ? prev.stalledSince : null;
    if (stall.stalled === true && !wasStalled) {
      stalledSince = measured.at.toISOString();
      transitions.push({ kind: 'onset', folder: rec, stall });
    } else if (wasStalled && stall.stalled !== true) {
      transitions.push({ kind: 'recovery', folder: rec, stall, since: prev.stalledSince });
      stalledSince = null;
    }
    nextState.folders[rec.id] = { history, stalled: stall.stalled === true, stalledSince };
    return { ...rec, stall: { ...stall, since: stall.stalled ? stalledSince : null } };
  });
  const unknown = folders.filter(f => f.needBytes === null).map(f => f.id);
  const knownNeedBytes = folders.reduce((a, f) => a + (f.needBytes || 0), 0);
  const totalNeedBytes = unknown.length ? null : knownNeedBytes;
  const report = {
    ok: true,
    at: measured.at.toISOString(),
    node: 'ph',
    folders,
    disk: measured.disk,
    totals: {
      totalNeedBytes,
      knownNeedBytes,
      unknownNeedFolders: unknown,
      freeAfterDownloadsBytes: totalNeedBytes === null ? null : measured.disk.freeBytes - totalNeedBytes,
    },
    stalled: folders.some(f => f.stall.stalled === true),
    stallRule: { windowMinutes: cfg.stallWindowMs / 60000, minMovedBytes: cfg.stallMinBytes },
  };
  return { report, nextState, transitions };
}

function transitionLine(tr, at, cfg) {
  const f = tr.folder;
  const stamp = localStamp(at);
  if (tr.kind === 'onset') {
    return `${stamp} STALL START ${f.label} (${f.id}): still to download moved ${fmtBytes(tr.stall.movedBytes)} since ${localStamp(new Date(tr.stall.windowStart))} (threshold ${cfg.stallMinBytes / MB} MB per ${cfg.stallWindowMs / 60000} min), need ${fmtBytes(f.needBytes)}, state ${f.state}`;
  }
  return `${stamp} STALL END ${f.label} (${f.id}): now ${tr.stall.status}${tr.since ? `, stalled since ${localStamp(new Date(tr.since))}` : ''}`;
}

async function run({ envFile = DEFAULT_ENV_FILE, dryRun = false, now = new Date(), fsImpl = fs, out = process.stdout, err = process.stderr } = {}) {
  let cfg;
  try {
    cfg = buildConfig(readEnvFile(envFile));
  } catch (e) {
    err.write(`ph-sync-report: FAIL config: ${e.message}\n`);
    return 1;
  }
  const p = paths(cfg, now);
  if (!dryRun) {
    ensureDir(cfg.logDir, 0o755);
    ensureDir(p.reports, 0o750);
    if (!takeLock(p.lock, now)) {
      appendLine(p.log, `${localStamp(now)} FAIL previous run still active; skipped`);
      err.write('ph-sync-report: FAIL previous run still active\n');
      return 1;
    }
  }
  try {
    let measured;
    try {
      measured = await measure(cfg, now, fsImpl);
    } catch (e) {
      const reason = failureReason(e);
      const message = e instanceof ReportError ? e.message : `unexpected error (${reason})`;
      if (!dryRun) {
        appendLine(p.log, `${localStamp(now)} FAIL ${message}; no report this run`);
        const failure = { ok: false, at: now.toISOString(), node: 'ph', error: message, reason };
        appendLine(p.jsonl, JSON.stringify(failure));
        // latest.json must never show progress that was not just measured.
        writeAtomic(p.latest, `${JSON.stringify(failure, null, 2)}\n`);
      }
      err.write(`ph-sync-report: FAIL ${message}\n`);
      return 1;
    }
    const state = loadState(p.state);
    const { report, nextState, transitions } = buildReport(cfg, measured, state);
    report.heartbeat = cfg.heartbeat.note;
    if (dryRun) {
      out.write(`${formatLogLine(report)}\n`);
      for (const tr of transitions) out.write(`${transitionLine(tr, now, cfg)}\n`);
      out.write(`${JSON.stringify(report, null, 2)}\n`);
      return 0;
    }
    if (cfg.heartbeat.enabled) report.heartbeat = await sendHeartbeat(cfg.heartbeat, report);
    writeAtomic(p.state, `${JSON.stringify(nextState)}\n`);
    appendLine(p.log, formatLogLine(report));
    for (const tr of transitions) appendLine(p.log, transitionLine(tr, now, cfg));
    if (report.heartbeat.startsWith('failed')) appendLine(p.log, `${localStamp(now)} WARN heartbeat ${report.heartbeat}`);
    appendLine(p.jsonl, JSON.stringify(report));
    writeAtomic(p.latest, `${JSON.stringify(report, null, 2)}\n`);
    pruneOld(cfg.logDir, 'sync', '.log', cfg.keepDays, now);
    pruneOld(p.reports, 'sync', '.jsonl', cfg.keepDays, now);
    return 0;
  } finally {
    if (!dryRun) { try { fs.unlinkSync(p.lock); } catch (_e) { /* already gone */ } }
  }
}

function parseArgs(argv) {
  const opts = { envFile: DEFAULT_ENV_FILE, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dry-run') opts.dryRun = true;
    else if (argv[i] === '--env-file' && argv[i + 1]) opts.envFile = argv[++i];
    else if (argv[i] === '--help' || argv[i] === '-h') opts.help = true;
    else throw new ReportError(`unknown argument ${argv[i]}`, 'usage');
  }
  return opts;
}

if (require.main === module) {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); } catch (e) {
    process.stderr.write(`ph-sync-report: ${e.message}\n`);
    process.exit(2);
  }
  if (opts.help) {
    process.stdout.write('usage: ph-sync-report.js [--dry-run] [--env-file /etc/ph-sync-reporter.env]\n');
    process.exit(0);
  }
  const watchdog = setTimeout(() => {
    process.stderr.write('ph-sync-report: FAIL run took longer than 120 s\n');
    process.exit(1);
  }, RUN_TIMEOUT_MS);
  run(opts).then(code => {
    clearTimeout(watchdog);
    process.exitCode = code;
  }, e => {
    clearTimeout(watchdog);
    process.stderr.write(`ph-sync-report: FAIL ${e && e.message ? e.message : e}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  parseEnvFile, parseFolders, heartbeatConfig, buildConfig, readEnvFile, failureReason, stGet,
  readFolder, tempBytesFor, readDisk, diskFromStatfs, evaluateStall, buildReport, formatLogLine,
  fmtBytes, localStamp, pruneOld, run, ReportError,
};
