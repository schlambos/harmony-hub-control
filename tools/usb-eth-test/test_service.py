#!/usr/bin/env python3
"""Direct tests for payload/scripts/usb_eth_service.sh.

The real service script runs against a sandbox: a scripted fake
codex_usbeth (its status fields are the fixture, not the subject), stub
insmod/rmmod/ifconfig/udhcpc on PATH, a fake /proc/modules file, and
fake ARP-sysctl files. The subjects under test are the service's own
decisions: bounded readiness waits, never re-registering a registered
controller, exactly one worker/DHCP client, stop cancelling pending
startup, and owned route/ARP setup + cleanup.

Run via tools/usb-eth-test/run_tests.sh (or directly with python3).
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
SERVICE = REPO / "payload" / "scripts" / "usb_eth_service.sh"

FAKE_HELPER = r'''#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
D = Path(os.environ["FAKE_DIR"])
def load():
    return json.loads((D / "fake.json").read_text())
def save(s):
    (D / "fake.json").write_text(json.dumps(s))
def log(msg):
    with open(D / "calls.log", "a") as f:
        f.write(msg + "\n")

cmd = sys.argv[1] if len(sys.argv) > 1 else ""
s = load()
if cmd == "status":
    mods = s["modules"]
    print("kernel=2.6.31-g89d565c")
    print("kernel_compatible=1")
    print("enabled=1")
    print("gadget_loaded=0")
    print(f"ehci_bound={1 if s['bound'] else 0}")
    print(f"platform_registered={1 if s['registered'] else 0}")
    print(f"usbcore_loaded={1 if 'usbcore' in mods else 0}")
    print(f"ehci_loaded={1 if 'ehci_hcd' in mods else 0}")
    print(f"state=fake")
    print("driver_loaded=1")
    print(f"usb_device={s['device']}")
    print(f"usb_driver={s['driver']}")
    print(f"usb_product={s['product']}")
    print(f"ifname={s['iface'] if s['driver_loaded'] else ''}")
    print(f"carrier={s['carrier']}")
    print(f"ipv4={s['ipv4'] if s['carrier'] else ''}")
elif cmd == "phy-host":
    s["phy_calls"] = s.get("phy_calls", 0) + 1
    save(s)
    ready_after = s.get("phy_ready_after", 0)
    if s["phy_calls"] <= ready_after:
        print("usbctrlr1 before=0xdeadbeef phy_host=failed reason=sentinel_read")
        sys.exit(1)
    print("usbctrlr1 before=0x84000085 after=0x84000085 phy_host=ok")
elif cmd == "register-ehci":
    if len(sys.argv) > 2 and sys.argv[2] == "--check":
        sys.exit(1 if s.get("check_fail") else 0)
    log("register-ehci")
    if s["registered"]:
        print("platform_registered=1 ehci_bound=0 register_ehci=skipped_registered_unbound")
        sys.exit(3)
    s["registrations"] = s.get("registrations", 0) + 1
    s["registered"] = True
    if "ehci_hcd" in s["modules"] and s.get("probe_ok", True):
        s["bound"] = True
    save(s)
    print(f"register_ehci call_rc=0 platform_registered=1 ehci_bound={1 if s['bound'] else 0}")
    sys.exit(0 if s["bound"] else 1)
elif cmd == "eth-fix":
    log(f"eth-fix {sys.argv[2]}")
    print("tx_csum_off=1 rx_csum_off=1")
elif cmd == "net-apply":
    log(f"net-apply {sys.argv[2]} {sys.argv[3]}")
    if s.get("net_apply_fail"):
        print("route_mode=none reason=policy_apply_failed rc=-1,-1")
        sys.exit(1)
    print("policy_supported=0")
    print("route_mode=metric wifi_metric_old=0")
elif cmd == "net-remove":
    log(f"net-remove {sys.argv[2]} {sys.argv[3]}")
    print("net_removed=1")
else:
    sys.exit(2)
'''

STUB_MOD = r'''#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
D = Path(os.environ["FAKE_DIR"])
s = json.loads((D / "fake.json").read_text())
def save():
    (D / "fake.json").write_text(json.dumps(s))
    (D / "proc_modules").write_text("".join(f"{m} 1000 0 - Live 0x0\n" for m in s["modules"]))
    with open(D / "calls.log", "a") as f:
        f.write(" ".join(sys.argv) + "\n")
prog = Path(sys.argv[0]).name
if prog == "insmod":
    name = Path(sys.argv[1]).stem.replace("-", "_")
    if name not in s["modules"]:
        s["modules"].append(name)
    # Loading ehci_hcd binds a registered device whose probe can pass.
    if name == "ehci_hcd" and s["registered"] and s.get("probe_ok", True):
        s["bound"] = True
    save()
elif prog == "rmmod":
    name = sys.argv[1]
    if name in s["modules"]:
        s["modules"].remove(name)
    if name == "ehci_hcd":
        s["bound"] = False
        # A probe that can pass only after the reload (no race with the test).
        if s.get("probe_ok_after_rmmod"):
            s["probe_ok"] = True
    save()
'''

# ifconfig: logs changes; a query prints the fixture's address (the wired
# interface's while it has carrier, Wi-Fi's from wifi_ip), and setting or
# clearing the wired address updates the fixture (static mode).
STUB_IFCONFIG = r'''#!PYTHON
import json, os, sys
from pathlib import Path
D = Path(os.environ["FAKE_DIR"])
s = json.loads((D / "fake.json").read_text())
a = sys.argv[1:]
if len(a) == 1:
    ip = mask = ""
    if a[0] == s.get("iface", "eth2") and s.get("carrier") and s.get("ipv4"):
        ip, mask = s["ipv4"], s.get("netmask", "255.255.255.0")
    elif a[0] == "ath0" and s.get("wifi_ip"):
        ip, mask = s["wifi_ip"], "255.255.255.0"
    print(f"{a[0]}      Link encap:Ethernet  HWaddr 00:14:D1:AA:BB:CC")
    if ip:
        print(f"          inet addr:{ip}  Bcast:0.0.0.0  Mask:{mask}")
    print("          UP BROADCAST RUNNING MULTICAST  MTU:1500  Metric:1")
    sys.exit(0)
with open(D / "calls.log", "a") as f:
    f.write("ifconfig " + " ".join(a) + "\n")
if a and a[0] == s.get("iface", "eth2") and len(a) > 1:
    if a[1] == "0.0.0.0":
        s["ipv4"] = ""
    elif a[1][0].isdigit():
        s["ipv4"] = a[1]
        if "netmask" in a:
            s["netmask"] = a[a.index("netmask") + 1]
    (D / "fake.json").write_text(json.dumps(s))
'''

# route: the fixture's connected routes, plus default and host routes that
# add/del keep in the fixture; changes are logged.
STUB_ROUTE = r'''#!PYTHON
import json, os, sys
from pathlib import Path
D = Path(os.environ["FAKE_DIR"])
s = json.loads((D / "fake.json").read_text())
a = sys.argv[1:]
extra = s.setdefault("extra_routes", [])
if a[:1] == ["-n"] or not a:
    print("Kernel IP routing table")
    print("Destination     Gateway         Genmask         Flags Metric Ref    Use Iface")
    print("192.168.0.0     0.0.0.0         255.255.255.0   U     0      0        0 ath0")
    if s.get("wired_route", True) and s.get("carrier"):
        print("192.168.0.0     0.0.0.0         255.255.255.0   U     0      0        0 eth2")
    for r in extra:
        flags = "UGH" if r["gw"] != "0.0.0.0" and r["mask"] == "255.255.255.255" else ("UG" if r["gw"] != "0.0.0.0" else ("UH" if r["mask"] == "255.255.255.255" else "U"))
        print(f'{r["net"]:<15} {r["gw"]:<15} {r["mask"]:<15} {flags:<5} {r["metric"]:<6} 0        0 {r["dev"]}')
    sys.exit(0)
with open(D / "calls.log", "a") as f:
    f.write("route " + " ".join(a) + "\n")
def opt(k, d=None):
    return a[a.index(k) + 1] if k in a else d
if "default" in a:
    r = {"net": "0.0.0.0", "mask": "0.0.0.0", "gw": opt("gw", "0.0.0.0"), "dev": opt("dev", "?"), "metric": opt("metric", "0")}
else:
    r = {"net": opt("-host") or opt("-net"), "mask": opt("netmask", "255.255.255.255"), "gw": opt("gw", "0.0.0.0"), "dev": opt("dev", "?"), "metric": opt("metric", "0")}
same = lambda x: x["net"] == r["net"] and x["mask"] == r["mask"] and x["dev"] == r["dev"] and ("metric" not in a or x["metric"] == r["metric"])
if a[0] == "add":
    if any(same(x) for x in extra):
        sys.exit(1)
    extra.append(r)
elif a[0] == "del":
    hit = [x for x in extra if same(x)]
    if not hit:
        sys.exit(1)
    extra.remove(hit[0])
(D / "fake.json").write_text(json.dumps(s))
'''

# ping: answers unless ping_fail is set, or ping_dead_dev names the
# interface the packet would take (a host route to the target, else the
# interface carrying local traffic): an adapter that sends but can't receive.
STUB_PING = r'''#!PYTHON
import json, os, sys
from pathlib import Path
D = Path(os.environ["FAKE_DIR"])
s = json.loads((D / "fake.json").read_text())
target = sys.argv[-1]
with open(D / "calls.log", "a") as f:
    f.write("ping " + target + "\n")
if s.get("ping_fail"):
    sys.exit(1)
if s.get("ping_fail_first", 0) > 0:
    # Fail exactly this many pings, then answer (no race with the test).
    s["ping_fail_first"] -= 1
    (D / "fake.json").write_text(json.dumps(s))
    sys.exit(1)
dead = s.get("ping_dead_dev", "")
if dead:
    host = [r for r in s.get("extra_routes", []) if r["net"] == target and r["mask"] == "255.255.255.255"]
    lan = Path(os.environ["FAKE_RUN_DIR"], "codex-lan-dev")
    dev = host[0]["dev"] if host else (lan.read_text().strip() if lan.exists() else "ath0")
    if dev == dead:
        sys.exit(1)
'''

# wpa_cli: logs; FAIL while wpa_fail is set (exit 0, like the hub).
STUB_WPA = r'''#!PYTHON
import json, os, sys
from pathlib import Path
D = Path(os.environ["FAKE_DIR"])
s = json.loads((D / "fake.json").read_text())
a = sys.argv[1:]
if a[-1:] == ["status"]:
    print("wpa_state=COMPLETED")
    print("ssid=Home")
    sys.exit(0)
with open(D / "calls.log", "a") as f:
    f.write("wpa_cli " + " ".join(a) + "\n")
print("FAIL" if s.get("wpa_fail") else "OK")
'''

# codex_hal_ltcp: logs each command; refuses while hal_fail is set.
STUB_HAL = r'''#!PYTHON
import json, os, sys
from pathlib import Path
D = Path(os.environ["FAKE_DIR"])
s = json.loads((D / "fake.json").read_text())
with open(D / "calls.log", "a") as f:
    f.write("hal " + " ".join(sys.argv[1:3]) + "\n")
print('{"id":1,"code":500}' if s.get("hal_fail") else '{"id":1,"code":200}')
'''

# The commands a 4.15.600 hub has (BusyBox 1.13.4 and the rest of its
# /bin, /sbin, /usr/bin, /usr/sbin), less those that would touch this
# computer and those stubbed here. CableTests run the service with only
# these and the stubs on PATH, so a command the hub lacks fails here too.
HUB_COMMANDS = ("[", "[[", "awk", "cat", "chmod", "cp", "cut", "date", "dirname", "dmesg",
                "echo", "expr", "grep", "hostname", "id", "kill", "ln", "ls", "md5sum",
                "mkdir", "mv", "nice", "pidof", "ps", "renice", "rm", "sed", "sh", "test",
                "time", "touch", "tr", "which")

STUB_PLAIN = {
    "killall": '#!/bin/sh\nexit 0\n',
    "sleep": '#!/bin/sh\nexec /bin/sleep 0.02\n',
    "udhcpc": r'''#!/usr/bin/env python3
import json, os, subprocess, sys
from pathlib import Path
D = Path(os.environ["FAKE_DIR"])
with open(D / "calls.log", "a") as f:
    f.write("udhcpc " + " ".join(sys.argv[1:]) + "\n")
pidfile = sys.argv[sys.argv.index("-p") + 1]
s = json.loads((D / "fake.json").read_text())
s["wired_route"] = True  # configuring the address recreates its route
(D / "fake.json").write_text(json.dumps(s))
if s.get("udhcpc_slow_release"):
    # Like udhcpc -R: on TERM, release the lease and run deconfig (clear the
    # address) a moment later, then exit.
    code = ("import signal, subprocess, sys, time\n"
            "def bye(*a):\n"
            "    time.sleep(0.3)\n"
            "    subprocess.run([sys.argv[1], sys.argv[2], '0.0.0.0'])\n"
            "    sys.exit(0)\n"
            "signal.signal(signal.SIGTERM, bye)\n"
            "time.sleep(60)\n")
    child = subprocess.Popen([sys.executable, "-c", code, str(Path(sys.argv[0]).parent / "ifconfig"), s.get("iface", "eth2")])
else:
    child = subprocess.Popen(["/bin/sleep", "60"])
Path(pidfile).write_text(str(child.pid) + "\n")
''',
    "route": r'''#!/usr/bin/env python3
import json, os
from pathlib import Path
D = Path(os.environ["FAKE_DIR"])
s = json.loads((D / "fake.json").read_text())
print("Kernel IP routing table")
print("Destination Gateway Genmask Flags Metric Ref Use Iface")
print("192.168.0.0 0.0.0.0 255.255.255.0 U 0 0 0 ath0")
if s.get("wired_route", True) and s.get("carrier"):
    print("192.168.0.0 0.0.0.0 255.255.255.0 U 0 0 0 eth2")
''',
}


class Sandbox:
    def __init__(self, fake):
        self.dir = Path(tempfile.mkdtemp(prefix="usbeth-svc-"))
        self.fake_dir = self.dir / "fake"
        self.fake_dir.mkdir()
        self.run_dir = self.dir / "run"
        self.run_dir.mkdir()
        self.bin = self.dir / "bin"
        self.bin.mkdir()
        self.mods = self.dir / "modules"
        self.mods.mkdir()
        for name in ("r8152.ko", "usbnet.ko", "asix.ko", "cdc_ether.ko",
                     "cdc_ncm.ko", "ax88179_178a.ko", "usbcore.ko", "ehci-hcd.ko"):
            (self.mods / name).write_text("fake module\n")
        base = {
            "registered": True, "bound": False, "modules": ["usbcore", "ehci_hcd"],
            "device": "0bda:8153", "driver": "r8152", "product": "USB 10/100/1000 LAN",
            "iface": "eth2", "driver_loaded": True, "carrier": 1,
            "ipv4": "192.168.0.234", "phy_ready_after": 0, "probe_ok": True,
            "registrations": 0, "phy_calls": 0, "wired_route": True,
        }
        base.update(fake)
        self.write_fake(base)
        (self.fake_dir / "calls.log").write_text("")
        helper = self.bin / "codex_usbeth"
        helper.write_text(FAKE_HELPER)
        helper.chmod(0o755)
        for prog in ("insmod", "rmmod"):
            stub = self.bin / prog
            stub.write_text(STUB_MOD)
            stub.chmod(0o755)
        for name, body in STUB_PLAIN.items():
            stub = self.bin / name
            stub.write_text(body)
            stub.chmod(0o755)
        for name, body in (("ifconfig", STUB_IFCONFIG), ("route", STUB_ROUTE), ("ping", STUB_PING),
                           ("wpa_cli", STUB_WPA), ("codex_hal_ltcp", STUB_HAL)):
            stub = self.bin / name
            stub.write_text(body.replace("#!PYTHON", "#!" + sys.executable, 1))
            stub.chmod(0o755)
        # The stubs' own interpreter, for the hub-commands-only PATH.
        os.symlink(sys.executable, self.bin / "python3")
        self.hubbin = self.dir / "hubbin"
        self.hubbin.mkdir()
        for name in HUB_COMMANDS:
            real = shutil.which(name, path="/usr/bin:/bin:/usr/sbin:/sbin")
            if real:
                os.symlink(real, self.hubbin / name)
        (self.dir / "uptime").write_text("1000.00 0.00\n")
        (self.dir / "cloud_blocker.conf").write_text("1\n")
        (self.dir / "gateway").write_text("192.168.0.1\n")
        (self.dir / "resolv.conf").write_text("nameserver 192.168.0.1\n")
        for iface in ("eth2", "ath0"):
            st = self.dir / "sysnet" / iface / "statistics"
            st.mkdir(parents=True)
            for k in ("rx_bytes", "tx_bytes", "rx_errors", "tx_errors"):
                (st / k).write_text("0\n")
        conf_dir = self.dir / "ipv4conf"
        for iface in ("eth2", "ath0"):
            (conf_dir / iface).mkdir(parents=True)
            (conf_dir / iface / "arp_ignore").write_text("0\n")
            (conf_dir / iface / "arp_announce").write_text("0\n")
        (self.dir / "usb_eth.conf").write_text("ENABLED=1\n")
        (self.dir / "platform-driver").mkdir()
        self.log = self.dir / "service.log"
        self.log.write_text("")

    def write_fake(self, state):
        (self.fake_dir / "fake.json").write_text(json.dumps(state))
        (self.fake_dir / "proc_modules").write_text(
            "".join(f"{m} 1000 0 - Live 0x0\n" for m in state["modules"]))

    def read_fake(self):
        return json.loads((self.fake_dir / "fake.json").read_text())

    def patch_fake(self, **kw):
        state = self.read_fake()
        state.update(kw)
        self.write_fake(state)

    def env(self, **over):
        env = dict(os.environ)
        env.update({
            "FAKE_DIR": str(self.fake_dir),
            "USBETH_PATH": f"{self.bin}:/usr/bin:/bin",
            "USBETH_CONF": str(self.dir / "usb_eth.conf"),
            "USBETH_HELPER": str(self.bin / "codex_usbeth"),
            "USBETH_MOD_DIR": str(self.mods),
            "USBETH_LOG": str(self.log),
            "USBETH_RUN_DIR": str(self.run_dir),
            "USBETH_PROC_MODULES": str(self.fake_dir / "proc_modules"),
            "USBETH_IPV4_CONF": str(self.dir / "ipv4conf"),
            "USBETH_PLATFORM_DRIVER_DIR": str(self.dir / "platform-driver"),
            "USBETH_USBCORE_KO": str(self.mods / "usbcore.ko"),
            "USBETH_EHCI_KO": str(self.mods / "ehci-hcd.ko"),
            "USBETH_POLL": "1",
            "USBETH_MONITOR_POLL": "1",
            "USBETH_DEP_TIMEOUT": "30",
            "USBETH_CTRL_WAIT": "8",
            "USBETH_ADAPTER_WAIT": "30",
            "USBETH_IFACE_WAIT": "8",
            "FAKE_RUN_DIR": str(self.run_dir),
            "USBETH_UPTIME": str(self.dir / "uptime"),
            "USBETH_BLOCKER": str(self.dir / "cloud_blocker.conf"),
            "USBETH_GATEWAY_STATE": str(self.dir / "gateway"),
            "USBETH_GUARD_PID": str(self.dir / "guard.pid"),
            "USBETH_GUARD_CAPS": str(self.dir / "guard.caps"),
            "USBETH_HAL_LTCP": str(self.bin / "codex_hal_ltcp"),
            "USBETH_RESOLV": str(self.dir / "resolv.conf"),
            "USBETH_SYS_NET": str(self.dir / "sysnet"),
        })
        env.update({k: str(v) for k, v in over.items()})
        return env

    def run(self, *args, **over):
        return subprocess.run(["sh", str(SERVICE), *args],
                              env=self.env(**over), capture_output=True,
                              text=True, timeout=30)

    def spawn_worker(self, **over):
        return subprocess.Popen(["sh", str(SERVICE), "worker"],
                                env=self.env(**over),
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    def state(self):
        out = {}
        f = self.run_dir / "codex-usb-eth.state"
        if f.exists():
            for line in f.read_text().splitlines():
                if "=" in line:
                    k, v = line.split("=", 1)
                    out[k] = v
        return out

    def net_state(self):
        f = self.run_dir / "codex-usb-eth-net.state"
        return f.read_text() if f.exists() else ""

    def calls(self):
        return (self.fake_dir / "calls.log").read_text()

    def wait_state(self, want, timeout=10.0, reason=None):
        deadline = time.time() + timeout
        while time.time() < deadline:
            st = self.state()
            if st.get("state") == want and (reason is None or st.get("reason") == reason):
                return st
            time.sleep(0.05)
        raise AssertionError(f"state never became {want}/{reason}; last={self.state()}")


class ServiceTests(unittest.TestCase):
    def test_late_phy_then_operational_and_clean_stop(self):
        sb = Sandbox({"phy_ready_after": 3})
        proc = sb.spawn_worker()
        try:
            sb.wait_state("operational")
            fake = sb.read_fake()
            self.assertEqual(fake["registrations"], 0)      # never re-registered
            self.assertGreaterEqual(fake["phy_calls"], 4)   # sentinel retries, no write
            self.assertEqual(sb.calls().count("udhcpc "), 1)
            self.assertIn("net-apply eth2 ath0", sb.calls())
            conf = sb.dir / "ipv4conf"
            self.assertEqual((conf / "eth2" / "arp_ignore").read_text().strip(), "1")
            self.assertEqual((conf / "ath0" / "arp_announce").read_text().strip(), "2")
        finally:
            rc = sb.run("stop")
        self.assertEqual(rc.returncode, 0)
        proc.wait(timeout=10)
        conf = sb.dir / "ipv4conf"
        self.assertEqual((conf / "eth2" / "arp_ignore").read_text().strip(), "0")
        self.assertEqual((conf / "ath0" / "arp_announce").read_text().strip(), "0")
        self.assertIn("net-remove eth2 ath0", sb.calls())
        self.assertEqual(sb.state().get("state"), "stopped")

    def test_phy_timeout_fails_without_touching_controller(self):
        sb = Sandbox({"phy_ready_after": 10 ** 9})
        rc = sb.run("worker", USBETH_DEP_TIMEOUT=4)
        self.assertEqual(rc.returncode, 1)
        st = sb.state()
        self.assertEqual(st.get("state"), "failed")
        self.assertEqual(st.get("reason"), "phy_not_ready")
        self.assertNotIn("register-ehci", sb.calls())
        self.assertEqual(sb.calls().count("insmod"), 0)  # ehci never attempted

    def test_platform_absent_registers_exactly_once(self):
        sb = Sandbox({"registered": False})
        proc = sb.spawn_worker()
        try:
            sb.wait_state("operational")
            self.assertEqual(sb.read_fake()["registrations"], 1)
            self.assertEqual(sb.calls().count("register-ehci"), 1)
        finally:
            sb.run("stop")
            proc.wait(timeout=10)

    def test_registered_unbound_recovers_with_one_reload(self):
        # ehci_hcd is already loaded but the device never bound, and the
        # (fake) first probe cannot pass until the reload after PHY fix.
        # The fake rmmod of ehci_hcd makes the next probe pass, so the
        # reload's insmod binds (flipping it from the test raced the worker).
        sb = Sandbox({"probe_ok": False, "probe_ok_after_rmmod": True})
        proc = sb.spawn_worker()
        try:
            sb.wait_state("operational")
            self.assertEqual(sb.read_fake()["registrations"], 0)
            self.assertEqual(sb.calls().count("rmmod ehci_hcd"), 1)
        finally:
            sb.run("stop")
            proc.wait(timeout=10)

    def test_registered_unbound_unrecoverable_stops_after_one_reload(self):
        sb = Sandbox({"probe_ok": False})
        rc = sb.run("worker", USBETH_CTRL_WAIT=3)
        self.assertEqual(rc.returncode, 1)
        self.assertEqual(sb.state().get("reason"), "controller_registered_unbound")
        self.assertEqual(sb.calls().count("rmmod ehci_hcd"), 1)
        self.assertEqual(sb.read_fake()["registrations"], 0)

    def test_concurrent_starts_spawn_one_worker_and_one_dhcp(self):
        sb = Sandbox({"phy_ready_after": 5})
        procs = [subprocess.Popen(["sh", str(SERVICE), "start"],
                                  env=sb.env(), stdout=subprocess.DEVNULL,
                                  stderr=subprocess.DEVNULL) for _ in range(3)]
        for p in procs:
            self.assertEqual(p.wait(timeout=15), 0)
        sb.wait_state("operational")
        self.assertEqual(sb.calls().count("udhcpc "), 1)
        rc = sb.run("start")  # repeated start is a no-op
        self.assertEqual(rc.returncode, 0)
        time.sleep(0.3)
        self.assertEqual(sb.calls().count("udhcpc "), 1)
        sb.run("stop")

    def test_stop_during_pending_startup_cancels_worker(self):
        sb = Sandbox({"phy_ready_after": 10 ** 9})
        rc = sb.run("start", USBETH_DEP_TIMEOUT=100000)
        self.assertEqual(rc.returncode, 0)  # returns at once, never blocks
        pidfile = sb.run_dir / "codex-usb-eth-worker.pid"
        self.assertTrue(pidfile.exists())
        worker_pid = int(pidfile.read_text().strip())
        rc = sb.run("stop")
        self.assertEqual(rc.returncode, 0)
        time.sleep(0.3)
        alive = subprocess.run(["kill", "-0", str(worker_pid)],
                               capture_output=True).returncode == 0
        self.assertFalse(alive)
        # Even when the PHY later becomes ready, nothing revives.
        sb.patch_fake(phy_ready_after=0)
        time.sleep(0.5)
        self.assertEqual(sb.calls().count("udhcpc "), 0)
        self.assertEqual(sb.read_fake()["registrations"], 0)
        self.assertEqual(sb.state().get("state"), "stopped")

    def test_adapter_absent_and_unsupported_are_distinct(self):
        sb = Sandbox({"device": ""})
        rc = sb.run("worker", USBETH_ADAPTER_WAIT=3)
        self.assertEqual(rc.returncode, 0)
        self.assertEqual(sb.state().get("state"), "adapter_absent")

        sb = Sandbox({"device": "0424:ec00", "driver": ""})
        rc = sb.run("worker", USBETH_ADAPTER_WAIT=3)
        self.assertEqual(rc.returncode, 0)
        self.assertEqual(sb.state().get("state"), "adapter_unsupported")

    def test_failed_route_apply_is_retried_not_cached(self):
        sb = Sandbox({"net_apply_fail": True})
        proc = sb.spawn_worker()
        try:
            sb.wait_state("degraded_routing", reason="route_apply_failed")
            sb.patch_fake(net_apply_fail=False)
            sb.wait_state("operational")
            self.assertIn("net_applied=1", sb.net_state())
            self.assertGreaterEqual(sb.calls().count("net-apply "), 2)
        finally:
            sb.run("stop")
            proc.wait(timeout=10)

    def test_link_return_without_route_reruns_dhcp_bounded(self):
        sb = Sandbox({})
        proc = sb.spawn_worker()
        try:
            sb.wait_state("operational")
            sb.patch_fake(carrier=0, wired_route=False)
            sb.wait_state("awaiting_carrier_dhcp", reason="no_carrier")
            before = sb.calls().count("udhcpc ")
            sb.patch_fake(carrier=1)  # link back, route still missing
            sb.wait_state("operational")
            after = sb.calls().count("udhcpc ")
            self.assertEqual(after, before + 1)  # one re-run, not a loop
            time.sleep(0.5)
            self.assertEqual(sb.calls().count("udhcpc "), after)
        finally:
            sb.run("stop")
            proc.wait(timeout=10)

    def test_carrier_drop_restores_wifi_and_recovers(self):
        sb = Sandbox({})
        proc = sb.spawn_worker()
        try:
            sb.wait_state("operational")
            sb.patch_fake(carrier=0)
            sb.wait_state("awaiting_carrier_dhcp", reason="no_carrier")
            conf = sb.dir / "ipv4conf"
            self.assertEqual((conf / "eth2" / "arp_ignore").read_text().strip(), "0")
            self.assertEqual(sb.net_state(), "")
            sb.patch_fake(carrier=1)
            sb.wait_state("operational")
            self.assertIn("net-apply eth2 ath0", sb.calls())
        finally:
            sb.run("stop")
            proc.wait(timeout=10)

    def test_melodious_off_skips_start_and_exits_running_worker(self):
        sb = Sandbox({})
        off_marker = sb.dir / "melodious-off"
        off_marker.write_text("off\n")
        for args in (["start"], ["start", "--force"]):
            rc = sb.run(*args, USBETH_OFF_MARKER=str(off_marker))
            self.assertEqual(rc.returncode, 0)
            self.assertFalse((sb.run_dir / "codex-usb-eth-worker.pid").exists())
            self.assertEqual(sb.calls(), "")

        off_marker.unlink()
        proc = sb.spawn_worker(USBETH_OFF_MARKER=str(off_marker), USBETH_MONITOR_POLL=1)
        try:
            sb.wait_state("operational")
            off_marker.write_text("off\n")
            self.assertEqual(proc.wait(timeout=5), 0)
            self.assertFalse((sb.run_dir / "codex-usb-eth-worker.pid").exists())
        finally:
            if proc.poll() is None:
                proc.kill()
            sb.run("stop")



class CableTests(unittest.TestCase):
    """Using the cable (docs/USB_ETHERNET.md): the gateway check before the
    cable takes local traffic and every 30 s after, Wi-Fi off, the front
    LED, static addresses. The hub's clock is the sandbox's uptime file; the
    service runs with only the hub's own commands (and the stubs) on PATH."""

    def setUp(self):
        self.sb = Sandbox(self.fixture())
        self.procs = []

    def fixture(self):
        return {"bound": True}

    def tearDown(self):
        self.sb.run("stop", **self.path())
        for p in self.procs:
            try:
                p.wait(timeout=10)
            except subprocess.TimeoutExpired:
                p.kill()
        for p in getattr(self, "guard", []):
            p.kill()

    def path(self):
        p = f"{self.sb.bin}:{self.sb.hubbin}"
        return {"USBETH_PATH": p, "PATH": p}

    def start(self, **over):
        env = dict(self.path(), **over)
        proc = subprocess.Popen(["sh", str(SERVICE), "worker"], env=self.sb.env(**env),
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.procs.append(proc)
        return proc

    def write_atomic(self, path, text):
        # Like codex_webui's writes: never a half-written file for the worker.
        tmp = path.with_name(path.name + ".tmp")
        tmp.write_text(text)
        os.replace(tmp, path)

    def clock(self, t):
        self.write_atomic(self.sb.dir / "uptime", f"{t}.00 0.00\n")

    def wait(self, cond, timeout=20.0):
        deadline = time.time() + timeout
        while time.time() < deadline:
            if cond():
                return True
            time.sleep(0.05)
        return False

    def lan_dev(self):
        p = self.sb.run_dir / "codex-lan-dev"
        return p.read_text().strip() if p.exists() else "ath0"

    def calls(self):
        return self.sb.calls().splitlines()

    def log(self):
        return self.sb.log.read_text()

    def conf(self, text):
        self.write_atomic(self.sb.dir / "usb_eth.conf", "ENABLED=1\n" + text)

    def guard_with_watchdog(self):
        g = subprocess.Popen(["/bin/sleep", "120"])
        self.guard = [g]
        (self.sb.dir / "guard.pid").write_text(f"{g.pid}\n")
        (self.sb.dir / "guard.caps").write_text("wifi-watchdog\n")

    def suspended(self):
        # The state file is written just before the disconnect (so a stop in
        # between still reconnects); Wi-Fi is off once that was logged.
        return (self.sb.run_dir / "codex-usb-eth-wifi-off").exists() and "Wi-Fi off: the cable works" in self.log()

    def led(self):
        return [c for c in self.calls() if c.startswith("hal ")]

    EXT = 'hal sys.led {"action":"extender_mode"}'
    NONEXT = 'hal sys.led {"action":"non_extender_mode"}'
    FIRE = 'hal sys.led {"action":"fire_command"}'

    # --- the gateway check ---

    def test_the_cable_takes_local_traffic_once_the_gateway_answers_through_it(self):
        self.start()
        self.sb.wait_state("operational")
        self.assertTrue(self.wait(lambda: self.lan_dev() == "eth2"))
        c = self.calls()
        i = c.index("ping 192.168.0.1")
        self.assertEqual(c[i - 1], "route add -host 192.168.0.1 dev eth2", c)
        self.assertEqual(c[i + 1], "route del -host 192.168.0.1 dev eth2", c)
        self.assertLess(i, c.index("net-apply eth2 ath0"), "routes moved before the check")
        self.assertIn("LAN traffic now through eth2", self.log())
        conf = self.sb.dir / "ipv4conf"
        self.assertEqual((conf / "eth2" / "arp_ignore").read_text().strip(), "1")

    def test_a_cable_that_cant_receive_never_takes_local_traffic(self):
        self.sb.patch_fake(ping_dead_dev="eth2")
        self.start()
        self.sb.wait_state("gateway_unreachable", reason="gateway_lost")
        self.assertEqual(self.lan_dev(), "ath0")
        self.assertNotIn("net-apply eth2 ath0", self.calls())
        self.assertEqual(self.calls().count("ping 192.168.0.1"), 2, "gave up after one miss, or kept trying")
        self.assertIn("the gateway doesn't answer through eth2", self.log())
        conf = self.sb.dir / "ipv4conf"
        self.assertEqual((conf / "eth2" / "arp_ignore").read_text().strip(), "0", "ARP left strict")
        self.assertFalse(any(r["mask"] == "255.255.255.255" for r in self.sb.read_fake().get("extra_routes", [])),
                         "the check's host route was left behind")
        self.assertIn("gateway_lost=1", self.sb.run("status", **self.path()).stdout)
        # Fixed: another try after the retry time, not before.
        self.sb.patch_fake(ping_dead_dev="")
        self.clock(1599)
        time.sleep(1.0)
        self.assertEqual(self.lan_dev(), "ath0", "tried again too soon")
        self.clock(1601)
        self.sb.wait_state("operational")
        self.assertTrue(self.wait(lambda: self.lan_dev() == "eth2"))

    def test_the_check_goes_through_the_cable_not_wifi(self):
        self.sb.patch_fake(ping_dead_dev="ath0")
        self.start()
        self.sb.wait_state("operational")
        self.assertTrue(self.wait(lambda: self.lan_dev() == "eth2"))

    def test_one_missed_check_is_tried_again(self):
        self.sb.patch_fake(ping_fail_first=1)
        self.start()
        self.sb.wait_state("operational")
        self.assertEqual(self.calls().count("ping 192.168.0.1"), 2)
        self.assertNotIn("doesn't answer", self.log())

    def test_a_cable_that_stops_answering_gives_local_traffic_back(self):
        self.start()
        self.assertTrue(self.wait(lambda: self.lan_dev() == "eth2"))
        self.sb.patch_fake(ping_dead_dev="eth2")
        self.clock(1031)  # first miss
        time.sleep(1.0)
        self.assertEqual(self.lan_dev(), "eth2", "one missed ping was enough")
        self.clock(1062)  # second miss
        self.sb.wait_state("gateway_unreachable")
        self.assertEqual(self.lan_dev(), "ath0")
        self.assertIn("net-remove eth2 ath0", self.calls())
        self.assertIn("the gateway stopped answering through the cable", self.log())

    def test_a_new_link_gets_a_fresh_try(self):
        self.sb.patch_fake(ping_dead_dev="eth2")
        self.start()
        self.sb.wait_state("gateway_unreachable")
        self.sb.patch_fake(ping_dead_dev="", carrier=0)
        self.sb.wait_state("awaiting_carrier_dhcp", reason="no_carrier")
        self.sb.patch_fake(carrier=1)
        self.sb.wait_state("operational")

    def test_another_network_is_only_an_extra_address(self):
        self.sb.patch_fake(ipv4="10.9.0.5")
        self.start()
        self.sb.wait_state("operational")
        time.sleep(0.5)
        self.assertEqual(self.lan_dev(), "ath0")
        self.assertNotIn("ping 192.168.0.1", self.calls())

    # --- Wi-Fi off while the cable works ---

    def test_wifi_goes_off_after_a_minute_of_working_cable_and_comes_back(self):
        self.conf("WIFI_OFF=1\n")
        self.guard_with_watchdog()
        self.start()
        self.assertTrue(self.wait(lambda: self.lan_dev() == "eth2"))
        time.sleep(0.5)
        self.assertFalse(self.suspended(), "Wi-Fi went off before the minute")
        self.clock(1061)
        self.assertTrue(self.wait(self.suspended))
        self.assertIn("wpa_cli -i ath0 disconnect", self.calls())
        st = self.sb.run("status", **self.path()).stdout
        self.assertIn("wifi_suspended=1", st)
        self.assertIn("lan_dev=eth2", st)
        self.sb.patch_fake(carrier=0)
        self.assertTrue(self.wait(lambda: not self.suspended()), "Wi-Fi stayed off without a link")
        self.assertIn("wpa_cli -i ath0 reconnect", self.calls())

    def test_no_wifi_off_without_the_guards_watchdog(self):
        self.conf("WIFI_OFF=1\n")
        self.start()
        self.assertTrue(self.wait(lambda: self.lan_dev() == "eth2"))
        self.clock(1100)
        time.sleep(1.0)
        self.assertFalse(self.suspended())
        self.assertIn("wifi_watchdog=0", self.sb.run("status", **self.path()).stdout)

    def test_switching_the_option_off_brings_wifi_back(self):
        self.conf("WIFI_OFF=1\n")
        self.guard_with_watchdog()
        self.start()
        self.assertTrue(self.wait(lambda: self.lan_dev() == "eth2"))
        self.clock(1061)
        self.assertTrue(self.wait(self.suspended))
        self.conf("WIFI_OFF=0\n")
        self.assertTrue(self.wait(lambda: not self.suspended()))

    def test_a_failed_reconnect_is_tried_again(self):
        self.conf("WIFI_OFF=1\n")
        self.guard_with_watchdog()
        self.start()
        self.assertTrue(self.wait(lambda: self.lan_dev() == "eth2"))
        self.clock(1061)
        self.assertTrue(self.wait(self.suspended))
        self.sb.patch_fake(wpa_fail=True)
        self.conf("WIFI_OFF=0\n")
        self.assertTrue(self.wait(lambda: "Wi-Fi reconnect failed" in self.log()))
        time.sleep(0.5)
        self.assertTrue(self.suspended(), "counted as back although the reconnect failed")
        self.assertEqual(self.log().count("Wi-Fi reconnect failed"), 1, "logged on every try")
        self.sb.patch_fake(wpa_fail=False)
        self.assertTrue(self.wait(lambda: not self.suspended()))

    def test_stop_brings_wifi_back(self):
        self.conf("WIFI_OFF=1\n")
        self.guard_with_watchdog()
        self.start()
        self.assertTrue(self.wait(lambda: self.lan_dev() == "eth2"))
        self.clock(1061)
        self.assertTrue(self.wait(self.suspended))
        self.assertEqual(self.sb.run("stop", **self.path()).returncode, 0)
        self.assertFalse(self.suspended())
        self.assertEqual(self.lan_dev(), "ath0")

    # --- the front LED ---

    def test_the_led_follows_the_cable(self):
        self.start()
        self.assertTrue(self.wait(lambda: self.led()[-2:] == [self.EXT, self.FIRE]), self.led())
        self.assertEqual(self.led().count(self.EXT), 1)
        self.sb.patch_fake(carrier=0)
        self.assertTrue(self.wait(lambda: self.led()[-2:] == [self.NONEXT, self.FIRE]), self.led())

    def test_the_led_is_set_again_after_wifi_goes_off(self):
        self.conf("WIFI_OFF=1\n")
        self.guard_with_watchdog()
        self.start()
        self.assertTrue(self.wait(lambda: self.led() == [self.EXT, self.FIRE]), self.led())
        self.clock(1061)
        self.assertTrue(self.wait(self.suspended))
        time.sleep(0.5)
        self.assertEqual(self.led().count(self.EXT), 1, "sent before hal handles the disconnect")
        self.clock(1064)
        self.assertTrue(self.wait(lambda: self.led()[2:] == [self.EXT, self.FIRE]), self.led())

    def test_a_refused_led_command_is_tried_again_and_repeated_later(self):
        self.sb.patch_fake(hal_fail=True)
        self.start()
        self.assertTrue(self.wait(lambda: self.EXT in self.led()))
        self.sb.patch_fake(hal_fail=False)
        time.sleep(0.5)
        self.assertNotIn(self.FIRE, self.led(), "tried again before 30 s")
        self.clock(1031)
        self.assertTrue(self.wait(lambda: self.led()[-2:] == [self.EXT, self.FIRE]), self.led())
        n = len(self.led())
        self.clock(1332)
        self.assertTrue(self.wait(lambda: self.led()[n:] == [self.EXT]), self.led())

    def test_stop_takes_the_led_out_of_extender_mode(self):
        self.start()
        self.assertTrue(self.wait(lambda: self.led() == [self.EXT, self.FIRE]))
        self.sb.run("stop", **self.path())
        self.assertEqual(self.led()[-2:], [self.NONEXT, self.FIRE])

    # --- static address ---

    def test_static_settings_are_applied_without_dhcp(self):
        self.sb.patch_fake(ipv4="")
        self.conf("IP_MODE=static\nIP_ADDRESS=192.168.0.50\nIP_NETMASK=255.255.255.0\nIP_GATEWAY=192.168.0.1\nIP_DNS=1.1.1.1\n")
        (self.sb.dir / "resolv.conf").write_text("")
        self.start()
        self.sb.wait_state("operational")
        self.assertIn("ifconfig eth2 192.168.0.50 netmask 255.255.255.0 up", self.calls())
        self.assertFalse(any(c.startswith("udhcpc") for c in self.calls()), "started DHCP in static mode")
        self.assertTrue(self.wait(lambda: self.lan_dev() == "eth2"))
        self.assertEqual((self.sb.dir / "resolv.conf").read_text(), "nameserver 1.1.1.1\n")
        st = self.sb.run("status", **self.path()).stdout
        self.assertIn("ip_mode=static", st)
        self.assertIn("router=192.168.0.1", st)

    def test_invalid_static_settings_leave_the_cable_without_an_address(self):
        self.sb.patch_fake(ipv4="")
        self.conf("IP_MODE=static\nIP_ADDRESS=192.168.0.50\nIP_NETMASK=255.0.255.0\n")
        self.start()
        self.sb.wait_state("failed", reason="static_invalid")
        self.assertFalse(any(c.startswith("udhcpc") for c in self.calls()))
        self.assertEqual(self.lan_dev(), "ath0")

    def test_switching_from_static_to_dhcp(self):
        self.sb.patch_fake(ipv4="")
        self.conf("IP_MODE=static\nIP_ADDRESS=192.168.0.50\nIP_NETMASK=255.255.255.0\n")
        self.start()
        self.sb.wait_state("operational")
        self.conf("IP_MODE=dhcp\n")
        self.assertTrue(self.wait(lambda: any(c.startswith("udhcpc") for c in self.calls())))
        c = self.calls()
        self.assertIn("ifconfig eth2 0.0.0.0", c[:[i for i, x in enumerate(c) if x.startswith("udhcpc")][0]])

    # --- the rest ---

    def test_restart_swaps_the_worker_and_leaves_the_wired_path_alone(self):
        self.conf("WIFI_OFF=1\n")
        self.guard_with_watchdog()
        self.sb.run("start", **self.path())
        self.assertTrue(self.wait(lambda: self.lan_dev() == "eth2"))
        self.clock(1061)
        self.assertTrue(self.wait(self.suspended))
        old = (self.sb.run_dir / "codex-usb-eth-worker.pid").read_text().strip()
        before = len(self.calls())
        self.assertEqual(self.sb.run("restart", **self.path()).returncode, 0)
        new = (self.sb.run_dir / "codex-usb-eth-worker.pid").read_text().strip()
        self.assertNotEqual(new, old)
        self.sb.wait_state("operational")
        time.sleep(1.0)
        after = self.calls()[before:]
        for c in after:
            self.assertFalse(c.startswith(("net-remove", "udhcpc", "wpa_cli -i ath0 reconnect", "ifconfig eth2 0.0.0.0")),
                             f"restart touched the wired path: {c}")
        self.assertTrue(self.suspended())
        self.assertEqual(self.lan_dev(), "eth2")

    def test_restart_keeps_a_live_worker_in_the_pid_file(self):
        # Throughout the swap the pid file must name a live process: with
        # none, the egress guard's watchdog would reconnect Wi-Fi.
        import threading
        self.sb.run("start", **self.path())
        self.sb.wait_state("operational")
        pidf = self.sb.run_dir / "codex-usb-eth-worker.pid"
        gaps, done = [], threading.Event()
        def watch():
            while not done.is_set():
                try:
                    os.kill(int(pidf.read_text().strip()), 0)
                except (OSError, ValueError):
                    gaps.append(time.time())
                time.sleep(0.002)
        t = threading.Thread(target=watch)
        t.start()
        try:
            self.assertEqual(self.sb.run("restart", **self.path()).returncode, 0)
            time.sleep(0.5)
        finally:
            done.set()
            t.join()
        self.assertEqual(gaps, [], f"the pid file named no live worker {len(gaps)} times during restart")
        time.sleep(0.5)
        pidf = self.sb.run_dir / "codex-usb-eth-worker.pid"
        self.assertTrue(pidf.exists(), "the old worker's exit removed the new pid file")
        os.kill(int(pidf.read_text().strip()), 0)  # names a live process

    def test_switched_off_and_straight_back_on_keeps_it_running(self):
        # codex_webui stops 2 s after an "off" (it answers first); "on" in
        # between must win, with a worker running.
        self.sb.run("start", **self.path())
        self.sb.wait_state("operational")
        (self.sb.dir / "usb_eth.conf").write_text("ENABLED=0\n")
        (self.sb.dir / "usb_eth.conf").write_text("ENABLED=1\n")
        self.sb.run("start", "--force", **self.path())
        self.assertEqual(self.sb.run("stop-if-disabled", **self.path()).returncode, 0)
        self.assertIn("stop skipped: switched back on", self.log())
        time.sleep(1.0)
        self.assertNotEqual(self.sb.state().get("state"), "stopped")
        pidf = self.sb.run_dir / "codex-usb-eth-worker.pid"
        self.assertTrue(pidf.exists())
        os.kill(int(pidf.read_text().strip()), 0)
        # Really off: it stops.
        (self.sb.dir / "usb_eth.conf").write_text("ENABLED=0\n")
        self.sb.run("stop-if-disabled", **self.path())
        self.assertEqual(self.sb.state().get("state"), "stopped")

    def test_a_cable_on_another_network_never_becomes_the_gateway(self):
        # Blocker off: the cable's own DHCP adds a default route for its
        # (other) network, listed first; Wi-Fi's must still decide.
        (self.sb.dir / "cloud_blocker.conf").write_text("0\n")
        self.sb.patch_fake(ipv4="10.9.0.5", wifi_ip="192.168.0.50", extra_routes=[
            {"net": "0.0.0.0", "mask": "0.0.0.0", "gw": "10.9.0.1", "dev": "eth2", "metric": "0"},
            {"net": "0.0.0.0", "mask": "0.0.0.0", "gw": "192.168.0.1", "dev": "ath0", "metric": "0"}])
        self.start()
        self.sb.wait_state("operational")
        time.sleep(1.0)
        self.assertEqual(self.lan_dev(), "ath0", "a cable on another network took local traffic")
        self.assertNotIn("ping 10.9.0.1", self.calls())

    def test_switching_to_static_waits_for_the_dhcp_clients_release(self):
        self.sb.patch_fake(udhcpc_slow_release=True)
        self.start()
        self.sb.wait_state("operational")
        self.conf("IP_MODE=static\nIP_ADDRESS=192.168.0.50\nIP_NETMASK=255.255.255.0\n")
        self.assertTrue(self.wait(lambda: "ifconfig eth2 192.168.0.50 netmask 255.255.255.0 up" in self.calls()))
        time.sleep(1.5)
        self.assertEqual(self.sb.read_fake()["ipv4"], "192.168.0.50", "the DHCP client's late release wiped the static address")
        self.assertEqual(self.calls().count("ifconfig eth2 192.168.0.50 netmask 255.255.255.0 up"), 1,
                         "the static address was wiped and set again")
        c = self.calls()
        self.assertLess(c.index("ifconfig eth2 0.0.0.0"), c.index("ifconfig eth2 192.168.0.50 netmask 255.255.255.0 up"))

    def test_a_multicast_route_on_the_cable_is_not_its_connected_route(self):
        # The guard puts multicast on the cable; a link back without its
        # connected route must still re-run DHCP.
        self.start()
        self.sb.wait_state("operational")
        n = len([c for c in self.calls() if c.startswith("udhcpc")])  # DHCP starts so far
        self.sb.patch_fake(wired_route=False, extra_routes=[
            {"net": "224.0.0.0", "mask": "240.0.0.0", "gw": "0.0.0.0", "dev": "eth2", "metric": "0"}])
        self.assertTrue(self.wait(lambda: len([c for c in self.calls() if c.startswith("udhcpc")]) > n),
                        "a multicast route passed for the connected route")

    def test_status_says_when_wifi_off_needs_a_router(self):
        (self.sb.dir / "cloud_blocker.conf").write_text("0\n")
        self.conf("WIFI_OFF=1\n")
        self.start()
        self.assertTrue(self.wait(lambda: self.lan_dev() == "eth2"))
        self.assertIn("wifi_off_blocked=no_router", self.sb.run("status", **self.path()).stdout.splitlines())

    def test_the_web_apps_flock_file_doesnt_block_the_service(self):
        # codex_webui serializes POST /api/usb-eth with a flock on a plain
        # file it leaves behind; the service's mkdir lock must not collide.
        (self.sb.run_dir / "codex-usb-eth.lock").write_text("")
        t0 = time.time()
        self.assertEqual(self.sb.run("start", **self.path()).returncode, 0)
        self.sb.wait_state("operational")
        self.assertEqual(self.sb.run("restart", **self.path()).returncode, 0)
        self.assertEqual(self.sb.run("stop", **self.path()).returncode, 0)
        self.assertEqual(self.sb.state().get("state"), "stopped")
        self.assertNotIn("cannot take", self.log())
        self.assertLess(time.time() - t0, 20)

    def test_the_service_lock_is_not_the_web_apps_flock_file(self):
        import re
        webui = (REPO / "payload/source/codex_webui.c").read_text()
        flock = re.search(r'#define USB_ETH_LOCK\s+"([^"]+)"', webui).group(1)
        svc = re.search(r'^LOCK_DIR=\$\{USBETH_LOCK_DIR:-\$RUN_DIR/([^}]+)\}$', SERVICE.read_text(), re.M).group(1)
        self.assertNotEqual(flock, "/var/run/" + svc)

    def test_restart_with_wifi_off_needs_no_phy_probe(self):
        # usbctrlr1 reads 0xdeadbeef while Wi-Fi is disconnected; with the
        # controller already bound the worker must not wait on it.
        self.conf("WIFI_OFF=1\n")
        self.guard_with_watchdog()
        self.sb.run("start", **self.path())
        self.assertTrue(self.wait(lambda: self.lan_dev() == "eth2"))
        self.clock(1061)
        self.assertTrue(self.wait(self.suspended))
        self.sb.patch_fake(phy_ready_after=10**6)  # every phy-host read is now a sentinel
        self.assertEqual(self.sb.run("restart", **self.path()).returncode, 0)
        # The state file still says "operational" from the old worker: give
        # the new one time to get through (or fail) its startup first.
        self.assertFalse(self.wait(lambda: "phy_not_ready" in self.log(), timeout=8), "the new worker waited on the PHY")
        # By now the new worker has written its own states; under load it may
        # still be finishing its startup.
        self.sb.wait_state("operational", timeout=20)
        self.assertNotIn("phy_not_ready", self.log())
        self.assertTrue(self.suspended())

    def defaults(self, dev):
        return [r["metric"] for r in self.sb.read_fake().get("extra_routes", []) if r["net"] == "0.0.0.0" and r["dev"] == dev]

    def test_a_cable_not_carrying_local_traffic_keeps_behind_wifis_default_route(self):
        # Blocker off, cable on another network: its own DHCP's default route
        # mustn't take the internet from Wi-Fi.
        (self.sb.dir / "cloud_blocker.conf").write_text("0\n")
        self.sb.patch_fake(ipv4="10.9.0.5", wifi_ip="192.168.0.50", extra_routes=[
            {"net": "0.0.0.0", "mask": "0.0.0.0", "gw": "10.9.0.1", "dev": "eth2", "metric": "0"},
            {"net": "0.0.0.0", "mask": "0.0.0.0", "gw": "192.168.0.1", "dev": "ath0", "metric": "0"}])
        self.start()
        self.assertTrue(self.wait(lambda: self.defaults("eth2") == ["30"]), self.defaults("eth2"))
        self.assertEqual(self.defaults("ath0"), ["0"])

    def test_a_cable_whose_router_doesnt_answer_keeps_behind_wifis_default_route(self):
        (self.sb.dir / "cloud_blocker.conf").write_text("0\n")
        self.sb.patch_fake(ping_dead_dev="eth2", wifi_ip="192.168.0.50", extra_routes=[
            {"net": "0.0.0.0", "mask": "0.0.0.0", "gw": "192.168.0.1", "dev": "eth2", "metric": "0"},
            {"net": "0.0.0.0", "mask": "0.0.0.0", "gw": "192.168.0.1", "dev": "ath0", "metric": "0"}])
        self.start()
        self.sb.wait_state("gateway_unreachable")
        self.assertTrue(self.wait(lambda: self.defaults("eth2") == ["30"]), self.defaults("eth2"))
        # Router back after the retry time: the cable takes over, its default
        # route back at 0 and Wi-Fi's behind it.
        self.sb.patch_fake(ping_dead_dev="")
        self.clock(1601)
        self.sb.wait_state("operational")
        self.assertTrue(self.wait(lambda: self.defaults("eth2") == ["0"] and self.defaults("ath0") == ["20"]),
                        (self.defaults("eth2"), self.defaults("ath0")))

    def test_a_refused_disconnect_leaves_no_wifi_off_state(self):
        self.conf("WIFI_OFF=1\n")
        self.guard_with_watchdog()
        self.sb.patch_fake(wpa_fail=True)
        self.start()
        self.assertTrue(self.wait(lambda: self.lan_dev() == "eth2"))
        self.clock(1061)
        self.assertTrue(self.wait(lambda: "wpa_cli -i ath0 disconnect" in self.calls()))
        time.sleep(0.5)
        self.assertFalse(self.suspended(), "Wi-Fi recorded as off although the disconnect was refused")

    def test_a_worker_that_sees_the_switch_off_re_checks_under_the_lock(self):
        # Switched off and back on while the worker waits for the lock (a
        # start holds it): the worker must carry on, not exit.
        self.start()
        self.sb.wait_state("operational")
        lockdir = self.sb.run_dir / "codex-usb-eth-service.lock"
        holder = subprocess.Popen(["/bin/sleep", "60"])
        try:
            lockdir.mkdir()
            (lockdir / "pid").write_text(f"{holder.pid}\n")
            (self.sb.dir / "usb_eth.conf").write_text("ENABLED=0\n")
            time.sleep(1.0)  # the worker sees it off and waits for the lock
            (self.sb.dir / "usb_eth.conf").write_text("ENABLED=1\n")
        finally:
            holder.kill()
            holder.wait()
            import shutil as _sh
            _sh.rmtree(lockdir, ignore_errors=True)
        time.sleep(1.5)
        self.assertNotIn("worker exiting", self.log())
        self.assertIsNone(self.procs[-1].poll(), "the worker exited although switched back on")

    def test_restart_does_nothing_while_switched_off(self):
        (self.sb.dir / "usb_eth.conf").write_text("ENABLED=0\n")
        self.assertEqual(self.sb.run("restart", **self.path()).returncode, 0)
        self.assertFalse((self.sb.run_dir / "codex-usb-eth-worker.pid").exists())

    def test_dhcp_keeps_asking_every_2_s_for_40_s(self):
        self.start()
        self.assertTrue(self.wait(lambda: any(c.startswith("udhcpc") for c in self.calls())))
        dh = [c for c in self.calls() if c.startswith("udhcpc")][0]
        self.assertIn("-t20 -T2 -A10", dh)

    def test_with_the_blocker_off_wifis_default_route_gives_way_and_comes_back(self):
        (self.sb.dir / "cloud_blocker.conf").write_text("0\n")
        self.sb.patch_fake(extra_routes=[
            {"net": "0.0.0.0", "mask": "0.0.0.0", "gw": "192.168.0.1", "dev": "ath0", "metric": "0"},
            {"net": "0.0.0.0", "mask": "0.0.0.0", "gw": "192.168.0.1", "dev": "eth2", "metric": "0"}])
        self.start()
        self.sb.wait_state("operational")
        wifi_default = lambda: [r["metric"] for r in self.sb.read_fake()["extra_routes"] if r["net"] == "0.0.0.0" and r["dev"] == "ath0"]
        self.assertTrue(self.wait(lambda: wifi_default() == ["20"]), wifi_default())
        self.sb.patch_fake(carrier=0)
        self.assertTrue(self.wait(lambda: wifi_default() == ["0"]), wifi_default())

    def test_status_and_overview(self):
        self.start()
        self.assertTrue(self.wait(lambda: self.lan_dev() == "eth2"))
        st = self.sb.run("status", **self.path()).stdout
        for line in ("lan_dev=eth2", "wifi_off=0", "wifi_suspended=0", "ip_mode=dhcp", "netmask=255.255.255.0", "dns=192.168.0.1"):
            self.assertIn(line, st.splitlines(), st)
        ov = self.sb.run("overview", **self.path()).stdout.splitlines()
        self.assertIn("lan_dev=eth2", ov)
        self.assertIn("gateway=192.168.0.1", ov)
        self.assertIn("cloud_blocker=1", ov)
        self.assertTrue(any(l.startswith("iface=eth2|wired|192.168.0.234|255.255.255.0|") for l in ov), ov)
        self.assertTrue(any(l.startswith("route=192.168.0.0|0.0.0.0|255.255.255.0|U|0|eth2") for l in ov), ov)
        self.assertIn("dns=192.168.0.1", ov)

if __name__ == "__main__":
    unittest.main(verbosity=2)
