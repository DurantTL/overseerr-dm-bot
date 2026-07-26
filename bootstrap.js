// Start the main Discord/web process, then attach optional background services that are isolated
// from index.js. Keeping workers here lets index.js shrink toward a true composition root over time.
require('./index');

const { startEpisodeRecovery } = require('./src/episode-recovery');
startEpisodeRecovery().catch(err => {
  // The main bot must stay online if the optional worker is misconfigured.
  console.error(`Episode recovery failed to start: ${err.message}`);
});
