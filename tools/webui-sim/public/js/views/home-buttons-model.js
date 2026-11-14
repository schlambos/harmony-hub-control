/* Home control buttons model: what the Harmony Companion's Light 1, Light 2,
   Plug 1, Plug 2 and + / − do, read from and written back to its 16422
   button maps. Pure (no DOM, no network). The contract is
   docs/HOME_CONTROL_BUTTONS.md:
   - 16422Root holds the global assignment; 16422Activity<id> overrides a
     key while that activity runs. A key the activity map doesn't have
     follows the global one.
   - Ha1–Ha4 carry a press and an optional long press; Ha<n>Up/Ha<n>Down
     are what + / − do after that key, HcUp/HcDown what they do otherwise.
   - "Nothing" in an activity is a button running the map's "Nothing"
     sequence (one zero delay); the engine drops a button without actions
     and would fall back to the global one.
   Everything else in those maps (other keys, other actions, sequences,
   unknown fields, key order) is carried through untouched.

   A Harmony Elite or 950 has the same six buttons. It is a remote with a
   screen (16417), so they live in the 16417 maps under its key names
   (HomeControl1–4). It sends + and − only while the root map has
   HomeControlPlus/HomeControlMinus, so a save puts them there, doing
   nothing, when they are missing; the hub plugin turns them into the keys
   above. A hub whose screen remotes never had a root map gets one. */

import { cloneJsonResource, commandAction, createAllocator } from "../wizard-model.js";
import { validateMapList } from "./remote-model.js";
import { TOUCH_EQUAD, rootMapId } from "./remotes-model.js";
import { describeAction, touchMapIdentifier } from "./touch-model.js";

/* Only 16422: the hub plugin's home keys are proven on it (16423 is untested). */
export const COMPANION_EQUAD = "16422";
/** The remotes with a screen (every model is 16417; only some have home buttons). */
export const SCREEN_EQUAD = TOUCH_EQUAD;

export const HOME_BUTTONS = Object.freeze([
  { key: "Ha1", label: "Light 1" },
  { key: "Ha2", label: "Light 2" },
  { key: "Ha3", label: "Plug 1" },
  { key: "Ha4", label: "Plug 2" },
]);

/* What differs per remote:
   - `buttons`: physical button order and UI labels;
   - `copy`: per-model heading, intro and hint wording;
   - `gateKeys`: keys the root map must have for the remote to send + and −;
   - `canTurnOff`: whether an activity can turn a button off. A remote with a
     screen shows a key that runs a sequence as one and waits for it, so the
     "Nothing" sequence isn't offered there;
   - `makesRoot`: whether a save may add the root map. */
const REMOTES = Object.freeze({
  [COMPANION_EQUAD]: {
    equad: COMPANION_EQUAD,
    name: "Harmony Companion",
    buttons: HOME_BUTTONS,
    copy: Object.freeze({
      section: "Light and plug buttons",
      introButtons: "light, plug and + / − buttons",
      hintLast: "light or plug button",
      hintGroup: "Light and plug buttons",
    }),
    gateKeys: [],
    canTurnOff: true,
    makesRoot: false,
  },
  [SCREEN_EQUAD]: {
    equad: SCREEN_EQUAD,
    name: "Harmony Elite or 950",
    /* Physical dot order (1–4 dots); Logitech numbered the keys column-major
       so 2 dots is HomeControl3 and 3 dots is HomeControl2. */
    buttons: Object.freeze([
      { key: "HomeControl1", label: "• 1 dot" },
      { key: "HomeControl3", label: "•• 2 dots" },
      { key: "HomeControl2", label: "••• 3 dots" },
      { key: "HomeControl4", label: "•••• 4 dots" },
    ]),
    copy: Object.freeze({
      section: "Dot buttons",
      introButtons: "home control and + / − buttons",
      hintLast: "dot button",
      hintGroup: "Dot buttons",
    }),
    gateKeys: ["HomeControlPlus", "HomeControlMinus"],
    canTurnOff: false,
    makesRoot: true,
  },
});

/** The home-button facts of a remote, by EquadID (the Companion's by default). */
export function homeRemote(equad = COMPANION_EQUAD) {
  const remote = REMOTES[String(equad)];
  if (!remote) throw new Error(`Remote ${equad} has no home control buttons.`);
  return remote;
}

