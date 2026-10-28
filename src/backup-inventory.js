'use strict';

// Service queue item 18, step one: find out what backups actually exist today, before building
// any verification. Read-only: lists files and reads settings, never creates, restores or deletes
// a backup. Each source comes back as one row:
//   { source, status: 'exists' | 'missing' | 'off' | 'unknown', detail, newestAt, count }
// 'unknown' means it couldn't be read from here (not configured, unreachable, or no API for it).

const fs = require('fs');
const path = require('path');
const axios = require('axios');

const base = url => String(url || '').replace(/\/+$/, '');
const fmtAge = ms => {
  const h = Math.floor(ms / 3600000);
  return h < 48 ? `${h}h` : `${Math.floor(h / 24)}d`;
};

// The bot's own SQLite backups: the in-process schedule, and whatever plex_invites-*.db files are
// in BACKUP_DIR (a host cron running scripts/backup-db.sh writes the same names).
function botDatabase({ intervalHours, backupDir, lastSuccessAt, now = Date.now(), fileSystem = fs }) {
  let files;
  try {
    files = fileSystem.readdirSync(backupDir).filter(f => /^plex_invites-.*\.db$/.test(f)).map(f => {
      const st = fileSystem.statSync(path.join(backupDir, f));
      return { name: f, mtime: st.mtimeMs, size: st.size };
    }).sort((a, b) => a.mtime - b.mtime);
  } catch (_err) { files = []; }
  const newest = files.at(-1) || null;
  const schedule = intervalHours > 0 ? `in-process every ${intervalHours}h` : 'in-process backup off (BACKUP_INTERVAL_HOURS=0)';
  const last = Number(lastSuccessAt) || 0;
  const parts = [schedule];
  if (newest) parts.push(`${files.length} file(s) in ${backupDir}, newest ${fmtAge(now - newest.mtime)} old`);
  else parts.push(`no backup files in ${backupDir}`);
  if (last) parts.push(`last in-process success ${fmtAge(now - last)} ago`);
  return {
    source: 'Bot database',
    status: newest ? 'exists' : intervalHours > 0 ? 'missing' : 'off',
    detail: parts.join('; '),
    newestAt: newest ? newest.mtime : null,
    count: files.length,
  };
}

// Sonarr / Radarr / Prowlarr keep their own config backups (scheduled, manual, pre-update). The
// list and the schedule are both readable over the API.
async function arrBackups(target, { http = axios, now = Date.now() } = {}) {
  const headers = { 'X-Api-Key': target.key };
  const root = `${base(target.url)}/api/${target.api}`;
  const [listRes, hostRes] = await Promise.all([
    http.get(`${root}/system/backup`, { headers, timeout: 15000 }),
    http.get(`${root}/config/host`, { headers, timeout: 15000 }).catch(() => ({ data: null })),
  ]);
  const list = (Array.isArray(listRes.data) ? listRes.data : [])
    .map(b => ({ type: b.type || 'unknown', time: Date.parse(b.time), size: Number(b.size) || 0 }))
    .filter(b => Number.isFinite(b.time))
    .sort((a, b) => a.time - b.time);
  const host = hostRes.data || {};
  const schedule = Number(host.backupInterval) > 0
    ? `scheduled every ${host.backupInterval}d, kept ${host.backupRetention ?? '?'}d${host.backupFolder ? `, folder ${host.backupFolder}` : ''}`
    : 'schedule not readable';
  const newest = list.at(-1) || null;
  return {
    source: target.app,
    status: newest ? 'exists' : 'missing',
    detail: newest
      ? `${list.length} backup(s), newest ${fmtAge(now - newest.time)} old (${newest.type}); ${schedule}`
      : `no backups listed; ${schedule}`,
    newestAt: newest ? newest.time : null,
    newestSize: newest ? newest.size : null,
    intervalDays: Number(host.backupInterval) > 0 ? Number(host.backupInterval) : null,
    count: list.length,
  };
}

// Plex's own scheduled database backup setting, when a local Plex URL and token are available.
async function plexBackupSetting({ url, token, http = axios }) {
  const res = await http.get(`${base(url)}/:/prefs`, { headers: { 'X-Plex-Token': token, Accept: 'application/json' }, timeout: 15000 });
  const settings = res.data?.MediaContainer?.Setting || [];
  const get = id => settings.find(s => s.id === id)?.value;
  const on = get('ButlerTaskBackupDatabase');
  if (on === undefined) return { source: 'Plex', status: 'unknown', detail: 'backup setting not found in Plex preferences', newestAt: null, count: null };
  return {
    source: 'Plex',
    settingOn: on === true || on === '1' || on === 1,
    status: on === true || on === '1' || on === 1 ? 'exists' : 'off',
    detail: on === true || on === '1' || on === 1
      ? `scheduled database backup on${get('ButlerDatabaseBackupPath') ? `, folder ${get('ButlerDatabaseBackupPath')}` : ''} (age of the newest copy isn't readable from the API)`
      : 'scheduled database backup off (Settings → Scheduled Tasks → Back up database)',
    newestAt: null,
    count: null,
  };
}

