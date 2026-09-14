'use strict';

// Mobile-first request wizard. Discord buttons cannot execute slash commands directly, so this
// layer collects a title, searches Seerr, lets the member pick a result, then forwards a proxy
// interaction into the bot's EXISTING /request handler. That preserves quotas, duplicate checks,
// approval gating, trust/auto-approval, subscriptions, and audit behavior in one place.

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');

const { ALL_SEASONS, formatSeasonsLabel } = require('./season-select');

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

// #255: `seasonsRaw` is optional. Omitting it (the original 2-arg call, still used for the
// movie path and the first TV step before a season is chosen) keeps takeSelection returning the
// bare raw string exactly as before; passing it makes takeSelection return { raw, seasonsRaw }
// instead, once a season choice exists to carry.
function stashSelection(userId, raw, seasonsRaw) {
  cleanupSessions();
  const nonce = Math.random().toString(36).slice(2, 10);
  sessions.set(nonce, {
    userId: String(userId),
    raw: String(raw).slice(0, 100),
    seasonsRaw: seasonsRaw === undefined ? undefined : String(seasonsRaw).slice(0, 100),
    createdAt: Date.now(),
  });
  return nonce;
}

function takeSelection(nonce, userId) {
  cleanupSessions();
  const row = sessions.get(nonce);
  if (!row || row.userId !== String(userId)) return null;
  sessions.delete(nonce);
  return row.seasonsRaw === undefined ? row.raw : { raw: row.raw, seasonsRaw: row.seasonsRaw };
}

