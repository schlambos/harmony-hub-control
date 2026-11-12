import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  CUSTOM_LINKS,
  FINDER_GIVE_UP,
  addRow,
  applyPreset,
  expandPattern,
  finderAnswer,
  finderApply,
  finderCandidates,
  finderStart,
  freeSlot,
  linkOk,
  matchPreset,
  parseProfile,
  patternOk,
  presetChangesWorkingRows,
  profileText,
  readPresets,
  readTvInputs,
  setMethod,
  setPattern,
  shareEntry,
  slotCommand,
  slotOf,
  targetLabel,
  tryRequest,
  tvInputProblems,
  tvInputsHint,
  writerInputs,
} from "../public/js/views/androidtv-inputs-model.js";

const FILE = JSON.parse(readFileSync(new URL("../../../payload/androidtv/input-presets.json", import.meta.url), "utf8"));
const PRESETS = readPresets(FILE);
const HISENSE = "content://android.media.tv/passthrough/com.hisense.tv.hitvinput%2F.hdmi.HdmiTvInputService%2FHW{n}";
const HDMI = [1, 2, 3, 4].map((n) => ({ name: `HDMI ${n}`, command: slotCommand(n) }));

describe("slots", () => {
  it("names slots 1-4 InputHdmi and the rest Input<n>, and reads them back", () => {
    assert.equal(slotCommand(1), "InputHdmi1");
    assert.equal(slotCommand(5), "Input5");
    assert.equal(slotOf("inputhdmi3"), 3);
    assert.equal(slotOf("Input32"), 32);
    for (const not of ["Input4", "Input33", "InputNext", "InputHdmi5", "PowerOn", ""]) assert.equal(slotOf(not), 0, not);
  });
  it("hands out the lowest free slot", () => {
    assert.equal(freeSlot([{ slot: 1 }, { slot: 2 }, { slot: 4 }]), 3);
    assert.equal(freeSlot(Array.from({ length: 32 }, (_, i) => ({ slot: i + 1 }))), 0);
  });
});

describe("links", () => {
  it("checks links and patterns as codex_androidtv does", () => {
    assert.ok(linkOk("content://x/one"));
    assert.ok(linkOk("https://example.com/two"));
    for (const bad of ["no scheme", "x", "content://a b", 'content://"q"', "content://é", "1abc://x"]) assert.ok(!linkOk(bad), bad);
    assert.ok(patternOk(HISENSE));
    assert.ok(!patternOk("content://x/HW"));
    assert.ok(!patternOk("content://x/{n}/{n}"));
    assert.equal(expandPattern(HISENSE, 3).endsWith("%2FHW3"), true);
  });
});

describe("the presets file", () => {
  it("ships a valid file: Hisense checked on a 75U8H, the default HDMI keys, untested patterns marked", () => {
    const hisense = PRESETS.presets.find((p) => p.vendor === "Hisense");
    assert.equal(hisense.method, "link");
    assert.equal(hisense.pattern, "hisense-hw");
    assert.deepEqual(hisense.inputs.map((i) => i.value), [2, 3, 4, 5]);
    assert.equal(hisense.checked.model, "75U8H");
    assert.equal(PRESETS.fallback.method, "keys");
    assert.deepEqual(PRESETS.fallback.inputs.map((i) => i.value), [243, 244, 245, 246]);
    assert.ok(PRESETS.patterns.filter((p) => p.id !== "hisense-hw").every((p) => p.untested));
  });
  it("leaves out entries that don't hold, and treats a broken file as none", () => {
    const got = readPresets({
      version: 1,
      patterns: [{ id: "ok", uri: "content://x/{n}" }, { id: "Bad Id", uri: "content://x/{n}" }, { id: "nopat", uri: "content://x" }],
      presets: [
        { vendor: "A", method: "link", pattern: "ok", inputs: [{ name: "HDMI 1", n: 1 }] },
        { vendor: "B", method: "link", pattern: "missing", inputs: [] },
        { vendor: "C", method: "keys", inputs: [{ name: "HDMI 1", key: "x" }] },
        { vendor: "D", method: "laser", inputs: [] },
        { method: "keys", inputs: [] },
      ],
    });
    assert.deepEqual(got.patterns.map((p) => p.id), ["ok"]);
    assert.deepEqual(got.presets.map((p) => p.vendor), ["A"]);
    for (const broken of [null, "x", { version: 2 }, {}]) assert.deepEqual(readPresets(broken).presets, []);
  });
  it("matches by vendor prefix (any case), then by model, else the default, else the HDMI keys", () => {
    assert.equal(matchPreset(PRESETS, "HISENSE", "SmartTV 4K FFM").vendor, "Hisense");
    assert.equal(matchPreset(PRESETS, "Sony", "Bravia").method, "keys");
    const byModel = readPresets({ version: 1, presets: [
      { vendor: "Acme", model: "^Pro", method: "menu", inputs: [{ name: "HDMI 1", position: 1 }] },
      { vendor: "Acme", method: "keys", inputs: [{ name: "HDMI 1", key: 243 }] },
    ] });
    assert.equal(matchPreset(byModel, "Acme", "Pro 9").method, "menu");
    assert.equal(matchPreset(byModel, "Acme", "Basic").method, "keys");
    assert.deepEqual(matchPreset(readPresets(null), "X", "Y").inputs.map((i) => i.value), [243, 244, 245, 246]);
  });
});

