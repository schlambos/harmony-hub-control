/* Pair a device with the hub again: one sheet for every kind the web app can
   pair. Steps, announced as they change:

     explain   what will happen; for a network TV, which TV (the ones the hub
               sees on the network, or an address typed in)
     waiting   the hub asks the device to show a code or a prompt
     code      the person types the code from the device's screen
     checking  the hub checks it
     done      or failed, saying why and what to try

   Network TV (codex_androidtv): pairing the same TV again keeps its id, so its
   hub device works again; a different TV (or one that was reset) is refused
   and its pairing undone, leaving the device as it was. LG webOS keeps its
   own sheet, which pairs and edits in one place. Other kinds can't be paired
   from here yet (pairing-model.js PAIRING_KINDS). */

import {
  cancelTvPairing,
  discoverTvs,
  finishTvPairing,
  forgetTv,
  getAndroidTvStatus,
  getTvPairing,
  startTvPairing,
} from "../api.js";
import { clearPairingProblem } from "../pairing-problems.js";
import * as hub from "../state.js";
import { escapeHtml, iconTile, listRow, openSheet, snackbar, spinner } from "../ui/shell.js";
import {
  androidTvIdOf,
  CODE_LENGTH,
  foundList,
  isAndroidTvEntry,
  normalizeCode,
  normalizeHost,
  pairingToUndo,
  pairStateText,
} from "./androidtv-model.js";
import { fieldId, setMessage, textField } from "./device-sheets.js";
import {
  androidTvPairStep,
  androidTvRepairProblem,
  androidTvRepairResult,
  closeUndoTvId,
  keepPolling,
  pairingKindOf,
} from "./pairing-model.js";
import { openWebOsSheet } from "./webos-sheet.js";

const DISCOVER_FOR_MS = 7000;
const POLL_MS = 600;

/* Opens the right sheet for the device, or returns null when it can't be
   paired from here. onDone(device) runs after a pairing that worked. */
export function openPairingSheet({ device, onDone } = {}) {
  const kind = pairingKindOf(device?.entry);
  if (kind === "webos") return openWebOsSheet({ device, onDone });
  if (kind === "androidtv") return openAndroidTvRepair({ device, onDone });
  return null;
}

