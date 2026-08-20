# PH viewer Tailscale setup

This is the PH-only remote-access path for Durant Media Server users. Main/USA users never see or need these controls.

## Why this exists

The PH Plex server is behind CGNAT and has no usable public IPv4/IPv6 path, so remote viewers need a private Tailscale path to Plex when they are away from the PH LAN.

The Discord setup wizard exposes device-specific instructions under `/setup` only when `home_server=ph`.

## Device behavior

Tailscale does not use the same onboarding UX on every platform, so the bot deliberately avoids pretending one key workflow works everywhere.

- **iPhone/iPad and Android phones/tablets:** use the normal Tailscale account/invite + VPN flow. The mobile apps do not expose the same paste-an-auth-key flow as Apple TV. The Discord guide therefore offers connection/admin help rather than handing the user a key they cannot conveniently enter. The tailnet invitation URL/account access is still provided by the admin; unused Tailscale external-user invite links expire, so do not hard-code a permanent invite into Discord.
- **Apple TV:** Tailscale supports **Use an auth key**. The bot can automatically mint a one-time `tag:ph-viewer` key and show it ephemerally to the requesting Discord member.
- **Android / Google TV:** prefer the QR code or generated-code flow shown by the Tailscale TV app. The user can ask the admin for help from Discord.
- **Computer:** a one-time key can be generated automatically when OAuth provisioning is enabled; it can be used with an auth-key-capable client/CLI.

One-off generated keys are never written to SQLite or audit metadata. Only the non-secret key ID, tag, requesting Discord ID, device class, and TTL are audited.

## Minimum bot configuration

The normal PH setup buttons need the existing PH/Tailscale values:

```env
TAILSCALE_ENABLED=true
TAILSCALE_SETUP_URL=https://tailscale.com/download
TAILSCALE_SERVER_ADDRESS=ph-server.end-cobra.ts.net

# Optional explicit base URL. If omitted, the bot derives
# http://TAILSCALE_SERVER_ADDRESS:32400
PH_PLEX_URL=http://ph-server.end-cobra.ts.net:32400
```

`PH_PLEX_URL` is especially useful if Plex is later exposed inside the tailnet through Tailscale Serve and the user-facing endpoint becomes HTTPS.

## Enable OAuth provisioning

Create a Tailscale OAuth client in **Trust credentials** with the **Auth Keys** scope and permission to mint the viewer tag used below. The OAuth access token created from this client lasts one hour; the bot requests one only when it needs to mint a viewer key.

Configure the bot:

```env
TAILSCALE_API_ENABLED=true
TAILSCALE_OAUTH_CLIENT_ID=your-oauth-client-id
# Prefer Docker/Portainer secret files for the secret:
TAILSCALE_OAUTH_CLIENT_SECRET_FILE=/run/secrets/tailscale_oauth_client_secret
# Inline is also supported, but never set both forms:
# TAILSCALE_OAUTH_CLIENT_SECRET=...

# `-` lets Tailscale infer the tailnet from the OAuth token.
TAILSCALE_TAILNET=-
TAILSCALE_VIEWER_TAG=tag:ph-viewer
# One-off key lifetime if it has not been used yet; default 30 minutes.
TAILSCALE_DEVICE_KEY_TTL_SECONDS=1800
```

These OAuth-specific values are currently documented here because the setup provisioning module owns them directly. Treat this block as the deployment reference when enabling automated PH device keys.

The OAuth client must be allowed to create `tag:ph-viewer` keys. Generated keys have these properties:

```text
reusable:       false
ephemeral:      false
preauthorized:  true
tags:           [tag:ph-viewer]
```

`ephemeral=false` is intentional: a phone/TV/computer is a persistent viewer device, not a disposable workload. The *auth key* is one-time; the provisioned device remains in the tailnet afterward.

## Access policy

The security boundary should be the tag. A PH viewer device should not gain broad tailnet access.

Conceptually:

```text
tag:ph-viewer -> tag:media-ph:32400
```

Do not grant `tag:ph-viewer` access to SSH, Proxmox, Portainer, NAS management, other servers, or unrelated tailnet services.

The PH Plex host should carry a dedicated server tag such as `tag:media-ph` and the policy should permit only Plex TCP/32400 from `tag:ph-viewer`. If the user-facing Plex endpoint is moved behind Tailscale Serve on HTTPS, update the grant to the actual service port/path architecture rather than leaving unnecessary broader access.

For phone/tablet users who join with a normal Tailscale user identity rather than an auth-key tag, make sure the tailnet's user/group grants are equally narrow. Joining the tailnet must not automatically imply access to management hosts.

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
