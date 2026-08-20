#!/usr/bin/env node
const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  setupStateForUser,
  setupSummaryLines,
  plexUsernameHelp,
  quickActions,
  setupActions,
  setupIntro,
} = require('../../src/setup');

test('setup: Main users never receive PH/Tailscale actions', () => {
  const state = setupStateForUser({
    discord_id: '123',
    email: 'main@example.com',
    plex_username: 'mainviewer',
    invited: 1,
    overseerr_created: 1,
    home_server: 'primary',
  });

  assert.equal(state.homeServer, 'primary');
  assert.equal(state.tailscaleRequired, false);
  assert.equal(state.connectionVerified, true);
  assert.ok(!setupSummaryLines(state).some(line => /PH (?:connection|device setup)/.test(line)));

  const actionIds = setupActions(state).map(a => a.id);
  assert.ok(actionIds.includes('open_plex'));
  assert.ok(!actionIds.some(id => id.startsWith('ph_') || id === 'test_ph_connection' || id === 'open_ph_plex'));

  const quickIds = quickActions(state).map(a => a.id);
  assert.ok(quickIds.includes('request_media'));
  assert.ok(quickIds.includes('setup'));
  assert.ok(!quickIds.includes('ph_connection'));
  assert.ok(!quickIds.includes('test_ph_connection'));
});

test('setup: PH users receive device picker and connection actions', () => {
  const state = setupStateForUser({
    discord_id: '456',
    email: 'ph@example.com',
    plex_username: 'phviewer',
    invited: 1,
    overseerr_user_id: 99,
    home_server: 'ph',
  });

  assert.equal(state.tailscaleRequired, true);
  assert.equal(state.connectionVerified, false);
  assert.match(setupIntro(state), /PH Server Connection|Philippines server/);
  assert.ok(setupSummaryLines(state).some(line => /PH device setup/.test(line)));

  const actions = setupActions(state, { PH_PLEX_URL: 'http://ph-server.end-cobra.ts.net:32400' });
  const ids = actions.map(a => a.id);
  assert.ok(ids.includes('ph_device_phone'));
  assert.ok(ids.includes('ph_device_appletv'));
  assert.ok(ids.includes('ph_device_androidtv'));
  assert.ok(ids.includes('ph_device_computer'));
  assert.ok(ids.includes('test_ph_connection'));
  assert.equal(actions.find(a => a.id === 'open_ph_plex').url, 'http://ph-server.end-cobra.ts.net:32400');

  const quickIds = quickActions(state).map(a => a.id);
  assert.ok(quickIds.includes('ph_connection'));
  assert.ok(quickIds.includes('test_ph_connection'));
});

test('setup: partial existing records are reconciled instead of treated as new', () => {
  const state = setupStateForUser({
    discord_id: '789',
    email: 'existing@example.com',
    invited: 1,
    overseerr_created: 1,
    home_server: 'ph',
    plex_username: null,
  });

  assert.equal(state.discordLinked, true);
  assert.equal(state.plexIdentityVerified, false);
  assert.equal(state.plexAccessVerified, true);
  assert.equal(state.seerrLinked, true);
  assert.match(setupIntro(state), /existing access record/);

  const ids = setupActions(state).map(a => a.id);
  assert.ok(ids.includes('plex_create'));
  assert.ok(ids.includes('plex_find_username'));
  assert.ok(ids.includes('plex_enter_username'));
  assert.ok(ids.includes('ph_device_phone'));
});

test('setup: saved username but no access offers username-based reinvite', () => {
  const state = setupStateForUser({
    discord_id: '101',
    email: 'viewer@example.com',
    plex_username: 'knownusername',
    invited: 0,
    home_server: 'primary',
  });

  const actions = setupActions(state);
  assert.ok(actions.some(a => a.id === 'plex_reinvite_username' && /knownusername/.test(a.label)));
  assert.ok(actions.some(a => a.id === 'plex_change_username'));
  assert.match(setupIntro(state), /send the server share directly to that username/i);
});

test('setup: a legacy invited flag never hides username re-share recovery', () => {
  const state = setupStateForUser({
    discord_id: '303',
    email: 'emailed@example.com',
    plex_username: 'emaildidnotarrive',
    invited: 1,
    overseerr_created: 1,
    home_server: 'primary',
  });

  const action = setupActions(state).find(a => a.id === 'plex_reinvite_username');
  assert.ok(action, 'username recovery remains available after an email-first invite was recorded');
  assert.match(action.label, /Verify \/ Re-send to Username/);
  assert.match(setupIntro(state), /email invitation|email invite/i);
});

test('setup: an unlinked user only gets setup/help quick actions and no dead-end username save', () => {
  const state = setupStateForUser(null);
  const quickIds = quickActions(state).map(a => a.id);
  assert.deepEqual(quickIds, ['setup', 'help']);

  const setupIds = setupActions(state).map(a => a.id);
  assert.ok(setupIds.includes('plex_create'));
  assert.ok(setupIds.includes('plex_find_username'));
  assert.ok(!setupIds.includes('plex_enter_username'));
  assert.match(setupIntro(state), /Request Plex Access/);
});

test('setup: Plex username help explicitly covers phone, computer, and TV', () => {
  const help = plexUsernameHelp();
  assert.ok(help.phone.join(' ').includes('profile'));
  assert.ok(help.phone.join(' ').includes('Return to Discord'));
  assert.ok(help.computer.join(' ').includes('upper-right'));
  assert.ok(help.tv.join(' ').includes('TV'));
});

test('setup: mobile quick actions expose common member commands', () => {
  const state = setupStateForUser({ discord_id: '202', home_server: 'primary' });
  const mapped = new Map(quickActions(state).map(a => [a.id, a.command]));

  assert.equal(mapped.get('request_media'), 'request');
  assert.equal(mapped.get('my_requests'), 'myrequests');
  assert.equal(mapped.get('request_status'), 'request-status');
  assert.equal(mapped.get('downloads'), 'downloads');
  assert.equal(mapped.get('setup'), 'setup');
  assert.equal(mapped.get('help'), 'help');
});
