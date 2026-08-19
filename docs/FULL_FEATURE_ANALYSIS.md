# Harmony Hub Control — Full Feature Analysis

> **HISTORICAL / NOT CURRENT MAIN.** This analysis is dated 2026-07-31 against
> the `agent/activity-webgui` branch. Its `codex_webui` identity (`6f05d649…`,
> 906,872 bytes) is a **historical** artifact, not the final product identity.
> The final product webui is `7bcf00bdcc98ded1795851ea72864f434e4e15d376a95dc7bedc70d34902b2a2`
> (778,408 bytes); see `docs/BUILD.md` and
> `docs/integration/main-product-20260819.md`.

**Repository:** `schlambos/harmony-hub-control`<br>
**Branch / HEAD:** `agent/activity-webgui` / `3de7b92da09323bdb569d9fcad1314c880bf6adb`<br>
**Analysis date:** 2026-07-31<br>
**Mode:** source and report analysis only; no hub mutation, prohibited endpoint use, commit, or push<br>
**Production artifact identity supplied by owner and independently matched to HEAD:** `codex_webui` md5 `6f05d6496067141fe13c1408224a42af`, 906,872 bytes

### Evidence notation

- **[Observed]** — command output produced during this analysis. Offline execution used a `git archive HEAD` snapshot outside the repository.
- **[Source]** — behavior directly established from current source or tests, cited as `path:line`.
- **[Documented]** — prior document or owner-provided production observation; treated as evidence of that observation, not automatically as current implementation truth.
- **[Hypothesis]** — terminal behavior cannot be observed from this repository; missing validation is named.
- **[External]** — URL-pinned upstream issue, PR, or repository metadata read without mutation.

## 1. Executive Summary

Harmony Hub Control is a post-root, LAN-hosted replacement control and configuration stack for Logitech Harmony Hub. Current branch adds an embedded 12-hash/11-view shell, offline activity graph authoring, paired-remote synchronization, IR database/learning/lab tools, Bluetooth pairing and HID controls, MQTT/Home Assistant integration, Wi-Fi and recovery controls, backup/import, optional Basic authentication, local updates, Docker/Unraid installation, and QEMU-based backend emulation. The root shell and assets are compiled into a static MIPS `codex_webui`; firmware-facing operations cross either HBus on loopback `:8088`, HAL LTCP on `:16716`, Lua resource-manager APIs, raw HCI, or hub files/FIFOs (`payload/source/codex_webui.c:26-80,2558-2695,8499-8792`; `tools/hub-emu/README.md:6-35`). **[Source]**

Feature implementation is broad and substantially real, not a mock-only UI. Current `codex_webui` implements activity config/state/run/save/sync, all setup-page form handlers, 24+ JSON API routes, 11 exports, v1/v2 import, update staging/apply, and embedded shell assets (`payload/source/codex_webui.c:8499-8642`). The repository artifact exactly matches the owner-supplied live md5/size: both working-tree file and `git show HEAD:payload/bin/codex_webui` produced `6f05d649…`, 906,872 bytes. **[Observed]**

Verification is strong at model/contract level but uneven at physical boundaries. This analysis executed 213 Node tests, nine Docker-manager tests, 70 activity-model assertion sites, 49 packaging checks, semantic-C, offline, Bluetooth, HBus, and IR-database smoke tests with no product-test failure. QEMU can run the actual MIPS HTTP server and HBus client, but Bluetooth/HAL, IR emission, the physical remote, reboot, MQTT broker, timing, and cloud behavior are stubbed or absent (`tools/hub-emu/README.md:111-130`; `tools/hub-emu/stubs/hcitool:1-16`; `tools/hub-emu/stubs/codex_hal_ltcp:1-19`). **[Observed/Source]**

Highest-priority defects are: (1) no Host/Origin/CSRF enforcement combined with a global LAN listener; (2) update integrity authenticates neither manifest nor binaries and permits downgrade; (3) secret-bearing Wi-Fi/MQTT/bundle exports are unredacted; (4) the wizard deletes `16420Activity<ID>` and other activity maps while the advanced editor requires the Bluetooth HID map; (5) installers omit `codex_bt_pair_agent`, the browser updater omits it, and update restart kills it without relaunch; (6) update/import multi-file replacement is non-transactional; and (7) Wi-Fi values permit newline injection (`payload/source/codex_webui.c:7529-7735,8500-8620,8581-8602,1257-1291`; `tools/webui-sim/public/js/wizard-model.js:198-240`; `payload/web/activity-ui.js:748-916,1920-1926`; `install_webui.py:305-313`; `payload/scripts/init.sh:30-44`). **[Source]**

**Readiness verdict:** feature scope is close to a complete owner-operated LAN control stack and current production shell is usable, but it is not ready for untrusted-network exposure or unattended self-update. Production safety remains conditional on cloud blocker staying enabled, owner-gated household-disruptive actions, reliable rollback artifacts, and avoiding web update/import paths until P0/P1 findings are addressed. Confidence is high for HTTP/source contracts and local persistence, medium for deployed shell identity and prior hardware observations, and low for unexecuted terminal radio/remote behavior.

## 2. System Architecture

### 2.1 Component map

```text
Browser
  └─ HTTP :8080 ─> codex_webui (static MIPS C server; fork per request)
       ├─ embedded Harmony shell + legacy HTML/forms
       ├─ HBus ─> codex_hbus ─> WebSocket 127.0.0.1:8088 ─> closed Harmony engine
       ├─ HAL ─> codex_hal_ltcp ─> LTCP 127.0.0.1:16716 ─> closed /usr/bin/hal
       ├─ activity IPC files ─> codexactivity.lua ─> firmware resource manager
       ├─ FIFO /tmp/bthid_input ─> codex_bthid_keyboard ─> HAL LTCP
       ├─ raw HCI ─> codex_bt_pair_agent ─> hci0/linkkeys
       ├─ local files under /data, /etc, /cache, /var/volatile, /tmp
       └─ shell helpers: hcitool, hciconfig, route, reboot, md5sum

Boot: /etc/init.d/rcS.local ─> /data/codex/init.sh ─> guards/services/plugins
Host install: Python/PowerShell or Docker/Unraid manager ─SSH/stdin─> hub
Development: webui-sim mock OR dev-proxy ─> QEMU hub-emu ─> actual MIPS backend
```

Server process, port, startup runtimes and dispatch are in `payload/source/codex_webui.c:8739-8792,8499-8642`; boot order is `payload/scripts/rcS.local:6-10,72-73` then `payload/scripts/init.sh:14-75`. **[Source]**

### 2.2 Frontend and embedded assets

`tools/webui-sim/public/` is source of truth for shell HTML/CSS/JS. `tools/package_harmony_shell.sh` runs the Bun bundle/minification and writes `tools/webui-sim/build/*` plus `payload/source/harmony_shell_assets.h`; `tools/embed_activity_ui.sh` also regenerates the vendored editor header (`tools/webui-sim/README.md:62-88`; `tools/package_harmony_shell.sh:45-71,122-191`; `tools/embed_activity_ui.sh:32-44`). `codex_webui.c` injects the existing base64 remote skin between generated head/tail arrays and serves shell/vendor assets (`payload/source/codex_webui.c:3030-3043,5866-5875,8515-8524`). **[Source]**

Production chain:

```text
tools/webui-sim/public/*
  -> tools/package_harmony_shell.sh
  -> payload/source/harmony_shell_assets.h
  -> zig cc -target mips-linux-musleabi -Os -static -s
  -> payload/bin/codex_webui
  -> SSH tmpfs/flash staging
  -> /data/codex/bin/codex_webui on hub
```

Current shell packaging executed twice deterministically and passed 49 contract checks; the tracked binary and owner-reported live artifact have the same md5/size. **[Observed]**

### 2.3 Backend and firmware integrations

| Boundary | Repository side | External/closed side | Confidence |
|---|---|---|---|
| HTTP | `codex_webui.c` request parser/handlers | Browser | High; source + tests |
| HBus | `codex_hbus.c` WebSocket client | Harmony engine on `127.0.0.1:8088` | Client high; engine terminal medium/low |
| HAL LTCP | `codex_hal_ltcp.c`, keyboard daemon | `/usr/bin/hal` on `127.0.0.1:16716` | Client high; radio terminal low |
| Activity persistence | volatile JSON IPC + `codexactivity.lua` | firmware resource manager/statedigest | Source high; closed APIs medium |
| Pairing | raw HCI pair agent, local linkkeys | controller/target device | Source high; fresh-pair hardware unverified |
| Physical remote | local MapList/FunctionList plus etag/hetag digest | paired handset firmware | Structural high; handset behavior from prior hardware records |
| Recovery network | `codex_dhcpd.c`, `codex_portal.c`, `recovery_ap.sh` | ath1/DHCP/captive portal/Wi-Fi radio | Source high; disruptive hardware path partial |

HBus request correlation, ping handling and large fragmented responses passed against a loopback WebSocket mock; actual engine verbs remain closed (`payload/source/codex_hbus.c:55-357`; `tools/hbus_notification_smoke.py:56-165`). **[Observed/Source]**

### 2.4 Trust, mutation, and rollback boundaries

