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
- Activity button maps, device roles, selected inputs, power on/off ordering,
  per device power on delays, and press/long press/double press maps are all
  editable offline from the web UI.
- Activity identities (button map IDs and physical button IDs) are allocated
  locally. There is no cloud allocator in offline mode.
- Offline mode makes the Hub LAN-only, serves paired-remote resource reads from
  local storage, acknowledges remote resource writes without cloud mutation,
  and prevents the handset's normal `setup.sync` flow from replacing locally
  owned activity resources with an older Logitech configuration.
- A paired physical Harmony remote can start and stop activities and control IR
  and Bluetooth devices after an activity starts.
- Bluetooth pairing is completed on the LAN with a local pairing agent,
  including Secure Simple Pairing confirmation and local link key storage.
  Pairing stays available for up to ten minutes or until a stable bond exists.
- The hub can present itself as a Bluetooth HID keyboard to a target such as an
  Android TV or NVIDIA SHIELD. IR and Bluetooth devices can be mixed in one
  activity.
- Direct Bluetooth HID report and connect calls are guarded so they refuse to
  run unless the expected native target is connected. This prevents a firmware
  HAL crash.
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

## Paired Remote Requirements

Hard requirements for a physical Harmony remote that starts activities and
sends IR or Bluetooth commands. Fail any of these and the remote misbehaves
even when every hub side check passes.

### No action-less buttons in activity maps

Activity button maps must not contain action-less buttons. A button is
action-less when its `ButtonAction`, `ButtonLongPressAction`, and
`ButtonDoublePressAction` are all null.

The hub tolerates action-less buttons and silently drops them, so every hub
side check still passes. The paired remote does not. Starting an activity whose
map contains one makes the remote briefly show "starting activity", return to
its home screen, and stop responding to every button until it is power cycled.

Genuine Logitech configurations contain zero action-less buttons across all
button maps. Their activity map button counts vary (15 to 54) because only
buttons that can be driven are included. Maps are never padded to a fixed size.

The editor now prunes action-less buttons and `validateGraph` rejects them.
Pruning is scoped to activity maps. A root button map legitimately ships
action-less shortcut buttons; activity selection and power off work through it.

### Bluetooth devices need `IsKeyboardAssociated` false

A Bluetooth device controlled from the physical remote must have
`IsKeyboardAssociated` set to false in `DeviceList.json`. With it true, the
remote reports "you have to use the Harmony App to pair this device" and
transmits nothing for that device.

This is hub resource state, not repository state, so it is not carried by an
install.

### Positive unique activity map identities

Activity button maps require positive unique identities. Every activity button
map needs a positive `ButtonMapId-` and every physical button a positive unique
`ButtonId`, with `ButtonState` set to 1. Omitted or zero values are never
allocated later in offline mode. The trailing dash in `ButtonMapId-` is part of
the key name, matching the `Id-`, `ActivityId-`, and `DeviceId-` convention used
throughout the Hub's resource JSON.

### Slow devices need an explicit power on delay

Set `NextDevicePowerOnDelay` in milliseconds on the role for that device. The
engine appends the delay immediately after that device's power on command and
before the entire input phase, so a slow amplifier or soundbar is awake before
its input command is sent.

Because input commands run in role order, placing the delay on the last powered
device also makes that device's input the final command in the sequence, which
overrides an HDMI CEC input change triggered by a display switching inputs
earlier in the same sequence.

## Repository Layout

