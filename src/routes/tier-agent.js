const fs = require('fs');
const path = require('path');
const bodyParser = require('body-parser');
const { createBodyConcurrencyLimiter } = require('./body-concurrency-limit');
const { createTierAgentAuth } = require('./tier-agent-auth');
const { createTierAgentReportLimiter } = require('./tier-agent-report-limit');
const { sanitizeNodeTelemetry, assessNodeTelemetry } = require('../node-telemetry');

function registerTierAgentRoutes(app, deps) {
  const {
    config, getTierAgentTokenHash, sha256, safeEqual, audit, getSetting, setSetting,
    getTierPlan, recordTierAgentHeartbeat, recordTierAgentReport, markTierPlanConverged,
    getTierNode, listTierNodeFiles, replaceTierNodeFiles, parseAtimeMask, maskSuspectAtimes,
    notifyTelemetryTransition, notifyDriveMissing, notifyDriveRecovered, notifyAgentReport,
    fileSystem = fs, projectRoot = path.join(__dirname, '..', '..'),
    auth = createTierAgentAuth({ getTierAgentTokenHash, sha256, safeEqual, audit }),
    reportLimiter = createTierAgentReportLimiter({ limit: config.AGENT_REPORT_MAX_PER_MINUTE }),
    bodyLimiter = createBodyConcurrencyLimiter({ limit: config.AGENT_REPORT_MAX_CONCURRENT, scope: 'agent report body' }),
    jsonParser = bodyParser.json({ limit: '25mb' }),
  } = deps;

  app.get('/agent/install/:node', auth, (req, res) => {
    const node = String(req.params.node).toLowerCase();
    const template = fileSystem.readFileSync(path.join(projectRoot, 'agent', 'install.sh.tmpl'), 'utf8');
    const botUrl = config.TUNNEL_DOMAIN ? `https://${config.TUNNEL_DOMAIN}` : `http://127.0.0.1:${config.PORT}`;
    audit('tier_agent_installer_fetched', { node, ip: req.ip || req.socket.remoteAddress || 'unknown' });
    res.type('text/plain').send(template.split('__NODE__').join(node).split('__BOT_URL__').join(botUrl));
  });

  app.get('/agent/source/:node', auth, (_req, res) => {
    res.type('text/plain').send(fileSystem.readFileSync(path.join(projectRoot, 'agent', 'agent.js'), 'utf8'));
  });

  app.get('/agent/manifest/:node', auth, (req, res) => {
    const raw = getSetting(`tier_manifest:${String(req.params.node).toLowerCase()}`);
    if (!raw) return res.status(404).json({ error: 'No manifest published for this node — run /tier apply.' });
    res.type('json').send(raw);
  });

  app.post('/agent/report/:node', auth, reportLimiter, bodyLimiter, jsonParser, (req, res) => {
    const node = String(req.params.node).toLowerCase();
    const body = req.body || {};
    const previousTelemetryLevel = getTierPlan(node)?.lastTelemetryLevel || 'unknown';
    const telemetry = sanitizeNodeTelemetry(body.telemetry);
    const telemetryHealth = assessNodeTelemetry(telemetry, { warnC: config.NODE_TEMP_WARN_C, criticalC: config.NODE_TEMP_CRITICAL_C });
    const emitTelemetry = () => notifyTelemetryTransition({ node, telemetry, telemetryHealth, previousTelemetryLevel });

    if (body.heartbeat && !body.driveMissing) {
      recordTierAgentHeartbeat(node, { errors: [], telemetry, telemetryLevel: telemetryHealth.level });
      emitTelemetry();
      audit('tier_agent_heartbeat', { node, planHash: body.planHash || null });
      return res.json({ ok: true, heartbeat: true });
    }

    const errors = Array.isArray(body.errors) ? body.errors.slice(0, 10).map(e => String(e).slice(0, 300)) : [];
    const skipped = Array.isArray(body.skipped) ? body.skipped.slice(0, 10).map(e => String(e).slice(0, 300)) : [];
    const mountKey = `tier_mount_state:${node}`;
    if (body.driveMissing) {
      const previousMountState = getSetting(mountKey);
      setSetting(mountKey, 'missing');
      const mountErrors = (Array.isArray(body.mountErrors) ? body.mountErrors : []).slice(0, 8).map(e => String(e).slice(0, 300));
      recordTierAgentHeartbeat(node, { errors: mountErrors.length ? mountErrors : ['media drive missing'], telemetry, telemetryLevel: telemetryHealth.level });
      emitTelemetry();
      audit('tier_agent_drive_missing', { node, mountErrors: mountErrors.join('; ').slice(0, 500) || undefined });
      if (previousMountState !== 'missing') notifyDriveMissing({ node, mountErrors });
      return res.json({ ok: true, acknowledged: 'drive-missing' });
    }

    if (getSetting(mountKey) === 'missing') {
      setSetting(mountKey, 'ok');
      audit('tier_agent_drive_recovered', { node });
      notifyDriveRecovered({ node });
    }

    let inventoryStored = false;
    if (Array.isArray(body.inventory)) {
      try {
        let files = body.inventory.slice(0, 200000);
        const mask = parseAtimeMask(getTierNode(node)?.atime_mask);
        if (mask) files = maskSuspectAtimes(files, listTierNodeFiles(node), mask);
        replaceTierNodeFiles(node, files);
        inventoryStored = true;
      } catch (err) {
        errors.push(`inventory store failed: ${err.message}`);
      }
    }

    recordTierAgentReport(node, { inventoryStored, errors, telemetry, telemetryLevel: telemetryHealth.level });
    emitTelemetry();
    const publishedHash = getTierPlan(node)?.published?.planHash || null;
    const converged = body.converged === true && errors.length === 0 && !!body.planHash && body.planHash === publishedHash;
    if (converged) markTierPlanConverged(node, { planHash: body.planHash });
    audit('tier_agent_report', { node, planHash: body.planHash || null, publishedHash, converged, bytesFreed: body.bytesFreed || 0, droppedCount: (body.dropped || []).length, inventoryCount: Array.isArray(body.inventory) ? body.inventory.length : 0, errors: errors.join('; ').slice(0, 500) || undefined, skipped: skipped.join('; ').slice(0, 500) || undefined });
    if ((body.bytesFreed || 0) > 0 || errors.length || skipped.length) {
      notifyAgentReport({ node, body, errors, skipped, publishedHash, converged });
    }
    return res.json({ ok: true, converged });
  });
}

module.exports = { registerTierAgentRoutes };
