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

// Compact per-drive SMART health as reported by the agent: at most 8 drives, each a
// {device, health} pair where health is strictly 'ok' or 'failing'. Anything else
// (absent smartctl, unreadable device, unexpected shape) is dropped — a missing
// reading is null, never a guess.
function sanitizeSmartHealth(raw) {
  if (!Array.isArray(raw)) return null;
  const out = [];
  for (const entry of raw.slice(0, 8)) {
    if (!entry || typeof entry !== 'object') continue;
    const device = String(entry.device || '').slice(0, 80);
    const health = entry.health === 'ok' || entry.health === 'failing' ? entry.health : null;
    if (!device || !health) continue;
    out.push({ device, health });
  }
  return out.length ? out : null;
}

// The agent's full sensor list (additive alongside temperatureC): at most 32 entries, each with
// a label, kind and a temperature inside the same -20..150°C window the agent applies. Kept in the
// order sent (CPU first, then hottest). Not an array = not reported (null, an older agent).
function sanitizeTemperatures(raw) {
  if (!Array.isArray(raw)) return null;
  const out = [];
  for (const entry of raw.slice(0, 32)) {
    if (!entry || typeof entry !== 'object') continue;
    const temperatureC = boundedNumber(entry.temperatureC, { min: -20, max: 150 });
    if (temperatureC == null) continue;
    const label = String(entry.label || '').slice(0, 80) || null;
    out.push({ label, kind: temperatureKind(entry.kind, label), temperatureC });
  }
  return out;
}

// Fan speeds as the host exposes them. An empty list is a real answer (no fan exposed, e.g. the
// PH NUC) and is kept as []; not an array = not reported.
function sanitizeFans(raw) {
  if (!Array.isArray(raw)) return null;
  const out = [];
  for (const entry of raw.slice(0, 16)) {
    if (!entry || typeof entry !== 'object') continue;
    const rpm = boundedNumber(entry.rpm, { min: 0, max: 100000 });
    if (rpm == null) continue;
    out.push({ label: String(entry.label || '').slice(0, 80) || null, rpm: Math.round(rpm) });
  }
  return out;
}

