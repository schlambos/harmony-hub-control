/* Remotes page model (#remotes): the hub's RF remotes, pairing one more, and
   the activity buttons of remotes without a screen. Pure functions;
   views/remotes.js renders and saves.

   hal pairs Harmony RF remotes on the hub itself, with no cloud: rf.info
   lists the radio's 6 pairing slots, and after a pair stock hal unpairs any
   older remote of the same kind (one per EquadID). So a Smart Control joins a
   Touch, but replaces an older Smart Control. With multi-remote on
   (docs/MULTI_REMOTE.md; /api/remotes says `multiRemote`) only a remote with
   a screen or a keyboard replaces an older one: a second Smart Control joins the first.
   Remotes of one model send the same EquadID, so they share its maps and
   always do the same thing.

   A remote without a screen (hal's "Sprite" remotes: the Smart Control,
   EquadID 16414, and the Companion, 16422 or 16423) keeps no setup and never
   syncs. It sends key names from one shared table, tagged with its own
   EquadID, and the hub answers them from that remote's maps in MapList:
   <EquadID>Activity<id> while that activity runs (without one the remote
   does nothing in that activity) and <EquadID>Root for the three activity
   buttons and while everything is off. The engine adds Off to the root map
   itself. */

import { cloneJsonResource, createAllocator, sameButton } from "../wizard-model.js";
import { KEY_REMOTES, NO_SCREEN_REMOTES, keyOn } from "./touch-model.js";

export const SMART_CONTROL_EQUAD = "16414";
export const TOUCH_EQUAD = "16417";

/** Pairing slots on the hub's radio (remotes, the keyboard and dongles share them). */
export const RF_SLOTS = 6;

/** The root map a remote answers from while nothing runs. */
export function rootMapId(remote = SMART_CONTROL_EQUAD) {
  return `${remote}Root`;
}

/** Whether a remote has the three activity buttons (a remote without a screen). */
export function hasActivityButtons(remote) {
  return NO_SCREEN_REMOTES.includes(String(remote));
}

/* hal accepts only these EquadIDs (others are unpaired at once). 16417 is
   every remote with a screen (Touch, Elite, Ultimate…); its skin tells them
   apart, and only the Touch's skin is known. `role` decides what the
   Remotes page offers for that remote: "screen", "no-screen" (keys and
   activity buttons) or "other". */
const KINDS = {
  16414: { name: "Harmony Smart Control remote", short: "Smart Control", role: "no-screen" },
  16417: { name: "Harmony remote with a screen", short: "screen remote", role: "screen" },
  16420: { name: "Harmony keyboard", short: "keyboard", role: "other" },
  16422: { name: "Harmony Companion remote", short: "Companion", role: "no-screen" },
  16423: { name: "Harmony Companion remote", short: "Companion", role: "no-screen" },
  34830: { name: "Harmony USB dongle", short: "dongle", role: "other" },
};
/* `tested`: the screen-remote editor has been proven on this model. */
const SKINS = { 99: { name: "Harmony Touch", short: "Touch", tested: true } };

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
 * The Settings switch's status line for multiple remotes of one model, from
 * /api/multi-remote (`undefined` while loading, `null` if it failed) and what
 * the page is doing ("saving", "restarting" or "").
 */
export function multiRemoteStatus(state, busy = "") {
  if (busy === "saving") return "Saving…";
  if (busy === "restarting") return "Restarting the hub… about two minutes";
  if (state === undefined) return "Checking…";
  if (!state) return "Couldn't check this setting";
  if (state.enabled && state.active) return "On";
  // Switched on, but rcS.local won't bind the copy over a hal that isn't the
  // stock build (after a firmware update, say): it stays off until turned off.
  if (state.enabled) return state.supported ? "On after the hub restarts" : "Not available on this hub's remote software; turn it off to clear";
  if (state.active) return "Off after the hub restarts";
  return state.supported ? "Off" : "Not available on this hub";
}

/**
 * The Settings switch's status line for USB Ethernet (/api/usb-eth):
 * `undefined` while loading, `null` when it couldn't be read, and `busy`
 * ("saving" or "").
 */
