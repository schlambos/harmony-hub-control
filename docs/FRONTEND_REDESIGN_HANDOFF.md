# FRONT-END REDESIGN HANDOFF

Read this in full before touching anything. It is the authoritative state
document for the web UI redesign that lives in `tools/webui-sim/`.

---

## 1. GROUND RULES (non-negotiable)

- **Sim only.** All redesign work is in `tools/webui-sim/`. Nothing has been
  pushed to the hub, nothing to origin, nothing committed. Production UI is
  still embedded in `payload/source/codex_webui.c` — do not port without the
  owner's explicit direction.
- The sim binds `127.0.0.1:8787` and never contacts `192.168.0.123`.
- All prior constraints from `docs/SESSION_HANDOFF.md` still apply (no cloud,
  no WAN route, no unpair/factory-reset, no secrets in commits, no pushing to
  origin/Ripthulhu, no hub reboots or TV interruption).
- HALT when done reading or when your task completes. Do not propose next
  steps. Wait for the owner's direction.

## 2. WHERE THIS STARTED

Prior session had built `tools/webui-sim/` (mock hub API + first-pass shell
UI). The owner's verdict: the UI was "a clusterfuck", "vibe coded", and
unfriendly. Three rounds of correction happened this session:

1. **Full audit + redesign** of every route (I read every front-end file and
   screenshotted every route at 1440px and 390px before designing anything).
2. **Guided setup wizard** — owner: "we really should have a wizard that walks
   the user through configuring their activities, buttons… the remote image is
   very beneficial… factor in UX and ease of access."
3. **Product restructure** — owner: "You didn't consider the 'new blank'
   bullshit. I don't want that. I want an activity setup wizard. This still
   flows like an engineering product sample dashboard… user friendly and
   production ready."

Two hard corrections from earlier sessions remain law:
- The virtual remote MUST be the real Harmony JPEG +
  `IR_REMOTE_BUTTONS` percent geometry. Never invent a second handset.
- Do not design-by-subagent; the owner asked me directly for design judgment.

## 3. DESIGN SYSTEM (DESIGN.md at repo root — keep it in sync)

Dark charcoal "AV rack console". Two color meanings, defended aggressively:
- **Amber = primary action** (one per screen). Everything else is quiet.
- **Teal = live/on-air only.**
- **Red outline = Power off / destructive** (Power off is never amber).

New button tier: `.btn-quiet` — hairline border, tertiary text, reveals amber
on hover. Used for all repeatable row actions (Run, Start, Set up). This is
what keeps screens to one amber element.

**The remote philosophy: the photo IS the interface.** Hotspots are
invisible at rest (no fill, no border). Mappedness is communicated by
response: amber glow ring on hover/focus, 35% flash on press, intensifying
glow during the 550ms long-press window, 4px hold-tick dot revealed only on
hover. The exception is the wizard's mapping step — a config surface, where
mapped keys get a persistent amber-muted fill (deliberate divergence,
documented in the CSS).

## 4. WHAT WAS BUILT (and why)

### 4a. Redesign pass (existing views)

Problems found by looking, not guessing:
- Hotspots rendered as permanent amber pills over the whole photo — "amber
  bubble-wrap". Fixed: invisible at rest (§3).
- Mobile `min-width/height` hotspot override broke the percent geometry and
  piled keys on top of each other. **Deleted — percent geometry is sacred.**
- Amber had lost meaning (5+ amber buttons per screen). Fixed with
  `.btn-quiet` + danger Power off.
- Status line ("what did my press just do") was below the fold under the
  591×1280 remote. **Moved above the remote**, pinned under the now-strip.
- Debug panels (Resolved actions, Send log) had user-grade billing. Merged
  into a single collapsed **Inspector** `<details>` panel, state persisted in
  `localStorage("hhc.inspector")`. Refresh state lives inside it now.
- Real bugs fixed: Home event log read `ev.type`/`ev.message` but the API
  sends `kind`/`buttonKey`/`command` (rows rendered empty); `.src-main` is a
  `<button>` and inherited UA `text-align:center` (names centered); activities
  savebar had two competing amber primaries (now: Save to hub = amber,
  Save & refresh = secondary, Run/Duplicate = ghost); global `[hidden]` rule
  added because component `display` values beat the UA rule and hidden
  buttons leaked visible.

