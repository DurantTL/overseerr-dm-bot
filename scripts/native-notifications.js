#!/usr/bin/env node
// Service queue items 12 and 15: set the apps' own Discord notifications (Sonarr, Radarr, Radarr
// 4K, Prowlarr, Seerr, Tautulli) and, with AUTOPULSE_URL set, the *arrs' Autopulse import webhook,
// from the bot's existing config. See docs/native-notifications.md and docs/autopulse.md.
//
//   node scripts/native-notifications.js           # preview: reads each app, changes nothing
//   node scripts/native-notifications.js --apply   # make the changes the preview listed
//
// Run it inside the bot container so it sees the same environment. The Discord webhook comes from
// NATIVE_ALERTS_DISCORD_WEBHOOK and is never printed.
const axios = require('axios');
const { CONFIG } = require('../src/config');
const { planAll, applyPlan } = require('../src/native-notifications');

const apply = process.argv.includes('--apply');
const mark = { create: '+ ', update: '~ ', none: '= ', skip: '- ', error: '! ' };

(async () => {
  const plans = await planAll(CONFIG, { http: axios, webhookUrl: CONFIG.NATIVE_ALERTS_DISCORD_WEBHOOK });
  if (!plans.length) { process.stdout.write('Nothing to plan: no matching apps are configured.\n'); return; }
  for (const p of plans) process.stdout.write(`${mark[p.action] || '  '}${p.app}: ${p.detail}\n`);
  const pending = plans.filter(p => p.action === 'create' || p.action === 'update').length;
  if (!apply) {
    process.stdout.write(pending ? `\nPreview only. ${pending} change(s) listed; run with --apply to make them.\n` : '\nNothing to change.\n');
    if (plans.some(p => p.action === 'error')) process.exitCode = 1;
    return;
  }
  const results = await applyPlan(plans, CONFIG, { http: axios });
  process.stdout.write('\n');
  for (const r of results) process.stdout.write(`${r.ok ? 'OK  ' : 'FAIL'} ${r.app}: ${r.detail}\n`);
  if (results.some(r => !r.ok) || plans.some(p => p.action === 'error')) process.exitCode = 1;
})().catch(err => {
  process.stderr.write(`${err.message}\n`);
  process.exitCode = 1;
});
