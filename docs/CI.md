# Continuous integration

Every pull request and every push to `main` runs `.github/workflows/ci.yml`.
It has two jobs. Neither touches a hub or uses a secret, so pull requests
from forks run it too.

| Job | What it proves | Runs |
| --- | --- | --- |
| Test suites | the suites that need no hub and no network pass | `sh tools/ci/run_suites.sh` on an Ubuntu runner |
| Pins and reproducible builds | every pin matches its committed file, and every committed binary is what its source builds | `python3 tools/ci/verify_pins.py`, then `sh tools/ci/rebuild_check.sh`, in a Debian container |

The design behind it, and what comes next, is in
[CI_BUILD_RELEASE_DESIGN.md](CI_BUILD_RELEASE_DESIGN.md).

## Test suites

`tools/ci/run_suites.sh` holds the list: the simulator and desktop tests, the
hygiene and shell checks, the installer contract, the BusyBox links, the
release tools, the Docker manager, USB Ethernet, the HBus and activity
checks, and the ten Lua writer tests. Run it the same way before you push:

```sh
sh tools/ci/run_suites.sh            # everything, about three minutes
sh tools/ci/run_suites.sh sim 'lua-*'   # only some
```

Every suite runs even after one fails, so one run shows every failure.

**Quarantine.** `tools/ci/quarantine.txt` lists the suites that already fail
on `main`. CI reports them and doesn't count them. When a listed suite
passes, CI fails until its line is deleted, so the list can't go stale. Two
suites are on it today:

- `lua-ha-devices`: `codexactivity-ha-devices-test.lua` stops at line 586;
- `activity-offline-guard`: the guard forbids `http://` in
  `codexactivity.lua`, which holds the Home Assistant webhook URL.

**Left out on Linux.** The suites are written on macOS and CI runs on
Linux, where 15 tests can't pass for reasons of the host. `run_suites.sh`
leaves them out on Linux and says so; on macOS it runs everything.

- `installer-contract`: the 14 tests that boot the hub's `rcS.local` with
  the host's tools (all of `SingleStateTurnOffOnFlow`, and one in
  `SingleStateBootAndDefenseInDepth`). Its stock lines use `${TDE:0:1}`,
  which dash rejects, and a `sed` script that GNU sed rejects; the hub's
  BusyBox and macOS accept both. The other 129 run.
- `sim`: one test in `ha-state.test.mjs` compiles a C harness with
  `-std=c99`, which hides `strdup`, `O_CLOEXEC` and `useconds_t` under
  glibc. The other 745 run.

Run the suites on a Mac before merging a change to the turn-off flow or the
Home Assistant state endpoint. (GitHub's macOS runners were tried first: the
job waited 15 minutes for a runner and was dropped.)

**Flaky.** `usb-eth` waits on real time, and one of its 56 tests fails now
and then on a busy machine, a different one each time. A failed run is tried
once more and reported as `FLAKY`.

**Not in CI yet:** the Android tests (need the Android SDK), the desktop
end-to-end tests (need Electron and a display), `hal_remotes` under Unicorn
(needs the stock `hal`, which is not in the repository), the Android TV
smoke tests (need a native `codex_androidtv`), and `ir_database_smoke_test`
(needs the network).

**The runner.** `ubuntu-24.04`; Node 26 from `actions/setup-node`; `luajit`
and `ripgrep` from Ubuntu; bun 1.3.14 from `tools/ci/install_bun.sh`, which
checks the release zip's SHA-256.

## Pins

`tools/ci/verify_pins.py` reads the tree and nothing else. Each shipped binary
has a single home for its SHA-256 and size under `build/pins/<name>`:

- `build/pins/<name>`: `SHA256` and `SIZE` of each binary in `payload/bin/`
  plus `payload/helpers/codex_flash_free` (read directly by
  `build/build_harmony_tools_kali.sh`);
- `payload/bin/MANIFEST.txt`: deterministic size (`1970-01-01 00:00` fixed
  timestamp) and MD5 inventory in sorted order, checked byte-for-byte against
  `python3 tools/ci/verify_pins.py --write-manifest`;
- `build/build_harmony_tools_kali.sh` and `docs/BUILD.md`: checked to ensure
  duplicate inline `*_EXPECT_*` constants, digest tables, and source-blob
  hashes do not return;
- `payload/modules/usb-net/README.md`: size, SHA-256 and MD5 of each module.

It prints every stale pin, with the value the file really has.

