import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  BUILTIN_HUB_PROTOCOLS,
  catalogRows,
  hubProtocolNames,
  supportedHubProtocolNames,
  describeCatalogRows,
  isCatalogPackage,
  isValidProtocolRecord,
  missingProtocolsHint,
  packageProtocols,
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

// Issue #243 fixture: all 17 Samsung HW-Q990D KeyCodes (ProtocolId 686, Raw null).
const ISSUE_243_SAMSUNG_PKG = {
  schema_version: "0.2.0",
  resources: {
    global_language_commands: [
      { Name: "BluetoothPairing", KeyCode: "G:Samsung 16 and 20 Bit:()(0x0CF0_1x0B946)():3", ProtocolId: 686, Raw: null },
      { Name: "DirectionDown", KeyCode: "G:Samsung 16 and 20 Bit:()(0x0CF0_1x0AD52)():3", ProtocolId: 686, Raw: null },
      { Name: "DirectionLeft", KeyCode: "G:Samsung 16 and 20 Bit:()(0x0CF0_1x00DF2)():3", ProtocolId: 686, Raw: null },
      { Name: "DirectionRight", KeyCode: "G:Samsung 16 and 20 Bit:()(0x0CF0_1x08D72)():3", ProtocolId: 686, Raw: null },
      { Name: "DirectionUp", KeyCode: "G:Samsung 16 and 20 Bit:()(0x0CF0_1x02DD2)():3", ProtocolId: 686, Raw: null },
      { Name: "Info", KeyCode: "G:Samsung 16 and 20 Bit:()(0x0CF0_1x043BC)():3", ProtocolId: 686, Raw: null },
      { Name: "Mute", KeyCode: "G:Samsung 16 and 20 Bit:()(0x0CF0_1x08E71)():3", ProtocolId: 686, Raw: null },
      { Name: "Pause", KeyCode: "G:Samsung 16 and 20 Bit:()(0x0CF0_1x051AE)():3", ProtocolId: 686, Raw: null },
      { Name: "Play", KeyCode: "G:Samsung 16 and 20 Bit:()(0x0CF0_1x051AE)():3", ProtocolId: 686, Raw: null },
      { Name: "PowerToggle", KeyCode: "G:Samsung 16 and 20 Bit:()(0x0CF0_1x00EF1)():3", ProtocolId: 686, Raw: null },
      { Name: "Select", KeyCode: "G:Samsung 16 and 20 Bit:()(0x0CF0_1x051AE)():3", ProtocolId: 686, Raw: null },
      { Name: "SoundControl", KeyCode: "G:Samsung 16 and 20 Bit:()(0x0CF0_1x0659A)():3", ProtocolId: 686, Raw: null },
      { Name: "SoundMode", KeyCode: "G:Samsung 16 and 20 Bit:()(0x0CF0_1x0DE21)():3", ProtocolId: 686, Raw: null },
      { Name: "Source", KeyCode: "G:Samsung 16 and 20 Bit:()(0x0CF0_1x0AE51)():3", ProtocolId: 686, Raw: null },
      { Name: "VolumeDown", KeyCode: "G:Samsung 16 and 20 Bit:()(0x0CF0_1x01EE1)():3", ProtocolId: 686, Raw: null },
      { Name: "VolumeUp", KeyCode: "G:Samsung 16 and 20 Bit:()(0x0CF0_1x0EE11)():3", ProtocolId: 686, Raw: null },
      { Name: "WakeUp", KeyCode: "G:Samsung 16 and 20 Bit:()(0x0CF0_1x009F6)():3", ProtocolId: 686, Raw: null },
    ],
  },
};

