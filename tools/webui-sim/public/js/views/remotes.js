/* Remotes (#remotes, under Settings): the remotes paired with the hub, a
   pairing window for one more, then a section for each paired remote, all
   built the same way: rows that open a page. Every remote with keys gets
   "Buttons for each activity", one row per activity opening the same editor
   (#touch/<id>/<EquadID>); a remote without a screen also gets its activity
   buttons (#activitybuttons/<EquadID>), and the Companion its home control
   buttons (#homebuttons, #homebuttons/<id>); so does a Harmony Elite or 950
   (#homebuttons/screen, #homebuttons/screen/<id>). Each remote has its own maps,
   named by its EquadID. Their keys stay alike (the editor changes every remote
   unless a key is set for one remote only), so each activity row only says
   where they differ. Models in remotes-model.js.

   A remote without a screen needs a map of its own for every activity, or
   it does nothing while that activity runs. Pairing one adds the maps it
   lacks, and a remote found without them gets a notice with one button that
   adds them (issue #86).

   Pairing never touches a remote of another kind: stock hal keeps one remote
   per kind and replaces only an older one of the same kind. With multi-remote
   on (the hub says `multiRemote`) only a remote with a screen or a keyboard
   does that; a second remote without a screen of the same model joins the
   first, and the two share that model's maps, so the page shows one section
   per model. The
   page reads the slot table before and after the window and says exactly
   what changed. Each slot can be unpaired. */

import * as api from "../api.js";
import * as hub from "../state.js";
import { confirmDialog, escapeHtml, iconTile, listRow, sectionLabel, snackbar, spinner } from "../ui/shell.js";
import {
  ACTIVITY_BUTTONS,
  PAIRING_STEPS,
  RF_SLOTS,
  SMART_CONTROL_EQUAD,
  buildRemoteActivityMapsMapList,
  keyComparison,
  missingRemoteActivityMaps,
  pairOutcome,
  pairedMessage,
  parseRfInfo,
  readActivityButtons,
  remoteActivityMapsSaveOutcome,
  remoteModels,
} from "./remotes-model.js";
import { saveMapList } from "./map-save.js";
import { hasRemoteMaps } from "./touch-model.js";
import { COMPANION_EQUAD, SCREEN_EQUAD, hasHomeButtons, homeRemote } from "./home-buttons-model.js";

