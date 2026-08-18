# Staging Contract — box-snapshot-20260818

Status: **NON-CANONICAL** staging contract and deterministic staging builder
for the `box-snapshot-20260818` provenance snapshot. Offline, standard-library
only, no network, no box access. The machine-readable contract is
`provenance/box-snapshot-20260818/staging-contract.json`; this document is its
human-readable companion and must agree with it exactly.

## What this is

`tools/reconciliation/build_staging.py` (Python standard library only) stages
a **local root filesystem** from the sanitized public payload manifest, the
reproducibility status record, the current repository working-tree text
sources, and an explicit caller-supplied directory of fresh source-built
binaries. It writes **only** to the caller `--out-dir` and never reads the
tracked `payload/bin` tree.

The staging is **NON-CANONICAL** and **incomplete by design**: only two of the
eight live binaries (`codex_dhcpd`, `codex_portal`) have proven exact source
reproduction; the other six are omitted with exact blockers. A staging with
any blocker is incomplete and fails closed unless `--allow-partial` is given.

## Inputs (read-only, offline)

| Input | Path | Role |
| --- | --- | --- |
| Public live manifest | `provenance/box-snapshot-20260818/public-payload-manifest.json` | authoritative live paths, kinds, modes, sizes, SHA-256 digests, symlink targets (23 entries) |
| Reproducibility status | `provenance/box-snapshot-20260818/reproducibility-status.json` | per-entry `build_status` and `source_provenance` |
| Staging contract | `provenance/box-snapshot-20260818/staging-contract.json` | required closure, exact mappings, allowed exact-build binaries, expected blockers, no-fallback policy, output schema |
| Repo text sources | current working tree (repo-relative paths declared by the contract only) | exact bytes for the nine text/literal entries |
| Source-built binaries | explicit `--build-output-dir` (optional) | the **only** place binaries are ever read from |

## Required closure (22 entries)

Every live entry of `public-payload-manifest/1` **except** the excluded stale
live `/data/codex/bin/MANIFEST.txt` must be staged with exact bytes, size,
mode, and symlink target verified against the live manifest, or reported as a
blocker. The closure is partitioned into four exact mappings:

| Mapping | Count | Entries |
| --- | --- | --- |
| `text_sources` | 9 | `init.sh`, `offline_egress_guard.sh`, `recovery_ap.sh`, `rcS.local`, `netservicestarter.lua`, `codexactivity.lua`, `codexmqtt.lua`, `/usr/sbin/dropbear`, `/usr/sbin/dropbearkey` |
| `installer_literals` | 2 | `/pkg/codexactivity/manifest.json`, `/pkg/codexmqtt/manifest.json` |
| `symlinks` | 3 | `/cache/bin/bthid_keyboard`, `/data/codex/bin/dropbear`, `/data/codex/bin/dropbearkey` |
| `binaries` | 8 | the eight live binaries under `/data/codex/bin/` |

## Allowed exact-build binaries (7)

A live binary is staged **only** when its `build_status` is
`EXACT_SOURCE_REPRODUCIBLE` **and** a regular file named by the contract exists
in `--build-output-dir` matching the live SHA-256 and size. Currently:

- `/data/codex/bin/codex_bt_pair_agent` — `EXACT_SOURCE_REPRODUCIBLE`
- `/data/codex/bin/codex_bthid_keyboard` — `EXACT_SOURCE_REPRODUCIBLE`
- `/data/codex/bin/codex_dhcpd` — `EXACT_SOURCE_REPRODUCIBLE`
- `/data/codex/bin/codex_hal_ltcp` — `EXACT_SOURCE_REPRODUCIBLE`
- `/data/codex/bin/codex_hbus` — `EXACT_SOURCE_REPRODUCIBLE`
- `/data/codex/bin/codex_portal` — `EXACT_SOURCE_REPRODUCIBLE`
- `/data/codex/bin/codex_webui` — `EXACT_SOURCE_REPRODUCIBLE`

This set is recomputed from `reproducibility-status.json` at every run; a
disagreement with the contract's `allowed_exact_build_binaries.paths` is a
contract failure (exit 2), never a silent difference.

## Blockers (1, machine-readable in `blockers.json`)

| Live path | build_status | source_provenance | reason_code |
| --- | --- | --- | --- |
| `/data/codex/bin/dropbearmulti` | UNVERIFIED_THIRD_PARTY | THIRD_PARTY_BINARY | UNRESOLVED_BINARY_REPRODUCIBILITY |

Additional reason codes (used when a qualifying binary is expected but absent
or mismatched): `NO_SOURCE_BUILD_OUTPUT`, `BUILD_OUTPUT_MISMATCH`,
`SOURCE_TEXT_MISSING`, `SOURCE_TEXT_MISMATCH`.

A combined explicit build-output dir containing all seven exact binaries
stages **21/22** closure entries, blocking only dropbearmulti
(`canonical=false`, `complete=false`, no legacy MANIFEST).

