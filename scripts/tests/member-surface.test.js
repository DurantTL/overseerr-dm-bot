#!/usr/bin/env node
'use strict';

// Unit tests for the member-surface adapter: the fake Discord interaction and the
// Discord-reply → HTML conversion used by the /member dashboard.

const { test } = require('node:test');
const assert = require('node:assert');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const {
  createMemberInteraction,
  runMemberCommand,
  memberReplyToHtml,
  discordMarkdownToHtml,
} = require('../../src/member-surface');
const { escapeHtml } = require('../../src/dashboard-render');

test('createMemberInteraction captures reply/editReply and reads options like discord.js', async () => {
  const { interaction, replies } = createMemberInteraction({
    discordId: '123',
    options: { title: 'movie:42:Dune', is4k: true },
  });
  assert.strictEqual(interaction.user.id, '123');
  assert.strictEqual(interaction.options.getString('title'), 'movie:42:Dune');
  assert.strictEqual(interaction.options.getBoolean('is4k'), true);
  assert.strictEqual(interaction.options.getString('missing'), null);
  assert.strictEqual(interaction.options.getInteger('missing'), null);
  assert.strictEqual(interaction.memberPermissions.has('Administrator'), false);

  await interaction.deferReply({ ephemeral: true });
  assert.strictEqual(replies.length, 0, 'deferReply captures nothing');
  await interaction.reply('first');
  await interaction.editReply({ content: 'second' });
  assert.strictEqual(replies.length, 2);
  assert.deepStrictEqual(replies[0], { kind: 'reply', payload: { content: 'first' } });
  assert.deepStrictEqual(replies[1], { kind: 'edit', payload: { content: 'second' } });
});

test('discordMarkdownToHtml converts the handler markdown subset and escapes HTML', () => {
  const html = discordMarkdownToHtml('**bold** and *italic* and `code`\n<script>alert(1)</script>', escapeHtml);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<em>italic<\/em>/);
  assert.match(html, /<code>code<\/code>/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /<br>/);
});

test('discordMarkdownToHtml converts timestamps and mentions', () => {
  const html = discordMarkdownToHtml('expires <t:1893456000:R> for <@123> in <#456>', escapeHtml);
  assert.doesNotMatch(html, /<t:/);
  assert.doesNotMatch(html, /<@/);
  assert.match(html, /for you in #channel/);
});

test('memberReplyToHtml renders embeds, fields, and link buttons', () => {
  const embed = new EmbedBuilder()
    .setTitle('📥 Download Ready')
    .setDescription('**Dune** (2021)')
    .addFields(
      { name: 'Expires', value: '<t:1893456000:R>', inline: true },
      { name: 'Link type', value: '🔒 One-time use', inline: true },
    )
    .setFooter({ text: 'Durant Media Server' });
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setLabel('Download').setStyle(ButtonStyle.Link).setURL('https://example.test/download/abc'),
    new ButtonBuilder().setCustomId('noop').setLabel('Ignore me').setStyle(ButtonStyle.Secondary),
  );
  const html = memberReplyToHtml({ embeds: [embed], components: [row] }, escapeHtml);
  assert.match(html, /Download Ready/);
  assert.match(html, /<strong>Dune<\/strong> \(2021\)/);
  assert.match(html, /Expires/);
  assert.match(html, /<a class="btn primary" href="https:\/\/example\.test\/download\/abc">Download<\/a>/);
  assert.doesNotMatch(html, /Ignore me/, 'custom-id buttons do not survive the trip to the dashboard');
});

test('runMemberCommand returns the terminal reply as HTML', async () => {
  async function stubHandler(interaction) {
    const row = { discord_id: '1' };
    if (!row) return interaction.reply('nope');
    await interaction.deferReply({ ephemeral: true });
    await interaction.editReply(`✅ Requested **${interaction.options.getString('title')}**`);
  }
  const html = await runMemberCommand(stubHandler, { discordId: '123', options: { title: 'Dune' }, escapeHtml });
  assert.match(html, /✅ Requested <strong>Dune<\/strong>/);
});

test('runMemberCommand handles a handler that never replies', async () => {
  const html = await runMemberCommand(async () => {}, { discordId: '123', escapeHtml });
  assert.match(html, /No response/);
});
