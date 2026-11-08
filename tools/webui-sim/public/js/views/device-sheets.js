/* Sheets over the device pages: Add a device and Edit details, a command's
   signal typed by hand (also the Import sheet's "Type a code" tab), Learn a
   button from the device's own remote, and the settings page's command
   picker (the app's CommandSheet).

   The hub answers its /ir/* forms with HTTP 200 even when it refuses, so a
   change counts once the re-read setup shows it; otherwise the hub's own
   message says why. */

import { postApiForm, postHubForm } from "../api.js";
import * as hub from "../state.js";
import { escapeHtml, icon, iconTile, listRow, openSheet, snackbar, spinner } from "../ui/shell.js";
import { LIMITS, analyzeCapture, deviceTypeOptions, isSafeLabel, normalizeSignal } from "./ir-model.js";
import { openAndroidTvSheet } from "./androidtv-sheet.js";

/* -- the hub's /ir/* forms --------------------------------------------------- */

/**
 * POST an /ir/* form, read the setup again, and resolve once `landed()`
 * sees the change; otherwise reject with the hub's message. Resolves
 * { message, verified }: when the setup can't be read back, the hub did
 * answer, so its message is all there is to go by (verified false).
 */
export async function hubChange(path, fields, landed) {
  const res = await postHubForm(path, fields);
  try {
    await hub.refreshConfig();
  } catch (_) {
    return { message: res.msg || "The hub answered.", verified: false };
  }
  if (!landed()) throw new Error(res.msg || "The hub didn't make the change.");
  return { message: res.msg, verified: true };
}

/** What to tell after a change: `done`, or the hub's own words when the
    change couldn't be checked. */
export function changeNote(result, done) {
  return result.verified ? done : `The hub says: ${result.message} It couldn't be read back to check.`;
}

/** The device's command as the hub stores it, or null. */
export function storedCommand(deviceId, name) {
  return hub.deviceById(deviceId)?.entry?.Commands?.find((c) => c?.Name === name) ?? null;
}

const NAME_RULE = `1–${LIMITS.name} characters, without quotes or backslashes`;

/* -- small markup helpers ------------------------------------------------------ */

let fieldCount = 0;

/** A unique element id for one sheet's field. */
export function fieldId(name) {
  fieldCount += 1;
  return `${name}${fieldCount}`;
}

/** Label, input and an optional hint (the app's OutlinedTextField). */
export function textField({ id, label, value = "", placeholder = "", maxlength = 0, hint = "", attrs = "" }) {
  return `<div class="m-field">
      <label for="${id}">${escapeHtml(label)}</label>
      <input id="${id}" value="${escapeHtml(value)}" placeholder="${escapeHtml(placeholder)}"${maxlength ? ` maxlength="${maxlength}"` : ""} autocomplete="off" spellcheck="false" ${attrs}>
      ${hint ? `<p class="m-field-hint">${escapeHtml(hint)}</p>` : ""}
    </div>`;
}

/**
 * The app's Stepper row: a title and a subtitle, then −, the value (which
 * can also be typed) and +. Its controls carry data-step / data-dir and
 * data-value for the page's handlers, and data-focus to keep focus across
 * redraws.
 */
export function stepperRow({ key, title, sub, text, value, min = 0, max, unit = "", spoken = "", less, more, decimal = false, disabled = false }) {
  const valid = Number.isFinite(value);
  const off = disabled ? " disabled" : "";
  return `<div class="m-row ds-stepper">
      <span class="m-row-text"><span class="ds-title">${escapeHtml(title)}</span><span class="m-row-sub">${escapeHtml(sub)}</span></span>
      <span class="ds-stepper-ctl" role="group" aria-label="${escapeHtml(title)}">
        <button type="button" class="icon-btn" data-focus="${key}-less" data-step="${key}" data-dir="-1" aria-label="${escapeHtml(less)}"${off || (!valid || value > min ? "" : " disabled")}>${icon("remove")}</button>
        <input class="ds-stepper-value" data-focus="${key}-value" data-value="${key}" value="${escapeHtml(text)}" inputmode="${decimal ? "decimal" : "numeric"}" autocomplete="off" aria-label="${escapeHtml(title + spoken)}"${off}>
        ${unit ? `<span class="ds-unit" aria-hidden="true">${unit}</span>` : ""}
        <button type="button" class="icon-btn" data-focus="${key}-more" data-step="${key}" data-dir="1" aria-label="${escapeHtml(more)}"${off || (!valid || value < max ? "" : " disabled")}>${icon("add")}</button>
      </span>
    </div>`;
}

