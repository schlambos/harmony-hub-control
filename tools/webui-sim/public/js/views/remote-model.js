/* Remote model: which command each remote key sends, for an activity or a
   single device. Pure (no DOM, no network), ported from the Melodious app
   (ActivityGraphBuilder.resolveActivityButtons / resolveActivitySoftButtons,
   FixIt, DomainIcons) so both remotes behave the same. */

import { BUTTON_KEY_BY_LABEL, REMOTE_BUTTONS, commandKey, matchCommand } from "../remote-layout.js";
import { readDeviceSettings } from "./device-settings-model.js";

/* Hardware-proven press semantics (P11, proven G3/G4/S1/S3/S5/S6):
   - Standard (hold repeats): plain button, hold ramps (Brightness/Volume/Speed).
   - One-shot toggles (PowerToggle, PlayPause, Mute, SkipForward/Back, Run,
     Activate, Press) double-fire when held >=300ms, so they need a self-long
     (ButtonLongPressAction == ButtonAction, EventType 2) which fires exactly
     once at release (<600ms) or once at the 2nd hold (>=600ms). */
export const ONE_SHOT_COMMANDS = Object.freeze([
  "PowerToggle",
  "PlayPause",
  "Mute",
  "SkipForward",
  "SkipBack",
  "Run",
  "Activate",
  "Press",
]);

const ONE_SHOT_KEYS = new Set(ONE_SHOT_COMMANDS.map((c) => commandKey(c)));

/** True when the command needs one-shot (self-long) protection. Case-insensitive, like the engine. */
export function isOneShotCommand(commandName) {
  const key = commandKey(commandName);
  if (!key) return false;
  if (ONE_SHOT_KEYS.has(key)) return true;
  // HA preset/step grammar (P15): presets are one-shot, *_step/increment/decrement ramp.
  if (/^(brightness|position|tilt|temperature|percentage|setvalue|volume|soundmode|hvacmode|presetmode|selectoption|effect|colortemp)/.test(key)) {
    if (/(step|increment|decrement|next|previous)$/.test(key)) return false;
    // Discrete presets (Brightness 40, Position 75, discrete selects) are one-shot.
    if (/^(brightnesspct|position|tilt|temperature|percentage|setvalue|volumeset|soundmode|hvacmode|presetmode|selectoption|effect|colortemp)/.test(key)) return true;
    return false;
  }
  return false;
}

/** Recommended press mode for a freshly picked command. */
export function recommendedPressMode(commandName) {
  return isOneShotCommand(commandName) ? "oneShot" : "standard";
}

/** Momentary step commands that want plain hold-to-ramp (never one-shot). */
export function isStepCommand(commandName) {
  return /^(brightnessup|brightnessdown|volumeup|volumedown|speedup|speeddown)$/i.test(
    String(commandName ?? "").replace(/[^a-z]/gi, ""),
  );
}

/* Gesture keys the Touch resolves locally (P18, proven G1d & S4).
   The Touch never sends these to the hub; it resolves each against the
   target device's 16417Device<id> screen and sends an ordinary device-map press. */
export const GESTURE_KEYS = Object.freeze(["SwipeUp", "SwipeDown", "SwipeLeft", "SwipeRight", "Tap"]);
export const GESTURE_HOLD_SUFFIX = "Hold";
export const GESTURE_DOUBLE_KEY = "DoubleTap";

function normCmd(name) {
  return String(name ?? "").toLowerCase();
}

/** Device grouping for pickers: members first, HA entities, other IR/BT.
 *  HA detection: Transport 64, or Home Assistant manufacturer/protocol. */
export function isHaDevice(device) {
  if (!device) return false;
  // Network Android/Google TVs are IP devices too, but not Home Assistant's.
  if (String((device.entry ?? device)?.Device?.AutoDetectedDevice?.Id ?? "").startsWith("melodious-androidtv-")) return false;
  if (device.isHa === true) return true;
  const transport = Number(device.transport ?? device.Transport ?? device.entry?.Device?.Transport ?? 1);
  if (transport === 64) return true;
  const manu = String(device.manufacturer ?? device.entry?.Device?.Manufacturer ?? "").toLowerCase();
  if (manu.includes("home assistant")) return true;
  return false;
}

/** The Home Assistant device key ({d} token) stored on a DeviceList entry, or null. */
export function haDeviceKey(device) {
  if (!device) return null;
  if (typeof device.haKey === "string" && device.haKey) return device.haKey;
  const entry = device.entry ?? device;
  const d = entry?.Device ?? entry;
  const params = d?.Tokens?.Parameters ?? [];
  const token = Array.isArray(params) ? params.find((p) => p?.Key === "{d}") : null;
  const value = token?.Value ? String(token.Value).trim() : "";
  return value || null;
}


/** "HDMI_1" -> "HDMI 1" (the stable hub input name). */
export function theaterPortLabel(portId) {
  return String(portId ?? "").replace("_", " ");
}

