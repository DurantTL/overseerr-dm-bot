// Idempotency helper for the /webhook/* routes: reduces a webhook payload to a stable dedupe
// key. Kept separate from db.js's recordWebhookEvent/pruneWebhookEvents (the storage side) so
// the key-derivation logic is independently testable without touching SQLite.
const { CONFIG } = require('./config');

// Builds a stable dedupe key for a webhook payload, coarsened to a fixed time bucket so a
// genuine redelivery (seconds to a few minutes later) collides with the original while a later,
// unrelated re-occurrence of the same event (e.g. a rewatch) does not.
function webhookEventKey(source, body) {
  const bucket = Math.floor(Date.now() / (CONFIG.WEBHOOK_DEDUPE_WINDOW_MINUTES * 60000));
  if (source === 'overseerr') {
    const media = body.media || {};
    const mediaId = media.media_type === 'tv' ? `tvdb:${media.tvdbId}` : `tmdb:${media.tmdbId}`;
    const reqId = body.request?.request_id;
    return `overseerr:${body.notification_type}:${reqId || mediaId}:${bucket}`;
  }
  if (source === 'plex') {
    const { event, Account, Metadata, Server } = body;
    return `plex:${event}:${Server?.uuid || ''}:${Metadata?.ratingKey || ''}:${Account?.id || ''}:${bucket}`;
  }
  if (source === 'tautulli') {
    const mediaId = body.media_type === 'movie' ? `tmdb:${body.tmdb_id}` : `tvdb:${body.tvdb_id}`;
    return `tautulli:${body.event}:${body.machine_id || ''}:${mediaId}:${body.user_email || ''}:${bucket}`;
  }
  return `${source}:unknown:${bucket}`;
}

module.exports = { webhookEventKey };
