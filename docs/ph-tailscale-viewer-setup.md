# PH viewer Tailscale setup

This is the PH-only remote-access path for Durant Media Server users. Main/USA users never see or need these controls.

## Why this exists

The PH Plex server is behind CGNAT and has no usable public IPv4/IPv6 path, so remote viewers need a private Tailscale path to Plex when they are away from the PH LAN.

The Discord setup wizard exposes device-specific instructions under `/setup` only when `home_server=ph`.

## Recommended identity model for personal viewer devices

For personal phones, tablets, laptops, desktops, Apple TVs, and Android/Google TVs, use the viewer's normal Tailscale user identity/invite flow. Current Tailscale guidance recommends tags for non-human/shared infrastructure rather than end-user devices, because applying a tag replaces the user's identity on that device.

That means the recommended production setting for ordinary household/member devices is:

```env
TAILSCALE_API_ENABLED=false
```

The bot still guides the user through installing Tailscale and asks an admin for connection help when needed. The admin supplies the appropriate Tailscale user/tailnet invitation. Do not hard-code a permanent external-user invite URL into Discord; unused invite links expire and user access should be revocable independently.

## Device behavior

Tailscale does not use the same onboarding UX on every platform, so the bot deliberately avoids pretending one key workflow works everywhere.

- **iPhone/iPad and Android phones/tablets:** normal Tailscale account/invite + VPN flow.
- **Apple TV:** normal login/QR flow is preferred for a personal TV. The client also supports auth keys, but tagged key provisioning should be reserved for a deliberately shared/non-human appliance identity.
- **Android / Google TV:** prefer the QR code or generated-code flow shown by the Tailscale TV app.
- **Computer:** normal user login is preferred for a personal computer. The optional auth-key path exists for deliberately shared/non-human appliances.

## Minimum bot configuration

The normal PH setup buttons need:

```env
PLEX_SIGNUP_URL=https://www.plex.tv/sign-up/
PLEX_WEB_URL=https://app.plex.tv/
TAILSCALE_ENABLED=true
TAILSCALE_SETUP_URL=https://tailscale.com/download
TAILSCALE_SERVER_ADDRESS=ph-server.end-cobra.ts.net
PH_PLEX_URL=http://ph-server.end-cobra.ts.net:32400
TAILSCALE_API_ENABLED=false
```

`PH_PLEX_URL` is the base URL. Discord appends `/web` to the Open/Test buttons. If it is omitted, the bot derives `http://TAILSCALE_SERVER_ADDRESS:32400`.

If Plex is later exposed inside the tailnet through Tailscale Serve, set `PH_PLEX_URL` to that HTTPS tailnet base instead.

## Optional tagged appliance provisioning

The repo still supports OAuth client-credentials provisioning for a deliberately shared/non-human viewer appliance. Do not enable this merely to simplify onboarding for personal user-owned devices.

Create a Tailscale OAuth client in **Trust credentials** with the **Auth Keys** scope and permission to mint the selected appliance tag, then configure:

```env
TAILSCALE_API_ENABLED=true
TAILSCALE_OAUTH_CLIENT_ID=your-oauth-client-id
# Prefer Docker/Portainer secret files if the secret is mounted into the container:
# TAILSCALE_OAUTH_CLIENT_SECRET_FILE=/run/secrets/tailscale_oauth_client_secret
# Or inline when no secret mount is available. Never set both forms.
TAILSCALE_OAUTH_CLIENT_SECRET=
TAILSCALE_TAILNET=-
TAILSCALE_VIEWER_TAG=tag:ph-viewer
TAILSCALE_DEVICE_KEY_TTL_SECONDS=1800
```

The OAuth client must be allowed to create the configured tag. Generated auth keys are one-off, non-ephemeral, preauthorized, and short-lived before first use. The secret key itself is shown only in the requesting user's ephemeral Discord response and is not persisted in SQLite or audit metadata.

## Access policy

Whether a viewer authenticates with a normal user identity or an intentionally tagged appliance identity, keep access narrow. PH viewers should be able to reach Plex, not management infrastructure.

For an intentionally tagged appliance, the conceptual grant is:

```text
tag:ph-viewer -> tag:media-ph:32400
```

Do not grant that identity access to SSH, Proxmox, Portainer, NAS management, California servers, or unrelated tailnet services.

For normal user-owned devices, create a dedicated Tailscale user/group policy for PH viewers and grant only the PH Plex destination/port. Joining the tailnet must not automatically imply broad access to management hosts. Remember that Tailscale grants are additive: a broad pre-existing rule can still give a PH viewer more access even if you add a narrow Plex-only rule later.

## Admin resend command

Admins can run:

```text
/send-setup user:@member
```

The bot reads the member's existing DB state and DMs the correct personalized setup guide. Main users receive Plex-only setup. PH users additionally receive PH Server Connection controls and their saved per-device setup status.

This is intended for users who are already in Plex/Seerr/Discord, users who got partially linked, or users who buy a new phone/TV/computer later.

## Plex invitation recovery

The username path is deliberately available even when the legacy database row already has `invited=1`.

Older email-first onboarding set `invited=1` when Plex accepted the share/invite request. That does **not** prove the invitation email arrived or that the member accepted it. Once the member has saved a Plex username, `/setup` therefore keeps **Verify / Re-send to Username** available. This is the recovery path for the broken/missing Plex invitation-email case.

After a username share is sent, the bot reads Plex's account/friends list back. It treats the username share as verified only after Plex recognizes that saved username on the server owner's account. If the read-back has not appeared yet, the user gets **Share Sent, Not Yet Verified** instead of a false success.

## Saved PH device status

Each PH user can confirm setup separately for:

- phone/tablet
- Apple TV
- Android/Google TV
- computer

These confirmations are intentionally labeled as **saved setup state**, not live VPN monitoring. A green check means the member confirmed that device was configured. It does not prove the device is online at this exact moment.

The member can reset a device later and repeat the guided setup.

## PH endpoint

With `TAILSCALE_SERVER_ADDRESS=ph-server.end-cobra.ts.net`, the setup wizard derives:

```text
http://ph-server.end-cobra.ts.net:32400/web
```

for the **Test / Open PH Plex** button unless `PH_PLEX_URL` explicitly overrides it.

If Tailscale Serve is enabled for Plex, `PH_PLEX_URL` can instead point at the HTTPS tailnet URL. Tailscale Serve is tailnet-only; it does not make Plex publicly reachable on the internet.
