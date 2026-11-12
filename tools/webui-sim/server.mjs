#!/usr/bin/env node
// SIMULATED HUB — no live device
//
// Zero-dependency mock of the harmony-hub-control local web API for offline
// UI development. Binds 127.0.0.1 only and never opens outbound connections.
//
// Run:  node tools/webui-sim/server.mjs
// Then: http://127.0.0.1:8787

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import {
  applyDeviceSettings,
  commandNames,
  inputsInUse,
  validateDeviceSettings,
} from "./public/js/views/device-settings-model.js";
import { LIMITS, isSafeLabel } from "./public/js/views/ir-model.js";
import { MAX_ACTIVITIES, isRestrictableId, normalizeWindows, restrictedAt } from "./public/js/views/restrictions-model.js";
import { validateStatic } from "./public/js/views/ethernet-model.js";

const SIM_DIR = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(SIM_DIR, "public");
const FIXTURE_PATH = path.join(SIM_DIR, "fixtures", "activity-config.json");
const HOST = "127.0.0.1";
const PORT = Number(process.env.PORT || 8787);
const MAX_BODY = 64 * 1024 * 1024;
const EVENT_LOG_LIMIT = 50;

// The shell lazy-loads the vendor editor from the hub's absolute routes;
// in the sim those map onto the vendored copies under public/vendor/.
const ASSET_ALIASES = {
  "/assets/activity-ui.js": "/vendor/activity-ui.js",
  "/assets/activity-ui.css": "/vendor/activity-ui.css"
};

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8"
};

const state = {
  revision: "",
  activityList: { Activities: [] },
  mapList: { ButtonMaps: [] },
  functionList: { FunctionMaps: [] },
  deviceList: { DevicesWithFeatures: [] },
  currentActivityId: "-1",
  haState: { version: 0, receivedMs: 0, states: [], rates: new Map() },
  events: []
};

function newRevision() {
  return `${crypto.randomBytes(4).toString("hex")}-${crypto.randomBytes(4).toString("hex")}`;
}

function loadFixture() {
  const parsed = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8"));
  state.revision = typeof parsed.revision === "string" && parsed.revision
    ? parsed.revision
    : newRevision();
  state.activityList = parsed.activityList || { Activities: [] };
  state.mapList = parsed.mapList || { ButtonMaps: [] };
  state.functionList = parsed.functionList || { FunctionMaps: [] };
  state.deviceList = parsed.deviceList || { DevicesWithFeatures: [] };
  state.currentActivityId = "-1";
  state.haState = { version: 0, receivedMs: 0, states: [], rates: new Map() };
}

function logEvent(entry) {
  state.events.push({ ts: new Date().toISOString(), ...entry });
  if (state.events.length > EVENT_LOG_LIMIT) {
    state.events.splice(0, state.events.length - EVENT_LOG_LIMIT);
  }
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonical(value[key]);
    return out;
  }
  return value;
}

function jsonEqual(a, b) {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

function sendJson(res, status, payload, extraHeaders = {}) {
  const body = `${JSON.stringify(payload)}\n`;
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    ...extraHeaders
  });
  res.end(body);
}

function sendError(res, status, error, extra = {}) {
  sendJson(res, status, { ok: false, error, ...extra });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error("request body is too large for this hub"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function parseParams(req, url) {
  const params = {};
  for (const [key, value] of url.searchParams) params[key] = value;
  if (req.method === "POST" || req.method === "PUT" || req.method === "PATCH") {
    const raw = await readBody(req);
    const type = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
    if (raw) {
      if (type === "application/json") {
        try {
          const parsed = JSON.parse(raw);
          // The raw body, for routes that check JSON tokens the way codex_webui does.
          Object.defineProperty(params, "__raw", { value: raw, enumerable: false });
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            Object.assign(params, parsed);
          } else {
            params.__json = parsed;
          }
        } catch {
          throw Object.assign(new Error("invalid JSON body"), { status: 400 });
        }
      } else {
        // application/x-www-form-urlencoded and anything else form-like
        for (const [key, value] of new URLSearchParams(raw)) params[key] = value;
      }
    }
  }
  return params;
}

function devicesWithFeatures() {
  return Array.isArray(state.deviceList.DevicesWithFeatures)
    ? state.deviceList.DevicesWithFeatures
    : [];
}

function findDeviceEntry(deviceId) {
  const id = String(deviceId);
  return devicesWithFeatures().find((entry) =>
    String(entry && entry.Device && entry.Device["Id-"]) === id);
}

function summarizeCommand(command) {
  const keycode = command && command.KeyCode ? String(command.KeyCode) : "";
  return {
    id: String((command && command["Id-"]) ?? 0),
    name: String((command && (command.Name ?? command.CommandName)) ?? ""),
    keycode,
    protocolId: Number((command && command.ProtocolId) ?? 0),
    learned: Boolean(command && command.IsLearned),
    raw: Boolean(command && command.Raw != null && !keycode)
  };
}

function activities() {
  return Array.isArray(state.activityList.Activities) ? state.activityList.Activities : [];
}

function activityExists(activityId) {
  const id = String(activityId);
  return activities().some((activity) => String(activity["Id-"] ?? activity.Id) === id);
}

function stateReply() {
  // Mirrors harmony.engine?getCurrentActivity; activity-ui.js extractCurrentActivity()
  // accepts a nested "result" / "activityId" key in the JSON reply string.
  return JSON.stringify({ result: state.currentActivityId, code: 200, msg: "OK" });
}

const HA_STATE_STALE_MS = 90000;
const HA_STATE_RATE_LIMIT_MS = 1000;
const MAX_HA_STATE_BODY = 65536;
const MAX_HA_STATES = 64;

function currentHaStateSnapshot() {
  const version = state.haState.version;
  const receivedMs = state.haState.receivedMs;
  const stale = version <= 0 || !receivedMs || (Date.now() - receivedMs) > HA_STATE_STALE_MS;
  return { version, stale, states: state.haState.states };
}

async function handleHaStatePost(req, res) {
  let raw;
  try {
    raw = await readBody(req);
  } catch (error) {
    sendError(res, error.status || 413, error.message || "bad request body");
    return;
  }
  if (Buffer.byteLength(raw, "utf8") > MAX_HA_STATE_BODY) {
    sendError(res, 413, "state push exceeds 64 KiB");
    return;
  }
  let parsed = null;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    sendError(res, 400, "body contains unbalanced JSON");
    return;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    sendError(res, 400, "body must be one JSON object with a states array");
    return;
  }
  if (!("states" in parsed)) {
    sendError(res, 400, "body is missing its states array");
    return;
  }
  if (!Array.isArray(parsed.states)) {
    sendError(res, 400, "states must be a JSON array");
    return;
  }
  if (parsed.states.length > MAX_HA_STATES) {
    sendError(res, 400, `at most ${MAX_HA_STATES} states are accepted per push`);
    return;
  }
  if (parsed.states.some((item) => !item || typeof item !== "object" || Array.isArray(item))) {
    sendError(res, 400, "each entry in states must be a JSON object");
    return;
  }
  const ip = req.socket?.remoteAddress || "127.0.0.1";
  const now = Date.now();
  const lastMs = state.haState.rates.get(ip) || 0;
  if (lastMs && now >= lastMs && (now - lastMs) < HA_STATE_RATE_LIMIT_MS) {
    sendJson(res, 429, { ok: false, error: "at most one state push per second is accepted" }, { "Retry-After": "2" });
    return;
  }
  state.haState.rates.set(ip, now);
  state.haState.version += 1;
  state.haState.receivedMs = now;
  state.haState.states = parsed.states;
  logEvent({ kind: "ha-state", version: state.haState.version, stored: parsed.states.length });
  sendJson(res, 200, { ok: true, version: state.haState.version, stored: parsed.states.length });
}

function handleHaStateGet(res, params) {
  const sinceRaw = String(params.since ?? "").trim();
  const since = /^\d+$/.test(sinceRaw) ? Number(sinceRaw) : -1;
  const snap = currentHaStateSnapshot();
  const changed = !(since >= 0 && since === snap.version && !snap.stale);
  sendJson(res, 200, {
    ok: true,
    code: changed ? 200 : 304,
    version: snap.version,
    changed,
    stale: snap.stale,
    states: snap.states
  });
}

function handleActivityConfig(res) {
  const ha = currentHaStateSnapshot();
  sendJson(res, 200, {
    ok: true,
    revision: state.revision,
    activityList: state.activityList,
    mapList: state.mapList,
    functionList: state.functionList,
    deviceList: state.deviceList,
    haStateVersion: ha.version,
    haState: ha
  });
}

// The hub's codexactivity CommitDeviceSettings, against the fixture.
function handleDeviceSettings(res, params) {
  const deviceId = String(params.deviceId ?? "");
  const settings = params.settings;
  if (!/^\d{1,18}$/.test(deviceId) || !settings || typeof settings !== "object" || Array.isArray(settings)) {
    sendError(res, 400, "body must contain a numeric deviceId and a settings object");
    return;
  }
  const devices = state.deviceList.DevicesWithFeatures;
  const index = devices.findIndex((entry) => String(entry?.Device?.["Id-"]) === deviceId);
  if (index < 0) {
    sendError(res, 422, `DeviceList has no device ${deviceId}`);
    return;
  }
  const errors = validateDeviceSettings(settings, commandNames(devices[index]));
  if (settings.inputs && typeof settings.inputs === "object") {
    const kept = settings.inputs.type === "none"
      ? []
      : (Array.isArray(settings.inputs.list) ? settings.inputs.list : []).map((i) => String(i?.name ?? "").trim());
    for (const use of inputsInUse({ activityList: state.activityList }, deviceId, kept)) {
      errors.push(`activity "${use.activity}" switches it to ${use.input}`);
    }
  }
  if (errors.length) {
    sendError(res, 422, errors.join(" "));
    return;
  }
  devices[index] = applyDeviceSettings(devices[index], settings);
  logEvent({ kind: "device-settings", deviceId });
  sendJson(res, 200, {
    ok: true,
    saved: true,
    localOnly: true,
    deviceId,
    message: "Device settings were saved and reloaded in the Hub engine."
  });
}

function handleActivityState(res) {
  sendJson(res, 200, { ok: true, reply: stateReply() });
}

function handleActivityRun(res, params) {
  const activityId = String(params.activityId ?? "").trim();
  if (!/^-?\d+$/.test(activityId) || Number(activityId) < -1) {
    sendError(res, 400, "activityId must be -1 or a non-negative integer");
    return;
  }
  if (activityId !== "-1" && !activityExists(activityId)) {
    sendError(res, 404, `unknown activityId ${activityId}`);
    return;
  }
  // Like the hub: a start inside the activity's time restrictions is refused
  // (engine code 568, answered 409); the running activity always passes.
  const now = new Date();
  if (activityId !== String(state.currentActivityId) &&
      restrictedAt(simRestrictions[activityId], now.getDay(), now.getHours() * 60 + now.getMinutes())) {
    logEvent({ kind: "activity-run", activityId, message: "refused: time restrictions" });
    sendJson(res, 409, {
      ok: false,
      restricted: true,
      error: "This activity can't be started now: it has time restrictions.",
      activityId,
      reply: JSON.stringify({ cmd: "harmony.engine?startActivity", code: "568", msg: "Activity is restricted at this time", data: `activityId=${state.currentActivityId}` })
    });
    return;
  }
  state.currentActivityId = activityId;
  logEvent({ kind: "activity-run", activityId });
  sendJson(res, 200, {
    ok: true,
    activityId,
    reply: JSON.stringify({ code: 200, msg: "OK", activityId })
  });
}

