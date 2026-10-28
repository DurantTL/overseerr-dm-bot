'use strict';

// Service queue item 13: Syncthing conflict watcher, report-only. Syncthing names a conflict copy
// "<name>.sync-conflict-<YYYYMMDD>-<HHMMSS>-<device short id><.ext>", keeping the extension, so a
// media conflict copy shows up in the inventory each tier agent already reports. The report route
// compares each node's conflict files with the ones it saw last time and pings only for new ones.
// Nothing is moved, renamed or deleted.
//
// Scope: the agents inventory media files in the tier folders, so this sees media conflicts there
// (not .nfo/.srt sidecars, and not folders outside the tier plan).

const MARK = '.sync-conflict-';
const DIGITS = /^\d+$/;
const DEVICE = /^[A-Z0-9]{7}$/;

// { original, at (ms, UTC as Syncthing writes it), device } for a conflict copy's file name, else
// null. Parsed by position rather than one big pattern: "<stem>.sync-conflict-" then
// "YYYYMMDD-HHMMSS-XXXXXXX" then an optional ".ext" with no further dots.
function parseConflictName(fileName) {
  const name = String(fileName || '');
  const idx = name.lastIndexOf(MARK);
  if (idx <= 0) return null;
  const stem = name.slice(0, idx);
  const rest = name.slice(idx + MARK.length);
  const date = rest.slice(0, 8);
  const time = rest.slice(9, 15);
  const device = rest.slice(16, 23);
  const ext = rest.slice(23);
  if (rest[8] !== '-' || rest[15] !== '-' || !DIGITS.test(date) || date.length !== 8 || !DIGITS.test(time) || time.length !== 6 || !DEVICE.test(device)) return null;
  if (ext && (ext[0] !== '.' || ext.length < 2 || ext.indexOf('.', 1) !== -1 || ext.includes('/'))) return null;
  const at = Date.UTC(+date.slice(0, 4), +date.slice(4, 6) - 1, +date.slice(6, 8), +time.slice(0, 2), +time.slice(2, 4), +time.slice(4, 6));
  return { original: `${stem}${ext}`, at: Number.isFinite(at) ? at : null, device };
}

function findConflicts(files) {
  const out = [];
  for (const f of Array.isArray(files) ? files : []) {
    const relPath = String(f?.relPath || '');
    const slash = relPath.lastIndexOf('/');
    const parsed = parseConflictName(relPath.slice(slash + 1));
    if (!parsed) continue;
    out.push({
      folderId: String(f.folderId ?? ''),
      relPath,
      original: (slash >= 0 ? relPath.slice(0, slash + 1) : '') + parsed.original,
      at: parsed.at,
      device: parsed.device,
      sizeBytes: Number(f.sizeBytes) || 0,
    });
  }
  return out;
}

const conflictKey = c => `${c.folderId}\u0000${c.relPath}`;

// The conflicts not in `seenKeys` (an array of conflictKey values from the last report), plus the
// keys to store now. A conflict that is resolved drops out of the stored set, so if it comes back
// it counts as new again.
function diffConflicts(found, seenKeys) {
  const seen = new Set(Array.isArray(seenKeys) ? seenKeys : []);
  return { fresh: found.filter(c => !seen.has(conflictKey(c))), keys: found.map(conflictKey) };
}

module.exports = { parseConflictName, findConflicts, diffConflicts, conflictKey };
