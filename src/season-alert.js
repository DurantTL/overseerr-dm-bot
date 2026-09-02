'use strict';

const { nextRepeatAlert, DEFAULT_ALERT_ATTEMPTS, DEFAULT_STAND_DOWN_AFTER } = require('./repeat-alert');

const ALERT_ATTEMPTS = DEFAULT_ALERT_ATTEMPTS;
const STAND_DOWN_AFTER = DEFAULT_STAND_DOWN_AFTER;

// Search cadence stays unchanged; this decides only whether another identical no-grab result is
// worth posting. A changed fingerprint is a new situation and always starts a fresh sequence.
function nextSeasonNoGrabAlert(previous, { fingerprint, now = Date.now() } = {}) {
  return nextRepeatAlert(previous, { fingerprint, now });
}

module.exports = { ALERT_ATTEMPTS, STAND_DOWN_AFTER, nextSeasonNoGrabAlert };