| Boundary | Trusted input | Mutation | Rollback |
|---|---|---|---|
| Browser -> hub HTTP | LAN/browser; optional Basic auth | Resources, settings, binaries, process/reboot state | Per-feature backups; incomplete automatic rollback |
| Activity editor -> Lua writer | Three lists + live DeviceList validation | ActivityList, MapList, FunctionList, etag/hetag/configVersion | Compensated transaction in C and Lua |
| Import | Uploaded text/bundle | Resources/settings sequentially | Backup first; manual restore, no bundle auto-rollback |
| Update | Client-supplied manifest and chunks | Root-executed binaries | Timestamp backup; manual recovery only |
| Installer | Root SSH key and numeric hub ID | Boot scripts, binaries, plugins, settings | Handoff backup; restore script incomplete |
| Cloud blocker | Local config + route monitor | Cloud task policy/default route | Saved gateway in volatile RAM; imperfect recovery |

Activity save is the strongest transaction: optimistic revision gate, semantic diff, backups, Lua snapshots, read-back, engine barrier, digest publication and compensation (`payload/source/codex_webui.c:2850-3028`; `payload/activity/codexactivity.lua:149-233,441-557`). Update/import are not atomic as sets (`payload/source/codex_webui.c:6145-6320,7600-7735`). **[Source]**

## 3. Feature Inventory

**Evidence scope:** this table is a scan index. Canonical file:line citations and evidence grades for every row are in §§4-11; verification classes are normalized in §11.

| Feature | Purpose and flow | Backend / persistence | Guards and states | Verification / limitation |
|---|---|---|---|---|
| Dashboard | Current activity, start tiles, power-off, event/status summary | activity config/state/run | Retry/error/empty state; sim events gated | Unit/model; production view owner-verified |
| Activity control | Real remote JPEG; resolve mapped activity keys; send IR/BT; long press | `/api/ir-send`, activity MapList | Unmapped disabled; Inspector persists; send errors surfaced | Browser/model; physical result terminal unverified here |
| Device control | Same handset in direct-device mode | inventory/device commands/IR send | Device selection and command resolution | Source/model; no new physical send |
| Activity roster | Friendly cards, run, edit, reorder, delete | full graph save with revision | Running activity deletion blocked; confirmation | Unit/model; wizard divergence remains |
| Wizard | Four-step name/devices/map/review flow | one `16414Activity` map + FunctionMap save | Valid command mapping; conflict/errors | Unit helpers; no dedicated wizard-model test; loses maps |
| Advanced editor | Full roles, inputs, ordering, delays, press/hold/double, JSON, repair | vendored `activity-ui.js`; save/sync | Strict graph validator/repair | 70-assertion smoke; enforces 16420 map |
| Physical remote | Pull local graph and control activities/devices | etag/hetag/configVersion; MapList | No action-less buttons; identity and keyboard association constraints | Prior hardware record; not emulatable |
| IR inventory/control | Browse devices/commands, virtual remote, direct send | DeviceList/ProtocolList; HBus holdaction | label/device validation; optional BT preconnect | Source + parser tests; no new photon proof |
| IR learning/test | Capture, classify keycode/NEC/raw, temporary test command | HBus `ir.cap`; temporary DeviceList mutation | 15 s capture; cleanup result | Source only; child death can leave temp command |
| IR import/sweep | IRDB/Flipper/LIRC/RemoteCentral conversion, import, batch, cancel | DeviceList, ProtocolList, event/cancel files | 2,048 stored, 1,024 batch, delays, safe path | 750/750 sampled commands parsed; sends not run |
| IR lab | Create/reuse temporary device, import/test/clear | DeviceList | Clear restricted to lab device; heap fix | Source/emulator prior; not exercised this mission |
| Bluetooth pairing | Register HID profile, pairable/discoverable, SSP, persist link key | raw HCI; BlueZ linkkeys; profile/target files | type/name/address/PIN; 10–600 s; auto-confirms SSP | Source + prior bond evidence; fresh pair untested |
| Bluetooth HID | Connect/authenticate, text FIFO, named keys, saved scripts | HAL LTCP, FIFO/status, bt-devices JSON | AUTH+ENCRYPT plus two lower guard layers | Host self-test/guards; radio terminal unverified |
| MQTT / HA | Broker config, discovery, state, activity/IR/HBus commands | `codexmqtt.lua`, config JSON, event log | Retained-command refusal; duplicate window | Model/config tests; no broker integration this mission |
| Wi-Fi | Edit/export network config; optional reboot; recovery AP | `/etc/wpa_supplicant.conf`, recovery scripts | required SSID/PSK; 0600; injection gap | Parser tests; hardware save forbidden |
| Backup/restore | Ten individual exports plus v2 bundle, component/bundle import | resources/settings | size/shape preflight; secret exports; backups | 213 model tests; import forbidden this mission |
| System | Status/log HTML probe, auth, cloud, rediscovery, reboot, update | config/logs/processes/update stage | destructive guards in UI; backend lacks CSRF | Model/source; dangerous actions unexecuted |
| Offline ownership | Block cloud tasks, local resource GET/PUT/sync, remove WAN route | netservice Lua + egress guard | fail-safe task gate; route monitor | Structural guard passed; prior live guard had died |
| Install/recovery | Direct SSH, Docker/Unraid once-mode, recovery AP | `/data/codex`, boot scripts, marker | key 0600, real hub ID, cloud restart | 9 manager tests; installer omissions remain |
| Emulator/sim | UI mock or actual MIPS backend under QEMU | in-memory fixture or seeded container | reset and loopback binding | Strong HTTP fidelity; hardware stubs force happy path |

## 4. Route-by-Route Analysis

Hash routing registers 11 views; `#devices` aliases the Control view with `{mode:"devices"}`, producing 12 hashes for 11 distinct view implementations (`tools/webui-sim/public/js/app.js:14-55`). Unknown hashes fall back to `#control`; each view gets `onShow`/`onHide`, active-nav `aria-current`, and a route-specific title (`tools/webui-sim/public/js/app.js:53-79,109-119`). **[Source]**

| Hash | Source | User flow and calls | States / storage | Limits and hazards |
|---|---|---|---|---|
| `#home` | `views/dashboard.js` | Ensures config/state; current activity; start/power-off; optional sim event log (`:105-120,125-216`) | Loading/error/retry, off/running, no activities | Sim events production-gated; derived counts only |
| `#control` | `views/control.js` | Activity selection, real remote hotspots, mapped/soft actions, run/power-off, `/api/ir-send` (`:414-565`) | Status line, Inspector, mapping empty state | Physical response beyond HBus unobserved |
| `#devices` | same `control.js` | Device selection and direct commands; same handset (`app.js:48-49`) | Empty device/command states | Intentional alias, not separate view |
| `#activities` | `views/activities-home.js` | Cards, run, wizard edit, reorder/delete through graph save (`:98-187`) | Load/error/empty; delete confirmation; live delete disabled | Uses shared graph; depends on revision |
| `#editor` | `views/activities.js`, `payload/web/activity-ui.js` | Lazy-load vendor CSS/JS; full editor and repair (`activities.js:137-186`) | Vendor load/error; unsaved/beforeunload | Complex strict validator; creates 16420 maps |
| `#wizard` | `views/wizard.js`, `wizard-model.js` | Name -> roles/devices -> remote mapping -> review/save/run (`wizard.js:323-519`) | Step errors, edit preload, completion | Replaces all activity maps with one 16414 map (`wizard-model.js:198-240`) |
| `#ir` | `views/ir.js`, `ir-model.js` | Inventory, saved commands, capture/test/import, RemoteCentral, queue/batch/lab (`ir.js:137-158,553,841`) | Loading/error/empty capture, filters, queue/progress, danger clear | Large surface; RemoteCentral is outbound and cloud-ungated |
| `#bluetooth` | `views/bluetooth.js`, `bluetooth-model.js` | Adapter/status, pair, scan, link, key/text, saved devices/scripts (`bluetooth.js:1-15,480-710`) | Runtime/link/pairing states, validation, destructive delete guard | Emulator stubs force AUTH+ENCRYPT happy path |
| `#mqtt` | `views/mqtt.js` | Read `/export/mqtt`, parse without revealing password, POST `/mqtt` (`mqtt.js:1-12`) | Loading/error, password-set indicator | Export response itself contains secret |
| `#wifi` | `views/wifi.js` | Read `/export/wifi`, redact PSK in UI, POST `/wifi`, reread (`wifi.js:1-20,201`) | Loading/error, hidden/open, password-preserved | Backend newline injection; save can disconnect hub |
| `#backup` | `views/backup.js`, `backup-model.js` | Ten individual exports plus bundle, file preflight, guarded `/import` (`backup.js:12-73`; `backup-model.js:1-90`) | Size/shape/error and destructive confirmation | Bundle contains secrets; import sequential/non-atomic |
| `#system` | `views/system.js`, `system-model.js` | HTML status/log probe; update status/check; cloud/auth/rediscover/reboot/apply (`system.js:18,99-100,430`) | Loading/error, update state, destructive guards | Probe renders heavy legacy page; backend has no CSRF |

Shared state caches only activity config/current state in memory, merges concurrent loads and keeps HTTP cache disabled (`tools/webui-sim/public/js/state.js:3-50,110-147`; `tools/webui-sim/public/js/api.js:11-45`). The Inspector disclosure state is the notable persistent browser cache, implemented with `localStorage("hhc.inspector")` (`tools/webui-sim/public/js/views/control.js:121-123`). **[Source]**