function openAndroidTvRepair({ device, onDone }) {
  const wanted = androidTvIdOf(device);
  let step = "explain";
  let found = [];
  let searching = true;
  let saved = null; // the TV's entry in codex_androidtv, when it has one
  let chosen = { host: "", name: "" };
  let busy = false;
  let codeSent = false; // keep polling on "code" until the hub moves on
  let discoverRun = 0;  // a pick stops the search; a late answer is dropped
  let knownTvs = [];    // codex_androidtv's TVs, to refuse another device's
  let timer = null;
  let closed = false;
  const ids = { host: fieldId("repairHost"), code: fieldId("repairCode") };
  const stopTimer = () => {
    clearTimeout(timer);
    timer = null;
  };
  const devicesByTv = () => new Set(hub.devices().filter((d) => isAndroidTvEntry(d.entry)).map((d) => androidTvIdOf(d.entry)));
  // Undo a pairing this sheet made, unless a hub device uses it.
  const undo = (id) => {
    const tv = pairingToUndo(id, { devicesByTv: devicesByTv() });
    if (tv) forgetTv({ id: tv }).catch(() => {});
  };

  return openSheet({
    label: `Pair ${device.name} again`,
    onClose: () => {
      closed = true;
      stopTimer();
      if (step === "waiting" || step === "code" || step === "checking") {
        // The hub may have finished since the last poll; the answer names the
        // TV then. Undo it only when it's another TV.
        cancelTvPairing().then((res) => undo(closeUndoTvId(res, wanted)), () => {});
      }
    },
    render: (content, close) => {
      /* The title and body change with the step; the message line stays put,
         so what it says is announced. A new step moves focus to its title
         (the code step, to the code field), which announces the step and
         keeps focus off a button the step just removed. */
      let shownStep = "";
      function frame(title, body) {
        if (!content.querySelector("[data-pair-body]")) {
          content.innerHTML = `<div class="m-form pairing-sheet">
              <h2 class="sheet-title" tabindex="-1" data-pair-title></h2>
              <div data-pair-body></div>
              <p class="form-msg" data-msg role="status" aria-live="polite"></p>
            </div>`;
        }
        content.querySelector(".pairing-sheet").dataset.step = step;
        content.querySelector("[data-pair-title]").textContent = title;
        content.querySelector("[data-pair-body]").innerHTML = body;
      }

      /* Without a message, a redraw of the same step (the TV list filling in)
         keeps what the line says, an error included; a new step clears it. */
      let note = { text: "", kind: "info" };
      function draw(message, kind = "info") {
        if (closed) return;
        if (message !== undefined) note = { text: message, kind };
        else if (step !== shownStep) note = { text: "", kind: "info" };
        if (step === "explain") drawExplain();
        else if (step === "waiting" || step === "checking") drawWaiting();
        else if (step === "code") drawCode();
        setMessage(content.querySelector("[data-msg]"), note.text, note.kind);
        if (step !== shownStep) {
          shownStep = step;
          if (step !== "code") content.querySelector("[data-pair-title]")?.focus();
        }
      }

      function drawExplain() {
        const list = foundList(found, new Set()).map((tv) => listRow({
          title: tv.name,
          subtitle: tv.host === saved?.host ? `${tv.host} · where ${device.name} was` : tv.host,
          leading: iconTile("tv", { size: 40 }),
          chevron: true,
          attrs: `data-host="${escapeHtml(tv.host)}" data-name="${escapeHtml(tv.name)}"`,
        })).join("");
        const savedRow = saved?.host && !found.some((f) => f.host === saved.host)
          ? listRow({
            title: device.name,
            subtitle: `${saved.host} · where it was last`,
            leading: iconTile("tv", { size: 40 }),
            chevron: true,
            attrs: `data-host="${escapeHtml(saved.host)}" data-name="${escapeHtml(device.name)}"`,
          })
          : "";
        frame(`Pair ${device.name} again`, `
            <p class="sheet-text">The TV shows a code, and you type it here. Pair it again when the hub was replaced or the TV forgot the hub. Its activities and buttons stay as they are.</p>
            <h3 class="m-section">Pick the TV ${searching ? spinner("Looking for TVs") : ""}</h3>
            ${savedRow || list ? `<div class="m-list">${savedRow}${list}</div>` : `<p class="list-note">${searching ? "Looking for TVs…" : "No TVs found. The TV has to be on, on the same network as the hub. You can type its address instead."}</p>`}
            <form data-manual novalidate>
              ${textField({ id: ids.host, label: "Or type its address", placeholder: "192.168.1.40", attrs: 'inputmode="decimal"', hint: "Find it on the TV: Settings, Network & Internet, then the network it is on." })}
              <button type="submit" class="btn btn-tonal btn-block">Use this address</button>
            </form>`);
        content.querySelectorAll("[data-host]").forEach((row) => row.addEventListener("click", () => pair(row.dataset.host, row.dataset.name)));
        content.querySelector("[data-manual]").addEventListener("submit", (event) => {
          event.preventDefault();
          const host = normalizeHost(content.querySelector(`#${ids.host}`).value);
          if (!host) {
            note = { text: "Type the TV's address as four numbers, such as 192.168.1.40.", kind: "error" };
            setMessage(content.querySelector("[data-msg]"), note.text, note.kind);
            return;
          }
          pair(host, "");
        });
      }

      function drawWaiting(state = step === "checking" ? "checking" : "connecting") {
        frame(`Pairing ${device.name}`, `<p class="sheet-text" data-wait>${spinner()} ${escapeHtml(pairStateText(state, chosen.name || device.name))}</p>`);
      }

      function drawCode() {
        frame("Enter the code on your TV", `
            <form novalidate data-code-form>
              <p class="sheet-text">${escapeHtml(chosen.name || device.name)} shows a ${CODE_LENGTH}-character code. Type it here.</p>
              ${textField({ id: ids.code, label: "Code", placeholder: "A1B2C3", maxlength: 9, attrs: 'autocapitalize="characters" autocomplete="one-time-code" spellcheck="false" class="androidtv-code"' })}
              <button type="submit" class="btn btn-filled btn-block">Pair</button>
            </form>`);
        const form = content.querySelector("[data-code-form]");
        const input = form.querySelector(`#${ids.code}`);
        input.focus();
        form.addEventListener("submit", async (event) => {
          event.preventDefault();
          if (busy) return;
          const { code, error } = normalizeCode(input.value);
          const msg = content.querySelector("[data-msg]");
          if (error) {
            setMessage(msg, error, "error");
            input.focus();
            return;
          }
          busy = true;
          form.querySelector("[type=submit]").disabled = true;
          setMessage(msg, "Checking the code…");
          try {
            await finishTvPairing({ code });
            codeSent = true;
            poll();
          } catch (err) {
            // A mistyped code is caught on the hub before it reaches the TV:
            // the TV keeps showing the same code.
            setMessage(msg, err.message || "Pairing failed.", "error");
            form.querySelector("[type=submit]").disabled = false;
            input.select();
          } finally {
            busy = false;
          }
        });
      }

      function finish(pairedTvId) {
        const result = androidTvRepairResult({ wantedTvId: wanted, pairedTvId, deviceName: device.name });
        if (!result.ok) {
          undo(result.undo);
          step = "explain";
          searching = false;
          draw(result.text, "error");
          return;
        }
        step = "done";
        // The TV knows the hub again: its banner (if any) can go.
        clearPairingProblem(device.id);
        const open = content.isConnected;
        close();
        snackbar(result.text);
        if (open) onDone?.(device);
      }

      async function pair(host, name) {
        if (busy) return;
        stopTimer();
        discoverRun += 1;
        searching = false;
        const names = new Map(hub.devices().filter((d) => isAndroidTvEntry(d.entry)).map((d) => [androidTvIdOf(d.entry), d.name]));
        const problem = androidTvRepairProblem({ host, wanted, found, tvs: knownTvs, devicesByTv: names });
        if (problem) {
          draw(problem, "error");
          return;
        }
        chosen = { host, name };
        codeSent = false;
        step = "waiting";
        draw();
        try {
          // codex_androidtv saves this name for the TV: keep the one it has.
          const res = await startTvPairing({ host, name: saved?.name || device.name });
          if (res.state === "failed") throw new Error(res.error || "Pairing failed.");
          poll();
        } catch (err) {
          step = "explain";
          searching = false;
          draw(err.message || "Pairing failed.", "error");
        }
      }

      async function poll() {
        stopTimer();
        if (closed) return;
        let res;
        try {
          res = await getTvPairing();
        } catch (_) {
          timer = setTimeout(poll, POLL_MS * 2);
          return;
        }
        if (closed) return;
        const next = androidTvPairStep(res.state);
        if (next === "done") {
          finish(String(res.tvId ?? ""));
          return;
        }
        if (next === "failed") {
          step = "explain";
          searching = false;
          draw(res.error || "Pairing stopped. Try again.", "error");
          return;
        }
        if (next !== step) {
          step = next;
          draw();
        } else if (step === "waiting" || step === "checking") {
          const line = content.querySelector("[data-wait]");
          if (line) line.innerHTML = `${spinner()} ${escapeHtml(pairStateText(res.state, chosen.name || device.name))}`;
        }
        if (keepPolling(step, codeSent)) timer = setTimeout(poll, POLL_MS);
      }

      async function discover(until, run = discoverRun) {
        let res;
        try {
          res = await discoverTvs();
        } catch (err) {
          if (run !== discoverRun) return;
          searching = false;
          if (step === "explain") draw(err.message || "The hub couldn't look for TVs.", "error");
          return;
        }
        if (run !== discoverRun) return; // a TV was picked meanwhile
        found = res.found ?? [];
        searching = Date.now() < until;
        if (step !== "explain" || closed) return;
        const typed = content.querySelector(`#${ids.host}`)?.value ?? "";
        const focused = document.activeElement?.id === ids.host;
        draw();
        const host = content.querySelector(`#${ids.host}`);
        if (host) {
          host.value = typed;
          if (focused) host.focus();
        }
        if (searching) timer = setTimeout(() => discover(until, run), 1200);
      }

      draw();
      getAndroidTvStatus().then((st) => {
        knownTvs = st.tvs ?? [];
        saved = knownTvs.find((tv) => tv.id === wanted) ?? null;
        if (step === "explain" && !closed && saved) draw();
      }, () => {});
      discover(Date.now() + DISCOVER_FOR_MS);
    },
  });
}
