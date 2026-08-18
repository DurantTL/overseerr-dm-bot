# Plex Home Staging (remote cache box)

A second, small Plex server (e.g. a NUC abroad, behind CGNAT and a VPS tunnel) serves a local
**cache** of the master library. The bot manages that cache from Discord:

- `/stage <title>` — the verb the rest of the stack doesn't have. Overseerr can't request a
  title that's already Available, and Plex won't copy between servers. The bot resolves the
  folder from Radarr/Sonarr and runs `rclone copy` into the cache; the requester gets a DM when
  it's warm. Cold titles stop being mysterious buffering and become an announced wait.
- **Durable queue** — stage jobs live in SQLite (`stage_jobs`). A restart mid-copy re-queues the
  job; `rclone copy` skips files that already transferred, so resuming is cheap.
- **Disk-pressure guard** — before each copy the bot checks free space (`rclone about`, falling
  back to a `STAGE_CACHE_MAX_GB` budget). If space is short it evicts least-recently-streamed
  unpinned titles (announced in the cleanup channel), or refuses with a clear message when even
  that wouldn't be enough.
- `/pin` / `/unpin` (admin) — exempt weekly-rewatch titles from eviction. `/staged` (admin) shows
  the cache; `/stage-bulk` (admin) seeds it from a pasted list — do this on LAN at gigabit before
  flying. All three can be granted to a specific role (e.g. PH users) in Server Settings →
  Integrations without code changes.
- **Auto-stage** — when a PH user's request finishes importing on the master
  (`MEDIA_AVAILABLE`), the bot stages it automatically and DMs when it's ready to play.
- **Play-triggered promotion** (`EDGE_PROMOTE_ON_PLAY`, off by default) — when a PH viewer
  *starts* a title that isn't cached yet, the bot stages it so the next play is local. Needs a
  Tautulli "Playback Start" webhook (event `play`) and/or Plex `media.play`/`media.resume`
  carrying the PH server identity. `EDGE_PROMOTE_AUDIT_ONLY=true` logs the decision
  (`edge_promote_would_stage`) without copying — run it that way first. Promotions have their own
  per-watcher daily cap (`EDGE_PROMOTE_MAX_PER_USER_PER_DAY`, attributed to the linked Tautulli
  email) and a per-title cooldown (`EDGE_PROMOTE_COOLDOWN_HOURS`) so a binge can't re-copy. This
  is the bot half of the edge remote-fallback design (`edge-playback-architecture.md`); the
  mergerfs remote-fallback mount that lets the missing title play *while* it copies is the infra
  half, done on the box.
- **Tunnel watchdog** — `PH_TUNNEL_HEALTH_URL` is polled; state transitions alert the system
  channel, and `/status` + `/staged` show tunnel state, cache free space, and active jobs.

## Server-aware webhook routing (the footgun guard)
Plex/Tautulli events now carry a server identity and every handler is gated on it:

- Events matching `PH_SERVER_NAMES` route to the **eviction** flow: the familiar finished-watching
  prompt, but "Free Up Space" only purges the *cache* copy — the master file is untouched.
- Events matching `CA_EDGE_SERVER_NAMES` are recorded as California edge playback and never enter
  either the Philippines staging flow or the full-Main deletion flow. Its tier agent owns storage.
- Events matching `PRIMARY_SERVER_NAMES` route to the existing keep/delete flow. Put only the
  three full Main storage servers here, not California.
- Once either edge list is set, events with **no** recognizable identity are skipped (fail-safe):
  a PH viewer finishing a movie must never reach a `delete_yes` that deletes the master.

Setup:
1. On the **PH box's Tautulli**, point the webhook at the same `POST /webhook/tautulli` endpoint
   and include the server identity in the JSON payload:
   `"server_name": "{server_name}", "machine_id": "{machine_id}"` (add the same two fields to the
   master's Tautulli payload too, or set `PRIMARY_SERVER_NAMES` and keep them matching).
2. Set `PH_SERVER_NAMES` to the PH box's server name and/or machine id, set
   `CA_EDGE_SERVER_NAMES` to California's identity, and set `PRIMARY_SERVER_NAMES` to only the
   full Main storage servers (all lowercase; no overlaps).
3. Configure an rclone remote that reaches the PH cache (e.g. SFTP through the VPS tunnel), mount
   the config into the container, and set `STAGE_RCLONE_REMOTE` (e.g. `phbox:/cache`) plus
   `STAGE_RCLONE_FLAGS=--config /app/data/rclone.conf`.
4. `STAGING_ENABLED=true`, and set `STAGE_CACHE_MAX_GB` if the remote can't answer `rclone about`.
5. Run `npm run doctor:edge` on the bot host (or `/doctor` in Discord). Do not enable automatic
   promotion until the Main source, Philippines cache read, tunnel, and free-space checks pass.

## Reaching the PH box: Tailscale (optional, per-person)
The Cloudflare tunnel covers the bot's own HTTP routes (dashboard, webhooks, downloads) — it is
never used for media, per Plex's ToS. That leaves the PH box's actual playback traffic with no
reachable path for a remote viewer: it's behind CGNAT and has no IPv6, so Plex's normal remote
access can't punch through either.

Tailscale solves that at the network layer instead of proxying media through a CDN: the PH box
joins your tailnet, viewers install Tailscale and join too, and their Plex client talks to the
box's stable `100.x.x.x` tailnet address directly (peer-to-peer when possible, relayed only as a
NAT-traversal fallback).

This is opt-in per person, not a default part of onboarding — most admins will only want it for
the handful of people actually assigned to the PH box:

1. Set `TAILSCALE_ENABLED=true`. This adds a third **Approve + Tailscale (PH)** button next to
   Approve/Deny on new access-request DMs — nothing changes for the plain **Approve** button.
2. Optionally set `TAILSCALE_SERVER_ADDRESS` to the PH box's tailnet hostname/IP so the bot can
   include it directly in the DM; leave it blank to tell the user an admin will send it.
3. When a request comes in from someone who needs the PH box, click **Approve + Tailscale (PH)**
   instead of **Approve**. The bot assigns them to `home_server=ph` (same as `/assign-server`),
   runs the normal Plex/Seerr invite chain, and appends Tailscale setup steps to their DM.
4. Separately (outside the bot — there's no Tailscale API integration here), invite that person
   to your tailnet from the Tailscale admin console, since you're deciding this case by case
   anyway.

## One server per person
Plex does **not** sync watch state between servers — separate Continue Watching, separate watched
marks, separate Tautulli history. So each person belongs to exactly one server:

- `/assign-server user:@X server:ph` marks a PH user. Invites (`/link`, `/invite`, `/reinvite`,
  access-request approvals) then go **only** to servers matching `PH_SERVER_NAMES`; everyone else
  is invited to everything *except* the PH box. With `PH_SERVER_NAMES` unset, invites behave as
  before (all servers).
- Revocation (leave-server button, `/unlink`, sync-fix orphan cleanup) always sweeps **every**
  server in the account — including ones in `PLEX_EXCLUDE_SERVERS` — so nobody keeps quiet access
  to an "excluded" box after losing access.
