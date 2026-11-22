/* Add / Edit / Pair a native LG webOS TV (codex_webos + CommitWebOsDevices). */

import {
  cancelWebOsPairing,
  getConfig,
  getWebOsPairStatus,
  getWebOsStatus,
  refreshWebOsTv,
  saveWebOsDevices,
  saveWebOsTv,
  startWebOsPairing,
} from "../api.js";
import * as hub from "../state.js";
import { escapeHtml, openSheet, snackbar } from "../ui/shell.js";
import { fieldId, setMessage, textField } from "./device-sheets.js";
import {
  isWebOsEntry,
  makeWebOsId,
  validateWebOsForm,
  webOsAppsFromTv,
  webOsConfigOf,
  webOsDeviceSet,
  webOsIdOf,
  webOsInputsFromTv,
  webOsPairStateText,
  webOsSpecs,
} from "./webos-model.js";

const PAIR_POLL_MS = 600;

export function openWebOsSheet({ device = null, onDone } = {}) {
  const editing = Boolean(device);
  const existing = editing ? webOsConfigOf(device) : null;
  let tvId = existing?.entity || "";
  let paired = Boolean(existing?.paired);
  let discoveredInputs = null;
  let discoveredApps = null;
  let busy = false;
  let pairing = false;
  let pollTimer = 0;
  let closed = false;

  const ids = {
    name: fieldId("webosName"),
    host: fieldId("webosHost"),
    mac: fieldId("webosMac"),
  };

  const stopPolling = () => {
    clearTimeout(pollTimer);
    pollTimer = 0;
  };

  return openSheet({
    label: editing ? `Edit ${device.name}` : "Add LG webOS TV",
    onClose: () => {
      closed = true;
      stopPolling();
      if (pairing) {
        pairing = false;
        cancelWebOsPairing().catch(() => {});
      }
    },
    render: (content, close) => {
      content.innerHTML = `<form class="m-form" novalidate>
          <h2 class="sheet-title">${editing ? "Edit LG webOS TV" : "LG webOS TV (native LAN)"}</h2>
          <p class="sheet-text">Controls an LG webOS TV directly over your LAN without Home Assistant. Power Off, volume, mute, HDMI inputs, apps, media transport and navigation keys run over webOS SSAP; Power On uses Wake-on-LAN when a MAC address is configured.</p>
          <p class="list-note">Experimental. Known to have problems on some newer LG TVs (2024 models), such as disconnects and standby being misread. If it doesn't behave, use Home Assistant's LG integration or IR instead.</p>
          ${textField({
            id: ids.name,
            label: "TV name",
            value: existing?.name || (editing ? device.name : "LG webOS TV"),
            placeholder: "Living Room LG",
            maxlength: 64,
          })}
          ${textField({
            id: ids.host,
            label: "TV IPv4 address",
            value: existing?.host || "",
            placeholder: "192.168.1.40",
            maxlength: 15,
            hint: "Use a static IP or DHCP reservation on your router so the hub can always reach the TV.",
          })}
          ${textField({
            id: ids.mac,
            label: "TV MAC address (for Wake-on-LAN Power On, optional)",
            value: existing?.mac || "",
            placeholder: "AA:BB:CC:11:22:33",
            maxlength: 24,
            hint: "Enable 'Mobile TV On' (Turn on via Wi-Fi) on the TV. Without a MAC, the TV uses PowerToggle instead of discrete PowerOn.",
          })}
          <div class="webos-pair-box">
            <div class="webos-pair-row">
              <span class="badge ${paired ? "badge-network" : ""}" data-webos-badge>${paired ? "Paired" : "Not paired"}</span>
              <div class="webos-pair-actions">
                <button type="button" class="btn btn-outlined" data-act="webos-pair">${paired ? "Re-pair" : "Pair with TV"}</button>
                <button type="button" class="btn btn-text" data-act="webos-refresh"${paired ? "" : " disabled"}>Refresh inputs &amp; apps</button>
              </div>
            </div>
            <p class="m-field-hint" data-webos-meta></p>
          </div>
          <p class="form-msg" data-msg role="status" aria-live="polite"></p>
          <button type="submit" class="btn btn-filled btn-block">${editing ? "Save changes" : "Add LG webOS TV"}</button>
        </form>`;

      const form = content.querySelector("form");
      const msg = content.querySelector("[data-msg]");
      const badge = content.querySelector("[data-webos-badge]");
      const meta = content.querySelector("[data-webos-meta]");
      const pairBtn = content.querySelector("[data-act='webos-pair']");
      const refreshBtn = content.querySelector("[data-act='webos-refresh']");
      const submit = form.querySelector("[type=submit]");

      const updatePairUi = () => {
        badge.textContent = paired ? "Paired" : "Not paired";
        badge.className = `badge ${paired ? "badge-network" : ""}`;
        pairBtn.textContent = pairing ? "Cancel pairing" : paired ? "Re-pair" : "Pair with TV";
        refreshBtn.disabled = !paired || pairing || busy;
      };

      const updateMetaFromTv = (tv) => {
        if (!tv) return;
        const inputs = webOsInputsFromTv(tv);
        const apps = webOsAppsFromTv(tv);
        if (inputs.length) discoveredInputs = inputs;
        if (apps.length) discoveredApps = apps;
        const parts = [];
        if (inputs.length) parts.push(`${inputs.length} HDMI input${inputs.length === 1 ? "" : "s"}`);
        if (apps.length) parts.push(`${apps.length} app${apps.length === 1 ? "" : "s"}`);
        meta.textContent = parts.length ? `Discovered from TV: ${parts.join(", ")}.` : "";
      };

      const readChecked = () => {
        const checked = validateWebOsForm({
          name: form.querySelector(`#${ids.name}`).value,
          host: form.querySelector(`#${ids.host}`).value,
          mac: form.querySelector(`#${ids.mac}`).value,
        });
        if (checked.error) {
          setMessage(msg, checked.error, "error");
          const targetId = ids[checked.field];
          if (targetId) form.querySelector(`#${targetId}`)?.focus();
          return null;
        }
        return checked.spec;
      };

      // Load live pairing/discovery state if editing an existing TV.
      if (tvId) {
        getWebOsStatus().then((st) => {
          if (closed) return;
          const found = (st?.tvs ?? []).find((t) => t.id === tvId);
          if (found) {
            paired = Boolean(found.paired);
            updatePairUi();
            updateMetaFromTv(found);
          }
        }).catch(() => {});
      }

      const pollPair = async (name) => {
        if (closed || !pairing) return;
        try {
          const ps = await getWebOsPairStatus();
          if (closed || !pairing) return;
          if (ps.state === "paired") {
            pairing = false;
            paired = true;
            if (ps.tvId) tvId = ps.tvId;
            updatePairUi();
            setMessage(msg, webOsPairStateText("paired", name), "ok");
            // Fetch inputs & apps shortly after pairing connects.
            setTimeout(() => {
              if (closed || !tvId) return;
              getWebOsStatus().then((st) => {
                const found = (st?.tvs ?? []).find((t) => t.id === tvId);
                if (found) updateMetaFromTv(found);
              }).catch(() => {});
            }, 600);
            return;
          }
          if (ps.state === "denied" || ps.state === "failed") {
            pairing = false;
            updatePairUi();
            setMessage(msg, ps.error || webOsPairStateText(ps.state, name), "error");
            return;
          }
          setMessage(msg, webOsPairStateText(ps.state, name));
          pollTimer = setTimeout(() => pollPair(name), PAIR_POLL_MS);
        } catch (err) {
          pairing = false;
          updatePairUi();
          setMessage(msg, err.message || "Lost contact with the hub while pairing.", "error");
        }
      };

      pairBtn.addEventListener("click", async () => {
        if (pairing) {
          stopPolling();
          pairing = false;
          updatePairUi();
          await cancelWebOsPairing().catch(() => {});
          setMessage(msg, "Pairing cancelled.");
          return;
        }
        const spec = readChecked();
        if (!spec) return;
        pairing = true;
        updatePairUi();
        setMessage(msg, webOsPairStateText("connecting", spec.name));
        try {
          const saved = await saveWebOsTv({ ...(tvId ? { id: tvId } : {}), ...spec });
          if (saved?.tv?.id) tvId = saved.tv.id;
          const started = await startWebOsPairing({ id: tvId, ...spec });
          if (!started?.ok) throw new Error(started?.error || "Could not start pairing.");
          setMessage(msg, webOsPairStateText(started.state || "prompt", spec.name));
          pollTimer = setTimeout(() => pollPair(spec.name), PAIR_POLL_MS);
        } catch (err) {
          pairing = false;
          updatePairUi();
          setMessage(msg, err.message || "Could not start pairing with the TV.", "error");
        }
      });

      refreshBtn.addEventListener("click", async () => {
        if (!tvId || busy || pairing) return;
        refreshBtn.disabled = true;
        setMessage(msg, "Refreshing inputs and apps from the TV…");
        try {
          const res = await refreshWebOsTv({ id: tvId });
          if (!res?.ok) throw new Error(res?.error || "Could not refresh from the TV.");
          if (res.tv) updateMetaFromTv(res.tv);
          setMessage(msg, "Refreshed inputs and apps from the TV.", "ok");
        } catch (err) {
          setMessage(msg, err.message || "Could not refresh inputs and apps.", "error");
        } finally {
          updatePairUi();
        }
      });

      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        if (busy) return;
        const spec = readChecked();
        if (!spec) return;
        busy = true;
        submit.disabled = true;
        updatePairUi();
        setMessage(msg, editing ? "Saving to the hub…" : "Adding to the hub…");
        try {
          const config = await getConfig();
          const existingIds = new Set(webOsSpecs(config).map((d) => d.entity));
          if (!tvId) tvId = makeWebOsId(existingIds);
          const daemonSave = await saveWebOsTv({ id: tvId, ...spec }).catch(() => null);
          if (daemonSave?.tv) {
            paired = Boolean(daemonSave.tv.paired);
            updateMetaFromTv(daemonSave.tv);
          }
          const payload = webOsDeviceSet(config, {
            add: {
              entity: tvId,
              ...spec,
              paired,
              ...(discoveredInputs ? { inputs: discoveredInputs } : {}),
              ...(discoveredApps ? { apps: discoveredApps } : {}),
            },
          });
          await saveWebOsDevices(payload);
          await hub.refreshConfig();
          const saved = hub.devices().find((d) => isWebOsEntry(d.entry) && webOsIdOf(d.entry) === tvId) ?? null;
          close();
          snackbar(editing ? `Saved ${spec.name}` : `Added ${spec.name}`);
          if (saved && onDone) onDone(saved);
        } catch (err) {
          setMessage(msg, err.message || "Could not save LG webOS TV.", "error");
        } finally {
          busy = false;
          submit.disabled = false;
          updatePairUi();
        }
      });
    },
  });
}
