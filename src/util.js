// Pure helpers: crypto/string/format utilities with no I/O and no app state.
const crypto = require('crypto');

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

// Constant-time string comparison for secrets (webhook secrets, admin credentials).
function safeEqual(a, b) {
  const ba = Buffer.from(String(a ?? ''));
  const bb = Buffer.from(String(b ?? ''));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// A real Discord user ID (snowflake). Rows like plex_12345 and stray junk must never be
// mentioned as <@...> or DM'd.
function isSnowflake(id) {
  return /^\d{17,20}$/.test(String(id || ''));
}

function canonicalizeEmail(raw) {
  const email = String(raw || '').trim().toLowerCase();
  const [local, domain] = email.split('@');
  if (!domain) return email;
  if (domain === 'plex.local') return `__placeholder__:${email}`;
  if (domain === 'gmail.com' || domain === 'googlemail.com') {
    return `${local.split('+')[0].replace(/\./g, '')}@gmail.com`;
  }
  return `${local.split('+')[0]}@${domain}`;
}

function isValidEmail(email) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email); }

function mediaTypeLabel(mediaType, is4k) { if (mediaType === 'tv') return is4k ? '4K TV Show' : 'TV Show'; return is4k ? '4K Movie' : 'Movie'; }

function mediaTypeEmoji(mediaType, is4k) { if (mediaType === 'tv') return '📺'; return is4k ? '🎥' : '🎬'; }

function requestStatusBadge(status) {
  return ({ pending: '⏳ Pending', approved: '🚀 Approved', available: '✅ Available', declined: '🚫 Declined', cancelled: '↩️ Cancelled' })[status] || `▫️ ${status}`;
}

function discordTimestamp(ms, style = 'R') { return `<t:${Math.floor(ms / 1000)}:${style}>`; }

// Formats one media type's slice of Overseerr's GET /user/{id}/quota response into a short
// human line. A missing/zero limit means Overseerr has no quota configured for this user/type —
// treated as unlimited (returns null) rather than shown as "0 left".
function quotaLine(quota, mediaType) {
  const q = quota?.[mediaType];
  if (!q || !q.limit) return null;
  const remaining = Number.isFinite(q.remaining) ? q.remaining : Math.max(0, q.limit - (q.used || 0));
  const label = mediaType === 'tv' ? 'series' : 'movie';
  return `${remaining} of ${q.limit} ${label} request${q.limit === 1 ? '' : 's'} left${q.days ? ` (resets every ${q.days}d)` : ''}`;
}

// Turns fetchReleaseEta()'s normalized info into a one-line human explanation of when the title
// might become downloadable, or null when release timing adds nothing (released a while ago,
// aired show with no upcoming episode). `waiting` is true when the title simply isn't out yet —
// callers use it to soften "being grabbed now" copy. Dates render as Discord timestamps so every
// viewer sees their own timezone/locale.
function releaseEtaInfo(info, now = Date.now()) {
  if (!info) return null;
  const ts = v => { const t = Date.parse(v || ''); return Number.isFinite(t) ? t : null; };
  const when = t => `${discordTimestamp(t, 'D')} (${discordTimestamp(t, 'R')})`;
  if (info.kind === 'movie') {
    const digital = ts(info.digitalRelease) ?? ts(info.physicalRelease);
    const cinemas = ts(info.inCinemas);
    if (digital != null) {
      if (digital > now) return { line: `📅 Digital release expected ${when(digital)} — downloads usually start around then.`, waiting: true };
      if (now - digital <= 30 * 86400000) return { line: `💿 Digitally released ${discordTimestamp(digital, 'R')} — a good copy should turn up soon.`, waiting: false };
      return null;
    }
    // Radarr calling it 'released' outranks a missing digital date — the movie is out, so
    // never claim it's still waiting on a release.
    if (info.status === 'released') return null;
    if (cinemas != null && cinemas > now) return { line: `🎬 Hits theaters ${when(cinemas)} — digital release usually follows a few months later.`, waiting: true };
    // A theatrical-only "not out yet" claim is only plausible while a digital window could
    // still be coming (~6 months); past that the metadata is stale, not the release.
    if (cinemas != null && now - cinemas <= 180 * 86400000) return { line: `🎬 In theaters since ${discordTimestamp(cinemas, 'D')} — no digital date announced yet; those typically land a few months after the theatrical release.`, waiting: true };
    if (cinemas == null && info.status) return { line: '📅 No release date announced yet — this could be a long wait.', waiting: true };
    return null;
  }
  if (info.kind === 'tv') {
    const first = ts(info.firstAired);
    const next = ts(info.nextAiring);
    if (first != null && first > now) return { line: `📅 Premieres ${when(first)}.`, waiting: true };
    if (next != null) return { line: `📅 Next episode airs ${when(next)}.`, waiting: false };
    if (info.status === 'upcoming') return { line: '📅 Not airing yet — no premiere date announced.', waiting: true };
    return null;
  }
  return null;
}

function statusEmoji(v) {
  if (['ok', 'configured'].includes(v)) return '✅';
  if (v === 'skipped') return '⏭️';
  return '❌';
}

function pad(n) { return String(n).padStart(2, '0'); }

// Human-readable duration from milliseconds: "45m", "1h", "1h 30m", "2d 3h". Sub-hour values
// must never round to "0h" — escalation delays are now configured in minutes.
function fmtDuration(ms) {
  const minutes = Math.max(0, Math.round(ms / 60000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days}d ${hours % 24}h` : `${days}d`;
}

function mimeFor(ext) { return ({ '.mkv': 'video/x-matroska', '.mp4': 'video/mp4', '.avi': 'video/x-msvideo', '.mov': 'video/quicktime', '.wmv': 'video/x-ms-wmv' })[ext] || 'application/octet-stream'; }

const gb = bytes => bytes / (1024 ** 3);

// Human-readable size that stays honest at both ends: a 500 MB episode must not render as
// "0 GB", and multi-TB libraries shouldn't show meaningless decimals.
const fmtSpace = bytes => {
  const g = gb(bytes);
  if (g >= 1024) return `${(g / 1024).toFixed(2)} TB`;
  if (g >= 10) return `${g.toFixed(0)} GB`;
  if (g >= 1) return `${g.toFixed(1)} GB`;
  return `${Math.max(0, Math.round(bytes / 1024 ** 2))} MB`;
};

function progressBar(pct) {
  const filled = Math.round(pct / 10);
  return '▰'.repeat(filled) + '▱'.repeat(10 - filled);
}

function queuePercent(item) {
  if (!item.size) return 0;
  return Math.max(0, Math.min(100, Math.round(((item.size - item.sizeleft) / item.size) * 100)));
}

function queueItemLooksUnhealthy(item) {
  return item.trackedStatus === 'warning' || item.status === 'warning' || item.status === 'failed' || item.messages.length > 0;
}

module.exports = { sha256, safeEqual, isSnowflake, canonicalizeEmail, isValidEmail, mediaTypeLabel, mediaTypeEmoji, requestStatusBadge, discordTimestamp, quotaLine, releaseEtaInfo, statusEmoji, pad, fmtDuration, mimeFor, gb, fmtSpace, progressBar, queuePercent, queueItemLooksUnhealthy };
