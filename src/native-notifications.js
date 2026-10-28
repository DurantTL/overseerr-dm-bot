'use strict';

// Service queue item 12: the apps' own Discord notifications, set from one place. Nothing new runs
// inside the bot; this only reads and writes each app's native notification settings.
//
//   Sonarr / Radarr / Radarr 4K / Prowlarr: one Discord connection named CONNECTION_NAME that sends
//     health issues (warnings included), health restored, and imports needing manual interaction.
//     Every other event is off. Other connections are never touched.
//   Seerr: its single Discord agent keeps its webhook and on/off state; only the notification
//     types change, to failed + issues (the bot already posts pending approvals, and the bot's own
//     DMs cover availability).
//   Tautulli: one Discord notifier named CONNECTION_NAME for Plex internal down/up and Plex update
//     available. Other notifiers are never touched.
//   Scrutiny has no settings API; its SMART alerts are a scrutiny.yaml entry (docs/native-notifications.md).
//
// planAll() only reads. applyPlan() writes only the steps planAll() marked create/update. The
// Discord webhook URL is a credential: it is sent to the apps and never printed, logged, or put in
// a plan description.

const CONNECTION_NAME = 'Plex Director: failures & health';

// *arr events to turn on, when the app's schema has them. Everything else starting with "on" is off.
const ARR_EVENTS_ON = ['onHealthIssue', 'onHealthRestored', 'onManualInteractionRequired'];
const ARR_LABELS = { onHealthIssue: 'health issues', onHealthRestored: 'health restored', onManualInteractionRequired: 'imports needing manual interaction' };

// Seerr notification type bits (Overseerr/Jellyseerr/Seerr share them).
const SEERR_TYPES = {
  MEDIA_PENDING: 2, MEDIA_APPROVED: 4, MEDIA_AVAILABLE: 8, MEDIA_FAILED: 16, TEST_NOTIFICATION: 32,
  MEDIA_DECLINED: 64, MEDIA_AUTO_APPROVED: 128, ISSUE_CREATED: 256, ISSUE_COMMENT: 512,
  ISSUE_RESOLVED: 1024, ISSUE_REOPENED: 2048, MEDIA_AUTO_REQUESTED: 4096,
};
const SEERR_WANTED = SEERR_TYPES.MEDIA_FAILED | SEERR_TYPES.ISSUE_CREATED | SEERR_TYPES.ISSUE_COMMENT
  | SEERR_TYPES.ISSUE_RESOLVED | SEERR_TYPES.ISSUE_REOPENED;

const TAUTULLI_TRIGGERS_ON = ['on_intdown', 'on_intup', 'on_pmsupdate'];
const TAUTULLI_LABELS = { on_intdown: 'Plex down (internal)', on_intup: 'Plex back up (internal)', on_pmsupdate: 'Plex update available' };

function seerrTypeNames(mask) {
  return Object.entries(SEERR_TYPES).filter(([, bit]) => (mask & bit) === bit).map(([name]) => name.toLowerCase().replace(/_/g, ' '));
}

function arrTargets(config) {
  const t = [];
  if (config.SONARR_URL) t.push({ app: 'Sonarr', url: config.SONARR_URL, key: config.SONARR_API_KEY, api: 'v3' });
  if (config.RADARR_URL) t.push({ app: 'Radarr', url: config.RADARR_URL, key: config.RADARR_API_KEY, api: 'v3' });
  if (config.RADARR_4K_URL) t.push({ app: 'Radarr 4K', url: config.RADARR_4K_URL, key: config.RADARR_4K_API_KEY, api: 'v3' });
  if (config.PROWLARR_URL) t.push({ app: 'Prowlarr', url: config.PROWLARR_URL, key: config.PROWLARR_API_KEY, api: 'v1' });
  return t;
}

const base = url => String(url || '').replace(/\/+$/, '');

// The desired *arr connection, built from the app's own Discord schema so field and event names
// always match the running version.
function desiredArrNotification(schema, webhookUrl, existing = null) {
  const out = JSON.parse(JSON.stringify(existing || schema));
  if (!existing) delete out.id;
  out.name = CONNECTION_NAME;
  out.implementation = schema.implementation;
  out.configContract = schema.configContract;
  for (const key of Object.keys(schema)) {
    if (/^on[A-Z]/.test(key) && typeof schema[key] === 'boolean') out[key] = ARR_EVENTS_ON.includes(key);
  }
  if ('includeHealthWarnings' in schema) out.includeHealthWarnings = true;
  const fields = Array.isArray(out.fields) ? out.fields : JSON.parse(JSON.stringify(schema.fields || []));
  const hook = fields.find(f => f.name === 'webHookUrl');
  if (hook) hook.value = webhookUrl;
  else fields.push({ name: 'webHookUrl', value: webhookUrl });
  out.fields = fields;
  return out;
}

