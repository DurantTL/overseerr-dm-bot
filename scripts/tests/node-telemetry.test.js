#!/usr/bin/env node
const { test } = require('node:test');
const assert = require('node:assert');
const { sanitizeNodeTelemetry, assessNodeTelemetry, telemetrySummary } = require('../../src/node-telemetry');
const { collectSystemTelemetry } = require('../../agent/agent');

test('agent prefers an identified CPU sensor over a hotter unclassified sensor', () => {
  const directories = {
    '/sys/class/thermal': ['thermal_zone0'],
    '/sys/class/thermal/thermal_zone0': ['temp'],
    '/sys/class/hwmon': ['hwmon0'],
    '/sys/class/hwmon/hwmon0': ['temp1_input', 'temp1_label'],
  };
  const files = {
    '/sys/class/thermal/thermal_zone0/temp': '99000',
    '/sys/class/hwmon/hwmon0/temp1_input': '81000',
    '/sys/class/hwmon/hwmon0/temp1_label': 'CPU Package',
  };
  const fsImpl = {
    readdirSync: value => {
      if (!directories[value]) throw new Error('missing');
      return directories[value];
    },
    readFileSync: value => files[value],
    statfsSync: () => ({ blocks: 1000, bavail: 250, bsize: 4096 }),
  };
  const osImpl = {
    loadavg: () => [1.5, 1, 0.5], cpus: () => [{}, {}, {}, {}],
    totalmem: () => 16_000, freemem: () => 4_000, uptime: () => 7200,
  };
  const value = collectSystemTelemetry({ mount: { root: '/mnt/media' }, folderRoot: '/fallback' }, { fsImpl, osImpl });
  assert.strictEqual(value.temperatureC, 81);
  assert.strictEqual(value.temperatureKind, 'cpu');
  assert.match(value.temperatureSource, /CPU Package.*hwmon\/hwmon0\/temp1_input/);
  assert.strictEqual(value.cpuCount, 4);
  assert.strictEqual(value.memoryFreeBytes, 4000);
  assert.strictEqual(value.filesystemTotalBytes, 4096000);
  assert.strictEqual(value.filesystemFreeBytes, 1024000);
});

test('server bounds telemetry and classifies configurable thermal transitions', () => {
  const now = 1_700_000_000_000;
  const value = sanitizeNodeTelemetry({
    collectedAt: now, temperatureC: 85.2, temperatureSource: 'CPU Package '.repeat(20), temperatureKind: 'cpu', load1: 1.2,
    cpuCount: 4, memoryTotalBytes: 100, memoryFreeBytes: 25, uptimeSeconds: 3600,
    filesystemTotalBytes: 1000, filesystemFreeBytes: 100,
    unexpected: 'discard me',
  });
  assert.strictEqual(value.temperatureSource.length, 80);
  assert.strictEqual(value.unexpected, undefined);
  assert.strictEqual(assessNodeTelemetry(value, { warnC: 80, criticalC: 90, now }).level, 'warn');
  assert.strictEqual(assessNodeTelemetry({ collectedAt: now, temperatureC: 95, temperatureKind: 'cpu' }, { warnC: 80, criticalC: 90, now }).level, 'critical');
  assert.strictEqual(assessNodeTelemetry({ collectedAt: now, temperatureC: 70, temperatureKind: 'cpu' }, { warnC: 80, criticalC: 90, now }).level, 'ok');
  assert.strictEqual(assessNodeTelemetry(null).level, 'unknown');
  assert.match(telemetrySummary(value, bytes => `${bytes} bytes`, { now }), /85\.2°C CPU.*RAM 75% used.*100 bytes disk free.*sample less than a minute old/);
});