```text
.
  Install_Harmony_Control.cmd
                           Double-click post-root installer for Windows
  install_webui.ps1        Windows installer for rooted hubs with SSH
  install_webui.py         Linux/macOS Python installer for rooted hubs
  restore_backup.ps1       Restores the installer's hub-side backup
  Dockerfile               One-time installer container image
  compose.yaml             Compose example for installer and web proxy
  .dockerignore            Docker build context exclusions
  .env.example             Example environment variables for Compose
  UNRAID.md                Unraid deployment procedure and safety notes
  CONTRIBUTING.md          Contribution notes
  UPSTREAM_REVISION        Tracked upstream revision marker
  docker/
    manager.py             Installer and proxy manager service
    tests/test_manager.py  Manager unit tests
  unraid/
    harmony-hub-control.xml
                           Unraid XML template
  payload/
    bin/
      codex_webui          Embedded web UI binary
      codex_bthid_keyboard Bluetooth HID keyboard runtime
      codex_bt_pair_agent  Local Bluetooth pairing agent (SSP confirm, link key,
                           full HID control report the stock handler truncates)
      codex_hal_ltcp       HAL LTCP helper
      codex_hbus           HBus helper
      codex_portal         Portal helper
      codex_dhcpd          DHCP helper for recovery AP
      dropbearmulti        Dropbear multi-binary
      FILES                Shipped binary file list
      MANIFEST.txt         Binary checksum manifest
    source/
      codex_webui.c        Web UI C source
      codex_bthid_keyboard.c
                           Bluetooth HID keyboard C source
      codex_bt_pair_agent.c
                           Local Bluetooth pairing agent C source
      codex_hal_ltcp.c     HAL LTCP C source
      codex_hbus.c         HBus C source
      codex_portal.c       Portal C source
      codex_dhcpd.c        DHCP helper C source
      activity_ui_assets.h Embedded activity UI assets header
      remote_skin_jpg.h    Embedded remote skin JPEG header
    scripts/
      init.sh              Hub-side init entry
      netservicestarter.lua
                           Patched connect server task; serves paired remote
                           resource reads locally and blocks cloud tasks
      offline_egress_guard.sh
                           Removes a WAN default route; keeps LAN and multicast
      recovery_ap.sh       Recovery access point helper
      rcS.local            Local rcS hook
      dropbear             Dropbear wrapper
      dropbearkey          Dropbear key wrapper
    activity/
      codexactivity.lua    Fail-closed offline activity resource writer
    mqtt/
      codexmqtt.lua        MQTT bridge Lua plugin
    web/
      activity-ui.css      Activity editor CSS source
      activity-ui.js       Activity editor JavaScript source
  tools/
    embed_activity_ui.sh   Embeds web assets into the web UI binary
    activity_graph_repair.mjs
                           Dry run or apply repair across all activity graph
                           resources (identity allocation, action-less pruning)
    activity_ui_model_smoke.mjs
                           Activity editor model tests
    activity_json_semantic_smoke.sh
                           Activity JSON semantic smoke check
    activity_offline_guard.sh
                           Offline guard smoke check
    bluetooth_device_bridge.mjs
                           Clones a working Bluetooth device profile and its
                           maps onto a target address
    bluetooth_hid_smoke.sh Bluetooth HID guard smoke check
    ir_database_smoke_test.mjs
                           IR database parser smoke test
    chrome_ui_smoke.mjs    Chrome UI smoke test
    hbus_notification_smoke.py
                           HBus notification smoke test
  build/
    build_harmony_tools_kali.sh
                           Linux toolchain path for the full binary set
  docs/
    AI_HANDOFF.md          AI handoff notes
    API.md                 Script and integration API
    BUILD.md               Build notes
    GITHUB_SETUP.md        GitHub setup notes
    SECURITY.md            Security notes before sharing the repository
  examples/
    mqtt-config.example.json
                           Example MQTT bridge config
```

The shipped binaries target the Harmony Hub's MIPS big-endian Linux userspace.
No build server is required to install the current payload.

## Activity Graph Maintenance

`tools/activity_graph_repair.mjs` repairs activity graph resources on a live
hub. Without `--apply` it is read only and prints the proposed repair.

It reports allocated map IDs, allocated button IDs, `ButtonState` corrections,
normalized sequences, and pruned action-less buttons, both per map and as
totals. The tool is idempotent: a second run against its own output reports
zero changes.

Read only:

```bash
node ./tools/activity_graph_repair.mjs --base-url http://<hub-ip>:8080
```

It can write proposed `MapList` and `FunctionList` to files with `--output-map`
and `--output-functions` for review before applying.

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
2. Rebuild MIPS binaries only when native source changes. MIPS binaries are
   built with Zig as a cross compiler. Web UI assets are embedded into
   `codex_webui`, so any change to `payload/web/activity-ui.js` requires
   regenerating the embedded header and rebuilding the binary:

   ```bash
   sh tools/embed_activity_ui.sh
   zig cc -target mips-linux-musleabi -Os -static -s -I payload/source -o payload/bin/codex_webui payload/source/codex_webui.c
   ```

   The result must be `ELF 32-bit MSB executable, MIPS, MIPS32 rel2, statically
   linked, stripped`. `build/build_harmony_tools_kali.sh` is the Linux toolchain
   path for the full binary set.
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

Activity editor model tests:

```bash
node ./tools/activity_ui_model_smoke.mjs
```

Offline guard check:

```bash
sh tools/activity_offline_guard.sh
```

Activity JSON semantic check:

```bash
sh tools/activity_json_semantic_smoke.sh
```

Bluetooth HID guard check:

```bash
sh tools/bluetooth_hid_smoke.sh
```

Action-less button audit. Fetch the live activity config and confirm no activity
button map contains a button whose `ButtonAction`, `ButtonLongPressAction`, and
`ButtonDoublePressAction` are all null:

```bash
curl -s "http://<hub-ip>:8080/api/activity-config" | node -e '
let d=""; process.stdin.on("data",c=>d+=c); process.stdin.on("end",()=>{
  const j=JSON.parse(d);
  const maps=(j.mapList && j.mapList.ButtonMaps) || [];
  let bad=0;
  for (const m of maps) {
    if (!String(m.__type||"").includes("ActivityButtonMap")) continue;
    for (const b of (m.Buttons||[])) {
      if (!b.ButtonAction && !b.ButtonLongPressAction && !b.ButtonDoublePressAction) bad++;
    }
  }
  console.log(bad===0 ? "ok: no action-less activity buttons" : "fail: "+bad+" action-less activity buttons");
  process.exit(bad===0?0:1);
});
'
```

The check is scoped to `ActivityButtonMap` on purpose. A root button map ships
action-less shortcut buttons and must not be reported as a failure.

```text
ok: no action-less activity buttons
```