/** The status line of a sheet or form: kind is error, warn, ok or info. */
export function setMessage(el, text, kind = "info") {
  if (!el) return;
  el.textContent = text ?? "";
  el.dataset.kind = text ? kind : "";
}

/* -- Add a device / Edit details ----------------------------------------------- */

/**
 * The device's name, type, maker and model (/ir/new-device, /ir/device).
 * onDone(device) runs after the hub has it, while the sheet was still open:
 * the new device for Add, the device for Edit.
 */
export function openDeviceSheet({ device = null, onDone } = {}) {
  const editing = Boolean(device);
  const stored = editing ? device.entry?.Device ?? {} : {};
  const types = deviceTypeOptions(editing ? String(stored.DeviceTypeDisplayName ?? "") : "");
  let type = editing && types.includes(stored.DeviceTypeDisplayName) ? stored.DeviceTypeDisplayName : types[0];
  const ids = { name: fieldId("devName"), manufacturer: fieldId("devMaker"), model: fieldId("devModel") };
  let busy = false;

  return openSheet({
    label: editing ? `Edit ${device.name}` : "Add a device",
    render: (content, close) => {
      content.innerHTML = `<form class="m-form" novalidate>
          <h2 class="sheet-title">${editing ? "Edit details" : "Add a device"}</h2>
          ${editing ? "" : `<div class="m-list androidtv-entry">${listRow({
            title: "Android or Google TV on the network",
            subtitle: "Paired over the network: power, every key and inputs, no IR",
            leading: iconTile("tv", { size: 40 }),
            chevron: true,
            attrs: 'data-act="androidtv"',
          })}</div>
          <p class="sheet-text">Or a device you control by IR. Then learn its buttons from its own remote, or import codes for it.</p>`}
          ${textField({ id: ids.name, label: "Name", value: stored.Name ?? "", placeholder: "Living room TV", maxlength: LIMITS.name })}
          <fieldset class="m-fieldset">
            <legend>Type</legend>
            <div class="m-chips">${types.map((t) => `<button type="button" class="chip" data-type="${escapeHtml(t)}" aria-pressed="${t === type}">${escapeHtml(t)}</button>`).join("")}</div>
          </fieldset>
          ${textField({ id: ids.manufacturer, label: "Manufacturer", value: stored.Manufacturer ?? "", placeholder: "Samsung", maxlength: LIMITS.manufacturer })}
          ${textField({ id: ids.model, label: "Model", value: stored.Model ?? "", placeholder: "UN55…", maxlength: LIMITS.model })}
          <p class="form-msg" data-msg role="status" aria-live="polite"></p>
          <button type="submit" class="btn btn-filled btn-block">${editing ? "Save" : "Add device"}</button>
        </form>`;
      const form = content.querySelector("form");
      const msg = content.querySelector("[data-msg]");
      const submit = form.querySelector("[type=submit]");
      const values = () => ({
        name: form.querySelector(`#${ids.name}`).value.trim(),
        manufacturer: form.querySelector(`#${ids.manufacturer}`).value.trim(),
        model: form.querySelector(`#${ids.model}`).value.trim(),
        type,
      });
      // The hub's answer can't tell "saved as it was" from a refusal, so
      // Edit details only sends a change.
      const initial = JSON.stringify(values());
      const unchanged = () => editing && JSON.stringify(values()) === initial;
      const sync = () => {
        submit.disabled = busy || unchanged();
      };

      form.addEventListener("click", (event) => {
        if (event.target.closest("[data-act='androidtv']")) {
          close();
          openAndroidTvSheet({ onDone });
          return;
        }
        const chip = event.target.closest("[data-type]");
        if (!chip) return;
        type = chip.dataset.type;
        form.querySelectorAll("[data-type]").forEach((c) => c.setAttribute("aria-pressed", String(c === chip)));
        sync();
      });
      form.addEventListener("input", sync);

      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        if (busy || unchanged()) return;
        const fields = values();
        for (const [key, label, max] of [
          ["name", "Name", LIMITS.name],
          ["manufacturer", "Manufacturer", LIMITS.manufacturer],
          ["model", "Model", LIMITS.model],
          ["type", "Type", LIMITS.deviceType],
        ]) {
          if (!isSafeLabel(fields[key], max)) {
            setMessage(msg, `${label} needs 1–${max} characters, without quotes or backslashes.`, "error");
            form.querySelector(`#${ids[key]}`)?.focus();
            return;
          }
        }
        busy = true;
        submit.disabled = true;
        setMessage(msg, editing ? "Saving…" : "Adding the device…");
        const before = new Set(hub.devices().map((d) => d.id));
        let added = null;
        try {
          let result;
          if (editing) {
            result = await hubChange("/ir/device", { deviceId: device.id, ...fields }, () => {
              const d = hub.deviceById(device.id)?.entry?.Device;
              return Boolean(d) && d.Name === fields.name && d.Manufacturer === fields.manufacturer &&
                d.Model === fields.model && d.DeviceTypeDisplayName === fields.type;
            });
          } else {
            result = await hubChange("/ir/new-device", fields, () => {
              added = hub.devices().find((d) => !before.has(d.id)) ?? null;
              return Boolean(added);
            });
          }
          const open = content.isConnected;
          close();
          snackbar(changeNote(result, editing ? `Saved ${fields.name}` : `Added ${fields.name}`));
          if (open && result.verified) onDone?.(added ?? hub.deviceById(device.id));
        } catch (error) {
          setMessage(msg, error.message || "Saving failed.", "error");
        } finally {
          busy = false;
          sync();
        }
      });
      sync();

      if (!editing) form.querySelector(`#${ids.name}`).focus();
    },
  });
}

