"""Tests for restart_logger.py against a fake docker CLI (no real Docker, no network).

Run: python3 -m unittest discover -s deploy/durant-server-restart-logger -p 'test_*.py'
"""

import datetime
import json
import os
import stat
import subprocess
import sys
import tempfile
import textwrap
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "restart_logger.py")
sys.path.insert(0, HERE)
import restart_logger as R  # noqa: E402

SECRET_ENV = ["PLEX_CLAIM=claim-SUPERSECRET-123", "API_KEY=deadbeefcafebabe0123456789abcdef", "RCLONE_PASS=hunter22"]

FAKE_DOCKER = textwrap.dedent('''\
    #!/usr/bin/env python3
    import json, os, sys
    fx = json.load(open(os.environ["FAKE_DOCKER_FIXTURE"]))
    calls = os.environ.get("FAKE_DOCKER_CALLS")
    if calls:
        open(calls, "a").write(json.dumps(sys.argv[1:]) + "\\n")
    mode = fx.get("mode", "ok")
    if mode == "down":
        sys.stderr.write("Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\\n"); sys.exit(1)
    if mode == "denied":
        sys.stderr.write("permission denied while trying to connect to the Docker daemon socket\\n"); sys.exit(1)
    cmd = sys.argv[1]
    if cmd not in ("ps", "inspect", "logs"):
        sys.stderr.write("fake docker: refused " + cmd + "\\n"); sys.exit(99)
    cs = fx["containers"]
    if cmd == "ps":
        print("\\n".join(c["Id"] for c in cs)); sys.exit(0)
    if cmd == "inspect":
        ids = sys.argv[4:]
        for c in cs:
            if c["Id"] not in ids: continue
            rec = {"id": c["Id"], "name": "/" + c["Name"], "startedAt": c["StartedAt"], "status": c.get("Status", "running"),
                   "restartCount": c.get("RestartCount", 0), "image": "sha256:" + c["Image"], "imageRef": c.get("ImageRef", "x/" + c["Name"]),
                   "policy": c.get("Policy", "unless-stopped")}
            if fx.get("leak"):  # a template mistake that let Env and Cmd through
                rec["Env"] = c.get("Env", []); rec["Cmd"] = c.get("Cmd", [])
            print(json.dumps(rec))
        sys.exit(0)
    if cmd == "logs":
        if fx.get("logsDenied"):
            sys.stderr.write("permission denied\\n"); sys.exit(1)
        sys.stderr.write(fx.get("watchtowerLog", "")); sys.exit(0)
''')


def cid(n):
    return (format(n, "x") * 64)[:64]


def img(n):
    return (format(n + 10, "x") * 64)[:64]


def containers(names, started="2026-10-20T03:00:00.123456789Z"):
    return [{"Id": cid(i + 1), "Name": n, "StartedAt": started, "Image": img(i + 1), "RestartCount": 0,
             "Env": SECRET_ENV, "Cmd": ["rclone", "--password", "hunter22"]} for i, n in enumerate(names)]


STACK = ["plex", "radarr", "sonarr", "syncthing", "qbittorrent", "media-cloudflared", "speedtest-tracker", "watchtower"]


