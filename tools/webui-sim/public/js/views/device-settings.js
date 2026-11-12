/* A device's settings page (#devices/<id>/settings), the app's
   DeviceSettingsScreen: how activities power the device on and off, how it
   switches inputs (web-only), and its command timing. The hub checks the
   settings against the device's commands and the activities, saves its
   device list and reloads its engine (codexactivity CommitDeviceSettings). */

import {
  getAndroidTvStatus,
  getConfig,
  getTvInputPresets,
  getTvInputs,
  saveAndroidTvDevices,
  saveDeviceSettings,
  saveTvInputs,
  tryTvInput,
} from "../api.js";
import * as hub from "../state.js";
import { confirmDialog, escapeHtml, icon, openMenu, sectionLabel, setAppBar, snackbar, spinner } from "../ui/shell.js";
import { openCommandPicker, stepperRow } from "./device-sheets.js";
import {
  INPUT_DELAY_MAX_MS,
  INPUT_TYPES,
  MAX_INPUTS,
  POWER_TYPES,
  SETTINGS_LIMITS,
  commandNames,
  deviceSettingsRequest,
  inputsInUse,
  readDeviceSettings,
  readInputSettings,
  validateDeviceSettings,
} from "./device-settings-model.js";
import { androidTvDeviceSet, androidTvIdOf, isAndroidTvEntry } from "./androidtv-model.js";
import {
  CUSTOM_LINKS,
  MENU_GAP_LIMITS,
  addRow,
  applyPreset,
  parseProfile,
  presetChangesWorkingRows,
  profileText,
  readPresets,
  readTvInputs,
  setMethod,
  setPattern,
  shareEntry,
  targetOptions,
  tvInputProblems,
  writerInputs,
} from "./androidtv-inputs-model.js";
import { openFinderSheet, openLinkSheet, openShareSheet, openTrySheet, tvInputsMarkup } from "./androidtv-inputs.js";

/* The app's steppers. Seconds are stored in ms; any value can be typed. */
const STEPPERS = {
  powerDelay: {
    title: "Warm-up time",
    sub: "How long it needs after turning on before it accepts commands",
    step: 500,
    max: SETTINGS_LIMITS.powerOnDelayMs[1],
    seconds: true,
    less: "Less warm-up time",
    more: "More warm-up time",
  },
  inputDelay: {
    title: "Wait after switching input",
    sub: "How long it needs after an input change",
    step: 500,
    max: INPUT_DELAY_MAX_MS,
    seconds: true,
    less: "Shorter wait after switching input",
    more: "Longer wait after switching input",
  },
  interKey: {
    title: "Delay between commands",
    sub: "Pause between two commands to this device",
    step: 50,
    max: SETTINGS_LIMITS.interKeyDelayMs[1],
    unit: "ms",
    less: "Shorter delay between commands",
    more: "Longer delay between commands",
  },
  interDevice: {
    title: "Delay before this device",
    sub: "Pause when switching to this device from another",
    step: 100,
    max: SETTINGS_LIMITS.interDeviceDelayMs[1],
    unit: "ms",
    less: "Shorter delay before this device",
    more: "Longer delay before this device",
  },
  menuGap: {
    title: "Gap between keys",
    sub: "How long the TV's input menu needs between keys",
    step: 100,
    max: MENU_GAP_LIMITS[1],
    unit: "ms",
    less: "Shorter gap between keys",
    more: "Longer gap between keys",
  },
  repeats: {
    title: "Repeats",
    sub: "Extra times a short press is sent",
    step: 1,
    max: SETTINGS_LIMITS.repeats[1],
    less: "Fewer repeats",
    more: "More repeats",
  },
};

const PICKS = {
  on: { title: "On command", powerFirst: true },
  off: { title: "Off command", powerFirst: true },
  toggle: { title: "Power command", powerFirst: true },
  next: { title: "Next-input command" },
  previous: { title: "Previous-input command", none: "None" },
  afterPowerOn: { title: "Input after power-on", none: "Not set" },
};

