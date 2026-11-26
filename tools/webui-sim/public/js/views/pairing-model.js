/* Device pairing, the parts every page shares (pure, for node:test): which
   kind of pairing a device has, what its status says, and how a pairing
   session's steps go. The pairing sheet (pairing-sheet.js) and the device
   page use it; the hub's GET /api/pairing answers from files only
   (codex_webui.c render_pairing_json), and the network TV services answer
   live. A Sony TV (ip-register) and a stock Bluetooth device pair through
   the hub's /api/pairing/start|finish|cancel. All wording lives here. */

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
  "ip-register": { label: "IP control", canPair: true },
  bluetooth: { label: "Bluetooth", canPair: true },
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

/* One device's status: { state, label, text, canPair }; label is the pill.
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
      // A device that only didn't connect may just be off: don't call that
      // "needs pairing".
      label: pairingIsTheFix(attention) ? pairingStateLabel("needs-attention") : "Didn't connect",
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

/* -- devices the stock engine pairs (/api/pairing/start|finish|cancel) ------- */

/* An address the hub will send a pairing request to: a private (RFC 1918)
   dotted quad, as the hub checks it. */
export function isPairingHost(host) {
  const parts = String(host ?? "").split(".");
  if (parts.length !== 4 || parts.some((p) => !/^\d{1,3}$/.test(p) || Number(p) > 255)) return false;
  const [a, b] = parts.map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/* The code a Sony TV shows: 4 digits (the hub takes 4 to 8). */
export function normalizePin(text) {
  const code = String(text ?? "").replace(/\s+/g, "");
  if (!code) return { code: "", error: "Type the code the TV shows." };
  if (!/^\d{4,8}$/.test(code)) return { code: "", error: "The code is the 4 digits on the TV's screen." };
  return { code, error: "" };
}

/* GET /api/pairing/find's list, the device's own address first. */
export function pairingFoundHosts(reply) {
  const out = [];
  for (const f of Array.isArray(reply?.found) ? reply.found : []) {
    if (isPairingHost(f?.host) && !out.some((o) => o.host === f.host)) out.push({ host: f.host, match: f.match === true });
  }
  return out.sort((x, y) => Number(y.match) - Number(x.match));
}

/* The sheet step for a start or finish answer. */
export function hubPairStep(reply) {
  return ["code", "select", "done"].includes(reply?.step) ? reply.step : "failed";
}

/* What pairing does, per kind, before it starts. */
export function hubPairingIntro(kind, name) {
  if (kind === "ip-register") {
    return `${name} shows a 4-digit code, and you type it here. Pair it again when the hub was replaced or ${name} refuses the hub's commands. Its activities and buttons stay as they are. The TV has to be on.`;
  }
  return `The hub forgets its old pairing with ${name}, then shows up on ${name} as “Harmony Keyboard” for you to pick. Pair it again when the hub was replaced or ${name} stopped answering. Its activities and buttons stay as they are, and stopping before the end usually keeps the pairing it had.`;
}

/* The steps to take on a stock Bluetooth device while the hub waits. */
export function bluetoothSelectSteps(name) {
  return [
    `On ${name}, open its Bluetooth settings. On a Shield: Settings, Remotes & Accessories, Add accessory.`,
    "Pick “Harmony Keyboard”, and accept Pair if it asks.",
    "Then press Done here.",
  ];
}

/* Whether a needs-pairing note says pairing is the fix, not just that the
   device might be off: a Bluetooth connect that failed is often a device
   that's asleep, so lists that nag leave it out (its own page still says). */
export function pairingIsTheFix(reason) {
  return reason !== "bt-not-connected";
}

/* Devices that need pairing now, from GET /api/pairing: not paired, or a
   send was refused for want of pairing. A state the files can't tell
   (unknown), or a device that only didn't connect, isn't listed. */
export function needsPairingList(reply) {
  return [...pairingFiles(reply)]
    .filter(([, f]) => (f.state === "not-paired" || (f.state === "needs-attention" && pairingIsTheFix(f.reason))) && PAIRING_KINDS[f.kind])
    .map(([deviceId, f]) => ({ deviceId, ...f, name: nameOf(reply, deviceId) }));
}

/* After a restore: every device that pairs with the hub itself. A new or
   replaced hub has none of their pairings, whatever the files say. */
export function pairableAfterRestore(reply) {
  return [...pairingFiles(reply)]
    .filter(([, f]) => PAIRING_KINDS[f.kind])
    .map(([deviceId, f]) => ({ deviceId, ...f, name: nameOf(reply, deviceId) }));
}

function nameOf(reply, deviceId) {
  const d = (Array.isArray(reply?.devices) ? reply.devices : []).find((x) => x?.deviceId === deviceId);
  return typeof d?.name === "string" && d.name ? d.name : `Device ${deviceId}`;
}
