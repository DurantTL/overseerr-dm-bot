#!/usr/bin/env node
const { test } = require('node:test');
const assert = require('node:assert');
const { mergeFleetDisks, evaluateFleetDiskAlerts, evaluateSmartTransitions } = require('../../src/fleet-disks');
const { assessDiskLevel, sanitizeSmartHealth } = require('../../src/node-telemetry');

const GB = 1024 ** 3;
const thresholds = { warnFreePct: 15, urgentFreePct: 8, clearMarginPct: 3 };

test('fleet disks: *arr volumes and tier-agent disks merge with source and node labels', () => {
  const now = Date.now();
  const disks = mergeFleetDisks({
    arrDisks: [{ path: '/share/media', displayPath: '/share/media', totalSpace: 8 * GB, freeSpace: 2 * GB }],
    tierNodes: [
      { name: 'california', telemetry: { collectedAt: now - 60000, filesystemTotalBytes: 8 * GB, filesystemFreeBytes: 1 * GB, smartHealth: [{ device: '/dev/sda', health: 'ok' }] } },
      { name: 'europe', telemetry: null },
    ],
    now,
  });
  assert.strictEqual(disks.length, 2);
  assert.deepStrictEqual(disks[0], { name: '/share/media', freeBytes: 2 * GB, totalBytes: 8 * GB, percentUsed: 75, source: 'arr', node: 'durant-server', telemetryAgeMs: null, smartHealth: null });
  assert.deepStrictEqual(disks[1], { name: 'california', freeBytes: 1 * GB, totalBytes: 8 * GB, percentUsed: 87.5, source: 'tier-agent', node: 'california', telemetryAgeMs: 60000, smartHealth: [{ device: '/dev/sda', health: 'ok' }] });
});

test('fleet disks: stale telemetry is included with its age, nodes without telemetry are skipped', () => {
  const now = Date.now();
  const disks = mergeFleetDisks({
    arrDisks: [],
    tierNodes: [
      { name: 'europe', telemetry: { collectedAt: now - 45 * 60 * 1000, filesystemTotalBytes: 10 * GB, filesystemFreeBytes: 9 * GB } },
      { name: 'ghost', telemetry: { collectedAt: now } },
    ],
    now,
  });
  assert.strictEqual(disks.length, 1);
  assert.strictEqual(disks[0].node, 'europe');
  assert.strictEqual(disks[0].telemetryAgeMs, 45 * 60 * 1000);
});

test('fleet disks: impossible byte counts surface as unknown, never NaN', () => {
  const disks = mergeFleetDisks({
    arrDisks: [{ path: '/bad', totalSpace: -1, freeSpace: 5 * GB }],
    tierNodes: [],
  });
  assert.strictEqual(disks.length, 1);
  assert.strictEqual(disks[0].percentUsed, null);
  const { events, levels } = evaluateFleetDiskAlerts({
    arrDisks: [{ path: '/bad', totalSpace: -1, freeSpace: 5 * GB }],
    tierNodes: [],
    getAlertState: () => null,
    ...thresholds,
  });
  assert.strictEqual(events.length, 0, 'garbage readings never page');
  assert.strictEqual(levels['arr:/bad'], 'unknown');
});

test('disk level: thresholds with hysteresis do not flap near a boundary', () => {
  const at = freePct => ({ freeBytes: freePct * GB, totalBytes: 100 * GB });
  assert.strictEqual(assessDiskLevel(at(20), { ...thresholds, previousLevel: 'unknown' }).level, 'ok');
  assert.strictEqual(assessDiskLevel(at(14), { ...thresholds, previousLevel: 'unknown' }).level, 'warn');
  assert.strictEqual(assessDiskLevel(at(7), { ...thresholds, previousLevel: 'unknown' }).level, 'urgent');
  // Riding the warn boundary: 16% free stays warn (clear needs >18%), 19% clears to ok.
  assert.strictEqual(assessDiskLevel(at(16), { ...thresholds, previousLevel: 'warn' }).level, 'warn');
  assert.strictEqual(assessDiskLevel(at(19), { ...thresholds, previousLevel: 'warn' }).level, 'ok');
  // Urgent holds until free climbs past 11%: 9% stays urgent, 12% steps down to warn.
  assert.strictEqual(assessDiskLevel(at(9), { ...thresholds, previousLevel: 'urgent' }).level, 'urgent');
  assert.strictEqual(assessDiskLevel(at(12), { ...thresholds, previousLevel: 'urgent' }).level, 'warn');
  // Unreadable free space is unknown, not a 0% emergency.
  assert.strictEqual(assessDiskLevel({ freeBytes: null, totalBytes: 100 * GB }, { ...thresholds, previousLevel: 'unknown' }).level, 'unknown');
  assert.strictEqual(assessDiskLevel({ freeBytes: 0, totalBytes: 100 * GB }, { ...thresholds, previousLevel: 'unknown' }).level, 'urgent');
});

