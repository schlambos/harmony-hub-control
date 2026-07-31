#!/usr/bin/env node
// hub-emu contract QA — proves the emulator serves the box's REAL API
// semantics, including the strict behaviors the old JS mock hid
// (form-only parsers, 404 for invented endpoints, revision conflicts, 413).
//
// Run after ./run.sh:  node tools/hub-emu/qa.mjs

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
  return { status: response.status, text, json };
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

let btForm = { status: 0, json: null, text: "skipped (no BT device in fixture)" };
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

console.log("\n== setup pages: seeded fake-only settings ==");
const dashProbe = await req(API, "/system", form({}));
check(
  "legacy dashboard firmware stat reads the seeded /etc/version",
  dashProbe.status === 200 && dashProbe.text.includes("4.15.600")
);
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
const systemJson = await req(API, "/system", jsonBody({ action: "reboot" }));
check(
  "POST /system with JSON body -> 200 HTML 'Unknown system action.' (non-mutating probe)",
  systemJson.status === 200 && systemJson.text.includes("Unknown system action."),
  systemJson.text.slice(0, 120)
);
const getSystem = await req(API, "/system");
check("GET /system -> 404 (the box only has POST /system)", getSystem.status === 404, `got ${getSystem.status}`);
const importJson = await req(API, "/import", jsonBody({ target: "mqtt", payload: "{}" }));
check(
  "POST /import with JSON body -> 200 HTML 'Unknown import target.'",
  importJson.status === 200 && importJson.text.includes("Unknown import target."),
  importJson.text.slice(0, 120)
);
const wifiAfterJson = await req(API, "/export/wifi");
check("JSON probes mutated nothing (wpa_supplicant.conf still seeded)", wifiAfterJson.text.includes("HUB-EMU-FAKE-SSID"));

console.log("\n== setup pages: form posts mutate settings and answer full HTML ==");
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
const expMqtt3 = await req(API, "/export/mqtt");
check("import restored the seeded fake MQTT config", expMqtt3.json?.broker?.host === "mqtt.hub-emu.invalid");
const btDeviceForm = await req(API, "/bt/device", form({ name: "QA Emu Keyboard", type: "btkeyboard", bdaddr: "02:00:00:00:00:01" }));
check(
  "POST /bt/device form -> 200 HTML 'Saved Bluetooth device' (obviously fake MAC)",
  btDeviceForm.status === 200 && btDeviceForm.text.includes("Saved Bluetooth device QA Emu Keyboard."),
  btDeviceForm.text.slice(0, 160)
);
const expBt2 = await req(API, "/export/bluetooth");
check(
  "Bluetooth save persisted to /data/codex/bt-devices.json",
  expBt2.text.includes("QA Emu Keyboard") && expBt2.text.includes("02:00:00:00:00:01")
);
const irLegacy = await req(API, "/ir/send", form({ deviceId: String(irDevice.Device["Id-"]), command: irCommand }));
check(
  "POST /ir/send form (legacy path) -> 200 HTML 'Sent ... to ...'",
  irLegacy.status === 200 && irLegacy.text.includes("Sent ") && irLegacy.text.includes(" to "),
  irLegacy.text.slice(0, 160)
);

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
const locked = await req(API, "/api/activity-state");
check("auth now gates the whole API (401 without credentials)", locked.status === 401, `got ${locked.status}`);
const authed = await req(API, "/api/activity-state", {
  headers: { Authorization: `Basic ${Buffer.from("hub-emu-fake-admin:hub-emu-fake-secret").toString("base64")}` },
});
check("the fake credentials authenticate", authed.status === 200 && authed.json?.ok === true, `got ${authed.status}`);
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

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
