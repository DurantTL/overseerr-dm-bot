// Validate before loading index.js, which opens the database and creates the Discord client.
// A bad deployment stays reachable for diagnosis without starting any application work.
const { validateConfig, startConfigErrorServer } = require('./src/config');

let configError = null;
try { validateConfig(); } catch (err) { configError = err; }

if (configError) {
  startConfigErrorServer(configError);
} else {
  // Start the main Discord/web process, then attach optional background services that are isolated
  // from index.js. Keeping workers here lets index.js shrink toward a true composition root over time.
  require('./index');

  const { startEpisodeRecovery } = require('./src/episode-recovery');
  startEpisodeRecovery().catch(err => {
    // The main bot must stay online if the optional worker is misconfigured.
    console.error(`Episode recovery failed to start: ${err.message}`);
  });
}
