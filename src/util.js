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

module.exports = { sha256, safeEqual, isSnowflake, canonicalizeEmail, isValidEmail, mediaTypeLabel, mediaTypeEmoji, requestStatusBadge, discordTimestamp, statusEmoji, pad, mimeFor, gb, fmtSpace, progressBar, queuePercent, queueItemLooksUnhealthy };
