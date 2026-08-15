'use strict';

const DAY_MS = 86400000;
const HISTORY_MS = 30 * DAY_MS;
const MAX_SAMPLES_PER_ROOT = 720;
const MIN_SAMPLES = 6;
const MIN_SPAN_MS = DAY_MS;

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function projectCapacity(samples, now = Date.now()) {
  const ordered = samples
    .map(sample => ({ at: Number(sample.sampledAt ?? sample.sampled_at), freeBytes: Number(sample.freeBytes ?? sample.free_bytes) }))
    .filter(sample => Number.isFinite(sample.at) && Number.isFinite(sample.freeBytes))
    .sort((a, b) => a.at - b.at);
  const spanMs = ordered.length > 1 ? ordered.at(-1).at - ordered[0].at : 0;
  if (ordered.length < MIN_SAMPLES || spanMs < MIN_SPAN_MS) {
    return { status: 'insufficient', sampleCount: ordered.length, spanMs, daysRemaining: null, consumptionBytesPerDay: null, confidence: null };
  }

  const rates = [];
  for (let i = 1; i < ordered.length; i++) {
    const elapsed = ordered[i].at - ordered[i - 1].at;
    if (elapsed > 0) rates.push((ordered[i - 1].freeBytes - ordered[i].freeBytes) * DAY_MS / elapsed);
  }
  if (!rates.length) return { status: 'insufficient', sampleCount: ordered.length, spanMs, daysRemaining: null, consumptionBytesPerDay: null, confidence: null };
  const consumptionBytesPerDay = median(rates);
  if (consumptionBytesPerDay <= 0) {
    return { status: 'stable', sampleCount: ordered.length, spanMs, daysRemaining: null, consumptionBytesPerDay: 0, confidence: null };
  }

  const deviation = median(rates.map(rate => Math.abs(rate - consumptionBytesPerDay)));
  const latest = ordered.at(-1);
  const currentFree = Math.max(0, latest.freeBytes - consumptionBytesPerDay * Math.max(0, now - latest.at) / DAY_MS);
  return {
    status: 'projected',
    sampleCount: ordered.length,
    spanMs,
    daysRemaining: currentFree / consumptionBytesPerDay,
    consumptionBytesPerDay,
    confidence: deviation <= consumptionBytesPerDay * 0.5 ? 'moderate' : 'low',
  };
}

function diskRoot(disk) {
  return String(disk.displayPath || disk.path);
}

function recordDiskSamples(database, disks, sampledAt = Date.now()) {
  const insert = database.prepare('INSERT OR REPLACE INTO disk_space_samples (root, free_bytes, total_bytes, sampled_at) VALUES (?, ?, ?, ?)');
  const write = database.transaction(rows => {
    for (const disk of rows) insert.run(diskRoot(disk), Number(disk.freeSpace), Number(disk.totalSpace), sampledAt);
  });
  write(disks.filter(disk => Number.isFinite(Number(disk.freeSpace)) && Number.isFinite(Number(disk.totalSpace))));
}

function pruneDiskSamples(database, now = Date.now()) {
  database.prepare('DELETE FROM disk_space_samples WHERE sampled_at < ?').run(now - HISTORY_MS);
  const trim = database.prepare(`DELETE FROM disk_space_samples WHERE root = ? AND sampled_at NOT IN (
    SELECT sampled_at FROM disk_space_samples WHERE root = ? ORDER BY sampled_at DESC LIMIT ?
  )`);
  for (const { root } of database.prepare('SELECT DISTINCT root FROM disk_space_samples').all()) {
    trim.run(root, root, MAX_SAMPLES_PER_ROOT);
  }
}

function forecastDisks(database, disks, now = Date.now()) {
  const since = now - HISTORY_MS;
  const select = database.prepare('SELECT free_bytes, sampled_at FROM disk_space_samples WHERE root = ? AND sampled_at >= ? ORDER BY sampled_at');
  return disks.map(disk => ({
    ...disk,
    root: diskRoot(disk),
    forecast: projectCapacity(select.all(diskRoot(disk), since), now),
  }));
}

function pathIsOnRoot(filePath, root) {
  const normalize = value => String(value || '').replace(/\\/g, '/').replace(/\/+$/, '');
  const file = normalize(filePath);
  const base = normalize(root);
  return !!file && !!base && (file === base || file.startsWith(`${base}/`));
}

function forecastLabel(forecast) {
  if (forecast.status === 'insufficient') return `not enough history yet (${forecast.sampleCount}/${MIN_SAMPLES} samples; at least 24h required)`;
  if (forecast.status === 'stable') return `no sustained fill trend (${forecast.sampleCount} samples over ${(forecast.spanMs / DAY_MS).toFixed(1)}d)`;
  return `approximately ${Math.max(0, Math.ceil(forecast.daysRemaining))} days at the current rate (${forecast.confidence} confidence; ${forecast.sampleCount} samples over ${(forecast.spanMs / DAY_MS).toFixed(1)}d)`;
}

module.exports = {
  DAY_MS, HISTORY_MS, MAX_SAMPLES_PER_ROOT, MIN_SAMPLES,
  projectCapacity, recordDiskSamples, pruneDiskSamples, forecastDisks, pathIsOnRoot, forecastLabel,
};
