#!/usr/bin/env node
const { test } = require('node:test');
const assert = require('node:assert');
const { createRequestGate } = require('../../src/request-gate');
const { loadSandbox } = require('./extract');

const pendingRequest = () => ({
  discordId: '123456789012345678',
  email: 'viewer@example.com',
  seerrUserId: 9,
  mediaType: 'tv',
  tmdbId: 1396,
  is4k: false,
  label: 'Breaking Bad',
  approvalChannelId: '111111111111111111',
  approvalMessageId: '222222222222222222',
});

function build({ verification = { ok: true }, quotaWarning = null, createError = null } = {}) {
  const state = {
    pending: new Map([['abcd1234', pendingRequest()]]),
    seerrRequests: [],
    requests: [],
    watches: [],
    tags: [],
    trust: new Map(),
    subscribers: new Set(),
    notifications: [],
    closedNotices: [],
    audit: [],
    postedNotices: new Set(),
  };
  const gate = createRequestGate({
    takePendingRequest: nonce => {
      const row = state.pending.get(nonce) || null;
      state.pending.delete(nonce);
      return row;
    },
    restashPendingRequest: (nonce, row) => state.pending.set(nonce, row),
    quotaBlockReason: async () => quotaWarning,
    createSeerrRequestAs: async (userId, mediaType, tmdbId, is4k) => {
      if (createError) throw createError;
      state.seerrRequests.push({ userId, mediaType, tmdbId, is4k });
      return { id: 77, media: { tvdbId: 81189 } };
    },
    verifySeerrRequestCreated: async () => verification,
    markApprovalNoticePosted: id => state.postedNotices.add(id),
    upsertRequest: (requestId, mediaKey, mediaType, is4k, title, discordId, status) => state.requests.push({ requestId, mediaKey, mediaType, is4k, title, discordId, status }),
    canEscalate: () => true,
    recordEscalationWatch: row => state.watches.push(row),
    tagPreAuthorizedMedia: async row => state.tags.push(row),
    bumpTrustScore: (discordId, amount) => state.trust.set(discordId, (state.trust.get(discordId) || 0) + amount),
    resetTrustScore: discordId => state.trust.set(discordId, 0),
    addRequestSubscriber: (key, discordId) => {
      const value = `${key}:${discordId}`;
      const added = !state.subscribers.has(value);
      state.subscribers.add(value);
      return added;
    },
    subscriberKeyFor: (tmdbId, is4k) => `tmdb:${tmdbId}${is4k ? ':4k' : ''}`,
    audit: (action, metadata) => state.audit.push({ action, metadata }),
    notifyApproved: async row => state.notifications.push({ type: 'approved', discordId: row.discordId }),
    notifyAlreadyRequested: async (row, subscribed) => state.notifications.push({ type: 'already', discordId: row.discordId, subscribed }),
    notifyDenied: async row => state.notifications.push({ type: 'denied', discordId: row.discordId }),
    closePendingRequestNotice: async row => state.closedNotices.push(row.approvalMessageId),
    log: { warn() {} },
  });
  return { gate, state };
}

const discordActor = { kind: 'discord', id: '999999999999999999', label: 'admin' };

test('request-gate: pending list returns every valid stash entry', () => {
  const sandbox = loadSandbox(['listPendingRequests'], {
    db: { prepare: () => ({ all: () => [
      { key: 'pending_request:abcd1234', value: JSON.stringify(pendingRequest()), updated_at: '2026-01-01 00:00:00' },
      { key: 'pending_request:badc5678', value: '{bad json', updated_at: '2026-01-02 00:00:00' },
    ] }) },
  });
  const rows = sandbox.run('listPendingRequests()');
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].nonce, 'abcd1234');
  assert.strictEqual(rows[0].label, pendingRequest().label);
  assert.strictEqual(rows[0].createdAt, '2026-01-01 00:00:00');
});

