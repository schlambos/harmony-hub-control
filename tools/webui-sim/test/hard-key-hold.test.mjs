/*
 * #75: a running activity links straight to its on-screen buttons, and a
 * physical hard key can carry a distinct Custom Hold command.
 *
 * The model half proves press=On / hold=Off survives a save and a reload,
 * for this remote and when the change goes to every remote. The source
 * half pins the two UI paths that have no DOM harness in the sim suite.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildTouchControlsMapList,
  readHardKeys,
} from "../public/js/views/touch-model.js";
import { validateMapList } from "../public/js/views/remote-model.js";

const load = () => {
  const raw = JSON.parse(readFileSync(new URL("../fixtures/activity-config.json", import.meta.url), "utf8"));
  const ids = new Set(raw.activityList.Activities.map((a) => String(a["Id-"])));
  raw.mapList.ButtonMaps = raw.mapList.ButtonMaps.filter((m) => m["ActivityId-"] == null || ids.has(String(m["ActivityId-"])));
  raw.functionList = {
    FunctionMaps: [...ids].map((id) => ({ __type: "ActivityFunctionMap", "ActivityId-": Number(id), FunctionGroups: [] })),
  };
  return raw;
};
const fixture = load();
const mapOf = (mapList, id) => mapList.ButtonMaps.find((m) => m.ButtonMapIdentifier === id);

/* An activity with both a Touch map and a Smart Control map, so the
   "all remotes" scope can be checked as well as the default one. */
const ACTIVITY = String(fixture.activityList.Activities.map((a) => a["Id-"]).find((id) => {
  const touch = mapOf(fixture.mapList, `16417Activity${id}`);
  const smart = mapOf(fixture.mapList, `16414Activity${id}`);
  return touch?.Buttons.some((b) => b.__type === "HardRemoteButton")
    && smart?.Buttons.some((b) => b.__type === "HardRemoteButton");
}));
const TOUCH_MAP = `16417Activity${ACTIVITY}`;
const SMART_MAP = `16414Activity${ACTIVITY}`;

const command = (name, functionId) => ({ kind: "command", deviceId: "10", command: name, functionId });

function withHold(read, key, { pressMode = "custom", longPress = command("PowerOff", 2) } = {}) {
  return read.rows.map((row) => (row.buttonKey === key
    ? { ...row, action: command("PowerOn", 1), pressMode, longPress }
    : row));
}

function buttonFor(mapList, identifier, key) {
  return mapOf(mapList, identifier).Buttons.find((b) => b.__type === "HardRemoteButton" && b.ButtonKey === key);
}

