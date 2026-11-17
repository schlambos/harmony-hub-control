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

// Form POST contract (docs/API.md "Form routes", issue #186): the pinned
// binary answers every legacy form POST with the full application page
// (render_page()/page_head(), ~785 KiB including the overview section and
// the embedded remote skin), HTTP 200 even on refusal, with the outcome in
// the page's <div class='msg'>. The browser's postHubForm() only needs
// response.ok plus that msg text (tools/webui-sim/public/js/api.js), so the
// full page is the supported contract. The compact <4 KiB result page this
// check once asserted came from 0828c08, which 638a8a6 ("restore live box
// binary as product") deliberately reverted; render_message() compact pages
// survive only on routes such as /ir/delete-device. Assert the documented
// page shape and message, and that no fixture secret leaks into it.
function checkFormPost(name, result, expectedMessage) {
  const bytes = Buffer.byteLength(result.text);
  check(
    `${name} returns the documented form result page`,
    result.status === 200 &&
      result.headers["content-type"]?.startsWith("text/html") &&
      result.headers["cache-control"] === "no-store" &&
      result.headers.connection?.toLowerCase() === "close" &&
      result.text.startsWith("<!doctype html>") &&
      result.text.includes("<section id='view-overview'") &&
      result.text.includes("<div class='msg'>") &&
      result.text.includes(expectedMessage) &&
      result.text.endsWith("</html>") &&
      !result.text.includes("hub-emu-fake-password") &&
      !result.text.includes("hub-emu-fake-passphrase"),
    `status=${result.status} bytes=${bytes}`,
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

console.log("\n== Home Assistant devices: codex_webui -> offline writer plumbing ==");
// engine-emu stands in for codexactivity's CommitHaDevices; the real
// reconciliation is tested by tools/touch-validator/codexactivity-ha-devices-test.lua.
const haSet = {
  webhook: "http://ha.hub-emu.invalid:8123/api/webhook/qa",
  devices: [{ entity: "light.qa", name: "QA lamp", commands: [{ name: "PowerOn", value: "turn_on" }] }],
};
const haForm = await req(API, "/api/ha-devices", form({ payload: JSON.stringify(haSet) }));
check("POST /api/ha-devices form-encoded -> 400 (JSON object only)", haForm.status === 400, `got ${haForm.status}`);
const haTrailing = await req(API, "/api/ha-devices", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(haSet) + " x",
});
check("POST /api/ha-devices with trailing data -> 400", haTrailing.status === 400, `got ${haTrailing.status}`);
const haDry = await req(API, "/api/ha-devices", jsonBody({ ...haSet, dryRun: true }));
check(
  "POST /api/ha-devices dryRun -> 200 with the writer's reply as the body",
  haDry.status === 200 && haDry.json?.ok === true && haDry.json?.dryRun === true &&
    haDry.json?.devices?.[0]?.entity === "light.qa",
  haDry.text.slice(0, 200),
);
const haCommit = await req(API, "/api/ha-devices", jsonBody(haSet));
check(
  "POST /api/ha-devices -> 200, not a dry run",
  haCommit.status === 200 && haCommit.json?.ok === true && haCommit.json?.dryRun === false,
  haCommit.text.slice(0, 200),
);
const haRejected = await req(API, "/api/ha-devices", jsonBody({ webhook: haSet.webhook, devices: "light.qa" }));
check(
  "POST /api/ha-devices the writer rejects -> 422 with its error",
  haRejected.status === 422 && haRejected.json?.ok === false && /devices/.test(haRejected.json?.error ?? ""),
  `got ${haRejected.status} ${haRejected.text.slice(0, 160)}`,
);
// codex_webui reads bodies by Content-Length only; a chunked body arrives empty.
const haChunked = await req(API, "/api/ha-devices", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(JSON.stringify(haSet)));
      controller.close();
    },
  }),
  duplex: "half",
});
check("POST /api/ha-devices chunked -> 400 (no Content-Length, empty body)", haChunked.status === 400, `got ${haChunked.status}`);
const haEvents = ((await req(CTRL, "/events")).json?.events ?? []).filter((e) => e.kind.startsWith("ha-devices"));
check(
  "the writer saw one dry run, one commit and one rejection, with the webhook intact",
  haEvents.length === 3 && haEvents[0].dryRun === true && haEvents[1].dryRun === false &&
    haEvents[1].webhook === haSet.webhook && haEvents[2].kind === "ha-devices-rejected",
  JSON.stringify(haEvents),
);

