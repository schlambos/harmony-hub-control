/* The Inputs section of a network TV's Settings page, and its sheets: Try,
   Find my inputs, a link for one input, and Share this setup. The logic is in
   androidtv-inputs-model.js; device-settings.js owns the draft and the save. */

import { tryTvInput } from "../api.js";
import { escapeHtml, icon, openSheet, sectionLabel, spinner } from "../ui/shell.js";
import {
  CUSTOM_LINKS,
  METHODS,
  finderAnswer,
  finderApply,
  finderCandidates,
  finderStart,
  linkOk,
  presetNote,
  statusLabel,
  targetLabel,
  targetOptions,
  today,
  tryRequest,
} from "./androidtv-inputs-model.js";

/* What Try and the finder need: a TV that is connected and on. "" when it can. */
export function tryBlocker(tv) {
  if (!tv?.status) return "The hub's network TV service isn't answering, so inputs can't be tried now.";
  if (!tv.status.connected) {
    return tv.status.mac
      ? "The TV is off or asleep. Turn it on to try inputs."
      : "The TV isn't connected, so inputs can't be tried now.";
  }
  if (!tv.status.on) return "Turn the TV on to try inputs.";
  return "";
}

function patternLabel(draft) {
  if (draft.pattern === CUSTOM_LINKS) return "A link for each input";
  const p = draft.patterns.find((q) => q.id === draft.pattern);
  return p ? p.label : "Choose…";
}

function methodRows(draft, tv, stepper) {
  return METHODS.map((m) => {
    const on = draft.method === m.value;
    let sub = "";
    if (on && m.value === "link") {
      sub = `<button type="button" class="m-row ds-pick ds-tv-sub" data-focus="tv-pattern" data-tv-act="pattern" aria-haspopup="dialog">
          <span class="ds-title">Input links</span>
          <span class="ds-pick-value">${escapeHtml(patternLabel(draft))}</span>
          ${icon("keyboard_arrow_down", { cls: "ds-caret" })}
        </button>`;
      if (tv.status && tv.status.connected && tv.status.appLinks === false) {
        sub += `<p class="ds-hint ds-tv-sub">This TV doesn't accept input links. Choose another way.</p>`;
      }
    }
    if (on && m.value === "menu") sub = `<div class="ds-tv-sub">${stepper("menuGap")}</div>`;
    return `<label class="m-row ds-choice">
        <input type="radio" name="ds-tvmethod" value="${m.value}" data-focus="tvmethod-${m.value}" data-radio="tvmethod"${on ? " checked" : ""}>
        <span class="ds-choice-text">${escapeHtml(m.label)}</span>
      </label>${sub}`;
  }).join("");
}

function rowMarkup(draft, row, i, count, canTry) {
  const status = statusLabel(row);
  const tone = row.status === "works" ? " is-works" : row.status === "failed" ? " is-failed" : "";
  const name = row.name.trim() || `Input ${i + 1}`;
  return `<div class="ds-input ds-tv-input">
      <div class="ds-tv-name">
        <input class="ds-input-name" data-focus="tv-name-${i}" data-tv-name="${i}" value="${escapeHtml(row.name)}" placeholder="HDMI 1" maxlength="64" autocomplete="off" aria-label="Input ${i + 1} name">
        <span class="ds-tv-status${tone}">${row.status === "works" ? icon("check", { size: 14 }) : ""}${escapeHtml(status)}</span>
      </div>
      <button type="button" class="ds-input-cmd" data-focus="tv-opens-${i}" data-tv-opens="${i}" aria-haspopup="dialog" aria-label="${escapeHtml(`What ${name} opens: ${targetLabel(draft, row.value)}`)}">
        <span>${escapeHtml(targetLabel(draft, row.value))}</span>${icon("keyboard_arrow_down", { size: 20 })}
      </button>
      <button type="button" class="icon-btn" data-focus="tv-try-${i}" data-tv-try="${i}" aria-label="${escapeHtml(`Try ${name}`)}"${canTry && row.value !== "" ? "" : " disabled"}>${icon("play_arrow")}</button>
      <button type="button" class="icon-btn" data-focus="in-menu-${i}" data-input-menu="${i}" aria-haspopup="menu" aria-label="More for input ${i + 1} of ${count}">${icon("more_vert")}</button>
    </div>`;
}