function handleActivitySave(res, params) {
  const { baseRevision, activityList, mapList, functionList } = params;
  const syncRemote = params.syncRemote === true || params.syncRemote === "true" || params.syncRemote === "1";
  if (
    !activityList || typeof activityList !== "object" || Array.isArray(activityList) ||
    !mapList || typeof mapList !== "object" || Array.isArray(mapList) ||
    !functionList || typeof functionList !== "object" || Array.isArray(functionList)
  ) {
    sendError(res, 400, "body must contain activityList, mapList, and functionList JSON objects");
    return;
  }
  if (!Array.isArray(activityList.Activities)) {
    sendError(res, 400, "activityList must contain an Activities array");
    return;
  }
  if (!Array.isArray(mapList.ButtonMaps)) {
    sendError(res, 400, "mapList must contain a ButtonMaps array");
    return;
  }
  if (!Array.isArray(functionList.FunctionMaps)) {
    sendError(res, 400, "functionList must contain a FunctionMaps array");
    return;
  }
  if (!baseRevision || String(baseRevision) !== state.revision) {
    sendJson(res, 409, {
      ok: false,
      error: "activity resources changed since this editor loaded",
      revision: state.revision
    });
    return;
  }
  const activityChanged = !jsonEqual(activityList, state.activityList);
  const mapChanged = !jsonEqual(mapList, state.mapList);
  const functionChanged = !jsonEqual(functionList, state.functionList);
  state.activityList = activityList;
  state.mapList = mapList;
  state.functionList = functionList;
  state.revision = newRevision();
  const remoteRefreshed = activityChanged || mapChanged || functionChanged || syncRemote;
  let message;
  if (!activityChanged && !mapChanged && !functionChanged && !syncRemote) {
    message = "Activity resources already matched the Hub; no write was needed.";
  } else if (!activityChanged && !mapChanged && !functionChanged) {
    message = "The local activity engine and paired-remote configuration revision were refreshed.";
  } else {
    message = "Activities were saved locally, reloaded in the Hub engine, and published as a new paired-remote configuration revision.";
  }
  sendJson(res, 200, {
    ok: true,
    saved: true,
    localOnly: true,
    activityChanged,
    mapChanged,
    functionChanged,
    remoteRefreshed,
    synced: false,
    syncQueued: false,
    syncConflict: false,
    revision: state.revision,
    message,
    reply: JSON.stringify({ code: 200, msg: "OK", simulated: true })
  });
}

function handleActivitySync(res) {
  state.revision = newRevision();
  sendJson(res, 200, {
    ok: true,
    localOnly: true,
    remoteRefreshed: true,
    syncQueued: false,
    synced: false,
    revision: state.revision,
    message: "The local activity engine and paired-remote configuration revision were refreshed.",
    reply: JSON.stringify({ code: 200, msg: "OK", simulated: true })
  });
}

function handleInventory(res) {
  const devices = devicesWithFeatures().map((entry) => {
    const device = (entry && entry.Device) || {};
    const commands = Array.isArray(entry && entry.Commands) ? entry.Commands : [];
    return {
      id: String(device["Id-"] ?? ""),
      name: String(device.Name ?? ""),
      manufacturer: String(device.Manufacturer ?? ""),
      model: String(device.Model ?? ""),
      type: String(device.DeviceTypeDisplayName ?? ""),
      controlPort: Number(device.ControlPort ?? 7),
      transport: Number(device.Transport ?? 1),
      commands: commands.map(summarizeCommand)
    };
  });
  const totalCommandCount = devices.reduce((sum, device) => sum + device.commands.length, 0);
  sendJson(res, 200, {
    ok: true,
    deviceCount: devices.length,
    totalCommandCount,
    displayDeviceLimit: LIMITS.devices,
    displayCommandLimit: MAX_IR_COMMANDS,
    storageCommandLimit: LIMITS.storedCommands,
    batchCommandLimit: LIMITS.batchCommands,
    requestBodyLimit: MAX_BODY,
    resourceFileLimit: 4 * 1024 * 1024,
    devices,
    hubId: "12345678-sim",
    limits: {}
  });
}

function handleDeviceCommands(res, params) {
  const deviceId = String(params.deviceId ?? "").trim();
  if (!/^[0-9A-Za-z_-]{1,63}$/.test(deviceId)) {
    sendError(res, 400, "invalid IR device id");
    return;
  }
  const entry = findDeviceEntry(deviceId);
  if (!entry) {
    sendError(res, 404, "device not found");
    return;
  }
  const commands = (Array.isArray(entry.Commands) ? entry.Commands : []).map(summarizeCommand);
  sendJson(res, 200, { ok: true, deviceId, commands, count: commands.length });
}

const holds = new Map();

function handleIrSend(res, params) {
  const deviceId = String(params.deviceId ?? "").trim();
  const command = String(params.command ?? "").trim();
  if (!deviceId || !command || !/^[0-9A-Za-z _+\-.:/]{1,127}$/.test(command)) {
    sendError(res, 400, "invalid IR command request");
    return;
  }
  // Hold-to-repeat (render_ir_send_json / hold_run): press starts a hold,
  // hold renews its 700 ms lease, release ends it; one hold at a time.
  const status = String(params.status ?? "");
  const holdId = String(params.holdId ?? "");
  if (status && (!["press", "hold", "release"].includes(status) || !/^[0-9A-Za-z]{8,40}$/.test(holdId))) {
    sendError(res, 400, "invalid IR command request");
    return;
  }
  if (!status) {
    logEvent({ kind: "ir", deviceId, command });
    sendJson(res, 200, { ok: true, deviceId, command, reply: "sim sent" });
    return;
  }
  const now = Date.now();
  for (const [id, hold] of holds) {
    if (now - hold.lease > 700 || now - hold.started > 30000) holds.delete(id);
  }
  if (status === "press") {
    holds.clear();
    holds.set(holdId, { started: now, lease: now });
  } else if (status === "hold") {
    const hold = holds.get(holdId);
    if (!hold) {
      sendJson(res, 410, { ok: false, error: "The hold has ended.", status, holdId });
      return;
    }
    hold.lease = now;
  } else {
    holds.delete(holdId);
  }
  logEvent({ kind: "ir", deviceId, command, status, holdId });
  sendJson(res, 200, { ok: true, status, holdId });
}

/* -- IR setup: codex_webui.c's /ir/* forms and IR JSON routes -------------
   The /ir/* forms answer with the hub's legacy page: HTTP 200 with the result
   in <div class='msg'>, refusals included; only delete-device answers 409 or
   404. Messages and checks follow the C. Nothing is ever transmitted. */

// The hub's limits are the client's (ir-model.js mirrors codex_webui.c);
// MAX_IR_COMMANDS is the one the client never needs.
const MAX_IR_COMMANDS = 160;
const LAB_DEVICE_NAME = "Temporary IR Test"; // ensure_lab_target_device()
const MAX_CANCELED_RUNS = 64;
const canceledRuns = new Set();
let captureArmed = false;

/* RF remotes (GET /api/remotes, POST /api/remote-pair, POST
   /api/remote-unpair). The sim starts with a Smart Control in slot 1 and a
   Touch in slot 2, with made-up radio IDs, and the stock hal: a pairing window
   lasts a few seconds here; then a new Smart Control joins the first free
   slot and, as hal does, the older one of its kind goes. With multi-remote on
   (POST /api/sim/multi-remote {"on":true}, or SIM_MULTI_REMOTE=1) only a
   remote with a screen or a keyboard replaces an older one, so the new Smart
   Control joins. */
const SIM_PAIR_MS = 3000;
const SIM_RF_SLOTS = 6;
let simRemotes = [];
let simPairing = false;
let simNextRfid = 3000000001;
let simMultiRemote = false; // the multi-remote hal runs (bind-mounted)
let simMultiEnabled = false; // multi_remote.conf says 1
let simHalSupported = true; // /usr/bin/hal is the stock 4.15.600 build
let simOffPendingUntil = 0; // like codex_webui's pending-restart guard: no pairing until then
let simRadioHung = false; // rf.info doesn't answer (a hung hal): off needs "force"
let simUsbEthEnabled = false;
let simUsbEthSupported = true;
let simUsbEthEhciBound = false;
let simUsbEthAdapter = null; // null | { vidPid, product, supportedChip, carrier, ipv4 }
let simUsbEthForcedState = null; // null | { state, reason } (POST /api/sim/usb-eth)
/* How the cable is used (usb_eth.conf's WIFI_OFF and IP_* settings, and what
   the service found): set with POST /api/usb-eth, the rest with
   POST /api/sim/usb-eth. */
let simUsbEthWifiOff = false;
let simUsbEthIpMode = "dhcp";
let simUsbEthStatic = { address: "", netmask: "", gateway: "", dns: [] };
let simUsbEthSeparate = false; // the cable is on another network than the hub's gateway
let simUsbEthGatewayLost = false; // the gateway stopped answering through the cable
let simUsbEthNeedsRestart = false; // the running egress guard predates its Wi-Fi watchdog
let simUsbEthLanSince = 0; // when the cable began carrying local traffic
let simUsbEthRx = 0;
let simUsbEthTx = 0;
const SIM_USB_ETH_WIFI_OFF_MS = 1500; // the hub waits a minute (WIFI_OFF_AFTER)
const SIM_RESTART_MS = 4000;
const SIM_HAL_STOCK_MD5 = "a3fdd823440c43f36e235fe51c45f008";
const SIM_HAL_MULTI_MD5 = "cafdd7930309c7d74a6a41a87642f0c1";

function resetSimRemotes() {
  simRemotes = [
    { EquadID: "16414", SkinId: "", DeviceIndex: "1", RFID: "1000000001" },
    { EquadID: "16417", SkinId: "99", DeviceIndex: "2", RFID: "2000000001" }
  ];
  simPairing = false;
  simMultiRemote = process.env.SIM_MULTI_REMOTE === "1";
  simMultiEnabled = simMultiRemote;
  simHalSupported = true;
  simOffPendingUntil = 0;
  simRadioHung = false;
  simUsbEthEnabled = false;
  simUsbEthSupported = true;
  simUsbEthEhciBound = false;
  simUsbEthAdapter = null;
  simUsbEthForcedState = null;
  simUsbEthWifiOff = false;
  simUsbEthIpMode = "dhcp";
  simUsbEthStatic = { address: "", netmask: "", gateway: "", dns: [] };
  simUsbEthSeparate = false;
  simUsbEthGatewayLost = false;
  simUsbEthNeedsRestart = false;
  simUsbEthLanSince = 0;
  simUsbEthRx = 0;
  simUsbEthTx = 0;
}

/* The raw text of a top-level JSON member's value, like codex_webui's
   json_top_member(): the first top-level match, ignoring keys nested in
   objects or arrays and anything inside strings; null when absent. */
function jsonTopToken(raw, key) {
  const text = String(raw ?? "");
  let depth = 0;
  let i = text.search(/\S/);
  if (i < 0 || text[i] !== "{") return null;
  for (; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      const start = ++i;
      while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
      if (i >= text.length) return null;
      if (depth === 1 && text.slice(start, i) === key) {
        const rest = text.slice(i + 1).match(/^\s*:\s*([^,}\]]*)/);
        if (rest) return rest[1].trim();
      }
    } else if (ch === "{" || ch === "[") {
      depth++;
    } else if (ch === "}" || ch === "]") {
      if (--depth === 0) return null;
    }
  }
  return null;
}

