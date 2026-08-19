/* Home view: what is on, one-tap start, hub status, recent sim events.
   Sim-only pieces (event log, /sim/ requests) stay gated on HARMONY_SIM so
   the production shell never touches a sim-only endpoint. */

import * as api from "../api.js";
import * as hub from "../state.js";
import { escapeHtml } from "../setup-kit.js";

const SIM = globalThis.HARMONY_SIM === true;

const TEMPLATE = `
  <div class="view-head">
    <div>
      <h2 id="title-home">Home</h2>
      <p class="view-lead">The rack at a glance — what is running, what can start, and what the sim has been doing.</p>
    </div>
    <div class="view-actions">
      <a class="btn btn-secondary" href="#control">Open remote</a>
    </div>
  </div>
  <section class="now-strip" id="nowStrip" aria-label="Now running">
    <div class="now-main">
      <span class="eyebrow" id="nowEyebrow">Now running</span>
      <h3 class="now-name" id="nowName">Reading hub state…</h3>
      <p class="now-meta mono" id="nowMeta"></p>
    </div>
    <div class="now-actions">
      <button type="button" class="btn btn-ghost" data-act="refresh">Refresh state</button>
      <button type="button" class="btn btn-danger" data-act="poweroff" id="nowPowerOff" disabled>Power off</button>
    </div>
  </section>
  <div class="dash-grid">
    <div class="dash-left">
      <section class="panel" aria-label="Activities">
        <div class="panel-head"><h3>Start an activity</h3><span class="mono muted" id="dashCount"></span></div>
        <div id="dashTiles" class="tile-grid stagger"></div>
      </section>
    </div>
    <div class="dash-right">
      <section class="panel" aria-label="Recent sim events">
        <div class="panel-head"><h3>Recent sim events</h3><button type="button" class="btn btn-quiet btn-sm" data-act="events">Refresh</button></div>
        <ol id="dashEvents" class="event-log"></ol>
      </section>
    </div>
  </div>
  <details class="hub-details" id="hubDetails">
    <summary class="sim-line mono" id="simLine">local hub</summary>
    <p class="mini muted mono" id="hubDetailsBody"></p>
  </details>`;

function eventTypeClass(kind) {
  const k = String(kind ?? "").toLowerCase();
  if (k.includes("run") || k.includes("start") || k.includes("state") || k.includes("reset")) {
    return "is-state";
  }
  if (k.includes("error") || k.includes("warn") || k.includes("reject")) return "is-error";
  return "";
}

function eventBadge(kind) {
  const k = String(kind ?? "").toLowerCase();
  if (k.includes("start") || k.includes("run")) return "run";
  if (k.includes("hold") || k.includes("button") || k.includes("ir")) return "key";
  if (k.includes("reset")) return "rst";
  if (k.includes("reject")) return "err";
  return (k || "sim").slice(0, 8);
}

function eventMessage(ev) {
  const k = String(ev?.kind ?? "").toLowerCase();
  if (k.includes("startactivity") || k.includes("run")) {
    if (ev.activityId === "-1") return "Start · Everything off";
    const name = hub.activityName(hub.activityById(ev.activityId));
    const rejected = k.includes("reject") ? " (rejected)" : "";
    return `Start · ${name}${rejected}`;
  }
  if (k.includes("hold") || k.includes("button")) {
    const held = ev.pressType && ev.pressType !== "press" ? ` (${ev.pressType})` : "";
    const status = ev.status && !ev.pressType ? ` · ${ev.status}` : "";
    return `${ev.buttonKey ?? ev.command ?? "Key"}${held}${status} → ${hub.deviceName(ev.deviceId)} · ${ev.command ?? "?"}`;
  }
  if (k.includes("reset")) return "Engine reset";
  return ev.message ?? ev.kind ?? "sim event";
}