const USB_ETH_REASONS = {
  phy_not_ready: "USB PHY not ready",
  deps_timeout: "USB drivers did not load in time",
  controller_registered_unbound: "USB controller did not start",
  kernel_or_slot_check_failed: "kernel check failed",
  driver_load_failed: "adapter driver failed to load",
  no_network_interface: "no wired network interface appeared",
  worker_stopped: "stopped unexpectedly, back on Wi-Fi",
  route_apply_failed: "wired routing could not be applied",
  unsupported_chipset: "unsupported chipset",
  no_usb_device: "no adapter found",
  static_invalid: "static address settings need fixing",
};

/* Enabled (the saved switch) is not operational (traffic can use the
 * cable). The hub reports both; this line must never call a merely
 * enabled hub "Ethernet + Wi-Fi". Operational on another network than the
 * hub's gateway (separateNetwork) is only an extra address: local traffic
 * stays on Wi-Fi. The Wired Ethernet page (ethernet-model.js) says more. */
export function usbEthStatus(state, busy = "") {
  if (busy === "saving") return "Applying…";
  if (state === undefined) return "Checking…";
  if (!state) return "Couldn't check USB Ethernet";
  if (!state.supported) {
    return state.kernel === "unknown" ? "USB Ethernet files missing · install again" : "Not available on this hub's kernel";
  }
  const dev = state.usbProduct || state.usbDevice || "";
  if (state.enabled) {
    const operational = state.operational ??
      (!state.state || state.state === "operational"
        ? Boolean(state.ifname && state.carrier && state.ipv4)
        : false);
    if (operational && state.ifname) {
      const how = state.separateNetwork ? "Wi-Fi · cable on another network"
        : state.wifiSuspended ? "Ethernet · Wi-Fi off"
          : "Ethernet + Wi-Fi";
      const parts = [how, state.ifname, state.ipv4 || "DHCP…"];
      if (dev) parts.push(dev);
      return parts.join(" · ");
    }
    switch (state.state) {
      case "starting":
        return "Turning on… waiting for the USB controller";
      case "failed":
        return `On, but not working: ${USB_ETH_REASONS[state.reason] || (state.reason || "startup failed").replaceAll("_", " ")}`;
      case "degraded_routing":
        if (state.reason === "prefix_mismatch") return `On${state.ifname ? ` · ${state.ifname}` : ""} · Subnet mask differs from Wi-Fi's · using Wi-Fi`;
        return "On, but wired replies are not confirmed on the cable: routing could not be applied";
      case "gateway_unreachable":
        return `On${state.ifname ? ` · ${state.ifname}` : ""} · Router not answering through the cable · using Wi-Fi`;
      case "adapter_absent":
        if (state.reason === "interface_gone") return "On · Adapter disconnected";
        return "On · Waiting for self-powered OTG Ethernet adapter";
      case "adapter_unsupported":
        return dev ? `On · ${dev} (unsupported chipset)` : "On · Unsupported USB Ethernet chipset";
      case "awaiting_carrier_dhcp":
      case "nic_not_bound":
        if (state.ifname && state.reason === "gateway_check") return `On · ${state.ifname} · Checking the router…`;
        if (state.ifname) {
          const waiting = state.ipMode === "static" ? "Setting the static address…" : "Waiting for DHCP…";
          return `On · ${state.ifname} · ${state.carrier ? waiting : "No link"}`;
        }
        return "On · Waiting for the wired link";
      case "stopped":
        return "On, but stopped";
      case "platform_unbound":
      case "deps_unavailable":
      case "platform_absent":
        return "On, but not working: USB controller did not start";
      default:
        break;
    }
    if (state.ifname) {
      const parts = ["On", state.ifname];
      if (state.carrier) parts.push(state.ipv4 || "DHCP…");
      else parts.push("No link");
      if (dev) parts.push(dev);
      return parts.join(" · ");
    }
    if (dev) return `On · ${dev} (unsupported chipset)`;
    return "On · Waiting for self-powered OTG Ethernet adapter";
  }
  if (dev) return `Wi-Fi only · ${dev} detected`;
  return "Wi-Fi only · Self-powered OTG Ethernet adapter";
}

