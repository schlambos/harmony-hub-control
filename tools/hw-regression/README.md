# Melodious Hardware Regression Suite (`tools/hw-regression/`)

A portable, hub-agnostic hardware regression suite that any contributor can run
against **their own** Harmony Hub and paired remotes with zero code edits.

Off-hub emulator and simulator tests prove logic; this suite proves **real
hardware behavior and cross-subsystem interactions** (for example: USB Ethernet
traffic genuinely traversing the wire rather than leaking over Wi-Fi, Android
TV Wake-on-LAN still binding to the active interface under USB Ethernet and the
cloud blocker, Wi-Fi route hand-back on cable loss, and patched `hal` radio
counters across paired remotes).

---

## 1. Quickstart (Clone to First Run)

Requires **Python 3.10+** (standard library only — zero third-party packages)
and OpenSSH (`ssh`) access to a rooted Melodious hub.

1. **Create your local gitignored config:**

   ```sh
   cp tools/hw-regression/config.example.json tools/hw-regression/config.local.json
   ```

2. **Fill in your hub connection in `tools/hw-regression/config.local.json`:**
   - Either set `"ssh_target"` to an `~/.ssh/config` host alias (e.g.
     `"my-harmony-hub"`, in which case `"ssh_key_path"` and `"hub_host"` can be
     left blank and the suite discovers the hub's LAN IPv4 over SSH), **or**
     set `"hub_host"` + `"ssh_key_path"`.
   - If you enabled HTTP Basic sign-in on the System page, fill in
     `"webui_username"` and `"webui_password"`.
   - Add your Wi-Fi network name to `"wifi_ssid_redact"` if it could appear in
     system logs.

3. **Run the default safe (strictly read-only) pass:**

   ```sh
   python3 tools/hw-regression/run.py
   ```

   This discovers your hub's live capabilities (`rf.info` paired remotes,
   `two_screen.conf`, `multi_remote.conf`, `usb_eth.conf`, `cloud_blocker.conf`,
   Android TV pairings, Home Assistant devices, Bluetooth keyboard, and time
   restrictions), runs **only** the checks that apply to your hub, clearly skips
   features you don't have enabled, masks all secrets/addresses, and writes a
   PR-ready Markdown report under `tools/hw-regression/reports/` (gitignored).

4. **Run with interactive physical checks + reversible activity round-trip:**

   ```sh
   python3 tools/hw-regression/run.py \
     --tier active \
     --allow-state-change \
     --allow-activity-toggle \
     --interactive
   ```

5. **Print a tailored physical checklist for your hub (read-only):**

   ```sh
   python3 tools/hw-regression/run.py --print-checklist
   ```

6. **Run the offline unit-test suite (no hub required):**

   ```sh
   python3 tools/hw-regression/run.py --self-test
   ```

---

## 2. Safety Rules & Tier Model

A Harmony Hub is a scarce hardware resource. The suite enforces hard safety
invariants in code (`hwreg/transport.py`, `hwreg/config.py`):

- **Default mode (`--tier safe`) is strictly read-only.** It never writes to
  flash or RAM, never starts/stops activities or sends IR/Bluetooth, never
  restarts services, and never reboots.
- **Forbidden operations (blocked at the transport layer in every tier):**
  - Never runs `sys.factoryreset`, firmware flash, or installer deployment.
  - Never deletes `/data/resources` or prunes `/data/codex-backups`.
  - Never reads `/data/codexmqtt/config.json` contents (checks non-empty file
    existence `[ -s ... ]` only).
  - Never races an open `rf.pairing` window (skips `rf.info` if pairing is active
    so slot-register reads cannot collide).
