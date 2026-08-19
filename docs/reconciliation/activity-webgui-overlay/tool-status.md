# Tool Status — activity-webgui overlay

Status of the materialized source-only overlay tools.  No box access, no
network, no commit/push.  Full hub MIPS execution is NOT run and NOT claimed.

## webui-sim — self-contained / runnable

`tools/webui-sim/` is a zero-dependency offline mock API + local UI.  It binds
`127.0.0.1` only and never contacts a real hub.  Runnable via
`node tools/webui-sim/server.mjs`.

Tests run: `node --test tools/webui-sim/test/*.test.mjs`

- **299 tests, 297 pass, 2 fail.**
- The 2 failures are `payload-bin-inventory.test.mjs` drift checks: the
  overlay worktree's `payload/bin` is at the 391e base (no
  `codex_bt_pair_agent`), while the test expects the 0828-dirty inventory.
  This is an **informational** gap, not a code defect: `payload/**` is
  excluded from this overlay by design.

## hub-emu — source-only, NOT full-MIPS-runnable

`tools/hub-emu/` is materialized source-only.  It is **not** runnable as a
full MIPS emulator here because:

- generated MIPS binaries (`tools/hub-emu/build/codex_*.mips`) are Tier C and
  excluded;
- the footprint trial (`tools/hub-emu/build/footprint-trial/**`) is excluded;
- `payload/web/` (referenced by some standalone tools) is not materialized.

Full hub MIPS execution is not run and not claimed.

## Standalone tool dependency matrix

| Tool | Tier | Self-contained | Notes |
| --- | --- | --- | --- |
| `activity_json_semantic_smoke.sh` | A | yes | ran: PASS (exit 0) |
| `activity_offline_guard.sh` | A | yes | ran: **exit 1** (391e `codexactivity.lua` lacks `process_activity`; source-cohort gap, see below) |
| `bluetooth_hid_smoke.sh` | A | yes | ran: PASS (compiles codex_webui.c locally) |
| `installer_contract_smoke.py` | A | yes | py_compile OK; runtime incompatible with preserved 391e installers (see below) |
| `hbus_notification_smoke.py` | A | yes (local mock) | py_compile OK |
| `activity_ui_model_smoke.mjs` | A | needs `payload/web/activity-ui.js` | ran: **exit 1** (`ENOENT` on `payload/web/activity-ui.js`; see below) |
| `harmony_shell_smoke.mjs` | A | needs `payload/web/*` + `payload/source/*` | not run (payload/web absent) |
| `activity_graph_repair.mjs` | A | yes | node --check OK |
| `bluetooth_device_bridge.mjs` | A | yes | node --check OK |
| `payload_bin_inventory.mjs` | A | reads `payload/bin/MANIFEST.txt` | node --check OK |
| `shipped_copy_hygiene.mjs` | A | yes | node --check OK |
| `embed_activity_ui.sh` | A | needs `payload/web/*` | sh -n OK |
| `package_harmony_shell.sh` | A | needs `payload/web/*` | sh -n OK |

## Validation summary

- `node --test tools/webui-sim/test/*.test.mjs`: 299 tests, 297 pass, 2 fail
  (informational payload-bin drift).
- `node --check` on all added `.mjs`/`.js`: all pass.
- `py_compile` on all added `.py`: all pass.
- `sh -n` on all added `.sh`: all pass.
- JSON parse on all added `.json`: all pass.
- `python3 -m unittest docker.tests.test_manager`: 9 tests OK.
- Docker Compose config check: skipped (docker CLI unavailable; informational).
- No ELF/Mach-O/PE among added files (only PNG/JPEG media).
- No `tools/*/build` added.

## activity_offline_guard.sh — source-cohort compatibility gap (NOT pass)

`tools/activity_offline_guard.sh` is materialized as-is from the 0828 source.
It **exits 1** in this overlay worktree, not 0.

Rerun result (exact, current):

```
$ sh tools/activity_offline_guard.sh; echo $?
1
```

The guard's `required` loop greps `payload/activity/codexactivity.lua` for the
literal `process_activity` (among other markers). The deliberately preserved
391e `codexactivity.lua` does not contain `process_activity`, so the
`rg -F process_activity` step fails under `set -eu` and the script exits 1
before printing anything. The recovered 0828-cohort guard expects a
`process_activity`/path contract that is absent from the preserved 391e
payload.

Classification: **expected source-cohort compatibility gap**, not a code
defect. The guard targets the 0828-dirty activity plugin surface, which is
excluded from this overlay by design (`payload/**` exclusion in tier-map). No
code defect in the guard itself is asserted here, and no offline-guard
behavior is claimed to pass.

## activity_ui_model_smoke.mjs — source-only omission (NOT runnable)

`tools/activity_ui_model_smoke.mjs` **cannot run** in this overlay. It reads
`payload/web/activity-ui.js` at import time; that file is deliberately
omitted/preserved absent in this source-only overlay.

Rerun result (exact, current):

```
$ node tools/activity_ui_model_smoke.mjs; echo $?
node:fs:539
    return binding.readFileUtf8(path, stringToFlags(options.flag));
                   ^

Error: ENOENT: no such file or directory, open '.../payload/web/activity-ui.js'
    at Object.readFileSync (node:fs:539:20)
    at file:///.../tools/activity_ui_model_smoke.mjs:7:19
    ...
  errno: -2,
  code: 'ENOENT',
  syscall: 'open',
  path: '.../payload/web/activity-ui.js'
}

Node.js v26.7.0
1
```

Classification: **source-only omission**, not a code defect. The smoke tool is
materialized as-is from the 0828 source; its input `payload/web/activity-ui.js`
is excluded from this overlay by design (`payload/**` exclusion in tier-map).

## installer_contract_smoke.py — source-only compatibility gap (NOT pass)

`tools/installer_contract_smoke.py` compiles (`py_compile` OK) but its runtime
is incompatible with the preserved 391e installers in this overlay worktree.

Rerun result (exact, current):

```
Ran 22 tests in 0.013s
FAILED (errors=22, skipped=1)
```

All 22 errors are the same `AttributeError`:

```
AttributeError: module 'install_webui_under_test' has no attribute 'bin_manifest_names'
```

raised from `prime_upgrade_hub()` at `installer_contract_smoke.py:446`
(`for name in INST.bin_manifest_names():`). The smoke tool expects a
`bin_manifest_names()` helper on the installer module that the preserved 391e
`install_webui.py` does not provide. The 1 skip is the PowerShell runtime-parse
test (`pwsh` not installed; left to Main).

Classification: **source-only compatibility gap**, not a pass. The tool is
materialized as-is from the 0828 source; it targets the 0828-dirty installer
surface, which is excluded from this overlay by design (`installers` exclusion
in tier-map). No code defect in the tool itself is asserted here, and no
installer behavior is claimed to pass.

## Invariants

- HEAD `391e10e663ced493d1a1dff0afa38530812f32a1`, branch
  `reconcile/box-snapshot-20260818-overlay`.
- README is the sole tracked `M` (modified-base exception; sanitization
  disclosure added). No staged files, no commits.
- Source (0828 dirty clone) and ACTIVE (main worktree) unchanged.
