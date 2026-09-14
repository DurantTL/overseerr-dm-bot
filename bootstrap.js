// Validate before loading index.js, which opens the database and creates the Discord client.
// A bad deployment stays reachable for diagnosis without starting any application work.
const { validateConfig, startConfigErrorServer } = require('./src/config');

let configError = null;
try { validateConfig(); } catch (err) { configError = err; }

if (configError) {
  startConfigErrorServer(configError);
} else {
  // Guided setup is installed before index.js so it can extend the existing Discord command
  // registration and intercept only setup-owned interactions. Layers are installed from broadest
  // to most specific; the later wrappers get first refusal and otherwise pass through to the
  // existing index.js listener unchanged. The Request Media wizard (src/setup-request-ui.js) no
  // longer patches Client.prototype.emit here — it registers explicitly inside index.js's own
  // interactionCreate listener instead, and setup-discord-extension.js's catch-all defers to it by
  // name (see isOwnedInteraction there) so button routing order is unchanged. It still forwards
  // its final choice down to the real /request handler as a synthetic interaction so the original
  // request gate remains the one authoritative implementation.
  const { installSetupDiscordExtension } = require('./src/setup-discord-extension');
  installSetupDiscordExtension();
  const { installSetupDiscordEnhancements } = require('./src/setup-discord-enhancements');
  installSetupDiscordEnhancements();
  const { installSetupDeviceState } = require('./src/setup-device-state');
  installSetupDeviceState();

  // Existing welcome/completion DMs are emitted by index.js. Install this bridge before index.js
  // so those messages automatically gain the Setup / Troubleshooting entry point without
  // duplicating the onboarding business logic.
  const { installSetupDmBridge } = require('./src/setup-dm-bridge');
  installSetupDmBridge();

  // Start the main Discord/web process. Recurring workers are owned by its automation registry so
  // scheduling, overlap protection, status, and shutdown share one lifecycle.
  require('./index');
}