class Harness:
    def __init__(self):
        self.dir = tempfile.mkdtemp(prefix="restart-logger-test-")
        self.base = os.path.join(self.dir, "rl")
        self.fixture = os.path.join(self.dir, "fixture.json")
        self.calls = os.path.join(self.dir, "calls.jsonl")
        self.docker = os.path.join(self.dir, "docker")
        with open(self.docker, "w") as fh:
            fh.write(FAKE_DOCKER)
        os.chmod(self.docker, 0o755)
        self.uptime = os.path.join(self.dir, "uptime")
        self.env_file = os.path.join(self.dir, "env")
        self.set_uptime(30 * 86400)

    def set_uptime(self, seconds):
        with open(self.uptime, "w") as fh:
            fh.write(f"{seconds:.2f} 12345.00\n")

    def set(self, cs, **extra):
        with open(self.fixture, "w") as fh:
            json.dump({"containers": cs, **extra}, fh)

    def env(self):
        return {**os.environ, "FAKE_DOCKER_FIXTURE": self.fixture, "FAKE_DOCKER_CALLS": self.calls, "DOCKER_BIN": self.docker,
                "PROC_UPTIME": self.uptime, "RESTART_LOGGER_DIR": self.base, "PYTHONDONTWRITEBYTECODE": "1"}

    def run(self, *args):
        return subprocess.run([sys.executable, "-B", SCRIPT, "--env-file", self.env_file, *args], capture_output=True, text=True, env=self.env())

    def poll(self, now):
        os.environ.update({k: v for k, v in self.env().items() if k.startswith("FAKE_DOCKER")})  # for the fake docker child
        cfg = R.load_config(self.env_file, self.env())
        out, err = _Sink(), _Sink()
        code = R.poll(cfg, now=now, out=out, err=err)
        return code, err.text

    def log(self):
        d = os.path.join(self.base, "logs")
        return "".join(open(os.path.join(d, f)).read() for f in sorted(os.listdir(d))) if os.path.isdir(d) else ""

    def jsonl(self):
        d = os.path.join(self.base, "reports")
        lines = []
        for f in sorted(os.listdir(d)) if os.path.isdir(d) else []:
            lines += [json.loads(x) for x in open(os.path.join(d, f)) if x.strip()]
        return lines

    def everything(self):
        text = []
        for root, _dirs, files in os.walk(self.base):
            for f in files:
                text.append(open(os.path.join(root, f), errors="replace").read())
        return "\n".join(text)


class _Sink:
    def __init__(self):
        self.text = ""

    def write(self, s):
        self.text += s


T0 = datetime.datetime(2026, 10, 28, 3, 0, 0, tzinfo=datetime.timezone.utc)
T1 = T0 + datetime.timedelta(minutes=5)


def restarted(cs, names, started="2026-10-28T03:03:12.5Z", **change):
    out = []
    for c in cs:
        c = dict(c)
        if c["Name"] in names:
            c["StartedAt"] = started
            c.update(change)
        out.append(c)
    return out


