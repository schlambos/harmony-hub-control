# Box Snapshot 2026-08-18 — Provenance Derivation Ledger

Status: **security-verifier and Oracle Gate 1 completed — Phase 1 passed;
Phase 2 provenance remediation applied** (pinned baseline ancestry,
integrity-pinned binary pilot reports ingested). Offline and deterministic.
No payload/source/build files were modified; no private evidence objects
were copied into the repository.

## What this is

`tools/reconciliation/derive_provenance.py` (Python standard library only, no
network, no box access) derives a provenance ledger for all **23 live entries**
of the authoritative evidence snapshot
(`reconciliation/evidence/box-snapshot-20260817/snapshot-nonsecret/manifest.json`,
collected read-only over SSH by `collect_box_snapshot`) against a **union scan
of two git repositories**:

- the read-only historical clone (primary; a genuine **shallow** clone — its
  `.git/shallow` truncates ancestry at the fork point `d87cebaf…`);
- the fresh reconciliation clone (baseline, default = this repository), which
  carries the missing full ancestry.

Commits and blobs are pooled and deduplicated by full SHA; an object resolves
in whichever repo holds it. A parent counts as a history gap only when it is
missing from **every** scanned repo. All access is git plumbing under
`--no-optional-locks`; neither repo is ever written. Generated outputs
reference both repos by sanitized labels only — never absolute local paths.

All identifications below were **computed directly from git history by the
tool** (every scanned commit's tree walked, every candidate blob byte-hashed
and compared to the live SHA-256). No earlier report's hash values were reused.

Generated artifacts (deterministic — two runs are byte-identical; no wall-clock
timestamps; ordering is committer epoch, then SHA):

| File | Content |
| --- | --- |
| `provenance/box-snapshot-20260818/artifact-map.json` | 23-entry ledger: live path/kind/mode/size/SHA-256/MD5/target; repo artifact+source candidate paths; exact git blob SHAs; full commit lists, earliest/latest commits; variant lineage; per-entry statuses and evidence |
| `provenance/box-snapshot-20260818/reproducibility-status.json` | per-entry and summary statuses, status counts, staleness summary, public-safety register, blockers, scanned history |
| `provenance/box-snapshot-20260818/public-payload-manifest.json` | sanitized **NON-CANONICAL** public manifest: approved live paths, kinds, modes, sizes, SHA-256/targets only — no host IP, user, identity, local paths, MD5s, or object bytes |
| `provenance/box-snapshot-20260818/public-safety-review.json` | sanitized durable record of the completed independent public-safety review (categories and verdicts only) |
| `provenance/box-snapshot-20260818/staging-contract.json` | machine-readable staging contract (required closure, exact mappings, allowed exact-build binaries, expected blockers, no-fallback policy, output schema) |
| `docs/reconciliation/staging-contract.md` | human-readable companion to the staging contract |

The staging contract and its companion document register the deterministic
staging builder (`tools/reconciliation/build_staging.py`). The tracked stale
`payload/bin/MANIFEST.txt` remains untouched by both the derivation and the
staging tool, and the staging tool never reads it (it stages only the
sanitized public manifest, the reproducibility status, current repo text
sources, and caller-supplied source-built binaries).

## Scanned history (union)

- **112 unique commits**, deterministic under baseline pinning: the
  historical clone contributes 57 (all of its intended refs, including the
  agent branch); the baseline clone contributes ONLY the pinned public base
  commit `d87cebafdee36ec33f1e4ea3055239dbfea6aa09` and its ancestry
  (`--baseline-ref` / `HARMONY_PROVENANCE_BASELINE_REF`). Union arithmetic:
  57 + 89 − **overlap 34** = 112 (55 baseline-unique, 23 historical-unique).
  The live reconciliation branch (c2cc1ea and any successor) is NEVER
  scanned, so new reconciliation commits cannot change generated outputs
  (proven by the ref-immunity test, which creates extra commits/refs in the
  baseline repo and asserts byte-identical artifacts and a stable count).
