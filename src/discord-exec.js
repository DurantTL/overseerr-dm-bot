'use strict';

// Headless Discord slash-command bridge for the Agent API.
//
// Lets an authenticated Agent API client invoke the bot's slash commands over HTTP by
// routing a synthetic "headless interaction" through the SAME dispatch code the real
// `interactionCreate` handler uses (handleSlashCommand in index.js). No repair logic is
// duplicated here — this file only builds the interaction shim, validates the request
// against the SlashCommandBuilder definitions, captures the handler's replies, and
// audits. The route layer (src/routes/agent-api.js) stays a thin HTTP shell.
//
// Headless limitations (documented in docs/agent-api.md):
// - No buttons, select menus, or modals: the initial reply is captured, but interactive
//   follow-ups (e.g. the Adopt buttons /rtorrent adopt posts) cannot be clicked via API.
// - No DMs: handlers that DM a Discord user will fail the same way they would for an
//   unreachable user; the error surfaces in the captured replies.
// - The synthetic user is an admin for permission checks: Agent API tokens are already
//   privileged (see docs/agent-api.md "Safety model"), so admin-gated commands are
//   invokable. The audit trail records `agent:<token-label>` as the actor.

const { ApplicationCommandOptionType } = require('discord.js');

class DiscordExecError extends Error {
  constructor(status, message, reason) {
    super(message);
    this.name = 'DiscordExecError';
    this.status = status;
    this.reason = reason || null;
  }
}

// Discord API option types we know how to validate and serve through the shim.
const SUPPORTED_OPTION_TYPES = {
  [ApplicationCommandOptionType.String]: 'string',
  [ApplicationCommandOptionType.Integer]: 'integer',
  [ApplicationCommandOptionType.Boolean]: 'boolean',
  [ApplicationCommandOptionType.User]: 'user',
  [ApplicationCommandOptionType.Number]: 'number',
};

const MAX_REPLY_TEXT = 4000;
const MAX_AUDIT_VALUE = 120;

function optionToMeta(o) {
  const meta = {
    name: String(o.name || ''),
    type: o.type,
    required: !!o.required,
    choices: Array.isArray(o.choices) ? o.choices.map(c => c.value) : [],
  };
  if (o.min_value != null) meta.minValue = o.min_value;
  if (o.max_value != null) meta.maxValue = o.max_value;
  if (Array.isArray(o.options)) meta.options = o.options.map(optionToMeta);
  return meta;
}

// SlashCommandBuilder instances -> plain metadata the validator can use without discord.js
// specifics leaking further. Accepts builders or already-plain { name, options } objects
// (the latter keeps unit tests free of discord.js if desired).
function commandDefsToMetadata(builders) {
  return (builders || [])
    .map(b => {
      const json = typeof b.toJSON === 'function' ? b.toJSON() : b;
      return {
        name: String(json.name || '').toLowerCase(),
        options: Array.isArray(json.options) ? json.options.map(optionToMeta) : [],
      };
    })
    .filter(m => m.name);
}

function typeError(optPath, expected, value) {
  return new DiscordExecError(
    400,
    `Option "${optPath}" must be ${expected} (got ${Array.isArray(value) ? 'array' : typeof value})`,
    'invalid_option_type',
  );
}