/* GET /api/multi-remote, like codex_webui's render_multi_remote_json(). */
function simMultiRemoteState() {
  const halMd5 = simMultiRemote ? SIM_HAL_MULTI_MD5 : simHalSupported ? SIM_HAL_STOCK_MD5 : "0123456789abcdef0123456789abcdef";
  const supported = simMultiRemote || simHalSupported;
  return {
    ok: true, enabled: simMultiEnabled, active: simMultiRemote, supported, halMd5,
    stockMd5: SIM_HAL_STOCK_MD5, patchedMd5: SIM_HAL_MULTI_MD5,
    reason: supported ? "" : `This hub's hal is not the build the multi-remote change was made for, so it can't be turned on safely. Its MD5 is ${halMd5}; the change needs the Harmony Hub firmware 4.15.600 hal, MD5 ${SIM_HAL_STOCK_MD5}.`
  };
}

/* POST /api/multi-remote: the sim "restarts" for a few seconds, then runs the new hal. */
function handleMultiRemoteSet(res, params) {
  const token = jsonTopToken(params.__raw, "enabled");
  if (token !== "true" && token !== "false") {
    sendJson(res, 400, { ok: false, error: 'Send {"enabled": true} or {"enabled": false}.' });
    return;
  }
  const forceToken = jsonTopToken(params.__raw, "force");
  if (forceToken !== null && forceToken !== "true" && forceToken !== "false") {
    sendJson(res, 400, { ok: false, error: 'Send {"enabled": true} or {"enabled": false} (and optionally "force": true to turn it off).' });
    return;
  }
  params = { ...params, enabled: token === "true" };
  // Like the hub: "force" (off only) skips the pairing and slot-table checks.
  const force = forceToken === "true" && !params.enabled;
  const state = simMultiRemoteState();
  if (params.enabled && !state.supported) {
    sendJson(res, 409, { ok: false, error: state.reason, halMd5: state.halMd5 });
    return;
  }
  if (!params.enabled && !force && simPairing) {
    // Like the hub: the slot table can't be vouched for while a window is open.
    sendJson(res, 409, { ok: false, error: "A pairing window is open on the hub. Try again when it closes." });
    return;
  }
  if (!params.enabled && !force && simRadioHung) {
    sendJson(res, 502, { ok: false, error: "The hub's radio didn't list its paired remotes, so the setting wasn't changed." });
    return;
  }
  if (!params.enabled && !force) {
    const counts = {};
    for (const r of simRemotes) if (["16414", "16422", "16423"].includes(r.EquadID)) (counts[r.EquadID] ??= []).push(r.DeviceIndex);
    const dups = Object.entries(counts).filter(([, slots]) => slots.length > 1).map(([id, slots]) => `${id} (slots ${slots.join(", ")})`).join("; ");
    if (dups) {
      sendJson(res, 409, { ok: false, duplicates: dups, error: `More than one remote of the same model is paired (EquadID ${dups}). The hub's stock software can't run two of one model, so unpair the extra ones first.` });
      return;
    }
  }
  simMultiEnabled = params.enabled;
  const rebooting = simMultiRemote !== params.enabled;
  if (rebooting && !params.enabled) simOffPendingUntil = Date.now() + SIM_RESTART_MS;
  if (rebooting) setTimeout(() => { simMultiRemote = simMultiEnabled; }, SIM_RESTART_MS);
  logEvent({ kind: "multi-remote", message: `Multiple remotes of one model ${params.enabled ? "on" : "off"}${rebooting ? " (restarting)" : ""}` });
  sendJson(res, 200, { ok: true, enabled: params.enabled, rebooting, ...(force ? { forced: true } : {}) });
}

/* GET /api/usb-eth, like codex_webui's render_usb_eth_json(). */
function simUsbEthState() {
  const kernel = simUsbEthSupported ? "2.6.31-g89d565c" : "2.6.31-other";
  const dev = simUsbEthEhciBound && simUsbEthAdapter ? simUsbEthAdapter : null;
  const boundIface = simUsbEthEnabled && dev && dev.supportedChip !== false ? "eth0" : "";
  const carrier = Boolean(boundIface && dev.carrier !== false);
  const isStatic = simUsbEthIpMode === "static";
  let ipv4 = "";
  if (carrier) {
    if (isStatic) ipv4 = simUsbEthStatic.address;
    else ipv4 = String(dev.ipv4 || (simUsbEthSeparate ? "10.0.0.55" : "192.168.1.55"));
  }
  /* Enabled is not operational: mirror the hub's state names. */
  let state = "platform_absent";
  let reason = "";
  if (simUsbEthEnabled) {
    if (simUsbEthForcedState) {
      state = simUsbEthForcedState.state;
      reason = simUsbEthForcedState.reason || "";
    } else if (!simUsbEthEhciBound) state = "platform_unbound";
    else if (!dev) state = "adapter_absent";
    else if (dev.supportedChip === false) state = "adapter_unsupported";
    else if (!carrier) state = "awaiting_carrier_dhcp";
    else if (simUsbEthGatewayLost && !simUsbEthSeparate) {
      state = "gateway_unreachable";
      reason = "gateway_lost";
    } else state = "operational";
  } else if (simUsbEthEhciBound) {
    state = "bus_ready";
  }
  const operational = state === "operational";
  // Like use_cable(): on the gateway's network the cable carries local traffic.
  const carriesLan = operational && !simUsbEthSeparate;
  if (!carriesLan) simUsbEthLanSince = 0;
  else if (!simUsbEthLanSince) simUsbEthLanSince = Date.now();
  if (operational) {
    simUsbEthRx += 6144;
    simUsbEthTx += 3072;
  }
  const router = !ipv4 ? null : isStatic ? simUsbEthStatic.gateway || null : ipv4.replace(/\.\d+$/, ".1");
  // Like manage_wifi(): off once the cable has carried local traffic a while, never without the guard's watchdog.
  const wifiSuspended = carriesLan && simUsbEthWifiOff && !simUsbEthNeedsRestart &&
    Date.now() - simUsbEthLanSince >= SIM_USB_ETH_WIFI_OFF_MS;
  return {
    ok: true,
    enabled: simUsbEthEnabled,
    supported: simUsbEthSupported,
    kernel,
    ehciBound: simUsbEthEhciBound,
    platformRegistered: simUsbEthEhciBound,
    operational,
    state,
    reason,
    routeMode: operational ? "metric" : "",
    driverLoaded: Boolean(simUsbEthEnabled && simUsbEthSupported && dev && dev.supportedChip !== false),
    gadgetLoaded: false,
    usbDevice: dev ? String(dev.vidPid || "0bda:8152") : "",
    usbProduct: dev ? String(dev.product || "USB 10/100 LAN") : "",
    ifname: boundIface,
    carrier,
    ipv4,
    speedMbps: carrier ? Number(dev.speedMbps || 100) : null,
    fullDuplex: carrier ? dev.fullDuplex !== false : null,
    netmask: ipv4 ? (isStatic ? simUsbEthStatic.netmask : "255.255.255.0") : null,
    router,
    dns: ipv4 && isStatic && simUsbEthStatic.dns.length ? [...simUsbEthStatic.dns] : ["192.168.1.1"],
    ipMode: simUsbEthIpMode,
    staticConfig: { ...simUsbEthStatic, dns: [...simUsbEthStatic.dns] },
    separateNetwork: operational && simUsbEthSeparate,
    gatewayUnreachable: state === "gateway_unreachable",
    wifiIp: "192.168.1.50",
    wifiOff: simUsbEthWifiOff,
    wifiSuspended,
    wifiNeedsRestart: simUsbEthWifiOff && simUsbEthNeedsRestart,
    wifiOffBlocked: null, // "noRouter" on the hub: cloud blocker off and no default route through the cable
    rxBytes: boundIface ? simUsbEthRx : null,
    txBytes: boundIface ? simUsbEthTx : null,
    lanInterface: carriesLan ? boundIface : "ath0"
  };
}

/* The network an address is on: address AND mask, like the hub's connected route. */
function simNetworkOf(ip, mask) {
  const a = ip.split(".").map(Number);
  const m = (mask || "255.255.255.0").split(".").map(Number);
  return a.map((x, i) => x & m[i]).join(".");
}

/* GET /api/network-overview, like codex_webui's render_network_overview_json(). */
function simNetworkOverview() {
  const st = simUsbEthState();
  const lan = st.lanInterface;
  const route = (destination, gateway, netmask, metric, iface) =>
    ({ destination, gateway, netmask, flags: gateway === "0.0.0.0" ? "U" : "UG", metric, interface: iface });
  const routes = [];
  if (st.ifname && st.ipv4) routes.push(route(simNetworkOf(st.ipv4, st.netmask), "0.0.0.0", st.netmask, 0, st.ifname));
  // The Wi-Fi subnet route is demoted while the cable carries local traffic.
  routes.push(route("192.168.1.0", "0.0.0.0", "255.255.255.0", lan === "ath0" ? 0 : 20, "ath0"));
  for (const [net, mask] of [["192.168.0.0", "255.255.0.0"], ["172.16.0.0", "255.240.0.0"], ["10.0.0.0", "255.0.0.0"]]) {
    routes.push(route(net, "192.168.1.1", mask, 0, lan));
  }
  routes.push(route("224.0.0.0", "0.0.0.0", "240.0.0.0", 0, lan));
  return {
    ok: true,
    available: true,
    wifi: {
      interface: "ath0", ip: "192.168.1.50", netmask: "255.255.255.0", mac: "00:04:20:00:00:01", up: true,
      rxBytes: 18247694, txBytes: 6943236, rxErrors: 0, txErrors: 0,
      ssid: "Home", state: st.wifiSuspended ? "DISCONNECTED" : "COMPLETED", bssid: "00:11:22:33:44:55",
      security: "WPA2-PSK", cipher: "CCMP", standard: "802.11ng", frequencyGhz: "2.412", bitRate: "72.2 Mb/s",
      quality: "82/94", signalDbm: -66, noiseDbm: -95, txPowerDbm: 11, suspended: st.wifiSuspended
    },
    wired: st.ifname ? {
      interface: st.ifname, ip: st.ipv4 || null, netmask: st.netmask, mac: "02:00:00:aa:bb:cc", up: true, carrier: st.carrier,
      rxBytes: st.rxBytes, txBytes: st.txBytes, rxErrors: 0, txErrors: 0,
      speedMbps: st.speedMbps, fullDuplex: st.fullDuplex, mode: st.ipMode
    } : null,
    routes,
    dns: st.dns,
    lanInterface: lan,
    gateway: "192.168.1.1",
    cloudBlocker: true
  };
}

/* POST /api/usb-eth, like codex_webui's render_usb_eth_set_json(): any of
   "enabled" and "wifiOff" (top-level true/false) and "ipMode" ("dhcp", or
   "static" with plain-string "address", "netmask", "gateway", "dns1",
   "dns2"). Switching to DHCP keeps the static values, for the form. */
