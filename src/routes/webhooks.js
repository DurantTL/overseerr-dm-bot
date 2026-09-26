const crypto = require('crypto');
const { safeEqual } = require('../util');

// Plex cannot attach a custom header, while Overseerr and Tautulli keep secrets out of access logs.
function webhookSecretOk(req, expected, { header = 'x-webhook-secret', allowQuery = false } = {}) {
  if (!expected) return true;
  if (safeEqual(req.headers?.[header], expected)) return true;
  return allowQuery ? safeEqual(req.query?.secret, expected) : false;
}

// Rejects a bad/missing secret before any multipart or JSON body parsing runs, so an
// unauthenticated caller can't spend parser/memory work on an oversized payload. The secret
// itself lives in a header (or query string for Plex, which can't send custom headers), so it's
// available before the body is touched.
function requireWebhookSecret(getExpected, opts) {
  return (req, res, next) => {
    if (!webhookSecretOk(req, getExpected(), opts)) return res.status(401).json({ error: 'Unauthorized' });
    next();
  };
}

// GitHub signs webhook payloads with HMAC-SHA256 over the raw request bytes,
// delivered as X-Hub-Signature-256: "sha256=<hex>". Unlike the other webhook sources
// (shared secret in a header), the signature can only be verified against the raw body,
// so this middleware does a bounded raw read itself and runs before any JSON parsing —
// mirroring requireWebhookSecret's position in the chain. 503 when the endpoint isn't
// configured rather than fail-open: an unconfigured endpoint must not accept payloads.
function requireGitHubSignature(getExpected, { limit = 1024 * 1024 } = {}) {
  return (req, res, next) => {
    const expected = getExpected();
    if (!expected) return res.status(503).json({ error: 'GitHub webhook not configured' });
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limit) tooLarge = true;
      else chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) return res.status(413).json({ error: 'Payload too large' });
      const raw = Buffer.concat(chunks);
      const signature = req.headers?.['x-hub-signature-256'] || '';
      const digest = `sha256=${crypto.createHmac('sha256', expected).update(raw).digest('hex')}`;
      if (!safeEqual(signature, digest)) return res.status(401).json({ error: 'Unauthorized' });
      req.rawBody = raw;
      next();
    });
    req.on('error', () => {
      if (!res.headersSent) res.status(400).json({ error: 'Bad request' });
    });
  };
}

// workflow_run conclusions worth a pre-merge alert. Everything else (success, cancelled,
// skipped, neutral, stale) stays quiet.
const GITHUB_CI_FAILURE_CONCLUSIONS = new Set(['failure', 'timed_out', 'action_required']);

