# Integration — main-product-20260819

Final product integration lane `integrate/main-product-20260819`. This document
is the **current product truth** for the integrated main product. Historical
reconciliation material lives under `docs/reconciliation/**` and
`provenance/box-snapshot-20260818/**` and is explicitly **not** current-main
truth.

## Lineage

| Ref | Full SHA |
| --- | --- |
| Base (upstream main) | `d87cebafdee36ec33f1e4ea3055239dbfea6aa09` |
| RECOVERY branch | `5e1b5520a8293b254ea88b8da725e99d74faf13e` (`recovery/agent-activity-webgui-20260818`) |
| OVERLAY branch | `e6d4df1b8ab51c8738e3630a28652fed7418448f` (`reconcile/box-snapshot-20260818-overlay`) |
| RECON branch | `391e10e663ced493d1a1dff0afa38530812f32a1` (`reconcile/box-snapshot-20260818`) |
| ACTIVITY branch | `41236d8ae8eeca8f3d54bbdc50c86db6ebcb570b` (`agent/activity-webgui`) |

First-parent commits after D87 (exactly five):

1. `444b71265d4c996654194a3710678ba3f8018b41` — Merge recovery/agent-activity-webgui-20260818 into integration lane
2. `658d9ff5d71848af91a1b573892888eb436c963a` — Merge reconcile/box-snapshot-20260818-overlay into integration lane
3. `a891a73ba6ed83f92a373935633fce7632b32170` — Exclude generated recovery artifacts and update integration .gitignore
4. `6fd4602d363000393007903a00f78e4e8ef3244c` — Regenerate production payload artifacts and manifests
5. *(this commit)* — Record final product and historical reconciliation evidence

RECOVERY, OVERLAY, RECON, and ACTIVITY are all ancestors of the final product
HEAD.

## Conflict ledger

The integration resolved conflicts between the base, the RECOVERY branch, and
the OVERLAY branch. Full blobs (git object IDs) for the conflicted paths:

| Path | Base (d87) | RECOVERY (5e1b552) | OVERLAY (e6d4df1) | Final (HEAD) |
| --- | --- | --- | --- | --- |
| `README.md` | `32c7be8f…` | `eba6358a…` | `6339e802…` | `eba6358a…` (RECOVERY) |
| `build/build_harmony_tools_kali.sh` | `89152471…` | `c01fc2a7…` | `64fd0bf2…` | `c01fc2a7…` (RECOVERY) |
| `docs/FOOTPRINT_AUDIT.md` | *(absent)* | `dfe86218…` | `37c0e68e…` | `37c0e68e…` (OVERLAY) |
| `docs/FRONTEND_REDESIGN_HANDOFF.md` | *(absent)* | `13e2b17e…` | `afc7d78d…` | `afc7d78d…` (OVERLAY) |
| `docs/FULL_FEATURE_ANALYSIS.md` | *(absent)* | `4bbb4908…` | `ec511856…` | `ec511856…` (OVERLAY) |
| `docs/PRODUCTION_PUSH_READINESS.md` | *(absent)* | `6a98cc49…` | `09565de3…` | `09565de3…` (OVERLAY) |
| `docs/SESSION_HANDOFF.md` | *(absent)* | `213ba627…` | `e421fe09…` | `e421fe09…` (OVERLAY) |
| `install_webui.ps1` | `c1a3e464…` | `0e20669e…` | `ed756b1c…` | `0e20669e…` (RECOVERY) |
| `install_webui.py` | `f5558ce7…` | `5fff4fdc…` | `a9662d63…` | `5fff4fdc…` (RECOVERY) |
| `payload/activity/codexactivity.lua` | *(absent)* | `abb1579e…` | `aa97d229…` | `abb1579e…` (RECOVERY) |
| `payload/scripts/netservicestarter.lua` | `b04e0286…` | `0cf6bb4b…` | `e9b0f31f…` | `0cf6bb4b…` (RECOVERY) |
| `payload/scripts/offline_egress_guard.sh` | *(absent)* | `c949ca88…` | `c949ca88…` | `c949ca88…` (identical) |
| `payload/source/codex_webui.c` | `d379d1fe…` | `c4ad6b63…` | `aa173f17…` | `c4ad6b63…` (RECOVERY) |
| `payload/source/harmony_shell_assets.h` | *(absent)* | `947cafd1…` | `ba6c4ce9…` | `947cafd1…` (RECOVERY) |
| `tools/hub-emu/docker/entrypoint.sh` | *(absent)* | `4000fc41…` | `8d537da6…` | `4000fc41…` (RECOVERY) |
| `tools/hub-emu/engine-emu.py` | *(absent)* | `7216e145…` | `e38ea4f7…` | `7216e145…` (RECOVERY) |
| `tools/hub-emu/seed/resources/MapList.json` | *(absent)* | `ee956c92…` | `6d6cc47a…` | `6d6cc47a…` (OVERLAY) |
| `tools/package_harmony_shell.sh` | *(absent)* | `46b909e0…` | `370dab63…` | `370dab63…` (OVERLAY) |
| `tools/webui-sim/fixtures/activity-config.json` | *(absent)* | `d30af455…` | `a15fbf13…` | `a15fbf13…` (OVERLAY) |
| `tools/webui-sim/server.mjs` | *(absent)* | `e32b427a…` | `e3e9e23f…` | `e3e9e23f…` (OVERLAY) |

