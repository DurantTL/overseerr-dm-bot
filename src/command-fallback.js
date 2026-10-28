'use strict';

// Command fallback ("the brains"): rescues commands that never became slash commands.
//
// In a real Discord server the failure mode is rarely a mistyped slash command — the
// client's autocomplete prevents most of those. It's a member typing what they *meant*
// as plain text: "/adpot bleach" sent as a normal message (no such command exists, so
// Discord just posts it as text), "rtorrent adopt bleach" with no slash at all, or an
// old command name from memory. Today those messages sit there and nothing happens.
// This feature watches configured channels, resolves the text against the live
// SlashCommandBuilder catalog, and either runs the command or offers a one-tap
// confirmation — so the member gets the thing they asked for and learns the real
// command for next time.
//
// Resolution tiers, cheapest first:
//   1. Exact parse — the text already is a valid command invocation, just typed.
//   2. Fuzzy parse — Damerau-Levenshtein over command/subcommand names, then the
//      same positional/named argument assembly and the SAME validateExecInput the
//      Agent API bridge uses, so a fallback invocation can never smuggle in an
//      option shape the real command would reject.
//   3. LLM parse (optional, env-configured) — an OpenAI-compatible chat endpoint
//      gets the message plus a catalog summary and answers with structured JSON.
//      Its confidence is clamped so an LLM guess ALWAYS needs a human tap.
//
// Safety model (this bot owns destructive commands, so the rails matter):
//   - The dispatched interaction is backed by the REAL message: real author, real
//     member permissions. A member can never fallback-run something their own
//     permissions wouldn't let them slash-run; admin gates inside handlers behave
//     exactly as they do for real interactions.
//   - Credential commands (the CREDENTIAL_ACTIONS register in discord-exec.js) are
//     never run from text — the member is told to use the real slash command.
//   - Only an exact textual parse of a command on the operator's auto-run list
//     executes without confirmation. Everything else needs the original author
//     (or an admin) to press Run within 60 seconds.
//   - Off by default. Nothing happens until an operator sets cmdfb_enabled=1 and
//     lists the channels to watch.
//
// Strict-channel cleanup: in channels listed in cmdfb_strict_channels, a message
// that is NOT a command attempt is chatter in a commands-only channel. Depending on
// cmdfb_cleanup it is reacted to with a pointer, or deleted after DMing the author
// a copy (never for admins, pinned messages, or messages with attachments — a
// delete must never destroy the only copy of a file).
//
// Configuration (app_settings via getSetting, same store as the media panel):
//   cmdfb_enabled         '1' to enable (default off)
//   cmdfb_channels        comma-separated channel IDs to watch for command attempts
//   cmdfb_strict_channels comma-separated channel IDs where chatter cleanup applies
//                         (must also be in cmdfb_channels)
//   cmdfb_cleanup         'off' (default) | 'react' | 'delete'
//   cmdfb_autorun         comma-separated command names safe to run from an exact
//                         textual parse with no confirmation (default: none)
// LLM tier (environment, NOT app_settings — it carries a credential):
//   COMMAND_FALLBACK_LLM_URL    full chat-completions URL of an OpenAI-compatible API
//   COMMAND_FALLBACK_LLM_API_KEY  bearer key for that API (optional for local models)
//   COMMAND_FALLBACK_LLM_MODEL    model name to request

const crypto = require('crypto');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, ApplicationCommandOptionType } = require('discord.js');
const { commandDefsToMetadata, validateExecInput, CREDENTIAL_ACTIONS, DiscordExecError } = require('./discord-exec');

const CONFIRM_MIN_CONFIDENCE = 0.72; // Below this, a text parse is a hint at best.
const FUZZY_FLOOR = 0.5; // A token scoring under this against every name is not a near miss.
const LLM_MAX_CONFIDENCE = 0.9; // LLM resolutions are clamped: a human always confirms.
const CONFIRM_TTL_MS = 60_000;
const USER_COOLDOWN_MS = 4_000;
const HINT_THROTTLE_MS = 10 * 60_000; // Strict-channel pointer, per channel.
const MAX_MESSAGE_CHARS = 500;