class RestartLoggerTest(unittest.TestCase):
    def setUp(self):
        self.h = Harness()
        self.base_cs = containers(STACK)
        self.h.set(self.base_cs)
        code, _ = self.h.poll(T0)
        self.assertEqual(code, 0)
        self.assertIn("BASELINE 8 containers recorded; restarts before this poll are unknown (not 0)", self.h.log())

    def events(self):
        return [e for e in self.h.jsonl() if e.get("type") not in (None, "baseline")]

    def test_no_change_writes_no_log_line(self):
        before = self.h.log()
        code, _ = self.h.poll(T1)
        self.assertEqual(code, 0)
        self.assertEqual(self.h.log(), before)
        latest = json.load(open(os.path.join(self.h.base, "latest.json")))
        self.assertEqual((latest["restarts"], latest["unexplained"], latest["containers"]), (0, 0, 8))

    def test_single_restart_image_unchanged_is_unexplained(self):
        self.h.set(restarted(self.base_cs, {"radarr"}))
        self.assertEqual(self.h.poll(T1)[0], 0)
        [e] = self.events()
        self.assertEqual((e["name"], e["classification"], e["unexplained"], e["imageChanged"]), ("radarr", "unexplained", True, False))
        line = [l for l in self.h.log().splitlines() if "RESTART radarr" in l][0]
        self.assertIn("detected between 2026-10-28T03:00:00Z and 2026-10-28T03:05:00Z (poll window)", line)
        self.assertIn("latest start 2026-10-28T03:03:12.5Z (was 2026-10-20T03:00:00.123456789Z)", line)
        self.assertIn("restarts +0", line)
        self.assertIn("image unchanged", line)
        self.assertIn("policy unless-stopped", line)
        self.assertIn("host up 30d 0h", line)
        self.assertTrue(line.endswith("unexplained: needs a human check · UNEXPLAINED"))
        self.assertNotIn("manual", line.lower())

    def test_restart_count_rise_is_policy_restart_and_twice_is_a_delta_not_two_events(self):
        self.h.set(restarted(self.base_cs, {"sonarr"}, RestartCount=2))
        self.h.poll(T1)
        [e] = self.events()
        self.assertEqual((e["classification"], e["restartDelta"], e["unexplained"]), ("policy-restart", 2, True))
        self.assertIn("restarts +2", self.h.log())
        self.assertEqual(self.h.log().count("RESTART sonarr"), 1)

    def test_single_restart_image_changed_is_watchtower_consistent_not_proof(self):
        self.h.set(restarted(self.base_cs, {"plex"}, Image=img(99), Id=cid(9)))
        self.h.poll(T1)
        [e] = self.events()
        self.assertEqual((e["classification"], e["unexplained"], e["recreated"]), ("image-changed", False, True))
        self.assertIn("image changed: consistent with a Watchtower image update, not proof", e["explanation"])
        self.assertIn("count reset (new container)", self.h.log())

    def test_image_changed_with_matching_watchtower_log(self):
        log = ('time="2026-10-28T03:02:01Z" level=info msg="Found new plexinc/pms-docker:latest image (0123abcd)"\n'
               'time="2026-10-28T03:02:05Z" level=info msg="Stopping /plex (1111) with SIGTERM"\n'
               'time="2026-10-28T03:02:20Z" level=info msg="Creating /plex"\n'
               'time="2026-10-28T03:02:30Z" level=info msg="Session done" Failed=0 Scanned=8 Updated=1 notify=shoutrrr://token-in-url@x\n')
        self.h.set(restarted(self.base_cs, {"plex"}, Image=img(99), Id=cid(9)), watchtowerLog=log)
        self.h.poll(T1)
        [e] = self.events()
        self.assertEqual(e["explanation"], "image changed: Watchtower log matches this window")
        self.assertNotIn("token-in-url", self.h.everything(), "Watchtower log text is never copied out")
        calls = [json.loads(x) for x in open(self.h.calls)]
        logs_call = [c for c in calls if c[0] == "logs"][0]
        self.assertEqual(logs_call, ["logs", "--since", "2026-10-28T03:00:00Z", "--until", "2026-10-28T03:05:00Z", "watchtower"])

    def test_watchtower_log_unreadable_keeps_weaker_wording(self):
        self.h.set(restarted(self.base_cs, {"plex"}, Image=img(99)), logsDenied=True)
        self.h.poll(T1)
        [e] = self.events()
        self.assertEqual(e["explanation"], "image changed: consistent with a Watchtower image update, not proof (Watchtower log not readable)")

    def test_watchtower_own_restart_is_not_flagged(self):
        self.h.set(restarted(self.base_cs, {"watchtower"}, Image=img(77), Id=cid(15)))
        self.h.poll(T1)
        [e] = self.events()
        self.assertEqual((e["classification"], e["unexplained"]), ("watchtower-self", False))
        self.assertNotIn("UNEXPLAINED", self.h.log())

    def test_all_restarted_and_uptime_reset_is_reboot_consistent(self):
        self.h.set_uptime(120)  # booted 2 minutes before this poll, inside the window
        self.h.set(restarted(self.base_cs, set(STACK) - {"watchtower"}))
        self.h.poll(T1)
        evs = self.events()
        self.assertEqual(len(evs), 7)
        self.assertTrue(all(e["classification"] == "host-reboot" and not e["unexplained"] for e in evs))
        self.assertIn("host booted at 2026-10-28T03:03:00Z (uptime 2m): consistent with a host reboot", evs[0]["explanation"])

    def test_all_restarted_and_uptime_old_is_stack_redeploy_consistent(self):
        self.h.set(restarted(self.base_cs, set(STACK) - {"watchtower"}))
        self.h.poll(T1)
        evs = self.events()
        self.assertTrue(all(e["classification"] == "stack-wide" and e["unexplained"] for e in evs))
        self.assertIn("host did not reboot (up 30d 0h): consistent with a stack redeploy or Docker daemon restart; check Portainer redeploy history (not proof)", evs[0]["explanation"])
        latest = json.load(open(os.path.join(self.h.base, "latest.json")))
        self.assertEqual((latest["restarts"], latest["unexplained"]), (7, 7))
        log = self.h.log()
        self.assertEqual(log.count(" CLUSTER "), 1)
        self.assertEqual(log.count("check Portainer redeploy history"), 1, "the long wording is logged once")
        self.assertEqual(log.count("part of the cluster above"), 7)

    def test_appeared_gone_and_stopped(self):
        cs = [c for c in self.base_cs if c["Name"] != "speedtest-tracker"] + containers(["newthing"])[:1]
        cs[-1] = dict(cs[-1], Id=cid(14), Name="newthing")
        cs = [dict(c, Status="exited") if c["Name"] == "qbittorrent" else c for c in cs]
        self.h.set(cs)
        self.h.poll(T1)
        types = {(e["type"], e["name"]) for e in self.events()}
        self.assertEqual(types, {("gone", "speedtest-tracker"), ("appeared", "newthing"), ("stopped", "qbittorrent")})
        self.assertTrue(all(not e["unexplained"] for e in self.events()))

    def test_docker_unreachable_fails_without_a_false_no_restarts(self):
        state_before = open(os.path.join(self.h.base, "state.json")).read()
        self.h.set(self.base_cs, mode="down")
        res = self.h.run()
        self.assertEqual(res.returncode, 1)
        self.assertIn("FAIL docker ps failed: daemon unreachable; no restart report this poll", self.h.log())
        latest = json.load(open(os.path.join(self.h.base, "latest.json")))
        self.assertEqual(latest["ok"], False)
        self.assertNotIn("restarts", latest)
        self.assertEqual(open(os.path.join(self.h.base, "state.json")).read(), state_before)
        self.h.set(self.base_cs, mode="denied")
        res = self.h.run()
        self.assertEqual(res.returncode, 1)
        self.assertIn("permission denied (is media@ in the docker group?)", self.h.log())

    def test_corrupt_state_fails_keeps_backup_and_recovers_by_baselining(self):
        self.h.set(restarted(self.base_cs, {"radarr"}))
        self.h.poll(T1)  # second good poll: state.json.bak now holds the T0 state
        state_path = os.path.join(self.h.base, "state.json")
        backup_path = os.path.join(self.h.base, "state.json.bak")
        good_backup = open(backup_path).read()
        with open(state_path, "w") as fh:
            fh.write('{"version": 1, "containers": {"plex": ')
        res = self.h.run()
        self.assertEqual(res.returncode, 1)
        self.assertIn("state file", res.stderr)
        self.assertIn("is corrupt; it was not overwritten", self.h.log())
        self.assertEqual(open(state_path).read(), '{"version": 1, "containers": {"plex": ', "corrupt file left as is")
        self.assertEqual(open(backup_path).read(), good_backup, "last good state kept")
        self.assertNotIn("0 restart", self.h.log())
        # Documented recovery: move the corrupt file aside; the next poll baselines.
        os.rename(state_path, state_path + ".corrupt")
        res = self.h.run()
        self.assertEqual(res.returncode, 0, res.stderr)
        self.assertEqual(self.h.log().count("BASELINE 8 containers recorded; restarts before this poll are unknown (not 0)"), 2)

    def test_field_whitelist_secrets_never_logged(self):
        self.h.set(restarted(self.base_cs, {"radarr", "plex"}), leak=True)
        self.h.run()
        everything = self.h.everything()
        for secret in ("SUPERSECRET", "deadbeefcafebabe", "hunter22", "PLEX_CLAIM", "RCLONE_PASS", "--password"):
            self.assertNotIn(secret, everything, secret)
        self.assertIn("RESTART radarr", everything)

    def test_only_read_only_docker_commands(self):
        self.h.set(restarted(self.base_cs, {"plex"}, Image=img(99)))
        self.h.run()
        cmds = {json.loads(x)[0] for x in open(self.h.calls)}
        self.assertTrue(cmds <= {"ps", "inspect", "logs"}, cmds)
        src = open(SCRIPT).read()
        import re
        # Every docker invocation in the source names ps, inspect or logs as its subcommand.
        subcommands = set(re.findall(r'run_docker\(cfg, \["(\w+)"', src)) | set(re.findall(r'\[cfg\["docker"\], "(\w+)"', src))
        self.assertEqual(subcommands, {"ps", "inspect", "logs"})
        self.assertNotRegex(src, r'"sudo"|sudo\s+-|os\.system|shell=True')

    def test_dry_run_writes_nothing(self):
        h = Harness()
        h.set(self.base_cs)
        res = h.run("--dry-run")
        self.assertEqual(res.returncode, 0, res.stderr)
        self.assertIn("BASELINE 8 containers", res.stdout)
        self.assertFalse(os.path.exists(h.base))


