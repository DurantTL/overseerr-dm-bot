// California play-triggered promotion (#182, docs/edge-playback-architecture.md §2.2). Pure,
// DB/Discord/network-free logic mirroring the shape of staging.js's planPlayPromotion (the PH
// pilot) but adapted for the tier/Syncthing transport: a play-promotion "pin" instead of an
// rclone copy, a per-viewer bounded-active-pin cap instead of only a daily counter, and a
// locality decision that must be able to say "present but still transferring" (Syncthing
// completion), not merely "in the desired keep-set". index.js supplies every impure fact
// (agent inventory rows, active pin counts, the audit-only/enabled flags) and acts on what these
// functions return — nothing here touches a database, the network, or the filesystem.
const DAY_MS = 86400000;

// ---- generalized identity → tier-node routing ----
// The finding in #182 was that California's promotion path only had a dedicated CA_EDGE_SERVER_NAMES
// constant, not a real identity→node map — fine while there is exactly one tier Plex, a problem the
// moment a second one shows up. This generalizes it WITHOUT touching classifyServerIdentity() (the
// deletion-routing classifier in src/staging.js) at all — that function's 'ph'/'ca-edge'/'primary'/
// 'unknown' contract, and therefore every fail-closed deletion-routing guarantee it provides, is
// untouched by this module. resolveEdgeTierNode is consulted ONLY on the already-isolated
// 'ca-edge' branch, purely to decide which tier node a promotion pin belongs to.
//
// map entries: { identity, node } with identity already lowercased/trimmed (see
// parseEdgeTierNodeMap). Fails closed: an identity with no match returns null, never a guess.
function resolveEdgeTierNode({ serverName, machineId } = {}, map = []) {
  const ids = [serverName, machineId].map(v => String(v || '').trim().toLowerCase()).filter(Boolean);
  if (!ids.length || !Array.isArray(map) || !map.length) return null;
  for (const id of ids) {
    const hit = map.find(e => e && e.identity === id);
    if (hit) return hit.node;
  }
  return null;
}

// Validate/parse the `EDGE_TIER_NODE_MAP` env format: `identity:node,identity2:node2`. Malformed
// entries (no ':', empty identity, empty/invalid node name) are dropped with a reason rather than
// throwing — config.js surfaces `errors` as non-fatal startup warnings, consistent with how this
// repo treats every other identity-list env var (placeholders are filtered, not fatal).
function parseEdgeTierNodeMap(raw) {
  const entries = [];
  const errors = [];
  for (const part of String(raw || '').split(',').map(s => s.trim()).filter(Boolean)) {
    const i = part.indexOf(':');
    if (i <= 0 || i === part.length - 1) {
      errors.push(`EDGE_TIER_NODE_MAP entry "${part}" must be identity:node`);
      continue;
    }
    const identity = part.slice(0, i).trim().toLowerCase();
    const node = part.slice(i + 1).trim();
    if (!identity || !/^[a-z0-9][a-z0-9_-]*$/i.test(node)) {
      errors.push(`EDGE_TIER_NODE_MAP entry "${part}" has an invalid identity or node name`);
      continue;
    }
    entries.push({ identity, node });
  }
  return { entries, errors };
}

// Compose the final identity→node map: explicit EDGE_TIER_NODE_MAP entries first, then every
// legacy CA_EDGE_SERVER_NAMES identity synthesized onto `legacyNode` (default 'california') for
// anyone who never set the new var — so upgrading this repo changes NOTHING for an existing
// single-tier-node deployment. An identity present in both keeps its explicit mapping (first
// match wins in resolveEdgeTierNode), and a duplicate identity across the two sources is reported
// so an operator notices before it causes surprising routing, without refusing to start.
function buildEdgeTierNodeMap(rawMap, legacyCaNames = [], legacyNode = 'california') {
  const { entries, errors } = parseEdgeTierNodeMap(rawMap);
  const seen = new Set(entries.map(e => e.identity));
  const merged = [...entries];
  for (const identity of legacyCaNames) {
    const id = String(identity || '').trim().toLowerCase();
    if (!id) continue;
    if (seen.has(id)) {
      errors.push(`identity "${id}" is in both EDGE_TIER_NODE_MAP and CA_EDGE_SERVER_NAMES; the explicit EDGE_TIER_NODE_MAP entry wins`);
      continue;
    }
    seen.add(id);
    merged.push({ identity: id, node: legacyNode });
  }
  return { map: merged, errors };
}

// ---- locality: presence + completion, never the desired keep-set alone (§2.2b) ----
// "In the keep-set" only proves DESIRED, not present or fully synchronized — a title can be kept
// while Syncthing is still pulling it, has partially failed, or the agent hasn't converged yet, and
// in every one of those cases playback is still on the remote fallback. completionPct is the
// node's own Syncthing GET /rest/db/completion?folder=...&device=... percentage for the title's
// folder when the caller has it (null = not available yet; see the PR notes on this being an
// interim signal until the agent reports it). Byte comparison against completeFrac is the
// always-available fallback proof (mirrors tier.js's own physicalTitleBytes / completeFrac use).
function decideCaLocality({ presentBytes = 0, expectedBytes = 0, completionPct = null, completeFrac = 0.98 }) {
  if (!(expectedBytes > 0)) return { local: false, reason: 'unknown_size' };
  if (!(presentBytes > 0)) return { local: false, reason: 'absent' };
  if (completionPct != null && completionPct < 100) return { local: false, reason: 'syncthing_incomplete' };
  if (presentBytes < expectedBytes * completeFrac) return { local: false, reason: 'partial' };
  return { local: true, reason: 'synced' };
}

