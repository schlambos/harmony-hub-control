// Honest send failures: a tap the engine refused used to show as sent, and a
// held key showed the engine's raw JSON. The hub now adds engineCode and
// needsPairing to those replies (codex_webui.c write_send_problem); the web
// app says what happened and, when pairing the device again is the fix,
// keeps a banner on the remote and device pages until it works again.
import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  describeSendFailure,
  engineMessage,
  pairingBannersMarkup,
  sendProblem,
  startProblemText,
} from "../public/js/views/send-problem-model.js";
import { startFailureText } from "../public/js/views/restrictions-model.js";
import {
  clearPairingProblem,
  hasPairingProblems,
  notePairingProblem,
  noteSendWorked,
  onPairingProblems,
  pairingProblemsFor,
  resetPairingProblems,
} from "../public/js/pairing-problems.js";
import { mountPairingBanners } from "../public/js/views/pairing-banner.js";
import { ApiError, irSend } from "../public/js/api.js";
import { clearSendLog, repeatCommand, sendCommand, sendLogEntries } from "../public/js/views/remote-pad.js";
import { state } from "../public/js/state.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SIM_DIR = path.join(HERE, "..");

// Engine replies as a hub's /data/codex/ir-events.log has them (ids changed).
const REAUTH_HOLD = JSON.stringify({ cmd: "harmony.engine?holdaction", code: 403, id: "codex-hold-x-1", msg: "Request Forbidden Reauthentication Required", data: { deviceId: "101" } });
const NO_COMMAND_TAP = `${JSON.stringify({ cmd: "harmony.engine?holdaction", code: 566, id: "codex-1-2-3", msg: "Command not found for device id:101" })}\n`;
const IP_REAUTH = { deviceId: "101", kind: "ip-register", reason: "ip-reauth" };
const BT = { deviceId: "202", kind: "bluetooth", reason: "bt-not-connected" };

const tapError = (data) => new ApiError(data.reply, 200, { ok: true, sent: false, ...data });