/* Skins of remotes with a screen that have home control buttons (Elite, 950). */
const HOME_BUTTON_SKINS = new Set(["111", "112"]);

/** Whether a paired remote (parseRfInfo) has home control buttons. */
export function hasHomeButtons(remote) {
  const equad = String(remote?.equadId ?? "");
  if (equad === COMPANION_EQUAD) return true;
  const skins = remote?.skinIds ?? [remote?.skinId];
  return equad === SCREEN_EQUAD && skins.some((skin) => HOME_BUTTON_SKINS.has(String(skin ?? "")));
}

/** What + and − do when the last pressed home button has no + / − of its own. */
export const ROCKER_KEYS = Object.freeze({ up: "HcUp", down: "HcDown" });

export const NOTHING_NAME = "Nothing";

/** The keys that make + and − adjust `homeKey` after it was pressed. */
export function dimKeys(homeKey) {
  return { up: `${homeKey}Up`, down: `${homeKey}Down` };
}

const homeKeysOf = (remote) => new Set(remote.buttons.map((b) => b.key));
const ownedKeysOf = (remote) => new Set([
  ...homeKeysOf(remote),
  ...remote.buttons.flatMap((b) => Object.values(dimKeys(b.key))),
  ...Object.values(ROCKER_KEYS),
]);
const remoteOf = (draft) => homeRemote(draft?.remote);
const OWNED_ACTIONS = ["ButtonCommandAction", "ButtonSequenceAction", "ButtonActivityAction"];
const SHORT_EVENT = 1;
const LONG_EVENT = 2;

const mapsOf = (config) => config?.mapList?.ButtonMaps ?? [];
const typeOf = (value) => (value && typeof value.__type === "string" ? value.__type : "");
const sequencesOf = (map) => (Array.isArray(map?.Sequences) ? map.Sequences : []);

function mapById(config, identifier) {
  return mapsOf(config).find((m) => m?.ButtonMapIdentifier === identifier) ?? null;
}

const targetIdentifier = (activityId, equad) => (activityId ? touchMapIdentifier(activityId, equad) : rootMapId(equad));

/* The map a new map copies its surface and remote ids from: another
   activity's map of this remote first, then its root map, then any of its
   maps (a remote with a screen may have device maps only). */
function siblingMap(config, equad) {
  const maps = mapsOf(config);
  const named = (prefix) => maps.find((m) => String(m?.ButtonMapIdentifier ?? "").startsWith(prefix));
  return named(`${equad}Activity`) ?? mapById(config, rootMapId(equad)) ?? named(`${equad}Device`) ?? null;
}

function isHardKey(button, key) {
  return typeOf(button) === "HardRemoteButton" && button.ButtonKey === key;
}

function hardButton(map, key) {
  return (Array.isArray(map?.Buttons) ? map.Buttons : []).find((b) => isHardKey(b, key)) ?? null;
}

/** The one sequence this page writes for "nothing". */
function isNothingSequence(sequence) {
  const steps = Array.isArray(sequence?.Actions) ? sequence.Actions : [];
  return sequence?.Name === NOTHING_NAME && steps.length === 1
    && typeOf(steps[0]).includes("ButtonDelayAction") && steps[0].Duration === 0 && steps[0].Order === 1;
}

function sequenceById(map, sequenceId) {
  return sequencesOf(map).find((s) => String(s?.SequenceId) === String(sequenceId)) ?? null;
}

function ownsAction(action) {
  return OWNED_ACTIONS.some((t) => typeOf(action).includes(t));
}

/* An action in the page's terms, always in one shape so drafts compare. */
function pageAction({ kind, deviceId, command, functionId, activityId, sequenceId, name }) {
  if (kind === "command") {
    return { kind, deviceId: String(deviceId), command: String(command ?? ""), functionId: Number(functionId) || 0 };
  }
  if (kind === "activity") return { kind, activityId: String(activityId) };
  if (kind === "sequence") return { kind, sequenceId: String(sequenceId), name: String(name ?? "") };
  throw new Error("Pick what the button does.");
}

const readAction = (action, map) => pageAction(describeAction(action, map));

