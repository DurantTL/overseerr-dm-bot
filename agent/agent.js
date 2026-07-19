#!/usr/bin/env node
// Tiering sync agent: the tiny per-node companion of the overseerr-dm-bot regional tiering
// planner. Runs on each edge node (systemd timer or container), pulls that node's manifest
// from the bot, and converges the local Syncthing replica onto it. A node can span several
// Syncthing folders (R2.1); the per-run cycle loops over every folder in the manifest:
//
//   1. GET  <bot>/agent/manifest/<node>   (bearer token; plan_hash unchanged → no-op)
//   For each folder in the manifest:
//   2. Assert the Syncthing folder is still Receive Only — abort loudly if not; that is the
//      only configuration under which this node could ever push a delete back to the master.
//   3. Write that folder's .stignore into its own root.
//   4. Trigger a Syncthing rescan of that folder and CONFIRM the ignores are loaded.
//   5. Only then prune: delete local files that are in `drop` AND ignored (ignored files are
//      never re-pulled; an un-ignored delete would just be re-downloaded). Traversal-confined
//      to that folder's root.
//   6. POST a report back (bytes freed, errors, and — for atime nodes — the local file
//      inventory {folderId, relPath, sizeBytes, atime} that is the planner's demand signal).
//
// Standalone on purpose: Node 18+ stdlib only (global fetch), no discord.js, no *arr deps.
// Idempotent and safe on a schedule.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// A node's Syncthing folders, as { id, root }. Multi-folder nodes set TIER_FOLDERS (JSON
// '[{"id":"aaaaa-bbbbb","path":"/mnt/media/Media/Family Films"}, ...]' or the compact
// 'id:path;id:path' form). Single-folder nodes keep SYNCTHING_FOLDER_ID + TIER_FOLDER_ROOT.
function parseFolders(env) {
  const raw = (env.TIER_FOLDERS || '').trim();
  if (raw) {
    if (raw.startsWith('[')) {
      return JSON.parse(raw).map(f => ({
        id: String(f.id ?? f.folder_id ?? f.folderId ?? ''),
        root: String(f.path ?? f.root ?? f.folder_root ?? f.folderRoot ?? '').replace(/\/+$/, ''),
      }));
    }
    return raw.split(';').map(s => s.trim()).filter(Boolean).map(pair => {
      const i = pair.indexOf(':');
      if (i < 0) throw new Error(`TIER_FOLDERS entry '${pair}' must be id:path`);
      return { id: pair.slice(0, i).trim(), root: pair.slice(i + 1).trim().replace(/\/+$/, '') };
    });
  }
  return [{ id: env.SYNCTHING_FOLDER_ID || '', root: (env.TIER_FOLDER_ROOT || '').replace(/\/+$/, '') }];
}

function buildCtx(env = process.env) {
  const need = k => {
    if (!env[k]) throw new Error(`Missing required env var ${k}`);
    return env[k];
  };
  const folders = parseFolders(env);
  if (!folders.length || folders.some(f => !f.root)) {
    throw new Error('No folder roots configured — set TIER_FOLDER_ROOT (single folder) or TIER_FOLDERS (multi-folder).');
  }
  return {
    botUrl: need('TIER_BOT_URL').replace(/\/$/, ''),
    node: need('TIER_NODE'),
    token: need('TIER_AGENT_TOKEN'),
    syncthingUrl: (env.SYNCTHING_URL || 'http://127.0.0.1:8384').replace(/\/$/, ''),
    syncthingApiKey: env.SYNCTHING_API_KEY || '',
    folders,
    // First folder's id/root, for the single-folder legacy manifest path (no manifest.folders).
    folderId: folders[0].id,
    folderRoot: folders[0].root,
    stateDir: env.TIER_STATE_DIR || '/var/lib/tier-agent',
    // Report the local file inventory (the atime demand signal). Default on — harmless for
    // Tautulli nodes, essential for atime nodes.
    reportInventory: (env.TIER_REPORT_INVENTORY ?? '1') !== '0',
    dryRun: env.TIER_DRY_RUN === '1',
    timeoutMs: Number(env.TIER_HTTP_TIMEOUT_MS || 30000),
    log: (...a) => console.log(new Date().toISOString(), ...a),
  };
}

