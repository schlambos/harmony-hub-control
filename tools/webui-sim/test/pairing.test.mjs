// Device pairing, the shared parts: which devices pair with something, what
// their status says (from GET /api/pairing, the TV services and this tab's
// failed sends), how a network TV pairing session's steps go, and whether
// pairing a TV again gave back the same TV. Plus the simulator's
// /api/pairing, which mirrors codex_webui.c render_pairing_json.
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  androidTvPairStep,
  androidTvRepairProblem,
  androidTvRepairResult,
  closeUndoTvId,
  keepPolling,
  pairingFiles,
  pairingKindOf,
  pairingStateLabel,
  pairingStatus,
  PAIRING_KINDS,
} from "../public/js/views/pairing-model.js";
import { pairingBannersMarkup } from "../public/js/views/send-problem-model.js";
import { pairingToUndo } from "../public/js/views/androidtv-model.js";
import { mountPairingBanners } from "../public/js/views/pairing-banner.js";
import { notePairingProblem, resetPairingProblems } from "../public/js/pairing-problems.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SIM_DIR = path.join(HERE, "..");

const entry = (device) => ({ Device: { "Id-": 1, Name: "X", ...device }, Commands: [] });
const SONY_REGISTER = { Url: "http://{IP}/sony/accessControl", Header: "", Body: "{}" };

describe("pairingKindOf", () => {
  it("knows each kind the hub's status route knows, and nothing else", () => {
    assert.equal(pairingKindOf(entry({ Transport: 65, RegisterSection: SONY_REGISTER })), "ip-register");
    assert.equal(pairingKindOf(entry({ Transport: 64, RegisterSection: null })), "", "a Roku pairs with nothing");
    assert.equal(pairingKindOf(entry({ Transport: 32, BTAddress: "" })), "bluetooth");
    assert.equal(pairingKindOf(entry({ Transport: 33 })), "bluetooth");
    assert.equal(pairingKindOf(entry({ Transport: 64, AutoDetectedDevice: { Id: "melodious-androidtv-1" } })), "androidtv");
    assert.equal(pairingKindOf(entry({ Transport: 64, AutoDetectedDevice: { Id: "melodious-webos-1" } })), "webos");
    assert.equal(pairingKindOf(entry({ Transport: 64, AutoDetectedDevice: { Id: "melodious-bt-1" } })), "bt-keyboard");
    assert.equal(pairingKindOf(entry({ Transport: 64, AutoDetectedDevice: { Id: "melodious-ha-1" } })), "");
    assert.equal(pairingKindOf(entry({ Transport: 64, AutoDetectedDevice: { Id: "melodious-switch2-1" } })), "");
    assert.equal(pairingKindOf(entry({ Transport: 1 })), "");
    assert.equal(pairingKindOf(entry({})), "", "a missing Transport is IR");
    assert.equal(pairingKindOf(null), "");
  });
});

describe("the hub and the web app agree on kinds", () => {
  it("classifies the shared fixture as tools/pairing-status-test expects", () => {
    const fixture = JSON.parse(readFileSync(path.join(SIM_DIR, "fixtures/pairing-kinds.json"), "utf8"));
    for (const e of fixture.DevicesWithFeatures) assert.equal(pairingKindOf(e), e.Device.ExpectKind, e.Device.Name);
  });
});

describe("pairingStatus", () => {
  it("reads the hub's files", () => {
    const files = pairingFiles({ devices: [
      { deviceId: "101", kind: "ip-register", state: "paired" },
      { deviceId: "102", kind: "ip-register", state: "not-paired" },
      { deviceId: "201", kind: "bluetooth", state: "needs-attention", reason: "bt-not-connected" },
      { deviceId: 5, kind: "bluetooth" },
    ] });
    assert.equal(files.size, 3, "an entry without a string id is dropped");
    assert.equal(pairingStatus({ kind: "ip-register", file: files.get("101") }).state, "paired");
    const sony = pairingStatus({ kind: "ip-register", file: files.get("102") });
    assert.equal(sony.state, "not-paired");
    assert.match(sony.text, /after the hub is replaced/);
    assert.equal(sony.canPair, false, "PR 4 pairs these");
    const shield = pairingStatus({ kind: "bluetooth", file: files.get("201") });
    assert.equal(shield.state, "needs-attention");
    assert.match(shield.text, /Bluetooth/);
    assert.equal(pairingStatus({ kind: "bluetooth", file: { state: "unknown" } }).state, "unknown");
    assert.equal(pairingStatus({ kind: "" }), null);
  });

  it("puts this tab's failed send first", () => {
    const status = pairingStatus({ kind: "ip-register", file: { state: "paired" }, problem: { reason: "ip-reauth" } });
    assert.equal(status.state, "needs-attention");
    assert.match(status.text, /no longer knows this hub/);
  });

  it("reads a network TV's live status", () => {
    assert.equal(pairingStatus({ kind: "androidtv", tv: null }).state, "not-paired");
    assert.equal(pairingStatus({ kind: "androidtv", tv: { connected: true } }).state, "paired");
    assert.equal(pairingStatus({ kind: "androidtv", tv: { connected: false } }).state, "unknown", "off isn't unpaired");
    assert.equal(pairingStatus({ kind: "androidtv", tv: null }).canPair, true);
    assert.equal(pairingStatus({ kind: "webos", tv: { paired: false } }).state, "not-paired");
    assert.equal(pairingStatus({ kind: "webos", tv: { paired: true, connected: false } }).state, "paired");
  });

  it("labels each state with words", () => {
    assert.deepEqual(["paired", "not-paired", "needs-attention", "unknown"].map(pairingStateLabel),
      ["Paired", "Not paired", "Needs pairing", "Pairing unknown"]);
    assert.equal(PAIRING_KINDS["bt-keyboard"].where, "#bluetooth");
  });
});

