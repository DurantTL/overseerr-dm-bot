#!/usr/bin/env node
// Heat readings slice: the agent's fuller telemetry (every sensor, fans, drive temperatures), the
// bot keeping those fields, sustained temperature alerting, and the node detail line.
const { test } = require('node:test');
const assert = require('node:assert');
const {
  sanitizeNodeTelemetry, assessNodeTelemetry, confirmTelemetryLevel, telemetryDetail, pendingTemperatureNote,
  SUSTAINED_TEMPERATURE_SAMPLES,
} = require('../../src/node-telemetry');
const { collectSystemTelemetry, collectSmartReadings, parseDriveTemperature } = require('../../agent/agent');
const { tierNodeStatus } = require('../../src/dashboard-render');

const OS = { loadavg: () => [0, 0, 0], cpus: () => [{}], totalmem: () => 10, freemem: () => 5, uptime: () => 7200 };

function fakeSys(directories, files) {
  return {
    readdirSync: value => {
      if (!directories[value]) throw new Error('missing');
      return directories[value];
    },
    readFileSync: value => {
      if (!(value in files)) throw new Error('missing');
      return files[value];
    },
    statfsSync: () => ({ blocks: 1000, bavail: 250, bsize: 4096 }),
  };
}

const noSmart = () => { const err = new Error('ENOENT'); err.code = 'ENOENT'; throw err; };

// A NUC-like host: a bogus acpitz zone (-263°C), coretemp package + cores, a PCH sensor, and an
// unreadable value. No fan files at all.
const NUC = fakeSys({
  '/sys/class/thermal': ['thermal_zone0', 'thermal_zone1'],
  '/sys/class/thermal/thermal_zone0': ['type', 'temp'],
  '/sys/class/thermal/thermal_zone1': ['type', 'temp'],
  '/sys/class/hwmon': ['hwmon1', 'hwmon2', 'hwmon3'],
  '/sys/class/hwmon/hwmon1': ['name', 'temp1_input'],
  '/sys/class/hwmon/hwmon2': ['name', 'temp1_input', 'temp1_label', 'temp2_input', 'temp2_label', 'temp3_input', 'temp3_label'],
  '/sys/class/hwmon/hwmon3': ['name', 'temp1_input', 'temp2_input'],
}, {
  '/sys/class/thermal/thermal_zone0/type': 'acpitz',
  '/sys/class/thermal/thermal_zone0/temp': '-263200',
  '/sys/class/thermal/thermal_zone1/type': 'x86_pkg_temp',
  '/sys/class/thermal/thermal_zone1/temp': '61000',
  '/sys/class/hwmon/hwmon1/name': 'acpitz',
  '/sys/class/hwmon/hwmon1/temp1_input': '-263200',
  '/sys/class/hwmon/hwmon2/name': 'coretemp',
  '/sys/class/hwmon/hwmon2/temp1_input': '62000',
  '/sys/class/hwmon/hwmon2/temp1_label': 'Package id 0',
  '/sys/class/hwmon/hwmon2/temp2_input': '59000',
  '/sys/class/hwmon/hwmon2/temp2_label': 'Core 0',
  '/sys/class/hwmon/hwmon2/temp3_input': '200000',
  '/sys/class/hwmon/hwmon2/temp3_label': 'Core 1',
  '/sys/class/hwmon/hwmon3/name': 'pch_cannonlake',
  '/sys/class/hwmon/hwmon3/temp1_input': '48000',
  '/sys/class/hwmon/hwmon3/temp2_input': 'not-a-number',
});

test('agent: temperatures[] keeps every sensor after filtering, CPU first then hottest; temperatureC unchanged', () => {
  const value = collectSystemTelemetry({ mount: { root: '/m' } }, { fsImpl: NUC, osImpl: OS, execImpl: noSmart });
  // Unchanged headline fields: the hottest CPU sensor.
  assert.strictEqual(value.temperatureC, 62);
  assert.strictEqual(value.temperatureKind, 'cpu');
  assert.match(value.temperatureSource, /^Package id 0 \(coretemp\/hwmon\/hwmon2\/temp1_input\)$/);
  const list = value.temperatures.map(t => [t.temperatureC, t.kind]);
  assert.deepStrictEqual(list, [[62, 'cpu'], [61, 'cpu'], [59, 'cpu'], [48, 'unclassified']], 'bogus -263, out-of-range 200 and non-numeric dropped');
  for (const t of value.temperatures) assert.deepStrictEqual(Object.keys(t).sort(), ['kind', 'label', 'temperatureC']);
  assert.strictEqual(value.temperatures[0].temperatureC, value.temperatureC, 'the list leads with the headline sensor');
});

