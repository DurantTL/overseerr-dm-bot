// Request-row persistence kept separate from the process-global DB so the merge and repair
// rules can be regression-tested against an isolated SQLite database.

// `seasons` (#255) is a storage key from src/season-select.js#seasonsToStorageKey — 'all', a
// JSON array of season numbers, or null for movies/unknown. Passing `undefined` (the historical
// call shape, still used by callers with no season knowledge, e.g. the Seerr webhook) means "I
// don't know" rather than "clear it": matching queries skip the seasons filter entirely (so
// those callers behave exactly as before this column existed) and writes preserve whatever the
// row already had via COALESCE. A caller that DOES know the selection (the /request and mobile
// wizard flows, always) passes it explicitly on every call, including 'all', so two pending rows
// for the same show+edition but different season selections are matched, adopted, and collapsed
// independently instead of colliding into one row.
function upsertTrackedRequest(database, overseerrRequestId, mediaId, mediaType, is4k, title, discordId, status, seasons) {
  const reqId = overseerrRequestId ? String(overseerrRequestId) : null;
  const edition = is4k ? 1 : 0;
  const hasSeasons = seasons !== undefined;
  const seasonsValue = hasSeasons ? seasons : null;
  const seasonsWhere = hasSeasons ? ' AND seasons IS ?' : '';
  const seasonsArgsWhere = hasSeasons ? [seasonsValue] : [];

  if (reqId) {
    const known = database.prepare('SELECT id FROM requests WHERE overseerr_request_id = ?').get(reqId);
    if (!known) {
      // Discord approval gates create a pending row before Seerr has assigned an id. Adopt that
      // row when approval succeeds instead of inserting a second row and leaving a phantom
      // pending request on /status and the dashboard.
      const provisional = database.prepare(`SELECT id FROM requests
        WHERE overseerr_request_id IS NULL AND media_id = ? AND is_4k = ? AND status = 'pending'${seasonsWhere}
        ORDER BY id DESC LIMIT 1`).get(mediaId, edition, ...seasonsArgsWhere);
      if (provisional) {
        database.prepare(`UPDATE requests SET
            overseerr_request_id = ?, media_type = ?, title = ?,
            requested_by_discord_id = COALESCE(?, requested_by_discord_id), status = ?,
            seasons = COALESCE(?, seasons)
          WHERE id = ?`)
          .run(reqId, mediaType, title, discordId || null, status, seasonsValue, provisional.id);
        return { action: 'adopted-provisional', id: provisional.id };
      }
    }
    database.prepare(`INSERT INTO requests (overseerr_request_id, media_id, media_type, is_4k, title, requested_by_discord_id, status, seasons)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(overseerr_request_id) DO UPDATE SET
        media_id = excluded.media_id,
        media_type = excluded.media_type,
        is_4k = excluded.is_4k,
        status = excluded.status,
        title = excluded.title,
        requested_by_discord_id = COALESCE(excluded.requested_by_discord_id, requests.requested_by_discord_id),
        seasons = COALESCE(excluded.seasons, requests.seasons)`)
      .run(reqId, mediaId, mediaType, edition, title, discordId || null, status, seasonsValue);
    return { action: known ? 'updated' : 'inserted' };
  }
  const updated = database.prepare(`UPDATE requests SET status = ?, title = ?,
      requested_by_discord_id = COALESCE(?, requested_by_discord_id),
      seasons = COALESCE(?, seasons)
    WHERE media_id = ? AND is_4k = ?${seasonsWhere}`)
    .run(status, title, discordId || null, seasonsValue, mediaId, edition, ...seasonsArgsWhere);
  if (!updated.changes) {
    const result = database.prepare(`INSERT INTO requests (overseerr_request_id, media_id, media_type, is_4k, title, requested_by_discord_id, status, seasons)
      VALUES (NULL, ?, ?, ?, ?, ?, ?, ?)`)
      .run(mediaId, mediaType, edition, title, discordId || null, status, seasonsValue);
    return { action: 'inserted-provisional', id: result.lastInsertRowid };
  }
  return { action: 'updated-by-media', count: updated.changes };
}

