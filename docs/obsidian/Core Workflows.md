---
tags:
  - project/overseerr-dm-bot
  - workflows
reviewed: 2026-08-16
source_commit: 1a803ac
---

# Core workflows

[[Project Home]] | [[Project Graph]] | [[Architecture]] | [[Data and Operations]]

## Member onboarding

An administrator can invite a member directly, post a reusable access-request button, or link an
existing Discord member to an email. The bot canonicalizes the email, prevents conflicting
real-user links, invites the account to Plex, creates or links the Seerr user, stores the Seerr
Discord notification identity, assigns the Discord role, and audits the result.

Pending approval state survives restarts. Expired requests and partial setup failures are surfaced
for retry rather than silently discarded.

## Request and approval

`/request` searches Seerr and submits as the linked member rather than the bot administrator. Admin
requests skip the local gate. Other requests are stored in SQLite and posted with Approve, Approve
with AvistaZ fallback, and Deny actions. Discord and dashboard approvals share the guarded request
operation, actor identity, and nonce behavior.

## Request tracking

Reconciliation combines local request rows with Seerr and arr state. Members see a four-stage
timeline: submitted, approved, downloaded, delivered. Queue errors, release dates, and stalled
states explain delays. Availability, terminal failure, and stalled outcomes can notify the
requester, subject to their stored notification preference.

## Public search and fallback

Public indexers receive the first opportunity through Sonarr or Radarr. If nothing is found, an
escalation watch can authorize AvistaZ after a delay. Automatic escalation is intentionally narrow:
obviously Asian television can qualify, movies require a human decision, and 4K requests never
escalate.

The direct-grab path searches AvistaZ through Prowlarr, ranks candidates, applies confidence and
allowance gates, sends approved torrents to rTorrent, copies completed content to writable staging,
then asks Sonarr or Radarr to import and verify it.

## Missing-episode recovery

Season-pack search handles old, dormant, or explicitly requested series when enough aired episodes
are missing. It records whether Sonarr filled a season with a pack, individual episodes, or a mix.
Partial and no-grab outcomes can include ranked interactive candidates and rejection reasons;
admins can force an eligible pack, while automatic forcing remains default-off and rechecks live
queue/duplicate state.

Episode recovery handles recent individual gaps after public and AvistaZ grace periods. The two
planners coordinate so episode recovery stands down when season-pack search owns the gap. Both
support side-effect-free previews using unsaved dashboard values.

## Playback, cleanup, and edge movement

Plex and Tautulli webhooks drive watched events, keep/delete prompts, requester updates, heavy
video-transcode alerts, and optional PH play-triggered staging. Cross-source watched events use a
shared durable identity so one playback does not create duplicate prompts.

Regional tiering builds per-node manifests from popularity, node demand, member requests, keep
lists, available capacity, and recent additions. The agent verifies the media mount and Receive
Only Syncthing mode before applying ignores or pruning files. Missing or partial inventory blocks
plan publication rather than risking an uncontrolled re-download.

The merged fallback mount remains an external rollout under #181. California play promotion (#182)
and season-level TV cache granularity (#183) are not yet implemented.
