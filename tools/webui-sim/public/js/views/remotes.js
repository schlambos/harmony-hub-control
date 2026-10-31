/* Remotes (#remotes, under Settings): the remotes paired with the hub, a
   pairing window for one more, then a section for each paired remote, all
   built the same way: rows that open a page. Every remote with keys gets
   "Buttons for each activity", one row per activity opening the same editor
   (#touch/<id>/<remote>); the Smart Control also gets its activity buttons
   (#activitybuttons). When two remotes with keys are paired, "Keys on both
   remotes" compares them with neither as the reference and copies either
   way. Models in remotes-model.js.

   Pairing never touches a remote of another kind: hal keeps one remote per
   kind and replaces only an older one of the same kind. The page reads the
   slot table before and after the window and says exactly what changed. */

import * as api from "../api.js";
import * as hub from "../state.js";
import { confirmDialog, escapeHtml, iconTile, listRow, sectionLabel, snackbar, spinner } from "../ui/shell.js";
import {
  ACTIVITY_BUTTONS,
  PAIRING_STEPS,
  SMART_CONTROL_EQUAD,
  TOUCH_EQUAD,
  buildKeyCopyMapList,
  keyComparison,
  pairOutcome,
  parseRfInfo,
  readActivityButtons,
} from "./remotes-model.js";
import { saveMapList } from "./map-save.js";

const SMART_CONTROL_STEPS = `On a Harmony Smart Control, ${PAIRING_STEPS[SMART_CONTROL_EQUAD]}.`;

/* The hub allows up to 120 s, but the request lasts the whole window plus
   hal's clean-up, and the macOS app gives up on a request after 120 s. */
const WINDOWS = [30, 60];
const DEFAULT_WINDOW = 60;

/* Remotes whose keys this page can open per activity, and the map each uses. */
const KEY_REMOTES = { "smart-control": SMART_CONTROL_EQUAD, screen: TOUCH_EQUAD };

