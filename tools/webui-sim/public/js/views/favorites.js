/* Favorite channels (#favorites/<activityId>, from an activity's ⋮ menu):
   the channels a screen remote lists for the activity, each with a number, a
   name and a logo. They belong to the activity's channel changing device,
   so every activity that changes channels on that device shows the same
   list. Add, edit, reorder and delete here; logos are uploaded pictures.
   Nothing reaches the hub until Save. docs/REMOTE_IMAGES.md */

import { ApiError, getFavorites, saveFavorites } from "../api.js";
import * as hub from "../state.js";
import {
  confirmDialog,
  escapeHtml,
  icon,
  iconTile,
  openSheet,
  setAppBar,
  snackbar,
  spinner,
} from "../ui/shell.js";
import { fieldId, setMessage } from "./device-sheets.js";
import {
  LOGO_SIZE,
  NUMBER_MAX,
  channelDeviceId,
  favoriteErrors,
  favoritesFromReply,
  favoritesSaveBody,
  favoritesSignature,
  fitRect,
  fitsOneRequest,
  logoUrl,
  moveFavorite,
  newFavorite,
  sharingActivities,
} from "./favorites-model.js";

/* A picture file as a LOGO_SIZE square PNG data URL: scaled to fit, centred,
   the rest transparent. Read as a data: URL, because the desktop app's
   pages may only load images from the app itself and data: URLs. */