export function createDeviceSettings({ root, track }) {
  let deviceId = "";
  let active = false;
  let shown = 0;
  let config = null;
  let names = [];
  let hasPower = true;
  let hasInputs = true;
  let suggested = [];
  let draft = null;
  let initialKey = "";
  let initialInputsKey = "";
  let typed = {}; // stepper text that isn't a number yet
  let saving = false;
  let saveError = "";
  /* A network TV: { id, status, draft, presets, loadError, writerKey, profileKey }.
     Its inputs are edited here and saved to the network TV writer and
     codex_androidtv instead of with the device settings. */
  let tv = null;

  /* -- the draft ---------------------------------------------------------------- */

  function draftFrom(entry) {
    const s = readDeviceSettings(entry);
    const i = readInputSettings(entry);
    hasPower = s.hasPowerFeature;
    hasInputs = i.hasInputFeature;
    suggested = i.suggested;
    return {
      power: { ...s.power },
      interKeyDelayMs: s.interKeyDelayMs,
      interDeviceDelayMs: s.interDeviceDelayMs,
      repeats: s.repeats,
      inputs: {
        type: i.type,
        delayMs: i.delayMs,
        list: i.list.map((r) => ({ name: r.name, command: r.command })),
        next: i.next,
        previous: i.previous,
        afterPowerOn: i.afterPowerOn,
      },
    };
  }

  const VALUES = {
    powerDelay: [() => draft.power.delayMs, (v) => { draft.power.delayMs = v; }],
    inputDelay: [
      () => (tv ? tv.draft.delayMs : draft.inputs.delayMs),
      (v) => { if (tv) tv.draft.delayMs = v; else draft.inputs.delayMs = v; },
    ],
    menuGap: [() => tv?.draft.gapMs, (v) => { if (tv) tv.draft.gapMs = Math.max(MENU_GAP_LIMITS[0], v); }],
    interKey: [() => draft.interKeyDelayMs, (v) => { draft.interKeyDelayMs = v; }],
    interDevice: [() => draft.interDeviceDelayMs, (v) => { draft.interDeviceDelayMs = v; }],
    repeats: [() => draft.repeats, (v) => { draft.repeats = v; }],
  };

  function settingsOf(withInputs) {
    const settings = {
      interKeyDelayMs: draft.interKeyDelayMs,
      interDeviceDelayMs: draft.interDeviceDelayMs,
      repeats: draft.repeats,
      power: { ...draft.power },
    };
    if (withInputs) {
      const i = draft.inputs;
      settings.inputs = {
        type: i.type,
        delayMs: i.delayMs,
        list: i.list.map((r) => ({ name: r.name.trim(), command: r.command })),
        next: i.next,
        previous: i.previous,
        afterPowerOn: i.afterPowerOn,
      };
    }
    return settings;
  }

  /* What the hub would get for the inputs. They are sent only when this
     changes, so saving power alone never rewrites a cloud-made input
     feature. */
  function inputsKey() {
    const i = draft.inputs;
    const cycle = i.type === "cycle";
    return JSON.stringify({
      type: i.type,
      delayMs: i.type === "none" ? null : i.delayMs,
      list: i.type === "none" ? [] : i.list.map((r) => [r.name.trim(), i.type === "discrete" ? r.command || "" : ""]),
      next: cycle ? i.next : "",
      previous: cycle ? i.previous || "" : "",
      afterPowerOn: cycle ? i.afterPowerOn || "" : "",
    });
  }

  /* What the network TV writer gets (names, order, slots, delay) and what
     codex_androidtv gets (the profile). Each is saved only when it changed. */
  function tvWriterKey() {
    return JSON.stringify(writerInputs(tv.draft));
  }

  function tvProfileKey() {
    return profileText(tv.draft);
  }

  function evaluate() {
    if (tv) {
      const settings = settingsOf(false);
      const problems = validateDeviceSettings(settings, names);
      problems.push(...tvInputProblems(tv.draft, { appLinks: tv.status?.connected ? tv.status.appLinks !== false : true }));
      const kept = tv.draft.method === "none" ? [] : tv.draft.rows.map((r) => r.name.trim());
      for (const use of inputsInUse(config, deviceId, kept)) {
        problems.push(`Activity "${use.activity}" switches this TV to ${use.input}; keep that input or change the activity first.`);
      }
      const changed = tvWriterKey() !== tv.writerKey || tvProfileKey() !== tv.profileKey ||
        JSON.stringify(settings) !== initialKey;
      return { settings, problems, changed };
    }
    const inputsChanged = inputsKey() !== initialInputsKey;
    const settings = settingsOf(inputsChanged);
    const problems = validateDeviceSettings(settings, names);
    if (settings.inputs) {
      const kept = settings.inputs.type === "none" ? [] : settings.inputs.list.map((r) => r.name);
      for (const use of inputsInUse(config, deviceId, kept)) {
        problems.push(`Activity "${use.activity}" switches this device to ${use.input}; keep that input or change the activity first.`);
      }
    }
    const changed = inputsChanged || JSON.stringify(settingsOf(false)) !== initialKey;
    return { settings, problems, changed };
  }

  function isDirty() {
    return Boolean(active && draft && evaluate().changed);
  }

  /* -- markup ------------------------------------------------------------------- */

  function stepper(key) {
    const s = STEPPERS[key];
    const value = VALUES[key][0]();
    const valid = Number.isFinite(value);
    return stepperRow({
      key,
      title: s.title,
      sub: s.sub,
      text: key in typed ? typed[key] : valid ? String(s.seconds ? value / 1000 : value) : "",
      value,
      max: s.max,
      unit: s.seconds ? "s" : s.unit ?? "",
      spoken: s.seconds ? " in seconds" : s.unit ? " in milliseconds" : "",
      less: s.less,
      more: s.more,
      decimal: Boolean(s.seconds),
    });
  }

  function radioGroup(name, label, options, value) {
    return `<div class="m-list" role="radiogroup" aria-label="${escapeHtml(label)}">${options.map((o) => `<label class="m-row ds-choice">
        <input type="radio" name="ds-${name}" value="${o.value}" data-focus="${name}-${o.value}" data-radio="${name}"${o.value === value ? " checked" : ""}>
        <span class="ds-choice-text">${escapeHtml(o.label)}</span>
      </label>`).join("")}</div>`;
  }

  function pickRow(key, value) {
    const pick = PICKS[key];
    const empty = pick.none ?? "Choose…";
    return `<button type="button" class="m-row ds-pick" data-focus="pick-${key}" data-pick="${key}" aria-haspopup="dialog">
        <span class="ds-title">${escapeHtml(pick.title)}</span>
        <span class="ds-pick-value${value ? "" : pick.none ? "" : " is-empty"}">${escapeHtml(value || empty)}</span>
        ${icon("keyboard_arrow_down", { cls: "ds-caret" })}
      </button>`;
  }

  function switchRow(key, title, sub, on) {
    return `<label class="m-row ds-switch">
        <span class="m-row-text"><span class="ds-title">${escapeHtml(title)}</span><span class="m-row-sub">${escapeHtml(sub)}</span></span>
        <input type="checkbox" role="switch" class="m-switch" data-focus="${key}" data-switch="${key}"${on ? " checked" : ""}>
      </label>`;
  }

  function inputRow(row, i, count, discrete) {
    return `<div class="ds-input">
        <input class="ds-input-name" data-focus="in-name-${i}" data-input-name="${i}" value="${escapeHtml(row.name)}" placeholder="HDMI 1" maxlength="64" autocomplete="off" aria-label="Input ${i + 1} name">
        ${discrete ? `<button type="button" class="ds-input-cmd" data-focus="in-cmd-${i}" data-input-cmd="${i}" aria-haspopup="dialog" aria-label="${escapeHtml(`Command for input ${i + 1}: ${row.command || "none"}`)}">
            <span>${escapeHtml(row.command || "No command")}</span>${icon("keyboard_arrow_down", { size: 20 })}
          </button>` : ""}
        <button type="button" class="icon-btn" data-focus="in-menu-${i}" data-input-menu="${i}" aria-haspopup="menu" aria-label="More for input ${i + 1} of ${count}">${icon("more_vert")}</button>
      </div>`;
  }

  function inputsMarkup() {
    if (tv) {
      return tvInputsMarkup({
        draft: tv.draft, tv, stepper, maxInputs: MAX_INPUTS,
        inUse: inputsInUse(config, deviceId, []),
      });
    }
    const i = draft.inputs;
    const inUse = inputsInUse(config, deviceId, []);
    const parts = [sectionLabel("Inputs")];
    if (!hasInputs) {
      parts.push(`<p class="ds-hint">Activities can't switch this device's input yet. Choose how it switches inputs and list them.</p>`);
    }
    if (inUse.length) {
      parts.push(`<p class="ds-hint">Used by activities: ${escapeHtml(inUse.map((u) => `${u.input} (${u.activity})`).join(", "))}. Keep these names.</p>`);
    }
    parts.push(radioGroup("inputs", "Input switching", INPUT_TYPES, i.type));
    if (i.type === "none") return parts.join("");
    parts.push(`<div class="m-list">${stepper("inputDelay")}</div>`);
    parts.push(`<h4 class="ds-sub">Inputs, in the device's order</h4>`);
    parts.push(i.list.length
      ? `<div class="m-list ds-inputs">${i.list.map((row, n) => inputRow(row, n, i.list.length, i.type === "discrete")).join("")}</div>`
      : `<p class="ds-hint">No inputs yet.</p>`);
    parts.push(`<div class="ds-row-actions">
        <button type="button" class="btn btn-text" data-focus="add-input" data-act="add-input"${i.list.length >= MAX_INPUTS ? " disabled" : ""}>${icon("add", { size: 18 })}Add input</button>
        <button type="button" class="btn btn-text" data-focus="fill-inputs" data-act="fill-inputs"${suggested.length ? "" : " disabled"}>Fill from commands</button>
      </div>`);
    if (i.type === "cycle") {
      parts.push(`<div class="m-list">${pickRow("next", i.next)}${pickRow("previous", i.previous)}${pickRow("afterPowerOn", i.afterPowerOn)}</div>`);
      parts.push(`<p class="ds-hint">Which input it is on when it turns on, so the hub knows where cycling starts.</p>`);
    }
    return parts.join("");
  }

  function footMarkup() {
    const { problems, changed } = evaluate();
    const offer = changed || !hasPower;
    const problem = saveError || (offer ? problems[0] : "") || "";
    const ready = offer && !problems.length && !saving;
    return `<p class="ds-problem">${escapeHtml(problem)}</p>
      <button type="button" class="btn btn-filled btn-block" data-focus="save" data-act="save"${ready ? "" : " disabled"}>${saving ? `${spinner()}Saving to hub…` : "Save"}</button>`;
  }

  function pageMarkup() {
    const p = draft.power;
    return `<div class="page ds">
        ${hasPower ? "" : `<p class="ds-note">This device has no power settings yet. The choices below are suggestions from its command names; save to apply them.</p>`}
        ${sectionLabel("Power")}
        ${radioGroup("power", "Power", POWER_TYPES, p.type)}
        ${p.type === "discrete" ? `<div class="m-list">${pickRow("on", p.on)}${pickRow("off", p.off)}</div>` : ""}
        ${p.type === "toggle" ? `<div class="m-list">${pickRow("toggle", p.toggle)}</div>` : ""}
        ${p.type === "none" ? "" : `${sectionLabel("Turning on")}
          <div class="m-list">
            ${stepper("powerDelay")}
            ${switchRow("alwaysOn", "Always on", "Activities never turn it off", p.alwaysOn)}
            ${switchRow("onBetweenActivities", "Keep on between activities", "Stays on when you switch to an activity that doesn't use it", p.onBetweenActivities)}
          </div>`}
        ${inputsMarkup()}
        ${sectionLabel("Timing")}
        <p class="ds-hint">Raise these if the device misses commands or responds to only some presses.</p>
        <div class="m-list">${stepper("interKey")}${stepper("interDevice")}${stepper("repeats")}</div>
        <div class="ds-foot" aria-live="polite">${footMarkup()}</div>
      </div>`;
  }

  /* A redraw keeps focus on the same control. */
  function render(focusKey) {
    const activeEl = document.activeElement;
    const key = focusKey ?? (root.contains(activeEl) ? activeEl.dataset.focus : null);
    root.innerHTML = pageMarkup();
    if (key) root.querySelector(`[data-focus="${key}"]`)?.focus({ preventScroll: true });
  }

  function renderFoot() {
    const foot = root.querySelector(".ds-foot");
    if (foot) foot.innerHTML = footMarkup();
  }

  function changed() {
    saveError = "";
    renderFoot();
  }

  /* -- loading ---------------------------------------------------------------------- */

  async function show(id) {
    const mine = (shown += 1);
    active = true;
    deviceId = id;
    draft = null;
    typed = {};
    saving = false;
    saveError = "";
    const known = hub.deviceById(id);
    setAppBar({ title: known ? `${known.name} settings` : "Device settings", back: `devices/${encodeURIComponent(id)}` });
    root.innerHTML = `<div class="m-center">${spinner("Loading the settings")}</div>`;
    try {
      // The hub's own copy, not the one this page loaded earlier.
      config = await getConfig();
    } catch (error) {
      if (mine !== shown) return;
      root.innerHTML = `<div class="page"><p class="list-note">Couldn't load the settings: ${escapeHtml(error.message)}</p>
          <button type="button" class="btn btn-filled" data-act="settings-retry">Try again</button></div>`;
      return;
    }
    if (mine !== shown) return;
    const entry = (config?.deviceList?.DevicesWithFeatures ?? []).find((e) => String(e?.Device?.["Id-"]) === id);
    if (!entry) {
      setAppBar({ title: "Device settings", back: "devices" });
      root.innerHTML = `<p class="list-note">This device is no longer on the hub.</p>`;
      return;
    }
    setAppBar({ title: `${entry.Device.Name || "Device"} settings`, back: `devices/${encodeURIComponent(id)}` });
    names = commandNames(entry);
    draft = draftFrom(entry);
    tv = null;
    if (isAndroidTvEntry(entry)) {
      tv = await loadTv(entry);
      if (mine !== shown) return;
    }
    initialKey = JSON.stringify(settingsOf(false));
    initialInputsKey = inputsKey();
    render();
  }

  /* A network TV's inputs: the device's list, codex_androidtv's profile and
     status, and the brand presets. Each may fail on its own; the page still
     shows what it has. */
  async function loadTv(entry) {
    const id = androidTvIdOf(entry);
    const [status, saved, presetsFile] = await Promise.all([
      getAndroidTvStatus().then((r) => (r.tvs ?? []).find((t) => t.id === id) ?? null, () => null),
      getTvInputs(id).then((r) => ({ ok: true, profile: r.profile }), (error) => ({ ok: false, error })),
      getTvInputPresets().then((r) => r, () => null),
    ]);
    const presets = readPresets(presetsFile);
    const i = readInputSettings(entry);
    const base = {
      entryInputs: i.hasInputFeature ? i.list : null,
      delayMs: i.delayMs,
      profile: saved.ok ? parseProfile(saved.profile) : null,
      presets,
      // The brand and model saved with the device (filled in from the TV when
      // it was added; Edit details changes them) pick the suggestion.
      vendor: String(entry.Device?.Manufacturer ?? ""),
      model: String(entry.Device?.Model ?? ""),
    };
    const t = {
      id, status, presets, base,
      draft: readTvInputs(base),
      loadError: saved.ok ? "" : `Couldn't read this TV's input settings from the hub (${saved.error.message}). Saving replaces them.`,
    };
    tv = t;
    t.writerKey = tvWriterKey();
    // A TV without a saved profile has nothing saved yet: saving writes it.
    t.profileKey = saved.ok && saved.profile ? tvProfileKey() : "";
    return t;
  }

  async function refreshTvStatus(focus) {
    if (!tv) return;
    const id = tv.id;
    const status = await getAndroidTvStatus().then((r) => (r.tvs ?? []).find((t) => t.id === id) ?? null, () => null);
    if (!tv || tv.id !== id) return;
    tv.status = status;
    render(focus);
  }

  function hide() {
    shown += 1;
    active = false;
  }

  async function confirmLeave() {
    if (saving) {
      snackbar("Saving to the hub… one moment");
      return false;
    }
    if (!isDirty()) return true;
    const discard = await confirmDialog({
      title: "Discard changes?",
      text: "These settings haven't been saved to the hub.",
      confirmLabel: "Discard",
      destructive: true,
    });
    if (discard) draft = null;
    return discard;
  }

  /* A network TV saves in three steps, each only when it changed: its
     inputs to the network TV writer (which adds the Input<n> commands they
     need), its profile to codex_androidtv, then power and timing. A step that
     fails stops the rest; Save again finishes. */
  async function saveTv(settings) {
    const id = deviceId;
    const t = tv;
    const parts = [];
    if (tvWriterKey() !== t.writerKey) {
      const set = androidTvDeviceSet(config);
      const mine = set.devices.find((d) => d.entity === t.id);
      if (!mine) throw new Error("This TV isn't in the hub's network TV list any more.");
      Object.assign(mine, writerInputs(t.draft));
      await saveAndroidTvDevices(set);
      t.writerKey = tvWriterKey();
      parts.push("inputs");
    }
    if (tvProfileKey() !== t.profileKey) {
      try {
        await saveTvInputs(t.id, tvProfileKey());
      } catch (error) {
        throw new Error(`${parts.length ? "The inputs were saved, but not how the TV switches them" : "How the TV switches inputs wasn't saved"}: ${error.message}`);
      }
      t.profileKey = tvProfileKey();
      parts.push("input switching");
    }
    if (JSON.stringify(settings) !== initialKey) {
      try {
        await saveDeviceSettings(deviceSettingsRequest(id, settings));
      } catch (error) {
        throw new Error(`${parts.length ? "The inputs were saved, but not the power and timing settings" : "The settings weren't saved"}: ${error.message}`);
      }
      initialKey = JSON.stringify(settings);
    }
    return "TV settings saved.";
  }

  async function save() {
    const { settings, problems } = evaluate();
    if (saving || problems.length) return;
    saving = true;
    saveError = "";
    renderFoot();
    const id = deviceId;
    if (tv) {
      try {
        const message = await saveTv(settings);
        saving = false;
        snackbar(message);
        hub.refreshConfig().catch(() => {});
        if (!active || id !== deviceId) return;
        draft = null;
        tv = null;
        location.hash = `#devices/${encodeURIComponent(id)}`;
      } catch (error) {
        saving = false;
        saveError = error.message || "Saving the TV settings failed.";
        if (active && id === deviceId) renderFoot();
      }
      return;
    }
    try {
      const res = await saveDeviceSettings(deviceSettingsRequest(id, settings));
      saving = false;
      snackbar(res.message || "Device settings saved.");
      hub.refreshConfig().catch(() => {});
      if (!active || id !== deviceId) return;
      draft = null; // saved: nothing to ask about on the way out
      location.hash = `#devices/${encodeURIComponent(id)}`;
    } catch (error) {
      saving = false;
      saveError = error.message || "Saving the device settings failed.";
      if (active && id === deviceId) renderFoot();
    }
  }

  /* -- events ---------------------------------------------------------------------- */

  function openPick(key) {
    const p = draft.power;
    const i = draft.inputs;
    const current = { on: p.on, off: p.off, toggle: p.toggle, next: i.next, previous: i.previous, afterPowerOn: i.afterPowerOn }[key];
    const options = key === "afterPowerOn" ? i.list.map((r) => r.name.trim()).filter(Boolean) : names;
    track(openCommandPicker({
      title: PICKS[key].title,
      names: options,
      selected: current,
      none: PICKS[key].none ?? "",
      powerFirst: Boolean(PICKS[key].powerFirst),
      onPick: (value) => {
        if (key in p) p[key] = value;
        else i[key] = value;
        saveError = "";
        render(`pick-${key}`);
      },
    }));
  }

  function openInputCommand(n) {
    const row = draft.inputs.list[n];
    track(openCommandPicker({
      title: row.name.trim() ? `Command for ${row.name.trim()}` : `Command for input ${n + 1}`,
      names,
      selected: row.command,
      none: "No command",
      onPick: (value) => {
        row.command = value;
        saveError = "";
        render(`in-cmd-${n}`);
      },
    }));
  }

  function openInputMenu(n, anchor) {
    const list = tv ? tv.draft.rows : draft.inputs.list;
    openMenu({
      anchor,
      label: `Input ${n + 1}`,
      items: [
        { id: "up", label: "Move up", icon: "keyboard_arrow_up", disabled: n === 0 },
        { id: "down", label: "Move down", icon: "keyboard_arrow_down", disabled: n === list.length - 1 },
        { id: "remove", label: "Remove", icon: "delete_outlined", destructive: true },
      ],
      onSelect: (choice) => {
        let focus = `in-menu-${n}`;
        if (choice === "remove") {
          list.splice(n, 1);
          focus = list.length ? `in-menu-${Math.min(n, list.length - 1)}` : "add-input";
        } else {
          const to = choice === "up" ? n - 1 : n + 1;
          [list[n], list[to]] = [list[to], list[n]];
          focus = `in-menu-${to}`;
        }
        saveError = "";
        render(focus);
      },
    });
  }

  function openTvOpens(n) {
    const d = tv.draft;
    const row = d.rows[n];
    const name = row.name.trim() || `Input ${n + 1}`;
    if (d.method === "link" && d.pattern === CUSTOM_LINKS) {
      track(openLinkSheet({
        name,
        value: row.value,
        onSave: (link) => {
          if (link !== row.value) Object.assign(row, { value: link, status: "untested", date: "" });
          saveError = "";
          render(`tv-opens-${n}`);
        },
      }));
      return;
    }
    const options = targetOptions(d);
    track(openCommandPicker({
      title: `What ${name} opens`,
      names: options.map((o) => o.label),
      selected: options.find((o) => o.value === row.value)?.label ?? "",
      onPick: (label) => {
        const picked = options.find((o) => o.label === label);
        if (picked && picked.value !== row.value) Object.assign(row, { value: picked.value, status: "untested", date: "" });
        saveError = "";
        render(`tv-opens-${n}`);
      },
    }));
  }

  function openTvPattern() {
    const d = tv.draft;
    const options = [
      ...d.patterns.map((p) => ({ id: p.id, label: `${p.label}${p.untested ? " (untested)" : ""}` })),
      { id: CUSTOM_LINKS, label: "A link for each input" },
    ];
    track(openCommandPicker({
      title: "Input links",
      names: options.map((o) => o.label),
      selected: options.find((o) => o.id === d.pattern)?.label ?? "",
      onPick: (label) => {
        const picked = options.find((o) => o.label === label);
        if (picked) setPattern(d, picked.id);
        saveError = "";
        render("tv-pattern");
      },
    }));
  }

  async function tvAct(act) {
    const d = tv.draft;
    if (act === "pattern") openTvPattern();
    else if (act === "find") {
      track(openFinderSheet({ tvId: tv.id, draft: d, onDone: () => { saveError = ""; render("tv-find"); } }));
    } else if (act === "preset") {
      const working = presetChangesWorkingRows(d);
      if (working.length) {
        const ok = await confirmDialog({
          title: "Use the suggested setup?",
          text: `It changes inputs you marked as working: ${working.map((r) => r.name.trim()).join(", ")}.`,
          confirmLabel: "Use it",
        });
        if (!ok || !tv) return;
      }
      applyPreset(d);
      saveError = "";
      render("tv-preset");
    } else if (act === "share") {
      track(openShareSheet({ entry: shareEntry(d, tv.base.vendor, tv.base.model) }));
    } else if (act === "refresh") {
      refreshTvStatus("tv-refresh");
    } else if (act === "power-on") {
      const id = tv.id;
      try {
        await tryTvInput({ device: id, method: "power", value: "on" });
      } catch (error) {
        snackbar(error.message, { error: true });
      }
      // The TV takes a few seconds to say it is on; longer from deep standby,
      // where it first has to wake up and join the network.
      for (let i = 0; i < 25 && tv?.id === id && !tv.status?.on; i++) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        await refreshTvStatus("tv-power-on");
      }
    }
  }

  function step(key, dir) {
    const s = STEPPERS[key];
    const [get, set] = VALUES[key];
    const value = Number.isFinite(get()) ? get() : 0;
    set(Math.min(s.max, Math.max(0, value + dir * s.step)));
    delete typed[key];
    saveError = "";
    render(`${key}-${dir < 0 ? "less" : "more"}`);
  }

  function typedValue(key, text) {
    const s = STEPPERS[key];
    const [, set] = VALUES[key];
    const trimmed = text.trim();
    const n = trimmed === "" ? NaN : Number(trimmed);
    set(Number.isFinite(n) ? (s.seconds ? Math.round(n * 1000) : n) : NaN);
    typed[key] = text;
  }

  /* While typing, only the − and + buttons follow: a redraw here would eat
     the click that moved focus away. */
  function syncStepper(key) {
    const value = VALUES[key][0]();
    const valid = Number.isFinite(value);
    const less = root.querySelector(`[data-focus="${key}-less"]`);
    const more = root.querySelector(`[data-focus="${key}-more"]`);
    if (less) less.disabled = valid && value <= 0;
    if (more) more.disabled = valid && value >= STEPPERS[key].max;
  }

  root.addEventListener("click", (event) => {
    if (!active) return;
    if (!draft) {
      if (event.target.closest("[data-act='settings-retry']")) show(deviceId);
      return;
    }
    if (saving) return;
    const stepBtn = event.target.closest("[data-step]");
    if (stepBtn) {
      step(stepBtn.dataset.step, Number(stepBtn.dataset.dir));
      return;
    }
    const pick = event.target.closest("[data-pick]");
    if (pick) {
      openPick(pick.dataset.pick);
      return;
    }
    if (tv) {
      const opens = event.target.closest("[data-tv-opens]");
      if (opens) {
        openTvOpens(Number(opens.dataset.tvOpens));
        return;
      }
      const tryBtn = event.target.closest("[data-tv-try]");
      if (tryBtn) {
        const n = Number(tryBtn.dataset.tvTry);
        track(openTrySheet({ tvId: tv.id, draft: tv.draft, index: n, onDone: () => { saveError = ""; render(`tv-try-${n}`); } }));
        return;
      }
      const tvActBtn = event.target.closest("[data-tv-act]");
      if (tvActBtn) {
        tvAct(tvActBtn.dataset.tvAct);
        return;
      }
    }
    const cmd = event.target.closest("[data-input-cmd]");
    if (cmd) {
      openInputCommand(Number(cmd.dataset.inputCmd));
      return;
    }
    const menu = event.target.closest("[data-input-menu]");
    if (menu) {
      openInputMenu(Number(menu.dataset.inputMenu), menu);
      return;
    }
    const act = event.target.closest("[data-act]")?.dataset.act;
    if (act === "add-input" && tv) {
      if (addRow(tv.draft)) {
        saveError = "";
        render(`tv-name-${tv.draft.rows.length - 1}`);
      }
    } else if (act === "add-input") {
      draft.inputs.list.push({ name: "", command: "" });
      saveError = "";
      render(`in-name-${draft.inputs.list.length - 1}`);
    } else if (act === "fill-inputs") {
      draft.inputs.list.splice(0, draft.inputs.list.length, ...suggested.map((s) => ({ ...s })));
      saveError = "";
      render("fill-inputs");
    } else if (act === "save") {
      save();
    }
  });

  root.addEventListener("change", (event) => {
    if (!active || !draft || saving) return;
    const t = event.target;
    if (t.dataset.radio === "power") {
      draft.power.type = t.value;
      saveError = "";
      render();
    } else if (t.dataset.radio === "tvmethod" && tv) {
      setMethod(tv.draft, t.value);
      saveError = "";
      render(`tvmethod-${t.value}`);
    } else if (t.dataset.radio === "inputs") {
      draft.inputs.type = t.value;
      // A device that never had inputs starts from its Input* commands.
      if (t.value !== "none" && !draft.inputs.list.length) draft.inputs.list.push(...suggested.map((s) => ({ ...s })));
      saveError = "";
      render();
    } else if (t.dataset.switch) {
      draft.power[t.dataset.switch] = t.checked;
      changed();
    } else if (t.dataset.value) {
      // Leaving the field shows the number the way the stepper writes it.
      const key = t.dataset.value;
      const value = VALUES[key][0]();
      if (Number.isFinite(value)) {
        delete typed[key];
        t.value = String(STEPPERS[key].seconds ? value / 1000 : value);
      }
    }
  });

  root.addEventListener("input", (event) => {
    if (!active || !draft || saving) return;
    const t = event.target;
    if (t.dataset.value) {
      typedValue(t.dataset.value, t.value);
      syncStepper(t.dataset.value);
      changed();
    } else if (t.dataset.tvName != null && tv) {
      tv.draft.rows[Number(t.dataset.tvName)].name = t.value;
      changed();
    } else if (t.dataset.inputName != null) {
      draft.inputs.list[Number(t.dataset.inputName)].name = t.value;
      changed();
    }
  });

  root.addEventListener("keydown", (event) => {
    const key = event.target.dataset?.value;
    if (!key || !active || !draft || saving) return;
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      step(key, event.key === "ArrowUp" ? 1 : -1);
      root.querySelector(`[data-focus="${key}-value"]`)?.focus();
    }
  });

  window.addEventListener("beforeunload", (event) => {
    if (!isDirty()) return;
    event.preventDefault();
    event.returnValue = "";
  });

  return { show, hide, confirmLeave };
}
