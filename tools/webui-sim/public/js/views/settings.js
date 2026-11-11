/* Settings tab (#settings): the app's SettingsScreen. A hub card, then the
   hub's own setup pages (Bluetooth keyboard, MQTT, Wi-Fi, Backup, System),
   each opening as a sub-page, then Experimental: the switch for multiple
   remotes of one model (docs/MULTI_REMOTE.md). It can be turned on only when
   the hub's hal is exactly the build the change was made for, and turning it
   on or off restarts the hub. Then the switch for Ethernet over a USB OTG
   adapter (docs/USB_ETHERNET.md), whose row opens the Wired Ethernet page
   (views/ethernet.js) for its status, Wi-Fi off and address settings, and
   the network overview. The simulator also lists its recent events
   here (the old Home page's debug panel; gated on HARMONY_SIM so the
   production shell never calls a /sim/ route). */

import * as api from "../api.js";
import * as hub from "../state.js";
import { confirmDialog, escapeHtml, icon, iconTile, listRow, screenTitle, sectionLabel, snackbar } from "../ui/shell.js";
import { multiRemoteStatus, usbEthStatus } from "./remotes-model.js";
import { parseTextStatus } from "./bluetooth-model.js";
import { turnOffText, turnOnText } from "./ethernet-model.js";

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
  let multi; // /api/multi-remote; undefined while loading, null when it couldn't be read
  let multiBusy = ""; // "" | "saving" | "restarting"
  let usbEth; // /api/usb-eth; undefined while loading, null when it couldn't be read
  let usbEthBusy = ""; // "" | "saving"

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

  function experimentalMarkup() {
    const status = multiRemoteStatus(multi, multiBusy);
    const disabled = multi === undefined || multi === null || Boolean(multiBusy);
    const ethStatus = usbEthStatus(usbEth, usbEthBusy);
    const ethDisabled = usbEth === undefined || usbEth === null || Boolean(usbEthBusy);
    return `${sectionLabel("Experimental")}
      <div class="m-list">
        <label class="m-row ds-switch">
          <span class="m-row-text"><span class="ds-title">Multiple remotes of one model</span><span class="m-row-sub" data-multi-status>${escapeHtml(status)}</span></span>
          <input type="checkbox" role="switch" class="m-switch" data-multi-remote${multi?.enabled ? " checked" : ""}${disabled ? " disabled" : ""} aria-label="Multiple remotes of one model">
        </label>
        <div class="m-row ds-switch eth-row">
          <a class="eth-row-link" href="#ethernet">
            <span class="m-row-text"><span class="ds-title">Ethernet (USB OTG)</span><span class="m-row-sub" data-usb-eth-status>${escapeHtml(ethStatus)}</span></span>
            ${icon("keyboard_arrow_right", { cls: "m-row-chevron" })}
          </a>
          <input type="checkbox" role="switch" class="m-switch" data-usb-eth${usbEth?.enabled ? " checked" : ""}${ethDisabled ? " disabled" : ""} aria-label="Ethernet (USB OTG)">
        </div>
      </div>
      <p class="list-note">Multiple remotes lets the hub keep two or more remotes without a screen of the same model, such as two Smart Controls (turning it on or off restarts the hub). Ethernet uses a <strong>self-powered OTG micro-USB Ethernet adapter</strong> with a supported chipset (see docs/USB_ETHERNET.md) — the hub's micro-USB port cannot supply power, so the adapter must have its own power leg. Open the row for its status, a static address, Wi-Fi off while the cable works, and a network overview.</p>`;
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
      ${experimentalMarkup()}
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

  async function loadMulti() {
    try {
      multi = await api.getMultiRemote();
    } catch (_) {
      multi = null;
    }
    if (!section.hidden) render();
  }

  async function loadUsbEth() {
    try {
      usbEth = await api.getUsbEth();
    } catch (_) {
      usbEth = null;
    }
    if (!section.hidden) render();
  }

  async function switchUsbEth(enabled) {
    if (!usbEth || usbEthBusy) return;
    if (enabled && !usbEth.supported) {
      await confirmDialog({
        title: "Can't turn on USB Ethernet",
        text: "This hub's kernel is not the build USB Ethernet was made for (2.6.31-g89d565c).",
        confirmLabel: "OK",
        cancel: false,
      });
      return;
    }
    const ok = await confirmDialog({
      title: enabled ? "Turn on USB Ethernet?" : "Turn off USB Ethernet?",
      text: enabled ? turnOnText() : turnOffText(usbEth, location.hostname),
      confirmLabel: enabled ? "Turn on" : "Turn off",
    });
    if (!ok) return;
    usbEthBusy = "saving";
    render();
    try {
      usbEth = await api.setUsbEth({ enabled });
      snackbar(enabled
        ? (usbEth?.operational ? "USB Ethernet is on and working." : "USB Ethernet is on; its status above says whether the cable is working.")
        : "USB Ethernet is off.");
    } catch (error) {
      await confirmDialog({
        title: enabled ? "Couldn't turn on USB Ethernet" : "Couldn't turn off USB Ethernet",
        text: error.message || "The hub didn't change the setting.",
        confirmLabel: "OK",
        cancel: false,
      });
      await loadUsbEth();
    } finally {
      usbEthBusy = "";
      if (!section.hidden) render();
    }
  }

  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /* After the hub restarts: poll until it answers with the new state (about 2 minutes). */
  async function waitForRestart(enabled) {
    await pause(5000);
    for (let i = 0; i < 48; i++) {
      try {
        multi = await api.getMultiRemote();
        if (multi.active === enabled) return true;
      } catch (_) {
        // still restarting
      }
      await pause(5000);
    }
    return false;
  }

  async function switchMulti(enabled) {
    if (!multi || multiBusy) return;
    if (enabled && !multi.supported) {
      await confirmDialog({
        title: "Can't turn this on",
        text: multi.reason || "This hub's remote software isn't the build this change was made for.",
        confirmLabel: "OK",
        cancel: false,
      });
      return;
    }
    const ok = await confirmDialog({
      title: enabled ? "Turn on multiple remotes of one model?" : "Turn off multiple remotes of one model?",
      text: enabled
        ? "Experimental. The hub makes a changed copy of its own remote software (hal), checks that it matches the expected checksum exactly, and runs it from now on. You can then pair more than one remote without a screen of the same model; they share their buttons. The hub restarts now to apply it. That takes about two minutes, and the remotes and this app won't respond until it's back."
        : "The hub goes back to its stock remote software, which keeps one remote of each model. The hub restarts now. That takes about two minutes, and the remotes and this app won't respond until it's back.",
      confirmLabel: enabled ? "Turn on and restart" : "Turn off and restart",
    });
    if (!ok) return;
    await applyMulti(enabled);
  }

  /* Off can't be checked while the radio doesn't answer (the very thing a
     hang in the changed hal breaks), so the hub offers to turn it off anyway. */
  async function offerForcedOff() {
    const ok = await confirmDialog({
      title: "Turn off anyway?",
      text: "The hub's radio isn't answering, so the hub can't check that no two remotes of one model are paired. It can still go back to its stock remote software and restart now. If two remotes of one model are still paired, the stock software hangs the same way: turn this back on, unpair the extra remote, then turn it off.",
      confirmLabel: "Turn off and restart",
    });
    if (ok) await applyMulti(false, true);
  }

  async function applyMulti(enabled, force = false) {
    multiBusy = "saving";
    render();
    let retryForced = false;
    try {
      const res = await api.setMultiRemote({ enabled, force });
      if (res.rebooting) {
        multiBusy = "restarting";
        render();
        const back = await waitForRestart(enabled);
        snackbar(back
          ? `The hub restarted. Multiple remotes of one model is ${enabled ? "on" : "off"}.`
          : "The hub hasn't come back with the new setting yet. Refresh in a minute.", { error: !back });
      } else {
        snackbar(`Multiple remotes of one model is ${enabled ? "on" : "off"}.`);
      }
    } catch (error) {
      if (!enabled && !force && error.status === 502) {
        retryForced = true;
      } else {
        await confirmDialog({
          title: enabled ? "Couldn't turn this on" : "Couldn't turn this off",
          text: error.message || "The hub didn't change the setting.",
          confirmLabel: "OK",
          cancel: false,
        });
      }
    } finally {
      multiBusy = "";
    }
    await loadMulti();
    if (retryForced) await offerForcedOff();
  }

  root.addEventListener("change", (event) => {
    const multiInput = event.target.closest("[data-multi-remote]");
    if (multiInput) {
      const enabled = multiInput.checked;
      multiInput.checked = !enabled; // stays as it was until the hub has changed
      switchMulti(enabled);
      return;
    }
    const ethInput = event.target.closest("[data-usb-eth]");
    if (ethInput) {
      const enabled = ethInput.checked;
      ethInput.checked = !enabled;
      switchUsbEth(enabled);
    }
  });

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
      loadMulti();
      loadUsbEth();
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
      loadMulti();
      loadUsbEth();
      loadEvents();
    },
    onHide() {},
  };
}
