#!/usr/bin/env node
// Precedence, validation, and drift protection for the dashboard-overridable settings.
const { test } = require('node:test');
const assert = require('node:assert');
const rs = require('../../src/runtime-settings');
const { readEpisodeRecoveryConfig } = require('../../src/episode-recovery');

function memStore(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    get: k => (map.has(k) ? map.get(k) : null),
    set: (k, v) => map.set(k, String(v)),
    del: k => map.delete(k),
    map,
  };
}

const CONFIG = { STUCK_AFTER_MINUTES: 45, ESCALATION_ENABLED: false, SEASON_PACK_MAX_PER_RUN: 5 };

test('runtime-settings: env is the default, an override wins, clearing restores env', () => {
  const store = memStore();
  assert.strictEqual(rs.resolveRuntime('STUCK_AFTER_MINUTES', { config: CONFIG, store }), 45, 'falls back to compose');

  rs.setOverride('STUCK_AFTER_MINUTES', '90', { store });
  assert.strictEqual(rs.resolveRuntime('STUCK_AFTER_MINUTES', { config: CONFIG, store }), 90, 'override wins');

  rs.clearOverride('STUCK_AFTER_MINUTES', { store });
  assert.strictEqual(rs.resolveRuntime('STUCK_AFTER_MINUTES', { config: CONFIG, store }), 45, 'cleared → compose again');
  assert.strictEqual(store.map.size, 0, 'no row left behind');
});

test('runtime-settings: booleans accept the usual truthy spellings', () => {
  const store = memStore();
  for (const on of ['1', 'true', 'TRUE', 'yes', 'on']) {
    rs.setOverride('ESCALATION_ENABLED', on, { store });
    assert.strictEqual(rs.resolveRuntime('ESCALATION_ENABLED', { config: CONFIG, store }), true, `${on} → true`);
  }
  for (const off of ['0', 'false', 'no', 'off', '']) {
    rs.setOverride('ESCALATION_ENABLED', off, { store });
    assert.strictEqual(rs.resolveRuntime('ESCALATION_ENABLED', { config: CONFIG, store }), false, `${off} → false`);
  }
});

test('runtime-settings: out-of-range and unparseable values are refused at write time', () => {
  const store = memStore();
  assert.strictEqual(rs.setOverride('SEASON_PACK_MAX_PER_RUN', '0', { store }).ok, false, 'below min refused');
  assert.strictEqual(rs.setOverride('SEASON_PACK_MAX_PER_RUN', '101', { store }).ok, false, 'above max refused');
  assert.strictEqual(rs.setOverride('SEASON_PACK_MAX_PER_RUN', 'banana', { store }).ok, false, 'non-numeric refused');
  assert.strictEqual(rs.setOverride('NOT_A_SETTING', '1', { store }).ok, false, 'unknown key refused');
  assert.strictEqual(store.map.size, 0, 'nothing persisted from a rejected write');
  assert.strictEqual(rs.setOverride('SEASON_PACK_MAX_PER_RUN', ' 7 ', { store }).ok, true, 'surrounding space tolerated');
  assert.strictEqual(rs.resolveRuntime('SEASON_PACK_MAX_PER_RUN', { config: CONFIG, store }), 7);
});

test('runtime-settings: a stored value that no longer validates falls back rather than applying', () => {
  // e.g. a row written by hand, or bounds tightened in a later release. Obeying it could park a
  // sweep at 0 forever; falling back to compose is the recoverable direction.
  const store = memStore({ [`${rs.OVERRIDE_PREFIX}SEASON_PACK_MAX_PER_RUN`]: '9999' });
  assert.strictEqual(rs.resolveRuntime('SEASON_PACK_MAX_PER_RUN', { config: CONFIG, store }), 5, 'ignored, compose used');
  const group = rs.describeRuntimeSettings({ config: CONFIG, store })
    .find(g => g.id === 'season_pack').settings.find(s => s.key === 'SEASON_PACK_MAX_PER_RUN');
  assert.strictEqual(group.overridden, false, 'and it is not reported as an active override');
});

test('runtime-settings: describe reports compose value, override state, and effective value', () => {
  const store = memStore();
  rs.setOverride('ESCALATION_ENABLED', '1', { store });
  const groups = rs.describeRuntimeSettings({ config: CONFIG, store });
  assert.deepStrictEqual(groups.map(g => g.id), ['stuck', 'escalation', 'season_pack', 'episode_recovery']);
  const esc = groups.find(g => g.id === 'escalation').settings.find(s => s.key === 'ESCALATION_ENABLED');
  assert.strictEqual(esc.envValue, false, 'compose says off');
  assert.strictEqual(esc.value, true, 'override says on');
  assert.strictEqual(esc.overridden, true);
  const stuck = groups.find(g => g.id === 'stuck').settings.find(s => s.key === 'STUCK_AFTER_MINUTES');
  assert.strictEqual(stuck.overridden, false, 'untouched settings are not flagged');
});

test('runtime-settings: env-sourced defaults match the module that owns them', () => {
  // The episode-recovery entries duplicate defaults that src/episode-recovery.js parses itself.
  // If one side changes, the dashboard would quietly display (and revert to) a stale default.
  const owned = readEpisodeRecoveryConfig({});
  const expected = {
    EPISODE_RECOVERY_ENABLED: owned.enabled,
    EPISODE_RECOVERY_CHECK_MINUTES: owned.checkMinutes,
    EPISODE_RECOVERY_PUBLIC_GRACE_HOURS: owned.publicGraceHours,
    EPISODE_RECOVERY_AVISTAZ_GRACE_HOURS: owned.avistazGraceHours,
    EPISODE_RECOVERY_LOOKBACK_DAYS: owned.lookbackDays,
    EPISODE_RECOVERY_MAX_PER_RUN: owned.maxPerRun,
    EPISODE_RECOVERY_MIN_CONFIDENCE: owned.minConfidence,
  };
  for (const [key, value] of Object.entries(expected)) {
    assert.strictEqual(rs.baseValue(rs.settingByKey(key), { env: {} }), value, `${key} default agrees`);
  }
});

test('runtime-settings: env-sourced values read the environment when no override exists', () => {
  const store = memStore();
  const env = { EPISODE_RECOVERY_MAX_PER_RUN: '9', EPISODE_RECOVERY_ENABLED: 'true' };
  assert.strictEqual(rs.resolveRuntime('EPISODE_RECOVERY_MAX_PER_RUN', { env, store }), 9);
  assert.strictEqual(rs.resolveRuntime('EPISODE_RECOVERY_ENABLED', { env, store }), true);
  rs.setOverride('EPISODE_RECOVERY_MAX_PER_RUN', '2', { store });
  assert.strictEqual(rs.resolveRuntime('EPISODE_RECOVERY_MAX_PER_RUN', { env, store }), 2, 'override still wins over env');
});

test('runtime-settings: every registered setting is resolvable and grouped', () => {
  const store = memStore();
  const groupIds = new Set(rs.GROUPS.map(g => g.id));
  for (const setting of rs.RUNTIME_SETTINGS) {
    assert.ok(groupIds.has(setting.group), `${setting.key} belongs to a known group`);
    assert.ok(['int', 'bool'].includes(setting.type), `${setting.key} has a supported type`);
    if (setting.type === 'int') assert.ok(setting.min != null && setting.max != null, `${setting.key} is bounded`);
    if (setting.source === 'env') assert.ok(setting.fallback !== undefined, `${setting.key} declares a fallback`);
    assert.doesNotThrow(() => rs.resolveRuntime(setting.key, { config: CONFIG, env: {}, store }));
  }
});
