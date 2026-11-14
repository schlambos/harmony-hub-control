# Harmony Companion home control buttons

The Harmony Companion remote has four home control buttons (**Light 1**,
**Light 2**, **Plug 1**, **Plug 2**) and a **+ / −** rocker. Logitech's
software binds them to Logitech's own home control devices only. Melodious
gives them actions like every other button: a device command, an activity or
a sequence, for every activity or for one.

Why bother: the buttons sit on the remote whatever runs, so they suit things
outside the activity, like a Home Assistant light or plug. A Home Assistant
device on the hub is an ordinary device, so its commands go on these buttons
too.

Everything here was probed on a hub with firmware 4.15.600 on 2026-10-25,
unless it says otherwise.

## Set them up

1. **Settings → Remotes**, in the Harmony Companion's section, card **Home
   control buttons**. The card shows only while a Companion (EquadID 16422)
   is paired.
2. Tap **Every activity** to set what the buttons do everywhere
   (`#homebuttons`), or an activity to set its own (`#homebuttons/<activityId>`).
3. Tap a button's row. Its sheet has the tabs **Press**, **Long press**, **+**
   and **−**. Pick a device, **Activities** or **Sequences** from the chips,
   then a command, or search across all of them.
4. Tap **Done**, then **Save to hub**. Nothing reaches the hub before that.

The page needs a hub with `16422` maps, that is a Companion that has synced
with it at least once. The Android app doesn't have this page.

## What you get

- **Every activity, or one.** What you set under Every activity works when no
  activity runs and in every activity without its own setting. An activity's
  own setting wins while that activity runs.
- **Press and long press.** A button with a long press fires once: the press
  on release, the long press about 0.7 s after you press it. A long press
  needs a press first.
- **+ and − follow the last button.** + and − after Light 1 run Light 1's +
  and − (for dimming the light it switches). When the last button has none,
  or none was pressed yet, + and − run their own rows, which have Press only.
- **No repeats.** A button without a long press fires once per press, however
  long you hold it. + and − repeat while held, so holding + dims.
- **Turn a button off in one activity.** On an activity's page, Press offers
  **Same as global** and **Nothing in this activity**.
- **Remove one part.** Long press and the Every activity tabs Press, + and −
  each have a "no action" row. **No press** also removes the long press and
  keeps + / −. **Clear** empties the whole button.
- **The page shows what's set.** A row names the press, the long press and
  the button's + / −; only a button with nothing set is greyed out. On an
  activity's page, a badge says whether the button follows the global one
  (**Global**), is set there (**Override**) or does nothing there
  (**Nothing**).
- **The sheet keeps your picks until Done** (`views/button-picker.js`). A
  pick, Clear and Undo keep the sheet open. Done keeps the changes; any other close drops them, as in the
  Touch editor.
- **Home Assistant devices first.** The chips list every device with
  commands, Home Assistant devices first (`sortPickerDevices`), then
  Activities and the map's own sequences, on one line that scrolls sideways.

## How it works

### The keys

The Companion's button maps start with `16422`.

| Button | Key the hub gets |
| --- | --- |
| Light 1, Light 2, Plug 1, Plug 2 | `Ha1`, `Ha2`, `Ha3`, `Ha4` |
| + and − | `RockerUp`, `RockerDown` |

While a key is held the remote sends a `hold` about every 220 ms.

### Where the setup lives

All of it lives in MapList and is saved through `/api/activity-save`, like
every activity edit.

- `16422Root` holds the global setup.
- `16422Activity<id>` overrides a key while that activity runs. An override is
  the whole button: an override with a press and no long press means no long
  press in that activity.
  - Sequences belong to one map. When an override keeps the global press (only
    its long press is set there) and that press is a sequence, the activity map
    gets a copy of the `16422Root` sequence with a new `SequenceId`, or reuses
    an identical copy it already has. Later changes to the global sequence
    don't reach the copy.
- `Ha1`–`Ha4` are `HardRemoteButton`s with a `ButtonAction` (the press,
  `EventType` 1) and an optional `ButtonLongPressAction` (`EventType` 2).
- `Ha<n>Up` and `Ha<n>Down` are what + and − do after `Ha<n>` was pressed
  last.
- `HcUp` and `HcDown` are what + and − do when the last pressed key has no
  + / − of its own, or no key was pressed yet.
- Actions are the ones the other editors write: `ButtonCommandAction`
  (`FunctionId-` from the command, 0 when it has none),
  `ButtonActivityAction` and `ButtonSequenceAction`.
