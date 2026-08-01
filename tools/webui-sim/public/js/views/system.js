/* System view: one non-mutating probe of POST /system (empty action reaches
   the hub's unknown-action branch and writes nothing) is parsed for firmware,
   uptime, memory, uname, logs, and the sign-in mode. Cloud egress, updates,
   discovery, and reboot use only endpoints the hub already serves.

   Safety shape, per the binding review:
   - the cloud blocker is one-way: when blocked there is NO disable control,
     and the combined cloud-plus-reboot action is never offered. When
     unblocked the only affordance is re-enabling the block.
   - sign-in enable/disable is a two-step confirm; the confirm names the
     username but the password is only ever read into the request body — it is
     never rendered, logged, or left in the DOM.
   - update apply defaults to restart=0 and is never one amber click; the
     restart variant is a separately armed danger action. This page never
     fetches from GitHub/the WAN and never stages anything.
   - the single amber primary on the whole page is "Refresh status". */

import { postHubForm, postApiForm, getJson, getText, probeBasicAuth } from "../api.js";
import { parseSystemHtml, parseCloudFlag } from "../setup-parsers.js";
import { viewHead, notice, el, clear, dangerGuard } from "../setup-kit.js";
import {
  cloudPanelState,
  authFormError,
  authIsEnabled,
  authEnableConsequence,
  AUTH_ENABLE_WARNING,
  basicAuthorizationHeader,
  shouldProbeAuthCredentials,
  authProbeSuccessMessage,
  authProbeFailureMessage,
  authDisabledMessage,
  formatBytes,
  updateCheckSummary,
  missingBinariesRemedy,
} from "./system-model.js";

