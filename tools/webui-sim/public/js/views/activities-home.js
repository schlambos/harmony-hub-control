/* Activities tab (#activities): the app's ActivitiesScreen. The running
   activity sits in a card with Open remote and Turn off; every other
   activity is a row with Start and a ⋮ menu (edit, set up buttons, the
   Touch's on-screen buttons, try the buttons, the advanced editor, reorder,
   delete). Setup goes through the
   wizard (#wizard). */

import * as hub from "../state.js";
import { deleteActivityGraph, reorderActivityGraph } from "../wizard-model.js";
import {
  confirmDialog,
  escapeHtml,
  icon,
  iconTile,
  openMenu,
  screenTitle,
  sectionLabel,
  snackbar,
  spinner,
  statusDot,
  vibrate,
} from "../ui/shell.js";
import { activityIconName, activityKeys, deviceNamesFor } from "./remote-model.js";

/* Fewer keys than this and the row warns, as the app does. */
const FEW_BUTTONS = 5;

export function createActivitiesHomeView(section) {
  let shown = "";
  let busy = false; // a delete or reorder is saving
  let counted = null; // the config the button counts below were made from
  let counts = new Map();

  section.innerHTML = `<div class="page" id="activitiesRoot"></div>`;
  const root = section.querySelector("#activitiesRoot");

  /* -- markup ------------------------------------------------------------------ */

  /* Keys an activity maps, counted once per loaded config: the list redraws
     on every state change, the maps only change with the config. */
  function buttonCount(id) {
    if (counted !== hub.state.config) {
      counted = hub.state.config;
      counts = new Map();
    }
    if (!counts.has(id)) counts.set(id, activityKeys(hub.state.config, id).size);
    return counts.get(id);
  }

  function hubLine() {
    const s = hub.state;
    let text = "Hub · connected";
    if (!s.configLoaded) text = "Hub · connecting…";
    else if (s.configError) text = "Hub · not connected";
    else if (!s.reachable) text = "Hub · not answering";
    const ok = s.configLoaded && !s.configError && s.reachable;
    return `<p class="m-title-sub">${statusDot(ok)}<span>${text}</span></p>`;
  }

  function titleMarkup() {
    return screenTitle("Activities", {
      subtitle: hubLine(),
      action: `<a class="icon-btn icon-btn-secondary" href="#wizard" aria-label="New activity" title="New activity">${icon("add")}</a>`,
    });
  }

  function runningCard(a, devices) {
    const id = String(a["Id-"]);
    const name = hub.activityName(a);
    const turningOff = hub.state.pendingId === "-1";
    return `<section class="run-card" aria-label="Running now">
        <div class="run-card-head">
          ${iconTile(activityIconName(a), { size: 52, tone: "primary" })}
          <div class="run-card-text">
            <p class="run-card-over">Running now</p>
            <h3 class="run-card-name">${escapeHtml(name)}</h3>
            <p class="run-card-meta">${escapeHtml(deviceNamesFor(a, devices).join(" · "))}</p>
          </div>
          <a class="icon-btn" href="#touch/${encodeURIComponent(id)}" aria-label="On-screen buttons for ${escapeHtml(name)}" title="On-screen buttons">${icon("tune_outlined")}</a>
          <a class="icon-btn" href="#wizard/${encodeURIComponent(id)}" aria-label="Edit ${escapeHtml(name)}" title="Edit">${icon("edit_outlined")}</a>
        </div>
        <div class="run-card-actions">
          <a class="btn btn-filled" href="#remote">${icon("settings_remote", { size: 20 })}Open remote</a>
          <button type="button" class="btn btn-danger" data-act="off"${turningOff ? " disabled" : ""}>
            ${turningOff ? spinner("Turning off") : icon("power_settings_new", { size: 20 })}Turn off
          </button>
        </div>
      </section>`;
  }

  function row(a, devices) {
    const id = String(a["Id-"]);
    const name = hub.activityName(a);
    const count = buttonCount(id);
    const meta = count < FEW_BUTTONS
      ? `<span class="act-row-warn">${icon("info_outlined", { size: 14 })}${count ? `Only ${count} button${count === 1 ? "" : "s"} set up` : "No buttons set up"}</span>`
      : `<span class="act-row-meta">${escapeHtml(deviceNamesFor(a, devices).join(" · ") || hub.activityTypeLabel(a))}</span>`;
    const start = hub.state.pendingId === id
      ? `<span class="act-row-busy">${spinner(`Starting ${name}`)}</span>`
      : `<button type="button" class="icon-btn icon-btn-raised" data-start="${escapeHtml(id)}" aria-label="Start ${escapeHtml(name)}" title="Start">${icon("play_arrow")}</button>`;
    return `<div class="act-row">
        ${iconTile(activityIconName(a), { size: 48, tone: "activity" })}
        <div class="act-row-text">
          <span class="act-row-name">${escapeHtml(name)}</span>
          ${meta}
        </div>
        ${start}
        <button type="button" class="icon-btn" data-menu-for="${escapeHtml(id)}" aria-haspopup="menu" aria-expanded="false" aria-label="More options for ${escapeHtml(name)}"${busy ? " disabled" : ""}>${icon("more_vert")}</button>
      </div>`;
  }

  function markup() {
    const s = hub.state;
    if (!s.configLoaded) return `${titleMarkup()}<div class="m-center">${spinner("Loading activities")}</div>`;
    if (s.configError) {
      return `${titleMarkup()}<div class="m-empty">
          ${iconTile("wifi_off", { size: 64, tone: "error" })}
          <h2 class="m-empty-title">Can't reach your hub</h2>
          <p class="m-empty-body">${escapeHtml(s.configError.message || "The hub didn't answer.")}</p>
          <button type="button" class="btn btn-filled" data-act="retry">Try again</button>
        </div>`;
    }
    const acts = hub.activities();
    if (!acts.length) {
      return `${titleMarkup()}<div class="m-empty">
          ${iconTile("play_arrow", { size: 64, tone: "activity" })}
          <h2 class="m-empty-title">No activities yet</h2>
          <p class="m-empty-body">An activity turns on the right devices and sets up the remote for you.</p>
          <a class="btn btn-filled" href="#wizard">Create an activity</a>
        </div>`;
    }
    const devices = hub.devices();
    const running = acts.find((a) => String(a["Id-"]) === s.currentId) ?? null;
    const others = acts.filter((a) => a !== running);
    const stateNote = s.stateError
      ? `<p class="act-note">${icon("info_outlined", { size: 16 })}<span>Couldn't read what's on: ${escapeHtml(s.stateError.message)}</span></p>`
      : "";
    return `${titleMarkup()}
      ${stateNote}
      <div class="acts">
        ${running ? runningCard(running, devices) : ""}
        ${running && others.length ? sectionLabel("Start something else", { muted: true }) : ""}
        ${others.map((a) => row(a, devices)).join("")}
      </div>`;
  }

  function render() {
    if (section.hidden) return;
    const html = markup();
    if (html === shown) return;
    // Rebuilding the list drops focus; put it back on the same control.
    const focused = document.activeElement;
    const keep = root.contains(focused)
      ? ["data-start", "data-menu-for", "data-act"].find((attr) => focused.hasAttribute(attr))
      : null;
    const keepValue = keep ? focused.getAttribute(keep) : "";
    shown = html;
    root.innerHTML = html;
    if (keep) root.querySelector(`[${keep}="${CSS.escape(keepValue)}"]`)?.focus();
  }

  /* -- actions ------------------------------------------------------------------- */

  async function start(id) {
    vibrate();
    location.hash = "#remote";
    await hub.setRunning(id);
    const err = hub.state.runError;
    if (err) snackbar(`Couldn't start ${hub.activityName(hub.activityById(id))} — ${err.message || "hub error"}`, { error: true });
  }

  async function turnOff() {
    vibrate();
    await hub.setRunning("-1");
    const err = hub.state.runError;
    if (err) snackbar(`Couldn't turn everything off — ${err.message || "hub error"}`, { error: true });
  }

  /* A delete or reorder writes the hub's whole setup; the latest copy is
     reloaded either way, so a refused save can simply be tried again. */
  async function mutate(fn, { done, failed }) {
    busy = true;
    render();
    try {
      await fn({ config: hub.state.config, revision: hub.state.config?.revision });
      if (done) snackbar(done);
    } catch (error) {
      snackbar(`${failed}: ${error.message || "hub error"}. The latest setup is reloaded; try again.`, { error: true });
    }
    busy = false;
    await hub.reloadConfig();
  }

  /* Reorder among the rows people see: the running activity sits in its card,
     so the neighbour may be two places away in the hub's order. The two
     activities swap; the running one keeps its place. */
  function neighbour(id, step) {
    const acts = hub.activities();
    const index = acts.findIndex((a) => String(a["Id-"]) === id);
    for (let i = index + step; i >= 0 && i < acts.length; i += step) {
      if (String(acts[i]["Id-"]) !== hub.state.currentId) return i - index;
    }
    return 0;
  }

  function move(id, step) {
    const direction = neighbour(id, step);
    if (!direction) return;
    mutate((ctx) => reorderActivityGraph({ ...ctx, id, direction }), { failed: "Couldn't save the new order" });
  }

  async function remove(id) {
    const name = hub.activityName(hub.activityById(id));
    const ok = await confirmDialog({
      title: `Delete “${name}”?`,
      text: "This removes the activity and its button setup from the hub and your universal remote.",
      confirmLabel: "Delete",
      destructive: true,
    });
    if (!ok) {
      root.querySelector(`[data-menu-for="${CSS.escape(id)}"]`)?.focus();
      return;
    }
    mutate((ctx) => deleteActivityGraph({ ...ctx, id }), { done: `Deleted “${name}”`, failed: `Couldn't delete “${name}”` });
  }

  function openRowMenu(anchor) {
    const id = anchor.dataset.menuFor;
    const name = hub.activityName(hub.activityById(id));
    const path = encodeURIComponent(id);
    openMenu({
      anchor,
      label: `Options for ${name}`,
      items: [
        { id: "edit", label: "Edit", icon: "edit_outlined" },
        { id: "buttons", label: "Set up buttons", icon: "tune_outlined" },
        { id: "touch", label: "On-screen buttons", icon: "tune_outlined" },
        { id: "try", label: "Try the buttons", icon: "settings_remote_outlined" },
        { id: "editor", label: "Advanced editor", icon: "build_outlined" },
        { id: "up", label: "Move up", icon: "keyboard_arrow_up", disabled: !neighbour(id, -1) },
        { id: "down", label: "Move down", icon: "keyboard_arrow_down", disabled: !neighbour(id, 1) },
        { id: "delete", label: "Delete", icon: "delete_outlined", destructive: true },
      ],
      onSelect: (choice) => {
        if (choice === "edit") location.hash = `#wizard/${path}`;
        else if (choice === "buttons") location.hash = `#wizard/${path}/buttons`;
        else if (choice === "touch") location.hash = `#touch/${path}`;
        else if (choice === "try") location.hash = `#remote/${path}`;
        else if (choice === "editor") location.hash = "#editor";
        else if (choice === "up") move(id, -1);
        else if (choice === "down") move(id, 1);
        else if (choice === "delete") remove(id);
      },
    });
  }

  /* -- events -------------------------------------------------------------------- */

  root.addEventListener("click", (event) => {
    const startBtn = event.target.closest("[data-start]");
    if (startBtn) {
      start(startBtn.dataset.start);
      return;
    }
    const menuBtn = event.target.closest("[data-menu-for]");
    if (menuBtn) {
      openRowMenu(menuBtn);
      return;
    }
    const act = event.target.closest("[data-act]")?.dataset.act;
    if (act === "off") turnOff();
    else if (act === "retry") hub.reloadConfig();
  });

  hub.subscribe(render);

  return {
    onShow() {
      shown = "";
      hub.ensureConfig();
      render();
    },
    onHide() {
      shown = "";
    },
  };
}
