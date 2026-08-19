# Historical Box Snapshot — NOT current-main truth

> **HISTORICAL / NOT CURRENT MAIN.** The JSON records in this directory are
> immutable historical artifacts of the `box-snapshot-20260818` provenance
> derivation. They describe a **prior live hub** evidence snapshot and are
> **not** the current product baseline. Their embedded hashes, sizes, and
> claims are preserved exactly as derived and are **not** falsified or
> rewritten by the current product integration.
>
> Current product truth lives in:
>
> - [docs/BUILD.md](../../docs/BUILD.md)
> - [docs/integration/main-product-20260819.md](../../docs/integration/main-product-20260819.md)
> - `provenance/integration/main-product-20260819/`

## Files

| File | Description |
| --- | --- |
| `artifact-map.json` | 23-entry historical ledger (live path/kind/mode/size/SHA-256/MD5/target, git blob SHAs, commit lists, statuses) |
| `reproducibility-status.json` | per-entry and summary statuses, blockers, scanned history |
| `public-payload-manifest.json` | sanitized NON-CANONICAL public manifest (approved live paths/kinds/modes/sizes/SHA-256/targets only) |
| `public-safety-review.json` | sanitized durable record of the completed public-safety review |
| `staging-contract.json` | machine-readable historical staging contract |

The historical webui digest recorded here (`c400173b…`, 906872 bytes) and the
stale live MANIFEST md5s (`39793b19…` / `6f05d649…`) are **historical** values
and are **not** the final product artifact identity. The final product webui is
`7bcf00bdcc98ded1795851ea72864f434e4e15d376a95dc7bedc70d34902b2a2` (778408
bytes); see `docs/BUILD.md`.
