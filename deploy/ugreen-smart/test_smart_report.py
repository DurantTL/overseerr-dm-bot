"""Tests for the UGREEN SMART reporter: parsing, the wrapper, fail-closed rules, the schedule.

Run: python3 -m unittest discover -s deploy/ugreen-smart -p 'test_*.py'
(scripts/tests/ugreen-smart-reporter.test.js runs this from `npm test`.)
"""

import datetime
import json
import os
import shutil
import stat
import subprocess
import tempfile
import unittest
from zoneinfo import ZoneInfo

import smart_report as sr

HERE = os.path.dirname(os.path.abspath(__file__))
WRAPPER = os.path.join(HERE, "host", "central-iowa-smart-report.sh")


def ata(model, passed, temp=34, realloc=0, pending=0, offline=0, hours=12000, serial="WD-SECRET123"):
    return {
        "smartctl": {"exit_status": 0 if passed else 8},
        "model_name": model, "serial_number": serial,
        "smart_status": {"passed": passed},
        "temperature": {"current": temp},
        "power_on_time": {"hours": hours},
        "ata_smart_attributes": {"table": [
            {"id": 5, "name": "Reallocated_Sector_Ct", "raw": {"value": realloc}},
            {"id": 197, "name": "Current_Pending_Sector", "raw": {"value": pending}},
            {"id": 198, "name": "Offline_Uncorrectable", "raw": {"value": offline}},
        ]},
    }


OPEN_FAILED = {
    "smartctl": {"exit_status": 2, "messages": [{"string": "Smartctl open device: /dev/sdz failed: No such device", "severity": "error"}]},
}


class ParseTests(unittest.TestCase):
    def test_ata_passed_row_has_every_field_and_no_serial(self):
        row = sr.parse_disk({"device": "/dev/sda", "exit": 0, "smart": ata("WDC WD40EFPX-68C6CN0", True, realloc=2, pending=1, offline=3)})
        self.assertEqual(row, {
            "device": "/dev/sda", "model": "WDC WD40EFPX-68C6CN0", "health": "PASSED", "temperatureC": 34,
            "reallocatedSectors": 2, "pendingSectors": 1, "offlineUncorrectable": 3, "powerOnHours": 12000, "error": None,
        })
        self.assertNotIn("WD-SECRET123", json.dumps(row))

    def test_failed_health(self):
        self.assertEqual(sr.parse_disk({"device": "/dev/sdb", "exit": 8, "smart": ata("ST4000VN006", False)})["health"], "FAILED")

    def test_open_failure_is_unknown_never_passed(self):
        row = sr.parse_disk({"device": "/dev/sdz", "exit": 2, "smart": OPEN_FAILED})
        self.assertEqual(row["health"], "UNKNOWN")
        self.assertIn("No such device", row["error"])
        row = sr.parse_disk({"device": "/dev/sdy", "exit": 2, "smart": None})
        self.assertEqual((row["health"], row["error"]), ("UNKNOWN", "device could not be opened"))

    def test_nvme_power_on_hours(self):
        smart = {"model_name": "Samsung SSD 980", "smart_status": {"passed": True}, "temperature": {"current": 41},
                 "nvme_smart_health_information_log": {"power_on_hours": 900}}
        row = sr.parse_disk({"device": "/dev/nvme0n1", "exit": 0, "smart": smart})
        self.assertEqual((row["health"], row["powerOnHours"], row["reallocatedSectors"]), ("PASSED", 900, None))

    def test_bad_output_raises(self):
        for text in ("", "not json", "[]", '{"disks": "x"}'):
            with self.assertRaises(sr.ReportError):
                sr.parse_wrapper_output(text, 0)
        with self.assertRaises(sr.ReportError):
            sr.parse_wrapper_output('{"smartctlMissing": false, "disks": []}', 4)

    def test_filesystem_only_when_sane(self):
        base = {"smartctlMissing": False, "source": "mdstat", "disks": [{"device": "/dev/sda", "exit": 0, "smart": ata("A", True)}]}
        ok = sr.parse_wrapper_output(json.dumps({**base, "filesystem": {"path": "/volume1", "totalBytes": 100, "freeBytes": 40}}), 0)
        self.assertEqual(ok["filesystem"], {"path": "/volume1", "totalBytes": 100, "freeBytes": 40})
        bad = sr.parse_wrapper_output(json.dumps({**base, "filesystem": {"path": "/volume1", "error": "df failed"}}), 0)
        self.assertNotIn("totalBytes", bad["filesystem"])
        payload = sr.build_payload(bad, 1)
        self.assertNotIn("filesystemTotalBytes", payload["telemetry"])


