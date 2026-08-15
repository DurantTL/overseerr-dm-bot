const { safeEqual } = require('../util');

// Plex cannot attach a custom header, while Overseerr and Tautulli keep secrets out of access logs.
function webhookSecretOk(req, expected, { header = 'x-webhook-secret', allowQuery = false } = {}) {
  if (!expected) return true;
  if (safeEqual(req.headers?.[header], expected)) return true;
  return allowQuery ? safeEqual(req.query?.secret, expected) : false;
}

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

  return { overseerr, plex, tautulli };
}

module.exports = { createWebhookHandlers, webhookSecretOk };
