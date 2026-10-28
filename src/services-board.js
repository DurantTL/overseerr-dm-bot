'use strict';

// Services board: the registry of every service the dashboard's Services tab
// can show, plus the data gathering that backs it. Each entry maps to an
// existing health check where one exists; standalone web UIs without a health
// key get a lightweight HTTP liveness probe against their configured URL.

const axios = require('axios');
const { fetchUpsStatus, nutConfigured } = require('./nut');
const { fetchUnifiNetwork, hasNetworkData } = require('./unifi');
const { queuePercent } = require('./util');

// Groups in display order.
const GROUPS = Object.freeze([
  'System Health',
  'Network',
  'Media',
  'Automation',
  'Downloads & Files',
  'Monitoring',
  'Background Services',
  'Websites',
]);

// Registry: key, display name, group, default port, optional path, health key
// (into gatherHealth()), config URL key (into CONFIG), container name for
// restart, and icon id for the client.
const SERVICES = Object.freeze([
  // Media
  { key: 'plex', name: 'Plex', desc: 'Movies, television, and streaming', icon: 'play', group: 'Media', urlKey: 'PLEX_URL', healthKey: 'plex', container: 'plex', defaultPort: 32400, urlFormat: 'http://<server LAN IP>:32400', urlNote: 'Plex uses host networking, so use the server\'s LAN IP. A container name won\'t resolve from the bot.' },
  { key: 'tautulli', name: 'Tautulli', desc: 'Plex activity and viewing statistics', icon: 'chart', group: 'Media', urlKey: 'TAUTULLI_URL', healthKey: 'tautulli', defaultPort: 8181 },
  { key: 'seerr', name: 'Seerr', desc: 'Media requests and availability', icon: 'search', group: 'Media', urlKey: 'OVERSEERR_URL', healthKey: 'overseerr', defaultPort: 5055 },
  { key: 'director', name: 'Plex Director', desc: 'Request bot and automation director', icon: 'bolt', group: 'Media', self: true, healthKey: null },

  // Automation
  { key: 'sonarr', name: 'Sonarr', desc: 'Television library automation', icon: 'tv', group: 'Automation', urlKey: 'SONARR_URL', healthKey: 'sonarr', container: 'sonarr', defaultPort: 8989, queueLabel: 'sonarr' },
  { key: 'radarr', name: 'Radarr', desc: 'Movie library automation', icon: 'film', group: 'Automation', urlKey: 'RADARR_URL', healthKey: 'radarr', container: 'radarr', defaultPort: 7878, queueLabel: 'radarr' },
  { key: 'radarr4k', name: 'Radarr 4K', desc: '4K movie library automation', icon: 'film', group: 'Automation', urlKey: 'RADARR_4K_URL', healthKey: 'radarr4k', container: 'radarr-4k', defaultPort: 7879, queueLabel: 'radarr-4k' },
  { key: 'prowlarr', name: 'Prowlarr', desc: 'Indexer management and sync', icon: 'search', group: 'Automation', urlKey: 'PROWLARR_URL', healthKey: 'prowlarr', container: 'prowlarr', defaultPort: 9696 },

  // Downloads & Files
  { key: 'rtorrent', name: 'rTorrent', desc: 'Torrent client and downloads', icon: 'download', group: 'Downloads & Files', urlKey: 'RTORRENT_URL', healthKey: 'rtorrent', defaultPort: 8080 },
  { key: 'premiumize', name: 'Premiumize', desc: 'Cloud downloads and debrid', icon: 'cloud', group: 'Downloads & Files', external: 'https://www.premiumize.me', healthKey: 'premiumize' },
  { key: 'syncthing', name: 'Syncthing', desc: 'Server-to-server file sync', icon: 'sync', group: 'Downloads & Files', urlKey: 'SYNCTHING_URL', healthKey: 'syncthing', defaultPort: 8384 },
  { key: 'filebrowser', name: 'File Browser', desc: 'Browse and manage server files', icon: 'folder', group: 'Downloads & Files', urlKey: 'FILEBROWSER_URL', healthKey: 'filebrowser', defaultPort: 8081 },

  // Monitoring
  { key: 'grafana', name: 'Grafana', desc: 'Metrics dashboards and alerting', icon: 'chart', group: 'Monitoring', urlKey: 'GRAFANA_URL', healthKey: 'grafana', defaultPort: 3000 },
  { key: 'glances', name: 'Glances', desc: 'Host performance and processes', icon: 'cpu', group: 'Monitoring', urlKey: 'GLANCES_URL', healthKey: 'glances', defaultPort: 61208 },
  { key: 'scrutiny', name: 'Scrutiny', desc: 'SMART drive health tracking', icon: 'shield', group: 'Monitoring', urlKey: 'SCRUTINY_URL', healthKey: 'scrutiny', defaultPort: 8080 },
  { key: 'portainer', name: 'Portainer', desc: 'Containers and Docker admin', icon: 'box', group: 'Monitoring', urlKey: 'PORTAINER_URL', healthKey: 'portainer', defaultPort: 9000 },

  // Background Services (compact mini cards)
  { key: 'huntarr', name: 'Huntarr', desc: 'Missing and upgrade hunting', icon: 'search', group: 'Background Services', urlKey: 'HUNTARR_URL', healthKey: 'huntarr', compact: true, defaultPort: 9705 },
  { key: 'recyclarr', name: 'Recyclarr', desc: 'Quality profile sync', icon: 'sync', group: 'Background Services', urlKey: 'RECYCLARR_URL', healthKey: 'recyclarr', compact: true },
  { key: 'cleanuparr', name: 'Cleanuparr', desc: 'Stalled download cleanup', icon: 'trash', group: 'Background Services', urlKey: 'CLEANUPARR_URL', healthKey: 'cleanuparr', compact: true, defaultPort: 11011 },
  { key: 'byparr', name: 'Byparr', desc: 'Captcha solving for indexers', icon: 'shield', group: 'Background Services', urlKey: 'BYPARR_URL', healthKey: 'byparr', compact: true, defaultPort: 8191 },

  // Websites
  { key: 'portfolio', name: 'Portfolio', desc: 'Personal site', icon: 'cloud', group: 'Websites', externalKey: 'PORTFOLIO_URL' },
  { key: 'business-site', name: 'Business site', desc: 'Company site', icon: 'cloud', group: 'Websites', externalKey: 'BUSINESS_SITE_URL' },
]);