class PayloadTests(unittest.TestCase):
    def test_payload_is_the_monitor_only_heartbeat_shape(self):
        parsed = sr.parse_wrapper_output(json.dumps({
            "smartctlMissing": False, "source": "mdstat",
            "disks": [{"device": "/dev/sda", "exit": 0, "smart": ata("WDC WD40EFPX", True)},
                      {"device": "/dev/sdb", "exit": 8, "smart": ata("WDC WD40EFPX", False)}],
            "filesystem": {"path": "/volume1", "totalBytes": 4000, "freeBytes": 1000},
        }), 0)
        payload = sr.build_payload(parsed, 1730000000000)
        self.assertEqual(set(payload), {"heartbeat", "monitorOnly", "telemetry", "agentVersion"})
        self.assertIs(payload["heartbeat"], True)
        self.assertIs(payload["monitorOnly"], True)
        self.assertRegex(payload["agentVersion"], r"^ugreen-smart-[0-9a-f]{8}$")
        self.assertEqual(payload["telemetry"], {
            "collectedAt": 1730000000000,
            "smartHealth": [{"device": "/dev/sda · WDC WD40EFPX", "health": "ok"}, {"device": "/dev/sdb · WDC WD40EFPX", "health": "failing"}],
            "temperatureC": None,
            "filesystemTotalBytes": 4000, "filesystemFreeBytes": 1000,
        })
        self.assertNotIn("SECRET", json.dumps(payload))


class RunOnceTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.cfg = sr.env_config({"SMART_REPORT_DIR": self.dir, "BOT_URL": "http://bot", "TIER_NODE_TOKEN": "tok"})
        self.posts = []

    def tearDown(self):
        shutil.rmtree(self.dir)

    def post(self, cfg, payload):
        self.posts.append(payload)
        return 200, "{}"

    def run_with(self, text, status=0, dry_run=False):
        return sr.run_once(self.cfg, dry_run=dry_run, ssh=lambda cfg: (text, status), post=self.post, clock=lambda: 1730000000.0)

    def report(self):
        (name,) = os.listdir(self.dir)
        with open(os.path.join(self.dir, name)) as fh:
            return name, json.load(fh)

    def test_healthy_run_posts_and_writes_a_dated_report(self):
        text = json.dumps({"smartctlMissing": False, "source": "mdstat", "disks": [
            {"device": "/dev/sda", "exit": 0, "smart": ata("WDC", True)}, {"device": "/dev/sdb", "exit": 0, "smart": ata("WDC", True)}]})
        self.assertEqual(self.run_with(text), 0)
        self.assertEqual(len(self.posts), 1)
        name, report = self.report()
        self.assertEqual(name, "smart-2024-10-26.json")  # 1730000000 = 2024-10-26 22:33 America/Chicago
        self.assertEqual((report["status"], report["diskCount"], report["posted"]), ("posted", 2, True))
        self.assertNotIn("WD-SECRET123", json.dumps(report))

    def test_one_unknown_disk_means_no_post(self):
        text = json.dumps({"smartctlMissing": False, "source": "mdstat", "disks": [
            {"device": "/dev/sda", "exit": 0, "smart": ata("WDC", True)}, {"device": "/dev/sdz", "exit": 2, "smart": OPEN_FAILED}]})
        self.assertEqual(self.run_with(text), 2)
        self.assertEqual(self.posts, [])
        _, report = self.report()
        self.assertEqual(report["status"], "error")
        self.assertEqual([d["health"] for d in report["disks"]], ["PASSED", "UNKNOWN"])

    def test_smartctl_missing_reports_every_disk_unknown_and_does_not_post(self):
        text = json.dumps({"smartctlMissing": True, "source": "mdstat", "disks": [
            {"device": "/dev/sda", "exit": None, "smart": None}, {"device": "/dev/sdb", "exit": None, "smart": None}]})
        self.assertEqual(self.run_with(text, status=3), 2)
        self.assertEqual(self.posts, [])
        _, report = self.report()
        self.assertEqual(report["status"], "smartctl-missing")
        self.assertEqual([(d["health"], d["error"]) for d in report["disks"]], [("UNKNOWN", "smartmontools missing on host")] * 2)

    def test_ssh_or_parse_failure_does_not_post(self):
        def boom(cfg):
            raise sr.ReportError("SSH failed: Host key verification failed.")
        self.assertEqual(sr.run_once(self.cfg, ssh=boom, post=self.post, clock=lambda: 1730000000.0), 2)
        self.assertEqual(self.run_with("garbage"), 2)
        self.assertEqual(self.posts, [])

    def test_bot_refusal_is_a_failure(self):
        def refuse(cfg, payload):
            raise sr.ReportError("bot answered HTTP 401 for /agent/report/central-iowa")
        text = json.dumps({"smartctlMissing": False, "source": "scan", "disks": [{"device": "/dev/sda", "exit": 0, "smart": ata("WDC", True)}]})
        self.assertEqual(sr.run_once(self.cfg, ssh=lambda cfg: (text, 0), post=refuse, clock=lambda: 1730000000.0), 2)

    def test_dry_run_prints_and_does_not_post(self):
        text = json.dumps({"smartctlMissing": False, "source": "scan", "disks": [{"device": "/dev/sda", "exit": 0, "smart": ata("WDC", True)}]})
        self.assertEqual(self.run_with(text, dry_run=True), 0)
        self.assertEqual(self.posts, [])
        self.assertEqual(self.report()[1]["status"], "dry-run")


