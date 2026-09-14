'use strict';

// Durable support-case lifecycle for the Media Center's Report/Support/Remove flows (issue #256).
// Discord-facing module owning its own builders, dependency-injected like src/media-panel.js so
// it can be exercised in tests without a live Discord client. src/db.js owns persistence and the
// audit trail; this module owns presentation (embeds/components/replies) and authorization.

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

const CATEGORY_LABELS = {
  remove: ['🗑️ Removal / Cancellation Requested', 0xef4444],
  report: ['⚠️ Playback Problem Reported', 0xf59e0b],
  support: ['🛟 Media Support Requested', 0x3b82f6],
};

const STATUS_LABELS = {
  open: '🟡 Open',
  acknowledged: '🔵 Acknowledged',
  resolved: '✅ Resolved',
};

const casesCommand = new SlashCommandBuilder()
  .setName('cases')
  .setDescription('List support cases from the Media Center (admin)')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addStringOption(o => o.setName('status').setDescription('Filter by status').addChoices(
    { name: 'open', value: 'open' },
    { name: 'acknowledged', value: 'acknowledged' },
    { name: 'resolved', value: 'resolved' },
    { name: 'mine', value: 'mine' },
  ));

const myCasesCommand = new SlashCommandBuilder()
  .setName('mycases')
  .setDescription('Show the status of your support cases (reports, support requests, removals)');

function isAdmin(interaction, config) {
  return interaction.memberPermissions?.has?.(PermissionFlagsBits.Administrator)
    || String(interaction.user?.id || '') === String(config.ADMIN_USER_ID || '');
}

function statusLine(row) {
  return STATUS_LABELS[row.status] || row.status;
}

function caseSummaryLine(row) {
  const media = row.media_title ? ` — ${row.media_title}` : '';
  const owner = row.owner_discord_id ? `owner: <@${row.owner_discord_id}>` : 'unowned';
  return `**${row.reference_id}** · ${statusLine(row)} · ${row.category}${media}\n> from <@${row.requester_discord_id}> · ${owner}`;
}

function myCaseSummaryLine(row) {
  const media = row.media_title ? ` — ${row.media_title}` : '';
  const lines = [`**${row.reference_id}** · ${statusLine(row)} · ${row.category}${media}`];
  if (row.status === 'resolved') {
    lines.push(`> ${row.resolution_note ? row.resolution_note.slice(0, 300) : 'Marked resolved.'}`);
  }
  return lines.join('\n');
}

function brandedEmbed(color = 0xe5a00d) {
  return new EmbedBuilder().setColor(color).setFooter({ text: 'Durant Media Server' }).setTimestamp();
}

// Buttons stay actionable through every status so an admin never has to hunt for a case in a
// different message to correct a mistaken resolve/assign — reopen is always available once
// resolved, ack/resolve are always available before that.
function caseComponents(row) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`case:assign:${row.id}`).setLabel('Assign to me').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`case:ack:${row.id}`).setLabel('Acknowledge').setStyle(ButtonStyle.Primary).setDisabled(row.status !== 'open'),
    new ButtonBuilder().setCustomId(`case:resolve:${row.id}`).setLabel('Resolve').setStyle(ButtonStyle.Success).setDisabled(row.status === 'resolved'),
    new ButtonBuilder().setCustomId(`case:reopen:${row.id}`).setLabel('Reopen').setStyle(ButtonStyle.Danger).setDisabled(row.status !== 'resolved'),
  )];
}

