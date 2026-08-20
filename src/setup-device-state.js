'use strict';

// Persistent, user-confirmed PH device state. This is intentionally described as "confirmed"
// rather than a network probe: Discord cannot prove that a specific phone/TV currently has
// Tailscale connected. The state is still useful for remembering which devices have completed
// setup and for making /setup a durable troubleshooting center instead of a one-time wizard.

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
} = require('discord.js');

const { getUserByDiscordId, getSetting, setSetting, deleteSetting, audit } = require('./db');
const { setupStateForUser, setupSummaryLines, setupIntro } = require('./setup');
const { setupButtons, quickActionButtons, DEVICE_COPY, phPlexUrl } = require('./setup-discord-extension');
const { CONFIG } = require('./config');
const { log } = require('./log');

const INSTALL_MARK = Symbol.for('durant.setupDeviceStateInstalled');
const DEVICES = ['phone', 'appletv', 'androidtv', 'computer'];
const LABELS = {
  phone: '📱 Phone / Tablet',
  appletv: '📺 Apple TV',
  androidtv: '📺 Android / Google TV',
  computer: '💻 Computer',
};

function brandedEmbed(color = 0x3b82f6) {
  return new EmbedBuilder().setColor(color).setFooter({ text: 'Durant Media Server' }).setTimestamp();
}

function stateKey(discordId, device) {
  return `ph_device_confirmed:${discordId}:${device}`;
}

function deviceConfirmation(discordId, device) {
  const raw = getSetting(stateKey(discordId, device));
  if (!raw) return null;
  const ts = Number(raw);
  return Number.isFinite(ts) && ts > 0 ? ts : null;
}

function deviceConfirmations(discordId) {
  return Object.fromEntries(DEVICES.map(device => [device, deviceConfirmation(discordId, device)]));
}

function anyDeviceConfirmed(discordId) {
  return Object.values(deviceConfirmations(discordId)).some(Boolean);
}

function statusLine(device, ts) {
  if (!ts) return `${LABELS[device]} — ⚪ not confirmed`;
  const unix = Math.floor(ts / 1000);
  return `${LABELS[device]} — ✅ confirmed <t:${unix}:R>`;
}

function tailscaleInstallUrl() {
  return String(CONFIG.TAILSCALE_SETUP_URL || process.env.TAILSCALE_SETUP_URL || 'https://tailscale.com/download').trim();
}

// Preferred PH-viewer path: share only the PH Plex machine to a user's own Tailscale identity.
// That keeps the viewer outside the Durant tailnet user-seat count while Tailscale's share
// quarantine and policy can limit them to this machine/port. Share links expire, so operators
// rotate this deployment value instead of persisting it in a member record.
function tailscaleShareUrl() {
  const raw = String(process.env.TAILSCALE_PH_SHARE_URL || '').trim();
  return /^https:\/\//i.test(raw) ? raw : '';
}

function linkButton(url, label) {
  return new ButtonBuilder().setURL(url).setLabel(label).setStyle(ButtonStyle.Link);
}

function customButton(id, label, style = ButtonStyle.Secondary) {
  return new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style);
}

function rows(buttons) {
  const out = [];
  for (let i = 0; i < buttons.length && out.length < 5; i += 5) out.push(new ActionRowBuilder().addComponents(...buttons.slice(i, i + 5)));
  return out;
}

function personalizedSetupPayload(row) {
  const confirmed = row?.discord_id ? anyDeviceConfirmed(row.discord_id) : false;
  const state = setupStateForUser(row, { connectionVerified: confirmed });
  const embed = brandedEmbed(state.plexIdentityVerified && state.plexAccessVerified ? 0x22c55e : 0xe5a00d)
    .setTitle(state.homeServer === 'ph' ? '🇵🇭 Durant Media Server Setup' : '🎬 Durant Media Server Setup')
    .setDescription(`${setupIntro(state)}\n\n\`\`\`\n${setupSummaryLines(state).join('\n')}\n\`\`\``);

  if (state.homeServer === 'ph') {
    const confirmations = deviceConfirmations(row.discord_id);
    embed.addFields({
      name: 'PH devices',
      value: DEVICES.map(device => statusLine(device, confirmations[device])).join('\n'),
      inline: false,
    }, {
      name: 'About this status',
      value: 'A green check means **you confirmed setup on that device**. It is a saved setup record, not a live VPN-health probe. Use **PH Server Connection** below to add or troubleshoot a device.',
      inline: false,
    });
  } else {
    embed.addFields({ name: 'Quick tip', value: 'Use the Quick Actions below for requests, status, downloads, setup, and help.' });
  }

  const components = [...setupButtons(state), ...quickActionButtons(state)].slice(0, 5);
  return { embeds: [embed], components, ephemeral: true };
}

