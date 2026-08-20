'use strict';

// Permanent, mobile-first Discord media control panel. An admin runs /media-panel once in the
// desired channel; the bot posts (or refreshes) one pinned message whose buttons open private
// request/support/removal flows. User actions stay ephemeral so the public channel remains clean.

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
  ModalBuilder,
  PermissionFlagsBits,
  REST,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');

const { CONFIG } = require('./config');
const { getUserByDiscordId, getSetting, setSetting, audit } = require('./db');
const { requestModal } = require('./setup-request-ui');
const { log } = require('./log');

const INSTALL_MARK = Symbol.for('durant.mediaPanelInstalled');
const PANEL_KEY_PREFIX = 'discord_media_panel:';

function brandedEmbed(color = 0xe5a00d) {
  return new EmbedBuilder().setColor(color).setFooter({ text: 'Durant Media Server' }).setTimestamp();
}

function panelPayload() {
  const embed = brandedEmbed()
    .setTitle('🎬 Durant Media Center')
    .setDescription([
      '**Request, manage, and get help without remembering slash commands.**',
      '',
      'Tap a button below. Searches, forms, and results are shown privately to you so this channel stays clean.',
    ].join('\n'))
    .addFields(
      { name: 'Requests', value: 'Request a movie or TV series, then choose HD/1080p or 4K.', inline: false },
      { name: 'Manage', value: 'Check your requests or ask to remove/cancel something.', inline: false },
      { name: 'Help', value: 'Report playback problems or send a support request to the media admins.', inline: false },
    );

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('media:request').setLabel('Request Media').setEmoji('🎬').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('media:myrequests').setLabel('My Requests').setEmoji('📋').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('media:queue').setLabel('Downloads / Queue').setEmoji('⬇️').setStyle(ButtonStyle.Secondary),
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('media:remove').setLabel('Remove / Cancel').setEmoji('🗑️').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('media:report').setLabel('Report a Problem').setEmoji('⚠️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('media:support').setLabel('Support').setEmoji('🛟').setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [embed], components: [row1, row2] };
}

function isAdmin(interaction) {
  return interaction.memberPermissions?.has?.(PermissionFlagsBits.Administrator)
    || String(interaction.user?.id || '') === String(CONFIG.ADMIN_USER_ID || '');
}

function panelSettingKey(guildId, channelId) {
  return `${PANEL_KEY_PREFIX}${guildId}:${channelId}`;
}

async function createOrRefreshPanel(interaction) {
  if (!isAdmin(interaction)) return interaction.reply({ content: '❌ Administrator permission is required.', ephemeral: true });
  if (!interaction.guildId || !interaction.channel?.isTextBased?.()) {
    return interaction.reply({ content: '❌ Run `/media-panel` in the server text channel where you want the pinned panel.', ephemeral: true });
  }

  await interaction.deferReply({ ephemeral: true });
  const key = panelSettingKey(interaction.guildId, interaction.channelId);
  const savedId = String(getSetting(key) || '').trim();
  let message = null;

  if (savedId) {
    try { message = await interaction.channel.messages.fetch(savedId); } catch (_e) {}
  }

  try {
    if (message) {
      await message.edit(panelPayload());
    } else {
      message = await interaction.channel.send(panelPayload());
      setSetting(key, message.id);
    }

    if (!message.pinned) {
      try { await message.pin('Permanent Durant Media Center control panel'); }
      catch (err) { log.warn(`Media panel posted but could not be pinned: ${err.message}`); }
    }

    audit('media_panel_published', {
      actorDiscordId: interaction.user.id,
      guildId: interaction.guildId,
      channelId: interaction.channelId,
      messageId: message.id,
    });
    return interaction.editReply(`✅ Media Center panel ${savedId && message.id === savedId ? 'refreshed' : 'posted'}${message.pinned ? ' and pinned' : ''}.`);
  } catch (err) {
    log.error(`Media panel publish failed: ${err.stack || err.message}`);
    return interaction.editReply(`❌ I could not publish the media panel: ${err.message}`);
  }
}

function simpleCommandProxy(interaction, commandName) {
  const options = {
    getString: () => null,
    getBoolean: () => null,
    getInteger: () => null,
    getUser: () => null,
  };
  return new Proxy(interaction, {
    get(target, prop, receiver) {
      if (prop === 'commandName') return commandName;
      if (prop === 'options') return options;
      if (prop === 'isChatInputCommand') return () => true;
      if (prop === 'isButton' || prop === 'isModalSubmit' || prop === 'isStringSelectMenu' || prop === 'isAutocomplete') return () => false;
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function supportModal(kind) {
  const removal = kind === 'remove';
  const report = kind === 'report';
  const title = removal ? 'Remove / Cancel Media' : report ? 'Report a Playback Problem' : 'Media Support';
  const modal = new ModalBuilder().setCustomId(`media:${kind}_modal`).setTitle(title);

  if (removal || report) {
    modal.addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('title')
        .setLabel('Movie or TV series')
        .setPlaceholder('Example: Stranger Things')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(120),
    ));
  }

  modal.addComponents(new ActionRowBuilder().addComponents(
    new TextInputBuilder()
      .setCustomId('details')
      .setLabel(removal ? 'Why should it be removed/cancelled?' : report ? 'What is wrong?' : 'How can we help?')
      .setPlaceholder(removal ? 'Example: I no longer want this series' : 'Include the device and what happened')
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true)
      .setMinLength(3)
      .setMaxLength(1000),
  ));
  return modal;
}

async function notifyAdmins(interaction, kind) {
  await interaction.deferReply({ ephemeral: true });
  const title = ['remove', 'report'].includes(kind) ? String(interaction.fields.getTextInputValue('title') || '').trim() : '';
  const details = String(interaction.fields.getTextInputValue('details') || '').trim();
  const labels = {
    remove: ['🗑️ Removal / Cancellation Requested', 0xef4444],
    report: ['⚠️ Playback Problem Reported', 0xf59e0b],
    support: ['🛟 Media Support Requested', 0x3b82f6],
  };
  const [heading, color] = labels[kind] || labels.support;

  let sent = false;
  try {
    const channel = CONFIG.ADMIN_CHANNEL_ID ? await interaction.client.channels.fetch(CONFIG.ADMIN_CHANNEL_ID) : null;
    if (channel?.isTextBased?.()) {
      const embed = brandedEmbed(color)
        .setTitle(heading)
        .setDescription(`From <@${interaction.user.id}>`)
        .addFields(
          ...(title ? [{ name: 'Media', value: title.slice(0, 1024), inline: false }] : []),
          { name: 'Details', value: details.slice(0, 1024), inline: false },
          { name: 'Source', value: `<#${interaction.channelId}>`, inline: false },
        );
      await channel.send({ embeds: [embed] });
      sent = true;
    }
  } catch (err) {
    log.warn(`Media panel ${kind} notification failed: ${err.message}`);
  }

  audit(`media_panel_${kind}_requested`, {
    actorDiscordId: interaction.user.id,
    title: title || null,
    notified: sent,
  });

  if (!sent) return interaction.editReply('⚠️ I could not reach the media admin channel. Please contact an admin directly.');
  if (kind === 'remove') {
    return interaction.editReply('✅ Your removal/cancellation request was sent to the media admins. Nothing was deleted automatically.');
  }
  if (kind === 'report') return interaction.editReply('✅ Your playback problem was sent to the media admins.');
  return interaction.editReply('✅ Your support request was sent to the media admins.');
}

function owns(interaction) {
  if (interaction?.isChatInputCommand?.() && interaction.commandName === 'media-panel') return true;
  if (interaction?.isButton?.()) return String(interaction.customId || '').startsWith('media:');
  if (interaction?.isModalSubmit?.()) return /^media:(remove|report|support)_modal$/.test(String(interaction.customId || ''));
  return false;
}

function installMediaPanel() {
  if (globalThis[INSTALL_MARK]) return;
  globalThis[INSTALL_MARK] = true;

  // Add the admin-only /media-panel installer without changing index.js's command list.
  const originalPut = REST.prototype.put;
  if (!originalPut.__durantMediaPanelWrapped) {
    async function wrappedPut(route, options = {}) {
      const isBotCommandRegistration = Array.isArray(options?.body)
        && options.body.some(c => c?.name === 'request' || c?.name === 'setup');
      if (isBotCommandRegistration && !options.body.some(c => c?.name === 'media-panel')) {
        const command = new SlashCommandBuilder()
          .setName('media-panel')
          .setDescription('Post or refresh the pinned Media Center control panel in this channel')
          .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
          .toJSON();
        options = { ...options, body: [...options.body, command] };
      }
      return originalPut.call(this, route, options);
    }
    wrappedPut.__durantMediaPanelWrapped = true;
    REST.prototype.put = wrappedPut;
  }

  const downstreamEmit = Client.prototype.emit;
  if (downstreamEmit.__durantMediaPanelWrapped) return;

  function wrappedEmit(event, ...args) {
    const interaction = args[0];
    if (event !== 'interactionCreate' || !owns(interaction)) return downstreamEmit.call(this, event, ...args);

    if (interaction.isChatInputCommand?.() && interaction.commandName === 'media-panel') {
      Promise.resolve(createOrRefreshPanel(interaction)).catch(err => log.error(`Media panel command failed: ${err.stack || err.message}`));
      return true;
    }

    if (interaction.isButton?.()) {
      const id = String(interaction.customId || '');
      if (id === 'media:request') {
        const linked = getUserByDiscordId(interaction.user.id);
        if (!linked) {
          Promise.resolve(interaction.reply({ content: '❌ Your Discord account is not linked yet. Use **Setup / Troubleshooting** or ask an admin to finish your access setup.', ephemeral: true })).catch(() => {});
        } else {
          Promise.resolve(interaction.showModal(requestModal())).catch(err => log.warn(`Media panel request modal failed: ${err.message}`));
        }
        return true;
      }
      if (id === 'media:myrequests') return downstreamEmit.call(this, 'interactionCreate', simpleCommandProxy(interaction, 'myrequests'));
      if (id === 'media:queue') return downstreamEmit.call(this, 'interactionCreate', simpleCommandProxy(interaction, 'queue'));
      if (id === 'media:remove') {
        Promise.resolve(interaction.showModal(supportModal('remove'))).catch(err => log.warn(`Remove modal failed: ${err.message}`));
        return true;
      }
      if (id === 'media:report') {
        Promise.resolve(interaction.showModal(supportModal('report'))).catch(err => log.warn(`Report modal failed: ${err.message}`));
        return true;
      }
      if (id === 'media:support') {
        Promise.resolve(interaction.showModal(supportModal('support'))).catch(err => log.warn(`Support modal failed: ${err.message}`));
        return true;
      }
    }

    if (interaction.isModalSubmit?.()) {
      const match = String(interaction.customId || '').match(/^media:(remove|report|support)_modal$/);
      if (match) {
        Promise.resolve(notifyAdmins(interaction, match[1])).catch(err => log.error(`Media panel form failed: ${err.stack || err.message}`));
        return true;
      }
    }
    return downstreamEmit.call(this, event, ...args);
  }

  wrappedEmit.__durantMediaPanelWrapped = true;
  Client.prototype.emit = wrappedEmit;
}

module.exports = { installMediaPanel, panelPayload, panelSettingKey, supportModal, simpleCommandProxy };