// A set the hub already holds, or already refused, must cost no flash backup:
// Home Assistant re-sent a refused set every 10 s, and each backup's JFFS2 GC
// stalled the engine until remote presses timed out.
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const backupNames = async () =>
  ((await req(CTRL, "/retention/inspect")).json?.families?.resources?.generations ?? []).map((g) => g.name);
const writerCalls = async () =>
  ((await req(CTRL, "/events")).json?.events ?? []).filter((e) => e.kind.startsWith("ha-devices")).length;
const memoSet = {
  webhook: haSet.webhook,
  devices: [{ entity: "light.memo", name: "Memo lamp", commands: [{ name: "PowerOn", value: "turn_on" }] }],
};
const memoPost = async (set) => {
  await sleep(1100); // backups are named by the second
  const before = { backups: await backupNames(), calls: await writerCalls() };
  const result = await req(API, "/api/ha-devices", jsonBody(set));
  const after = { backups: await backupNames(), calls: await writerCalls() };
  return {
    ...result,
    backedUp: after.backups.some((name) => !before.backups.includes(name)),
    writerCalls: after.calls - before.calls,
  };
};
const memoFirst = await memoPost(memoSet);
check(
  "a new HA set is backed up and written",
  memoFirst.status === 200 && memoFirst.json?.changed === true && memoFirst.backedUp && memoFirst.writerCalls === 1,
  JSON.stringify({ status: memoFirst.status, backedUp: memoFirst.backedUp, calls: memoFirst.writerCalls }),
);
const memoSecond = await memoPost(memoSet);
check(
  "the same set again: no backup; the writer answers unchanged",
  memoSecond.status === 200 && memoSecond.json?.changed === false && !memoSecond.backedUp &&
    memoSecond.writerCalls === 1,
  JSON.stringify({ status: memoSecond.status, backedUp: memoSecond.backedUp, calls: memoSecond.writerCalls }),
);
const memoThird = await memoPost(memoSet);
check(
  "and again: the unchanged answer is replayed without the writer",
  memoThird.status === 200 && memoThird.json?.ok === true && memoThird.json?.changed === false &&
    !memoThird.backedUp && memoThird.writerCalls === 0,
  JSON.stringify({ status: memoThird.status, backedUp: memoThird.backedUp, calls: memoThird.writerCalls }),
);
const refusedSet = { webhook: haSet.webhook, devices: [{ ...memoSet.devices[0], name: "Refused TV" }] };
const refusedFirst = await memoPost(refusedSet);
check(
  "a refused set -> 422 from the writer",
  refusedFirst.status === 422 && /activities still use/.test(refusedFirst.json?.error ?? "") &&
    refusedFirst.writerCalls === 1,
  JSON.stringify({ status: refusedFirst.status, calls: refusedFirst.writerCalls }),
);
const refusedAgain = await memoPost(refusedSet);
check(
  "the same refused set again: the same 422, with no backup and no writer",
  refusedAgain.status === 422 && refusedAgain.json?.error === refusedFirst.json?.error &&
    !refusedAgain.backedUp && refusedAgain.writerCalls === 0,
  JSON.stringify({ status: refusedAgain.status, backedUp: refusedAgain.backedUp, calls: refusedAgain.writerCalls }),
);
const callsBeforeDry = await writerCalls();
const memoDry = await req(API, "/api/ha-devices", jsonBody({ ...refusedSet, dryRun: true }));
check(
  "a dry run bypasses the memo",
  memoDry.status === 422 && (await writerCalls()) === callsBeforeDry + 1,
  `got ${memoDry.status}`,
);

