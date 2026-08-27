#!/usr/bin/env node
const { test } = require('node:test');
const assert = require('node:assert');
const { sanitizeNodeTelemetry, assessNodeTelemetry, telemetrySummary } = require('../../src/node-telemetry');
const { collectSystemTelemetry } = require('../../agent/agent');

test('agent collects the hottest valid Linux sensor plus load, RAM, uptime, and filesystem capacity', () => {
  const directories = {
    '/sys/class/thermal': ['thermal_zone0'],
    '/sys/class/thermal/thermal_zone0': ['temp'],
    '/sys/class/hwmon': ['hwmon0'],
    '/sys/class/hwmon/hwmon0': ['temp1_input', 'temp1_label'],
  };
  const files = {
    '/sys/class/thermal/thermal_zone0/temp': '72000',
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
  assert.strictEqual(value.temperatureSource, 'CPU Package');
  assert.strictEqual(value.cpuCount, 4);
  assert.strictEqual(value.memoryFreeBytes, 4000);
  assert.strictEqual(value.filesystemTotalBytes, 4096000);
  assert.strictEqual(value.filesystemFreeBytes, 1024000);
});

test('server bounds telemetry and classifies configurable thermal transitions', () => {
  const value = sanitizeNodeTelemetry({
    temperatureC: 85.2, temperatureSource: 'x'.repeat(200), load1: 1.2,
    cpuCount: 4, memoryTotalBytes: 100, memoryFreeBytes: 25, uptimeSeconds: 3600,
    filesystemTotalBytes: 1000, filesystemFreeBytes: 100,
    unexpected: 'discard me',
  });
  assert.strictEqual(value.temperatureSource.length, 80);
  assert.strictEqual(value.unexpected, undefined);
  assert.strictEqual(assessNodeTelemetry(value, { warnC: 80, criticalC: 90 }).level, 'warn');
  assert.strictEqual(assessNodeTelemetry({ temperatureC: 95 }, { warnC: 80, criticalC: 90 }).level, 'critical');
  assert.strictEqual(assessNodeTelemetry({ temperatureC: 70 }, { warnC: 80, criticalC: 90 }).level, 'ok');
  assert.strictEqual(assessNodeTelemetry(null).level, 'unknown');
  assert.match(telemetrySummary(value, bytes => `${bytes} bytes`), /85\.2°C CPU.*RAM 75% used.*100 bytes disk free/);
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
