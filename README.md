# Harmony Hub Control

Local web UI and helper runtime for an already rooted Logitech Harmony Hub.

> **Branch notice:** this is the `reconcile/box-snapshot-20260818-overlay`
> branch at base `391e10e`. It is a **public-safe source/docs overlay** on top
> of the operational baseline: source files, documentation, screenshots, and
> development tools are added, but the shipped installers and `payload/`
> binaries are preserved exactly as at the base commit. See
> [docs/reconciliation/activity-webgui-overlay/](docs/reconciliation/activity-webgui-overlay/)
> for the machine-readable overlay record.

This repository is for post-root device ownership work: the web dashboard, IR
database tooling, Bluetooth HID controls, MQTT/Home Assistant bridge, recovery
AP helpers, and the installer that deploys those pieces over SSH.

It does not contain rooting tools, device compromise notes, private keys, live
MQTT credentials, firmware dumps, or personal backups.

## Current Status

- **7 of 8 live binaries are exact-source-reproducible** (`codex_dhcpd`,
  `codex_portal`, `codex_webui`, `codex_bt_pair_agent`,
  `codex_bthid_keyboard`, `codex_hal_ltcp`, `codex_hbus`).
- **Deterministic staging is 21/22**: every closure entry except
  `dropbearmulti` stages byte-exactly from verified source-built outputs.
- **`dropbearmulti` is build-unverified** (version/license verified, binary
  build unverified — no vendor source/patch/config/rebuild closure).
- The **stale live `MANIFEST.txt`** is recorded separately as a staleness
  finding, never staged.
- Generated provenance is **`canonical=false`, `complete=false`** (NON-CANONICAL).
- See [docs/reconciliation/box-snapshot-20260818.md](docs/reconciliation/box-snapshot-20260818.md)
  and [docs/reconciliation/staging-contract.md](docs/reconciliation/staging-contract.md)
  for the current reconciliation evidence.

## What this is

A local web remote, activity editor, and smart-home bridge that runs on the
hub itself — no Logitech app, account, or cloud required. It installs a
self-contained web interface and helper runtime onto an **already-rooted**
Harmony Hub over SSH, then lets you control activities, edit configurations,
learn IR codes, pair Bluetooth devices, and integrate with Home Assistant —
entirely from a browser on your local network.

Everything lives on the hub: activities, device database, button maps, and
settings are plain JSON files on the hub's flash storage, editable and backed
up from the web UI, with the Logitech cloud fully blocked by default.

## Feature tour

- **Dashboard and browser remote** — the Home view shows what is running with
  one-tap activity start and power-off; the Control view renders the genuine
  Harmony remote image with live button hotspots and a send inspector.
- **Activities** — a guided wizard plus an advanced editor with a strict
  validator and repair pass; saves are transactional on the hub and publish
  to the paired physical remote offline.
- **Device and IR control** — learning, IRDB / Flipper-IRDB / RemoteCentral
  import, batch sweeps, and a scratch "IR Lab" device.
- **Bluetooth pairing and HID keyboard** — local pairing with Secure Simple
  Pairing, on-hub link-key storage, and a keyboard-class HID mode with saved
  keystroke scripts.
- **MQTT and Home Assistant** — a hub-side Lua bridge publishes discovery and
  accepts activity/IR commands.
- **Wi-Fi, recovery, and system tools** — browser Wi-Fi editing, a recovery AP
  workflow, and a System page for status, cloud blocker, sign-in, and updates.
- **Backup, restore, and updates** — ten one-click exports plus a full owner
  bundle; the installer creates a hub-side backup first and
  `restore_backup.ps1` rolls back to it.

## Screenshots

| | |
|---|---|
| ![Home dashboard with the running activity, start tiles, and recent events](docs/screenshots/home.png) *Home — now playing and one-tap starts* | ![Activity roster with run, set up, reorder, and delete controls](docs/screenshots/activities.png) *Activities — run, rework, reorder, delete* |
| ![Guided activity setup wizard, step one of four](docs/screenshots/wizard.png) *Activity wizard — guided four-step setup* | ![IR setup with device inventory, learning, and batch sweep tools](docs/screenshots/ir.png) *IR setup — inventory, learning, imports, sweeps* |
| ![Bluetooth page showing an authenticated HID link and pairing controls](docs/screenshots/bluetooth.png) *Bluetooth — pairing and HID keyboard control* | ![MQTT broker and Home Assistant discovery configuration](docs/screenshots/mqtt.png) *MQTT — broker setup and HA discovery* |
| ![Backup page with individual exports and the full owner bundle](docs/screenshots/backup.png) *Backup — ten exports plus a full bundle* | ![System page with status, cloud blocker, sign-in, and updates](docs/screenshots/system.png) *System — status, cloud policy, sign-in, updates* |