/* The section, merged: one method choice, one list, no command pickers. */
export function tvInputsMarkup({ draft, tv, inUse, stepper, maxInputs }) {
  const parts = [sectionLabel("Inputs")];
  if (inUse.length) {
    parts.push(`<p class="ds-hint">Used by activities: ${escapeHtml(inUse.map((u) => `${u.input} (${u.activity})`).join(", "))}. Keep these names.</p>`);
  }
  if (tv.loadError) parts.push(`<p class="ds-note">${escapeHtml(tv.loadError)}</p>`);
  parts.push(`<div class="m-list ds-tv-methods" role="radiogroup" aria-label="How this TV switches inputs">${methodRows(draft, tv, stepper)}</div>`);
  const note = presetNote(draft, draft.preset?.vendor);
  if (note && draft.method !== "none") parts.push(`<p class="ds-hint ds-tv-note">${escapeHtml(note)}${draft.fromProfile ? "" : " · not saved yet"}</p>`);
  else if (!draft.fromProfile && draft.method !== "none") {
    // No brand suggestion: say which manufacturer was looked up, and where it's set.
    const brand = tv.base?.vendor ? `“${tv.base.vendor}”` : "this TV";
    parts.push(`<p class="ds-hint ds-tv-note">No suggested setup for ${escapeHtml(brand)}. The manufacturer is set in the device's Edit details.</p>`);
  }
  if (draft.method === "none") return parts.join("");
  parts.push(`<div class="m-list">${stepper("inputDelay")}</div>`);
  parts.push(`<h4 class="ds-sub">Inputs, in the TV's order</h4>`);
  const blocker = tryBlocker(tv);
  if (blocker) {
    // Wake-on-LAN reaches a TV that's asleep and off the network, once its
    // address (mac) is known.
    const canWake = tv.status && !tv.status.on && (tv.status.connected || tv.status.mac);
    const action = (canWake
      ? `<button type="button" class="btn btn-text" data-focus="tv-power-on" data-tv-act="power-on">Turn on the TV</button>`
      : "")
      + (tv.status?.connected ? "" : `<button type="button" class="btn btn-text" data-focus="tv-refresh" data-tv-act="refresh">Check again</button>`);
    parts.push(`<div class="ds-tv-blocker"><p class="ds-hint">${escapeHtml(blocker)}</p>${action}</div>`);
  }
  parts.push(draft.rows.length
    ? `<div class="m-list ds-inputs">${draft.rows.map((row, n) => rowMarkup(draft, row, n, draft.rows.length, !blocker)).join("")}</div>`
    : `<p class="ds-hint">No inputs yet.</p>`);
  const canFind = !blocker && finderCandidates(draft).length > 0 && draft.rows.length > 0;
  parts.push(`<div class="ds-row-actions">
      <button type="button" class="btn btn-text" data-focus="add-input" data-act="add-input"${draft.rows.length >= maxInputs ? " disabled" : ""}>${icon("add", { size: 18 })}Add input</button>
      <button type="button" class="btn btn-text" data-focus="tv-find" data-tv-act="find"${canFind ? "" : " disabled"}>Find my inputs…</button>
      <button type="button" class="btn btn-text" data-focus="tv-preset" data-tv-act="preset">Use the suggested setup</button>
      <button type="button" class="btn btn-text" data-focus="tv-share" data-tv-act="share">Share this setup</button>
    </div>`);
  return parts.join("");
}

/* -- sheets ----------------------------------------------------------------------- */

function sheetButtons(buttons) {
  return `<div class="ds-tv-answers">${buttons.map((b) => `<button type="button" class="btn ${b.filled ? "btn-filled" : "btn-tonal"} btn-block" data-answer="${escapeHtml(b.id)}">${escapeHtml(b.label)}</button>`).join("")}</div>`;
}

/**
 * Try one row: send it (Home first), then ask whether the TV switched to it.
 * onDone() runs after any answer changed the draft.
 */