class WrapperTests(unittest.TestCase):
    """Runs the real host wrapper with a fake smartctl and a sample /proc/mdstat."""

    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.bin = os.path.join(self.dir, "bin")
        os.mkdir(self.bin)
        self.calls = os.path.join(self.dir, "calls")
        self.smartctl = os.path.join(self.bin, "smartctl")
        with open(self.smartctl, "w") as fh:
            fh.write(f"""#!/bin/sh
echo "$*" >> {self.calls}
case "$*" in
  --scan*) echo "/dev/sdc -d sat # /dev/sdc, ATA device"; exit 0 ;;
esac
dev=$(eval echo \\${{$#}})
case "$dev" in
  /dev/sda|/dev/sdb|/dev/sdc) printf '{{"model_name":"WDC WD40EFPX","serial_number":"WD-SECRET","smart_status":{{"passed":true}},"temperature":{{"current":33}}}}\\n'; exit 0 ;;
  *) printf '{{"smartctl":{{"messages":[{{"string":"open failed","severity":"error"}}]}}}}\\n'; exit 2 ;;
esac
""")
        os.chmod(self.smartctl, stat.S_IRWXU)
        self.mdstat = os.path.join(self.dir, "mdstat")

    def tearDown(self):
        shutil.rmtree(self.dir)

    def run_wrapper(self, mdstat, extra_env=None, smartctl=True):
        with open(self.mdstat, "w") as fh:
            fh.write(mdstat)
        env = {"PATH": "/usr/bin:/bin", "MDSTAT": self.mdstat, **(extra_env or {})}
        env["SMARTCTL"] = self.smartctl if smartctl else os.path.join(self.dir, "no-such-smartctl")
        proc = subprocess.run(["sh", WRAPPER], capture_output=True, text=True, env=env, timeout=30)
        return proc.returncode, json.loads(proc.stdout)

    def test_raid1_members_are_discovered_from_mdstat(self):
        mdstat = ("Personalities : [raid1]\n"
                  "md1 : active raid1 sdb3[1] sda3[0]\n      3902187456 blocks super 1.2 [2/2] [UU]\n\n"
                  "md0 : active raid1 sdb1[1] sda1[0]\n      8382464 blocks super 1.2 [2/2] [UU]\n\nunused devices: <none>\n")
        status, out = self.run_wrapper(mdstat)
        self.assertEqual(status, 0)
        self.assertEqual(out["source"], "mdstat")
        self.assertEqual([d["device"] for d in out["disks"]], ["/dev/sdb", "/dev/sda"], "each parent disk once")
        with open(self.calls) as fh:
            calls = fh.read().splitlines()
        self.assertEqual(calls, ["-i -H -A -j /dev/sdb", "-i -H -A -j /dev/sda"], "one read per disk, no self-test")
        self.assertFalse(any(" -t " in c or c.startswith("-t") for c in calls))

    def test_nvme_members_map_to_the_namespace(self):
        status, out = self.run_wrapper("md2 : active raid1 nvme1n1p1[1] nvme0n1p1[0]\n")
        self.assertEqual([d["device"] for d in out["disks"]], ["/dev/nvme1n1", "/dev/nvme0n1"])

    def test_scan_fallback_and_unopenable_disk(self):
        status, out = self.run_wrapper("Personalities :\nunused devices: <none>\n")
        self.assertEqual((status, out["source"], [d["device"] for d in out["disks"]]), (0, "scan", ["/dev/sdc"]))
        status, out = self.run_wrapper("md1 : active raid1 sdx3[0] sda3[1]\n")
        rows = [sr.parse_disk(d) for d in out["disks"]]
        self.assertEqual([(r["device"], r["health"]) for r in rows], [("/dev/sdx", "UNKNOWN"), ("/dev/sda", "PASSED")])

    def test_smartctl_missing(self):
        status, out = self.run_wrapper("md1 : active raid1 sdb3[1] sda3[0]\n", smartctl=False)
        self.assertEqual(status, 3)
        self.assertTrue(out["smartctlMissing"])
        self.assertEqual([d["device"] for d in out["disks"]], ["/dev/sdb", "/dev/sda"])

    def test_host_sensors_are_read_from_sysfs(self):
        sysfs = os.path.join(self.dir, "sys")
        files = {
            "class/thermal/thermal_zone0/type": "acpitz\n", "class/thermal/thermal_zone0/temp": "-263200\n",
            "class/thermal/thermal_zone1/type": "x86_pkg_temp\n", "class/thermal/thermal_zone1/temp": "51000\n",
            "class/hwmon/hwmon2/name": "coretemp\n", "class/hwmon/hwmon2/temp1_input": "52000\n", "class/hwmon/hwmon2/temp1_label": "Package id 0\n",
            "class/hwmon/hwmon2/temp2_input": "not-a-number\n", "class/hwmon/hwmon3/name": 'odd"name\n', "class/hwmon/hwmon3/temp1_input": "47000\n",
        }
        for rel, body in files.items():
            path = os.path.join(sysfs, rel)
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "w") as fh:
                fh.write(body)
        status, out = self.run_wrapper("md1 : active raid1 sda3[0]\n", {"SYSFS": sysfs})
        self.assertEqual(status, 0)
        self.assertEqual(sorted((s["source"], s["raw"]) for s in out["sensors"]), [
            ("hwmon/hwmon2/temp1_input", 52000), ("hwmon/hwmon3/temp1_input", 47000),
            ("thermal/thermal_zone0/temp", -263200), ("thermal/thermal_zone1/temp", 51000)], "non-numeric value skipped")
        self.assertEqual(sr.parse_host_temperatures(out["sensors"])[0]["temperatureC"], 52)

    def test_no_sysfs_means_an_empty_sensor_list_and_disks_unaffected(self):
        status, out = self.run_wrapper("md1 : active raid1 sda3[0]\n", {"SYSFS": os.path.join(self.dir, "nothing")})
        self.assertEqual((status, out["sensors"], [d["device"] for d in out["disks"]]), (0, [], ["/dev/sda"]))

    def test_data_path_free_and_total(self):
        status, out = self.run_wrapper("md1 : active raid1 sda3[0]\n", {"DATA_PATH": self.dir})
        fs = out["filesystem"]
        self.assertEqual(fs["path"], self.dir)
        self.assertGreater(fs["totalBytes"], 0)
        self.assertLessEqual(fs["freeBytes"], fs["totalBytes"])


