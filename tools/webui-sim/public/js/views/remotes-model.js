/* Remotes page model (#remotes): the hub's RF remotes, pairing one more, and
   the Harmony Smart Control's buttons. Pure functions; views/remotes.js
   renders and saves.

   hal pairs Harmony RF remotes on the hub itself, with no cloud: rf.info
   lists the radio's pairing slots, and after a pair hal unpairs any older
   remote of the same kind (one per EquadID). So a Smart Control joins a
   Touch, but replaces an older Smart Control.

   The Smart Control (EquadID 16414) keeps no setup and never syncs. It sends
   key codes, and the hub answers them from the 16414 maps in MapList:
   16414Activity<id> while that activity runs (without one the remote does
   nothing in that activity) and 16414Root for the three activity buttons
   and while everything is off. The engine adds Off to the root map itself. */

import { cloneJsonResource, createAllocator, sameButton } from "../wizard-model.js";
import { keyOn } from "./touch-model.js";

export const SMART_CONTROL_EQUAD = "16414";
export const TOUCH_EQUAD = "16417";
export const ROOT_MAP_ID = `${SMART_CONTROL_EQUAD}Root`;

/* hal accepts only these EquadIDs (others are unpaired at once). 16417 is
   every remote with a screen (Touch, Elite, Ultimate…); its skin tells them
   apart, and only the Touch's skin is known. `role` decides what the
   Remotes page offers for that remote. */
const KINDS = {
  16414: { name: "Harmony Smart Control remote", short: "Smart Control", role: "smart-control" },
  16417: { name: "Harmony remote with a screen", short: "screen remote", role: "screen" },
  16420: { name: "Harmony keyboard", short: "keyboard", role: "other" },
  16422: { name: "Harmony Companion remote", short: "Companion", role: "other" },
  16423: { name: "Harmony Companion remote", short: "Companion", role: "other" },
  34830: { name: "Harmony USB dongle", short: "dongle", role: "other" },
};
const SKINS = { 99: { name: "Harmony Touch", short: "Touch" } };

/* How to put a remote in pairing mode, for the kinds proven on hardware. */
export const PAIRING_STEPS = {
  16414: "hold Menu and Mute together for about 5 seconds",
};

function remoteKind(equadId, skinId = "") {
  const id = String(equadId ?? "");
  const kind = KINDS[id] ?? { name: `Unknown remote (EquadID ${id || "?"})`, short: "remote", role: "other" };
  const skin = id === TOUCH_EQUAD ? SKINS[String(skinId)] : null;
  return skin ? { ...kind, ...skin } : kind;
}

export function remoteKindName(equadId, skinId = "") {
  return remoteKind(equadId, skinId).name;
}

/* hal's JSON reply, given as the raw text codex_hal_ltcp printed or as an
   object; null when it isn't one. */
function halReply(reply) {
  if (reply && typeof reply === "object") return reply;
  const text = String(reply ?? "");
  const start = text.indexOf("{");
  if (start === -1) return null;
  try {
    return JSON.parse(text.slice(start));
  } catch (_) {
    return null;
  }
}

/** rf.info -> { hub, remotes: [{ slot, equadId, rfid, skinId, name, short, role }] }, or null. */
export function parseRfInfo(reply) {
  const json = halReply(reply);
  if (!json || Number(json.code) !== 200 || !json.data || typeof json.data !== "object") return null;
  const devices = Array.isArray(json.data.Devices) ? json.data.Devices : [];
  const remotes = devices
    .map((d) => ({
      slot: Number(d?.DeviceIndex) || 0,
      equadId: String(d?.EquadID ?? ""),
      rfid: String(d?.RFID ?? ""),
      skinId: String(d?.SkinId ?? ""),
    }))
    .filter((r) => r.slot > 0 && r.equadId && r.equadId !== "0")
    .map((r) => ({ ...r, ...remoteKind(r.equadId, r.skinId) }))
    .sort((a, b) => a.slot - b.slot);
  return {
    hub: { equadId: String(json.data.EquadID ?? ""), rfid: String(json.data.RFID ?? "") },
    remotes,
  };
}

const remoteIdentity = (r) => `${r.slot}:${r.equadId}:${r.rfid}`;

/**
 * What one pairing window did, from the slot tables read before and after
 * it. `status`:
 *   "paired"    a remote joined (`replaced` lists older ones of its kind hal dropped)
 *   "lost"      a remote of another kind is gone; the page must say so loudly
 *   "already"   a remote paired but no slot changed: it was this hub's already and kept its slot
 *   "timeout"   nothing joined in the window
 *   "unknown"   the table couldn't be read afterwards
 */
