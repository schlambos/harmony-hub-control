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

### If Logitech's page shows "Launch Application" and clicking does nothing

That page (`id.logi.com/launch.html`) hands the
`com.logitech.harmony://lidsoauth?...` callback to the Harmony desktop
app. Without that app installed, Chrome and Edge have nothing to open:
the button looks dead and the callback never appears in the address
bar. The sign-in itself worked — only the hand-off has nowhere to go.

Get the callback from the browser console instead:

1. Stay on the "Launch Application" page and open the developer tools
   (F12), then the **Console** tab.
2. Click **Launch Application** once more.
3. Copy the whole red message, `Failed to launch
   'com.logitech.harmony://lidsoauth?code=...&state=...' because the
   scheme does not have a registered handler.`
4. Paste that whole message into the helper's bridge page or terminal.
   The helper takes the callback out of it (and checks it belongs to
   this sign-in attempt, like any other paste).

Or skip the browser dance: the Melodious desktop app and the Android
app sign in inside the app and catch the callback themselves
(**Import codes → Logitech catalog → Sign in**).

One more format note: the import opens only the packages this helper
(or the apps) write — a `harmony-catalog-*.json` with
`schema_version: "0.2.0"`. A raw JSON dump saved from MyHarmony or the
Harmony app is a different shape and is refused as the wrong format;
run the helper for that maker and model instead.

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
