#!/usr/bin/env node
const { test } = require('node:test');
const assert = require('node:assert');
const { webhookEventKey } = require('../../src/webhook-events');
const { canonicalizeEmail, isValidEmail, isSnowflake } = require('../../src/util');
const { loadSandbox } = require('./extract');

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

test('webhook-events: Plex and Tautulli share a watched key for one resolved viewer', () => {
  const plex = {
    event: 'media.scrobble',
    Server: { uuid: 'M1' },
    Metadata: { type: 'movie', ratingKey: 'r1', Guid: [{ id: 'tmdb://5' }] },
    Account: { id: 1 },
  };
  const tautulli = { event: 'watched', media_type: 'movie', tmdb_id: 5, machine_id: 'm1', user_email: 'a@example.com' };
  assert.strictEqual(webhookEventKey('plex', plex, 'discord:123'), 'watched:m1:tmdb:5:discord:123');
  assert.strictEqual(webhookEventKey('tautulli', tautulli, 'discord:123'), webhookEventKey('plex', plex, 'discord:123'));
});

test('webhook-events: different resolved viewers do not share a watched key', () => {
  const body = { event: 'watched', media_type: 'movie', tmdb_id: 5, machine_id: 'm1', user_email: 'a@example.com' };
  assert.notStrictEqual(webhookEventKey('tautulli', body, 'discord:123'), webhookEventKey('tautulli', body, 'discord:456'));
});

test('webhook-events: unresolved viewers keep source-specific keys', () => {
  const plex = { event: 'media.scrobble', Server: { uuid: 'm1' }, Metadata: { type: 'movie', ratingKey: 'r1', Guid: [{ id: 'tmdb://5' }] }, Account: { id: 1 } };
  const tautulli = { event: 'watched', media_type: 'movie', tmdb_id: 5, machine_id: 'm1' };
  assert.match(webhookEventKey('plex', plex), /^plex:/);
  assert.match(webhookEventKey('tautulli', tautulli), /^tautulli:/);
  assert.notStrictEqual(webhookEventKey('plex', plex), webhookEventKey('tautulli', tautulli));
});

test('webhook-events: email identities prefer a linked Discord user', () => {
  const sandbox = loadSandbox(['webhookUserKey'], {
    canonicalizeEmail, isValidEmail, isSnowflake,
    getUserByCanonicalEmail: email => canonicalizeEmail(email) === 'viewer@gmail.com' ? { discord_id: '123456789012345678' } : null,
  });
  assert.strictEqual(sandbox.run("webhookUserKey('Viewer+plex@gmail.com')"), 'discord:123456789012345678');
  assert.strictEqual(sandbox.run("webhookUserKey('other@example.com')"), 'email:other@example.com');
  assert.strictEqual(sandbox.run("webhookUserKey('not-an-email')"), null);
});

test('webhook-events: Plex account resolution includes friends and the server owner', async () => {
  const calls = [];
  const sandbox = loadSandbox(['resolvePlexWebhookEmail'], {
    plexWebhookAccountCache: { expiresAt: 0, emails: new Map() },
    getPlexToken: async () => 'token',
    plexApiGet: async path => {
      calls.push(path);
      return path.endsWith('/friends') ? [{ id: 7, email: 'friend@example.com' }] : { id: 9, email: 'owner@example.com' };
    },
    isValidEmail,
    log: { warn() {} },
  });
  assert.strictEqual(await sandbox.run('resolvePlexWebhookEmail(7)'), 'friend@example.com');
  assert.strictEqual(await sandbox.run('resolvePlexWebhookEmail(9)'), 'owner@example.com');
  assert.deepStrictEqual(calls, ['/api/v2/friends', '/api/v2/user'], 'the second lookup uses the cache');
});

test('webhook-events: unknown source still produces a key rather than throwing', () => {
  assert.strictEqual(webhookEventKey('mystery', {}), 'mystery:unknown');
});