// Every source, in a fixed order. A source that can't be read is 'unknown' with the reason
// (HTTP status or error code only), never a failure of the whole inventory.
async function inventory(config, { http = axios, now = Date.now(), fileSystem = fs, lastSuccessAt = null, plex = null } = {}) {
  const rows = [botDatabase({ intervalHours: config.BACKUP_INTERVAL_HOURS, backupDir: config.BACKUP_DIR, lastSuccessAt, now, fileSystem })];
  const why = err => (err?.response?.status ? `HTTP ${err.response.status}` : err?.code || 'request failed');
  const arrs = [
    ['Sonarr', config.SONARR_URL, config.SONARR_API_KEY, 'v3'],
    ['Radarr', config.RADARR_URL, config.RADARR_API_KEY, 'v3'],
    ['Radarr 4K', config.RADARR_4K_URL, config.RADARR_4K_API_KEY, 'v3'],
    ['Prowlarr', config.PROWLARR_URL, config.PROWLARR_API_KEY, 'v1'],
  ];
  for (const [app, url, key, api] of arrs) {
    if (!url || !key) { rows.push({ source: app, status: 'unknown', detail: 'not configured in the bot', newestAt: null, count: null }); continue; }
    rows.push(await arrBackups({ app, url, key, api }, { http, now }).catch(err => ({ source: app, status: 'unknown', detail: `couldn't read (${why(err)})`, newestAt: null, count: null })));
  }
  if (plex?.url && plex?.token) {
    rows.push(await plexBackupSetting({ ...plex, http }).catch(err => ({ source: 'Plex', status: 'unknown', detail: `couldn't read preferences (${why(err)})`, newestAt: null, count: null })));
  } else {
    rows.push({ source: 'Plex', status: 'unknown', detail: 'no local PLEX_URL, so its backup setting wasn\'t read; check Settings → Scheduled Tasks → Back up database', newestAt: null, count: null });
  }
  rows.push({ source: 'Seerr', status: 'unknown', detail: 'no backup API; its config is the /app/config folder, covered only by whatever backs up appdata', newestAt: null, count: null });
  rows.push({ source: 'Tautulli', status: 'unknown', detail: 'backups aren\'t listable over its API; check Settings → Backup and its backups folder', newestAt: null, count: null });
  return rows;
}

// ---- Item 18, step two: verification for the backups the inventory found ----
// Only sources that exist are checked; nothing here restores or drills a backup.
//   *arr: the newest backup must be newer than its own schedule plus GRACE_DAYS, and not empty.
//   Plex: the scheduled database backup must still be on. The API doesn't expose the copies' age,
//         so that is all that can be checked honestly.
// The bot database is only checked when its in-process backup is on (it has its own overdue alert
// and /backup-rehearse), and Seerr/Tautulli have nothing readable, so they are not checked.
const GRACE_DAYS = 1;
const ARR_SOURCES = ['Sonarr', 'Radarr', 'Radarr 4K', 'Prowlarr'];

// One verdict per checkable source: { source, ok, problem } — problem is a short sentence when not
// ok. Sources that couldn't be read come back with ok: null (unknown), never as a failure.
function verifyBackups(rows, { now = Date.now(), graceDays = GRACE_DAYS } = {}) {
  const verdicts = [];
  for (const row of rows) {
    if (ARR_SOURCES.includes(row.source)) {
      if (row.status === 'unknown') { verdicts.push({ source: row.source, ok: null, problem: row.detail }); continue; }
      if (row.status === 'missing' || !row.newestAt) { verdicts.push({ source: row.source, ok: false, problem: 'no backups listed' }); continue; }
      const days = row.intervalDays || 7;
      const ageDays = (now - row.newestAt) / 86400000;
      if (ageDays > days + graceDays) {
        verdicts.push({ source: row.source, ok: false, problem: `newest backup is ${Math.floor(ageDays)} days old; it backs up every ${days} days` });
      } else if (row.newestSize === 0) {
        verdicts.push({ source: row.source, ok: false, problem: 'newest backup is an empty file' });
      } else {
        verdicts.push({ source: row.source, ok: true, problem: null });
      }
    } else if (row.source === 'Plex') {
      if (row.status === 'unknown') verdicts.push({ source: 'Plex', ok: null, problem: row.detail });
      else verdicts.push({ source: 'Plex', ok: !!row.settingOn, problem: row.settingOn ? null : 'scheduled database backup has been turned off' });
    }
  }
  return verdicts;
}

// Pure: which verdicts changed since the last check. A source that goes bad posts once; one that
// recovers after a reported problem posts once. Unknown (unreadable) results leave state alone.
// state: { [source]: { problem } } for sources currently reported bad.
function backupTransitions(verdicts, state = {}) {
  const next = { ...state };
  const failed = [];
  const recovered = [];
  for (const v of verdicts) {
    if (v.ok === null) continue;
    if (v.ok === false) {
      if (!state[v.source]) failed.push(v);
      next[v.source] = { problem: v.problem };
    } else if (state[v.source]) {
      recovered.push(v);
      delete next[v.source];
    }
  }
  return { failed, recovered, state: next };
}

module.exports = { botDatabase, arrBackups, plexBackupSetting, inventory, verifyBackups, backupTransitions, GRACE_DAYS };