async function botApi(ctx, method, route, body) {
  const res = await fetch(`${ctx.botUrl}${route}`, {
    method,
    headers: { authorization: `Bearer ${ctx.token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(ctx.timeoutMs),
  });
  if (!res.ok) throw new Error(`${method} ${route} → HTTP ${res.status}`);
  return res.json();
}

async function syncthingApi(ctx, method, route) {
  const res = await fetch(`${ctx.syncthingUrl}${route}`, {
    method,
    headers: { 'X-API-Key': ctx.syncthingApiKey },
    signal: AbortSignal.timeout(ctx.timeoutMs),
  });
  if (!res.ok) throw new Error(`Syncthing ${method} ${route} → HTTP ${res.status}`);
  const text = await res.text();
  try { return JSON.parse(text); } catch (_e) { return text; }
}

// Must match the planner's renderer so ignore-confirmation compares like with like.
const escapeStignore = relPath => String(relPath).replace(/[\\*?[\]{}]/g, ch => `\\${ch}`);

// Fallback .stignore body if the manifest folder didn't carry a rendered one (the bot normally
// includes folder.stignore). Header format mirrors the planner's.
function renderStignore(drop) {
  const lines = [
    `// Managed by overseerr-dm-bot regional tiering — DO NOT EDIT BY HAND.`,
    `// (agent-rendered fallback)`,
  ];
  for (const e of drop || []) lines.push(`/${escapeStignore(e.relPath)}`);
  return `${lines.join('\n')}\n`;
}

// Map the manifest's folders onto this node's local folder roots (by id), producing the concrete
// per-folder work items. A legacy single-folder manifest (no `folders` array) yields one item
// from the top-level drop + stignore and this node's first folder.
function resolveFolderPlans(ctx, manifest) {
  const byId = new Map(ctx.folders.map(f => [f.id, f]));
  if (Array.isArray(manifest.folders) && manifest.folders.length) {
    // Only collapse an unmatched folder onto this node's single folder in the pure single-folder
    // case (one manifest folder, one configured folder). A genuinely multi-folder manifest keeps
    // each folder on its own root so two folders can never clobber the same .stignore.
    const singleLegacy = manifest.folders.length === 1 && ctx.folders.length === 1;
    return manifest.folders.map(mf => {
      const local = byId.get(mf.folder_id) || (singleLegacy ? ctx.folders[0] : null);
      const folderRoot = String((local && local.root) || mf.folder_root || '').replace(/\/+$/, '');
      const folderId = (local && local.id) || mf.folder_id || ctx.folderId;
      return {
        folderId,
        syncFolderId: mf.folder_id || folderId,
        folderRoot,
        drop: mf.drop || [],
        stignore: mf.stignore || renderStignore(mf.drop),
      };
    });
  }
  return [{
    folderId: ctx.folderId,
    syncFolderId: ctx.folderId,
    folderRoot: ctx.folderRoot,
    drop: manifest.drop || [],
    stignore: manifest.stignore || renderStignore(manifest.drop),
  }];
}

// §4a step 2: the one check that protects the master. A Receive Only folder never pushes local
// changes; if someone flipped it to send-receive, pruning here would propagate deletes to every
// other node. Abort and let the bot alert.
async function assertReceiveOnly(ctx, syncFolderId) {
  const folder = await syncthingApi(ctx, 'GET', `/rest/config/folders/${encodeURIComponent(syncFolderId)}`);
  if (folder.type !== 'receiveonly') {
    throw new Error(`SAFETY ABORT: Syncthing folder '${syncFolderId}' is type '${folder.type}', expected 'receiveonly' — pruning could propagate deletes to the master. Fix the folder type before this agent will touch anything.`);
  }
}

function writeStignore(ctx, fp) {
  const target = path.join(fp.folderRoot, '.stignore');
  if (ctx.dryRun) return ctx.log(`[dry-run] would write ${fp.drop.length} ignore pattern(s) to ${target}`);
  fs.writeFileSync(target, fp.stignore, 'utf8');
}

// §4a step 4: rescan the folder, then verify Syncthing actually loaded our patterns before
// deleting anything. Deleting an un-ignored file loses no data — it just gets re-pulled — but the
// point of this agent is not to waste transpacific bandwidth.
async function rescanAndConfirmIgnores(ctx, fp) {
  await syncthingApi(ctx, 'POST', `/rest/db/scan?folder=${encodeURIComponent(fp.syncFolderId)}`);
  const loaded = await syncthingApi(ctx, 'GET', `/rest/db/ignores?folder=${encodeURIComponent(fp.syncFolderId)}`);
  const lines = new Set(loaded.ignore || []);
  const missing = fp.drop.map(e => `/${escapeStignore(e.relPath)}`).filter(l => !lines.has(l));
  if (missing.length) throw new Error(`Ignores not loaded for ${missing.length} drop path(s) in folder '${fp.syncFolderId}' (first: ${missing[0]}) — refusing to prune`);
  return lines;
}

function dirSizeBytes(target) {
  let total = 0;
  const st = fs.lstatSync(target);
  if (!st.isDirectory()) return st.size;
  for (const entry of fs.readdirSync(target)) total += dirSizeBytes(path.join(target, entry));
  return total;
}

// §4a step 5: prune a folder's drops that are confirmed ignored. Every path is resolved and
// checked to stay inside THAT folder's root — a malicious or corrupt manifest must not reach
// outside it, and one folder's drop can never touch another's tree.
function pruneDrops(ctx, fp, loadedIgnores) {
  const dropped = [];
  const errors = [];
  let bytesFreed = 0;
  for (const entry of fp.drop) {
    const pattern = `/${escapeStignore(entry.relPath)}`;
    if (!loadedIgnores.has(pattern)) {
      errors.push(`skipped ${entry.relPath}: not in loaded ignores`);
      continue;
    }
    const target = path.resolve(fp.folderRoot, entry.relPath);
    if (target !== fp.folderRoot && !target.startsWith(`${fp.folderRoot}${path.sep}`)) {
      errors.push(`skipped ${entry.relPath}: escapes folder root`);
      continue;
    }
    if (!fs.existsSync(target)) continue; // already gone (or never pulled) — idempotent
    try {
      const bytes = dirSizeBytes(target);
      if (ctx.dryRun) {
        ctx.log(`[dry-run] would delete ${target} (${bytes} bytes)`);
      } else {
        fs.rmSync(target, { recursive: true, force: true });
        ctx.log(`pruned ${entry.relPath} (${bytes} bytes)`);
      }
      dropped.push({ folderId: fp.folderId, relPath: entry.relPath, bytes });
      bytesFreed += bytes;
    } catch (err) {
      errors.push(`delete failed ${entry.relPath}: ${err.message}`);
    }
  }
  return { dropped, bytesFreed, errors };
}

const MEDIA_EXT = new Set(['.mkv', '.mp4', '.avi', '.mov', '.wmv', '.m4v', '.ts', '.webm', '.mpg', '.mpeg', '.flv', '.iso']);

// Local media inventory for the report — the planner's atime (LRU) demand signal. Walks each
// folder root, skipping Syncthing internals; only media files are reported (posters/nfos would
// drown the signal and the payload). Each row is tagged with its folder id + folder-relative path.
function collectInventory(ctx, folderPlans = ctx.folders.map(f => ({ folderId: f.id, folderRoot: f.root }))) {
  const out = [];
  const seen = new Set(); // dedupe if two folder plans share a root (single-folder manifests)
  for (const fp of folderPlans) {
    if (seen.has(`${fp.folderId} ${fp.folderRoot}`)) continue;
    seen.add(`${fp.folderId} ${fp.folderRoot}`);
    const walk = dir => {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_e) { return; }
      for (const e of entries) {
        if (e.name.startsWith('.st')) continue;
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) { walk(abs); continue; }
        if (!e.isFile() || !MEDIA_EXT.has(path.extname(e.name).toLowerCase())) continue;
        try {
          const st = fs.statSync(abs);
          out.push({ folderId: fp.folderId, relPath: path.relative(fp.folderRoot, abs).split(path.sep).join('/'), sizeBytes: st.size, atime: Math.floor(st.atimeMs) });
        } catch (_e) { /* file vanished mid-walk */ }
      }
    };
    walk(fp.folderRoot);
  }
  out.sort((a, b) => (a.folderId.localeCompare(b.folderId)) || a.relPath.localeCompare(b.relPath));
  return out;
}

