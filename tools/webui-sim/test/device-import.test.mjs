import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { openImportSheet } from "../public/js/views/device-import.js";

// Tiny DOM test double, not a second implementation of the view. It runs
// the real mount, click, FileReader and input handlers without a browser dep.
class Node {
  constructor(tag = "div") {
    this.tag = tag; this.children = []; this.attrs = {}; this.listeners = {};
    this.dataset = {}; this.value = ""; this._text = ""; this.className = "";
    this.classList = { add: (name) => { this.className += ` ${name}`; } };
  }
  setAttribute(key, value) {
    this.attrs[key] = String(value);
    if (key === "id") this.id = String(value);
    if (key === "class") this.className = String(value);
    if (key === "value") this.value = String(value);
    if (key.startsWith("data-")) this.dataset[key.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = String(value);
  }
  getAttribute(key) { return this.attrs[key]; }
  appendChild(child) {
    child.remove(); this.children.push(child); child.parent = this; return child;
  }
  append(...children) { children.forEach((c) => this.appendChild(c)); }
  replaceChildren(...children) { this.children.forEach((c) => { c.parent = null; }); this.children = []; this._text = ""; this.append(...children); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); this.parent = null; }
  set textContent(text) { this.replaceChildren(); this._text = String(text); }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(""); }
  set innerHTML(html) {
    this.replaceChildren();
    const stack = [this];
    for (const token of html.match(/<[^>]+>|[^<]+/g) || []) {
      if (token.startsWith("</")) { stack.pop(); continue; }
      if (!token.startsWith("<")) { stack.at(-1)._text += token; continue; }
      const tag = /^<(\w+)/.exec(token)?.[1];
      if (!tag) continue;
      const child = new Node(tag);
      for (const [, k, v] of token.matchAll(/([\w-]+)="([^"]*)"/g)) child.setAttribute(k, v);
      for (const [, k] of token.matchAll(/\s(data-[\w-]+)(?=[\s>])/g)) child.setAttribute(k, "");
      stack.at(-1).appendChild(child);
      if (!["input", "br", "hr"].includes(tag)) stack.push(child);
    }
  }
  matches(selector) {
    if (selector.startsWith("#")) return this.id === selector.slice(1);
    if (selector.startsWith(".")) return this.className.split(/\s+/).includes(selector.slice(1));
    const attr = /^\[([^=$]+)(\$?=)?["']?([^"'\]]*)["']?\]$/.exec(selector);
    if (attr) {
      const value = attr[1] === "id" ? this.id : this.attrs[attr[1]];
      return attr[2] === "$=" ? value?.endsWith(attr[3]) : attr[2] ? value === attr[3] : value !== undefined;
    }
    return this.tag === selector;
  }
  querySelectorAll(selector) { return this.children.flatMap((c) => [...(c.matches(selector) ? [c] : []), ...c.querySelectorAll(selector)]); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  addEventListener(name, fn) { (this.listeners[name] ||= []).push(fn); }
  async emit(name) { if (this.disabled) return; await Promise.all((this.listeners[name] || []).map((fn) => fn({ target: this, preventDefault() {} }))); }
  showModal() { this.open = true; }
  close() { this.open = false; this.emit("close"); }
  focus() {}
}

const device = { id: "42", name: "Fixture receiver", manufacturer: "Sony", model: "STR-DG720", typeLabel: "Receiver" };
const wire = JSON.parse(readFileSync(new URL("../../../desktop/test/fixtures/catalog-fixtures.json", import.meta.url)));
const pkg = { schema_version: "0.2.0", resources: { global_language_commands: wire.getGlobalLanguageCommands.GetGlobalLanguageCommandsResult } };
const flush = async () => { for (let n = 0; n < 30; n++) await Promise.resolve(); };

