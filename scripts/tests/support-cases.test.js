#!/usr/bin/env node
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DB_MODULE = require.resolve('../../src/db');
const { createSupportCaseFeature, submitSupportCase, owns, isAdmin } = require('../../src/support-cases');

function freshDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'support-cases-test-'));
  process.env.DB_PATH = path.join(dir, 'test.db');
  delete require.cache[DB_MODULE];
  const dbModule = require('../../src/db');
  dbModule.runMigrations();
  return { ...dbModule, dir };
}

function cleanup({ db, dir }) {
  db.close();
  delete process.env.DB_PATH;
  fs.rmSync(dir, { recursive: true, force: true });
}

function reopenDb({ dir }) {
  process.env.DB_PATH = path.join(dir, 'test.db');
  delete require.cache[DB_MODULE];
  const dbModule = require('../../src/db');
  dbModule.runMigrations();
  return { ...dbModule, dir };
}

// ---- src/db.js lifecycle ----

test('createSupportCase persists a case with a unique reference id and audits creation', () => {
  const handle = freshDb();
  try {
    const { case: row, duplicate } = handle.createSupportCase({
      requesterDiscordId: 'member-1',
      category: 'report',
      mediaTitle: 'Stranger Things',
      details: 'Buffers on episode 3',
    });
    assert.equal(duplicate, false);
    assert.match(row.reference_id, /^CASE-[A-Z0-9]+$/);
    assert.equal(row.status, 'open');
    assert.equal(row.requester_discord_id, 'member-1');

    const auditRows = handle.db.prepare("SELECT * FROM audit_log WHERE action = 'support_case_created'").all();
    assert.equal(auditRows.length, 1);
  } finally {
    cleanup(handle);
  }
});

test('duplicate submissions within the dedupe window are suppressed and return the existing case', () => {
  const handle = freshDb();
  try {
    const first = handle.createSupportCase({ requesterDiscordId: 'member-1', category: 'support', details: 'Help me' });
    const second = handle.createSupportCase({ requesterDiscordId: 'member-1', category: 'support', details: 'Help me' });
    assert.equal(second.duplicate, true);
    assert.equal(second.case.id, first.case.id);

    const all = handle.db.prepare('SELECT COUNT(*) AS c FROM support_cases').get().c;
    assert.equal(all, 1);
    const suppressed = handle.db.prepare("SELECT * FROM audit_log WHERE action = 'support_case_duplicate_suppressed'").all();
    assert.equal(suppressed.length, 1);
  } finally {
    cleanup(handle);
  }
});

test('a different requester with identical text is not treated as a duplicate', () => {
  const handle = freshDb();
  try {
    handle.createSupportCase({ requesterDiscordId: 'member-1', category: 'support', details: 'Help me' });
    const other = handle.createSupportCase({ requesterDiscordId: 'member-2', category: 'support', details: 'Help me' });
    assert.equal(other.duplicate, false);
    assert.equal(handle.db.prepare('SELECT COUNT(*) AS c FROM support_cases').get().c, 2);
  } finally {
    cleanup(handle);
  }
});

test('notify delivery failure is bounded and eventually marked permanently failed', () => {
  const handle = freshDb();
  try {
    const { case: row } = handle.createSupportCase({ requesterDiscordId: 'member-1', category: 'report', details: 'x' });
    handle.recordSupportCaseNotifyResult(row.id, { ok: false });
    handle.recordSupportCaseNotifyResult(row.id, { ok: false });
    let current = handle.getSupportCaseById(row.id);
    assert.equal(current.notify_status, 'failed');
    assert.equal(current.notify_attempts, 2);

    handle.recordSupportCaseNotifyResult(row.id, { ok: false });
    current = handle.getSupportCaseById(row.id);
    assert.equal(current.notify_status, 'failed_permanent');
    assert.equal(current.notify_attempts, 3);

    // Permanently-failed cases are not offered for further automatic retry.
    assert.equal(handle.listSupportCasesNeedingNotifyRetry(10).some(r => r.id === row.id), false);
  } finally {
    cleanup(handle);
  }
});