// What differs between two *arr notifications, as words (never values for the webhook).
function arrDifferences(current, desired) {
  const diffs = [];
  for (const key of Object.keys(desired)) {
    if (/^on[A-Z]/.test(key) && typeof desired[key] === 'boolean' && current[key] !== desired[key]) diffs.push(`${key} ${desired[key] ? 'on' : 'off'}`);
  }
  if ('includeHealthWarnings' in desired && current.includeHealthWarnings !== desired.includeHealthWarnings) diffs.push('health warnings on');
  const hookOf = n => (n.fields || []).find(f => f.name === 'webHookUrl')?.value || '';
  // Some versions return secret fields masked ("********"); a masked value can't be compared, so
  // it isn't counted as a change: on those versions a webhook-only change has to be made in the
  // app's UI. Any other change still sends the configured webhook along with it.
  const currentHook = hookOf(current);
  if (!/^\*+$/.test(currentHook) && currentHook !== hookOf(desired)) diffs.push('webhook changed');
  return diffs;
}

async function planArr(target, { http, webhookUrl }) {
  const headers = { 'X-Api-Key': target.key };
  const root = `${base(target.url)}/api/${target.api}/notification`;
  const [listRes, schemaRes] = await Promise.all([
    http.get(root, { headers, timeout: 15000 }),
    http.get(`${root}/schema`, { headers, timeout: 15000 }),
  ]);
  const schema = (schemaRes.data || []).find(s => s.implementation === 'Discord');
  if (!schema) return { app: target.app, action: 'skip', detail: 'this version has no Discord connection type' };
  const existing = (listRes.data || []).find(n => n.name === CONNECTION_NAME) || null;
  const desired = desiredArrNotification(schema, webhookUrl, existing);
  const events = ARR_EVENTS_ON.filter(k => k in schema).map(k => ARR_LABELS[k]).join(', ');
  if (!existing) {
    return { app: target.app, action: 'create', detail: `add Discord connection "${CONNECTION_NAME}": ${events}${'includeHealthWarnings' in schema ? ' (warnings included)' : ''}; every other event off`, request: { method: 'post', url: root, body: desired, headers } };
  }
  const diffs = arrDifferences(existing, desired);
  if (!diffs.length) return { app: target.app, action: 'none', detail: `"${CONNECTION_NAME}" already sends ${events} only` };
  return { app: target.app, action: 'update', detail: `update "${CONNECTION_NAME}": ${diffs.join(', ')}`, request: { method: 'put', url: `${root}/${existing.id}`, body: desired, headers } };
}

// ---- Autopulse (service queue item 15) ----
// With AUTOPULSE_URL set, Sonarr / Radarr / Radarr 4K each get one Webhook connection that calls
// Autopulse's matching trigger (/triggers/sonarr or /triggers/radarr) on import, upgrade and
// rename, so Plex refreshes just that item instead of scanning the library. Delete events stay
// off: this only ever refreshes. The Autopulse password is a credential and is never printed.
const AUTOPULSE_CONNECTION = 'Autopulse: refresh imported item';
const AUTOPULSE_EVENTS_ON = ['onDownload', 'onUpgrade', 'onRename'];
const AUTOPULSE_LABELS = { onDownload: 'import', onUpgrade: 'upgrade', onRename: 'rename' };

function setField(fields, name, value) {
  const f = fields.find(x => x.name === name);
  if (f) f.value = value;
  else fields.push({ name, value });
}

function desiredAutopulseWebhook(schema, { url, username, password }, existing = null) {
  const out = JSON.parse(JSON.stringify(existing || schema));
  if (!existing) delete out.id;
  out.name = AUTOPULSE_CONNECTION;
  out.implementation = schema.implementation;
  out.configContract = schema.configContract;
  for (const key of Object.keys(schema)) {
    if (/^on[A-Z]/.test(key) && typeof schema[key] === 'boolean') out[key] = AUTOPULSE_EVENTS_ON.includes(key);
  }
  const fields = Array.isArray(out.fields) ? out.fields : JSON.parse(JSON.stringify(schema.fields || []));
  setField(fields, 'url', url);
  setField(fields, 'method', 1); // POST
  setField(fields, 'username', username);
  setField(fields, 'password', password);
  out.fields = fields;
  return out;
}

