'use strict';

// Dashboard routes for the Europe node sync (see src/europe-sync.js). Preview runs
// the script with DRY_RUN=true; a real run is confirmation-gated in the UI,
// rate-limited, and audited. Both return rendered HTML so the page's generic
// inline data-post handler can display the results without new client code.

const express = require('express');
const { createEuropeSync } = require('../europe-sync');

function registerEuropeSyncRoutes(app, deps) {
  const { audit, dashboardAuth, dashboardActor = () => ({}), db, rateLimit, escapeHtml, scriptPath } = deps;
  const json = express.json({ limit: '64kb' });
  const limiter = rateLimit({ windowMs: 60 * 1000, limit: 20 });
  const sync = createEuropeSync({ scriptPath });

  function statusPayload() {
    const status = sync.getStatus();
    let lastRun = null;
    try {
      const row = db.prepare(
        "SELECT created_at, details FROM audit_log WHERE action = 'dashboard_europe_sync_run' ORDER BY id DESC LIMIT 1"
      ).get();
      if (row) lastRun = { at: row.created_at, details: row.details };
    } catch (_e) { /* audit table may not exist in every test fixture */ }
    return { ...status, lastRun };
  }

  function resultToHtml(result, { live }) {
    const section = (title, items, emptyText) => {
      if (!items.length) return `<p class="muted">${escapeHtml(emptyText)}</p>`;
      return `<h4>${escapeHtml(title)} (${items.length})</h4><ul class="tier-manage-list">${items.map(i =>
        `<li><code>${escapeHtml(i.name)}</code>${i.year ? ` <span class="muted">(${escapeHtml(i.year)})</span>` : ''}</li>`
      ).join('')}</ul>`;
    };
    const verb = live ? 'did' : 'would';
    const summary = live
      ? `Sync complete: ${result.adds.length} added, ${result.removes.length} removed from the Europe folder, ${result.skips.length} skipped.`
      : `Dry run — nothing changed. This ${verb} add ${result.adds.length}, remove ${result.removes.length}, skip ${result.skips.length}.`;
    return `<div class="europe-sync-result"><p><strong>${escapeHtml(summary)}</strong></p>`
      + section(live ? 'Added' : 'Would add', result.adds, 'Nothing to add.')
      + section(live ? 'Removed' : 'Would remove', result.removes, 'Nothing to remove.')
      + section('Skipped (no video file — likely unreleased placeholders)', result.skips, 'Nothing skipped.')
      + `</div>`;
  }

  app.post('/admin/action/europe-sync/status', dashboardAuth, limiter, json, async (req, res) => {
    res.json({ ok: true, status: statusPayload() });
  });

  app.post('/admin/action/europe-sync/preview', dashboardAuth, limiter, json, async (req, res) => {
    const status = sync.getStatus();
    if (!status.scriptFound) {
      return res.status(503).json({ ok: false, error: `Sync script not found at ${scriptPath} on this host.` });
    }
    try {
      const result = await sync.preview();
      res.json({ ok: true, html: resultToHtml(result, { live: false }) });
    } catch (err) {
      audit('dashboard_europe_sync_failed', { ...dashboardActor(req), mode: 'preview', error: err.message });
      res.status(500).json({ ok: false, error: `Preview failed: ${err.message}` });
    }
  });

  app.post('/admin/action/europe-sync/run', dashboardAuth, limiter, json, async (req, res) => {
    const status = sync.getStatus();
    if (!status.scriptFound) {
      return res.status(503).json({ ok: false, error: `Sync script not found at ${scriptPath} on this host.` });
    }
    try {
      const result = await sync.run();
      audit('dashboard_europe_sync_run', {
        ...dashboardActor(req),
        added: result.adds.length,
        removed: result.removes.length,
        skipped: result.skips.length,
      });
      res.json({ ok: true, html: resultToHtml(result, { live: true }) });
    } catch (err) {
      audit('dashboard_europe_sync_failed', { ...dashboardActor(req), mode: 'run', error: err.message });
      res.status(500).json({ ok: false, error: `Sync failed: ${err.message}` });
    }
  });
}

module.exports = { registerEuropeSyncRoutes };
