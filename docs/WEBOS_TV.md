# Network TVs: LG webOS TV (Hub-Native)

Melodious can control an LG webOS TV directly over your LAN — no Home Assistant
bridge and no IR line of sight required. The hub speaks LG's SSAP protocol over
WebSocket (`wss://<tv>:3001` with automatic fallback to `ws://<tv>:3000` for older
webOS generations), uses the TV's pointer-input socket for navigation keys, and
wakes the TV from standby via Wake-on-LAN.

A native LG webOS TV is an ordinary Harmony hub device (`melodious-webos-<id>`),
so it works in activities, on physical remotes, on Touch screens, and in the Web,
Desktop, and Android apps alongside any IR, Bluetooth, Android TV, or Home
Assistant devices.

Nothing leaves your LAN, and the cloud blocker stays on.

## Requirements

- An LG webOS TV on the same LAN as the hub.
- **LG Connect Apps** enabled on the TV (Settings → General → Network → LG Connect Apps, or Settings → General → External Devices → TV On With Mobile / LG Connect Apps depending on webOS version).
- **Fixed IPv4 address** (DHCP reservation on your router) so the hub always finds the TV.
- **For Power On from standby (Wake-on-LAN):**
  - Enable **Mobile TV On** / **Turn on via Wi-Fi** (or **Turn on via Ethernet**) on the TV.
  - Note the TV's **MAC address** (Settings → General → Network → Wi-Fi / Wired Connection, or from your router's DHCP table).
  - Note: LG webOS has **no** discrete `PowerOn` SSAP command. When a MAC address is configured, Melodious wires discrete `PowerOn` (Wake-on-LAN) and `PowerOff` (`ssap://system/turnOff`). Without a MAC address, Melodious does **not** emit a fake `PowerOn`; it wires honest `PowerToggle` instead.

## Add and pair an LG webOS TV

Device creation and pairing live in the **Web and Desktop apps** (the Android app
controls, edits settings on, and includes native LG webOS TVs in activities once
added, matching the Android TV workflow).

1. Power the LG TV **on** (it must be awake to accept pairing).
2. In Melodious Web or Desktop, open **Devices → + → LG webOS TV on the network**.
3. Enter:
   - **TV name** (e.g., *Living Room LG*)
   - **TV IPv4 address** (e.g., `192.168.1.40`)
   - **TV MAC address** (optional, e.g., `AA:BB:CC:11:22:33` — required for discrete Wake-on-LAN `PowerOn`)
4. Tap **Pair with TV**. Melodious connects over `wss://:3001` (falling back to
   `ws://:3000` if needed) and prompts the TV.
5. On the LG TV screen, choose **Accept** using the LG remote.
   - If you choose **Deny** (or cancel), Melodious reports the refusal clearly and
     stores no credential; tap **Pair with TV** to try again.
   - Once accepted, the TV returns a pairing `client-key` that `codex_webos` saves
     privately on the hub (`/data/codex/webos/tvs.tsv`, mode `0600`). The key is
     never logged, never written to `DeviceList.json`, and never returned in API
     responses (only `paired: true|false` is exposed).
6. Tap **Refresh inputs & apps** (or let pairing finish populating them) to import
   your TV's stable HDMI ports (`HDMI_1`–`HDMI_4`) and installed launchable apps
   (`App Netflix`, `App Plex`, etc.).
7. Tap **Add LG webOS TV**. The device opens on its page with live connection
   status, tappable commands, and a managed Touch device screen.

## Supported commands

Command names mirror the proven `ha-melodious` webOS profile so native and
HA-bridged LG devices feel identical in activities:

- **Power:** `PowerOn` (Wake-on-LAN, only emitted when MAC is configured), `PowerOff` (`ssap://system/turnOff`), `PowerToggle`
- **Volume:** `VolumeUp`, `VolumeDown`, `Mute` (toggle via `getVolume` + `setMute`)
- **Inputs:** `Input HDMI 1`–`Input HDMI 4` (stable `HDMI_1`–`HDMI_4` port IDs via `tv/switchInput`, never fragile CEC labels)
- **Apps:** `App <Name>` commands discovered via `com.webos.applicationManager/listApps` and launched via `com.webos.applicationManager/launch`
- **Transport:** `Play`, `Pause`, `PlayPause`, `Stop` (`ssap://media.controls/*`)
- **Navigation & remote keys (via pointer-input socket):** `DirectionUp`, `DirectionDown`, `DirectionLeft`, `DirectionRight`, `Select`, `Back`, `Home`, `Exit`, `Menu`, `Guide`, `Info`, `ChannelUp`, `ChannelDown`, `Red`, `Green`, `Yellow`, `Blue`, `0`–`9`, `Dash`, `Record`

