# Melodious for Android: Logitech catalog lookup

This brings the macOS app's catalog feature (`docs/DESKTOP_APP.md`) to the
Android app, one to one:

- **Sign in** to the user's own Logitech account, in Chrome, from the app.
- **Devices → a device → Import codes → Logitech catalog:** Sign in, Brand
  and Model fields with the model check, Search, a results list, Download,
  the preview (what this hub can take, plus every skipped command and why),
  Import to that device, and "Open a catalog package…" for the
  `harmony-catalog-*.json` files made by `tools/catalog/harmony_catalog.py`.
- **Settings:** a Logitech account row (signed in or not; Sign in, Sign
  out), and the OAuth client_id override.

Limits:
- The hub doesn't change: no new routes, no C, no web UI change, no
  `codex_webui` rebuild. The app uses `/export/protocols` and
  `/api/catalog-import`, which the hub already serves.
- Logitech tokens stay in the app, encrypted with the Android Keystore.
  The hub only receives the same `/api/catalog-import` rows the web UI and
  the macOS app send.
- Nothing is created or changed in the Logitech account.
- No WebView. Google blocks its sign-in in embedded WebViews
  (`disallowed_useragent`), and spoofing the user agent is not an option.
- No system URL handler. The app declares **no intent filter** for
  Logitech's `com.logitech.harmony` scheme. Chrome's Auth Tab hands the
  redirect back to the app that opened it. The existing `melodious://hub`
  deep link stays as it is.
- Out of scope, as on the Mac: IRDB ("Find codes"), RemoteCentral, Type a
  code and Flipper files. Android's Paste path is unchanged.

## Architecture

```
┌─────────────────────────── Melodious (app.melodious) ───────────────────────────┐
│ app module (Android)                                                            │
│  ├─ MainActivity        registers the Auth Tab result launcher (onCreate)       │
│  ├─ AuthTabSignIn       picks a browser with Auth Tab support, launches,        │
│  │                      hands the result URI back; no intent filter             │
│  ├─ LogitechTokenStore  AES-GCM key in the Android Keystore; ciphertext in      │
│  │                      its own private prefs file; nothing stored on failure   │
│  ├─ HubPrefs            + client_id override (not secret)                       │
│  ├─ MelodiousViewModel  catalog account + tab state, handlers                   │
│  └─ UI                  Import sheet tabs (Logitech catalog | Paste),           │
│                         Settings row, client_id field, file picker (SAF)        │
│ core-protocol (pure Kotlin/JVM, unit-tested on the Mac)                         │
│  ├─ catalog/            OAuth + PKCE, strict callback, Harmony signin,          │
│  │                      discovery, model check, search, download, package,      │
│  │                      catalogRows; one request at a time                      │
│  └─ rest/               + getHubProtocolNames, importCatalogCommands            │
└─────────────────────────────────────────────────────────────────────────────────┘
        │ LAN, plain HTTP (unchanged)                  │ HTTPS
        ▼                                              ▼
   codex_webui :8080 on the hub         accounts.logi.com, *.myharmony.com
                                        (and Chrome, for the sign-in page only)
```

### Module split

Everything that isn't Android goes in `core-protocol`, which is already a
pure JVM library with JUnit tests. The app module keeps only what needs
the Android framework.

| `core-protocol` (`app.melodious.protocol.catalog`) | `app` (`app.melodious`) |
| --- | --- |
| `CatalogOAuth`: PKCE, authorize URL, `parseCallback`, exchange and refresh forms, `parseTokens` | `system/AuthTabSignIn`: browser choice, launch, result hand-back |
| `CatalogHttp`: OkHttp transport with the endpoint allowlist, no redirects, a scoped cookie jar | `system/LogitechTokenStore`: Keystore encryption behind `TokenStore` |
| `CatalogClient`: Harmony signin, discovery and host swap, `checkModel`, search, `GetGlobalDevices`, `GetGlobalLanguageCommands` | `MelodiousViewModel`: catalog state and handlers |
| `CatalogService`: `ensureSession`, one refresh-and-retry, serialized calls, `status`/`signIn`/`signOut`/`checkModel`/`search`/`download` | `ui/devices/CatalogImportTab.kt`, the Import sheet tabs, the Settings row and the client_id field |
| `CatalogPackage`: 0.2.0 package, `redact`, `isCatalogPackage` | |
| `CatalogImport`: `catalogRows`, `hubProtocolNames`, `describeCatalogRows` | |
| Interfaces: `TokenStore`, `SignInLauncher` (implemented in `app`, faked in tests) | |