// One entry per drive read; temperatureC null when that drive gave no reading.
function sanitizeDriveTemperatures(raw) {
  if (!Array.isArray(raw)) return null;
  const out = [];
  for (const entry of raw.slice(0, 8)) {
    if (!entry || typeof entry !== 'object') continue;
    const device = String(entry.device || '').slice(0, 80);
    if (!device) continue;
    out.push({ device, temperatureC: boundedNumber(entry.temperatureC, { min: -20, max: 150 }) });
  }
  return out;
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
    smartHealth: sanitizeSmartHealth(raw.smartHealth),
    temperatures: sanitizeTemperatures(raw.temperatures),
    fans: sanitizeFans(raw.fans),
    driveTemperatures: sanitizeDriveTemperatures(raw.driveTemperatures),
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

// Sustained confirmation for temperature alerts. assessNodeTelemetry judges one sample; a node only
// moves UP a level (ok -> warn, warn -> critical) once this many consecutive samples are at or
// above that level's line. At the agent's ~15-minute cadence, 2 samples is about 30 minutes, so
// a single spike is recorded and shown but never alerts. Moving down (clearing, or critical ->
// warn) is unchanged: immediate, using assessNodeTelemetry's hysteresis clear points.
const SUSTAINED_TEMPERATURE_SAMPLES = 2;

const LEVEL_RANK = { unknown: 0, ok: 0, warn: 1, critical: 2 };

// raw = assessNodeTelemetry(telemetry, { previousLevel }) for this sample. previousLevel is the
// node's confirmed (alerted) level; previousStreak counts consecutive samples at/above each line.
// Returns the confirmed { level, reason } plus the streak to store and, while an escalation is
// waiting for confirmation, pendingLevel.
function confirmTelemetryLevel(telemetry, raw, {
  previousLevel = 'unknown',
  previousStreak = null,
  warnC = 80,
  required = SUSTAINED_TEMPERATURE_SAMPLES,
} = {}) {
  const rank = LEVEL_RANK[raw.level] ?? 0;
  const prev = previousStreak && typeof previousStreak === 'object' ? previousStreak : {};
  const streak = {
    warn: rank >= 1 ? (Number(prev.warn) || 0) + 1 : 0,
    critical: rank >= 2 ? (Number(prev.critical) || 0) + 1 : 0,
  };
  const prevRank = LEVEL_RANK[previousLevel] ?? 0;
  if (rank <= prevRank) return { level: raw.level, reason: raw.reason, streak, pendingLevel: null };
  if (raw.level === 'critical' && streak.critical >= required) {
    return { level: 'critical', reason: `${raw.reason} (${streak.critical} readings in a row)`, streak, pendingLevel: null };
  }
  if (prevRank < 1 && streak.warn >= required) {
    const temp = telemetry?.temperatureC;
    const reason = raw.level === 'warn'
      ? `${raw.reason} (${streak.warn} readings in a row)`
      : `${temperatureLabel(telemetry)} ${Number(temp).toFixed(1)}°C — at or above ${warnC}°C for ${streak.warn} readings in a row`;
    return { level: 'warn', reason, streak, pendingLevel: raw.level === 'critical' ? 'critical' : null };
  }
  const needed = raw.level === 'critical' ? streak.critical : streak.warn;
  return {
    level: previousLevel,
    reason: `${raw.reason} — reading ${needed} of ${required} needed before it alerts`,
    streak,
    pendingLevel: raw.level,
  };
}

function formatTelemetryAge(ageMs) {
  if (ageMs < 60000) return 'less than a minute';
  if (ageMs < 3600000) return `${Math.floor(ageMs / 60000)}m`;
  if (ageMs < 86400000) return `${(ageMs / 3600000).toFixed(ageMs < 10 * 3600000 ? 1 : 0)}h`;
  return `${(ageMs / 86400000).toFixed(1)}d`;
}

// Free-space assessment, mirroring assessNodeTelemetry's Schmitt-trigger hysteresis but
// inverted: lower free % is worse. Thresholds are free-space percentages (warn when at or
// below warnFreePct, urgent at or below urgentFreePct). Once a level is entered, leaving
// it requires rising clearMarginPct above its line, so a disk riding the boundary doesn't
// flap alerts on every sweep.
function assessDiskLevel({ freeBytes, totalBytes }, {
  warnFreePct = 15,
  urgentFreePct = 8,
  clearMarginPct = 3,
  previousLevel = 'unknown',
} = {}) {
  const total = Number(totalBytes);
  // null/undefined free space means "unreadable" — it must not coerce to 0 (Number(null))
  // and page as urgent; only a real reading of 0 is an emergency.
  const free = freeBytes == null ? NaN : Number(freeBytes);
  if (!(total > 0) || !(free >= 0) || free > total) return { level: 'unknown', reason: 'disk size unavailable', freePct: null };
  const freePct = (free / total) * 100;
  const label = `${freePct.toFixed(1)}% free`;
  if (freePct <= urgentFreePct) return { level: 'urgent', reason: `only ${label} — at or below the ${urgentFreePct}% urgent line`, freePct };
  const urgentClearPct = urgentFreePct + clearMarginPct;
  if (previousLevel === 'urgent' && freePct <= urgentClearPct) {
    return { level: 'urgent', reason: `still only ${label} (below the ${urgentClearPct}% clear point)`, freePct };
  }
  if (freePct <= warnFreePct) return { level: 'warn', reason: `only ${label} — at or below the ${warnFreePct}% warning line`, freePct };
  const warnClearPct = warnFreePct + clearMarginPct;
  if ((previousLevel === 'warn' || previousLevel === 'urgent') && freePct <= warnClearPct) {
    return { level: 'warn', reason: `still only ${label} (below the ${warnClearPct}% clear point)`, freePct };
  }
  return { level: 'ok', reason: `${label} free`, freePct };
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

// The fuller readings for a node's detail line: every kept sensor (short label, no sysfs path),
// fans and drive temperatures, each only when the node reported them. null when there is nothing
// beyond the summary. Plain text, so it reads the same on a phone.
function shortSensorLabel(label) {
  return String(label || 'sensor').replace(/\s*\([^)]*\)\s*$/, '').trim() || String(label || 'sensor');
}

function telemetryDetail(telemetry, { maxSensors = 8 } = {}) {
  if (!telemetry) return null;
  const parts = [];
  const temps = Array.isArray(telemetry.temperatures) ? telemetry.temperatures : [];
  if (temps.length) {
    const shown = temps.slice(0, maxSensors).map(t => `${shortSensorLabel(t.label)} ${t.temperatureC.toFixed(1)}°C`);
    parts.push(`sensors: ${shown.join(', ')}${temps.length > maxSensors ? ` +${temps.length - maxSensors} more` : ''}`);
  }
  if (Array.isArray(telemetry.fans) && telemetry.fans.length) {
    parts.push(`fans: ${telemetry.fans.map(f => `${shortSensorLabel(f.label)} ${f.rpm} RPM`).join(', ')}`);
  }
  if (Array.isArray(telemetry.driveTemperatures) && telemetry.driveTemperatures.length) {
    parts.push(`drives: ${telemetry.driveTemperatures.map(d => `${d.device} ${d.temperatureC == null ? 'n/a' : `${d.temperatureC}°C`}`).join(', ')}`);
  }
  return parts.length ? parts.join(' · ') : null;
}

// While a temperature escalation waits for confirmation, say so: the reading is real and shown,
// it just hasn't alerted yet. null when nothing is pending.
function pendingTemperatureNote(plan, { warnC = 80, criticalC = 90, required = SUSTAINED_TEMPERATURE_SAMPLES } = {}) {
  const streak = plan?.lastTelemetryStreak;
  const level = plan?.lastTelemetryLevel || 'unknown';
  if (!streak) return null;
  if (level !== 'critical' && streak.critical > 0 && streak.critical < required) return `at or above ${criticalC}°C for ${streak.critical} reading(s); alerts after ${required} in a row`;
  if (level !== 'warn' && level !== 'critical' && streak.warn > 0 && streak.warn < required) return `at or above ${warnC}°C for ${streak.warn} reading(s); alerts after ${required} in a row`;
  return null;
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
  SUSTAINED_TEMPERATURE_SAMPLES,
  confirmTelemetryLevel,
  sanitizeNodeTelemetry,
  sanitizeSmartHealth,
  assessNodeTelemetry,
  assessDiskLevel,
  telemetrySummary,
  telemetryDetail,
  pendingTemperatureNote,
  telemetryAge,
  nodeUptimeHint,
};
