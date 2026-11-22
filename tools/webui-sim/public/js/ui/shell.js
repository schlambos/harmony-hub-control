/* Shared Melodious UI pieces: snackbar, bottom sheets, confirm dialogs,
   menus, the sub-page top bar, and small markup helpers that match the
   app's Compose components (ScreenTitle, ListGroup/ListRow, IconTile,
   StatusDot). */

import { escapeHtml } from "../setup-kit.js";
import { icon } from "./icons.js";

export { escapeHtml, icon };

/* -- Snackbar (one at a time, errors linger) ------------------------------ */

let snackTimer = null;

export function snackbar(text, { error = false } = {}) {
  const host = document.getElementById("snackbars");
  if (!host) return;
  clearTimeout(snackTimer);
  host.innerHTML = `<div class="snackbar${error ? " is-error" : ""}" role="${error ? "alert" : "status"}">${escapeHtml(text)}</div>`;
  snackTimer = setTimeout(() => {
    host.innerHTML = "";
  }, error ? 8000 : 4000);
}

/* -- Bottom sheet (centred card on wide screens) --------------------------- */

/**
 * Open a modal sheet. `render(content, close)` fills it. Esc, the scrim and
 * close() all dismiss it; the dialog element is removed afterwards.
 */
export function openSheet({ label, render, onClose, className = "" }) {
  const dialog = document.createElement("dialog");
  dialog.className = `sheet${className ? ` ${className}` : ""}`;
  dialog.setAttribute("aria-label", label);
  dialog.innerHTML = `<div class="sheet-body"><div class="sheet-handle" aria-hidden="true"></div><div class="sheet-content"></div></div>`;
  const content = dialog.querySelector(".sheet-content");
  const close = () => {
    if (dialog.open) dialog.close();
  };
  // A click that lands on the dialog itself (not its body) hit the scrim.
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) close();
  });
  dialog.addEventListener("close", () => {
    dialog.remove();
    onClose?.();
  });
  document.body.appendChild(dialog);
  render(content, close);
  dialog.showModal();
  return { dialog, content, close };
}

/* -- Confirm dialog (ConfirmDialog) ------------------------------------------- */

let dialogCount = 0;

/**
 * Ask before something that can't be undone. Resolves true for the confirm
 * button; Cancel, Esc and the scrim resolve false. Cancel has focus first.
 * With `cancel: false` it only tells: one button, which has focus.
 */
export function confirmDialog({ title, text, confirmLabel, destructive = false, cancel = true }) {
  return new Promise((resolve) => {
    const id = `mDialog${(dialogCount += 1)}`;
    const dialog = document.createElement("dialog");
    dialog.className = "m-dialog";
    dialog.setAttribute("aria-labelledby", `${id}t`);
    dialog.setAttribute("aria-describedby", `${id}d`);
    dialog.innerHTML = `<div class="m-dialog-body">
        <h2 class="m-dialog-title" id="${id}t">${escapeHtml(title)}</h2>
        <p class="m-dialog-text" id="${id}d">${escapeHtml(text)}</p>
        <div class="m-dialog-actions">
          ${cancel ? `<button type="button" class="btn btn-text" data-answer="" autofocus>Cancel</button>` : ""}
          <button type="button" class="btn btn-text${destructive ? " is-destructive" : ""}" data-answer="yes"${cancel ? "" : " autofocus"}>${escapeHtml(confirmLabel)}</button>
        </div>
      </div>`;
    let answer = false;
    dialog.addEventListener("click", (event) => {
      const button = event.target.closest("[data-answer]");
      if (event.target !== dialog && !button) return;
      answer = Boolean(button?.dataset.answer);
      dialog.close();
    });
    dialog.addEventListener("close", () => {
      dialog.remove();
      resolve(answer);
    });
    document.body.appendChild(dialog);
    dialog.showModal();
  });
}

/* -- Menu (DropdownMenu) -------------------------------------------------------- */

/**
 * A menu dropped from `anchor`, kept inside the window. Items are
 * { id, label, icon, destructive, disabled }; choosing one closes the menu
 * and calls onSelect(id). Arrow keys, Home and End move between items; Esc
 * and a click outside close it, then onClose() runs either way.
 */
export function openMenu({ anchor, label, items, onSelect, onClose }) {
  const dialog = document.createElement("dialog");
  dialog.className = "m-menu";
  dialog.setAttribute("aria-label", label);
  dialog.innerHTML = `<div class="m-menu-body" role="menu" aria-label="${escapeHtml(label)}">${items
    .map((item) => `<button type="button" role="menuitem" class="m-menu-item${item.destructive ? " is-destructive" : ""}" data-menu-item="${escapeHtml(item.id)}"${item.disabled ? " disabled" : ""}>
        ${icon(item.icon)}<span>${escapeHtml(item.label)}</span>
      </button>`)
    .join("")}</div>`;
  let picked = null;
  dialog.addEventListener("click", (event) => {
    const item = event.target.closest("[data-menu-item]");
    if (event.target !== dialog && !item) return;
    picked = item?.dataset.menuItem ?? null;
    dialog.close();
  });
  dialog.addEventListener("keydown", (event) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const list = [...dialog.querySelectorAll("[data-menu-item]:not(:disabled)")];
    const at = list.indexOf(document.activeElement);
    const next = event.key === "Home" ? 0
      : event.key === "End" ? list.length - 1
      : (at + (event.key === "ArrowDown" ? 1 : -1) + list.length) % list.length;
    list[next]?.focus();
  });
  dialog.addEventListener("close", () => {
    dialog.remove();
    anchor.setAttribute("aria-expanded", "false");
    onClose?.();
    if (picked) onSelect(picked);
  });
  document.body.appendChild(dialog);
  dialog.showModal();
  anchor.setAttribute("aria-expanded", "true");
  // Below the anchor, right edges aligned; above it when there's no room.
  // offsetWidth/Height: the opening animation scales the menu, which a
  // bounding box would include.
  const a = anchor.getBoundingClientRect();
  const width = dialog.offsetWidth;
  const height = dialog.offsetHeight;
  const edge = 8;
  const left = Math.max(edge, Math.min(a.right - width, document.documentElement.clientWidth - width - edge));
  const below = a.bottom + 4;
  const top = below + height <= window.innerHeight - edge ? below : Math.max(edge, a.top - 4 - height);
  dialog.style.left = `${left}px`;
  dialog.style.top = `${top}px`;
  dialog.querySelector("[data-menu-item]:not(:disabled)")?.focus();
  return dialog;
}

