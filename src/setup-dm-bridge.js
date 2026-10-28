'use strict';

// Add a persistent setup entry point to the bot's onboarding DMs. index.js calls withSetupButton()
// explicitly on the payloads it sends at the onboarding steps (the welcome DM, the setup-complete
// reply, and dmUser); nothing patches Discord prototypes. Only a tightly scoped set of known
// onboarding embed titles gains the button; request/progress/cleanup DMs pass through unchanged.

const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

const ONBOARDING_TITLE_PATTERNS = [
  /Welcome to Durant Media Server/i,
  /You're In!/i,
  /Your Setup Needs Attention/i,
];

function embedTitle(embed) {
  return String(embed?.data?.title || embed?.title || '');
}

function onboardingTitle(payload) {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.embeds)) return '';
  return payload.embeds.map(embedTitle).find(title => ONBOARDING_TITLE_PATTERNS.some(re => re.test(title))) || '';
}

function isOnboardingPayload(payload) {
  return !!onboardingTitle(payload);
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

function setupButtonLabel(payload) {
  const title = onboardingTitle(payload);
  if (/Welcome to Durant Media Server/i.test(title)) return '🎬 Start Plex Setup';
  if (/Your Setup Needs Attention/i.test(title)) return '🛠️ Fix My Setup';
  return '🛠️ Setup / Troubleshooting';
}

function withSetupButton(payload) {
  if (!isOnboardingPayload(payload) || hasSetupButton(payload)) return payload;
  const rows = Array.isArray(payload.components) ? [...payload.components] : [];
  if (rows.length >= 5) return payload;
  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('setup:open')
      .setLabel(setupButtonLabel(payload))
      .setStyle(ButtonStyle.Primary),
  ));
  return { ...payload, components: rows };
}

module.exports = {
  isOnboardingPayload,
  setupButtonLabel,
  withSetupButton,
};
