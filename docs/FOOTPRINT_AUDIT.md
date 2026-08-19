# Footprint audit — redesigned web UI vs hub budgets

**Scope:** audit only. No production changes, no `payload/` edits, no live hub.
**Date:** 2026-07-30  
**Branch context:** `agent/activity-webgui` @ `5d84cd9` + uncommitted `tools/webui-sim` / `tools/hub-emu` work  
**Method:** byte inventory + trial MIPS embeds (quarantined under `tools/hub-emu/build/footprint-trial/`) + static analysis of `codex_webui.c` + Playwright request/action census against hub-emu (`127.0.0.1:8787` → real MIPS `codex_webui`).  
**QA after measurements:** `node tools/hub-emu/qa.mjs` → **24/24**; `POST /reset` applied.

Ground truth for hardware: `docs/SESSION_HANDOFF.md` §8.

---

## 0. Executive verdict

| Budget | Verdict | Binding constraint |
|--------|---------|-------------------|
| **DISK** (`/data` 5 MiB jffs2) | **fits-with-changes** | Unknown free space; prior in-place ~670 KB replace exhausted `/data`. Naive full embed (+231 KB raw / +99 KB gzip-proxy) is unsafe. Viable only with **vendor+skin dedup**, **no self-hosted full font pack**, install staged via `/var/volatile`, and preferably minify or gzip-at-rest assets. |
| **MEMORY** (62 MB RAM, ~24 MB free typical) | **fits** | Per-connection `malloc(MAX_REQUEST_BYTES)` ≈ **1.01 MiB** always; cold SPA load ≈ **19 hub forks**, browser ~6-wide → ~6 MiB request buffers concurrent. Peak stays well under ~24 MB free for fixture-sized graphs. |
| **COMPUTE** (weak MIPS; 1× `codex_hbus`/s → loadavg 4.75) | **fits** | **Idle UI generates zero hub traffic** (2 min measured). Cost is bursty page-load forks (~19 vs old ~3) and per-action `popen`→`codex_hbus` (pre-existing backend shape). No polling loops in the new shell. |

**Bottom line:** the redesigned UI is hub-correct and **can fit** if ported with deliberate packaging. Shipping every file in `public/` as a second copy of vendor/skin plus CDN fonts self-hosted is the path that **does not fit safely**. Memory and CPU are not the blockers; **flash install headroom** is.

---

## 1. Numbers

### 1.1 Disk — new front-end assets (`tools/webui-sim/public/`)

gzip-9 is used as a **jffs2 zlib-class proxy** (not identical to jffs2, directionally useful).

| Component | Files | Raw (B) | gzip-9 (B) | Notes |
|-----------|------:|--------:|-----------:|-------|
| `index.html` | 1 | 10 227 | 2 272 | Entry; loads Google Fonts CDN |
| New shell CSS | 5 | 58 918 | 12 725 | tokens, app, remote, wizard, activity-overrides |
| New shell JS (ES modules) | 11 | 101 892 | 31 140 | app + views + api/state/wizard-model/remote-layout |
| Vendor editor | 2 | 99 143 | 21 401 | **byte-identical** to `payload/web/activity-ui.{js,css}` |
| Remote skin JPEG | 1 | 59 892 | 59 146 | **same pixels** as `REMOTE_SKIN_JPG_B64` (decoded 59 892 B) |
| **Public tree total** | 20 | **330 072** | **~126 684** (sum of per-file gz) | |

**Dedup facts (measured):**

- `public/vendor/activity-ui.js` ≡ `payload/web/activity-ui.js` (md5 `dbae0a25…`)
- `public/vendor/activity-ui.css` ≡ `payload/web/activity-ui.css` (md5 `1ba520ed…`)
- Skin JPEG ≡ bytes decoded from `payload/source/remote_skin_jpg.h` (md5 `3b8b3763…`)
- Production already embeds vendor as `/assets/activity-ui.js|css` and inlines skin as a **data-URI** from B64 (~79 856 B of B64 text in the binary today).

