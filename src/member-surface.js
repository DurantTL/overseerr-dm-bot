'use strict';

// Member self-service surface: lets the /member dashboard run the exact same slash-command
// handlers the Discord bot uses, instead of reimplementing their logic. A minimal fake
// "interaction" captures whatever the handler replies with; the captured Discord-flavored
// reply (markdown strings, embeds, link buttons) is then converted to HTML for the page.
//
// Handlers stay the single source of truth for business logic — rate limits, duplicate
// detection, quotas, audits, and DMs all behave identically whether the member tapped the
// command in Discord or submitted the form on the dashboard.

const { ButtonStyle } = require('discord.js');

function formatDiscordTimestamp(epochSeconds) {
  const d = new Date(Number(epochSeconds) * 1000);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

// Small Discord-flavor markdown subset actually used by the member handlers:
// **bold**, *italic*, __underline__, ~~strike~~, `code`, <t:...> timestamps,
// <@id> mentions, <#id> channels, <@&id> roles, newlines.
function discordMarkdownToHtml(text, escapeHtml) {
  // Pull out the <...> constructs and `code` spans before escaping — escapeHtml would mangle
  // the angle brackets, and markdown inside code spans must not be interpreted.
  const pulled = [];
  const pull = html => {
    pulled.push(html);
    return `%%PULLED${pulled.length - 1}%%`;
  };
  let raw = String(text ?? '');
  raw = raw.replace(/<t:(\d+)(?::[tTdDfFR])?>/g, (_m, ts) => pull(escapeHtml(formatDiscordTimestamp(ts))));
  raw = raw.replace(/<@(\d+)>/g, () => pull('you'));
  raw = raw.replace(/<@&(\d+)>/g, () => pull('@role'));
  raw = raw.replace(/<#(\d+)>/g, () => pull('#channel'));
  raw = raw.replace(/`([^`\n]+)`/g, (_m, code) => pull(`<code>${escapeHtml(code)}</code>`));

  let html = escapeHtml(raw);
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/(^|\W)\*([^*\n]+)\*/g, '$1<em>$2</em>');
  html = html.replace(/__([^_\n]+)__/g, '<u>$1</u>');
  html = html.replace(/~~([^~\n]+)~~/g, '<s>$1</s>');
  html = html.replace(/\n/g, '<br>');
  html = html.replace(/%%PULLED(\d+)%%/g, (_m, i) => pulled[Number(i)]);
  return html;
}

function embedToHtml(embed, escapeHtml) {
  const data = (embed && embed.data) || embed || {};
  const parts = ['<div class="member-result-embed">'];
  if (data.title) parts.push(`<h3>${escapeHtml(String(data.title))}</h3>`);
  if (data.description) parts.push(`<div class="member-result-desc">${discordMarkdownToHtml(data.description, escapeHtml)}</div>`);
  const fields = Array.isArray(data.fields) ? data.fields : [];
  if (fields.length) {
    parts.push('<dl class="member-result-fields">');
    for (const field of fields) {
      parts.push(`<div class="member-result-field${field.inline ? ' inline' : ''}"><dt>${escapeHtml(String(field.name ?? ''))}</dt><dd>${discordMarkdownToHtml(field.value ?? '', escapeHtml)}</dd></div>`);
    }
    parts.push('</dl>');
  }
  if (data.footer && data.footer.text) parts.push(`<p class="muted">${escapeHtml(String(data.footer.text))}</p>`);
  parts.push('</div>');
  return parts.join('');
}

function componentsToHtml(components, escapeHtml) {
  const links = [];
  for (const row of components || []) {
    for (const button of row?.components || []) {
      const data = button?.data || {};
      // Only Link buttons survive the trip to the dashboard — custom-id buttons are Discord
      // interactions (approve/deny, retries) that live in Discord, not here.
      if (data.style === ButtonStyle.Link && data.url) {
        links.push(`<a class="btn primary" href="${escapeHtml(String(data.url))}">${escapeHtml(String(data.label || 'Open'))}</a>`);
      }
    }
  }
  return links.length ? `<div class="actions">${links.join('')}</div>` : '';
}

// A captured reply payload (string or { content, embeds, components }) → HTML.
function memberReplyToHtml(payload, escapeHtml) {
  const normalized = typeof payload === 'string' ? { content: payload } : (payload || {});
  const parts = [];
  if (normalized.content) {
    parts.push(`<div class="member-result-text">${discordMarkdownToHtml(normalized.content, escapeHtml)}</div>`);
  }
  for (const embed of normalized.embeds || []) {
    parts.push(embedToHtml(embed, escapeHtml));
  }
  const actions = componentsToHtml(normalized.components, escapeHtml);
  if (actions) parts.push(actions);
  return parts.join('');
}

// The fake interaction. Covers exactly the surface the member-facing handlers use:
// user.id, memberPermissions.has(), options.getString/getBoolean/getInteger/getNumber,
// deferReply, reply, editReply (+followUp as a safety net that also captures).
function createMemberInteraction({ discordId, options = {} }) {
  const replies = [];
  const capture = kind => async payload => {
    replies.push({ kind, payload: typeof payload === 'string' ? { content: payload } : (payload || {}) });
    return {};
  };
  const readOption = name => {
    const value = options[name];
    return value === undefined ? null : value;
  };
  const interaction = {
    user: { id: String(discordId), username: 'member' },
    // Dashboard members act as themselves; admin-only branches stay gated on the admin's own
    // Discord identity (isAdminInteraction also checks CONFIG.ADMIN_USER_ID against user.id).
    memberPermissions: { has: () => false },
    options: {
      getString: readOption,
      getBoolean: readOption,
      getInteger: readOption,
      getNumber: readOption,
      getUser: () => null,
    },
    deferReply: async () => {},
    reply: capture('reply'),
    editReply: capture('edit'),
    followUp: capture('followUp'),
  };
  return { interaction, replies };
}

// Run a slash-command handler as a member and return the terminal reply as HTML.
// The terminal reply is the last captured one — handlers end with exactly one.
async function runMemberCommand(handler, { discordId, options = {}, escapeHtml }) {
  const { interaction, replies } = createMemberInteraction({ discordId, options });
  await handler(interaction);
  const terminal = replies[replies.length - 1];
  if (!terminal) return '<p class="muted">No response.</p>';
  return memberReplyToHtml(terminal.payload, escapeHtml);
}

module.exports = {
  createMemberInteraction,
  runMemberCommand,
  memberReplyToHtml,
  discordMarkdownToHtml,
};
