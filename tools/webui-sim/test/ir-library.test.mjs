import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  detectFormat,
  parseLibraryText,
  filterLibraryIndex,
  scoreLibraryPath,
  rowsToImportPayload,
  planImport,
  loadLibraryIndex,
  formatSourceErrors,
  keyFromParts,
  resetLibraryCache,
  LIBRARY_SOURCES,
  KNOWN_DEAD_PACKAGE_INDEXES,
} from "../public/js/ir-library.js";
import { LIMITS } from "../public/js/views/ir-model.js";

describe("detectFormat", () => {
  it("detects flipper by header and extension", () => {
    assert.equal(detectFormat("Filetype: IR signals file\n#\nname: Power\n"), "flipper");
    assert.equal(detectFormat("name: Power\n", "tv.ir"), "flipper");
  });

  it("detects IRDB CSV", () => {
    assert.equal(detectFormat("functionname,protocol,device,subdevice,function\nPower,NEC,1,-1,2\n"), "irdb-csv");
    assert.equal(detectFormat("Power,NEC,1,-1,2\n", "codes.csv"), "irdb-csv");
  });

  it("detects pipe rows and pronto", () => {
    assert.equal(detectFormat("Power|keycode|G:Toshiba 32 Bit:(0x1)(Repeat)():3\n"), "pipe");
    assert.equal(
      detectFormat("0000 006D 0022 0002 0157 00AC 0015 0015 0015 0015 0015 0015 0015 0015 0015 0015 0015 0015 0015 0015 0015 0015"),
      "pronto",
    );
  });
});

describe("parseLibraryText", () => {
  it("parses IRDB CSV into supported keycode rows", () => {
    const csv = "functionname,protocol,device,subdevice,function\nPower,NEC,32,-1,8\nVolUp,NEC,32,-1,16\n";
    const parsed = parseLibraryText(csv, { filename: "x.csv" });
    assert.equal(parsed.format, "irdb-csv");
    assert.equal(parsed.supported, 2);
    assert.ok(parsed.rows[0].code.startsWith("G:Toshiba"));
    assert.equal(parsed.rows[0].name, "Power");
  });

  it("parses Flipper NEC entries from a dropped file", () => {
    const ir = [
      "Filetype: IR signals file",
      "Version: 1",
      "#",
      "name: Power",
      "type: parsed",
      "protocol: NEC",
      "address: 20 00 00 00",
      "command: 0A 00 00 00",
      "#",
      "name: RawOnly",
      "type: raw",
      "frequency: 38000",
      "duty_cycle: 0.330000",
      "data: 9000 4500 560 560 560 1690 560 560",
      "",
    ].join("\n");
    const parsed = parseLibraryText(ir, { filename: "remote.ir" });
    assert.equal(parsed.format, "flipper");
    assert.ok(parsed.supported >= 1);
    const power = parsed.rows.find((r) => r.name === "Power");
    assert.ok(power?.supported);
    assert.equal(power.mode, "keycode");
  });

  it("parses pipe rows", () => {
    const parsed = parseLibraryText("Mute|keycode|G:Toshiba 32 Bit:(0xABCDEF01)(Repeat)():3\n");
    assert.ok(parsed.supported >= 1);
    assert.equal(parsed.rows[0].name, "Mute");
  });

  it("never invents supported rows without a code", () => {
    const parsed = parseLibraryText("not a real code file at all");
    for (const r of parsed.rows) {
      if (r.supported) assert.ok(r.code);
    }
  });
});

describe("search scoring", () => {
  it("scores path tokens without requiring exact manufacturer spelling", () => {
    assert.ok(scoreLibraryPath("Samsung/TV/BN59.csv", "samsung tv") > 0);
    assert.ok(scoreLibraryPath("Samsung/TV/BN59.csv", "samung") < 0);
    assert.ok(scoreLibraryPath("LG/Television/OLED.csv", "lg oled") > scoreLibraryPath("Sony/AV/STR.csv", "lg oled"));
  });

  it("returns an informative empty result for nonsense queries", () => {
    const entries = [
      { source: "irdb", path: "Samsung/TV/A.csv" },
      { source: "irdb", path: "LG/TV/B.csv" },
    ];
    const { matches, message } = filterLibraryIndex(entries, "zzzxnotarealbrand999");
    assert.equal(matches.length, 0);
    assert.match(message, /No library files matched/i);
    assert.match(message, /zzzxnotarealbrand999/);
  });

  it("returns ranked matches for real tokens", () => {
    const entries = [
      { source: "irdb", path: "Samsung/TV/RemoteA.csv" },
      { source: "irdb", path: "Sony/AV/Amp.csv" },
    ];
    const { matches, message } = filterLibraryIndex(entries, "Samsung TV");
    assert.ok(matches.length >= 1);
    assert.ok(matches[0].path.toLowerCase().includes("samsung"));
    assert.match(message, /Showing/);
  });

  it("surfaces partial source failures in the search message", () => {
    const entries = [{ source: "irdb", path: "Samsung/TV/A.csv" }];
    const sourceErrors = ["Flipper: HTTP 403"];
    const { matches, message, incomplete } = filterLibraryIndex(entries, "Samsung", {
      sourceErrors,
    });
    assert.equal(matches.length, 1);
    assert.match(incomplete, /Results are incomplete/i);
    assert.match(incomplete, /Flipper: HTTP 403/);
    assert.match(message, /incomplete/i);
    assert.match(message, /Flipper/);
  });
});