function handleUsbEthSet(res, params) {
  const token = jsonTopToken(params.__raw, "enabled");
  const wifiToken = jsonTopToken(params.__raw, "wifiOff");
  const modeToken = jsonTopToken(params.__raw, "ipMode");
  const notBool = (t) => t !== null && t !== "true" && t !== "false";
  if ((token === null && wifiToken === null && modeToken === null) || notBool(token) || notBool(wifiToken) ||
      (modeToken !== null && modeToken !== '"dhcp"' && modeToken !== '"static"')) {
    sendJson(res, 400, { ok: false, error: 'Send {"enabled": true|false}, {"wifiOff": true|false} and/or {"ipMode": "dhcp"|"static", ...}.' });
    return;
  }
  let fields = null;
  if (modeToken === '"static"') {
    fields = {};
    for (const key of ["address", "netmask", "gateway", "dns1", "dns2"]) {
      const raw = jsonTopToken(params.__raw, key);
      if (raw !== null && (!/^"[^"\\]*"$/.test(raw) || raw.length > 21)) {
        sendJson(res, 400, { ok: false, error: "Address fields must be plain strings.", field: key });
        return;
      }
      fields[key] = raw === null ? "" : raw.slice(1, -1);
    }
    const problem = validateStatic(fields);
    if (problem) {
      sendJson(res, 400, { ok: false, error: problem.message, field: problem.field });
      return;
    }
  }
  const want = token === null ? null : token === "true";
  if (want && !simUsbEthSupported) {
    sendJson(res, 409, {
      ok: false,
      error: "This hub's kernel is not the build USB Ethernet was made for (2.6.31-g89d565c).",
      kernel: "2.6.31-other"
    });
    return;
  }
  if (wifiToken !== null) simUsbEthWifiOff = wifiToken === "true";
  if (fields) {
    simUsbEthIpMode = "static";
    simUsbEthStatic = { address: fields.address, netmask: fields.netmask, gateway: fields.gateway, dns: [fields.dns1, fields.dns2].filter(Boolean) };
  } else if (modeToken === '"dhcp"') {
    simUsbEthIpMode = "dhcp";
  }
  if (want !== null) {
    simUsbEthEnabled = want;
    simUsbEthForcedState = null;
    if (want) simUsbEthEhciBound = true; // Like the hub: stop leaves EHCI registered.
    logEvent({ kind: "usb-eth", message: `USB Ethernet ${want ? "on" : "off"}` });
  }
  sendJson(res, 200, simUsbEthState());
}

/* Activity time restrictions, like codex_webui's /api/activity-restrictions:
   activity id -> its windows; an activity with none has no entry. */
let simRestrictions = {};

function handleRestrictionsSet(res, params) {
  const activityId = typeof params.activityId === "string" ? params.activityId : "";
  if (!isRestrictableId(activityId)) {
    sendJson(res, 400, { ok: false, error: "Give the activity's id." });
    return;
  }
  const { windows, error } = normalizeWindows(params.windows);
  if (error) {
    sendJson(res, 400, { ok: false, error });
    return;
  }
  const next = { ...simRestrictions };
  if (windows.length) {
    if (!(activityId in next) && Object.keys(next).length >= MAX_ACTIVITIES) {
      sendJson(res, 409, { ok: false, error: `Up to ${MAX_ACTIVITIES} activities can have time restrictions.` });
      return;
    }
    next[activityId] = windows;
  } else {
    delete next[activityId];
  }
  simRestrictions = next;
  logEvent({ kind: "restrictions", message: `Time restrictions for activity ${activityId}: ${windows.length || "none"}` });
  sendJson(res, 200, { ok: true, activities: simRestrictions });
}

function simRfInfo() {
  return JSON.stringify({
    id: 1,
    data: { EquadID: "34827", RFID: "9000000001", Devices: simRemotes, DeviceCount: simRemotes.length },
    code: 200
  });
}

async function handleRemotePair(res, params) {
  if (simPairing) {
    sendJson(res, 409, { ok: false, pairing: true, error: "A pairing window is already open on the hub." });
    return;
  }
  if (Date.now() < simOffPendingUntil) {
    sendJson(res, 409, { ok: false, restarting: true, error: "The hub is about to restart to turn off multiple remotes of one model. Pair the remote after it restarts." });
    return;
  }
  const seconds = Math.min(120, Math.max(10, Number(params.seconds) || 60));
  const before = simRfInfo();
  simPairing = true;
  const started = Date.now();
  await new Promise((resolve) => setTimeout(resolve, SIM_PAIR_MS));
  const used = new Set(simRemotes.map((r) => r.DeviceIndex));
  let slot = 1;
  while (used.has(String(slot))) slot += 1;
  if (slot > SIM_RF_SLOTS) {
    simPairing = false;
    sendJson(res, 200, {
      ok: true, seconds, elapsedMs: Date.now() - started, pairCode: 500, multiRemote: simMultiRemote,
      pair: JSON.stringify({ id: 1, code: 500, msg: "all slots used" }), before, after: simRfInfo()
    });
    return;
  }
  const joined = { EquadID: "16414", SkinId: "", DeviceIndex: String(slot), RFID: String(simNextRfid++) };
  if (!simMultiRemote || joined.EquadID === "16417" || joined.EquadID === "16420") {
    simRemotes = simRemotes.filter((r) => r.EquadID !== joined.EquadID);
  }
  simRemotes.push(joined);
  simRemotes.sort((a, b) => Number(a.DeviceIndex) - Number(b.DeviceIndex));
  simPairing = false;
  logEvent({ kind: "remote-pair", message: `Smart Control paired in slot ${slot}` });
  sendJson(res, 200, {
    ok: true,
    seconds,
    elapsedMs: Date.now() - started,
    pairCode: 200,
    multiRemote: simMultiRemote,
    pair: JSON.stringify({ id: 1, data: { ...joined }, code: 200 }),
    before,
    after: simRfInfo()
  });
}

// safe_label(): non-empty, no control characters, no '"' or backslash. It
// has no length limit of its own: form_value() already cut the field to its
// buffer (formFields below).
const safeLabel = (value) => isSafeLabel(value, Infinity);

// The /ir/* and test-learned buffers in codex_webui.c (form_value copies at
// most size - 1 bytes).
const FORM_SIZES = {
  deviceId: 64,
  name: 128,
  oldName: 128,
  command: 128,
  manufacturer: 128,
  model: 128,
  type: 80,
  mode: 32,
  protocol: 32,
  nec: 64,
  keycode: 512,
  raw: 2048
};

function formFields(params) {
  const out = { ...params };
  for (const [key, size] of Object.entries(FORM_SIZES)) {
    if (key in out) out[key] = String(out[key] ?? "").slice(0, size - 1);
  }
  return out;
}

/* Network Android/Google TVs (codex_androidtv). A pretend TV is on the network;
   pairing walks preparing → connecting → code, and the code is SIM_ANDROIDTV_CODE
   (logged as a sim event, since there is no TV screen to read it from). */
const SIM_ANDROIDTV_CODE = "A1B2C3";
const SIM_ANDROIDTV_FOUND = [{ name: "Living Room TV", host: "192.168.0.60" }];
const SIM_ANDROIDTV_COMMANDS = [
  "PowerOn", "PowerOff", "PowerToggle", "DirectionUp", "DirectionDown", "DirectionLeft",
  "DirectionRight", "Select", "Back", "Home", "Menu", "Settings", "Info", "Guide",
  "VolumeUp", "VolumeDown", "Mute", "ChannelUp", "ChannelDown", "PrevChannel", "Play",
  "Pause", "PlayPause", "Stop", "FastForward", "Rewind", "SkipForward", "SkipBack",
  "Record", "Captions", "Search", "Assistant", "InputHdmi1", "InputHdmi2", "InputHdmi3",
  "InputHdmi4", "InputNext", "Red", "Green", "Yellow", "Blue", "Number0", "Number1",
  "Number2", "Number3", "Number4", "Number5", "Number6", "Number7", "Number8", "Number9"
];
const simAndroidTv = { tvs: new Map(), pair: { state: "idle", host: "", name: "", error: "", tvId: "", at: 0 } };

function simAndroidTvPairState() {
  const p = simAndroidTv.pair;
  const age = Date.now() - p.at;
  if (p.state === "preparing" && age > 1200) { p.state = "connecting"; p.at = Date.now(); }
  if (p.state === "connecting" && age > 600) {
    p.state = "code";
    logEvent({ type: "androidtv-pair-code", host: p.host, code: SIM_ANDROIDTV_CODE });
  }
  if (p.state === "checking" && age > 500) {
    p.state = "paired";
    p.tvId = "androidtv" + Buffer.from(p.host).toString("hex").slice(-8).padStart(8, "0");
    simAndroidTv.tvs.set(p.tvId, { id: p.tvId, name: p.name || "Android TV", host: p.host, on: false });
  }
  return { ok: true, state: p.state, host: p.host, name: p.name, error: p.error, tvId: p.tvId };
}

function simAndroidTvTag(entry) {
  return String(entry?.Device?.AutoDetectedDevice?.Id ?? "").startsWith("melodious-androidtv-");
}

function simAndroidTvTokenOf(entry) {
  return (entry?.Device?.Tokens?.Parameters ?? []).find((t) => t?.Key === "{d}")?.Value ?? "";
}

function handleAndroidTvDevices(res, params) {
  const devices = Array.isArray(params.devices) ? params.devices : null;
  if (!devices) {
    sendError(res, 400, "body must be one JSON object with a devices list");
    return;
  }
  const entries = deviceEntries();
  const owned = new Map(entries.filter(simAndroidTvTag).map((e) => [simAndroidTvTokenOf(e), e]));
  const others = entries.filter((e) => !simAndroidTvTag(e));
  for (const d of devices) {
    if (!/^androidtv[0-9a-f]+$/.test(String(d.entity ?? ""))) {
      sendJson(res, 422, { ok: false, error: `device needs a paired TV id such as androidtv1a2b3c4d` });
      return;
    }
    if (others.some((e) => String(e.Device?.Name ?? "").toLowerCase() === String(d.name ?? "").toLowerCase())) {
      sendJson(res, 422, { ok: false, error: `another device is already named ${d.name}` });
      return;
    }
  }
  const result = { ok: true, localOnly: true, added: [], updated: [], removed: [], unchanged: [], devices: [] };
  const kept = [...others];
  for (const d of devices) {
    let entry = owned.get(d.entity);
    if (!entry) {
      // Count the TVs this request already added, so two new TVs never share an id.
      const id = nextId([...entries, ...kept].map((e) => e.Device?.["Id-"]), 39000000);
      entry = {
        Device: {
          "Id-": id, Name: d.name, Manufacturer: d.manufacturer || "Android TV", Model: d.model || "Android TV",
          DeviceTypeDisplayName: "Television", DeviceType: 1, Transport: 64, Icon: 1,
          Tokens: { Parameters: [{ Key: "{d}", Value: d.entity }] },
          AutoDetectedDevice: { Id: `melodious-androidtv-${id}` }
        },
        Commands: SIM_ANDROIDTV_COMMANDS.map((name, i) => ({
          Name: name, "Id-": id * 100 + i, TransportType: 64, KeyCode: "", Raw: null,
          Parameters: [{ Key: "{c}", Value: name }], IsLearned: false
        })),
        DeviceFeatures: []
      };
      result.added.push(d.name);
    } else {
      entry.Device.Name = d.name;
      result.updated.push(d.name);
    }
    kept.push(entry);
    result.devices.push({ entity: d.entity, deviceId: String(entry.Device["Id-"]), name: d.name });
  }
  for (const [token, entry] of owned) {
    if (!devices.some((d) => d.entity === token)) result.removed.push(entry.Device.Name);
  }
  state.deviceList.DevicesWithFeatures = kept;
  state.revision = newRevision();
  result.changed = true;
  logEvent({ type: "androidtv-devices", ...result });
  sendJson(res, 200, result);
}

