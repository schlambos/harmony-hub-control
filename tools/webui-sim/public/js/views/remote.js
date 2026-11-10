/* Remote tab (#remote, #remote/<activityId>): the app's RemoteScreen.
   Nothing running: "Everything's off", one card per activity.
   Starting or stopping: a busy state until the hub answers.
   Running: the activity remote. Header with a switch-activity sheet,
   On-screen buttons, Fix it and power; Buttons and Keyboard tabs; More keys
   (a sheet on phones, a side panel on wide screens).
   #remote/<id> opens an activity that is not running, to try its keys. */

import * as api from "../api.js";
import * as hub from "../state.js";
import {
  escapeHtml,
  icon,
  iconTile,
  openSheet,
  snackbar,
  spinner,
  statusDot,
  vibrate,
} from "../ui/shell.js";
import { parseTextStatus } from "./bluetooth-model.js";
import { offStateSendNote } from "./control-power.js";
import {
  activityIconName,
  activityKeys,
  activityRoles,
  deviceIconName,
  deviceNamesFor,
  fixItDevices,
  softButtons,
} from "./remote-model.js";
import { startFailureText } from "./restrictions-model.js";
import {
  describe,
  flash,
  haStateStripMarkup,
  moreKeysMarkup,
  padMarkup,
  repeatCommand,
  sendCommand,
  wireKeys,
  wireMoreKeys,
} from "./remote-pad.js";

const MODE_KEY = "melodious.remoteMode";
const FIX_GAP_MS = 600;
/* The hub's keyboard often reconnects a little after the hub or TV wakes; only
   call it a problem after this long. */
const KEYBOARD_GRACE_MS = 20000;
const KEYBOARD_POLL_MS = 3000;
const KEYS = [
  ["Enter", "enter"],
  ["Backspace", "backspace"],
  ["Space", "space"],
  ["Tab", "tab"],
  ["Esc", "escape"],
  ["Home", "home"],
];

function readMode() {
  try {
    return localStorage.getItem(MODE_KEY) === "keyboard" ? "keyboard" : "buttons";
  } catch (_) {
    return "buttons";
  }
}