test('request-gate: happy path performs approval side effects and returns identifiers', async () => {
  const { gate, state } = build();
  const result = await gate.approveGatedRequest({ nonce: 'abcd1234', actor: discordActor, azPreAuth: true });
  assert.deepStrictEqual({ ok: result.ok, requestId: result.requestId, mediaKey: result.mediaKey, verified: result.verified, restashed: result.restashed },
    { ok: true, requestId: 77, mediaKey: 'tvdb:81189', verified: true, restashed: false });
  assert.deepStrictEqual(state.requests.map(row => row.mediaKey), ['tvdb:81189', 'tmdb:1396']);
  assert.strictEqual(state.requests.every(row => row.status === 'approved'), true);
  assert.strictEqual(state.watches[0].preAuthorized, true);
  assert.strictEqual(state.tags[0].tvdbId, 81189);
  assert.strictEqual(state.trust.get(pendingRequest().discordId), 1);
  assert.deepStrictEqual([...state.postedNotices], [77]);
  assert.deepStrictEqual(state.notifications, [{ type: 'approved', discordId: pendingRequest().discordId }]);
  assert.deepStrictEqual(state.closedNotices, [pendingRequest().approvalMessageId]);
  const approval = state.audit.find(row => row.action === 'request_approved_gate');
  assert.deepStrictEqual({ kind: approval.metadata.actorKind, id: approval.metadata.actorId, discord: approval.metadata.actorDiscordId },
    { kind: 'discord', id: discordActor.id, discord: discordActor.id });
});

test('request-gate: a lost Seerr request is restashed without approval side effects', async () => {
  const { gate, state } = build({ verification: { ok: false, reason: 'Seerr rolled it back' } });
  const result = await gate.approveGatedRequest({ nonce: 'abcd1234', actor: discordActor });
  assert.deepStrictEqual({ ok: result.ok, requestId: result.requestId, verified: result.verified, restashed: result.restashed, error: result.error },
    { ok: false, requestId: 77, verified: false, restashed: true, error: 'Seerr rolled it back' });
  assert.strictEqual(state.pending.has('abcd1234'), true);
  assert.deepStrictEqual(state.requests, []);
  assert.deepStrictEqual(state.watches, []);
  assert.deepStrictEqual(state.notifications, []);
  assert.deepStrictEqual(state.closedNotices, []);
});

test('request-gate: quota drift warns without blocking approval', async () => {
  const { gate, state } = build({ quotaWarning: 'No series quota remains' });
  const result = await gate.approveGatedRequest({ nonce: 'abcd1234', actor: discordActor });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.quotaWarning, 'No series quota remains');
  assert.strictEqual(state.audit.find(row => row.action === 'request_approved_gate').metadata.overQuota, true);
});

test('request-gate: taking the nonce makes a second approval harmless', async () => {
  const { gate, state } = build();
  assert.strictEqual((await gate.approveGatedRequest({ nonce: 'abcd1234', actor: discordActor })).ok, true);
  const second = await gate.approveGatedRequest({ nonce: 'abcd1234', actor: discordActor });
  assert.deepStrictEqual({ ok: second.ok, error: second.error, pending: second.pending }, { ok: false, error: 'already_handled', pending: null });
  assert.strictEqual(state.seerrRequests.length, 1);
});

test('request-gate: Seerr collisions resolve as subscriptions', async () => {
  const err = Object.assign(new Error('Request already exists'), { response: { status: 409, data: { message: 'Request for this media already exists.' } } });
  const { gate, state } = build({ createError: err });
  const result = await gate.approveGatedRequest({ nonce: 'abcd1234', actor: discordActor });
  assert.strictEqual(result.collision, true);
  assert.strictEqual(result.restashed, false);
  assert.strictEqual(state.requests[0].status, 'approved');
  assert.strictEqual(state.subscribers.size, 1);
  assert.deepStrictEqual(state.notifications, [{ type: 'already', discordId: pendingRequest().discordId, subscribed: true }]);
});

