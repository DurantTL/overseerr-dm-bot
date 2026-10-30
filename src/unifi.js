'use strict';
// UDR7 (UniFi OS) local network data for the Services tab Network group.
//
// Reads the classic controller API through the UniFi OS proxy:
//   GET https://<UNIFI_HOST>/proxy/network/api/s/<site>/stat/health
//   GET https://<UNIFI_HOST>/proxy/network/api/s/<site>/stat/sta
//
// Auth: X-API-KEY header (local API key from the UniFi OS settings). If the
// key is rejected and UNIFI_USER/UNIFI_PASSWORD are set, falls back to the
// cookie session (POST /api/login), cached until it 401s.
//
// Real data only: no host or no credential -> null (the Network group stays
// hidden; no dead cards). Failures surface as { error } so the card can say
// why, matching the speedtest/ZFS pattern.
//
// Note on WiFi detail: wireless clients hang off the meshed Asus APs, which
// bridge L2, so the UDR7 still sees each client's MAC/IP and live rates —
// client counts, the wired/wireless split, and top talkers are real. Per-
// client signal quality is AP-side and not available here.

const axios = require('axios');
const https = require('https');
const { log } = require('./log');

const HISTORY_MAX = 60;
// Per request to the console. axios's `timeout` only measures socket inactivity, so a console that
// accepts the connection and then trickles (or never finishes) a response could hold the dashboard's
// request open; the AbortSignal caps the whole request at the same 8 s.
const UNIFI_TIMEOUT_MS = 8000;
const history = []; // [{ t, downMbps, upMbps }], oldest -> newest
let sessionCookie = null;

function agent(config) {
  // The console uses a self-signed cert; verification stays off unless
  // UNIFI_VERIFY_SSL=1.
  return new https.Agent({ rejectUnauthorized: config.UNIFI_VERIFY_SSL === true });
}

function baseUrl(config) {
  return `https://${config.UNIFI_HOST}/proxy/network`;
}

function requestOpts(config, headers) {
  return { headers, timeout: UNIFI_TIMEOUT_MS, signal: AbortSignal.timeout(UNIFI_TIMEOUT_MS), httpsAgent: agent(config) };
}

async function login(config, http) {
  const res = await http.post(
    `https://${config.UNIFI_HOST}/api/login`,
    { username: config.UNIFI_USER, password: config.UNIFI_PASSWORD },
    requestOpts(config, {})
  );
  const setCookie = (res.headers && res.headers['set-cookie']) || [];
  const token = setCookie.map((c) => String(c).split(';')[0]).find((c) => /^TOKEN=/.test(c));
  if (!token) throw new Error('unifi_login_no_cookie');
  sessionCookie = token;
}

async function apiGet(config, path, http = axios) {
  const headers = {};
  if (config.UNIFI_API_KEY) headers['X-API-KEY'] = config.UNIFI_API_KEY;
  if (sessionCookie) headers.Cookie = sessionCookie;
  try {
    const res = await http.get(baseUrl(config) + path, requestOpts(config, headers));
    return expectJson(res.data, path);
  } catch (err) {
    const status = err.response && err.response.status;
    if (!sessionCookie && (status === 401 || status === 403) && config.UNIFI_USER && config.UNIFI_PASSWORD) {
      await login(config, http);
      const retry = await http.get(baseUrl(config) + path, requestOpts(config, { ...headers, Cookie: sessionCookie }));
      return expectJson(retry.data, path);
    }
    if (!err.unifiPath) err.unifiPath = path;
    throw err;
  }
}

// The console answers a sign-in page (HTML) instead of JSON when a request isn't authorised on some
// firmware, with a 200. Treat anything that isn't a JSON object as a failure rather than "no data".
function expectJson(data, path) {
  if (data && typeof data === 'object') return data;
  const err = new Error('unexpected_response_not_json');
  err.code = 'unexpected_response_not_json';
  err.unifiPath = path;
  throw err;
}

// Why a read failed, as a short stable code the page turns into plain words. Never includes the key.
function failureReason(err) {
  const status = err.response && err.response.status;
  if (status === 401 || status === 403) return 'auth_rejected_check_key';
  if (status) return `http_${status}`;
  if (err.code === 'ECONNABORTED' || err.code === 'ERR_CANCELED' || err.name === 'AbortError' || err.name === 'CanceledError' || /timeout/i.test(String(err.message))) return 'timeout';
  return String(err.code || err.message || 'fetch_failed').slice(0, 80);
}

