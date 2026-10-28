#!/usr/bin/env node
// Backup inventory (src/backup-inventory.js), item 18 step one: read-only reporting of what
// backups exist for the bot's database, the *arrs and Plex, with unreadable sources marked
// unknown rather than failing the report.
const { test } = require('node:test');
const assert = require('node:assert');

const B = require('../../src/backup-inventory');

const NOW = Date.parse('2026-10-28T12:00:00Z');
const H = 3600000;

function fakeFs(files) {
  return {
    readdirSync: () => Object.keys(files),
    statSync: p => ({ mtimeMs: files[p.split('/').pop()].mtime, size: 1000 }),
  };
}

test('backup inventory: bot database is off, missing or present, from the schedule and the files', () => {
  const none = B.botDatabase({ intervalHours: 0, backupDir: '/app/data/backups', now: NOW, fileSystem: { readdirSync: () => { throw new Error('ENOENT'); } } });
  assert.deepStrictEqual([none.status, none.count], ['off', 0]);
  assert.match(none.detail, /in-process backup off \(BACKUP_INTERVAL_HOURS=0\); no backup files in \/app\/data\/backups/);

  const missing = B.botDatabase({ intervalHours: 24, backupDir: '/b', now: NOW, fileSystem: fakeFs({}) });
  assert.strictEqual(missing.status, 'missing');

  const hostCron = B.botDatabase({ intervalHours: 0, backupDir: '/b', now: NOW, fileSystem: fakeFs({
    'plex_invites-20261026-010000Z.db': { mtime: NOW - 59 * H }, 'plex_invites-20261027-010000Z.db': { mtime: NOW - 35 * H }, 'notes.txt': { mtime: NOW },
  }) });
  assert.deepStrictEqual([hostCron.status, hostCron.count, hostCron.newestAt], ['exists', 2, NOW - 35 * H]);
  assert.match(hostCron.detail, /2 file\(s\) in \/b, newest 35h old/, 'files from a host cron count even with the in-process schedule off');
});

test('backup inventory: *arr backups are listed with their schedule', async () => {
  const calls = [];
  const http = { get: async (url, opts) => {
    calls.push([url, opts.headers['X-Api-Key']]);
    if (url.endsWith('/system/backup')) return { data: [
      { id: 1, name: 'sonarr_backup_1.zip', type: 'scheduled', time: '2026-10-21T03:00:00Z', size: 5e6 },
      { id: 2, name: 'sonarr_backup_2.zip', type: 'update', time: '2026-10-27T03:00:00Z', size: 5e6 },
    ] };
    return { data: { backupInterval: 7, backupRetention: 28, backupFolder: 'Backups' } };
  } };
  const row = await B.arrBackups({ app: 'Sonarr', url: 'http://sonarr:8989/', key: 'k', api: 'v3' }, { http, now: NOW });
  assert.deepStrictEqual([row.status, row.count, row.newestAt], ['exists', 2, Date.parse('2026-10-27T03:00:00Z')]);
  assert.match(row.detail, /2 backup\(s\), newest 33h old \(update\); scheduled every 7d, kept 28d, folder Backups/);
  assert.deepStrictEqual(calls.map(c => c[0]), ['http://sonarr:8989/api/v3/system/backup', 'http://sonarr:8989/api/v3/config/host']);

  const empty = await B.arrBackups({ app: 'Prowlarr', url: 'http://p', key: 'k', api: 'v1' }, { http: { get: async url => (url.endsWith('/system/backup') ? { data: [] } : Promise.reject(new Error('x'))) }, now: NOW });
  assert.deepStrictEqual([empty.status, empty.detail], ['missing', 'no backups listed; schedule not readable']);
});

test('backup inventory: Plex backup setting on, off, or not found', async () => {
  const prefs = settings => ({ get: async () => ({ data: { MediaContainer: { Setting: settings } } }) });
  const on = await B.plexBackupSetting({ url: 'http://plex:32400', token: 't', http: prefs([{ id: 'ButlerTaskBackupDatabase', value: true }, { id: 'ButlerDatabaseBackupPath', value: '/config/backups' }]) });
  assert.deepStrictEqual([on.status, /folder \/config\/backups/.test(on.detail)], ['exists', true]);
  const off = await B.plexBackupSetting({ url: 'http://plex:32400', token: 't', http: prefs([{ id: 'ButlerTaskBackupDatabase', value: false }]) });
  assert.strictEqual(off.status, 'off');
  const unknown = await B.plexBackupSetting({ url: 'http://plex:32400', token: 't', http: prefs([]) });
  assert.strictEqual(unknown.status, 'unknown');
});