async function showSetup(interaction) {
  const row = getUserByDiscordId(interaction.user.id);
  const payload = personalizedSetupPayload(row);
  if (interaction.replied || interaction.deferred) return interaction.followUp(payload);
  return interaction.reply(payload);
}

async function showPhDashboard(interaction) {
  const row = getUserByDiscordId(interaction.user.id);
  const state = setupStateForUser(row);
  if (!state.tailscaleRequired) return interaction.reply({ content: 'Your account uses the Main server, so no PH Server Connection setup is needed.', ephemeral: true });
  const confirmations = deviceConfirmations(interaction.user.id);
  const shareUrl = tailscaleShareUrl();
  const buttons = DEVICES.map(device => customButton(`setup:ph_device:${device}`, LABELS[device]));
  if (shareUrl) buttons.push(linkButton(shareUrl, '🔗 Join PH Server'));
  return interaction.reply({
    embeds: [brandedEmbed().setTitle('🔐 PH Server Connection').setDescription([
      'Choose the device you want to set up or troubleshoot.',
      '',
      ...(shareUrl ? [
        '**No paid Durant Tailscale seat is required.** Tap **Join PH Server** to accept a share of only the PH Plex machine using your own free Tailscale identity.',
        '',
      ] : []),
      ...DEVICES.map(device => statusLine(device, confirmations[device])),
      '',
      'Each device keeps its own saved setup confirmation. You can reset a device later if you replace it or need to troubleshoot from scratch.',
    ].join('\n'))],
    components: rows(buttons),
    ephemeral: true,
  });
}

async function showDevice(interaction, device) {
  const row = getUserByDiscordId(interaction.user.id);
  const state = setupStateForUser(row);
  if (!state.tailscaleRequired) return interaction.reply({ content: 'Your account uses the Main server, so no PH Server Connection setup is needed.', ephemeral: true });
  if (!DEVICES.includes(device)) return interaction.reply({ content: 'Unknown device type. Open `/setup` and choose a device again.', ephemeral: true });
  const copy = DEVICE_COPY[device];
  const confirmedAt = deviceConfirmation(interaction.user.id, device);
  const shareUrl = tailscaleShareUrl();
  const buttons = [linkButton(tailscaleInstallUrl(), 'Install Tailscale')];
  if (shareUrl) buttons.push(linkButton(shareUrl, '🔗 Join PH Server'));
  const helpLabel = shareUrl
    ? 'Connection Help'
    : device === 'phone' ? 'Join / Connection Help'
      : device === 'androidtv' ? 'TV Code / Connection Help'
        : 'Connection Help';
  buttons.push(customButton(`setup:request_key:${device}`, helpLabel, ButtonStyle.Primary));
  if (phPlexUrl()) buttons.push(linkButton(`${phPlexUrl()}/web`, 'Test / Open PH Plex'));
  buttons.push(customButton(`setup:ph_confirm:${device}`, confirmedAt ? 'Confirm Again' : '✅ I Connected This Device', ButtonStyle.Success));
  if (confirmedAt) buttons.push(customButton(`setup:ph_unconfirm:${device}`, 'Reset Device Status', ButtonStyle.Danger));
  buttons.push(customButton('setup:ph_connection', 'Back to PH Devices'));

  const shareIntro = shareUrl
    ? '\n\n**Join the PH server:** Tap **Join PH Server**, sign in with your own Tailscale account, and accept the shared PH Plex machine. This does not add you as a paid user on the Durant tailnet.'
    : '';
  const status = confirmedAt ? `\n\n**Saved status:** ✅ confirmed <t:${Math.floor(confirmedAt / 1000)}:R>` : '\n\n**Saved status:** ⚪ not confirmed yet';
  return interaction.reply({
    embeds: [brandedEmbed().setTitle(copy.title).setDescription(`${copy.steps.map((s, i) => `**${i + 1}.** ${s}`).join('\n\n')}${shareIntro}${status}`)],
    components: rows(buttons),
    ephemeral: true,
  });
}