console.log("\n== Touch device screens: codex_webui -> offline writer plumbing ==");
// engine-emu stands in for codexactivity's CommitDeviceScreen; the real
// builder is tested by tools/touch-validator/codexactivity-device-screens-test.lua.
const screenBadId = await req(API, "/api/device-screen", jsonBody({ deviceId: "amp" }));
check("POST /api/device-screen without a numeric deviceId -> 400", screenBadId.status === 400, `got ${screenBadId.status}`);
const screenDry = await req(API, "/api/device-screen", jsonBody({ deviceId: "40000001", dryRun: true }));
check(
  "POST /api/device-screen dryRun -> 200 with the writer's reply as the body",
  screenDry.status === 200 && screenDry.json?.ok === true && screenDry.json?.dryRun === true &&
    screenDry.json?.deviceId === "40000001" && screenDry.json?.removed === false,
  screenDry.text.slice(0, 200),
);
const screenRemove = await req(API, "/api/device-screen", jsonBody({ deviceId: "40000001", remove: true }));
check(
  "POST /api/device-screen remove -> 200, not a dry run",
  screenRemove.status === 200 && screenRemove.json?.removed === true && screenRemove.json?.dryRun === false,
  screenRemove.text.slice(0, 200),
);
const screenRejected = await req(API, "/api/device-screen", jsonBody({ deviceId: "0" }));
check(
  "POST /api/device-screen the writer rejects -> 422 with its error",
  screenRejected.status === 422 && /no device 0/.test(screenRejected.json?.error ?? ""),
  `got ${screenRejected.status} ${screenRejected.text.slice(0, 160)}`,
);
const screenEvents = ((await req(CTRL, "/events")).json?.events ?? []).filter((e) => e.kind.startsWith("device-screen"));
check(
  "the writer saw a dry run, a removal and a rejection",
  screenEvents.length === 3 && screenEvents[0].dryRun === true && screenEvents[1].remove === true &&
    screenEvents[2].kind === "device-screen-rejected",
  JSON.stringify(screenEvents),
);

console.log("\n== writer requests take turns ==");
// Each connection is its own codex_webui child and all writer requests share
// one request file; without a lock, overlapping requests delete each other's
// files and one waits out its whole 120 s. engine-emu answers this op at once
// (422, unknown op), so every request should come back quickly.
const turnsStart = Date.now();
const turns = await Promise.all(
  [1, 2, 3, 4].map(() =>
    req(API, "/api/device-settings", jsonBody({ deviceId: "74521691", settings: { power: { type: "none" } } }))),
);
const turnsMs = Date.now() - turnsStart;
check(
  "four overlapping writer requests each get the writer's answer",
  turns.every((t) => t.status === 422 && /unknown op/.test(t.json?.error ?? "")),
  turns.map((t) => `${t.status} ${t.json?.error ?? t.text.slice(0, 60)}`).join(" | "),
);
check("and none waits out the writer limit", turnsMs < 15000, `${turnsMs} ms`);

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
    systemStatus.json?.logs?.includes("--- startup log (newest lines) ---") &&
    systemStatus.json?.logs?.includes("hub-emu fake startup") &&
    systemStatus.json?.logs?.includes("--- recovery log (newest lines) ---") &&
    systemStatus.json?.logs?.includes("hub-emu fake recovery") &&
    systemStatus.json?.logs?.includes("--- local service syslog (newest lines) ---") &&
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
check(
  "GET /export/mqtt redacts the broker password while sign-in is off (issue #88)",
  expMqtt.json?.broker?.password === "__REDACTED__" && !expMqtt.text.includes("hub-emu-fake-password"),
  expMqtt.text.slice(0, 200)
);
const expWifi = await req(API, "/export/wifi");
check("GET /export/wifi -> seeded fake SSID", expWifi.status === 200 && expWifi.text.includes("HUB-EMU-FAKE-SSID"));
check(
  "GET /export/wifi redacts the PSK while sign-in is off (issue #88)",
  expWifi.text.includes('psk="__REDACTED__"') && !expWifi.text.includes("hub-emu-fake-passphrase"),
  expWifi.text.slice(0, 200)
);
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
checkFormPost("POST /wifi JSON validation", wifiJson, "Wi-Fi SSID is required.");
const systemJson = await req(API, "/system", jsonBody({ action: "reboot" }));
check(
  "POST /system with JSON body -> 200 HTML 'Unknown system action.' (non-mutating probe)",
  systemJson.status === 200 && systemJson.text.includes("Unknown system action."),
  systemJson.text.slice(0, 120)
);
checkFormPost("POST /system JSON validation", systemJson, "Unknown system action.");
const getSystem = await req(API, "/system");
check("GET /system -> 404 (the box only has POST /system)", getSystem.status === 404, `got ${getSystem.status}`);
const importJson = await req(API, "/import", jsonBody({ target: "mqtt", payload: "{}" }));
check(
  "POST /import with JSON body -> 200 HTML 'Unknown import target.'",
  importJson.status === 200 && importJson.text.includes("Unknown import target."),
  importJson.text.slice(0, 120)
);
checkFormPost("POST /import JSON validation", importJson, "Unknown import target.");
const wifiAfterJson = await req(API, "/export/wifi");
check("JSON probes mutated nothing (wpa_supplicant.conf still seeded)", wifiAfterJson.text.includes("HUB-EMU-FAKE-SSID"));

