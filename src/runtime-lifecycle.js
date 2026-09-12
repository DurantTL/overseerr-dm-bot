'use strict';

function createRuntimeLifecycle({
  client,
  token,
  startHttp,
  stopHttp,
  startDiscordWorkers,
  log,
  now = Date.now,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  retryInitialMs = 5000,
  retryMaxMs = 300000,
}) {
  const state = {
    http: 'idle',
    discord: 'idle',
    loginAttempts: 0,
    lastDiscordError: null,
    nextDiscordRetryAt: null,
    discordReadyAt: null,
    discordDisconnectedAt: null,
    workersStarted: false,
    stopping: false,
  };
  let httpResource = null;
  let startPromise = null;
  let loginInFlight = null;
  let retryTimer = null;
  let stopped = false;

  const snapshot = () => ({ ...state });
  const safeError = error => String(error?.message || error || 'unknown error').replace(/[\r\n]+/g, ' ').slice(0, 240);

  async function markReady() {
    if (stopped) return;
    if (retryTimer) clearTimeoutFn(retryTimer);
    retryTimer = null;
    state.discord = 'ready';
    state.lastDiscordError = null;
    state.nextDiscordRetryAt = null;
    state.discordReadyAt = new Date(now()).toISOString();
    state.discordDisconnectedAt = null;
    if (state.workersStarted) return;
    state.workersStarted = true;
    try {
      await startDiscordWorkers();
    } catch (error) {
      log.error(`Discord worker startup failed: ${safeError(error)}`);
    }
  }

  function markDisconnected(reason) {
    if (stopped) return;
    state.discord = 'disconnected';
    state.discordDisconnectedAt = new Date(now()).toISOString();
    if (reason) state.lastDiscordError = safeError(reason);
  }

  client.on('ready', markReady);
  client.on('shardResume', markReady);
  client.on('shardDisconnect', event => markDisconnected(event?.reason || 'Discord gateway disconnected'));
  client.on('invalidated', () => markDisconnected('Discord session invalidated'));
  client.on('shardReconnecting', () => {
    if (!stopped) state.discord = 'connecting';
  });
  client.on('error', error => {
    if (!stopped) state.lastDiscordError = safeError(error);
  });

  function scheduleRetry() {
    if (stopped || retryTimer) return;
    const exponent = Math.max(0, state.loginAttempts - 1);
    const delay = Math.min(retryMaxMs, retryInitialMs * (2 ** exponent));
    state.discord = 'retrying';
    state.nextDiscordRetryAt = new Date(now() + delay).toISOString();
    log.warn(`Discord login failed; retrying in ${Math.ceil(delay / 1000)}s`);
    retryTimer = setTimeoutFn(() => {
      retryTimer = null;
      state.nextDiscordRetryAt = null;
      void login();
    }, delay);
    retryTimer?.unref?.();
  }

  function login() {
    if (stopped || state.discord === 'ready' || loginInFlight) return loginInFlight;
    state.discord = 'connecting';
    state.loginAttempts += 1;
    loginInFlight = Promise.resolve()
      .then(() => client.login(token))
      .catch(error => {
        if (stopped) return;
        state.lastDiscordError = safeError(error);
        log.error(`Discord login attempt ${state.loginAttempts} failed: ${state.lastDiscordError}`);
        scheduleRetry();
      })
      .finally(() => { loginInFlight = null; });
    return loginInFlight;
  }

  function start() {
    if (startPromise) return startPromise;
    startPromise = (async () => {
      state.http = 'starting';
      httpResource = await startHttp();
      if (stopped) {
        await stopHttp(httpResource);
        httpResource = null;
        state.http = 'stopped';
        return snapshot();
      }
      state.http = 'ready';
      void login();
      return snapshot();
    })().catch(error => {
      state.http = 'failed';
      throw error;
    });
    return startPromise;
  }

  async function stop() {
    if (stopped) return;
    stopped = true;
    state.stopping = true;
    state.discord = 'stopping';
    if (retryTimer) clearTimeoutFn(retryTimer);
    retryTimer = null;
    state.nextDiscordRetryAt = null;
    if (startPromise) await startPromise.catch(() => {});
    if (httpResource) {
      await stopHttp(httpResource);
      httpResource = null;
    }
    state.http = 'stopped';
    try { await client.destroy(); } finally {
      state.discord = 'stopped';
      state.stopping = false;
    }
  }

  return { start, stop, snapshot };
}

function createDiscordReadyGuard({ snapshot }) {
  return function discordReadyGuard(_req, res, next) {
    const state = snapshot();
    if (state.discord === 'ready') return next();
    return res.status(503).json({
      ok: false,
      error: `Discord is ${state.discord || 'unavailable'}; no changes were made. Wait for reconnect and try again.`,
      retryable: true,
    });
  };
}

module.exports = { createRuntimeLifecycle, createDiscordReadyGuard };
