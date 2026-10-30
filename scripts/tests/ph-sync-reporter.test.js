#!/usr/bin/env node
// PH sync reporter (deploy/ph-sync-reporter): stall logic, paused/unknown need, and whole runs
// against a fake Syncthing REST API. No real Syncthing, no network beyond 127.0.0.1.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', '..', 'deploy', 'ph-sync-reporter', 'ph-sync-report.js');
const R = require(SCRIPT);

const KEY = 'test-placeholder-key-0123456789';
const GiB = 1024 ** 3;
const MB = 1000 * 1000;
const WINDOW = { windowMs: 120 * 60000, minBytes: 100 * MB };
const T0 = Date.parse('2026-10-29T12:00:00Z');
const at = n => T0 + n * 15 * 60000;

// ---------------------------------------------------------------------------------------------
// Fake Syncthing

function fakeSyncthing(initial) {
  const state = { folders: initial, requests: [], authFail: false, down: false };
  const server = http.createServer((req, res) => {
    state.requests.push({ method: req.method, url: req.url, key: req.headers['x-api-key'] });
    const send = (code, body) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };
    if (req.method !== 'GET') return send(405, { error: 'reporter must only GET' });
    if (state.authFail || req.headers['x-api-key'] !== KEY) return send(403, 'CSRF Error');
    const url = new URL(req.url, 'http://x');
    const cfgMatch = url.pathname.match(/^\/rest\/config\/folders\/(.+)$/);
    const id = cfgMatch ? decodeURIComponent(cfgMatch[1]) : url.searchParams.get('folder');
    const f = state.folders[id];
    if (!f) return send(404, 'No folder with given ID');
    if (cfgMatch) return send(200, { id, label: f.label, path: `/data/${f.label}`, type: 'receiveonly', paused: !!f.paused });
    if (url.pathname === '/rest/db/status') {
      if (f.paused || f.notRunning) {
        // Syncthing v2.1.7: no runner, state "", stale numbers from the database.
        return send(200, { state: '', needBytes: 5 * GiB, needTotalItems: 9, needDeletes: 0, error: '' });
      }
      return send(200, { state: f.state, needBytes: f.needBytes, needTotalItems: f.needItems ?? 0, needDeletes: f.needDeletes ?? 0, needFiles: f.needItems ?? 0, error: f.error || '' });
    }
    if (url.pathname === '/rest/db/need') {
      return send(200, { page: 1, perpage: Number(url.searchParams.get('perpage')), progress: f.progress || [], queued: [], rest: [] });
    }
    return send(404, 'not found');
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    state.url = `http://127.0.0.1:${server.address().port}`;
    state.close = () => new Promise(r => { server.close(r); server.closeAllConnections(); });
    resolve(state);
  }));
}

