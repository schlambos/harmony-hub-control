#!/usr/bin/env python3
"""Tests for payload/scripts/offline_egress_guard.sh's USB Ethernet parts.

The guard runs for real under dash (a POSIX shell like the hub's BusyBox
ash) with only the hub's own commands on PATH, against fake route (a
routing table kept in routes.json and printed like `route -n`) and
wpa_cli commands and a temporary /sys tree. It must route the private
ranges and multicast through the interface usb_eth_service.sh names in
codex-lan-dev (only while the service's worker runs and that interface can
actually carry them), and when the worker is gone, have the service hand
everything back to Wi-Fi. GuardAndService runs the guard together with the
real usb_eth_service.sh in test_service.py's sandbox.

Run via tools/usb-eth-test/run_tests.sh (or directly with python3).
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
GUARD = REPO / "payload" / "scripts" / "offline_egress_guard.sh"
SHELL = [shutil.which("dash") or "/bin/sh"]

# The hub's commands (see test_service.py), less those faked here.
HUB_COMMANDS = ("[", "[[", "awk", "cat", "chmod", "cp", "cut", "date", "dirname", "dmesg",
                "echo", "expr", "grep", "hostname", "id", "kill", "ln", "ls", "md5sum",
                "mkdir", "mv", "nice", "pidof", "ps", "renice", "rm", "sed", "sh", "sleep",
                "test", "time", "touch", "tr", "which")

FAKE_ROUTE = r'''#!PYTHON
import json, os, sys
db = os.environ["FAKE_ROUTES"]
routes = json.load(open(db)) if os.path.exists(db) else []
a = sys.argv[1:]
def save(): json.dump(routes, open(db, "w"))
def opt(name, default=None):
    return a[a.index(name) + 1] if name in a else default
if a and a[0] == "-n":
    print("Kernel IP routing table")
    print("Destination     Gateway         Genmask         Flags Metric Ref    Use Iface")
    for r in routes:
        flags = "UG" if r["gw"] != "0.0.0.0" else "U"
        print(f'{r["net"]:<15} {r["gw"]:<15} {r["mask"]:<15} {flags:<5} {r["metric"]:<6} 0        0 {r["dev"]}')
    sys.exit(0)
with open(os.environ["FAKE_LOG"], "a") as f: f.write("route " + " ".join(a) + "\n")
cmd = a[0]
if "default" in a:
    net, mask = "0.0.0.0", "0.0.0.0"
else:
    net = opt("-net") or opt("-host"); mask = opt("netmask", "255.255.255.255")
r = {"net": net, "mask": mask, "gw": opt("gw", "0.0.0.0"), "dev": opt("dev", "?"), "metric": opt("metric", "0")}
if cmd == "add":
    if any(x["net"] == net and x["mask"] == mask and x["dev"] == r["dev"] and x["metric"] == r["metric"] for x in routes):
        sys.exit(1)
    routes.append(r); save()
elif cmd == "del":
    for i, x in enumerate(routes):
        if x["net"] == net and x["mask"] == mask and (r["dev"] == "?" or x["dev"] == r["dev"]) and ("metric" not in a or x["metric"] == r["metric"]):
            del routes[i]; save(); sys.exit(0)
    sys.exit(1)
'''

# ifconfig ath0: Wi-Fi's address while the test writes one to wifi-ip.
FAKE_IFCONFIG = """#!/bin/sh
if [ "$1" = ath0 ] && [ -s "$FAKE_WIFI_IP" ]; then
  echo "ath0      Link encap:Ethernet  HWaddr 00:04:20:00:00:01"
  echo "          inet addr:$(cat "$FAKE_WIFI_IP")  Bcast:192.168.1.255  Mask:255.255.255.0"
