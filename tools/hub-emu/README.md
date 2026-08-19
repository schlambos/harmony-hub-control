# hub-emu — the Harmony hub's web backend, virtualized 1:1

**SIMULATED HUB — no live device.** Binds `127.0.0.1` only; never contacts
`192.168.0.123`. Nothing here touches `payload/bin` or the physical hub.

Unlike `tools/webui-sim` (a JavaScript *mock* of the API), hub-emu runs the
box's **actual backend code**:

```
browser ──> dev-proxy.mjs :8787 ──────────────┐  (static UI + byte-forwarding,
                                              │   zero request interpretation)
   docker container "hub-emu"                 ▼
   ┌──────────────────────────────────────────────────────────┐
   │  codex_webui   — REAL binary, unmodified codex_webui.c,  │ :8080 → host :8788
   │                  MIPS32 big-endian (production zig       │
   │                  recipe), under qemu-mips user-mode      │
   │      │ popen()                                           │
   │      ▼                                                   │
   │  codex_hbus    — REAL binary, MIPS32 BE under qemu       │
   │      │ WebSocket 127.0.0.1:8088                          │
   │      ▼                                                   │
   │  engine-emu.py — emulated Harmony engine gateway,        │ :8089 → host :8789
   │                  offline activity writer (file IPC in    │  (control plane)
   │                  /var/volatile), control plane           │
   │  stubs/        — hcitool · hciconfig · codex_hal_ltcp   │
   │                  (the BT/HAL hardware seam) · reboot    │
   │                  (record-only, never signals PID 1)     │
   └──────────────────────────────────────────────────────────┘
```

The emulation boundary sits exactly where physical hardware sits on the box:
everything HTTP — parsing (`form_value` vs JSON), validation (`safe_label`,
`validate_resource_json`), the revision hash (`activity_revision`), 409/413
semantics, backups/rollback, endpoint routing (404s included) — is executed by
the real compiled code, big-endian, byte for byte.

## Run

```sh
# one-time host deps (already installed): brew install zig colima docker
colima start                       # if not already running
tools/hub-emu/run.sh               # seed → build (if needed) → container
node tools/hub-emu/dev-proxy.mjs   # serves the redesigned UI on :8787
```

Open http://127.0.0.1:8787/#control

- `run.sh --rebuild` forces a recompile of the MIPS binaries.
- Node: use PATH node or
  `/Users/matt/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node`.

## Ports

| Port | What | Purpose |
|---|---|---|
| 8787 | dev-proxy | front-end + verbatim `/api/*`, `/export/*` and setup-POST forwarding |
| 8788 | real `codex_webui` | the 1:1 hub API — point curl/tests here |
| 8789 | engine-emu control | reset/events/status plus emulator-only retention and Step 4A install seeding, inspection, and real-MIPS execution |

The proxy byte-forwards the legacy setup POST routes (`/system`, `/mqtt`,
`/wifi`, `/import`, `/ir/*`, `/bt/*`) to the real binary, so the redesigned
front-end can drive the form-encoded handlers and extract their compact result
HTML. `GET /api/system-status` is forwarded by the normal `/api/*` path and
never invokes the legacy application renderer. Nothing else leaves the static
UI.

The proxy also maps `/sim/reset`, `/sim/events`, `/sim/status` → control
plane. These are deliberately **outside** `/api/` so the emulated surface
stays exactly what the box serves (`/api/sim/*` correctly 404s, matching the
hub).

## State & reset

Resources live in the container at `/data/resources/` (seeded from
`tools/webui-sim/fixtures/activity-config.json` via `make-seed.mjs`). Saves go
through the box's real transaction path: `offline_activity_commit` → request
file in `/var/volatile` → engine-emu's writer → files rewritten → read back and
semantically verified by the real binary.

Setup-page settings are seeded (first boot, and on every reset) from
`seed/settings/` to the exact paths the binary reads — with obviously fake
secrets only:

| Seed | Box path | Contract |
|---|---|---|
| `mqtt-config.json` | `/data/codexmqtt/config.json` | `POST /mqtt` · `GET /export/mqtt` |
| `wpa_supplicant.conf` | `/etc/wpa_supplicant.conf` | `POST /wifi` · `GET /export/wifi` |
| `bt-devices.json` | `/data/codex/bt-devices.json` | `POST /bt/*` · `GET /export/bluetooth` |
| `cloud_blocker.conf` | `/data/codex/cloud_blocker.conf` | `POST /system action=cloud*` · `GET /export/cloud` (always `1`) |
| `version` | `/etc/version` | `GET /api/system-status` firmware |

`/sbin/reboot` is a record-only stub: it appends to
`/var/volatile/reboot-requests.log` and exits 0 — it never signals PID 1 (that
would kill the container). `GET /status` exposes the count as `rebootCount`.

Reset after every QA session: `curl -X POST http://127.0.0.1:8789/reset` (or
`/sim/reset` via the proxy). It reseeds resources AND the five settings files,
removes `webui_auth.conf` and `update_state.conf`, clears `/tmp/codex_update`
staging, the reboot log, backups, events, and returns the engine to PowerOff.

### Retention fixtures

Retention setup stays out of the production HTTP API. The control plane exposes:

- `POST /retention/seed?scenario=standard` — all four strict-name families,
  nested sparse files, more than 64 resource/settings and 32 update
  generations, family and combined overages, an empty newest-looking
  generation, unknown manual artifacts, and an external-target symlink.
- `POST /retention/seed?scenario=creation` — two resource rollbacks sized so a
  real resource mutation must reserve space and prune the oldest.
- `POST /retention/seed?scenario=copy-failure` plus
  `POST /retention/arm-copy-failure` — a readable `stat()` source whose read
  fails inside the real MIPS backup copier.
