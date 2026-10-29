'use strict';

// "Last watched" and "last active" for the People tab. Read-only bookkeeping: nothing here
// alerts, messages anyone or changes access.
//
// Plex: every server is signed in under the owner's Plex account, so Plex webhooks arrive from all
// of them; each play is recorded per Plex account and server. A history sweep fills in plays from
// before the webhooks were recorded, from the main Tautulli and from each fleet node's own Tautulli
// or Plex history. Rows are keyed by Plex account ID, which webhooks, Tautulli (user_id) and Plex
// history (accountID) all share, and matched to People by the account's email (the same mapping
// the webhook flow uses), else by Plex username.
//
// Discord: the newest message, DM or command per member, from events the bot already receives,
// plus a one-time look back through recent channel history so quiet members aren't blank on day
// one. Presence (online/offline) is not used: it needs a privileged intent the bot doesn't have.

const TITLE_MAX = 200;

function clip(value, max = TITLE_MAX) {
  const s = String(value ?? '').replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, max) : null;
}

// Keep only the newest play per account and server.
function recordPlexPlay(database, { accountId, server, at, title }) {
  const id = String(accountId ?? '').trim();
  const srv = clip(server, 80);
  const when = Number(at);
  if (!id || !srv || !Number.isFinite(when) || when <= 0) return false;
  return database.prepare(`INSERT INTO plex_last_watched (account_id, server, watched_at, title) VALUES (?, ?, ?, ?)
    ON CONFLICT(account_id, server) DO UPDATE SET watched_at = excluded.watched_at, title = excluded.title
    WHERE excluded.watched_at > plex_last_watched.watched_at`).run(id, srv, Math.round(when), clip(title)).changes > 0;
}

function recordDiscordActivity(database, { discordId, at, place }) {
  const id = String(discordId ?? '');
  const when = Number(at);
  if (!/^\d{5,25}$/.test(id) || !Number.isFinite(when) || when <= 0) return false;
  return database.prepare(`INSERT INTO discord_last_active (discord_id, active_at, place) VALUES (?, ?, ?)
    ON CONFLICT(discord_id) DO UPDATE SET active_at = excluded.active_at, place = excluded.place
    WHERE excluded.active_at > discord_last_active.active_at`).run(id, Math.round(when), clip(place, 80)).changes > 0;
}

// A Plex webhook payload (any server). Only plays count: play, resume and scrobble (finished).
function playFromWebhook(payload, now = Date.now()) {
  const event = payload && payload.event;
  if (!['media.play', 'media.resume', 'media.scrobble'].includes(event)) return null;
  const accountId = payload.Account && payload.Account.id;
  const server = payload.Server && (payload.Server.title || payload.Server.uuid);
  const m = payload.Metadata || {};
  if (accountId == null || !server) return null;
  const title = m.type === 'episode' && m.grandparentTitle ? `${m.grandparentTitle} · ${m.title || ''}`.replace(/ · $/, '') : m.title;
  return { accountId: String(accountId), server, at: now, title };
}

// Tautulli get_history rows: user_id is the Plex account ID, date is Unix seconds.
function playsFromTautulli(rows, server) {
  return (rows || []).filter(r => r && r.user_id != null && Number(r.date) > 0)
    .map(r => ({ accountId: String(r.user_id), server, at: Number(r.date) * 1000, title: r.full_title || r.title }));
}

// Plex /status/sessions/history/all rows: accountID and viewedAt (Unix seconds).
function playsFromPlex(rows, server) {
  return (rows || []).filter(r => r && r.accountID != null && Number(r.viewedAt) > 0)
    .map(r => ({ accountId: String(r.accountID), server, at: Number(r.viewedAt) * 1000, title: r.type === 'episode' && r.grandparentTitle ? `${r.grandparentTitle} · ${r.title || ''}` : r.title }));
}

// Newest play per account across a batch, so a sweep writes one row per account and server.
function newestPerAccountServer(plays) {
  const best = new Map();
  for (const p of plays) {
    const k = `${p.accountId}\u0000${p.server}`;
    if (!best.has(k) || p.at > best.get(k).at) best.set(k, p);
  }
  return [...best.values()];
}

function recordPlays(database, plays) {
  let changed = 0;
  database.transaction(list => { for (const p of list) if (recordPlexPlay(database, p)) changed += 1; })(newestPerAccountServer(plays));
  return changed;
}

// For each People row ({ discord_id, email, plex_username }): the newest play on any server and
// the newest Discord activity. emailByAccount and nameByAccount map Plex account IDs to the
// account's email and username (from plex.tv, the same source the webhook flow uses).
function activityForMembers(database, users, { emailByAccount = new Map(), nameByAccount = new Map() } = {}) {
  const accountByEmail = new Map();
  for (const [id, email] of emailByAccount) if (email) accountByEmail.set(String(email).toLowerCase().trim(), String(id));
  const accountByName = new Map();
  for (const [id, name] of nameByAccount) if (name) accountByName.set(String(name).toLowerCase().trim(), String(id));
  const plays = new Map();
  for (const r of database.prepare('SELECT account_id, server, watched_at, title FROM plex_last_watched ORDER BY watched_at DESC').all()) {
    if (!plays.has(r.account_id)) plays.set(r.account_id, { at: r.watched_at, server: r.server, title: r.title });
  }
  const discord = new Map(database.prepare('SELECT discord_id, active_at, place FROM discord_last_active').all().map(r => [r.discord_id, { at: r.active_at, place: r.place }]));
  const out = new Map();
  for (const u of users || []) {
    const account = (u.email && accountByEmail.get(String(u.email).toLowerCase().trim()))
      || (u.plex_username && accountByName.get(String(u.plex_username).toLowerCase().trim()))
      || null;
    out.set(u.discord_id, {
      plexMatched: !!account,
      watched: account ? plays.get(account) || null : null,
      discord: discord.get(String(u.discord_id)) || null,
    });
  }
  return out;
}

module.exports = {
  recordPlexPlay, recordDiscordActivity, playFromWebhook, playsFromTautulli, playsFromPlex,
  newestPerAccountServer, recordPlays, activityForMembers,
};
