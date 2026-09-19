'use strict';

// Admin user-management actions for the dashboard People tab. Like the member surface,
// these run the REAL slash-command handlers through the fake-interaction adapter —
// /link, /unlink, /invite, /reinvite, /assign-server, /reshare-all — so the dashboard
// never reimplements (or drifts from) the Discord logic. The adapter runs with
// admin: true, which is what lets the handlers' requireAdmin() checks pass.

const express = require('express');
const { createMemberInteraction, memberReplyToHtml } = require('../member-surface');

const DISCORD_ID_RE = /^\d{5,25}$/;
// Good enough for a first gate; the real handlers do their own stricter email checks.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function registerUserAdminRoutes(app, deps) {
  const { audit, dashboardAuth, rateLimit, escapeHtml, getGuildMembers, fetchDiscordUser, handlers } = deps;
  const json = express.json({ limit: '64kb' });
  const limiter = rateLimit({ windowMs: 60 * 1000, limit: 60 });

  // Resolve a Discord user for the handlers' getUser('user') option. Prefer the real
  // Discord user object (so invite DMs actually send); fall back to a minimal stub
  // whose send() rejects, which the invite handler already turns into a
  // "DMs are closed — provide the email" message.
  async function resolveTargetUser(discordId) {
    try {
      const real = await fetchDiscordUser(discordId);
      if (real) return real;
    } catch (_e) { /* fall through to the stub */ }
    try {
      const members = await getGuildMembers();
      const m = (members || []).find(x => x?.user?.id === discordId);
      if (m) {
        const username = m.user.username || m.displayName || 'user';
        return { id: discordId, username, tag: username, bot: false, send: async () => { throw new Error('DMs closed'); } };
      }
    } catch (_e) { /* fall through to the stub */ }
    return { id: discordId, username: 'user', tag: 'user', bot: false, send: async () => { throw new Error('DMs closed'); } };
  }

  async function runAsAdmin(handler, { options = {}, optionUsers = {} }) {
    const { interaction, replies } = createMemberInteraction({
      discordId: 'dashboard', admin: true, options, optionUsers,
    });
    await handler(interaction);
    const terminal = replies[replies.length - 1];
    return memberReplyToHtml(terminal ? terminal.payload : { content: 'No response.' }, escapeHtml);
  }

  const bad = (res, message) => { res.status(400).json({ ok: false, error: message }); return undefined; };
  const validDiscordId = id => DISCORD_ID_RE.test(String(id || '').trim());
  const validEmail = email => EMAIL_RE.test(String(email || '').trim());

  function userAction(path, run) {
    app.post(path, dashboardAuth, limiter, json, async (req, res) => {
      try {
        const html = await run(req.body || {}, res);
        if (html === undefined) return; // run already answered (validation error)
        res.json({ ok: true, html });
      } catch (err) {
        audit('dashboard_user_action_failed', { path, error: err.message });
        res.status(500).json({ ok: false, error: 'Action failed — check the bot logs.' });
      }
    });
  }

  userAction('/admin/action/user/link', async (body, res) => {
    const discordId = String(body.discordId || '').trim();
    const email = String(body.email || '').trim();
    if (!validDiscordId(discordId)) return bad(res, 'That doesn\u2019t look like a Discord user ID.');
    if (!validEmail(email)) return bad(res, 'That doesn\u2019t look like an email address.');
    const target = await resolveTargetUser(discordId);
    return runAsAdmin(handlers.link, { options: { email }, optionUsers: { user: target } });
  });

  userAction('/admin/action/user/unlink', async (body, res) => {
    const discordId = String(body.discordId || '').trim();
    if (!validDiscordId(discordId)) return bad(res, 'That doesn\u2019t look like a Discord user ID.');
    const target = await resolveTargetUser(discordId);
    return runAsAdmin(handlers.unlink, { optionUsers: { user: target } });
  });

  userAction('/admin/action/user/invite', async (body, res) => {
    const discordId = String(body.discordId || '').trim();
    const email = body.email ? String(body.email).trim() : null;
    if (!validDiscordId(discordId)) return bad(res, 'That doesn\u2019t look like a Discord user ID.');
    if (email && !validEmail(email)) return bad(res, 'That doesn\u2019t look like an email address.');
    const server = body.server === 'ph' ? 'ph' : 'primary';
    const target = await resolveTargetUser(discordId);
    const options = { server };
    if (email) options.email = email;
    return runAsAdmin(handlers.invite, { options, optionUsers: { user: target } });
  });

  userAction('/admin/action/user/reinvite', async (body, res) => {
    const discordId = body.discordId ? String(body.discordId).trim() : null;
    const email = body.email ? String(body.email).trim() : null;
    if (!discordId && !email) return bad(res, 'Provide a Discord user or an email.');
    if (discordId && !validDiscordId(discordId)) return bad(res, 'That doesn\u2019t look like a Discord user ID.');
    const optionUsers = {};
    if (discordId) optionUsers.user = await resolveTargetUser(discordId);
    const options = {};
    if (email) options.email = email;
    return runAsAdmin(handlers.reinvite, { options, optionUsers });
  });

  userAction('/admin/action/user/assign-server', async (body, res) => {
    const discordId = String(body.discordId || '').trim();
    const server = String(body.server || '').trim();
    if (!validDiscordId(discordId)) return bad(res, 'That doesn\u2019t look like a Discord user ID.');
    if (!['primary', 'ph'].includes(server)) return bad(res, 'Server must be Main or Philippines.');
    const target = await resolveTargetUser(discordId);
    return runAsAdmin(handlers.assignServer, { options: { server }, optionUsers: { user: target } });
  });

  userAction('/admin/action/reshare-all', async (body, res) => {
    const mode = String(body.mode || '').trim();
    if (!['preview', 'apply'].includes(mode)) return bad(res, 'Mode must be preview or apply.');
    return runAsAdmin(handlers.reshareAll, { options: { mode } });
  });
}

module.exports = { registerUserAdminRoutes };
