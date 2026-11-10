/* Home control buttons (#homebuttons, #homebuttons/<activityId>): what the
   Harmony Companion's Light 1, Light 2, Plug 1, Plug 2 and + / − do.
   Without an activity the page sets the global buttons; with one it sets
   that activity's overrides, which can also turn a button off there. One
   row per button opens its sheet (button-picker.js). Saves go through
   saveMapList (home-buttons-model). */

import * as hub from "../state.js";
import {
  HOME_BUTTONS,
  COMPANION_EQUAD,
  ROCKER_KEYS,
  buildHomeButtonsMapList,
  clearAction,
  dimKeys,
  effectiveAssignment,
  isChanged,
  keysChanged,
  readHomeButtons,
  revertKeys,
  saveOutcome,
  setAction,
  setNothing,
} from "./home-buttons-model.js";
import {
  confirmDialog,
  escapeHtml,
  iconTile,
  openSheet,
  sectionLabel,
  setAppBar,
  snackbar,
  spinner,
} from "../ui/shell.js";
import { buttonPickerSheet, showCurrentRow } from "./button-picker.js";
import { sortPickerDevices } from "./remote-model.js";
import { saveMapList } from "./map-save.js";
import { hasRemoteMaps } from "./touch-model.js";

const HINT = "+ and − adjust the light or plug button you pressed last when it has + / − actions; otherwise they do what “+ and −” says. Light and plug buttons fire once per press and don't repeat while held. A long press fires after you hold the button for about 0.7 seconds.";

const BADGES = { global: "Global", override: "Override", nothing: "Nothing" };
const SOURCES = { global: "global setting", override: "this activity" };

const ACTIVITIES_CHIP = "activities";
const SEQUENCES_CHIP = "sequences";

/* What each tab of a button's sheet sets: a key and its press or long press. */
function lightTabs(key, label) {
  const { up, down } = dimKeys(key);
  return [
    { id: "press", label: "Press", key, which: "press" },
    { id: "long", label: "Long press", key, which: "long" },
    { id: "up", label: "+", key: up, which: "press", title: `+ after ${label}` },
    { id: "down", label: "−", key: down, which: "press", title: `− after ${label}` },
  ];
}

const BUTTONS = [
  ...HOME_BUTTONS.map((b) => ({ ...b, tabs: lightTabs(b.key, b.label) })),
  { key: ROCKER_KEYS.up, label: "+", tabs: [{ id: "press", label: "Press", key: ROCKER_KEYS.up, which: "press" }] },
  { key: ROCKER_KEYS.down, label: "−", tabs: [{ id: "press", label: "Press", key: ROCKER_KEYS.down, which: "press" }] },
];

/* Whether two actions do the same thing (a command by its name). */
function sameTarget(current, action) {
  if (current?.kind !== action.kind) return false;
  if (action.kind === "command") return current.deviceId === action.deviceId && current.command === action.command;
  if (action.kind === "activity") return current.activityId === action.activityId;
  return current.sequenceId === action.sequenceId;
}

/* The chip whose list holds the action. */
function chipOf(action) {
  if (action?.kind === "command") return action.deviceId;
  if (action?.kind === "activity") return ACTIVITIES_CHIP;
  if (action?.kind === "sequence") return SEQUENCES_CHIP;
  return "";
}

