import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  BUILTIN_HUB_PROTOCOLS,
  catalogRows,
  hubProtocolNames,
  supportedHubProtocolNames,
  describeCatalogRows,
  isCatalogPackage,
} from "../public/js/logitech-catalog.js";

const PKG = {
  schema_version: "0.2.0",
  resources: {
    global_language_commands: [
      { Name: "PowerOn", KeyCode: "G:Sony 15 Bit:()(0x3A0C)():3", ProtocolId: 17 },
      { Name: "PowerOff", KeyCode: "G:Sony 15 Bit:()(0x7A0C)():3", ProtocolId: 17 },
      { Name: "VolumeUp", KeyCode: "G:Sony 15 Bit:()(0x240C)():3", ProtocolId: 17 },
      { Name: "SmartKey", KeyCode: "G:RC6 Mode 0:()(0x1)():0", ProtocolId: 999 },
      { Name: "LearnedRaw", KeyCode: "", Raw: "F38000P500S500" },
      { Name: "Broken", KeyCode: "", Raw: "" },
      { Name: "", KeyCode: "G:Sony 15 Bit:()(0x1)():3", ProtocolId: 17 },
    ],
  },
};

it("isCatalogPackage accepts only 0.2.0 packages with a commands array", () => {
  assert.equal(isCatalogPackage(PKG), true);
  assert.equal(isCatalogPackage({ schema_version: "0.2.0", resources: { global_language_commands: [] } }), true);
  for (const bad of [null, [], {}, "0.2.0", { ...PKG, schema_version: "1.0" }, { schema_version: "0.2.0", resources: { global_language_commands: {} } }]) assert.equal(isCatalogPackage(bad), false);
});

describe("catalogRows", () => {
  it("imports only KeyCodes whose protocol is on the hub", () => {
    const result = catalogRows(PKG, ["Sony 15 Bit", "Toshiba 32 Bit"]);
    assert.deepEqual(result.rows.map((r) => r.name), ["PowerOn", "PowerOff", "VolumeUp", "LearnedRaw"]);
    assert.deepEqual(result.protocolsUsed, ["Sony 15 Bit"]);
    assert.deepEqual(result.missingProtocols, ["RC6 Mode 0"]);
    assert.equal(result.skipped.length, 3);
    assert.match(result.skipped[0].reason, /RC6 Mode 0/);
  });

  it("refuses every KeyCode when no protocol list is known", () => {
    const result = catalogRows(PKG, []);
    assert.deepEqual(result.rows.map((r) => r.name), ["LearnedRaw"]);
    assert.deepEqual(result.missingProtocols.sort(), ["RC6 Mode 0", "Sony 15 Bit"]);
  });

  it("handles a package without commands", () => {
    const result = catalogRows({ resources: {} }, ["Sony 15 Bit"]);
    assert.equal(result.rows.length, 0);
    assert.equal(result.skipped.length, 0);
  });

  it("summarises importable, skipped and missing protocols", () => {
    const text = describeCatalogRows(catalogRows(PKG, ["Sony 15 Bit"]));
    assert.match(text, /4 importable/);
    assert.match(text, /Sony 15 Bit/);
    assert.match(text, /missing on hub: RC6 Mode 0/);
  });
});

describe("hubProtocolNames", () => {
  it("reads names out of a ProtocolList export", () => {
    assert.deepEqual(
      hubProtocolNames({ Protocols: [{ Name: "Sony 15 Bit" }, { Name: "Toshiba 32 Bit" }, {}] }),
      ["Sony 15 Bit", "Toshiba 32 Bit"],
    );
    assert.deepEqual(hubProtocolNames(null), []);
  });
});

describe("supportedHubProtocolNames", () => {
  it("includes built-in hub protocols on a fresh hub with an empty ProtocolList", () => {
    assert.deepEqual(BUILTIN_HUB_PROTOCOLS, ["Toshiba 32 Bit", "MemorexO1 32 Bit"]);
    const freshNames = supportedHubProtocolNames({ Protocols: [] });
    assert.deepEqual(freshNames, ["Toshiba 32 Bit", "MemorexO1 32 Bit"]);

    const lgPkg = {
      schema_version: "0.2.0",
      resources: {
        global_language_commands: [
          { Name: "PowerToggle", KeyCode: "G:Toshiba 32 Bit:(0x20DF10EF)(Repeat)():3", ProtocolId: 2 },
          { Name: "VolumeUp", KeyCode: "G:Toshiba 32 Bit:(0x20DF40BF)(Repeat)():3", ProtocolId: 2 },
          { Name: "Unsupported", KeyCode: "G:RC6 Mode 0:()(0x1)():0", ProtocolId: 999 },
        ],
      },
    };
    const result = catalogRows(lgPkg, freshNames);
    assert.deepEqual(result.rows.map((r) => r.name), ["PowerToggle", "VolumeUp"]);
    assert.deepEqual(result.protocolsUsed, ["Toshiba 32 Bit"]);
    assert.deepEqual(result.missingProtocols, ["RC6 Mode 0"]);
  });

  it("merges ProtocolList entries with built-in protocols without duplicates and returns null on invalid input", () => {
    assert.deepEqual(
      supportedHubProtocolNames({ Protocols: [{ Name: "Sony 15 Bit" }, { Name: "Toshiba 32 Bit" }] }),
      ["Sony 15 Bit", "Toshiba 32 Bit", "MemorexO1 32 Bit"],
    );
    assert.equal(supportedHubProtocolNames(null), null);
    assert.equal(supportedHubProtocolNames({}), null);
  });
});
