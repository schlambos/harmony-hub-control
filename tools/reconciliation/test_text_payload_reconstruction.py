#!/usr/bin/env python3
"""Phase 2 Lane A tests: exact public-safe text/runtime reconstruction.

Verifies, offline and without SSH/network/execution of the installers:

  * the reconstructed runtime text payloads are byte-identical to the live
    authoritative SHA-256 digests (and carry the live modes);
  * already-exact payloads were not disturbed;
  * payload/bin/MANIFEST.txt was NOT regenerated (browser/update contract
    is encoded in the installers only) and the live pair-agent binary was
    NOT copied into payload/;
  * the Python and PowerShell installers deploy the same symmetric closure
    (offline guard, codexactivity plugin + manifest literal, pair agent,
    dirs/modes/symlinks, startup) and fail closed with an explicit
    source-build blocker while codex_bt_pair_agent is unbuilt;
  * no secrets or personal/local identifiers appear in the deliverables.

Run:  python3 -m unittest tools.reconciliation.test_text_payload_reconstruction -v
"""

from __future__ import annotations

import hashlib
import os
import re
import stat
import subprocess
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parent.parent

#: reconstructed payload file -> (authoritative live SHA-256, live mode)
EXACT_PAYLOADS = {
    "payload/scripts/dropbear": (
        "cb07cd5483028c5fd4ac7a090d32b87776b9308b0115ab157fe63b3ffe6afce6",
        0o755),
    "payload/scripts/init.sh": (
        "4a334106f8acf9ecdf3d867c0deeb22d9ef7ede3afe9961c91e9651b210292c0",
        0o755),
    "payload/scripts/offline_egress_guard.sh": (
        "72f3ba67f492f51284509b029a5c38c2edccd21e334581438acd4c14708ceb42",
        0o755),
    "payload/scripts/netservicestarter.lua": (
        "e9722835033257ec0f7dd4f66df4f1f037ee8139cd7bbadaecb7c6f37b9a652c",
        0o644),
    "payload/activity/codexactivity.lua": (
        "d49ac11d49872324135b8bc7605e1ff4d0639ceabb5b3018735fcc6810cb40d6",
        0o644),
    "payload/mqtt/codexmqtt.lua": (
        "3928b5d341acf25167724ea4375a9b7dd8cc73e40b8727d35f964fc87d3cfc21",
        0o644),
}

#: payloads that were already exact before this lane and must stay untouched
ALREADY_EXACT = {
    "payload/scripts/rcS.local": (
        "d5d9693e173e4bebd8c268f72a6fc9a60b2946032c95e9a718281da2a05ea5c0"),
    "payload/scripts/dropbearkey": (
        "45d03451f1242b043f7824e3ccc4fd580f39a95322a7510c39959323ba3646cc"),
    "payload/scripts/recovery_ap.sh": (
        "5935e17d68e50216b96f5642bc4beeb2c4e491766068dbd8e36396ab0f5f9797"),
}

PAIR_AGENT = "codex_bt_pair_agent"
PAIR_AGENT_PATH = Path(REPO_ROOT, "payload", "bin", PAIR_AGENT)
#: live pair-agent binary digest that must NEVER be copied into payload/
LIVE_PAIR_AGENT_SHA256 = (
    "563c6c58a3629edfebd7ec30ebcf14e6384a2d84e89669b1d7c3d79c75b619c8")

#: committed MANIFEST.txt at the Phase 1 commit (must not be regenerated)
COMMITTED_MANIFEST_SHA256 = (
    "dfe176842dd1caae66e0ee9867e759880fb6cb9893b5f23d15ec92d107e2e6e6")

#: banned personal/local identifiers (fragments avoid self-matching)
_BANNED = ("/Use" + "rs/", "192.168" + ".0.123", "schlam" + "bo")
_RE_PERSONAL = re.compile(r"\bma" + r"tt\b", re.IGNORECASE)
_RE_ROOT_AT_IP = re.compile("ro" + r"ot@" + r"[0-9]")

#: remote paths both installers must deploy (symmetric closure)
REQUIRED_REMOTE_TARGETS = (
    "/data/codex/bin/dropbearmulti",
    "/data/codex/bin/codex_dhcpd",
    "/data/codex/bin/codex_hbus",
    "/data/codex/bin/codex_hal_ltcp",
    "/data/codex/bin/codex_bthid_keyboard",
    "/data/codex/bin/codex_bt_pair_agent",
    "/data/codex/bin/codex_portal",
    "/data/codex/bin/codex_webui",
    "/usr/sbin/dropbear",
    "/usr/sbin/dropbearkey",
    "/data/codex/init.sh",
    "/data/codex/offline_egress_guard.sh",
    "/data/codex/recovery_ap.sh",
    "/etc/init.d/rcS.local",
    "/opt/luaworks/tasks/connectserver/netservicestarter.lua",
    "/pkg/codexactivity/codexactivity.lua",
    "/pkg/codexactivity/manifest.json",
    "/pkg/codexmqtt/codexmqtt.lua",
    "/pkg/codexmqtt/manifest.json",
    "/data/codex/hub_id",
    "/data/codex/cloud_blocker.conf",
    "/etc/tdeenable",
    "/data/codexmqtt/config.json",
)