describe("hard-key Custom Hold (#75)", () => {
  it("has an activity with a hard key on both remotes", () => {
    assert.notEqual(ACTIVITY, "undefined");
    const touch = readHardKeys(fixture, ACTIVITY);
    const smart = readHardKeys(fixture, ACTIVITY, { remote: "16414" });
    assert.ok(touch.rows.length > 0);
    assert.ok(smart.rows.length > 0);
  });

  it("saves a distinct hold command as EventType 2", () => {
    const read = readHardKeys(fixture, ACTIVITY);
    const key = read.rows[0].buttonKey;
    const mapList = buildTouchControlsMapList(fixture, {
      hard: { activityId: ACTIVITY, rows: withHold(read, key), base: read.base },
    });
    const btn = buttonFor(mapList, TOUCH_MAP, key);
    assert.equal(btn.ButtonAction.CommandName, "PowerOn");
    assert.equal(btn.ButtonAction.EventType, 1);
    assert.equal(btn.ButtonLongPressAction.CommandName, "PowerOff");
    assert.equal(btn.ButtonLongPressAction.EventType, 2);
    assert.deepEqual(validateMapList(mapList), []);
  });

  it("keeps press=On / hold=Off through a save and reload", () => {
    const read = readHardKeys(fixture, ACTIVITY);
    const key = read.rows[0].buttonKey;
    const mapList = buildTouchControlsMapList(fixture, {
      hard: { activityId: ACTIVITY, rows: withHold(read, key), base: read.base },
    });
    const after = { ...fixture, mapList };
    const row = readHardKeys(after, ACTIVITY).rows.find((r) => r.buttonKey === key);
    assert.equal(row.pressMode, "custom");
    assert.equal(row.action.command, "PowerOn");
    assert.equal(row.longPress.command, "PowerOff");
  });

  it("keeps one-shot's long equal to the short command", () => {
    const read = readHardKeys(fixture, ACTIVITY);
    const key = read.rows[0].buttonKey;
    const mapList = buildTouchControlsMapList(fixture, {
      hard: { activityId: ACTIVITY, rows: withHold(read, key, { pressMode: "oneShot", longPress: command("PowerOff", 2) }), base: read.base },
    });
    const btn = buttonFor(mapList, TOUCH_MAP, key);
    assert.equal(btn.ButtonLongPressAction.CommandName, "PowerOn");
    assert.equal(btn.ButtonLongPressAction.EventType, 2);
    const row = readHardKeys({ ...fixture, mapList }, ACTIVITY).rows.find((r) => r.buttonKey === key);
    assert.equal(row.pressMode, "oneShot");
    assert.equal(row.longPress.command, "PowerOn");
  });

  it("clears the hold back to Standard", () => {
    const read = readHardKeys(fixture, ACTIVITY);
    const key = read.rows[0].buttonKey;
    const mapList = buildTouchControlsMapList(fixture, {
      hard: { activityId: ACTIVITY, rows: withHold(read, key, { pressMode: "standard", longPress: null }), base: read.base },
    });
    assert.equal(buttonFor(mapList, TOUCH_MAP, key).ButtonLongPressAction, null);
  });

  it("writes the pair to every remote for the all-remotes scope", () => {
    const touch = readHardKeys(fixture, ACTIVITY);
    const smart = readHardKeys(fixture, ACTIVITY, { remote: "16414" });
    const key = touch.rows.find((r) => smart.rows.some((s) => s.buttonKey === r.buttonKey)).buttonKey;
    const mapList = buildTouchControlsMapList(fixture, {
      hard: { activityId: ACTIVITY, rows: withHold(touch, key), base: touch.base },
      twins: [{ remote: "16414", rows: withHold(smart, key), base: smart.base }],
    });
    for (const identifier of [TOUCH_MAP, SMART_MAP]) {
      const btn = buttonFor(mapList, identifier, key);
      assert.equal(btn.ButtonAction.CommandName, "PowerOn", identifier);
      assert.equal(btn.ButtonLongPressAction.CommandName, "PowerOff", identifier);
    }
  });

  it("leaves the other remote alone for the this-remote-only scope", () => {
    const touch = readHardKeys(fixture, ACTIVITY);
    const smart = readHardKeys(fixture, ACTIVITY, { remote: "16414" });
    const key = touch.rows.find((r) => smart.rows.some((s) => s.buttonKey === r.buttonKey)).buttonKey;
    const mapList = buildTouchControlsMapList(fixture, {
      hard: { activityId: ACTIVITY, rows: withHold(touch, key), base: touch.base },
    });
    assert.equal(buttonFor(mapList, TOUCH_MAP, key).ButtonLongPressAction.CommandName, "PowerOff");
    assert.deepEqual(mapOf(mapList, SMART_MAP), mapOf(fixture.mapList, SMART_MAP));
  });
});

describe("running activity button shortcuts (#75)", () => {
  const read = (name) => readFileSync(new URL(`../public/js/views/${name}`, import.meta.url), "utf8");

  it("links the running activity card to On-screen buttons", () => {
    const source = read("activities-home.js");
    assert.match(source, /href="#touch\/\$\{encodeURIComponent\(id\)\}"/);
    assert.match(source, /aria-label="On-screen buttons for \$\{escapeHtml\(name\)\}"/);
    assert.match(source, /title="On-screen buttons"/);
    assert.match(source, /icon\("tune_outlined"\)/);
    // The Edit shortcut stays beside it.
    assert.match(source, /href="#wizard\/\$\{encodeURIComponent\(id\)\}"/);
  });

  it("links a running activity's Remote header to On-screen buttons", () => {
    const source = read("remote.js");
    assert.match(source, /href="#touch\/\$\{encodeURIComponent\(p\.id\)\}"/);
    assert.match(source, /aria-label="On-screen buttons for \$\{escapeHtml\(name\)\}"/);
    assert.match(source, /icon\("tune_outlined"\)/);
  });

  it("shows the hard-key hold picker and requires a hold command", () => {
    const source = read("touch-screen.js");
    assert.match(source, /data-h-long/);
    assert.match(source, /Hold action \(fires when held ≥600ms\):/);
    assert.match(source, /data-h-long-device/);
    assert.match(source, /data-h-long-search/);
    assert.match(source, /data-h-long-command/);
    assert.match(source, /data-h="done"[\s\S]*?\.disabled = !pick \|\| \(pressMode === "custom" && !longPick\)/);
  });
});
