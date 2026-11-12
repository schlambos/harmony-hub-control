import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { matchingRowsOfAllChips } from "../public/js/views/button-picker.js";

describe("button picker search across all chips", () => {
  const list = (id, label, names) => ({ chip: { id, label }, rows: names.map((name) => ({ label: name })) });
  const lists = [
    list("1", "Living room TV", ["PowerToggle", "VolumeUp"]),
    list("2", "Bedroom", ["PowerOff", "PowerToggle", "Mute"]),
    list("activities", "Activities", ["Music", "Watch TV"]),
  ];
  const found = (query) => matchingRowsOfAllChips(lists, query).map(({ chip, row, index }) => `${chip.id}:${index}:${row.label}`);

  it("needs every word in the chip label or row label, in any case", () => {
    assert.deepEqual(found("bed toggle"), ["2:1:PowerToggle"]);
    assert.deepEqual(found("  BED   Toggle "), ["2:1:PowerToggle"]);
    assert.deepEqual(found("music activ"), ["activities:0:Music"]);
  });

  it("keeps chip order, then row order, with each row's index in its own list", () => {
    assert.deepEqual(found("toggle"), ["1:0:PowerToggle", "2:1:PowerToggle"]);
    assert.deepEqual(found("power"), ["1:0:PowerToggle", "2:0:PowerOff", "2:1:PowerToggle"]);
  });

  it("matches a chip label alone, so a device's name lists its rows", () => {
    assert.deepEqual(found("bedroom"), ["2:0:PowerOff", "2:1:PowerToggle", "2:2:Mute"]);
  });

  it("keeps the row itself, so its current flag survives", () => {
    const current = { label: "Mute", current: true };
    const [match] = matchingRowsOfAllChips([{ chip: { id: "2", label: "Bedroom" }, rows: [current] }], "mute");
    assert.equal(match.row, current);
  });

  it("finds nothing when one word matches nowhere", () => {
    assert.deepEqual(found("bed zzz"), []);
  });
});