test('agent: no fan exposed -> fans is an empty list (never 0); fans present -> RPM with labels', () => {
  const nuc = collectSystemTelemetry({ mount: { root: '/m' } }, { fsImpl: NUC, osImpl: OS, execImpl: noSmart });
  assert.deepStrictEqual(nuc.fans, []);
  const withFans = fakeSys({
    '/sys/class/hwmon': ['hwmon4'],
    '/sys/class/hwmon/hwmon4': ['name', 'fan1_input', 'fan1_label', 'fan2_input', 'fan3_input'],
  }, {
    '/sys/class/hwmon/hwmon4/name': 'nct6798',
    '/sys/class/hwmon/hwmon4/fan1_input': '1180',
    '/sys/class/hwmon/hwmon4/fan1_label': 'CPU Fan',
    '/sys/class/hwmon/hwmon4/fan2_input': '0',
    '/sys/class/hwmon/hwmon4/fan3_input': 'garbage',
  });
  const value = collectSystemTelemetry({ mount: { root: '/m' } }, { fsImpl: withFans, osImpl: OS, execImpl: noSmart });
  assert.deepStrictEqual(value.fans, [
    { label: 'CPU Fan (nct6798/hwmon/hwmon4/fan1_input)', rpm: 1180 },
    { label: 'nct6798 (hwmon/hwmon4/fan2_input)', rpm: 0 },
  ], 'a real 0 RPM reading (stopped fan) is kept; an unreadable one is dropped');
});

test('agent: drive temperatures for ATA, NVMe and absent shapes, from the one smartctl call per disk', () => {
  const ata194 = { smart_status: { passed: true }, ata_smart_attributes: { table: [{ id: 194, name: 'Temperature_Celsius', raw: { value: 197570854952, string: '40 (Min/Max 18/46)' } }] } };
  const ataCurrent = { smart_status: { passed: true }, temperature: { current: 35 } };
  const nvme = { smart_status: { passed: true }, nvme_smart_health_information_log: { temperature: 44 } };
  const none = { smart_status: { passed: true } };
  assert.strictEqual(parseDriveTemperature(JSON.stringify(ata194)), 40, 'packed raw value: the leading number wins');
  assert.strictEqual(parseDriveTemperature(JSON.stringify(ataCurrent)), 35);
  assert.strictEqual(parseDriveTemperature(JSON.stringify(nvme)), 44);
  assert.strictEqual(parseDriveTemperature(JSON.stringify(none)), null);
  assert.strictEqual(parseDriveTemperature(JSON.stringify({ temperature: { current: 400 } })), null, 'out of range is null');
  assert.strictEqual(parseDriveTemperature('SMART overall-health self-assessment test result: PASSED'), null);

  const outputs = { '/dev/sda': ata194, '/dev/nvme0n1': nvme, '/dev/sdb': none };
  const calls = [];
  const execImpl = (cmd, args) => {
    calls.push([cmd, ...args].join(' '));
    const device = args[args.length - 1];
    if (device === '/dev/sdc') { const err = new Error('exit 2'); err.stdout = ''; throw err; }
    return JSON.stringify(outputs[device]);
  };
  const out = collectSmartReadings({ smartDevices: '/dev/sda /dev/nvme0n1 /dev/sdb /dev/sdc' }, '/m', { execImpl });
  assert.deepStrictEqual(out.driveTemperatures, [
    { device: '/dev/sda', temperatureC: 40 },
    { device: '/dev/nvme0n1', temperatureC: 44 },
    { device: '/dev/sdb', temperatureC: null },
    { device: '/dev/sdc', temperatureC: null },
  ]);
  assert.deepStrictEqual(out.smartHealth.map(d => d.device), ['/dev/sda', '/dev/nvme0n1', '/dev/sdb'], 'health unchanged: unreadable sdc has no entry');
  assert.deepStrictEqual(calls, [
    'smartctl -H -A -j /dev/sda', 'smartctl -H -A -j /dev/nvme0n1', 'smartctl -H -A -j /dev/sdb', 'smartctl -H -A -j /dev/sdc',
  ], 'one call per disk, never a self-test');
  assert.ok(!calls.some(c => / -t /.test(c)));
});

test('bot: the new fields survive sanitizing; bogus values are dropped; absent stays null', () => {
  const value = sanitizeNodeTelemetry({
    collectedAt: 1, temperatureC: 62,
    temperatures: [{ label: 'Package id 0', kind: 'cpu', temperatureC: 62 }, { label: 'bogus', kind: 'cpu', temperatureC: -263 }, { label: 'x', temperatureC: Infinity }, { label: 'PCH', kind: 'other', temperatureC: 48 }],
    fans: [{ label: 'CPU Fan', rpm: 1180.4 }, { label: 'bad', rpm: -5 }],
    driveTemperatures: [{ device: '/dev/sda', temperatureC: 40 }, { device: '/dev/sdb', temperatureC: null }, { temperatureC: 30 }],
  });
  assert.deepStrictEqual(value.temperatures, [{ label: 'Package id 0', kind: 'cpu', temperatureC: 62 }, { label: 'PCH', kind: 'unclassified', temperatureC: 48 }]);
  assert.deepStrictEqual(value.fans, [{ label: 'CPU Fan', rpm: 1180 }]);
  assert.deepStrictEqual(value.driveTemperatures, [{ device: '/dev/sda', temperatureC: 40 }, { device: '/dev/sdb', temperatureC: null }]);
  assert.deepStrictEqual(sanitizeNodeTelemetry({ temperatureC: 50, fans: [] }).fans, [], 'no fan exposed stays an empty list');
  const old = sanitizeNodeTelemetry({ temperatureC: 50 });
  assert.strictEqual(old.temperatures, null, 'an older agent: not reported');
  assert.strictEqual(old.fans, null);
  assert.strictEqual(old.driveTemperatures, null);
});

