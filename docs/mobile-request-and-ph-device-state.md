# Mobile Request Wizard and PH Device Setup State

This document covers the two follow-on pieces added to guided setup in PR #222.

## Mobile Request Media wizard

The **Request Media** Quick Action no longer stops at a clickable `/request` mention. On mobile it now runs a short Discord-native wizard:

1. Tap **Request Media**.
2. Enter a movie or TV title in the modal.
3. The bot searches Seerr and shows up to 20 matching titles in a select menu, including year and existing Seerr/Plex status when available.
4. Pick the exact title.
5. Choose **Request HD / 1080p** or **Request 4K**.
6. The selected request is forwarded into the existing `/request` handler.

The last point is important: the wizard does **not** duplicate request business logic. A proxy interaction is passed to the normal `/request` handler, so the existing rate limit, linked-user check, duplicate detection, subscriber behavior, Seerr quota check, admin approval gate, trust auto-approval, 4K rules, request persistence, and audit logging remain authoritative.

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