### Sign-in with Chrome's Auth Tab

1. The user taps **Sign in** (on the catalog tab or in Settings).
2. `CatalogService.signIn()` runs `ensureSession`: saved tokens first, then
   one silent refresh, and only then the browser.
3. For the browser, `AuthTabSignIn` picks the package:
   - Chrome (`com.android.chrome`), if `isAuthTabSupported` says yes. It's
     the one browser that has been run.
   - Otherwise the default Custom Tabs browser, if it supports Auth Tab
     (not verified).
   - Otherwise nothing is launched, and the app says sign-in needs Chrome. "Open a catalog package…" still works.

   A plain Custom Tab is never used as a fallback. Without an intent
   filter, its redirect would go nowhere, or to Logitech's own app if that
   is installed.
4. `AuthTabIntent.launch(launcher, authorizeUrl, "com.logitech.harmony")`,
   with the chosen package set on the intent. The launcher is registered
   in `MainActivity.onCreate`. A small app-scoped holder passes it, and the
   pending result, between the activity and the ViewModel.
5. The result:
   - `RESULT_OK`: `resultUri` goes through the strict `parseCallback`
     (below), then the code exchange, the encrypted save and Harmony
     signin.
   - `RESULT_CANCELED` (the user backed out): signed out quietly, with no
     error and no retry loop, as on the Mac.
   - `RESULT_VERIFICATION_FAILED` and `RESULT_VERIFICATION_TIMED_OUT` (these
     only apply to `https` redirects): an error message, signed out.
6. The PKCE verifier and state live only in memory, for one attempt. If
   Android ends the app's process while Chrome is open, the result that
   comes back has no matching attempt. It's refused with "Sign-in was
   interrupted; sign in again". Nothing is written to disk before the
   exchange succeeds.

The callback check is the Mac's strict one:
- scheme `com.logitech.harmony`;
- host `lidsoauth`;
- no path, fragment or user info;
- exactly one `code` and one `state`, and the state must match this
  attempt;
- `error=` means "Logitech refused the sign-in; sign in again";
- bare strings and logi.com pages are refused.

### Catalog client (`core-protocol`)

A Kotlin port of `desktop/src/catalog/{oauth,client}.js`, which ports
`tools/catalog/harmony_catalog.py`. Same endpoints, bodies and wording:

| Step | Call |
| --- | --- |
| PKCE | 48 random bytes (`SecureRandom`) → base64url verifier; S256 challenge; 24-byte state |
| Authorize | `accounts.logi.com/identity/oauth2/authorize`, `response_type=code`, `scope=openid`, `redirect_uri=com.logitech.harmony://lidsoauth`, the client_id |
| Code exchange, refresh | `POST accounts.logi.com/identity/oauth2/token`, form-encoded. A refresh answer without a new refresh or id token keeps the old one. |
| Harmony session | `POST lb-svcs…/CompositeSecurityServices/Security.svc/json2/signin` with `{access_token, id_token}` and the bearer → `AccountId` (kept in memory only; a locked account is refused) |
| Operation table | `POST cf-svcs…/Discovery/Discovery.svc/json/GetJsonOperations` `{"clientTypeId":"Redbull 1.0"}`, header `x-logitech-api-version: 1`; cached for the session; `svcs`/`cf-svcs` addresses moved to `lb-svcs`, `json` → `json2` where the Mac does it; `GetGlobalLanguageCommands` falls back to the `GetCommands` sibling's address |
| Model check (anonymous) | `GET svcs.myharmony.com/HarmonyPlatform/DeviceManager.svc/json2/SearchDevice/manf/<m>/model/<n>/iface/IR` → found or not, and the canonical spelling. No bearer, no cookies. |
| Search | `SearchGlobalDevices` (json2) `{manufacturer, modelNumber, deviceType:0, searchType:2, maxResults:50}`. Each match becomes `{id (Id-), manufacturer, model (DeviceModel or Model), displayText (DisplayText or SelectedText), deviceType (the Mac's label table), description}`. |
| Download | `GetGlobalDevices([id])` (exactly one device, with that id), then `GetGlobalLanguageCommands({globalLanguageVersionId:{Value: DefaultGlobalLanguageVersionId}})` |
| Package | `schema_version` `0.2.0`, `source` `logitech-catalog-via-melodious-android`, `query`, and `resources` (`search_result`, `selected_match`, `global_device`, `global_language_commands`), each passed through the helper's `redact` rule (keys matching authorization, cookie, password, secret, access/refresh/id/auth token or account id) |

