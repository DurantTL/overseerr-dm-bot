# Production readiness for the Durant topology

The bot recognizes two viewing groups (**Main** and **Philippines**) and three storage roles:
full Main storage, California edge/cache, and Philippines edge/cache. California remains in the
Main viewing group even though its 3 TB disk is tier-managed. Philippines media capacity is the
5 TB external drive only; its 1 TB system SSD must not be counted or used as a fallback.

## Keep these safety switches off during rollout

```env
ENABLE_DELETION=false
DELETION_DRY_RUN=true
STAGING_ENABLED=false
EDGE_PROMOTE_ON_PLAY=false
```

Use `EDGE_PROMOTE_AUDIT_ONLY=true` only after identity routing passes `/doctor`. Enable copying
later, one edge at a time. Live deletion is a separate final decision and is not required for
normal requesting, downloading, viewing, tier planning, or dashboards.

## Required identity routing

```env
PH_SERVER_NAMES=<philippines Plex name and/or machine id>
CA_EDGE_SERVER_NAMES=<california Plex name and/or machine id>
PRIMARY_SERVER_NAMES=<full-main-1>,<full-main-2>,<full-main-3>
```

Every Tautulli payload must include `server_name` and `machine_id`. No value may overlap between
the lists. California playback is fail-closed out of deletion and Philippines staging. Only a
recognized full Main identity may reach the existing cleanup/deletion decision path.

## Storage and agent gates

- California: configure the tier node with the real 3 TB usable media budget, real media roots,
  Receive Only Syncthing folders, and `TIER_MOUNT_ROOT` plus either `TIER_EXPECTED_UUID` or a
  sentinel `TIER_MOUNT_MARKER`.
- Philippines: point all media folders and the mount guard at the 5 TB external drive. Do not put
  the 1 TB system SSD in `usable_bytes`, `TIER_FOLDERS`, staging cache roots, or mergerfs writable
  branches.
- Keep Syncthing and the tier agent on real storage paths, never the fake/merged Plex view.
- Require recent heartbeats and a clean agent report before publishing a tier plan.

## Deployment gate

1. Back up `/app/data` (database, WAL/SHM when present, rclone configuration) and the Portainer
   stack. Keep the last known-good image digest/tag.
2. Rotate Discord, Seerr, Plex, *arr, Cloudflare, dashboard, webhook, and agent credentials that
   have appeared in exported YAML or chat; store the replacements as Portainer secrets/variables.
3. Pin the bot image to a tested release or SHA for first deployment. If Watchtower is used, set
   `WATCHTOWER_LABEL_ENABLE=true` and label only the bot after the manual rollout succeeds.
4. Remove unnecessary `seccomp=unconfined`, oversized PID limits, and oversized ulimits from the
   bot service. The repository compose file does not require them.
5. Run the test suite, deploy with deletion/copying disabled, then run `/status`, `/doctor`, and
   the authenticated `/admin/doctor` endpoint.
6. Require Plex, Seerr, Radarr, Radarr 4K, Sonarr, Prowlarr, storage, identities, rclone, tunnel,
   and both edge agents to pass. Byparr may be disabled/unset if it is intentionally unused.

Rollback is: restore the prior pinned image, restore `/app/data` only if a database migration or
data repair misbehaved, and leave all destructive/copy switches disabled while diagnosing.
