// Environment-driven configuration: CONFIG, required-key validation, and non-fatal
// risky-config warnings. dotenv loads here so CONFIG is correct no matter which module
// is required first.
require('dotenv').config();

function parseBool(v, fallback = false) {
  if (v === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
}

const CONFIG = {
  DISCORD_BOT_TOKEN: process.env.DISCORD_BOT_TOKEN,
  DISCORD_CLIENT_ID: process.env.DISCORD_CLIENT_ID,
  DISCORD_GUILD_ID: process.env.DISCORD_GUILD_ID,
  ADMIN_CHANNEL_ID: process.env.ADMIN_CHANNEL_ID,
  ADMIN_USER_ID: process.env.ADMIN_USER_ID,
  OVERSEERR_URL: (process.env.OVERSEERR_URL || '').replace(/\/$/, ''),
  OVERSEERR_API_KEY: process.env.OVERSEERR_API_KEY,
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
  STUCK_CHECK_MINUTES: Number.parseInt(process.env.STUCK_CHECK_MINUTES || '10', 10),
  STUCK_AFTER_MINUTES: Number.parseInt(process.env.STUCK_AFTER_MINUTES || '45', 10),
  STUCK_ALERT_COOLDOWN_HOURS: Number.parseInt(process.env.STUCK_ALERT_COOLDOWN_HOURS || '6', 10),
  // AvistaZ private-tracker fallback: tag-gated escalation of stalled requests (see README).
  // Radarr/Sonarr lowercase tag labels, so the compare key is lowercased here too.
  AVISTAZ_TAG: (process.env.AVISTAZ_TAG || 'avistaz').toLowerCase(),
  ESCALATION_ENABLED: parseBool(process.env.ESCALATION_ENABLED, false),
  ESCALATION_DELAY_HOURS: Number.parseInt(process.env.ESCALATION_DELAY_HOURS || '6', 10),
  ESCALATION_CHECK_MINUTES: Number.parseInt(process.env.ESCALATION_CHECK_MINUTES || '30', 10),
  ESCALATION_MAX_AGE_DAYS: Number.parseInt(process.env.ESCALATION_MAX_AGE_DAYS || '14', 10),
  JANITOR_CHECK_MINUTES: Number.parseInt(process.env.JANITOR_CHECK_MINUTES || '60', 10),
  RETENTION_ENFORCEMENT: parseBool(process.env.RETENTION_ENFORCEMENT, false),
  RETENTION_CHECK_HOURS: Number.parseInt(process.env.RETENTION_CHECK_HOURS || '24', 10),
  RETENTION_MAX_DELETES_PER_RUN: Number.parseInt(process.env.RETENTION_MAX_DELETES_PER_RUN || '10', 10),
  DISK_SPACE_WARN_GB: Number.parseInt(process.env.DISK_SPACE_WARN_GB || '100', 10),
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
  REQUESTS_CHANNEL_ID: process.env.REQUESTS_CHANNEL_ID || '',
  SYSTEM_ALERTS_CHANNEL_ID: process.env.SYSTEM_ALERTS_CHANNEL_ID || '',
  DOWNLOADS_CHANNEL_ID: process.env.DOWNLOADS_CHANNEL_ID || '',
  PLAYBACK_CHANNEL_ID: process.env.PLAYBACK_CHANNEL_ID || '',
  CLEANUP_CHANNEL_ID: process.env.CLEANUP_CHANNEL_ID || '',
  AUDIT_CHANNEL_ID: process.env.AUDIT_CHANNEL_ID || '',
  DEPLOY_CHANNEL_ID: process.env.DEPLOY_CHANNEL_ID || '',
  PORT: Number.parseInt(process.env.PORT || '3000', 10),
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
  DELETION_GRACE_HOURS: Number.parseInt(process.env.DELETION_GRACE_HOURS || '24', 10),
  DELETION_REMINDER_COOLDOWN_HOURS: Number.parseInt(process.env.DELETION_REMINDER_COOLDOWN_HOURS || '12', 10),
  KEEP_LIST_DEFAULT_DAYS: Number.parseInt(process.env.KEEP_LIST_DEFAULT_DAYS || '90', 10),
  NEVER_DELETE_MEDIA_IDS: process.env.NEVER_DELETE_MEDIA_IDS ? process.env.NEVER_DELETE_MEDIA_IDS.split(',').map(s => s.trim()) : [],
};

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
}

// Non-fatal sanity checks for risky-but-valid configurations. Logged at startup and posted once
// to the system channel after connect, so a dangerous combo can't sit unnoticed.
function configWarnings() {
  const warnings = [];
  if (CONFIG.TUNNEL_DOMAIN && !CONFIG.WEBHOOK_SECRET) {
    warnings.push('`WEBHOOK_SECRET` is blank while `TUNNEL_DOMAIN` is set — the Seerr/Plex webhook endpoints are reachable from the internet without authentication.');
  }
  if (CONFIG.ENABLE_DELETION && !CONFIG.DELETION_DRY_RUN) {
    warnings.push('Deletion is **live** (`ENABLE_DELETION=true`, `DELETION_DRY_RUN=false`) — the janitor and retention rules will delete real files.');
  }
  const dashSecret = CONFIG.DASHBOARD_ADMIN_PASSWORD || CONFIG.DASHBOARD_ADMIN_TOKEN;
  if (CONFIG.DASHBOARD_ENABLED && dashSecret && dashSecret.length < 12) {
    warnings.push('The dashboard password/token is under 12 characters — use a longer one (login is internet-reachable if your tunnel exposes it).');
  }
  if (CONFIG.PLAYBACK_CHECK_MINUTES > 0 && CONFIG.PLAYBACK_CHANNEL_ID && !(CONFIG.TAUTULLI_URL && CONFIG.TAUTULLI_API_KEY)) {
    warnings.push('`PLAYBACK_CHANNEL_ID` is set but Tautulli isn\'t configured (`TAUTULLI_URL` + `TAUTULLI_API_KEY`) — no playback alerts will be sent.');
  }
  if (CONFIG.ESCALATION_ENABLED && !CONFIG.RADARR_URL && !CONFIG.SONARR_URL) {
    warnings.push('`ESCALATION_ENABLED=true` but neither Radarr nor Sonarr is configured — AvistaZ escalation can never fire.');
  }
  return warnings;
}

module.exports = { parseBool, CONFIG, REQUIRED_ENV, validateConfig, configWarnings };
