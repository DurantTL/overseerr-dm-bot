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
  return ({ pending: '⏳ Pending', approved: '🚀 Approved', available: '✅ Available', declined: '🚫 Declined' })[status] || `▫️ ${status}`;
}

function discordTimestamp(ms, style = 'R') { return `<t:${Math.floor(ms / 1000)}:${style}>`; }

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
    if (cinemas != null && cinemas > now) return { line: `🎬 Hits theaters ${when(cinemas)} — digital release usually follows a few months later.`, waiting: true };
    if (cinemas != null) return { line: `🎬 In theaters since ${discordTimestamp(cinemas, 'D')} — no digital date announced yet; those typically land a few months after the theatrical release.`, waiting: true };
    if (info.status && info.status !== 'released') return { line: '📅 No release date announced yet — this could be a long wait.', waiting: true };
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

function mimeFor(ext) { return ({ '.mkv': 'video/x-matroska', '.mp4': 'video/mp4', '.avi': 'video/x-msvideo', '.mov': 'video/quicktime', '.wmv': 'video/x-ms-wmv' })[ext] || 'application/octet-stream'; }

const gb = bytes => bytes / (1024 ** 3);

const fmtSpace = bytes => gb(bytes) >= 1024 ? `${(gb(bytes) / 1024).toFixed(2)} TB` : `${gb(bytes).toFixed(0)} GB`;

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

module.exports = { sha256, safeEqual, isSnowflake, canonicalizeEmail, isValidEmail, mediaTypeLabel, mediaTypeEmoji, requestStatusBadge, discordTimestamp, releaseEtaInfo, statusEmoji, pad, mimeFor, gb, fmtSpace, progressBar, queuePercent, queueItemLooksUnhealthy };