function tmpdir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ph-sync-${name}-`));
}

function writeEnv(dir, vars) {
  const file = path.join(dir, 'reporter.env');
  fs.writeFileSync(file, Object.entries(vars).map(([k, v]) => `${k}=${v}`).join('\n') + '\n', { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return file;
}

function setup(st, extra = {}) {
  const dir = tmpdir('run');
  const media = path.join(dir, 'media');
  for (const sub of ['Family Films', '4k', 'Movies', 'TV Shows']) fs.mkdirSync(path.join(media, 'Media', sub), { recursive: true });
  const envFile = writeEnv(dir, {
    SYNCTHING_URL: st.url,
    SYNCTHING_API_KEY: KEY,
    PH_SYNC_FOLDERS: `"fam-aaaaa:${media}/Media/Family Films;fourk-bbbbb:${media}/Media/4k;mov-ccccc:${media}/Media/Movies;tv-ddddd:${media}/Media/TV Shows"`,
    PH_SYNC_MEDIA_PATH: '/', // always its own mount; the not-mounted case is tested separately
    PH_SYNC_LOG_DIR: path.join(dir, 'log'),
    PH_SYNC_STATE_DIR: path.join(dir, 'lib'),
    ...extra,
  });
  return { dir, media, envFile, logDir: path.join(dir, 'log'), stateDir: path.join(dir, 'lib') };
}

function sink() {
  const chunks = [];
  return { write: s => { chunks.push(s); return true; }, text: () => chunks.join('') };
}

function readAll(dir) {
  const out = [];
  const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else out.push(fs.readFileSync(p, 'utf8')); } };
  walk(dir);
  return out.join('\n');
}

const folders = () => ({
  'fam-aaaaa': { label: 'Family Films', state: 'syncing', needBytes: 2.6 * GiB, needItems: 3 },
  'fourk-bbbbb': { label: '4K', state: 'idle', needBytes: 0, needItems: 0 },
  'mov-ccccc': { label: 'Movies', state: 'syncing', needBytes: 9.8 * GiB, needItems: 5 },
  'tv-ddddd': { label: 'TV Shows', state: 'syncing', needBytes: 57.2 * GiB, needItems: 400 },
});

// ---------------------------------------------------------------------------------------------
// Stall logic

const s = (n, need, extra = {}) => ({ t: at(n), paused: false, need, items: need ? 1 : 0, temp: null, ...extra });

test('stall: syncing and progressing over the window is not a stall', () => {
  const h = Array.from({ length: 9 }, (_, i) => s(i, 10 * GiB - i * 200 * MB));
  const v = R.evaluateStall(h, WINDOW);
  assert.strictEqual(v.stalled, false);
  assert.strictEqual(v.status, 'progressing');
  assert.strictEqual(v.movedBytes, 1600 * MB);
});

test('stall: need flat (under 100 MB) for 2 hours while syncing sets the flag', () => {
  const h = Array.from({ length: 9 }, (_, i) => s(i, 10 * GiB - i * 10 * MB));
  const v = R.evaluateStall(h, WINDOW);
  assert.strictEqual(v.stalled, true);
  assert.strictEqual(v.status, 'stalled');
  assert.strictEqual(v.movedBytes, 80 * MB);
});

test('stall: under 2 hours of history is warming up, never a stall', () => {
  const h = Array.from({ length: 8 }, (_, i) => s(i, 10 * GiB)); // 7 intervals = 1 h 45 min
  const v = R.evaluateStall(h, WINDOW);
  assert.strictEqual(v.stalled, false);
  assert.strictEqual(v.status, 'warming-up');
});

test('stall: need GROWING is new master content, not a stall; the window restarts after it', () => {
  const flat = Array.from({ length: 9 }, (_, i) => s(i, 9 * GiB));
  flat.push(s(9, 12 * GiB)); // a new title landed on the master
  let v = R.evaluateStall(flat, WINDOW);
  assert.strictEqual(v.stalled, false);
  assert.strictEqual(v.status, 'new-content');
  // Still flat 2 hours after the growth: now it is a stall.
  for (let i = 10; i <= 17; i++) flat.push(s(i, 12 * GiB));
  v = R.evaluateStall(flat, WINDOW);
  assert.strictEqual(v.stalled, true);
});

test('stall: need 0 with state idle is converged, not stalled', () => {
  const h = Array.from({ length: 9 }, (_, i) => s(i, 0));
  const v = R.evaluateStall(h, WINDOW);
  assert.deepStrictEqual([v.stalled, v.status], [false, 'converged']);
});

test('stall: a paused folder is unknown (null), never 0-as-progress, and breaks the window', () => {
  const h = Array.from({ length: 9 }, (_, i) => s(i, 10 * GiB));
  h.push({ t: at(9), paused: true, need: null, items: null, temp: null });
  let v = R.evaluateStall(h, WINDOW);
  assert.deepStrictEqual([v.stalled, v.status], [null, 'paused']);
  // Resumed: the paused sample is not read as progress, and the window starts over.
  h.push(s(10, 10 * GiB));
  v = R.evaluateStall(h, WINDOW);
  assert.deepStrictEqual([v.stalled, v.status], [false, 'warming-up']);
});

test('stall: one big file landing in its temp file counts as progress even with need flat', () => {
  // needBytes only drops when a whole file completes; a 6 GiB movie at a slow share of the link
  // takes hours. Temp-file bytes on disk show it is moving.
  const h = Array.from({ length: 9 }, (_, i) => s(i, 9.8 * GiB, { temp: i * 50 * MB }));
  const v = R.evaluateStall(h, WINDOW);
  assert.strictEqual(v.stalled, false);
  assert.strictEqual(v.movedBytes, 400 * MB);
  // Temp file not written for 2 hours (the Oct 28 pattern): stalled.
  const dead = Array.from({ length: 9 }, () => 0).map((_, i) => s(i, 9.8 * GiB, { temp: 300 * MB }));
  assert.strictEqual(R.evaluateStall(dead, WINDOW).stalled, true);
});

test('stall: a file completing is counted once, not twice', () => {
  // 1 GiB file half in temp; it completes: need drops 1 GiB, temp drops 0.5 GiB -> 0.5 GiB moved.
  const h = [s(0, 5 * GiB, { temp: 0.5 * GiB }), ...Array.from({ length: 8 }, (_, i) => s(i + 1, 4 * GiB, { temp: 0 }))];
  const v = R.evaluateStall(h, WINDOW);
  assert.strictEqual(v.movedBytes, 0.5 * GiB);
});

// ---------------------------------------------------------------------------------------------
// Folder reads against the fake API

test('readFolder: paused folder reads need unknown even though db/status carries stale numbers', async () => {
  const st = await fakeSyncthing({ 'mov-ccccc': { label: 'Movies', paused: true } });
  try {
    const rec = await R.readFolder({ syncthingUrl: st.url, apiKey: KEY }, { id: 'mov-ccccc', path: '/x' });
    assert.strictEqual(rec.state, 'paused');
    assert.strictEqual(rec.needBytes, null);
    assert.strictEqual(rec.needItems, null);
    assert.ok(!st.requests.some(r => r.url.includes('/rest/db/completion')), 'db/completion must never be used');
    assert.ok(st.requests.every(r => r.method === 'GET'));
  } finally { await st.close(); }
});

test('readFolder: state "" while not paused is not-running with need unknown', async () => {
  const st = await fakeSyncthing({ 'mov-ccccc': { label: 'Movies', notRunning: true } });
  try {
    const rec = await R.readFolder({ syncthingUrl: st.url, apiKey: KEY }, { id: 'mov-ccccc', path: '/x' });
    assert.deepStrictEqual([rec.state, rec.needBytes], ['not-running', null]);
  } finally { await st.close(); }
});

test('readFolder: in-progress temp files are measured from db/need "progress" (no "files" key)', async () => {
  const dir = tmpdir('temp');
  fs.mkdirSync(path.join(dir, 'Big (2020)'));
  fs.writeFileSync(path.join(dir, 'Big (2020)', '.syncthing.Big (2020).mkv.tmp'), crypto.randomBytes(256 * 1024));
  const longBase = `${'x'.repeat(150)}.mkv`;
  fs.writeFileSync(path.join(dir, `.syncthing.${crypto.createHash('sha256').update(longBase).digest('hex')}.tmp`), crypto.randomBytes(64 * 1024));
  const st = await fakeSyncthing({
    'mov-ccccc': { label: 'Movies', state: 'syncing', needBytes: 6 * GiB, needItems: 2, progress: [{ name: 'Big (2020)/Big (2020).mkv', size: 6 * GiB }, { name: longBase, size: 1 }, { name: '../../etc/passwd', size: 1 }] },
  });
  try {
    const rec = await R.readFolder({ syncthingUrl: st.url, apiKey: KEY }, { id: 'mov-ccccc', path: dir });
    assert.strictEqual(rec.inProgress.items, 3);
    assert.strictEqual(rec.inProgress.tempFiles, 2, 'plain and hashed temp names found; path outside the folder ignored');
    assert.ok(rec.inProgress.tempBytes >= 320 * 1024);
    assert.ok(rec.inProgress.lastTempWriteAt);
    assert.match(st.requests.find(r => r.url.startsWith('/rest/db/need')).url, /perpage=100/);
  } finally { await st.close(); }
});

// ---------------------------------------------------------------------------------------------
// Disk

test('disk: matches df (Size, Avail, Use%) on a real filesystem', () => {
  const df = spawnSync('df', ['-B1', '--output=size,avail,pcent', '/'], { encoding: 'utf8' });
  if (df.status !== 0) return; // no GNU df here
  const [size, avail, pcent] = df.stdout.trim().split('\n').pop().trim().split(/\s+/);
  const d = R.readDisk('/');
  assert.strictEqual(d.totalBytes, Number(size));
  assert.ok(Math.abs(d.freeBytes - Number(avail)) < 64 * 1024 * 1024, 'free within 64 MiB of df (the disk is live)');
  assert.ok(Math.abs(d.usedPercent - parseInt(pcent, 10)) <= 1);
});

test('disk: PH-like layout; a separately mounted drive reads, an unmounted /mnt/media is refused', () => {
  // A drive mounted at /mnt/media (different device from /mnt), as on PH's LaCie.
  const fake = {
    statSync: p => ({ '/mnt/media': { dev: 2049 }, '/mnt': { dev: 64768 } }[p]),
    statfsSync: () => ({ bsize: 4096, blocks: 1220942336, bfree: 76881920, bavail: 76881920 }),
  };
  const d = R.readDisk('/mnt/media', fake);
  assert.deepStrictEqual(d, { path: '/mnt/media', totalBytes: 1220942336 * 4096, freeBytes: 76881920 * 4096, usedPercent: 94 });
  // Drive missing: /mnt/media is just a directory on the system disk.
  const missing = { ...fake, statSync: () => ({ dev: 64768 }) };
  assert.throws(() => R.readDisk('/mnt/media', missing), e => e.reason === 'media_not_mounted');
  const realDir = tmpdir('nomount');
  assert.throws(() => R.readDisk(realDir), e => e.reason === 'media_not_mounted');
});

// ---------------------------------------------------------------------------------------------
// Whole runs

test('run: 9 runs at 15 min; stall onset logged once, recovery logged, outputs carry no key', async () => {
  const st = await fakeSyncthing(folders());
  const env = setup(st);
  try {
    const out = sink();
    const err = sink();
    for (let i = 0; i <= 8; i++) {
      st.folders['tv-ddddd'].needBytes -= 500 * MB; // TV progressing
      st.folders['fam-aaaaa'].needBytes += i === 4 ? 1 * GiB : 0; // Family: new content arrives
      const code = await R.run({ envFile: env.envFile, now: new Date(at(i)), out, err });
      assert.strictEqual(code, 0, err.text());
    }
    let latest = JSON.parse(fs.readFileSync(path.join(env.stateDir, 'latest.json'), 'utf8'));
    const byId = Object.fromEntries(latest.folders.map(f => [f.id, f]));
    assert.strictEqual(byId['mov-ccccc'].stall.stalled, true, 'Movies flat for 2 h');
    assert.strictEqual(byId['tv-ddddd'].stall.status, 'progressing');
    assert.strictEqual(byId['fam-aaaaa'].stall.status, 'new-content');
    assert.strictEqual(byId['fourk-bbbbb'].stall.status, 'converged');
    assert.strictEqual(latest.stalled, true);
    assert.strictEqual(latest.totals.totalNeedBytes, latest.folders.reduce((a, f) => a + f.needBytes, 0));
    assert.strictEqual(latest.totals.freeAfterDownloadsBytes, latest.disk.freeBytes - latest.totals.totalNeedBytes);
    assert.strictEqual(latest.heartbeat, 'off');

    // Movies starts moving again: recovery.
    st.folders['mov-ccccc'].needBytes -= 2 * GiB;
    assert.strictEqual(await R.run({ envFile: env.envFile, now: new Date(at(9)), out, err }), 0);
    latest = JSON.parse(fs.readFileSync(path.join(env.stateDir, 'latest.json'), 'utf8'));
    assert.strictEqual(latest.stalled, false);

    const logs = fs.readdirSync(env.logDir);
    assert.deepStrictEqual(logs.map(n => /^sync-\d{4}-\d{2}-\d{2}\.log$/.test(n)), logs.map(() => true));
    const log = readAll(env.logDir);
    assert.strictEqual(log.match(/STALL START Movies/g).length, 1);
    assert.strictEqual(log.match(/STALL END Movies/g).length, 1);
    assert.strictEqual(log.match(/ OK need: /g).length, 10);
    assert.match(log, /stall YES/);
    const reports = readAll(path.join(env.stateDir, 'reports')).trim().split('\n');
    assert.strictEqual(reports.length, 10);
    assert.ok(reports.every(l => JSON.parse(l).ok === true));
    assert.ok(!readAll(env.dir).replace(fs.readFileSync(env.envFile, 'utf8'), '').includes(KEY), 'key appears in no output');
    assert.ok(st.requests.every(r => r.method === 'GET'));
    assert.ok(!st.requests.some(r => r.url.includes('completion')));
    assert.strictEqual(out.text(), '', 'quiet on success');
  } finally { await st.close(); }
});

test('run: paused folder shows need unknown in log and JSON; total is a lower bound', async () => {
  const f = folders();
  f['tv-ddddd'] = { label: 'TV Shows', paused: true };
  const st = await fakeSyncthing(f);
  const env = setup(st);
  try {
    assert.strictEqual(await R.run({ envFile: env.envFile, now: new Date(at(0)), out: sink(), err: sink() }), 0);
    const latest = JSON.parse(fs.readFileSync(path.join(env.stateDir, 'latest.json'), 'utf8'));
    const tv = latest.folders.find(x => x.id === 'tv-ddddd');
    assert.deepStrictEqual([tv.state, tv.needBytes, tv.stall.stalled], ['paused', null, null]);
    assert.strictEqual(latest.totals.totalNeedBytes, null);
    assert.strictEqual(latest.totals.freeAfterDownloadsBytes, null);
    assert.deepStrictEqual(latest.totals.unknownNeedFolders, ['tv-ddddd']);
    assert.match(readAll(env.logDir), /TV Shows paused \(need \?\).*total >=.*some need unknown.*after downloads \?/);
  } finally { await st.close(); }
});

test('run: API down -> exit 1, clear log line, latest.json carries no measurements, state untouched', async () => {
  const st = await fakeSyncthing(folders());
  const env = setup(st);
  try {
    assert.strictEqual(await R.run({ envFile: env.envFile, now: new Date(at(0)), out: sink(), err: sink() }), 0);
    const stateBefore = fs.readFileSync(path.join(env.stateDir, 'state.json'), 'utf8');
    await st.close();
    const err = sink();
    assert.strictEqual(await R.run({ envFile: env.envFile, now: new Date(at(1)), out: sink(), err }), 1);
    assert.match(err.text(), /FAIL Syncthing API unreachable/);
    const log = readAll(env.logDir);
    assert.match(log, /FAIL Syncthing API unreachable at http:\/\/127\.0\.0\.1:\d+ \((ECONNREFUSED|UND_ERR_SOCKET|ECONNRESET)\); no report this run/); // in-process keep-alive may see the close first
    const latest = JSON.parse(fs.readFileSync(path.join(env.stateDir, 'latest.json'), 'utf8'));
    assert.strictEqual(latest.ok, false);
    assert.strictEqual(latest.folders, undefined);
    assert.strictEqual(latest.disk, undefined);
    assert.strictEqual(fs.readFileSync(path.join(env.stateDir, 'state.json'), 'utf8'), stateBefore);
    assert.ok(!fs.existsSync(path.join(env.stateDir, 'run.lock')));
  } finally { await st.close().catch(() => {}); }
});

test('run: key rejected, folder missing, and bad shapes each fail the whole run', async () => {
  const st = await fakeSyncthing(folders());
  const env = setup(st);
  try {
    st.authFail = true;
    let err = sink();
    assert.strictEqual(await R.run({ envFile: env.envFile, now: new Date(at(0)), out: sink(), err }), 1);
    assert.match(err.text(), /rejected the API key .*HTTP 403/);
    assert.ok(!err.text().includes(KEY));
    st.authFail = false;
    delete st.folders['mov-ccccc'];
    err = sink();
    assert.strictEqual(await R.run({ envFile: env.envFile, now: new Date(at(1)), out: sink(), err }), 1);
    assert.match(err.text(), /folder mov-ccccc is not in Syncthing's config/);
    st.folders['mov-ccccc'] = { label: 'Movies', state: 'syncing', needBytes: 'lots' };
    err = sink();
    assert.strictEqual(await R.run({ envFile: env.envFile, now: new Date(at(2)), out: sink(), err }), 1);
    assert.match(err.text(), /has no needBytes/);
    assert.ok(!fs.existsSync(path.join(env.stateDir, 'state.json')), 'no measurement was ever recorded');
  } finally { await st.close(); }
});

test('run: an unmounted media drive fails the run instead of reporting the system disk', async () => {
  const st = await fakeSyncthing(folders());
  const env = setup(st, { PH_SYNC_MEDIA_PATH: tmpdir('nomount') });
  try {
    const err = sink();
    assert.strictEqual(await R.run({ envFile: env.envFile, now: new Date(at(0)), out: sink(), err }), 1);
    assert.match(err.text(), /nothing is mounted at/);
  } finally { await st.close(); }
});

// ---------------------------------------------------------------------------------------------
// Config and heartbeat

test('config: env file must be chmod 600; folders parse from TIER_FOLDERS-style values', () => {
  const dir = tmpdir('cfg');
  const file = writeEnv(dir, { SYNCTHING_API_KEY: KEY, PH_SYNC_FOLDERS: 'a-1:/m/A' });
  fs.chmodSync(file, 0o644);
  assert.throws(() => R.readEnvFile(file), /chmod 600/);
  assert.deepStrictEqual(R.parseFolders('a-1:/m/Family Films;b-2:/m/TV Shows'), [{ id: 'a-1', path: '/m/Family Films' }, { id: 'b-2', path: '/m/TV Shows' }]);
  assert.deepStrictEqual(R.parseFolders('[{"id":"a-1","path":"/m/A"}]'), [{ id: 'a-1', path: '/m/A' }]);
  assert.throws(() => R.parseFolders('a-1:relative'), /absolute/);
  assert.throws(() => R.buildConfig({ PH_SYNC_FOLDERS: 'a-1:/m' }), /SYNCTHING_API_KEY/);
  assert.throws(() => R.buildConfig({ SYNCTHING_API_KEY: 'k', PH_SYNC_FOLDERS: 'a-1:/m', SYNCTHING_URL: 'http://10.0.0.5:8384' }), /on this machine/);
});

test('heartbeat: off unless URL and token are both set; never the uptime ingest; never plain http off-box', () => {
  assert.strictEqual(R.heartbeatConfig({}).enabled, false);
  assert.match(R.heartbeatConfig({ BOT_HEARTBEAT_URL: 'https://bot.example/agent/x' }).note, /TOKEN not set/);
  assert.match(R.heartbeatConfig({ BOT_HEARTBEAT_TOKEN: 't' }).note, /URL not set/);
  assert.throws(() => R.heartbeatConfig({ BOT_HEARTBEAT_URL: 'https://bot.example/api/uptime/ingest', BOT_HEARTBEAT_TOKEN: 't' }), /uptime ingest/);
  assert.throws(() => R.heartbeatConfig({ BOT_HEARTBEAT_URL: 'http://bot.example/hb', BOT_HEARTBEAT_TOKEN: 't' }), /https/);
  assert.strictEqual(R.heartbeatConfig({ BOT_HEARTBEAT_URL: 'https://bot.example/hb', BOT_HEARTBEAT_TOKEN: 't' }).enabled, true);
});

test('heartbeat: when configured, posts the same report with the bearer token; failure is a WARN, not lost data', async () => {
  const got = [];
  const hb = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => { got.push({ url: req.url, auth: req.headers.authorization, body }); res.writeHead(got.length === 1 ? 204 : 500); res.end(); });
  });
  await new Promise(r => hb.listen(0, '127.0.0.1', r));
  const st = await fakeSyncthing(folders());
  const env = setup(st, { BOT_HEARTBEAT_URL: `http://127.0.0.1:${hb.address().port}/agent/sync/ph`, BOT_HEARTBEAT_TOKEN: 'hb-placeholder' });
  try {
    assert.strictEqual(await R.run({ envFile: env.envFile, now: new Date(at(0)), out: sink(), err: sink() }), 0);
    assert.strictEqual(got[0].auth, 'Bearer hb-placeholder');
    assert.strictEqual(got[0].url, '/agent/sync/ph');
    assert.strictEqual(JSON.parse(got[0].body).folders.length, 4);
    assert.strictEqual(await R.run({ envFile: env.envFile, now: new Date(at(1)), out: sink(), err: sink() }), 0);
    assert.match(readAll(env.logDir), /WARN heartbeat failed \(HTTP 500\)/);
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(env.stateDir, 'latest.json'), 'utf8')).heartbeat, 'failed (HTTP 500)');
  } finally { await st.close(); await new Promise(r => hb.close(r)); }
});