- The shallow boundary of the historical clone (`1a9e27090b05f835e20b2a9a9ce76bd0d59be2b9`,
  parent of `d87cebaf…`) **resolves via the baseline clone**: no history gaps
  remain, and the former HISTORY_GAP blocker is gone.
- Key refs: historical `refs/heads/agent/activity-webgui` = `0828c08a…`,
  `refs/heads/main` = `d87cebaf…`, `refs/remotes/fork/agent/activity-webgui` =
  `41236d8a…`; baseline adds `refs/remotes/origin/agent/activity-webgui` =
  `41236d8a…` and the working branch at `d87cebaf…`. Full union list in the
  artifacts.

## The 23 entries

| Live path | Kind | Size | Source provenance | Build status | Blob match | Commits | Git blob |
| --- | --- | --- | --- | --- | --- | --- | --- |
| /cache/bin/bthid_keyboard | symlink | 36 | SYMLINK_NO_CONTENT | n/a | — | — | — |
| /data/codex/bin/MANIFEST.txt | file | 749 | GENERATED_DYNAMIC (stale/incoherent) | n/a | no | — | — |
| /data/codex/bin/codex_bt_pair_agent | file | 111796 | CANDIDATE_SOURCE_BINARY_MATCH_ONLY | **RECIPE_UNPROVEN** (pilot) | yes | 54 | e512cd4641b6… |
| /data/codex/bin/codex_bthid_keyboard | file | 116452 | CANDIDATE_SOURCE_BINARY_MATCH_ONLY | **RECIPE_UNPROVEN** (pilot) | yes | 54 | 47d0bd1eb7ff… |
| /data/codex/bin/codex_dhcpd | file | 104168 | **EXACT_SOURCE_REPRODUCIBLE** | **EXACT_SOURCE_REPRODUCIBLE** | yes | 111 | 48070f511298… |
| /data/codex/bin/codex_hal_ltcp | file | 76772 | CANDIDATE_SOURCE_BINARY_MATCH_ONLY | **RECIPE_UNPROVEN** (pilot) | yes | 54 | 119eeed9a122… |
| /data/codex/bin/codex_hbus | file | 74660 | CANDIDATE_SOURCE_NO_BINARY_MATCH | **RECIPE_UNPROVEN** | no | — | — |
| /data/codex/bin/codex_portal | file | 109548 | **EXACT_SOURCE_REPRODUCIBLE** | **EXACT_SOURCE_REPRODUCIBLE** | yes | 111 | a745df84f2ca… |
| /data/codex/bin/codex_webui | file | 906872 | CANDIDATE_SOURCE_BINARY_MATCH_ONLY | HISTORICAL_BINARY_MATCH_ONLY | yes | **32** | 25b395ac3aa1… |
| /data/codex/bin/dropbear | symlink | 13 | SYMLINK_NO_CONTENT | n/a | — | — | — |
| /data/codex/bin/dropbearkey | symlink | 13 | SYMLINK_NO_CONTENT | n/a | — | — | — |
| /data/codex/bin/dropbearmulti | file | 577296 | THIRD_PARTY_BINARY | UNVERIFIED_THIRD_PARTY | yes | 111 | 7ea86221aa80… |
| /data/codex/init.sh | file | 2647 | EXACT_COMMITTED_SOURCE | n/a | yes | 54 | a4cd566df4be… |
| /data/codex/offline_egress_guard.sh | file | 1753 | EXACT_COMMITTED_SOURCE | n/a | yes | 55 | c949ca888862… |
| /data/codex/recovery_ap.sh | file | 1859 | EXACT_COMMITTED_SOURCE | n/a | yes | 111 | 3f994bcee6a5… |
| /etc/init.d/rcS.local | file | 2799 | EXACT_COMMITTED_SOURCE | n/a | yes | 111 | 96974eb98b5c… |
| /opt/luaworks/tasks/connectserver/netservicestarter.lua | file | 12707 | **RECONSTRUCTED_SOURCE_EXACT** + **PUBLIC_SAFETY_PASS** | n/a | no | — | — |
| /pkg/codexactivity/codexactivity.lua | file | 18551 | EXACT_COMMITTED_SOURCE | n/a | yes | **1** | aa97d229207b… |
| /pkg/codexactivity/manifest.json | file | 27 | EXACT_INSTALLER_LITERAL | n/a | — | 55 | — |
| /pkg/codexmqtt/codexmqtt.lua | file | 23533 | EXACT_COMMITTED_SOURCE | n/a | yes | 56 | e7c998753fdc… |
| /pkg/codexmqtt/manifest.json | file | 23 | EXACT_INSTALLER_LITERAL | n/a | — | 94 | — |
| /usr/sbin/dropbear | file | 52 | **RECONSTRUCTED_SOURCE_EXACT** (near-miss) | n/a | no | — | — |
| /usr/sbin/dropbearkey | file | 48 | EXACT_COMMITTED_SOURCE | n/a | yes | 111 | e0731199f4e2… |

