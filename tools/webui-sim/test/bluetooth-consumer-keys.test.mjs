/*
 * Source-level contract for the Bluetooth Consumer page keys (#89).
 *
 * The hub's web UI and Android app send key names to /api/bt-call; the C
 * server maps those names to HID usages and builds the report.  These tests
 * pin the three things that must agree:
 *
 *   1. bt_key_usage() maps each name to the standard Consumer page usage.
 *   2. bt_keyboard_report_hex() emits report ID 3 (Consumer Control) with a
 *      4-byte payload for usages >= 0x200, and keeps the old report ID 1
 *      keyboard report for ordinary keys.
 *   3. The web UI and Android key lists actually offer the names.
 *
 * The stock btkeyboard descriptor already declares report ID 3 as a
 * Consumer Control collection with two 16-bit usages, so no descriptor or
 * re-pairing change is involved.  codex_bt_pair_agent's GET_REPORT reply
 * size (report ID + 4 payload bytes) is checked as the matching contract.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const WEBUI_C = path.join(REPO, "payload", "source", "codex_webui.c");
const PAIR_AGENT_C = path.join(REPO, "payload", "source", "codex_bt_pair_agent.c");
const WEB_MODEL = path.join(
  REPO, "tools", "webui-sim", "public", "js", "views", "bluetooth-model.js");
const ANDROID_SURFACE = path.join(
  REPO, "Android", "app", "src", "main", "kotlin", "app", "melodious",
  "ui", "remote", "RemoteSurfaces.kt");
const HUB_EMU_DEVICES = path.join(
  REPO, "tools", "hub-emu", "seed", "resources", "DeviceList.json");

/* HID Usage Tables 1.12, Consumer page (0x0C).  The first two are the
 * usages the Chromecast with Google TV remote sends.  The rest are the
 * standard usages for the labels the issue asks for; acvoice/acpanel are
 * the verified Chromecast alternatives for search and settings. */
const CONSUMER_KEYS = {
  achome: 0x223,      // AC Home
  acback: 0x224,      // AC Back
  acmenu: 0x040,      // Menu
  acsearch: 0x221,    // AC Search
  acguide: 0x08d,     // Media Select Program Guide
  acinfo: 0x1bd,      // AL OEM Features/Tips/Tutorial Browser (INFO)
  acsettings: 0x096,  // Media Select Tape (Google TV SETTINGS)
  acexit: 0x204,      // AC Exit
  acvoice: 0x0cf,     // Voice Command
  acpanel: 0x2a2,     // AC Desktop Show All Applications (control panel)
};

function read(file) {
  return fs.readFileSync(file, "utf8");
}

function functionBody(source, signature) {
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, `missing ${signature}`);
  const end = source.indexOf("\n}", start);
  assert.notEqual(end, -1, `unterminated ${signature}`);
  return source.slice(start, end);
}

function usageMap(source) {
  const body = functionBody(source, "static int bt_key_usage");
  const map = new Map();
  const re = /if \(strcmp\(key, "([^"]+)"\) == 0[^;]*\) return (0x[0-9a-fA-F]+);/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    map.set(m[1], Number.parseInt(m[2], 16));
  }
  return map;
}

function hexBytes(hex) {
  return Buffer.from(hex, "hex");
}

