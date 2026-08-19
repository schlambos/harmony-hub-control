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
  fetchLibraryFile,
  irdbFileUrl,
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

/* Paths that really appear in the IRDB index shape: relative, .csv, and made of
   the punctuation manufacturers actually use in folder names. */
const SAFE_IRDB_PATHS = [
  "A.csv",
  "Samsung/TV/BN59-01178W.csv",
  "LG/Television/OLED.csv",
  "Sony/AV/STR_DE998.csv",
  "3M/Projector/X30.csv",
  "_misc/Unsorted/A.csv",
  "Yamaha/RX-V (2015)/main.csv",
  "Denon/AVR/Remote+Codes.csv",
  "Onkyo/TX-NR/Zone 2, Main.csv",
  "Philips/TV/O'Brien & Sons!.csv",
];

/* Live IRDB rows: the "unknown remote" sentinel filename leads with a dash.
   A dash carries no traversal meaning, so these are real code files. */
const SENTINEL_IRDB_PATHS = [
  "Bose/Unknown_Wave/-1,-1.csv",
  "General Instruments/Unknown_550/-1,-1.csv",
  "Jerrold/Unknown_MRC/-1,-1.csv",
  "-1,-1.csv",
  "-1/-1,-1.csv",
  "Bose/-Unknown_Wave/-1,-1.csv",
];

const ACCEPTED_IRDB_PATHS = [...SAFE_IRDB_PATHS, ...SENTINEL_IRDB_PATHS];

/* Every one of these must be refused before any fetch: a forged index row or a
   hand-built entry must never reach outside the approved /codes/ prefix. */
const UNSAFE_IRDB_PATHS = [
  "",
  "   ",
  null,
  undefined,
  42,
  {},
  [],
  "Samsung/TV/A.txt",
  "Samsung/TV/A.csv.txt",
  "Samsung/TV/A.CSV",
  "Samsung/TV/A",
  ".csv",
  "/Samsung/TV/A.csv",
  "//evil.example/A.csv",
  "https://evil.example/A.csv",
  "http://evil.example/A.csv",
  "HTTPS://evil.example/A.csv",
  "javascript:alert(1)//A.csv",
  "data:text/csv,A.csv",
  "../A.csv",
  "../../etc/passwd.csv",
  "Samsung/../../A.csv",
  "Samsung/./A.csv",
  "Samsung/../A.csv",
  "....//A.csv",
  "..%2f..%2fA.csv",
  "Samsung/..%2FA.csv",
  "Samsung%2FTV%2FA.csv",
  "Samsung/%2e%2e/A.csv",
  "Samsung/%2E%2E/A.csv",
  "Samsung\\TV\\A.csv",
  "Samsung/TV\\..\\A.csv",
  "Samsung/TV/A%00.csv",
  "Samsung/TV/A\u0000.csv",
  "Samsung/TV/%zz.csv",
  "Samsung/TV/%2.csv",
  "Samsung/TV/%.csv",
  "Samsung/TV/A?x=/B.csv",
  "Samsung/TV/A#/B.csv",
  "Samsung//TV/A.csv",
  "Samsung/TV/A.csv\n../evil.csv",
  "\tSamsung/TV/A.csv",
  " Samsung/TV/A.csv",
  "Samsung/TV/A.csv ",
  /* Admitting a leading dash must not admit dash-flavoured traversal. */
  ".-1,-1.csv",
  "..-1,-1.csv",
  "/-1,-1.csv",
  "//-1,-1.csv",
  "Bose//-1,-1.csv",
  "../-1,-1.csv",
  "Bose/./-1,-1.csv",
  "Bose/../-1,-1.csv",
  "Bose/Unknown_Wave/../../../-1,-1.csv",
  "-1,-1.csv/../evil.csv",
  "-1/..%2f-1,-1.csv",
  "-1,-1/%2e%2e/evil.csv",
  "-1,-1.csv\\..\\evil.csv",
  "-1,-1.csv?x=-1,-1.csv",
  "-1,-1.csv#/-1,-1.csv",
  "-1,-1.CSV",
  "-1,-1.txt",
  "-1,-1.csv\u0000",
  "https://evil.example/-1,-1.csv",
];

function recordingFetch(response) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return response;
    },
  };
}

