# Merged-library mount + Plex test-library — operational runbook (Phase 2/3)

This is the **operational** half of Phases 2 and 3: the mergerfs mount and the temporary Plex
test library that turn "a dropped title fails to play, no webhook fires" into "a dropped title
plays through the remote fallback, a real play event fires, the bot can promote it." None of it is
bot code — it is infra you stand up on each edge box — but it is a prerequisite for enabling
play-triggered promotion, so the sequence and the safety gates are captured here.

The design and rationale live in [`edge-playback-architecture.md`](edge-playback-architecture.md)
(§2.1 the merged library, §2.2 the bot layer). This file is the step-by-step **do-this-then-that**
that follows it, with verification and rollback at each step.

- **Phase 2 pilots on the Philippines (PH) cache box** — simpler transport (rclone cache, not
  Syncthing), and play-triggered promotion already exists behind flags.
- **Phase 3 repeats it on California** — same merged view, but the local branch is the existing
  Syncthing RAID and promotion is a planner pin, not an rclone copy.

> **Golden rule for the whole runbook:** the remote branch is **read-only, always**, and the tier
> agent / Syncthing must never see the merged path. The edge must never be able to mutate the master,
> and the pruning agent must only ever touch the real local branch. Every step below preserves those
> two invariants; if a step would break either, stop.

---

## 0. Preconditions (both boxes)

Confirm before touching mounts:

- [ ] Tailscale (or the existing mesh) is up and the edge can reach the master over it.
- [ ] The master exposes its library **read-only** over a transport rclone/sshfs can mount
      (rclone-serve SFTP/WebDAV, an SFTP account chrooted read-only, or a read-only NFS/SMB export).
      The account/key used here must have **no write capability** to the master — verify by trying to
      `touch` a file through it *before* you trust it (see step 1).
- [ ] `mergerfs` and `rclone` (or `sshfs`) are installed on the edge.
- [ ] You know the master's **top-level tree names** exactly: `Movies/` and `TV Shows/` (these are
      what `STAGE_MOVIES_SUBDIR` / `STAGE_TV_SUBDIR` default to). The local cache/branch **must** use
      the identical relative layout or mergerfs will treat a promoted copy as a *different* file and
      keep streaming the remote one. This path-layout fix already shipped on the bot side
      (`resolveStageSource`, `src/staging.js`); this runbook is the mount half of the same invariant.
- [ ] The bot's promotion flags are **all off**: `EDGE_PROMOTE_ON_PLAY=false`. You enable promotion
      only at the very end, after the mount is proven.

---

## Phase 2 — PH cache box

### 2.1 Read-only remote view of the master

Mount the master library read-only. Example with an rclone remote `master:` that points at the
master's library root, served read-only over the tunnel:

```bash
sudo mkdir -p /mnt/master-ro
rclone mount master:/library /mnt/master-ro \
  --read-only \
  --allow-other \
  --dir-cache-time 12h \
  --vfs-cache-mode off \
  --daemon
```

`sshfs` alternative:

```bash
sshfs -o ro,allow_other,reconnect master-ro@master-host:/srv/library /mnt/master-ro
```

**Prove read-only before continuing** — this is the master-safety check, not a formality:

```bash
touch /mnt/master-ro/__wtest 2>&1 | grep -qi 'read-only\|permission denied' \
  && echo "OK: remote branch is read-only" \
  || { echo "FAIL: remote branch is WRITABLE — stop, fix the export/account"; rm -f /mnt/master-ro/__wtest; }
```

Verify the tree matches what the cache will use:

```bash
ls /mnt/master-ro            # expect: Movies  'TV Shows'  (exact names)
```

### 2.2 Local-first mergerfs view

The PH local branch is the rclone **cache root** (`STAGE_RCLONE_REMOTE`'s local side — where the
stage worker copies to). Merge local-first over the read-only remote:

```bash
sudo mkdir -p /mnt/plex-library
mergerfs -o category.create=ff,func.getattr=ff,ro=false,allow_other,use_ino \
  /mnt/cache=RW:/mnt/master-ro=RO \
  /mnt/plex-library
```

- `category.create=ff` (first-found) + branch order `local:RW` then `remote:RO` = **local wins**;
  reads prefer the cached copy and fall through to the remote only when the file is absent locally.
- The remote branch is tagged `RO`, so mergerfs will **never create** into it — new files (future
  promotions) can only land in the local cache branch. This is what keeps the master untouchable
  through the merged view.

Sanity-check the merge:

```bash
# A title that exists ONLY on the master shows through:
ls "/mnt/plex-library/Movies" | head
# A title present in the local cache resolves to the LOCAL copy (same relative path):
readlink -f "/mnt/plex-library/Movies/<a cached title>/<file>.mkv"   # → /mnt/cache/...
```