function parseTheater(snap, stale) {
  if (stale || !snap || typeof snap.theater !== "object" || snap.theater === null) return null;
  const raw = snap.theater;
  const ports = (Array.isArray(raw.ports) ? raw.ports : [])
    .filter((port) => port && typeof port === "object" && typeof port.id === "string")
    .map((port) => ({
      id: port.id,
      label: typeof port.label === "string" && port.label.trim() ? port.label.trim() : theaterPortLabel(port.id),
      connected: typeof port.connected === "boolean" ? port.connected : null,
      signal: typeof port.signal === "boolean" ? port.signal : null,
      cecName: typeof port.cec_name === "string" && port.cec_name.trim() ? port.cec_name.trim() : null,
      cecType: typeof port.cec_type === "number" ? port.cec_type : null,
    }));
  const active = raw.active_input && typeof raw.active_input === "object" && typeof raw.active_input.id === "string"
    ? { id: raw.active_input.id, label: typeof raw.active_input.label === "string" && raw.active_input.label.trim() ? raw.active_input.label.trim() : theaterPortLabel(raw.active_input.id) }
    : null;
  let sound = null;
  if (raw.sound && typeof raw.sound === "object") {
    const s = raw.sound;
    const output = typeof s.output === "string" && s.output.trim() ? s.output.trim() : null;
    const label = typeof s.label === "string" && s.label.trim() ? s.label.trim() : null;
    const volume = typeof s.volume === "number" && Number.isFinite(s.volume) ? s.volume : null;
    const muted = typeof s.muted === "boolean" ? s.muted : null;
    const dest = output === "external_arc" ? (label ? `${label} (ARC)` : "ARC") : (label || output);
    if (dest) {
      const bits = [`Sound: ${dest}`];
      if (volume != null) bits.push(`Vol ${volume}`);
      if (muted === true) bits.push("Muted");
      sound = { output, label, port: typeof s.port === "string" ? s.port : null, volume, muted, text: bits.join(" \u00b7 ") };
    }
  }
  const portsText = ports.map((port) => {
    const live = active && port.id === active.id;
    const state = live ? "live" : port.connected === true ? "connected" : port.connected === false ? "not connected" : "unknown";
    const sig = port.signal === true && !live ? ", signal" : "";
    return `${theaterPortLabel(port.id)} ${port.label} (${state}${sig})`;
  }).join(" \u00b7 ");
  return { activeInput: active, ports, sound, portsText };
}

/**
 * Normalize one Home Assistant device's live state against the hub's haState
 * envelope. Never invents "off" when stale, missing or unavailable: returns
 * { known: false, stale: true, power: "unknown", badge: "State unknown", ... }.
 */
export function describeHaDeviceState(device, haState) {
  if (!isHaDevice(device)) return null;
  const key = haDeviceKey(device);
  const envelope = haState && typeof haState === "object" ? haState : null;
  const list = Array.isArray(envelope?.states) ? envelope.states : [];
  const snap = key ? list.find((s) => s && typeof s === "object" && String(s.key ?? "") === key) ?? null : null;
  const stale = Boolean(!envelope || envelope.stale || !snap || snap.available === false);
  const rawPower = !stale && typeof snap?.power === "string" ? snap.power.toLowerCase() : "unknown";
  const power = rawPower === "on" || rawPower === "off" ? rawPower : "unknown";
  const known = !stale && power !== "unknown";
  const source = !stale && typeof snap?.source === "string" && snap.source.trim() ? snap.source.trim() : null;
  const activity = !stale && typeof snap?.activity === "string" && snap.activity.trim() ? snap.activity.trim() : null;
  const volume = !stale && typeof snap?.volume === "number" && Number.isFinite(snap.volume)
    ? Math.max(0, Math.min(100, Math.round(snap.volume * 100)))
    : null;
  const muted = !stale && typeof snap?.muted === "boolean" ? snap.muted : null;
  const rawPlaying = !stale && typeof snap?.playing === "string" ? snap.playing.toLowerCase() : null;
  const playing = rawPlaying && ["playing", "paused", "idle"].includes(rawPlaying) ? rawPlaying : null;
  const theater = parseTheater(snap, stale);

  const chips = [];
  if (!known) {
    chips.push({ kind: "unknown", label: "State unknown" });
  } else {
    chips.push({ kind: power === "on" ? "on" : "off", label: power === "on" ? "On" : "Off" });
    if (source) chips.push({ kind: "source", label: source });
    if (activity && activity.toLowerCase() !== (source ?? "").toLowerCase()) {
      chips.push({ kind: "app", label: activity });
    }
    if (playing && (playing === "playing" || playing === "paused")) {
      chips.push({ kind: "playing", label: playing === "playing" ? "Playing" : "Paused" });
    }
    if (theater?.sound) {
      // TV-reported level on a 0-100 scale, not a percentage of HA volume.
      chips.push({ kind: "sound", label: theater.sound.text });
    } else if (muted === true) {
      chips.push({ kind: "muted", label: volume != null ? `Muted (${volume}%)` : "Muted" });
    } else if (volume != null) {
      chips.push({ kind: "volume", label: `Vol ${volume}%` });
    }
  }
  const summary = chips.map((c) => c.label).join(" · ");
  return {
    key,
    known,
    stale,
    power,
    source,
    activity,
    volume,
    muted,
    playing,
    badge: !known ? "State unknown" : power === "on" ? "On" : "Off",
    chips,
    summary,
    theater,
    activeInputId: theater?.activeInput ? theaterPortLabel(theater.activeInput.id) : null,
  };
}

