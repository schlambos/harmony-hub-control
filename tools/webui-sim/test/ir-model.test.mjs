import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  LIMITS,
  DEVICE_TYPES,
  isSafeLabel,
  isSafeRunId,
  clampDelay,
  makeRunId,
  hbusDataIsEmpty,
  captureLooksEmpty,
  analyzeCapture,
  normalizeSignal,
  isNecHex,
  chunkCommands,
  parseIrdbLines,
  decodeEntities,
  harmonyRawFromTimings,
  prontoToHarmonyRaw,
  remoteCentralCommands,
  normalizeRemoteCentralPath,
  describeInventory,
} from "../public/js/views/ir-model.js";

describe("LIMITS", () => {
  it("exposes the hub buffer ceilings (declared size minus one)", () => {
    assert.equal(LIMITS.deviceId, 63);
    assert.equal(LIMITS.command, 127);
    assert.equal(LIMITS.name, 127);
    assert.equal(LIMITS.keycode, 511);
    assert.equal(LIMITS.raw, 2047);
    assert.equal(LIMITS.runId, 96);
    assert.equal(LIMITS.batchCommands, 1024);
    assert.equal(LIMITS.storedCommands, 2048);
    assert.equal(LIMITS.devices, 32);
  });

  it("is frozen", () => {
    assert.ok(Object.isFrozen(LIMITS));
  });
});

describe("DEVICE_TYPES", () => {
  it("lists exactly the five hub-recognized types", () => {
    assert.deepEqual([...DEVICE_TYPES], [
      "Television",
      "Amplifier",
      "Media Player",
      "Game Console",
      "Home Appliance",
    ]);
  });
});

describe("isSafeLabel", () => {
  it("accepts normal printable text within the limit", () => {
    assert.equal(isSafeLabel("Living room TV"), true);
    assert.equal(isSafeLabel("a"), true);
    assert.equal(isSafeLabel("a".repeat(127)), true);
  });

  it("rejects empty, too long, control chars, quote, and backslash", () => {
    assert.equal(isSafeLabel(""), false);
    assert.equal(isSafeLabel("a".repeat(128)), false);
    assert.equal(isSafeLabel("bad\u0001name"), false);
    assert.equal(isSafeLabel("bad\u007fname"), false);
    assert.equal(isSafeLabel('bad"name'), false);
    assert.equal(isSafeLabel("bad\\name"), false);
  });

  it("respects a custom max", () => {
    assert.equal(isSafeLabel("abc", 5), true);
    assert.equal(isSafeLabel("abcdef", 5), false);
  });

  it("coerces null/undefined to empty string", () => {
    assert.equal(isSafeLabel(null), false);
    assert.equal(isSafeLabel(undefined), false);
  });
});

describe("isSafeRunId", () => {
  it("accepts 1..96 chars of [A-Za-z0-9_.-]", () => {
    assert.equal(isSafeRunId("run_1"), true);
    assert.equal(isSafeRunId("a".repeat(96)), true);
    assert.equal(isSafeRunId("dry_abc-123.xyz"), true);
  });

  it("rejects empty, too long, and foreign chars", () => {
    assert.equal(isSafeRunId(""), false);
    assert.equal(isSafeRunId("a".repeat(97)), false);
    assert.equal(isSafeRunId("bad run"), false);
    assert.equal(isSafeRunId("bad/run"), false);
  });
});

describe("clampDelay", () => {
  it("clamps to 40..10000 with a floor fallback", () => {
    assert.equal(clampDelay("120"), 120);
    assert.equal(clampDelay("40"), 40);
    assert.equal(clampDelay("39"), 40);
    assert.equal(clampDelay("1"), 40);
    assert.equal(clampDelay("10000"), 10000);
    assert.equal(clampDelay("99999"), 10000);
  });

  it("falls back to the minimum for non-numeric input", () => {
    assert.equal(clampDelay("abc"), 40);
    assert.equal(clampDelay(""), 40);
    assert.equal(clampDelay(null), 40);
  });
});

describe("makeRunId", () => {
  it("produces a prefixed safe run id", () => {
    const id = makeRunId("dry");
    assert.ok(id.startsWith("dry_"));
    assert.ok(isSafeRunId(id));
  });

  it("uses the default prefix", () => {
    const id = makeRunId();
    assert.ok(id.startsWith("webui_"));
    assert.ok(isSafeRunId(id));
  });
});