function validateOptionValue(meta, value, optPath) {
  const kind = SUPPORTED_OPTION_TYPES[meta.type];
  if (!kind) {
    throw new DiscordExecError(
      400,
      `Option "${optPath}" uses a Discord option type the bridge doesn't support (type ${meta.type})`,
      'unsupported_option_type',
    );
  }
  switch (kind) {
    case 'string':
      if (typeof value !== 'string') throw typeError(optPath, 'a string', value);
      break;
    case 'integer':
      if (typeof value !== 'number' || !Number.isInteger(value)) throw typeError(optPath, 'an integer', value);
      if (meta.minValue != null && value < meta.minValue) {
        throw new DiscordExecError(400, `Option "${optPath}" must be >= ${meta.minValue}`, 'option_out_of_range');
      }
      if (meta.maxValue != null && value > meta.maxValue) {
        throw new DiscordExecError(400, `Option "${optPath}" must be <= ${meta.maxValue}`, 'option_out_of_range');
      }
      break;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) throw typeError(optPath, 'a number', value);
      break;
    case 'boolean':
      if (typeof value !== 'boolean') throw typeError(optPath, 'a boolean', value);
      break;
    case 'user': {
      const id = typeof value === 'string' ? value : (value && value.id);
      if (typeof id !== 'string' || !/^\d{5,}$/.test(id)) {
        throw new DiscordExecError(400, `Option "${optPath}" must be a Discord user id string or { id } object`, 'invalid_option_type');
      }
      break;
    }
    default:
      throw new DiscordExecError(400, `Option "${optPath}" has an unhandled type`, 'unsupported_option_type');
  }
  if (meta.choices.length && !meta.choices.includes(value)) {
    throw new DiscordExecError(
      400,
      `Option "${optPath}" must be one of: ${meta.choices.map(c => JSON.stringify(c)).join(', ')}`,
      'invalid_option_choice',
    );
  }
}

// Validate { command, subcommand, options } against the builder definitions. Returns the
// normalized dispatch triple. Throws DiscordExecError with a 400 status on any mismatch.
function validateExecInput(input, metadatas) {
  const command = String(input.command || '').trim().toLowerCase();
  if (!command) throw new DiscordExecError(400, 'command is required', 'missing_command');
  const meta = (metadatas || []).find(m => m.name === command);
  if (!meta) {
    throw new DiscordExecError(
      400,
      `Unknown command "${command}"`,
      'unknown_command',
    );
  }
  const subcommandMetas = meta.options.filter(o => o.type === ApplicationCommandOptionType.Subcommand);
  const groupMetas = meta.options.filter(o => o.type === ApplicationCommandOptionType.SubcommandGroup);
  const valueMetas = meta.options.filter(
    o => o.type !== ApplicationCommandOptionType.Subcommand && o.type !== ApplicationCommandOptionType.SubcommandGroup,
  );

  let subcommandName = null;
  let activeOptions;
  const rawSub = input.subcommand == null ? null : String(input.subcommand).trim().toLowerCase();
  if (subcommandMetas.length) {
    if (!rawSub) {
      throw new DiscordExecError(
        400,
        `/${command} requires a subcommand (one of: ${subcommandMetas.map(s => s.name).join(', ')})`,
        'missing_subcommand',
      );
    }
    const sm = subcommandMetas.find(s => s.name === rawSub);
    if (!sm) {
      throw new DiscordExecError(
        400,
        `Unknown subcommand "${rawSub}" for /${command} (one of: ${subcommandMetas.map(s => s.name).join(', ')})`,
        'unknown_subcommand',
      );
    }
    subcommandName = sm.name;
    activeOptions = sm.options || [];
  } else {
    if (groupMetas.length) {
      throw new DiscordExecError(400, `/${command} uses subcommand groups, which the bridge doesn't support`, 'unsupported_subcommand_group');
    }
    if (rawSub) throw new DiscordExecError(400, `/${command} takes no subcommand`, 'unexpected_subcommand');
    activeOptions = valueMetas;
  }

  const provided = input.options || {};
  const where = subcommandName ? `/${command} ${subcommandName}` : `/${command}`;
  for (const name of Object.keys(provided)) {
    const om = activeOptions.find(o => o.name === name);
    if (!om) {
      throw new DiscordExecError(400, `Unknown option "${name}" for ${where}`, 'unknown_option');
    }
    validateOptionValue(om, provided[name], name);
  }
  for (const om of activeOptions) {
    if (om.required && !(om.name in provided)) {
      throw new DiscordExecError(400, `Option "${om.name}" is required for ${where}`, 'missing_required_option');
    }
  }
  return { commandName: meta.name, subcommandName, optionValues: provided };
}