/* One key in one map: absent (undefined), "set" (press and long press),
   "nothing", or "other" (actions this page doesn't own; kept unless changed). */
function readEntry(map, key) {
  const button = hardButton(map, key);
  if (!button) return undefined;
  const press = button.ButtonAction;
  const long = button.ButtonLongPressAction;
  const longOwned = !long || ownsAction(long);
  if (!press || !ownsAction(press) || !longOwned) return { state: "other" };
  if (typeOf(press).includes("ButtonSequenceAction") && isNothingSequence(sequenceById(map, press.SequenceId))) {
    return { state: "nothing" };
  }
  return {
    state: "set",
    press: readAction(press, map),
    long: long ? readAction(long, map) : null,
  };
}

function readEntries(map, remote) {
  const entries = {};
  for (const key of ownedKeysOf(remote)) {
    const entry = readEntry(map, key);
    if (entry) entries[key] = entry;
  }
  return entries;
}

/**
 * The page's draft for one scope: the global assignment (no activityId) or
 * one activity's overrides. `entries` are this scope's own keys; in an
 * activity, `globalEntries` are what a key without an override follows.
 */
export function readHomeButtons(config, activityId = "", equad = COMPANION_EQUAD) {
  const remote = homeRemote(equad);
  const id = activityId ? String(activityId) : "";
  const map = mapById(config, targetIdentifier(id, remote.equad));
  const root = mapById(config, rootMapId(remote.equad));
  const sibling = siblingMap(config, remote.equad);
  return {
    remote: remote.equad,
    activityId: id,
    exists: Boolean(map),
    canEdit: id || remote.makesRoot ? Boolean(map || sibling) : Boolean(root),
    entries: readEntries(map, remote),
    globalEntries: id ? readEntries(root, remote) : {},
    sequences: sequencesOf(map)
      .filter((s) => !isNothingSequence(s))
      .map((s) => ({ sequenceId: String(s.SequenceId), name: String(s.Name ?? "") })),
    base: JSON.stringify(map),
  };
}

/**
 * What a key does in the draft's scope and where that comes from:
 * "global", "override", "nothing", "other" or "unset".
 */
export function effectiveAssignment(draft, key) {
  const own = draft.entries[key];
  if (own) {
    if (own.state === "set") return { source: draft.activityId ? "override" : "global", press: own.press, long: own.long };
    return { source: own.state, press: null, long: null };
  }
  const inherited = draft.activityId ? draft.globalEntries[key] : undefined;
  if (inherited?.state === "set") return { source: "global", press: inherited.press, long: inherited.long };
  if (inherited) return { source: inherited.state, press: null, long: null };
  return { source: "unset", press: null, long: null };
}

/* -- Edits: each returns a new draft --------------------------------------- */

function copy(draft) {
  return { ...draft, entries: structuredClone(draft.entries) };
}

function ownedEntry(draft, key) {
  if (!ownedKeysOf(remoteOf(draft)).has(key)) throw new Error(`${key} isn't a home control key.`);
  return draft.entries[key];
}

/**
 * Set what a press ("press") or long press ("long") of `key` does. A long
 * press needs a press: in an activity that follows the global button, the
 * override starts from the global press.
 */
export function setAction(draft, key, which, action) {
  const wanted = pageAction(action ?? {});
  const entry = ownedEntry(draft, key);
  const next = copy(draft);
  if (which === "press") {
    next.entries[key] = { state: "set", press: wanted, long: entry?.state === "set" ? entry.long : null };
    return next;
  }
  if (which !== "long" || !homeKeysOf(remoteOf(draft)).has(key)) {
    const labels = remoteOf(draft).buttons.map((b) => b.label);
    throw new Error(`Only ${labels.slice(0, -1).join(", ")} and ${labels.at(-1)} have a long press.`);
  }
  if (entry?.state === "set") {
    next.entries[key].long = wanted;
    return next;
  }
  const inherited = draft.activityId && !entry ? draft.globalEntries[key] : undefined;
  if (inherited?.state !== "set") throw new Error("Set what a press does first.");
  next.entries[key] = { state: "set", press: { ...inherited.press }, long: wanted };
  return next;
}

/** Clear a press (the whole key: it follows the global one again, or is
    not set) or only the long press. */
