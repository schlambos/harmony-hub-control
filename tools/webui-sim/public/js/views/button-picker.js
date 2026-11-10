/* One button's pick sheet, like the wizard's key picker: tabs, device
   chips on one line that scrolls sideways, search across every chip, Clear,
   Done and Undo. A pick keeps the sheet open; Done keeps the changes, any
   other close drops them. Markup and classes are the pick sheet's. */

import { escapeHtml, icon } from "../ui/shell.js";

/** The rows of every list whose chip and row label hold each word of
    `query`: “bed toggle” finds Bedroom's PowerToggle. */
export function matchingRowsOfAllChips(lists, query) {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return lists.flatMap(({ chip, rows }) => rows
    .map((row, index) => ({ chip, row, index }))
    .filter(({ row }) => {
      const text = `${chip.label} ${row.label}`.toLowerCase();
      return words.every((word) => text.includes(word));
    }));
}

/**
 * openSheet options for one button's sheet. Fixed: label, tabs, tabsLabel,
 * chips, searchLabel. Asked after every change: now(tab), tabEnabled(tab),
 * tabHint(tab) (why a tab is off), canClear(), canUndo(), startChip(tab),
 * rows(tab, chip) and extraRows(tab) as [{ label, current, pick }].
 * Changes: pick(), onClear(), onUndo(); onDone().
 */
export function buttonPickerSheet(picker) {
  return {
    label: `${picker.label} button`,
    className: "pick-sheet",
    render: (content, close) => renderPicker(content, close, picker),
  };
}

/** After the sheet opens: show the row in use, as the app does, and its chip. */
export function showCurrentRow(content) {
  scrollToRow(content, content.querySelector(".pick-row.is-current"));
  showPressedChip(content);
}

/* The sticky top (title, tabs, chips, search) covers the list's first rows,
   and grows with every line of chips: centre the row in the part below it. */
function scrollToRow(content, row) {
  if (!row) return;
  const top = content.querySelector(".pick-top");
  content.style.scrollPaddingTop = top ? `${top.offsetHeight}px` : "";
  row.scrollIntoView({ block: "center" });
}

function tabsMarkup({ tabs, tabsLabel }) {
  if (tabs.length < 2) return "";
  return `
            <div class="seg-tabs" role="tablist" aria-label="${escapeHtml(tabsLabel)}">
              ${tabs.map((t) => `<button type="button" role="tab" class="seg-tab" data-pick-tab="${escapeHtml(t.id)}">${escapeHtml(t.label)}</button>`).join(`
              `)}
            </div>`;
}

function chipsMarkup() {
  const chips = `<div class="pick-chips is-row" role="group" aria-label="Device" data-pick-chips></div>`;
  const step = (direction, label, name) => `<button type="button" class="icon-btn pick-chip-step" data-pick-scroll="${direction}" aria-label="${label}" title="${label}" hidden>${icon(name)}</button>`;
  return `<div class="pick-chip-row">
              ${step(-1, "Show previous choices", "keyboard_arrow_left")}
              ${chips}
              ${step(1, "Show more choices", "keyboard_arrow_right")}
            </div>`;
}

function rowMarkup(row, attribute, check) {
  return `<button type="button" class="pick-row${row.current ? " is-current" : ""}" ${attribute}><span>${escapeHtml(row.label)}</span>${row.current ? check : ""}</button>`;
}

