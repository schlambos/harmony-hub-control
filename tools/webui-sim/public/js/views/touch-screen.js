/* Touch & Home Assistant Control Studio (#touch/<activityId>):
   On-screen buttons, physical hard keys (16417 mirror) and swipe/tap gestures
   for one activity. Saves go through /api/activity-save like every activity
   edit (touch-model). See docs/TOUCH_EDITOR.md and docs/HOME_ASSISTANT.md.
   Press modes (P11): Standard (hold repeats), One-shot self-long (exactly
   once), Short + Separate Long. Gestures resolve locally on the Touch
   (P18) and cannot use hub one-shot protection. */

import * as api from "../api.js";
import * as hub from "../state.js";
import {
  GESTURE_KEYS,
  LABEL_MAX,
  TOUCH_HARD_KEYS,
  addButton,
  buildTouchControlsMapList,
  controlsSaveOutcome,
  gestureSimulation,
  isChanged,
  isOneShotCommand,
  moveButton,
  neighbourOf,
  readGestures,
  readHardKeys,
  readTouchScreen,
  recommendedPressMode,
  removeButton,
  saveOutcome,
  setCommand,
  setLabel,
  setLongCommand,
  setPressMode,
  touchSavePayload,
} from "./touch-model.js";
import {
  confirmDialog,
  escapeHtml,
  icon,
  iconTile,
  openSheet,
  setAppBar,
  snackbar,
  spinner,
} from "../ui/shell.js";
import {
  gestureWarningsForActivity,
  humanizeLabel,
  isHaDevice,
  sortPickerDevices,
} from "./remote-model.js";

/* A save publishes a new revision, and the Touch syncs by itself when it
   sees it. Its own Sync menu asks the cloud and fails offline. */
const SYNC_NOTE = "The Touch picks up the change by itself. Until it does, a button you moved or changed can run its new action under its old label.";