// DevicesWithFeatures as the array the hub appends to.
function deviceEntries() {
  if (!Array.isArray(state.deviceList.DevicesWithFeatures)) state.deviceList.DevicesWithFeatures = [];
  return state.deviceList.DevicesWithFeatures;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function sendMsgPage(res, status, message) {
  const body = "<!doctype html><html><head><title>Harmony Hub Control</title></head><body>" +
    `<div class='msg'>${escapeHtml(message)}</div></body></html>\n`;
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function deviceCommands(entry) {
  if (!Array.isArray(entry.Commands)) entry.Commands = [];
  return entry.Commands;
}

function hasCommand(entry, name) {
  return deviceCommands(entry).some((c) => String(c?.Name ?? "") === name);
}

// New ids continue after the largest one in use, from the hub's floor.
function nextId(values, floor) {
  const max = values.reduce((m, v) => Math.max(m, Number(v) || 0), 0);
  return Math.max(max + 1, floor);
}

function nextCommandId() {
  return nextId(devicesWithFeatures().flatMap((e) => deviceCommands(e).map((c) => c?.["Id-"])), 39000000);
}

// build_nec_keycode()
function necKeycode(hex, protocolId) {
  const clean = String(hex ?? "").trim().replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]{1,8}$/.test(clean)) return null;
  const value = parseInt(clean, 16).toString(16).toUpperCase().padStart(8, "0");
  return protocolId === 679
    ? `G:MemorexO1 32 Bit:()(0x${value})():3`
    : `G:Toshiba 32 Bit:(0x${value})(Repeat)():3`;
}

/* The signal of /ir/command, /ir/update-command and /api/ir-test-learned:
   { mode, protocolId, code, raw } or { error }. "auto" keeps the first of
   keycode, NEC and raw that was given (analyze_capture_storage). */
function irSignal(params, defaultMode) {
  let mode = String(params.mode ?? "").trim() || defaultMode;
  let protocolId = parseInt(params.protocol, 10);
  if (!(protocolId > 0)) protocolId = 2;
  const keycode = String(params.keycode ?? "").trim();
  const nec = String(params.nec ?? "").trim();
  const raw = String(params.raw ?? "").trim();
  if (mode === "auto") mode = keycode ? "keycode" : nec ? "nec" : "raw";
  if (mode === "raw") return raw ? { mode, protocolId, code: "", raw } : { error: "Raw command data is required." };
  if (mode === "nec") {
    const code = necKeycode(nec, protocolId);
    return code ? { mode: "keycode", protocolId, code, raw: "" } : { error: "NEC value must be 1-8 hex digits." };
  }
  return keycode
    ? { mode: "keycode", protocolId, code: keycode, raw: "" }
    : { error: defaultMode === "auto" ? "KeyCode is required." : "Harmony compact code is required." };
}

// build_ir_command_json()
function irCommand(id, name, signal) {
  const raw = signal.mode === "raw";
  return {
    Raw: raw ? signal.raw : null,
    "Id-": id,
    KeyCode: raw ? "" : signal.code,
    DateTaught: `/Date(${Math.floor(Date.now() / 1000)}000+0000)/`,
    FunctionId: null,
    Parameters: null,
    Name: name,
    FunctionGroupId: 0,
    TransportType: 1,
    ProtocolId: raw ? null : signal.protocolId,
    CommandTypeId: "",
    IsLearned: true
  };
}

// add_ir_command(): returns { ok, msg }.
function addIrCommand(deviceId, name, params) {
  if (!safeLabel(deviceId) || !safeLabel(name)) return { ok: false, msg: "Device and command name are required." };
  const signal = irSignal(params, "auto");
  if (signal.error) return { ok: false, msg: signal.error };
  const entry = findDeviceEntry(deviceId);
  if (!entry) return { ok: false, msg: `Device ${deviceId} not found.` };
  if (deviceCommands(entry).length >= LIMITS.storedCommands) {
    return { ok: false, msg: `Device ${deviceId} already has the local storage limit of ${LIMITS.storedCommands} commands.` };
  }
  if (hasCommand(entry, name)) return { ok: false, msg: `Command ${name} already exists on device ${deviceId}.` };
  deviceCommands(entry).push(irCommand(nextCommandId(), name, signal));
  return { ok: true, msg: `Saved command ${name} on device ${deviceId}.` };
}

function deleteIrCommand(deviceId, name) {
  const entry = findDeviceEntry(deviceId);
  if (!entry) return { ok: false, msg: `Device ${deviceId} not found.` };
  const list = deviceCommands(entry);
  const index = list.findIndex((c) => String(c?.Name ?? "") === name);
  if (index < 0) return { ok: false, msg: `Command ${name} not found on device ${deviceId}.` };
  list.splice(index, 1);
  return { ok: true, msg: `Deleted command ${name} from device ${deviceId}.` };
}

// harmony_device_type_id()
function deviceTypeId(type) {
  const t = String(type).toLowerCase();
  if (t === "amplifier") return 19;
  if (t === "television" || t === "tv") return 2;
  if (t === "media player") return 22;
  if (t === "game console") return 32;
  return 44;
}

// create_ir_device_ex(): returns { ok, msg, id }.
function createIrDevice({ name, manufacturer, model, type }) {
  if (![name, manufacturer, model, type].every(safeLabel)) {
    return { ok: false, msg: "Device fields cannot be empty or contain control characters." };
  }
  const id = nextId(devicesWithFeatures().map((e) => e?.Device?.["Id-"]), 90000000);
  const typeId = deviceTypeId(type);
  deviceEntries().push({
    Device: {
      "Id-": id,
      Name: name,
      Manufacturer: manufacturer,
      Model: model,
      DeviceType: typeId,
      DeviceTypeDisplayName: type,
      Icon: typeId,
      Transport: 1,
      ControlPort: 7,
      InterKeyDelay: 300,
      InterDeviceDelay: 500,
      PressMinRepeats: 3,
      DeviceAddedDate: `/Date(${Math.floor(Date.now() / 1000)}000+0000)/`
    },
    Commands: [],
    DeviceFeatures: []
  });
  return { ok: true, msg: `Created IR device ${name} (${id}).`, id: String(id) };
}

function labDevice() {
  return devicesWithFeatures().find((e) => e?.Device?.Name === LAB_DEVICE_NAME) ?? null;
}

// ensure_lab_target_device()
function ensureLabDevice() {
  const found = labDevice();
  if (found) {
    const id = String(found.Device["Id-"]);
    return { ok: true, id, created: false, msg: `Using existing ${LAB_DEVICE_NAME} (${id}).` };
  }
  const made = createIrDevice({ name: LAB_DEVICE_NAME, manufacturer: "Local", model: "Command Sweep", type: "HomeAppliance" });
  return { ...made, created: made.ok };
}

// resource_references_device(): any "DeviceId-" naming it, in activities or maps.
function referencesDevice(value, id) {
  if (Array.isArray(value)) return value.some((item) => referencesDevice(item, id));
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, item]) =>
    key === "DeviceId-" ? String(item) === id : referencesDevice(item, id));
}

function handleIrForm(res, pathname, body) {
  const params = formFields(body);
  const deviceId = String(params.deviceId ?? "");
  let result;
  switch (pathname) {
    case "/ir/new-device":
      result = createIrDevice(params);
      break;
    case "/ir/device": {
      const fields = ["name", "manufacturer", "model", "type"].map((k) => String(params[k] ?? ""));
      const entry = findDeviceEntry(deviceId);
      if (!safeLabel(deviceId) || !fields.every(safeLabel)) {
        result = { ok: false, msg: "Device fields cannot be empty or contain control characters." };
      } else if (!entry) {
        result = { ok: false, msg: `Failed to update device ${deviceId}.` };
      } else {
        [entry.Device.Name, entry.Device.Manufacturer, entry.Device.Model, entry.Device.DeviceTypeDisplayName] = fields;
        result = { ok: true, msg: `Updated device ${deviceId}.` };
      }
      break;
    }
    case "/ir/delete-device": {
      const id = /^\d+$/.test(deviceId) && Number(deviceId) > 0 ? deviceId : "";
      const index = devicesWithFeatures().findIndex((e) => String(e?.Device?.["Id-"]) === id);
      if (!id || index < 0) {
        sendMsgPage(res, 404, `Device ${deviceId} not found.`);
        return;
      }
      if ([state.activityList, state.mapList, state.functionList].some((list) => referencesDevice(list, id))) {
        sendMsgPage(res, 409,
          `Device ${deviceId} is still used by an activity or a remote button map. Remove it from those first, then delete it.`);
        return;
      }
      devicesWithFeatures().splice(index, 1);
      result = { ok: true, msg: `Deleted device ${deviceId}.` };
      break;
    }
    case "/ir/command":
      result = addIrCommand(deviceId, String(params.name ?? ""), params);
      break;
    case "/ir/update-command": {
      const oldName = String(params.oldName ?? "");
      const name = String(params.name ?? "");
      const entry = findDeviceEntry(deviceId);
      const list = entry ? deviceCommands(entry) : [];
      const index = list.findIndex((c) => String(c?.Name ?? "") === oldName);
      const signal = irSignal(params, "keycode");
      if (!safeLabel(deviceId) || !safeLabel(oldName) || !safeLabel(name)) {
        result = { ok: false, msg: "Device, current command name, and new command name are required." };
      } else if (index < 0) {
        result = { ok: false, msg: `Command ${oldName} was not found on device ${deviceId}.` };
      } else if (name !== oldName && hasCommand(entry, name)) {
        result = { ok: false, msg: `Command ${name} already exists on device ${deviceId}.` };
      } else if (signal.error) {
        result = { ok: false, msg: signal.error };
      } else {
        list[index] = irCommand(Number(list[index]["Id-"]) || nextCommandId(), name, signal);
        result = { ok: true, msg: `Updated command ${name} on device ${deviceId}.` };
      }
      break;
    }
    case "/ir/delete-command":
      result = deleteIrCommand(deviceId, String(params.command ?? ""));
      break;
    default:
      sendError(res, 404, "not found");
      return;
  }
  if (result.ok) logEvent({ kind: "ir-setup", route: pathname, deviceId: result.id ?? deviceId });
  sendMsgPage(res, 200, result.msg);
}

/* /api/capture hears nothing (the sim has no IR receiver) unless
   POST /api/sim/capture-next armed one sample NEC frame for the next call. */
function handleCapture(res) {
  if (captureArmed) {
    captureArmed = false;
    sendJson(res, 200, {
      ok: true,
      raw: "",
      mode: "nec",
      protocolId: 2,
      keycode: "",
      nec: "0x00FF02FD",
      analysis: "NEC 32-bit frame (simulated sample)"
    });
    return;
  }
  sendJson(res, 200, {
    ok: true,
    raw: "",
    mode: "",
    protocolId: 0,
    keycode: "",
    nec: "",
    analysis: "SIMULATED HUB — no IR receiver"
  });
}