Resolution policy: RECOVERY wins for the installers, the activity plugin, the
webui/hbus sources, and the hub-emu engine/entrypoint (the product-test
surface); OVERLAY wins for the reconciliation documentation, provenance
records, and the webui-sim fixtures/server (the historical-reconciliation
surface). Where the two branches carried identical blobs, the shared blob is
retained.

### Guard repair (authorized product-test correction)

The RECOVERY `install_webui.ps1` is **policy-pinned and unchanged**. Its
installer-path assertion in `tools/activity_offline_guard.sh` was a stale
guard: it required the literal `activity\codexactivity.lua` (Windows backslash)
while the RECOVERY installer references the candidate via
`Join-Path $Payload "activity/codexactivity.lua"` (portable forward slash).

- **Original guard blob:** `ee391fe4494a8cdc8b32f198fde2de85a971b0a9`
  (the `rg -F 'activity\codexactivity.lua'` assertion).
- **Final guard blob:** `93933cd02fa7a392fbe19cd194aa634bbb1e4c21`
  (narrow two-alternative fixed-string check accepting either separator, plus
  a regression self-check).
- **RECOVERY installer blob:** `0e20669efb3aa88ba8922c14d8682ac0c13adf54`
  (unchanged; still the final `install_webui.ps1`).

Rationale: this is a **stale guard repair**, not a waived or weakened test.
The guard still requires the exact `activity/codexactivity.lua` basename/path
and every other assertion (plugin markers, forbidden paths, webui forbidden
paths, netservicestarter markers, egress markers, init markers, and the
`offline_egress_guard.sh` packaging checks). Only the separator for the single
`activity/codexactivity.lua` candidate is widened from backslash-only to
backslash-or-forward-slash.

Passing evidence: `sh tools/activity_offline_guard.sh` exits 0 and prints
`offline activity guard passed`. The regression self-check proves the
forward-slash candidate passes and a wrong path (`activity/codexmqtt.lua`)
fails.

## Artifact ledger

See `provenance/integration/main-product-20260819/artifact-ledger.json` for the
machine-readable record. Summary of the eight final binaries:

| Binary | Size | MD5 | SHA-256 |
| --- | --- | --- | --- |
| `codex_bt_pair_agent` | 111796 | `5f08bbc830acc8039eeeaae84f5bad10` | `563c6c58a3629edfebd7ec30ebcf14e6384a2d84e89669b1d7c3d79c75b619c8` |
| `codex_bthid_keyboard` | 116452 | `f55eaefedb72ed2f0360d090674cd7d6` | `c6a3c4cd0db3aab1bbdc92ae22e3ae2ffe11d442ac7fe0920b46a6da0b5cef13` |
| `codex_dhcpd` | 104168 | `2f0a6fc6303743eeccc77d1b93e7253f` | `90ff5163fbbe7f8fa38725d3ac02d8cf4a5796b099e6947fa24108f9cc125c57` |
| `codex_hal_ltcp` | 76772 | `282c60662ef6374fe0eefa1971e32361` | `7fa9a84b9ee270bdf6e47d40859d29b6c1c30e5a1766f0ab59e9143dd13ca26c` |
| `codex_hbus` | 74660 | `e8e62d851417aafa9995f687277e8414` | `4be9e6ac2e09e7eb052f9c47e81480d1e32aee7190bedb6ef7f932cf07aab8f9` |
| `codex_portal` | 109548 | `bd1a7e51f476ea3a680741ca9b321b14` | `43d3925147cd70fdb58be1ba53a684a2f76b1f05a12e5db3f5c258a3cf387cc7` |
| `codex_webui` | 778408 | `7c6b0daa3df6677d23d26777ae9ed485` | `7bcf00bdcc98ded1795851ea72864f434e4e15d376a95dc7bedc70d34902b2a2` |
| `dropbearmulti` | 577296 | `3733327fd04bca282dbf06f33da0bf6c` | `e2ea632aed8b31dc5ea56b9673cbd983ec83260a97d33f891a0cebf51d5c6c8d` |

`payload/bin/MANIFEST.txt` and `payload/bin/FILES` are the tracked inventory
records; the MD5s above match `MANIFEST.txt` exactly.

## Build attestations

The final product build flow and exact dual-Zig pins are in
[docs/BUILD.md](../BUILD.md). Per-binary build status (all 8):

- `codex_webui` — EXACT_SOURCE_REPRODUCIBLE (Homebrew Zig 0.16.0, clang 21.1.8)
- `codex_hbus` — EXACT_SOURCE_REPRODUCIBLE (Official Zig 0.16.0, clang 21.1.0, `-mcpu=mips32`)
- `codex_bt_pair_agent`, `codex_bthid_keyboard`, `codex_hal_ltcp` — EXACT_SOURCE_REPRODUCIBLE (Official Zig 0.16.0)
- `codex_dhcpd`, `codex_portal` — EXACT_SOURCE_REPRODUCIBLE (Bootlin mips32-uclibc)
- `dropbearmulti` — **UNVERIFIED_THIRD_PARTY** (the only one)

