/* Activity setup (#wizard, #wizard/<id>, #wizard/<id>/buttons): the app's
   ActivityEditor. Name and kind, which device does each job, inputs, what
   the remote's buttons do, then a review (web-only) and save. Writes genuine
   graph resources through wizard-model; the advanced editor (#editor) covers
   the fields the wizard doesn't show. */

import * as hub from "../state.js";
import {
  ACTIVITY_TYPES,
  BUTTON_SOURCE,
  ROLE_TYPES,
  defaultPowerDelay,
  draftButtonsFromMap,
  inputOptions,
  mappingSourceLabel,
  preferredDeviceForButtonKey,
  reconcileWizardButtons,
  saveDraft,
} from "../wizard-model.js";
import {
  confirmDialog,
  escapeHtml,
  icon,
  iconTile,
  listRow,
  openSheet,
  sectionLabel,
  setAppBar,
  snackbar,
  spinner,
} from "../ui/shell.js";
import { REMOTE_BUTTONS, commandKey } from "../remote-layout.js";
import {
  KEY_LABELS,
  canonicalKey,
  deviceIconName,
  isHaDevice,
  isOneShotCommand,
  roleLabel,
  sortPickerDevices,
} from "./remote-model.js";

const STEPS = [
  { label: "Name", next: "Next: devices" },
  { label: "Devices", next: "Next: inputs" },
  { label: "Inputs", next: "Next: buttons" },
  { label: "Buttons", next: "Next: review" },
  { label: "Review", next: "Save activity" },
];
const BUTTONS_STEP = 3;

/* The keys the wizard maps, grouped the way people think about a remote
   (the app's BUTTON_GROUPS). PrevChannel is the remote's Back key. */
const BUTTON_GROUPS = [
  ["Volume & channel", ["VolumeUp", "VolumeDown", "VolumeMute", "ChannelUp", "ChannelDown"]],
  ["Navigation", ["DirectionUp", "DirectionDown", "DirectionLeft", "DirectionRight", "Select", "PrevChannel", "Menu", "Exit", "Guide", "Info", "Dvr"]],
  ["Playback", ["Play", "Pause", "Rewind", "FastForward", "Stop", "Record"]],
  ["Colour keys", ["Red", "Green", "Yellow", "Blue"]],
  ["Numbers", ["Number1", "Number2", "Number3", "Number4", "Number5", "Number6", "Number7", "Number8", "Number9", "Number0"]],
];
const ALL_KEYS = BUTTON_GROUPS.flatMap(([, keys]) => keys);

/* The wait after a device turns on steps by half a second, up to 30 s. */
const DELAY_STEP = 500;
const DELAY_MAX = 30000;

const JOB_RANK = new Map(ROLE_TYPES.map((t, i) => [t.type, i]));

/* Back's aliases include "previous", which also matches "PreviousTrack": the
   wizard only suggests a command named exactly Back, Return or Previous. */
const BACK_NAMES = new Set(REMOTE_BUTTONS.find((b) => b.label === "Back").aliases.split("|").map(commandKey));

function emptyDraft() {
  return { name: "", type: 1, roles: [], buttons: {} };
}

/* A new activity starts with the jobs most setups share, as the app does:
   the first TV or projector shows the picture, and the first amplifier,
   receiver or soundbar plays the sound. */
function seededRoles(devices) {
  const first = (pattern) => devices.find((d) => pattern.test(d.typeLabel));
  return [
    ["DisplayActivityRole", first(/television|projector/i)],
    ["VolumeActivityRole", first(/amplifier|receiver|sound|speaker/i)],
  ]
    .filter(([, device]) => device)
    .map(([roleType, device]) => ({ roleType, deviceId: device.id, input: "", powerDelay: defaultPowerDelay(roleType) }));
}

/* Roles in power-on order. Saving numbers the devices by their first role,
   so loading them in the hub's order keeps that order. */
function rolesOf(activity) {
  return (activity.Roles ?? [])
    .map((r, i) => ({ r, i }))
    .sort((a, b) => (Number(a.r.PowerOnOrder) || 0) - (Number(b.r.PowerOnOrder) || 0) || a.i - b.i)
    .map(({ r }) => ({
      deviceId: r["DeviceId-"] == null ? "" : String(r["DeviceId-"]),
      roleType: String(r.__type ?? ""),
      input: r.SelectedInput?.Name ?? "",
      powerDelay: r.NextDevicePowerOnDelay ?? "",
    }));
}

/* Devices in power-on order, each once. A new activity orders by job
   priority (JOB_RANK, §6.3); an existing one keeps the hub's saved order,
   which rolesOf loads as draft order. */
function deviceOrder(roles, byRank = false) {
  const ids = [...new Set(roles.map((r) => r.deviceId).filter(Boolean))];
  if (!byRank) return ids;
  const rankOf = (id) => Math.min(
    ...roles.filter((r) => r.deviceId === id).map((r) => JOB_RANK.get(r.roleType) ?? 99),
  );
  return ids.sort((a, b) => rankOf(a) - rankOf(b) || ids.indexOf(a) - ids.indexOf(b));
}

/* A device's input is shared by all its jobs: the first one set wins. */
function inputIn(roles, deviceId) {
  return roles.find((r) => r.deviceId === deviceId && r.input)?.input ?? "";
}

function seconds(ms) {
  const s = ms / 1000;
  return `${Number.isInteger(s) ? s : s.toFixed(1)} s`;
}