describe("a network TV pairing session", () => {
  it("maps codex_androidtv's states onto the sheet's steps", () => {
    assert.deepEqual(["preparing", "connecting", "code", "checking", "paired", "failed", "idle", "weird"].map(androidTvPairStep),
      ["waiting", "waiting", "code", "checking", "done", "failed", "failed", "failed"]);
  });

  it("keeps the device when the same TV comes back, and refuses another", () => {
    const same = androidTvRepairResult({ wantedTvId: "androidtv1a2b3c4d", pairedTvId: "androidtv1a2b3c4d", deviceName: "Den TV" });
    assert.deepEqual(same, { ok: true, undo: "", text: "Den TV is paired with the hub again." });
    const other = androidTvRepairResult({ wantedTvId: "androidtv1a2b3c4d", pairedTvId: "androidtv99999999", deviceName: "Den TV" });
    assert.equal(other.ok, false);
    assert.equal(other.undo, "androidtv99999999");
    assert.match(other.text, /Nothing was changed/);
    assert.equal(androidTvRepairResult({ wantedTvId: "androidtv1a2b3c4d", pairedTvId: "" }).ok, false);
  });
});

describe("the re-pair sheet's decisions", () => {
  const wanted = "androidtv1a2b3c4d";
  const devicesByTv = new Map([[wanted, "Den TV"], ["androidtv55555555", "Living Room TV"]]);

  it("refuses an address that is another device's TV before pairing", () => {
    const found = [{ host: "192.168.1.41", paired: "androidtv55555555" }, { host: "192.168.1.40", paired: wanted }];
    assert.match(androidTvRepairProblem({ host: "192.168.1.41", wanted, found, devicesByTv }), /Living Room TV's TV/);
    assert.equal(androidTvRepairProblem({ host: "192.168.1.40", wanted, found, devicesByTv }), "", "its own TV");
    assert.equal(androidTvRepairProblem({ host: "192.168.1.99", wanted, found, devicesByTv }), "", "a TV the hub doesn't know: try it");
    const tvs = [{ id: "androidtv77777777", host: "192.168.1.42" }];
    assert.match(androidTvRepairProblem({ host: "192.168.1.42", wanted, tvs, devicesByTv }), /another TV the hub knows/);
  });

  it("keeps polling except while waiting for the person's code", () => {
    assert.equal(keepPolling("waiting", false), true);
    assert.equal(keepPolling("checking", false), true);
    assert.equal(keepPolling("code", false), false);
    assert.equal(keepPolling("code", true), true, "after a code was sent, until the hub moves on");
  });

  it("on close, undoes only another TV that no hub device uses", () => {
    const uses = new Set(devicesByTv.keys());
    assert.equal(closeUndoTvId({ tvId: wanted }, wanted), "", "never its own TV");
    assert.equal(closeUndoTvId({ tvId: "" }, wanted), "");
    assert.equal(closeUndoTvId(null, wanted), "");
    const other = closeUndoTvId({ tvId: "androidtv55555555" }, wanted);
    assert.equal(pairingToUndo(other, { devicesByTv: uses }), "", "another device's TV stays paired");
    const stray = closeUndoTvId({ tvId: "androidtv99999999" }, wanted);
    assert.equal(pairingToUndo(stray, { devicesByTv: uses }), "androidtv99999999");
  });
});

describe("the banner's Pair now", () => {
  beforeEach(() => resetPairingProblems());

  it("shows only for devices the sheet can pair", () => {
    const html = pairingBannersMarkup([
      { deviceId: "301", reason: "ip-reauth" },
      { deviceId: "101", reason: "ip-reauth" },
    ], () => "TV", (id) => id === "301");
    assert.equal((html.match(/data-pairing-pair="301"/g) ?? []).length, 1);
    assert.doesNotMatch(html, /data-pairing-pair="101"/);
  });

  it("opens the sheet for that device", () => {
    const slot = { innerHTML: "", dataset: {} };
    const listeners = [];
    const root = {
      querySelector: (sel) => (sel === "[data-pairing-banners]" ? slot : null),
      addEventListener: (ev, fn) => listeners.push(fn),
      contains: () => true,
    };
    const opened = [];
    mountPairingBanners(root, { deviceIds: () => ["301"], nameOf: () => "Den TV", canPair: () => true, onPair: (id) => opened.push(id) });
    notePairingProblem({ deviceId: "301", kind: "ip-register", reason: "ip-reauth" });
    assert.match(slot.innerHTML, /Pair now/);
    const button = { dataset: { pairingPair: "301" } };
    for (const fn of listeners) fn({ target: { closest: (sel) => (sel === "[data-pairing-pair]" ? button : null) } });
    assert.deepEqual(opened, ["301"]);
  });
});

/* -- the simulator's GET /api/pairing ----------------------------------------- */

function startSim() {
  const port = 19700 + Math.floor(Math.random() * 250); // a range no other sim test uses
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(SIM_DIR, "server.mjs")], {
      env: { ...process.env, PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`sim did not start: ${out}`));
    }, 8000);
    child.stdout.on("data", (chunk) => {
      out += chunk.toString();
      if (out.includes("Listening")) {
        clearTimeout(timer);
        resolve({ child, base: `http://127.0.0.1:${port}` });
      }
    });
    child.stderr.on("data", (chunk) => (out += chunk.toString()));
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`sim exited (${code}): ${out}`));
    });
  });
}

