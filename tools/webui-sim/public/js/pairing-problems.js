/* Devices whose last send or start failed because they need pairing with the
   hub (needsPairing in the hub's reply; views/send-problem-model.js). Kept for
   this tab only: a device leaves the list when the command that failed works
   again or the person dismisses its notice. Another command working proves
   little: a Sony TV's IR commands still work while its IP ones are refused.
   The remote and device pages show a banner for their devices
   (views/pairing-banner.js). */

const problems = new Map(); // deviceId → { deviceId, kind, reason, command }
const listeners = new Set();

function emit() {
  for (const fn of listeners) fn();
}

/* command: the one that failed, when a send did ("" for an activity start). */
export function notePairingProblem(needsPairing, command = "") {
  const id = String(needsPairing?.deviceId ?? "");
  if (!id || !needsPairing?.reason) return;
  const prev = problems.get(id);
  const next = { deviceId: id, kind: String(needsPairing.kind ?? ""), reason: String(needsPairing.reason), command: String(command ?? "") };
  if (prev && prev.reason === next.reason && prev.kind === next.kind && prev.command === next.command) return;
  problems.set(id, next);
  emit();
}

/* A send worked: the device leaves the list when it was the command that
   failed (or the failure came from an activity start, which names none). A
   Bluetooth connect failure goes on any send that worked: the link is back. */
export function noteSendWorked(deviceId, command) {
  const p = problems.get(String(deviceId ?? ""));
  if (p && (p.reason === "bt-not-connected" || !p.command || p.command === String(command ?? ""))) clearPairingProblem(deviceId);
}

/* The person dismissed the notice. */
export function clearPairingProblem(deviceId) {
  if (problems.delete(String(deviceId ?? ""))) emit();
}

export function hasPairingProblems() {
  return problems.size > 0;
}

export function pairingProblemsFor(deviceIds) {
  const out = [];
  for (const id of deviceIds ?? []) {
    const p = problems.get(String(id));
    if (p && !out.includes(p)) out.push(p);
  }
  return out;
}

/* fn() runs on every change; returns the unsubscribe. */
export function onPairingProblems(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/* For tests. */
export function resetPairingProblems() {
  problems.clear();
  emit();
}
