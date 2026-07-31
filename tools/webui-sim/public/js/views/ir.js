/* IR setup: device + command inventory, create/edit/delete, capture/learn,
   batch dry/live sweep with run-id cancel, IRDB import, RemoteCentral
   (outbound, offline by design) and the temporary IR lab target.

   Every mutation re-reads the hub's authoritative state (/api/inventory and
   /api/device-commands) — the UI never trusts its own copy. All dynamic DOM
   is built with the safe setup-kit primitives; there is no innerHTML. */

import { getJson, postApiForm, postHubForm } from "../api.js";
import { el, setText, clear, notice, dangerGuard } from "../setup-kit.js";
import {
  LIMITS,
  DEVICE_TYPES,
  isSafeLabel,
  isSafeRunId,
  clampDelay,
  makeRunId,
  analyzeCapture,
  normalizeSignal,
  chunkCommands,
  parseIrdbLines,
  remoteCentralCommands,
  normalizeRemoteCentralPath,
  describeInventory,
} from "./ir-model.js";

/* One amber primary on the whole page: the live sweep. Everything repeatable
   is btn-quiet, every delete is a red two-step danger guard. */
const T = {
  lead:
    "Manage the hub's IR devices and learned commands. Everything writes through the hub's own " +
    "parsers and is re-read after each save, so what you see is what the hub has.",
};

