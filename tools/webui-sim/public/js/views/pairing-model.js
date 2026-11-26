/* Device pairing, the parts every page shares (pure, for node:test): which
   kind of pairing a device has, what its status says, and how a pairing
   session's steps go. The pairing sheet (pairing-sheet.js) and the device
   page use it; the hub's GET /api/pairing answers from files only
   (codex_webui.c render_pairing_json), and the network TV services answer
   live. All wording lives here. */

import { ANDROIDTV_TAG } from "./androidtv-model.js";

/* Device.Transport is a bitmask: 1 IR, 32 Bluetooth, 64 IP (a Sony TV is 65).
   Missing reads as IR; anything but a positive whole number has no bits, as
   the hub reads it. */
function transportHas(value, bit) {
  const bits = value === undefined || value === null ? 1 : Number.isInteger(value) && value > 0 ? value : 0;
  return (bits & bit) !== 0;
}

/* What each kind is, and whether this web app can pair it yet. */
export const PAIRING_KINDS = Object.freeze({
  androidtv: { label: "Network TV", canPair: true },
  webos: { label: "LG webOS", canPair: true },
  "bt-keyboard": { label: "Bluetooth keyboard", canPair: false, where: "#bluetooth", whereLabel: "Bluetooth page" },
  "ip-register": { label: "IP control", canPair: false },
  bluetooth: { label: "Bluetooth", canPair: false },
});

/* The pairing kind of a hub device entry, like the hub's pairing_kind_state:
   the hub's own network devices by their tag, then a stock IP device with a
   registration template (a Sony TV), then a stock Bluetooth device. "" when
   the device pairs with nothing (IR, Home Assistant, Switch 2). */
export function pairingKindOf(entry) {
  const device = entry?.Device ?? {};
  const autoId = String(device.AutoDetectedDevice?.Id ?? "");
  if (autoId.startsWith(ANDROIDTV_TAG)) return "androidtv";
  if (autoId.startsWith("melodious-webos-")) return "webos";
  if (autoId.startsWith("melodious-bt-")) return "bt-keyboard";
  if (autoId.startsWith("melodious-")) return "";
  const template = device.RegisterSection;
  if (transportHas(device.Transport, 64) && template && typeof template === "object" && !Array.isArray(template)) return "ip-register";
  if (transportHas(device.Transport, 32)) return "bluetooth";
  return "";
}

/* GET /api/pairing's list as deviceId → { kind, state, reason }. */
export function pairingFiles(reply) {
  const out = new Map();
  for (const d of Array.isArray(reply?.devices) ? reply.devices : []) {
    if (typeof d?.deviceId === "string" && d.deviceId) {
      out.set(d.deviceId, { kind: String(d.kind ?? ""), state: String(d.state ?? "unknown"), reason: String(d.reason ?? "") });
    }
  }
  return out;
}

/* One device's status: { state, text, canPair }.
   state is paired | not-paired | needs-attention | unknown.
   file: its GET /api/pairing entry. problem: its entry in the tab's
   pairing-problems list (a send this tab saw fail). tv: for a network TV,
   its entry in the service's live status, null when the service doesn't list
   it, undefined when that wasn't asked. */
