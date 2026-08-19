import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  BT_TYPES,
  QUICK_KEYS,
  btTypeLabel,
  isAllowedBtType,
  isValidBtAddr,
  normalizeBtAddr,
  isValidBtPin,
  isValidBtName,
  isValidStoreId,
  isValidLabel,
  isValidScript,
  clampScanTimeout,
  clampGapMs,
  parseBtInventory,
  normalizeBtCall,
  parseTextStatus,
} from "../public/js/views/bluetooth-model.js";

describe("isValidBtAddr", () => {
  it("accepts a canonical MAC", () => {
    assert.equal(isValidBtAddr("AA:BB:CC:DD:EE:FF"), true);
    assert.equal(isValidBtAddr("00:1a:7d:da:71:13"), true);
  });
  it("rejects wrong length, separators, and non-hex", () => {
    assert.equal(isValidBtAddr("AABBCCDDEEFF"), false);
    assert.equal(isValidBtAddr("AA-BB-CC-DD-EE-FF"), false);
    assert.equal(isValidBtAddr("AA:BB:CC:DD:EE:FG"), false);
    assert.equal(isValidBtAddr(""), false);
    assert.equal(isValidBtAddr("AA:BB:CC:DD:EE:F"), false);
    assert.equal(isValidBtAddr(null), false);
  });
});

describe("normalizeBtAddr", () => {
  it("trims and upper-cases", () => {
    assert.equal(normalizeBtAddr("  aa:bb:cc:dd:ee:ff "), "AA:BB:CC:DD:EE:FF");
    assert.equal(normalizeBtAddr(undefined), "");
  });
});

describe("isValidBtPin", () => {
  it("allows empty and up to 16 digits", () => {
    assert.equal(isValidBtPin(""), true);
    assert.equal(isValidBtPin("0000"), true);
    assert.equal(isValidBtPin("1234567890123456"), true);
  });
  it("rejects non-digits and over 16 chars", () => {
    assert.equal(isValidBtPin("12a4"), false);
    assert.equal(isValidBtPin("12345678901234567"), false);
  });
});

describe("isValidBtName", () => {
  it("accepts 1..48 of letters, digits, space, . _ -", () => {
    assert.equal(isValidBtName("Harmony Keyboard"), true);
    assert.equal(isValidBtName("Hub-2.1_x"), true);
    assert.equal(isValidBtName("a".repeat(48)), true);
  });
  it("rejects empty, >48, and punctuation", () => {
    assert.equal(isValidBtName(""), false);
    assert.equal(isValidBtName("a".repeat(49)), false);
    assert.equal(isValidBtName("bad/name"), false);
    assert.equal(isValidBtName("bad;name"), false);
  });
});

describe("isAllowedBtType / BT_TYPES", () => {
  it("accepts exactly the five hub profiles", () => {
    for (const t of ["fire", "btkeyboard", "btkeyboard-nexus", "ps3", "wii"]) {
      assert.equal(isAllowedBtType(t), true);
    }
    assert.equal(isAllowedBtType("mouse"), false);
    assert.equal(isAllowedBtType(""), false);
  });
  it("labels every type and resolves unknown to itself", () => {
    for (const t of BT_TYPES) assert.ok(btTypeLabel(t.value).length > 0);
    assert.equal(btTypeLabel("mystery"), "mystery");
  });
});

describe("isValidStoreId", () => {
  it("accepts 1..36 of [A-Za-z0-9_-]", () => {
    assert.equal(isValidStoreId("bt_123_4"), true);
    assert.equal(isValidStoreId("a".repeat(36)), true);
  });
  it("rejects empty, >36, and symbols", () => {
    assert.equal(isValidStoreId(""), false);
    assert.equal(isValidStoreId("a".repeat(37)), false);
    assert.equal(isValidStoreId("bad id"), false);
    assert.equal(isValidStoreId("bad/id"), false);
  });
});

describe("isValidLabel", () => {
  it("accepts normal names", () => {
    assert.equal(isValidLabel("Living room TV"), true);
    assert.equal(isValidLabel("Power On"), true);
  });
  it("rejects empty, control chars, quote, backslash", () => {
    assert.equal(isValidLabel(""), false);
    assert.equal(isValidLabel("bad\u0001name"), false);
    assert.equal(isValidLabel("bad\u007fname"), false);
    assert.equal(isValidLabel('bad"name'), false);
    assert.equal(isValidLabel("bad\\name"), false);
  });
});

describe("isValidScript", () => {
  it("accepts printable text with newline/tab/CR", () => {
    assert.equal(isValidScript("TEXT hello\nWAIT 300\nKEY enter"), true);
    assert.equal(isValidScript("a\tb\rc"), true);
  });
  it("rejects empty, >=2048, and stray control chars", () => {
    assert.equal(isValidScript(""), false);
    assert.equal(isValidScript("a".repeat(2048)), false);
    assert.equal(isValidScript("a".repeat(2047)), true);
    assert.equal(isValidScript("bad\u0000script"), false);
    assert.equal(isValidScript("bad\u007fscript"), false);
  });
});

describe("clampScanTimeout", () => {
  it("clamps to 1..20 with default 2", () => {
    assert.equal(clampScanTimeout("8"), 8);
    assert.equal(clampScanTimeout("0"), 1);
    assert.equal(clampScanTimeout("-3"), 1);
    assert.equal(clampScanTimeout("99"), 20);
    assert.equal(clampScanTimeout("abc"), 2);
    assert.equal(clampScanTimeout(""), 2);
  });
});

