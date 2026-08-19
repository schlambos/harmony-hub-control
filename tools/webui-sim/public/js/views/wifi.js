/* Wi-Fi setup view (#wifi).
 *
 * Current state comes from GET /export/wifi (raw wpa_supplicant.conf) via
 * parseWpaSupplicant — the parser never returns the psk value, and this view
 * never renders, logs, or re-posts a saved secret. Saves POST
 * form-urlencoded to /wifi (postHubForm) with the exact legacy fields:
 * ssid, password, hidden, open, keep_password, apply.
 *
 * Two save paths:
 *   - "Save" (the single amber primary) omits `apply` — the hub stores the
 *     network and keeps running; nothing is interrupted. After a successful
 *     save the export is re-read so the state panel reflects the hub.
 *   - "Save and reboot now" (btn-danger) sits behind the two-step typed
 *     danger guard; only the confirmed path sends apply=reboot. The stated
 *     consequence: the hub immediately drops off the network and wrong
 *     credentials require the recovery access point.
 */

import { el, clear, setText, notice, viewHead, dangerGuard } from "../setup-kit.js";
import { getText, postHubForm } from "../api.js";
import { parseWpaSupplicant } from "../setup-parsers.js";

const EXPORT_PATH = "/export/wifi";
const SAVE_PATH = "/wifi";
const REBOOT_PHRASE = "REBOOT";

