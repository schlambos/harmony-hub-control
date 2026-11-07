#!/usr/bin/env node
// Put Home Assistant devices on the hub through POST /api/ha-devices, and
// listen for the webhook calls their commands make.
//
// The hub's offline writer (codexactivity CommitHaDevices) owns every device
// whose AutoDetectedDevice.Id starts with "melodious-ha-". It saves DeviceList
// and ProtocolList with new etags, reloads the engine and publishes a new
// revision, so the Harmony Touch pulls the change on its own. A set replaces
// all of those devices; an empty set removes them and their protocol.
//
// Only apply and revert write to the hub. plan asks the hub for a dry run.

import fs from "node:fs";
import http from "node:http";

function usage(message) {
  if (message) console.error(`error: ${message}\n`);
  console.error(`Usage:
  node tools/ha_devices.mjs status --hub http://HUB:8080
  node tools/ha_devices.mjs plan   --hub ... (--set FILE | --webhook URL [--entity ID] [--name NAME])
  node tools/ha_devices.mjs apply  --hub ... (same as plan)
  node tools/ha_devices.mjs revert --hub ...
  node tools/ha_devices.mjs send   --hub ... --entity ID --command NAME
  (--entity matches the device key: the entity ID for v1, the key for v2)
  node tools/ha_devices.mjs listen [--port 8770]

Without --set, the set is one test device for --entity (default
light.melodious_test) with PowerOn, PowerOff and two inputs.
revert removes every Home Assistant device; the hub refuses while an
activity, button or sequence still uses one.`);
  process.exit(message ? 2 : 0);
}

function parseArgs(argv) {
  const options = {
    mode: argv[0] || "",
    hub: "",
    set: "",
    webhook: "",
    entity: "light.melodious_test",
    name: "HA test",
    command: "PowerOn",
    port: 8770
  };
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => argv[++index] || usage(`${arg} needs a value`);
    if (arg === "--help") usage();
    else if (arg === "--hub") options.hub = value().replace(/\/+$/, "");
    else if (arg === "--set") options.set = value();
    else if (arg === "--webhook") options.webhook = value();
    else if (arg === "--entity") options.entity = value();
    else if (arg === "--name") options.name = value();
    else if (arg === "--command") options.command = value();
    else if (arg === "--port") options.port = Number(value());
    else usage(`unknown option ${arg}`);
  }
  if (!["status", "plan", "apply", "revert", "send", "listen"].includes(options.mode)) usage("pick a mode");
  if (options.mode !== "listen" && !options.hub) usage("--hub is required");
  if ((options.mode === "plan" || options.mode === "apply") && !options.set && !options.webhook) {
    usage("plan and apply need --set or --webhook");
  }
  return options;
}

// The gate's test device: discrete power and two inputs, so it can sit in an
// activity and show each kind of command arriving.
function testSet(options) {
  return {
    webhook: options.webhook,
    devices: [{
      entity: options.entity,
      name: options.name,
      commands: [
        { name: "PowerOn", value: "turn_on" },
        { name: "PowerOff", value: "turn_off" },
        { name: "InputA", value: "select_source:A" },
        { name: "InputB", value: "select_source:B" },
        { name: "VolumeUp", value: "volume_up" }
      ],
      power: { on: "PowerOn", off: "PowerOff" },
      inputs: [
        { name: "Input A", command: "InputA" },
        { name: "Input B", command: "InputB" }
      ]
    }]
  };
}

function readSet(options) {
  return options.set ? JSON.parse(fs.readFileSync(options.set, "utf8")) : testSet(options);
}

// fetch sends a string body with Content-Length; codex_webui ignores chunked bodies.
async function postSet(hub, set) {
  const response = await fetch(hub + "/api/ha-devices", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(set)
  });
  const text = await response.text();
  console.log(`HTTP ${response.status}`);
  try {
    console.log(JSON.stringify(JSON.parse(text), null, 2));
  } catch {
    console.log(text);
  }
  if (!response.ok) process.exitCode = 1;
}

async function haDevices(hub) {
  const response = await fetch(hub + "/api/activity-config");
  if (!response.ok) throw new Error(`/api/activity-config: HTTP ${response.status}`);
  const config = await response.json();
  return config.deviceList.DevicesWithFeatures.filter((entry) =>
    String(entry.Device?.AutoDetectedDevice?.Id || "").startsWith("melodious-ha-"));
}

function entityOf(entry) {
  return (entry.Device.Tokens?.Parameters || []).find((token) => token.Key === "{d}")?.Value;
}

async function status(options) {
  const devices = await haDevices(options.hub);
  if (!devices.length) console.log("no Home Assistant devices on the hub");
  for (const entry of devices) {
    const commands = entry.Commands.map((command) =>
      `${command.Name}=${command.Parameters?.[0]?.Value}`).join(", ");
    console.log(`${entry.Device["Id-"]}  ${entry.Device.Name}  ${entityOf(entry)}\n  ${commands}`);
  }
}

async function send(options) {
  const entry = (await haDevices(options.hub)).find((item) => entityOf(item) === options.entity);
  if (!entry) throw new Error(`no Home Assistant device for ${options.entity}`);
  const body = new URLSearchParams({ deviceId: String(entry.Device["Id-"]), command: options.command });
  const response = await fetch(options.hub + "/api/ir-send", { method: "POST", body });
  console.log(`ir-send ${options.command}: HTTP ${response.status}`, await response.text());
}

// Answers 200 to everything: a 404 or no answer makes the hub's engine
// rescan the network inside its IP command task.
function listen(options) {
  http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      console.log(`${new Date().toISOString()} ${request.socket.remoteAddress} ${request.method} ${request.url}`);
      console.log(`  headers ${JSON.stringify(request.headers)}`);
      console.log(`  body    ${body}`);
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end("{}");
    });
  }).listen(options.port, "0.0.0.0", () => {
    console.log(`listening on 0.0.0.0:${options.port}; leave this running and send from the hub`);
  });
}

const options = parseArgs(process.argv.slice(2));
const run = {
  status: () => status(options),
  plan: () => postSet(options.hub, { ...readSet(options), dryRun: true }),
  apply: () => postSet(options.hub, readSet(options)),
  revert: () => postSet(options.hub, { devices: [] }),
  send: () => send(options),
  listen: () => listen(options)
}[options.mode];
Promise.resolve(run()).catch((error) => {
  console.error(`error: ${error.message}`);
  process.exit(1);
});