export function pairOutcome({ before, after, pair } = {}) {
  const was = parseRfInfo(before);
  const now = parseRfInfo(after);
  const reported = halReply(pair);
  // A remote that pairs into the slot it already had gets code 200 with no
  // data (seen on hardware 2026-10-31); a window nobody used gets 500.
  const halPaired = Number(reported?.code) === 200;
  if (!was || !now) {
    return { status: "unknown", added: [], removed: [], replaced: [], lost: [], halPaired };
  }
  const wasIds = new Set(was.remotes.map(remoteIdentity));
  const nowIds = new Set(now.remotes.map(remoteIdentity));
  const added = now.remotes.filter((r) => !wasIds.has(remoteIdentity(r)));
  const removed = was.remotes.filter((r) => !nowIds.has(remoteIdentity(r)));
  const addedKinds = new Set(added.map((r) => r.equadId));
  const replaced = removed.filter((r) => addedKinds.has(r.equadId));
  const lost = removed.filter((r) => !addedKinds.has(r.equadId));
  let status;
  if (lost.length) status = "lost";
  else if (added.length) status = "paired";
  else status = halPaired ? "already" : "timeout";
  return { status, added, removed, replaced, lost, halPaired, remotes: now.remotes };
}

/* -- The Smart Control's activity buttons (16414Root) ------------------------
   Each takes an activity on a press and another on a long press, as
   Logitech's app set them up. */

export const ACTIVITY_BUTTONS = [
  { key: "WatchTVActivity", label: "TV" },
  { key: "MovieActivity", label: "Movie" },
  { key: "MusicActivity", label: "Music" },
];

const PRESS = "ButtonAction";
const LONG_PRESS = "ButtonLongPressAction";

function maps(config) {
  return config?.mapList?.ButtonMaps ?? [];
}

function activityIds(config) {
  return new Set((config?.activityList?.Activities ?? []).map((a) => String(a["Id-"])));
}

function rootMap(config) {
  return maps(config).find((m) => m?.ButtonMapIdentifier === ROOT_MAP_ID) ?? null;
}

/* "" for no action; the activity id for an activity action; null for any
   other action, which the page leaves alone. */
function actionActivity(action) {
  if (!action) return "";
  if (String(action.__type ?? "").includes("ButtonActivityAction")) return String(action["ActivityId-"] ?? "");
  return null;
}

/**
 * The three activity buttons as rows: { key, label, press, longPress } where
 * press/longPress are an activity id, "" for nothing, or null for an action
 * this page doesn't edit. `missing` lists ids that name a deleted activity.
 */
export function readActivityButtons(config) {
  const map = rootMap(config);
  const known = activityIds(config);
  const rows = ACTIVITY_BUTTONS.map(({ key, label }) => {
    const button = map?.Buttons?.find((b) => b?.ButtonKey === key);
    const press = actionActivity(button?.[PRESS]);
    const longPress = actionActivity(button?.[LONG_PRESS]);
    return {
      key,
      label,
      press,
      longPress,
      missing: [press, longPress].filter((id) => id && !known.has(id)),
    };
  });
  return { hasRoot: Boolean(map), rows };
}

function activityAction(activityId, eventType) {
  return {
    __type: "ButtonActivityAction",
    "ActivityId-": Number(activityId),
    Order: 0,
    EventType: eventType,
    Id: 0,
  };
}

function harmonyDate() {
  return `/Date(${Date.now()}+0000)/`;
}

/* Surface identities for a new 16414 map, borrowed from an existing one. */
function smartControlSurface(config) {
  const source = maps(config).find((m) => String(m?.ButtonMapIdentifier ?? "").startsWith(SMART_CONTROL_EQUAD)) ?? {};
  return {
    "ButtonMapSurfaceId-": source["ButtonMapSurfaceId-"] ?? null,
    "RemoteId-": source["RemoteId-"] ?? null,
    "SurfaceId-": source["SurfaceId-"] ?? null,
  };
}

/* The hub refuses a MapList that names a deleted activity anywhere, so a
   button left on one saves as nothing. */
function keptActivity(known, id) {
  return id && known.has(String(id)) ? String(id) : "";
}

/**
 * MapList with the activity buttons set as `rows` says. A row's press or
 * longPress is an activity id or "" for nothing; null leaves that action
 * as it is. Only buttons whose action changes are touched, a button still
 * on a deleted activity is cleared (a new choice must exist), and a missing
 * 16414Root is created. Returns { mapList, changed }.
 */
