function boundedNumber(value, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const number = Number(value);
  return Number.isFinite(number) && number >= min && number <= max ? number : null;
}

function sanitizeNodeTelemetry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const value = {
    collectedAt: boundedNumber(raw.collectedAt, { min: 0 }),
    temperatureC: boundedNumber(raw.temperatureC, { min: -20, max: 150 }),
    temperatureSource: String(raw.temperatureSource || '').slice(0, 80) || null,
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
  return Object.values(value).some(item => item !== null) ? value : null;
}

function assessNodeTelemetry(telemetry, { warnC = 80, criticalC = 90 } = {}) {
  const temp = telemetry?.temperatureC;
  if (temp == null) return { level: 'unknown', reason: 'temperature unavailable' };
  if (temp >= criticalC) return { level: 'critical', reason: `CPU temperature ${temp.toFixed(1)}°C is at or above ${criticalC}°C` };
  if (temp >= warnC) return { level: 'warn', reason: `CPU temperature ${temp.toFixed(1)}°C is at or above ${warnC}°C` };
  return { level: 'ok', reason: `CPU temperature ${temp.toFixed(1)}°C` };
}

function telemetrySummary(telemetry, fmtSpace = value => `${value} B`) {
  if (!telemetry) return 'hardware telemetry unavailable';
  const memoryUsed = telemetry.memoryTotalBytes != null && telemetry.memoryFreeBytes != null
    ? Math.max(0, telemetry.memoryTotalBytes - telemetry.memoryFreeBytes) : null;
  const memoryPct = memoryUsed != null && telemetry.memoryTotalBytes ? Math.round(memoryUsed / telemetry.memoryTotalBytes * 100) : null;
  const diskPct = telemetry.filesystemFreeBytes != null && telemetry.filesystemTotalBytes
    ? Math.round(telemetry.filesystemFreeBytes / telemetry.filesystemTotalBytes * 100) : null;
  return [
    telemetry.temperatureC != null ? `${telemetry.temperatureC.toFixed(1)}°C CPU` : 'temperature unavailable',
    telemetry.load1 != null ? `load ${telemetry.load1.toFixed(2)}${telemetry.cpuCount ? `/${telemetry.cpuCount} CPU` : ''}` : null,
    memoryPct != null ? `RAM ${memoryPct}% used` : null,
    diskPct != null ? `${fmtSpace(telemetry.filesystemFreeBytes)} disk free (${diskPct}%)` : null,
    telemetry.uptimeSeconds != null ? `uptime ${Math.floor(telemetry.uptimeSeconds / 3600)}h` : null,
  ].filter(Boolean).join(' · ');
}

module.exports = { sanitizeNodeTelemetry, assessNodeTelemetry, telemetrySummary };