## Repinning and absorbing `main`

`tools/repin.sh` rebuilds changed (or named) Zig binaries on macOS or Linux,
regenerates `harmony_shell_assets.h` and `activity_ui_assets.h` when web inputs
change, updates `build/pins/<name>` and `payload/bin/MANIFEST.txt`, and runs
`python3 tools/ci/verify_pins.py`:

```sh
sh tools/repin.sh                  # rebuild Zig binaries whose inputs changed
sh tools/repin.sh codex_webui      # rebuild a named binary (and web headers)
sh tools/repin.sh --all            # rebuild all 10 Zig binaries + web headers
```

`tools/absorb_main.sh` merges `main` into a feature branch (or a pull request
in a temporary worktree) and resolves derived conflicts automatically:

```sh
sh tools/absorb_main.sh                # merge origin/main into current branch
sh tools/absorb_main.sh --pr 134       # dry-run absorb main into PR #134
sh tools/absorb_main.sh --pr 134 --push # absorb main and push to PR #134
```

- If any **hand-written** file conflicts, `absorb_main.sh` stops immediately
  (exit != 0), lists the conflicting files, and aborts the merge cleanly.
- If **only derived files** conflict (`payload/bin/*`,
  `payload/helpers/codex_flash_free`, `build/pins/*`,
  `payload/bin/MANIFEST.txt`, `payload/source/harmony_shell_assets.h`,
  `payload/source/activity_ui_assets.h`, or legacy pre-Phase-2 inline pin hunks
  in `build/build_harmony_tools_kali.sh` and `docs/BUILD.md`), it resolves them
  automatically, runs `tools/repin.sh` for the binaries changed on the branch,
  verifies with `verify_pins.py`, and commits the merge while preserving
  contributor commit authorship.

## Reproducible builds

`tools/ci/rebuild_check.sh` builds from source and compares bytes:

1. It regenerates `harmony_shell_assets.h` (bun 1.3.14) and
   `activity_ui_assets.h`, and checks the two-screen `hal` edits
   (`tools/build_hal_remotes.py --check`). Each must come out as committed.
2. It runs `build/build_harmony_tools_kali.sh`, which stops on the first
   binary that misses its pin.
3. It compares each built file with the committed one: the eleven binaries
   in `payload/bin/` and `payload/helpers/codex_flash_free`.

A binary in `payload/bin/` that the build doesn't write fails the check, so a
new binary can't ship without a recipe.

The kernel modules in `payload/modules/usb-net/` are **not** rebuilt. Their
kernel tree and backport sources are not in the repository, so CI can only
check their pins.

**The container.** `debian:bookworm-slim`, pinned by digest in the workflow,
with `bzip2 ca-certificates file gcc git libc6-dev make patch python3
python3-pyelftools unzip wget xz-utils` from Debian. The host compiler only
builds BusyBox's configuration tool; nothing it produces ends up in a binary.

**The toolchains.** Each is downloaded once, checked against a pinned
SHA-256, and cached between runs:

| Toolchain | Used for | Pinned in |
| --- | --- | --- |
| Zig 0.16.0, official tarball | every binary but Dropbear | tarball: `tools/ci/rebuild_check.sh`; executable: the build script |
| Bootlin `mips32--uclibc--stable-2017.05-toolchains-1-1` | Dropbear | `tools/ci/rebuild_check.sh` |
| bun 1.3.14 | `harmony_shell_assets.h` | `tools/ci/install_bun.sh` |
| BusyBox 1.37.0, BearSSL 0.6, Dropbear 2025.89 sources | their binaries | the build script |

The build script accepts the official Zig 0.16.0 executable for aarch64
macOS, x86_64 Linux and aarch64 Linux. All three build the same bytes.

To run the same check yourself, with Docker:

```sh
sh tools/ci/rebuild_in_docker.sh          # checks HEAD, so commit first
```

It uses the same image, as `linux/amd64` because Bootlin's toolchain is
x86_64 only. On an Apple Silicon Mac that takes about 14 minutes; CI takes
about two.

## Making it the merge gate

CI reports on every pull request once this is merged. To make it block a
merge, add a branch protection rule for `main` that requires the checks
`Test suites` and `Pins and reproducible builds`.

## Actions used

Only GitHub's own, pinned by commit: `actions/checkout`,
`actions/setup-node`, `actions/cache` and `actions/upload-artifact`. When
the build check fails, the built files are kept as the `rebuild-output`
artifact so they can be compared with the committed ones.