export function createRemoteView(section) {
  let previewId = "";
  let mode = readMode();
  let shown = "";
  let ctx = null; // { activity, live, keys, soft, devices }
  let sheet = null;
  let keyboardTimer = null;
  let keyboardSince = 0;
  let keyboardLive = null;
  let lastConfig = null;

  section.innerHTML = `<div class="remote-root" id="remoteRoot"></div>`;
  const root = section.querySelector("#remoteRoot");

  /* -- state → screen --------------------------------------------------------- */

  function phase() {
    const s = hub.state;
    if (!s.configLoaded) return { kind: "loading" };
    if (s.configError) return { kind: "error" };
    if (s.pendingId) return { kind: "busy", id: s.pendingId };
    const id = previewId || (s.currentId && s.currentId !== "-1" ? s.currentId : "");
    const activity = id ? hub.activityById(id) : null;
    if (activity) return { kind: "remote", id, live: s.currentId === id };
    return { kind: "off" };
  }

  function render() {
    const p = phase();
    const key = JSON.stringify([p, mode, p.kind === "off" ? hub.state.stateError?.message ?? "" : ""]);
    if (key === shown && hub.state.config === lastConfig) {
      renderLiveBits();
      return;
    }
    // A sheet belongs to the screen it was opened from (an activity that just
    // stopped, a config that just reloaded): close it with that screen.
    if (key !== shown) closeSheet();
    shown = key;
    lastConfig = hub.state.config;
    stopKeyboardPolling();
    if (p.kind === "loading") root.innerHTML = loadingMarkup();
    else if (p.kind === "error") root.innerHTML = errorMarkup();
    else if (p.kind === "busy") root.innerHTML = busyMarkup(p.id);
    else if (p.kind === "off") root.innerHTML = offMarkup();
    else renderRemote(p);
  }

  function loadingMarkup() {
    return `<div class="m-center">${spinner("Loading your hub")}</div>`;
  }

  function errorMarkup() {
    return `<div class="m-empty">
        ${iconTile("wifi_off", { size: 64, tone: "error" })}
        <h2 class="m-empty-title">Can't reach your hub</h2>
        <p class="m-empty-body">${escapeHtml(hub.state.configError?.message || "The hub didn't answer.")}</p>
        <button type="button" class="btn btn-filled" data-act="retry">Try again</button>
      </div>`;
  }

  function busyMarkup(id) {
    const text = id === "-1"
      ? "Turning everything off…"
      : `Starting ${hub.activityName(hub.activityById(id))}…`;
    return `<div class="busy" role="status">
        <div class="busy-ring">${spinner()}${icon("tv", { size: 28 })}</div>
        <h2 class="busy-title">${escapeHtml(text)}</h2>
        <p class="busy-body">Your hub is switching devices and inputs. This can take a few seconds.</p>
      </div>`;
  }

  function offMarkup() {
    const devices = hub.devices();
    const acts = hub.activities();
    const err = hub.state.stateError
      ? `<p class="off-note">${icon("info_outlined", { size: 16 })} Couldn't read what's on: ${escapeHtml(hub.state.stateError.message)}</p>`
      : "";
    const cards = acts.length
      ? acts.map((a) => {
          const id = String(a["Id-"]);
          return `<button type="button" class="off-card" data-start="${escapeHtml(id)}" aria-label="Start ${escapeHtml(hub.activityName(a))}">
              ${iconTile(activityIconName(a), { size: 52, tone: "primary" })}
              <span class="off-card-text">
                <span class="off-card-name">${escapeHtml(hub.activityName(a))}</span>
                <span class="off-card-meta">${escapeHtml(deviceNamesFor(a, devices).join(" · ") || hub.activityTypeLabel(a))}</span>
              </span>
              ${icon("play_arrow", { size: 28, cls: "off-card-play" })}
            </button>`;
        }).join("")
      : `<p class="off-empty">No activities yet. Create one in the <a href="#activities">Activities</a> tab.</p>`;
    return `<div class="off">
        <h2 class="off-title">Everything's off</h2>
        <p class="off-sub">What do you want to do?</p>
        ${err}
        <div class="off-list">${cards}</div>
      </div>`;
  }

  /* -- the activity remote -------------------------------------------------------- */

  function renderRemote(p) {
    const activity = hub.activityById(p.id);
    const devices = hub.devices();
    const ids = new Set(activityRoles(activity).map((r) => r.deviceId));
    ctx = {
      activity,
      live: p.live,
      keys: activityKeys(hub.state.config, p.id),
      soft: softButtons(hub.state.config, p.id),
      devices: devices.filter((d) => ids.has(d.id)),
    };
    const name = hub.activityName(activity);
    const names = deviceNamesFor(activity, devices).join(", ");
    const head = `<header class="remote-head">
        <button type="button" class="remote-title" data-act="switch" aria-haspopup="dialog" aria-label="${escapeHtml(`${name}. Switch activity`)}">
          <span class="remote-name">${escapeHtml(name)}${icon("keyboard_arrow_down", { cls: "remote-caret" })}</span>
          <span class="remote-sub">${p.live ? statusDot(true) : ""}${escapeHtml(p.live ? names || "On" : "Not running")}</span>
        </button>
        ${p.live ? `<a class="icon-btn icon-btn-tonal" href="#touch/${encodeURIComponent(p.id)}" aria-label="On-screen buttons for ${escapeHtml(name)}" title="On-screen buttons">${icon("tune_outlined")}</a>` : ""}
        ${p.live ? `<button type="button" class="icon-btn icon-btn-tonal" data-act="fixit" aria-label="Fix it: something didn't turn on or switch input" title="Fix it">${icon("build_outlined")}</button>` : ""}
        ${p.live
          ? `<button type="button" class="power-btn" data-act="poweroff" aria-label="Turn off ${escapeHtml(name)}" title="Turn off">${icon("power_settings_new")}</button>`
          : `<button type="button" class="btn btn-filled" data-start="${escapeHtml(p.id)}">${icon("play_arrow", { size: 20 })}Start</button>`}
      </header>`;
    const preview = p.live
      ? ""
      : `<p class="remote-preview">${icon("info_outlined", { size: 18 })}<span>${escapeHtml(name)} isn't running. Keys still send, straight to its devices.</span></p>`;
    const haStrip = haStateStripMarkup(ctx.devices, hub.state.haState);
    root.innerHTML = `<div class="remote">
        <div class="remote-main">
          ${head}
          ${preview}
          <div id="remoteHaStrip">${haStrip}</div>
          <p class="remote-status" id="remoteStatus" role="status" aria-live="polite"></p>
          <div class="seg-tabs" role="tablist" aria-label="Remote mode">
            <button type="button" role="tab" class="seg-tab" data-mode="buttons" aria-selected="${mode === "buttons"}">Buttons</button>
            <button type="button" role="tab" class="seg-tab" data-mode="keyboard" aria-selected="${mode === "keyboard"}">Keyboard</button>
          </div>
          <div class="remote-surface" id="remoteSurface">${mode === "keyboard" ? keyboardMarkup() : padMarkup(ctx.keys)}</div>
        </div>
        <aside class="remote-side" aria-label="More keys">${moreKeysMarkup(ctx.keys, { title: name, softButtons: ctx.soft })}</aside>
      </div>`;
    wireMoreKeys(root.querySelector(".remote-side"), { source: panelSource, send: sendAction, keyEvents: false });
    if (mode === "keyboard") startKeyboardPolling();
  }

  function panelSource() {
    return ctx && {
      keys: ctx.keys,
      softButtons: ctx.soft,
      devices: ctx.devices,
      title: hub.activityName(ctx.activity),
    };
  }

  function renderLiveBits() {
    const sub = root.querySelector(".remote-sub");
    if (sub && ctx?.live) {
      sub.innerHTML = `${statusDot(true)}${escapeHtml(deviceNamesFor(ctx.activity, hub.devices()).join(", ") || "On")}`;
    }
    const strip = root.querySelector("#remoteHaStrip");
    if (strip && ctx) {
      strip.innerHTML = haStateStripMarkup(ctx.devices, hub.state.haState);
    }
  }

  function setStatus(text, kind) {
    const el = root.querySelector("#remoteStatus");
    if (!el) return;
    el.textContent = text;
    el.dataset.kind = kind ?? "";
  }

  /* -- sending ------------------------------------------------------------------- */

  function sendNote() {
    if (!ctx || ctx.live) return "";
    return offStateSendNote({
      baseNote: "",
      currentActivityId: hub.state.currentId,
      selectedActivityName: hub.activityName(ctx.activity),
    }).replace(/^ · /, "");
  }

  function sendAction(action, label, el) {
    flash(el);
    return sendCommand(action, {
      label,
      activityId: ctx?.activity ? String(ctx.activity["Id-"]) : undefined,
      status: setStatus,
      note: sendNote,
    });
  }

  function pressKey(entry, which, el) {
    const action = which === "hold" ? entry.hold : entry.press;
    sendAction(action, which === "hold" ? `${entry.label} (held)` : entry.label, el);
  }

  function repeatKey(entry, el) {
    flash(el);
    return repeatCommand(entry.press, {
      label: entry.label,
      activityId: ctx?.activity ? String(ctx.activity["Id-"]) : undefined,
      status: setStatus,
      note: sendNote,
    });
  }

  async function start(id) {
    vibrate();
    previewId = "";
    if (location.hash !== "#remote") history.replaceState(history.state, "", "#remote");
    await hub.setRunning(id);
    const err = hub.state.runError;
    if (err) {
      snackbar(id === "-1"
        ? `Couldn't turn everything off — ${err.message || "hub error"}`
        : startFailureText(hub.activityName(hub.activityById(id)), err), { error: true });
    }
  }

  /* -- sheets -------------------------------------------------------------------- */

  function closeSheet() {
    sheet?.close();
    sheet = null;
  }

  function openMoreKeys() {
    closeSheet();
    const opened = openSheet({
      label: "More keys",
      // close fires asynchronously: only forget this sheet, not a newer one.
      onClose: () => { if (sheet === opened) sheet = null; },
      render: (content) => {
        content.innerHTML = moreKeysMarkup(ctx.keys, { title: hub.activityName(ctx.activity), softButtons: ctx.soft });
        wireMoreKeys(content, { source: panelSource, send: sendAction, onPress: pressKey, onRepeat: repeatKey });
      },
    });
    sheet = opened;
  }

  function openSwitcher() {
    closeSheet();
    const current = hub.state.currentId;
    const opened = openSheet({
      label: "Switch activity",
      onClose: () => { if (sheet === opened) sheet = null; },
      render: (content, close) => {
        content.innerHTML = `<h2 class="sheet-title">Switch activity</h2>
          <div class="sheet-rows">
            ${hub.activities().map((a) => {
              const id = String(a["Id-"]);
              const isCurrent = id === current;
              return `<button type="button" class="sheet-row${isCurrent ? " is-selected" : ""}" data-switch="${escapeHtml(id)}">
                  ${iconTile(activityIconName(a), { size: 40 })}
                  <span class="sheet-row-title">${escapeHtml(hub.activityName(a))}</span>
                  ${isCurrent ? icon("check", { cls: "sheet-row-check", label: "Running" }) : ""}
                </button>`;
            }).join("")}
            <button type="button" class="sheet-row is-destructive" data-switch="-1">
              ${iconTile("power_settings_new", { size: 40, tone: "power" })}
              <span class="sheet-row-title">Turn everything off</span>
            </button>
          </div>`;
        content.addEventListener("click", (event) => {
          const row = event.target.closest("[data-switch]");
          if (!row) return;
          close();
          if (row.dataset.switch !== current) start(row.dataset.switch);
        });
      },
    });
    sheet = opened;
  }

  function openFixIt() {
    closeSheet();
    const fixes = fixItDevices(ctx.activity, hub.devices(), hub.state.haState);
    const needsPower = fixes.filter((f) => f.powerOn || f.powerToggle);
    const allDiscrete = needsPower.every((f) => f.powerOn);
    const bulk = fixes.flatMap((f) => [
      ...(f.powerOn ? [{ device: f.device, command: f.powerOn }] : []),
      ...(f.inputCommand ? [{ device: f.device, command: f.inputCommand }] : []),
    ]);
    const opened = openSheet({
      label: "Fix it",
      onClose: () => { if (sheet === opened) sheet = null; },
      render: (content, close) => {
        content.innerHTML = `<h2 class="sheet-title">Something not right?</h2>
          <p class="sheet-text">Tap the fix for what's wrong. Melodious resends just that command and nothing else changes.</p>
          ${allDiscrete && bulk.length ? `<button type="button" class="btn btn-filled btn-block" data-fix-all>Resend power and inputs for everything</button>` : ""}
          ${fixes.length ? "" : `<p class="sheet-text">None of this activity's devices has a power or input command to resend.</p>`}
          ${fixes.map((f, i) => `<div class="fix-card">
              <div class="fix-card-head">
                ${iconTile(deviceIconName(f.device), { size: 40 })}
                <span class="fix-card-text">
                  <span class="fix-card-name">${escapeHtml(f.device.name)}</span>
                  <span class="fix-card-roles">${escapeHtml([f.roles.join(" · "), f.haHint].filter(Boolean).join(" · "))}</span>
                </span>
              </div>
              <div class="fix-card-actions">
                ${f.powerOn ? `<button type="button" class="btn btn-tonal" data-fix="${i}" data-fix-kind="power">It's off</button>` : ""}
                ${f.powerToggle ? `<button type="button" class="btn btn-outlined" data-fix="${i}" data-fix-kind="toggle">Press power</button>` : ""}
                ${f.inputCommand ? `<button type="button" class="btn btn-tonal" data-fix="${i}" data-fix-kind="input">Switch to ${escapeHtml(f.inputName)}</button>` : ""}
              </div>
              ${f.powerToggle ? `<p class="fix-card-warn">This device only has a power toggle. Only press it if the device is off, or it will turn off.</p>` : ""}
            </div>`).join("")}`;
        content.addEventListener("click", async (event) => {
          if (event.target.closest("[data-fix-all]")) {
            close();
            let failed = 0;
            for (const [i, item] of bulk.entries()) {
              if (i > 0) await new Promise((r) => setTimeout(r, FIX_GAP_MS));
              const ok = await sendCommand({ deviceId: item.device.id, command: item.command.name, functionId: item.command.functionId }, { label: "Fix it", status: setStatus });
              if (!ok) failed += 1;
            }
            if (failed) snackbar(`${failed} of ${bulk.length} commands didn't send. Check the send log.`, { error: true });
            else snackbar("Resent power and inputs");
            return;
          }
          const btn = event.target.closest("[data-fix]");
          if (!btn) return;
          const f = fixes[Number(btn.dataset.fix)];
          const c = btn.dataset.fixKind === "input" ? f.inputCommand : btn.dataset.fixKind === "toggle" ? f.powerToggle : f.powerOn;
          const ok = await sendCommand({ deviceId: f.device.id, command: c.name, functionId: c.functionId }, { label: "Fix it", status: setStatus });
          if (ok) snackbar(`Sent ${c.name} to ${f.device.name}`);
        });
      },
    });
    sheet = opened;
  }

  /* -- keyboard tab -------------------------------------------------------------- */

  function keyboardMarkup() {
    return `<div class="kb">
        <div class="kb-status" id="kbStatus">${keyboardStatusMarkup()}</div>
        <p class="kb-hint">Type a search, password or web address. Your phone keyboard's mic button can dictate.</p>
        <textarea class="kb-text" id="kbText" rows="3" placeholder="Type here" aria-label="Text to type on the TV" enterkeyhint="send"></textarea>
        <button type="button" class="btn btn-filled btn-block" data-act="kb-send">${icon("send", { size: 18 })}Send to TV</button>
        <h3 class="m-section is-muted">Keys</h3>
        <div class="kb-keys">${KEYS.map(([l, code]) => `<button type="button" class="chip" data-kb-key="${code}">${l}</button>`).join("")}</div>
      </div>`;
  }

  function keyboardStatusMarkup() {
    if (keyboardLive) return "";
    if (Date.now() - keyboardSince < KEYBOARD_GRACE_MS) {
      return `<p class="kb-connecting">${spinner()}Connecting to the keyboard…</p>`;
    }
    return `<div class="kb-warn">
        ${icon("info_outlined", { cls: "kb-warn-icon" })}
        <div>
          <p class="kb-warn-title">The hub's Bluetooth keyboard isn't connected</p>
          <p class="kb-warn-body">Typing still sends, but nothing will arrive until the keyboard is paired with your TV.</p>
          <a class="btn btn-text btn-sm" href="#bluetooth">Set up keyboard</a>
        </div>
      </div>`;
  }

  async function pollKeyboard() {
    try {
      keyboardLive = parseTextStatus(await api.getJson("/api/bt-text-status")).live;
    } catch (_) {
      keyboardLive = false;
    }
    const el = root.querySelector("#kbStatus");
    if (el) el.innerHTML = keyboardStatusMarkup();
  }

  function startKeyboardPolling() {
    stopKeyboardPolling();
    keyboardSince = Date.now();
    keyboardLive = null;
    pollKeyboard();
    keyboardTimer = setInterval(pollKeyboard, KEYBOARD_POLL_MS);
  }

  function stopKeyboardPolling() {
    clearInterval(keyboardTimer);
    keyboardTimer = null;
  }

  async function sendText() {
    const area = root.querySelector("#kbText");
    const text = area?.value ?? "";
    if (!text) return;
    vibrate();
    try {
      await api.postApiForm("/api/bt-text", { text });
      area.value = "";
      setStatus(`Typed ${text.length} character${text.length === 1 ? "" : "s"} on the TV`, "ok");
    } catch (error) {
      snackbar(`Couldn't send the text — ${error.message || "hub error"}`, { error: true });
    }
  }

  async function sendKey(code, el) {
    vibrate();
    flash(el);
    try {
      await api.postApiForm("/api/bt-call", { action: "report", type: "btkeyboard", code, gapMs: "35" });
      setStatus(`Keyboard · ${el.textContent}`, "ok");
    } catch (error) {
      snackbar(`Couldn't send the key — ${error.message || "hub error"}`, { error: true });
    }
  }

  /* -- events -------------------------------------------------------------------- */

  wireKeys(root, {
    keyFor: (k) => ctx?.keys.get(k) ?? null,
    onPress: pressKey,
    onRepeat: repeatKey,
    onPreview: (entry) => {
      if (entry) setStatus(describe(entry.label, entry.press), "preview");
    },
  });

  root.addEventListener("click", (event) => {
    const startBtn = event.target.closest("[data-start]");
    if (startBtn) {
      start(startBtn.dataset.start);
      return;
    }
    const modeBtn = event.target.closest("[data-mode]");
    if (modeBtn && modeBtn.dataset.mode !== mode) {
      mode = modeBtn.dataset.mode;
      try {
        localStorage.setItem(MODE_KEY, mode);
      } catch (_) {}
      vibrate();
      render();
      root.querySelector(`[data-mode="${mode}"]`)?.focus();
      return;
    }
    const kbKey = event.target.closest("[data-kb-key]");
    if (kbKey) {
      sendKey(kbKey.dataset.kbKey, kbKey);
      return;
    }
    if (event.target.closest(".remote-side")) return;
    const act = event.target.closest("[data-act]")?.dataset.act;
    if (act === "switch") openSwitcher();
    else if (act === "more") openMoreKeys();
    else if (act === "fixit") openFixIt();
    else if (act === "poweroff") start("-1");
    else if (act === "kb-send") sendText();
    else if (act === "retry") hub.reloadConfig();
  });

  root.addEventListener("keydown", (event) => {
    if (event.target.id === "kbText" && event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      sendText();
    }
  });

  hub.subscribe(() => {
    if (!section.hidden) render();
  });

  return {
    onShow({ args = [] } = {}) {
      previewId = args[0] ? String(args[0]) : "";
      shown = "";
      hub.ensureConfig();
      render();
    },
    onHide() {
      closeSheet();
      stopKeyboardPolling();
      shown = "";
    },
  };
}