- `POST /retention/seed?scenario=oversized` — a protected newest settings
  generation that alone exceeds 64 KiB.
- `GET /retention/inspect` — out-of-band apparent-byte, file-count, and digest
  inventory. It never decides what to delete.
- `POST /retention/prune` — executes
  `qemu-mips /opt/hub/bin/codex_webui.mips --prune-backups`; Python only
  captures its exit status and stable summary.

Only the compiled C binary prunes. `POST /reset` reseeds the normal fixtures,
removes every synthetic retention root, manual artifact, and external target,
and leaves the copy-failure seam explicitly disarmed.

### Step 4A capacity-gated install fixtures

The installer's capacity gate and atomic same-directory installs run against
the box's REAL MIPS maintenance CLI — `codex_webui --storage-status`,
`--install-plan`, `--install-file [--rollback-restore]` — under qemu-mips,
never through a production HTTP route. The control plane exposes:

- `/mnt/data` — a small FIXED-SIZE tmpfs mounted at container boot and
  bind-mounted over `/data` (requires `--cap-add SYS_ADMIN`, which `run.sh`
  adds). This is the C binary's authoritative capacity source. It gives
  deterministic `statvfs()` numbers for exact-floor fixtures; it is NOT a
  JFFS2 equivalence claim.
- `POST /step4a/seed` `{"scenario":"upgrade"|"fresh"}` — deterministic
  pre-install destination state over the installer allowlist (obvious fake
  old content; `fresh` = first-install absent shape).
- `POST /step4a/capacity` `{"free":N}` — drives free capacity to exactly N
  bytes with one filler file (N=0 empties), enabling exact-floor,
  one-byte-below, and insufficient fixtures.
- `POST /step4a/stage`, `/step4a/fault`, `/step4a/run`, `/step4a/inspect`,
  `/step4a/handoff`, `/step4a/rollback-copy`, `/step4a/remove`,
  `/step4a/md5` — staging tree, deterministic refusal seams (symlink/dir/FIFO
  destinations and sources, traversal, wrong modes), real-MIPS execution with
  exit/stdout/process counts, state inspection, wrapper-shaped handoff,
  wrapper rollback copies, and the corrected `/bin/busybox md5sum` interface.
- `POST /step4a/run` accepts an optional `fault` object with harness-only,
  production-unmodified syscall seams: `errnoOn` (seccomp-BPF makes guest
  fchmod/fsync/fdatasync/rename return an errno), `partialBytes` (RLIMIT_FSIZE
  + SIGXFSZ ignored -> EFBIG mid-copy), `truncateRace` (truncate the staged
  source the instant the temp appears -> verified short read before rename),
  and `tempCollision` (pre-create every possible O_EXCL temp name for the
  child pid). These prove copy/verify/rename failure cleanup and exact temp
  collision without any C hook.
- `POST /step4a/reset` — same cleanup as `POST /reset`.



## Contract QA

`node tools/hub-emu/qa.mjs` covers the baseline config/state envelopes,
form-vs-JSON body parsing on `activity-run`/`ir-send`, Bluetooth (Transport 32)
send path, 404s for endpoints the box lacks (`/api/control-button`,
`/api/sim/events`), full save/409/revision flow through the writer daemon, the
1 MiB `MAX_REQUEST_BODY` 413, bounded `GET /api/system-status` data and auth,
the setup-page contracts, reboot observability, auth enable/disable,
update-state reset, and full settings restoration. It then drives the
retention scenarios above and proves deletion order, recursive apparent-byte
accounting, family/global budgets, protected minima, idempotence, unknown and
symlink safety, copy-failure rollback preservation, and reset cleanup through
the real MIPS binary.

## What is genuinely real vs emulated

Real (compiled from `payload/source`, unmodified): `codex_webui.c`,
`codex_hbus.c` — every HTTP contract the front-end can observe.

Emulated (engine-emu.py + stubs, shapes from `docs/SESSION_HANDOFF.md` §5 and
the decompiled firmware): `harmony.engine?getCurrentActivity` (genuine nested
`{"data":{"result":...}}` envelope), `startactivity` (validates the activity
exists, tracks current), `holdaction` (logs device/command — this is where IR/BT
photons would leave the box), `ir.cap` (empty capture), the offline activity
writer, `hcitool`/HAL steady-state replies (authenticated BT link, matching the
live hub), and a deterministic `ps` snapshot for System-status process output.

Not emulated, by design: the physical remote (hub-tolerates/remote-rejects
asymmetry is un-emulatable — validate graphs via the wizard contract + vendored
repair pass; final remote checks stay on hardware), IR/BT radiation, activity
power sequencing timing, the cloud (which is blocked on the box anyway), and
the MQTT broker itself (the seeded config is disabled; `tcp_established` just
reports "not connected"). The `/sbin/reboot` stub makes reboot requests
observable but never restarts anything.

## Gotchas

- **Port 8787 collision**: `tools/webui-sim/server.mjs` (the old mock) uses
  8787 too. If it is running, dev-proxy dies with EADDRINUSE and the browser
  talks to the MOCK — which accepts JSON bodies and fakes `/api/control-button`,
  poisoning any fidelity conclusion. Check `lsof -iTCP:8787 -sTCP:LISTEN`.
- Browser cache lies during QA (see FRONTEND_REDESIGN_HANDOFF §7): always
  navigate with a cache-buster (`/?fresh=N#route`).
- The emulator enforces the box's real limits: request bodies over 1 MiB get
  413; the fixture (~408 KB) fits comfortably.
- First `ir-send` triggers the real protocol-repair path
  (`repair_known_protocols_for_current_commands`) which appends builtin
  protocol 2 to `ProtocolList.json` and takes a resource backup — genuine box
  behavior, not a bug. `/reset` restores the seed.