export function createIrView(section) {
  /* ---------------- state ---------------- */
  let inventory = null; // shaped by describeInventory
  let inventoryError = null;
  let selectedDeviceId = "";
  let commands = [];
  let commandsError = null;
  let captureSignal = null; // last analyzeCapture() result
  const lab = { deviceId: "", name: "" };
  const batch = {
    deviceId: "",
    chunk: 250,
    delay: 120,
    runId: "",
    running: false,
    sent: 0,
    total: 0,
    canceled: false,
    dry: true,
  };
  const batchLog = [];
  const refs = {};
  let mounted = false;
  let firstLoadDone = false;
  let generation = 0; // invalidates stale async replies after re-show/hide
  let labGuard;

  /* ---------------- tiny builders ---------------- */
  function button(label, className, onClick, extra = {}) {
    const b = el("button", {
      text: label,
      className: `btn ${className}`,
      attrs: { type: "button", ...(extra.attrs || {}) },
    });
    if (onClick) b.addEventListener("click", onClick);
    return b;
  }

  function field(labelText, input, hint) {
    const children = [el("label", { text: labelText, attrs: { for: input.id } }), input];
    if (hint) children.push(el("p", { className: "setup-field-hint", text: hint }));
    return el("div", { children });
  }

  function textInput(id, { value = "", placeholder = "", maxlength, autocomplete = "off" } = {}) {
    return el("input", {
      attrs: { id, type: "text", value, placeholder, maxlength, autocomplete },
    });
  }

  function setNotice(container, kind, message) {
    clear(container);
    if (message) container.appendChild(notice(kind, message));
  }

  function stateBlock(title, body) {
    return el("div", {
      className: "state-block",
      children: [el("span", { className: "state-title", text: title }), el("span", { text: body })],
    });
  }

  function skeleton(lines = 3) {
    const children = [];
    for (let i = 0; i < lines; i += 1) children.push(el("div", { className: "skel" }));
    return el("div", { children });
  }

  function panel({ label, title, actions = [], children = [] }) {
    const head = el("div", {
      className: "panel-head",
      children: [el("h3", { text: title }), el("div", { className: "view-actions", children: actions })],
    });
    return el("section", {
      className: "panel setup-panel",
      attrs: { "aria-label": label },
      children: [head, ...children],
    });
  }

  function deviceOptions(selectedId) {
    const devices = inventory?.devices ?? [];
    return devices.map((d) =>
      el("option", { text: d.name || d.id, attrs: { value: d.id, selected: d.id === selectedId || undefined } }));
  }

  function deviceById(id) {
    return (inventory?.devices ?? []).find((d) => d.id === String(id)) ?? null;
  }

  function asText(value) {
    return String(value ?? "");
  }

  /* ---------------- data (authoritative re-reads) ---------------- */
  async function loadInventory({ skeleton: showSkeleton = false } = {}) {
    if (showSkeleton) {
      inventoryError = null;
      renderInventory();
    }
    const gen = generation;
    try {
      const raw = await getJson("/api/inventory");
      if (gen !== generation) return;
      inventory = describeInventory(raw);
      if (!inventory.ok) throw new Error("the hub reported it could not read the inventory");
      inventoryError = null;
    } catch (error) {
      if (gen !== generation) return;
      inventoryError = error;
    }
    renderInventory();
  }

  async function loadCommands() {
    if (!selectedDeviceId) {
      commands = [];
      commandsError = null;
      renderCommands();
      return;
    }
    const gen = generation;
    try {
      const j = await getJson(`/api/device-commands?deviceId=${encodeURIComponent(selectedDeviceId)}`);
      if (gen !== generation) return;
      commands = Array.isArray(j.commands) ? j.commands : [];
      commandsError = null;
    } catch (error) {
      if (gen !== generation) return;
      commands = [];
      commandsError = error;
    }
    renderCommands();
  }

  async function refreshAll() {
    await loadInventory();
    if (selectedDeviceId && !deviceById(selectedDeviceId)) {
      selectedDeviceId = "";
      commands = [];
      commandsError = null;
    }
    if (batch.deviceId && !deviceById(batch.deviceId)) {
      batch.deviceId = "";
    }
    await loadCommands();
    renderDeviceSelects();
    renderBatchList();
  }

  /* After any create/update/delete/import/lab change the hub is the source of
     truth — throw away our copy and re-read it. */
  async function mutated() {
    await refreshAll();
  }

  /* ---------------- inventory render ---------------- */
  function inventoryStats() {
    if (!inventory) return el("div");
    const rows = [
      ["Devices", `${inventory.deviceCount} / ${inventory.displayDeviceLimit}`],
      ["Total commands", String(inventory.totalCommandCount)],
      ["Storage limit / device", String(inventory.storageCommandLimit)],
      ["Batch limit / request", String(inventory.batchCommandLimit)],
    ];
    return el("dl", {
      className: "setup-kv",
      children: rows.map(([k, v]) =>
        el("div", { children: [el("dt", { text: k }), el("dd", { className: "mono", text: v })] })),
    });
  }

  function deviceRow(device) {
    const meta = [device.manufacturer, device.model].filter(Boolean).join(" · ") || "no manufacturer / model";
    const status = el("span", {
      className: "pill",
      text: `${device.commands.length} cmd${device.commands.length === 1 ? "" : "s"}`,
    });
    const row = el("div", {
      className: "act-card",
      children: [
        el("div", {
          className: "act-main",
          children: [
            el("span", { className: "act-name", text: device.name || device.id }),
            el("span", { className: "act-meta", text: `${meta} · ${device.type || "device"} · #${device.id}` }),
          ],
        }),
        el("div", { className: "act-side", children: [status] }),
      ],
    });
    const side = row.querySelector(".act-side");

    const isSelected = device.id === selectedDeviceId;
    side.appendChild(
      button(isSelected ? "Commands ▾" : "Commands", isSelected ? "btn-secondary btn-sm" : "btn-quiet btn-sm", () => {
        selectedDeviceId = isSelected ? "" : device.id;
        captureSignal = null;
        renderCaptureSignal();
        loadCommands().then(renderDeviceSelects);
        renderInventory();
      }),
    );
    side.appendChild(
      button("Edit", "btn-quiet btn-sm", () => openDeviceForm(device)),
    );
    const del = button("Delete", "btn-danger btn-sm", null);
    dangerGuard(del, {
      consequence: `Permanently removes "${device.name}" and all of its learned commands from the hub.`,
      confirmLabel: "Delete device",
      onConfirm: () => deleteDevice(device.id),
    });
    side.appendChild(del);
    return row;
  }

  function renderInventory() {
    const body = refs.inventoryBody;
    clear(body);
    if (inventoryError) {
      const retry = button("Retry", "btn-quiet btn-sm", () => loadInventory({ skeleton: true }));
      body.appendChild(notice("error", `Could not load the IR inventory: ${inventoryError.message}.`));
      body.appendChild(retry);
      return;
    }
    if (!inventory) {
      body.appendChild(skeleton(4));
      return;
    }
    body.appendChild(inventoryStats());
    if (!inventory.devices.length) {
      body.appendChild(stateBlock("No IR devices yet", "Create one below, or import codes from a database."));
      return;
    }
    const list = el("div", { className: "stagger" });
    inventory.devices.forEach((d, i) => {
      const row = deviceRow(d);
      row.style.setProperty("--i", String(i));
      list.appendChild(row);
    });
    body.appendChild(list);
  }

  /* ---------------- device create / edit ---------------- */
  function openDeviceForm(device) {
    renderDeviceForm(device);
    refs.deviceFormPanel.hidden = false;
    refs.deviceFormPanel.scrollIntoView({ block: "nearest" });
  }

  function closeDeviceForm() {
    refs.deviceFormPanel.hidden = true;
  }

  function renderDeviceForm(device) {
    const editing = Boolean(device);
    const body = refs.deviceFormBody;
    clear(body);

    const name = textInput("irDevName", { value: device?.name ?? "", placeholder: "Living room TV", maxlength: LIMITS.name });
    const manufacturer = textInput("irDevMfr", { value: device?.manufacturer ?? "", placeholder: "Samsung", maxlength: LIMITS.manufacturer });
    const model = textInput("irDevModel", { value: device?.model ?? "", placeholder: "UN55…", maxlength: LIMITS.model });
    const type = el("select", {
      attrs: { id: "irDevType" },
      children: DEVICE_TYPES.map((t) =>
        el("option", { text: t, attrs: { value: t, selected: t === device?.type || undefined } })),
    });

    const status = el("div", { className: "setup-status" });
    const save = button(editing ? "Save device" : "Create device", "btn-secondary", async () => {
      const fields = {
        name: name.value.trim(),
        manufacturer: manufacturer.value.trim(),
        model: model.value.trim(),
        type: type.value,
      };
      for (const [key, max] of [["name", LIMITS.name], ["manufacturer", LIMITS.manufacturer], ["model", LIMITS.model], ["type", LIMITS.deviceType]]) {
        if (!isSafeLabel(fields[key], max)) {
          setNotice(status, "error", `"${key}" must be 1–${max} printable characters (no quotes or backslashes).`);
          return;
        }
      }
      save.disabled = true;
      setNotice(status, "info", editing ? "Saving device…" : "Creating device…");
      try {
        const res = editing
          ? await postHubForm("/ir/device", { deviceId: device.id, ...fields })
          : await postHubForm("/ir/new-device", fields);
        setNotice(status, "ok", res.msg || (editing ? "Device saved." : "Device created."));
        await mutated();
        closeDeviceForm();
      } catch (error) {
        setNotice(status, "error", error.message || "Device save failed.");
      } finally {
        save.disabled = false;
      }
    });

    body.appendChild(el("div", { className: "row", children: [
      field("Device name", name),
      field("Device type", type),
    ] }));
    body.appendChild(el("div", { className: "row", children: [
      field("Manufacturer", manufacturer),
      field("Model", model),
    ] }));
    body.appendChild(el("div", { className: "setup-actions", children: [
      save,
      button("Cancel", "btn-ghost", closeDeviceForm),
    ] }));
    body.appendChild(status);
    name.focus();
  }

  async function deleteDevice(deviceId) {
    const status = refs.inventoryStatus;
    setNotice(status, "info", "Deleting device…");
    try {
      const res = await postHubForm("/ir/delete-device", { deviceId });
      if (selectedDeviceId === deviceId) {
        selectedDeviceId = "";
        commands = [];
      }
      setNotice(status, "ok", res.msg || "Device deleted.");
      await mutated();
    } catch (error) {
      setNotice(status, "error", error.message || "Delete failed.");
    }
  }

  /* ---------------- commands render + CRUD ---------------- */
  function renderCommands() {
    const wrap = refs.commandsPanel;
    const body = refs.commandsBody;
    clear(body);
    if (!selectedDeviceId) {
      wrap.hidden = true;
      return;
    }
    wrap.hidden = false;
    const device = deviceById(selectedDeviceId);
    setText(refs.commandsTitle, `Commands — ${device?.name ?? selectedDeviceId}`);
    setText(refs.commandsCount, `${commands.length} stored`);

    if (commandsError) {
      body.appendChild(notice("error", `Could not load commands: ${commandsError.message}.`));
      return;
    }
    if (!commands.length) {
      body.appendChild(stateBlock("No commands on this device", "Add one below, learn one, or import from a database."));
      return;
    }
    const list = el("div");
    commands.forEach((c) => list.appendChild(commandRow(c)));
    body.appendChild(list);
  }

  function commandRow(command) {
    const badges = [];
    if (command.raw) badges.push(el("span", { className: "pill", text: "raw" }));
    else if (command.learned) badges.push(el("span", { className: "pill pill-sim", text: "learned" }));
    if (command.protocolId) badges.push(el("span", { className: "pill", text: `proto ${command.protocolId}` }));

    const sendStatus = el("span", { className: "mini muted", text: "" });
    const row = el("div", {
      className: "act-card",
      children: [
        el("div", {
          className: "act-main",
          children: [
            el("span", { className: "act-name mono", text: command.name }),
            el("span", { className: "act-meta", children: [...badges, el("span", { text: command.keycode ? " · has code" : "" })] }),
          ],
        }),
        el("div", { className: "act-side", children: [sendStatus] }),
      ],
    });
    const side = row.querySelector(".act-side");

    side.appendChild(
      button("Send", "btn-quiet btn-sm", async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        setText(sendStatus, "sending…");
        try {
          const j = await postApiForm("/api/ir-send", { deviceId: selectedDeviceId, command: command.name });
          setText(sendStatus, `sent · ${asText(j.reply).slice(0, 60)}`);
        } catch (error) {
          setText(sendStatus, "");
          setNotice(refs.commandsStatus, "error", `Send failed: ${error.message}`);
        } finally {
          btn.disabled = false;
        }
      }),
    );
    side.appendChild(button("Edit", "btn-quiet btn-sm", () => openCommandForm(command)));
    const del = button("Delete", "btn-danger btn-sm", null);
    dangerGuard(del, {
      consequence: `Removes the "${command.name}" command from this device.`,
      confirmLabel: "Delete command",
      onConfirm: () => deleteCommand(command.name),
    });
    side.appendChild(del);
    return row;
  }

  async function deleteCommand(commandName) {
    setNotice(refs.commandsStatus, "info", "Deleting command…");
    try {
      const res = await postHubForm("/ir/delete-command", { deviceId: selectedDeviceId, command: commandName });
      setNotice(refs.commandsStatus, "ok", res.msg || "Command deleted.");
      await mutated();
    } catch (error) {
      setNotice(refs.commandsStatus, "error", error.message || "Delete failed.");
    }
  }

  /* ---------------- command add / edit ---------------- */
  function openCommandForm(command) {
    renderCommandForm(command);
    refs.commandFormPanel.hidden = false;
    refs.commandFormPanel.scrollIntoView({ block: "nearest" });
  }

  function closeCommandForm() {
    refs.commandFormPanel.hidden = true;
  }

  function renderCommandForm(command) {
    const editing = Boolean(command);
    const body = refs.commandFormBody;
    clear(body);
    const device = deviceById(selectedDeviceId);

    const name = textInput("irCmdName", { value: command?.name ?? "", placeholder: "PowerToggle", maxlength: LIMITS.name });
    const initialMode = command ? (command.raw ? "raw" : "keycode") : "auto";
    const mode = el("select", {
      attrs: { id: "irCmdMode" },
      children: ["auto", "keycode", "nec", "raw"].map((m) =>
        el("option", { text: m, attrs: { value: m, selected: m === initialMode || undefined } })),
    });
    const protocol = textInput("irCmdProto", { value: command?.protocolId ? String(command.protocolId) : "2", placeholder: "2", maxlength: LIMITS.protocol });
    const keycode = textInput("irCmdKeycode", { value: command?.keycode ?? "", placeholder: "G:Toshiba 32 Bit:(0x…)(Repeat)():3", maxlength: LIMITS.keycode });
    const nec = textInput("irCmdNec", { value: "", placeholder: "0x04FB08F7", maxlength: LIMITS.nec });
    const raw = el("textarea", { attrs: { id: "irCmdRaw", placeholder: "F38000 P100 S200 …" } });

    const status = el("div", { className: "setup-status" });

    function syncMode() {
      const m = mode.value;
      keycode.closest("div").hidden = !(m === "keycode" || m === "auto");
      nec.closest("div").hidden = !(m === "nec" || m === "auto");
      raw.closest("div").hidden = !(m === "raw" || m === "auto");
      protocol.closest("div").hidden = m === "raw";
    }
    mode.addEventListener("change", syncMode);

    const save = button(editing ? "Save command" : "Add command", "btn-secondary", async () => {
      const deviceId = selectedDeviceId;
      if (!isSafeLabel(deviceId, LIMITS.deviceId)) {
        setNotice(status, "error", "Choose a valid device first.");
        return;
      }
      if (!isSafeLabel(name.value.trim(), LIMITS.name)) {
        setNotice(status, "error", `Command name must be 1–${LIMITS.name} printable characters (no quotes or backslashes).`);
        return;
      }
      let signal;
      try {
        signal = normalizeSignal({
          mode: mode.value,
          protocol: protocol.value,
          nec: nec.value,
          keycode: keycode.value,
          raw: raw.value,
        }, { defaultMode: editing ? "keycode" : "auto" });
      } catch (error) {
        setNotice(status, "error", error.message);
        return;
      }
      save.disabled = true;
      setNotice(status, "info", editing ? "Saving command…" : "Adding command…");
      try {
        const fields = { deviceId, name: name.value.trim(), mode: signal.mode, protocol: signal.protocol, nec: signal.nec, keycode: signal.keycode, raw: signal.raw };
        const res = editing
          ? await postHubForm("/ir/update-command", { ...fields, oldName: command.name })
          : await postHubForm("/ir/command", fields);
        setNotice(status, "ok", res.msg || "Command saved.");
        await mutated();
        closeCommandForm();
      } catch (error) {
        setNotice(status, "error", error.message || "Command save failed.");
      } finally {
        save.disabled = false;
      }
    });

    body.appendChild(el("p", {
      className: "help",
      text: device
        ? `Adding to "${device.name}" (#${device.id}). The hub stores keycode/NEC compactly and replays raw timings.`
        : "Select a device above to add a command to it.",
    }));
    body.appendChild(el("div", { className: "row", children: [field("Command name", name), field("Signal type", mode)] }));
    body.appendChild(el("div", { className: "row", children: [field("Protocol id", protocol), field("Keycode", keycode)] }));
    body.appendChild(el("div", { className: "row", children: [field("NEC hex", nec)] }));
    body.appendChild(field("Raw timing", raw));
    body.appendChild(el("div", { className: "setup-actions", children: [save, button("Cancel", "btn-ghost", closeCommandForm)] }));
    body.appendChild(status);
    syncMode();
    name.focus();
  }

  /* ---------------- learn: capture / test / save ---------------- */
  function renderCaptureSignal() {
    const box = refs.captureSignal;
    clear(box);
    if (!captureSignal) {
      box.appendChild(el("p", { className: "mini muted", text: "No capture yet — press Capture and point a remote at the hub." }));
      return;
    }
    if (captureSignal.empty) {
      box.appendChild(notice("warn",
        "No signal received. The emulated hub has no IR receiver, so ir.cap returns empty. " +
        "On real hardware, point the original remote at the hub and capture again."));
      return;
    }
    const rows = [["decoded as", captureSignal.mode]];
    if (captureSignal.keycode) rows.push(["keycode", captureSignal.keycode]);
    if (captureSignal.nec) rows.push(["nec", captureSignal.nec]);
    if (captureSignal.mode === "raw") rows.push(["raw", captureSignal.raw.slice(0, 120) + (captureSignal.raw.length > 120 ? "…" : "")]);
    rows.push(["protocol", String(captureSignal.protocolId)]);
    if (captureSignal.analysis) rows.push(["analysis", captureSignal.analysis]);
    box.appendChild(el("dl", {
      className: "setup-kv",
      children: rows.map(([k, v]) =>
        el("div", { children: [el("dt", { text: k }), el("dd", { className: "mono", text: v })] })),
    }));
  }

  async function doCapture() {
    const status = refs.learnStatus;
    refs.captureBtn.disabled = true;
    setNotice(status, "info", "listening for an IR frame…");
    try {
      const j = await postApiForm("/api/capture", {});
      captureSignal = analyzeCapture(j);
      renderCaptureSignal();
      setNotice(status, captureSignal.empty ? "warn" : "ok",
        captureSignal.empty ? "No signal — the emulator has no IR receiver." : "Capture decoded. Test it, then save it.");
    } catch (error) {
      captureSignal = null;
      renderCaptureSignal();
      setNotice(status, "error", `Capture failed: ${error.message}`);
    } finally {
      refs.captureBtn.disabled = false;
    }
  }

  async function doTestLearned() {
    const status = refs.learnStatus;
    const deviceId = refs.learnDevice.value;
    if (!isSafeLabel(deviceId, LIMITS.deviceId)) {
      setNotice(status, "error", "Choose a device to test against.");
      return;
    }
    if (!captureSignal || captureSignal.empty) {
      setNotice(status, "error", "Learn or enter a signal before testing.");
      return;
    }
    refs.learnTestBtn.disabled = true;
    setNotice(status, "info", "Testing the learned signal (the hub saves it briefly, sends it, then removes it)…");
    try {
      const j = await postApiForm("/api/ir-test-learned", {
        deviceId,
        name: refs.learnName.value.trim() || "Signal test",
        mode: captureSignal.mode,
        protocol: String(captureSignal.protocolId),
        nec: captureSignal.nec,
        keycode: captureSignal.keycode,
        raw: captureSignal.raw,
      });
      const tail = asText(j.reply).trim();
      setNotice(status, "ok", `Test sent${tail ? `: ${tail.slice(0, 160)}` : ""}.`);
      await mutated();
    } catch (error) {
      setNotice(status, "error", `Test failed: ${error.message}`);
    } finally {
      refs.learnTestBtn.disabled = false;
    }
  }

  async function doSaveLearned() {
    const status = refs.learnStatus;
    const deviceId = refs.learnDevice.value;
    const name = refs.learnName.value.trim();
    if (!isSafeLabel(deviceId, LIMITS.deviceId)) {
      setNotice(status, "error", "Choose a device to save to.");
      return;
    }
    if (!isSafeLabel(name, LIMITS.name)) {
      setNotice(status, "error", `Give the command a name (1–${LIMITS.name} printable characters).`);
      return;
    }
    if (!captureSignal || captureSignal.empty) {
      setNotice(status, "error", "Learn or enter a signal before saving.");
      return;
    }
    refs.learnSaveBtn.disabled = true;
    setNotice(status, "info", "Saving command…");
    try {
      const res = await postHubForm("/ir/command", {
        deviceId,
        name,
        mode: captureSignal.mode,
        protocol: String(captureSignal.protocolId),
        nec: captureSignal.nec,
        keycode: captureSignal.keycode,
        raw: captureSignal.raw,
      });
      setNotice(status, "ok", res.msg || "Command saved.");
      await mutated();
    } catch (error) {
      setNotice(status, "error", error.message || "Save failed.");
    } finally {
      refs.learnSaveBtn.disabled = false;
    }
  }

  /* ---------------- batch sweep ---------------- */
  function batchSelectedNames() {
    const boxes = [...refs.batchList.querySelectorAll("input[type=checkbox]")];
    return boxes.filter((b) => b.checked).map((b) => b.value);
  }

  function renderBatchList() {
    const list = refs.batchList;
    clear(list);
    const device = deviceById(batch.deviceId);
    if (!batch.deviceId || !device) {
      list.appendChild(el("p", { className: "mini muted", text: "Choose a device to load its commands." }));
      return;
    }
    if (!device.commands.length) {
      list.appendChild(el("p", { className: "mini muted", text: "This device has no saved commands." }));
      return;
    }
    const frag = el("div", { className: "setup-fields" });
    device.commands.forEach((c, i) => {
      const id = `irBatch_${i}_${c.name.replace(/[^A-Za-z0-9_-]/g, "_")}`;
      const box = el("input", { attrs: { id, type: "checkbox", value: c.name, checked: true } });
      frag.appendChild(el("label", {
        className: "mini",
        attrs: { for: id },
        children: [box, el("span", { className: "mono", text: ` ${c.name}` })],
      }));
    });
    list.appendChild(frag);
  }

  function updateBatchProgress() {
    const p = batch.total > 0 ? Math.min(1, batch.sent / batch.total) : 0;
    refs.batchFill.style.transform = `scaleX(${p})`;
    setText(refs.batchMeterLabel,
      batch.running
        ? `${batch.dry ? "dry-running" : "sending"} ${batch.sent} / ${batch.total}${batch.canceled ? " — cancelling" : ""}`
        : batch.total
          ? `${batch.dry ? "dry run" : "run"} ${batch.canceled ? "stopped" : "done"} · ${batch.sent} / ${batch.total}`
          : "idle");
  }

  function logBatch(line) {
    batchLog.unshift(line);
    if (batchLog.length > 40) batchLog.length = 40;
    const logEl = refs.batchLogEl;
    clear(logEl);
    batchLog.forEach((l) => logEl.appendChild(el("li", { className: "mono mini", text: l })));
  }

  function updateBatchButtons() {
    refs.batchDryBtn.disabled = batch.running;
    refs.batchLiveBtn.disabled = batch.running;
    refs.batchCancelBtn.disabled = !batch.running;
  }

  async function runBatch(dry) {
    const deviceId = batch.deviceId;
    if (!isSafeLabel(deviceId, LIMITS.deviceId)) {
      setNotice(refs.batchStatus, "error", "Choose a device to sweep.");
      return;
    }
    const names = batchSelectedNames();
    const { chunks, total, dropped } = chunkCommands(names, batch.chunk);
    if (!total) {
      setNotice(refs.batchStatus, "error", "No valid commands are selected.");
      return;
    }
    batch.dry = dry;
    batch.runId = makeRunId(dry ? "dry" : "live");
    if (!isSafeRunId(batch.runId)) batch.runId = "run_" + Date.now().toString(36);
    batch.running = true;
    batch.sent = 0;
    batch.total = total;
    batch.canceled = false;
    const delay = clampDelay(batch.delay);
    updateBatchButtons();
    updateBatchProgress();
    setNotice(refs.batchStatus, "info",
      `${dry ? "Dry-running" : "Sending"} ${total} command${total === 1 ? "" : "s"} as run ${batch.runId} ` +
      `(chunk ${chunks.length > 1 ? chunks.length + "×" : ""}${delay} ms gap)${dropped ? ` · ${dropped} invalid name(s) skipped` : ""}.`);
    logBatch(`run ${batch.runId}: ${total} commands, ${chunks.length} chunk(s), ${dry ? "dry" : "live"}, ${delay} ms`);

    try {
      for (let i = 0; i < chunks.length && !batch.canceled; i += 1) {
        const j = await postApiForm("/api/ir-batch-send", {
          deviceId,
          commands: chunks[i],
          delayMs: String(delay),
          dryRun: dry ? "1" : "0",
          runId: batch.runId,
        });
        batch.sent += Number(j.sent) || 0;
        if (j.canceled) batch.canceled = true;
        const fail = Number(j.failed) || 0;
        logBatch(
          `${dry ? "dry" : "live"} chunk ${i + 1}/${chunks.length}: sent ${j.sent}` +
          `${fail ? `, failed ${fail}` : ""}${Number(j.skipped) ? `, skipped ${j.skipped}` : ""}` +
          ` in ${j.elapsedMs} ms${j.lastReply ? ` · ${asText(j.lastReply).slice(0, 60)}` : ""}` +
          `${j.canceled ? " · canceled" : ""}`,
        );
        updateBatchProgress();
      }
      if (batch.canceled) {
        setNotice(refs.batchStatus, "warn", `Run ${batch.runId} canceled after ${batch.sent} command${batch.sent === 1 ? "" : "s"}.`);
      } else {
        setNotice(refs.batchStatus, "ok", `${dry ? "Dry run" : "Live send"} complete: ${batch.sent} command${batch.sent === 1 ? "" : "s"}${dry ? " (nothing was transmitted)" : ""}.`);
      }
    } catch (error) {
      logBatch(`run ${batch.runId} failed: ${error.message}`);
      setNotice(refs.batchStatus, "error", `Batch failed: ${error.message}`);
    } finally {
      batch.running = false;
      updateBatchButtons();
      updateBatchProgress();
      if (!dry) await refreshAll(); // a live send repairs protocols + takes backups — re-read
    }
  }

  async function cancelBatch() {
    if (!batch.runId) return;
    batch.canceled = true; // stop queueing further chunks locally
    refs.batchCancelBtn.disabled = true;
    try {
      await postApiForm("/api/ir-cancel", { runId: batch.runId });
      logBatch(`cancel requested for ${batch.runId}`);
    } catch (error) {
      logBatch(`cancel failed: ${error.message}`);
    }
    updateBatchButtons();
  }

  /* ---------------- IRDB import ---------------- */
  function updateImportPreview() {
    const { rows, skipped } = parseIrdbLines(refs.importPayload.value);
    setText(refs.importPreview, rows.length || skipped
      ? `${rows.length} command${rows.length === 1 ? "" : "s"} ready to stage · ${skipped} line${skipped === 1 ? "" : "s"} the hub will skip`
      : "Paste pipe rows (name|keycode) or IRDB CSV rows (name,protocol,device,subdevice,function).");
  }

  async function doImport() {
    const deviceId = refs.importDevice.value;
    const payload = refs.importPayload.value;
    if (!isSafeLabel(deviceId, LIMITS.deviceId)) {
      setNotice(refs.importStatus, "error", "Choose a device to import into.");
      return;
    }
    if (!payload.trim()) {
      setNotice(refs.importStatus, "error", "Paste some codes to import first.");
      return;
    }
    refs.importBtn.disabled = true;
    setNotice(refs.importStatus, "info", "Importing…");
    try {
      const j = await postApiForm("/api/irdb-import", { deviceId, payload });
      setNotice(refs.importStatus, "ok", j.message || "Import complete.");
      refs.importPayload.value = "";
      updateImportPreview();
      await mutated();
    } catch (error) {
      setNotice(refs.importStatus, "error", error.message || "Import failed.");
    } finally {
      refs.importBtn.disabled = false;
    }
  }

  /* ---------------- RemoteCentral (outbound, offline by design) -------- */
  async function doRemoteCentral() {
    const path = normalizeRemoteCentralPath(refs.rcPath.value);
    if (!path.startsWith("/cgi-bin/codes/")) {
      setNotice(refs.rcStatus, "error", "Path must stay inside /cgi-bin/codes/ — the hub rejects anything else.");
      return;
    }
    refs.rcBtn.disabled = true;
    clear(refs.rcResults);
    setNotice(refs.rcStatus, "info", "Asking the hub to fetch (outbound — may time out offline)…");
    try {
      const j = await getJson(`/api/remotecentral-fetch?path=${encodeURIComponent(path)}`);
      if (!j.ok) {
        setNotice(refs.rcStatus, "warn",
          `RemoteCentral fetch failed: ${j.error || "unknown error"}. Nothing was imported.`);
        return;
      }
      const rows = remoteCentralCommands(j.html);
      if (!rows.length) {
        setNotice(refs.rcStatus, "info", "Fetched the page, but found no Pronto codes to convert.");
        return;
      }
      setNotice(refs.rcStatus, "ok", `Found ${rows.length} Pronto code${rows.length === 1 ? "" : "s"}.`);
      const list = el("div", { className: "setup-fields" });
      rows.forEach((r) => {
        const addBtn = button("Add to import", "btn-quiet btn-sm", () => {
          if (!r.raw) return;
          const name = r.name.replace(/[|,"\\]/g, "").trim() || "Command";
          refs.importPayload.value += `${name}|raw|${r.raw}\n`;
          updateImportPreview();
          setNotice(refs.importStatus, "info", `Added "${name}" to the import payload.`);
        });
        if (!r.raw) addBtn.disabled = true;
        list.appendChild(el("div", {
          className: "act-card",
          children: [
            el("div", { className: "act-main", children: [
              el("span", { className: "act-name", text: r.name }),
              el("span", { className: "act-meta mono", text: r.raw ? `raw ${r.raw.slice(0, 40)}…` : "unsupported Pronto format" }),
            ] }),
            el("div", { className: "act-side", children: [addBtn] }),
          ],
        }));
      });
      refs.rcResults.appendChild(list);
    } catch (error) {
      setNotice(refs.rcStatus, "error", `RemoteCentral fetch error: ${error.message}.`);
    } finally {
      refs.rcBtn.disabled = false;
    }
  }

  /* ---------------- IR lab (temporary target) ---------------- */
  async function doLabTarget() {
    refs.labTargetBtn.disabled = true;
    setNotice(refs.labStatus, "info", "Preparing the temporary test device…");
    try {
      const j = await postApiForm("/api/ir-lab-target", {});
      lab.deviceId = j.deviceId || "";
      lab.name = j.name || "Temporary IR Test";
      setText(refs.labCurrent, lab.deviceId
        ? `${lab.name} · #${lab.deviceId} (${j.created ? "created" : "reused"})`
        : "no lab target");
      setNotice(refs.labStatus, "ok", j.message || "Lab target ready.");
      await mutated();
    } catch (error) {
      setNotice(refs.labStatus, "error", error.message || "Could not create the lab target.");
    } finally {
      refs.labTargetBtn.disabled = false;
    }
  }

  async function doLabClear() {
    if (!lab.deviceId) {
      setNotice(refs.labStatus, "error", "Set a lab target first.");
      return;
    }
    setNotice(refs.labStatus, "info", "Clearing the temporary device…");
    try {
      const j = await postApiForm("/api/ir-lab-clear", { deviceId: lab.deviceId });
      setNotice(refs.labStatus, "ok", j.message || "Temporary device cleared.");
      await mutated();
    } catch (error) {
      setNotice(refs.labStatus, "error", error.message || "Clear failed.");
    }
  }

  /* ---------------- shared device selects ---------------- */
  function renderDeviceSelects() {
    for (const sel of [refs.learnDevice, refs.importDevice]) {
      const current = sel.value;
      clear(sel);
      sel.appendChild(el("option", { text: "Choose a device…", attrs: { value: "" } }));
      deviceOptions(current).forEach((o) => sel.appendChild(o));
      sel.value = current;
    }
    // batch device select drives its own command checkbox list
    const current = batch.deviceId;
    clear(refs.batchDevice);
    refs.batchDevice.appendChild(el("option", { text: "Choose a device…", attrs: { value: "" } }));
    deviceOptions(current).forEach((o) => refs.batchDevice.appendChild(o));
    refs.batchDevice.value = current;
  }

  /* ---------------- mount (static skeleton) ---------------- */
  function mount() {
    if (mounted) return;
    mounted = true;

    // header
    section.appendChild(el("div", { className: "view-head", children: [
      el("div", { children: [el("h2", { text: "IR setup" }), el("p", { className: "view-lead", text: T.lead })] }),
      el("div", { className: "view-actions", children: [
        button("Refresh", "btn-quiet", () => refreshAll()),
      ] }),
    ] }));

    // inventory
    refs.inventoryStatus = el("div", { className: "setup-status" });
    refs.inventoryBody = el("div");
    const invPanel = panel({
      label: "IR devices",
      title: "Devices",
      actions: [button("Add device", "btn-secondary btn-sm", () => openDeviceForm(null))],
      children: [refs.inventoryBody, refs.inventoryStatus],
    });
    section.appendChild(invPanel);

    // device form (hidden)
    refs.deviceFormBody = el("div");
    refs.deviceFormPanel = panel({ label: "Device form", title: "Device details", children: [refs.deviceFormBody] });
    refs.deviceFormPanel.hidden = true;
    section.appendChild(refs.deviceFormPanel);

    // commands (hidden until a device is chosen)
    refs.commandsTitle = el("h3", { text: "Commands" });
    refs.commandsCount = el("span", { className: "mini muted", text: "" });
    refs.commandsBody = el("div");
    refs.commandsStatus = el("div", { className: "setup-status" });
    refs.commandsPanel = el("section", {
      className: "panel setup-panel",
      attrs: { "aria-label": "Device commands" },
      children: [
        el("div", { className: "panel-head", children: [
          refs.commandsTitle,
          el("div", { className: "view-actions", children: [
            refs.commandsCount,
            button("Add command", "btn-secondary btn-sm", () => openCommandForm(null)),
          ] }),
        ] }),
        refs.commandsBody,
        refs.commandsStatus,
      ],
    });
    refs.commandsPanel.hidden = true;
    section.appendChild(refs.commandsPanel);

    // command form (hidden)
    refs.commandFormBody = el("div");
    refs.commandFormPanel = panel({ label: "Command form", title: "Command details", children: [refs.commandFormBody] });
    refs.commandFormPanel.hidden = true;
    section.appendChild(refs.commandFormPanel);

    /* two-up: learn | batch */
    const midRow = el("div", { className: "row" });

    // learn panel
    refs.learnDevice = el("select", { attrs: { id: "irLearnDevice" } });
    refs.captureBtn = button("Capture", "btn-quiet", doCapture);
    refs.captureSignal = el("div");
    refs.learnName = textInput("irLearnName", { placeholder: "PowerToggle", maxlength: LIMITS.name });
    refs.learnTestBtn = button("Test signal", "btn-quiet", doTestLearned);
    refs.learnSaveBtn = button("Save as command", "btn-secondary", doSaveLearned);
    refs.learnStatus = el("div", { className: "setup-status" });
    midRow.appendChild(panel({
      label: "Learn a button",
      title: "Learn",
      children: [
        field("Device", refs.learnDevice),
        el("div", { className: "setup-actions", children: [refs.captureBtn] }),
        refs.captureSignal,
        field("Command name", refs.learnName),
        el("div", { className: "setup-actions", children: [refs.learnTestBtn, refs.learnSaveBtn] }),
        refs.learnStatus,
      ],
    }));

    // batch panel
    refs.batchDevice = el("select", { attrs: { id: "irBatchDevice" } });
    refs.batchDevice.addEventListener("change", () => {
      batch.deviceId = refs.batchDevice.value;
      renderBatchList();
    });
    refs.batchChunk = textInput("irBatchChunk", { value: String(batch.chunk), placeholder: "250", maxlength: 6 });
    refs.batchDelay = textInput("irBatchDelay", { value: String(batch.delay), placeholder: "120", maxlength: 6 });
    refs.batchList = el("div", {
      attrs: { style: "max-height:180px;overflow-y:auto" },
    });
    refs.batchDryBtn = button("Dry run", "btn-secondary", () => { batch.chunk = Number(refs.batchChunk.value); batch.delay = Number(refs.batchDelay.value); runBatch(true); });
    refs.batchLiveBtn = button("Live send", "btn-primary", () => { batch.chunk = Number(refs.batchChunk.value); batch.delay = Number(refs.batchDelay.value); runBatch(false); });
    refs.batchCancelBtn = button("Cancel run", "btn-danger", cancelBatch);
    refs.batchCancelBtn.disabled = true;
    refs.batchFill = el("div", {
      attrs: { style: "transform-origin:left;transform:scaleX(0);height:6px;border-radius:3px;background:var(--status-live);transition:transform var(--dur-med) var(--ease-out)" },
    });
    refs.batchMeterLabel = el("span", { className: "mini muted", text: "idle" });
    refs.batchLogEl = el("ul", { className: "event-log" });
    refs.batchStatus = el("div", { className: "setup-status" });
    midRow.appendChild(panel({
      label: "Batch sweep",
      title: "Batch sweep",
      children: [
        field("Device", refs.batchDevice),
        el("div", { className: "row", children: [
          field("Commands / request", refs.batchChunk, "1–1024 per request"),
          field("Gap (ms)", refs.batchDelay, "40–10000, hub clamps"),
        ] }),
        el("label", { text: "Commands to send" }),
        refs.batchList,
        el("div", { className: "setup-actions", children: [refs.batchDryBtn, refs.batchLiveBtn, refs.batchCancelBtn] }),
        el("div", { children: [
          el("div", { attrs: { style: "background:var(--surface-inset);border:1px solid var(--border-default);border-radius:3px;overflow:hidden" }, children: [refs.batchFill] }),
          refs.batchMeterLabel,
        ] }),
        refs.batchLogEl,
        refs.batchStatus,
      ],
    }));
    section.appendChild(midRow);

    /* two-up: import | remotecentral */
    const lowRow = el("div", { className: "row" });

    refs.importDevice = el("select", { attrs: { id: "irImportDevice" } });
    refs.importPayload = el("textarea", { attrs: { id: "irImportPayload", placeholder: "KEY_POWER,NEC,32,-1,8\nVolumeUp|keycode|G:Toshiba 32 Bit:(0x…)(Repeat)():3" } });
    refs.importPayload.addEventListener("input", updateImportPreview);
    refs.importPreview = el("p", { className: "mini muted", text: "" });
    refs.importBtn = button("Import", "btn-quiet", doImport);
    refs.importStatus = el("div", { className: "setup-status" });
    lowRow.appendChild(panel({
      label: "IRDB import",
      title: "Import codes",
      children: [
        field("Device", refs.importDevice),
        field("Codes", refs.importPayload),
        refs.importPreview,
        el("div", { className: "setup-actions", children: [refs.importBtn] }),
        refs.importStatus,
      ],
    }));

    refs.rcPath = textInput("irRcPath", { placeholder: "/cgi-bin/codes/lg/… or a remotecentral.com URL" });
    refs.rcBtn = button("Fetch", "btn-quiet", doRemoteCentral);
    refs.rcResults = el("div");
    refs.rcStatus = el("div", { className: "setup-status" });
    lowRow.appendChild(panel({
      label: "RemoteCentral",
      title: "RemoteCentral",
      children: [
        notice("info", "Outbound, offline by design: this asks the hub itself to read remotecentral.com through /api/remotecentral-fetch. The hub's outbound reader can fail (redirect, timeout, or blocked egress) and the error is shown as-is. Nothing is fetched until you press Fetch."),
        field("Path", refs.rcPath),
        el("div", { className: "setup-actions", children: [refs.rcBtn] }),
        refs.rcResults,
        refs.rcStatus,
      ],
    }));
    section.appendChild(lowRow);

    // lab
    refs.labTargetBtn = button("Set lab target", "btn-quiet", doLabTarget);
    refs.labCurrent = el("span", { className: "mini muted", text: "no lab target" });
    const labClearBtn = button("Clear lab device", "btn-danger", null);
    labGuard = dangerGuard(labClearBtn, {
      consequence: "Deletes every command on the temporary IR lab device.",
      confirmLabel: "Clear lab",
      onConfirm: doLabClear,
    });
    refs.labStatus = el("div", { className: "setup-status" });
    section.appendChild(panel({
      label: "IR lab",
      title: "Temporary IR lab",
      children: [
        el("p", { className: "help", text: "Stage throw-away commands on a scratch device, sweep them, then clear it — without touching your real devices." }),
        el("div", { className: "setup-actions", children: [refs.labTargetBtn, labClearBtn, refs.labCurrent] }),
        refs.labStatus,
      ],
    }));

    renderDeviceSelects();
    renderBatchList();
    updateBatchProgress();
    updateImportPreview();
  }

  mount();

  return {
    async onShow() {
      generation += 1;
      if (!firstLoadDone) {
        firstLoadDone = true;
        inventory = null;
        inventoryError = null;
        renderInventory();
      }
      await refreshAll();
    },
    onHide() {
      generation += 1;
      labGuard.disarm();
      // leaving the view does not cancel a run — the hub tracks it by run id.
    },
  };
}