function portFromUrl(url, fallback) {
  if (!url) return fallback || null;
  try {
    const parsed = new URL(url);
    if (parsed.port) return Number(parsed.port);
    return parsed.protocol === 'https:' ? 443 : 80;
  } catch {
    return fallback || null;
  }
}

async function probeUrl(url, timeoutMs = 4000) {
  try {
    const res = await axios.get(url, { timeout: timeoutMs, validateStatus: () => true, maxRedirects: 2 });
    return res.status < 500 ? 'ok' : 'down';
  } catch {
    return 'down';
  }
}

// A direct link opened as-is (no LAN/Tailscale rewriting): fixed in the registry (`external`)
// or read from an env variable (`externalKey`) so site addresses live in the stack, not the
// public repo. Only http(s) values count; anything else is treated as unset.
function externalLink(svc, config) {
  const value = svc.external || (svc.externalKey ? config[svc.externalKey] : null);
  return typeof value === 'string' && /^https?:\/\//i.test(value.trim()) ? value.trim() : null;
}

// The value an operator should add for a service's missing variable, as a template: never a
// real address. Shown in the admin-only Config gaps card next to the variable name.
function urlFormat(svc) {
  if (svc.urlFormat) return svc.urlFormat;
  if (svc.externalKey) return 'https://<site address>';
  return svc.defaultPort ? `http://<host>:${svc.defaultPort}` : 'http://<host>:<port>';
}

// Sonarr/Radarr `timeleft` is "HH:MM:SS" or "D.HH:MM:SS"; null when unknown (stalled, queued).
function timeleftSeconds(value) {
  const text = String(value || '').trim();
  const dot = text.indexOf('.');
  const days = dot > -1 ? text.slice(0, dot) : '0';
  const parts = (dot > -1 ? text.slice(dot + 1) : text).split(':');
  if (parts.length !== 3 || ![days, ...parts].every(p => /^\d+$/.test(p))) return null;
  const [h, m, sec] = parts.map(Number);
  return Number(days) * 86400 + h * 3600 + m * 60 + sec;
}

const DOWNLOADS_PER_CARD = 3;

