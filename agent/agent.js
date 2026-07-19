#!/usr/bin/env node
// Tiering sync agent: the tiny per-node companion of the overseerr-dm-bot regional tiering
// planner. Runs on each edge node (systemd timer or container), pulls that node's manifest
// from the bot, and converges the local Syncthing replica onto it:
//
//   1. GET  <bot>/agent/manifest/<node>   (bearer token; plan_hash unchanged → no-op)
//   2. Assert the Syncthing folder is still Receive Only — abort loudly if not; that is the
//      only configuration under which this node could ever push a delete back to the master.
//   3. Write the manifest's .stignore into the folder root.
//   4. Trigger a Syncthing rescan and CONFIRM the ignores are loaded.
//   5. Only then prune: delete local files that are in `drop` AND ignored (ignored files are
//      never re-pulled; an un-ignored delete would just be re-downloaded).
//   6. POST a report back (bytes freed, errors, and — for atime nodes — the local file
//      inventory {relPath, sizeBytes, atime} that is the planner's demand signal).
//
// Standalone on purpose: Node 18+ stdlib only (global fetch), no discord.js, no *arr deps.
// Idempotent and safe on a schedule.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function buildCtx(env = process.env) {
  const need = k => {
    if (!env[k]) throw new Error(`Missing required env var ${k}`);
    return env[k];
  };
  return {
    botUrl: need('TIER_BOT_URL').replace(/\/$/, ''),
    node: need('TIER_NODE'),
    token: need('TIER_AGENT_TOKEN'),
    syncthingUrl: (env.SYNCTHING_URL || 'http://127.0.0.1:8384').replace(/\/$/, ''),
    syncthingApiKey: env.SYNCTHING_API_KEY || '',
    folderId: env.SYNCTHING_FOLDER_ID || '',
    folderRoot: need('TIER_FOLDER_ROOT').replace(/\/$/, ''),
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

// §4a step 1: the one check that protects the master. A Receive Only folder never pushes
// local changes; if someone flipped it to send-receive, pruning here would propagate deletes
// to every other node. Abort and let the bot alert.
async function assertReceiveOnly(ctx) {
  const folder = await syncthingApi(ctx, 'GET', `/rest/config/folders/${encodeURIComponent(ctx.folderId)}`);
  if (folder.type !== 'receiveonly') {
    throw new Error(`SAFETY ABORT: Syncthing folder '${ctx.folderId}' is type '${folder.type}', expected 'receiveonly' — pruning could propagate deletes to the master. Fix the folder type before this agent will touch anything.`);
  }
}

function writeStignore(ctx, manifest) {
  const target = path.join(ctx.folderRoot, '.stignore');
  if (ctx.dryRun) return ctx.log(`[dry-run] would write ${manifest.drop.length} ignore pattern(s) to ${target}`);
  fs.writeFileSync(target, manifest.stignore, 'utf8');
}

// §4a step 3: rescan, then verify Syncthing actually loaded our patterns before deleting
// anything. Deleting an un-ignored file loses no data — it just gets re-pulled — but the
// point of this agent is not to waste transpacific bandwidth.
async function rescanAndConfirmIgnores(ctx, manifest) {
  await syncthingApi(ctx, 'POST', `/rest/db/scan?folder=${encodeURIComponent(ctx.folderId)}`);
  const loaded = await syncthingApi(ctx, 'GET', `/rest/db/ignores?folder=${encodeURIComponent(ctx.folderId)}`);
  const lines = new Set(loaded.ignore || []);
  const missing = manifest.drop.map(e => `/${escapeStignore(e.relPath)}`).filter(l => !lines.has(l));
  if (missing.length) throw new Error(`Ignores not loaded for ${missing.length} drop path(s) (first: ${missing[0]}) — refusing to prune`);
  return lines;
}

function dirSizeBytes(target) {
  let total = 0;
  const st = fs.lstatSync(target);
  if (!st.isDirectory()) return st.size;
  for (const entry of fs.readdirSync(target)) total += dirSizeBytes(path.join(target, entry));
  return total;
}

// §4a step 4: prune drops that are confirmed ignored. Every path is resolved and checked to
// stay inside the folder root — a malicious or corrupt manifest must not reach outside it.
function pruneDrops(ctx, manifest, loadedIgnores) {
  const dropped = [];
  const errors = [];
  let bytesFreed = 0;
  for (const entry of manifest.drop) {
    const pattern = `/${escapeStignore(entry.relPath)}`;
    if (!loadedIgnores.has(pattern)) {
      errors.push(`skipped ${entry.relPath}: not in loaded ignores`);
      continue;
    }
    const target = path.resolve(ctx.folderRoot, entry.relPath);
    if (target !== ctx.folderRoot && !target.startsWith(`${ctx.folderRoot}${path.sep}`)) {
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
      dropped.push({ relPath: entry.relPath, bytes });
      bytesFreed += bytes;
    } catch (err) {
      errors.push(`delete failed ${entry.relPath}: ${err.message}`);
    }
  }
  return { dropped, bytesFreed, errors };
}

const MEDIA_EXT = new Set(['.mkv', '.mp4', '.avi', '.mov', '.wmv', '.m4v', '.ts', '.webm', '.mpg', '.mpeg', '.flv', '.iso']);

// Local media inventory for the report — the planner's atime (LRU) demand signal. Walks the
// folder root, skipping Syncthing internals; only media files are reported (posters/nfos would
// drown the signal and the payload).
function collectInventory(ctx) {
  const out = [];
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
        out.push({ relPath: path.relative(ctx.folderRoot, abs).split(path.sep).join('/'), sizeBytes: st.size, atime: Math.floor(st.atimeMs) });
      } catch (_e) { /* file vanished mid-walk */ }
    }
  };
  walk(ctx.folderRoot);
  out.sort((a, b) => a.relPath.localeCompare(b.relPath));
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

  // atime accuracy note (§3.2a): the inventory is collected BEFORE any pruning below could
  // touch files, and reading file *metadata* (stat) never bumps atime.
  const inventory = ctx.reportInventory ? collectInventory(ctx) : null;
  const invHash = inventory ? inventoryHash(inventory) : null;
  const inventoryChanged = inventory && invHash !== state.inventoryHash;

  if (!planChanged && !inventoryChanged) {
    ctx.log(`plan ${manifest.planHash} unchanged and inventory unchanged — nothing to do`);
    return { skipped: true, planHash: manifest.planHash };
  }

  let pruneResult = { dropped: [], bytesFreed: 0, errors: [] };
  if (planChanged) {
    try {
      await assertReceiveOnly(ctx);                                    // 2. topology guard
      writeStignore(ctx, manifest);                                    // 3. ignore first
      const loaded = ctx.dryRun ? new Set(manifest.drop.map(e => `/${escapeStignore(e.relPath)}`)) : await rescanAndConfirmIgnores(ctx, manifest); // 4. confirm loaded
      pruneResult = pruneDrops(ctx, manifest, loaded);                 // 5. then prune
      if (!ctx.dryRun) state.planHash = manifest.planHash;
    } catch (err) {
      ctx.log(`ERROR: ${err.message}`);
      pruneResult.errors.push(err.message);
    }
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

module.exports = { buildCtx, runOnce, assertReceiveOnly, rescanAndConfirmIgnores, pruneDrops, collectInventory, escapeStignore, loadState, saveState };