describe("irdbFileUrl path boundary", () => {
  it("returns exactly fileBase + path for safe relative .csv paths", () => {
    for (const path of ACCEPTED_IRDB_PATHS) {
      assert.equal(irdbFileUrl(path), LIBRARY_SOURCES.irdb.fileBase + path, `safe path rejected: ${path}`);
    }
  });

  it("keeps the live leading-dash sentinel rows IRDB actually publishes", () => {
    for (const path of SENTINEL_IRDB_PATHS) {
      assert.equal(irdbFileUrl(path), LIBRARY_SOURCES.irdb.fileBase + path, `sentinel path rejected: ${path}`);
    }
  });

  it("rejects every entry in the adversarial path corpus", () => {
    for (const path of UNSAFE_IRDB_PATHS) {
      assert.equal(irdbFileUrl(path), "", `unsafe path accepted: ${String(path)}`);
    }
  });

  it("never yields a URL outside the exact /codes/ prefix", () => {
    const base = new URL(LIBRARY_SOURCES.irdb.fileBase);
    for (const path of ACCEPTED_IRDB_PATHS) {
      const resolved = new URL(irdbFileUrl(path));
      assert.equal(resolved.origin, base.origin, `origin escaped for ${path}`);
      assert.ok(resolved.pathname.startsWith(base.pathname), `prefix escaped for ${path}`);
      assert.equal(resolved.search, "");
      assert.equal(resolved.hash, "");
    }
  });
});

describe("loadLibraryIndex path boundary", () => {
  it("keeps safe and sentinel rows, omits unsafe ones, and counts the skips", async () => {
    resetLibraryCache();
    const rawIndex = [
      "Samsung/TV/A.csv",
      "Bose/Unknown_Wave/-1,-1.csv",
      "../../etc/passwd.csv",
      "https://evil.example/x.csv",
      "General Instruments/Unknown_550/-1,-1.csv",
      "Samsung/%2e%2e/B.csv",
      "Jerrold/Unknown_MRC/-1,-1.csv",
      "LG/TV/B.csv",
      "notes.txt",
      "",
    ].join("\n");
    const { calls, fetchImpl } = recordingFetch({ ok: true, async text() { return rawIndex; } });
    const result = await loadLibraryIndex({ sources: ["irdb"], fetchImpl });
    assert.equal(calls.length, 1);
    assert.deepEqual(result.entries.map((e) => e.path), [
      "Samsung/TV/A.csv",
      "Bose/Unknown_Wave/-1,-1.csv",
      "General Instruments/Unknown_550/-1,-1.csv",
      "Jerrold/Unknown_MRC/-1,-1.csv",
      "LG/TV/B.csv",
    ]);
    for (const entry of result.entries) {
      assert.equal(entry.url, LIBRARY_SOURCES.irdb.fileBase + entry.path);
      assert.equal(entry.url, irdbFileUrl(entry.path));
    }
    assert.equal(result.skipped, 4);
  });

  /* A skipped row is a note about the index, not a failed source: it must never
     make a healthy search claim the results are incomplete. */
  it("reports skip-only loads with a count and no source errors", async () => {
    resetLibraryCache();
    const rawIndex = ["Samsung/TV/A.csv", "../evil.csv", "notes.txt"].join("\n");
    const { fetchImpl } = recordingFetch({ ok: true, async text() { return rawIndex; } });
    const result = await loadLibraryIndex({ sources: ["irdb"], fetchImpl });
    assert.equal(result.entries.length, 1);
    assert.equal(result.skipped, 2);
    assert.deepEqual(result.errors, []);
    assert.equal(formatSourceErrors(result.errors), "");
    assert.deepEqual(result.loaded, ["irdb"]);
  });

  it("serves the same skipped count from cache on a repeat load", async () => {
    resetLibraryCache();
    const rawIndex = ["Samsung/TV/A.csv", "../evil.csv"].join("\n");
    const { calls, fetchImpl } = recordingFetch({ ok: true, async text() { return rawIndex; } });
    const first = await loadLibraryIndex({ sources: ["irdb"], fetchImpl });
    const second = await loadLibraryIndex({ sources: ["irdb"], fetchImpl });
    assert.equal(calls.length, 1);
    assert.equal(first.skipped, 1);
    assert.equal(second.skipped, 1);
    assert.deepEqual(second.errors, []);
    resetLibraryCache();
  });

  it("fails closed naming the skipped count when every row is unsafe", async () => {
    resetLibraryCache();
    const rawIndex = ["../../evil.csv", "https://evil.example/x.csv", ""].join("\n");
    const { fetchImpl } = recordingFetch({ ok: true, async text() { return rawIndex; } });
    await assert.rejects(
      () => loadLibraryIndex({ sources: ["irdb"], fetchImpl }),
      (e) => /Could not load code libraries/i.test(e.message) && /2 skipped/i.test(e.message),
    );
    resetLibraryCache();
  });

  it("still populates errors for a genuine source failure alongside skips", async () => {
    resetLibraryCache();
    const rawIndex = ["Samsung/TV/A.csv", "../evil.csv"].join("\n");
    const fetchImpl = async (url) => {
      if (String(url).endsWith("/codes/index")) return { ok: true, async text() { return rawIndex; } };
      return { ok: false, status: 403, async text() { return ""; } };
    };
    const result = await loadLibraryIndex({ sources: ["irdb", "flipper"], fetchImpl });
    assert.equal(result.skipped, 1);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /flipper/i);
    assert.match(formatSourceErrors(result.errors), /Results are incomplete/i);
    resetLibraryCache();
  });

  it("still reports an index HTTP failure as a source error", async () => {
    resetLibraryCache();
    const { fetchImpl } = recordingFetch({ ok: false, status: 500, async text() { return ""; } });
    await assert.rejects(() => loadLibraryIndex({ sources: ["irdb"], fetchImpl }), /HTTP 500/);
    resetLibraryCache();
  });
});

