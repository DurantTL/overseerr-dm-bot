'use strict';

// F9 weekly "Not Watchable Yet" digest for the admin channel. It reuses the dashboard's rows
// (gatherIncompleteRequests), so the digest and the Operations card always agree, and groups
// them by requester: what each person asked for that still can't be watched, how long ago, and
// what is happening with it now.

const PER_REQUESTER = 10;
const DAY_MS = 86400000;

// Local calendar date, weekday (0 = Sunday) and hour in `tz`.
function localParts(now, tz) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short', hour: 'numeric', hourCycle: 'h23',
  }).formatToParts(new Date(now)).map(p => [p.type, p.value]));
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday);
  return { date: `${parts.year}-${parts.month}-${parts.day}`, weekday, hour: Number(parts.hour) % 24 };
}

// The run key ("YYYY-MM-DD") if the digest is due now, else null. Due from the configured hour
// until the end of that local day, once per day, so a restart or a busy sweep at 9:00 still
// posts later that morning instead of skipping a week.
function dueKey({ now, tz, day, hour, lastKey }) {
  const local = localParts(now, tz);
  if (local.weekday !== day || local.hour < hour || local.date === lastKey) return null;
  return local.date;
}

const ago = (now, at) => {
  if (!Number.isFinite(at)) return null;
  const days = Math.floor((now - at) / DAY_MS);
  return days <= 0 ? 'today' : days === 1 ? '1 day ago' : `${days} days ago`;
};

function seerrLink(base, row) {
  if (!base || !row.tmdbId) return null;
  return `${base.replace(/\/$/, '')}/${row.mediaType === 'tv' ? 'tv' : 'movie'}/${row.tmdbId}`;
}

// { title, description } for the weekly post. `rows` are gatherIncompleteRequests rows; only
// their `digest` part is used.
function buildNotWatchableDigest(rows, { now = Date.now(), seerrUrl = '' } = {}) {
  const items = (rows || []).map(r => r.digest).filter(Boolean);
  if (!items.length) return { title: 'Not Watchable Yet: all clear', description: 'Every open request is watchable. Nothing is waiting.' };
  const groups = new Map();
  for (const item of items) {
    const key = item.requesterId || '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  const ordered = [...groups.entries()].sort((a, b) => b[1].length - a[1].length || (a[0] ? 0 : 1) - (b[0] ? 0 : 1));
  const sections = ordered.map(([requesterId, list]) => {
    list.sort((a, b) => (a.requestedAt ?? Infinity) - (b.requestedAt ?? Infinity));
    const lines = list.slice(0, PER_REQUESTER).map(item => {
      const link = seerrLink(seerrUrl, item);
      const name = link ? `[${item.title.replace(/[[\]]/g, '')}](${link})` : `**${item.title}**`;
      const when = ago(now, item.requestedAt);
      return `${item.failed ? '❌ ' : '• '}${name}: ${item.status}${when ? ` · requested ${when}` : ''}`;
    });
    if (list.length > PER_REQUESTER) lines.push(`• …and ${list.length - PER_REQUESTER} more`);
    // Mentions inside an embed show the name without pinging anyone.
    return `${requesterId ? `<@${requesterId}>` : '**Requester unknown**'} (${list.length})\n${lines.join('\n')}`;
  });
  let description = sections.join('\n\n');
  if (description.length > 4000) description = `${description.slice(0, 3990)}\n…`;
  return { title: `Not Watchable Yet: ${items.length} title${items.length === 1 ? '' : 's'}`, description };
}

module.exports = { localParts, dueKey, buildNotWatchableDigest, PER_REQUESTER };
