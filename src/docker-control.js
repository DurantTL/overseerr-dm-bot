'use strict';

// Container restart for the Services tab's long-press actions. Two paths:
//  1. Docker socket (needs /var/run/docker.sock mounted in the bot container)
//  2. Portainer API (PORTAINER_URL + PORTAINER_API_KEY + PORTAINER_ENDPOINT_ID)
// The Services API only advertises restart when one of these is available.

const http = require('http');
const axios = require('axios');
const { redactCredentials } = require('./operator-error');

function socketAvailable(socketPath = '/var/run/docker.sock') {
  try {
    require('fs').accessSync(socketPath, require('fs').constants.R_OK | require('fs').constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function dockerSocketRequest(socketPath, method, reqPath, timeoutMs = 15000, { binary = false } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path: reqPath, method }, res => {
      const chunks = [];
      res.on('data', c => { chunks.push(c); });
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve({ status: res.statusCode, body: binary ? buf : buf.toString('utf8') });
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('Docker socket timed out')); });
    req.end();
  });
}

async function restartViaSocket(container, socketPath) {
  // POST /containers/{name}/restart — Docker accepts a name or ID.
  const { status, body } = await dockerSocketRequest(socketPath, 'POST', `/containers/${encodeURIComponent(container)}/restart?t=15`);
  if (status !== 204) throw new Error(`Docker restart failed: HTTP ${status} ${body.slice(0, 120)}`);
  return true;
}

