import * as api from "../api.js";
import * as hub from "../state.js";
import { escapeHtml } from "../setup-kit.js";
import {
  REMOTE_BUTTONS,
  aliasMatch,
  commandKey,
  matchCommand,
} from "../remote-layout.js";
import { commandsPanelShouldOpen } from "./control-panel-state.js";

const HOLD_MS = 550;
const LOG_MAX = 14;
const SOFT_MAX = 24;

/* Production defines globalThis.REMOTE_SKIN_SRC from the hub's existing
   REMOTE_SKIN_JPG_B64 so the JPEG is never embedded or served twice; the
   static route is the sim/offline fallback. */
const SKIN_SRC = globalThis.REMOTE_SKIN_SRC || "/assets/remote-skin.jpg";

const TEMPLATE = `
  <div class="view-head">
    <div>
      <h2 id="title-control">Control</h2>
      <p class="view-lead">One handset for the whole rack. Pick a source, press keys — the resolved device and command always show before you send.</p>
    </div>
    <div class="view-actions">
      <div class="segmented" role="group" aria-label="Control mode">
        <button type="button" data-mode="activities" aria-pressed="true">Activities</button>
        <button type="button" data-mode="devices" aria-pressed="false">Devices</button>
      </div>
      <button type="button" class="btn btn-danger" data-act="poweroff" id="ctrlPowerOff" disabled>Power off</button>
    </div>
  </div>
  <section class="now-strip" id="ctrlNowStrip" aria-label="Now running">
    <div class="now-main">
      <span class="eyebrow" id="ctrlNowEyebrow">Now running</span>
      <h3 class="now-name" id="ctrlNowName">Reading hub state…</h3>
      <p class="now-meta mono" id="ctrlNowMeta"></p>
    </div>
  </section>
  <p class="remote-status" id="remoteStatus" role="status" aria-live="polite">
    <span id="statusTarget" class="status-target">Pick a key</span>
    <span id="statusNote" class="status-note">resolved device and command show here</span>
  </p>
  <div class="control-grid">
    <aside class="panel control-src" aria-label="Source list">
      <div class="panel-head"><h3 id="srcTitle">Activities</h3><span class="mono muted" id="srcMeta"></span></div>
      <div id="srcList" class="src-list"></div>
    </aside>
    <div class="control-remotecol">
      <div class="remote-wrap">
        <div class="ir-remote-card">
          <div class="ir-remote-shell">
            <div class="ir-remote-skin" id="remoteBody" role="group" aria-label="Harmony remote">
              <img src="${SKIN_SRC}" alt="Harmony remote control layout" width="591" height="1280" draggable="false">
            </div>
          </div>
          <p class="remote-help muted">Same skin and button map as the hub IR Control page. Hover or tap a key to see what it sends; unmapped keys stay quiet.</p>
        </div>
        <div class="chip-grid" id="softChips" aria-label="Soft menu buttons not on the hard remote"></div>
      </div>
    </div>
    <div class="control-side">
      <details class="panel commands-panel" id="commandsPanel">
        <summary>
          <span class="commands-title">All commands</span>
          <span class="mono muted" id="resolveMeta"></span>
        </summary>
        <div class="commands-body">
          <p class="mini muted" id="commandsHint">Each row sends immediately to the hub (IR or Bluetooth) — not a preview.</p>
          <div id="resolveList" class="resolve-list"></div>
        </div>
      </details>
      <details class="panel inspector" id="inspector">
        <summary>
          <span class="inspector-title">Send log</span>
        </summary>
        <div class="inspector-body">
          <div class="inspector-actions">
            <button type="button" class="btn btn-quiet btn-sm" data-act="refresh">Refresh state</button>
            <button type="button" class="btn btn-quiet btn-sm" data-act="clearlog">Clear log</button>
          </div>
          <ol id="sendLog" class="send-log"><li class="send-hint">Press a key — sends appear here.</li></ol>
        </div>
      </details>
    </div>
  </div>`;

