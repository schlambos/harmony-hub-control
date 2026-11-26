/* Pair a device the stock engine keeps the pairing for, through the hub's
   /api/pairing/start|finish|cancel (docs/API.md "Pairing"):

     Sony TV (ip-register)  explain + pick the TV (the hub searches for it,
                            or an address typed in) → waiting → code →
                            checking → done. A wrong code makes the TV show
                            a new one; "Show a new code" asks again.
     Bluetooth              explain → waiting → select (the person picks
                            "Harmony Keyboard" on the device, then Done) →
                            checking → done. Closing the sheet stops the hub
                            offering itself.

   Same frame as pairing-sheet.js: the title and body change with the step,
   the message line stays put (so what it says is announced), and a new step
   moves focus to its title, or to the code field. */

import { cancelPairing, cancelPairingOnExit, findPairingHost, finishPairing, startPairing } from "../api.js";
import { clearPairingProblem } from "../pairing-problems.js";
import { escapeHtml, iconTile, listRow, openSheet, snackbar, spinner } from "../ui/shell.js";
import { normalizeHost } from "./androidtv-model.js";
import { fieldId, setMessage, textField } from "./device-sheets.js";
import {
  bluetoothSelectSteps,
  hubPairingIntro,
  hubPairStep,
  isPairingHost,
  normalizePin,
  pairingFoundHosts,
} from "./pairing-model.js";

