#!/usr/bin/env node
// hub-emu contract QA — proves the emulator serves the box's REAL API
// semantics, including the strict behaviors the old JS mock hid
// (form-only parsers, 404 for invented endpoints, revision conflicts, 413).
//
// Run after ./run.sh:  node tools/hub-emu/qa.mjs

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const API = process.env.API ?? "http://127.0.0.1:8788";
const CTRL = process.env.CTRL ?? "http://127.0.0.1:8789";

let passed = 0;
let failed = 0;

function check(name, condition, detail = "") {
  if (condition) {
    passed++;
    console.log(`  ok  ${name}`);
  } else {
    failed++;
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function req(base, path, options = {}) {
  const response = await fetch(base + path, options);
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON responses are asserted via text */
  }
  return { status: response.status, headers: Object.fromEntries(response.headers), text, json };
}

const form = (data) => ({
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(data).toString(),
});

const jsonBody = (data) => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(data),
});

const POST_RESULT_MAX_BYTES = 4096;
const SYSTEM_STATUS_MAX_BYTES = 65536;
const FULL_APPLICATION_MARKERS = [
  "<section id='view-overview'",
  "<section id='view-activities'",
  "<section id='view-ir'",
  "<section id='view-bluetooth'",
  "<section id='view-backup'",
  "<section id='view-system'",
  "/assets/activity-ui.js",
  "/assets/harmony-shell.js",
  "REMOTE_SKIN_SRC=",
  "data:image/jpeg;base64,",
];

function checkCompactPost(name, result, expectedMessage) {
  const bytes = Buffer.byteLength(result.text);
  const leakedMarker = FULL_APPLICATION_MARKERS.find((marker) => result.text.includes(marker));
  check(
    `${name} returns bounded compact result HTML`,
    result.status === 200 &&
      result.headers["content-type"]?.startsWith("text/html") &&
      result.headers["cache-control"] === "no-store" &&
      result.headers.connection?.toLowerCase() === "close" &&
      result.text.startsWith("<!doctype html>") &&
      result.text.includes("<div class='msg'>") &&
      result.text.includes(expectedMessage) &&
      result.text.includes("<a href='/'>") &&
      result.text.endsWith("</html>") &&
      bytes < POST_RESULT_MAX_BYTES &&
      !leakedMarker,
    `status=${result.status} bytes=${bytes} leaked=${leakedMarker ?? "none"}`,
  );
}

const authorizedForm = (data, authorization) => {
  const options = form(data);
  options.headers.Authorization = authorization;
  return options;
};

// Start from pristine state.
await req(CTRL, "/reset", { method: "POST" });

console.log("\n== data layer ==");
const config = await req(API, "/api/activity-config");
check("GET /api/activity-config -> 200 ok", config.status === 200 && config.json?.ok === true);
check(
  "config carries revision + all four lists",
  typeof config.json?.revision === "string" &&
    Array.isArray(config.json?.activityList?.Activities) &&
    Array.isArray(config.json?.mapList?.ButtonMaps) &&
    Array.isArray(config.json?.functionList?.FunctionMaps) &&
    Array.isArray(config.json?.deviceList?.DevicesWithFeatures)
);

const state0 = await req(API, "/api/activity-state");
const reply0 = state0.json?.reply ? JSON.parse(state0.json.reply) : null;
check("GET /api/activity-state -> 200 ok (webui -> real codex_hbus -> WS engine)", state0.status === 200 && state0.json?.ok === true);
check(
  "state reply is the genuine nested engine envelope (data.result)",
  reply0?.code === 200 && reply0?.data?.result === "-1",
  state0.json?.reply
);

console.log("\n== action layer: body-encoding fidelity ==");
const activities = config.json.activityList.Activities;
const someActivity = String(activities[0]["Id-"]);
const runJson = await req(API, "/api/activity-run", jsonBody({ activityId: Number(someActivity) }));
check("POST /api/activity-run with JSON body -> 400 (form_value cannot parse JSON)", runJson.status === 400, `got ${runJson.status}`);

const runForm = await req(API, "/api/activity-run", form({ activityId: someActivity }));
check("POST /api/activity-run form-encoded -> 200 ok", runForm.status === 200 && runForm.json?.ok === true, runForm.text.slice(0, 120));

const state1 = await req(API, "/api/activity-state");
const reply1 = state1.json?.reply ? JSON.parse(state1.json.reply) : null;
check("engine now reports the started activity", reply1?.data?.result === someActivity, state1.json?.reply);

const devices = config.json.deviceList.DevicesWithFeatures;
const irDevice = devices.find((d) => Number(d.Device?.Transport ?? 1) !== 32);
const btDevice = devices.find((d) => Number(d.Device?.Transport) === 32);
const irCommand = irDevice?.Commands?.[0]?.Name ?? "PowerToggle";

const irJson = await req(API, "/api/ir-send", jsonBody({ deviceId: String(irDevice.Device["Id-"]), command: irCommand }));
check("POST /api/ir-send with JSON body -> 400", irJson.status === 400, `got ${irJson.status}`);

const irForm = await req(API, "/api/ir-send", form({ deviceId: String(irDevice.Device["Id-"]), command: irCommand }));
check("POST /api/ir-send form-encoded (IR device) -> 200", irForm.status === 200 && irForm.json?.ok === true, irForm.text.slice(0, 160));

let btForm = { status: 0, json: null, text: "unavailable (no BT device in fixture)" };
if (btDevice) {
  const btCommand = btDevice.Commands?.[0]?.Name ?? "Home";
  btForm = await req(API, "/api/ir-send", form({ deviceId: String(btDevice.Device["Id-"]), command: btCommand }));
  check("POST /api/ir-send form-encoded (Bluetooth device, Transport 32) -> 200", btForm.status === 200 && btForm.json?.ok === true, btForm.text.slice(0, 160));
}

console.log("\n== endpoints the box does not have ==");
const controlButton = await req(API, "/api/control-button", jsonBody({ activityId: someActivity, buttonKey: "VolumeUp" }));
check("POST /api/control-button -> 404 (sim-only endpoint)", controlButton.status === 404, `got ${controlButton.status}`);
const simEvents = await req(API, "/api/sim/events");
check("GET /api/sim/events -> 404 (sim-only endpoint)", simEvents.status === 404, `got ${simEvents.status}`);

console.log("\n== full-graph save: writer daemon + revision semantics ==");
const noop = await req(
  API,
  "/api/activity-save",
  jsonBody({
    baseRevision: config.json.revision,
    activityList: config.json.activityList,
    mapList: config.json.mapList,
    functionList: config.json.functionList,
  })
);
check("no-change save with fresh baseRevision -> 200 saved", noop.status === 200 && noop.json?.saved === true, noop.text.slice(0, 160));
check("no-change save reports activityChanged=false", noop.json?.activityChanged === false);

const renamed = structuredClone(config.json.activityList);
renamed.Activities[0].Name = "QA Renamed Activity";
const mutate = await req(
  API,
  "/api/activity-save",
  jsonBody({
    baseRevision: noop.json.revision,
    activityList: renamed,
    mapList: config.json.mapList,
    functionList: config.json.functionList,
  })
);
check("mutating save -> 200 with activityChanged=true", mutate.status === 200 && mutate.json?.activityChanged === true, mutate.text.slice(0, 200));

const configAfter = await req(API, "/api/activity-config");
check(
  "mutation persisted through the offline writer and re-read from disk",
  configAfter.json?.activityList?.Activities?.[0]?.Name === "QA Renamed Activity"
);
check("revision advanced after mutation", configAfter.json?.revision !== noop.json?.revision);

const stale = await req(
  API,
  "/api/activity-save",
  jsonBody({
    baseRevision: config.json.revision, // stale by two saves
    activityList: config.json.activityList,
    mapList: config.json.mapList,
    functionList: config.json.functionList,
  })
);
check("save with stale baseRevision -> 409 with current revision", stale.status === 409 && typeof stale.json?.revision === "string", `got ${stale.status}`);

console.log("\n== box resource limits ==");
const big = await req(API, "/api/activity-save", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: `{"pad":"${"x".repeat(1100 * 1024)}"}`,
});
check("body over the box's 1 MiB MAX_REQUEST_BODY -> 413", big.status === 413, `got ${big.status}`);

console.log("\n== control plane (out-of-band) ==");
const events = await req(CTRL, "/events");
const kinds = (events.json?.events ?? []).map((e) => e.kind);
check("engine event log captured startactivity", kinds.includes("startactivity"), kinds.join(","));
check("engine event log captured holdaction (IR/BT sends)", kinds.includes("holdaction"), kinds.join(","));

const reset = await req(CTRL, "/reset", { method: "POST" });
check("POST /reset -> 200", reset.status === 200 && reset.json?.ok === true);
const configReset = await req(API, "/api/activity-config");
check(
  "reset restored the pristine fixture",
  configReset.json?.activityList?.Activities?.[0]?.Name !== "QA Renamed Activity" &&
    configReset.json?.revision === config.json?.revision
);
const stateReset = await req(API, "/api/activity-state");
const replyReset = stateReset.json?.reply ? JSON.parse(stateReset.json.reply) : null;
check("reset returned engine to PowerOff (-1)", replyReset?.data?.result === "-1");

console.log("\n== compact read-only System status ==");
const systemStatus = await req(API, "/api/system-status");
const expectedSystemKeys = [
  "authMode", "firmware", "logs", "memTotal", "memory",
  "mounts", "ok", "processes", "uname", "uptime",
];
check(
  "GET /api/system-status -> 200 no-store JSON with the complete shape",
  systemStatus.status === 200 &&
    systemStatus.headers["content-type"]?.startsWith("application/json") &&
    systemStatus.headers["cache-control"] === "no-store" &&
    systemStatus.headers.connection?.toLowerCase() === "close" &&
    systemStatus.json?.ok === true &&
    JSON.stringify(Object.keys(systemStatus.json ?? {}).sort()) === JSON.stringify(expectedSystemKeys),
  systemStatus.text.slice(0, 200),
);
const displayedMemTotal = systemStatus.json?.memory?.match(/^MemTotal:\s*([^\n]+)/m)?.[1]?.trim();
check(
  "System status uses the seeded firmware and existing bounded read-only sources",
  systemStatus.json?.firmware === "4.15.600" &&
    /^(?:\d+d )?\d+h \d+m$/.test(systemStatus.json?.uptime ?? "") &&
    systemStatus.json?.memTotal === displayedMemTotal &&
    systemStatus.json?.uname?.includes("Linux") &&
    systemStatus.json?.mounts?.includes(" on / ") &&
    systemStatus.json?.processes?.includes("qemu-mips /opt/hub/bin/codex_webui.mips 8080") &&
    systemStatus.json?.logs?.includes("--- startup log ---") &&
    systemStatus.json?.logs?.includes("--- recovery log ---") &&
    systemStatus.json?.logs?.includes("--- local service syslog ---") &&
    systemStatus.json?.authMode === "open on local network",
  systemStatus.text.slice(0, 300),
);
const systemStatusBytes = Buffer.byteLength(systemStatus.text);
const systemStatusLeak = FULL_APPLICATION_MARKERS.find((marker) => systemStatus.text.includes(marker));
check(
  "System status stays below 64 KiB without application HTML, IR data, or fixture secrets",
  systemStatusBytes < SYSTEM_STATUS_MAX_BYTES &&
    !systemStatusLeak &&
    !systemStatus.text.includes("DeviceList.json") &&
    !systemStatus.text.includes("hub-emu-fake-password") &&
    !systemStatus.text.includes("hub-emu-fake-passphrase"),
  `bytes=${systemStatusBytes} leaked=${systemStatusLeak ?? "none"}`,
);

console.log("\n== setup pages: seeded fake-only settings ==");
const expMqtt = await req(API, "/export/mqtt");
check(
  "GET /export/mqtt -> seeded fake broker config (disabled, .invalid host)",
  expMqtt.status === 200 && expMqtt.json?.broker?.host === "mqtt.hub-emu.invalid" && expMqtt.json?.enabled === false
);
const expWifi = await req(API, "/export/wifi");
check("GET /export/wifi -> seeded fake SSID", expWifi.status === 200 && expWifi.text.includes("HUB-EMU-FAKE-SSID"));
const expBt = await req(API, "/export/bluetooth");
check(
  "GET /export/bluetooth -> seeded empty store",
  expBt.status === 200 && Array.isArray(expBt.json?.devices) && expBt.json.devices.length === 0
);
const expCloud = await req(API, "/export/cloud");
check("GET /export/cloud -> seeded cloud blocker stays 1", expCloud.status === 200 && expCloud.text.trim() === "1");