describe("send-problem-model", () => {
  it("reads the two members, and nothing from a reply without them", () => {
    assert.deepEqual(sendProblem({ engineCode: 403, needsPairing: IP_REAUTH }), { engineCode: 403, needsPairing: IP_REAUTH });
    assert.deepEqual(sendProblem({ needsPairing: BT }), { engineCode: null, needsPairing: BT });
    assert.equal(sendProblem({ ok: false, error: "x" }), null);
    assert.equal(sendProblem(null), null);
    assert.equal(sendProblem({ engineCode: "403", needsPairing: { deviceId: 101, reason: "ip-reauth" } }), null, "wrong types are ignored");
  });

  it("takes the engine's msg out of its raw reply", () => {
    assert.equal(engineMessage(NO_COMMAND_TAP), "Command not found for device id:101");
    assert.equal(engineMessage("Could not connect Bluetooth device"), "");
    assert.equal(engineMessage("{broken"), "");
  });

  it("says a device needs pairing instead of quoting the engine", () => {
    const held = describeSendFailure(new ApiError(REAUTH_HOLD, 502, { ok: false, error: REAUTH_HOLD, engineCode: 403, needsPairing: IP_REAUTH }),
      { deviceName: "Sony TV", command: "VolumeUp" });
    assert.equal(held.text, "Sony TV no longer accepts commands from this hub. It needs to be paired with the hub again.");
    assert.equal(held.note, "needs pairing again");
    assert.deepEqual(held.needsPairing, IP_REAUTH);
    assert.doesNotMatch(held.text, /\{/);
    const bt = describeSendFailure(tapError({ reply: "Could not connect Bluetooth device 202 …", needsPairing: BT }), { deviceName: "Shield", command: "Home" });
    assert.equal(bt.text, "Shield isn't connected to the hub over Bluetooth.");
    assert.deepEqual(bt.needsPairing, BT);
  });

  it("words the engine codes it knows, and quotes the msg of others", () => {
    const words = (data) => describeSendFailure(tapError(data), { deviceName: "TiVo", command: "Guide" });
    assert.equal(words({ engineCode: 560, reply: "{}" }).text, "Couldn't send Guide to TiVo: the hub is still loading its setup. Try again in a moment.");
    assert.equal(words({ engineCode: 566, reply: NO_COMMAND_TAP }).text, "Couldn't send Guide to TiVo: the hub has no “Guide” command for it.");
    const other = words({ engineCode: 601, reply: JSON.stringify({ code: 601, msg: "Capod time is set" }) });
    assert.equal(other.text, "Couldn't send Guide to TiVo: Capod time is set (code 601).");
    assert.equal(other.note, "Capod time is set");
    assert.equal(words({ engineCode: 599, reply: "" }).text, "Couldn't send Guide to TiVo: the hub's engine refused it (code 599).");
  });

  it("keeps older hubs' and network errors as they were", () => {
    const old = describeSendFailure(new ApiError(REAUTH_HOLD, 502, { ok: false, error: REAUTH_HOLD }), { deviceName: "Sony TV", command: "VolumeUp" });
    assert.equal(old.text, "Couldn't send VolumeUp to Sony TV — Request Forbidden Reauthentication Required", "an older hub's raw reply still loses its JSON");
    assert.equal(old.needsPairing, null);
    assert.equal(describeSendFailure(new ApiError("Sim server not reachable", 0)).text, "Couldn't send the command to the device — Sim server not reachable");
  });

  it("explains an activity start that failed on a member device", () => {
    const nameOf = (id) => ({ 101: "Sony TV" })[id] ?? "";
    const err = new ApiError("Request Forbidden Reauthentication Required", 502, { ok: false, engineCode: 403, needsPairing: IP_REAUTH });
    assert.equal(startProblemText(err, nameOf), "Sony TV no longer accepts commands from this hub. It needs to be paired with the hub again.");
    assert.equal(startFailureText("Watch TV", err, nameOf), "Couldn't start Watch TV. Sony TV no longer accepts commands from this hub. It needs to be paired with the hub again.");
    const loading = new ApiError("Account config data is not available", 502, { ok: false, engineCode: 560 });
    assert.equal(startFailureText("Watch TV", loading), "Couldn't start Watch TV. The hub is still loading its setup. Try again in a moment.");
    assert.equal(startFailureText("Watch TV", new ApiError("boom", 502, { ok: false, engineCode: 500 })), "Couldn't start Watch TV — boom");
    assert.equal(startFailureText("Watch TV", new ApiError("x", 409, { restricted: true })), "“Watch TV” can't be started now: it has time restrictions.");
  });

  it("builds a banner per device, escaped, with a dismiss button", () => {
    const html = pairingBannersMarkup([IP_REAUTH, BT], (id) => ({ 101: "Sony <TV>", 202: "Shield" })[id]);
    assert.match(html, /<strong>Sony &lt;TV&gt;<\/strong> no longer accepts commands from this hub\./);
    assert.match(html, /after the hub is replaced/);
    assert.match(html, /<strong>Shield<\/strong> isn&#39;t connected to the hub over Bluetooth\./);
    assert.equal((html.match(/data-pairing-dismiss=/g) ?? []).length, 2);
    assert.equal(pairingBannersMarkup([]), "");
  });
});

describe("pairing problems list", () => {
  beforeEach(() => resetPairingProblems());

  it("keeps one entry per device and tells listeners only about changes", () => {
    let calls = 0;
    const off = onPairingProblems(() => calls++);
    notePairingProblem(IP_REAUTH);
    notePairingProblem({ ...IP_REAUTH });
    assert.equal(calls, 1, "the same problem again is no change");
    notePairingProblem(BT);
    assert.deepEqual(pairingProblemsFor(["202", "101", "999"]).map((p) => p.deviceId), ["202", "101"]);
    clearPairingProblem("101");
    clearPairingProblem("101");
    assert.equal(calls, 3);
    assert.deepEqual(pairingProblemsFor(["101"]), []);
    notePairingProblem({ deviceId: "", reason: "ip-reauth" });
    assert.equal(calls, 3, "a problem with no device is ignored");
    off();
  });

  it("clears a device only when the command that failed works again", () => {
    notePairingProblem(IP_REAUTH, "VolumeUp");
    noteSendWorked("101", "PowerOn"); // an IR command: proves nothing
    assert.equal(pairingProblemsFor(["101"]).length, 1);
    noteSendWorked("101", "VolumeUp");
    assert.equal(pairingProblemsFor(["101"]).length, 0);
    notePairingProblem(BT); // from an activity start: no command
    noteSendWorked("202", "Home");
    assert.equal(hasPairingProblems(), false);
  });
});

/* A page root with one banner slot, enough for pairing-banner.js. */
function fakeRoot() {
  const slot = { innerHTML: "", dataset: {} };
  const listeners = [];
  return {
    slot,
    querySelector: (sel) => (sel === "[data-pairing-banners]" ? slot : null),
    addEventListener: (ev, fn) => listeners.push(fn),
    contains: () => true,
    click(deviceId) {
      const button = { dataset: { pairingDismiss: deviceId } };
      for (const fn of listeners) fn({ target: { closest: () => button } });
    },
  };
}

describe("pairing banners on a page", () => {
  beforeEach(() => resetPairingProblems());

  it("shows the page's own devices, follows the list, and dismisses", () => {
    const root = fakeRoot();
    const banners = mountPairingBanners(root, { deviceIds: () => ["101"], nameOf: () => "Sony TV" });
    banners.update();
    assert.equal(root.slot.innerHTML, "");
    notePairingProblem(BT);
    assert.equal(root.slot.innerHTML, "", "another page's device");
    notePairingProblem(IP_REAUTH);
    assert.match(root.slot.innerHTML, /Sony TV<\/strong> no longer accepts/);
    const before = root.slot.innerHTML;
    root.slot.innerHTML = before; // unchanged: left alone
    banners.update();
    assert.equal(root.slot.innerHTML, before);
    root.click("101");
    assert.equal(root.slot.innerHTML, "");
    assert.deepEqual(pairingProblemsFor(["101"]), []);
  });

  it("fills a slot the page just re-rendered", () => {
    const root = fakeRoot();
    const banners = mountPairingBanners(root, { deviceIds: () => ["101"], nameOf: () => "Sony TV" });
    notePairingProblem(IP_REAUTH);
    root.slot.innerHTML = "";
    root.slot.dataset = {}; // a fresh slot
    banners.update();
    assert.match(root.slot.innerHTML, /Sony TV/);
  });
});

/* -- api.irSend and the keypad, against a fake hub ------------------------- */

const origFetch = globalThis.fetch;
const origDocument = globalThis.document;
let answer; // (form) → [status, json]
let snack;

function useFakeHub() {
  globalThis.fetch = async (url, options = {}) => {
    const form = Object.fromEntries(new URLSearchParams(options.body ?? ""));
    const [status, json] = answer(form, String(url));
    return { ok: status < 400, status, text: async () => JSON.stringify(json) };
  };
  snack = { innerHTML: "" };
  globalThis.document = { getElementById: (id) => (id === "snackbars" ? snack : null), querySelectorAll: () => [] };
  state.config = {
    deviceList: {
      DevicesWithFeatures: [
        { Device: { "Id-": 101, Name: "Sony TV", Transport: 65 }, Commands: [], DeviceFeatures: [] },
        { Device: { "Id-": 202, Name: "Shield", Transport: 32 }, Commands: [], DeviceFeatures: [] },
      ],
    },
  };
}

function restore() {
  globalThis.fetch = origFetch;
  globalThis.document = origDocument;
}

describe("api.irSend", () => {
  beforeEach(useFakeHub);
  afterEach(restore);

  it("throws for a tap that wasn't sent, with the hub's reply as data", async () => {
    answer = () => [200, { ok: true, deviceId: "101", command: "Guide", sent: false, engineCode: 566, reply: NO_COMMAND_TAP }];
    await assert.rejects(irSend({ deviceId: "101", command: "Guide" }), (err) => {
      assert.ok(err instanceof ApiError);
      assert.equal(err.data.engineCode, 566);
      assert.equal(err.message, NO_COMMAND_TAP);
      return true;
    });
  });

  it("resolves a tap that went out, and one from a hub without \"sent\"", async () => {
    answer = () => [200, { ok: true, sent: true, reply: "{\"code\":200}" }];
    assert.equal((await irSend({ deviceId: "101", command: "Guide" })).sent, true);
    answer = () => [200, { ok: true, reply: "{\"code\":566}" }];
    assert.equal((await irSend({ deviceId: "101", command: "Guide" })).ok, true, "an older hub: as before");
  });
});

describe("the keypad on a failed send", () => {
  beforeEach(() => {
    useFakeHub();
    resetPairingProblems();
    clearSendLog();
  });
  afterEach(restore);

  it("says the TV needs pairing, logs it, and raises the banner; a later send clears it", async () => {
    answer = () => [200, { ok: true, sent: false, engineCode: 403, needsPairing: IP_REAUTH, reply: REAUTH_HOLD }];
    const lines = [];
    const ok = await sendCommand({ deviceId: "101", command: "Guide" }, { status: (text, kind) => lines.push([text, kind]) });
    assert.equal(ok, false);
    assert.match(snack.innerHTML, /Sony TV no longer accepts commands from this hub/);
    assert.deepEqual(lines.at(-1), ["Guide → Sony TV · Guide · needs pairing again", "error"]);
    assert.equal(sendLogEntries()[0].note, "needs pairing again");
    assert.equal(pairingProblemsFor(["101"]).length, 1);
    answer = () => [200, { ok: true, sent: true, reply: "{\"code\":200}" }];
    assert.equal(await sendCommand({ deviceId: "101", command: "InputHdmi1" }), true);
    assert.equal(pairingProblemsFor(["101"]).length, 1, "another command working proves little");
    assert.equal(await sendCommand({ deviceId: "101", command: "Guide" }), true);
    assert.equal(pairingProblemsFor(["101"]).length, 0);
  });

  it("clears after a hold that ran its course, not when the press is answered", async () => {
    notePairingProblem(BT, "DirectionUp");
    let presses = 0;
    answer = (form) => {
      if (form.status === "press") presses += 1;
      return [200, { ok: true, status: form.status, holdId: form.holdId }];
    };
    const stop = repeatCommand({ deviceId: "202", command: "DirectionUp" }, { label: "Up" });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(presses, 1);
    assert.equal(pairingProblemsFor(["202"]).length, 1, "still listed while the key is held");
    stop();
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(pairingProblemsFor(["202"]).length, 0);
  });

  it("does the same for a held key the hub refused", async () => {
    answer = (form) => form.status === "press"
      ? [502, { ok: false, error: "Could not connect Bluetooth device 202 at 00:11:22:33:44:55 (native code 500).", needsPairing: BT, status: "press", holdId: form.holdId }]
      : [200, { ok: true }];
    const stop = repeatCommand({ deviceId: "202", command: "DirectionUp" }, { label: "Up" });
    await new Promise((r) => setTimeout(r, 50));
    stop();
    await new Promise((r) => setTimeout(r, 20));
    assert.match(snack.innerHTML, /Shield isn&#39;t connected to the hub over Bluetooth\./);
    assert.equal(pairingProblemsFor(["202"]).length, 1);
  });
});

/* -- the simulator plays the hub's replies --------------------------------- */

function startSim() {
  const port = 19400 + Math.floor(Math.random() * 300); // a range no other sim test uses
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

describe("simulator send failures", () => {
  let sim;
  let deviceId;
  let activityId;
  before(async () => {
    sim = await startSim();
    const config = await (await origFetch(`${sim.base}/api/activity-config`)).json();
    deviceId = String(config.deviceList.DevicesWithFeatures[0].Device["Id-"]);
    activityId = String(config.activityList.Activities[0]["Id-"]);
  });
  after(() => sim?.child.kill());

  const post = async (p, form) => {
    const res = await origFetch(`${sim.base}${p}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form).toString(),
    });
    return { status: res.status, json: await res.json() };
  };
  const inject = async (body) => {
    const res = await origFetch(`${sim.base}/api/sim/send-failure`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    assert.equal(res.status, 200);
  };

  it("treats an injected 200 as a send that works, like the hub", async () => {
    await inject({ deviceId, engineCode: 200, msg: "OK" });
    assert.equal((await post("/api/ir-send", { deviceId, command: "PowerOn" })).json.sent, true);
    await inject({ deviceId, clear: true });
  });

  it("answers a good tap with sent:true and the engine's 200", async () => {
    const { status, json } = await post("/api/ir-send", { deviceId, command: "PowerOn" });
    assert.equal(status, 200);
    assert.equal(json.sent, true);
    assert.equal(JSON.parse(json.reply).code, 200);
  });

  it("answers a TV that needs pairing like the hub, for taps and holds", async () => {
    await inject({ deviceId, engineCode: 403, msg: "Request Forbidden Reauthentication Required" });
    const tap = await post("/api/ir-send", { deviceId, command: "PowerOn" });
    assert.equal(tap.status, 200);
    assert.equal(tap.json.ok, true);
    assert.equal(tap.json.sent, false);
    assert.equal(tap.json.engineCode, 403);
    assert.deepEqual(tap.json.needsPairing, { deviceId, kind: "ip-register", reason: "ip-reauth" });
    const hold = await post("/api/ir-send", { deviceId, command: "VolumeUp", status: "press", holdId: "abcdefgh1234" });
    assert.equal(hold.status, 502);
    assert.equal(hold.json.ok, false);
    assert.equal(JSON.parse(hold.json.error).data.deviceId, deviceId);
    assert.deepEqual(hold.json.needsPairing, { deviceId, kind: "ip-register", reason: "ip-reauth" });
  });

  it("answers a Bluetooth connect that failed, then clears", async () => {
    await inject({ deviceId, btFailed: true });
    const tap = await post("/api/ir-send", { deviceId, command: "PowerOn" });
    assert.equal(tap.json.sent, false);
    assert.equal(tap.json.engineCode, undefined, "the engine was never asked");
    assert.equal(tap.json.needsPairing.reason, "bt-not-connected");
    await inject({ deviceId, clear: true });
    assert.equal((await post("/api/ir-send", { deviceId, command: "PowerOn" })).json.sent, true);
  });

  it("fails an activity start with the engine's code and the member device", async () => {
    await inject({ activityId, engineCode: 403, msg: "Request Forbidden Reauthentication Required", dataDeviceId: deviceId });
    const run = await post("/api/activity-run", { activityId });
    assert.equal(run.status, 502);
    assert.equal(run.json.engineCode, 403);
    assert.deepEqual(run.json.needsPairing, { deviceId, kind: "ip-register", reason: "ip-reauth" });
    await inject({ activityId, engineCode: 560, msg: "Account config data is not available" });
    const loading = await post("/api/activity-run", { activityId });
    assert.equal(loading.json.engineCode, 560);
    assert.equal(loading.json.needsPairing, undefined);
    await post("/api/sim/reset", {});
    assert.equal((await post("/api/activity-run", { activityId })).status, 200, "reset clears injected failures");
  });
});
