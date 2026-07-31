/* Bluetooth view (#bluetooth): pair the hub as a HID keyboard, find and link
   a target, send keys/text, and manage saved devices and commands.

   Transport is the shared api.js layer:
     - JSON endpoints (/api/bt-call, /api/bt-text, /api/bt-saved-command) via postApiForm
     - legacy hub form pages (/bt/device, /bt/command, /bt/delete-*) via postHubForm
     - reads (/export/bluetooth, /api/bt-text-status) via getText / getJson

   All dynamic values go through setup-kit's safe DOM (el/textContent) — no
   innerHTML. Destructive deletes use the two-step dangerGuard. State colors are
   honest: teal only for a genuinely authenticated link or a live FIFO runtime.
   No polling, no auto pair/connect/report on load, and no unpair is offered. */

import { el, clear, notice, viewHead, dangerGuard } from "../setup-kit.js";
import { getJson, getText, postApiForm, postHubForm } from "../api.js";
import {
  BT_TYPES,
  QUICK_KEYS,
  btTypeLabel,
  isValidBtAddr,
  normalizeBtAddr,
  isValidBtPin,
  isValidBtName,
  isAllowedBtType,
  isValidLabel,
  isValidScript,
  clampScanTimeout,
  clampGapMs,
  parseBtInventory,
  normalizeBtCall,
  parseTextStatus,
} from "./bluetooth-model.js";

let fieldSeq = 0;
function fieldId(name) {
  return `bt-${name}-${++fieldSeq}`;
}

/* -- Small builders ------------------------------------------------------ */

function textInput(name, attrs = {}) {
  const id = fieldId(name);
  const input = el("input", { attrs: { id, ...attrs } });
  return { id, input };
}

function selectInput(name, options, selected) {
  const id = fieldId(name);
  const select = el(
    "select",
    {
      attrs: { id },
      children: options.map((o) =>
        el("option", { text: o.label, attrs: { value: o.value, ...(o.value === selected ? { selected: "" } : {}) } }),
      ),
    },
  );
  return { id, select };
}

function textArea(name, attrs = {}) {
  const id = fieldId(name);
  const area = el("textarea", { attrs: { id, spellcheck: "false", ...attrs } });
  return { id, area };
}

function labeled(forId, labelText, control, hint) {
  const children = [el("label", { text: labelText, attrs: { for: forId } }), control];
  if (hint) children.push(el("p", { className: "setup-field-hint", text: hint }));
  return el("div", { children });
}

function panelWithHead(title, ariaLabel, headExtra) {
  const head = el("div", { className: "panel-head", children: [el("h3", { text: title })] });
  if (headExtra) head.appendChild(headExtra);
  const body = el("div", { className: "setup-fields" });
  const node = el("section", { className: "panel setup-panel", attrs: { "aria-label": ariaLabel }, children: [head, body] });
  return { node, body };
}

/** A status readout: a notice slot over a scrollable mono <pre> for raw hub output. */
function readout() {
  const noteSlot = el("div");
  const pre = el("pre", {
    className: "mono",
    attrs: { style: "max-height:240px;overflow:auto;white-space:pre-wrap" },
  });
  pre.hidden = true;
  const root = el("div", { className: "setup-status", children: [noteSlot, pre] });
  return {
    root,
    show({ kind, message, raw }) {
      clear(noteSlot);
      if (message) noteSlot.appendChild(notice(kind, message));
      pre.textContent = raw ?? "";
      pre.hidden = !raw;
    },
    clear() {
      clear(noteSlot);
      pre.textContent = "";
      pre.hidden = true;
    },
  };
}

function setBadge(badge, live, text) {
  clear(badge);
  if (live) badge.appendChild(el("span", { className: "live-dot", attrs: { "aria-hidden": "true" } }));
  badge.appendChild(el("span", { text }));
  badge.classList.toggle("pill-live", live);
  badge.classList.toggle("pill-dim", !live);
}

function kvList(rows) {
  return el(
    "dl",
    { className: "setup-kv", children: rows.map(([k, v]) => el("div", { children: [el("dt", { text: k }), el("dd", { text: v })] })) },
  );
}