Responsive intent is a 220 px rail collapsing below 840 px and a control grid with a 280–360 px remote column (`DESIGN.md:102-106`). Accessibility includes `aria-current`, labels/field hints, focusable remote hotspots, danger confirmations and HTML escaping; no automated axe/Lighthouse/keyboard/screen-reader suite exists. **[Source]**

## 5. Backend and API Contracts

### 5.1 Global HTTP contract

`read_request` allocates `MAX_REQUEST_BYTES` (1 MiB body + 8 KiB), parses method/path/auth/body and flags truncation (`payload/source/codex_webui.c:60-62,8418-8486`). Every route passes optional Basic auth, then 413 handling, then method/path dispatch; wrong methods fall through to plain 404 rather than 405 (`payload/source/codex_webui.c:831-853,8499-8642`). JSON success normally uses `{ok:true,...}` and failures `{ok:false,error}`; streamed HTML/JSON responses omit `Content-Length`, while embedded assets and downloads include it (`payload/source/codex_webui.c:938-997,3030-3043,5866-5906`). **[Source]**

### 5.2 Activity APIs

| Method/path | Request | Success / errors | Side effects / caller |
|---|---|---|---|
| GET `/api/activity-config` | none | four lists + three-list revision; 503 | Reads Activity/Map/Function/Device; shell/editor (`:2707-2748`) |
| GET `/api/activity-state` | none | current HBus reply; 502 | HBus getCurrentActivity; shared state (`:2750-2757`) |
| POST `/api/activity-run` | form `activityId`, `-1` power off | 200; 400/502 | HBus startactivity; dashboard/control (`:2761-2783`) |
| POST `/api/activity-save` | JSON `baseRevision`, three lists, `syncRemote` | change flags/revision/remoteRefreshed; 400/409/500/503 | Backup, IPC transaction, compensation; wizard/editor/roster (`:2850-3028`) |
| POST `/api/activity-sync` | none | local refresh, never cloud sync; 503 | etag/hetag/digest refresh (`:2787-2848`) |

### 5.3 Inventory and IR APIs

| Method/path | Request / response | Side effects and guards |
|---|---|---|
| GET `/api/inventory` | limits, devices, command metadata | Reads DeviceList; may repair missing built-in protocols (`:1509-1528`) |
| GET/POST `/api/device-commands` | query/form `deviceId`; command list; 400/404 | Same state-dependent protocol repair (`:1591-1625`) |
| GET/POST `/api/remotecentral-fetch` | `path`; `{html}` or error | Hardcoded host + strict `/cgi-bin/codes/` path; outbound HTTP (`:1671-1748`) |
| GET/POST `/api/capture` | fixed 15 s capture; classified raw/keycode/NEC | HBus `ir.cap`; no persistence (`:1654-1668,4271-4283`) |
| POST `/api/ir-send` | form `deviceId`,`command`; reply | Optional BT preconnect, HBus holdaction, event log (`:6328-6348`) |
| POST `/api/ir-test-learned` | device/name/mode/signal | Add -> settle -> send -> delete; cleanup reported (`:8153-8203`) |
| POST `/api/ir-batch-send` | newline commands, delay, dryRun, runId | Up to 1,024; cancel polling; sends/logs (`:6351-6442`) |
| POST `/api/ir-cancel` | safe runId | Creates cancel marker and event (`:6444-6468`) |
| POST `/api/ir-lab-target` | none | Create/reuse temporary DeviceList entry (`:6470-6482`) |
| POST `/api/ir-lab-clear` | optional deviceId | Only canonical lab device; backup/write (`:6484-6522`) |
| POST `/api/irdb-import` | deviceId + line payload | Dedup/caps; DeviceList/ProtocolList backup/write/reload (`:8278-8313`) |

Legacy IR form routes provide create/update/delete device/command and HTML responses; they are dispatched at `payload/source/codex_webui.c:8611-8628`.

### 5.4 Bluetooth APIs

| Method/path | Request / response | Side effects and guards |
|---|---|---|
| POST `/api/bt-call` | action/type/address/name/code/PIN/time/gap | Pair/scan/connect/status/report matrix; 400/409/502; HCI/HAL (`:7737-8140`) |
| GET `/api/bt-text-status` | runtime/status JSON | Reads PID/status; missing/stale states (`:7270-7300`) |
| POST `/api/bt-text` | text <=32 KiB | Requires live runtime + authenticated encrypted target; FIFO write (`:7250-7268,7014-7081`) |
| POST `/api/bt-saved-command` | deviceId, command | Requires authenticated target; executes saved script (`:8396-8422`) |

Legacy saved-device/command form routes are at `payload/source/codex_webui.c:8629-8638`. Pairing persists BlueZ-compatible link keys using a temp/rename 0600 file (`payload/source/codex_bt_pair_agent.c:237-299`); all payload-bearing paths require authenticated+encrypted connection and HAL rechecks (`payload/source/codex_webui.c:6622-6649,7989-7998`; `payload/source/codex_hal_ltcp.c:471-506`).

### 5.5 Update APIs

| Method/path | Contract | Side effects / hazards |
|---|---|---|
| GET `/api/update-status` | local allow-listed files, size/md5 | Reads `/data/codex/bin` (`:7437-7460`) |
| GET/POST `/api/update-check-state` | saved check metadata | Reads/writes `update_state.conf` (`:7462-7508`) |
| POST `/api/update-begin` | client manifest | Clears/stages under `/tmp/codex_update` (`:7510-7557`) |
| POST `/api/update-chunk` | allow-listed file, exact offset, hex bytes | No total staging cap (`:7559-7598`) |
| POST `/api/update-apply` | optional restart | Prevalidates MD5, backs up, sequentially replaces, no auto-rollback, process restarts (`:7600-7735`) |

Allow-list includes seven `codex_*` binaries, but embedded browser update names omit `codex_bt_pair_agent`; restart kills that agent and does not relaunch it. Browser fetch URLs are hardcoded to `Ripthulhu/harmony-hub-control`, not the feature-bearing `schlambos` fork (`payload/source/codex_webui.c:72-80,4516,7716-7733`). **[Source]**

### 5.6 Exports and legacy setup forms

| Method/path family | Response / input | Side effects |
|---|---|---|
| GET `/export/bundle` | `harmony-owner-bundle-v2` attachment | Reads resources/settings, including secrets (`:1812-1838`) |
| GET `/export/devices\|functions\|protocols\|activities\|maps\|automation` | corresponding JSON attachment | Read-only (`:8581-8594`) |
| GET `/export/mqtt\|wifi\|cloud\|bluetooth` | config/text/JSON attachment | Read-only; MQTT/Wi-Fi secret-bearing (`:8595-8602`) |
| POST `/mqtt` | form config | Atomic JSON write, discovery trigger (`:5908-5941`) |
| POST `/wifi` | form network config | WPA write; optional reboot (`:5943-5976`) |
| POST `/system` | reboot/cloud/auth/rediscover | Config/process/route mutations (`:5978-6050`) |
| POST `/import` | target + payload/bundle | Backup then sequential resource/settings write/reload (`:6145-6320`) |

All routes share the same auth gate. None has CSRF/Origin/Host protection (`payload/source/codex_webui.c:8499-8642`).

## 6. Persistence and Data Model

### 6.1 Authoritative resources

| Resource | Path / root shape | Authority and writers | Backup/import/export |
|---|---|---|---|
| DeviceList | `/data/resources/DeviceList.json`; `DevicesWithFeatures` | Device/IR/import handlers; activity transaction reads only | Six-resource snapshots; device/bundle export/import |
| ActivityList | `/data/resources/ActivityList.json`; `Activities` | Activity three-list transaction only | Snapshots; activity/bundle export/import |
| MapList | `/data/resources/MapList.json`; `ButtonMaps` | Activity three-list transaction only | Snapshots; maps/bundle export/import |
| FunctionList | `/data/resources/FunctionList.json`; `FunctionMaps` | Activity transaction and device/import handlers | Snapshots; function/bundle export/import |
| ProtocolList | `/data/resources/ProtocolList.json`; `Protocols` | IR repair/import handlers | Snapshots; protocol/bundle export/import |
| AutomationConfig | `/data/resources/AutomationConfig.json`; object | Import/firmware/MQTT discovery context | Snapshots; automation/bundle export/import |

Paths are defined at `payload/source/codex_webui.c:32-38`. `GET /api/activity-config` returns all four activity-related lists, but revision and save cover ActivityList/MapList/FunctionList only; `deviceList` in an activity-save body is ignored (`payload/source/codex_webui.c:2707-2748,2862-2865`). **[Source]**

### 6.2 Settings, secrets, runtime state

