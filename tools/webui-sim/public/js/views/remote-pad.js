/* The Melodious keypad, shared by the activity remote and the device page:
   the Buttons surface, the "More keys" content, the all-commands list, key
   wiring, and sending (with the send log). Mirrors the app's RemoteKeys and
   RemoteSurfaces: keys fire when the finger lifts; a key with a long-press
   action fires that action after 500 ms instead; volume, channel and the
   D-pad fire on touch-down and, held, repeat until let go or slid off
   (key-repeat.js); unmapped keys are dimmed. */

import * as api from "../api.js";
import * as hub from "../state.js";
import { escapeHtml, icon, snackbar, statusDot, vibrate } from "../ui/shell.js";
import { MAX_REPEAT_MS, REPEATABLE_KEYS, startRepeat } from "./key-repeat.js";
import { KEY_LABELS, describeHaDeviceState, describeTheaterLink, isHaCommandRedundant, sendsHome } from "./remote-model.js";

const HOLD_MS = 500;
const LOG_MAX = 60;

/* Firmware ButtonKey for the remote's Back key. */
const BACK = "PrevChannel";

/* -- Send log (kept across views, newest first) ----------------------------- */

const sendLog = [];
const logListeners = new Set();

export function onSendLog(fn) {
  logListeners.add(fn);
  return () => logListeners.delete(fn);
}

export function sendLogEntries() {
  return sendLog;
}

export function clearSendLog() {
  sendLog.length = 0;
  for (const fn of logListeners) fn();
}

function addLog(entry) {
  sendLog.unshift({ time: new Date().toLocaleTimeString([], { hour12: false }), ...entry });
  sendLog.length = Math.min(sendLog.length, LOG_MAX);
  for (const fn of logListeners) fn();
}

/** "Volume up → Living room amp · VolumeUp", the resolved line under the tabs. */
export function describe(label, action) {
  return `${label} → ${hub.deviceName(action.deviceId)} · ${action.command}`;
}

/**
 * Send one command. `activityId` is passed for activity remotes so the hub
 * logs which activity the key belonged to; `status(text, kind)` updates the
 * view's status line ("sending" | "ok" | "error").
 */
export async function sendCommand(action, { label, activityId, status, note } = {}) {
  if (!action?.deviceId || !action?.command) return false;
  const line = describe(label ?? action.command, action);
  vibrate();
  status?.(line, "sending");
  try {
    await api.irSend({
      deviceId: action.deviceId,
      command: action.command,
      functionId: action.functionId,
      activityId,
    });
    const extra = note ? note() : "";
    status?.(extra ? `${line} · ${extra}` : line, "ok");
    addLog({ target: `${hub.deviceName(action.deviceId)} · ${action.command}`, note: extra || "sent", ok: true });
    return true;
  } catch (error) {
    const message = error?.message || "network error";
    status?.(`${line} · ${message}`, "error");
    snackbar(`Couldn't send ${action.command} to ${hub.deviceName(action.deviceId)} — ${message}`, { error: true });
    addLog({ target: `${hub.deviceName(action.deviceId)} · ${action.command}`, note: message, ok: false });
    return false;
  }
}

/**
 * Send one command for as long as its key is held (key-repeat.js): a quick
 * tap sends it once, a longer hold repeats it. Returns stop(), or null if
 * the action can't be held. Logged once; a failure shows like a failed send.
 */
export function repeatCommand(action, { label, activityId, status, note } = {}) {
  if (!action?.deviceId || !action?.command) return null;
  const line = describe(label ?? action.command, action);
  const target = `${hub.deviceName(action.deviceId)} · ${action.command}`;
  vibrate();
  status?.(line, "sending");
  let ended = false;
  let sent = false;
  const stop = startRepeat(
    (which, holdId) =>
      api.irSend({
        deviceId: action.deviceId,
        command: action.command,
        functionId: action.functionId,
        activityId,
        status: which,
        holdId,
      }).then((reply) => {
        if (which === "press") {
          sent = true;
          const extra = note ? note() : "";
          addLog({ target, note: extra || "sent", ok: true });
        }
        return reply;
      }),
    {
      onEnd: (error, reason) => {
        ended = true;
        if (reason === "superseded") return; // the newer key reports itself
        if (reason !== "failed") {
          const why = reason === "cap" ? `stopped after ${MAX_REPEAT_MS / 1000} s` : error?.message || "hold ended";
          status?.(`${line} · ${why}`, "ok");
          return;
        }
        const message = error?.message || "network error";
        status?.(`${line} · ${message}`, "error");
        snackbar(`Couldn't send ${action.command} to ${hub.deviceName(action.deviceId)} — ${message}`, { error: true });
        addLog({ target, note: message, ok: false });
      },
    },
  );
  return () => {
    stop().then(() => {
      if (ended || !sent) return;
      const extra = note ? note() : "";
      status?.(extra ? `${line} · ${extra}` : line, "ok");
    });
  };
}

