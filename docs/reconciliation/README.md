# Reconciliation ledgers — live box identities

> Everything under `docs/reconciliation/**` is a point-in-time reconciliation
> of the `box-snapshot-20260818` evidence snapshot and the `activity-webgui`
> overlay materialization. **The live box binary identities recorded here are
> product truth** (webui 906872 / `c400173b…`). The later 778408-byte Recovery
> rebuild is not the product.
>
> Current product build flow and the corrected integration ledger:
>
> - [docs/BUILD.md](../BUILD.md) — live-box product build flow
> - [docs/integration/main-product-20260819.md](../integration/main-product-20260819.md) — integration ledger
> - `provenance/integration/main-product-20260819/` — machine-readable integration records

## Contents

| Path | What it is |
| --- | --- |
| `box-snapshot-20260818.md` | Provenance derivation ledger for the historical 23-entry evidence snapshot |
| `staging-contract.md` | Human-readable companion to the historical staging contract |
| `activity-webgui-overlay/` | Materialization report, tier map, protected paths, and tool status for the source-only overlay |

The JSON records under `provenance/box-snapshot-20260818/**` are immutable
snapshot artifacts; their embedded live hashes and claims are product
identities and are **not** rewritten.
