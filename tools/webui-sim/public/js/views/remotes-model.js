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

export const SMART_CONTROL_EQUAD = "16414";
export const TOUCH_EQUAD = "16417";
export const ROOT_MAP_ID = `${SMART_CONTROL_EQUAD}Root`;

/* hal accepts only these EquadIDs (others are unpaired at once). 16417 is
   every remote with a screen; its skin tells them apart. */
const KINDS = {
  16414: "Harmony Smart Control remote",
  16417: "Harmony remote with a screen",
  16420: "Harmony keyboard",
  16422: "Harmony Companion remote",
  16423: "Harmony Companion remote",
  34830: "Harmony USB dongle",
};
const SKINS = { 99: "Harmony Touch" };

export function remoteKindName(equadId, skinId = "") {
  const id = String(equadId ?? "");
  if (id === TOUCH_EQUAD && SKINS[String(skinId)]) return SKINS[String(skinId)];
  return KINDS[id] ?? `Unknown remote (EquadID ${id || "?"})`;
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

/** rf.info -> { hub, remotes: [{ slot, equadId, rfid, skinId, name }] }, or null. */
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
    .map((r) => ({ ...r, name: remoteKindName(r.equadId, r.skinId) }))
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

/* -- Keys the Smart Control shares with the Touch ----------------------------
   Both remotes answer from their own map, so a key changed in the Touch
   editor (16417 only) leaves the Smart Control on the old command. */

/* The Smart Control's keys besides the activity buttons, as Logitech's
   16414 maps name them. */
const SMART_CONTROL_KEYS = new Set([
  "Blue", "ChannelDown", "ChannelUp", "DirectionDown", "DirectionLeft",
  "DirectionRight", "DirectionUp", "Dvr", "Exit", "FastForward", "Green",
  "Guide", "Info", "Menu", "Number0", "Number1", "Number2", "Number3",
  "Number4", "Number5", "Number6", "Number7", "Number8", "Number9", "Pause",
  "Play", "PrevChannel", "Record", "Red", "Rewind", "Select", "Stop",
  "VolumeDown", "VolumeMute", "VolumeUp", "Yellow",
]);

/** The Smart Control's name for a Touch hard key, or "" when it has no such key. */
export function smartControlKey(touchKey) {
  const key = touchKey === "DVR" ? "Dvr" : String(touchKey ?? "");
  return SMART_CONTROL_KEYS.has(key) ? key : "";
}

const ACTION_FIELDS = [PRESS, LONG_PRESS, "ButtonDoublePressAction"];

function hasAction(button) {
  return ACTION_FIELDS.some((field) => button?.[field]);
}

/* A sequence lives in its own map's Sequences, so a key that runs one can't
   be copied to another map as it is. */
function copyable(button) {
  return ACTION_FIELDS.every((field) => {
    const type = String(button?.[field]?.__type ?? "");
    return !button?.[field] || type.includes("ButtonCommandAction") || type.includes("ButtonActivityAction");
  });
}

/* Touch hard keys that the Smart Control map lacks or maps differently;
   `skipped` are ones that run something only the Touch map holds. */
function keyGaps(touchMap, smartMap) {
  const missing = [];
  const differs = [];
  const skipped = [];
  const seen = new Set();
  for (const button of touchMap?.Buttons ?? []) {
    if (button?.__type !== "HardRemoteButton" || !hasAction(button)) continue;
    const key = smartControlKey(button.ButtonKey);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const smart = smartMap?.Buttons?.find((b) => b?.ButtonKey === key);
    const gap = !smart || !hasAction(smart) ? missing : sameButton(button, smart) ? null : differs;
    if (!gap) continue;
    if (copyable(button)) gap.push({ key, touch: button });
    else skipped.push({ key, touch: button });
  }
  return { missing, differs, skipped };
}

/**
 * Per activity: { activityId, name, smartMap, touchMap, missing, differs,
 * skipped }, where the lists are Smart Control key names (skipped: keys the
 * page can't copy, set them in Activity setup). `smartMap` false means the
 * Smart Control does nothing in that activity.
 */
export function keyParity(config) {
  const byId = new Map(maps(config).map((m) => [m?.ButtonMapIdentifier, m]));
  return (config?.activityList?.Activities ?? [])
    .slice()
    .sort((a, b) => (a.ActivityOrder ?? 0) - (b.ActivityOrder ?? 0))
    .map((activity) => {
      const id = String(activity["Id-"]);
      const smartMap = byId.get(`${SMART_CONTROL_EQUAD}Activity${id}`) ?? null;
      const touchMap = byId.get(`${TOUCH_EQUAD}Activity${id}`) ?? null;
      const gaps = smartMap && touchMap ? keyGaps(touchMap, smartMap) : { missing: [], differs: [], skipped: [] };
      return {
        activityId: id,
        name: activity.Name || activity.ActivityDisplayName || `Activity ${id}`,
        smartMap: Boolean(smartMap),
        touchMap: Boolean(touchMap),
        missing: gaps.missing.map((g) => g.key),
        differs: gaps.differs.map((g) => g.key),
        skipped: gaps.skipped.map((g) => g.key),
      };
    });
}

/**
 * MapList with the Touch's hard keys copied onto the Smart Control maps,
 * for the given activities (all when omitted): missing keys are added and
 * differing ones take the Touch's actions. A Smart Control button keeps its
 * ButtonId and number-pad group; nothing is removed. Returns
 * { mapList, copied } with the number of keys written.
 */
export function buildKeyParityMapList(config, onlyActivityIds = null) {
  const mapList = cloneJsonResource(config?.mapList ?? { ButtonMaps: [] });
  if (!Array.isArray(mapList.ButtonMaps)) mapList.ButtonMaps = [];
  const alloc = createAllocator(config);
  const wanted = onlyActivityIds ? new Set(onlyActivityIds.map(String)) : null;
  const byId = new Map(mapList.ButtonMaps.map((m) => [m?.ButtonMapIdentifier, m]));
  let copied = 0;
  for (const activity of config?.activityList?.Activities ?? []) {
    const id = String(activity["Id-"]);
    if (wanted && !wanted.has(id)) continue;
    const smartMap = byId.get(`${SMART_CONTROL_EQUAD}Activity${id}`);
    const touchMap = byId.get(`${TOUCH_EQUAD}Activity${id}`);
    if (!smartMap || !touchMap) continue;
    const { missing, differs } = keyGaps(touchMap, smartMap);
    if (!missing.length && !differs.length) continue;
    if (!Array.isArray(smartMap.Buttons)) smartMap.Buttons = [];
    for (const { key, touch } of [...missing, ...differs]) {
      const index = smartMap.Buttons.findIndex((b) => b?.ButtonKey === key);
      const existing = index === -1 ? null : smartMap.Buttons[index];
      const copy = cloneJsonResource(touch);
      copy.ButtonId = existing?.ButtonId ?? alloc.id();
      copy.ButtonKey = key;
      copy.FunctionGroupType = existing?.FunctionGroupType ?? (/^Number\d$/.test(key) ? 2 : 0);
      if (index === -1) smartMap.Buttons.push(copy);
      else smartMap.Buttons[index] = copy;
      copied += 1;
    }
    smartMap.DateModified = harmonyDate();
  }
  return { mapList, copied };
}