describe("clampGapMs", () => {
  it("resets below 15 to the default 35 and caps at 5000 (matches hub)", () => {
    assert.equal(clampGapMs("35"), 35);
    assert.equal(clampGapMs("15"), 15);
    assert.equal(clampGapMs("1"), 35);
    assert.equal(clampGapMs("-5"), 35);
    assert.equal(clampGapMs("5000"), 5000);
    assert.equal(clampGapMs("99999"), 5000);
    assert.equal(clampGapMs("nope"), 35);
  });
});

describe("parseBtInventory", () => {
  it("normalizes a populated store", () => {
    const text = JSON.stringify({
      version: 1,
      devices: [
        {
          id: "bt_1_2",
          name: "Shield",
          type: "btkeyboard",
          bdaddr: "AA:BB:CC:DD:EE:FF",
          commands: [
            { name: "Open YT", delayMs: 40, script: "TEXT youtube\nKEY enter" },
            { name: "bad", delayMs: 5, script: "" },
          ],
        },
      ],
    });
    const inv = parseBtInventory(text);
    assert.equal(inv.length, 1);
    assert.equal(inv[0].id, "bt_1_2");
    assert.equal(inv[0].commands.length, 1);
    assert.equal(inv[0].commands[0].name, "Open YT");
    assert.equal(inv[0].commands[0].delayMs, 40);
  });

  it("returns [] for the seeded-empty store and for garbage", () => {
    assert.deepEqual(parseBtInventory('{"version":1,"devices":[]}'), []);
    assert.deepEqual(parseBtInventory("not json"), []);
    assert.deepEqual(parseBtInventory(""), []);
  });

  it("clamps delayMs and drops entries missing id/name", () => {
    const text = JSON.stringify({
      devices: [
        { id: "x", name: "ok", commands: [{ name: "c", delayMs: 1, script: "KEY a" }] },
        { id: "", name: "no-id" },
        { id: "y", name: "" },
      ],
    });
    const inv = parseBtInventory(text);
    assert.equal(inv.length, 1);
    assert.equal(inv[0].commands[0].delayMs, 35);
  });
});

describe("normalizeBtCall", () => {
  it("reads responseRaw from the real hub", () => {
    const r = normalizeBtCall({ ok: true, action: "status", connected: true, detectedAddress: "AA:BB:CC:DD:EE:FF", responseRaw: "Connections: ..." });
    assert.equal(r.connected, true);
    assert.equal(r.detectedAddress, "AA:BB:CC:DD:EE:FF");
    assert.equal(r.raw, "Connections: ...");
  });
  it("falls back to the sim stub's reply field", () => {
    const r = normalizeBtCall({ ok: true, action: "scan", reply: "sim stub: no bluetooth hardware" });
    assert.equal(r.connected, false);
    assert.equal(r.raw, "sim stub: no bluetooth hardware");
  });
  it("treats connected strictly and defaults missing fields", () => {
    const r = normalizeBtCall({ connected: "true" });
    assert.equal(r.connected, false);
    assert.equal(r.raw, "");
    assert.equal(r.nativeCode, null);
    assert.deepEqual(normalizeBtCall(null), { action: "", cmd: "", connected: false, detectedAddress: "", nativeCode: null, error: "", raw: "" });
  });
  it("captures nativeCode when present", () => {
    assert.equal(normalizeBtCall({ nativeCode: 200 }).nativeCode, 200);
  });
});

describe("parseTextStatus", () => {
  it("marks live only for a running runtime in listening state", () => {
    const live = parseTextStatus({ runtime: true, state: "listening", target: "AA:BB:CC:DD:EE:FF", sent: 5, skipped: 1 });
    assert.equal(live.runtime, true);
    assert.equal(live.live, true);
    assert.equal(live.sent, 5);
    assert.equal(live.target, "AA:BB:CC:DD:EE:FF");
    assert.equal(parseTextStatus({ runtime: true, state: "no_target" }).live, false);
    assert.equal(parseTextStatus({ runtime: false, state: "listening" }).live, false);
  });
  it("reads the sim/missing shapes honestly", () => {
    const sim = parseTextStatus({ ok: true, state: "sim", detail: "SIMULATED HUB — no Bluetooth FIFO runtime", sent: 0, skipped: 0 });
    assert.equal(sim.runtime, false);
    assert.equal(sim.live, false);
    assert.equal(sim.state, "sim");
    assert.ok(sim.error.includes("SIMULATED HUB"));
    const missing = parseTextStatus({ ok: true, runtime: false, state: "missing", error: "Bluetooth FIFO runtime is not running" });
    assert.equal(missing.live, false);
    assert.ok(missing.error.includes("not running"));
  });
});

describe("QUICK_KEYS", () => {
  it("uses only hub-recognized key codes", () => {
    const known = new Set([
      "directionup", "directiondown", "directionleft", "directionright",
      "enter", "escape", "menu", "home", "backspace", "space", "tab", "delete",
      "pageup", "pagedown", "insert", "end",
      "number1", "number2", "number3", "number4", "number5",
      "number6", "number7", "number8", "number9", "number0",
      "ctrll", "alttab", "altf4", "ctrlaltdelete",
    ]);
    for (const k of QUICK_KEYS) {
      assert.ok(known.has(k.code), `unexpected key code: ${k.code}`);
      assert.ok(k.label.length > 0);
    }
  });
});