function autopulseDifferences(current, desired) {
  const diffs = [];
  for (const key of Object.keys(desired)) {
    if (/^on[A-Z]/.test(key) && typeof desired[key] === 'boolean' && current[key] !== desired[key]) diffs.push(`${key} ${desired[key] ? 'on' : 'off'}`);
  }
  const val = (n, name) => (n.fields || []).find(f => f.name === name)?.value;
  for (const name of ['url', 'method', 'username']) {
    if (String(val(current, name) ?? '') !== String(val(desired, name) ?? '')) diffs.push(`${name} changed`);
  }
  // A masked stored password ("********") can't be compared; see arrDifferences.
  const pw = String(val(current, 'password') ?? '');
  if (!/^\*+$/.test(pw) && pw !== String(val(desired, 'password') ?? '')) diffs.push('password changed');
  return diffs;
}

async function planAutopulse(target, { http, autopulse }) {
  const app = `${target.app} → Autopulse`;
  const headers = { 'X-Api-Key': target.key };
  const root = `${base(target.url)}/api/${target.api}/notification`;
  const [listRes, schemaRes] = await Promise.all([
    http.get(root, { headers, timeout: 15000 }),
    http.get(`${root}/schema`, { headers, timeout: 15000 }),
  ]);
  const schema = (schemaRes.data || []).find(s => s.implementation === 'Webhook');
  if (!schema) return { app, action: 'skip', detail: 'this version has no Webhook connection type' };
  const trigger = target.app === 'Sonarr' ? 'sonarr' : 'radarr';
  const url = `${base(autopulse.url)}/triggers/${trigger}`;
  const existing = (listRes.data || []).find(n => n.name === AUTOPULSE_CONNECTION) || null;
  const desired = desiredAutopulseWebhook(schema, { url, username: autopulse.username, password: autopulse.password }, existing);
  const events = AUTOPULSE_EVENTS_ON.filter(k => k in schema).map(k => AUTOPULSE_LABELS[k]).join(', ');
  if (!existing) {
    return { app, action: 'create', detail: `add Webhook "${AUTOPULSE_CONNECTION}" to ${url} on ${events}; every other event off`, request: { method: 'post', url: root, body: desired, headers } };
  }
  const diffs = autopulseDifferences(existing, desired);
  if (!diffs.length) return { app, action: 'none', detail: `"${AUTOPULSE_CONNECTION}" already calls ${url} on ${events} only` };
  return { app, action: 'update', detail: `update "${AUTOPULSE_CONNECTION}": ${diffs.join(', ')}`, request: { method: 'put', url: `${root}/${existing.id}`, body: desired, headers } };
}

async function planSeerr(config, { http }) {
  const headers = { 'X-Api-Key': config.OVERSEERR_API_KEY };
  const url = `${base(config.OVERSEERR_URL)}/api/v1/settings/notifications/discord`;
  const res = await http.get(url, { headers, timeout: 15000 });
  const current = res.data && typeof res.data === 'object' ? res.data : {};
  if (!current.enabled || !current.options?.webhookUrl) {
    return { app: 'Seerr', action: 'skip', detail: 'Discord agent is off or has no webhook; turn it on in Seerr first (it is also what pings members)' };
  }
  const types = Number(current.types) || 0;
  if (types === SEERR_WANTED) return { app: 'Seerr', action: 'none', detail: 'Discord agent already sends failed + issues only' };
  const dropping = seerrTypeNames(types & ~SEERR_WANTED);
  const adding = seerrTypeNames(SEERR_WANTED & ~types);
  return {
    app: 'Seerr',
    action: 'update',
    detail: `Discord agent types → failed + issues${dropping.length ? `; stops: ${dropping.join(', ')}` : ''}${adding.length ? `; adds: ${adding.join(', ')}` : ''} (webhook and on/off unchanged)`,
    request: { method: 'post', url, body: { ...current, types: SEERR_WANTED }, headers },
  };
}

async function tautulli(http, config, cmd, params = {}) {
  const res = await http.get(`${base(config.TAUTULLI_URL)}/api/v2`, { params: { apikey: config.TAUTULLI_API_KEY, cmd, ...params }, timeout: 15000 });
  if (res.data?.response?.result !== 'success') throw new Error(`Tautulli ${cmd} failed`);
  return res.data.response.data;
}

