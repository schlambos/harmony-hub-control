/* Native LG webOS TVs (codex_webos): pure data, validation, and status helpers,
   importable under node:test without DOM dependencies.

   A native LG webOS TV is a TransportType 64 hub device owned by codexactivity's
   CommitWebOsDevices writer:
     - AutoDetectedDevice.Id starts with "melodious-webos-"
     - Tokens.Parameters carries {d} ("webos<hex>"), {host} (IPv4), {mac} (optional
       canonical MAC for Wake-on-LAN), and {keySlot} ("set" | "unset")
     - The actual pairing client-key NEVER leaves codex_webos's private 0600 file. */

export const WEBOS_TAG = "melodious-webos-";

export function isWebOsEntry(entry) {
  return String(entry?.Device?.AutoDetectedDevice?.Id ?? "").startsWith(WEBOS_TAG);
}

export function isWebOsDevice(device) {
  return isWebOsEntry(device?.entry ?? device);
}

function tokenValue(entryOrDevice, key) {
  const entry = entryOrDevice?.entry ?? entryOrDevice;
  const tokens = entry?.Device?.Tokens?.Parameters ?? [];
  const token = Array.isArray(tokens) ? tokens.find((t) => t?.Key === key) : null;
  return typeof token?.Value === "string" ? token.Value : "";
}

/** The TV's stable webOS id ("webos<hex>"), or "". */
export function webOsIdOf(entryOrDevice) {
  return tokenValue(entryOrDevice, "{d}");
}

/** Stored webOS config from Device.Tokens.Parameters (never contains a client-key). */
export function webOsConfigOf(entryOrDevice) {
  const entry = entryOrDevice?.entry ?? entryOrDevice;
  return {
    entity: webOsIdOf(entry),
    name: String(entry?.Device?.Name ?? ""),
    host: tokenValue(entry, "{host}"),
    mac: tokenValue(entry, "{mac}").toUpperCase(),
    paired: tokenValue(entry, "{keySlot}") === "set",
  };
}

/** Strict IPv4 address normalization, or null. */
export function normalizeWebOsHost(text) {
  const raw = String(text ?? "").trim();
  const parts = raw.split(".");
  if (parts.length !== 4) return null;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p) || Number(p) > 255) return null;
  }
  return parts.map(Number).join(".");
}

/** Optional 6-byte MAC address normalization (for Wake-on-LAN). */
export function normalizeWebOsMac(text) {
  const raw = String(text ?? "").trim();
  if (!raw) return { mac: "" };
  let hex = "";
  if (/^[0-9a-fA-F]{2}(:[0-9a-fA-F]{2}){5}$/.test(raw)) {
    hex = raw.replace(/:/g, "").toUpperCase();
  } else if (/^[0-9a-fA-F]{2}(-[0-9a-fA-F]{2}){5}$/.test(raw)) {
    hex = raw.replace(/-/g, "").toUpperCase();
  } else if (/^[0-9a-fA-F]{12}$/.test(raw)) {
    hex = raw.toUpperCase();
  } else {
    return { error: "TV MAC address must be 6 hex bytes, such as AA:BB:CC:11:22:33." };
  }
  if (hex === "000000000000" || hex === "FFFFFFFFFFFF") {
    return { error: "TV MAC address cannot be all zeros or all FF." };
  }
  const pairs = [];
  for (let i = 0; i < 12; i += 2) pairs.push(hex.slice(i, i + 2));
  return { mac: pairs.join(":") };
}

/** Hub device name check: 1-64 printable chars, no quotes or backslashes. */
export function webOsNameProblem(name) {
  const text = String(name ?? "").trim();
  if (!text) return "Give the LG webOS TV a name.";
  if (text.length > 64) return "The name can have up to 64 characters.";
  if (/[\u0000-\u001f\u007f"\\]/.test(text)) return "The name can't contain quotes or backslashes.";
  return "";
}

/** Validate add/edit form fields; returns { spec } or { error, field }. */
export function validateWebOsForm({ name, host, mac = "" }) {
  const nameErr = webOsNameProblem(name);
  if (nameErr) return { error: nameErr, field: "name" };

  const cleanHost = normalizeWebOsHost(host);
  if (!cleanHost) return { error: "Enter the TV's IPv4 address, such as 192.168.1.40.", field: "host" };

  const macRes = normalizeWebOsMac(mac);
  if (macRes.error) return { error: macRes.error, field: "mac" };

  return {
    spec: {
      name: String(name).trim(),
      host: cleanHost,
      mac: macRes.mac,
    },
  };
}

/** Generate a fresh stable webOS id ("webos" + 8 hex chars) not in existingIds. */
export function makeWebOsId(existingIds = new Set()) {
  const used = existingIds instanceof Set ? existingIds : new Set(existingIds);
  for (let i = 0; i < 64; i += 1) {
    const num = Math.floor(Math.random() * 0x100000000) >>> 0;
    const id = `webos${num.toString(16).padStart(8, "0")}`;
    if (!used.has(id)) return id;
  }
  return `webos${Date.now().toString(16).slice(-8).padStart(8, "0")}`;
}

/** Map codex_webos tv.inputs -> CommitWebOsDevices inputs list (stable HDMI port IDs). */
export function webOsInputsFromTv(tv) {
  const raw = Array.isArray(tv?.inputs) ? tv.inputs : [];
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    const id = String(item?.id ?? "");
    const m = id.match(/^HDMI_([1-9]\d?)$/);
    if (!m) continue;
    const num = Number(m[1]);
    if (num < 1 || num > 16) continue;
    const cmd = `Input HDMI ${num}`;
    if (seen.has(cmd)) continue;
    seen.add(cmd);
    out.push({ name: `HDMI ${num}`, command: cmd });
  }
  return out;
}

/** Map codex_webos tv.apps -> CommitWebOsDevices apps list. */
export function webOsAppsFromTv(tv) {
  const raw = Array.isArray(tv?.apps) ? tv.apps : [];
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    const cmd = String(item?.command ?? "").trim();
    const id = String(item?.id ?? "").trim();
    if (!cmd || !/^App [\w][\w _.+-]*$/.test(cmd) || cmd.length > 48) continue;
    if (seen.has(cmd.toLowerCase())) continue;
    seen.add(cmd.toLowerCase());
    out.push(id ? { name: cmd, id } : { name: cmd });
    if (out.length >= 48) break;
  }
  return out;
}

