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
