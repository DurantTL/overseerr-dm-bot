// Validate before loading index.js, which opens the database and creates the Discord client.
// A bad deployment stays reachable for diagnosis without starting any application work.
const { validateConfig, startConfigErrorServer } = require('./src/config');

let configError = null;
try { validateConfig(); } catch (err) { configError = err; }

if (configError) {
  startConfigErrorServer(configError);
} else {
  // Guided setup is installed before index.js so it can extend the existing Discord command
  // registration and intercept only /setup, the enhanced /me, and setup-owned buttons/modals.
  // The rest of the bot continues through index.js unchanged.
  const { installSetupDiscordExtension } = require('./src/setup-discord-extension');
  installSetupDiscordExtension();

  // Start the main Discord/web process, then attach optional background services that are isolated
  // from index.js. Keeping workers here lets index.js shrink toward a true composition root over time.
  require('./index');

  const { startEpisodeRecovery } = require('./src/episode-recovery');
  startEpisodeRecovery().catch(err => {
    // The main bot must stay online if the optional worker is misconfigured.
    console.error(`Episode recovery failed to start: ${err.message}`);
  });
}