console.log("\n== setup pages: form posts mutate settings and answer the form result page ==");
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
checkFormPost("POST /mqtt form", mqttForm, "MQTT settings saved. The bridge will reconnect when it notices the config change.");
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
checkFormPost("POST /wifi form", wifiForm, "Wi-Fi settings saved. Reboot when ready to use them.");
const expWifi2 = await req(API, "/export/wifi");
check(
  "Wi-Fi save persisted to /etc/wpa_supplicant.conf",
  expWifi2.text.includes("HUB-EMU-QA-SSID") && expWifi2.text.includes("key_mgmt=WPA-PSK")
);

console.log("\n== secret exports: redacted while sign-in is off; redacted restore preserves (issue #88) ==");
check(
  "GET /export/wifi redacts the saved PSK",
  expWifi2.text.includes('psk="__REDACTED__"') && !expWifi2.text.includes("hub-emu-qa-passphrase")
);
check(
  "GET /export/mqtt redacts the saved broker password",
  expMqtt2.json?.broker?.password === "__REDACTED__" && !expMqtt2.text.includes("hub-emu-qa-password")
);
const expBundle = await req(API, "/export/bundle");
check(
  "GET /export/bundle redacts both secrets",
  expBundle.status === 200 &&
    expBundle.text.includes("__REDACTED__") &&
    !expBundle.text.includes("hub-emu-qa-passphrase") &&
    !expBundle.text.includes("hub-emu-qa-password"),
  expBundle.text.slice(0, 200)
);
// MD5 oracle: importing the unredacted equivalent and then the redacted
// export must land on identical file bytes — the redacted restore splices
// the on-hub secret back in instead of storing the placeholder.
const secretPaths = ["/etc/wpa_supplicant.conf", "/data/codexmqtt/config.json"];
await req(API, "/import", form({ target: "wifi", payload: expWifi2.text.replace("__REDACTED__", "hub-emu-qa-passphrase") }));
await req(API, "/import", form({ target: "mqtt", payload: expMqtt2.text.replace("__REDACTED__", "hub-emu-qa-password") }));
const md5Unredacted = await req(CTRL, "/step4a/md5", jsonBody({ paths: secretPaths }));
const impWifiRedacted = await req(API, "/import", form({ target: "wifi", payload: expWifi2.text }));
const impMqttRedacted = await req(API, "/import", form({ target: "mqtt", payload: expMqtt2.text }));
const md5Redacted = await req(CTRL, "/step4a/md5", jsonBody({ paths: secretPaths }));
check(
  "restoring redacted wifi+mqtt exports preserves the on-hub secrets byte-for-byte",
  impWifiRedacted.text.includes("Wi-Fi settings imported") &&
    impMqttRedacted.text.includes("MQTT settings imported") &&
    md5Unredacted.json?.exitCode === 0 &&
    md5Redacted.json?.exitCode === 0 &&
    md5Unredacted.json?.stdout === md5Redacted.json?.stdout,
  `unredacted=${md5Unredacted.json?.stdout} redacted=${md5Redacted.json?.stdout}`
);
const wifiControlChar = await req(API, "/wifi", form({ ssid: "HUB-EMU-QA-SSID", password: "bad\npsk=injected", apply: "save" }));
check(
  "POST /wifi rejects a password containing a newline (no wpa_supplicant injection)",
  wifiControlChar.status === 200 && wifiControlChar.text.includes("Wi-Fi password must be"),
  wifiControlChar.text.slice(0, 160)
);
const cloudForm = await req(API, "/system", form({ action: "cloud", cloudBlocker: "on" }));
check(
  "POST /system action=cloud (blocker on) -> 200 HTML 'Cloud blocker enabled'",
  cloudForm.status === 200 && cloudForm.text.includes("Cloud blocker enabled"),
  cloudForm.text.slice(0, 160)
);
checkFormPost("POST /system action=cloud", cloudForm, "Cloud blocker enabled and LAN-only egress applied.");
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
checkFormPost("POST /import target=mqtt", importForm, "MQTT settings imported. The bridge will reconnect when it notices the config change.");
const expMqtt3 = await req(API, "/export/mqtt");
check("import restored the seeded fake MQTT config", expMqtt3.json?.broker?.host === "mqtt.hub-emu.invalid");
const btQaName = "QA <Emu> & Keyboard";
const btDeviceForm = await req(API, "/bt/device", form({ name: btQaName, type: "btkeyboard", bdaddr: "02:00:00:00:00:01" }));
check(
  "POST /bt/device form -> 200 HTML with the escaped exact dynamic message",
  btDeviceForm.status === 200 && btDeviceForm.text.includes("Saved Bluetooth device QA &lt;Emu&gt; &amp; Keyboard."),
  btDeviceForm.text.slice(0, 320)
);
checkFormPost("POST /bt/device form", btDeviceForm, "Saved Bluetooth device QA &lt;Emu&gt; &amp; Keyboard.");
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
checkFormPost("POST /ir/send form", irLegacy, "Sent ");

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
checkFormPost("POST /system action=reboot", rebootForm, "Rebooting now.");
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
checkFormPost("POST /system action=cloud_reboot", cloudRebootForm, "Cloud blocker enabled. Rebooting now.");
const expCloud3 = await req(API, "/export/cloud");
check("cloud_reboot kept the blocker at 1", expCloud3.text.trim() === "1");
const statusAfter2 = await req(CTRL, "/status");
check("second reboot request recorded (rebootCount 2)", statusAfter2.json?.rebootCount === 2, JSON.stringify(statusAfter2.json));

