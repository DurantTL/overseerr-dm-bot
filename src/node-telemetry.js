function boundedNumber(value, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === null || value === undefined || typeof value === 'boolean') return null;
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= min && number <= max ? number : null;
}

function temperatureKind(value, source) {
  if (value === 'cpu' || value === 'unclassified') return value;
  return /(?:cpu|core|package|x86_pkg_temp|coretemp|k10temp|zenpower|soc)/i.test(String(source || ''))
    ? 'cpu'
    : 'unclassified';
}

function sanitizeNodeTelemetry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const value = {
    collectedAt: boundedNumber(raw.collectedAt, { min: 0 }),
    temperatureC: boundedNumber(raw.temperatureC, { min: -20, max: 150 }),
    temperatureSource: String(raw.temperatureSource || '').slice(0, 80) || null,
    temperatureKind: null,
    load1: boundedNumber(raw.load1, { max: 10000 }),
    load5: boundedNumber(raw.load5, { max: 10000 }),
    load15: boundedNumber(raw.load15, { max: 10000 }),
    cpuCount: boundedNumber(raw.cpuCount, { min: 1, max: 4096 }),
    memoryTotalBytes: boundedNumber(raw.memoryTotalBytes),
    memoryFreeBytes: boundedNumber(raw.memoryFreeBytes),
    uptimeSeconds: boundedNumber(raw.uptimeSeconds),
    filesystemTotalBytes: boundedNumber(raw.filesystemTotalBytes),
    filesystemFreeBytes: boundedNumber(raw.filesystemFreeBytes),
  };
  value.temperatureKind = value.temperatureC == null ? null : temperatureKind(raw.temperatureKind, value.temperatureSource);
  return Object.values(value).some(item => item !== null) ? value : null;
}

// Hysteresis: a temperature riding right at a threshold (say 79-81°C against an 80°C warn line)
// would otherwise flip level, and therefore alert, on every single report for hours. Once a level
// has been entered, clearing it requires dropping clearMarginC below its threshold rather than
// just ticking back under it — the classic Schmitt-trigger fix for flapping near a boundary.
// previousLevel is the level the node was last recorded at (e.g. tier plan's lastTelemetryLevel);
// omit it (or pass 'unknown') for a one-off, stateless read.
const TELEMETRY_STALE_AFTER_MS = 12 * 3600000;

function telemetryAge(telemetry, now = Date.now()) {
  const collectedAt = telemetry?.collectedAt;
  if (!Number.isFinite(collectedAt)) return null;
  return Math.max(0, now - collectedAt);
}

function temperatureLabel(telemetry) {
  return telemetry?.temperatureKind === 'cpu' ? 'CPU temperature' : 'Temperature';
}

function assessNodeTelemetry(telemetry, {
  warnC = 80,
  criticalC = 90,
  clearMarginC = 5,
  previousLevel = 'unknown',
  now = Date.now(),
  staleAfterMs = TELEMETRY_STALE_AFTER_MS,
} = {}) {
  const temp = telemetry?.temperatureC;
  if (temp == null) return { level: 'unknown', reason: 'temperature unavailable' };
  const ageMs = telemetryAge(telemetry, now);
  if (ageMs == null) return { level: 'unknown', reason: 'temperature collection time unavailable' };
  if (ageMs > staleAfterMs) return { level: 'unknown', reason: `temperature reading is stale (${formatTelemetryAge(ageMs)} old)` };
  const label = temperatureLabel(telemetry);
  if (temp >= criticalC) return { level: 'critical', reason: `${label} ${temp.toFixed(1)}°C is at or above ${criticalC}°C` };
  const criticalClearC = criticalC - clearMarginC;
  if (previousLevel === 'critical' && temp >= criticalClearC) {
    return { level: 'critical', reason: `${label} ${temp.toFixed(1)}°C is still near critical (below ${criticalC}°C but above the ${criticalClearC}°C clear point)` };
  }
  if (temp >= warnC) return { level: 'warn', reason: `${label} ${temp.toFixed(1)}°C is at or above ${warnC}°C` };
  const warnClearC = warnC - clearMarginC;
  if ((previousLevel === 'warn' || previousLevel === 'critical') && temp >= warnClearC) {
    return { level: 'warn', reason: `${label} ${temp.toFixed(1)}°C is still elevated (below ${warnC}°C but above the ${warnClearC}°C clear point)` };
  }
  return { level: 'ok', reason: `${label} ${temp.toFixed(1)}°C` };
}

