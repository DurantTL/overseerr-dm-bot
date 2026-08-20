'use strict';

// Follow-on guided-setup features layered over setup-discord-extension.js.
// Loaded after the base extension, so owned interactions here get first refusal before the
// base setup handler. This keeps the current draft PR incremental without duplicating index.js.

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
  PermissionFlagsBits,
  REST,
  SlashCommandBuilder,
} = require('discord.js');

const { CONFIG } = require('./config');
const { db, getUserByDiscordId, audit } = require('./db');
const { getPlexToken, fetchPlexFriends, inviteUserToPlex } = require('./plex');
const { setupStateForUser, setupSummaryLines, setupIntro } = require('./setup');
const { setupButtons, quickActionButtons, phPlexUrl } = require('./setup-discord-extension');
const { deviceConfirmations, anyDeviceConfirmed, LABELS } = require('./setup-device-state');
const { createViewerAuthKey, configured: tailscaleApiConfigured, provisionConfig } = require('./tailscale-provision');
const { log } = require('./log');

const INSTALL_MARK = Symbol.for('durant.guidedSetupEnhancementsInstalled');

function brandedEmbed(color = 0xe5a00d) {
  return new EmbedBuilder().setColor(color).setFooter({ text: 'Durant Media Server' }).setTimestamp();
}

function setupPayloadForUser(userRow, { dm = false } = {}) {
  const connectionVerified = userRow?.home_server === 'ph' && userRow?.discord_id
    ? anyDeviceConfirmed(userRow.discord_id)
    : false;
  const state = setupStateForUser(userRow, { connectionVerified });
  const title = state.homeServer === 'ph' ? '🇵🇭 Your Durant Media Server Setup' : '🎬 Your Durant Media Server Setup';
  const embed = brandedEmbed(state.plexIdentityVerified && state.plexAccessVerified ? 0x22c55e : 0xe5a00d)
    .setTitle(title)
    .setDescription(`${setupIntro(state)}\n\n\`\`\`\n${setupSummaryLines(state).join('\n')}\n\`\`\``)
    .addFields({
      name: 'Come back any time',
      value: state.homeServer === 'ph'
        ? 'Use `/setup` whenever you add a new phone, TV, or computer. PH Server Connection instructions only appear for Philippines users.'
        : 'Use `/setup` any time you need Plex account help or want the mobile Quick Actions again.',
    });

  if (state.homeServer === 'ph' && userRow?.discord_id) {
    const confirmations = deviceConfirmations(userRow.discord_id);
    const lines = Object.entries(LABELS).map(([device, label]) => {
      const ts = confirmations[device];
      return ts ? `${label} — ✅ confirmed <t:${Math.floor(ts / 1000)}:R>` : `${label} — ⚪ not confirmed`;
    });
    embed.addFields({
      name: 'PH devices',
      value: lines.join('\n'),
      inline: false,
    });
  }

  const components = [...setupButtons(state), ...quickActionButtons(state)].slice(0, 5);
  return { embeds: [embed], components, ...(dm ? {} : { ephemeral: true }) };
}

function isAdmin(interaction) {
  return interaction.memberPermissions?.has?.(PermissionFlagsBits.Administrator)
    || String(interaction.user?.id || '') === String(CONFIG.ADMIN_USER_ID || '');
}

async function sendSetupGuideCommand(interaction) {
  if (!isAdmin(interaction)) return interaction.reply({ content: '❌ Administrator permission is required.', ephemeral: true });
  const target = interaction.options.getUser('user', true);
  const row = getUserByDiscordId(target.id);
  if (!row) return interaction.reply({ content: `⚠️ ${target.tag || target.username} does not have a Durant Media Server user record yet. Use the normal access invite flow first.`, ephemeral: true });

  await interaction.deferReply({ ephemeral: true });
  try {
    await target.send(setupPayloadForUser(row, { dm: true }));
    audit('setup_guide_sent', { actorDiscordId: interaction.user.id, targetDiscordId: target.id, homeServer: row.home_server || 'primary' });
    return interaction.editReply(`✅ Sent ${target.tag || target.username} their personalized **${row.home_server === 'ph' ? 'Philippines + PH Server Connection' : 'Main Plex'}** setup guide.`);
  } catch (err) {
    log.warn(`Could not DM setup guide to ${target.id}: ${err.message}`);
    return interaction.editReply(`❌ I could not DM ${target.tag || target.username}. They may have server DMs disabled. Ask them to run \`/setup\` directly.`);
  }
}

