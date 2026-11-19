/* Pure helpers for Control skin power-key + off-state send copy.
   No DOM. Power on the photo is a UI affordance only — never written into
   a saved ButtonMap. */

import { matchCommand } from "../remote-layout.js";

/** Remote-layout aliases for the photo's power hotspot. */
export const POWER_ALIASES =
  "poweroff|power off|standby|shutdown|off|powertoggle|power toggle|power";

/**
 * Resolve what the skin Power key should do.
 * @returns
 *   | { kind: "activity-poweroff" }
 *   | { kind: "device-power", deviceId, command, functionId }
 *   | { kind: "inert", reason: "nothing-running" | "no-power-command" | "no-device" }
 */
export function resolveSkinPowerAction({
  mode,
  currentActivityId,
  selectedDeviceId,
  deviceCommands,
  deviceEntry,
}) {
  if (mode === "activities") {
    const id = String(currentActivityId ?? "");
    if (id && id !== "-1") return { kind: "activity-poweroff" };
    return { kind: "inert", reason: "nothing-running" };
  }
  const deviceId = String(selectedDeviceId ?? "");
  if (!deviceId) return { kind: "inert", reason: "no-device" };
  let cmd = matchCommand(deviceCommands, POWER_ALIASES);
  if (!cmd?.name && deviceEntry) {
    const features = Array.isArray(deviceEntry.DeviceFeatures) ? deviceEntry.DeviceFeatures : [];
    const pf = features.find((f) => String(f?.__type ?? "").includes("PowerFeature"));
    const powerType = Number(pf?.PowerTypeId);
    if (pf && powerType !== 0 && powerType !== 3) {
      const cmds = Array.isArray(deviceCommands) ? deviceCommands : [];
      const candidates = [
        ...(Array.isArray(pf.PowerOffActions) ? pf.PowerOffActions : []),
        ...(Array.isArray(pf.PowerToggleActions) ? pf.PowerToggleActions : []),
        ...(Array.isArray(pf.PowerOnActions) ? pf.PowerOnActions : []),
      ];
      for (const action of candidates) {
        if (!action?.IRCommandName) continue;
        const hit = cmds.find((c) => c?.name === action.IRCommandName);
        if (hit?.name) {
          cmd = hit;
          break;
        }
      }
    }
  }
  if (!cmd?.name) return { kind: "inert", reason: "no-power-command" };
  return {
    kind: "device-power",
    deviceId,
    command: cmd.name,
    functionId: cmd.functionId ?? cmd["FunctionId-"] ?? 0,
  };
}

/** True when hub state means PowerOff / unknown (nothing useful is on). */
export function isEverythingOff(currentActivityId) {
  const id = String(currentActivityId ?? "");
  return !id || id === "-1";
}

/**
 * Status note after a successful IR send in Activities mode.
 * Does not block the send — only adds context when nothing is running.
 */
export function offStateSendNote({
  baseNote = "sent",
  currentActivityId,
  selectedActivityName,
} = {}) {
  if (!isEverythingOff(currentActivityId)) return baseNote;
  const name = String(selectedActivityName || "").trim();
  if (name) {
    return `${baseNote} · nothing is running — start ${name}?`;
  }
  return `${baseNote} · nothing is running — start an activity first`;
}

/** Aria/title for the skin power key given a resolved action. */
export function skinPowerLabel(action) {
  if (!action || action.kind === "inert") {
    if (action?.reason === "nothing-running") {
      return "Power off — nothing is running";
    }
    if (action?.reason === "no-power-command") {
      return "Power — no power command on this device";
    }
    return "Power — not available";
  }
  if (action.kind === "activity-poweroff") {
    return "Power off — end the running activity";
  }
  return `Power — ${action.command}`;
}
