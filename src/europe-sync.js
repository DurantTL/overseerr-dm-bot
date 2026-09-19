'use strict';

// Europe node sync: the 1TB Europe Plex box (full 4K + family films, no TV, movies
// from 2024 on) is curated by sync-latest-movies.sh, which hardlinks qualifying
// movie folders into a Syncthing folder. This module shells out to that script —
// never reimplementing its year-window / video-file logic — and parses its output
// into structured adds/removes/skips for the dashboard.
//
// Safety: preview runs the script with DRY_RUN=true (read-only apart from a
// mkdir -p). A real run hardlinks new movies (no extra disk on the master) and
// removes aged-out *hardlinks* from the sync folder — the source library is never
// touched, but Europe does lose those titles, so the dashboard gates runs behind
// a confirmation and an audit record.
//
// The script is executed from a temp copy with only the DRY_RUN line rewritten,
// so the server's script file is never modified by the bot.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ADD_RE = /^(?:WOULD ADD|ADDED):\s*(.+?)\s*(?:\(year:\s*(\d{4})\))?\s*$/;
const REMOVE_RE = /^(?:WOULD REMOVE|REMOVED)\s*(?:\([^)]*\))?:\s*(.+?)\s*$/;
const SKIP_RE = /^SKIPPED\s*(?:\([^)]*\))?:\s*(.+?)\s*$/;

function parseScriptConfig(text) {
  const get = re => {
    const m = re.exec(text);
    return m ? m[1] : null;
  };
  const source = get(/^SOURCE="([^"]*)"/m);
  const dest = get(/^DEST="([^"]*)"/m);
  const yearsBack = parseInt(get(/^YEARS_BACK=(\d+)/m) || '', 10);
  const dryRun = get(/^DRY_RUN=(true|false)/m);
  if (!source || !dest || !Number.isInteger(yearsBack) || !dryRun) return null;
  const yearMax = new Date().getFullYear();
  return { source, dest, yearsBack, dryRunDefault: dryRun === 'true', yearMin: yearMax - yearsBack, yearMax };
}

function parseScriptOutput(stdout) {
  const adds = [];
  const removes = [];
  const skips = [];
  for (const rawLine of String(stdout || '').split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    let m = ADD_RE.exec(line);
    if (m) { adds.push({ name: m[1], year: m[2] || null }); continue; }
    m = REMOVE_RE.exec(line);
    if (m) { removes.push({ name: m[1] }); continue; }
    m = SKIP_RE.exec(line);
    if (m) { skips.push({ name: m[1] }); }
  }
  return { adds, removes, skips };
}

// Default runner: copy the script to a temp file with the DRY_RUN line rewritten,
// execute it with bash, capture stdout. Rejects on spawn error, timeout, or a
// non-zero exit.
function defaultRunScript(scriptPath, dryRun, { timeoutMs = 5 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    let source;
    try {
      source = fs.readFileSync(scriptPath, 'utf8');
    } catch (err) {
      reject(new Error(`Sync script not found at ${scriptPath}`));
      return;
    }
    if (!/^DRY_RUN=(true|false)/m.test(source)) {
      reject(new Error('Sync script has no DRY_RUN line — refusing to run an unknown variant.'));
      return;
    }
    const rewritten = source.replace(/^DRY_RUN=(true|false)/m, `DRY_RUN=${dryRun ? 'true' : 'false'}`);
    const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'europe-sync-')), 'sync-latest-movies.sh');
    fs.writeFileSync(tmp, rewritten, { mode: 0o755 });

    const child = spawn('bash', [tmp], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Sync script timed out.'));
    }, timeoutMs);
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', err => {
      clearTimeout(timer);
      try { fs.rmSync(path.dirname(tmp), { recursive: true, force: true }); } catch (_e) {}
      reject(err);
    });
    child.on('close', code => {
      clearTimeout(timer);
      try { fs.rmSync(path.dirname(tmp), { recursive: true, force: true }); } catch (_e) {}
      if (code !== 0) {
        reject(new Error(`Sync script exited with code ${code}${stderr.trim() ? `: ${stderr.trim().slice(0, 300)}` : ''}`));
        return;
      }
      resolve(stdout);
    });
  });
}