describe("hbusDataIsEmpty / captureLooksEmpty", () => {
  it("detects an empty hbus data envelope", () => {
    assert.equal(hbusDataIsEmpty('{"data":{}}'), true);
    assert.equal(hbusDataIsEmpty('{"data":null}'), true);
    assert.equal(hbusDataIsEmpty('{"data":{"x":1}}'), false);
    assert.equal(hbusDataIsEmpty("not json"), false);
  });

  it("captureLooksEmpty matches the shell heuristic", () => {
    assert.equal(captureLooksEmpty(""), true);
    assert.equal(captureLooksEmpty("no payload returned"), true);
    assert.equal(captureLooksEmpty("IR timeout"), true);
    assert.equal(captureLooksEmpty('{"data":{}}'), true);
    assert.equal(captureLooksEmpty("F38000 P100 S200"), false);
  });
});

describe("analyzeCapture", () => {
  it("returns empty=true when nothing usable arrived", () => {
    const r = analyzeCapture({ raw: "", keycode: "", nec: "" });
    assert.equal(r.empty, true);
    assert.equal(r.mode, "");
    assert.equal(r.protocolId, 2);
  });

  it("decodes a keycode capture", () => {
    const r = analyzeCapture({ raw: "", keycode: "G:Toshiba 32 Bit:(0x1)(Repeat)():3", nec: "" });
    assert.equal(r.empty, false);
    assert.equal(r.mode, "keycode");
    assert.equal(r.keycode, "G:Toshiba 32 Bit:(0x1)(Repeat)():3");
  });

  it("decodes a nec capture", () => {
    const r = analyzeCapture({ raw: "", keycode: "", nec: "0x04FB08F7" });
    assert.equal(r.empty, false);
    assert.equal(r.mode, "nec");
    assert.equal(r.nec, "0x04FB08F7");
  });

  it("decodes a raw capture", () => {
    const r = analyzeCapture({ raw: "F38000 P100 S200", keycode: "", nec: "" });
    assert.equal(r.empty, false);
    assert.equal(r.mode, "raw");
    assert.equal(r.raw, "F38000 P100 S200");
  });

  it("defaults protocolId to 2 when missing or invalid", () => {
    assert.equal(analyzeCapture({ raw: "" }).protocolId, 2);
    assert.equal(analyzeCapture({ raw: "", protocolId: "x" }).protocolId, 2);
    assert.equal(analyzeCapture({ raw: "", protocolId: 0 }).protocolId, 2);
    assert.equal(analyzeCapture({ raw: "", protocolId: 5 }).protocolId, 5);
  });
});

describe("normalizeSignal", () => {
  it("defaults mode to auto and protocol to 2", () => {
    const r = normalizeSignal({ mode: "", protocol: "", keycode: "G:Toshiba", nec: "", raw: "" });
    assert.equal(r.mode, "auto");
    assert.equal(r.protocol, "2");
  });

  it("requires a keycode in keycode mode", () => {
    assert.throws(() => normalizeSignal({ mode: "keycode", keycode: "" }), /Harmony compact code is required/);
  });

  it("validates NEC hex in nec mode", () => {
    assert.throws(() => normalizeSignal({ mode: "nec", nec: "xyz" }), /NEC value must be 1-8 hex digits/);
    const r = normalizeSignal({ mode: "nec", nec: "0x04FB08F7" });
    assert.equal(r.nec, "0x04FB08F7");
  });

  it("requires raw data in raw mode", () => {
    assert.throws(() => normalizeSignal({ mode: "raw", raw: "" }), /Raw command data is required/);
  });

  it("requires some signal in auto mode", () => {
    assert.throws(() => normalizeSignal({ mode: "auto", keycode: "", nec: "", raw: "" }), /Learn or enter a signal/);
  });

  it("rejects oversized raw and keycode", () => {
    assert.throws(() => normalizeSignal({ mode: "raw", raw: "x".repeat(2048) }), /longer than 2047/);
    assert.throws(() => normalizeSignal({ mode: "keycode", keycode: "x".repeat(512) }), /longer than 511/);
  });
});

describe("isNecHex", () => {
  it("accepts optional 0x plus 1..8 hex digits", () => {
    assert.equal(isNecHex("04FB08F7"), true);
    assert.equal(isNecHex("0x04FB08F7"), true);
    assert.equal(isNecHex("ABC"), true);
  });

  it("rejects too long, non-hex, and empty", () => {
    assert.equal(isNecHex("04FB08F7AB"), false);
    assert.equal(isNecHex("xyz"), false);
    assert.equal(isNecHex(""), false);
  });
});

