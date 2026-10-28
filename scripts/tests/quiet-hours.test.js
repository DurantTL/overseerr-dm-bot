#!/usr/bin/env node
'use strict';
// F7 quiet hours (src/quiet-hours.js): the window wraps midnight in the configured time zone,
// silenced posts get Discord's silent flag and are noted, and the digest waits for the window to
// end, groups by category, skips log channels, and survives a failed post.
const { test } = require('node:test');
const assert = require('node:assert');

const qh = require('../../src/quiet-hours');

// 2026-10-28 is CDT (UTC-5) in America/Chicago.
const at = (hhmm) => Date.parse(`2026-10-28T${hhmm}:00Z`);
const CHI_2300 = at('04:00') + 86400000; // 23:00 Chicago on the 28th
const CHI_0300 = at('08:00');            // 03:00 Chicago
const CHI_0700 = at('12:00');            // 07:00 Chicago
const CHI_1200 = at('17:00');            // 12:00 Chicago

function memoryStore() {
  const map = new Map();
  return { get: k => map.get(k) ?? null, set: (k, v) => map.set(k, v), del: k => map.delete(k), map };
}

test('window wraps midnight, end hour is exclusive, equal hours mean no window', () => {
  assert.strictEqual(qh.inWindow(23, 22, 7), true);
  assert.strictEqual(qh.inWindow(3, 22, 7), true);
  assert.strictEqual(qh.inWindow(7, 22, 7), false);
  assert.strictEqual(qh.inWindow(21, 22, 7), false);
  assert.strictEqual(qh.inWindow(13, 12, 14), true);
  assert.strictEqual(qh.inWindow(14, 12, 14), false);
  assert.strictEqual(qh.inWindow(5, 5, 5), false);
});

test('local hour follows the configured time zone, not UTC', () => {
  assert.strictEqual(qh.localHour(CHI_0300, 'America/Chicago'), 3);
  assert.strictEqual(qh.localHour(CHI_0300, 'UTC'), 8);
  assert.strictEqual(qh.validTimeZone('America/Chicago'), true);
  assert.strictEqual(qh.validTimeZone('Mars/Olympus'), false);
});

test('silence adds the silent flag and keeps existing flags and content', () => {
  assert.deepStrictEqual(qh.silence('hello'), { content: 'hello', flags: qh.SUPPRESS_NOTIFICATIONS });
  const embeds = [{ data: { title: 'x' } }];
  const out = qh.silence({ embeds, flags: 4 });
  assert.strictEqual(out.flags, 4 | qh.SUPPRESS_NOTIFICATIONS);
  assert.strictEqual(out.embeds, embeds);
});

test('message titles come from the embed builder, a plain embed, or the first content line', () => {
  assert.strictEqual(qh.messageTitle({ embeds: [{ data: { title: 'Built' } }] }), 'Built');
  assert.strictEqual(qh.messageTitle({ embeds: [{ title: 'Plain' }] }), 'Plain');
  assert.strictEqual(qh.messageTitle({ content: 'first\nsecond' }), 'first');
  assert.strictEqual(qh.messageTitle('just text'), 'just text');
  assert.strictEqual(qh.messageTitle({}), 'Notification');
});

test('quiet only while enabled and inside the window', () => {
  let enabled = true;
  const q = qh.createQuietHours({ settings: () => ({ enabled, start: 22, end: 7, tz: 'America/Chicago' }), store: memoryStore() });
  assert.strictEqual(q.isQuiet(CHI_2300), true);
  assert.strictEqual(q.isQuiet(CHI_0300), true);
  assert.strictEqual(q.isQuiet(CHI_0700), false);
  enabled = false;
  assert.strictEqual(q.isQuiet(CHI_0300), false);
});

test('digest waits for the window to end, groups by category, skips log channels, clears only when told', () => {
  const store = memoryStore();
  let now = CHI_2300;
  const q = qh.createQuietHours({ settings: () => ({ enabled: true, start: 22, end: 7, tz: 'America/Chicago' }), store, now: () => now });
  q.record('downloads', { embeds: [{ data: { title: 'Show [S01E02] imported' } }] }, { url: 'https://discord.com/channels/1/2/3' });
  q.record('system', { embeds: [{ data: { title: 'Sonarr down' } }] }, { url: 'https://discord.com/channels/1/2/4' });
  q.record('audit', { content: 'audit line' }, null);
  q.record('downloads', 'Another download', null);
  assert.strictEqual(q.pendingDigest(), null, 'no digest while still quiet');

  now = CHI_0700;
  const pending = q.pendingDigest();
  assert.strictEqual(pending.items.length, 4);
  assert.strictEqual(pending.digest.title, 'Overnight digest: 3 posts');
  assert.strictEqual(pending.digest.description, [
    '**Health** (1)\n• [Sonarr down](https://discord.com/channels/1/2/4)',
    '**Downloads** (2)\n• [Show S01E02 imported](https://discord.com/channels/1/2/3)\n• Another download',
  ].join('\n\n'));
  assert.ok(q.pendingDigest(), 'still pending until cleared, so a failed post is retried');
  q.clear();
  assert.strictEqual(q.pendingDigest(), null);
});

test('only log channels silenced: nothing to digest', () => {
  assert.strictEqual(qh.buildDigest([{ kind: 'audit', title: 'x' }, { kind: 'deploy', title: 'y' }]), null);
});

test('long groups are capped with a count, and the description stays under the embed limit', () => {
  const items = Array.from({ length: 300 }, (_, i) => ({ kind: i % 2 ? 'downloads' : 'requests', title: `${'T'.repeat(100)} ${i}`, url: `https://discord.com/channels/1/2/${i}` }));
  const digest = qh.buildDigest(items);
  assert.match(digest.description, /…and 140 more/);
  assert.ok(digest.description.length <= 4096);
});

test('the stored list is capped and a corrupt row reads as empty', () => {
  const store = memoryStore();
  const q = qh.createQuietHours({ settings: () => ({ enabled: true, start: 0, end: 23, tz: 'UTC' }), store, now: () => CHI_1200 });
  for (let i = 0; i < 310; i++) q.record('downloads', `n${i}`, null);
  assert.strictEqual(JSON.parse(store.map.get('quiet_digest_items')).length, 300);
  store.set('quiet_digest_items', '{not json');
  assert.doesNotThrow(() => q.record('downloads', 'after', null));
});

test('only disk and drive health posts bypass quiet hours', () => {
  const source = require('fs').readFileSync(require('path').join(__dirname, '../../index.js'), 'utf8');
  const urgent = [...source.matchAll(/notifyChannel\('([a-z]+)', \{ embeds: \[brandedEmbed\([^)]*\)\s*\.setTitle\(([^\n]+)\)[\s\S]*?\] \}(, \{ urgent: true \})?\);/g)]
    .filter(m => m[3]).map(m => m[2]);
  assert.deepStrictEqual(urgent.sort(), [
    "'Storage Capacity Warning'",
    '`${icon} Disk space ${recovered ? \'recovered\' : event.to} — ${event.label}`',
    '`💽 Drive health — ${event.node}`',
  ].sort());
  assert.strictEqual(source.split('] }, { urgent: true });').length - 1, 3);
});