describe("the profile text", () => {
  it("round-trips a link profile with a pattern", () => {
    const draft = readTvInputs({ entryInputs: HDMI, profile: null, presets: PRESETS, vendor: "Hisense" });
    draft.rows[0].status = "works";
    draft.rows[0].date = "2026-11-11";
    const text = profileText(draft);
    assert.equal(text, `method\tlink\npattern\t${HISENSE}\nslot\t1\t2\tworks\t2026-11-11\nslot\t2\t3\tuntested\t-\n` +
      "slot\t3\t4\tuntested\t-\nslot\t4\t5\tuntested\t-\n");
    const again = readTvInputs({ entryInputs: HDMI, profile: parseProfile(text), presets: PRESETS, vendor: "Hisense" });
    assert.equal(again.method, "link");
    assert.equal(again.pattern, "hisense-hw");
    assert.deepEqual(again.rows.map((r) => [r.value, r.status]), [[2, "works"], [3, "untested"], [4, "untested"], [5, "untested"]]);
  });
  it("keeps whole links, menus with their gap, and a pattern the presets file doesn't list", () => {
    const links = parseProfile("method\tlink\nslot\t1\thttps://example.com/a\tfailed\t2026-11-12\n");
    assert.equal(links.slots.get(1).value, "https://example.com/a");
    const menu = parseProfile("method\tmenu\ngap\t300\nslot\t2\t3\tuntested\t-\n");
    assert.equal(menu.gapMs, 300);
    const odd = parseProfile("method\tlink\npattern\tcontent://other/{n}\nslot\t1\t7\tuntested\t-\n");
    const draft = readTvInputs({ entryInputs: HDMI.slice(0, 1), profile: odd, presets: PRESETS, vendor: "Hisense" });
    assert.equal(draft.pattern, "saved");
    assert.ok(profileText(draft).includes("pattern\tcontent://other/{n}"));
    assert.equal(parseProfile("nonsense"), null);
    assert.equal(parseProfile(""), null);
  });
});

describe("the draft", () => {
  it("describes the built-in behaviour when the TV has no profile: Hisense links, others the HDMI keys", () => {
    const h = readTvInputs({ entryInputs: HDMI, profile: null, presets: PRESETS, vendor: "Hisense" });
    assert.equal(h.fromProfile, false);
    assert.deepEqual(h.rows.map((r) => r.value), [2, 3, 4, 5]);
    const other = readTvInputs({ entryInputs: HDMI, profile: null, presets: PRESETS, vendor: "Sony" });
    assert.equal(other.method, "keys");
    assert.deepEqual(other.rows.map((r) => r.value), [243, 244, 245, 246]);
  });
  it("reads renamed inputs by slot, and a device without inputs as don't switch", () => {
    const renamed = [{ name: "Shield", command: "InputHdmi1" }, { name: "Xbox", command: "InputHdmi3" }];
    const d = readTvInputs({ entryInputs: renamed, profile: null, presets: PRESETS, vendor: "Hisense" });
    assert.deepEqual(d.rows.map((r) => [r.name, r.slot, r.value]), [["Shield", 1, 2], ["Xbox", 3, 4]]);
    assert.equal(readTvInputs({ entryInputs: null, profile: null, presets: PRESETS }).method, "none");
  });
  it("adds rows on the lowest free slot", () => {
    const d = readTvInputs({ entryInputs: [HDMI[0], HDMI[2]], profile: null, presets: PRESETS, vendor: "Sony" });
    assert.equal(addRow(d, "Live TV").slot, 2);
    assert.equal(addRow(d).slot, 4);
    assert.equal(addRow(d).slot, 5);
  });
  it("switching method keeps names, order and slots, maps what it can, and marks everything untested", () => {
    const d = readTvInputs({ entryInputs: HDMI, profile: null, presets: PRESETS, vendor: "Hisense" });
    d.rows[0].status = "works";
    setMethod(d, "keys");
    assert.deepEqual(d.rows.map((r) => [r.name, r.slot, r.value, r.status]),
      [["HDMI 1", 1, 243, "untested"], ["HDMI 2", 2, 244, "untested"], ["HDMI 3", 3, 245, "untested"], ["HDMI 4", 4, 246, "untested"]]);
    setMethod(d, "menu");
    assert.deepEqual(d.rows.map((r) => r.value), [1, 2, 3, 4]);
    setMethod(d, "link");
    assert.equal(d.pattern, "hisense-hw");
    assert.deepEqual(d.rows.map((r) => r.value), [2, 3, 4, 5]);
  });
  it("switching to links per input clears the numbers; another pattern keeps them", () => {
    const d = readTvInputs({ entryInputs: HDMI, profile: null, presets: PRESETS, vendor: "Hisense" });
    setPattern(d, "mediatek-tis-hdmi");
    assert.deepEqual(d.rows.map((r) => r.value), [2, 3, 4, 5]);
    setPattern(d, CUSTOM_LINKS);
    assert.deepEqual(d.rows.map((r) => r.value), ["", "", "", ""]);
  });
  it("the suggested setup keeps the slots of inputs it names, and says when it would change ones that work", () => {
    const d = readTvInputs({ entryInputs: [{ name: "HDMI 3", command: "Input9" }], profile: null, presets: PRESETS, vendor: "Hisense" });
    d.rows[0].value = 7;
    d.rows[0].status = "works";
    assert.equal(presetChangesWorkingRows(d).length, 1);
    applyPreset(d);
    assert.deepEqual(d.rows.map((r) => [r.name, r.slot, r.value]), [["HDMI 1", 1, 2], ["HDMI 2", 2, 3], ["HDMI 3", 9, 4], ["HDMI 4", 3, 5]]);
  });
});

