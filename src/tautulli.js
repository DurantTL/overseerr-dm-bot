// Tautulli API: live Plex session activity for /watching and the transcode watchdog.
const axios = require('axios');
const { CONFIG } = require('./config');

// ---- Tautulli (playback visibility) ----
const tautulliConfigured = () => !!(CONFIG.TAUTULLI_URL && CONFIG.TAUTULLI_API_KEY);

async function tautulliApi(cmd, params = {}) {
  const res = await axios.get(`${CONFIG.TAUTULLI_URL}/api/v2`, {
    params: { apikey: CONFIG.TAUTULLI_API_KEY, cmd, ...params },
    timeout: 10000,
  });
  if (res.data?.response?.result !== 'success') throw new Error(res.data?.response?.message || `Tautulli ${cmd} failed`);
  return res.data.response.data;
}

// One line per active Plex session, shared by /watching and the transcode sweep.
function describeSession(s) {
  const decision = s.video_decision === 'transcode' ? '🔥 Transcoding'
    : s.transcode_decision === 'copy' ? '📼 Direct Stream'
    : '▶️ Direct Play';
  const res = s.video_full_resolution || s.stream_video_full_resolution || '';
  const streamRes = s.stream_video_full_resolution || '';
  const quality = s.video_decision === 'transcode' && res && streamRes && res !== streamRes ? `${res} → ${streamRes}` : (streamRes || res);
  const pct = s.progress_percent ? ` (${s.progress_percent}%)` : '';
  return `• **${s.friendly_name || s.user || 'Unknown'}** — ${s.full_title || 'Unknown'} — ${decision}${quality ? ` — ${quality}` : ''}${pct}`;
}

module.exports = { tautulliConfigured, tautulliApi, describeSession };