When the TV is unreachable or turned off, non-power commands fail immediately with
a clear error rather than succeeding silently. Once the TV wakes or comes back on
the LAN, `codex_webos` reconnects automatically using the stored `client-key`.

## Native vs Home Assistant webOS bridge

Both paths coexist independently — you can run a native LG webOS TV and an
HA-bridged LG webOS TV on the same hub (with distinct names) without conflict.

| Capability | Hub-native (`codex_webos`) | HA-bridged (`ha-melodious` + HA `webostv`) |
| --- | --- | --- |
| Requires Home Assistant | **No** (hub talks directly to TV on LAN) | Yes |
| Power On (WoL) & Power Off (`turnOff`) | Yes | Yes |
| Volume, Mute, HDMI 1–4, App launch, Transport | Yes | Yes |
| D-pad / Select / Back / Home / Exit | Yes (pointer-input socket) | Yes (`webostv.button`) |
| Live theater / ARC / CEC signal strip | Not in scope | Yes (via HA `WebOSObservations`) |
| Media artwork / now-playing | Not in scope | Via HA |

## Transport design (`wss://:3001` and `ws://:3000`)

Modern LG webOS TVs (webOS 6 / 2022+) require TLS WebSocket (`wss://<tv>:3001`
with a self-signed TV certificate) and reject or redirect plaintext port 3000.
Older LG webOS TVs (webOS 3–5) serve plaintext `ws://<tv>:3000`.

`codex_webos` links BearSSL 0.6 (already vendored for `codex_androidtv`) and
defaults to `auto` transport: it tries `wss://<tv>:3001` first (accepting the
TV's self-signed RSA or ECDSA certificate while authenticating with the paired
`client-key`), automatically falls back to `ws://<tv>:3000` if port 3001 refuses
or fails, and remembers whichever transport succeeded.

## How it works on the hub

```text
Harmony engine ──HTTP POST 127.0.0.1:8096/cmd──► codex_webos ──wss:3001 / ws:3000──► LG TV
                                                     │   └──pointer WebSocket──────► LG TV
                                                     └──UDP Wake-on-LAN (ports 7/9)► LAN
web/desktop app ──/api/webos/*──► codex_webui ──proxy──► codex_webos (127.0.0.1:8096)
```

- **`codex_webos`** (`payload/source/codex_webos.c`, BearSSL 0.6) listens on
  `127.0.0.1:8096` only and is kept running by `/data/codex/webos_service.sh`.
- **Storage:** `/data/codex/webos/tvs.tsv` (mode `0600`, atomic write-and-rename)
  stores each TV's id, host, MAC, transport preference, name, and `client-key`.
- **Devices:** `codexactivity`'s `CommitWebOsDevices` creates `Television`
  (`Transport = 64`) devices with `AutoDetectedDevice.Id = melodious-webos-<id>`
  and `{d}`, `{host}`, `{mac}`, `{keySlot}` tokens — never the `client-key`.
- **Android gap:** Adding, editing network host/MAC, and pairing native LG webOS
  TVs is currently Web/Desktop-only (same as Android TV). Once added, Android
  fully supports the TV in activities, remote/command screens, badges, and
  Device Settings.

## Limitations and out of scope

- Magic Remote cursor/pointer movement, voice search, TV toast notifications,
  media artwork/now-playing state, and broadcast channel tuning beyond
  `ChannelUp`/`ChannelDown`/digits are intentionally out of scope.
- Adding and pairing LG webOS TVs is Web/Desktop-only; Android controls existing
  paired devices.
- Wake-on-LAN requires the TV's MAC address and the TV's *Mobile TV On* setting
  enabled; some TVs disable Wi-Fi WoL in deep energy-saving standby (wired
  Ethernet or disabling Quick Start+ restrictions helps).

## Testing without a real TV

Build the native host binary with BearSSL 0.6 and run the mock-TV protocol spike,
integration suite, and Wake-on-LAN unit tests:

```sh
cc -O2 -Ibuild/tmp/bearssl-0.6/inc -Ibuild/tmp/bearssl-0.6/src \
  -o build/output/codex_webos-native payload/source/codex_webos.c \
  $(find build/tmp/bearssl-0.6/src -name '*.c' | LC_ALL=C sort)

python3 tools/webos/webos_spike_test.py --codex-webos build/output/codex_webos-native
python3 tools/webos/webos_smoke.py --codex-webos build/output/codex_webos-native
sh tools/webos/wol_test.sh
```