export function clearAction(draft, key, which) {
  const entry = ownedEntry(draft, key);
  const next = copy(draft);
  if (which === "long") {
    if (entry?.state === "set") next.entries[key].long = null;
    return next;
  }
  delete next.entries[key];
  return next;
}

/** In an activity: the key does nothing there, whatever the global one does. */
export function setNothing(draft, key) {
  if (!draft.activityId) throw new Error("Only an activity can turn a button off.");
  if (!remoteOf(draft).canTurnOff) throw new Error("This remote's buttons can't be turned off for one activity.");
  ownedEntry(draft, key);
  const next = copy(draft);
  next.entries[key] = { state: "nothing" };
  return next;
}

/* The entries in key order, so two drafts compare whatever order their edits came in. */
function entriesShape(entries, remote) {
  return JSON.stringify([...ownedKeysOf(remote)].map((key) => entries[key] ?? null));
}

const reread = (config, draft) => readHomeButtons(config, draft.activityId, draft.remote);

/** Whether the draft differs from the scope it was read from. */
export function isChanged(config, draft) {
  const remote = remoteOf(draft);
  return entriesShape(reread(config, draft).entries, remote) !== entriesShape(draft.entries, remote);
}

/** Whether any of `keys` differs from the scope it was read from. */
export function keysChanged(config, draft, keys) {
  const saved = reread(config, draft).entries;
  return keys.some((key) => JSON.stringify(saved[key] ?? null) !== JSON.stringify(draft.entries[key] ?? null));
}

/** The draft with `keys` back as the scope has them on the hub. */
export function revertKeys(config, draft, keys) {
  const saved = reread(config, draft).entries;
  const next = copy(draft);
  for (const key of keys) {
    if (saved[key]) next.entries[key] = structuredClone(saved[key]);
    else delete next.entries[key];
  }
  return next;
}

/**
 * After a save the hub didn't confirm, what the hub has now: "saved",
 * "unchanged" or "changed" (something else), like the Touch editor.
 */
export function saveOutcome(config, draft) {
  if (JSON.stringify(mapById(config, targetIdentifier(draft.activityId, draft.remote))) === draft.base) return "unchanged";
  return isChanged(config, draft) ? "changed" : "saved";
}

/* -- Writing the MapList ------------------------------------------------------ */

function harmonyDate(now) {
  return `/Date(${now}+0000)/`;
}

/* Logitech's key order for the Companion's actions (its 16422Root map). */
function buttonAction(action, eventType, sequenceIdIn) {
  if (action.kind === "command") {
    return commandAction(action.deviceId, { name: action.command, functionId: action.functionId }, eventType);
  }
  if (action.kind === "activity") {
    return { __type: "ButtonActivityAction", "ActivityId-": Number(action.activityId), Order: 0, EventType: eventType, Id: 0 };
  }
  return { __type: "ButtonSequenceAction", SequenceId: Number(sequenceIdIn(action.sequenceId)), Order: 0, EventType: eventType, Id: 0 };
}

/* A new sequence id. Sequence ids aren't allocator ids, so stay clear of every map's. */
function freshSequenceId(config, alloc) {
  const used = new Set(mapsOf(config).flatMap(sequencesOf).map((s) => String(s?.SequenceId)));
  let id = alloc.id();
  while (used.has(String(id))) id = alloc.id();
  return id;
}

/* A sequence's content: everything but its id. */
const sequenceContent = (sequence) => JSON.stringify({ ...sequence, SequenceId: null });

/* The id a button in `map` runs a sequence by. Sequences are per map: an
   activity override that keeps the global press (a long press set on its
   own) runs a 16422Root sequence, so the activity map gets a copy of it,
   or reuses a copy it already has. */
function sequenceIdResolver(config, map, alloc, equad) {
  const own = new Set(sequencesOf(map).map((s) => String(s.SequenceId)));
  const root = map.ButtonMapIdentifier === rootMapId(equad) ? null : mapById(config, rootMapId(equad));
  return (sequenceId) => {
    const id = String(sequenceId);
    if (own.has(id)) return id;
    const source = sequenceById(root, id);
    if (!source) throw new Error("That sequence isn't on the hub any more.");
    const copy = sequencesOf(map).find((s) => sequenceContent(s) === sequenceContent(source));
    if (copy) return String(copy.SequenceId);
    const copyId = freshSequenceId(config, alloc);
    if (!Array.isArray(map.Sequences)) map.Sequences = [];
    map.Sequences.push({ ...structuredClone(source), SequenceId: copyId });
    return String(copyId);
  };
}

