#!/usr/bin/env node
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { loadSandbox } = require('./extract');
const {
  DAY_MS, MAX_SAMPLES_PER_ROOT, projectCapacity, recordDiskSamples, pruneDiskSamples, forecastDisks, pathIsOnRoot,
} = require('../../src/capacity');

const GB = 1024 ** 3;

function createDatabase(file) {
  const database = new Database(file);
  database.exec(`CREATE TABLE disk_space_samples (
    root TEXT NOT NULL,
    free_bytes INTEGER NOT NULL,
    total_bytes INTEGER NOT NULL,
    sampled_at INTEGER NOT NULL,
    PRIMARY KEY (root, sampled_at)
  )`);
  return database;
}

test('capacity: projection waits for enough samples and elapsed history', () => {
  const now = Date.UTC(2026, 7, 15);
  const tooFew = Array.from({ length: 5 }, (_, index) => ({ sampledAt: now - (4 - index) * DAY_MS, freeBytes: (100 - index * 10) * GB }));
  assert.strictEqual(projectCapacity(tooFew, now).status, 'insufficient');
  const tooShort = Array.from({ length: 6 }, (_, index) => ({ sampledAt: now - (5 - index) * 3600000, freeBytes: (100 - index * 10) * GB }));
  assert.strictEqual(projectCapacity(tooShort, now).status, 'insufficient');
});

test('capacity: steady consumption projects days remaining', () => {
  const now = Date.UTC(2026, 7, 15);
  const samples = Array.from({ length: 6 }, (_, index) => ({ sampledAt: now - (5 - index) * DAY_MS, freeBytes: (100 - index * 10) * GB }));
  const projection = projectCapacity(samples, now);
  assert.strictEqual(projection.status, 'projected');
  assert.strictEqual(projection.consumptionBytesPerDay, 10 * GB);
  assert.strictEqual(projection.daysRemaining, 5);
  assert.strictEqual(projection.confidence, 'moderate');
});

test('capacity: one large import does not create a sustained alarming trend', () => {
  const now = Date.UTC(2026, 7, 15);
  const free = [100, 100, 100, 50, 50, 50, 50];
  const samples = free.map((value, index) => ({ sampledAt: now - (free.length - 1 - index) * 6 * 3600000, freeBytes: value * GB }));
  assert.strictEqual(projectCapacity(samples, now).status, 'stable');
});

test('capacity: samples survive reopen and prune to fixed time and row bounds', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'overseerr-capacity-'));
  const file = path.join(directory, 'capacity.db');
  const now = Date.UTC(2026, 7, 15);
  try {
    let database = createDatabase(file);
    recordDiskSamples(database, [{ path: '/media', freeSpace: 100 * GB, totalSpace: 200 * GB }], now - 31 * DAY_MS);
    const insert = database.prepare('INSERT INTO disk_space_samples (root, free_bytes, total_bytes, sampled_at) VALUES (?, ?, ?, ?)');
    database.transaction(() => {
      for (let index = 0; index < MAX_SAMPLES_PER_ROOT + 5; index++) insert.run('/media', (100 * GB) - index, 200 * GB, now - index * 1000);
    })();
    database.close();

    database = new Database(file);
    pruneDiskSamples(database, now);
    assert.strictEqual(database.prepare('SELECT COUNT(*) AS count FROM disk_space_samples WHERE root = ?').get('/media').count, MAX_SAMPLES_PER_ROOT);
    const disks = forecastDisks(database, [{ path: '/media', freeSpace: 100 * GB, totalSpace: 200 * GB }], now);
    assert.strictEqual(disks[0].forecast.sampleCount, MAX_SAMPLES_PER_ROOT);
    assert.strictEqual(database.prepare('SELECT COUNT(*) AS count FROM disk_space_samples WHERE sampled_at < ?').get(now - 30 * DAY_MS).count, 0);
    database.close();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('capacity: cleanup paths match only their actual disk root', () => {
  assert.strictEqual(pathIsOnRoot('/share/media/Movies/A', '/share/media'), true);
  assert.strictEqual(pathIsOnRoot('/share/media-archive/A', '/share/media'), false);
  assert.strictEqual(pathIsOnRoot('C:\\Media\\Movies\\A', 'C:\\Media'), true);
});

test('capacity: cleanup suggestions exclude keep-listed and never-delete media', async () => {
  let reply;
  const embed = () => ({
    setTitle() { return this; },
    setDescription(description) { this.description = description; return this; },
    setFooter() { return this; },
  });
  const sandbox = loadSandbox(['handleCleanupSuggestionsCommand'], {
    requireAdmin: async () => true,
    arrSources: () => [{ kind: 'movie', label: 'radarr', url: 'http://radarr', key: 'key' }],
    axios: { get: async () => ({ data: [
      { tmdbId: 1, title: 'Kept', path: '/media/Kept', sizeOnDisk: 30 * GB, added: '2020-01-01' },
      { tmdbId: 2, title: 'Never', path: '/media/Never', sizeOnDisk: 20 * GB, added: '2020-01-01' },
      { tmdbId: 3, title: 'Eligible', path: '/media/Eligible', sizeOnDisk: 10 * GB, added: '2020-01-01' },
    ] }) },
    isInKeepList: mediaId => mediaId === 'tmdb:1',
    CONFIG: { NEVER_DELETE_MEDIA_IDS: ['tmdb:2'] },
    db: {},
    fetchDiskSpace: async () => [{ path: '/media' }],
    forecastDisks: () => [{ path: '/media', root: '/media', forecast: { status: 'projected', daysRemaining: 10, consumptionBytesPerDay: 5 * GB } }],
    pathIsOnRoot,
    fmtSpace: bytes => `${bytes / GB} GB`,
    brandedEmbed: embed,
    COLORS: { INFO: 1 },
    audit: () => {},
  });
  const interaction = {
    deferReply: async () => {},
    editReply: async value => { reply = value; },
  };
  await sandbox.handleCleanupSuggestionsCommand(interaction);
  assert.match(reply.embeds[0].description, /Eligible/);
  assert.doesNotMatch(reply.embeds[0].description, /Kept|Never/);
  assert.match(reply.embeds[0].description, /buy approximately 2 days/);
});