export function buildActivityButtonsMapList(config, rows) {
  const known = activityIds(config);
  const mapList = cloneJsonResource(config?.mapList ?? { ButtonMaps: [] });
  if (!Array.isArray(mapList.ButtonMaps)) mapList.ButtonMaps = [];
  const alloc = createAllocator(config);
  let map = mapList.ButtonMaps.find((m) => m?.ButtonMapIdentifier === ROOT_MAP_ID);
  const created = !map;
  if (!map) {
    map = {
      "ButtonMapId-": alloc.mapId(),
      Buttons: [],
      ...smartControlSurface(config),
      __type: "RootButtonMap",
      ButtonMapIdentifier: ROOT_MAP_ID,
      DateModified: harmonyDate(),
      Sequences: null,
    };
  }
  if (!Array.isArray(map.Buttons)) map.Buttons = [];
  let changed = false;
  for (const row of rows) {
    if (!ACTIVITY_BUTTONS.some((b) => b.key === row.key)) continue;
    let button = map.Buttons.find((b) => b?.ButtonKey === row.key);
    for (const [field, value, eventType] of [[PRESS, row.press, 1], [LONG_PRESS, row.longPress, 2]]) {
      if (value === null || value === undefined) continue;
      const current = actionActivity(button?.[field]);
      let wanted = String(value);
      if (wanted && !known.has(wanted)) {
        if (wanted !== current) throw new Error("An activity button names an activity that no longer exists.");
        wanted = keptActivity(known, wanted);
      }
      if (current === wanted) continue;
      if (!button) {
        if (!wanted) continue;
        button = {
          ButtonId: alloc.id(),
          __type: "HardRemoteButton",
          [PRESS]: null,
          ButtonDoublePressAction: null,
          FunctionGroupType: 0,
          ButtonState: 1,
          ButtonKey: row.key,
          [LONG_PRESS]: null,
        };
        map.Buttons.push(button);
      }
      button[field] = wanted ? activityAction(wanted, eventType) : null;
      changed = true;
    }
  }
  if (changed) {
    map.DateModified = harmonyDate();
    if (created) mapList.ButtonMaps.push(map);
  }
  return { mapList, changed };
}

/**
 * After a save the hub didn't confirm: does the hub's config now hold the
 * rows that were sent ("saved"), the rows it had before ("unchanged"), or
 * something else ("changed")?
 */
export function activityButtonsSaveOutcome(config, baseRows, sentRows) {
  const now = readActivityButtons(config).rows;
  const known = activityIds(config);
  const matches = (value, hub, kept) => value === null || value === undefined || hub === (kept ? keptActivity(known, value) : String(value));
  const same = (rows, kept) => rows.every((row) => {
    const hub = now.find((r) => r.key === row.key);
    return hub && matches(row.press, hub.press, kept) && matches(row.longPress, hub.longPress, kept);
  });
  if (same(sentRows, true)) return "saved";
  if (same(baseRows, false)) return "unchanged";
  return "changed";
}

/* -- Keys on both remotes -----------------------------------------------------
   The Smart Control (16414) and the Touch or other screen remote (16417)
   each have their own key map per activity, which Logitech fills alike and
   the editor keeps alike unless the owner sets a key for one remote only.
   This lists, per activity, the keys where they differ. Only keys both
   remotes physically have are compared (the Touch has no number keys). */

const ACTION_FIELDS = [PRESS, LONG_PRESS, "ButtonDoublePressAction"];

function hardButtons(map) {
  return (map?.Buttons ?? []).filter((b) => b?.__type === "HardRemoteButton" && ACTION_FIELDS.some((f) => b?.[f]));
}

/* One remote's hard key with an action, by the other remote's spelling. */
function keyButton(map, remote, key) {
  const name = keyOn(remote, key);
  return name ? hardButtons(map).find((b) => b.ButtonKey === name) ?? null : null;
}

/**
 * Per activity: { activityId, name, smartMap, touchMap, onlySmart,
 * onlyTouch, differ }. The lists hold key names in each remote's spelling
 * (DVR on the Touch, Dvr on the Smart Control; `differ` uses the Smart
 * Control's). `smartMap`/`touchMap` false means that remote has no keys in
 * the activity.
 */
export function keyComparison(config) {
  const byId = new Map(maps(config).map((m) => [m?.ButtonMapIdentifier, m]));
  return (config?.activityList?.Activities ?? [])
    .slice()
    .sort((a, b) => (a.ActivityOrder ?? 0) - (b.ActivityOrder ?? 0))
    .map((activity) => {
      const id = String(activity["Id-"]);
      const smartMap = byId.get(`${SMART_CONTROL_EQUAD}Activity${id}`) ?? null;
      const touchMap = byId.get(`${TOUCH_EQUAD}Activity${id}`) ?? null;
      const result = {
        activityId: id,
        name: activity.Name || activity.ActivityDisplayName || `Activity ${id}`,
        smartMap: Boolean(smartMap),
        touchMap: Boolean(touchMap),
        onlySmart: [],
        onlyTouch: [],
        differ: [],
      };
      if (!smartMap || !touchMap) return result;
      const keys = new Set([...hardButtons(smartMap), ...hardButtons(touchMap)]
        .map((b) => keyOn(SMART_CONTROL_EQUAD, b.ButtonKey))
        .filter((k) => k && keyOn(TOUCH_EQUAD, k)));
      for (const key of keys) {
        const smart = keyButton(smartMap, SMART_CONTROL_EQUAD, key);
        const touch = keyButton(touchMap, TOUCH_EQUAD, key);
        if (smart && touch && sameButton(smart, touch)) continue;
        if (smart && touch) result.differ.push(key);
        else if (smart) result.onlySmart.push(key);
        else result.onlyTouch.push(keyOn(TOUCH_EQUAD, key));
      }
      return result;
    });
}
