/* Activity buttons (#activitybuttons, from Settings → Remotes): the Harmony
   Smart Control's three activity buttons, each starting one activity on a
   press and another on a long press (16414Root). Saved through
   /api/activity-save; models in remotes-model.js. */

import * as hub from "../state.js";
import { confirmDialog, escapeHtml, setAppBar, snackbar, spinner } from "../ui/shell.js";
import {
  activityButtonsSaveOutcome,
  buildActivityButtonsMapList,
  readActivityButtons,
} from "./remotes-model.js";
import { saveMapList } from "./map-save.js";

export function createActivityButtonsView(section) {
  let rows = null; // draft
  let baseRows = null;
  let dirty = false;
  let saving = false;

  section.innerHTML = `<div class="page" id="activityButtonsRoot"></div>`;
  const root = section.querySelector("#activityButtonsRoot");

  // A button left on a deleted activity needs a save even when nothing was picked.
  const needsSave = () => dirty || Boolean(rows?.some((r) => r.missing.length));

  function updateBar() {
    if (!section.hidden) setAppBar({ title: "Activity buttons", back: "remotes" });
  }

  function activityOptions(selected) {
    const acts = hub.activities();
    const known = acts.some((a) => String(a["Id-"]) === selected);
    return [
      `<option value=""${selected === "" ? " selected" : ""}>Nothing</option>`,
      selected && !known ? `<option value="${escapeHtml(selected)}" selected>Deleted activity</option>` : "",
      ...acts.map((a) => {
        const id = String(a["Id-"]);
        return `<option value="${escapeHtml(id)}"${id === selected ? " selected" : ""}>${escapeHtml(hub.activityName(a))}</option>`;
      }),
    ].join("");
  }

  function buttonSelect(row, field) {
    const value = row[field];
    const label = `${row.label} ${field === "press" ? "press" : "long press"}`;
    if (value === null) {
      return `<select aria-label="${escapeHtml(label)}" disabled><option>Set elsewhere (kept)</option></select>`;
    }
    return `<select aria-label="${escapeHtml(label)}" data-key="${row.key}" data-field="${field}"${saving ? " disabled" : ""}>${activityOptions(value)}</select>`;
  }

  function render() {
    if (section.hidden) return;
    updateBar();
    if (!hub.state.config) {
      root.innerHTML = hub.state.configError
        ? `<p class="list-note">Can't reach your hub: ${escapeHtml(hub.state.configError.message || "no answer")}.</p>`
        : `<div class="m-center">${spinner("Loading")}</div>`;
      return;
    }
    if (!rows) {
      baseRows = readActivityButtons(hub.state.config).rows;
      rows = structuredClone(baseRows);
    }
    const missing = rows.some((r) => r.missing.length);
    root.innerHTML = `<div class="m-card">
        <div class="m-card-head"><span>Harmony Smart Control remote</span></div>
        <p class="list-note">Each button starts one activity on a press and another on a long press. Off turns everything off by itself.</p>
        ${missing ? `<div class="notice notice-warn" role="status">A button still names an activity that was deleted. Saving sets it to Nothing, or pick another activity first.</div>` : ""}
        <div class="remotes-buttons" role="group" aria-label="Activity buttons">
          <span class="remotes-buttons-head">Button</span><span class="remotes-buttons-head">Press</span><span class="remotes-buttons-head">Long press</span>
          ${rows.map((row) => `<span class="remotes-buttons-key">${escapeHtml(row.label)}</span>${buttonSelect(row, "press")}${buttonSelect(row, "longPress")}`).join("")}
        </div>
        <div class="actions">
          <button type="button" class="btn btn-text" data-act="undo"${!dirty || saving ? " disabled" : ""}>Undo</button>
          <button type="button" class="btn btn-filled" data-act="save"${!needsSave() || saving ? " disabled" : ""}>${saving ? "Saving…" : "Save"}</button>
        </div>
      </div>`;
  }

  async function save() {
    if (saving || !needsSave()) return;
    let built;
    try {
      built = buildActivityButtonsMapList(hub.state.config, rows);
    } catch (error) {
      snackbar(`Not saved — ${error.message}`, { error: true });
      return;
    }
    if (!built.changed) {
      dirty = false;
      render();
      return;
    }
    const draft = { rows, baseRows, dirty };
    saving = true;
    render();
    const result = await saveMapList(built.mapList, {
      done: "Saved. The Smart Control uses the new buttons at once.",
      check: (config) => activityButtonsSaveOutcome(config, draft.baseRows, draft.rows),
    });
    saving = false;
    if (result === "kept") ({ rows, baseRows, dirty } = draft);
    else {
      rows = null;
      dirty = false;
    }
    render();
  }

  root.addEventListener("change", (event) => {
    const select = event.target.closest("select[data-key]");
    if (!select) return;
    const row = rows.find((r) => r.key === select.dataset.key);
    if (!row) return;
    row[select.dataset.field] = select.value;
    row.missing = [row.press, row.longPress].filter((id) => id && !hub.activityById(id));
    dirty = rows.some((r, i) => r.press !== baseRows[i].press || r.longPress !== baseRows[i].longPress);
    render();
  });

  root.addEventListener("click", (event) => {
    const act = event.target.closest("[data-act]")?.dataset.act;
    if (act === "save") save();
    else if (act === "undo") {
      rows = structuredClone(baseRows);
      dirty = false;
      render();
    }
  });

  hub.subscribe(() => {
    if (!dirty && !saving) rows = null;
    render();
  });

  return {
    onShow() {
      if (!dirty) rows = null;
      hub.ensureConfig();
      render();
    },
    onHide() {},
    async confirmLeave() {
      if (saving) {
        snackbar("Saving to the hub… one moment");
        return false;
      }
      if (!dirty) return true;
      const leave = await confirmDialog({
        title: "Discard your changes?",
        text: "The activity buttons you changed aren't saved.",
        confirmLabel: "Discard",
        destructive: true,
      });
      if (leave) dirty = false;
      return leave;
    },
  };
}