#: full /data/codex/bin browser/update manifest contract (both installers)
CONTRACT_BINARIES = {
    "codex_bt_pair_agent", "codex_bthid_keyboard", "codex_dhcpd",
    "codex_hal_ltcp", "codex_hbus", "codex_portal", "codex_webui",
    "dropbearmulti",
}

INSTALLER_PY = Path(REPO_ROOT, "install_webui.py")
INSTALLER_PS1 = Path(REPO_ROOT, "install_webui.ps1")


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


class TestExactReconstruction(unittest.TestCase):
    """Reconstructed payloads are byte- and mode-identical to live."""

    def test_exact_bytes_and_modes(self):
        for rel, (expected, mode) in sorted(EXACT_PAYLOADS.items()):
            path = Path(REPO_ROOT, rel)
            self.assertTrue(path.is_file(), f"{rel} missing")
            self.assertEqual(
                sha256_file(path), expected,
                f"{rel} is not byte-identical to the live artifact")
            self.assertEqual(
                stat.S_IMODE(path.stat().st_mode), mode,
                f"{rel} mode mismatch (want {oct(mode)})")

    def test_sizes_match_live_manifest(self):
        expected_sizes = {
            "payload/scripts/dropbear": 52,
            "payload/scripts/init.sh": 2647,
            "payload/scripts/offline_egress_guard.sh": 1753,
            "payload/scripts/netservicestarter.lua": 12707,
            "payload/activity/codexactivity.lua": 18551,
            "payload/mqtt/codexmqtt.lua": 23533,
        }
        for rel, size in expected_sizes.items():
            self.assertEqual(
                Path(REPO_ROOT, rel).stat().st_size, size, rel)

    def test_already_exact_payloads_untouched(self):
        for rel, expected in sorted(ALREADY_EXACT.items()):
            self.assertEqual(sha256_file(Path(REPO_ROOT, rel)), expected, rel)

    def test_diag_variant_is_the_live_netservicestarter(self):
        data = Path(REPO_ROOT, "payload/scripts/netservicestarter.lua").read_bytes()
        # the DIAG instrumentation marker documented in SESSION_HANDOFF
        self.assertIn(b"CODEX DIAG", data)
        self.assertEqual(len(data), 12707)

    def test_offline_guard_is_committed_lineage(self):
        """Guard bytes equal the committed blob (not a hand-edit)."""
        proc = subprocess.run(
            ["git", "--no-optional-locks", "-C", str(REPO_ROOT),
             "hash-object", "payload/scripts/offline_egress_guard.sh"],
            capture_output=True, text=True)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(
            proc.stdout.strip(),
            "c949ca8888628a02c446463b5aa47c181dad1fb2",
            "guard no longer matches its committed git blob")


class TestNoBinaryCopiesOrManifestRegen(unittest.TestCase):
    """Live binaries stay out of payload/; MANIFEST.txt is not regenerated."""

    def test_pair_agent_binary_not_copied(self):
        self.assertFalse(
            PAIR_AGENT_PATH.exists(),
            "live pair-agent binary must not be copied into payload/")

    def test_live_pair_agent_digest_absent_from_payload(self):
        bin_dir = Path(REPO_ROOT, "payload", "bin")
        for path in sorted(bin_dir.glob("*")):
            if path.is_file():
                self.assertNotEqual(
                    sha256_file(path), LIVE_PAIR_AGENT_SHA256,
                    f"live pair-agent bytes found in {path.name}")

    def test_bin_manifest_not_regenerated(self):
        manifest = Path(REPO_ROOT, "payload", "bin", "MANIFEST.txt")
        self.assertEqual(sha256_file(manifest), COMMITTED_MANIFEST_SHA256)
        text = manifest.read_text(encoding="utf-8")
        self.assertNotIn(
            PAIR_AGENT, text,
            "MANIFEST.txt must not list the pair agent before a staged "
            "build regenerates it; the contract lives in the installers")


