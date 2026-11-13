#!/usr/bin/env python3
"""Tests for tools/releases/release.py on a synthetic release.

  python3 tools/releases/test_release.py
"""

from __future__ import annotations

import hashlib
import json
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import release  # noqa: E402

VERSION = "9.8.7"
COMMIT = "0123456789abcdef0123456789abcdef01234567"
WIN_SETUP = f"Melodious-{VERSION}-win-x64-setup.exe"
WIN_ZIP = f"Melodious-{VERSION}-win-x64.zip"
TARBALL = b"fake busybox-1.37.0 source\n"
TARBALL_NAME = "busybox-1.37.0.tar.bz2"
README = ("| Upstream source | `https://busybox.net/downloads/busybox-1.37.0.tar.bz2`, SHA-256 `"
          + hashlib.sha256(TARBALL).hexdigest() + "` (matches busybox.net's `.sha256`) |\n")


def fake_apk(_path: Path) -> dict:
    return {"package": "app.melodious", "versionCode": 42, "versionName": VERSION,
            "certs": [release.ANDROID_RELEASE_CERT]}


def write_hub_zip(path: Path, extra: dict | None = None, bad_md5: bool = False, helpers: bool = True,
                  gpl_source: bool = True, gpl_source_omit: str = "", readme: str = README) -> None:
    files = {rel: f"content of {rel}\n".encode() for rel in release.HUB_FILES}
    if helpers:
        files.update({rel: f"helper {rel}\n".encode() for rel in release.HUB_INSTALLER_HELPERS})
    files.update(extra or {})
    manifest = "".join(
        f"{hashlib.md5(data).hexdigest() if not bad_md5 else '0' * 32}  {rel.split('/')[-1]}\n"
        for rel, data in files.items() if rel.startswith("payload/bin/")
    )
    top = f"melodious-hub-{VERSION}/"
    with zipfile.ZipFile(path, "w") as z:
        z.comment = COMMIT.encode()
        z.writestr(top + "install_webui.py", "# installer\n")
        z.writestr(top + "payload/bin/MANIFEST.txt", manifest)
        if gpl_source:
            for rel in sorted(release.HUB_GPL_SOURCE) + [
                    "third_party/busybox-1.37.0/" + f for f in release.BUSYBOX_SOURCE_FILES] + [
                    "third_party/busybox-1.37.0/patches/0001-fix.patch"]:
                if rel != gpl_source_omit:
                    z.writestr(top + rel, readme if rel.endswith("/README.md") else f"source {rel}\n")
        for rel, data in files.items():
            z.writestr(top + rel, data)


class ReleaseToolTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.dir = root / "release"
        self.dir.mkdir()

    def tearDown(self):
        self.tmp.cleanup()

    def make_release(self, series="hub", tarball: bytes | None = TARBALL, **zip_args):
        if series == "hub" and tarball is not None:
            (self.dir / TARBALL_NAME).write_bytes(tarball)
        for name in release.ordered_assets(series, VERSION):
            if name.startswith("melodious-hub-"):
                write_hub_zip(self.dir / name, **zip_args)
            else:
                (self.dir / name).write_bytes(f"asset {name}".encode())
        manifest = release.build_manifest(self.dir, series, VERSION, "1.2.0",
                                          None if series == "hub" else COMMIT, apk_reader=fake_apk)
        (self.dir / release.MANIFEST_NAME).write_text(json.dumps(manifest, indent=2) + "\n")
        release.write_sums(self.dir, release.release_assets(self.dir, series, VERSION) + [release.MANIFEST_NAME])
        return manifest

    def verify(self):
        return release.verify_release(self.dir, apk_reader=fake_apk)

    def assertRejected(self, pattern):
        with self.assertRaisesRegex(release.ReleaseError, pattern):
            self.verify()

    def test_hub_release_round_trip(self):
        manifest = self.make_release()
        report = self.verify()
        self.assertIn("matches the assets", report[-1])
        self.assertEqual(manifest["commit"], COMMIT)
        self.assertEqual(manifest["android"]["versionCode"], 42)
        tiers = {f["path"]: f["tier"] for f in manifest["hub"]["files"]}
        self.assertEqual(tiers["payload/bin/codex_webui"], 1)
        self.assertEqual(tiers["payload/activity/codexactivity.lua"], 2)
        self.assertEqual(tiers["payload/scripts/rcS.local"], 3)
        self.assertEqual(tiers["payload/bin/codex_portal"], 3)
        self.assertWindows(manifest)

    def test_desktop_release_round_trip(self):
        manifest = self.make_release(series="desktop")
        self.verify()
        self.assertEqual(manifest["tag"], f"desktop-v{VERSION}")
        self.assertNotIn("hub", manifest)
        self.assertWindows(manifest)

    def assertWindows(self, manifest):
        self.assertEqual(manifest["windows"], {
            "assets": {"x64": WIN_SETUP}, "zip": {"x64": WIN_ZIP}, "minSystem": "10.0", "minHub": "1.2.0"})
        self.assertEqual(manifest["macos"]["assets"],
                         {arch: f"Melodious-{VERSION}-{arch}.zip" for arch in ("arm64", "x64")})
        sums = release.parse_sums((self.dir / release.SUMS_NAME).read_text())
        for name in (WIN_SETUP, WIN_ZIP):
            self.assertEqual(sums[name], hashlib.sha256(f"asset {name}".encode()).hexdigest())
        at = list(sums).index(f"Melodious-{VERSION}-x64.zip")
        self.assertEqual(list(sums)[at + 1:at + 3], [WIN_SETUP, WIN_ZIP])

    def test_windows_min_hub_is_optional_for_desktop(self):
        self.make_release(series="desktop")
        manifest = release.build_manifest(self.dir, "desktop", VERSION, None, COMMIT)
        self.assertNotIn("minHub", manifest["windows"])
        self.assertNotIn("minHub", manifest["macos"])

    def test_missing_windows_asset_is_rejected(self):
        for series in ("hub", "desktop"):
            for name in (WIN_SETUP, WIN_ZIP):
                with self.subTest(series=series, name=name):
                    self.make_release(series=series)
                    (self.dir / name).unlink()
                    self.assertRejected(f"lists {name}, which is not in")
                    with self.assertRaisesRegex(release.ReleaseError, f"missing asset {name}"):
                        release.build_manifest(self.dir, series, VERSION, "1.2.0", COMMIT, apk_reader=fake_apk)
                self.tearDown()
                self.setUp()

    def test_corrupted_windows_asset_is_rejected(self):
        for series in ("hub", "desktop"):
            for name in (WIN_SETUP, WIN_ZIP):
                with self.subTest(series=series, name=name):
                    self.make_release(series=series)
                    (self.dir / name).write_bytes(b"swapped")
                    self.assertRejected(f"{name}: SHA-256 does not match")
                self.tearDown()
                self.setUp()

    def test_windows_asset_left_out_of_sums_is_rejected(self):
        for series in ("hub", "desktop"):
            with self.subTest(series=series):
                self.make_release(series=series)
                names = [n for n in release.release_assets(self.dir, series, VERSION) if n != WIN_ZIP]
                release.write_sums(self.dir, names + [release.MANIFEST_NAME])
                self.assertRejected("not covered")
                (self.dir / WIN_ZIP).unlink()
                self.assertRejected("expected")
            self.tearDown()
            self.setUp()

    def test_edited_windows_manifest_is_rejected(self):
        self.make_release(series="desktop")
        path = self.dir / release.MANIFEST_NAME
        data = json.loads(path.read_text())
        data["windows"]["assets"]["x64"] = WIN_ZIP
        path.write_text(json.dumps(data, indent=2) + "\n")
        release.write_sums(self.dir, release.release_assets(self.dir, "desktop", VERSION) + [release.MANIFEST_NAME])
        self.assertRejected("does not match the assets")

    def test_tampered_asset_is_rejected(self):
        self.make_release()
        (self.dir / f"melodious-{VERSION}.apk").write_bytes(b"swapped")
        self.assertRejected("SHA-256 does not match")

    def test_extra_unlisted_asset_is_rejected(self):
        self.make_release()
        (self.dir / "surprise.bin").write_bytes(b"x")
        self.assertRejected("not covered")

    def test_unknown_payload_file_is_rejected(self):
        with self.assertRaisesRegex(release.ReleaseError, "no install destination"):
            self.make_release(extra={"payload/bin/codex_new_daemon": b"new"})

    def test_installer_helpers_ship_but_are_not_installed(self):
        manifest = self.make_release()
        paths = {f["path"] for f in manifest["hub"]["files"]}
        self.assertTrue(release.HUB_INSTALLER_HELPERS)
        self.assertFalse(paths & release.HUB_INSTALLER_HELPERS)

    def test_missing_installer_helper_is_rejected(self):
        with self.assertRaisesRegex(release.ReleaseError, "missing payload files payload/helpers/"):
            self.make_release(helpers=False)

    def test_busybox_needs_its_licence_and_source_in_the_zip(self):
        self.assertIn("payload/bin/busybox-extra", release.HUB_FILES)
        with self.assertRaisesRegex(release.ReleaseError, "missing BusyBox licence/source files"):
            self.make_release(gpl_source=False)
        for omit in ("build/busybox-zig-cc.sh", "third_party/busybox-1.37.0/busybox.config",
                     "third_party/busybox-1.37.0/patches/0001-fix.patch"):
            with self.subTest(omit=omit), self.assertRaisesRegex(release.ReleaseError, "missing BusyBox"):
                self.make_release(gpl_source_omit=omit)

    def test_hub_release_carries_busybox_upstream_source(self):
        self.make_release()
        sums = release.parse_sums((self.dir / release.SUMS_NAME).read_text())
        self.assertEqual(sums[TARBALL_NAME], hashlib.sha256(TARBALL).hexdigest())
        self.verify()
        self.assertEqual(release.source_assets(self.dir, "desktop", VERSION), {})

    def test_missing_busybox_tarball_is_rejected(self):
        with self.assertRaisesRegex(release.ReleaseError, f"missing asset {TARBALL_NAME}"):
            self.make_release(tarball=None)

    def test_busybox_tarball_must_match_the_pin(self):
        with self.assertRaisesRegex(release.ReleaseError, "differs from the pin"):
            self.make_release(tarball=b"another tarball\n")
        self.tearDown()
        self.setUp()
        self.make_release()
        (self.dir / TARBALL_NAME).write_bytes(b"swapped\n")
        self.assertRejected("SHA-256 does not match")

    def test_busybox_tarball_left_out_of_sums_is_rejected(self):
        self.make_release()
        release.write_sums(self.dir, release.ordered_assets("hub", VERSION) + [release.MANIFEST_NAME])
        self.assertRejected("not covered")

    def test_readme_must_pin_the_tarball(self):
        with self.assertRaisesRegex(release.ReleaseError, "doesn't name the upstream"):
            self.make_release(readme="no pin here\n")
        with self.assertRaisesRegex(release.ReleaseError, "another version"):
            self.make_release(readme=README.replace("1.37.0", "1.36.1"))

    def test_payload_manifest_mismatch_is_rejected(self):
        with self.assertRaisesRegex(release.ReleaseError, "md5 for"):
            self.make_release(bad_md5=True)

    def test_hub_release_needs_min_hub(self):
        self.make_release()
        with self.assertRaisesRegex(release.ReleaseError, "--min-hub is required"):
            release.build_manifest(self.dir, "hub", VERSION, None, None, apk_reader=fake_apk)

    def test_apk_from_another_key_is_rejected(self):
        self.make_release()
        wrong = lambda p: {**fake_apk(p), "certs": ["00" * 32]}  # noqa: E731
        with self.assertRaisesRegex(release.ReleaseError, "expected the release key"):
            release.build_manifest(self.dir, "hub", VERSION, "1.2.0", None, apk_reader=wrong)

    def test_edited_sums_are_rejected(self):
        self.make_release()
        sums = self.dir / release.SUMS_NAME
        sums.write_text(sums.read_text().replace("0", "1", 1))
        self.assertRejected("SHA-256 does not match|bad SHA256SUMS|does not match")

    def test_edited_manifest_is_rejected(self):
        self.make_release()
        path = self.dir / release.MANIFEST_NAME
        data = json.loads(path.read_text())
        data["android"]["minHub"] = "1.0.0"
        path.write_text(json.dumps(data, indent=2) + "\n")
        release.write_sums(self.dir, release.release_assets(self.dir, "hub", VERSION) + [release.MANIFEST_NAME])
        self.assertRejected("does not match the assets")

if __name__ == "__main__":
    unittest.main()