- **Per-run opt-in flags cannot be permanently enabled in `config.local.json`.**
  State-changing checks require explicit CLI flags on that invocation:
  - `--tier active --allow-state-change`: enables interactive physical prompts
    (`--interactive`) and specific reversible probes:
    - `--allow-activity-toggle`: starts one activity via `/api/activity-run` and
      restores the exact prior `activityId` in a `finally` block.
    - `--allow-hold-probe`: runs `press` -> `hold` -> `release` on `/api/ir-send`
      only when `test_hold` (`device_id` + `command`) is explicitly set in
      `config.local.json`, always sending `release` in `finally`.
    - `--allow-wol`: dispatches one live `PowerOn` to a disconnected Android TV
      and verifies the `Wake-on-LAN` interface log line.
  - `--tier disruptive --allow-disruptive`: enables physical RJ-45 cable-pull
    hand-back confirmation (`hitl.usb_eth_rj45_handback`), only after verifying
    that the `ath0` Wi-Fi lifeline is up.
  - `--allow-reboot`: explicit gate for the disruptive reboot/soak definition
    (`disruptive.reboot_and_soak`); never implied by any other flag.
  - Phase-3 disruptive drills (`core.turn_off_on_roundtrip`,
    `core.backup_restore_drill`, `core.recovery_ap_roundtrip`,
    `usb_eth.wifi_off_watchdog_recovery`) are registered definitions behind
    `--tier disruptive --allow-disruptive` only: the suite records the
    operator procedure and never executes them automatically.
  - Phase-3 feature probes keep new hub output on the existing SSH/HTTP
    transport and masker; MQTT broker credentials from `config.local.json`
    are used only for the broker CONNECT and are registered with the masker.
    Checks skip cleanly (never fail) when the hub lacks the feature.
- **Critical hardware rule — USB Ethernet OTG brownout:**
  **Never hot-plug or hot-unplug the micro-USB OTG Ethernet adapter on a powered
  hub** (doing so browns out the 5 V rail and reboots the hub). Always power the
  hub off, wait 30 seconds, attach the OTG Y-adapter and its external 5 V power
  brick, then apply power. For link-loss / hand-back tests, unplug **only the
  RJ-45 Ethernet cable**, never the micro-USB side.

---

## 3. PR Hardware Gate Model

Off-hub test suites (`webui-sim`, `installer_contract_smoke.py`, `hal_remotes`
emulator, `usb-eth-test`, `wol_test.sh`) remain required on every PR. In
addition, **any PR touching the paths below must attach a masked Hardware
Regression Report** before merge:

| Risk Area | Touched Repo Paths | Required Hardware Pass |
| --- | --- | --- |
| **Patched `hal` & RF remotes** | `payload/source/hal_remotes/*`, `payload/helpers/hal_*_patch.json`, `tools/build_hal_remotes.py` | `--tier active --allow-state-change --allow-activity-toggle --interactive` on a hub running the changed `hal` (`core.*`, `remote.*`, `hitl.two_screen_*`, `hitl.patched_hal_*`). |
| **USB host / Ethernet & kernel modules** | `payload/modules/*`, `payload/source/codex_usbeth.c`, `payload/scripts/usb_eth_service.sh` | Full `core.*` + `usb_eth.*` + `cross.*` + `--interactive --tier disruptive --allow-disruptive` (`hitl.usb_eth_rj45_handback`), proving counter-verified wired traffic and clean Wi-Fi hand-back. |
| **Boot & init scripts** | `payload/scripts/rcS.local`, `payload/scripts/init.sh` | Full `core.*` + `remote.*` + enabled feature checks after a clean boot of the staged script. |
| **Network routing, egress guard, or LAN broadcast/WoL** | `payload/scripts/offline_egress_guard.sh`, `payload/source/codex_androidtv.c` (WoL/mDNS), `payload/scripts/netservicestarter.lua` | `core.cloud_blocker_and_routes`, `usb_eth.lifeline_and_state`, `usb_eth.traffic_on_wire`, `cross.usb_eth_wol_binding` (`--allow-wol` if a standby TV is available), and `cross.lan_peer_reachability`. |
| **Installer staging / hal bind / flash checks** | `install_webui.py`, `install_webui.ps1` | Default read-only pass (`python3 tools/hw-regression/run.py`) before and after `--preflight-only` / deploy on a real hub. |

### How to attach a report to a PR

1. Run the suite with `--out tools/hw-regression/reports/pr-<num>.md`.
2. Inspect `tools/hw-regression/reports/pr-<num>.md` locally to confirm the
   automatic masker replaced all LAN IPs (`<hub-wifi-ip>`, `<hub-wired-ip>`,
   `<gateway-ip>`), MACs (`<mac-wifi>`, `<mac-wired>`), SSIDs (`<ssid>`), hub ID
   (`<hub-id>`), and RF serials (`<rfid-slotN>`).
3. Paste the Markdown report into a PR comment (or under a `<details>` block in
   the PR description). Never commit `config.local.json` or raw unmasked logs.