| State | Path | Format / authority | Durability / secret class |
|---|---|---|---|
| MQTT | `/data/codexmqtt/config.json` | broker, credentials, topics, discovery/timing | persistent 0600; password secret |
| Wi-Fi | `/etc/wpa_supplicant.conf` | WPA network block | persistent 0600; PSK secret |
| Cloud blocker | `/data/codex/cloud_blocker.conf` | enabled/disabled token | persistent; security-critical |
| Web auth | `/data/codex/webui_auth.conf` | enabled, username, plaintext password | persistent 0600; fail-open on invalid file |
| BT saved devices | `/data/codex/bt-devices.json` | version + devices + commands/scripts | persistent; addresses/local automation |
| BT link keys | `/var/lib/bluetooth/<adapter>/linkkeys` | peer/key/type entries | persistent 0600; cryptographic secret |
| BT target/profile | `/data/codex/bthid_target`, related profile file | selected address/type | persistent |
| Hub ID | `/data/codex/hub_id` | numeric | persistent; operational identifier |
| Update state | `/data/codex/update_state.conf` | checkedAt/available/changes/message/source | persistent status |
| Update stage | `/tmp/codex_update/*` | manifest + chunked binaries | volatile RAM; size not globally capped |
| Update backup | `/data/codex/update-backups/<timestamp>` | previous binaries; keep three | persistent manual rollback |
| Resource backup | `/data/codex/resource-backups/<timestamp>` | six resource files; keep five | persistent manual/context rollback |
| IR events | `/data/codex/ir-events.log[.1]` | JSON lines; 64 KiB rotation | persistent flash writes |
| Activity IPC | `/var/volatile/codex-activity-{request,response}.json` | correlated operation/response | volatile 0600 |
| BT text | `/tmp/bthid_input`, `/tmp/bthid_status` | FIFO + JSON status | volatile |

Canonical path macros are `payload/source/codex_webui.c:26-58`; keyboard paths are also in `payload/source/codex_bthid_keyboard.c:22-26`. **[Source]**

### 6.3 Activity invariants and state layers

The C revision is three FNV-1a hashes joined as `%08x-%08x-%08x`; missing or stale `baseRevision` yields 409 (`payload/source/codex_webui.c:1840-1864,2902-2911`). It is an editor-concurrency token, not firmware etag. Lua separately generates fresh etag/hetag values, increments `configVersion`, saves state digest and emits `connect.stateDigest?notify` (`payload/activity/codexactivity.lua:83-107,149-200,475-482,552-556`). **[Source]**

Lua validation is final authority: positive unique activities, valid device/activity references in roles/actions/maps, known FunctionMap types, exactly one ActivityFunctionMap per activity, and live DeviceList validation (`payload/activity/codexactivity.lua:248-438,460-469`). Client validation adds map/button identity, `ButtonState`, identifier/surface totality, action-less rejection and the conditional 16420 HID-map rule (`payload/web/activity-ui.js:1688-1929`). **[Source]**

Paired-remote hard lines:

- No action-less buttons in ActivityButtonMaps; prior hardware evidence reports remote lockup until power-cycle (`README.md:63-80`; `docs/SESSION_HANDOFF.md:119-144`). **[Documented hardware]**
- Bluetooth remote devices require `IsKeyboardAssociated:false`; imports can silently reintroduce true (`README.md:82-90`; `docs/SESSION_HANDOFF.md:146-157`). **[Documented hardware]**
- Positive unique `ButtonMapId-`/`ButtonId`, `ButtonState:1`, exact trailing-dash keys, preserved remote/surface identities (`docs/API.md:84-154`). **[Source/Documented hardware]**
- `NextDevicePowerOnDelay` belongs to the role and occurs between power and input phases (`README.md:101-111`; `docs/SESSION_HANDOFF.md:258-264`). **[Documented firmware analysis]**

### 6.4 Authoritative state versus caches

| Layer | Role |
|---|---|
| Resource files + firmware manager | Durable authoritative graph/settings |
| Firmware activity engine | Loaded runtime interpretation; requires reload/barrier |
| statedigest/etag/hetag | Paired-client freshness and re-pull signal |
| C `baseRevision` | Browser optimistic-concurrency token |
| Shell `state.js` | In-memory activity config/current ID cache; invalidated after save |
| View-local state | Wizard drafts, queues, selection, form status |
| `localStorage("hhc.inspector")` | UI disclosure preference only |
| Emulator/sim | Fixture-derived, not production authority |

`state.js` deduplicates in-flight reads and exposes immutable sorted/derived helpers (`tools/webui-sim/public/js/state.js:3-50,110-156`). **[Source]**

## 7. End-to-End Operational Flows

### 7.1 Loading the production shell

1. `init.sh` starts `codex_webui 8080`; main starts BT helper runtimes, binds `INADDR_ANY`, listens and forks (`payload/scripts/init.sh:30-75`; `payload/source/codex_webui.c:8739-8792`).
2. Request parser/auth/body gates run (`payload/source/codex_webui.c:8418-8513`).
3. `GET /` calls `render_harmony_shell`, streaming generated head + existing remote-skin base64 + tail (`:5866-5875,8515-8516`).
4. Browser loads shell CSS/JS and lazy vendor editor from embedded routes (`:3030-3043,8517-8524`).
5. `app.js` selects hash, runs view `onShow`, then `ensureConfig()` and `refreshState()` (`tools/webui-sim/public/js/app.js:53-79,109-119`).
6. Config reads four resources; state crosses HBus getCurrentActivity (`payload/source/codex_webui.c:2707-2757`).

### 7.2 Starting/stopping an activity

1. Dashboard/control/wizard calls `state.setRunning(id)` -> form POST `/api/activity-run` (`state.js:130-147`; `api.js:56-71`).
2. C validates `-1` or nonnegative integer, builds timestamped params and calls `harmony.engine?startactivity` (`codex_webui.c:2697-2705,2761-2783`).
3. `codex_hbus` sends correlated WebSocket request to loopback `:8088` (`codex_hbus.c:55-114,241-357`).
4. **[Hypothesis]** closed engine runs power/input sequencing and device effects; source proof ends at HBus. Prior decompiled-firmware evidence says all power actions precede inputs and delay follows the owning power action (`docs/SESSION_HANDOFF.md:258-264`).
5. Client refreshes state; `-1` is PowerOff, not a separate stop endpoint (`state.js:130-147`; `docs/API.md:20-30`).

### 7.3 Saving an activity

1. Wizard/editor/roster build full ActivityList/MapList/FunctionList plus `baseRevision` (`payload/web/activity-ui.js:1931-1992`; `wizard-model.js:198-240`).
2. C validates root shapes, compares revision (409 on stale), semantic-diffs and backs up changed resources (`codex_webui.c:2850-2920`).
3. C writes correlated volatile request and polls up to 45 s (`:2613-2695`).
4. Lua refuses unless cloud blocker is exactly enabled, validates graph against live DeviceList and snapshots current state (`codexactivity.lua:292-469`).
5. Lua writes and verifies all three resources, reloads engine, waits process barrier, increments digest and notifies clients (`:475-557`).
6. Any Lua failure restores snapshots; C performs second semantic read-back and compensates again if needed (`:202-233`; `codex_webui.c:2932-3022`).
7. Client adopts returned revision and reloads.

**Wizard defect:** `wizard-model.js:226-227` deletes all maps for edited activity and re-adds one 16414 map. Advanced editor requires exactly one conditional `16420Activity<ID>` for Bluetooth keyboard role and recreates it before save (`payload/web/activity-ui.js:748-916,1920-1926`). Server/Lua do not enforce this identifier. **[Source]**

### 7.4 Sending an IR command

1. Control/IR UI POSTs device and command (`control.js:507-529`; `api.js:74-82`).
2. C validates labels, repairs known protocols if necessary and checks whether DeviceList marks target Transport 32 (`codex_webui.c:6328-6348,4152-4229`).
3. Bluetooth target path loads bond, discards stale unauthenticated ACL, connects and requires five stable AUTH+ENCRYPT samples; normal IR bypasses this (`:4185-4229,6651-6667`).
4. C calls HBus `harmony.engine?holdaction` and logs event (`:4238-4264`).
5. **[Hypothesis]** engine/HAL emits IR or HID; no new physical send was performed.

### 7.5 Bluetooth HID command/text

1. Text POST reaches FIFO handler; it requires live runtime, listening state, safe target and authenticated encrypted ACL (`codex_webui.c:7014-7081,7250-7268`).
2. Keyboard daemon maps ASCII, rechecks native `bthid.status` per character, sends press/release LTCP reports and updates status (`codex_bthid_keyboard.c:334-435,633-813`).
3. Named keys/report sequences pass web AUTH+ENCRYPT gate, stage a sequence file and invoke LTCP (`codex_webui.c:7929-8108,6823-6982`).
4. `codex_hal_ltcp` independently checks connected type/address before every report part (`codex_hal_ltcp.c:471-506,508-602`).
5. **[Hypothesis]** closed HAL/radio delivers keys. Emulator stubs force all three guard layers true.

### 7.6 Saving MQTT or Wi-Fi configuration

**MQTT:** setup view reads export without rendering password, POSTs legacy form; C preserves optional existing password, writes 0600 JSON atomically and triggers HBus discovery; Lua notices config change and reconnects (`views/mqtt.js:1-12`; `codex_webui.c:1113-1135,5908-5941`; `codexmqtt.lua:658-710`).

**Wi-Fi:** view parses export without returning PSK, POSTs form and rereads; C validates required SSID/password, writes 0600 supplicant config and optionally reboots (`views/wifi.js:1-20`; `codex_webui.c:1177-1199,5943-5976`). `%0A` newline is not stripped, permitting directive injection (`codex_webui.c:1257-1291`).

