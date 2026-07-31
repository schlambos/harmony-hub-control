# Production push readiness — six setup pages (#ir #bluetooth #mqtt #wifi #backup #system)

**Mission type:** analysis only. **Hub writes this mission: ZERO** (SSH reads +
HTTP GETs only; verified below). **Date:** 2026-07-31.
**Branch context:** `agent/activity-webgui` @ `5d84cd9`, all work uncommitted.
**Decision required from owner:** go/no-go on the push, plus two ride-along
options (§6). Nothing deploys without that approval.

---

## 0. Executive verdict

**GO, with conditions** (§7). Flash headroom is comfortable by conservative
estimate (~3.1 MB free physical, ~1.4 MB in the 2×-pessimistic bound, vs a
~406 KB peak install need). The binary provenance chain is closed byte-for-byte.
All eight endpoints the new pages call are live on the hub with the exact
shapes the emulator asserted. The single highest-risk step remains the flash
binary replace itself; the runbook (§4) stages via tmpfs with an atomic rename
and two independent rollback binaries.

---

## 1. Binary provenance report

Every artifact below was md5-verified this session.

| Artifact | md5 | raw bytes | What it is |
|---|---|---:|---|
| **On-hub** `/data/codex/bin/codex_webui` (running, pid 3891) | `39793b19337f479fab87918eb424bf68` | 809,608 | Redesigned shell (5 routes), **no setup pages** |
| Quarantine `out/codex_webui.BEFORE` | `39793b19…` — **byte-identical to on-hub** | 809,608 | Rebuilt from current source + deployed header |
| Repo `payload/bin/codex_webui` (+ repo `MANIFEST.txt`, + snapshot copy, + `/var/volatile/codex_webui.prev`) | `ad1ef2b15f922bbe658fda0417f845a4` | 684,148 | **Pre-shell** binary. STALE vs hub |
| Quarantine `out/codex_webui.AFTER` | `eccda9b8634d4002d4c4533b65b3667f` | 906,984 | Six-setup-pages build, pre-IR-fix (superseded) |
| **PUSH CANDIDATE** (setup pages + IR-lab heap fix, owner-approved 2026-07-31) | `08a68298159fa5137b510b28af984789` | 906,872 | Current source (fix applied in-tree) + six-setup-pages header |

**Note:** the IR-lab heap fix is now applied in `payload/source/codex_webui.c`,
so a rebuild of "current source + baseline header" no longer reproduces the
deployed `39793b19…` binary — that reproduction was verified before the fix
was applied. gzip-9 of the push candidate: 317,891 B.

**Delta of the push:** +97,376 raw · +29,301 gzip-9 · **+42,778 jffs2-chunk-proxy**
(4 KiB-chunk deflate, the closest available model of jffs2 zlib nodes).

**Exact reproduction recipes (both verified this session):**

- Deployed (BEFORE): current (dirty) `payload/source/codex_webui.c`
  + current `payload/source/harmony_shell_assets.h`
  (`d78ea51cab939747ec3c14987da59141`, 633,794 B) →
  `zig cc -target mips-linux-musleabi -Os -static -s -I <src> -o codex_webui codex_webui.c`
  (zig 0.16.0) → md5 `39793b19…` = on-hub binary.
- Candidate (AFTER): same source + regenerated header
  (`66c529656b516f9221aa890f1ca37339`, 1,126,713 B) built by
  `tools/package_harmony_shell.sh` (bun 1.3.14) → md5 `eccda9b8…`.
  Determinism re-verified: a fresh `bun build` of the current sim tree
  reproduced the measured bundle md5 exactly (`535ea313…`, 166,546 B).

**Build-regeneration hazard (confirmed):** `tools/embed_activity_ui.sh` now
chains `tools/package_harmony_shell.sh`, which rewrites
`payload/source/harmony_shell_assets.h` from `tools/webui-sim/public/`. Any
standard build therefore embeds the six setup pages. The only source diff vs
the deployed binary is that header; `codex_webui.c` itself is unchanged between
BEFORE and AFTER.

