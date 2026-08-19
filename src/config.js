// Environment-driven configuration: CONFIG, required-key validation, and non-fatal
// risky-config warnings. dotenv loads here so CONFIG is correct no matter which module
// is required first.
require('dotenv').config({ quiet: true });
const fs = require('fs');
const http = require('http');

function parseBool(v, fallback = false) {
  if (v === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
}

function resolveFileEnv(env, readFileSync = fs.readFileSync) {
  const fileValues = new Map();
  return new Proxy(env, {
    get(target, key) {
      if (typeof key !== 'string') return Reflect.get(target, key);
      const fileKey = `${key}_FILE`;
      if (!Object.prototype.hasOwnProperty.call(target, fileKey)) return Reflect.get(target, key);
      if (Object.prototype.hasOwnProperty.call(target, key)) {
        throw new Error(`Configuration error: ${key} and ${fileKey} are both set; set only one`);
      }
      if (fileValues.has(key)) return fileValues.get(key);
      try {
        const value = readFileSync(target[fileKey], 'utf8').replace(/\r?\n$/, '');
        fileValues.set(key, value);
        return value;
      } catch (err) {
        throw new Error(`Configuration error: could not read ${fileKey} for ${key}: ${err.message}`, { cause: err });
      }
    },
  });
}

// Discord snowflakes arrive as env values that people paste by hand (and that Portainer/compose
// pass through verbatim), so they routinely carry a trailing CR from a Windows-edited env file,
// stray spaces, or the quotes someone wrapped them in. Discord rejects those as "Unknown Channel"
// with no hint about the invisible character, so scrub them here once instead.
function parseId(v) {
  if (v === undefined || v === null) return '';
  return String(v).trim().replace(/^['"]|['"]$/g, '').trim();
}

function isPlaceholderValue(raw) {
  const value = String(raw || '').trim();
  if (!value) return false;
  return /^changeme$/i.test(value)
    || /^<[^<>]+>$/.test(value)
    || /^(?:https?:\/\/)?your-[a-z0-9-]+(?:[/:]|$)/i.test(value)
    || /^[a-z0-9-]*-name-or-machine-id$/i.test(value)
    || /^main-server-1$/i.test(value)
    || /(?:^|[/:])path-on-[a-z0-9-]+(?:[/:]|$)/i.test(value)
    || /^(?:https?:\/\/)?(?:[^./]+\.)*example\.com(?:[/:]|$)/i.test(value);
}

function parseIdentityList(raw) {
  return String(raw || '').split(',').map(s => s.trim().toLowerCase()).filter(value => value && !isPlaceholderValue(value));
}

function omitPlaceholder(raw) {
  return isPlaceholderValue(raw) ? '' : (raw || '');
}

function placeholderConfigWarnings(config, env) {
  const identityKeys = new Set(['PH_SERVER_NAMES', 'CA_EDGE_SERVER_NAMES', 'PRIMARY_SERVER_NAMES']);
  const warnings = [];
  for (const key of Object.keys(config)) {
    const raw = env[key];
    if (!raw || !String(raw).split(',').some(isPlaceholderValue)) continue;
    if (identityKeys.has(key)) {
      warnings.push(`\`${key}\` contains an example placeholder; it was ignored so it cannot enable strict webhook identity routing. Set the real Plex server name or machine ID.`);
    } else if (key === 'PH_TUNNEL_HEALTH_URL') {
      warnings.push('`PH_TUNNEL_HEALTH_URL` contains an example placeholder; it was ignored so the tunnel watchdog stays disabled instead of sending false outage alerts.');
    } else {
      warnings.push(`\`${key}\` contains an example placeholder. Replace it with a real value or unset it before relying on this setting.`);
    }
  }
  return warnings;
}

const RESOLVED_ENV = resolveFileEnv(process.env);
const CONFIG = (() => {
  const process = { env: RESOLVED_ENV };
  return {
  // Logging: level filters what gets emitted (debug < info < warn < error); format switches
  // between the human-readable default and single-line JSON for log shippers (Loki/ELK/CloudWatch).
  LOG_LEVEL: (process.env.LOG_LEVEL || 'info').toLowerCase(),
  LOG_FORMAT: (process.env.LOG_FORMAT || 'text').toLowerCase(),
  DISCORD_BOT_TOKEN: process.env.DISCORD_BOT_TOKEN,
  DISCORD_CLIENT_ID: parseId(process.env.DISCORD_CLIENT_ID),
  DISCORD_GUILD_ID: parseId(process.env.DISCORD_GUILD_ID),
  ADMIN_CHANNEL_ID: parseId(process.env.ADMIN_CHANNEL_ID),
  ADMIN_USER_ID: parseId(process.env.ADMIN_USER_ID),
  OVERSEERR_URL: (process.env.OVERSEERR_URL || '').replace(/\/$/, ''),
  OVERSEERR_API_KEY: process.env.OVERSEERR_API_KEY,
  REQUEST_RECONCILE_MINUTES: Number.parseInt(process.env.REQUEST_RECONCILE_MINUTES || '15', 10),
  REQUEST_STALLED_HOURS: Number.parseInt(process.env.REQUEST_STALLED_HOURS || '72', 10),
  PENDING_APPROVAL_CHECK_MINUTES: Number.parseInt(process.env.PENDING_APPROVAL_CHECK_MINUTES || '60', 10),
  PENDING_APPROVAL_NUDGE_HOURS: Number.parseInt(process.env.PENDING_APPROVAL_NUDGE_HOURS || '24', 10),
  PENDING_APPROVAL_REQUESTER_HOURS: Number.parseInt(process.env.PENDING_APPROVAL_REQUESTER_HOURS || '48', 10),
  PENDING_APPROVAL_EXPIRE_DAYS: Number.parseInt(process.env.PENDING_APPROVAL_EXPIRE_DAYS || '21', 10),
  WEBHOOK_SECRET: process.env.WEBHOOK_SECRET || '',
  PLEX_TOKEN: process.env.PLEX_TOKEN || '',
  PLEX_USERNAME: process.env.PLEX_USERNAME || '',
  PLEX_PASSWORD: process.env.PLEX_PASSWORD || '',
  PLEX_EXCLUDE_SERVERS: process.env.PLEX_EXCLUDE_SERVERS ? process.env.PLEX_EXCLUDE_SERVERS.split(',').map(v => v.trim().toLowerCase()) : [],
  RADARR_URL: process.env.RADARR_URL || '',
  RADARR_API_KEY: process.env.RADARR_API_KEY || '',
  RADARR_4K_URL: process.env.RADARR_4K_URL || '',
  RADARR_4K_API_KEY: process.env.RADARR_4K_API_KEY || '',
  SONARR_URL: process.env.SONARR_URL || '',
  SONARR_API_KEY: process.env.SONARR_API_KEY || '',
  PROWLARR_URL: process.env.PROWLARR_URL || '',
  PROWLARR_API_KEY: process.env.PROWLARR_API_KEY || '',
  BYPARR_URL: process.env.BYPARR_URL || '',
  TAUTULLI_URL: (process.env.TAUTULLI_URL || '').replace(/\/$/, ''),
  TAUTULLI_API_KEY: process.env.TAUTULLI_API_KEY || '',
  PLAYBACK_CHECK_MINUTES: Number.parseInt(process.env.PLAYBACK_CHECK_MINUTES || '5', 10),
  TRANSCODE_ALERT_COOLDOWN_MINUTES: Number.parseInt(process.env.TRANSCODE_ALERT_COOLDOWN_MINUTES || '60', 10),
  PREMIUMIZE_API_KEY: process.env.PREMIUMIZE_API_KEY || '',
  PREMIUMIZE_CHECK_MINUTES: Number.parseInt(process.env.PREMIUMIZE_CHECK_MINUTES || '15', 10),
  PREMIUMIZE_STUCK_AFTER_MINUTES: Number.parseInt(process.env.PREMIUMIZE_STUCK_AFTER_MINUTES || '45', 10),
  PREMIUMIZE_ALERT_COOLDOWN_HOURS: Number.parseInt(process.env.PREMIUMIZE_ALERT_COOLDOWN_HOURS || '6', 10),
  // A transfer still at (effectively) 0% after the stuck window — no cached source, dead
  // torrent — is deleted automatically instead of sitting in the queue re-alerting forever.
  PREMIUMIZE_AUTO_CLEAR_DEAD: parseBool(process.env.PREMIUMIZE_AUTO_CLEAR_DEAD, true),
  // Progress ceiling (percent) below which a stuck transfer counts as "dead" for auto-clear.
  PREMIUMIZE_AUTO_CLEAR_MAX_PROGRESS: Number.parseInt(process.env.PREMIUMIZE_AUTO_CLEAR_MAX_PROGRESS || '1', 10),
  STUCK_CHECK_MINUTES: Number.parseInt(process.env.STUCK_CHECK_MINUTES || '10', 10),
  STUCK_AFTER_MINUTES: Number.parseInt(process.env.STUCK_AFTER_MINUTES || '45', 10),
  STUCK_ALERT_COOLDOWN_HOURS: Number.parseInt(process.env.STUCK_ALERT_COOLDOWN_HOURS || '6', 10),
  // AvistaZ private-tracker fallback: tag-gated escalation of stalled requests (see README).
  // Radarr/Sonarr lowercase tag labels, so the compare key is lowercased here too.
  AVISTAZ_TAG: (process.env.AVISTAZ_TAG || 'avistaz').toLowerCase(),
  ESCALATION_ENABLED: parseBool(process.env.ESCALATION_ENABLED, false),
  // Minutes with nothing found/downloading before escalation. The legacy ESCALATION_DELAY_HOURS
  // key still works when the minutes key is unset.
  ESCALATION_DELAY_MINUTES: Number.parseInt(process.env.ESCALATION_DELAY_MINUTES
    || (process.env.ESCALATION_DELAY_HOURS ? String(Number.parseInt(process.env.ESCALATION_DELAY_HOURS, 10) * 60) : '45'), 10),
  ESCALATION_CHECK_MINUTES: Number.parseInt(process.env.ESCALATION_CHECK_MINUTES || '15', 10),
  ESCALATION_MAX_AGE_DAYS: Number.parseInt(process.env.ESCALATION_MAX_AGE_DAYS || '14', 10),
  // Minutes after approval before a title that verifiably ISN'T in its arr triggers the
  // "request never landed" alert (Seerr can accept a request and lose it moments later).
  ESCALATION_ARR_GRACE_MINUTES: Number.parseInt(process.env.ESCALATION_ARR_GRACE_MINUTES || '10', 10),
  // Optional overrides for the direct-add rescue path (the "Add to Sonarr/Radarr & Search"
  // button on lost-request alerts). Unset = the arr's first root folder / first quality profile.
  RADARR_ROOT_FOLDER: process.env.RADARR_ROOT_FOLDER || '',
  SONARR_ROOT_FOLDER: process.env.SONARR_ROOT_FOLDER || '',
  RADARR_QUALITY_PROFILE: process.env.RADARR_QUALITY_PROFILE || '',
  SONARR_QUALITY_PROFILE: process.env.SONARR_QUALITY_PROFILE || '',
  // ---- Season-pack-first searching for old shows (every indexer, not just AvistaZ) ----
  // Sonarr searches missing episodes one at a time. For a show that finished airing years ago
  // the whole season exists as one torrent, so the bot asks Sonarr for a SeasonSearch instead —
  // one grab instead of N. Currently-airing shows are untouched (no pack exists for them yet).
  SEASON_PACK_FIRST: parseBool(process.env.SEASON_PACK_FIRST, true),
  // Season search only runs against series carrying AVISTAZ_TAG — otherwise Sonarr's own
  // SeasonSearch/EpisodeSearch hits every configured indexer (public trackers included) and
  // routes to whatever download client those indexers use. Turn on to keep searching untagged
  // series through Sonarr the old way.
  SEASON_PACK_SONARR_UNTAGGED: parseBool(process.env.SEASON_PACK_SONARR_UNTAGGED, false),
  // A tagged series is searched directly against AvistaZ (Prowlarr search → rank → seedbox
  // rTorrent), reusing the same pipeline as /avistaz search and the escalation watchdog,
  // instead of Sonarr's own SeasonSearch command.
  SEASON_PACK_AVISTAZ_DIRECT: parseBool(process.env.SEASON_PACK_AVISTAZ_DIRECT, true),
  // After a completed search makes no or partial progress, inspect Sonarr's rejected releases
  // and report the best candidates. Automatic rejection overrides are a separate, default-off
  // switch so operators can observe the human-in-the-loop buttons before trusting automation.
  SEASON_PACK_INTERACTIVE: parseBool(process.env.SEASON_PACK_INTERACTIVE, true),
  SEASON_PACK_FORCE_GRAB: parseBool(process.env.SEASON_PACK_FORCE_GRAB, false),
  SEASON_PACK_MIN_SEEDERS: Number.parseInt(process.env.SEASON_PACK_MIN_SEEDERS || '1', 10),
  SEASON_PACK_MAX_SIZE_GB: Number.parseInt(process.env.SEASON_PACK_MAX_SIZE_GB || '200', 10),
  SEASON_PACK_MIN_CONFIDENCE: Number.parseInt(process.env.SEASON_PACK_MIN_CONFIDENCE || '70', 10),
  SEASON_PACK_CHECK_MINUTES: Number.parseInt(process.env.SEASON_PACK_CHECK_MINUTES || '180', 10),
  // Give shows somebody actually requested the same treatment even while they're still airing:
  // most releases are "S01" season packs whatever the show's age, and a requester is waiting.
  // Safe on an in-progress season — only aired episodes count toward the missing threshold.
  SEASON_PACK_REQUESTED: parseBool(process.env.SEASON_PACK_REQUESTED, true),
  // A 'continuing' series with nothing aired in this long (and nothing scheduled) counts as old.
  // Series Sonarr marks 'ended' always count, whatever this is set to.
  SEASON_PACK_DORMANT_DAYS: Number.parseInt(process.env.SEASON_PACK_DORMANT_DAYS || '365', 10),
  // Missing episodes needed before a season is searched as a pack. A season that is entirely
  // missing always qualifies; this is the threshold for partially-present seasons, where
  // pulling a whole pack to fill one gap would cost more bandwidth than it saves.
  SEASON_PACK_MIN_MISSING: Number.parseInt(process.env.SEASON_PACK_MIN_MISSING || '3', 10),
  // Don't re-search the same season more often than this — a season with nothing available
  // would otherwise be re-searched every sweep forever.
  SEASON_PACK_COOLDOWN_HOURS: Number.parseInt(process.env.SEASON_PACK_COOLDOWN_HOURS || '24', 10),
  // Ceiling on season searches per sweep, so a first run over a large library doesn't fire
  // hundreds of indexer searches at once.
  SEASON_PACK_MAX_PER_RUN: Number.parseInt(process.env.SEASON_PACK_MAX_PER_RUN || '5', 10),
  // When interactive evidence confirms Sonarr has an approved single-episode result but no
  // eligible pack, stage EpisodeSearch commands without hiding an unbounded indexer fan-out.
  SEASON_PACK_EPISODE_FALLBACK: parseBool(process.env.SEASON_PACK_EPISODE_FALLBACK, true),
  SEASON_PACK_EPISODE_BATCH_SIZE: Number.parseInt(process.env.SEASON_PACK_EPISODE_BATCH_SIZE || '25', 10),
  SEASON_PACK_EPISODE_MAX_PER_RUN: Number.parseInt(process.env.SEASON_PACK_EPISODE_MAX_PER_RUN || '50', 10),
  SEASON_PACK_EPISODE_RETRY_MINUTES: Number.parseInt(process.env.SEASON_PACK_EPISODE_RETRY_MINUTES || '180', 10),
  // An untagged season searched through Sonarr's own indexers whose missing-episode count never
  // shrinks across repeated sweeps is stuck on dead public releases (defunct trackers, no
  // seeders) — this is exactly what AVISTAZ_TAG + SEASON_PACK_AVISTAZ_DIRECT exists to fix, but
  // only for series someone remembered to tag. After this many consecutive stalled sweeps the
  // series is tagged automatically so the next sweep routes it to AvistaZ instead. 0 disables it.
  SEASON_PACK_AUTO_TAG_AFTER_STALLS: Number.parseInt(process.env.SEASON_PACK_AUTO_TAG_AFTER_STALLS || '3', 10),
  // ---- AvistaZ direct grab: Prowlarr search → seedbox rTorrent → rclone → arr import ----
  // Full rTorrent XML-RPC endpoint incl. credentials, e.g.
  // https://user:pass@server.rapidseedbox.com/plugins/rpc/rpc.php
  RTORRENT_URL: process.env.RTORRENT_URL || '',
  // rTorrent label (d.custom1) applied per media type — the category the seedbox side sees.
  RTORRENT_LABEL_MOVIE: process.env.RTORRENT_LABEL_MOVIE || 'radarr',
  RTORRENT_LABEL_TV: process.env.RTORRENT_LABEL_TV || 'sonarr',
  // Case-insensitive substring matched against Prowlarr indexer names to find AvistaZ.
  AVISTAZ_INDEXER_NAME: (process.env.AVISTAZ_INDEXER_NAME || 'avistaz').toLowerCase(),
  // Max grabs per UTC day (failed attempts count — the tracker may have already counted the
  // download). 0 = unlimited.
  AVISTAZ_DAILY_GRAB_LIMIT: Number.parseInt(process.env.AVISTAZ_DAILY_GRAB_LIMIT || '100', 10),
  // 'approve' = always post candidates with Download buttons; 'auto' = escalations grab the
  // top candidate automatically when its confidence ≥ GRAB_AUTO_CONFIDENCE.
  GRAB_MODE: (process.env.GRAB_MODE || 'approve').toLowerCase(),
  GRAB_AUTO_CONFIDENCE: Number.parseInt(process.env.GRAB_AUTO_CONFIDENCE || '92', 10),
  // Block a grab/adoption when an active job already covers the same episode(s) — even a
  // different release/encoding/size of them (info-hash and exact-title dedupe can't see that).
  // On by default; set false to allow multiple releases of the same content into the pipeline.
  GRAB_CONTENT_DEDUPE: parseBool(process.env.GRAB_CONTENT_DEDUPE, true),
  // ---- Whole-series grabs (TV only) ----
  // A single AvistaZ search usually holds more than one useful release for a show (a season
  // pack per season, or packs plus stray episodes). With this on, TV offers gain a "Grab
  // Everything" button that takes every non-overlapping release in one click, and GRAB_MODE=auto
  // grabs that whole set instead of only the top candidate.
  GRAB_TV_COMPLETE: parseBool(process.env.GRAB_TV_COMPLETE, true),
  // Hard ceiling on releases per whole-series grab. The daily allowance still applies and is
  // the tighter limit whenever AVISTAZ_DAILY_GRAB_LIMIT is set.
  GRAB_TV_MAX_RELEASES: Number.parseInt(process.env.GRAB_TV_MAX_RELEASES || '6', 10),
  // Floor for inclusion in a whole-series plan. Deliberately below GRAB_AUTO_CONFIDENCE: the
  // top pick has to clear that bar on its own, while later seasons only need to be plausible.
  GRAB_TV_COMPLETE_MIN_CONFIDENCE: Number.parseInt(process.env.GRAB_TV_COMPLETE_MIN_CONFIDENCE || '70', 10),
  // rclone remote pointing at the seedbox's rTorrent download folder, e.g. `rapidseedbox:files`.
  GRAB_RCLONE_REMOTE: (process.env.GRAB_RCLONE_REMOTE || '').replace(/\/$/, ''),
  // Extra rclone flags for seedbox copies (SFTP tuning etc.), space-separated.
  GRAB_RCLONE_FLAGS: (process.env.GRAB_RCLONE_FLAGS || '').split(/\s+/).filter(Boolean),
  // Writable local staging folder inside the container (NOT under the read-only media
  // mount) that Radarr/Sonarr can also see; GRAB_IMPORT_PATH is that same folder as the
  // arrs see it (defaults to the container path when they share the mount).
  GRAB_STAGING_PATH: (process.env.GRAB_STAGING_PATH || '').replace(/\/$/, ''),
  GRAB_IMPORT_PATH: (process.env.GRAB_IMPORT_PATH || process.env.GRAB_STAGING_PATH || '').replace(/\/$/, ''),
  GRAB_CHECK_MINUTES: Number.parseInt(process.env.GRAB_CHECK_MINUTES || '5', 10),
  GRAB_COPY_TIMEOUT_MINUTES: Number.parseInt(process.env.GRAB_COPY_TIMEOUT_MINUTES || '240', 10),
  // A pushed torrent that never appears in rTorrent within this window failed to load.
  GRAB_MISSING_AFTER_MINUTES: Number.parseInt(process.env.GRAB_MISSING_AFTER_MINUTES || '10', 10),
  // Give up watching a seedbox download after this long without completion.
  GRAB_DOWNLOAD_TIMEOUT_HOURS: Number.parseInt(process.env.GRAB_DOWNLOAD_TIMEOUT_HOURS || '72', 10),
  // When an arr's scan silently declines cleanly-matched files, verifyArrImport can force
  // them through ManualImport automatically — but only ever does so when the job is pinned
  // to a single resolved Sonarr/Radarr id (see target_arr_id) AND every file maps to that
  // exact id, never on a guessed match. Off by default: until that identity resolution is
  // trustworthy for a given deployment, forced imports should go through the guided
  // "Map to a Series…" wizard instead.
  SONARR_AUTO_MANUAL_IMPORT: parseBool(process.env.SONARR_AUTO_MANUAL_IMPORT, false),
  // ---- rTorrent adoption (/rtorrent adopt): bring torrents the bot didn't submit into ----
  // ---- the same transfer/import pipeline. See README "Adopting existing torrents". ----
  // Enables the discovery sweep; /rtorrent adopt itself only needs the grab pipeline pieces.
  RTORRENT_ADOPT_ENABLED: parseBool(process.env.RTORRENT_ADOPT_ENABLED, false),
  RTORRENT_ADOPT_CHECK_MINUTES: Number.parseInt(process.env.RTORRENT_ADOPT_CHECK_MINUTES || '5', 10),
  // rTorrent labels (d.custom1, lowercased) the discovery sweep considers adoptable.
  RTORRENT_ADOPT_LABELS: (process.env.RTORRENT_ADOPT_LABELS || 'sonarr,radarr').split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
  // Adopt discovered candidates automatically instead of posting Adopt buttons.
  RTORRENT_ADOPT_AUTO: parseBool(process.env.RTORRENT_ADOPT_AUTO, false),
  // Seedbox-side absolute folder that GRAB_RCLONE_REMOTE points at (e.g.
  // /home/user/Downloads) — lets adoption map a torrent's d.base_path to the right rclone
  // subpath when torrents live in per-label subfolders.
  RTORRENT_REMOTE_ROOT: (process.env.RTORRENT_REMOTE_ROOT || '').replace(/\/$/, ''),
  JANITOR_CHECK_MINUTES: Number.parseInt(process.env.JANITOR_CHECK_MINUTES || '60', 10),
  RETENTION_ENFORCEMENT: parseBool(process.env.RETENTION_ENFORCEMENT, false),
  RETENTION_CHECK_HOURS: Number.parseInt(process.env.RETENTION_CHECK_HOURS || '24', 10),
  RETENTION_MAX_DELETES_PER_RUN: Number.parseInt(process.env.RETENTION_MAX_DELETES_PER_RUN || '10', 10),
  DISK_SPACE_WARN_GB: Number.parseInt(process.env.DISK_SPACE_WARN_GB || '100', 10),
  DISK_FORECAST_WARN_DAYS: Number.parseInt(process.env.DISK_FORECAST_WARN_DAYS || '14', 10),
  // Optional allowlist of mount points / media folders to report in /status and disk alerts.
  // Unset = report every *arr mount (original behaviour). Set e.g. `/share/media` to hide the
  // container's own `/` and `/config` disks and label the media mount by its real folder.
  DISK_SPACE_PATHS: (process.env.DISK_SPACE_PATHS || '').split(',').map(s => s.trim()).filter(Boolean),
  TUNNEL_DOMAIN: process.env.TUNNEL_DOMAIN,
  RAID_PATH: process.env.RAID_PATH || '/mnt/raid',
  PATH_REMAP_FROM: process.env.PATH_REMAP_FROM || '',
  PATH_REMAP_TO: process.env.PATH_REMAP_TO || process.env.RAID_PATH || '/mnt/raid',
  TAUTULLI_WEBHOOK_SECRET: process.env.TAUTULLI_WEBHOOK_SECRET || '',
  // Optional per-topic notification channels; anything unset falls back to ADMIN_CHANNEL_ID.
  REQUESTS_CHANNEL_ID: parseId(process.env.REQUESTS_CHANNEL_ID),
  SYSTEM_ALERTS_CHANNEL_ID: parseId(process.env.SYSTEM_ALERTS_CHANNEL_ID),
  DOWNLOADS_CHANNEL_ID: parseId(process.env.DOWNLOADS_CHANNEL_ID),
  PLAYBACK_CHANNEL_ID: parseId(process.env.PLAYBACK_CHANNEL_ID),
  CLEANUP_CHANNEL_ID: parseId(process.env.CLEANUP_CHANNEL_ID),
  AUDIT_CHANNEL_ID: parseId(process.env.AUDIT_CHANNEL_ID),
  DEPLOY_CHANNEL_ID: parseId(process.env.DEPLOY_CHANNEL_ID),
  PORT: Number.parseInt(process.env.PORT || '3000', 10),
  TRUST_PROXY: parseBool(process.env.TRUST_PROXY, false),
  DASHBOARD_ENABLED: parseBool(process.env.DASHBOARD_ENABLED, true),
  DASHBOARD_ADMIN_PASSWORD: process.env.DASHBOARD_ADMIN_PASSWORD || '',
  DASHBOARD_ADMIN_TOKEN: process.env.DASHBOARD_ADMIN_TOKEN || '',
  STRICT_DASHBOARD_POST_AUTH: parseBool(process.env.STRICT_DASHBOARD_POST_AUTH, true),
  SESSION_SECRET: process.env.SESSION_SECRET || '',
  SESSION_TTL_HOURS: Number.parseInt(process.env.SESSION_TTL_HOURS || '12', 10),
  ENABLE_DELETION: parseBool(process.env.ENABLE_DELETION, false),
  DELETION_DRY_RUN: parseBool(process.env.DELETION_DRY_RUN, true),
  AUTO_REMOVE_PLEX_ON_LEAVE: parseBool(process.env.AUTO_REMOVE_PLEX_ON_LEAVE, false),
  DOWNLOAD_TOKEN_TTL_HOURS: Number.parseInt(process.env.DOWNLOAD_TOKEN_TTL_HOURS || '24', 10),
  DOWNLOAD_ONE_TIME_LINKS_DEFAULT: parseBool(process.env.DOWNLOAD_ONE_TIME_LINKS_DEFAULT, false),
  DOWNLOAD_MAX_PER_HOUR: Number.parseInt(process.env.DOWNLOAD_MAX_PER_HOUR || '10', 10),
  DOWNLOAD_ROUTE_MAX_PER_MINUTE: Number.parseInt(process.env.DOWNLOAD_ROUTE_MAX_PER_MINUTE || '60', 10),
  DOWNLOAD_LARGE_FILE_GB: Number.parseInt(process.env.DOWNLOAD_LARGE_FILE_GB || '8', 10),
  // ---- Plex Home staging (remote cache box behind a tunnel) ----
  // The PH box serves a small local cache of the Main library. The bot copies titles into
  // that cache over rclone ("staging"), evicts them when space runs short, and must never let a
  // PH playback event trigger anything destructive against the master library.
  STAGING_ENABLED: parseBool(process.env.STAGING_ENABLED, false),
  // Server identities as they appear in Tautulli ({server_name}/{machine_id}) and Plex webhook
  // payloads (Server.title/uuid), lowercased. PH_SERVER_NAMES marks the Philippines cache box,
  // CA_EDGE_SERVER_NAMES marks the California cache/fallback node, and PRIMARY_SERVER_NAMES
  // strictly identifies only full Main storage servers. Viewing groups remain Main/Philippines.
  PH_SERVER_NAMES: parseIdentityList(process.env.PH_SERVER_NAMES),
  CA_EDGE_SERVER_NAMES: parseIdentityList(process.env.CA_EDGE_SERVER_NAMES),
  PRIMARY_SERVER_NAMES: parseIdentityList(process.env.PRIMARY_SERVER_NAMES),
  // rclone destination root for the cache, e.g. `phbox:/cache` or `phbox:cache`.
  STAGE_RCLONE_REMOTE: (process.env.STAGE_RCLONE_REMOTE || '').replace(/\/$/, ''),
  STAGE_RCLONE_BINARY: process.env.STAGE_RCLONE_BINARY || 'rclone',
  // Extra rclone flags (space-separated), e.g. `--config /app/data/rclone.conf --bwlimit 8M`.
  STAGE_RCLONE_FLAGS: (process.env.STAGE_RCLONE_FLAGS || '').split(/\s+/).filter(Boolean),
  // Cache budget when `rclone about` can't report free space for the remote (0 = rely on
  // rclone about only). Free space is then budget minus the tracked staged items.
  STAGE_CACHE_MAX_GB: Number.parseInt(process.env.STAGE_CACHE_MAX_GB || '0', 10),
  STAGE_MIN_FREE_GB: Number.parseInt(process.env.STAGE_MIN_FREE_GB || '25', 10),
  STAGE_JOB_TIMEOUT_MINUTES: Number.parseInt(process.env.STAGE_JOB_TIMEOUT_MINUTES || '240', 10),
  STAGE_CHECK_MINUTES: Number.parseInt(process.env.STAGE_CHECK_MINUTES || '2', 10),
  STAGE_MAX_PER_USER_PER_DAY: Number.parseInt(process.env.STAGE_MAX_PER_USER_PER_DAY || '6', 10),
  // §Phase2 cache-tree layout. The staged copy's path RELATIVE to the cache root must match the
  // master library tree exactly for a local-first mergerfs view to substitute it — otherwise the
  // local copy is an unused duplicate. The master uses `Movies/<folder>` and `TV Shows/<folder>`,
  // so those are the defaults (the old lowercase `movies`/`tv` never matched). Override only if the
  // master tree uses different top-level names. Trailing/leading slashes are trimmed.
  STAGE_MOVIES_SUBDIR: (process.env.STAGE_MOVIES_SUBDIR || 'Movies').replace(/^\/+|\/+$/g, ''),
  STAGE_TV_SUBDIR: (process.env.STAGE_TV_SUBDIR || 'TV Shows').replace(/^\/+|\/+$/g, ''),
  // §Phase2: how often to reconcile staged_items against what's actually on the cache drive
  // (drops rows whose file vanished and re-queues them). 0 disables the periodic sweep; the
  // startup sweep still runs once.
  STAGE_RECONCILE_MINUTES: Number.parseInt(process.env.STAGE_RECONCILE_MINUTES || '30', 10),
  // Play-triggered promotion (PH pilot; see docs/edge-playback-architecture.md §2.2). When a PH
  // viewer starts a title that isn't cached yet, stage it so the NEXT play is local. Off by
  // default. EDGE_PROMOTE_AUDIT_ONLY decides + logs ('edge_promote_would_stage') without copying,
  // for a safe dark rollout. The cap is enforced here (not inherited from /stage's command-layer
  // limit) and attributed to the linked watcher; the cooldown stops a nightly binge re-copying.
  EDGE_PROMOTE_ON_PLAY: parseBool(process.env.EDGE_PROMOTE_ON_PLAY, false),
  EDGE_PROMOTE_AUDIT_ONLY: parseBool(process.env.EDGE_PROMOTE_AUDIT_ONLY, false),
  EDGE_PROMOTE_COOLDOWN_HOURS: Number.parseInt(process.env.EDGE_PROMOTE_COOLDOWN_HOURS || '12', 10),
  EDGE_PROMOTE_MAX_PER_USER_PER_DAY: Number.parseInt(process.env.EDGE_PROMOTE_MAX_PER_USER_PER_DAY || '6', 10),
  // Tunnel watchdog: any HTTP response from this URL (e.g. the PH Plex /identity endpoint via
  // the VPS tunnel) counts as up; connect errors/timeouts count as down.
  PH_TUNNEL_HEALTH_URL: omitPlaceholder(process.env.PH_TUNNEL_HEALTH_URL),
  PH_TUNNEL_CHECK_MINUTES: Number.parseInt(process.env.PH_TUNNEL_CHECK_MINUTES || '5', 10),
  PH_TUNNEL_FAILS_BEFORE_ALERT: Number.parseInt(process.env.PH_TUNNEL_FAILS_BEFORE_ALERT || '3', 10),
  // Tailscale as an *optional* reachability path for PH viewers: CGNAT + no IPv6 means normal
  // Plex remote access can't reach the box, and the Cloudflare tunnel is reserved for the bot's
  // own HTTP routes (never media, per Plex's ToS). Nothing here invites anyone automatically —
  // it only controls whether the "Approve + Tailscale" button appears, so an admin can opt a
  // specific person in by hand instead of every PH request getting one.
  TAILSCALE_ENABLED: parseBool(process.env.TAILSCALE_ENABLED, false),
  TAILSCALE_SETUP_URL: process.env.TAILSCALE_SETUP_URL || 'https://tailscale.com/download',
  TAILSCALE_SERVER_ADDRESS: process.env.TAILSCALE_SERVER_ADDRESS || '',
  // ---- Regional tiering ("edge cache"): per-node curation of the replicated library ----
  // Planner knobs; per-node overrides (warm/fresh days) live in the tier_nodes table.
  TIER_CORE_TOP_K: Number.parseInt(process.env.TIER_CORE_TOP_K || '25', 10),
  TIER_HALF_LIFE_DAYS: Number.parseInt(process.env.TIER_HALF_LIFE_DAYS || '30', 10),
  TIER_WARM_DAYS: Number.parseInt(process.env.TIER_WARM_DAYS || '14', 10),
  TIER_FRESH_DAYS: Number.parseInt(process.env.TIER_FRESH_DAYS || '30', 10),
  TIER_REQUEST_GRACE_DAYS: Number.parseInt(process.env.TIER_REQUEST_GRACE_DAYS || '45', 10),
  TIER_HISTORY_DAYS: Number.parseInt(process.env.TIER_HISTORY_DAYS || '90', 10),
  // §1.4 anti-churn: a candidate must clear a meaningful net gain before it displaces kept titles.
  TIER_CHURN_MIN_ABSOLUTE: Number.parseFloat(process.env.TIER_CHURN_MIN_ABSOLUTE || '0.05'),
  TIER_CHURN_MIN_RELATIVE: Number.parseFloat(process.env.TIER_CHURN_MIN_RELATIVE || '0.2'),
  TIER_CHURN_PENALTY_PER_TB: Number.parseFloat(process.env.TIER_CHURN_PENALTY_PER_TB || '0.05'),
  // §1.5 apply guardrails: a rebalance beyond ANY of these caps needs an echoed confirmation code
  // tied to the exact plan hash (`/tier apply node:<n> confirm:XXXX`). Caps are on the plan's real
  // effect vs the node's last physical inventory: bytes actually deleted, titles deleted, bytes to
  // download. 0 disables a cap.
  TIER_APPLY_MAX_REMOVAL_GB: Number.parseInt(process.env.TIER_APPLY_MAX_REMOVAL_GB || '100', 10),
  TIER_APPLY_MAX_REMOVED_TITLES: Number.parseInt(process.env.TIER_APPLY_MAX_REMOVED_TITLES || '10', 10),
  TIER_APPLY_MAX_DOWNLOAD_GB: Number.parseInt(process.env.TIER_APPLY_MAX_DOWNLOAD_GB || '150', 10),
  // Prefix stripped from remapped arr paths to make manifest paths folder-relative (the
  // Syncthing folder root as THIS bot sees it). Defaults to the media mount.
  TIER_SOURCE_ROOT: (process.env.TIER_SOURCE_ROOT || process.env.PATH_REMAP_TO || process.env.RAID_PATH || '/mnt/raid').replace(/\/$/, ''),
  // Optional JSON array seeding tier_nodes when the table is empty, e.g.
  // [{"name":"california","usable_bytes":4000000000000,"headroom_pct":25,"demand_source":"plex","plex_url":"http://<node-tailscale-ip>:32400","plex_token":"...","sticky":1}]
  // Prefer demand_source "plex" whenever the bot can reach the node's PMS: real watch history,
  // immune to Plex's scheduled file scans (which are exactly what pollutes atime), with the
  // agent's atime report as automatic per-title/whole-node fallback. Use "atime" only when the
  // node's PMS is unreachable from the bot.
  TIER_NODES_SEED: process.env.TIER_NODES_SEED || '',
  DELETION_GRACE_HOURS: Number.parseInt(process.env.DELETION_GRACE_HOURS || '24', 10),
  DELETION_REMINDER_COOLDOWN_HOURS: Number.parseInt(process.env.DELETION_REMINDER_COOLDOWN_HOURS || '12', 10),
  KEEP_LIST_DEFAULT_DAYS: Number.parseInt(process.env.KEEP_LIST_DEFAULT_DAYS || '90', 10),
  LOG_RETENTION_DAYS: Number.parseInt(process.env.LOG_RETENTION_DAYS || '90', 10),
  PENDING_EMAIL_EXPIRY_DAYS: Number.parseInt(process.env.PENDING_EMAIL_EXPIRY_DAYS || '14', 10),
  SHUTDOWN_DRAIN_SECONDS: Number.parseInt(process.env.SHUTDOWN_DRAIN_SECONDS || '8', 10),
  WEBHOOK_DEDUPE_WINDOW_MINUTES: Number.parseInt(process.env.WEBHOOK_DEDUPE_WINDOW_MINUTES || '5', 10),
  WEBHOOK_EVENT_RETENTION_DAYS: Number.parseInt(process.env.WEBHOOK_EVENT_RETENTION_DAYS || '3', 10),
  BACKUP_INTERVAL_HOURS: Number.parseInt(process.env.BACKUP_INTERVAL_HOURS || '0', 10),
  BACKUP_DIR: process.env.BACKUP_DIR || '/app/data/backups',
  BACKUP_KEEP_COUNT: Number.parseInt(process.env.BACKUP_KEEP_COUNT || '14', 10),
  REQUEST_SUBSCRIBER_RETENTION_DAYS: Number.parseInt(process.env.REQUEST_SUBSCRIBER_RETENTION_DAYS || '180', 10),
  PLEX_MEMBER_ROLE_ID: parseId(process.env.PLEX_MEMBER_ROLE_ID) || null,
  WHATS_NEW_ENABLED: parseBool(process.env.WHATS_NEW_ENABLED, false),
  WHATS_NEW_CHANNEL_ID: parseId(process.env.WHATS_NEW_CHANNEL_ID) || null,
  // Multiple seasons of the same show becoming available close together collapse into one post.
  WHATS_NEW_GROUP_WINDOW_HOURS: Number.parseInt(process.env.WHATS_NEW_GROUP_WINDOW_HOURS || '20', 10),
  // 0 = disabled (default), preserving today's behavior — every non-admin request is gated.
  AUTO_APPROVE_AFTER_N_APPROVED: Number.parseInt(process.env.AUTO_APPROVE_AFTER_N_APPROVED || '0', 10),
  MONTHLY_RECAP_ENABLED: parseBool(process.env.MONTHLY_RECAP_ENABLED, false),
  NEVER_DELETE_MEDIA_IDS: process.env.NEVER_DELETE_MEDIA_IDS ? process.env.NEVER_DELETE_MEDIA_IDS.split(',').map(s => s.trim()) : [],
  };
})();

CONFIG.PLACEHOLDER_WARNINGS = placeholderConfigWarnings(CONFIG, RESOLVED_ENV);

const REQUIRED_ENV = [
  'DISCORD_BOT_TOKEN', 'DISCORD_CLIENT_ID', 'DISCORD_GUILD_ID', 'ADMIN_CHANNEL_ID', 'ADMIN_USER_ID',
  'OVERSEERR_URL', 'OVERSEERR_API_KEY', 'TUNNEL_DOMAIN', 'RAID_PATH',
];

function validateConfig() {
  const missing = REQUIRED_ENV.filter(k => !CONFIG[k]);
  if (!CONFIG.PLEX_TOKEN && !(CONFIG.PLEX_USERNAME && CONFIG.PLEX_PASSWORD)) {
    missing.push('PLEX_TOKEN or PLEX_USERNAME+PLEX_PASSWORD');
  }
  if (missing.length) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
  if (CONFIG.DASHBOARD_ENABLED && !CONFIG.DASHBOARD_ADMIN_PASSWORD && !CONFIG.DASHBOARD_ADMIN_TOKEN) {
    throw new Error('DASHBOARD_ENABLED=true requires DASHBOARD_ADMIN_PASSWORD or DASHBOARD_ADMIN_TOKEN');
  }
  // Dashboard sessions are signed with SESSION_SECRET. Without this check the app would fall back
  // to deriving a signing key from the admin password/token via a fast general-purpose hash — a
  // captured signed session cookie would then give an attacker a known HMAC message/signature
  // pair, making a weak admin credential guessable offline at SHA-256 speed. Refusing to start is
  // the actionable fix: generate one with `openssl rand -hex 32` and set SESSION_SECRET.
  if (CONFIG.DASHBOARD_ENABLED && !CONFIG.SESSION_SECRET) {
    throw new Error('DASHBOARD_ENABLED=true requires SESSION_SECRET (generate one with `openssl rand -hex 32`); dashboard sessions must never be signed with a key derived from the admin password/token');
  }
  // TUNNEL_DOMAIN makes /webhook/overseerr, /webhook/plex, and /webhook/tautulli reachable from
  // the public internet regardless of whether deletion is live — an unauthenticated webhook is a
  // real attack surface (spoofed events, request/queue manipulation) on its own.
  if (CONFIG.TUNNEL_DOMAIN && !CONFIG.WEBHOOK_SECRET) {
    throw new Error('WEBHOOK_SECRET is required whenever TUNNEL_DOMAIN is set; the Overseerr/Plex webhook endpoints would otherwise be reachable from the internet without authentication');
  }
  if (CONFIG.TUNNEL_DOMAIN && !CONFIG.TAUTULLI_WEBHOOK_SECRET) {
    throw new Error('TAUTULLI_WEBHOOK_SECRET is required whenever TUNNEL_DOMAIN is set; the Tautulli webhook endpoint would otherwise be reachable from the internet without authentication');
  }
  // Redundant with the TUNNEL_DOMAIN check above (which already covers every deployment, since
  // TUNNEL_DOMAIN is itself required), kept as a second, deletion-specific guard so unauthenticated
  // playback webhooks can never arm destructive actions even if the check above is ever loosened.
  if (CONFIG.ENABLE_DELETION && !CONFIG.DELETION_DRY_RUN && (!CONFIG.WEBHOOK_SECRET || !CONFIG.TAUTULLI_WEBHOOK_SECRET)) {
    throw new Error('Live deletion requires both WEBHOOK_SECRET and TAUTULLI_WEBHOOK_SECRET; unauthenticated playback webhooks must never arm destructive actions');
  }
  if (CONFIG.ENABLE_DELETION && !CONFIG.DELETION_DRY_RUN && (CONFIG.PH_SERVER_NAMES.length || CONFIG.CA_EDGE_SERVER_NAMES.length) && !CONFIG.PRIMARY_SERVER_NAMES.length) {
    throw new Error('Live deletion with edge servers requires PRIMARY_SERVER_NAMES so only explicitly identified full Main servers can arm deletion');
  }
  if (CONFIG.ENABLE_DELETION && !CONFIG.DELETION_DRY_RUN) {
    const identities = [...CONFIG.PH_SERVER_NAMES, ...CONFIG.CA_EDGE_SERVER_NAMES, ...CONFIG.PRIMARY_SERVER_NAMES];
    const duplicate = identities.find((id, index) => identities.indexOf(id) !== index);
    if (duplicate) throw new Error(`Live deletion refuses overlapping server identity '${duplicate}'; PH_SERVER_NAMES, CA_EDGE_SERVER_NAMES, and PRIMARY_SERVER_NAMES must be disjoint`);
  }
}

function startConfigErrorServer(error, fatalPath = '/app/data/last-fatal.txt') {
  const message = error instanceof Error ? error.message : String(error);
  const { log } = require('./log');
  log.error(`Startup validation failed: ${message}. Serving config-error health only on port ${CONFIG.PORT}.`);
  try {
    fs.writeFileSync(fatalPath, `${new Date().toISOString()} ${message}\n`, 'utf8');
  } catch (writeError) {
    log.error(`Could not write ${fatalPath}: ${writeError.message}`);
  }
  return http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'GET' && req.url === '/health') {
      res.statusCode = 503;
      return res.end(JSON.stringify({ overall: 'config_error', error: message }));
    }
    res.statusCode = 404;
    return res.end(JSON.stringify({ error: 'Not Found' }));
  }).listen(CONFIG.PORT);
}

