'use strict';

// Turning an arr's manualimport rejections into something you can act on.
//
// The rejection list used to be flattened into a de-duplicated set of reason strings, which for a
// season pack reads "• Unable to determine if file is a sample" and leaves you to work out which
// of twenty-two episodes it meant. Reasons are grouped with their filenames here instead, and the
// handful of reasons with a known, specific remedy carry that remedy — several of them are not
// mapping problems at all, so the "Map to a Series…" wizard would be the wrong thing to reach for.

const path = require('path');

// Ordered: first match wins, so specific patterns must precede general ones.
const HINTS = [
  {
    match: /unable to determine if file is a sample/i,
    hint: 'The arr could not read the file\'s runtime, so it cannot rule out a sample. Almost always an unreadable file rather than a matching problem: check the permissions the arr sees, and that the file is non-zero and complete. `docker exec sonarr ffprobe -v error -show_entries format=duration <file>` reproduces it directly.',
  },
  {
    match: /destination already exists/i,
    hint: 'The library already holds a file at the destination path. An arr never overwrites a file it has no record of — rescan the series so it adopts the existing file (then it can judge the new one as an upgrade), or delete the stale copy, then re-import.',
  },
  {
    match: /unknown series|unable to parse|no episodes? found/i,
    hint: 'A naming/matching problem — this is what the guided mapping flow is for.',
  },
  {
    match: /existing file.*(higher|better) quality|not an upgrade/i,
    hint: 'The arr already has an equal or better copy and is declining on purpose. Nothing is broken; delete the staged file if you do not want it.',
  },
  {
    match: /file is a sample/i,
    hint: 'Genuinely detected as a sample — the release probably included one alongside the real file, which is harmless.',
  },
  {
    match: /no permission|access to the path|denied/i,
    hint: 'A filesystem permission problem: the arr can see the file but cannot read or move it. Compare the uid the arr runs as against the file owner.',
  },
];

function hintFor(reason) {
  return HINTS.find(entry => entry.match.test(String(reason || '')))?.hint || null;
}

// [{ reason, hint, files: [...basenames], count }] — most-affected reason first, so the biggest
// problem is the first thing read.
function summarizeImportRejections(preview, { maxFilesPerReason = 6 } = {}) {
  const byReason = new Map();
  for (const entry of preview || []) {
    const name = entry?.path ? path.basename(entry.path) : '(unnamed file)';
    for (const rejection of entry?.rejections || []) {
      // Sonarr sends {reason}; be tolerant of a bare string, but never stringify the object
      // itself — an empty reason would otherwise surface to the operator as "[object Object]".
      const raw = typeof rejection === 'string' ? rejection : rejection?.reason;
      const reason = String(raw ?? '').trim();
      if (!reason) continue;
      if (!byReason.has(reason)) byReason.set(reason, []);
      byReason.get(reason).push(name);
    }
  }
  return [...byReason.entries()]
    .map(([reason, files]) => ({
      reason,
      hint: hintFor(reason),
      count: files.length,
      files: files.slice(0, maxFilesPerReason),
      more: Math.max(0, files.length - maxFilesPerReason),
    }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
}

// Discord-ready lines. Kept separate from the summary so the grouping can be tested without
// asserting on formatting.
function renderRejectionLines(groups) {
  return (groups || []).flatMap(group => [
    `• **${group.reason}** — ${group.count} file${group.count === 1 ? '' : 's'}`,
    `  ${group.files.join(', ')}${group.more ? ` _(+${group.more} more)_` : ''}`,
    ...(group.hint ? [`  -# ${group.hint}`] : []),
  ]);
}

// Whether anything in this batch is a naming/matching problem. When nothing is, offering the
// "Map to a Series…" wizard actively misleads — the files are already matched and the arr is
// refusing them for an unrelated reason.
function looksLikeMappingProblem(groups) {
  return (groups || []).some(g => /unknown series|unable to parse|no episodes? found|invalid season|episode.*not found/i.test(g.reason));
}

module.exports = { summarizeImportRejections, renderRejectionLines, hintFor, looksLikeMappingProblem };
