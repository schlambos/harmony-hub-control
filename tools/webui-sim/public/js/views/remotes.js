/* Remotes (#remotes, under Settings): the remotes paired with the hub, a
   pairing window for one more, the Harmony Smart Control's activity buttons,
   and the keys it shares with the Touch. Models in remotes-model.js.

   Pairing never touches a remote of another kind: hal keeps one remote per
   kind and replaces only an older one of the same kind. The page reads the
   slot table before and after the window and says exactly what changed. */

import * as api from "../api.js";
import * as hub from "../state.js";
import { confirmDialog, escapeHtml, iconTile, listRow, sectionLabel, snackbar, spinner } from "../ui/shell.js";
import {
  SMART_CONTROL_EQUAD,
  activityButtonsSaveOutcome,
  buildActivityButtonsMapList,
  buildKeyParityMapList,
  keyParity,
  pairOutcome,
  parseRfInfo,
  readActivityButtons,
  remoteKindName,
} from "./remotes-model.js";

/* The hub allows up to 120 s, but the request lasts the whole window plus
   hal's clean-up, and the macOS app gives up on a request after 120 s. */
const WINDOWS = [30, 60];
const DEFAULT_WINDOW = 60;

export function createRemotesView(section) {
  let remotes = undefined; // parsed rf.info; null when it couldn't be read
  let remotesBusy = false; // the hub says a pairing window is open
  let windowSeconds = DEFAULT_WINDOW;
  let pairing = null; // { endsAt } while this page holds a window open
  let outcome = null; // pairOutcome of the last window
  let rows = null; // activity-button draft
  let baseRows = null;
  let dirty = false;
  let saving = false;
  let timer = null;

  section.innerHTML = `<div class="page" id="remotesRoot"></div>`;
  const root = section.querySelector("#remotesRoot");

  const busy = () => Boolean(pairing) || saving;
  // A button left on a deleted activity needs a save even when nothing was picked.
  const needsSave = () => dirty || Boolean(rows?.some((r) => r.missing.length));

  function remoteRow(r) {
    const smart = r.equadId === SMART_CONTROL_EQUAD;
    return listRow({
      title: r.name,
      subtitle: `Slot ${r.slot}`,
      leading: iconTile(smart ? "settings_remote" : "settings_remote_outlined", { size: 44, tone: smart ? "hub" : "" }),
    });
  }

  function remotesCard() {
    let body;
    if (remotesBusy && !pairing) {
      body = `<p class="list-note">A pairing window is open on the hub. The list shows again when it closes.</p>`;
    } else if (remotes === undefined) {
      body = `<div class="m-center remotes-loading">${spinner("Loading")}</div>`;
    } else if (remotes === null) {
      body = `<p class="list-note">The hub's radio didn't list its remotes. Try Refresh.</p>`;
    } else if (!remotes.remotes.length) {
      body = `<p class="list-note">No remotes are paired with this hub.</p>`;
    } else {
      body = `<div class="m-list">${remotes.remotes.map(remoteRow).join("")}</div>`;
    }
    return `${sectionLabel("Paired with this hub")}
      <div class="m-card">
        <div class="m-card-head"><span>Remotes</span>
          <button type="button" class="btn btn-text btn-sm" data-act="refresh"${busy() ? " disabled" : ""}>Refresh</button>
        </div>
        ${body}
      </div>`;
  }

  function outcomeNotice() {
    if (!outcome) return "";
    const list = (items) => items.map((r) => `${escapeHtml(r.name)} in slot ${r.slot}`).join(", ");
    const kept = (outcome.remotes ?? []).filter((r) => !outcome.added.some((a) => a.slot === r.slot));
    const keptText = kept.length ? ` Still paired: ${list(kept)}.` : "";
    switch (outcome.status) {
      case "paired": {
        const replaced = outcome.replaced.length
          ? ` It replaced the older ${list(outcome.replaced)}; the hub keeps one remote of each kind.`
          : "";
        return `<div class="notice notice-ok" role="status"><strong>Paired:</strong> ${list(outcome.added)}.${replaced}${keptText}</div>`;
      }
      case "lost":
        return `<div class="notice notice-error" role="alert"><strong>A remote of another kind is no longer paired:</strong> ${list(outcome.lost)}.${outcome.added.length ? ` Joined: ${list(outcome.added)}.` : ""} Pair it again with its own steps.</div>`;
      case "already":
        return `<div class="notice notice-info" role="status">The hub reported a pair, but no slot changed: that remote was already paired.${keptText}</div>`;
      case "timeout":
        return `<div class="notice notice-warn" role="status">No remote joined while the window was open. Check the remote's battery, keep it near the hub, and hold the keys until the window closes.</div>`;
      default:
        return `<div class="notice notice-warn" role="status">The window closed, but the hub's radio didn't list its remotes afterwards. Refresh to see what's paired.</div>`;
    }
  }

  function pairCard() {
    if (pairing) {
      const left = Math.max(0, Math.ceil((pairing.endsAt - Date.now()) / 1000));
      return `${sectionLabel("Pair a remote")}
        <div class="m-card remotes-pairing" aria-live="polite">
          <div class="m-card-head"><span>Pairing window open</span>${spinner("Pairing")}</div>
          <p><strong>On a Harmony Smart Control, hold Menu and Mute together for about 5 seconds.</strong></p>
          <p class="list-note">${left > 0 ? `${left} s left.` : "Closing the window…"} Don't press the button on the hub while it's open.</p>
        </div>`;
    }
    const options = WINDOWS.map((s) => `<option value="${s}"${s === windowSeconds ? " selected" : ""}>${s} seconds</option>`).join("");
    return `${sectionLabel("Pair a remote")}
      <div class="m-card">
        <p>The hub opens its pairing window. While it's open, hold <strong>Menu</strong> and <strong>Mute</strong> on a Harmony Smart Control for about 5 seconds. Other remotes use their own pairing steps.</p>
        <p class="list-note">The hub keeps one remote of each kind, so pairing a Smart Control replaces an older Smart Control. Remotes of other kinds, like a Harmony Touch, stay paired. Nothing goes through Logitech's servers.</p>
        ${outcomeNotice()}
        <div class="actions">
          <label class="remotes-window">Window <select data-window${busy() ? " disabled" : ""}>${options}</select></label>
          <button type="button" class="btn btn-filled" data-act="pair"${busy() || remotesBusy ? " disabled" : ""}>Open pairing window</button>
        </div>
      </div>`;
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
    return `<select aria-label="${escapeHtml(label)}" data-key="${row.key}" data-field="${field}"${busy() ? " disabled" : ""}>${activityOptions(value)}</select>`;
  }

  function buttonsCard() {
    if (!hub.state.config) return "";
    const missing = rows.some((r) => r.missing.length);
    return `${sectionLabel("Smart Control activity buttons")}
      <div class="m-card">
        <p class="list-note">Each button starts one activity on a press and another on a long press. Off turns everything off by itself.</p>
        ${missing ? `<div class="notice notice-warn" role="status">A button still names an activity that was deleted. Saving sets it to Nothing, or pick another activity first.</div>` : ""}
        <div class="remotes-buttons" role="group" aria-label="Activity buttons">
          <span class="remotes-buttons-head">Button</span><span class="remotes-buttons-head">Press</span><span class="remotes-buttons-head">Long press</span>
          ${rows.map((row) => `<span class="remotes-buttons-key">${escapeHtml(row.label)}</span>${buttonSelect(row, "press")}${buttonSelect(row, "longPress")}`).join("")}
        </div>
        <div class="actions">
          <button type="button" class="btn btn-text" data-act="undo"${!dirty || busy() ? " disabled" : ""}>Undo</button>
          <button type="button" class="btn btn-filled" data-act="save"${!needsSave() || busy() ? " disabled" : ""}>${saving ? "Saving…" : "Save"}</button>
        </div>
      </div>`;
  }

  function parityCard() {
    if (!hub.state.config) return "";
    const parity = keyParity(hub.state.config);
    if (!parity.length) return "";
    const fixable = parity.some((p) => p.missing.length || p.differs.length);
    const line = (p) => {
      if (!p.smartMap) {
        return listRow({
          title: p.name,
          subtitle: "The Smart Control does nothing here yet. Open Activity setup and save to give it keys.",
          href: `#wizard/${encodeURIComponent(p.activityId)}`,
          chevron: true,
        });
      }
      const parts = [];
      if (p.missing.length) parts.push(`missing ${p.missing.join(", ")}`);
      if (p.differs.length) parts.push(`different ${p.differs.join(", ")}`);
      if (p.skipped.length) parts.push(`set in Activity setup: ${p.skipped.join(", ")}`);
      const subtitle = !p.touchMap
        ? "No Touch keys to compare"
        : parts.length ? `Unlike the Touch: ${parts.join("; ")}` : "Same keys as the Touch";
      return listRow({ title: p.name, subtitle });
    };
    return `${sectionLabel("Same keys as the Touch")}
      <div class="m-card">
        <p class="list-note">Each remote has its own key map. A key changed only for the Touch leaves the Smart Control on the old command.</p>
        <div class="m-list">${parity.map(line).join("")}</div>
        ${fixable ? `<div class="actions"><button type="button" class="btn btn-filled" data-act="parity"${busy() || dirty ? " disabled" : ""}>Copy the Touch's keys to the Smart Control</button></div>` : ""}
      </div>`;
  }

  function render() {
    if (section.hidden) return;
    if (!hub.state.config && !hub.state.configError) {
      root.innerHTML = `${remotesCard()}${pairCard()}<div class="m-center">${spinner("Loading")}</div>`;
      return;
    }
    if (hub.state.config && !rows) {
      baseRows = readActivityButtons(hub.state.config).rows;
      rows = structuredClone(baseRows);
    }
    root.innerHTML = `${remotesCard()}${pairCard()}${buttonsCard()}${parityCard()}`;
  }

  async function loadRemotes() {
    try {
      const reply = await api.getRemotes();
      remotesBusy = Boolean(reply.pairing);
      if (!remotesBusy) remotes = parseRfInfo(reply.reply);
    } catch (_) {
      remotesBusy = false;
      remotes = null;
    }
    render();
  }

  async function pair() {
    if (busy()) return;
    const smart = remotes?.remotes?.find((r) => r.equadId === SMART_CONTROL_EQUAD);
    const ok = await confirmDialog({
      title: "Open the pairing window?",
      text: smart
        ? `This hub already has a ${remoteKindName(smart.equadId)} in slot ${smart.slot}. If you pair a different Smart Control, the hub replaces that one. Remotes of other kinds stay paired.`
        : "Remotes already paired stay paired, unless the new one is the same kind as one of them: the hub keeps one remote of each kind.",
      confirmLabel: "Open window",
    });
    if (!ok) return;
    outcome = null;
    pairing = { endsAt: Date.now() + windowSeconds * 1000 };
    clearInterval(timer);
    timer = setInterval(render, 1000);
    render();
    try {
      const reply = await api.pairRemote({ seconds: windowSeconds });
      outcome = pairOutcome(reply);
      if (outcome.remotes) remotes = parseRfInfo(reply.after);
      remotesBusy = false;
    } catch (error) {
      // 409 and 502 come before the window opens; anything else may come after.
      const message = error.status === 409 ? "A pairing window is already open on the hub. Wait for it to close."
        : error.status === 502 ? error.message
        : `No answer about the pairing window — ${error.message || "hub error"}. The list below shows what's paired now.`;
      snackbar(message, { error: true });
    } finally {
      clearInterval(timer);
      timer = null;
      pairing = null;
    }
    if (!outcome || outcome.status === "unknown") await loadRemotes();
    render();
  }

  /* The hub can apply a save and still report a failure (a slow engine), so
     look at what it has before saying what happened. */
  async function saveMapList(mapList, { done, check }) {
    saving = true;
    render();
    const payload = {
      baseRevision: hub.state.config.revision,
      activityList: structuredClone(hub.state.config.activityList),
      mapList,
      functionList: structuredClone(hub.state.config.functionList),
    };
    // A save that didn't land keeps the changes on screen to try again.
    const draft = { rows, baseRows, dirty };
    let keep = false;
    try {
      await api.saveActivity(payload);
      await hub.reloadConfig();
      snackbar(done);
    } catch (error) {
      await hub.reloadConfig();
      const result = hub.state.configError ? "unknown" : check(hub.state.config);
      if (result === "saved") snackbar(`${done} The hub was slow to confirm.`);
      else if (error.status === 504) {
        keep = true;
        snackbar("The hub is still saving. Your changes are still here; reload in a minute to see whether they landed before you save again.", { error: true });
      } else if (result === "unchanged") {
        keep = true;
        snackbar(`Not saved — ${error.message || "hub error"}. Nothing changed on the hub; your changes are still here.`, { error: true });
      } else snackbar(`Couldn't save — ${error.message || "hub error"}. This shows what the hub has now.`, { error: true });
    } finally {
      saving = false;
      if (keep) ({ rows, baseRows, dirty } = draft);
      else {
        rows = null;
        dirty = false;
      }
      render();
    }
  }

  async function saveButtons() {
    if (busy() || !needsSave()) return;
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
    const base = baseRows;
    const sent = rows;
    await saveMapList(built.mapList, {
      done: "Saved. The Smart Control uses the new buttons at once.",
      check: (config) => activityButtonsSaveOutcome(config, base, sent),
    });
  }

  async function copyTouchKeys() {
    if (busy() || dirty) return;
    const { mapList, copied } = buildKeyParityMapList(hub.state.config);
    if (!copied) return;
    await saveMapList(mapList, {
      done: `Copied ${copied} key${copied === 1 ? "" : "s"} from the Touch to the Smart Control.`,
      check: (config) => {
        const left = keyParity(config).reduce((n, p) => n + p.missing.length + p.differs.length, 0);
        return left === 0 ? "saved" : "unchanged";
      },
    });
  }

  root.addEventListener("change", (event) => {
    const select = event.target.closest("select[data-key]");
    if (select) {
      const row = rows.find((r) => r.key === select.dataset.key);
      if (!row) return;
      row[select.dataset.field] = select.value;
      row.missing = [row.press, row.longPress].filter((id) => id && !hub.activityById(id));
      dirty = rows.some((r, i) => r.press !== baseRows[i].press || r.longPress !== baseRows[i].longPress);
      render();
      return;
    }
    if (event.target.matches("select[data-window]")) {
      windowSeconds = Number(event.target.value) || DEFAULT_WINDOW;
    }
  });

  root.addEventListener("click", (event) => {
    const act = event.target.closest("[data-act]")?.dataset.act;
    if (act === "refresh") {
      remotes = undefined;
      render();
      loadRemotes();
      hub.reloadConfig().then(() => {
        rows = null;
        dirty = false;
        render();
      });
    } else if (act === "pair") pair();
    else if (act === "save") saveButtons();
    else if (act === "undo") {
      rows = structuredClone(baseRows);
      dirty = false;
      render();
    } else if (act === "parity") copyTouchKeys();
  });

  hub.subscribe(() => {
    if (!dirty && !saving) rows = null;
    render();
  });

  async function confirmLeave() {
    if (pairing) {
      return confirmDialog({
        title: "Leave while the window is open?",
        text: "The hub keeps its pairing window open until it closes by itself. You won't see what changed here; Remotes shows the list again afterwards.",
        confirmLabel: "Leave",
      });
    }
    if (!dirty) return true;
    return confirmDialog({
      title: "Discard your changes?",
      text: "The activity buttons you changed aren't saved.",
      confirmLabel: "Discard",
      destructive: true,
    });
  }

  return {
    onShow() {
      hub.ensureConfig();
      if (!pairing) {
        remotes = undefined;
        loadRemotes();
      }
      render();
    },
    onHide() {},
    confirmLeave,
  };
}