export function createRemotesView(section) {
  let remotes = undefined; // parsed rf.info; null when it couldn't be read
  let remotesBusy = false; // the hub says a pairing window is open
  let windowSeconds = DEFAULT_WINDOW;
  let pairing = null; // { endsAt } while this page holds a window open
  let outcome = null; // pairOutcome of the last window
  let saving = false; // copying keys between remotes
  let timer = null;

  section.innerHTML = `<div class="page" id="remotesRoot"></div>`;
  const root = section.querySelector("#remotesRoot");

  const busy = () => Boolean(pairing) || saving;
  const paired = () => remotes?.remotes ?? [];
  const pairedByRole = (role) => paired().find((r) => r.role === role) ?? null;

  function remoteRow(r) {
    // A screen remote other than the Touch shows its skin, which tells which model it is.
    const skin = r.role === "screen" && r.short === "screen remote" && r.skinId ? ` · skin ${r.skinId}` : "";
    return listRow({
      title: r.name,
      subtitle: `Slot ${r.slot}${skin}`,
      leading: iconTile("settings_remote", { size: 44, tone: "hub" }),
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
        return `<div class="notice notice-ok" role="status"><strong>Paired:</strong> that remote was already this hub's, so it kept its slot and nothing else changed.${keptText}</div>`;
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
          <p><strong>Put the remote in pairing mode now.</strong> ${escapeHtml(SMART_CONTROL_STEPS)}</p>
          <p class="list-note">${left > 0 ? `${left} s left.` : "Closing the window…"} Don't press the button on the hub while it's open.</p>
        </div>`;
    }
    const options = WINDOWS.map((s) => `<option value="${s}"${s === windowSeconds ? " selected" : ""}>${s} seconds</option>`).join("");
    return `${sectionLabel("Pair a remote")}
      <div class="m-card">
        <p>The hub opens its pairing window. While it's open, put the remote in pairing mode. ${escapeHtml(SMART_CONTROL_STEPS)} Other remotes use their own pairing steps.</p>
        <p class="list-note">The hub keeps one remote of each kind: a new remote replaces an older one of the same kind, and remotes of other kinds stay paired. Nothing goes through Logitech's servers.</p>
        ${outcomeNotice()}
        <div class="actions">
          <label class="remotes-window">Window <select data-window${busy() ? " disabled" : ""}>${options}</select></label>
          <button type="button" class="btn btn-filled" data-act="pair"${busy() || remotesBusy ? " disabled" : ""}>Open pairing window</button>
        </div>
      </div>`;
  }

  /* The same card for every remote with keys: a row per activity opening
     that remote's keys (and, for the Touch, its screen and gestures). */
  function activitiesCard(remote) {
    const acts = hub.activities();
    const what = remote.role === "screen" ? "On-screen buttons, hard keys and gestures" : "Its keys";
    const note = remote.role === "screen" && remote.short !== "Touch"
      ? `<p class="list-note">The editor was built and tested with the Harmony Touch. Other remotes with a screen answer from the same maps.</p>`
      : "";
    return `<div class="m-card">
        <div class="m-card-head"><span>Buttons for each activity</span></div>
        <p class="list-note">${what}, set per activity.</p>
        ${note}
        ${acts.length
          ? `<div class="m-list">${acts.map((a) => listRow({
              title: hub.activityName(a),
              href: `#touch/${encodeURIComponent(String(a["Id-"]))}/${KEY_REMOTES[remote.role]}`,
              chevron: true,
            })).join("")}</div>`
          : `<p class="list-note">This hub has no activities yet.</p>`}
      </div>`;
  }

  function activityButtonsCard() {
    const rows = readActivityButtons(hub.state.config).rows;
    const name = (id) => {
      if (id === null) return "set elsewhere";
      if (!id) return "nothing";
      const activity = hub.activityById(id);
      return activity ? hub.activityName(activity) : "deleted activity";
    };
    const summary = rows.map((r) => `${r.label}: ${name(r.press)}`).join(" · ");
    return `<div class="m-card">
        <div class="m-card-head"><span>Activity buttons</span></div>
        <div class="m-list">${listRow({
          title: ACTIVITY_BUTTONS.map((b) => b.label).join(", "),
          subtitle: summary,
          href: "#activitybuttons",
          chevron: true,
        })}</div>
      </div>`;
  }

  function remoteSection(remote) {
    let body;
    if (remote.role === "smart-control") body = `${activityButtonsCard()}${activitiesCard(remote)}`;
    else if (remote.role === "screen") body = activitiesCard(remote);
    else body = `<div class="m-card"><p class="list-note">Nothing to set for this remote here yet.</p></div>`;
    return `${sectionLabel(remote.name)}<div class="remotes-section">${body}</div>`;
  }

  /* How many keys each copy would write, worked out once per hub revision
     (the page redraws every second while a pairing window is open). */
  let counts = { revision: null };
  function copyCounts() {
    const config = hub.state.config;
    if (counts.revision !== config.revision) {
      counts = {
        revision: config.revision,
        toTouch: buildKeyCopyMapList(config, SMART_CONTROL_EQUAD).copied,
        toSmart: buildKeyCopyMapList(config, TOUCH_EQUAD).copied,
      };
    }
    return counts;
  }

  /* Keys on both remotes: the Smart Control against the screen remote, with
     neither as the reference. */
  function bothKeysSection(smart, screen) {
    const rows = keyComparison(hub.state.config);
    if (!rows.length) return "";
    const s = smart.short;
    const t = screen.short;
    const line = (p) => {
      const missingMap = !p.smartMap ? smart : !p.touchMap ? screen : null;
      if (missingMap) {
        return listRow({
          title: p.name,
          subtitle: `The ${missingMap.short} has no keys here yet.`,
          href: `#touch/${encodeURIComponent(p.activityId)}/${KEY_REMOTES[missingMap.role]}`,
          chevron: true,
        });
      }
      const parts = [];
      if (p.differ.length) parts.push(`different: ${p.differ.join(", ")}`);
      if (p.onlySmart.length) parts.push(`only on the ${s}: ${p.onlySmart.join(", ")}`);
      if (p.onlyTouch.length) parts.push(`only on the ${t}: ${p.onlyTouch.join(", ")}`);
      return listRow({ title: p.name, subtitle: parts.length ? parts.join(" · ") : "Same keys on both" });
    };
    const { toTouch, toSmart } = copyCounts();
    const uncopyable = [...new Set(rows.flatMap((p) => [...p.noCopyToSmart, ...p.noCopyToTouch]))];
    const button = (from, count, label) => `<button type="button" class="btn btn-outlined" data-copy="${from}"${busy() || !count ? " disabled" : ""}>${escapeHtml(label)}</button>`;
    return `${sectionLabel("Keys on both remotes")}
      <div class="m-card">
        <p class="list-note">Each remote has its own key map, so a key changed for one leaves the other on the old command. Only keys both remotes have are compared.</p>
        <div class="m-list">${rows.map(line).join("")}</div>
        ${uncopyable.length ? `<p class="list-note">Keys that run a sequence aren't copied (${escapeHtml(uncopyable.join(", "))}); set those in Activity setup.</p>` : ""}
        <div class="actions remotes-copy">
          ${button(SMART_CONTROL_EQUAD, toTouch, `Copy the ${s}'s keys to the ${t}`)}
          ${button(TOUCH_EQUAD, toSmart, `Copy the ${t}'s keys to the ${s}`)}
        </div>
      </div>`;
  }

  function render() {
    if (section.hidden) return;
    if (!hub.state.config && !hub.state.configError) {
      root.innerHTML = `${remotesCard()}${pairCard()}<div class="m-center">${spinner("Loading")}</div>`;
      return;
    }
    let sections = "";
    if (hub.state.config) {
      sections = paired().map(remoteSection).join("");
      const smart = pairedByRole("smart-control");
      const screen = pairedByRole("screen");
      if (smart && screen) sections += bothKeysSection(smart, screen);
    }
    root.innerHTML = `${remotesCard()}${pairCard()}${sections}`;
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
    const now = paired().map((r) => `${r.name} (slot ${r.slot})`).join(", ");
    const ok = await confirmDialog({
      title: "Open the pairing window?",
      text: now
        ? `Paired now: ${now}. A new remote of one of those kinds replaces that one; a remote of any other kind joins alongside them.`
        : "The hub keeps one remote of each kind. No remotes are paired with it now.",
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

  async function copyKeys(from) {
    if (busy()) return;
    const source = pairedByRole(from === SMART_CONTROL_EQUAD ? "smart-control" : "screen");
    const target = pairedByRole(from === SMART_CONTROL_EQUAD ? "screen" : "smart-control");
    if (!source || !target) return;
    const { mapList, copied } = buildKeyCopyMapList(hub.state.config, from);
    if (!copied) return;
    const ok = await confirmDialog({
      title: `Copy the ${source.short}'s keys to the ${target.short}?`,
      text: `${copied} key${copied === 1 ? "" : "s"} on the ${target.short} will do what they do on the ${source.short}. Keys only the ${target.short} has stay as they are.`,
      confirmLabel: "Copy",
    });
    if (!ok) return;
    saving = true;
    render();
    await saveMapList(mapList, {
      done: `Copied ${copied} key${copied === 1 ? "" : "s"} from the ${source.short} to the ${target.short}.`,
      check: (config) => (buildKeyCopyMapList(config, from).copied === 0 ? "saved" : "unchanged"),
    });
    saving = false;
    render();
  }

  root.addEventListener("change", (event) => {
    if (event.target.matches("select[data-window]")) {
      windowSeconds = Number(event.target.value) || DEFAULT_WINDOW;
    }
  });

  root.addEventListener("click", (event) => {
    const copy = event.target.closest("[data-copy]");
    if (copy) {
      copyKeys(copy.dataset.copy);
      return;
    }
    const act = event.target.closest("[data-act]")?.dataset.act;
    if (act === "refresh") {
      remotes = undefined;
      render();
      loadRemotes();
      hub.reloadConfig();
    } else if (act === "pair") pair();
  });

  hub.subscribe(() => render());

  async function confirmLeave() {
    if (saving) {
      snackbar("Saving to the hub… one moment");
      return false;
    }
    if (!pairing) return true;
    return confirmDialog({
      title: "Leave while the window is open?",
      text: "The hub keeps its pairing window open until it closes by itself. You won't see what changed here; Remotes shows the list again afterwards.",
      confirmLabel: "Leave",
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