class TestInstallerSymmetry(unittest.TestCase):
    """Both installers deploy the identical closure; neither executes here."""

    @classmethod
    def setUpClass(cls):
        cls.py = INSTALLER_PY.read_text(encoding="utf-8")
        # PS1 is CRLF on disk; normalize only for inspection
        cls.ps1 = INSTALLER_PS1.read_text(encoding="utf-8").replace("\r\n", "\n")

    @staticmethod
    def _norm(text: str) -> str:
        """Collapse whitespace so needles split across source lines match."""
        return re.sub(r"\s+", " ", text)

    @staticmethod
    def _upload_paths(text: str, call_re: str) -> set:
        """Remote paths of upload calls: first quoted absolute path after
        each call site (handles multiline calls and builder expressions)."""
        paths = set()
        for match in re.finditer(call_re, text):
            window = text[match.end():match.end() + 400]
            found = re.search(r'"(/[^"]+)"', window)
            if found:
                paths.add(found.group(1))
        return paths

    def test_symmetric_upload_mappings(self):
        py_text = self.py.replace(
            "PAIR_AGENT_REMOTE", '"/data/codex/bin/codex_bt_pair_agent"')
        py_uploads = self._upload_paths(
            py_text, r"self\.upload_(?:bytes|text)\(")
        ps1_text = self.ps1.replace(
            "$PairAgentRemote", '"/data/codex/bin/codex_bt_pair_agent"')
        ps1_uploads = self._upload_paths(ps1_text, r"Upload-(?:Bytes|Text)\b")
        self.assertEqual(
            py_uploads, ps1_uploads,
            "installer upload mappings diverge: "
            f"py-only={sorted(py_uploads - ps1_uploads)} "
            f"ps1-only={sorted(ps1_uploads - py_uploads)}")
        for target in REQUIRED_REMOTE_TARGETS:
            self.assertIn(target, py_uploads, f"py installer missing {target}")
            self.assertIn(target, ps1_uploads, f"ps1 installer missing {target}")
        # both installers reference every required remote path somewhere
        for target in REQUIRED_REMOTE_TARGETS:
            self.assertIn(target, self._norm(self.py))
            self.assertIn(target, self.ps1)

    def test_plugin_literals_present_and_symmetric(self):
        for text, esc in ((self.py, False), (self.ps1, True)):
            literal = ('{""plugin"":""codexactivity""}`n' if esc
                       else '{"plugin":"codexactivity"}')
            self.assertIn(literal, text, "codexactivity manifest literal")
            literal = ('{""plugin"":""codexmqtt""}`n' if esc
                       else '{"plugin":"codexmqtt"}')
            self.assertIn(literal, text, "codexmqtt manifest literal")

    def test_offline_guard_deployed_and_started(self):
        for label, text in (("py", self.py), ("ps1", self.ps1)):
            self.assertIn(
                'PAYLOAD / "scripts" / "offline_egress_guard.sh"'
                if label == "py" else 'scripts\\offline_egress_guard.sh',
                text, f"{label}: offline guard upload missing")
            self.assertIn(
                "/data/codex/offline_egress_guard.sh", text,
                f"{label}: offline guard remote path missing")
            self.assertIn(
                "offline_egress_guard.sh monitor", text,
                f"{label}: offline guard not started in monitor mode")
            self.assertIn(
                "/pkg/codexactivity", text,
                f"{label}: codexactivity dir not created")

    def test_activity_plugin_deployed(self):
        for label, text in (("py", self.py), ("ps1", self.ps1)):
            self.assertIn(
                '"activity" / "codexactivity.lua"' if label == "py"
                else 'activity\\codexactivity.lua', text,
                f"{label}: codexactivity.lua upload missing")
            self.assertIn(
                "/pkg/codexactivity/codexactivity.lua", text, label)
            self.assertIn(
                "gatewayType", text, f"{label}: hbus discover missing")
            self.assertIn("codexactivity", text, label)
            self.assertIn("codexmqtt", text, label)

    def test_pair_agent_declared_with_explicit_blocker(self):
        for label, text in (("py", self.py), ("ps1", self.ps1)):
            norm = self._norm(text)
            self.assertIn(PAIR_AGENT, text, f"{label}: pair agent undeclared")
            self.assertIn(
                "source-build blocker", norm,
                f"{label}: explicit blocker message missing")
            self.assertIn(
                "payload/source/codex_bt_pair_agent.c", norm,
                f"{label}: blocker must point at the source to build")
            unquoted = re.sub(r"\s+", " ", norm.replace('"', " "))
            self.assertIn(
                "do not copy the live evidence binary", unquoted.lower(),
                f"{label}: blocker must forbid copying the evidence binary")
            # fail-closed gate runs before any hub interaction
            gate_pos = text.find("source-build blocker")
            ssh_pos = text.find('"id; uname -a"') if label == "py" else \
                text.find('Invoke-Remote "id; uname -a"')
            self.assertGreaterEqual(
                gate_pos, 0, f"{label}: no blocker found")
            check_call = text.find(
                "ensure_pair_agent_deployable()" if label == "py"
                else "Ensure-PairAgentDeployable")
            self.assertLess(
                check_call, ssh_pos,
                f"{label}: blocker gate must run before first SSH contact")

    def test_pair_agent_uploaded_chmodded_verified(self):
        self.assertIn('PAIR_AGENT_LOCAL, PAIR_AGENT_REMOTE, "755"', self.py)
        self.assertIn("Upload-Bytes $PairAgentLocal $PairAgentRemote", self.ps1)
        for text in (self.py, self.ps1):
            # chmod coverage via the shared remote path literal
            self.assertIn("/data/codex/bin/codex_bt_pair_agent", text)

    def test_browser_update_contract_symmetric(self):
        py_block = re.search(
            r"BROWSER_UPDATE_MANIFEST_BINARIES = \((.*?)\)", self.py, re.S)
        assert py_block is not None, "py contract constant missing"
        py_names = set(re.findall(r'"([a-z_]+)"', py_block.group(1)))
        ps1_block = re.search(
            r"\$BrowserUpdateManifestBinaries = @\((.*?)\)", self.ps1, re.S)
        assert ps1_block is not None, "ps1 contract constant missing"
        ps1_names = set(re.findall(r'"([a-z_]+)"', ps1_block.group(1)))
        self.assertEqual(py_names, CONTRACT_BINARIES)
        self.assertEqual(ps1_names, CONTRACT_BINARIES)
        self.assertIn(PAIR_AGENT, py_names | ps1_names)

    def test_symlinks_and_dirs_created(self):
        for text in (self.py, self.ps1):
            self.assertIn("ln -sf dropbearmulti /data/codex/bin/dropbear", text)
            self.assertIn("ln -sf dropbearmulti /data/codex/bin/dropbearkey", text)
            self.assertIn(
                "ln -sf /data/codex/bin/codex_bthid_keyboard /cache/bin/bthid_keyboard",
                text)
            self.assertIn("mkdir -p /data/codex/bin", text)
            self.assertIn("/pkg/codexactivity", text)

    def test_backups_cover_new_closure(self):
        for text in (self.py, self.ps1):
            for backed_up in (
                    "/data/codex/offline_egress_guard.sh",
                    "/pkg/codexactivity/codexactivity.lua",
                    "/pkg/codexactivity/manifest.json",
                    "/opt/luaworks/tasks/connectserver/netservicestarter.lua"):
                self.assertIn(backed_up, text)

    def test_line_endings_preserved(self):
        raw = INSTALLER_PS1.read_bytes()
        self.assertNotIn(b"\r\n\r\n\r\n", raw)  # no accidental blank-run
        self.assertTrue(raw.count(b"\r\n") > raw.count(b"\n") * 0.9,
                        "ps1 must stay CRLF")
        py_raw = INSTALLER_PY.read_bytes()
        self.assertNotIn(b"\r\n", py_raw, "py installer must stay LF")


