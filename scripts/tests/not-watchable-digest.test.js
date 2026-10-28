#!/usr/bin/env node
'use strict';
// F9 weekly "Not Watchable Yet" digest (src/not-watchable-digest.js): due once on the configured
// local day from the configured hour, grouped by requester, oldest first, links only when a
// public Seerr address is set.
const { test } = require('node:test');
const assert = require('node:assert');
const d = require('../../src/not-watchable-digest');

const TZ = 'America/Chicago';
// Monday 2026-11-02 is CST (UTC-6).
const MON_0859 = Date.parse('2026-11-02T14:59:00Z');
const MON_0900 = Date.parse('2026-11-02T15:00:00Z');
const MON_2330 = Date.parse('2026-11-03T05:30:00Z');
const TUE_0900 = Date.parse('2026-11-03T15:00:00Z');

test('local parts follow the time zone', () => {
  assert.deepStrictEqual(d.localParts(MON_0900, TZ), { date: '2026-11-02', weekday: 1, hour: 9 });
  assert.deepStrictEqual(d.localParts(MON_2330, TZ), { date: '2026-11-02', weekday: 1, hour: 23 });
});

test('due from the hour to the end of the day, once', () => {
  const base = { tz: TZ, day: 1, hour: 9, lastKey: null };
  assert.strictEqual(d.dueKey({ ...base, now: MON_0859 }), null);
  assert.strictEqual(d.dueKey({ ...base, now: MON_0900 }), '2026-11-02');
  assert.strictEqual(d.dueKey({ ...base, now: MON_2330 }), '2026-11-02', 'a late start still posts that day');
  assert.strictEqual(d.dueKey({ ...base, now: MON_2330, lastKey: '2026-11-02' }), null, 'only once');
  assert.strictEqual(d.dueKey({ ...base, now: TUE_0900 }), null, 'a missed Monday does not post Tuesday');
});

const DAY = 86400000;
const row = (digest) => ({ title: 'x', digest });

test('groups by requester, busiest first, oldest request first, failures marked', () => {
  const rows = [
    row({ title: 'Dune', mediaType: 'movie', tmdbId: 438631, requesterId: '111111111111111111', requestedAt: MON_0900 - 3 * DAY, status: 'approved · 1 item in the download queue', failed: false }),
    row({ title: 'Severance', mediaType: 'tv', tmdbId: 95396, requesterId: '222222222222222222', requestedAt: MON_0900 - 20 * DAY, status: '2 episodes missing · nothing in flight', failed: false }),
    row({ title: 'Arrival', mediaType: 'movie', tmdbId: 329865, requesterId: '111111111111111111', requestedAt: MON_0900 - 10 * DAY, status: 'failed · nothing in flight', failed: true }),
    row({ title: 'Orphan', mediaType: 'movie', tmdbId: null, requesterId: null, requestedAt: null, status: 'pending · nothing in flight', failed: false }),
    { title: 'no digest part' },
  ];
  const out = d.buildNotWatchableDigest(rows, { now: MON_0900, seerrUrl: 'https://seerr.example.test/' });
  assert.strictEqual(out.title, 'Not Watchable Yet: 4 titles');
  assert.strictEqual(out.description, [
    '<@111111111111111111> (2)\n❌ [Arrival](https://seerr.example.test/movie/329865): failed · nothing in flight · requested 10 days ago\n• [Dune](https://seerr.example.test/movie/438631): approved · 1 item in the download queue · requested 3 days ago',
    '<@222222222222222222> (1)\n• [Severance](https://seerr.example.test/tv/95396): 2 episodes missing · nothing in flight · requested 20 days ago',
    '**Requester unknown** (1)\n• **Orphan**: pending · nothing in flight',
  ].join('\n\n'));
});

test('no public Seerr address: plain titles, no links', () => {
  const out = d.buildNotWatchableDigest([row({ title: 'Dune', mediaType: 'movie', tmdbId: 1, requesterId: null, requestedAt: MON_0900, status: 's', failed: false })], { now: MON_0900 });
  assert.match(out.description, /\*\*Dune\*\*: s · requested today/);
  assert.ok(!out.description.includes('http'));
});

test('nothing open: an all-clear post', () => {
  assert.strictEqual(d.buildNotWatchableDigest([], {}).title, 'Not Watchable Yet: all clear');
});

test('long lists are capped per requester and under the embed limit', () => {
  const rows = Array.from({ length: 80 }, (_, i) => row({ title: `${'T'.repeat(80)} ${i}`, mediaType: 'movie', tmdbId: i + 1, requesterId: `10000000000000000${i % 4}`, requestedAt: MON_0900 - i * DAY, status: 'approved · nothing in flight', failed: false }));
  const out = d.buildNotWatchableDigest(rows, { now: MON_0900, seerrUrl: 'https://s.example.test' });
  assert.match(out.description, /…and 10 more/);
  assert.ok(out.description.length <= 4096);
});
