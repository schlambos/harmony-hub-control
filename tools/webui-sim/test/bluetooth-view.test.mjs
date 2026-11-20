import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";

class FakeClassList {
  constructor(node) {
    this.node = node;
    this.set = new Set();
  }
  add(...names) {
    for (const n of names) for (const part of String(n).split(/\s+/)) if (part) this.set.add(part);
  }
  remove(...names) {
    for (const n of names) this.set.delete(n);
  }
  toggle(name, force) {
    if (force === undefined) {
      if (this.set.has(name)) { this.set.delete(name); return false; }
      this.set.add(name); return true;
    }
    if (force) this.set.add(name);
    else this.set.delete(name);
    return !!force;
  }
  contains(name) { return this.set.has(name); }
  toString() { return [...this.set].join(" "); }
}

class FakeElement {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.attributes = new Map();
    this.dataset = {};
    this.listeners = new Map();
    this.classList = new FakeClassList(this);
    this._text = "";
    this.value = "";
    this.type = "";
    this.hidden = false;
    this.disabled = false;
    this.parentNode = null;
  }
  set className(v) {
    this.classList = new FakeClassList(this);
    this.classList.add(v);
  }
  get className() { return this.classList.toString(); }
  set textContent(v) {
    this._text = String(v ?? "");
    this.children = [];
  }
  get textContent() {
    if (this.children.length) return this.children.map((c) => c.textContent).join("");
    return this._text;
  }
  setAttribute(k, v) {
    const val = String(v);
    this.attributes.set(k, val);
    if (k.startsWith("data-")) {
      const key = k.slice(5).replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
      this.dataset[key] = val;
    }
    if (k === "value") this.value = val;
  }
  getAttribute(k) { return this.attributes.get(k) ?? null; }
  appendChild(child) {
    if (child && typeof child === "object") {
      child.parentNode = this;
      this.children.push(child);
    }
    return child;
  }
  append(...nodes) {
    for (const n of nodes) {
      if (typeof n === "string") {
        const span = new FakeElement("#text");
        span._text = n;
        this.appendChild(span);
      } else if (n) {
        this.appendChild(n);
      }
    }
  }
  replaceChildren(...nodes) {
    this.children = [];
    this._text = "";
    this.append(...nodes);
  }
  addEventListener(ev, fn) {
    if (!this.listeners.has(ev)) this.listeners.set(ev, []);
    this.listeners.get(ev).push(fn);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  querySelectorAll(selector) {
    const out = [];
    const match = (node) => {
      if (selector.startsWith(".")) return node.classList.contains(selector.slice(1));
      if (selector.startsWith("[")) {
        const m = selector.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/);
        if (!m) return false;
        return m[2] === undefined ? node.attributes.has(m[1]) : node.attributes.get(m[1]) === m[2];
      }
      return node.tagName === selector.toUpperCase();
    };
    const walk = (node) => {
      for (const child of node.children) {
        if (match(child)) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }
  get firstChild() { return this.children[0] ?? null; }
  removeChild(child) {
    const i = this.children.indexOf(child);
    if (i >= 0) this.children.splice(i, 1);
  }
}

const origDocument = globalThis.document;
const origFetch = globalThis.fetch;

afterEach(() => {
  if (origDocument === undefined) delete globalThis.document;
  else globalThis.document = origDocument;
  if (origFetch === undefined) delete globalThis.fetch;
  else globalThis.fetch = origFetch;
});

function installFakeDom(routes) {
  globalThis.document = {
    createElement: (tag) => new FakeElement(tag),
    createTextNode: (text) => {
      const n = new FakeElement("#text");
      n._text = String(text ?? "");
      return n;
    },
  };
  globalThis.fetch = async (url) => {
    const key = String(url);
    const handler = routes[key];
    if (!handler) {
      return { ok: false, status: 404, text: async () => "not found", json: async () => ({ ok: false }) };
    }
    const payload = typeof handler === "function" ? handler() : handler;
    const text = typeof payload === "string" ? payload : JSON.stringify(payload);
    return {
      ok: true,
      status: 200,
      text: async () => text,
      json: async () => JSON.parse(text),
    };
  };
}

describe("Bluetooth page view (#114 published and unpublished commands)", () => {
  it("shows published, renamed, unpublished, and retained saved commands on the Bluetooth page", async () => {
    const inventory = {
      version: 1,
      devices: [
        {
          id: "bt_1730000000_42",
          name: "Work Laptop",
          type: "btkeyboard",
          bdaddr: "AA:BB:CC:DD:EE:FF",
          harmony: true,
          commands: [
            { name: "Wake and Sign In", delayMs: 35, script: "KEY escape\nWAIT 500\nTEXT secret\nKEY enter" },
            { name: "Déverrouiller", delayMs: 35, script: "KEY escape" },
            { name: "Home", delayMs: 35, script: "KEY home" },
            { name: "!!!", delayMs: 35, script: "KEY enter" },
          ],
        },
      ],
    };
    const activityConfig = {
      ok: true,
      revision: "rev-1",
      activityList: { Activities: [] },
      mapList: { ButtonMaps: [] },
      functionList: { FunctionMaps: [] },
      deviceList: {
        DevicesWithFeatures: [
          {
            Device: {
              "Id-": 39000050,
              Name: "Work Laptop",
              Transport: 64,
              AutoDetectedDevice: { Id: "melodious-bt-39000050" },
              Tokens: { Parameters: [{ Key: "{d}", Value: "bt_1730000000_42" }] },
            },
            Commands: [
              { Name: "Home", Parameters: [{ Key: "{c}", Value: "tvhome" }] },
              { Name: "Wake and Sign In", Parameters: [{ Key: "{c}", Value: "saved57616b6520616e64205369676e20496e" }] },
              { Name: "Deverrouiller", Parameters: [{ Key: "{c}", Value: "saved44c3a9766572726f75696c6c6572" }] },
              { Name: "Home Saved", Parameters: [{ Key: "{c}", Value: "saved486f6d65" }] },
              { Name: "Old Sign In", Parameters: [{ Key: "{c}", Value: "saved4f6c64205369676e20496e" }] },
            ],
            DeviceFeatures: [],
          },
        ],
      },
    };
    installFakeDom({
      "/api/bt-call": { ok: true, connected: false, responseRaw: "" },
      "/api/bt-text-status": { ok: true, runtime: false, state: "missing" },
      "/export/bluetooth": inventory,
      "/api/activity-config": activityConfig,
    });
    const { state } = await import("../public/js/state.js");
    state.config = activityConfig;
    state.configLoaded = true;
    const { createBluetoothView } = await import("../public/js/views/bluetooth.js");
    const root = new FakeElement("section");
    const view = createBluetoothView(root);
    view.onShow();
    // Flush async microtasks for fetch + renderInventory
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 10));

    const text = root.textContent;
    assert.match(text, /3 saved scripts/, "Harmony summary counts published saved scripts");
    assert.match(text, /On Harmony/, "published command shows On Harmony badge");
    assert.match(text, /Deverrouiller/, "transliterated Harmony name is shown");
    assert.match(text, /Home Saved/, "clashing command's disambiguated Harmony name is shown");
    assert.match(text, /Not on Harmony/, "unpublished command is clearly marked");
    assert.match(text, /!!!/, "unpublished command name is listed");
    assert.match(text, /ASCII letters or digits/i, "unpublished reason is shown");
    assert.match(text, /Old Sign In/, "retained deleted command still used by Harmony is noted");
  });
});
