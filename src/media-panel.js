'use strict';

// Permanent, mobile-first Discord media control panel. An admin runs /media-panel once in the
// desired channel; the bot posts (or refreshes) one pinned message whose buttons open private
// request/support/removal flows. User actions stay ephemeral so the public channel remains clean.

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');

const { submitSupportCase } = require('./support-cases');

const PANEL_KEY_PREFIX = 'discord_media_panel:';

const mediaPanelCommand = new SlashCommandBuilder()
  .setName('media-panel')
  .setDescription('Post or refresh the pinned Media Center control panel in this channel')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

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
    new ButtonBuilder().setCustomId('media:mycases').setLabel('My Cases').setEmoji('🗂️').setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [embed], components: [row1, row2] };
}

function isAdmin(interaction, config) {
  return interaction.memberPermissions?.has?.(PermissionFlagsBits.Administrator)
    || String(interaction.user?.id || '') === String(config.ADMIN_USER_ID || '');
}

function panelSettingKey(guildId, channelId) {
  return `${PANEL_KEY_PREFIX}${guildId}:${channelId}`;
}

async function createOrRefreshPanel(interaction, { config, getSetting, setSetting, audit, log }) {
  if (!isAdmin(interaction, config)) return interaction.reply({ content: '❌ Administrator permission is required.', ephemeral: true });
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

// Reports/support requests/removal requests are persisted as durable support cases (issue #256)
// instead of a one-off admin-channel message: src/support-cases.js owns creation, admin-channel
// delivery (retry-safe), and the member-facing reference ID reply.
async function notifyAdmins(interaction, kind, { config, audit, log, supportCases }) {
  return submitSupportCase(interaction, kind, {
    config,
    audit,
    log,
    createCase: supportCases.createCase,
    recordNotifyResult: supportCases.recordNotifyResult,
  });
}

function owns(interaction) {
  if (interaction?.isChatInputCommand?.() && interaction.commandName === 'media-panel') return true;
  if (interaction?.isButton?.()) return String(interaction.customId || '').startsWith('media:');
  if (interaction?.isModalSubmit?.()) return /^media:(remove|report|support)_modal$/.test(String(interaction.customId || ''));
  return false;
}

function createMediaPanelFeature({ config, getUserByDiscordId, getSetting, setSetting, audit, requestModal, log, forwardSlashCommand, supportCases }) {
  if (!config || !getUserByDiscordId || !getSetting || !setSetting || !audit || !requestModal || !log || !forwardSlashCommand || !supportCases?.createCase || !supportCases?.recordNotifyResult) {
    throw new TypeError('Media panel dependencies are required');
  }

  async function handleInteraction(interaction) {
    if (!owns(interaction)) return false;
    if (interaction.isChatInputCommand?.() && interaction.commandName === 'media-panel') {
      await createOrRefreshPanel(interaction, { config, getSetting, setSetting, audit, log });
      return true;
    }

    if (interaction.isButton?.()) {
      const id = String(interaction.customId || '');
      if (id === 'media:request') {
        const linked = getUserByDiscordId(interaction.user.id);
        if (!linked) {
          await interaction.reply({ content: '❌ Your Discord account is not linked yet. Use **Setup / Troubleshooting** or ask an admin to finish your access setup.', ephemeral: true });
        } else {
          await interaction.showModal(requestModal());
        }
        return true;
      }
      if (id === 'media:myrequests') {
        await forwardSlashCommand(simpleCommandProxy(interaction, 'myrequests'));
        return true;
      }
      if (id === 'media:queue') {
        await forwardSlashCommand(simpleCommandProxy(interaction, 'queue'));
        return true;
      }
      if (id === 'media:mycases') {
        await forwardSlashCommand(simpleCommandProxy(interaction, 'mycases'));
        return true;
      }
      if (id === 'media:remove') {
        await interaction.showModal(supportModal('remove'));
        return true;
      }
      if (id === 'media:report') {
        await interaction.showModal(supportModal('report'));
        return true;
      }
      if (id === 'media:support') {
        await interaction.showModal(supportModal('support'));
        return true;
      }
    }

    if (interaction.isModalSubmit?.()) {
      const match = String(interaction.customId || '').match(/^media:(remove|report|support)_modal$/);
      if (match) {
        await notifyAdmins(interaction, match[1], { config, audit, log, supportCases });
        return true;
      }
    }
    return false;
  }

  return { command: mediaPanelCommand, handleInteraction, owns };
}

module.exports = {
  createMediaPanelFeature,
  mediaPanelCommand,
  panelPayload,
  panelSettingKey,
  supportModal,
  simpleCommandProxy,
};
