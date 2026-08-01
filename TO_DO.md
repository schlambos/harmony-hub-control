# TO DO — UI/UX Audit Findings and Roadmap

Source: hands-on UI audit performed 2026-07-31 against the real backend
(`tools/hub-emu`, actual MIPS `codex_webui` under QEMU) at 1440px and 390px.
Every flow below was exercised live: full wizard create → save → verify →
delete cycle, remote key sends, IR/BT/MQTT/Wi-Fi/backup/system forms,
destructive-action guards, unknown-route fallback, and a mobile layout pass.
Cross-referenced with the source-verified defects in
[docs/FULL_FEATURE_ANALYSIS.md](docs/FULL_FEATURE_ANALYSIS.md).

**Overall verdict:** core functionality is genuinely user-accessible and the
UX quality is well above hobby-project baseline. The daily-driver loop and the
full activity lifecycle work end-to-end with excellent feedback. The gaps are
two silent-damage traps, one lockout trap, and discoverability/effort issues
in the wizard's mapping step and IR onboarding.

## Verified strengths (no action needed)

- State logic: Power off disabled when off; running activity's Delete
  disabled; inline delete confirmation; reboot requires typing `REBOOT` with
  consequences stated; import locked until payload matches selected type;
  unknown hashes fall back to `#control`.
- Wizard quality: plain language ("Its job: Shows the picture"), real input
  lists, duplicate devices disabled across rows, per-step validation, readable
  review, completion state with "Run it now". Test activity saved through the
  real three-resource transaction and appeared everywhere instantly.
- Honest microcopy: "paired is not the same as an authenticated link", "the
  hub never returns the saved password", secret warnings on bundle/exports,
  5 MiB flash education.
- Forms teach: field-level hints, stated clamping ranges, live MQTT "Topics
  on the wire" preview.
- Accessibility bones: real buttons with resolved-action labels, skip-link,
  `aria-current` nav, status regions. Mobile 390px holds up with no
  horizontal overflow (minor truncation only).

---

## A — Traps that damage trust or data (fix first)

### A1. Wizard silently destroys advanced maps  ☑

Source-verified P1. Editing any activity via "Set up" replaces **all** of its
button maps with one wizard-owned `16414Activity` map — including the
conditional `16420Activity<ID>` Bluetooth HID map the advanced editor
requires. The UI offers "Set up" on every activity card with zero warning, so
the friendliest path can quietly break a BT-remote activity.

- Fix: preserve non-wizard-owned maps on edit, or warn and route
  BT-keyboard activities to the advanced editor.
- Where: `tools/webui-sim/public/js/wizard-model.js` (map replacement at
  ~198–240), `payload/web/activity-ui.js` (16420 requirement at ~748–916,
  1920–1926).
- Verify: new wizard-model tests — edit a BT activity, assert 16420 map and
  all non-owned maps survive; advanced validator passes without repair.

### A2. Sign-in lockout is one typo away  ☑

Enabling auth (System → Sign-in) takes username + password with no confirm
field and no "test credentials" step; recovery is SSH-only. The backend is
also fail-open on a corrupt auth file, so protection is weaker than it looks.

- Fix: double-entry password field, or a post-enable verification probe
  (fetch with new credentials before the old session ends); surface a
  "recovery is SSH-only" warning.
- Where: `tools/webui-sim/public/js/views/system.js`; backend
  `payload/source/codex_webui.c` auth handling (~364–390, 831–853).

### A3. Updater points at the wrong repo; pair agent lifecycle drift  ☑

Source-verified P1. The embedded updater fetches from hardcoded upstream
`Ripthulhu/harmony-hub-control` URLs — on a fork install, applying an update
can overwrite the shell and features with upstream binaries. The update
restart path kills `codex_bt_pair_agent` without relaunching it, the browser
updater omits it from its file list, and the installers do not upload it at
all (fresh installs lack pairing until manually fixed).

- Fix: manifest/release URL from build config, not hardcoded; single
  generated artifact manifest drives installer upload + updater allow-list +
  restart set; restart the pair agent after apply.
- Where: `payload/source/codex_webui.c` (~72–80, 4516, 7716–7733),
  `install_webui.py` (~305–313), `install_webui.ps1`,
  `payload/scripts/init.sh` (~30–44), `payload/bin/MANIFEST.txt`.
- Do this before advertising "Software update" in the UI.

---

### Hygiene. No personal fixture IDs in shipped copy  ☑

Backup warnings no longer name household device IDs. Gate:
`node tools/shipped_copy_hygiene.mjs --check` derives forbidden tokens from
fixtures/seeds and scans shipped paths (including embedded shell header).

---

## B — Ease and discoverability

### B4. Button mapping starts populated from roles  ☑

New activities used to open step 3 with 0/35 keys mapped. Defaults are now
the arrival state (not a one-click “apply” action): transport → player role,
volume/mute → volume role, channel/digits → channel role when present,
d-pad/OK/menu/back → player chain — matching the advanced editor’s
`preferredButtonDeviceId` routing. Only real device commands are used; empty
keys stay unmapped. Draft `source` tags (`default` / `user` / `existing`)
show on the remote and in labels; step-2 role changes re-derive defaults
without clobbering user or existing mappings; reset-all / per-key revert
are offered instead of apply.