- **Nothing** (activity maps only): the key runs the map's sequence named
  `Nothing`, whose `Actions` are one `ButtonDelayAction` with `Duration` 0 and
  `Order` 1. One such sequence per map serves every key that does nothing
  there; it goes once no key uses it.
  - A key without actions can't stand for nothing: the engine drops it and
    falls back to `16422Root`, and an action-less button in an activity map
    stops the Companion responding.
- A new `16422Activity<id>` map copies its surface and remote ids from another
  `16422` map and takes its ids from the shared allocator. An empty map is
  never made.

Every other key, map, sequence and field is carried through untouched.

### What the engine does on its own

- A key is looked up in `16422Activity<current activity>` first, then in
  `16422Root`, by the map's `ButtonMapIdentifier` and the button's
  `ButtonKey`.
- After every MapList load, the AutomationConfig pass
  (`userconfigreader.getAutomationConfiguration`) removes `Ha1`–`Ha4` from
  `16422Root`, rebuilds them from `AutomationConfig.json` only, and adds
  `RockerUp` and `RockerDown`. Activity maps keep their keys.
- `processButtonCommand` hands every key with "Rocker" in its name to the home
  automation manager before it reads any button map.
- A key without a long press is sent again on every `hold`, which flips a
  toggle several times.
- Sequence steps are stored by their `Order`, which must start at 1.

### The hook (`payload/activity/codexactivity.lua`)

`start()` installs two wrappers, once per engine run, and asks for one
MapList reload so the root keys come back after boot. It asks only when
MapList has Companion home keys.

- **Root keys**, around `getAutomationConfiguration`:
  - It puts back the `Ha1`–`Ha4` the MapList had and the pass removed.
  - A key `AutomationConfig.json` binds (a Logitech home control device) keeps
    that binding.
  - It remembers the account the engine hands it, which is where the key
    wrapper reads the maps: the plugin may not require the session module
    (`tools/activity_offline_guard.sh`).
- **Keys**, around `processButtonCommand`, for `equadId` 16422 only:
  - A home key press is remembered as the last home key.
  - A home key that does nothing in the running activity (all its actions are
    delays) is answered `200` for press, hold and release; the engine never
    sees it.
  - A home key without a long press has its holds answered `200`, so it fires
    once per press. A key `AutomationConfig.json` binds keeps the engine's own
    hold handling.
  - `RockerUp`/`RockerDown` become `<last home key>Up/Down` when that key has
    an action, else `HcUp`/`HcDown` when that has one; otherwise they stay as
    they are. The name chosen at the press is kept for its holds and release,
    which repeat, so holding + dims.
  - If the wrapper fails, the key goes to the engine unchanged.

## Harmony Elite and 950

The Elite and the 950 have the same six buttons: four silkscreened with dots
(`•`, `••`, `•••`, `••••`) instead of Light/Plug text, and a **+ / −** rocker.
This part is built from the remote's firmware (4.15.330) and the hub's engine
as read, and was run on a Harmony 950 (skin 112) on 2026-11-13. The Harmony
Elite (skin 111) shares the firmware and dot cluster and is expected to match,
but is not hardware-verified here.

Logitech numbers the `HomeControl` keys column-major while silkscreening the
dots row-major, so the physical dot buttons map to `HomeControl` keys in a
crossed order:

| Physical | HomeControl key | Old label |
| --- | --- | --- |
| `•` 1 dot | `HomeControl1` | Light 1 |
| `••` 2 dots | `HomeControl3` | Plug 1 |
| `•••` 3 dots | `HomeControl2` | Light 2 |
| `••••` 4 dots | `HomeControl4` | Plug 2 |
| `+` / `−` | `HomeControlPlus` / `HomeControlMinus` (act on the last-pressed dot's `Up`/`Down`, else `HcUp`/`HcDown`) | + / − |

The UI orders the 16417 rows in physical dot order (`• 1 dot` to `•••• 4 dots`,
keys `HomeControl1`, `HomeControl3`, `HomeControl2`, `HomeControl4`).

Run on the 950 (skin 112), with the buttons set for every activity:

- All four dot buttons (`•` 1 dot / `HomeControl1`, `••` 2 dots / `HomeControl3`,
  `•••` 3 dots / `HomeControl2`, `••••` 4 dots / `HomeControl4`) send their
  commands. Held, a dot button without a long press sends its command once.
- After 1 dot (`HomeControl1`), + and − send its + and − commands
  (`HomeControl1Up`/`HomeControl1Down`, volume up and down in the test).
- After a dot button with no + and −, a + or − that does nothing is answered
  `200`, pressed or held, and the remote's screen carries on.
- The remote's other keys work as before.
- The home keys arrive as full `control.button` requests, with a `hold` about
  every 0.3 seconds while one is held.

Not yet run on a 950:

- **Whether a held + or − repeats.** The hub's log shows one press and one
  release of the command for a 3 second hold of +. It can't show whether the
  device got a repeat, and that wasn't checked.
- **A long press action** on a dot button.
- **`HcUp`/`HcDown`**: what + and − do when the dot button pressed last has none.
- **An activity's own buttons** (`#homebuttons/screen/<activityId>`).
- **The remote's own home control screens**: whether they react to a root map
  that holds plain commands.

- **Where:** Settings → Remotes, in the screen remote's section, card **Home
  control buttons** (`#homebuttons/screen`, `#homebuttons/screen/<activityId>`).
  The card shows only while a remote with skin 111 (Elite) or 112 (950) is
  paired. The page follows the Companion's layout with the dot buttons in
  physical order (`• 1 dot`–`•••• 4 dots`).
- **Keys:** both are remotes with a screen, EquadID `16417`, so the setup
  lives in `16417Root` and `16417Activity<id>`, beside the keys every screen
  remote has. The dot buttons map to `HomeControl1`, `HomeControl3`,
  `HomeControl2`, and `HomeControl4` as tabled above; + and − are
  `HomeControlPlus` and `HomeControlMinus` and act on the last-pressed dot's
  `HomeControl<n>Up`/`HomeControl<n>Down`, or `HcUp`/`HcDown` when the last
  dot has none.
- **A Touch paired to the same hub** shares these maps and has no such keys,
  so it never sends them.
- **The root map:** a hub whose screen remotes came from a Touch has no
  `16417Root`. The first save makes it, with the surface and remote ids of
  another `16417` map.
- **+ and − need the root map.** The remote sends a home key only when the
  running activity's map has it or a root map does. So every save makes sure
  `16417Root` has `HomeControlPlus` and `HomeControlMinus`, running the
  `Nothing` sequence when they had no entry. A key already there is kept.
- **The hook** treats `equadId` 16417 like the Companion with these names:
  - a home key without a long press has its holds answered `200`;
  - `HomeControlPlus`/`HomeControlMinus` become `<last home key>Up/Down`, else
    `HcUp`/`HcDown`. With neither, a + or − that does nothing is answered
    `200`, because the engine hands every `HomeControlPlus`/`Minus` release to
    its home automation manager;
  - a + or − Logitech's home control binds stays the engine's.
- **No "Nothing in this activity".** A screen remote shows a key that runs a
  sequence as one and waits for the hub to finish it, so the page doesn't
  offer the `Nothing` sequence in an activity map here.
- **After a save** the remote must sync before it sends a new key, as for
  every button change on a screen remote.

## Limits

- Companion (`16422`), and the Elite and 950 as above; other remotes' home
  keys are untouched.
- The engine loads `codexactivity.lua` once per boot: after installing a new
  version the hub must reboot before the hooks run.
- Until the first config load after the plugin starts, keys go to the engine
  as they are; the reload `start()` asks for ends that window.
- + and − remember the last home key in memory only; after a reboot they use
  `HcUp`/`HcDown` until a home key is pressed.
- The hub remembers one last home key, not one per remote: with two
  Companions, + and − follow the home key last pressed on either.
- If an activity map has its own sequence with the same `SequenceId` as an
  inherited global sequence press, the override runs the activity's sequence
  and no copy is made. The page reads a press by its id only, without the map
  it came from.
- A home key pressed in an activity where it does nothing still becomes the
  last home key, so + and − then use its `Up`/`Down` keys.
- While an activity without a `16422Activity<id>` map runs, the engine ignores
  every Companion key, home keys included (decompiled `buttonPress`, not
  probed). Saving an override for that activity creates its map.

## Checking it

- **On the hub**, `logread` after a boot shows `codexactivity: home-control
  key hook installed` and `codexactivity: home-control command hook
  installed`, then `codexactivity: kept home-control keys Ha1 …` for the keys
  it put back.
- **Hub tests**: `luajit tools/touch-validator/codexactivity-home-buttons-test.lua`
  (the Elite and 950 keys included).
- **Web tests**: `tools/webui-sim/test/home-buttons-model.test.mjs` and
  `tools/webui-sim/test/button-picker.test.mjs`.
