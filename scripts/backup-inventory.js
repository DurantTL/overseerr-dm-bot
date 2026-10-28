#!/usr/bin/env node
// Service queue item 18, step one: what backups exist today? Read-only; run inside the bot
// container so it sees the same config and data volume:
//
//   docker exec -it <bot-container> node scripts/backup-inventory.js          # report
//   docker exec -it <bot-container> node scripts/backup-inventory.js --json   # same, as JSON
//
// It lists backup files and reads settings. It never creates, restores or deletes a backup.
const { CONFIG } = require('../src/config');
const { inventory } = require('../src/backup-inventory');

(async () => {
  let lastSuccessAt = null;
  try { lastSuccessAt = require('../src/db').getSetting('backup_last_success'); } catch (_err) { /* no database here */ }
  const plex = process.env.PLEX_URL && CONFIG.PLEX_TOKEN ? { url: process.env.PLEX_URL, token: CONFIG.PLEX_TOKEN } : null;
  const rows = await inventory(CONFIG, { lastSuccessAt, plex });
  if (process.argv.includes('--json')) { process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`); return; }
  const mark = { exists: 'EXISTS ', missing: 'MISSING', off: 'OFF    ', unknown: '?      ' };
  for (const r of rows) process.stdout.write(`${mark[r.status]} ${r.source}: ${r.detail}\n`);
  process.stdout.write('\nRead-only: nothing was created, restored or deleted.\n');
})().catch(err => {
  process.stderr.write(`Backup inventory failed: ${err.message}\n`);
  process.exitCode = 1;
});