function keyUsageCopy(device, key, ttlSeconds) {
  const ttlMinutes = Math.max(1, Math.round(ttlSeconds / 60));
  const common = `This is a **one-time**, restricted appliance key and expires in about **${ttlMinutes} minutes** if unused. Do not share it.`;
  if (device === 'appletv') {
    return `${common}\n\n**Apple TV shared/appliance mode**\n1. Install/open Tailscale on Apple TV.\n2. Choose **Use an auth key**.\n3. On your iPhone/iPad open the Apple TV Remote keyboard and paste the key below.\n4. Select **Log in**.\n\n\`${key}\``;
  }
  if (device === 'computer') {
    return `${common}\n\n**Computer shared/appliance mode**\nIf the client offers an auth-key option, paste the key below. Otherwise use the Tailscale CLI with its auth-key option.\n\n\`${key}\``;
  }
  return `${common}\n\n\`${key}\``;
}

async function autoOrFallbackKey(interaction, device) {
  const row = getUserByDiscordId(interaction.user.id);
  const state = setupStateForUser(row);
  if (!state.tailscaleRequired) return interaction.reply({ content: 'No PH connection setup is needed for your Main-server account.', ephemeral: true });

  // Personal viewer devices should normally keep a user-owned Tailscale identity. Current
  // Tailscale guidance reserves tags for non-human/shared infrastructure, because applying a
  // tag replaces the user's identity on that device. Phones and Android/Google TV therefore
  // always use the normal user login/invite path. Apple TV/computer only reach the optional
  // tagged auth-key path when the operator explicitly enables TAILSCALE_API_ENABLED.
  if (device === 'phone') {
    return interaction.reply({
      embeds: [brandedEmbed(0x3b82f6).setTitle('📱 Phone / Tablet — easiest setup').setDescription([
        'Use your normal Tailscale user sign-in/invite rather than an auth key.',
        '',
        '1. Install and open Tailscale.',
        '2. Allow the VPN configuration.',
        '3. Sign in to the tailnet account/invite your admin provided.',
        '4. Confirm Tailscale says **Connected**.',
        '5. Return to Discord and open PH Plex.',
        '',
        'If you still need help joining the tailnet, use **Ask Admin for Access** below.',
      ].join('\n'))],
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('setup:admin_tailnet_help:phone').setLabel('Ask Admin for Access').setStyle(ButtonStyle.Primary),
        ...(phPlexUrl() ? [new ButtonBuilder().setURL(`${phPlexUrl()}/web`).setLabel('Test / Open PH Plex').setStyle(ButtonStyle.Link)] : []),
      )],
      ephemeral: true,
    });
  }
  if (device === 'androidtv') {
    return interaction.reply({
      embeds: [brandedEmbed(0x3b82f6).setTitle('📺 Android / Google TV — easiest setup').setDescription([
        'Use the normal Tailscale user/QR flow so this personal TV keeps the viewer identity.',
        '',
        '1. Install/open Tailscale on the TV and choose **Log in**.',
        '2. Scan the QR code with a phone, or use the generated code shown by the TV app.',
        '3. If the generated code needs admin help, send it using the button below.',
        '4. When the TV says **Connected**, open Plex.',
      ].join('\n'))],
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('setup:admin_tailnet_help:androidtv').setLabel('Send TV Code / Ask Admin').setStyle(ButtonStyle.Primary),
        ...(phPlexUrl() ? [new ButtonBuilder().setURL(`${phPlexUrl()}/web`).setLabel('Test / Open PH Plex').setStyle(ButtonStyle.Link)] : []),
      )],
      ephemeral: true,
    });
  }

  const cfg = provisionConfig();
  if (!tailscaleApiConfigured(cfg)) {
    const label = device === 'appletv' ? 'Apple TV' : 'computer';
    return interaction.reply({
      embeds: [brandedEmbed(0x3b82f6).setTitle(`🔐 ${label} — recommended personal-device setup`).setDescription([
        'Use the normal Tailscale login/QR flow for a personal viewer device.',
        '',
        'The bot\'s automatic auth-key mode is intentionally disabled unless an admin explicitly enables shared/appliance provisioning.',
        'If you need the tailnet invitation or help connecting, use the button below.',
      ].join('\n'))],
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`setup:admin_tailnet_help:${device}`).setLabel('Ask Admin for Access').setStyle(ButtonStyle.Primary),
        ...(phPlexUrl() ? [new ButtonBuilder().setURL(`${phPlexUrl()}/web`).setLabel('Test / Open PH Plex').setStyle(ButtonStyle.Link)] : []),
      )],
      ephemeral: true,
    });
  }

  await interaction.deferReply({ ephemeral: true });
  try {
    const result = await createViewerAuthKey({ discordId: interaction.user.id, device, config: cfg });
    audit('tailscale_viewer_key_created', {
      actorDiscordId: interaction.user.id,
      device,
      keyId: result.keyId,
      tag: result.tag,
      expirySeconds: result.expirySeconds,
    });
    return interaction.editReply({
      embeds: [brandedEmbed(0x22c55e).setTitle('🔑 One-Time Shared/Appliance Connection Key').setDescription(keyUsageCopy(device, result.key, result.expirySeconds))],
      components: phPlexUrl() ? [new ActionRowBuilder().addComponents(new ButtonBuilder().setURL(`${phPlexUrl()}/web`).setLabel('After Setup: Test PH Plex').setStyle(ButtonStyle.Link))] : [],
    });
  } catch (err) {
    log.warn(`Automatic Tailscale viewer-key creation failed: ${err.response?.data?.message || err.message}`);
    return notifyAdminForManualKey(interaction, device, `Automatic appliance-key creation failed: ${err.response?.data?.message || err.message}`, true);
  }
}

