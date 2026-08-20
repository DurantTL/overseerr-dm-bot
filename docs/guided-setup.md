# Guided setup and mobile quick actions

This document tracks the implementation behind issue #221.

## User goals

- New and existing users can run `/setup` at any time.
- `/me` keeps the existing profile/checklist information and adds mobile-friendly Quick Actions.
- Plex onboarding does not depend on the invite email arriving: users are shown how to create a Plex account, how to find their Plex username on phone/web/TV, and can save that username for a username-based server invite.
- Main users never see PH/Tailscale controls.
- `home_server=ph` users get a **PH Server Connection** section with device-specific Tailscale help.

## PH Server Connection

PH users can choose:

- Phone / tablet
- Apple TV
- Android / Google TV
- Computer

Each guide links to the configured Tailscale setup/download URL and explains the complete install → allow VPN → connect → test Plex flow.

Until Tailscale OAuth/API automation lands, **Request One-Time Key** sends an admin-channel request naming the member and device. The admin should generate a short-lived, one-off PH-viewer setup key and DM it to that member. Reusable administrative auth keys must not be sent to viewers.

When `TAILSCALE_SERVER_ADDRESS=ph-server.end-cobra.ts.net`, the setup UI derives the current PH Plex test/open URL as:

```text
http://ph-server.end-cobra.ts.net:32400/web
```

An explicit `PH_PLEX_URL` environment value may override the base URL. This is useful later if the server is moved to an HTTPS tailnet endpoint.

## Plex username flow

The setup wizard offers:

1. **Create Plex Account**
2. **Find My Plex Username**
3. **Enter Plex Username**
4. **Open Plex Web**

The username help has separate instructions for phone/tablet, computer/Plex Web, and smart TV. After a username is saved, an uninvited user gets an **Invite <username>** button so the bot can send the Plex share to the username instead of relying on the email invite path.

## Mobile Quick Actions

`/setup` and the enhanced `/me` surface buttons for:

- Request Media
- My Requests
- Request Status
- Downloads
- Setup / Troubleshooting
- Help

Discord does not allow a message button to directly execute another slash command on behalf of the user. For the existing command-backed actions, the button therefore returns the registered clickable slash-command mention; on mobile the user taps that command and gets the existing autocomplete/options flow. This intentionally reuses the existing command implementation rather than duplicating request business logic.

PH users additionally see PH Server Connection and Test/Open PH Plex actions.

## Implementation shape

The pure state/actions live in `src/setup.js`. Discord wiring lives in `src/setup-discord-extension.js` and is installed from `bootstrap.js` before `index.js` starts. The extension only owns `/setup`, the enhanced `/me`, and `setup:*` button/modal IDs; all unrelated Discord interactions continue to the existing handler unchanged.

## Remaining work

- Automate short-lived Tailscale device credentials through OAuth/API rather than the interim admin key request.
- Add admin **Send Setup Guide** tooling.
- Add a persistent Setup/Quick Actions button to other onboarding completion DMs where useful.
- Replace the extension hook with normal composition-root registration once the large Discord handler in `index.js` is split into modules.