### 4b. Activity setup wizard (`#wizard`)

Four steps: **Name it → Pick devices → Map buttons → Review & save.**
The vendored editor assumed you think like the firmware; the wizard assumes
you think like a person:

- Roles are jobs in English ("Shows the picture", "Controls the volume") with
  hint lines, mapped to real `__type`s underneath. Input-on-start comes from
  the device's actual command list (`InputHdmi1` → "HDMI 1").
- **Map buttons uses the real remote photo**: click a key → pick device +
  searchable command (datalist, validated against the device's commands) +
  optional long-press (same device).
- Review is a human-readable summary; success screen offers Run/Open
  remote/All activities.

**It writes genuine Harmony graphs, not approximations.** Shapes were
extracted from the genuine fixture and the vendored editor source:
- ID allocation above the Logitech floors (`MAP_ID_FLOOR 52944089`,
  `BUTTON_ID_FLOOR 1878029713`, ceiling 2147483000) — never reuse cloud IDs.
- `ActivityButtonMap` with `ButtonMapIdentifier: 16414Activity<ID>`, surface
  and remote IDs cloned from an existing surface map, `ButtonState: 1`,
  unique positive `ButtonId`s, canonical `ButtonKey` names
  (`BUTTON_KEY_BY_LABEL` in `remote-layout.js`: "Volume up" → `VolumeUp`,
  OK → `Select`, digits → `Number0-9`).
- Roles carry per-device `PowerOnOrder`/`PowerOffOrder` (roles sharing a
  device share an order number), `SelectedInput`, optional
  `NextDevicePowerOnDelay`.
- `ActivityFunctionMap` per activity (`Functions.UserConfigurator.<id>`,
  empty groups — matches vendor behavior on this fixture, which has no
  device function maps).
- Save = full-graph replace via `POST /api/activity-save` with
  `baseRevision` (409 on conflict).

Verified: zero action-less buttons, zero duplicate IDs, and the vendored
editor's own repair pass needed **0 identity fixes** on wizard output.
Edit mode replaces in place (same activity ID, maps replaced not
duplicated, hidden advanced fields preserved).

### 4c. Product restructure

- `#activities` = **friendly management page** (`views/activities-home.js`):
  cards with name + "Watch a movie · 3 devices · 68 buttons", Run, Set up
  (opens wizard preloaded via `setWizardEditId`), reorder ↑↓ (rewrites
  ActivityOrder sequentially through a full-graph save), Delete with inline
  two-step confirm (disabled while live). One amber CTA: "Set up a new
  activity". No repair dumps, no JSON, no raw IDs.
- `#editor` = the vendored full-fidelity editor, retitled **Advanced
  editor**, for power users. Repair notices and JSON tabs live here now.
- **"New blank" is gone** (roster button removed; vendor binds with optional
  chaining, so absence is safe). The wizard is the only creation path. The
  in-wizard "Start from" switcher was also removed — editing enters from
  each card's Set up button. One mental model: cards manage, wizard
  configures.
- Control: clicking **Run now also selects the activity** so the remote
  follows what's playing (Run ≠ select was confusing).

## 5. METHOD DRIVERS (why it was done this way)

- **Look before designing.** Every file read, every route screenshotted
  desktop + mobile before any pixel moved. The worst problems (amber wash,
  geometry pile-up, empty event log) were only visible in renders.
- **Genuine shapes over invented shapes.** Graph contracts came from the
  genuine Logitech fixture and `payload/web/activity-ui.js` (floors,
  identifiers, surface templates, `__type` names) — the paired remote is
  fragile about identities (see README "Paired Remote Requirements").
- **The full editor stays as the escape hatch** rather than being rewritten:
  it handles exotic cases (double-press, soft menu buttons, sequences,
  per-surface maps) the wizard deliberately doesn't expose.
- **Sim-first iteration** because the owner forbade production changes.

## 6. KEY FILES

- `DESIGN.md` — design system; must match `tokens.css` behavior.
- `tools/webui-sim/public/css/tokens.css|app.css|remote.css|wizard.css|activity-overrides.css`
- `tools/webui-sim/public/js/views/activities-home.js` — friendly cards page (#activities)
- `tools/webui-sim/public/js/views/wizard.js` — 4-step wizard (#wizard)
- `tools/webui-sim/public/js/wizard-model.js` — allocator, graph composers,
  save/delete/reorder through `/api/activity-save`
- `tools/webui-sim/public/js/remote-layout.js` — geometry + aliases +
  `BUTTON_KEY_BY_LABEL` canonical ButtonKey map
- `tools/webui-sim/public/js/views/activities.js` — vendored editor host (#editor)
- `tools/webui-sim/public/js/views/control.js` — remote view, Inspector,
  Run-follows-selection
- `tools/webui-sim/server.mjs` — mock API (full-graph replace save,
  baseRevision 409 semantics)

## 7. GOTCHAS THE NEXT AGENT WILL HIT

- **Browser cache lies during QA.** The Playwright profile serves stale JS
  modules/CSS across same-URL navigations despite `no-cache`. Always navigate
  with a cache-buster (`/?fresh=N#route`) or close the page first. Two
  "bugs" (409 mismatch, device select) were actually stale-page artifacts.
- The vendored editor registers a **beforeunload dialog** when it has
  unsaved repair state — auto-accept dialogs in Playwright when navigating
  away from #editor.
- `[hidden]` loses to component `display` values — the global
  `[hidden]{display:none!important}` in app.css is load-bearing, do not
  remove it.
- `<button>` defaults to `text-align:center` — always set text-align on
  button-as-row patterns.
- The genuine fixture ships **2 pre-existing orphan ActivityButtonMaps**
  (activity 41467671) — not your bug; that's what the vendored repair
  removes.
- The sim's `/api/control-button` resolves through `ActivityButtonMap`s by
  `ButtonKey` (hard) or `TextOnRemote`/`MenuItem.IndexInMenu` (soft).
- The friendly cards page intentionally does NOT run the vendored repair
  pass — repair stays in the advanced editor where its notices belong.
- Sim state is in-memory: `POST /api/sim/reset` restores the fixture. Always
  reset after QA.

## 8. KNOWN BOUNDARIES (deliberate, not gaps)

- Wizard does not expose: double-press, soft menu buttons, sequences,
  multi-surface maps, per-key cross-device hold (hold is same-device).
  Advanced editor covers these.
- Setup pages (IR/BT/MQTT/Wi-Fi/Backup/System) are COMPLETE in the sim
  (built against tools/hub-emu, QA-green: 65/65 emulator contract asserts,
  213/213 unit tests, 14/14 browser scenarios). They exist only in
  tools/webui-sim/ and are NOT deployed to the hub; see
  docs/PRODUCTION_PUSH_READINESS.md for the push analysis.
- Home "Sim status" panel is now a one-line footer (`sim · N activities ·
  … · rev …`) by design.

## 9. STATE AT HANDOFF

- Repo: `/Users/matt/Documents/Codex/2026-07-26/ro/work/harmony-hub-control`,
  branch `agent/activity-webgui` @ 5d84cd9. **No commits, nothing pushed.**
  Uncommitted: `DESIGN.md`, `docs/SESSION_HANDOFF.md`,
  `docs/FRONTEND_REDESIGN_HANDOFF.md`, `tools/webui-sim/` (entire tree).
- Live hub untouched. Prior hub state in `docs/SESSION_HANDOFF.md` remains
  authoritative.
- Sim: `node tools/webui-sim/server.mjs` → `http://127.0.0.1:8787/#control`
  (node path: `/Users/matt/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node`).
  Sim was reset to pristine fixture at handoff.
- All QA green at handoff: create/edit/delete/reorder flows, remote press
  resolution, mobile 390px, 0 console errors, `node --check` clean on all
  edited JS.

HALT. Do not propose or start further work. Wait for the owner's direction.
