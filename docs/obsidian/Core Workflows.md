---
tags:
  - project/overseerr-dm-bot
  - workflows
reviewed: 2026-08-11
source_commit: b656155
---

# Core workflows

[[Project Home]] | [[Project Graph]] | [[Architecture]] | [[Data and Operations]]

## Member onboarding

An administrator can invite a member directly, post a reusable access-request button, or link an existing Discord member to an email. The bot canonicalizes the email, prevents conflicting real-user links, invites the account to Plex, creates or links the Seerr user, stores the Seerr Discord notification identity, assigns the Discord role, and audits the result.

The headline failure mode is silent loss of the member journey. Existing code handles several of these cases, while [[Backlog#Member experience|issues #127 and #128]] cover pending approvals and unsuccessful requests that can still become invisible to users.

## Request and approval

`/request` searches Seerr and submits as the linked member rather than the bot administrator. Admin requests skip the local gate. Other requests are stashed in SQLite and posted to Discord with Approve, Approve with AvistaZ fallback, and Deny actions.

Approval currently mixes Discord presentation with Seerr creation, verification, local state, trust updates, escalation setup, audit, and requester notification. [[Backlog#Dashboard parity|#118]] separates that work into a headless operation so [[Backlog#Dashboard parity|#119]] can safely reuse it from the dashboard.

## Request tracking

Reconciliation combines local request rows with Seerr and arr state. Members see a four-stage timeline: submitted, approved, downloaded, delivered. Queue errors and release dates can explain waiting states. Availability triggers DMs to the requester and any subscribers.

The remaining gap is proactive communication when a request fails, exhausts fallback options, or stalls without a release date. That is [[Backlog#Member experience|#128]].

## Public search and fallback

Public indexers receive the first opportunity through Sonarr or Radarr. If nothing is found, an escalation watch can authorize AvistaZ after a delay. Automatic escalation is intentionally narrow: obviously Asian television can qualify, movies require a human decision, and 4K requests never escalate.

The direct-grab path is:

1. Search AvistaZ through Prowlarr.
2. Rank candidates by identity, coverage, quality, seeders, size, and allowance.
3. Auto-grab only when configured and sufficiently confident; otherwise request approval.
4. Send the torrent bytes to rTorrent and keep the seedbox copy seeding.
5. Copy completed content with rclone to writable staging.
6. Ask Sonarr or Radarr to import and verify the result.

## Missing-episode recovery

Season-pack search handles old, dormant, or explicitly requested series when enough aired episodes are missing. Episode recovery handles recent individual gaps after public and AvistaZ grace periods. The two planners coordinate so episode recovery stands down when season-pack search owns the gap.

[[Backlog#Dashboard parity|#134]] proposes a shared, side-effect-free planning layer so operators can preview both paths using unsaved settings without consuming indexer or tracker allowance.

## Playback, cleanup, and edge movement

Plex and Tautulli webhooks drive watched events, keep/delete prompts, requester updates, and optional play-triggered staging. Cross-source watched-event identity is still source-specific, so the same play can produce two prompts; [[Backlog#Member experience|#126]] addresses that.

Regional tiering builds per-node manifests from universal popularity, node demand, member requests, keep lists, available capacity, and recent additions. The agent verifies the storage mount and Receive Only Syncthing mode before applying ignores or pruning files. Missing inventory blocks plan application rather than risking an uncontrolled re-download.