// Restricted Damerau-Levenshtein distance: Levenshtein plus one adjacent
// transposition ("adpot" -> "adopt" costs 1, which is the typo people actually make).
function damerauLevenshtein(a, b) {
  const s = String(a);
  const t = String(b);
  const m = s.length;
  const n = t.length;
  if (!m) return n;
  if (!n) return m;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 1; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && s[i - 1] === t[j - 2] && s[i - 2] === t[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[m][n];
}

// 1 = identical, 0 = nothing alike. Short names saturate fast (one edit on a
// 3-letter name is a big change), which is what we want: "hep" -> "help" should
// score lower than "adpot" -> "adopt".
function nameSimilarity(token, name) {
  const a = String(token || '').toLowerCase();
  const b = String(name || '').toLowerCase();
  if (!a || !b) return 0;
  if (a === b) return 1;
  const dist = damerauLevenshtein(a, b);
  return Math.max(0, 1 - dist / Math.max(a.length, b.length));
}

function bestNameMatch(token, names) {
  let best = null;
  for (const name of names || []) {
    const score = nameSimilarity(token, name);
    if (!best || score > best.score) best = { name, score };
  }
  return best;
}

// Split on whitespace, honoring single/double quotes so a search term survives as
// one token: adopt search="bleach thousand year" or adopt "bleach thousand year".
function tokenizeCommandText(text) {
  const tokens = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match;
  while ((match = re.exec(String(text || ''))) !== null) {
    tokens.push(match[1] ?? match[2] ?? match[3]);
  }
  return tokens;
}

const COMMAND_TOKEN_RE = /^[a-z0-9][a-z0-9_-]*$/i;

// Coerce one raw token to an option's declared type. Returns { ok, value } — a
// failed coercion is reported to the member, never silently dropped, because a
// dropped word changes what the command would do.
function coerceOptionValue(meta, raw) {
  const value = String(raw);
  switch (meta.type) {
    case ApplicationCommandOptionType.String:
      return { ok: true, value };
    case ApplicationCommandOptionType.Integer: {
      if (!/^-?\d+$/.test(value.trim())) return { ok: false };
      return { ok: true, value: parseInt(value, 10) };
    }
    case ApplicationCommandOptionType.Number: {
      const num = Number(value);
      return Number.isFinite(num) ? { ok: true, value: num } : { ok: false };
    }
    case ApplicationCommandOptionType.Boolean: {
      const v = value.trim().toLowerCase();
      if (['true', 'yes', 'on', '1'].includes(v)) return { ok: true, value: true };
      if (['false', 'no', 'off', '0'].includes(v)) return { ok: true, value: false };
      return { ok: false };
    }
    case ApplicationCommandOptionType.User: {
      const id = value.replace(/^<@!?(\d+)>$/, '$1');
      return /^\d{5,}$/.test(id) ? { ok: true, value: id } : { ok: false };
    }
    default:
      // Channel/role/mentionable/attachment options can't be expressed in typed
      // text reliably — the bridge validator rejects them downstream as well.
      return { ok: false, unsupported: true };
  }
}

// Assemble { command, subcommand, options } from typed tokens against one command's
// metadata. Named forms (key=value, --key value, --key=value) win; remaining tokens
// fill options positionally in declaration order, and a trailing string option
// absorbs the rest of the line (search terms are multi-word: "adopt bleach
// thousand year blood war" is one search, not five arguments).
function assembleOptions(activeOptions, tokens) {
  const options = {};
  const positional = [];
  const problems = [];
  const byName = new Map((activeOptions || []).map(o => [o.name, o]));

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const named = /^(?:--)?([a-z][a-z0-9_-]*)=(.+)$/i.exec(token) || /^(?:--)([a-z][a-z0-9_-]*)$/i.exec(token);
    if (named && byName.has(named[1].toLowerCase())) {
      const key = named[1].toLowerCase();
      let raw = named[2];
      if (raw == null) {
        raw = tokens[i + 1];
        if (raw == null) { problems.push(`Option "${key}" needs a value`); continue; }
        i++;
      }
      const coerced = coerceOptionValue(byName.get(key), raw);
      if (!coerced.ok) { problems.push(`Option "${key}" couldn't take "${raw}"`); continue; }
      options[key] = coerced.value;
      continue;
    }
    if (/^(?:--)?[a-z][a-z0-9_-]*=/i.test(token)) {
      problems.push(`Unknown option "${token.split('=')[0].replace(/^--/, '')}"`);
      continue;
    }
    positional.push(token);
  }

  const remaining = [...positional];
  const opts = activeOptions || [];

  // Tail-choice pass: a choices-bearing option (adopt's target=sonarr|radarr) is
  // almost always typed LAST when it's typed positionally at all — "adopt bleach
  // sonarr". Peel it off the tail before the main walk so a multi-word string
  // argument in front of it isn't truncated to make room.
  for (const meta of opts) {
    if (!remaining.length) break;
    if (meta.name in options || !meta.choices?.length) continue;
    const last = remaining[remaining.length - 1];
    const hit = meta.choices.find(c => String(c).toLowerCase() === String(last).toLowerCase());
    if (hit != null) {
      options[meta.name] = hit;
      remaining.pop();
    }
  }

  // Main walk, in declaration order. A string option absorbs the rest of the
  // line, holding back one token per later non-string option ("request the dark
  // knight 2008" -> title="the dark knight", year=2008). Non-string options take
  // exactly one token; a failed coercion is a reported problem, not a silent skip.
  for (let idx = 0; idx < opts.length; idx++) {
    if (!remaining.length) break;
    const meta = opts[idx];
    if (meta.name in options) continue;
    if (meta.type === ApplicationCommandOptionType.String && !meta.choices?.length) {
      const laterNonString = opts.slice(idx + 1)
        .filter(o => !(o.name in options) && o.type !== ApplicationCommandOptionType.String)
        .length;
      const take = Math.max(1, remaining.length - laterNonString);
      const coerced = coerceOptionValue(meta, remaining.splice(0, take).join(' '));
      if (coerced.ok) options[meta.name] = coerced.value;
      continue;
    }
    if (meta.choices?.length) {
      // Mid-line choices option: consume only an actual choice token.
      const hit = meta.choices.find(c => String(c).toLowerCase() === String(remaining[0]).toLowerCase());
      if (hit != null) {
        options[meta.name] = hit;
        remaining.shift();
      }
      continue;
    }
    const raw = remaining.shift();
    const coerced = coerceOptionValue(meta, raw);
    if (!coerced.ok) { problems.push(`Option "${meta.name}" couldn't take "${raw}"`); continue; }
    options[meta.name] = coerced.value;
  }

  return { options, ignoredTokens: remaining, problems };
}