- Where: `tools/webui-sim/public/js/wizard-model.js` (derive/reconcile),
  `views/wizard.js`, `css/wizard.css`; tests in
  `tools/webui-sim/test/wizard-button-defaults.test.mjs`.

### B5. Full command list hides behind "Inspector"  ☑

Off-skin commands are now under **All commands** (not a debug label). Devices
mode opens the panel by default; Activities stays collapsed unless the user
chose otherwise (`hhc.commands`, with one-time migrate from `hhc.inspector=open`).
Send log is a separate collapsed panel. Rows still send immediately; copy says so.

- Where: `tools/webui-sim/public/js/views/control.js`, `control-panel-state.js`,
  `css/remote.css`, `DESIGN.md`.

### B6. IR onboarding assumes you arrive with codes  ☑

Guided **Find codes for my device**: browser-side **IRDB** index search + file
drop (IRDB CSV, Flipper `.ir`, pipe, Pronto) with format detection, preview
accounting (found / supported / will import), then explicit `/api/irdb-import`.
Hub stays offline for library fetches. Flipper is **file-drop only** (CDN
package index permanently 403s on size; GitHub trees are rate-limited). Partial
source failures surface in the UI. Manual paste and RemoteCentral kept.

- Where: `tools/webui-sim/public/js/ir-library.js`, `views/ir.js`; tests in
  `tools/webui-sim/test/ir-library.test.mjs`.

### B6-follow. Smoke-test library indexes may 403 on jsDelivr /flat  ☐

`tools/ir_database_smoke_test.mjs` still uses
`data.jsdelivr.com/v1/package/gh/.../flat` for LIRC (works today) and SmartIR
(403 package-size, same class as Flipper). Flipper path there uses GitHub trees
(CLI-only, token-friendly). Track separately from the UI.

### B7. Dead ends without remediation  ☐

BT "Text helper · missing" and update binaries "not present" state facts but
never say what to do about it (the pair-agent installer omission makes this
state real for actual users). Add one remediation sentence + doc link each.

- Where: `views/bluetooth.js`, `views/system.js`.

### B8. Remote skin's power key is a dead spot  ☐

The photo's power button is "not mapped — disabled" even while an activity
runs; Power off exists only as a separate UI button. Users tap the picture's
power key first. Consider mapping it to power-off-with-confirm during a
running activity.

- Where: `views/control.js` hotspot handling.

### B9. Sends while everything is off give no context  ☐

Pressing a mapped key with no activity running reports "sent" with no hint
that nothing is on. Add a nudge: "Nothing is running — start NVIDIA Shield?"

- Where: `views/control.js` status line.

---

## C — Polish

### C10. Raw IDs in consumer-facing surfaces  ☐

Activity tiles show "id 48113644"; the footer shows the revision hash. Move
behind the Inspector/details affordances.

### C11. Redundant count chips on device rows  ☐

Device list rows show a bare "44" chip next to "44 commands" text — reads as
a mystery number. Drop the chip or make it meaningful.

### C12. Advanced editor greets users with a scary repair banner  ☐

Graphs that merely need normalization open with a prominent recovery warning
and UNSAVED state before the user touches anything. Soften to "Repairs
suggested (view diff)" with an explicit apply.

### C13. Header activity chip truncates on mobile  ☐

"NVIDIA Shiel…" at 390px. Acceptable; consider text-fit or shorter chip.

---

## Backend security items (from FULL_FEATURE_ANALYSIS — gate for recommending broadly)

Invisible in the UI but required before calling the stack safe beyond a
trusted LAN. See analysis §8 and §14 for full detail and verification plans.

- ☐ Host/Origin/CSRF enforcement on the all-interfaces listener
  (`codex_webui.c` ~8499–8792).
- ☐ Signed/versioned updates (no authenticity or downgrade policy today,
  ~7529–7735).
- ☐ Secret-redacted exports by default; separately confirmed encrypted owner
  backup (~1812–1838, 8581–8602).
- ☐ Wi-Fi value sanitization — newline/control-char injection (~1257–1291).
- ☐ Transactional update/import with automatic rollback (~6145–6320,
  7600–7700).
- ☐ Server resource bounds: child concurrency cap, socket read timeout,
  bounded import buffers (~8775–8790).

---

## Recommended execution order

1. **A1 wizard map preservation** — also unblocks recommending the wizard as
   the default path.
2. **A2 auth lockout guard** — small change, high trust payoff.
3. **A3 update pipeline correctness** — fork URL, pair-agent restart,
   installer/updater parity.
4. **B4 auto-map defaults + B5 Inspector rename** — the two biggest ease
   wins, both cheap.
5. **B6 guided IR import** — turns the strongest power feature into a
   consumer feature.
6. **Backend security items** — before any exposure beyond a trusted LAN.

Items A1, A2 (frontend half), B4–B9, C10–C13 are pure frontend work
(`tools/webui-sim/public/js/` + `sh tools/package_harmony_shell.sh` +
rebuild); A3 touches C and the installers.