function normalizeReplyPayload(kind, payload) {
  const p = typeof payload === 'string' ? { content: payload } : (payload || {});
  const out = { kind };
  if (p.content != null) out.content = String(p.content).slice(0, MAX_REPLY_TEXT);
  if (Array.isArray(p.embeds) && p.embeds.length) {
    out.embeds = p.embeds.slice(0, 10).map(e => {
      try {
        return typeof e.toJSON === 'function' ? e.toJSON() : e;
      } catch (_err) {
        return { title: String(e.title || ''), description: String(e.description || '').slice(0, MAX_REPLY_TEXT) };
      }
    });
  }
  if (p.ephemeral || p.flags === 64) out.ephemeral = true;
  if (Array.isArray(p.components) && p.components.length) {
    out.components = `${p.components.length} component row(s) — buttons/selects can't be used via the API`;
  }
  if (Array.isArray(p.files) && p.files.length) {
    out.files = `${p.files.length} file attachment(s) omitted`;
  }
  return out;
}

// The headless interaction: a plain object implementing the slice of the discord.js
// interaction API the slash-command handlers actually use (surveyed from index.js).
// Anything inherently interactive (modals, buttons, DMs to real users) degrades to a
// captured note instead of failing silently.
function buildHeadlessInteraction({ commandName, subcommandName, optionValues, actorLabel }) {
  const replies = [];
  const userId = `agent:${actorLabel}`;
  const capture = (kind, payload) => {
    const normalized = normalizeReplyPayload(kind, payload);
    replies.push(normalized);
    return normalized;
  };

  const interaction = {
    commandName,
    options: {
      getString: name => {
        const v = optionValues[name];
        return v == null ? null : String(v);
      },
      getInteger: name => {
        const v = optionValues[name];
        return v == null ? null : Number(v);
      },
      getNumber: name => {
        const v = optionValues[name];
        return v == null ? null : Number(v);
      },
      getBoolean: name => {
        const v = optionValues[name];
        return v == null ? null : Boolean(v);
      },
      getUser: name => {
        const v = optionValues[name];
        if (v == null) return null;
        const id = String(typeof v === 'string' ? v : v.id);
        return { id, username: `user-${id}`, tag: `user-${id}`, bot: false, displayAvatarURL: () => null };
      },
      getSubcommand: () => {
        if (!subcommandName) throw new Error('getSubcommand() called but no subcommand was provided');
        return subcommandName;
      },
      getSubcommandGroup: () => null,
      // Autocomplete never fires headless; handlers only reach getFocused() via the
      // autocomplete path, which the bridge doesn't invoke.
      getFocused: () => null,
    },
    user: {
      id: userId,
      username: `agent-${actorLabel}`,
      tag: `agent-${actorLabel}`,
      bot: false,
      displayAvatarURL: () => null,
    },
    // Agent API tokens are privileged (see docs/agent-api.md "Safety model"), so the
    // synthetic actor passes admin permission checks. Every invocation is audited as
    // `agent:<token-label>`, distinguishing API runs from Discord users.
    memberPermissions: { has: () => true },
    member: null,
    channelId: 'agent-api',
    channel: {
      id: 'agent-api',
      send: async payload => {
        capture('channelSend', payload);
        return { id: 'headless-message' };
      },
    },
    guild: null,
    guildId: null,
    client: { user: { id: 'agent-api-bridge', username: 'agent-api' } },
    deferred: false,
    replied: false,
    isChatInputCommand: () => true,
    isAutocomplete: () => false,
    isButton: () => false,
    isStringSelectMenu: () => false,
    isModalSubmit: () => false,
    deferReply: async opts => {
      interaction.deferred = true;
      capture('defer', opts || {});
    },
    reply: async payload => {
      interaction.replied = true;
      capture('reply', payload);
      return { id: 'headless-message' };
    },
    editReply: async payload => {
      capture('editReply', payload);
      return { id: 'headless-message' };
    },
    followUp: async payload => {
      capture('followUp', payload);
      return { id: 'headless-message' };
    },
    deleteReply: async () => {
      capture('deleteReply', {});
    },
    showModal: async modal => {
      capture('modal', modal && typeof modal.toJSON === 'function' ? modal.toJSON() : modal);
      throw new Error('Modals require a Discord client — not supported via the Agent API');
    },
    // Button/select/update surface: slash-command dispatch never produces these, but a
    // handler reaching for them headless gets a captured note instead of a TypeError.
    update: async payload => {
      capture('update', payload);
    },
    deferUpdate: async () => {
      capture('deferUpdate', {});
    },
  };
  return { interaction, replies };
}