test('request-gate: denial never sends a request to Seerr', async () => {
  const { gate, state } = build();
  const actor = { kind: 'dashboard', id: 'session-1', label: 'Dashboard operator' };
  const result = await gate.denyGatedRequest({ nonce: 'abcd1234', actor });
  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(state.seerrRequests, []);
  assert.strictEqual(state.requests[0].status, 'declined');
  assert.strictEqual(state.trust.get(pendingRequest().discordId), 0);
  assert.deepStrictEqual(state.notifications, [{ type: 'denied', discordId: pendingRequest().discordId }]);
  assert.deepStrictEqual(state.closedNotices, [pendingRequest().approvalMessageId]);
  const denial = state.audit.find(row => row.action === 'request_denied_gate');
  assert.deepStrictEqual({ kind: denial.metadata.actorKind, id: denial.metadata.actorId, discord: denial.metadata.actorDiscordId },
    { kind: 'dashboard', id: 'session-1', discord: undefined });
});

test('request-gate: dashboard actor uses a stable session identity', () => {
  const sandbox = loadSandbox(['readCookie', 'dashboardGateActor'], {
    sha256: value => require('crypto').createHash('sha256').update(value).digest('hex'),
  });
  sandbox.req = { headers: { cookie: 'dm_session=signed-session; other=value' }, ip: '127.0.0.1', socket: {} };
  const actor = sandbox.run('dashboardGateActor(req)');
  assert.strictEqual(actor.kind, 'dashboard');
  assert.match(actor.id, /^session:[0-9a-f]{12}$/);
  assert.strictEqual(actor.id.includes('signed-session'), false);
});

test('request-gate: dashboard responses keep lost requests retryable', () => {
  const sandbox = loadSandbox(['dashboardGateResponse']);
  sandbox.result = { ok: false, requestId: 77, restashed: true, error: 'Seerr rolled it back' };
  const failed = sandbox.run("dashboardGateResponse(result, 'approve')");
  assert.strictEqual(failed.retryable, true);
  assert.match(failed.error, /request #77/);
  assert.match(failed.error, /Seerr rolled it back/);
  sandbox.result = { ok: true, requestId: 78, quotaWarning: 'No series quota remains', pending: pendingRequest(), collision: false };
  const approved = sandbox.run("dashboardGateResponse(result, 'approve')");
  assert.match(approved.message, /request #78/);
  assert.match(approved.message, /Quota warning: No series quota remains/);
});

function gateInteraction(result) {
  const state = { edits: [], followUps: [], deferred: false };
  const sandbox = loadSandbox(['handleGateApprove'], {
    approveGatedRequest: async () => result,
    CONFIG: { AVISTAZ_TAG: 'avistaz' },
    COLORS: { WARN: 1, SUCCESS: 2 },
    mediaTypeEmoji: () => 'TV',
    escalationDelayLabel: () => '1h',
    preAuthOutcomeLabel: () => 'asks first',
    brandedEmbed: () => ({ setTitle(title) { this.title = title; return this; }, setDescription(description) { this.description = description; return this; } }),
  });
  sandbox.interaction = {
    user: { id: discordActor.id, tag: 'admin' },
    deferUpdate: async () => { state.deferred = true; },
    editReply: async payload => { state.edits.push(payload); return payload; },
    followUp: async payload => { state.followUps.push(payload); return payload; },
  };
  return { sandbox, state };
}

test('request-gate: Discord wrapper preserves buttons when verification fails', async () => {
  const pending = pendingRequest();
  const { sandbox, state } = gateInteraction({ ok: false, requestId: 77, mediaKey: 'tvdb:81189', quotaWarning: null, verified: false, restashed: true, error: 'Seerr rolled it back', pending });
  await sandbox.run(`handleGateApprove(interaction, 'abcd1234', { azPreAuth: false })`);
  assert.strictEqual(state.deferred, true);
  assert.match(state.edits[0].embeds[0].title, /Seerr lost the request/);
  assert.strictEqual(Object.hasOwn(state.edits[0], 'components'), false);
});

test('request-gate: Discord wrapper removes buttons after success', async () => {
  const pending = pendingRequest();
  const { sandbox, state } = gateInteraction({ ok: true, requestId: 77, mediaKey: 'tvdb:81189', quotaWarning: null, verified: true, restashed: false, error: null, pending, collision: false });
  await sandbox.run(`handleGateApprove(interaction, 'abcd1234', { azPreAuth: false })`);
  assert.match(state.edits[0].embeds[0].title, /Approved/);
  assert.strictEqual(state.edits[0].components.length, 0);
});
