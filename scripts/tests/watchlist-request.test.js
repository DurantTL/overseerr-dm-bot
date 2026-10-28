#!/usr/bin/env node
'use strict';
// F12: Seerr's own Plex-watchlist auto-requests. Seerr's webhook doesn't mark them, so the bot
// looks the request up (isAutoRequest) and then notes the source on the admin card and tells
// the requester, in one DM, why a request appeared. Bot-made requests are never looked up.
const { test } = require('node:test');
const assert = require('node:assert');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { loadSandbox } = require('./extract');

function fakeEmbed() {
  const e = { data: { fields: [] } };
  e.setTitle = t => { e.data.title = t; return e; };
  e.setDescription = d => { e.data.description = d; return e; };
  e.addFields = (...f) => { e.data.fields.push(...f.flat()); return e; };
  e.setThumbnail = () => e; e.setImage = () => e; e.setFooter = () => e;
  return e;
}

function bed({ watchlist, posted = [] }) {
  const state = { dms: [], cards: [], lookups: [], audits: [] };
  const sandbox = loadSandbox(['handleOverseerrWebhook'], {
    CONFIG: { ADMIN_USER_ID: '999999999999999999', WHATS_NEW_ENABLED: false },
    COLORS: { SUCCESS: 1, INFO: 2, WARN: 3, DANGER: 4 },
    ActionRowBuilder, ButtonBuilder, ButtonStyle,
    db: { prepare: () => ({ get: () => null }) },
    isSnowflake: v => /^\d{17,20}$/.test(String(v || '')),
    resolveRequester: () => ({ discordId: '111111111111111111', email: 'm@example.test', source: 'payload' }),
    posterUrl: () => null,
    postedApprovalNotices: new Set(posted),
    isSeerrWatchlistRequest: async id => { state.lookups.push(id); return watchlist; },
    safeGetChannel: async () => ({ send: async m => state.cards.push(m) }),
    channelFor: () => '1',
    brandedEmbed: fakeEmbed,
    mediaTypeEmoji: () => '🎬', mediaTypeLabel: () => 'Movie',
    dmUser: async (id, payload) => { state.dms.push({ id, title: payload.embeds[0].data.title, text: payload.embeds[0].data.description }); return true; },
    audit: (action, meta) => state.audits.push({ action, meta }),
    upsertRequest: () => {}, resolveEscalationForMediaKey: () => {},
    fetchReleaseEta: async () => null, releaseEtaInfo: () => null,
    clearRequestSubscribers: () => {}, subscriberKeyFor: () => 'k', tvSeasonsForMediaId: () => null,
  });
  return { sandbox, state };
}

const body = type => ({ notification_type: type, subject: 'Movie Request - Dune', media: { media_type: 'movie', tmdbId: 438631 }, request: { request_id: '42' } });

test('pending watchlist request: admin card says so, requester gets one DM explaining it', async () => {
  const { sandbox, state } = bed({ watchlist: true });
  await sandbox.handleOverseerrWebhook(body('MEDIA_PENDING'));
  assert.deepStrictEqual(state.lookups, ['42']);
  const fields = state.cards[0].embeds[0].data.fields;
  assert.ok(fields.some(f => f.name === 'Source' && /Plex watchlist/.test(f.value)));
  assert.strictEqual(state.cards[0].components.length, 1, 'Approve/Deny buttons kept');
  assert.strictEqual(state.dms.length, 1);
  assert.strictEqual(state.dms[0].title, '📋 Added From Your Plex Watchlist');
  assert.match(state.dms[0].text, /waiting for an admin/);
  assert.ok(state.audits.some(a => a.action === 'seerr_request_received' && a.meta.fromWatchlist === true));
});

test('auto-approved watchlist request: one DM, the approval one, saying where it came from', async () => {
  const { sandbox, state } = bed({ watchlist: true });
  await sandbox.handleOverseerrWebhook(body('MEDIA_AUTO_APPROVED'));
  assert.strictEqual(state.dms.length, 1);
  assert.strictEqual(state.dms[0].title, '📋 Added From Your Plex Watchlist');
  assert.match(state.dms[0].text, /^It was on your Plex watchlist[\s\S]*\*\*Dune\*\* was approved/);
});

test('a request made in Seerr directly is unchanged: no source note, no extra DM', async () => {
  const { sandbox, state } = bed({ watchlist: false });
  await sandbox.handleOverseerrWebhook(body('MEDIA_PENDING'));
  assert.ok(!state.cards[0].embeds[0].data.fields.some(f => f.name === 'Source'));
  assert.strictEqual(state.dms.length, 0);
  await sandbox.handleOverseerrWebhook(body('MEDIA_AUTO_APPROVED'));
  assert.deepStrictEqual(state.dms.map(d => d.title), ['🎉 Request Approved']);
});

test('requests the bot already posted are not looked up', async () => {
  const { sandbox, state } = bed({ watchlist: true, posted: ['42'] });
  await sandbox.handleOverseerrWebhook(body('MEDIA_PENDING'));
  assert.deepStrictEqual(state.lookups, []);
  assert.strictEqual(state.dms.length, 0);
});
