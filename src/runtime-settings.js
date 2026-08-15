// Runtime-overridable settings for the automation sweeps.
//
// Everything here has always been env-only: set in compose, read once at boot, changed only by a
// redeploy. That is the right default for credentials and topology, but it is a poor fit for the
// knobs an operator actually turns while watching the thing run — "stop escalating for now",
// "search season packs less aggressively". Those live here instead.
//
// Precedence is deliberately one-directional and boring: an override row in app_settings wins;
// with no row, the compose/env value is used unchanged. Clearing an override returns the setting
// to whatever compose says, so the stack file stays the source of truth for the steady state and
// the dashboard is a temporary hand on the tiller. Nothing here is written back to compose.
//
// Consumers must read through resolveRuntime() at the point of use rather than caching a value at
// boot, or an override silently does nothing until the next restart — which is exactly the class
// of "configured it, looks fine, changes nothing" bug this module exists to avoid.

const OVERRIDE_PREFIX = 'runtime_override:';

// `source: 'config'` reads the already-parsed CONFIG value (which may carry legacy-key handling);
// `source: 'env'` mirrors a module that parses process.env itself, and `fallback` must match that
// module's default — runtime-settings.test.js asserts the episode-recovery ones still agree.
const RUNTIME_SETTINGS = [
  // ---- Pending request approvals ----
  { key: 'PENDING_APPROVAL_CHECK_MINUTES', group: 'pending_approvals', type: 'int', min: 0, max: 1440, source: 'config',
    label: 'Check every', unit: 'min', help: '0 pauses nudges and expiry.' },
  { key: 'PENDING_APPROVAL_NUDGE_HOURS', group: 'pending_approvals', type: 'int', min: 1, max: 720, source: 'config',
    label: 'Nudge admins after', unit: 'h' },
  { key: 'PENDING_APPROVAL_REQUESTER_HOURS', group: 'pending_approvals', type: 'int', min: 1, max: 720, source: 'config',
    label: 'Update requester after', unit: 'h' },
  { key: 'PENDING_APPROVAL_EXPIRE_DAYS', group: 'pending_approvals', type: 'int', min: 1, max: 365, source: 'config',
    label: 'Expire unanswered requests after', unit: 'days' },

  // ---- Stuck-download watchdog ----
  { key: 'STUCK_CHECK_MINUTES', group: 'stuck', type: 'int', min: 0, max: 1440, source: 'config',
    label: 'Check every', unit: 'min', help: '0 stops the watchdog entirely.' },
  { key: 'STUCK_AFTER_MINUTES', group: 'stuck', type: 'int', min: 5, max: 10080, source: 'config',
    label: 'Consider stalled after', unit: 'min' },
  { key: 'STUCK_ALERT_COOLDOWN_HOURS', group: 'stuck', type: 'int', min: 0, max: 168, source: 'config',
    label: 'Re-alert no sooner than', unit: 'h' },

  // ---- AvistaZ escalation ----
  { key: 'ESCALATION_ENABLED', group: 'escalation', type: 'bool', source: 'config',
    label: 'Escalate stalled requests to AvistaZ' },
  { key: 'ESCALATION_CHECK_MINUTES', group: 'escalation', type: 'int', min: 0, max: 1440, source: 'config',
    label: 'Check every', unit: 'min', help: '0 pauses the sweep without clearing the toggle.' },
  { key: 'ESCALATION_DELAY_MINUTES', group: 'escalation', type: 'int', min: 1, max: 10080, source: 'config',
    label: 'Escalate after nothing found for', unit: 'min' },
  { key: 'ESCALATION_MAX_AGE_DAYS', group: 'escalation', type: 'int', min: 1, max: 365, source: 'config',
    label: 'Give up on requests older than', unit: 'days' },

  // ---- Season-pack-first searching ----
  { key: 'SEASON_PACK_FIRST', group: 'season_pack', type: 'bool', source: 'config',
    label: 'Search whole seasons for old shows' },
  { key: 'SEASON_PACK_REQUESTED', group: 'season_pack', type: 'bool', source: 'config',
    label: 'Also pack-search currently-airing requested shows' },
  { key: 'SEASON_PACK_CHECK_MINUTES', group: 'season_pack', type: 'int', min: 0, max: 1440, source: 'config',
    label: 'Check every', unit: 'min' },
  { key: 'SEASON_PACK_MIN_MISSING', group: 'season_pack', type: 'int', min: 1, max: 100, source: 'config',
    label: 'Missing episodes before packing a partial season', unit: 'eps' },
  { key: 'SEASON_PACK_MAX_PER_RUN', group: 'season_pack', type: 'int', min: 1, max: 100, source: 'config',
    label: 'Max season searches per run' },
  { key: 'SEASON_PACK_DORMANT_DAYS', group: 'season_pack', type: 'int', min: 1, max: 3650, source: 'config',
    label: 'Treat a continuing series as old after', unit: 'days' },

  // ---- Episode recovery worker (src/episode-recovery.js parses these from env itself) ----
  { key: 'EPISODE_RECOVERY_ENABLED', group: 'episode_recovery', type: 'bool', source: 'env', fallback: false,
    label: 'Recover individual missing episodes' },
  { key: 'EPISODE_RECOVERY_CHECK_MINUTES', group: 'episode_recovery', type: 'int', min: 5, max: 1440, source: 'env', fallback: 30,
    label: 'Check every', unit: 'min' },
  { key: 'EPISODE_RECOVERY_MAX_PER_RUN', group: 'episode_recovery', type: 'int', min: 1, max: 50, source: 'env', fallback: 3,
    label: 'Max episodes actioned per run' },
  { key: 'EPISODE_RECOVERY_PUBLIC_GRACE_HOURS', group: 'episode_recovery', type: 'int', min: 0, max: 168, source: 'env', fallback: 6,
    label: 'Try public indexers for', unit: 'h' },
  { key: 'EPISODE_RECOVERY_AVISTAZ_GRACE_HOURS', group: 'episode_recovery', type: 'int', min: 0, max: 168, source: 'env', fallback: 12,
    label: 'Then wait before AvistaZ', unit: 'h' },
  { key: 'EPISODE_RECOVERY_MIN_CONFIDENCE', group: 'episode_recovery', type: 'int', min: 0, max: 100, source: 'env', fallback: 88,
    label: 'Minimum release-match confidence', unit: '%' },
  { key: 'EPISODE_RECOVERY_LOOKBACK_DAYS', group: 'episode_recovery', type: 'int', min: 1, max: 365, source: 'env', fallback: 14,
    label: 'Only consider episodes aired within', unit: 'days' },
];