// Non-fatal sanity checks for risky-but-valid configurations. Logged at startup and posted once
// to the system channel after connect, so a dangerous combo can't sit unnoticed.
function configWarnings() {
  const warnings = [...CONFIG.PLACEHOLDER_WARNINGS];
  for (const [urlKey, keyKey] of [
    ['RADARR_URL', 'RADARR_API_KEY'],
    ['RADARR_4K_URL', 'RADARR_4K_API_KEY'],
    ['SONARR_URL', 'SONARR_API_KEY'],
    ['PROWLARR_URL', 'PROWLARR_API_KEY'],
    ['TAUTULLI_URL', 'TAUTULLI_API_KEY'],
  ]) {
    if (!!CONFIG[urlKey] !== !!CONFIG[keyKey]) {
      warnings.push(`\`${urlKey}\` and \`${keyKey}\` must be set together — this integration is incomplete.`);
    }
  }
  if (CONFIG.PORT !== 3000) {
    warnings.push(`\`PORT=${CONFIG.PORT}\` does not match the repository Compose mapping \`3000:3000\` — update both sides of \`ports\` or restore \`PORT=3000\`.`);
  }
  if (!['debug', 'info', 'warn', 'error'].includes(CONFIG.LOG_LEVEL)) {
    warnings.push(`\`LOG_LEVEL=${CONFIG.LOG_LEVEL}\` is not a valid level (use \`debug\`, \`info\`, \`warn\`, or \`error\`) — treating it as \`info\`.`);
  }
  if (!['text', 'json'].includes(CONFIG.LOG_FORMAT)) {
    warnings.push(`\`LOG_FORMAT=${CONFIG.LOG_FORMAT}\` is not a valid format (use \`text\` or \`json\`) — treating it as \`text\`.`);
  }
  // WEBHOOK_SECRET/TAUTULLI_WEBHOOK_SECRET being blank while TUNNEL_DOMAIN is set is no longer
  // reachable here — validateConfig() now refuses to start in that case (see above).
  if (CONFIG.ENABLE_DELETION && !CONFIG.DELETION_DRY_RUN) {
    warnings.push('Deletion is **live** (`ENABLE_DELETION=true`, `DELETION_DRY_RUN=false`) — the janitor and retention rules will delete real files.');
  }
  const dashSecret = CONFIG.DASHBOARD_ADMIN_PASSWORD || CONFIG.DASHBOARD_ADMIN_TOKEN;
  if (CONFIG.DASHBOARD_ENABLED && dashSecret && dashSecret.length < 12) {
    warnings.push('The dashboard password/token is under 12 characters — use a longer one (login is internet-reachable if your tunnel exposes it).');
  }
  if (CONFIG.DASHBOARD_ENABLED && CONFIG.SESSION_SECRET && CONFIG.SESSION_SECRET.length < 32) {
    warnings.push('`SESSION_SECRET` is under 32 characters — use a longer, random value (e.g. `openssl rand -hex 32`) so signed dashboard sessions cannot be brute-forced offline.');
  }
  // A malformed ID is invisible at runtime: every notification to that channel just quietly
  // fails to resolve, so the bot looks healthy while nothing is ever posted. (Key list is local
  // rather than module-level so the vm-sandbox test harness, which extracts whole functions,
  // can run this check standalone.)
  const idKeys = [
    'DISCORD_CLIENT_ID', 'DISCORD_GUILD_ID', 'ADMIN_CHANNEL_ID', 'ADMIN_USER_ID',
    'REQUESTS_CHANNEL_ID', 'SYSTEM_ALERTS_CHANNEL_ID', 'DOWNLOADS_CHANNEL_ID', 'PLAYBACK_CHANNEL_ID',
    'CLEANUP_CHANNEL_ID', 'AUDIT_CHANNEL_ID', 'DEPLOY_CHANNEL_ID', 'WHATS_NEW_CHANNEL_ID',
    'PLEX_MEMBER_ROLE_ID',
  ];
  for (const key of idKeys) {
    const value = CONFIG[key];
    if (value && !/^\d{17,20}$/.test(value)) {
      warnings.push(`\`${key}=${value}\` is not a Discord ID (17-20 digits) — right-click the channel/user in Discord with Developer Mode on and "Copy ID". Nothing routed there will ever be delivered.`);
    }
  }
  if (CONFIG.PLAYBACK_CHECK_MINUTES > 0 && CONFIG.PLAYBACK_CHANNEL_ID && !(CONFIG.TAUTULLI_URL && CONFIG.TAUTULLI_API_KEY)) {
    warnings.push('`PLAYBACK_CHANNEL_ID` is set but Tautulli isn\'t configured (`TAUTULLI_URL` + `TAUTULLI_API_KEY`) — no playback alerts will be sent.');
  }
  if (CONFIG.ESCALATION_ENABLED && !CONFIG.RADARR_URL && !CONFIG.SONARR_URL) {
    warnings.push('`ESCALATION_ENABLED=true` but neither Radarr nor Sonarr is configured — AvistaZ escalation can never fire.');
  }
  if (CONFIG.RTORRENT_URL && !CONFIG.PROWLARR_URL) {
    warnings.push('`RTORRENT_URL` is set but Prowlarr isn\'t (`PROWLARR_URL` + `PROWLARR_API_KEY`) — the AvistaZ direct-grab pipeline can\'t search anything.');
  }
  if (CONFIG.RTORRENT_URL && (!CONFIG.GRAB_RCLONE_REMOTE || !CONFIG.GRAB_STAGING_PATH)) {
    warnings.push('`RTORRENT_URL` is set but `GRAB_RCLONE_REMOTE`/`GRAB_STAGING_PATH` aren\'t — completed seedbox grabs can\'t be copied home and imported.');
  }
  if (CONFIG.RTORRENT_URL && !CONFIG.RADARR_URL && !CONFIG.SONARR_URL) {
    warnings.push('`RTORRENT_URL` is set but neither Radarr nor Sonarr is configured — completed grabs could never be imported.');
  }
  if (CONFIG.RTORRENT_ADOPT_ENABLED && (!CONFIG.RTORRENT_URL || !CONFIG.GRAB_RCLONE_REMOTE || !CONFIG.GRAB_STAGING_PATH)) {
    warnings.push('`RTORRENT_ADOPT_ENABLED=true` but the transfer pipeline is incomplete (`RTORRENT_URL` + `GRAB_RCLONE_REMOTE` + `GRAB_STAGING_PATH`) — adopted torrents could never be copied home.');
  }
  if (!['approve', 'auto'].includes(CONFIG.GRAB_MODE)) {
    warnings.push(`\`GRAB_MODE=${CONFIG.GRAB_MODE}\` is not a valid mode (use \`approve\` or \`auto\`) — treating it as \`approve\`.`);
  }
  if (CONFIG.STAGING_ENABLED && !CONFIG.STAGE_RCLONE_REMOTE) {
    warnings.push('`STAGING_ENABLED=true` but `STAGE_RCLONE_REMOTE` is unset — `/stage` can never copy anything to the cache box.');
  }
  if (CONFIG.STAGING_ENABLED && !CONFIG.PH_SERVER_NAMES.length && !CONFIG.PLACEHOLDER_WARNINGS.some(warning => warning.includes('`PH_SERVER_NAMES`'))) {
    warnings.push('`STAGING_ENABLED=true` but `PH_SERVER_NAMES` is unset — webhook events from the cache box are indistinguishable from the master, so a PH viewer finishing a movie could trigger a **delete prompt against the master library**. Set it before the box goes live.');
  }
  if (CONFIG.PH_SERVER_NAMES.length || CONFIG.CA_EDGE_SERVER_NAMES.length) {
    warnings.push('An edge identity list is set: Tautulli/Plex webhook payloads that carry **no** server identity are now skipped as a fail-safe. Make sure every Tautulli notification payload includes `server_name`/`machine_id` or the finished-watching prompts stop firing.');
  }
  const lists = [
    ['PH_SERVER_NAMES', CONFIG.PH_SERVER_NAMES],
    ['CA_EDGE_SERVER_NAMES', CONFIG.CA_EDGE_SERVER_NAMES],
    ['PRIMARY_SERVER_NAMES', CONFIG.PRIMARY_SERVER_NAMES],
  ];
  const overlaps = [];
  for (let i = 0; i < lists.length; i++) {
    for (let j = i + 1; j < lists.length; j++) {
      const shared = lists[i][1].filter(id => lists[j][1].includes(id));
      if (shared.length) overlaps.push(`${lists[i][0]} / ${lists[j][0]}: ${shared.join(', ')}`);
    }
  }
  if (overlaps.length) {
    warnings.push(`Server identities overlap between routing lists: ${overlaps.join('; ')}. Remove every overlap before trusting webhook routing.`);
  }
  return warnings;
}

module.exports = { parseBool, parseId, resolveFileEnv, isPlaceholderValue, parseIdentityList, omitPlaceholder, placeholderConfigWarnings, CONFIG, REQUIRED_ENV, validateConfig, startConfigErrorServer, configWarnings };
