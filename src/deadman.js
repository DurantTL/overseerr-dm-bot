'use strict';

// Dead-man's switch for the scheduled jobs (item 11). Each automation-registry job can have a
// Healthchecks or Uptime Kuma Push URL; after a scheduled run of that job succeeds, the bot pings
// it. The monitor alerts when a ping doesn't arrive inside its window, so a job that silently stops
// running (or keeps failing) is reported, and nothing is sent while things are fine. Report-only:
// the bot never acts on a missed ping, and failures are not pinged (the monitor's silence is the
// signal).
//
// Push URLs carry the monitor's token, so they are treated as credentials: they are never logged,
// returned to the dashboard, or put in an error message. Only job ids and outcomes leave here.

const axios = require('axios');

const JOB_ID = /^[a-z0-9][a-z0-9-]*$/;

// DEADMAN_PING_URLS: "job-id=url" entries separated by commas or whitespace. Returns the parsed
// map plus the job ids of entries that were ignored (bad id or not an http(s) URL), so startup can
// say which entry to fix without echoing the URL.
function parseDeadmanUrls(raw) {
  const urls = new Map();
  const invalid = [];
  for (const entry of String(raw || '').split(/[\s,]+/).filter(Boolean)) {
    const eq = entry.indexOf('=');
    const id = (eq > 0 ? entry.slice(0, eq) : entry).trim().toLowerCase();
    const url = eq > 0 ? entry.slice(eq + 1).trim() : '';
    let ok = JOB_ID.test(id) && !!url;
    if (ok) {
      try { ok = ['http:', 'https:'].includes(new URL(url).protocol); } catch { ok = false; }
    }
    if (ok) urls.set(id, url);
    else invalid.push(JOB_ID.test(id) ? id : `entry ${invalid.length + 1}`);
  }
  return { urls, invalid };
}

// One GET to the push URL. Healthchecks and Uptime Kuma both count a plain GET as "up". Never
// throws; the result carries no URL or response body.
async function pingDeadman(url, { http = axios, timeoutMs = 10000 } = {}) {
  try {
    const res = await http.get(url, { timeout: timeoutMs, maxRedirects: 3, validateStatus: () => true, responseType: 'text' });
    return { ok: res.status >= 200 && res.status < 300, status: res.status };
  } catch (err) {
    return { ok: false, status: null, reason: err?.code || 'request failed' };
  }
}

// The registry-facing side: which jobs are watched, and a ping after each scheduled success.
function createDeadman({ raw, knownIds = [], http = axios, now = Date.now, logger = console } = {}) {
  const { urls, invalid } = parseDeadmanUrls(raw);
  const known = new Set(knownIds);
  const unknown = [...urls.keys()].filter(id => known.size && !known.has(id));
  if (invalid.length) logger.warn?.(`DEADMAN_PING_URLS: ignored ${invalid.length} entr${invalid.length === 1 ? 'y' : 'ies'} (${invalid.join(', ')}); expected job-id=https://...`);
  if (unknown.length) logger.warn?.(`DEADMAN_PING_URLS: no scheduled job named ${unknown.join(', ')}`);
  return {
    configured: id => urls.has(id),
    ids: () => [...urls.keys()],
    unknown: () => unknown.slice(),
    invalid: () => invalid.slice(),
    async ping(id) {
      const url = urls.get(id);
      if (!url) return null;
      const result = await pingDeadman(url, { http });
      if (!result.ok) logger.warn?.(`dead-man ping for ${id} failed (${result.status ?? result.reason})`);
      return { at: now(), ok: result.ok };
    },
  };
}

module.exports = { parseDeadmanUrls, pingDeadman, createDeadman };
