import * as api from "./api.js";
import { inputNames } from "./views/device-settings-model.js";
import { describeHaDeviceState, haDeviceKey } from "./views/remote-model.js";

export const state = {
  config: null,
  configError: null,
  configLoaded: false,
  currentId: "", // "" unknown · "-1" everything off · "<id>" running
  stateError: null,
  reachable: true, // false after repeated failed state polls
  pendingId: "", // activity being started ("-1" = turning off) until the hub answers
  runError: null, // the last failed start / turn-off request
  haState: null, // { version, stale, states: [...] } from /api/activity-config or /api/ha-state
  haStateVersion: 0,
};

const subscribers = new Set();

export function subscribe(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

function emit() {
  for (const fn of subscribers) fn(state);
}

// In-flight dedup: shell boot and view onShow both ask for config/state;
// concurrent asks merge into one GET so the hub is never double-fetched.
let configInflight = null;

/* Config reads are numbered. An answer shows only if no read started after
   it has shown one already, so an older setup never replaces a newer one,
   and a read that lost out can rely on the newer answer: it started later.
   A reload blanks the page and sets aside every read already on its way. */
let configReads = 0;
let configShown = 0;
let latestRead = Promise.resolve();
const settle = () => {};

// Resolves once the newest read so far has answered.
async function newestRead() {
  let seen;
  do {
    seen = configReads;
    await latestRead;
  } while (seen !== configReads);
  return state;
}

function showConfig(read, config) {
  if (read <= configShown) return false;
  configShown = read;
  state.config = config;
  state.configError = null;
  state.configLoaded = true;
  if (config?.haState && typeof config.haState === "object") {
    state.haState = {
      version: Number(config.haState.version ?? config.haStateVersion ?? 0),
      stale: Boolean(config.haState.stale),
      states: Array.isArray(config.haState.states) ? config.haState.states : [],
    };
    state.haStateVersion = state.haState.version;
  }
  emit();
  return true;
}

// An error shows only when there is no setup on screen to keep.
function showConfigError(read, error) {
  if (read <= configShown || state.config) return false;
  state.configError = error;
  state.configLoaded = true;
  emit();
  return true;
}

export function ensureConfig() {
  if (state.config || state.configError) return Promise.resolve(state);
  if (configInflight) return configInflight;
  const read = ++configReads;
  const pending = (async () => {
    try {
      if (showConfig(read, await api.getConfig())) return state;
    } catch (error) {
      if (showConfigError(read, error)) return state;
    }
    return newestRead();
  })().finally(() => {
    if (configInflight === pending) configInflight = null;
  });
  configInflight = pending;
  latestRead = pending.then(settle, settle);
  return pending;
}

export async function reloadConfig() {
  state.config = null;
  state.configError = null;
  state.configLoaded = false;
  configShown = configReads;
  configInflight = null;
  emit();
  return ensureConfig();
}

/* Read the config again after a change to it, keeping the current one on
   screen until the answer arrives (reloadConfig blanks it first). Rejects
   when the hub can't be read; the config on screen then stays. */
export function refreshConfig() {
  const read = ++configReads;
  const done = (async () => {
    let config;
    try {
      config = await api.getConfig();
    } catch (error) {
      showConfigError(read, error);
      throw error;
    }
    if (showConfig(read, config) || state.config) return state;
    // A reload blanked the page meanwhile: its answer is the newer one.
    return newestRead();
  })();
  latestRead = done.then(settle, settle);
  return done;
}

function extractCurrentActivity(payload) {
  const raw =
    typeof payload === "string"
      ? payload
      : typeof payload?.reply === "string"
        ? payload.reply
        : payload
          ? JSON.stringify(payload)
          : "";

  let decoded = payload?.reply ?? payload;
  for (let attempt = 0; attempt < 3 && typeof decoded === "string"; attempt += 1) {
    const trimmed = decoded.trim();
    if (/^-?\d+$/.test(trimmed)) return trimmed;
    try {
      decoded = JSON.parse(trimmed);
    } catch (_) {
      break;
    }
  }

  const find = (value, depth = 0) => {
    if (depth > 8 || value == null) return "";
    if (typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        if (/^(current)?activityid$/i.test(key) && /^-?\d+$/.test(String(child))) {
          return String(child);
        }
      }
      for (const [key, child] of Object.entries(value)) {
        if (/^result$/i.test(key) && /^-?\d+$/.test(String(child))) {
          return String(child);
        }
      }
      for (const child of Object.values(value)) {
        const found = find(child, depth + 1);
        if (found) return found;
      }
    } else if (typeof value === "string") {
      try {
        return find(JSON.parse(value), depth + 1);
      } catch (_) {
        return "";
      }
    }
    return "";
  };

  const structured = find(decoded);
  if (structured) return structured;

  const match =
    raw.match(/"(?:current)?activityId"\s*:\s*"?(-?\d+)"?/i) ||
    raw.match(/"result"\s*:\s*"?(-?\d+)"?/i);
  return match ? match[1] : "";
}

