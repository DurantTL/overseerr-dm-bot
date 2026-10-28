'use strict';

// F7 quiet hours for the admin channels. During the window every channel post still goes out
// immediately, but as a Discord silent message (no push, no phone buzz), so buttons keep working
// and nothing waits in a queue that a restart could lose. Each silenced post is noted, and the
// first digest sweep after the window ends posts one summary grouped by category, with a jump
// link to each post. Callers mark the few posts that must still ping (disk and drive health) as
// urgent; those bypass the window and are not digested. Member DMs are not touched.

// Discord's SUPPRESS_NOTIFICATIONS message flag (1 << 12), the "@silent" flag.
const SUPPRESS_NOTIFICATIONS = 1 << 12;
const STORE_KEY = 'quiet_digest_items';
const MAX_ITEMS = 300;
const PER_GROUP = 10;

// Digest sections, in order. Channels not listed here (audit, deploy, what's new) are still
// silenced during quiet hours but left out of the digest: they are logs, not things to act on.
const GROUPS = [
  ['system', 'Health'],
  ['requests', 'Requests'],
  ['downloads', 'Downloads'],
  ['cleanup', 'Cleanup'],
  ['playback', 'Playback'],
  ['admin', 'Admin'],
];
const DIGESTED = new Set(GROUPS.map(([kind]) => kind));

function validTimeZone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function localHour(now, tz) {
  const part = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' })
    .formatToParts(new Date(now)).find(p => p.type === 'hour');
  return Number(part?.value) % 24;
}

// start === end means no window. A window that crosses midnight (22 → 7) wraps.
function inWindow(hour, start, end) {
  if (start === end) return false;
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

function messageTitle(msg) {
  if (typeof msg === 'string') return msg.split('\n')[0].slice(0, 120);
  const embed = msg?.embeds?.[0];
  const title = embed?.data?.title ?? embed?.title;
  if (title) return String(title).slice(0, 120);
  if (msg?.content) return String(msg.content).split('\n')[0].slice(0, 120);
  return 'Notification';
}

function silence(msg) {
  const base = typeof msg === 'string' ? { content: msg } : { ...msg };
  base.flags = (typeof base.flags === 'number' ? base.flags : 0) | SUPPRESS_NOTIFICATIONS;
  return base;
}

// Markdown links need the title's brackets out of the way.
const linkText = title => title.replace(/[[\]]/g, '');

// { title, description } for the digest embed, or null when nothing in the list is digested.
function buildDigest(items, { perGroup = PER_GROUP } = {}) {
  const shown = items.filter(i => DIGESTED.has(i.kind));
  if (!shown.length) return null;
  const sections = [];
  for (const [kind, label] of GROUPS) {
    const group = shown.filter(i => i.kind === kind);
    if (!group.length) continue;
    const lines = group.slice(0, perGroup).map(i => (i.url ? `• [${linkText(i.title)}](${i.url})` : `• ${i.title}`));
    if (group.length > perGroup) lines.push(`• …and ${group.length - perGroup} more`);
    sections.push(`**${label}** (${group.length})\n${lines.join('\n')}`);
  }
  let description = sections.join('\n\n');
  // Discord caps an embed description at 4096 characters.
  if (description.length > 4000) description = `${description.slice(0, 3990)}\n…`;
  return { title: `Overnight digest: ${shown.length} post${shown.length === 1 ? '' : 's'}`, description };
}

// settings(): { enabled, start, end, tz }, read at each call so dashboard overrides apply at once.
// store: { get(key), set(key, value), del(key) } over app_settings.
function createQuietHours({ settings, store, now = () => Date.now() }) {
  function isQuiet(at = now()) {
    const s = settings();
    if (!s.enabled || !validTimeZone(s.tz)) return false;
    return inWindow(localHour(at, s.tz), s.start, s.end);
  }

  function readItems() {
    try {
      const parsed = JSON.parse(store.get(STORE_KEY) || '[]');
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function record(kind, msg, sent) {
    const items = readItems();
    items.push({ kind, title: messageTitle(msg), url: typeof sent?.url === 'string' ? sent.url : null, at: now() });
    store.set(STORE_KEY, JSON.stringify(items.slice(-MAX_ITEMS)));
  }

  // The digest to post now, or null: only once the window is over and something was silenced.
  // Call clear() after it posts, so a failed post is retried on the next sweep.
  function pendingDigest(at = now()) {
    if (isQuiet(at)) return null;
    const items = readItems();
    if (!items.length) return null;
    return { items, digest: buildDigest(items) };
  }

  function clear() { store.del(STORE_KEY); }

  return { isQuiet, silence, record, pendingDigest, clear };
}

module.exports = { SUPPRESS_NOTIFICATIONS, GROUPS, validTimeZone, localHour, inWindow, messageTitle, silence, buildDigest, createQuietHours };