**Google Fonts (IBM Plex Sans 400/500/600 + Mono 400/500):**

| Strategy | Approx size | Hub-viable? |
|----------|------------:|-------------|
| CDN (current `index.html`) | 0 on flash | **No** — hub is offline-by-design (no default route / WAN) |
| Self-host all unicode subsets | ~261 KB WOFF2 | Poor use of flash |
| Self-host **latin only** (measured) | **75 308 B** (3 files fetched under Chrome UA; already compressed) | Possible but optional |
| System UI fonts / drop webfonts | 0 | Preferred for hub port |

### 1.2 Disk — what already lives on `/data` (fixture-equivalent + repo bins)

| Occupant | Raw (B) | gzip-9 proxy (B) |
|----------|--------:|-----------------:|
| `payload/bin/*` eight tools (incl. dropbear) | 1 854 840 | ~774 574 (sum) |
| of which `codex_webui` production | **684 148** | **257 771** |
| Resource seed (Activity/Map/Device/Function/Protocol/Automation) | 414 591 | Map+Device+Activity alone ~20.7 KB gz |
| Resource backups worst case (5 sets × 6 files, fixture-sized) | **~2 072 955** logical | jffs2 compresses; still the largest reclaimable tenant |
| Partition `/data` (mtd4) | **5 242 880** | n/a |

There is **no free-space query** on device. Logical sum of known tenants already approaches the partition size before compression; compression is why it works today. A prior **~670 KB in-place binary replace exhausted `/data` mid-write**.

### 1.3 Disk — trial MIPS embed builds (exact growth)

Toolchain (production recipe, scratch only):

`zig cc -target mips-linux-musleabi -Os -static -s`

Sources copied to `tools/hub-emu/build/footprint-trial/` (payload untouched). Shell assets forced into the link so growth is real.

| Variant | What is embedded beyond today’s vendor JS/CSS | Binary raw | gzip-9 of binary | Δ raw vs baseline | Δ gz vs baseline |
|---------|-----------------------------------------------|----------:|-----------------:|------------------:|-----------------:|
| **BASELINE** | (control; footprint anchor only) | 684 168 | 257 801 | 0 | 0 |
| **FULL** | index + shell CSS + shell JS + **raw skin JPEG again** | 915 144 | 356 712 | **+230 976** | **+98 911** |
| **DEDUP** | index + shell CSS + shell JS (reuse vendor routes + existing B64 skin) | 855 240 | 295 549 | **+171 072** | **+37 748** |
| **DEDUP_MIN** | same as DEDUP after whitespace/comment squeeze | 828 360 | 290 104 | **+144 192** | **+32 303** |
| **GZIP_EMBED** | DEDUP payloads stored pre-gzip-9 (would need `Content-Encoding`) | 722 568 | 297 940 | **+38 400** | **+40 139** |

Production `payload/bin/codex_webui`: 684 148 raw, md5 `ad1ef2b1…` (baseline trial differs by the tiny keep-anchor stub only).

**Interpretation:**

- **FULL** pays twice for skin (B64 already in binary + raw array) and is the worst flash story.
- **DEDUP** is the honest minimum feature embed: ~**+171 KB raw**, ~**+38 KB** jffs2-proxy.
- **GZIP_EMBED** wins **install safety** (smaller file to stage) but jffs2-proxy of the whole binary is **not** better than DEDUP — precompressed blobs resist a second compressor. Benefit appears when flash stores the smaller raw binary / when serving encoded bodies without expanding into a second copy.
- Self-hosting latin fonts on top of DEDUP: **+75 KB** more if embedded or loose on flash.

### 1.4 Memory — allocation paths (`payload/source/codex_webui.c`)

