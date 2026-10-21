import * as api from "./api.js";

export const state = {
  config: null,
  configError: null,
  configLoaded: false,
  currentId: "", // "" unknown · "-1" everything off · "<id>" running
  stateError: null,
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

export function ensureConfig() {
  if (state.config || state.configError) return Promise.resolve(state);
  if (configInflight) return configInflight;
  configInflight = (async () => {
    try {
      state.config = await api.getConfig();
      state.configError = null;
    } catch (error) {
      state.configError = error;
    }
    state.configLoaded = true;
    emit();
    return state;
  })().finally(() => {
    configInflight = null;
  });
  return configInflight;
}

export async function reloadConfig() {
  state.config = null;
  state.configError = null;
  state.configLoaded = false;
  emit();
  return ensureConfig();
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

export async function pollStateDigest() {
  let res;
  try {
    res = await api.getStateDigest(lastStateVersion);
  } catch (_) {
    return false; // transient; the next tick retries
  }
  if (!res || !res.changed) return false;
  const version = extractStateVersion(res.reply);
  if (version) lastStateVersion = version;
  await refreshState();
  return true;
}

export function startStatePolling(intervalMs = 5000) {
  if (statePollTimer) return;
  statePollTimer = setInterval(pollStateDigest, intervalMs);
}

export function stopStatePolling() {
  if (statePollTimer) {
    clearInterval(statePollTimer);
    statePollTimer = null;
  }
}

export async function setRunning(id) {
  const target = String(id);
  try {
    await api.runActivity(target === "-1" ? -1 : Number(target));
    state.stateError = null;
    await refreshState();
    if (!state.currentId && !state.stateError) {
      state.currentId = target;
      emit();
    }
  } catch (error) {
    try {
      await refreshState();
    } catch (_) {}
    state.stateError = error;
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
    return {
      id: String(device["Id-"]),
      name: device.Name || device.FriendlyName || `Device ${device["Id-"]}`,
      manufacturer: device.Manufacturer ?? "",
      model: device.Model ?? "",
      type: device.DeviceType ?? "",
      commands: (entry.Commands ?? []).map((c) => ({
        name: c.Name,
        functionId: c["FunctionId-"],
        keyCode: c.KeyCode,
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
