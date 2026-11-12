# CI, build and release pipeline: design

Status: Phase 1 is built ([CI.md](CI.md)). Phases 2 and 3 are proposals for
the owner to pick from. Written 2026-11-12 against `main` at `b5d9254`.

## The problem

Every binary is committed, and each one's size and digest are written by
hand into three shared files: `payload/bin/MANIFEST.txt`,
`build/build_harmony_tools_kali.sh` and `docs/BUILD.md`. A pull request that
changes a binary's source carries the rebuilt binary and those edits. When
another pull request merges first, the open one may have to be rebased,
rebuilt and repinned. Nothing checked any of it: no CI ran, and no tool
compared the pins with the files.

## What the merge history shows

Method: for every merged pull request A that was open while another, B,
merged, compare what each changed. Git conflicts when both change the same
or neighbouring lines of a file, or the same binary file. A's pre-rebase
commits are gone, so its changed lines are located in the pre-B file by
content. This is a model of each rebase, not a replay; it counts each pair
once and misses pull requests that were closed unmerged.

Of 99 merged pull requests, 52 changed a binary or a pin, and 41 of those
rebuilt `codex_webui` (its source, or the web app embedded in it). The model
finds 29 conflicts, hitting 16 pull requests:

| Conflicts | Kind | What it takes to resolve |
| --- | --- | --- |
| 14 (48%) | Both rebuilt the same binary: 12 `codex_webui`, 1 `codex_androidtv`, 1 `codex_usbeth` | Rebuild and repin. In 8 of the 14 a hand-written file conflicted too. In 6 only the binary, its pins and the generated header did. |
| 9 (31%) | Hand-written files only (`install_webui.py`, tests, CSS, README) | A person. No build change helps. |
| 6 (21%) | Different binaries, pin files only: `docs/BUILD.md` 5 times, the build script 2, `MANIFEST.txt` 2 | Nothing but editing: neither side's binary is stale. |

Since 2026-11-01 the split is 8, 5 and 6.

Two things follow.

1. **Pin edits for different binaries seldom conflict.** Contributors edit
   only their binary's lines, and git merges those unless the lines are
   neighbours. It happened 6 times. Splitting the pin files per binary fixes
   those 6 and no others.
2. **The churn is `codex_webui`.** Nearly every change to the web app or its
   C rebuilds the one binary, so any two such pull requests conflict in the
   binary itself. No arrangement of pin files changes that. What can change
   is the cost: today it is a rebase, a rebuild and hand edits in three
   files; it can be one command, or nothing.

## Constraints

- **Deploy from a branch.** The hub is installed straight from a branch or
  worktree. A branch must hold binaries that match its source, or building
  them must be one easy step.
- **Install from a checkout.** `install_webui.py`, `install_webui.ps1`, the
  desktop app and Docker read `payload/bin/` and `MANIFEST.txt` from the
  tree.
- **Builds are reproducible.** Phase 1 proves it on every run, so who built
  a binary no longer matters: anyone, or CI, can rebuild it and get the same
  bytes.
- **GPL source at release.** A release that ships a rebuilt GPL binary
  carries its source.
- First-party only; CI has no hub access and no secrets.

## Phase 1: the gate (built)

Every pull request and every push to `main` runs the test suites, checks
every pin against its committed file, and rebuilds every binary in a pinned
container to compare it with the committed one. A stale pin, a binary that
doesn't match its source, or a generated header that wasn't regenerated
fails the pull request. See [CI.md](CI.md).

This doesn't reduce the churn. It makes the next phases safe: once CI proves
that a binary and its pins match the source, they can be written by a tool
instead of by hand, and the pull request diff no longer has to be trusted
for them.

## Phase 2: ending the churn (options)

### A. One home for each pin (cheap)

- Each binary's SHA-256 and size move to a file of its own, `build/pins/<name>`.
  The build script reads them from there.
- `docs/BUILD.md` stops repeating digests and source blob ids; it keeps the
  recipes and points at `build/pins/`.
- `MANIFEST.txt` stays, since the installers and the release tool read it,
  but a tool writes it in a fixed form, and CI checks that.

Fixes the 6 different-binary conflicts (21%) outright. Does nothing for two
pull requests that rebuild the same binary. Cost: the build script, the
docs, `verify_pins.py`; no installer change. It also removes the 95
hand-kept pins that Phase 1 now has to police.

### B. One command to repin and to absorb `main` (cheap, builds on A)

- `tools/repin.sh [binary…]`: regenerate the headers, rebuild the binaries
  whose sources changed, copy them into `payload/`, write their pins and
  `MANIFEST.txt`. The Zig binaries build on macOS and Linux; BusyBox and
  Dropbear need the Linux container, and change rarely.
- `tools/absorb_main.sh [--pr N]`: merge `main`; where only derived files
  conflict (binaries, pins, `MANIFEST.txt`, generated headers), take
  `main`'s and run `repin`; where a hand-written file conflicts, stop and
  say which. With `--pr N` the owner can do it for a contributor's pull
  request before merging.