**Stale references to fix at push time:** repo `payload/bin/codex_webui` and
`payload/bin/MANIFEST.txt` still carry `ad1ef2b1…`/684,148;
`docs/SESSION_HANDOFF.md` §2 lists `ad1ef2b1` as the hub binary (superseded —
the shell was deployed after that doc and after the 07-30 snapshot).

---

## 2. Flash budget analysis (`/data`, 5 MiB jffs2, mtd4)

Complete tenant enumeration performed on-hub (1,314 files under `/data`;
matches the 1,427-path snapshot manifest minus `/cache`). Compression modeled
per-file-type from measured chunked-deflate ratios (binary ×0.449 measured;
JSON ×0.20 used conservatively vs ×0.139 measured; text ×0.35).

| Tenant | logical B | est. physical B |
|---|---:|---:|
| `/data/codex/bin` — 8 tools + manifest | 1,981,049 | 889,799 |
| `/data/rootssh/bin` — dropbearmulti copy | 577,296 | 259,206 |
| `/data/resources` — 14 files | 273,848 | 54,770 |
| `/data/codex/resource-backups` — 2 resource + 2 settings sets | 806,674 | 161,335 |
| `/data/codex-backups` — 10 dirs (JSON 415,632 + binaries 333,152) | 748,784 | 232,711 |
| `/data/codex` misc (`ir-events.log` 59,607 etc.) | ~65,000 | ~22,750 |
| Small tenants (luaworks, discovery, digest, loggly, ssh-stage, mqtt) | ~29,000 | ~14,500 |
| jffs2 per-inode overhead (~100 B × 1,314) | — | ~131,400 |
| **Total** | **~4.48 MB** | **~1.77 MB** |

Usable partition (5,242,880 − ~5 erase-block GC reserve) ≈ **4,915,200 B**.

- **Estimated free: ~3.15 MB.**
- **2×-pessimistic bound (all ratios doubled): ~1.38 MB free.**
- **Peak need during install:** new binary ~406 KB physical coexists with the
  old ~363 KB until the rename+unlink completes. Steady-state growth: **+43 KB**.

Even the pessimistic bound leaves >3× the peak need. Context: the historical
~670 KB mid-write truncation happened when 5 resource-backup sets (~2 MB
logical) were resident; retention has since been pruned to 2+2 sets.

**Reclaim plan (optional, not required by the numbers)** — per
FOOTPRINT_AUDIT rec #9; every file is already captured in the 07-30 snapshot:

| Delete | logical B | est. physical B |
|---|---:|---:|
| `/data/codex/resource-backups/20260727_174852` (pre-repair era set) | 546,663 | ~109,000 |
| `/data/codex-backups/activity-sync-contract-20260727_0020` | 455,936 | ~110,000 |
| `/data/codex-backups/hbus-response-fix-20260726-220120` | 71,236 | ~32,000 |
| **Total reclaim** | **1,073,835** | **~251,000** |

**Free-space caveat stands:** jffs2 free space cannot be queried on this
BusyBox. The mitigation is procedural (§4): tmpfs staging, `sync`, byte-count +
md5 verification of the written file *before* the rename, and verified
rollback if any check fails.

---

## 3. Contract parity — live hub, GETs only (performed, all green)

All eight endpoints the SIM pages call were probed on `192.168.0.123:8080`
(zero POSTs). Shapes match the emulator's 65/65 contract assertions exactly.