function logoFromFile(file) {
  return new Promise((resolve, reject) => {
    const refuse = () => reject(new Error("That file isn't a picture this browser can open."));
    const reader = new FileReader();
    reader.onerror = refuse;
    reader.onload = () => {
      const image = new Image();
      image.onerror = refuse;
      image.onload = () => {
        const canvas = document.createElement("canvas");
        canvas.width = LOGO_SIZE;
        canvas.height = LOGO_SIZE;
        const r = fitRect(image.naturalWidth, image.naturalHeight);
        const ctx = canvas.getContext("2d");
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(image, r.x, r.y, r.width, r.height);
        resolve(canvas.toDataURL("image/png"));
      };
      image.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  });
}

/* A favorite's logo in a tile; a TV glyph when it has none (or the hub
   doesn't hold it). */
function logoTile(favorite, size) {
  const url = favorite.upload || logoUrl(favorite.logo);
  if (!url) return `<span class="fav-logo">${iconTile("tv_outlined", { size })}</span>`;
  return `<span class="fav-logo"><span class="m-tile m-tile--image" style="--tile:${size}px">${icon("tv_outlined", { size: Math.round(size * 0.5) })}<img class="m-tile-img" src="${escapeHtml(url)}" alt=""></span></span>`;
}

export function createFavoritesView(section) {
  let activityId = "";
  let deviceId = "";
  let reply = null; // the hub's last answer for this device
  let list = []; // the list being edited
  let saved = ""; // favoritesSignature of the hub's list
  let saving = false;
  let blocked = ""; // "", "missing", "nodevice", "error", "old", "cannot"
  let blockedText = "";
  let sheet = null;
  let showToken = 0;

  section.innerHTML = `<div class="wiz favorites" id="favoritesRoot"></div>`;
  const root = section.querySelector("#favoritesRoot");

  const dirty = () => !blocked && reply != null && favoritesSignature(list) !== saved;
  const max = () => Number(reply?.max) || 64;
  const activityName = () => hub.activityName(hub.activityById(activityId));
  const deviceName = () => hub.deviceName(deviceId) || "the channel device";

  function updateBar() {
    if (section.hidden) return;
    setAppBar({ title: "Favorite channels", back: "activities", close: dirty(), onBack: requestClose });
  }

  /* -- markup ------------------------------------------------------------------ */

  function row(favorite, index) {
    const label = favorite.name || "this favorite";
    return `<div class="m-row fav-row" data-key="${escapeHtml(favorite.key)}">
        <button type="button" class="fav-main" data-edit="${escapeHtml(favorite.key)}" aria-haspopup="dialog" aria-label="Edit ${escapeHtml(label)}">
          ${logoTile(favorite, 48)}
          <span class="m-row-text">
            <span class="m-row-title">${escapeHtml(favorite.name)}</span>
            <span class="m-row-sub">Channel ${escapeHtml(favorite.number)}</span>
          </span>
        </button>
        <button type="button" class="icon-btn" data-move="${escapeHtml(favorite.key)}" data-step="-1" aria-label="Move ${escapeHtml(label)} up"${index > 0 && !saving ? "" : " disabled"}>${icon("keyboard_arrow_up")}</button>
        <button type="button" class="icon-btn" data-move="${escapeHtml(favorite.key)}" data-step="1" aria-label="Move ${escapeHtml(label)} down"${index < list.length - 1 && !saving ? "" : " disabled"}>${icon("keyboard_arrow_down")}</button>
        <button type="button" class="icon-btn" data-delete="${escapeHtml(favorite.key)}" aria-label="Delete ${escapeHtml(label)}"${saving ? " disabled" : ""}>${icon("delete_outlined")}</button>
      </div>`;
  }

  function introMarkup() {
    const others = sharingActivities(hub.activities(), deviceId, activityId);
    const shared = others.length
      ? ` ${others.map((n) => `“${n}”`).join(", ")} ${others.length === 1 ? "changes" : "change"} channels on the same device and ${others.length === 1 ? "shows" : "show"} the same list.`
      : "";
    const tuning = hub.activityById(activityId)?.IsTuningDefault === false
      ? `<p class="wiz-hint">“${escapeHtml(activityName())}” isn't the hub's default activity for watching TV; the remote may not list favorites in it.</p>`
      : "";
    return `<div class="wiz-intro">
        <h2 tabindex="-1">${escapeHtml(activityName())}</h2>
        <p>${escapeHtml(`The remote lists these channels in this activity. Choosing one sends its number to ${deviceName()}.${shared}`)}</p>
      </div>${tuning}`;
  }

  function bodyMarkup() {
    const full = list.length >= max();
    return `${introMarkup()}
      ${list.length
        ? `<div class="m-list">${list.map(row).join("")}</div>`
        : `<p class="list-note">No favorite channels yet.</p>`}
      <button type="button" class="btn btn-tonal btn-block" data-act="add"${full || saving ? " disabled" : ""}>${icon("add", { size: 20 })}Add a favorite</button>
      ${full ? `<p class="wiz-hint">A device can have at most ${max()} favorites.</p>` : ""}
      ${dirty() ? `<p class="wiz-hint">Nothing reaches the hub until you save.</p>` : ""}`;
  }

  function footMarkup() {
    const can = dirty() && !saving;
    return `<div class="wiz-foot">
        <button type="button" class="btn btn-outlined" data-act="undo"${can ? "" : " disabled"}>Undo changes</button>
        <button type="button" class="btn btn-filled${saving ? " is-busy" : ""}" data-act="save"${can ? "" : " disabled"}${saving ? ' aria-busy="true"' : ""}>
          ${saving ? `${spinner()}Saving to hub…` : "Save to hub"}
        </button>
      </div>`;
  }

  const BLOCKED = {
    missing: ["info_outlined", "This activity isn't on the hub any more", "It may have been deleted from another screen."],
    nodevice: ["info_outlined", "This activity doesn't change channels", "The remote lists favorite channels only in an activity that has a device for changing channels. Edit the activity to choose one."],
    old: ["info_outlined", "The hub's software is older than this app", "Update the hub to edit favorite channels."],
    cannot: ["info_outlined", "This device can't have favorite channels", ""],
    error: ["wifi_off", "Couldn't read the favorite channels", ""],
  };

  function renderBlocked(kind, text = "") {
    blocked = kind;
    blockedText = text;
    updateBar();
    const [glyph, title, body] = BLOCKED[kind];
    root.innerHTML = `<div class="m-empty">
        ${iconTile(glyph, { size: 64, tone: kind === "error" ? "error" : "" })}
        <h2 class="m-empty-title">${escapeHtml(title)}</h2>
        <p class="m-empty-body">${escapeHtml(blockedText || body)}</p>
        ${kind === "error"
          ? `<button type="button" class="btn btn-filled" data-act="retry">Try again</button>`
          : `<a class="btn btn-filled" href="#activities">Back to activities</a>`}
      </div>`;
  }

  function render() {
    updateBar();
    if (blocked || !reply || section.hidden) return;
    const focused = document.activeElement;
    let keep = "";
    if (root.contains(focused)) {
      for (const attr of ["data-edit", "data-move", "data-delete", "data-act"]) {
        if (focused.hasAttribute(attr)) {
          keep = `[${attr}="${CSS.escape(focused.getAttribute(attr))}"]${attr === "data-move" ? `[data-step="${focused.dataset.step}"]` : ""}`;
          break;
        }
      }
    }
    root.innerHTML = `<div class="wiz-body">${bodyMarkup()}</div>${footMarkup()}`;
    if (keep) root.querySelector(`${keep}:not(:disabled)`)?.focus({ preventScroll: true });
  }

  /* -- the hub ------------------------------------------------------------------- */

  function adopt(answer) {
    reply = answer;
    list = favoritesFromReply(answer);
    saved = favoritesSignature(list);
  }

  async function load(token) {
    try {
      const answer = await getFavorites(deviceId);
      if (token !== showToken || section.hidden) return;
      if (!answer.exists && !answer.canCreate) {
        const reason = String(answer.reason ?? "");
        renderBlocked("cannot", reason ? `${deviceName()}: ${reason}.` : "");
        return;
      }
      blocked = "";
      adopt(answer);
      render();
      root.querySelector(".wiz-intro h2")?.focus({ preventScroll: true });
    } catch (error) {
      if (token !== showToken || section.hidden) return;
      if (error instanceof ApiError && error.status === 404) renderBlocked("old");
      else renderBlocked("error", error.message || "The hub didn't answer.");
    }
  }

  async function save() {
    if (saving || !dirty()) return;
    const body = favoritesSaveBody({ deviceId, etag: reply.etag, list });
    if (!fitsOneRequest(body)) {
      snackbar("That's too many new logos for one save. Save with fewer, then add the rest.", { error: true });
      return;
    }
    saving = true;
    render();
    try {
      const answer = await saveFavorites(body);
      saving = false;
      adopt(answer);
      // Tiles that showed "no logo on the hub" may have one now.
      document.dispatchEvent(new CustomEvent("melodious:images-changed"));
      snackbar("Saved. The remote gets the favorites when it next syncs.");
    } catch (error) {
      saving = false;
      snackbar(`Couldn't save: ${error.message || "hub error"}`, { error: true });
    }
    if (!section.hidden) render();
  }

  function undo() {
    adopt(reply);
    render();
  }

  async function confirmDiscard() {
    if (saving) {
      snackbar("Saving to the hub… one moment");
      return false;
    }
    if (!dirty()) return true;
    const discard = await confirmDialog({
      title: "Discard changes?",
      text: "Nothing has been saved to the hub yet.",
      confirmLabel: "Discard",
      destructive: true,
    });
    if (discard) adopt(reply);
    return discard;
  }

  async function requestClose() {
    if (await confirmDiscard()) location.hash = "#activities";
  }

  /* -- the sheet: one favorite ---------------------------------------------------- */

  function closeSheet() {
    sheet?.close();
    sheet = null;
  }

  /* `key` null adds a favorite. The sheet edits a copy; Done puts it in the
     list. */
  function openFavoriteSheet(key) {
    const existing = key ? list.find((f) => f.key === key) : null;
    const draft = existing ? { ...existing } : newFavorite();
    const prefix = fieldId("fav");
    let busy = false;
    const opened = openSheet({
      label: existing ? `Edit ${existing.name || "favorite"}` : "Add a favorite",
      onClose: () => {
        if (sheet === opened) sheet = null;
        const back = existing ? `[data-edit="${CSS.escape(existing.key)}"]` : `[data-act="add"]`;
        if (!sheet) root.querySelector(back)?.focus({ preventScroll: true });
      },
      render: (content, close) => {
        function draw() {
          const hasLogo = Boolean(draft.upload || draft.logo);
          content.innerHTML = `<form class="m-form" novalidate>
              <h2 class="sheet-title">${existing ? "Edit favorite" : "Add a favorite"}</h2>
              <div class="m-form-fields">
                <div class="m-field">
                  <label for="${prefix}n">Name</label>
                  <input id="${prefix}n" data-field="name" value="${escapeHtml(draft.name)}" maxlength="64" autocomplete="off" spellcheck="false" required>
                  <p class="m-field-hint" data-error="name"></p>
                </div>
                <div class="m-field">
                  <label for="${prefix}c">Channel number</label>
                  <input id="${prefix}c" data-field="number" value="${escapeHtml(draft.number)}" maxlength="${NUMBER_MAX}" inputmode="decimal" autocomplete="off" required>
                  <p class="m-field-hint" data-error="number">The digits the remote sends, such as 12 or 12-1.</p>
                </div>
              </div>
              <div class="fav-logo-field">
                ${logoTile(draft, 72)}
                <div class="fav-logo-actions">
                  <button type="button" class="btn btn-tonal" data-act="upload"${busy ? " disabled" : ""}>${busy ? spinner("Reading the picture") : ""}${hasLogo ? "Replace logo…" : "Upload logo…"}</button>
                  ${hasLogo ? `<button type="button" class="btn btn-text" data-act="unlogo">Remove logo</button>` : ""}
                </div>
                <input type="file" accept="image/*" data-file hidden>
              </div>
              <p class="m-field-hint">Any picture works; it is scaled to fit a square and keeps its transparent parts. The remote shows it small, so a simple logo reads best.</p>
              <p class="form-msg" data-msg role="status" aria-live="polite"></p>
              <button type="submit" class="btn btn-filled btn-block">Done</button>
            </form>`;
        }

        function showErrors(errors) {
          for (const field of ["name", "number"]) {
            const hint = content.querySelector(`[data-error="${field}"]`);
            if (errors[field]) {
              hint.textContent = errors[field];
              hint.classList.add("is-error");
            }
            content.querySelector(`[data-field="${field}"]`)?.setAttribute("aria-invalid", String(Boolean(errors[field])));
          }
          const first = ["name", "number"].find((field) => errors[field]);
          if (first) content.querySelector(`[data-field="${first}"]`)?.focus();
        }

        content.addEventListener("input", (event) => {
          const field = event.target.dataset?.field;
          if (field) draft[field] = event.target.value;
        });

        content.addEventListener("click", (event) => {
          const act = event.target.closest("[data-act]")?.dataset.act;
          if (act === "upload") content.querySelector("[data-file]").click();
          else if (act === "unlogo") {
            draft.upload = "";
            draft.logo = "";
            draft.image = "";
            draw();
            content.querySelector("[data-act=upload]")?.focus();
          }
        });

        content.addEventListener("change", async (event) => {
          if (!event.target.matches("[data-file]")) return;
          const file = event.target.files?.[0];
          if (!file) return;
          busy = true;
          draw();
          let message = "";
          try {
            draft.upload = await logoFromFile(file);
          } catch (error) {
            message = error.message;
          }
          busy = false;
          if (!opened.dialog.isConnected) return;
          draw();
          setMessage(content.querySelector("[data-msg]"), message, "error");
          content.querySelector("[data-act=upload]")?.focus();
        });

        content.addEventListener("submit", (event) => {
          event.preventDefault();
          const errors = favoriteErrors(draft);
          if (Object.keys(errors).length) {
            showErrors(errors);
            return;
          }
          draft.name = draft.name.trim();
          draft.number = draft.number.trim();
          list = existing ? list.map((f) => (f.key === existing.key ? draft : f)) : [...list, draft];
          close();
          render();
        });

        draw();
        content.querySelector("[data-field=name]")?.focus();
      },
    });
    sheet = opened;
  }

  /* -- events ------------------------------------------------------------------- */

  root.addEventListener("click", (event) => {
    const act = event.target.closest("[data-act]")?.dataset.act;
    if (act === "retry") {
      hub.reloadConfig().then(() => view.onShow({ args: [encodeURIComponent(activityId)] }));
      return;
    }
    if (saving || blocked) return;
    const edit = event.target.closest("[data-edit]");
    if (edit) {
      openFavoriteSheet(edit.dataset.edit);
      return;
    }
    const mover = event.target.closest("[data-move]");
    if (mover) {
      list = moveFavorite(list, list.findIndex((f) => f.key === mover.dataset.move), Number(mover.dataset.step));
      render();
      return;
    }
    const remover = event.target.closest("[data-delete]");
    if (remover) {
      const index = list.findIndex((f) => f.key === remover.dataset.delete);
      list = list.filter((f) => f.key !== remover.dataset.delete);
      render();
      const rows = root.querySelectorAll("[data-edit]");
      (rows[Math.min(index, rows.length - 1)] ?? root.querySelector("[data-act=add]"))?.focus({ preventScroll: true });
      return;
    }
    if (act === "add") openFavoriteSheet(null);
    else if (act === "save") save();
    else if (act === "undo") undo();
  });

  window.addEventListener("beforeunload", (event) => {
    if (!dirty() || section.hidden) return;
    event.preventDefault();
    event.returnValue = "";
  });

  const view = {
    async onShow({ args = [] } = {}) {
      const token = (showToken += 1);
      closeSheet();
      reply = null;
      list = [];
      saved = "";
      saving = false;
      blocked = "";
      try {
        activityId = decodeURIComponent(args[0] ?? "");
      } catch (_) {
        activityId = ""; // a malformed escape is just an unknown activity
      }
      root.innerHTML = `<div class="m-center">${spinner("Loading")}</div>`;
      updateBar();
      await hub.ensureConfig();
      if (token !== showToken || section.hidden) return;
      if (hub.state.configError) {
        renderBlocked("error", hub.state.configError.message || "The hub didn't answer.");
        return;
      }
      const activity = hub.activityById(activityId);
      if (!activity) {
        renderBlocked("missing");
        return;
      }
      deviceId = channelDeviceId(activity);
      if (!deviceId) {
        renderBlocked("nodevice");
        return;
      }
      await load(token);
    },
    onHide() {
      showToken += 1;
      closeSheet();
    },
    confirmLeave: confirmDiscard,
  };
  return view;
}