function setup(catalog) {
  const body = new Node("body");
  globalThis.document = { body, createElement: (tag) => new Node(tag), getElementById: () => null };
  globalThis.window = catalog ? { melodiousDesktop: { catalog } } : {};
  globalThis.FileReader = class {
    readAsText(file) { this.result = file.text; this.onload(); }
  };
  const requests = [];
  globalThis.fetch = async (url, opts = {}) => {
    requests.push({ url, ...opts });
    const data = url === "/export/protocols" ? { Protocols: [{ Name: "Sony 15 Bit" }, { Name: "Sony 20 Bit" }] } : { ok: true, deviceList: { DevicesWithFeatures: [] } };
    return { ok: true, status: 200, text: async () => JSON.stringify(data) };
  };
  const sheet = openImportSheet({ device });
  const panel = sheet.content.querySelector('[id$="panel-catalog"]');
  const button = (label) => panel.querySelectorAll("button").find((b) => b.textContent === label);
  const tab = sheet.content.querySelectorAll("button").find((b) => b.textContent === "Logitech catalog");
  const input = (suffix) => panel.querySelector(`[id$="${suffix}"]`);
  return { ...sheet, panel, button, tab, input, requests };
}

describe("Import codes catalog tab", () => {
  it("without a bridge keeps the helper/file UI, makes no opening requests, previews and imports a file", async () => {
    const s = setup();
    await s.tab.emit("click");
    assert.equal(s.requests.length, 0);
    assert.equal(s.panel.querySelectorAll("input").length, 1);
    assert.equal(s.button("Sign in"), undefined);
    assert.match(s.panel.textContent, /On your computer, run tools\/catalog\/harmony_catalog.py once/);
    const file = s.input("CatalogFile");
    file.files = [{ name: "fixture.json", text: JSON.stringify(pkg) }];
    await file.emit("change"); await flush();
    assert.match(s.panel.textContent, /4 importable/);
    assert.match(s.panel.textContent, /missing on hub: RC6 Mode 0/);
    assert.match(s.panel.textContent, /original remote.*IRDB.*Flipper/i);
    assert.doesNotMatch(s.panel.textContent, /missing on hub: protocol/);
    await s.button("Import 4 commands to Fixture receiver").emit("click");
    const sent = s.requests.find((r) => r.url === "/api/catalog-import");
    const sentBody = JSON.parse(sent.body);
    assert.equal(sentBody.commands.length, 4);
    assert.equal(sentBody.protocols, undefined);
    assert.equal(s.dialog.open, false);
  });

  it("previews and posts bundled protocols when a package supplies one missing from the hub", async () => {
    const s = setup();
    await s.tab.emit("click");
    const bundledProto = {
      __type: "IrProtocol",
      "Id-": 777,
      Name: "Fixture Custom 24 Bit",
      CarrierFrequency: 38000,
      IRSegments: [{ Header: [{ Value: 4000, Type: 1 }], Payload: { NumberOfBits: 24, Encodings: [] }, Trailer: [], TotalLength: 45000, Name: "Fixture Custom 24 Bit" }],
      CodeSegments: [],
      KeyCode: { Start: null, Repeat: [{ SegmentType: 1, SegmentName: "Fixture Custom 24 Bit" }], Finish: null },
    };
    const bundledPkg = {
      schema_version: "0.2.0",
      resources: {
        global_language_commands: [
          { Name: "PowerOn", KeyCode: "G:Fixture Custom 24 Bit:()(0x123456)():3", ProtocolId: 777 },
        ],
        protocols: [bundledProto],
      },
    };
    const file = s.input("CatalogFile");
    file.files = [{ name: "bundled.json", text: JSON.stringify(bundledPkg) }];
    await file.emit("change"); await flush();
    assert.match(s.panel.textContent, /1 importable/);
    assert.match(s.panel.textContent, /adds protocols: Fixture Custom 24 Bit/);
    await s.button("Import 1 command to Fixture receiver").emit("click");
    const sent = s.requests.find((r) => r.url === "/api/catalog-import");
    const sentBody = JSON.parse(sent.body);
    assert.equal(sentBody.commands.length, 1);
    assert.deepEqual(sentBody.protocols, [bundledProto]);
  });

  it("fake bridge sign in, search, pick, download, preview, all skipped reasons, import, sign out and errors", async () => {
    const calls = [];
    const catalog = {
      status: async () => { calls.push("status"); return { signedIn: false }; },
      signIn: async () => { calls.push("signIn"); return { signedIn: true }; },
      signOut: async () => { calls.push("signOut"); return { signedIn: false }; },
      search: async (q) => { calls.push("search"); if (q.model === "FAIL") throw new Error("Catalog refused"); return [{ id: 167856, manufacturer: "Sony", model: "STR-DG720", displayText: "Sony STR-DG720", deviceType: "Receiver" }]; },
      download: async () => { calls.push("download"); return pkg; },
      checkModel: async () => { calls.push("checkModel"); return { found: true }; },
    };
    const s = setup(catalog);
    assert.deepEqual(calls, [], "no bridge call when the sheet opens");
    await s.tab.emit("click"); await flush();
    assert.equal(s.input("CatalogBrand").value, "Sony");
    assert.equal(s.input("CatalogModel").value, "STR-DG720");
    await s.button("Sign in").emit("click");
    assert.match(s.panel.textContent, /Signed in to Logitech/);
    await s.button("Search Logitech catalog").emit("click");
    await s.button("Download").emit("click");
    assert.match(s.panel.textContent, /SmartKey — protocol “RC6 Mode 0” is not on this hub/);
    assert.deepEqual(calls, ["status", "signIn", "search", "download"]);
    await s.button("Sign out").emit("click");
    assert.ok(s.button("Sign in"));
    s.input("CatalogModel").value = "FAIL";
    await s.button("Search Logitech catalog").emit("click");
    assert.match(s.panel.textContent, /Catalog refused/);
    // Every skipped command is visible, not only the first 12.
    pkg.resources.global_language_commands.push(...Array.from({ length: 15 }, (_, n) => ({ Name: `Skipped${n}` })));
    s.input("CatalogModel").value = "STR-DG7";
    await s.button("Search Logitech catalog").emit("click");
    await s.button("Download").emit("click");
    assert.match(s.panel.textContent, /Skipped14 — no KeyCode or Raw code/);
    pkg.resources.global_language_commands.splice(5);
    await s.button("Import 4 commands to Fixture receiver").emit("click");
    assert.equal(s.requests.filter((r) => r.url === "/api/catalog-import").length, 1);
  });

  it("model check debounces 600 ms, never checks prefilled values, serializes changed input and cancels on close", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const calls = [];
    let answer;
    const s = setup({ status: async () => ({ signedIn: false }), checkModel: (q) => {
      calls.push(q); return new Promise((resolve) => { answer = resolve; });
    } });
    await s.tab.emit("click"); await flush();
    const model = s.input("CatalogModel");
    await model.emit("input"); t.mock.timers.tick(1000); await flush();
    assert.equal(calls.length, 0);
    model.value = "STR-DG7"; await model.emit("input");
    t.mock.timers.tick(599); await flush(); assert.equal(calls.length, 0);
    t.mock.timers.tick(1); await flush(); assert.equal(calls.length, 1);
    model.value = "STR-DG"; await model.emit("input");
    t.mock.timers.tick(600); await flush(); assert.equal(calls.length, 1);
    answer({ found: true, model: "STALE" }); await flush();
    assert.equal(calls.length, 2);
    assert.doesNotMatch(s.panel.textContent, /STALE/);
    answer({ found: true, model: "STR-DG720" }); await flush();
    assert.match(s.panel.textContent, /Logitech knows this as STR-DG720/);
    model.value = "another"; await model.emit("input"); s.close();
    t.mock.timers.tick(1000); await flush(); assert.equal(calls.length, 2);
  });

  it("cancel is quiet, downloads cannot overlap, and a failed download cannot import a stale preview", async () => {
    let count = 0;
    let rejectDownload;
    const s = setup({
      status: async () => ({ signedIn: false }),
      signIn: async () => ({ signedIn: false }),
      search: async () => [{ id: 167856, manufacturer: "Sony", model: "STR-DG720" }],
      download: async () => { count++; if (count === 1) return pkg; return new Promise((_, reject) => { rejectDownload = reject; }); },
    });
    await s.tab.emit("click"); await flush();
    await s.button("Sign in").emit("click");
    assert.doesNotMatch(s.panel.textContent, /Sign-in failed|Signing in/);
    await s.button("Search Logitech catalog").emit("click");
    await s.button("Download").emit("click");
    const importing = s.button("Import 4 commands to Fixture receiver");
    assert.equal(importing.hidden, false);
    const pending = s.button("Download").emit("click"); await flush();
    assert.equal(importing.hidden, true);
    await s.button("Download").emit("click");
    assert.equal(count, 2);
    rejectDownload(new Error("Download refused")); await pending;
    assert.match(s.panel.textContent, /Download refused/);
    assert.equal(importing.hidden, true);
    s.close();
  });
});