# Raw host readings as the wrapper sends them: a bogus acpitz zone, an x86_pkg_temp zone, coretemp
# package + core (millidegrees), an over-range core, a PCH sensor and a plain-degrees value.
RAW_SENSORS = [
    {"source": "thermal/thermal_zone0/temp", "device": "acpitz", "label": "", "raw": -263200},
    {"source": "thermal/thermal_zone1/temp", "device": "x86_pkg_temp", "label": "", "raw": 51000},
    {"source": "hwmon/hwmon2/temp1_input", "device": "coretemp", "label": "Package id 0", "raw": 52000},
    {"source": "hwmon/hwmon2/temp2_input", "device": "coretemp", "label": "Core 0", "raw": 49000},
    {"source": "hwmon/hwmon2/temp3_input", "device": "coretemp", "label": "Core 1", "raw": 200000},
    {"source": "hwmon/hwmon3/temp1_input", "device": "pch_jasperlake", "label": "", "raw": 47000},
    {"source": "hwmon/hwmon4/temp1_input", "device": "nvme", "label": "Composite", "raw": 38},
    {"source": "hwmon/hwmon5/temp1_input", "device": "x", "label": "", "raw": float("inf")},
]


class TemperatureTests(unittest.TestCase):
    def test_same_filtering_and_order_as_the_agent(self):
        temps = sr.parse_host_temperatures(RAW_SENSORS)
        self.assertEqual([(t["temperatureC"], t["kind"]) for t in temps],
                         [(52, "cpu"), (51, "cpu"), (49, "cpu"), (47, "unclassified"), (38, "unclassified")],
                         "-263 and 200 dropped, non-finite dropped, CPU first then hottest")
        self.assertEqual(temps[0]["label"], "Package id 0 (coretemp/hwmon/hwmon2/temp1_input)")
        self.assertEqual(temps[1]["label"], "x86_pkg_temp (thermal/thermal_zone1/temp)")

    def test_payload_carries_the_headline_and_the_list(self):
        parsed = sr.parse_wrapper_output(json.dumps({"smartctlMissing": False, "source": "mdstat", "sensors": RAW_SENSORS,
                                                     "disks": [{"device": "/dev/sda", "exit": 0, "smart": ata("WDC", True)}]}), 0)
        t = sr.build_payload(parsed, 1)["telemetry"]
        self.assertEqual((t["temperatureC"], t["temperatureKind"]), (52, "cpu"))
        self.assertEqual(t["temperatureSource"], "Package id 0 (coretemp/hwmon/hwmon2/temp1_input)")
        self.assertEqual(len(t["temperatures"]), 5)

    def test_bad_or_missing_sensors_mean_null_temperature_not_a_failure(self):
        for sensors in (None, [], "garbage", [{"raw": "x"}], [{"raw": -263200}], [{"raw": True}]):
            body = {"smartctlMissing": False, "source": "mdstat", "disks": [{"device": "/dev/sda", "exit": 0, "smart": ata("WDC", True)}]}
            if sensors is not None:
                body["sensors"] = sensors
            parsed = sr.parse_wrapper_output(json.dumps(body), 0)
            t = sr.build_payload(parsed, 1)["telemetry"]
            self.assertIsNone(t["temperatureC"], f"sensors={sensors!r}")
            self.assertNotIn("temperatures", t)


