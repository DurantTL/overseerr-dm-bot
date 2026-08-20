// Read-only Main → edge-path diagnostics. No command in this module copies,
// purges, syncs, or edits remote state; it is safe to run during an incident or before rollout.
const fs = require('fs');
const { spawn } = require('child_process');
const axios = require('axios');
const { CONFIG } = require('./config');

function run(command, args, timeoutMs = 15000) {
  return new Promise(resolve => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = ''; let timedOut = false;
    child.stdout.on('data', d => { stdout = (stdout + d).slice(-65536); });
    child.stderr.on('data', d => { stderr = (stderr + d).slice(-4000); });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    timer.unref();
    child.on('error', err => { clearTimeout(timer); resolve({ ok: false, error: err.message }); });
    child.on('close', code => {
      clearTimeout(timer);
      resolve({ ok: code === 0 && !timedOut, code, stdout: stdout.trim(), stderr: stderr.trim(), timedOut });
    });
  });
}

function check(name, status, detail) { return { name, status, detail }; }

async function runEdgeDiagnostics({ live = true } = {}) {
  const checks = [];
  checks.push(check('Staging switch', CONFIG.STAGING_ENABLED ? 'ok' : 'warn', CONFIG.STAGING_ENABLED ? 'enabled' : 'disabled'));
  checks.push(check('Philippines identity', CONFIG.PH_SERVER_NAMES.length ? 'ok' : 'fail', CONFIG.PH_SERVER_NAMES.length ? `${CONFIG.PH_SERVER_NAMES.length} server identity value(s)` : 'PH_SERVER_NAMES is empty'));
  checks.push(check('California edge identity', CONFIG.CA_EDGE_SERVER_NAMES.length ? 'ok' : 'warn', CONFIG.CA_EDGE_SERVER_NAMES.length ? `${CONFIG.CA_EDGE_SERVER_NAMES.length} server identity value(s)` : 'CA_EDGE_SERVER_NAMES is empty; California playback cannot be isolated from full Main storage'));
  checks.push(check('Full Main identity', CONFIG.PRIMARY_SERVER_NAMES.length ? 'ok' : 'warn', CONFIG.PRIMARY_SERVER_NAMES.length ? `${CONFIG.PRIMARY_SERVER_NAMES.length} server identity value(s)` : 'PRIMARY_SERVER_NAMES is empty; any named non-edge server is treated as full Main storage'));
  const all = [
    ['Philippines', CONFIG.PH_SERVER_NAMES],
    ['California edge', CONFIG.CA_EDGE_SERVER_NAMES],
    ['full Main', CONFIG.PRIMARY_SERVER_NAMES],
  ];
  const overlap = [];
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      const shared = all[i][1].filter(id => all[j][1].includes(id));
      if (shared.length) overlap.push(`${all[i][0]} / ${all[j][0]}: ${shared.join(', ')}`);
    }
  }
  checks.push(check('Identity separation', overlap.length ? 'fail' : 'ok', overlap.length ? overlap.join('; ') : 'Philippines, California edge, and full Main identity lists do not overlap'));
  checks.push(check('Cache layout', CONFIG.STAGE_MOVIES_SUBDIR && CONFIG.STAGE_TV_SUBDIR ? 'ok' : 'fail', `movies=${CONFIG.STAGE_MOVIES_SUBDIR || '(empty)'}, tv=${CONFIG.STAGE_TV_SUBDIR || '(empty)'}`));

  const sourceRoot = CONFIG.TIER_SOURCE_ROOT || CONFIG.PATH_REMAP_TO || CONFIG.RAID_PATH;
  try {
    fs.accessSync(sourceRoot, fs.constants.R_OK);
    checks.push(check('Main source', 'ok', `${sourceRoot} is readable`));
  } catch (err) {
    checks.push(check('Main source', 'fail', `${sourceRoot} is not readable: ${err.code || err.message}`));
  }

  if (!CONFIG.STAGE_RCLONE_REMOTE) {
    checks.push(check('Philippines transfer destination', 'fail', 'STAGE_RCLONE_REMOTE is empty'));
  } else {
    const remoteName = (CONFIG.STAGE_RCLONE_REMOTE.match(/^([^:]+):/) || [])[1];
    checks.push(check('Philippines transfer destination', remoteName ? 'ok' : 'warn', remoteName ? `rclone remote '${remoteName}' configured` : 'destination is not an rclone remote'));
  }

  if (!live) return checks;

  const version = await run(CONFIG.STAGE_RCLONE_BINARY, ['version', ...CONFIG.STAGE_RCLONE_FLAGS]);
  checks.push(check('rclone binary', version.ok ? 'ok' : 'fail', version.ok ? (version.stdout.split('\n')[0] || 'available') : (version.error || version.stderr || 'unavailable')));

  if (version.ok && CONFIG.STAGE_RCLONE_REMOTE) {
    // Ask rclone about the configured staging path, not merely the remote root. With SFTP the
    // cache may live on a separately mounted filesystem (for example /mnt/media), while phbox:
    // itself reports the server's OS disk. The safety check and /doctor must measure the same disk.
    const aboutTarget = CONFIG.STAGE_RCLONE_REMOTE;
    const about = await run(CONFIG.STAGE_RCLONE_BINARY, ['about', aboutTarget, '--json', ...CONFIG.STAGE_RCLONE_FLAGS], 30000);
    if (about.ok) {
      try {
        const info = JSON.parse(about.stdout);
        const gb = n => typeof n === 'number' ? `${(n / 1024 ** 3).toFixed(1)} GB` : 'unknown';
        checks.push(check('Philippines free space', 'ok', `${gb(info.free)} free of ${gb(info.total)}`));
      } catch (_err) {
        checks.push(check('Philippines free space', 'warn', 'rclone about returned non-JSON output'));
      }
    } else {
      checks.push(check('Philippines free space', CONFIG.STAGE_CACHE_MAX_GB > 0 ? 'warn' : 'fail', about.stderr || `rclone about exited ${about.code}`));
    }

    const listing = await run(CONFIG.STAGE_RCLONE_BINARY, ['lsjson', '--max-depth', '1', CONFIG.STAGE_RCLONE_REMOTE, ...CONFIG.STAGE_RCLONE_FLAGS], 30000);
    if (listing.ok) {
      try {
        const entries = JSON.parse(listing.stdout || '[]');
        checks.push(check('Philippines cache read', 'ok', `${entries.length} top-level entr${entries.length === 1 ? 'y' : 'ies'} visible`));
      } catch (_err) {
        checks.push(check('Philippines cache read', 'fail', 'cache listing was not valid JSON'));
      }
    } else {
      checks.push(check('Philippines cache read', 'fail', listing.error || listing.stderr || `rclone lsjson exited ${listing.code}`));
    }
  }

  if (!CONFIG.PH_TUNNEL_HEALTH_URL) {
    checks.push(check('Philippines tunnel', 'warn', 'PH_TUNNEL_HEALTH_URL is empty'));
  } else {
    const tunnel = await axios.get(CONFIG.PH_TUNNEL_HEALTH_URL, { timeout: 10000, validateStatus: () => true })
      .then(res => ({ ok: true, status: res.status }))
      .catch(err => ({ ok: false, error: err.code || err.message }));
    checks.push(check('Philippines tunnel', tunnel.ok ? 'ok' : 'fail', tunnel.ok ? `answered HTTP ${tunnel.status}` : tunnel.error));
  }
  return checks;
}

module.exports = { runEdgeDiagnostics };