/**
 * Display-only link from a hub device to one LG HDMI port (integration
 * options -> snapshot theater_links). The linked device's own power is never
 * inferred: connection, video signal and ARC are observations, not power.
 * Returns null when this device has no link in the snapshot.
 */
export function describeTheaterLink(device, haState) {
  if (!device) return null;
  const envelope = haState && typeof haState === "object" ? haState : null;
  const list = Array.isArray(envelope?.states) ? envelope.states : [];
  const deviceId = String(device.id ?? "");
  let snap = null;
  let link = null;
  for (const state of list) {
    if (!state || typeof state !== "object" || !Array.isArray(state.theater_links)) continue;
    const found = state.theater_links.find((l) => l && String(l.device_id ?? "") === deviceId && typeof l.port === "string");
    if (found) { snap = state; link = found; break; }
  }
  if (!link) return null;
  const stale = Boolean(!envelope || envelope.stale || snap.available === false);
  const theater = parseTheater(snap, stale);
  if (!theater) {
    return { key: snap.key ?? null, known: false, stale: true, power: "unknown", badge: "State unknown",
      chips: [{ kind: "unknown", label: "State unknown" }], summary: "State unknown", theater: null,
      theaterLink: { port: link.port }, activeInputId: null };
  }
  const port = theater.ports.find((p) => p.id === link.port) ?? null;
  const live = Boolean(theater.activeInput && theater.activeInput.id === link.port);
  const chips = [];
  if (live) chips.push({ kind: "on", label: `${theaterPortLabel(link.port)} \u00b7 live on the TV` });
  else if (port?.connected === true) chips.push({ kind: "source", label: `${theaterPortLabel(link.port)} \u00b7 connected to the TV` });
  else if (port?.connected === false) chips.push({ kind: "unknown", label: `${theaterPortLabel(link.port)} \u00b7 not connected` });
  else chips.push({ kind: "unknown", label: theaterPortLabel(link.port) });
  if (port?.signal === true && theater.sound?.port !== link.port) {
    chips.push({ kind: "playing", label: "Signal present" });
  }
  if (theater.sound?.port === link.port) {
    // ARC destination: TV-reported level only. Power stays unknown.
    chips.push({ kind: "sound", label: theater.sound.text.replace(/^Sound: /, "On ARC \u00b7 ") });
  }
  return { key: snap.key ?? null, known: true, stale: false, power: "unknown", badge: "Linked",
    chips, summary: chips.map((c) => c.label).join(" \u00b7 "), theater,
    theaterLink: { port: link.port, live, connected: port?.connected ?? null, signal: port?.signal ?? null },
    activeInputId: theater.activeInput ? theaterPortLabel(theater.activeInput.id) : null };
}

/**
 * True when a command on an HA device is redundant given its fresh live state
 * (for example PowerOn while already on, PowerOff while already off, Play
 * while already playing, Pause while paused, or Input X while already on X).
 * Never returns true when state is unknown or stale.
 */
export function isHaCommandRedundant(commandName, haInfo) {
  if (!haInfo || !haInfo.known) return false;
  const key = commandKey(commandName);
  if (!key) return false;
  if (haInfo.power === "on" && (key === "poweron" || key === "on")) return true;
  if (haInfo.power === "off" && (key === "poweroff" || key === "off")) return true;
  if (haInfo.playing === "playing" && key === "play") return true;
  if (haInfo.playing === "paused" && key === "pause") return true;
  if (haInfo.activeInputId) {
    const activeKey = commandKey(haInfo.activeInputId);
    if (activeKey && key === `input${activeKey}`) return true;
  }
  if (haInfo.source) {
    const srcKey = commandKey(haInfo.source);
    if (srcKey && (key === `input${srcKey}` || (commandName.toLowerCase().startsWith("input ") && key === srcKey))) {
      return true;
    }
  }
  return false;
}