| Limit / path | Value | Role |
|--------------|------:|------|
| `MAX_REQUEST_BODY` | 1 048 576 | 413 beyond this |
| `MAX_REQUEST_BYTES` | 1 056 768 | **`read_request` always `malloc`s this** before parsing |
| `MAX_RESOURCE_FILE` | 2 097 152 | per-file read cap |
| Fork model | `listen` backlog 8; **`fork` per accept** (~L8753) | each connection = child process |
| `GET /api/activity-config` | 4× `read_file_alloc` | fixture: ~415 KB resident lists while responding (~414 680 B JSON out) |
| `POST /api/activity-save` | req body + 3 extracted lists + 3 old + 3 saved + 32 KiB commit/rollback stacks | fixture save body **~340 KB**; heap peak order **~2.0–2.4 MiB** in that child |
| `GET /api/activity-state` / run | small; **`popen` → `codex_hbus`** | reply buffers 8 KiB-class |
| `POST /api/ir-send` | protocol repair may touch ProtocolList + **resource backup**; BT path may `hcitool`/`hal` before `holdaction` | first send heavier than steady |

**Concurrency bound (structure, not qemu RSS):**

| Scenario | Order-of-magnitude heap in flight |
|----------|-----------------------------------|
| 6 parallel asset/module GETs (browser default) | 6 × ~1.01 MiB request buffers ≈ **6.0 MiB** (buffers freed after headers; short-lived) |
| 1× activity-config during that burst | +~0.4 MiB lists |
| Observed cold load | ~19 sequential/parallel hub requests; peak concurrent likely ≤6–8 |
| 1× activity-save | ~2.0–2.4 MiB in one child |
| Typical free RAM (handoff) | **~24 MiB** (62 MB device; `/var/volatile` is RAM) |

**Verdict math:** even stacking 8 × 1 MiB request buffers + one config read (~8.5 MiB) leaves double-digit MiB free. The redesigned UI does **not** invent larger server buffers; it multiplies short-lived forks. Save remains the heaviest single handler and is **user-gated**.

Embedded assets live in `.rodata` of the static binary: FULL/DEDUP grow the mapped image by the Δ raw above; they are shared across forks (COW / shared text), not multiplied per connection.

### 1.5 Compute / requests — Playwright census (cache disabled, fresh context)

**Hub process model:** each same-origin request → one `fork` + `handle_client`.  
**HBus spawn:** `run_cmd` → `popen` → `/data/codex/bin/codex_hbus` for `getCurrentActivity`, `startactivity`, `holdaction` (and BT helpers on some IR paths).

#### Cold load (hub-origin counts; fonts are external and die on real hub)

| Route | Hub reqs | Hub API | External (CDN fonts) | Notes |
|-------|--------:|--------:|---------------------:|-------|
| `#control` | **19** | 2 | 2–3 | 1 HTML + 4 CSS + 11 JS + skin + config + state |
| `#activities` | 21 | **4** | 2 | **double** `activity-config` + **double** `activity-state` |
| `#wizard` | 20 | 3 | 2 | double config |
| `#home` | 21 | 3 | 3 | double config; also `GET /sim/events` (sim-only; **404 on box**) |
| `#editor` | **24** | 4 | 2 | + `vendor/activity-ui.js|css` + `activity-overrides.css` (lazy vendor boot) |

**Static graph (every cold load of the shell):**

- HTML 1, CSS 4 (tokens/app/remote/wizard), JS modules 11, JPEG 1 → **17 static** + 2 API = **19** on `#control`.
- Old production UI: server-rendered `/` + `/assets/activity-ui.css` + `/assets/activity-ui.js` ≈ **3** hub requests (skin inlined).

**Bytes (control cold, including one 414 680 B config):** hub-dominated ~0.7 MB transfer; config is ~99% of API weight.

#### User actions (post-load deltas)

| Action | Extra hub reqs | Payload | Backend cost |
|--------|---------------:|---------|--------------|
| Key press (mapped hotspot) | **1** | `POST /api/ir-send` ~50 B form | `repair_known_protocols…` (cheap after first) + optional BT preconnect chain + **`codex_hbus` `holdaction`** |
| Long-press | **1** | same `ir-send` | same; UI timer only |
| Run activity | **2** | `POST /api/activity-run` + `GET /api/activity-state` | **2× hbus** (`startactivity`, `getCurrentActivity`) |
| Reorder activities (save) | **2** | `POST /api/activity-save` **~340 210 B** + `GET /api/activity-config` ~446 KB | full save path + backup if changed; **no hbus** for writer IPC file path |
| No-op save (mirror) | 2 | save body ~340 KB; `activityChanged:false` | validates revision; no backup when unchanged |