/** Current native LG webOS TVs on the hub as CommitWebOsDevices specs. */
export function webOsSpecs(config) {
  const entries = config?.deviceList?.DevicesWithFeatures ?? [];
  return entries
    .filter(isWebOsEntry)
    .map((entry) => {
      const cfg = webOsConfigOf(entry);
      return {
        entity: cfg.entity,
        name: cfg.name,
        host: cfg.host,
        ...(cfg.mac ? { mac: cfg.mac } : {}),
        paired: cfg.paired,
      };
    })
    .filter((spec) => spec.entity && spec.host);
}

/** Whole device set for POST /api/webos/devices: existing + add - remove. */
export function webOsDeviceSet(config, { add = null, remove = "" } = {}) {
  let devices = webOsSpecs(config);
  if (remove) devices = devices.filter((d) => d.entity !== remove);
  if (add) {
    const entity = add.entity || makeWebOsId(devices.map((d) => d.entity));
    const idx = devices.findIndex((d) => d.entity === entity);
    const next = {
      entity,
      name: String(add.name ?? "").trim(),
      host: add.host,
      ...(add.mac ? { mac: add.mac } : {}),
      paired: Boolean(add.paired),
      ...(Array.isArray(add.inputs) ? { inputs: add.inputs } : {}),
      ...(Array.isArray(add.apps) ? { apps: add.apps } : {}),
    };
    if (idx >= 0) devices[idx] = next;
    else devices.push(next);
  }
  return { devices };
}

const WEBOS_WAKE_COMMANDS = new Set(["PowerOn", "PowerOff", "PowerToggle"]);

/**
 * Why a command can't reach this LG webOS TV right now, or "". The hub's
 * engine posts commands to codex_webos without waiting for an answer, so a
 * key for a TV that is off would otherwise look sent. Power commands always
 * go through: they wake the TV (Wake-on-LAN) or are harmless when it's off.
 */
export function webOsSendBlocker(tv, command) {
  if (!tv || tv.connected || WEBOS_WAKE_COMMANDS.has(command)) return "";
  if (!tv.paired) return "the TV isn't paired yet";
  return tv.standby ? "the TV is off (standby)" : "the TV is off or unreachable";
}

/** One-line status summary for an LG webOS TV on its device page. */
export function webOsStatusText(tv, cfg = null) {
  const host = tv?.host || cfg?.host || "";
  const paired = Boolean(tv ? tv.paired : cfg?.paired);
  if (!paired) {
    return `Unpaired${host ? ` · ${host}` : ""} — open Edit details and tap Pair to accept on the TV.`;
  }
  if (tv?.connected) {
    const vol = Number(tv.volume) >= 0 ? ` · Volume ${tv.volume}${tv.muted ? " (muted)" : ""}` : "";
    const ptr = tv.pointerReady ? "" : " · remote keys unavailable";
    return `Paired · Connected${vol}${ptr}${host ? ` · ${host}` : ""}`;
  }
  const why = tv?.error ? ` (${tv.error})` : "";
  const wake = (tv?.mac || cfg?.mac)
    ? "Power On wakes it via Wake-on-LAN."
    : "Add the TV's MAC address in Edit details for Wake-on-LAN Power On.";
  return `Paired · Off or unreachable${why}${host ? ` · ${host}` : ""}. ${wake}`;
}

/** Pairing progress copy for codex_webos /pair/status states. */
export function webOsPairStateText(state, name) {
  const label = name || "the TV";
  switch (state) {
    case "connecting":
      return `Connecting to ${label}…`;
    case "prompt":
      return `Check ${label}'s screen and choose Accept to finish pairing…`;
    case "paired":
      return `Paired with ${label}.`;
    case "denied":
      return `Pairing was declined on ${label}. Tap Pair to try again.`;
    case "failed":
      return `Could not pair with ${label}.`;
    default:
      return "";
  }
}
