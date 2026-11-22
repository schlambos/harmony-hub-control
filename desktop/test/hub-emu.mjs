// Opt-in local integration test. Hard-pinned to the hub-emu container and
// loopback API; never accepts a real hub address or sends IR.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { catalogRows, supportedHubProtocolNames } from "../../tools/webui-sim/public/js/logitech-catalog.js";

const require = createRequire(import.meta.url);
const { createSchemeHandler } = require("../src/scheme.js");
assert.equal(execFileSync("docker", ["inspect", "hub-emu", "--format", "{{.Config.Image}}"], { encoding: "utf8" }).trim(), "hub-emu");
// Start from a genuinely blank ProtocolList.json (offline/fresh hub) to prove
// built-in protocols (Sony 15/20 Bit, Samsung 16 and 20 Bit) and validly
// bundled protocols are appended on import without manual seeding.
execFileSync("docker", ["exec", "hub-emu", "python3", "-c", `
import json
p='/data/resources/ProtocolList.json'
open(p,'w').write(json.dumps({'Protocols':[]},separators=(',',':')))
`]);
const handler = createSchemeHandler({
  shellDir: fileURLToPath(new URL("../build/shell/", import.meta.url)),
  getHub: () => ({ host: "127.0.0.1", port: 8788 }),
});
const request = async (path, body) => {
  const response = await handler.handle(new Request(`melodious://app${path}`, body === undefined ? {} : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }));
  return { status: response.status, body: JSON.parse(await response.text()) };
};
const lab = await request("/api/ir-lab-target", {});
assert.equal(lab.body.ok, true, JSON.stringify(lab));
const wire = JSON.parse(readFileSync(new URL("fixtures/catalog-fixtures.json", import.meta.url)));
const commands = wire.getGlobalLanguageCommands.GetGlobalLanguageCommandsResult;
const blankProtocolList = (await request("/export/protocols")).body;
assert.deepEqual(blankProtocolList.Protocols, []);
const supportedNames = supportedHubProtocolNames(blankProtocolList);
const plan = catalogRows({ resources: { global_language_commands: commands } }, supportedNames);
assert.equal(plan.rows.length, 4);
const imported = await request("/api/catalog-import", { deviceId: lab.body.deviceId, commands: plan.rows });
assert.equal(imported.status, 200, JSON.stringify(imported));
assert.match(imported.body.message, /Imported: 4/);
const stored = (await request("/export/devices")).body.DevicesWithFeatures.find((e) => String(e.Device["Id-"]) === String(lab.body.deviceId)).Commands;
for (const expected of commands.slice(0, 4)) {
  const actual = stored.find((c) => c.Name === expected.Name);
  assert.equal(actual.KeyCode, expected.KeyCode);
  assert.equal(actual.ProtocolId, expected.ProtocolId);
}
// Issue #243: Samsung 16 and 20 Bit KeyCode imports on a fresh hub and appends record 686.
const samsungImport = await request("/api/catalog-import", {
  deviceId: lab.body.deviceId,
  commands: [{ name: "SamsungPower", keycode: "G:Samsung 16 and 20 Bit:()(0x0CF0_1x00EF1)():3", raw: "" }],
});
assert.equal(samsungImport.status, 200, JSON.stringify(samsungImport));
assert.match(samsungImport.body.message, /Imported: 1/);

// Bundled non-built-in protocol is validated and appended (append-only, never replacing existing ids).
const customProto = {
  __type: "IrProtocol",
  "Id-": 777,
  Name: "Fixture Custom 24 Bit",
  CarrierFrequency: 38000,
  IRSegments: [{ Header: [{ Value: 4000, Type: 1 }], Payload: { NumberOfBits: 24, Encodings: [] }, Trailer: [], TotalLength: 45000, Name: "Fixture Custom 24 Bit" }],
  CodeSegments: [],
  KeyCode: { Start: null, Repeat: [{ SegmentType: 1, SegmentName: "Fixture Custom 24 Bit" }], Finish: null },
};
const bundledImport = await request("/api/catalog-import", {
  deviceId: lab.body.deviceId,
  commands: [{ name: "CustomCmd", keycode: "G:Fixture Custom 24 Bit:()(0x123456)():3", raw: "" }],
  protocols: [customProto],
});
assert.equal(bundledImport.status, 200, JSON.stringify(bundledImport));
assert.match(bundledImport.body.message, /Imported: 1/);

// Attempting to overwrite an existing protocol id (686 or 777) or pass a malformed protocol is refused.
const collideImport = await request("/api/catalog-import", {
  deviceId: lab.body.deviceId,
  commands: [{ name: "HijackCmd", keycode: "G:Hijack Proto:()(0x1)():3", raw: "" }],
  protocols: [{ ...customProto, "Id-": 777, Name: "Hijack Proto" }],
});
assert.equal(collideImport.status, 400);
assert.match(collideImport.body.message, /Rejected: 1/);

const afterProtocols = (await request("/export/protocols")).body.Protocols;
assert.ok(afterProtocols.some((p) => p["Id-"] === 17 && p.Name === "Sony 15 Bit"));
assert.ok(afterProtocols.some((p) => p["Id-"] === 18 && p.Name === "Sony 20 Bit"));
assert.ok(afterProtocols.some((p) => p["Id-"] === 686 && p.Name === "Samsung 16 and 20 Bit"));
assert.ok(afterProtocols.some((p) => p["Id-"] === 777 && p.Name === "Fixture Custom 24 Bit"));
assert.equal(afterProtocols.filter((p) => p["Id-"] === 777).length, 1);

const refused = await request("/api/catalog-import", { deviceId: lab.body.deviceId, commands: [{ name: "UnsupportedFixture", keycode: commands[4].KeyCode, raw: "" }] });
assert.equal(refused.status, 400);
assert.match(refused.body.message, /Rejected: 1/);
console.log("hub-emu: blank ProtocolList -> built-ins (17/18/686) + bundled (777) appended; overwrite/missing refused: OK");
