#!/usr/bin/env node
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dbPath = path.join(os.tmpdir(), `durant-device-state-${process.pid}.db`);
process.env.DB_PATH = dbPath;

const { setSetting, deleteSetting } = require('../../src/db');
const {
  DEVICES,
  stateKey,
  deviceConfirmation,
  deviceConfirmations,
  anyDeviceConfirmed,
  personalizedSetupPayload,
} = require('../../src/setup-device-state');

after(() => {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(dbPath + suffix); } catch (_e) {}
  }
});

test('PH device confirmations are stored independently per device', () => {
  const userId = '111111111111111111';
  for (const device of DEVICES) deleteSetting(stateKey(userId, device));
  assert.equal(anyDeviceConfirmed(userId), false);

  setSetting(stateKey(userId, 'phone'), '1700000000000');
  const statuses = deviceConfirmations(userId);
  assert.equal(statuses.phone, 1700000000000);
  assert.equal(statuses.appletv, null);
  assert.equal(anyDeviceConfirmed(userId), true);
});

test('Main setup payload never gains PH device status', () => {
  const payload = personalizedSetupPayload({
    discord_id: '222222222222222222',
    email: 'main@example.com',
    plex_username: 'mainuser',
    invited: 1,
    overseerr_created: 1,
    home_server: 'primary',
  });
  const json = payload.embeds[0].toJSON();
  assert.ok(!json.fields?.some(f => f.name === 'PH devices'));
});

test('PH setup payload shows saved device confirmation status', () => {
  const userId = '333333333333333333';
  setSetting(stateKey(userId, 'computer'), String(Date.now()));
  const payload = personalizedSetupPayload({
    discord_id: userId,
    email: 'ph@example.com',
    plex_username: 'phuser',
    invited: 1,
    overseerr_created: 1,
    home_server: 'ph',
  });
  const json = payload.embeds[0].toJSON();
  const field = json.fields.find(f => f.name === 'PH devices');
  assert.ok(field);
  assert.match(field.value, /Computer.*confirmed/);
  assert.match(field.value, /Phone \/ Tablet.*not confirmed/);
  assert.equal(deviceConfirmation(userId, 'computer') > 0, true);
});
