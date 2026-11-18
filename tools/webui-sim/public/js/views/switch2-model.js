/* Nintendo Switch 2 wake-only devices (Option C BLE beacon): pure data and
   validation logic, importable under node:test.

   A Switch 2 wake device is an ordinary TransportType 64 hub device that
   codexactivity's CommitSwitch2Devices writer owns:
     - AutoDetectedDevice.Id starts with "melodious-switch2-"
     - Tokens.Parameters carries {d} (stable id "switch2<hex>"), {s2mac},
       {cmac} and {pid}
     - Commands has a single "Wake" command wired to PowerOnActions;
       PowerOffActions is empty (documented no-op). */

export const SWITCH2_TAG = "melodious-switch2-";

export const SWITCH2_CONTROLLER_TYPES = Object.freeze([
  { id: "joycon2-r", label: "Joy-Con 2 (Right)", pid: "6620", displayPid: "66 20", tested: true },
  { id: "joycon2-l", label: "Joy-Con 2 (Left)", pid: "6720", displayPid: "67 20", tested: true },
  { id: "pro2", label: "Switch 2 Pro Controller", pid: "6920", displayPid: "69 20", tested: true },
  { id: "custom", label: "Custom PID (advanced, untested)", pid: "", displayPid: "", tested: false },
]);

const KNOWN_PID_BY_VALUE = new Map(
  SWITCH2_CONTROLLER_TYPES.filter((t) => t.pid).map((t) => [t.pid, t]),
);

export function isSwitch2Entry(entry) {
  return String(entry?.Device?.AutoDetectedDevice?.Id ?? "").startsWith(SWITCH2_TAG);
}

export function isSwitch2Device(device) {
  return isSwitch2Entry(device?.entry ?? device);
}

function tokenValue(entryOrDevice, key) {
  const entry = entryOrDevice?.entry ?? entryOrDevice;
  const tokens = entry?.Device?.Tokens?.Parameters ?? [];
  const token = Array.isArray(tokens) ? tokens.find((t) => t?.Key === key) : null;
  return typeof token?.Value === "string" ? token.Value : "";
}

/** The device's stable Switch 2 id ("switch2<hex>"), or "". */
export function switch2IdOf(entryOrDevice) {
  return tokenValue(entryOrDevice, "{d}");
}

/** Stored Switch 2 wake config from Device.Tokens.Parameters. */
export function switch2ConfigOf(entryOrDevice) {
  const entry = entryOrDevice?.entry ?? entryOrDevice;
  const pid = tokenValue(entry, "{pid}").toUpperCase();
  const known = KNOWN_PID_BY_VALUE.get(pid);
  return {
    entity: switch2IdOf(entry),
    name: String(entry?.Device?.Name ?? ""),
    switch2Mac: tokenValue(entry, "{s2mac}").toUpperCase(),
    controllerMac: tokenValue(entry, "{cmac}").toUpperCase(),
    pid,
    controllerType: known ? known.id : "custom",
  };
}

/** Human-readable controller label for a stored 4-hex PID (e.g. "6620"). */
export function controllerTypeLabel(pid) {
  const clean = String(pid ?? "").replace(/[\s:-]/g, "").toUpperCase();
  const known = KNOWN_PID_BY_VALUE.get(clean);
  if (known) return `${known.label} (${known.displayPid})`;
  if (/^[0-9A-F]{4}$/.test(clean)) return `Custom PID (${clean.slice(0, 2)} ${clean.slice(2, 4)}, untested)`;
  return "Unknown controller";
}

/**
 * Validate and normalize a 6-byte Bluetooth MAC address.
 * Accepts AA:BB:CC:DD:EE:FF, AA-BB-CC-DD-EE-FF, or AABBCCDDEEFF.
 * Rejects non-hex, mixed separators, all-zero and FF:FF:FF:FF:FF:FF.
 */
export function normalizeMac(text, label = "MAC address") {
  const raw = String(text ?? "").trim();
  if (!raw) return { error: `Enter the ${label}.` };
  let hex = "";
  if (/^[0-9a-fA-F]{2}(:[0-9a-fA-F]{2}){5}$/.test(raw)) {
    hex = raw.replace(/:/g, "").toUpperCase();
  } else if (/^[0-9a-fA-F]{2}(-[0-9a-fA-F]{2}){5}$/.test(raw)) {
    hex = raw.replace(/-/g, "").toUpperCase();
  } else if (/^[0-9a-fA-F]{12}$/.test(raw)) {
    hex = raw.toUpperCase();
  } else {
    return { error: `${label} must be 6 hex bytes, such as AA:BB:CC:11:22:33.` };
  }
  if (hex === "000000000000" || hex === "FFFFFFFFFFFF") {
    return { error: `${label} cannot be all zeros or all FF.` };
  }
  const bytes = [];
  for (let i = 0; i < 12; i += 2) bytes.push(Number.parseInt(hex.slice(i, i + 2), 16));
  const mac = bytes.map((b) => b.toString(16).toUpperCase().padStart(2, "0")).join(":");
  return { mac, bytes };
}

/**
 * Validate and normalize a 2-byte controller PID in BLE wire order (<lo> <hi>).
 * Accepts "66 20", "66:20", "66-20", or "6620".
 */