function renderPicker(content, close, picker) {
  const { label, chips, searchLabel = "Search commands" } = picker;
  let tab = picker.tabs[0].id;
  let query = "";
  let chip = picker.startChip(tab);

  // The top keeps one height, as the chips do: its "Now:" line doesn't wrap either.
  content.innerHTML = `<div class="pick-top is-fixed">
            <div class="pick-head">
              <h2 class="sheet-title" tabindex="-1" autofocus>“${escapeHtml(label)}” button</h2>
              <span data-pick-clear></span>
              <button type="button" class="btn btn-filled btn-sm" data-pick="done">Done</button>
            </div>
            <p class="pick-now" data-pick-now></p>${tabsMarkup(picker)}
            ${chipsMarkup()}
            <label class="search-field">${icon("search", { size: 22 })}<input type="search" data-pick-search placeholder="${escapeHtml(searchLabel)}" aria-label="${escapeHtml(searchLabel)}" autocomplete="off"></label>
          </div>
          <div class="pick-list" data-pick-list></div>
          <div class="pick-foot" data-pick-foot></div>`;
  const $ = (selector) => content.querySelector(selector);

  function drawTop() {
    $("[data-pick-clear]").innerHTML = picker.canClear() ? `<button type="button" class="btn btn-text is-destructive" data-pick="clear">Clear</button>` : "";
    const now = $("[data-pick-now]");
    now.textContent = picker.now(tab);
    now.title = now.textContent;
    content.querySelectorAll("[data-pick-tab]").forEach((b) => {
      b.setAttribute("aria-selected", String(b.dataset.pickTab === tab));
      b.disabled = !picker.tabEnabled(b.dataset.pickTab);
      b.title = b.disabled ? picker.tabHint?.(b.dataset.pickTab) ?? "" : "";
    });
    $("[data-pick-chips]").innerHTML = chips.map((c) => `<button type="button" class="chip" data-pick-device="${escapeHtml(c.id)}" aria-pressed="${c.id === chip}">${escapeHtml(c.label)}</button>`).join("");
    $("[data-pick-foot]").innerHTML = picker.canUndo()
      ? `<button type="button" class="btn btn-text" data-pick="undo">Undo my change</button>`
      : "";
  }

  // While searching, a row says its chip and remembers it.
  function listRows(check) {
    if (!query.trim()) {
      return picker.rows(tab, chip).map((row, index) => rowMarkup(row, `data-pick-command="${index}"`, check));
    }
    const lists = chips.map((c) => ({ chip: c, rows: picker.rows(tab, c.id) }));
    return matchingRowsOfAllChips(lists, query).map(({ chip: c, row, index }) => rowMarkup(
      { ...row, label: `${c.label} · ${row.label}` },
      `data-pick-chip="${escapeHtml(c.id)}" data-pick-command="${index}"`,
      check,
    ));
  }

  function drawList() {
    const check = icon("check", { cls: "pick-check", label: "Current" });
    const rows = listRows(check);
    const extras = query.trim()
      ? ""
      : picker.extraRows(tab).map((row, index) => rowMarkup(row, `data-pick-extra="${index}"`, check)).join("");
    $("[data-pick-list]").innerHTML = rows.length || extras
      ? extras + rows.join("")
      : `<p class="list-note">Nothing matches “${escapeHtml(query.trim())}”.</p>`;
  }

  // After a new tab or chip, show the row in use, else the top.
  function showCurrent() {
    const row = $(".pick-row.is-current");
    if (row) scrollToRow(content, row);
    else content.scrollTop = 0;
  }

  function redraw() {
    drawTop();
    drawList();
    showCurrent();
    showPressedChip(content);
  }

  function apply(update) {
    update();
    drawTop();
    drawList();
  }

  content.addEventListener("click", (event) => {
    const tabButton = event.target.closest("[data-pick-tab]");
    if (tabButton) {
      if (tabButton.disabled || tabButton.dataset.pickTab === tab) return;
      tab = tabButton.dataset.pickTab;
      chip = picker.startChip(tab);
      redraw();
      return;
    }
    const chipButton = event.target.closest("[data-pick-device]");
    if (chipButton) {
      chip = chipButton.dataset.pickDevice;
      // A search over every chip would hide the chip just picked: start it over.
      if (query) {
        query = "";
        $("[data-pick-search]").value = "";
      }
      redraw();
      return;
    }
    const row = event.target.closest("[data-pick-command]");
    if (row) {
      const picked = picker.rows(tab, row.dataset.pickChip ?? chip)[Number(row.dataset.pickCommand)];
      if (picked) apply(picked.pick);
      return;
    }
    const extra = event.target.closest("[data-pick-extra]");
    if (extra) {
      const picked = picker.extraRows(tab)[Number(extra.dataset.pickExtra)];
      if (picked) apply(picked.pick);
      return;
    }
    const act = event.target.closest("[data-pick]")?.dataset.pick;
    if (act === "clear") apply(picker.onClear);
    else if (act === "undo") apply(picker.onUndo);
    else if (act === "done") {
      picker.onDone();
      close();
    }
  });

  content.addEventListener("input", (event) => {
    if (!event.target.matches("[data-pick-search]")) return;
    query = event.target.value;
    drawList();
    content.scrollTop = 0;
  });

  followChipRow(content);
  drawTop();
  drawList();
}

