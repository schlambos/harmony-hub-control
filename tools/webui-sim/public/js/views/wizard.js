/* Guided activity setup: Basics → Devices → Buttons → Review.
   Writes genuine graph resources via wizard-model; the full editor remains
   the escape hatch for anything the wizard does not expose. */

import * as hub from "../state.js";
import { REMOTE_BUTTONS, BUTTON_KEY_BY_LABEL } from "../remote-layout.js";
import { ACTIVITY_TYPES, ROLE_TYPES, roleLabel, saveDraft } from "../wizard-model.js";

const STEPS = [
  { id: "basics", label: "Name it" },
  { id: "devices", label: "Pick devices" },
  { id: "buttons", label: "Map buttons" },
  { id: "review", label: "Review & save" },
];

const SKIN_SRC = globalThis.REMOTE_SKIN_SRC || "/assets/remote-skin.jpg";

const TEMPLATE = `
  <div class="view-head">
    <div>
      <h2 id="title-wizard">Activity setup</h2>
      <p class="view-lead">Four steps to a working activity: what it's called, which devices it uses, what the remote buttons do, then save. The full editor stays available for advanced fields.</p>
    </div>
    <div class="view-actions">
      <a class="btn btn-ghost" href="#activities">All activities</a>
      <a class="btn btn-ghost" href="#editor">Advanced editor</a>
    </div>
  </div>
  <ol class="wiz-rail" id="wizRail"></ol>
  <div class="wiz-body" id="wizBody"></div>
  <div class="wiz-foot" id="wizFoot">
    <p class="wiz-note" id="wizNote" role="status" aria-live="polite"></p>
    <div class="wiz-foot-actions">
      <button type="button" class="btn btn-ghost" id="wizBack">Back</button>
      <button type="button" class="btn btn-primary" id="wizNext">Continue</button>
    </div>
  </div>`;

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function prettifyInput(commandName) {
  const stripped = String(commandName).replace(/^Input/i, "");
  return stripped
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Za-z])(\d)/g, "$1 $2")
    .replace(/\bHdmi\b/g, "HDMI")
    .replace(/\bTv\b/g, "TV")
    .replace(/\bAv\b/g, "AV")
    .replace(/\bUsb\b/g, "USB")
    .replace(/\bArc\b/g, "ARC");
}

function inputOptions(device) {
  return (device?.commands ?? [])
    .filter((c) => /^(input|hdmi|source)/i.test(c.name))
    .map((c) => ({ value: prettifyInput(c.name), command: c.name }));
}

function emptyDraft() {
  return { name: "", type: 2, roles: [], buttons: {} };
}

let pendingEditId = "";

export function setWizardEditId(id) {
  pendingEditId = String(id ?? "");
}