// Resolve typed text against the command catalog (metadata form, as produced by
// commandDefsToMetadata). Pure — no Discord objects — so the whole resolver is
// unit-testable with plain-object definitions.
// Returns one of:
//   { kind: 'resolved', command, subcommand, options, confidence, exact }
//   { kind: 'invalid', command, subcommand, options, confidence, problems } — the
//     intent is clear but the invocation is broken; problems say how.
//   { kind: 'none' } — not a command attempt worth acting on.
function resolveCommandText(text, metadatas) {
  const raw = String(text || '').trim();
  if (!raw || raw.length > MAX_MESSAGE_CHARS) return { kind: 'none' };
  const prefixed = raw.startsWith('/') || raw.startsWith('!');
  const tokens = tokenizeCommandText(raw.replace(/^[/!]\s*/, ''));
  if (!tokens.length || !COMMAND_TOKEN_RE.test(tokens[0])) return { kind: 'none' };

  const metas = metadatas || [];
  const cmdToken = tokens[0].toLowerCase();
  const exactCmd = metas.find(m => m.name === cmdToken);
  const cmdMatch = exactCmd ? { name: exactCmd.name, score: 1 } : bestNameMatch(cmdToken, metas.map(m => m.name));
  if (!cmdMatch || cmdMatch.score < FUZZY_FLOOR) return { kind: 'none' };
  const meta = metas.find(m => m.name === cmdMatch.name);

  const subMetas = meta.options.filter(o => o.type === ApplicationCommandOptionType.Subcommand);
  let subcommand = null;
  let subScore = 1;
  let argTokens = tokens.slice(1);

  if (subMetas.length) {
    const subToken = (tokens[1] || '').toLowerCase();
    const exactSub = subMetas.find(s => s.name === subToken);
    const subMatch = exactSub ? { name: exactSub.name, score: 1 } : bestNameMatch(subToken, subMetas.map(s => s.name));
    if (subMatch && subMatch.score >= FUZZY_FLOOR) {
      subcommand = subMatch.name;
      subScore = subMatch.score;
      argTokens = tokens.slice(2);
    }
    // Otherwise the second token is an argument, not a subcommand — leave
    // subcommand null and let validation produce the "requires a subcommand"
    // problem, which is the helpful answer.
  }

  const activeOptions = subcommand
    ? (subMetas.find(s => s.name === subcommand)?.options || [])
    : meta.options.filter(o => o.type !== ApplicationCommandOptionType.Subcommand
      && o.type !== ApplicationCommandOptionType.SubcommandGroup);

  const { options, ignoredTokens, problems } = assembleOptions(activeOptions, argTokens);
  const confidence = subMetas.length && subcommand
    ? 0.55 * cmdMatch.score + 0.45 * subScore
    : cmdMatch.score;
  const exact = cmdMatch.score === 1 && subScore === 1 && !problems.length;

  // Final gate: the bridge validator is the authority on shape (required options,
  // choices, ranges). Its error becomes the member-facing problem.
  try {
    const validated = validateExecInput({ command: meta.name, subcommand, options }, metas);
    if (problems.length) {
      return { kind: 'invalid', command: validated.commandName, subcommand: validated.subcommandName, options: validated.optionValues, confidence, problems, prefixed };
    }
    return { kind: 'resolved', command: validated.commandName, subcommand: validated.subcommandName, options: validated.optionValues, confidence, exact, ignoredTokens, prefixed };
  } catch (err) {
    if (err instanceof DiscordExecError) {
      return { kind: 'invalid', command: meta.name, subcommand, options, confidence, problems: [...problems, err.message], prefixed };
    }
    throw err;
  }
}

