/* Add a network TV: an Android TV or Google TV that the hub controls over
   the network (codex_androidtv), with no IR. One sheet, four steps:

     find   TVs the hub sees on the network (mDNS), or an address typed in
     wait   the hub makes its key (first time only) and asks the TV for a code
     code   the person types the code from the TV's screen
     name   name it and add it as a hub device (CommitAndroidTvDevices)

   Closing before the device is added unpairs the TV again, so the hub never
   keeps a pairing without a device for it. A pairing a hub device uses is
   never undone: the TV may already have been on the hub (paired again from a
   typed address), or the save may have gone through. */

import {
  cancelTvPairing,
  discoverTvs,
  finishTvPairing,
  forgetTv,
  getAndroidTvStatus,
  getConfig,
  getTvPairing,
  getTvInputPresets,
  saveAndroidTvDevices,
  saveTvInputs,
  startTvPairing,
} from "../api.js";
import * as hub from "../state.js";
import { escapeHtml, iconTile, listRow, openSheet, snackbar, spinner } from "../ui/shell.js";
import {
  androidTvDeviceSet,
  androidTvIdOf,
  CODE_LENGTH,
  foundList,
  isAndroidTvEntry,
  nameProblem,
  normalizeCode,
  normalizeHost,
  pairingToUndo,
  pairStateText,
} from "./androidtv-model.js";
import { fieldId, setMessage, textField } from "./device-sheets.js";
import {
  applyPreset,
  profileText,
  readPresets,
  readTvInputs,
  slotCommand,
  tvInputProblems,
  writerInputs,
} from "./androidtv-inputs-model.js";

const DISCOVER_FOR_MS = 7000;
const POLL_MS = 600;

const BRAND_WAIT_MS = 8000;

/* After a TV is added: when the presets file has a suggestion for the
   manufacturer saved with it, save that as the TV's input profile. Best
   effort: Settings → Inputs still offers it if this doesn't happen. Only when
   the suggestion's inputs are the new TV's own (HDMI 1-4), so the device's
   input list needs no change. */
async function applyTvInputPreset(tvId, manufacturer, model) {
  try {
    const presets = readPresets(await getTvInputPresets());
    const tv = ((await getAndroidTvStatus()).tvs ?? []).find((t) => t.id === tvId) ?? null;
    if (!tv || tv.inputs !== "builtin") return;
    const hdmi = [1, 2, 3, 4].map((n) => ({ name: `HDMI ${n}`, command: slotCommand(n) }));
    const draft = readTvInputs({ entryInputs: hdmi, profile: null, presets, vendor: manufacturer, model });
    if (!draft.preset?.vendor) return;
    applyPreset(draft);
    if (JSON.stringify(writerInputs(draft).inputs) !== JSON.stringify(hdmi)) return;
    if (tvInputProblems(draft, { appLinks: !tv.connected || tv.appLinks !== false }).length) return;
    await saveTvInputs(tvId, profileText(draft));
  } catch {
    // Settings → Inputs offers the same suggestion.
  }
}

