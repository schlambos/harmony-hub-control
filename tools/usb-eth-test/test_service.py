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
    save()
'''

STUB_PLAIN = {
    "ifconfig": '#!/bin/sh\necho "ifconfig $@" >> "$FAKE_DIR/calls.log"\n',
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
        sb = Sandbox({"probe_ok": False})
        # insmod of an already-loaded module is a no-op in the service;
        # simulate probe success only after rmmod+insmod by flipping the
        # flag from the rmmod side effect: emulate via driver_loaded flow
        # -- the fake binds on insmod only when probe_ok, so flip it once
        # the worker has had a chance to rmmod (calls.log watch below).
        proc = sb.spawn_worker()
        try:
            deadline = time.time() + 5
            while time.time() < deadline and "rmmod" not in sb.calls():
                time.sleep(0.05)
            sb.patch_fake(probe_ok=True)
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


if __name__ == "__main__":
    unittest.main(verbosity=2)