export function deviceDomainLabel(device) {
  const name = String(device?.name ?? "").toLowerCase();
  const commands = (device?.commands ?? []).map((c) => String(c?.name ?? c).toLowerCase());
  const has = (...names) => names.some((n) => commands.includes(n));
  if (String(device?.entry?.Device?.AutoDetectedDevice?.Id ?? "").startsWith("melodious-androidtv-")) return "Network TV";
  if (has("brightnessup", "brightnessdown") || name.includes("light")) return "Light";
  if (has("play", "pause", "playpause") || has("volumeup")) {
    if (commands.includes("run") || commands.includes("activate")) return "Scene / Script";
    return "Media Player";
  }
  if (has("run") || has("activate") || has("press")) return "Scene / Script";
  if (has("speedup", "speeddown") || has("open", "close")) return "Switch / Fan / Cover";
  if (isHaDevice(device)) return "Home Assistant";
  return "Other";
}

/** Sort devices for pickers: members first, then HA grouped, then others. */
export function sortPickerDevices(devices, roleIds) {
  const roles = new Set((roleIds ?? []).map(String));
  const rank = (d) => {
    if (roles.has(String(d.id))) return 0;
    if (isHaDevice(d)) return 1;
    return 2;
  };
  return [...devices].sort((a, b) => rank(a) - rank(b) || String(a.name).localeCompare(String(b.name)));
}

/** Group devices for pickers with section labels. */
export function groupPickerDevices(devices, roleIds) {
  const sorted = sortPickerDevices(devices, roleIds);
  const members = [];
  const ha = [];
  const other = [];
  for (const d of sorted) {
    if ((roleIds ?? []).map(String).includes(String(d.id))) members.push(d);
    else if (isHaDevice(d)) ha.push(d);
    else other.push(d);
  }
  return { members, ha, other };
}

/* Touch Gesture Lookup Simulator (P18): replicate juniper/gesturepad.lua +
   harmony.lua key-gate over a MapList.
   Returns { ok, reason, deviceId, command, resolved: 'soft'|'hard'|null,
              hardGateOk, warnings[] }. */
export function simulateGestureLookup(mapList, activityId, gestureKey) {
  const id = String(activityId);
  const maps = mapList?.ButtonMaps ?? [];
  const activityMap = maps.find((m) => String(m?.ButtonMapIdentifier) === `16417Activity${id}`);
  if (!activityMap) return { ok: false, reason: "no-activity-map", warnings: ["No remote screen for this activity yet."] };
  const gesture = (activityMap.Buttons ?? []).find(
    (b) => String(b?.__type ?? "").includes("GestureRemoteButton") && String(b?.ButtonKey) === String(gestureKey),
  );
  if (!gesture) return { ok: false, reason: "no-gesture", warnings: [`No ${gestureKey} gesture on this activity yet.`] };
  const action = gesture.ButtonAction;
  if (!action || !String(action?.CommandName ?? "")) {
    return { ok: false, reason: "no-action", warnings: [`${gestureKey} has no command assigned.`] };
  }
  const deviceId = String(action["DeviceId-"] ?? "");
  const command = String(action.CommandName ?? "");
  const functionId = Number(action["FunctionId-"] ?? 0);
  const deviceMap = maps.find((m) => String(m?.ButtonMapIdentifier) === `16417Device${deviceId}`);
  if (!deviceMap) {
    return {
      ok: false, reason: "no-device-screen", deviceId, command, functionId,
      warnings: [`Device ${deviceId} has no remote screen, so ${gestureKey} → ${command} does nothing.`],
    };
  }
  const buttons = deviceMap.Buttons ?? [];
  // Match FunctionId- > 0 first, else CommandName/ButtonKey (Touch behaviour).
  let target = null;
  if (Number.isFinite(functionId) && functionId > 0) {
    target = buttons.find((b) => Number(b?.ButtonAction?.["FunctionId-"] ?? 0) === functionId) ?? null;
  }
  if (!target) {
    const want = normCmd(command);
    target = buttons.find((b) => {
      const a = b?.ButtonAction;
      if (!a || String(a?.__type ?? "").includes("ButtonClientAction")) return false;
      if (normCmd(a?.CommandName) === want) return true;
      if (String(b?.ButtonKey ?? "").toLowerCase() === want) return true;
      return false;
    }) ?? null;
  }
  if (!target) {
    return {
      ok: false, reason: "no-command-on-screen", deviceId, command, functionId,
      warnings: [`Device ${deviceId} has no ${command} on its remote screen.`],
    };
  }
  const isHard = String(target?.__type ?? "").includes("HardRemoteButton");
  const warnings = [];
  if (isOneShotCommand(command)) {
    warnings.push(`Raw toggles (${command}) on gestures can double-fire: gestures cannot use hub one-shot protection. Prefer discrete On/Off or Up/Down, or enable HA-side debounce.`);
  }
  if (isHard) {
    const key = String(target.ButtonKey ?? "");
    const activityHard = new Set(
      (activityMap.Buttons ?? [])
        .filter((b) => String(b?.__type ?? "").includes("HardRemoteButton"))
        .map((b) => String(b?.ButtonKey ?? "")),
    );
    if (!activityHard.has(key)) {
      return {
        ok: false, reason: "hard-gate-blocked", deviceId, command, functionId,
        resolved: "hard", hardKey: key, hardGateOk: false,
        warnings: [`${gestureKey} → ${command} resolves to hard key ${key}, which is not mapped in this activity (the remote drops keys the activity doesn't map).`],
      };
    }
    return { ok: true, reason: "hard", deviceId, command, functionId, resolved: "hard", hardKey: key, hardGateOk: true, warnings };
  }
  return { ok: true, reason: "soft", deviceId, command, functionId, resolved: "soft", hardGateOk: true, warnings };
}

