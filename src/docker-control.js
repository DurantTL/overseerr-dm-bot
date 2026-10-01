'use strict';

// Container restart for the Services tab's long-press actions. Two paths:
//  1. Docker socket (needs /var/run/docker.sock mounted in the bot container)
//  2. Portainer API (PORTAINER_URL + PORTAINER_API_KEY + PORTAINER_ENDPOINT_ID)
// The Services API only advertises restart when one of these is available.

const http = require('http');
const axios = require('axios');

function socketAvailable(socketPath = '/var/run/docker.sock') {
  try {
    require('fs').accessSync(socketPath, require('fs').constants.R_OK | require('fs').constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function dockerSocketRequest(socketPath, method, reqPath, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path: reqPath, method }, res => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
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
  // Find the container id by name, then restart it.
  const list = await axios.get(`${base}/api/endpoints/${endpointId}/docker/containers`, {
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

module.exports = { restartCapable, restartContainer, socketAvailable };
