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
  // The legacy `invited` column records that a share/invite was successfully sent. Older flows
  // set it before the member accepted the share, so setup must keep a username re-share/verify
  // action available even when this is true.
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
    `Plex share record    ${statusIcon(state.plexAccessVerified)} ${state.homeServer === 'ph' ? '🇵🇭 Philippines' : 'Main'}`,
    `Seerr account        ${statusIcon(state.seerrLinked)}`,
  ];

  if (state.tailscaleRequired) {
    const connectionOk = state.connectionVerified;
    lines.push(`PH device setup      ${statusIcon(connectionOk)}${connectionOk ? ' confirmed' : ' not confirmed'}`);
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
  const setupAndHelp = [
    { id: 'setup', label: '🛠️ Setup / Troubleshooting', command: 'setup' },
    { id: 'help', label: '❓ Help', command: 'help' },
  ];
  if (!state?.discordLinked) return setupAndHelp;

  // These IDs are intentionally UI-framework-agnostic strings. Discord handlers can map them
  // to existing slash-command service functions without duplicating request business logic.
  const actions = [
    { id: 'request_media', label: '🎬 Request Media', command: 'request' },
    { id: 'my_requests', label: '📋 My Requests', command: 'myrequests' },
    { id: 'request_status', label: '🔎 Request Status', command: 'request-status' },
    { id: 'downloads', label: '⬇️ Downloads', command: 'downloads' },
    ...setupAndHelp,
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
    );
    if (state.discordLinked) actions.push({ id: 'plex_enter_username', label: 'Enter Plex Username', style: 'primary' });
    actions.push({ id: 'plex_profile_web', label: 'Open Plex on Web', style: 'link', url: plexWebUrl });
  } else {
    actions.push(
      {
        id: 'plex_reinvite_username',
        label: state.plexAccessVerified ? 'Verify / Re-send to Username' : `Invite ${state.plexUsername}`,
        style: 'primary',
      },
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
    return 'Start by creating/signing in to Plex and finding your Plex username. Then finish the server\'s Request Plex Access step so I can create your Discord access record; return here afterward to save the username and verify the Plex share.';
  }

  if (!state.plexIdentityVerified) {
    return 'I found your existing access record. The next step is confirming your Plex username so a missing Plex invitation email cannot block you.';
  }

  if (!state.plexAccessVerified) {
    return `Your Plex username is saved as **${state.plexUsername}**. Send the server share directly to that username next.`;
  }

  if (state.tailscaleRequired && !state.connectionVerified) {
    return `Plex has a share record for **${state.plexUsername}**. If an old email invite never worked, use **Verify / Re-send to Username**. Then finish PH Server Connection on each device you watch from outside the PH home network.`;
  }

  return `Your setup record looks complete. **Verify / Re-send to Username** remains available if an older Plex email invitation never actually gave you access. You can reopen this screen any time, especially when adding a new device.`;
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