async function planTautulli(config, { http, webhookUrl }) {
  const agents = await tautulli(http, config, 'get_available_notifier_agents');
  const discord = (agents || []).find(a => a.name === 'discord');
  if (!discord) return { app: 'Tautulli', action: 'skip', detail: 'no Discord notification agent in this version' };
  const notifiers = await tautulli(http, config, 'get_notifiers');
  const mine = (notifiers || []).find(n => n.friendly_name === CONNECTION_NAME && n.agent_name === 'discord');
  const triggers = TAUTULLI_TRIGGERS_ON.map(t => TAUTULLI_LABELS[t]).join(', ');
  const settings = { agent_id: discord.id, friendly_name: CONNECTION_NAME, discord_hook: webhookUrl };
  for (const t of TAUTULLI_TRIGGERS_ON) settings[t] = 1;
  if (!mine) {
    return { app: 'Tautulli', action: 'create', detail: `add Discord notifier "${CONNECTION_NAME}": ${triggers}`, tautulli: { create: true, agentId: discord.id, settings } };
  }
  const cfg = await tautulli(http, config, 'get_notifier_config', { notifier_id: mine.id });
  const actions = cfg?.actions || {};
  const missing = TAUTULLI_TRIGGERS_ON.filter(t => Number(actions[t]) !== 1);
  const extra = Object.keys(actions).filter(t => /^on_/.test(t) && !TAUTULLI_TRIGGERS_ON.includes(t) && Number(actions[t]) === 1);
  const hookChanged = (cfg?.config?.discord_hook || '') !== webhookUrl;
  if (!missing.length && !extra.length && !hookChanged) return { app: 'Tautulli', action: 'none', detail: `"${CONNECTION_NAME}" already sends ${triggers} only` };
  for (const t of extra) settings[t] = 0;
  const diffs = [...missing.map(t => `${TAUTULLI_LABELS[t]} on`), ...extra.map(t => `${t} off`), ...(hookChanged ? ['webhook changed'] : [])];
  return { app: 'Tautulli', action: 'update', detail: `update "${CONNECTION_NAME}": ${diffs.join(', ')}`, tautulli: { create: false, notifierId: mine.id, settings } };
}

// Read-only. One entry per app; an app that can't be read becomes an 'error' entry rather than
// stopping the others. Errors never include URLs or response bodies.
async function planAll(config, { http, webhookUrl }) {
  const autopulse = config.AUTOPULSE_URL ? { url: config.AUTOPULSE_URL, username: config.AUTOPULSE_USERNAME || '', password: config.AUTOPULSE_PASSWORD || '' } : null;
  if (!webhookUrl && !autopulse) throw new Error('Set NATIVE_ALERTS_DISCORD_WEBHOOK and/or AUTOPULSE_URL');
  const safe = (app, fn) => fn().catch(err => ({ app, action: 'error', detail: `could not read settings (${err?.response?.status ? `HTTP ${err.response.status}` : err?.code || 'request failed'})` }));
  const plans = [];
  if (webhookUrl) {
    for (const target of arrTargets(config)) plans.push(await safe(target.app, () => planArr(target, { http, webhookUrl })));
    if (config.OVERSEERR_URL && config.OVERSEERR_API_KEY) plans.push(await safe('Seerr', () => planSeerr(config, { http })));
    if (config.TAUTULLI_URL && config.TAUTULLI_API_KEY) plans.push(await safe('Tautulli', () => planTautulli(config, { http, webhookUrl })));
  }
  if (autopulse) {
    for (const target of arrTargets(config).filter(t => t.app !== 'Prowlarr')) {
      plans.push(await safe(`${target.app} → Autopulse`, () => planAutopulse(target, { http, autopulse })));
    }
  }
  return plans;
}

async function applyStep(step, config, { http }) {
  if (step.request) {
    const { method, url, body, headers } = step.request;
    await http[method](url, body, { headers, timeout: 15000 });
    return;
  }
  if (step.tautulli) {
    let notifierId = step.tautulli.notifierId;
    if (step.tautulli.create) {
      const created = await tautulli(http, config, 'add_notifier_config', { agent_id: step.tautulli.agentId });
      notifierId = created?.notifier_id ?? created?.id;
      if (notifierId == null) throw new Error('Tautulli did not return the new notifier id');
    }
    await tautulli(http, config, 'set_notifier_config', { notifier_id: notifierId, ...step.tautulli.settings });
  }
}

// Writes only create/update steps. Returns one line per step; failures say which app and the HTTP
// status, nothing else.
async function applyPlan(plans, config, { http }) {
  const results = [];
  for (const step of plans) {
    if (step.action !== 'create' && step.action !== 'update') { results.push({ app: step.app, ok: true, detail: 'nothing to do' }); continue; }
    try {
      await applyStep(step, config, { http });
      results.push({ app: step.app, ok: true, detail: step.action === 'create' ? 'created' : 'updated' });
    } catch (err) {
      results.push({ app: step.app, ok: false, detail: `failed (${err?.response?.status ? `HTTP ${err.response.status}` : err?.code || 'request failed'})` });
    }
  }
  return results;
}

module.exports = {
  CONNECTION_NAME, ARR_EVENTS_ON, SEERR_TYPES, SEERR_WANTED, TAUTULLI_TRIGGERS_ON,
  AUTOPULSE_CONNECTION, AUTOPULSE_EVENTS_ON, desiredAutopulseWebhook, autopulseDifferences, planAutopulse,
  arrTargets, desiredArrNotification, arrDifferences, seerrTypeNames,
  planArr, planSeerr, planTautulli, planAll, applyPlan,
};
