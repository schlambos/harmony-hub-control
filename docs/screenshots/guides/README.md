# Device and activity guide screenshots

These captures support [Adding Devices & Importing IR Codes](../../DEVICES_AND_CODES_GUIDE.md)
and [Creating Activities & Customizing Your Remote](../../ACTIVITIES_GUIDE.md).
They show the real shared UI against `tools/webui-sim/server.mjs`, not a
mock drawing or a live hub. A simulated send, save or sync is not hardware
validation.

## Reproduce

From `desktop/`, with Node and the desktop development dependencies installed:

```sh
npm ci
npx playwright install chromium
npm run bundle:shell
node scripts/capture-guide-screenshots.mjs
node scripts/check-guide-links.mjs
```

The [capture script](../../../desktop/scripts/capture-guide-screenshots.mjs):

- Starts its own simulator on an unused loopback port. An occupied explicit
  `SIM_PORT` fails before any API changes. No real hub address is accepted.
- Renames the simulator's in-memory device/activity display data through
  its ordinary APIs. The checked-in fixture is unchanged. Names such as
  Living Room TV, Marantz AVR and Streaming Box are illustrative, not claims
  that their underlying fixture codes match that hardware. For the advanced
  walkthrough, it keeps only the newly created, complete activity and saves
  the editor's normal map reconciliation. Older demo activities reference
  absent devices and would correctly prevent a whole-graph save.
- Uses Chromium for Web UI captures and the actual Electron preload/IPC for
  Desktop catalog captures. `MELODIOUS_E2E=1` and an isolated temporary
  profile disable discovery and keep saved real hubs/accounts out of scope.
  The catalog service returns public, synthetic test fixtures: no Logitech
  sign-in page, account or online catalog request is involved.
- Blocks external browser requests. IRDB, RemoteCentral, network TV pairing,
  USB and physical remotes are not contacted. The learned signal is supplied
  by the simulator's `capture-next` helper.
- Captures dark-mode PNGs at a 1280 × 840 viewport. The catalog search image
  is cropped to the actual Brand/Model/results area below the account row;
  the preview is scrolled to include the skipped reason and Import button.
  No UI labels or hint text are rewritten for a screenshot.
- Closes the app/browser, stops its simulator and removes only its own
  temporary profile after the run.

`bundle:shell` uses the existing byte-identity guard for the shipped shell
header. Neither guide requires a changed shell, binary, installer or pin.

## Screenshot audit

Reviewed the existing 86 PNGs under `screenshots/desktop/`,
`screenshots/web/` and `screenshots/android/` before choosing captures.
Some legacy activity/list screenshots contain personal activity names;
the older import screenshots also predate today's catalog tab. None of
those files is reused by the new guides or modified in this change.

All 29 PNGs in this directory were visually inspected for readable layout,
current UI labels and clean example values before inclusion. No real IP,
MAC address, email, account, personal activity title or local filesystem
path appears. The catalog skip example is intentional and must remain
visible. The screenshot set covers:

- Add-device choices, the device remote/commands, three IR import tabs,
  learning before/after capture, power, direct/cycling inputs, timing,
  a completed dry-run sweep and the scratch IR lab entry
- The five Web/Desktop activity steps, a Guide press/hold example,
  on-screen buttons, gestures, Home control buttons and their picker,
  advanced-editor overview/power order, and Fix it
- Desktop catalog Sign in, search results and supported/skipped preview

Native Android steps are verified against the Kotlin UI source, not
represented by a Web UI screenshot pretending to be the Android app.
The guides explicitly distinguish its **Start & end** step, ordinary-press
wizard picker, catalog/Paste tabs, and web-only customization paths.

## Label references

Check these before changing the instructions or recapturing:

- `tools/webui-sim/public/js/views/device-{sheets,import,settings,sweep}.js`
  and `device-settings-model.js`
- `tools/webui-sim/public/js/views/{wizard,touch-screen,home-buttons,remote,remotes,restrictions-sheet}.js`
  and `tools/webui-sim/public/js/wizard-model.js`
- `tools/webui-sim/public/js/views/activities.js` and
  `tools/webui-sim/public/vendor/activity-ui.js` for raw/advanced edits
- `desktop/src/catalog/` and `desktop/src/main.js` for sign-in/IPC behavior
- `Android/app/src/main/kotlin/app/melodious/ui/activities/ActivityEditor.kt`,
  `StepEditing.kt`, `TouchScreenEditor.kt`, and `ui/devices/DevicesScreen.kt`

Reader checks for the guides: can a browser-only user import a catalog
package, can an Android user find the correct input/hold editor, can a new
user distinguish device warm-up from activity waits, and can they recover
a failed input switch without reinstalling or resetting the hub?
