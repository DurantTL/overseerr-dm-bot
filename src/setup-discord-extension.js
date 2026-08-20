'use strict';

// Discord integration for the guided setup center. This is loaded before index.js so it can
// extend the existing command registration and intercept only the setup-related interactions.
// Keeping it isolated avoids another large block of onboarding/button code in index.js while the
// main composition root is being broken into services.

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
  ModalBuilder,
  REST,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');

const { CONFIG } = require('./config');
const { db, getUserByDiscordId, getTrustScore, audit } = require('./db');
const { inviteUserToPlex } = require('./plex');
const { fetchUserQuota } = require('./seerr');
const { quotaLine } = require('./util');
const {
  setupStateForUser,
  setupSummaryLines,
  setupIntro,
  plexUsernameHelp,
  quickActions,
} = require('./setup');
const { log } = require('./log');

const INSTALL_MARK = Symbol.for('durant.guidedSetupInstalled');
const COMMAND_CACHE_MS = 5 * 60 * 1000;
const commandCache = new Map();

function brandedEmbed(color = 0xe5a00d) {
  return new EmbedBuilder()
    .setColor(color)
    .setFooter({ text: 'Durant Media Server' })
    .setTimestamp();
}

function phPlexUrl() {
  const explicit = String(process.env.PH_PLEX_URL || '').trim();
  if (explicit) return explicit.replace(/\/$/, '');
  const address = String(CONFIG.TAILSCALE_SERVER_ADDRESS || process.env.TAILSCALE_SERVER_ADDRESS || '').trim();
  if (!address) return '';
  if (/^https?:\/\//i.test(address)) return address.replace(/\/$/, '');
  return `http://${address}:32400`;
}

function plexWebUrl() {
  return String(process.env.PLEX_WEB_URL || 'https://app.plex.tv/').trim();
}

function plexSignupUrl() {
  return String(process.env.PLEX_SIGNUP_URL || 'https://www.plex.tv/sign-up/').trim();
}

function tailscaleSetupUrl() {
  return String(CONFIG.TAILSCALE_SETUP_URL || process.env.TAILSCALE_SETUP_URL || 'https://tailscale.com/download').trim();
}

function button(customId, label, style = ButtonStyle.Secondary) {
  return new ButtonBuilder().setCustomId(customId).setLabel(label).setStyle(style);
}

function linkButton(url, label) {
  return new ButtonBuilder().setURL(url).setLabel(label).setStyle(ButtonStyle.Link);
}

function rowsFromButtons(buttons) {
  const rows = [];
  for (let i = 0; i < buttons.length && rows.length < 5; i += 5) {
    rows.push(new ActionRowBuilder().addComponents(...buttons.slice(i, i + 5)));
  }
  return rows;
}

function setupButtons(state) {
  const buttons = [];

  if (!state.plexIdentityVerified) {
    buttons.push(
      linkButton(plexSignupUrl(), 'Create Plex Account'),
      button('setup:plex_find_username', 'Find My Plex Username'),
    );
    // A Discord/access-request row has to exist before a username can be saved. New members can
    // still create the Plex account and learn where the username is, but we do not show a button
    // that can only end in an error until the normal Request Plex Access step created their row.
    if (state.discordLinked) buttons.push(button('setup:plex_enter_username', 'Enter Plex Username', ButtonStyle.Primary));
    buttons.push(linkButton(plexWebUrl(), 'Open Plex Web'));
  } else {
    // Keep this recovery action available even when `invited=1`. Older email-first onboarding
    // marks that flag when Plex accepted the invite POST, not when the member actually received or
    // accepted the email. Re-sharing to the confirmed username is the reliable recovery path.
    buttons.push(
      button(
        'setup:plex_invite_username',
        state.plexAccessVerified ? 'Verify / Re-send to Username' : `Invite ${state.plexUsername}`.slice(0, 80),
        ButtonStyle.Success,
      ),
      button('setup:plex_enter_username', 'Change Plex Username'),
    );
  }

  if (state.tailscaleRequired) {
    buttons.push(
      button('setup:ph_device:phone', '📱 Phone / Tablet'),
      button('setup:ph_device:appletv', '📺 Apple TV'),
      button('setup:ph_device:androidtv', '📺 Android / Google TV'),
      button('setup:ph_device:computer', '💻 Computer'),
    );
    const phUrl = phPlexUrl();
    if (phUrl) buttons.push(linkButton(`${phUrl}/web`, '🎬 Open PH Plex'));
  } else {
    buttons.push(linkButton(plexWebUrl(), '🎬 Open Plex'));
  }

  return rowsFromButtons(buttons);
}

async function guildCommandMention(interaction, name) {
  const guild = interaction.guild;
  if (!guild) return `\`/${name}\``;
  const cached = commandCache.get(guild.id);
  let commands = cached && (Date.now() - cached.at < COMMAND_CACHE_MS) ? cached.commands : null;
  if (!commands) {
    try {
      commands = await guild.commands.fetch();
      commandCache.set(guild.id, { at: Date.now(), commands });
    } catch (_err) {
      return `\`/${name}\``;
    }
  }
  const cmd = commands.find(c => c.name === name);
  return cmd ? `</${name}:${cmd.id}>` : `\`/${name}\``;
}

function quickActionButtons(state) {
  return rowsFromButtons(quickActions(state).map(action => {
    if (action.id === 'setup') return button('setup:open', action.label, ButtonStyle.Primary);
    if (action.id === 'ph_connection') return button('setup:ph_connection', action.label);
    if (action.id === 'test_ph_connection') {
      const phUrl = phPlexUrl();
      return phUrl ? linkButton(`${phUrl}/web`, action.label) : button('setup:ph_connection', action.label);
    }
    return button(`setup:quick:${action.command}`, action.label);
  }));
}

function setupEmbed(userRow) {
  const state = setupStateForUser(userRow);
  const title = state.homeServer === 'ph' ? '🇵🇭 Durant Media Server Setup' : '🎬 Durant Media Server Setup';
  return {
    state,
    embed: brandedEmbed(state.plexIdentityVerified && state.plexAccessVerified ? 0x22c55e : 0xe5a00d)
      .setTitle(title)
      .setDescription(`${setupIntro(state)}\n\n\`\`\`\n${setupSummaryLines(state).join('\n')}\n\`\`\``)
      .addFields({
        name: 'Quick tip',
        value: state.homeServer === 'ph'
          ? 'Tailscale/PH Server Connection controls appear only because this account is assigned to the Philippines server. You can return here whenever you add a new device.'
          : 'Use the Quick Actions below for the things you do most often on Discord mobile.',
      }),
  };
}

async function sendSetup(interaction) {
  const row = getUserByDiscordId(interaction.user.id);
  const { state, embed } = setupEmbed(row);
  const components = [...setupButtons(state), ...quickActionButtons(state)].slice(0, 5);
  const payload = { embeds: [embed], components, ephemeral: true };
  if (interaction.replied || interaction.deferred) return interaction.followUp(payload);
  return interaction.reply(payload);
}

function describeTrustStanding(discordId) {
  const threshold = Number(CONFIG.AUTO_APPROVE_AFTER_N_APPROVED || 0);
  if (threshold <= 0) return null;
  const score = getTrustScore(discordId);
  if (score >= threshold) return `🚀 Auto-approved — ${score} approved request${score === 1 ? '' : 's'} (4K still needs admin approval)`;
  return `${score} of ${threshold} approved requests until auto-approval`;
}

async function sendMe(interaction) {
  const row = getUserByDiscordId(interaction.user.id);
  if (!row) {
    const state = setupStateForUser(null);
    return interaction.reply({
      embeds: [brandedEmbed(0xf59e0b)
        .setTitle('👤 Not Linked Yet')
        .setDescription('You are not linked to a Plex account yet. Open **Setup / Troubleshooting** for the Plex account steps, then use the server\'s Request Plex Access flow to finish linking.')],
      components: quickActionButtons(state).slice(0, 2),
      ephemeral: true,
    });
  }

  await interaction.deferReply({ ephemeral: true });
  const state = setupStateForUser(row);
  const requestCount = db.prepare('SELECT COUNT(*) AS c FROM requests WHERE requested_by_discord_id = ?').get(interaction.user.id).c;
  let quota = null;
  if (row.overseerr_user_id != null) {
    try { quota = await fetchUserQuota(row.overseerr_user_id); } catch (_e) {}
  }
  const quotaLines = [quotaLine(quota, 'movie'), quotaLine(quota, 'tv')].filter(Boolean);
  const accessReady = !!(row.invited && row.overseerr_created);
  const homeServer = state.homeServer === 'ph' ? 'Philippines' : 'Main';
  const checklist = [
    `1. ${state.plexIdentityVerified ? '✅' : '⚠️'} Plex username ${state.plexUsername ? `**${state.plexUsername}**` : 'not confirmed — use Setup instead of relying on the invite email'}`,
    `2. ${row.invited ? '✅' : '⏳'} Plex server access ${row.invited ? 'sent/recorded' : 'has not been sent yet'}`,
    `3. ${row.overseerr_created ? '✅' : '⏳'} Request access ${row.overseerr_created ? 'connected' : 'still being set up'}`,
    `4. ${accessReady ? '✅' : '⏳'} Home server: **${homeServer}**`,
  ].join('\n');
  const nextStep = !state.plexIdentityVerified
    ? 'Open **Setup / Troubleshooting** and confirm your Plex username. This avoids depending on Plex invite emails.'
    : !row.invited
      ? `Open **Setup / Troubleshooting** and send access directly to **${state.plexUsername}**.`
      : !row.overseerr_created
        ? 'Your Plex share is recorded; an admin still needs to finish request access.'
        : state.homeServer === 'ph'
          ? 'You are ready. Use **Setup / Troubleshooting** whenever you need to connect a new phone, TV, or computer to the PH server. If an old Plex email invite never worked, use **Verify / Re-send to Username** there.'
          : 'You are ready. Use the Quick Actions below for requests, status, downloads, and help. If an old Plex email invite never worked, use **Verify / Re-send to Username** in Setup.';

  const standing = describeTrustStanding(interaction.user.id);
  const embed = brandedEmbed(accessReady ? 0x22c55e : 0xe5a00d)
    .setTitle(accessReady ? '✅ Your Access Is Ready' : '👤 Your Access Checklist')
    .setThumbnail(interaction.user.displayAvatarURL?.() || null)
    .addFields(
      { name: 'Plex email', value: `\`${row.email}\``, inline: false },
      { name: 'Setup', value: checklist, inline: false },
      { name: 'Next step', value: nextStep, inline: false },
      { name: 'Total requests', value: `${requestCount}`, inline: true },
      ...(quotaLines.length ? [{ name: 'Quota', value: quotaLines.join('\n'), inline: false }] : []),
      ...(standing ? [{ name: 'Standing', value: standing, inline: false }] : []),
      ...(state.homeServer === 'ph' ? [{ name: 'PH Server Connection', value: 'Tailscale is required when you are away from the PH home network. Setup is available again whenever you add a new device.', inline: false }] : []),
    );

  return interaction.editReply({ embeds: [embed], components: quickActionButtons(state).slice(0, 5) });
}

function usernameModal(currentUsername = '') {
  const input = new TextInputBuilder()
    .setCustomId('plex_username')
    .setLabel('Your Plex username')
    .setPlaceholder('Example: johnsmith84')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMinLength(1)
    .setMaxLength(100);
  if (currentUsername) input.setValue(currentUsername.slice(0, 100));
  return new ModalBuilder()
    .setCustomId('setup:plex_username_modal')
    .setTitle('Enter Plex Username')
    .addComponents(new ActionRowBuilder().addComponents(input));
}

async function showPlexUsernameHelp(interaction) {
  const help = plexUsernameHelp();
  const row = getUserByDiscordId(interaction.user.id);
  const lines = [
    '**📱 iPhone / Android**',
    help.phone.map((s, i) => `${i + 1}. ${s}`).join('\n'),
    '',
    '**💻 Computer / Plex Web**',
    help.computer.map((s, i) => `${i + 1}. ${s}`).join('\n'),
    '',
    '**📺 Smart TV / Apple TV / Android TV**',
    help.tv.map((s, i) => `${i + 1}. ${s}`).join('\n'),
    '',
    '**If the TV does not make the username obvious, use Plex Web on your phone or computer.**',
    ...(!row ? ['', '**Next:** finish the server\'s **Request Plex Access** step so your Discord account gets an access record. Then return to `/setup` and enter the username you found.'] : []),
  ];

  const buttons = [linkButton(plexWebUrl(), 'Open Plex Web')];
  if (row) buttons.push(button('setup:plex_enter_username', 'Enter Plex Username', ButtonStyle.Primary));
  buttons.push(button('setup:open', 'Back to Setup'));

  return interaction.reply({
    embeds: [brandedEmbed().setTitle(`🔎 ${help.title}`).setDescription(lines.join('\n'))],
    components: rowsFromButtons(buttons),
    ephemeral: true,
  });
}

const DEVICE_COPY = {
  phone: {
    title: '📱 Phone / Tablet — PH Server Connection',
    steps: [
      'Install **Tailscale** on the phone or tablet.',
      'Open Tailscale and allow the VPN configuration when your device asks.',
      'Sign in using the PH tailnet invite/account flow provided through Discord. Phones and tablets normally use this sign-in flow rather than a pasted auth key.',
      'Make sure Tailscale says **Connected**.',
      'Return here and open PH Plex. If the Plex page opens, the connection is working.',
    ],
  },
  appletv: {
    title: '📺 Apple TV — PH Server Connection',
    steps: [
      'On Apple TV, open the **App Store** and install **Tailscale**.',
      'Open Tailscale and allow/install the VPN configuration.',
      'Choose **Use an auth key** when using the one-time key from Discord, or follow the QR/login flow shown on the TV.',
      'Leave Tailscale connected, then open Plex.',
      'If you need a one-time connection key, use the button below.',
    ],
  },
  androidtv: {
    title: '📺 Android / Google TV — PH Server Connection',
    steps: [
      'Open the **Play Store** on the TV and install **Tailscale**.',
      'Open Tailscale and choose **Log in**.',
      'Use the QR code or generated code shown by the TV app. If an admin needs to authorize the code, use the Discord help button below.',
      'Leave Tailscale connected, then open Plex.',
      'Return here to test PH Plex and save this device as connected.',
    ],
  },
  computer: {
    title: '💻 Computer — PH Server Connection',
    steps: [
      'Install **Tailscale** for Windows, macOS, or Linux.',
      'Open Tailscale and allow the VPN connection.',
      'Use the **one-time connection key** provided for this computer when prompted, or use the normal sign-in flow.',
      'Confirm Tailscale says **Connected**.',
      'Open PH Plex using the button below.',
    ],
  },
};

async function showPhDevice(interaction, device) {
  const row = getUserByDiscordId(interaction.user.id);
  const state = setupStateForUser(row);
  if (!state.tailscaleRequired) {
    return interaction.reply({ content: 'This account is assigned to the Main server, so no PH Server Connection/VPN setup is needed.', ephemeral: true });
  }
  const copy = DEVICE_COPY[device] || DEVICE_COPY.phone;
  const phUrl = phPlexUrl();
  const buttons = [
    linkButton(tailscaleSetupUrl(), 'Install Tailscale'),
    button(`setup:request_key:${device}`, 'Connection Help', ButtonStyle.Primary),
    button('setup:open', 'Back to Setup'),
  ];
  if (phUrl) buttons.splice(2, 0, linkButton(`${phUrl}/web`, '✅ Test / Open PH Plex'));

  return interaction.reply({
    embeds: [brandedEmbed(0x3b82f6)
      .setTitle(copy.title)
      .setDescription(copy.steps.map((s, i) => `**${i + 1}.** ${s}`).join('\n\n'))],
    components: rowsFromButtons(buttons),
    ephemeral: true,
  });
}

async function requestOneTimeKey(interaction, device) {
  const row = getUserByDiscordId(interaction.user.id);
  const state = setupStateForUser(row);
  if (!state.tailscaleRequired) return interaction.reply({ content: 'No PH connection key is needed for your Main-server account.', ephemeral: true });

  let notified = false;
  try {
    const channelId = CONFIG.ADMIN_CHANNEL_ID;
    const channel = channelId ? await interaction.client.channels.fetch(channelId) : null;
    if (channel?.isTextBased()) {
      await channel.send({ embeds: [brandedEmbed(0xf59e0b)
        .setTitle('🔑 PH Connection Key Requested')
        .setDescription(`<@${interaction.user.id}> needs **PH Server Connection help** for **${device}**.\n\nUse the platform-appropriate flow. If an auth key is appropriate, generate a short-lived, one-off PH-viewer key. Do not send a reusable admin key.`)
        .addFields({ name: 'Plex user', value: state.plexUsername || 'not confirmed', inline: true }, { name: 'Home server', value: '🇵🇭 Philippines', inline: true })] });
      notified = true;
    }
  } catch (err) {
    log.warn(`Could not notify admin about PH connection key request: ${err.message}`);
  }

  audit('tailscale_setup_key_requested', { actorDiscordId: interaction.user.id, device, notified });
  return interaction.reply({
    content: notified
      ? '✅ I asked an admin for **PH Server Connection help** for this device. Follow the device-specific instructions they send, then return to **Setup / Troubleshooting**.'
      : '⚠️ I could not reach the admin channel automatically. Please ask an admin for **PH Server Connection help** and tell them which device you are setting up.',
    ephemeral: true,
  });
}

async function savePlexUsername(interaction) {
  const row = getUserByDiscordId(interaction.user.id);
  if (!row) {
    return interaction.reply({ content: 'I cannot save a Plex username until your Discord account has an access-request record. Please use the server\'s **Request Plex Access** flow first, then return to `/setup`.', ephemeral: true });
  }
  const username = String(interaction.fields.getTextInputValue('plex_username') || '').trim();
  if (!username || username.length > 100 || /[\r\n]/.test(username)) {
    return interaction.reply({ content: 'That does not look like a valid Plex username. Please try again.', ephemeral: true });
  }

  db.prepare('UPDATE users SET plex_username = ? WHERE discord_id = ?').run(username, interaction.user.id);
  audit('plex_username_saved', { actorDiscordId: interaction.user.id, plexUsername: username, homeServer: row.home_server || 'primary' });

  const refreshed = getUserByDiscordId(interaction.user.id);
  const state = setupStateForUser(refreshed);
  const shareLabel = state.plexAccessVerified ? 'Verify / Re-send to Username' : `Invite ${username}`.slice(0, 80);
  return interaction.reply({
    embeds: [brandedEmbed(0x22c55e)
      .setTitle('✅ Plex Username Saved')
      .setDescription(`I saved **${username}** as your Plex username.\n\nNext, tap **${shareLabel}**. This sends the Plex share directly to the username and verifies it against Plex, so a missing or broken invitation email does not block setup.`)],
    components: rowsFromButtons([
      button('setup:plex_invite_username', shareLabel, ButtonStyle.Success),
      button('setup:open', 'Back to Setup'),
    ]),
    ephemeral: true,
  });
}

async function inviteSavedUsername(interaction) {
  const row = getUserByDiscordId(interaction.user.id);
  const state = setupStateForUser(row);
  if (!row || !state.plexUsername) return interaction.reply({ content: 'Please enter your Plex username first.', ephemeral: true });

  await interaction.deferReply({ ephemeral: true });
  try {
    const result = await inviteUserToPlex(state.plexUsername, { homeServer: state.homeServer });
    if (!result.successCount) {
      return interaction.editReply({
        content: `⚠️ Plex did not accept an invite for **${state.plexUsername}** on any matching server. Double-check the username and try again.`,
        components: rowsFromButtons([button('setup:plex_enter_username', 'Change Plex Username'), button('setup:plex_find_username', 'Find My Plex Username')]),
      });
    }

    db.prepare("UPDATE users SET invited = 1, invited_at = CURRENT_TIMESTAMP WHERE discord_id = ?").run(interaction.user.id);
    audit('plex_username_invite_sent', { actorDiscordId: interaction.user.id, plexUsername: state.plexUsername, homeServer: state.homeServer, successCount: result.successCount, total: result.total });
    const phNote = state.homeServer === 'ph' ? '\n\nBecause you are on the **Philippines server**, continue with **PH Server Connection** in `/setup` for every device you use away from the PH home Wi-Fi.' : '';
    return interaction.editReply({
      embeds: [brandedEmbed(0x22c55e).setTitle('✅ Plex Access Sent').setDescription(`Plex access was sent to **${state.plexUsername}** on ${result.successCount}/${result.total} matching server${result.total === 1 ? '' : 's'}.${phNote}`)],
      components: rowsFromButtons([button('setup:open', 'Continue Setup', ButtonStyle.Primary)]),
    });
  } catch (err) {
    log.warn(`Username Plex invite failed for ${interaction.user.id}: ${err.message}`);
    return interaction.editReply({ content: `❌ Plex could not send the invite right now: ${err.response?.data?.message || err.message}` });
  }
}

async function quickCommand(interaction, command) {
  const allowed = new Set(['request', 'myrequests', 'request-status', 'downloads', 'help']);
  if (!allowed.has(command)) return interaction.reply({ content: 'That quick action is not available.', ephemeral: true });
  const mention = await guildCommandMention(interaction, command);
  const guidance = command === 'request'
    ? 'Tap the command below, then start typing the movie or show title. Discord will show the same Seerr search choices as the normal slash command.'
    : `Tap the command below to open **/${command}**.`;
  return interaction.reply({ content: `${guidance}\n\n➡️ ${mention}`, ephemeral: true });
}

function isOwnedInteraction(interaction) {
  if (interaction?.isChatInputCommand?.() && ['setup', 'me'].includes(interaction.commandName)) return true;
  if (interaction?.isButton?.() && String(interaction.customId || '').startsWith('setup:')) return true;
  if (interaction?.isModalSubmit?.() && interaction.customId === 'setup:plex_username_modal') return true;
  return false;
}

async function handleSetupInteraction(interaction) {
  if (interaction.isChatInputCommand()) {
    if (interaction.commandName === 'setup') return sendSetup(interaction);
    if (interaction.commandName === 'me') return sendMe(interaction);
  }

  if (interaction.isModalSubmit() && interaction.customId === 'setup:plex_username_modal') return savePlexUsername(interaction);
  if (!interaction.isButton()) return;

  const id = String(interaction.customId || '');
  if (id === 'setup:open') return sendSetup(interaction);
  if (id === 'setup:plex_find_username') return showPlexUsernameHelp(interaction);
  if (id === 'setup:plex_enter_username') {
    const row = getUserByDiscordId(interaction.user.id);
    if (!row) {
      return interaction.reply({
        content: 'First finish the server\'s **Request Plex Access** step so I have an account record for you. Then return to `/setup` and enter the Plex username you found.',
        ephemeral: true,
      });
    }
    return interaction.showModal(usernameModal(row?.plex_username || ''));
  }
  if (id === 'setup:plex_invite_username') return inviteSavedUsername(interaction);
  if (id === 'setup:ph_connection') return showPhDevice(interaction, 'phone');
  if (id.startsWith('setup:ph_device:')) return showPhDevice(interaction, id.split(':')[2]);
  if (id.startsWith('setup:request_key:')) return requestOneTimeKey(interaction, id.split(':')[2] || 'device');
  if (id.startsWith('setup:quick:')) return quickCommand(interaction, id.slice('setup:quick:'.length));
  return interaction.reply({ content: 'That setup action is no longer available. Run `/setup` to refresh the setup screen.', ephemeral: true });
}

function installCommandRegistrationExtension() {
  const originalPut = REST.prototype.put;
  if (originalPut.__durantSetupWrapped) return;

  async function wrappedPut(route, options = {}) {
    if (Array.isArray(options?.body) && options.body.some(c => c?.name === 'me') && !options.body.some(c => c?.name === 'setup')) {
      const setupCommand = new SlashCommandBuilder().setName('setup').setDescription('Setup or troubleshoot your Plex access and server connection').toJSON();
      options = { ...options, body: [...options.body, setupCommand] };
    }
    return originalPut.call(this, route, options);
  }
  wrappedPut.__durantSetupWrapped = true;
  REST.prototype.put = wrappedPut;
}

function installInteractionExtension() {
  const originalEmit = Client.prototype.emit;
  if (originalEmit.__durantSetupWrapped) return;

  function wrappedEmit(event, ...args) {
    if (event === 'interactionCreate' && isOwnedInteraction(args[0])) {
      Promise.resolve(handleSetupInteraction(args[0])).catch(err => {
        log.error(`Guided setup interaction failed: ${err.stack || err.message}`);
        const interaction = args[0];
        const payload = { content: '❌ Setup hit an unexpected error. Please try `/setup` again or contact an admin.', ephemeral: true };
        if (interaction?.replied || interaction?.deferred) interaction.followUp(payload).catch(() => {});
        else interaction?.reply?.(payload).catch(() => {});
      });
      return true;
    }
    return originalEmit.call(this, event, ...args);
  }
  wrappedEmit.__durantSetupWrapped = true;
  Client.prototype.emit = wrappedEmit;
}

function installSetupDiscordExtension() {
  if (globalThis[INSTALL_MARK]) return;
  globalThis[INSTALL_MARK] = true;
  installCommandRegistrationExtension();
  installInteractionExtension();
}

module.exports = {
  installSetupDiscordExtension,
  phPlexUrl,
  setupButtons,
  quickActionButtons,
  usernameModal,
  DEVICE_COPY,
  isOwnedInteraction,
};
