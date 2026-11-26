// The Backup view's restore lock (views/backup.js) on a fake DOM: the label
// while the hub is not ready, polls that don't re-announce an unchanged
// message, and "Restore without waiting", which sends force=1.
import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";

class FakeClassList {
  constructor() { this.set = new Set(); }
  add(...names) { for (const n of names) for (const p of String(n).split(/\s+/)) if (p) this.set.add(p); }
  remove(...names) { for (const n of names) this.set.delete(n); }
  contains(name) { return this.set.has(name); }
  toString() { return [...this.set].join(" "); }
}

let focused = null;

class FakeElement {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.attributes = new Map();
    this.listeners = new Map();
    this.classList = new FakeClassList();
    this.parentNode = null;
    this.disabled = false;
    this.placeholder = "";
    this._text = "";
    this._value = undefined;
  }
  set className(v) { this.classList = new FakeClassList(); this.classList.add(v); }
  get className() { return this.classList.toString(); }
  set textContent(v) { this._text = String(v ?? ""); this.children = []; }
  get textContent() {
    return this.children.length ? this.children.map((c) => c.textContent).join("") : this._text;
  }
  // A select's value is its first option's until one is chosen.
  set value(v) { this._value = String(v); }
  get value() {
    if (this._value !== undefined) return this._value;
    if (this.tagName === "SELECT") return this.children[0]?.getAttribute("value") ?? "";
    return "";
  }
  setAttribute(k, v) { this.attributes.set(k, String(v)); }
  getAttribute(k) { return this.attributes.get(k) ?? null; }
  removeAttribute(k) { this.attributes.delete(k); }
  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  replaceChildren(...nodes) {
    this.children = [];
    this._text = "";
    for (const n of nodes) this.appendChild(n);
  }
  after(node) {
    const siblings = this.parentNode.children;
    node.parentNode = this.parentNode;
    siblings.splice(siblings.indexOf(this) + 1, 0, node);
  }
  remove() {
    if (!this.parentNode) return;
    const siblings = this.parentNode.children;
    siblings.splice(siblings.indexOf(this), 1);
    this.parentNode = null;
  }
  focus() { focused = this; }
  addEventListener(ev, fn) {
    if (!this.listeners.has(ev)) this.listeners.set(ev, []);
    this.listeners.get(ev).push(fn);
  }
  click() { for (const fn of this.listeners.get("click") ?? []) fn({ preventDefault() {} }); }
  dispatch(ev) { for (const fn of this.listeners.get(ev) ?? []) fn({}); }
  all(pred) {
    const out = [];
    const walk = (node) => node.children.forEach((c) => { if (pred(c)) out.push(c); walk(c); });
    walk(this);
    return out;
  }
  byId(id) { return this.all((n) => n.getAttribute("id") === id)[0] ?? null; }
  buttonNamed(text) { return this.all((n) => n.tagName === "BUTTON" && n.textContent === text)[0] ?? null; }
}

const VALID_BUNDLE = JSON.stringify({
  format: "harmony-owner-bundle-v2",
  files: {
    "DeviceList.json": '{"DevicesWithFeatures":[]}', "FunctionList.json": '{"FunctionMaps":[]}',
    "ProtocolList.json": '{"Protocols":[]}', "ActivityList.json": '{"Activities":[]}',
    "MapList.json": '{"ButtonMaps":[]}', "AutomationConfig.json": "{}",
    "mqtt-config.json": '{"broker":{},"baseTopic":"harmony"}',
    "wpa_supplicant.conf": 'network={\n ssid="x"\n}',
  },
});

const NOT_READY = { ok: true, ready: false, reason: "blank-hub-check", message: "Preparing the store." };
let hub; // what the fake hub answers, and what it was sent
const origDocument = globalThis.document;
const origFetch = globalThis.fetch;

function reply(status, text) {
  return { ok: status < 400, status, text: async () => text, json: async () => JSON.parse(text) };
}

beforeEach(() => {
  focused = null;
  hub = { ready: { ...NOT_READY }, readyStatus: 200, polls: 0, imports: [] };
  globalThis.document = { createElement: (tag) => new FakeElement(tag) };
  globalThis.fetch = async (url, options = {}) => {
    const path = String(url);
    if (path === "/api/config-ready") {
      hub.polls += 1;
      return reply(hub.readyStatus, JSON.stringify(hub.ready));
    }
    if (path === "/import") {
      const fields = Object.fromEntries(new URLSearchParams(options.body));
      hub.imports.push(fields);
      const refused = !hub.ready.ready && fields.force !== "1";
      return reply(refused ? 503 : 200, `<div class='msg'>${refused ? hub.ready.message : "Backup bundle imported."}</div>`);
    }
    if (path.startsWith("/export/")) return reply(200, "{}");
    return reply(404, "not found");
  };
  mock.timers.enable({ apis: ["setTimeout"] });
});

afterEach(() => {
  mock.timers.reset();
  globalThis.document = origDocument;
  globalThis.fetch = origFetch;
});

