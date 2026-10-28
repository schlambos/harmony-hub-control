# Melodious for macOS (`desktop/`)

The Melodious web app in a Mac window, plus Logitech catalog lookup. The
plan and its security model are in [`docs/DESKTOP_APP.md`](../docs/DESKTOP_APP.md);
the user guide is in the main [README](../README.md#the-macos-app).

The app serves the packaged web UI (`tools/package_harmony_shell.sh`) over
`melodious://app` and forwards hub requests over the LAN. Logitech sign-in,
search and download run in the main process; the page reaches them only
through the `window.melodiousDesktop.catalog` bridge.

## Setup

```sh
cd desktop
npm ci
node node_modules/electron/install.js   # npm 11 skips Electron's postinstall
```

Electron, electron-builder and Playwright are pinned to exact versions in
`package.json`.

## Bundle and run

```sh
cd desktop
npm start
```

`scripts/bundle-shell.sh` runs `tools/package_harmony_shell.sh`, checks that
`payload/source/harmony_shell_assets.h` did not change, and copies the five
shell files into `desktop/build/shell/`. If the check fails, the web app
sources and the committed header disagree: rebuild `codex_webui` first
(`docs/BUILD.md`), so the app and the hub carry the same bundle.

## Tests

```sh
node --test desktop/test/                     # units: forwarder, discovery, settings, security, catalog client, IPC, preload
(cd desktop && npm run test:e2e)              # Playwright _electron suite against tools/webui-sim
node desktop/test/hub-emu.mjs                 # catalog import POSTs against tools/hub-emu (start it first)
(cd desktop && npm run test:dist)             # the built apps in dist/ (run npm run dist first)
```

`test:dist` checks each built `Melodious.app`: the ad-hoc signature, one
architecture per build, the app's own LC_UUID, an Info.plist with the Local
Network text and no URL scheme, update feed or login item, and a shell
byte-identical to `build/shell/`. It then launches the app
against the simulator (on loopback, which Local Network privacy doesn't
cover, so the LAN prompt is a manual check) and opens the catalog tab. It never signs in to
Logitech, and it runs with `--use-mock-keychain` so it doesn't touch your
login Keychain. The x64 build runs under Rosetta on Apple silicon; without
Rosetta it is skipped.

None of the tests contact Logitech or a real hub.

## Build the downloads

```sh
cd desktop
npm ci && node node_modules/electron/install.js
npm run dist
(cd dist && shasum -a 256 *.zip *.dmg > SHA256SUMS.txt && cat SHA256SUMS.txt)
npm run test:dist
```

`npm run dist` stages the shell, then runs
`electron-builder --mac --arm64 --x64` with `electron-builder.yml`:

| File | What it is |
| --- | --- |
| `dist/Melodious-<version>-arm64.dmg`, `.zip` | Apple silicon |
| `dist/Melodious-<version>-x64.dmg`, `.zip` | Intel |

- Separate builds per architecture, not one universal app, which would
  double the download.
- Ad-hoc signed (`identity: "-"`, hardened runtime off). No Developer ID,
  no notarisation, so macOS asks before the first launch (see below).
- No update feed, no URL scheme, no login item and no helper beyond
  Electron's own. Update checks (opt-in, `src/updates.js`) read GitHub's
  release list. Install and Restart (`src/self-update.js`) downloads this
  Mac's zip from the release, checks it against the release's
  `SHA256SUMS.txt`, unpacks it next to the app, checks the bundle id,
  version and code seal, swaps the two apps by rename (rolling back on
  failure) and relaunches. It only works for an app in a folder your account
  can write, such as /Applications for an admin. It doesn't work from the
  disk image or a translocated copy, and the app says so.
- `scripts/after-pack.js` gives the main executable its own LC_UUID before
  signing, derived from the bundle id and arch (`scripts/macho-uuid.js`).
  macOS Local Network privacy identifies apps by that UUID, and Electron's
  prebuilt executable has the same one in every app on the same version, so
  without it macOS files Melodious under another Electron app (often the
  development `Electron.app`), never asks, and every LAN connection to the hub
  fails ([electron/electron#55101](https://github.com/electron/electron/issues/55101)).
  The UUID stays the same across versions, so the permission survives updates.
  `Info.plist` carries `NSLocalNetworkUsageDescription` for the prompt.
- electron-builder downloads the Electron zips and its dmg tools on the
  first build and caches them in `~/Library/Caches/electron-builder`.
- The `.zip.blockmap` files are for auto-update, which the app doesn't
  have. Don't attach them to a release.

The app icon is `resources/icon.png`, made from the Melodious artwork:

```sh
sips -s format bmp Android/branding/melodious-icon-source.jpg --out /tmp/melodious.bmp
python3 -I desktop/scripts/build-icon.py /tmp/melodious.bmp desktop/resources/icon.png
```

## Release

The owner publishes releases. A release:

- is tagged `desktop-v<version>` on the same commit as a hub build, so the
  app's bundle matches that commit's `codex_webui`;
- is named "Melodious for macOS <version>";
- has the two `.dmg` and two `.zip` files and `SHA256SUMS.txt` attached,
  with the checksums in the notes (`RELEASE_NOTES.md` is the text);
- says which Electron version it ships.

Electron updates arrive only with a new release of the app.

## Opening an unsigned app

- Finder: Control-click Melodious → Open. Where macOS no longer offers Open,
  use System Settings → Privacy & Security → Open Anyway.
- Terminal: `xattr -dr com.apple.quarantine /Applications/Melodious.app`.

Each build has a new ad-hoc signature, so after an update macOS may ask once
more to let Melodious use "Melodious Safe Storage" in your Keychain. Choose
Always Allow. If you deny it, the app can't read its saved sign-ins: sign in
to the hub and Logitech again.