test('backup inventory: every source appears; unconfigured or unreachable ones are unknown, not errors', async () => {
  const http = { get: async url => { if (url.includes('radarr')) { const e = new Error('nope'); e.response = { status: 401 }; throw e; } return { data: [] }; } };
  const rows = await B.inventory({ BACKUP_INTERVAL_HOURS: 0, BACKUP_DIR: '/none', RADARR_URL: 'http://radarr', RADARR_API_KEY: 'k' }, { http, now: NOW, fileSystem: fakeFs({}) });
  assert.deepStrictEqual(rows.map(r => [r.source, r.status]), [
    ['Bot database', 'off'], ['Sonarr', 'unknown'], ['Radarr', 'unknown'], ['Radarr 4K', 'unknown'], ['Prowlarr', 'unknown'],
    ['Plex', 'unknown'], ['Seerr', 'unknown'], ['Tautulli', 'unknown'],
  ]);
  assert.strictEqual(rows[2].detail, "couldn't read (HTTP 401)");
  assert.strictEqual(rows[1].detail, 'not configured in the bot');
});

// ---- Item 18 step two: verify the backups that exist ----
const DAY = 86400000;
const arr = (source, ageDays, extra = {}) => ({ source, status: 'exists', newestAt: NOW - ageDays * DAY, newestSize: 4e6, intervalDays: 7, count: 5, detail: '', ...extra });

test('backup check: today\'s real inventory (5 days old on a 7-day schedule, Plex on) all passes', () => {
  const verdicts = B.verifyBackups([
    { source: 'Bot database', status: 'off' },
    arr('Sonarr', 5), arr('Radarr', 5), arr('Radarr 4K', 15 / 24), arr('Prowlarr', 5),
    { source: 'Plex', status: 'exists', settingOn: true },
    { source: 'Seerr', status: 'unknown' }, { source: 'Tautulli', status: 'unknown' },
  ], { now: NOW });
  assert.deepStrictEqual(verdicts.map(v => [v.source, v.ok]), [['Sonarr', true], ['Radarr', true], ['Radarr 4K', true], ['Prowlarr', true], ['Plex', true]],
    'the bot database (off), Seerr and Tautulli are not checked at all');
});

test('backup check: stale past schedule + 1 day, empty, missing, Plex switched off, and unreadable', () => {
  const verdicts = B.verifyBackups([
    arr('Sonarr', 7.9), arr('Radarr', 8.5), arr('Radarr 4K', 1, { newestSize: 0 }), { source: 'Prowlarr', status: 'missing', newestAt: null },
    { source: 'Plex', status: 'off', settingOn: false },
  ], { now: NOW });
  assert.deepStrictEqual(verdicts.map(v => [v.source, v.ok, v.problem]), [
    ['Sonarr', true, null],
    ['Radarr', false, 'newest backup is 8 days old; it backs up every 7 days'],
    ['Radarr 4K', false, 'newest backup is an empty file'],
    ['Prowlarr', false, 'no backups listed'],
    ['Plex', false, 'scheduled database backup has been turned off'],
  ]);
  const unreadable = B.verifyBackups([{ source: 'Sonarr', status: 'unknown', detail: "couldn't read (HTTP 401)" }], { now: NOW });
  assert.deepStrictEqual(unreadable, [{ source: 'Sonarr', ok: null, problem: "couldn't read (HTTP 401)" }]);
});

test('backup check: posts when a source goes bad and when it recovers, not every day in between', () => {
  let state = {};
  const step = verdicts => { const r = B.backupTransitions(verdicts, state); state = r.state; return [r.failed.map(v => v.source), r.recovered.map(v => v.source)]; };
  const good = { source: 'Radarr', ok: true, problem: null };
  const bad = { source: 'Radarr', ok: false, problem: 'stale' };
  assert.deepStrictEqual(step([good]), [[], []]);
  assert.deepStrictEqual(step([bad]), [['Radarr'], []]);
  assert.deepStrictEqual(step([bad]), [[], []], 'no repeat while it stays bad');
  assert.deepStrictEqual(step([{ source: 'Radarr', ok: null, problem: 'HTTP 502' }]), [[], []], 'unreadable leaves it as reported');
  assert.deepStrictEqual(step([good]), [[], ['Radarr']]);
  assert.deepStrictEqual(state, {});
});