/* -- a command's signal, by hand ------------------------------------------------ */

const SIGNAL_TYPES = [
  { value: "auto", label: "Auto", hint: "Fill in what you have; the hub works out the type." },
  { value: "keycode", label: "Keycode", hint: "A Harmony compact code." },
  { value: "nec", label: "NEC", hint: "An NEC code in hex: up to 8 digits." },
  { value: "raw", label: "Raw", hint: "Raw timings. The hub replays them as they are." },
];

/* Which fields each signal type uses (Auto shows every one). */
const SIGNAL_FIELDS = {
  auto: ["protocol", "keycode", "nec", "raw"],
  keycode: ["protocol", "keycode"],
  nec: ["protocol", "nec"],
  raw: ["raw"],
};

/**
 * The command form: name, signal type, protocol id, keycode, NEC hex and
 * raw timing, filled from `command` when editing. Returns { values, focus }.
 */
export function renderCommandForm(container, { command = null } = {}) {
  let mode = command ? (command.raw ? "raw" : "keycode") : "auto";
  const ids = {
    name: fieldId("cmdName"),
    protocol: fieldId("cmdProto"),
    keycode: fieldId("cmdKeycode"),
    nec: fieldId("cmdNec"),
    raw: fieldId("cmdRaw"),
  };
  container.classList.add("m-form-fields");
  container.innerHTML = `${textField({ id: ids.name, label: "Command name", value: command?.name ?? "", placeholder: "PowerToggle", maxlength: LIMITS.name })}
    <fieldset class="m-fieldset">
      <legend>Signal type</legend>
      <div class="m-chips">${SIGNAL_TYPES.map((t) => `<button type="button" class="chip" data-mode="${t.value}" aria-pressed="${t.value === mode}">${t.label}</button>`).join("")}</div>
      <p class="m-field-hint" data-mode-hint></p>
    </fieldset>
    <div data-signal="protocol">${textField({ id: ids.protocol, label: "Protocol id", value: command?.protocolId ? String(command.protocolId) : "2", placeholder: "2", maxlength: LIMITS.protocol, attrs: 'inputmode="numeric"' })}</div>
    <div data-signal="keycode">${textField({ id: ids.keycode, label: "Keycode", value: command?.keyCode ?? "", placeholder: "G:Toshiba 32 Bit:(0x…)(Repeat)():3", maxlength: LIMITS.keycode })}</div>
    <div data-signal="nec">${textField({ id: ids.nec, label: "NEC hex", placeholder: "0x04FB08F7", maxlength: LIMITS.nec })}</div>
    <div class="m-field" data-signal="raw">
      <label for="${ids.raw}">Raw timing</label>
      <textarea id="${ids.raw}" placeholder="F38000 P100 S200 …" spellcheck="false">${escapeHtml(command?.rawData ?? "")}</textarea>
    </div>`;

  function sync() {
    container.querySelectorAll("[data-mode]").forEach((c) => c.setAttribute("aria-pressed", String(c.dataset.mode === mode)));
    container.querySelector("[data-mode-hint]").textContent = SIGNAL_TYPES.find((t) => t.value === mode).hint;
    container.querySelectorAll("[data-signal]").forEach((el) => {
      el.hidden = !SIGNAL_FIELDS[mode].includes(el.dataset.signal);
    });
  }

  container.addEventListener("click", (event) => {
    const chip = event.target.closest("[data-mode]");
    if (!chip) return;
    mode = chip.dataset.mode;
    sync();
  });
  sync();

  const value = (key) => container.querySelector(`#${ids[key]}`).value;
  return {
    values: () => ({
      name: value("name"),
      mode,
      protocol: value("protocol"),
      keycode: value("keycode"),
      nec: value("nec"),
      raw: value("raw"),
    }),
    focus: () => container.querySelector(`#${ids.name}`).focus(),
  };
}

