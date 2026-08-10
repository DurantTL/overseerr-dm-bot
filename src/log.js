// Console logger shared by every module. Level filtering and JSON output are configured via
// LOG_LEVEL/LOG_FORMAT (see src/config.js); invalid values are warned about at startup
// (configWarnings) and fall back to the safe defaults ('info'/'text') here too.
const { CONFIG } = require('./config');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[CONFIG.LOG_LEVEL] ?? LEVELS.info;
const jsonOutput = CONFIG.LOG_FORMAT === 'json';

function serialize(args) {
  return args.map(a => {
    if (typeof a === 'string') return a;
    if (a instanceof Error) return a.stack || a.message;
    try { return JSON.stringify(a); } catch (_e) { return String(a); }
  }).join(' ');
}

// `label` is the human-readable tag ('OK' reads better than 'INFO' for success lines); `level`
// is what actually gets filtered and reported in JSON mode.
function emit(level, label, consoleFn, args) {
  if (LEVELS[level] < threshold) return;
  if (jsonOutput) {
    consoleFn(JSON.stringify({ ts: new Date().toISOString(), level, msg: serialize(args) }));
  } else {
    consoleFn(`[${label}]`, ...args);
  }
}

const log = {
  debug: (...a) => emit('debug', 'DEBUG', console.log, a),
  info: (...a) => emit('info', 'INFO', console.log, a),
  ok: (...a) => emit('info', 'OK', console.log, a),
  warn: (...a) => emit('warn', 'WARN', console.warn, a),
  error: (...a) => emit('error', 'ERROR', console.error, a),
};

module.exports = { log };