// The few downloads worth showing on a Sonarr/Radarr card: from the queue the board already
// fetches, matched by queue label (records can arrive without series or episode objects, so
// nothing here depends on them). Downloading first, then anything that needs a look, then
// importing, then the rest, each by progress.
function cardDownloads(queueItems) {
  const RANK = { downloading: 0, warning: 1, importing: 2 };
  const rank = d => (d.state in RANK ? RANK[d.state] : 3);
  return (queueItems || [])
    .filter(q => Number(q.size) > 0)
    .map(q => {
      const status = String(q.status || '').toLowerCase();
      const unhealthy = q.trackedStatus === 'warning' || status === 'warning' || status === 'failed';
      const state = unhealthy ? 'warning'
        : status === 'completed' ? 'importing'
          : status === 'downloading' ? 'downloading'
            : status === 'paused' ? 'paused'
              : 'queued';
      return {
        title: String(q.title || 'Unknown').slice(0, 120),
        pct: queuePercent(q),
        sizeLeft: Math.max(0, Number(q.sizeleft) || 0),
        eta: state === 'downloading' ? timeleftSeconds(q.timeleft) : null,
        state,
      };
    })
    .sort((a, b) => rank(a) - rank(b) || b.pct - a.pct)
    .slice(0, DOWNLOADS_PER_CARD);
}

// One service's up/down state, shared by the Services board and the service-down
// alert sweep (src/service-alerts.js) so both always agree on what "down" means.
// A health key from gatherHealth() wins; otherwise the configured URL is probed.
async function resolveServiceState(svc, { config, health, probe = probeUrl }) {
  const url = svc.urlKey ? config[svc.urlKey] : null;

  let state = 'skip';
  if (svc.healthKey && health) {
    const v = health[svc.healthKey];
    state = v === 'ok' || v === 'configured' ? 'ok' : v === 'down' || v === 'missing' ? 'down' : 'skip';
  } else if (url) {
    state = await probe(url);
  }
  // A configured URL that fails its health check but answers HTTP is still
  // reachable — prefer the probe for URL-less health misses.
  if (state === 'skip' && url) state = await probe(url);
  // External links and the dashboard itself are always "up" from here.
  if ((externalLink(svc, config) || svc.self) && state === 'skip') state = 'ok';
  return { url, state };
}

// Speedtest Tracker response shapes:
// - legacy /api/speedtest/latest: { data: { download, upload } } in Mbps, { ping } in ms
// - v1 /api/v1/results/latest: { data: { download_bits, upload_bits, ping } }
// Prefer the explicit *_bits fields when present; otherwise the legacy fields
// are already Mbps. Never invent values: unparseable or failed results surface
// as { error } so the UI can say why instead of showing silent dashes.
function speedtestMbps(d) {
  const bits = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n / 1e6 : null; };
  const mbps = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; };
  return {
    downloadMbps: d.download_bits != null ? bits(d.download_bits) : mbps(d.download),
    uploadMbps: d.upload_bits != null ? bits(d.upload_bits) : mbps(d.upload),
  };
}

async function fetchSpeedtest(config, http = axios) {
  if (!config.SPEEDTEST_URL) return null;
  try {
    const res = await http.get(config.SPEEDTEST_URL, { timeout: 6000 });
    const d = res.data?.data || res.data || {};
    if (d.failed === true || d.status === 'failed') {
      return { error: 'last_result_failed', ranAt: d.created_at || d.updated_at || null };
    }
    const { downloadMbps, uploadMbps } = speedtestMbps(d);
    if (downloadMbps == null && uploadMbps == null) {
      return { error: 'empty_result', ranAt: d.created_at || null };
    }
    const ping = Number(d.ping);
    return {
      downloadMbps,
      uploadMbps,
      pingMs: Number.isFinite(ping) && ping > 0 ? ping : null,
      ranAt: d.created_at || null,
    };
  } catch (err) {
    return { error: String((err && err.code) || (err && err.message) || 'fetch_failed').slice(0, 80) };
  }
}

