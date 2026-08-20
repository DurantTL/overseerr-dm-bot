# Guided setup and mobile quick actions

This document tracks the implementation behind issue #221 and PR #222.

## User goals

- New, existing, and partially-linked users can return to `/setup` at any time.
- `/me` keeps the existing profile/checklist information and adds mobile-friendly Quick Actions.
- Plex onboarding does not depend on the invite email arriving: users are shown how to create a Plex account, find their Plex username on phone/web/TV, save it, and send the server share to the username.
- Main users never see PH/Tailscale controls.
- `home_server=ph` users get a **PH Server Connection** section with device-specific Tailscale help and persistent per-device setup state.
- Existing onboarding DMs receive a **Setup / Troubleshooting** entry point automatically.

## Plex username flow

The setup wizard offers the appropriate next actions based on the user record:

1. **Create Plex Account**
2. **Find My Plex Username**
3. **Enter Plex Username** once the Discord/access-request record exists
4. **Invite <username>** when Plex access is not yet confirmed
5. **Open Plex**

The username help has separate instructions for phone/tablet, computer/Plex Web, and smart TV. Username-based sharing avoids depending on Plex's invitation email delivery.

After a username share is sent, the bot reads the Plex user/friends list back. `invited=1` is only set when Plex recognizes that saved username. A successful POST without a matching read-back is shown as **Share Sent, Not Yet Verified** rather than a false completion.

Admins can resend the personalized guide to an existing member with:

```text
/send-setup user:@member
```

## PH Server Connection

PH users can choose:

- Phone / tablet
- Apple TV
- Android / Google TV
- Computer

The device flows are intentionally platform-aware:

- Phone/tablet: normal Tailscale sign-in/invite flow.
- Apple TV: supports the one-time auth-key path.
- Android/Google TV: QR/generated-code flow with admin help when needed.
- Computer: one-time auth key when OAuth provisioning is enabled.

When Tailscale OAuth is configured, Apple TV/computer credentials are one-off, short-lived, pre-authorized `tag:ph-viewer` keys. The secret is shown only in the requesting user's ephemeral Discord response and is never stored in SQLite or audit metadata. If OAuth is not configured or fails, the bot falls back to asking an admin for device-specific help.

Each PH device also has a saved **I Connected This Device** confirmation. This is onboarding state, not a live VPN probe. `/setup` remembers phone/tablet, Apple TV, Android/Google TV, and computer independently and allows the user to reset a device later.

When `TAILSCALE_SERVER_ADDRESS=ph-server.end-cobra.ts.net`, the setup UI derives:

```text
http://ph-server.end-cobra.ts.net:32400/web
```

An explicit `PH_PLEX_URL` overrides that base. If Tailscale Serve is enabled for Plex, use the HTTPS tailnet endpoint there.

## Mobile Quick Actions

`/setup` and `/me` surface buttons for:

- Request Media
- My Requests
- Request Status
- Downloads
- Setup / Troubleshooting
- Help

PH users additionally see PH Server Connection/Test actions.

### Request Media

**Request Media** is a Discord-native mobile wizard:

1. Tap **Request Media**.
2. Enter a movie or TV title.
3. Pick the correct Seerr result.
4. Choose HD/1080p or 4K.
5. The final choice is forwarded into the existing `/request` handler.

The wizard does not fork request business logic. The existing linked-user check, rate limit, duplicate/subscriber behavior, quota enforcement, admin approval gate, trust auto-approval, 4K rules, persistence, and audit behavior remain authoritative.

The remaining command-backed Quick Actions return the registered clickable slash-command mention, because Discord buttons cannot directly execute another slash command as the user.

## Implementation shape

- `src/setup.js` — pure setup state/action model.
- `src/setup-discord-extension.js` — base `/setup`, enhanced `/me`, Plex username flow, and quick actions.
- `src/setup-discord-enhancements.js` — `/send-setup`, Plex read-back verification, and Tailscale provisioning interception.
- `src/setup-device-state.js` — persistent PH device confirmations and PH device dashboard.
- `src/setup-request-ui.js` — mobile Request Media modal/select flow that routes into the existing `/request` handler.
- `src/setup-dm-bridge.js` — adds Setup / Troubleshooting to existing welcome/setup-completion DMs.
- `src/tailscale-provision.js` — scoped Tailscale OAuth/auth-key client.
- `bootstrap.js` — installs all guided-setup layers before `index.js` starts.

## Remaining cleanup

The feature is intentionally layered around the current large `index.js` composition root. Once Discord/onboarding/request handling is split into normal services, these wrapper hooks should be folded into that composition directly. Optional future work can correlate saved PH device state with live Tailscale device inventory, but the current UI deliberately does not claim that user-confirmed setup is a live VPN health check.