/* -- Markup ------------------------------------------------------------------- */

/**
 * Live state strip for Home Assistant-backed devices on the remote and device
 * screens. Shows power, source/input, app, playing, volume and mute; when
 * stale or missing, shows a "State unknown" badge — never "Off".
 */
export function haStateStripMarkup(devices, haState, { single = false } = {}) {
  const rows = (devices ?? [])
    .map((device) => {
      const own = describeHaDeviceState(device, haState);
      const link = describeTheaterLink(device, haState);
      if (own && link?.known) {
        // An HA device that is also linked to an LG port shows both.
        const seen = new Set(own.chips.map((c) => c.label));
        const extra = link.chips.filter((c) => !seen.has(c.label));
        return { device, info: { ...own, chips: [...own.chips, ...extra], theaterLink: link.theaterLink } };
      }
      return { device, info: own ?? link };
    })
    .filter(({ info }) => Boolean(info));
  if (!rows.length) return "";
  return `<div class="ha-state-strip" role="region" aria-label="Home Assistant device state">${rows
    .map(({ device, info }) => {
      const chips = info.chips
        .map((c) => {
          const dot = c.kind === "on" ? statusDot(true) : c.kind === "off" ? statusDot(false) : "";
          return `<span class="ha-chip ha-chip-${escapeHtml(c.kind)}">${dot}${escapeHtml(c.label)}</span>`;
        })
        .join("");
      const detail = info.theater?.portsText
        ? `<div class="ha-state-detail">${escapeHtml(info.theater.portsText)}</div>`
        : "";
      return `<div class="ha-state-row" data-ha-device="${escapeHtml(device.id)}">
          ${single ? "" : `<span class="ha-state-name">${escapeHtml(device.name)}</span>`}
          <div class="ha-state-chips">${chips}</div>${detail}
        </div>`;
    })
    .join("")}</div>`;
}

function keyLabel(keys, key, label) {
  const entry = keys.get(key);
  const name = label ?? KEY_LABELS[key] ?? key;
  if (!entry) return `${name}, not set up`;
  const hold = entry.hold ? `; hold: ${hub.deviceName(entry.hold.deviceId)} ${entry.hold.command}` : "";
  return `${name}: ${hub.deviceName(entry.press.deviceId)} ${entry.press.command}${hold}`;
}

function key(keys, k, inner, { cls = "", label } = {}) {
  const entry = keys.get(k);
  const mapped = Boolean(entry);
  const haInfo = entry?.press?.deviceId ? hub.haDeviceState(entry.press.deviceId) : null;
  const redundant = mapped && isHaCommandRedundant(entry.press.command, haInfo);
  return `<button type="button" class="rk${cls ? ` ${cls}` : ""}${entry?.hold ? " has-hold" : ""}${redundant ? " is-redundant" : ""}" data-key="${k}" aria-label="${escapeHtml(keyLabel(keys, k, label))}"${mapped ? "" : " disabled"}>${inner}</button>`;
}

function captionKey(keys, k, label, iconName) {
  return key(keys, k, `${icon(iconName, { size: 22 })}<span class="rk-caption">${escapeHtml(label)}</span>`, {
    cls: "rk-captioned",
    label,
  });
}