export function openTrySheet({ tvId, draft, index, onDone }) {
  const row = draft.rows[index];
  const name = row.name.trim() || `Input ${index + 1}`;
  let value = row.value;
  let changed = false;
  return openSheet({
    label: `Try ${name}`,
    onClose: () => { if (changed) onDone(); },
    render: (content, close) => {
      async function send() {
        content.innerHTML = `<h2 class="sheet-title">Trying ${escapeHtml(name)}</h2>
          <p class="sheet-text">${spinner()} Sending ${escapeHtml(targetLabel(draft, value))} to the TV, after Home…</p>`;
        try {
          await tryTvInput(tryRequest(tvId, draft, value));
        } catch (error) {
          content.innerHTML = `<h2 class="sheet-title">Couldn't try ${escapeHtml(name)}</h2>
            <p class="sheet-text">${escapeHtml(error.message)}</p>${sheetButtons([{ id: "close", label: "Close", filled: true }])}`;
          return;
        }
        // The hub presses Home, then the input 1.5 s later: ask once it has.
        await new Promise((resolve) => setTimeout(resolve, 2000));
        ask();
      }
      function ask() {
        content.innerHTML = `<h2 class="sheet-title">Did the TV switch to ${escapeHtml(name)}?</h2>
          <p class="sheet-text">The hub sent ${escapeHtml(targetLabel(draft, value))}. It can't see the screen, so your answer is the test.</p>
          ${sheetButtons([
            { id: "yes", label: "Yes", filled: true },
            { id: "no", label: "No, nothing changed" },
            ...(draft.rows.length > 1 ? [{ id: "other", label: "It showed a different input…" }] : []),
          ])}`;
      }
      function failed() {
        const options = targetOptions(draft);
        const at = options.findIndex((o) => o.value === value);
        const next = at >= 0 && at + 1 < options.length ? options[at + 1] : null;
        content.innerHTML = `<h2 class="sheet-title">${escapeHtml(name)} didn't switch</h2>
          <p class="sheet-text">${next ? `Try the next one, or choose another way to switch inputs on this page.` : `Try another way to switch inputs on this page, or a different link.`}</p>
          ${sheetButtons([...(next ? [{ id: "next", label: `Try ${next.label}`, filled: true }] : []), { id: "close", label: "Close" }])}`;
        content.dataset.next = next ? String(options.indexOf(next)) : "";
      }
      function other() {
        content.innerHTML = `<h2 class="sheet-title">Which input did it show?</h2>
          <p class="sheet-text">${escapeHtml(targetLabel(draft, value))} opens that input instead. The two inputs swap what they open.</p>
          <div class="ds-tv-answers">${draft.rows.map((r, i) => i === index ? "" : `<button type="button" class="btn btn-tonal btn-block" data-swap="${i}">${escapeHtml(r.name.trim() || `Input ${i + 1}`)}</button>`).join("")}</div>`;
      }
      content.addEventListener("click", (event) => {
        const swap = event.target.closest("[data-swap]");
        if (swap) {
          const otherRow = draft.rows[Number(swap.dataset.swap)];
          const was = otherRow.value;
          Object.assign(otherRow, { value, status: "works", date: today() });
          Object.assign(row, { value: was, status: "untested", date: "" });
          changed = true;
          close();
          return;
        }
        const answer = event.target.closest("[data-answer]")?.dataset.answer;
        if (!answer) return;
        if (answer === "close") close();
        else if (answer === "yes") {
          Object.assign(row, { value, status: "works", date: today() });
          changed = true;
          close();
        } else if (answer === "no") {
          if (row.value === value) Object.assign(row, { status: "failed", date: today() });
          changed = true;
          failed();
        } else if (answer === "other") other();
        else if (answer === "next") {
          value = targetOptions(draft)[Number(content.dataset.next)].value;
          row.value = value;
          row.status = "untested";
          changed = true;
          send();
        }
      });
      send();
    },
  });
}

/**
 * Find my inputs: each candidate in turn (Home first), and "What's on screen
 * now?". What it finds goes into the draft's rows, unsaved.
 */