// Log only when the outcome changes (failing -> a different failure, failing -> ok), not on every
// dashboard poll: the page polls every 15 s per open tab. Endpoint path and status/code only.
let lastLoggedState = null;
function logOutcome(state, detail) {
  if (state === lastLoggedState) return;
  const previous = lastLoggedState;
  lastLoggedState = state;
  if (state === 'ok') {
    if (previous) log.info(`unifi: reads recovered (was ${previous})`);
    return;
  }
  log.warn(`unifi: ${detail}`);
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function parseHealth(data) {
  const rows = (data && data.data) || [];
  const wan = rows.find((r) => r.subsystem === 'wan') || {};
  const www = rows.find((r) => r.subsystem === 'www') || {};
  const lat = num(www.latency);
  const capDown = num(www.xput_down);
  const capUp = num(www.xput_up);
  return {
    // `up` optimistic when the endpoint answers: a missing wan row with a
    // working API is not evidence of an outage.
    up: wan.up !== false,
    ip: wan.wan_ip || null,
    isp: wan.isp_name || null,
    latencyMs: lat != null && lat >= 0 ? lat : null,
    // Last measured capacity from the console's own speed test, not live.
    capacityDownMbps: capDown != null && capDown > 0 ? capDown : null,
    capacityUpMbps: capUp != null && capUp > 0 ? capUp : null,
  };
}

function rateOf(c, keys) {
  for (const k of keys) {
    const n = Number(c[k]);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return 0;
}

function parseClients(data) {
  const rows = (data && data.data) || [];
  let wired = 0;
  let wireless = 0;
  let downBps = 0;
  let upBps = 0;
  const talkers = [];
  for (const c of rows) {
    const isWired = c.is_wired === true;
    if (isWired) wired += 1;
    else wireless += 1;
    // "-r" fields are live rates in bytes/sec. Wired clients on some
    // firmware report under wired-* keys; accept both.
    const rx = rateOf(c, ['rx_bytes-r', 'wired-rx_bytes-r']);
    const tx = rateOf(c, ['tx_bytes-r', 'wired-tx_bytes-r']);
    downBps += rx;
    upBps += tx;
    talkers.push({
      name: c.name || c.hostname || c.mac || null,
      ip: c.ip || null,
      downMbps: (rx * 8) / 1e6,
      upMbps: (tx * 8) / 1e6,
      wired: isWired,
    });
  }
  talkers.sort((a, b) => b.downMbps + b.upMbps - (a.downMbps + a.upMbps));
  return {
    total: rows.length,
    wired,
    wireless,
    downMbps: (downBps * 8) / 1e6,
    upMbps: (upBps * 8) / 1e6,
    top: talkers.slice(0, 3),
  };
}

async function fetchUnifiNetwork(config, http = axios) {
  if (!config.UNIFI_HOST) return null;
  if (!config.UNIFI_API_KEY && !(config.UNIFI_USER && config.UNIFI_PASSWORD)) return null;
  const site = config.UNIFI_SITE || 'default';
  try {
    const [health, sta] = await Promise.all([
      apiGet(config, `/api/s/${site}/stat/health`, http),
      apiGet(config, `/api/s/${site}/stat/sta`, http),
    ]);
    const wan = parseHealth(health);
    const clients = parseClients(sta);
    logOutcome(hasNetworkData({ wan, clients }) ? 'ok' : 'empty',
      `stat/health and stat/sta answered but carried no WAN or client data (site ${site})`);
    const sample = { t: Date.now(), downMbps: clients.downMbps, upMbps: clients.upMbps };
    history.push(sample);
    while (history.length > HISTORY_MAX) history.shift();
    return {
      wan,
      clients,
      throughput: { downMbps: clients.downMbps, upMbps: clients.upMbps },
      history: history.slice(),
    };
  } catch (err) {
    const reason = failureReason(err);
    const status = err.response && err.response.status;
    logOutcome(`error:${reason}`, `GET ${err.unifiPath || `/api/s/${site}/stat/*`} failed: ${status ? `HTTP ${status}` : (err.code || err.name || 'error')} (${reason})`);
    return { error: reason };
  }
}

// Whether the bot has what it needs to ask the console at all (host plus a key or a login).
function unifiConfigured(config) {
  return !!(config.UNIFI_HOST && (config.UNIFI_API_KEY || (config.UNIFI_USER && config.UNIFI_PASSWORD)));
}

// True when a successful UniFi read carries at least one real value. A console that answers with
// empty health and client lists still parses (wan.up defaults to true), which would draw a green
// WAN card full of dashes and a 0-device donut — numbers that look live but aren't. The board
// hides the Network group for that case instead. Errors are not "empty": they render their own
// honest unreachable card.
function hasNetworkData(network) {
  if (!network || network.error) return false;
  const wan = network.wan || {};
  const clients = network.clients || {};
  return Boolean(wan.ip || wan.isp || wan.latencyMs != null || wan.capacityDownMbps != null || wan.capacityUpMbps != null
    || Number(clients.total) > 0);
}

module.exports = { fetchUnifiNetwork, parseHealth, parseClients, hasNetworkData, unifiConfigured, failureReason, UNIFI_TIMEOUT_MS };
