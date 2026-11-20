import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as buttonPicker from "../public/js/views/button-picker.js";

const readPublic = (rel) => readFileSync(new URL(`../public/${rel}`, import.meta.url), "utf8");

describe("issue #216: command picker layout never collapses with many devices", () => {
  it("wizard and touch-screen command pickers use single-line scrollable chip rows, never wrapping .pick-chips", () => {
    for (const file of ["js/views/wizard.js", "js/views/touch-screen.js"]) {
      const src = readPublic(file);
      assert.equal(
        /class="pick-chips"(?!.*is-row)/.test(src),
        false,
        `${file} still renders a wrapping .pick-chips block inside the picker`,
      );
      assert.match(
        src,
        /chipRowMarkup\(/,
        `${file} should render device chips with chipRowMarkup() (single-line scrollable row)`,
      );
      assert.match(
        src,
        /followChipRow\(/,
        `${file} should wire horizontal chip-row scrolling with followChipRow()`,
      );
    }
  });

  it("wizard and touch-screen command pickers keep header fixed and metadata scrolling above compact sticky .pick-top", () => {
    for (const file of ["js/views/wizard.js", "js/views/touch-screen.js"]) {
      const src = readPublic(file);
      assert.match(src, /class="pick-scroll"/, `${file} should wrap picker body in .pick-scroll`);
      assert.match(src, /class="pick-meta"/, `${file} should place metadata in non-sticky .pick-meta`);
    }
    const css = readPublic("css/wizard.css");
    assert.match(css, /\.pick-sheet\s+\.sheet-content:has\(\s*>\s*\.pick-scroll\s*\)/, "wizard.css should lay out split pick-sheet content as flex column");
    assert.match(css, /\.pick-scroll\s*\{[^}]*overflow-y:\s*auto/s, "wizard.css .pick-scroll should scroll vertically");
    assert.match(css, /\.pick-scroll\s*\{[^}]*min-height:\s*0/s, "wizard.css .pick-scroll needs min-height: 0 so flex child can scroll");
    assert.match(css, /\.pick-chips\.is-row\s*\{[^}]*flex-wrap:\s*nowrap/s, "wizard.css .pick-chips.is-row must not wrap");
  });

  it("searchDeviceCommands searches the active device first (unprefixed) and other devices when many exist", () => {
    assert.equal(typeof buttonPicker.searchDeviceCommands, "function", "searchDeviceCommands must be exported from button-picker.js");
    const devices = Array.from({ length: 20 }, (_, i) => ({
      id: String(100 + i),
      name: i === 0 ? "TV LG" : i === 15 ? "Lampe salon" : `Device ${i + 1}`,
      commands: i === 0
        ? [{ name: "VolumeUp", functionId: 1 }, { name: "Home", functionId: 2 }]
        : i === 15
          ? [{ name: "PowerToggle", functionId: 10 }, { name: "Home", functionId: 11 }]
          : [{ name: "PowerOn", functionId: 20 + i }],
    }));

    // Empty query: only active device's commands, unprefixed.
    const idle = buttonPicker.searchDeviceCommands(devices, "100", "");
    assert.deepEqual(idle.map((r) => `${r.device.id}:${r.label}`), ["100:VolumeUp", "100:Home"]);

    // Search matching both active device and another device: active first unprefixed, others prefixed with device name.
    const home = buttonPicker.searchDeviceCommands(devices, "100", "Home");
    assert.deepEqual(home.map((r) => `${r.device.id}:${r.label}:${r.index}`), [
      "100:Home:1",
      "115:Lampe salon · Home:1",
    ]);

    // Search by device name + command finds a command on device #16 without scrolling chips.
    const salon = buttonPicker.searchDeviceCommands(devices, "100", "salon toggle");
    assert.deepEqual(salon.map((r) => `${r.device.id}:${r.label}:${r.command.name}`), [
      "115:Lampe salon · PowerToggle:PowerToggle",
    ]);
  });

  it("chipRowMarkup and followChipRow wire single-line horizontal chip scrolling with arrows and active-chip centering", () => {
    assert.equal(typeof buttonPicker.chipRowMarkup, "function", "chipRowMarkup must be exported");
    assert.equal(typeof buttonPicker.followChipRow, "function", "followChipRow must be exported");
    assert.equal(typeof buttonPicker.showPressedChip, "function", "showPressedChip must be exported");

    const html = buttonPicker.chipRowMarkup({ attr: "data-h-devices", label: "Hold device" });
    assert.match(html, /class="pick-chip-row"/);
    assert.match(html, /class="pick-chips is-row"/);
    assert.match(html, /data-h-devices/);
    assert.match(html, /aria-label="Hold device"/);
    assert.match(html, /data-pick-scroll="-1"/);
    assert.match(html, /data-pick-scroll="1"/);

    // Exercise followChipRow + showPressedChip with a mock 20-chip row that overflows horizontally.
    const makeClassList = () => {
      const set = new Set();
      return {
        toggle(name, force) { force ? set.add(name) : set.delete(name); },
        contains(name) { return set.has(name); },
      };
    };
    const listeners = new Map();
    const rowListeners = new Map();
    const back = { hidden: true, focus() {} };
    const forward = { hidden: true, focus() {} };
    const activeChip = { offsetLeft: 920, offsetWidth: 120 };
    const row = {
      scrollWidth: 1800,
      clientWidth: 460,
      scrollLeft: 0,
      classList: makeClassList(),
      addEventListener(ev, fn) { rowListeners.set(ev, fn); },
      scrollBy({ left }) { this.scrollLeft = Math.max(0, Math.min(this.scrollWidth - this.clientWidth, this.scrollLeft + left)); },
      querySelector(sel) { return sel === '[aria-pressed="true"]' ? activeChip : null; },
    };
    const wrap = {
      querySelector(sel) {
        if (sel === ".pick-chips.is-row") return row;
        return null;
      },
      querySelectorAll(sel) {
        if (sel === "[data-pick-scroll]") return [back, forward];
        return [];
      },
      addEventListener(ev, fn) { listeners.set(ev, fn); },
    };
    const content = {
      scrollTop: 0,
      clientHeight: 600,
      querySelector(sel) {
        if (sel === ".pick-chip-row") return wrap;
        if (sel === ".pick-chips.is-row") return row;
        return null;
      },
      querySelectorAll(sel) {
        if (sel === ".pick-chip-row") return [wrap];
        return [];
      },
    };
    const prevRO = globalThis.ResizeObserver;
    const prevDoc = globalThis.document;
    let observed = null;
    globalThis.ResizeObserver = class {
      constructor(cb) { this.cb = cb; }
      observe(el) { observed = el; this.cb(); }
    };
    globalThis.document = { activeElement: null };
    try {
      buttonPicker.followChipRow(content);
      assert.equal(observed, row);
      assert.equal(back.hidden, true);
      assert.equal(forward.hidden, false);
      assert.equal(row.classList.contains("has-after"), true);

      // Centering a chip far down the row scrolls it horizontally into view.
      buttonPicker.showPressedChip(content);
      assert.ok(row.scrollLeft > 500, `expected scrollLeft > 500, got ${row.scrollLeft}`);
      rowListeners.get("scroll")();
      assert.equal(back.hidden, false);
      assert.equal(forward.hidden, false);
      assert.equal(row.classList.contains("has-before"), true);
      assert.equal(row.classList.contains("has-after"), true);
    } finally {
      globalThis.ResizeObserver = prevRO;
      globalThis.document = prevDoc;
    }
  });
});