describe("chunkCommands", () => {
  it("splits names into chunks under the batch limit", () => {
    const names = ["Power", "VolUp", "VolDown", "Mute", "Menu"];
    const result = chunkCommands(names, 2);
    assert.equal(result.total, 5);
    assert.equal(result.dropped, 0);
    assert.equal(result.chunks.length, 3);
    assert.equal(result.chunks[0], "Power\nVolUp");
    assert.equal(result.chunks[1], "VolDown\nMute");
    assert.equal(result.chunks[2], "Menu");
  });

  it("drops invalid names and counts them", () => {
    const names = ["ok", 'bad"name', "also ok", ""];
    const result = chunkCommands(names, 100);
    assert.equal(result.total, 2);
    assert.equal(result.dropped, 2);
  });

  it("clamps chunk size to the batch limit", () => {
    const result = chunkCommands(["a", "b"], 99999);
    assert.equal(result.chunks.length, 1);
    assert.equal(result.chunks[0], "a\nb");
  });

  it("returns empty chunks for no valid names", () => {
    const result = chunkCommands([], 100);
    assert.equal(result.total, 0);
    assert.equal(result.chunks.length, 0);
  });
});

describe("parseIrdbLines", () => {
  it("parses pipe rows (name|keycode)", () => {
    const { rows, skipped } = parseIrdbLines("Power|G:Toshiba 32\nVolUp|G:Toshiba 33");
    assert.equal(rows.length, 2);
    assert.equal(rows[0].name, "Power");
    assert.equal(rows[0].mode, "keycode");
    assert.equal(rows[0].code, "G:Toshiba 32");
    assert.equal(skipped, 0);
  });

  it("parses three-part pipe rows (name|raw|code)", () => {
    const { rows } = parseIrdbLines("Power|raw|F38000 P100 S200");
    assert.equal(rows[0].mode, "raw");
    assert.equal(rows[0].code, "F38000 P100 S200");
  });

  it("parses IRDB CSV rows (name,protocol,device,subdevice,function)", () => {
    const { rows } = parseIrdbLines("Power,NEC,32,-1,8");
    assert.equal(rows[0].name, "Power");
    assert.equal(rows[0].mode, "irdb");
    assert.equal(rows[0].code, "NEC,32,-1,8");
  });

  it("skips the CSV header and blank lines", () => {
    const { rows, skipped } = parseIrdbLines("FunctionName,Protocol,Device,SubDevice,Function\n\nPower,NEC,32,-1,8");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].name, "Power");
  });

  it("skips invalid names", () => {
    const { rows, skipped } = parseIrdbLines('bad"name|code');
    assert.equal(rows.length, 0);
    assert.equal(skipped, 1);
  });
});

describe("decodeEntities", () => {
  it("decodes named and numeric entities", () => {
    assert.equal(decodeEntities("&amp;&lt;&gt;&quot;"), '&<>"');
    assert.equal(decodeEntities("&#65;"), "A");
    assert.equal(decodeEntities("&#x41;"), "A");
    assert.equal(decodeEntities("&copy;"), "©");
  });

  it("leaves unknown entities intact", () => {
    assert.equal(decodeEntities("&unknown;"), "&unknown;");
  });
});

describe("harmonyRawFromTimings", () => {
  it("builds F<freq> P/S pairs from timings", () => {
    const raw = harmonyRawFromTimings(38000, [100, 200, 100, 200]);
    assert.ok(raw.startsWith("F9470")); // 38000 -> 0x9470
    assert.ok(raw.includes("P64")); // 100 -> 0x64
    assert.ok(raw.includes("SC8")); // 200 -> 0xC8
  });

  it("pads a 3-timing burst with a 100000 tail", () => {
    const raw = harmonyRawFromTimings(38000, [100, 200, 100]);
    assert.ok(raw.length > 0);
  });

  it("returns empty for too few timings", () => {
    assert.equal(harmonyRawFromTimings(38000, [100, 200]), "");
  });

  it("clamps frequency to 10..60 kHz", () => {
    const low = harmonyRawFromTimings(1000, [100, 200, 100, 200]);
    assert.ok(low.startsWith("F2710")); // 10000 -> 0x2710
    const high = harmonyRawFromTimings(99999, [100, 200, 100, 200]);
    assert.ok(high.startsWith("FEA60")); // 60000 -> 0xEA60
  });
});