export function createHomeButtonsView(section) {
  let activityId = "";
  let draft = null;
  let dirty = false;
  let saving = false;
  let blocked = ""; // "error" | "missing"
  let sheet = null;
  let showToken = 0;

  section.innerHTML = `<div class="wiz home-buttons" id="homeButtonsRoot"></div>`;
  const root = section.querySelector("#homeButtonsRoot");

  /* -- labels ------------------------------------------------------------------ */

  const deviceName = (id) => hub.deviceById(id)?.name ?? "Missing device";
  const sequenceName = (action) => action.name || `Sequence ${action.sequenceId}`;

  function actionSummary(action) {
    if (action.kind === "command") return `${deviceName(action.deviceId)} · ${action.command}`;
    if (action.kind === "sequence") return `Runs “${sequenceName(action)}”`;
    return `Starts ${hub.activityName(hub.activityById(action.activityId))}`;
  }

  /* An action in a few words, for the line under a row. */
  function shortSummary(action) {
    if (action.kind === "command") return action.command;
    if (action.kind === "sequence") return sequenceName(action);
    return hub.activityName(hub.activityById(action.activityId));
  }

  function pressAndLong({ press, long }) {
    return `${actionSummary(press)}${long ? ` · long press: ${shortSummary(long)}` : ""}`;
  }

  /* The sheet's "Now:" line for one key: what it does and where that comes from. */
  function nowLine(key, title) {
    const assignment = effectiveAssignment(draft, key);
    const from = activityId && SOURCES[assignment.source] ? ` (${SOURCES[assignment.source]})` : "";
    const lead = title ? `${title}:` : "Now:";
    if (assignment.source === "nothing") return `${lead} nothing in this activity.`;
    if (assignment.source === "other") return `${lead} set up elsewhere, kept as it is.`;
    if (assignment.press) return `${lead} ${pressAndLong(assignment)}${from}`;
    if (title) return `${lead} not set, so ${title[0]} does what “${title[0]}” says.`;
    return "Not set yet.";
  }

  function globalSummary(key) {
    const entry = draft.globalEntries[key];
    if (entry?.state === "set") return pressAndLong(entry);
    if (entry?.state === "nothing") return "does nothing";
    if (entry) return "set up elsewhere";
    return "not set";
  }

  /* -- drawing ----------------------------------------------------------------- */

  function updateBar() {
    if (section.hidden) return;
    setAppBar({ title: "Home control buttons", back: "remotes", close: dirty, onBack: requestClose });
  }

  /* `others`: the button has other actions, so an empty press says which part is unset. */
  function pressMarkup(assignment, others) {
    if (assignment.source === "nothing") return `<span>${activityId ? "Nothing in this activity" : "Does nothing"}</span>`;
    if (assignment.source === "other") return "<span>Set up elsewhere · kept as it is</span>";
    const { press } = assignment;
    if (!press) return `<span>${others ? "Press: not set" : "Not set"}</span>`;
    if (press.kind !== "command") return `<span>${escapeHtml(actionSummary(press))}</span>`;
    return `<span class="wiz-key-line"><span class="wiz-key-device">${escapeHtml(deviceName(press.deviceId))}</span><span class="wiz-key-cmd">&nbsp;· ${escapeHtml(press.command)}</span></span>`;
  }

  /* The button's + / − that have an action: "+: CenterUp". */
  function dimParts(button) {
    return button.tabs
      .filter((t) => t.title)
      .map((t) => ({ label: t.label, press: effectiveAssignment(draft, t.key).press }))
      .filter((dim) => dim.press)
      .map((dim) => `${dim.label}: ${shortSummary(dim.press)}`);
  }

  /* Under the press: the long press and the button's + / −. */
  function extrasLine(assignment, dims) {
    const parts = [...(assignment.long ? [`Long press: ${shortSummary(assignment.long)}`] : []), ...dims];
    return parts.length ? `<span class="wiz-key-hold">${escapeHtml(parts.join(" · "))}</span>` : "";
  }

  /* The badge covers the press and the button's + / −: an override anywhere wins, then nothing, then global. */
  function badgeSource(button) {
    const sources = new Set(button.tabs.filter((t) => t.which === "press").map((t) => effectiveAssignment(draft, t.key).source));
    return ["override", "nothing", "global"].find((source) => sources.has(source));
  }

  function buttonRow(button) {
    const assignment = effectiveAssignment(draft, button.key);
    const dims = dimParts(button);
    // Grey only when the button does nothing at all, + / − included.
    const unset = assignment.source === "unset" && !dims.length;
    const source = activityId && badgeSource(button);
    const badge = source ? `<span class="badge">${BADGES[source]}</span>` : "";
    const inner = `<span class="wiz-key-name">${escapeHtml(button.label)}</span>
        <span class="wiz-key-value${unset ? " is-unset" : ""}">${pressMarkup(assignment, dims.length > 0)}${extrasLine(assignment, dims)}</span>
        ${badge}`;
    // A key set up in a way this page doesn't change is only shown.
    return draft.entries[button.key]?.state === "other"
      ? `<div class="m-row wiz-key">${inner}</div>`
      : `<button type="button" class="m-row wiz-key" data-key="${escapeHtml(button.key)}" aria-haspopup="dialog">${inner}</button>`;
  }

  function bodyMarkup() {
    const name = activityId ? hub.activityName(hub.activityById(activityId)) : "Harmony Companion";
    const about = activityId
      ? "What the Harmony Companion's light, plug and + / − buttons do while this activity runs. Changes here only apply to this activity. A button you don't change follows the global setting; one you change replaces it, long press included."
      : "What the Harmony Companion's light, plug and + / − buttons do. Change a button for one activity: Remotes → Home control buttons → the activity.";
    const intro = `<div class="wiz-intro"><h2 tabindex="-1">${escapeHtml(name)}</h2><p>${escapeHtml(about)}</p></div>`;
    if (!hasRemoteMaps(hub.state.config, COMPANION_EQUAD) || !draft.canEdit) {
      return `${intro}<div class="m-empty">
          ${iconTile("info_outlined", { size: 64 })}
          <h2 class="m-empty-title">No Harmony Companion on this hub</h2>
          <p class="m-empty-body">Home control buttons need a Harmony Companion remote that has synced with this hub at least once.</p>
        </div>`;
    }
    const lights = BUTTONS.filter((b) => b.tabs.length > 1);
    const rocker = BUTTONS.filter((b) => b.tabs.length === 1);
    return `${intro}
      ${sectionLabel("Light and plug buttons")}
      <div class="m-list">${lights.map(buttonRow).join("")}</div>
      ${sectionLabel("+ and −")}
      <div class="m-list">${rocker.map(buttonRow).join("")}</div>
      <p class="wiz-hint">${escapeHtml(HINT)}</p>
      ${dirty ? `<p class="wiz-hint">Nothing reaches the hub until you save.</p>` : ""}`;
  }

  function footMarkup() {
    if (!hasRemoteMaps(hub.state.config, COMPANION_EQUAD) || !draft.canEdit) return "";
    return `<div class="wiz-foot">
        <button type="button" class="btn btn-outlined" data-act="undo"${dirty && !saving ? "" : " disabled"}>Undo changes</button>
        <button type="button" class="btn btn-filled${saving ? " is-busy" : ""}" data-act="save"${dirty && !saving ? "" : " disabled"}${saving ? ' aria-busy="true"' : ""}>
          ${saving ? `${spinner()}Saving to hub…` : "Save to hub"}
        </button>
      </div>`;
  }

  function render() {
    updateBar();
    if (blocked || !draft) return;
    const focused = document.activeElement;
    const keep = root.contains(focused)
      ? (focused.dataset.key ? `[data-key="${CSS.escape(focused.dataset.key)}"]` : focused.dataset.act ? `[data-act="${focused.dataset.act}"]` : "")
      : "";
    root.innerHTML = `<div class="wiz-body">${bodyMarkup()}</div>${footMarkup()}`;
    if (keep) root.querySelector(keep)?.focus({ preventScroll: true });
  }

  function renderBlocked(kind) {
    blocked = kind;
    updateBar();
    root.innerHTML = kind === "missing"
      ? `<div class="m-empty">
          ${iconTile("info_outlined", { size: 64 })}
          <h2 class="m-empty-title">This activity isn't on the hub any more</h2>
          <p class="m-empty-body">It may have been deleted from another screen.</p>
          <a class="btn btn-filled" href="#remotes">Back to remotes</a>
        </div>`
      : `<div class="m-empty">
          ${iconTile("wifi_off", { size: 64, tone: "error" })}
          <h2 class="m-empty-title">Can't reach your hub</h2>
          <p class="m-empty-body">${escapeHtml(hub.state.configError?.message || "The hub didn't answer.")}</p>
          <button type="button" class="btn btn-filled" data-act="retry">Try again</button>
        </div>`;
  }

  /* -- edits ------------------------------------------------------------------- */

  function edit(change) {
    try {
      draft = change(draft);
    } catch (error) {
      snackbar(error.message, { error: true });
      return;
    }
    dirty = isChanged(hub.state.config, draft);
  }

  function closeSheet() {
    sheet?.close();
    sheet = null;
  }

  /* The lists a sheet offers: each device with commands, the activities,
     and the scope's sequences when it has any besides "Nothing". */
  function sheetChips() {
    // Home Assistant devices first: home buttons mostly drive Home Assistant.
    const devices = sortPickerDevices(hub.devices().filter((d) => d.commands.length), []);
    return [
      ...devices.map((d) => ({ id: d.id, label: d.name })),
      { id: ACTIVITIES_CHIP, label: "Activities" },
      ...(draft.sequences.length ? [{ id: SEQUENCES_CHIP, label: "Sequences" }] : []),
    ];
  }

  /* The rows of one list, each setting `slot` (a key's press or long press). */
  function slotRows(slot, chip) {
    const own = draft.entries[slot.key];
    const current = own?.state === "set" ? own[slot.which] : null;
    const row = (label, action) => ({
      label,
      current: sameTarget(current, action),
      pick: () => edit((d) => setAction(d, slot.key, slot.which, action)),
    });
    if (chip === ACTIVITIES_CHIP) {
      return hub.activities().map((a) => row(hub.activityName(a), { kind: "activity", activityId: String(a["Id-"]) }));
    }
    if (chip === SEQUENCES_CHIP) {
      return draft.sequences.map((s) => row(sequenceName(s), { kind: "sequence", ...s }));
    }
    const device = hub.deviceById(chip);
    return (device?.commands ?? []).map((c) => row(c.name, {
      kind: "command",
      deviceId: device.id,
      command: c.name,
      functionId: c.functionId ?? 0,
    }));
  }

  /* In an activity, a press can also follow the global button or do nothing. */
  function scopeRows(slot) {
    if (!activityId || slot.which !== "press") return [];
    const own = draft.entries[slot.key];
    return [
      {
        label: `Same as global: ${globalSummary(slot.key)}`,
        current: !own,
        pick: () => edit((d) => clearAction(d, slot.key, "press")),
      },
      {
        label: "Nothing in this activity",
        current: own?.state === "nothing",
        pick: () => edit((d) => setNothing(d, slot.key)),
      },
    ];
  }

  /* A tab's "no action" row: the long press, or a global press, + or −. The press takes its long press with it. */
  function noneRows(slot) {
    const effective = effectiveAssignment(draft, slot.key);
    if (slot.which === "long") {
      return [{ label: "No long press", current: !effective.long, pick: () => edit((d) => withoutLong(d, slot.key)) }];
    }
    if (activityId) return [];
    const label = slot.title ? `No ${slot.label} action` : "No press";
    return [{ label, current: !effective.press, pick: () => edit((d) => clearAction(d, slot.key, "press")) }];
  }

  /* An activity following a global long press keeps the global press and drops the long one. */
  function withoutLong(d, key) {
    if (d.entries[key]?.state === "set") return clearAction(d, key, "long");
    const { press, long } = effectiveAssignment(d, key);
    return long ? setAction(d, key, "press", press) : d;
  }

  /* Done keeps the sheet's changes; any other close puts the draft back. */
  function openButtonSheet(button) {
    closeSheet();
    const slotOf = (tab) => button.tabs.find((t) => t.id === tab);
    const keys = [...new Set(button.tabs.map((t) => t.key))];
    const chips = sheetChips();
    const before = { draft, dirty };
    let done = false;
    const opened = openSheet({
      ...buttonPickerSheet({
        label: button.label,
        tabs: button.tabs,
        tabsLabel: "When the button is",
        chips,
        // Short enough for a 360 px phone.
        searchLabel: "Search all devices & activities",
        now: (tab) => nowLine(slotOf(tab).key, slotOf(tab).title),
        tabEnabled: (tab) => {
          const slot = slotOf(tab);
          if (draft.entries[slot.key]?.state === "other") return false;
          return slot.which !== "long" || Boolean(effectiveAssignment(draft, slot.key).press);
        },
        canClear: () => keys.some((key) => draft.entries[key] && draft.entries[key].state !== "other"),
        canUndo: () => keysChanged(hub.state.config, draft, keys),
        startChip: (tab) => {
          const want = chipOf(effectiveAssignment(draft, slotOf(tab).key)[slotOf(tab).which])
            || chipOf(effectiveAssignment(draft, button.key).press);
          return chips.some((c) => c.id === want) ? want : chips[0].id;
        },
        rows: (tab, chip) => slotRows(slotOf(tab), chip),
        extraRows: (tab) => [...noneRows(slotOf(tab)), ...scopeRows(slotOf(tab))],
        // Clear empties the whole button: press, long press, + and −.
        onClear: () => edit((d) => keys
          .filter((key) => d.entries[key] && d.entries[key].state !== "other")
          .reduce((next, key) => clearAction(next, key, "press"), d)),
        onUndo: () => edit((d) => revertKeys(hub.state.config, d, keys)),
        onDone: () => {
          done = true;
        },
      }),
      className: "pick-sheet",
      // close fires asynchronously: only this sheet's close restores the draft and focus.
      onClose: () => {
        if (sheet !== opened) return;
        if (!done) ({ draft, dirty } = before);
        render();
        sheet = null;
        root.querySelector(`[data-key="${CSS.escape(button.key)}"]`)?.focus();
      },
    });
    sheet = opened;
    showCurrentRow(opened.content);
  }

  /* -- saving ------------------------------------------------------------------ */

  async function save() {
    if (saving || !dirty) return;
    let mapList;
    try {
      mapList = buildHomeButtonsMapList(hub.state.config, draft);
    } catch (error) {
      snackbar(`Not saved — ${error.message}`, { error: true });
      return;
    }
    const sent = draft;
    saving = true;
    render();
    const result = await saveMapList(mapList, {
      done: "Saved. The remote's buttons work this way now.",
      check: (config) => saveOutcome(config, sent),
    });
    saving = false;
    if (result !== "kept") {
      dirty = false;
      draft = readHomeButtons(hub.state.config, activityId);
    }
    if (!section.hidden) render();
  }


  function undo() {
    draft = readHomeButtons(hub.state.config, activityId);
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
    if (await confirmDiscard()) location.hash = "#remotes";
  }

  /* -- events ------------------------------------------------------------------- */

  root.addEventListener("click", (event) => {
    if (saving) return;
    const row = event.target.closest("[data-key]");
    if (row) {
      openButtonSheet(BUTTONS.find((b) => b.key === row.dataset.key));
      return;
    }
    const act = event.target.closest("[data-act]")?.dataset.act;
    if (act === "save") save();
    else if (act === "undo") undo();
    else if (act === "retry") hub.reloadConfig().then(() => view.onShow({ args: activityId ? [activityId] : [] }));
  });

  window.addEventListener("beforeunload", (event) => {
    if (!dirty || section.hidden) return;
    event.preventDefault();
    event.returnValue = "";
  });

  const view = {
    async onShow({ args = [] } = {}) {
      const token = (showToken += 1);
      closeSheet();
      draft = null;
      dirty = false;
      saving = false;
      blocked = "";
      try {
        activityId = decodeURIComponent(args[0] ?? "");
      } catch (_) {
        activityId = "-"; // a malformed escape is just an unknown activity
      }
      root.innerHTML = `<div class="m-center">${spinner("Loading")}</div>`;
      updateBar();
      await hub.ensureConfig();
      if (token !== showToken || section.hidden) return;
      if (hub.state.configError) {
        renderBlocked("error");
        return;
      }
      if (activityId && !hub.activityById(activityId)) {
        renderBlocked("missing");
        return;
      }
      draft = readHomeButtons(hub.state.config, activityId);
      render();
      root.querySelector(".wiz-intro h2")?.focus({ preventScroll: true });
    },
    onHide() {
      showToken += 1;
      closeSheet();
    },
    confirmLeave: confirmDiscard,
  };
  return view;
}
