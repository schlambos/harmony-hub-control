# Releasing Melodious

A release is a GitHub release `v<version>` ("Melodious <major.minor>") with:
- the hub zip;
- the Android APK;
- the four macOS files;
- the two Windows files (Not fully tested, needs confirmation; unsigned);
- the unsigned iOS / iPadOS IPA, `melodious-ios-<v>.ipa` (experimental, sideload-only; see [IOS_APP.md](IOS_APP.md));
- BusyBox's upstream source tarball, `busybox-<version>.tar.bz2` (hub releases);
- the GPL-2.0 hub kernel source archive, `Harmony.hub.4.3.48.mips-linux-2.6.31.tar.zip` (hub releases shipping `asix.ko`; see `third_party/linux-2.6.31-harmony/README.md`);
- `melodious-update.json`;
- `SHA256SUMS.txt`.

An app-only hotfix may go out as `desktop-v<version>` with the Mac and Windows
files. Untick "Set as latest" on those releases, so GitHub's "latest" stays on
the full release.

Releases are not signed. `SHA256SUMS.txt` proves a download is intact, not who
published it, so the GitHub account is what protects a release. The APK is
still signed with the Android release key (`melodious-release.jks`, certificate
SHA-256 `7a766509…0bd2de`). Android refuses an update signed with any other
key, so losing that key means users uninstall and reinstall.

## Each release

1. **Build the assets** into one folder:
   - `melodious-hub-<v>.zip`;
     build it from the release commit. Include the installer-only HAL patch data with the flash probe. The complete archive command is:

     ```sh
     git archive --format=zip --prefix="melodious-hub-$v/" -o "$folder/melodious-hub-$v.zip" HEAD \
       Install_Harmony_Control.cmd install_webui.py install_webui.ps1 \
       payload/bin payload/helpers payload/activity payload/mqtt payload/scripts payload/androidtv payload/modules \
       LICENSE third_party/busybox-1.37.0 build/build_harmony_tools_kali.sh \
       build/busybox-zig-cc.sh build/busybox-zig-ar.sh build/discard-mips-pdr.ld
     ```
   - the owner signs the APK with `apksigner` → `melodious-<v>.apk`;
   - `Melodious-<v>-{arm64,x64}.{dmg,zip}`;
   - `Melodious-<v>-win-x64-setup.exe` and `Melodious-<v>-win-x64.zip`, from
     the `melodious-windows-x64` artifact of the `Desktop (Windows)` workflow
     run on the release commit, or from `npm run dist:win` on a Windows PC
     (`desktop/README.md`). Check the two files against the artifact's
     `SHA256SUMS-windows.txt`, then leave that file out of the folder. They
     are unsigned (Windows Desktop app: Not fully tested, needs confirmation),
     so SmartScreen warns before the first launch; say so in the release notes;
   - for a hub release, the BusyBox tarball that
     `third_party/busybox-<version>/README.md` names, as downloaded from
     busybox.net (`busybox-1.37.0.tar.bz2` today). `busybox-extra` is GPL-2.0,
     so its complete source goes out from the same place as the binary;
   - for a hub release shipping `asix.ko`, the GPL-2.0 hub kernel source
     archive `Harmony.hub.4.3.48.mips-linux-2.6.31.tar.zip` (its origin and
     pinned SHA-256 are in `third_party/linux-2.6.31-harmony/README.md`), so
     the complete corresponding kernel source is attached beside the binary;
   - `melodious-ios-<v>.ipa`, built on macOS with Xcode via
     `./ios/build-ipa.sh` (unsigned sideload IPA; see [IOS_APP.md](IOS_APP.md)).
2. **Write the manifest and checksums** (the agent runs this):

   ```sh
   python3 tools/releases/release.py manifest <folder> --version <v> --min-hub <oldest hub the apps support>
   ```

   *(Note: `tools/releases/release.py` currently generates `melodious-update.json`
   and `SHA256SUMS.txt` only for the hub zip, APK, macOS and Windows desktop
   assets, and the BusyBox tarball, and `verify` rejects extra unlisted files
   in `<folder>`. Keep `Harmony.hub.4.3.48.mips-linux-2.6.31.tar.zip` and
   `melodious-ios-<v>.ipa` outside `<folder>` until after `release.py verify`
   passes, check their SHA-256 separately, and upload them alongside the
   verified assets in step 4.)*

   This writes:
   - `melodious-update.json`: version, the APK's versionCode and certificate,
     the Mac zips, the Windows installer and zip, and each hub payload file
     with its install destination, tier and SHA-256;
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

   It checks every checksum, that nothing in the folder is left out or
   missing (the Windows files included), and that the manifest matches the
   assets.
4. **Upload everything in the folder**, including `melodious-update.json`,
   then publish.

For a `desktop-v<v>` release, add `--series desktop --commit <sha>` in step 2.

## Hub version

`MELODIOUS_VERSION` in `payload/source/codex_webui.c` is the release the hub
software belongs to. `GET /api/version` reports it. Bump it in the release
commit and rebuild `codex_webui` (`docs/BUILD.md`), even if nothing else in
the hub changed.
