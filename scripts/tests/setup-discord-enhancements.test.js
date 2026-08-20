#!/usr/bin/env node
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dbPath = path.join(os.tmpdir(), `durant-setup-enhancements-${process.pid}.db`);
process.env.DB_PATH = dbPath;

const { runMigrations, db, setSetting } = require('../../src/db');
runMigrations();
const { stateKey } = require('../../src/setup-device-state');
const { setupPayloadForUser } = require('../../src/setup-discord-enhancements');

after(() => {
  try { db.close(); } catch (_e) {}
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(`${dbPath}${suffix}`); } catch (_e) {}
  }
});

test('admin resend payload includes saved PH device state', () => {
  const discordId = '444444444444444444';
  setSetting(stateKey(discordId, 'appletv'), '1700000000000');
  const payload = setupPayloadForUser({
    discord_id: discordId,
    email: 'ph@example.com',
    plex_username: 'phviewer',
    invited: 1,
    overseerr_created: 1,
    home_server: 'ph',
  }, { dm: true });

  const json = payload.embeds[0].toJSON();
  const devices = json.fields.find(field => field.name === 'PH devices');
  assert.ok(devices, 'PH resend includes device summary');
  assert.match(devices.value, /Apple TV.*confirmed/);
  assert.match(devices.value, /Phone \/ Tablet.*not confirmed/);
  assert.equal(Object.hasOwn(payload, 'ephemeral'), false, 'DM payload does not carry interaction-only ephemeral metadata');
});

test('admin resend payload for Main never includes PH state', () => {
  const payload = setupPayloadForUser({
    discord_id: '555555555555555555',
    email: 'main@example.com',
    plex_username: 'mainviewer',
    invited: 1,
    overseerr_created: 1,
    home_server: 'primary',
  }, { dm: true });

  const json = payload.embeds[0].toJSON();
  assert.ok(!json.fields.some(field => field.name === 'PH devices'));
  assert.equal(JSON.stringify(payload.components).includes('ph_connection'), false);
});