export function createTouchScreenView(section) {
  let activityId = "";
  let softDraft = null;
  let hardRows = [];
  let gestureRows = [];
  let baseMapText = "";
  let activeTab = "soft"; // soft | hard | gestures
  let dirty = false;
  let saving = false;
  let saved = false;
  let blocked = "";
  let sheet = null;
  let showToken = 0;

  section.innerHTML = `<div class="wiz touch" id="touchRoot"></div>`;
  const root = section.querySelector("#touchRoot");

  const activityName = () => hub.activityName(hub.activityById(activityId));
  const roleIds = () => (hub.activityById(activityId)?.Roles ?? []).map((r) => String(r["DeviceId-"]));

  function actionSummary(action) {
    if (action.kind === "command") {
      const device = hub.deviceById(action.deviceId);
      return `${device ? device.name : "Missing device"} · ${action.command}`;
    }
    if (action.kind === "sequence") return action.name ? `Runs the sequence “${action.name}”` : "Runs a sequence";
    if (action.kind === "activity") return `Starts ${hub.activityName(hub.activityById(action.activityId))}`;
    return "Works on the Touch only";
  }

  function pickerDevices() {
    const ids = roleIds();
    const all = hub.devices().filter((d) => d.commands.length);
    return sortPickerDevices(all, ids);
  }

  function pressModeSummary(row) {
    if (row.action?.kind !== "command") return "";
    if (row.pressMode === "oneShot") return " · One-shot";
    if (row.pressMode === "custom" && row.longPress) return ` · Hold: ${row.longPress.command}`;
    return "";
  }

  function updateBar() {
    if (section.hidden) return;
    setAppBar({ title: "Touch & HA controls", back: "activities", close: dirty, onBack: requestClose });
  }

  function tabMarkup() {
    const tabs = [["soft", "On-screen"], ["hard", `Hard keys (${hardRows.length})`], ["gestures", `Gestures (${gestureRows.length})`]];
    return `<div class="seg-tabs" role="tablist" aria-label="Control type">${tabs.map(([v, t]) => `<button type="button" role="tab" class="seg-tab" data-tab="${v}" aria-selected="${activeTab === v}">${t}</button>`).join("")}</div>`;
  }

  function softBody() {
    const intro = `<div class="wiz-intro"><h2 tabindex="-1">${escapeHtml(activityName())}</h2>
        <p>On-screen buttons in screen order. Toggles default to One-shot (exactly once). Gaps stay visible — new buttons fill the lowest free slot.</p></div>`;
    const syncNote = saved
      ? `<div class="notice notice-warn touch-sync" role="status"><strong>Saved to the hub.</strong> ${escapeHtml(SYNC_NOTE)}</div>`
      : "";
    if (!softDraft.canCreate) {
      return `${intro}<div class="m-empty">
          ${iconTile("info_outlined", { size: 64 })}
          <h2 class="m-empty-title">No Harmony Touch screen on this hub</h2>
          <p class="m-empty-body">On-screen buttons need a Harmony Touch that has synced with this hub at least once.</p>
        </div>`;
    }
    const list = softDraft.rows.length
      ? `<div class="m-list">${softDraft.rows.map(rowMarkup).join("")}</div>`
      : `<p class="list-note">No on-screen buttons yet.</p>`;
    const gapHint = (() => {
      const slots = softDraft.rows.map((r) => r.slot).sort((a, b) => a - b);
      const gaps = [];
      for (let i = 0; i < slots.length; i += 1) {
        if (slots[i] !== i + gaps.length) {
          // Find missing slots before this one.
          for (let s = (slots[i - 1] ?? -1) + 1; s < slots[i]; s += 1) gaps.push(s);
        }
      }
      // Simpler: lowest free slot.
      const used = new Set(slots);
      let free = 0;
      while (used.has(free)) free += 1;
      if (gaps.length || softDraft.rows.length === 0) return "";
      void gaps;
      return free > slots.length ? "" : "";
    })();
    void gapHint;
    return `${intro}${syncNote}${tabMarkup()}${list}
      <button type="button" class="wiz-add" data-act="add" aria-haspopup="dialog"${saving ? " disabled" : ""}>${icon("add")}<span>Add a button</span></button>
      ${keptNote()}
      ${dirty ? `<p class="wiz-hint">${escapeHtml(`Nothing reaches the hub until you save. ${SYNC_NOTE}`)}</p>` : ""}`;
  }

  function rowMarkup(row) {
    const label = row.label || "No label";
    const position = `<span class="touch-slot" title="Slot ${row.slot}" aria-hidden="true">${row.slot + 1}</span>`;
    if (row.locked) {
      return `<div class="m-row touch-row is-locked">
          ${position}
          <span class="m-row-text">
            <span class="m-row-title">${escapeHtml(label)}</span>
            <span class="m-row-sub">${escapeHtml(actionSummary(row.action))} · kept as it is</span>
          </span>
        </div>`;
    }
    const up = neighbourOf(softDraft, row.key, -1);
    const down = neighbourOf(softDraft, row.key, 1);
    return `<div class="m-row touch-row">
        ${position}
        <button type="button" class="touch-main" data-edit="${escapeHtml(row.key)}" aria-haspopup="dialog">
          <span class="m-row-text">
            <span class="m-row-title">${escapeHtml(label)}</span>
            <span class="m-row-sub">${escapeHtml(actionSummary(row.action))}${escapeHtml(pressModeSummary(row))}</span>
          </span>
        </button>
        <span class="touch-move">
          <button type="button" class="icon-btn" data-move="${escapeHtml(row.key)}" data-step="-1" aria-label="${escapeHtml(`Move ${label} up`)}"${up && !saving ? "" : " disabled"}>${icon("keyboard_arrow_up")}</button>
          <button type="button" class="icon-btn" data-move="${escapeHtml(row.key)}" data-step="1" aria-label="${escapeHtml(`Move ${label} down`)}"${down && !saving ? "" : " disabled"}>${icon("keyboard_arrow_down")}</button>
        </span>
      </div>`;
  }

  function keptNote() {
    const { numberPad, sequences } = softDraft.kept;
    const parts = [
      numberPad && `the number pad`,
      sequences && `${sequences} sequence${sequences === 1 ? "" : "s"}`,
    ].filter(Boolean);
    if (!parts.length) return "";
    return `<p class="wiz-hint">This screen also has ${parts.join(" and ")}. They stay as they are. Hard keys and gestures have their own tabs above.</p>`;
  }

  function hardBody() {
    const intro = `<div class="wiz-intro"><h2 tabindex="-1">${escapeHtml(activityName())}</h2>
        <p>Physical hard keys on the Touch (mirrored from the activity). Any device works — <strong>Extra</strong> keys are not powered by the activity. Toggles default to One-shot.</p></div>`;
    const syncNote = saved
      ? `<div class="notice notice-warn touch-sync" role="status"><strong>Saved to the hub.</strong> ${escapeHtml(SYNC_NOTE)}</div>`
      : "";
    if (!softDraft.canCreate) return `${intro}<p class="list-note">No Touch screen on this hub.</p>`;
    const ids = roleIds();
    const list = hardRows.length
      ? `<div class="m-list">${hardRows.map((r) => {
        const extra = !ids.includes(String(r.action?.deviceId));
        const mode = r.pressMode === "oneShot" ? " · One-shot" : r.pressMode === "custom" && r.longPress ? ` · Hold: ${r.longPress.command}` : "";
        return `<div class="m-row touch-row">
            <button type="button" class="touch-main" data-hedit="${escapeHtml(r.buttonKey)}" aria-haspopup="dialog">
              <span class="m-row-text">
                <span class="m-row-title">${escapeHtml(r.buttonKey)}${extra ? ` <span class="chip">Extra</span>` : ""}</span>
                <span class="m-row-sub">${escapeHtml(r.action?.kind === "command" ? actionSummary(r.action) + mode : "Not set")}${extra ? " · extra control" : ""}</span>
              </span>
            </button>
            <button type="button" class="icon-btn" data-hremove="${escapeHtml(r.buttonKey)}" aria-label="Remove ${escapeHtml(r.buttonKey)}" ${saving ? " disabled" : ""}>${icon("delete_outlined")}</button>
          </div>`;
      }).join("")}</div>`
      : `<p class="list-note">No hard keys mapped on the Touch yet. Add the ones this activity uses.</p>`;
    const missing = TOUCH_HARD_KEYS.filter((k) => !hardRows.some((r) => r.buttonKey === k));
    const addHint = missing.length ? `<p class="wiz-hint">Unmapped: ${missing.slice(0, 8).join(", ")}${missing.length > 8 ? ` +${missing.length - 8} more` : ""}. Adding a hard key here mirrors it for the Touch.</p>` : "";
    return `${intro}${syncNote}${tabMarkup()}${list}
      <button type="button" class="wiz-add" data-act="hadd" aria-haspopup="dialog"${saving ? " disabled" : ""}>${icon("add")}<span>Add a hard key</span></button>
      ${addHint}
      ${dirty ? `<p class="wiz-hint">${escapeHtml(`Nothing reaches the hub until you save. ${SYNC_NOTE}`)}</p>` : ""}`;
  }

  function gestureBody() {
    const intro = `<div class="wiz-intro"><h2 tabindex="-1">${escapeHtml(activityName())}</h2>
        <p>Swipes and taps resolve on the Touch against the target device's own screen. Plain swipes release in ~200ms (single execution); hold-swipes ramp. Toggles on gestures can double-fire — prefer On/Off or Up/Down.</p></div>`;
    const syncNote = saved
      ? `<div class="notice notice-warn touch-sync" role="status"><strong>Saved to the hub.</strong> ${escapeHtml(SYNC_NOTE)}</div>`
      : "";
    if (!softDraft.canCreate) return `${intro}<p class="list-note">No Touch screen on this hub.</p>`;
    const warnings = gestureWarningsForActivity(hub.state.config.mapList, activityId);
    const warnByKey = new Map();
    for (const w of warnings) {
      if (!warnByKey.has(w.key)) warnByKey.set(w.key, []);
      warnByKey.get(w.key).push(w.message);
    }
    const list = gestureRows.length
      ? `<div class="m-list">${gestureRows.map((r) => {
        const sim = gestureSimulation({ mapList: hub.state.config.mapList, activityList: hub.state.config.activityList }, activityId, r.gestureKey);
        void sim;
        // Simulate against the draft (unsaved) by building a temp mapList.
        const status = simulateAgainstDraft(r.gestureKey);
        const warns = warnByKey.get(r.gestureKey) ?? [];
        const extraWarn = status.warnings ?? [];
        const allWarn = [...warns, ...extraWarn.filter((w) => !warns.includes(w))];
        return `<div class="m-row touch-row">
            <button type="button" class="touch-main" data-gedit="${escapeHtml(r.gestureKey)}" aria-haspopup="dialog">
              <span class="m-row-text">
                <span class="m-row-title">${escapeHtml(r.gestureKey)}</span>
                <span class="m-row-sub">${escapeHtml(r.action?.kind === "command" ? actionSummary(r.action) : "Not set")}${r.longPress ? ` · Hold: ${r.longPress.command}` : ""}${r.doublePress ? ` · Double: ${r.doublePress.CommandName ?? "set"}` : ""}</span>
                ${status.ok ? `<span class="m-row-sub">Resolves to ${status.resolved} ${status.hardKey ?? ""} on device ${status.deviceId ?? ""} ✓</span>` : `<span class="m-row-sub" style="color:var(--warning)">⚠ ${escapeHtml(status.warnings?.[0] ?? "Won't work yet")}</span>`}
                ${allWarn.slice(0, 1).map((w) => `<span class="m-row-sub">${escapeHtml(w)}</span>`).join("")}
              </span>
            </button>
            <span class="touch-move">
              ${status.reason === "hard-gate-blocked" && status.hardKey ? `<button type="button" class="icon-btn" data-gfix="${escapeHtml(r.gestureKey)}" title="Add hard key ${escapeHtml(status.hardKey)} to this activity" aria-label="Fix ${escapeHtml(r.gestureKey)} by adding ${escapeHtml(status.hardKey)}">${icon("build_outlined")}</button>` : ""}
              <button type="button" class="icon-btn" data-gremove="${escapeHtml(r.gestureKey)}" aria-label="Remove ${escapeHtml(r.gestureKey)}">${icon("delete_outlined")}</button>
            </span>
          </div>`;
      }).join("")}</div>`
      : `<p class="list-note">No gestures yet. Swipes are great for brightness/volume (Up/Down) and discrete On/Off (Right/Left).</p>`;
    const unused = GESTURE_KEYS.filter((k) => !gestureRows.some((r) => r.gestureKey === k));
    return `${intro}${syncNote}${tabMarkup()}${list}
      ${unused.length ? `<button type="button" class="wiz-add" data-act="gadd" aria-haspopup="dialog"${saving ? " disabled" : ""}>${icon("add")}<span>Add a gesture (${unused.join(", ")})</span></button>` : `<p class="wiz-hint">All five gestures are mapped. Tap can also carry Hold and Double-tap actions.</p>`}
      ${dirty ? `<p class="wiz-hint">${escapeHtml(`Nothing reaches the hub until you save. ${SYNC_NOTE}`)}</p>` : ""}`;
  }

  function simulateAgainstDraft(gestureKey) {
    // Build a temp config with the draft's gestures/hard keys applied, then simulate.
    try {
      const mapList = buildTouchControlsMapList(hub.state.config, {
        soft: softDraft,
        hard: { rows: hardRows },
        gestures: { rows: gestureRows },
      });
      return gestureSimulation({ mapList, activityList: hub.state.config.activityList }, activityId, gestureKey);
    } catch (_) {
      return gestureSimulation({ mapList: hub.state.config.mapList, activityList: hub.state.config.activityList }, activityId, gestureKey);
    }
  }

  function bodyMarkup() {
    if (activeTab === "hard") return hardBody();
    if (activeTab === "gestures") return gestureBody();
    return softBody();
  }

  function footMarkup() {
    if (!softDraft?.canCreate) return "";
    return `<div class="wiz-foot">
        <button type="button" class="btn btn-outlined" data-act="undo"${dirty && !saving ? "" : " disabled"}>Undo changes</button>
        <button type="button" class="btn btn-filled${saving ? " is-busy" : ""}" data-act="save"${dirty && !saving ? "" : " disabled"}${saving ? ' aria-busy="true"' : ""}>
          ${saving ? `${spinner()}Saving to hub…` : "Save to hub"}
        </button>
      </div>`;
  }

  function render() {
    updateBar();
    if (blocked || !softDraft) return;
    root.innerHTML = `<div class="wiz-body">${bodyMarkup()}</div>${footMarkup()}`;
  }

  function renderBlocked(kind) {
    blocked = kind;
    updateBar();
    root.innerHTML = kind === "missing"
      ? `<div class="m-empty">
          ${iconTile("info_outlined", { size: 64 })}
          <h2 class="m-empty-title">This activity isn't on the hub any more</h2>
          <p class="m-empty-body">It may have been deleted from another screen.</p>
          <a class="btn btn-filled" href="#activities">Back to activities</a>
        </div>`
      : `<div class="m-empty">
          ${iconTile("wifi_off", { size: 64, tone: "error" })}
          <h2 class="m-empty-title">Can't reach your hub</h2>
          <p class="m-empty-body">${escapeHtml(hub.state.configError?.message || "The hub didn't answer.")}</p>
          <button type="button" class="btn btn-filled" data-act="retry">Try again</button>
        </div>`;
  }

  function markDirty() {
    dirty = true;
    render();
  }

  function applySoft(edit) {
    try {
      softDraft = edit(softDraft);
    } catch (error) {
      snackbar(error.message, { error: true });
      return false;
    }
    markDirty();
    return true;
  }

  function currentPayload() {
    return {
      baseRevision: hub.state.config.revision,
      activityList: JSON.parse(JSON.stringify(hub.state.config.activityList)),
      mapList: buildTouchControlsMapList(hub.state.config, {
        soft: softDraft,
        hard: { rows: hardRows },
        gestures: { rows: gestureRows },
      }),
      functionList: JSON.parse(JSON.stringify(hub.state.config.functionList)),
    };
  }

  function openSoftButtonSheet(key) {
    sheet?.close();
    const row = key ? softDraft.rows.find((r) => r.key === key) : null;
    const devices = pickerDevices();
    let label = row ? row.label : "";
    let labelTouched = Boolean(row);
    let pick = row?.action.kind === "command"
      ? { deviceId: row.action.deviceId, command: row.action.command, functionId: row.action.functionId }
      : null;
    let pressMode = row?.pressMode ?? (pick ? recommendedPressMode(pick.command) : "standard");
    let longPick = row?.longPress ? { ...row.longPress } : null;
    let deviceId = devices.some((d) => d.id === pick?.deviceId) ? pick.deviceId : devices[0]?.id ?? "";
    let longDeviceId = devices.some((d) => d.id === longPick?.deviceId) ? longPick.deviceId : deviceId;
    let query = "";
    let longQuery = "";

    const opened = openSheet({
      label: row ? `Button ${row.label}` : "New button",
      className: "pick-sheet",
      onClose: () => {
        if (sheet === opened) sheet = null;
        if (!sheet) root.querySelector(key ? `[data-edit="${CSS.escape(key)}"]` : '[data-act="add"]')?.focus();
      },
      render: (content, close) => {
        content.innerHTML = `<div class="pick-top">
            <div class="pick-head">
              <h2 class="sheet-title" tabindex="-1" autofocus>${row ? "Edit button" : "New button"}</h2>
              ${row ? `<button type="button" class="btn btn-text is-destructive" data-sheet="remove">Remove</button>` : ""}
              <button type="button" class="btn btn-filled btn-sm" data-sheet="done">Done</button>
            </div>
            <div class="wiz-field">
              <label for="touchLabel">Label on the Touch</label>
              <input id="touchLabel" maxlength="${LABEL_MAX}" autocomplete="off" value="${escapeHtml(label)}">
            </div>
            <p class="pick-now" data-pick-now></p>
            <div class="m-chips" role="group" aria-label="Press behaviour" data-pick-mode></div>
            <p class="wiz-hint" data-pick-hint></p>
            <div class="pick-chips" role="group" aria-label="Device" data-pick-chips></div>
            <label class="search-field">${icon("search", { size: 22 })}<input type="search" data-pick-search placeholder="Search commands" aria-label="Search commands" autocomplete="off"></label>
          </div>
          <div class="pick-list" data-pick-list></div>
          <div class="pick-long" data-pick-long style="display:none"></div>`;
        const $ = (selector) => content.querySelector(selector);

        function drawTop() {
          const ids = roleIds();
          $("[data-pick-now]").textContent = pick
            ? `Sends: ${actionSummary({ kind: "command", ...pick })}${pressMode === "oneShot" ? " (One-shot)" : pressMode === "custom" && longPick ? ` + Hold ${longPick.command}` : ""}${ids.includes(String(pick.deviceId)) ? "" : " [Extra]"}`
            : row && row.action.kind !== "command"
              ? `${actionSummary(row.action)}. Pick a command to send instead.`
              : "Pick the command it sends.";
          const modes = [["standard", "Standard"], ["oneShot", "One-shot"], ["custom", "Separate Hold"]];
          $("[data-pick-mode]").innerHTML = pick ? modes.map(([v, t]) => `<button type="button" class="chip" data-mode="${v}" aria-pressed="${pressMode === v}">${t}</button>`).join("") : "";
          const hint = $("[data-pick-hint]");
          if (pick && isOneShotCommand(pick.command)) {
            hint.textContent = pressMode === "oneShot" ? "One-shot: fires exactly once even when held. Recommended." : "Warning: held ≥300ms double-fires this toggle. Use One-shot.";
          } else if (pick) {
            hint.textContent = pressMode === "standard" ? "Standard: hold ramps volume/brightness." : pressMode === "oneShot" ? "One-shot: fires once at release." : "Separate Hold: pick the Hold command below.";
          } else hint.textContent = "";
          const ids2 = roleIds();
          $("[data-pick-chips]").innerHTML = devices.map((d) => {
            const member = ids2.includes(String(d.id));
            const tag = member ? "" : isHaDevice(d) ? " · HA" : " · extra";
            return `<button type="button" class="chip" data-pick-device="${escapeHtml(d.id)}" aria-pressed="${d.id === deviceId}">${escapeHtml(d.name)}${tag}</button>`;
          }).join("");
          $('[data-sheet="done"]').disabled = !label.trim() || !(pick || row);
          const longBox = $("[data-pick-long]");
          if (pressMode === "custom" && pick) {
            longBox.style.display = "";
            const ldev = devices.find((d) => d.id === longDeviceId);
            longBox.innerHTML = `<p class="wiz-hint">Hold action (fires when held ≥600ms):</p>
              <div class="pick-chips">${devices.map((d) => `<button type="button" class="chip" data-long-device="${escapeHtml(d.id)}" aria-pressed="${d.id === longDeviceId}">${escapeHtml(d.name)}</button>`).join("")}</div>
              <label class="search-field">${icon("search", { size: 22 })}<input type="search" data-long-search placeholder="Search hold commands" autocomplete="off"></label>
              <div data-long-list>${(ldev?.commands ?? []).filter((c) => !longQuery || c.name.toLowerCase().includes(longQuery.toLowerCase())).map((c) => {
                const on = longPick?.deviceId === longDeviceId && longPick?.command === c.name;
                return `<button type="button" class="pick-row${on ? " is-current" : ""}" data-long-command="${escapeHtml(c.name)}"><span>${escapeHtml(c.name)}</span></button>`;
              }).join("") || `<p class="list-note">No commands.</p>`}</div>`;
          } else longBox.style.display = "none";
        }

        function drawList() {
          const device = devices.find((d) => d.id === deviceId);
          const q = query.trim().toLowerCase();
          const check = icon("check", { cls: "pick-check", label: "Current" });
          const rows = (device?.commands ?? [])
            .map((c, i) => ({ c, i }))
            .filter(({ c }) => !q || c.name.toLowerCase().includes(q))
            .map(({ c, i }) => {
              const on = pick?.deviceId === deviceId && pick?.command === c.name;
              const shot = isOneShotCommand(c.name) ? " · 1-shot" : "";
              return `<button type="button" class="pick-row${on ? " is-current" : ""}" data-pick-command="${i}"><span>${escapeHtml(c.name)}${shot}</span>${on ? check : ""}</button>`;
            });
          $("[data-pick-list]").innerHTML = !device
            ? `<p class="list-note">This hub has no devices with commands yet.</p>`
            : rows.length
              ? rows.join("")
              : `<p class="list-note">Nothing matches “${escapeHtml(query.trim())}”.</p>`;
          drawTop();
        }

        function done() {
          const ok = applySoft((d) => {
            if (!row) {
              const added = addButton(d, { label, ...pick, pressMode, longPress: longPick });
              // addButton already handles one-shot; if custom without long, fall back.
              if (pressMode === "custom" && longPick) {
                const key = added.rows.at(-1).key;
                return setLongCommand(added, key, { deviceId: longPick.deviceId, command: longPick.command, functionId: longPick.functionId });
              }
              return added;
            }
            let next = setLabel(d, row.key, label);
            if (pick) {
              next = setCommand(next, row.key, pick);
              // Re-apply the chosen press mode (setCommand auto-picks; override).
              if (pressMode === "standard") next = setPressMode(next, row.key, "standard");
              else if (pressMode === "oneShot") next = setPressMode(next, row.key, "oneShot");
              else if (pressMode === "custom" && longPick) {
                next = setPressMode(next, row.key, "custom", { deviceId: longPick.deviceId, command: longPick.command, functionId: longPick.functionId });
              }
            } else if (pressMode) {
              try {
                if (pressMode === "standard") next = setPressMode(next, row.key, "standard");
                else if (pressMode === "oneShot") next = setPressMode(next, row.key, "oneShot");
              } catch (_) {}
            }
            return next;
          });
          if (ok) close();
        }

        content.addEventListener("click", (event) => {
          const modeBtn = event.target.closest("[data-mode]");
          if (modeBtn) {
            pressMode = modeBtn.dataset.mode;
            if (pressMode === "oneShot" && pick) longPick = { kind: "command", deviceId: pick.deviceId, command: pick.command, functionId: pick.functionId };
            if (pressMode === "standard") longPick = null;
            drawTop();
            drawList();
            return;
          }
          const chip = event.target.closest("[data-pick-device]");
          if (chip) {
            deviceId = chip.dataset.pickDevice;
            drawTop();
            drawList();
            content.querySelector(".pick-row.is-current")?.scrollIntoView({ block: "center" });
            return;
          }
          const lchip = event.target.closest("[data-long-device]");
          if (lchip) {
            longDeviceId = lchip.dataset.longDevice;
            drawTop();
            return;
          }
          const lcmd = event.target.closest("[data-long-command]");
          if (lcmd) {
            const dev = devices.find((d) => d.id === longDeviceId);
            const cmd = dev?.commands.find((c) => c.name === lcmd.dataset.longCommand);
            if (cmd) {
              longPick = { kind: "command", deviceId: dev.id, command: cmd.name, functionId: cmd.functionId ?? 0 };
              pressMode = "custom";
              drawTop();
            }
            return;
          }
          const commandRow = event.target.closest("[data-pick-command]");
          if (commandRow) {
            const device = devices.find((d) => d.id === deviceId);
            const command = device?.commands[Number(commandRow.dataset.pickCommand)];
            if (!command) return;
            pick = { deviceId: device.id, command: command.name, functionId: command.functionId ?? 0 };
            pressMode = recommendedPressMode(command.name);
            if (pressMode === "oneShot") longPick = { kind: "command", deviceId: device.id, command: command.name, functionId: command.functionId ?? 0 };
            else if (pressMode === "standard") longPick = null;
            if (!labelTouched) {
              label = humanizeLabel(command.name).slice(0, LABEL_MAX);
              $("#touchLabel").value = label;
            }
            drawTop();
            drawList();
            return;
          }
          const act = event.target.closest("[data-sheet]")?.dataset.sheet;
          if (act === "done") done();
          else if (act === "remove" && applySoft((d) => removeButton(d, row.key))) close();
        });

        content.addEventListener("input", (event) => {
          if (event.target.id === "touchLabel") {
            label = event.target.value;
            labelTouched = true;
            drawTop();
          } else if (event.target.matches("[data-pick-search]")) {
            query = event.target.value;
            drawList();
          } else if (event.target.matches("[data-long-search]")) {
            longQuery = event.target.value;
            drawTop();
          }
        });

        content.addEventListener("keydown", (event) => {
          if (event.target.id === "touchLabel" && event.key === "Enter") {
            event.preventDefault();
            if (!$('[data-sheet="done"]').disabled) done();
          }
        });

        drawTop();
        drawList();
      },
    });
    sheet = opened;
    opened.content.querySelector(".pick-row.is-current")?.scrollIntoView({ block: "center" });
  }

  function openHardSheet(buttonKey) {
    sheet?.close();
    const existing = buttonKey ? hardRows.find((r) => r.buttonKey === buttonKey) : null;
    const devices = pickerDevices();
    const ids = roleIds();
    let key = existing?.buttonKey ?? TOUCH_HARD_KEYS.find((k) => !hardRows.some((r) => r.buttonKey === k)) ?? "VolumeUp";
    let pick = existing?.action?.kind === "command" ? { ...existing.action } : null;
    let pressMode = existing?.pressMode ?? (pick ? recommendedPressMode(pick.command) : "standard");
    let longPick = existing?.longPress ? { ...existing.longPress } : null;
    let deviceId = devices.some((d) => d.id === pick?.deviceId) ? pick.deviceId : devices[0]?.id ?? "";
    let longDeviceId = devices.some((d) => d.id === longPick?.deviceId) ? longPick.deviceId : deviceId;
    let longQuery = "";

    const opened = openSheet({
      label: existing ? `Hard key ${key}` : "New hard key",
      className: "pick-sheet",
      onClose: () => {
        if (sheet === opened) sheet = null;
        if (!sheet) root.querySelector(existing ? `[data-hedit="${CSS.escape(buttonKey)}"]` : '[data-act="hadd"]')?.focus();
      },
      render: (content, close) => {
        content.innerHTML = `<div class="pick-top">
            <div class="pick-head"><h2 class="sheet-title">${existing ? "Edit hard key" : "New hard key"}</h2>
            ${existing ? `<button type="button" class="btn btn-text is-destructive" data-h="remove">Remove</button>` : ""}
            <button type="button" class="btn btn-filled btn-sm" data-h="done">Done</button></div>
            <p class="pick-now" data-h-now></p>
            <div class="m-chips" data-h-mode></div>
            <p class="wiz-hint">Keys target any device — non-members are Extra (never powered). One-shot prevents hold double-toggle.</p>
            <label class="search-field">Key <select data-h-key>${TOUCH_HARD_KEYS.map((k) => `<option value="${k}"${k === key ? " selected" : ""}${hardRows.some((r) => r.buttonKey === k && k !== existing?.buttonKey) ? " disabled" : ""}>${k}</option>`).join("")}</select></label>
            <div class="pick-chips" data-h-devices></div>
            <label class="search-field">${icon("search", { size: 22 })}<input type="search" data-h-search placeholder="Search commands"></label>
          </div><div class="pick-list" data-h-list></div>
          <div class="pick-long" data-h-long style="display:none"></div>`;
        const $ = (s) => content.querySelector(s);
        let q = "";
        function draw() {
          $("[data-h-now]").textContent = pick ? `${key}: ${pick.deviceId} · ${pick.command}${pressMode === "oneShot" ? " (One-shot)" : pressMode === "custom" && longPick ? ` + Hold ${longPick.command}` : ""}` : `${key}: not set`;
          $("[data-h-mode]").innerHTML = pick ? [["standard", "Standard"], ["oneShot", "One-shot"], ["custom", "Custom Hold"]].map(([v, t]) => `<button type="button" class="chip" data-h-modebtn="${v}" aria-pressed="${pressMode === v}">${t}</button>`).join("") : "";
          $("[data-h-devices]").innerHTML = devices.map((d) => `<button type="button" class="chip" data-h-dev="${escapeHtml(d.id)}" aria-pressed="${d.id === deviceId}">${escapeHtml(d.name)}${ids.includes(String(d.id)) ? "" : " · extra"}</button>`).join("");
          const dev = devices.find((d) => d.id === deviceId);
          $("[data-h-list]").innerHTML = (dev?.commands ?? []).filter((c) => !q || c.name.toLowerCase().includes(q.toLowerCase())).map((c) => {
            const on = pick?.deviceId === deviceId && pick?.command === c.name;
            return `<button type="button" class="pick-row${on ? " is-current" : ""}" data-h-cmd="${escapeHtml(c.name)}"><span>${escapeHtml(c.name)}${isOneShotCommand(c.name) ? " · 1-shot" : ""}</span></button>`;
          }).join("") || `<p class="list-note">No commands.</p>`;
          $('[data-h="done"]').disabled = !pick || (pressMode === "custom" && !longPick);
          const longBox = $("[data-h-long]");
          if (pressMode === "custom" && pick) {
            longBox.style.display = "";
            const ldev = devices.find((d) => d.id === longDeviceId);
            longBox.innerHTML = `<p class="wiz-hint">Hold action (fires when held ≥600ms):</p>
              <div class="pick-chips">${devices.map((d) => `<button type="button" class="chip" data-h-long-device="${escapeHtml(d.id)}" aria-pressed="${d.id === longDeviceId}">${escapeHtml(d.name)}${ids.includes(String(d.id)) ? "" : " · extra"}</button>`).join("")}</div>
              <label class="search-field">${icon("search", { size: 22 })}<input type="search" data-h-long-search placeholder="Search hold commands" autocomplete="off"></label>
              <div data-h-long-list>${(ldev?.commands ?? []).filter((c) => !longQuery || c.name.toLowerCase().includes(longQuery.toLowerCase())).map((c) => {
                const on = longPick?.deviceId === longDeviceId && longPick?.command === c.name;
                return `<button type="button" class="pick-row${on ? " is-current" : ""}" data-h-long-command="${escapeHtml(c.name)}"><span>${escapeHtml(c.name)}</span></button>`;
              }).join("") || `<p class="list-note">No commands.</p>`}</div>`;
          } else longBox.style.display = "none";
        }
        content.addEventListener("click", (ev) => {
          const mb = ev.target.closest("[data-h-modebtn]");
          if (mb) {
            pressMode = mb.dataset.hModebtn;
            if (pressMode === "oneShot" && pick) longPick = { ...pick };
            if (pressMode === "standard") longPick = null;
            draw();
            return;
          }
          const dc = ev.target.closest("[data-h-dev]");
          if (dc) { deviceId = dc.dataset.hDev; draw(); return; }
          const ldc = ev.target.closest("[data-h-long-device]");
          if (ldc) { longDeviceId = ldc.dataset.hLongDevice; draw(); return; }
          const lcmd = ev.target.closest("[data-h-long-command]");
          if (lcmd) {
            const dev = devices.find((d) => d.id === longDeviceId);
            const c = dev?.commands.find((x) => x.name === lcmd.dataset.hLongCommand);
            if (c) { longPick = { kind: "command", deviceId: dev.id, command: c.name, functionId: c.functionId ?? 0 }; pressMode = "custom"; draw(); }
            return;
          }
          const cmd = ev.target.closest("[data-h-cmd]");
          if (cmd) {
            const dev = devices.find((d) => d.id === deviceId);
            const c = dev?.commands.find((x) => x.name === cmd.dataset.hCmd);
            if (c) {
              pick = { kind: "command", deviceId: dev.id, command: c.name, functionId: c.functionId ?? 0 };
              pressMode = recommendedPressMode(c.name);
              longPick = pressMode === "oneShot" ? { ...pick } : null;
              draw();
            }
            return;
          }
          const act = ev.target.closest("[data-h]")?.dataset.h;
          if (act === "done" && pick) {
            const row = { buttonKey: key, buttonId: existing?.buttonId ?? null, action: pick, pressMode, longPress: longPick, doublePress: existing?.doublePress ?? null, extra: !ids.includes(String(pick.deviceId)), locked: false };
            if (existing) {
              hardRows = hardRows.map((r) => r.buttonKey === buttonKey ? { ...row, buttonId: r.buttonId } : r);
              // Key rename: if key changed, replace.
              if (key !== buttonKey) {
                hardRows = hardRows.filter((r) => r.buttonKey !== buttonKey);
                if (!hardRows.some((r) => r.buttonKey === key)) hardRows.push(row);
              }
            } else {
              hardRows.push(row);
              hardRows.sort((a, b) => a.buttonKey.localeCompare(b.buttonKey));
            }
            markDirty();
            close();
          } else if (act === "remove") {
            hardRows = hardRows.filter((r) => r.buttonKey !== buttonKey);
            markDirty();
            close();
          }
        });
        content.addEventListener("input", (ev) => {
          if (ev.target.matches("[data-h-search]")) { q = ev.target.value; draw(); }
          else if (ev.target.matches("[data-h-long-search]")) { longQuery = ev.target.value; draw(); }
        });
        content.addEventListener("change", (ev) => {
          if (ev.target.matches("[data-h-key]")) { key = ev.target.value; draw(); }
        });
        draw();
      },
    });
    sheet = opened;
  }

  function openGestureSheet(gestureKey) {
    sheet?.close();
    const existing = gestureKey ? gestureRows.find((r) => r.gestureKey === gestureKey) : null;
    const devices = pickerDevices();
    let gkey = existing?.gestureKey ?? GESTURE_KEYS.find((k) => !gestureRows.some((r) => r.gestureKey === k)) ?? "Tap";
    let pick = existing?.action?.kind === "command" ? { ...existing.action } : null;
    let longPick = existing?.longPress ? { ...existing.longPress } : null;
    let doublePick = existing?.doublePress ?? null;
    let deviceId = devices.some((d) => d.id === pick?.deviceId) ? pick.deviceId : devices[0]?.id ?? "";

    const opened = openSheet({
      label: existing ? `Gesture ${gkey}` : "New gesture",
      className: "pick-sheet",
      onClose: () => {
        if (sheet === opened) sheet = null;
      },
      render: (content, close) => {
        content.innerHTML = `<div class="pick-top">
          <div class="pick-head"><h2 class="sheet-title">${existing ? "Edit gesture" : "New gesture"}</h2>
          ${existing ? `<button type="button" class="btn btn-text is-destructive" data-g="remove">Remove</button>` : ""}
          <button type="button" class="btn btn-filled btn-sm" data-g="done">Done</button></div>
          <p class="pick-now" data-g-now></p>
          <p class="wiz-hint">Gestures cannot use hub one-shot: avoid raw toggles on Tap, or enable HA-side debounce. Prefer On/Off or Up/Down. Hold-swipes ramp.</p>
          <label>Gesture <select data-g-key>${GESTURE_KEYS.map((k) => `<option value="${k}"${k === gkey ? " selected" : ""}${gestureRows.some((r) => r.gestureKey === k && k !== existing?.gestureKey) ? " disabled" : ""}>${k}</option>`).join("")}</select></label>
          <div class="pick-chips" data-g-devices></div>
          <label class="search-field">${icon("search", { size: 22 })}<input type="search" data-g-search placeholder="Search commands"></label>
        </div><div class="pick-list" data-g-list></div><div data-g-warn></div>`;
        const $ = (s) => content.querySelector(s);
        let q = "";
        function draw() {
          $("[data-g-now]").textContent = pick ? `${gkey}: ${pick.deviceId} · ${pick.command}` : `${gkey}: not set`;
          $("[data-g-devices]").innerHTML = devices.map((d) => `<button type="button" class="chip" data-g-dev="${escapeHtml(d.id)}" aria-pressed="${d.id === deviceId}">${escapeHtml(d.name)}</button>`).join("");
          const dev = devices.find((d) => d.id === deviceId);
          $("[data-g-list]").innerHTML = (dev?.commands ?? []).filter((c) => !q || c.name.toLowerCase().includes(q.toLowerCase())).map((c) => {
            const on = pick?.deviceId === deviceId && pick?.command === c.name;
            return `<button type="button" class="pick-row${on ? " is-current" : ""}" data-g-cmd="${escapeHtml(c.name)}"><span>${escapeHtml(c.name)}${isOneShotCommand(c.name) ? " ⚠ toggle" : ""}</span></button>`;
          }).join("") || `<p class="list-note">No commands.</p>`;
          $('[data-g="done"]').disabled = !pick;
          // Live simulation against draft.
          try {
            const tmpGestures = [...gestureRows.filter((r) => r.gestureKey !== gkey), { gestureKey: gkey, buttonId: existing?.buttonId ?? 1, action: pick ?? { kind: "command", deviceId, command: "X", functionId: 0 }, longPress: longPick, doublePress: doublePick }];
            const tmpMap = buildTouchControlsMapList(hub.state.config, { soft: softDraft, hard: { rows: hardRows }, gestures: { rows: tmpGestures } });
            const sim = gestureSimulation({ mapList: tmpMap, activityList: hub.state.config.activityList }, activityId, gkey);
            $("[data-g-warn]").innerHTML = sim.ok
              ? `<p class="wiz-hint">✓ Resolves to ${sim.resolved} on device ${sim.deviceId}.${sim.warnings?.length ? " " + escapeHtml(sim.warnings[0]) : ""}</p>`
              : `<p class="wiz-hint" style="color:var(--warning)">⚠ ${escapeHtml(sim.warnings?.[0] ?? sim.reason)}</p>`;
          } catch (e) {
            $("[data-g-warn]").innerHTML = "";
          }
        }
        content.addEventListener("click", (ev) => {
          const dc = ev.target.closest("[data-g-dev]");
          if (dc) { deviceId = dc.dataset.gDev; draw(); return; }
          const cmd = ev.target.closest("[data-g-cmd]");
          if (cmd) {
            const dev = devices.find((d) => d.id === deviceId);
            const c = dev?.commands.find((x) => x.name === cmd.dataset.gCmd);
            if (c) { pick = { kind: "command", deviceId: dev.id, command: c.name, functionId: c.functionId ?? 0 }; draw(); }
            return;
          }
          const act = ev.target.closest("[data-g]")?.dataset.g;
          if (act === "done" && pick) {
            const row = { gestureKey: gkey, buttonId: existing?.buttonId ?? null, action: pick, longPress: longPick, doublePress: doublePick, rawLong: longPick ? { "DeviceId-": Number(longPick.deviceId), __type: "ButtonCommandAction", "FunctionId-": Number(longPick.functionId) || 0, CommandName: longPick.command } : null, rawDouble: doublePick };
            if (existing) {
              gestureRows = gestureRows.map((r) => r.gestureKey === gestureKey ? (gkey !== gestureKey ? { ...row } : { ...row, gestureKey: gkey }) : r);
              if (gkey !== gestureKey) gestureRows = gestureRows.filter((r, i, arr) => arr.findIndex((x) => x.gestureKey === r.gestureKey) === i);
            } else gestureRows.push(row);
            markDirty();
            close();
          } else if (act === "remove") {
            gestureRows = gestureRows.filter((r) => r.gestureKey !== gestureKey);
            markDirty();
            close();
          }
        });
        content.addEventListener("input", (ev) => {
          if (ev.target.matches("[data-g-search]")) { q = ev.target.value; draw(); }
        });
        content.addEventListener("change", (ev) => {
          if (ev.target.matches("[data-g-key]")) { gkey = ev.target.value; draw(); }
        });
        draw();
      },
    });
    sheet = opened;
  }

  async function save() {
    if (saving || !dirty) return;
    let payload;
    try {
      payload = currentPayload();
    } catch (error) {
      snackbar(`Not saved — ${error.message}`, { error: true });
      return;
    }
    const base = softDraft.base;
    saving = true;
    render();
    const reread = () => {
      softDraft = readTouchScreen(hub.state.config, activityId);
      hardRows = readHardKeys(hub.state.config, activityId).rows;
      gestureRows = readGestures(hub.state.config, activityId).rows;
    };
    try {
      await api.saveActivity(payload);
      dirty = false;
      saved = true;
      await hub.reloadConfig();
      reread();
      snackbar("Saved. The Touch picks up the change by itself.");
    } catch (error) {
      // The hub can apply a save and still report a failure (a slow engine),
      // so look at what it has now before saying what happened.
      await hub.reloadConfig();
      const outcome = hub.state.configError
        ? "unknown"
        : controlsSaveOutcome(hub.state.config, activityId, base, payload.mapList);
      if (error.status === 504 && outcome !== "saved") {
        // The hub's writer hasn't answered yet and may still apply this save.
        snackbar("The hub is still saving. Your changes are still here; reload in a minute to see whether they landed before you save again.", { error: true });
      } else if (outcome === "saved") {
        dirty = false;
        saved = true;
        reread();
        snackbar("Saved, though the hub was slow to confirm. The Touch picks up the change by itself.");
      } else if (outcome === "unchanged") {
        snackbar(`Not saved — ${error.message || "hub error"}. Nothing changed on the hub; your changes are still here, so you can try again.`, { error: true });
      } else if (outcome === "changed") {
        dirty = false;
        saved = true;
        reread();
        snackbar("The hub didn't confirm the save, and its copy of this screen changed. This shows what the hub has now.", { error: true });
      } else {
        snackbar(`Couldn't save — ${error.message || "hub error"}. Reload to see what the hub has.`, { error: true });
      }
    } finally {
      saving = false;
      if (!section.hidden) render();
    }
  }

  function undo() {
    softDraft = readTouchScreen(hub.state.config, activityId);
    hardRows = readHardKeys(hub.state.config, activityId).rows;
    gestureRows = readGestures(hub.state.config, activityId).rows;
    dirty = false;
    render();
  }

  async function confirmDiscard() {
    if (saving) {
      snackbar("Saving to the hub… one moment");
      return false;
    }
    if (!dirty) return true;
    const discard = await confirmDialog({
      title: "Discard changes?",
      text: "Nothing has been saved to the hub yet.",
      confirmLabel: "Discard",
      destructive: true,
    });
    if (discard) dirty = false;
    return discard;
  }

  async function requestClose() {
    if (await confirmDiscard()) location.hash = "#activities";
  }

  root.addEventListener("click", (event) => {
    if (saving) return;
    const tab = event.target.closest("[data-tab]");
    if (tab) {
      activeTab = tab.dataset.tab;
      render();
      return;
    }
    const edit = event.target.closest("[data-edit]");
    if (edit) {
      openSoftButtonSheet(edit.dataset.edit);
      return;
    }
    const move = event.target.closest("[data-move]");
    if (move) {
      applySoft((d) => moveButton(d, move.dataset.move, Number(move.dataset.step)));
      return;
    }
    const hedit = event.target.closest("[data-hedit]");
    if (hedit) {
      openHardSheet(hedit.dataset.hedit);
      return;
    }
    const hremove = event.target.closest("[data-hremove]");
    if (hremove) {
      hardRows = hardRows.filter((r) => r.buttonKey !== hremove.dataset.hremove);
      markDirty();
      return;
    }
    const gedit = event.target.closest("[data-gedit]");
    if (gedit) {
      openGestureSheet(gedit.dataset.gedit);
      return;
    }
    const gremove = event.target.closest("[data-gremove]");
    if (gremove) {
      gestureRows = gestureRows.filter((r) => r.gestureKey !== gremove.dataset.gremove);
      markDirty();
      return;
    }
    const gfix = event.target.closest("[data-gfix]");
    if (gfix) {
      const gkey = gfix.dataset.gfix;
      const sim = simulateAgainstDraft(gkey);
      if (sim.reason === "hard-gate-blocked" && sim.hardKey && sim.deviceId && sim.command) {
        // One-click fix: add the missing hard key to this activity.
        if (!hardRows.some((r) => r.buttonKey === sim.hardKey)) {
          hardRows.push({
            buttonKey: sim.hardKey,
            buttonId: null,
            action: { kind: "command", deviceId: sim.deviceId, command: sim.command, functionId: sim.functionId ?? 0 },
            pressMode: "standard",
            longPress: null,
            doublePress: null,
            extra: !roleIds().includes(String(sim.deviceId)),
            locked: false,
          });
          markDirty();
          snackbar(`Added hard key ${sim.hardKey} so ${gkey} can resolve. Save to apply.`);
        }
      }
      return;
    }
    const act = event.target.closest("[data-act]")?.dataset.act;
    if (act === "add") openSoftButtonSheet(null);
    else if (act === "hadd") openHardSheet(null);
    else if (act === "gadd") openGestureSheet(null);
    else if (act === "save") save();
    else if (act === "undo") undo();
    else if (act === "retry") hub.reloadConfig().then(() => view.onShow({ args: [activityId] }));
  });

  window.addEventListener("beforeunload", (event) => {
    if (!dirty || section.hidden) return;
    event.preventDefault();
    event.returnValue = "";
  });

  const view = {
    async onShow({ args = [] } = {}) {
      const token = (showToken += 1);
      sheet?.close();
      softDraft = null;
      hardRows = [];
      gestureRows = [];
      dirty = false;
      saving = false;
      saved = false;
      blocked = "";
      activeTab = "soft";
      try {
        activityId = decodeURIComponent(args[0] ?? "");
      } catch (_) {
        activityId = "";
      }
      root.innerHTML = `<div class="m-center">${spinner("Loading")}</div>`;
      updateBar();
      await hub.ensureConfig();
      if (token !== showToken || section.hidden) return;
      if (hub.state.configError) {
        renderBlocked("error");
        return;
      }
      if (!hub.activityById(activityId)) {
        renderBlocked("missing");
        return;
      }
      softDraft = readTouchScreen(hub.state.config, activityId);
      try {
        hardRows = readHardKeys(hub.state.config, activityId).rows;
      } catch (_) { hardRows = []; }
      try {
        gestureRows = readGestures(hub.state.config, activityId).rows;
      } catch (_) { gestureRows = []; }
      baseMapText = JSON.stringify(hub.state.config.mapList.ButtonMaps.find((m) => m.ButtonMapIdentifier === `16417Activity${activityId}`));
      render();
      root.querySelector(".wiz-intro h2")?.focus({ preventScroll: true });
    },
    onHide() {
      showToken += 1;
      sheet?.close();
    },
    confirmLeave: confirmDiscard,
  };
  return view;
}