/* -- the one-line chip row ------------------------------------------------------- */

// Room an arrow and its fade take at each end: a chip under it counts as hidden.
const CHIP_EDGE = 40;
// Pixels a wheel "line" moves (deltaMode 1, Firefox with a mouse).
const WHEEL_LINE = 40;

/* Wires the row's wheel, arrows and edge marks. The row only gets its size
   once the sheet opens, so the edges follow its size as well as its scroll. */
function followChipRow(content) {
  const row = content.querySelector(".pick-chips.is-row");
  const [back, forward] = content.querySelectorAll("[data-pick-scroll]");
  const markEdges = () => markHiddenChips(row, back, forward);
  row.addEventListener("scroll", markEdges, { passive: true });
  new ResizeObserver(markEdges).observe(row);
  row.addEventListener("wheel", (event) => wheelSideways(row, content, event), { passive: false });
  content.querySelector(".pick-chip-row").addEventListener("click", (event) => {
    const step = event.target.closest("[data-pick-scroll]");
    if (!step) return;
    const left = Number(step.dataset.pickScroll) * (row.clientWidth - 2 * CHIP_EDGE);
    row.scrollBy({ left, behavior: "smooth" });
  });
}

/* Fade and arrow on each side that has more chips. An arrow that hides while
   it has focus hands focus to the other one, so the keyboard isn't dropped. */
function markHiddenChips(row, back, forward) {
  const end = row.scrollWidth - row.clientWidth;
  const before = row.scrollLeft > 1;
  const after = row.scrollLeft < end - 1;
  const focused = [back, forward].find((button) => button === document.activeElement);
  row.classList.toggle("has-before", before);
  row.classList.toggle("has-after", after);
  back.hidden = !before;
  forward.hidden = !after;
  if (focused?.hidden) (focused === back ? forward : back).focus();
}

/* A mouse wheel only goes up and down: over the row it moves the row sideways
   until the row's end, then the sheet. The sheet is scrolled here, not left to
   the browser: Chrome keeps a wheel on a row at a fractional x (a centred
   sheet) when the row is at its end, and then scrolls neither. A mostly
   sideways gesture (a trackpad swipe) and a pinch (ctrlKey) stay the browser's. */
function wheelSideways(row, sheet, event) {
  if (event.ctrlKey || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
  event.preventDefault();
  const end = row.scrollWidth - row.clientWidth;
  const atEnd = event.deltaY > 0 ? row.scrollLeft >= end - 1 : row.scrollLeft <= 1;
  if (atEnd) sheet.scrollTop += wheelPixels(event, sheet.clientHeight);
  else row.scrollLeft += wheelPixels(event, row.clientWidth);
}

// deltaY in pixels: deltaMode 0 is pixels, 1 lines (Firefox), 2 pages.
function wheelPixels(event, page) {
  return event.deltaY * [1, WHEEL_LINE, page][event.deltaMode];
}

/* Centres the pressed chip when it is hidden or under an arrow. Only the row
   moves: scrollIntoView would also scroll the sheet. Needs the row to be the
   chips' offsetParent (position: relative in wizard.css). */
function showPressedChip(content) {
  const row = content.querySelector(".pick-chips.is-row");
  const chip = row?.querySelector('[aria-pressed="true"]');
  if (!chip) return;
  const start = chip.offsetLeft - CHIP_EDGE;
  const end = chip.offsetLeft + chip.offsetWidth + CHIP_EDGE;
  if (start < row.scrollLeft || end > row.scrollLeft + row.clientWidth) {
    row.scrollLeft = chip.offsetLeft + (chip.offsetWidth - row.clientWidth) / 2;
  }
}
