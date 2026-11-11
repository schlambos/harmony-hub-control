# Two remotes with a screen

The stock hub keeps one remote with a screen (Harmony Touch, Ultimate, Elite,
950). Pair a second and it unpairs the first. `--two-screen on` lets the hub
keep two and serve both at the same time.

**Status: experimental, and not yet proven on hardware.** The change runs
against the hub's real `hal` code in an emulator (see [Tests](#tests)); the
hardware checks are listed under [What is and isn't proven](#what-is-and-isnt-proven).
It is off unless you turn it on, it is only in the Python installer, and it
changes the hub's own remote software.

## What you get

- Both screen remotes stay paired, across restarts.
- Either can be used at any time. Their messages interleave; neither waits for
  the other.
- An activity started on one shows on both: every state update goes to each
  screen remote that is awake.
- The hub answers each remote's own requests, so each syncs for itself.
- **They share one setup.** Both are the same model to the hub (EquadID
  16417), so they get the same activities, buttons and screens.
- Up to 6 remotes in total, as before.

## Turning it on and off

```sh
python3 install_webui.py --hub-host <hub> --two-screen once    # the next boot only
python3 install_webui.py --hub-host <hub> --two-screen on      # until turned off
python3 install_webui.py --hub-host <hub> --two-screen off
```

- **`once` first.** The setting is cleared before the changed `hal` starts, so
  any restart, watchdog reset or power cycle puts the hub back on the stock
  `hal`. Use it until you have seen both remotes work.
- `serial` and `serial-once` turn on the fallback mode
  ([below](#serial-mode)).
- The hub restarts each time the setting changes (about two minutes).
- It works only if the hub's `hal` is exactly the build the change was made
  for (firmware 4.15.600). Any other build is refused before anything is
  written.
- **Off does not unpair anything.** The stock `hal` keeps both remotes paired
  and serves one at a time, badly: the second one's presses arrive in a batch
  about a minute late. After turning it off, unpair all but one in
  Settings → Remotes.
- By hand, over SSH: `echo 0 > /data/codex/two_screen.conf; reboot`.

### Pairing the second remote

Turn two-screen on first; then pair from Settings → Remotes with the first
remote asleep.

- A Harmony 950 or Elite opens its own pairing screen with **Menu + Mute**
  held together. It isn't in the remote's Settings menu.
- A remote that is set up for another hub won't pair ("Unable to reach hub"):
  it keeps looking for the hub it knows. It has to forget that hub first.
- After pairing, a remote that came from another hub shows an account
  conflict. Putting it on its charger makes it take this hub's setup. **That
  erases the setup it had.**

These three were seen on one Harmony 950 moved to a hub with a Harmony Touch.

## How it works

Remotes with a screen talk to the hub over **HOT**: a sequenced, acknowledged
transport on the hub's 2.4 GHz radio, carrying requests and replies both ways.
The radio has six slots and tags every frame with its slot. The limit is in
`hal`, the hub's stock hardware daemon, which has **one** HOT context: one set
of sequence numbers, one object being received, one link flag, one "send to"
slot. With two screen remotes paired:

- their sequence numbers collide, and each collision costs the sender a
  2-second resend;
- everything the hub starts goes to the highest-numbered screen-remote slot;
- one remote going to sleep marks the link down for both.

The changed `hal` keeps the stock HOT code and its one thread, and gives each
screen-remote slot its own context:

| | Stock | Two-screen |
| --- | --- | --- |
| Context | one | one per screen-remote slot. The first slot heard keeps the stock one. |
| An incoming frame | overwrites the peer slot | goes to its slot's context |
| Poll timeout | one | one deadline per context |
| A screen remote's link loss | marks the one context down | marks its own context down |
| A reply | to the highest screen-remote slot | to the slot that asked |
| A state update | to the highest screen-remote slot | to every linked screen-remote slot, in turn |
| A second request before the first is taken | replaces the first | waits in a queue of 16 |

With **one** screen remote paired it uses the stock context and every rule
above gives the stock result: the frames on the air are the same, at the same
times.

### Who a hub-initiated command goes to

Some commands are for a remote itself: its IR emitter, LED, HID relay,
firmware, clock. The hub's Lua addresses them as `hot.1.<command>` or
`/rf/hot/1/<path>`; stock `hal` ignores the number. Now:

| Address | Goes to |
| --- | --- |
| `hot.1.…`, `/rf/hot/1/…` | the remote whose request the hub took last, if it is linked; else the linked remote heard last; else the highest linked screen-remote slot; else stock's choice |
| `hot.1N.…`, `/rf/hot/1N/…` (N = slot 1–6) | the remote in slot N |
| the rest of a file session (open … close) | where its `open` went |

The hub's Lua is not changed. The rule is one function, `ts_pick_target` in
[`hal_remotes.c`](../payload/source/hal_remotes/hal_remotes.c).

### Serial mode

`--two-screen serial` keeps the per-slot contexts but serves one object at a
time: while one remote's message is in flight, the other's frames are dropped
and it resends two seconds later. It is slower and exists in case the radio
can't interleave two remotes' frames.

## What changes in `hal`

The added code is C,
[`payload/source/hal_remotes/`](../payload/source/hal_remotes/), built for
MIPS32 big-endian with the pinned Zig 0.16.0 and no libc. It calls the stock
functions at their stock addresses.

- **Where it lives.** `hal` carries an 18.9 KB `.pdr` section (debugger data
  that is never loaded) and one unused program header. The header becomes a
  `PT_LOAD` that maps those bytes at `0x473cd0`, and the code goes there. The
  file keeps its size.
- **How stock code reaches it.** Eleven hooks, 24 words: the HOT thread's
  loop, the entries of `hot_send_data`, `hot_hbus_notify_send`,
  `hot_update_pair_status`, `hot_object_data` and the two `hot.N` parsers, the
  handler thread's wait, one link test, the same-model unpair, and the
  `hot.stats` handler.
- **Multi-remote.** The 40 per-slot key-thread edits of
  [MULTI_REMOTE.md](MULTI_REMOTE.md) are included unchanged. Its same-model
  unpair is replaced by one that asks both settings:

  | Model | Both off | Multi-remote | Two-screen |
  | --- | --- | --- | --- |
  | USB dongle (34830) | keep | keep | keep |
  | Screen remote (16417) | unpair the older | unpair the older | **keep** |
  | 16418–16420, keyboard included | unpair | unpair | unpair |
  | Any other | unpair | **keep** | unpair |

All of it is in
[`payload/helpers/hal_remotes_patch.json`](../payload/helpers/hal_remotes_patch.json),
which `tools/build_hal_remotes.py` writes from the source:

| | md5 | Size |
| --- | --- | --- |
| Stock `hal` (firmware 4.15.600) | `a3fdd823440c43f36e235fe51c45f008` | 363,640 |
| Two-screen `hal` | `904560dfaa3dc84a175524c2a80ec240` | 363,640 |

### Delivery

As for multi-remote, with four additions.

- **Built from the hub's own file, never shipped.** The installer reads the
  hub's `/usr/bin/hal`, applies the edits and checks the md5. If the
  multi-remote copy is running it takes that copy's edits back out first. It
  installs the result as `/data/codex/bin/hal_remotes`.
- **Load check.** Before it restarts the hub, the installer runs the installed
  copy with an option `hal` doesn't have (`hal_remotes -h`). `hal` prints its
  usage and exits before it opens anything. If the hub can't start the copy,
  the setting goes back to `0` and the hub is not restarted.
- **Bind-mounted at boot** by `rcS.local`, when `/data/codex/two_screen.conf`
  says `1`, `once`, `serial` or `serial-once` and both files have exactly the
  md5s above. The stock file is never modified.
- **Gates.** `rcS.local` writes `/var/run/codex_hal_gates` before it binds the
  copy: `1` or `0` for two-screen, multi-remote, serial. `hal` reads that file
  once and nothing else. Without it every hook takes the stock path, so the
  copy behaves as the stock `hal`.
- **One boot.** For `once`, `rcS.local` writes `0` to the setting and reads it
  back before it binds.
- **Boot counter.** `hal` is restarted by the watchdog, which restarts the
  hub. `rcS.local` counts each boot that binds the copy and clears the count
  when `hal` has run four minutes. After three in a row that didn't, the copy
  is left alone until the setting is saved again.

### With multi-remote

One copy carries both. While two-screen is on, `rcS.local` binds this copy and
passes it the multi-remote setting; the multi-remote copy stays on the hub for
when two-screen goes off.

- Turning multi-remote on while two-screen runs saves the setting only. Its
  own copy can't be built then (it needs the stock file), so
  `--two-screen off` is refused until multi-remote is off too.
- The web app's Settings page shows "Multiple remotes of one model" as active
  whenever any copy is bound, and its switch refuses to turn it on while
  two-screen runs. Use the installer.

## Checking it

- `/cache/codex-init.log`: `codex two-screen hal bound over /usr/bin/hal
  (setting 1, gates 100)`, or why it was skipped.
- `hal`'s log: `hal_remotes: gates two-screen=1 multi-remote=0 serial=0`, and
  `hal_remotes: slot 3 uses HOT context 1` when a second remote first speaks.
- `codex_hal_ltcp 'hot.stats' '{}' 8` on the hub. The 17 stock counters are
  summed over the contexts (the two maximum lengths are maxima). Added:
  `TS MODE` (1 interleaved, 2 serial), `TS SLOTS` (bit n = slot n holds a
  screen remote), `TS CONTEXTS`, `TS DROPS` (serial mode), and per slot
  `S<n> LINK`, `RX OBJECTS`, `TX OBJECTS`, `MSG SEQ ERROR`, `TIMEOUT`,
  `IO ERROR`.

A few `MSG SEQ ERROR` are normal with one remote too: a press and a state
update crossing on the air. Compare rates, not against zero.

## What is and isn't proven

Proven in the emulator, against the stock `hal` binary:

- With one screen remote, the changed `hal` sends byte-for-byte the frames
  stock sends, at the same times, whatever the settings (also with frames
  lost, a sleep and a wake). The request queue is not used with one remote
  either.
- With the setting off and two remotes, it behaves as stock does.
- Two and three remotes sending at once all get through, with no resends.
- Replies, state updates and hub-initiated commands reach the right remote,
  including `hot.1N` and a file session that stays with the remote it opened
  on.
- One remote asleep, or gone without the radio saying so, doesn't hold up the
  other.
- With 5% of frames lost, two remotes on the changed `hal` do about as well
  as one remote on stock: 9 failed requests in 320 calls against 6, and
  sequence errors per message within a few percent either way.

Not proven until it runs on a hub:

- That the hub's kernel (2.6.31) loads a `hal` with the extra program header.
  It should (a segment after the one with `.bss` is ordinary), and the
  installer's load check finds out before any restart.
- That the radio delivers two remotes' frames interleaved. Its 8-frame queue
  may be shared between slots; `IO ERROR` in `hot.stats` would show it, and
  serial mode is the answer.
- That the remotes' own firmware and the hub's Lua are content with two of
  them in day-to-day use.

Known limits:

- The PowerShell installer has no `-TwoScreen` yet.
- A pairing started with `delayunpair` still unpairs the older screen remote
  five seconds later. Nothing in the hub or the remotes sends it.

## Tests

```sh
HAL_REMOTES_ZIG=/path/to/zig-0.16.0/zig python3 tools/build_hal_remotes.py --check
HAL_STOCK=/path/to/stock/hal python3 tools/hal_remotes/test_hal_remotes.py
python3 tools/installer_contract_smoke.py
```

- `build_hal_remotes.py --check` rebuilds the patch file and fails if it
  differs. It also checks the compiled code: every call out goes through
  `$t9`, nothing writes `$gp`, no jump leaves except to the listed stock
  addresses.
- `test_hal_remotes.py` runs `hal`'s own HOT code under Unicorn
  ([`tools/hal_remotes/emu.py`](../tools/hal_remotes/emu.py)). `hal` is built
  from code shared with the remotes, so each "remote" is a stock copy of the
  same binary in the remote's role, and the test carries frames between them
  as the radio does. Logitech's `hal` is not in this repository; without
  `HAL_STOCK` only the patch file is checked. Needs `unicorn` and
  `pyelftools`.
- `installer_contract_smoke.py` covers `--two-screen` against the fake hub,
  and runs the two `hal` blocks of `rcS.local` under `/bin/sh` and `dash`.
