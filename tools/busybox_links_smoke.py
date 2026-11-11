#!/usr/bin/env python3
"""Smoke test for init.sh's BusyBox block: the applet links in RAM.

Cuts the `if [ -x /data/codex/bin/busybox-extra ]` block out of
payload/scripts/init.sh, points its two paths at a temporary directory and
runs it with /bin/sh against a fake busybox. Nothing on this machine outside
the temporary directory is touched; the test refuses to run if the block
names any other absolute path.

Run from the repo root: python3 tools/busybox_links_smoke.py
"""

import os
import re
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
INIT = ROOT / "payload" / "scripts" / "init.sh"
BB = "/data/codex/bin/busybox-extra"
LINKS = "/var/volatile/codex-bb"


def links_block() -> str:
    text = INIT.read_text()
    m = re.search(r"^if \[ -x /data/codex/bin/busybox-extra \]; then\n.*?^fi\n", text, re.M | re.S)
    if not m:
        raise AssertionError("init.sh has no BusyBox block")
    return m.group(0)


class BusyBoxLinks(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="bb-links-"))
        self.bb = self.tmp / "busybox"
        self.links = self.tmp / "codex-bb"
        block = links_block()
        others = set(re.findall(r"(?<![\w$])/[\w./-]+", block)) - {BB, LINKS, LINKS + "/", "/dev/null"}
        self.assertEqual(others, set(), "the block names paths this test doesn't redirect")
        self.log = self.tmp / "init.log"
        self.script = f"LOG={self.log}\n" + block.replace(BB, str(self.bb)).replace(LINKS, str(self.links))

    def tearDown(self):
        subprocess.run(["rm", "-rf", str(self.tmp)], check=True)

    def fake_busybox(self, body: str):
        self.bb.write_text("#!/bin/sh\n" + body)
        self.bb.chmod(self.bb.stat().st_mode | stat.S_IXUSR)

    def run_block(self):
        # init.sh has no `set -e`: whatever the block does, the boot goes on.
        r = subprocess.run(["/bin/sh", "-c", self.script + "echo boot-continues\n"], capture_output=True,
                           text=True, env={"PATH": "/usr/bin:/bin"})
        self.assertIn("boot-continues", r.stdout, r.stderr)
        return r

    # A stand-in for `busybox --install -s DIR`: links two applets into DIR.
    INSTALLS = (
        'if [ "$1 $2" = "--install -s" ] && [ -d "$3" ]; then\n'
        '  for a in head tail; do ln -s "$0" "$3/$a" || exit 1; done\n'
        'else echo "unexpected: $*" >&2; exit 2; fi\n'
    )

    def test_installs_the_applet_links_into_the_ram_directory(self):
        self.fake_busybox(self.INSTALLS)
        self.run_block()
        self.assertEqual(sorted(os.listdir(self.links)), ["head", "tail"])
        for n in ("head", "tail"):
            self.assertEqual(os.readlink(self.links / n), str(self.bb))

    def test_stale_links_are_replaced_on_every_boot(self):
        self.links.mkdir()
        (self.links / "old").symlink_to("/nonexistent")
        self.fake_busybox(self.INSTALLS)
        self.run_block()
        self.assertEqual(sorted(os.listdir(self.links)), ["head", "tail"])

    def test_a_binary_that_wont_run_leaves_an_empty_directory_and_logs(self):
        self.fake_busybox('echo "cannot run" >&2; exit 126\n')
        self.run_block()
        self.assertEqual(os.listdir(self.links), [])
        self.assertIn("--install failed", self.log.read_text())
        self.assertNotIn("cannot run", self.log.read_text())  # one summary line, not the raw errors

    def test_a_good_install_writes_nothing_to_the_boot_log(self):
        self.fake_busybox(self.INSTALLS)
        self.run_block()
        self.assertFalse(self.log.exists())

    def test_no_binary_no_directory(self):
        self.run_block()
        self.assertFalse(self.links.exists())


if __name__ == "__main__":
    unittest.main()