The union with the baseline's deeper ancestry raised several counts (e.g.
dhcpd/portal/rcS.local/recovery_ap/dropbearmulti/dropbearkey now matched
across 111 commits, the codexmqtt installer literal across 94, earliest
`c6275b7564347f0bf74f91ba70637197dc7487e8`): the same blobs persist through
the pre-fork upstream lineage. The webui window and the single-commit
codexactivity lineage are unchanged. Full 40-char SHAs, complete commit lists,
earliest/latest commits, and variant lineages are in `artifact-map.json`.

## Key findings

### Text artifacts — exact byte provenance

Seven live scripts/Lua files are byte-identical to committed blobs; the two
`/pkg/*/manifest.json` files equal the literals written by `install_webui.py`
(`upload_text('{"plugin":…}\n', "/pkg/…/manifest.json")` — mqtt literal
present since `c6275b75…` (94 commits), activity literal since `309cec3a…`
(55 commits); both through HEAD `0828c08a…`).

- `/pkg/codexactivity/codexactivity.lua` matches blob `aa97d229207b…` in
  **exactly one commit**: `309cec3ab15d96780ce4b5b6f7032aea296f0996`
  (2026-07-27, "feat: make activity sync fully offline").

### codex_webui — exact commit enumeration

Live SHA-256 `c400173bb42f735734c522556c69f6c80f0604949413eb974c7b361b9e4ac11a`
equals git blob `25b395ac3aa18e408e6aaaf49766256641df9b57` of
`payload/bin/codex_webui` in **exactly 32 of the 112 scanned commits**:

- earliest: `d64716c97651d389647df4dd429f85b5166c2f3a` (2026-07-31T18:54:29Z)
- latest: `93d1d7f91e82bced7b996a2bd51454b1774b16e9` (2026-08-02T12:52:40Z)
- present at the tips of both `refs/remotes/fork/agent/activity-webgui`
  (historical clone) and `refs/remotes/origin/agent/activity-webgui`
  (baseline clone), **not** at dirty-clone HEAD `0828c08a…` (newer rebuilt
  webui binaries) — the hub runs the fork-branch build.
- Within those 32 commits the candidate source `payload/source/codex_webui.c`
  appears as two distinct blobs (24 + 8 commits): the deployed binary
  predates the final source revisions on that line — recorded, not asserted
  as a reproduction.

The 32-commit list is independently re-derived by the test suite directly
from the union of both repos' git histories before comparison.

### codex_hbus — RECIPE_UNPROVEN

No committed blob matches the live binary. The bounded local-reproduction
diagnostic (`evidence/.../diagnostics/hbus-repro/report.json`, verdict
`RECIPE_UNPROVEN`, SHA-256-pinned in the ledger) is incorporated: the
documented zig recipe is disproven as-written (ISA mismatch), the justified
`-mcpu=mips32` variant reproduces ELF identity and size within 20 bytes
byte-deterministically but reproduces **neither** reference binary. The live
binary equals the known-good on-hub backup reference of 2026-07-30 (md5
`e8e62d85…`), distinct from every committed build. **Build remains
UNVERIFIED.**