### 7.7 Export and restore

1. Backup view exposes ten individual exports plus the bundle route; GET streams attachments (`views/backup.js:12-73`; `codex_webui.c:8581-8602`).
2. Bundle v2 includes resource/settings data; Wi-Fi/MQTT secrets are unredacted (`codex_webui.c:1812-1838`).
3. Browser validates size/shape/cloud-enable-only and danger-confirms (`backup-model.js:1-90`; executed Node tests).
4. `/import` backs up, then sequentially writes selected resources/settings and reloads/discovers (`codex_webui.c:6145-6320`).
5. Failure after an earlier write does not auto-restore; operator must use timestamp backup. Installer restore is separate and restores fewer files than installer backs up (`restore_backup.ps1:87-124`; `install_webui.py:289-299`).

### 7.8 Update application

1. Browser fetches public manifest/binaries from hardcoded `Ripthulhu/harmony-hub-control` GitHub/raw/CDN URLs, compares local status, begins stage, hex-chunks files and applies (`views/system.js:99-100,430`; embedded updater source at `codex_webui.c:4516`). This can overwrite fork-only features with upstream binaries.
2. C accepts client manifest, exact allow-listed filenames and offsets; apply verifies staged file against same client manifest (`codex_webui.c:7510-7629`).
3. All files prevalidate, then each live binary is backed up and replaced sequentially; no automatic rollback on mid-loop failure (`:7600-7700`).
4. Manifest installs, sync runs, response returns backup path; restart shell kills pair agent, restarts keyboard/webui, but does not relaunch pair agent (`:7701-7733`).
5. No signature, pinned key or version gate exists; downgrade is permitted.

### 7.9 IR-lab target and clear

1. IR view calls target; C heap-allocates ~12 MiB inventory lookup, reuses or creates `Temporary IR Test` in DeviceList (`views/ir.js`; `codex_webui.c:1485-1504,3457-3495,6470-6482`).
2. Heap allocation fixes the former request-child stack overflow (`4bdb1a7`; `docs/PRODUCTION_PUSH_READINESS.md:274-287`).
3. Clear resolves canonical target, rejects other devices, backs up and clears command array (`codex_webui.c:6484-6522`).
4. No physical send occurs until later batch execution.

### 7.10 Production build and deployment

1. Packager regenerates shell header; Zig builds static MIPS binary; manifest md5/size is updated (`tools/webui-sim/README.md:62-88`; `README.md:336-357`).
2. Direct installer validates root key/hub ID, creates handoff backup, streams files via SSH `cat`, writes configs/plugins, starts services, verifies md5 and optionally reboots (`install_webui.py:263-404`).
3. Docker/Unraid manager copies runtime key to 0600 temp, calls installer once and writes `/config/state/install.json`; steady state nginx proxies to hub (`docker/manager.py:171-203,266-305,321-353,360-421,485-500`).
4. Production-safe binary-only runbook stages in `/var/volatile`, verifies, copies to `.next`, syncs, verifies again, renames and health-checks (`docs/PRODUCTION_PUSH_READINESS.md:148-236`). **[Documented, not executed this mission]**

## 8. Offline and Security Model

### 8.1 Offline isolation

Strict offline mode layers:

1. `netservicestarter.lua` skips cloudapi/PubNub/package-manager tasks when blocked and fails blocked when config is missing (`payload/scripts/netservicestarter.lua:28-38,258-265,344`).
2. Local HBus guards serve resource GET locally, fake-ack resource PUT without mutation and answer `setup.sync*` locally (`payload/scripts/netservicestarter.lua:76-237`).
3. `offline_egress_guard.sh` removes default route, preserves LAN and multicast and checks every two seconds (`payload/scripts/offline_egress_guard.sh:9-10,29-46,67-71`).
4. Activity Lua refuses writes unless blocker is exactly `1` (`payload/activity/codexactivity.lua:441-447`).

Limitations: route deletion is not a firewall; DHCP/link events can open a short egress window; IPv6/secondary routes are not covered; saved gateway is volatile; Lua accepts broader enabled semantics than egress guard; RemoteCentral fetch is a direct outbound exception and is not blocker-gated (`offline_egress_guard.sh:5,32,39,69-71`; `codex_webui.c:1717-1748`). **[Source]**

### 8.2 Authentication and exposure

Optional Basic auth is global and precedes routing; missing/empty config disables it (`codex_webui.c:364-390,831-853`). Default no-auth and no TLS are documented LAN design choices (`docs/SECURITY.md:3-8`). Risks: plaintext password, ordinary `strcmp`, no throttling, and fail-open corruption behavior. **[Source]**

Confirmed security gaps:

- No Host/Origin/Referer/Sec-Fetch/CSRF controls; listener is `INADDR_ANY`. Cross-site form requests and DNS rebinding bypass trusted-LAN assumptions (`codex_webui.c:8499-8792`).
- Update trust is client-supplied blob + client-supplied MD5, allowing arbitrary root binary/downgrade (`:7529-7735`).
- `/export/wifi`, `/export/mqtt`, and bundle disclose credentials without redaction (`:1812-1838,8581-8602`).
- Wi-Fi quoting permits newline directives (`:1257-1291`).
- Fork-per-request has no child cap/client receive timeout; import amplifies per-request heap use (`:6145-6320,8775-8790`).
- Shared JSON read-modify-write has no interprocess lock; atomic rename does not prevent lost updates.
- `write_file_atomic` lacks pre-rename `fsync` (`:247-266`).
- IR event logging writes flash per command (`:4124-4137`).

Clean findings: no confirmed command injection, general RemoteCentral SSRF, updater path traversal, auth bypass, or XSS; input escaping, exact update filename allow-list, RemoteCentral host/path restrictions and parser bounds are effective (`codex_webui.c:601-638,1671-1748,7288-7305,8500-8506`). **[Source]**

### 8.3 Household-disruptive operations

Activity run/power-off, IR/HID sends, pairing, Wi-Fi save/reboot, cloud toggle, imports, update apply, auth changes, rediscovery and reboot can affect household equipment, connectivity or hub availability. UI danger guards reduce accidental clicks, but backend CSRF and unauthenticated LAN calls bypass UI confirmation. Owner presence remains required for physical-remote regression, network/auth changes, reboot, update and destructive import (`docs/PRODUCTION_PUSH_READINESS.md:240-268`; `docs/SESSION_HANDOFF.md:440-456`). **[Documented/Source]**

## 9. Build, Deployment, and Rollback

### 9.1 Build and reproducibility

Production recipe is Zig `mips-linux-musleabi -Os -static -s`; result must be 32-bit MSB MIPS32r2 static stripped (`README.md:336-353`). Legacy full-build script uses a Bootlin Linux x86-64 toolchain and is unsuitable on arm64 macOS (`docs/SESSION_HANDOFF.md:363-369`). **[Documented/Source]**

Current observed artifact: md5 `6f05d6496067141fe13c1408224a42af`, 906,872 bytes for both working-tree and HEAD blob; manifest and owner-reported live identity match. **[Observed]**

Generated artifacts are committed beside generators: `activity_ui_assets.h`, `harmony_shell_assets.h`, `remote_skin_jpg.h`, MIPS binaries, and emulator binaries. Shell smoke proved deterministic regeneration, but `tools/hub-emu/build/codex_webui.mips` can be stale because default `run.sh` rebuilds only if absent; use `--rebuild` (`tools/hub-emu/run.sh:17-23`). **[Observed/Source]**

### 9.2 Installation planes

| Plane | Behavior | Main risks |
|---|---|---|
| Python/PowerShell | Direct SSH backup/upload/config/start/verify/reboot | Omits pair-agent binary; boot-script replacement; flash limits |
| Docker/Unraid | Once/always/never installer gate, marker, nginx proxy | Marker lacks deployed digests; stale image/payload; accidental repeated install |
| Web updater | Binary-only browser staging/apply | Unauthenticated integrity, partial apply, pair-agent drift |
| Binary push runbook | tmpfs staging + double md5 + atomic rename | Manual; binary-only; rollback artifact discipline |

Installers upload seven binaries—six `codex_*` tools plus `dropbearmulti`—but omit `codex_bt_pair_agent`, while `init.sh` expects it. This set differs from the update endpoint's seven-`codex_*` allow-list (`install_webui.py:305-313,379-387`; `payload/scripts/init.sh:30-44`; `payload/bin/MANIFEST.txt:1-14`; `payload/source/codex_webui.c:72-80`). **[Source]**

### 9.3 Flash, memory, and process constraints

- `/data` and `/cache` are 5 MiB JFFS2; free space is not queryable with available BusyBox. A prior in-place ~670 KiB replace truncated mid-write (`docs/SESSION_HANDOFF.md:340-348`). **[Documented hardware]**
- `/var/volatile` is RAM on a ~62 MiB device; unbounded logs/staging can exhaust memory (`docs/SESSION_HANDOFF.md:346-350`). **[Documented hardware]**
- Each request initially allocates ~1.01 MiB and server forks per connection; save/import are heavier (`docs/FOOTPRINT_AUDIT.md:93-118`). **[Source-derived estimate]**
- Current shell packaging avoids duplicate vendor/skin and external fonts; flash growth was measured as acceptable only with tmpfs staging and rollback discipline (`docs/FOOTPRINT_AUDIT.md:68-91,173-227`). **[Documented measurement]**