async function confirmDevice(interaction, device) {
  const row = getUserByDiscordId(interaction.user.id);
  if (!row || row.home_server !== 'ph') return interaction.reply({ content: 'PH device setup is only available to Philippines-server users.', ephemeral: true });
  if (!DEVICES.includes(device)) return interaction.reply({ content: 'Unknown device type.', ephemeral: true });
  const now = Date.now();
  setSetting(stateKey(interaction.user.id, device), String(now));
  audit('ph_device_setup_confirmed', { actorDiscordId: interaction.user.id, device, confirmedAt: now });
  return interaction.reply({
    embeds: [brandedEmbed(0x22c55e).setTitle('✅ Device Setup Saved').setDescription(`${LABELS[device]} is now marked as **setup confirmed**.\n\nThis remembers your onboarding progress; it does not continuously monitor whether Tailscale is connected.`)],
    components: rows([customButton('setup:ph_connection', 'View PH Devices', ButtonStyle.Primary), customButton('setup:open', 'Back to Setup')]),
    ephemeral: true,
  });
}

async function resetDevice(interaction, device) {
  const row = getUserByDiscordId(interaction.user.id);
  if (!row || row.home_server !== 'ph') return interaction.reply({ content: 'PH device setup is only available to Philippines-server users.', ephemeral: true });
  if (!DEVICES.includes(device)) return interaction.reply({ content: 'Unknown device type.', ephemeral: true });
  deleteSetting(stateKey(interaction.user.id, device));
  audit('ph_device_setup_reset', { actorDiscordId: interaction.user.id, device });
  return interaction.reply({
    content: `${LABELS[device]} was reset to **not confirmed**. Open PH Server Connection to set it up again.`,
    components: rows([customButton('setup:ph_connection', 'View PH Devices', ButtonStyle.Primary)]),
    ephemeral: true,
  });
}

function owns(interaction) {
  if (interaction?.isChatInputCommand?.() && interaction.commandName === 'setup') return true;
  if (!interaction?.isButton?.()) return false;
  const id = String(interaction.customId || '');
  return id === 'setup:open'
    || id === 'setup:ph_connection'
    || id.startsWith('setup:ph_device:')
    || id.startsWith('setup:ph_confirm:')
    || id.startsWith('setup:ph_unconfirm:');
}

function installSetupDeviceState() {
  if (globalThis[INSTALL_MARK]) return;
  globalThis[INSTALL_MARK] = true;
  const downstreamEmit = Client.prototype.emit;
  if (downstreamEmit.__durantDeviceStateWrapped) return;

  function wrappedEmit(event, ...args) {
    const interaction = args[0];
    if (event !== 'interactionCreate' || !owns(interaction)) return downstreamEmit.call(this, event, ...args);
    let task;
    if (interaction.isChatInputCommand?.() && interaction.commandName === 'setup') task = showSetup(interaction);
    else {
      const id = String(interaction.customId || '');
      if (id === 'setup:open') task = showSetup(interaction);
      else if (id === 'setup:ph_connection') task = showPhDashboard(interaction);
      else if (id.startsWith('setup:ph_device:')) task = showDevice(interaction, id.split(':')[2]);
      else if (id.startsWith('setup:ph_confirm:')) task = confirmDevice(interaction, id.split(':')[2]);
      else if (id.startsWith('setup:ph_unconfirm:')) task = resetDevice(interaction, id.split(':')[2]);
    }
    Promise.resolve(task).catch(err => {
      log.error(`PH device setup state failed: ${err.stack || err.message}`);
      const payload = { content: '❌ PH setup hit an unexpected error. Run `/setup` and try again.', ephemeral: true };
      if (interaction?.replied || interaction?.deferred) interaction.followUp(payload).catch(() => {});
      else interaction?.reply?.(payload).catch(() => {});
    });
    return true;
  }
  wrappedEmit.__durantDeviceStateWrapped = true;
  Client.prototype.emit = wrappedEmit;
}

module.exports = {
  installSetupDeviceState,
  DEVICES,
  LABELS,
  stateKey,
  deviceConfirmation,
  deviceConfirmations,
  anyDeviceConfirmed,
  tailscaleShareUrl,
  personalizedSetupPayload,
};