describe("fetchLibraryFile path boundary", () => {
  const csv = "functionname,protocol,device,subdevice,function\nPower,NEC,32,-1,8\n";
  const okResponse = { ok: true, async text() { return csv; } };

  it("fetches a safe irdb entry exactly once from the recomputed url", async () => {
    const { calls, fetchImpl } = recordingFetch(okResponse);
    const path = "Samsung/TV/A.csv";
    const text = await fetchLibraryFile(
      { source: "irdb", path, url: LIBRARY_SOURCES.irdb.fileBase + path },
      { fetchImpl },
    );
    assert.equal(text, csv);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, LIBRARY_SOURCES.irdb.fileBase + path);
  });

  it("recomputes the url when the entry supplies none", async () => {
    const { calls, fetchImpl } = recordingFetch(okResponse);
    await fetchLibraryFile({ source: "irdb", path: "LG/TV/B.csv" }, { fetchImpl });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, LIBRARY_SOURCES.irdb.fileBase + "LG/TV/B.csv");
  });

  it("rejects a forged url that does not match its path, without fetching", async () => {
    const { calls, fetchImpl } = recordingFetch(okResponse);
    await assert.rejects(
      () => fetchLibraryFile(
        { source: "irdb", path: "Samsung/TV/A.csv", url: "https://evil.example/steal.csv" },
        { fetchImpl },
      ),
      /does not match/i,
    );
    await assert.rejects(
      () => fetchLibraryFile(
        { source: "irdb", path: "Samsung/TV/A.csv", url: LIBRARY_SOURCES.irdb.fileBase + "Samsung/TV/A.csv?x=1" },
        { fetchImpl },
      ),
      /does not match/i,
    );
    assert.equal(calls.length, 0);
  });

  it("rejects entries whose source is not irdb, without fetching", async () => {
    const { calls, fetchImpl } = recordingFetch(okResponse);
    for (const source of ["flipper", "", undefined, "IRDB"]) {
      await assert.rejects(
        () => fetchLibraryFile({ source, path: "Samsung/TV/A.csv" }, { fetchImpl }),
        /only IRDB/i,
      );
    }
    await assert.rejects(() => fetchLibraryFile(null, { fetchImpl }), /only IRDB/i);
    assert.equal(calls.length, 0);
  });

  it("rejects a missing path, without fetching", async () => {
    const { calls, fetchImpl } = recordingFetch(okResponse);
    for (const entry of [{ source: "irdb" }, { source: "irdb", path: "" }, { source: "irdb", path: null }]) {
      await assert.rejects(() => fetchLibraryFile(entry, { fetchImpl }), /no path/i);
    }
    assert.equal(calls.length, 0);
  });

  it("never calls fetch for any adversarial path", async () => {
    const { calls, fetchImpl } = recordingFetch(okResponse);
    for (const path of UNSAFE_IRDB_PATHS) {
      await assert.rejects(
        () => fetchLibraryFile({ source: "irdb", path }, { fetchImpl }),
        `unsafe path was not rejected: ${String(path)}`,
      );
    }
    assert.equal(calls.length, 0);
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