### 9.4 Rollback and recovery

| Layer | Recovery | Gap |
|---|---|---|
| Activity save | Lua snapshots + C compensation | Strongest automatic rollback |
| Resource/settings import | Timestamp backups | No automatic bundle rollback |
| Update | `/data/codex/update-backups/<ts>` keep 3 | Manual restore; mixed versions possible |
| Install | `/data/codex-backups/webui-handoff-*` | PowerShell-only restore; omits blocker/egress/activity/binaries |
| Binary push | volatile previous + durable host copy | Requires prepared artifact/operator |
| Recovery AP | reset/TDE-triggered AP + portal | Replaces station Wi-Fi; owner-disruptive |

`restore_backup.ps1:111-116` restores fewer files than `install_webui.py:289-299` backs up; no Python restore counterpart exists. **[Source]**

## 10. Emulator and Test Infrastructure

### 10.1 webui-sim

`tools/webui-sim/server.mjs` is a dependency-free, loopback-only Node mock. It loads a genuine-shaped activity fixture into memory, implements core activity/inventory/control routes, setup stubs and exports, and resets via simulator-only API (`tools/webui-sim/README.md:1-60`). It proves UI/model behavior, not C parsing, filesystem writes, firmware, hardware or production response framing. **[Source]**

Known mock differences: accepts JSON in places production expects forms; flat versus nested activity-state shape; simulator-only `/api/control-button`; incomplete advanced IR/BT/update surface; in-memory revisions and persistence (`tools/webui-sim/server.mjs:191-467`; `tools/hub-emu/README.md:99-130`). **[Source]**

### 10.2 hub-emu

Hub emulator runs actual MIPS `codex_webui` and `codex_hbus` under QEMU, with Python engine and hardware stubs. Ports are dev proxy `8787`, backend `8788`, control `8789`; proxy byte-forwards requests and maps `/sim/*` only to control plane (`tools/hub-emu/README.md:6-68`; `tools/hub-emu/dev-proxy.mjs:94-155`). **[Source]**

It accurately tests request parsing, form-vs-JSON behavior, status/404/409/413 paths, C validation, real resource backup/commit/read-back, routing and MIPS endianness. It does not prove physical remote behavior, IR/BT radiation, activity timing, cloud, broker, true reboot, CPU/RAM timing or flash behavior (`tools/hub-emu/README.md:111-130`; `docs/FOOTPRINT_AUDIT.md:231-238`). **[Source]**

BT stubs synthesize AUTH+ENCRYPT for all BT fixture devices and return connected/code 200, forcing every guard layer true (`tools/hub-emu/stubs/hcitool:6-16`; `tools/hub-emu/stubs/codex_hal_ltcp:9-18`). Reboot only logs; `hciconfig` is no-op; logread is empty. **[Source]**

### 10.3 Test assets and safe execution results

| Asset | Nature | This analysis |
|---|---|---|
| `tools/webui-sim/test/*.test.mjs` | JS unit/model tests | 213/213 passed |
| `docker/tests/test_manager.py` | Python manager unit tests | 9/9 passed |
| `activity_ui_model_smoke.mjs` | Vendored editor graph behavior | Passed; 70 static assertion sites |
| `harmony_shell_smoke.mjs` | Two-pass packaging + contracts | Passed; 49 runtime checks |
| `activity_json_semantic_smoke.sh` | Host-compiled C unit main | Passed; seven test groups |
| `activity_offline_guard.sh` | 41 structural source checks | Passed |
| `bluetooth_hid_smoke.sh` | self-test, compile checks, 25 source guards | Passed; four nonfatal unused-code warnings |
| `hbus_notification_smoke.py` | real host client + loopback WS mock | Passed large request/fragment/correlation scenario |
| `ir_database_smoke_test.mjs` | public IR corpus dry run | 750/750 rows supported; no configuration |
| `hub-emu/qa.mjs` | 65 compiled-backend assertions | Not run: suite exercises mission-forbidden mutations |

Initial directory-style Node/Python discovery commands failed before assertions under Node 24/Python 3.14; explicit file commands passed. This is test-command portability/documentation drift, not product failure. **[Observed]**

## 11. Verification Matrix

Legend: **U** unit/model; **C** contract/static; **E** emulator; **B** browser; **H** hardware; **P** production; **O** owner presence required; **—** no evidence. A mark means explicit evidence exists, not that every branch is covered.

| Feature | U | C | E | B | H | P | O | Current status / evidence |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|---|
| Shell load/assets/routes | ✓ | ✓ | prior E | ✓ | — | ✓ | — | 49 packaging runtime checks; current artifact owner/browser verified |
| Home/dashboard | ✓ | ✓ | ✓ | ✓ | — | ✓ | — | Model + prior browser; state terminal is HBus |
| Activity run/power-off | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | Prior physical-remote success; no new execution |
| Activity save/sync | ✓ | ✓ | prior E | ✓ | ✓ | ✓ | ✓ | Transaction source + emulator prior + hardware handoff |
| Activity roster/reorder/delete | ✓ | ✓ | ✓ | ✓ | partial | partial | ✓ | Shared graph tested; no fresh physical regression |
| Wizard | partial | ✓ | ✓ | ✓ | — | ✓ | ✓ | No dedicated wizard-model test; 16420/map-loss defect |
| Advanced editor | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 70-assertion smoke and prior hardware correction |
| Physical remote graph invariants | partial | ✓ | — | — | ✓ | ✓ | ✓ | Hub/remote asymmetry cannot be emulated |
| IR inventory/device commands | ✓ | ✓ | ✓ | ✓ | partial | ✓ | — | GET contracts verified historically; state-dependent repair |
| IR send | model | ✓ | stub | ✓ | partial | partial | ✓ | HBus boundary/source; no new photon capture |
| IR capture/learn/test | ✓ | ✓ | stub | partial | — | — | ✓ | No current hardware capture proof |
| IRDB/Flipper/LIRC import | ✓ | ✓ | partial | ✓ | — | partial | ✓ | 750-row dry run; import forbidden this mission |
| RemoteCentral | ✓ | ✓ | — | partial | — | — | — | Parser/path tests; outbound fetch not exercised |
| IR batch/cancel/lab | ✓ | ✓ | partial | ✓ | — | ✓ | ✓ | Heap fix owner/browser verified; no hardware sweep |
| BT adapter/pairing | ✓ | ✓ | happy-path stub | ✓ | partial | partial | ✓ | Existing bond evidence; fresh SSP not recorded |
| BT connect/auth guards | ✓ | ✓ | forced-success stub | partial | ✓ | ✓ | ✓ | Guards motivated by prior HAL crashes |
| BT HID text/named keys | ✓ | ✓ | forced-success stub | partial | partial | partial | ✓ | Host self-test; no new radio transcript |
| Saved BT devices/scripts | ✓ | ✓ | partial | ✓ | — | partial | ✓ | Storage/model source; hardware sequence unverified |
| MQTT config/discovery | ✓ | ✓ | config stub | ✓ | — | partial | ✓ | No broker integration this mission |
| MQTT control topics | — | ✓ | — | — | — | — | ✓ | Arbitrary HBus command surface source-only |
| Wi-Fi config | ✓ | ✓ | prior E | ✓ | partial | partial | ✓ | Save/reboot prohibited; newline defect confirmed |
| Backup exports | ✓ | ✓ | prior E | ✓ | — | ✓ | — | Ten individual exports plus bundle; secrets intentionally not retrieved |
| Import/restore | ✓ | ✓ | prior E | partial | — | partial | ✓ | Forbidden this mission; non-atomic gap |
| System status/logs | ✓ | ✓ | partial | ✓ | — | ✓ | — | Heavy HTML probe; no new live call |
| Auth | ✓ | ✓ | prior E | partial | — | partial | ✓ | Lockout-sensitive; no live change |
| Cloud blocker/offline guards | ✓ | ✓ | partial | partial | ✓ | ✓ | ✓ | Structural pass; prior live egress process had died |
| Update status/stage/apply | ✓ | ✓ | prior E | partial | — | partial | ✓ | Apply forbidden; integrity/rollback defects |
| Docker/Unraid manager | ✓ | ✓ | — | — | — | — | ✓ | 9/9 unit tests; no install run |
| Recovery AP | — | ✓ | — | — | partial | partial | ✓ | Source/prior record; disruptive and unexecuted |

### 11.1 Commands executed

```text
node --test tools/webui-sim/test/*.test.mjs                 213 pass
python3 docker/tests/test_manager.py -v                    9 pass
sh tools/activity_json_semantic_smoke.sh                   pass
sh tools/activity_offline_guard.sh                         pass
node tools/activity_ui_model_smoke.mjs                     pass
node tools/harmony_shell_smoke.mjs                         49 checks pass
sh tools/bluetooth_hid_smoke.sh                            pass
cc ... codex_hbus.c && python3 tools/hbus_notification_smoke.py ...  pass
node tools/ir_database_smoke_test.mjs ... --dry-run         750/750 supported
md5/wc + git show HEAD:payload/bin/codex_webui             6f05… / 906872
```

Evidence logs were stored outside the repository under the temporary analysis journal. `git status --short` remained empty until this report was created. **[Observed]**

## 12. Risks and Known Limitations