test('a later successful delivery records the channel/message link', () => {
  const handle = freshDb();
  try {
    const { case: row } = handle.createSupportCase({ requesterDiscordId: 'member-1', category: 'report', details: 'x' });
    handle.recordSupportCaseNotifyResult(row.id, { ok: false });
    assert.equal(handle.listSupportCasesNeedingNotifyRetry(10).length, 1);

    handle.recordSupportCaseNotifyResult(row.id, { channelId: 'chan-1', messageId: 'msg-1', ok: true });
    const current = handle.getSupportCaseById(row.id);
    assert.equal(current.notify_status, 'sent');
    assert.equal(current.discord_channel_id, 'chan-1');
    assert.equal(current.discord_message_id, 'msg-1');
    assert.equal(handle.listSupportCasesNeedingNotifyRetry(10).length, 0);
  } finally {
    cleanup(handle);
  }
});

test('assign / acknowledge / resolve / reopen drive the case status machine with an audit trail', () => {
  const handle = freshDb();
  try {
    const { case: row } = handle.createSupportCase({ requesterDiscordId: 'member-1', category: 'support', details: 'help' });

    const assigned = handle.assignSupportCase(row.id, 'admin-1', 'admin-1');
    assert.equal(assigned.owner_discord_id, 'admin-1');
    assert.equal(assigned.status, 'open');

    const acked = handle.acknowledgeSupportCase(row.id, 'admin-1');
    assert.equal(acked.status, 'acknowledged');
    assert.ok(acked.acknowledged_at);

    const resolved = handle.resolveSupportCase(row.id, 'admin-1', 'Fixed the transcoder.');
    assert.equal(resolved.status, 'resolved');
    assert.equal(resolved.resolution_note, 'Fixed the transcoder.');
    assert.ok(resolved.resolved_at);
    assert.equal(resolved.member_notify_status, 'pending');

    const reopened = handle.reopenSupportCase(row.id, 'admin-2', 'Member says it is still broken');
    assert.equal(reopened.status, 'open');
    assert.equal(reopened.resolved_at, null);

    const actions = handle.db.prepare('SELECT action FROM audit_log ORDER BY id').all().map(r => r.action);
    assert.deepEqual(actions, [
      'support_case_created',
      'support_case_assigned',
      'support_case_acknowledged',
      'support_case_resolved',
      'support_case_reopened',
    ]);
  } finally {
    cleanup(handle);
  }
});

test('resolving never touches media/request tables — only the support_cases row changes', () => {
  const handle = freshDb();
  try {
    handle.db.prepare(`INSERT INTO requests (overseerr_request_id, media_id, media_type, title, requested_by_discord_id, status)
      VALUES ('req-1', 'tmdb:1', 'movie', 'Some Movie', 'member-1', 'approved')`).run();
    const { case: row } = handle.createSupportCase({ requesterDiscordId: 'member-1', category: 'remove', mediaTitle: 'Some Movie', details: 'please remove' });

    handle.resolveSupportCase(row.id, 'admin-1', 'Removed manually via *arr.');

    const request = handle.db.prepare('SELECT * FROM requests WHERE overseerr_request_id = ?').get('req-1');
    assert.equal(request.status, 'approved', 'resolving a case must not mutate an unrelated request row');
  } finally {
    cleanup(handle);
  }
});

test('listSupportCasesForRequester only returns that requester\'s cases', () => {
  const handle = freshDb();
  try {
    handle.createSupportCase({ requesterDiscordId: 'member-1', category: 'support', details: 'a' });
    handle.createSupportCase({ requesterDiscordId: 'member-2', category: 'support', details: 'b' });
    const mine = handle.listSupportCasesForRequester('member-1');
    assert.equal(mine.length, 1);
    assert.equal(mine[0].requester_discord_id, 'member-1');
  } finally {
    cleanup(handle);
  }
});

test('cases survive a simulated restart (db module re-required against the same file)', () => {
  let handle = freshDb();
  const { case: row } = handle.createSupportCase({ requesterDiscordId: 'member-1', category: 'report', details: 'restart me' });
  handle.assignSupportCase(row.id, 'admin-1', 'admin-1');
  const dir = handle.dir;
  handle.db.close();

  const reopened = reopenDb({ dir });
  try {
    const survived = reopened.getSupportCaseById(row.id);
    assert.ok(survived);
    assert.equal(survived.reference_id, row.reference_id);
    assert.equal(survived.owner_discord_id, 'admin-1');
    const auditRows = reopened.db.prepare('SELECT COUNT(*) AS c FROM audit_log').get().c;
    assert.ok(auditRows >= 2, 'audit trail also survives the restart');
  } finally {
    cleanup(reopened);
  }
});