const GROUPS = [
  { id: 'pending_approvals', title: 'Pending approvals', blurb: 'Nudges admins, updates requesters, and expires unanswered request gates.' },
  { id: 'stuck', title: 'Stuck downloads', blurb: 'Watches the Sonarr/Radarr queues and alerts when an item stops making progress.' },
  { id: 'escalation', title: 'AvistaZ escalation', blurb: 'Requests that find nothing on public indexers get escalated to the private tracker.' },
  { id: 'season_pack', title: 'Season-pack search', blurb: 'Asks Sonarr for a whole season instead of episode-by-episode when a pack is likely to exist.' },
  { id: 'episode_recovery', title: 'Episode recovery', blurb: 'Chases individual aired episodes that never landed, even once the series looks available.' },
];

const BY_KEY = new Map(RUNTIME_SETTINGS.map(s => [s.key, s]));
const settingByKey = key => BY_KEY.get(key) || null;

function parseBoolish(v) {
  return ['1', 'true', 'yes', 'on'].includes(String(v).trim().toLowerCase());
}

// The value this setting would have with no override in play.
function baseValue(setting, { config = {}, env = process.env } = {}) {
  if (setting.source === 'config') return coerce(setting, config[setting.key]);
  const raw = env[setting.key];
  return raw === undefined || raw === '' ? setting.fallback : coerce(setting, raw);
}

function coerce(setting, raw) {
  if (setting.type === 'bool') return typeof raw === 'boolean' ? raw : parseBoolish(raw);
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : setting.fallback ?? 0;
}

// Effective value: override if one is stored and still valid, else the compose/env value.
// An override that no longer passes validation (bounds changed in a release, row edited by hand)
// is ignored rather than obeyed — falling back to compose is the safe direction.
function resolveRuntime(key, { config = {}, env = process.env, store } = {}) {
  const setting = settingByKey(key);
  if (!setting) throw new Error(`Unknown runtime setting: ${key}`);
  const base = baseValue(setting, { config, env });
  const raw = store?.get?.(OVERRIDE_PREFIX + key);
  if (raw == null) return base;
  const parsed = validate(setting, raw);
  return parsed.ok ? parsed.value : base;
}

function validate(setting, raw) {
  if (setting.type === 'bool') return { ok: true, value: parseBoolish(raw) };
  const n = Number.parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(n)) return { ok: false, error: `${setting.key} must be a whole number` };
  if (setting.min != null && n < setting.min) return { ok: false, error: `${setting.key} must be at least ${setting.min}` };
  if (setting.max != null && n > setting.max) return { ok: false, error: `${setting.key} must be at most ${setting.max}` };
  return { ok: true, value: n };
}

function setOverride(key, raw, { store }) {
  const setting = settingByKey(key);
  if (!setting) return { ok: false, error: `Unknown setting ${key}` };
  const parsed = validate(setting, raw);
  if (!parsed.ok) return parsed;
  store.set(OVERRIDE_PREFIX + key, setting.type === 'bool' ? (parsed.value ? '1' : '0') : String(parsed.value));
  return { ok: true, value: parsed.value };
}

function clearOverride(key, { store }) {
  if (!settingByKey(key)) return { ok: false, error: `Unknown setting ${key}` };
  store.del(OVERRIDE_PREFIX + key);
  return { ok: true };
}

// Rows for the dashboard: what compose says, what (if anything) overrides it, and what is in force.
function describeRuntimeSettings({ config = {}, env = process.env, store } = {}) {
  return GROUPS.map(group => ({
    ...group,
    settings: RUNTIME_SETTINGS.filter(s => s.group === group.id).map(setting => {
      const base = baseValue(setting, { config, env });
      const raw = store?.get?.(OVERRIDE_PREFIX + setting.key);
      const overridden = raw != null && validate(setting, raw).ok;
      return {
        ...setting,
        envValue: base,
        overridden,
        value: resolveRuntime(setting.key, { config, env, store }),
      };
    }),
  }));
}

module.exports = {
  OVERRIDE_PREFIX, RUNTIME_SETTINGS, GROUPS, settingByKey,
  baseValue, resolveRuntime, setOverride, clearOverride, describeRuntimeSettings, validate,
};