const flush = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };
const { createBackupView } = await import("../public/js/views/backup.js");

async function openView() {
  const section = new FakeElement("section");
  const view = createBackupView(section);
  await flush();
  const restore = () => section.all((n) => n.tagName === "BUTTON" && n.classList.contains("btn-danger"))[0];
  return { section, view, restore, readiness: section.byId("backupReadiness") };
}

describe("Backup view restore lock", () => {
  it("shows a disabled \"Waiting for the hub…\" restore while the hub is not ready", async () => {
    const { view, restore, readiness } = await openView();
    assert.equal(restore().disabled, true);
    assert.equal(restore().textContent, "Waiting for the hub…");
    assert.match(readiness.textContent, /Preparing the store\..*unlocks by itself/);
    view.onHide();
  });

  it("doesn't rebuild an unchanged message on each poll, and unlocks when ready", async () => {
    const { view, restore, readiness } = await openView();
    const notice = readiness.children[0];
    mock.timers.tick(3000);
    await flush();
    assert.equal(hub.polls, 2);
    assert.equal(readiness.children[0], notice, "the live region kept the same node");
    hub.ready = { ok: true, ready: true, reason: "ready", message: "" };
    mock.timers.tick(3000);
    await flush();
    assert.equal(readiness.children.length, 0);
    assert.equal(restore().disabled, false);
    assert.equal(restore().textContent, "Restore backup");
    mock.timers.tick(30000);
    await flush();
    assert.equal(hub.polls, 3, "polling stops once ready");
    view.onHide();
  });

  it("backs off to 10 s polls after the first minute", async () => {
    const { view } = await openView();
    for (let i = 0; i < 20; i++) {
      mock.timers.tick(3000);
      await flush();
    }
    assert.equal(hub.polls, 21);
    mock.timers.tick(3000);
    await flush();
    assert.equal(hub.polls, 21, "no poll 3 s later");
    mock.timers.tick(7000);
    await flush();
    assert.equal(hub.polls, 22);
    view.onHide();
  });

  it("restores without waiting only after the person asks, and sends force=1", async () => {
    const { section, view, restore, readiness } = await openView();
    section.byId("backupPayload").value = VALID_BUNDLE;
    readiness.buttonNamed("Restore without waiting…").click();
    assert.equal(focused, readiness.buttonNamed("Wait for the hub instead"), "focus stays on the toggle");
    assert.equal(restore().disabled, false);
    assert.equal(restore().textContent, "Restore without waiting");
    restore().click(); // arms the guard
    assert.equal(restore().textContent, "Confirm restore");
    const consequence = section.all((n) => n.classList.contains("danger-guard-consequence"))[0];
    assert.match(consequence.textContent, /^The hub isn't ready to load a restore\./);
    // A poll with the same answer leaves the armed guard alone.
    mock.timers.tick(3000);
    await flush();
    assert.equal(restore().textContent, "Confirm restore");
    section.all((n) => n.classList.contains("danger-guard-input"))[0].value = "replace everything";
    restore().click();
    await flush();
    assert.equal(hub.imports.length, 1);
    assert.equal(hub.imports[0].force, "1");
    assert.equal(hub.imports[0].target, "bundle");
    view.onHide();
  });

  it("can go back to waiting, and a plain restore never sends force", async () => {
    const { section, view, restore, readiness } = await openView();
    readiness.buttonNamed("Restore without waiting…").click();
    readiness.buttonNamed("Wait for the hub instead").click();
    assert.equal(restore().disabled, true);
    assert.equal(restore().textContent, "Waiting for the hub…");
    hub.ready = { ok: true, ready: true, reason: "ready", message: "" };
    mock.timers.tick(3000);
    await flush();
    section.byId("backupPayload").value = VALID_BUNDLE;
    restore().click();
    section.all((n) => n.classList.contains("danger-guard-input"))[0].value = "replace everything";
    restore().click();
    await flush();
    assert.equal(hub.imports.length, 1);
    assert.equal(hub.imports[0].force, undefined);
    view.onHide();
  });

  it("forgets \"restore without waiting\" once the hub is ready", async () => {
    const { view, restore, readiness } = await openView();
    readiness.buttonNamed("Restore without waiting…").click();
    hub.ready = { ok: true, ready: true, reason: "ready", message: "" };
    mock.timers.tick(3000);
    await flush();
    assert.equal(readiness.children.length, 0);
    assert.equal(restore().textContent, "Restore backup");
    view.onHide();
  });

  it("leaves settings restores and hubs without the readiness route unlocked", async () => {
    hub.readyStatus = 404;
    const older = await openView();
    assert.equal(older.restore().disabled, false);
    assert.equal(older.readiness.children.length, 0);
    older.view.onHide();
    hub.readyStatus = 200;
    const { section, view, restore, readiness } = await openView();
    const select = section.byId("backupTarget");
    select.value = "wifi";
    select.dispatch("change");
    assert.equal(restore().disabled, false);
    assert.equal(restore().textContent, "Restore backup");
    assert.equal(readiness.children.length, 0);
    view.onHide();
  });
});
