import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { BUTTON_KEY_BY_LABEL } from "../public/js/remote-layout.js";
import {
  BUTTON_GROUPS,
  buildActivityGraph,
  deriveDefaultButtons,
  isWizardOwnedActivityMap,
  wizardButtonStats,
} from "../public/js/wizard-model.js";
import { KEY_LABELS, activityKeys, canonicalKey, deviceKeys, validateMapList } from "../public/js/views/remote-model.js";
import {
  SMART_CONTROL_HARD_KEYS,
  TOUCH_HARD_KEYS,
  buildTouchControlsMapList,
  hardKeysFor,
  keyOn,
  readHardKeys,
} from "../public/js/views/touch-model.js";

/* #234: the keys either side of 0 on the remotes without a screen. hal names
   them from its key table (re/bin/hal VA 0x461AE8): HID 0x0056 ("--") is
   NumberPlus and HID 0x0028 ("E") is NumberEnter, for the Smart Control
   (16414) and the Companion (16422, 16423) alike. The Touch and Elite (16417)
   have no such keys. */

const FIXTURE = JSON.parse(readFileSync(new URL("../fixtures/activity-config.json", import.meta.url), "utf8"));
const SHIELD = "48113644";
const NEW_KEYS = ["NumberPlus", "NumberEnter"];
const NO_SCREEN = ["16414", "16422", "16423"];

/* The fixture with Companion maps (16422, 16423) alike with the Smart Control's. */
function withCompanions() {
  const config = structuredClone(FIXTURE);
  const smart = config.mapList.ButtonMaps.filter((m) => /^16414Activity/.test(m.ButtonMapIdentifier));
  for (const [n, remote] of ["16422", "16423"].entries()) {
    config.mapList.ButtonMaps.push(...smart.map((m, i) => ({
      ...structuredClone(m),
      "ButtonMapId-": 70000000 + n * 1000 + i,
      ButtonMapIdentifier: m.ButtonMapIdentifier.replace(/^16414/, remote),
      "RemoteId-": 4242 + n,
      Buttons: m.Buttons.map((b, j) => ({ ...structuredClone(b), ButtonId: 71000000 + n * 100000 + i * 100 + j })),
    })));
  }
  return config;
}
const mapOf = (maps, id) => maps.find((m) => m.ButtonMapIdentifier === id);
const keyIn = (map, key) => map?.Buttons.find((b) => b.__type === "HardRemoteButton" && b.ButtonKey === key);

