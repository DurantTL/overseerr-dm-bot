# Edge Node Rebuild Runbook

A step-by-step checklist for rebuilding a tier-agent edge node from bare metal (fresh OS
install, replacement hardware, or a wipe-and-reinstall after a hardware failure). Follow this
in order — the mount guard and the install command both depend on steps earlier in the list.

All values below (IPs, tokens, UUIDs, hostnames) are **placeholders**. Substitute your own; never
paste real tokens or device identifiers into a shared runbook or ticket.

## 1. Static IP via netplan

Edge nodes need a stable address so the bot's Tailscale/tunnel config and Syncthing discovery
don't have to chase a DHCP lease change. Example `/etc/netplan/01-edge-static.yaml`:

```yaml
network:
  version: 2
  ethernets:
    eth0:
      dhcp4: no
      addresses:
        - 192.168.1.50/24
      routes:
        - to: default
          via: 192.168.1.1
      nameservers:
        addresses: [192.168.1.1, 1.1.1.1]
```

Apply and verify:

```sh
sudo netplan apply
ip -4 addr show eth0
```

If the box has multiple NICs, confirm which interface name is actually live (`ip link`) before
writing the file — interface names are not guaranteed to match the old install.

## 2. Mount the external media drive — by UUID, never `/dev/sdX`

`/dev/sdX` device names are assigned in enumeration order at boot and are **not stable** —
adding, removing, or just power-cycling a USB drive can silently swap which letter a drive gets.
Always mount by filesystem UUID.

1. Find the UUID of the drive:

   ```sh
   lsblk -o NAME,UUID,FSTYPE,SIZE
   ```

   Example output (placeholder values):

   ```
   NAME   UUID                                   FSTYPE  SIZE
   sda1   aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee   ext4    8T
   ```

2. Add an `/etc/fstab` entry keyed on that UUID, not the device path:

   ```
   UUID=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee  /mnt/media  ext4  defaults,nofail  0  2
   ```

   `nofail` matters — without it, a missing/failed drive at boot can hang the whole boot sequence
   instead of just leaving `/mnt/media` empty (which the mount guard in step 3 is built to catch).

3. Mount and confirm:

   ```sh
   sudo mkdir -p /mnt/media
   sudo mount -a
   findmnt /mnt/media
   ```

4. Create the mount-guard sentinel file **on the drive itself**, once, after confirming it's
   actually mounted:

   ```sh
   sudo touch /mnt/media/.tier-media-ok
   ```

   If this file is ever created on the wrong filesystem (e.g. because the drive wasn't mounted
   yet when you ran `touch`), the mount guard will treat the *system disk* as "proven" the next
   time the drive fails to remount — the opposite of what it's for. Always `findmnt` first.

## 3. Configure the mount guard

The tier agent's mount guard (`agent/agent.js`) is **opt-in**: if `TIER_MOUNT_ROOT` is left
unset, no guard runs at all, and a drive that fails to remount after a reboot will silently look
like an empty local directory — the agent will report an empty inventory and Syncthing will
re-pull the whole library onto the system disk. Always configure this on any node with an
external/removable drive.

Two independent proofs are supported; configure at least one (both is fine):

- `TIER_EXPECTED_UUID` — the filesystem UUID from step 2 above. Best for bare-metal/host installs.
- `TIER_MOUNT_MARKER` — the sentinel file from step 2.4, given as a path **relative to**
  `TIER_MOUNT_ROOT` (e.g. `.tier-media-ok`). This is the one that also works inside a container,
  since a Docker bind mount of a failed-to-remount host path still "looks" mounted from inside —
  the UUID check does not survive that, but a missing sentinel file does.

Example env values (see `agent/README.md` for the full var table):

```sh
TIER_MOUNT_ROOT=/mnt/media
TIER_EXPECTED_UUID=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee
TIER_MOUNT_MARKER=.tier-media-ok
```

Setting `TIER_MOUNT_ROOT` without at least one proof is a hard startup error by design — the
agent refuses to run with a bare "is it a mount point?" check, since that lies inside containers.

## 4. Create Syncthing folders via the REST API, not GUI clicking

Clicking through the Syncthing web GUI to set up folders on a rebuilt node is slow and easy to
get subtly wrong (folder type, ignore-file handling, share settings). Prefer the REST API so the
folder config is reproducible and scriptable.

1. Get an API key from Syncthing's GUI (Settings → General → API Key), or reuse the node's
   existing one from `/etc/syncthing/config.xml`.

2. Create (or verify) a folder as **Receive Only** — the tier agent refuses to prune anything on
   a folder that isn't Receive Only, since that's the only thing standing between an edge node
   and accidentally pushing deletes back to the master:

   ```sh
   curl -X PUT http://127.0.0.1:8384/rest/config/folders/movies \
     -H "X-API-Key: <your-syncthing-api-key>" \
     -H "Content-Type: application/json" \
     -d '{
       "id": "movies",
       "label": "Movies",
       "path": "/mnt/media/Media/Movies",
       "type": "receiveonly",
       "devices": [{"deviceID": "AAAAAAA-BBBBBBB-CCCCCCC-DDDDDDD-EEEEEEE-FFFFFFF-GGGGGGG-HHHHHHH"}]
     }'
   ```

3. Confirm it registered and the type stuck:

   ```sh
   curl -s http://127.0.0.1:8384/rest/config/folders/movies -H "X-API-Key: <your-syncthing-api-key>" | jq '.type'
   ```

   This should print `"receiveonly"`. If it doesn't, `assertReceiveOnly()` in the agent will hard
   abort every run until it's fixed.

Repeat per folder for a multi-folder node.