let stateInflight = null;

export function refreshState() {
  if (stateInflight) return stateInflight;
  stateInflight = (async () => {
    try {
      const payload = await api.getState();
      state.currentId = extractCurrentActivity(payload);
      state.stateError = null;
    } catch (error) {
      state.stateError = error;
    }
    emit();
    return state;
  })().finally(() => {
    stateInflight = null;
  });
  return stateInflight;
}

// Lightweight liveness. connect.statedigest?get returns "unchanged" until the
// hub's stateVersion moves, so we poll it cheaply and pull the full activity
// state only when something actually changed — a remote starting an activity,
// or another client making a change — rather than on a fixed expensive timer.
let lastStateVersion = null;
let statePollTimer = null;

// Pure: pull the stateVersion out of an /api/state reply (robust to the engine
// reply being escaped/nested). Exported for unit testing.
export function extractStateVersion(payload) {
  if (payload == null) return null;
  const raw = (typeof payload === "string" ? payload : JSON.stringify(payload)).replace(/\\/g, "");
  const match = raw.match(/"stateVersion"\s*:\s*"?(\d+)/i);
  return match ? match[1] : null;
}

// The hub counts as unreachable after two polls in a row fail, so one
// dropped request never flashes the "can't reach your hub" banner.
let pollFailures = 0;

function setReachable(reachable) {
  if (state.reachable === reachable) return;
  state.reachable = reachable;
  emit();
}

export async function pollStateDigest() {
  let res;
  try {
    res = await api.getStateDigest(lastStateVersion);
  } catch (error) {
    // An HTTP error still means the hub answered; only a failed connection
    // (status 0) counts towards "unreachable".
    if (error?.status > 0) {
      pollFailures = 0;
      setReachable(true);
    } else {
      pollFailures += 1;
      if (pollFailures >= 2) setReachable(false);
    }
    return false; // transient; the next tick retries
  }
  pollFailures = 0;
  setReachable(true);
  await pollHaState();
  if (!res || !res.changed) return false;
  const version = extractStateVersion(res.reply);
  if (version) lastStateVersion = version;
  await refreshState();
  return true;
}

export async function pollHaState() {
  if (!state.config || !devices().some((d) => d.isHa)) return false;
  let res;
  try {
    res = await api.getHaState(state.haStateVersion > 0 ? state.haStateVersion : "");
  } catch (_) {
    return false;
  }
  if (!res || typeof res !== "object") return false;
  const next = {
    version: Number(res.version ?? 0),
    stale: Boolean(res.stale),
    states: Array.isArray(res.states) ? res.states : [],
  };
  const prev = state.haState;
  const changed = Boolean(res.changed) ||
    !prev ||
    prev.version !== next.version ||
    prev.stale !== next.stale;
  if (!changed) return false;
  state.haState = next;
  state.haStateVersion = next.version;
  emit();
  return true;
}

export function haDeviceState(deviceOrId) {
  const d = typeof deviceOrId === "object" && deviceOrId ? deviceOrId : deviceById(deviceOrId);
  return d ? describeHaDeviceState(d, state.haState) : null;
}

export function startStatePolling(intervalMs = 3000) {
  if (statePollTimer) return;
  statePollTimer = setInterval(pollStateDigest, intervalMs);
}

export function stopStatePolling() {
  if (statePollTimer) {
    clearInterval(statePollTimer);
    statePollTimer = null;
  }
}

/* Start an activity ("-1" turns everything off). pendingId shows the busy
   state until the hub answers; a later start owns it from then on. A failed
   request lands in runError, apart from stateError (reading the state). */
export async function setRunning(id) {
  const target = String(id);
  state.pendingId = target;
  state.runError = null;
  emit();
  try {
    await api.runActivity(target === "-1" ? -1 : Number(target));
    // A poll may have begun reading before the switch: let it finish, then
    // read again so the answer reflects this start.
    if (stateInflight) await stateInflight;
    if (state.pendingId === target) state.pendingId = "";
    await refreshState();
    if (!state.currentId && !state.stateError) {
      state.currentId = target;
      emit();
    }
  } catch (error) {
    if (state.pendingId === target) state.pendingId = "";
    state.runError = error;
    try {
      await refreshState();
    } catch (_) {}
    emit();
  }
  return state;
}

export function activities() {
  const list = state.config?.activityList?.Activities ?? [];
  return [...list].sort((a, b) => (a.ActivityOrder ?? 0) - (b.ActivityOrder ?? 0));
}

export function activityById(id) {
  return activities().find((a) => String(a["Id-"]) === String(id)) ?? null;
}

export function activityName(activity) {
  if (!activity) return "Unknown activity";
  return activity.Name || activity.ActivityDisplayName || `Activity ${activity["Id-"]}`;
}

const ACTIVITY_TYPE_LABELS = {
  1: "Watch TV",
  2: "Watch a movie",
  3: "Play a game",
  4: "Listen to music",
};

export function activityTypeLabel(activity) {
  return ACTIVITY_TYPE_LABELS[activity?.Type] ?? "Activity";
}

export function devices() {
  const raw = state.config?.deviceList?.DevicesWithFeatures ?? [];
  return raw.map((entry) => {
    const device = entry.Device ?? {};
    const transport = Number(device.Transport) || 1;
    return {
      id: String(device["Id-"]),
      name: device.Name || device.FriendlyName || `Device ${device["Id-"]}`,
      manufacturer: device.Manufacturer ?? "",
      model: device.Model ?? "",
      type: device.DeviceType ?? "",
      typeLabel: device.DeviceTypeDisplayName || device.DeviceType || "",
      transport,
      // Transport 32 is Bluetooth HID; 64 is Home Assistant IP; else IR.
      isBluetooth: transport === 32,
      isHa: transport === 64 || String(device.Manufacturer ?? "").toLowerCase().includes("home assistant"),
      haKey: haDeviceKey(entry),
      entry,
      inputs: inputNames(entry),
      commands: (entry.Commands ?? []).map((c) => ({
        name: c.Name,
        functionId: c["FunctionId-"],
        keyCode: c.KeyCode,
        // The hub marks every command added on it as learned; a raw one
        // keeps its timings in Raw and has no KeyCode.
        learned: Boolean(c.IsLearned),
        raw: c.Raw != null && !c.KeyCode,
        rawData: typeof c.Raw === "string" ? c.Raw : "",
        protocolId: Number(c.ProtocolId) || 0,
      })),
    };
  });
}

export function deviceById(id) {
  return devices().find((d) => d.id === String(id)) ?? null;
}

export function deviceName(id) {
  return deviceById(id)?.name ?? `Device ${id}`;
}

export function buttonMapsForActivity(id) {
  const maps = state.config?.mapList?.ButtonMaps ?? [];
  return maps.filter((m) => String(m["ActivityId-"]) === String(id));
}

export function counts() {
  return {
    activities: activities().length,
    devices: devices().length,
    buttonMaps: (state.config?.mapList?.ButtonMaps ?? []).length,
    revision: state.config?.revision ?? "—",
  };
}
