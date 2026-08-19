# Box Snapshot — live product identities

> The JSON records in this directory are the immutable
> `box-snapshot-20260818` provenance derivation. They describe the **live
> hub** evidence snapshot. **Those live identities are product truth.**
> Embedded hashes, sizes, and claims are preserved exactly as derived.
>
> Current product build flow and the corrected integration ledger:
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

The live webui digest recorded here (`c400173b…`, 906872 bytes, md5
`6f05d649…`) **is** the product artifact identity. The later 778408-byte /
`7bcf00bd…` Recovery rebuild is not the product. See `docs/BUILD.md`.
