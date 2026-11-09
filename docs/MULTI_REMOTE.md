# More than one remote of the same model

The hub's radio has **6 pairing slots**, but the stock hub keeps only **one
remote per model**. Pair a second Harmony Smart Control and the hub unpairs the
first one. Remotes of different models (a Smart Control and a Companion, say)
can already share a hub.

**Settings → Experimental → Multiple remotes of one model** lifts that rule for
**remotes without a screen** (Smart Control, Companion), so a hub can keep two
or more of the same model. It is off unless you turn it on, and it's
experimental: it changes the hub's own remote software.

- **Turning it on:**
  - The switch works only if the hub's `hal` is exactly the build the change
    was made for (firmware 4.15.600). Otherwise the page says why it can't be
    turned on.
  - The hub builds the changed copy from its own file and keeps it only if the
    copy's MD5 matches exactly.
  - Then it restarts, which takes about two minutes.
- **Turning it off** restarts the hub too. It's refused while two remotes of
  one model are paired; unpair the extras first. If the radio has stopped
  answering, it can be forced off ([below](#if-the-radio-stops-answering)).
- **The installers** can do the same with `--multi-remote on|off|force-off`
  (PowerShell: `-MultiRemote on|off|force-off`).

## What you get

- Up to 6 remotes in total. The Harmony keyboard and Harmony USB dongles take
  slots too; Bluetooth devices and the apps don't.
- **Remotes of one model share one button setup.**
  - Every remote of a model sends key presses tagged with that model's ID
    (EquadID), and the hub answers from that model's maps.
  - So two Smart Controls always do the same thing, and Settings → Remotes
    shows them as one section ("Harmony Smart Control remote × 2").
  - The hub can't tell which of the two sent a press.
- **Remotes with a screen keep the stock rule.** A second Touch or Elite still
  replaces the first one, because the hub can sync its setup to only one
  remote with a screen.
- **So does the Harmony keyboard.** `hal` gives it one thread with a static
  radio subscriber, like the remotes' key threads below, so a second keyboard
  would hang the radio the same way. It still replaces an older one.
- Settings → Remotes lists every slot with an **Unpair** button (in both
  modes), and says how many of the 6 slots are used.

## How it works

The rule lives in `hal`, the hub's stock hardware daemon (`/usr/bin/hal`), in
two places. Both have to change. Lifting only the first makes the second hang
`hal`'s radio.

1. **The same-model unpair.** After every successful pair, `hal` compares
   the radio's slot table from before and after the pair. It unpairs any older
   slot holding the same EquadID as a new one.
   - It already exempts one kind, the Harmony USB dongle (EquadID 34830).
   - Multi-remote keeps it only for remotes with a screen (16417) and the
     keyboard (16420), with five words at offsets `0x27cdc`–`0x27cec`:
     `hal` lets only six models get that far, and 16417–16420 holds just those
     two. The keyboard's thread subscribes one static structure (`0x463d70`)
     whichever keyboard it serves, so two keyboards would hang the radio the
     same way two Smart Controls did.
2. **Per-model key threads.** Each remote without a screen gets a thread
   that receives its key reports. Stock `hal` keeps that thread's state per
   model:
   - one radio subscriber (a static structure for the Smart Control, one per
     Companion ID);
   - one thread handle;
   - one shared word for the thread's argument.

   A second remote of the same model reuses all three. Its thread zeroes and
   re-registers the subscriber the first thread is using, which makes the
   radio's subscriber list circular. The message dispatcher then walks it
   forever while holding the list's lock, so no key press or radio command
   gets through until the duplicate is unpaired.

   Multi-remote makes this state per slot:
   - each key thread `malloc`s its own subscriber and records it in a per-slot
     table;
   - its argument is passed by value;
   - the thread manager keeps handles per slot when it starts threads at boot
     and after a pair;
   - when a remote is removed, the manager stops that slot's thread only (or
     does nothing if the slot has none).

   The per-slot tables reuse the `.bss` space of the static subscribers, which
   nothing uses any more. The extra code sits in the per-model selection stubs
   it replaces.

The 45 edits (4 bytes each) are in
[`payload/helpers/hal_multiremote_patch.json`](../payload/helpers/hal_multiremote_patch.json):

| | md5 | Size |
| --- | --- | --- |
| Stock `hal` (firmware 4.15.600) | `a3fdd823440c43f36e235fe51c45f008` | 363,640 |
| Multi-remote `hal` | `cafdd7930309c7d74a6a41a87642f0c1` | 363,640 |

Nothing else changes:
- Unknown models are still unpaired at once.
- Key decoding, the keyboard and dongles are untouched.
- Each remote's key reports are delivered exactly as before.

Tested on hardware (Harmony Hub, firmware 4.15.600, two Smart Controls):
- boot with one remote, then pair a second;
- keys from both reach the engine and do the same thing;
- unpair the second (its thread exits), then pair it again;
- a reboot with both remotes already paired: the copy bound at boot,
  `rf.info` answered in 0.05 s listing both slots, 19 key presses all
  reached the engine, and the radio still answered five minutes later.

The radio answered throughout. Each subscriber leaks 92 bytes of RAM when its
remote is unpaired.

### Delivery

- **Built from the hub's own file, never shipped.** The Settings switch
  (`POST /api/multi-remote`, in `codex_webui`) builds the copy on the hub.
  The installer reads the hub's `/usr/bin/hal` over SSH and builds it on the
  install machine. Either way the source must be exactly the stock build.
  It applies the edits from the patch file, checks the result's md5, and installs it as
  `/data/codex/bin/hal_multiremote`, with `/data/codex/multi_remote.conf` set
  to `1`. Logitech's binary is not in this repository. A hub with any other
  `hal` build is refused before anything is written.
- **Bind-mounted at boot.** The stock boot script sources
  `/etc/init.d/rcS.local` before it starts `/usr/bin/hal`. `rcS.local`
  bind-mounts the copy over `/usr/bin/hal`, but only when
  `multi_remote.conf` says `1` and both files have exactly the md5s above.
  Otherwise the hub boots the stock `hal`. The stock file is never modified or
  overlaid.
- **Reboot.** `hal` starts once at boot, so the installer reboots the hub when
  the setting changes, or when the `hal` that runs (it checks the bind mount)
  isn't the one asked for. After the reboot it checks the mount again and
  warns if `rcS.local` didn't do what was asked.
- **After a firmware update** that changes `hal`, `rcS.local` no longer binds
  the copy, and the switch says it isn't available on this hub's remote
  software. Turning it off clears the setting.
- **Flash cost.** The copy takes about 180 KB of flash.

### Turning it off

The Settings switch (or `--multi-remote off` / `-MultiRemote off`) writes `0`
and reboots into the stock `hal`. `rcS.local` then deletes the copy before
`hal` starts. (Deleting it while it's bind-mounted would leave `/usr/bin/hal`
a stale handle, so neither the switch nor the installer does that.) Remotes that are already
paired stay paired; the stock rule applies again from the next pair.

- **Unpair the extra remotes of a model first.** With two of one model in
  the radio's table, the stock `hal` hangs its radio: no remote works until
  the extra one is unpaired.
- The switch and the installers refuse until they are unpaired. They also
  refuse while a pairing window is open, or if the radio doesn't list its
  remotes.
- From the check until the reboot, pairing from the web app is blocked by a
  guard file in RAM (`/var/run/codex-multi-remote-pending`), so no duplicate
  can join in between. It lapses after 10 minutes if no reboot comes.
  Pairing with the hub's own button isn't covered.
- The installers refuse `--multi-remote off` with `--no-apply-cloud-restart`
  (`-MultiRemote off -NoApplyCloudRestart`) while the copy runs: it would
  keep running after the guard lapses, with nothing to stop a duplicate pair
  before the stock `hal` starts.

Leaving the option out keeps the hub as it is, on or off.

### If the radio stops answering

Turning off normally asks the radio for its slot table first, which a hang in
the changed `hal` would block. So there is a forced off that asks the radio
nothing: it writes `0` and reboots into the stock `hal`.

- **Settings:** when "off" fails because the radio didn't answer, the page
  offers **Turn off anyway** (`POST /api/multi-remote
  {"enabled":false,"force":true}`).
- **Installers:** `--multi-remote force-off` (`-MultiRemote force-off`).
- **By hand, over SSH:** `echo 0 > /data/codex/multi_remote.conf; reboot`.

If two remotes of one model are still paired, the stock `hal` hangs on them
too. Turning it back on doesn't need the radio, so do that, unpair the extra
remote, and turn it off again.

The by-hand path needs SSH. The recovery AP (`codex_portal`) only handles
Wi-Fi setup, so it cannot write the conf.

### Checking it

- `GET /api/remotes` answers `"multiRemote": true` while the copy runs (see
  [API.md](API.md#rf-remotes)).
- On the hub, `grep /usr/bin/hal /proc/mounts` shows the bind mount.
- `/cache/codex-init.log` gets `codex multi-remote hal bound over /usr/bin/hal`
  at each boot (or `… skipped (unexpected hal build)`).
