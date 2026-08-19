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

function handleActivityConfig(res) {
  sendJson(res, 200, {
    ok: true,
    revision: state.revision,
    activityList: state.activityList,
    mapList: state.mapList,
    functionList: state.functionList,
    deviceList: state.deviceList
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
    activityEngineReady: true,
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
    displayDeviceLimit: 64,
    displayCommandLimit: 20000,
    storageCommandLimit: 20000,
    batchCommandLimit: 500,
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

function handleIrSend(res, params) {
  const deviceId = String(params.deviceId ?? "").trim();
  const command = String(params.command ?? "").trim();
  if (!deviceId || !command || !/^[0-9A-Za-z _+\-.:/]{1,127}$/.test(command)) {
    sendError(res, 400, "invalid IR command request");
    return;
  }
  logEvent({ kind: "ir", deviceId, command });
  sendJson(res, 200, { ok: true, deviceId, command, reply: "sim sent" });
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
  "/export/activities": { file: "ActivityList.json", resource: () => state.activityList },
  "/export/maps": { file: "MapList.json", resource: () => state.mapList },
  "/export/functions": { file: "FunctionList.json", resource: () => state.functionList },
  "/export/devices": { file: "DeviceList.json", resource: () => state.deviceList },
  "/export/automation": { file: "AutomationConfig.json", resource: () => ({}) },
  "/export/mqtt": { file: "mqtt.json", resource: () => ({}) },
  "/export/wifi": { file: "wifi.json", resource: () => ({}) }
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
  if (pathname === "/export/bundle") {
    sendJson(res, 200, {
      format: "harmony-owner-bundle-v2",
      simulated: true,
      "ActivityList.json": state.activityList,
      "MapList.json": state.mapList,
      "FunctionList.json": state.functionList,
      "DeviceList.json": state.deviceList,
      "AutomationConfig.json": {}
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

async function handleApi(req, res, pathname, url) {
  let params;
  try {
    params = await parseParams(req, url);
  } catch (error) {
    sendError(res, error.status || 413, error.message || "bad request body");
    return;
  }
  const route = `${req.method} ${pathname}`;
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
        state.events.length = 0;
        sendJson(res, 200, { ok: true, revision: state.revision, currentActivityId: state.currentActivityId });
      } catch (error) {
        sendError(res, 500, `fixture reload failed: ${error.message}`);
      }
      return;
    }
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
      sendJson(res, 200, {
        ok: true,
        raw: "",
        mode: "",
        protocolId: 0,
        keycode: "",
        nec: "",
        analysis: "SIMULATED HUB — no IR receiver"
      });
      return;
    case "GET /api/update-status":
      sendJson(res, 200, {
        ok: true,
        repo: "https://github.com/Ripthulhu/harmony-hub-control",
        rawBase: "",
        files: []
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
