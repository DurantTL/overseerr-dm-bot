'use strict';

// Automation → Fleet and host: what to list, besides the bot's own registry jobs. Adding a row is
// an edit here plus a bot redeploy; there is no admin UI for it. docs/fleet-host-automation.md has
// a worked example of each kind.
//
// Every row states its expected cadence as `period` (minutes between runs) so its status is judged
// against its own schedule: a row is stale only once it is past last run + period + grace, where
// grace is one period, at most 12 hours (src/fleet-host.js).
//
// Nothing here is a secret. Never put tokens, keys or passwords in this file.

const MIN = 1;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

module.exports = Object.freeze({
  // Tier nodes come from the bot's tier node registry (tier_nodes). Every registered node gets a
  // row; these entries only add where it runs and its cadence. A node with no entry runs the tier
  // agent's 15-minute timer. `listWhenMissing` keeps a row on the page even before the node is
  // registered or has reported (shown as no data, never as a made-up check-in).
  tierDefaults: Object.freeze({ where: 'Tier agent', schedule: 'every 15 min', period: 15 * MIN }),
  tierNodes: Object.freeze([
    Object.freeze({
      node: 'central-iowa',
      where: 'UGOS, Central Iowa · monitor-only SMART reporter container',
      schedule: 'daily, 03:17 America/Chicago',
      period: DAY,
      monitor: true,
      listWhenMissing: true,
    }),
  ]),

  // The heartbeat allowlist. POST /api/automation/heartbeat accepts only these names; anything
  // else is refused and nothing is stored. A row shows "awaiting first heartbeat" (no data) until
  // its sender posts, and is never ok without a heartbeat.
  heartbeats: Object.freeze([
    Object.freeze({ name: 'staging-sweep', label: 'Staging sweep', group: 'Host crons', where: 'Host · media crontab', schedule: 'Sundays 09:17 UTC', period: WEEK, path: '~/bin/staging-sweep.sh', log: '~/seedbox-staging/.sweep/' }),
    Object.freeze({ name: 'latest-movies-sync', label: 'Europe sync (latest movies)', group: 'Host crons', where: 'Host · media crontab', schedule: 'daily 05:00 UTC', period: DAY, path: 'sync-latest-movies.sh' }),
    Object.freeze({ name: 'edith-director-monitor', label: 'Director monitor', group: 'Edith watches', where: 'Edith · Muse runtime cron', schedule: 'every 15 min', period: 15 * MIN }),
    Object.freeze({ name: 'edith-movie-watch', label: 'Movie watch', group: 'Edith watches', where: 'Edith · Muse runtime cron', schedule: 'Mondays', period: WEEK }),
    Object.freeze({ name: 'edith-muse-charm-watch', label: 'Muse Charm watch', group: 'Edith watches', where: 'Edith · Muse runtime cron', schedule: 'daily', period: DAY }),
    Object.freeze({ name: 'edith-negros-power-watch', label: 'Negros Power watch', group: 'Edith watches', where: 'Edith · Muse runtime cron', schedule: 'every 2 hours', period: 2 * HOUR }),
    Object.freeze({ name: 'edith-tailworm-watch', label: 'Tailworm watch', group: 'Edith watches', where: 'Edith · Muse runtime cron', schedule: 'daily, about 07:14 Central', period: DAY }),
    Object.freeze({ name: 'edith-ups-power-watch', label: 'UPS power watch', group: 'Edith watches', where: 'Edith · Muse runtime cron', schedule: 'every 15 min', period: 15 * MIN }),
    Object.freeze({ name: 'ph-sync-reporter', label: 'PH sync reporter', group: 'Fleet scripts', where: 'PH · root cron', schedule: 'every 15 min', period: 15 * MIN, path: '/opt/ph-sync-reporter/ph-sync-report.js', log: '/var/log/ph-sync-reporter/' }),
    // Schedules for these two are set by their own slices; until then a heartbeat from them shows
    // as unknown (never ok), because there is nothing to judge it against.
    Object.freeze({ name: 'restart-logger', label: 'Restart logger', group: 'Fleet scripts', where: 'Not built yet', schedule: null, period: null }),
    Object.freeze({ name: 'staging-cross-check', label: 'Staging cross-check', group: 'Fleet scripts', where: 'Not built yet', schedule: null, period: null }),
  ]),

  // Listed only: things that run on a schedule or on events but send no heartbeat. Their status is
  // always "unknown, see log", never ok.
  inventory: Object.freeze([
    Object.freeze({ name: 'watchtower', label: 'Watchtower', where: 'durant-server · its own container', schedule: 'daily 04:00 UTC', path: 'containrrr/watchtower container', log: 'docker logs watchtower', note: 'The bot does not track its runs.' }),
    Object.freeze({ name: 'syncthing-conflict-watcher', label: 'Syncthing conflict watcher', where: 'Bot · on each inbound tier agent report', schedule: 'event-driven, no cadence', path: 'src/sync-conflicts.js', log: 'bot log and admin alerts channel', note: 'Runs when a tier agent reports; it has no schedule of its own to miss.' }),
  ]),
});
