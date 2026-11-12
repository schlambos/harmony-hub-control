#!/usr/bin/env python3
"""Scratch-repo integration tests for build/pins/*, tools/repin.sh,
tools/absorb_main.sh, and tools/ci/verify_pins.py.

Proves:
  1. Two branches editing different binaries merge with zero conflicts under
     build/pins/, and absorb_main.sh refreshes MANIFEST.txt cleanly.
  2. Two branches both changing codex_webui (web JS on one branch, C on the
     other) conflict on derived files only, and absorb_main.sh resolves +
     rebuilds + repins in one command, passing verify_pins.py.
  3. Two branches conflicting on a hand-written C/JS line cause absorb_main.sh
     to stop (exit != 0), report the conflicting hand-written file, and abort
     the merge cleanly without guessing.
  4. verify_pins.py fails on stale build/pins/*, inline *_EXPECT_* regressions,
     duplicate BUILD.md digests, or non-canonical MANIFEST.txt.
  5. Pre-Phase-2 transition: a branch forked before Phase 2 that edited legacy
     inline *_EXPECT_* pins in build_harmony_tools_kali.sh and docs/BUILD.md
     absorbs post-Phase-2 main cleanly via absorb_main.sh.
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

COPY_PATHS = (
    ".gitattributes",
    ".gitignore",
    "build/build_harmony_tools_kali.sh",
    "build/discard-mips-pdr.ld",
    "build/pins",
    "docs/BUILD.md",
    "payload/bin",
    "payload/helpers/codex_flash_free",
    "payload/modules/usb-net",
    "payload/source",
    "payload/web",
    "tools/absorb_main.sh",
    "tools/embed_activity_ui.sh",
    "tools/package_harmony_shell.sh",
    "tools/repin.sh",
    "tools/ci/install_bun.sh",
    "tools/ci/verify_pins.py",
    "tools/webui-sim/public",
)


def git(cwd: Path, *args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    env = os.environ.copy()
    env.setdefault("GIT_AUTHOR_NAME", "Test Author")
    env.setdefault("GIT_AUTHOR_EMAIL", "author@example.invalid")
    env.setdefault("GIT_COMMITTER_NAME", "Test Committer")
    env.setdefault("GIT_COMMITTER_EMAIL", "committer@example.invalid")
    return subprocess.run(
        ["git", *args],
        cwd=cwd,
        check=check,
        capture_output=True,
        text=True,
        env=env,
    )


def run_cmd(cwd: Path, *args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        list(args),
        cwd=cwd,
        check=check,
        capture_output=True,
        text=True,
    )


class RepinAbsorbTest(unittest.TestCase):
    template_dir: tempfile.TemporaryDirectory[str]
    template_repo: Path

    @classmethod
    def setUpClass(cls) -> None:
        # Avoid commas in temp directory paths (clang -Wl,-T,... splits on commas)
        cls.template_dir = tempfile.TemporaryDirectory(prefix="melodious-repin-tpl-")
        cls.template_repo = Path(cls.template_dir.name) / "repo"
        cls.template_repo.mkdir(parents=True, exist_ok=True)
        for rel in COPY_PATHS:
            src = ROOT / rel
            dst = cls.template_repo / rel
            dst.parent.mkdir(parents=True, exist_ok=True)
            if src.is_dir():
                shutil.copytree(src, dst, symlinks=True)
            else:
                shutil.copy2(src, dst)
        git(cls.template_repo, "init", "-b", "main")
        git(cls.template_repo, "config", "user.name", "Test Author")
        git(cls.template_repo, "config", "user.email", "author@example.invalid")
        git(cls.template_repo, "add", ".")
        git(cls.template_repo, "commit", "-q", "-m", "initial post-phase2 main")

    @classmethod
    def tearDownClass(cls) -> None:
        cls.template_dir.cleanup()

    def make_scratch_repo(self) -> tuple[tempfile.TemporaryDirectory[str], Path]:
        tmp = tempfile.TemporaryDirectory(prefix="melodious-repin-test-")
        repo = Path(tmp.name) / "work"
        shutil.copytree(self.template_repo, repo, symlinks=True)
        return tmp, repo

    def test_1_different_binaries_merge_with_zero_pin_conflicts(self) -> None:
        tmp, repo = self.make_scratch_repo()
        self.addCleanup(tmp.cleanup)

        # Branch A edits codex_dhcpd.c and repins codex_dhcpd on main
        dhcpd_c = repo / "payload/source/codex_dhcpd.c"
        dhcpd_c.write_text(
            dhcpd_c.read_text(encoding="utf-8")
            + '\n__attribute__((used)) static const char repin_test_dhcpd[] = "dhcpd-branch-a";\n',
            encoding="utf-8",
        )
        run_cmd(repo, "sh", "tools/repin.sh", "codex_dhcpd")
        git(repo, "add", ".")
        git(repo, "commit", "-q", "-m", "feat(dhcpd): update codex_dhcpd")

        # Branch B (from initial commit) edits codex_hbus.c and repins codex_hbus
        git(repo, "checkout", "-q", "-b", "feat/hbus", "HEAD~1")
        hbus_c = repo / "payload/source/codex_hbus.c"
        hbus_c.write_text(
            hbus_c.read_text(encoding="utf-8")
            + '\n__attribute__((used)) static const char repin_test_hbus[] = "hbus-branch-b";\n',
            encoding="utf-8",
        )
        run_cmd(repo, "sh", "tools/repin.sh", "codex_hbus")
        git(repo, "add", ".")
        git(repo, "commit", "-q", "-m", "feat(hbus): update codex_hbus")

        # Verify that a raw git merge produces ZERO conflicts under build/pins/
        git(repo, "merge", "--no-commit", "--no-ff", "main", check=False)
        unmerged = git(repo, "diff", "--name-only", "--diff-filter=U").stdout.splitlines()
        pin_conflicts = [p for p in unmerged if p.startswith("build/pins/")]
        self.assertEqual(pin_conflicts, [], f"expected zero conflicts under build/pins/, got {unmerged}")
        git(repo, "merge", "--abort", check=False)

        # Now run absorb_main.sh to complete the merge and refresh MANIFEST.txt
        res = run_cmd(repo, "sh", "tools/absorb_main.sh", "--no-fetch", "--main", "main")
        self.assertEqual(res.returncode, 0, res.stderr)
        verify = run_cmd(repo, "python3", "tools/ci/verify_pins.py")
        self.assertEqual(verify.returncode, 0, verify.stderr)

    def test_2_same_binary_codex_webui_web_and_c_resolved_by_absorb_main(self) -> None:
        tmp, repo = self.make_scratch_repo()
        self.addCleanup(tmp.cleanup)

        # main advances with a C change in codex_webui.c + repin
        webui_c = repo / "payload/source/codex_webui.c"
        webui_c.write_text(
            webui_c.read_text(encoding="utf-8")
            + '\n__attribute__((used)) static const char repin_main_c_tag[] = "webui-main-c-change";\n',
            encoding="utf-8",
        )
        run_cmd(repo, "sh", "tools/repin.sh", "codex_webui")
        git(repo, "add", ".")
        git(repo, "commit", "-q", "-m", "feat(webui): C change on main")
        main_webui_sha = (repo / "build/pins/codex_webui").read_text(encoding="utf-8")

        # Feature branch (from initial commit) changes web JS + repins codex_webui
        git(repo, "checkout", "-q", "-b", "feat/web-js", "HEAD~1")
        app_js = repo / "tools/webui-sim/public/js/app.js"
        app_js.write_text(
            app_js.read_text(encoding="utf-8")
            + '\nglobalThis.__melodiousRepinTestMarker = "web-branch-js-change";\n',
            encoding="utf-8",
        )
        run_cmd(repo, "sh", "tools/repin.sh", "codex_webui")
        git(repo, "add", ".")
        builder_commit = git(repo, "commit", "-q", "-m", "feat(webui): JS change on branch")
        branch_commit_sha = git(repo, "rev-parse", "HEAD").stdout.strip()
        branch_webui_sha = (repo / "build/pins/codex_webui").read_text(encoding="utf-8")
        self.assertNotEqual(main_webui_sha, branch_webui_sha)

        # Absorb main in one command
        res = run_cmd(repo, "sh", "tools/absorb_main.sh", "--no-fetch", "--main", "main")
        self.assertEqual(res.returncode, 0, res.stderr)

        # Verify pins pass and the rebuilt codex_webui incorporates BOTH changes
        verify = run_cmd(repo, "python3", "tools/ci/verify_pins.py")
        self.assertEqual(verify.returncode, 0, verify.stderr)
        merged_webui_sha = (repo / "build/pins/codex_webui").read_text(encoding="utf-8")
        self.assertNotEqual(merged_webui_sha, main_webui_sha)
        self.assertNotEqual(merged_webui_sha, branch_webui_sha)
        # Contributor commit SHA is preserved as first parent of the merge commit
        first_parent = git(repo, "rev-parse", "HEAD^1").stdout.strip()
        self.assertEqual(first_parent, branch_commit_sha)

    def test_3_hand_written_conflict_stops_and_aborts_cleanly(self) -> None:
        tmp, repo = self.make_scratch_repo()
        self.addCleanup(tmp.cleanup)

        # Both main and feature branch edit the exact same hand-written line in codex_dhcpd.c
        dhcpd_c = repo / "payload/source/codex_dhcpd.c"
        orig = dhcpd_c.read_text(encoding="utf-8")
        first_line, rest = orig.split("\n", 1)

        dhcpd_c.write_text(f"{first_line} /* main edit */\n{rest}", encoding="utf-8")
        git(repo, "add", "payload/source/codex_dhcpd.c")
        git(repo, "commit", "-q", "-m", "main edits line 1 of codex_dhcpd.c")

        git(repo, "checkout", "-q", "-b", "feat/conflict", "HEAD~1")
        dhcpd_c.write_text(f"{first_line} /* branch conflicting edit */\n{rest}", encoding="utf-8")
        git(repo, "add", "payload/source/codex_dhcpd.c")
        git(repo, "commit", "-q", "-m", "branch edits line 1 of codex_dhcpd.c")
        pre_head = git(repo, "rev-parse", "HEAD").stdout.strip()

        res = run_cmd(repo, "sh", "tools/absorb_main.sh", "--no-fetch", "--main", "main", check=False)
        self.assertNotEqual(res.returncode, 0, "absorb_main.sh must fail on hand-written conflict")
        self.assertIn("payload/source/codex_dhcpd.c", res.stderr)
        # Tree must be left clean at pre_head (merge aborted)
        self.assertEqual(git(repo, "status", "--porcelain").stdout.strip(), "")
        self.assertEqual(git(repo, "rev-parse", "HEAD").stdout.strip(), pre_head)

    def test_4_verify_pins_rejects_stale_pin_and_non_canonical_manifest(self) -> None:
        tmp, repo = self.make_scratch_repo()
        self.addCleanup(tmp.cleanup)

        # 4a. Stale build/pins/codex_hbus
        pin_file = repo / "build/pins/codex_hbus"
        orig_pin = pin_file.read_text(encoding="utf-8")
        pin_file.write_text("SHA256=" + ("0" * 64) + "\nSIZE=12345\n", encoding="utf-8")
        res = run_cmd(repo, "python3", "tools/ci/verify_pins.py", check=False)
        self.assertNotEqual(res.returncode, 0)
        self.assertIn("build/pins/codex_hbus", res.stderr)
        pin_file.write_text(orig_pin, encoding="utf-8")

        # 4b. Non-canonical MANIFEST.txt (wall-clock timestamp instead of 1970-01-01 00:00)
        manifest = repo / "payload/bin/MANIFEST.txt"
        orig_manifest = manifest.read_text(encoding="utf-8")
        manifest.write_text(orig_manifest.replace("1970-01-01 00:00", "Nov 12 08:46", 1), encoding="utf-8")
        res = run_cmd(repo, "python3", "tools/ci/verify_pins.py", check=False)
        self.assertNotEqual(res.returncode, 0)
        self.assertIn("does not match canonical deterministic generator output", res.stderr)
        manifest.write_text(orig_manifest, encoding="utf-8")

        # 4c. Inline *_EXPECT_SHA256 regression in build_harmony_tools_kali.sh
        script = repo / "build/build_harmony_tools_kali.sh"
        orig_script = script.read_text(encoding="utf-8")
        script.write_text(orig_script + "\nWEBUI_EXPECT_SHA256=" + ("a" * 64) + "\n", encoding="utf-8")
        res = run_cmd(repo, "python3", "tools/ci/verify_pins.py", check=False)
        self.assertNotEqual(res.returncode, 0)
        self.assertIn("inline WEBUI_EXPECT_SHA256", res.stderr)
        script.write_text(orig_script, encoding="utf-8")

    def test_5_pre_phase2_branch_inline_pin_conflict_resolves_cleanly(self) -> None:
        tmp, repo = self.make_scratch_repo()
        self.addCleanup(tmp.cleanup)

        # Simulate a pre-Phase-2 base commit before build/pins/ existed
        git(repo, "checkout", "-q", "-b", "pre-phase2-base")
        shutil.rmtree(repo / "build/pins")
        script = repo / "build/build_harmony_tools_kali.sh"
        orig_script = script.read_text(encoding="utf-8")
        script.write_text(
            orig_script.replace(
                "#: expected output digests live in build/pins/<name> (SHA256 and SIZE, fail\n#: closed on any mismatch).",
                "DHCPD_EXPECT_SHA256=749161a5cd140cb72a73619c61d77c4beeb4a71f31ca87810ead4575b8f1ce81\nDHCPD_EXPECT_SIZE=31464",
            ),
            encoding="utf-8",
        )
        build_md = repo / "docs/BUILD.md"
        orig_md = build_md.read_text(encoding="utf-8")
        build_md.write_text(
            orig_md
            + "\n| `codex_dhcpd` | 31464 | `749161a5cd140cb72a73619c61d77c4beeb4a71f31ca87810ead4575b8f1ce81` |\n",
            encoding="utf-8",
        )
        git(repo, "add", "-A")
        git(repo, "commit", "-q", "-m", "simulate pre-phase2 base")

        # Create post-Phase-2 main on top of pre-phase2-base
        git(repo, "checkout", "-q", "-B", "main", "pre-phase2-base")
        shutil.copytree(self.template_repo / "build/pins", repo / "build/pins")
        script.write_text(orig_script, encoding="utf-8")
        build_md.write_text(orig_md, encoding="utf-8")
        git(repo, "add", "-A")
        git(repo, "commit", "-q", "-m", "Phase 2 single-home pins on main")

        # Create a PR branch forked from pre-phase2-base that edits codex_dhcpd.c
        # AND updates the old inline pins in build_harmony_tools_kali.sh and docs/BUILD.md
        git(repo, "checkout", "-q", "-b", "feat/pre-phase2-pr", "pre-phase2-base")
        dhcpd_c = repo / "payload/source/codex_dhcpd.c"
        dhcpd_c.write_text(
            dhcpd_c.read_text(encoding="utf-8")
            + '\n__attribute__((used)) static const char pre_phase2_tag[] = "pre-phase2-pr";\n',
            encoding="utf-8",
        )
        script.write_text(
            script.read_text(encoding="utf-8").replace(
                "DHCPD_EXPECT_SHA256=749161a5cd140cb72a73619c61d77c4beeb4a71f31ca87810ead4575b8f1ce81",
                "DHCPD_EXPECT_SHA256=1111111111111111111111111111111111111111111111111111111111111111",
            ),
            encoding="utf-8",
        )
        build_md.write_text(
            build_md.read_text(encoding="utf-8").replace(
                "749161a5cd140cb72a73619c61d77c4beeb4a71f31ca87810ead4575b8f1ce81",
                "1111111111111111111111111111111111111111111111111111111111111111",
            ),
            encoding="utf-8",
        )
        git(repo, "add", "-A")
        git(repo, "commit", "-q", "-m", "pre-phase2 PR edits dhcpd and old inline pins")

        # Run absorb_main.sh to absorb post-Phase-2 main into the pre-Phase-2 PR branch
        res = run_cmd(repo, "sh", "tools/absorb_main.sh", "--no-fetch", "--main", "main")
        self.assertEqual(res.returncode, 0, res.stderr)
        verify = run_cmd(repo, "python3", "tools/ci/verify_pins.py")
        self.assertEqual(verify.returncode, 0, verify.stderr)


if __name__ == "__main__":
    unittest.main()