// ---- the promotion decision itself ----
// Mirrors staging.planPlayPromotion's action shape ('skip' | 'audit' | <do the thing>) so callers
// and audit-log readers already understand the vocabulary; the "do the thing" action is 'pin'
// (record a durable play-promotion pin) rather than 'enqueue' (a copy job), because California's
// promotion mechanism is "let the planner keep it", not "copy it directly" — see docs
// §2.2c. Order matters: cheapest/most-decisive skips first, exactly like the PH version.
//   enabled            — CA_PLAY_PROMOTE_ENABLED master switch
//   hasFullCopy        — the title actually exists on an enabled full master node; never promote
//                         something the master can't serve (mirrors planTier's noFullCopy guard)
//   alreadyLocal       — decideCaLocality(...).local
//   lastPromoteAt/cooldownMs — per-(node,title) debounce, mirrors PH's promote_last: cooldown
//   viewerActivePins/maxPinsPerViewer — bounded per-viewer cap: a viewer may only hold this many
//                         SIMULTANEOUS active pins on a node at once (distinct from PH's daily
//                         count cap — a CA pin holds persistent local storage for days, so the
//                         cap that matters is concurrent outstanding promotions, not just a
//                         24h counter; callers may additionally apply a daily counter the same
//                         way PH does and it composes fine — pass rateLimitOk:false through here)
//   rateLimitOk        — optional extra daily-counter gate (defaults true = not used)
//   auditOnly          — CA_PLAY_PROMOTE_AUDIT_ONLY: decide + log, never actually pin (dark rollout)
function planCaPlayPromotion({
  enabled,
  hasFullCopy,
  alreadyLocal,
  lastPromoteAt = 0,
  now = Date.now(),
  cooldownMs = 0,
  viewerActivePins = 0,
  maxPinsPerViewer = Infinity,
  rateLimitOk = true,
  auditOnly = false,
}) {
  if (!enabled) return { action: 'skip', reason: 'disabled' };
  if (!hasFullCopy) return { action: 'skip', reason: 'no_full_copy' };
  if (alreadyLocal) return { action: 'skip', reason: 'already_local' };
  if (lastPromoteAt && cooldownMs > 0 && (now - lastPromoteAt) < cooldownMs) return { action: 'skip', reason: 'cooldown' };
  if (!rateLimitOk) return { action: 'skip', reason: 'rate_limited' };
  if (viewerActivePins >= maxPinsPerViewer) return { action: 'skip', reason: 'viewer_pin_cap' };
  if (auditOnly) return { action: 'audit', reason: 'audit_only' };
  return { action: 'pin', reason: 'promote' };
}

// ---- durable, expiring pin records ----
// Pure shape; index.js/db.js persists these keyed UNIQUE(node, media_id) — an upsert, not an
// insert, so re-playing the same title while its pin is already active just refreshes the expiry
// instead of creating a second row (the "at most one" invariant lives at the storage layer via
// that unique key; this just computes the value to store).
function computePlayPin({ mediaId, viewerId, now = Date.now(), pinDays }) {
  return { mediaId, viewerId: viewerId ?? null, createdAt: now, expiresAt: now + Math.max(0, pinDays) * DAY_MS };
}

// Filter a list of pin rows ({ mediaId, expiresAt, ... }) down to the ones still active `now` —
// the same filter that must run BOTH when feeding pins into the planner's floor set (tier.js
// planTier) and when computing the manifest's pinnedRelPaths for the ignore-overlay subtraction,
// so a pin's expiry restores BOTH the planner's normal eviction behavior AND the legacy overlay's
// ignore rule in the same instant, with no separate "unpin" step required.
function activePlayPins(pins, now = Date.now()) {
  return (pins || []).filter(p => p && Number(p.expiresAt) > now);
}

// ---- pin-aware legacy ignore overlay (§182 BLOCKER) ----
// California's persistent manual overlay (`/etc/tier-agent/extra-ignores/<folderId>.txt`) is
// applied OUT-OF-BAND after the planner's own .stignore — so on its own it keeps ignoring a title
// forever, even once a play-promotion pin has moved that title into the planner's keep-set. The
// fix: the agent (or whatever applies the overlay) must compute the FINAL ignore set as
// `planner-drops ∪ legacy-ignores − active-promotion-pins`. All three inputs are `/escaped/relPath`
// strings in Syncthing .stignore syntax (matching escapeStignore in tier.js/agent.js) so this is a
// pure set operation; agent/agent.js carries its own copy of the escaping+merge step (it runs
// standalone on the edge box, no dependency on this repo's src/), but the algorithm here is the
// spec both implementations follow and this module's tests are the executable proof of it.
function computeFinalIgnoreLines({ plannerLines = [], legacyLines = [], pinnedLines = [] }) {
  const pinned = new Set(pinnedLines);
  const out = new Set();
  for (const l of plannerLines) if (!pinned.has(l)) out.add(l);
  for (const l of legacyLines) if (!pinned.has(l)) out.add(l);
  return [...out].sort();
}

module.exports = {
  DAY_MS,
  resolveEdgeTierNode,
  parseEdgeTierNodeMap,
  buildEdgeTierNodeMap,
  decideCaLocality,
  planCaPlayPromotion,
  computePlayPin,
  activePlayPins,
  computeFinalIgnoreLines,
};
