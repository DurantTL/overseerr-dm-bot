'use strict';

// Trends for Home, from history the bot already keeps: disk free (disk_space_samples), service
// uptime (service_samples) and requests (requests). Each series says so when there is not
// enough history yet instead of drawing a flat or invented line.

const DAY_MS = 24 * 60 * 60 * 1000;

function diskTrend(database, { now = Date.now(), days = 30, points = 60 } = {}) {
  const since = now - days * DAY_MS;
  const rows = database.prepare('SELECT root, free_bytes, total_bytes, sampled_at FROM disk_space_samples WHERE sampled_at >= ? ORDER BY sampled_at').all(since);
  const byRoot = new Map();
  for (const r of rows) {
    if (!byRoot.has(r.root)) byRoot.set(r.root, []);
    byRoot.get(r.root).push(r);
  }
  return [...byRoot.entries()].map(([root, list]) => {
    const step = Math.max(1, Math.ceil(list.length / points));
    const series = list.filter((_, i) => i % step === 0 || i === list.length - 1).map(r => ({ t: r.sampled_at, v: r.free_bytes }));
    const first = list[0];
    const last = list[list.length - 1];
    return { root, series, free: last.free_bytes, total: last.total_bytes, change: last.free_bytes - first.free_bytes, spanMs: last.sampled_at - first.sampled_at };
  });
}

// Share of service checks that were up, per day, oldest first. Days with no checks are null.
function uptimeByDay(database, { now = Date.now(), days = 7 } = {}) {
  const end = Math.floor(now / DAY_MS) * DAY_MS + DAY_MS;
  const start = end - days * DAY_MS;
  const rows = database.prepare(`SELECT CAST((sampled_at - ?) / ${DAY_MS} AS INTEGER) AS d, COUNT(*) AS n, SUM(state = 'down') AS down
    FROM service_samples WHERE sampled_at >= ? AND sampled_at < ? GROUP BY d`).all(start, start, end);
  const out = Array.from({ length: days }, (_, i) => ({ day: start + i * DAY_MS, pct: null }));
  for (const r of rows) if (out[r.d] && r.n) out[r.d].pct = Math.round(((r.n - r.down) / r.n) * 1000) / 10;
  return out;
}

function requestsByDay(database, { now = Date.now(), days = 14 } = {}) {
  const end = Math.floor(now / DAY_MS) * DAY_MS + DAY_MS;
  const start = end - days * DAY_MS;
  const iso = ms => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
  const rows = database.prepare('SELECT date(created_at) AS d, COUNT(*) AS n FROM requests WHERE created_at >= ? AND created_at < ? GROUP BY d').all(iso(start), iso(end));
  const counts = new Map(rows.map(r => [r.d, r.n]));
  return Array.from({ length: days }, (_, i) => {
    const day = start + i * DAY_MS;
    return { day, n: counts.get(new Date(day).toISOString().slice(0, 10)) || 0 };
  });
}

function gatherTrends(database, opts = {}) {
  const safe = fn => { try { return fn(); } catch { return null; } };
  return {
    disks: safe(() => diskTrend(database, opts)),
    uptime: safe(() => uptimeByDay(database, opts)),
    requests: safe(() => requestsByDay(database, opts)),
  };
}

module.exports = { DAY_MS, diskTrend, uptimeByDay, requestsByDay, gatherTrends };