test('sustained alerting: one spike never alerts, two in a row do, a drop clears with the existing rule', () => {
  assert.strictEqual(SUSTAINED_TEMPERATURE_SAMPLES, 2);
  const now = 1_700_000_000_000;
  const opts = { warnC: 80, criticalC: 90, now };
  let level = 'ok';
  let streak = null;
  const step = temperatureC => {
    const t = { collectedAt: now, temperatureC, temperatureKind: 'cpu' };
    const confirmed = confirmTelemetryLevel(t, assessNodeTelemetry(t, { ...opts, previousLevel: level }), { previousLevel: level, previousStreak: streak, warnC: 80 });
    const changed = confirmed.level !== level;
    level = confirmed.level;
    streak = confirmed.streak;
    return { level, changed, pending: confirmed.pendingLevel, reason: confirmed.reason };
  };
  // Single spikes: recorded, not alerted.
  assert.deepStrictEqual([step(85).level, step(70).level, step(95).level, step(70).level], ['ok', 'ok', 'ok', 'ok']);
  // Two consecutive over the warn line -> warn alert on the second.
  let r = step(82);
  assert.deepStrictEqual([r.level, r.changed, r.pending], ['ok', false, 'warn']);
  r = step(83);
  assert.deepStrictEqual([r.level, r.changed], ['warn', true]);
  assert.match(r.reason, /2 readings in a row/);
  // One critical spike while in warn: stays warn. A second in a row: critical.
  assert.strictEqual(step(91).level, 'warn');
  r = step(92);
  assert.deepStrictEqual([r.level, r.changed], ['critical', true]);
  // Down is immediate, with the unchanged hysteresis: 86 holds critical, 84 drops to warn, 76
  // holds warn, 74 clears.
  assert.deepStrictEqual([step(86).level, step(84).level, step(76).level, step(74).level], ['critical', 'warn', 'warn', 'ok']);
  // A critical spike then a warn reading: two in a row over the warn line -> warn.
  step(95);
  assert.strictEqual(step(81).level, 'warn');
  step(70);
  // Stale/unknown resets the streak; it doesn't count toward confirmation.
  step(85);
  const stale = { collectedAt: now - 13 * 3600000, temperatureC: 85, temperatureKind: 'cpu' };
  const unknown = confirmTelemetryLevel(stale, assessNodeTelemetry(stale, { ...opts, previousLevel: level }), { previousLevel: level, previousStreak: streak });
  assert.deepStrictEqual([unknown.level, unknown.streak], ['unknown', { warn: 0, critical: 0 }]);
});

test('display: sensor list, fans and drive temps where present, and a pending note while unconfirmed', () => {
  const telemetry = sanitizeNodeTelemetry({
    collectedAt: Date.now(), temperatureC: 62, temperatureSource: 'Package id 0 (coretemp/hwmon/hwmon2/temp1_input)', temperatureKind: 'cpu',
    temperatures: [{ label: 'Package id 0 (coretemp/hwmon/hwmon2/temp1_input)', kind: 'cpu', temperatureC: 62 }, { label: 'Core 0 (coretemp/hwmon/hwmon2/temp2_input)', kind: 'cpu', temperatureC: 59 }, { label: 'pch_cannonlake (hwmon/hwmon3/temp1_input)', kind: 'unclassified', temperatureC: 48 }],
    fans: [], driveTemperatures: [{ device: '/dev/sda', temperatureC: 40 }, { device: '/dev/sdb', temperatureC: null }],
  });
  assert.strictEqual(telemetryDetail(telemetry), 'sensors: Package id 0 62.0°C, Core 0 59.0°C, pch_cannonlake 48.0°C · drives: /dev/sda 40°C, /dev/sdb n/a', 'no fans line when none are exposed');
  assert.strictEqual(telemetryDetail(sanitizeNodeTelemetry({ temperatureC: 50 })), null, 'older agent: nothing extra');
  const plan = { lastHeartbeatAt: Date.now(), lastTelemetry: telemetry, lastTelemetryLevel: 'ok', lastTelemetryStreak: { warn: 1, critical: 0 } };
  assert.match(pendingTemperatureNote(plan), /at or above 80°C for 1 reading\(s\); alerts after 2 in a row/);
  const details = tierNodeStatus(plan, null).details;
  assert.match(details, /62\.0°C CPU \(Package id 0/, 'current temp and source as before');
  assert.match(details, /sensors: Package id 0 62\.0°C/);
  assert.match(details, /drives: \/dev\/sda 40°C/);
});