export function openAndroidTvSheet({ onDone } = {}) {
  let step = "find";
  let found = [];
  let searching = true;
  let chosen = { host: "", name: "" };
  let tvId = "";
  let added = null;
  let saving = null;     // the device save while it runs
  let committed = false; // the save went through: the hub has a device for tvId
  let busy = false;
  let timer = null;
  let closed = false;
  const ids = { host: fieldId("tvHost"), code: fieldId("tvCode"), name: fieldId("tvName"), maker: fieldId("tvMaker"), model: fieldId("tvModel") };

  const stopTimer = () => {
    clearTimeout(timer);
    timer = null;
  };
  const devicesByTv = () => new Set(hub.devices().filter((d) => isAndroidTvEntry(d.entry)).map((d) => androidTvIdOf(d.entry)));
  // Undo a pairing this sheet made, unless a hub device uses it.
  const undoPairing = (id) => {
    const undo = pairingToUndo(id, { committed, devicesByTv: devicesByTv() });
    if (undo) forgetTv({ id: undo }).catch(() => {});
  };

  return openSheet({
    label: "Add a network TV",
    onClose: () => {
      closed = true;
      stopTimer();
      if (step === "name") {
        // Closed while saving: decide once the save settles.
        if (saving) saving.catch(() => undoPairing(tvId));
        else undoPairing(tvId);
      } else if (step === "wait" || step === "code") {
        // The hub may have finished pairing since the last poll; the cancel
        // answer names the TV then.
        cancelTvPairing().then((res) => undoPairing(res?.tvId ?? ""), () => {});
      }
    },
    render: (content, close) => {

      function draw(message = "", kind = "info") {
        if (closed) return;
        if (step === "find") drawFind();
        else if (step === "wait") drawWait();
        else if (step === "code") drawCode();
        else drawName();
        setMessage(content.querySelector("[data-msg]"), message, kind);
      }

      function drawFind() {
        const list = foundList(found, devicesByTv());
        const rows = list.map((tv) => listRow({
          title: tv.name,
          subtitle: tv.added ? `${tv.host} · already on the hub` : tv.host,
          leading: iconTile("tv", { size: 40 }),
          chevron: !tv.added,
          attrs: tv.added ? "disabled" : `data-host="${escapeHtml(tv.host)}" data-name="${escapeHtml(tv.name)}"`,
        })).join("");
        content.innerHTML = `<div class="m-form">
            <h2 class="sheet-title">Add a network TV</h2>
            <p class="sheet-text">For Android TV and Google TV sets on this network. The hub turns them on and off and sends every remote key over the network, with no IR.</p>
            <h3 class="m-section">On this network ${searching ? spinner("Looking for TVs") : ""}</h3>
            ${rows ? `<div class="m-list">${rows}</div>` : `<p class="list-note">${searching ? "Looking for TVs…" : "No TVs found. The TV has to be on, on the same network as the hub. You can type its address instead."}</p>`}
            <form data-manual novalidate>
              ${textField({ id: ids.host, label: "Or type its address", placeholder: "192.168.1.40", attrs: 'inputmode="decimal"', hint: "Find it on the TV: Settings, Network & Internet, then the network it is on." })}
              <button type="submit" class="btn btn-tonal btn-block">Use this address</button>
            </form>
            <p class="form-msg" data-msg role="status" aria-live="polite"></p>
          </div>`;
        content.querySelectorAll("[data-host]").forEach((row) => row.addEventListener("click", () => pair(row.dataset.host, row.dataset.name)));
        content.querySelector("[data-manual]").addEventListener("submit", (event) => {
          event.preventDefault();
          const host = normalizeHost(content.querySelector(`#${ids.host}`).value);
          if (!host) {
            setMessage(content.querySelector("[data-msg]"), "Type the TV's address as four numbers, such as 192.168.1.40.", "error");
            return;
          }
          pair(host, "");
        });
      }

      function drawWait(state = "connecting") {
        content.innerHTML = `<div class="m-form">
            <h2 class="sheet-title">Pairing with ${escapeHtml(chosen.name || chosen.host)}</h2>
            <p class="sheet-text" data-wait>${spinner()} ${escapeHtml(pairStateText(state, chosen.name))}</p>
            <p class="form-msg" data-msg role="status" aria-live="polite"></p>
          </div>`;
      }

      function drawCode() {
        content.innerHTML = `<form class="m-form" novalidate>
            <h2 class="sheet-title">Enter the code on your TV</h2>
            <p class="sheet-text">${escapeHtml(chosen.name || "The TV")} shows a ${CODE_LENGTH}-character code. Type it here.</p>
            ${textField({ id: ids.code, label: "Code", placeholder: "A1B2C3", maxlength: 9, attrs: 'autocapitalize="characters" class="androidtv-code"' })}
            <p class="form-msg" data-msg role="status" aria-live="polite"></p>
            <button type="submit" class="btn btn-filled btn-block">Pair</button>
          </form>`;
        const form = content.querySelector("form");
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
            poll();
          } catch (err) {
            // A mistyped code is caught on the hub before it reaches the TV:
            // the TV keeps showing the same code, so the person can try again.
            setMessage(msg, err.message || "Pairing failed.", "error");
            form.querySelector("[type=submit]").disabled = false;
            input.select();
          } finally {
            busy = false;
          }
        });
      }

      function drawName() {
        content.innerHTML = `<form class="m-form" novalidate>
            <h2 class="sheet-title">Name the TV</h2>
            <p class="sheet-text">It's paired. Add it to the hub as a device, then put it in your activities like any other.</p>
            ${textField({ id: ids.name, label: "Name", value: chosen.name || "TV", maxlength: 64 })}
            ${textField({ id: ids.maker, label: "Manufacturer", placeholder: "Sony", maxlength: 64 })}
            ${textField({ id: ids.model, label: "Model", placeholder: "XR-65A80L", maxlength: 64 })}
            <p class="ds-hint" data-brand aria-live="polite">${spinner()} Asking the TV for its brand and model…</p>
            <p class="form-msg" data-msg role="status" aria-live="polite"></p>
            <button type="submit" class="btn btn-filled btn-block">Add TV</button>
          </form>`;
        const form = content.querySelector("form");
        const nameInput = form.querySelector(`#${ids.name}`);
        nameInput.select();
        fillBrand(form);
        form.addEventListener("submit", async (event) => {
          event.preventDefault();
          if (busy) return;
          const msg = content.querySelector("[data-msg]");
          const name = nameInput.value.trim();
          const manufacturer = form.querySelector(`#${ids.maker}`).value.trim();
          const model = form.querySelector(`#${ids.model}`).value.trim();
          const problem = nameProblem(name) || (manufacturer && nameProblem(manufacturer)) || (model && nameProblem(model));
          if (problem) {
            setMessage(msg, problem, "error");
            return;
          }
          busy = true;
          form.querySelector("[type=submit]").disabled = true;
          setMessage(msg, "Adding the TV to the hub…");
          try {
            // The hub's own copy of the device list decides what the set is.
            const config = await getConfig();
            saving = saveAndroidTvDevices(androidTvDeviceSet(config, { add: { entity: tvId, name, manufacturer, model } }));
            await saving;
            committed = true;
            applyTvInputPreset(tvId, manufacturer, model);
            await hub.refreshConfig().catch(() => {});
            added = hub.devices().find((d) => isAndroidTvEntry(d.entry) && androidTvIdOf(d.entry) === tvId) ?? null;
            const open = content.isConnected;
            close();
            snackbar(`Added ${name}`);
            if (open) onDone?.(added);
          } catch (err) {
            setMessage(msg, err.message || "Adding the TV failed.", "error");
            form.querySelector("[type=submit]").disabled = false;
          } finally {
            saving = null;
            busy = false;
          }
        });
      }

      /* The TV says its brand and model on the remote connection the hub opens
         right after pairing (device_info). Fill them in, unless the person
         has typed there already; they're saved with the device, which is
         where Settings → Inputs looks for a brand suggestion. */
      async function fillBrand(form) {
        const maker = form.querySelector(`#${ids.maker}`);
        const modelField = form.querySelector(`#${ids.model}`);
        const typed = new Set();
        maker.addEventListener("input", () => typed.add("maker"));
        modelField.addEventListener("input", () => typed.add("model"));
        const line = form.querySelector("[data-brand]");
        const until = Date.now() + BRAND_WAIT_MS;
        let tv = null;
        while (!closed && form.isConnected && Date.now() < until) {
          tv = await getAndroidTvStatus().then((r) => (r.tvs ?? []).find((t) => t.id === tvId) ?? null, () => null);
          if (tv?.vendor || tv?.model) break;
          await new Promise((resolve) => setTimeout(resolve, 700));
        }
        if (closed || !form.isConnected) return;
        if (tv?.vendor || tv?.model) {
          if (!typed.has("maker") && tv.vendor) maker.value = tv.vendor;
          if (!typed.has("model") && tv.model) modelField.value = tv.model;
          line.textContent = "Filled in from what the TV reports. Change them if they're not right.";
        } else {
          line.textContent = "The TV didn't say its brand. Type it to get the suggested input setup.";
        }
      }

      async function discover(until) {
        try {
          const res = await discoverTvs();
          found = res.found ?? [];
        } catch (err) {
          searching = false;
          if (step === "find") draw(err.message || "The hub couldn't look for TVs.", "error");
          return;
        }
        searching = Date.now() < until;
        if (step !== "find" || closed) return;
        const typed = content.querySelector(`#${ids.host}`)?.value ?? "";
        const focused = document.activeElement?.id === ids.host;
        draw();
        const host = content.querySelector(`#${ids.host}`);
        if (host) {
          host.value = typed;
          if (focused) host.focus();
        }
        if (searching) timer = setTimeout(() => discover(until), 1200);
      }

      async function pair(host, name) {
        if (busy) return;
        stopTimer();
        chosen = { host, name };
        step = "wait";
        draw();
        try {
          const res = await startTvPairing({ host, name });
          if (res.state === "failed") throw new Error(res.error || "Pairing failed.");
          drawWait(res.state);
          poll();
        } catch (err) {
          step = "find";
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
        } catch (err) {
          timer = setTimeout(poll, POLL_MS * 2);
          return;
        }
        if (closed) return;
        if (res.state === "code") {
          if (step !== "code") {
            step = "code";
            draw();
          }
          return;
        }
        if (res.state === "paired") {
          tvId = res.tvId;
          step = "name";
          draw();
          return;
        }
        if (res.state === "failed" || res.state === "idle") {
          step = "find";
          searching = false;
          draw(res.error || "Pairing stopped. Try again.", "error");
          return;
        }
        if (step === "wait") {
          const line = content.querySelector("[data-wait]");
          if (line) line.innerHTML = `${spinner()} ${escapeHtml(pairStateText(res.state, chosen.name))}`;
        }
        timer = setTimeout(poll, POLL_MS);
      }

      draw();
      discover(Date.now() + DISCOVER_FOR_MS);
    },
  });
}
