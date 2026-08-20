'use strict';

// Pure setup-state helpers for the Discord onboarding / troubleshooting wizard.
// Keep Discord builders and network calls out of this module so slash commands, buttons,
// admin tooling, and tests can all share the exact same state model.

const DEFAULT_PLEX_SIGNUP_URL = 'https://www.plex.tv/sign-up/';
const DEFAULT_PLEX_WEB_URL = 'https://app.plex.tv/';

function normalizedHomeServer(value) {
  return String(value || '').toLowerCase() === 'ph' ? 'ph' : 'primary';
}

function setupStateForUser(user, options = {}) {
  const homeServer = normalizedHomeServer(user?.home_server);
  const plexUsername = String(user?.plex_username || '').trim();
  const discordLinked = !!user?.discord_id;
  const plexIdentityVerified = !!plexUsername;
  const plexAccessVerified = !!Number(user?.invited || 0);
  const seerrLinked = !!Number(user?.overseerr_created || 0) || Number.isInteger(user?.overseerr_user_id);
  const tailscaleRequired = homeServer === 'ph';

  return {
    discordLinked,
    plexIdentityVerified,
    plexAccessVerified,
    seerrLinked,
    homeServer,
    plexUsername: plexUsername || null,
    email: String(user?.email || '').trim() || null,
    tailscaleRequired,
    // Phase 1 intentionally does not pretend we can detect a viewer's Tailscale client from
    // Discord. A later API-backed phase can supply these booleans explicitly.
    tailscaleSetupStarted: tailscaleRequired ? !!options.tailscaleSetupStarted : false,
    connectionVerified: tailscaleRequired ? !!options.connectionVerified : true,
  };
}

function statusIcon(ok, pendingIcon = '⚠️') {
  return ok ? '✅' : pendingIcon;
}

function setupSummaryLines(state) {
  const lines = [
    `Discord account      ${statusIcon(state.discordLinked)}`,
    `Plex account         ${statusIcon(state.plexIdentityVerified)}${state.plexUsername ? ` ${state.plexUsername}` : ''}`,
    `Server access        ${statusIcon(state.plexAccessVerified)} ${state.homeServer === 'ph' ? '🇵🇭 Philippines' : 'Main'}`,
    `Seerr account        ${statusIcon(state.seerrLinked)}`,
  ];

  if (state.tailscaleRequired) {
    const connectionOk = state.connectionVerified;
    lines.push(`PH connection        ${statusIcon(connectionOk)}${connectionOk ? ' verified' : ' not verified'}`);
  }

  return lines;
}

function plexUsernameHelp() {
  return {
    title: 'Find your Plex username',
    phone: [
      'Open the Plex app.',
      'Tap your profile/avatar.',
      'Open Profile or My Profile.',
      'Find the username shown for your Plex account.',
      'Return to Discord and choose Enter Plex Username.',
    ],
    computer: [
      'Open Plex Web.',
      'Click your profile picture in the upper-right.',
      'Open Profile.',
      'Find the username shown for your Plex account.',
      'Return to Discord and choose Enter Plex Username.',
    ],
    tv: [
      'Open Plex on the TV.',
      'Open the profile/avatar menu.',
      'Open Profile.',
      'Find the username for the signed-in Plex account.',
      'If the TV does not show it clearly, use Plex Web on a phone or computer.',
    ],
  };
}

function quickActions(state) {
  // These IDs are intentionally UI-framework-agnostic strings. Discord handlers can map them
  // to existing slash-command service functions without duplicating request business logic.
  const actions = [
    { id: 'request_media', label: '🎬 Request Media', command: 'request' },
    { id: 'my_requests', label: '📋 My Requests', command: 'myrequests' },
    { id: 'request_status', label: '🔎 Request Status', command: 'request-status' },
    { id: 'downloads', label: '⬇️ Downloads', command: 'downloads' },
    { id: 'setup', label: '🛠️ Setup / Troubleshooting', command: 'setup' },
    { id: 'help', label: '❓ Help', command: 'help' },
  ];

  if (state?.tailscaleRequired) {
    actions.splice(actions.length - 2, 0,
      { id: 'ph_connection', label: '🔐 PH Server Connection', command: null },
      { id: 'test_ph_connection', label: '✅ Test PH Connection', command: null },
    );
  }

  return actions;
}

function setupActions(state, config = {}) {
  const plexSignupUrl = config.PLEX_SIGNUP_URL || DEFAULT_PLEX_SIGNUP_URL;
  const plexWebUrl = config.PLEX_WEB_URL || DEFAULT_PLEX_WEB_URL;
  const actions = [];

  if (!state.plexIdentityVerified) {
    actions.push(
      { id: 'plex_create', label: 'Create Plex Account', style: 'link', url: plexSignupUrl },
      { id: 'plex_find_username', label: 'Find My Plex Username', style: 'secondary' },
      { id: 'plex_enter_username', label: 'Enter Plex Username', style: 'primary' },
      { id: 'plex_profile_web', label: 'Open Plex on Web', style: 'link', url: plexWebUrl },
    );
  } else if (!state.plexAccessVerified) {
    actions.push(
      { id: 'plex_reinvite_username', label: `Invite ${state.plexUsername}`, style: 'primary' },
      { id: 'plex_change_username', label: 'Change Plex Username', style: 'secondary' },
    );
  }

  if (state.tailscaleRequired) {
    actions.push(
      { id: 'ph_device_phone', label: '📱 Phone / Tablet', style: 'secondary' },
      { id: 'ph_device_appletv', label: '📺 Apple TV', style: 'secondary' },
      { id: 'ph_device_androidtv', label: '📺 Android / Google TV', style: 'secondary' },
      { id: 'ph_device_computer', label: '💻 Computer', style: 'secondary' },
      { id: 'test_ph_connection', label: '✅ Test PH Connection', style: 'secondary' },
    );

    if (config.PH_PLEX_URL) {
      actions.push({ id: 'open_ph_plex', label: '🎬 Open PH Plex', style: 'link', url: config.PH_PLEX_URL });
    }
  } else {
    actions.push({ id: 'open_plex', label: '🎬 Open Plex', style: 'link', url: plexWebUrl });
  }

  return actions;
}

function setupIntro(state) {
  if (!state.discordLinked) {
    return 'I found no linked Discord profile yet. We can still guide you through Plex setup and then link the account.';
  }

  if (!state.plexIdentityVerified) {
    return 'I found part of your existing account. The next step is confirming your Plex username so you do not have to rely on a missing Plex invite email.';
  }

  if (!state.plexAccessVerified) {
    return `Your Plex username is saved as **${state.plexUsername}**, but server access still needs to be verified.`;
  }

  if (state.tailscaleRequired && !state.connectionVerified) {
    return 'Your Plex access is ready. Because you use the Philippines server, finish the PH Server Connection on each device you watch from outside the PH home network.';
  }

  return 'Your Durant Media Server setup looks ready. You can reopen this setup screen any time, especially when adding a new device.';
}

module.exports = {
  DEFAULT_PLEX_SIGNUP_URL,
  DEFAULT_PLEX_WEB_URL,
  normalizedHomeServer,
  setupStateForUser,
  setupSummaryLines,
  plexUsernameHelp,
  quickActions,
  setupActions,
  setupIntro,
};
