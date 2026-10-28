#!/usr/bin/env node
// Service queue item 16: report-only Tailscale key-expiry audit for headless nodes. Reads the
// device list with a read-only token (OAuth scope devices:core:read) and prints each headless
// node's key expiry, flagging any inside TAILSCALE_KEY_EXPIRY_DAYS (default 30). Changes nothing.
//
//   node scripts/tailscale-audit.js
const { CONFIG } = require('../src/config');
const { provisionConfig } = require('../src/tailscale-provision');
const { auditConfigured, listDevices, auditDevices } = require('../src/tailscale-audit');

(async () => {
  const config = provisionConfig();
  if (!auditConfigured(config)) {
    process.stdout.write('Tailscale API is not configured (TAILSCALE_API_ENABLED, TAILSCALE_OAUTH_CLIENT_ID, TAILSCALE_OAUTH_CLIENT_SECRET).\n');
    process.exitCode = 1;
    return;
  }
  const rows = auditDevices(await listDevices(config), {
    windowDays: CONFIG.TAILSCALE_KEY_EXPIRY_DAYS, names: CONFIG.TAILSCALE_HEADLESS_NODES, viewerTag: config.viewerTag,
  });
  if (!rows.length) { process.stdout.write('No headless nodes found.\n'); return; }
  const label = { expired: 'EXPIRED', expiring: 'WARN   ', ok: 'ok     ', never: 'ok     ' };
  for (const r of rows) {
    const when = r.expiresAt == null ? 'key expiry off' : r.status === 'expired'
      ? `expired ${new Date(r.expiresAt).toISOString().slice(0, 10)}`
      : `expires ${new Date(r.expiresAt).toISOString().slice(0, 10)} (${r.daysLeft} days)`;
    process.stdout.write(`${label[r.status]} ${r.name} (${r.os}): ${when}\n`);
  }
  const due = rows.filter(r => r.status === 'expired' || r.status === 'expiring');
  process.stdout.write(due.length
    ? `\n${due.length} headless node(s) need a key renewal or key expiry turned off in the Tailscale admin console. Nothing was changed.\n`
    : `\nNo headless node key expires within ${CONFIG.TAILSCALE_KEY_EXPIRY_DAYS} days.\n`);
})().catch(err => {
  // Status and code only: never the request, which carries the client secret.
  const status = err?.response?.status;
  process.stderr.write(`Tailscale audit failed${status ? ` (HTTP ${status}${status === 400 || status === 403 ? ': the OAuth client may need the devices:core:read scope' : ''})` : `: ${err?.code || err?.message || 'request failed'}`}\n`);
  process.exitCode = 1;
});