console.log("\n== auth: set, observed, then cleared by reset ==");
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
checkFormPost("POST /system action=auth enable", authForm, "Web UI sign-in enabled.");
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
checkFormPost("POST /system action=auth disable", disableAuthForm, "Web UI sign-in disabled.");
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

console.log("\n== software version; no installs over HTTP ==");
const version = await req(API, "/api/version");
check(
  "GET /api/version -> 200 melodious version, api level and features",
  version.status === 200 && version.json?.ok === true && version.json?.product === "melodious" &&
    /^\d+\.\d+\.\d+$/.test(version.json?.version ?? "") && version.json?.api >= 1 &&
    version.json?.update?.protocol === 0 && version.json?.features?.includes("activity-save"),
  version.text.slice(0, 200),
);
const updateStatus = await req(API, "/api/update-status");
check(
  "GET /api/update-status reports the same version and 9 binaries, read-only",
  updateStatus.status === 200 && updateStatus.json?.version === version.json?.version &&
    JSON.stringify((updateStatus.json?.files ?? []).map((file) => file.name)) === JSON.stringify([
      "codex_webui", "codex_bthid_keyboard", "codex_bt_pair_agent", "codex_androidtv",
      "codex_usbeth", "codex_hal_ltcp", "codex_hbus", "codex_portal", "codex_dhcpd",
    ]) &&
    (updateStatus.json?.files ?? []).every((file) =>
      typeof file.present === "boolean" && Number.isInteger(file.size)) &&
    !("rawBase" in (updateStatus.json ?? {})),
  updateStatus.text.slice(0, 200),
);
/* 1.2.0 and older let any client stage a binary with its own MD5 list and
   install it (no signature, no Origin check). Those routes are gone. */
