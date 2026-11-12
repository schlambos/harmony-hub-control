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
4. Name the TV and tap **Add TV**. Its manufacturer and model are filled in
   from what the TV reports once paired (change them if they're wrong); they're
   saved with the device like any other's, and **Edit details** changes them
   later. It opens on its own device page, with its connection on top:
   *Network TV · Connected · On · 192.168.1.40*.

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
| InputHdmi1 to InputHdmi4, Input5 to Input32 | The TV's inputs: what each opens is set in Settings → Inputs (see Inputs). The device has Input5 and up only while an input uses them |
| InputNext | The input menu key |
| Number0 to Number9, Red, Green, Yellow, Blue, Captions | Those keys |

## Inputs

TVs switch inputs in different ways, so each network TV says how in its
**Settings → Inputs** (the button at the top right of its device page):

| Way | What the hub sends | Good for |
|---|---|---|
| Open each input directly | An app link to the input's TV-input passthrough URI, from a pattern (`…%2FHW{n}`) and a number per input, or a whole link per input | TVs that ignore the input keys, such as Hisense |
| Android input keys | Android's TV input keys: HDMI 1-4 (KEYCODE_TV_INPUT_HDMI_1 to 4), AV, Component, VGA, Live TV | Many other TVs |
| Input menu, then keys | The input menu key, Down to the input's place in the menu, Select, with a gap between keys | The last resort, when neither of the others works |
| Don't switch inputs | Nothing | TVs whose sources switch them by HDMI-CEC |

The same section lists the inputs: their names (what activities use), their
order, and what each opens. **Add input** and ⋮ → **Remove** add and remove
inputs, up to 32. Behind each input is one of the device's input commands
(InputHdmi1-4, then Input5 and up), so renaming or reordering inputs doesn't
change the activities and buttons that use them.

The hub can't see the screen, and a TV doesn't say which input it shows (any
passthrough link, even a wrong one, opens the TV's input app). So the page
asks:

- **▶ Try** on an input sends it (the TV's Home first, then the input) and asks
  whether the TV switched to it. *Yes* marks it as working; *No* offers the next
  number to try; *It showed a different input* swaps the two inputs' targets.
  The TV has to be connected and on; the page can turn it on.
- **Find my inputs…** steps through the candidates (input numbers, keys or menu
  places) and asks what's on screen after each: one of your inputs, a new one
  (name it), an input with no picture, or nothing. It stops when every input is
  found or after three "nothing changed" answers in a row.
- **Use the suggested setup** starts again from the suggestion for the TV's
  brand. **Share this setup** shows yours as an entry for the presets file, to
  paste into an issue so others with that TV can start from it.

Nothing is saved until **Save**, which writes how the TV switches inputs to
codex_androidtv, then the inputs to the device, and only when the inputs part
changed: saving power or timing alone leaves a TV with nothing saved on the
hub's built-in behaviour. Inputs set up before this with other commands (such
as Home) are listed with the next free input command and "Was the Home
command"; choose what each opens before saving the inputs.

### Suggestions by brand

`payload/androidtv/input-presets.json` (on the hub
`/data/codex/androidtv-input-presets.json`) holds the suggested setups, by the
device's manufacturer and model (filled in from what the TV reports when it is
added: the hub's log says `TV <id> is a <vendor> <model>`, and
`/api/androidtv/status` shows it while the TV is connected). A TV added before
this, saved as "Android TV", gets a suggestion once **Edit details** sets its
manufacturer; while it's connected, Settings offers to save the brand it
reports with one tap. Changing or adding a brand is a change to
that one file; nothing is rebuilt. A new TV gets its brand's suggestion when it
is added, and the device page says "Inputs not checked yet" until its inputs
are saved from Settings.

```json
{
  "version": 1,
  "patterns": [{ "id": "hisense-hw", "label": "Hisense (HW numbers)", "uri": "content://…%2FHW{n}" }],
  "presets": [{ "vendor": "Hisense", "model": "optional regular expression", "method": "link",
                "pattern": "hisense-hw", "inputs": [{ "name": "HDMI 1", "n": 2 }],
                "checked": { "model": "75U8H", "date": "2026-11-11", "inputs": ["HDMI 1"] } }],
  "default": { "method": "keys", "inputs": [{ "name": "HDMI 1", "key": 243 }] }
}
```

- `patterns`: link patterns with `{n}` once. `untested: true` marks one nobody
  has confirmed yet: it's in the page's list, and a preset that uses it is
  offered in Settings but never applied on its own when a TV is added.
- `presets`: matched by vendor (a case-insensitive prefix), then `model` when
  given; the first match wins, else `default`. `method` is `link`, `keys`,
  `menu` or `none`. Each input has a `name` and `n` (a pattern number), `link`
  (a whole link, for link without a pattern), `key` (a key code) or
  `position` (a place in the input menu, with `gapMs` on the preset).
- `checked`: on which model, when, and which inputs someone confirmed (kept
  for whoever maintains the file; the page doesn't show it).

The page checks the file and leaves out entries that don't hold, so a mistake
in it can't break Settings; a missing file means no suggestions (the HDMI keys).

Checked so far: a Hisense 75U8H (Google TV) ignores the HDMI keys, and the
input URIs HW2, HW3 and HW4 open HDMI 1, 2 and 3 (HDMI 4 as HW5 follows the
pattern but hasn't been confirmed). The MediaTek and `com.vt.source.external`
patterns in the file did nothing on that TV; they are there, marked untested,
for other brands. A TV can show an input this way even when nothing is plugged
into it (its own menu greys those out).

### What the hub stores

codex_androidtv keeps each TV's setting in `inputs-<id>.tsv` beside its other
files, one setting per line (tab-separated):

```text
method	link
pattern	content://android.media.tv/passthrough/com.hisense.tv.hitvinput%2F.hdmi.HdmiTvInputService%2FHW{n}
slot	1	2	works	2026-11-11
slot	2	3	untested	-
```

`method` is `keys`, `link`, `menu` or `none`; `pattern` (link only) and `gap`
(menu only, 100-2000 ms) follow. Each `slot` line is an input command (1-4 are
InputHdmi1-4, n ≥ 5 is Input<n>), its value (a key code, a pattern number or a
whole link, or a menu place), and the last Try's result and date. A TV without
the file keeps the behaviour before this setting existed: the HDMI keys, except
that a Hisense TV with app links gets the HW<n+1> links. Forgetting a TV removes
its file.

When an activity turns the TV on and then picks an input, the input waits until
the TV reports that it is on (up to 8 s after the power key): a TV that is still
waking up ignores it. A long press on an input opens it once.

## Power

PowerOn and PowerOff are discrete for the Harmony engine, but many TVs ignore
Android's separate wake and sleep keys and only answer the power key. So the hub
sends the power key only when the TV reports the other state: PowerOn on a TV
that is already on does nothing.

If a TV ignores the power key (one that is still shutting down from a PowerOff a
moment ago does) and drops off the network, or goes silent on the connection,
the hub sends Wake-on-LAN and the power key once more. While PowerOn waits for
a TV that can't be reached, Wake-on-LAN is repeated every 5 s. If the TV still
doesn't come on, the commands an activity queued behind PowerOn (its input, say)
are dropped rather than sent to it later. A PowerOff that arrives while a PowerOn
hasn't been sent yet (a retry, or one waiting for a TV it can't reach) cancels it
and those commands, so the TV isn't woken only to be turned off.

How a TV turns on from standby depends on how it sleeps:

- **Network still up** (many TVs keep it for a while, or for good with a
  "network standby" or "quick start" setting): the hub sends the power key.
- **Network down** (deep standby): the hub sends a Wake-on-LAN packet to the
  TV's address on the network (learned when it pairs) and then the key if it's
  still needed. Many TVs power fully on from Wake-on-LAN, and some report
  standby for a moment while they boot, so after a Wake-on-LAN the hub waits
  5 s from the TV's latest state report before it presses the key. A key during
  that boot would turn the TV off again.
  The packet goes to the hub's own subnet broadcast address (for example
  `192.168.1.255`) as well as `255.255.255.255`. With the cloud blocker on, the hub
  has no default route, so only the subnet address can be sent.
  - Each interface that's up and running gets its own copy, sent bound to it. With
    [wired Ethernet](USB_ETHERNET.md), Wi-Fi and the adapter share one broadcast
    address; with Wi-Fi switched off, an unbound send could leave by the
    disconnected radio and be lost.
  - The log line `sent Wake-on-LAN to <mac> via <address> (<interface>), …` names
    what went out.

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
  TLS is [BearSSL](https://bearssl.org/) 0.6. About 215 KB on flash and about
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
one.

`tools/androidtv/wol_test.sh` tests Wake-on-LAN without sending anything. It
builds `tools/androidtv/wol_test.c`, which includes `codex_androidtv.c` with
`getifaddrs()` and `sendto()` replaced by fakes, and checks that:

- the magic packet goes to each interface's own broadcast address (e.g.
  `192.168.1.255`) as well as to `255.255.255.255`;
- it still goes when `255.255.255.255` has no route, as when the cloud blocker is on;
- loopback, down, not running, point-to-point and IPv6 interfaces are skipped;
- each subnet broadcast is sent bound to its interface, so with Wi-Fi off and a
  USB adapter on the same subnet it goes out the adapter;
- PowerOn sends it only for a TV that isn't connected and has a known MAC, at
  most once every 3 s.

It needs BearSSL unpacked as for the build (or `BEARSSL=<dir>`):

```bash
sh tools/androidtv/wol_test.sh
```

The writer has its own Lua tests:
`luajit tools/touch-validator/codexactivity-androidtv-devices-test.lua`.

Protocol references: the
[androidtvremote2](https://github.com/tronikos/androidtvremote2) library (MIT),
and the [protocol write-up](https://github.com/Aymkdn/assistant-freebox-cloud/wiki/Google-TV-(aka-Android-TV)-Remote-Control-(v2)).