async function notifyAdminForManualKey(interaction, device, reason, alreadyDeferred = false) {
  let notified = false;
  try {
    const channel = CONFIG.ADMIN_CHANNEL_ID ? await interaction.client.channels.fetch(CONFIG.ADMIN_CHANNEL_ID) : null;
    if (channel?.isTextBased()) {
      await channel.send({ embeds: [brandedEmbed(0xf59e0b)
        .setTitle('🔐 PH Connection Help Requested')
        .setDescription(`<@${interaction.user.id}> needs PH Server Connection help for **${device}**.\n\n${reason}`)] });
      notified = true;
    }
  } catch (err) {
    log.warn(`Could not notify admin for PH setup: ${err.message}`);
  }
  audit('tailscale_setup_manual_help_requested', { actorDiscordId: interaction.user.id, device, reason, notified });
  const content = notified
    ? '✅ I notified an admin. They can finish the PH Server Connection setup with you.'
    : '⚠️ I could not notify the admin channel. Please contact an admin directly.';
  if (alreadyDeferred || interaction.deferred) return interaction.editReply({ content });
  return interaction.reply({ content, ephemeral: true });
}

async function verifyAndInvitePlexUsername(interaction) {
  const row = getUserByDiscordId(interaction.user.id);
  const state = setupStateForUser(row);
  if (!row || !state.plexUsername) return interaction.reply({ content: 'Please enter your Plex username first.', ephemeral: true });

  await interaction.deferReply({ ephemeral: true });
  try {
    const result = await inviteUserToPlex(state.plexUsername, { homeServer: state.homeServer });
    if (!result.successCount) return interaction.editReply(`⚠️ Plex did not accept **${state.plexUsername}** on any matching server. Double-check the username in \`/setup\`.`);

    // Read back the Plex account list. This is intentionally stronger than treating a successful
    // POST as proof: it confirms Plex recognizes the username on the owner's account after the share.
    const token = await getPlexToken();
    const friends = await fetchPlexFriends(token).catch(() => []);
    const wanted = state.plexUsername.toLowerCase();
    const matched = friends.find(f => [f.username, f.title, f.email].some(v => String(v || '').toLowerCase() === wanted));

    if (!matched) {
      audit('plex_username_invite_unverified', { actorDiscordId: interaction.user.id, plexUsername: state.plexUsername, homeServer: state.homeServer, successCount: result.successCount });
      return interaction.editReply({
        embeds: [brandedEmbed(0xf59e0b).setTitle('⚠️ Plex Share Sent, Not Yet Verified').setDescription(`Plex accepted the share request for **${state.plexUsername}**, but the account is not visible in the Plex user list yet. Wait a minute and run \`/setup\` again before assuming access is complete.`)],
      });
    }

    db.prepare("UPDATE users SET invited = 1, invited_at = CURRENT_TIMESTAMP WHERE discord_id = ?").run(interaction.user.id);
    audit('plex_username_invite_verified', { actorDiscordId: interaction.user.id, plexUsername: state.plexUsername, homeServer: state.homeServer, plexUserId: matched.id || null, successCount: result.successCount, total: result.total });
    return interaction.editReply({
      embeds: [brandedEmbed(0x22c55e).setTitle('✅ Plex Access Verified').setDescription(`Plex recognizes **${state.plexUsername}** on the server owner account. Continue setup below.${state.homeServer === 'ph' ? '\n\nNext: set up **PH Server Connection** for each device used away from the PH home Wi-Fi.' : ''}`)],
      components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('setup:open').setLabel('Continue Setup').setStyle(ButtonStyle.Primary))],
    });
  } catch (err) {
    log.warn(`Verified username invite failed: ${err.response?.data?.message || err.message}`);
    return interaction.editReply(`❌ Plex could not complete the username share right now: ${err.response?.data?.message || err.message}`);
  }
}