test('hysteresis keeps a temperature riding near a threshold from flapping level on every read', () => {
  const now = 1_700_000_000_000;
  const sample = temperatureC => ({ collectedAt: now, temperatureC, temperatureKind: 'cpu' });
  const opts = { warnC: 80, criticalC: 90, now };
  // A stateless read (no previousLevel) classifies purely on the raw threshold.
  assert.strictEqual(assessNodeTelemetry(sample(79), opts).level, 'ok');
  assert.strictEqual(assessNodeTelemetry(sample(81), opts).level, 'warn');

  // Once "warn" has been entered, a dip back under 80°C that hasn't cleared the 5°C margin (75°C)
  // stays "warn" instead of bouncing back to "ok" and re-arming the next uptick as a fresh alert.
  assert.strictEqual(assessNodeTelemetry(sample(79), { ...opts, previousLevel: 'warn' }).level, 'warn');
  assert.strictEqual(assessNodeTelemetry(sample(76), { ...opts, previousLevel: 'warn' }).level, 'warn');
  // Actually clearing the margin (below 75°C) recovers to ok.
  assert.strictEqual(assessNodeTelemetry(sample(74), { ...opts, previousLevel: 'warn' }).level, 'ok');

  // Same margin behavior guards the critical threshold (90°C, 85°C clear point).
  assert.strictEqual(assessNodeTelemetry(sample(87), { ...opts, previousLevel: 'critical' }).level, 'critical');
  assert.strictEqual(assessNodeTelemetry(sample(84), { ...opts, previousLevel: 'critical' }).level, 'warn');
});

test('invalid or unavailable sensor readings degrade to unavailable without failing collection', () => {
  const fsImpl = {
    readdirSync: () => { throw new Error('no sysfs'); },
    statfsSync: () => { throw new Error('no filesystem stats'); },
  };
  const osImpl = {
    loadavg: () => [0, 0, 0], cpus: () => [{}], totalmem: () => 10, freemem: () => 5, uptime: () => 1,
  };
  const value = collectSystemTelemetry({ mount: {}, folderRoot: '/media' }, { fsImpl, osImpl });
  assert.strictEqual(value.temperatureC, null);
  assert.strictEqual(value.filesystemFreeBytes, null);
  assert.strictEqual(sanitizeNodeTelemetry({ temperatureC: 500 }), null);
});

test('server preserves unavailable values and never treats stale telemetry as healthy', () => {
  for (const invalid of [null, undefined, '', '   ', false, true, NaN, Infinity, [], {}]) {
    const telemetry = sanitizeNodeTelemetry({ temperatureC: invalid });
    assert.ok(!telemetry || telemetry.temperatureC === null, `${String(invalid)} stays unavailable`);
  }
  assert.strictEqual(sanitizeNodeTelemetry({ temperatureC: 0 })?.temperatureC, 0, 'a legitimate numeric zero remains valid');
  assert.strictEqual(sanitizeNodeTelemetry({ temperatureC: '0' })?.temperatureC, 0, 'a non-empty numeric string remains supported');

  const now = 1_700_000_000_000;
  const stale = sanitizeNodeTelemetry({
    collectedAt: now - 13 * 3600000,
    temperatureC: 70,
    temperatureSource: 'acpitz',
    temperatureKind: 'unclassified',
  });
  assert.strictEqual(assessNodeTelemetry(stale, { now, previousLevel: 'warn' }).level, 'unknown');
  assert.match(telemetrySummary(stale, undefined, { now }), /70\.0°C unclassified.*sample 13h old \(stale\)/);
});

test('unclassified sensor readings are not labeled as CPU temperature', () => {
  const now = 1_700_000_000_000;
  const telemetry = sanitizeNodeTelemetry({
    collectedAt: now,
    temperatureC: 42,
    temperatureSource: 'nvme Composite',
    temperatureKind: 'unclassified',
  });
  assert.match(assessNodeTelemetry(telemetry, { now }).reason, /^Temperature 42\.0°C/);
  assert.doesNotMatch(telemetrySummary(telemetry, undefined, { now }), /°C CPU/);
});
