# webui-sim — Simulated Harmony Hub

Offline mock API + redesigned local UI for Harmony Hub Control development.
**SIMULATED HUB — no live device**: binds `127.0.0.1` only and never contacts
`192.168.0.123` or any real hub. Zero npm dependencies.

This does **not** deploy to the hub. Production still embeds assets into
`codex_webui`. Use the sim to iterate on UX safely.

## Run

From the repository root:

```sh
node tools/webui-sim/server.mjs
```

If `node` is missing from `PATH` (common on this machine):

```sh
/Users/matt/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node tools/webui-sim/server.mjs
```

Open http://127.0.0.1:8787/#control

- Default view is **Control** — real Harmony remote JPEG + activity/device modes
- **Home** — now playing + start tiles
- **Activities** — full offline editor (`vendor/activity-ui.js`)
- Fixture: `tools/webui-sim/fixtures/activity-config.json` (genuine Logitech shape)

Set `PORT=<n>` to change the port (default 8787).

## What it serves

- Fixture state is loaded from `tools/webui-sim/fixtures/activity-config.json`
  into memory at boot; edits via the API live in memory only.
- Activity API: `GET /api/activity-config`, `GET /api/activity-state`,
  `POST /api/activity-run` (form `activityId`, `-1` = PowerOff),
  `POST /api/activity-save` (JSON, `baseRevision` conflict → `409`),
  `POST /api/activity-sync`.
- Inventory/IR: `GET /api/inventory`, `GET /api/device-commands?deviceId=`,
  `POST /api/ir-send` (form or JSON).
- Virtual activity remote: `POST /api/control-button` with
  `{ activityId, buttonKey, pressType? }` (`press`|`long`|`double`) resolves
  the button through the in-memory `ActivityButtonMap`s. Hard buttons match by
  `ButtonKey`; soft buttons (no `ButtonKey`) match by `TextOnRemote` or
  `MenuItem.IndexInMenu`.
- Stubs: `GET/POST /api/bt-call`, `GET /api/bt-text-status`,
  `GET/POST /api/capture`, `GET /api/update-status`.
- Exports: `/export/activities`, `/export/maps`, `/export/functions`,
  `/export/devices`, `/export/bundle`, `/export/automation`, `/export/mqtt`,
  `/export/wifi`, `/export/cloud` — served from the in-memory resources as
  attachment JSON.

## Debug helpers

- `GET /api/sim/events` — last 50 control events (activity runs, IR sends,
  virtual button presses).
- `POST /api/sim/reset` — reloads the fixture from disk, resets the current
  activity to `-1` (PowerOff), and clears the event log.

## Production packaging (flash-safe embed)

This sim UI is the single source of truth for the production shell embedded in
`payload/source/codex_webui.c`. Packaging is deterministic (no timestamps):

```sh
sh tools/package_harmony_shell.sh        # bundle JS (bun IIFE), CSS, transform
                                         # HTML -> payload/source/harmony_shell_assets.h
sh tools/embed_activity_ui.sh            # also regenerates the shell embed
node tools/harmony_shell_smoke.mjs       # packaging + contract assertions
```

What it produces (DEDUP_MIN footprint class, ~0.81 MB `codex_webui`):

- **one** minified shell JS (`/assets/harmony-shell.js`, classic + `defer`)
- **one** minified shell CSS (`/assets/harmony-shell.css`, with
  `activity-overrides.css` baked in)
- production HTML that defines `globalThis.REMOTE_SKIN_SRC` from the hub's
  **existing** `REMOTE_SKIN_JPG_B64` seam-injection — the JPEG is never
  embedded or served a second time.
- The advanced editor lazy-loads the **existing** `/assets/activity-ui.*`
  vendor routes — it is never copied into the shell bundle.
- No Google Fonts (system fallbacks), no `/sim/` requests, no external URLs.

`tools/hub-emu/run.sh` runs `embed_activity_ui.sh` before every MIPS compile
so generation always precedes compilation. The sim/dev-proxy map
`/assets/activity-ui.*` onto `public/vendor/*` (byte-identical to
`payload/web/*`).