- `.gitattributes` marks the derived files as generated, so reviews collapse
  them.

A same-binary conflict still happens, but it costs one command: nothing by
hand for the 6 that were derived files only, and only the real source
conflict for the other 8. Branches keep binaries that match their source, so
deploying from a branch and installing from a checkout work as today. CI
proves the result, so a wrong repin can't merge.

### C. CI repins `main` after each merge (medium)

Pull requests stop carrying binaries and pins; a job on `main` rebuilds and
commits them.

- Ends same-binary conflicts completely.
- **`main` is wrong between the merge and the bot's commit**: new scripts
  and Lua beside old binaries. The owner deploys from `main` minutes after
  merging, and `codex_webui`, `codex_hbus` and the Lua plugin must come from
  the same build. The installers would need a guard that refuses a tree
  whose binaries don't match its source.
- A branch no longer holds the binary for its source, so deploying from a
  branch needs a local build first, every time.
- The job needs permission to push to `main`.
- The pull request no longer shows the binary that ships. With reproducible
  builds that is acceptable, but it is a change in what a review covers.

### D. Binaries out of git, fetched from releases or CI (big)

Ends every binary and pin conflict. Breaks both constraints: a checkout can
no longer be installed without a download or a toolchain (the Windows
installer has neither), and deploying from a branch needs CI to have built
that exact commit, or a local build. Rolling back with `git show` goes too.
Too disruptive for how this project works.

### Recommendation

**A and B together.** They are the smallest change that ends the churn as a
cost: of the 29 conflicts, 6 disappear, 14 become one command, and the 9 in
hand-written files are real and stay. They keep binaries in git, so neither
constraint is touched, and they need no secrets and no push rights.

Splitting the pins alone (A) is not enough: it fixes a fifth of the
conflicts and none of the `codex_webui` ones.

Hold C in reserve. If same-binary rebases still hurt after B, apply C to
`codex_webui` only, with the installer guard, and accept its costs for that
one binary.

## Phase 3: the release workflow (spec)

A workflow started by pushing a tag `v<version>` (or `desktop-v<version>`).
It prepares a **draft** release; the owner signs the APK and publishes, as
now. It replaces the hand-run steps in [RELEASING.md](RELEASING.md), not its
checks.

1. **Check the tag.** The version must equal `MELODIOUS_VERSION` in
   `codex_webui.c`, the desktop `package.json` and the Android
   `versionName`. Stop if not.
2. **Run the gate** on the tagged commit: the suites, the pins, the rebuild.
   The binaries in the release are the committed ones, just proven to be
   what the tagged source builds.
3. **Hub zip.** `git archive` with the path list RELEASING.md requires
   (payload, `payload/helpers`, installers, `LICENSE`, `third_party/`, the
   build scripts).
4. **GPL sources.** Download each upstream tarball a shipped GPL binary was
   built from, check it against the pin in the tree, and attach it:
   `busybox-1.37.0.tar.bz2` today, and the kernel source for the USB
   Ethernet modules once their sources are in the tree. Fail if a GPL binary
   has no pinned source.
5. **macOS app.** Build the four files on a macOS runner
   (`npm ci`, `npm run dist`). Not byte-reproducible; covered by checksums.
6. **Android.** Build the unsigned release APK. The signing key stays off
   GitHub.
7. **Draft release** with the hub zip, the Mac files, the source tarballs,
   the unsigned APK as a workflow artifact only, and the notes from
   `docs/release-notes/<version>.md` (fail if missing).
8. **Owner, locally:** sign the APK, add it to the draft, run
   `tools/releases/release.py manifest` and `verify` (they need the signed
   APK's certificate), upload `melodious-update.json` and `SHA256SUMS.txt`,
   publish.

The workflow needs `contents: write` to create the draft, and nothing else:
no signing key, no hub.

## Plan

| Step | What | Size |
| --- | --- | --- |
| 1 | Merge Phase 1; require its two checks on `main` | done, plus one setting |
| 2 | A: `build/pins/`, digests out of `BUILD.md`, generated `MANIFEST.txt` | small |
| 3 | B: `tools/repin.sh`, `tools/absorb_main.sh`, `.gitattributes` | small |
| 4 | Release workflow | medium |
| 5 | Only if needed: C for `codex_webui` | medium |

## Gaps Phase 1 found

- **The kernel modules can't be rebuilt.** `payload/modules/usb-net/*.ko`
  ship without their kernel tree, backport sources or hub symbol table in
  the repository. CI checks their pins only.
- **Two suites fail on `main`** and are quarantined:
  `codexactivity-ha-devices-test.lua` (line 586) and
  `activity_offline_guard.sh`.
- **15 tests need a macOS host** and are left out on Linux; `usb-eth` is
  flaky. See [CI.md](CI.md).
- **`install_webui.py` needs Python 3.12.** An f-string with a backslash in
  its expression (the statement ending at line 2620) is a syntax error on
  Python 3.11 and older, and no document states the requirement.
- **`BUILD.md` still calls `dropbearmulti` unverified.** The build script
  requires it to reproduce, and CI now proves it does.