### netservicestarter.lua — DIAG patch, reconciliation-branch reconstruction

Live md5 `aee70756…` (12,707 B) has **no exact committed source** in any of
the 112 scanned commits (committed: clean 11,788-B blob across 55 commits,
plus an older 5,615-B variant across 2). The committed
`docs/SESSION_HANDOFF.md` documents the live digest across 33 commits and
identifies the on-hub backed-up clean original, which the ledger confirms
equals the committed clean blob lineage. The live bytes are byte-identical to
the current reconciliation-branch working-tree source
`payload/scripts/netservicestarter.lua` (SHA-256
`e9722835033257ec0f7dd4f66df4f1f037ee8139cd7bbadaecb7c6f37b9a652c`, 12,707 B),
which is absent from the pinned 112-commit union scan. Source provenance:
`RECONSTRUCTED_SOURCE_EXACT` (introduced by the reconciliation branch), with
the near-miss and backed-up-clean-original historical evidence retained.

### /usr/sbin/dropbear — near-miss wrapper, reconciliation-branch reconstruction

The live 52-byte wrapper (`exec /data/codex/bin/dropbear -K 300 "$@"`) differs
from the committed 58-byte `payload/scripts/dropbear` (`… -s -g -K 300 …`)
exactly by the `-s -g` tokens. The live bytes are byte-identical to the
current reconciliation-branch working-tree source `payload/scripts/dropbear`
(SHA-256 `cb07cd5483028c5fd4ac7a090d32b87776b9308b0115ab157fe63b3ffe6afce6`,
52 B), absent from the pinned 112-commit union scan. Source provenance:
`RECONSTRUCTED_SOURCE_EXACT` (introduced by the reconciliation branch), with
the near-miss analysis retained. `/usr/sbin/dropbearkey` is an exact match
across 111 commits.

### Live MANIFEST.txt is stale and incoherent

`/data/codex/bin/MANIFEST.txt` (749 B) disagrees with the actual live files:

| Name | Listed md5 / size | Live md5 / size |
| --- | --- | --- |
| codex_bthid_keyboard | 29a34114… / 114932 | f55eaefe… / 116452 |
| codex_hal_ltcp | 4c408478… / 108764 | 282c6066… / 76772 |
| codex_hbus | 30d0f093… / 74660 | e8e62d85… / 74660 |
| codex_webui | 39793b19… / 809608 | 6f05d649… / 906872 |

codex_dhcpd, codex_portal, dropbearmulti match; **codex_bt_pair_agent is
missing from the listing entirely.** Marked `stale: true`, `incoherent: true`
in both `artifact-map.json` and `reproducibility-status.json`.

## Public-safety review (completed, incorporated)

The completed independent public-safety review is recorded in sanitized,
durable form in `public-safety-review.json`:

- **overall: PUBLIC_SAFETY_PASS**; no pending safety items.
- All 23 allowlisted live paths/digests reviewed safe.
- The DIAG netservicestarter live source bytes: **PUBLIC_SOURCE_SAFE** (its
  *source provenance* is RECONSTRUCTED_SOURCE_EXACT — reconciliation-branch
  working tree — and is tracked separately; the safety verdict makes no
  provenance or reproducibility claim).
- `codex_bthid_keyboard`: the concrete Bluetooth MAC addresses in the
  candidate source are self-test fixtures documented in
  `docs/SESSION_HANDOFF.md` (bthid section, ~lines 405-407) and the owner
  previously elected to publish as-is. The review records the **category**
  (`SELF_TEST_FIXTURE_MACS_DOCUMENTED_OWNER_ELECTED_PUBLISH_AS_IS`) only —
  the MAC values are deliberately not reproduced in any generated output.
- Recorded limitation: the safety pass **does not** authorize copying
  evidence binaries or private objects into `payload/`; nothing was copied.

## Binary reproducibility pilot reports (Phase 2, integrity-pinned)