function listNames(names) {
  return names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

function intro(title, text) {
  return `<div class="wiz-intro"><h2 tabindex="-1">${escapeHtml(title)}</h2><p>${escapeHtml(text)}</p></div>`;
}

/* A selector that finds the same control after the step is drawn again. */
function focusKey(el, scope) {
  if (!el || !scope.contains(el)) return "";
  if (el.id) return `#${CSS.escape(el.id)}`;
  return [...el.attributes]
    .filter((a) => a.name.startsWith("data-"))
    .map((a) => `[${a.name}="${CSS.escape(a.value)}"]`)
    .join("");
}

export function createWizardView(section) {
  let step = 0;
  let draft = emptyDraft();
  let editId = "";
  let dirty = false; // something changed since the wizard opened
  let saving = false;
  let snapshot = {}; // the keys as the wizard opened them, for Undo
  let cleared = new Set(); // keys the user cleared: suggestions stay out
  let blocked = ""; // "error" | "missing" when there is nothing to edit
  let sheet = null;
  let showToken = 0;
  let lastArgs = [];

  section.innerHTML = `<div class="wiz" id="wizRoot"></div>`;
  const root = section.querySelector("#wizRoot");

  /* -- draft --------------------------------------------------------------- */

  const devicesById = () => new Map(hub.devices().map((d) => [d.id, d]));
  const deviceLabel = (byId, id) => byId.get(id)?.name ?? "Missing device";
  const delayOf = (deviceId) => Number(draft.roles.find((r) => r.deviceId === deviceId)?.powerDelay) || 0;

  function setForDevice(deviceId, field, value) {
    for (const role of draft.roles) if (role.deviceId === deviceId) role[field] = value;
  }

  function roleDevices() {
    const byId = devicesById();
    return deviceOrder(draft.roles, !editId).map((id) => byId.get(id)).filter(Boolean);
  }

  function sortedJobs() {
    return draft.roles
      .map((role, index) => ({ role, index }))
      .sort((a, b) => (JOB_RANK.get(a.role.roleType) ?? 99) - (JOB_RANK.get(b.role.roleType) ?? 99) || a.index - b.index);
  }

  /* Keys whose device left the hub drop out. Empty keys take the suggestion
     only for new activities; existing activities keep unmapped keys unmapped
     until the owner picks Reset or a per-key default (P06 #7). What people
     set, or the activity already had (including non-member extra controls,
     P13), stays. */
  function syncButtonDefaults() {
    const isNew = !editId;
    draft.buttons = reconcileWizardButtons(draft.buttons, draft.roles, hub.devices(), {
      fillDefaults: isNew,
    });
    for (const key of cleared) delete draft.buttons[key];
    const back = draft.buttons.PrevChannel;
    if (back?.source === BUTTON_SOURCE.default && !BACK_NAMES.has(commandKey(back.command.name))) delete draft.buttons.PrevChannel;
  }

  const changedKeys = () => ALL_KEYS.filter((k) => cleared.has(k) || draft.buttons[k]?.source === BUTTON_SOURCE.user);

  /* Undo puts keys back as the wizard opened them: the activity's own
     mapping, or the suggestion a new activity started with. */
  function undoKeys(keys) {
    for (const key of keys) {
      cleared.delete(key);
      if (snapshot[key]) draft.buttons[key] = structuredClone(snapshot[key]);
      else delete draft.buttons[key];
    }
    syncButtonDefaults();
  }

  function changed() {
    dirty = true;
    render();
  }

  function rolesChanged() {
    syncButtonDefaults();
    changed();
  }

  function assignDevice(roleType, index, deviceId) {
    const prev = index == null ? null : draft.roles[index];
    if (prev?.deviceId === deviceId) return;
    const others = draft.roles.filter((_, i) => i !== index);
    const sibling = others.find((r) => r.deviceId === deviceId);
    // The device's input and power-on wait come along from its other jobs;
    // a device new to the activity starts with the job's default wait (§6.3).
    const role = {
      roleType,
      deviceId,
      input: sibling ? inputIn(others, deviceId) : "",
      powerDelay: sibling ? sibling.powerDelay : defaultPowerDelay(roleType),
    };
    if (prev) draft.roles[index] = role;
    else draft.roles.push(role);
    rolesChanged();
  }

  function removeJob(index) {
    draft.roles.splice(index, 1);
    rolesChanged();
  }

  function changeDelay(deviceId, direction) {
    const ms = delayOf(deviceId);
    const next = direction > 0
      ? Math.min(DELAY_MAX, Math.floor(ms / DELAY_STEP) * DELAY_STEP + DELAY_STEP)
      : Math.max(0, Math.ceil(ms / DELAY_STEP) * DELAY_STEP - DELAY_STEP);
    // 0 is a value the user chose, not "never set": keep it distinct from "".
    setForDevice(deviceId, "powerDelay", next);
    changed();
    // At either end the pressed button turns off; keep focus on the stepper.
    const pressed = root.querySelector(`[data-delay="${CSS.escape(deviceId)}"][data-delay-step="${direction}"]`);
    if (pressed?.disabled) root.querySelector(`[data-delay="${CSS.escape(deviceId)}"][data-delay-step="${-direction}"]`)?.focus();
  }

  function setPress(key, device, command) {
    const prev = draft.buttons[key];
    cleared.delete(key);
    const oneShot = isOneShotCommand(command.name);
    // Auto-default HA toggles to self-long (P11): hold == press prevents
    // double-fire when held >=300ms. Non-toggles keep prior hold unless it
    // was a self-long for a previous one-shot (then clear to standard).
    let hold = prev?.hold ?? null;
    if (oneShot) {
      hold = { deviceId: device.id, command: { name: command.name, functionId: command.functionId } };
    } else if (prev?.hold && prev?.command && prev.hold.deviceId === prev.deviceId
        && prev.hold.command?.name === prev.command?.name) {
      hold = null;
    }
    draft.buttons[key] = {
      deviceId: device.id,
      command: { name: command.name, functionId: command.functionId },
      hold,
      // A double-press action has no control here; it rides along untouched.
      doublePress: prev?.doublePress ?? null,
      source: BUTTON_SOURCE.user,
      extra: !draft.roles.some((r) => String(r.deviceId) === String(device.id)),
    };
  }

  function setHold(key, device, command) {
    const prev = draft.buttons[key];
    if (!prev) return;
    draft.buttons[key] = {
      ...prev,
      hold: command ? { deviceId: device.id, command: { name: command.name, functionId: command.functionId } } : null,
      source: BUTTON_SOURCE.user,
    };
  }

  function setPressMode(key, mode) {
    const prev = draft.buttons[key];
    if (!prev?.command) return;
    if (mode === "standard") {
      draft.buttons[key] = { ...prev, hold: null, source: BUTTON_SOURCE.user };
    } else if (mode === "oneShot") {
      draft.buttons[key] = {
        ...prev,
        hold: { deviceId: prev.deviceId, command: { ...prev.command } },
        source: BUTTON_SOURCE.user,
      };
    }
    // Custom mode is set by picking a distinct Hold command in the Hold tab.
  }

  function isExtraKey(key) {
    const m = draft.buttons[key];
    if (!m?.deviceId) return false;
    return !draft.roles.some((r) => String(r.deviceId) === String(m.deviceId));
  }

  function pressModeLabel(key) {
    const m = draft.buttons[key];
    if (!m?.command?.name) return "";
    if (!m.hold?.command?.name) return "Standard";
    if (String(m.hold.deviceId) === String(m.deviceId) && String(m.hold.command?.name) === String(m.command?.name)) {
      return "One-shot";
    }
    return `Hold: ${m.hold.command.name}`;
  }

  function draftFrom(activity) {
    const next = emptyDraft();
    next.name = hub.activityName(activity);
    next.type = Number(activity.Type ?? 1);
    next.roles = rolesOf(activity);
    const maps = hub.buttonMapsForActivity(String(activity["Id-"]));
    const surface = maps.find((m) => /^16414Activity/.test(String(m?.ButtonMapIdentifier ?? ""))) ?? maps[0];
    // Real maps write some keys in either case ("DVR", "Dvr"): file them under
    // the wizard's name, so the row shows them and saving writes one entry.
    for (const [key, mapping] of Object.entries(draftButtonsFromMap(surface))) {
      const name = canonicalKey(key) ?? key;
      if (!next.buttons[name]) next.buttons[name] = mapping;
    }
    return next;
  }

  /* -- steps ------------------------------------------------------------------ */

  function canAdvance(at = step) {
    if (at === 0) return Boolean(draft.name.trim());
    if (at === 1) return draft.roles.some((r) => r.deviceId);
    return true;
  }

  function reachable(target) {
    for (let i = 0; i < target; i += 1) if (!canAdvance(i)) return false;
    return true;
  }

  /* Opened on a later step (Set up buttons), an earlier one can still be
     missing something: say which, since Next stays off until it's done. */
  function missingHint() {
    if (step < 2 || reachable(step)) return "";
    const at = [0, 1].find((i) => !canAdvance(i));
    const what = at === 0 ? "give the activity a name" : "pick a device for at least one job";
    return `<p class="wiz-hint">Go back to ${STEPS[at].label} and ${what} to save this activity.</p>`;
  }

  function progressMarkup() {
    return `<nav class="wiz-progress" aria-label="Steps">${STEPS.map((s, i) => `<button type="button"
        class="wiz-seg${i <= step ? " is-done" : ""}" data-go="${i}" aria-label="Step ${i + 1}: ${s.label}"${i === step ? ' aria-current="step"' : ""}${reachable(i) ? "" : " disabled"}></button>`).join("")}</nav>`;
  }

  function nameStep() {
    return `${intro("What's this activity called?", "Pick a short name you'd say out loud, like “Watch TV” or “Xbox”.")}
      <div class="wiz-field">
        <label for="wizName">Name</label>
        <input id="wizName" maxlength="96" autocomplete="off" enterkeyhint="next" value="${escapeHtml(draft.name)}">
      </div>
      <fieldset class="wiz-choices">
        <legend class="wiz-label">What kind of activity is it?</legend>
        ${ACTIVITY_TYPES.map((t) => {
          const on = Number(draft.type) === t.value;
          return `<label class="wiz-choice${on ? " is-selected" : ""}">
              <input type="radio" name="wizKind" data-kind="${t.value}"${on ? " checked" : ""}>
              <span class="wiz-choice-text">${escapeHtml(t.label)}</span>${on ? icon("check") : ""}
            </label>`;
        }).join("")}
      </fieldset>`;
  }

  function powerMarkup(byId) {
    const ids = deviceOrder(draft.roles, !editId);
    if (ids.length < 2) return "";
    return `${sectionLabel("Turning on")}
      <p class="wiz-hint">Devices turn on in this order. Give a slow one time to wake up before the next one turns on.</p>
      <div class="m-list">${ids.map((id, i) => {
        const device = byId.get(id);
        const name = deviceLabel(byId, id);
        const ms = delayOf(id);
        const last = i === ids.length - 1;
        return `<div class="m-row wiz-power">
            <span class="wiz-power-pos" aria-hidden="true">${i + 1}</span>
            ${iconTile(device ? deviceIconName(device) : "tv", { size: 36 })}
            <span class="m-row-text">
              <span class="m-row-title">${escapeHtml(name)}</span>
              <span class="m-row-sub">${last ? "Turns on last" : `Then wait ${seconds(ms)}`}</span>
            </span>
            ${last ? "" : `<span class="wiz-stepper" role="group" aria-label="${escapeHtml(`Wait after ${name}`)}">
                <button type="button" class="icon-btn" data-delay="${escapeHtml(id)}" data-delay-step="-1" aria-label="${escapeHtml(`Wait less after ${name}, now ${seconds(ms)}`)}"${ms > 0 ? "" : " disabled"}>${icon("remove")}</button>
                <button type="button" class="icon-btn" data-delay="${escapeHtml(id)}" data-delay-step="1" aria-label="${escapeHtml(`Wait longer after ${name}, now ${seconds(ms)}`)}"${ms < DELAY_MAX ? "" : " disabled"}>${icon("add")}</button>
              </span>`}
          </div>`;
      }).join("")}</div>`;
  }

  function devicesStep() {
    const byId = devicesById();
    const free = ROLE_TYPES.some((t) => !draft.roles.some((r) => r.roleType === t.type));
    return `${intro("Which device does what?", "We use this to turn the right things on and set up the buttons for you.")}
      <div class="wiz-jobs">
        ${sortedJobs().map(({ role, index }) => {
          const device = byId.get(role.deviceId);
          const name = device ? device.name : role.deviceId ? "Device not on this hub" : "Choose a device";
          return `<button type="button" class="wiz-job" data-job="${index}" aria-haspopup="dialog">
              ${iconTile(device ? deviceIconName(device) : "add", { size: 40 })}
              <span class="wiz-job-text">
                <span class="wiz-job-role">${escapeHtml(roleLabel(role.roleType))}</span>
                <span class="wiz-job-device${device ? "" : " is-missing"}">${escapeHtml(name)}</span>
              </span>
              ${icon("keyboard_arrow_down", { cls: "wiz-job-caret" })}
            </button>`;
        }).join("")}
        ${free ? `<button type="button" class="wiz-add" data-act="add-job" aria-haspopup="dialog">${icon("add")}<span>Add another job</span></button>` : ""}
      </div>
      ${canAdvance(1) ? "" : `<p class="wiz-hint">Pick a device for at least one job to continue.</p>`}
      ${powerMarkup(byId)}`;
  }

  function inputsStep() {
    const byId = devicesById();
    const cards = [];
    const none = [];
    for (const id of deviceOrder(draft.roles, !editId)) {
      const device = byId.get(id);
      if (!device) continue;
      const current = inputIn(draft.roles, id);
      const names = inputOptions(device).map((o) => o.value);
      // An input the device no longer lists still shows, so it can be seen and changed.
      if (current && !names.includes(current)) names.unshift(current);
      if (!names.length) {
        none.push(device.name);
        continue;
      }
      cards.push(`<section class="wiz-card" aria-label="${escapeHtml(device.name)}">
          <div class="wiz-card-head">${iconTile(deviceIconName(device), { size: 36 })}<h3>${escapeHtml(device.name)}</h3></div>
          <div class="wiz-chips" role="group" aria-label="${escapeHtml(`Input for ${device.name}`)}">
            ${["", ...names].map((name) => `<button type="button" class="chip" data-input-device="${escapeHtml(id)}" data-input="${escapeHtml(name)}" aria-pressed="${name === current}">${escapeHtml(name || "Don't switch")}</button>`).join("")}
          </div>
        </section>`);
    }
    const rest = none.length && cards.length
      ? `<p class="wiz-hint">${escapeHtml(listNames(none))} ${none.length === 1 ? "has" : "have"} no inputs set up, so ${none.length === 1 ? "it stays" : "they stay"} on whatever input ${none.length === 1 ? "it's" : "they're"} on.</p>`
      : "";
    return `${intro("Which input should each device use?", "When this activity starts, the hub switches each device to the input you pick here.")}
      ${cards.length ? `<div class="wiz-cards">${cards.join("")}</div>${rest}` : `<p class="wiz-hint">Nothing to set. None of these devices need input switching.</p>`}`;
  }

  function buttonsStep() {
    const byId = devicesById();
    const roleIds = draft.roles.map((r) => String(r.deviceId));
    const mapped = ALL_KEYS.filter((k) => draft.buttons[k]?.command?.name).length;
    const extraCount = ALL_KEYS.filter((k) => {
      const m = draft.buttons[k];
      return m?.command?.name && !roleIds.includes(String(m.deviceId));
    }).length;
    const hint = extraCount
      ? `We filled these in from the devices you picked. Extra controls (${extraCount}) stay powered as they are — the activity never turns them on or off. Tap any button to change what it does. ${mapped} of ${ALL_KEYS.length} set.`
      : `We filled these in from the devices you picked. Tap any button to change what it does. ${mapped} of ${ALL_KEYS.length} set.`;
    return `${intro("Check the buttons", hint)}
      <button type="button" class="btn btn-text wiz-reset" data-act="undo-buttons"${changedKeys().length ? "" : " disabled"}>Undo my changes</button>
      ${BUTTON_GROUPS.map(([group, keys]) => `${sectionLabel(group)}
        <div class="m-list">${keys.map((key) => {
          const m = draft.buttons[key];
          const set = Boolean(m?.command?.name);
          const extra = set && !roleIds.includes(String(m.deviceId));
          const oneShot = set && m.hold?.command?.name
            && String(m.hold.deviceId) === String(m.deviceId)
            && String(m.hold.command?.name) === String(m.command?.name);
          return `<button type="button" class="m-row wiz-key" data-key="${key}" aria-haspopup="dialog">
              <span class="wiz-key-name">${escapeHtml(KEY_LABELS[key])}${extra ? ` <span class="chip" title="Not a member: the activity never turns this device on or off">Extra</span>` : ""}</span>
              <span class="wiz-key-value${set ? "" : " is-unset"}">
                ${set
                  ? `<span class="wiz-key-line"><span class="wiz-key-device">${escapeHtml(deviceLabel(byId, m.deviceId))}${extra ? " · extra control" : ""}</span><span class="wiz-key-cmd">&nbsp;· ${escapeHtml(m.command.name)}</span></span>`
                  : "<span>Not set</span>"}
                ${set && oneShot ? `<span class="wiz-key-hold">One-shot (no hold repeat)</span>` : ""}
                ${set && !oneShot && m.hold?.command?.name ? `<span class="wiz-key-hold">Hold: ${escapeHtml(m.hold.command.name)}</span>` : ""}
              </span>
            </button>`;
        }).join("")}</div>`).join("")}`;
  }

  function reviewStep() {
    const byId = devicesById();
    const name = draft.name.trim();
    const kind = ACTIVITY_TYPES.find((t) => t.value === Number(draft.type))?.label ?? "Activity";
    const jobs = sortedJobs().map(({ role }) => `${roleLabel(role.roleType)}: ${deviceLabel(byId, role.deviceId)}`);
    const order = deviceOrder(draft.roles, !editId);
    const waits = order.slice(0, -1).filter((id) => delayOf(id))
      .map((id) => `waits ${seconds(delayOf(id))} after ${deviceLabel(byId, id)}`);
    const inputs = order.filter((id) => inputIn(draft.roles, id))
      .map((id) => `${deviceLabel(byId, id)} → ${inputIn(draft.roles, id)}`);
    const mapped = ALL_KEYS.filter((k) => draft.buttons[k]?.command?.name).length;
    const changedByYou = changedKeys().length;
    return `${intro(
        editId ? `Save “${name}”?` : "Ready to save?",
        editId
          ? "Saving replaces this activity's name, devices, inputs and buttons on the hub. Everything else about it stays as it is."
          : `“${name}” goes at the end of the remote's list of activities.`,
      )}
      <div class="m-list">
        ${listRow({ title: "Name", subtitle: `${name} · ${kind}`, chevron: true, attrs: 'data-go="0"' })}
        ${listRow({ title: "Devices", subtitle: [...jobs, ...waits].join(" · ") || "None yet", chevron: true, attrs: 'data-go="1"' })}
        ${listRow({ title: "Inputs", subtitle: inputs.join(" · ") || "No input switching", chevron: true, attrs: 'data-go="2"' })}
        ${listRow({ title: "Buttons", subtitle: `${mapped} of ${ALL_KEYS.length} set${changedByYou ? ` · ${changedByYou} changed by you` : ""}`, chevron: true, attrs: 'data-go="3"' })}
      </div>`;
  }

  function footMarkup() {
    return `<div class="wiz-foot">
        ${step > 0 ? `<button type="button" class="btn btn-outlined" data-act="back"${saving ? " disabled" : ""}>Back</button>` : ""}
        <button type="button" class="btn btn-filled${saving ? " is-busy" : ""}" data-act="next"${canAdvance() && reachable(step) ? "" : " disabled"}${saving ? ' aria-busy="true"' : ""}>
          ${saving ? `${spinner()}Saving to hub…` : STEPS[step].next}
        </button>
      </div>`;
  }

  /* -- drawing ------------------------------------------------------------------ */

  function updateBar() {
    if (section.hidden) return;
    setAppBar({
      title: editId ? `Edit “${draft.name.trim() || "activity"}”` : "New activity",
      back: "activities",
      close: true,
      onBack: requestClose,
      actions: blocked ? "" : `<span class="appbar-note">Step ${step + 1} of ${STEPS.length}</span>`,
    });
  }

  function render() {
    updateBar();
    if (blocked) return;
    const keep = focusKey(document.activeElement, root);
    const body = [nameStep, devicesStep, inputsStep, buttonsStep, reviewStep][step]();
    root.innerHTML = `${progressMarkup()}<div class="wiz-body">${body}${missingHint()}</div>${footMarkup()}`;
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
          <a class="btn btn-filled" href="#activities">Back to activities</a>
        </div>`
      : `<div class="m-empty">
          ${iconTile("wifi_off", { size: 64, tone: "error" })}
          <h2 class="m-empty-title">Can't reach your hub</h2>
          <p class="m-empty-body">${escapeHtml(hub.state.configError?.message || "The hub didn't answer.")}</p>
          <button type="button" class="btn btn-filled" data-act="retry">Try again</button>
        </div>`;
  }

  function go(target) {
    const next = Math.max(0, Math.min(STEPS.length - 1, target));
    if (next === step || !reachable(next)) return;
    if (next === BUTTONS_STEP) syncButtonDefaults();
    step = next;
    render();
    window.scrollTo(0, 0);
    root.querySelector(".wiz-intro h2")?.focus({ preventScroll: true });
  }

  function next() {
    if (saving || !canAdvance() || !reachable(step)) return;
    if (step < STEPS.length - 1) go(step + 1);
    else save();
  }

  async function save() {
    saving = true;
    render();
    try {
      const outcome = await saveDraft({
        config: hub.state.config,
        revision: hub.state.config?.revision,
        // A job must have a device; a broken one from old data is left out.
        draft: { ...draft, roles: draft.roles.filter((r) => r.deviceId) },
        editId: editId || null,
      });
      dirty = false;
      await hub.reloadConfig();
      snackbar(`Saved “${outcome.name}”`);
      if (!section.hidden) location.hash = "#activities";
    } catch (error) {
      // A refused save usually means the setup changed elsewhere: reload it,
      // so trying again saves onto the latest copy.
      await hub.reloadConfig();
      snackbar(`Couldn't save — ${error.message || "hub error"}. The latest setup is reloaded; try again.`, { error: true });
    } finally {
      saving = false;
      if (!section.hidden) render();
    }
  }

  /* Asked by the close button and by the router, so the browser's Back and
     the navigation rail can't drop changes silently either. */
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
    if (saving) return;
    if (await confirmDiscard()) location.hash = "#activities";
  }

  /* -- sheets --------------------------------------------------------------------- */

  function closeSheet() {
    sheet?.close();
    sheet = null;
  }

  /* close fires asynchronously: forget only this sheet, and only put focus
     back when no other sheet has opened in the meantime. */
  function trackSheet(options, focusSelector) {
    const opened = openSheet({
      ...options,
      onClose: () => {
        if (sheet === opened) sheet = null;
        if (!sheet) root.querySelector(focusSelector())?.focus();
      },
    });
    sheet = opened;
    return opened;
  }

  function openJobPicker() {
    closeSheet();
    const free = ROLE_TYPES.filter((t) => !draft.roles.some((r) => r.roleType === t.type));
    trackSheet({
      label: "Add a job",
      render: (content, close) => {
        content.innerHTML = `<h2 class="sheet-title">What should it do?</h2>
          <div class="sheet-rows">${free.map((t) => `<button type="button" class="sheet-row" data-pick-job="${t.type}">
              <span class="sheet-row-text"><span class="sheet-row-title">${escapeHtml(roleLabel(t.type))}</span><span class="sheet-row-sub">${escapeHtml(t.hint)}</span></span>
            </button>`).join("")}</div>`;
        content.addEventListener("click", (event) => {
          const row = event.target.closest("[data-pick-job]");
          if (!row) return;
          close();
          openDevicePicker(row.dataset.pickJob, null);
        });
      },
    }, () => '[data-act="add-job"]');
  }

  function openDevicePicker(roleType, index) {
    closeSheet();
    const current = index == null ? null : draft.roles[index];
    const devices = hub.devices();
    trackSheet({
      label: roleLabel(roleType),
      render: (content, close) => {
        content.innerHTML = `<h2 class="sheet-title">${escapeHtml(roleLabel(roleType))}</h2>
          ${devices.length ? "" : `<p class="sheet-text">There are no devices on this hub yet. Add one in Devices first.</p>`}
          <div class="sheet-rows">
            ${devices.map((d) => {
              const on = current?.deviceId === d.id;
              const sub = [d.manufacturer, d.model].filter(Boolean).join(" ");
              return `<button type="button" class="sheet-row${on ? " is-selected" : ""}" data-pick-device="${escapeHtml(d.id)}">
                  ${iconTile(deviceIconName(d), { size: 40 })}
                  <span class="sheet-row-text"><span class="sheet-row-title">${escapeHtml(d.name)}</span>${sub ? `<span class="sheet-row-sub">${escapeHtml(sub)}</span>` : ""}</span>
                  ${on ? icon("check", { cls: "sheet-row-check", label: "Selected" }) : ""}
                </button>`;
            }).join("")}
            ${current ? `<button type="button" class="sheet-row is-destructive" data-pick-remove><span class="sheet-row-title">Not used in this activity</span></button>` : ""}
          </div>`;
        content.addEventListener("click", (event) => {
          const row = event.target.closest("[data-pick-device]");
          if (row) {
            close();
            assignDevice(roleType, index, row.dataset.pickDevice);
          } else if (event.target.closest("[data-pick-remove]")) {
            close();
            removeJob(index);
          }
        });
      },
    }, () => {
      const at = draft.roles.findIndex((r) => r.roleType === roleType);
      return at >= 0 ? `[data-job="${at}"]` : '[data-act="add-job"]';
    });
  }

  /* One key: Press and Hold tabs, any device (members first, HA grouped),
     then that device's commands. Toggles default to one-shot self-long (P11).
     Picking a command sets it and closes the sheet. */
  function openKeySheet(key) {
    closeSheet();
    const roleIds = draft.roles.map((r) => String(r.deviceId));
    const allDevices = sortPickerDevices(hub.devices(), roleIds);
    const devices = allDevices.length ? allDevices : [];
    const label = KEY_LABELS[key];
    const mapping = () => draft.buttons[key] ?? null;
    let tab = "press";
    let query = "";
    const startDevice = () => {
      const m = mapping();
      const want = tab === "hold"
        ? m?.hold?.deviceId || m?.deviceId
        : m?.deviceId || preferredDeviceForButtonKey(key, draft.roles);
      if (devices.some((d) => d.id === want)) return want;
      // Prefer a member device, else the first HA, else the first device.
      return devices[0]?.id ?? "";
    };
    let deviceId = startDevice();

    const opened = trackSheet({
      label: `${label} button`,
      className: "pick-sheet",
      render: (content, close) => {
        content.innerHTML = `<div class="pick-top">
            <div class="pick-head">
              <h2 class="sheet-title" tabindex="-1" autofocus>“${escapeHtml(label)}” button</h2>
              <span data-pick-clear></span>
            </div>
            <p class="pick-now" data-pick-now></p>
            <div class="m-chips" role="group" aria-label="Press behaviour" data-pick-mode></div>
            <p class="wiz-hint" data-pick-hint></p>
            <div class="seg-tabs" role="tablist" aria-label="When the key is">
              <button type="button" role="tab" class="seg-tab" data-pick-tab="press">Press</button>
              <button type="button" role="tab" class="seg-tab" data-pick-tab="hold">Hold</button>
            </div>
            <div class="pick-chips" role="group" aria-label="Device" data-pick-chips></div>
            <label class="search-field">${icon("search", { size: 22 })}<input type="search" data-pick-search placeholder="Search commands" aria-label="Search commands" autocomplete="off"></label>
          </div>
          <div class="pick-list" data-pick-list></div>
          <div class="pick-foot" data-pick-foot></div>`;
        const $ = (selector) => content.querySelector(selector);

        function pressMode() {
          const m = mapping();
          if (!m?.command?.name) return "unset";
          if (!m.hold?.command?.name) return "standard";
          if (String(m.hold.deviceId) === String(m.deviceId) && String(m.hold.command?.name) === String(m.command?.name)) return "oneShot";
          return "custom";
        }

        function drawTop() {
          const m = mapping();
          const byId = devicesById();
          $("[data-pick-clear]").innerHTML = m ? `<button type="button" class="btn btn-text is-destructive" data-pick="clear">Clear</button>` : "";
          const extra = m && !roleIds.includes(String(m.deviceId)) ? " · Extra control (not powered by activity)" : "";
          $("[data-pick-now]").textContent = m?.command?.name
            ? `Now: ${deviceLabel(byId, m.deviceId)} · ${m.command.name}${m.hold?.command?.name ? ` · hold: ${m.hold.command.name}` : ""} (${mappingSourceLabel(m.source)}${extra ? ", extra" : ""})`
            : "Not set yet.";
          const mode = pressMode();
          $("[data-pick-mode]").innerHTML = m?.command?.name ? [
            ["standard", "Standard (hold repeats)"],
            ["oneShot", "One-shot (no double-toggle)"],
            ["custom", "Hold is different"],
          ].map(([v, t]) => `<button type="button" class="chip" data-pick-modebtn="${v}" aria-pressed="${mode === v}">${t}</button>`).join("") : "";
          const hintEl = $("[data-pick-hint]");
          if (hintEl) {
            if (!m?.command?.name) hintEl.textContent = "";
            else if (isOneShotCommand(m.command.name)) {
              hintEl.textContent = mode === "oneShot"
                ? "One-shot: fires exactly once even when held (self-long). Recommended for toggles."
                : "Warning: this toggle double-fires when held ≥300ms unless One-shot is on.";
            } else {
              hintEl.textContent = mode === "standard"
                ? "Standard: holding ramps (volume/brightness) or repeats harmlessly."
                : "Custom hold: releasing early fires Press, holding fires Hold.";
            }
          }
          content.querySelectorAll("[data-pick-tab]").forEach((b) => {
            b.setAttribute("aria-selected", String(b.dataset.pickTab === tab));
            if (b.dataset.pickTab === "hold") b.disabled = !m;
          });
          $("[data-pick-chips]").innerHTML = devices.map((d) => {
            const isMember = roleIds.includes(String(d.id));
            const ha = !isMember && isHaDevice(d);
            const tag = !isMember ? (ha ? " · HA" : " · extra") : "";
            return `<button type="button" class="chip" data-pick-device="${escapeHtml(d.id)}" aria-pressed="${d.id === deviceId}" title="${isMember ? "Activity member" : "Extra control · not powered by activity"}">${escapeHtml(d.name)}${tag}</button>`;
          }).join("");
          $("[data-pick-foot]").innerHTML = changedKeys().includes(key)
            ? `<button type="button" class="btn btn-text" data-pick="undo">Undo my change</button>`
            : "";
        }

        function drawList() {
          const m = mapping();
          const device = devices.find((d) => d.id === deviceId);
          const q = query.trim().toLowerCase();
          const current = tab === "hold" ? m?.hold : m;
          const check = icon("check", { cls: "pick-check", label: "Current" });
          const rows = (device?.commands ?? [])
            .map((c, i) => ({ c, i }))
            .filter(({ c }) => !q || c.name.toLowerCase().includes(q))
            .map(({ c, i }) => {
              const on = current?.deviceId === deviceId && current?.command?.name === c.name;
              return `<button type="button" class="pick-row${on ? " is-current" : ""}" data-pick-command="${i}"><span>${escapeHtml(c.name)}</span>${on ? check : ""}</button>`;
            });
          const none = tab === "hold" && !q
            ? `<button type="button" class="pick-row${m?.hold ? "" : " is-current"}" data-pick-none><span>No hold action</span>${m?.hold ? "" : check}</button>`
            : "";
          $("[data-pick-list]").innerHTML = !device
            ? `<p class="list-note">Choose the activity's devices first.</p>`
            : rows.length || none
              ? none + rows.join("")
              : `<p class="list-note">Nothing matches “${escapeHtml(query.trim())}”.</p>`;
        }

        // After a new tab or device, show the command in use, else the top.
        function showCurrent() {
          const row = $(".pick-row.is-current");
          if (row) row.scrollIntoView({ block: "center" });
          else content.scrollTop = 0;
        }

        function finish(update) {
          update();
          close();
          changed();
        }

        content.addEventListener("click", (event) => {
          const modeBtn = event.target.closest("[data-pick-modebtn]");
          if (modeBtn) {
            const mode = modeBtn.dataset.pickModebtn;
            finish(() => setPressMode(key, mode));
            return;
          }
          const tabBtn = event.target.closest("[data-pick-tab]");
          if (tabBtn) {
            if (tabBtn.disabled || tabBtn.dataset.pickTab === tab) return;
            tab = tabBtn.dataset.pickTab;
            deviceId = startDevice();
            drawTop();
            drawList();
            showCurrent();
            return;
          }
          const chip = event.target.closest("[data-pick-device]");
          if (chip) {
            deviceId = chip.dataset.pickDevice;
            drawTop();
            drawList();
            showCurrent();
            return;
          }
          const row = event.target.closest("[data-pick-command]");
          if (row) {
            const device = devices.find((d) => d.id === deviceId);
            const command = device?.commands[Number(row.dataset.pickCommand)];
            if (command) finish(() => (tab === "hold" ? setHold(key, device, command) : setPress(key, device, command)));
            return;
          }
          if (event.target.closest("[data-pick-none]")) {
            finish(() => setHold(key, null, null));
            return;
          }
          const act = event.target.closest("[data-pick]")?.dataset.pick;
          if (act === "clear") {
            finish(() => {
              delete draft.buttons[key];
              cleared.add(key);
            });
          } else if (act === "undo") finish(() => undoKeys([key]));
        });

        content.addEventListener("input", (event) => {
          if (!event.target.matches("[data-pick-search]")) return;
          query = event.target.value;
          drawList();
          content.scrollTop = 0;
        });

        drawTop();
        drawList();
      },
    }, () => `[data-key="${key}"]`);
    // Open on the command the key sends now, as the app does.
    opened.content.querySelector(".pick-row.is-current")?.scrollIntoView({ block: "center" });
  }

  /* -- events ---------------------------------------------------------------------- */

  root.addEventListener("click", (event) => {
    if (saving) return;
    const seg = event.target.closest("[data-go]");
    if (seg) {
      go(Number(seg.dataset.go));
      return;
    }
    const job = event.target.closest("[data-job]");
    if (job) {
      const index = Number(job.dataset.job);
      openDevicePicker(draft.roles[index].roleType, index);
      return;
    }
    const chip = event.target.closest("[data-input-device]");
    if (chip) {
      setForDevice(chip.dataset.inputDevice, "input", chip.dataset.input);
      changed();
      return;
    }
    const delay = event.target.closest("[data-delay]");
    if (delay) {
      changeDelay(delay.dataset.delay, Number(delay.dataset.delayStep));
      return;
    }
    const key = event.target.closest("[data-key]");
    if (key) {
      openKeySheet(key.dataset.key);
      return;
    }
    const act = event.target.closest("[data-act]")?.dataset.act;
    if (act === "next") next();
    else if (act === "back") go(step - 1);
    else if (act === "add-job") openJobPicker();
    else if (act === "undo-buttons") {
      undoKeys(changedKeys());
      changed();
    } else if (act === "retry") hub.reloadConfig().then(() => view.onShow({ args: lastArgs }));
  });

  root.addEventListener("input", (event) => {
    if (event.target.id !== "wizName") return;
    draft.name = event.target.value;
    dirty = true;
    // Typing doesn't redraw the step; just follow it in the title and buttons.
    updateBar();
    const nextButton = root.querySelector('[data-act="next"]');
    if (nextButton) nextButton.disabled = !canAdvance() || !reachable(step);
    root.querySelectorAll("[data-go]").forEach((b) => {
      b.disabled = !reachable(Number(b.dataset.go));
    });
  });

  root.addEventListener("change", (event) => {
    const kind = event.target.closest("[data-kind]");
    if (!kind) return;
    draft.type = Number(kind.dataset.kind);
    changed();
  });

  root.addEventListener("keydown", (event) => {
    if (event.target.id === "wizName" && event.key === "Enter") {
      event.preventDefault();
      next();
    }
  });

  window.addEventListener("beforeunload", (event) => {
    if (!dirty || section.hidden) return;
    event.preventDefault();
    event.returnValue = "";
  });

  const view = {
    async onShow({ args = [] } = {}) {
      const token = (showToken += 1);
      lastArgs = args;
      closeSheet();
      step = 0;
      draft = emptyDraft();
      editId = "";
      dirty = false;
      saving = false;
      blocked = "";
      cleared = new Set();
      root.innerHTML = `<div class="m-center">${spinner("Loading")}</div>`;
      updateBar();
      await hub.ensureConfig();
      if (token !== showToken || section.hidden) return;
      if (hub.state.configError) {
        renderBlocked("error");
        return;
      }
      let id = args[0] ?? "";
      try {
        id = decodeURIComponent(id);
      } catch (_) {
        // A malformed escape is just an unknown activity.
      }
      if (id) {
        const activity = hub.activityById(id);
        if (!activity) {
          renderBlocked("missing");
          return;
        }
        editId = id;
        draft = draftFrom(activity);
        if (args[1] === "buttons") step = BUTTONS_STEP;
      } else {
        draft.roles = seededRoles(hub.devices());
      }
      syncButtonDefaults();
      snapshot = structuredClone(draft.buttons);
      render();
      // A new activity starts in the name field, except on touch screens where
      // that would cover the screen with the keyboard.
      const typing = !editId && window.matchMedia?.("(pointer: fine)").matches;
      root.querySelector(typing ? "#wizName" : ".wiz-intro h2")?.focus({ preventScroll: true });
    },
    onHide() {
      showToken += 1;
      closeSheet();
    },
    confirmLeave: confirmDiscard,
  };
  return view;
}