const inventoryHash = inv => crypto.createHash('sha256').update(JSON.stringify(inv)).digest('hex').slice(0, 16);

function loadState(ctx) {
  try { return JSON.parse(fs.readFileSync(path.join(ctx.stateDir, `${ctx.node}.json`), 'utf8')); } catch (_e) { return {}; }
}

function saveState(ctx, state) {
  fs.mkdirSync(ctx.stateDir, { recursive: true });
  fs.writeFileSync(path.join(ctx.stateDir, `${ctx.node}.json`), JSON.stringify(state));
}

async function runOnce(ctx) {
  const state = loadState(ctx);
  const manifest = await botApi(ctx, 'GET', `/agent/manifest/${encodeURIComponent(ctx.node)}`);
  const planChanged = manifest.planHash !== state.planHash;
  const folderPlans = resolveFolderPlans(ctx, manifest);

  // atime accuracy note (§3.2a): the inventory is collected BEFORE any pruning below could
  // touch files, and reading file *metadata* (stat) never bumps atime.
  const inventory = ctx.reportInventory ? collectInventory(ctx, folderPlans) : null;
  const invHash = inventory ? inventoryHash(inventory) : null;
  const inventoryChanged = inventory && invHash !== state.inventoryHash;

  if (!planChanged && !inventoryChanged) {
    ctx.log(`plan ${manifest.planHash} unchanged and inventory unchanged — nothing to do`);
    return { skipped: true, planHash: manifest.planHash };
  }

  const pruneResult = { dropped: [], bytesFreed: 0, errors: [] };
  let hardError = false; // a thrown safety abort / ignore-confirm failure (not a benign prune skip)
  if (planChanged) {
    for (const fp of folderPlans) {
      try {
        await assertReceiveOnly(ctx, fp.syncFolderId);                  // 2. topology guard
        writeStignore(ctx, fp);                                         // 3. ignore first
        const loaded = ctx.dryRun ? new Set(fp.drop.map(e => `/${escapeStignore(e.relPath)}`)) : await rescanAndConfirmIgnores(ctx, fp); // 4. confirm loaded
        const pr = pruneDrops(ctx, fp, loaded);                         // 5. then prune
        pruneResult.dropped.push(...pr.dropped);
        pruneResult.bytesFreed += pr.bytesFreed;
        pruneResult.errors.push(...pr.errors);
      } catch (err) {
        ctx.log(`ERROR [folder ${fp.syncFolderId || '(default)'}]: ${err.message}`);
        pruneResult.errors.push(err.message);
        hardError = true;
      }
    }
    // Advance the applied plan only if no folder hard-failed. Benign per-file prune skips (e.g. a
    // manifest entry that escapes the root) still count as converged for hysteresis, matching v1 —
    // a topology abort or unloaded-ignores failure must instead retry the whole plan next run.
    if (!ctx.dryRun && !hardError) state.planHash = manifest.planHash;
  }

  const report = {
    planHash: manifest.planHash,
    converged: planChanged && !pruneResult.errors.length,
    bytesFreed: pruneResult.bytesFreed,
    dropped: pruneResult.dropped,
    errors: pruneResult.errors,
  };
  if (inventoryChanged) report.inventory = inventory;
  await botApi(ctx, 'POST', `/agent/report/${encodeURIComponent(ctx.node)}`, report);
  if (inventoryChanged && !ctx.dryRun) state.inventoryHash = invHash;
  if (!ctx.dryRun) saveState(ctx, state);
  ctx.log(`done: plan ${manifest.planHash}${planChanged ? '' : ' (unchanged)'}, freed ${pruneResult.bytesFreed} bytes, ${pruneResult.errors.length} error(s)`);
  if (pruneResult.errors.length) process.exitCode = 1;
  return report;
}

if (require.main === module) {
  runOnce(buildCtx()).catch(err => {
    console.error(new Date().toISOString(), 'FATAL:', err.message);
    process.exit(1);
  });
}

module.exports = { buildCtx, parseFolders, runOnce, resolveFolderPlans, assertReceiveOnly, rescanAndConfirmIgnores, pruneDrops, collectInventory, escapeStignore, loadState, saveState };