function formatTelemetryAge(ageMs) {
  if (ageMs < 60000) return 'less than a minute';
  if (ageMs < 3600000) return `${Math.floor(ageMs / 60000)}m`;
  if (ageMs < 86400000) return `${(ageMs / 3600000).toFixed(ageMs < 10 * 3600000 ? 1 : 0)}h`;
  return `${(ageMs / 86400000).toFixed(1)}d`;
}

function telemetrySummary(telemetry, fmtSpace = value => `${value} B`, { now = Date.now(), staleAfterMs = TELEMETRY_STALE_AFTER_MS } = {}) {
  if (!telemetry) return 'hardware telemetry unavailable';
  const memoryUsed = telemetry.memoryTotalBytes != null && telemetry.memoryFreeBytes != null
    ? Math.max(0, telemetry.memoryTotalBytes - telemetry.memoryFreeBytes) : null;
  const memoryPct = memoryUsed != null && telemetry.memoryTotalBytes ? Math.round(memoryUsed / telemetry.memoryTotalBytes * 100) : null;
  const diskPct = telemetry.filesystemFreeBytes != null && telemetry.filesystemTotalBytes
    ? Math.round(telemetry.filesystemFreeBytes / telemetry.filesystemTotalBytes * 100) : null;
  const ageMs = telemetryAge(telemetry, now);
  const freshness = ageMs == null ? 'sample age unavailable' : `sample ${formatTelemetryAge(ageMs)} old${ageMs > staleAfterMs ? ' (stale)' : ''}`;
  const temperature = telemetry.temperatureC != null
    ? `${telemetry.temperatureC.toFixed(1)}°C ${telemetry.temperatureKind === 'cpu' ? 'CPU' : 'unclassified'}${telemetry.temperatureSource ? ` (${telemetry.temperatureSource})` : ''}`
    : 'temperature unavailable';
  return [
    temperature,
    telemetry.load1 != null ? `load ${telemetry.load1.toFixed(2)}${telemetry.cpuCount ? `/${telemetry.cpuCount} CPU` : ''}` : null,
    memoryPct != null ? `RAM ${memoryPct}% used` : null,
    diskPct != null ? `${fmtSpace(telemetry.filesystemFreeBytes)} disk free (${diskPct}%)` : null,
    telemetry.uptimeSeconds != null ? `uptime ${Math.floor(telemetry.uptimeSeconds / 3600)}h` : null,
    freshness,
  ].filter(Boolean).join(' · ');
}

const REBUILD_UPTIME_THRESHOLD_SECONDS = 3 * 3600;

// A freshly (re)built node or one still catching up on its first Syncthing sync runs hot and slow
// for a while — that's expected, not a fault. Surface it as context on hardware/report alerts so a
// spike right after a rebuild doesn't read as an unexplained problem.
function nodeUptimeHint(telemetry) {
  const uptime = telemetry?.uptimeSeconds;
  if (uptime == null || uptime >= REBUILD_UPTIME_THRESHOLD_SECONDS) return null;
  const age = uptime < 3600 ? `${Math.max(1, Math.round(uptime / 60))}m` : `${(uptime / 3600).toFixed(1)}h`;
  return `🔧 Node has only been up ${age} — likely still rebuilding or catching up on its initial Syncthing sync. Elevated load, temperature, and slower reports are expected until it settles.`;
}

module.exports = {
  TELEMETRY_STALE_AFTER_MS,
  sanitizeNodeTelemetry,
  assessNodeTelemetry,
  telemetrySummary,
  telemetryAge,
  nodeUptimeHint,
};
