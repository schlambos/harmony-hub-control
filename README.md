# Harmony Hub Control

Local web UI and helper runtime for an already rooted Logitech Harmony Hub.

This repository is for post-root device ownership work: the web dashboard, IR
database tooling, Bluetooth HID controls, MQTT/Home Assistant bridge, recovery
AP helpers, and the installer that deploys those pieces over SSH.

It does not contain rooting tools, device compromise notes, private keys, live
MQTT credentials, firmware dumps, or personal backups.

> **Docker / Unraid package:** this snapshot includes a one-time installer
> container, persistent web proxy, Compose example, and Unraid XML template.
> See [UNRAID.md](UNRAID.md) for the deployment procedure and safety notes.

## Current Status

- Web UI runs on `http://<hub-ip>:8080/`.
- HTTP authentication is intentionally disabled for LAN-only use.
- Activities can be created, duplicated, reordered, edited, launched, and
  published to the Hub's paired-remote configuration entirely offline from the
  web UI. Device/input roles and press, long-press, and double-press button maps
  are edited together. Activity control groups in `FunctionList.json` are
  created, repaired, validated, and available in the full-fidelity JSON editor.
- Offline mode makes the Hub LAN-only, serves paired-remote resource reads from
  local storage, acknowledges remote resource writes without cloud mutation,
  and prevents the handset's normal `setup.sync` flow from replacing locally
  owned activity resources with an older Logitech configuration.
- IR devices can be configured from database lookup or manual learning.
- Database import supports IRDB, Flipper-IRDB, and RemoteCentral-style Pronto
  sources.
- Flipper parsed `RC5`, `RC6`, `SIRC`, `SIRC15`, and `SIRC20` entries are
  converted to raw timing replays when possible.
- The IR sweep page can stage large command sets in browser memory, import
  selected commands to the hub, and send them in cancellable batches.
- Bluetooth HID mode can expose the hub as a keyboard-class device and send
  keystroke scripts through the auto-started hub-side FIFO runtime.
- MQTT bridge publishes Home Assistant discovery and exposes hub/device state.
- Recovery helpers can start a local AP workflow from the reset button path.

## Repository Layout

```text
.
  Install_Harmony_Control.cmd
                           Double-click post-root installer for Windows
  install_webui.ps1        Windows installer for rooted hubs with SSH
  install_webui.py         Linux/macOS Python installer for rooted hubs
  restore_backup.ps1       Restores the installer's hub-side backup
  payload/
    bin/                   MIPS binaries shipped to the hub
    scripts/               Init, recovery, Dropbear wrappers, offline enforcement
    activity/              Fail-closed offline activity resource writer
    mqtt/                  MQTT bridge Lua plugin
    source/                C sources for the native helper binaries
    web/                   Readable activity editor CSS/JavaScript sources
  tools/
    embed_activity_ui.sh   Embeds web assets into the single web UI binary
    activity_graph_repair.mjs
                           Dry-run/apply repair for all activity graph resources
    ir_database_smoke_test.mjs
  build/
    build_harmony_tools_kali.sh
  docs/
    AI_HANDOFF.md
    API.md
    BUILD.md
    GITHUB_SETUP.md
    SECURITY.md
  examples/
    mqtt-config.example.json
```

The shipped binaries target the Harmony Hub's MIPS big-endian Linux userspace.
No build server is required to install the current payload.

## Quick Install

Run after the hub has just been rooted with the LAN root tool. The installer
uses your Harmony SSH key. It looks in `.ssh` for a private key whose filename
starts with `harmony_owner_`:

```text
%USERPROFILE%\.ssh\harmony_owner_*
~/.ssh/harmony_owner_*
```

The installer also needs the real numeric Harmony Hub ID for local HBus
commands. If you rooted the hub with `harmony-hub-root`, this is read
automatically from the handoff file under `.harmony-hub`. If the handoff file is
missing, pass the exact value printed by the root tool as `hub_id=...`:

```powershell
.\install_webui.ps1 -HubHost <hub-ip> -HubId <numeric-id>
```

```bash
python3 install_webui.py --hub-host <hub-ip> --hub-id <numeric-id>
```

