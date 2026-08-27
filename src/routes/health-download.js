const fs = require('fs');
const path = require('path');
const { rateLimit } = require('express-rate-limit');
const { SqliteRollingWindowStore } = require('../rate-limit');

function registerHealthAndDownloadRoutes(app, {
  config,
  db,
  gatherHealth,
  httpRateLimitKey,
  cleanExpiredTokens,
  getDownloadRecordByRawToken,
  sha256,
  resolveSafeMediaPath,
  notifyChannel,
  mimeFor,
  audit,
  fileSystem = fs,
  downloadLimiter,
}) {
  let publicHealthCache = { at: 0, value: null, pending: null };

  app.get('/live', (_req, res) => res.json({ overall: 'ok', timestamp: new Date().toISOString() }));
  app.get('/health', async (_req, res) => {
    try {
      if (publicHealthCache.value && Date.now() - publicHealthCache.at < 30000) {
        return res.status(publicHealthCache.value.overall === 'ok' ? 200 : 503).json(publicHealthCache.value);
      }
      publicHealthCache.pending ||= gatherHealth().then(value => {
        const publicValue = { ...value };
        delete publicValue.errors;
        publicHealthCache = { at: Date.now(), value: publicValue, pending: null };
        return publicValue;
      }).catch(err => {
        publicHealthCache.pending = null;
        throw err;
      });
      const value = await publicHealthCache.pending;
      return res.status(value.overall === 'ok' ? 200 : 503).json(value);
    } catch (err) {
      return res.status(503).json({ overall: 'down', error: err.message });
    }
  });

  const limiter = downloadLimiter || rateLimit({
    windowMs: 60000,
    limit: config.DOWNLOAD_ROUTE_MAX_PER_MINUTE,
    keyGenerator: httpRateLimitKey,
    store: new SqliteRollingWindowStore({
      db, scope: 'download-route', limit: config.DOWNLOAD_ROUTE_MAX_PER_MINUTE, windowMs: 60000,
    }),
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, res) => res.status(429).send('Too many requests.'),
  });

  app.get('/download/:token', limiter, async (req, res) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    cleanExpiredTokens();
    const record = getDownloadRecordByRawToken(req.params.token);
    if (!record || record.revoked) {
      db.prepare('INSERT INTO download_access_log (token_hash, ip, user_agent, status) VALUES (?, ?, ?, ?)').run(sha256(req.params.token), ip, req.get('user-agent') || '', 'not_found_or_revoked');
      return res.status(404).send('Link not found or revoked.');
    }
    if (Date.now() > record.expires_at) return res.status(410).send('This download link has expired.');
    if (record.one_time_use && record.used_at) return res.status(410).send('This one-time link has already been used.');

    const candidatePath = path.resolve(record.file_path);
    if (!fileSystem.existsSync(candidatePath)) return res.status(404).send('File not found on server.');

    let filePath;
    try {
      filePath = resolveSafeMediaPath(candidatePath);
    } catch (_e) {
      db.prepare('INSERT INTO download_access_log (token_hash, discord_id, ip, user_agent, file_path, status) VALUES (?, ?, ?, ?, ?, ?)').run(record.token_hash, record.discord_id, ip, req.get('user-agent') || '', record.file_path, 'invalid_path');
      return res.status(403).send('Invalid file path.');
    }

    const stat = fileSystem.statSync(filePath);
    if (stat.size >= config.DOWNLOAD_LARGE_FILE_GB * 1024 * 1024 * 1024) {
      notifyChannel('downloads', `📥 Large download started by <@${record.discord_id}>: ${record.title} (${(stat.size / (1024 ** 3)).toFixed(2)} GB)`);
    }

    if (record.one_time_use) {
      db.prepare('UPDATE download_tokens SET used_at = ? WHERE token_hash = ?').run(Date.now(), record.token_hash);
    }

    const fileSize = stat.size;
    const fileName = path.basename(filePath);
    const mimeType = mimeFor(path.extname(filePath).toLowerCase());

    res.on('finish', () => {
      db.prepare('INSERT INTO download_access_log (token_hash, discord_id, ip, user_agent, file_path, status, bytes_sent) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(record.token_hash, record.discord_id, ip, req.get('user-agent') || '', filePath, `http_${res.statusCode}`, Number(res.getHeader('Content-Length')) || 0);
      audit('download_completed_or_failed', { targetDiscordId: record.discord_id, title: record.title, status: res.statusCode });
    });

    const range = req.headers.range;
    db.prepare('INSERT INTO download_access_log (token_hash, discord_id, ip, user_agent, file_path, status) VALUES (?, ?, ?, ?, ?, ?)').run(record.token_hash, record.discord_id, ip, req.get('user-agent') || '', filePath, 'download_started');
    audit('download_started', { targetDiscordId: record.discord_id, title: record.title });

    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
      let start; let end;
      if (m && m[1] === '' && m[2] !== '') {
        start = Math.max(fileSize - Number.parseInt(m[2], 10), 0);
        end = fileSize - 1;
      } else {
        start = m && m[1] !== '' ? Number.parseInt(m[1], 10) : NaN;
        end = m && m[2] !== '' ? Math.min(Number.parseInt(m[2], 10), fileSize - 1) : fileSize - 1;
      }
      if (!m || Number.isNaN(start) || start > end || start >= fileSize) {
        res.writeHead(416, { 'Content-Range': `bytes */${fileSize}` });
        return res.end();
      }
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
        'Content-Type': mimeType,
        'Content-Disposition': `attachment; filename="${fileName}"`,
      });
      fileSystem.createReadStream(filePath, { start, end }).pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Length': fileSize,
        'Content-Type': mimeType,
        'Accept-Ranges': 'bytes',
        'Content-Disposition': `attachment; filename="${fileName}"`,
      });
      fileSystem.createReadStream(filePath).pipe(res);
    }
  });
}

module.exports = { registerHealthAndDownloadRoutes };
