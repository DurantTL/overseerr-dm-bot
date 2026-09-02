'use strict';

const DEFAULT_ALERT_ATTEMPTS = new Set([1, 2, 4]);
const DEFAULT_STAND_DOWN_AFTER = 4;

// Generic escalating-backoff / stand-down decision for "should I alert again about this same
// recurring condition". A changed fingerprint is a new situation and always restarts the sequence
// fresh (immediate alert). An unchanged fingerprint only alerts again on attempts 1, 2, 4, ... and
// then goes quiet after standDownAfter, while the caller keeps counting attempts so a status
// surface can still show "stood down after N identical results". Shared by season no-grab alerts
// (src/season-alert.js) and tier agent error reports (src/routes/tier-agent.js) — anything that
// repeats the exact same failure on a fixed cadence and would otherwise spam a channel forever.
function nextRepeatAlert(previous, { fingerprint, now = Date.now(), alertAttempts = DEFAULT_ALERT_ATTEMPTS, standDownAfter = DEFAULT_STAND_DOWN_AFTER } = {}) {
  if (!fingerprint) throw new Error('Repeat alert fingerprint is required.');
  const changed = !previous || previous.fingerprint !== fingerprint;
  const attemptCount = changed ? 1 : Math.max(0, Number(previous.attemptCount) || 0) + 1;
  const stoodDown = attemptCount >= standDownAfter;
  const shouldAlert = changed || alertAttempts.has(attemptCount);
  const nextAlertAttempt = stoodDown ? null : attemptCount < 2 ? 2 : 4;
  return { fingerprint, attemptCount, changed, stoodDown, shouldAlert, nextAlertAttempt, lastAttemptedAt: now };
}

module.exports = { DEFAULT_ALERT_ATTEMPTS, DEFAULT_STAND_DOWN_AFTER, nextRepeatAlert };