function createWebhookHandlers({
  config,
  audit,
  webhookEventKey,
  recordWebhookEvent,
  forgetWebhookEvent,
  webhookUserKey,
  resolvePlexWebhookEmail,
  handleOverseerrWebhook,
  handlePlexWebhook,
  handleTautulliWebhook,
  notifyCiFailure,
  log,
}) {
  async function overseerr(req, res) {
    if (!webhookSecretOk(req, config.WEBHOOK_SECRET)) return res.status(401).json({ error: 'Unauthorized' });
    res.sendStatus(200);
    let eventKey;
    try {
      let body = req.body;
      if (typeof body.payload === 'string') body = JSON.parse(body.payload);
      eventKey = webhookEventKey('overseerr', body);
      if (!recordWebhookEvent(eventKey, 'overseerr')) {
        audit('webhook_duplicate', { source: 'overseerr', type: body.notification_type });
        return;
      }
      audit('webhook_received', { source: 'overseerr', type: body.notification_type });
      await handleOverseerrWebhook(body);
    } catch (err) {
      if (eventKey) forgetWebhookEvent(eventKey);
      audit('external_api_error', { provider: 'overseerr_webhook', error: err.message });
    }
  }

  async function plex(req, res) {
    if (!webhookSecretOk(req, config.WEBHOOK_SECRET, { allowQuery: true })) return res.status(401).json({ error: 'Unauthorized' });
    res.sendStatus(200);
    let eventKey;
    try {
      const payload = JSON.parse(req.body.payload || '{}');
      let userKey = null;
      if (payload.event === 'media.scrobble') {
        const email = await resolvePlexWebhookEmail(payload.Account?.id).catch(err => {
          log.warn(`Could not resolve Plex webhook account ${payload.Account?.id || 'unknown'}: ${err.message}`);
          return null;
        });
        userKey = webhookUserKey(email);
        if (!userKey) audit('webhook_identity_unresolved', { source: 'plex', accountId: payload.Account?.id || null });
      }
      eventKey = webhookEventKey('plex', payload, userKey);
      if (!recordWebhookEvent(eventKey, 'plex')) {
        audit('webhook_duplicate', { source: 'plex', event: payload.event });
        return;
      }
      audit('webhook_received', { source: 'plex', event: payload.event });
      await handlePlexWebhook(payload);
    } catch (err) {
      if (eventKey) forgetWebhookEvent(eventKey);
      audit('external_api_error', { provider: 'plex_webhook', error: err.message });
    }
  }

  async function tautulli(req, res) {
    if (!webhookSecretOk(req, config.TAUTULLI_WEBHOOK_SECRET, { header: 'x-tautulli-secret' })) return res.status(401).json({ error: 'Unauthorized' });
    res.sendStatus(200);
    let eventKey;
    try {
      const body = req.body || {};
      const userKey = body.event === 'watched' ? webhookUserKey(body.user_email) : null;
      if (body.event === 'watched' && !userKey) audit('webhook_identity_unresolved', { source: 'tautulli' });
      eventKey = webhookEventKey('tautulli', body, userKey);
      if (!recordWebhookEvent(eventKey, 'tautulli')) {
        audit('webhook_duplicate', { source: 'tautulli', event: body.event });
        return;
      }
      audit('webhook_received', { source: 'tautulli', event: body.event });
      await handleTautulliWebhook(body);
    } catch (err) {
      if (eventKey) forgetWebhookEvent(eventKey);
      audit('external_api_error', { provider: 'tautulli_webhook', error: err.message });
    }
  }

  // Pre-merge CI watchdog: GitHub fires workflow_run when each workflow finishes. On a
  // failing conclusion we alert (DM + audit) so a red PR never gets merged unnoticed;
  // successes stay quiet. The 200 goes out before any work — GitHub retries slow
  // responses, and alerting must never block the ack.
  async function github(req, res) {
    res.sendStatus(200);
    let eventKey;
    try {
      const event = req.headers?.['x-github-event'] || '';
      let body;
      try {
        body = JSON.parse(req.rawBody ? req.rawBody.toString('utf8') : '{}');
      } catch (_parseErr) {
        audit('webhook_invalid_payload', { source: 'github', event });
        return;
      }
      if (event === 'ping') {
        audit('webhook_received', { source: 'github', event: 'ping', hook_id: body.hook_id || null });
        return;
      }
      if (event !== 'workflow_run') return; // push, pull_request, etc.: nothing to say
      const run = body.workflow_run || {};
      if (body.action !== 'completed') return; // requested / in_progress: CI still running
      const conclusion = run.conclusion || '';
      eventKey = webhookEventKey('github', { run_id: run.id, conclusion });
      if (!recordWebhookEvent(eventKey, 'github')) {
        audit('webhook_duplicate', { source: 'github', event: 'workflow_run', run_id: run.id });
        return;
      }
      if (!GITHUB_CI_FAILURE_CONCLUSIONS.has(conclusion)) {
        audit('webhook_received', { source: 'github', event: 'workflow_run', conclusion, run_id: run.id });
        return;
      }
      const prs = (run.pull_requests || []).map(pr => `#${pr.number}`).join(', ') || 'no linked PR';
      const detail = {
        workflow: run.name || 'unknown workflow',
        conclusion,
        prs,
        sha: String(run.head_sha || '').slice(0, 12),
        branch: run.head_branch || '',
        url: run.html_url || '',
        run_id: run.id,
      };
      audit('github_ci_failed', { source: 'github', ...detail });
      if (notifyCiFailure) await notifyCiFailure(detail);
    } catch (err) {
      if (eventKey) forgetWebhookEvent(eventKey);
      audit('external_api_error', { provider: 'github_webhook', error: err.message });
    }
  }

  return { overseerr, plex, tautulli, github };
}

module.exports = { createWebhookHandlers, webhookSecretOk, requireWebhookSecret, requireGitHubSignature };