export function createWifiView(section) {
  section.appendChild(
    viewHead(
      "Wi-Fi",
      "Change the network the hub joins. Saved settings take effect on reboot; if a new network fails, hold the reset button to start the recovery access point.",
    ),
  );

  /* -- Saved-network panel -------------------------------------------- */

  const stateChip = el("span", { className: "pill pill-dim", text: "Not configured" });
  const currentBody = el("div");

  function kvRow(term, valueNode) {
    return el("div", { children: [el("dt", { text: term }), valueNode] });
  }

  const kvSsid = el("dd");
  const kvSecurity = el("dd");
  const kvPassword = el("dd");
  const kvHidden = el("dd");
  const kv = el("dl", {
    className: "setup-kv",
    children: [
      kvRow("Network (SSID)", kvSsid),
      kvRow("Security", kvSecurity),
      kvRow("Password", kvPassword),
      kvRow("Hidden network", kvHidden),
    ],
  });

  function renderChip(cfg) {
    const configured = Boolean(cfg && cfg.ssid);
    stateChip.className = configured ? "pill pill-live" : "pill pill-dim";
    setText(stateChip, configured ? "Configured" : "Not configured");
  }

  function renderCurrentLoading() {
    clear(currentBody);
    currentBody.appendChild(el("p", { className: "setup-unavailable", text: "Reading the saved network…" }));
  }

  function renderCurrentError(message) {
    clear(currentBody);
    currentBody.appendChild(notice("warn", `Could not read the saved network: ${message}`));
    const retry = el("button", { className: "btn btn-quiet btn-sm", text: "Retry", attrs: { type: "button" } });
    retry.addEventListener("click", () => refreshCurrent());
    currentBody.appendChild(el("div", { className: "setup-actions", children: [retry] }));
  }

  /* -- Configure form -------------------------------------------------- */

  let current = null; // last parseWpaSupplicant result; null = unknown
  let formTouched = false;
  let busy = false;
  let generation = 0; // invalidates stale async replies after re-show/hide

  const ssidInput = el("input", {
    attrs: {
      id: "wifiSsid",
      name: "ssid",
      type: "text",
      autocomplete: "off",
      spellcheck: "false",
      "aria-describedby": "wifiSsidHint",
    },
  });
  const passwordInput = el("input", {
    attrs: {
      id: "wifiPassword",
      name: "password",
      type: "password",
      autocomplete: "new-password",
      "aria-describedby": "wifiPasswordHint",
    },
  });
  const passwordHint = el("p", { className: "setup-field-hint", attrs: { id: "wifiPasswordHint" } });
  const openInput = el("input", { attrs: { id: "wifiOpen", name: "open", type: "checkbox" } });
  const hiddenInput = el("input", { attrs: { id: "wifiHidden", name: "hidden", type: "checkbox" } });

  // Checkbox rows reuse the shell's inline-toggle pattern (label + auto-width
  // input with the amber accent) defined in wizard.css.
  function checkToggle(input, text) {
    return el("label", {
      className: "wiz-hold-toggle",
      attrs: { for: input.id },
      children: [input, document.createTextNode(text)],
    });
  }

  function updatePasswordHint() {
    if (openInput.checked) {
      passwordInput.disabled = true;
      passwordInput.placeholder = "";
      setText(passwordHint, "Open networks join without a password.");
      return;
    }
    passwordInput.disabled = false;
    if (current && current.passwordSet) {
      passwordInput.placeholder = "Leave blank to keep the saved password";
      setText(
        passwordHint,
        "The hub never returns the saved password. A blank field keeps it; typing a value replaces it.",
      );
    } else {
      passwordInput.placeholder = "WPA/WPA2 passphrase (8–63 characters)";
      setText(passwordHint, "Required unless the network is open.");
    }
  }

  /** Mirror the C handler's checks so bad input fails before it ships. */
  function validate() {
    if (ssidInput.value.trim() === "") return "Wi-Fi SSID is required.";
    if (!openInput.checked && passwordInput.value === "" && current && !current.passwordSet) {
      return "Wi-Fi password is required unless the network is open.";
    }
    return "";
  }

  /** Exact legacy field set. The saved PSK is preserved with
      keep_password=on whenever no new value is typed; a typed value
      replaces it. Open networks never ship a password field. */
  function collectFields(apply) {
    const password = openInput.checked ? "" : passwordInput.value;
    const fields = {
      ssid: ssidInput.value,
      password: openInput.checked ? false : password,
      hidden: hiddenInput.checked,
      open: openInput.checked,
      keep_password: !openInput.checked && password === "",
    };
    if (apply) fields.apply = apply;
    return fields;
  }

  const statusBox = el("div", { className: "setup-status", attrs: { "aria-live": "polite" } });

  function showStatus(kind, message) {
    clear(statusBox);
    statusBox.appendChild(notice(kind, message));
  }

  const saveBtn = el("button", { className: "btn btn-primary", text: "Save", attrs: { type: "submit" } });
  const rebootBtn = el("button", {
    className: "btn btn-danger",
    text: "Save and reboot now…",
    attrs: { type: "button" },
  });

  function setButtonsBusy(isBusy, which) {
    saveBtn.disabled = isBusy;
    rebootBtn.disabled = isBusy;
    const target = which === "reboot" ? rebootBtn : saveBtn;
    const spinner = target.querySelector(".btn-spin");
    if (isBusy) {
      if (!spinner) {
        target.prepend(el("span", { className: "btn-spin", text: "●", attrs: { "aria-hidden": "true" } }));
      }
    } else if (spinner) {
      spinner.remove();
    }
  }

  async function save(apply) {
    if (busy) return;
    const error = validate();
    if (error) {
      showStatus("error", error);
      return;
    }
    busy = true;
    setButtonsBusy(true, apply);
    try {
      const result = await postHubForm(SAVE_PATH, collectFields(apply));
      const msg = result.msg || "Unexpected response from the hub.";
      if (!msg.toLowerCase().includes("saved")) {
        // The hub answers errors as 200 + <div class='msg'> — surface them.
        showStatus("error", msg);
        return;
      }
      if (apply === "reboot") {
        showStatus(
          "warn",
          `${msg} The hub drops off its current network immediately; this page goes offline until it joins the new one.`,
        );
        passwordInput.value = ""; // never leave the typed secret in the DOM
        formTouched = false; // the hub is now the source of truth — let the form repopulate
        return;
      }
      showStatus("info", msg);
      passwordInput.value = ""; // never leave the typed secret in the DOM
      formTouched = false; // the hub is now the source of truth — let the form repopulate
      await refreshCurrent({ quiet: true });
    } catch (err) {
      showStatus("error", err && err.message ? err.message : "Save failed.");
    } finally {
      busy = false;
      setButtonsBusy(false, apply);
    }
  }

  const form = el("form", { attrs: { novalidate: "" } });
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    save(); // amber path: no `apply` field — save only, reboot later
  });
  form.addEventListener("input", () => {
    formTouched = true;
  });
  form.addEventListener("change", () => {
    formTouched = true;
  });
  openInput.addEventListener("change", updatePasswordHint);

  // Validation gate for the danger path: registered before dangerGuard so an
  // invalid first click shows the error instead of arming (same-element
  // stopImmediatePropagation blocks the guard's arm handler).
  rebootBtn.addEventListener("click", (e) => {
    const error = validate();
    if (error) {
      e.stopImmediatePropagation();
      showStatus("error", error);
    }
  });

  const guard = dangerGuard(rebootBtn, {
    confirmLabel: "Confirm — save and reboot",
    typedPhrase: REBOOT_PHRASE,
    consequence:
      "The hub reboots the moment you confirm and immediately drops off the network it is using. " +
      "If the new SSID or password is wrong, this page goes offline and you must hold the hub's " +
      "reset button to start the recovery access point.",
    onConfirm() {
      save("reboot"); // the only path that ever sends apply=reboot
    },
  });

  /* -- State load ------------------------------------------------------ */

  async function refreshCurrent({ quiet = false } = {}) {
    if (!quiet) renderCurrentLoading();
    const gen = generation;
    try {
      const cfg = parseWpaSupplicant(await getText(EXPORT_PATH));
      if (gen !== generation) return;
      current = cfg;
      renderChip(cfg);
      setText(kvSsid, cfg.ssid || "Not configured");
      kvSsid.classList.toggle("setup-unavailable", !cfg.ssid);
      setText(kvSecurity, cfg.open ? "Open (no password)" : cfg.keyMgmt || "WPA-PSK");
      setText(kvPassword, cfg.open ? "Not used" : cfg.passwordSet ? "Saved on hub" : "Not set");
      setText(kvHidden, cfg.hidden ? "Yes" : "No");
      clear(currentBody);
      currentBody.appendChild(kv);
      if (!formTouched) {
        ssidInput.value = cfg.ssid;
        hiddenInput.checked = cfg.hidden;
        openInput.checked = cfg.open;
      }
      updatePasswordHint();
    } catch (err) {
      if (gen !== generation) return;
      if (quiet) return; // keep the last known state rather than flash an error
      current = null;
      renderChip(null);
      renderCurrentError(err && err.message ? err.message : "no response");
      updatePasswordHint();
    }
  }

  /* -- Assembly --------------------------------------------------------- */

  const exportLink = el("a", {
    className: "btn btn-quiet btn-sm",
    text: "Export wpa_supplicant.conf",
    attrs: { href: EXPORT_PATH, download: "wpa_supplicant.conf" },
  });

  section.appendChild(
    el("section", {
      className: "panel setup-panel",
      attrs: { "aria-label": "Saved network" },
      children: [
        el("div", { className: "panel-head", children: [el("h3", { text: "Saved network" }), stateChip] }),
        currentBody,
        el("div", { className: "setup-actions", children: [exportLink] }),
      ],
    }),
  );

  form.append(
    el("div", {
      className: "setup-fields",
      children: [
        el("label", { text: "Network name (SSID)", attrs: { for: ssidInput.id } }),
        ssidInput,
        el("p", {
          className: "setup-field-hint",
          attrs: { id: "wifiSsidHint" },
          text: "The name of the network the hub should join.",
        }),
        el("label", { text: "Password", attrs: { for: passwordInput.id } }),
        passwordInput,
        passwordHint,
        checkToggle(openInput, "Open network (no password)"),
        checkToggle(hiddenInput, "Hidden network (does not broadcast its name)"),
      ],
    }),
    statusBox,
    el("div", { className: "setup-actions", children: [saveBtn, rebootBtn] }),
    el("p", {
      className: "setup-field-hint",
      text: "Save stores the network without interrupting the hub — it keeps running until it reboots. Save and reboot applies the change immediately.",
    }),
  );

  section.appendChild(
    el("section", {
      className: "panel setup-panel",
      attrs: { "aria-label": "Configure network" },
      children: [
        el("div", { className: "panel-head", children: [el("h3", { text: "Configure network" })] }),
        form,
      ],
    }),
  );

  updatePasswordHint();

  return {
    onShow() {
      generation += 1;
      refreshCurrent({ quiet: current !== null });
    },
    onHide() {
      generation += 1;
      guard.disarm();
    },
  };
}
