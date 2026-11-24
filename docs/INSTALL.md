# Install, update, turn off and roll back

The full reference for installing Melodious on a rooted Harmony Hub,
updating it, turning it off and back on, and rolling back an update.
The [README](../README.md#install-update-and-roll-back) has the short version;
the guided desktop Setup Wizard is in [SETUP_GUIDE.md](SETUP_GUIDE.md)
(Linux Desktop app and Setup Wizard: **Not fully tested, needs
confirmation**).

## Before you start

| Requirement | Details |
| --- | --- |
| Harmony Hub | Rooted with [harmony-hub-root](https://github.com/Ripthulhu/harmony-hub-root), bundled in [`tools/hub-root/`](../tools/hub-root/README.md) (see below), or by the desktop [Setup Wizard](SETUP_GUIDE.md). The installer itself doesn't root hubs. |
| SSH key | The root tool's private key, `harmony_owner_*`, in `~/.ssh` (`%USERPROFILE%\.ssh` on Windows). A hub rooted with a different tool (the standalone harmony-hub-root, harmony-ng) holds that tool's key in its `authorized_keys` instead: pass it with `--key-path` (PowerShell: `-KeyPath`). If ssh answers `Permission denied (publickey)`, that mismatch is why. |
| Hub ID | The numeric Hub ID the root tool prints. Don't guess it: Melodious sends it with every command to the hub's engine. |
| Free flash | About 1.6 MB of the hub's 5 MB data flash for the first install, or about 1.2 MB when the root tool's Dropbear can be reused. Each later web app update needs about 0.65 MB free (the first one that adds BusyBox, about 0.25 MB more). The installer measures it and stops before writing anything if there isn't enough (see [If the hub's flash is full](#if-the-hubs-flash-is-full)). |
| Install computer | Windows with PowerShell, Linux or macOS with Python 3.10 or newer, or a Docker or Unraid host. The installer needs only `ssh`, not `scp` or `sftp`. |
| Network | A trusted home network. The web app is plain HTTP. |

Root the hub first with the bundled root tool. It is in this repository,
not in the release zip, so clone it and run:

```bash
python3 tools/hub-root/run_harmony_hub_tool.py --action lan-root --hub-host <hub-ip>
```

Keep the SSH key it creates (`harmony_owner_*` in `~/.ssh`) and the
numeric Hub ID it prints ([tools/hub-root/README.md](../tools/hub-root/README.md)).
The hub needs its initial setup first; for a factory-fresh hub with no
Logitech account, follow [FRESH_HUB_ACTIVATION.md](FRESH_HUB_ACTIVATION.md)
instead.

Then download `melodious-hub-<version>.zip` from the
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
   - If harmony-hub-root left its `dropbearmulti` on the hub, the
     installer hard-links it instead of writing a second copy. Either
     build of the same Dropbear counts: the one Melodious and its bundled
     root tool (`tools/hub-root`) ship, with the unloaded `.pdr` section
     stripped, or the same build with only a plain strip, which earlier
     releases and harmony-hub-root ship and older hubs run.
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
| `--hub-host` (`--host`), `--key-path`, `--port`, `--ssh-user` | `-HubHost`, `-KeyPath`, `-Port`, `-SshUser` | How to reach the hub over SSH: its address, the private key (default `~/.ssh/harmony_owner_*`), port and user. |
| `--hub-id` | `-HubId` | The Hub ID. Without it, the installer reads it from the hub, then from the root tool's files in `~/.harmony-hub/`. |
| `--no-prompt` | `-NoPrompt` | Fails instead of asking for a missing value. |
| `--mqtt-broker`, `--mqtt-port`, `--mqtt-user`, `--mqtt-password`, `--mqtt-base-topic`, `--mqtt-discovery-prefix`, `--mqtt-client-id`, `--mqtt-disabled` | `-MqttBroker` … `-MqttDisabled` | Set up the MQTT bridge. Without them, an upgrade keeps the hub's MQTT settings. |
| `--no-apply-cloud-restart` | `-NoApplyCloudRestart` | Skips the reboot after the cloud-blocker files or an engine plugin (`codexactivity.lua`, `codexmqtt.lua`) change. Without that reboot the engine keeps running the old plugin. |
| `--skip-cloud-suppression` | `-SkipCloudSuppression` | Leaves the hub's `netservicestarter.lua` as it is. With a clean install, it also writes the cloud blocker as off. It doesn't undo an existing install; use `--turn-off` for that. |
| `--turn-off` | `-TurnOff` | **Experimental** (not yet validated on live hardware): writes `/etc/melodious-off`, restores the internet route, and restarts the hub into Logitech's stock runtime so the Harmony app can manage it again. Supports `--preflight-only`. See [Turn Melodious off and on](#turn-melodious-off-and-on). |
| `--turn-on` | `-TurnOn` | **Experimental** (not yet validated on live hardware): removes `/etc/melodious-off` and restarts the hub back into Melodious with the cloud blocker and your saved settings restored. Supports `--preflight-only`. |
| `--i-understand-experimental` | `-IUnderstandExperimental` | Acknowledges the EXPERIMENTAL `--turn-off`/`--turn-on` warning. Required for scripted (`--no-prompt`) turn-off/on runs; interactive runs acknowledge it in the confirmation prompt. `--preflight-only` never needs it. |
| `--force` | `-Force` | With `--turn-off`, overrides the preflight refusals for duplicate remotes without a screen, a missing Wi-Fi `network={` block, or a local-account / unprovisioned hub. Never overrides the SSH survival check. |
| `--remove-root-tool-leftovers` | `-RemoveRootToolLeftovers` | Accepted for compatibility; no longer needed. Dead legacy data is removed automatically before installing (see below). |
| `--skip-flash-check` | `-SkipFlashCheck` | Installs even when the measured free flash looks too small. If flash really runs out, the install still stops with nothing in use changed. |
| `--multi-remote on` / `off` / `force-off` | `-MultiRemote on` / `off` / `force-off` | Lets the hub keep more than one remote without a screen of the same model, such as two Smart Controls; they share one button setup. `off` restores the stock one-per-model rule. It's refused while two remotes of one model are paired (unpair the extra ones first), and together with `--no-apply-cloud-restart` while the multi-remote `hal` runs. `force-off` (`-MultiRemote force-off`) turns it off without asking the radio, for a radio that stopped answering. The installer reboots when the files change or the running `hal` isn't the one asked for, then checks it. The web app's Settings → Experimental switch does the same. Without it, an upgrade leaves the setting as it is. See [MULTI_REMOTE.md](MULTI_REMOTE.md). |
| `--two-screen on` / `once` / `serial` / `serial-once` / `off` / `force-off` | `-TwoScreen on` / `once` / `serial` / `serial-once` / `off` / `force-off` | Lets the hub keep two remotes with a screen and serve both at once; they share one setup. `once` runs it for the next boot only, which is the way to try it. `serial` is the fallback mode. `off` (or `force-off`) restores the stock `hal`; remotes already paired stay paired, so unpair all but one afterwards. The installer reboots when the setting or the running `hal` changes, then checks it. See [TWO_SCREEN_REMOTES.md](TWO_SCREEN_REMOTES.md). |
| `--ntp-server <host[,host]>` | `-NtpServer <host[,host]>` | Chooses custom NTP servers for the hub's clock, instead of the default public ones (up to 3 host names or IPv4 addresses, e.g. `ntp.example.com`). When set, only these are asked. `""` goes back to the defaults. Omitted: unchanged. The same setting is in System -> Custom NTP server. |

`python3 install_webui.py --help` lists every option.

## If the hub's flash is full

Everything Melodious writes, and everything the hub keeps, shares one
5 MB flash partition. The preflight report shows the free flash
(`flash_free_bytes`) and the estimate for this run
(`flash_required_bytes`). If the estimate doesn't fit, the run stops
with `BLOCKED_CAPACITY` before writing anything.

- **Dead legacy data (removed automatically).** Before the capacity
  check, every install removes what Melodious or its rooting tools left
  behind and nothing reads any more: harmony-hub-root's staging folders
  (`/data/codexssh_*_stage`, about 0.5 MB each) and, once SSH runs
  Melodious's Dropbear, its spare copy in `/data/rootssh/bin`; binaries
  an earlier Melodious release installed that this one no longer ships
  (identified by the hub's own `/data/codex/bin/MANIFEST.txt` and the
  MD5 it records); Melodious backup generations past the newest three
  per kind under `/data/codex/resource-backups` and
  `/data/codex-backups`; and temp files from interrupted installs
  (`<dest>.codex-new` / `.codex-rb`, incomplete handoff folders). The
  log lists each removal (`removed_legacy`). Your resources
  (`/data/resources`), the Dropbear SSH is running on, stock firmware
  files, and the Extender package below are never removed.
- **The Harmony Hub Extender package.** A hub that has ever had a
  Harmony Hub Extender (Zigbee/Z-Wave) connected keeps Logitech's
  runtime for it in `/pkg/moosehead`: about 5 MB, which can leave too
  little room for Melodious even with the backups and logs cleared.
  The preflight reports it and its size (`extender_package`). Melodious
  never removes it, because that breaks the devices behind the
  Extender. If you no longer use an Extender, copy the folder off the
  hub first, then delete it over SSH.
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

**Reinstall / repair hub software…** (Settings → Updates, and the
Melodious menu on a Mac or the File menu on Windows and Linux — Desktop app
on Linux: **Not fully tested, needs confirmation**) puts hub
software back on the hub whatever version it runs:

- You pick the source: the latest GitHub release, or a
  `melodious-hub-<version>.zip` on your computer. The app shows the hub's
  version next to the source's before anything changes.
- **Repair** checks every file on the hub and replaces only the ones that
  differ; when they all match, nothing is written. **Reinstall All Files**
  sends and rewrites every file, then restarts the hub.
- A source older than the hub needs an explicit **Downgrade**. When both
  report the same version but files differ, the app lists them and asks
  first, because a hub built from source keeps the last release's number.
- It is the same SSH install as **Update hub…**, with the same key, checks
  and rollback. The zip must carry every file this version of the app
  installs, so an older release's zip is refused.

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

## If the web app answers 502, or a hub on another VLAN goes quiet

These two look like a dead hub and usually aren't.

- **HTTP 502 in the web app, on every page.** The web app is running,
  but it can't reach the hub's engine. The usual cause is a missing
  Hub ID: the engine commands carry it, and without
  `/data/codex/hub_id` on the hub every one fails (the answer's body
  says "Hub ID is missing"). That happens when an install didn't
  finish — run the installer again with the numeric Hub ID the root
  tool printed. A 502 on one action only (starting an activity,
  pairing a remote) means that one engine or radio call failed; the
  message says which.
- **HTTP 404 from `curl`.** The hub's addresses are lowercase and
  case-sensitive: `http://<hub-ip>:8080/api/activity-state` works,
  `/API/activity-state` does not.
- **The hub stops answering from another VLAN when the cloud blocker
  is on.** The blocker removes the hub's default route, so the hub
  can't reach the internet — and, without help, couldn't answer
  anything off its own subnet either. Melodious keeps routes to the
  private ranges (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16) through
  your router, so a phone, Home Assistant or MQTT broker on another
  private VLAN still reaches the hub and gets its replies. What does
  not cross a VLAN is discovery: the multicast the apps use to find
  hubs stays on one subnet, so from another VLAN type the hub's
  address in by hand. Clients that reach the hub from a public
  address (a VPN that hands out public IPs, say) get no reply while
  the blocker is on, by design. The hub's clock sync has the same
  shape: point it at a time server on your own network in
  **System → Custom NTP server** if the defaults can't be reached.

## Turn Melodious off and on

> **EXPERIMENTAL — not yet validated on live hardware.** The off/on mechanism
> is implemented and fully tested off-hub, but the round trip the feature
> exists for — the stock Harmony app actually reclaiming the hub after
> `--turn-off` — is unproven on a real hub. Back up first (**Download full
> backup** below) and proceed at your own risk. Both installers print this
> warning as a banner before doing anything, fold it into the interactive
> confirmation, and refuse scripted `--no-prompt` runs without
> `--i-understand-experimental` (`-IUnderstandExperimental`).

To hand the hub back to Logitech's cloud and the Harmony app without
touching firmware or erasing Melodious's files, turn Melodious off:

```bash
python3 install_webui.py --hub-host <hub-ip> --turn-off
```

```powershell
.\install_webui.ps1 -HubHost <hub-ip> -TurnOff
```

Before you do, download a backup on the Backup page (**Download full
backup**): the Harmony app's cloud copy of your setup replaces what is
on the hub at the next sync, so devices and activities you added only in
Melodious go away. Add `--preflight-only` (`-PreflightOnly`) to inspect
every gate without writing anything.

### What `--turn-off` checks and does

Melodious uses a single state file, `/etc/melodious-off`, checked at the
top of the boot script (`rcS.local`) and the Lua network starter
(`netservicestarter.lua`), with defense-in-depth guards in every service
script and `/pkg` plugin. None of your Melodious settings
(`cloud_blocker.conf`, `two_screen.conf`, `multi_remote.conf`,
`usb_eth.conf`, `timezone.conf`, `ntp_servers.conf`, `activity-restrictions.json`), `/pkg`
plugins, or patched `hal` copies are deleted or edited.

1. **Preflight safety gates (before any write):**
   - **SSH survival (always enforced):** checks `/etc/init.d/rcS`,
     `/etc/tdeenable`, `/usr/sbin/dropbear` and its target binary, a
     non-empty `/home/root/.ssh/authorized_keys`, and either a readable
     non-empty `/etc/dropbear/dropbear_rsa_host_key` or a working
     `dropbearkey`.
   - **Paired remotes:** queries `rf.info`. Refuses (unless `--force`) if
     two remotes without a screen of the same model (`16414`, `16422`,
     `16423`) are paired, because the stock `hal` hangs its radio on
     duplicates — unpair the extra remote in Settings → Remotes first.
     Warns if two remotes with a screen (`16417`) are paired (the stock
     `hal` serves one at a time).
   - **Wi-Fi survival:** refuses (unless `--force`) if
     `/etc/wpa_supplicant.conf` has no `network={` block, since USB
     Ethernet stays off when Melodious is off. If wired Wi-Fi-off mode is
     active, `--turn-off` reconnects `ath0` before restarting; if you
     connected to `--hub-host` over the USB Ethernet address, it switches
     to the hub's Wi-Fi IP after the restart and prints that address.
   - **Local-account / unprovisioned hubs:** inspects
     `/data/luaworks/provision/preferences` and refuses (unless
     `--force`) if the hub is unprovisioned or uses a local account
     (`"authToken": "local"` from [FRESH_HUB_ACTIVATION.md](FRESH_HUB_ACTIVATION.md)).
     Re-provisioning a hub onto a Logitech account in the Harmony app
     runs stock `cleanDataFolder("/data")`, which wipes `/data/codex` and
     root SSH; keeping the marker at `/etc/melodious-off` avoids
     stranding the hub cloud-blocked, and the gate warns before you lose
     root SSH.
2. **Older-install bootstrap:** if the hub runs an older Melodious build
   whose `rcS.local` and `netservicestarter.lua` don't check
   `/etc/melodious-off` yet, `--turn-off` updates those gate-aware text
   scripts first (verified `.codex-new` copies + a `webui-handoff-*`
   backup, newest 3 kept). On an already-current hub it writes only
   `/etc/melodious-off` (~25 bytes).
3. **Restart and verification:** restores the default internet route
   through `offline_egress_guard.sh`, restarts the hub, confirms the
   reboot happened (`boot_id` / `btime` / uptime), and verifies that
   `/etc/melodious-off` is present, `codex_webui`, the egress guard, the
   USB Ethernet worker and `codex_androidtv` are all stopped,
   `/usr/bin/hal` is not bind-mounted (stock `hal`), and the Touch sync
   probe line is gone from `/etc/hosts`.

### Taking the hub back in the Harmony app

1. Put your phone on the same Wi-Fi network as the hub and open the
   official Harmony app, signed into the Logitech account the hub was
   set up under.
2. Connect to the hub when it appears on the local network.
3. Run **Sync** in the Harmony app (Menu → Harmony Setup → Sync, or the
   remote's Sync) and let it finish to **100%**, then start an activity
   to confirm the cloud configuration reconciled cleanly.

### Turning Melodious back on

While `/etc/melodious-off` exists, a normal installer run and the macOS
app's **Update hub…** both refuse to run, so automated setups (such as
Docker with `INSTALL_MODE=always`) cannot turn Melodious back on by
accident. Pass `--turn-on` (`-TurnOn`) explicitly:

```bash
python3 install_webui.py --hub-host <hub-ip> --turn-on
```

```powershell
.\install_webui.ps1 -HubHost <hub-ip> -TurnOn
```

`--turn-on` checks that any configured two-screen `hal` copy still loads
on the hub, unlinks `/etc/melodious-off` (which needs zero free flash),
restarts the hub, waits for SSH (`:22`) and the web app (`:8080`), and
confirms `codex_webui` and the expected `hal` are running. The cloud
blocker and all your saved Melodious settings take effect again on that
boot; if the Harmony app overwrote your setup while Melodious was off,
restore your saved bundle on the Backup page.

## Rolling back an update

In PowerShell, `restore_backup.ps1` restores these from the newest
handoff backup (what the last installer run replaced), then tells you to
reboot the hub. It goes back one update; to stop running Melodious and
go back to the Harmony app, use `--turn-off` above instead:

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
