#!/usr/bin/env node
// hub-emu seed generator — splits the genuine-shape webui-sim fixture into the
// individual resource files the real codex_webui binary reads from
// /data/resources/. Run from anywhere; paths are resolved from this file.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, "..", "webui-sim", "fixtures", "activity-config.json");
const OUT_DIR = path.join(HERE, "seed", "resources");

const fixture = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));

const activityList = fixture.activityList ?? { Activities: [] };
const mapList = fixture.mapList ?? { ButtonMaps: [] };
// The fixture has no functionList key; the hub requires a FunctionMaps file.
const functionList = fixture.functionList ?? { FunctionMaps: [] };
const deviceList = fixture.deviceList ?? { DevicesWithFeatures: [] };

if (!Array.isArray(activityList.Activities)) throw new Error("fixture activityList.Activities missing");
if (!Array.isArray(mapList.ButtonMaps)) throw new Error("fixture mapList.ButtonMaps missing");
if (!Array.isArray(deviceList.DevicesWithFeatures)) throw new Error("fixture deviceList.DevicesWithFeatures missing");

fs.mkdirSync(OUT_DIR, { recursive: true });

const files = {
  "ActivityList.json": activityList,
  "MapList.json": mapList,
  "FunctionList.json": functionList,
  "DeviceList.json": deviceList,
  // Minimal-but-valid shapes; the real binary appends builtin protocols on
  // demand (repair_known_protocols_for_current_commands) exactly like the box.
  "ProtocolList.json": { Protocols: [] },
  "AutomationConfig.json": {},
};

for (const [name, value] of Object.entries(files)) {
  const target = path.join(OUT_DIR, name);
  fs.writeFileSync(target, `${JSON.stringify(value)}\n`);
  console.log(`seed: ${name} ${fs.statSync(target).size} bytes`);
}
console.log(`seed written to ${OUT_DIR}`);