async function fetchZfsHealth(config, http = axios) {
  if (!config.ZFS_HEALTH_URL) return null;
  try {
    const res = await http.get(config.ZFS_HEALTH_URL, { timeout: 6000 });
    const d = res.data || {};
    // Optional space fields the endpoint may serve (e.g. from `zfs list -Hpo used,avail <pool>`):
    // used_bytes, avail_bytes (or available_bytes), total_bytes. Rendered as a usage bar when
    // present; absent means no bar — never a fabricated percentage.
    const num = (v) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : null; };
    const usedBytes = num(d.used_bytes);
    const availBytes = num(d.avail_bytes != null ? d.avail_bytes : d.available_bytes);
    const totalBytes = num(d.total_bytes) ?? (usedBytes != null && availBytes != null ? usedBytes + availBytes : null);
    const space = (usedBytes != null && totalBytes) ? {
      usedBytes,
      availBytes,
      totalBytes,
      usedPct: Math.min(100, Math.round(usedBytes / totalBytes * 100)),
    } : null;
    return {
      pool: d.pool || null,
      health: d.health || 'UNKNOWN',
      lastScrub: d.last_scrub || null,
      errors: d.errors || null,
      issueCount: Number(d.issue_count) || 0,
      space,
    };
  } catch (err) {
    // Surface the failure instead of null: an unreachable exporter is a
    // deployment/networking problem, not a pool problem, and the UI should
    // say which. The card renders this as a neutral warning, not a red dot.
    return { error: String(err.code || err.message || 'fetch_failed').slice(0, 80) };
  }
}

// SSD temperature via Prometheus. Prefers the SMART textfile metric
// (node_drive_temp_celsius, written on the host by drive-temp-collector.sh),
// picking the drive whose model names an SSD; falls back to node_exporter
// hwmon (NVMe composite, then drivetemp/ata). Returns { tempC, sensor,
// instance } or { error } — never a fabricated reading.
async function fetchSsdTemp(config, http = axios) {
  if (!config.PROMETHEUS_URL) return null;
  try {
    const query = (q) => http.get(config.PROMETHEUS_URL + '/api/v1/query', {
      params: { query: q }, timeout: 8000,
    }).then((r) => r.data?.data?.result || []).catch(() => []);
    const [driveTemps, hwmon] = await Promise.all([
      query('node_drive_temp_celsius'),
      query('node_hwmon_temp_celsius'),
    ]);
    const val = (r) => { const v = Number(r.value?.[1]); return Number.isFinite(v) ? v : null; };
    const pick = (results, label) => {
      let best = null;
      for (const r of results) {
        const v = val(r);
        if (v == null) continue;
        if (!best || v > best.tempC) best = { tempC: v, sensor: label(r), instance: r.metric?.instance || '' };
      }
      return best;
    };
    // 1. SMART textfile: the SSD-labelled drive (never an HDD on this card).
    const ssdDrives = driveTemps.filter((r) => /ssd/i.test(String(r.metric?.model || '')));
    let best = pick(ssdDrives, (r) => String(r.metric?.model || r.metric?.device || 'ssd'));
    // 2. hwmon: NVMe composite, then drivetemp/ata.
    if (!best) {
      const chipOf = (r) => String(r.metric?.chip || '');
      let cands = hwmon.filter((r) => /nvme/i.test(chipOf(r)));
      if (!cands.length) cands = hwmon.filter((r) => /drivetemp|ata/i.test(chipOf(r)));
      best = pick(cands, (r) => String(r.metric?.sensor || chipOf(r)));
    }
    if (!best) return { error: 'no_ssd_sensor' };
    return { tempC: Math.round(best.tempC * 10) / 10, sensor: best.sensor, instance: best.instance };
  } catch (err) {
    return { error: String(err.code || err.message || 'fetch_failed').slice(0, 80) };
  }
}

