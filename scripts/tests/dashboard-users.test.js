#!/usr/bin/env node
'use strict';

// Tests for the admin user-management routes: validation, auth gating, and
// dispatch through the real-handler adapter (admin mode, getUser targets).

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { createApp, listen, close } = require('../../src/app');
const { escapeHtml } = require('../../src/dashboard-render');
const { registerUserAdminRoutes } = require('../../src/routes/dashboard-users');

function fixture() {
  const app = createApp();
  const seen = {};
  const stub = name => async interaction => {
    seen[name] = {
      admin: interaction.memberPermissions.has('Administrator'),
      userId: interaction.user.id,
      options: {
        email: interaction.options.getString('email'),
        server: interaction.options.getString('server'),
        mode: interaction.options.getString('mode'),
      },
      targetUser: interaction.options.getUser('user'),
    };
    await interaction.reply({ content: `ok:${name}` });
  };
  registerUserAdminRoutes(app, {
    audit: () => {},
    dashboardAuth: (req, res, next) => (req.headers['x-admin-token'] === 'secret' ? next() : res.status(401).json({ ok: false, error: 'no' })),
    rateLimit: require('express-rate-limit').rateLimit,
    escapeHtml,
    getGuildMembers: async () => [],
    fetchDiscordUser: async id => ({ id, username: 'caleb', tag: 'caleb', bot: false, send: async () => {} }),
    handlers: {
      link: stub('link'),
      unlink: stub('unlink'),
      invite: stub('invite'),
      reinvite: stub('reinvite'),
      assignServer: stub('assignServer'),
      reshareAll: stub('reshareAll'),
    },
  });
  return { app, seen };
}

function post(port, path, body, headers = {}) {
  const data = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers },
    }, res => {
      let text = '';
      res.on('data', c => { text += c; });
      res.on('end', () => resolve({ statusCode: res.statusCode, json: JSON.parse(text) }));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

const AUTH = { 'x-admin-token': 'secret' };

test('user admin routes require dashboard auth', async () => {
  const { app } = fixture();
  const server = await listen(app, 0);
  try {
    const res = await post(server.address().port, '/admin/action/user/link', { discordId: '123456789012345678', email: 'a@b.c' });
    assert.strictEqual(res.statusCode, 401);
  } finally {
    await close(server);
  }
});

test('link validates input and dispatches with the resolved Discord user', async () => {
  const { app, seen } = fixture();
  const server = await listen(app, 0);
  try {
    const port = server.address().port;
    const badId = await post(port, '/admin/action/user/link', { discordId: 'nope', email: 'a@b.c' }, AUTH);
    assert.strictEqual(badId.statusCode, 400);
    const badEmail = await post(port, '/admin/action/user/link', { discordId: '123456789012345678', email: 'not-an-email' }, AUTH);
    assert.strictEqual(badEmail.statusCode, 400);
    const missing = await post(port, '/admin/action/user/link', { discordId: '123456789012345678' }, AUTH);
    assert.strictEqual(missing.statusCode, 400);

    const ok = await post(port, '/admin/action/user/link', { discordId: '123456789012345678', email: 'caleb@example.com' }, AUTH);
    assert.strictEqual(ok.statusCode, 200);
    assert.strictEqual(ok.json.ok, true);
    assert.match(ok.json.html, /ok:link/);
    assert.strictEqual(seen.link.admin, true, 'handlers run with admin permissions');
    assert.strictEqual(seen.link.userId, 'dashboard');
    assert.strictEqual(seen.link.options.email, 'caleb@example.com');
    assert.strictEqual(seen.link.targetUser.id, '123456789012345678');
  } finally {
    await close(server);
  }
});

test('unlink, invite, reinvite, assign-server, reshare-all dispatch correctly', async () => {
  const { app, seen } = fixture();
  const server = await listen(app, 0);
  try {
    const port = server.address().port;

    const unlink = await post(port, '/admin/action/user/unlink', { discordId: '123456789012345678' }, AUTH);
    assert.strictEqual(unlink.statusCode, 200);
    assert.strictEqual(seen.unlink.admin, true);
    assert.strictEqual(seen.unlink.targetUser.id, '123456789012345678');

    const invite = await post(port, '/admin/action/user/invite', { discordId: '123456789012345678', email: 'caleb@example.com', server: 'ph' }, AUTH);
    assert.strictEqual(invite.statusCode, 200);
    assert.strictEqual(seen.invite.options.email, 'caleb@example.com');
    assert.strictEqual(seen.invite.options.server, 'ph');

    const inviteDefaultServer = await post(port, '/admin/action/user/invite', { discordId: '123456789012345678' }, AUTH);
    assert.strictEqual(inviteDefaultServer.statusCode, 200);
    assert.strictEqual(seen.invite.options.server, 'primary');
    assert.strictEqual(seen.invite.options.email, null);

    const reinvite = await post(port, '/admin/action/user/reinvite', { email: 'caleb@example.com' }, AUTH);
    assert.strictEqual(reinvite.statusCode, 200);
    assert.strictEqual(seen.reinvite.options.email, 'caleb@example.com');
    assert.strictEqual(seen.reinvite.targetUser, null);

    const badServer = await post(port, '/admin/action/user/assign-server', { discordId: '123456789012345678', server: 'moon' }, AUTH);
    assert.strictEqual(badServer.statusCode, 400);
    const assign = await post(port, '/admin/action/user/assign-server', { discordId: '123456789012345678', server: 'ph' }, AUTH);
    assert.strictEqual(assign.statusCode, 200);
    assert.strictEqual(seen.assignServer.options.server, 'ph');

    const badMode = await post(port, '/admin/action/reshare-all', { mode: 'yeet' }, AUTH);
    assert.strictEqual(badMode.statusCode, 400);
    const preview = await post(port, '/admin/action/reshare-all', { mode: 'preview' }, AUTH);
    assert.strictEqual(preview.statusCode, 200);
    assert.strictEqual(seen.reshareAll.options.mode, 'preview');
  } finally {
    await close(server);
  }
});
