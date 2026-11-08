/* Devices tab, the app's DevicesScreen and its device pages:
     #devices                 the list: search, + (Add a device), Tools
     #devices/lab             the IR lab (ir-lab.js)
     #devices/<id>            a device: Remote and Commands tabs; ⋮ holds
                              Edit details, its Touch screen and Delete device
     #devices/<id>/settings   power, inputs and timing (device-settings.js)
     #devices/<id>/sweep      send all commands (device-sweep.js)
   On the Commands tab, Learn a button and Import codes open sheets, and a
   command's ⋮ edits or deletes it. The remote sends straight to the device,
   outside any activity. */

import { forgetTv, getAndroidTvStatus, getConfig, postHubForm, saveActivity, saveAndroidTvDevices, saveDeviceScreen } from "../api.js";
import * as hub from "../state.js";
import {
  confirmDialog,
  escapeHtml,
  icon,
  iconTile,
  listRow,
  openMenu,
  openSheet,
  screenTitle,
  sectionLabel,
  setAppBar,
  snackbar,
  spinner,
} from "../ui/shell.js";
import { resolveSkinPowerAction } from "./control-power.js";
import { openImportSheet } from "./device-import.js";
import { createDeviceSettings } from "./device-settings.js";
import { changeNote, hubChange, openCommandSheet, openDeviceSheet, openLearnSheet, storedCommand } from "./device-sheets.js";
import { createDeviceSweep } from "./device-sweep.js";
import { createIrLab, labNote } from "./ir-lab.js";
import { androidTvDeviceSet, androidTvIdOf, isAndroidTvDevice, tvStatusText } from "./androidtv-model.js";
import { LIMITS, deviceUsage, touchScreenState, withoutDeviceMaps } from "./ir-model.js";
import { describeHaDeviceState, deviceIconName, deviceKeys, isHaCommandRedundant } from "./remote-model.js";
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