Transport, as on the Mac:
- Its own `OkHttpClient`, separate from the hub client, with a 30 s call
  timeout.
- HTTPS only. Redirects are not followed (`followRedirects(false)`,
  `followSslRedirects(false)`); a 3xx is an error.
- An allowlist of exactly the Mac's endpoints: the token URL, discovery,
  Harmony signin, `SearchDevice/manf/…` (GET only), and the three
  `lb-svcs…/DeviceManager.svc/` operations. Anything else is refused
  before it's sent.
- `Accept: application/json` and the Mac's `User-Agent`
  (`melodious-catalog/1.0`).
- An in-memory cookie jar with the Mac's rules: only `myharmony.com`
  cookies, never sent on a GET (so the model check stays anonymous),
  never written to disk, and cleared on sign-out.
- JSON and form bodies are sent with a fixed `Content-Length`.
- Coroutine cancellation cancels the OkHttp call.

Session handling follows the Mac's `createCatalogService`:
- All catalog calls run one at a time (a `Mutex`), and sign-in is
  single-flight.
- A refused catalog call (HTTP 400 "Access is denied") gets one refresh
  and one retry, never a loop. If that fails, the tokens are deleted and
  the message is "Logitech refused the catalog session; sign in again".
- The service checks its inputs: trimmed strings of 1–64 characters, and a
  positive integer id.
- Errors are plain messages the tab can show, for example "Sign in to
  Logitech first" or "No catalog device matches Sony STR-DG7".

Etiquette, unchanged from the Mac and the helper:
- Read-only. One request at a time, one device per download.
- Search and Download run only when the user taps.
- The model check runs only after a 600 ms pause in typing, at most one
  request in flight, and never for the values pre-filled when the tab
  opens.
- Nothing runs in the background or on a timer. Opening the sheet or the
  tab makes no network request.

### Token storage (Android Keystore)

- `LogitechTokenStore` implements `TokenStore { load(); save(tokens);
  clear() }`.