describe("checks", () => {
  const base = () => readTvInputs({ entryInputs: HDMI, profile: null, presets: PRESETS, vendor: "Sony" });
  it("passes a complete draft", () => assert.deepEqual(tvInputProblems(base()), []));
  it("wants every input to open something, and no two the same", () => {
    const d = base();
    d.rows[1].value = "";
    d.rows[2].value = 243;
    const p = tvInputProblems(d);
    assert.ok(p.includes("Choose what HDMI 2 opens."), p);
    assert.ok(p.includes("HDMI 1 and HDMI 3 open the same thing."), p);
  });
  it("checks names, the menu gap, links, and app links", () => {
    const d = base();
    d.rows[0].name = 'Bad"Name';
    assert.ok(tvInputProblems(d)[0].startsWith("Input names"));
    const m = base();
    setMethod(m, "menu");
    m.gapMs = 50;
    assert.ok(tvInputProblems(m).some((p) => p.includes("gap")));
    const l = base();
    setMethod(l, "link");
    setPattern(l, CUSTOM_LINKS);
    l.rows.forEach((r, i) => { r.value = `content://x/${i}`; });
    l.rows[0].value = "not a link";
    assert.ok(tvInputProblems(l).includes("HDMI 1 needs a link."));
    l.rows[0].value = "content://x/9";
    assert.deepEqual(tvInputProblems(l), []);
    assert.ok(tvInputProblems(l, { appLinks: false })[0].includes("doesn't accept input links"));
  });
  it("needs nothing more for don't switch, and an input for the rest", () => {
    const d = base();
    setMethod(d, "none");
    assert.deepEqual(tvInputProblems(d), []);
    const e = base();
    e.rows = [];
    assert.ok(tvInputProblems(e)[0].startsWith("List at least one input"));
  });
});