## Test results (final product gate)

| Gate | Result |
| --- | --- |
| `sh tools/activity_offline_guard.sh` | PASS (exit 0, no waiver) |
| `python3 tools/installer_contract_smoke.py` | 34 pass, 1 skip (pwsh runtime-parse; allowed) |
| `node --test tools/webui-sim/test/*.test.mjs` | 299/299 pass |
| `node tools/activity_ui_model_smoke.mjs` | PASS |
| `python3 -m unittest docker.tests.test_manager` | 9/9 pass |
| `sh tools/activity_json_semantic_smoke.sh` | PASS (self-contained) |
| `sh tools/bluetooth_hid_smoke.sh` | PASS (self-contained; compiles codex_webui.c locally) |
| `python3 tools/hbus_notification_smoke.py` | PASS (self-contained local mock) |
| JS/Python/shell/JSON syntax | PASS (`node --check`, `py_compile`, `sh -n`, JSON parse) |
| `git diff --check` | PASS (no whitespace errors) |
| Docker Compose config | SKIPPED (docker CLI present but `docker compose` plugin absent; truthful skip) |

Historical reconciliation tests (`tools/reconciliation/test_*`) are **not**
run as a product-main live-pin gate; they require a disposable RECON checkout
or prior verified historical evidence. The prior verified historical result
(180/180) is recorded in the historical ledger, not re-run here.

## Docs-truth gate

- `README.md` is the final product narrative baseline with **no**
  recovery/overlay/temp/source-only/current-live/canonical banner, and exactly
  one clearly historical reconciliation pointer (the blockquote in the
  Documentation section).
- `docs/BUILD.md` is the final product build flow with the exact final webui
  and hbus SHA-256/size, the exact dual-Zig pins/commands, all 8 artifact
  statuses, and dropbear-only UNVERIFIED_THIRD_PARTY.
- `docs/reconciliation/**` carries prominent historical/not-current-main
  notices (see `docs/reconciliation/README.md`).
- `provenance/box-snapshot-20260818/**` carries a historical pointer/README
  without falsifying the immutable historical JSON hashes/claims.
- No current-main doc treats the `391e`/live pins as final product truth; the
  historical `906872`-byte webui and `39793b19…`/`6f05d649…` md5s remain
  confined to the historical reconciliation records.

## Branch-closure plan

| Ref | Full SHA | Disposition |
| --- | --- | --- |
| D87 (base) | `d87cebafdee36ec33f1e4ea3055239dbfea6aa09` | ancestor of final product |
| RECOVERY | `5e1b5520a8293b254ea88b8da725e99d74faf13e` | merged (commit 1) |
| OVERLAY | `e6d4df1b8ab51c8738e3630a28652fed7418448f` | merged (commit 2) |
| RECON | `391e10e663ced493d1a1dff0afa38530812f32a1` | ancestor of OVERLAY |
| ACTIVITY | `41236d8ae8eeca8f3d54bbdc50c86db6ebcb570b` | ancestor of RECOVERY |

Closure: the integration lane is complete at exactly five first-parent commits
after D87. No push, no remote deletion, no box access, no protected-repo
writes. `origin` and `upstream` push URLs remain DISABLED.

## Approved-literal actual scopes

The following identity/runtime literals are **user-approved** and remain only
with their actual scopes documented:

- `harmony_owner_*` / `harmony_owner_key` — the SSH private-key filename
  convention produced by the root tool; appears in installer key discovery,
  Docker/Unraid key mounting, and documentation. Not a real key filename.
- `Ripthulhu/harmony-hub-control` — the upstream project URL (fetch remote and
  documentation links). Not a personal identity.
- `matt.ucc.asn.au` — the official Dropbear release mirror host (upstream
  infrastructure), present in `build/build_harmony_tools_kali.sh`.
- `pimento` — the Harmony hub's internal codename, present in
  `payload/scripts/rcS.local` and decompiled-source notes in
  `docs/SESSION_HANDOFF.md`. Not a personal identity.
- `192.168.1.108` / `192.168.76.1` — hub-side recovery-AP/eth1 fixture
  addresses in `payload/scripts/rcS.local` and `payload/scripts/recovery_ap.sh`.
- `192.168.0.123` / `192.168.1.44` / `192.168.1.10` / `192.168.1.20` /
  `192.168.1.45` / `192.168.1.50` — RFC 1918 example/fixture addresses in
  documentation and tests.

Sanitized in this commit: the unapproved identity fixture (the eight-digit
numeric Hub ID `1539…0924`) was replaced with the synthetic `12345678` in the
recovery-selected hub engine/entrypoint (`tools/hub-emu/engine-emu.py`,
`tools/hub-emu/docker/entrypoint.sh`), preserving functional changes. A full
tracked-tree scan confirms no unapproved identity fixture, no `pimentoblue`
owner tag, no real key filename, no personal `Documents`/`.bun` paths, and no
unrelated owner paths remain.