## No-fallback policy (enforced, not assumed)

- The repository `payload/bin` tree is **never read** and **never a fallback**.
  A binary without a qualifying source-built artifact is omitted with a
  blocker, never sourced from tracked binaries.
- A `--build-output-dir` that is, or is inside, `payload/bin` (checked
  lexically and through symlinks) is rejected.
- `--build-output-dir` must exist and be a directory, must not overlap the
  out-dir in either direction, and its binary artifacts must be regular files
  (symlinks are refused).

## Stale live MANIFEST.txt

The live `/data/codex/bin/MANIFEST.txt` (749 B) is stale and incoherent (4
hash/size mismatches, 1 live binary missing from the listing). It is **never
staged**. The tracked stale `payload/bin/MANIFEST.txt` remains untouched by
both the derivation and the staging tool, and the staging tool never reads it.
A fresh legacy `MANIFEST.txt` (one `<md5sum>  <name>` line per
required binary, in declared order) is emitted **only** for a complete staging
— which requires every required binary to be source-reproducible and present as
a matching source-built artifact. It is never emitted for a partial staging,
and generation refuses bytes equal to the stale live digest.

## Outputs (written only to `--out-dir`)

| Output | When | Content |
| --- | --- | --- |
| `rootfs/` | complete, or partial under `--allow-partial` | staged local root filesystem (exact live modes, three exact symlinks), published by atomic rename |
| `staging-manifest.json` | always | what was staged, against which sources, every entry byte/size/mode/target-verified before publish |
| `blockers.json` | always | every omitted closure entry with an exact reason code and live build_status/source_provenance |
| `staging-attestation.json` | complete or partial | public-safe attestation (canonical=false, complete=false while any blocker remains, NON-CANONICAL notice) |

All JSON is canonical (sorted keys, 2-space indent, ASCII, LF-terminated) with
no wall-clock timestamps; determinism is inherited from the input digests. Two
runs over identical inputs produce byte-identical outputs.

## Out-dir safety

The out-dir must not be the filesystem root, the repository root, or inside
the repository `payload/`, `provenance/`, `docs/`, `tools/`, `.git/`, or
`.slim/` trees (checked lexically and through symlinks). Live paths are
materialized only after validation: absolute, normalized, no `..` segments,
and confined to the rootfs directory.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | complete staging published (rootfs plus all manifests) |
| 2 | usage, input, contract, or safety failure; nothing published |
| 3 | partial staging published under `--allow-partial` |
| 4 | incomplete staging without `--allow-partial`: fail closed, no rootfs published; diagnostic `staging-manifest.json` and `blockers.json` are written |

## Public safety

Generated artifacts contain **no private evidence paths, no host/user
identity, and no MD5 digests** (SHA-256 only). The legacy `MANIFEST.txt`
rootfs file (emitted only for a complete staging) carries MD5 digests by the
on-hub browser/update contract; no generated JSON manifest ever does.

## Invocation

```
python3 tools/reconciliation/build_staging.py \
    --out-dir /path/to/staging-output \
    [--build-output-dir /path/to/source-built-binaries] \
    [--allow-partial]
```

Optional environment overrides: `HARMONY_STAGING_LIVE_MANIFEST`,
`HARMONY_STAGING_REPRO_STATUS`, `HARMONY_STAGING_CONTRACT`,
`HARMONY_STAGING_REPO_ROOT`, `HARMONY_STAGING_BUILD_OUTPUT_DIR`.

## Validation

```
# offline tests (fixture + safety + hygiene; always run)
python3 -W error::ResourceWarning -m unittest \
    tools.reconciliation.test_build_staging -v

# real-evidence tests: supply BOTH distinct fixtures for zero skips.
# The first contains only the verified dhcpd/portal pair used by the partial
# fixture class; the second contains the combined seven exact build outputs.
HARMONY_SOURCE_BUILT_OUTPUT_DIR=/path/to/source-built/dhcpd-portal/verified \
HARMONY_COMBINED_BUILD_OUTPUT_DIR=/path/to/source-built/all-seven/verified \
    python3 -W error::ResourceWarning -m unittest \
    tools.reconciliation.test_build_staging -v

# byte-compilation
python3 -m py_compile tools/reconciliation/build_staging.py \
    tools/reconciliation/test_build_staging.py
```

Do not point both variables at the same directory: the partial fixture asserts
the dhcpd/portal-only blocker set, while the combined fixture asserts 21/22
staging with only dropbearmulti blocked.

The test suite covers: source-built binary hashes, exact text-source hashes,
installer literals, modes/symlinks, deterministic outputs, unresolved-binary
omission, the no-payload/bin-fallback rule, path-traversal/out-dir safety, the
no-stale/legacy-MANIFEST-on-partial rule, fail-closed semantics, no
subprocess/network, and publication hygiene. The real-evidence tests stage a
real partial rootfs and verify its files/hashes/modes/symlinks and blockers.

Validation owner: **security verifier + Oracle Gate 3**.