// "/rtorrent adopt search=<Bleach> target=sonarr" — the canonical form shown in
// confirmations and hints, so the member sees (and learns) the real command.
function canonicalCommandString({ command, subcommand, options }) {
  const parts = [`/${command}`];
  if (subcommand) parts.push(subcommand);
  for (const [key, value] of Object.entries(options || {})) {
    parts.push(`${key}=<${String(value)}>`);
  }
  return parts.join(' ');
}

function isCredentialCommand(command, subcommand) {
  const key = subcommand ? `${command} ${subcommand}` : command;
  return Boolean(CREDENTIAL_ACTIONS[key] || CREDENTIAL_ACTIONS[command]);
}

// ---------------------------------------------------------------------------
// LLM tier
// ---------------------------------------------------------------------------

// Compact catalog for the prompt: names, descriptions, subcommands, option names.
// Deliberately no option *values* or server state — the model only maps intent.
function catalogSummary(metadatas) {
  return (metadatas || []).map(meta => {
    const subs = meta.options.filter(o => o.type === ApplicationCommandOptionType.Subcommand);
    if (subs.length) {
      return {
        name: meta.name,
        subcommands: subs.map(s => ({ name: s.name, options: (s.options || []).map(o => o.name) })),
      };
    }
    return { name: meta.name, options: meta.options.map(o => o.name) };
  });
}

// Pull the first JSON object out of a model reply (models wrap JSON in prose or
// code fences despite instructions). Returns null when there is no object.
function extractJsonObject(text) {
  const start = String(text || '').indexOf('{');
  const end = String(text || '').lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(String(text).slice(start, end + 1));
  } catch (_err) {
    return null;
  }
}