const hbusEntry = (status) => JSON.stringify(status.json?.files?.find((file) => file.name === "codex_hbus") ?? null);
const hbusBefore = hbusEntry(updateStatus);
const evilHex = Buffer.from("evil").toString("hex");
const evilMd5 = createHash("md5").update("evil").digest("hex");
const removed = [];
for (const [route, body] of [
  ["/api/update-begin", form({ manifest: `${evilMd5}  codex_hbus\n00000000000000000000000000000000  codex_webui\n` })],
  ["/api/update-chunk", form({ file: "codex_hbus", offset: "0", hex: evilHex })],
  ["/api/update-apply", form({ restart: "0" })],
  ["/api/update-check-state", form({ available: "1" })],
]) {
  const r = await req(API, route, { ...body, headers: { ...body.headers, Origin: "http://evil.example" } });
  removed.push(`${route} ${r.status}`);
}
check("unsigned install routes and the update-check record answer 404",
  removed.every((line) => line.endsWith(" 404")), removed.join(" | "));
const checkStateGet = await req(API, "/api/update-check-state");
check("GET /api/update-check-state -> 404", checkStateGet.status === 404, `got ${checkStateGet.status}`);
const hbusAfter = hbusEntry(await req(API, "/api/update-status"));
check("codex_hbus untouched by the attempted install",
  hbusBefore === hbusAfter && !hbusAfter.includes(evilMd5),
  `${hbusBefore} -> ${hbusAfter}`);

// Retired maintenance CLI (issue #186): this section once drove
// `codex_webui --prune-backups` (byte-ceiling retention with a stable
// summary line) and, below, the Step 4A `--storage-status` /
// `--install-plan` / `--install-file` installer CLI. The pinned binary has
// no command-line modes at all (docs/API.md: "The codex_webui binary has
// no command-line modes; it takes an optional port argument and serves"),
// so passing a flag started a listener on port 0 and every such check
// hung until the harness timeout. Retention in the shipped product is
// count-based and happens inside backup creation
// (prune_resource_backups(), settings_* never pruned), which the
// "backup creation retention" section below still exercises end-to-end
// through the real save path. The emulator's /retention/* and /step4a/*
// fixtures remain available for future work but assert nothing here.

const aliveAfterRetention = await req(API, "/api/activity-state");
check(
  "normal real MIPS server still serves existing routes",
  aliveAfterRetention.status === 200 && aliveAfterRetention.json?.ok === true,
  aliveAfterRetention.text.slice(0, 160),
);

const familyOf = (inventory, name) => inventory?.families?.[name] ?? { bytes: 0, count: 0, generations: [] };
const generationNames = (inventory, name) => familyOf(inventory, name).generations.map((entry) => entry.name);
const generationByName = (inventory, family, name) =>
  familyOf(inventory, family).generations.find((entry) => entry.name === name);

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
// Count-based retention (docs/API.md "Backup retention"): backup_resources()
// prunes to 4 before copying and to 5 after, newest-first by name; there is
// no byte reservation in the shipped binary (that was the retired unified
// design, issue #186). With the creation fixture below the ceiling, a save
// adds exactly one generation and deletes none.
check(
  "real backup creation saves and keeps generations within the count ceiling",
  creationSave.status === 200 &&
    creationSave.json?.saved === true &&
    justCreatedNames.length === 1 &&
    creationAfterNames.length <= 5 &&
    creationAfterNames.includes("20260804_220000"),
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

// The copy-failure gate (a failed backup copy answering 503 and blocking
// the save) belonged to the same retired design: shipped backup_resources()
// copies with `cp ... 2>/dev/null` and the save proceeds. No documented
// contract promises the gate, so its three checks are removed here rather
// than re-asserted against the live binary (issue #186).

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

const finalReset = await req(CTRL, "/reset", { method: "POST" });
const expMqttFinal = await req(API, "/export/mqtt");
const expWifiFinal = await req(API, "/export/wifi");
check(
  "reset at the end restores seeded settings",
  finalReset.status === 200 &&
    expMqttFinal.json?.broker?.host === "mqtt.hub-emu.invalid" &&
    expWifiFinal.text.includes("HUB-EMU-FAKE-SSID"),
  expMqttFinal.text.slice(0, 160),
);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