## Requirements

| Requirement | Details |
|---|---|
| Harmony Hub | Already **rooted** with [harmony-hub-root](https://github.com/Ripthulhu/harmony-hub-root). This project does not root hubs. |
| SSH key | The private key produced by the root tool, named `harmony_owner_*`, in `~/.ssh` (or `%USERPROFILE%\.ssh`). |
| Hub ID | The exact numeric Hub ID printed by the root tool. **Do not guess it.** |
| Install machine | Windows (PowerShell), Linux/macOS (Python 3), or a Docker/Unraid host. Only plain `ssh` is used. |
| Network | A trusted local network. The web UI is plain HTTP with optional sign-in; never expose it to the internet. |

The shipped binaries target the Harmony Hub's MIPS big-endian Linux userspace.
No build step is required to install the current payload.

## Quick Install

Run after the hub has been rooted. The installer finds your `harmony_owner_*`
key automatically; if you rooted with `harmony-hub-root`, the Hub ID is read
from its handoff file, otherwise pass it explicitly.

**Windows** — double-click:

```text
Install_Harmony_Control.cmd
```

or run PowerShell directly:

```powershell
.\install_webui.ps1 -HubHost <hub-ip> -HubId <numeric-id>
```

**Linux/macOS:**

```bash
python3 install_webui.py --hub-host <hub-ip> --hub-id <numeric-id>
```

Non-interactive, with MQTT disabled:

```bash
python3 install_webui.py --hub-host <hub-ip> --key-path ~/.ssh/harmony_owner_<key-name> --mqtt-disabled --no-prompt
```

The installer creates a backup on the hub, uploads the runtime, starts Dropbear
if needed, starts the web UI, and writes MQTT config if provided. By default it
enables the cloud blocker and reboots once so the guarded handlers load. To
stage the cloud setting without the install-time reboot, add
`-NoApplyCloudRestart` (PowerShell) or `--no-apply-cloud-restart` (Python).

Then open:

```text
http://<hub-ip>:8080/
```

**Docker / Unraid** — a one-time installer container plus a persistent web
proxy, with a Compose example and an Unraid XML template. See
[UNRAID.md](UNRAID.md) for the full procedure and safety notes.

**Rollback** — restore the newest hub-side backup created by the installer:

```powershell
.\restore_backup.ps1 -HubHost <hub-ip> -KeyPath "$env:USERPROFILE\.ssh\<root-key-file>"
```

## Source-only disclosure

This overlay adds source and development tooling, but it is **not** a
fully-runnable build of every component:

- **`tools/webui-sim/` is runnable** — a zero-dependency Node mock of the API
  for UI work. Run `node tools/webui-sim/server.mjs` and open
  `http://127.0.0.1:8787/#control`.
- **`tools/hub-emu/` is source-only and NOT full-QEMU/MIPS-runnable** — the
  generated MIPS binaries under `tools/hub-emu/build/**` and the Tier C
  `payload/` artifacts are deliberately omitted from this overlay, so the
  emulator cannot be run as-is. Do not treat the hub run command as runnable
  here. See
  [docs/reconciliation/activity-webgui-overlay/tool-status.md](docs/reconciliation/activity-webgui-overlay/tool-status.md).
- **`tools/installer_contract_smoke.py` is a source-only compatibility gap** —
  it compiles but its runtime targets the 0828-dirty installer surface and is
  incompatible with the preserved 391e installers (22 `AttributeError` errors
  for a missing `bin_manifest_names` helper). See
  [docs/reconciliation/activity-webgui-overlay/tool-status.md](docs/reconciliation/activity-webgui-overlay/tool-status.md).

## Sanitization disclosure

This overlay is a **sanitized derivative**: unapproved local identity values
(SSH key filename, live numeric Hub ID, hub hostname, and the authoritative
local repo path) were replaced with generic placeholders, and
`tools/package_harmony_shell.sh` was made portable (Bun discovered from `BUN`
or `PATH`). The only preserved owner literals are the user-approved private
network IP `192.168.0.123` and the exact runtime fallback node path. See
[docs/reconciliation/activity-webgui-overlay/tier-map.json](docs/reconciliation/activity-webgui-overlay/tier-map.json)
for the category-only replacement record and approved-literal scopes.

## Development and testing

You do not need a hub to work on the UI or verify most behavior.

**UI simulator** (zero dependencies, in-memory mock API, binds loopback only):

```bash
node tools/webui-sim/server.mjs
# open http://127.0.0.1:8787/#control
```

**Test suites** (runnable on a host machine, no hub required):

```bash
node --test tools/webui-sim/test/*.test.mjs   # UI/model unit tests (299/297/2, see below)
sh tools/activity_json_semantic_smoke.sh      # save-path JSON semantics (PASS)
sh tools/bluetooth_hid_smoke.sh               # Bluetooth HID guards (PASS)
python3 docker/tests/test_manager.py          # Docker manager (9 tests OK)
```

**Not runnable / not passing in this overlay** (source-cohort compatibility
gaps, not code defects — see
[docs/reconciliation/activity-webgui-overlay/tool-status.md](docs/reconciliation/activity-webgui-overlay/tool-status.md)):

```bash
node tools/activity_ui_model_smoke.mjs        # NOT runnable: payload/web/activity-ui.js absent (ENOENT, exit 1)
sh tools/activity_offline_guard.sh            # NOT passing: exits 1 (391e codexactivity.lua lacks process_activity)
node tools/ir_database_smoke_test.mjs --sample=24 --per-device=10 --source=all --dry-run  # base tool; requires network (public IRDB CDNs)
```

**Test truth:** the webui-sim suite reports **299 tests, 297 pass, 2
informational failures**. The two failures are `payload-bin-inventory.test.mjs`
drift checks: this overlay deliberately preserves the 391e `payload/` tree, so
the inventory does not match the 0828-dirty expectation. They are not code
defects.

- `tools/activity_offline_guard.sh` **exits 1** in this overlay: the recovered
  0828-cohort guard expects a `process_activity`/path contract that is absent
  from the deliberately preserved 391e `payload/activity/codexactivity.lua`.
  This is an expected source-cohort compatibility gap, not a code defect.
- `node tools/activity_ui_model_smoke.mjs` **cannot run**: it reads
  `payload/web/activity-ui.js`, which is deliberately omitted/preserved absent
  in this source-only overlay (exits 1 with `ENOENT`).
- `tools/installer_contract_smoke.py` reports **`Ran 22 tests` /
  `FAILED (errors=22, skipped=1)`** because the preserved 391e installer lacks
  the `bin_manifest_names` helper the 0828-dirty smoke tool expects.

## Documentation

| Document | Contents |
|---|---|
| [UNRAID.md](UNRAID.md) | Docker / Unraid deployment procedure and safety notes |
| [docs/API.md](docs/API.md) | HTTP API for scripts and integrations |
| [docs/BUILD.md](docs/BUILD.md) | Rebuilding the MIPS binaries |
| [docs/SECURITY.md](docs/SECURITY.md) | Security policy and pre-sharing checklist |
| [docs/FULL_FEATURE_ANALYSIS.md](docs/FULL_FEATURE_ANALYSIS.md) | In-depth, evidence-graded feature and architecture analysis |
| [DESIGN.md](DESIGN.md) | Web UI design system |
| [tools/webui-sim/README.md](tools/webui-sim/README.md) | UI simulator and production shell packaging |
| [tools/hub-emu/README.md](tools/hub-emu/README.md) | QEMU hub emulator (source-only in this overlay) |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Contribution guidelines |
| [docs/reconciliation/activity-webgui-overlay/](docs/reconciliation/activity-webgui-overlay/) | Overlay record: protected paths, tier map, materialization report, tool status |

## Safety and limitations

This is owner-operated software for a rooted device on a trusted network.

- **Trusted LAN only.** The UI is plain HTTP, sign-in is optional Basic auth
  (off by default). Never port-forward or expose the hub to the internet.
- **Backups and exports contain secrets.** The Wi-Fi, MQTT, and full-bundle
  exports include your Wi-Fi password and MQTT credentials so restores are
  complete. Store downloaded backups accordingly.
- **The browser updater is a convenience, not a secure channel.** Payload
  updates fetched from the System page are not cryptographically signed.
- **Some operations disrupt the household.** Wi-Fi changes, reboots, cloud
  toggles, imports, and updates can interrupt TV time or briefly take the hub
  offline.
- **Cloud blocking is the supported mode.** Mixing local editing with the
  Logitech app or cloud sync is not supported and can overwrite local work.

## Contributing, security, and credits

Contributions are welcome — keep changes scoped, prefer small pull requests
with a short test note, and never commit SSH keys, MQTT passwords, tokens,
hub backups, firmware dumps, or rooting tools. See
[CONTRIBUTING.md](CONTRIBUTING.md) and [docs/SECURITY.md](docs/SECURITY.md)
before sharing changes.

- Hub rooting: [harmony-hub-root](https://github.com/Ripthulhu/harmony-hub-root)
- Upstream project: [Ripthulhu/harmony-hub-control](https://github.com/Ripthulhu/harmony-hub-control)

**License:** this repository does not currently include a license file, so
default copyright applies. Confirm redistribution rights with the author
before republishing binaries or images built from it.