describe("loadLibraryIndex partial failure", () => {
  it("returns IRDB entries and names a failing extra source without dropping success", async () => {
    resetLibraryCache();
    const fetchImpl = async (url) => {
      if (String(url).includes("irdb") && String(url).includes("index")) {
        return {
          ok: true,
          async text() {
            return "Samsung/TV/A.csv\nLG/TV/B.csv\n";
          },
        };
      }
      return { ok: false, status: 403, async json() { return { message: "nope" }; }, async text() { return ""; } };
    };
    const result = await loadLibraryIndex({
      sources: ["irdb", "flipper"],
      fetchImpl,
    });
    assert.equal(result.entries.length, 2);
    assert.ok(result.loaded.includes("irdb"));
    assert.ok(result.errors.some((e) => /flipper/i.test(e)));
    assert.match(formatSourceErrors(result.errors), /Results are incomplete/i);
    assert.match(formatSourceErrors(result.errors), /flipper/i);
  });

  it("does not offer Flipper as a LIBRARY_SOURCES browser search target", () => {
    assert.ok(LIBRARY_SOURCES.irdb);
    assert.equal(LIBRARY_SOURCES.flipper, undefined);
    assert.ok(KNOWN_DEAD_PACKAGE_INDEXES.some((d) => /Flipper/i.test(d.repo)));
  });
});

describe("import accounting (found / supported / will import)", () => {
  it("builds hub pipe lines from supported rows only", () => {
    const payload = rowsToImportPayload([
      { name: "Power", mode: "keycode", code: "G:x", supported: true },
      { name: "Skip", mode: "skip", code: "", supported: false },
      { name: "RawBtn", mode: "raw", code: "F94C4P100S200", supported: true },
    ]);
    assert.equal(payload, "Power|keycode|G:x\nRawBtn|raw|F94C4P100S200");
  });

  it("reconciles found, unsupported, and willImport without a mystery gap", () => {
    const rows = [
      { name: "A", mode: "keycode", code: "k1", supported: true },
      { name: "B", mode: "keycode", code: "k2", supported: true },
      { name: "C", mode: "skip", code: "", supported: false },
      { name: 'bad"name', mode: "keycode", code: "k3", supported: true },
      { name: "D", mode: "keycode", code: "k4", supported: true },
    ];
    const plan = planImport(rows, 0);
    assert.equal(plan.found, 5);
    assert.equal(plan.supported, 4);
    assert.equal(plan.unsupported, 1);
    assert.equal(plan.unsafeName, 1);
    assert.equal(plan.importable, 3);
    assert.equal(plan.willImport, 3);
    assert.equal(plan.truncated, 0);
    assert.match(plan.summary, /5 found/);
    assert.match(plan.summary, /4 supported/);
    assert.match(plan.summary, /1 unsupported/);
    assert.match(plan.summary, /3 will import/);
    const payload = rowsToImportPayload(rows, { max: plan.willImport });
    assert.equal(payload.split("\n").filter(Boolean).length, plan.willImport);
  });

  it("attributes truncation to hub room/batch caps, not a silent 40", () => {
    const rows = Array.from({ length: 45 }, (_, i) => ({
      name: `Cmd${i}`,
      mode: "keycode",
      code: `k${i}`,
      supported: true,
    }));
    const full = planImport(rows, 0);
    assert.equal(full.found, 45);
    assert.equal(full.supported, 45);
    assert.equal(full.willImport, 45);
    assert.equal(full.truncated, 0);
    const tightRoom = planImport(rows, LIMITS.storedCommands - 10);
    assert.equal(tightRoom.willImport, 10);
    assert.equal(tightRoom.truncated, 35);
    assert.match(tightRoom.summary, /10 will import/);
    assert.match(tightRoom.summary, /35 held back/);
  });

  it("keyFromParts builds NEC keycodes", () => {
    const k = keyFromParts("NEC", 32, -1, 8);
    assert.match(k, /^G:Toshiba 32 Bit:\(0x[0-9A-F]+\)\(Repeat\)\(\):3$/);
  });
});

describe("cache reset", () => {
  it("resetLibraryCache is callable", () => {
    resetLibraryCache();
  });
});
