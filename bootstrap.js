// Validate before loading index.js, which opens the database and creates the Discord client.
// A bad deployment stays reachable for diagnosis without starting any application work.
const { validateConfig, startConfigErrorServer } = require('./src/config');

let configError = null;
try { validateConfig(); } catch (err) { configError = err; }

if (configError) {
  startConfigErrorServer(configError);
} else {
  // Guided setup no longer patches Discord prototypes. The setup features
  // (src/setup-device-state.js, src/setup-discord-enhancements.js,
  // src/setup-discord-extension.js, src/setup-request-ui.js) register explicitly inside
  // index.js's own interactionCreate listener, chained most-specific first
  // (device-state > enhancements > extension, after media-panel/support-case/request-ui),
  // and their slash commands (/setup, /send-setup) live in index.js's slashCommands array.

  // Existing welcome/completion DMs are emitted by index.js. Install this bridge before index.js
  // so those messages automatically gain the Setup / Troubleshooting entry point without
  // duplicating the onboarding business logic.
  const { installSetupDmBridge } = require('./src/setup-dm-bridge');
  installSetupDmBridge();

  // Start the main Discord/web process. Recurring workers are owned by its automation registry so
  // scheduling, overlap protection, status, and shutdown share one lifecycle.
  require('./index');
}