export function createWizardView(section) {
  let mounted = false;
  let els;
  let step = 0;
  let draft = emptyDraft();
  let editId = "";
  let selectedKey = null; // remote-layout label currently being assigned
  let panelDeviceId = ""; // device chosen in the assign panel (survives re-renders)
  let saved = null; // { activityId, name } after a successful save

  function mount() {
    if (mounted) return;
    mounted = true;
    section.innerHTML = TEMPLATE;
    els = {
      rail: section.querySelector("#wizRail"),
      body: section.querySelector("#wizBody"),
      note: section.querySelector("#wizNote"),
      back: section.querySelector("#wizBack"),
      next: section.querySelector("#wizNext"),
    };
    els.back.addEventListener("click", () => go(step - 1));
    els.next.addEventListener("click", onNext);
    els.body.addEventListener("click", onBodyClick);
    els.body.addEventListener("change", onBodyChange);
    els.body.addEventListener("input", onBodyInput);
  }

  /* -- navigation --------------------------------------------------- */

  function go(next) {
    step = Math.max(0, Math.min(STEPS.length - 1, next));
    selectedKey = null;
    render();
  }

  function onNext() {
    const problem = validate(step);
    if (problem) {
      setNote(problem, true);
      return;
    }
    if (step < STEPS.length - 1) {
      go(step + 1);
    } else {
      save();
    }
  }

  function validate(which) {
    if (which === 0 && !draft.name.trim()) return "Give the activity a name to continue.";
    if (which === 1 && !draft.roles.length) return "Add at least one device to continue.";
    if (which === 1 && draft.roles.some((r) => !r.deviceId || !r.roleType)) {
      return "Every device row needs a device and a job.";
    }
    return "";
  }

  function setNote(text, isError = false) {
    els.note.textContent = text;
    els.note.classList.toggle("is-error", isError);
  }

  /* -- render --------------------------------------------------------- */

  function render() {
    els.rail.innerHTML = STEPS.map((s, i) => {
      const state = i < step ? "is-done" : i === step ? "is-current" : "";
      return `<li class="${state}">
        <span class="wiz-rail-dot">${i < step ? "✓" : i + 1}</span>
        <span class="wiz-rail-label">${s.label}</span>
      </li>`;
    }).join("");

    els.back.hidden = step === 0;
    els.next.hidden = false;
    els.next.textContent = step === STEPS.length - 1 ? "Save to hub" : "Continue";
    setNote("");

    if (step === 0) renderBasics();
    else if (step === 1) renderDevices();
    else if (step === 2) renderButtons();
    else renderReview();
  }

  function renderBasics() {
    els.body.innerHTML = `
      <section class="panel wiz-panel">
        <h3>${editId ? `Rework “${escapeHtml(draft.name)}”` : "What is this activity?"}</h3>
        <p class="help">${editId
          ? "Name, devices, and buttons below replace its current setup when you save; advanced fields you can't see here are preserved."
          : "Examples: “Movie night”, “Saturday games”, “Vinyl”. The name shows on the remote's screen."}</p>
        <label for="wizName">Activity name</label>
        <input id="wizName" maxlength="96" value="${escapeHtml(draft.name)}" placeholder="Movie night" autocomplete="off">
        <label>What kind of activity is it?</label>
        <div class="wiz-kinds" role="group" aria-label="Activity kind">
          ${ACTIVITY_TYPES.map((t) => `
            <button type="button" class="wiz-kind ${Number(draft.type) === t.value ? "is-selected" : ""}" data-kind="${t.value}" aria-pressed="${Number(draft.type) === t.value}">
              ${t.label}
            </button>`).join("")}
        </div>
      </section>`;
    section.querySelector("#wizName")?.focus();
  }

  function renderDevices() {
    const devices = hub.devices();
    els.body.innerHTML = `
      <section class="panel wiz-panel">
        <h3>Which devices take part?</h3>
        <p class="help">Add each device this activity uses and give it a job. Devices power on in the order you add them — if one is slow to wake, give it a power-on delay.</p>
        <div class="wiz-roles" id="wizRoles">
          ${draft.roles.map((role, i) => roleRow(role, i, devices)).join("")}
        </div>
        <button type="button" class="btn btn-secondary" data-wiz="add-role" ${draft.roles.length >= devices.length ? "disabled" : ""}>Add a device</button>
      </section>`;
  }

  function roleRow(role, i, devices) {
    const device = devices.find((d) => d.id === role.deviceId);
    const inputs = inputOptions(device);
    const usedIds = new Set(draft.roles.map((r) => r.deviceId));
    return `
      <div class="wiz-role" data-role-index="${i}">
        <div class="wiz-role-grid">
          <div>
            <label>Device</label>
            <select data-field="deviceId">
              <option value="">Choose a device…</option>
              ${devices.map((d) => `<option value="${d.id}" ${d.id === role.deviceId ? "selected" : ""} ${usedIds.has(d.id) && d.id !== role.deviceId ? "disabled" : ""}>${escapeHtml(d.name)}</option>`).join("")}
            </select>
          </div>
          <div>
            <label>Its job</label>
            <select data-field="roleType">
              <option value="">Choose a job…</option>
              ${ROLE_TYPES.map((r) => `<option value="${r.type}" ${r.type === role.roleType ? "selected" : ""}>${r.label}</option>`).join("")}
            </select>
          </div>
          <div>
            <label>Input on start</label>
            <select data-field="input" ${inputs.length ? "" : "disabled"}>
              <option value="">No input change</option>
              ${inputs.map((o) => `<option value="${escapeHtml(o.value)}" ${o.value === role.input ? "selected" : ""}>${escapeHtml(o.value)}</option>`).join("")}
            </select>
          </div>
          <div>
            <label>Power-on delay (ms)</label>
            <input data-field="powerDelay" inputmode="numeric" pattern="[0-9]*" placeholder="0" value="${escapeHtml(role.powerDelay ?? "")}">
          </div>
          <button type="button" class="btn btn-quiet btn-sm wiz-role-remove" data-wiz="remove-role" aria-label="Remove this device">Remove</button>
        </div>
        ${role.roleType ? `<p class="help">${ROLE_TYPES.find((r) => r.type === role.roleType)?.hint ?? ""}</p>` : ""}
      </div>`;
  }

  function renderButtons() {
    const mappedCount = Object.keys(draft.buttons).length;
    const assignable = REMOTE_BUTTONS.filter((b) => BUTTON_KEY_BY_LABEL[b.label]);
    els.body.innerHTML = `
      <section class="panel wiz-panel">
        <h3>What should the buttons do?</h3>
        <p class="help">Click a key on the remote, then pick the device and command it sends. Mapped keys glow. Skip anything you don't need — you can refine later in the full editor.</p>
        <div class="wiz-map">
          <div class="ir-remote-shell wiz-remote">
            <div class="ir-remote-skin" id="wizRemoteBody" role="group" aria-label="Harmony remote — pick a key to map">
              <img src="${SKIN_SRC}" alt="Harmony remote control layout" width="591" height="1280" draggable="false">
              ${assignable.map((b) => {
                const key = BUTTON_KEY_BY_LABEL[b.label];
                const mapped = Boolean(draft.buttons[key]);
                return `<button type="button"
                  class="remote-hotspot wiz-key ${mapped ? "is-mapped" : ""} ${selectedKey === b.label ? "is-selected" : ""}"
                  data-key-label="${b.label}"
                  style="left:${b.x}%;top:${b.y}%;width:${b.w}%;height:${b.h}%"
                  aria-label="${b.label} — ${mapped ? "mapped" : "not mapped"}"
                  aria-pressed="${mapped}"></button>`;
              }).join("")}
            </div>
          </div>
          <div class="wiz-assign" id="wizAssign">
            ${selectedKey ? assignPanel() : `
              <div class="state-block">
                <span class="state-title">No key selected</span>
                Pick a key on the remote to assign it — ${mappedCount} of ${assignable.length} keys mapped so far.
              </div>`}
          </div>
        </div>
      </section>`;
  }

  function defaultAssignDevice() {
    const playback = draft.roles.find((r) => /Play|Channel/.test(r.roleType));
    return playback?.deviceId ?? draft.roles[0]?.deviceId ?? hub.devices()[0]?.id ?? "";
  }

  function assignPanel() {
    const key = BUTTON_KEY_BY_LABEL[selectedKey];
    const existing = draft.buttons[key];
    const devices = hub.devices();
    const deviceId = panelDeviceId || existing?.deviceId || defaultAssignDevice();
    const device = devices.find((d) => d.id === deviceId);
    const mappedCount = Object.keys(draft.buttons).length;
    return `
      <div class="wiz-assign-head">
        <h4>“${selectedKey}” sends…</h4>
        <span class="mono muted">${mappedCount} mapped</span>
      </div>
      <label for="wizAssignDevice">Device</label>
      <select id="wizAssignDevice">
        ${devices.map((d) => `<option value="${d.id}" ${d.id === deviceId ? "selected" : ""}>${escapeHtml(d.name)}</option>`).join("")}
      </select>
      <label for="wizAssignCommand">Command</label>
      <input id="wizAssignCommand" list="wizCommandList" placeholder="Type to search commands…" value="${escapeHtml(existing?.command?.name ?? "")}" autocomplete="off">
      <datalist id="wizCommandList">
        ${(device?.commands ?? []).map((c) => `<option value="${escapeHtml(c.name)}">`).join("")}
      </datalist>
      <div class="wiz-hold">
        <label class="wiz-hold-toggle" for="wizHoldToggle">
          <input type="checkbox" id="wizHoldToggle" ${existing?.hold ? "checked" : ""}>
          Holding the key does something else
        </label>
        <div id="wizHoldRow" ${existing?.hold ? "" : "hidden"}>
          <label for="wizHoldCommand">Hold command (same device)</label>
          <input id="wizHoldCommand" list="wizCommandList" placeholder="e.g. ${escapeHtml(existing?.command?.name ?? "Play")}" value="${escapeHtml(existing?.hold?.command?.name ?? "")}" autocomplete="off">
        </div>
      </div>
      <div class="wiz-assign-actions">
        <button type="button" class="btn btn-primary btn-sm" data-wiz="apply-key">Apply to “${selectedKey}”</button>
        ${existing ? `<button type="button" class="btn btn-quiet btn-sm" data-wiz="clear-key">Remove mapping</button>` : ""}
      </div>`;
  }

  function renderReview() {
    if (saved) {
      els.body.innerHTML = `
        <section class="panel wiz-panel wiz-done">
          <h3>“${escapeHtml(saved.name)}” is saved</h3>
          <p class="help">Written to the hub config and reloaded in the activity engine. It appears on the remote and in Control.</p>
          <div class="actions">
            <button type="button" class="btn btn-primary" data-wiz="run-saved">Run it now</button>
            <a class="btn btn-secondary" href="#control">Open remote</a>
            <a class="btn btn-quiet" href="#activities">All activities</a>
            <button type="button" class="btn btn-quiet" data-wiz="again">Set up another</button>
          </div>
        </section>`;
      els.next.hidden = true;
      els.back.hidden = true;
      setNote("");
      return;
    }
    els.next.hidden = false;
    const devices = hub.devices();
    const mapped = Object.entries(draft.buttons);
    els.body.innerHTML = `
      <section class="panel wiz-panel">
        <h3>Review “${escapeHtml(draft.name)}”</h3>
        <p class="help">${editId ? "Saving replaces this activity's setup in place." : "Saving adds a new activity at the end of the remote's list."}</p>
        <div class="wiz-review">
          <div class="wiz-review-card">
            <span class="eyebrow">Activity</span>
            <strong>${escapeHtml(draft.name)}</strong>
            <span class="muted">${ACTIVITY_TYPES.find((t) => t.value === Number(draft.type))?.label ?? "Activity"}</span>
          </div>
          <div class="wiz-review-card">
            <span class="eyebrow">Devices · ${draft.roles.length}</span>
            ${draft.roles.map((r) => {
              const d = devices.find((x) => x.id === r.deviceId);
              return `<span class="wiz-review-line"><strong>${escapeHtml(d?.name ?? r.deviceId)}</strong> — ${roleLabel(r.roleType)}${r.input ? ` · ${escapeHtml(r.input)}` : ""}${r.powerDelay ? ` · ${r.powerDelay}ms delay` : ""}</span>`;
            }).join("")}
          </div>
          <div class="wiz-review-card">
            <span class="eyebrow">Buttons · ${mapped.length}</span>
            ${mapped.length ? mapped.map(([key, m]) => {
              const d = devices.find((x) => x.id === m.deviceId);
              return `<span class="wiz-review-line"><strong>${key}</strong> → ${escapeHtml(d?.name ?? m.deviceId)} · ${escapeHtml(m.command.name)}${m.hold?.command ? ` (hold: ${escapeHtml(m.hold.command.name)})` : ""}</span>`;
            }).join("") : `<span class="wiz-review-line muted">No buttons mapped — the activity still runs, and you can map keys later in the full editor.</span>`}
          </div>
        </div>
      </section>`;
  }

  /* -- events --------------------------------------------------------- */

  function onBodyClick(e) {
    const kindBtn = e.target.closest("[data-kind]");
    if (kindBtn) {
      draft.type = Number(kindBtn.dataset.kind);
      els.body.querySelectorAll(".wiz-kind").forEach((b) => {
        const on = b === kindBtn;
        b.classList.toggle("is-selected", on);
        b.setAttribute("aria-pressed", String(on));
      });
      return;
    }
    const keyEl = e.target.closest(".wiz-key");
    if (keyEl) {
      selectedKey = keyEl.dataset.keyLabel;
      panelDeviceId = draft.buttons[BUTTON_KEY_BY_LABEL[selectedKey]]?.deviceId ?? defaultAssignDevice();
      renderButtons();
      return;
    }
    const act = e.target.closest("[data-wiz]")?.dataset.wiz;
    if (!act) return;
    if (act === "add-role") {
      const devices = hub.devices();
      const free = devices.find((d) => !draft.roles.some((r) => r.deviceId === d.id));
      draft.roles.push({ deviceId: free?.id ?? "", roleType: "", input: "", powerDelay: "" });
      renderDevices();
    } else if (act === "remove-role") {
      const row = e.target.closest("[data-role-index]");
      draft.roles.splice(Number(row.dataset.roleIndex), 1);
      renderDevices();
    } else if (act === "apply-key") {
      applyKey();
    } else if (act === "clear-key") {
      delete draft.buttons[BUTTON_KEY_BY_LABEL[selectedKey]];
      renderButtons();
    } else if (act === "run-saved" && saved) {
      hub.setRunning(saved.activityId).then(() => { location.hash = "#control"; });
    } else if (act === "again") {
      draft = emptyDraft();
      editId = "";
      saved = null;
      go(0);
    }
  }

  function onBodyChange(e) {
    const field = e.target.dataset.field;
    if (field) {
      const row = e.target.closest("[data-role-index]");
      const role = draft.roles[Number(row.dataset.roleIndex)];
      if (role) {
        role[field] = e.target.value;
        if (field === "deviceId" || field === "roleType") renderDevices();
      }
      return;
    }
    if (e.target.id === "wizHoldToggle") {
      section.querySelector("#wizHoldRow").hidden = !e.target.checked;
      return;
    }
    if (e.target.id === "wizAssignDevice") {
      panelDeviceId = e.target.value;
      renderButtons();
    }
  }

  function onBodyInput(e) {
    if (e.target.id === "wizName") draft.name = e.target.value;
  }

  function pickStart(id) {
    if (!id) {
      editId = "";
      draft = emptyDraft();
      renderBasics();
      return;
    }
    const activity = hub.activityById(id);
    if (!activity) return;
    editId = id;
    draft = emptyDraft();
    draft.name = hub.activityName(activity);
    draft.type = Number(activity.Type ?? 1);
    draft.roles = (activity.Roles ?? []).map((r) => ({
      deviceId: String(r["DeviceId-"]),
      roleType: String(r.__type ?? ""),
      input: r.SelectedInput?.Name ?? "",
      powerDelay: r.NextDevicePowerOnDelay ?? "",
    }));
    const maps = hub.buttonMapsForActivity(id);
    const surface = maps.find((m) => /^16414Activity/.test(String(m?.ButtonMapIdentifier ?? ""))) ?? maps[0];
    for (const b of surface?.Buttons ?? []) {
      if (!b.ButtonKey || !b.ButtonAction?.CommandName) continue;
      draft.buttons[b.ButtonKey] = {
        deviceId: String(b.ButtonAction["DeviceId-"]),
        command: { name: b.ButtonAction.CommandName, functionId: b.ButtonAction["FunctionId-"] },
        hold: b.ButtonLongPressAction?.CommandName
          ? {
              deviceId: String(b.ButtonLongPressAction["DeviceId-"]),
              command: { name: b.ButtonLongPressAction.CommandName, functionId: b.ButtonLongPressAction["FunctionId-"] },
            }
          : null,
      };
    }
    renderBasics();
  }

  function applyKey() {
    const deviceId = section.querySelector("#wizAssignDevice").value || panelDeviceId;
    const commandName = section.querySelector("#wizAssignCommand").value.trim();
    const device = hub.deviceById(deviceId);
    const command = device?.commands.find((c) => c.name === commandName);
    if (!command) {
      setNote(`“${commandName || "?"}” is not a command of ${device?.name ?? "that device"} — pick one from the list.`, true);
      return;
    }
    const holdOn = section.querySelector("#wizHoldToggle").checked;
    const holdName = holdOn ? section.querySelector("#wizHoldCommand").value.trim() : "";
    let hold = null;
    if (holdName) {
      const holdCommand = device.commands.find((c) => c.name === holdName);
      if (!holdCommand) {
        setNote(`Hold command “${holdName}” is not a command of ${device.name}.`, true);
        return;
      }
      hold = { deviceId, command: { name: holdCommand.name, functionId: holdCommand.functionId } };
    }
    draft.buttons[BUTTON_KEY_BY_LABEL[selectedKey]] = {
      deviceId,
      command: { name: command.name, functionId: command.functionId },
      hold,
    };
    setNote("");
    renderButtons();
  }

  async function save() {
    els.next.disabled = true;
    setNote("Saving to the hub…");
    try {
      const outcome = await saveDraft({
        config: hub.state.config,
        revision: hub.state.config?.revision,
        draft,
        editId: editId || null,
      });
      saved = { activityId: outcome.activityId, name: outcome.name };
      await hub.reloadConfig();
      renderReview();
    } catch (error) {
      setNote(`Save failed: ${error.message}`, true);
    } finally {
      els.next.disabled = false;
    }
  }

  mount();

  return {
    async onShow() {
      await hub.ensureConfig();
      draft = emptyDraft();
      editId = "";
      saved = null;
      step = 0;
      if (pendingEditId && hub.activityById(pendingEditId)) {
        pickStart(pendingEditId);
      }
      pendingEditId = "";
      render();
    },
    onHide() {},
  };
}