### 12.1 Confirmed defects

| Priority class | Defect | Impact | Evidence |
|---|---|---|---|
| P0 | No CSRF/Origin/Host validation on all-interface listener | Off-LAN malicious page can drive hub; DNS rebinding can expose responses | `codex_webui.c:8499-8792` |
| P0 | Update has no authenticity/version policy | Arbitrary/downgraded root binary, persistent compromise | `codex_webui.c:7529-7735` |
| P0 | Secret-bearing GET exports | Wi-Fi PSK/MQTT password exfiltration | `codex_webui.c:1812-1838,8581-8602` |
| P0 | Wi-Fi newline injection | Repoint/disconnect hub network | `codex_webui.c:1257-1291` |
| P1 | Wizard drops all existing maps, including required conditional 16420 map | Saves graph advanced editor rejects; physical BT remote behavior can break | `wizard-model.js:198-240`; `activity-ui.js:1920-1926` |
| P1 | Installer/updater/pair-agent drift | Fresh install misses daemon; update restart kills it; BT compatibility absent until restart path | `install_webui.py:305-313`; `init.sh:30-44`; `codex_webui.c:72-80,4516,7716-7733` |
| P1 | Updater points at upstream, not feature fork | Install update can downgrade or erase shell, setup, activity, and pairing work | `codex_webui.c:4516`; `UPSTREAM_REVISION` |
| P1 | Update/import multi-file operations are not transactional | Mixed binaries/settings/resources after flash/write failure | `codex_webui.c:6145-6320,7600-7700` |
| P1 | Restore does not match install backup | Rollback cannot restore complete pre-install policy/runtime state | `install_webui.py:289-299`; `restore_backup.ps1:111-116` |
| P1 | Legacy form HTML still builds three ~12 MiB inventories; HTML/JSON omit Content-Length | Form response can OOM/truncate invisibly; shell/API truncation not detectable by length | `codex_webui.c:988-997,4286-4608,5866-5906` |
| P1 | No child cap/read timeout; heavy import allocations | Slowloris/RAM exhaustion makes hub unavailable | `codex_webui.c:6145-6320,8775-8790` |
| P2 | No cross-process resource lock | Silent lost updates across concurrent forked requests | Fork model + no lock in `codex_webui.c` |
| P2 | Auth plaintext, fail-open, unthrottled | Users can overestimate protection; damaged config disables auth | `codex_webui.c:364-390,831-841` |
| P2 | No pre-rename fsync | Power cut can expose empty/truncated config | `codex_webui.c:247-266` |
| P2 | Cloud isolation is route-based and process-fragile | Brief/alternate egress; disable may not restore gateway | `offline_egress_guard.sh:5,29-46,67-71` |
| P2 | MQTT accepts arbitrary HBus command string | Broker compromise reaches wider engine surface than HTTP validators | `payload/mqtt/codexmqtt.lua:568-586,612-655` |
| P2 | RemoteCentral bypasses blocker policy | Offline promise has explicit outbound exception | `codex_webui.c:1671-1748` |
| P2 | IR logging writes flash per key/batch | JFFS2 wear | `codex_webui.c:4116-4137` |
| P2 | Cached emulator binary can be stale | False QA confidence against older backend | `tools/hub-emu/run.sh:17-23` |
| P3 | IR batch dry-run increments `sent` | Misleading UX/reporting | `codex_webui.c:6406-6416` |
| P3 | Remote hotspot alias collisions (`enter`) | One command may map to multiple keys | `codex_webui.c:4898-4968` |
| P3 | Temporary learned command can survive child death | Stray `Signal Test *` command | `codex_webui.c:8182-8189` |

### 12.2 DeviceList clobber and remote hazards

`/api/activity-save` cannot write DeviceList; `/import target=devices` is the broad replacement path and bypasses activity transaction semantics. Restoring an older list can reset `IsKeyboardAssociated`, BT address/profile metadata or device references, and engine state may remain stale until reload (`docs/SESSION_HANDOFF.md:208-220,372-376`). **[Documented hardware/source]**

Action-less maps can leave a paired remote unresponsive until power-cycle even when hub-side validation appears healthy. The physical remote is a separate firmware authority and is not modeled by QEMU (`README.md:57-99`; `tools/hub-emu/README.md:124-130`). **[Documented hardware]**

### 12.3 Theoretical or context-dependent risks

- Basic credentials traverse clear HTTP: real, but accepted by current trusted-LAN design.
- MD5 collision weakness is secondary; absence of trusted manifest is the primary flaw.
- JSON parser limitations around `\uXXXX` and control bytes are robustness/data-fidelity risks, not demonstrated exploits.
- QEMU CPU/RAM timing is not representative; footprint conclusions are structured estimates/proxies.
- `bluetoothd` process was observed in a prior live handoff despite pair-agent comments assuming it does not run; interaction risk remains unresolved (`payload/source/codex_bt_pair_agent.c:19-23`; `docs/SESSION_HANDOFF.md:61`).

### 12.4 Hard safety lines

- Keep cloud blocker enabled; do not use Logitech app/cloud fallback.
- Do not unpair/factory-reset physical remote.
- Do not bypass BT/HAL crash guards.
- Stage flash writes through tmpfs and verify size/md5 before rename.
- Serialize SSH on low-memory hub.
- Keep owner present for power, remote, network, auth, update, reboot and destructive import tests.
- Never push `origin` (`Ripthulhu`); fork publication only on explicit request.

## 13. Documentation and Implementation Drift

| Source claim | Current resolution |
|---|---|
| `SESSION_HANDOFF.md` pins `5d84cd9` and older binary | Historical; current HEAD/artifact is `3de7b92` / `6f05…` |
| `FRONTEND_REDESIGN_HANDOFF.md` says setup pages sim-only | Superseded by packaging/deployment commits and owner production context |
| `PRODUCTION_PUSH_READINESS.md` candidate hash `08a682…` | Historical candidate; current tracked/live identity is `6f05…` at same size |
| `FOOTPRINT_AUDIT.md` uses pre-shell baseline and older QA counts | Historical measurement; useful methodology, not current artifact identity |
| `API.md` says no HTTP authentication | Stale in general; optional Basic auth exists, default remains off |
| `webui-sim/README.md` short view list | Stale summary; app registers 12 hashes/11 views |
| Handoff says one live 16420 map removed | Live-hub experiment, not repo contract; advanced editor still requires conditional map |
| Wizard says shapes mirror vendored editor | False for multi-surface/16420 maps; wizard destroys them |
| Emulator README says actual backend | True only after rebuild; cached MIPS artifact can be stale |
| Docs/test commands use directory discovery | Node 24/Python 3.14 require explicit files in this environment |
| SECURITY says auth disabled | Omits optional Basic mode and its plaintext/fail-open limits |

Generated-versus-source drift is a structural risk: generated headers, bundled editor, source modules, MIPS binaries, emulator binaries and MANIFEST are all committed. Shell smoke covers deterministic generation and vendor byte identity, but no CI enforces regeneration or blob hashes. **[Source/Observed]**

Module boundaries are mixed. Frontend source is reasonably separated by view/model/API/state, but backend remains an 8,793-line C translation unit with routing, parsing, HTML, persistence, HBus/HAL shelling, update, auth and every feature. Similar validation/graph logic exists in advanced editor, wizard, repair tool, Lua writer, simulator and tests, producing the observed 16420 drift. **[Source-derived]**

## 14. Prioritized Recommendations

No recommendation was implemented.

### P0 — data loss, lockout, security, hub availability

| Recommendation | Evidence / user impact | Components | Proposed solution | Verification | Effort |
|---|---|---|---|---|---|
| Add Host/origin/CSRF enforcement | Cross-site mutation/rebinding (`codex_webui.c:8499-8792`) | request parser/auth, frontend forms | Allow trusted Host/IP names; reject cross-origin state changes; add per-session CSRF token | Negative browser tests for foreign Origin/Host; same-origin flows pass | Medium |
| Authenticate updates cryptographically | Client supplies manifest/hash/blob (`:7529-7735`) | updater C + browser/release pipeline | Signed manifest with pinned public key; monotonic version/downgrade confirmation | Tampered/signed/old manifest contract tests; recovery drill | Large |
| Split/redact secret exports | Raw WPA/MQTT/bundle GETs (`:1812-1838,8581-8602`) | export handlers, backup UI | Default redacted exports; separately danger-confirmed encrypted owner backup | Assert no PSK/password in ordinary responses; encrypted restore round-trip | Medium |
| Sanitize Wi-Fi values | Newline injection (`:1257-1291`) | `save_wifi`, import validation | Apply `clean_config_value`, reject CR/LF/control chars; parse complete WPA shape | Unit tests `%0A`, directives, quotes, valid Unicode SSID | Small |
| Bound server resources | Fork/slowloris/import heap (`:6145-6320,8775-8790`) | accept loop, request reader/importer | Child concurrency cap, accepted-socket timeout, smaller/streamed import buffers | Slow-client/concurrency/RSS tests on QEMU and hardware | Medium |

### P1 — broken or incomplete core functionality

