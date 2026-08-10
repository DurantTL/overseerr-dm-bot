#!/usr/bin/env node
const { test } = require('node:test');
const assert = require('node:assert');
const { webhookEventKey } = require('../../src/webhook-events');

test('webhook-events: overseerr key is stable across identical redeliveries', () => {
  const body = { notification_type: 'MEDIA_AVAILABLE', media: { media_type: 'movie', tmdbId: 42 }, request: { request_id: '7' } };
  assert.strictEqual(webhookEventKey('overseerr', body), webhookEventKey('overseerr', body));
});

test('webhook-events: overseerr key falls back to media id when no request id', () => {
  const body = { notification_type: 'MEDIA_AVAILABLE', media: { media_type: 'tv', tvdbId: 99 } };
  assert.strictEqual(webhookEventKey('overseerr', body), 'overseerr:MEDIA_AVAILABLE:tvdb:99');
});

test('webhook-events: overseerr fallback key distinguishes 4K from non-4K', () => {
  const sd = { notification_type: 'MEDIA_AVAILABLE', media: { media_type: 'movie', tmdbId: 42, is4k: false } };
  const uhd = { notification_type: 'MEDIA_AVAILABLE', media: { media_type: 'movie', tmdbId: 42, is4k: true } };
  assert.notStrictEqual(webhookEventKey('overseerr', sd), webhookEventKey('overseerr', uhd), 'a standard and a 4K delivery for the same title must not collide');
});

test('webhook-events: plex key distinguishes by server/rating key/account', () => {
  const base = { event: 'media.scrobble', Server: { uuid: 's1' }, Metadata: { ratingKey: 'r1' }, Account: { id: 1 } };
  const other = { ...base, Metadata: { ratingKey: 'r2' } };
  assert.notStrictEqual(webhookEventKey('plex', base), webhookEventKey('plex', other));
});

test('webhook-events: tautulli key distinguishes by machine/media/user', () => {
  const base = { event: 'watched', media_type: 'movie', tmdb_id: 5, machine_id: 'm1', user_email: 'a@example.com' };
  const other = { ...base, user_email: 'b@example.com' };
  assert.notStrictEqual(webhookEventKey('tautulli', base), webhookEventKey('tautulli', other));
});

test('webhook-events: unknown source still produces a key rather than throwing', () => {
  assert.strictEqual(webhookEventKey('mystery', {}), 'mystery:unknown');
});