test('disk alerts: warn, escalate, and recover emit exactly one transition each', () => {
  const states = {};
  const run = freeGB => evaluateFleetDiskAlerts({
    arrDisks: [],
    tierNodes: [{ name: 'california', telemetry: { collectedAt: Date.now(), filesystemTotalBytes: 100 * GB, filesystemFreeBytes: freeGB * GB } }],
    getAlertState: key => states[key] || null,
    ...thresholds,
  });
  let r = run(7);
  assert.strictEqual(r.events.length, 1, 'a first reading that is already bad still pages once');
  assert.strictEqual(r.events[0].key, 'tier:california');
  assert.strictEqual(r.events[0].to, 'urgent');
  states['tier:california'] = { level: 'urgent' };
  r = run(7);
  assert.strictEqual(r.events.length, 0, 'repeating the same level is quiet');
  r = run(12);
  assert.strictEqual(r.events.length, 1);
  assert.deepStrictEqual([r.events[0].from, r.events[0].to], ['urgent', 'warn']);
  states['tier:california'] = { level: 'warn' };
  r = run(20);
  assert.strictEqual(r.events.length, 1);
  assert.deepStrictEqual([r.events[0].from, r.events[0].to], ['warn', 'ok']);
});

test('disk alerts: stale tier telemetry is unknown and never pages', () => {
  const { events, levels } = evaluateFleetDiskAlerts({
    arrDisks: [],
    tierNodes: [{ name: 'europe', telemetry: { collectedAt: Date.now() - 13 * 60 * 60 * 1000, filesystemTotalBytes: 100 * GB, filesystemFreeBytes: 1 * GB } }],
    getAlertState: () => null,
    ...thresholds,
  });
  assert.strictEqual(events.length, 0);
  assert.strictEqual(levels['tier:europe'], 'unknown');
});

test('smart transitions: newly failing pages, recovery clears, unchanged stays quiet', () => {
  const mk = smart => [{ name: 'california', telemetry: { collectedAt: Date.now(), smartHealth: smart } }];
  let r = evaluateSmartTransitions({ tierNodes: mk([{ device: '/dev/sda', health: 'failing' }]), getPreviousFailing: () => [] });
  assert.strictEqual(r.events.length, 1);
  assert.deepStrictEqual(r.events[0].newlyFailing, ['/dev/sda']);
  assert.deepStrictEqual(r.failingByNode, { california: ['/dev/sda'] });
  r = evaluateSmartTransitions({ tierNodes: mk([{ device: '/dev/sda', health: 'failing' }]), getPreviousFailing: () => ['/dev/sda'] });
  assert.strictEqual(r.events.length, 0);
  r = evaluateSmartTransitions({ tierNodes: mk([{ device: '/dev/sda', health: 'ok' }]), getPreviousFailing: () => ['/dev/sda'] });
  assert.strictEqual(r.events.length, 1);
  assert.deepStrictEqual(r.events[0].recovered, ['/dev/sda']);
  assert.deepStrictEqual(r.failingByNode, { california: [] });
  // No SMART data at all — not an event, not a failure.
  r = evaluateSmartTransitions({ tierNodes: [{ name: 'europe', telemetry: { collectedAt: Date.now() } }], getPreviousFailing: () => null });
  assert.strictEqual(r.events.length, 0);
  assert.deepStrictEqual(r.failingByNode, {});
});

test('sanitizeSmartHealth: caps entries, device length, and accepted statuses', () => {
  const raw = Array.from({ length: 10 }, (_, i) => ({ device: `/dev/sd${i}`, health: i % 2 ? 'failing' : 'ok' }));
  const out = sanitizeSmartHealth(raw);
  assert.strictEqual(out.length, 8, 'at most 8 entries');
  const long = sanitizeSmartHealth([{ device: '/dev/' + 'x'.repeat(200), health: 'ok' }]);
  assert.strictEqual(long[0].device.length, 80, 'device names are capped');
  const odd = sanitizeSmartHealth([{ device: '/dev/odd', health: 'unknown' }]);
  assert.strictEqual(odd, null, 'invalid statuses are dropped');
  assert.strictEqual(sanitizeSmartHealth('nope'), null);
  assert.strictEqual(sanitizeSmartHealth([]), null);
});