fi
"""

FAKE_WPA = """#!/bin/sh
echo "wpa_cli $*" >> "$FAKE_LOG"
[ -f "$FAKE_WPA_FAIL" ] && echo FAIL
exit 0
"""


class GuardHub(unittest.TestCase):
    """A temporary hub: Wi-Fi on 192.168.1.0/24, the cloud blocker on, the
    gateway 192.168.1.1 saved by the guard."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="usbeth-guard-"))
        t = self.tmp
        for d in ("run", "data", "bin", "hubbin", "sys/class/net/ath0"):
            (t / d).mkdir(parents=True, exist_ok=True)
        (t / "data/cloud_blocker.conf").write_text("1\n")
        (t / "run/gateway").write_text("192.168.1.1\n")
        (t / "routes.json").write_text(json.dumps([
            {"net": "192.168.1.0", "mask": "255.255.255.0", "gw": "0.0.0.0", "dev": "ath0", "metric": "0"},
            {"net": "224.0.0.0", "mask": "240.0.0.0", "gw": "0.0.0.0", "dev": "ath0", "metric": "0"},
        ]))
        (t / "wifi-ip").write_text("192.168.1.50\n")
        for name, body in (("route", FAKE_ROUTE.replace("#!PYTHON", "#!" + sys.executable, 1)), ("wpa_cli", FAKE_WPA),
                           ("ifconfig", FAKE_IFCONFIG)):
            p = t / "bin" / name
            p.write_text(body)
            p.chmod(0o755)
        for name in HUB_COMMANDS:
            real = shutil.which(name, path="/usr/bin:/bin:/usr/sbin:/sbin")
            if real:
                os.symlink(real, t / "hubbin" / name)
        path = f"{t / 'bin'}:{t / 'hubbin'}"
        self.env = {
            "PATH": path, "USBETH_PATH": path, "USBETH_BLOCKER": str(t / "data/cloud_blocker.conf"),
            "USBETH_SYS": str(t / "sys"), "FAKE_ROUTES": str(t / "routes.json"),
            "FAKE_LOG": str(t / "calls.log"), "FAKE_WPA_FAIL": str(t / "wpa-fails"),
            "FAKE_WIFI_IP": str(t / "wifi-ip"),
        }
        # usb_eth_service.sh's worker, alive unless a test ends it (kill_worker).
        self.worker = subprocess.Popen(["sleep", "300"])
        self.addCleanup(self.worker.kill)
        (t / "run/codex-usb-eth-worker.pid").write_text(f"{self.worker.pid}\n")

    def kill_worker(self):
        self.worker.kill()
        self.worker.wait()

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def routes(self):
        return json.loads((self.tmp / "routes.json").read_text())

    def route_metric(self, net, dev):
        return [r["metric"] for r in self.routes() if r["net"] == net and r["dev"] == dev]

    def plug_adapter(self):
        (self.tmp / "sys/class/net/eth2").mkdir(parents=True, exist_ok=True)

    def wait_for(self, path, seconds=5.0):
        import time
        end = time.time() + seconds
        while time.time() < end:
            if path.exists():
                return True
            time.sleep(0.05)
        return False