/* The action as the page reads it back, to keep an unchanged one as is. */
function sameAction(existing, wanted, map) {
  if (!existing || !wanted) return !existing && !wanted;
  return ownsAction(existing) && JSON.stringify(readAction(existing, map)) === JSON.stringify(wanted);
}

/* Logitech's key order for a Companion hard button. */
function newButton(key, buttonId) {
  return {
    ButtonKey: key,
    __type: "HardRemoteButton",
    ButtonLongPressAction: null,
    ButtonState: 1,
    FunctionGroupType: 0,
    ButtonDoublePressAction: null,
    ButtonAction: null,
    ButtonId: buttonId,
  };
}

/* A new map (an activity's, or the root map without an activity) copies the
   surface and remote ids from a sibling. */
function newMap(config, activityId, alloc, remote) {
  const sibling = siblingMap(config, remote.equad);
  if (!sibling) throw new Error(`This hub has no ${remote.name} map to copy.`);
  return {
    "ButtonMapId-": alloc.mapId(),
    ...(activityId ? { "ActivityId-": Number(activityId) } : {}),
    Buttons: [],
    "ButtonMapSurfaceId-": sibling["ButtonMapSurfaceId-"] ?? null,
    __type: activityId ? "ActivityButtonMap" : "RootButtonMap",
    "RemoteId-": sibling["RemoteId-"] ?? null,
    ButtonMapIdentifier: targetIdentifier(activityId, remote.equad),
    DateModified: null,
    Sequences: [],
    "SurfaceId-": sibling["SurfaceId-"] ?? null,
  };
}

/* The map's "Nothing" sequence id, adding the sequence when it has none. */
function nothingSequenceId(config, map, alloc) {
  const found = sequencesOf(map).find(isNothingSequence);
  if (found) return found.SequenceId;
  const id = freshSequenceId(config, alloc);
  if (!Array.isArray(map.Sequences)) map.Sequences = [];
  map.Sequences.push({ SequenceId: id, Name: NOTHING_NAME, Actions: [{ __type: "ButtonDelayAction", Duration: 0, Order: 1 }] });
  return id;
}

/* The "Nothing" sequence goes once no button in the map runs it. */
function dropUnusedNothing(map) {
  const used = new Set((Array.isArray(map.Buttons) ? map.Buttons : []).flatMap((b) => ["ButtonAction", "ButtonLongPressAction", "ButtonDoublePressAction"]
    .map((field) => b?.[field])
    .filter((a) => typeOf(a).includes("ButtonSequenceAction"))
    .map((a) => String(a.SequenceId))));
  if (!Array.isArray(map.Sequences)) return;
  map.Sequences = map.Sequences.filter((s) => !isNothingSequence(s) || used.has(String(s.SequenceId)));
}

function writeEntry(button, entry, map, sequenceIdIn, nothingId) {
  if (entry.state === "nothing") {
    if (!(typeOf(button.ButtonAction).includes("ButtonSequenceAction") && String(button.ButtonAction.SequenceId) === String(nothingId))) {
      button.ButtonAction = { __type: "ButtonSequenceAction", SequenceId: Number(nothingId), Order: 0, EventType: SHORT_EVENT, Id: 0 };
    }
    button.ButtonLongPressAction = null;
    return;
  }
  if (!sameAction(button.ButtonAction, entry.press, map)) {
    button.ButtonAction = buttonAction(entry.press, SHORT_EVENT, sequenceIdIn);
  }
  if (!sameAction(button.ButtonLongPressAction, entry.long, map)) {
    button.ButtonLongPressAction = entry.long ? buttonAction(entry.long, LONG_EVENT, sequenceIdIn) : null;
  }
}

/* The draft's keys written into `map`: changed keys keep their place and
   fields, cleared keys go, new keys go after the rest. */