export function openHubPairingSheet({ device, kind, onDone }) {
  const tv = kind === "ip-register";
  let step = "explain";
  let busy = false;
  let closed = false;
  let host = "";
  let found = [];
  let searching = tv;
  let searched = true;
  let wrongCode = false;
  let offered = false; // Bluetooth: start ran, so the hub may be discoverable
  const ids = { host: fieldId("pairHost"), code: fieldId("pairCode") };

  // A tab closed mid-pairing never runs onClose: tell the hub on the way out
  // (the hub also stops by itself after a few minutes).
  const onPageHide = () => {
    if (!tv && offered && step !== "done") cancelPairingOnExit(device.id);
  };
  window.addEventListener("pagehide", onPageHide);

  return openSheet({
    label: `Pair ${device.name}`,
    onClose: () => {
      window.removeEventListener("pagehide", onPageHide);
      closed = true;
      // Stop the hub offering itself over Bluetooth, whatever step this is
      // (a failed finish lands back on explain). A TV has nothing open.
      if (!tv && offered && step !== "done") cancelPairing(device.id).catch(() => {});
    },
    render: (content, close) => {
      let shownStep = "";
      let note = { text: "", kind: "info" };
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
      function draw(message, kind = "info") {
        if (closed) return;
        if (message !== undefined) note = { text: message, kind };
        else if (step !== shownStep) note = { text: "", kind: "info" };
        if (step === "explain") drawExplain();
        else if (step === "waiting" || step === "checking") drawWaiting();
        else if (step === "code") drawCode();
        else if (step === "select") drawSelect();
        setMessage(content.querySelector("[data-msg]"), note.text, note.kind);
        if (step !== shownStep) {
          shownStep = step;
          if (step !== "code") content.querySelector("[data-pair-title]")?.focus();
        }
      }

      function drawExplain() {
        const intro = `<p class="sheet-text">${escapeHtml(hubPairingIntro(kind, device.name))}</p>`;
        if (!tv) {
          frame(`Pair ${device.name}`, `${intro}
              <p class="sheet-text">No remote to reach its settings? Its phone app works too. After a hub swap, ${escapeHtml(device.name)} may also list the old hub's “Harmony Keyboard”: forget that one there.</p>
              <button type="button" class="btn btn-filled btn-block" data-start>Start pairing</button>`);
          content.querySelector("[data-start]").addEventListener("click", () => begin());
          return;
        }
        const rows = found.map((f) => listRow({
          title: f.match ? device.name : "Another device",
          subtitle: f.match ? `${f.host} · found on the network` : `${f.host} · answered, but isn't ${device.name}`,
          leading: iconTile("tv", { size: 40 }),
          chevron: true,
          attrs: `data-host="${escapeHtml(f.host)}"`,
        })).join("");
        const empty = searching
          ? "Looking for the TV…"
          : searched
            ? `${device.name} didn't answer. It has to be on, on the same network as the hub. You can type its address instead.`
            : "Type the TV's address.";
        frame(`Pair ${device.name}`, `${intro}
            <h3 class="m-section">Pick the TV ${searching ? spinner("Looking for the TV") : ""}</h3>
            ${rows ? `<div class="m-list">${rows}</div>` : `<p class="list-note">${escapeHtml(empty)}</p>`}
            <form data-manual novalidate>
              ${textField({ id: ids.host, label: "Or type its address", value: host, placeholder: "192.168.1.40", attrs: 'inputmode="decimal"', hint: "Find it on the TV: Settings, Network, then Network status." })}
              <button type="submit" class="btn btn-tonal btn-block">Use this address</button>
            </form>`);
        content.querySelectorAll("[data-host]").forEach((row) => row.addEventListener("click", () => begin(row.dataset.host)));
        content.querySelector("[data-manual]").addEventListener("submit", (event) => {
          event.preventDefault();
          const typed = normalizeHost(content.querySelector(`#${ids.host}`).value);
          if (!typed || !isPairingHost(typed)) {
            note = { text: "Type the TV's address on your network, four numbers such as 192.168.1.40.", kind: "error" };
            setMessage(content.querySelector("[data-msg]"), note.text, note.kind);
            return;
          }
          begin(typed);
        });
      }

      function drawWaiting() {
        const text = step === "checking"
          ? (tv ? "Checking the code…" : `Checking that ${device.name} picked the hub…`)
          : (tv ? `Asking ${device.name} for a code…` : "Getting the hub ready…");
        frame(`Pairing ${device.name}`, `<p class="sheet-text">${spinner()} ${escapeHtml(text)}</p>`);
      }

      function drawCode() {
        frame("Enter the code on your TV", `
            <form novalidate data-code-form>
              <p class="sheet-text">${escapeHtml(device.name)} shows a 4-digit code. Type it here.</p>
              ${textField({ id: ids.code, label: "Code", placeholder: "1234", maxlength: 8, attrs: 'inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]*"' })}
              <button type="submit" class="btn btn-filled btn-block">Pair</button>
              ${wrongCode ? '<button type="button" class="btn btn-text btn-block" data-again>Show a new code</button>' : ""}
            </form>`);
        const form = content.querySelector("[data-code-form]");
        const input = form.querySelector(`#${ids.code}`);
        input.focus();
        form.querySelector("[data-again]")?.addEventListener("click", () => begin(host));
        form.addEventListener("submit", async (event) => {
          event.preventDefault();
          if (busy) return;
          const { code, error } = normalizePin(input.value);
          if (error) {
            setMessage(content.querySelector("[data-msg]"), error, "error");
            input.focus();
            return;
          }
          busy = true;
          step = "checking";
          draw();
          try {
            const res = await finishPairing({ deviceId: device.id, host, code });
            busy = false;
            if (hubPairStep(res) === "done") done(res);
            else fail("The TV didn't finish pairing. Try again.");
          } catch (err) {
            busy = false;
            if (closed) return;
            if (err.data?.wrongCode) {
              // A Sony shows a new code after a wrong one: ask for it.
              wrongCode = true;
              step = "code";
              draw(err.message || "The TV didn't accept that code.", "error");
            } else {
              fail(err.message || "Pairing failed.");
            }
          }
        });
      }

      function drawSelect() {
        const items = bluetoothSelectSteps(device.name).map((s) => `<li>${escapeHtml(s)}</li>`).join("");
        frame(`Pick the hub on ${device.name}`, `
            <ol class="sheet-text pairing-steps">${items}</ol>
            <button type="button" class="btn btn-filled btn-block" data-done>Done</button>`);
        content.querySelector("[data-done]").addEventListener("click", async () => {
          if (busy) return;
          busy = true;
          step = "checking";
          draw();
          try {
            const res = await finishPairing({ deviceId: device.id });
            busy = false;
            const next = hubPairStep(res);
            if (next === "done") done(res);
            else if (next === "select") {
              step = "select";
              draw(`The hub hasn't seen ${device.name} pick it yet. Pick “Harmony Keyboard” there, then press Done again.`, "error");
            } else fail("Pairing stopped. Try again.");
          } catch (err) {
            busy = false;
            fail(err.message || "Pairing failed.");
          }
        });
      }

      function fail(message) {
        if (closed) return;
        step = "explain";
        wrongCode = false;
        draw(message, "error");
      }

      function done(res) {
        step = "done";
        clearPairingProblem(device.id);
        const open = content.isConnected;
        close();
        snackbar(res?.reloading
          ? `${device.name} is paired with the hub. The hub reloads its setup now; give it a few seconds.`
          : `${device.name} is paired with the hub.`);
        if (open) onDone?.(device);
      }

      async function begin(address = "") {
        if (busy) return;
        busy = true;
        host = address;
        searching = false;
        step = "waiting";
        draw();
        if (!tv) offered = true;
        try {
          const res = await startPairing({ deviceId: device.id, host: tv ? host : undefined });
          busy = false;
          const next = hubPairStep(res);
          if (closed) {
            // Closed while the hub started: the cancel sent then may have
            // come first, so stop it again.
            if (!tv && next === "select") cancelPairing(device.id).catch(() => {});
            return;
          }
          if (next === "done") done(res);
          else if (next === "code" || next === "select") {
            step = next;
            draw();
          } else fail("Pairing didn't start. Try again.");
        } catch (err) {
          busy = false;
          fail(err.message || "Pairing didn't start.");
        }
      }

      draw();
      if (tv) {
        findPairingHost(device.id).then((res) => {
          found = pairingFoundHosts(res);
          searched = res?.searched !== false;
        }, () => {
          searched = false;
        }).finally(() => {
          searching = false;
          if (step !== "explain" || closed) return;
          // Keep what was typed, and where focus was.
          const typed = content.querySelector(`#${ids.host}`)?.value ?? "";
          const focused = document.activeElement?.id === ids.host;
          host = typed;
          draw();
          const field = content.querySelector(`#${ids.host}`);
          if (field && focused) field.focus();
        });
      }
    },
  });
}