export function pairingStatus({ kind, file = null, problem = null, tv = undefined } = {}) {
  const meta = PAIRING_KINDS[kind];
  if (!meta) return null;
  const canPair = meta.canPair;
  const attention = problem?.reason || (file?.state === "needs-attention" ? file.reason : "");
  if (attention) {
    return {
      state: "needs-attention",
      text: attention === "bt-not-connected"
        ? "Didn't connect over Bluetooth the last time. Check that it's on; if it still won't connect, pair it again."
        : "Refused the last command: it no longer knows this hub. Pair it again.",
      canPair,
    };
  }
  if (kind === "androidtv" && tv !== undefined) {
    if (tv === null) return { state: "not-paired", text: "Not paired with this hub.", canPair };
    if (tv.connected) return { state: "paired", text: "Paired and connected.", canPair };
    return { state: "unknown", text: "Paired, not connected right now (it may be off).", canPair };
  }
  if (kind === "webos" && tv !== undefined) {
    if (!tv?.paired) return { state: "not-paired", text: "Not paired with this hub.", canPair };
    return { state: "paired", text: tv.connected ? "Paired and connected." : "Paired, not connected right now (it may be off).", canPair };
  }
  if (file?.state === "paired") return { state: "paired", text: "Paired with this hub.", canPair };
  if (file?.state === "not-paired") {
    return {
      state: "not-paired",
      text: kind === "ip-register"
        ? "Not paired with this hub: the hub has no registration from it, so its network commands will be refused. This happens after the hub is replaced."
        : "Not paired with this hub.",
      canPair,
    };
  }
  return {
    state: "unknown",
    text: kind === "bluetooth" ? "Paired with a hub before; the hub can't tell from here whether it's this one." : "",
    canPair,
  };
}

/* The pill label for a state: words, not colour alone. */
export function pairingStateLabel(state) {
  return ({ paired: "Paired", "not-paired": "Not paired", "needs-attention": "Needs pairing" })[state] ?? "Pairing unknown";
}

/* -- a network TV pairing session (codex_androidtv's /api/androidtv/pair-*) -- */

/* The sheet step for codex_androidtv's pairing state. */
export function androidTvPairStep(state) {
  switch (state) {
    case "preparing":
    case "connecting":
      return "waiting";
    case "code":
      return "code";
    case "checking":
      return "checking";
    case "paired":
      return "done";
    default:
      return "failed"; // failed, idle (stopped), or an answer this doesn't know
  }
}

/* After pairing a device's TV again: the same TV keeps its id (codex_androidtv
   hashes the TV's own certificate), so its hub device works again. A
   different id is another TV, or this one after a factory reset: the device
   still points at the old id, and the new pairing is undone. */
export function androidTvRepairResult({ wantedTvId, pairedTvId, deviceName = "the TV" }) {
  if (pairedTvId && pairedTvId === wantedTvId) {
    return { ok: true, undo: "", text: `${deviceName} is paired with the hub again.` };
  }
  return {
    ok: false,
    undo: pairedTvId || "",
    text: `That TV isn't the one ${deviceName} was set up with (or it was reset, which gives it a new identity). Nothing was changed. To use it, delete ${deviceName} and add the TV again.`,
  };
}

/* Before pairing a TV again: refuse an address that is already another hub
   device's TV (codex_androidtv would rename it, and the result would be
   refused anyway). found: /api/androidtv/discover's list (paired = the TV id
   when the hub has it); tvs: /api/androidtv/status's list. "" when fine. */
export function androidTvRepairProblem({ host, wanted, found = [], tvs = [], devicesByTv = new Map() }) {
  const known = (found ?? []).find((f) => f?.host === host)?.paired || (tvs ?? []).find((t) => t?.host === host)?.id || "";
  if (!known || known === wanted) return "";
  const other = devicesByTv.get?.(known);
  return other
    ? `That address is ${other}'s TV, not this one. Pick the TV this device was set up with.`
    : "That address is another TV the hub knows, not this one. Pick the TV this device was set up with.";
}

/* Whether the session keeps polling the hub: always, except while the code
   step waits for the person; once a code was sent, until the hub moves on. */
export function keepPolling(step, codeSent) {
  return step !== "code" || Boolean(codeSent);
}

/* The sheet closed mid-session and the hub answered the cancel: the TV id to
   unpair, "" for none. The device's own TV is never unpaired; another is,
   unless a hub device uses it (pairingToUndo checks that). */
export function closeUndoTvId(cancelReply, wanted) {
  const id = String(cancelReply?.tvId ?? "");
  return id && id !== wanted ? id : "";
}