export function normalizePid(text) {
  const raw = String(text ?? "").trim();
  if (!raw) return { error: "Enter a 2-byte hex PID (for example, 66 20)." };
  const m = raw.match(/^([0-9a-fA-F]{2})[\s:-]?([0-9a-fA-F]{2})$/);
  if (!m) return { error: "PID must be 2 hex bytes in wire order, such as 66 20." };
  const lo = m[1].toUpperCase();
  const hi = m[2].toUpperCase();
  return {
    pid: `${lo}${hi}`,
    display: `${lo} ${hi}`,
    bytes: [Number.parseInt(lo, 16), Number.parseInt(hi, 16)],
  };
}

/**
 * Build the exact 31-byte Switch 2 BLE wake advertisement payload from the PoC:
 *   02 01 06 1B FF 53 05 01 00 03 7E 05 <PID lo> <PID hi> 00 01 81
 *   <Switch 2 MAC reversed> 0F 00 00 00 00 00 00 00
 */
export function buildSwitch2WakePayload(switch2Mac, pid) {
  const macRes = normalizeMac(switch2Mac, "Switch 2 MAC");
  if (macRes.error) throw new Error(macRes.error);
  const pidRes = normalizePid(pid);
  if (pidRes.error) throw new Error(pidRes.error);
  const out = new Uint8Array(31);
  out.set([0x02, 0x01, 0x06, 0x1B, 0xFF, 0x53, 0x05, 0x01, 0x00, 0x03, 0x7E, 0x05], 0);
  out[12] = pidRes.bytes[0];
  out[13] = pidRes.bytes[1];
  out[14] = 0x00;
  out[15] = 0x01;
  out[16] = 0x81;
  for (let i = 0; i < 6; i += 1) out[17 + i] = macRes.bytes[5 - i];
  out[23] = 0x0F;
  // bytes 24..30 stay 0x00
  return out;
}

/** Validate a hub device name: 1-64 chars, no control chars, quotes or backslashes. */
export function switch2NameProblem(name) {
  const text = String(name ?? "").trim();
  if (!text) return "Give this Switch 2 device a name.";
  if (text.length > 64) return "The name can have up to 64 characters.";
  if (/[\u0000-\u001f\u007f"\\]/.test(text)) return "The name can't contain quotes or backslashes.";
  return "";
}

/** Validate the complete add/edit form; returns { spec } or { error, field }. */
export function validateSwitch2Form({ name, switch2Mac, controllerMac, controllerType, customPid }) {
  const nameErr = switch2NameProblem(name);
  if (nameErr) return { error: nameErr, field: "name" };

  const s2 = normalizeMac(switch2Mac, "Switch 2 Bluetooth MAC");
  if (s2.error) return { error: s2.error, field: "switch2Mac" };

  const ctrl = normalizeMac(controllerMac, "Bonded controller MAC");
  if (ctrl.error) return { error: ctrl.error, field: "controllerMac" };

  if (s2.mac === ctrl.mac) {
    return {
      error: "Bonded controller MAC must be your Joy-Con 2 or Pro Controller 2's MAC, not the Switch 2's own MAC.",
      field: "controllerMac",
    };
  }

  const preset = SWITCH2_CONTROLLER_TYPES.find((t) => t.id === controllerType);
  if (!preset) return { error: "Choose a controller type.", field: "controllerType" };

  const pidInput = preset.id === "custom" ? customPid : preset.pid;
  const pid = normalizePid(pidInput);
  if (pid.error) return { error: pid.error, field: "customPid" };

  return {
    spec: {
      name: String(name).trim(),
      switch2Mac: s2.mac,
      controllerMac: ctrl.mac,
      pid: pid.pid,
    },
  };
}

/** Generate a fresh stable Switch 2 id ("switch2" + 8 hex chars) not in existingIds. */
export function makeSwitch2Id(existingIds = new Set()) {
  const used = existingIds instanceof Set ? existingIds : new Set(existingIds);
  for (let i = 0; i < 64; i += 1) {
    const num = Math.floor(Math.random() * 0x100000000) >>> 0;
    const id = `switch2${num.toString(16).padStart(8, "0")}`;
    if (!used.has(id)) return id;
  }
  return `switch2${Date.now().toString(16).slice(-8).padStart(8, "0")}`;
}

/** Current Switch 2 wake devices on the hub, as CommitSwitch2Devices specs. */
export function switch2Specs(config) {
  const entries = config?.deviceList?.DevicesWithFeatures ?? [];
  return entries
    .filter(isSwitch2Entry)
    .map((entry) => {
      const cfg = switch2ConfigOf(entry);
      return {
        entity: cfg.entity,
        name: cfg.name,
        switch2Mac: cfg.switch2Mac,
        controllerMac: cfg.controllerMac,
        pid: cfg.pid,
      };
    })
    .filter((spec) => spec.entity && spec.switch2Mac && spec.controllerMac && spec.pid);
}

/** Whole device set for POST /api/switch2/devices: existing + add - remove. */
export function switch2DeviceSet(config, { add = null, remove = "" } = {}) {
  let devices = switch2Specs(config);
  if (remove) devices = devices.filter((d) => d.entity !== remove);
  if (add) {
    const entity = add.entity || makeSwitch2Id(devices.map((d) => d.entity));
    const idx = devices.findIndex((d) => d.entity === entity);
    const next = {
      entity,
      name: String(add.name ?? "").trim(),
      switch2Mac: add.switch2Mac,
      controllerMac: add.controllerMac,
      pid: add.pid,
    };
    if (idx >= 0) devices[idx] = next;
    else devices.push(next);
  }
  return { devices };
}