#### Steady state

| Test | Result |
|------|--------|
| UI open on `#control`, **120 s**, no input | **`backgroundHubReqs: 0`** |
| `setInterval` / poll loops in new shell | **None** (only one-shot `setTimeout` for long-press UI and vendor post-save refresh) |

#### popen / fork summary

| Event | forks (hub HTTP) | `codex_hbus` spawns (typical) |
|-------|-----------------:|------------------------------:|
| Cold `#control` | ~19 | 1 (`activity-state`) |
| Cold `#editor` | ~24 | 2 (double state) |
| Run | +2 | +2 |
| Key | +1 | +1 (+ N BT/hal if Transport 32 cold) |
| Idle 2 min | 0 | 0 |

Calibration anchor (handoff): spawning `codex_hbus` **once per second** → load average **4.75**. The new UI does **not** do that. A human mashing keys could approach that rate; that cost is the existing IR API, not a new poller.

---

## 2. Verdicts (justified)

### 2.1 DISK — **fits-with-changes**

**Binding constraint:** 5 MiB jffs2 `/data` with **unknowable free space**, large backup retention, and a proven **mid-write truncation** on ~670 KB replace.

- Embedding the shell with **DEDUP** is ~**+38 KB** jffs2-proxy / **+171 KB** raw on `codex_webui` — plausible **if** install is staged from tmpfs and backups are pruned before replace.
- **FULL** (+99 KB gz-proxy / +231 KB raw) and **FULL + fonts** push risk into “likely need deletes first” territory.
- Loose static files on flash **instead of** embed still consume the same compressed bytes and need a static handler the box lacks today.
- CDN fonts contribute **0** flash but **break offline**; self-hosting latin adds ~75 KB.

Not **fits** unconditionally: free space cannot be proven from the device.  
Not **does-not-fit**: DEDUP_MIN/DEDUP growth is small relative to backup churn (~2 MB logical worst case).

### 2.2 MEMORY — **fits**

**Binding constraint:** fork-per-request × **1.01 MiB** read buffer × browser parallelism on cold load.

Measured/structured peak remains **≪ 24 MiB free** for current fixture (~415 KB resources, ~340 KB saves). The UI does not add server-side caches or workers. Risk would appear only with pathological concurrency plus multi-megabyte resource graphs approaching `MAX_RESOURCE_FILE`.

### 2.3 COMPUTE — **fits**

**Binding constraint:** MIPS cost of **`popen`→`codex_hbus`** on state/run/ir-send (pre-existing), plus **larger cold-load fork burst** (new).

Mitigating facts: **zero idle traffic**, no intervals, actions are 1–2 hub calls. Cold load ~19 forks is harsher than the old 3-request UI but is a one-shot burst, not a sustained loadavg driver like 1 Hz hbus sampling.

---

## 3. Ranked recommendations (do not implement here)

Estimated savings are vs a naive FULL embed of the entire `public/` tree into `codex_webui` (~+231 KB raw / +99 KB gz-proxy), unless noted.