describe("#234 the -- and E keys", () => {
  it("are hard keys on every remote without a screen, and not on the Touch", () => {
    for (const key of NEW_KEYS) {
      assert.ok(SMART_CONTROL_HARD_KEYS.includes(key), key);
      assert.ok(!TOUCH_HARD_KEYS.includes(key), key);
      for (const remote of NO_SCREEN) {
        assert.ok(hardKeysFor(remote).includes(key), `${remote} ${key}`);
        assert.equal(keyOn(remote, key), key);
      }
      assert.equal(keyOn("16417", key), "");
    }
  });

  it("are offered by the activity editor's button step, without guessing a command for them", () => {
    const offered = BUTTON_GROUPS.flatMap(([, keys]) => keys);
    for (const key of NEW_KEYS) assert.ok(offered.includes(key), key);
    assert.equal(BUTTON_KEY_BY_LABEL.Dash, "NumberPlus");
    assert.equal(BUTTON_KEY_BY_LABEL.Enter, "NumberEnter");
    assert.equal(wizardButtonStats({}).assignable, 38);
    const player = { id: "1", name: "Player", commands: ["Play", "Enter", "Dash", "-"].map((name, i) => ({ name, functionId: i })) };
    const defaults = deriveDefaultButtons([{ deviceId: "1", roleType: "PlayMovieActivityRole" }], [player]);
    for (const key of NEW_KEYS) assert.equal(defaults[key], undefined, key);
  });

  it("are saved by the activity editor to every remote without a screen, and not the Touch", () => {
    const config = withCompanions();
    const command = (name) => ({ deviceId: "74521691", command: { name, functionId: 0 }, hold: null });
    const draft = { name: "Dash and Enter", type: 1, roles: [], buttons: { NumberPlus: command("Dash"), NumberEnter: command("Enter") } };
    const graph = buildActivityGraph({ config, draft, editId: null });
    const maps = graph.mapList.ButtonMaps;
    const wizard = maps.find((m) => isWizardOwnedActivityMap(m, graph.activityId));
    for (const remote of NO_SCREEN) {
      const map = mapOf(maps, `${remote}Activity${graph.activityId}`);
      assert.equal(keyIn(map, "NumberPlus")?.ButtonAction.CommandName, "Dash", remote);
      assert.equal(keyIn(map, "NumberEnter")?.ButtonAction.CommandName, "Enter", remote);
    }
    assert.equal(map16417Keys(maps, graph.activityId).filter((k) => NEW_KEYS.includes(k)).length, 0);
    assert.ok(wizard);
  });

  it("are saved by each remote's key editor, and reach the other remotes without a screen", () => {
    for (const remote of NO_SCREEN) {
      const config = withCompanions();
      const read = (r) => readHardKeys(config, SHIELD, { remote: r });
      const mine = read(remote);
      const deviceId = mine.rows.find((r) => r.action?.kind === "command").action.deviceId;
      const row = (key, name) => ({ key, buttonKey: key, buttonId: null, action: { kind: "command", deviceId, command: name, functionId: 0 }, pressMode: "standard", longPress: null, doublePress: null });
      const withNew = (rows) => [...rows.filter((r) => !NEW_KEYS.includes(r.buttonKey)), row("NumberPlus", "Dash"), row("NumberEnter", "Enter")];
      const others = NO_SCREEN.filter((r) => r !== remote);
      const mapList = buildTouchControlsMapList(config, {
        hard: { activityId: SHIELD, rows: withNew(mine.rows), base: mine.base },
        twins: others.map((r) => ({ remote: r, rows: withNew(read(r).rows), base: read(r).base })),
      }, { remote });
      for (const r of NO_SCREEN) {
        const map = mapOf(mapList.ButtonMaps, `${r}Activity${SHIELD}`);
        assert.equal(keyIn(map, "NumberPlus")?.ButtonAction.CommandName, "Dash", `${remote} -> ${r}`);
        assert.equal(keyIn(map, "NumberEnter")?.ButtonAction.CommandName, "Enter", `${remote} -> ${r}`);
        // Every other key on that remote is as it was.
        const before = mapOf(config.mapList.ButtonMaps, `${r}Activity${SHIELD}`);
        assert.deepEqual(map.Buttons.filter((b) => !NEW_KEYS.includes(b.ButtonKey)), before.Buttons);
      }
      assert.deepEqual(mapOf(mapList.ButtonMaps, `16417Activity${SHIELD}`), mapOf(config.mapList.ButtonMaps, `16417Activity${SHIELD}`));
      assert.deepEqual(validateMapList(mapList), []);
    }
  });

  it("light up the on-screen remote's -- and Enter keys", () => {
    const config = withCompanions();
    const map = mapOf(config.mapList.ButtonMaps, `16414Activity${SHIELD}`);
    const deviceId = map.Buttons[0].ButtonAction["DeviceId-"];
    map.Buttons.push(
      { __type: "HardRemoteButton", ButtonId: 1, ButtonKey: "NumberPlus", FunctionGroupType: 0, ButtonState: 1, ButtonAction: { __type: "ButtonCommandAction", "DeviceId-": deviceId, CommandName: "Dash", "FunctionId-": 0, EventType: 1, Order: 0, Id: 0 }, ButtonLongPressAction: null, ButtonDoublePressAction: null },
      { __type: "HardRemoteButton", ButtonId: 2, ButtonKey: "NumberEnter", FunctionGroupType: 0, ButtonState: 1, ButtonAction: { __type: "ButtonCommandAction", "DeviceId-": deviceId, CommandName: "Enter", "FunctionId-": 0, EventType: 1, Order: 0, Id: 0 }, ButtonLongPressAction: null, ButtonDoublePressAction: null },
    );
    const keys = activityKeys(config, SHIELD);
    assert.equal(keys.get("NumberPlus")?.press.command, "Dash");
    assert.equal(keys.get("NumberEnter")?.press.command, "Enter");
    for (const key of NEW_KEYS) {
      assert.equal(canonicalKey(key), key);
      assert.ok(KEY_LABELS[key], key);
    }
    const device = { id: "9", name: "Box", commands: [{ name: "Dash" }, { name: "Enter" }] };
    assert.equal(deviceKeys(device).get("NumberPlus")?.press.command, "Dash");
    assert.equal(deviceKeys(device).get("NumberEnter")?.press.command, "Enter");
  });
});

function map16417Keys(maps, activityId) {
  return (mapOf(maps, `16417Activity${activityId}`)?.Buttons ?? []).map((b) => b.ButtonKey);
}