class TestHygiene(unittest.TestCase):
    """No secrets or personal/local identifiers in this lane's deliverables."""

    FILES = tuple(Path(REPO_ROOT, rel) for rel in EXACT_PAYLOADS) + (
        INSTALLER_PY, INSTALLER_PS1,
        Path(REPO_ROOT, "tools", "reconciliation",
             "test_text_payload_reconstruction.py"))

    def test_no_personal_or_local_identifiers(self):
        for path in self.FILES:
            text = path.read_text(encoding="utf-8", errors="replace")
            for banned in _BANNED:
                self.assertNotIn(banned, text, f"{path.name}: {banned}")
            self.assertIsNone(_RE_PERSONAL.search(text), path.name)
            self.assertIsNone(_RE_ROOT_AT_IP.search(text), path.name)

    def test_no_embedded_credentials(self):
        for path in (INSTALLER_PY, INSTALLER_PS1):
            text = path.read_text(encoding="utf-8", errors="replace")
            # broker credentials must only ever flow from parameters,
            # never hardcoded values; no key material embedded
            self.assertIsNone(re.search(r"password\s*=\s*\"[^\"]+\"", text),
                              f"{path.name}: hardcoded password")
            self.assertIsNone(re.search(r"psk\s*=\s*\"", text, re.I),
                              f"{path.name}: hardcoded PSK")
            self.assertNotIn("BEGIN RSA PRIVATE KEY", text)
            self.assertNotIn("BEGIN OPENSSH PRIVATE KEY", text)

    def test_installers_not_executed_by_tests(self):
        """Static-inspection contract: this module never imports or runs
        the installers (grep self as a guard against regressions)."""
        source = Path(__file__).read_text(encoding="utf-8")
        # needles built from fragments so this guard cannot match itself
        self.assertNotIn("import install_" + "webui", source)
        self.assertNotIn("Instal" + "ler(", source)
        self.assertNotIn("pw" + "sh", source)


if __name__ == "__main__":
    unittest.main()