class TemperatureRunTests(unittest.TestCase):
    # Same harness as RunOnceTests, without re-running its tests.
    setUp, tearDown, post, run_with, report = RunOnceTests.setUp, RunOnceTests.tearDown, RunOnceTests.post, RunOnceTests.run_with, RunOnceTests.report

    def test_temperature_failure_still_posts_the_smart_report(self):
        text = json.dumps({"smartctlMissing": False, "source": "mdstat", "sensors": [{"raw": "unreadable"}],
                           "disks": [{"device": "/dev/sda", "exit": 0, "smart": ata("WDC", True)}]})
        self.assertEqual(self.run_with(text), 0)
        self.assertEqual(len(self.posts), 1)
        self.assertIsNone(self.posts[0]["telemetry"]["temperatureC"])
        self.assertEqual(self.posts[0]["telemetry"]["smartHealth"], [{"device": "/dev/sda · WDC", "health": "ok"}])

    def test_an_unknown_disk_still_blocks_the_post_even_with_a_good_temperature(self):
        text = json.dumps({"smartctlMissing": False, "source": "mdstat", "sensors": RAW_SENSORS, "disks": [
            {"device": "/dev/sda", "exit": 0, "smart": ata("WDC", True)}, {"device": "/dev/sdz", "exit": 2, "smart": OPEN_FAILED}]})
        self.assertEqual(self.run_with(text), 2)
        self.assertEqual(self.posts, [])

    def test_the_temperature_lands_in_the_local_report(self):
        text = json.dumps({"smartctlMissing": False, "source": "mdstat", "sensors": RAW_SENSORS,
                           "disks": [{"device": "/dev/sda", "exit": 0, "smart": ata("WDC", True)}]})
        self.assertEqual(self.run_with(text), 0)
        self.assertEqual(self.report()[1]["temperatures"][0]["temperatureC"], 52)


class ScheduleTests(unittest.TestCase):
    def test_an_early_wakeup_never_runs_before_the_target(self):
        tz = ZoneInfo("America/Chicago")
        target = datetime.datetime(2026, 10, 29, 20, 16, tzinfo=tz)
        clock = [target.timestamp() - 120]
        slept = []

        def sleep(seconds):
            slept.append(seconds)
            clock[0] += seconds - (1.5 if len(slept) == 1 else 0)  # the first sleep wakes 1.5s early

        sr.sleep_until(target, 120, sleep=sleep, now=lambda: clock[0])
        self.assertGreaterEqual(clock[0], target.timestamp())
        self.assertEqual(slept, [120, 2])
        wait, nxt = sr.seconds_until_next("20:16", "America/Chicago", now=datetime.datetime.fromtimestamp(clock[0], tz))
        self.assertEqual((nxt.day, nxt.hour, nxt.minute), (30, 20, 16), "after the run, the next target is tomorrow")

    def test_next_run_is_the_next_0317_chicago(self):
        tz = ZoneInfo("America/Chicago")
        wait, target = sr.seconds_until_next("03:17", "America/Chicago", now=datetime.datetime(2026, 10, 30, 1, 0, tzinfo=tz))
        self.assertEqual((target.day, target.hour, target.minute, wait), (30, 3, 17, 8220))
        wait, target = sr.seconds_until_next("03:17", "America/Chicago", now=datetime.datetime(2026, 10, 30, 4, 0, tzinfo=tz))
        self.assertEqual((target.day, target.hour), (31, 3))

    def test_dst_change_keeps_wall_clock_time(self):
        tz = ZoneInfo("America/Chicago")
        # 2026-11-01 02:00 CDT -> 01:00 CST. From 2026-10-31 04:00 CDT the next 03:17 CST is 24h later.
        wait, target = sr.seconds_until_next("03:17", "America/Chicago", now=datetime.datetime(2026, 10, 31, 4, 0, tzinfo=tz))
        self.assertEqual((target.month, target.day, target.hour, target.minute), (11, 1, 3, 17))
        self.assertEqual(wait, 24 * 3600 + 17 * 60)


if __name__ == "__main__":
    unittest.main()