// render_ir_test_learned_json(): add a temporary command, "send" it, remove it.
function handleIrTestLearned(res, body) {
  const params = formFields(body);
  const deviceId = String(params.deviceId ?? "");
  if (!safeLabel(deviceId)) {
    sendError(res, 400, "choose a device before testing");
    return;
  }
  if (!params.raw && !params.keycode && !params.nec) {
    sendError(res, 400, "learn or enter a signal before testing");
    return;
  }
  const temp = `Signal Test ${Math.floor(Date.now() / 1000)} ${process.pid % 10000}`;
  const added = addIrCommand(deviceId, temp, { protocol: "2", ...params, mode: params.mode || "auto" });
  const cleanup = added.ok ? deleteIrCommand(deviceId, temp) : { ok: false, msg: "" };
  if (added.ok) logEvent({ kind: "ir-test", deviceId, command: temp });
  sendJson(res, added.ok ? 200 : 400, {
    ok: added.ok,
    deviceId,
    tempCommand: added.ok ? temp : "",
    addMessage: added.msg,
    reply: added.ok ? "sim sent" : "",
    cleanupOk: cleanup.ok,
    cleanupMessage: cleanup.msg
  });
}

// render_ir_batch_send_json(): one request sends a chunk, newline-separated.
async function handleIrBatchSend(res, params) {
  const deviceId = String(params.deviceId ?? "");
  const runId = String(params.runId ?? "");
  if (!safeLabel(deviceId)) {
    sendError(res, 400, "invalid IR batch device");
    return;
  }
  if (runId && !/^[A-Za-z0-9_.-]{1,96}$/.test(runId)) {
    sendError(res, 400, "invalid IR run id");
    return;
  }
  const dryRun = params.dryRun === "1" || String(params.dryRun).toLowerCase() === "true";
  const delayMs = Math.min(10000, Math.max(40, parseInt(params.delayMs, 10) || 0));
  const started = Date.now();
  const lines = String(params.commands ?? "").split("\n");
  let sent = 0;
  let skipped = 0;
  let attempted = 0;
  let canceled = false;
  let lastReply = "";
  let i = 0;
  for (; i < lines.length && attempted < LIMITS.batchCommands; i += 1) {
    if (runId && canceledRuns.has(runId)) {
      // The client sends no further chunk of a canceled run.
      canceledRuns.delete(runId);
      canceled = true;
      break;
    }
    const name = lines[i].trim();
    if (!name || !safeLabel(name)) {
      skipped += 1;
      continue;
    }
    attempted += 1;
    if (!dryRun) {
      logEvent({ kind: "ir", deviceId, command: name, runId });
      lastReply = "sim sent";
      // A short real wait per command so a sweep can be watched and stopped.
      await new Promise((resolve) => setTimeout(resolve, Math.min(delayMs, 250)));
    }
    sent += 1;
  }
  skipped += lines.length - i;
  if (sent === 0 && !canceled) {
    sendError(res, 400, "no valid commands selected");
    return;
  }
  sendJson(res, 200, {
    ok: true,
    deviceId,
    runId,
    dryRun,
    canceled,
    sent,
    skipped,
    attempted,
    failed: 0,
    delayMs,
    elapsedMs: Date.now() - started,
    lastReply
  });
}

function handleIrCancel(res, params) {
  const runId = String(params.runId ?? "");
  if (!/^[A-Za-z0-9_.-]{1,96}$/.test(runId)) {
    sendError(res, 400, "invalid IR run id");
    return;
  }
  canceledRuns.add(runId);
  // A cancel that came after its run finished is never collected: keep the newest.
  if (canceledRuns.size > MAX_CANCELED_RUNS) canceledRuns.delete(canceledRuns.values().next().value);
  sendJson(res, 200, { ok: true, runId, canceled: true });
}

function handleIrLabTarget(res) {
  const lab = ensureLabDevice();
  sendJson(res, lab.ok ? 200 : 500, {
    ok: lab.ok,
    deviceId: lab.ok ? lab.id : "",
    name: LAB_DEVICE_NAME,
    created: Boolean(lab.created),
    message: lab.msg
  });
}

function handleIrLabClear(res, params) {
  const lab = ensureLabDevice();
  if (!lab.ok) {
    sendError(res, 500, lab.msg);
    return;
  }
  const deviceId = String(params.deviceId ?? "") || lab.id;
  if (deviceId !== lab.id) {
    sendError(res, 400, "clear only supports the temporary sweep device");
    return;
  }
  const entry = findDeviceEntry(deviceId);
  if (!entry) {
    sendError(res, 500, `Device ${deviceId} not found.`);
    return;
  }
  const count = deviceCommands(entry).length;
  entry.Commands = [];
  sendJson(res, 200, { ok: true, deviceId, message: `Cleared ${count} commands from device ${deviceId}.` });
}

// build_irdb_nec_keycode(): IRDB's NEC, NEC1, NEC1-f16 and NEC2 rows, each
// byte bit-reversed; NEC2 repeats the whole frame.
function irdbKeycode(protocol, device, subdevice, fn) {
  const nec2 = /^nec2$/i.test(protocol);
  if (!nec2 && !/^(nec|nec1|nec1-f16)$/i.test(protocol)) return null;
  const d = parseInt(device, 10) || 0;
  const s = !subdevice || subdevice === "-1" ? d ^ 0xff : parseInt(subdevice, 10) || 0;
  const f = parseInt(fn, 10) || 0;
  // strtoul() wraps a negative value past 255, so the C refuses it too.
  if (![d, s, f].every((n) => n >= 0 && n <= 255)) return null;
  const rev = (n) => parseInt(n.toString(2).padStart(8, "0").split("").reverse().join(""), 2);
  const byte = (n) => rev(n).toString(16).toUpperCase().padStart(2, "0");
  const value = `0x${byte(d)}${byte(s)}${byte(f)}${byte(~f & 0xff)}`;
  return `G:Toshiba 32 Bit:(${value})(${nec2 ? value : "Repeat"})():3`;
}

// keycode_protocol_id(): the protocol a KeyCode names. The sim has no
// ProtocolList, so only the two the hub can add itself are known here.
function keycodeProtocolId(code) {
  const name = /^G:([^:]+):/.exec(String(code || ""))?.[1];
  return name === "Toshiba 32 Bit" ? 2 : name === "MemorexO1 32 Bit" ? 679 : 0;
}

// bulk_import_irdb_commands(): name|keycode, name|keycode|code, name|raw|data, or IRDB CSV.
function handleIrdbImport(res, params) {
  const deviceId = String(params.deviceId ?? "");
  const entry = safeLabel(deviceId) ? findDeviceEntry(deviceId) : null;
  if (!entry) {
    sendError(res, 400, safeLabel(deviceId) ? "Failed to locate device command list." : "Invalid device for IRDB import.");
    return;
  }
  const remaining = LIMITS.storedCommands - deviceCommands(entry).length;
  if (remaining <= 0) {
    sendError(res, 400, `Device ${deviceId} already has the local storage limit of ${LIMITS.storedCommands} commands.`);
    return;
  }
  const staged = [];
  const taken = new Set(deviceCommands(entry).map((c) => String(c?.Name ?? "")));
  const firstId = nextCommandId();
  let submitted = 0;
  let skippedExisting = 0;
  let rejected = 0;
  for (const rawLine of String(params.payload ?? "").split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    let name = "";
    let signal = null;
    if (line.includes("|")) {
      const f = line.split("|").map((v) => v.trim());
      name = f[0];
      if (f.length >= 3 && f[1].toLowerCase() === "raw") signal = { mode: "raw", raw: f[2] };
      else if (f.length >= 3 && f[1].toLowerCase() === "keycode") signal = { mode: "keycode", code: f[2] };
      else if (f.length >= 2) signal = { mode: "keycode", code: f[1] };
    } else {
      const f = line.split(",").map((v) => v.trim());
      if (f.length >= 5 && f[0].toLowerCase() !== "functionname") {
        name = f[0];
        signal = { mode: "keycode", code: irdbKeycode(f[1], f[2], f[3], f[4]) ?? "" };
      }
    }
    if (!name) continue;
    submitted += 1;
    if (!safeLabel(name)) {
      rejected += 1;
    } else if (taken.has(name)) {
      skippedExisting += 1;
    } else if (signal.mode === "raw"
      ? !signal.raw || signal.raw.length > 4096 || /[\u0000-\u001f\u007f]/.test(signal.raw)
      : !signal.code || !keycodeProtocolId(signal.code)) {
      rejected += 1;
    } else if (staged.length >= remaining) {
      rejected += 1;
    } else {
      staged.push(irCommand(firstId + staged.length, name, { protocolId: keycodeProtocolId(signal.code) || 2, ...signal }));
      taken.add(name);
    }
  }
  const counts = `Submitted: ${submitted}  Imported: ${staged.length}  Skipped existing: ${skippedExisting}  Rejected: ${rejected}`;
  if (!staged.length) {
    const message = !submitted ? "IRDB import payload was empty."
      : skippedExisting === submitted ? `All submitted names already exist. ${counts}`
      : !skippedExisting ? `Backend rejected malformed/raw commands. ${counts}`
      : `No supported new IRDB commands were selected. ${counts}`;
    sendError(res, 400, message);
    return;
  }
  deviceCommands(entry).push(...staged);
  logEvent({ kind: "ir-import", deviceId, imported: staged.length });
  sendJson(res, 200, { ok: true, message: counts });
}

// Catalog test surface only: no Logitech connection. The named protocols
// model what a fixture hub already has; they are not new protocol definitions.
const CATALOG_PROTOCOLS = [
  { Id: 2, Name: "Toshiba 32 Bit" },
  { Id: 17, Name: "Sony 15 Bit" },
  { Id: 18, Name: "Sony 20 Bit" },
];

function handleCatalogImport(res, params) {
  const entry = findDeviceEntry(String(params.deviceId ?? ""));
  if (!entry || !Array.isArray(params.commands) || !params.commands.length || params.commands.length > LIMITS.batchCommands) {
    sendError(res, 400, "Catalog import needs a device and commands list within the request limit.");
    return;
  }
  const staged = [];
  const taken = new Set(deviceCommands(entry).map((c) => c.Name));
  let rejected = 0;
  let skipped = 0;
  for (const row of params.commands) {
    if (!row || typeof row.name !== "string" || !safeLabel(row.name)) { rejected++; continue; }
    if (taken.has(row.name)) { skipped++; continue; }
    const raw = typeof row.raw === "string" ? row.raw : "";
    const code = typeof row.keycode === "string" ? row.keycode : "";
    const name = /^G:([^:]+):/.exec(code)?.[1];
    const protocolId = CATALOG_PROTOCOLS.find((p) => p.Name === name)?.Id;
    if ((raw ? raw.length > 2047 || /[\u0000-\u001f\u007f]/.test(raw) : !protocolId || code.length > 511) ||
        deviceCommands(entry).length + staged.length >= LIMITS.storedCommands) { rejected++; continue; }
    staged.push(irCommand(nextCommandId() + staged.length, row.name, { mode: raw ? "raw" : "keycode", raw, code, protocolId }));
    taken.add(row.name);
  }
  const message = `Submitted: ${params.commands.length}  Imported: ${staged.length}  Skipped existing: ${skipped}  Rejected: ${rejected}`;
  if (!staged.length) { sendError(res, 400, message); return; }
  deviceCommands(entry).push(...staged);
  logEvent({ kind: "catalog-import", deviceId: String(params.deviceId), imported: staged.length });
  sendJson(res, 200, { ok: true, message });
}

/* The hub fetches remotecentral.com itself; the sim never goes online and
   answers like a hub without internet access. */
