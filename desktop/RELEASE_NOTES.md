Melodious for macOS is the Melodious web app in a Mac window, plus one thing the hub's own page can't do: sign in to your Logitech account and pull a device's codes from Logitech's catalog. Your Logitech sign-in stays on your Mac; the hub never sees it.

## Downloads

| File | What it is |
| --- | --- |
| `Melodious-1.3.0-arm64.dmg` | Apple silicon (M1 and later) |
| `Melodious-1.3.0-x64.dmg` | Intel |
| `Melodious-1.3.0-arm64.zip`, `Melodious-1.3.0-x64.zip` | The same apps, zipped |
| `SHA256SUMS.txt` | SHA-256 checksums of the four files |

Needs macOS 13 or later and a hub running Melodious 1.2.0 or newer. The app carries this release's web app, and its Touch & HA controls editor needs hub software 1.2.0; catalog import needs the hub's catalog route (an older hub says "update the hub"). **Update hub…** works on any hub the installer can reach, and brings it to 1.3.0. The app ships Electron 45.0.0 (Chromium 156).

## Install

1. Open the `.dmg` for your Mac and drag Melodious to Applications (or unzip the `.zip`).
2. The app isn't signed with an Apple Developer ID, so macOS asks before the first launch:
   - Finder: Control-click Melodious → Open. Where macOS no longer offers Open, use System Settings → Privacy & Security → Open Anyway.
   - Or in Terminal: `xattr -dr com.apple.quarantine /Applications/Melodious.app`
3. macOS asks whether Melodious may find and connect to devices on your local network. Choose **Allow**: without it the app can't reach the hub. (Change it later in System Settings → Privacy & Security → Local Network.)
4. Melodious looks for your hub on the network, or you type its address. If your hub has a sign-in, enter it once; it's kept encrypted in your Keychain.

## What's new in 1.3

- **Update checks (opt-in):** the app asks once whether to check GitHub for new releases. If you say yes, it checks once a day and tells you when a newer app or hub is out. **Check now** in Settings → Updates checks right away.
- **Install and Restart:** the app downloads a new version from this repository's GitHub releases, checks it against the release's `SHA256SUMS.txt`, replaces itself and relaunches. Your settings and sign-ins stay.
- **Update hub…:** when a newer hub release is out, the app updates the hub for you over SSH with the installer's key (the newest `~/.ssh/harmony_owner_*`) and your `~/.ssh/known_hosts`. It sends only the files that changed and does the installer's steps on the hub: copies in RAM, a handoff backup, a health check, and the old files put back if the check fails.
- **The web app from hub 1.3.0:** System shows the hub's Melodious version and points to the installer for updates.

## What's new in 1.2

- **The web app from hub 1.2.0**, including the Touch & HA controls editor:
  - set a Harmony Touch's on-screen buttons, hard keys and gestures for each activity, with any device, including Home Assistant ones;
  - choose how a key acts when held: Standard, One-shot (fires once, however long you hold) or a separate hold command;
  - the activity setup keeps extra keys, holds and gestures it didn't create when you save.
- **Home Assistant devices** added by the [ha-melodious](https://github.com/schlambos/ha-melodious) integration show up with their own Touch screens.

## What's in 1.1

- **The web app:** Remote, Activities, Devices and Settings, from the same bundle the hub serves.
- **Logitech catalog lookup:** Devices → a device → Import codes → Logitech catalog.
  - Sign in with your Logitech account (Google sign-in works) in a separate window.
  - Type the brand and model; the app checks the model name as you type, then Search lists the matches.
  - Download one device's codes, preview them, and import the commands this hub can play. Commands whose IR protocol the hub doesn't have are listed with the reason, not dropped silently.
- **Settings (⌘,):** the hub's address and sign-in, and the Logitech account.

## Privacy

- Logitech tokens stay in the app's background process and are stored encrypted with your Keychain. Sign out deletes them.
- The hub gets only the imported commands. Logitech gets the sign-in, the searches and the one device you download; nothing about your hub.
- No telemetry, no crash upload. If you turn on update checks (the app asks once), it asks GitHub once a day for Melodious's releases; GitHub sees your IP address and the app's version. The app contacts Logitech only when you sign in, type a model, search or download.

## Known limits

- **Slow saves:** with an activity running, a save can take up to two minutes. If the hub still hasn't finished, the app says so; reload a minute later to check before saving again.
- **Updates:** when a new version is out (if you turn on checks), Install and Restart downloads it from GitHub, checks it and replaces the app. It needs the app in a folder you can write, such as Applications. Each build has a new signature, so after an update macOS may ask once more to let Melodious use "Melodious Safe Storage" in your Keychain. Choose Always Allow.
- **Protocols:** catalog codes import only if the hub already has their IR protocol. The others are listed as skipped.
- **Sign-in:** Google sign-in is tested. Logitech email-and-password sign-in uses the same page but hasn't been run.
- **Logitech's service:** this uses your own Logitech account. If Logitech closes this path, IRDB search, code files and learning still work.

See the [README](https://github.com/schlambos/harmony-hub-control#the-macos-app) for details and screenshots.
