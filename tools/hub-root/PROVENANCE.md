# Provenance

`tools/hub-root/` is the Harmony Hub root tool, bundled into Melodious.

- **Upstream:** Ripthulhu/harmony-hub-root, by **Ripthulhu** and its
  contributors. The original root mechanism (persistent key-only root SSH
  over LAN/USB, USB diagnostics, Wi-Fi provisioning, factory reset, and
  firmware upload) is that project's work. It is upstream code under the
  all-rights-reserved terms in this repository's `LICENSE`, section 1.
- **Bundled:** 2026-11-11, at the Melodious maintainer's direction, from
  the state of that tool including the Melodious commits below, so the
  fresh-hub activation chain ships and versions with Melodious instead
  of depending on a separate checkout.
- **Melodious additions in this directory** (MIT, `LICENSE` section 2,
  by Matthew Gibbons):
  - `bf04290` — POST and USB hbus transports for unprovisioned hubs
    (corrected USB secondary-packet framing included).
  - `bb5df37` — opening the TDE gate on unprovisioned hubs (gate
    pre-check, JSON file-transfer staging fallback).
  - Their tests in `tests/test_hbus_transports.py` (44 tests).

The fresh-hub chain that uses this tool is documented in
`docs/FRESH_HUB_ACTIVATION.md`.