export function createSystemView(section) {
  /* ---- state ---------------------------------------------------------- */
  let probe = null; // last parsed POST /system probe
  let probeError = null;
  let probeInflight = null; // dedup so one route entry = one probe
  let cloudOn = null; // boolean | null unknown
  let cloudError = null;
  let updateStatus = null;
  let updateStatusError = null;
  let checkState = null;
  let checkStateError = null;
  const disarms = []; // guard teardowns run on onHide

  const els = {};

  /* ---- small builders ------------------------------------------------- */

  function kvRow(label, value, { unavailable = false } = {}) {
    const dd = el("dd", { text: value, className: unavailable ? "setup-unavailable" : "" });
    return { row: el("div", { children: [el("dt", { text: label }), dd] }), dd };
  }

  function panel(title, headExtra, children) {
    return el("section", {
      className: "panel setup-panel",
      attrs: { "aria-label": title },
      children: [
        el("div", { className: "panel-head", children: [el("h3", { text: title }), headExtra].filter(Boolean) }),
        ...children,
      ],
    });
  }

  function setResult(node, kind, text) {
    clear(node);
    if (text) node.appendChild(notice(kind, text));
  }

  /* ---- status probe (the one expensive read) -------------------------- */

  function loadProbe() {
    if (probeInflight) return probeInflight;
    probeInflight = (async () => {
      probeError = null;
      try {
        // Empty action hits the hub's unknown-action branch: full page, no writes.
        const res = await postHubForm("/system", { action: "" });
        probe = parseSystemHtml(res.html);
      } catch (error) {
        probeError = error;
      }
      renderStatus();
    })().finally(() => {
      probeInflight = null;
    });
    return probeInflight;
  }

  async function loadCloud() {
    cloudError = null;
    try {
      cloudOn = parseCloudFlag(await getText("/export/cloud"));
    } catch (error) {
      cloudOn = null;
      cloudError = error;
    }
    renderCloud();
  }

  async function loadUpdate() {
    const [statusRes, checkRes] = await Promise.allSettled([
      getJson("/api/update-status"),
      getJson("/api/update-check-state"),
    ]);
    updateStatusError = statusRes.status === "rejected" ? statusRes.reason : null;
    if (statusRes.status === "fulfilled") updateStatus = statusRes.value;
    checkStateError = checkRes.status === "rejected" ? checkRes.reason : null;
    if (checkRes.status === "fulfilled") checkState = checkRes.value;
    renderUpdate();
  }

  function refreshAll() {
    loadProbe();
    loadCloud();
    loadUpdate();
  }

  /* ---- mutations ------------------------------------------------------ */

  async function enableCloud() {
    try {
      const res = await postHubForm("/system", { action: "cloud", cloudBlocker: true });
      setResult(els.cloudResult, "ok", res.msg || "Cloud blocker enabled and LAN-only egress applied.");
      await loadCloud(); // authoritative re-read of /export/cloud
    } catch (error) {
      setResult(els.cloudResult, "error", `Could not enable the cloud blocker: ${error.message}`);
    }
  }

  function clearPasswordFields() {
    if (els.passwordInput) els.passwordInput.value = "";
    if (els.confirmInput) els.confirmInput.value = "";
  }

  function showAuthProbeFailure(username, password) {
    clear(els.authResult);
    els.authResult.appendChild(notice("error", authProbeFailureMessage()));
    const recoveryActions = el("div", { className: "setup-actions" });
    const disableNow = el("button", {
      className: "btn btn-danger",
      text: "Disable sign-in now",
      attrs: { type: "button" },
    });
    disableNow.addEventListener("click", async () => {
      disableNow.disabled = true;
      try {
        const authorization = password
          ? basicAuthorizationHeader(username, password)
          : undefined;
        await postHubForm("/system", { action: "auth" }, { authorization });
        setResult(els.authResult, "ok", authDisabledMessage());
        clearPasswordFields();
        lastAuthCredentials = null;
        await loadProbe();
      } catch (error) {
        setResult(
          els.authResult,
          "error",
          `Could not disable sign-in from this page (${error.message}). ` +
            "Use SSH: delete or edit /data/codex/webui_auth.conf, then restart codex_webui.",
        );
      } finally {
        disableNow.disabled = false;
      }
    });
    recoveryActions.appendChild(disableNow);
    els.authResult.appendChild(recoveryActions);
  }

  /* Last credentials used for a successful enable (in-memory only, cleared on
     disable / hide / successful probe cleanup). Never written to storage. */
  let lastAuthCredentials = null;

  async function setAuth(enabling, username, password) {
    try {
      const fields = enabling
        ? {
            action: "auth",
            authEnabled: true,
            authUsername: username,
            ...(password ? { authPassword: password } : {}),
          }
        : { action: "auth" };
      const authorization = !enabling && lastAuthCredentials
        ? basicAuthorizationHeader(lastAuthCredentials.username, lastAuthCredentials.password)
        : undefined;
      const res = await postHubForm("/system", fields, { authorization });

      if (!enabling) {
        lastAuthCredentials = null;
        clearPasswordFields();
        setResult(els.authResult, "ok", res.msg || authDisabledMessage());
        await loadProbe();
        return;
      }

      /* Post-enable verification with an explicit Authorization header — never
         rely on the browser Basic prompt/cache (codex_webui.c webui_auth_ok). */
      if (shouldProbeAuthCredentials(password)) {
        const header = basicAuthorizationHeader(username, password);
        const probe = await probeBasicAuth("/", header);
        if (probe.ok) {
          lastAuthCredentials = { username, password };
          setResult(els.authResult, "ok", authProbeSuccessMessage(username));
          clearPasswordFields();
        } else {
          lastAuthCredentials = { username, password };
          showAuthProbeFailure(username, password);
          clearPasswordFields();
        }
      } else {
        /* Blank password keep-current: hub kept the stored secret; we cannot probe it. */
        setResult(
          els.authResult,
          "ok",
          res.msg || "Web UI sign-in setting saved (current password kept; not re-verified).",
        );
        clearPasswordFields();
      }
    } catch (error) {
      setResult(
        els.authResult,
        "error",
        error.status === 401
          ? "Sign-in required (HTTP 401) — the hub already requires credentials for this change."
          : `Sign-in change failed: ${error.message}`,
      );
    }
  }

  async function applyUpdate(restart) {
    try {
      const res = await postApiForm("/api/update-apply", { restart });
      setResult(
        els.updateResult,
        "ok",
        `Applied: ${res.updated || "staged files"}. Backup: ${res.backupDir || "—"}. ` +
          (res.restart ? "Services are restarting." : "Services were left running."),
      );
      await loadUpdate(); // refresh installed binary hashes/sizes
    } catch (error) {
      setResult(els.updateResult, "error", `Apply failed: ${error.message}`);
    }
  }

  async function rediscover() {
    try {
      const res = await postHubForm("/system", { action: "rediscover" });
      setResult(els.mqttResult, "ok", res.msg || "MQTT discovery reload requested.");
    } catch (error) {
      setResult(els.mqttResult, "error", `Discovery reload failed: ${error.message}`);
    }
  }

  async function reboot() {
    try {
      const res = await postHubForm("/system", { action: "reboot" });
      setResult(els.rebootResult, "warn", `${res.msg || "Rebooting now."} The hub will not answer until it finishes booting.`);
    } catch (error) {
      setResult(els.rebootResult, "error", `Reboot request failed: ${error.message}`);
    }
  }

  /* ---- renders -------------------------------------------------------- */

  function renderStatus() {
    clear(els.statusNotice);
    if (probeError) {
      const msg =
        probeError.status === 401
          ? "Sign-in required (HTTP 401). The hub now asks for credentials before this page can read status."
          : `Could not read system status: ${probeError.message}`;
      els.statusNotice.appendChild(notice("error", msg));
      return;
    }
    if (!probe) return;
    els.firmwareDd.textContent = probe.firmware || "unknown";
    els.uptimeDd.textContent = probe.uptime || "—";
    els.memoryDd.textContent = probe.memTotal || "—";
    els.authModeDd.textContent = probe.authMode || "—";
    els.sysPre.textContent = [
      "--- uname ---",
      probe.uname,
      "",
      "--- memory ---",
      probe.memory,
      "",
      "--- mounts ---",
      probe.mounts,
      "",
      "--- processes ---",
      probe.processes,
    ].join("\n");
    els.logPre.textContent = probe.logs || "(no log output)";
    els.authModeLine.textContent = probe.authMode
      ? `Current mode: ${probe.authMode}.`
      : "Current mode: unknown.";
  }

  function renderCloud() {
    clear(els.cloudState);
    if (cloudError) {
      els.cloudState.appendChild(notice("error", `Could not read cloud blocker state: ${cloudError.message}`));
      return;
    }
    if (cloudOn === null) {
      els.cloudState.appendChild(el("p", { className: "mini muted", text: "Reading cloud blocker state…" }));
      return;
    }
    els.cloudState.appendChild(cloudPanelState(cloudOn).live ? els.cloudLive : els.cloudOff);
  }

  function renderUpdate() {
    clear(els.checkSummary);
    if (checkStateError) {
      els.checkSummary.appendChild(notice("error", `Could not read the saved update-check state: ${checkStateError.message}`));
    } else if (checkState) {
      els.checkSummary.appendChild(el("p", { className: "mini", text: updateCheckSummary(checkState) }));
      if (checkState.message) {
        els.checkSummary.appendChild(el("p", { className: "setup-field-hint", text: checkState.message }));
      }
    }

    clear(els.binList);
    if (updateStatusError) {
      els.binList.appendChild(notice("error", `Could not read installed binaries: ${updateStatusError.message}`));
      return;
    }
    if (!updateStatus?.files?.length) return;
    const dl = el("dl", { className: "setup-kv" });
    for (const file of updateStatus.files) {
      const value = file.present ? `${formatBytes(file.size)} · md5 ${file.md5 ?? "—"}` : "not present";
      const { row } = kvRow(file.name, value);
      dl.appendChild(row);
    }
    els.binList.appendChild(dl);
    const remedy = missingBinariesRemedy(updateStatus.files);
    if (remedy) els.binList.appendChild(notice("warn", remedy));
  }

  /* ---- build the DOM once --------------------------------------------- */

  section.appendChild(
    viewHead("System", "Firmware, logs, sign-in, updates, and reboot — read from the hub, never from the internet."),
  );

  /* Status */
  els.refreshBtn = el("button", { className: "btn btn-primary", text: "Refresh status", attrs: { type: "button" } });
  els.refreshBtn.addEventListener("click", refreshAll);
  els.statusNotice = el("div", {});
  const firmware = kvRow("Firmware", "Reading…");
  const uptime = kvRow("Uptime", "Reading…");
  const memory = kvRow("Memory", "Reading…");
  const authMode = kvRow("Sign-in mode", "Reading…");
  const hubId = kvRow("Hub ID", "Not exposed by this web API", { unavailable: true });
  els.firmwareDd = firmware.dd;
  els.uptimeDd = uptime.dd;
  els.memoryDd = memory.dd;
  els.authModeDd = authMode.dd;
  els.sysPre = el("pre", { className: "mono" });
  els.logPre = el("pre", { className: "mono" });
  section.appendChild(
    panel(
      "Status",
      els.refreshBtn,
      [
        els.statusNotice,
        el("dl", { className: "setup-kv", children: [firmware.row, uptime.row, memory.row, authMode.row, hubId.row] }),
        el("p", { className: "setup-field-hint", text: "The Hub ID lives at /data/codex/hub_id on the device and is never served over HTTP." }),
        el("details", { children: [el("summary", { text: "System information" }), els.sysPre] }),
        el("details", { children: [el("summary", { text: "Logs" }), els.logPre] }),
      ],
    ),
  );

  /* Cloud egress (one-way) */
  els.cloudState = el("div", {});
  els.cloudResult = el("div", { className: "setup-status" });
  els.cloudEnableBtn = el("button", { className: "btn btn-secondary", text: "Enable cloud blocking", attrs: { type: "button" } });
  els.cloudEnableBtn.addEventListener("click", enableCloud);
  els.cloudLive = el("div", {
    children: [
      el("p", { children: [el("span", { className: "pill pill-live", text: "Cloud blocked · LAN-only" })] }),
      el("p", { className: "mini muted", text: "Logitech cloud services (cloudapi, PubNub, package manager) are blocked. This hub stays on the local network only." }),
      el("p", { className: "setup-field-hint", text: "Turning cloud access back on is intentionally not offered from this page." }),
    ],
  });
  els.cloudOff = el("div", {
    children: [
      notice("warn", "Cloud blocker is off — the hub may reach Logitech servers the next time it connects to a network."),
      el("div", { className: "setup-actions", children: [els.cloudEnableBtn] }),
    ],
  });
  section.appendChild(panel("Cloud egress", null, [els.cloudState, els.cloudResult]));

  /* Sign-in */
  els.authModeLine = el("p", { className: "mini", text: "Current mode: reading…" });
  els.usernameInput = el("input", { attrs: { id: "sys-auth-username", type: "text", autocomplete: "username", placeholder: "admin" } });
  els.passwordInput = el("input", { attrs: { id: "sys-auth-password", type: "password", autocomplete: "new-password", placeholder: "Leave blank to keep current" } });
  els.confirmInput = el("input", { attrs: { id: "sys-auth-confirm", type: "password", autocomplete: "new-password", placeholder: "Re-enter password" } });
  els.authResult = el("div", { className: "setup-status" });
  els.enableBtn = el("button", { className: "btn btn-secondary", text: "Require sign-in", attrs: { type: "button" } });
  els.disableBtn = el("button", { className: "btn btn-danger", text: "Disable sign-in", attrs: { type: "button" } });

  /* Enable is a custom two-step so the confirm can name the live username
     (dangerGuard's consequence is fixed at setup time). The password is only
     ever read into the request body — never into this text. */
  let enableArmed = false;
  let enableConsequence = null;
  function disarmEnable() {
    if (!enableArmed) return;
    enableArmed = false;
    els.enableBtn.textContent = "Require sign-in";
    els.enableBtn.classList.remove("danger-guard-armed");
    els.enableBtn.removeAttribute("aria-describedby");
    if (enableConsequence) {
      enableConsequence.remove();
      enableConsequence = null;
    }
  }
  function readAuthForm() {
    return {
      username: els.usernameInput.value.trim(),
      password: els.passwordInput.value,
      passwordConfirm: els.confirmInput.value,
      authAlreadyEnabled: authIsEnabled(probe?.authMode),
    };
  }
  els.enableBtn.addEventListener("click", () => {
    const form = readAuthForm();
    const error = authFormError({ enabling: true, ...form });
    if (!enableArmed) {
      if (error) {
        setResult(els.authResult, "error", error);
        return;
      }
      enableArmed = true;
      els.enableBtn.textContent = "Confirm: enable sign-in";
      els.enableBtn.classList.add("danger-guard-armed");
      enableConsequence = el("p", {
        className: "danger-guard-consequence",
        text: authEnableConsequence(form.username),
      });
      enableConsequence.id = "sys-auth-enable-consequence";
      els.enableBtn.setAttribute("aria-describedby", enableConsequence.id);
      els.enableBtn.after(enableConsequence);
      return;
    }
    if (error) {
      disarmEnable();
      setResult(els.authResult, "error", error);
      return;
    }
    disarmEnable();
    setAuth(true, form.username, form.password);
  });
  els.enableBtn.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && enableArmed) {
      e.preventDefault();
      disarmEnable();
    }
  });

  disarms.push(
    dangerGuard(els.disableBtn, {
      consequence: "This removes the sign-in requirement and leaves the web UI open to anyone who can reach the hub on the local network.",
      confirmLabel: "Confirm: disable sign-in",
      onConfirm: () => setAuth(false),
    }).disarm,
  );

  section.appendChild(
    panel("Sign-in", null, [
      els.authModeLine,
      el("label", { text: "Username", attrs: { for: "sys-auth-username" } }),
      els.usernameInput,
      el("label", { text: "New password", attrs: { for: "sys-auth-password" } }),
      els.passwordInput,
      el("label", { text: "Confirm password", attrs: { for: "sys-auth-confirm" } }),
      els.confirmInput,
      el("p", {
        className: "setup-field-hint",
        text: "Enter the password twice when enabling. Leave both blank only when sign-in is already on and you want to keep the current password. The password goes straight into the request body — never displayed, logged, or stored by this shell.",
      }),
      el("div", { className: "setup-actions", children: [els.enableBtn, els.disableBtn] }),
      els.authResult,
      notice("warn", AUTH_ENABLE_WARNING),
    ]),
  );

  /* Software update */
  els.checkSummary = el("div", {});
  els.binList = el("div", {});
  els.updateResult = el("div", { className: "setup-status" });
  els.applyBtn = el("button", { className: "btn btn-danger", text: "Apply staged update", attrs: { type: "button" } });
  els.applyRestartBtn = el("button", { className: "btn btn-danger", text: "Apply and restart services", attrs: { type: "button" } });
  disarms.push(
    dangerGuard(els.applyBtn, {
      consequence:
        "Applies whatever update is already staged on the hub, overwriting the binaries in /data/codex/bin. " +
        "A backup of the current binaries is kept (the last three are retained). This page downloads and stages nothing.",
      confirmLabel: "Confirm: apply staged update",
      onConfirm: () => applyUpdate("0"),
    }).disarm,
    dangerGuard(els.applyRestartBtn, {
      consequence:
        "Applies the staged update, then immediately kills and restarts codex_webui and the Bluetooth runtime. " +
        "The web UI drops off the network during the restart and this session may not recover in the emulator.",
      confirmLabel: "Confirm: apply and restart",
      onConfirm: () => applyUpdate("1"),
    }).disarm,
  );
  section.appendChild(
    panel("Software update", null, [
      notice(
        "info",
        "This page never downloads binaries and never points at a public GitHub owner. " +
          "Browser self-update against a hardcoded repository is disabled until release signing exists " +
          "(see payload/bin/MANIFEST.txt as the install/update inventory). " +
          "Only an already-staged update on the hub can be applied here.",
      ),
      els.checkSummary,
      els.binList,
      el("div", { className: "setup-actions", children: [els.applyBtn, els.applyRestartBtn] }),
      el("p", {
        className: "setup-field-hint",
        text:
          "Apply acts only on files already staged under /tmp/codex_update (allow-listed names from MANIFEST). " +
          "If nothing is staged, the hub says so. Apply keeps services running; the restart variant restarts " +
          "codex_webui, codex_bthid_keyboard, and codex_bt_pair_agent (same as init.sh).",
      }),
      els.updateResult,
    ]),
  );

  /* MQTT discovery */
  els.mqttResult = el("div", { className: "setup-status" });
  els.rediscoverBtn = el("button", { className: "btn btn-quiet", text: "Reload discovery", attrs: { type: "button" } });
  els.rediscoverBtn.addEventListener("click", rediscover);
  section.appendChild(
    panel("Home Assistant discovery", null, [
      el("p", { className: "mini muted", text: "Re-publish MQTT discovery if new devices or commands do not appear after changes." }),
      el("div", { className: "setup-actions", children: [els.rediscoverBtn] }),
      els.mqttResult,
    ]),
  );

  /* Reboot */
  els.rebootResult = el("div", { className: "setup-status" });
  els.rebootBtn = el("button", { className: "btn btn-danger", text: "Reboot hub", attrs: { type: "button" } });
  disarms.push(
    dangerGuard(els.rebootBtn, {
      typedPhrase: "REBOOT",
      consequence: "All activities stop, the hub drops off the network, and it does not answer until it finishes booting.",
      confirmLabel: "Confirm reboot",
      onConfirm: reboot,
    }).disarm,
  );
  section.appendChild(
    panel("Reboot", null, [
      el("p", { className: "mini muted", text: "Restart the hub after saving settings that need a reboot to take effect." }),
      el("div", { className: "setup-actions", children: [els.rebootBtn] }),
      els.rebootResult,
    ]),
  );

  /* ---- lifecycle ------------------------------------------------------ */

  return {
    onShow() {
      refreshAll();
    },
    onHide() {
      for (const disarm of disarms) disarm();
      disarmEnable();
      lastAuthCredentials = null;
      clearPasswordFields();
    },
  };
}
