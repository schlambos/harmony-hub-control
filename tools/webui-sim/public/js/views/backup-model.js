/* Backup page model: the /export/* surface of the hub plus a client-side
   preflight for POST /import. The validator mirrors the hub-side check
   (payload/source/codex_webui.c: validate_import_payload) closely enough
   that the browser rejects malformed payloads before they are uploaded;
   the hub remains the authority and its reply is always shown verbatim.
   Pure data logic — no DOM, no network — unit-testable under node:test. */

import { serializeForm } from "../setup-parsers.js";

/* Mirrors #define MAX_REQUEST_BODY (1024 * 1024) in codex_webui.c: the
   whole form-urlencoded body (target + URL-encoded payload) must fit.
   Larger bodies are truncated server-side and the import is rejected. */
export const MAX_REQUEST_BODY = 1024 * 1024;

/* Start warning as the encoded request approaches the limit. */
export const REQUEST_WARN_BYTES = 900 * 1024;

/* The ten resource/settings files the hub owns, in the order the legacy
   /import target select lists them. kind mirrors which automatic backup
   the hub takes on import (backup_resources vs backup_settings). */
export const RESOURCES = [
  { target: "devices", file: "DeviceList.json", kind: "resource", secret: false, desc: "Paired devices and learned buttons" },
  { target: "functions", file: "FunctionList.json", kind: "resource", secret: false, desc: "Command-to-function maps" },
  { target: "protocols", file: "ProtocolList.json", kind: "resource", secret: false, desc: "IR protocol definitions" },
  { target: "activities", file: "ActivityList.json", kind: "resource", secret: false, desc: "Activities and roles" },
  { target: "maps", file: "MapList.json", kind: "resource", secret: false, desc: "Remote button maps" },
  { target: "automation", file: "AutomationConfig.json", kind: "resource", secret: false, desc: "Automation settings" },
  { target: "mqtt", file: "mqtt-config.json", kind: "settings", secret: true, desc: "Broker settings, including password" },
  { target: "wifi", file: "wpa_supplicant.conf", kind: "settings", secret: true, desc: "Network credentials (PSK)" },
  { target: "cloud", file: "cloud-blocker.conf", kind: "settings", secret: false, desc: "Logitech cloud blocker flag" },
  { target: "bluetooth", file: "bt-devices.json", kind: "settings", secret: false, desc: "Paired Bluetooth devices" },
];

/* File keys embedded by send_bundle_download(), in emission order. */
export const BUNDLE_FILES = [
  { name: "DeviceList.json", secret: false },
  { name: "FunctionList.json", secret: false },
  { name: "ProtocolList.json", secret: false },
  { name: "ActivityList.json", secret: false },
  { name: "MapList.json", secret: false },
  { name: "AutomationConfig.json", secret: false },
  { name: "mqtt-config.json", secret: true },
  { name: "wpa_supplicant.conf", secret: true },
  { name: "bt-devices.json", secret: false },
  { name: "cloud-blocker.conf", secret: false },
];

/* Mirrors import_label_for_target() in codex_webui.c. */
export const IMPORT_LABELS = {
  bundle: "backup bundle",
  devices: "DeviceList.json",
  functions: "FunctionList.json",
  protocols: "ProtocolList.json",
  activities: "ActivityList.json",
  maps: "MapList.json",
  automation: "AutomationConfig.json",
  mqtt: "MQTT config",
  wifi: "Wi-Fi config",
  cloud: "cloud blocker setting",
  bluetooth: "Bluetooth devices",
};

/* The hub's cloud_value_known() also accepts disable values (0/off/false/
   disabled/allow/allowed), but this page deliberately only ever enables
   the blocker — a restore must never reopen cloud egress. */
export const CLOUD_ENABLE_VALUES = ["1", "on", "true", "enabled"];

/* The hub's cloud_value_known() accepts these disable tokens; a bundle
   embedding any of them would silently flip the blocker off via
   save_cloud_blocker(cloud_value_enabled(...)) -> "0". The client
   preflight rejects them so the upload never reaches the hub. */