export function gestureWarningsForActivity(mapList, activityId) {
  const out = [];
  const maps = mapList?.ButtonMaps ?? [];
  const activityMap = maps.find((m) => String(m?.ButtonMapIdentifier) === `16417Activity${String(activityId)}`);
  if (!activityMap) return out;
  for (const b of activityMap.Buttons ?? []) {
    if (!String(b?.__type ?? "").includes("GestureRemoteButton")) continue;
    const key = String(b?.ButtonKey ?? "");
    if (!GESTURE_KEYS.includes(key)) {
      out.push({ key, level: "warn", message: `Unknown gesture key ${key}; remotes only resolve SwipeUp/Down/Left/Right and Tap.` });
      continue;
    }
    const sim = simulateGestureLookup(mapList, activityId, key);
    for (const w of sim.warnings ?? []) out.push({ key, level: sim.ok ? "warn" : "error", message: w, sim });
    // Long/double on gestures: hub never runs them, Touch resolves locally.
    if (b?.ButtonLongPressAction && !isOneShotCommand(b?.ButtonAction?.CommandName)) {
      // Hold-swipes ramp; informational only.
    }
  }
  return out;
}

/* Firmware ButtonKey for every key on the keypad, with the label people see.
   The physical remote's Back key is stored as PrevChannel in real MapLists. */
export const KEY_LABELS = Object.freeze({
  Rewind: "Rewind",
  Play: "Play",
  Pause: "Pause",
  FastForward: "Fast forward",
  Record: "Record",
  Stop: "Stop",
  Red: "Red",
  Green: "Green",
  Yellow: "Yellow",
  Blue: "Blue",
  Dvr: "DVR",
  Guide: "Guide",
  Info: "Info",
  Exit: "Exit",
  Menu: "Menu",
  DirectionUp: "Up",
  DirectionDown: "Down",
  DirectionLeft: "Left",
  DirectionRight: "Right",
  Select: "OK",
  VolumeUp: "Volume up",
  VolumeDown: "Volume down",
  VolumeMute: "Mute",
  PrevChannel: "Back",
  ChannelUp: "Channel up",
  ChannelDown: "Channel down",
  Number1: "1",
  Number2: "2",
  Number3: "3",
  Number4: "4",
  Number5: "5",
  Number6: "6",
  Number7: "7",
  Number8: "8",
  Number9: "9",
  Number0: "0",
  Dash: "–",
  Enter: "Enter",
});

const CANONICAL = new Map(Object.keys(KEY_LABELS).map((k) => [k.toLowerCase(), k]));

/** Stored ButtonKey -> keypad key ("DVR" and "Dvr" both appear in real maps). */
export function canonicalKey(buttonKey) {
  return CANONICAL.get(String(buttonKey ?? "").toLowerCase()) ?? null;
}

function actionOf(raw) {
  if (!raw || !raw.CommandName || raw["DeviceId-"] == null) return null;
  return {
    deviceId: String(raw["DeviceId-"]),
    command: String(raw.CommandName),
    functionId: raw["FunctionId-"] ?? null,
  };
}

const mapsOf = (config) => config?.mapList?.ButtonMaps ?? [];

const MAP_TYPES = ["DeviceButtonMap", "ActivityButtonMap", "RootButtonMap"];
const BUTTON_TYPES = ["HardRemoteButton", "SoftRemoteButton", "GestureRemoteButton"];
const ACTION_FIELDS = ["ButtonAction", "ButtonLongPressAction", "ButtonDoublePressAction"];

/**
 * Check a MapList against the shapes the hub's and the Touch's stock
 * button-map reader can load, mirroring the hub's validateGraph in
 * payload/activity/codexactivity.lua. Returns error strings; an empty
 * list means the MapList is safe to save. Device and activity references
 * are the hub's job and are not checked here. Duplicate on-screen slots
 * are rejected in activity maps only: device maps keep their existing
 * slots until the device screen editor sets their rule, and the number
 * pad (FunctionGroupType 2) is keyed separately from other soft buttons.
 */
