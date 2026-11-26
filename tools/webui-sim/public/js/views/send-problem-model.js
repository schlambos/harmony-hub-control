/* What a failed send or activity start means, in plain words. Pure, for
   node:test. The hub adds two members to such a reply (codex_webui.c
   write_send_problem, docs/API.md "Send failures"):
     engineCode    the engine's own code, when it answered;
     needsPairing  {deviceId, kind, reason} when pairing the device with the
                   hub again is the fix.
   A tap still answers 200 with ok:true, so api.irSend turns "sent": false
   into an error. All wording lives here, none on the hub. */

import { escapeHtml } from "../setup-kit.js";

/* Engine codes with a better sentence than the engine's own msg. */
export const ENGINE_CODES = Object.freeze({
  NOT_LOADED: 560, // "Account config data is not available"
  NO_COMMAND: 566, // "Command not found for device id:…"
});

/* The two members, checked; null when the reply has neither. */
export function sendProblem(data) {
  if (!data || typeof data !== "object") return null;
  const engineCode = Number.isInteger(data.engineCode) ? data.engineCode : null;
  const np = data.needsPairing;
  const needsPairing = np && typeof np === "object" && typeof np.deviceId === "string" && np.deviceId &&
    typeof np.reason === "string" && np.reason
    ? { deviceId: np.deviceId, kind: typeof np.kind === "string" ? np.kind : "", reason: np.reason }
    : null;
  return engineCode === null && !needsPairing ? null : { engineCode, needsPairing };
}

/* The engine's msg from its raw reply ('{"cmd":…,"code":566,"msg":"…"}'),
   or "" when the text isn't one. */
export function engineMessage(text) {
  if (typeof text !== "string" || !text.trim().startsWith("{")) return "";
  try {
    const reply = JSON.parse(text);
    return typeof reply?.msg === "string" ? reply.msg : "";
  } catch (_) {
    return "";
  }
}

/* One sentence for a device that needs pairing, and a short reason for the
   send log and the status line. */
export function pairingProblemText(needsPairing, deviceName) {
  const name = deviceName || "This device";
  switch (needsPairing?.reason) {
    case "ip-reauth":
      return {
        text: `${name} no longer accepts commands from this hub. It needs to be paired with the hub again.`,
        why: "This happens after the hub is replaced, or when the device refuses to renew the hub's registration. Its IR commands, if it has any, still work.",
        note: "needs pairing again",
      };
    case "bt-not-connected":
      return {
        text: `${name} isn't connected to the hub over Bluetooth.`,
        why: "Check that it's on and in range. If it still won't connect, it needs to be paired with the hub again.",
        note: "not connected over Bluetooth",
      };
    default:
      return { text: `${name} needs to be paired with this hub again.`, why: "", note: "needs pairing" };
  }
}

/* A failed send (api.irSend's ApiError) as { text, note, needsPairing }:
   text for the snackbar, note for the status line and send log. */
export function describeSendFailure(error, { deviceName = "the device", command = "the command" } = {}) {
  const problem = sendProblem(error?.data);
  const lead = `Couldn't send ${command} to ${deviceName}`;
  if (problem?.needsPairing) {
    const words = pairingProblemText(problem.needsPairing, deviceName);
    return { text: words.text, note: words.note, needsPairing: problem.needsPairing };
  }
  if (problem?.engineCode === ENGINE_CODES.NOT_LOADED) {
    return { text: `${lead}: the hub is still loading its setup. Try again in a moment.`, note: "hub still loading", needsPairing: null };
  }
  if (problem?.engineCode === ENGINE_CODES.NO_COMMAND) {
    return { text: `${lead}: the hub has no “${command}” command for it.`, note: "no such command", needsPairing: null };
  }
  // A tap's engine answer is in data.reply; a hold's is the error text.
  const raw = engineMessage(error?.data?.reply) || engineMessage(error?.message);
  if (problem?.engineCode != null) {
    const why = raw || "the hub's engine refused it";
    return { text: `${lead}: ${why} (code ${problem.engineCode}).`, note: why, needsPairing: null };
  }
  const message = raw || error?.message || "network error";
  return { text: `${lead} — ${message}`, note: message, needsPairing: null };
}

/* The part of an activity start's failure after "Couldn't start <name>",
   or "" to keep the hub's own error. */
export function startProblemText(error, nameOf = () => "") {
  const problem = sendProblem(error?.data);
  if (problem?.needsPairing) return pairingProblemText(problem.needsPairing, nameOf(problem.needsPairing.deviceId) || "").text;
  if (problem?.engineCode === ENGINE_CODES.NOT_LOADED) return "The hub is still loading its setup. Try again in a moment.";
  return "";
}

/* The persistent banners for the devices that need pairing ({deviceId,
   reason} each). Each says what's wrong and stays until the device works
   again or the person dismisses it. canPair(deviceId) adds "Pair now" for a
   device the pairing sheet can pair. */
export function pairingBannersMarkup(problems, nameOf = () => "", canPair = () => false) {
  return (problems ?? [])
    .map((p) => {
      const name = nameOf(p.deviceId) || "A device";
      const words = pairingProblemText(p, name);
      const rest = words.text.startsWith(name) ? words.text.slice(name.length) : ` ${words.text}`;
      return `<div class="notice notice-warn pairing-banner" data-pairing-device="${escapeHtml(p.deviceId)}">
          <div class="pairing-banner-text"><p><strong>${escapeHtml(name)}</strong>${escapeHtml(rest)}</p>${words.why ? `<p class="pairing-banner-why">${escapeHtml(words.why)}</p>` : ""}</div>
          <div class="pairing-banner-actions">
            ${canPair(p.deviceId) ? `<button type="button" class="btn btn-tonal" data-pairing-pair="${escapeHtml(p.deviceId)}" aria-haspopup="dialog">Pair now</button>` : ""}
            <button type="button" class="btn btn-text" data-pairing-dismiss="${escapeHtml(p.deviceId)}" aria-label="Dismiss the notice about ${escapeHtml(name)}">Dismiss</button>
          </div>
        </div>`;
    })
    .join("");
}