| Endpoint | Result |
|---|---|
| `GET /export/cloud` | `1` — cloud blocker intact |
| `GET /api/update-status` | `ok,repo,rawBase,files[7]{name,present,size,md5}`; reports `codex_webui 39793b19… 809608` (independent provenance confirmation) |
| `GET /api/update-check-state` | `ok,checkedAt,available,changes,message,source` — **currently `available=true, changes=4`** (see hazard below) |
| `GET /api/bt-text-status` | `ok,runtime,pid,updated,state,target,sent,skipped,error` — runtime listening |
| `GET /export/mqtt` | full config JSON incl. `broker{host,port,username,password}` (values redacted here) |
| `GET /export/bluetooth` | `version,devices[2]{id,name,type,bdaddr,commands}` |
| `GET /export/wifi` | valid `wpa_supplicant` shape (`ssid`/`psk` redacted) |
| `GET /api/inventory` | `ok,deviceCount:3,…,devices[3]{id,name,…,commands}` — 21,928 B |

Note: `GET /api/inventory` routes through
`repair_known_protocols_for_current_commands()`; it is a strict no-op
(returns before `backup_resources()`) when protocols 2/679 are present.
Verified no write occurred: post-probe `ProtocolList.json` md5
`73b9f2fc41622bb706663152710ee8f2` equals the 07-30 snapshot copy, and the
`resource-backups` set list is unchanged (same 4 sets before/after).

**Hub-state drift found (informational, not caused by this mission):**
on-hub `MapList.json` (`10841328…`) and `ActivityList.json` (`b135aec1…`)
differ from the 07-30 snapshot (`60ca06b2…`/`4b7bf3b0…`); `DeviceList` and
`ProtocolList` match. The snapshot is therefore stale for those two files and
for the binary — see rollback design in §4.

---

## 4. Push runbook (DOCUMENTED ONLY — nothing here was executed)

Preconditions: owner approval given; household TV idle (check `#control`
first); one SSH session; Mac artifacts built and verified.

### 4.0 Package & verify (on the Mac)

```sh
# 1. Regenerate embed + build (this is the standard chain; it will write
#    payload/source/harmony_shell_assets.h and should now be allowed to):
sh tools/embed_activity_ui.sh
zig cc -target mips-linux-musleabi -Os -static -s -I payload/source \
  -o payload/bin/codex_webui payload/source/codex_webui.c
# 2. Verify EXACTLY (IR-lab heap fix is already in the source tree):
md5 payload/bin/codex_webui       # MUST be 08a68298159fa5137b510b28af984789
wc -c payload/bin/codex_webui     # MUST be 906872
# 3. Keep a durable copy of the CURRENT hub binary as the rollback artifact:
ssh -i ~/.ssh/harmony_owner_ed25519 root@192.168.0.123 \
  'cat /data/codex/bin/codex_webui' > /tmp/codex_webui.rollback-39793b19
md5 /tmp/codex_webui.rollback-39793b19   # MUST be 39793b19…
```

### 4.1 Optional flash reclaim (owner-approved list from §2 only)

```sh
ssh … root@192.168.0.123 'rm -r /data/codex/resource-backups/20260727_174852 \
  /data/codex-backups/activity-sync-contract-20260727_0020 \
  /data/codex-backups/hbus-response-fix-20260726-220120; sync'
```

### 4.2 Stage in tmpfs (RAM, zero flash cost)

```sh
# Clean stale staging first (~1.57 MB RAM currently held by leftovers):
ssh … 'rm -f /var/volatile/codex_webui.new /var/volatile/codex_webui.prev \
  /var/volatile/MANIFEST.txt.new /var/volatile/MANIFEST.txt.prev \
  /var/volatile/hhc-enum.sh /var/volatile/hhc-paths.txt /var/volatile/hhc-logread-n.txt'
# scp does not work (no sftp-server) — use a cat pipe:
ssh … 'cat > /var/volatile/codex_webui.new' < payload/bin/codex_webui
ssh … 'md5sum /var/volatile/codex_webui.new'   # MUST match §4.0 step 2
```

### 4.3 Atomic install

