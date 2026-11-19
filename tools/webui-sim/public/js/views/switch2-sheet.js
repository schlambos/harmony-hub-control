/* Add / Edit a Nintendo Switch 2 wake device (Option C BLE beacon).
   Follows the same CommitSwitch2Devices device-set pattern as androidtv-sheet.js. */

import { getConfig, saveSwitch2Devices } from "../api.js";
import * as hub from "../state.js";
import { escapeHtml, openSheet, snackbar } from "../ui/shell.js";
import { fieldId, setMessage, textField } from "./device-sheets.js";
import {
  isSwitch2Entry,
  makeSwitch2Id,
  SWITCH2_CONTROLLER_TYPES,
  switch2ConfigOf,
  switch2DeviceSet,
  switch2IdOf,
  switch2Specs,
  validateSwitch2Form,
} from "./switch2-model.js";

export function openSwitch2Sheet({ device = null, onDone } = {}) {
  const editing = Boolean(device);
  const existing = editing ? switch2ConfigOf(device) : null;
  let controllerType = existing?.controllerType || "joycon2-r";
  const initialCustomPid = existing && existing.controllerType === "custom"
    ? `${existing.pid.slice(0, 2)} ${existing.pid.slice(2, 4)}`
    : "";
  let busy = false;

  const ids = {
    name: fieldId("s2Name"),
    switch2Mac: fieldId("s2Mac"),
    controllerMac: fieldId("s2CtrlMac"),
    customPid: fieldId("s2Pid"),
  };

  return openSheet({
    label: editing ? `Edit ${device.name}` : "Add Nintendo Switch 2 (wake)",
    render: (content, close) => {
      const renderChips = () => SWITCH2_CONTROLLER_TYPES.map((t) =>
        `<button type="button" class="chip" data-s2-type="${escapeHtml(t.id)}" aria-pressed="${t.id === controllerType}">${escapeHtml(t.label)}${t.displayPid ? ` · ${escapeHtml(t.displayPid)}` : ""}</button>`,
      ).join("");

      content.innerHTML = `<form class="m-form" novalidate>
          <h2 class="sheet-title">${editing ? "Edit Switch 2 wake device" : "Nintendo Switch 2 (Bluetooth wake)"}</h2>
          <p class="sheet-text">Wakes a sleeping Nintendo Switch 2 over Bluetooth LE (2-second beacon) when you start an activity or tap <strong>Wake</strong>. Wake only — Switch 1 wake and controller input are not supported. <strong>Power Off is a no-op</strong> (sleep is handled by TV HDMI-CEC standby or the console itself).</p>
          ${textField({
            id: ids.name,
            label: "Device name",
            value: existing?.name || (editing ? device.name : "Nintendo Switch 2"),
            placeholder: "Nintendo Switch 2",
            maxlength: 64,
          })}
          ${textField({
            id: ids.switch2Mac,
            label: "Switch 2 Bluetooth MAC",
            value: existing?.switch2Mac || "",
            placeholder: "AA:BB:CC:11:22:33",
            maxlength: 24,
            hint: "The console's own Bluetooth MAC in normal order (Melodious reverses it inside the wake packet automatically).",
          })}
          ${textField({
            id: ids.controllerMac,
            label: "Bonded controller MAC",
            value: existing?.controllerMac || "",
            placeholder: "12:34:56:78:9A:BC",
            maxlength: 24,
            hint: "The Bluetooth MAC of your own Joy-Con 2 or Pro Controller 2 already paired to this Switch 2.",
          })}
          <fieldset class="m-fieldset">
            <legend>Controller type</legend>
            <div class="m-chips" data-s2-chips>${renderChips()}</div>
          </fieldset>
          <div data-s2-custom${controllerType === "custom" ? "" : " hidden"}>
            ${textField({
              id: ids.customPid,
              label: "Custom PID (2-byte hex, untested)",
              value: initialCustomPid,
              placeholder: "66 20",
              maxlength: 8,
              hint: "Advanced & untested (for third-party controllers such as PowerA): enter the 2 hex bytes immediately after 7E 05 in the BLE manufacturer data, low byte first.",
            })}
          </div>
          <details class="s2-help">
            <summary>How to find both MAC addresses</summary>
            <ol>
              <li>Put your Switch 2 to sleep and open a BLE scanner app (such as nRF Connect or LightBlue) near a Joy-Con 2 or Pro Controller 2 that is already paired to it.</li>
              <li>Detach the Joy-Con 2 or press HOME on the controller, and watch for an advertisement whose manufacturer data starts with <code>53 05</code> (Nintendo, <code>0x0553</code>).</li>
              <li>Note the advertising device's MAC address — that is your <strong>Bonded controller MAC</strong>.</li>
              <li>In the manufacturer data after <code>53 05 01 00 03 7E 05</code>, the next 2 bytes are the controller PID (<code>66 20</code> Joy-Con 2 Right, <code>67 20</code> Left, <code>69 20</code> Pro 2), followed by <code>00 01 81</code> (or <code>00 01 00</code>), and then 6 bytes for the <strong>Switch 2 Bluetooth MAC in reverse order</strong> (for example, <code>33 22 11 CC BB AA</code> means <code>AA:BB:CC:11:22:33</code>).</li>
            </ol>
            <p class="m-field-hint">In crowded RF rooms where a phone scanner sees too many devices, you can also correlate a computer BLE scan with <code>hcitool lescan</code> on the hub (see <code>docs/SWITCH2_WAKE.md</code>).</p>
          </details>
          <p class="form-msg" data-msg role="status" aria-live="polite"></p>
          <button type="submit" class="btn btn-filled btn-block">${editing ? "Save changes" : "Add Switch 2 wake device"}</button>
        </form>`;

      const form = content.querySelector("form");
      const msg = content.querySelector("[data-msg]");
      const submit = form.querySelector("[type=submit]");
      const customWrap = form.querySelector("[data-s2-custom]");

      form.addEventListener("click", (event) => {
        const chip = event.target.closest("[data-s2-type]");
        if (!chip) return;
        controllerType = chip.dataset.s2Type;
        form.querySelectorAll("[data-s2-type]").forEach((c) => c.setAttribute("aria-pressed", String(c === chip)));
        customWrap.hidden = controllerType !== "custom";
        setMessage(msg, "");
      });

      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        if (busy) return;
        const fields = {
          name: form.querySelector(`#${ids.name}`).value,
          switch2Mac: form.querySelector(`#${ids.switch2Mac}`).value,
          controllerMac: form.querySelector(`#${ids.controllerMac}`).value,
          controllerType,
          customPid: form.querySelector(`#${ids.customPid}`).value,
        };
        const checked = validateSwitch2Form(fields);
        if (checked.error) {
          setMessage(msg, checked.error, "error");
          const targetId = ids[checked.field];
          if (targetId) form.querySelector(`#${targetId}`)?.focus();
          return;
        }
        busy = true;
        submit.disabled = true;
        setMessage(msg, editing ? "Saving to the hub…" : "Adding to the hub…");
        try {
          const config = await getConfig();
          const existingIds = new Set(switch2Specs(config).map((d) => d.entity));
          const entity = existing?.entity || makeSwitch2Id(existingIds);
          const payload = switch2DeviceSet(config, { add: { entity, ...checked.spec } });
          await saveSwitch2Devices(payload);
          await hub.refreshConfig();
          const saved = hub.devices().find((d) => isSwitch2Entry(d.entry) && switch2IdOf(d.entry) === entity) ?? null;
          close();
          snackbar(editing ? `Saved ${checked.spec.name}` : `Added ${checked.spec.name}`);
          if (saved && onDone) onDone(saved);
        } catch (err) {
          setMessage(msg, err.message || "Could not save Switch 2 wake device.", "error");
        } finally {
          busy = false;
          submit.disabled = false;
        }
      });
    },
  });
}