### Reading the report's three-way split

Every check in the generated report is categorized into one of three honest
buckets:

- **Verified**: Measured directly by the suite over SSH/HTTP/counters (e.g.
  `eth2` `tx_bytes` and `rx_packets` moved across multi-KB TCP transfers with 0
  errors; `hal` MD5 and `/var/run/codex_hal_gates` match `two_screen.conf`).
- **Reported**: Confirmed by the human operator during `--interactive` physical
  prompts (`[Operator-Reported]`), paired with pre/post SSH counter deltas where
  available.
- **Unresolved**: Either skipped because the feature is not enabled on that
  contributor's hub (with explicit reason), or an applicable active/interactive
  check not exercised in a safe/non-interactive run.

---

## 4. Coverage Map & Phase Plan

| Subsystem / Interaction | Check ID | Mode | Tier | Slice / Phase |
| --- | --- | --- | --- | --- |
| **Core: Boot, SSH, RAM, TDE, dmesg** | `core.boot_and_ssh` | Automatable | `safe` | **Slice 1 (Built)** |
| **Core: Daemons, `/proc/exe` MD5, Web UI & HBus** | `core.services_and_webui` | Automatable | `safe` | **Slice 1 (Built)** |
| **Core: `hal` identity (stock / multi / two remotes with screens / `once`), gates & `-h` load-check** | `core.hal_identity` | Automatable | `safe` | **Slice 1 (Built)** |
| **Core: Cloud blocker WAN suppression, multicast & 2.2s route-flap check** | `core.cloud_blocker_and_routes` | Automatable | `safe` | **Slice 1 (Built)** |
| **Remote -> Engine: `rf.info` slot policy, `Root` + `Activity` maps, 0 action-less buttons** | `remote.rf_inventory_and_maps` | Automatable | `safe` | **Slice 1 (Built)** |
| **Remote -> Engine: `hot.stats` per-slot radio error counters & `TS SLOTS` mask** | `remote.hot_radio_counters` | Automatable | `safe` | **Slice 1 (Built)** |
| **Remote -> Engine: Reversible `/api/activity-run` start + restore** | `remote.engine_activity_roundtrip` | Automatable | `active` | **Slice 1 (Built)** |
| **Remote -> Engine: `/api/ir-send` `press` -> `hold` -> `release` lifecycle** | `remote.hold_to_repeat_api` | Automatable | `active` | **Slice 1 (Built)** |
| **Remote -> Engine: Physical remote button -> activity + hold + Off** | `hitl.remote_physical_button_activity` | HITL + counters | `active` | **Slice 1 (Built)** |
| **USB Ethernet: Wi-Fi lifeline, state, `arp_ignore`/`arp_announce` & metric** | `usb_eth.lifeline_and_state` | Automatable | `safe` | **Slice 1 (Built)** |
| **USB Ethernet: Counter-verified bidirectional wire traffic & BE TCP checksums** | `usb_eth.traffic_on_wire` | Automatable | `safe` | **Slice 1 (Built)** |
| **Cross: USB-Eth + Cloud Blocker <-> Android TV WoL interface binding (+ opt-in live WoL)** | `cross.usb_eth_wol_binding` | Automatable | `safe` / `active` | **Slice 1 (Built)** |
| **Cross: USB-Eth + Cloud Blocker <-> HA webhook / TV / gateway routes & PR #128 hand-back** | `cross.lan_peer_reachability` | Automatable | `safe` | **Slice 1 (Built)** |
| **Two remotes with screens: simultaneous presses + cross-remote screen follow** | `hitl.two_screen_simultaneous_and_follow` | HITL + `hot.stats` | `active` | **Slice 1 (Built)** |
| **Two remotes with screens: sleep/wake link drop & resync** | `hitl.two_screen_sleep_wake` | HITL + `hot.stats` | `active` | **Slice 1 (Built)** |
| **Cross: Patched `hal` <-> handset built-in IR emitter (`hot.1` / `ts_pick_target`)** | `hitl.patched_hal_remote_ir_emitter` | HITL + `hot.stats` | `active` | **Slice 1 (Built)** |
| **Cross: Patched `hal` <-> local config sync / HOT file session** | `hitl.patched_hal_remote_sync` | HITL + `hot.stats` | `active` | **Slice 1 (Built)** |
| **Cross: USB-Eth active <-> physical Android TV wake from deep standby** | `hitl.usb_eth_wol_physical_tv_wake` | HITL + WoL log | `active` | **Slice 1 (Built)** |
| **Cross: USB-Eth RJ-45 unplug Wi-Fi hand-back & replug recovery** | `hitl.usb_eth_rj45_handback` | HITL | `disruptive` | **Slice 1 (Built)** |
| **Bluetooth HID: `hci0` UP RUNNING, `codex_bt_pair_agent`, link-key & AUTH+ENCRYPT check** | `bt.adapter_and_hid_daemon` | Automatable | `safe` | **Phase 3 (Built)** |
| **Time Restrictions: Active window 568 refusal + fail-open on unknown clock/TZ** | `restrictions.window_and_clock_failopen` | Automatable | `active` (`--allow-activity-toggle`) | **Phase 3 (Built)** |
| **Home Assistant: `/api/ha-state` freshness + live webhook POST round-trip** | `ha.state_and_webhook_roundtrip` | Automatable | `safe` read + `active` round-trip | **Phase 3 (Built)** |
| **Home Assistant: `CommitHaDevices` v2 dry-run + live scratch-device commit/removal** | `ha.devices_commit_live` | Automatable | `active` (`--allow-state-change`) | **Phase 3 (Built)** |
| **MQTT: broker discovery/state topics + activity-select round-trip** (skips when MQTT off) | `mqtt.broker_roundtrip` | Automatable | `active` (`--allow-state-change`) | **Phase 3 (Built)** |
| **Android TV: mDNS `_androidtvremote2._tcp` discovery across USB-Eth + Wi-Fi** | `androidtv.mdns_discovery_cross_if` | Automatable | `safe` | **Phase 3 (Built)** |
| **Android TV: input profiles per method + Try switch; pairing itself is HITL** | `androidtv.pair_inputs_try` / `hitl.androidtv_pairing` | Automatable + HITL | `active` | **Phase 3 (Built)** |
| **Remotes: Home Control buttons (16422 + 16417, +/− dimming, does-nothing rocker, legacy replace/clear #161)** | `remote.home_control_buttons` / `hitl.remote_home_control_buttons` | Automatable preconditions + HITL | `safe` / `active` | **Phase 3 (Built)** |
| **Remotes: pair-after-activities map backfill (#149) without re-saving activities** | `remote.pair_after_activities_backfill` / `hitl.remote_pair_after_activities_backfill` | Automatable + HITL | `safe` / `active` | **Phase 3 (Built)** |
| **Remotes: IR Learn capture→send; gesture/sequence/one-shot from a physical remote** | `hitl.remote_learn_and_gesture` | HITL + `hot.stats` | `active` | **Phase 3 (Built)** |
| **USB Ethernet: adapter-matrix note for traffic-untested chipsets (Realtek/AX88179/CDC)** | `usb_eth.adapter_matrix` / `hitl.usb_eth_adapter_matrix` | Automatable note + HITL | `safe` / `disruptive` | **Phase 3 (Built)** |
| **Turn-off/on round-trip** (`--turn-off` → stock spot-check → `--turn-on` → blocker/config intact) | `core.turn_off_on_roundtrip` | Definition + gating (operator-driven) | `disruptive` | **Phase 3 (Built — definition)** |
| **Backup → change → Restore drill** | `core.backup_restore_drill` | Definition + gating (operator-driven) | `disruptive` | **Phase 3 (Built — definition)** |
| **Recovery AP round-trip** (TDE boot → `Harmony-Recovery-*` → portal/DHCP → normal boot) | `core.recovery_ap_roundtrip` | Definition + gating (operator-driven) | `disruptive` | **Phase 3 (Built — definition)** |
| **Opt-in Reboot Persistence & Long-Uptime Soak** (`--allow-reboot`, RAM & counter drift) | `disruptive.reboot_and_soak` | Definition + gating (operator-driven) | `disruptive` | **Phase 3 (Built — definition)** |
| **USB Ethernet `WIFI_OFF=1` Watchdog & Worker-Death Recovery** (post-PR #125 merge) | `usb_eth.wifi_off_watchdog_recovery` | Definition + gating (operator-driven) | `disruptive` | **Phase 3 (Built — definition)** |
