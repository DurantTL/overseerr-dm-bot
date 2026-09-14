# Mobile Request Wizard and PH Device Setup State

This document covers the two follow-on pieces added to guided setup in PR #222.

## Mobile Request Media wizard

The **Request Media** Quick Action no longer stops at a clickable `/request` mention. On mobile it now runs a short Discord-native wizard:

1. Tap **Request Media**.
2. Enter a movie or TV title in the modal.
3. The bot searches Seerr and shows up to 20 matching titles in a select menu, including year and existing Seerr/Plex status when available.
4. Pick the exact title.
5. **TV only:** pick one or more seasons, or **All Seasons**, from a select menu built from Seerr's own per-season status (seasons already fully requested/available are still listed — Seerr's `all` picks up only what's missing — but the /request slash-command path narrows an explicit pick and tells you which seasons it skipped). If Seerr can't be reached for the season list, the wizard falls back to All Seasons rather than blocking the request.
6. Choose **Request HD / 1080p** or **Request 4K**.
7. The selected request (including the season selection, movies always omit it) is forwarded into the existing `/request` handler.

The last point is important: the wizard does **not** duplicate request business logic. A proxy interaction is passed to the normal `/request` handler, so the existing rate limit, linked-user check, duplicate detection, subscriber behavior, Seerr quota check, admin approval gate, trust auto-approval, 4K rules, request persistence, and audit logging remain authoritative. Season selection (#255) is shared the same way: both the mobile wizard and the `/request seasons` option resolve through `src/season-select.js` and the same Seerr season-status lookup, so a season picked one way behaves identically to the other — persisted through pending approval, restart recovery, Seerr submission, duplicate/subscriber handling, `/request-status`, and `/request-cancel`. Movie requests are completely unaffected: they never carry a season selection.

Wizard selections are held only in a short-lived in-memory nonce map. They expire after 15 minutes and are bound to the Discord user that created them.

## PH device setup state

PH users can now keep a persistent record of which device types they have finished setting up:

- Phone / tablet
- Apple TV
- Android / Google TV
- Computer

From `/setup`, **PH Server Connection** opens the device dashboard. Each device can be opened for its device-specific Tailscale instructions, PH Plex test link, connection help/key flow, and **I Connected This Device** confirmation.

A confirmation is stored as an `app_settings` timestamp under:

```text
ph_device_confirmed:<discord_id>:<device>
```

Users can reset an individual device when replacing hardware or troubleshooting from scratch.

### What "confirmed" means

This is deliberately user-confirmed setup state, not a claim that Discord can continuously probe a viewer's VPN client. `/setup` labels it accordingly. A saved check means the member completed the device setup and confirmed it; it is not a live Tailscale health signal.

The PH setup summary treats the PH connection as complete when at least one PH device has a saved confirmation, while still showing each device independently. Main-server users never see these controls or state fields.
