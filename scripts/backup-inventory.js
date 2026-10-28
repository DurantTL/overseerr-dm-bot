#!/usr/bin/env node
// Service queue item 18, step one: what backups exist today? Read-only; run inside the bot
// container so it sees the same config and data volume:
//
//   docker exec -it <bot-container> node scripts/backup-inventory.js          # report
//   docker exec -it <bot-container> node scripts/backup-inventory.js --json   # same, as JSON
//   docker exec -it <bot-container> node scripts/backup-inventory.js --check  # also verify what exists
//
// It lists backup files and reads settings. It never creates, restores or deletes a backup.
const { CONFIG } = require('../src/config');
const { inventory, verifyBackups } = require('../src/backup-inventory');

(async () => {
  let lastSuccessAt = null;
  try { lastSuccessAt = require('../src/db').getSetting('backup_last_success'); } catch (_err) { /* no database here */ }
  const plex = process.env.PLEX_URL && CONFIG.PLEX_TOKEN ? { url: process.env.PLEX_URL, token: CONFIG.PLEX_TOKEN } : null;
  const now = Date.now(); // one clock for the report and the check, so their ages agree
  const rows = await inventory(CONFIG, { lastSuccessAt, plex, now });
  if (process.argv.includes('--json')) { process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`); return; }
  const mark = { exists: 'EXISTS ', missing: 'MISSING', off: 'OFF    ', unknown: '?      ' };
  for (const r of rows) process.stdout.write(`${mark[r.status]} ${r.source}: ${r.detail}\n`);
  if (process.argv.includes('--check')) {
    process.stdout.write('\nVerification:\n');
    const verdicts = verifyBackups(rows, { now });
    for (const v of verdicts) process.stdout.write(`${v.ok === true ? 'OK     ' : v.ok === false ? 'PROBLEM' : '?      '} ${v.source}${v.problem ? `: ${v.problem}` : ''}\n`);
    if (verdicts.some(v => v.ok === false)) process.exitCode = 2;
  }
  process.stdout.write('\nRead-only: nothing was created, restored or deleted.\n');
})().catch(err => {
  process.stderr.write(`Backup inventory failed: ${err.message}\n`);
  process.exitCode = 1;
});
