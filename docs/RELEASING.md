# Releasing Melodious

A release is a GitHub release `v<version>` ("Melodious <major.minor>") with:
- the hub zip;
- the Android APK;
- the four macOS files;
- BusyBox's upstream source tarball, `busybox-<version>.tar.bz2` (hub releases);
- `melodious-update.json`;
- `SHA256SUMS.txt`.

A Mac-only hotfix may go out as `desktop-v<version>` with the Mac files. Untick
"Set as latest" on those releases, so GitHub's "latest" stays on the full
release.

Releases are not signed. `SHA256SUMS.txt` proves a download is intact, not who
published it, so the GitHub account is what protects a release. The APK is
still signed with the Android release key (`melodious-release.jks`, certificate
SHA-256 `7a766509…0bd2de`). Android refuses an update signed with any other
key, so losing that key means users uninstall and reinstall.

## Each release

1. **Build the assets** into one folder:
   - `melodious-hub-<v>.zip`;
   - the owner signs the APK with `apksigner` → `melodious-<v>.apk`;
   - `Melodious-<v>-{arm64,x64}.{dmg,zip}`;
   - for a hub release, the BusyBox tarball that
     `third_party/busybox-<version>/README.md` names, as downloaded from
     busybox.net (`busybox-1.37.0.tar.bz2` today). `busybox-extra` is GPL-2.0,
     so its complete source goes out from the same place as the binary.
2. **Write the manifest and checksums** (the agent runs this):

   ```sh
   python3 tools/releases/release.py manifest <folder> --version <v> --min-hub <oldest hub the apps support>
   ```

   This writes:
   - `melodious-update.json`: version, the APK's versionCode and certificate,
     the Mac zips, and each hub payload file with its install destination,
     tier and SHA-256;
   - `SHA256SUMS.txt`: every asset, the BusyBox tarball included, plus
     `melodious-update.json`.

   It also checks:
   - the APK is signed with the release key;
   - the hub zip's `MANIFEST.txt` matches its binaries;
   - every payload file has a known destination;
   - the hub zip carries the installers' flash probe,
     `payload/helpers/codex_flash_free`. Add `payload/helpers` to the
     `git archive` path list. The probe runs only from the hub's RAM, so
     `melodious-update.json` doesn't list it;
   - the hub zip carries the GPL-2.0 BusyBox's corresponding source:
     `LICENSE`, `third_party/busybox-1.37.0/` (licence, patch, `.config`,
     and the README naming the upstream tarball) and the build scripts
     (`build/build_harmony_tools_kali.sh`, `build/busybox-zig-cc.sh`,
     `build/busybox-zig-ar.sh`, `build/discard-mips-pdr.ld`). Add them to the
     `git archive` path list;
   - the BusyBox tarball is in the folder and matches the SHA-256 that README
     pins.
3. **Verify** (the agent runs this):

   ```sh
   python3 tools/releases/release.py verify <folder>
   ```

   It checks every checksum, that nothing in the folder is left out, and that
   the manifest matches the assets.
4. **Upload everything in the folder**, including `melodious-update.json`,
   then publish.

For a `desktop-v<v>` release, add `--series desktop --commit <sha>` in step 2.

## Hub version

`MELODIOUS_VERSION` in `payload/source/codex_webui.c` is the release the hub
software belongs to. `GET /api/version` reports it. Bump it in the release
commit and rebuild `codex_webui` (`docs/BUILD.md`), even if nothing else in
the hub changed.
