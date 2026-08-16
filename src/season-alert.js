'use strict';

const ALERT_ATTEMPTS = new Set([1, 2, 4]);
const STAND_DOWN_AFTER = 4;

// Search cadence stays unchanged; this decides only whether another identical no-grab result is
// worth posting. A changed fingerprint is a new situation and always starts a fresh sequence.
function nextSeasonNoGrabAlert(previous, { fingerprint, now = Date.now() } = {}) {
  if (!fingerprint) throw new Error('Season alert fingerprint is required.');
  const changed = !previous || previous.fingerprint !== fingerprint;
  const attemptCount = changed ? 1 : Math.max(0, Number(previous.attemptCount) || 0) + 1;
  const stoodDown = attemptCount >= STAND_DOWN_AFTER;
  const shouldAlert = changed || ALERT_ATTEMPTS.has(attemptCount);
  const nextAlertAttempt = stoodDown ? null : attemptCount < 2 ? 2 : 4;
  return { fingerprint, attemptCount, changed, stoodDown, shouldAlert, nextAlertAttempt, lastAttemptedAt: now };
}

module.exports = { ALERT_ATTEMPTS, STAND_DOWN_AFTER, nextSeasonNoGrabAlert };