class HeartbeatTest(unittest.TestCase):
    def test_off_unless_both_set_and_never_uptime_ingest(self):
        self.assertEqual(R.heartbeat_config({})["enabled"], False)
        self.assertIn("TOKEN not set", R.heartbeat_config({"BOT_HEARTBEAT_URL": "https://bot.example/api/automation/heartbeat"})["note"])
        self.assertIn("URL not set", R.heartbeat_config({"BOT_HEARTBEAT_TOKEN": "t"})["note"])
        with self.assertRaises(R.PollError):
            R.heartbeat_config({"BOT_HEARTBEAT_URL": "https://bot.example/api/uptime/ingest", "BOT_HEARTBEAT_TOKEN": "t"})
        with self.assertRaises(R.PollError):
            R.heartbeat_config({"BOT_HEARTBEAT_URL": "http://bot.example/hb", "BOT_HEARTBEAT_TOKEN": "t"})
        self.assertTrue(R.heartbeat_config({"BOT_HEARTBEAT_URL": "https://bot.example/api/automation/heartbeat", "BOT_HEARTBEAT_TOKEN": "t"})["enabled"])

    def test_heartbeat_posts_common_fields_and_failure_never_breaks_logging(self):
        import http.server
        import threading
        got = []

        class H(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                body = self.rfile.read(int(self.headers["Content-Length"]))
                got.append((self.path, self.headers["Authorization"], json.loads(body)))
                self.send_response(200 if len(got) == 1 else 500)
                self.end_headers()

            def log_message(self, *a):
                pass

        srv = http.server.HTTPServer(("127.0.0.1", 0), H)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        try:
            h = Harness()
            with open(h.env_file, "w") as fh:
                fh.write(f"BOT_HEARTBEAT_URL=http://127.0.0.1:{srv.server_port}/api/automation/heartbeat\nBOT_HEARTBEAT_TOKEN=hb-placeholder\n")
            os.chmod(h.env_file, 0o600)
            cs = containers(STACK)
            h.set(cs)
            self.assertEqual(h.poll(T0)[0], 0)
            h.set(restarted(cs, {"radarr"}))
            self.assertEqual(h.poll(T1)[0], 0, "a heartbeat failure must not fail the poll")
            self.assertEqual(got[0][1], "Bearer hb-placeholder")
            self.assertEqual(got[0][0], "/api/automation/heartbeat")
            self.assertEqual({k: got[0][2][k] for k in ("name", "source", "status")}, {"name": "restart-logger", "source": "durant-server", "status": "ok"})
            self.assertEqual(got[1][2]["summary"], "1 restart(s) in window, 1 unexplained")
            self.assertEqual(got[1][2]["counts"], {"restarts": 1, "unexplained": 1, "containers": 8})
            self.assertIn("RESTART radarr", h.log())
            self.assertIn("WARN heartbeat failed (HTTP 500); logging continues", h.log())
            self.assertNotIn("hb-placeholder", h.everything())
        finally:
            srv.shutdown()

    def test_env_file_must_be_private(self):
        h = Harness()
        with open(h.env_file, "w") as fh:
            fh.write("BOT_HEARTBEAT_TOKEN=x\n")
        os.chmod(h.env_file, 0o644)
        with self.assertRaises(R.PollError):
            R.load_config(h.env_file, {})


class PureTest(unittest.TestCase):
    def test_docker_time_and_retention(self):
        self.assertIsNone(R.parse_docker_time("0001-01-01T00:00:00Z"))
        self.assertEqual(R.parse_docker_time("2026-10-28T03:03:12.123456789Z").isoformat(), "2026-10-28T03:03:12.123456+00:00")
        d = tempfile.mkdtemp()
        for n in ("restarts-2026-09-01.log", "restarts-2026-10-20.log", "other-2026-01-01.log"):
            open(os.path.join(d, n), "w").close()
        R.prune(d, "restarts", ".log", 30, T0)
        self.assertEqual(sorted(os.listdir(d)), ["other-2026-01-01.log", "restarts-2026-10-20.log"])

    def test_two_restarts_are_not_a_cluster(self):
        a = {"id": "a" * 12, "startedAt": "2026-10-20T00:00:00Z", "status": "running", "restartCount": 0, "image": "1" * 12, "policy": "always", "imageRef": "x/a"}
        prev = {"a": a, "b": dict(a, id="b" * 12, imageRef="x/b")}
        now = {k: dict(v, startedAt="2026-10-28T03:02:00Z") for k, v in prev.items()}
        evs = R.classify(R.diff(prev, now), last_poll=T0, now=T1, uptime_s=999999, watchtower_matches=set())
        self.assertTrue(all(e["classification"] == "unexplained" for e in evs))


if __name__ == "__main__":
    unittest.main()