async function adminTailnetHelp(interaction, device) {
  return notifyAdminForManualKey(interaction, device, `User requested device-specific PH connection help for ${device}.`);
}

function isOwned(interaction) {
  if (interaction?.isChatInputCommand?.() && interaction.commandName === 'send-setup') return true;
  if (!interaction?.isButton?.()) return false;
  const id = String(interaction.customId || '');
  return id === 'setup:plex_invite_username'
    || id.startsWith('setup:request_key:')
    || id.startsWith('setup:admin_tailnet_help:');
}

async function handle(interaction) {
  if (interaction.isChatInputCommand() && interaction.commandName === 'send-setup') return sendSetupGuideCommand(interaction);
  const id = String(interaction.customId || '');
  if (id === 'setup:plex_invite_username') return verifyAndInvitePlexUsername(interaction);
  if (id.startsWith('setup:request_key:')) return autoOrFallbackKey(interaction, id.split(':')[2] || 'device');
  if (id.startsWith('setup:admin_tailnet_help:')) return adminTailnetHelp(interaction, id.split(':')[2] || 'device');
}

function installCommandRegistration() {
  const originalPut = REST.prototype.put;
  if (originalPut.__durantSetupEnhancementsWrapped) return;
  async function wrappedPut(route, options = {}) {
    const isBotCommandRegistration = Array.isArray(options?.body)
      && options.body.some(c => c?.name === 'me' || c?.name === 'setup');
    if (isBotCommandRegistration && !options.body.some(c => c?.name === 'send-setup')) {
      const cmd = new SlashCommandBuilder()
        .setName('send-setup')
        .setDescription('Send a member their personalized Plex/PH setup guide')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addUserOption(o => o.setName('user').setDescription('Member to send the guide to').setRequired(true))
        .toJSON();
      options = { ...options, body: [...options.body, cmd] };
    }
    return originalPut.call(this, route, options);
  }
  wrappedPut.__durantSetupEnhancementsWrapped = true;
  REST.prototype.put = wrappedPut;
}

function installInteractionInterception() {
  const originalEmit = Client.prototype.emit;
  if (originalEmit.__durantSetupEnhancementsWrapped) return;
  function wrappedEmit(event, ...args) {
    if (event === 'interactionCreate' && isOwned(args[0])) {
      Promise.resolve(handle(args[0])).catch(err => {
        log.error(`Guided setup enhancement failed: ${err.stack || err.message}`);
        const interaction = args[0];
        const payload = { content: '❌ Setup hit an unexpected error. Please try again or contact an admin.', ephemeral: true };
        if (interaction?.replied || interaction?.deferred) interaction.followUp(payload).catch(() => {});
        else interaction?.reply?.(payload).catch(() => {});
      });
      return true;
    }
    return originalEmit.call(this, event, ...args);
  }
  wrappedEmit.__durantSetupEnhancementsWrapped = true;
  Client.prototype.emit = wrappedEmit;
}

function installSetupDiscordEnhancements() {
  if (globalThis[INSTALL_MARK]) return;
  globalThis[INSTALL_MARK] = true;
  installCommandRegistration();
  installInteractionInterception();
}

module.exports = {
  installSetupDiscordEnhancements,
  setupPayloadForUser,
  keyUsageCopy,
  isOwned,
};
