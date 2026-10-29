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
//
// Two script versions are understood; the deployed script is the system of record and this module
// adapts to it, never the other way round:
//   v1  YEARS_BACK=<n> (calendar years) and a literal DRY_RUN=true|false line.
//   v2  MONTHS_BACK=<n>, a rolling window anchored to the first of the current month (cutoff = the
//       first of the month N months before that), and DRY_RUN="${DRY_RUN:-false}". A literal
//       DRY_RUN=true|false line is accepted in v2 too.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

// Output markers. ADD and REMOVE/SKIP accept an optional "(reason)" before the colon, and ADD an
// optional trailing "(year: 2024)" or "(released: 2025-03-14)"-style note.
const ADD_RE = /^(?:WOULD ADD|ADDED)\s*(?:\([^)]*\))?:\s*(.+?)\s*(?:\((?:year|released|release|date|release date):\s*([^)]+)\))?\s*$/i;
const REMOVE_RE = /^(?:WOULD REMOVE|REMOVED)\s*(?:\([^)]*\))?:\s*(.+?)\s*$/i;
const SKIP_RE = /^(?:WOULD SKIP|SKIPPED)\s*(?:\([^)]*\))?:\s*(.+?)\s*$/i;
// Banner and summary lines the script prints around the list; not items, not "unrecognised".
const NOISE_RE = /^(?:={3,}.*|-{3,}.*|#.*|Done\.?|Summary.*|DRY RUN.*|Dry run.*)$/i;

// The DRY_RUN line in either accepted form: a literal true|false, or the v2 environment default.
const DRY_RUN_LINE_RE = /^DRY_RUN=(?:(true|false)|"\$\{DRY_RUN:-(true|false)\}")[ \t]*$/m;

// The first of the month `monthsBack` months before the first of `now`'s month, the way the v2
// script computes its cutoff (date -d "$(date +%Y-%m-01) -N months"). Local time, like the script.
function monthsCutoff(monthsBack, now = new Date()) {
  const d = new Date(now.getFullYear(), now.getMonth() - monthsBack, 1);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-01`;
}

function parseScriptConfig(text, { now = new Date() } = {}) {
  const get = re => {
    const m = re.exec(text);
    return m ? m[1] : null;
  };
  // A plain value or a "${VAR:-value}" default, quoted or not.
  const value = name => {
    const m = new RegExp(`^${name}=(?:"\\$\\{${name}:-([^}"]*)\\}"|"([^"]*)"|(\\S+))`, 'm').exec(text);
    return m ? (m[1] ?? m[2] ?? m[3]) : null;
  };
  const source = get(/^SOURCE="([^"]*)"/m) || value('SOURCE');
  const dest = get(/^DEST="([^"]*)"/m) || value('DEST');
  const dry = DRY_RUN_LINE_RE.exec(text);
  if (!source || !dest || !dry) return null;
  const dryRunDefault = (dry[1] || dry[2]) === 'true';
  const months = /^\d+$/.test(value('MONTHS_BACK') || '') ? Number(value('MONTHS_BACK')) : null;
  if (months != null) {
    return { version: 2, source, dest, dryRunDefault, window: { kind: 'months', monthsBack: months, cutoff: monthsCutoff(months, now) } };
  }
  const yearsBack = /^\d+$/.test(value('YEARS_BACK') || '') ? Number(value('YEARS_BACK')) : null;
  if (yearsBack == null) return null;
  const yearMax = now.getFullYear();
  return { version: 1, source, dest, dryRunDefault, window: { kind: 'years', yearsBack, yearMin: yearMax - yearsBack, yearMax } };
}

// How the card describes the window: rolling months for v2, a year range for v1.
function describeWindow(window) {
  if (!window) return '';
  if (window.kind === 'months') {
    const [y, m] = window.cutoff.split('-').map(Number);
    const label = new Date(y, m - 1, 1).toLocaleDateString('en-US', { day: 'numeric', month: 'long', year: 'numeric' });
    return `movies released within the last ${window.monthsBack} months (on or after ${label}, a rolling window from the first of this month)`;
  }
  return `movies ${window.yearMin}–${window.yearMax}`;
}

function parseScriptOutput(stdout) {
  const adds = [];
  const removes = [];
  const skips = [];
  // Lines that are neither an item nor known banner noise: shown to the operator rather than
  // silently dropped, so a marker the script changes can't hide part of a run.
  const other = [];
  for (const rawLine of String(stdout || '').split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    let m = ADD_RE.exec(line);
    if (m) { adds.push({ name: m[1], year: m[2] ? m[2].trim() : null }); continue; }
    m = REMOVE_RE.exec(line);
    if (m) { removes.push({ name: m[1] }); continue; }
    m = SKIP_RE.exec(line);
    if (m) { skips.push({ name: m[1] }); continue; }
    if (!NOISE_RE.test(line)) other.push(line);
  }
  return { adds, removes, skips, other };
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
    if (!DRY_RUN_LINE_RE.test(source)) {
      reject(new Error('Sync script has no recognised DRY_RUN line — refusing to run an unknown variant.'));
      return;
    }
    // Only the DRY_RUN line changes in the temp copy (either form becomes a literal), and the
    // child gets no inherited DRY_RUN either, so the mode is exactly the one asked for.
    const rewritten = source.replace(DRY_RUN_LINE_RE, `DRY_RUN=${dryRun ? 'true' : 'false'}`);
    const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'europe-sync-')), 'sync-latest-movies.sh');
    fs.writeFileSync(tmp, rewritten, { mode: 0o755 });

    const env = { ...process.env };
    delete env.DRY_RUN;
    const child = spawn('bash', [tmp], { stdio: ['ignore', 'pipe', 'pipe'], env });
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
// The preview tells the operator *which* movies would sync; the estimate tells them how
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

module.exports = { createEuropeSync, parseScriptConfig, parseScriptOutput, describeWindow, monthsCutoff, estimateSizes, defaultRunScript };