// Main entry: gather everything the Services tab needs. `deps` supplies the
// already-wired functions from the bot (health, queues, tautulli). `http` is
// an optional axios-compatible client for the ZFS/speedtest fetches (tests).
async function gatherServicesBoard({ config, health, queues, sessions, canRestart, http }) {
  const queueCounts = { sonarr: 0, radarr: 0, 'radarr-4k': 0 };
  const queueByLabel = { sonarr: [], radarr: [], 'radarr-4k': [] };
  for (const q of queues || []) {
    const label = q.source?.label;
    if (label in queueCounts) {
      queueCounts[label]++;
      queueByLabel[label].push(q);
    }
  }

  const [ups, zfs, speedtest, networkRead, ssdTemp] = await Promise.all([
    nutConfigured(config) ? fetchUpsStatus(config).catch(() => null) : Promise.resolve(null),
    fetchZfsHealth(config, http).catch(() => null),
    fetchSpeedtest(config, http).catch(() => null),
    fetchUnifiNetwork(config, http).catch(() => null),
    fetchSsdTemp(config, http).catch(() => null),
  ]);
  // Network shows real UniFi numbers or an honest unreachable card, never an empty shell.
  const network = networkRead && (networkRead.error || hasNetworkData(networkRead)) ? networkRead : null;

  const services = [];
  // Services the board can't check because their URL variable isn't set. They used to vanish
  // silently; now they're listed with the variable that would bring them back. Recomputed on every
  // request, so a card moves into its group as soon as its variable appears.
  const hidden = [];
  for (const svc of SERVICES) {
    if (svc.special) continue; // handled as dedicated cards below
    const { url, state } = await resolveServiceState(svc, { config, health });

    // No dead cards: without a URL (or external/self link) and without a
    // down-state worth flagging, there is nothing actionable to show.
    const link = externalLink(svc, config);
    if (!url && !link && !svc.self && state !== 'down') {
      // Names only: never the value of a variable, which can embed credentials.
      const missing = svc.urlKey || svc.externalKey || null;
      hidden.push({
        key: svc.key, name: svc.name, group: svc.group, icon: svc.icon, missing,
        format: missing ? urlFormat(svc) : null,
        note: svc.urlNote || null,
      });
      continue;
    }

    const entry = {
      key: svc.key,
      name: svc.name,
      desc: svc.desc || '',
      group: svc.group,
      icon: svc.icon,
      state,
      port: portFromUrl(url, svc.port),
      path: svc.path || '',
      external: link,
      self: !!svc.self,
      compact: !!svc.compact,
      canRestart: !!(canRestart && svc.container),
      container: svc.container || null,
    };
    if (svc.queueLabel && queueCounts[svc.queueLabel]) {
      entry.queue = queueCounts[svc.queueLabel];
      const downloads = cardDownloads(queueByLabel[svc.queueLabel]);
      if (downloads.length) entry.downloads = downloads;
    }
    if (state === 'down' && health?.errors?.[svc.healthKey]) entry.detail = String(health.errors[svc.healthKey]).slice(0, 120);
    services.push(entry);
  }

  // Plex sessions for the now-playing strip.
  const nowPlaying = (sessions || []).map(s => ({
    title: s.title || s.grandparent_title || 'Unknown',
    subtitle: s.grandparent_title && s.title !== s.grandparent_title
      ? `${s.grandparent_title} · ${s.parent_title || ''}`.replace(/ · $/, '')
      : (s.original_title || ''),
    user: s.friendly_name || s.user || '',
    player: s.player || '',
    state: s.state || '',
    viewOffset: Number(s.view_offset) || 0,
    duration: Number(s.duration) || 0,
    // How it's playing, so the board shows what is loading the server (same rules as describeSession).
    decision: s.video_decision === 'transcode' ? 'transcode' : s.transcode_decision === 'copy' ? 'direct stream' : 'direct play',
    quality: s.stream_video_full_resolution || s.video_full_resolution || '',
    bandwidthKbps: Number(s.bandwidth) || 0,
  })).slice(0, 3);

  return {
    services,
    hidden,
    groups: GROUPS.filter(g => services.some(s => s.group === g) || (g === 'System Health' && (ups || zfs || speedtest || ssdTemp || (network && !network.error))) || (g === 'Network' && network)),
    ups,
    zfs,
    speedtest,
    network,
    ssdTemp,
    nowPlaying,
    // Smart-network hosts for the client: it picks LAN vs Tailscale via WebRTC.
    netHosts: {
      lan: config.DASHBOARD_LAN_HOST || '192.168.50.122',
      tail: config.DASHBOARD_TAIL_HOST || '100.91.15.98',
    },
    fetchedAt: new Date().toISOString(),
  };
}

module.exports = { GROUPS, SERVICES, gatherServicesBoard, cardDownloads, timeleftSeconds, resolveServiceState, externalLink, urlFormat, portFromUrl, fetchSpeedtest, fetchZfsHealth, fetchSsdTemp };
