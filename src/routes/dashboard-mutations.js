'use strict';

function registerDashboardMutationRoutes(app, deps) {
  const {
    CONFIG,
    approveGatedRequest,
    audit,
    clearMediaPriority,
    clearSeasonAlertState,
    dashboardActionError,
    dashboardActor,
    dashboardAuth,
    dashboardGateActor,
    dashboardGateResponse,
    db,
    denyGatedRequest,
    discordReadyGuard,
    findAvistazIndexer,
    getArrTagId,
    getEscalationById,
    getSeasonEpisodeFallback,
    getSeasonSearchTimes,
    getSeriesEpisodes,
    getTierNode,
    grabConfigured,
    grabDailyAllowance,
    httpRateLimitKey,
    listMediaPriority,
    listSonarrSeries,
    monitorSeasonSearch,
    nextRank,
    pad,
    prepareTierNodeInstall,
    previewAutomation,
    rateLimit,
    recordSeasonSearch,
    replaceTierNodeFolders,
    revokeAllDownloadLinks,
    runEpisodeRecoverySweep,
    runEscalation,
    runGuardedSweep,
    runSeasonDirectGrab,
    runtimeSettings,
    seasonSearchCooldown,
    setMediaPriority,
    setTierAgentToken,
    settingsStore,
    sonarrSeriesAliases,
    sweepEscalations,
    sweepSeasonPacks,
    sweepStuckDownloads,
    tierInstallCommand,
    triggerEpisodeSearch,
    triggerSeasonSearch,
    tunable,
    upsertTierNode,
    usesDirectGrabEscalation,
  } = deps;
  app.post('/admin/action/gate', rateLimit({
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
  app.post('/admin/action/tier-node', rateLimit({
    windowMs: 15 * 60000,
    limit: 60,
    keyGenerator: httpRateLimitKey,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, res) => res.status(429).json({ ok: false, error: 'Too many dashboard actions. Wait a moment and try again.' }),
  }), dashboardAuth, (req, res) => {
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
  app.post('/admin/action/tier-token', rateLimit({
    windowMs: 15 * 60000,
    limit: 60,
    keyGenerator: httpRateLimitKey,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, res) => res.status(429).json({ ok: false, error: 'Too many dashboard actions. Wait a moment and try again.' }),
  }), dashboardAuth, (req, res) => {
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
  app.post('/admin/action/search', rateLimit({
    windowMs: 15 * 60000,
    limit: 60,
    keyGenerator: httpRateLimitKey,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, res) => res.status(429).json({ ok: false, error: 'Too many dashboard actions. Wait a moment and try again.' }),
  }), dashboardAuth, async (req, res) => {
    const kind = req.body?.kind;
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

  app.post('/admin/action/priority', rateLimit({
    windowMs: 15 * 60000,
    limit: 60,
    keyGenerator: httpRateLimitKey,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, res) => res.status(429).json({ ok: false, error: 'Too many dashboard actions. Wait a moment and try again.' }),
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
  }), dashboardAuth, async (req, res) => {
    try {
      const items = await previewAutomation(req.body?.name, req.body?.values || {});
      return res.json({ ok: true, items });
    } catch (err) {
      return res.status(400).json({ ok: false, error: dashboardActionError(err) });
    }
  });

  app.post('/admin/action/sweep', rateLimit({
    windowMs: 15 * 60000,
    limit: 60,
    keyGenerator: httpRateLimitKey,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, res) => res.status(429).json({ ok: false, error: 'Too many dashboard actions. Wait a moment and try again.' }),
  }), dashboardAuth, async (req, res) => {
    const name = req.body?.name;
    const sweeps = {
      stuck: sweepStuckDownloads,
      escalation: sweepEscalations,
      'season-pack': () => sweepSeasonPacks({ rearmAlerts: true }),
      'episode-recovery': runEpisodeRecoverySweep,
    };
    if (!sweeps[name]) {
      audit('dashboard_sweep', { ...dashboardActor(req), ok: false, name, reason: 'invalid_sweep' });
      return res.status(400).json({ ok: false, error: 'Unknown sweep.' });
    }
    try {
      const outcome = await runGuardedSweep(name, sweeps[name]);
      if (!outcome.ok || outcome.result?.busy) {
        audit('dashboard_sweep', { ...dashboardActor(req), ok: false, name, reason: 'already_running' });
        return res.status(409).json({ ok: false, error: `${name} sweep is already running.` });
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

  app.post('/admin/action/escalate', rateLimit({
    windowMs: 15 * 60000,
    limit: 60,
    keyGenerator: httpRateLimitKey,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, res) => res.status(429).json({ ok: false, error: 'Too many dashboard actions. Wait a moment and try again.' }),
  }), dashboardAuth, async (req, res) => {
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
  app.post('/admin/settings', rateLimit({
    windowMs: 15 * 60000,
    limit: 60,
    keyGenerator: httpRateLimitKey,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, res) => res.status(429).json({ ok: false, error: 'Too many dashboard actions. Wait a moment and try again.' }),
  }), dashboardAuth, (req, res) => {
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

  app.post('/admin/settings/reset', rateLimit({
    windowMs: 15 * 60000,
    limit: 60,
    keyGenerator: httpRateLimitKey,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, res) => res.status(429).json({ ok: false, error: 'Too many dashboard actions. Wait a moment and try again.' }),
  }), dashboardAuth, (req, res) => {
    const keys = Array.isArray(req.body && req.body.keys) ? req.body.keys : [];
    const cleared = keys.filter(key => runtimeSettings.clearOverride(key, { store: settingsStore }).ok);
    if (cleared.length) audit('runtime_settings_reset', { cleared });
    res.json({ ok: true, cleared });
  });

  app.post('/admin/action/revoke-all', rateLimit({
    windowMs: 15 * 60000,
    limit: 60,
    keyGenerator: httpRateLimitKey,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, res) => res.status(429).json({ ok: false, error: 'Too many dashboard actions. Wait a moment and try again.' }),
  }), dashboardAuth, (_req, res) => { revokeAllDownloadLinks(); res.json({ ok: true }); });
  app.post('/admin/action/revoke-user/:discordId', rateLimit({
    windowMs: 15 * 60000,
    limit: 60,
    keyGenerator: httpRateLimitKey,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, res) => res.status(429).json({ ok: false, error: 'Too many dashboard actions. Wait a moment and try again.' }),
  }), dashboardAuth, (req, res) => { revokeAllDownloadLinks(req.params.discordId); res.json({ ok: true, discordId: req.params.discordId }); });
}

module.exports = { registerDashboardMutationRoutes };