/** Add (/ir/command) or update (/ir/update-command) a command; resolves
    like hubChange once the re-read setup has it. */
export async function saveCommand(device, command, values) {
  const name = String(values.name ?? "").trim();
  if (!isSafeLabel(name, LIMITS.name)) throw new Error(`The command name needs ${NAME_RULE}.`);
  if (name !== command?.name && storedCommand(device.id, name)) {
    throw new Error(`${device.name} already has a command called “${name}”.`);
  }
  const defaultMode = command ? "keycode" : "auto";
  const mode = String(values.mode ?? "").trim() || defaultMode;
  if (mode === "auto" && ![values.keycode, values.nec, values.raw].some((v) => String(v ?? "").trim())) {
    throw new Error("Fill in a keycode, an NEC code or raw timings.");
  }
  // Throws with the hub's own wording for a missing or malformed code.
  const signal = normalizeSignal(values, { defaultMode });
  const fields = {
    deviceId: device.id,
    name,
    mode: signal.mode,
    protocol: signal.protocol,
    nec: signal.nec,
    keycode: signal.keycode,
    raw: signal.raw,
  };
  if (!command) return hubChange("/ir/command", fields, () => Boolean(storedCommand(device.id, name)));
  // The hub rewrites the whole command (DateTaught too), so an update shows.
  const before = JSON.stringify(storedCommand(device.id, command.name));
  return hubChange("/ir/update-command", { ...fields, oldName: command.name }, () => {
    const now = storedCommand(device.id, name);
    if (!now) return false;
    return name !== command.name ? !storedCommand(device.id, command.name) : JSON.stringify(now) !== before;
  });
}

/** Edit a command's name and signal (the command row's ⋮ → Edit). */
export function openCommandSheet({ device, command }) {
  let busy = false;
  return openSheet({
    label: `Edit ${command.name}`,
    render: (content, close) => {
      content.innerHTML = `<form class="m-form" novalidate>
          <h2 class="sheet-title">Edit command</h2>
          <p class="sheet-text">On ${escapeHtml(device.name)}. The hub stores keycodes and NEC codes compactly and replays raw timings.</p>
          <div data-command-form></div>
          <p class="form-msg" data-msg role="status" aria-live="polite"></p>
          <button type="submit" class="btn btn-filled btn-block">Save</button>
        </form>`;
      const form = content.querySelector("form");
      const msg = content.querySelector("[data-msg]");
      const submit = form.querySelector("[type=submit]");
      const fields = renderCommandForm(content.querySelector("[data-command-form]"), { command });
      // An update is confirmed by the stored command changing, which an
      // unchanged save can't show: only a change is sent.
      const initial = JSON.stringify(fields.values());
      const unchanged = () => JSON.stringify(fields.values()) === initial;
      const sync = () => {
        submit.disabled = busy || unchanged();
      };
      // The signal-type chips handle their click first, on the way up.
      form.addEventListener("input", sync);
      form.addEventListener("click", sync);
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        if (busy || unchanged()) return;
        busy = true;
        submit.disabled = true;
        setMessage(msg, "Saving the command…");
        try {
          const result = await saveCommand(device, command, fields.values());
          close();
          snackbar(changeNote(result, `Saved “${fields.values().name.trim()}”`));
        } catch (error) {
          setMessage(msg, error.message || "Saving failed.", "error");
        } finally {
          busy = false;
          sync();
        }
      });
      sync();
    },
  });
}

/* -- Learn a button ----------------------------------------------------------------- */

/**
 * The app's LearnSheet: Start listening, Listening…, then "Got it" with a
 * name, Test and Save. After a save it starts over for the next button.
 * Signal details (decoded type, codes, protocol) are a web extra.
 */
