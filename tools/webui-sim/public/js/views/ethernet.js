/* Wired Ethernet view (#ethernet): a self-powered OTG USB Ethernet adapter
   on the hub's micro-USB port (docs/USB_ETHERNET.md). Experimental. Opened
   from Settings' "Ethernet (USB OTG)" row.

   GET /api/usb-eth gives the state; POST /api/usb-eth takes any of
   { enabled } (no restart: the hub starts or stops its service and answers
   with the new state), { wifiOff } and the address settings
   ({ ipMode: "dhcp" } or { ipMode: "static", address, ... }), which the
   service picks up on its next pass. Wi-Fi stays connected unless Wi-Fi off
   is chosen, so switching this off, or unplugging the adapter, puts the hub
   back on Wi-Fi only. GET /api/network-overview (Wi-Fi, both interfaces,
   routes, DNS) is heavier: read when the page opens and every
   OVERVIEW_MS while it's open. ethernet-model.js and network-model.js turn
   the answers into words. */

import * as api from "../api.js";
import { confirmDialog, escapeHtml, iconTile, listRow, screenTitle, sectionLabel, snackbar } from "../ui/shell.js";
import {
  addressChangeWarning, canEnable, canRetry, ethernetDetails, ethernetState, pollDelay, staticFormValues, turnOffText,
  turnOnText, validateStatic, wifiOffText,
} from "./ethernet-model.js";
import { textField } from "./device-sheets.js";
import { routeRows, summaryRows, wifiRows, wiredRows } from "./network-model.js";

const OVERVIEW_MS = 10000;

const IP_FIELDS = [
  ["address", "Address", "192.168.1.20", ""],
  ["netmask", "Subnet mask", "255.255.255.0", ""],
  ["gateway", "Router (gateway)", "192.168.1.1", "Optional. Without it the hub reaches only this subnet over the cable."],
  ["dns1", "DNS server", "192.168.1.1", "Optional."],
  ["dns2", "Second DNS server", "", "Optional."],
];

