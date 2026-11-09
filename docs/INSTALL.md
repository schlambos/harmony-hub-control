# Install, update and roll back

The full reference for installing Melodious on a rooted Harmony Hub,
updating it, and rolling back. The [README](../README.md#quick-start)
has the short version.

## Before you start

| Requirement | Details |
| --- | --- |
| Harmony Hub | Rooted with [harmony-hub-root](https://github.com/Ripthulhu/harmony-hub-root). Melodious doesn't root hubs. |
| SSH key | The root tool's private key, `harmony_owner_*`, in `~/.ssh` (`%USERPROFILE%\.ssh` on Windows). |
| Hub ID | The numeric Hub ID the root tool prints. Don't guess it: Melodious sends it with every command to the hub's engine. |
| Free flash | About 1.4 MB of the hub's 5 MB data flash for the first install, or about 1 MB when the root tool's identical Dropbear can be reused. Each later web app update needs about 0.65 MB free. The installer measures it and stops before writing anything if there isn't enough (see [If the hub's flash is full](#if-the-hubs-flash-is-full)). |
| Install computer | Windows with PowerShell, Linux or macOS with Python 3, or a Docker or Unraid host. The installer needs only `ssh`, not `scp` or `sftp`. |
| Network | A trusted home network. The web app is plain HTTP. |

Download `melodious-hub-<version>.zip` from the
[latest release](https://github.com/schlambos/harmony-hub-control/releases/latest)
and unzip it, or clone this repository. From a computer on the same
network:

```bash
python3 install_webui.py --hub-host <hub-ip> --hub-id <hub-id>
```

On Windows, double-click `Install_Harmony_Control.cmd`, or in
PowerShell:

```powershell
.\install_webui.ps1 -HubHost <hub-ip> -HubId <hub-id>
```

The first install turns on the cloud blocker, leaves MQTT off, and
reboots the hub once. Then open `http://<hub-ip>:8080/`. Your existing
activities and devices are there, including any set up with the
Logitech app before rooting.

## What each run does

The first run on a hub writes Melodious's configuration: the Hub ID,
the cloud blocker (on), and the MQTT settings (off, unless you pass the
`--mqtt-*` options). Later runs upgrade in place and keep that
configuration. `--clean-install` writes it from scratch.

Each run:

1. Finds your key: `--key-path`, or else the newest `harmony_owner_*`
   key in `~/.ssh`.
2. Uploads every file to a private folder in the hub's RAM
   (`/var/volatile/codex-install-*`). It checks each MD5 and compares
   it with the installed copy, so unchanged files aren't written.
3. Checks that flash and RAM can hold the change and a rollback.
   - **Flash:** a small probe, `payload/helpers/codex_flash_free`, runs
     from the RAM folder and reports the free flash; it's never
     installed. The installer estimates what the changed files take on
     the hub's compressed flash, with a margin, and stops with
     `BLOCKED_CAPACITY` before writing anything if they don't fit.
   - **RAM:** it copies the files it will change into RAM, then writes a
     handoff backup to `/data/codex-backups/webui-handoff-*`.
4. Writes each changed file next to its target as `<file>.codex-new`
   and verifies it, then renames the copies into place, `codex_webui`
   last.
   - If harmony-hub-root left an identical `dropbearmulti` on the hub,
     the installer hard-links it instead of writing a second copy.
   - If flash runs out anyway, it removes the copies and nothing in use
     changes.
   - If a later step fails, it puts the originals back in reverse order
     and verifies them.
5. Restarts the web app and the Bluetooth keyboard service, registers
   the hub plugins, and waits for the web app to answer.
6. Reboots the hub only if the cloud-blocker files, an engine plugin or the
   multi-remote setting changed.

## Installer options

| Python | PowerShell | What it does |
| --- | --- | --- |
| `--preflight-only` | `-PreflightOnly` | Stages and compares in RAM, prints what would change and a verdict, and writes nothing to flash. |
| `--clean-install` | `-CleanInstall` | Writes the configuration from scratch. |
| `--hub-id` | `-HubId` | The Hub ID. Without it, the installer reads it from the hub, then from the root tool's files in `~/.harmony-hub/`. |
| `--no-prompt` | `-NoPrompt` | Fails instead of asking for a missing value. |
| `--mqtt-broker`, `--mqtt-port`, `--mqtt-user`, `--mqtt-password`, `--mqtt-base-topic`, `--mqtt-discovery-prefix`, `--mqtt-client-id`, `--mqtt-disabled` | `-MqttBroker` … `-MqttDisabled` | Set up the MQTT bridge. Without them, an upgrade keeps the hub's MQTT settings. |
| `--no-apply-cloud-restart` | `-NoApplyCloudRestart` | Skips the reboot after the cloud-blocker files or an engine plugin (`codexactivity.lua`, `codexmqtt.lua`) change. Without that reboot the engine keeps running the old plugin. |
| `--skip-cloud-suppression` | `-SkipCloudSuppression` | Leaves the hub's `netservicestarter.lua` as it is. With a clean install, it also writes the cloud blocker as off. |
| `--remove-root-tool-leftovers` | `-RemoveRootToolLeftovers` | Deletes what harmony-hub-root left behind before installing (see below). |
| `--skip-flash-check` | `-SkipFlashCheck` | Installs even when the measured free flash looks too small. If flash really runs out, the install still stops with nothing in use changed. |
| `--multi-remote on` / `off` / `force-off` | `-MultiRemote on` / `off` / `force-off` | Lets the hub keep more than one remote without a screen of the same model, such as two Smart Controls; they share one button setup. `off` restores the stock one-per-model rule. It's refused while two remotes of one model are paired (unpair the extra ones first), and together with `--no-apply-cloud-restart` while the multi-remote `hal` runs. `force-off` (`-MultiRemote force-off`) turns it off without asking the radio, for a radio that stopped answering. The installer reboots when the files change or the running `hal` isn't the one asked for, then checks it. The web app's Settings → Experimental switch does the same. Without it, an upgrade leaves the setting as it is. See [MULTI_REMOTE.md](MULTI_REMOTE.md). |

`python3 install_webui.py --help` lists every option.

## If the hub's flash is full

Everything Melodious writes, and everything the hub keeps, shares one
5 MB flash partition. The preflight report shows the free flash
(`flash_free_bytes`) and the estimate for this run
(`flash_required_bytes`). If the estimate doesn't fit, the run stops
with `BLOCKED_CAPACITY` before writing anything.

- **harmony-hub-root's leftovers.** The root tool doesn't delete its
  staging folders, `/data/codexssh_*_stage`: about 0.5 MB each, one per
  root attempt. Once Melodious runs SSH, its copy of Dropbear in
  `/data/rootssh/bin` isn't used either. The preflight lists them;
  `--remove-root-tool-leftovers` deletes them before installing. It
  removes the root tool's Dropbear only while SSH runs Melodious's
  copy.
- **Old backups.** `/data/codex-backups` and
  `/data/codex/resource-backups` hold older copies. Download a backup
  first, then delete the ones you don't need over SSH.
- **Updates need room too.** Replacing the web app needs about 0.65 MB
  free while the old and new copies both exist. The installer warns
  when less than that will be left. The macOS app's **Update hub…**
  doesn't measure flash; if it runs out, it stops with nothing in use
  changed.

## Updating

Get the latest release or the latest copy of this repository, and run
the installer again. Or let the macOS app do it: when a newer hub
release is out, Settings → Updates offers **Update hub…**. The Android
app only tells you a hub update is out; it never holds the hub's SSH
key.

How the macOS app's hub update works:

- **Download:** the app fetches the hub zip from the GitHub release,
  checks it against the release's `SHA256SUMS.txt`, and sends only the
  files that differ.
- **Key:** it connects over SSH with the same key as the installer, the
  newest `~/.ssh/harmony_owner_*`, and your `~/.ssh/known_hosts`.
- **On the hub:** a short script does the installer's steps from a RAM
  folder: check every file, copies in RAM, a handoff backup,
  `.codex-new` then rename with `codex_webui` last, then a restart and
  a check that the web app answers. If that check fails, it puts the
  old files back. It reboots when the boot scripts or plugins changed.
  Because it runs on the hub, it finishes even if the Mac drops off the
  network.
- **A new hub** still needs the installer once; the app only updates a
  hub that already has Melodious.
- **Doesn't change:** the hub's settings (the Hub ID, cloud blocker,
  MQTT) and its web routes.

App updates are opt-in. The macOS app is ad-hoc signed; if you turn on
update checks, it can update itself from the GitHub release (checked
against the release's checksums before anything is swapped). The
Android app likewise downloads the release APK and installs it over
itself only when you tap Install, after checking the checksum and the
signing key. Nothing updates until you opt in and confirm. See
[SECURITY.md](SECURITY.md) for how downloads are checked.

## Rolling back

In PowerShell, `restore_backup.ps1` restores these from the newest
handoff backup, then tells you to reboot the hub:

- the boot script;
- `netservicestarter.lua`;
- the SSH wrappers;
- the Hub ID;
- the MQTT settings.

```powershell
.\restore_backup.ps1 -HubHost <hub-ip> -KeyPath "$env:USERPROFILE\.ssh\<key-file>"
```

Backups the hub keeps on its own flash:

| Backups | Folder | Kept |
| --- | --- | --- |
| Resource backups (`YYYYMMDD_HHMMSS`), taken before each write | `/data/codex/resource-backups` | Newest 5 |
| Installer handoffs (`webui-handoff-*`) | `/data/codex-backups` | Newest 3 |

Only folders with those exact names are ever removed.

## Docker and Unraid

The image runs the same installer with settings from environment
variables, then stays up as a small proxy to the hub's web app. See
[UNRAID.md](../UNRAID.md) and `compose.yaml`.