export const CLOUD_DISABLE_VALUES = ["0", "off", "false", "disabled", "allow", "allowed"];

export function resourceByTarget(target) {
  return RESOURCES.find((r) => r.target === target) ?? null;
}

export function exportHref(target) {
  return `/export/${target}`;
}

const encoder = new TextEncoder();

export function utf8ByteLength(text) {
  return encoder.encode(String(text ?? "")).length;
}

export function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

/* Exact byte size of the body postHubForm("/import", { target, payload })
   sends — same URLSearchParams serializer as the transport layer. */
export function encodedImportSize(target, payload) {
  return utf8ByteLength(serializeForm({ target, payload: String(payload ?? "") }).toString());
}

/* Mirrors looks_like_json_object(): first non-space char is "{", last
   non-space char is "}". */
function looksLikeJsonObject(text) {
  const t = String(text).trim();
  return t.startsWith("{") && t.endsWith("}");
}

/* Mirrors cloud_value_enabled/cloud_value_known token handling: leading
   whitespace is skipped, the first token is lowercased, the rest ignored. */
function firstToken(text) {
  const match = String(text).trim().match(/^\S+/);
  return match ? match[0].toLowerCase() : "";
}

/* Mirrors json_string() in codex_webui.c: finds "key", skips to the first
   '"' after the ':', and copies until the closing '"' (handling \n, \t, and
   escaped quotes). Returns "" when the key is absent or the value is not a
   JSON string — exactly the hub's behavior, so the client preflight sees
   the same cloud-blocker.conf value the hub would extract and save. */
function bundleExtractString(bundle, key) {
  const needle = `"${key}"`;
  const start = String(bundle).indexOf(needle);
  if (start < 0) return "";
  let p = bundle.indexOf(":", start + needle.length);
  if (p < 0) return "";
  p += 1;
  while (p < bundle.length && /\s/.test(bundle[p])) p++;
  if (bundle[p] !== '"') return "";
  p += 1;
  let out = "";
  while (p < bundle.length && bundle[p] !== '"') {
    if (bundle[p] === "\\" && p + 1 < bundle.length) {
      p += 1;
      if (bundle[p] === "n") out += "\n";
      else if (bundle[p] === "t") out += "\t";
      else out += bundle[p];
    } else {
      out += bundle[p];
    }
    p += 1;
  }
  return out;
}

/* A bundle embeds cloud-blocker.conf. The hub's handle_import_bundle only
   writes the blocker when the trimmed value is non-empty, and otherwise
   leaves the current state untouched — so an absent/empty cloud key is
   safe. But any non-empty value reaches cloud_value_known (which accepts
   disable tokens) and then save_cloud_blocker(cloud_value_enabled(...)),
   which writes "0" for a disable token. This guard rejects disable
   tokens up front so a bundle restore can never reopen cloud egress. */
function validateBundleCloudBlocker(text) {
  const cloud = bundleExtractString(text, "cloud-blocker.conf");
  const token = firstToken(cloud);
  if (!token) return { ok: true };
  if (CLOUD_ENABLE_VALUES.includes(token)) return { ok: true };
  if (CLOUD_DISABLE_VALUES.includes(token)) {
    return fail(
      "Bundle embeds a cloud-blocker.conf value that would disable the blocker " +
        `("${token}"). The cloud blocker cannot be disabled through a restore — ` +
        "remove the cloud-blocker.conf key or set it to 1, on, true, or enabled.",
    );
  }
  return fail(
    `Bundle embeds an unknown cloud-blocker.conf value ("${token}"). ` +
      "Use 1, on, true, or enabled, or omit cloud-blocker.conf to keep the current state.",
  );
}

const JSON_OBJECT_ONLY = new Set(["automation"]);
const REQUIRED_KEYS = {
  devices: ["\"DevicesWithFeatures\""],
  functions: ["\"FunctionMaps\""],
  protocols: ["\"Protocols\""],
  activities: ["\"Activities\""],
  maps: ["\"ButtonMaps\""],
  mqtt: ["\"broker\"", "\"baseTopic\""],
};

