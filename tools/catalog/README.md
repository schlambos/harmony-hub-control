# Logitech catalog helper

Downloads one device's command set from Logitech's own catalog, on your
computer, for import into Melodious. Use it only for devices you own.

```sh
python3 tools/catalog/harmony_catalog.py Sony STR-DG720
# writes harmony-catalog-sony-str-dg720.json
```

Then, in the web UI: open the device → **Import codes → Logitech catalog** →
open the package. The package also bundles the IR protocol definitions
its commands need (from your account's ProtocolList), so a set imports
even on a hub that does not have its protocol yet — including a blank
hub, which also has several common protocols built in. Anything still
skipped is listed in the sheet with its reason, not dropped silently.

## Signing in (no APK, no password in the terminal)

The first run opens Logitech's own login page in your browser — the same
OAuth flow the Harmony desktop app uses (authorization code + PKCE):

1. Sign in on Logitech's page. Your password is typed only there; this
   program never sees it, and there is no APK or client secret involved.
   The sign-in uses the public client identifier of Logitech's Harmony
   desktop app, read out of Logitech's publicly served desktop web bundle.
   If Logitech ever rotates it, set `MELODIOUS_CLIENT_ID` to the new one.
2. The browser then tries to open the Harmony app and lands on an address
   starting with `com.logitech.harmony://lidsoauth?code=...`. Copy that
   whole address from the address bar.
3. Paste it into the helper's bridge page (it opens
   `http://127.0.0.1:8765/` for you; 127.0.0.1 only) or into the terminal.

Tokens are kept at `~/.melodious/harmony_token.json` (mode `0600`), so
later runs refresh silently and usually skip the browser entirely.

`--list` shows the catalog matches for a maker/model without downloading.

## How it behaves

- Read-only, one device at a time, at the pace of the official app. Nothing
  is created, changed or deleted in your Logitech account.
- Credentials never leave your computer. The hub stays offline and never
  sees the sign-in; only the finished package (which carries no tokens)
  reaches it, through your browser.
- This uses Logitech's service with your own account. Logitech's terms
  govern your account; if they ever close this path, IRDB search and
  learning still work. Last verified against the live service 2026-10-22.