function buildAdminCaseMessage(row, kind, sourceChannelId) {
  const [heading, color] = CATEGORY_LABELS[kind] || CATEGORY_LABELS.support;
  const embed = brandedEmbed(color)
    .setTitle(heading)
    .setDescription(`From <@${row.requester_discord_id}> · Case **${row.reference_id}**`)
    .addFields(
      ...(row.media_title ? [{ name: 'Media', value: String(row.media_title).slice(0, 1024), inline: false }] : []),
      { name: 'Details', value: String(row.details).slice(0, 1024), inline: false },
      { name: 'Status', value: statusLine(row), inline: true },
      { name: 'Owner', value: row.owner_discord_id ? `<@${row.owner_discord_id}>` : 'Unassigned', inline: true },
      ...(sourceChannelId ? [{ name: 'Source', value: `<#${sourceChannelId}>`, inline: false }] : []),
    );
  return { embeds: [embed], components: caseComponents(row) };
}

function resolveModal(caseId) {
  const modal = new ModalBuilder().setCustomId(`case:resolve_modal:${caseId}`).setTitle('Resolve Case');
  modal.addComponents(new ActionRowBuilder().addComponents(
    new TextInputBuilder()
      .setCustomId('note')
      .setLabel('Resolution note (sent to the member)')
      .setPlaceholder('What did you do / what should they know?')
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true)
      .setMaxLength(1000),
  ));
  return modal;
}

function reopenModal(caseId) {
  const modal = new ModalBuilder().setCustomId(`case:reopen_modal:${caseId}`).setTitle('Reopen Case');
  modal.addComponents(new ActionRowBuilder().addComponents(
    new TextInputBuilder()
      .setCustomId('reason')
      .setLabel('Why is this being reopened?')
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true)
      .setMaxLength(500),
  ));
  return modal;
}

// Submits a member's Report/Support/Remove modal as a durable case, notifies the admin channel
// (retry-safe: failures are recorded on the case rather than dropped), and replies to the member
// with a reference ID they can track later — the single entry point src/media-panel.js delegates
// to instead of posting a one-off, un-tracked Discord message.
async function submitSupportCase(interaction, kind, { config, createCase, recordNotifyResult, audit, log }) {
  await interaction.deferReply({ ephemeral: true });
  const title = ['remove', 'report'].includes(kind) ? String(interaction.fields.getTextInputValue('title') || '').trim() : '';
  const details = String(interaction.fields.getTextInputValue('details') || '').trim();

  const { case: caseRow, duplicate } = createCase({
    requesterDiscordId: interaction.user.id,
    category: kind,
    mediaTitle: title || null,
    details,
  });

  let sent = caseRow.notify_status === 'sent';
  if (!sent) {
    let channelId = null;
    let messageId = null;
    try {
      const channel = config.ADMIN_CHANNEL_ID ? await interaction.client.channels.fetch(config.ADMIN_CHANNEL_ID) : null;
      if (channel?.isTextBased?.()) {
        const { embeds, components } = buildAdminCaseMessage(caseRow, kind, interaction.channelId);
        const message = await channel.send({ embeds, components });
        sent = true;
        channelId = channel.id;
        messageId = message.id;
      }
    } catch (err) {
      log.warn(`Support case ${kind} notification failed: ${err.message}`);
    }
    recordNotifyResult(caseRow.id, { channelId, messageId, ok: sent });
  }

  audit(`media_panel_${kind}_requested`, {
    actorDiscordId: interaction.user.id,
    title: title || null,
    notified: sent,
    referenceId: caseRow.reference_id,
    duplicate,
  });

  if (!sent) {
    return interaction.editReply(`⚠️ I could not reach the media admin channel, but your request was saved as **${caseRow.reference_id}**. An admin can find and retry it with \`/cases\`, or contact one directly.`);
  }
  const base = kind === 'remove'
    ? `✅ Your removal/cancellation request was sent to the media admins as **${caseRow.reference_id}**. Nothing was deleted automatically.`
    : kind === 'report'
      ? `✅ Your playback problem was sent to the media admins as **${caseRow.reference_id}**.`
      : `✅ Your support request was sent to the media admins as **${caseRow.reference_id}**.`;
  return interaction.editReply(`${base} Track it anytime with \`/mycases\`.`);
}