/** The Buttons surface: transport row, D-pad, rockers and the four caption keys. */
export function padMarkup(keys) {
  const menuIsHome = sendsHome(keys, "Menu");
  const exitIsHome = sendsHome(keys, "Exit") && !menuIsHome;
  return `<div class="pad">
      <div class="pad-transport">
        ${key(keys, "Rewind", icon("fast_rewind", { size: 26 }))}
        ${key(keys, "Play", icon("play_arrow", { size: 26 }), { cls: "rk-primary" })}
        ${key(keys, "Pause", icon("pause", { size: 26 }))}
        ${key(keys, "FastForward", icon("fast_forward", { size: 26 }))}
        <button type="button" class="rk rk-more" data-act="more" aria-label="More keys" aria-haspopup="dialog">${icon("more_horiz", { size: 26 })}</button>
      </div>
      <div class="pad-dpad">
        <div class="dpad" role="group" aria-label="Arrows and OK">
          ${key(keys, "DirectionUp", icon("keyboard_arrow_up", { size: 34 }), { cls: "dpad-key dpad-up" })}
          ${key(keys, "DirectionLeft", icon("keyboard_arrow_left", { size: 34 }), { cls: "dpad-key dpad-left" })}
          ${key(keys, "Select", "OK", { cls: "dpad-ok" })}
          ${key(keys, "DirectionRight", icon("keyboard_arrow_right", { size: 34 }), { cls: "dpad-key dpad-right" })}
          ${key(keys, "DirectionDown", icon("keyboard_arrow_down", { size: 34 }), { cls: "dpad-key dpad-down" })}
        </div>
      </div>
      <div class="pad-bottom">
        <div class="rocker" role="group" aria-label="Volume">
          ${key(keys, "VolumeUp", icon("add", { size: 28 }), { cls: "rocker-key" })}
          <span class="rocker-cap" aria-hidden="true">VOL</span>
          ${key(keys, "VolumeDown", icon("remove", { size: 28 }), { cls: "rocker-key" })}
        </div>
        <div class="pad-grid">
          ${captionKey(keys, BACK, "Back", "undo")}
          ${captionKey(keys, "Menu", menuIsHome ? "Home" : "Menu", menuIsHome ? "home" : "menu")}
          ${captionKey(keys, "Exit", exitIsHome ? "Home" : "Exit", exitIsHome ? "home" : "exit_to_app")}
          ${captionKey(keys, "VolumeMute", "Mute", "volume_off")}
        </div>
        <div class="rocker" role="group" aria-label="Channel">
          ${key(keys, "ChannelUp", icon("keyboard_arrow_up", { size: 28 }), { cls: "rocker-key" })}
          <span class="rocker-cap" aria-hidden="true">CH</span>
          ${key(keys, "ChannelDown", icon("keyboard_arrow_down", { size: 28 }), { cls: "rocker-key" })}
        </div>
      </div>
    </div>`;
}

const SECONDARY = [["Guide", "Guide"], ["Info", "Info"], ["Dvr", "DVR"], ["Exit", "Exit"]];
const COLORS = [["Red", "red"], ["Green", "green"], ["Yellow", "yellow"], ["Blue", "blue"]];
const NUMBERS = [
  ["Number1", "1"], ["Number2", "2"], ["Number3", "3"],
  ["Number4", "4"], ["Number5", "5"], ["Number6", "6"],
  ["Number7", "7"], ["Number8", "8"], ["Number9", "9"],
  ["Dash", "–"], ["Number0", "0"], ["Enter", "Enter"],
];

/** "More keys": this activity's on-screen buttons, secondary and colour keys,
    the number pad, and the way into every device command and the send log. */
export function moreKeysMarkup(keys, { title, softButtons = [], heading = true }) {
  const soft = softButtons.length
    ? `<h3 class="m-section is-muted">This activity</h3>
       <div class="mk-soft">${softButtons
         .map((b, i) => `<button type="button" class="mk-soft-key" data-soft="${i}" title="${escapeHtml(describe(b.label, b.action))}">${escapeHtml(b.label)}</button>`)
         .join("")}</div>`
    : "";
  const numbers = NUMBERS.some(([k]) => keys.has(k))
    ? `<h3 class="m-section is-muted">Numbers</h3>
       <div class="mk-numbers">${NUMBERS.map(([k, l]) => key(keys, k, escapeHtml(l), { cls: `rk-sheet${l.length > 1 ? " rk-small" : ""}`, label: l })).join("")}</div>`
    : "";
  return `<div class="mk">
      ${heading ? `<div class="mk-head"><h2 class="mk-title">More keys</h2><span class="mk-for">${escapeHtml(title)}</span></div>` : ""}
      ${soft}
      <div class="mk-row mk-row-4">${SECONDARY.map(([k, l]) => key(keys, k, escapeHtml(l), { cls: "rk-sheet rk-small", label: l })).join("")}</div>
      <div class="mk-row mk-row-6">
        ${key(keys, "Record", icon("fiber_manual_record", { size: 24 }), { cls: "rk-sheet rk-record" })}
        ${key(keys, "Stop", icon("stop", { size: 24 }), { cls: "rk-sheet" })}
        ${COLORS.map(([k, c]) => key(keys, k, `<span class="rk-color rk-color-${c}"></span>`, { cls: "rk-sheet" })).join("")}
      </div>
      ${numbers}
      <div class="mk-links">
        <button type="button" class="btn btn-text" data-act="all-commands">All device commands…</button>
        <button type="button" class="btn btn-text" data-act="send-log">Send log</button>
      </div>
    </div>`;
}