| Recommendation | Evidence / impact | Components | Proposed solution | Verification | Effort |
|---|---|---|---|---|---|
| Preserve complete wizard activity graph | Wizard removes all maps; editor requires conditional 16420 | `wizard-model.js`, editor, tests | Preserve all non-owned maps; generate conditional HID map from shared graph composer; retain top-level keys | New wizard-model tests for BT, two surfaces, edit/delete/reorder; advanced validator passes without repair | Medium |
| Unify binary inventory/lifecycle | Pair agent omitted/killed (`install_webui.py`, updater, `init.sh`) | installers, JS names, C allow-list/restart | Single generated artifact manifest drives upload/update/restart; restart agent after update | Fresh install/update on emulator; process/md5 matrix; BT regression with owner | Medium |
| Make update/import transactional | Partial writes leave mixed state | C update/import handlers | Stage all files, free-space gate, commit marker, automatic rollback on any error | Fault injection after every file/rename; exact pre-state restored | Large |
| Make restore symmetric | Restore omits backed-up policy/activity files | Python/PowerShell installer/restore | Shared backup manifest and cross-platform restore; include binaries and blocker/activity files | Install -> mutate fixture -> restore -> byte/hash compare | Medium |
| Fix legacy page memory/framing | Three 12 MiB inventories + no Content-Length | IR inventory model, `render_page`, shell/JSON framing | Replace fixed per-device command arrays with dynamic storage; buffer/length or chunked framing | Low-memory QEMU/hardware form response; truncation detection tests | Medium |

### P2 — reliability, testing, maintainability

| Recommendation | Evidence / impact | Components | Proposed solution | Verification | Effort |
|---|---|---|---|---|---|
| Add resource locks and fsync | Lost updates/power-cut window | atomic writer and mutating handlers | Advisory lock per resource transaction; `fsync` file + parent directory | Concurrent writer and power-failure simulation | Medium |
| Harden cloud blocker | Route monitor gaps/volatile gateway | egress guard, Lua policy, UI | Consistent token parser; firewall/IPv4+IPv6 policy; persistent gateway recovery; watchdog | DHCP/link/reboot/disable tests; WAN blocked continuously | Medium |
| Restrict MQTT HBus surface | Arbitrary `cmd` bypasses HTTP allowlists | `codexmqtt.lua` | Explicit verb/schema allow-list; optional feature flag for raw HBus | Broker fuzz/retained/duplicate/unauthorized verb tests | Small |
| Make emulator current by default | Cached backend can be stale | `run.sh`, generated artifacts | Hash source/headers and rebuild on mismatch; emit tested SHA/md5 | CI asserts emulator blob equals fresh build | Small |
| Add CI and contract generation | Manual regeneration and duplicated constants | package/build/tests | CI for explicit test commands, generated diff, MIPS build, source/model contract generation | Clean checkout produces zero diff and all tests pass | Medium |
| Decompose `codex_webui.c` | 8,793-line mixed responsibility | C backend | Extract HTTP, activity, IR, BT, setup, update modules without behavior change | Golden route table + QEMU contract suite | Large |
| Move/limit per-key IR logs | JFFS2 churn | IR logger | Volatile or opt-in logging; buffered/bounded persistence | Flash-write count and rotation tests | Small |

### P3 — UX and optional enhancements

| Recommendation | Evidence / impact | Components | Proposed solution | Verification | Effort |
|---|---|---|---|---|---|
| Correct dry-run counters and temp cleanup | Misleading `sent`; orphan temp commands | batch/test-learned handlers | Report `wouldSend`; finally-style cleanup/sweep | Unit/fault-injection tests | Small |
| Audit remote hotspot aliases | Duplicate `enter` mapping | `IR_REMOTE_BUTTONS` | Deterministic precedence and collision test | Exhaustive alias uniqueness report | Small |
| Improve status APIs | System page parses heavy legacy HTML | system backend/view | Small read-only `/api/system-status` and `/api/logs` with caps | Contract/perf tests on hub | Medium |
| Expand accessibility QA | No axe/keyboard/screen-reader suite | shell/views | Automated axe + keyboard/focus tests at 390/840/1280 | CI WCAG regression gate | Medium |

## 15. Evidence Index

### 15.1 Primary implementation

- `payload/source/codex_webui.c` — HTTP, shell/assets, activity/IR/BT/setup/update/export/import contracts.
- `payload/activity/codexactivity.lua` — activity validation, three-resource transaction, etag/hetag/digest, compensation.
- `payload/web/activity-ui.js` — advanced editor graph model/repair/validation.
- `tools/webui-sim/public/js/app.js`, `api.js`, `state.js`, `views/*`, `wizard-model.js` — production shell source and route/view behavior.
- `payload/source/codex_hbus.c`, `codex_hal_ltcp.c`, `codex_bthid_keyboard.c`, `codex_bt_pair_agent.c` — firmware/radio boundaries.
- `payload/source/codex_dhcpd.c`, `codex_portal.c` — recovery AP DHCP and captive portal binaries.
- `payload/mqtt/codexmqtt.lua` — MQTT discovery/state/control surface.
- `payload/scripts/init.sh`, `rcS.local`, `netservicestarter.lua`, `offline_egress_guard.sh`, `recovery_ap.sh` — boot/offline/recovery.
- `install_webui.py`, `install_webui.ps1`, `restore_backup.ps1`, `docker/manager.py`, `Dockerfile`, `compose.yaml`, `unraid/harmony-hub-control.xml` — deployment lifecycle.
- `Install_Harmony_Control.cmd` — Windows launcher; `examples/mqtt-config.example.json` — MQTT configuration schema example.

### 15.2 Generated and packaged artifacts

- `tools/package_harmony_shell.sh` -> `payload/source/harmony_shell_assets.h`.
- `tools/embed_activity_ui.sh` -> `payload/source/activity_ui_assets.h`.
- `payload/source/remote_skin_jpg.h` — remote image.
- `payload/bin/codex_webui`, `payload/bin/MANIFEST.txt` — shipped binary identity.
- `build/build_harmony_tools_kali.sh` — legacy full-toolchain build.

### 15.3 Test and emulator evidence

- `tools/webui-sim/test/*.test.mjs` — 213 executed unit tests.
- `docker/tests/test_manager.py` — nine executed tests.
- `tools/activity_ui_model_smoke.mjs` — 70 assertion sites, executed.
- `tools/harmony_shell_smoke.mjs` — 49 runtime checks, executed.
- `tools/activity_graph_repair.mjs` — live/dry-run graph repair and validation; `tools/bluetooth_device_bridge.mjs` — Bluetooth device/map cloning; `tools/chrome_ui_smoke.mjs` — legacy CDP smoke tool.
- `tools/activity_json_semantic_smoke.sh`, `activity_offline_guard.sh`, `bluetooth_hid_smoke.sh`, `hbus_notification_smoke.py`, `ir_database_smoke_test.mjs` — executed as described in §10/§11.
- `tools/hub-emu/*` — source-reviewed; full QA not executed due mission prohibitions.

### 15.4 Documents treated as leads/historical evidence

- `README.md` — feature status, paired-remote constraints, repository/build/install overview.
- `DESIGN.md` — design intent and production-shell source-of-truth statement.
- `docs/SESSION_HANDOFF.md` — prior hardware and firmware investigation; pinned to older state.
- `docs/PRODUCTION_PUSH_READINESS.md` — historical production-readiness measurements/runbook.
- `docs/FRONTEND_REDESIGN_HANDOFF.md` — sim-first design history and boundaries.
- `docs/FOOTPRINT_AUDIT.md` — historical flash/RAM/CPU methodology and measurements.
- `docs/API.md` — intended API contract; optional-auth/update/setup details partly stale.
- `docs/SECURITY.md` — stated trusted-LAN security policy; predates optional Basic auth (see §8.2, §13).
- `docs/AI_HANDOFF.md`, `docs/BUILD.md`, `docs/GITHUB_SETUP.md`, `CONTRIBUTING.md` — older architecture, build, repository, and contribution context.
- `UNRAID.md` — container deployment procedure; `UPSTREAM_REVISION` — machine-readable upstream baseline pin.
- `tools/webui-sim/README.md`, `tools/hub-emu/README.md` — development/emulation contracts.

### 15.5 Git and external provenance

- Fork branch is 24 commits ahead, zero behind upstream base `d87ceba`; HEAD is publicly resolvable at `schlambos/harmony-hub-control`.
- Upstream issue [#2](https://github.com/Ripthulhu/harmony-hub-control/issues/2) and PR [#3](https://github.com/Ripthulhu/harmony-hub-control/pull/3) address dynamic IR inventory memory and Content-Length; fork commit `4bdb1a7` only heap-moves the IR-lab lookup. Current form-page OOM/framing gap remains. **[External]**
- No remote was written; `origin` is the prohibited Ripthulhu upstream, `fork` is schlambos.

**Final readiness verdict:** Harmony Hub Control at `3de7b92` is feature-rich and demonstrably functional for an informed owner on a trusted LAN, with strong local activity transaction design and credible prior hardware evidence. It is not production-safe for untrusted or broadly accessible networks, unattended updates, or recovery-free configuration changes. Highest-priority remaining work is cross-origin/Host protection, signed/versioned updates, secret-safe exports, Wi-Fi sanitization, wizard graph preservation, pair-agent lifecycle parity, transactional update/import, and complete rollback. Until those land, retain cloud isolation, tmpfs/md5 deployment gates, owner-presence rules, and manual rollback readiness.