const SMART_CONTROL_STEPS = `On a Harmony Smart Control, ${PAIRING_STEPS[SMART_CONTROL_EQUAD]}.`;

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
  let multiRemote = false; // the hub runs the multi-remote hal
  let unpairing = 0; // slot being unpaired
  let addingKeys = false; // saving the activity maps a paired remote lacks
  let timer = null;

  section.innerHTML = `<div class="page" id="remotesRoot"></div>`;
  const root = section.querySelector("#remotesRoot");

  const busy = () => Boolean(pairing) || Boolean(unpairing) || addingKeys;
  const paired = () => remotes?.remotes ?? [];
  // One entry per model: remotes of one model share its maps.
  const models = () => remoteModels(paired());
  // Paired models with keys per activity: with a screen, or without one.
  const keyRemotes = () => models().filter((r) => r.role === "screen" || r.role === "no-screen");

  function remoteRow(r) {
    // A screen remote other than the Touch shows its skin, which tells which model it is.
    const skin = r.role === "screen" && r.short === "screen remote" && r.skinId ? ` · skin ${r.skinId}` : "";
    const twins = paired().filter((o) => o.equadId === r.equadId && o.slot !== r.slot).map((o) => o.slot);
    const shares = twins.length ? ` · same buttons as slot ${twins.join(", ")}` : "";
    return listRow({
      title: r.name,
      subtitle: `Slot ${r.slot}${skin}${shares}`,
      leading: iconTile("settings_remote", { size: 44, tone: "hub" }),
      trailing: `<button type="button" class="btn btn-text btn-sm" data-unpair="${r.slot}"${busy() || remotesBusy ? " disabled" : ""}>${unpairing === r.slot ? "Unpairing…" : "Unpair"}</button>`,
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
      body = `<div class="m-list">${remotes.remotes.map(remoteRow).join("")}</div>
        <p class="list-note">${remotes.remotes.length} of ${RF_SLOTS} radio slots used.</p>`;
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
          ? ` It replaced the older ${list(outcome.replaced)}; ${multiRemote ? "the hub keeps one remote with a screen and one keyboard" : "the hub keeps one remote of each kind"}.`
          : "";
        const sharing = outcome.sharing?.length
          ? ` It does the same as the other ${escapeHtml(outcome.sharing[0].short)}: remotes of one model share their buttons.`
          : "";
        return `<div class="notice notice-ok" role="status"><strong>Paired:</strong> ${list(outcome.added)}.${replaced}${sharing}${keptText}</div>`;
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
    const full = paired().length >= RF_SLOTS;
    const options = WINDOWS.map((s) => `<option value="${s}"${s === windowSeconds ? " selected" : ""}>${s} seconds</option>`).join("");
    return `${sectionLabel("Pair a remote")}
      <div class="m-card">
        <p>The hub opens its pairing window. While it's open, put the remote in pairing mode. ${escapeHtml(SMART_CONTROL_STEPS)} Other remotes use their own pairing steps.</p>
        <p class="list-note">${multiRemote
          ? "Remotes without a screen can be paired more than once: a second remote of the same model joins the first, and the two share their buttons. A remote with a screen (or a Harmony keyboard) still replaces an older one."
          : "The hub keeps one remote of each kind: a new remote replaces an older one of the same kind, and remotes of other kinds stay paired."} The radio has ${RF_SLOTS} slots. Nothing goes through Logitech's servers.</p>
        ${multiRemote ? "" : `<p class="list-note">To pair two remotes of the same model, turn on <a href="#settings">Multiple remotes of one model</a> in Settings (experimental).</p>`}
        ${outcomeNotice()}
        <div class="actions">
          <label class="remotes-window">Window <select data-window${busy() ? " disabled" : ""}>${options}</select></label>
          <button type="button" class="btn btn-filled" data-act="pair"${busy() || remotesBusy || full ? " disabled" : ""}>Open pairing window</button>
        </div>
        ${full ? `<p class="list-note">All ${RF_SLOTS} slots are used. Unpair a remote to pair another.</p>` : ""}
      </div>`;
  }

  /* Where this remote's keys differ from the other paired remotes' in an
     activity, in this remote's words; "" when they're alike. */
  function keyDifference(p, others) {
    if (!p) return "";
    if (!p.hasMap) return "No keys here yet";
    const name = (o) => (others.length > 1 ? `the ${others.find((r) => r.equadId === o.remote)?.short ?? "other remote"}` : "the other remote");
    return p.others.filter((o) => o.hasMap).flatMap((o) => [
      o.differ.length && `different on ${name(o)}: ${o.differ.join(", ")}`,
      o.mineOnly.length && `not on ${name(o)}: ${o.mineOnly.join(", ")}`,
      o.theirsOnly.length && `only on ${name(o)}: ${o.theirsOnly.join(", ")}`,
    ]).filter(Boolean).join(" · ");
  }

  /* The same card for every remote with keys: a row per activity opening
     that remote's keys (and, for a remote with a screen, its screen and
     gestures). */
  function activitiesCard(remote) {
    const acts = hub.activities();
    const what = remote.role === "screen" ? "On-screen buttons, hard keys and gestures" : "Its keys";
    const others = keyRemotes().filter((r) => r.equadId !== remote.equadId && hasRemoteMaps(hub.state.config, r.equadId));
    const byActivity = new Map(keyComparison(hub.state.config, remote.equadId, others.map((r) => r.equadId)).map((p) => [p.activityId, p]));
    const every = others.length > 1 ? "all your remotes" : "both remotes";
    const notes = [
      others.length && `<p class="list-note">Keys work the same on ${every}: a key you change goes on ${others.length > 1 ? "all of them" : "both"} unless you set it for one remote only.</p>`,
      remote.role === "screen" && !remote.tested
        && `<p class="list-note">Remotes with a screen share these maps, but this editor hasn't been tested on this model yet.</p>`,
    ].filter(Boolean).join("");
    return `<div class="m-card">
        <div class="m-card-head"><span>Buttons for each activity</span></div>
        <p class="list-note">${what}, set per activity.</p>
        ${notes}
        ${acts.length
          ? `<div class="m-list">${acts.map((a) => {
              const id = String(a["Id-"]);
              return listRow({
                title: hub.activityName(a),
                subtitle: keyDifference(byActivity.get(id), others) || undefined,
                href: `#touch/${encodeURIComponent(id)}/${encodeURIComponent(remote.equadId)}`,
                chevron: true,
              });
            }).join("")}</div>`
          : `<p class="list-note">This hub has no activities yet.</p>`}
      </div>`;
  }

  /* A remote without a screen has three activity buttons, in its own root map. */
  function activityButtonsCard(remote) {
    const rows = readActivityButtons(hub.state.config, remote.equadId).rows;
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
          href: `#activitybuttons/${encodeURIComponent(remote.equadId)}`,
          chevron: true,
        })}</div>
      </div>`;
  }

  /* The remote's home control and + / − buttons: one row for every
     activity (its root map), then a row per activity for its overrides. */
  function homeButtonsCard(remote) {
    const row = (title, href) => listRow({ title, href, chevron: true });
    // A remote with a screen: only the Elite and the 950 have these buttons.
    const screen = remote.equadId !== COMPANION_EQUAD;
    const base = screen ? "#homebuttons/screen" : "#homebuttons";
    const labels = homeRemote(screen ? SCREEN_EQUAD : COMPANION_EQUAD).buttons.map((b) => b.label).join(", ");
    const note = screen
      ? `${labels} and + / − on a Harmony Elite or 950. An activity follows these unless it has its own.`
      : `${labels} and + / −. An activity follows these unless it has its own.`;
    return `<div class="m-card">
        <div class="m-card-head"><span>Home control buttons</span></div>
        <p class="list-note">${note}</p>
        <div class="m-list">${[
          row("Every activity", base),
          ...hub.activities().map((a) => row(hub.activityName(a), `${base}/${encodeURIComponent(String(a["Id-"]))}`)),
        ].join("")}</div>
      </div>`;
  }

  /* A remote without a screen that has no map for some activities: say what
     that means and offer the fix. Pairing here adds them itself; this is for
     a remote paired before that, or when that save didn't land. */
  function missingKeysNotice(remote) {
    const missing = missingRemoteActivityMaps(hub.state.config, [remote.equadId]);
    if (!missing.length) return "";
    const names = missing.map((m) => escapeHtml(m.name)).join(", ");
    return `<div class="notice notice-warn" role="status">
        <strong>This remote has no keys for ${missing.length === 1 ? "one activity" : `${missing.length} activities`}:</strong> ${names}.
        While ${missing.length === 1 ? "it" : "one of them"} runs the hub ignores every key on this remote, Off included.
        <div class="actions"><button type="button" class="btn btn-filled btn-sm" data-act="add-keys"${busy() || remotesBusy ? " disabled" : ""}>${addingKeys ? "Adding…" : "Add its keys"}</button></div>
      </div>`;
  }

  /* Give every paired remote without a screen a map for each activity it
     has none for. One save for all of them; nothing else in MapList changes. */
  async function addMissingKeys() {
    if (addingKeys || !hub.state.config) return;
    const { mapList, created } = buildRemoteActivityMapsMapList(hub.state.config, paired());
    if (!created.length) return;
    addingKeys = true;
    render();
    try {
      await saveMapList(mapList, {
        done: `Added the missing keys (${created.length === 1 ? "one activity map" : `${created.length} activity maps`}).`,
        check: (config) => remoteActivityMapsSaveOutcome(config, created),
      });
    } finally {
      addingKeys = false;
      render();
    }
  }

  /* One section per model: remotes of one model share its maps. */
  function remoteSection(remote) {
    let body;
    if (remote.role === "no-screen") body = `${missingKeysNotice(remote)}${activityButtonsCard(remote)}${activitiesCard(remote)}`;
    else if (remote.role === "screen") body = activitiesCard(remote);
    else body = `<div class="m-card"><p class="list-note">Nothing to set for this remote here yet.</p></div>`;
    if (hasHomeButtons(remote)) body += homeButtonsCard(remote);
    const count = remote.slots.length;
    const shared = count > 1
      ? `<p class="list-note">These ${count} remotes ${new Set(remote.skinIds).size > 1 ? "both have a screen" : "are the same model"}, so they share these settings (slots ${remote.slots.join(", ")}).</p>`
      : "";
    return `${sectionLabel(count > 1 ? `${remote.name} × ${count}` : remote.name)}<div class="remotes-section">${shared}${body}</div>`;
  }

  function render() {
    if (section.hidden) return;
    if (!hub.state.config && !hub.state.configError) {
      root.innerHTML = `${remotesCard()}${pairCard()}<div class="m-center">${spinner("Loading")}</div>`;
      return;
    }
    const sections = hub.state.config ? models().map(remoteSection).join("") : "";
    root.innerHTML = `${remotesCard()}${pairCard()}${sections}`;
  }

  async function loadRemotes() {
    try {
      const reply = await api.getRemotes();
      remotesBusy = Boolean(reply.pairing);
      if (!remotesBusy) {
        remotes = parseRfInfo(reply.reply);
        multiRemote = Boolean(reply.multiRemote);
      }
    } catch (_) {
      remotesBusy = false;
      remotes = null;
    }
    render();
  }

  async function pair() {
    if (busy()) return;
    const now = paired().map((r) => `${r.name} (slot ${r.slot})`).join(", ");
    const rule = multiRemote
      ? "A remote without a screen joins alongside them, even one of a model already paired; a remote with a screen or a keyboard replaces an older one."
      : "A new remote of one of those kinds replaces that one; a remote of any other kind joins alongside them.";
    const ok = await confirmDialog({
      title: "Open the pairing window?",
      text: now
        ? `Paired now: ${now}. ${rule}`
        : multiRemote ? "No remotes are paired with this hub now." : "The hub keeps one remote of each kind. No remotes are paired with it now.",
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
      if (typeof reply.multiRemote === "boolean") multiRemote = reply.multiRemote;
      outcome = pairOutcome(reply);
      if (outcome.remotes) remotes = parseRfInfo(reply.after);
      remotesBusy = false;
    } catch (error) {
      // 409 and 502 come before the window opens; anything else may come after.
      const message = error.status === 409 ? error.message || "A pairing window is already open on the hub. Wait for it to close."
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
    // A remote that just joined has no keys in the activities that already
    // exist; add them now instead of leaving it dead once one starts.
    if (outcome && (outcome.status === "paired" || outcome.status === "already")) {
      await hub.ensureConfig();
      await addMissingKeys();
    }
    const pairedText = pairedMessage(outcome);
    if (pairedText && !section.hidden) {
      await confirmDialog({ title: "Remote paired", text: pairedText, confirmLabel: "OK", cancel: false });
    }
  }

  async function unpair(slot) {
    const remote = paired().find((r) => r.slot === slot);
    if (!remote || busy()) return;
    const last = paired().length === 1;
    const ok = await confirmDialog({
      title: `Unpair the ${remote.short} in slot ${slot}?`,
      text: `It stops controlling this hub until you pair it again.${last ? " It's the only remote paired with this hub." : ""}`,
      confirmLabel: "Unpair",
      destructive: true,
    });
    if (!ok) return;
    unpairing = slot;
    outcome = null;
    render();
    try {
      const reply = await api.unpairRemote({ slot });
      snackbar(`Unpaired the ${remote.short} in slot ${slot}.`);
      const after = parseRfInfo(reply.after);
      if (after) remotes = after;
      else {
        // The hub unpaired it but couldn't list the slots afterwards: never keep
        // showing the old list; read it again (loadRemotes() shows the radio as
        // unavailable if that fails too).
        unpairing = 0;
        remotes = undefined;
        render();
        await loadRemotes();
      }
    } catch (error) {
      snackbar(error.message || "The hub didn't unpair that remote.", { error: true });
      unpairing = 0;
      await loadRemotes();
    }
    unpairing = 0;
    render();
  }

  root.addEventListener("change", (event) => {
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
      hub.reloadConfig();
    } else if (act === "pair") pair();
    else if (act === "add-keys") addMissingKeys();
    const slot = event.target.closest("[data-unpair]")?.dataset.unpair;
    if (slot) unpair(Number(slot));
  });

  hub.subscribe(() => render());

  async function confirmLeave() {
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