const KEY_MESSAGES = {
  devices: "DeviceList import must contain DevicesWithFeatures.",
  functions: "FunctionList import must contain FunctionMaps.",
  protocols: "ProtocolList import must contain Protocols.",
  activities: "ActivityList import must contain Activities.",
  maps: "MapList import must contain ButtonMaps.",
  mqtt: "MQTT import must contain broker and baseTopic.",
};

function fail(message) {
  return { ok: false, message };
}

/** Client mirror of validate_import_payload(target, payload) in
    codex_webui.c, with one deliberate tightening: cloud accepts only
    enable values. Returns { ok: true } or { ok: false, message }. */
export function validateImportPayload(target, payload) {
  const text = String(payload ?? "").trim();
  if (!text) return fail("Import payload is empty.");

  if (target === "bundle") {
    if (
      looksLikeJsonObject(text) &&
      (text.includes("harmony-owner-bundle-v1") || text.includes("harmony-owner-bundle-v2")) &&
      text.includes("\"DeviceList.json\"")
    ) {
      return validateBundleCloudBlocker(text);
    }
    return fail("Bundle import must be a harmony-owner-bundle-v1 or v2 JSON export.");
  }

  if (target === "wifi") {
    if (text.includes("network={") && text.includes("ssid=")) return { ok: true };
    return fail("Wi-Fi import must look like a wpa_supplicant config with a network block and ssid.");
  }

  if (target === "cloud") {
    if (CLOUD_ENABLE_VALUES.includes(firstToken(text))) return { ok: true };
    return fail("This page only enables the cloud blocker: paste 1, on, true, or enabled. Disabling the blocker is not offered here.");
  }

  if (target === "bluetooth") {
    if (looksLikeJsonObject(text) && text.includes("\"devices\"")) return { ok: true };
    return fail("Bluetooth devices import must be a JSON object with a devices list.");
  }

  if (!(target in IMPORT_LABELS)) return fail(`Unknown import target "${target}".`);

  if (!looksLikeJsonObject(text)) {
    return fail(`${IMPORT_LABELS[target]} import must be a JSON object.`);
  }
  if (JSON_OBJECT_ONLY.has(target)) return { ok: true };

  const required = REQUIRED_KEYS[target] ?? [];
  for (const key of required) {
    if (!text.includes(key)) return fail(KEY_MESSAGES[target]);
  }
  return { ok: true };
}

/** Full client preflight for a restore: shape + encoded request size.
    Returns { valid, level: "ok"|"warn"|"error", message, payloadBytes,
    requestBytes }. level drives the notice color in the view. */
export function preflightImport(target, payload) {
  const raw = String(payload ?? "");
  const payloadBytes = utf8ByteLength(raw.trim());
  const requestBytes = encodedImportSize(target, raw);
  const sizeNote = `Request size ${formatBytes(requestBytes)} of the 1 MiB limit.`;

  const shape = validateImportPayload(target, raw);
  if (!shape.ok) {
    return { valid: false, level: "error", message: shape.message, payloadBytes, requestBytes };
  }
  if (requestBytes > MAX_REQUEST_BODY) {
    return {
      valid: false,
      level: "error",
      message: `Encoded request would be ${formatBytes(requestBytes)} — over the hub's 1 MiB body limit, which rejects it outright. Import one resource at a time instead.`,
      payloadBytes,
      requestBytes,
    };
  }
  if (requestBytes >= REQUEST_WARN_BYTES) {
    return {
      valid: true,
      level: "warn",
      message: `Shape looks right, but the encoded request is ${formatBytes(requestBytes)} — close to the 1 MiB limit the hub enforces. If it fails, import the resources one at a time.`,
      payloadBytes,
      requestBytes,
    };
  }
  return {
    valid: true,
    level: "ok",
    message: `${IMPORT_LABELS[target]} shape looks right. ${sizeNote}`,
    payloadBytes,
    requestBytes,
  };
}