```sh
ssh … '
set -e
cp /data/codex/bin/codex_webui /var/volatile/codex_webui.prev
cp /var/volatile/codex_webui.new /data/codex/bin/codex_webui.next
sync
md5sum /data/codex/bin/codex_webui.next        # MUST match again — this line
                                               # is the truncation detector:
                                               # WRONG md5/size => rm .next, STOP (§4.5)
mv /data/codex/bin/codex_webui.next /data/codex/bin/codex_webui
sync
'
# Restart the service (kill; init respawns it — same flow the installer uses):
ssh … 'kill $(pidof codex_webui) 2>/dev/null; sleep 2; /data/codex/bin/codex_webui 8080 & sleep 1; ps | grep "[c]odex_webui"'
```

### 4.4 Health check (GETs only)

```sh
curl -s http://192.168.0.123:8080/export/cloud            # MUST be 1
curl -s http://192.168.0.123:8080/ | grep -c harmony-shell.js   # MUST be 1
curl -s http://192.168.0.123:8080/api/update-status | grep <new-md5>
curl -s http://192.168.0.123:8080/api/activity-config >/dev/null && echo ok
# then browser: all 11 routes per §5 phase 1.
```

Then update `payload/bin/MANIFEST.txt` (new md5/size) and, on explicit owner
request only, commit.

### 4.5 Rollback (two independent paths)

1. **Fast (this-boot):** `/var/volatile/codex_webui.prev` (`39793b19…`) —
   `cp` it back over `/data/codex/bin/codex_webui`, `sync`, restart. Also
   durable on the Mac as `/tmp/codex_webui.rollback-39793b19` (§4.0) — move it
   somewhere permanent before starting.
2. **Disaster:** `~/HarmonyHubBackups/hub-snapshot-2026-07-30/` (1427/1427
   md5-verified). **WARNING:** its binary is `ad1ef2b1` (pre-shell) and its
   `MapList.json`/`ActivityList.json` are stale vs today's hub. Full-snapshot
   restore reverts the shell deploy AND post-07-30 activity edits. Use only
   file-by-file, deliberately.

**Danger lines honored by this runbook:** no reboot required (binary restart
only); cloud blocker untouched; `/import target=devices` never called
(SHIELD `IsKeyboardAssociated=false` cannot be clobbered); secrets never leave
the hub; one SSH session throughout.

---

## 5. Hardware QA plan (after an approved push)

**Phase 1 — read-only (safe immediately):**
- All 11 routes render at desktop + 390 px; 0 console errors; regression pass
  on #home #control #devices #activities #wizard #editor.
- System page: firmware/uptime/memory populate via the HTML probe; measure
  probe wall-time and confirm hub loadavg stays sane (baseline today: 0.00).
- IR page inventory lists 3 real devices; Bluetooth page shows runtime
  listening + 2 saved devices; MQTT page shows real broker config; Backup page
  lists real exports.

**Phase 2 — mutating, owner present, one at a time:**
- Wi-Fi: save the SAME credentials (no-op rewrite) and verify **no reboot**
  and no association drop. Do NOT change SSID/PSK remotely.
- MQTT: save same config; verify broker reconnect.
- Backup: full settings export → diff against live files (read-only import
  test happens in SIM only).
- Auth: enable → 401 challenge → disable, in one sitting (lockout risk:
  keep the SSH session open until confirmed off or working).

**Phase 3 — explicitly gated / forbidden:**
- **IR lab target/clear:** do NOT exercise on hardware unless the heap fix
  rode along (without it the 12.1 MB stack frame kills the request child —
  see §6a). If the fix shipped: safe to test with owner present.
- **Do NOT test:** `/import target=devices` (DeviceList clobber risk incl.
  SHIELD `IsKeyboardAssociated`), reboot button, cloud-blocker toggle,
  update-apply, factory/unpair paths. Activities stay untouched during TV use.
- Physical-remote regression (start/stop Watch TV) only after resource-file
  md5s confirmed unchanged by all of the above.

---

## 6. Owner decisions — options analysis

### (a) IR-lab one-line heap fix ride-along — **APPROVED by owner 2026-07-31; applied in-tree**