// ---- src/support-cases.js (Discord-facing, dependency-injected) ----

function adminInteraction(overrides = {}) {
  return {
    user: { id: 'admin-1' },
    memberPermissions: { has: () => true },
    isChatInputCommand: () => false,
    isButton: () => true,
    isModalSubmit: () => false,
    reply: async () => {},
    deferReply: async () => {},
    editReply: async () => {},
    deferUpdate: async () => {},
    showModal: async () => {},
    ...overrides,
  };
}

function memberInteraction(overrides = {}) {
  return {
    user: { id: 'member-1' },
    memberPermissions: { has: () => false },
    isChatInputCommand: () => false,
    isButton: () => true,
    isModalSubmit: () => false,
    reply: async () => {},
    deferReply: async () => {},
    editReply: async () => {},
    ...overrides,
  };
}

function feature(overrides = {}) {
  const calls = { audits: [] };
  const instance = createSupportCaseFeature({
    config: { ADMIN_USER_ID: 'admin-1', ADMIN_CHANNEL_ID: 'admin-channel' },
    createCase: () => ({ case: { id: 1, reference_id: 'CASE-1', notify_status: 'pending' }, duplicate: false }),
    getCaseById: () => ({ id: 1, reference_id: 'CASE-1', status: 'open', category: 'support', requester_discord_id: 'member-1', details: 'x' }),
    listCases: () => [],
    listCasesForRequester: () => [],
    listCasesNeedingNotifyRetry: () => [],
    recordNotifyResult: () => {},
    recordMemberNotifyResult: () => {},
    assignCase: () => ({ id: 1, reference_id: 'CASE-1', status: 'open', category: 'support' }),
    acknowledgeCase: () => ({ id: 1, reference_id: 'CASE-1', status: 'acknowledged', category: 'support' }),
    resolveCase: () => ({ id: 1, reference_id: 'CASE-1', status: 'resolved', category: 'support', requester_discord_id: 'member-1', member_notify_status: 'sent' }),
    reopenCase: () => ({ id: 1, reference_id: 'CASE-1', status: 'open', category: 'support' }),
    audit: (...args) => calls.audits.push(args),
    log: { warn: () => {}, error: () => {} },
    ...overrides,
  });
  return { instance, calls };
}

test('owns() recognizes case buttons, resolve/reopen modals, and the cases/mycases commands', () => {
  assert.equal(owns({ isButton: () => true, customId: 'case:assign:1' }), true);
  assert.equal(owns({ isButton: () => true, customId: 'case:ack:42' }), true);
  assert.equal(owns({ isButton: () => true, customId: 'unrelated' }), false);
  assert.equal(owns({ isModalSubmit: () => true, customId: 'case:resolve_modal:1' }), true);
  assert.equal(owns({ isChatInputCommand: () => true, commandName: 'cases' }), true);
  assert.equal(owns({ isChatInputCommand: () => true, commandName: 'mycases' }), true);
  assert.equal(owns({ isChatInputCommand: () => true, commandName: 'other' }), false);
});

test('isAdmin allows Administrator permission or the configured admin user id', () => {
  const config = { ADMIN_USER_ID: 'admin-1' };
  assert.equal(isAdmin({ user: { id: 'admin-1' }, memberPermissions: { has: () => false } }, config), true);
  assert.equal(isAdmin({ user: { id: 'someone-else' }, memberPermissions: { has: () => true } }, config), true);
  assert.equal(isAdmin({ user: { id: 'someone-else' }, memberPermissions: { has: () => false } }, config), false);
});

test('a non-admin cannot assign/acknowledge/resolve/reopen a case', async () => {
  const { instance } = feature();
  let replyText = null;
  const interaction = memberInteraction({ customId: 'case:ack:1', reply: async payload => { replyText = payload.content; } });
  const handled = await instance.handleInteraction(interaction);
  assert.equal(handled, true);
  assert.match(replyText, /Administrator permission is required/);
});

test('an admin can acknowledge a case, which refreshes the source message', async () => {
  let edited = null;
  const { instance } = feature();
  const interaction = adminInteraction({
    customId: 'case:ack:1',
    message: { edit: async payload => { edited = payload; } },
  });
  const handled = await instance.handleInteraction(interaction);
  assert.equal(handled, true);
  assert.ok(edited, 'admin message is refreshed after an acknowledge');
});

