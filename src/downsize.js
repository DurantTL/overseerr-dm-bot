'use strict';

// Downsize swap: replace an existing larger movie file with a smaller staged replacement.
//
// Caleb is downsizing his 4K library — same quality, smaller files. Radarr's import logic
// only accepts "upgrades," so it rejects smaller replacements ("Not a quality revision
// upgrade"). The working swap is: delete the old file via the Radarr API, then import the
// staged smaller file. This module holds the pure decision logic (facts in, verdict out)
// so tests can exercise it directly; index.js wires Discord, Radarr, and the filesystem
// around these decisions.

const fs = require('fs');
const path = require('path');
const { normalizeTitle } = require('./grab');

// Video extensions the downsize flow cares about — matches VIDEO_EXTS in index.js.
const VIDEO_EXTS = new Set(['.mkv', '.mp4', '.avi', '.m4v', '.ts', '.wmv', '.mov']);

function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return 'unknown';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u++; }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[u]}`;
}

// Recursively list video files under a directory. Returns [{ path, size }].
// Skips `.incoming` (in-flight rclone copies — never import from there).
function listStagedVideos(stagingPath) {
  const out = [];
  const walk = dir => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_e) { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === '.incoming') continue;
        walk(full);
      } else if (e.isFile() && VIDEO_EXTS.has(path.extname(e.name).toLowerCase())) {
        let size = null;
        try { size = fs.statSync(full).size; } catch (_e) { /* unreadable — skip */ }
        if (size != null) out.push({ path: full, size });
      }
    }
  };
  walk(stagingPath);
  return out;
}

// Score how well a staged filename matches a movie title. Higher is better.
// - Exact normalized title containment: +10
// - Token overlap: +1 per shared token
// Returns 0 when there's no meaningful overlap.
function matchScore(stagedName, movieTitle) {
  const normFile = ` ${normalizeTitle(path.basename(stagedName, path.extname(stagedName)))} `;
  const normTitle = normalizeTitle(movieTitle);
  if (!normTitle) return 0;
  if (normFile.includes(` ${normTitle} `)) return 10 + normTitle.split(' ').length;
  const titleTokens = normTitle.split(' ').filter(Boolean);
  const hits = titleTokens.filter(t => normFile.includes(` ${t} `)).length;
  // Require at least half the title tokens (rounded up) to avoid "The" matching everything.
  if (hits < Math.ceil(titleTokens.length / 2)) return 0;
  return hits;
}

// Find the staged replacement for a movie.
// Strategy, best first:
//  1. Adopted grab jobs (listAdoptedGrabJobs): a job whose title matches the movie gives
//     the exact staged path — no guessing.
//  2. Filename similarity: scan the staging folder for video files whose names match.
// Only files SMALLER than the existing file qualify — a downsize that isn't smaller is
// pointless, and offering it would be confusing.
// Returns { path, size, via } or null.
function findStagedReplacement(stagingPath, movie, adoptedJobs = []) {
  if (!stagingPath || !movie) return null;
  const oldSize = Number(movie.movieFile?.size) || 0;

  // Strategy 1: adopted jobs. The job title is the release name; match against the movie.
  const normMovie = normalizeTitle(`${movie.title || ''} ${movie.year || ''}`.trim());
  for (const job of adoptedJobs || []) {
    const jobTitle = String(job.release_title || job.title || '');
    if (!jobTitle || !normMovie) continue;
    // The job is for this movie when every movie-title token appears in the release name.
    const tokens = normMovie.split(' ').filter(Boolean);
    const haystack = ` ${normalizeTitle(jobTitle)} `;
    if (tokens.length && tokens.every(t => haystack.includes(` ${t} `))) {
      // The staged file lives under stagingPath named after the release.
      const candidates = [
        path.join(stagingPath, jobTitle),
        path.join(stagingPath, `${jobTitle}.mkv`),
        path.join(stagingPath, `${jobTitle}.mp4`),
      ];
      for (const c of candidates) {
        try {
          const st = fs.statSync(c);
          if (st.isFile() && st.size > 0 && (!oldSize || st.size < oldSize)) {
            return { path: c, size: st.size, via: 'adopted-job' };
          }
          if (st.isDirectory()) {
            const vids = listStagedVideos(c).filter(v => !oldSize || v.size < oldSize);
            if (vids.length === 1) return { path: vids[0].path, size: vids[0].size, via: 'adopted-job' };
            // Multiple videos in the folder — pick the largest (the main feature, not a sample).
            if (vids.length > 1) {
              vids.sort((a, b) => b.size - a.size);
              return { path: vids[0].path, size: vids[0].size, via: 'adopted-job' };
            }
          }
        } catch (_e) { /* not there — try next */ }
      }
    }
  }

  // Strategy 2: filename similarity scan across the whole staging folder.
  // B14: if the top two candidates tie on score, the match is ambiguous — don't silently
  // pick one. Return null so the caller reports "no confident match" instead of swapping
  // the wrong file.
  const videos = listStagedVideos(stagingPath);
  const scored = videos
    .map(v => ({ ...v, score: matchScore(v.path, `${movie.title || ''} ${movie.year || ''}`.trim()) }))
    .filter(v => v.score > 0 && (!oldSize || v.size < oldSize))
    .sort((a, b) => b.score - a.score || b.size - a.size);
  if (!scored.length) return null;
  if (scored.length > 1 && scored[0].score === scored[1].score) return null;
  return { path: scored[0].path, size: scored[0].size, via: 'filename-match' };
}

// Build the preview data for the Swap/Cancel prompt.
// Returns { ok, reason } on failure, or the full preview on success.
function buildDownsizePreview({ movie, oldFile, newFile }) {
  if (!movie) return { ok: false, reason: 'movie_not_found' };
  if (!oldFile || !oldFile.path) return { ok: false, reason: 'no_existing_file' };
  if (!newFile || !newFile.path) return { ok: false, reason: 'no_replacement' };
  const oldSize = Number(oldFile.size) || 0;
  const newSize = Number(newFile.size) || 0;
  if (oldSize > 0 && newSize >= oldSize) {
    return { ok: false, reason: 'not_smaller', oldSize, newSize };
  }
  return {
    ok: true,
    movieTitle: movie.title,
    movieYear: movie.year,
    oldPath: oldFile.path,
    oldSize,
    oldQuality: qualityName(oldFile.quality),
    newPath: newFile.path,
    newSize,
    bytesSaved: oldSize > 0 ? oldSize - newSize : null,
  };
}

// B1: Radarr nests the quality name at quality.quality.name; other shapes use quality.name.
// Centralize so the [object Object] class can't recur.
function qualityName(q) {
  if (!q) return 'unknown';
  if (typeof q === 'string') return q;
  return q.quality?.name || q.name || 'unknown';
}

// Execute the downsize swap. All side effects go through `deps` so tests can stub them.
// Steps: verify staged file exists → DELETE old file via Radarr API → trigger
// DownloadedMoviesScan → poll for the new file. Returns a result object; never throws.
//
// deps: { fs, path, axios, CONFIG, radarrGetFrom, audit, sleepMs }
async function executeDownsizeSwap({ offer, deps }) {
  const { fs, path, axios, CONFIG, radarrGetFrom, audit } = deps;
  const sleepMs = deps.sleepMs || (ms => new Promise(r => setTimeout(r, ms)));
  const actor = { actorDiscordId: offer.actorDiscordId, title: offer.movieTitle, arrId: offer.movieId, source: offer.sourceLabel };

  // Safety: the offer is valid only for the exact staged file previewed by the admin.
  // Reject path traversal, .incoming, and any symlink below the configured staging root
  // before touching Radarr. Importing through a lexical alias is unsafe even when the
  // symlink ultimately resolves inside staging: Radarr may not see the same alias.
  const stagingRoot = String(CONFIG.GRAB_STAGING_PATH || '');
  const replacementRel = stagingRoot ? path.relative(path.resolve(stagingRoot), path.resolve(offer.newPath)) : '';
  if (!stagingRoot || !replacementRel || replacementRel === '..' || replacementRel.startsWith(`..${path.sep}`) || path.isAbsolute(replacementRel) || replacementRel.split(path.sep).includes('.incoming')) {
    audit('downsize_aborted', { ...actor, reason: 'unsafe_replacement_path', newPath: offer.newPath });
    return { ok: false, reason: 'unsafe_replacement_path', newPath: offer.newPath };
  }

  let stagedStat = null;
  try { stagedStat = fs.statSync(offer.newPath); } catch (_e) { /* gone */ }
  if (!stagedStat?.isFile()) {
    audit('downsize_aborted', { ...actor, reason: 'replacement_gone', newPath: offer.newPath });
    return { ok: false, reason: 'replacement_gone', newPath: offer.newPath };
  }
  if (typeof fs.realpathSync === 'function') {
    try {
      const resolvedRoot = fs.realpathSync(stagingRoot);
      const resolvedReplacement = fs.realpathSync(offer.newPath);
      const expectedResolvedPath = path.resolve(resolvedRoot, replacementRel);
      if (path.normalize(resolvedReplacement) !== path.normalize(expectedResolvedPath)) {
        audit('downsize_aborted', { ...actor, reason: 'unsafe_replacement_path', newPath: offer.newPath });
        return { ok: false, reason: 'unsafe_replacement_path', newPath: offer.newPath };
      }
    } catch (_e) {
      audit('downsize_aborted', { ...actor, reason: 'replacement_gone', newPath: offer.newPath });
      return { ok: false, reason: 'replacement_gone', newPath: offer.newPath };
    }
  }
  // Exact byte equality is intentional: a one-byte change can be a different or incomplete
  // replacement. The preview's stat size is the consent boundary for this destructive swap.
  const expectedNewSize = Number(offer.newSize);
  if (!Number.isFinite(expectedNewSize) || expectedNewSize <= 0 || stagedStat.size !== expectedNewSize) {
    audit('downsize_aborted', { ...actor, reason: 'size_changed', newPath: offer.newPath, expectedSize: offer.newSize, actualSize: stagedStat.size });
    return { ok: false, reason: 'size_changed', newPath: offer.newPath, expectedSize: offer.newSize, actualSize: stagedStat.size };
  }
  const expectedOldSize = Number(offer.oldSize);
  if (!Number.isFinite(expectedOldSize) || expectedOldSize <= 0 || stagedStat.size >= expectedOldSize) {
    audit('downsize_aborted', { ...actor, reason: 'not_smaller', newPath: offer.newPath, oldSize: offer.oldSize, actualSize: stagedStat.size });
    return { ok: false, reason: 'not_smaller', newPath: offer.newPath, oldSize: offer.oldSize, actualSize: stagedStat.size };
  }

  // Revalidate the destructive target immediately before deletion. A preview can remain open
  // while Radarr upgrades or replaces the movie, so file id alone is not a sufficient consent
  // boundary: id, path, and size must all still describe the exact file shown in the preview.
  let currentFile;
  try {
    const movies = await radarrGetFrom(offer.sourceUrl, offer.sourceKey, '/movie');
    const movie = (movies || []).find(x => Number(x.id) === Number(offer.movieId));
    currentFile = movie?.movieFile || null;
  } catch (err) {
    audit('downsize_aborted', { ...actor, reason: 'revalidation_failed', error: err.message });
    return { ok: false, reason: 'revalidation_failed', error: err.message };
  }
  const sameOldFile = currentFile
    && Number(currentFile.id) === Number(offer.oldFileId)
    && path.normalize(String(currentFile.path || '')) === path.normalize(String(offer.oldPath || ''))
    && Number(currentFile.size) === Number(offer.oldSize);
  if (!sameOldFile) {
    audit('downsize_aborted', {
      ...actor,
      reason: 'stale_old_file',
      expectedOldFileId: offer.oldFileId,
      currentOldFileId: currentFile?.id ?? null,
      expectedOldPath: offer.oldPath,
      currentOldPath: currentFile?.path ?? null,
      expectedOldSize: offer.oldSize,
      currentOldSize: currentFile?.size ?? null,
    });
    return { ok: false, reason: 'stale_old_file' };
  }

  // Step 1: delete the existing file via the Radarr API.
  try {
    await axios.delete(`${offer.sourceUrl}/api/v3/moviefile/${offer.oldFileId}`, {
      params: { apikey: offer.sourceKey }, timeout: 15000,
    });
  } catch (err) {
    audit('downsize_delete_failed', { ...actor, oldFileId: offer.oldFileId, oldPath: offer.oldPath, error: err.message });
    return { ok: false, reason: 'delete_failed', error: err.message };
  }
  audit('downsize_old_deleted', { ...actor, oldFileId: offer.oldFileId, oldPath: offer.oldPath, oldSize: offer.oldSize });

  // Step 2: trigger the Radarr import scan, translating the bot's staging view to the arr's.
  const importPath = path.join(CONFIG.GRAB_IMPORT_PATH || CONFIG.GRAB_STAGING_PATH, replacementRel);
  let commandId;
  try {
    const cmd = await axios.post(`${offer.sourceUrl}/api/v3/command`,
      { name: 'DownloadedMoviesScan', path: importPath },
      { headers: { 'X-Api-Key': offer.sourceKey }, timeout: 15000 });
    commandId = cmd.data?.id ?? null;
  } catch (err) {
    audit('downsize_scan_failed', { ...actor, importPath, error: err.message });
    return { ok: false, reason: 'scan_failed', error: err.message, oldDeleted: true, importPath };
  }
  audit('downsize_scan_triggered', { ...actor, importPath, commandId });

  // Step 3: verify. Poll the movie — success is a movieFile whose path left staging.
  let verified = false;
  let newMoviePath = null;
  for (let i = 0; i < 12; i++) {
    await sleepMs(5000);
    try {
      const movies = await radarrGetFrom(offer.sourceUrl, offer.sourceKey, '/movie');
      const m = (movies || []).find(x => Number(x.id) === Number(offer.movieId));
      newMoviePath = m?.movieFile?.path || null;
      if (newMoviePath && !newMoviePath.startsWith(CONFIG.GRAB_STAGING_PATH) && !newMoviePath.startsWith(CONFIG.GRAB_IMPORT_PATH)) {
        verified = true;
        break;
      }
    } catch (_e) { /* transient — keep polling */ }
  }
  const stagedGone = !fs.existsSync(offer.newPath);

  if (verified) {
    audit('downsize_swapped', { ...actor, oldPath: offer.oldPath, oldSize: offer.oldSize, newPath: newMoviePath, newSize: offer.newSize, bytesSaved: offer.bytesSaved });
    return { ok: true, newMoviePath, stagedGone };
  }
  audit('downsize_unverified', { ...actor, newMoviePath, stagedGone, commandId });
  return { ok: false, reason: 'unverified', commandId, newMoviePath, stagedGone, oldDeleted: true };
}

module.exports = { formatBytes, listStagedVideos, matchScore, findStagedReplacement, buildDownsizePreview, executeDownsizeSwap, VIDEO_EXTS,
  qualityName,};
