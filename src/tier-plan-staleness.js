'use strict';

const { nextRepeatAlert } = require('./repeat-alert');

const DEFAULT_CHECK_INTERVAL_MS = 60 * 60000;
const DEFAULT_INITIAL_DELAY_MS = 2 * 60000;

function planAgeMs(plan, now) {
  const publishedAt = Number(plan?.published?.publishedAt);
  return Number.isFinite(publishedAt) && publishedAt > 0 ? Math.max(0, now - publishedAt) : null;
}

function evaluateTierPlanStaleness({
  nodes,
  getPlan,
  getAlertState,
  setAlertState,
  clearAlertState,
  staleDays,
  now = Date.now(),
}) {
  const thresholdMs = Math.max(1, Number(staleDays) || 14) * 86400000;
  const events = [];
  for (const node of nodes.filter(item => item.enabled)) {
    const plan = getPlan(node.name);
    const ageMs = planAgeMs(plan, now);
    const previous = getAlertState(node.name);
    if (ageMs == null || ageMs <= thresholdMs) {
      if (previous) {
        const republished = Number(plan?.published?.publishedAt) > Number(previous.publishedAt)
          || plan?.published?.planHash !== previous.planHash;
        clearAlertState(node.name);
        if (republished) events.push({ type: 'recovered', node: node.name, plan, previous });
      }
      continue;
    }

    const planHash = String(plan.published.planHash || 'unknown');
    const publishedAt = Number(plan.published.publishedAt);
    const fingerprint = `${node.name}:${planHash}:${publishedAt}`;
    const repeat = nextRepeatAlert(previous, { fingerprint, now });
    const state = { ...repeat, planHash, publishedAt, ageMs, staleDays: Number(staleDays) || 14 };
    setAlertState(node.name, state);
    if (repeat.shouldAlert) events.push({ type: 'stale', node: node.name, plan, state });
  }
  return events;
}

function scheduleTierPlanStaleness({
  run,
  setTimeoutFn = setTimeout,
  setIntervalFn = setInterval,
  initialDelayMs = DEFAULT_INITIAL_DELAY_MS,
  intervalMs = DEFAULT_CHECK_INTERVAL_MS,
}) {
  const invoke = () => Promise.resolve().then(run);
  const first = setTimeoutFn(invoke, initialDelayMs);
  const interval = setIntervalFn(invoke, intervalMs);
  first?.unref?.();
  interval?.unref?.();
  return { first, interval };
}

module.exports = {
  DEFAULT_CHECK_INTERVAL_MS,
  DEFAULT_INITIAL_DELAY_MS,
  planAgeMs,
  evaluateTierPlanStaleness,
  scheduleTierPlanStaleness,
};
