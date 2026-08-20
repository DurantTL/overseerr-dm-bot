# PH viewer Tailscale setup

This is the PH-only remote-access path for Durant Media Server users. Main/USA users never see or need these controls.

## Why this exists

The PH Plex server is behind CGNAT and has no usable public IPv4/IPv6 path, so remote viewers need a private Tailscale path to Plex when they are away from the PH LAN.

The Discord setup wizard exposes device-specific instructions under `/setup` only when `home_server=ph`.

## Device behavior

Tailscale does not use the same onboarding UX on every platform, so the bot deliberately avoids pretending one key workflow works everywhere.

- **iPhone/iPad and Android phones/tablets:** use the normal Tailscale account/invite + VPN flow. The mobile apps do not expose the same paste-an-auth-key flow as Apple TV.
- **Apple TV:** Tailscale explicitly supports **Use an auth key**. The bot can automatically mint a one-time `tag:ph-viewer` key and show it ephemerally to the requesting Discord member.
- **Android / Google TV:** prefer the QR code or generated-code flow shown by the Tailscale TV app. The user can ask the admin for help from Discord.
- **Computer:** a one-time key can be generated automatically when OAuth provisioning is enabled; it can be used with an auth-key-capable client/CLI.

One-off generated keys are never written to SQLite or audit metadata. Only the non-secret key ID, tag, requesting Discord ID, device class, and TTL are audited.

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

The OAuth client must be allowed to create `tag:ph-viewer` keys. Generated keys have these properties:

```text
reusable:      false
 ephemeral:    false
 preauthorized:true
 tags:         [tag:ph-viewer]
```

`ephemeral=false` is intentional: a phone/TV/computer is a persistent viewer device, not a disposable workload. The *auth key* is one-time; the provisioned device remains in the tailnet afterward.

## Access policy

The security boundary should be the tag. A PH viewer device should not gain broad tailnet access.

Conceptually:

```text
tag:ph-viewer -> tag:media-ph:32400
```

Do not grant `tag:ph-viewer` access to SSH, Proxmox, Portainer, NAS management, other servers, or unrelated tailnet services.

The PH Plex host should carry a dedicated server tag such as `tag:media-ph` and the policy should permit only Plex TCP/32400 from `tag:ph-viewer`.

## Admin resend command

Admins can run:

```text
/send-setup user:@member
```

The bot reads the member's existing DB state and DMs the correct personalized setup guide. Main users receive Plex-only setup. PH users additionally receive PH Server Connection controls.

This is intended for users who are already in Plex/Seerr/Discord, users who got partially linked, or users who buy a new phone/TV/computer later.

## Plex verification

The enhanced setup flow no longer treats a successful Plex share POST as final proof. When a user taps the username-based invite button, the bot sends the share and then reads Plex's account/friends list back. It marks `invited=1` only after Plex recognizes that saved username on the server owner's account. If the read-back has not appeared yet, the user gets a **Share Sent, Not Yet Verified** message instead of a false success.

## PH endpoint

With `TAILSCALE_SERVER_ADDRESS=ph-server.end-cobra.ts.net`, the setup wizard derives:

```text
http://ph-server.end-cobra.ts.net:32400/web
```

for the **Test / Open PH Plex** button unless `PH_PLEX_URL` explicitly overrides it.

Later, if Tailscale Serve is enabled for Plex, `PH_PLEX_URL` can be pointed at the HTTPS tailnet URL instead.