export function validateMapList(mapList) {
  if (!mapList || !Array.isArray(mapList.ButtonMaps)) {
    return ["MapList.ButtonMaps must be an array"];
  }
  const errors = [];
  for (const map of mapList.ButtonMaps) {
    if (!map || typeof map !== "object" || Array.isArray(map)) {
      errors.push("MapList contains a non-object button map");
      continue;
    }
    const mapLabel = String(map.ButtonMapIdentifier ?? map["ButtonMapId-"] ?? "unknown");
    const mapType = typeof map.__type === "string" ? map.__type : "";
    const isActivityMap = mapType.includes("ActivityButtonMap");
    if (!MAP_TYPES.some((t) => mapType.includes(t))) {
      errors.push(`MapList map ${mapLabel} has an unknown or missing __type`);
    }
    if (!Array.isArray(map.Buttons)) {
      errors.push(`MapList map ${mapLabel} is missing its Buttons array`);
      continue;
    }
    const sequenceIds = new Set();
    if (map.Sequences !== undefined && map.Sequences !== null) {
      if (!Array.isArray(map.Sequences)) {
        errors.push(`MapList map ${mapLabel} has an invalid Sequences value`);
      } else {
        for (const sequence of map.Sequences) {
          if (!sequence || typeof sequence !== "object" || sequence.SequenceId == null) {
            errors.push(`MapList map ${mapLabel} has a sequence without a SequenceId`);
            continue;
          }
          const sequenceLabel = String(sequence.SequenceId);
          sequenceIds.add(sequenceLabel);
          if (!Array.isArray(sequence.Actions)) {
            errors.push(`MapList map ${mapLabel} sequence ${sequenceLabel} is missing its Actions array`);
            continue;
          }
          for (const step of sequence.Actions) {
            const stepType = step && typeof step === "object" && typeof step.__type === "string" ? step.__type : "";
            if (stepType.includes("ButtonCommandAction")) continue;
            if (stepType.includes("ButtonDelayAction")) {
              if (typeof step.Duration !== "number") {
                errors.push(`MapList map ${mapLabel} sequence ${sequenceLabel} has a delay step without a numeric Duration`);
              }
              continue;
            }
            errors.push(`MapList map ${mapLabel} sequence ${sequenceLabel} has a step with an unknown or missing __type`);
          }
        }
      }
    }
    const seenSlots = new Set();
    for (const button of map.Buttons) {
      if (!button || typeof button !== "object" || Array.isArray(button)) {
        errors.push(`MapList map ${mapLabel} contains a non-object button`);
        continue;
      }
      const buttonType = typeof button.__type === "string" ? button.__type : "";
      const isSoft = buttonType.includes("SoftRemoteButton");
      if (!BUTTON_TYPES.some((t) => buttonType.includes(t))) {
        errors.push(`MapList map ${mapLabel} has a button with an unknown or missing __type`);
        continue;
      }
      if (!isSoft && (typeof button.ButtonKey !== "string" || button.ButtonKey === "")) {
        errors.push(`MapList map ${mapLabel} button is missing ButtonKey`);
      }
      if (isSoft) {
        const index = button.MenuItem && typeof button.MenuItem === "object" ? button.MenuItem.IndexInMenu : undefined;
        if (!Number.isSafeInteger(index) || index < 0) {
          errors.push(`MapList map ${mapLabel} soft button has an invalid MenuItem.IndexInMenu`);
        } else if (isActivityMap) {
          const slotKey = `${button.FunctionGroupType === 2 ? "pad" : "soft"}:${index}`;
          if (seenSlots.has(slotKey)) {
            errors.push(`MapList map ${mapLabel} has duplicate IndexInMenu ${index} for on-screen buttons`);
          }
          seenSlots.add(slotKey);
        }
      }
      for (const field of ACTION_FIELDS) {
        const action = button[field];
        if (!action || typeof action !== "object") continue;
        const actionType = typeof action.__type === "string" ? action.__type : "";
        if (actionType.includes("ButtonSequenceAction") && !sequenceIds.has(String(action.SequenceId))) {
          errors.push(`MapList map ${mapLabel} button references missing sequence ${String(action.SequenceId)}`);
        }
      }
    }
  }
  return errors;
}

/** The activity's button maps, its own 16414 map first (as the app does). */
export function activityButtonMaps(config, activityId) {
  const id = String(activityId);
  const own = `16414Activity${id}`;
  return mapsOf(config)
    .filter((m) => m?.__type === "ActivityButtonMap" && String(m["ActivityId-"]) === id)
    .sort((a, b) => (a.ButtonMapIdentifier === own ? 0 : 1) - (b.ButtonMapIdentifier === own ? 0 : 1));
}

/** "PreviousTrack" -> "Previous Track"; labels with a space are left alone. */
export function humanizeLabel(raw) {
  const text = String(raw ?? "");
  return text.includes(" ") ? text : text.replace(/([a-z])([A-Z])/g, "$1 $2");
}

/* On-screen (touch screen) buttons that send one command, in menu order.
   Sequences are skipped: the web does not run them yet. */
