# Historical Reconciliation — NOT current-main truth

> **HISTORICAL / NOT CURRENT MAIN.** Everything under `docs/reconciliation/**`
> is a point-in-time reconciliation of the historical `box-snapshot-20260818`
> evidence snapshot and the `activity-webgui` overlay materialization. These
> records describe a **prior live hub** and a **source-only overlay worktree**;
> they are **not** the current product baseline and must not be read as final
> product truth.
>
> The current product build flow, artifact identities, and integration ledger
> are in:
>
> - [docs/BUILD.md](../BUILD.md) — final product build flow
> - [docs/integration/main-product-20260819.md](../integration/main-product-20260819.md) — integration ledger
> - `provenance/integration/main-product-20260819/` — machine-readable integration records

## Contents

| Path | What it is |
| --- | --- |
| `box-snapshot-20260818.md` | Provenance derivation ledger for the historical 23-entry evidence snapshot |
| `staging-contract.md` | Human-readable companion to the historical staging contract |
| `activity-webgui-overlay/` | Materialization report, tier map, protected paths, and tool status for the source-only overlay |

The historical JSON records under `provenance/box-snapshot-20260818/**` are
immutable historical artifacts; their embedded hashes and claims are **not**
falsified or rewritten by the current product integration.
