// Idempotency helper for the /webhook/* routes: reduces a webhook payload to a stable dedupe
// key. Kept separate from db.js's recordWebhookEvent/pruneWebhookEvents (the storage side) so
// the key-derivation logic is independently testable without touching SQLite.
//
// No time bucket is baked into the key itself — db.js's recordWebhookEvent applies the dedupe
// window as a real sliding check against created_at instead. A fixed floor(now/window) bucket
// would let two deliveries a fraction of a second apart land in different buckets right at a
// boundary and both be treated as new.
function webhookEventKey(source, body) {
  if (source === 'overseerr') {
    const media = body.media || {};
    const mediaId = media.media_type === 'tv' ? `tvdb:${media.tvdbId}` : `tmdb:${media.tmdbId}`;
    const reqId = body.request?.request_id;
    // request_id alone already disambiguates 4K from non-4K (Seerr tracks them as separate
    // requests); the mediaId fallback doesn't carry that distinction on its own, so tack is4k on
    // — otherwise a standard and a 4K MEDIA_AVAILABLE for the same title could collide and one
    // would get silently treated as a duplicate of the other.
    const fallback = `${mediaId}${media.is4k ? ':4k' : ''}`;
    return `overseerr:${body.notification_type}:${reqId || fallback}`;
  }
  if (source === 'plex') {
    const { event, Account, Metadata, Server } = body;
    return `plex:${event}:${Server?.uuid || ''}:${Metadata?.ratingKey || ''}:${Account?.id || ''}`;
  }
  if (source === 'tautulli') {
    const mediaId = body.media_type === 'movie' ? `tmdb:${body.tmdb_id}` : `tvdb:${body.tvdb_id}`;
    return `tautulli:${body.event}:${body.machine_id || ''}:${mediaId}:${body.user_email || ''}${body.is_4k ? ':4k' : ''}`;
  }
  return `${source}:unknown`;
}

module.exports = { webhookEventKey };