## 5. Run the dashboard-generated install command

Use the dashboard's **Tier Node Setup → Generate install command** section (or
`/tier-node token name:<node>` in Discord) rather than hand-assembling the installer — it bakes
in the correct `TIER_FOLDERS` JSON, a fresh one-time agent token, and (if you filled them in)
`TIER_MOUNT_ROOT`/`TIER_MOUNT_MARKER`.

Before generating: fill in `TIER_MOUNT_ROOT` and `TIER_MOUNT_MARKER` on the form if this node has
an external drive (steps 2–3 above). They're marked optional in the UI because a master/single-disk
node doesn't need them — but on any node with removable media, leaving them blank means **no
mount-guard protection at all**. See item 4 below (`docs/known-issues.md` companion review) for
the plan to make that omission more visible in the UI.

The generated command looks like (placeholder values):

```sh
export TIER_AGENT_TOKEN='<your-token-here>'
curl -fsSL -H "Authorization: Bearer $TIER_AGENT_TOKEN" 'https://bot.example.com/agent/install/edge-node-1' \
  | sudo -E env TIER_AGENT_TOKEN="$TIER_AGENT_TOKEN" SYNCTHING_API_KEY='<your-syncthing-api-key>' \
    TIER_FOLDERS='[{"id":"movies","path":"/mnt/media/Media/Movies"}]' \
    TIER_MOUNT_ROOT='/mnt/media' TIER_MOUNT_MARKER='.tier-media-ok' sh
unset TIER_AGENT_TOKEN
```

Run it on the node itself (not inside the bot's container). It installs the agent to
`/opt/tier-agent`, writes the token to root-only `/etc/tier-agent.env`, installs a 15-minute
systemd timer, and runs once immediately so a misconfiguration shows up right away instead of
15 minutes later.

Recommended: on the first run, set `TIER_DRY_RUN=1` in `/etc/tier-agent.env`, run
`systemctl start tier-agent.service`, and read `journalctl -u tier-agent` before letting the
timer loose unattended. Remove `TIER_DRY_RUN` once you're satisfied.

## 6. Verify the Syncthing connection is direct, not relayed

Before assuming a slow initial sync is just "a big library, give it time," confirm the node is
actually talking to the master directly. A node behind CGNAT (no public inbound IP — common for
any edge node not port-forwarded on its own router) will silently fall back to Syncthing's public
relay infrastructure, which is slow enough (observed as low as single-digit bytes/min) to be
indistinguishable from "stuck" unless you check the connection type directly. See
`docs/known-issues.md` ("CGNAT'd edge nodes silently fall back to Syncthing's public relay...")
for the full writeup — this step is the summary.

1. On the **master**, once the new node has connected at least once, check its connection type:

   ```sh
   curl -s http://127.0.0.1:8384/rest/system/connections -H "X-API-Key: <master-syncthing-api-key>" \
     | jq '.connections["<node-device-id>"] | {connected, type, address}'
   ```

2. If `type` contains `relay` (e.g. `"relay-client"`), pin the node's Tailscale IP as a static
   device address on the master so Syncthing stops relying on discovery to find a direct path:

   ```sh
   curl -X PATCH http://127.0.0.1:8384/rest/config/devices/<node-device-id> \
     -H "X-API-Key: <master-syncthing-api-key>" \
     -H "Content-Type: application/json" \
     -d '{"addresses": ["tcp://<node-tailscale-ip>:22000", "dynamic"]}'
   ```

3. Re-check `/rest/system/connections` after the next reconnect — `type` should now read
   `tcp-client`/`tcp-server` (or `quic-*`) with `address` showing the node's Tailscale IP
   (`100.64.0.0/10`) on port `22000`, not a relay hostname.

Do this **before** trusting any "initial sync is taking a while" read on a freshly rebuilt node —
a relayed connection can make a healthy node look stuck for days.

## 7. Verify RTC wake before trusting it in production

If this node is expected to wake itself from suspend/sleep on a schedule (e.g. to run during an
off-peak window), verify RTC wake works **before** relying on it, using a short, safe test rather
than a long overnight sleep you can't easily recover from remotely:

```sh
sudo rtcwake -m off -s 120
```

This does **not** put the machine to sleep — `-m off` only programs the RTC alarm 120 seconds out
and returns immediately, letting you confirm the alarm was set without any actual suspend risk.
Check the result:

```sh
sudo rtcwake -m off -s 120 -v
```

The verbose form prints the wake time it's programming into the RTC. Once you've confirmed the
alarm can be set, test an actual suspend/resume cycle with a short window while you're physically
present or have out-of-band (IPMI/iLO/network KVM) access to the box — not over SSH alone, since a
resume that fails to bring networking back up will otherwise strand the node until someone visits
it in person.

## Checklist summary

- [ ] Static IP configured via netplan and confirmed with `ip -4 addr show`
- [ ] External drive mounted via `/etc/fstab` by UUID (never `/dev/sdX`), with `nofail`
- [ ] Mount-guard sentinel file created on the drive after confirming the mount
- [ ] `TIER_MOUNT_ROOT` + (`TIER_EXPECTED_UUID` and/or `TIER_MOUNT_MARKER`) set
- [ ] Syncthing folders created via REST API as `receiveonly`, confirmed with a GET
- [ ] Dashboard-generated install command run on the node, first pass with `TIER_DRY_RUN=1`
- [ ] `journalctl -u tier-agent` reviewed before removing `TIER_DRY_RUN`
- [ ] Syncthing connection type checked on the master (`/rest/system/connections`) — direct, not relay
- [ ] RTC wake verified with `rtcwake -m off -s 120` before relying on scheduled wake