async function restartViaPortainer({ url, apiKey, endpointId, container }) {
  const base = url.replace(/\/$/, '');
  const headers = { 'X-API-Key': apiKey };
  // Find the container id by name, then restart it. Docker's list endpoint is
  // /containers/json; Portainer proxies it unchanged and 404s on /containers.
  const list = await axios.get(`${base}/api/endpoints/${endpointId}/docker/containers/json`, {
    headers, params: { all: 1 }, timeout: 10000,
  });
  const match = (list.data || []).find(c =>
    (c.Names || []).some(n => n.replace(/^\//, '') === container) || c.Id?.startsWith(container));
  if (!match) throw new Error(`Container "${container}" not found in Portainer`);
  const res = await axios.post(
    `${base}/api/endpoints/${endpointId}/docker/containers/${match.Id}/restart`,
    null, { headers, params: { t: 15 }, timeout: 15000, validateStatus: () => true });
  if (res.status !== 204) throw new Error(`Portainer restart failed: HTTP ${res.status}`);
  return true;
}

// Docker keeps a restart count and the last start time per container, not a restart history, so
// these are the only lifecycle facts the board can show honestly. Inspect also returns the
// container's environment (Config.Env), which holds secrets: only the fields below ever leave
// this function, and nothing here is logged.
function containerFacts(inspect) {
  const state = (inspect && inspect.State) || {};
  const started = typeof state.StartedAt === 'string' && !state.StartedAt.startsWith('0001-') ? state.StartedAt : null;
  return {
    restartCount: Number.isInteger(inspect && inspect.RestartCount) ? inspect.RestartCount : null,
    startedAt: started,
    status: typeof state.Status === 'string' ? state.Status : null,
    image: typeof inspect?.Config?.Image === 'string' ? inspect.Config.Image : null,
  };
}

// { name: facts | null } for the given container names, through the same access restart uses
// (Docker socket or Portainer). A container that can't be read maps to null; nothing throws.
async function inspectContainers(config, names) {
  const cap = restartCapable(config);
  const out = {};
  const wanted = [...new Set((names || []).filter(n => /^[a-z0-9][a-z0-9_.-]*$/i.test(n)))];
  if (!cap || !wanted.length) return out;
  if (cap.via === 'socket') {
    await Promise.all(wanted.map(async name => {
      try {
        const { status, body } = await dockerSocketRequest(cap.socketPath, 'GET', `/containers/${encodeURIComponent(name)}/json`, 8000);
        out[name] = status === 200 ? containerFacts(JSON.parse(body)) : null;
      } catch { out[name] = null; }
    }));
    return out;
  }
  const base = cap.url.replace(/\/$/, '');
  const headers = { 'X-API-Key': cap.apiKey };
  let list = [];
  try {
    const res = await axios.get(`${base}/api/endpoints/${cap.endpointId}/docker/containers/json`, { headers, params: { all: 1 }, timeout: 10000 });
    list = Array.isArray(res.data) ? res.data : [];
  } catch { return out; }
  await Promise.all(wanted.map(async name => {
    const match = list.find(c => (c.Names || []).some(n => n.replace(/^\//, '') === name));
    if (!match) { out[name] = null; return; }
    try {
      const res = await axios.get(`${base}/api/endpoints/${cap.endpointId}/docker/containers/${match.Id}/json`, { headers, timeout: 10000 });
      out[name] = containerFacts(res.data);
    } catch { out[name] = null; }
  }));
  return out;
}

// ---- Read-only container logs for the action sheet's View logs ----
const LOG_TAIL = 200;
const LOG_LINE_CHARS = 2000;
const LOG_MAX_BYTES = 1024 * 1024;
const SECRET_KEY_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASS|WEBHOOK|COOKIE|CREDENTIAL)/i;

// Docker multiplexes stdout/stderr for non-TTY containers: each frame is an 8-byte header
// (stream byte, three zero bytes, big-endian length) then the payload. TTY containers send
// plain text. Anything that doesn't parse as frames is treated as plain text.
function demuxDockerLogs(buf) {
  if (!Buffer.isBuffer(buf)) return [{ stream: 'stdout', text: String(buf || '') }];
  const frames = [];
  let off = 0;
  while (off + 8 <= buf.length) {
    const kind = buf[off];
    if (kind > 2 || buf[off + 1] !== 0 || buf[off + 2] !== 0 || buf[off + 3] !== 0) break;
    const len = buf.readUInt32BE(off + 4);
    if (off + 8 + len > buf.length) break;
    frames.push({ stream: kind === 2 ? 'stderr' : 'stdout', text: buf.toString('utf8', off + 8, off + 8 + len) });
    off += 8 + len;
  }
  if (off === 0 && buf.length) return [{ stream: 'stdout', text: buf.toString('utf8') }];
  return frames;
}

// The literal values of every secret-looking setting, plus the password part of any configured
// URL that embeds credentials (RTORRENT_URL does), so a container that echoes its own config
// can't put them on screen. Short values are skipped so common words don't get blanked.
function secretLiterals(config) {
  const out = new Set();
  for (const [name, value] of Object.entries(config || {})) {
    if (typeof value !== 'string' || !value) continue;
    if (SECRET_KEY_NAME.test(name) && value.length >= 6) out.add(value);
    const userinfo = /^[a-z][a-z0-9+.-]*:\/\/([^/@\s]+)@/i.exec(value);
    if (userinfo) {
      const [user, pass] = userinfo[1].split(':');
      if (pass && pass.length >= 4) out.add(pass);
      if (pass && user && user.length >= 4) out.add(user);
      try { if (pass) out.add(decodeURIComponent(pass)); } catch { /* keep the raw form only */ }
    }
  }
  return [...out].sort((a, b) => b.length - a.length);
}

function redactLogLine(text, literals) {
  let line = redactCredentials(text);
  for (const lit of literals) if (line.includes(lit)) line = line.split(lit).join('[redacted]');
  return line;
}

// [{ at, stream, text }] for the last LOG_TAIL lines, timestamps from Docker, every line
// redacted before it leaves. Read-only: only GET /logs is ever called.
function parseLogLines(frames, literals) {
  const lines = [];
  for (const frame of frames) {
    for (const raw of frame.text.split('\n')) {
      if (!raw) continue;
      const sp = raw.indexOf(' ');
      const stamp = sp > 0 ? raw.slice(0, sp) : '';
      const hasStamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(stamp);
      const body = (hasStamp ? raw.slice(sp + 1) : raw).replace(/\r$/, '').slice(0, LOG_LINE_CHARS);
      lines.push({ at: hasStamp ? stamp.slice(0, 19) + 'Z' : null, stream: frame.stream, text: redactLogLine(body, literals) });
    }
  }
  return lines.slice(-LOG_TAIL);
}

async function containerLogs(config, container) {
  const cap = restartCapable(config);
  if (!cap) throw new Error('Container access is not configured (mount the Docker socket or set PORTAINER_*).');
  if (!/^[a-z0-9][a-z0-9_.-]*$/i.test(container)) throw new Error('Invalid container name.');
  const query = `stdout=1&stderr=1&timestamps=1&tail=${LOG_TAIL}`;
  let buf;
  if (cap.via === 'socket') {
    const { status, body } = await dockerSocketRequest(cap.socketPath, 'GET', `/containers/${encodeURIComponent(container)}/logs?${query}`, 15000, { binary: true });
    if (status !== 200) throw new Error(`Docker logs failed: HTTP ${status}`);
    buf = body.subarray(0, LOG_MAX_BYTES);
  } else {
    const base = cap.url.replace(/\/$/, '');
    const headers = { 'X-API-Key': cap.apiKey };
    const list = await axios.get(`${base}/api/endpoints/${cap.endpointId}/docker/containers/json`, { headers, params: { all: 1 }, timeout: 10000 });
    const match = (list.data || []).find(c => (c.Names || []).some(n => n.replace(/^\//, '') === container));
    if (!match) throw new Error(`Container "${container}" not found in Portainer`);
    const res = await axios.get(`${base}/api/endpoints/${cap.endpointId}/docker/containers/${match.Id}/logs?${query}`, {
      headers, timeout: 15000, responseType: 'arraybuffer', maxContentLength: LOG_MAX_BYTES, validateStatus: () => true,
    });
    if (res.status !== 200) throw new Error(`Portainer logs failed: HTTP ${res.status}`);
    buf = Buffer.from(res.data);
  }
  return parseLogLines(demuxDockerLogs(buf), secretLiterals(config));
}

function restartCapable(config) {
  const socketPath = config.DOCKER_SOCKET || '/var/run/docker.sock';
  if (config.DOCKER_SOCKET !== '' && socketAvailable(socketPath)) return { via: 'socket', socketPath };
  if (config.PORTAINER_URL && config.PORTAINER_API_KEY && config.PORTAINER_ENDPOINT_ID) {
    return { via: 'portainer', url: config.PORTAINER_URL, apiKey: config.PORTAINER_API_KEY, endpointId: config.PORTAINER_ENDPOINT_ID };
  }
  return null;
}

async function restartContainer(config, container) {
  const cap = restartCapable(config);
  if (!cap) throw new Error('Container restart is not configured (mount the Docker socket or set PORTAINER_*).');
  // Basic allowlist: only names the services board knows about.
  if (!/^[a-z0-9][a-z0-9_.-]*$/i.test(container)) throw new Error('Invalid container name.');
  if (cap.via === 'socket') return restartViaSocket(container, cap.socketPath);
  return restartViaPortainer({ ...cap, container });
}

module.exports = {
  restartCapable, restartContainer, socketAvailable, containerFacts, inspectContainers,
  containerLogs, demuxDockerLogs, parseLogLines, secretLiterals, LOG_TAIL,
};