function handleRemoteCentralFetch(res, params) {
  const path = String(params.path ?? "").trim();
  if (!path.startsWith("/cgi-bin/codes/") || path.includes("..")) {
    sendJson(res, 400, { ok: false, source: "remotecentral", error: "invalid RemoteCentral path" });
    return;
  }
  sendJson(res, 200, { ok: false, source: "remotecentral", path, error: "SIMULATED HUB — no internet access" });
}

function buttonIdentity(button) {
  if (!button || typeof button !== "object") return "";
  if (button.ButtonKey != null && button.ButtonKey !== "") return String(button.ButtonKey);
  if (button.TextOnRemote != null && button.TextOnRemote !== "") return String(button.TextOnRemote);
  if (button.MenuItem && button.MenuItem.IndexInMenu != null) return String(button.MenuItem.IndexInMenu);
  return "";
}

function handleControlButton(res, params) {
  const activityId = String(params.activityId ?? "").trim();
  const buttonKey = String(params.buttonKey ?? "").trim();
  let pressType = String(params.pressType ?? "press").trim().toLowerCase() || "press";
  if (!/^-?\d+$/.test(activityId)) {
    sendError(res, 400, "activityId must be -1 or a non-negative integer");
    return;
  }
  if (!buttonKey) {
    sendError(res, 400, "buttonKey is required");
    return;
  }
  if (!["press", "long", "double"].includes(pressType)) pressType = "press";
  const buttonMaps = Array.isArray(state.mapList.ButtonMaps) ? state.mapList.ButtonMaps : [];
  const maps = buttonMaps.filter((map) =>
    map && map.__type === "ActivityButtonMap" && String(map["ActivityId-"]) === activityId);
  if (!maps.length) {
    sendError(res, 404, `no ActivityButtonMap for activityId ${activityId}`);
    return;
  }
  let button = null;
  for (const map of maps) {
    const buttons = Array.isArray(map.Buttons) ? map.Buttons : [];
    button = buttons.find((candidate) => buttonIdentity(candidate) === buttonKey) || null;
    if (button) break;
  }
  if (!button) {
    sendError(res, 404, `button "${buttonKey}" not found in activity ${activityId} maps`);
    return;
  }
  const actionFor = {
    press: button.ButtonAction,
    long: button.ButtonLongPressAction,
    double: button.ButtonDoublePressAction
  };
  const action = actionFor[pressType] || button.ButtonAction;
  if (!action || typeof action !== "object") {
    sendError(res, 404, `button "${buttonKey}" has no action for pressType "${pressType}"`);
    return;
  }
  if (action.__type !== "ButtonCommandAction" || action["DeviceId-"] == null || !action.CommandName) {
    sendError(res, 422, `button "${buttonKey}" action is not a device command (${action.__type || "unknown"})`);
    return;
  }
  const deviceId = String(action["DeviceId-"]);
  const command = String(action.CommandName);
  logEvent({ kind: "button", activityId, buttonKey, pressType, deviceId, command });
  sendJson(res, 200, { ok: true, deviceId, command, pressType, activityId });
}

const EXPORTS = {
  "/export/protocols": { file: "ProtocolList.json", resource: () => ({ Protocols: CATALOG_PROTOCOLS }) },
  "/export/activities": { file: "ActivityList.json", resource: () => state.activityList },
  "/export/maps": { file: "MapList.json", resource: () => state.mapList },
  "/export/functions": { file: "FunctionList.json", resource: () => state.functionList },
  "/export/devices": { file: "DeviceList.json", resource: () => state.deviceList },
  "/export/automation": { file: "AutomationConfig.json", resource: () => ({}) },
  "/export/mqtt": { file: "mqtt.json", resource: () => ({}) },
  "/export/wifi": { file: "wifi.json", resource: () => ({}) },
  "/export/restrictions": { file: "activity-restrictions.json", resource: () => ({ version: 1, activities: simRestrictions }) }
};

function handleExport(res, pathname) {
  if (pathname === "/export/cloud") {
    const body = "1\n";
    res.writeHead(200, {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Length": Buffer.byteLength(body),
      "Cache-Control": "no-store"
    });
    res.end(body);
    return;
  }
  if (pathname === "/export/timezone") {
    const body = "America/New_York\nEST5EDT,M3.2.0,M11.1.0\n";
    res.writeHead(200, {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Length": Buffer.byteLength(body),
      "Cache-Control": "no-store"
    });
    res.end(body);
    return;
  }
  if (pathname === "/export/bundle") {
    sendJson(res, 200, {
      format: "harmony-owner-bundle-v2",
      simulated: true,
      "ActivityList.json": state.activityList,
      "MapList.json": state.mapList,
      "FunctionList.json": state.functionList,
      "DeviceList.json": state.deviceList,
      "AutomationConfig.json": {},
      "activity-restrictions.json": { version: 1, activities: simRestrictions }
    }, { "Content-Disposition": 'attachment; filename="harmony-owner-bundle.json"' });
    return;
  }
  const entry = EXPORTS[pathname];
  if (!entry) {
    sendError(res, 404, "not found");
    return;
  }
  sendJson(res, 200, entry.resource(), {
    "Content-Disposition": `attachment; filename="${entry.file}"`
  });
}

/* Like codex_webui's request_same_origin_json(): the routes that change the
   radio or reboot the hub take only application/json, and a browser's Origin,
   when sent, must be this host. */
const SAME_ORIGIN_JSON_ROUTES = new Set(["POST /api/multi-remote", "POST /api/remote-unpair", "POST /api/usb-eth", "POST /api/activity-restrictions"]);
const SAME_ORIGIN_JSON_ERROR =
  "This change takes a JSON request (Content-Type: application/json) from the hub's own web app.";

function sameOriginJson(req) {
  const type = String(req.headers["content-type"] || "");
  const m = /^application\/json(?:$|[;\s])/i.exec(type.trim());
  if (!m) return false;
  if (req.headers.origin === undefined) return true;
  const o = /^https?:\/\/(.*)$/i.exec(String(req.headers.origin).trim());
  const host = String(req.headers.host || "").trim();
  return Boolean(o && host && o[1].toLowerCase() === host.toLowerCase());
}