Do not use a guessed Hub ID; IR, capture, MQTT, and dashboard HBus calls depend
on the real value. The installer does not prompt for a Hub ID interactively,
because guessed numeric values are accepted by the shell but fail against the
hub.

### Windows

Double-click:

```text
Install_Harmony_Control.cmd
```

Enter the hub IP address when prompted. The installer also prompts for MQTT
broker settings; leave the broker blank to install the UI with MQTT disabled for
now.

The installer uses only plain `ssh` and remote `cat` over stdin to copy files.
It does not require `scp`, `sftp`, or `tftp`, which are not available in the
minimal Dropbear SSH environment installed by the root tool.

PowerShell can also be run directly:

```powershell
.\install_webui.ps1 -HubHost <hub-ip>
```

### Linux/macOS

Use the Python 3 installer from the repository root:

```bash
python3 install_webui.py --hub-host <hub-ip>
```

For a non-interactive install with MQTT disabled:

```bash
python3 install_webui.py --hub-host <hub-ip> --key-path ~/.ssh/harmony_owner_<key-name> --mqtt-disabled --no-prompt
```

The installer will prompt for missing values, create a backup on the hub, upload
the runtime, start Dropbear if needed, start the web UI, and write MQTT config
if provided.

By default the installer enables strict offline ownership. It keeps Logitech
cloudapi, PubNub, and package-manager background tasks from starting, removes
the Hub's WAN default route, retains LAN and multicast routes, and replaces the
paired remote's cloud-capable resource/sync handlers with local-only handlers.
Local web, MQTT, Bluetooth, Wi-Fi recovery, discovery, and SSH control continue
to work. Fresh installs reboot once so the guarded handlers are loaded before
handoff. The **System > Cloud blocker** setting changes the egress route
immediately; **Save and reboot** also reloads the handler and task policy.

To stage the setting without the install-time reboot:

```powershell
.\install_webui.ps1 -HubHost <hub-ip> -NoApplyCloudRestart
```

```bash
python3 install_webui.py --hub-host <hub-ip> --no-apply-cloud-restart
```

Open the UI afterward:

```text
http://<hub-ip>:8080/
```

## Rollback

Restore the newest backup created by the installer:

```powershell
.\restore_backup.ps1 -HubHost <hub-ip> -KeyPath "$env:USERPROFILE\.ssh\<root-key-file>"
```

## Development Workflow

Keep changes scoped and reviewable:

1. Edit `payload/source/codex_webui.c` or the relevant payload script/plugin.
2. Rebuild MIPS binaries only when native source changes.
3. Replace the corresponding file under `payload/bin/`.
4. Update `payload/bin/MANIFEST.txt`.
5. Install to a test hub with `install_webui.ps1` on Windows or `install_webui.py` on Linux/macOS.
6. Verify the dashboard, IR import, Bluetooth HID, MQTT, and rollback paths.

Do not commit local secrets, hub backups, firmware dumps, root tooling, or
credentials. See `docs/SECURITY.md` before sharing the repository.

For script and integration control, see `docs/API.md`.

## Useful Checks

Page check:

```powershell
Invoke-WebRequest -Uri "http://<hub-ip>:8080/" -UseBasicParsing
```

Process and checksum check:

```powershell
ssh -i "$env:USERPROFILE\.ssh\<root-key-file>" root@<hub-ip> "ps | grep '[c]odex_webui'; ps | grep '[c]odex_bthid_keyboard'; ps | grep '[d]ropbear'; md5sum /data/codex/bin/codex_webui"
```

Logs:

```powershell
ssh -i "$env:USERPROFILE\.ssh\<root-key-file>" root@<hub-ip> "tail -80 /cache/codex-init.log; tail -80 /data/codex/ir-events.log 2>/dev/null"
```

IR database parser smoke test:

```powershell
node .\tools\ir_database_smoke_test.mjs --sample=24 --per-device=10 --source=all --dry-run
```

Linux/macOS:

```bash
node ./tools/ir_database_smoke_test.mjs --sample=24 --per-device=10 --source=all --dry-run
```

To create test devices and import supported commands without sending IR:

```powershell
node .\tools\ir_database_smoke_test.mjs --sample=8 --per-device=8 --source=all --configure --hub=http://<hub-ip>:8080
```