/** A line for the pairing pop-up about one pairing window's outcome; "" when there's nothing to celebrate. */
export function pairedMessage(outcome) {
  if (!outcome) return "";
  if (outcome.status === "already") return "That remote was already paired with this hub, so it kept its slot and nothing else changed.";
  if (outcome.status !== "paired" || !outcome.added?.length) return "";
  const lines = outcome.added.map((r) => `${r.name} paired in slot ${r.slot}.`);
  for (const r of outcome.sharing ?? []) {
    const twins = (outcome.remotes ?? []).filter((o) => o.equadId === r.equadId && o.slot !== r.slot).map((o) => o.slot);
    if (twins.length) lines.push(`It does the same as the ${r.short} in slot ${twins.join(", ")}: remotes of one model share their buttons.`);
  }
  if (outcome.replaced?.length) {
    lines.push(`It replaced the older ${outcome.replaced.map((r) => `${r.short} in slot ${r.slot}`).join(", ")}.`);
  }
  return lines.join(" ");
}

/**
 * Paired remotes grouped by model (EquadID), in slot order: one entry per
 * model with its `slots`. Remotes of one model share that model's maps, so
 * the page sets them up once.
 */
export function remoteModels(remotes) {
  const byModel = new Map();
  for (const r of remotes ?? []) {
    const model = byModel.get(r.equadId);
    if (model) model.slots.push(r.slot);
    else byModel.set(r.equadId, { ...r, slots: [r.slot] });
  }
  return [...byModel.values()];
}

/**
 * What one pairing window did, from the slot tables read before and after
 * it. `status`:
 *   "paired"    a remote joined (`replaced` lists older ones of its kind hal
 *               dropped; `sharing`, those that joined another remote of
 *               their model and share its buttons)
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
    return { status: "unknown", added: [], removed: [], replaced: [], lost: [], sharing: [], halPaired };
  }
  const wasIds = new Set(was.remotes.map(remoteIdentity));
  const nowIds = new Set(now.remotes.map(remoteIdentity));
  const added = now.remotes.filter((r) => !wasIds.has(remoteIdentity(r)));
  const removed = was.remotes.filter((r) => !nowIds.has(remoteIdentity(r)));
  const addedKinds = new Set(added.map((r) => r.equadId));
  const replaced = removed.filter((r) => addedKinds.has(r.equadId));
  const lost = removed.filter((r) => !addedKinds.has(r.equadId));
  const sharing = added.filter((r) => now.remotes.some((o) => o.equadId === r.equadId && o.slot !== r.slot));
  let status;
  if (lost.length) status = "lost";
  else if (added.length) status = "paired";
  else status = halPaired ? "already" : "timeout";
  return { status, added, removed, replaced, lost, sharing, halPaired, remotes: now.remotes };
}

/* -- Activity buttons (<EquadID>Root) -----------------------------------------
   A remote without a screen has three; each takes an activity on a press
   and another on a long press, as Logitech's app set them up. Every such
   remote has its own root map. */

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

