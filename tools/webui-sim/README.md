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

If `node` is missing from `PATH`, point `NODE` at your runtime:

```sh
NODE=/path/to/node tools/webui-sim/server.mjs
```

Open http://127.0.0.1:8787/#remote

The UI is **Melodious**, the same interface as the Android app (see
`DESIGN.md` and `docs/MELODIOUS_WEB_UI.md`). Four tabs:

- **Remote** (`#remote`): "Everything's off" when nothing runs, otherwise
  the activity's keypad, keyboard tab, More keys and Fix it. `#remote/<id>`
  tries an activity's keys without starting it.
- **Activities** (`#activities`): the list, the setup wizard (`#wizard`) and
  the full offline editor (`#editor`, `vendor/activity-ui.js`).
- **Devices** (`#devices`): add a device, each device's own remote and
  commands (`#devices/<id>`: Learn a button, Import codes, edit or delete a
  command, Edit details and Delete device in ⋮), its settings
  (`#devices/<id>/settings`), Send all commands (`#devices/<id>/sweep`) and
  the IR lab (`#devices/lab`).
- **Settings** (`#settings`): Bluetooth, MQTT, Wi-Fi, Backup, System, and
  the simulator's recent events.

The old `#control` and `#home` hashes open the Remote tab, and `#ir` opens
Devices.

Fixture: `tools/webui-sim/fixtures/activity-config.json` (genuine Logitech
shape).

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
- IR setup, with the hub's own checks and messages: the `/ir/*` forms
  (`new-device`, `device`, `delete-device`, `command`, `update-command`,
  `delete-command`) answer like the hub's legacy page (HTTP 200 and the
  result in `<div class='msg'>`, refusals included; delete-device answers
  `409` while activities or maps still name the device), and the JSON routes
  `/api/irdb-import`, `/api/ir-test-learned`, `/api/ir-batch-send` (dry or
  "live", with `/api/ir-cancel`), `/api/ir-lab-target` and `/api/ir-lab-clear`.
  Nothing is transmitted; `/api/remotecentral-fetch` answers like a hub
  without internet access.
- Virtual activity remote: `POST /api/control-button` with
  `{ activityId, buttonKey, pressType? }` (`press`|`long`|`double`) resolves
  the button through the in-memory `ActivityButtonMap`s. Hard buttons match by
  `ButtonKey`; soft buttons (no `ButtonKey`) match by `TextOnRemote` or
  `MenuItem.IndexInMenu`.
- Stubs: `GET/POST /api/bt-call`, `GET /api/bt-text-status`,
  `GET/POST /api/capture` (hears nothing; see below), `GET /api/update-status`.
- Exports: `/export/activities`, `/export/maps`, `/export/functions`,
  `/export/devices`, `/export/bundle`, `/export/automation`, `/export/mqtt`,
  `/export/wifi`, `/export/cloud` — served from the in-memory resources as
  attachment JSON.

## Debug helpers

- `GET /api/sim/events` — last 50 control events (activity runs, IR sends,
  virtual button presses).
- `POST /api/sim/reset` — reloads the fixture from disk, resets the current
  activity to `-1` (PowerOff), and clears the event log.
- `POST /api/sim/capture-next` — the next `/api/capture` hears one sample
  NEC frame, so Learn a button can reach its "Got it" step.
- `POST /api/sim/send-failure` — JSON `{"deviceId", "engineCode", "msg"}`
  makes that device's sends fail as the hub's do (`403` with
  "Reauthentication Required" is a TV that needs pairing again);
  `{"deviceId", "btFailed": true}` fails the Bluetooth connect before the send;
  `{"activityId", "engineCode", "msg", "dataDeviceId"}` fails that activity's
  starts. Add `"clear": true` to undo one, or send only it to undo all.
  `/api/sim/reset` clears them too.
- `POST /api/sim/pairing` — `{"deviceId", "cookie": true}` makes
  `GET /api/pairing` report that IP device (a Sony TV) as registered with the
  hub; `"cookie": false` undoes it; `{"clear": true}` drops every registration
  and failure marker.

## Production packaging (flash-safe embed)

This sim UI is the single source of truth for the production shell embedded in
`payload/source/codex_webui.c`. Packaging is deterministic (no timestamps):

```sh
sh tools/package_harmony_shell.sh        # bundle JS (bun IIFE), CSS, transform
                                         # HTML -> payload/source/harmony_shell_assets.h
sh tools/embed_activity_ui.sh            # also regenerates the shell embed
node tools/harmony_shell_smoke.mjs       # packaging + contract assertions
```

What it produces (DEDUP_MIN footprint class, ~0.90 MiB / 942,552 bytes `codex_webui`):

- **one** minified shell JS (`/assets/harmony-shell.js`, classic + `defer`)
- **one** minified shell CSS (`/assets/harmony-shell.css`, with
  `activity-overrides.css` baked in)
- production HTML, embedded whole as `harmony_index`. The shell draws its
  own keypad and carries no remote photo; only the legacy page still embeds
  `REMOTE_SKIN_JPG_B64`.
- The advanced editor lazy-loads the **existing** `/assets/activity-ui.*`
  vendor routes — it is never copied into the shell bundle.
- No Google Fonts (system fallbacks), no `/sim/` requests, no automatically
  loaded external assets. Browser-side data fetches in the redesigned shell
  are limited to IRDB Search and Preview after an explicit click. Clicked
  documentation links and legacy owner-triggered import/update surfaces can
  also navigate to or contact their named sources.

`tools/hub-emu/run.sh` runs `embed_activity_ui.sh` before every MIPS compile
so generation always precedes compilation. The sim/dev-proxy map
`/assets/activity-ui.*` onto `public/vendor/*` (byte-identical to
`payload/web/*`).