/** Every command of the given devices, grouped by device, filtered by query. */
export function allCommandsMarkup(devices, query = "") {
  const q = query.trim().toLowerCase();
  const groups = devices
    .map((d) => ({ d, cmds: d.commands.map((c, i) => ({ c, i })).filter(({ c }) => !q || c.name.toLowerCase().includes(q)) }))
    .filter((g) => g.cmds.length);
  if (!groups.length) {
    return `<p class="mk-empty">${q ? `Nothing matches “${escapeHtml(query.trim())}”.` : "No commands."}</p>`;
  }
  return groups
    .map(({ d, cmds }) => {
      const haInfo = d.isHa ? hub.haDeviceState(d) : null;
      return `<h3 class="m-section">${escapeHtml(d.name)}</h3>
      <div class="cmd-list">${cmds
        .map(({ c, i }) => {
          const redundant = isHaCommandRedundant(c.name, haInfo);
          return `<button type="button" class="cmd-row${redundant ? " is-redundant" : ""}" data-cmd-device="${escapeHtml(d.id)}" data-cmd="${i}">${escapeHtml(c.name)}</button>`;
        })
        .join("")}</div>`;
    })
    .join("");
}

export function sendLogMarkup() {
  if (!sendLog.length) return `<p class="mk-empty">Press a key — sends appear here.</p>`;
  return `<ol class="send-log">${sendLog
    .map((e) => `<li><span class="send-time">${escapeHtml(e.time)}</span><span class="send-target">${escapeHtml(e.target)}</span><span class="send-note${e.ok ? "" : " is-error"}">${escapeHtml(e.note)}</span></li>`)
    .join("")}</ol>`;
}

function sendLogPage() {
  return `<div class="mk-page">
      <div class="mk-page-head">
        <button type="button" class="icon-btn" data-act="back-keys" aria-label="Back to keys">${icon("arrow_back")}</button>
        <h2 class="mk-title">Send log</h2>
      </div>
      <div class="mk-actions">
        <button type="button" class="btn btn-outlined btn-sm" data-act="refresh">${icon("refresh", { size: 18 })}Refresh state</button>
        <button type="button" class="btn btn-text btn-sm" data-act="clear-log">Clear log</button>
      </div>
      <div class="send-log-body">${sendLogMarkup()}</div>
    </div>`;
}

onSendLog(() => {
  document.querySelectorAll(".send-log-body").forEach((el) => {
    el.innerHTML = sendLogMarkup();
  });
});

/**
 * Make a "More keys" container (a sheet's content or the wide-screen side
 * panel) interactive: on-screen buttons, the all-commands page with search,
 * and the send log. `source()` returns the current
 * { keys, softButtons, devices, title }; `send(action, label, el)` sends.
 * Pass keyEvents: false when an ancestor already wires the keys.
 */
export function wireMoreKeys(panel, { source, send, onPress, onRepeat, keyEvents = true }) {
  if (keyEvents) wireKeys(panel, { keyFor: (k) => source()?.keys.get(k) ?? null, onPress, onRepeat });
  panel.addEventListener("click", (event) => {
    const src = source();
    if (!src) return;
    const soft = event.target.closest("[data-soft]");
    if (soft) {
      const b = src.softButtons?.[Number(soft.dataset.soft)];
      if (b) send(b.action, b.label, soft);
      return;
    }
    const cmd = event.target.closest("[data-cmd]");
    if (cmd) {
      const device = hub.deviceById(cmd.dataset.cmdDevice);
      const c = device?.commands[Number(cmd.dataset.cmd)];
      if (c) send({ deviceId: device.id, command: c.name, functionId: c.functionId }, c.name, cmd);
      return;
    }
    const act = event.target.closest("[data-act]")?.dataset.act;
    if (act === "all-commands") {
      panel.innerHTML = `<div class="mk-page">
          <div class="mk-page-head">
            <button type="button" class="icon-btn" data-act="back-keys" aria-label="Back to keys">${icon("arrow_back")}</button>
            <h2 class="mk-title">All commands</h2>
          </div>
          <label class="search-field">${icon("search", { size: 22 })}<input type="search" data-filter placeholder="Search commands" aria-label="Search commands"></label>
          <p class="mk-hint">Each one sends immediately.</p>
          <div class="cmd-results">${allCommandsMarkup(src.devices)}</div>
        </div>`;
      panel.querySelector("[data-filter]").focus();
    } else if (act === "send-log") {
      panel.innerHTML = sendLogPage();
    } else if (act === "back-keys") {
      panel.innerHTML = moreKeysMarkup(src.keys, { title: src.title, softButtons: src.softButtons });
    } else if (act === "clear-log") {
      clearSendLog();
    } else if (act === "refresh") {
      Promise.all([hub.refreshState(), hub.pollHaState()]).then(() => snackbar("Hub state refreshed"));
    }
  });
  panel.addEventListener("input", (event) => {
    if (!event.target.matches("[data-filter]")) return;
    const results = panel.querySelector(".cmd-results");
    if (results) results.innerHTML = allCommandsMarkup(source()?.devices ?? [], event.target.value);
  });
}

