'use strict';

// Mobile-first request wizard. Discord buttons cannot execute slash commands directly, so this
// layer collects a title, searches Seerr, lets the member pick a result, then forwards a proxy
// interaction into the bot's EXISTING /request handler. That preserves quotas, duplicate checks,
// approval gating, trust/auto-approval, subscriptions, and audit behavior in one place.

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');

const { getUserByDiscordId } = require('./db');
const { searchSeerr } = require('./seerr');
const { log } = require('./log');

const INSTALL_MARK = Symbol.for('durant.setupRequestUiInstalled');
const SESSION_TTL_MS = 15 * 60 * 1000;
const sessions = new Map();

function brandedEmbed(color = 0x3b82f6) {
  return new EmbedBuilder().setColor(color).setFooter({ text: 'Durant Media Server' }).setTimestamp();
}

function mediaEmoji(mediaType) {
  return mediaType === 'tv' ? '📺' : '🎬';
}

function resultTitle(result) {
  return String((result.mediaType === 'movie' ? result.title : result.name) || 'Unknown').trim();
}

function resultYear(result) {
  const raw = result.releaseDate || result.firstAirDate;
  return raw ? String(raw).slice(0, 4) : '';
}

function resultStatus(result) {
  const status = result.mediaInfo?.status;
  if (status === 5) return '✅ on Plex';
  if (status === 4) return '🌗 partly on Plex';
  if (status === 2 || status === 3) return '⏳ requested';
  return '';
}

function encodePickedResult(result) {
  const title = resultTitle(result).replace(/[\r\n:]+/g, ' ').trim();
  return `${result.mediaType}:${result.id}:${title}`.slice(0, 100);
}

function requestResultOptions(results) {
  return (results || []).filter(r => ['movie', 'tv'].includes(r.mediaType) && Number.isFinite(Number(r.id))).slice(0, 20).map(r => {
    const year = resultYear(r);
    const status = resultStatus(r);
    return {
      label: `${mediaEmoji(r.mediaType)} ${resultTitle(r)}${year ? ` (${year})` : ''}`.slice(0, 100),
      description: `${r.mediaType === 'tv' ? 'TV series' : 'Movie'}${status ? ` · ${status}` : ''}`.slice(0, 100),
      value: encodePickedResult(r),
    };
  });
}

function cleanupSessions(now = Date.now()) {
  for (const [nonce, s] of sessions) if (now - s.createdAt > SESSION_TTL_MS) sessions.delete(nonce);
}

function stashSelection(userId, raw) {
  cleanupSessions();
  const nonce = Math.random().toString(36).slice(2, 10);
  sessions.set(nonce, { userId: String(userId), raw: String(raw).slice(0, 100), createdAt: Date.now() });
  return nonce;
}

function takeSelection(nonce, userId) {
  cleanupSessions();
  const row = sessions.get(nonce);
  if (!row || row.userId !== String(userId)) return null;
  sessions.delete(nonce);
  return row.raw;
}

function requestModal() {
  return new ModalBuilder()
    .setCustomId('setup:request_modal')
    .setTitle('Request Media')
    .addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('title')
        .setLabel('Movie or TV show')
        .setPlaceholder('Example: The Last of Us')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMinLength(2)
        .setMaxLength(100),
    ));
}

async function startRequest(interaction) {
  const linked = getUserByDiscordId(interaction.user.id);
  if (!linked) {
    return interaction.reply({
      content: '❌ Your Discord account is not linked yet. Open **Setup / Troubleshooting** first, or ask an admin to finish your access setup.',
      ephemeral: true,
    });
  }
  return interaction.showModal(requestModal());
}

async function searchRequest(interaction) {
  const query = String(interaction.fields.getTextInputValue('title') || '').trim();
  await interaction.deferReply({ ephemeral: true });
  let results;
  try {
    results = await searchSeerr(query, 5000);
  } catch (err) {
    log.warn(`Mobile request search failed: ${err.message}`);
    return interaction.editReply('❌ I could not search Seerr right now. Try again in a moment or use `/request`.');
  }
  const options = requestResultOptions(results);
  if (!options.length) {
    return interaction.editReply({
      embeds: [brandedEmbed(0xf59e0b)
        .setTitle('No Matches Found')
        .setDescription(`I could not find a movie or TV show matching **${query}**. Try a shorter title or include the year.`)],
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('setup:quick:request').setLabel('Search Again').setStyle(ButtonStyle.Primary),
      )],
    });
  }

  const menu = new StringSelectMenuBuilder()
    .setCustomId('setup:request_results')
    .setPlaceholder('Choose the movie or show')
    .addOptions(options);
  return interaction.editReply({
    embeds: [brandedEmbed().setTitle('🎬 Choose What You Want').setDescription(`Search results for **${query}**. Pick the correct title below.`)],
    components: [new ActionRowBuilder().addComponents(menu)],
  });
}

