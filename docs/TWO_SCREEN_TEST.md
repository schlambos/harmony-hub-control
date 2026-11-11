# Two remotes with a screen: the test build of `hal`

This is a **developer test, not a feature.** It exists to find out what
happens when two remotes with a screen (Harmony Touch, Elite, 950) are paired
to one hub, so the real change can be designed. It has no switch in Settings
and only the Python installer can set it up.

For several remotes *without* a screen, see [MULTI_REMOTE.md](MULTI_REMOTE.md).

## What it changes

The stock `hal` unpairs an older remote when a new one of the same model
pairs. The test build is the stock `hal` (firmware 4.15.600) with four words
changed, so that rule is skipped for remotes with a screen (model 16417) the
same way it already is for the Harmony USB dongle. Everything else is stock.

| | md5 | Size |
| --- | --- | --- |
| Stock `hal` (firmware 4.15.600) | `a3fdd823440c43f36e235fe51c45f008` | 363,640 |
| Two-screen test `hal` | `b6c34fbaa5e5fb4db0959278da754af3` | 363,640 |

The edits are in
[`payload/helpers/hal_twoscreen_test_patch.json`](../payload/helpers/hal_twoscreen_test_patch.json):
at `0x27ce8`–`0x27cf8`, model 16417 branches to the same "keep it" path as
the dongle.

**It does not make two remotes with a screen work.** `hal` still talks to
them through one shared connection state: it sends the hub's updates to only
one of them, and when both talk at once their messages can mix. Finding out
how badly is the point of the test.

## How it runs

- **Built from the hub's own file, never shipped.** The installer reads the
  hub's `/usr/bin/hal`, refuses anything but the stock build, applies the
  edits, checks the result's md5 and installs it as
  `/data/codex/bin/hal_twoscreen_test` with
  `/data/codex/two_screen_test.conf` set to `1`.
- **One boot only.** At the next boot `rcS.local` checks both md5s, writes `0`
  to the setting, reads it back, and only then bind-mounts the copy over
  `/usr/bin/hal`. So the boot after that — a restart, a watchdog reset or a
  power cycle — starts the stock `hal` and deletes the copy. To run the test
  build again, arm it again.
- **Never with multi-remote.** The installer refuses to arm it while
  [multiple remotes of one model](MULTI_REMOTE.md) is on, and `rcS.local`
  doesn't bind it over another copy.

```sh
# Set it up and restart into it:
python3 install_webui.py --hub-host <hub> --key-path <key> --no-prompt --two-screen-test arm
# Or set it up only; the next restart you choose binds it:
python3 install_webui.py --hub-host <hub> --key-path <key> --no-prompt --no-apply-cloud-restart --two-screen-test arm
# Disarm, and restart a hub that runs it:
python3 install_webui.py --hub-host <hub> --key-path <key> --no-prompt --two-screen-test off
```

Checking it, on the hub:

- `md5sum /usr/bin/hal` shows the test md5 while it runs.
- `/cache/codex-init.log` gets `codex two-screen test hal bound over
  /usr/bin/hal (this boot only)`, or `… skipped (…)`.
- `/data/codex/bin/codex_hal_ltcp 'hot.stats' '{}' 8` prints `hal`'s counters
  for the screen-remote link (sequence, CRC and timeout errors, link losses).

## Limits and recovery

- **Pair the second remote from the web app** (Settings → Remotes). Pairing
  started from a remote's own menu still unpairs the older one.
- **Settings → Remotes says "Multiple remotes of one model" is on** while the
  test build runs, because the page only checks that a copy of `hal` is
  bound. It isn't on: do not pair a second Smart Control or Companion, which
  would hang the radio.
- **Going back to the stock `hal` is a restart.** By hand over SSH: `reboot`
  (the setting is already `0`).
- **The stock `hal` does not unpair the second remote.** Both stay paired
  after the restart, and the stock `hal` mixes their messages the same way.
  The test is over only when one of them is unpaired (Settings → Remotes →
  Unpair, on either `hal`). Until then keep one of them asleep or out of
  range.
- If `hal` stops, the hub restarts. SSH starts before `hal` and doesn't depend
  on it.