describe("prontoToHarmonyRaw", () => {
  it("converts a learned (0000) Pronto frame", () => {
    // 0000 006D 0002 0002 + 4 timings — minimal frame that yields 4 timings
    const raw = prontoToHarmonyRaw("0000 006D 0002 0002 0010 0010 0020 0020");
    assert.ok(raw.length > 0);
    assert.ok(raw.startsWith("F"));
  });

  it("returns empty for non-learned (non-0000) frames", () => {
    assert.equal(prontoToHarmonyRaw("0100 006D 0002 0002 0010 0010 0020 0020"), "");
  });

  it("returns empty for too-short input", () => {
    assert.equal(prontoToHarmonyRaw("0000 006D"), "");
    assert.equal(prontoToHarmonyRaw(""), "");
  });
});

describe("remoteCentralCommands", () => {
  it("extracts Pronto hex runs from HTML", () => {
    // The extractor requires at least 10 hex words after the type code.
    const html = "<td>Power</td><td>0000 006D 0004 0004 0010 0010 0020 0020 0030 0030 0040 0040</td>";
    const rows = remoteCentralCommands(html);
    assert.ok(rows.length >= 1);
    assert.ok(rows[0].hex.startsWith("0000"));
  });

  it("returns empty for pages with no Pronto codes", () => {
    assert.deepEqual(remoteCentralCommands("<p>no codes here</p>"), []);
  });
});

describe("normalizeRemoteCentralPath", () => {
  it("normalizes a relative path into /cgi-bin/codes/", () => {
    assert.equal(normalizeRemoteCentralPath("lg/1234"), "/cgi-bin/codes/lg/1234");
  });

  it("keeps an absolute /cgi-bin/codes/ path", () => {
    assert.equal(normalizeRemoteCentralPath("/cgi-bin/codes/lg/1234"), "/cgi-bin/codes/lg/1234");
  });

  it("extracts the path from a remotecentral.com URL", () => {
    assert.equal(
      normalizeRemoteCentralPath("https://www.remotecentral.com/cgi-bin/codes/lg/1234"),
      "/cgi-bin/codes/lg/1234",
    );
  });

  it("returns empty for anchors and query-only strings", () => {
    assert.equal(normalizeRemoteCentralPath("#section"), "");
    assert.equal(normalizeRemoteCentralPath("?q=1"), "");
  });
});

describe("describeInventory", () => {
  it("shapes a populated inventory", () => {
    const inv = describeInventory({
      ok: true,
      deviceCount: 2,
      totalCommandCount: 10,
      devices: [
        {
          id: "1",
          name: "TV",
          manufacturer: "Samsung",
          model: "UN55",
          type: "Television",
          commands: [
            { id: "c1", name: "Power", keycode: "G:1", protocolId: 2, learned: true, raw: false },
          ],
        },
        {
          id: "2",
          name: "Amp",
          commands: [],
        },
      ],
    });
    assert.equal(inv.ok, true);
    assert.equal(inv.deviceCount, 2);
    assert.equal(inv.totalCommandCount, 10);
    assert.equal(inv.devices.length, 2);
    assert.equal(inv.devices[0].commands.length, 1);
    assert.equal(inv.devices[0].commands[0].name, "Power");
    assert.equal(inv.devices[0].commands[0].protocolId, 2);
    assert.equal(inv.devices[0].commands[0].learned, true);
  });

  it("falls back to defaults for missing fields", () => {
    const inv = describeInventory({ ok: false });
    assert.equal(inv.ok, false);
    assert.equal(inv.deviceCount, 0);
    assert.equal(inv.totalCommandCount, 0);
    assert.equal(inv.displayDeviceLimit, LIMITS.devices);
    assert.equal(inv.storageCommandLimit, LIMITS.storedCommands);
    assert.equal(inv.batchCommandLimit, LIMITS.batchCommands);
    assert.deepEqual(inv.devices, []);
  });

  it("coerces device and command fields to safe strings", () => {
    const inv = describeInventory({
      ok: true,
      devices: [{ id: 1, name: null, commands: [{ id: null, name: undefined, keycode: 0 }] }],
    });
    assert.equal(inv.devices[0].id, "1");
    assert.equal(inv.devices[0].name, "");
    assert.equal(inv.devices[0].commands[0].name, "");
    assert.equal(inv.devices[0].commands[0].keycode, "0");
  });
});