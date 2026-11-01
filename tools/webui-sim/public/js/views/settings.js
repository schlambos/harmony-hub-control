/* Settings tab (#settings): the app's SettingsScreen. A hub card, then the
   hub's own setup pages (Bluetooth keyboard, MQTT, Wi-Fi, Backup, System),
   each opening as a sub-page. The simulator also lists its recent events
   here (the old Home page's debug panel; gated on HARMONY_SIM so the
   production shell never calls a /sim/ route). */

import * as api from "../api.js";
import * as hub from "../state.js";
import { escapeHtml, iconTile, listRow, screenTitle, sectionLabel } from "../ui/shell.js";
import { parseTextStatus } from "./bluetooth-model.js";

const SIM = globalThis.HARMONY_SIM === true;

const PAGES = [
  ["remotes", "Remotes", "Pair a Harmony remote and set its buttons"],
  ["bluetooth", "Bluetooth keyboard", ""],
  ["mqtt", "MQTT", "Home Assistant bridge"],
  ["wifi", "Wi-Fi", "The network your hub joins"],
  ["backup", "Backup", "Download or restore your hub's setup"],
  ["system", "System", "Firmware, time zone, sign-in, updates and logs"],
];

function eventLine(ev) {
  const kind = String(ev?.kind ?? "").toLowerCase();
  if (kind.includes("startactivity") || kind.includes("run")) {
    return ev.activityId === "-1" ? "Start · Everything off" : `Start · ${hub.activityName(hub.activityById(ev.activityId))}`;
  }
  if (kind.includes("hold") || kind.includes("button") || kind.includes("ir")) {
    return `${ev.buttonKey ?? ev.command ?? "Key"} → ${hub.deviceName(ev.deviceId)} · ${ev.command ?? "?"}`;
  }
  if (kind.includes("reset")) return "Engine reset";
  return ev.message ?? ev.kind ?? "sim event";
}

export function createSettingsView(section) {
  let keyboard = null; // parsed /api/bt-text-status, or { failed: true }
  let events; // undefined while loading, null when the sim has no event log

  section.innerHTML = `<div class="page" id="settingsRoot"></div>`;
  const root = section.querySelector("#settingsRoot");

  function hubCard() {
    const s = hub.state;
    const ok = s.configLoaded && !s.configError && s.reachable;
    let subtitle;
    if (!s.configLoaded) subtitle = "Connecting…";
    else if (s.configError) subtitle = `Not connected · ${s.configError.message}`;
    else {
      const c = hub.counts();
      subtitle = [
        s.reachable ? "Connected" : "Not answering",
        `${c.activities} activit${c.activities === 1 ? "y" : "ies"}`,
        `${c.devices} device${c.devices === 1 ? "" : "s"}`,
      ].filter(Boolean).join(" · ");
    }
    return `<div class="m-list">${listRow({
      title: "Hub",
      subtitle,
      leading: iconTile(ok ? "wifi" : "wifi_off", { size: 48, tone: ok ? "hub" : "" }),
      trailing: `<button type="button" class="btn btn-outlined" data-act="refresh">Refresh</button>`,
    })}</div>`;
  }

  function keyboardSubtitle() {
    if (!keyboard) return "Checking…";
    if (keyboard.failed) return "Couldn't check the keyboard";
    return keyboard.live
      ? `Connected${keyboard.target ? ` · ${keyboard.target}` : ""}`
      : "Not connected · pair with your TV";
  }

  function eventsMarkup() {
    if (!SIM || events === null) return "";
    const list = events === undefined
      ? `<p class="list-note">Loading events…</p>`
      : events.length
        ? `<ol class="send-log">${events
            .slice()
            .reverse()
            .map((ev) => `<li><span class="send-time">${ev.ts ? new Date(ev.ts).toLocaleTimeString([], { hour12: false }) : "--:--:--"}</span><span class="send-target">${escapeHtml(eventLine(ev))}</span></li>`)
            .join("")}</ol>`
        : `<p class="list-note">No events yet. Press some keys on the remote.</p>`;
    return `${sectionLabel("Simulation")}
      <div class="m-card">
        <div class="m-card-head"><span>Recent sim events</span><button type="button" class="btn btn-text btn-sm" data-act="events">Refresh</button></div>
        ${list}
      </div>`;
  }

  function aboutMarkup() {
    const c = hub.state.config ? hub.counts() : null;
    const favicon = document.querySelector("link[rel~='icon']")?.getAttribute("href") ?? "";
    return `<div class="about">
        ${favicon ? `<img class="about-mark" src="${escapeHtml(favicon)}" alt="" width="48" height="48">` : ""}
        <p class="about-name">Melodious</p>
        <p class="about-text">Runs on your Harmony Hub, fully offline.</p>
        ${c ? `<p class="about-meta">Config revision ${escapeHtml(c.revision)} · ${c.buttonMaps} button maps</p>` : ""}
      </div>`;
  }

  function render() {
    root.innerHTML = `${screenTitle("Settings")}
      ${hubCard()}
      ${sectionLabel("Hub")}
      <div class="m-list">${PAGES.map(([route, title, subtitle]) => listRow({
        title,
        subtitle: route === "bluetooth" ? keyboardSubtitle() : subtitle,
        href: `#${route}`,
        chevron: true,
      })).join("")}</div>
      ${eventsMarkup()}
      ${aboutMarkup()}`;
  }

  async function loadKeyboard() {
    try {
      keyboard = parseTextStatus(await api.getJson("/api/bt-text-status"));
    } catch (_) {
      keyboard = { failed: true };
    }
    if (!section.hidden) render();
  }

  async function loadEvents() {
    if (!SIM) return;
    try {
      events = (await api.getSimEvents())?.events ?? [];
    } catch (_) {
      events = null;
    }
    if (!section.hidden) render();
  }

  root.addEventListener("click", (event) => {
    const act = event.target.closest("[data-act]")?.dataset.act;
    if (act === "refresh") {
      hub.reloadConfig();
      hub.refreshState();
      loadKeyboard();
    } else if (act === "events") {
      loadEvents();
    }
  });

  hub.subscribe(() => {
    if (!section.hidden) render();
  });

  return {
    onShow() {
      hub.ensureConfig();
      render();
      loadKeyboard();
      loadEvents();
    },
    onHide() {},
  };
}
