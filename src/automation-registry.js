'use strict';

const RUN_PREFIX = 'automation_run:';

function summarizeResult(result) {
  if (result == null) return { count: 0, summary: 'completed' };
  if (typeof result !== 'object') return { count: 0, summary: String(result).slice(0, 240) };
  const preferred = ['acted', 'searched', 'alerted', 'processed', 'reconciled', 'transferred', 'removed', 'created', 'updated', 'count'];
  const key = preferred.find(name => Number.isFinite(result[name]));
  const count = key ? Number(result[key]) : Object.values(result).filter(value => Number.isFinite(value)).reduce((sum, value) => sum + Number(value), 0);
  const parts = Object.entries(result)
    .filter(([, value]) => ['string', 'number', 'boolean'].includes(typeof value))
    .slice(0, 6)
    .map(([name, value]) => `${name}=${value}`);
  return { count, summary: (parts.join(', ') || 'completed').slice(0, 500) };
}

function createAutomationRegistry({ definitions, store, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, logger = console } = {}) {
  if (!Array.isArray(definitions) || !definitions.length) throw new Error('Automation definitions are required');
  const byId = new Map();
  for (const definition of definitions) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(definition.id || '')) throw new Error(`Invalid automation ID: ${definition.id}`);
    if (byId.has(definition.id)) throw new Error(`Duplicate automation ID: ${definition.id}`);
    if (typeof definition.run !== 'function') throw new Error(`Automation ${definition.id} has no runner`);
    byId.set(definition.id, Object.freeze({ ...definition }));
  }

  const states = new Map();
  const running = new Set();
  const timers = new Map();
  let started = false;

  function readState(id) {
    if (states.has(id)) return states.get(id);
    const raw = store?.get?.(RUN_PREFIX + id);
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed.status === 'running') {
          const recovered = { ...parsed, status: 'failed', finishedAt: now(), durationMs: Math.max(0, now() - Number(parsed.startedAt || now())), error: 'process restarted before this run finished' };
          states.set(id, recovered);
          store?.set?.(RUN_PREFIX + id, JSON.stringify(recovered));
        } else states.set(id, parsed);
      }
      catch (err) { states.set(id, { status: 'failed', error: `invalid stored run state: ${err.message}` }); }
    }
    return states.get(id) || null;
  }

  function writeState(id, patch) {
    const state = { ...(readState(id) || {}), ...patch };
    states.set(id, state);
    store?.set?.(RUN_PREFIX + id, JSON.stringify(state));
    return state;
  }

  function prerequisite(definition) {
    return typeof definition.prerequisite === 'function' ? definition.prerequisite() : { enabled: true };
  }

  function availability(definition) {
    const result = prerequisite(definition);
    const cadence = typeof definition.cadence === 'function' ? definition.cadence() : definition.cadence;
    const minutes = Number(cadence?.minutes || 0);
    if (!result?.enabled) return { enabled: false, reason: result?.reason || 'prerequisite unavailable', cadence: { ...cadence, minutes } };
    if (!(minutes > 0)) return { enabled: false, reason: cadence?.disabledReason || 'cadence is disabled', cadence: { ...cadence, minutes } };
    return { enabled: true, reason: null, cadence: { source: 'compose', mutable: false, ...cadence, minutes } };
  }

  function arm(id, delayMs, trigger = 'scheduled') {
    if (!started) return;
    const definition = byId.get(id);
    const delay = Math.max(1, Number(delayMs) || 60000);
    const nextRunAt = now() + delay;
    writeState(id, { nextRunAt });
    const timer = setTimer(async () => {
      timers.delete(id);
      const available = availability(definition);
      const startupAllowed = trigger === 'startup' && definition.startupIgnoresCadence && prerequisite(definition)?.enabled;
      if (available.enabled || startupAllowed) {
        try { await run(id, { trigger, requireManual: false }); }
        catch (err) { logger.warn?.(`${definition.label || id} failed: ${err.message}`); }
      }
      const current = availability(definition);
      arm(id, current.enabled ? current.cadence.minutes * 60000 : 60000);
    }, delay);
    timer?.unref?.();
    timers.set(id, timer);
  }

  async function run(id, { trigger = 'manual', requireManual = trigger === 'manual' } = {}) {
    const definition = byId.get(id);
    if (!definition) return { ok: false, unknown: true };
    const available = availability(definition);
    const startupAllowed = trigger === 'startup' && definition.startupIgnoresCadence && prerequisite(definition)?.enabled;
    if (!available.enabled && !startupAllowed) return { ok: false, disabled: true, reason: available.reason };
    if (requireManual && definition.manual?.enabled !== true) return { ok: false, unavailable: true, reason: definition.manual?.reason || 'manual execution is unavailable' };
    if (running.has(id)) {
      const previous = readState(id) || {};
      writeState(id, { ...previous, overlapSkips: Number(previous.overlapSkips || 0) + 1 });
      return { ok: false, busy: true };
    }
    running.add(id);
    const startedAt = now();
    writeState(id, { status: 'running', startedAt, finishedAt: null, durationMs: null, trigger, error: null });
    try {
      const runner = trigger === 'startup' && definition.startupRun
        ? definition.startupRun
        : trigger === 'manual' && definition.manualRun ? definition.manualRun : definition.run;
      const result = await runner();
      const finishedAt = now();
      const summary = summarizeResult(result);
      writeState(id, { status: 'ok', startedAt, finishedAt, durationMs: Math.max(0, finishedAt - startedAt), trigger, resultCount: summary.count, resultSummary: summary.summary, error: null });
      return { ok: true, result };
    } catch (err) {
      const finishedAt = now();
      writeState(id, { status: 'failed', startedAt, finishedAt, durationMs: Math.max(0, finishedAt - startedAt), trigger, resultCount: 0, resultSummary: null, error: String(err?.message || err).slice(0, 500) });
      throw err;
    } finally {
      running.delete(id);
    }
  }

  async function preview(id, values) {
    const definition = byId.get(id);
    if (!definition?.preview) return { ok: false, unavailable: true, reason: definition?.manual?.reason || 'preview is unavailable' };
    if (running.has(id)) return { ok: false, busy: true };
    return { ok: true, result: await definition.preview(values) };
  }

  function list() {
    return [...byId.values()].map(definition => {
      const state = readState(definition.id);
      const available = availability(definition);
      return {
        id: definition.id,
        label: definition.label || definition.id,
        enabled: available.enabled,
        disabledReason: available.reason,
        cadence: available.cadence,
        running: running.has(definition.id) || state?.status === 'running',
        manual: definition.manual || { enabled: false, reason: 'manual execution is unavailable' },
        previewable: typeof definition.preview === 'function',
        state,
      };
    });
  }

  function start() {
    if (started) return;
    started = true;
    for (const definition of byId.values()) {
      const available = availability(definition);
      const previous = readState(definition.id);
      const remaining = previous?.nextRunAt ? previous.nextRunAt - now() : null;
      const firstDelay = !definition.runOnStartup && Number.isFinite(remaining) && remaining > 0
        ? remaining
        : (definition.firstRunDelayMs ?? (available.enabled ? available.cadence.minutes * 60000 : 60000));
      arm(definition.id, firstDelay, definition.runOnStartup ? 'startup' : 'scheduled');
    }
  }

  function stop() {
    started = false;
    for (const timer of timers.values()) clearTimer(timer);
    timers.clear();
  }

  return { ids: () => [...byId.keys()], list, run, preview, start, stop, readState, availability: id => availability(byId.get(id)) };
}

module.exports = { RUN_PREFIX, createAutomationRegistry, summarizeResult };