console.log("\n== setup pages: legacy form parsers ignore JSON bodies ==");
const wifiJson = await req(API, "/wifi", jsonBody({ ssid: "HUB-EMU-JSON-SSID", password: "hub-emu-json-pass" }));
check(
  "POST /wifi with JSON body -> 200 HTML 'Wi-Fi SSID is required.' (form_value sees no ssid)",
  wifiJson.status === 200 && wifiJson.text.includes("Wi-Fi SSID is required."),
  wifiJson.text.slice(0, 120)
);
checkCompactPost("POST /wifi JSON validation", wifiJson, "Wi-Fi SSID is required.");
const systemJson = await req(API, "/system", jsonBody({ action: "reboot" }));
check(
  "POST /system with JSON body -> 200 HTML 'Unknown system action.' (non-mutating probe)",
  systemJson.status === 200 && systemJson.text.includes("Unknown system action."),
  systemJson.text.slice(0, 120)
);
checkCompactPost("POST /system JSON validation", systemJson, "Unknown system action.");
const getSystem = await req(API, "/system");
check("GET /system -> 404 (the box only has POST /system)", getSystem.status === 404, `got ${getSystem.status}`);
const importJson = await req(API, "/import", jsonBody({ target: "mqtt", payload: "{}" }));
check(
  "POST /import with JSON body -> 200 HTML 'Unknown import target.'",
  importJson.status === 200 && importJson.text.includes("Unknown import target."),
  importJson.text.slice(0, 120)
);
checkCompactPost("POST /import JSON validation", importJson, "Unknown import target.");
const wifiAfterJson = await req(API, "/export/wifi");
check("JSON probes mutated nothing (wpa_supplicant.conf still seeded)", wifiAfterJson.text.includes("HUB-EMU-FAKE-SSID"));

console.log("\n== setup pages: form posts mutate settings and answer compact result HTML ==");
const mqttForm = await req(API, "/mqtt", form({
  host: "mqtt-qa.hub-emu.invalid",
  port: "1884",
  username: "hub-emu-qa-user",
  password: "hub-emu-qa-password",
  baseTopic: "harmony/hub-emu-qa",
  discoveryPrefix: "homeassistant",
  clientId: "hub-emu-qa-client",
  name: "QA Emu Hub",
  pollSeconds: "15",
  keepAlive: "45",
}));
check(
  "POST /mqtt form -> 200 HTML 'MQTT settings saved'",
  mqttForm.status === 200 && mqttForm.text.includes("MQTT settings saved"),
  mqttForm.text.slice(0, 160)
);
checkCompactPost("POST /mqtt form", mqttForm, "MQTT settings saved. The bridge will reconnect when it notices the config change.");
const expMqtt2 = await req(API, "/export/mqtt");
check(
  "MQTT save persisted to /data/codexmqtt/config.json (bridge stays disabled)",
  expMqtt2.json?.broker?.host === "mqtt-qa.hub-emu.invalid" &&
    expMqtt2.json?.baseTopic === "harmony/hub-emu-qa" &&
    expMqtt2.json?.enabled === false
);
const wifiForm = await req(API, "/wifi", form({ ssid: "HUB-EMU-QA-SSID", password: "hub-emu-qa-passphrase", apply: "save" }));
check(
  "POST /wifi form apply=save -> 200 HTML 'saved, reboot when ready'",
  wifiForm.status === 200 && wifiForm.text.includes("Wi-Fi settings saved. Reboot when ready"),
  wifiForm.text.slice(0, 160)
);
checkCompactPost("POST /wifi form", wifiForm, "Wi-Fi settings saved. Reboot when ready to use them.");
const expWifi2 = await req(API, "/export/wifi");
check(
  "Wi-Fi save persisted to /etc/wpa_supplicant.conf",
  expWifi2.text.includes("HUB-EMU-QA-SSID") && expWifi2.text.includes("key_mgmt=WPA-PSK")
);
const cloudForm = await req(API, "/system", form({ action: "cloud", cloudBlocker: "on" }));
check(
  "POST /system action=cloud (blocker on) -> 200 HTML 'Cloud blocker enabled'",
  cloudForm.status === 200 && cloudForm.text.includes("Cloud blocker enabled"),
  cloudForm.text.slice(0, 160)
);
checkCompactPost("POST /system action=cloud", cloudForm, "Cloud blocker enabled and LAN-only egress applied.");
const expCloud2 = await req(API, "/export/cloud");
check("no cloud disable values are ever posted (blocker still 1)", expCloud2.text.trim() === "1");
const seedMqtt = JSON.stringify({
  baseTopic: "harmony/hub-emu-fake",
  broker: { host: "mqtt.hub-emu.invalid", password: "hub-emu-fake-password", port: 1883, username: "hub-emu-fake-user" },
  clientId: "hub-emu-fake-client",
  discoveryPrefix: "homeassistant",
  enabled: false,
  haDiscovery: true,
  keepAlive: 60,
  name: "Harmony Hub (Emu)",
  pollSeconds: 10,
});
const importForm = await req(API, "/import", form({ target: "mqtt", payload: seedMqtt }));
check(
  "POST /import target=mqtt form -> 200 HTML 'MQTT settings imported'",
  importForm.status === 200 && importForm.text.includes("MQTT settings imported"),
  importForm.text.slice(0, 160)
);
checkCompactPost("POST /import target=mqtt", importForm, "MQTT settings imported. The bridge will reconnect when it notices the config change.");
const expMqtt3 = await req(API, "/export/mqtt");
check("import restored the seeded fake MQTT config", expMqtt3.json?.broker?.host === "mqtt.hub-emu.invalid");
const btQaName = "QA <Emu> & Keyboard";
const btDeviceForm = await req(API, "/bt/device", form({ name: btQaName, type: "btkeyboard", bdaddr: "02:00:00:00:00:01" }));
check(
  "POST /bt/device form -> 200 HTML with the escaped exact dynamic message",
  btDeviceForm.status === 200 && btDeviceForm.text.includes("Saved Bluetooth device QA &lt;Emu&gt; &amp; Keyboard."),
  btDeviceForm.text.slice(0, 320)
);
checkCompactPost("POST /bt/device form", btDeviceForm, "Saved Bluetooth device QA &lt;Emu&gt; &amp; Keyboard.");
const expBt2 = await req(API, "/export/bluetooth");
check(
  "Bluetooth save persisted to /data/codex/bt-devices.json",
  expBt2.text.includes(btQaName) && expBt2.text.includes("02:00:00:00:00:01")
);
const irLegacy = await req(API, "/ir/send", form({ deviceId: String(irDevice.Device["Id-"]), command: irCommand }));
check(
  "POST /ir/send form (legacy path) -> 200 HTML 'Sent ... to ...'",
  irLegacy.status === 200 && irLegacy.text.includes("Sent ") && irLegacy.text.includes(" to "),
  irLegacy.text.slice(0, 160)
);
checkCompactPost("POST /ir/send form", irLegacy, "Sent ");

console.log("\n== reboot: observable, harmless, never auto-fired ==");
const statusBefore = await req(CTRL, "/status");
check(
  "no reboot was auto-fired by boot, seeding, or the JSON probes (rebootCount 0)",
  statusBefore.json?.rebootCount === 0,
  JSON.stringify(statusBefore.json)
);
const rebootForm = await req(API, "/system", form({ action: "reboot" }));
check(
  "POST /system action=reboot -> 200 HTML 'Rebooting now.'",
  rebootForm.status === 200 && rebootForm.text.includes("Rebooting now."),
  rebootForm.text.slice(0, 160)
);
checkCompactPost("POST /system action=reboot", rebootForm, "Rebooting now.");
const aliveAfterReboot = await req(API, "/api/activity-state");
check(
  "container survived the reboot request (stub never signals PID 1)",
  aliveAfterReboot.status === 200 && aliveAfterReboot.json?.ok === true
);
const statusAfter = await req(CTRL, "/status");
check("reboot request was recorded (rebootCount 1)", statusAfter.json?.rebootCount === 1, JSON.stringify(statusAfter.json));
const cloudRebootForm = await req(API, "/system", form({ action: "cloud_reboot", cloudBlocker: "on" }));
check(
  "POST /system action=cloud_reboot (blocker on) -> 200 HTML '... Rebooting now.'",
  cloudRebootForm.status === 200 && cloudRebootForm.text.includes("Cloud blocker enabled. Rebooting now."),
  cloudRebootForm.text.slice(0, 160)
);
checkCompactPost("POST /system action=cloud_reboot", cloudRebootForm, "Cloud blocker enabled. Rebooting now.");
const expCloud3 = await req(API, "/export/cloud");
check("cloud_reboot kept the blocker at 1", expCloud3.text.trim() === "1");
const statusAfter2 = await req(CTRL, "/status");
check("second reboot request recorded (rebootCount 2)", statusAfter2.json?.rebootCount === 2, JSON.stringify(statusAfter2.json));

console.log("\n== auth + update state: set, observed, then cleared by reset ==");
const updatePost = await req(API, "/api/update-check-state", form({
  available: "1",
  changes: "2",
  message: "QA fake update",
  source: "https://updates.hub-emu.invalid/",
}));
check(
  "POST /api/update-check-state form -> 200 ok",
  updatePost.status === 200 && updatePost.json?.ok === true && updatePost.json?.available === true,
  updatePost.text.slice(0, 160)
);
const updateGet = await req(API, "/api/update-check-state");
check(
  "update state persisted to /data/codex/update_state.conf",
  updateGet.json?.available === true && updateGet.json?.changes === 2 && updateGet.json?.message === "QA fake update",
  updateGet.text.slice(0, 160)
);
const authForm = await req(API, "/system", form({
  action: "auth",
  authEnabled: "on",
  authUsername: "hub-emu-fake-admin",
  authPassword: "hub-emu-fake-secret",
}));
check(
  "POST /system action=auth -> 200 HTML 'Web UI sign-in enabled'",
  authForm.status === 200 && authForm.text.includes("Web UI sign-in enabled"),
  authForm.text.slice(0, 160)
);
checkCompactPost("POST /system action=auth enable", authForm, "Web UI sign-in enabled.");
const locked = await req(API, "/api/activity-state");
check("auth now gates the whole API (401 without credentials)", locked.status === 401, `got ${locked.status}`);
const authed = await req(API, "/api/activity-state", {
  headers: { Authorization: `Basic ${Buffer.from("hub-emu-fake-admin:hub-emu-fake-secret").toString("base64")}` },
});
check("the fake credentials authenticate", authed.status === 200 && authed.json?.ok === true, `got ${authed.status}`);
const fakeAuthorization = `Basic ${Buffer.from("hub-emu-fake-admin:hub-emu-fake-secret").toString("base64")}`;
const lockedSystemStatus = await req(API, "/api/system-status");
check("auth gates GET /api/system-status (401 without credentials)", lockedSystemStatus.status === 401, `got ${lockedSystemStatus.status}`);
const authedSystemStatus = await req(API, "/api/system-status", {
  headers: { Authorization: fakeAuthorization },
});
check(
  "authenticated System status remains complete and reports sign-in required",
  authedSystemStatus.status === 200 &&
    authedSystemStatus.json?.ok === true &&
    authedSystemStatus.json?.authMode === "sign-in required",
  authedSystemStatus.text.slice(0, 200),
);
const disableAuthForm = await req(API, "/system", authorizedForm({
  action: "auth",
  authUsername: "hub-emu-fake-admin",
}, fakeAuthorization));
check(
  "POST /system action=auth disables sign-in with the existing credentials",
  disableAuthForm.status === 200 && disableAuthForm.text.includes("Web UI sign-in disabled."),
  disableAuthForm.text.slice(0, 200),
);
checkCompactPost("POST /system action=auth disable", disableAuthForm, "Web UI sign-in disabled.");
const statusAfterAuthDisable = await req(API, "/api/system-status");
check(
  "disabled auth reopens System status and reports local-network mode",
  statusAfterAuthDisable.status === 200 && statusAfterAuthDisable.json?.authMode === "open on local network",
  statusAfterAuthDisable.text.slice(0, 200),
);
const reset2 = await req(CTRL, "/reset", { method: "POST" });
check("POST /reset -> 200", reset2.status === 200 && reset2.json?.ok === true);
const unlocked = await req(API, "/api/activity-state");
check(
  "reset removed webui_auth.conf (API open again, container not locked)",
  unlocked.status === 200 && unlocked.json?.ok === true,
  `got ${unlocked.status}`
);
const updateCleared = await req(API, "/api/update-check-state");
check(
  "reset removed update_state.conf (back to not-checked)",
  updateCleared.json?.available === false && Number(updateCleared.json?.checkedAt) === 0,
  updateCleared.text.slice(0, 160)
);

console.log("\n== reset restores the seeded fake settings ==");
const expMqtt4 = await req(API, "/export/mqtt");
check(
  "MQTT config restored to the seed",
  expMqtt4.json?.broker?.host === "mqtt.hub-emu.invalid" && expMqtt4.json?.enabled === false
);
const expWifi4 = await req(API, "/export/wifi");
check(
  "wpa_supplicant.conf restored to the seed",
  expWifi4.text.includes("HUB-EMU-FAKE-SSID") && !expWifi4.text.includes("HUB-EMU-QA-SSID")
);
const expBt4 = await req(API, "/export/bluetooth");
check(
  "bt-devices.json restored to the empty seed",
  Array.isArray(expBt4.json?.devices) && expBt4.json.devices.length === 0
);
const expCloud4 = await req(API, "/export/cloud");
check("cloud blocker still 1 after reset", expCloud4.text.trim() === "1");
const statusReset2 = await req(CTRL, "/status");
check("reboot log cleared by reset (rebootCount 0)", statusReset2.json?.rebootCount === 0, JSON.stringify(statusReset2.json));

console.log("\n== software update apply: rollback creation through real MIPS ==");
const updatePayload = await readFile(new URL("./stubs/codex_hbus", import.meta.url));
const updateMd5 = createHash("md5").update(updatePayload).digest("hex");
const updateManifest = [
  `${updateMd5}  codex_hbus`,
  "00000000000000000000000000000000  codex_webui",
  "",
].join("\n");
const updateBegin = await req(
  API, "/api/update-begin", form({ manifest: updateManifest }));
