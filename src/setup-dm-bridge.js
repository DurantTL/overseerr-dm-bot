'use strict';

// Add a persistent Setup / Troubleshooting entry point to the bot's existing onboarding DMs
// without duplicating the onboarding business logic from index.js. This only touches a tightly
// scoped set of known onboarding embed titles; request/progress/cleanup DMs are left unchanged.

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  GuildMember,
  Message,
  User,
} = require('discord.js');

const INSTALL_MARK = Symbol.for('durant.setupDmBridgeInstalled');
const ONBOARDING_TITLE_PATTERNS = [
  /Welcome to Durant Media Server/i,
  /You're In!/i,
  /Your Setup Needs Attention/i,
];

function embedTitle(embed) {
  return String(embed?.data?.title || embed?.title || '');
}

function isOnboardingPayload(payload) {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.embeds)) return false;
  return payload.embeds.some(embed => ONBOARDING_TITLE_PATTERNS.some(re => re.test(embedTitle(embed))));
}

function hasSetupButton(payload) {
  return (payload.components || []).some(row => {
    const components = row?.components || row?.data?.components || [];
    return components.some(component => {
      const id = component?.data?.custom_id || component?.custom_id || component?.customId;
      return String(id || '') === 'setup:open';
    });
  });
}

function withSetupButton(payload) {
  if (!isOnboardingPayload(payload) || hasSetupButton(payload)) return payload;
  const rows = Array.isArray(payload.components) ? [...payload.components] : [];
  if (rows.length >= 5) return payload;
  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('setup:open')
      .setLabel('🛠️ Setup / Troubleshooting')
      .setStyle(ButtonStyle.Primary),
  ));
  return { ...payload, components: rows };
}

function wrapSend(proto, methodName, marker) {
  const original = proto?.[methodName];
  if (typeof original !== 'function' || original[marker]) return;
  async function wrapped(payload, ...rest) {
    return original.call(this, withSetupButton(payload), ...rest);
  }
  wrapped[marker] = true;
  proto[methodName] = wrapped;
}

function installSetupDmBridge() {
  if (globalThis[INSTALL_MARK]) return;
  globalThis[INSTALL_MARK] = true;
  // member.send and user.send cover admin-triggered DMs; Message.reply covers the flow where a
  // member replies to the bot's onboarding DM and the bot finishes setup in that same DM thread.
  wrapSend(User?.prototype, 'send', '__durantSetupDmWrapped');
  wrapSend(GuildMember?.prototype, 'send', '__durantSetupDmWrapped');
  wrapSend(Message?.prototype, 'reply', '__durantSetupReplyWrapped');
}

module.exports = {
  installSetupDmBridge,
  isOnboardingPayload,
  withSetupButton,
};
