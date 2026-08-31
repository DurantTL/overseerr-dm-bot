// rTorrent adoption: bring torrents that already live in the seedbox rTorrent (added
// manually, by another private tracker, or before the bot existed) into the grab pipeline.
// The bot normally tracks torrents by the info-hash it computes when IT submits the
// .torrent; anything else in rTorrent has no grab_jobs row and is invisible. Adoption
// creates that row from the EXISTING torrent — no tracker download, no AvistaZ allowance
// slot, nothing removed from rTorrent — at 'downloading' (the sweep watches it to 100%) or
// 'complete' (the transfer runs immediately), and the normal rclone → .incoming →
// arr-import chain finishes the job.
//
// Everything here is pure (facts in, verdict out) so the tests can exercise it directly;
// index.js wires Discord, rTorrent, and rclone around these decisions.
const { CONFIG } = require('./config');
const { normalizeTitle } = require('./grab');

// Token match: every word of the search must appear in the torrent name, case- and
// punctuation-insensitive — "Blood Vs Duty" matches "Blood.Vs.Duty.S01.1080p.WEB-DL".
function matchTorrentsByName(torrents, search) {
  const tokens = normalizeTitle(search).split(' ').filter(Boolean);
  if (!tokens.length) return [];
  return (torrents || []).filter(t => {
    const haystack = ` ${normalizeTitle(t.name)} `;
    return tokens.every(tok => haystack.includes(` ${tok} `));
  });
}

// Import target implied by the torrent's rTorrent label (d.custom1). Only labels listed in
// RTORRENT_ADOPT_LABELS count, and the label must name an arr that is actually configured.
// Null means blank/unknown label — adoption then requires an explicit admin choice, never a
// silent guess.
function adoptTargetForLabel(label, cfg = CONFIG) {
  const l = String(label || '').trim().toLowerCase();
  if (!l || !cfg.RTORRENT_ADOPT_LABELS.includes(l)) return null;
  if (l.includes('sonarr')) return cfg.SONARR_URL ? 'sonarr' : null;
  if (l.includes('radarr')) return cfg.RADARR_URL ? 'radarr' : null;
  return null;
}

// Map the torrent's on-seedbox path (d.base_path: the folder for multi-file torrents, the
// file itself for single-file ones) to the subpath under GRAB_RCLONE_REMOTE that rclone
// should copy. RTORRENT_REMOTE_ROOT is the seedbox-side folder the remote points at, so
// torrents living in per-label subfolders map to 'label/Name'. Null when the path can't be
// mapped safely — callers fall back to the bare torrent name.
function remoteSubpathFor(basePath, remoteRoot) {
  const base = String(basePath || '');
  const root = String(remoteRoot || '').replace(/\/+$/, '');
  if (!root || !base.startsWith(`${root}/`)) return null;
  const rel = base.slice(root.length + 1).replace(/\/+$/, '');
  if (!rel || rel.split('/').some(part => !part || part === '.' || part === '..')) return null;
  return rel;
}

// Torrents rTorrent has placed at a relative path.
//
// rTorrent reports d.base_path relative when its own download directory is configured
// relatively (a bare `directory.default.set = ./downloads`, or none at all, leaving the path
// relative to rTorrent's working directory). Sonarr and Radarr both refuse such a torrent
// outright — "has a download path starting with '.' and will not be processed. Adjust this to
// an absolute path in rTorrent" — so it downloads to completion and is then simply dropped:
// never imported, and never recorded as a failure either.
//
// That is invisible to everything else here. The stuck-download watchdog reads the *arr queue,
// and these produce no queue item to read; the season sweep sees a grab that vanished without
// a downloadFailed event to explain it. One relative path in rTorrent's config therefore stalls
// every grab from every source — the bot's own direct grabs and the *arrs' — until someone
// reads the rTorrent log, which is the one place it is written down.
function findUnprocessableTorrents(torrents = []) {
  return (torrents || []).filter(torrent => {
    const base = String(torrent.basePath || '').trim();
    // An empty base_path is a torrent rTorrent has not allocated yet, not a misconfiguration.
    return base !== '' && !base.startsWith('/');
  });
}

// The adoption verdict for one existing torrent: refuse duplicates (an info-hash already in
// grab_jobs is already owned by the pipeline), refuse target-less adoptions, and pick the
// job's starting state from the torrent's completion.
function decideAdoption({ torrent, existingJob, target }) {
  if (existingJob) return { ok: false, dup: true, why: `already tracked as grab job #${existingJob.id} (${existingJob.state})` };
  if (!target) return { ok: false, needsTarget: true, why: 'the rTorrent label is blank or unknown — pick sonarr/radarr explicitly' };
  const name = String(torrent.name || '');
  if (!name || name.includes('/') || name.includes('..')) return { ok: false, why: `unsafe torrent name: ${name || '(empty)'}` };
  return { ok: true, state: torrent.complete ? 'complete' : 'downloading', mediaType: target === 'sonarr' ? 'tv' : 'movie' };
}