- Key: AES-256-GCM, generated in `AndroidKeyStore` under one alias,
  encrypt/decrypt only, random IV per write, no user authentication
  (so a refresh doesn't need the lock screen). The key can't leave the
  device.
- Stored: `{access_token, id_token, refresh_token}` as JSON, encrypted, in
  its own private SharedPreferences file (`melodious_logitech`), as IV +
  ciphertext in base64. Nothing else: never the AccountId, cookies or
  codes. The hub settings file (`melodious_prefs`) doesn't change.
- **If the Keystore fails**, on key creation or on encrypt, nothing is
  stored and any old blob is deleted. The tokens last only while the app
  runs, as on the Mac when `safeStorage` is unavailable.
- **If a blob can't be decrypted** (for example after a device transfer,
  where the key doesn't follow), it is deleted and the user is signed out.
- Sign out deletes the blob and the in-memory tokens, and clears the
  cookies and the operation cache.
- `android:allowBackup="false"` is already set. A device-to-device
  transfer could copy the blob, but not the Keystore key, so it's
  useless there and gets deleted on first read.
- No new dependency. `androidx.security:security-crypto`
  (`EncryptedSharedPreferences`) is deprecated, so it isn't used.
- Tokens never reach logs, the hub, packages or the UI. The app has no
  HTTP logging interceptor and adds none.

The hub's Basic auth header is still stored in plain `HubPrefs`, as it
is today.

### Talking to the hub

Two calls are added to `CodexHubRestClient`. Both use the saved endpoint
and Basic header, as every hub call does:
- `getHubProtocolNames(endpoint)`: `GET /export/protocols` →
  `Protocols[].Name`, as `hubProtocolNames` does in the web UI. If it
  can't be read, the preview says so ("…the hub's protocol list couldn't
  be read, so no KeyCode can be checked yet") and imports nothing.
- `importCatalogCommands(endpoint, deviceId, rows)`: `POST
  /api/catalog-import` with JSON `{deviceId, commands:[{name, keycode, raw,
  protocol}]}`, the same body the web sends. It goes through the existing
  `postJson`, whose OkHttp body has a fixed `Content-Length`; `codex_webui`
  can't read chunked bodies.
  - The hub answers `{ok, message}`: it backs up DeviceList, stores each
    KeyCode with the protocol its `G:<name>:` prefix names, skips names the
    device already has, and refuses protocols it lacks.
  - A 404 shows "Your hub's Melodious software is older than this app;
    update the hub". Any other error shows the hub's message.
  - Afterwards the app reloads the config, closes the sheet and shows
    "Imported to <device>. <hub message>".

## Screens

### Import codes sheet

Today `ImportSheet` (in `DevicesScreen.kt`) is Paste only. It gets the web
sheet's tab row, with only the tabs Android has, in the web's order:
**Logitech catalog | Paste**. The sheet opens on the first tab, as the web
does.

- **Paste:** today's content, unchanged (the text, the field and Import
  through `importIrPayload`). It's moved into its own composable; no
  behaviour change.
- **Logitech catalog,** top to bottom, as on the Mac:
  1. The intro: "Use the code set from Logitech's own catalog for
     <maker> <model>. Only commands whose IR protocol this hub already has
     are imported; the rest are listed below, not dropped silently."
  2. Account row: "Signed in to Logitech" with Sign out, or "Logitech
     account" with Sign in.
  3. Brand and Model fields (64 characters at most), pre-filled from the
     device's manufacturer and model. Under Model, the check result:
     "Logitech knows this as STR-DG720" or "Not found under that name".
  4. **Search Logitech catalog**, then the results: display text, then
     device type and description, with a Download button on each row.
  5. The preview, as the web builds it:
     - the summary line from `describeCatalogRows` (importable count,
       protocols, skipped count, protocols missing on the hub);
     - the first 24 importable commands with their protocol;
     - **every** skipped command with its reason, for example
       "protocol “RC6 Mode 0” is not on this hub".
  6. **Import N commands to <device>**.
  7. **Open a catalog package…** always at the bottom, signed in or not,
     and with or without Chrome.
  8. The hint under it: "Or open a harmony-catalog-*.json file from
     tools/catalog/harmony_catalog.py. Your Logitech sign-in stays on this
     phone; the hub never sees it."

The model check is in the composable: a `LaunchedEffect` keyed on the two
fields. It does nothing while they equal the pre-filled values or either is
blank. Otherwise it waits 600 ms, then asks the ViewModel. A newer edit
cancels the wait. The ViewModel runs at most one check at a time and drops
a result if the fields have changed since. Closing the sheet cancels it all.

"Open a catalog package…" uses the Storage Access Framework
(`ActivityResultContracts.OpenDocument`, JSON and text types), so it needs
no storage permission. It reads at most 4 MB (the Sony package is about
30 KB), parses it, checks `isCatalogPackage`, and shows the same preview.
Errors use the web's wording: "<file> is not a catalog package (not
JSON)" and "<file> is not a Logitech catalog package from
tools/catalog/harmony_catalog.py."

The tab's state (matches, preview, status line) lives in the ViewModel, so
it survives the sheet being redrawn. It's cleared when the sheet closes.
The account state is shared with Settings.

### Settings

The Mac's Settings page, section by section, and where it is on Android:

| Mac Settings | Android |
| --- | --- |
| Current hub | Settings tab → **Hub** row (exists) |
| Hubs on this network | Settings → Hub page (exists; SSDP plus the existing /24 probe) |
| Enter address | Settings → Hub page (exists) |
| Hub sign-in | Settings → Hub page, "My hub needs a sign-in" (exists) |
| Logitech account | **New:** a "Logitech account" row on the Settings tab, under Hub: "Signed in to Logitech" (Sign out) or "Not signed in · used only to search and download device codes from Logitech's catalog" (Sign in) |
| Advanced: OAuth client_id | A "Logitech catalog" section at the bottom of Settings → Advanced, with a field and Save. "Leave empty to use Logitech's public desktop client_id (9d88df5e-…)." |

The client_id override:
- It's stored in `HubPrefs` (it isn't a secret). Empty means the built-in
  value.
- It's checked like the Mac's: trimmed, 128 characters at most, no spaces
  or control characters.
- Changing it doesn't sign the user out. It applies to the next sign-in or
  refresh.

## Code ported or reused

| What | From |
| --- | --- |
| OAuth, PKCE, callback check, exchange, refresh | `desktop/src/catalog/oauth.js` |
| Harmony signin, discovery, host swap, model check, search, download, package, `redact`, session and retry, serialization | `desktop/src/catalog/client.js` (which follows `tools/catalog/harmony_catalog.py`) |
| `catalogRows`, `isCatalogPackage`, `hubProtocolNames`, `describeCatalogRows` and the skip reasons | `tools/webui-sim/public/js/logitech-catalog.js` |
| Tab layout, wording, model-check rules, error handling, the 404 message | `tools/webui-sim/public/js/views/device-import.js` (`previewCatalogPackage`, `doCatalogSignIn`, `doCatalogSignOut`, `doCatalogSearch`, `doCatalogDownload`, `checkCatalogModel`, `renderCatalogAccount`, `renderCatalogResults`, `renderCatalogPreview`, `doCatalogImport`) |
| Settings wording | `desktop/src/connect/connect.js` (Logitech account, Advanced) |
| Test data | `desktop/test/fixtures/catalog-fixtures.json` (public catalog fields only, no credentials), read in place by the Kotlin tests so both ports test the same data |
| Hub calls | `CodexHubRestClient.postJson` and `getRawText`; `importIrPayload` as the model for busy state and messages |

The Kotlin names follow the JS ones (`catalogSignIn`, `catalogSearch`,
`catalogDownload`, `checkCatalogModel`, `catalogImport`), so the two ports
can be read side by side.

## Security model

**Sign-in:**
- Logitech's page runs in Chrome's Auth Tab, not in the app. The app never
  sees the password or the Google session. Chrome's cookies stay in
  Chrome.
- The app accepts a result only from its own launcher, for its own pending
  attempt, through the strict `parseCallback`. Nothing else in the app can
  deliver a code: there is no intent filter and no exported component.
- PKCE protects the code: a code that went elsewhere can't be exchanged
  without the verifier, which never leaves the app's memory.

**Secrets:**
- Logitech tokens are encrypted with a Keystore key, or not stored at all
  (see "Token storage").
- The AccountId and cookies are kept in memory only.
- Nothing personal is built in: no account, email, hub address, hub ID or
  token. The only fixed value is Logitech's public desktop client_id
  `9d88df5e-7edf-4288-8634-26721cbe7add`, which the client_id setting
  overrides.

**What reaches the hub:** what the app sends today, plus `GET
/export/protocols` and the `/api/catalog-import` body (`deviceId` and the
command rows). Never a Logitech token.

**What reaches Logitech:** the sign-in (in Chrome), the token calls,
Harmony signin, discovery, the anonymous model check, search, and the one
device downloaded. Nothing about the hub: no hub ID, address, device list
or codes.

**No background traffic:** no telemetry. The only network calls are the ones
listed above, each started by a tap or, for the model check, by typing, plus
the update check if you turn it on: once a day (when the app opens), one
request to `api.github.com` for Melodious's releases, which shows GitHub your
IP address and the app's version. Tapping Install downloads the APK and its
checksum list from that GitHub release.