const VALID_BUNDLED_PROTOCOL = {
  __type: "IrProtocol",
  "Id-": 777,
  Name: "Fixture Custom 24 Bit",
  CarrierFrequency: 38000,
  IRSegments: [{ Header: [{ Value: 4000, Type: 1 }], Payload: { NumberOfBits: 24, Encodings: [] }, Trailer: [], TotalLength: 45000, Name: "Fixture Custom 24 Bit" }],
  CodeSegments: [],
  KeyCode: { Start: null, Repeat: [{ SegmentType: 1, SegmentName: "Fixture Custom 24 Bit" }], Finish: null },
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
    assert.deepEqual(result.protocolsToAdd, []);
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

  it("counts KeyCodes as importable when their protocol is validly bundled in resources.protocols", () => {
    const pkgWithBundled = {
      schema_version: "0.2.0",
      resources: {
        global_language_commands: [
          { Name: "PowerOn", KeyCode: "G:Fixture Custom 24 Bit:()(0x123456)():3", ProtocolId: 777 },
          { Name: "UnknownProto", KeyCode: "G:Still Missing:()(0x1)():3", ProtocolId: 888 },
        ],
        protocols: [
          VALID_BUNDLED_PROTOCOL,
          { __type: "HidProtocol", "Id-": 999997, Name: "HID 16 Bit" },
          { __type: "IrProtocol", "Id-": 888, Name: "Still Missing", CarrierFrequency: 0, IRSegments: [], KeyCode: {} },
        ],
      },
    };
    const result = catalogRows(pkgWithBundled, supportedHubProtocolNames({ Protocols: [] }));
    assert.deepEqual(result.rows.map((r) => r.name), ["PowerOn"]);
    assert.deepEqual(result.protocolsUsed, ["Fixture Custom 24 Bit"]);
    assert.deepEqual(result.protocolsToAdd, [VALID_BUNDLED_PROTOCOL]);
    assert.deepEqual(result.missingProtocols, ["Still Missing"]);
    assert.match(describeCatalogRows(result), /adds protocols: Fixture Custom 24 Bit/);

    // Already on hub -> not re-added in protocolsToAdd
    const alreadyOnHub = catalogRows(pkgWithBundled, ["Fixture Custom 24 Bit"]);
    assert.deepEqual(alreadyOnHub.rows.map((r) => r.name), ["PowerOn"]);
    assert.deepEqual(alreadyOnHub.protocolsToAdd, []);
  });

  it("validates bundled protocol records strictly", () => {
    assert.equal(isValidProtocolRecord(VALID_BUNDLED_PROTOCOL), true);
    assert.equal(isValidProtocolRecord({ ...VALID_BUNDLED_PROTOCOL, __type: "HidProtocol" }), false);
    assert.equal(isValidProtocolRecord({ ...VALID_BUNDLED_PROTOCOL, "Id-": 0 }), false);
    assert.equal(isValidProtocolRecord({ ...VALID_BUNDLED_PROTOCOL, Name: "Bad:Name" }), false);
    assert.equal(isValidProtocolRecord({ ...VALID_BUNDLED_PROTOCOL, CarrierFrequency: 500 }), false);
    assert.equal(isValidProtocolRecord({ ...VALID_BUNDLED_PROTOCOL, IRSegments: [], CodeSegments: [] }), false);
    assert.equal(isValidProtocolRecord({ ...VALID_BUNDLED_PROTOCOL, KeyCode: null }), false);
    assert.deepEqual(packageProtocols({ resources: { protocols: [VALID_BUNDLED_PROTOCOL, VALID_BUNDLED_PROTOCOL] } }), [VALID_BUNDLED_PROTOCOL]);
  });

  it("explains missing protocols and gives concrete next steps", () => {
    assert.equal(missingProtocolsHint([]), "");
    const hint = missingProtocolsHint(["RC6 Mode 0"]);
    assert.match(hint, /RC6 Mode 0/);
    assert.match(hint, /original remote/i);
    assert.match(hint, /IRDB/i);
    assert.match(hint, /Flipper/i);
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
  it("includes built-in hub protocols on a fresh hub with an empty ProtocolList, including Samsung 16 and 20 Bit (#243)", () => {
    assert.deepEqual(BUILTIN_HUB_PROTOCOLS, [
      "Toshiba 32 Bit",
      "Sony 15 Bit",
      "Sony 20 Bit",
      "Saitek 11 Bit",
      "MemorexO1 32 Bit",
      "Samsung 16 and 20 Bit",
    ]);
    const freshNames = supportedHubProtocolNames({ Protocols: [] });
    assert.deepEqual(freshNames, [...BUILTIN_HUB_PROTOCOLS]);

    const samsungResult = catalogRows(ISSUE_243_SAMSUNG_PKG, freshNames);
    assert.equal(samsungResult.rows.length, 17);
    assert.equal(samsungResult.skipped.length, 0);
    assert.deepEqual(samsungResult.protocolsUsed, ["Samsung 16 and 20 Bit"]);
    assert.deepEqual(samsungResult.missingProtocols, []);
    assert.deepEqual(samsungResult.protocolsToAdd, []);

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
      supportedHubProtocolNames({ Protocols: [{ Name: "Custom Proto" }, { Name: "Toshiba 32 Bit" }] }),
      [
        "Custom Proto",
        "Toshiba 32 Bit",
        "Sony 15 Bit",
        "Sony 20 Bit",
        "Saitek 11 Bit",
        "MemorexO1 32 Bit",
        "Samsung 16 and 20 Bit",
      ],
    );
    assert.equal(supportedHubProtocolNames(null), null);
    assert.equal(supportedHubProtocolNames({}), null);
  });
});