// ---- Space estimates ----
// The preview tells Caleb *which* movies would sync; the estimate tells him how
// much room Europe needs for them. Hardlinks cost nothing extra on the master,
// but the 1TB Europe disk holds the actual bytes. Sizes come from du against the
// script's own SOURCE/DEST dirs (parsed from its config) — never from a
// reimplementation of its filtering. Bounded by folder count and a timeout; any
// failure degrades to nulls so the preview still works.

const ESTIMATE_MAX_FOLDERS = 200;
const ESTIMATE_TIMEOUT_MS = 60 * 1000;

function runCmd(cmd, args, timeoutMs) {
  return new Promise(resolve => {
    let stdout = '';
    let settled = false;
    const child = spawn(cmd, args, { timeout: timeoutMs });
    child.stdout.on('data', d => { stdout += d; });
    child.on('error', () => { if (!settled) { settled = true; resolve(null); } });
    child.on('close', code => { if (!settled) { settled = true; resolve(code === 0 ? stdout : null); } });
  });
}

function safeJoin(base, name) {
  const root = path.resolve(base) + path.sep;
  const resolved = path.resolve(base, name);
  return resolved.startsWith(root) ? resolved : null;
}

async function estimateSizes({ source, dest, adds }) {
  const out = {
    estimatedNewBytes: null,
    measuredFolders: 0,
    totalFolders: (adds || []).length,
    destBytes: null,
    destFreeBytes: null,
  };
  if (!source || !dest) return out;
  try {
    const dirs = (adds || [])
      .slice(0, ESTIMATE_MAX_FOLDERS)
      .map(a => a && a.name)
      .filter(Boolean)
      .map(name => safeJoin(source, name))
      .filter(Boolean);
    if (dirs.length) {
      const du = await runCmd('du', ['-sb', '--', ...dirs], ESTIMATE_TIMEOUT_MS);
      if (du) {
        let total = 0;
        let count = 0;
        for (const line of du.split('\n')) {
          const m = /^(\d+)\t/.exec(line);
          if (m) { total += Number(m[1]); count++; }
        }
        if (count) { out.estimatedNewBytes = total; out.measuredFolders = count; }
      }
    }
    const destDu = await runCmd('du', ['-sb', '--', dest], ESTIMATE_TIMEOUT_MS);
    if (destDu) {
      const m = /^(\d+)\t/.exec(destDu);
      if (m) out.destBytes = Number(m[1]);
    }
    const df = await runCmd('df', ['-B1', '--output=avail', '--', dest], ESTIMATE_TIMEOUT_MS);
    if (df) {
      const avail = Number(df.trim().split('\n').pop());
      if (Number.isFinite(avail)) out.destFreeBytes = avail;
    }
  } catch (_e) { /* degrade to nulls */ }
  return out;
}

function createEuropeSync({ scriptPath, runScript = defaultRunScript } = {}) {
  if (!scriptPath) throw new Error('createEuropeSync requires scriptPath');

  function getStatus() {
    let config = null;
    let scriptFound = false;
    let executable = false;
    try {
      const text = fs.readFileSync(scriptPath, 'utf8');
      scriptFound = true;
      config = parseScriptConfig(text);
      try {
        fs.accessSync(scriptPath, fs.constants.X_OK);
        executable = true;
      } catch (_e) { /* readable but not executable */ }
    } catch (_e) { /* script not present on this host */ }
    return { scriptPath, scriptFound, executable, config };
  }

  async function preview() {
    const stdout = await runScript(scriptPath, true);
    return { ...parseScriptOutput(stdout), raw: stdout };
  }

  async function run() {
    const stdout = await runScript(scriptPath, false);
    return { ...parseScriptOutput(stdout), raw: stdout };
  }

  return { getStatus, preview, run, estimateSizes, parseScriptConfig, parseScriptOutput };
}

module.exports = { createEuropeSync, parseScriptConfig, parseScriptOutput, estimateSizes, defaultRunScript };