async function withButton(btn, fn) {
  if (btn.disabled) return;
  btn.disabled = true;
  try {
    await fn();
  } finally {
    btn.disabled = false;
  }
}

function errMsg(err) {
  return err && err.message ? err.message : String(err);
}

/* -- View ---------------------------------------------------------------- */

export function createBluetoothView(section) {
  /* Connection badge lives in the view head, right-aligned. */
  const linkBadge = el("span", { className: "pill pill-dim", children: [el("span", { text: "Link unknown" })] });
  const head = viewHead(
    "Bluetooth",
    "Make the hub appear as a Bluetooth keyboard, pair the device you want to control, then send keys, text, and saved scripts.",
  );
  head.appendChild(el("div", { className: "view-actions", children: [linkBadge] }));
  section.appendChild(head);

  /* Shared keyboard profile, used by pairing, connect, and key sending. */
  const profileType = selectInput("profile", BT_TYPES, "btkeyboard");

  /* ---- Panel 1: Pairing & link ---------------------------------------- */
  const pair = panelWithHead("Pairing & link", "Bluetooth pairing and link status");
  const pairName = textInput("pair-name", { type: "text", value: "Harmony Keyboard", maxlength: "48" });
  const pairOut = readout();
  const linkCheckBtn = el("button", { type: "button", className: "btn btn-quiet btn-sm", text: "Check link" });
  const adapterBtn = el("button", { type: "button", className: "btn btn-quiet btn-sm", text: "Adapter status" });
  const pairOnBtn = el("button", { type: "button", className: "btn btn-primary", text: "Start pairing mode" });
  const pairOffBtn = el("button", { type: "button", className: "btn btn-secondary", text: "Stop pairing mode" });

  pair.body.append(
    el("div", {
      className: "row",
      children: [
        labeled(pairName.id, "Name shown while pairing", pairName.input, "1–48 letters, numbers, spaces, or . _ -"),
        labeled(profileType.id, "Keyboard profile", profileType.select, "Also used for connecting and sending keys."),
      ],
    }),
    el("div", { className: "setup-actions", children: [pairOnBtn, pairOffBtn, linkCheckBtn, adapterBtn] }),
    el("p", {
      className: "setup-field-hint",
      text:
        "Starting pairing registers the HID profile and makes the hub discoverable. Pair from the target's Bluetooth settings, then Check link — paired is not the same as an authenticated link.",
    }),
    pairOut.root,
  );
  section.appendChild(pair.node);

  /* ---- Panel 2: Find & connect ---------------------------------------- */
  const conn = panelWithHead("Find & connect", "Scan for and connect a Bluetooth target");
  const targetAddr = textInput("addr", { type: "text", placeholder: "AA:BB:CC:DD:EE:FF", autocomplete: "off", spellcheck: "false" });
  const pin = textInput("pin", { type: "text", inputmode: "numeric", placeholder: "Optional legacy PIN", autocomplete: "off" });
  const scanTimeout = textInput("timeout", { type: "text", inputmode: "numeric", value: "8" });
  const connOut = readout();
  const bleScanBtn = el("button", { type: "button", className: "btn btn-quiet btn-sm", text: "Scan BLE" });
  const classicScanBtn = el("button", { type: "button", className: "btn btn-quiet btn-sm", text: "Scan classic" });
  const connectBtn = el("button", { type: "button", className: "btn btn-secondary", text: "Connect" });
  const disconnectBtn = el("button", { type: "button", className: "btn btn-secondary", text: "Disconnect" });

  conn.body.append(
    el("div", {
      className: "row",
      children: [
        labeled(targetAddr.id, "Target address", targetAddr.input, "Leave blank to let the hub use the connected target."),
        labeled(pin.id, "PIN (if requested)", pin.input, "Up to 16 digits, only for legacy pairing."),
      ],
    }),
    el("div", {
      className: "row",
      children: [labeled(scanTimeout.id, "Scan time (seconds)", scanTimeout.input, "Clamped to 1–20."), el("div")],
    }),
    el("div", { className: "setup-actions", children: [bleScanBtn, classicScanBtn, connectBtn, disconnectBtn] }),
    connOut.root,
  );
  section.appendChild(conn.node);

  /* ---- Panel 3: Send keys & text -------------------------------------- */
  const keys = panelWithHead("Send keys & text", "Forward HID keys and exact text to the linked target");
  const keysOut = readout();
  const gapMs = textInput("gap", { type: "text", inputmode: "numeric", value: "35" });
  const customKey = textInput("custom-key", { type: "text", placeholder: "e.g. enter, f5, ctrl+l, alt+f4", autocomplete: "off" });
  const sendKeyBtn = el("button", { type: "button", className: "btn btn-quiet btn-sm", text: "Send key" });

  const keysGrid = el("div", {
    className: "setup-actions",
    attrs: { style: "gap:var(--space-2)" },
    children: QUICK_KEYS.map((k) =>
      el("button", { type: "button", className: "btn btn-quiet btn-sm", text: k.label, attrs: { "data-code": k.code } }),
    ),
  });
  keysGrid.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-code]");
    if (btn) sendKey(btn.dataset.code, btn);
  });

  const textBlock = textArea("text-block", { placeholder: "Paste exact text to type on the target" });
  const sendTextBtn = el("button", { type: "button", className: "btn btn-quiet btn-sm", text: "Send text" });

  keys.body.append(
    el("div", {
      className: "setup-field-hint",
      text: "Every send is triggered by you. Keys go over the low-level HID report path; text uses the exact-typing FIFO helper below.",
    }),
    keysGrid,
    el("div", {
      className: "row",
      children: [
        labeled(customKey.id, "Custom key or combo", customKey.input, "Names like enter, f5, or combos like ctrl+l."),
        labeled(gapMs.id, "Gap between keys (ms)", gapMs.input, "Clamped to 15–5000."),
      ],
    }),
    el("div", { className: "setup-actions", children: [sendKeyBtn] }),
    labeled(textBlock.id, "Exact text to type", textBlock.area),
    el("div", { className: "setup-actions", children: [sendTextBtn] }),
    keysOut.root,
  );
  section.appendChild(keys.node);

  /* ---- Panel 4: Text helper (FIFO runtime) ---------------------------- */
  const rt = panelWithHead("Text helper (FIFO runtime)", "Status of the background exact-typing runtime");
  const rtBadge = el("span", { className: "pill pill-dim", children: [el("span", { text: "unknown" })] });
  const rtCheckBtn = el("button", { type: "button", className: "btn btn-quiet btn-sm", text: "Check helper" });
  const rtKvSlot = el("div");
  rt.node.querySelector(".panel-head").appendChild(rtBadge);
  rt.body.append(el("div", { className: "setup-actions", children: [rtCheckBtn] }), rtKvSlot);
  section.appendChild(rt.node);

  /* ---- Panel 5: Saved devices & commands ------------------------------ */
  const saved = panelWithHead("Saved devices & commands", "Stored Bluetooth targets and reusable keyboard scripts");
  const savedOut = readout();
  const addName = textInput("add-name", { type: "text", placeholder: "Living room TV" });
  const addType = selectInput("add-type", BT_TYPES, "btkeyboard");
  const addAddr = textInput("add-addr", { type: "text", placeholder: "AA:BB:CC:DD:EE:FF", autocomplete: "off" });
  const addBtn = el("button", { type: "button", className: "btn btn-secondary", text: "Save device" });
  const savedList = el("div", { className: "setup-fields" });

  saved.body.append(
    el("div", {
      className: "row",
      children: [
        labeled(addName.id, "Device name", addName.input),
        labeled(addType.id, "Keyboard profile", addType.select),
      ],
    }),
    el("div", { className: "row", children: [labeled(addAddr.id, "Bluetooth address", addAddr.input), el("div")] }),
    el("div", { className: "setup-actions", children: [addBtn] }),
    savedOut.root,
    savedList,
  );
  section.appendChild(saved.node);

  /* ---- State helpers -------------------------------------------------- */

  let generation = 0; // invalidates stale async replies after re-show/hide

  function updateLink(connected, address) {
    setBadge(linkBadge, connected, connected ? `Link · ${address || "connected"}` : "No authenticated link");
  }

  function sharedFields() {
    const type = profileType.select.value;
    return { type, addr: normalizeBtAddr(targetAddr.input.value) };
  }

  /* ---- Panel 1 actions ------------------------------------------------ */

  async function pairingOn() {
    const name = pairName.input.value.trim();
    const type = profileType.select.value;
    if (!isValidBtName(name)) {
      pairOut.show({ kind: "error", message: "Pairing name must be 1–48 letters, numbers, spaces, or . _ -" });
      return;
    }
    if (!isAllowedBtType(type)) {
      pairOut.show({ kind: "error", message: "Choose a supported keyboard profile." });
      return;
    }
    await withButton(pairOnBtn, async () => {
      try {
        const r = normalizeBtCall(await postApiForm("/api/bt-call", { action: "pairing_on", name, type }));
        pairOut.show({
          kind: "ok",
          message: `Pairing mode active — hub is discoverable as “${name}” (${btTypeLabel(type)}). Pair from the target, then Check link.`,
          raw: r.raw,
        });
      } catch (err) {
        pairOut.show({ kind: "error", message: errMsg(err) });
      }
    });
  }

  async function pairingOff() {
    await withButton(pairOffBtn, async () => {
      try {
        const r = normalizeBtCall(await postApiForm("/api/bt-call", { action: "pairing_off" }));
        pairOut.show({ kind: "info", message: "Pairing mode stopped — the adapter is no longer discoverable.", raw: r.raw });
      } catch (err) {
        pairOut.show({ kind: "error", message: errMsg(err) });
      }
    });
  }

  async function checkLink() {
    await withButton(linkCheckBtn, async () => {
      try {
        const r = normalizeBtCall(await postApiForm("/api/bt-call", { action: "status" }));
        updateLink(r.connected, r.detectedAddress);
        pairOut.show({
          kind: r.connected ? "ok" : "info",
          message: r.connected
            ? `Authenticated HID link to ${r.detectedAddress}.`
            : "No authenticated HID link detected. Pair the target or Connect first.",
          raw: r.raw,
        });
      } catch (err) {
        pairOut.show({ kind: "error", message: errMsg(err) });
      }
    });
  }

  async function adapterStatus() {
    await withButton(adapterBtn, async () => {
      try {
        const r = normalizeBtCall(await postApiForm("/api/bt-call", { action: "adapter_status" }));
        updateLink(r.connected, r.detectedAddress);
        pairOut.show({ kind: "info", message: "Adapter status refreshed.", raw: r.raw });
      } catch (err) {
        pairOut.show({ kind: "error", message: errMsg(err) });
      }
    });
  }

  /* ---- Panel 2 actions ------------------------------------------------ */

  async function scan(ble) {
    const btn = ble ? bleScanBtn : classicScanBtn;
    const timeout = clampScanTimeout(scanTimeout.input.value);
    await withButton(btn, async () => {
      try {
        const fields = ble ? { action: "scan", timeout: String(timeout) } : { action: "classic_scan" };
        const r = normalizeBtCall(await postApiForm("/api/bt-call", fields));
        connOut.show({ kind: "info", message: `${ble ? "BLE" : "Classic"} scan complete.`, raw: r.raw });
      } catch (err) {
        connOut.show({ kind: "error", message: errMsg(err) });
      }
    });
  }

  async function connect() {
    const { type, addr } = sharedFields();
    const pinValue = pin.input.value.trim();
    if (!isAllowedBtType(type)) {
      connOut.show({ kind: "error", message: "Choose a supported keyboard profile." });
      return;
    }
    if (!isValidBtAddr(addr)) {
      connOut.show({ kind: "error", message: "Enter a valid target address (AA:BB:CC:DD:EE:FF) to connect." });
      return;
    }
    if (!isValidBtPin(pinValue)) {
      connOut.show({ kind: "error", message: "PIN must be up to 16 digits." });
      return;
    }
    await withButton(connectBtn, async () => {
      try {
        const fields = { action: "connect", type, bdaddr: addr };
        if (pinValue) fields.pin = pinValue;
        const r = normalizeBtCall(await postApiForm("/api/bt-call", fields));
        updateLink(r.connected, r.detectedAddress || addr);
        connOut.show({
          kind: r.connected ? "ok" : "info",
          message: r.connected ? `Connected to ${addr}.` : "Connect accepted, but no stable authenticated link formed.",
          raw: r.raw,
        });
      } catch (err) {
        connOut.show({ kind: "error", message: errMsg(err) });
      }
    });
  }

  async function disconnect() {
    const { type, addr } = sharedFields();
    if (addr && !isValidBtAddr(addr)) {
      connOut.show({ kind: "error", message: "Target address is not a valid MAC. Fix it or clear it to auto-detect." });
      return;
    }
    await withButton(disconnectBtn, async () => {
      try {
        const fields = { action: "disconnect", type };
        if (addr) fields.bdaddr = addr;
        const r = normalizeBtCall(await postApiForm("/api/bt-call", fields));
        updateLink(r.connected, r.detectedAddress);
        connOut.show({ kind: "info", message: "Disconnect requested.", raw: r.raw });
      } catch (err) {
        connOut.show({ kind: "error", message: errMsg(err) });
      }
    });
  }

  /* ---- Panel 3 actions ------------------------------------------------ */

  async function sendKey(code, btn) {
    const { type, addr } = sharedFields();
    const key = String(code ?? "").trim();
    if (!isAllowedBtType(type)) {
      keysOut.show({ kind: "error", message: "Choose a supported keyboard profile." });
      return;
    }
    if (addr && !isValidBtAddr(addr)) {
      keysOut.show({ kind: "error", message: "Target address is not a valid MAC. Fix it or clear it to auto-detect." });
      return;
    }
    if (!key) {
      keysOut.show({ kind: "error", message: "Enter a key or combo to send." });
      return;
    }
    const gap = clampGapMs(gapMs.input.value);
    await withButton(btn || sendKeyBtn, async () => {
      try {
        const fields = { action: "report", type, code: key, gapMs: String(gap) };
        if (addr) fields.bdaddr = addr;
        const r = normalizeBtCall(await postApiForm("/api/bt-call", fields));
        updateLink(r.connected, r.detectedAddress);
        keysOut.show({ kind: "ok", message: `Sent “${key}”.`, raw: r.raw });
      } catch (err) {
        keysOut.show({ kind: "error", message: errMsg(err) });
      }
    });
  }

  async function sendText() {
    const text = textBlock.area.value;
    if (!text) {
      keysOut.show({ kind: "error", message: "Enter some text to type." });
      return;
    }
    await withButton(sendTextBtn, async () => {
      try {
        const r = await postApiForm("/api/bt-text", { text });
        keysOut.show({ kind: "ok", message: `Sent ${r.bytes ?? text.length} byte(s) of text through the FIFO helper.` });
      } catch (err) {
        keysOut.show({ kind: "error", message: errMsg(err) });
      }
    });
  }

  /* ---- Panel 4 actions ------------------------------------------------ */

  async function loadTextStatus() {
    await withButton(rtCheckBtn, async () => {
      try {
        const s = parseTextStatus(await getJson("/api/bt-text-status"));
        setBadge(rtBadge, s.live, s.live ? "Text helper live" : `Text helper · ${s.state}`);
        clear(rtKvSlot);
        rtKvSlot.appendChild(
          kvList([
            ["Runtime", s.runtime ? "running" : "not running"],
            ["State", s.state],
            ["Target", s.target || "—"],
            ["Sent / skipped", `${s.sent} / ${s.skipped}`],
          ]),
        );
        if (s.error && !s.live) {
          rtKvSlot.appendChild(notice("info", s.error));
        }
      } catch (err) {
        setBadge(rtBadge, false, "Text helper · unknown");
        clear(rtKvSlot);
        rtKvSlot.appendChild(notice("error", errMsg(err)));
      }
    });
  }

  /* ---- Panel 5: saved devices & commands ------------------------------ */

  async function loadInventory() {
    const gen = generation;
    clear(savedList);
    savedList.appendChild(el("div", { className: "state-block", children: [el("div", { className: "skel" }), el("div", { className: "skel" })] }));
    try {
      const devices = parseBtInventory(await getText("/export/bluetooth"));
      if (gen !== generation) return;
      renderInventory(devices);
    } catch (err) {
      if (gen !== generation) return;
      clear(savedList);
      savedList.appendChild(notice("error", `Could not load saved Bluetooth devices: ${errMsg(err)}`));
    }
  }

  function renderInventory(devices) {
    clear(savedList);
    if (!devices.length) {
      savedList.appendChild(notice("info", "No saved Bluetooth devices yet. Pair and save a target above to store reusable commands."));
      return;
    }
    for (const dev of devices) savedList.appendChild(deviceCard(dev));
  }

  function deviceCard(dev) {
    const card = el("div", { className: "panel panel-inset" });

    const delBtn = el("button", { type: "button", className: "btn btn-danger btn-sm", text: "Delete device" });
    dangerGuard(delBtn, {
      consequence: `Removes “${dev.name}” and all of its saved commands from the hub.`,
      confirmLabel: "Confirm delete",
      onConfirm: () => removeDevice(dev.id, dev.name),
    });

    card.appendChild(
      el("div", {
        className: "panel-head",
        children: [
          el("div", {
            children: [
              el("h3", { text: dev.name }),
              el("div", { className: "mini muted mono", text: `${btTypeLabel(dev.type)} · ${dev.bdaddr || "no address"}` }),
            ],
          }),
          delBtn,
        ],
      }),
    );

    const commands = el("div", { className: "setup-fields" });
    if (dev.commands.length) {
      for (const cmd of dev.commands) commands.appendChild(commandRow(dev, cmd));
    } else {
      commands.appendChild(el("p", { className: "mini muted", text: "No keyboard commands saved for this device yet." }));
    }
    card.appendChild(commands);
    card.appendChild(commandEditor(dev));
    return card;
  }

  function commandRow(dev, cmd) {
    const row = el("div", { className: "callout" });
    const sendBtn = el("button", { type: "button", className: "btn btn-quiet btn-sm", text: "Send" });
    const delBtn = el("button", { type: "button", className: "btn btn-danger btn-sm", text: "Delete" });
    dangerGuard(delBtn, {
      consequence: `Deletes the “${cmd.name}” command from ${dev.name}.`,
      confirmLabel: "Confirm delete",
      onConfirm: () => removeCommand(dev.id, cmd.name),
    });

    row.appendChild(
      el("div", {
        className: "setup-actions",
        attrs: { style: "justify-content:space-between;margin-top:0" },
        children: [
          el("div", {
            children: [
              el("strong", { text: cmd.name }),
              el("div", { className: "mini muted", text: `${cmd.delayMs} ms between keys` }),
            ],
          }),
          el("div", { className: "setup-actions", attrs: { style: "margin-top:0" }, children: [sendBtn, delBtn] }),
        ],
      }),
    );
    row.appendChild(el("pre", { className: "mono mini", attrs: { style: "margin-top:var(--space-2);white-space:pre-wrap" }, text: cmd.script }));

    sendBtn.addEventListener("click", () => sendSaved(dev.id, cmd.name, sendBtn));
    return row;
  }

  function commandEditor(dev) {
    const name = textInput(`cmd-name-${dev.id}`, { type: "text", placeholder: "Command name" });
    const delay = textInput(`cmd-delay-${dev.id}`, { type: "text", inputmode: "numeric", value: "35" });
    const script = textArea(`cmd-script-${dev.id}`, { placeholder: "TEXT hello\nWAIT 300\nKEY enter\nCOMBO ctrl+l" });
    const saveBtn = el("button", { type: "button", className: "btn btn-secondary btn-sm", text: "Save command" });

    saveBtn.addEventListener("click", () => saveCommand(dev.id, name.input.value, delay.input.value, script.area.value, saveBtn));

    return el("div", {
      className: "setup-fields",
      attrs: { style: "margin-top:var(--space-4)" },
      children: [
        el("div", { className: "row", children: [labeled(name.id, "New command name", name.input), labeled(delay.id, "Gap (ms)", delay.input)] }),
        labeled(script.id, "Keyboard script", script.area),
        el("div", { className: "setup-actions", children: [saveBtn] }),
      ],
    });
  }

  async function addDevice() {
    const name = addName.input.value.trim();
    const type = addType.select.value;
    const addr = normalizeBtAddr(addAddr.input.value);
    if (!isValidLabel(name)) {
      savedOut.show({ kind: "error", message: "Device name is required (no control characters, quotes, or backslashes)." });
      return;
    }
    if (!isAllowedBtType(type)) {
      savedOut.show({ kind: "error", message: "Choose a supported keyboard profile." });
      return;
    }
    if (!isValidBtAddr(addr)) {
      savedOut.show({ kind: "error", message: "Enter a valid Bluetooth address (AA:BB:CC:DD:EE:FF)." });
      return;
    }
    await withButton(addBtn, async () => {
      try {
        const res = await postHubForm("/bt/device", { name, type, bdaddr: addr });
        savedOut.show({ kind: "ok", message: res.msg || `Saved device ${name}.` });
        addName.input.value = "";
        addAddr.input.value = "";
        await loadInventory();
      } catch (err) {
        savedOut.show({ kind: "error", message: errMsg(err) });
      }
    });
  }

  async function saveCommand(deviceId, name, delay, script, btn) {
    const cmdName = String(name ?? "").trim();
    if (!isValidLabel(cmdName)) {
      savedOut.show({ kind: "error", message: "Command name is required (no control characters, quotes, or backslashes)." });
      return;
    }
    if (!isValidScript(script)) {
      savedOut.show({ kind: "error", message: "Script must be non-empty, under 2048 characters, with no unusual control characters." });
      return;
    }
    await withButton(btn, async () => {
      try {
        const res = await postHubForm("/bt/command", { deviceId, name: cmdName, delayMs: String(clampGapMs(delay)), script });
        savedOut.show({ kind: "ok", message: res.msg || `Saved command ${cmdName}.` });
        await loadInventory();
      } catch (err) {
        savedOut.show({ kind: "error", message: errMsg(err) });
      }
    });
  }

  async function removeDevice(deviceId, name) {
    try {
      const res = await postHubForm("/bt/delete-device", { deviceId });
      savedOut.show({ kind: "ok", message: res.msg || `Deleted device ${name}.` });
      await loadInventory();
    } catch (err) {
      savedOut.show({ kind: "error", message: errMsg(err) });
    }
  }

  async function removeCommand(deviceId, command) {
    try {
      const res = await postHubForm("/bt/delete-command", { deviceId, command });
      savedOut.show({ kind: "ok", message: res.msg || `Deleted command ${command}.` });
      await loadInventory();
    } catch (err) {
      savedOut.show({ kind: "error", message: errMsg(err) });
    }
  }

  async function sendSaved(deviceId, command, btn) {
    await withButton(btn, async () => {
      try {
        const r = await postApiForm("/api/bt-saved-command", { deviceId, command });
        savedOut.show({ kind: "ok", message: r.message || `Sent command ${command}.` });
      } catch (err) {
        savedOut.show({ kind: "error", message: errMsg(err) });
      }
    });
  }

  /* ---- Wiring --------------------------------------------------------- */

  pairOnBtn.addEventListener("click", pairingOn);
  pairOffBtn.addEventListener("click", pairingOff);
  linkCheckBtn.addEventListener("click", checkLink);
  adapterBtn.addEventListener("click", adapterStatus);
  bleScanBtn.addEventListener("click", () => scan(true));
  classicScanBtn.addEventListener("click", () => scan(false));
  connectBtn.addEventListener("click", connect);
  disconnectBtn.addEventListener("click", disconnect);
  sendKeyBtn.addEventListener("click", () => sendKey(customKey.input.value));
  sendTextBtn.addEventListener("click", sendText);
  rtCheckBtn.addEventListener("click", loadTextStatus);
  addBtn.addEventListener("click", addDevice);

  /* app.js calls onShow when #bluetooth is shown, so state loads on demand —
     no boot-time requests, no polling, no automatic pair/connect/report. */
  function onShow() {
    generation += 1;
    checkLink();
    loadTextStatus();
    loadInventory();
  }

  function onHide() {
    generation += 1;
  }

  return { onShow, onHide };
}
