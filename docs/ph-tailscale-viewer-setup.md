# PH viewer Tailscale setup

This is the PH-only remote-access path for Durant Media Server users. Main/USA users never see or need these controls.

## Why this exists

The PH Plex server is behind CGNAT and has no usable public IPv4/IPv6 path, so remote viewers need a private Tailscale path to Plex when they are away from the PH LAN.

The Discord setup wizard exposes device-specific instructions under `/setup` only when `home_server=ph`.

## Recommended model: share only the PH Plex machine

Do **not** invite every Plex viewer into the Durant tailnet as a normal tailnet member. Tailscale bills normal tailnet users as seats after the free-plan allowance, while **machine sharing does not increase the user count of the Durant tailnet**.

Instead:

1. Keep the PH Plex host in the Durant tailnet.
2. Give that PH host a server/resource identity such as `tag:media-ph` if desired.
3. Use Tailscale **Share** on that one PH machine.
4. The viewer signs in with their own Tailscale identity/free tailnet and accepts the share.
5. The PH Plex machine appears to that viewer, but the viewer is not a member/paid seat of the Durant tailnet.
6. Restrict shared users to Plex TCP/32400 with the Durant tailnet policy.

This is a better fit than tagging the viewer's phone/TV/computer. Tailscale recommends tags for non-human/shared infrastructure, not end-user devices. The **PH server** is the thing that should be tagged; the viewer remains a normal Tailscale user in their own tailnet.

Tailscale also quarantines shared machines by default, so the shared PH server can receive connections from the recipient but cannot initiate connections back into the recipient's tailnet.

## Share-link flow in Discord

Generate a share link from the PH server's machine entry in the Tailscale admin console:

**Machines → ph-server → Share → Copy share link**

A reusable machine-share link can be accepted by multiple recipients, but Tailscale currently expires unused share links after 30 days. Treat the link like a password and rotate it when needed.

Put the current link into the bot environment:

```env
TAILSCALE_PH_SHARE_URL=https://login.tailscale.com/...
```

When configured, PH users get a **Join PH Server** button in the PH Server Connection wizard. Main users never receive the link or button.

## Device behavior

Once the viewer has accepted the PH machine share with their own Tailscale identity:

- **iPhone/iPad and Android phones/tablets:** install Tailscale, sign in to the same identity that accepted the share, connect, then open PH Plex.
- **Apple TV:** install Tailscale and sign in/QR-link with the same Tailscale identity.
- **Android / Google TV:** use the Tailscale QR/generated-code login with the same identity.
- **Computer:** install Tailscale and sign in with the same identity.

The share belongs to that recipient identity, so the user can use their own devices without becoming a Durant tailnet user.

## Minimum bot configuration

For the recommended seat-free machine-sharing model:

```env
PLEX_SIGNUP_URL=https://www.plex.tv/sign-up/
PLEX_WEB_URL=https://app.plex.tv/

TAILSCALE_ENABLED=true
TAILSCALE_SETUP_URL=https://tailscale.com/download
TAILSCALE_SERVER_ADDRESS=ph-server.end-cobra.ts.net
PH_PLEX_URL=http://ph-server.end-cobra.ts.net:32400

# Current PH machine-share link. Rotate when it expires/revokes.
TAILSCALE_PH_SHARE_URL=https://login.tailscale.com/...

# Keep automated tagged-device provisioning off for personal viewer devices.
TAILSCALE_API_ENABLED=false
```

`PH_PLEX_URL` is the base URL. Discord appends `/web` to the Open/Test buttons. If it is omitted, the bot derives `http://TAILSCALE_SERVER_ADDRESS:32400`.

If Plex is later exposed inside the tailnet through Tailscale Serve, set `PH_PLEX_URL` to that HTTPS tailnet base instead.

## Tailscale policy: shared users can reach only PH Plex

The share itself already limits a recipient to the machine you shared. Add a policy restriction so shared recipients can use only Plex TCP/32400 on the PH server.

Tag the PH server as a resource, for example:

```json
{
  "tagOwners": {
    "tag:media-ph": ["autogroup:admin"]
  },
  "grants": [
    {
      "src": ["autogroup:shared"],
      "dst": ["tag:media-ph"],
      "ip": ["tcp:32400"]
    }
  ]
}
```

Important: Tailscale grants are additive. If your existing policy contains a broad rule such as `src: ["*"]` to `dst: ["*"]`, shared users may inherit more access than you intended. Review the full policy and make sure `autogroup:shared` cannot reach SSH, Proxmox, Portainer, NAS management, California servers, or unrelated tailnet services.

Because the PH server itself is a real server/resource, `tag:media-ph` is an appropriate use of a tag. Do not tag the viewer's personal phone/TV/computer merely to avoid user seats.

## Optional tagged appliance provisioning

The repo still contains OAuth/auth-key support for a deliberately shared/non-human appliance. It is not the normal Plex viewer path.

Keep this off for ordinary users:

```env
TAILSCALE_API_ENABLED=false
```

Only if you intentionally provision a non-human appliance would you configure:

```env
TAILSCALE_API_ENABLED=true
TAILSCALE_OAUTH_CLIENT_ID=your-oauth-client-id
TAILSCALE_OAUTH_CLIENT_SECRET=
TAILSCALE_TAILNET=-
TAILSCALE_VIEWER_TAG=tag:ph-viewer
TAILSCALE_DEVICE_KEY_TTL_SECONDS=1800
```

## Admin resend command

Admins can run:

```text
/send-setup user:@member
```

The bot reads the member's existing DB state and DMs the correct personalized setup guide. Main users receive Plex-only setup. PH users additionally receive PH Server Connection controls and their saved per-device setup status.

## Plex invitation recovery

The username path is deliberately available even when the legacy database row already has `invited=1`.

Older email-first onboarding set `invited=1` when Plex accepted the share/invite request. That does **not** prove the invitation email arrived or that the member accepted it. Once the member has saved a Plex username, `/setup` therefore keeps **Verify / Re-send to Username** available.

After a username share is sent, the bot reads Plex's account/friends list back. If the read-back has not appeared yet, the user gets **Share Sent, Not Yet Verified** instead of a false success.

## Saved PH device status

Each PH user can confirm setup separately for phone/tablet, Apple TV, Android/Google TV, and computer. These confirmations are saved onboarding state, not live VPN monitoring.

## PH endpoint

With `TAILSCALE_SERVER_ADDRESS=ph-server.end-cobra.ts.net`, the setup wizard derives:

```text
http://ph-server.end-cobra.ts.net:32400/web
```

for the **Test / Open PH Plex** button unless `PH_PLEX_URL` explicitly overrides it.
