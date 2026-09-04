# Known Issues

Operational gotchas discovered running this stack in production, kept here so they don't have to
be rediscovered. All example values (vendor/product IDs, device paths) below are the actual
publicly-documented USB IDs for the affected hardware class, not secrets — but keep any
node-specific serials, IPs, or tokens you gather while debugging a similar issue out of this file.

## External USB-SATA drives silently throttled by the `uas` driver

**Symptom:** an external drive connected over a USB-SATA bridge shows a fully negotiated USB3
link (`lsusb -t` reports `5000M` / SuperSpeed) but sustained read/write throughput is 10–15x
slower than the drive and enclosure should support — often slow enough to make an initial
Syncthing scan or a large `rclone copy` job take days instead of hours. Nothing in `dmesg` looks
obviously wrong, and the link speed reported by USB itself is misleading: it reflects the
negotiated *bus* speed, not what the storage driver sitting on top of it is doing.

**Cause:** certain USB-SATA bridge chips negotiate to the Linux `uas` (USB Attached SCSI) driver
instead of the older `usb-storage` driver. `uas` is supposed to be strictly faster (it supports
command queuing), but a subset of bridge chips have firmware bugs that `uas` triggers, causing it
to silently fall back to serialized, unqueued I/O — while `usb-storage` handles the same chip
correctly. This is a known category of hardware/driver interaction, not something specific to
this project. **Confirmed** on a LaCie external drive using the `059f:1093` bridge chip
(LaCie/SanDisk vendor ID `059f`); other bridge chips with the same firmware-generation issue are
likely affected too — check the actual VID:PID on any drive that seems to be badly underperforming
despite reporting a good link.

**Diagnostic:**

```sh
lsusb -t
```

Look for the affected device's line and check which driver claimed it:

```
    |__ Port 2: Dev 3, If 0, Class=Mass Storage, Driver=uas, 5000M
```

`Driver=uas` at full negotiated speed (`5000M`) with poor real-world throughput is the signature.
Cross-check the vendor:product ID with `lsusb`:

```sh
lsusb
# Bus 002 Device 003: ID 059f:1093 LaCie ...
```

**Fix:** force that specific VID:PID to use `usb-storage` instead of `uas` via a kernel quirk.
This does not disable `uas` system-wide — only for the exact device ID you specify.

1. Edit `/etc/default/grub` and add the quirk to `GRUB_CMDLINE_LINUX_DEFAULT`:

   ```
   GRUB_CMDLINE_LINUX_DEFAULT="quiet splash usb-storage.quirks=059f:1093:u"
   ```

   The trailing `u` is the quirk flag for "force `usb-storage`, disable `uas`" — see
   `modinfo usb-storage` for the full quirk-flag reference if a different flag is ever needed.

2. Regenerate the GRUB config and reboot:

   ```sh
   sudo update-grub
   sudo reboot
   ```

3. Confirm the driver changed:

   ```sh
   lsusb -t
   ```

   The affected device's line should now read `Driver=usb-storage` instead of `Driver=uas`.
   Re-run a throughput test (e.g. `dd if=/dev/zero of=/mnt/media/testfile bs=1M count=2048 oflag=direct`
   followed by removing the test file) and compare against the drive's rated sequential speed.

**Why this matters for edge nodes specifically:** a node stuck on the buggy `uas` path will pass
every mount-guard check (the drive *is* genuinely mounted and healthy) while taking far longer
than expected to complete Syncthing's initial folder scan after a rebuild — which can look like
the "operation aborted due to timeout" agent failure described in the tier-agent scanning issue,
even though the actual root cause here is the USB driver, not the agent. Check `lsusb -t` on any
freshly rebuilt edge node before assuming a slow initial sync is normal.

## CGNAT'd edge nodes silently fall back to Syncthing's public relay instead of connecting direct over Tailscale

**Symptom:** a folder on an edge node shows "Syncing" in Syncthing indefinitely, or for far longer
than the library size and network should require. Nothing errors — Syncthing does not surface
"stuck" as a distinct state from "genuinely slow" — and the node otherwise looks healthy: it's on
the tailnet, `tailscale status` is clean, the mount guard passes, and the agent's heartbeat is
current. **Confirmed** in production on two edge nodes behind CGNAT (no public inbound IP):
throughput on the affected folders measured roughly 2–8 bytes/min, which is functionally
indistinguishable from "stuck" without checking the connection type directly.

