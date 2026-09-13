'use strict';

function registerDashboardReadRoutes(app, deps) {
  const {
    CONFIG,
    PASSKEY_RP,
    arrSources,
    buildSyncPreview,
    canEscalate,
    dashboardActionError,
    dashboardAuth,
    db,
    discordReadyGuard,
    escapeHtml,
    fetchArrQueues,
    fetchDiskSpace,
    fetchOverseerrUsers,
    fmtAgo,
    fmtDuration,
    fmtSpace,
    forecastDisks,
    forecastLabel,
    gatherHealth,
    gatherIncompleteRequests,
    getAutomationRegistry = () => null,
    getGuildMembers,
    getTierPlan,
    grabDailyAllowance,
    httpRateLimitKey,
    listActiveGrabJobs,
    listActiveStageJobs,
    listMediaPriority,
    listPasskeys,
    listPendingRequests,
    listRadarrMovies,
    listSeasonAlertStates,
    listSonarrMissingEpisodes,
    listSonarrSeries,
    listTierNodeFolders,
    listTierNodes,
    mediaTypeLabel,
    normalizeSearchQuery,
    queueItemLooksUnhealthy,
    queuePercent,
    quotaBlockReason,
    rateLimit,
    renderAutomationRegistry = () => '',
    renderHealthBadges,
    renderItemList,
    renderPage,
    renderPasskeyManagement,
    renderSettingsGroup,
    renderStat,
    renderTable,
    renderTierNodeSetup,
    runEdgeDiagnostics,
    checkPublicOriginReadiness = async () => [],
    runtimeSettings,
    searchDashboard,
    seasonAlertDashboardItems,
    settingsStore,
    sqliteUtcMs,
    tautulliApi,
    tautulliConfigured,
    tierNodeStatus,
    tunable,
  } = deps;
  app.get('/admin', rateLimit({
    windowMs: 15 * 60000,
    limit: 300,
    keyGenerator: httpRateLimitKey,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, res) => res.status(429).json({ ok: false, error: 'Too many dashboard requests. Wait a moment and try again.' }),
  }), dashboardAuth, async (_req, res) => {
    const now = Date.now();
    const pendingApprovals = listPendingRequests();
    const passkeys = listPasskeys();
    // Live activity: every external read is failure-tolerant so one dead integration never
    // takes the dashboard down — null means "couldn't reach it", rendered as such.
    const [health, sessions, queue, disks, edgeChecks, members, pendingQuota] = await Promise.all([
      gatherHealth(),
      tautulliConfigured() ? tautulliApi('get_activity').then(d => d?.sessions || []).catch(() => null) : Promise.resolve(null),
      arrSources().length ? fetchArrQueues().catch(() => null) : Promise.resolve(null),
      arrSources().length ? fetchDiskSpace().catch(() => null) : Promise.resolve(null),
      runEdgeDiagnostics({ live: false }).catch(() => []),
      pendingApprovals.length ? getGuildMembers().catch(() => []) : Promise.resolve([]),
      Promise.all(pendingApprovals.map(pending => quotaBlockReason(pending.seerrUserId, pending.discordId, pending.mediaType, { tmdbId: pending.tmdbId, is4k: pending.is4k }, true)
        .then(warning => ({ warning, error: null }))
        .catch(err => ({ warning: null, error: dashboardActionError(err) })))),
    ]);
    const grabJobs = listActiveGrabJobs();
    const stageJobs = listActiveStageJobs();
    const escalations = db.prepare("SELECT * FROM escalations WHERE state IN ('watching','alerted','error') ORDER BY approved_at").all();
    // Depends on the queue above, so it runs after rather than inside that Promise.all. Null on
    // failure (Sonarr unreachable) so the card says so instead of claiming everything is fine.
    const incomplete = await gatherIncompleteRequests({ queue: queue || [], grabJobs, escalations, now }).catch(() => null);
    const pendingDeletions = db.prepare("SELECT * FROM pending_deletions WHERE status = 'pending' ORDER BY delete_after LIMIT 25").all();
    const tierNodes = listTierNodes();
    // Latest agent report per tier node, from the audit log.
    const lastReportByNode = {};
    for (const r of db.prepare("SELECT * FROM audit_log WHERE action = 'tier_agent_report' ORDER BY id DESC LIMIT 100").all()) {
      try {
        const m = JSON.parse(r.metadata_json);
        if (m.node && !lastReportByNode[m.node]) lastReportByNode[m.node] = { ...m, at: r.created_at };
      } catch (_e) {}
    }

    const pendingPlex = db.prepare('SELECT * FROM users WHERE invited = 0 ORDER BY requested_at DESC LIMIT 25').all();
    const pendingRequestCount = db.prepare("SELECT COUNT(*) AS c FROM requests WHERE status = 'pending'").get().c;
    const recentRequests = db.prepare('SELECT * FROM requests ORDER BY id DESC LIMIT 50').all();
    const linkedUsers = db.prepare('SELECT discord_id, email, invited, requested_at, home_server FROM users ORDER BY requested_at DESC LIMIT 100').all();
    const recentDownloads = db.prepare('SELECT * FROM download_access_log ORDER BY id DESC LIMIT 25').all();
    const auditRows = db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 50').all();
    const linkedTotal = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
    const activeLinks = db.prepare('SELECT COUNT(*) AS c FROM download_tokens WHERE revoked = 0 AND expires_at > ?').get(now).c;

    const memberNames = new Map(members.map(member => [member.user.id, member.displayName || member.user.globalName || member.user.username || member.user.tag]));
    const approvalItems = pendingApprovals.map((pending, index) => {
      const quota = pendingQuota[index];
      const azAvailable = canEscalate(pending);
      const createdAt = typeof pending.createdAt === 'number' ? pending.createdAt : sqliteUtcMs(pending.createdAt);
      return {
        state: quota.error || quota.warning ? 'warn' : 'ok',
        title: pending.label,
        sub: `${memberNames.get(pending.discordId) || pending.discordId} · ${mediaTypeLabel(pending.mediaType, pending.is4k)} · quota: ${quota.error ? `unavailable (${quota.error})` : (quota.warning || 'within limit')} · AvistaZ pre-auth ${azAvailable ? 'available' : 'unavailable'}`,
        right: createdAt ? `waiting ${fmtDuration(Math.max(0, now - createdAt))}` : 'waiting age unknown',
        actions: [
          { label: 'Approve', url: '/admin/action/gate', body: { operation: 'approve', nonce: pending.nonce }, inline: true },
          { label: 'Approve + AvistaZ fallback', url: '/admin/action/gate', body: { operation: 'approve_az', nonce: pending.nonce }, inline: true, disabled: !azAvailable, title: azAvailable ? '' : 'AvistaZ pre-auth is unavailable for this request.' },
          { label: 'Deny', url: '/admin/action/gate', body: { operation: 'deny', nonce: pending.nonce }, inline: true, danger: true },
        ],
      };
    });

    const stats = [
      renderStat('Streaming', sessions === null ? '—' : sessions.length),
      renderStat('Downloading', queue === null ? '—' : queue.length),
      renderStat('Active jobs', grabJobs.length + stageJobs.length),
      renderStat('Watching', escalations.length),
      renderStat('Incomplete', incomplete === null ? '—' : incomplete.length),
      renderStat('Tier nodes', `${tierNodes.filter(n => n.enabled).length}/${tierNodes.length}`),
      renderStat('Pending requests', pendingRequestCount),
      renderStat('Linked users', linkedTotal),
      renderStat('Download links', activeLinks),
    ].join('');

    const decisionLabel = s => (s.transcode_decision === 'transcode' || s.video_decision === 'transcode' ? '🔥 transcoding'
      : s.transcode_decision === 'copy' ? '📼 direct stream' : '▶️ direct play');
    const nowPlayingItems = (sessions || []).map(s => ({
      state: (s.transcode_decision === 'transcode' || s.video_decision === 'transcode') ? 'warn' : 'ok',
      title: s.full_title || 'Unknown',
      sub: `${s.friendly_name || s.user || 'Unknown'} · ${decisionLabel(s)}${s.stream_video_full_resolution ? ` · ${s.stream_video_full_resolution}` : ''}${s.player ? ` · ${s.player}` : ''}`,
      pct: Number(s.progress_percent) || 0,
    }));

    const queueItems = (queue || []).map(q => ({
      state: queueItemLooksUnhealthy(q) ? 'warn' : 'ok',
      title: q.title,
      sub: `${q.source.label} · ${q.status}${q.trackedState ? ` (${q.trackedState})` : ''}${q.messages.length ? ` · ⚠️ ${q.messages[0]}` : ''}`,
      right: `${fmtSpace(Math.max(0, q.size - q.sizeleft))} / ${fmtSpace(q.size)}${q.timeleft ? ` · ${q.timeleft}` : ''}`,
      pct: queuePercent(q),
    }));

    const jobItems = [
      ...grabJobs.map(j => ({
        state: j.state === 'failed' ? 'down' : 'ok',
        title: j.release_title || j.title,
        sub: `seedbox grab #${j.id} · ${j.state}${j.error ? ` · ${j.error}` : ''}`,
        right: `${fmtSpace(j.size_bytes || 0)}${j.sent_at ? ` · started ${fmtAgo(j.sent_at)}` : ''}`,
      })),
      ...stageJobs.map(j => ({
        state: j.status === 'failed' ? 'down' : 'ok',
        title: j.title,
        sub: `PH stage #${j.id} · ${j.status}`,
        right: `${fmtSpace(j.size_bytes || 0)}${j.started_at ? ` · started ${fmtAgo(j.started_at)}` : ''}`,
      })),
    ];
    const allowance = grabDailyAllowance();
    const watchItems = [
      ...escalations.map(e => ({
        state: 'warn',
        title: e.title,
        sub: `escalation watch · ${e.state}${e.pre_authorized ? ' · pre-authorized' : ''}`,
        right: `approved ${fmtAgo(e.approved_at)}`,
        actions: [{
          label: allowance.limited ? `Escalate now (${allowance.remaining} left)` : 'Escalate now',
          url: '/admin/action/escalate',
          body: { id: e.id },
          confirm: allowance.limited
            ? `Escalate ${e.title} now? This can spend one of ${allowance.remaining} remaining AvistaZ downloads today.`
            : `Escalate ${e.title} to AvistaZ now?`,
          danger: true,
          disabled: allowance.exhausted,
        }],
      })),
      ...pendingDeletions.map(p => ({
        state: 'skip',
        title: p.title || p.media_id,
        sub: 'pending deletion (finished-watching prompt)',
        right: `deletes ${fmtAgo(p.delete_after)}`,
      })),
    ];
    const priorityItems = listMediaPriority().map((item, index, all) => ({
      state: 'ok',
      title: item.title,
      sub: `${mediaTypeLabel(item.media_type, false)} · ${item.key}`,
      right: `rank ${item.rank}`,
      actions: [
        { label: 'Up', url: '/admin/action/priority', body: { operation: 'move', key: item.key, direction: -1 }, disabled: index === 0 },
        { label: 'Down', url: '/admin/action/priority', body: { operation: 'move', key: item.key, direction: 1 }, disabled: index === all.length - 1 },
        { label: 'Unpin', url: '/admin/action/priority', body: { operation: 'unpin', key: item.key } },
      ],
    }));
    const seasonAlertItems = seasonAlertDashboardItems(listSeasonAlertStates({ stoodDownOnly: true }));
    const automationInventory = getAutomationRegistry()?.list() || [];
    const sweepItems = automationInventory.filter(item => item.manual.enabled).map(item => ({
      state: item.enabled ? 'skip' : 'warn',
      title: item.label,
      sub: item.enabled ? 'Registry-approved manual action' : item.disabledReason,
      actions: [{ label: 'Run now', url: '/admin/action/sweep', body: { name: item.id }, disabled: !item.enabled }],
    }));

    const tierItems = tierNodes.map(n => {
      const plan = getTierPlan(n.name);
      const rep = lastReportByNode[n.name];
      const status = tierNodeStatus(plan, rep, now, CONFIG.TIER_PLAN_STALE_DAYS);
      return {
        state: !n.enabled ? 'skip' : status.state,
        title: `${n.name}${n.full ? ' · full master' : ''}${n.sticky ? ' · sticky' : ''}`,
        sub: `${n.access} · ${n.demand_source}${n.demand_source === 'atime' && n.atime_mask ? ` (mask ${n.atime_mask})` : ''} · ${n.transport} · ${fmtSpace(n.usable_bytes || 0)} @ ${n.headroom_pct}% headroom · ${status.details}`,
        right: status.status,
        actions: status.setup ? [{ label: 'Set up this node', setupNode: n.name }] : [],
      };
    });

    const diskItems = forecastDisks(db, disks || [], now).map(d => {
      const used = (d.totalSpace || 0) - (d.freeSpace || 0);
      const pct = d.totalSpace ? Math.round((used / d.totalSpace) * 100) : 0;
      return {
        state: (tunable('DISK_SPACE_WARN_GB') > 0 && (d.freeSpace || 0) < tunable('DISK_SPACE_WARN_GB') * 1024 ** 3)
          || (tunable('DISK_FORECAST_WARN_DAYS') > 0 && d.forecast.status === 'projected' && d.forecast.daysRemaining <= tunable('DISK_FORECAST_WARN_DAYS')) ? 'warn' : 'ok',
        title: d.root,
        sub: `${fmtSpace(d.freeSpace || 0)} free of ${fmtSpace(d.totalSpace || 0)} · ${forecastLabel(d.forecast)}`,
        right: `${pct}% used`,
        pct,
      };
    });

    const plexUserRows = pendingPlex.map(u => ({ email: u.email, discord: u.discord_id, requested: fmtAgo(u.requested_at) }));
    const requestRows = recentRequests.map(r => ({ title: r.title, status: r.status, type: mediaTypeLabel(r.media_type, r.is_4k), seerr: r.overseerr_request_id || 'provisional', requester: r.requested_by_discord_id || '—', when: fmtAgo(sqliteUtcMs(r.created_at)) }));
    const linkedRows = linkedUsers.map(u => ({ email: u.email, discord: u.discord_id, group: u.home_server === 'ph' ? 'Philippines' : 'Main', invited: u.invited ? '✅' : '⏳', since: fmtAgo(u.requested_at) }));
    const downloadRows = recentDownloads.map(d => ({ when: fmtAgo(sqliteUtcMs(d.created_at)), file: (d.file_path || '').split('/').pop() || '—', status: d.status, sent: d.bytes_sent ? fmtSpace(d.bytes_sent) : '', ip: d.ip || '' }));
    const auditTableRows = auditRows.map(a => ({ when: fmtAgo(sqliteUtcMs(a.created_at)), action: a.action, details: String(a.metadata_json || '').slice(0, 160) }));

    const unavailable = which => `<p class="muted">${escapeHtml(which)} unreachable or not configured.</p>`;
    const nav = [['overview', 'Overview'], ['operations', 'Operations'], ['automation', 'Automation'], ['edge', 'Edge'], ['people', 'People'], ['logs', 'Logs']];
    const settingsGroups = runtimeSettings.describeRuntimeSettings({ config: CONFIG, store: settingsStore });
    const overriddenCount = settingsGroups.reduce((n, g) => n + g.settings.filter(x => x.overridden).length, 0);

    const body = `
      <div class="overall ${health.overall === 'ok' ? 'ok' : 'warn'}">
        <span>Overall: <strong>${escapeHtml(String(health.overall).toUpperCase())}</strong></span>
        <span class="updated">updated ${new Date(now).toISOString().slice(11, 19)} UTC · auto-refreshes</span>
      </div>
      <div class="stats">${stats}</div>

      <section class="panel" data-panel="overview">
        ${renderPasskeyManagement(passkeys, PASSKEY_RP.rpID, PASSKEY_RP.origin)}
        <div class="card">
          <h2>Integrations</h2>
          <div class="badges">${renderHealthBadges(health)}</div>
          ${Object.keys(health.errors || {}).length ? renderItemList(Object.entries(health.errors).map(([name, error]) => ({ state: 'down', title: name, sub: error })), '') : ''}
        </div>
        <div class="card">
          <h2>▶️ Now Streaming</h2>
          ${sessions === null ? unavailable('Tautulli') : renderItemList(nowPlayingItems, 'Nobody is streaming right now.')}
        </div>
        <div class="card">
          <h2>⬇️ Downloading</h2>
          ${queue === null ? unavailable('Radarr/Sonarr') : renderItemList(queueItems, 'Nothing in the download queues.')}
        </div>
        <div class="card">
          <h2>💾 Disk Space</h2>
          ${disks === null ? unavailable('*arr diskspace') : renderItemList(diskItems, 'No disks reported.')}
        </div>
      </section>

      <section class="panel" data-panel="operations">
        <div class="card">
          <h2>Pending Approval<span class="sub">Requests waiting for an administrator. Quota changes are warnings and do not block approval.</span></h2>
          ${renderItemList(approvalItems, 'No requests are waiting for approval.')}
        </div>
        <div class="card">
          <h2>🧩 Not Watchable Yet<span class="sub">Requests still missing content — including series Seerr already calls "available" but that are missing aired episodes. Worst first.</span></h2>
          ${incomplete === null ? unavailable('Sonarr') : renderItemList(incomplete, 'Every request is complete — nothing missing.')}
        </div>
        <div class="card">
          <h2>⚙️ Active Jobs</h2>
          ${renderItemList(jobItems, 'No seedbox grabs or staging copies running.')}
        </div>
        <div class="card">
          <h2>👀 Watching / Scheduled</h2>
          ${renderItemList(watchItems, 'No escalation watches or pending deletions.')}
        </div>
        <div class="card">
          <h2>Pinned Media<span class="sub">Pinned titles run first in capped Sonarr sweeps. Reorder them here.</span></h2>
          ${renderItemList(priorityItems, 'No titles are pinned.')}
        </div>
        <div class="card">
          <h2>Recent Media Requests</h2>
          ${renderTable(requestRows)}
        </div>
        <div class="card">
          <h2>Manual Actions</h2>
          ${renderItemList(sweepItems, '')}
          <div class="actions">
            <a class="btn" href="/admin/health">Health JSON</a>
            <a class="btn" href="/admin/doctor">Edge Doctor JSON</a>
            <a class="btn" href="/admin/action/sync-preview">Sync Preview</a>
            <a class="btn" href="/admin/action/cleanup-preview">Cleanup Preview</a>
            <button class="btn danger" type="button" onclick="revokeAll()">Revoke All Download Links</button>
          </div>
        </div>
      </section>

      <section class="panel" data-panel="automation">
        <p class="panel-intro">These take effect on the next sweep — no redeploy. Compose stays the default:
          <strong>Reset to compose</strong> drops the override and the stack file's value applies again.
          ${overriddenCount ? `<strong>${overriddenCount}</strong> setting${overriddenCount === 1 ? ' is' : 's are'} currently overridden here.` : 'Nothing is overridden right now.'}</p>
        <div class="card">
          <h2>Season-search alert stand-downs<span class="sub">Searches still run. Only repeated identical no-release messages are muted.</span></h2>
          ${renderItemList(seasonAlertItems, 'No season-search alerts are stood down.')}
        </div>
        ${renderAutomationRegistry(automationInventory)}
        ${settingsGroups.map(renderSettingsGroup).join('')}
      </section>

      <section class="panel" data-panel="edge">
        <div class="card">
          <h2>📦 Tier Nodes</h2>
          ${renderItemList(tierItems, 'No tier nodes registered yet.')}
        </div>
        ${renderTierNodeSetup(tierNodes.map(node => ({ ...node, folders: listTierNodeFolders(node.name) })))}
        <div class="card">
          <h2>🩺 Edge Readiness</h2>
          ${renderItemList(edgeChecks.map(c => ({ state: c.status === 'fail' ? 'down' : c.status, title: c.name, sub: c.detail })), 'No edge checks available.')}
        </div>
      </section>

      <section class="panel" data-panel="people">
        <div class="card">
          <h2>Pending Plex Users</h2>
          ${renderTable(plexUserRows)}
        </div>
        <div class="card">
          <h2>Linked Users</h2>
          ${renderTable(linkedRows)}
        </div>
      </section>

      <section class="panel" data-panel="logs">
        <div class="card">
          <h2>Recent Downloads</h2>
          ${renderTable(downloadRows)}
        </div>
        <div class="card">
          <h2>Recent Audit Log</h2>
          ${renderTable(auditTableRows)}
        </div>
      </section>

      <script src="/admin/passkey-client.js"></script>
      <script src="/admin/webauthn-browser.js"></script>
      <script>
        async function revokeAll() {
          if (!confirm('Revoke ALL active download links? This cannot be undone.')) return;
          const r = await fetch('/admin/action/revoke-all', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
          alert(r.ok ? 'All active download links revoked.' : 'Failed: ' + r.status);
          if (r.ok) location.reload();
        }
        document.querySelectorAll('[data-post]').forEach(function (btn) {
          btn.addEventListener('click', async function () {
            var prompt = btn.dataset.confirm;
            if (prompt && !confirm(prompt)) return;
            var body = JSON.parse(btn.dataset.body || '{}');
            if (prompt) body.confirmed = true;
            var item = btn.closest('.item-main');
            var buttons = btn.dataset.inline && item ? [].slice.call(item.querySelectorAll('[data-post]')) : [btn];
            var buttonStates = buttons.map(function (button) { return { button: button, disabled: button.disabled }; });
            var note = btn.dataset.inline && item ? item.querySelector('.action-result') : null;
            buttons.forEach(function (button) { button.disabled = true; });
            if (note) { note.textContent = 'Workingâ€¦'; note.className = 'action-result'; }
            try {
              var r = await fetch(btn.dataset.post, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
              var result = await r.json().catch(function () { return {}; });
              var ok = r.ok && result.ok !== false;
              var message = ok ? (result.message || 'Action completed.') : (result.error || 'Request failed: ' + r.status);
              if (note) {
                note.textContent = message;
                note.className = 'action-result ' + (ok ? 'ok' : 'bad');
                if (!ok && result.retryable) buttonStates.forEach(function (state) { state.button.disabled = state.disabled; });
              } else {
                alert(message);
                if (ok) location.reload();
              }
            } catch (err) {
              var message = String(err && err.message || err);
              if (note) { note.textContent = message; note.className = 'action-result bad'; }
              else alert(message);
              buttonStates.forEach(function (state) { state.button.disabled = state.disabled; });
            }
          });
        });
        (function () {
          var enroll = document.getElementById('passkey-enroll');
          var note = document.getElementById('passkey-note');
          var expectedOrigin = (document.getElementById('passkeys') || {}).dataset ? document.getElementById('passkeys').dataset.passkeyOrigin : '';
          var passkeyReady = !enroll || (!!window.PasskeyClient && window.PasskeyClient.preparePasskeyAction(enroll, note, window, '', expectedOrigin));
          if (enroll && !window.PasskeyClient) {
            enroll.disabled = true;
            note.textContent = 'Passkey support could not be checked. Open this HTTPS dashboard in Safari, Chrome, Edge, or another WebAuthn-capable browser.';
            note.className = 'save-note bad';
          }
          var post = async function (url, body) {
            var response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
            var result = await response.json().catch(function () { return {}; });
            if (!response.ok) throw new Error(result.error || 'Passkey request failed.');
            return result;
          };
          if (enroll && passkeyReady) enroll.addEventListener('click', async function () {
            var label = document.getElementById('passkey-label').value.trim();
            if (!label) { note.textContent = 'Enter a device label.'; note.className = 'save-note bad'; return; }
            enroll.disabled = true;
            try {
              var optionsJSON = await post('/admin/passkey/registration-options', { label: label });
              var response = await SimpleWebAuthnBrowser.startRegistration({ optionsJSON: optionsJSON });
              await post('/admin/passkey/register', response);
              location.hash = 'overview';
              location.reload();
            } catch (error) {
              note.textContent = window.PasskeyClient ? window.PasskeyClient.passkeyErrorMessage(error, window, expectedOrigin) : (error.message || String(error));
              note.className = 'save-note bad';
              enroll.disabled = false;
            }
          });
          document.querySelectorAll('[data-passkey-rename]').forEach(function (button) {
            button.addEventListener('click', async function () {
              var row = button.closest('[data-passkey]');
              try { await post('/admin/passkey/rename', { credentialId: row.dataset.passkey, label: row.querySelector('input').value }); location.reload(); }
              catch (error) { note.textContent = error.message || String(error); note.className = 'save-note bad'; }
            });
          });
          document.querySelectorAll('[data-passkey-revoke]').forEach(function (button) {
            button.addEventListener('click', async function () {
              if (!confirm('Revoke this passkey? That device will no longer be able to sign in.')) return;
              var row = button.closest('[data-passkey]');
              try { await post('/admin/passkey/revoke', { credentialId: row.dataset.passkey }); location.reload(); }
              catch (error) { note.textContent = error.message || String(error); note.className = 'save-note bad'; }
            });
          });
        })();
        document.querySelectorAll('[data-setup-node]').forEach(function (btn) {
          btn.addEventListener('click', function () {
            var form = document.getElementById('tier-install-form');
            if (!form) return;
            form.elements.node.value = btn.dataset.setupNode;
            form.elements.node.dispatchEvent(new Event('change'));
            document.getElementById('tier-node-setup').scrollIntoView({ behavior: 'smooth' });
            var firstFolder = form.querySelector('[name="folderId"]');
            if (firstFolder) firstFolder.focus();
          });
        });
        (function () {
          var registerForm = document.getElementById('tier-register-form');
          var installForm = document.getElementById('tier-install-form');
          var folderList = document.getElementById('tier-folder-list');
          var folderRow = function (folder) {
            var row = document.createElement('div');
            row.className = 'tier-folder-row';
            row.innerHTML = '<label>Syncthing folder ID<input name="folderId" placeholder="e.g. movies"></label>'
              + '<label>Local folder path<input name="folderRoot" placeholder="/mnt/media/Media/Movies"></label>'
              + '<button class="btn tier-folder-remove" type="button">Remove</button>';
            row.querySelector('[name="folderId"]').value = folder && (folder.folderId || folder.id) || '';
            row.querySelector('[name="folderRoot"]').value = folder && (folder.folderRoot || folder.path) || '';
            return row;
          };
          var ensureFourFolderRows = function () {
            if (!folderList) return;
            while (folderList.children.length < 4) folderList.appendChild(folderRow());
          };
          if (folderList) {
            folderList.addEventListener('click', function (event) {
              var button = event.target.closest('.tier-folder-remove');
              if (!button) return;
              button.closest('.tier-folder-row').remove();
              ensureFourFolderRows();
              window.__dirtySettings = true;
            });
            document.getElementById('tier-folder-add').addEventListener('click', function () {
              folderList.appendChild(folderRow());
              window.__dirtySettings = true;
            });
          }
          if (installForm) installForm.elements.node.addEventListener('change', function () {
            var option = this.options[this.selectedIndex];
            var folders = [];
            try { folders = JSON.parse(option.dataset.folders || '[]'); } catch (_e) {}
            folderList.replaceChildren();
            folders.forEach(function (folder) { folderList.appendChild(folderRow(folder)); });
            ensureFourFolderRows();
          });
          var mountGuardNote = document.getElementById('tier-mount-guard-note');
          var updateMountGuardNote = function () {
            if (!mountGuardNote || !installForm) return;
            var configured = !!(installForm.elements.mountRoot.value.trim() && installForm.elements.mountMarker.value.trim());
            mountGuardNote.innerHTML = configured
              ? '✅ Mount guard: <strong>configured</strong>.'
              : '⚠️ Mount guard: <strong>NOT configured</strong> — if this node has an external/removable media drive, a failed remount after reboot will go undetected and the agent may report an empty inventory. Fill in both fields above to enable it; leave both blank only for a master/single-disk node.';
            mountGuardNote.className = 'setup-warning' + (configured ? ' ok' : '');
          };
          if (installForm) { updateMountGuardNote(); installForm.addEventListener('input', updateMountGuardNote); }
          [registerForm, installForm].filter(Boolean).forEach(function (form) {
            form.addEventListener('input', function () { window.__dirtySettings = true; });
          });
          if (registerForm) registerForm.addEventListener('submit', async function (event) {
            event.preventDefault();
            var values = Object.fromEntries(new FormData(registerForm));
            values.full = registerForm.elements.full.checked;
            var note = document.getElementById('tier-register-note');
            var r = await fetch('/admin/action/tier-node', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(values) });
            var result = await r.json().catch(function () { return {}; });
            if (!r.ok || result.ok === false) { note.textContent = result.error || 'Registration failed.'; note.className = 'save-note bad'; return; }
            window.__dirtySettings = false;
            location.hash = 'edge';
            location.reload();
          });
          if (installForm) installForm.addEventListener('submit', async function (event) {
            event.preventDefault();
            var values = Object.fromEntries(new FormData(installForm));
            values.folders = [].slice.call(folderList.querySelectorAll('.tier-folder-row')).map(function (row) {
              return { id: row.querySelector('[name="folderId"]').value.trim(), path: row.querySelector('[name="folderRoot"]').value.trim() };
            }).filter(function (folder) { return folder.id || folder.path; });
            delete values.folderId;
            delete values.folderRoot;
            var note = document.getElementById('tier-install-note');
            if (!values.folders.length || values.folders.some(function (folder) { return !folder.id || !folder.path; })) {
              note.textContent = 'Add at least one complete folder ID/path pair; remove or finish partial rows.';
              note.className = 'save-note bad';
              return;
            }
            if (!!values.mountRoot !== !!values.mountMarker) {
              note.textContent = 'Mount root and mount marker must be supplied together.';
              note.className = 'save-note bad';
              return;
            }
            var mountGuardWarning = (!values.mountRoot && !values.mountMarker)
              ? 'Mount guard: NOT configured for this node — an external drive that fails to remount will go undetected.\n\n'
              : '';
            if (!confirm(mountGuardWarning + 'Save this complete folder list and rotate the node token? The existing agent will stop working until this new command is installed.')) return;
            values.confirmed = true;
            var r = await fetch('/admin/action/tier-token', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(values) });
            var result = await r.json().catch(function () { return {}; });
            if (!r.ok || result.ok === false) { note.textContent = result.error || 'Command generation failed.'; note.className = 'save-note bad'; return; }
            document.getElementById('tier-install-command').textContent = result.command;
            document.getElementById('tier-install-mount-status').textContent = (values.mountRoot && values.mountMarker)
              ? '✅ Mount guard: configured.' : '⚠️ Mount guard: NOT configured on this node.';
            document.getElementById('tier-install-result').hidden = false;
            installForm.elements.node.options[installForm.elements.node.selectedIndex].dataset.folders = JSON.stringify(values.folders);
            note.textContent = 'Token rotated. Copy this command now.';
            note.className = 'save-note ok';
          });
          var copy = document.getElementById('tier-copy-command');
          if (copy) copy.addEventListener('click', async function () {
            await navigator.clipboard.writeText(document.getElementById('tier-install-command').textContent);
            copy.textContent = 'Copied';
          });
        })();
        (function () {
          var note = function (group, text, cls) {
            var el = document.querySelector('[data-note="' + group + '"]');
            if (el) { el.textContent = text; el.className = 'save-note' + (cls ? ' ' + cls : ''); }
          };
          var inputsFor = function (group) {
            return [].slice.call(document.querySelectorAll('[data-group="' + group + '"] [data-key]'));
          };
          // Any edit blocks the auto-refresh until it is saved, so a pending change can't be
          // silently thrown away by the 60s reload.
          document.addEventListener('input', function (e) { if (e.target.dataset && e.target.dataset.key) window.__dirtySettings = true; });
          document.addEventListener('change', function (e) { if (e.target.dataset && e.target.dataset.key) window.__dirtySettings = true; });
          var post = async function (url, payload, group, okText) {
            note(group, 'Saving…');
            try {
              var r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
              var body = await r.json().catch(function () { return {}; });
              if (!r.ok || body.ok === false) { note(group, (body.errors || ['Failed: ' + r.status]).join('; '), 'bad'); return; }
              window.__dirtySettings = false;
              note(group, okText, 'ok');
              setTimeout(function () { location.reload(); }, 700);
            } catch (err) { note(group, String(err && err.message || err), 'bad'); }
          };
          document.querySelectorAll('[data-preview]').forEach(function (btn) {
            btn.addEventListener('click', async function () {
              var group = btn.dataset.preview;
              var values = {};
              inputsFor(group).forEach(function (el) {
                values[el.dataset.key] = el.dataset.type === 'bool' ? (el.checked ? '1' : '0') : el.value;
              });
              note(group, 'Calculating preview...');
              try {
                var sweep = group.replace(/_/g, '-');
                var r = await fetch('/admin/action/sweep-preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: sweep, values: values }) });
                var body = await r.json().catch(function () { return {}; });
                if (!r.ok || body.ok === false) { note(group, body.error || 'Preview failed.', 'bad'); return; }
                var result = document.querySelector('[data-preview-result="' + group + '"]');
                result.replaceChildren();
                var heading = document.createElement('p');
                heading.textContent = body.items.length ? body.items.length + ' item(s) evaluated:' : 'No items would be actioned.';
                result.appendChild(heading);
                if (body.items.length) {
                  var list = document.createElement('ul');
                  body.items.forEach(function (item) {
                    var row = document.createElement('li');
                    row.textContent = item.title + ': ' + item.stage + ' — ' + item.reason;
                    list.appendChild(row);
                  });
                  result.appendChild(list);
                }
                note(group, 'Preview uses the unsaved values above.', 'ok');
              } catch (err) { note(group, String(err && err.message || err), 'bad'); }
            });
          });
          document.querySelectorAll('[data-save]').forEach(function (btn) {
            btn.addEventListener('click', function () {
              var group = btn.dataset.save;
              var values = {};
              inputsFor(group).forEach(function (el) {
                values[el.dataset.key] = el.dataset.type === 'bool' ? (el.checked ? '1' : '0') : el.value;
              });
              post('/admin/settings', { values: values }, group, 'Saved.');
            });
          });
          document.querySelectorAll('[data-reset]').forEach(function (btn) {
            btn.addEventListener('click', function () {
              var group = btn.dataset.reset;
              if (!confirm('Drop the overrides for this group and use the compose values again?')) return;
              post('/admin/settings/reset', { keys: inputsFor(group).map(function (el) { return el.dataset.key; }) }, group, 'Reset to compose.');
            });
          });
        })();
      </script>`;
    res.type('html').send(renderPage('Dashboard', body, { showLogout: true, showSearch: true, nav, autoRefresh: true, tabs: true }));
  });

  app.get('/admin/search', rateLimit({
    windowMs: 15 * 60000,
    limit: 300,
    keyGenerator: httpRateLimitKey,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, res) => res.status(429).json({ ok: false, error: 'Too many dashboard requests. Wait a moment and try again.' }),
  }), dashboardAuth, async (req, res) => {
    const normalized = normalizeSearchQuery(req.query.q);
    if (!normalized.query) {
      return res.type('html').send(renderPage('Search', '<div class="card"><h2>Search</h2><p class="muted">Enter at least 2 characters.</p></div>', { showLogout: true, showSearch: true }));
    }
    if (normalized.error) {
      return res.status(400).type('html').send(renderPage('Search', `<div class="card"><h2>Search</h2><div class="error">${escapeHtml(normalized.error)}</div></div>`, { showLogout: true, showSearch: true, searchQuery: normalized.query }));
    }
    const [members, queues, series, missingEpisodes, movies] = await Promise.all([
      getGuildMembers().catch(() => []),
      arrSources().length ? fetchArrQueues().catch(() => []) : Promise.resolve([]),
      CONFIG.SONARR_URL ? listSonarrSeries().catch(() => []) : Promise.resolve([]),
      CONFIG.SONARR_URL ? listSonarrMissingEpisodes().catch(() => []) : Promise.resolve([]),
      (CONFIG.RADARR_URL || CONFIG.RADARR_4K_URL) ? listRadarrMovies().catch(() => []) : Promise.resolve([]),
    ]);
    const now = Date.now();
    const results = searchDashboard({
      query: normalized.query,
      requests: db.prepare('SELECT * FROM requests ORDER BY id DESC').all(),
      users: db.prepare('SELECT * FROM users ORDER BY requested_at DESC').all(),
      auditRows: db.prepare('SELECT created_at, action, metadata_json FROM audit_log ORDER BY id DESC').all(),
      downloadTokens: db.prepare('SELECT discord_id, revoked, expires_at FROM download_tokens').all(),
      members: members.filter(member => !member.user?.bot).map(member => ({ discordId: member.user.id, name: member.displayName || member.user.globalName || member.user.username || member.user.tag })),
      queues, series, missingEpisodes, movies, now,
    });
    const requestRows = results.requests.map(row => ({ title: row.title, status: row.status, type: row.type, requester: row.requestedBy, when: fmtAgo(sqliteUtcMs(row.requestedAt)), progress: row.progress }));
    const userRows = results.users.map(row => ({ discord: row.discord, name: row.name, email: row.email, linked: row.linked, server: row.homeServer, invited: row.invited, requests: row.requests, links: row.activeLinks }));
    const libraryRows = results.library.map(row => ({ title: row.title, type: row.type, status: row.status, complete: row.completeness, gaps: row.gaps, source: row.source }));
    const auditRows = results.audit.map(row => ({ when: fmtAgo(sqliteUtcMs(row.when)), action: row.action, matched: row.match }));
    const body = `<div class="actions"><a class="btn" href="/admin">Back to dashboard</a></div>
      <div class="card"><h2>Requests <span class="sub">${requestRows.length} result${requestRows.length === 1 ? '' : 's'}</span></h2>${renderTable(requestRows)}</div>
      <div class="card"><h2>Users <span class="sub">${userRows.length} result${userRows.length === 1 ? '' : 's'}</span></h2>${renderTable(userRows)}</div>
      <div class="card"><h2>Library <span class="sub">${libraryRows.length} result${libraryRows.length === 1 ? '' : 's'}</span></h2>${renderTable(libraryRows)}</div>
      <div class="card"><h2>Audit <span class="sub">${auditRows.length} result${auditRows.length === 1 ? '' : 's'} · metadata is searchable but hidden</span></h2>${renderTable(auditRows)}</div>`;
    res.type('html').send(renderPage(`Search: ${normalized.query}`, body, { showLogout: true, showSearch: true, searchQuery: normalized.query }));
  });

  app.get('/admin/health', rateLimit({
    windowMs: 15 * 60000,
    limit: 300,
    keyGenerator: httpRateLimitKey,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, res) => res.status(429).json({ ok: false, error: 'Too many dashboard requests. Wait a moment and try again.' }),
  }), dashboardAuth, async (_req, res) => res.json(await gatherHealth()));
  app.get('/admin/doctor', rateLimit({
    windowMs: 15 * 60000,
    limit: 300,
    keyGenerator: httpRateLimitKey,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, res) => res.status(429).json({ ok: false, error: 'Too many dashboard requests. Wait a moment and try again.' }),
  }), dashboardAuth, async (_req, res) => {
    const [edgeChecks, originChecks] = await Promise.all([runEdgeDiagnostics({ live: true }), checkPublicOriginReadiness()]);
    res.json({ checks: [...originChecks, ...edgeChecks], tierNodes: listTierNodes().map(n => ({ name: n.name, enabled: !!n.enabled, full: !!n.full, usableBytes: n.usable_bytes })) });
  });
  app.get('/admin/action/sync-preview', rateLimit({
    windowMs: 15 * 60000,
    limit: 30,
    keyGenerator: httpRateLimitKey,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, res) => res.status(429).json({ ok: false, error: 'Too many dashboard actions. Wait a moment and try again.' }),
  }), dashboardAuth, discordReadyGuard, async (_req, res) => res.json(await buildSyncPreview()));
  app.get('/admin/action/cleanup-preview', rateLimit({
    windowMs: 15 * 60000,
    limit: 300,
    keyGenerator: httpRateLimitKey,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, res) => res.status(429).json({ ok: false, error: 'Too many dashboard requests. Wait a moment and try again.' }),
  }), dashboardAuth, async (_req, res) => {
    const users = await fetchOverseerrUsers().catch(() => []);
    const toDelete = users.filter(u => u.userType !== 1 && ['displayName', 'email', 'username'].some(k => (u[k] || '').toLowerCase().startsWith('deleted_user')));
    res.json({ wouldRemove: toDelete.length, users: toDelete.map(u => ({ id: u.id, email: u.email, username: u.username })) });
  });
}

module.exports = { registerDashboardReadRoutes };
