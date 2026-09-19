'use strict';

const express = require('express');

// Every dashboard mutation (POST) route, extracted from startExpressServer() in index.js as part
// of #178. index.js still owns wiring: it builds the deps object below from its existing local
// functions/module requires and calls registerDashboardMutationRoutes(app, deps) once. Route
// paths, auth ordering, validation, response bodies, and audit records are unchanged from the
// inline implementation this replaces.
function registerDashboardMutationRoutes(app, deps) {
  const {
    CONFIG,
    audit,
    dashboardCache = { invalidate() {} },
    dashboardActionError,
    dashboardActor,
    dashboardAuth,
    dashboardGateActor,
    dashboardGateResponse,
    db,
    discordReadyGuard,
    approveGatedRequest,
    denyGatedRequest,
    clearMediaPriority,
    clearSeasonAlertState,
    findAvistazIndexer,
    getArrTagId,
    getEscalationById,
    getSeasonEpisodeFallback,
    getSeasonSearchTimes,
    getSeriesEpisodes,
    getTierNode,
    addTierNodeFolder,
    addTierNodeMember,
    assessApplyImpact,
    buildTierPlans,
    computeTierActionPreview,
    createAgentApiToken,
    fmtSpace,
    grabConfigured,
    grabDailyAllowance,
    httpRateLimitKey,
    listMediaPriority,
    listSonarrSeries,
    listTierNodeFiles,
    monitorSeasonSearch,
    nextRank,
    pad,
    prepareTierNodeInstall,
    publishTierNodePlan,
    rateLimit,
    recordSeasonSearch,
    removeTierNodeFolder,
    removeTierNodeMember,
    replaceTierNodeFolders,
    revokeAgentApiToken,
    revokeAllDownloadLinks,
    runEscalation,
    runSeasonDirectGrab,
    runtimeSettings,
    seasonSearchCooldown,
    setMediaPriority,
    setTierAgentToken,
    setTierNodeEnabled,
    settingsStore,
    sonarrSeriesAliases,
    tierApplyCaps,
    tierApplyConfirmCode,
    tierInstallCommand,
    triggerEpisodeSearch,
    triggerMovieSearch,
    triggerSeasonSearch,
    tunable,
    upsertTierNode,
    usesDirectGrabEscalation,
    getAutomationRegistry = () => null,
  } = deps;

  const router = express.Router();
  // A successful mutation can change what several dashboard panels would show (approving a
  // request changes quota, pending counts, and Arr queues alike), so invalidate the whole
  // integration cache rather than tracking exactly which keys each route could affect — the next
  // /admin render just pays for one fresh fetch, same as every render did before that cache
  // existed. Preview-only routes (sweep-preview) never reach this: they change nothing.
  router.use((req, res, next) => {
    res.on('finish', () => { if (res.statusCode < 400) dashboardCache.invalidate(); });
    next();
  });

  router.post('/admin/action/gate', rateLimit({
    windowMs: 15 * 60000,
    limit: 30,
    keyGenerator: httpRateLimitKey,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, res) => res.status(429).json({ ok: false, error: 'Too many dashboard actions. Wait a moment and try again.' }),
  }), dashboardAuth, discordReadyGuard, async (req, res) => {
    const operation = req.body?.operation;
    const nonce = String(req.body?.nonce || '');
    if (!['approve', 'approve_az', 'deny'].includes(operation) || !/^[0-9a-f]{8}$/.test(nonce)) {
      return res.status(400).json({ ok: false, error: 'Invalid pending-request action.', retryable: false });
    }
    try {
      const actor = dashboardGateActor(req);
      const result = operation === 'deny'
        ? await denyGatedRequest({ nonce, actor })
        : await approveGatedRequest({ nonce, actor, azPreAuth: operation === 'approve_az' });
      const response = dashboardGateResponse(result, operation);
      const status = response.ok ? 200 : (result.restashed ? 502 : 409);
      return res.status(status).json(response);
    } catch (err) {
      return res.status(500).json({ ok: false, error: dashboardActionError(err), retryable: false });
    }
  });
  router.post('/admin/action/tier-node', dashboardAuth, (req, res) => {
    const name = String(req.body?.name || '').trim().toLowerCase();
    const usableGb = Number(req.body?.usableGb);
    const access = req.body?.access;
    const demandSource = req.body?.demandSource;
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name) || !Number.isInteger(usableGb) || usableGb < 1
      || !['open', 'restricted'].includes(access) || !['tautulli', 'plex', 'atime'].includes(demandSource)) {
      audit('dashboard_tier_node_upserted', { ...dashboardActor(req), ok: false, node: name || null, reason: 'invalid_request' });
      return res.status(400).json({ ok: false, error: 'Enter a valid node name, capacity, access, and demand source.' });
    }
    const { created, node } = upsertTierNode({ name, usable_bytes: usableGb * 1024 ** 3, access, demand_source: demandSource, full: req.body?.full === true });
    audit('dashboard_tier_node_upserted', { ...dashboardActor(req), ok: true, node: name, created });
    return res.json({ ok: true, node: { name: node.name }, message: created ? 'Node registered.' : 'Node updated.' });
  });
  router.post('/admin/action/tier-token', dashboardAuth, (req, res) => {
    const node = String(req.body?.node || '').trim().toLowerCase();
    const legacyFolderRoot = String(req.body?.folderRoot || '').trim();
    const legacyFolderId = String(req.body?.syncthingFolderId || '').trim();
    if (req.body?.confirmed !== true) return res.status(400).json({ ok: false, error: 'Token rotation confirmation is required.' });
    if (!getTierNode(node)) return res.status(404).json({ ok: false, error: 'Node not found.' });
    let setup;
    try {
      setup = prepareTierNodeInstall({
        ...req.body,
        folders: req.body?.folders || [{ id: legacyFolderId, path: legacyFolderRoot }],
      });
    }
    catch (err) { return res.status(400).json({ ok: false, error: err.message }); }
    const { folders, syncthingApiKey, mountRoot, mountMarker } = setup;
    upsertTierNode({ name: node, folder_root: folders[0].path });
    replaceTierNodeFolders(node, folders);
    const token = setTierAgentToken(node);
    const botUrl = CONFIG.TUNNEL_DOMAIN ? `https://${CONFIG.TUNNEL_DOMAIN}` : `http://127.0.0.1:${CONFIG.PORT}`;
    const command = tierInstallCommand({ botUrl, node, token, folders, syncthingApiKey, mountRoot, mountMarker });
    audit('dashboard_tier_agent_token_rotated', { ...dashboardActor(req), node, folderCount: folders.length });
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ ok: true, command });
  });
  // Dashboard-minted Agent API tokens: the operator's replacement for hand-generating
  // AGENT_API_TOKEN and editing the container environment. The raw token is returned exactly
  // once — only its hash is stored, so it must be copied now.
  router.post('/admin/action/agent-api-token', dashboardAuth, (req, res) => {
    const label = String(req.body?.label || '').trim();
    if (!label || label.length > 64) {
      return res.status(400).json({ ok: false, error: 'Give the token a label of 1 to 64 characters, e.g. "Edith".' });
    }
    let created;
    try {
      created = createAgentApiToken(label);
    } catch (err) {
      return res.status(400).json({ ok: false, error: err.message });
    }
    audit('dashboard_agent_api_token_created', { ...dashboardActor(req), tokenId: created.id, label: created.label });
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ ok: true, id: created.id, label: created.label, token: created.token });
  });
  router.post('/admin/action/agent-api-token-revoke', dashboardAuth, (req, res) => {
    const id = Number(req.body?.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ ok: false, error: 'Token id is required.' });
    if (req.body?.confirmed !== true) return res.status(400).json({ ok: false, error: 'Token revocation confirmation is required.' });
    if (!revokeAgentApiToken(id)) return res.status(404).json({ ok: false, error: 'Token not found or already revoked.' });
    audit('dashboard_agent_api_token_revoked', { ...dashboardActor(req), tokenId: id });
    return res.json({ ok: true });
  });
  router.post('/admin/action/search', dashboardAuth, async (req, res) => {
    const kind = req.body?.kind;
    if (kind === 'movie') {
      const movieId = Number(req.body?.movieId);
      const is4k = req.body?.is4k === true;
      if (!Number.isInteger(movieId) || movieId < 1) {
        audit('dashboard_search', { ...dashboardActor(req), ok: false, reason: 'invalid_request' });
        return res.status(400).json({ ok: false, error: 'Valid Radarr movie ID is required.' });
      }
      try {
        await triggerMovieSearch(movieId, { is4k });
        audit('dashboard_search', { ...dashboardActor(req), ok: true, kind: 'movie', movieId, is4k });
        return res.json({ ok: true, message: `Movie search triggered in Radarr${is4k ? ' 4K' : ''}.` });
      } catch (err) {
        audit('dashboard_search', { ...dashboardActor(req), ok: false, kind: 'movie', movieId, error: err.message });
        return res.status(502).json({ ok: false, error: `Radarr search failed: ${err.message}` });
      }
    }
    const seriesId = Number(req.body?.seriesId);
    const seasonNumber = Number(req.body?.seasonNumber);
    const episodeId = Number(req.body?.episodeId);
    if (kind === 'rearm-alert') {
      if (!Number.isInteger(seriesId) || seriesId < 1 || !Number.isInteger(seasonNumber) || seasonNumber < 0) {
        audit('dashboard_season_alert_rearmed', { ...dashboardActor(req), ok: false, reason: 'invalid_request' });
        return res.status(400).json({ ok: false, error: 'Valid series and season numbers are required.' });
      }
      const changed = clearSeasonAlertState(seriesId, seasonNumber);
      audit('dashboard_season_alert_rearmed', { ...dashboardActor(req), ok: true, seriesId, seasonNumber, changed });
      return res.json({ ok: true, message: changed ? 'Season-search alerts re-armed.' : 'Season-search alerts were already armed.' });
    }
    if (!['season', 'episode'].includes(kind) || !Number.isInteger(seriesId)) {
      audit('dashboard_search', { ...dashboardActor(req), ok: false, reason: 'invalid_request' });
      return res.status(400).json({ ok: false, error: 'Invalid search request.' });
    }
    try {
      const series = (await listSonarrSeries()).find(row => Number(row.id) === seriesId);
      if (!series) throw new Error(`Sonarr series ${seriesId} was not found`);
      const episodes = await getSeriesEpisodes(seriesId);
      if (kind === 'season') {
        const missing = episodes.filter(ep => Number(ep.seasonNumber) === seasonNumber && ep.monitored && !ep.hasFile
          && Date.parse(ep.airDateUtc || ep.airDate || '') <= Date.now());
        if (!Number.isInteger(seasonNumber) || !missing.length) throw new Error(`Sonarr season ${seasonNumber} has no aired missing episodes`);
        const fallback = getSeasonEpisodeFallback(seriesId, seasonNumber);
        if (fallback) {
          const error = `A bounded episode fallback already owns this season (${fallback.state})`;
          audit('dashboard_search', { ...dashboardActor(req), ok: false, reason: 'episode_fallback_active', seriesId, seasonNumber, fallbackState: fallback.state });
          return res.status(409).json({ ok: false, error });
        }
        // An admin explicitly clicking "Search Now" is a deliberate one-off override, not the
        // automated sweep — force:true skips the cooldown (including any stall backoff) rather
        // than making them wait out a multi-day backoff they just decided isn't warranted.
        // Without force, the plain cooldown still applies so an accidental double-click isn't
        // silently overridden.
        const force = !!req.body?.force;
        const { cooling, nextEligible } = force ? { cooling: false } : seasonSearchCooldown(getSeasonSearchTimes(seriesId)[seasonNumber]);
        if (cooling) {
          const error = `Season search is cooling down until ${new Date(nextEligible).toISOString()}`;
          audit('dashboard_search', { ...dashboardActor(req), ok: false, reason: 'cooldown', seriesId, seasonNumber, nextEligible });
          return res.status(409).json({ ok: false, error, nextEligible, canOverride: true });
        }
        // Mirror the automated season-pack sweep's avistaz-vs-sonarr decision. This button used
        // to always call Sonarr's plain SeasonSearch, silently ignoring the AvistaZ tag — an
        // override on a tagged show now actually searches AvistaZ instead of quietly falling
        // back to the public-indexer route it exists to avoid.
        const tagSource = { url: CONFIG.SONARR_URL, key: CONFIG.SONARR_API_KEY, label: 'sonarr' };
        const tagId = await getArrTagId(tagSource, CONFIG.AVISTAZ_TAG).catch(() => null);
        const tagged = tagId != null && (series.tags || []).includes(tagId);
        const directEnabled = tunable('SEASON_PACK_AVISTAZ_DIRECT') && grabConfigured();
        const indexer = tagged && directEnabled ? await findAvistazIndexer().catch(() => null) : null;
        if (tagged && directEnabled && !indexer) {
          audit('dashboard_search', { ...dashboardActor(req), ok: false, reason: 'indexer_missing', seriesId, seasonNumber, title: series.title });
          return res.status(409).json({ ok: false, error: `${series.title} is tagged for AvistaZ, but the AvistaZ indexer could not be found in Prowlarr — check AVISTAZ_INDEXER_NAME and the indexer's name there.` });
        }
        if (tagged && directEnabled && indexer) {
          const allowance = grabDailyAllowance();
          const result = await runSeasonDirectGrab({ series, season: { season: seasonNumber, missing: missing.length }, indexer, allowance });
          clearSeasonAlertState(seriesId, seasonNumber);
          recordSeasonSearch({ seriesId, seasonNumber, seriesTitle: series.title, missing: missing.length });
          audit('dashboard_search', { ...dashboardActor(req), ok: result.status !== 'error', kind, seriesId, seasonNumber, title: series.title, route: 'avistaz', status: result.status, override: force });
          const statusText = result.status === 'grabbed' ? result.detail
            : result.status === 'offered' ? result.detail
              : result.status === 'no_results' ? 'AvistaZ search completed but found no results.'
                : result.status === 'allowance' ? 'the daily AvistaZ grab allowance is exhausted for today.'
                  : `AvistaZ search failed: ${result.error || 'unknown error'}`;
          return res.json({ ok: result.status !== 'error', message: `${series.title} S${pad(seasonNumber)} — ${statusText}` });
        }
        const searchedAt = Date.now();
        const command = await triggerSeasonSearch(seriesId, seasonNumber);
        clearSeasonAlertState(seriesId, seasonNumber);
        const stallCount = recordSeasonSearch({ seriesId, seasonNumber, seriesTitle: series.title, missing: missing.length });
        monitorSeasonSearch({ seriesId, seriesTitle: series.title, seriesYear: series.year, seriesAliases: sonarrSeriesAliases(series), seasonNumber, missingAtSearch: missing.length, commandId: command?.id, searchedAt, stallCount });
        audit('dashboard_search', { ...dashboardActor(req), ok: true, kind, seriesId, seasonNumber, title: series.title, route: 'sonarr', commandId: command?.id || null, override: force });
        return res.json({ ok: true, message: `Sonarr accepted the S${pad(seasonNumber)} season search for ${series.title}.${force ? ' (cooldown overridden)' : ''}` });
      }
      const episode = episodes.find(ep => Number(ep.id) === episodeId && ep.monitored && !ep.hasFile
        && Date.parse(ep.airDateUtc || ep.airDate || '') <= Date.now());
      if (!Number.isInteger(episodeId) || !episode) throw new Error(`Sonarr episode ${episodeId} is not an aired missing episode in this series`);
      await triggerEpisodeSearch([episodeId]);
      audit('dashboard_search', { ...dashboardActor(req), ok: true, kind, seriesId, episodeId, title: series.title, seasonNumber: episode.seasonNumber, episodeNumber: episode.episodeNumber });
      return res.json({ ok: true, message: `Sonarr accepted the S${pad(episode.seasonNumber)}E${pad(episode.episodeNumber)} search for ${series.title}.` });
    } catch (err) {
      const error = dashboardActionError(err);
      audit('dashboard_search', { ...dashboardActor(req), ok: false, kind, seriesId, seasonNumber: Number.isInteger(seasonNumber) ? seasonNumber : null, episodeId: Number.isInteger(episodeId) ? episodeId : null, error });
      return res.status(err?.response ? 502 : 400).json({ ok: false, error });
    }
  });

  router.post('/admin/action/priority', rateLimit({
    windowMs: 60000,
    limit: 30,
    keyGenerator: httpRateLimitKey,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, res) => res.status(429).json({ ok: false, error: 'Too many priority changes. Wait a moment and try again.' }),
  }), dashboardAuth, (req, res) => {
    const operation = req.body?.operation;
    const key = String(req.body?.key || '');
    if (!['pin', 'unpin', 'move'].includes(operation) || !/^(tvdb|tmdb):\d+$/.test(key)) {
      audit('dashboard_priority', { ...dashboardActor(req), ok: false, operation, key, reason: 'invalid_request' });
      return res.status(400).json({ ok: false, error: 'Invalid priority request.' });
    }
    const rows = listMediaPriority();
    if (operation === 'pin') {
      const mediaType = req.body?.mediaType;
      const title = String(req.body?.title || '').trim();
      if (!['tv', 'movie'].includes(mediaType) || !title) {
        audit('dashboard_priority', { ...dashboardActor(req), ok: false, operation, key, reason: 'missing_media' });
        return res.status(400).json({ ok: false, error: 'Media type and title are required.' });
      }
      setMediaPriority({ key, mediaType, title, rank: nextRank(rows), pinnedBy: 'dashboard' });
    } else if (operation === 'unpin') {
      clearMediaPriority(key);
    } else {
      const index = rows.findIndex(row => row.key === key);
      const direction = Number(req.body?.direction);
      if (index < 0 || ![-1, 1].includes(direction)) {
        audit('dashboard_priority', { ...dashboardActor(req), ok: false, operation, key, reason: 'invalid_move' });
        return res.status(400).json({ ok: false, error: 'Pinned title or direction is invalid.' });
      }
      const target = Math.max(0, Math.min(rows.length - 1, index + direction));
      const [moved] = rows.splice(index, 1);
      rows.splice(target, 0, moved);
      const update = db.prepare('UPDATE media_priority SET rank = ? WHERE key = ?');
      db.transaction(() => rows.forEach((row, rank) => update.run(rank + 1, row.key)))();
    }
    audit('dashboard_priority', { ...dashboardActor(req), ok: true, operation, key });
    return res.json({ ok: true, message: operation === 'pin' ? 'Title pinned.' : operation === 'unpin' ? 'Title unpinned.' : 'Pinned order updated.' });
  });

  // A preview is authenticated but expensive: it reads the whole Sonarr series list and then
  // walks episodes series by series. Held-down Enter on the Preview button, or a stuck bit of
  // dashboard JS, would hammer Sonarr harder than the sweep it is previewing ever does.
  app.post('/admin/action/sweep-preview', rateLimit({
    windowMs: 60000,
    limit: 20,
    keyGenerator: httpRateLimitKey,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, res) => res.status(429).json({ ok: false, error: 'Too many previews. Wait a moment and try again.' }),
  }), dashboardAuth, discordReadyGuard, async (req, res) => {
    try {
      const outcome = await getAutomationRegistry().preview(req.body?.name, req.body?.values || {});
      if (!outcome.ok) return res.status(outcome.busy ? 409 : 400).json({ ok: false, error: outcome.reason || 'Preview unavailable.' });
      return res.json({ ok: true, items: outcome.result });
    } catch (err) {
      return res.status(400).json({ ok: false, error: dashboardActionError(err) });
    }
  });

  router.post('/admin/action/sweep', rateLimit({
    windowMs: 60000,
    limit: 10,
    keyGenerator: httpRateLimitKey,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, res) => res.status(429).json({ ok: false, error: 'Too many run-now requests. Wait a moment and try again.' }),
  }), dashboardAuth, discordReadyGuard, async (req, res) => {
    const name = req.body?.name;
    const automationRegistry = getAutomationRegistry();
    if (!automationRegistry?.ids().includes(name)) {
      audit('dashboard_sweep', { ...dashboardActor(req), ok: false, name, reason: 'invalid_sweep' });
      return res.status(400).json({ ok: false, error: 'Unknown sweep.' });
    }
    try {
      const outcome = await automationRegistry.run(name, { trigger: 'manual' });
      if (!outcome.ok) {
        const reason = outcome.busy ? 'already_running' : outcome.disabled ? 'disabled' : 'manual_unavailable';
        audit('dashboard_sweep', { ...dashboardActor(req), ok: false, name, reason });
        return res.status(outcome.busy ? 409 : 400).json({ ok: false, error: outcome.busy ? `${name} sweep is already running.` : outcome.reason });
      }
      const result = outcome.result || {};
      const count = result.searched ?? result.acted ?? result.alerted ?? 0;
      audit('dashboard_sweep', { ...dashboardActor(req), ok: true, name, count, result });
      return res.json({ ok: true, message: `${name} sweep finished with ${count} action(s).`, result });
    } catch (err) {
      const error = dashboardActionError(err);
      audit('dashboard_sweep', { ...dashboardActor(req), ok: false, name, error });
      return res.status(502).json({ ok: false, error });
    }
  });

  router.post('/admin/action/escalate', dashboardAuth, async (req, res) => {
    const id = Number(req.body?.id);
    const row = getEscalationById(id);
    if (req.body?.confirmed !== true) {
      audit('dashboard_escalation', { ...dashboardActor(req), ok: false, id, reason: 'confirmation_required' });
      return res.status(400).json({ ok: false, error: 'Confirmation is required.' });
    }
    if (!row || !['watching', 'alerted', 'error'].includes(row.state)) {
      audit('dashboard_escalation', { ...dashboardActor(req), ok: false, id, reason: 'already_handled' });
      return res.status(409).json({ ok: false, error: 'This escalation was already handled.' });
    }
    const directGrab = usesDirectGrabEscalation(row) && grabConfigured();
    const before = grabDailyAllowance();
    if (directGrab && before.exhausted) {
      audit('dashboard_escalation', { ...dashboardActor(req), ok: false, id, reason: 'allowance_exhausted', remaining: before.remaining });
      return res.status(409).json({ ok: false, error: 'The daily AvistaZ allowance is exhausted.', remaining: before.remaining });
    }
    try {
      const result = await runEscalation(row);
      const after = grabDailyAllowance();
      audit('dashboard_escalation', { ...dashboardActor(req), ok: result.ok, id, mediaId: row.media_id, title: row.title, remainingBefore: before.remaining, remainingAfter: after.remaining, reason: result.reason || result.why || null });
      if (!result.ok) return res.status(result.deferred ? 409 : 502).json({ ok: false, error: result.why || result.reason, remaining: after.remaining });
      return res.json({ ok: true, message: result.detail, remaining: after.remaining });
    } catch (err) {
      const error = dashboardActionError(err);
      audit('dashboard_escalation', { ...dashboardActor(req), ok: false, id, mediaId: row.media_id, title: row.title, error });
      return res.status(502).json({ ok: false, error });
    }
  });
  // Runtime overrides for the automation sweeps. Every write is validated against the setting's
  // declared bounds (src/runtime-settings.js) and audited — an override that quietly changes what
  // the bot does needs the same paper trail as any other admin action.
  router.post('/admin/settings', dashboardAuth, (req, res) => {
    const values = (req.body && req.body.values) || {};
    const errors = [];
    const applied = [];
    for (const [key, raw] of Object.entries(values)) {
      const result = runtimeSettings.setOverride(key, raw, { store: settingsStore });
      if (result.ok) applied.push({ key, value: result.value });
      else errors.push(result.error);
    }
    if (applied.length) audit('runtime_settings_changed', { applied });
    res.status(errors.length ? 400 : 200).json({ ok: !errors.length, applied, errors });
  });

  router.post('/admin/settings/reset', dashboardAuth, (req, res) => {
    const keys = Array.isArray(req.body && req.body.keys) ? req.body.keys : [];
    const cleared = keys.filter(key => runtimeSettings.clearOverride(key, { store: settingsStore }).ok);
    if (cleared.length) audit('runtime_settings_reset', { cleared });
    res.json({ ok: true, cleared });
  });

  router.post('/admin/action/revoke-all', dashboardAuth, (_req, res) => { revokeAllDownloadLinks(); res.json({ ok: true }); });
  router.post('/admin/action/revoke-user/:discordId', dashboardAuth, (req, res) => { revokeAllDownloadLinks(req.params.discordId); res.json({ ok: true, discordId: req.params.discordId }); });

  // Tier planning UI (dashboard parity slice 1). Preview is expensive — it walks the full
  // Sonarr/Radarr inventory — so it gets its own tight rate limit, mirroring the
  // sweep-preview comment about held-down Enter hammering the arrs.
  app.post('/admin/action/tier-preview', rateLimit({
    windowMs: 5 * 60000,
    limit: 10,
    keyGenerator: httpRateLimitKey,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, res) => res.status(429).json({ ok: false, error: 'Too many tier previews. Wait a moment and try again.' }),
  }), dashboardAuth, discordReadyGuard, async (req, res) => {
    const only = String(req.body?.node || '').trim().toLowerCase() || null;
    let plans;
    try {
      plans = await buildTierPlans();
    } catch (err) {
      return res.status(502).json({ ok: false, error: dashboardActionError(err) });
    }
    let names = Object.keys(plans.manifests || {});
    if (only) names = names.filter(n => n === only);
    if (!names.length) {
      return res.status(404).json({ ok: false, error: only ? `No plan for node "${only}" — is it registered and enabled?` : 'Nothing to plan.' });
    }
    const caps = tierApplyCaps();
    const summarizeEntry = e => ({
      title: (e.title || e.mediaId || '').slice(0, 80),
      sizeBytes: e.sizeBytes || 0,
      size: fmtSpace(e.sizeBytes || 0),
      folderId: e.folderId || null,
      score: typeof e.value === 'number' ? Number(e.value.toFixed(3)) : null,
    });
    const nodes = names.map(name => {
      const m = plans.manifests[name];
      const node = (plans.nodes || []).find(n => n.name === name) || {};
      const rec = plans.planRecords?.[name] || null;
      const base = {
        name,
        full: !!node.full || !!m.full,
        access: node.access || m.access || null,
        planHash: m.planHash,
        keepCount: m.stats.keepCount,
        keepBytes: fmtSpace(m.stats.keepBytes),
        dropCount: m.stats.dropCount,
        dropBytes: fmtSpace(m.stats.dropBytes),
        budgetBytes: fmtSpace(m.stats.budgetBytes),
        publishedHash: rec?.published?.planHash || null,
        convergedHash: rec?.converged?.planHash || null,
      };
      if (base.full) return { ...base, impact: null, actions: null, topChanges: [] };
      const files = listTierNodeFiles(name);
      const impact = assessApplyImpact({ manifest: m, files, caps });
      impact.confirmCode = tierApplyConfirmCode(name, m.planHash);
      const actions = computeTierActionPreview({ manifest: m, files });
      const t = actions.totals;
      return {
        ...base,
        impact: {
          requiresConfirm: impact.requiresConfirm,
          confirmCode: impact.confirmCode,
          realRemovalBytes: impact.realRemovalBytes,
          realRemoval: fmtSpace(impact.realRemovalBytes),
          removedTitles: impact.removedTitles,
          newDownloadBytes: impact.newDownloadBytes,
          newDownload: fmtSpace(impact.newDownloadBytes),
          newDownloadTitles: impact.newDownloadTitles,
          hasReport: impact.hasReport,
          exceeds: impact.exceeds,
        },
        actions: {
          download: { count: t.downloadLocally.count, bytes: fmtSpace(t.downloadLocally.bytes) },
          remove: { count: t.removeLocal.count, bytes: fmtSpace(t.removeLocal.bytes) },
          syncing: { count: t.keptDownloading.count, bytes: fmtSpace(t.keptDownloading.bytes) },
          alreadyGone: { count: t.alreadyAbsent.count },
          synced: { count: t.keptSynced.count, bytes: fmtSpace(t.keptSynced.bytes) },
          hasReport: actions.hasReport,
        },
        topChanges: [
          ...actions.downloadLocally.slice(0, 10).map(e => ({ ...summarizeEntry(e), action: 'download' })),
          ...actions.removeLocal.slice(0, 10).map(e => ({ ...summarizeEntry(e), action: 'remove' })),
        ],
      };
    });
    return res.json({
      ok: true,
      nodes,
      warnings: plans.warnings || [],
      routingErrors: (plans.routingErrors || []).filter(i => names.includes(i.node)).map(i => ({
        node: i.node, count: i.count, examples: (i.examples || []).slice(0, 3),
      })),
      failedSources: (plans.failedSources || []).map(f => ({ label: f.label, error: String(f.error).slice(0, 200) })),
    });
  });

  router.post('/admin/action/tier-apply', rateLimit({
    windowMs: 60000,
    limit: 10,
    keyGenerator: httpRateLimitKey,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, res) => res.status(429).json({ ok: false, error: 'Too many tier applies. Wait a moment and try again.' }),
  }), dashboardAuth, discordReadyGuard, async (req, res) => {
    const only = String(req.body?.node || '').trim().toLowerCase() || null;
    const confirm = String(req.body?.confirm || '').trim().toUpperCase() || null;
    let plans;
    try {
      plans = await buildTierPlans();
    } catch (err) {
      return res.status(502).json({ ok: false, error: dashboardActionError(err) });
    }
    let names = Object.keys(plans.manifests || {});
    if (only) names = names.filter(n => n === only);
    if (!names.length) {
      return res.status(404).json({ ok: false, error: only ? `No plan for node "${only}".` : 'Nothing to apply.' });
    }
    const routingErrors = (plans.routingErrors || []).filter(i => names.includes(i.node));
    if (routingErrors.length) {
      audit('tier_apply_blocked_routing', { ...dashboardActor(req), nodes: names, routingErrors: routingErrors.map(i => ({ node: i.node, count: i.count })) });
      return res.status(409).json({
        ok: false,
        error: 'Apply blocked — folder routing mismatch. Fix the node folders and re-run preview.',
        routingErrors: routingErrors.map(i => ({ node: i.node, count: i.count, examples: (i.examples || []).slice(0, 3) })),
      });
    }
    if (plans.failedSources?.length) {
      audit('tier_apply_blocked_incomplete_inventory', {
        ...dashboardActor(req), nodes: names, failedSources: plans.failedSources.map(f => f.label),
      });
      return res.status(409).json({
        ok: false,
        error: 'Apply blocked — incomplete inventory. Publishing now would blank .stignore for the missing source and trigger a full re-sync.',
        failedSources: plans.failedSources.map(f => ({ label: f.label, error: String(f.error).slice(0, 200) })),
      });
    }
    const caps = tierApplyCaps();
    const applied = [];
    const held = [];
    for (const name of names) {
      const m = plans.manifests[name];
      const node = (plans.nodes || []).find(n => n.name === name);
      if (node?.full || m.full) {
        plans.planRecords[name] = publishTierNodePlan(name, m);
        audit('tier_plan_published', { ...dashboardActor(req), node: name, planHash: m.planHash, full: true });
        applied.push(name);
        continue;
      }
      const files = listTierNodeFiles(name);
      const impact = assessApplyImpact({ manifest: m, files, caps });
      const code = tierApplyConfirmCode(name, m.planHash);
      if (impact.requiresConfirm && confirm !== code) {
        held.push({ node: name, confirmCode: code });
        audit('tier_apply_blocked', {
          ...dashboardActor(req), node: name, planHash: m.planHash,
          realRemovalBytes: impact.realRemovalBytes, removedTitles: impact.removedTitles,
          newDownloadBytes: impact.newDownloadBytes,
        });
        continue;
      }
      plans.planRecords[name] = publishTierNodePlan(name, m);
      audit('tier_plan_published', {
        ...dashboardActor(req), node: name, planHash: m.planHash,
        keepCount: m.stats.keepCount, dropCount: m.stats.dropCount, dropBytes: m.stats.dropBytes,
        confirmed: !!impact.requiresConfirm,
      });
      applied.push(name);
    }
    return res.json({ ok: true, applied, held });
  });

  const tierNodeName = req => String(req.body?.name || '').trim().toLowerCase();
  router.post('/admin/action/tier-node/enable', dashboardAuth, (req, res) => {
    const name = tierNodeName(req);
    if (!getTierNode(name)) {
      audit('dashboard_tier_node_enabled', { ...dashboardActor(req), ok: false, node: name || null, reason: 'not_found' });
      return res.status(404).json({ ok: false, error: 'Node not found.' });
    }
    setTierNodeEnabled(name, true);
    audit('dashboard_tier_node_enabled', { ...dashboardActor(req), ok: true, node: name });
    return res.json({ ok: true, message: `Node "${name}" enabled — it rejoins planning on the next preview.` });
  });
  router.post('/admin/action/tier-node/disable', dashboardAuth, (req, res) => {
    const name = tierNodeName(req);
    if (!getTierNode(name)) {
      audit('dashboard_tier_node_disabled', { ...dashboardActor(req), ok: false, node: name || null, reason: 'not_found' });
      return res.status(404).json({ ok: false, error: 'Node not found.' });
    }
    setTierNodeEnabled(name, false);
    audit('dashboard_tier_node_disabled', { ...dashboardActor(req), ok: true, node: name });
    return res.json({ ok: true, message: `Node "${name}" disabled — the planner skips it entirely.` });
  });
  router.post('/admin/action/tier-node/folder-add', dashboardAuth, (req, res) => {
    const name = tierNodeName(req);
    const folderId = String(req.body?.folderId || '').trim();
    const folderRoot = String(req.body?.folderRoot || '').trim();
    if (!getTierNode(name)) {
      audit('dashboard_tier_node_folder_added', { ...dashboardActor(req), ok: false, node: name || null, reason: 'not_found' });
      return res.status(404).json({ ok: false, error: 'Node not found.' });
    }
    if (!folderId || !folderRoot) {
      audit('dashboard_tier_node_folder_added', { ...dashboardActor(req), ok: false, node: name, reason: 'invalid_request' });
      return res.status(400).json({ ok: false, error: 'Folder ID and local path are both required.' });
    }
    addTierNodeFolder(name, folderId, folderRoot);
    audit('dashboard_tier_node_folder_added', { ...dashboardActor(req), ok: true, node: name, folderId });
    return res.json({ ok: true, message: `Folder "${folderId}" added to "${name}". Re-run preview to see the per-folder split.` });
  });
  router.post('/admin/action/tier-node/folder-remove', dashboardAuth, (req, res) => {
    const name = tierNodeName(req);
    const folderId = String(req.body?.folderId || '').trim();
    if (!getTierNode(name)) {
      audit('dashboard_tier_node_folder_removed', { ...dashboardActor(req), ok: false, node: name || null, reason: 'not_found' });
      return res.status(404).json({ ok: false, error: 'Node not found.' });
    }
    if (!folderId) {
      audit('dashboard_tier_node_folder_removed', { ...dashboardActor(req), ok: false, node: name, reason: 'invalid_request' });
      return res.status(400).json({ ok: false, error: 'Folder ID is required.' });
    }
    const removed = removeTierNodeFolder(name, folderId);
    audit('dashboard_tier_node_folder_removed', { ...dashboardActor(req), ok: removed, node: name, folderId });
    return res.json({ ok: true, message: removed ? `Folder "${folderId}" removed from "${name}".` : `Folder "${folderId}" was not on "${name}".` });
  });
  router.post('/admin/action/tier-member/add', dashboardAuth, (req, res) => {
    const name = tierNodeName(req);
    const node = getTierNode(name);
    if (!node) {
      audit('dashboard_tier_member_added', { ...dashboardActor(req), ok: false, node: name || null, reason: 'not_found' });
      return res.status(404).json({ ok: false, error: 'Node not found.' });
    }
    if (node.access !== 'restricted') {
      audit('dashboard_tier_member_added', { ...dashboardActor(req), ok: false, node: name, reason: 'not_restricted' });
      return res.status(400).json({ ok: false, error: `Node "${name}" is not restricted — only restricted nodes have a member set.` });
    }
    const discordId = String(req.body?.discordId || '').trim();
    if (!/^\d{5,25}$/.test(discordId)) {
      audit('dashboard_tier_member_added', { ...dashboardActor(req), ok: false, node: name, reason: 'invalid_request' });
      return res.status(400).json({ ok: false, error: 'Enter a valid Discord user ID (digits).' });
    }
    addTierNodeMember(name, discordId);
    audit('dashboard_tier_member_added', { ...dashboardActor(req), ok: true, node: name, discordId });
    return res.json({ ok: true, message: `Member added to "${name}".` });
  });
  router.post('/admin/action/tier-member/remove', dashboardAuth, (req, res) => {
    const name = tierNodeName(req);
    const node = getTierNode(name);
    if (!node) {
      audit('dashboard_tier_member_removed', { ...dashboardActor(req), ok: false, node: name || null, reason: 'not_found' });
      return res.status(404).json({ ok: false, error: 'Node not found.' });
    }
    const discordId = String(req.body?.discordId || '').trim();
    if (!/^\d{5,25}$/.test(discordId)) {
      audit('dashboard_tier_member_removed', { ...dashboardActor(req), ok: false, node: name, reason: 'invalid_request' });
      return res.status(400).json({ ok: false, error: 'Enter a valid Discord user ID (digits).' });
    }
    const removed = removeTierNodeMember(name, discordId);
    audit('dashboard_tier_member_removed', { ...dashboardActor(req), ok: removed, node: name, discordId });
    return res.json({ ok: true, message: removed ? `Member removed from "${name}".` : `That user was not a member of "${name}".` });
  });

  app.use(router);
}

module.exports = { registerDashboardMutationRoutes };
