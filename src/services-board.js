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
  // Media
  { key: 'plex', name: 'Plex', desc: 'Movies, television, and streaming', icon: 'play', group: 'Media', urlKey: 'PLEX_URL', healthKey: 'plex', container: 'plex', defaultPort: 32400 },
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
    const res = await axios.get(config.SPEEDTEST_URL, { timeout: 6000 });
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
    // External links and the dashboard itself are always "up" from here.
    if ((svc.external || svc.self) && state === 'skip') state = 'ok';

    // No dead cards: without a URL (or external/self link) and without a
    // down-state worth flagging, there is nothing actionable to show.
    if (!url && !svc.external && !svc.self && state !== 'down') continue;

    const entry = {
      key: svc.key,
      name: svc.name,
      desc: svc.desc || '',
      group: svc.group,
      icon: svc.icon,
      state,
      port: portFromUrl(url, svc.port),
      path: svc.path || '',
      external: svc.external || null,
      self: !!svc.self,
      compact: !!svc.compact,
      canRestart: !!(canRestart && svc.container),
      container: svc.container || null,
    };
    if (svc.queueLabel && queueCounts[svc.queueLabel]) {
      entry.queue = queueCounts[svc.queueLabel];
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