`find_ir_device_by_name` (codex_webui.c:1486) puts a `struct ir_inventory` on
the stack. Measured size: 32 devices × (508 + 160 × 2,476 B) ≈ **12.1 MB** vs
the 8 MB default stack rlimit on Linux 2.6.31 — the forked request child for
`/api/ir-lab-target` / `/api/ir-lab-clear` dies by SIGSEGV before `main`-path
code runs (the listener parent survives; the request just resets). This will
fail on the real hub too; "real IR hardware" does not change stack limits.
Three sibling call-sites (:5195/:5234/:5274) already use the heap pattern.

Measured cost (quarantined build, this session): **−112 B raw, −88 B gzip**
(906,872 vs 906,984 — the heap version is *smaller*; giant stack frames cost
extra prologue code on MIPS). Risk: one function, mechanical, same pattern as
adjacent code; emulator QA covers both endpoints.

### (b) Lazy-load setup bundle vs single-bundle embed — **recommended: single bundle**

Measured split: setup pages = **98,700 B** of the 166,546 B minified bundle
(main-only bundle: 67,846 B). But on this embed-all architecture BOTH bundles
still live in the binary's `.rodata`, so lazy-loading saves **zero flash** —
it only cuts per-cold-load transfer (166.5 → 67.8 KB on non-setup routes) and
parse time, at the cost of a `codex_webui.c` edit (extra route + asset array),
a packaging-script change, and a full QA re-run. Flash is the binding
constraint and §2 shows it is not under pressure; LAN transfer of 166 KB is
trivial. Not worth it now; revisit only if a future embed pushes headroom.

### System-page HTML probe (flagged for awareness, no decision forced)

Each `#system` entry issues one `POST /system action=""` → the legacy
`render_page` (~791 KB HTML, SIM-measured with a comparable 3-device
inventory) + 2 multi-command `popen` shells (`uname/meminfo/mount/ps`,
`init-log/logread|grep`) + the activity/status panel hbus call, inside one
fork with the standard 1.01 MiB request buffer. This is the same cost as ONE
legacy dashboard load — a request this hub served routinely before the
redesign. It is user-initiated, deduped while in flight, and never polled.
**Recommendation: accept as-is.** (Cheaper alternatives if it ever matters:
client-session caching of the probe — JS-only; or a small read-only
`/api/system-status` JSON endpoint — a C change, est. +2–4 KB.)

### Update-page downgrade trap (flag for owner)

`update_state.conf` currently reports “4 file(s) need update” vs
`Ripthulhu/harmony-hub-control@main`. The legacy page's browser-driven
**Install update** would fetch upstream binaries and OVERWRITE the deployed
shell (and, post-push, the setup pages). The new System page only exposes
`update-apply` for already-staged files, but the legacy page remains reachable.
Suggest: never use Install update while running locally-built binaries; a
future change could repoint or disable it (owner decision, not part of this push).

---

## 7. Go/no-go recommendation

**GO**, conditional on:

1. Owner approves the push explicitly (this document is analysis, not consent).
2. §4.0 md5 gates pass exactly (`08a68298…`/906,872 — setup pages + IR fix).
3. The durable rollback copy of `39793b19…` is on the Mac before any hub write.
4. Install performed exactly per §4 (tmpfs staging → sync → md5 → atomic
   rename → health checks), one SSH session, TV idle.

No blocking factor was found. The two caveats that keep this conditional
rather than unconditional: jffs2 free space is unprovable on-device (mitigated
by staging + the §4.3 truncation detector + verified rollback), and the 07-30
snapshot is not a clean rollback for the shell era (mitigated by condition 3).

---

## 8. Mission integrity statement

Hub operations this session: SSH `ls/cat/md5sum` reads and the 8 HTTP GETs in
§3. Zero POSTs, zero file writes, zero process changes, no reboot; cloud
blocker verified `1` before and after; `ProtocolList.json` md5 and the
resource-backups set list verified unchanged after the only GET with a
theoretical write path. Load average at probe time: 0.00. The hub is as found.
