# Network TVs: Android TV and Google TV

Melodious can control an Android TV or Google TV set over the network instead of
by IR. The hub pairs with the TV the way Google's own TV remote app does, then
sends every key over your network: power on and off, the D-pad, volume, inputs,
digits, colour keys and app launches. A network TV is an ordinary hub device, so
it goes into activities, onto buttons and onto Touch screens like any other.

Why bother when the TV has IR: IR needs line of sight, and many Android TVs
answer IR power-on badly or not at all from standby. Over the network the hub
knows whether the TV is on, so PowerOn and PowerOff never toggle it the wrong
way.

Nothing goes through Google or Logitech, and the cloud blocker stays on.

## Requirements

- An Android TV or Google TV set (or box) that offers Google's TV remote
  service. Almost all do: it is what the Google TV phone app uses. HA's
  `androidtv_remote` integration uses the same service.
- The TV on the same network as the hub, best with a fixed address (a DHCP
  reservation on the router).
- For power-on from standby: the TV has to keep its network up, or wake on
  Wake-on-LAN. See [Power](#power).

## Add a TV

1. **Devices → + → Android or Google TV on the network.**
2. Pick the TV from the list the hub finds on the network, or type its address.
   The first time, the hub makes its own key, which takes up to half a minute.
3. The TV shows a 6-character code. Type it in. A mistyped code is caught on
   the hub before it reaches the TV, so you can correct it and the TV keeps
   showing the same code.
4. Name the TV and tap **Add TV**. It opens on its own device page, with its
   connection on top: *Network TV · Connected · On · 192.168.1.40*.

Then use it in activities like any other device: the activity wizard offers its
HDMI inputs, and its power uses PowerOn and PowerOff.

To remove it, delete the device (⋮ → Delete device). The hub also unpairs it. A
TV that an activity or button still uses can't be deleted until it's taken out
of them.

## Commands

| Command | Sends |
|---|---|
| PowerOn, PowerOff | The power key, only when the TV is in the other state (see Power) |
| PowerToggle | The power key |
| DirectionUp/Down/Left/Right, Select | The D-pad and OK |
| Back, Home, Menu, Settings, Info, Guide, Search, Assistant | Those keys |
| VolumeUp, VolumeDown, Mute | Volume keys. Holding a button repeats, as with any IP command |
| ChannelUp, ChannelDown, PrevChannel | Channel keys |
| Play, Pause, PlayPause, Stop, FastForward, Rewind, SkipForward, SkipBack, Record | Media keys |
| InputHdmi1 to InputHdmi4, InputNext | The HDMI input keys and the input menu. The device's inputs HDMI 1-4 use them |
| Number0 to Number9, Red, Green, Yellow, Blue, Captions | Those keys |

Whether a TV honours the HDMI input keys depends on the TV. If yours doesn't,
let a source switch it by HDMI-CEC, or use InputNext.

## Power

PowerOn and PowerOff are discrete for the Harmony engine, but many TVs ignore
Android's separate wake and sleep keys and only answer the power key. So the hub
sends the power key only when the TV reports the other state: PowerOn on a TV
that is already on does nothing.

How a TV turns on from standby depends on how it sleeps:

- **Network still up** (many TVs keep it for a while, or for good with a
  "network standby" or "quick start" setting): the hub sends the power key.
- **Network down** (deep standby): the hub sends a Wake-on-LAN packet to the
  TV's address on the network (learned when it pairs) and then the key if it's
  still needed.

Wake-on-LAN usually works only on the TV's built-in Ethernet port. A USB network
adapter loses power when the TV sleeps, and some TVs drop Wi-Fi entirely. Look
in the TV's settings for *Wake on LAN*, *Wake on Wireless Network*, *Network
standby* or *Quick start*.

## Moving TVs

If the TV gets a new address, the hub finds it again on the network by the
Bluetooth address it announces (after a minute of not reaching it) and carries
on. A DHCP reservation is still the reliable way.

## How it works

```text
Harmony engine ──HTTP POST 127.0.0.1:8095/cmd──► codex_androidtv ──TLS 6466──► TV
  {"device":"androidtv1a2b3c4d","command":"VolumeUp"}         Android TV Remote v2
web app ──/api/androidtv/*──► codex_webui ──proxy──► codex_androidtv ──TLS 6467──► TV (pairing)
```

- **codex_androidtv** (`payload/source/codex_androidtv.c`) is a small daemon on the hub,
  listening on 127.0.0.1 only. It keeps one TLS connection to each paired TV
  (Android TV Remote protocol v2: varint-length protobuf messages, pings every
  5 s), answers the engine at once, and sends keys as soon as the TV is
  connected. It pairs new TVs (the "polo" pairing protocol on port 6467), finds
  them with mDNS (`_androidtvremote2._tcp`) and wakes them with Wake-on-LAN.
  TLS is [BearSSL](https://bearssl.org/) 0.6. About 260 KB on flash and about
  200 KB of RAM with a TV connected.
- **Identity.** On first start the hub makes one RSA-2048 key and a self-signed
  certificate (`/data/codex/androidtv/client.key.der`, `client.crt.der`, mode 0600)
  in a low-priority background process. Each TV's certificate is pinned when it
  pairs (`tv-<id>.crt.der`): the code typed from the TV's screen authenticates
  both ends, and afterwards the hub talks only to that key. Paired TVs are
  listed in `tvs.tsv` (id, address, MAC, Bluetooth address, name).
- **Devices.** codexactivity's `CommitAndroidTvDevices` writes them with the same code
  as Home Assistant devices (see [HOME_ASSISTANT.md](HOME_ASSISTANT.md) for the
  engine's rules, each verified on hardware): `TransportType` 64 commands, a
  protocol `Melodious Android TV` whose `ControlSection` posts
  `{"device":"{d}","command":"{c}"}` to `http://127.0.0.1:8095/cmd`, and
  `AutoDetectedDevice.Id` `melodious-androidtv-<deviceId>`. The command set is fixed,
  so a request names only the TV, its name, manufacturer and model.
- **Rules it keeps:** the engine drops an IP command that waited more than
  500 ms and rescans SSDP after a non-200 answer, so codex_androidtv always answers
  200 at once and acts afterwards. Keys wait for a connection up to 8 s
  (PowerOn 20 s, long enough for a TV to wake).
- **Running it.** `init.sh` starts `/data/codex/androidtv_service.sh`, which keeps one
  codex_androidtv running and restarts it 5 s after it exits. Its log is in RAM:
  `/var/volatile/codex-androidtv.log`, kept under 64 KB.

## Troubleshooting

- **The TV isn't in the list.** It must be on and on the hub's network (mDNS
  doesn't cross VLANs). Type its address instead.
- **"Could not reach the TV"**: check the address, and that the TV is on. Some
  TVs turn the remote service off in deep standby.
- **Not connected on the device page.** The TV is off the network (deep
  standby, or a new address). PowerOn still tries Wake-on-LAN.
- **A TV that was reset forgets its pairings.** Delete the device and add the
  TV again.
- **Logs:** `ssh root@<hub> cat /var/volatile/codex-androidtv.log`, and
  `GET /api/androidtv/status`.

## Testing without a TV

`tools/androidtv/fake_tv.py` is a fake Android TV (pairing and remote, standard
library plus `openssl`). `tools/androidtv/androidtv_smoke.py` runs a native codex_androidtv
against it and checks pairing, the typo check, keys, the discrete power logic,
unknown commands and restarts:

```bash
python3 tools/androidtv/androidtv_smoke.py --codex-androidtv build/output/codex_androidtv-native
```

Build the native binary with the codex_androidtv command in [BUILD.md](BUILD.md),
using `-target x86_64-linux-musl` (or your host's target) instead of the MIPS
one. The writer has its own Lua tests:
`luajit tools/touch-validator/codexactivity-androidtv-devices-test.lua`.

Protocol references: the
[androidtvremote2](https://github.com/tronikos/androidtvremote2) library (MIT),
and the [protocol write-up](https://github.com/Aymkdn/assistant-freebox-cloud/wiki/Google-TV-(aka-Android-TV)-Remote-Control-(v2)).
