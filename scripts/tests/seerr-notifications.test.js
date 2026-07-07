#!/usr/bin/env node
// setOverseerrDiscordNotification: Seerr 3.3 discordIds vs pre-3.3 discordId, settings round-trip.
// resolveRequester: webhook payload attribution across template variants.
const assert = require('assert');
const axios = require('axios');
const express = require('express');
const { loadSandbox } = require('./extract');

const BOT_CLIENT_ID = '111111111111111111';
const sandbox = loadSandbox(
  ['isSnowflake', 'setOverseerrDiscordNotification', 'webhookDiscordId', 'resolveRequester'],
  {
    axios,
    CONFIG: { OVERSEERR_URL: '', OVERSEERR_API_KEY: 'test-key', DISCORD_CLIENT_ID: BOT_CLIENT_ID },
    audit: () => {},
    dbUserByEmail: null,
    getUserByCanonicalEmail: () => sandbox.dbUserByEmail,
  },
);

function mockSeerr({ modern }) {
  const app = express();
  app.use(express.json());
  // POST is a FULL settings update on the real server: omitted fields are cleared.
  const state = { posts: [], stored: modern ? ['999888777666555444'] : null, failGet: false, otherSettings: { pgpKey: 'PGPKEY', telegramChatId: '42', pushoverUserKey: 'pk' } };
  app.get('/api/v1/user/:id/settings/notifications', (req, res) => {
    if (state.failGet) return res.status(500).json({ error: 'boom' });
    if (modern) return res.json({ ...state.otherSettings, discordIds: state.stored });
    return res.json({ ...state.otherSettings, discordId: '999888777666555444' });
  });
  app.post('/api/v1/user/:id/settings/notifications', (req, res) => {
    state.posts.push(req.body);
    state.otherSettings = { pgpKey: req.body.pgpKey, telegramChatId: req.body.telegramChatId, pushoverUserKey: req.body.pushoverUserKey };
    if (modern) {
      state.stored = req.body.discordIds?.filter(id => id !== '') ?? []; // exact Seerr 3.3 behavior
      return res.json({ discordIds: state.stored });
    }
    return res.json({ discordId: req.body.discordId });
  });
  return new Promise(resolve => {
    const server = app.listen(0, () => resolve({ server, state, port: server.address().port }));
  });
}

(async () => {
  const USER_ID = '123456789012345678';

  // Seerr 3.3: merge + store via plural key, legacy key still present, other settings survive.
  let { server, state, port } = await mockSeerr({ modern: true });
  sandbox.CONFIG.OVERSEERR_URL = `http://127.0.0.1:${port}`;
  assert.strictEqual(await sandbox.run(`setOverseerrDiscordNotification(7, '${USER_ID}')`), true);
  assert.deepStrictEqual(state.stored, ['999888777666555444', USER_ID], '3.3: existing ID preserved + new stored');
  assert.strictEqual(state.posts[0].discordId, USER_ID, '3.3: legacy key still sent');
  assert.deepStrictEqual(state.otherSettings, { pgpKey: 'PGPKEY', telegramChatId: '42', pushoverUserKey: 'pk' }, '3.3: other settings round-tripped');
  await sandbox.run(`setOverseerrDiscordNotification(7, '${USER_ID}')`);
  assert.deepStrictEqual(state.stored, ['999888777666555444', USER_ID], '3.3: idempotent re-link');
  server.close();

  // Failing GET: abort, never POST a partial body.
  ({ server, state, port } = await mockSeerr({ modern: true }));
  state.failGet = true;
  sandbox.CONFIG.OVERSEERR_URL = `http://127.0.0.1:${port}`;
  assert.strictEqual(await sandbox.run(`setOverseerrDiscordNotification(7, '${USER_ID}')`), false, 'failing GET reports failure');
  assert.strictEqual(state.posts.length, 0, 'failing GET: no POST fired');
  server.close();

  // Pre-3.3: singular key honored, settings survive.
  ({ server, state, port } = await mockSeerr({ modern: false }));
  sandbox.CONFIG.OVERSEERR_URL = `http://127.0.0.1:${port}`;
  assert.strictEqual(await sandbox.run(`setOverseerrDiscordNotification(7, '${USER_ID}')`), true);
  assert.strictEqual(state.posts[0].discordId, USER_ID, 'pre-3.3: singular key sent');
  assert.deepStrictEqual(state.otherSettings, { pgpKey: 'PGPKEY', telegramChatId: '42', pushoverUserKey: 'pk' }, 'pre-3.3: other settings round-tripped');
  server.close();

  // resolveRequester across payload shapes.
  const rr = req => sandbox.run.call(null, 'resolveRequester(REQ)', Object.assign(sandbox, { REQ: req })) ?? null;
  sandbox.dbUserByEmail = null;

  sandbox.REQ = { requestedBy_email: 'a@b.c', requestedBy_settings_discordIds: '222222222222222222, 333333333333333333' };
  let r = sandbox.run('resolveRequester(REQ)');
  assert.deepStrictEqual([r.discordId, r.source], ['222222222222222222', 'webhook'], '3.3 comma list: first snowflake wins');

  sandbox.REQ = { requestedBy_settings_discordIds: ['444444444444444444', '555555555555555555'] };
  assert.strictEqual(sandbox.run('resolveRequester(REQ)').discordId, '444444444444444444', 'array form parsed');

  sandbox.REQ = { requestedBy_settings_discordIds: `${BOT_CLIENT_ID};666666666666666666` };
  assert.strictEqual(sandbox.run('resolveRequester(REQ)').discordId, '666666666666666666', "bot's own ID skipped");

  sandbox.REQ = { requestedBy_settings_discordIds: '{{requestedBy_settings_discordIds}}', requestedBy_settings_discordId: '777777777777777777' };
  assert.strictEqual(sandbox.run('resolveRequester(REQ)').discordId, '777777777777777777', 'placeholder falls back to legacy field');

  sandbox.REQ = { requestedBy_settings_discordIds: '{{requestedBy_settings_discordIds}}', requestedBy_settings_discordId: '{{requestedBy_settings_discordId}}' };
  r = sandbox.run('resolveRequester(REQ)');
  assert.deepStrictEqual([r.discordId, r.source], [null, 'none'], 'both placeholders → no requester');

  sandbox.dbUserByEmail = { discord_id: '101010101010101010' };
  sandbox.REQ = { requestedBy_email: 'a@b.c', requestedBy_settings_discordIds: '222222222222222222' };
  r = sandbox.run('resolveRequester(REQ)');
  assert.deepStrictEqual([r.discordId, r.source], ['101010101010101010', 'db-email'], 'DB email match takes priority');

  console.log('ok - seerr-notifications');
})().catch(err => { console.error('FAILED seerr-notifications:', err.message); process.exit(1); });