export function openLearnSheet({ device }) {
  let phase = "idle"; // idle · listening · heard
  let capture = null;
  let note = null; // { text, kind } under the idle text
  let busy = ""; // "test" or "save" while the hub works
  let name = "";
  let listening = 0;
  const nameId = fieldId("learnName");
  const who = escapeHtml(device.name);

  return openSheet({
    label: "Learn a button",
    render: (content) => {
      function summary() {
        return capture.analysis || `${capture.mode.toUpperCase()} signal`;
      }

      function details() {
        const rows = [["Decoded as", capture.mode]];
        if (capture.keycode) rows.push(["Keycode", capture.keycode]);
        if (capture.nec) rows.push(["NEC", capture.nec]);
        if (capture.mode === "raw") rows.push(["Raw", capture.raw.length > 120 ? `${capture.raw.slice(0, 120)}…` : capture.raw]);
        rows.push(["Protocol", String(capture.protocolId)]);
        return `<details class="m-details">
            <summary>Signal details</summary>
            <dl class="m-kv">${rows.map(([k, v]) => `<div><dt>${escapeHtml(k)}</dt><dd class="mono">${escapeHtml(v)}</dd></div>`).join("")}</dl>
          </details>`;
      }

      function draw() {
        let body;
        if (phase === "listening") {
          body = `<p class="sheet-text">Listening… Point your original ${who} remote at the hub and press the button once.</p>
            <div class="m-progress" role="progressbar" aria-label="Listening"><span></span></div>`;
        } else if (phase === "heard") {
          body = `<p class="learn-heard">${icon("check", { size: 20 })}<span>Got it. ${escapeHtml(summary())}</span></p>
            ${textField({ id: nameId, label: "Command name (e.g. InputHdmi3)", value: name, maxlength: LIMITS.name, attrs: 'enterkeyhint="done"' })}
            <div class="learn-actions">
              <button type="button" class="btn btn-outlined" data-learn="test">Test</button>
              <button type="button" class="btn btn-filled" data-learn="save">Save to ${who}</button>
            </div>
            <button type="button" class="btn btn-text learn-again" data-learn="start">Learn again</button>
            ${details()}`;
        } else {
          body = `<p class="sheet-text">Point your original ${who} remote at the front of the hub, then tap Start and press the button you want to copy.</p>
            ${note ? `<p class="form-msg learn-note" data-kind="${note.kind}">${escapeHtml(note.text)}</p>` : ""}
            <button type="button" class="btn btn-filled btn-block" data-learn="start">Start listening</button>`;
        }
        content.innerHTML = `<h2 class="sheet-title">Learn a button</h2>${body}
          <p class="form-msg" data-msg role="status" aria-live="polite"></p>`;
        syncButtons();
      }

      // The name field keeps its focus: only the buttons follow it.
      function syncButtons() {
        const test = content.querySelector("[data-learn='test']");
        const save = content.querySelector("[data-learn='save']");
        const again = content.querySelector(".learn-again");
        if (test) {
          test.disabled = Boolean(busy);
          test.innerHTML = `${busy === "test" ? spinner() : ""}Test`;
        }
        if (save) {
          save.disabled = Boolean(busy) || !name.trim();
          save.innerHTML = busy === "save" ? `${spinner()}Saving…` : `Save to ${who}`;
        }
        if (again) again.disabled = Boolean(busy);
      }

      function fail(text) {
        setMessage(content.querySelector("[data-msg]"), text, "error");
      }

      function signalFields() {
        return {
          mode: capture.mode,
          protocol: String(capture.protocolId),
          nec: capture.nec,
          keycode: capture.keycode,
          raw: capture.raw,
        };
      }

      async function listen() {
        const mine = (listening += 1);
        phase = "listening";
        capture = null;
        note = null;
        draw();
        let heard = null;
        try {
          heard = analyzeCapture(await postApiForm("/api/capture", {}));
          note = heard.empty ? { text: "Didn't hear anything. Point the remote at the hub and try again.", kind: "warn" } : null;
        } catch (error) {
          note = { text: `Learning failed: ${error.message}`, kind: "error" };
        }
        // A later Start, or a closed sheet, owns the screen now.
        if (mine !== listening || !content.isConnected) return;
        if (heard && !heard.empty) {
          capture = heard;
          phase = "heard";
        } else {
          phase = "idle";
        }
        draw();
        content.querySelector(phase === "heard" ? `#${nameId}` : "[data-learn='start']")?.focus();
      }

      async function test() {
        busy = "test";
        syncButtons();
        try {
          await postApiForm("/api/ir-test-learned", { deviceId: device.id, name: name.trim() || "Signal test", ...signalFields() });
          snackbar("Test signal sent");
        } catch (error) {
          fail(`Test failed: ${error.message}`);
        } finally {
          busy = "";
          if (content.isConnected) syncButtons();
        }
      }

      async function save() {
        const clean = name.trim();
        busy = "save";
        syncButtons();
        try {
          const result = await saveCommand(device, null, { name: clean, ...signalFields() });
          snackbar(changeNote(result, `Saved “${clean}”`));
          busy = "";
          if (!content.isConnected) return;
          // Ready for the next button, as in the app.
          capture = null;
          name = "";
          phase = "idle";
          draw();
          content.querySelector("[data-learn='start']")?.focus();
        } catch (error) {
          busy = "";
          if (!content.isConnected) return;
          syncButtons();
          fail(error.message || "Saving failed.");
        }
      }

      content.addEventListener("click", (event) => {
        const act = event.target.closest("[data-learn]")?.dataset.learn;
        if (busy && act) return;
        if (act === "start") listen();
        else if (act === "test") test();
        else if (act === "save") save();
      });

      content.addEventListener("input", (event) => {
        if (event.target.id !== nameId) return;
        name = event.target.value;
        syncButtons();
      });

      content.addEventListener("keydown", (event) => {
        if (event.key === "Enter" && event.target.id === nameId && !busy && name.trim()) {
          event.preventDefault();
          save();
        }
      });

      draw();
    },
  });
}