function writeEntries(config, map, draft, alloc) {
  const owned = ownedKeysOf(remoteOf(draft));
  const sequenceIdIn = sequenceIdResolver(config, map, alloc, draft.remote);
  const wantsNothing = Object.values(draft.entries).some((e) => e.state === "nothing");
  const nothingId = wantsNothing ? nothingSequenceId(config, map, alloc) : null;
  const written = new Set();
  const buttons = [];
  for (const button of Array.isArray(map.Buttons) ? map.Buttons : []) {
    const key = typeOf(button) === "HardRemoteButton" ? button.ButtonKey : "";
    const before = owned.has(key) ? readEntry(map, key) : undefined;
    const entry = draft.entries[key];
    if (!before || (before.state === "other" && entry?.state === "other")) {
      buttons.push(button);
      continue;
    }
    // A second button for a key already written would shadow it on the hub.
    if (written.has(key)) continue;
    written.add(key);
    if (!entry) continue; // cleared
    writeEntry(button, entry, map, sequenceIdIn, nothingId);
    buttons.push(button);
  }
  for (const [key, entry] of Object.entries(draft.entries)) {
    if (written.has(key) || entry.state === "other") continue;
    const button = newButton(key, alloc.id());
    writeEntry(button, entry, map, sequenceIdIn, nothingId);
    buttons.push(button);
  }
  map.Buttons = buttons;
  dropUnusedNothing(map);
}

/* The remote sends + and − only while its root map has `gateKeys`: add the
   ones it lacks, doing nothing. A key already there is kept as it is. */
function addGateKeys(config, mapList, remote, alloc, now) {
  if (!remote.gateKeys.length) return;
  const rootId = rootMapId(remote.equad);
  let root = mapList.ButtonMaps.find((m) => m?.ButtonMapIdentifier === rootId);
  const missing = remote.gateKeys.filter((key) => !hardButton(root, key));
  if (!missing.length) return;
  if (!root) {
    root = newMap(config, "", alloc, remote);
    mapList.ButtonMaps.push(root);
  }
  const nothingId = nothingSequenceId(config, root, alloc);
  if (!Array.isArray(root.Buttons)) root.Buttons = [];
  for (const key of missing) {
    const button = newButton(key, alloc.id());
    button.ButtonAction = { __type: "ButtonSequenceAction", SequenceId: Number(nothingId), Order: 0, EventType: SHORT_EVENT, Id: 0 };
    root.Buttons.push(button);
  }
  root.DateModified = harmonyDate(now);
}

/**
 * The hub's MapList with the draft written into its 16422 map. Every other
 * map, and every key the page doesn't own, is copied as is. An activity
 * without a Companion map gets one, but never an empty one. Throws when
 * the map changed on the hub since the draft was read, or when the result
 * would not pass validation.
 */
export function buildHomeButtonsMapList(config, draft, { now = Date.now() } = {}) {
  const activityId = draft.activityId;
  if (activityId && !(config?.activityList?.Activities ?? []).some((a) => String(a?.["Id-"]) === activityId)) {
    throw new Error("This activity isn't on the hub any more.");
  }
  const remote = remoteOf(draft);
  const identifier = targetIdentifier(activityId, remote.equad);
  if (JSON.stringify(mapById(config, identifier)) !== draft.base) {
    throw new Error("These buttons changed on the hub since you opened them. Reopen the page to see the latest.");
  }
  const mapList = cloneJsonResource(config.mapList);
  const alloc = createAllocator(config);
  let map = mapList.ButtonMaps.find((m) => m?.ButtonMapIdentifier === identifier);
  if (!map) {
    if (!activityId && !remote.makesRoot) throw new Error(`This hub has no ${remote.name} buttons to change.`);
    if (Object.keys(draft.entries).length === 0) return mapList;
    map = newMap(config, activityId, alloc, remote);
    mapList.ButtonMaps.push(map);
  }
  const before = JSON.stringify(map);
  writeEntries(config, map, draft, alloc);
  if (JSON.stringify(map) !== before) map.DateModified = harmonyDate(now);
  addGateKeys(config, mapList, remote, alloc, now);
  const errors = validateMapList(mapList);
  if (errors.length) throw new Error(`The hub would not load these buttons: ${errors[0]}`);
  return mapList;
}