// Repair the exact historical duplicate shape produced by the old approval flow. A NULL-id
// pending row is removed only when a same-edition Seerr-backed row has already advanced beyond
// pending. That conservative condition avoids collapsing legitimate later season requests.
function collapseStalePendingRequests(database) {
  // Seasons must match too (`r.seasons IS p.seasons`) — otherwise a stale pending row for one
  // season selection could be collapsed into a completed row for a DIFFERENT selection on the
  // same show+edition, which is exactly the "different season request treated as the same
  // completed request" bug #255 calls out.
  const staleRows = database.prepare(`SELECT p.* FROM requests p
    WHERE p.overseerr_request_id IS NULL AND p.status = 'pending'
      AND EXISTS (
        SELECT 1 FROM requests r
        WHERE r.media_id = p.media_id AND r.is_4k = p.is_4k AND r.seasons IS p.seasons
          AND r.overseerr_request_id IS NOT NULL AND r.status != 'pending'
      )
    ORDER BY p.id`).all();
  const findWinner = database.prepare(`SELECT * FROM requests
    WHERE media_id = ? AND is_4k = ? AND seasons IS ? AND overseerr_request_id IS NOT NULL AND status != 'pending'
    ORDER BY id DESC LIMIT 1`);
  const mergeRequester = database.prepare(`UPDATE requests SET
    requested_by_discord_id = COALESCE(requested_by_discord_id, ?)
    WHERE id = ?`);
  const remove = database.prepare('DELETE FROM requests WHERE id = ?');
  const repaired = [];
  const work = () => {
    for (const stale of staleRows) {
      const winner = findWinner.get(stale.media_id, stale.is_4k, stale.seasons);
      if (!winner) continue;
      mergeRequester.run(stale.requested_by_discord_id || null, winner.id);
      remove.run(stale.id);
      repaired.push({ staleId: stale.id, keptId: winner.id, mediaId: stale.media_id, status: winner.status });
    }
  };
  const repair = typeof database.transaction === 'function'
    ? database.transaction(work)
    : () => {
      database.exec('BEGIN');
      try { work(); database.exec('COMMIT'); } catch (err) { database.exec('ROLLBACK'); throw err; }
    };
  repair();
  return repaired;
}

function statusFromSeerrRequest(request) {
  const requestStatus = Number(request?.status);
  if (requestStatus === 3) return 'declined';
  if (requestStatus === 4) return 'failed';
  if (requestStatus === 5) return 'available';
  const mediaStatus = Number(request?.is4k ? request?.media?.status4k : request?.media?.status);
  if (mediaStatus === 5) return 'available';
  if (requestStatus === 2) return 'approved';
  if (requestStatus === 1) return 'pending';
  return null;
}

function reconcileTrackedRequestStatuses(database, remoteRequests) {
  const remoteById = new Map((remoteRequests || []).filter(r => r?.id != null).map(r => [String(r.id), r]));
  const rows = database.prepare('SELECT id, overseerr_request_id, status FROM requests WHERE overseerr_request_id IS NOT NULL').all();
  const update = database.prepare('UPDATE requests SET status = ? WHERE id = ?');
  const changed = [];
  for (const row of rows) {
    const remote = remoteById.get(String(row.overseerr_request_id));
    const status = statusFromSeerrRequest(remote);
    if (!status || status === row.status) continue;
    update.run(status, row.id);
    changed.push({ id: row.id, requestId: String(row.overseerr_request_id), from: row.status, to: status });
  }
  return { changed, repaired: collapseStalePendingRequests(database) };
}

module.exports = { upsertTrackedRequest, collapseStalePendingRequests, statusFromSeerrRequest, reconcileTrackedRequestStatuses };