| Rank | Recommendation | Est. saving / effect | Risk / notes |
|-----:|----------------|----------------------|--------------|
| 1 | **Vendor dedup** — serve editor from existing `/assets/activity-ui.js|css`; do not embed `public/vendor/*` again | **~99 KB raw** out of tree; avoids second copy of 88 711+10 432 B | `#editor` already lazy-loads vendor paths; point them at `/assets/…` |
| 2 | **Skin dedup** — keep B64/data-URI or single raw embed, never both | **~60 KB raw** (FULL vs DEDUP skin delta) | Match one strategy in HTML |
| 3 | **Font strategy: system stack** (drop Google Fonts) | **75–261 KB** flash avoided; **3 external reqs** removed; works offline | Visual change vs sim; document in DESIGN.md |
| 4 | **Single-bundle (or few-bundle) JS/CSS** for hub port | Cold load hub reqs **19 → ~5–7**; fewer forks / less 1 MiB buffer churn | Still embed or static-serve the bundles; loses fine-grained cache (irrelevant with `Cache-Control: no-store`) |
| 5 | **Minify** shell JS/CSS/HTML before embed | Trial **DEDUP → DEDUP_MIN: −27 KB raw / −5.4 KB gz-proxy** | Use real minifier in release pipeline; trial was whitespace-only |
| 6 | **Gzip-at-rest + `Content-Encoding: gzip`** for embedded/static assets | Trial raw binary **+38 KB** vs +171 KB; install safer | jffs2-proxy of whole binary ~same as DEDUP; must not double-compress wrongly; gunzip on tiny MIPS if decompressed in process would **hurt RAM** — prefer send compressed bytes as-is |
| 7 | **Fix double `activity-config` / `activity-state`** on `#activities`, `#wizard`, `#editor`, `#home` | **−1 heavy config read (~415 KB)** and **−1 hbus** on affected cold loads | Client state already shared; likely duplicate `ensureConfig`/`onShow` |
| 8 | **Drop or gate `#home` `/sim/events`** for production | Avoids a guaranteed **404 fork** on box | Sim-only API |
| 9 | **Backup retention** — keep 2–3 resource backup sets instead of 5, or exclude MapList from oldest sets | Up to **~0.8–1.2 MB logical** reclaim (fixture-scaled) | Operational; largest flash lever on device today |
| 10 | **Install procedure** — stage new `codex_webui` in `/var/volatile`, `sync`, atomic rename; prune backups first | Prevents repeat of mid-write truncate | Process, not code size |
| 11 | **Optional: lazy-route code split** that does **not** load wizard/editor modules until navigated | Smaller first paint bundle; fewer initial forks if split across requests carefully | On embed-all architectures, splitting without HTTP multi-file may not reduce flash |
| 12 | **Do not** self-host full multi-subset IBM Plex | Avoid **~261 KB** | Latin-only only if brand insists |

**Packaging recipe that the numbers support (recommendation only):**

1. System fonts.  
2. Embed or serve: `index` + minified shell CSS + minified shell JS bundle.  
3. Reuse `/assets/activity-ui.*` for advanced editor.  
4. One skin strategy (existing B64 inline or one JPEG route).  
5. Stage binary via tmpfs; prune `resource-backups` before replace.  
6. Expect `codex_webui` ≈ **0.83–0.86 MB** raw (DEDUP_MIN/DEDUP class), **~290–296 KB** gz-proxy — not 0.92 MB FULL.

---

## 4. Method notes & limits

- **qemu-user / Docker memory and CPU are not the box** — used only for contract fidelity and request structure.
- jffs2 size ≠ gzip-9 of file; gzip-9 is a **proxy**.
- Free space on hub **cannot** be measured with available BusyBox tools (`df` absent).
- Request census used Playwright with **cache disabled** and `?fresh=` URLs; dev-proxy on **8787** confirmed (`hub-emu/dev-proxy.mjs`), not the old mock.
- Action census drove real `ir-send` / `activity-run` / `activity-save` against hub-emu; first `ir-send` may create a resource backup (reset afterward).
- Trial builds: `tools/hub-emu/build/footprint-trial/` (quarantined README included).

---

## 5. Artifact index

| Path | Purpose |
|------|---------|
| `tools/hub-emu/build/footprint-trial/out/codex_webui.*` | MIPS binaries for size table |
| `tools/hub-emu/build/footprint-trial/request-census.json` | Cold-load + steady-state network log |
| `tools/hub-emu/build/footprint-trial/action-census.json` | Run / key / save / long-press |
| `tools/hub-emu/build/footprint-trial/assets/` | Bundled shell inputs |
| `docs/FOOTPRINT_AUDIT.md` | This report |

---

*HALT. Audit complete. No port, optimize, or refactor performed.*