async function pickRequest(interaction) {
  const raw = String(interaction.values?.[0] || '');
  const match = raw.match(/^(movie|tv):(\d+):(.+)$/);
  if (!match) return interaction.reply({ content: 'That result is no longer valid. Tap **Request Media** and search again.', ephemeral: true });
  const [, mediaType, , title] = match;
  const nonce = stashSelection(interaction.user.id, raw);
  const description = mediaType === 'tv'
    ? `**${title}**\n\nChoose the quality. TV requests include all available seasons.`
    : `**${title}**\n\nChoose the quality.`;
  return interaction.update({
    embeds: [brandedEmbed().setTitle(`${mediaEmoji(mediaType)} Confirm Request`).setDescription(description)],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`setup:request_confirm:${nonce}:hd`).setLabel('Request HD / 1080p').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`setup:request_confirm:${nonce}:4k`).setLabel('Request 4K').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('setup:quick:request').setLabel('Search Again').setStyle(ButtonStyle.Secondary),
    )],
  });
}

// Make a real ButtonInteraction look like the normal /request ChatInputCommand to the downstream
// listener. Methods such as deferReply/editReply remain bound to the ORIGINAL button interaction,
// so Discord receives a valid acknowledgement while index.js executes its existing request code.
function requestInteractionProxy(interaction, raw, is4k) {
  const options = {
    getString: name => name === 'title' ? raw : null,
    getBoolean: name => name === 'is4k' ? !!is4k : null,
  };
  return new Proxy(interaction, {
    get(target, prop, receiver) {
      if (prop === 'commandName') return 'request';
      if (prop === 'options') return options;
      if (prop === 'isChatInputCommand') return () => true;
      if (prop === 'isButton' || prop === 'isModalSubmit' || prop === 'isStringSelectMenu' || prop === 'isAutocomplete') return () => false;
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function owns(interaction) {
  if (interaction?.isButton?.()) {
    const id = String(interaction.customId || '');
    return id === 'setup:quick:request' || id.startsWith('setup:request_confirm:');
  }
  if (interaction?.isModalSubmit?.()) return interaction.customId === 'setup:request_modal';
  if (interaction?.isStringSelectMenu?.()) return interaction.customId === 'setup:request_results';
  return false;
}

function installSetupRequestUi() {
  if (globalThis[INSTALL_MARK]) return;
  globalThis[INSTALL_MARK] = true;
  const downstreamEmit = Client.prototype.emit;
  if (downstreamEmit.__durantRequestUiWrapped) return;

  function wrappedEmit(event, ...args) {
    const interaction = args[0];
    if (event !== 'interactionCreate' || !owns(interaction)) return downstreamEmit.call(this, event, ...args);

    if (interaction.isButton?.() && interaction.customId === 'setup:quick:request') {
      Promise.resolve(startRequest(interaction)).catch(err => log.error(`Request wizard start failed: ${err.stack || err.message}`));
      return true;
    }
    if (interaction.isModalSubmit?.() && interaction.customId === 'setup:request_modal') {
      Promise.resolve(searchRequest(interaction)).catch(err => log.error(`Request wizard search failed: ${err.stack || err.message}`));
      return true;
    }
    if (interaction.isStringSelectMenu?.() && interaction.customId === 'setup:request_results') {
      Promise.resolve(pickRequest(interaction)).catch(err => log.error(`Request wizard pick failed: ${err.stack || err.message}`));
      return true;
    }
    if (interaction.isButton?.() && String(interaction.customId || '').startsWith('setup:request_confirm:')) {
      const [, , nonce, quality] = String(interaction.customId).split(':');
      const raw = takeSelection(nonce, interaction.user.id);
      if (!raw) {
        Promise.resolve(interaction.reply({ content: '⏳ That request screen expired. Tap **Request Media** and search again.', ephemeral: true })).catch(() => {});
        return true;
      }
      // Send the proxy THROUGH the wrapped layers beneath us. The normal index.js /request handler
      // is the only code that actually creates/gates the request.
      return downstreamEmit.call(this, 'interactionCreate', requestInteractionProxy(interaction, raw, quality === '4k'));
    }
    return downstreamEmit.call(this, event, ...args);
  }
  wrappedEmit.__durantRequestUiWrapped = true;
  Client.prototype.emit = wrappedEmit;
}

module.exports = {
  installSetupRequestUi,
  requestModal,
  requestResultOptions,
  encodePickedResult,
  requestInteractionProxy,
  stashSelection,
  takeSelection,
};
