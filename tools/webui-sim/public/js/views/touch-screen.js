/* Touch & Home Assistant Control Studio (#touch/<activityId>[/<remote>]):
   On-screen buttons, physical hard keys (16417 mirror) and swipe/tap gestures
   for one activity. With remote 16414 it edits the Harmony Smart Control's
   hard keys for the activity instead (it has no screen or gestures); a
   remote in the address means the page was opened from Settings → Remotes,
   which its back arrow returns to.
   Both remotes' keys stay alike: a key edit goes to the other remote's map
   too unless the owner sets it for this remote only, and a key already set
   differently stays that way unless they choose both. Saves go through /api/activity-save like every activity
   edit (touch-model). See docs/TOUCH_EDITOR.md and docs/HOME_ASSISTANT.md.
   Press modes (P11): Standard (hold repeats), One-shot self-long (exactly
   once), Short + Separate Long. Gestures resolve locally on the Touch
   (P18) and cannot use hub one-shot protection. */

import * as api from "../api.js";
import * as hub from "../state.js";
import {
  GESTURE_KEYS,
  LABEL_MAX,
  SMART_CONTROL_REMOTE,
  TOUCH_REMOTE,
  addButton,
  buildTouchControlsMapList,
  controlsSaveOutcome,
  gestureSimulation,
  hardKeysFor,
  hasRemoteMaps,
  isChanged,
  keyOn,
  keyRowsChanged,
  otherRemote,
  isOneShotCommand,
  moveButton,
  neighbourOf,
  readGestures,
  readHardKeys,
  readTouchScreen,
  recommendedPressMode,
  removeButton,
  sameKey,
  saveOutcome,
  setCommand,
  setLabel,
  setLongCommand,
  setPressMode,
  touchSavePayload,
} from "./touch-model.js";
import { parseRfInfo } from "./remotes-model.js";
import {
  confirmDialog,
  escapeHtml,
  icon,
  iconTile,
  openSheet,
  sectionLabel,
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
/* The Smart Control keeps nothing: the hub answers its keys from the saved map. */
const SMART_CONTROL_NOTE = "The Smart Control uses the change at once.";
const REMOTE_NAMES = { [SMART_CONTROL_REMOTE]: "Smart Control", [TOUCH_REMOTE]: "Touch" };

export function createTouchScreenView(section) {
  let activityId = "";
  let softDraft = null;
  let hardRows = [];
  let gestureRows = [];
  let baseMapText = "";
  let remote = TOUCH_REMOTE; // whose map: the Touch's or the Smart Control's
  let fromRemotes = false; // opened from Settings → Remotes
  let hardBase = ""; // the hard-key map text as read, for the save check
  let twin = null; // the other remote's keys { remote, rows, readRows, base }; null when the hub has no maps for it
  let twinPaired; // that remote as the radio lists it; null when not paired, undefined when unknown
  let savedTouch = false; // the last save changed the Touch's map
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
  const isSmart = () => remote === SMART_CONTROL_REMOTE;
  const twinChanged = () => Boolean(twin) && keyRowsChanged(twin.readRows, twin.rows);
  const touchChanged = () => !isSmart() || (twinChanged() && twin.remote === TOUCH_REMOTE);
  const syncNote = () => ((saved && !dirty ? savedTouch : touchChanged()) ? SYNC_NOTE : SMART_CONTROL_NOTE);
  const thisName = () => REMOTE_NAMES[remote];
  const twinName = () => twinPaired?.short ?? REMOTE_NAMES[twin.remote];
  // The other remote's side shows when it's paired (or the radio couldn't say);
  // its keys follow edits either way, so they stay alike if it's paired later.
  const twinShown = () => Boolean(twin) && twinPaired !== null;
  // The Smart Control's keys need a 16414 map on the hub to model a new one on.
  const canEdit = () => (isSmart() ? hasRemoteMaps(hub.state.config, remote) : softDraft?.canCreate);

  function readKeys() {
    const read = readHardKeys(hub.state.config, activityId, { remote });
    hardRows = read.rows;
    hardBase = read.base;
    const other = otherRemote(remote);
    if (hasRemoteMaps(hub.state.config, other)) {
      const theirs = readHardKeys(hub.state.config, activityId, { remote: other });
      twin = { remote: other, rows: theirs.rows, readRows: structuredClone(theirs.rows), base: theirs.base };
    } else {
      twin = null;
    }
  }

  /* The other remote's row for one of this remote's keys. */
  function twinRow(key) {
    const name = twin ? keyOn(twin.remote, key) : "";
    return name ? twin.rows.find((r) => r.buttonKey === name) ?? null : null;
  }

  /* Whether a key is alike on both remotes (neither having it counts), so
     an edit to it goes to both. A key the other remote lacks never mirrors. */
  function mirrors(key) {
    if (!twin || !keyOn(twin.remote, key)) return false;
    return sameKey(hardRows.find((r) => r.buttonKey === key), twinRow(key));
  }

  /* Set (or with null, remove) a key on the other remote, keeping its ButtonId. */
  function setTwinKey(key, row) {
    const name = keyOn(twin.remote, key);
    if (!name) return;
    const kept = twin.rows.find((r) => r.buttonKey === name);
    twin.rows = twin.rows.filter((r) => r.buttonKey !== name);
    if (row) twin.rows.push({ ...structuredClone(row), key: name, buttonKey: name, buttonId: kept?.buttonId ?? null });
  }

  function removeKey(key, both) {
    if (both) setTwinKey(key, null);
    hardRows = hardRows.filter((r) => r.buttonKey !== key);
    markDirty();
  }

  /* Keys only the other remote has set that this remote has too. */
  function twinOnlyRows() {
    if (!twinShown()) return [];
    return twin.rows
      .map((r) => ({ row: r, key: keyOn(remote, r.buttonKey) }))
      .filter(({ key }) => key && !hardRows.some((h) => h.buttonKey === key));
  }

  async function loadTwinPaired(token) {
    if (!twin) return;
    try {
      const reply = await api.getRemotes();
      if (token !== showToken || reply.pairing) return; // a pairing window is open: unknown
      const parsed = parseRfInfo(reply.reply);
      if (!parsed) return;
      const role = twin.remote === SMART_CONTROL_REMOTE ? "smart-control" : "screen";
      twinPaired = parsed.remotes.find((r) => r.role === role) ?? null;
    } catch (_) {
      return; // unknown: the other remote's side stays shown
    }
    if (!section.hidden) render();
  }
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
    setAppBar({
      title: isSmart() ? "Smart Control & HA controls" : "Touch & HA controls",
      back: fromRemotes ? "remotes" : "activities",
      close: dirty,
      onBack: requestClose,
    });
  }

  function tabMarkup() {
    if (isSmart()) return ""; // keys only: no screen, no gestures
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
        <p>${twinShown()
          ? `Keys work the same on the ${escapeHtml(thisName())} and the ${escapeHtml(twinName())} unless you set one for this remote only`
          : isSmart() ? "The Smart Control's keys in this activity" : "Physical hard keys on the Touch"}. Any device works — <strong>Extra</strong> keys are not powered by the activity. Toggles default to One-shot.</p></div>`;
    const savedNote = saved
      ? `<div class="notice notice-warn touch-sync" role="status"><strong>Saved to the hub.</strong> ${escapeHtml(syncNote())}</div>`
      : "";
    if (!canEdit()) return `${intro}<p class="list-note">${isSmart() ? "No Smart Control keys on this hub." : "No Touch screen on this hub."}</p>`;
    const ids = roleIds();
    const list = hardRows.length
      ? `<div class="m-list">${hardRows.map((r) => {
        const extra = !ids.includes(String(r.action?.deviceId));
        const mode = r.pressMode === "oneShot" ? " · One-shot" : r.pressMode === "custom" && r.longPress ? ` · Hold: ${r.longPress.command}` : "";
        // A key both remotes have but set differently is this remote's alone.
        const own = twinShown() && keyOn(twin.remote, r.buttonKey) && !mirrors(r.buttonKey);
        const theirs = own ? twinRow(r.buttonKey) : null;
        const twinNote = own
          ? ` · ${theirs ? `On the ${twinName()}: ${theirs.action?.kind === "command" ? actionSummary(theirs.action) + pressModeSummary(theirs) : "something else"}` : `Not on the ${twinName()}`}`
          : "";
        return `<div class="m-row touch-row">
            <button type="button" class="touch-main" data-hedit="${escapeHtml(r.buttonKey)}" aria-haspopup="dialog">
              <span class="m-row-text">
                <span class="m-row-title">${escapeHtml(r.buttonKey)}${extra ? ` <span class="chip">Extra</span>` : ""}${own ? ` <span class="chip">This remote only</span>` : ""}</span>
                <span class="m-row-sub">${escapeHtml(r.action?.kind === "command" ? actionSummary(r.action) + mode : "Not set")}${extra ? " · extra control" : ""}${escapeHtml(twinNote)}</span>
              </span>
            </button>
            <button type="button" class="icon-btn" data-hremove="${escapeHtml(r.buttonKey)}" aria-label="Remove ${escapeHtml(r.buttonKey)}" ${saving ? " disabled" : ""}>${icon("delete_outlined")}</button>
          </div>`;
      }).join("")}</div>`
      : `<p class="list-note">No keys mapped on the ${escapeHtml(thisName())} yet. Add the ones this activity uses.</p>`;
    const missing = hardKeysFor(remote).filter((k) => !hardRows.some((r) => r.buttonKey === k));
    const addHint = missing.length
      ? `<p class="wiz-hint">Unmapped: ${missing.slice(0, 8).join(", ")}${missing.length > 8 ? ` +${missing.length - 8} more` : ""}.${twinShown() ? ` Keys you add go on both remotes unless you choose this remote only.` : ""}</p>`
      : "";
    const numbersNote = twinShown() && hardRows.some((r) => !keyOn(twin.remote, r.buttonKey))
      ? `<p class="wiz-hint">The ${escapeHtml(twinName())} has no number keys, so those are the ${escapeHtml(thisName())}'s alone.</p>`
      : "";
    const theirsOnly = twinOnlyRows();
    const theirsList = theirsOnly.length
      ? `${sectionLabel(`Only on the ${twinName()}`)}
        <div class="m-list">${theirsOnly.map(({ row, key }) => row.action?.kind === "command"
          ? `<div class="m-row touch-row"><button type="button" class="touch-main" data-htwin="${escapeHtml(key)}" aria-haspopup="dialog">
              <span class="m-row-text"><span class="m-row-title">${escapeHtml(key)}</span>
              <span class="m-row-sub">${escapeHtml(`${actionSummary(row.action)}${pressModeSummary(row)} · not on the ${thisName()}`)}</span></span></button></div>`
          : `<div class="m-row touch-row is-locked"><span class="m-row-text"><span class="m-row-title">${escapeHtml(key)}</span>
              <span class="m-row-sub">${escapeHtml(`${actionSummary(row.action)} · set it on the ${twinName()}`)}</span></span></div>`).join("")}</div>
        ${theirsOnly.some(({ row }) => row.action?.kind === "command")
          ? `<button type="button" class="btn btn-outlined" data-act="htake"${saving ? " disabled" : ""}>Add these here too</button>`
          : ""}`
      : "";
    return `${intro}${savedNote}${tabMarkup()}${list}
      <button type="button" class="wiz-add" data-act="hadd" aria-haspopup="dialog"${saving ? " disabled" : ""}>${icon("add")}<span>Add a key</span></button>
      ${addHint}${numbersNote}${theirsList}
      ${dirty ? `<p class="wiz-hint">${escapeHtml(`Nothing reaches the hub until you save. ${syncNote()}`)}</p>` : ""}`;
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
    if (!canEdit()) return "";
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
    const twinEdits = twinChanged() ? { remote: twin.remote, rows: twin.rows, base: twin.base } : null;
    const mapList = isSmart()
      ? buildTouchControlsMapList(hub.state.config, { hard: { activityId, rows: hardRows, base: hardBase }, twin: twinEdits }, { remote })
      : buildTouchControlsMapList(hub.state.config, {
        soft: softDraft,
        hard: { rows: hardRows },
        gestures: { rows: gestureRows },
        twin: twinEdits,
      });
    return {
      baseRevision: hub.state.config.revision,
      activityList: JSON.parse(JSON.stringify(hub.state.config.activityList)),
      mapList,
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

  /* `from` (a new key only): start from the other remote's setting for `buttonKey`. */
  function openHardSheet(buttonKey, { from = null } = {}) {
    sheet?.close();
    const existing = buttonKey && !from ? hardRows.find((r) => r.buttonKey === buttonKey) : null;
    const start = existing ?? from;
    const devices = pickerDevices();
    const ids = roleIds();
    const keys = hardKeysFor(remote);
    let key = (from && buttonKey) || existing?.buttonKey || keys.find((k) => !hardRows.some((r) => r.buttonKey === k)) || "VolumeUp";
    let pick = start?.action?.kind === "command" ? { ...start.action } : null;
    let pressMode = start?.pressMode ?? (pick ? recommendedPressMode(pick.command) : "standard");
    let longPick = start?.longPress ? { ...start.longPress } : null;
    let deviceId = devices.some((d) => d.id === pick?.deviceId) ? pick.deviceId : devices[0]?.id ?? "";
    // Both remotes when the key is alike on both now; this one only when it already differs.
    let both = mirrors(key);
    let bothChosen = false;
    const twinHas = () => Boolean(twin && keyOn(twin.remote, key));

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
            <div data-h-twin></div>
            <p class="wiz-hint">Keys target any device — non-members are Extra (never powered). One-shot prevents hold double-toggle.</p>
            <label class="search-field">Key <select data-h-key>${keys.map((k) => `<option value="${k}"${k === key ? " selected" : ""}${hardRows.some((r) => r.buttonKey === k && k !== existing?.buttonKey) ? " disabled" : ""}>${k}</option>`).join("")}</select></label>
            <div class="pick-chips" data-h-devices></div>
            <label class="search-field">${icon("search", { size: 22 })}<input type="search" data-h-search placeholder="Search commands"></label>
          </div><div class="pick-list" data-h-list></div>`;
        const $ = (s) => content.querySelector(s);
        let q = "";
        function draw() {
          $("[data-h-now]").textContent = pick ? `${key}: ${pick.deviceId} · ${pick.command}${pressMode === "oneShot" ? " (One-shot)" : ""}` : `${key}: not set`;
          $("[data-h-mode]").innerHTML = pick ? [["standard", "Standard"], ["oneShot", "One-shot"], ["custom", "Custom Hold"]].map(([v, t]) => `<button type="button" class="chip" data-h-modebtn="${v}" aria-pressed="${pressMode === v}">${t}</button>`).join("") : "";
          $("[data-h-devices]").innerHTML = devices.map((d) => `<button type="button" class="chip" data-h-dev="${escapeHtml(d.id)}" aria-pressed="${d.id === deviceId}">${escapeHtml(d.name)}${ids.includes(String(d.id)) ? "" : " · extra"}</button>`).join("");
          const dev = devices.find((d) => d.id === deviceId);
          $("[data-h-list]").innerHTML = (dev?.commands ?? []).filter((c) => !q || c.name.toLowerCase().includes(q.toLowerCase())).map((c) => {
            const on = pick?.deviceId === deviceId && pick?.command === c.name;
            return `<button type="button" class="pick-row${on ? " is-current" : ""}" data-h-cmd="${escapeHtml(c.name)}"><span>${escapeHtml(c.name)}${isOneShotCommand(c.name) ? " · 1-shot" : ""}</span></button>`;
          }).join("") || `<p class="list-note">No commands.</p>`;
          $('[data-h="done"]').disabled = !pick;
          $("[data-h-twin]").innerHTML = twinMarkup();
        }
        function twinMarkup() {
          if (!twinShown()) return "";
          if (!twinHas()) return `<p class="wiz-hint">The ${escapeHtml(twinName())} has no ${escapeHtml(key)} key, so this one is the ${escapeHtml(thisName())}'s alone.</p>`;
          const theirs = twinRow(key);
          const alike = sameKey(pick ? { action: pick, pressMode, longPress: longPick, doublePress: start?.doublePress ?? null } : null, theirs);
          const now = theirs
            ? `On the ${twinName()}: ${theirs.action?.kind === "command" ? actionSummary(theirs.action) + pressModeSummary(theirs) : "something else"}`
            : `Not set on the ${twinName()}`;
          const scope = [["both", "Both remotes"], ["this", `Only the ${thisName()}`]]
            .map(([v, t]) => `<button type="button" class="chip" data-h-scope="${v}" aria-pressed="${(v === "both") === both}">${escapeHtml(t)}</button>`).join("");
          return `<div class="m-chips" role="group" aria-label="Which remotes">${scope}</div>
            <p class="wiz-hint">${escapeHtml(now)}.${!alike && theirs?.action?.kind === "command" ? ` <button type="button" class="btn btn-text btn-sm" data-h="theirs">Use it here</button>` : ""}</p>`;
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
          const sc = ev.target.closest("[data-h-scope]");
          if (sc) { both = sc.dataset.hScope === "both"; bothChosen = true; draw(); return; }
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
          if (act === "theirs") {
            const theirs = twinRow(key);
            pick = { ...theirs.action };
            pressMode = theirs.pressMode ?? "standard";
            longPick = theirs.longPress ? { ...theirs.longPress } : null;
            if (devices.some((d) => d.id === pick.deviceId)) deviceId = pick.deviceId;
            draw();
            return;
          }
          if (act === "done" && pick) {
            const row = { key, buttonKey: key, buttonId: existing?.buttonId ?? null, action: pick, pressMode, longPress: longPick, doublePress: start?.doublePress ?? null, extra: !ids.includes(String(pick.deviceId)), locked: false };
            if (twin && both) {
              // A renamed key leaves the other remote's old key only if they were alike.
              if (existing && key !== buttonKey && mirrors(buttonKey)) setTwinKey(buttonKey, null);
              setTwinKey(key, row);
            }
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
            removeKey(buttonKey, Boolean(twin) && both);
            close();
          }
        });
        content.addEventListener("input", (ev) => {
          if (ev.target.matches("[data-h-search]")) { q = ev.target.value; draw(); }
        });
        content.addEventListener("change", (ev) => {
          if (ev.target.matches("[data-h-key]")) {
            key = ev.target.value;
            if (!bothChosen) both = mirrors(key);
            draw();
          }
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
    const base = isSmart() ? hardBase : softDraft.base;
    const twinCheck = twinChanged() ? { remote: twin.remote, base: twin.base } : null;
    savedTouch = touchChanged();
    saving = true;
    render();
    const reread = () => {
      softDraft = readTouchScreen(hub.state.config, activityId);
      readKeys();
      gestureRows = readGestures(hub.state.config, activityId).rows;
    };
    try {
      await api.saveActivity(payload);
      dirty = false;
      saved = true;
      await hub.reloadConfig();
      reread();
      snackbar(`Saved. ${syncNote()}`);
    } catch (error) {
      // The hub can apply a save and still report a failure (a slow engine),
      // so look at what it has now before saying what happened.
      await hub.reloadConfig();
      const outcome = hub.state.configError
        ? "unknown"
        : controlsSaveOutcome(hub.state.config, activityId, base, payload.mapList, { remote, twin: twinCheck });
      if (error.status === 504 && outcome !== "saved") {
        // The hub's writer hasn't answered yet and may still apply this save.
        snackbar("The hub is still saving. Your changes are still here; reload in a minute to see whether they landed before you save again.", { error: true });
      } else if (outcome === "saved") {
        dirty = false;
        saved = true;
        reread();
        snackbar(`Saved, though the hub was slow to confirm. ${syncNote()}`);
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
    readKeys();
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
    if (await confirmDiscard()) location.hash = fromRemotes ? "#remotes" : "#activities";
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
      // A key alike on both goes from both; one set for this remote only goes from this one.
      removeKey(hremove.dataset.hremove, mirrors(hremove.dataset.hremove));
      return;
    }
    const htwin = event.target.closest("[data-htwin]");
    if (htwin) {
      openHardSheet(htwin.dataset.htwin, { from: twinRow(htwin.dataset.htwin) });
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
          const both = mirrors(sim.hardKey);
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
          if (both) setTwinKey(sim.hardKey, hardRows.at(-1));
          markDirty();
          snackbar(`Added hard key ${sim.hardKey} so ${gkey} can resolve. Save to apply.`);
        }
      }
      return;
    }
    const act = event.target.closest("[data-act]")?.dataset.act;
    if (act === "add") openSoftButtonSheet(null);
    else if (act === "hadd") openHardSheet(null);
    else if (act === "htake") {
      for (const { row, key } of twinOnlyRows()) {
        if (row.action?.kind !== "command") continue;
        hardRows.push({ ...structuredClone(row), key, buttonKey: key, buttonId: null });
      }
      hardRows.sort((a, b) => a.buttonKey.localeCompare(b.buttonKey));
      markDirty();
    }
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
      try {
        activityId = decodeURIComponent(args[0] ?? "");
      } catch (_) {
        activityId = "";
      }
      fromRemotes = args[1] === SMART_CONTROL_REMOTE || args[1] === TOUCH_REMOTE;
      remote = args[1] === SMART_CONTROL_REMOTE ? SMART_CONTROL_REMOTE : TOUCH_REMOTE;
      activeTab = isSmart() ? "hard" : "soft";
      hardBase = "";
      twin = null;
      twinPaired = undefined;
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
        readKeys();
      } catch (_) { hardRows = []; }
      try {
        gestureRows = readGestures(hub.state.config, activityId).rows;
      } catch (_) { gestureRows = []; }
      baseMapText = JSON.stringify(hub.state.config.mapList.ButtonMaps.find((m) => m.ButtonMapIdentifier === `${remote}Activity${activityId}`));
      render();
      loadTwinPaired(token);
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
