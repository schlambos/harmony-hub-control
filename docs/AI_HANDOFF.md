# AI Handoff

You are working on the Harmony Hub Control post-root runtime.

## Goal

Improve and maintain the local web UI and supporting hub services for an
already rooted Logitech Harmony Hub.

## Important Boundaries

- This repository is not the rooting tool.
- Do not add LAN or USB rooting material here.
- Do not include private keys, tokens, MQTT passwords, Home Assistant tokens,
  firmware dumps, or hub backups.
- The web UI intentionally has no HTTP authentication right now. Treat it as a
  trusted-LAN-only tool.
- The installer expects root SSH to already work.

## Main Files

- `payload/source/codex_webui.c`: single-binary web server and front-end assets.
- `payload/activity/codexactivity.lua`: fail-closed local activity resource
  transaction and paired-remote configuration refresh.
- `payload/mqtt/codexmqtt.lua`: Home Assistant MQTT bridge.
- `payload/scripts/init.sh`: hub boot startup for local services.
- `payload/scripts/recovery_ap.sh`: reset-button recovery AP flow.
- `payload/scripts/netservicestarter.lua`: local service starter that reads
  `/data/codex/cloud_blocker.conf`, blocks Logitech background tasks, and
  replaces the paired remote's resource/sync API handlers with local-only
  implementations.
- `payload/scripts/offline_egress_guard.sh`: reversible route guard that removes
  WAN egress while retaining the Hub's LAN and multicast routes.
- `install_webui.ps1`: Windows SSH uploader/installer.
- `install_webui.py`: Linux/macOS Python SSH uploader/installer.
- `restore_backup.ps1`: rollback helper.

## Runtime Paths On Hub

```text
/data/codex/bin/codex_webui
/data/codex/bin/codex_hbus
/data/codex/bin/codex_hal_ltcp
/data/codex/bin/codex_dhcpd
/data/codex/bin/codex_portal
/data/codex/init.sh
/data/codex/offline_egress_guard.sh
/data/codex/recovery_ap.sh
/data/codex/hub_id
/data/codex/cloud_blocker.conf
/data/codexmqtt/config.json
/pkg/codexactivity/codexactivity.lua
/pkg/codexmqtt/codexmqtt.lua
/usr/sbin/dropbear
/usr/sbin/dropbearkey
/etc/init.d/rcS.local
```

## Current Feature Notes

- IR import sources should stay separate in the UI, with an `All databases`
  option.
- Unsupported IR database rows should be visible with enough detail to debug
  parser coverage.
- Flipper parsed protocols currently include `RC5`, `RC6`, `SIRC`, `SIRC15`,
  and `SIRC20` conversion to raw timing.
- Learned IR signals should be testable before saving.
- The IR sweep page should favor fast staging in browser memory and hub-side
  batch sends that can be stopped.
- Bluetooth HID keystroke accuracy matters. Prefer the included FIFO runtime
  (`/data/codex/bin/codex_bthid_keyboard`, symlinked as
  `/cache/bin/bthid_keyboard`) for text; it emits complete press/release frames
  per key and avoids long key-held repeats.
- MQTT should publish enough state for Home Assistant debugging, including IP
  address and bridge health.
- Cloud blocker defaults to enabled. Exact value `1` removes the WAN default
  route, preserves LAN/multicast routing, blocks cloudapi, PubNub, and
  package-manager tasks, and makes `proxy.resource?get`,
  `proxy.resource?put`, and `setup.sync*` local-only. Value `0` restores the
  saved WAN route and delegates those handlers to firmware; reboot or network
  reconnect is still required to start cloud background workers.
- Activity writes must stay offline. The web UI talks to `codexactivity.lua`
  through `/var/volatile`; that plugin must fail closed when the cloud blocker
  is inactive and must not use the firmware resource proxy, sync task, offline
  queue, session, or a network socket.
- Activity edits are a three-resource transaction: `ActivityList` owns the
  activity/roles, `MapList` owns paired-remote buttons, and `FunctionList` owns
  the generated control groups. Every activity must have two compatible remote
  surface maps and exactly one `ActivityFunctionMap`. Activities with a
  Bluetooth `KeyboardTextEntryActivityRole` also require a third map, the
  firmware Bluetooth keyboard/HID map `16420Activity<ActivityId>`. Validate
  references to both activities and current devices before saving.

## Verification Checklist

After changing web UI or runtime behavior:

1. Deploy with `install_webui.ps1` on Windows or `python3 install_webui.py` on Linux/macOS.
2. Open `http://<hub-ip>:8080/`.
3. Check Dashboard, Activities, IR Devices, IR Sweep, Bluetooth, MQTT, Wi-Fi,
   Backup, and System sections.
4. Confirm no browser auth prompt appears.
5. Import a small IR database file and verify supported/unsupported counts.
6. Send one known-good IR command.
7. If Bluetooth changed, pair and send a short exact text script.
8. If MQTT changed, verify discovery and state topics in Home Assistant.
9. Tail `/cache/codex-init.log` and `/data/codex/ir-events.log`.
10. Confirm rollback can find the newest backup.
11. If Activities changed, verify `tools/activity_offline_guard.sh`, confirm the
    blocker remains enabled, confirm the routing table has LAN and multicast
    routes but no default route, confirm no offline-queue entry was created,
    exercise guarded `proxy.resource?put` and `setup.sync`, and inspect
    `harmony.engine?config` for the expected control-group count.