function rootMap(config, remote) {
  return maps(config).find((m) => m?.ButtonMapIdentifier === rootMapId(remote)) ?? null;
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
export function readActivityButtons(config, remote = SMART_CONTROL_EQUAD) {
  const map = rootMap(config, remote);
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

/* Surface identities for a new map of this remote, borrowed from one of its
   maps that has them, else from any activity map: the hub never reads them,
   and Logitech gave a Companion's maps the Smart Control's. */
function remoteSurface(config, remote) {
  const has = (m) => m && (m["SurfaceId-"] ?? m["ButtonMapSurfaceId-"]) != null;
  const source = maps(config).find((m) => has(m) && String(m?.ButtonMapIdentifier ?? "").startsWith(String(remote)))
    ?? maps(config).find((m) => has(m) && m?.__type === "ActivityButtonMap")
    ?? {};
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
 * root map for `remote` is created. Returns { mapList, changed }.
 */
export function buildActivityButtonsMapList(config, rows, remote = SMART_CONTROL_EQUAD) {
  const known = activityIds(config);
  const mapList = cloneJsonResource(config?.mapList ?? { ButtonMaps: [] });
  if (!Array.isArray(mapList.ButtonMaps)) mapList.ButtonMaps = [];
  const alloc = createAllocator(config);
  let map = mapList.ButtonMaps.find((m) => m?.ButtonMapIdentifier === rootMapId(remote));
  const created = !map;
  if (!map) {
    map = {
      "ButtonMapId-": alloc.mapId(),
      Buttons: [],
      ...remoteSurface(config, remote),
      __type: "RootButtonMap",
      ButtonMapIdentifier: rootMapId(remote),
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
export function activityButtonsSaveOutcome(config, baseRows, sentRows, remote = SMART_CONTROL_EQUAD) {
  const now = readActivityButtons(config, remote).rows;
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

/* -- Keys for a remote paired after its activities ----------------------------
   Pairing writes nothing to MapList, and Logitech's setup made activity maps
   only for the remotes the account had. So a remote without a screen paired
   here has no <EquadID>Activity<id> map for the activities that already
   exist: its activity button starts one from <EquadID>Root, then the engine
   drops every press, Off included, while that activity runs (issue #86).
   These give it a map for every activity, with the keys another remote
   already has there, which is what saving each activity again used to do. */

const COMMAND_ACTION = "ButtonCommandAction";

function isCommandAction(action) {
  return Boolean(action) && String(action.__type ?? "").includes(COMMAND_ACTION) && Boolean(action.CommandName);
}

function pairedNoScreenRemotes(remotes) {
  const paired = new Set((remotes ?? []).map((r) => String(r?.equadId ?? r)));
  return NO_SCREEN_REMOTES.filter((r) => paired.has(r));
}

/**
 * The activities a paired remote without a screen has no keys for:
 * [{ remote, activityId, name }], by remote then activity order. `remotes`
 * is the paired remotes (parseRfInfo's) or their EquadIDs.
 */
export function missingRemoteActivityMaps(config, remotes) {
  const have = new Set(maps(config).map((m) => String(m?.ButtonMapIdentifier ?? "")));
  const activities = (config?.activityList?.Activities ?? [])
    .slice()
    .sort((a, b) => (a.ActivityOrder ?? 0) - (b.ActivityOrder ?? 0));
  const missing = [];
  for (const remote of pairedNoScreenRemotes(remotes)) {
    for (const activity of activities) {
      const activityId = String(activity["Id-"]);
      if (have.has(`${remote}Activity${activityId}`)) continue;
      missing.push({
        remote,
        activityId,
        name: activity.Name || activity.ActivityDisplayName || `Activity ${activityId}`,
      });
    }
  }
  return missing;
}

/* The keys a new map of `remote` starts with in an activity: those another
   remote has there, a remote without a screen first, then one with a screen
   (no number keys). hal names every no-screen remote's keys from one table,
   so those are taken under the names they have, also ones this editor
   doesn't list (Logitech's UpArrow, say); a screen remote's are respelled.
   Only keys that send a command: a sequence or a home control belongs to
   the map it was made in. */
function borrowedKeys(config, remote, activityId, alloc) {
  const others = [...NO_SCREEN_REMOTES, ...KEY_REMOTES.filter((r) => !NO_SCREEN_REMOTES.includes(r))]
    .filter((r) => r !== remote);
  for (const other of others) {
    const source = maps(config).find((m) => m?.ButtonMapIdentifier === `${other}Activity${activityId}`);
    const buttons = [];
    const seen = new Set();
    for (const button of source?.Buttons ?? []) {
      if (button?.__type !== "HardRemoteButton" || !isCommandAction(button[PRESS])) continue;
      const key = NO_SCREEN_REMOTES.includes(other) ? String(button.ButtonKey ?? "") : keyOn(remote, button.ButtonKey);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const kept = (action) => (isCommandAction(action) ? cloneJsonResource(action) : null);
      buttons.push({
        ButtonId: alloc.id(),
        __type: "HardRemoteButton",
        [PRESS]: cloneJsonResource(button[PRESS]),
        ButtonDoublePressAction: kept(button.ButtonDoublePressAction),
        FunctionGroupType: /^Number\d$/.test(key) ? 2 : 0,
        ButtonState: 1,
        ButtonKey: key,
        [LONG_PRESS]: kept(button[LONG_PRESS]),
      });
    }
    if (buttons.length) return buttons;
  }
  return [];
}

/**
 * MapList with an activity map for every paired remote without a screen
 * that lacks one (missingRemoteActivityMaps). A new map takes the keys
 * another remote has in that activity; with none to take it is empty, which
 * still lets the engine answer Off and the activity buttons from the root
 * map. Existing maps are never touched. Returns { mapList, created } where
 * `created` lists the new maps' identifiers.
 */
export function buildRemoteActivityMapsMapList(config, remotes) {
  const mapList = cloneJsonResource(config?.mapList ?? { ButtonMaps: [] });
  if (!Array.isArray(mapList.ButtonMaps)) mapList.ButtonMaps = [];
  const alloc = createAllocator(config);
  const created = [];
  for (const { remote, activityId } of missingRemoteActivityMaps(config, remotes)) {
    const identifier = `${remote}Activity${activityId}`;
    const surface = remoteSurface(config, remote);
    mapList.ButtonMaps.push({
      "ButtonMapId-": alloc.mapId(),
      "ActivityId-": Number(activityId),
      Buttons: borrowedKeys(config, remote, activityId, alloc),
      "ButtonMapSurfaceId-": surface["ButtonMapSurfaceId-"],
      __type: "ActivityButtonMap",
      "RemoteId-": surface["RemoteId-"],
      ButtonMapIdentifier: identifier,
      DateModified: harmonyDate(),
      Sequences: [],
      "SurfaceId-": surface["SurfaceId-"],
    });
    created.push(identifier);
  }
  return { mapList, created };
}

/**
 * After a save the hub didn't confirm: does the hub's config now hold every
 * map that was sent ("saved"), none of them ("unchanged"), or some ("changed")?
 */
export function remoteActivityMapsSaveOutcome(config, created) {
  const have = new Set(maps(config).map((m) => String(m?.ButtonMapIdentifier ?? "")));
  const landed = (created ?? []).filter((id) => have.has(id)).length;
  if (landed === (created ?? []).length) return "saved";
  return landed ? "changed" : "unchanged";
}

/* -- Keys across remotes ------------------------------------------------------
   Every remote with keys has its own key map per activity, which Logitech
   fills alike and the editor keeps alike unless the owner sets a key for
   one remote only. This lists, per activity, where one remote's keys differ
   from each other remote's. Only keys both remotes physically have are
   compared (remotes with a screen have no number keys). */

const ACTION_FIELDS = [PRESS, LONG_PRESS, "ButtonDoublePressAction"];

function hardButtons(map) {
  return (map?.Buttons ?? []).filter((b) => b?.__type === "HardRemoteButton" && ACTION_FIELDS.some((f) => b?.[f]));
}

/* A remote's hard key with an action, by any remote's spelling. */
function keyButton(map, remote, key) {
  const name = keyOn(remote, key);
  return name ? hardButtons(map).find((b) => b.ButtonKey === name) ?? null : null;
}

/**
 * Per activity, how `remote`'s keys compare with each of `others`':
 * { activityId, name, hasMap, others: [{ remote, hasMap, differ, mineOnly,
 * theirsOnly }] }. Key names are in `remote`'s spelling. `hasMap` false
 * means that remote has no keys in the activity; nothing is compared then.
 */
export function keyComparison(config, remote, others = []) {
  const byId = new Map(maps(config).map((m) => [m?.ButtonMapIdentifier, m]));
  return (config?.activityList?.Activities ?? [])
    .slice()
    .sort((a, b) => (a.ActivityOrder ?? 0) - (b.ActivityOrder ?? 0))
    .map((activity) => {
      const id = String(activity["Id-"]);
      const mine = byId.get(`${remote}Activity${id}`) ?? null;
      return {
        activityId: id,
        name: activity.Name || activity.ActivityDisplayName || `Activity ${id}`,
        hasMap: Boolean(mine),
        others: others.map((other) => {
          const theirs = byId.get(`${other}Activity${id}`) ?? null;
          const result = { remote: String(other), hasMap: Boolean(theirs), differ: [], mineOnly: [], theirsOnly: [] };
          if (!mine || !theirs) return result;
          const keys = new Set([...hardButtons(mine), ...hardButtons(theirs)]
            .map((b) => keyOn(remote, b.ButtonKey))
            .filter((k) => k && keyOn(other, k)));
          for (const key of [...keys].sort()) {
            const a = keyButton(mine, remote, key);
            const b = keyButton(theirs, other, key);
            if (a && b && sameButton(a, b)) continue;
            if (a && b) result.differ.push(key);
            else if (a) result.mineOnly.push(key);
            else result.theirsOnly.push(key);
          }
          return result;
        }),
      };
    });
}