Two local binary pilot reports are ingested with SHA-256 integrity pinning,
and a reproduction claim propagates ONLY when the report's rebuilt digest
equals the live digest (verdict + hash + integrity all checked in code):

| Report | SHA-256 | Verdict | Coverage |
| --- | --- | --- | --- |
| `binary-pilots/dhcpd-portal/report.json` | `25bd2435e36177ea3aed0d931e1a81a634508f7617b0f621a9967e6f6177eee4` | EXACT_SOURCE_REPRODUCIBLE | codex_dhcpd, codex_portal: two independent container builds from the exact candidate source with the pinned Bootlin mips32-uclibc toolchain (tarball SHA-256 verified) are byte-identical to each other AND to the live evidence digests |
| `binary-pilots/bt-hal-hbus/report.json` | `68b353b647c462b23125c90407a11c6d2f7dafffbdf4a3a1d0509ae2a271ac68` | RECIPE_UNPROVEN | codex_bt_pair_agent, codex_bthid_keyboard, codex_hal_ltcp, codex_hbus: exact documented Bootlin recipe is deterministic but wrong ISA (mips32 r1 vs live r2); the single justified Zig follow-up reproduces exact ELF identity byte-deterministically with a uniform +20 B residual and no md5 match |
| `hbus-repro/report.json` (prior) | sha-pinned in ledger | RECIPE_UNPROVEN | corroborating prior evidence for codex_hbus |

Resulting per-binary statuses: dhcpd/portal **EXACT_SOURCE_REPRODUCIBLE**
(`build_verified_count = 2`); pair-agent/bthid/hal/hbus **RECIPE_UNPROVEN**;
codex_webui **HISTORICAL_BINARY_MATCH_ONLY** (no pilot yet; lineage evidence
only); dropbearmulti **UNVERIFIED_THIRD_PARTY**.

## Reproducibility policy encoded in the outputs

A historical binary blob match is **deployment-lineage evidence only** — it
never claims the binary rebuilds from the candidate source.
`EXACT_SOURCE_REPRODUCIBLE` is asserted only from integrity-pinned pilot
reports whose rebuilt SHA-256 equals the live digest. Phase-2 uncommitted
text/source work is NOT claimed as committed provenance anywhere in the
generated outputs.

## Blockers (machine-readable in `reproducibility-status.json`)

1. `UNRESOLVED_BINARY_REPRODUCIBILITY` — 6 binaries lack proven exact source
   reproduction (codex_bt_pair_agent, codex_bthid_keyboard, codex_hal_ltcp,
   codex_hbus, codex_webui, dropbearmulti); dhcpd/portal are resolved.
2. `LIVE_MANIFEST_STALE` — 4 hash/size mismatches, 1 omission.

Resolved by earlier remediations: `HISTORY_GAP` (union baseline resolves
`1a9e270…`); `PUBLIC_SAFETY_PENDING` (review completed → PUBLIC_SAFETY_PASS);
`NO_BINARY_BUILD_REPRODUCIBILITY` (superseded by the accurate per-binary
UNRESOLVED_BINARY_REPRODUCIBILITY blocker now that dhcpd/portal are
reproduced exactly); `MANUAL_SOURCE_REQUIRED` ×2 (netservicestarter.lua DIAG
variant and /usr/sbin/dropbear near-miss wrapper are now
`RECONSTRUCTED_SOURCE_EXACT` from the reconciliation-branch working tree).

## Regenerate / validate (offline)

The derivation tool bakes in **no personal or machine-specific defaults**.
Identify the primary historical clone explicitly via CLI or environment
variable (generic placeholders shown):