// Every plausible location of the torrent's data under GRAB_RCLONE_REMOTE, best guess
// first: the RTORRENT_REMOTE_ROOT-derived subpath when configured, the bare torrent name,
// then every trailing suffix of d.base_path (up to 5 segments — 'file.mkv',
// 'Downloads/file.mkv', 'localclient/Downloads/file.mkv', …). rclone verifies which one is
// real, so an unset or wrong RTORRENT_REMOTE_ROOT self-corrects instead of failing the
// adoption: an SFTP remote with no path= points at the login home dir, making files appear
// as 'Downloads/…' rather than at the root.
function remoteSubpathCandidates(basePath, name, remoteRoot) {
  const out = [];
  const push = p => {
    if (p && !out.includes(p) && p.split('/').every(part => part && part !== '.' && part !== '..')) out.push(p);
  };
  push(remoteSubpathFor(basePath, remoteRoot));
  push(String(name || ''));
  const segs = String(basePath || '').split('/').filter(Boolean);
  for (let n = 1; n <= Math.min(segs.length, 5); n++) push(segs.slice(segs.length - n).join('/'));
  return out;
}

// Parse `rclone lsf --format ps --separator ';'` output into [{ path, size }] entries.
// Directory-ness comes from the trailing '/' (rclone's --dir-slash marker), NOT from the
// size column — backends report directory "sizes" inconsistently (-1, 0, or a stat size),
// and any of those must become size null so folder torrents are never size-gated against a
// meaningless number. Plain `lsf` output without the size column parses too (size null).
function parseRemoteListing(text) {
  const entries = [];
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const sep = line.lastIndexOf(';');
    const tail = sep === -1 ? null : line.slice(sep + 1);
    const sized = tail !== null && /^-?\d+$/.test(tail); // a ';' inside a filename isn't a size column
    let p = sized ? line.slice(0, sep) : line;
    const isDir = /\/+$/.test(p);
    p = p.replace(/\/+$/, '');
    if (!p) continue;
    const rawSize = sized ? Number(tail) : NaN;
    entries.push({ path: p, size: !isDir && Number.isFinite(rawSize) && rawSize >= 0 ? rawSize : null });
  }
  return entries;
}

// basename → [{ path, size }]. This backs the last-resort filename search: when data was
// moved on the seedbox behind rTorrent's back (stale d.base_path — e.g. episodes sorted
// into a per-series folder), the exact torrent name is looked up anywhere in the tree.
// Only a UNIQUE match may be used — two files with the same name is a guess, and adoption
// never guesses.
function indexRemoteListing(text) {
  const map = new Map();
  for (const entry of parseRemoteListing(text)) {
    const base = entry.path.slice(entry.path.lastIndexOf('/') + 1);
    if (!base) continue;
    if (!map.has(base)) map.set(base, []);
    map.get(base).push(entry);
  }
  return map;
}

// Does a listed size satisfy the torrent's size? Directories and unknown sizes can't be
// checked (null); a FILE whose size differs is a re-allocated placeholder or partial copy —
// rTorrent recreates 0-byte files at the old path when its data was moved away, and those
// must never be adopted as the real thing.
function remoteSizeMatches(size, expectedBytes) {
  if (size == null || !expectedBytes) return true;
  return size === expectedBytes;
}

// Join a subpath onto an rclone remote without corrupting bare remotes: on SFTP,
// 'remote:path' is home-relative while 'remote:/path' is root-relative, so
// 'rapidseedbox:' + '/' + 'Downloads/x' would probe the absolute /Downloads/x instead of
// ~/Downloads/x. Only insert '/' when the remote already carries a path.
function joinRemotePath(remote, sub) {
  const r = String(remote || '');
  if (!sub) return r;
  return r.endsWith(':') ? `${r}${sub}` : `${r}/${sub}`;
}

// Which bulk-adopt buttons a cohort should get: an explicit target pins one button; a
// cohort whose labels all resolve to the same arr gets that one; anything mixed or
// unresolved falls back to one button per configured arr — the admin picks, never a guess.
function bulkTargetChoices(candidates, explicitTarget, cfg = CONFIG) {
  if (explicitTarget) return [explicitTarget];
  const resolved = (candidates || []).map(t => adoptTargetForLabel(t.label, cfg));
  if (resolved.length && resolved.every(t => t && t === resolved[0])) return [resolved[0]];
  return [cfg.SONARR_URL ? 'sonarr' : null, cfg.RADARR_URL ? 'radarr' : null].filter(Boolean);
}

module.exports = { findUnprocessableTorrents, matchTorrentsByName, adoptTargetForLabel, remoteSubpathFor, remoteSubpathCandidates, parseRemoteListing, indexRemoteListing, remoteSizeMatches, joinRemotePath, decideAdoption, bulkTargetChoices };
