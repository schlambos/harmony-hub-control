# Harmony Hub Control — Native Android App (`Android/`)

A native Kotlin + Jetpack Compose replacement for the discontinued Logitech Harmony Android app, built specifically around **Harmony Hub Control** (`codex_webui` on `:8080` + stock `hbus` WebSocket on `:8088`).

No cloud login, no WebView wrapper, and zero outbound internet traffic required for normal operation. If you turn on update checks (the app asks once), it asks GitHub once a day for Melodious's releases; GitHub sees your IP address and the app's version. Nothing downloads until you tap **Install**: the app then downloads the APK from the GitHub release, checks it against the release's `SHA256SUMS.txt` and against its own signing key, and Android installs it over the app (on Android 12+ without a system dialog, once you've allowed "Install unknown apps" for Melodious). The other optional exception is the Logitech catalog in a device's **Import codes** sheet: only when you sign in (in Chrome), search, download one device, or type in the Brand/Model fields does the app talk to Logitech's catalog services, from the phone, with your own account. Your Logitech sign-in stays on the phone (tokens encrypted with the Android Keystore); the hub only ever receives the same catalog-import command rows the web app sends.

---

## Architecture & Module Layout

```text
Android/
├── settings.gradle.kts
├── build.gradle.kts
├── gradle/libs.versions.toml
├── core-protocol/          # Pure Kotlin JVM library (unit-testable on JVM without Android framework)
│   ├── model/              # HarmonyModels.kt & RemoteLayout.kt (43 percent hotspots, aliases, skin power rules)
│   ├── graph/              # ActivityGraphBuilder.kt (Port of wizard-model.js: offline ID allocator above
│   │                       #   Logitech floors 52,944,089 / 1,878,029,713, 16414 + 16420 BT HID map preservation,
│   │                       #   role-based default button derivation, and action-less button pruning)
│   ├── ir/                 # IrProtocolTools.kt (Pronto 0000 hex -> Harmony raw F...P...S..., IRDB CSV/pipe parser)
│   ├── discovery/          # HarmonyHubDiscovery.kt (SSDP UDP 1900 multicast + Android Emulator 10.0.2.2 probes)
│   ├── hbus/               # HBusWebSocketClient.kt (ws://<hub>:8088 continuous press/hold/release & live push)
│   └── rest/               # CodexHubRestClient.kt (http://<hub>:8080 REST client for config, IR, BT, exports)
├── core-ssh/               # Direct SSH Provisioner & Emergency Recovery (root@<hub>:22 via JSch)
│   └── ssh/                # HubSshProvisioner.kt (BusyBox-safe inspection & Web UI auth lockout reset)
└── app/                    # Jetpack Compose Android Application
    ├── assets/             # Genuine Harmony remote-skin.jpg from tools/webui-sim/public/assets/
    ├── ui/theme/           # RackConsoleTheme.kt (Exact DESIGN.md charcoal/amber/teal/danger tokens)
    ├── ui/components/      # RackConsoleTopBar, RackPanel, RackNoticeBanner, DangerGuardButton
    ├── ui/remote/          # Photo-real virtual handset, Eyes-Free Gesture Touchpad, BT HID IME/Voice drawer
    ├── ui/activities/      # Activity roster, 0-buttons warning badge, 4-step Guided Wizard with auto-apply picker
    ├── ui/ir/              # Master-Detail IR Studio: Commands, Learn IR, IRDB/Pronto Import, Batch Sweeper
    ├── ui/admin/           # SSDP LAN scanner, Bluetooth SSP pairing, System Cloud Blocker, SSH Recovery
    └── system/             # HarmonyQuickTileService.kt (Android Quick Settings Tile for 1-swipe Power Off)
```

---

## Key Features Beyond Web & Official Logitech App

1. **Dual-Channel Transport (`:8080` REST + `:8088` HBus WebSocket):**
   - Uses `:8088` WebSocket for real-time continuous `press` → `hold` → `release` volume/navigation ramping and instant state push when someone uses the physical Harmony remote.
   - Uses `:8080` (`codex_webui`) for compensated 3-resource activity saves (`ActivityList.json`, `MapList.json`, `FunctionList.json`), IR capture, and local Bluetooth SSP pairing.
2. **Physical Phone Volume Rocker & Tactile Haptics:**
   - Pressing your phone's hardware Volume Up / Down keys dispatches the active activity's resolved Volume command with tactile haptic feedback.
3. **Photo-Real Handset + Eyes-Free Gesture Touchpad:**
   - Switch anytime between the authentic Harmony remote skin (`remote-skin.jpg` with 43 percent hotspots) and an **Eyes-Free Touchpad** (swipe for D-pad, tap for `OK`, double-tap for `Back`, long-press for `Menu`).
4. **Native Android Keyboard & Voice Dictation to Bluetooth HID:**
   - Type or use Android microphone voice dictation to stream characters directly to `/api/bt-text` (`codex_bthid_keyboard`) on your paired NVIDIA SHIELD, Android TV, or HTPC.
5. **Android Quick Settings Tile & Deep Links:**
   - Add the **Harmony Power Off** tile to your Android notification shade for one-tap power off from any app, or trigger `harmony://hub/activity/<id>` and `harmony://hub/poweroff` from NFC tags, Tasker, or Home Assistant.
6. **Direct SSH Lockout Recovery from Phone:**
   - Paste your `harmony_owner_*` key in the **Hub & BT** tab to inspect `/data/codex/bin` or clear a `/data/codex/webui_auth.conf` sign-in lockout directly over SSH (`root@<hub-ip>:22`).

---

## Running Against the Existing Simulator or Hub Emulator

1. Start the repository's zero-dependency UI simulator on your host machine:
   ```bash
   node tools/webui-sim/server.mjs
   ```
   *(Or start the full MIPS QEMU emulator via `tools/hub-emu/run.sh`)*
2. Open the `Android/` directory in **Android Studio** (Ladybug / Meerkat or newer) and run the `:app` configuration on an Android Emulator or physical Android device.
3. On an Android Emulator, `HarmonyHubDiscovery` automatically probes `http://10.0.2.2:8787` (UI simulator) and `http://10.0.2.2:8080` (QEMU hub emulator) and connects automatically on launch. On a physical phone, it broadcasts an SSDP `M-SEARCH` on `239.255.255.250:1900` to find your live Harmony Hub on the LAN.