function owns(interaction) {
  if (interaction?.isChatInputCommand?.() && ['cases', 'mycases'].includes(interaction.commandName)) return true;
  if (interaction?.isButton?.()) return /^case:(assign|ack|resolve|reopen):\d+$/.test(String(interaction.customId || ''));
  if (interaction?.isModalSubmit?.()) return /^case:(resolve|reopen)_modal:\d+$/.test(String(interaction.customId || ''));
  return false;
}

function createSupportCaseFeature(deps) {
  const {
    config,
    createCase,
    getCaseById,
    listCases,
    listCasesForRequester,
    listCasesNeedingNotifyRetry,
    recordNotifyResult,
    recordMemberNotifyResult,
    assignCase,
    acknowledgeCase,
    resolveCase,
    reopenCase,
    audit,
    log,
  } = deps || {};
  for (const [name, fn] of Object.entries({
    config, createCase, getCaseById, listCases, listCasesForRequester, listCasesNeedingNotifyRetry,
    recordNotifyResult, recordMemberNotifyResult, assignCase, acknowledgeCase, resolveCase, reopenCase, audit, log,
  })) {
    if (!fn) throw new TypeError(`Support case dependency "${name}" is required`);
  }

  async function requireAdmin(interaction) {
    if (isAdmin(interaction, config)) return true;
    await interaction.reply({ content: '❌ Administrator permission is required.', ephemeral: true });
    return false;
  }

  // A resolved case's note reaches the requester by DM; delivery failure is recorded on the case
  // (member_notify_status) rather than retried inline here — the requester can always see the note
  // via /mycases even if the DM never lands, satisfying "status survives even if a DM fails".
  async function notifyRequesterOfResolution(client, caseRow) {
    try {
      const user = await client.users.fetch(caseRow.requester_discord_id);
      await user.send({ embeds: [brandedEmbed(0x22c55e)
        .setTitle('✅ Your support case was resolved')
        .setDescription(`Case **${caseRow.reference_id}** (${caseRow.category}) has been marked resolved.`)
        .addFields({ name: 'Note', value: (caseRow.resolution_note || 'No note was left.').slice(0, 1024) })] });
      recordMemberNotifyResult(caseRow.id, true);
      return true;
    } catch (err) {
      log.warn(`Support case ${caseRow.reference_id} resolution DM failed: ${err.message}`);
      recordMemberNotifyResult(caseRow.id, false);
      return false;
    }
  }

  async function refreshSourceMessage(interaction, caseRow) {
    if (!interaction.message) return;
    const kind = caseRow.category;
    const { embeds, components } = buildAdminCaseMessage(caseRow, kind);
    try { await interaction.message.edit({ embeds, components }); } catch (err) { log.warn(`Support case message refresh failed: ${err.message}`); }
  }

  async function handleButton(interaction) {
    const match = String(interaction.customId).match(/^case:(assign|ack|resolve|reopen):(\d+)$/);
    if (!match) return false;
    if (!(await requireAdmin(interaction))) return true;
    const [, action, idStr] = match;
    const id = Number(idStr);
    const existing = getCaseById(id);
    if (!existing) {
      await interaction.reply({ content: '❌ That case no longer exists.', ephemeral: true });
      return true;
    }

    if (action === 'assign') {
      const row = assignCase(id, interaction.user.id, interaction.user.id);
      await interaction.deferUpdate();
      await refreshSourceMessage(interaction, row);
      return true;
    }
    if (action === 'ack') {
      const row = acknowledgeCase(id, interaction.user.id);
      await interaction.deferUpdate();
      await refreshSourceMessage(interaction, row);
      return true;
    }
    if (action === 'resolve') {
      await interaction.showModal(resolveModal(id));
      return true;
    }
    if (action === 'reopen') {
      await interaction.showModal(reopenModal(id));
      return true;
    }
    return false;
  }

  async function handleModal(interaction) {
    const resolveMatch = String(interaction.customId).match(/^case:resolve_modal:(\d+)$/);
    const reopenMatch = String(interaction.customId).match(/^case:reopen_modal:(\d+)$/);
    if (!resolveMatch && !reopenMatch) return false;
    if (!(await requireAdmin(interaction))) return true;

    if (resolveMatch) {
      const id = Number(resolveMatch[1]);
      const note = String(interaction.fields.getTextInputValue('note') || '').trim();
      await interaction.deferReply({ ephemeral: true });
      const row = resolveCase(id, interaction.user.id, note);
      if (!row) { await interaction.editReply('❌ That case no longer exists.'); return true; }
      const memberNotified = await notifyRequesterOfResolution(interaction.client, row);
      if (interaction.message) await refreshSourceMessage(interaction, row);
      await interaction.editReply(`✅ Case **${row.reference_id}** marked resolved${memberNotified ? ' and the member was notified.' : ' — the member could not be DMed, but the note is saved and visible via /mycases.'}`);
      return true;
    }

    const id = Number(reopenMatch[1]);
    const reason = String(interaction.fields.getTextInputValue('reason') || '').trim();
    await interaction.deferReply({ ephemeral: true });
    const row = reopenCase(id, interaction.user.id, reason);
    if (!row) { await interaction.editReply('❌ That case no longer exists.'); return true; }
    if (interaction.message) await refreshSourceMessage(interaction, row);
    await interaction.editReply(`🔁 Case **${row.reference_id}** reopened.`);
    return true;
  }

  async function handleCasesCommand(interaction) {
    if (!(await requireAdmin(interaction))) return true;
    await interaction.deferReply({ ephemeral: true });
    for (const pending of listCasesNeedingNotifyRetry(5)) {
      try {
        const channel = config.ADMIN_CHANNEL_ID ? await interaction.client.channels.fetch(config.ADMIN_CHANNEL_ID) : null;
        if (channel?.isTextBased?.()) {
          const { embeds, components } = buildAdminCaseMessage(pending, pending.category);
          const message = await channel.send({ embeds, components });
          recordNotifyResult(pending.id, { channelId: channel.id, messageId: message.id, ok: true });
        } else {
          recordNotifyResult(pending.id, { ok: false });
        }
      } catch (_err) {
        recordNotifyResult(pending.id, { ok: false });
      }
    }

    const statusOpt = interaction.options.getString('status');
    const rows = statusOpt === 'mine'
      ? listCases({ ownerDiscordId: interaction.user.id, limit: 20 })
      : listCases({ status: statusOpt || 'open', limit: 20 });
    await interaction.editReply(rows.length ? rows.map(caseSummaryLine).join('\n\n').slice(0, 1900) : `No ${statusOpt || 'open'} cases.`);
    return true;
  }

  async function handleMyCasesCommand(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const rows = listCasesForRequester(interaction.user.id, { limit: 10 });
    await interaction.editReply(rows.length
      ? rows.map(myCaseSummaryLine).join('\n\n').slice(0, 1900)
      : 'You have no support cases yet. Use the Media Center panel\'s Report/Support/Remove buttons to open one.');
    return true;
  }

  async function handleInteraction(interaction) {
    if (interaction.isChatInputCommand?.()) {
      if (interaction.commandName === 'cases') return handleCasesCommand(interaction);
      if (interaction.commandName === 'mycases') return handleMyCasesCommand(interaction);
      return false;
    }
    if (interaction.isButton?.()) return handleButton(interaction);
    if (interaction.isModalSubmit?.()) return handleModal(interaction);
    return false;
  }

  return { commands: [casesCommand, myCasesCommand], handleInteraction, owns };
}

module.exports = {
  createSupportCaseFeature,
  submitSupportCase,
  buildAdminCaseMessage,
  caseComponents,
  caseSummaryLine,
  myCaseSummaryLine,
  statusLine,
  isAdmin,
  owns,
  casesCommand,
  myCasesCommand,
  resolveModal,
  reopenModal,
};