test('resolve opens a modal; submitting it resolves the case and reports member notification result', async () => {
  const { instance } = feature();
  const ackInteraction = adminInteraction({ customId: 'case:resolve:1' });
  let shownModal = null;
  ackInteraction.showModal = async modal => { shownModal = modal; };
  await instance.handleInteraction(ackInteraction);
  assert.ok(shownModal, 'resolve button shows a modal instead of resolving immediately');

  let replyText = null;
  const modalSubmit = adminInteraction({
    isButton: () => false,
    isModalSubmit: () => true,
    customId: 'case:resolve_modal:1',
    fields: { getTextInputValue: () => 'All fixed.' },
    client: { users: { fetch: async () => ({ send: async () => {} }) } },
    editReply: async content => { replyText = content; },
  });
  const handled = await instance.handleInteraction(modalSubmit);
  assert.equal(handled, true);
  assert.match(replyText, /CASE-1/);
  assert.match(replyText, /resolved/);
});

test('member DM failure on resolution does not block resolving; it is reported instead', async () => {
  const { instance } = feature({
    resolveCase: () => ({ id: 1, reference_id: 'CASE-1', status: 'resolved', category: 'support', requester_discord_id: 'member-1', member_notify_status: 'failed' }),
  });
  let replyText = null;
  const modalSubmit = adminInteraction({
    isButton: () => false,
    isModalSubmit: () => true,
    customId: 'case:resolve_modal:1',
    fields: { getTextInputValue: () => 'Fixed.' },
    client: { users: { fetch: async () => { throw new Error('cannot DM'); } } },
    editReply: async content => { replyText = content; },
  });
  const handled = await instance.handleInteraction(modalSubmit);
  assert.equal(handled, true);
  assert.match(replyText, /CASE-1/);
  assert.match(replyText, /could not be DMed/);
});

test('/mycases lists only the caller\'s own cases via listCasesForRequester', async () => {
  const seen = [];
  const { instance } = feature({
    listCasesForRequester: (discordId, opts) => { seen.push([discordId, opts]); return [{ reference_id: 'CASE-9', status: 'open', category: 'report', requester_discord_id: 'member-1', details: 'x' }]; },
  });
  let replyText = null;
  const interaction = memberInteraction({
    isButton: () => false,
    isChatInputCommand: () => true,
    commandName: 'mycases',
    options: { getString: () => null },
    editReply: async content => { replyText = content; },
  });
  const handled = await instance.handleInteraction(interaction);
  assert.equal(handled, true);
  assert.equal(seen[0][0], 'member-1');
  assert.match(replyText, /CASE-9/);
});

test('/cases is admin-only', async () => {
  const { instance } = feature();
  let replyText = null;
  const interaction = memberInteraction({
    isButton: () => false,
    isChatInputCommand: () => true,
    commandName: 'cases',
    reply: async payload => { replyText = payload.content; },
  });
  const handled = await instance.handleInteraction(interaction);
  assert.equal(handled, true);
  assert.match(replyText, /Administrator permission is required/);
});

test('submitSupportCase saves the case even when the admin channel is unreachable, and reports the reference id', async () => {
  const created = [];
  const notifyResults = [];
  let replyText = null;
  const interaction = {
    user: { id: 'member-1' },
    channelId: 'source-chan',
    fields: { getTextInputValue: key => (key === 'title' ? 'A Show' : 'It crashes') },
    client: { channels: { fetch: async () => { throw new Error('no access'); } } },
    deferReply: async () => {},
    editReply: async content => { replyText = content; },
  };
  await submitSupportCase(interaction, 'report', {
    config: { ADMIN_CHANNEL_ID: 'admin-channel' },
    createCase: args => { created.push(args); return { case: { id: 5, reference_id: 'CASE-FAIL', notify_status: 'pending' }, duplicate: false }; },
    recordNotifyResult: (id, result) => notifyResults.push([id, result]),
    audit: () => {},
    log: { warn: () => {} },
  });
  assert.equal(created[0].category, 'report');
  assert.equal(notifyResults[0][1].ok, false);
  assert.match(replyText, /CASE-FAIL/);
  assert.match(replyText, /could not reach/);
});