export function openFinderSheet({ tvId, draft, onDone }) {
  let state = finderStart(draft);
  let stopped = false;
  return openSheet({
    label: "Find my inputs",
    onClose: () => {
      stopped = true;
      if (state.found.length || state.added.length) {
        finderApply(draft, state);
        onDone(state);
      }
    },
    render: (content, close) => {
      async function step() {
        const value = state.candidates[state.index];
        content.innerHTML = `<h2 class="sheet-title">Find my inputs</h2>
          <p class="sheet-text">${spinner()} Trying ${escapeHtml(targetLabel(draft, value))} (${state.index + 1} of ${state.candidates.length})…</p>`;
        try {
          await tryTvInput(tryRequest(tvId, draft, value));
        } catch (error) {
          content.innerHTML = `<h2 class="sheet-title">Find my inputs stopped</h2>
            <p class="sheet-text">${escapeHtml(error.message)}</p>${sheetButtons([{ id: "close", label: "Close", filled: true }])}`;
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 2000));
        if (!stopped) ask(value);
      }
      function ask(value) {
        const named = new Set([...state.found, ...state.added].map((f) => f.name.toLowerCase()));
        const left = draft.rows.filter((r) => r.name.trim() && !named.has(r.name.trim().toLowerCase()));
        content.innerHTML = `<h2 class="sheet-title">What's on screen now?</h2>
          <p class="sheet-text">The hub sent ${escapeHtml(targetLabel(draft, value))}.</p>
          <div class="ds-tv-answers">
            ${left.map((r) => `<button type="button" class="btn btn-tonal btn-block" data-found="${escapeHtml(r.name.trim())}">${escapeHtml(r.name.trim())}</button>`).join("")}
            <form class="ds-tv-new" data-new-form>
              <input data-new-name maxlength="64" placeholder="Another input (name it)" aria-label="Name of the input on screen" autocomplete="off">
              <button type="submit" class="btn btn-tonal">Add</button>
            </form>
            <button type="button" class="btn btn-tonal btn-block" data-answer="empty">An input with no picture</button>
            <button type="button" class="btn btn-tonal btn-block" data-answer="nothing">Nothing changed</button>
            <button type="button" class="btn btn-text btn-block" data-answer="stop">Stop</button>
          </div>`;
      }
      function answer(a) {
        state = finderAnswer(state, draft, a);
        if (state.done) {
          const n = state.found.length + state.added.length;
          content.innerHTML = `<h2 class="sheet-title">Done</h2>
            <p class="sheet-text">${n ? `Found ${n} input${n === 1 ? "" : "s"}. Check the list, then Save.` : "Nothing found this way. Try another way to switch inputs."}</p>
            ${sheetButtons([{ id: "close", label: "Close", filled: true }])}`;
          return;
        }
        step();
      }
      content.addEventListener("click", (event) => {
        const found = event.target.closest("[data-found]");
        if (found) { answer({ kind: "input", name: found.dataset.found }); return; }
        const a = event.target.closest("[data-answer]")?.dataset.answer;
        if (a === "close" || a === "stop") close();
        else if (a === "empty" || a === "nothing") answer({ kind: a });
      });
      content.addEventListener("submit", (event) => {
        event.preventDefault();
        const field = content.querySelector("[data-new-name]");
        const name = String(field?.value ?? "").trim();
        if (!name || /["\\]/.test(name)) { field?.focus(); return; }
        answer({ kind: "new", name });
      });
      if (!state.candidates.length) {
        content.innerHTML = `<h2 class="sheet-title">Find my inputs</h2><p class="sheet-text">There's nothing to try for a link per input.</p>${sheetButtons([{ id: "close", label: "Close", filled: true }])}`;
      } else step();
    },
  });
}

/* A link for one input (the link-per-input choice). */
export function openLinkSheet({ name, value, onSave }) {
  return openSheet({
    label: `Link for ${name}`,
    render: (content, close) => {
      content.innerHTML = `<form data-link-form>
          <h2 class="sheet-title">Link for ${escapeHtml(name)}</h2>
          <p class="sheet-text">The link the TV opens for this input, such as content://android.media.tv/passthrough/…</p>
          <input data-link value="${escapeHtml(value ?? "")}" maxlength="199" autocomplete="off" spellcheck="false" aria-label="Link">
          <p class="ds-problem" data-link-problem></p>
          <button type="submit" class="btn btn-filled btn-block">Done</button>
        </form>`;
      content.addEventListener("submit", (event) => {
        event.preventDefault();
        const link = String(content.querySelector("[data-link]").value ?? "").trim();
        if (!linkOk(link)) {
          content.querySelector("[data-link-problem]").textContent = "Enter a whole link, such as content://…, without spaces or quotes.";
          return;
        }
        close();
        onSave(link);
      });
    },
  });
}

/* Share this setup: a presets-file entry to paste into a GitHub issue. */
export function openShareSheet({ entry }) {
  const text = JSON.stringify(entry, null, 2);
  return openSheet({
    label: "Share this setup",
    render: (content) => {
      content.innerHTML = `<h2 class="sheet-title">Share this setup</h2>
        <p class="sheet-text">If it works, other people with this TV can start from it. Paste this into an issue on the Melodious project, and it can go into the suggested setups.</p>
        <textarea class="ds-tv-share" readonly rows="10" aria-label="This TV's input setup">${escapeHtml(text)}</textarea>
        <button type="button" class="btn btn-tonal btn-block" data-copy>Copy</button>`;
      content.querySelector("[data-copy]").addEventListener("click", async (event) => {
        try {
          await navigator.clipboard.writeText(text);
          event.target.textContent = "Copied";
        } catch {
          content.querySelector("textarea").select();
        }
      });
    },
  });
}