async function handleApi(req, res, pathname, url) {
  if (req.method === "POST" && pathname === "/api/ha-state") {
    await handleHaStatePost(req, res);
    return;
  }
  let params;
  try {
    params = await parseParams(req, url);
  } catch (error) {
    sendError(res, error.status || 413, error.message || "bad request body");
    return;
  }
  const route = `${req.method} ${pathname}`;
  if (SAME_ORIGIN_JSON_ROUTES.has(route) && !sameOriginJson(req)) {
    sendJson(res, 403, { ok: false, error: SAME_ORIGIN_JSON_ERROR });
    return;
  }
  switch (route) {
    case "GET /api/activity-config":
      handleActivityConfig(res);
      return;
    case "GET /api/activity-state":
      handleActivityState(res);
      return;
    case "POST /api/activity-run":
      handleActivityRun(res, params);
      return;
    case "POST /api/activity-save":
      handleActivitySave(res, params);
      return;
    case "POST /api/activity-sync":
      handleActivitySync(res);
      return;
    case "POST /api/device-settings":
      handleDeviceSettings(res, params);
      return;
    case "GET /api/ha-state":
      handleHaStateGet(res, params);
      return;
    case "POST /api/device-screen":
      // The hub builds Touch screens in codexactivity.lua; a copy here could drift.
      sendJson(res, 501, { ok: false, error: "The simulator doesn't build Touch screens; the hub does." });
      return;
    case "GET /api/inventory":
      handleInventory(res);
      return;
    case "GET /api/device-commands":
    case "POST /api/device-commands":
      handleDeviceCommands(res, params);
      return;
    case "POST /api/ir-send":
      handleIrSend(res, params);
      return;
    case "POST /api/control-button":
    case "GET /api/control-button":
      handleControlButton(res, params);
      return;
    case "GET /api/sim/events":
      sendJson(res, 200, { ok: true, events: state.events.slice(-EVENT_LOG_LIMIT) });
      return;
    case "POST /api/sim/reset": {
      try {
        loadFixture();
        resetSimRemotes();
        state.events.length = 0;
        captureArmed = false;
        canceledRuns.clear();
        sendJson(res, 200, { ok: true, revision: state.revision, currentActivityId: state.currentActivityId });
      } catch (error) {
        sendError(res, 500, `fixture reload failed: ${error.message}`);
      }
      return;
    }
    case "GET /api/androidtv/status":
      sendJson(res, 200, {
        ok: true, version: "sim", identity: "ready",
        tvs: [...simAndroidTv.tvs.values()].map((tv) => ({
          id: tv.id, name: tv.name, vendor: "Sim", model: "Sim TV", host: tv.host, mac: "02:00:00:00:00:60", connected: true,
          on: tv.on, volume: 12, volumeMax: 100, muted: false, keysSent: 0, connects: 1, error: ""
        }))
      });
      return;
    case "GET /api/androidtv/discover":
      sendJson(res, 200, {
        ok: true, searching: false,
        found: SIM_ANDROIDTV_FOUND.map((f) => ({
          ...f, paired: [...simAndroidTv.tvs.values()].find((tv) => tv.host === f.host)?.id ?? ""
        }))
      });
      return;
    case "POST /api/androidtv/pair-start": {
      const host = String(params.host ?? "");
      if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
        sendJson(res, 200, { ok: false, error: "Enter the TV's IPv4 address, such as 192.168.1.40." });
        return;
      }
      simAndroidTv.pair = { state: "preparing", host, name: String(params.name ?? ""), error: "", tvId: "", at: Date.now() };
      sendJson(res, 200, simAndroidTvPairState());
      return;
    }
    case "GET /api/androidtv/pair-status":
      sendJson(res, 200, simAndroidTvPairState());
      return;
    case "POST /api/androidtv/pair-finish": {
      const code = String(params.code ?? "").toUpperCase();
      if (simAndroidTvPairState().state !== "code") {
        sendJson(res, 200, { ok: false, error: "The TV isn't waiting for a code. Start again." });
        return;
      }
      if (code !== SIM_ANDROIDTV_CODE) {
        sendJson(res, 200, { ok: false, error: "That code doesn't match. Check the code on the TV and try again." });
        return;
      }
      simAndroidTv.pair.state = "checking";
      simAndroidTv.pair.at = Date.now();
      sendJson(res, 200, simAndroidTvPairState());
      return;
    }
    case "POST /api/androidtv/pair-cancel": {
      // Like codex_androidtv: a pairing that has finished stays, and the answer
      // names its TV so the caller can tidy up.
      const done = simAndroidTvPairState();
      simAndroidTv.pair.state = "idle";
      sendJson(res, 200, { ...done, state: "idle" });
      return;
    }
    case "POST /api/androidtv/forget":
      simAndroidTv.tvs.delete(String(params.id ?? ""));
      sendJson(res, 200, { ok: true });
      return;
    case "POST /api/androidtv/rename":
      sendJson(res, 200, { ok: true });
      return;
    case "POST /api/androidtv/devices":
      handleAndroidTvDevices(res, params);
      return;
    case "GET /api/remotes":
      sendJson(res, 200, simPairing
        ? { ok: true, pairing: true }
        : { ok: true, pairing: false, multiRemote: simMultiRemote, slots: SIM_RF_SLOTS, reply: simRfInfo() });
      return;
    case "POST /api/remote-unpair": {
      // Like codex_webui's json_top_int(): the top-level token must be a plain
      // integer, so "2", 1.5, 1e1, 2e0 and 2.0 are all refused.
      const token = jsonTopToken(params.__raw, "slot");
      const slot = token !== null && /^-?\d+$/.test(token) ? Number(token) : NaN;
      if (!Number.isInteger(slot) || slot < 1 || slot > SIM_RF_SLOTS) {
        sendJson(res, 400, { ok: false, error: "Give the remote's slot, 1 to 6." });
        return;
      }
      if (simPairing) {
        sendJson(res, 409, { ok: false, pairing: true, error: "A pairing window is already open on the hub." });
        return;
      }
      const before = simRfInfo();
      if (!simRemotes.some((r) => r.DeviceIndex === String(slot))) {
        sendJson(res, 404, { ok: false, error: `No remote is paired in slot ${slot}.`, before });
        return;
      }
      simRemotes = simRemotes.filter((r) => r.DeviceIndex !== String(slot));
      logEvent({ kind: "remote-unpair", message: `Remote in slot ${slot} unpaired` });
      sendJson(res, 200, { ok: true, slot, code: 200, reply: JSON.stringify({ id: 1, code: 200 }), before, after: simRfInfo() });
      return;
    }
    case "POST /api/sim/multi-remote":
      // Sim only: {"on": bool} runs that hal; optional "enabled" (the saved setting, e.g. on but
      // not running after a firmware update), "halSupported" and "radioHung" (rf.info hangs).
      simMultiRemote = Boolean(params.on);
      simMultiEnabled = typeof params.enabled === "boolean" ? params.enabled : simMultiRemote;
      if (typeof params.halSupported === "boolean") simHalSupported = params.halSupported;
      if (typeof params.radioHung === "boolean") simRadioHung = params.radioHung;
      sendJson(res, 200, { ok: true, multiRemote: simMultiRemote, enabled: simMultiEnabled, halSupported: simHalSupported, radioHung: simRadioHung });
      return;
    case "GET /api/multi-remote":
      sendJson(res, 200, simMultiRemoteState());
      return;
    case "GET /api/activity-restrictions":
      sendJson(res, 200, { ok: true, activities: simRestrictions });
      return;
    case "POST /api/activity-restrictions":
      handleRestrictionsSet(res, params);
      return;
    case "POST /api/multi-remote":
      handleMultiRemoteSet(res, params);
      return;
    case "POST /api/sim/usb-eth":
      if (typeof params.supported === "boolean") simUsbEthSupported = params.supported;
      if (typeof params.enabled === "boolean") simUsbEthEnabled = params.enabled;
      if (typeof params.ehciBound === "boolean") simUsbEthEhciBound = params.ehciBound;
      if (params.adapter === null) simUsbEthAdapter = null;
      else if (params.adapter && typeof params.adapter === "object") simUsbEthAdapter = { ...params.adapter };
      if (params.state === null) simUsbEthForcedState = null;
      else if (typeof params.state === "string") simUsbEthForcedState = { state: params.state, reason: String(params.reason || "") };
      // How the cable fares: "separate" (on another network than the hub's
      // gateway: only an extra address), "gatewayLost" (the gateway stopped
      // answering through it: gateway_unreachable), "wifiNeedsRestart" (the
      // egress guard predates its Wi-Fi watchdog: Wi-Fi off waits for a restart).
      if (typeof params.separate === "boolean") simUsbEthSeparate = params.separate;
      if (typeof params.gatewayLost === "boolean") simUsbEthGatewayLost = params.gatewayLost;
      if (typeof params.wifiNeedsRestart === "boolean") simUsbEthNeedsRestart = params.wifiNeedsRestart;
      sendJson(res, 200, simUsbEthState());
      return;
    case "GET /api/usb-eth":
      sendJson(res, 200, simUsbEthState());
      return;
    case "GET /api/network-overview":
      sendJson(res, 200, simNetworkOverview());
      return;
    case "POST /api/usb-eth":
      handleUsbEthSet(res, params);
      return;
    case "POST /api/remote-pair":
      await handleRemotePair(res, params);
      return;
    case "POST /api/sim/remotes":
      // Sim only: set the radio's slot table, e.g. {"devices":[{"EquadID":"16417","SkinId":"5","DeviceIndex":"1"}]}.
      if (!Array.isArray(params.devices)) {
        sendError(res, 400, "body must contain a devices array");
        return;
      }
      simRemotes = params.devices.map((d, i) => ({
        EquadID: String(d.EquadID ?? ""),
        SkinId: String(d.SkinId ?? ""),
        DeviceIndex: String(d.DeviceIndex ?? i + 1),
        RFID: String(d.RFID ?? 1000000001 + i)
      }));
      sendJson(res, 200, { ok: true, reply: simRfInfo() });
      return;
    case "GET /api/bt-call":
    case "POST /api/bt-call":
      sendJson(res, 200, { ok: true, action: String(params.action || ""), reply: "sim stub: no bluetooth hardware" });
      return;
    case "GET /api/bt-text-status":
      sendJson(res, 200, {
        ok: true,
        state: "sim",
        detail: "SIMULATED HUB — no Bluetooth FIFO runtime",
        sent: 0,
        skipped: 0
      });
      return;
    case "GET /api/capture":
    case "POST /api/capture":
      handleCapture(res);
      return;
    case "POST /api/sim/capture-next":
      captureArmed = true;
      sendJson(res, 200, { ok: true, armed: true });
      return;
    case "POST /api/ir-test-learned":
      handleIrTestLearned(res, params);
      return;
    case "POST /api/ir-batch-send":
      await handleIrBatchSend(res, params);
      return;
    case "POST /api/ir-cancel":
      handleIrCancel(res, params);
      return;
    case "POST /api/ir-lab-target":
      handleIrLabTarget(res);
      return;
    case "POST /api/ir-lab-clear":
      handleIrLabClear(res, params);
      return;
    case "POST /api/irdb-import":
      handleIrdbImport(res, params);
      return;
    case "POST /api/catalog-import":
      handleCatalogImport(res, params);
      return;
    case "GET /api/remotecentral-fetch":
    case "POST /api/remotecentral-fetch":
      handleRemoteCentralFetch(res, params);
      return;
    case "GET /api/version":
      sendJson(res, 200, {
        ok: true,
        product: "melodious",
        version: "1.3.0",
        api: 1,
        update: { protocol: 0 },
        features: [
          "activity-save", "activity-sync", "catalog-import", "device-commands",
          "androidtv-devices", "device-screen", "device-settings", "ha-devices", "ha-devices-v2",
          "ha-state", "irdb-import", "remote-pair"
        ]
      });
      return;
    case "GET /api/update-status":
      sendJson(res, 200, {
        ok: true,
        version: "1.3.0",
        repo: "https://github.com/schlambos/harmony-hub-control",
        files: []
      });
      return;
    case "GET /api/system-status":
      sendJson(res, 200, {
        ok: true,
        firmware: "SIMULATED HUB",
        uptime: "0h 0m",
        memTotal: "",
        memory: "",
        uname: "SIMULATED HUB — no live device",
        mounts: "",
        processes: "",
        logs: "SIMULATED HUB — no logs",
        authMode: "open on local network"
      });
      return;
    default:
      sendError(res, 404, "not found");
  }
}

function placeholderPage(res) {
  const body = [
    "<!doctype html><html><head><meta charset=\"utf-8\"><title>SIMULATED HUB</title></head><body>",
    "<h1>SIMULATED HUB — no live device</h1>",
    "<p>Drop the web UI build into <code>tools/webui-sim/public/</code> to serve it here.</p>",
    "<ul>",
    "<li><a href=\"/api/activity-config\">/api/activity-config</a></li>",
    "<li><a href=\"/api/activity-state\">/api/activity-state</a></li>",
    "<li><a href=\"/api/inventory\">/api/inventory</a></li>",
    "<li><a href=\"/api/sim/events\">/api/sim/events</a></li>",
    "</ul></body></html>"
  ].join("\n");
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function serveStatic(res, pathname) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    sendError(res, 400, "bad path");
    return;
  }
  const resolved = path.resolve(PUBLIC_DIR, `.${rel}`);
  if (resolved !== PUBLIC_DIR && !resolved.startsWith(PUBLIC_DIR + path.sep)) {
    sendError(res, 403, "forbidden");
    return;
  }
  let stat = fs.statSync(resolved, { throwIfNoEntry: false });
  let file = resolved;
  if (stat && stat.isDirectory()) {
    file = path.join(resolved, "index.html");
    stat = fs.statSync(file, { throwIfNoEntry: false });
  }
  if (!stat || !stat.isFile()) {
    // SPA fallback: extensionless paths serve the app shell.
    if (!path.extname(resolved)) {
      const index = path.join(PUBLIC_DIR, "index.html");
      const indexStat = fs.statSync(index, { throwIfNoEntry: false });
      if (indexStat && indexStat.isFile()) {
        file = index;
        stat = indexStat;
      } else {
        placeholderPage(res);
        return;
      }
    } else {
      sendError(res, 404, "not found");
      return;
    }
  }
  const type = MIME[path.extname(file).toLowerCase()] || "application/octet-stream";
  res.writeHead(200, {
    "Content-Type": type,
    "Content-Length": stat.size,
    "Cache-Control": "no-cache"
  });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer((req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${HOST}:${PORT}`);
    const pathname = url.pathname;
    if (pathname.startsWith("/api/")) {
      handleApi(req, res, pathname, url).catch((error) => {
        if (!res.headersSent) sendError(res, 500, `internal error: ${error.message}`);
        else res.end();
      });
      return;
    }
    if (pathname.startsWith("/export/")) {
      if (req.method !== "GET") {
        sendError(res, 405, "method not allowed");
        return;
      }
      handleExport(res, pathname);
      return;
    }
    if (pathname.startsWith("/ir/") && req.method === "POST") {
      parseParams(req, url)
        .then((params) => handleIrForm(res, pathname, params))
        .catch((error) => {
          if (!res.headersSent) sendError(res, error.status || 413, error.message || "bad request body");
          else res.end();
        });
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      sendError(res, 405, "method not allowed");
      return;
    }
    serveStatic(res, ASSET_ALIASES[pathname] ?? pathname);
  } catch (error) {
    if (!res.headersSent) sendError(res, 500, `internal error: ${error.message}`);
    else res.end();
  }
});

try {
  loadFixture();
  resetSimRemotes();
} catch (error) {
  console.error(`Failed to load fixture ${FIXTURE_PATH}: ${error.message}`);
  process.exit(1);
}

server.listen(PORT, HOST, () => {
  const activityCount = activities().length;
  const deviceCount = devicesWithFeatures().length;
  console.log("");
  console.log("============================================================");
  console.log(" SIMULATED HUB — no live device");
  console.log(" harmony-hub-control web UI simulator (offline mock API)");
  console.log(` Listening:    http://${HOST}:${PORT}`);
  console.log(` Fixture:      ${FIXTURE_PATH}`);
  console.log(` Static root:  ${PUBLIC_DIR}`);
  console.log(` Loaded:       ${activityCount} activities, ${deviceCount} devices, revision ${state.revision}`);
  console.log(" This server NEVER contacts 192.168.0.123 or any real hub.");
  console.log(" Debug:        GET /api/sim/events   POST /api/sim/reset");
  console.log("============================================================");
});

server.on("error", (error) => {
  console.error(`Server failed to start on http://${HOST}:${PORT} — ${error.message}`);
  process.exit(1);
});