/* -- Key wiring --------------------------------------------------------------- */

/**
 * Wire press / long-press on every [data-key] inside root.
 * keyFor(key) returns the resolved entry; onPress(entry, "press"|"hold", el)
 * sends it; onPreview(entry|null) shows what a key would send (hover, focus).
 * onRepeat(entry, el), when given, makes the repeatable keys (volume,
 * channel, D-pad) without a long-press action fire on touch-down as a hold
 * that repeats until let go; it returns a function that ends the hold (or
 * null when the key can't be held, and it is sent once instead).
 */
export function wireKeys(root, { keyFor, onPress, onPreview, onRepeat }) {
  let active = null;

  // While a key is down, a hidden page or a lost window lets it go: a key
  // must never keep repeating where nobody can see it.
  const onHidden = () => {
    if (document.hidden) clear();
  };
  const clear = () => {
    if (!active) return;
    clearTimeout(active.timer);
    active.stopRepeat?.();
    active.el.classList.remove("is-pressed");
    active = null;
    window.removeEventListener("blur", clear);
    document.removeEventListener("visibilitychange", onHidden);
  };

  root.addEventListener("pointerdown", (event) => {
    const el = event.target.closest("[data-key]");
    if (!el || el.disabled || (event.pointerType === "mouse" && event.button !== 0)) return;
    const entry = keyFor(el.dataset.key);
    if (!entry) return;
    clear();
    el.classList.add("is-pressed");
    el.setPointerCapture?.(event.pointerId);
    active = { el, entry, pointerId: event.pointerId, held: false, timer: null, stopRepeat: null };
    window.addEventListener("blur", clear);
    document.addEventListener("visibilitychange", onHidden);
    const pressed = active;
    if (!entry.hold && onRepeat && REPEATABLE_KEYS.has(el.dataset.key)) {
      // Like the app: fire now, and keep going while the finger stays down.
      pressed.held = true;
      pressed.stopRepeat = onRepeat(entry, el);
      if (!pressed.stopRepeat) onPress(entry, "press", el);
    } else if (entry.hold) {
      pressed.timer = setTimeout(() => {
        if (active !== pressed) return;
        pressed.held = true;
        onPress(entry, "hold", el);
      }, HOLD_MS);
    }
  });

  root.addEventListener("pointerup", (event) => {
    if (!active || event.pointerId !== active.pointerId) return;
    const { el, entry, held } = active;
    const box = el.getBoundingClientRect();
    const inside =
      event.clientX >= box.left && event.clientX <= box.right &&
      event.clientY >= box.top && event.clientY <= box.bottom;
    clear();
    // Slid off the key: treat as cancelled, like a physical remote.
    if (!held && inside) onPress(entry, "press", el);
  });

  root.addEventListener("pointercancel", clear);

  // Sliding off a held repeat key lets it go, as in the app.
  root.addEventListener("pointermove", (event) => {
    if (!active || event.pointerId !== active.pointerId || !active.stopRepeat) return;
    const box = active.el.getBoundingClientRect();
    if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) clear();
  });

  // Keyboard activation (Enter / Space) arrives as a click with no pointer.
  root.addEventListener("click", (event) => {
    if (event.detail !== 0) return;
    const el = event.target.closest("[data-key]");
    if (!el || el.disabled) return;
    const entry = keyFor(el.dataset.key);
    if (entry) onPress(entry, "press", el);
  });

  // A long touch would otherwise open the browser's context menu.
  root.addEventListener("contextmenu", (event) => {
    if (event.target.closest("[data-key]")) event.preventDefault();
  });

  if (onPreview) {
    const preview = (event) => {
      const el = event.target.closest?.("[data-key]");
      onPreview(el && !el.disabled ? keyFor(el.dataset.key) : null);
    };
    root.addEventListener("pointerover", (event) => {
      if (event.pointerType === "mouse") preview(event);
    });
    root.addEventListener("focusin", preview);
    root.addEventListener("pointerleave", () => onPreview(null));
  }
}

/** Brief "sent" flash on the key that fired. */
export function flash(el) {
  if (!el) return;
  el.classList.add("is-sent");
  setTimeout(() => el.classList.remove("is-sent"), 220);
}