class EgressGuardLanDevice(GuardHub):
    """offline_egress_guard.sh routes through the LAN device usb_eth_service.sh names,
    and reconnects Wi-Fi if the service turned it off and its worker is gone."""

    def guard(self, **extra):
        e = dict(self.env, GUARD_USBETH_WIFI_OFF=str(self.tmp / "run/codex-usb-eth-wifi-off"),
                 GUARD_USBETH_PID=str(self.tmp / "run/codex-usb-eth-worker.pid"),
                 GUARD_USBETH_SERVICE=str(self.tmp / "no-usb_eth_service.sh"))
        e.update(extra)
        e = dict(e, GUARD_PATH=self.env["USBETH_PATH"], GUARD_BLOCKER=self.env["USBETH_BLOCKER"],
                 GUARD_GATEWAY_STATE=str(self.tmp / "run/gateway"), GUARD_PID_FILE=str(self.tmp / "run/guard.pid"),
                 GUARD_LAN_DEV_FILE=str(self.tmp / "run/codex-lan-dev"), GUARD_SYS=self.env["USBETH_SYS"],
                 GUARD_LOG=str(self.tmp / "guard.log"))
        return subprocess.run(SHELL + [str(GUARD)], env=e, capture_output=True, text=True, timeout=30)

    def private(self):
        return sorted((r["net"], r["gw"], r["dev"]) for r in self.routes() if r["net"] in ("10.0.0.0", "172.16.0.0", "192.168.0.0"))

    def test_private_routes_follow_the_lan_device(self):
        r = self.routes()
        r.append({"net": "0.0.0.0", "mask": "0.0.0.0", "gw": "192.168.1.1", "dev": "ath0", "metric": "0"})
        (self.tmp / "routes.json").write_text(json.dumps(r))
        self.guard()
        # Default route gone, private ranges through the saved gateway on Wi-Fi.
        self.assertEqual(self.route_metric("0.0.0.0", "ath0"), [])
        self.assertEqual({d for _, _, d in self.private()}, {"ath0"})
        self.assertEqual(len(self.private()), 3)
        # The adapter takes over: the guard moves them (and multicast) to eth2.
        self.plug_adapter()
        r = self.routes()
        r.append({"net": "192.168.1.0", "mask": "255.255.255.0", "gw": "0.0.0.0", "dev": "eth2", "metric": "0"})
        (self.tmp / "routes.json").write_text(json.dumps(r))
        (self.tmp / "run/codex-lan-dev").write_text("eth2\n")
        self.guard()
        self.assertEqual({d for _, _, d in self.private()}, {"eth2"})
        self.assertEqual(len(self.private()), 3)
        self.assertEqual(self.route_metric("224.0.0.0", "eth2"), ["0"])
        self.assertEqual(self.route_metric("224.0.0.0", "ath0"), [])
        # Adapter gone: back to Wi-Fi.
        (self.tmp / "run/codex-lan-dev").unlink()
        self.guard()
        self.assertEqual({d for _, _, d in self.private()}, {"ath0"})
        self.assertEqual(self.route_metric("224.0.0.0", "ath0"), ["0"])

    def test_an_adapter_without_an_address_or_off_the_gateways_subnet_is_ignored(self):
        r = self.routes()
        r.append({"net": "0.0.0.0", "mask": "0.0.0.0", "gw": "192.168.1.1", "dev": "ath0", "metric": "0"})
        (self.tmp / "routes.json").write_text(json.dumps(r))
        self.guard()
        self.plug_adapter()
        (self.tmp / "run/codex-lan-dev").write_text("eth2\n")
        # eth2 exists but has no address (no connected route): nothing moves.
        self.guard()
        self.assertEqual({d for _, _, d in self.private()}, {"ath0"})
        self.assertEqual(self.route_metric("224.0.0.0", "ath0"), ["0"])
        # An address on another subnet than the saved gateway: still nothing moves.
        r = self.routes()
        r.append({"net": "10.9.8.0", "mask": "255.255.255.0", "gw": "0.0.0.0", "dev": "eth2", "metric": "0"})
        (self.tmp / "routes.json").write_text(json.dumps(r))
        self.guard()
        self.assertEqual({d for _, _, d in self.private()}, {"ath0"})
        self.assertEqual(len(self.private()), 3)
        self.assertEqual(self.route_metric("224.0.0.0", "ath0"), ["0"])

    def guard_env(self):
        return dict(GUARD_USBETH_WIFI_OFF=str(self.tmp / "run/codex-usb-eth-wifi-off"),
                    GUARD_USBETH_PID=str(self.tmp / "run/codex-usb-eth-worker.pid"))

    def test_reconnects_wifi_if_the_service_worker_is_gone(self):
        state = self.tmp / "run/codex-usb-eth-wifi-off"
        state.write_text("")
        # A live worker: leave Wi-Fi to it.
        live = subprocess.Popen(["sleep", "30"])
        self.addCleanup(live.kill)
        (self.tmp / "run/codex-usb-eth-worker.pid").write_text(f"{live.pid}\n")
        self.guard(**self.guard_env())
        self.assertTrue(state.exists())
        self.assertNotIn("wpa_cli", (self.tmp / "calls.log").read_text() if (self.tmp / "calls.log").exists() else "")
        # The worker is gone: the guard reconnects Wi-Fi.
        live.kill()
        live.wait()
        self.guard(**self.guard_env())
        self.assertFalse(state.exists())
        self.assertIn("wpa_cli -i ath0 reconnect", (self.tmp / "calls.log").read_text())
        self.assertIn("reconnected Wi-Fi", (self.tmp / "guard.log").read_text())

    def test_a_running_guard_announces_its_watchdog(self):
        caps = self.tmp / "run/guard.caps"
        e = dict(self.env, GUARD_PATH=self.env["USBETH_PATH"], GUARD_BLOCKER=self.env["USBETH_BLOCKER"],
                 GUARD_GATEWAY_STATE=str(self.tmp / "run/gateway"), GUARD_PID_FILE=str(self.tmp / "run/guard.pid"),
                 GUARD_LAN_DEV_FILE=str(self.tmp / "run/codex-lan-dev"), GUARD_SYS=self.env["USBETH_SYS"],
                 GUARD_LOG=str(self.tmp / "guard.log"), GUARD_CAPS_FILE=str(caps),
                 GUARD_USBETH_WIFI_OFF=str(self.tmp / "run/codex-usb-eth-wifi-off"),
                 GUARD_USBETH_PID=str(self.tmp / "run/codex-usb-eth-worker.pid"))
        g = subprocess.Popen(SHELL + [str(GUARD), "monitor"], env=e, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.addCleanup(lambda: g.poll() is None and g.kill())
        self.assertTrue(self.wait_for(caps))
        self.assertEqual(caps.read_text().strip(), "wifi-watchdog")
        self.assertEqual((self.tmp / "run/guard.pid").read_text().strip(), str(g.pid))
        # A hangup (the end of the SSH session an installer started it from)
        # leaves it running: until the next boot nothing would restart it.
        import time, signal
        g.send_signal(signal.SIGHUP)
        time.sleep(1.5)
        self.assertIsNone(g.poll(), "the guard exited on SIGHUP")
        self.assertTrue(caps.exists())
        g.terminate()
        g.wait(timeout=10)
        self.assertFalse(caps.exists(), "the guard left its caps file behind")

    def test_with_the_blocker_off_the_default_route_decides_like_the_service(self):
        # A gateway saved back when the blocker was on (another network) must
        # not keep multicast on Wi-Fi while the service uses the cable.
        (self.tmp / "data/cloud_blocker.conf").write_text("0\n")
        (self.tmp / "run/gateway").write_text("10.0.0.1\n")
        self.plug_adapter()
        r = self.routes()
        r += [{"net": "0.0.0.0", "mask": "0.0.0.0", "gw": "192.168.1.1", "dev": "ath0", "metric": "0"},
              {"net": "192.168.1.0", "mask": "255.255.255.0", "gw": "0.0.0.0", "dev": "eth2", "metric": "0"}]
        (self.tmp / "routes.json").write_text(json.dumps(r))
        (self.tmp / "run/codex-lan-dev").write_text("eth2\n")
        self.guard()
        self.assertEqual(self.route_metric("224.0.0.0", "eth2"), ["0"])
        self.assertEqual(self.route_metric("224.0.0.0", "ath0"), [])

    def test_the_watchdog_keeps_trying_if_the_reconnect_fails(self):
        self.kill_worker()
        state = self.tmp / "run/codex-usb-eth-wifi-off"
        state.write_text("")
        (self.tmp / "wpa-fails").write_text("")
        self.guard()
        self.assertTrue(state.exists(), "the state went although the reconnect failed")
        (self.tmp / "wpa-fails").unlink()
        self.guard()
        self.assertFalse(state.exists())

    def test_a_cable_on_another_network_never_becomes_the_gateway(self):
        # The adapter's own DHCP adds a default route for its network: it goes
        # (blocker on), and its router is never saved as the hub's gateway.
        self.plug_adapter()
        r = self.routes()
        r += [{"net": "10.9.0.0", "mask": "255.255.255.0", "gw": "0.0.0.0", "dev": "eth2", "metric": "0"},
              {"net": "0.0.0.0", "mask": "0.0.0.0", "gw": "10.9.0.1", "dev": "eth2", "metric": "0"}]
        (self.tmp / "routes.json").write_text(json.dumps(r))
        self.guard()
        self.assertEqual((self.tmp / "run/gateway").read_text().strip(), "192.168.1.1")
        self.assertEqual(self.route_metric("0.0.0.0", "eth2"), [], "the adapter's default route stayed")
        self.assertEqual({d for _, _, d in self.private()}, {"ath0"})
        # Wi-Fi's own default route is still learned.
        r = self.routes() + [{"net": "0.0.0.0", "mask": "0.0.0.0", "gw": "192.168.1.254", "dev": "ath0", "metric": "0"}]
        (self.tmp / "routes.json").write_text(json.dumps(r))
        self.guard()
        self.assertEqual((self.tmp / "run/gateway").read_text().strip(), "192.168.1.254")

    def test_a_hub_on_the_cable_alone_learns_its_gateway_from_it(self):
        (self.tmp / "wifi-ip").write_text("")
        (self.tmp / "run/gateway").unlink()
        self.plug_adapter()
        r = self.routes() + [{"net": "0.0.0.0", "mask": "0.0.0.0", "gw": "192.168.1.1", "dev": "eth2", "metric": "0"}]
        (self.tmp / "routes.json").write_text(json.dumps(r))
        self.guard()
        self.assertEqual((self.tmp / "run/gateway").read_text().strip(), "192.168.1.1")

    def test_the_installers_replace_a_guard_from_before_the_watchdog(self):
        # The old guard traps TERM to remove its pid file and keeps looping.
        sys.path.insert(0, str(REPO))
        import importlib.util
        spec = importlib.util.spec_from_file_location("install_webui_snippets", REPO / "install_webui.py")
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        pidf = self.tmp / "run/old-guard.pid"
        old = self.tmp / "old_guard.sh"
        old.write_text(f'#!/bin/sh\necho $$ > {pidf}\ntrap \'rm -f "{pidf}"\' 0 1 2 15\nwhile :; do sleep 1; done\n')
        g = subprocess.Popen(SHELL + [str(old)], env=self.env)
        self.addCleanup(lambda: g.poll() is None and g.kill())
        self.assertTrue(self.wait_for(pidf))
        snippet = mod.GUARD_REPLACE.replace("/var/run/codex-offline-egress.pid", str(pidf))
        subprocess.run(SHELL + ["-c", snippet], env=self.env, timeout=30)
        import time
        time.sleep(0.3)
        self.assertIsNotNone(g.poll(), "the old guard survived the installer's replacement")
        self.assertFalse(pidf.exists())

    def test_a_running_guard_puts_back_its_pid_file(self):
        caps = self.tmp / "run/guard.caps"
        pidf = self.tmp / "run/guard.pid"
        e = dict(self.env, GUARD_PATH=self.env["USBETH_PATH"], GUARD_BLOCKER=self.env["USBETH_BLOCKER"],
                 GUARD_GATEWAY_STATE=str(self.tmp / "run/gateway"), GUARD_PID_FILE=str(pidf),
                 GUARD_LAN_DEV_FILE=str(self.tmp / "run/codex-lan-dev"), GUARD_SYS=self.env["USBETH_SYS"],
                 GUARD_LOG=str(self.tmp / "guard.log"), GUARD_CAPS_FILE=str(caps))
        g = subprocess.Popen(SHELL + [str(GUARD), "monitor"], env=e, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.addCleanup(lambda: g.poll() is None and g.kill())
        self.assertTrue(self.wait_for(pidf))
        pidf.unlink()
        self.assertTrue(self.wait_for(pidf, 6), "the guard didn't put its pid file back")
        self.assertEqual(pidf.read_text().strip(), str(g.pid))
        g.terminate()
        g.wait(timeout=10)

    def test_the_installers_keep_a_new_guards_pid_file(self):
        # init.sh's loop may start the new guard while the installer waits for
        # the old one to go: its pid file must survive the installer's cleanup.
        import importlib.util
        spec = importlib.util.spec_from_file_location("install_webui_snippets2", REPO / "install_webui.py")
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        pidf = self.tmp / "run/guard2.pid"
        old = subprocess.Popen(["sleep", "30"])
        new = subprocess.Popen(["sleep", "30"])
        self.addCleanup(lambda: [p.kill() for p in (old, new)])
        pidf.write_text(f"{old.pid}\n")
        # The new guard writes its pid while the snippet sleeps after killing the old one.
        snippet = mod.GUARD_REPLACE.replace("/var/run/codex-offline-egress.pid", str(pidf))
        snippet = snippet.replace("sleep 1;", f"sleep 1; echo {new.pid} > {pidf};", 1)
        subprocess.run(SHELL + ["-c", snippet], env=self.env, timeout=30)
        self.assertTrue(pidf.exists(), "the installer removed the new guard's pid file")
        self.assertEqual(pidf.read_text().strip(), str(new.pid))

    def fake_service(self, rc=0):
        """A usb_eth_service.sh that logs `recover` and, if rc is 0, clears codex-lan-dev."""
        svc = self.tmp / "usb_eth_service.sh"
        svc.write_text(f"""#!/bin/sh
echo "service $*" >> "{self.tmp / 'calls.log'}"
[ {rc} = 0 ] || exit {rc}
rm -f "{self.tmp / 'run/codex-lan-dev'}" "{self.tmp / 'run/codex-usb-eth-wifi-off'}"
echo recovered
""")
        svc.chmod(0o755)
        return svc

    def cable_carrying_lan(self):
        self.plug_adapter()
        r = self.routes()
        r.append({"net": "192.168.1.0", "mask": "255.255.255.0", "gw": "0.0.0.0", "dev": "eth2", "metric": "0"})
        (self.tmp / "routes.json").write_text(json.dumps(r))
        (self.tmp / "run/codex-lan-dev").write_text("eth2\n")

    def test_a_dead_workers_lan_device_is_ignored_and_handed_back(self):
        # The adapter keeps its link and address, but nothing watches it any more.
        self.cable_carrying_lan()
        self.guard(GUARD_USBETH_SERVICE=str(self.fake_service(rc=1)))
        self.assertEqual(self.route_metric("224.0.0.0", "eth2"), ["0"], "a live worker's cable wasn't used")
        self.assertNotIn("service", (self.tmp / "calls.log").read_text())
        self.kill_worker()
        self.guard(GUARD_USBETH_SERVICE=str(self.fake_service(rc=1)))
        # recover couldn't finish (lock busy): the guard still keeps off the cable, and asks again next time.
        self.assertEqual(self.route_metric("224.0.0.0", "ath0"), ["0"])
        self.assertEqual(self.route_metric("224.0.0.0", "eth2"), [])
        self.assertEqual({d for _, _, d in self.private()}, {"ath0"})
        self.assertTrue((self.tmp / "run/codex-lan-dev").exists())
        self.guard(GUARD_USBETH_SERVICE=str(self.fake_service()))
        self.assertEqual((self.tmp / "calls.log").read_text().count("service recover"), 2)
        self.assertFalse((self.tmp / "run/codex-lan-dev").exists())
        self.assertIn("restored local traffic on Wi-Fi", (self.tmp / "guard.log").read_text())

    def test_wifi_comes_back_even_if_recover_cant_run(self):
        self.cable_carrying_lan()
        state = self.tmp / "run/codex-usb-eth-wifi-off"
        state.write_text("")
        self.kill_worker()
        self.guard(GUARD_USBETH_SERVICE=str(self.fake_service(rc=1)))
        self.assertFalse(state.exists())
        self.assertIn("wpa_cli -i ath0 reconnect", (self.tmp / "calls.log").read_text())

    def test_a_bogus_lan_device_falls_back_to_wifi(self):
        for bogus in ("eth9", "br0; reboot", "../ath0"):
            (self.tmp / "run/codex-lan-dev").write_text(bogus + "\n")
            self.guard()
            self.assertEqual(self.route_metric("224.0.0.0", "ath0"), ["0"], bogus)


class GuardAndService(unittest.TestCase):
    """The egress guard and the real usb_eth_service.sh together, in
    test_service.py's sandbox: the worker dies while the cable carries local
    traffic, Wi-Fi is off and the adapter keeps its link and address."""

    def setUp(self):
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        import test_service
        self.ts = test_service
        self.sb = test_service.Sandbox({"bound": True, "wifi_ip": "192.168.0.50"})
        self.addCleanup(shutil.rmtree, self.sb.dir, True)
        (self.sb.dir / "sys/class/net/eth2").mkdir(parents=True)
        (self.sb.dir / "sys/class/net/ath0").mkdir(parents=True)
        p = f"{self.sb.bin}:{self.sb.hubbin}"
        self.path = {"USBETH_PATH": p, "PATH": p}
        self.procs = []

    def tearDown(self):
        self.sb.run("stop", **self.path)
        for proc in self.procs:
            if proc.poll() is None:
                proc.kill()
            proc.wait()

    def wait(self, cond, timeout=20.0):
        import time
        end = time.time() + timeout
        while time.time() < end:
            if cond():
                return True
            time.sleep(0.05)
        return False

    def test_the_guard_hands_everything_back_when_the_worker_dies(self):
        sb, run = self.sb, self.sb.run_dir
        (sb.dir / "usb_eth.conf").write_text("ENABLED=1\nWIFI_OFF=1\n")
        env = sb.env(**self.path)
        env.update(GUARD_PATH=self.path["PATH"], GUARD_BLOCKER=str(sb.dir / "cloud_blocker.conf"),
                   GUARD_GATEWAY_STATE=str(sb.dir / "gateway"), GUARD_PID_FILE=str(sb.dir / "guard.pid"),
                   GUARD_CAPS_FILE=str(sb.dir / "guard.caps"), GUARD_LAN_DEV_FILE=str(run / "codex-lan-dev"),
                   GUARD_SYS=str(sb.dir / "sys"), GUARD_LOG=str(sb.dir / "guard.log"),
                   GUARD_USBETH_WIFI_OFF=str(run / "codex-usb-eth-wifi-off"),
                   GUARD_USBETH_PID=str(run / "codex-usb-eth-worker.pid"), GUARD_USBETH_SERVICE=str(self.ts.SERVICE))
        guard = subprocess.Popen(SHELL + [str(GUARD), "monitor"], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.procs.append(guard)
        self.assertTrue(self.wait(lambda: (sb.dir / "guard.caps").exists()))
        worker = subprocess.Popen(["sh", str(self.ts.SERVICE), "worker"], env=sb.env(**self.path),
                                  stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.procs.append(worker)
        lan = run / "codex-lan-dev"
        wifi_off = run / "codex-usb-eth-wifi-off"
        multicast = lambda dev: any(r["net"] == "224.0.0.0" and r["dev"] == dev for r in sb.read_fake().get("extra_routes", []))
        self.assertTrue(self.wait(lambda: lan.exists() and lan.read_text().strip() == "eth2"))
        self.assertTrue(self.wait(lambda: multicast("eth2")), "the guard didn't follow the cable")
        (sb.dir / "uptime").write_text("1061.00 0.00\n")
        self.assertTrue(self.wait(lambda: wifi_off.exists() and "Wi-Fi off: the cable works" in sb.log.read_text()))
        # The worker dies; the adapter keeps carrier and its address.
        worker.kill()
        worker.wait()
        self.assertTrue(self.wait(lambda: not lan.exists()), "codex-lan-dev still names the cable")
        self.assertTrue(self.wait(lambda: not wifi_off.exists()), "Wi-Fi stayed off")
        self.assertTrue(self.wait(lambda: multicast("ath0") and not multicast("eth2")), "multicast stayed on the cable")
        calls = sb.calls()
        self.assertIn("wpa_cli -i ath0 reconnect", calls)
        self.assertIn("net-remove eth2 ath0", calls)
        self.assertEqual((sb.dir / "ipv4conf" / "eth2" / "arp_ignore").read_text().strip(), "0")
        self.assertEqual((sb.state().get("state"), sb.state().get("reason")), ("failed", "worker_stopped"))
        self.assertIn("restored local traffic on Wi-Fi", (sb.dir / "guard.log").read_text())
        privates = lambda: [r for r in sb.read_fake().get("extra_routes", [])
                            if r["net"] in ("10.0.0.0", "172.16.0.0", "192.168.0.0") and r["mask"] != "255.255.255.0"]
        self.assertTrue(self.wait(lambda: len(privates()) == 3 and {r["dev"] for r in privates()} == {"ath0"}), privates())


if __name__ == "__main__":
    unittest.main(verbosity=1)