const updateChunk = await req(
  API,
  "/api/update-chunk",
  form({ file: "codex_hbus", offset: "0", hex: updatePayload.toString("hex") }),
);
const updateApply = await req(
  API, "/api/update-apply", form({ restart: "0" }));
const updateInventory = await req(CTRL, "/retention/inspect");
const updateGenerations =
  updateInventory.json?.families?.updates?.generations ?? [];
check(
  "real MIPS update staging accepts a manifest and byte-exact allowed payload",
  updateBegin.status === 200 && updateBegin.json?.ok === true &&
    updateChunk.status === 200 && updateChunk.json?.ok === true &&
    updateChunk.json?.bytes === updatePayload.length,
  `${updateBegin.text} ${updateChunk.text}`,
);
check(
  "real MIPS update apply creates a valid rollback and replaces the file without restart",
  updateApply.status === 200 && updateApply.json?.ok === true &&
    updateApply.json?.updated === "codex_hbus" &&
    updateApply.json?.restart === false &&
    updateGenerations.length === 1 &&
    updateGenerations[0]?.regularFiles === 1 &&
    updateGenerations[0]?.bytes === updatePayload.length &&
    updateApply.json?.backupDir?.endsWith(`/${updateGenerations[0]?.name}`),
  `${updateApply.text} ${JSON.stringify(updateInventory.json)}`,
);
const aliveAfterUpdate = await req(API, "/api/activity-state");
check(
  "identical update leaves normal real MIPS application behavior available",
  aliveAfterUpdate.status === 200 && aliveAfterUpdate.json?.ok === true,
  aliveAfterUpdate.text.slice(0, 160),
);
await req(CTRL, "/reset", { method: "POST" });

console.log("\n== unified backup retention: real MIPS maintenance mode ==");
const parseRetentionSummary = (text) => Object.fromEntries(
  [...text.matchAll(/([a-z_]+)=(\d+)/g)].map((match) => [match[1], Number(match[2])]),
);
const familyOf = (inventory, name) => inventory?.families?.[name] ?? { bytes: 0, count: 0, generations: [] };
const generationNames = (inventory, name) => familyOf(inventory, name).generations.map((entry) => entry.name);
const generationByName = (inventory, family, name) =>
  familyOf(inventory, family).generations.find((entry) => entry.name === name);
const untouchedSignature = (inventory) => JSON.stringify(
  (inventory?.untouched ?? []).map(({ root, name, type, bytes, sha256 }) =>
    ({ root, name, type, bytes, sha256 })),
);

const retentionSeed = await req(CTRL, "/retention/seed?scenario=standard", { method: "POST" });
const retentionBefore = retentionSeed.json;
check(
  "retention fixture seeds beyond legacy resource/settings/update entry limits",
  familyOf(retentionBefore, "resources").count > 64 &&
    familyOf(retentionBefore, "settings").count > 64 &&
    familyOf(retentionBefore, "updates").count > 32,
  JSON.stringify(Object.fromEntries(
    ["resources", "settings", "handoff", "updates"].map((name) =>
      [name, familyOf(retentionBefore, name).count]))),
);
check(
  "fixture puts every recognized family above its apparent-byte ceiling",
  ["resources", "settings", "handoff", "updates"].every((name) =>
    familyOf(retentionBefore, name).bytes > familyOf(retentionBefore, name).ceiling),
  JSON.stringify(Object.fromEntries(
    ["resources", "settings", "handoff", "updates"].map((name) =>
      [name, familyOf(retentionBefore, name).bytes]))),
);
check(
  "fixture aggregate recognized bytes exceed 2 MiB",
  retentionBefore?.recognizedBytes > retentionBefore?.combinedCeiling,
  `before=${retentionBefore?.recognizedBytes} ceiling=${retentionBefore?.combinedCeiling}`,
);
const nestedBefore = generationByName(retentionBefore, "resources", "20260727_174852");
check(
  "out-of-band inventory observes nested regular-file apparent bytes",
  nestedBefore?.bytes === 24 * 1024 && nestedBefore?.regularFiles === 1,
  JSON.stringify(nestedBefore),
);
const unknownBefore = untouchedSignature(retentionBefore);
const externalBefore = retentionBefore?.externalTarget;

const retentionRun = await req(CTRL, "/retention/prune", { method: "POST" });
const retentionAfter = retentionRun.json?.inventory;
const retentionSummary = parseRetentionSummary(retentionRun.json?.stdout ?? "");
check(
  "real MIPS --prune-backups completes successfully without starting a listener",
  retentionRun.status === 200 &&
    retentionRun.json?.exitCode === 0 &&
    retentionRun.json?.webuiProcessesBefore === 1 &&
    retentionRun.json?.webuiProcessesAfter === 1 &&
    retentionRun.json?.elapsedMs < 20000,
  retentionRun.text.slice(0, 500),
);
check(
  "maintenance emits the complete stable summary with no hidden over-budget state",
  ["bytes_before", "bytes_after", "generations_deleted", "protected_generations", "over_budget", "errors"]
    .every((key) => Number.isInteger(retentionSummary[key])) &&
    retentionSummary.over_budget === 0 &&
    retentionSummary.errors === 0 &&
    retentionSummary.generations_deleted > 0 &&
    retentionSummary.bytes_before === retentionBefore.recognizedBytes &&
    retentionSummary.bytes_after === retentionAfter.recognizedBytes,
  retentionRun.json?.stdout,
);
const resourceAfterNames = generationNames(retentionAfter, "resources");
const resourceBeforeValidNames = generationNames(retentionBefore, "resources")
  .filter((name) => name !== "99991231_235959");
const deletedResourceNames = resourceBeforeValidNames.filter((name) => !resourceAfterNames.includes(name));
const retainedResourceNames = resourceBeforeValidNames.filter((name) => resourceAfterNames.includes(name));
check(
  "newest valid resource survives while empty newest-looking generation is removed",
  resourceAfterNames.includes("20260804_220000") &&
    !resourceAfterNames.includes("99991231_235959"),
  resourceAfterNames.join(","),
);
check(
  "resource deletion is oldest-first, including 1970 before modern generations",
  !resourceAfterNames.includes("19700101_000000") &&
    !resourceAfterNames.includes("20260727_174852") &&
    deletedResourceNames.length > 0 &&
    retainedResourceNames.length > 0 &&
    deletedResourceNames.every((deleted) =>
      retainedResourceNames.every((retained) => deleted < retained)),
  `deleted=${deletedResourceNames.join(",")} retained=${retainedResourceNames.join(",")}`,
);
check(
  "settings generations are bounded and newest valid settings survives",
  familyOf(retentionAfter, "settings").bytes <= familyOf(retentionAfter, "settings").ceiling &&
    generationNames(retentionAfter, "settings").includes("settings_20260804_220000"),
  JSON.stringify(familyOf(retentionAfter, "settings")),
);
check(
  "handoff generations are bounded and newest valid handoff survives",
  familyOf(retentionAfter, "handoff").bytes <= familyOf(retentionAfter, "handoff").ceiling &&
    generationNames(retentionAfter, "handoff").includes("webui-handoff-20260720-070000"),
  JSON.stringify(familyOf(retentionAfter, "handoff")),
);
const newestUpdate = String(Math.floor(Date.UTC(2026, 7, 4, 22) / 1000));
check(
  "numeric update generations retain newest-first behavior beyond 32 entries",
  familyOf(retentionAfter, "updates").bytes <= familyOf(retentionAfter, "updates").ceiling &&
    generationNames(retentionAfter, "updates").includes(newestUpdate),
  JSON.stringify(familyOf(retentionAfter, "updates")),
);
check(
  "family ceilings and 2 MiB combined ceiling hold after family-first pruning",
  ["resources", "settings", "handoff", "updates"].every((name) =>
    familyOf(retentionAfter, name).bytes <= familyOf(retentionAfter, name).ceiling) &&
    retentionAfter.recognizedBytes <= retentionAfter.combinedCeiling,
  `after=${retentionAfter.recognizedBytes} families=${JSON.stringify(
    Object.fromEntries(["resources", "settings", "handoff", "updates"]
      .map((name) => [name, familyOf(retentionAfter, name).bytes])))}`,
);
check(
  "unknown manual files/directories and recognized-name non-directory are byte-identical",
  JSON.parse(unknownBefore).length === 3 &&
    untouchedSignature(retentionAfter) === unknownBefore,
  `before=${unknownBefore} after=${untouchedSignature(retentionAfter)}`,
);
check(
  "symlink generation is removed without touching its external target",
  externalBefore?.type === "file" &&
    typeof externalBefore.sha256 === "string" &&
    !resourceAfterNames.includes("19700101_000000") &&
    retentionAfter?.externalTarget?.sha256 === externalBefore.sha256 &&
    retentionAfter?.externalTarget?.bytes === externalBefore.bytes,
  JSON.stringify(retentionAfter?.externalTarget),
);
const retentionRerun = await req(CTRL, "/retention/prune", { method: "POST" });
const rerunSummary = parseRetentionSummary(retentionRerun.json?.stdout ?? "");
check(
  "second real MIPS enforcement is idempotent",
  retentionRerun.json?.exitCode === 0 &&
    rerunSummary.generations_deleted === 0 &&
    rerunSummary.bytes_before === rerunSummary.bytes_after &&
    rerunSummary.bytes_after === retentionAfter.recognizedBytes,
  retentionRerun.json?.stdout,
);
const aliveAfterMaintenance = await req(API, "/api/activity-state");
check(
  "normal real MIPS server still serves existing routes after maintenance",
  aliveAfterMaintenance.status === 200 && aliveAfterMaintenance.json?.ok === true,
  aliveAfterMaintenance.text.slice(0, 160),
);

console.log("\n== backup creation retention and copy-failure safety ==");
await req(CTRL, "/retention/seed?scenario=creation", { method: "POST" });
const creationBefore = await req(CTRL, "/retention/inspect");
const creationConfig = await req(API, "/api/activity-config");
const creationActivities = structuredClone(creationConfig.json.activityList);
creationActivities.Activities[0].Name = "QA Retention Creation";
const creationSave = await req(
  API,
  "/api/activity-save",
  jsonBody({
    baseRevision: creationConfig.json.revision,
    syncRemote: false,
    activityList: creationActivities,
    mapList: creationConfig.json.mapList,
    functionList: creationConfig.json.functionList,
  }),
);
const creationAfter = await req(CTRL, "/retention/inspect");
const creationBeforeNames = generationNames(creationBefore.json, "resources");
const creationAfterNames = generationNames(creationAfter.json, "resources");
const justCreatedNames = creationAfterNames.filter((name) => !creationBeforeNames.includes(name));
const justCreated = generationByName(
  creationAfter.json, "resources", justCreatedNames[0]);
check(
  "real backup creation reserves bytes, removes the oldest eligible generation, and saves",
  creationSave.status === 200 &&
    creationSave.json?.saved === true &&
    !creationAfterNames.includes("19700101_000000"),
  `${creationSave.text.slice(0, 200)} names=${creationAfterNames.join(",")}`,
);
check(
  "just-created valid resource generation survives alongside prior known-good rollback",
  justCreatedNames.length === 1 &&
    /^\d{8}_\d{6}$/.test(justCreatedNames[0]) &&
    justCreated?.regularFiles > 0 &&
    creationAfterNames.includes("20260804_220000"),
  `before=${creationBeforeNames.join(",")} after=${creationAfterNames.join(",")}`,
);

await req(CTRL, "/reset", { method: "POST" });
await req(CTRL, "/retention/seed?scenario=copy-failure", { method: "POST" });
const failedBackupBefore = await req(CTRL, "/retention/inspect");
const priorRollbackBefore = generationByName(
  failedBackupBefore.json, "resources", "20260804_220000");
const failureConfig = await req(API, "/api/activity-config");
const failureOriginalName =
  failureConfig.json?.activityList?.Activities?.[0]?.Name;
const failureActivities = structuredClone(failureConfig.json.activityList);
failureActivities.Activities[0].Name = "QA MUST NOT PERSIST";
const armFailure = await req(CTRL, "/retention/arm-copy-failure", { method: "POST" });
const failedSave = await req(
  API,
  "/api/activity-save",
  jsonBody({
    baseRevision: failureConfig.json.revision,
    syncRemote: false,
    activityList: failureActivities,
    mapList: failureConfig.json.mapList,
    functionList: failureConfig.json.functionList,
  }),
);
const failedBackupAfter = await req(CTRL, "/retention/inspect");
const priorRollbackAfter = generationByName(
  failedBackupAfter.json, "resources", "20260804_220000");
const configAfterFailedBackup = await req(API, "/api/activity-config");
check(
  "emulator arms a regular-file source that fails during real MIPS backup copying",
  armFailure.status === 200 && armFailure.json?.ok === true &&
    armFailure.json?.source === "/proc/self/mem",
  armFailure.text,
);
check(
  "failed backup copy blocks the destructive resource mutation",
  failureConfig.status === 200 &&
    typeof failureOriginalName === "string" &&
    failedSave.status === 503 &&
    failedSave.json?.error?.includes("Required resource backup failed") &&
    configAfterFailedBackup.status === 200 &&
    configAfterFailedBackup.json?.activityList?.Activities?.[0]?.Name ===
      failureOriginalName,
  failedSave.text.slice(0, 240),
);
check(
  "failed backup copy removes its partial generation and preserves prior rollback byte-for-byte",
  familyOf(failedBackupAfter.json, "resources").count === 1 &&
    priorRollbackAfter?.sha256 === priorRollbackBefore?.sha256 &&
    priorRollbackAfter?.bytes === priorRollbackBefore?.bytes,
  `before=${JSON.stringify(priorRollbackBefore)} after=${JSON.stringify(priorRollbackAfter)}`,
);