// ---------------------------------------------------------------------------------------------
// Housekeeping and CLI

test('retention: dated logs and reports older than PH_SYNC_KEEP_DAYS are removed, others kept', () => {
  const dir = tmpdir('prune');
  for (const n of ['sync-2026-08-01.log', 'sync-2026-10-01.log', 'other-2026-01-01.log', 'notes.txt']) fs.writeFileSync(path.join(dir, n), 'x');
  R.pruneOld(dir, 'sync', '.log', 60, new Date('2026-10-30T12:00:00Z'));
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['notes.txt', 'other-2026-01-01.log', 'sync-2026-10-01.log']);
});

test('cli: --dry-run prints the line and JSON and writes nothing; API down exits non-zero', async () => {
  const st = await fakeSyncthing(folders());
  const env = setup(st);
  try {
    const res = await new Promise(resolve => {
      const { spawn } = require('child_process');
      const child = spawn(process.execPath, [SCRIPT, '--dry-run', '--env-file', env.envFile], { encoding: 'utf8' });
      let stdout = '';
      child.stdout.on('data', c => { stdout += c; });
      child.on('close', code => resolve({ code, stdout }));
    });
    assert.strictEqual(res.code, 0);
    assert.match(res.stdout, / OK need: Family Films 2\.6 GiB syncing \| 4K 0 idle \| Movies 9\.8 GiB syncing \| TV Shows 57\.2 GiB syncing \| total 69\.6 GiB/);
    assert.ok(!res.stdout.includes(KEY));
    assert.ok(!fs.existsSync(env.logDir) && !fs.existsSync(env.stateDir), 'dry run writes nothing');
  } finally { await st.close(); }
  const down = spawnSync(process.execPath, [SCRIPT, '--env-file', env.envFile], { encoding: 'utf8' });
  assert.strictEqual(down.status, 1);
  assert.match(down.stderr, /FAIL Syncthing API unreachable at http:\/\/127\.0\.0\.1:\d+ \(ECONNREFUSED\)/);
});

test('safety: the script only ever issues GETs to Syncthing and has no write endpoints in it', () => {
  const src = fs.readFileSync(SCRIPT, 'utf8');
  for (const forbidden of ['/rest/db/completion', '/rest/db/scan', '/rest/system/restart', '/rest/db/override', '/rest/db/revert', '/rest/system/pause', '/rest/system/resume', '/rest/db/ignores', 'api/uptime/ingest\'']) {
    assert.ok(!src.includes(forbidden), `script must not reference ${forbidden}`);
  }
  assert.ok(!/\.files\b/.test(src), 'db/need has no "files" key');
  assert.strictEqual((src.match(/method: 'POST'/g) || []).length, 1, 'the only POST is the opt-in heartbeat');
});