**Cause:** Syncthing prefers a direct connection between two devices, but falls back to relaying
through its public relay infrastructure whenever it can't establish one directly — and a node
behind CGNAT has no public inbound IP for the master to dial, so Syncthing's own NAT traversal
(UPnP/STUN/hole-punching) fails silently and it relays instead. This happens even when both nodes
are already reachable directly via a private overlay network (e.g. Tailscale) — Syncthing has no
awareness of the tailnet and never tries that path on its own. A node can be relaying like this
from the day it was first set up without anyone noticing, since relay traffic still counts as
"Syncing" rather than any kind of error state.

**Diagnostic:** check the connection type Syncthing is actually using for the affected device, not
just whether it's "Connected":

```sh
curl -s http://127.0.0.1:8384/rest/system/connections -H "X-API-Key: <your-syncthing-api-key>" \
  | jq '.connections["<remote-device-id>"] | {connected, type, address}'
```

A `type` containing `relay` (e.g. `"relay-client"`) confirms the node is relaying. A direct
connection instead reports a `tcp-client`/`tcp-server` (or `quic-*`) type with `address` showing
the peer's actual IP:port — a Tailscale IP (typically `100.64.0.0/10`) and port `22000` if the fix
below is in place.

**Fix:** pin the node's known Tailscale IP into the *master's* Syncthing device config as a static
address, so Syncthing tries it directly instead of relying on discovery/NAT traversal to find a
path on its own:

```sh
curl -X PATCH http://127.0.0.1:8384/rest/config/devices/<remote-device-id> \
  -H "X-API-Key: <master-syncthing-api-key>" \
  -H "Content-Type: application/json" \
  -d '{"addresses": ["tcp://<tailscale-ip>:22000", "dynamic"]}'
```

Keeping `"dynamic"` in the list preserves the normal discovery fallback if the Tailscale IP ever
changes; it's just no longer the *only* path tried. This takes effect on the next reconnect —
watch `/rest/system/connections` (or the Syncthing GUI) for the `type` to flip away from `relay-*`.
In one measured case this improved throughput by roughly 18x.

**Why this matters for edge nodes specifically:** every edge node behind CGNAT is a candidate for
this from initial deployment — it is not something that develops later, so a node that has "always
been slow" is more likely to be relaying than to have a genuinely slow link. See
`docs/edge-node-rebuild-runbook.md` for the step that checks this during node setup, before initial
sync is assumed to be simply slow.

## Tier plans can go silently stale with no built-in alerting

**Symptom:** an edge node keeps converging cleanly (`converged: true`, no errors, regular
heartbeats) against a plan that is weeks old, while the actual demand on that node has moved on.
Syncthing itself has no concept of "tier" or "plan age" — it just keeps mirroring whatever the
master's folder contains under the current `.stignore`, so a node with a stale plan looks perfectly
healthy on every signal the agent reports. **Confirmed** in production: one node's plan went
unapplied for 46 days, during which the disk filled from healthy to 99% full and multiple large
title syncs failed outright with "insufficient space" errors — a genuine operational outage caused
entirely by nobody re-running `/tier apply`.

**Cause:** `/tier apply` is a manual, admin-confirmed action by design (large rebalances require
typing a confirmation code before anything prunes) — nothing currently re-publishes a plan on a
schedule, and nothing flags a published plan's age until someone thinks to run `/tier preview` and
read it off the `📤 Published … ago` line. The existing agent-liveness signals (`lastHeartbeatAt`,
`lastAgentReportAt` — surfaced in `/tier-node list` and the dashboard) measure a completely
different thing: "is the agent still checking in", not "is the plan it's converging on current".
A node can heartbeat every 15 minutes for 46 days straight while converging against the same stale
plan the entire time.

**Status:** proposal only, not yet implemented — see the tier-plan-staleness discussion for the
options under consideration (scheduled re-apply, a staleness alert threshold, and surfacing plan
age in the routine status views rather than only in `/tier preview`).
