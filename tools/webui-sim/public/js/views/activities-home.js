/* Activities home: the remote's activity list for everyday use.
   Cards with run/edit/reorder/delete; setup always goes through the wizard.
   The vendored editor still exists at #editor for advanced fields. */

import * as hub from "../state.js";
import { deleteActivityGraph, reorderActivityGraph } from "../wizard-model.js";
import { setWizardEditId } from "./wizard.js";

const TEMPLATE = `
  <div class="view-head">
    <div>
      <h2 id="title-activities-home">Activities</h2>
      <p class="view-lead">Everything on the remote's screen. Run one, rework one, or set up a new one — setup is always guided.</p>
    </div>
    <div class="view-actions">
      <a class="btn btn-quiet" href="#editor">Advanced editor</a>
      <a class="btn btn-primary" href="#wizard">Set up a new activity</a>
    </div>
  </div>
  <p class="wiz-note" id="actNote" role="status" aria-live="polite"></p>
  <div id="actCards" class="act-list stagger"></div>`;

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

export function createActivitiesHomeView(section) {
  let mounted = false;
  let els;
  let confirmDeleteId = "";

  function mount() {
    if (mounted) return;
    mounted = true;
    section.innerHTML = TEMPLATE;
    els = {
      cards: section.querySelector("#actCards"),
      note: section.querySelector("#actNote"),
    };
    section.addEventListener("click", onClick);
    hub.subscribe(render);
  }

  function setNote(text, isError = false) {
    els.note.textContent = text;
    els.note.classList.toggle("is-error", isError);
  }

  function buttonsFor(id) {
    const maps = hub.buttonMapsForActivity(id);
    return maps.reduce((count, m) =>
      count + (m.Buttons ?? []).filter((b) => b.ButtonAction?.CommandName).length, 0);
  }

  function card(a, index, total) {
    const id = String(a["Id-"]);
    const live = hub.state.currentId === id;
    const name = hub.activityName(a);
    const kind = hub.activityTypeLabel(a);
    const deviceCount = new Set((a.Roles ?? []).map((r) => String(r["DeviceId-"]))).size;
    const buttonCount = buttonsFor(id);
    const meta = `${kind} · ${deviceCount} device${deviceCount === 1 ? "" : "s"} · ${buttonCount} button${buttonCount === 1 ? "" : "s"}`;

    if (confirmDeleteId === id) {
      return `<div class="act-card is-confirming" data-card="${id}">
        <div class="act-confirm">
          <p><strong>Delete “${escapeHtml(name)}”?</strong> Its button setup goes with it. This can't be undone.</p>
          <div class="act-confirm-actions">
            <button type="button" class="btn btn-danger btn-sm" data-del-yes="${id}">Delete it</button>
            <button type="button" class="btn btn-quiet btn-sm" data-del-no>Keep it</button>
          </div>
        </div>
      </div>`;
    }

    return `<div class="act-card${live ? " is-live" : ""}" data-card="${id}" style="--i:${index}">
      <button type="button" class="act-main" data-edit="${id}" title="Open “${escapeHtml(name)}” in the setup wizard">
        <span class="act-name">${escapeHtml(name)}</span>
        <span class="act-meta">${escapeHtml(meta)}</span>
      </button>
      <span class="act-side">
        ${live
          ? `<span class="pill pill-live"><span class="live-dot" aria-hidden="true"></span>On air</span>`
          : `<button type="button" class="btn btn-quiet btn-sm" data-run="${id}">Run</button>`}
        <button type="button" class="btn btn-quiet btn-sm" data-edit="${id}">Set up</button>
        <span class="act-order" role="group" aria-label="Reorder ${escapeHtml(name)}">
          <button type="button" class="act-order-btn" data-move="-1" data-id="${id}" ${index === 0 ? "disabled" : ""} aria-label="Move up">↑</button>
          <button type="button" class="act-order-btn" data-move="1" data-id="${id}" ${index === total - 1 ? "disabled" : ""} aria-label="Move down">↓</button>
        </span>
        <button type="button" class="btn btn-quiet btn-sm act-del" data-del="${id}" ${live ? "disabled title=\"Power off before deleting\"" : ""}>Delete</button>
      </span>
    </div>`;
  }

  function render() {
    if (!mounted) return;
    const s = hub.state;
    if (!s.configLoaded) {
      els.cards.innerHTML = `<div class="state-block"><div class="skel" style="width:70%"></div><div class="skel"></div><div class="skel" style="width:55%"></div></div>`;
      return;
    }
    if (s.configError) {
      els.cards.innerHTML = `<div class="state-block">
        <span class="state-title">Could not load hub config</span>
        ${escapeHtml(s.configError.message)}
        <div style="margin-top:var(--space-3)"><button type="button" class="btn btn-secondary btn-sm" data-retry>Retry</button></div>
      </div>`;
      return;
    }
    const acts = hub.activities();
    if (!acts.length) {
      els.cards.innerHTML = `<div class="state-block">
        <span class="state-title">No activities yet</span>
        Set up your first one — it takes about a minute.
        <div style="margin-top:var(--space-4)"><a class="btn btn-primary" href="#wizard">Set up a new activity</a></div>
      </div>`;
      return;
    }
    els.cards.innerHTML = acts.map((a, i) => card(a, i, acts.length)).join("");
  }

  async function mutate(fn, busyNote) {
    setNote(busyNote);
    try {
      await fn({
        config: hub.state.config,
        revision: hub.state.config?.revision,
      });
      await hub.reloadConfig();
      setNote("");
    } catch (error) {
      setNote(`${error.message} — reloaded the latest config; try again.`, true);
      await hub.reloadConfig();
    }
  }

  function onClick(e) {
    const retry = e.target.closest("[data-retry]");
    if (retry) {
      hub.reloadConfig();
      return;
    }
    const delNo = e.target.closest("[data-del-no]");
    if (delNo) {
      confirmDeleteId = "";
      render();
      return;
    }
    const delYes = e.target.closest("[data-del-yes]");
    if (delYes) {
      const id = delYes.dataset.delYes;
      confirmDeleteId = "";
      mutate((ctx) => deleteActivityGraph({ ...ctx, id }), "Deleting…");
      return;
    }
    const del = e.target.closest("[data-del]");
    if (del && !del.disabled) {
      confirmDeleteId = del.dataset.del;
      render();
      return;
    }
    const move = e.target.closest("[data-move]");
    if (move && !move.disabled) {
      const { id, move: dir } = move.dataset;
      mutate((ctx) => reorderActivityGraph({ ...ctx, id, direction: dir }), "Saving order…");
      return;
    }
    const run = e.target.closest("[data-run]");
    if (run) {
      hub.setRunning(run.dataset.run);
      return;
    }
    const edit = e.target.closest("[data-edit]");
    if (edit) {
      setWizardEditId(edit.dataset.edit);
      location.hash = "#wizard";
    }
  }

  mount();

  return {
    onShow() {
      confirmDeleteId = "";
      hub.ensureConfig();
      hub.refreshState();
      render();
    },
    onHide() {},
  };
}