describe("labels and requests", () => {
  it("labels each method's targets", () => {
    const d = readTvInputs({ entryInputs: HDMI, profile: null, presets: PRESETS, vendor: "Hisense" });
    assert.equal(targetLabel(d, 3), "No. 3");
    setMethod(d, "keys");
    assert.equal(targetLabel(d, 170), "Live TV");
    setMethod(d, "menu");
    assert.equal(targetLabel(d, 2), "2nd in the menu");
    assert.equal(targetLabel(d, ""), "Not set");
  });
  it("builds Try bodies as codex_androidtv takes them (strings)", () => {
    const d = readTvInputs({ entryInputs: HDMI, profile: null, presets: PRESETS, vendor: "Hisense" });
    assert.deepEqual(tryRequest("androidtv1", d, 3), { device: "androidtv1", method: "link", value: "3", home: "1", pattern: HISENSE });
    setMethod(d, "menu");
    assert.deepEqual(tryRequest("androidtv1", d, 2, { home: false }), { device: "androidtv1", method: "menu", value: "2", home: "0", gap: "500" });
  });
  it("gives the writer names, order and slot commands, or none for don't switch", () => {
    const d = readTvInputs({ entryInputs: HDMI.slice(0, 2), profile: null, presets: PRESETS, vendor: "Sony", delayMs: 500 });
    addRow(d, "Live TV");
    d.rows[0].name = " Shield ";
    assert.deepEqual(writerInputs(d), { inputs: [{ name: "Shield", command: "InputHdmi1" },
      { name: "HDMI 2", command: "InputHdmi2" }, { name: "Live TV", command: "InputHdmi3" }], inputDelay: 500 });
    setMethod(d, "none");
    assert.deepEqual(writerInputs(d).inputs, []);
  });
  it("shares a setup as a presets-file entry", () => {
    const d = readTvInputs({ entryInputs: HDMI.slice(0, 2), profile: null, presets: PRESETS, vendor: "Hisense" });
    d.rows[0].status = "works";
    const e = shareEntry(d, "Hisense", "SmartTV 4K FFM");
    assert.equal(e.patternUri, HISENSE);
    assert.deepEqual(e.inputs, [{ name: "HDMI 1", n: 2 }, { name: "HDMI 2", n: 3 }]);
    assert.deepEqual(e.checked.inputs, ["HDMI 1"]);
  });
});

describe("Find my inputs", () => {
  it("tries the method's candidates in order", () => {
    const d = readTvInputs({ entryInputs: HDMI, profile: null, presets: PRESETS, vendor: "Hisense" });
    assert.deepEqual(finderCandidates(d), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    setPattern(d, CUSTOM_LINKS);
    assert.deepEqual(finderCandidates(d), []);
    setMethod(d, "keys");
    assert.equal(finderCandidates(d)[0], 243);
  });
  it("walks the answers, stops when every input is found, and fills the rows (new ones too)", () => {
    const d = readTvInputs({ entryInputs: HDMI.slice(0, 2), profile: null, presets: PRESETS, vendor: "Hisense" });
    let s = finderStart(d);
    s = finderAnswer(s, d, { kind: "empty" });                     // No. 1: no picture
    s = finderAnswer(s, d, { kind: "input", name: "HDMI 1" });     // No. 2
    s = finderAnswer(s, d, { kind: "new", name: "Xbox" });         // No. 3
    assert.equal(s.done, false);
    s = finderAnswer(s, d, { kind: "input", name: "HDMI 2" });     // No. 4
    assert.equal(s.done, true);
    finderApply(d, s, "2026-11-12");
    assert.deepEqual(d.rows.map((r) => [r.name, r.slot, r.value, r.status, r.date]),
      [["HDMI 1", 1, 2, "works", "2026-11-12"], ["HDMI 2", 2, 4, "works", "2026-11-12"], ["Xbox", 3, 3, "works", "2026-11-12"]]);
  });
  it("takes a target away from an input it wasn't the answer for", () => {
    const d = readTvInputs({ entryInputs: HDMI.slice(0, 2), profile: null, presets: PRESETS, vendor: "Hisense" });
    // HDMI 2 claims No. 3, but No. 3 showed a new input.
    let s = finderStart(d);
    s = finderAnswer(s, d, { kind: "nothing" });                   // No. 1
    s = finderAnswer(s, d, { kind: "input", name: "HDMI 1" });     // No. 2
    s = finderAnswer(s, d, { kind: "new", name: "Xbox" });         // No. 3
    finderApply(d, s, "2026-11-12");
    assert.deepEqual(d.rows.map((r) => [r.name, r.value, r.status]),
      [["HDMI 1", 2, "works"], ["HDMI 2", "", "untested"], ["Xbox", 3, "works"]]);
    assert.ok(tvInputProblems(d).includes("Choose what HDMI 2 opens."));
  });
  it(`gives up after ${FINDER_GIVE_UP} "nothing changed" answers in a row`, () => {
    const d = readTvInputs({ entryInputs: HDMI, profile: null, presets: PRESETS, vendor: "Hisense" });
    let s = finderStart(d);
    for (let i = 0; i < FINDER_GIVE_UP - 1; i++) s = finderAnswer(s, d, { kind: "nothing" });
    assert.equal(s.done, false);
    s = finderAnswer(s, d, { kind: "nothing" });
    assert.equal(s.done, true);
  });
});

describe("the device page hint", () => {
  it("points a connected TV on the built-in guess at Settings → Inputs", () => {
    assert.equal(tvInputsHint({ connected: true, inputs: "builtin" }), "Inputs not checked yet: Settings → Inputs");
    assert.equal(tvInputsHint({ connected: true, inputs: "link" }), "");
    assert.equal(tvInputsHint({ connected: false, inputs: "builtin" }), "");
    assert.equal(tvInputsHint(undefined), "");
  });
});
