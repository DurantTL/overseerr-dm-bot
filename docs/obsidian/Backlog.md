---
tags:
  - project/overseerr-dm-bot
  - backlog
reviewed: 2026-08-11
source_commit: b656155
github_snapshot: 19 open issues
---

# Backlog

[[Project Home]] | [[Project Graph]] | [[Project Review]] | [[Architecture]]

This is a snapshot of the live issue tracker on 2026-08-11. GitHub remains authoritative.

## Dashboard parity

- [#116 Global search](https://github.com/DurantTL/overseerr-dm-bot/issues/116): search requests, users, library, and audit from one authenticated endpoint.
- [#117 One-click actions](https://github.com/DurantTL/overseerr-dm-bot/issues/117): search, pin, run sweeps, and escalate from existing dashboard rows.
- [#118 Headless approval gate](https://github.com/DurantTL/overseerr-dm-bot/issues/118): separate approval behavior from Discord presentation.
- [#119 Dashboard approve or deny](https://github.com/DurantTL/overseerr-dm-bot/issues/119): depends on #118.
- [#120 Tier node setup](https://github.com/DurantTL/overseerr-dm-bot/issues/120): register nodes, rotate tokens, render the complete installer, and show convergence.
- [#121 Passkey sign-in](https://github.com/DurantTL/overseerr-dm-bot/issues/121): WebAuthn primary login with password fallback.
- [#134 Sweep preview](https://github.com/DurantTL/overseerr-dm-bot/issues/134): side-effect-free previews using unsaved automation values and shared planning logic.

## Silent failure and reliability

- [#122 Placeholder configuration](https://github.com/DurantTL/overseerr-dm-bot/issues/122): ignore known placeholders that currently alter routing or trigger false alerts, and warn once.
- [#125 Diagnosable fatal configuration](https://github.com/DurantTL/overseerr-dm-bot/issues/125): serve a 503 health reason and persist the last fatal error when startup validation fails.
- [#129 Persistent rate limits](https://github.com/DurantTL/overseerr-dm-bot/issues/129): move download counters and alert cooldowns into durable state.
- [#131 Verified backups](https://github.com/DurantTL/overseerr-dm-bot/issues/131): integrity-check backups, expose last success, alert when overdue, and rehearse restore.

## Member experience

- [#123 Who requested](https://github.com/DurantTL/overseerr-dm-bot/issues/123): admin title lookup across requesters and subscribers; command shape and visibility still need a decision.
- [#126 Cross-source watched dedupe](https://github.com/DurantTL/overseerr-dm-bot/issues/126): normalize Plex and Tautulli events to the same viewer/media identity when possible.
- [#127 Pending approval lifecycle](https://github.com/DurantTL/overseerr-dm-bot/issues/127): nudge, list, notify, and eventually expire unattended approvals.
- [#128 Failure and stall notices](https://github.com/DurantTL/overseerr-dm-bot/issues/128): send each requester one honest notification for failure, exhaustion, future release, or long stall.

## Foundations

- [#130 File-backed secrets](https://github.com/DurantTL/overseerr-dm-bot/issues/130): support the `KEY_FILE` convention with strict conflict and read-error behavior.
- [#133 Testable Express handlers](https://github.com/DurantTL/overseerr-dm-bot/issues/133): extract route groups incrementally, beginning with webhooks.

## Storage planning

- [#132 Capacity forecast](https://github.com/DurantTL/overseerr-dm-bot/issues/132): persist disk samples, estimate time to capacity, alert early, and connect cleanup suggestions to recovered time.

## Tracking issue and dependencies

[#124](https://github.com/DurantTL/overseerr-dm-bot/issues/124) is the umbrella issue. Its recommended sequence is:

`#122` -> `#125` -> `#116` -> `#117` -> `#127` -> `#133` for webhooks, followed by the remaining issues as demand requires.

The only explicit hard dependency is `#118` blocking `#119`. Coordination edges worth preserving are `#116` with `#123`, `#117` with `#134`, and the pending-list work shared by `#119` and `#127`. See [[Project Graph#Delivery graph]].