export function createEthernetView(section) {
  let status; // /api/usb-eth; undefined while loading, null if it couldn't be read
  let busy = false;
  let timer = null;
  let overview; // /api/network-overview; undefined while loading, null if it couldn't be read
  let overviewTimer = null;
  let ipDraft = null; // { mode, values } while the IP form has unsaved edits
  let ipError = null; // { field, message }

  section.innerHTML = `<div class="page" id="ethernetRoot"></div>`;
  const root = section.querySelector("#ethernetRoot");

  function statusCard() {
    if (status === undefined) {
      return `<div class="m-list">${listRow({ title: "Checking…", leading: iconTile("settings_ethernet", { size: 48 }) })}</div>`;
    }
    const s = ethernetState(status);
    const retry = canRetry(status)
      ? `<button type="button" class="btn btn-outlined" data-act="retry"${busy ? " disabled" : ""}>Try again</button>`
      : "";
    return `<div class="m-list" aria-live="polite">${listRow({
      title: s.title,
      subtitle: s.detail,
      leading: iconTile("settings_ethernet", { size: 48, tone: s.tone === "live" ? "hub" : "" }),
      trailing: retry,
    })}</div>`;
  }

  function switchRow() {
    const enabled = Boolean(status?.enabled);
    const disabled = busy || status === undefined || status === null || (!enabled && !canEnable(status));
    const wifiOff = Boolean(status?.wifiOff);
    const wifiDisabled = busy || !enabled;
    const wifiSub = !enabled ? "Needs the adapter switched on"
      : status?.wifiSuspended ? "On · Wi-Fi is off now"
        : wifiOff && status?.wifiNeedsRestart ? "On · takes effect after the hub restarts"
          : wifiOff ? "On" : "Off";
    return `<div class="m-list">
        <label class="m-row ds-switch">
          <span class="m-row-text"><span class="ds-title">Ethernet (USB OTG)</span><span class="m-row-sub">${escapeHtml(busy ? "Saving…" : enabled ? "On" : "Off")}</span></span>
          <input type="checkbox" role="switch" class="m-switch" data-usb-ethernet${enabled ? " checked" : ""}${disabled ? " disabled" : ""} aria-label="Ethernet (USB OTG)">
        </label>
        <label class="m-row ds-switch">
          <span class="m-row-text"><span class="ds-title">Turn Wi-Fi off while the cable works</span><span class="m-row-sub">${escapeHtml(wifiSub)}</span></span>
          <input type="checkbox" role="switch" class="m-switch" data-wifi-off${wifiOff ? " checked" : ""}${wifiDisabled ? " disabled" : ""} aria-label="Turn Wi-Fi off while the cable works">
        </label>
      </div>
      <p class="list-note">With Wi-Fi off, the hub is reachable only at its wired address. It turns Wi-Fi off once the cable has carried local traffic for a minute and your router answers through it, and turns it back on by itself if the cable stops working, and after any restart.</p>`;
  }

  function ipCard() {
    if (!status?.supported) return "";
    const saved = { mode: status.ipMode === "static" ? "static" : "dhcp", values: staticFormValues(status) };
    const draft = ipDraft ?? saved;
    const chip = (mode, label) =>
      `<button type="button" class="chip" data-ip-mode="${mode}" aria-pressed="${draft.mode === mode}"${busy ? " disabled" : ""}>${escapeHtml(label)}</button>`;
    const fields = draft.mode === "static"
      ? IP_FIELDS.map(([key, label, placeholder, hint]) => textField({
          id: `eth-${key}`, label, value: draft.values[key] ?? "", placeholder, maxlength: 15,
          hint: ipError?.field === key ? ipError.message : hint,
          attrs: `inputmode="decimal" data-ip-field="${key}"${ipError?.field === key ? ' aria-invalid="true"' : ""}${busy ? " disabled" : ""}`,
        })).join("")
      : `<p class="list-note">The hub asks your router for an address. To keep it the same, reserve one for the adapter in your router.</p>`;
    const changed = Boolean(ipDraft);
    return `${sectionLabel("IP address")}
      <form class="m-card m-form-fields" data-ip-form novalidate>
        <fieldset class="m-fieldset">
          <legend>How the adapter gets its address</legend>
          <div class="m-chips">${chip("dhcp", "Automatic (DHCP)")}${chip("static", "Static")}</div>
        </fieldset>
        ${fields}
        <p class="form-msg" role="status" aria-live="polite">${ipError && !IP_FIELDS.some(([k]) => k === ipError.field) ? escapeHtml(ipError.message) : ""}</p>
        <button type="submit" class="btn btn-filled"${busy || !changed ? " disabled" : ""}>Save</button>
      </form>`;
  }

  function rowsList(rows, cls = "") {
    return `<div class="m-list${cls ? ` ${cls}` : ""}">${rows.map(([title, subtitle]) => listRow({ title, subtitle })).join("")}</div>`;
  }

  function overviewCard() {
    if (status && !status.supported) return "";
    let body;
    if (overview === undefined) body = `<p class="list-note">Reading the network…</p>`;
    else if (overview === null) body = `<p class="list-note">Couldn't read the network overview. Refresh to try again.</p>`;
    else if (!overview.available) return "";
    else {
      const routes = routeRows(overview);
      body = `<h4 class="eth-sub">Wi-Fi</h4>${rowsList(wifiRows(overview))}
        <h4 class="eth-sub">Ethernet</h4>${rowsList(wiredRows(overview))}
        <h4 class="eth-sub">Routing</h4>${rowsList(summaryRows(overview))}
        ${routes.length ? rowsList(routes.map((r) => [r.title, r.subtitle]), "eth-routes") : `<p class="list-note">No routes.</p>`}
        <p class="list-note">Of two routes to the same place, the hub uses the one with the lower metric; the other is the fallback.</p>`;
    }
    return `${sectionLabel("Network overview")}${body}`;
  }

  function detailsCard() {
    const rows = ethernetDetails(status);
    if (!rows.length) return "";
    return `${sectionLabel("Details")}
      <div class="m-list">${rows.map(([label, value]) => listRow({ title: label, subtitle: value })).join("")}</div>`;
  }

  function needsCard() {
    return `${sectionLabel("What you need")}
      <div class="m-card">
        <ul class="list-note eth-needs">
          <li>A <strong>self-powered</strong> OTG micro-USB Ethernet adapter: one with its own power input, often sold for streaming sticks. The hub's micro-USB port can't power an adapter, so a plain adapter won't start. Plug the power input into a USB charger; it powers the hub and the adapter together.</li>
          <li>An adapter with a supported chipset. docs/USB_ETHERNET.md lists them and how far each has been tested.</li>
          <li>Connect the adapter and the cable before turning this on: the hub looks for the adapter for about a minute.</li>
        </ul>
        <p class="list-note">Wi-Fi stays connected as a fallback unless you turn it off above. While the cable works, the hub sends local traffic through it and has a second address: reserve one for the adapter in your router, and point Home Assistant at it. While this is on, the micro-USB port can't be used as a USB device port until the hub restarts with it off.</p>
      </div>`;
  }

  function render() {
    root.innerHTML = `${screenTitle("Wired Ethernet", {
        action: `<button type="button" class="btn btn-outlined" data-act="refresh"${busy ? " disabled" : ""}>Refresh</button>`,
      })}
      ${statusCard()}
      ${sectionLabel("Experimental")}
      ${switchRow()}
      ${ipCard()}
      ${detailsCard()}
      ${overviewCard()}
      ${needsCard()}`;
  }

  function schedule() {
    clearTimeout(timer);
    timer = null;
    const delay = pollDelay(status);
    if (!section.hidden && delay) timer = setTimeout(load, delay);
  }

  function scheduleOverview() {
    clearTimeout(overviewTimer);
    overviewTimer = section.hidden ? null : setTimeout(loadOverview, OVERVIEW_MS);
  }

  // Someone is typing in the IP form: a redraw would take the focus away.
  function editingIpForm() {
    return root.contains(document.activeElement?.closest?.("[data-ip-form]") ?? null);
  }

  // The overview, and the status with it: status polling stops in steady
  // states (cable working, Wi-Fi off, router not answering), and a cable
  // unplugged or a router answering again must still show.
  async function loadOverview() {
    const [o, s] = await Promise.allSettled([api.getNetworkOverview(), api.getUsbEth()]);
    overview = o.status === "fulfilled" ? o.value : null;
    if (s.status === "fulfilled") status = s.value;
    if (!section.hidden && !editingIpForm()) render();
    scheduleOverview();
    if (!timer) schedule();
  }

  async function load() {
    try {
      status = await api.getUsbEth();
    } catch (_) {
      status = null;
    }
    // While polling (every 4 s in some states), not over a half-typed form;
    // the next poll after it shows the news.
    if (!section.hidden && !editingIpForm()) render();
    schedule();
  }

  async function apply(enabled) {
    if (busy) return;
    const ok = await confirmDialog({
      title: enabled ? "Turn on USB Ethernet?" : "Turn off USB Ethernet?",
      text: enabled ? turnOnText() : turnOffText(status, location.hostname),
      confirmLabel: enabled ? "Turn on" : "Turn off",
    });
    if (!ok) return;
    await send(enabled);
  }

  async function send(enabled) {
    busy = true;
    render();
    const viaCable = !enabled && status?.ipv4 && location.hostname === status.ipv4;
    try {
      status = await api.setUsbEth({ enabled });
      snackbar(enabled
        ? (status?.operational ? "USB Ethernet is on and working." : "USB Ethernet is on; the status above follows its progress.")
        : "USB Ethernet is off.");
      if (viaCable) {
        // The hub drops this address in a moment; nothing more to load from here.
        busy = false;
        render();
        return;
      }
    } catch (error) {
      await confirmDialog({
        title: enabled ? "Couldn't turn on USB Ethernet" : "Couldn't turn off USB Ethernet",
        text: error.message || "The hub didn't change the setting.",
        confirmLabel: "OK",
        cancel: false,
      });
    } finally {
      busy = false;
    }
    await load();
    loadOverview();
  }

  async function applyWifiOff(wifiOff) {
    if (busy) return;
    const ok = await confirmDialog({
      title: wifiOff ? "Turn Wi-Fi off while the cable works?" : "Keep Wi-Fi on?",
      text: wifiOffText(status, wifiOff, location.hostname),
      confirmLabel: wifiOff ? "Turn Wi-Fi off" : "Keep Wi-Fi on",
    });
    if (!ok) return;
    busy = true;
    render();
    try {
      status = await api.setUsbEth({ wifiOff });
      snackbar(wifiOff ? "Wi-Fi turns off once the cable has worked for a minute." : "Wi-Fi stays on.");
    } catch (error) {
      await confirmDialog({ title: "Couldn't change this", text: error.message || "The hub didn't change the setting.", confirmLabel: "OK", cancel: false });
    } finally {
      busy = false;
    }
    await load();
  }

  root.addEventListener("change", (event) => {
    const wifiInput = event.target.closest("[data-wifi-off]");
    if (wifiInput) {
      const wifiOff = wifiInput.checked;
      wifiInput.checked = !wifiOff; // stays as it was until the hub has changed
      applyWifiOff(wifiOff);
      return;
    }
    const input = event.target.closest("[data-usb-ethernet]");
    if (!input) return;
    const enabled = input.checked;
    input.checked = !enabled; // stays as it was until the hub has changed
    apply(enabled);
  });

  function currentDraft() {
    return ipDraft ?? { mode: status?.ipMode === "static" ? "static" : "dhcp", values: staticFormValues(status) };
  }

  async function saveIp() {
    const draft = currentDraft();
    if (draft.mode === "static") {
      ipError = validateStatic(draft.values);
      if (ipError) {
        render();
        root.querySelector(`[data-ip-field="${ipError.field}"]`)?.focus();
        return;
      }
    }
    const warning = addressChangeWarning(status, draft.values, draft.mode, location.hostname);
    if (warning) {
      const ok = await confirmDialog({ title: "Change the address?", text: warning, confirmLabel: "Change it" });
      if (!ok) return;
    }
    busy = true;
    ipError = null;
    render();
    try {
      status = await api.setUsbEth(draft.mode === "static" ? { ipMode: "static", ...draft.values } : { ipMode: "dhcp" });
      ipDraft = null;
      snackbar(draft.mode === "static" ? `The adapter uses ${draft.values.address} from now on.` : "The adapter gets its address from your router.");
    } catch (error) {
      ipError = { field: error.data?.field ?? "", message: error.message || "The hub didn't save the address settings." };
    } finally {
      busy = false;
    }
    render();
    if (ipError) root.querySelector(`[data-ip-field="${ipError.field}"]`)?.focus();
    else setTimeout(load, 6000); // the service applies it on its next pass
  }

  root.addEventListener("click", (event) => {
    const act = event.target.closest("[data-act]")?.dataset.act;
    if (act === "refresh") {
      load();
      loadOverview();
      return;
    }
    if (act === "retry" && !busy) {
      send(true);
      return;
    }
    const modeButton = event.target.closest("[data-ip-mode]");
    if (modeButton && !busy) {
      const draft = currentDraft();
      ipDraft = { mode: modeButton.dataset.ipMode, values: draft.values };
      const saved = status?.ipMode === "static" ? "static" : "dhcp";
      if (ipDraft.mode === saved && saved === "dhcp") ipDraft = null;
      ipError = null;
      render();
    }
  });

  root.addEventListener("input", (event) => {
    const input = event.target.closest("[data-ip-field]");
    if (!input) return;
    const draft = currentDraft();
    ipDraft = { mode: draft.mode, values: { ...draft.values, [input.dataset.ipField]: input.value.trim() } };
    // Re-rendering would steal focus: just enable Save.
    const save = root.querySelector("[data-ip-form] [type=submit]");
    if (save) save.disabled = busy;
  });

  root.addEventListener("submit", (event) => {
    if (!event.target.closest("[data-ip-form]")) return;
    event.preventDefault();
    saveIp();
  });

  return {
    onShow() {
      render();
      load();
      loadOverview();
    },
    onHide() {
      clearTimeout(timer);
      timer = null;
      clearTimeout(overviewTimer);
      overviewTimer = null;
    },
  };
}