// Ask the configured OpenAI-compatible endpoint to map a message to a command.
// Returns a resolution shaped like resolveCommandText's, or { kind: 'none' }.
// Any failure (timeout, bad JSON, unknown command) degrades to 'none' — the LLM
// tier is an enhancement, never a dependency.
async function resolveWithLlm(text, metadatas, llm, fetchImpl) {
  const doFetch = fetchImpl || globalThis.fetch;
  if (!llm || !llm.url || typeof doFetch !== 'function') return { kind: 'none' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6_000);
  try {
    const res = await doFetch(llm.url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        ...(llm.apiKey ? { authorization: `Bearer ${llm.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: llm.model || 'gpt-4o-mini',
        temperature: 0,
        messages: [
          {
            role: 'system',
            content: 'You map a Discord member\'s message to a bot command. Reply with ONLY a JSON object: {"command": string, "subcommand": string|null, "options": object, "confidence": number 0..1}. Use only commands, subcommands and option names from the catalog. If the message is not a command request, reply {"command": null}.',
          },
          { role: 'user', content: JSON.stringify({ message: String(text).slice(0, MAX_MESSAGE_CHARS), catalog: catalogSummary(metadatas) }) },
        ],
      }),
    });
    if (!res.ok) return { kind: 'none' };
    const data = await res.json();
    const parsed = extractJsonObject(data?.choices?.[0]?.message?.content);
    if (!parsed || !parsed.command) return { kind: 'none' };
    const options = {};
    for (const [k, v] of Object.entries(parsed.options || {})) options[String(k).toLowerCase()] = v;
    const validated = validateExecInput(
      { command: String(parsed.command).toLowerCase(), subcommand: parsed.subcommand ? String(parsed.subcommand).toLowerCase() : null, options },
      metadatas,
    );
    const confidence = Math.min(LLM_MAX_CONFIDENCE, Math.max(0, Number(parsed.confidence) || 0));
    return { kind: 'resolved', command: validated.commandName, subcommand: validated.subcommandName, options: validated.optionValues, confidence, exact: false, source: 'llm' };
  } catch (_err) {
    return { kind: 'none' };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Message-backed interaction shim
// ---------------------------------------------------------------------------

// The slice of the discord.js interaction API slash handlers use, backed by a
// real guild message instead of the Agent API's capture buffers: replies post to
// the channel, the author is the real member, and memberPermissions are the
// member's real permissions. reply/editReply/followUp are state-tolerant (a
// handler written against real interactions may call them in orders that would
// throw there; here they degrade to "edit what we sent, else send"), because a
// fallback invocation must never die on shim bookkeeping.
//
// A channel post can't be ephemeral, and handlers put private things in ephemeral
// replies (/me shows the member's Plex email, /downloads their links). So an
// ephemeral reply goes to the author's DMs, with a one-line pointer in the
// channel; if their DMs are closed the command fails with a note to use the real
// slash command. A private reply must never land in the channel.
function buildMessageInteraction({ message, commandName, subcommandName, optionValues }) {
  let lastSent = null;
  let privateReply = false; // The handler's reply is ephemeral: it and its edits go to DMs.
  let dmPointerPosted = false;
  const toPayload = payload => {
    const p = typeof payload === 'string' ? { content: payload } : { ...(payload || {}) };
    const ephemeral = Boolean(p.ephemeral);
    delete p.ephemeral;
    return { p, ephemeral };
  };
  const sendPrivately = async p => {
    let dm;
    try {
      dm = await message.author.send(p);
    } catch (err) {
      throw new Error('That reply is private and I couldn\'t DM you — run the real slash command instead.', { cause: err });
    }
    if (!dmPointerPosted) {
      dmPointerPosted = true;
      await message.reply({ content: '📬 Sent you a DM — that one is private.' }).catch(() => {});
    }
    return dm;
  };
  const send = async (p, ephemeral) => {
    lastSent = ephemeral ? await sendPrivately(p) : await message.channel.send(p);
    interaction.replied = true;
    return lastSent;
  };

  const interaction = {
    commandName,
    options: {
      getString: name => (optionValues[name] == null ? null : String(optionValues[name])),
      getInteger: name => (optionValues[name] == null ? null : Number(optionValues[name])),
      getNumber: name => (optionValues[name] == null ? null : Number(optionValues[name])),
      getBoolean: name => (optionValues[name] == null ? null : Boolean(optionValues[name])),
      getUser: name => {
        const v = optionValues[name];
        if (v == null) return null;
        const id = String(typeof v === 'string' ? v : v.id);
        const mentioned = message.mentions?.users?.get?.(id);
        if (mentioned) return mentioned;
        return { id, username: `user-${id}`, tag: `user-${id}`, bot: false, displayAvatarURL: () => null };
      },
      getChannel: () => null,
      getRole: () => null,
      getMentionable: () => null,
      getSubcommand: () => {
        if (!subcommandName) throw new Error('getSubcommand() called but no subcommand was provided');
        return subcommandName;
      },
      getSubcommandGroup: () => null,
      getFocused: () => null,
    },
    user: message.author,
    member: message.member || null,
    memberPermissions: message.member?.permissions || null,
    channelId: message.channelId,
    channel: message.channel,
    guild: message.guild || null,
    guildId: message.guildId || null,
    client: message.client,
    deferred: false,
    replied: false,
    isChatInputCommand: () => true,
    isAutocomplete: () => false,
    isButton: () => false,
    isStringSelectMenu: () => false,
    isModalSubmit: () => false,
    inGuild: () => Boolean(message.guildId),
    deferReply: async options => {
      if (interaction.deferred || interaction.replied) return;
      interaction.deferred = true;
      if (options?.ephemeral) {
        privateReply = true; // Nothing in the channel yet; the edit that follows goes to DMs.
        return;
      }
      lastSent = await message.reply({ content: '⏳ Working on it…' }).catch(() => null);
    },
    reply: async payload => {
      const { p, ephemeral } = toPayload(payload);
      if (interaction.deferred && lastSent) {
        lastSent = await lastSent.edit(p);
        interaction.replied = true;
        return lastSent;
      }
      if (interaction.replied) return send(p, ephemeral);
      if (ephemeral || privateReply) {
        privateReply = true;
        return send(p, true);
      }
      lastSent = await message.reply(p);
      interaction.replied = true;
      return lastSent;
    },
    editReply: async payload => {
      const { p } = toPayload(payload);
      if (!lastSent) return send(p, privateReply);
      lastSent = await lastSent.edit(p);
      interaction.replied = true;
      return lastSent;
    },
    followUp: async payload => {
      const { p, ephemeral } = toPayload(payload);
      return send(p, ephemeral);
    },
    fetchReply: async () => lastSent,
    deleteReply: async () => {
      if (lastSent) await lastSent.delete().catch(() => {});
      lastSent = null;
    },
    showModal: async () => {
      throw new Error('That command opens a form — run it as a real slash command so Discord can show it.');
    },
  };
  return interaction;
}

// Discord enforces a command's default_member_permissions only in its own slash
// picker — the bot is never told. Fallback dispatch goes straight to the handler,
// so it has to apply that gate itself, or every admin-only command whose handler
// trusts Discord to hide it (/staged does today) is open to any member who types
// its name. "0" means no one but administrators, matching Discord.
function memberMayUse(commandDefs, commandName, member, userId, config = {}) {
  const def = (commandDefs || [])
    .map(b => (typeof b?.toJSON === 'function' ? b.toJSON() : b))
    .find(json => String(json?.name || '').toLowerCase() === String(commandName || '').toLowerCase());
  const required = def?.default_member_permissions;
  if (required == null) return true;
  if (config.ADMIN_USER_ID && String(userId || '') === String(config.ADMIN_USER_ID)) return true;
  const permissions = member?.permissions;
  if (typeof permissions?.has !== 'function') return false;
  let bits;
  try { bits = BigInt(required); } catch (_err) { return false; }
  if (bits === 0n) return Boolean(permissions.has('Administrator'));
  return Boolean(permissions.has(bits));
}

// ---------------------------------------------------------------------------
// Feature
// ---------------------------------------------------------------------------

function createCommandFallbackFeature(deps) {
  const {
    config = {},
    getSetting,
    getCommandDefs,
    handleSlashCommand,
    audit = () => {},
    log = { error: () => {}, info: () => {} },
    llm = null,
    fetchImpl = null,
    now = Date.now,
  } = deps || {};
  if (typeof getSetting !== 'function') throw new Error('createCommandFallbackFeature requires getSetting');
  if (typeof getCommandDefs !== 'function') throw new Error('createCommandFallbackFeature requires getCommandDefs');
  if (typeof handleSlashCommand !== 'function') throw new Error('createCommandFallbackFeature requires handleSlashCommand');

  const pending = new Map(); // nonce -> { resolution, authorId, channelId, confirmMessage, expiresAt }
  const lastActionByUser = new Map();
  const lastHintByChannel = new Map();

  const settingList = key => String(getSetting(key) || '').split(',').map(s => s.trim()).filter(Boolean);
  const isEnabled = () => String(getSetting('cmdfb_enabled') || '') === '1';
  const watchedChannels = () => new Set(settingList('cmdfb_channels'));
  const strictChannels = () => new Set(settingList('cmdfb_strict_channels'));
  const cleanupMode = () => {
    const mode = String(getSetting('cmdfb_cleanup') || 'off').trim().toLowerCase();
    return ['react', 'delete'].includes(mode) ? mode : 'off';
  };
  const autoRunCommands = () => new Set(settingList('cmdfb_autorun').map(s => s.toLowerCase()));

  const isAdmin = message => Boolean(
    message.member?.permissions?.has?.('Administrator')
    || String(message.author?.id || '') === String(config.ADMIN_USER_ID || ''),
  );

  async function executeResolution(message, resolution, via) {
    if (!memberMayUse(getCommandDefs(), resolution.command, message.member, message.author?.id, config)) {
      audit('command_fallback', { actorDiscordId: message.author.id, channelId: message.channelId, command: resolution.command, subcommand: resolution.subcommand, via, ok: false, reason: 'not_permitted' });
      await message.reply({ content: `❌ **/${resolution.command}** isn't available to you.` }).catch(() => {});
      return false;
    }
    const interaction = buildMessageInteraction({
      message,
      commandName: resolution.command,
      subcommandName: resolution.subcommand,
      optionValues: resolution.options,
    });
    try {
      await handleSlashCommand(interaction);
      audit('command_fallback', {
        actorDiscordId: message.author.id,
        channelId: message.channelId,
        command: resolution.command,
        subcommand: resolution.subcommand,
        confidence: resolution.confidence,
        via,
        ok: true,
      });
      await message.react('✅').catch(() => {});
      return true;
    } catch (err) {
      audit('command_fallback', {
        actorDiscordId: message.author.id,
        channelId: message.channelId,
        command: resolution.command,
        subcommand: resolution.subcommand,
        via,
        ok: false,
        reason: 'handler_error',
      });
      await message.channel.send({ content: `❌ ${String(err.message || 'That command failed').slice(0, 300)}` }).catch(() => {});
      return false;
    }
  }

  async function offerConfirmation(message, resolution) {
    const nonce = crypto.randomBytes(6).toString('hex');
    const canonical = canonicalCommandString(resolution);
    const ignored = resolution.ignoredTokens?.length
      ? `\n(I couldn't place: ${resolution.ignoredTokens.map(t => `\`${t}\``).join(' ')})`
      : '';
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`cmdfb:run:${nonce}`).setLabel('Run it').setEmoji('▶️').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`cmdfb:skip:${nonce}`).setLabel('No thanks').setStyle(ButtonStyle.Secondary),
    );
    const confirmMessage = await message.reply({
      content: `Did you mean **${canonical}**?${ignored}\nTap **Run it** and I'll run it as you — or ignore this and use the slash command.`,
      components: [row],
    });
    const entry = { resolution, authorId: message.author.id, channelId: message.channelId, confirmMessage, sourceMessage: message, expiresAt: now() + CONFIRM_TTL_MS };
    pending.set(nonce, entry);
    const timer = setTimeout(() => {
      if (pending.get(nonce) === entry) {
        pending.delete(nonce);
        confirmMessage.edit({ content: `⌛ That offer expired. The command was **${canonical}**.`, components: [] }).catch(() => {});
      }
    }, CONFIRM_TTL_MS);
    timer.unref?.();
  }

  async function handleCleanup(message) {
    const mode = cleanupMode();
    if (mode === 'off') return;
    if (isAdmin(message) || message.pinned) return;
    if (message.mentions?.users?.has?.(message.client.user.id)) return; // Talking to the bot is allowed.
    const hasAttachments = (message.attachments?.size || 0) > 0;

    if (mode === 'react' || hasAttachments) {
      await message.react('👀').catch(() => {});
      const lastHint = lastHintByChannel.get(message.channelId) || 0;
      if (now() - lastHint > HINT_THROTTLE_MS) {
        lastHintByChannel.set(message.channelId, now());
        const note = await message.channel.send({
          content: `Heads up — <#${message.channelId}> is a commands-only channel. Chatter goes in a regular channel so requests don't get buried. 🙂`,
        }).catch(() => null);
        if (note) {
          const t = setTimeout(() => note.delete().catch(() => {}), 20_000);
          t.unref?.();
        }
      }
      audit('command_fallback_cleanup', { actorDiscordId: message.author.id, channelId: message.channelId, mode: 'react', ok: true });
      return;
    }

    // mode === 'delete' and no attachments: DM the author a copy first — the
    // delete must never be the moment their words disappear.
    let dmDelivered = false;
    try {
      await message.author.send({
        content: `I moved a message out of <#${message.channelId}> — that channel is commands-only so requests stay visible. Here's exactly what you said, so nothing is lost:\n\n> ${String(message.content).slice(0, 1500)}\n\nRepost it in a chat channel and it'll stay up.`,
      });
      dmDelivered = true;
    } catch (_err) { /* DMs closed — fall through to react-only. */ }
    if (!dmDelivered) {
      await message.react('👀').catch(() => {});
      audit('command_fallback_cleanup', { actorDiscordId: message.author.id, channelId: message.channelId, mode: 'delete_dm_failed', ok: false });
      return;
    }
    await message.delete().catch(() => {});
    audit('command_fallback_cleanup', { actorDiscordId: message.author.id, channelId: message.channelId, mode: 'delete', ok: true });
  }

  async function handleMessage(message) {
    if (!message?.guild || message.author?.bot) return;
    if (!isEnabled()) return;
    if (!watchedChannels().has(message.channelId)) return;
    if (message.channel?.isThread?.()) return;
    if (typeof message.content !== 'string') return;

    const userKey = `${message.channelId}:${message.author.id}`;
    const lastAction = lastActionByUser.get(userKey) || 0;
    if (now() - lastAction < USER_COOLDOWN_MS) return;
    lastActionByUser.set(userKey, now());

    let commandDefs;
    let metadatas;
    try {
      commandDefs = getCommandDefs();
      metadatas = commandDefsToMetadata(commandDefs);
    } catch (err) {
      log.error(`command-fallback: command definitions unavailable: ${err.message}`);
      return;
    }
    if (!metadatas.length) return;

    let resolution = resolveCommandText(message.content, metadatas);
    if (resolution.kind === 'none' && llm) {
      resolution = await resolveWithLlm(message.content, metadatas, llm, fetchImpl);
      if (resolution.kind === 'resolved') resolution.prefixed = message.content.trim().startsWith('/');
    }
    // A command this member can't use is never offered, hinted or run: to them it
    // isn't a command at all, so it falls through to plain-message handling below.
    if ((resolution.kind === 'resolved' || resolution.kind === 'invalid')
      && !memberMayUse(commandDefs, resolution.command, message.member, message.author?.id, config)) {
      resolution = { kind: 'none' };
    }

    if (resolution.kind === 'resolved') {
      if (isCredentialCommand(resolution.command, resolution.subcommand)) {
        audit('command_fallback', { actorDiscordId: message.author.id, channelId: message.channelId, command: resolution.command, subcommand: resolution.subcommand, via: 'credential_hint', ok: true });
        await message.reply({
          content: `That one handles credentials, so it has to be run as a real slash command: **${canonicalCommandString(resolution)}** — type \`/\` and pick it from the list.`,
        }).catch(() => {});
        return;
      }
      if (resolution.exact && autoRunCommands().has(resolution.command)) {
        await executeResolution(message, resolution, 'autorun');
        return;
      }
      if (resolution.confidence >= CONFIRM_MIN_CONFIDENCE) {
        await offerConfirmation(message, resolution);
        return;
      }
      // A slash-prefixed near miss deserves one quiet pointer. An unprefixed
      // near miss is probably just conversation that starts with a command-ish
      // word ("hello" ~ "help") — silent here, but in a strict channel it is
      // still chatter, so let cleanup judge it below.
      if (resolution.prefixed) {
        await message.reply({
          content: `That looks close to **${canonicalCommandString(resolution)}** — type \`/\` and Discord will autocomplete the real one.`,
        }).catch(() => {});
        return;
      }
      if (strictChannels().has(message.channelId)) await handleCleanup(message);
      return;
    }

    if (resolution.kind === 'invalid' && resolution.confidence >= CONFIRM_MIN_CONFIDENCE) {
      audit('command_fallback', { actorDiscordId: message.author.id, channelId: message.channelId, command: resolution.command, subcommand: resolution.subcommand, via: 'invalid_hint', ok: false, reason: resolution.problems[0] || 'invalid' });
      await message.reply({
        content: `Close — I read that as **/${resolution.command}${resolution.subcommand ? ` ${resolution.subcommand}` : ''}**, but: ${resolution.problems[0]}. Fix that bit and I'll run it.`,
      }).catch(() => {});
      return;
    }

    // Not a command attempt at all. In a strict channel that's chatter to clean
    // up; everywhere else it's just conversation — stay silent.
    if (strictChannels().has(message.channelId)) {
      await handleCleanup(message);
    }
  }

  // Confirm-button dispatch, delegated from interactionCreate like the other
  // features. Returns true when the interaction belonged to this feature.
  async function handleInteraction(interaction) {
    const customId = interaction?.customId;
    if (typeof customId !== 'string' || !customId.startsWith('cmdfb:')) return false;
    if (typeof interaction.isButton === 'function' && !interaction.isButton()) return false;

    const [, action, nonce] = customId.split(':');
    const entry = pending.get(nonce);
    if (!entry || entry.expiresAt < now()) {
      if (entry) pending.delete(nonce);
      await interaction.reply({ content: '⌛ That offer expired — type the message again and I\'ll re-offer it.', ephemeral: true }).catch(() => {});
      return true;
    }
    const presserIsAuthor = String(interaction.user?.id) === String(entry.authorId);
    const presserIsAdmin = Boolean(
      interaction.memberPermissions?.has?.('Administrator')
      || String(interaction.user?.id || '') === String(config.ADMIN_USER_ID || ''),
    );
    if (!presserIsAuthor && !presserIsAdmin) {
      await interaction.reply({ content: '❌ Only the person who typed it (or an admin) can run this one.', ephemeral: true }).catch(() => {});
      return true;
    }

    pending.delete(nonce);
    const canonical = canonicalCommandString(entry.resolution);
    if (action === 'skip') {
      audit('command_fallback', { actorDiscordId: entry.authorId, channelId: entry.channelId, command: entry.resolution.command, via: 'dismissed', ok: true });
      await interaction.update({ content: `No problem. For next time, the real command is **${canonical}**.`, components: [] }).catch(() => {});
      return true;
    }
    if (action === 'run') {
      await interaction.update({ content: `▶️ Running **${canonical}**…`, components: [] }).catch(() => {});
      await executeResolution(entry.sourceMessage, entry.resolution, 'confirmed');
      return true;
    }
    return true;
  }

  return { handleMessage, handleInteraction, _pending: pending };
}

module.exports = {
  createCommandFallbackFeature,
  buildMessageInteraction,
  resolveCommandText,
  resolveWithLlm,
  assembleOptions,
  coerceOptionValue,
  tokenizeCommandText,
  damerauLevenshtein,
  nameSimilarity,
  canonicalCommandString,
  isCredentialCommand,
  memberMayUse,
  CONFIRM_MIN_CONFIDENCE,
};
