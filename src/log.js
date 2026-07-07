// Console logger shared by every module.

const log = {
  info: (...a) => console.log('[INFO]', ...a),
  ok: (...a) => console.log('[OK]', ...a),
  warn: (...a) => console.warn('[WARN]', ...a),
  error: (...a) => console.error('[ERROR]', ...a),
};

module.exports = { log };
