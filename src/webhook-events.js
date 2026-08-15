// Idempotency helper for the /webhook/* routes: reduces a webhook payload to a stable dedupe
// key. Kept separate from db.js's recordWebhookEvent/pruneWebhookEvents (the storage side) so
// the key-derivation logic is independently testable without touching SQLite.
//
// No time bucket is baked into the key itself — db.js's recordWebhookEvent applies the dedupe
// window as a real sliding check against created_at instead. A fixed floor(now/window) bucket
// would let two deliveries a fraction of a second apart land in different buckets right at a
// boundary and both be treated as new.
function webhookEventKey(source, body, userKey) {
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
    const guid = Metadata?.Guid || [];
    const mediaId = Metadata?.type === 'movie'
      ? (guid.find(value => value.id?.startsWith('tmdb://'))?.id || '').replace('tmdb://', 'tmdb:')
      : (guid.find(value => value.id?.startsWith('tvdb://'))?.id || '').replace('tvdb://', 'tvdb:');
    if (event === 'media.scrobble' && Server?.uuid && mediaId && userKey) {
      return `watched:${String(Server.uuid).toLowerCase()}:${mediaId}:${String(userKey).toLowerCase()}`;
    }
    return `plex:${event}:${Server?.uuid || ''}:${Metadata?.ratingKey || ''}:${Account?.id || ''}`;
  }
  if (source === 'tautulli') {
    const rawMediaId = body.media_type === 'movie' ? body.tmdb_id : body.tvdb_id;
    const mediaId = `${body.media_type === 'movie' ? 'tmdb' : 'tvdb'}:${rawMediaId ?? ''}`;
    if (body.event === 'watched' && body.machine_id && String(rawMediaId ?? '').trim() && userKey) {
      return `watched:${String(body.machine_id).toLowerCase()}:${mediaId}:${String(userKey).toLowerCase()}`;
    }
    return `tautulli:${body.event}:${body.machine_id || ''}:${mediaId}:${body.user_email || ''}${body.is_4k ? ':4k' : ''}`;
  }
  return `${source}:unknown`;
}

module.exports = { webhookEventKey };