If a cached title resolves to `/mnt/master-ro/...` instead of `/mnt/cache/...`, the path layout does
**not** match — fix the cache tree (it must be `Movies/<folder>` / `TV Shows/<folder>`) before going
further, or promotions will be invisible.

### 2.3 Temporary Plex test library on the merged view

Do **not** repoint the production PH library yet. Add a **new, temporary** library so a mistake is
trivially reversible:

1. Plex → Settings → Libraries → **Add Library** → Movies → point it at
   `/mnt/plex-library/Movies`. Repeat for TV → `/mnt/plex-library/TV Shows`.
2. Name them clearly (e.g. `TEST — Merged Movies`) so nobody confuses them with production.
3. Let them scan. Expect the **full master catalogue** to appear (remote branch supplies every
   title), with cached titles served locally.

### 2.4 Verify local + remote playback

- [ ] **Local play:** start a title you know is cached locally. Confirm it plays and that
      `iostat`/`nethogs` shows disk reads, not tunnel traffic.
- [ ] **Remote play:** start a title that is **only** on the master (not cached). Confirm it plays
      through the tunnel (expect tunnel bandwidth, higher start latency). This is the case that
      previously failed — it must now succeed.
- [ ] **Play event fires:** confirm Tautulli/Plex emits a play-*start* for the remote play (this is
      the signal the bot's promotion path keys off). With promotion still off, nothing is copied yet —
      you're only proving the event exists.

### 2.5 Remote-master outage test (the failure mode that matters)

Simulate the tunnel/master going down and confirm the edge degrades gracefully instead of hanging:

```bash
# Drop the remote branch (kill the rclone/sshfs mount):
fusermount -u /mnt/master-ro    # or: systemctl stop the mount unit
```

- [ ] **Cached titles still play** (they're on the local branch — mergerfs serves them with the
      remote branch gone).
- [ ] Uncached titles fail *cleanly* (Plex shows unavailable), and the box does **not** lock up on a
      hung mount. If reads hang, add `x-systemd.mount-timeout` / rclone `--timeout` and a health-check
      restart to the mount unit before relying on this in production.
- [ ] Restore the remote mount and confirm uncached titles play again.

Wire the mount's health into the existing tunnel watchdog if you want alerting:
`PH_TUNNEL_HEALTH_URL` already pings the PH tunnel and alerts after
`PH_TUNNEL_FAILS_BEFORE_ALERT` failures.

### 2.6 Reconcile the staging DB against disk

Before promotion writes anything, make sure the bot's view of the cache matches reality — orphaned
or stale `staged_items` rows would make promotion decisions wrong. This is automated:

- `reconcileStagedItems` (`src/staging.js`) runs at startup and every `STAGE_RECONCILE_MINUTES`
  (default 30). It verifies each row against the cache drive and drops/re-queues mismatches.
- Confirm a clean pass in the logs (`sweepStagedReconciliation`) and that `/stage` status /
  the dashboard's cache view matches `rclone lsjson` of the cache root.

### 2.7 Enable promotion — audit-only first, then real

**Audit-only** (decides + logs, copies nothing):

```env
EDGE_PROMOTE_ON_PLAY=true
EDGE_PROMOTE_AUDIT_ONLY=true
```

- Play several uncached titles. Confirm the bot logs `edge_promote_would_stage` for each, with sane
  cooldown/cap behaviour (`EDGE_PROMOTE_COOLDOWN_HOURS`, `EDGE_PROMOTE_MAX_PER_USER_PER_DAY`).
- Confirm it does **not** fire for titles already cached (present + complete).

**Real promotion** (flip audit off once the audit log looks right):

```env
EDGE_PROMOTE_ON_PLAY=true
EDGE_PROMOTE_AUDIT_ONLY=false
```

- Play an uncached title → the stage worker copies it into `/mnt/cache/Movies/<folder>` (or
  `TV Shows/...`). Because playback is already happening through the fallback, the copy just makes
  the **next** play local.
- After the copy, confirm the merged path now resolves that title to the **local** branch
  (`readlink -f` → `/mnt/cache/...`) and the next play reads from disk, not the tunnel.

### 2.8 Cut production over (optional, once confident)

Only after the test library has behaved through steps 2.4–2.7: repoint the production PH library at
`/mnt/plex-library`, let it match up (same GUIDs, so watch history is preserved), and remove the
temporary `TEST —` libraries. Keep the mounts under systemd units with restart-on-failure.

---

## Phase 3 — California edge (after PH is stable)

Same shape, two important differences: the **local branch is the Syncthing RAID**, and promotion is
a **planner pin**, not an rclone copy.

### 3.1 Read-only remote branch + local-first merged view

Identical to §2.1/§2.2, but the local branch is California's existing Syncthing library root:

```bash
mergerfs -o category.create=ff,func.getattr=ff,allow_other,use_ino \
  /mnt/raid/library=RW:/mnt/master-ro=RO \
  /mnt/plex-library
```

Run the same read-only proof (`touch` through `/mnt/master-ro`) and the same local-first resolution
check.

### 3.2 Keep Syncthing and the tier agent OFF the merged path

This is the California-specific safety boundary:

- [ ] Syncthing stays pointed **only** at the real RAID folders (`/mnt/raid/library/...`), exactly as
      today — Receive-Only, `.stignore`-driven. It must **not** be pointed at `/mnt/plex-library`.
- [ ] The tier agent's `TIER_FOLDER_ROOT` / `TIER_FOLDERS` stay on the **real** RAID roots, never the
      merged path. The agent prunes the local branch; if it saw the merged view it could try to delete
      files that only exist on the remote branch. (The agent's own mount guard —
      `TIER_MOUNT_ROOT` + UUID/marker — already refuses to run if a folder root isn't on the real
      media drive; keep those set so a misconfiguration fails closed.)
- [ ] mergerfs `RO` on the remote branch guarantees promotions (new local files) only ever land in
      the RAID branch — i.e. only Syncthing ever writes California's local files. Preserve that
      invariant; do not add a second writer to the merged path.

Because the `.stignore` drops now leave a title **visible and playable via the remote branch** while
occupying zero RAID, existing tier evictions become safe on the merged view — a dropped title is a
fallback stream, not a missing file.

### 3.3 Test library, playback, outage, reconcile — same as PH

Repeat §2.3–§2.6 on California:

- temporary `TEST — Merged` libraries on `/mnt/plex-library`,
- verify local + remote playback and that a remote play emits an event,
- **outage test:** drop `/mnt/master-ro` and confirm RAID-local titles still play and the box doesn't
  hang,
- reconcile: here "DB vs disk" is the tier planner's converged state vs the agent's reported
  inventory — confirm `/tier preview node:california` shows the physical inventory and the agent's
  **heartbeat is fresh** (`/tier-node list` now shows `agent <age>` per node; a stale heartbeat means
  the agent isn't converging and promotion would strand titles on the fallback).

### 3.4 California play-promotion — the bot pieces this runbook depends on

Unlike PH, real California promotion is **not** just a flag flip — it needs the bot-side work in
`edge-playback-architecture.md` §2.2 that is **not yet built**:

- a play-promotion **pin** that feeds the planner as an extra floor (`TIER_PLAY_PIN_DAYS`),
- **pin-aware ignore generation** (replace the out-of-band overlay with first-class DB policies —
  `manual_exclusion` / `permanent_pin` / `temporary_play_pin` / `planner_drop` / `safety_force_keep`
  — so a promotion pin actually un-ignores the title; today's overlay can keep a title ignored even
  after the planner moves it into the keep set),
- an authenticated **"run now"** path so a pin converges immediately instead of on the next ~6 h
  timer.

Until those land, California runs **merged-view read-only**: the full library is visible and every
title is playable (locally if cached, via the fallback if not), tier evictions are safe, but
promotion stays manual (`/tier pin` recompute + apply). Stand up the mount now; enable automatic
promotion when §3.4's bot work is done. **Do not** point Syncthing or the tier agent at the merged
path to work around the missing pieces.

---

## Rollback (either box)

The whole runbook is reversible because the production library is never touched until the final,
optional cut-over:

1. In Plex, delete the temporary `TEST —` libraries (production is still on its original path).
2. `EDGE_PROMOTE_ON_PLAY=false` (stops any further copies).
3. Unmount, innermost first: `fusermount -u /mnt/plex-library` then `fusermount -u /mnt/master-ro`.
4. The local branch (cache / RAID) is unchanged by any of the above — nothing local is lost.

If you had already cut production over (§2.8), repoint the production library back at the raw local
branch before unmounting.

---

## Status this runbook leaves in place

```
PH merged fallback mount:           runbook ready — infra stand-up (this doc)
PH play promotion:                  code ready, gated by EDGE_PROMOTE_ON_PLAY (enable per §2.7)
California merged fallback mount:    runbook ready — infra stand-up (this doc, §3)
California play promotion:           needs bot work (edge-playback §2.2 / roadmap Phase 3) before enabling
Season-level TV planning:            Phase 4, untouched
```
