'use strict';

// Director's Fleet sync card: per node, per folder, how much Syncthing still has to pull. Read
// only, from what each tier agent already reports (collectFolderCompletion in agent/agent.js,
// stored on the tier plan as folderCompletion by the report route). Nothing here connects to a
// node. A snapshot older than FRESH_MS is shown as the node's last numbers, marked stale; that is
// the same 6-hour cut-off the California play-promotion locality check uses.

const FRESH_MS = 6 * 3600000;

function folderLabel(folderId, folders) {
  const match = folders.find(f => f.folderId === folderId);
  const root = match && match.folderRoot ? String(match.folderRoot).replace(/\/+$/, '') : '';
  const base = root ? root.slice(root.lastIndexOf('/') + 1) : '';
  return base || folderId || 'Folder';
}

// nodes: tier node rows (only name and enabled are read). Returns
// [{ node, reportedAt, stale, folders: [{ label, completion, needBytes, globalBytes, needItems, done }] }]
// with nodes that have never sent a snapshot carrying reportedAt null and no folders.
function buildFleetSync(nodes, { getTierPlan, listTierNodeFolders, now = Date.now(), freshMs = FRESH_MS }) {
  return (Array.isArray(nodes) ? nodes : [])
    .filter(n => n && n.name && Number(n.enabled ?? 1) !== 0)
    .map(n => {
      const snap = getTierPlan(n.name)?.folderCompletion || null;
      const reportedAt = snap && Number.isFinite(snap.at) ? snap.at : null;
      const folders = listTierNodeFolders(n.name) || [];
      return {
        node: n.name,
        reportedAt,
        stale: reportedAt != null && now - reportedAt > freshMs,
        folders: (reportedAt != null && Array.isArray(snap.folders) ? snap.folders : []).map(f => {
          const completion = Number.isFinite(f.completion) ? f.completion : null;
          const needBytes = Number.isFinite(f.needBytes) ? f.needBytes : null;
          return {
            label: folderLabel(f.folderId, folders),
            completion,
            needBytes,
            globalBytes: Number.isFinite(f.globalBytes) ? f.globalBytes : null,
            needItems: Number.isFinite(f.needItems) ? f.needItems : null,
            done: completion === 100 && !needBytes,
          };
        }),
      };
    });
}

module.exports = { FRESH_MS, buildFleetSync, folderLabel };