export function createDashboardView(section) {
  let mounted = false;
  let els;

  function mount() {
    if (mounted) return;
    mounted = true;
    section.innerHTML = TEMPLATE;
    els = {
      strip: section.querySelector("#nowStrip"),
      eyebrow: section.querySelector("#nowEyebrow"),
      name: section.querySelector("#nowName"),
      meta: section.querySelector("#nowMeta"),
      powerOff: section.querySelector("#nowPowerOff"),
      count: section.querySelector("#dashCount"),
      tiles: section.querySelector("#dashTiles"),
      simLine: section.querySelector("#simLine"),
      hubDetailsBody: section.querySelector("#hubDetailsBody"),
      events: section.querySelector("#dashEvents"),
    };

    section.addEventListener("click", (e) => {
      const act = e.target.closest("[data-act]")?.dataset.act;
      if (act === "refresh") hub.refreshState();
      else if (act === "events") loadEvents();
      else if (act === "poweroff") hub.setRunning(-1);
      const run = e.target.closest("[data-run]");
      if (run) hub.setRunning(run.dataset.run);
      const retry = e.target.closest("[data-retry]");
      if (retry) hub.reloadConfig();
    });

    if (!SIM) {
      section.querySelector('[aria-label="Recent sim events"]')?.remove();
      const lead = section.querySelector(".view-lead");
      if (lead) lead.textContent = "The rack at a glance — what is running and what can start.";
    }

    hub.subscribe(renderHub);
    renderHub();
  }

  function renderHub() {
    const s = hub.state;
    renderNow(s);
    renderTiles(s);
    renderSimLine(s);
  }

  function renderNow(s) {
    const running = s.currentId && s.currentId !== "-1";
    const activity = running ? hub.activityById(s.currentId) : null;
    els.strip.classList.toggle("is-off", !running);
    if (running) {
      els.eyebrow.textContent = "Now running";
      els.name.textContent = activity ? hub.activityName(activity) : "Running activity";
      els.meta.textContent = activity ? hub.activityTypeLabel(activity) : "";
      if (els.meta) els.meta.title = `Activity id ${s.currentId}`;
      els.powerOff.disabled = false;
    } else if (s.currentId === "-1") {
      els.eyebrow.textContent = "Now running";
      els.name.textContent = "Everything is off";
      els.meta.textContent = "PowerOff is active";
      els.powerOff.disabled = true;
    } else {
      els.eyebrow.textContent = "Now running";
      els.name.textContent = "Nothing running yet";
      els.meta.textContent = s.stateError
        ? `Hub state unavailable: ${s.stateError.message}`
        : "Start an activity below or open the remote";
      els.powerOff.disabled = true;
    }
  }

  function renderTiles(s) {
    if (!s.configLoaded) {
      els.count.textContent = "";
      els.tiles.innerHTML = `<div class="state-block" style="grid-column:1/-1"><div class="skel" style="width:70%"></div><div class="skel"></div></div>`;
      return;
    }
    if (s.configError) {
      els.count.textContent = "";
      els.tiles.innerHTML = `<div class="state-block" style="grid-column:1/-1">
        <span class="state-title">Could not load hub config</span>
        ${escapeHtml(s.configError.message)}
        <div style="margin-top:var(--space-3)"><button type="button" class="btn btn-secondary btn-sm" data-retry>Retry</button></div>
      </div>`;
      return;
    }
    const acts = hub.activities();
    els.count.textContent = `${acts.length} activities`;
    if (!acts.length) {
      els.tiles.innerHTML = `<div class="state-block" style="grid-column:1/-1">No activities in this hub config. Add some in the Activities editor.</div>`;
      return;
    }
    els.tiles.innerHTML = acts
      .map((a, i) => {
        const id = String(a["Id-"]);
        const live = s.currentId === id;
        return `<div class="tile${live ? " is-live" : ""}" style="--i:${i}">
          <span class="tile-main">
            <span class="tile-name">${escapeHtml(hub.activityName(a))}</span>
            <span class="tile-meta">${escapeHtml(hub.activityTypeLabel(a))}</span>
          </span>
          ${
            live
              ? `<span class="pill pill-live"><span class="live-dot" aria-hidden="true"></span>On air</span>`
              : `<button type="button" class="btn btn-quiet btn-sm" data-run="${escapeHtml(id)}" title="${escapeHtml(`Start · id ${id}`)}">Start</button>`
          }
        </div>`;
      })
      .join("");
  }

  function renderSimLine(s) {
    const mode = SIM ? "sim" : "local hub";
    if (!s.configLoaded || s.configError) {
      els.simLine.textContent = `${mode} · config unavailable`;
      if (els.hubDetailsBody) els.hubDetailsBody.textContent = s.configError?.message || "Config not loaded.";
      return;
    }
    const c = hub.counts();
    els.simLine.textContent = `${mode} · ${c.activities} activities · ${c.devices} devices`;
    if (els.hubDetailsBody) {
      els.hubDetailsBody.textContent =
        `${c.buttonMaps} button maps · revision ${c.revision || "—"}` +
        (s.currentId ? ` · current activity id ${s.currentId}` : "");
    }
  }

  function eventsPanel() {
    return section.querySelector('[aria-label="Recent sim events"]');
  }

  async function loadEvents() {
    if (!SIM) return;
    const panel = eventsPanel();
    els.events.innerHTML = `<li><span class="ev-time mono">--:--:--</span><span class="ev-type">sim</span><span class="ev-msg">Loading events…</span></li>`;
    try {
      const [, payload] = await Promise.all([hub.ensureConfig(), api.getSimEvents()]);
      if (panel) panel.hidden = false;
      const events = payload?.events ?? [];
      if (!events.length) {
        els.events.innerHTML = `<li><span class="ev-time mono"></span><span class="ev-type">sim</span><span class="ev-msg">No events yet — press some keys in Control.</span></li>`;
        return;
      }
      els.events.innerHTML = events
        .slice()
        .reverse()
        .map((ev) => {
          const time = ev.ts
            ? new Date(ev.ts).toLocaleTimeString([], { hour12: false })
            : "--:--:--";
          return `<li>
            <span class="ev-time mono">${time}</span>
            <span class="ev-type ${eventTypeClass(ev.kind)}">${escapeHtml(eventBadge(ev.kind))}</span>
            <span class="ev-msg">${escapeHtml(eventMessage(ev))}</span>
          </li>`;
        })
        .join("");
    } catch (_) {
      if (panel) panel.hidden = true;
    }
  }

  mount();

  return {
    onShow() {
      renderHub();
      loadEvents();
    },
    onHide() {},
  };
}