function sanitizeOptionsForAudit(options) {
  const out = {};
  for (const [k, v] of Object.entries(options || {})) {
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    out[k] = String(s).slice(0, MAX_AUDIT_VALUE);
  }
  return out;
}

// Creates the bridge executor. handleSlashCommand and getCommandDefs come from index.js
// (the real dispatch + the real SlashCommandBuilder list); tests inject fakes.
function createDiscordExec({ handleSlashCommand, getCommandDefs, audit }) {
  if (typeof handleSlashCommand !== 'function') throw new Error('createDiscordExec requires handleSlashCommand');
  if (typeof getCommandDefs !== 'function') throw new Error('createDiscordExec requires getCommandDefs');
  const doAudit = typeof audit === 'function' ? audit : () => {};

  return async function executeDiscordCommand({ command, subcommand, options, actorLabel }) {
    const label = String(actorLabel || 'unknown').slice(0, 80);
    const actor = `agent:${label}`;
    const base = {
      actor,
      command: command == null ? null : String(command).slice(0, 80),
      subcommand: subcommand == null ? null : String(subcommand).slice(0, 80),
      options: sanitizeOptionsForAudit(options),
    };

    let metadatas;
    try {
      metadatas = commandDefsToMetadata(getCommandDefs());
    } catch (err) {
      doAudit('agent_api_discord_exec', { ...base, ok: false, reason: 'defs_unavailable' });
      throw new DiscordExecError(503, 'Discord command definitions are unavailable', 'defs_unavailable');
    }
    if (!metadatas.length) {
      doAudit('agent_api_discord_exec', { ...base, ok: false, reason: 'defs_unavailable' });
      throw new DiscordExecError(503, 'Discord command definitions are unavailable', 'defs_unavailable');
    }

    let validated;
    try {
      validated = validateExecInput({ command, subcommand, options }, metadatas);
    } catch (err) {
      if (err instanceof DiscordExecError) {
        doAudit('agent_api_discord_exec', { ...base, ok: false, reason: err.reason });
        throw err;
      }
      doAudit('agent_api_discord_exec', { ...base, ok: false, reason: 'validation_error' });
      throw new DiscordExecError(400, 'Invalid request', 'validation_error');
    }

    const { interaction, replies } = buildHeadlessInteraction({
      commandName: validated.commandName,
      subcommandName: validated.subcommandName,
      optionValues: validated.optionValues,
      actorLabel: label,
    });

    try {
      await handleSlashCommand(interaction);
    } catch (err) {
      // Mirror the real interactionCreate catch block: surface a clean error reply rather
      // than letting the exception escape the bridge.
      doAudit('agent_api_discord_exec', { ...base, ok: false, reason: 'handler_error' });
      replies.push({ kind: 'error', content: `❌ ${String(err && err.message || 'Command failed')}`.slice(0, MAX_REPLY_TEXT) });
      return { ok: false, replies };
    }

    doAudit('agent_api_discord_exec', { ...base, ok: true, replies: replies.length });
    return { ok: true, replies };
  };
}

module.exports = {
  createDiscordExec,
  DiscordExecError,
  commandDefsToMetadata,
  validateExecInput,
  buildHeadlessInteraction,
};
