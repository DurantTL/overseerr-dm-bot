#!/usr/bin/env node
'use strict';
// F10 viewing insights (src/viewing-insights.js): top titles and per-person hours from the last
// week of Tautulli history, and recent additions split into hits (played within 3 days of
// arriving) and untouched (here a week or more, never played).
const { test } = require('node:test');
const assert = require('node:assert');
const v = require('../../src/viewing-insights');

const NOW = Date.parse('2026-11-02T15:00:00Z');
const DAY = 86400000;
const sec = ms => Math.floor(ms / 1000);
const movie = (key, title, user, daysAgo, minutes = 120) => ({ media_type: 'movie', rating_key: key, title, friendly_name: user, date: sec(NOW - daysAgo * DAY), play_duration: minutes * 60 });
const episode = (show, title, user, daysAgo, minutes = 45) => ({ media_type: 'episode', rating_key: `${show}-e`, grandparent_rating_key: show, grandparent_title: title, title: 'Ep', friendly_name: user, date: sec(NOW - daysAgo * DAY), play_duration: minutes * 60 });

test('plays: music and keyless rows are dropped, episodes count under their show', () => {
  assert.strictEqual(v.toPlay({ media_type: 'track', rating_key: '1', date: 1 }), null);
  assert.strictEqual(v.toPlay({ media_type: 'movie', date: 1 }), null);
  const p = v.toPlay(episode('700', 'Slow Horses', 'ana', 1));
  assert.deepStrictEqual([p.key, p.title, p.type, p.user, p.seconds], ['700', 'Slow Horses', 'tv', 'ana', 2700]);
  assert.strictEqual(v.toPlay({ media_type: 'movie', rating_key: '9', title: 'X', user: 'bo', date: 10, duration: 'n/a' }).seconds, 0);
});

test('weekly digest: top titles, hours per person, older plays ignored', () => {
  const historyRows = [
    movie('501', 'Dune', 'ana', 1), movie('501', 'Dune', 'bo', 2), movie('502', 'Arrival', 'ana', 3),
    episode('700', 'Slow Horses', 'ana', 1), episode('700', 'Slow Horses', 'ana', 2), episode('700', 'Slow Horses', 'bo', 4),
    movie('503', 'Old News', 'cy', 12),
  ];
  const out = v.buildViewingInsights({ historyRows, now: NOW });
  assert.strictEqual(out.title, 'Viewing this week: 6 plays · 8.3 h · 2 viewers');
  const field = name => out.fields.find(f => f.name === name)?.value;
  assert.strictEqual(field('🎬 Top movies'), '1. Dune: 2 plays · 2 viewers\n2. Arrival: 1 play · 1 viewer');
  assert.strictEqual(field('📺 Top shows'), '1. Slow Horses: 3 plays · 2 viewers');
  assert.strictEqual(field('👥 Who watched'), '**ana**: 5.5 h · 4 plays · mostly Slow Horses\n**bo**: 2.8 h · 2 plays · mostly Dune');
  assert.ok(!JSON.stringify(out).includes('Old News'), 'plays older than a week are not in the weekly numbers');
});

test('new additions: hits within 3 days, untouched after a week, too-new ones not judged', () => {
  const added = [
    { titleKey: '601', title: 'Hit Movie', addedAt: NOW - 5 * DAY },
    { titleKey: '602', title: 'Slow Burn', addedAt: NOW - 10 * DAY },
    { titleKey: '603', title: 'Ignored', addedAt: NOW - 9 * DAY },
    { titleKey: '604', title: 'Brand New', addedAt: NOW - 2 * DAY },
    { titleKey: '700', title: 'Slow Horses', addedAt: NOW - 20 * DAY },
    { titleKey: '700', title: 'Slow Horses', addedAt: NOW - 4 * DAY },
    { titleKey: '605', title: 'Too Old', addedAt: NOW - 30 * DAY },
  ];
  const historyRows = [
    movie('601', 'Hit Movie', 'ana', 4.5), movie('601', 'Hit Movie', 'bo', 3),
    movie('602', 'Slow Burn', 'ana', 2), // 8 days after arriving: watched, but not a hit
    episode('700', 'Slow Horses', 'cy', 3.5), // within 3 days of the newest episode
  ];
  const out = v.buildViewingInsights({ historyRows, added, now: NOW });
  const field = name => out.fields.find(f => f.name === name)?.value;
  assert.strictEqual(field('🔥 New and watched fast'), 'Hit Movie: 2 viewers\nSlow Horses: 1 viewer');
  assert.strictEqual(field('💤 New but not watched yet'), 'Ignored: added 9 days ago');
});

test('a quiet week says so', () => {
  const out = v.buildViewingInsights({ historyRows: [], added: [], now: NOW });
  assert.strictEqual(out.title, 'Viewing this week: nothing was played');
  assert.deepStrictEqual(out.fields, []);
});

test('long lists are capped and fields stay under Discord limits', () => {
  const historyRows = Array.from({ length: 40 }, (_, i) => movie(String(1000 + i), `Movie ${'x'.repeat(60)} ${i}`, `user-${i}`, 1));
  const added = Array.from({ length: 30 }, (_, i) => ({ titleKey: String(2000 + i), title: `Unwatched ${'y'.repeat(200)} ${i}`, addedAt: NOW - 10 * DAY }));
  const out = v.buildViewingInsights({ historyRows, added, now: NOW });
  assert.match(out.fields.find(f => f.name === '👥 Who watched').value, /…and 3[01] more$/);
  assert.ok(out.fields.every(f => f.value.length <= 1024));
  assert.strictEqual(out.fields.find(f => f.name === '🎬 Top movies').value.split('\n').length, 5);
});

test('fit keeps whole lines and always shows how many were left out', () => {
  assert.strictEqual(v.fit(['a', 'b'], 0), 'a\nb');
  assert.strictEqual(v.fit(['a'], 3), 'a\n…and 3 more');
  const out = v.fit(Array.from({ length: 50 }, (_, i) => `${'z'.repeat(40)} ${i}`), 2);
  assert.ok(out.length <= 1024);
  const kept = out.split('\n').length - 1;
  assert.ok(out.endsWith(`…and ${50 - kept + 2} more`));
});