describe("Bluetooth Consumer page keys (#89)", () => {
  const source = read(WEBUI_C);
  const usages = usageMap(source);

  it("maps every requested key name to the standard Consumer usage", () => {
    for (const [name, usage] of Object.entries(CONSUMER_KEYS)) {
      assert.equal(usages.get(name), usage, `${name} usage`);
      assert.ok(usage >= 0x001 && usage <= 0x2ff,
        `${name} 0x${usage.toString(16)} is inside the descriptor's 0x001..0x2ff range`);
    }
  });

  it("keeps the keyboard-page key names unchanged", () => {
    assert.equal(usages.get("home"), 0x4a);
    assert.equal(usages.get("menu"), 0x65);
    assert.equal(usages.get("escape"), 0x29);
    assert.equal(usages.get("enter"), 0x28);
  });

  it("emits a 6-byte Consumer report (A1 03 + two 16-bit usages)", () => {
    const body = functionBody(source, "static int bt_keyboard_report_hex");
    assert.ok(body.includes('"A103%02X%02X0000"'),
      "consumer press format must be A103 + little-endian usage + zero second usage");
    assert.ok(body.includes('"A10300000000"'),
      "consumer release format must be A103 + four zero payload bytes");
    assert.ok(!body.includes('"A103%02X%02X000000"'),
      "the draft's 7-byte consumer report is one byte too long");

    for (const [name, usage] of Object.entries(CONSUMER_KEYS)) {
      const press = `A103${(usage & 0xff).toString(16).padStart(2, "0")}` +
        `${((usage >> 8) & 0xff).toString(16).padStart(2, "0")}0000`.toUpperCase();
      const release = "A10300000000";
      assert.equal(hexBytes(press).length, 6, `${name} press length`);
      assert.equal(hexBytes(release).length, 6, `${name} release length`);
      assert.equal(hexBytes(press)[0], 0xa1);
      assert.equal(hexBytes(press)[1], 0x03);
      assert.equal(hexBytes(press)[2], usage & 0xff);
      assert.equal(hexBytes(press)[3], (usage >> 8) & 0xff);
      assert.deepEqual([...hexBytes(press).subarray(4)], [0, 0]);
      assert.deepEqual([...hexBytes(release).subarray(2)], [0, 0, 0, 0]);
    }
  });

  it("keeps the old 10-byte keyboard report for keyboard-page keys", () => {
    const body = functionBody(source, "static int bt_keyboard_report_hex");
    assert.ok(body.includes('"A101%02X00%02X0000000000"'));
    assert.ok(body.includes('"A1010000000000000000"'));
    const enter = 0x28;
    const press = `A1010000${enter.toString(16).padStart(2, "0")}0000000000`.toUpperCase();
    assert.equal(hexBytes(press).length, 10);
    assert.equal(hexBytes(press)[0], 0xa1);
    assert.equal(hexBytes(press)[1], 0x01);
  });

  it("matches the pair agent's GET_REPORT size for report ID 3", () => {
    const body = functionBody(read(PAIR_AGENT_C), "static size_t hid_input_report_size");
    assert.match(body, /case 0x03: return 5; \/\* consumer control \*\//);
    // 5 = report ID + two 16-bit usages; the A1 DATA prefix is added on top.
    assert.equal(5 + 1, 6);
  });

  it("offers every key in the web UI key list with a human label", () => {
    const model = read(WEB_MODEL);
    for (const name of Object.keys(CONSUMER_KEYS)) {
      const re = new RegExp(`\\{ code: "${name}", label: "([^"]+)" \\}`);
      const m = model.match(re);
      assert.ok(m, `web UI QUICK_KEYS is missing ${name}`);
      assert.ok(m[1].trim().length > 0, `${name} needs a label`);
    }
  });

  it("offers every key on the Android keyboard surface", () => {
    const surface = read(ANDROID_SURFACE);
    for (const name of Object.keys(CONSUMER_KEYS)) {
      assert.ok(surface.includes(`"${name}"`), `Android keyboard surface is missing ${name}`);
    }
  });

  it("keeps Home/Back on the stock Bluetooth device command list", () => {
    const data = JSON.parse(read(HUB_EMU_DEVICES));
    const entries = data.DevicesWithFeatures || data.devices || [];
    const bt = entries.find((entry) => Number(entry?.Device?.Transport) === 32);
    assert.ok(bt, "no Transport 32 device in the hub-emu seed");
    const commands = new Map((bt.Commands || []).map((c) => [c.Name, c.KeyCode || ""]));
    assert.match(commands.get("Home") || "", /0C000223/i,
      "stock Home command must send Consumer AC Home");
    assert.match(commands.get("Back") || "", /0C000224/i,
      "stock Back command must send Consumer AC Back");
  });
});