/* -- the command picker (CommandSheet) ------------------------------------------------------- */

/**
 * Pick one of `names`: search, a check on the current one, and with
 * `none` a first row that picks "" (e.g. "No command"). `powerFirst` puts
 * power commands on top, as the app does for its power slots.
 */
export function openCommandPicker({ title, names, selected = "", none = "", powerFirst = false, onPick }) {
  const list = powerFirst
    ? [...names].sort((a, b) => Number(!/power/i.test(a)) - Number(!/power/i.test(b)))
    : [...names];
  const current = String(selected ?? "").toLowerCase();
  let query = "";

  const opened = openSheet({
    label: title,
    className: "pick-sheet",
    render: (content, close) => {
      content.innerHTML = `<div class="pick-top">
          <div class="pick-head"><h2 class="sheet-title" tabindex="-1" autofocus>${escapeHtml(title)}</h2></div>
          <label class="search-field">${icon("search", { size: 22 })}<input type="search" data-pick-search placeholder="Search" aria-label="Search" autocomplete="off"></label>
        </div>
        <div class="pick-list" data-pick-list></div>`;
      const check = icon("check", { cls: "pick-check", label: "Current" });

      function draw() {
        const q = query.trim().toLowerCase();
        const rows = list
          .map((n, i) => ({ n, i }))
          .filter(({ n }) => !q || n.toLowerCase().includes(q))
          .map(({ n, i }) => {
            const on = n.toLowerCase() === current;
            return `<button type="button" class="pick-row${on ? " is-current" : ""}" data-pick="${i}"><span>${escapeHtml(n)}</span>${on ? check : ""}</button>`;
          });
        const noneRow = none && !q
          ? `<button type="button" class="pick-row${current ? "" : " is-current"}" data-pick="none"><span>${escapeHtml(none)}</span>${current ? "" : check}</button>`
          : "";
        content.querySelector("[data-pick-list]").innerHTML = rows.length || noneRow
          ? noneRow + rows.join("")
          : `<p class="list-note">Nothing matches “${escapeHtml(query.trim())}”.</p>`;
      }

      content.addEventListener("click", (event) => {
        const row = event.target.closest("[data-pick]");
        if (!row) return;
        const value = row.dataset.pick === "none" ? "" : list[Number(row.dataset.pick)];
        close();
        onPick(value);
      });

      content.addEventListener("input", (event) => {
        if (!event.target.matches("[data-pick-search]")) return;
        query = event.target.value;
        draw();
        content.scrollTop = 0;
      });

      draw();
    },
  });
  // Open on the current choice.
  opened.content.querySelector(".pick-row.is-current")?.scrollIntoView({ block: "center" });
  return opened;
}