console.log("\n== protected-minimum over-budget reporting ==");
await req(CTRL, "/reset", { method: "POST" });
const oversizedSeed = await req(CTRL, "/retention/seed?scenario=oversized", { method: "POST" });
const oversizedRun = await req(CTRL, "/retention/prune", { method: "POST" });
const oversizedSummary = parseRetentionSummary(oversizedRun.json?.stdout ?? "");
const oversizedAfter = oversizedRun.json?.inventory;
check(
  "protected newest generation alone can exceed its family ceiling in the fixture",
  familyOf(oversizedSeed.json, "settings").bytes > familyOf(oversizedSeed.json, "settings").ceiling &&
    generationByName(oversizedSeed.json, "settings", "settings_20260804_220000")?.bytes >
      familyOf(oversizedSeed.json, "settings").ceiling,
  JSON.stringify(familyOf(oversizedSeed.json, "settings")),
);
check(
  "maintenance returns nonzero and reports protected-minimum over-budget without errors",
  oversizedRun.json?.exitCode !== 0 &&
    oversizedSummary.over_budget === 1 &&
    oversizedSummary.errors === 0 &&
    oversizedSummary.generations_deleted === 1,
  oversizedRun.json?.stdout,
);
check(
  "oversized protected newest settings survives while every older eligible generation is deleted",
  generationNames(oversizedAfter, "settings").length === 1 &&
    generationNames(oversizedAfter, "settings")[0] === "settings_20260804_220000" &&
    familyOf(oversizedAfter, "settings").bytes > familyOf(oversizedAfter, "settings").ceiling,
  JSON.stringify(familyOf(oversizedAfter, "settings")),
);

const retentionReset = await req(CTRL, "/reset", { method: "POST" });
const retentionResetInventory = await req(CTRL, "/retention/inspect");
const routeAfterRetentionReset = await req(API, "/api/activity-state");
check(
  "emulator reset removes every synthetic retention artifact and restores normal service",
  retentionReset.status === 200 &&
    ["resources", "settings", "handoff", "updates"].every((name) =>
      familyOf(retentionResetInventory.json, name).count === 0) &&
    retentionResetInventory.json?.untouched?.length === 0 &&
    retentionResetInventory.json?.externalTarget === null &&
    routeAfterRetentionReset.status === 200 &&
    routeAfterRetentionReset.json?.ok === true,
  retentionResetInventory.text.slice(0, 400),
);

console.log("\n== Step 4A: capacity-gated installer CLI through real MIPS ==");
// Control-plane contract LOCKED with the fixture owner (QemuFixtureImpl):
//   GET  /step4a/inspect            {ok, capacity, destinations, stages, handoff}
//   GET  /step4a/capacity           capacity object
//   POST /step4a/seed               {"scenario":"upgrade"|"fresh"} -> inspect shape
//   POST /step4a/capacity           {"free":N} exact /mnt/data free bytes via filler
//   POST /step4a/stage              {"leaves":{leaf:{bytes|copy|link|fifo}}} -> {ok,stage,staged}
//   POST /step4a/fault              {"kind","target","detail"} fixture seams
//   POST /step4a/run                {"argv":[...]} -> {argv,exitCode,stdout,stderr,elapsedMs,
//                                   webuiProcessesBefore,webuiProcessesAfter,kv}
//   POST /step4a/rollback-copy      {"source","destination"} wrapper-style cp -p
//   POST /step4a/remove             {"path"} wrapper rm -f + absence check
//   POST /step4a/handoff            {"stamp","failAfter"?,"budget"?}
//   POST /step4a/manual-backups     owner artifacts that must survive
//   POST /step4a/md5                {"paths":[...]} /bin/busybox md5sum
// C CLI contract: --storage-status [floor]; --install-plan src dst mode floor;
// --install-file src dst mode floor [--rollback-restore]. Stable kv output;
// exits: 0 success/floor-met, 1 refusal/floor-not-met, 2 invalid arguments.
// --file-status destination: read-only destination probe via the staged C
// binary (the installer wrappers' only destination-discovery/verification
// primitive). Stable kv: operation=file-status, ok, destination, allowed,
// exists, type=absent|regular|symlink|other, bytes, allocated_bytes, md5 (32
// lowercase hex or none), mode_decimal, errors, and a stable reason on
// refusal. Allowed absence is success with zeroed numerics and md5=none;
// invalid/unknown/symlink/other fail nonzero. Exits: 0 status, 1 refusal,
// 2 invalid arguments.
// Every payload, stamp, and credential in this block is an obvious fake.
// The fixture exposes deterministic seams for every required failure path.
const INSTALL_FLOOR = 1048576;
const DEST_WEBUI = "/data/codex/bin/codex_webui";
const DEST_HBUS = "/data/codex/bin/codex_hbus";
const DEST_RCS = "/etc/init.d/rcS.local";
const DEST_INIT = "/data/codex/init.sh";
const DEST_EGRESS = "/data/codex/offline_egress_guard.sh";
const DEST_RECOVERY = "/data/codex/recovery_ap.sh";
const CONFIG_PRESERVED_PATHS = [
  "/data/codexmqtt/config.json",
  "/data/codex/cloud_blocker.conf",
  "/data/codex/hub_id",
  "/etc/wpa_supplicant.conf",
  "/data/codex/bt-devices.json",
];

const parseInstallKv = (text) => Object.fromEntries(
  String(text ?? "").split("\n")
    .map((line) => line.trim())
    .filter((line) => line.includes("="))
    .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
);
const ceilAlloc = (bytes, fragment) =>
  bytes === 0 ? 0 : Math.ceil(bytes / fragment) * fragment;
const alignDown = (value, fragment) => Math.floor(value / fragment) * fragment;
const sha256Hex = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fakeCandidateBytes = (leaf, size) => {
  // Mirrors the fixture's deterministic fake candidate content exactly.
  const label = Buffer.from(`HUB-EMU-FAKE-CANDIDATE-${leaf}\n`, "ascii");
  const repeated = Buffer.concat(
    Array.from({ length: Math.floor(size / label.length) + 1 }, () => label));
  return repeated.subarray(0, size);
};
const cliRuns = [];
async function runCli(argv, fault = undefined) {
  // fault: optional harness-only fault object ({errnoOn/errno, partialBytes,
  // truncateRace, tempCollision}) applied by the fixture around the qemu
  // child; the production MIPS binary is never modified.
  const response = await req(CTRL, "/step4a/run", jsonBody({ argv, fault }));
  if (response.status !== 200 || !response.json) {
    check(`control plane runs the real MIPS CLI (${argv.join(" ")})`, false, response.text.slice(0, 200));
    return null;
  }
  cliRuns.push(response.json);
  return response.json;
}
const destSnap = (inspect, path) =>
  inspect?.destinations?.[path] ?? { type: "missing-from-inspect" };

