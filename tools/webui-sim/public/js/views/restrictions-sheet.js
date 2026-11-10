/* Time restrictions for one activity (Activities ⋮ menu): the times it can't
   be started. Each time is a set of days and a from–until range; the hub
   refuses a start inside one from every remote and app, and an activity that
   is already on when a time begins keeps running. Saving replaces the
   activity's whole list; an empty list lifts its restrictions. */

import { getActivityRestrictions, saveActivityRestrictions } from "../api.js";
import { escapeHtml, icon, openSheet, snackbar, spinner } from "../ui/shell.js";
import { fieldId, setMessage } from "./device-sheets.js";
import {
  DAYS,
  MAX_WINDOWS,
  describeWindow,
  endForInput,
  endFromInput,
  newWindow,
  normalizeWindows,
} from "./restrictions-model.js";

/* onSaved(activities) gets every activity's restrictions after a save. */
export function openRestrictionsSheet({ activityId, name, onSaved }) {
  let windows = null; // the list being edited, with ends as the inputs show them
  let loadError = "";
  let saving = false;
  let closed = false;
  const prefix = fieldId("rs");

  const toInputs = (list) => list.map((w) => ({ days: [...w.days], start: w.start, end: endForInput(w.end) }));
  const fromInputs = (list) => list.map((w) => ({ days: w.days, start: w.start, end: endFromInput(w.end) }));

  return openSheet({
    label: `Time restrictions for ${name}`,
    onClose: () => {
      closed = true;
    },
    render: (content, close) => {
      function windowMarkup(w, i) {
        const summary = normalizeWindows(fromInputs([w])).windows?.[0];
        return `<fieldset class="m-fieldset rs-window" data-index="${i}">
            <legend>Time ${i + 1}</legend>
            <div class="m-chips" role="group" aria-label="Days for time ${i + 1}">
              ${DAYS.map((d) => `<button type="button" class="chip" data-day="${d.key}" aria-pressed="${w.days.includes(d.key)}" aria-label="${d.long}">${d.short}</button>`).join("")}
            </div>
            <div class="rs-times">
              <div class="m-field">
                <label for="${prefix}s${i}">From</label>
                <input id="${prefix}s${i}" type="time" step="60" data-field="start" value="${escapeHtml(w.start)}" required>
              </div>
              <div class="m-field">
                <label for="${prefix}e${i}">Until</label>
                <input id="${prefix}e${i}" type="time" step="60" data-field="end" value="${escapeHtml(w.end)}" required>
              </div>
            </div>
            <div class="rs-window-foot">
              <p class="m-field-hint" data-summary>${escapeHtml(summary ? describeWindow(summary) : "")}</p>
              <button type="button" class="btn btn-text is-destructive" data-remove aria-label="Remove time ${i + 1}">${icon("delete_outlined", { size: 20 })}Remove</button>
            </div>
          </fieldset>`;
      }

      function draw(message = "", kind = "info") {
        if (closed) return;
        let body;
        if (loadError) {
          body = `<p class="sheet-text">${escapeHtml(loadError)}</p>
            <button type="button" class="btn btn-tonal btn-block" data-act="retry">Try again</button>`;
        } else if (!windows) {
          body = `<div class="m-center">${spinner("Loading time restrictions")}</div>`;
        } else {
          body = `${windows.length
              ? windows.map(windowMarkup).join("")
              : `<p class="list-note">No restrictions: ${escapeHtml(name)} can be started at any time.</p>`}
            ${windows.length < MAX_WINDOWS ? `<button type="button" class="btn btn-tonal btn-block" data-act="add">${icon("add", { size: 20 })}Add a time</button>` : ""}
            <p class="form-msg" data-msg role="status" aria-live="polite"></p>
            <button type="submit" class="btn btn-filled btn-block"${saving ? " disabled" : ""}>${saving ? spinner("Saving") : ""}Save</button>`;
        }
        content.innerHTML = `<form class="m-form" novalidate>
            <h2 class="sheet-title">Time restrictions</h2>
            <p class="sheet-text">${escapeHtml(name)} can't be started at these times, from any remote or app. If it's already on when a time begins, it keeps running. Times are in the hub's time zone; an end of 00:00 is midnight.</p>
            ${body}
          </form>`;
        setMessage(content.querySelector("[data-msg]"), message, kind);
      }

      async function load() {
        loadError = "";
        windows = null;
        draw();
        try {
          const res = await getActivityRestrictions();
          windows = toInputs(res.activities?.[activityId] ?? []);
        } catch (err) {
          loadError = `Couldn't read the time restrictions: ${err.message || "hub error"}`;
        }
        draw();
      }

      async function save() {
        if (saving) return;
        const { windows: checked, error } = normalizeWindows(fromInputs(windows));
        if (error) {
          setMessage(content.querySelector("[data-msg]"), error, "error");
          return;
        }
        saving = true;
        draw();
        try {
          const res = await saveActivityRestrictions({ activityId, windows: checked });
          saving = false;
          onSaved?.(res.activities ?? {});
          snackbar(checked.length ? `Saved time restrictions for “${name}”` : `“${name}” can be started at any time`);
          close();
        } catch (err) {
          saving = false;
          draw(`Couldn't save: ${err.message || "hub error"}`, "error");
        }
      }

      function windowAt(el) {
        const box = el.closest("[data-index]");
        return box ? { box, w: windows[Number(box.dataset.index)] } : {};
      }

      // After an edit: the time's new summary, and no stale save error.
      function refreshSummary(box, w) {
        const summary = normalizeWindows(fromInputs([w])).windows?.[0];
        box.querySelector("[data-summary]").textContent = summary ? describeWindow(summary) : "";
        setMessage(content.querySelector("[data-msg]"), "");
      }

      content.addEventListener("click", (event) => {
        const act = event.target.closest("[data-act]")?.dataset.act;
        if (act === "retry") {
          load();
          return;
        }
        if (act === "add") {
          windows.push(toInputs([newWindow()])[0]);
          draw();
          content.querySelector(`[data-index="${windows.length - 1}"] [data-day]`)?.focus();
          return;
        }
        const chip = event.target.closest("[data-day]");
        if (chip) {
          const { box, w } = windowAt(chip);
          const day = chip.dataset.day;
          w.days = w.days.includes(day) ? w.days.filter((d) => d !== day) : [...w.days, day];
          chip.setAttribute("aria-pressed", String(w.days.includes(day)));
          refreshSummary(box, w);
          return;
        }
        const remove = event.target.closest("[data-remove]");
        if (remove) {
          windows.splice(Number(remove.closest("[data-index]").dataset.index), 1);
          draw();
          content.querySelector("[data-act=add]")?.focus();
        }
      });

      content.addEventListener("input", (event) => {
        const field = event.target.dataset?.field;
        if (!field) return;
        const { box, w } = windowAt(event.target);
        w[field] = event.target.value;
        refreshSummary(box, w);
      });

      content.addEventListener("submit", (event) => {
        event.preventDefault();
        save();
      });

      load();
    },
  });
}