/* -- Sub-page top bar --------------------------------------------------------- */

let appBarBack = null;

/** Show the back-arrow bar (title, parent hash, optional action buttons HTML),
    or hide it with null. Action clicks are handled by the view that owns them.
    `close` swaps the arrow for a close button, and `onBack` runs instead of
    following the link (the wizard asks before it discards changes). */
export function setAppBar(bar) {
  const el = document.getElementById("appbar");
  const app = document.getElementById("app");
  if (!el || !app) return;
  appBarBack = bar?.onBack ?? null;
  if (!bar) {
    el.hidden = true;
    app.classList.remove("is-subpage");
    return;
  }
  el.hidden = false;
  app.classList.add("is-subpage");
  el.classList.toggle("is-compact", Boolean(bar.close));
  const back = el.querySelector("#appbarBack");
  if (!back.dataset.wired) {
    back.dataset.wired = "1";
    back.addEventListener("click", (event) => {
      if (!appBarBack) return;
      event.preventDefault();
      appBarBack();
    });
  }
  back.setAttribute("href", `#${bar.back}`);
  back.setAttribute("aria-label", bar.close ? "Close without saving" : "Back");
  back.innerHTML = icon(bar.close ? "close" : "arrow_back");
  el.querySelector("#appbarTitle").textContent = bar.title;
  el.querySelector("#appbarActions").innerHTML = bar.actions ?? "";
}

/* -- Haptics: a short tick where the browser can vibrate (Android) ------------ */

export function vibrate() {
  try {
    navigator.vibrate?.(8);
  } catch (_) {}
}

/* -- Markup helpers (escape everything that comes from the hub) -------------- */

export function screenTitle(title, { subtitle = "", action = "" } = {}) {
  return `<div class="m-title-row">
      <div class="m-title-text"><h2 class="m-title">${escapeHtml(title)}</h2>${subtitle}</div>
      ${action}
    </div>`;
}

export function sectionLabel(text, { muted = false } = {}) {
  return `<h3 class="m-section${muted ? " is-muted" : ""}">${escapeHtml(text)}</h3>`;
}

export function iconTile(name, { size = 44, tone = "" } = {}) {
  return `<span class="m-tile${tone ? ` m-tile--${tone}` : ""}" style="--tile:${size}px">${icon(name, { size: Math.round(size * 0.5) })}</span>`;
}

// Activity images the hub didn't have this session. The screens rebuild
// their HTML on every state poll; without this each rebuild would ask the hub
// for the same missing image again.
const missingImages = new Set();

/** An icon tile with an image over it (an activity's own icon). The icon
    shows while the image loads, and stays if the image fails. */
export function imageTile(url, fallbackIcon, { size = 44, tone = "" } = {}) {
  if (!url || missingImages.has(url)) return iconTile(fallbackIcon, { size, tone });
  return `<span class="m-tile m-tile--image${tone ? ` m-tile--${tone}` : ""}" style="--tile:${size}px">${icon(fallbackIcon, { size: Math.round(size * 0.5) })}<img class="m-tile-img" src="${escapeHtml(url)}" alt="" loading="lazy" decoding="async"></span>`;
}

// A tile image that can't load (not on the hub yet) leaves its icon and is
// not asked for again until images change (the activity editor says so
// after it stores an icon). Load errors don't bubble, so listen in
// the capture phase.
if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
  document.addEventListener("error", (event) => {
    const target = event.target;
    if (target?.tagName === "IMG" && target.classList?.contains("m-tile-img")) {
      const src = target.getAttribute("src");
      if (src) missingImages.add(src);
      target.remove();
    }
  }, true);
  document.addEventListener("melodious:images-changed", () => missingImages.clear());
}

export function statusDot(live) {
  return `<span class="m-dot${live ? " is-live" : ""}" aria-hidden="true"></span>`;
}

/** One list row; pass `href` for a link row or `attrs` for a button row. */
export function listRow({ title, subtitle = "", leading = "", trailing = "", chevron = false, href = "", attrs = "" }) {
  const inner = `${leading}
      <span class="m-row-text">
        <span class="m-row-title">${escapeHtml(title)}</span>
        ${subtitle ? `<span class="m-row-sub">${escapeHtml(subtitle)}</span>` : ""}
      </span>
      ${trailing}
      ${chevron ? icon("keyboard_arrow_right", { cls: "m-row-chevron" }) : ""}`;
  if (href) return `<a class="m-row" href="${escapeHtml(href)}" ${attrs}>${inner}</a>`;
  if (attrs) return `<button type="button" class="m-row" ${attrs}>${inner}</button>`;
  return `<div class="m-row">${inner}</div>`;
}

export function spinner(label = "") {
  return `<span class="m-spinner" role="progressbar" ${label ? `aria-label="${escapeHtml(label)}"` : 'aria-hidden="true"'}></span>`;
}