```
# derive (baseline defaults to this repository; env-overridable)
HARMONY_PROVENANCE_SOURCE_REPO=/path/to/historical-clone \
    python3 tools/reconciliation/derive_provenance.py
# equivalent: python3 tools/reconciliation/derive_provenance.py \
#     --source-repo /path/to/historical-clone \
#     [--snapshot-dir /path/to/evidence/snapshot-nonsecret] \
#     [--hbus-report /path/to/hbus-repro/report.json] \
#     [--baseline-repo /path/to/full-ancestry-clone] \
#     [--baseline-ref <full-public-base-SHA>]   # default: d87cebaf...6aa09 \
#     [--pilot-dhcp-portal-report /path/to/report.json] \
#     [--pilot-bt-hal-hbus-report /path/to/report.json] \
#     [--out-dir provenance/box-snapshot-20260818]

# provenance tests (fixture tests always run; real-evidence tests run only
# when the env vars identify the inputs)
HARMONY_PROVENANCE_SOURCE_REPO=/path/to/historical-clone \
    python3 -W error::ResourceWarning -m unittest \
    tools.reconciliation.test_derive_provenance -v

# collector tests + byte-compilation
python3 -W error::ResourceWarning -m unittest tools.reconciliation.test_collect_box_snapshot
python3 -m py_compile tools/reconciliation/derive_provenance.py \
    tools/reconciliation/test_derive_provenance.py
```

Optional environment overrides: `HARMONY_PROVENANCE_SNAPSHOT_DIR`,
`HARMONY_PROVENANCE_HBUS_REPORT`, `HARMONY_PROVENANCE_BASELINE_REPO`,
`HARMONY_PROVENANCE_BASELINE_REF` (default pins the public base commit
`d87cebafdee36ec33f1e4ea3055239dbfea6aa09`),
`HARMONY_PROVENANCE_PILOT_DHCP_PORTAL_REPORT`,
`HARMONY_PROVENANCE_PILOT_BT_HAL_HBUS_REPORT`.
Collector test constants use RFC 5737 TEST-NET examples (`192.0.2.123`,
`testuser`); the production collector CLI remains fully configurable and the
private collection evidence is unaltered. Generated artifacts embed sanitized
labels and digests only, so they are byte-identical wherever the inputs live
(pinned by the freshness test).

The provenance suite (53 tests, ResourceWarning-clean under
`-W error::ResourceWarning`) covers: exact 23-entry coverage in all four
artifacts; byte-determinism and committed-artifact freshness (outputs stay
byte-identical wherever the env-identified inputs live); live fields equal to
the authoritative manifest; **union-history gap resolution** (shallow primary
alone shows the gap; primary+baseline resolves it, with a genuine
shallow-clone fixture and an independent git re-derivation pinning the
112-unique-commit expectation — 57 + 89 − 34 overlap — and `1a9e270…`
presence); the webui 32-commit enumeration re-derived from the union;
full-length SHA enforcement; hbus RECIPE_UNPROVEN with report-hash integrity;
DIAG statuses (RECONSTRUCTED_SOURCE_EXACT + PUBLIC_SAFETY_PASS, with the
reconciliation-source block and retained near-miss/backup-original evidence);
reconciliation-source failure modes (missing/symlink/escape/size/hash all
fail closed, no absolute local path in the block); safety-review
record shape (no MAC values, no pending statuses, no reproducibility claims);
staleness flags and mismatch set; sanitizer rules (no host/user/identity/
local-path/MD5 leakage, no excluded config/resource/key paths — including
assertions that neither scanned repo's absolute path appears anywhere);
stale-value containment to explicit evidence contexts; the
no-reproduction-claim-from-binary-match invariant (exact claims must carry
an integrity-pinned pilot whose rebuilt SHA-256 equals the live digest);
**reconciliation-ref immunity** (extra commits/refs created in the baseline
repo leave all artifacts byte-identical and the count at 112, because only
the pinned base ref is scanned); pilot-report hash/verdict pinning; and
**publication hygiene** (every committed deliverable under `tools/reconciliation`,
`provenance/box-snapshot-20260818`, and `docs/reconciliation` is scanned for
personal home paths, personal names, the actual box IP, and `root@` to an
actual destination; the tool is asserted to have no hardcoded repo default;
collector tests are asserted to use RFC 5737 TEST-NET constants).