const s4aProbe = await req(CTRL, "/step4a/inspect");
if (s4aProbe.status !== 200 || s4aProbe.json?.ok !== true) {
  check("Step 4A fixture is available", false, s4aProbe.text.slice(0, 200));
} else {
  console.log("\n-- Step 4A: seed, storage authority, stable status output --");
  const settingsMd5Before = await req(CTRL, "/step4a/md5", jsonBody({ paths: CONFIG_PRESERVED_PATHS }));
  const seedUpgrade = await req(CTRL, "/step4a/seed", jsonBody({ scenario: "upgrade" }));
  check(
    "upgrade seed reports the full Step 4A fixture state on /mnt/data",
    seedUpgrade.json?.ok === true &&
      seedUpgrade.json?.capacity?.storagePath === "/mnt/data" &&
      seedUpgrade.json?.capacity?.dataIsSymlink === false &&
      seedUpgrade.json?.capacity?.mntDataMounted === true &&
      typeof seedUpgrade.json?.destinations === "object",
    seedUpgrade.text.slice(0, 240),
  );
  const upgradeDests = seedUpgrade.json?.destinations ?? {};
  check(
    "every installer destination is a regular file with a hash and mode",
    Object.keys(upgradeDests).length >= 20 &&
      Object.values(upgradeDests).every((snap) =>
        snap.type === "regular" && typeof snap.sha256 === "string" && Number.isInteger(snap.mode)),
    JSON.stringify(Object.entries(upgradeDests).filter(([, snap]) => snap.type !== "regular")),
  );
  const settingsMd5AfterSeed = await req(CTRL, "/step4a/md5", jsonBody({ paths: CONFIG_PRESERVED_PATHS }));
  check(
    "configuration files survive destination seeding byte-for-byte",
    settingsMd5Before.json?.exitCode === 0 &&
      settingsMd5AfterSeed.json?.exitCode === 0 &&
      settingsMd5Before.json?.stdout === settingsMd5AfterSeed.json?.stdout,
    `before=${settingsMd5Before.json?.stdout} after=${settingsMd5AfterSeed.json?.stdout}`,
  );

  const naturalFree = seedUpgrade.json?.capacity?.bytesAvailable ?? 0;
  let fragmentBytes = seedUpgrade.json?.capacity?.fragmentBytes ?? 0;
  const capacityTarget = alignDown(naturalFree - 4 * 1024 * 1024, fragmentBytes || 4096);
  const step4aCapacityOk = fragmentBytes > 0 && capacityTarget >= 8 * 1024 * 1024;
  if (!step4aCapacityOk) {
    check("Step 4A capacity fixture has exact-boundary headroom", false,
      `fixture reports ${naturalFree} free bytes (fragment ${fragmentBytes})`);
  } else {
    const capacityPin = await req(CTRL, "/step4a/capacity", jsonBody({ free: capacityTarget }));
    fragmentBytes = capacityPin.json?.fragmentBytes ?? fragmentBytes;
    check(
      "fixture drives /mnt/data free space to the exact fragment-aligned QA target",
      capacityPin.json?.storagePath === "/mnt/data" &&
        capacityPin.json?.bytesAvailable === capacityTarget &&
        capacityPin.json?.blocksAvailable * fragmentBytes === capacityTarget,
      JSON.stringify(capacityPin.json),
    );

    const statusDefault = await runCli(["--storage-status"]);
    if (statusDefault) {
      const skv = parseInstallKv(statusDefault.stdout);
      check(
        "storage-status emits the complete stable kv set on the authoritative path",
        statusDefault.exitCode === 0 &&
          JSON.stringify(Object.keys(skv).sort()) === JSON.stringify([
            "available_bytes", "blocks_available", "bytes_available", "errors",
            "floor_bytes", "floor_met", "fragment_bytes", "mode", "ok",
            "storage_path", "sufficient",
          ]) &&
          skv.mode === "storage-status" && skv.ok === "1" &&
          skv.storage_path === "/mnt/data" && skv.errors === "0" &&
          skv.fragment_bytes === String(fragmentBytes) &&
          skv.available_bytes === String(capacityTarget) &&
          skv.bytes_available === String(capacityTarget) &&
          Number(skv.blocks_available) * fragmentBytes === capacityTarget,
        statusDefault.stdout,
      );
      check(
        "the default floor is exactly 1048576 and is met with headroom",
        skv.floor_bytes === "1048576" && skv.floor_met === "1" && skv.sufficient === "1",
        statusDefault.stdout,
      );
      const stExact = await runCli(["--storage-status", String(capacityTarget)]);
      const stHigh = await runCli(["--storage-status", String(Number(skv.available_bytes) + 1)]);
      const stLow = await runCli(["--storage-status", String(Number(skv.available_bytes) - 1)]);
      check(
        "floor at exactly the available bytes is met (exit 0)",
        stExact?.exitCode === 0 && parseInstallKv(stExact?.stdout).floor_met === "1",
        stExact?.stdout,
      );
      check(
        "floor one byte above the available bytes is not met (exit 1, floor_met=0)",
        stHigh?.exitCode === 1 && parseInstallKv(stHigh?.stdout).ok === "1" &&
          parseInstallKv(stHigh?.stdout).floor_met === "0" &&
          parseInstallKv(stHigh?.stdout).sufficient === "0",
        stHigh?.stdout,
      );
      check(
        "floor one byte below the available bytes is still met (exit 0)",
        stLow?.exitCode === 0 && parseInstallKv(stLow?.stdout).floor_met === "1",
        stLow?.stdout,
      );
      for (const badFloor of ["abc", "-1", "1048575", "18446744073709551616"]) {
        const bad = await runCli(["--storage-status", badFloor]);
        const bkv = parseInstallKv(bad?.stdout);
        check(
          `malformed or overflowing floor ${badFloor} is refused before any probe (exit 2)`,
          bad?.exitCode === 2 && bkv.ok === "0" && bkv.reason === "floor_invalid" && bkv.errors === "0",
          bad?.stdout ?? "no run",
        );
      }
    }

    console.log("\n-- Step 4A: plans are read-only; absent destinations stay absent --");
    await req(CTRL, "/step4a/seed", jsonBody({ scenario: "fresh" }));
    const freshInspect = await req(CTRL, "/step4a/inspect");
    check(
      "fresh seed leaves every installer destination absent",
      Object.keys(freshInspect.json?.destinations ?? {}).length >= 20 &&
        Object.values(freshInspect.json?.destinations ?? {}).every((snap) => snap.type === "absent"),
      JSON.stringify(Object.entries(freshInspect.json?.destinations ?? {}).filter(([, snap]) => snap.type !== "absent")),
    );
    const stagePlan = await req(CTRL, "/step4a/stage", jsonBody({ leaves: { "qa-plan-webui": { bytes: 4096 } } }));
    const planBefore = await req(CTRL, "/step4a/inspect");
    const planSrc = stagePlan.json?.staged?.["qa-plan-webui"];
    if (stagePlan.json?.ok === true && planSrc) {
      const planFresh = await runCli(["--install-plan", planSrc, DEST_WEBUI, "755", String(INSTALL_FLOOR)]);
      const pkv = parseInstallKv(planFresh?.stdout);
      const expectedCandidateReservation = ceilAlloc(4096, fragmentBytes) + fragmentBytes;
      check(
        "plan for an absent destination allows the create with zero rollback reservation",
        planFresh?.exitCode === 0 && pkv.ok === "1" && pkv.allowed === "1" &&
          pkv.destination_existed === "0" && pkv.rollback_reservation_bytes === "0" &&
          pkv.source_bytes === "4096" &&
          pkv.candidate_bytes === String(ceilAlloc(4096, fragmentBytes)) &&
          pkv.candidate_reservation_bytes === String(expectedCandidateReservation) &&
          pkv.required_bytes === String(INSTALL_FLOOR + expectedCandidateReservation) &&
          pkv.sufficient === "1" && pkv.floor_met === "1" && pkv.errors === "0",
        planFresh?.stdout,
      );
      const planAfter = await req(CTRL, "/step4a/inspect");
      check(
        "plan measured only: destination and capacity stay unchanged after staging",
        destSnap(planAfter.json, DEST_WEBUI).type === "absent" &&
          planAfter.json?.capacity?.bytesAvailable === planBefore.json?.capacity?.bytesAvailable &&
          JSON.stringify(planAfter.json?.destinations) === JSON.stringify(planBefore.json?.destinations),
        JSON.stringify({ dest: destSnap(planAfter.json, DEST_WEBUI), free: planAfter.json?.capacity?.bytesAvailable }),
      );
    } else {
      check(
        "fixture unavailable: read-only plan staging for qa-plan-webui (absent-destination battery skipped)",
        false,
        stagePlan.text.slice(0, 200),
      );
    }

    console.log("\n-- Step 4A: symlink, traversal, and malformed-argument refusals --");
    await req(CTRL, "/step4a/seed", jsonBody({ scenario: "upgrade" }));
    const stageBattery = await req(CTRL, "/step4a/stage", jsonBody({
      leaves: { "qa-good": { bytes: 512 }, "qa-link": { bytes: 64 }, "qa-fifo": { bytes: 64 } },
    }));
    const goodSrc = stageBattery.json?.staged?.["qa-good"];
    const stageDir = stageBattery.json?.stage ?? "";
    const stageLeafName = String(goodSrc ?? "").split("/").pop();
    if (stageBattery.json?.ok === true && goodSrc) {
      await req(CTRL, "/step4a/fault", jsonBody({ kind: "source-symlink", target: stageBattery.json.staged["qa-link"], detail: "/etc/passwd" }));
      await req(CTRL, "/step4a/fault", jsonBody({ kind: "source-fifo", target: stageBattery.json.staged["qa-fifo"] }));
      await req(CTRL, "/step4a/fault", jsonBody({ kind: "stage-alias", target: "/var/volatile/codex-install-qa-alias", detail: stageDir }));
      await req(CTRL, "/step4a/fault", jsonBody({ kind: "destination-symlink", target: DEST_INIT, detail: "/etc/passwd" }));
      await req(CTRL, "/step4a/fault", jsonBody({ kind: "destination-directory", target: DEST_RECOVERY }));
      await req(CTRL, "/step4a/fault", jsonBody({ kind: "destination-fifo", target: DEST_EGRESS }));
      const batteryBefore = await req(CTRL, "/step4a/inspect");
      const refusalCases = [
        ["relative source path", ["--install-plan", "var/volatile/codex-install-qa/file", DEST_WEBUI, "755", String(INSTALL_FLOOR)], 1, "source_path_invalid"],
        ["source outside the staging root", ["--install-plan", "/tmp/qa-source", DEST_WEBUI, "755", String(INSTALL_FLOOR)], 1, "source_path_invalid"],
        ["source with .. traversal", ["--install-plan", `${stageDir}/../${stageDir.split("/").pop()}/${stageLeafName}`, DEST_WEBUI, "755", String(INSTALL_FLOOR)], 1, "source_path_invalid"],
        ["source through a staging alias symlink", ["--install-plan", `/var/volatile/codex-install-qa-alias/${stageLeafName}`, DEST_WEBUI, "755", String(INSTALL_FLOOR)], 1, "source_open_failed"],
        ["source leaf that is a symlink", ["--install-plan", stageBattery.json.staged["qa-link"], DEST_WEBUI, "755", String(INSTALL_FLOOR)], 1, "source_open_failed"],
        ["source leaf that is a FIFO", ["--install-plan", stageBattery.json.staged["qa-fifo"], DEST_WEBUI, "755", String(INSTALL_FLOOR)], 1, "source_open_failed"],
        ["destination outside the allowlist", ["--install-plan", goodSrc, "/data/codex/evil", "755", String(INSTALL_FLOOR)], 1, "destination_not_allowed"],
        ["destination that is a symlink", ["--install-plan", goodSrc, DEST_INIT, "755", String(INSTALL_FLOOR)], 1, "destination_type_invalid"],
        ["destination that is a directory", ["--install-plan", goodSrc, DEST_RECOVERY, "755", String(INSTALL_FLOOR)], 1, "destination_type_invalid"],
        ["destination that is a FIFO", ["--install-plan", goodSrc, DEST_EGRESS, "755", String(INSTALL_FLOOR)], 1, "destination_type_invalid"],
        ["mode wider than octal 7777", ["--install-plan", goodSrc, DEST_WEBUI, "77777", String(INSTALL_FLOOR)], 2, "mode_invalid"],
        ["mode with non-octal digits", ["--install-plan", goodSrc, DEST_WEBUI, "999", String(INSTALL_FLOOR)], 2, "mode_invalid"],
        ["mode that mismatches the allowlist", ["--install-plan", goodSrc, DEST_WEBUI, "644", String(INSTALL_FLOOR)], 1, "mode_not_allowed"],
        ["non-numeric floor", ["--install-plan", goodSrc, DEST_WEBUI, "755", "abc"], 2, "floor_invalid"],
        ["floor overflowing u64", ["--install-plan", goodSrc, DEST_WEBUI, "755", "18446744073709551616"], 2, "floor_invalid"],
        ["unknown install-file flag", ["--install-file", goodSrc, DEST_WEBUI, "755", String(INSTALL_FLOOR), "--bogus"], 2, "usage_invalid"],
        ["missing install-plan arguments", ["--install-plan", goodSrc, DEST_WEBUI, "755"], 2, "usage_invalid"],
        ["missing install-file arguments", ["--install-file", goodSrc, DEST_WEBUI, "755"], 2, "usage_invalid"],
        ["extra storage-status argument", ["--storage-status", "1048576", "extra"], 2, "usage_invalid"],
        ["extra install-plan argument", ["--install-plan", goodSrc, DEST_WEBUI, "755", String(INSTALL_FLOOR), "extra"], 2, "usage_invalid"],
      ];
      for (const [name, argv, exitCode, reason] of refusalCases) {
        const refusal = await runCli(argv);
        const rkv = parseInstallKv(refusal?.stdout);
        check(
          `refuses ${name} with reason=${reason}`,
          refusal?.exitCode === exitCode && rkv.ok === "0" && rkv.reason === reason,
          refusal?.stdout ?? "no run",
        );
      }
      const batteryAfter = await req(CTRL, "/step4a/inspect");
      check(
        "the refusal battery wrote nothing: destinations, hashes, modes, and staging unchanged",
        JSON.stringify(batteryAfter.json?.destinations) === JSON.stringify(batteryBefore.json?.destinations) &&
          JSON.stringify(batteryAfter.json?.stages) === JSON.stringify(batteryBefore.json?.stages),
        JSON.stringify({ destinations: batteryAfter.json?.destinations, stages: batteryAfter.json?.stages }),
      );
      const DEST_MQTT = "/pkg/codexmqtt/codexmqtt.lua";
      const missingParentSeed = await req(CTRL, "/step4a/seed", jsonBody({ scenario: "missing-parent" }));
      const missingParentStage = await req(CTRL, "/step4a/stage", jsonBody({
        leaves: { "qa-missing-parent": { bytes: 1024 } },
      }));
      const missingParentSrc = missingParentStage.json?.staged?.["qa-missing-parent"];
      if (missingParentSeed.json?.ok === true && missingParentSrc) {
        const parentStatus = await runCli(["--file-status", DEST_MQTT]);
        const parentStatusKv = parseInstallKv(parentStatus?.stdout);
        const parentStatusInspect = await req(CTRL, "/step4a/inspect");
        check(
          "file-status treats an allowlisted destination below a missing parent as successful stable absence without creating parents",
          parentStatus?.exitCode === 0 && parentStatusKv.operation === "file-status" &&
            parentStatusKv.ok === "1" && parentStatusKv.destination === DEST_MQTT &&
            parentStatusKv.allowed === "1" && parentStatusKv.exists === "0" &&
            parentStatusKv.type === "absent" && parentStatusKv.bytes === "0" &&
            parentStatusKv.allocated_bytes === "0" && parentStatusKv.md5 === "none" &&
            parentStatusKv.mode_decimal === "0" && parentStatusKv.errors === "0" &&
            destSnap(parentStatusInspect.json, DEST_MQTT).type === "absent",
          parentStatus?.stdout,
        );
        const parentPlan = await runCli([
          "--install-plan", missingParentSrc, DEST_MQTT, "644", String(INSTALL_FLOOR),
        ]);
        const parentPlanKv = parseInstallKv(parentPlan?.stdout);
        const parentInspect = await req(CTRL, "/step4a/inspect");
        check(
          "missing-parent planner is read-only and does not create destination parents",
          parentPlan?.exitCode === 0 && parentPlanKv.ok === "1" &&
            destSnap(parentInspect.json, DEST_MQTT).type === "absent",
          parentPlan?.stdout,
        );
        const parentInstall = await runCli([
          "--install-file", missingParentSrc, DEST_MQTT, "644", String(INSTALL_FLOOR),
        ]);
        const parentInstallKv = parseInstallKv(parentInstall?.stdout);
        check(
          "missing-parent install refuses destination_open_failed without mutation",
          parentInstall?.exitCode !== 0 && parentInstallKv.reason === "destination_open_failed" &&
            destSnap((await req(CTRL, "/step4a/inspect")).json, DEST_MQTT).type === "absent",
          parentInstall?.stdout,
        );
        await req(CTRL, "/step4a/seed", jsonBody({ scenario: "upgrade" }));
      } else {
        check(
          "fixture unavailable: missing-parent seed/stage for qa-missing-parent (missing-parent battery skipped)",
          false,
          `seed=${missingParentSeed.text.slice(0, 160)} stage=${missingParentStage.text.slice(0, 160)}`,
        );
      }
    } else {
      check(
        "fixture unavailable: refusal-battery staging for qa-good/qa-link/qa-fifo (symlink/traversal/malformed-argument battery skipped)",
        false,
        stageBattery.text.slice(0, 200),
      );
    }

    console.log("\n-- Step 4A: capacity gates refuse with zero mutation --");
    if (stageBattery.json?.ok === true && goodSrc) {
      const planGate = await runCli(["--install-plan", goodSrc, DEST_WEBUI, "755", String(INSTALL_FLOOR)]);
      const gateKv = parseInstallKv(planGate?.stdout);
      const requiredGate = Number(gateKv.required_bytes);
      check(
        "plan reserves candidate + rollback fragments for an existing destination",
        planGate?.exitCode === 0 && gateKv.destination_existed === "1" &&
          Number(gateKv.rollback_reservation_bytes) > 0 &&
          Number(gateKv.candidate_reservation_bytes) === ceilAlloc(512, fragmentBytes) + fragmentBytes &&
          requiredGate === INSTALL_FLOOR + Number(gateKv.candidate_reservation_bytes) + Number(gateKv.rollback_reservation_bytes),
        planGate?.stdout,
      );
      const freeShort = alignDown(requiredGate - 1, fragmentBytes);
      const capShort = await req(CTRL, "/step4a/capacity", jsonBody({ free: freeShort }));
      check(
        "fixture pins free space below the plan requirement (fragment-aligned)",
        capShort.json?.bytesAvailable === freeShort && freeShort < requiredGate,
        JSON.stringify(capShort.json),
      );
      const planShort = await runCli(["--install-plan", goodSrc, DEST_WEBUI, "755", String(INSTALL_FLOOR)]);
      const planShortKv = parseInstallKv(planShort?.stdout);
      check(
        "plan short of rollback capacity exits nonzero: sufficient=0 while floor_met=1",
        planShort?.exitCode === 1 && planShortKv.ok === "1" &&
          planShortKv.sufficient === "0" && planShortKv.floor_met === "1" &&
          planShortKv.available_bytes === String(freeShort),
        planShort?.stdout,
      );
      const destBeforeShort = destSnap((await req(CTRL, "/step4a/inspect")).json, DEST_WEBUI);
      const installShort = await runCli(["--install-file", goodSrc, DEST_WEBUI, "755", String(INSTALL_FLOOR)]);
      const installShortKv = parseInstallKv(installShort?.stdout);
      const destAfterShort = destSnap((await req(CTRL, "/step4a/inspect")).json, DEST_WEBUI);
      check(
        "install-file short of capacity refuses insufficient_storage and preserves the destination",
        installShort?.exitCode === 1 && installShortKv.result === "refused" &&
          installShortKv.reason === "insufficient_storage" && installShortKv.rename_completed === "0" &&
          JSON.stringify(destAfterShort) === JSON.stringify(destBeforeShort),
        installShort?.stdout,
      );
      await req(CTRL, "/step4a/capacity", jsonBody({ free: capacityTarget }));
    } else {
      check("capacity gate refusal assertions", false,
        "staging seam did not provide the 512-byte candidate source");
    }

    console.log("\n-- Step 4A: --file-status read-only destination probe through real MIPS --");
    const FILE_STATUS_KEYS = [
      "operation", "ok", "destination", "allowed", "exists", "type",
      "bytes", "allocated_bytes", "md5", "mode_decimal", "errors",
    ];
    const runFileStatus = async (destination) => {
      const run = await runCli(["--file-status", destination]);
      return { run, kv: parseInstallKv(run?.stdout) };
    };
    const seededRegular = destSnap((await req(CTRL, "/step4a/inspect")).json, DEST_WEBUI);
    const { run: fsRegularRun, kv: fsRegular } = await runFileStatus(DEST_WEBUI);
    check(
      "file-status on an existing allowlisted regular file reports full metadata",
      fsRegularRun?.exitCode === 0 &&
        JSON.stringify(Object.keys(fsRegular).sort()) === JSON.stringify([...FILE_STATUS_KEYS].sort()) &&
        fsRegular.operation === "file-status" && fsRegular.ok === "1" &&
        fsRegular.destination === DEST_WEBUI && fsRegular.allowed === "1" &&
        fsRegular.exists === "1" && fsRegular.type === "regular" &&
        Number(fsRegular.bytes) === seededRegular.bytes &&
        Number(fsRegular.allocated_bytes) >= seededRegular.bytes &&
        /^[0-9a-f]{32}$/.test(fsRegular.md5 ?? "") &&
        Number(fsRegular.mode_decimal) === (seededRegular.mode & 0o7777) &&
        fsRegular.errors === "0",
      fsRegularRun?.stdout,
    );
    const removedTarget = DEST_INIT;
    await req(CTRL, "/step4a/remove", jsonBody({ path: removedTarget }));
    const { run: fsAbsentRun, kv: fsAbsent } = await runFileStatus(removedTarget);
    const absentStillGone = destSnap((await req(CTRL, "/step4a/inspect")).json, removedTarget);
    check(
      "file-status on an allowlisted absent path succeeds with exists=0, zeroed numerics, md5=none",
      fsAbsentRun?.exitCode === 0 && fsAbsent.operation === "file-status" &&
        fsAbsent.ok === "1" && fsAbsent.destination === removedTarget &&
        fsAbsent.allowed === "1" && fsAbsent.exists === "0" && fsAbsent.type === "absent" &&
        fsAbsent.bytes === "0" && fsAbsent.allocated_bytes === "0" &&
        fsAbsent.md5 === "none" && fsAbsent.mode_decimal === "0" && fsAbsent.errors === "0" &&
        absentStillGone.type === "absent",
      fsAbsentRun?.stdout,
    );
    await req(CTRL, "/step4a/seed", jsonBody({ scenario: "upgrade" }));
    await req(CTRL, "/step4a/fault", jsonBody({ kind: "destination-symlink", target: DEST_RCS, detail: "/etc/passwd" }));
    const { run: fsSymlinkRun, kv: fsSymlink } = await runFileStatus(DEST_RCS);
    check(
      "file-status refuses a symlink destination nonzero without following it",
      fsSymlinkRun?.exitCode !== 0 && fsSymlink.operation === "file-status" &&
        fsSymlink.ok === "0" && fsSymlink.allowed === "1" && fsSymlink.exists === "1" &&
        fsSymlink.type === "symlink" && typeof fsSymlink.reason === "string" &&
        fsSymlink.reason.length > 0,
      fsSymlinkRun?.stdout,
    );
    await req(CTRL, "/step4a/fault", jsonBody({ kind: "destination-directory", target: DEST_RCS }));
    const { run: fsOtherRun, kv: fsOther } = await runFileStatus(DEST_RCS);
    check(
      "file-status refuses a non-regular destination (directory) nonzero",
      fsOtherRun?.exitCode !== 0 && fsOther.operation === "file-status" &&
        fsOther.ok === "0" && fsOther.exists === "1" && fsOther.type === "other" &&
        typeof fsOther.reason === "string" && fsOther.reason.length > 0,
      fsOtherRun?.stdout,
    );
    await req(CTRL, "/step4a/seed", jsonBody({ scenario: "upgrade" }));
    for (const [name, badPath] of [
      ["non-allowlisted path", "/etc/passwd"],
      ["relative path", "data/codex/bin/codex_webui"],
      ["traversal path", "/data/codex/bin/../bin/codex_webui"],
    ]) {
      const { run: badRun, kv: badKv } = await runFileStatus(badPath);
      check(
        `file-status refuses ${name} with a stable reason and allowed=0`,
        badRun?.exitCode !== 0 && badKv.operation === "file-status" &&
          badKv.ok === "0" && badKv.allowed === "0" &&
          typeof badKv.reason === "string" && badKv.reason.length > 0,
        badRun?.stdout,
      );
    }
    const fsArgRun = await runCli(["--file-status"]);
    check(
      "file-status without a destination exits 2 (invalid arguments)",
      fsArgRun?.exitCode === 2 && parseInstallKv(fsArgRun?.stdout).ok === "0",
      fsArgRun?.stdout,
    );
    check(
      "every file-status probe ran as a one-shot real MIPS process (no server, no linger)",
      cliRuns.every((entry) =>
        entry.webuiProcessesBefore === 1 && entry.webuiProcessesAfter === 1),
      JSON.stringify(cliRuns.map((entry) => [entry.argv?.[0], entry.webuiProcessesBefore, entry.webuiProcessesAfter])),
    );
    const fsInspectAfter = await req(CTRL, "/step4a/inspect");
    check(
      "file-status probes mutated nothing: destinations match the upgrade seed",
      Object.values(fsInspectAfter.json?.destinations ?? {}).every((snap) => snap.type === "regular") &&
        destSnap(fsInspectAfter.json, DEST_WEBUI).sha256 === seededRegular.sha256,
      JSON.stringify(fsInspectAfter.json?.tempFiles),
    );

    console.log("\n-- Step 4A: atomic install, post-measure, idempotence --");
    const newPayload = fakeCandidateBytes("qa-new-webui", 4096);
    const newSha = sha256Hex(newPayload);
    const stageInstall = await req(CTRL, "/step4a/stage", jsonBody({ leaves: { "qa-new-webui": { bytes: 4096 } } }));
    const installSrc = stageInstall.json?.staged?.["qa-new-webui"];
    if (stageInstall.json?.ok === true && installSrc) {
      const destBeforeInstall = destSnap((await req(CTRL, "/step4a/inspect")).json, DEST_WEBUI);
      const installRun = await runCli(["--install-file", installSrc, DEST_WEBUI, "755", String(INSTALL_FLOOR)]);
      const installKv = parseInstallKv(installRun?.stdout);
      const destAfterInstall = destSnap((await req(CTRL, "/step4a/inspect")).json, DEST_WEBUI);
      check(
        "install-file replaces the destination atomically with the fake payload",
        installRun?.exitCode === 0 && installKv.result === "installed" &&
          installKv.rename_completed === "1" && installKv.identical === "0" &&
          installKv.sufficient === "1" && installKv.errors === "0" &&
          ["0", "1"].includes(installKv.directory_fsync) &&
          destBeforeInstall.sha256 !== destAfterInstall.sha256,
        installRun?.stdout,
      );
      check(
        "installed bytes are byte-exact and the canonical mode is enforced",
        destAfterInstall.type === "regular" && destAfterInstall.bytes === 4096 &&
          destAfterInstall.sha256 === newSha && destAfterInstall.mode === 0o755,
        JSON.stringify(destAfterInstall),
      );
      check(
        "post-write measurement rechecks the same authoritative path and keeps the floor",
        Number.isInteger(Number(installKv.available_bytes_after)) &&
          Number.isInteger(Number(installKv.available_bytes)) &&
          installKv.floor_met_after === "1" && installKv.storage_path === "/mnt/data",
        installRun?.stdout,
      );
      const noopRun = await runCli(["--install-file", installSrc, DEST_WEBUI, "755", String(INSTALL_FLOOR)]);
      const noopKv = parseInstallKv(noopRun?.stdout);
      const destAfterNoop = destSnap((await req(CTRL, "/step4a/inspect")).json, DEST_WEBUI);
      check(
        "reinstalling identical bytes is a streaming no-op (no reservation, temp, or rename)",
        noopRun?.exitCode === 0 && noopKv.identical === "1" && noopKv.result === "no-op" &&
          noopKv.rename_completed === "0" && noopKv.errors === "0" && destAfterNoop.sha256 === newSha,
        noopRun?.stdout,
      );
    } else {
      check(
        "fixture unavailable: staging for qa-new-webui (atomic install/post-measure/idempotence battery skipped)",
        false,
        stageInstall.text.slice(0, 200),
      );
    }

    console.log("\n-- Step 4A: failure seams preserve the destination --");
    const stageFaults = await req(CTRL, "/step4a/stage", jsonBody({
      leaves: { "qa-link-source": { bytes: 256 }, "qa-modeok": { bytes: 256 }, "qa-flush-distinct": { bytes: 257 } },
    }));
    if (stageFaults.json?.ok === true) {
      const destHbusBefore = destSnap((await req(CTRL, "/step4a/inspect")).json, DEST_HBUS);
      await req(CTRL, "/step4a/fault", jsonBody({ kind: "source-symlink", target: stageFaults.json.staged["qa-link-source"], detail: "/proc/self/mem" }));
      const linkRun = await runCli(["--install-file", stageFaults.json.staged["qa-link-source"], DEST_HBUS, "755", String(INSTALL_FLOOR)]);
      check(
        "a symlink source never reaches the copier (O_NOFOLLOW refuses) and the destination survives",
        linkRun?.exitCode === 1 && parseInstallKv(linkRun?.stdout).result === "refused" &&
          parseInstallKv(linkRun?.stdout).reason === "source_open_failed" &&
          JSON.stringify(destSnap((await req(CTRL, "/step4a/inspect")).json, DEST_HBUS)) === JSON.stringify(destHbusBefore),
        linkRun?.stdout,
      );
      const wrongModeRun = await runCli(["--install-file", stageFaults.json.staged["qa-modeok"], DEST_HBUS, "600", String(INSTALL_FLOOR)]);
      check(
        "wrong install mode is refused before any write with the destination untouched",
        wrongModeRun?.exitCode === 1 &&
          parseInstallKv(wrongModeRun?.stdout).reason === "mode_not_allowed" &&
          JSON.stringify(destSnap((await req(CTRL, "/step4a/inspect")).json, DEST_HBUS)) === JSON.stringify(destHbusBefore),
        wrongModeRun?.stdout,
      );
      // Byte-identical mode mismatch: the destination holds EXACTLY the
      // candidate bytes at the wrong mode 0600 while the requested canonical
      // mode is 0755. The CLI MUST NOT treat this as an identical no-op or
      // chmod in place; it must run the temp/fsync/atomic-rename path.
      const stageModeMismatch = await req(CTRL, "/step4a/stage", jsonBody({
        leaves: { "qa-mode-identical": { copy: DEST_HBUS, mode: 0o600 } },
      }));
      const mismatchSrc = stageModeMismatch.json?.staged?.["qa-mode-identical"];
      check(
        "fixture stages a byte-identical copy of the destination for the mode-mismatch repro",
        stageModeMismatch.json?.ok === true && typeof mismatchSrc === "string",
        stageModeMismatch.text.slice(0, 200),
      );
      await req(CTRL, "/step4a/fault", jsonBody({ kind: "mode-conflict", target: DEST_HBUS, detail: "600" }));
      const mismatchBefore = destSnap((await req(CTRL, "/step4a/inspect")).json, DEST_HBUS);
      check(
        "fixture arms the destination byte-identical at the wrong mode 0600",
        mismatchBefore.type === "regular" && mismatchBefore.mode === 0o600 &&
          mismatchBefore.sha256 === sha256Hex(await readFile(new URL("./stubs/codex_hbus", import.meta.url))),
        JSON.stringify(mismatchBefore),
      );
      const mismatchRun = await runCli(["--install-file", mismatchSrc, DEST_HBUS, "755", String(INSTALL_FLOOR)]);
      const mismatchKv = parseInstallKv(mismatchRun?.stdout);
      const mismatchAfter = destSnap((await req(CTRL, "/step4a/inspect")).json, DEST_HBUS);
      const mismatchTemp = (await req(CTRL, "/step4a/inspect")).json?.tempFiles ?? [];
      check(
        "byte-identical 0600 destination with requested 0755 is NOT a no-op: atomic replace completes",
        mismatchRun?.exitCode === 0 && mismatchKv.result === "installed" &&
          mismatchKv.rename_completed === "1" && mismatchKv.identical === "1" &&
          mismatchKv.errors === "0" && mismatchKv.floor_met === "1",
        mismatchRun?.stdout,
      );
      check(
        "mode-mismatch replace keeps the exact bytes and lands the canonical 0755 with no temp leftovers",
        mismatchAfter.type === "regular" && mismatchAfter.mode === 0o755 &&
          mismatchAfter.sha256 === mismatchBefore.sha256 &&
          mismatchAfter.bytes === mismatchBefore.bytes && mismatchTemp.length === 0,
        `${mismatchRun?.stdout} ${JSON.stringify(mismatchAfter)} temps=${JSON.stringify(mismatchTemp)}`,
      );
      const mismatchNoop = await runCli(["--install-file", mismatchSrc, DEST_HBUS, "755", String(INSTALL_FLOOR)]);
      const mismatchNoopKv = parseInstallKv(mismatchNoop?.stdout);
      check(
        "once the canonical mode is restored the same candidate IS a streaming no-op",
        mismatchNoop?.exitCode === 0 && mismatchNoopKv.result === "no-op" &&
          mismatchNoopKv.identical === "1" && mismatchNoopKv.rename_completed === "0",
        mismatchNoop?.stdout,
      );
      await req(CTRL, "/step4a/fault", jsonBody({ kind: "flush-ro" }));
      const flushRun = await runCli(["--install-file", stageFaults.json.staged["qa-flush-distinct"], DEST_HBUS, "755", String(INSTALL_FLOOR)]);
      const flushKv = parseInstallKv(flushRun?.stdout);
      check(
        "read-only storage refuses at same-directory temp creation and preserves the destination",
        flushRun?.exitCode === 1 && flushKv.result === "refused" &&
          flushKv.reason === "temp_create_failed" && flushKv.rename_completed === "0" &&
          JSON.stringify(destSnap((await req(CTRL, "/step4a/inspect")).json, DEST_HBUS)) === JSON.stringify(mismatchAfter),
        flushRun?.stdout,
      );
      await req(CTRL, "/step4a/fault", jsonBody({ kind: "flush-rw" }));
      const flushRecover = await runCli(["--install-file", stageFaults.json.staged["qa-flush-distinct"], DEST_HBUS, "755", String(INSTALL_FLOOR)]);
      check(
        "after remount rw the same install succeeds (the failure left no partial state)",
        flushRecover?.exitCode === 0 && parseInstallKv(flushRecover?.stdout).result === "installed",
        flushRecover?.stdout,
      );
    } else {
      check(
        "fixture unavailable: staging for qa-link-source/qa-modeok/qa-flush-distinct (failure-seam battery skipped)",
        false,
        stageFaults.text.slice(0, 200),
      );
    }

    console.log("\n-- Step 4A: deterministic temp and authority seams --");
    const seamStage = await req(CTRL, "/step4a/stage", jsonBody({
      leaves: { "qa-seam": { bytes: 8192 }, "qa-seam-large": { bytes: 8 * 1024 * 1024 } },
    }));
    const seamSrc = seamStage.json?.staged?.["qa-seam"];
    const seamLarge = seamStage.json?.staged?.["qa-seam-large"];
    if (seamStage.json?.ok === true && seamSrc && seamLarge) {
      const authorityDetached = await req(CTRL, "/step4a/data-authority", jsonBody({ action: "detach" }));
      const fallbackStatus = await runCli(["--storage-status"]);
      const fallbackKv = parseInstallKv(fallbackStatus?.stdout);
      check(
        "storage-status falls back to /data only for ENOENT on /mnt/data",
        authorityDetached.json?.ok === true && fallbackStatus?.exitCode === 0 &&
          fallbackKv.storage_path === "/data" && fallbackKv.ok === "1",
        `${authorityDetached.text} ${fallbackStatus?.stdout}`,
      );
      const authorityObscured = await req(CTRL, "/step4a/data-authority", jsonBody({ action: "obscure" }));
      const nonfallbackStatus = await runCli(["--storage-status"]);
      const nonfallbackKv = parseInstallKv(nonfallbackStatus?.stdout);
      check(
        "storage-status does not fall back for non-ENOENT authority errors",
        authorityObscured.json?.ok === true && nonfallbackStatus?.exitCode !== 0 &&
          nonfallbackKv.storage_path !== "/data",
        `${authorityObscured.text} ${nonfallbackStatus?.stdout}`,
      );
      await req(CTRL, "/step4a/data-authority", jsonBody({ action: "reveal" }));

      const tempBefore = await req(CTRL, "/step4a/inspect");
      const collision = await runCli(
        ["--install-file", seamSrc, DEST_HBUS, "755", String(INSTALL_FLOOR)],
        { tempCollision: { destination: DEST_HBUS } },
      );
      const tempAfter = await req(CTRL, "/step4a/inspect");
      const collisionKv = parseInstallKv(collision?.stdout);
      check(
        "pre-created temporary names exhaust collision retries without replacement",
        collision?.exitCode === 1 && collisionKv.reason === "temp_create_failed" &&
          collisionKv.rename_completed === "0" && tempAfter.json?.tempFiles?.length === 0,
        collision?.stdout,
      );

      const partialBefore = destSnap((await req(CTRL, "/step4a/inspect")).json, DEST_HBUS);
      const partial = await runCli(
        ["--install-file", seamLarge, DEST_HBUS, "755", String(INSTALL_FLOOR)],
        { partialBytes: 1024 },
      );
      const partialAfter = await req(CTRL, "/step4a/inspect");
      const partialKv = parseInstallKv(partial?.stdout);
      check(
        "partial write fails before rename and preserves old hash/mode",
        partial?.exitCode !== 0 && partialKv.rename_completed === "0" &&
          JSON.stringify(destSnap(partialAfter.json, DEST_HBUS)) === JSON.stringify(partialBefore),
        partial?.stdout,
      );
      const truncateBefore = destSnap((await req(CTRL, "/step4a/inspect")).json, DEST_HBUS);
      const truncate = await runCli(
        ["--install-file", seamLarge, DEST_HBUS, "755", String(INSTALL_FLOOR)],
        { truncateRace: { source: seamLarge, destination: DEST_HBUS } },
      );
      const truncateAfter = await req(CTRL, "/step4a/inspect");
      const truncateKv = parseInstallKv(truncate?.stdout);
      check(
        "source truncation race fails verification before rename",
        truncate?.exitCode !== 0 && truncateKv.rename_completed === "0" &&
          JSON.stringify(destSnap(truncateAfter.json, DEST_HBUS)) === JSON.stringify(truncateBefore),
        truncate?.stdout,
      );

      for (const syscall of ["fchmod", "fsync", "renameat"]) {
        const before = destSnap((await req(CTRL, "/step4a/inspect")).json, DEST_HBUS);
        const injected = await runCli(
          ["--install-file", seamSrc, DEST_HBUS, "755", String(INSTALL_FLOOR)],
          { errnoOn: [syscall], errno: "EIO" },
        );
        const after = await req(CTRL, "/step4a/inspect");
        const ikv = parseInstallKv(injected?.stdout);
        check(
          `${syscall} errno failure preserves destination and cleans temp`,
          injected?.exitCode !== 0 && ikv.rename_completed === "0" &&
            JSON.stringify(destSnap(after.json, DEST_HBUS)) === JSON.stringify(before) &&
            after.json?.tempFiles?.length === 0,
          injected?.stdout,
        );
      }
      await req(CTRL, "/step4a/seed", jsonBody({ scenario: "upgrade" }));
    } else {
      check(
        "fixture unavailable: staging for qa-seam/qa-seam-large (deterministic temp/authority-seam battery skipped)",
        false,
        seamStage.text.slice(0, 200),
      );
    }
    console.log("\n-- Step 4A: handoff and manual backup safety --");
    await req(CTRL, "/step4a/manual-backups", { method: "POST" });
    const handoffGood = await req(CTRL, "/step4a/handoff", jsonBody({ stamp: "20260806-130000" }));
    check(
      "bounded handoff copies the required files atomically into a renamed generation",
      handoffGood.json?.ok === true &&
        handoffGood.json?.final === "/data/codex-backups/webui-handoff-20260806-130000" &&
        Array.isArray(handoffGood.json?.copied) && handoffGood.json.copied.length > 0 &&
        handoffGood.json.bytes <= 262144,
      handoffGood.text.slice(0, 240),
    );
    const expectedHandoffSources = new Set([
      "/etc/init.d/rcS.local",
      "/opt/luaworks/tasks/connectserver/netservicestarter.lua",
      "/usr/sbin/dropbear",
      "/usr/sbin/dropbearkey",
      "/data/codex/hub_id",
      "/data/codex/cloud_blocker.conf",
      "/data/codex/offline_egress_guard.sh",
      "/data/codexmqtt/config.json",
      "/pkg/codexactivity/codexactivity.lua",
      "/pkg/codexactivity/manifest.json",
    ]);
    check(
      "handoff copies exactly the required bounded source set",
      new Set((handoffGood.json?.copied ?? []).map((entry) => entry.source)).size ===
        expectedHandoffSources.size &&
        (handoffGood.json?.copied ?? []).every((entry) => expectedHandoffSources.has(entry.source)),
      JSON.stringify(handoffGood.json?.copied),
    );
    const handoffInspect = await req(CTRL, "/step4a/inspect");
    check(
      "manual owner backups coexist with the new handoff generation",
      handoffInspect.json?.handoff?.includes("webui-handoff-20260101-000000") &&
        handoffInspect.json?.handoff?.includes("owner-note.txt") &&
        handoffInspect.json?.handoff?.includes("webui-handoff-20260806-130000"),
      JSON.stringify(handoffInspect.json?.handoff),
    );
    const handoffFail = await req(CTRL, "/step4a/handoff", jsonBody({ stamp: "20260806-131500", failAfter: 0 }));
    const handoffFailInspect = await req(CTRL, "/step4a/inspect");
    check(
      "failed handoff removes its incomplete directory and renames nothing",
      handoffFail.json?.ok === false && handoffFail.json?.reason === "injected_copy_failure" &&
        handoffFail.json?.final === null &&
        !JSON.stringify(handoffFailInspect.json?.handoff).includes("20260806-131500"),
      JSON.stringify(handoffFailInspect.json?.handoff),
    );
    const pruneWithHandoff = await req(CTRL, "/retention/prune", { method: "POST" });
    const handoffAfterPrune = await req(CTRL, "/step4a/inspect");
    check(
      "Step 3 retention preserves handoff generations and owner files under budget",
      pruneWithHandoff.json?.exitCode === 0 &&
        handoffAfterPrune.json?.handoff?.includes("webui-handoff-20260101-000000") &&
        handoffAfterPrune.json?.handoff?.includes("webui-handoff-20260806-130000") &&
        handoffAfterPrune.json?.handoff?.includes("owner-note.txt"),
      JSON.stringify(handoffAfterPrune.json?.handoff),
    );

    console.log("\n-- Step 4A: preflight writes nothing (hashes, lists, modes, inventory, identity) --");
    await req(CTRL, "/step4a/seed", jsonBody({ scenario: "upgrade" }));
    const preflightBefore = await req(CTRL, "/step4a/inspect");
    const inventoryBefore = await req(CTRL, "/retention/inspect");
    const stagePreflight = await req(CTRL, "/step4a/stage", jsonBody({
      leaves: { "qa-pre-hbus": { bytes: 2048 }, "qa-pre-rcs": { bytes: 1024 }, "qa-pre-webui": { bytes: 4096 } },
    }));
    if (stagePreflight.json?.ok === true) {
      const preflightTargets = [
        ["qa-pre-hbus", DEST_HBUS],
        ["qa-pre-rcs", DEST_RCS],
        ["qa-pre-webui", DEST_WEBUI],
      ];
      let preflightPlansOk = true;
      for (const [leaf, dest] of preflightTargets) {
        const plan = await runCli(["--install-plan", stagePreflight.json.staged[leaf], dest, "755", String(INSTALL_FLOOR)]);
        preflightPlansOk = preflightPlansOk && plan?.exitCode === 0 && parseInstallKv(plan?.stdout).ok === "1";
      }
      check("preflight plans for every candidate succeed with headroom restored", preflightPlansOk);
      const preflightAfter = await req(CTRL, "/step4a/inspect");
      const inventoryAfter = await req(CTRL, "/retention/inspect");
      check(
        "preflight changed no destination hash, file list, or mode",
        JSON.stringify(preflightAfter.json?.destinations) === JSON.stringify(preflightBefore.json?.destinations),
      );
      check(
        "preflight left the backup inventory untouched",
        JSON.stringify(inventoryAfter.json) === JSON.stringify(inventoryBefore.json),
      );
      check(
        "preflight staging stayed volatile in private 0700 trees",
        preflightAfter.json?.stages?.length === preflightBefore.json.stages.length + 1 &&
          preflightAfter.json?.stages?.every((stage) => stage.mode === 0o700),
        JSON.stringify(preflightAfter.json?.stages?.map((stage) => stage.path)),
      );
      check(
        "preflight kept capacity byte-identical (measurement only)",
        preflightAfter.json?.capacity?.bytesAvailable === preflightBefore.json?.capacity?.bytesAvailable,
        JSON.stringify({ before: preflightBefore.json?.capacity?.bytesAvailable, after: preflightAfter.json?.capacity?.bytesAvailable }),
      );
    } else {
      check(
        "fixture unavailable: staging for qa-pre-hbus/qa-pre-rcs/qa-pre-webui (preflight read-only battery skipped)",
        false,
        stagePreflight.text.slice(0, 200),
      );
    }

    console.log("\n-- Step 4A: fake upgrade preserves configuration --");
    const configMd5Before = await req(CTRL, "/step4a/md5", jsonBody({ paths: CONFIG_PRESERVED_PATHS }));
    const expMqttBeforeConfig = await req(API, "/export/mqtt");
    const stageConfig = await req(CTRL, "/step4a/stage", jsonBody({ leaves: { "qa-cfg-webui": { bytes: 2048 } } }));
    if (stageConfig.json?.ok === true) {
      const configInstall = await runCli(["--install-file", stageConfig.json.staged["qa-cfg-webui"], DEST_WEBUI, "755", String(INSTALL_FLOOR)]);
      const configMd5After = await req(CTRL, "/step4a/md5", jsonBody({ paths: CONFIG_PRESERVED_PATHS }));
      const expMqttAfterConfig = await req(API, "/export/mqtt");
      check(
        "fake upgrade installs while every configuration file stays byte-identical",
        configInstall?.exitCode === 0 &&
          configMd5Before.json?.exitCode === 0 && configMd5After.json?.exitCode === 0 &&
          configMd5Before.json?.stdout === configMd5After.json?.stdout &&
          expMqttAfterConfig.json?.broker?.host === expMqttBeforeConfig.json?.broker?.host &&
          expMqttAfterConfig.json?.enabled === false,
        `before=${configMd5Before.json?.stdout} after=${configMd5After.json?.stdout}`,
      );
    } else {
      check(
        "fixture unavailable: staging for qa-cfg-webui (config-preservation fake-upgrade battery skipped)",
        false,
        stageConfig.text.slice(0, 200),
      );
    }

    console.log("\n-- Step 4A: reverse multi-file rollback through real MIPS --");
    await req(CTRL, "/step4a/seed", jsonBody({ scenario: "upgrade" }));
    const stageRollback = await req(CTRL, "/step4a/stage", jsonBody({
      leaves: { "qa-rb-hbus": { bytes: 2048 }, "qa-rb-rcs": { bytes: 1024 }, "qa-rb-webui": { bytes: 4096 } },
    }));
    if (stageRollback.json?.ok === true) {
      // Install order mirrors the wrapper: codex_webui last. Forward floor_k =
      // 1048576 + handoff reservation + sum of every later forward+rollback
      // reservation; reverse floor_k = 1048576 + every later restoration.
      const rollbackOrder = [
        ["qa-rb-hbus", DEST_HBUS, 2048],
        ["qa-rb-rcs", DEST_RCS, 1024],
        ["qa-rb-webui", DEST_WEBUI, 4096],
      ];
      const originals = {};
      let rollbackCopiesOk = true;
      for (const [, dest] of rollbackOrder) {
        originals[dest] = destSnap((await req(CTRL, "/step4a/inspect")).json, dest);
        const copy = await req(CTRL, "/step4a/rollback-copy", jsonBody({
          source: dest,
          destination: `${stageRollback.json.stage}/rb-${dest.split("/").pop()}`,
        }));
        rollbackCopiesOk = rollbackCopiesOk && copy.status === 200;
      }
      check("wrapper-style rollback copies captured every original", rollbackCopiesOk);
      const reservations = {};
      for (const [leaf, dest] of rollbackOrder) {
        const plan = await runCli(["--install-plan", stageRollback.json.staged[leaf], dest, "755", String(INSTALL_FLOOR)]);
        const pkv = parseInstallKv(plan?.stdout);
        reservations[dest] = {
          forward: Number(pkv.candidate_reservation_bytes),
          rollback: Number(pkv.rollback_reservation_bytes),
        };
      }
      const handoffForRollback = await req(CTRL, "/step4a/handoff", jsonBody({ stamp: "20260806-140000" }));
      const handoffReservation = handoffForRollback.json?.bytes
        ? ceilAlloc(handoffForRollback.json.bytes, fragmentBytes) + fragmentBytes
        : 0;
      let installOrderOk = handoffForRollback.json?.ok === true;
      for (let pos = 0; pos < rollbackOrder.length; pos++) {
        const [leaf, dest] = rollbackOrder[pos];
        const rest = rollbackOrder.slice(pos + 1)
          .reduce((sum, [, d]) => sum + reservations[d].forward + reservations[d].rollback, 0);
        const expectedFloor = INSTALL_FLOOR + handoffReservation + rest;
        const run = await runCli(["--install-file", stageRollback.json.staged[leaf], dest, "755", String(expectedFloor)]);
        const rkv = parseInstallKv(run?.stdout);
        installOrderOk = installOrderOk && run?.exitCode === 0 &&
          rkv.result === "installed" && rkv.floor_bytes === String(expectedFloor);
      }
      check(
        "install order keeps codex_webui last with each floor covering every later reservation",
        installOrderOk,
        JSON.stringify(reservations),
      );
      const installedState = await req(CTRL, "/step4a/inspect");
      check(
        "all three destinations carry the fake upgrade bytes and canonical modes",
        rollbackOrder.every(([leaf, dest, size]) =>
          destSnap(installedState.json, dest).sha256 === sha256Hex(fakeCandidateBytes(leaf, size)) &&
          destSnap(installedState.json, dest).mode === 0o755),
        JSON.stringify(rollbackOrder.map(([, dest]) => destSnap(installedState.json, dest))),
      );
      const midInstallAlive = await req(API, "/api/system-status");
      check(
        "the normal server stays live through the multi-file install window",
        midInstallAlive.status === 200 && midInstallAlive.json?.ok === true,
        midInstallAlive.text.slice(0, 160),
      );
      let rollbackOk = true;
      const reversed = [...rollbackOrder].reverse();
      for (let idx = 0; idx < reversed.length; idx++) {
        const [, dest] = reversed[idx];
        const rest = reversed.slice(idx + 1)
          .reduce((sum, [, d]) => sum + ceilAlloc(originals[d].bytes, fragmentBytes) + fragmentBytes, 0);
        const restoreFloor = INSTALL_FLOOR + rest;
        const run = await runCli(["--install-file", `${stageRollback.json.stage}/rb-${dest.split("/").pop()}`, dest, "755", String(restoreFloor), "--rollback-restore"]);
        const rkv = parseInstallKv(run?.stdout);
        rollbackOk = rollbackOk && run?.exitCode === 0 && rkv.result === "installed" &&
          rkv.rollback_reservation_bytes === "0" && rkv.floor_bytes === String(restoreFloor);
      }
      const rolledBackState = await req(CTRL, "/step4a/inspect");
      check(
        "reverse rollback restores every original byte-for-byte with zero rollback reservation",
        rollbackOk && rollbackOrder.every(([, dest]) =>
          destSnap(rolledBackState.json, dest).sha256 === originals[dest].sha256 &&
          destSnap(rolledBackState.json, dest).bytes === originals[dest].bytes &&
          destSnap(rolledBackState.json, dest).mode === originals[dest].mode),
        JSON.stringify(rollbackOrder.map(([, dest]) => destSnap(rolledBackState.json, dest))),
      );

      // Originally-absent destinations: rollback removes the new paths.
      await req(CTRL, "/step4a/seed", jsonBody({ scenario: "fresh" }));
      const stageAbsent = await req(CTRL, "/step4a/stage", jsonBody({
        leaves: { "qa-abs-hbus": { bytes: 1024 }, "qa-abs-webui": { bytes: 1024 } },
      }));
      if (stageAbsent.json?.ok === true) {
        const absentDests = [["qa-abs-hbus", DEST_HBUS], ["qa-abs-webui", DEST_WEBUI]];
        let absentInstalled = true;
        for (const [leaf, dest] of absentDests) {
          const run = await runCli(["--install-file", stageAbsent.json.staged[leaf], dest, "755", String(INSTALL_FLOOR)]);
          absentInstalled = absentInstalled && run?.exitCode === 0 && parseInstallKv(run?.stdout).result === "installed";
        }
        check("first-install shape creates originally-absent destinations", absentInstalled);
        const removals = [];
        for (const [, dest] of [...absentDests].reverse()) {
          removals.push(await req(CTRL, "/step4a/remove", jsonBody({ path: dest })));
        }
        const afterAbsent = await req(CTRL, "/step4a/inspect");
        check(
          "rollback of originally-absent destinations removes the new paths",
          removals.every((removal) => removal.json?.ok === true) &&
            absentDests.every(([, dest]) => destSnap(afterAbsent.json, dest).type === "absent"),
          JSON.stringify(absentDests.map(([, dest]) => destSnap(afterAbsent.json, dest))),
        );
      } else {
        check(
          "fixture unavailable: staging for qa-abs-hbus/qa-abs-webui (originally-absent rollback battery skipped)",
          false,
          stageAbsent.text.slice(0, 200),
        );
      }

      // Incomplete rollback is fatal: new files and staged recovery copies survive.
      await req(CTRL, "/step4a/seed", jsonBody({ scenario: "upgrade" }));
      const stageFatal = await req(CTRL, "/step4a/stage", jsonBody({
        leaves: { "qa-fatal-hbus": { bytes: 2048 }, "qa-fatal-webui": { bytes: 2048 } },
      }));
      if (stageFatal.json?.ok === true) {
        const fatalDests = [["qa-fatal-hbus", DEST_HBUS], ["qa-fatal-webui", DEST_WEBUI]];
        for (const [leaf, dest] of fatalDests) {
          await req(CTRL, "/step4a/rollback-copy", jsonBody({
            source: dest,
            destination: `${stageFatal.json.stage}/rb-${dest.split("/").pop()}`,
          }));
          await runCli(["--install-file", stageFatal.json.staged[leaf], dest, "755", String(INSTALL_FLOOR)]);
        }
        await req(CTRL, "/step4a/fault", jsonBody({ kind: "flush-ro" }));
        let fatalIncomplete = false;
        for (const [, dest] of [...fatalDests].reverse()) {
          const restore = await runCli(["--install-file", `${stageFatal.json.stage}/rb-${dest.split("/").pop()}`, dest, "755", String(INSTALL_FLOOR), "--rollback-restore"]);
          fatalIncomplete = fatalIncomplete || restore?.exitCode !== 0;
        }
        const fatalAfter = await req(CTRL, "/step4a/inspect");
        await req(CTRL, "/step4a/fault", jsonBody({ kind: "flush-rw" }));
        check(
          "an interrupted rollback is incomplete and preserves both the new files and the staged recovery copies",
          fatalIncomplete &&
            fatalDests.every(([leaf, dest]) =>
              destSnap(fatalAfter.json, dest).sha256 === sha256Hex(fakeCandidateBytes(leaf, 2048))) &&
            fatalAfter.json?.stages?.some((stage) => stage.path === stageFatal.json.stage) &&
            Object.keys(fatalAfter.json?.stages?.find((stage) => stage.path === stageFatal.json.stage)?.leaves ?? {})
              .some((leafName) => leafName.includes("rb-")),
          JSON.stringify(fatalAfter.json?.stages?.map((stage) => stage.path)),
        );
      } else {
        check(
          "fixture unavailable: staging for qa-fatal-hbus/qa-fatal-webui (incomplete-rollback fatality battery skipped)",
          false,
          stageFatal.text.slice(0, 200),
        );
      }
    } else {
      check(
        "fixture unavailable: staging for qa-rb-hbus/qa-rb-rcs/qa-rb-webui (reverse multi-file rollback battery skipped)",
        false,
        stageRollback.text.slice(0, 200),
      );
    }
    await req(CTRL, "/step4a/fault", jsonBody({ kind: "flush-rw" }));
    await req(CTRL, "/step4a/seed", jsonBody({ scenario: "upgrade" }));

    console.log("\n-- Step 4A: the normal server and Step 3 contract survive --");
    check(
      "every real MIPS maintenance run kept process identity (one server, no listener)",
      cliRuns.length > 0 && cliRuns.every((run) =>
        run.webuiProcessesBefore === 1 && run.webuiProcessesAfter === 1),
      `runs=${cliRuns.length}`,
    );
    const aliveFinal = await req(API, "/api/activity-state");
    check(
      "normal real MIPS server stays live through the whole Step 4A proof",
      aliveFinal.status === 200 && aliveFinal.json?.ok === true,
      aliveFinal.text.slice(0, 160),
    );
    const rebootFinal = await req(CTRL, "/status");
    check("Step 4A never restarted or rebooted the box", rebootFinal.json?.rebootCount === 0, JSON.stringify(rebootFinal.json));
  }

  const finalReset = await req(CTRL, "/reset", { method: "POST" });
  const expMqttFinal = await req(API, "/export/mqtt");
  const expWifiFinal = await req(API, "/export/wifi");
  check(
    "reset after Step 4A restores seeded settings",
    finalReset.status === 200 &&
      expMqttFinal.json?.broker?.host === "mqtt.hub-emu.invalid" &&
      expWifiFinal.text.includes("HUB-EMU-FAKE-SSID"),
    expMqttFinal.text.slice(0, 160),
  );
  const step4aFinal = await req(CTRL, "/step4a/inspect");
  check(
    "no Step 4A filler, staging tree, or handoff survives reset (staging cleanup)",
    step4aFinal.json?.capacity?.fillerBytes === 0 &&
      step4aFinal.json?.stages?.length === 0 &&
      step4aFinal.json?.handoff?.length === 0,
    JSON.stringify({
      filler: step4aFinal.json?.capacity?.fillerBytes,
      stages: step4aFinal.json?.stages?.length,
      handoff: step4aFinal.json?.handoff,
    }),
  );
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
