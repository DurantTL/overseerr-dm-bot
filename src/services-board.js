'use strict';

// Services board: the registry of every service the dashboard's Services tab
// can show, plus the data gathering that backs it. Each entry maps to an
// existing health check where one exists; standalone web UIs without a health
// key get a lightweight HTTP liveness probe against their configured URL.

const axios = require('axios');
const { fetchUpsStatus, nutConfigured } = require('./nut');

// Groups in display order.
const GROUPS = Object.freeze([
  'System Health',
  'Media',
  'Automation',
  'Downloads & Files',
  'Monitoring',
  'Background Services',
]);

// Registry: key, display name, group, default port, optional path, health key
// (into gatherHealth()), config URL key (into CONFIG), container name for
// restart, and icon id for the client.
const SERVICES = Object.freeze([
  // System Health — special cards backed by dedicated adapters, not URLs.
  { key: 'ups', name: 'UPS Power', group: 'System Health', special: 'ups', icon: 'bolt' },
  { key: 'zfs', name: 'ZFS Pool', group: 'System Health', special: 'zfs', icon: 'disk' },
  { key: 'speedtest', name: 'Speedtest', group: 'System Health', special: 'speedtest', icon: 'gauge' },
  // Media
  { key: 'plex', name: 'Plex', group: 'Media', healthKey: 'plex', port: 32400, path: '/web', icon: 'play' },
  { key: 'tautulli', name: 'Tautulli', group: 'Media', urlKey: 'TAUTULLI_URL', icon: 'chart', container: 'tautulli' },
  { key: 'seerr', name: 'Seerr', group: 'Media', healthKey: 'overseerr', urlKey: 'OVERSEERR_URL', icon: 'search', container: 'seerr' },
  // Automation
  { key: 'sonarr', name: 'Sonarr', group: 'Automation', healthKey: 'sonarr', urlKey: 'SONARR_URL', icon: 'tv', container: 'sonarr', queue: 'sonarr' },
  { key: 'radarr', name: 'Radarr', group: 'Automation', healthKey: 'radarr', urlKey: 'RADARR_URL', icon: 'film', container: 'radarr', queue: 'radarr' },
  { key: 'radarr4k', name: 'Radarr 4K', group: 'Automation', healthKey: 'radarr4k', urlKey: 'RADARR_4K_URL', icon: 'film', container: 'radarr-4k', queue: 'radarr-4k' },
  { key: 'prowlarr', name: 'Prowlarr', group: 'Automation', healthKey: 'prowlarr', urlKey: 'PROWLARR_URL', icon: 'layers', container: 'prowlarr' },
  // Downloads & Files
  { key: 'rtorrent', name: 'rTorrent', group: 'Downloads & Files', healthKey: 'rtorrent', urlKey: 'RTORRENT_URL', icon: 'download', container: 'rtorrent' },
  { key: 'premiumize', name: 'Premiumize', group: 'Downloads & Files', healthKey: 'premiumize', icon: 'cloud' },
  { key: 'syncthing', name: 'Syncthing', group: 'Downloads & Files', healthKey: 'syncthing', urlKey: 'SYNCTHING_URL', icon: 'sync', container: 'syncthing' },
  { key: 'filebrowser', name: 'File Browser', group: 'Downloads & Files', urlKey: 'FILEBROWSER_URL', port: 8081, icon: 'folder', container: 'filebrowser' },
  // Monitoring
  { key: 'grafana', name: 'Grafana', group: 'Monitoring', urlKey: 'GRAFANA_URL', port: 3000, icon: 'chart', container: 'grafana' },
  { key: 'glances', name: 'Glances', group: 'Monitoring', urlKey: 'GLANCES_URL', port: 61208, icon: 'cpu', container: 'glances' },
  { key: 'scrutiny', name: 'Scrutiny', group: 'Monitoring', urlKey: 'SCRUTINY_URL', port: 8080, path: '/web', icon: 'disk', container: 'scrutiny' },
  { key: 'portainer', name: 'Portainer', group: 'Monitoring', urlKey: 'PORTAINER_URL', port: 9000, icon: 'box', container: 'portainer' },
  // Background Services
  { key: 'huntarr', name: 'Huntarr', group: 'Background Services', healthKey: 'huntarr', urlKey: 'HUNTARR_URL', icon: 'search', container: 'huntarr' },
  { key: 'recyclarr', name: 'Recyclarr', group: 'Background Services', healthKey: 'recyclarr', urlKey: 'RECYCLARR_URL', icon: 'sync', container: 'recyclarr' },
  { key: 'cleanuparr', name: 'Cleanuparr', group: 'Background Services', healthKey: 'cleanuparr', urlKey: 'CLEANUPARR_URL', icon: 'trash', container: 'cleanuparr' },
  { key: 'byparr', name: 'Byparr', group: 'Background Services', healthKey: 'byparr', urlKey: 'BYPARR_URL', icon: 'shield', container: 'byparr' },
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

async function fetchSpeedtest(config) {
  if (!config.SPEEDTEST_URL) return null;
  try {
    const res = await axios.get(`${config.SPEEDTEST_URL.replace(/\/$/, '')}/api/speedtest/latest`, { timeout: 6000 });
    const d = res.data?.data || res.data || {};
    return {
      downloadMbps: Number(d.download) || null,
      uploadMbps: Number(d.upload) || null,
      pingMs: Number(d.ping) || null,
      ranAt: d.created_at || null,
    };
  } catch {
    return null;
  }
}

async function fetchZfsHealth(config) {
  if (!config.ZFS_HEALTH_URL) return null;
  try {
    const res = await axios.get(config.ZFS_HEALTH_URL, { timeout: 6000 });
    const d = res.data || {};
    return {
      pool: d.pool || null,
      health: d.health || 'UNKNOWN',
      lastScrub: d.last_scrub || null,
      errors: d.errors || null,
      issueCount: Number(d.issue_count) || 0,
    };
  } catch {
    return null;
  }
}

// Main entry: gather everything the Services tab needs. `deps` supplies the
// already-wired functions from the bot (health, queues, tautulli).
async function gatherServicesBoard({ config, health, queues, sessions, canRestart }) {
  const queueCounts = { sonarr: 0, radarr: 0, 'radarr-4k': 0 };
  for (const q of queues || []) {
    const label = q.source?.label;
    if (label in queueCounts) queueCounts[label]++;
  }

  const [ups, zfs, speedtest] = await Promise.all([
    nutConfigured(config) ? fetchUpsStatus(config).catch(() => null) : Promise.resolve(null),
    fetchZfsHealth(config).catch(() => null),
    fetchSpeedtest(config).catch(() => null),
  ]);

  const services = [];
  for (const svc of SERVICES) {
    if (svc.special) continue; // handled as dedicated cards below
    const url = svc.urlKey ? config[svc.urlKey] : null;
    // Without a configured URL and without a health key, there is nothing to
    // show — skip the card entirely (no dead cards).
    if (!url && !svc.healthKey) continue;

    let state = 'skip';
    if (svc.healthKey && health) {
      const v = health[svc.healthKey];
      state = v === 'ok' || v === 'configured' ? 'ok' : v === 'down' || v === 'missing' ? 'down' : 'skip';
    } else if (url) {
      state = await probeUrl(url);
    }
    // A configured URL that fails its health check but answers HTTP is still
    // reachable — prefer the probe for URL-less health misses.
    if (state === 'skip' && url) state = await probeUrl(url);

    const entry = {
      key: svc.key,
      name: svc.name,
      group: svc.group,
      icon: svc.icon,
      state,
      port: portFromUrl(url, svc.port),
      path: svc.path || '',
      canRestart: !!(canRestart && svc.container),
      container: svc.container || null,
    };
    if (svc.queue && queueCounts[svc.queue]) {
      entry.queue = queueCounts[svc.queue];
      entry.detail = `${queueCounts[svc.queue]} downloading`;
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
  })).slice(0, 3);

  return {
    services,
    groups: GROUPS.filter(g => services.some(s => s.group === g) || (g === 'System Health' && (ups || zfs || speedtest))),
    ups,
    zfs,
    speedtest,
    nowPlaying,
    // Smart-network hosts for the client: it picks LAN vs Tailscale via WebRTC.
    netHosts: {
      lan: config.DASHBOARD_LAN_HOST || '192.168.50.122',
      tail: config.DASHBOARD_TAIL_HOST || '100.91.15.98',
    },
    fetchedAt: new Date().toISOString(),
  };
}

module.exports = { GROUPS, SERVICES, gatherServicesBoard, portFromUrl };