export function createDevicesView(section) {
  let page = "list"; // list · lab · device · settings · sweep
  let deviceId = "";
  let query = "";
  let tab = "remote";
  let commandQuery = "";
  let device = null;
  let keys = new Map();
  let shownKey = "";
  let shownData = null;
  let pageShown = false; // the sweep or lab page has drawn itself
  const sheets = new Set();

  section.innerHTML = `<div class="devices-root" id="devicesRoot"></div>`;
  const root = section.querySelector("#devicesRoot");

  /* Every sheet a page opens closes when the page goes. A change often
     redraws the page under the sheet, so focus goes back to the control
     that opened it as it is now (`selector`), not to the one it replaced. */
  function track(opened, selector = "") {
    sheets.add(opened);
    opened.dialog.addEventListener("close", () => {
      sheets.delete(opened);
      if (!selector || section.hidden || sheets.size) return;
      const lost = !document.activeElement || document.activeElement === document.body;
      if (lost) document.querySelector(selector)?.focus();
    });
    return opened;
  }

  function closeSheets() {
    for (const opened of sheets) opened.close();
    sheets.clear();
  }

  const settings = createDeviceSettings({ root, track });
  const sweep = createDeviceSweep({ root });
  const lab = createIrLab({ root });

  /* -- list ------------------------------------------------------------------- */

  function matches() {
    const q = query.trim().toLowerCase();
    return hub.devices()
      .map((d) => {
        const nameHit = !q || [d.name, d.model, d.manufacturer].some((v) => v.toLowerCase().includes(q));
        const commandHits = q ? d.commands.filter((c) => c.name.toLowerCase().includes(q)).length : 0;
        return nameHit || commandHits ? { d, commandHits } : null;
      })
      .filter(Boolean);
  }

  function rowsMarkup() {
    const rows = matches();
    if (!rows.length) {
      return `<p class="list-note">${query.trim() ? `Nothing matches “${escapeHtml(query.trim())}”.` : "No devices on this hub yet."}</p>`;
    }
    return `<div class="m-list">${rows
      .map(({ d, commandHits }) => {
        const haInfo = d.isHa ? describeHaDeviceState(d, hub.state.haState) : null;
        const subtitle = commandHits
          ? `${commandHits} matching command${commandHits === 1 ? "" : "s"}`
          : [
              haInfo ? haInfo.summary : "",
              d.model || d.manufacturer,
              `${d.commands.length} command${d.commands.length === 1 ? "" : "s"}`,
            ].filter(Boolean).join(" · ");
        const badgeCls = d.isAndroidTv ? " badge-network" : d.isHa ? " badge-ha" : d.isBluetooth ? " badge-bluetooth" : "";
        const badgeLabel = d.isAndroidTv ? "Network" : d.isHa ? "Home Assistant" : d.isBluetooth ? "Bluetooth" : "IR";
        const badge = `<span class="badge${badgeCls}">${badgeLabel}</span>`;
        return listRow({
          title: d.name,
          subtitle,
          leading: iconTile(deviceIconName(d)),
          trailing: badge,
          href: `#devices/${encodeURIComponent(d.id)}`,
          attrs: `aria-label="Open ${escapeHtml(d.name)}"`,
        });
      })
      .join("")}</div>`;
  }

  function renderList() {
    const s = hub.state;
    if (!s.configLoaded) {
      root.innerHTML = `<div class="m-center">${spinner("Loading devices")}</div>`;
      return;
    }
    if (s.configError) {
      root.innerHTML = `${screenTitle("Devices")}<p class="list-note">Couldn't load the hub's devices: ${escapeHtml(s.configError.message)}</p>
        <button type="button" class="btn btn-filled" data-act="retry">Try again</button>`;
      return;
    }
    const all = hub.devices();
    const commands = all.reduce((n, d) => n + d.commands.length, 0);
    const add = `<button type="button" class="icon-btn icon-btn-secondary" data-act="add-device" aria-haspopup="dialog" aria-label="Add a device" title="Add a device">${icon("add")}</button>`;
    root.innerHTML = `<div class="page">
        ${screenTitle("Devices", { action: add })}
        <label class="search-field">${icon("search", { size: 22 })}<input type="search" id="deviceSearch" value="${escapeHtml(query)}" placeholder="Search devices or commands" aria-label="Search devices or commands"></label>
        <div id="deviceRows">${rowsMarkup()}</div>
        <p class="list-note">Open a device to control it directly, outside any activity. Each device also has Learn a button and Import codes.</p>
        ${sectionLabel("Tools")}
        <div class="m-list">${listRow({
          title: "IR lab",
          subtitle: "A scratch device for trying codes",
          leading: iconTile("build_outlined"),
          chevron: true,
          href: "#devices/lab",
        })}</div>
        <p class="list-note">${all.length} of ${LIMITS.devices} devices · ${commands} command${commands === 1 ? "" : "s"} in all</p>
      </div>`;
  }

  /* -- device page -------------------------------------------------------------- */

  function setStatus(text, kind) {
    const el = root.querySelector("#deviceStatus");
    if (!el) return;
    el.textContent = text;
    el.dataset.kind = kind ?? "";
  }

  function sendAction(action, label, el) {
    flash(el);
    return sendCommand(action, { label, status: setStatus });
  }

  function pressKey(entry, which, el) {
    sendAction(which === "hold" ? entry.hold : entry.press, entry.label, el);
  }

  function repeatKey(entry, el) {
    flash(el);
    return repeatCommand(entry.press, { label: entry.label, status: setStatus });
  }

  function panelSource() {
    return device && { keys, softButtons: [], devices: [device], title: device.name };
  }

  function commandRows() {
    const q = commandQuery.trim().toLowerCase();
    const haInfo = device.isHa ? describeHaDeviceState(device, hub.state.haState) : null;
    const list = device.commands
      .map((c, i) => ({ c, i }))
      .filter(({ c }) => !q || c.name.toLowerCase().includes(q));
    if (!list.length) {
      return `<p class="list-note">${q ? `Nothing matches “${escapeHtml(commandQuery.trim())}”.` : "No commands yet. Learn a button or import codes."}</p>`;
    }
    return `<div class="cmd-list">${list
      .map(({ c, i }) => {
        const redundant = isHaCommandRedundant(c.name, haInfo);
        const tag = redundant
          ? `<span class="cmd-tag">Current</span>`
          : c.learned ? `<span class="cmd-tag">Learned</span>` : "";
        return `<div class="cmd-item${redundant ? " is-redundant" : ""}">
          <button type="button" class="cmd-row" data-cmd-device="${escapeHtml(device.id)}" data-cmd="${i}">
            <span class="cmd-name">${escapeHtml(c.name)}</span>${tag}
          </button>
          <button type="button" class="icon-btn cmd-more" data-cmd-menu="${i}" aria-haspopup="menu" aria-label="More for ${escapeHtml(c.name)}">${icon("more_vert")}</button>
        </div>`;
      })
      .join("")}</div>`;
  }

  function renderDevice() {
    const s = hub.state;
    if (!s.configLoaded) {
      root.innerHTML = `<div class="m-center">${spinner("Loading the device")}</div>`;
      return;
    }
    if (s.configError) {
      setAppBar({ title: "Device", back: "devices" });
      root.innerHTML = `<div class="page"><p class="list-note">Couldn't load the hub's devices: ${escapeHtml(s.configError.message)}</p>
        <button type="button" class="btn btn-filled" data-act="retry">Try again</button></div>`;
      return;
    }
    device = hub.deviceById(deviceId);
    if (!device) {
      setAppBar({ title: "Device", back: "devices" });
      root.innerHTML = `<p class="list-note">This device is no longer on the hub.</p>`;
      return;
    }
    keys = deviceKeys(device);
    const power = powerAction();
    const powerLabel = power.kind === "device-power" ? `Send ${power.command} to ${device.name}` : `${device.name} has no power command`;
    const id = encodeURIComponent(device.id);
    setAppBar({
      title: device.name,
      back: "devices",
      actions: `<a class="icon-btn" href="#devices/${id}/settings" aria-label="${escapeHtml(device.name)} settings" title="Settings">${icon("tune_outlined")}</a>
        <button type="button" class="icon-btn icon-btn-power" data-act="device-power" aria-label="${escapeHtml(powerLabel)}" title="${escapeHtml(powerLabel)}"${power.kind === "device-power" ? "" : " disabled"}>${icon("power_settings_new")}</button>
        <button type="button" class="icon-btn" data-act="device-menu" aria-haspopup="menu" aria-expanded="false" aria-label="More options for ${escapeHtml(device.name)}" title="More options">${icon("more_vert")}</button>`,
    });
    const tabs = `<div class="seg-tabs" role="tablist" aria-label="${escapeHtml(device.name)}">
        <button type="button" role="tab" class="seg-tab" data-tab="remote" aria-selected="${tab === "remote"}">Remote</button>
        <button type="button" role="tab" class="seg-tab" data-tab="commands" aria-selected="${tab === "commands"}">Commands (${device.commands.length})</button>
      </div>`;
    const haStrip = device.isHa ? haStateStripMarkup([device], hub.state.haState, { single: true }) : "";
    const androidtv = isAndroidTvDevice(device);
    const androidTvLine = androidtv ? `<p class="list-note androidtv-status" data-androidtv-status>Network TV · checking the connection…</p>` : "";
    const body = tab === "remote"
      ? `<div class="remote">
          <div class="remote-main">
            ${haStrip}
            <p class="remote-status" id="deviceStatus" role="status" aria-live="polite"></p>
            ${androidTvLine}
            ${tabs}
            <div class="remote-surface">${padMarkup(keys)}</div>
          </div>
          <aside class="remote-side" aria-label="More keys">${moreKeysMarkup(keys, { title: device.name })}</aside>
        </div>`
      : `<div class="page">
          ${haStrip}
          <p class="remote-status" id="deviceStatus" role="status" aria-live="polite"></p>
          ${androidTvLine}
          ${tabs}
          ${androidtv ? `<p class="list-note">A network TV's commands come with it; the hub sends them over the network.</p>` : `<div class="cmd-tools">
            <button type="button" class="btn btn-outlined" data-act="learn" aria-haspopup="dialog">${icon("settings_remote_outlined", { size: 18 })}Learn a button</button>
            <button type="button" class="btn btn-outlined" data-act="import" aria-haspopup="dialog">${icon("content_paste_outlined", { size: 18 })}Import codes</button>
          </div>`}
          ${labNote(device)}
          <label class="search-field">${icon("search", { size: 22 })}<input type="search" id="commandSearch" value="${escapeHtml(commandQuery)}" placeholder="Search ${device.commands.length} commands" aria-label="Search ${device.commands.length} commands"></label>
          <div class="cmd-head">
            <p class="list-note">Tap a command to send it.</p>
            ${device.commands.length ? `<a class="btn btn-text" href="#devices/${id}/sweep">Send all…</a>` : ""}
          </div>
          <div id="commandRows">${commandRows()}</div>
        </div>`;
    root.innerHTML = body;
    if (androidtv) showAndroidTvStatus(device);
    const side = root.querySelector(".remote-side");
    if (side) wireMoreKeys(side, { source: panelSource, send: sendAction, keyEvents: false });
  }

  /* A network TV's connection, from codex_androidtv, under its name. */
  async function showAndroidTvStatus(d) {
    const line = root.querySelector("[data-androidtv-status]");
    let text;
    try {
      const st = await getAndroidTvStatus();
      text = tvStatusText((st.tvs ?? []).find((tv) => tv.id === androidTvIdOf(d)));
    } catch (error) {
      text = error.message || "The hub's network TV service didn't answer.";
    }
    if (line?.isConnected) line.textContent = `Network TV · ${text}`;
  }

  /* What a page shows of the setup: a redraw only when it changes, so a
     refresh for something else leaves the page (and its search) alone. */
  function pageData() {
    if (page === "list") {
      return JSON.stringify(hub.devices().map((d) => [
        d.id,
        d.name,
        d.model,
        d.manufacturer,
        d.isBluetooth,
        d.isHa,
        d.commands.length,
        d.isHa ? describeHaDeviceState(d, hub.state.haState)?.summary ?? "" : "",
      ]));
    }
    if (page === "device") {
      const d = hub.deviceById(deviceId);
      return JSON.stringify([
        d?.entry ?? null,
        d?.isHa ? describeHaDeviceState(d, hub.state.haState) : null,
      ]);
    }
    return hub.state.config;
  }

  function render() {
    const s = hub.state;
    if (page === "settings") return; // it keeps its own copy and unsaved edits
    const key = JSON.stringify([page, deviceId, tab, s.configLoaded, Boolean(s.configError)]);
    const data = pageData();
    if (key === shownKey && data === shownData) return;
    shownKey = key;
    shownData = data;
    if (page === "list") {
      setAppBar(null);
      renderList();
      return;
    }
    if (page === "device") {
      renderDevice();
      return;
    }
    // The sweep and the lab draw themselves once the setup is in.
    if (!s.configLoaded) {
      root.innerHTML = `<div class="m-center">${spinner("Loading")}</div>`;
      return;
    }
    if (s.configError) {
      root.innerHTML = `<div class="page"><p class="list-note">Couldn't load the hub's devices: ${escapeHtml(s.configError.message)}</p>
        <button type="button" class="btn btn-filled" data-act="retry">Try again</button></div>`;
      return;
    }
    const pageView = page === "sweep" ? sweep : lab;
    if (pageShown) pageView.refresh();
    else {
      pageShown = true;
      pageView.show(deviceId);
    }
  }

  function openMoreKeys() {
    track(openSheet({
      label: "More keys",
      render: (content) => {
        content.innerHTML = moreKeysMarkup(keys, { title: device.name });
        wireMoreKeys(content, { source: panelSource, send: sendAction, onPress: pressKey, onRepeat: repeatKey });
      },
    }));
  }

  /* The device's first power command by name (PowerOff, standby, a toggle),
     the same key the hub's own remote page and the app use. */
  function powerAction() {
    return resolveSkinPowerAction({
      mode: "devices",
      currentActivityId: hub.state.currentId,
      selectedDeviceId: device.id,
      deviceCommands: device.commands,
    });
  }

  function powerDevice() {
    if (!device) return;
    const action = powerAction();
    if (action.kind !== "device-power") {
      snackbar(`${device.name} has no power command`, { error: true });
      return;
    }
    sendAction({ deviceId: action.deviceId, command: action.command, functionId: action.functionId }, "Power");
  }

  /* -- delete ---------------------------------------------------------------------- */

  function stillUsed(d, uses) {
    return confirmDialog({
      title: `${d.name} is still in use`,
      text: `This device is still used by ${uses.join(", ")}. Remove it from there first, then delete it.`,
      confirmLabel: "OK",
      cancel: false,
    });
  }

  /* The hub refuses to delete a device that activities or button maps still
     name (their later saves would fail validation). Say where it is used, or
     first drop the device's own remote screens through the activity save. */
  async function deleteDevice(d) {
    const early = deviceUsage(hub.state.config, d.id);
    if (early.uses.length) {
      await stillUsed(d, early.uses);
      return;
    }
    const ok = await confirmDialog({
      title: `Delete ${d.name}?`,
      text: `Permanently removes “${d.name}”, all of its learned commands and its device screen on the remote from the hub.`,
      confirmLabel: "Delete",
      destructive: true,
    });
    if (!ok) return;
    snackbar(`Deleting ${d.name}…`);
    try {
      // The hub's own copy decides, not the one on screen.
      const config = await getConfig();
      const usage = deviceUsage(config, d.id);
      if (usage.uses.length) {
        await stillUsed(d, usage.uses);
        return;
      }
      let saved = null;
      if (usage.ownMaps) {
        const { mapList, functionList } = withoutDeviceMaps(config, d.id);
        saved = await saveActivity({
          baseRevision: config.revision,
          activityList: config.activityList,
          mapList,
          functionList,
        });
      }
      try {
        if (isAndroidTvDevice(d)) {
          // The writer owns network TVs: save the set without it, then unpair.
          await saveAndroidTvDevices(androidTvDeviceSet(config, { remove: androidTvIdOf(d) }));
          await forgetTv({ id: androidTvIdOf(d) }).catch(() => {});
        } else {
          await postHubForm("/ir/delete-device", { deviceId: d.id });
        }
      } catch (error) {
        // The device stays: give it back the remote screens taken off it.
        if (saved) {
          const back = await saveActivity({
            baseRevision: saved.revision,
            activityList: config.activityList,
            mapList: config.mapList,
            functionList: config.functionList,
          }).then(() => true, () => false);
          error.message = `${error.message} ${back
            ? "Its remote screens are back as they were."
            : "Its remote screens were removed and couldn't be put back."}`;
        }
        throw error;
      } finally {
        await hub.refreshConfig().catch(() => {});
      }
      snackbar(`Deleted ${d.name}`);
      if (!section.hidden && page === "device" && deviceId === d.id) location.hash = "#devices";
    } catch (error) {
      snackbar(error.message || "Delete failed.", { error: true });
    }
  }

  async function deleteCommand(d, name) {
    const ok = await confirmDialog({
      title: `Delete “${name}”?`,
      text: `Removes the “${name}” command from ${d.name}.`,
      confirmLabel: "Delete",
      destructive: true,
    });
    if (!ok) return;
    try {
      const result = await hubChange("/ir/delete-command", { deviceId: d.id, command: name }, () => !storedCommand(d.id, name));
      snackbar(changeNote(result, `Deleted “${name}”`));
    } catch (error) {
      snackbar(error.message || "Delete failed.", { error: true });
    }
  }

  /* -- menus ------------------------------------------------------------------------- */

  /* -- Touch screen ------------------------------------------------------------------ */

  /* The hub builds the screen from the device's commands: hard keys for the
     ones named like them, every other command on screen. The Touch pulls
     the change by itself. */
  async function saveTouchScreen(d, remove) {
    snackbar(remove ? `Removing ${d.name}'s remote screen…` : `Building ${d.name}'s remote screen…`);
    try {
      const result = await saveDeviceScreen({ deviceId: d.id, remove });
      await hub.refreshConfig().catch(() => {});
      if (!result.changed) {
        snackbar(remove ? `${d.name} has no remote screen` : `${d.name}'s remote screen is already up to date`);
      } else if (remove) {
        snackbar(`Removed ${d.name}'s remote screen. Remotes with a screen pick this up by themselves.`);
      } else {
        const keys = result.hardKeys?.length ?? 0;
        const onScreen = result.onScreen ?? 0;
        snackbar(`${d.name}'s remote screen: ${keys} hard key${keys === 1 ? "" : "s"}, ${onScreen} on-screen button${onScreen === 1 ? "" : "s"}. Remotes with a screen pick it up by themselves.`);
      }
    } catch (error) {
      snackbar(error.message || "The remote screen was not saved.", { error: true });
    }
  }

  function touchScreenItems(d) {
    const screen = touchScreenState(hub.state.config, d.id);
    if (screen === "none") return [{ id: "screen-make", label: "Make remote screen", icon: "settings_remote_outlined" }];
    if (screen === "made") {
      return [
        { id: "screen-make", label: "Rebuild remote screen", icon: "refresh" },
        { id: "screen-remove", label: "Remove remote screen", icon: "remove" },
      ];
    }
    return [];
  }

  function openDeviceMenu(anchor) {
    const d = device;
    openMenu({
      anchor,
      label: `${d.name} options`,
      items: [
        { id: "edit", label: "Edit details", icon: "edit_outlined" },
        ...touchScreenItems(d),
        { id: "delete", label: "Delete device", icon: "delete_outlined", destructive: true },
      ],
      onSelect: (choice) => {
        if (choice === "edit") track(openDeviceSheet({ device: d }), "[data-act='device-menu']");
        else if (choice === "screen-make") saveTouchScreen(d, false);
        else if (choice === "screen-remove") saveTouchScreen(d, true);
        else if (choice === "delete") deleteDevice(d);
      },
    });
  }

  function openCommandMenu(anchor, command) {
    const d = device;
    openMenu({
      anchor,
      label: command.name,
      items: [
        { id: "edit", label: "Edit", icon: "edit_outlined" },
        { id: "delete", label: "Delete", icon: "delete_outlined", destructive: true },
      ],
      onSelect: (choice) => {
        if (choice === "edit") track(openCommandSheet({ device: d, command }), "#commandSearch");
        else if (choice === "delete") deleteCommand(d, command.name);
      },
    });
  }

  /* -- events ------------------------------------------------------------------- */

  wireKeys(root, {
    keyFor: (k) => (page === "device" ? keys.get(k) ?? null : null),
    onPress: pressKey,
    onRepeat: repeatKey,
    onPreview: (entry) => {
      if (entry) setStatus(describe(entry.label, entry.press), "preview");
    },
  });

  root.addEventListener("click", (event) => {
    if (page !== "settings" && event.target.closest("[data-act='retry']")) {
      hub.reloadConfig();
      return;
    }
    if (page === "list") {
      const act = event.target.closest("[data-act]")?.dataset.act;
      if (act === "add-device") {
        track(openDeviceSheet({
          onDone: (added) => {
            if (added && !section.hidden) location.hash = `#devices/${encodeURIComponent(added.id)}`;
          },
        }), "[data-act='add-device']");
      }
      return;
    }
    if (page !== "device" || !device || event.target.closest(".remote-side")) return;
    const tabBtn = event.target.closest("[data-tab]");
    if (tabBtn && tabBtn.dataset.tab !== tab) {
      tab = tabBtn.dataset.tab;
      shownKey = "";
      render();
      root.querySelector(`[data-tab="${tab}"]`)?.focus();
      return;
    }
    const menuBtn = event.target.closest("[data-cmd-menu]");
    if (menuBtn) {
      const c = device.commands[Number(menuBtn.dataset.cmdMenu)];
      if (c) openCommandMenu(menuBtn, c);
      return;
    }
    const cmd = event.target.closest("[data-cmd]");
    if (cmd) {
      const c = device.commands[Number(cmd.dataset.cmd)];
      if (c) sendAction({ deviceId: device.id, command: c.name, functionId: c.functionId }, c.name, cmd);
      return;
    }
    const act = event.target.closest("[data-act]")?.dataset.act;
    if (act === "more") openMoreKeys();
    else if (act === "learn") track(openLearnSheet({ device }), "[data-act='learn']");
    else if (act === "import") track(openImportSheet({ device }), "[data-act='import']");
  });

  root.addEventListener("input", (event) => {
    if (event.target.id === "deviceSearch") {
      query = event.target.value;
      root.querySelector("#deviceRows").innerHTML = rowsMarkup();
    } else if (event.target.id === "commandSearch") {
      commandQuery = event.target.value;
      root.querySelector("#commandRows").innerHTML = commandRows();
    }
  });

  document.getElementById("appbar")?.addEventListener("click", (event) => {
    if (section.hidden || page !== "device" || !device) return;
    if (event.target.closest("[data-act='device-power']")) powerDevice();
    const menu = event.target.closest("[data-act='device-menu']");
    if (menu) openDeviceMenu(menu);
  });

  hub.subscribe(() => {
    if (!section.hidden) render();
  });

  function leavePage() {
    if (page === "settings") settings.hide();
    else if (page === "sweep") sweep.hide();
    else if (page === "lab") lab.hide();
  }

  return {
    onShow({ args = [] } = {}) {
      let next = args[0] ?? "";
      try {
        next = decodeURIComponent(next);
      } catch (_) {
        // A malformed escape is just an unknown device.
      }
      const nextPage = !next ? "list"
        : next === "lab" ? "lab"
        : args[1] === "settings" ? "settings"
        : args[1] === "sweep" ? "sweep"
        : "device";
      closeSheets();
      leavePage();
      if (next !== deviceId && nextPage !== "lab") {
        tab = "remote";
        commandQuery = "";
      }
      page = nextPage;
      if (page !== "list" && page !== "lab") deviceId = next;
      shownKey = "";
      pageShown = false;
      hub.ensureConfig();
      if (page === "settings") settings.show(deviceId);
      render();
    },
    onHide() {
      closeSheets();
      leavePage();
      shownKey = "";
      pageShown = false;
    },
    confirmLeave() {
      return page === "settings" ? settings.confirmLeave() : true;
    },
  };
}