export function createControlView(section) {
  let mode = "activities";
  let selectedActivityId = "";
  let selectedDeviceId = "";
  let resolutions = []; // index -> action | null
  let softButtons = []; // { label, action }
  let lastStatus = null;
  let mounted = false;
  let els;

  /* -- long-press bookkeeping ------------------------------------ */
  let holdTimer = null;
  let holdFired = false;
  let suppressClick = false;

  function mount() {
    if (mounted) return;
    mounted = true;
    section.innerHTML = TEMPLATE;
    els = {
      powerOff: section.querySelector("#ctrlPowerOff"),
      nowStrip: section.querySelector("#ctrlNowStrip"),
      nowEyebrow: section.querySelector("#ctrlNowEyebrow"),
      nowName: section.querySelector("#ctrlNowName"),
      nowMeta: section.querySelector("#ctrlNowMeta"),
      srcTitle: section.querySelector("#srcTitle"),
      srcMeta: section.querySelector("#srcMeta"),
      srcList: section.querySelector("#srcList"),
      body: section.querySelector("#remoteBody"),
      chips: section.querySelector("#softChips"),
      statusTarget: section.querySelector("#statusTarget"),
      statusNote: section.querySelector("#statusNote"),
      resolveList: section.querySelector("#resolveList"),
      resolveMeta: section.querySelector("#resolveMeta"),
      commandsHint: section.querySelector("#commandsHint"),
      log: section.querySelector("#sendLog"),
      segmented: section.querySelector(".segmented"),
      commandsPanel: section.querySelector("#commandsPanel"),
      inspector: section.querySelector("#inspector"),
    };
    applyCommandsPanelOpen();
    els.commandsPanel.addEventListener("toggle", () => {
      localStorage.setItem("hhc.commands", els.commandsPanel.open ? "open" : "closed");
      /* Finish migration off the old Inspector key once the user chooses. */
      localStorage.removeItem("hhc.inspector");
    });
    if (localStorage.getItem("hhc.sendlog") === "open") els.inspector.open = true;
    els.inspector.addEventListener("toggle", () => {
      localStorage.setItem("hhc.sendlog", els.inspector.open ? "open" : "closed");
    });
    buildKeys();
    wire();
    hub.subscribe(renderAll);
    renderAll();
  }

  function applyCommandsPanelOpen() {
    els.commandsPanel.open = commandsPanelShouldOpen({
      mode,
      commandsPref: localStorage.getItem("hhc.commands"),
      legacyInspectorPref: localStorage.getItem("hhc.inspector"),
    });
  }

  function buildKeys() {
    const frag = document.createDocumentFragment();
    REMOTE_BUTTONS.forEach((b, i) => {
      const el = document.createElement("button");
      el.type = "button";
      el.className = "remote-hotspot disabled";
      el.dataset.index = String(i);
      el.style.left = `${b.x}%`;
      el.style.top = `${b.y}%`;
      el.style.width = `${b.w}%`;
      el.style.height = `${b.h}%`;
      el.disabled = true;
      el.setAttribute("aria-label", `${b.label} — not mapped`);
      el.title = b.label;
      frag.appendChild(el);
    });
    els.body.appendChild(frag);
  }

  function wire() {
    els.segmented.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-mode]");
      if (btn) setMode(btn.dataset.mode);
    });

    section.addEventListener("click", (e) => {
      const act = e.target.closest("[data-act]")?.dataset.act;
      if (act === "refresh") refresh();
      else if (act === "poweroff") powerOff();
      else if (act === "clearlog") els.log.innerHTML = "";
      const run = e.target.closest("[data-run]");
      if (run) {
        if (mode === "activities") {
          selectedActivityId = run.dataset.run;
          applyMapping();
          renderSrcList();
        }
        runActivity(run.dataset.run);
      }
      const select = e.target.closest("[data-select]");
      if (select) {
        if (mode === "activities") selectedActivityId = select.dataset.select;
        else selectedDeviceId = select.dataset.select;
        applyMapping();
        renderSrcList();
      }
      const soft = e.target.closest("[data-soft]");
      if (soft) {
        const entry = softButtons[Number(soft.dataset.soft)];
        if (entry) sendAction(entry.action, entry.label, soft);
      }
      const resolve = e.target.closest("[data-resolve]");
      if (resolve && !resolve.disabled) {
        const r = resolutions[Number(resolve.dataset.resolve)];
        if (r) sendAction(r, REMOTE_BUTTONS[Number(resolve.dataset.resolve)].label);
      }
      const command = e.target.closest("[data-command]");
      if (command) {
        const device = hub.deviceById(selectedDeviceId);
        const cmd = device?.commands[Number(command.dataset.command)];
        if (cmd) sendAction({ deviceId: device.id, command: cmd.name, functionId: cmd.functionId }, cmd.name);
      }
      const retry = e.target.closest("[data-retry]");
      if (retry) hub.reloadConfig();
    });

    els.body.addEventListener("pointerdown", (e) => {
      const el = e.target.closest(".remote-hotspot");
      if (!el || el.disabled) return;
      const r = resolutions[Number(el.dataset.index)];
      if (!r) return;
      suppressClick = true;
      holdFired = false;
      if (r.hold) {
        el.setPointerCapture?.(e.pointerId);
        holdTimer = setTimeout(() => {
          holdFired = true;
          el.classList.add("is-holding");
          sendAction(r.hold, `${REMOTE_BUTTONS[Number(el.dataset.index)].label} (held)`, el);
        }, HOLD_MS);
      }
    });

    const release = () => {
      clearTimeout(holdTimer);
      holdTimer = null;
      els.body.querySelectorAll(".remote-hotspot.is-holding").forEach((k) => k.classList.remove("is-holding"));
    };
    els.body.addEventListener("pointerup", (e) => {
      const el = e.target.closest(".remote-hotspot");
      release();
      if (!el || el.disabled || holdFired) return;
      const r = resolutions[Number(el.dataset.index)];
      if (r) sendAction(r, REMOTE_BUTTONS[Number(el.dataset.index)].label, el);
    });
    els.body.addEventListener("pointercancel", release);
    els.body.addEventListener("pointerleave", () => {
      if (holdTimer) release();
    });

    els.body.addEventListener("click", (e) => {
      if (suppressClick) {
        suppressClick = false;
        return;
      }
      const el = e.target.closest(".remote-hotspot");
      if (!el || el.disabled) return;
      const r = resolutions[Number(el.dataset.index)];
      if (r) sendAction(r, REMOTE_BUTTONS[Number(el.dataset.index)].label, el);
    });

    const preview = (el) => {
      const r = el && resolutions[Number(el.dataset.index)];
      if (!r) return;
      setStatus(`${hub.deviceName(r.deviceId)} · ${r.command}`, "will send", "");
    };
    els.body.addEventListener("pointerover", (e) => preview(e.target.closest(".remote-hotspot")));
    els.body.addEventListener("focusin", (e) => preview(e.target.closest(".remote-hotspot")));
    const restore = () => {
      if (lastStatus) setStatus(lastStatus.target, lastStatus.note, lastStatus.cls);
      else setStatus("Pick a key", "resolved device and command show here", "");
    };
    els.body.addEventListener("pointerout", (e) => {
      if (!els.body.contains(e.relatedTarget)) restore();
    });
    els.body.addEventListener("focusout", (e) => {
      if (!els.body.contains(e.relatedTarget)) restore();
    });
  }

  /* -- mapping ------------------------------------------------------ */

  function primaryMap(activityId) {
    let best = null;
    let bestCount = -1;
    for (const map of hub.buttonMapsForActivity(activityId)) {
      const count = (map.Buttons ?? []).filter((b) => b.ButtonKey).length;
      if (count > bestCount) {
        best = map;
        bestCount = count;
      }
    }
    return best;
  }

  function actionFromEntry(entry) {
    const a = entry.ButtonAction;
    if (!a?.CommandName) return null;
    return {
      deviceId: String(a["DeviceId-"]),
      command: a.CommandName,
      functionId: a["FunctionId-"],
      buttonKey: entry.ButtonKey ?? null,
    };
  }

  function applyMapping() {
    resolutions = REMOTE_BUTTONS.map(() => null);
    softButtons = [];

    if (mode === "activities") {
      const map = primaryMap(selectedActivityId);
      const seen = new Set();
      for (const entry of map?.Buttons ?? []) {
        const action = actionFromEntry(entry);
        if (!action) continue;
        if (entry.ButtonKey) {
          const index = REMOTE_BUTTONS.findIndex((b) =>
            aliasMatch(commandKey(entry.ButtonKey), b.aliases));
          if (index !== -1 && !resolutions[index]) {
            const holdEntry = entry.ButtonLongPressAction?.CommandName
              ? {
                  deviceId: String(entry.ButtonLongPressAction["DeviceId-"]),
                  command: entry.ButtonLongPressAction.CommandName,
                  functionId: entry.ButtonLongPressAction["FunctionId-"],
                  buttonKey: entry.ButtonKey,
                }
              : null;
            resolutions[index] = { ...action, hold: holdEntry };
          }
        } else {
          const key = `${action.deviceId}:${action.command}`;
          if (!seen.has(key) && softButtons.length < SOFT_MAX) {
            seen.add(key);
            softButtons.push({ label: entry.TextOnRemote || action.command, action });
          }
        }
      }
    } else {
      const device = hub.deviceById(selectedDeviceId);
      REMOTE_BUTTONS.forEach((b, i) => {
        const cmd = matchCommand(device?.commands, b.aliases);
        if (cmd) {
          resolutions[i] = {
            deviceId: device.id,
            command: cmd.name,
            functionId: cmd.functionId,
            buttonKey: null,
            hold: null,
          };
        }
      });
    }
    renderKeys();
    renderChips();
    renderResolve();
  }

  function renderKeys() {
    els.body.querySelectorAll(".remote-hotspot").forEach((el) => {
      const i = Number(el.dataset.index);
      const b = REMOTE_BUTTONS[i];
      const r = resolutions[i];
      if (r) {
        el.disabled = false;
        el.classList.remove("disabled");
        el.classList.toggle("has-hold", Boolean(r.hold));
        el.title = `${b.label} → ${hub.deviceName(r.deviceId)} · ${r.command}`;
        el.setAttribute(
          "aria-label",
          `${b.label} — ${hub.deviceName(r.deviceId)} ${r.command}` +
            (r.hold ? ` (hold: ${r.hold.command})` : ""));
      } else {
        el.disabled = true;
        el.classList.add("disabled");
        el.classList.remove("has-hold");
        el.title = `${b.label} (not mapped)`;
        el.setAttribute("aria-label", `${b.label} — not mapped`);
      }
    });
  }

  function renderChips() {
    els.chips.innerHTML = softButtons
      .map(
        (s, i) =>
          `<button type="button" class="chip" data-soft="${i}" title="${escapeHtml(`${hub.deviceName(s.action.deviceId)} · ${s.action.command}`)}">${escapeHtml(s.label)}</button>`)
      .join("");
  }

  function renderResolve() {
    if (mode === "devices") {
      const device = hub.deviceById(selectedDeviceId);
      els.resolveMeta.textContent = device ? `${device.commands.length} commands` : "";
      if (!device?.commands.length) {
        els.resolveList.innerHTML = `<div class="resolve-empty">No commands for this device.</div>`;
        return;
      }
      els.resolveList.innerHTML = device.commands
        .map((cmd, i) => {
          const keyIndex = REMOTE_BUTTONS.findIndex((b) =>
            aliasMatch(commandKey(cmd.name), b.aliases));
          const target = keyIndex !== -1 ? `on remote: ${REMOTE_BUTTONS[keyIndex].label}` : "not on remote skin";
          return `<button type="button" class="resolve-row" data-command="${i}" title="Send ${escapeHtml(cmd.name)} now">
            <span class="resolve-key">${escapeHtml(cmd.name)}</span>
            <span class="resolve-target">${escapeHtml(target)} · tap to send</span>
          </button>`;
        })
        .join("");
      return;
    }

    const mapped = resolutions
      .map((r, i) => ({ r, i }))
      .filter(({ r }) => r);
    els.resolveMeta.textContent = `${mapped.length}/${REMOTE_BUTTONS.length} mapped`;
    if (!mapped.length) {
      els.resolveList.innerHTML = `<div class="resolve-empty">No buttons mapped for this activity yet. Map keys in the <a href="#activities">Activities editor</a>.</div>`;
      return;
    }
    els.resolveList.innerHTML = mapped
      .map(({ r, i }) =>
        `<button type="button" class="resolve-row" data-resolve="${i}" title="Send now">
          <span class="resolve-key">${escapeHtml(REMOTE_BUTTONS[i].label)}</span>
          <span class="resolve-target">${escapeHtml(`${hub.deviceName(r.deviceId)} · ${r.command}${r.hold ? ` · hold: ${r.hold.command}` : ""}`)}</span>
        </button>`)
      .join("");
  }

  /* -- source list ----------------------------------------------------- */

  function renderSrcList() {
    els.srcTitle.textContent = mode === "activities" ? "Activities" : "Devices";
    const s = hub.state;

    if (!s.configLoaded) {
      els.srcMeta.textContent = "";
      els.srcList.innerHTML = `<div class="state-block"><div class="skel" style="width:80%"></div><div class="skel"></div><div class="skel" style="width:65%"></div></div>`;
      return;
    }
    if (s.configError) {
      els.srcMeta.textContent = "";
      els.srcList.innerHTML = `<div class="state-block">
        <span class="state-title">Could not load hub config</span>
        ${escapeHtml(s.configError.message)}
        <div style="margin-top:var(--space-3)"><button type="button" class="btn btn-secondary btn-sm" data-retry>Retry</button></div>
      </div>`;
      return;
    }

    if (mode === "activities") {
      const acts = hub.activities();
      els.srcMeta.textContent = `${acts.length} in ActivityList`;
      if (!acts.length) {
        els.srcList.innerHTML = `<div class="state-block">No activities in this hub config.</div>`;
        return;
      }
      els.srcList.innerHTML = acts
        .map((a) => {
          const id = String(a["Id-"]);
          const live = s.currentId === id;
          const selected = selectedActivityId === id;
          return `<div class="src-row${selected ? " is-selected" : ""}${live ? " is-live" : ""}">
            <span class="src-order mono">${String(a.ActivityOrder ?? 0).padStart(2, "0")}</span>
            <button type="button" class="src-main" data-select="${escapeHtml(id)}" title="${escapeHtml(`${hub.activityName(a)} · ${hub.activityTypeLabel(a)} · ${id}`)}">
              <span class="src-name">${escapeHtml(hub.activityName(a))}</span>
              <span class="src-meta mono">${escapeHtml(`${hub.activityTypeLabel(a)} · ${id}`)}</span>
            </button>
            <span class="src-side">${
              live
                ? `<span class="pill pill-live"><span class="live-dot" aria-hidden="true"></span>On air</span>`
                : `<button type="button" class="btn btn-quiet btn-sm" data-run="${escapeHtml(id)}">Run</button>`
            }</span>
          </div>`;
        })
        .join("");
      return;
    }

    const devs = hub.devices();
    els.srcMeta.textContent = `${devs.length} devices`;
    if (!devs.length) {
      els.srcList.innerHTML = `<div class="state-block">No devices in this hub config.</div>`;
      return;
    }
    els.srcList.innerHTML = devs
      .map((d) =>
        `<button type="button" class="src-row${selectedDeviceId === d.id ? " is-selected" : ""}" data-select="${escapeHtml(d.id)}" aria-pressed="${selectedDeviceId === d.id}">
          <span class="src-order mono">${d.commands.length}</span>
          <span class="src-main">
            <span class="src-name">${escapeHtml(d.name)}</span>
            <span class="src-meta mono">${escapeHtml(`${d.manufacturer || "Unknown"} · ${d.commands.length} commands`)}</span>
          </span>
        </button>`)
      .join("");
  }

  /* -- status + log ------------------------------------------------------ */

  function setStatus(target, note, cls) {
    els.statusTarget.textContent = target;
    els.statusNote.textContent = note;
    els.statusNote.className = `status-note${cls ? ` ${cls}` : ""}`;
    if (cls !== "") lastStatus = { target, note, cls };
  }

  function addLog(target, note, cls) {
    els.log.querySelector(".send-hint")?.remove();
    const li = document.createElement("li");
    const time = new Date().toLocaleTimeString([], { hour12: false });
    li.innerHTML = `<span class="send-time mono">${time}</span>
      <span class="send-target">${escapeHtml(target)}</span>
      <span class="send-note ${cls}">${escapeHtml(note)}</span>`;
    els.log.prepend(li);
    while (els.log.children.length > LOG_MAX) els.log.lastChild.remove();
  }

  function flash(el) {
    if (!el) return;
    el.classList.add("is-sending");
    setTimeout(() => el.classList.remove("is-sending"), 220);
  }

  /* -- sending -------------------------------------------------------------- */

  async function sendAction(action, label, el) {
    const target = `${hub.deviceName(action.deviceId)} · ${action.command}`;
    flash(el);
    setStatus(target, "sending…", "");
    const { note, cls } = await directIr(action, "sent");
    setStatus(`${label} → ${target}`, note, cls);
    addLog(target, note, cls);
  }

  async function directIr(action, okNote) {
    try {
      await api.irSend({
        deviceId: action.deviceId,
        command: action.command,
        functionId: action.functionId,
        activityId: mode === "activities" ? selectedActivityId : undefined,
      });
      return { note: okNote, cls: "is-ok" };
    } catch (error) {
      if (error instanceof api.ApiError && error.status > 0) {
        return { note: error.message || `HTTP ${error.status}`, cls: "is-err" };
      }
      const message =
        error instanceof api.ApiError
          ? error.message
          : error?.message || "network error";
      return { note: message, cls: "is-local" };
    }
  }

  async function runActivity(id) {
    const name = hub.activityName(hub.activityById(id));
    setStatus(name, "starting…", "");
    await hub.setRunning(id);
    if (hub.state.stateError) {
      const msg = hub.state.stateError.message || "run failed";
      setStatus(name, msg, "is-err");
      addLog(`Start · ${name}`, msg, "is-err");
      return;
    }
    setStatus(name, "started", "is-ok");
    addLog(`Start · ${name}`, "run", "is-ok");
  }

  async function powerOff() {
    setStatus("Everything is off", "powering down…", "");
    await hub.setRunning(-1);
    if (hub.state.stateError) {
      const msg = hub.state.stateError.message || "power off failed";
      setStatus("Power off", msg, "is-err");
      addLog("Power off · all devices", msg, "is-err");
      return;
    }
    setStatus("Everything is off", "powered down", "is-ok");
    addLog("Power off · all devices", "run", "is-ok");
  }

  async function refresh() {
    els.statusNote.textContent = "reading hub state…";
    await hub.refreshState();
  }

  /* -- mode / lifecycle ------------------------------------------------------- */

  function ensureSelection() {
    const acts = hub.activities();
    if (acts.length) {
      const live = acts.find((a) => String(a["Id-"]) === hub.state.currentId);
      if (!selectedActivityId || !acts.some((a) => String(a["Id-"]) === selectedActivityId)) {
        selectedActivityId = String((live ?? acts[0])["Id-"]);
      }
    } else {
      selectedActivityId = "";
    }
    const devs = hub.devices();
    if (devs.length) {
      if (!selectedDeviceId || !devs.some((d) => d.id === selectedDeviceId)) {
        selectedDeviceId = devs[0].id;
      }
    } else {
      selectedDeviceId = "";
    }
  }

  function setMode(next) {
    if (mode === next) return;
    mode = next;
    els.segmented.querySelectorAll("[data-mode]").forEach((b) =>
      b.setAttribute("aria-pressed", String(b.dataset.mode === mode)));
    applyCommandsPanelOpen();
    if (els.commandsHint) {
      els.commandsHint.textContent =
        mode === "devices"
          ? "Every command on this device. Each row sends immediately (IR or Bluetooth) — not a preview."
          : "Mapped remote keys for this activity. Each row sends immediately — not a preview.";
    }
    renderAll();
  }

  function renderNow() {
    if (!els.nowName) return;
    const id = hub.state.currentId;
    const running = id && id !== "-1";
    if (els.powerOff) els.powerOff.disabled = !running;
    if (!id) {
      els.nowEyebrow.textContent = "Now running";
      els.nowName.textContent = hub.state.stateError ? "State unavailable" : "Nothing running yet";
      els.nowMeta.textContent = hub.state.stateError?.message || "Start an activity from the list, or leave PowerOff as-is.";
      els.nowStrip?.classList.remove("is-live", "is-off");
      return;
    }
    if (id === "-1") {
      els.nowEyebrow.textContent = "Power";
      els.nowName.textContent = "Everything is off";
      els.nowMeta.textContent = "PowerOff is active";
      els.nowStrip?.classList.add("is-off");
      els.nowStrip?.classList.remove("is-live");
      return;
    }
    const activity = hub.activityById(id);
    els.nowEyebrow.textContent = "Now running";
    els.nowName.textContent = hub.activityName(activity);
    els.nowMeta.textContent = `${hub.activityTypeLabel(activity)} · ${id}`;
    els.nowStrip?.classList.add("is-live");
    els.nowStrip?.classList.remove("is-off");
  }

  function renderAll() {
    if (!mounted) return;
    ensureSelection();
    renderNow();
    renderSrcList();
    applyMapping();
  }

  mount();

  return {
    onShow(params) {
      const nextMode = params?.mode === "devices" ? "devices" : "activities";
      section.setAttribute("aria-label", nextMode === "devices" ? "Device remote" : "Activity remote");
      if (nextMode !== mode) setMode(nextMode);
      else renderAll();
    },
    onHide() {},
  };
}