function touchButtons(config, activityId) {
  const id = String(activityId);
  const out = [];
  const seen = new Set();
  for (const map of mapsOf(config)) {
    if (String(map?.["ActivityId-"]) !== id) continue;
    if (!String(map?.ButtonMapIdentifier ?? "").startsWith("16417")) continue;
    for (const button of map.Buttons ?? []) {
      if (button?.__type !== "SoftRemoteButton") continue;
      if (button.ButtonAction?.__type !== "ButtonCommandAction") continue;
      const action = actionOf(button.ButtonAction);
      if (!action) continue;
      const dedupe = `${action.deviceId}:${action.command}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      out.push({
        label: humanizeLabel(String(button.TextOnRemote || action.command).trim()),
        action,
        order: Number(button.MenuItem?.IndexInMenu ?? Number.MAX_SAFE_INTEGER),
        digit: /^\d$/.test(action.command.trim()) ? action.command.trim() : null,
      });
    }
  }
  return out.sort((a, b) => a.order - b.order);
}

/** On-screen buttons for the "This activity" row (digits feed the number pad). */
export function softButtons(config, activityId) {
  return touchButtons(config, activityId)
    .filter((b) => b.digit === null)
    .map(({ label, action }) => ({ label, action }));
}

/**
 * Every keypad key an activity maps: key -> { key, label, press, hold }.
 * The first map that sets a key wins, own map first. Number keys fall back to
 * the activity's on-screen digit buttons, which many activities use instead.
 */
export function activityKeys(config, activityId) {
  const keys = new Map();
  for (const map of activityButtonMaps(config, activityId)) {
    for (const button of map.Buttons ?? []) {
      const key = canonicalKey(button?.ButtonKey);
      if (!key || keys.has(key)) continue;
      const press = actionOf(button.ButtonAction);
      if (!press) continue;
      keys.set(key, { key, label: KEY_LABELS[key], press, hold: actionOf(button.ButtonLongPressAction) });
    }
  }
  for (const button of touchButtons(config, activityId)) {
    const key = button.digit === null ? null : `Number${button.digit}`;
    if (!key || keys.has(key)) continue;
    keys.set(key, { key, label: KEY_LABELS[key], press: button.action, hold: null });
  }
  return keys;
}

/* Keypad keys for driving one device directly, matched by command name
   through the remote-layout aliases, as the hub's own IR page does, except
   that an exact name wins (see matchCommand). */
const DEVICE_KEY_BY_LABEL = { ...BUTTON_KEY_BY_LABEL, Dash: "Dash", Enter: "Enter" };

/** key -> { key, label, press } for a device from state.devices(). */
export function deviceKeys(device) {
  const keys = new Map();
  if (!device) return keys;
  for (const hotspot of REMOTE_BUTTONS) {
    const key = DEVICE_KEY_BY_LABEL[hotspot.label];
    if (!key || keys.has(key)) continue;
    const command = matchCommand(device.commands, hotspot.aliases);
    if (!command) continue;
    keys.set(key, {
      key,
      label: KEY_LABELS[key],
      press: { deviceId: device.id, command: command.name, functionId: command.functionId ?? null },
      hold: null,
    });
  }
  return keys;
}

/** True when a key really sends Home (activities often map Menu or Exit to it). */
export function sendsHome(keys, key) {
  return /home/i.test(keys.get(key)?.press?.command ?? "");
}

/* -- Activities and devices, as the app shows them ----------------------- */

/** An activity's roles in power-on order. */
export function activityRoles(activity) {
  return (activity?.Roles ?? [])
    .filter((r) => r?.["DeviceId-"] != null)
    .map((r) => ({
      deviceId: String(r["DeviceId-"]),
      roleType: String(r.__type || "DisplayActivityRole"),
      input: r.SelectedInput?.Name ? String(r.SelectedInput.Name) : null,
      powerOnOrder: Number(r.PowerOnOrder ?? 1),
    }))
    .sort((a, b) => a.powerOnOrder - b.powerOnOrder);
}

/** Device names taking part in an activity, in power-on order, no repeats. */
export function deviceNamesFor(activity, devices) {
  const byId = new Map(devices.map((d) => [d.id, d.name]));
  const names = [];
  for (const role of activityRoles(activity)) {
    const name = byId.get(role.deviceId);
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

const ROLE_LABELS = {
  DisplayActivityRole: "Screen",
  VolumeActivityRole: "Sound / volume",
  PlayMovieActivityRole: "Plays movies & shows",
  PlayGameActivityRole: "Plays games",
  PlayMediaActivityRole: "Plays music",
  ChannelChangingActivityRole: "Changes channels",
  KeyboardTextEntryActivityRole: "Keyboard / typing",
};

/** The job a role does, phrased the way the app does. */
export function roleLabel(roleType) {
  return ROLE_LABELS[roleType] ?? String(roleType ?? "").replace(/ActivityRole$/, "");
}

/** Material icon name for an activity (DomainIcons.activityIcon). */
export function activityIconName(activity) {
  const name = String(activity?.Name ?? "").toLowerCase();
  if (name.includes("pc") || name.includes("computer")) return "computer";
  switch (Number(activity?.Type)) {
    case 1: return "tv";
    case 2: return "movie";
    case 3: return "sports_esports";
    case 4: return "music_note";
    default: return "play_arrow";
  }
}

const STREAMER_HINTS = ["shield", "google tv", "chromecast", "apple tv", "roku", "fire tv", "firestick"];

/** Material icon name for a device (DomainIcons.deviceIcon). */
export function deviceIconName(device) {
  const type = String(device?.typeLabel ?? device?.type ?? "").toLowerCase();
  const name = `${device?.name ?? ""} ${device?.model ?? ""}`.toLowerCase();
  if (STREAMER_HINTS.some((hint) => name.includes(hint))) return "cast";
  if (/television|tv|projector/.test(type)) return "tv";
  if (/amplifier|receiver|sound|speaker/.test(type)) return "speaker";
  if (/game|console/.test(type)) return "sports_esports";
  if (/computer|pc/.test(type)) return "computer";
  if (/media|stream/.test(type)) return "cast";
  if (/switch/.test(type)) return "settings_input_hdmi";
  if (/camera/.test(type)) return "videocam";
  if (device?.isBluetooth) return "bluetooth";
  return "tv";
}

/* -- Fix it -------------------------------------------------------------- */

const POWER_ON_KEYS = new Set(["poweron", "on"]);
const POWER_TOGGLE_KEYS = new Set(["powertoggle", "power"]);

/* "HDMI 2" -> the command that selects it: the device's own InputFeature
   mapping first, then the "Input" + name convention. */
function inputCommandFor(device, inputName) {
  const inputs = (device.entry?.DeviceFeatures ?? [])
    .flatMap((f) => (Array.isArray(f?.Inputs) ? f.Inputs : []));
  const actions = inputs.find((i) => i?.InputName === inputName)?.Actions;
  const mapped = (Array.isArray(actions) ? actions : []).find((a) => a?.IRCommandName)?.IRCommandName;
  const byName = (name) => device.commands.find((c) => c.name === name);
  if (mapped && byName(mapped)) return byName(mapped);
  const wanted = commandKey(inputName);
  if (!wanted) return null;
  return device.commands.find((c) => commandKey(c.name) === `input${wanted}`)
    ?? device.commands.find((c) => commandKey(c.name) === wanted)
    ?? null;
}

/**
 * Fix it: per device in an activity, the one command that turns it on and the
 * one that selects the activity's input. Configured power commands (the
 * device's PowerFeature) beat name guessing; a toggle is offered separately
 * because resending it can turn the device off. When `haState` is supplied,
 * HA-backed devices also carry `haInfo` and a human `haHint` ("Already on ·
 * HDMI 1", "Off in Home Assistant", "State unknown").
 */
export function fixItDevices(activity, devices, haState = null) {
  const byId = new Map(devices.map((d) => [d.id, d]));
  const out = [];
  const seen = new Set();
  for (const role of activityRoles(activity)) {
    if (seen.has(role.deviceId)) continue;
    seen.add(role.deviceId);
    const device = byId.get(role.deviceId);
    if (!device) continue;
    const roles = activityRoles(activity).filter((r) => r.deviceId === role.deviceId);
    const named = (name) =>
      name ? device.commands.find((c) => c.name.toLowerCase() === String(name).toLowerCase()) ?? null : null;
    const settings = device.entry ? readDeviceSettings(device.entry) : null;
    const configured = settings?.hasPowerFeature ? settings.power : null;
    let powerOn = null;
    let powerToggle = null;
    if (configured) {
      if (configured.type === "discrete") powerOn = named(configured.on);
      if (configured.type === "toggle") powerToggle = named(configured.toggle);
    } else {
      powerOn = device.commands.find((c) => POWER_ON_KEYS.has(commandKey(c.name))) ?? null;
      powerToggle = device.commands.find((c) => POWER_TOGGLE_KEYS.has(commandKey(c.name))) ?? null;
    }
    const inputName = roles.find((r) => r.input)?.input ?? null;
    const inputCommand = inputName ? inputCommandFor(device, inputName) : null;
    if (!powerOn && !powerToggle && !inputCommand) continue;
    const haInfo = haState ? describeHaDeviceState(device, haState) : null;
    let haHint = null;
    if (haInfo) {
      if (!haInfo.known) {
        haHint = "State unknown";
      } else if (haInfo.power === "on") {
        const parts = [`${device.name} is already on`];
        if (haInfo.source) parts.push(`on ${haInfo.source}`);
        else if (haInfo.activity) parts.push(`in ${haInfo.activity}`);
        haHint = parts.join(" · ");
      } else {
        haHint = `${device.name} is off`;
      }
    }
    out.push({
      device,
      roles: [...new Set(roles.map((r) => roleLabel(r.roleType)))],
      powerOn,
      powerToggle: powerOn ? null : powerToggle,
      inputName,
      inputCommand,
      haInfo,
      haHint,
    });
  }
  return out;
}