describe("simulator pairing status", () => {
  let sim;
  let bluetoothId = "";
  before(async () => {
    sim = await startSim();
    const config = await (await fetch(`${sim.base}/api/activity-config`)).json();
    const bt = config.deviceList.DevicesWithFeatures.find((e) => pairingKindOf(e) === "bluetooth");
    bluetoothId = bt ? String(bt.Device["Id-"]) : "";
  });
  after(() => sim?.child.kill());

  const json = async (p, body) => {
    const res = await fetch(`${sim.base}${p}`, body === undefined ? {} : {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    return res.json();
  };
  const form = (p, fields) => fetch(`${sim.base}${p}`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString(),
  }).then((r) => r.json());
  const entryFor = async (id) => (await json("/api/pairing")).devices.find((d) => d.deviceId === id);

  it("lists only devices that pair with something, as the fixture has them", async () => {
    const reply = await json("/api/pairing");
    assert.equal(reply.ok, true);
    const config = await json("/api/activity-config");
    const kinds = new Map(config.deviceList.DevicesWithFeatures.map((e) => [String(e.Device["Id-"]), pairingKindOf(e)]));
    for (const d of reply.devices) assert.equal(d.kind, kinds.get(d.deviceId), d.deviceId);
    assert.equal(reply.devices.length, [...kinds.values()].filter(Boolean).length);
  });

  it("marks a device whose send needed pairing, until the command that failed works", async (t) => {
    if (!bluetoothId) return t.skip("the fixture has no Bluetooth device");
    await json("/api/sim/send-failure", { deviceId: bluetoothId, btFailed: true });
    await form("/api/ir-send", { deviceId: bluetoothId, command: "Home" });
    assert.deepEqual(await entryFor(bluetoothId), { deviceId: bluetoothId, kind: "bluetooth", state: "needs-attention", reason: "bt-not-connected" });
    await json("/api/sim/send-failure", { deviceId: bluetoothId, clear: true });
    await form("/api/ir-send", { deviceId: bluetoothId, command: "Back" });
    assert.equal((await entryFor(bluetoothId)).state, "needs-attention", "another command proves little");
    await form("/api/ir-send", { deviceId: bluetoothId, command: "Home" });
    assert.notEqual((await entryFor(bluetoothId)).state, "needs-attention");
  });

  it("clears a held key's marker once the hold ran its course", async (t) => {
    if (!bluetoothId) return t.skip("the fixture has no Bluetooth device");
    await json("/api/sim/send-failure", { deviceId: bluetoothId, btFailed: true });
    await form("/api/ir-send", { deviceId: bluetoothId, command: "DirectionUp", status: "press", holdId: "pairhold0001" });
    assert.equal((await entryFor(bluetoothId)).state, "needs-attention");
    await json("/api/sim/send-failure", { deviceId: bluetoothId, clear: true });
    await form("/api/ir-send", { deviceId: bluetoothId, command: "DirectionUp", status: "press", holdId: "pairhold0002" });
    assert.equal((await entryFor(bluetoothId)).state, "needs-attention", "not on the press");
    await form("/api/ir-send", { deviceId: bluetoothId, command: "DirectionUp", status: "release", holdId: "pairhold0002" });
    assert.notEqual((await entryFor(bluetoothId)).state, "needs-attention");
  });

  it("drops every marker and registration on reset", async () => {
    await json("/api/sim/pairing", { deviceId: "999", cookie: true });
    assert.deepEqual((await json("/api/sim/pairing", { clear: true })).cookies, []);
  });
});