// Discord select menus cap at 25 options. "All Seasons" always gets a slot; eligible season
// numbers fill the rest, so a show with more seasons than that still degrades gracefully instead
// of erroring (the /request slash command remains available for picking a season past the cap).
function seasonSelectOptions(eligibleSeasons) {
  const options = [{ label: '🌟 All Seasons', description: 'Request every available season', value: ALL_SEASONS }];
  for (const n of eligibleSeasons.slice(0, 24)) {
    options.push({ label: `Season ${n}`, value: `season:${n}` });
  }
  return options;
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

// Make a real ButtonInteraction look like the normal /request ChatInputCommand to the downstream
// listener. Methods such as deferReply/editReply remain bound to the ORIGINAL button interaction,
// so Discord receives a valid acknowledgement while index.js executes its existing request code.
function requestInteractionProxy(interaction, raw, is4k, seasonsRaw) {
  const options = {
    getString: name => {
      if (name === 'title') return raw;
      if (name === 'seasons') return seasonsRaw ?? null;
      return null;
    },
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
  if (interaction?.isStringSelectMenu?.()) {
    const id = String(interaction.customId || '');
    return id === 'setup:request_results' || id.startsWith('setup:request_seasons:');
  }
  return false;
}

// Explicit button/modal/select handler registration with dependency injection, matching the
// pattern src/media-panel.js established: no Discord prototype patching here at all — index.js
// calls handleInteraction directly from its own interactionCreate listener.
function createSetupRequestUiFeature({ getUserByDiscordId, searchSeerr, fetchSeerrTvSeasonInfo, log, forwardSlashCommand }) {
  if (!getUserByDiscordId || !searchSeerr || !fetchSeerrTvSeasonInfo || !log || !forwardSlashCommand) {
    throw new TypeError('Setup request UI dependencies are required');
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

  // Quality-confirm step, shared by the movie path and the end of the TV season-picker path below.
  function confirmQualityStep(interaction, nonce, mediaType, title, seasonsRaw) {
    const description = seasonsRaw
      ? `**${title}**\n\nSeasons: **${formatSeasonsLabel(seasonsRaw === ALL_SEASONS ? ALL_SEASONS : seasonsRaw.split(',').map(Number))}**\n\nChoose the quality.`
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

  async function pickRequest(interaction) {
    const raw = String(interaction.values?.[0] || '');
    const match = raw.match(/^(movie|tv):(\d+):(.+)$/);
    if (!match) return interaction.reply({ content: 'That result is no longer valid. Tap **Request Media** and search again.', ephemeral: true });
    const [, mediaType, tmdbIdRaw, title] = match;

    // Movies never had a season concept and still don't — straight to the quality step (#255:
    // "Movie requests must be unchanged").
    if (mediaType !== 'tv') {
      const nonce = stashSelection(interaction.user.id, raw);
      return confirmQualityStep(interaction, nonce, mediaType, title, null);
    }

    // TV: offer an explicit season choice instead of silently requesting everything. The nonce
    // carries only `raw` at this point (no seasonsRaw yet) — takeSelection below returns the bare
    // string, matching the pre-#255 shape.
    const nonce = stashSelection(interaction.user.id, raw);
    const info = await fetchSeerrTvSeasonInfo(Number(tmdbIdRaw), false).catch(() => ({ eligible: [] }));
    if (!info.eligible.length) {
      // Seerr didn't answer, or genuinely has no season data yet — fail open to the pre-#255
      // behavior (request everything) rather than block the wizard on a Seerr hiccup.
      return confirmQualityStep(interaction, nonce, mediaType, title, ALL_SEASONS);
    }
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`setup:request_seasons:${nonce}`)
      .setPlaceholder('Choose one or more seasons, or All Seasons')
      .setMinValues(1)
      .setMaxValues(Math.min(info.eligible.length, 24) + 1)
      .addOptions(seasonSelectOptions(info.eligible));
    return interaction.update({
      embeds: [brandedEmbed().setTitle('📺 Choose Seasons').setDescription(`**${title}**\n\nPick specific season(s), or All Seasons.`)],
      components: [
        new ActionRowBuilder().addComponents(menu),
        new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('setup:quick:request').setLabel('Search Again').setStyle(ButtonStyle.Secondary)),
      ],
    });
  }

  async function pickSeasons(interaction) {
    const nonce = String(interaction.customId).split(':')[2];
    const picked = takeSelection(nonce, interaction.user.id);
    if (!picked || typeof picked !== 'string') {
      return interaction.update({ content: '⏳ That request screen expired. Tap **Request Media** and search again.', embeds: [], components: [] });
    }
    const raw = picked;
    const match = raw.match(/^(movie|tv):(\d+):(.+)$/);
    const [, mediaType, , title] = match || [];
    const values = interaction.values || [];
    // 'all' takes precedence over anything else picked alongside it, rather than erroring — it's
    // the least surprising interpretation of "All Seasons + Season 3" both being checked.
    const seasonsRaw = values.includes(ALL_SEASONS)
      ? ALL_SEASONS
      : values.map(v => v.replace('season:', '')).filter(v => /^\d+$/.test(v)).join(',');
    const newNonce = stashSelection(interaction.user.id, raw, seasonsRaw || ALL_SEASONS);
    return confirmQualityStep(interaction, newNonce, mediaType, title, seasonsRaw || ALL_SEASONS);
  }

  async function confirmRequest(interaction) {
    const [, , nonce, quality] = String(interaction.customId).split(':');
    const picked = takeSelection(nonce, interaction.user.id);
    if (!picked) {
      return interaction.reply({ content: '⏳ That request screen expired. Tap **Request Media** and search again.', ephemeral: true });
    }
    const raw = typeof picked === 'string' ? picked : picked.raw;
    const seasonsRaw = typeof picked === 'string' ? undefined : picked.seasonsRaw;
    // Forward the proxy directly to the same slash-command dispatcher index.js uses for a real
    // /request invocation. That handler is the only code that actually creates/gates the request.
    return forwardSlashCommand(requestInteractionProxy(interaction, raw, quality === '4k', seasonsRaw));
  }

  async function handleInteraction(interaction) {
    if (!owns(interaction)) return false;

    if (interaction.isButton?.() && interaction.customId === 'setup:quick:request') {
      await startRequest(interaction);
      return true;
    }
    if (interaction.isModalSubmit?.() && interaction.customId === 'setup:request_modal') {
      await searchRequest(interaction);
      return true;
    }
    if (interaction.isStringSelectMenu?.() && interaction.customId === 'setup:request_results') {
      await pickRequest(interaction);
      return true;
    }
    if (interaction.isStringSelectMenu?.() && String(interaction.customId || '').startsWith('setup:request_seasons:')) {
      await pickSeasons(interaction);
      return true;
    }
    if (interaction.isButton?.() && String(interaction.customId || '').startsWith('setup:request_confirm:')) {
      await confirmRequest(interaction);
      return true;
    }
    return false;
  }

  return { handleInteraction, owns, requestModal };
}

module.exports = {
  createSetupRequestUiFeature,
  requestModal,
  requestResultOptions,
  encodePickedResult,
  requestInteractionProxy,
  stashSelection,
  takeSelection,
  seasonSelectOptions,
  owns,
};
