"use strict";

(() => {
  const bridge = window.melodiousDesktop?.hub;
  const catalogBridge = window.melodiousDesktop?.catalog;
  const updatesBridge = window.melodiousDesktop?.updates;
  const wizardBridge = window.melodiousDesktop?.wizard;
  const wizardFlow = window.MelodiousRootWizardFlow;
  const root = document.getElementById("connectRoot");
  const appbar = document.getElementById("connectAppbar");
  const appbarTitle = document.getElementById("connectAppbarTitle");
  const appbarActions = document.getElementById("connectAppbarActions");
  const backBtn = document.getElementById("settingsBackBtn");
  const snackHost = document.getElementById("snackbars");

  if (!root || !bridge) return;

  const ROUTER_SVG =
    '<svg class="ic" width="24" height="24" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M16 4.2c1.5 0 3 .6 4.2 1.7l.8-.8C19.6 3.7 17.8 3 16 3s-3.6.7-5 2.1l.8.8C13 4.8 14.5 4.2 16 4.2zm-3.3 2.5.8.8c.7-.7 1.6-1 2.5-1s1.8.3 2.5 1l.8-.8c-.9-.9-2.1-1.4-3.3-1.4s-2.4.5-3.3 1.4zM19 13h-2V9h-2v4H5c-1.1 0-2 .9-2 2v4c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2v-4c0-1.1-.9-2-2-2zM8 18H6v-2h2v2zm3.5 0h-2v-2h2v2zm3.5 0h-2v-2h2v2z"/></svg>';

  let state = {
    mode: "connect",
    wizardDevAvailable: false,
    hub: null,
    hasHubAuth: false,
    hubUsername: "",
    logitechSignedIn: false,
    encryptionAvailable: true,
    clientId: "",
    defaultClientId: "9d88df5e-7edf-4288-8634-26721cbe7add",
    unreachableError: null,
  };

  let discovered = [];
  let scanning = false;
  let connecting = false;
  let showSignIn = false;
  let formHost = "";
  let formPort = "8080";
  let formUser = "";
  let formPass = "";
  let formClientId = "";
  let statusMsg = "";
  let statusError = false;
  let snackTimer = null;
  let updates = null;
  let updatesBusy = false;
  let hubStep = "";
  let lastWizardViewKey = "";
  let connectExistingChosen = false;

  let wiz = wizardFlow
    ? wizardFlow.createInitialWizardState()
    : { open: false, step: 1, busy: false, logLines: [] };

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
    );
  }

  function showSnackbar(text, isError = false) {
    if (!snackHost) return;
    clearTimeout(snackTimer);
    snackHost.innerHTML = `<div class="snackbar${isError ? " is-error" : ""}" role="${isError ? "alert" : "status"}">${escapeHtml(text)}</div>`;
    snackTimer = setTimeout(() => {
      snackHost.innerHTML = "";
    }, isError ? 6000 : 3500);
  }

  function pushWizLog(line) {
    const clean = String(line ?? "").trim();
    if (!clean) return;
    wiz.logLines.push(clean);
    if (wiz.logLines.length > 120) {
      wiz.logLines.splice(0, wiz.logLines.length - 120);
    }
  }

  function renderDiscoveredList() {
    if (scanning && discovered.length === 0) {
      return '<p class="list-note" id="discoveryStatus">Searching…</p>';
    }
    if (discovered.length === 0) {
      return '<p class="list-note" id="discoveryStatus">None found. Enter your hub\'s address below.</p>';
    }
    return `<div class="m-list" id="discoveredList">${discovered
      .map((hub, idx) => {
        const isCurrent =
          state.hub &&
          state.hub.host === hub.host &&
          Number(state.hub.port) === Number(hub.port || 8080);
        const portSuffix =
          hub.port && Number(hub.port) !== 8080 ? `:${hub.port}` : "";
        const subParts = [`${hub.host}${portSuffix}`];
        if (hub.firmware) subParts.push(`Firmware ${hub.firmware}`);
        if (hub.authRequired) subParts.push("Sign-in required");
        return `<button type="button" class="m-row" data-discover-idx="${idx}" ${connecting ? "disabled" : ""}>
          <span class="m-tile" style="--tile:40px">${ROUTER_SVG}</span>
          <span class="m-row-text">
            <span class="m-row-title">${escapeHtml(hub.name || `Hub (${hub.host})`)}</span>
            <span class="m-row-sub">${escapeHtml(subParts.join(" · "))}</span>
          </span>
          ${
            isCurrent
              ? `<span style="display:inline-flex;align-items:center;gap:6px;color:var(--live);font-size:var(--fs-body-sm)"><span class="m-dot is-live" aria-hidden="true"></span><span>Saved</span></span>`
              : ""
          }
        </button>`;
      })
      .join("")}</div>`;
  }

  function renderConnectAndAddressSection({ includeWizardCard = false } = {}) {
    const wizardEntryHtml =
      includeWizardCard && wizardBridge && wizardFlow && state.wizardDevAvailable
        ? wizardFlow.renderWizardConnectEntry({ disabled: connecting })
        : "";

    return `
      ${wizardEntryHtml}
      <div style="display:flex;align-items:center;justify-content:space-between;margin-top:var(--space-6);margin-bottom:var(--space-2)">
        <h3 class="m-section" style="margin:0">Hubs on this network</h3>
        ${
          scanning
            ? '<span class="m-spinner" role="progressbar" aria-label="Searching"></span>'
            : `<button type="button" class="btn btn-text btn-sm" id="scanHubsBtn" ${connecting ? "disabled" : ""}>Search again</button>`
        }
      </div>
      ${renderDiscoveredList()}

      <h3 class="m-section">Enter address</h3>
      <form id="connectForm" class="m-card m-form" novalidate>
        <div style="display:grid;grid-template-columns:1fr 120px;gap:var(--space-3)">
          <div class="m-field">
            <label for="connectHost">Hub IP address</label>
            <input id="connectHost" name="host" type="text" autocomplete="off" spellcheck="false" placeholder="10.0.0.20" value="${escapeHtml(formHost)}" ${connecting ? "disabled" : ""}>
          </div>
          <div class="m-field">
            <label for="connectPort">Port</label>
            <input id="connectPort" name="port" type="text" inputmode="numeric" autocomplete="off" placeholder="8080" value="${escapeHtml(formPort)}" ${connecting ? "disabled" : ""}>
          </div>
        </div>

        ${
          showSignIn
            ? `
          <div class="m-field">
            <label for="connectUsername">Username</label>
            <input id="connectUsername" name="username" type="text" autocomplete="off" spellcheck="false" value="${escapeHtml(formUser)}" ${connecting ? "disabled" : ""}>
          </div>
          <div class="m-field">
            <label for="connectPassword">Password</label>
            <input id="connectPassword" name="password" type="password" autocomplete="off" value="${escapeHtml(formPass)}" ${connecting ? "disabled" : ""}>
            ${
              !state.encryptionAvailable
                ? `<p class="m-field-hint">Secure password storage is unavailable on this computer; password will not be stored on disk.</p>`
                : ""
            }
          </div>
        `
            : `
          <div>
            <button type="button" class="btn btn-text btn-sm" id="toggleSignInBtn">My hub needs a sign-in</button>
          </div>
        `
        }

        ${
          statusMsg
            ? `<div class="notice ${statusError ? "notice-error" : "notice-ok"}" id="connectStatus" role="${statusError ? "alert" : "status"}">${escapeHtml(statusMsg)}</div>`
            : ""
        }

        <button type="submit" class="btn btn-filled btn-block" id="connectBtn" ${connecting ? "disabled" : ""}>
          ${connecting ? '<span class="m-spinner" style="border-color:var(--on-primary);border-right-color:transparent" aria-hidden="true"></span>' : ""}
          <span>${connecting ? "Connecting…" : "Connect"}</span>
        </button>
      </form>
    `;
  }

  function formatCheckedAt(ms) {
    if (!ms) return "Not checked yet";
    return `Last checked ${new Date(ms).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}`;
  }

  function renderUpdatesSection() {
    if (!updatesBridge) return "";
    const u = updates;
    const appTitle = !u
      ? "Checking…"
      : u.app
        ? `Melodious ${u.app.version} is available`
        : `Melodious ${u.appVersion}`;
    const appSub = !u
      ? ""
      : u.app
        ? `You have ${u.appVersion}. Install and Restart downloads it from GitHub and replaces this app.`
        : `${u.checks ? "Checks once a day" : "Daily checks are off"} · ${formatCheckedAt(u.lastCheckedAt)}`;
    let hubRow = "";
    if (u && u.hub) {
      const hubTitle = u.hub.legacy ? "Hub: Melodious 1.2 or older" : `Hub: Melodious ${u.hub.version}`;
      const hubSub = hubStep || u.hubNote || (u.latestHub ? "Up to date" : "");
      hubRow = `
        <div class="m-row">
          <span class="m-row-text">
            <span class="m-row-title" id="updatesHubTitle">${escapeHtml(hubTitle)}</span>
            <span class="m-row-sub">${escapeHtml(hubSub)}</span>
          </span>
          ${
            u.hubNote && u.latestHub
              ? `<span style="display:flex;gap:var(--space-2)">
                   <button type="button" class="btn btn-text btn-sm" data-release-url="${escapeHtml(u.latestHub.url)}">Release page</button>
                   <button type="button" class="btn btn-tonal btn-sm" id="updatesHubBtn" ${updatesBusy || hubStep ? "disabled" : ""}>Update hub…</button>
                 </span>`
              : ""
          }
        </div>`;
    }
    return `
      <h3 class="m-section">Updates</h3>
      <div class="m-list">
        <div class="m-row">
          <span class="m-row-text">
            <span class="m-row-title" id="updatesAppTitle">${escapeHtml(appTitle)}</span>
            <span class="m-row-sub" id="updatesAppSub">${escapeHtml(appSub)}</span>
          </span>
          ${
            u && u.app
              ? `<span style="display:flex;gap:var(--space-2)">
                   <button type="button" class="btn btn-text btn-sm" data-release-url="${escapeHtml(u.app.url)}">Release page</button>
                   <button type="button" class="btn btn-filled btn-sm" id="updatesInstallBtn" ${updatesBusy ? "disabled" : ""}>Install and Restart</button>
                 </span>`
              : ""
          }
        </div>
        ${hubRow}
      </div>
      <div style="display:flex;gap:var(--space-2);flex-wrap:wrap;margin-top:var(--space-3)">
        <button type="button" class="btn btn-tonal" id="updatesCheckBtn" ${updatesBusy ? "disabled" : ""}>
          ${updatesBusy ? '<span class="m-spinner" aria-hidden="true"></span>' : ""}<span>${updatesBusy ? "Checking…" : "Check now"}</span>
        </button>
        ${
          u
            ? `<button type="button" class="btn btn-outlined" id="updatesToggleBtn">${u.checks ? "Turn off daily checks" : "Check daily"}</button>`
            : ""
        }
        ${
          state.hub
            ? `<button type="button" class="btn btn-outlined" id="updatesReinstallBtn" ${updatesBusy || hubStep ? "disabled" : ""}>Reinstall / repair hub software…</button>`
            : ""
        }
      </div>
      ${hubStep && !hubRow ? `<p class="list-note" id="updatesHubStep" role="status">${escapeHtml(hubStep)}</p>` : ""}
      <p class="m-field-hint">Checks ask GitHub (api.github.com) for Melodious's releases. GitHub sees your IP address and this app's version; nothing about your hub or devices is sent. Nothing downloads until you choose Install and Restart, Update hub or Reinstall / repair hub software, which puts a release (or a hub zip from this computer) back on the hub whatever version it runs.</p>
    `;
  }

  function renderSettingsSections() {
    const savedHubText = state.hub
      ? `${state.hub.host}:${state.hub.port}`
      : "Not connected";
    const authStatusText = !state.encryptionAvailable
      ? "Keychain encryption unavailable (nothing stored)"
      : state.hasHubAuth
        ? `Saved${state.hubUsername ? ` for ${state.hubUsername}` : ""}`
        : "Not set";

    const wizardSettingsEntry =
      wizardBridge && wizardFlow && state.wizardDevAvailable
        ? wizardFlow.renderWizardSettingsEntry({ disabled: updatesBusy })
        : "";

    return `
      <h3 class="m-section">Current hub</h3>
      <div class="m-list">
        <div class="m-row">
          <span class="m-tile m-tile--hub" style="--tile:44px">${ROUTER_SVG}</span>
          <span class="m-row-text">
            <span class="m-row-title" id="currentHubAddress">${escapeHtml(savedHubText)}</span>
            <span class="m-row-sub">Sign-in: ${escapeHtml(authStatusText)}</span>
          </span>
          ${
            state.hub
              ? `<button type="button" class="btn btn-danger btn-sm" id="forgetHubBtn">Forget hub</button>`
              : ""
          }
        </div>
      </div>

      ${wizardSettingsEntry}

      ${renderConnectAndAddressSection({ includeWizardCard: false })}

      <h3 class="m-section">Hub sign-in</h3>
      <form id="hubAuthForm" class="m-card m-form" novalidate>
        <p class="m-field-hint" style="margin-top:0">
          Used when your hub has HTTP Basic sign-in enabled. Stored with this computer's secure password storage when available.
        </p>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:var(--space-3)">
          <div class="m-field">
            <label for="settingsAuthUser">Username</label>
            <input id="settingsAuthUser" type="text" autocomplete="off" spellcheck="false" value="${escapeHtml(formUser)}">
          </div>
          <div class="m-field">
            <label for="settingsAuthPass">Password</label>
            <input id="settingsAuthPass" type="password" autocomplete="off" value="">
          </div>
        </div>
        <div style="display:flex;gap:var(--space-2);flex-wrap:wrap">
          <button type="submit" class="btn btn-tonal" id="saveHubAuthBtn">Save sign-in</button>
          ${
            state.hasHubAuth
              ? '<button type="button" class="btn btn-outlined" id="clearHubAuthBtn">Forget sign-in</button>'
              : ""
          }
        </div>
      </form>

      <h3 class="m-section">Logitech account</h3>
      <div class="m-list">
        <div class="m-row" id="settingsLogitechRow">
          <span class="m-row-text">
            <span class="m-row-title" id="settingsLogitechStatus">${
              state.logitechSignedIn ? "Signed in to Logitech" : "Not signed in"
            }</span>
            <span class="m-row-sub">${
              !state.encryptionAvailable
                ? "Keychain encryption is unavailable; sign-in lasts only while the app is open."
                : "Used only to search and download device codes from Logitech's catalog."
            }</span>
          </span>
          ${
            state.logitechSignedIn
              ? '<button type="button" class="btn btn-outlined btn-sm" id="settingsLogitechSignOutBtn">Sign out</button>'
              : '<button type="button" class="btn btn-tonal btn-sm" id="settingsLogitechSignInBtn">Sign in</button>'
          }
        </div>
      </div>

      ${renderUpdatesSection()}

      <h3 class="m-section">Advanced</h3>
      <form id="clientIdForm" class="m-card m-form" novalidate>
        <div class="m-field">
          <label for="clientIdInput">OAuth client_id</label>
          <input id="clientIdInput" type="text" autocomplete="off" spellcheck="false" placeholder="${escapeHtml(state.defaultClientId)}" value="${escapeHtml(formClientId)}">
          <p class="m-field-hint">Leave empty to use Logitech's public desktop client_id (${escapeHtml(state.defaultClientId)}).</p>
        </div>
        <div>
          <button type="submit" class="btn btn-tonal" id="saveClientIdBtn">Save client_id</button>
        </div>
      </form>
    `;
  }

  async function loadUpdates() {
    if (!updatesBridge) return;
    try {
      updates = await updatesBridge.get();
    } catch {
      updates = null;
    }
    render();
  }

  function render() {
    const wizardOpen = Boolean(
      wiz.open && wizardBridge && wizardFlow && state.wizardDevAvailable
    );
    const isSettings = state.mode === "settings";

    if (wizardOpen) {
      document.title = "Hub Setup · Melodious";
      if (appbar) {
        appbar.hidden = false;
        if (backBtn) backBtn.hidden = false;
        if (appbarTitle) appbarTitle.textContent = "Hub Setup";
        if (appbarActions) {
          const stepNote = wiz.troubleshootingOpen
            ? "Troubleshooting"
            : wiz.step >= 4
              ? "Done"
              : `Step ${wiz.step} of 3`;
          appbarActions.innerHTML = `<span class="appbar-note" id="connectAppbarStepNote">${escapeHtml(stepNote)}</span>`;
        }
      }
      wiz.firstRunOob = !state.hub;
      root.innerHTML = wizardFlow.renderWizardPage(wiz);
      const viewKey = `${wiz.step}:${wiz.subScreen || ""}:${wiz.troubleshootingOpen ? "ts" : ""}`;
      if (viewKey !== lastWizardViewKey) {
        lastWizardViewKey = viewKey;
        document.getElementById("main")?.scrollTo?.(0, 0);
        window.scrollTo?.(0, 0);
      }
      return;
    }
    lastWizardViewKey = "";

    document.title = `${isSettings ? "Settings" : "Connect"} · Melodious`;
    if (appbar) {
      appbar.hidden = !isSettings;
      if (backBtn) {
        backBtn.hidden = !state.hub;
      }
      if (appbarTitle) {
        appbarTitle.textContent = "Settings";
      }
      if (appbarActions) {
        appbarActions.innerHTML = "";
      }
    }

    if (isSettings) {
      root.innerHTML = renderSettingsSections();
    } else {
      const heading = connecting
        ? "Connecting…"
        : scanning && discovered.length === 0
          ? "Looking for your hub…"
          : state.unreachableError
            ? "Can't reach your hub"
            : "Connect to your hub";
      const subheading = state.unreachableError
        ? "Make sure this computer is on the same network as the hub and the hub is powered on."
        : "Choose a hub discovered on your network or enter its IP address below.";

      root.innerHTML = `
        <div style="padding:var(--space-6) var(--space-1) var(--space-2);display:grid;gap:var(--space-2)">
          <span class="m-tile m-tile--primary" style="--tile:56px">${ROUTER_SVG}</span>
          <h2 class="m-title" id="connectTitle" style="margin-top:var(--space-2)">${escapeHtml(heading)}</h2>
          <p class="muted" id="connectSubtitle">${escapeHtml(subheading)}</p>
        </div>
        ${
          state.unreachableError && state.hub
            ? `<div class="notice notice-error" style="margin-top:var(--space-3)">${escapeHtml(`${state.hub.host}:${state.hub.port} — ${state.unreachableError}`)}</div>
               <div style="margin-top:var(--space-3)">
                 <button type="button" class="btn btn-filled btn-block" id="retrySavedHubBtn" ${connecting ? "disabled" : ""}>Try again</button>
               </div>`
            : ""
        }
        ${renderConnectAndAddressSection({ includeWizardCard: true })}
      `;
    }
  }

  async function runDiscovery() {
    if (scanning) return;
    scanning = true;
    render();
    try {
      const list = await bridge.discover();
      discovered = Array.isArray(list) ? list : [];
    } catch {
      discovered = [];
    } finally {
      scanning = false;
      render();
    }
  }

  async function doConnect(host, port, username, password) {
    const trimmedHost = String(host ?? "").trim();
    const trimmedPort = String(port ?? "8080").trim() || "8080";
    if (!trimmedHost) {
      statusError = true;
      statusMsg = "Enter your hub's IP address or hostname.";
      render();
      return;
    }
    connecting = true;
    statusMsg = "";
    statusError = false;
    render();
    try {
      const res = await bridge.connect({
        host: trimmedHost,
        port: Number(trimmedPort),
        username: showSignIn ? String(username ?? "") : "",
        password: showSignIn ? String(password ?? "") : "",
      });
      if (res && res.ok) {
        window.location.hash = "#remote";
        window.location.reload();
        return;
      }
      if (res && res.authRequired) {
        showSignIn = true;
        formHost = trimmedHost;
        formPort = trimmedPort;
        statusError = true;
        statusMsg = res.error || "This hub requires a username and password.";
      } else {
        statusError = true;
        statusMsg = (res && res.error) || `Can't reach a Melodious hub at ${trimmedHost}:${trimmedPort}.`;
      }
    } catch (err) {
      statusError = true;
      statusMsg = err?.message || "Connection failed.";
    } finally {
      connecting = false;
      render();
    }
  }

  function syncInputsFromDom() {
    const hostEl = document.getElementById("connectHost");
    const portEl = document.getElementById("connectPort");
    const userEl = document.getElementById("connectUsername");
    const passEl = document.getElementById("connectPassword");
    const cidEl = document.getElementById("clientIdInput");
    if (hostEl) formHost = hostEl.value;
    if (portEl) formPort = portEl.value;
    if (userEl) formUser = userEl.value;
    if (passEl) formPass = passEl.value;
    if (cidEl) formClientId = cidEl.value;

    const ipDisclosureEl = document.getElementById("wizardIpDisclosure");
    if (ipDisclosureEl) wiz.ipDisclosureOpen = Boolean(ipDisclosureEl.open);
    const advDetailsEl = document.getElementById("wizardAdvancedOptions");
    if (advDetailsEl) wiz.advancedOpen = Boolean(advDetailsEl.open);

    const wizFreshEl = document.getElementById("wizardIntentFresh");
    const wizProvEl = document.getElementById("wizardIntentProvisioned");
    const wizHostEl = document.getElementById("wizardHostInput");
    const wizMaskEl = document.getElementById("wizardMaskIds");
    const wizSsidEl = document.getElementById("wizardWifiSsidInput");
    const wizEncEl = document.getElementById("wizardWifiEncSelect");
    const wizPassEl = document.getElementById("wizardWifiPassInput");
    const freshHostEl = document.getElementById("freshConfirmedHostInput");
    const wizHubNameEl = document.getElementById("wizardHubNameInput");
    const useLocalZipEl = document.getElementById("wizardUseLocalZip");
    const customHubIdEl = document.getElementById("wizardCustomHubIdInput");
    const tsHostEl = document.getElementById("wizardTroubleshootHostInput");
    const tsHubIdEl = document.getElementById("wizardTroubleshootHubIdInput");
    const allowPostEl = document.getElementById("wizardAllowUnprovenPost");

    if (wizFreshEl?.checked) wiz.intent = "fresh";
    if (wizProvEl?.checked) wiz.intent = "provisioned";
    if (wizHostEl) {
      const prevManual = wiz.hostInput;
      wiz.hostInput = wizHostEl.value;
      if (wizHostEl.value !== prevManual) {
        wiz.confirmedHost = wizHostEl.value.trim();
      }
    }
    if (wizMaskEl) wiz.maskIds = wizMaskEl.checked;
    if (wizSsidEl) wiz.wifiSsid = wizSsidEl.value;
    if (wizEncEl) wiz.wifiEncryption = wizEncEl.value;
    if (wizPassEl) wiz.wifiPassword = wizPassEl.value;
    if (freshHostEl) wiz.confirmedHost = freshHostEl.value.trim();
    if (wizHubNameEl) wiz.hubNameInput = wizHubNameEl.value;
    if (useLocalZipEl) {
      wiz.installSource = useLocalZipEl.checked ? "local" : "latest";
    }
    if (customHubIdEl) {
      if (wiz.flowPath === "provisioned") {
        wiz.provHubIdInput = customHubIdEl.value;
      } else {
        wiz.remoteIdInput = customHubIdEl.value;
      }
    }
    if (tsHostEl) {
      wiz.confirmedHost = tsHostEl.value.trim();
    }
    if (tsHubIdEl) {
      if (wiz.flowPath === "provisioned") {
        wiz.provHubIdInput = tsHubIdEl.value;
      } else {
        wiz.remoteIdInput = tsHubIdEl.value;
      }
    }
    if (allowPostEl) wiz.allowUnprovenPost = allowPostEl.checked;
  }

  function applyWedgeFromOutcome(res) {
    const wedged = Boolean(
      res?.result?.usbWedge ||
        res?.result?.usb?.usbWedge ||
        res?.result?.wifiScan?.usbWedge ||
        res?.result?.wifiStatus?.usbWedge ||
        res?.result?.wifiConnect?.usbWedge ||
        res?.result?.factoryReset?.usbWedge ||
        res?.result?.firmwareFlash?.usbWedge ||
        res?.result?.tdeEnable?.usbWedge ||
        res?.result?.provisionLocal?.usbWedge ||
        res?.result?.automationConfig?.usbWedge ||
        res?.result?.root?.usbWedge
    );
    if (wedged) {
      wiz.usbWedgeActive = true;
      wiz.usbWedgeMessage = res?.error || "";
    }
  }

  async function confirmWizardStep({ title, body, confirmLabel = "Continue", danger = false }) {
    if (!wizardFlow?.openWizardConfirmDialog) return false;
    return wizardFlow.openWizardConfirmDialog(document, {
      title,
      body,
      confirmLabel,
      danger,
    });
  }

  async function runWizardDetect() {
    if (!wizardBridge || !wizardFlow || !state.wizardDevAvailable || wiz.busy) return;
    syncInputsFromDom();
    wiz.busy = true;
    wiz.busyAction = "detect";
    wiz.error = "";
    wiz.showTechDetails = false;
    wiz.logLines = [];
    render();
    try {
      const typedStep1Host = wiz.step === 1 ? wiz.hostInput.trim() : "";
      const targetHost =
        wiz.step === 1 ? typedStep1Host : (wiz.confirmedHost || wiz.hostInput).trim();
      const res = await wizardBridge.detectAndClassify({
        userIntent: wiz.intent,
        host: targetHost,
        skipUsb: false,
        mask: wiz.maskIds,
      });
      wiz.classifyResult = res;
      wiz.usbWedgeActive = Boolean(res?.usbWedge?.wedged);
      wiz.usbWedgeMessage = res?.usbWedge?.message || "";
      if (res?.firmwareGate?.passes === true) {
        wiz.firmwarePassed = true;
      }
      if (res?.signals?.lan?.ports?.["22"]) {
        wiz.sshOpen = true;
      }
      const detectedHost = wizardFlow.extractDetectedHost(res);
      if (typedStep1Host) {
        // User explicitly typed an IP on Step 1 — never overwrite it with a different SSDP IP.
        wiz.confirmedHost = typedStep1Host;
      } else if (detectedHost) {
        wiz.confirmedHost = detectedHost;
      }
      const detectedHubId = wizardFlow.extractDetectedNumericHubId(res);
      if (detectedHubId !== null && !wiz.provHubIdInput.trim()) {
        wiz.provHubIdInput = String(detectedHubId);
      }
      wiz.stepText = "";
    } catch (err) {
      wiz.error = err?.message || String(err);
      wiz.stepText = "";
    } finally {
      wiz.busy = false;
      wiz.busyAction = "";
      render();
    }
  }

  async function enterStep2Wifi() {
    wiz.flowPath = "fresh";
    wiz.step = 2;
    wiz.subScreen = null;
    wiz.error = "";
    wiz.showTechDetails = false;
    render();
    if (!wiz.wifiScanned && !wiz.wifiConnected && !wiz.busy) {
      await handleWifiScan();
    }
  }

  function enterStep3Install(flowPath = wiz.flowPath, transport = wiz.provisionedTransport) {
    wiz.flowPath = flowPath === "provisioned" ? "provisioned" : "fresh";
    wiz.provisionedTransport = transport === "usb" ? "usb" : "lan";
    wiz.step = 3;
    wiz.subScreen = null;
    wiz.error = "";
    wiz.showTechDetails = false;
    wiz.installChecklistFailedStep = 0;
    render();
  }

  async function enterStep4Done(rawHost, rawPort = 8080) {
    const host = String(rawHost || wiz.confirmedHost || wiz.hostInput || "").trim();
    const port = Number(rawPort) || 8080;
    wiz.step = 4;
    wiz.subScreen = null;
    wiz.handoffHost = host;
    wiz.handoffPort = port;
    wiz.handoffError = "";
    wiz.handoffConnected = false;
    render();
    if (!host) {
      wiz.handoffError = "No hub IP address set.";
      render();
      return;
    }
    wiz.busy = true;
    wiz.busyAction = "handoff";
    render();
    try {
      const res = await bridge.connect({ host, port });
      if (res && res.ok) {
        wiz.handoffConnected = true;
        wiz.handoffFirmware = res.firmware || "";
        wiz.handoffError = "";
        state = await bridge.getState();
      } else {
        wiz.handoffConnected = false;
        wiz.handoffError = res?.error || `Could not connect to ${host} yet.`;
      }
    } catch (err) {
      wiz.handoffConnected = false;
      wiz.handoffError = err?.message || String(err);
    } finally {
      wiz.busy = false;
      wiz.busyAction = "";
      wiz.stepText = "";
      render();
    }
  }

  async function handleFlashFirmware() {
    if (!wizardBridge || wiz.busy) return;
    syncInputsFromDom();

    wiz.busy = true;
    wiz.busyAction = "usb-flash-firmware";
    wiz.error = "";
    wiz.showTechDetails = false;
    wiz.logLines = [];
    render();
    try {
      const res = await wizardBridge.runAction({
        action: "usb-flash-firmware",
        confirmAction: "usb-flash-firmware",
        mask: wiz.maskIds,
      });
      if (res?.canceled) {
        wiz.stepText = "";
        return;
      }
      applyWedgeFromOutcome(res);
      if (!res?.ok) {
        wiz.error = res?.error || "Software update did not complete.";
        return;
      }
      wiz.firmwarePassed = true;
      wiz.subScreen = null;
      showSnackbar("Hub software updated to 4.15.600.");
      wiz.busy = false;
      wiz.busyAction = "";
      const activeHost = (wiz.confirmedHost || wiz.hostInput).trim();
      if (wiz.flowPath === "provisioned" && wizardFlow.isUnmaskedHost(activeHost)) {
        enterStep3Install("provisioned", wiz.provisionedTransport);
      } else {
        await enterStep2Wifi();
      }
      return;
    } catch (err) {
      wiz.error = err?.message || String(err);
    } finally {
      wiz.busy = false;
      wiz.busyAction = "";
      wiz.stepText = "";
      render();
    }
  }

  async function handleFactoryReset() {
    if (!wizardBridge || wiz.busy) return;
    syncInputsFromDom();

    wiz.busy = true;
    wiz.busyAction = "usb-factory-reset";
    wiz.error = "";
    wiz.showTechDetails = false;
    wiz.logLines = [];
    render();
    try {
      const res = await wizardBridge.runAction({
        action: "usb-factory-reset",
        confirmAction: "usb-factory-reset",
        resetPayload: "1",
        mask: wiz.maskIds,
      });
      applyWedgeFromOutcome(res);
      if (!res?.ok) {
        wiz.error = res?.error || "Could not erase the hub over USB.";
      } else {
        wiz.factoryResetSent = true;
        wiz.factoryResetGuidance = res.result?.factoryReset?.powerCycleGuidance || "";
        wiz.classifyResult = null;
        wiz.intent = "fresh";
        wiz.flowPath = "fresh";
        wiz.confirmedHost = "";
        wiz.hostInput = "";
        wiz.wifiConnected = false;
        wiz.wifiScanned = false;
        wiz.tdeDone = false;
        wiz.provisionLocalDone = false;
        wiz.seedAutomationDone = false;
        wiz.sshOpen = false;
        wiz.didRootInSession = false;
        wiz.installDone = false;
        showSnackbar("Hub erased. Unplug the USB cable for 15 seconds.");
      }
    } catch (err) {
      wiz.error = err?.message || String(err);
    } finally {
      wiz.busy = false;
      wiz.busyAction = "";
      wiz.stepText = "";
      render();
    }
  }

  async function handleWifiScan() {
    if (!wizardBridge || wiz.busy) return;
    syncInputsFromDom();
    wiz.busy = true;
    wiz.busyAction = "usb-wifi-scan";
    wiz.error = "";
    wiz.showTechDetails = false;
    render();
    try {
      const res = await wizardBridge.runAction({
        action: "usb-wifi-scan",
        showSsids: true,
        mask: false,
      });
      applyWedgeFromOutcome(res);
      if (!res?.ok) {
        wiz.error = "Couldn't scan for Wi-Fi networks. Make sure the USB cable is connected and try Scan Again.";
      } else {
        wiz.wifiScanned = true;
        const nets = res.result?.wifiScan?.networks;
        wiz.wifiNetworks = Array.isArray(nets) ? nets : [];
        if (!wiz.wifiSsid && wiz.wifiNetworks[0]?.ssid) {
          const first = wiz.wifiNetworks[0];
          wiz.wifiSsid = String(first.ssid);
          const rawEnc = String(first.encryption || first.security || "WPA2-PSK").toUpperCase();
          if (rawEnc === "NONE" || rawEnc === "OPEN") wiz.wifiEncryption = "OPEN";
          else if (rawEnc.includes("WPA2")) wiz.wifiEncryption = "WPA2-PSK";
          else if (rawEnc.includes("WPA")) wiz.wifiEncryption = "WPA-PSK";
        }
      }
    } catch (err) {
      wiz.error = err?.message || String(err);
    } finally {
      wiz.busy = false;
      wiz.busyAction = "";
      wiz.stepText = "";
      render();
    }
  }

  async function handleWifiConnect() {
    if (!wizardBridge || !wizardFlow || wiz.busy) return;
    syncInputsFromDom();
    const ssid = wiz.wifiSsid.trim();
    const enc = wiz.wifiEncryption || "WPA2-PSK";
    const pass = enc === "OPEN" ? "" : wiz.wifiPassword;

    if (!ssid) {
      wiz.error = "Choose a 2.4 GHz Wi-Fi network or enter its name.";
      render();
      return;
    }
    if (enc !== "OPEN" && !pass) {
      wiz.error = "Enter the Wi-Fi password for this network.";
      render();
      return;
    }

    wiz.busy = true;
    wiz.busyAction = "usb-wifi-connect";
    wiz.error = "";
    wiz.showTechDetails = false;
    wiz.wifiIpDetectFailed = false;
    wiz.logLines = [];
    render();
    try {
      const res = await wizardBridge.runAction({
        action: "usb-wifi-connect",
        confirmAction: "usb-wifi-connect",
        ssid,
        encryption: enc,
        password: pass,
        showSsids: true,
        mask: wiz.maskIds,
      });
      applyWedgeFromOutcome(res);
      if (!res?.ok) {
        wiz.error = "Couldn't connect your hub to Wi-Fi. Check the password and make sure it's a 2.4 GHz network.";
        return;
      }

      wiz.wifiConnected = true;
      render();

      let detectedUsbIp = "";
      for (let attempt = 0; attempt < 8; attempt += 1) {
        if (attempt > 0) {
          await new Promise((r) => setTimeout(r, 2500));
        }
        const statusRes = await wizardBridge
          .runAction({
            action: "usb-wifi-status",
            showSsids: true,
            mask: false,
          })
          .catch(() => null);
        const candIp = String(
          statusRes?.result?.wifiStatus?.ipAddress ||
            statusRes?.result?.wifiStatus?.ip ||
            ""
        ).trim();
        if (wizardFlow.isUnmaskedHost(candIp) && candIp !== "0.0.0.0") {
          detectedUsbIp = candIp;
          break;
        }
      }
      if (detectedUsbIp) {
        wiz.confirmedHost = detectedUsbIp;
      } else if (!wiz.confirmedHost.trim()) {
        // Query USB-isolated classification (skipUsb: false) so another hub on SSDP
        // can never be mistaken for this USB-connected hub's IP.
        const cls = await wizardBridge
          .detectAndClassify({
            userIntent: wiz.flowPath === "provisioned" ? "provisioned" : "fresh",
            host: "",
            skipUsb: false,
            mask: false,
          })
          .catch(() => null);
        const usbDetectedHost = wizardFlow.extractDetectedHost(cls);
        if (usbDetectedHost) wiz.confirmedHost = usbDetectedHost;
      }
      wiz.wifiIpDetectFailed = !wizardFlow.isUnmaskedHost(wiz.confirmedHost);
      showSnackbar(
        wiz.confirmedHost
          ? `Connected to ${ssid}.`
          : "Wi-Fi connected. Enter your hub's IP address from your router below."
      );
    } catch (err) {
      wiz.error = err?.message || String(err);
    } finally {
      wiz.busy = false;
      wiz.busyAction = "";
      wiz.stepText = "";
      render();
    }
  }

  async function handleInstallMelodious() {
    if (!wizardBridge || !wizardFlow || wiz.busy) return;
    syncInputsFromDom();

    const host = (wiz.confirmedHost || wiz.hostInput).trim();
    if (!wizardFlow.isUnmaskedHost(host)) {
      wiz.error = "Hub IP address is missing. Go back and find your hub or connect it to Wi-Fi first.";
      wiz.installChecklistFailedStep = 1;
      render();
      return;
    }

    const isProv = wiz.flowPath === "provisioned";
    const rawHubId = isProv
      ? wiz.provHubIdInput || wiz.remoteIdInput
      : wiz.remoteIdInput;
    const hubIdInt = wizardFlow.parsePositiveIntInput(rawHubId);
    if (hubIdInt === null) {
      wiz.error = "Custom Hub ID must be a positive whole number (for example, 20264150).";
      wiz.advancedOpen = true;
      wiz.installChecklistFailedStep = 1;
      render();
      return;
    }

    wiz.busy = true;
    wiz.busyAction = "unified-install";
    wiz.installRunning = true;
    wiz.installChecklistStep = 1;
    wiz.installChecklistFailedStep = 0;
    wiz.error = "";
    wiz.showTechDetails = false;
    wiz.usbWedgeActive = false;
    wiz.logLines = [];
    render();

    const failAtStep = (stepNum, errMessage) => {
      wiz.installChecklistFailedStep = stepNum;
      wiz.installChecklistStep = 0;
      wiz.error = errMessage || "Setup paused.";
    };

    try {
      // 1. Preparing hub for offline use
      if (!isProv) {
        wiz.installChecklistStep = 1;
        render();

        if (!wiz.tdeDone) {
          const tdeRes = await wizardBridge.runAction({
            action: "usb-tde-enable",
            confirmAction: "usb-tde-enable",
            mask: wiz.maskIds,
          });
          applyWedgeFromOutcome(tdeRes);
          if (!tdeRes?.ok) {
            failAtStep(1, tdeRes?.error || "Could not prepare hub file access over USB.");
            return;
          }
          wiz.tdeDone = true;
          render();
        }

        if (!wiz.provisionLocalDone) {
          const provRes = await wizardBridge.runAction({
            action: "usb-provision-local",
            confirmAction: "usb-provision-local",
            remoteId: hubIdInt,
            hubName: wiz.hubNameInput.trim() || "Harmony Hub",
            accountId: wiz.accountIdInput.trim(),
            mask: wiz.maskIds,
          });
          applyWedgeFromOutcome(provRes);
          if (!provRes?.ok) {
            failAtStep(1, provRes?.error || "Could not save offline setup on the hub.");
            return;
          }
          wiz.provisionLocalDone = true;
          render();
        }

        if (!wiz.seedAutomationDone) {
          const seedRes = await wizardBridge.runAction({
            action: "usb-seed-automation",
            confirmAction: "usb-seed-automation",
            remoteId: hubIdInt,
            accountId: wiz.accountIdInput.trim(),
            mask: wiz.maskIds,
          });
          applyWedgeFromOutcome(seedRes);
          if (!seedRes?.ok) {
            failAtStep(1, seedRes?.error || "Could not finish offline preparation over USB.");
            return;
          }
          wiz.seedAutomationDone = true;
          render();
        }
      }

      // 2. Setting up local hub access
      wiz.installChecklistStep = 2;
      render();

      if (!wiz.sshOpen) {
        const rootAction = isProv
          ? wiz.provisionedTransport === "usb"
            ? "usb-root"
            : "lan-root-xmpp"
          : "usb-root";
        const rootRes = await wizardBridge.runAction({
          action: rootAction,
          confirmAction: rootAction,
          host,
          remoteId: hubIdInt,
          mask: wiz.maskIds,
        });
        applyWedgeFromOutcome(rootRes);
        if (!rootRes?.ok) {
          failAtStep(2, rootRes?.error || "Could not enable local access on the hub.");
          return;
        }
        if (rootRes.result?.root?.sshPortOpen === false) {
          failAtStep(2, `Local access did not open on ${host}.`);
          return;
        }
        wiz.sshOpen = true;
        wiz.didRootInSession = true;
        render();
      }

      // 3. Downloading and installing Melodious
      wiz.installChecklistStep = 3;
      render();

      let installRes = await wizardBridge.installHub({
        source: wiz.installSource,
        host,
        hubId: hubIdInt,
        preflightOnly: false,
        removeRootToolLeftovers: true,
        replaceStaleHostKey: Boolean(wiz.didRootInSession),
      });
      if (installRes?.canceled) {
        wiz.installChecklistStep = 0;
        return;
      }
      if (!installRes?.ok && !wiz.didRootInSession && installRes?.hostKeyChanged) {
        const fpNote = installRes.hostKeyFingerprint
          ? `\n\nSecurity key fingerprint:\n${installRes.hostKeyFingerprint}`
          : "";
        const trustOk = await confirmWizardStep({
          title: "Hub security key changed",
          body:
            `This hub's security key changed on ${host} — this is normal after a reset or re-setup. Trust this hub and continue installing Melodious?` +
            fpNote,
          confirmLabel: "Trust & Continue",
        });
        if (!trustOk) {
          failAtStep(3, installRes?.error || "Installation canceled.");
          return;
        }
        wiz.logLines = [];
        render();
        installRes = await wizardBridge.installHub({
          source: wiz.installSource,
          host,
          hubId: hubIdInt,
          preflightOnly: false,
          removeRootToolLeftovers: true,
          replaceStaleHostKey: true,
        });
        if (installRes?.canceled) {
          wiz.installChecklistStep = 0;
          return;
        }
      }
      if (!installRes?.ok) {
        const failedStage = installRes?.webUiReachable === false ? 4 : wiz.installChecklistStep || 3;
        failAtStep(failedStage, installRes?.error || "Melodious installation did not complete.");
        return;
      }

      // 4. Restarting hub and checking connection -> Screen 4 (Done)
      wiz.installedVersion = installRes.version || "";
      wiz.installDone = true;
      wiz.handoffPort = Number(installRes.port) || 8080;
      wiz.installChecklistStep = 4;
      render();

      showSnackbar(
        wiz.installedVersion
          ? `Melodious ${wiz.installedVersion} installed!`
          : "Melodious installed!"
      );
      wiz.busy = false;
      wiz.busyAction = "";
      wiz.installChecklistStep = 0;
      await enterStep4Done(host, wiz.handoffPort);
      return;
    } catch (err) {
      failAtStep(wiz.installChecklistStep || 1, err?.message || String(err));
    } finally {
      wiz.busy = false;
      wiz.busyAction = "";
      wiz.stepText = "";
      render();
    }
  }

  async function handleTroubleshootingPreflightOnly() {
    if (!wizardBridge || !wizardFlow || wiz.busy) return;
    syncInputsFromDom();
    const host = (wiz.confirmedHost || wiz.hostInput).trim();
    if (!wizardFlow.isUnmaskedHost(host)) {
      wiz.error = "Enter a Target Hub IP before running Preflight Check Only.";
      render();
      return;
    }
    const rawHubId =
      wiz.flowPath === "provisioned"
        ? wiz.provHubIdInput || wiz.remoteIdInput
        : wiz.remoteIdInput;
    const hubIdInt = wizardFlow.parsePositiveIntInput(rawHubId);
    if (hubIdInt === null) {
      wiz.error = "Enter a positive numeric Hub ID before running Preflight Check Only.";
      render();
      return;
    }

    wiz.busy = true;
    wiz.busyAction = "preflight-only";
    wiz.error = "";
    wiz.lastManualOutcome = null;
    render();
    try {
      const installRes = await wizardBridge.installHub({
        source: wiz.installSource,
        host,
        hubId: hubIdInt,
        preflightOnly: true,
        removeRootToolLeftovers: true,
        replaceStaleHostKey: false,
      });
      if (!installRes?.canceled) {
        wiz.lastManualOutcome = {
          action: "preflight-only",
          ok: Boolean(installRes?.ok),
          error: installRes?.error || "",
        };
        if (installRes?.ok) {
          wiz.preflightPassed = true;
          showSnackbar(`Preflight passed for Melodious ${installRes.version || ""}`.trim());
        }
      }
    } catch (err) {
      wiz.error = err?.message || String(err);
    } finally {
      wiz.busy = false;
      wiz.busyAction = "";
      render();
    }
  }

  async function handleManualOverrideAction(action) {
    if (!wizardBridge || !wizardFlow || wiz.busy) return;
    syncInputsFromDom();
    const readonlyActions = new Set([
      "usb-preflight",
      "usb-wifi-scan",
      "usb-wifi-status",
    ]);
    const isReadonly = readonlyActions.has(action);
    if (!isReadonly) {
      const extraWarn =
        action === "post-root"
          ? "\n\nEXPERIMENTAL: HTTP POST root is unproven on full runs."
          : "";
      const ok = await confirmWizardStep({
        title: `Run troubleshooting action "${action}"?`,
        body: `This runs ${action} directly against the connected hub.${extraWarn}`,
        confirmLabel: `Run ${action}`,
        danger: action === "usb-factory-reset",
      });
      if (!ok) return;
    }

    wiz.busy = true;
    wiz.busyAction = action;
    wiz.error = "";
    wiz.lastManualOutcome = null;
    render();
    try {
      let res;
      if (action === "usb-preflight") {
        res = await wizardBridge.usbProbe({
          action: "usb-preflight",
          mask: wiz.maskIds,
        });
        res = { ...res, action: "usb-preflight" };
      } else {
        const rawRid =
          wiz.flowPath === "provisioned"
            ? wiz.provHubIdInput || wiz.remoteIdInput
            : wiz.remoteIdInput;
        const ridInt = wizardFlow.parsePositiveIntInput(rawRid);
        res = await wizardBridge.runAction({
          action,
          confirmAction: isReadonly ? "" : action,
          allowUnprovenPost: action === "post-root" && wiz.allowUnprovenPost,
          host: (wiz.confirmedHost || wiz.hostInput).trim(),
          mask: wiz.maskIds,
          ssid: wiz.wifiSsid.trim(),
          encryption: wiz.wifiEncryption || "WPA2-PSK",
          password: wiz.wifiPassword,
          remoteId: ridInt,
          hubName: wiz.hubNameInput.trim() || "Harmony Hub",
          accountId: wiz.accountIdInput.trim(),
        });
      }
      if (!res?.canceled) {
        applyWedgeFromOutcome(res);
        wiz.lastManualOutcome = res;
        if (action === "usb-factory-reset" && res?.ok) {
          wiz.factoryResetSent = true;
          wiz.factoryResetGuidance = res.result?.factoryReset?.powerCycleGuidance || "";
        }
      }
    } catch (err) {
      wiz.error = err?.message || String(err);
    } finally {
      wiz.busy = false;
      wiz.busyAction = "";
      render();
    }
  }

  root.addEventListener(
    "toggle",
    (event) => {
      const id = event.target?.id || "";
      if (id === "wizardIpDisclosure") {
        wiz.ipDisclosureOpen = Boolean(event.target.open);
      } else if (id === "wizardAdvancedOptions") {
        wiz.advancedOpen = Boolean(event.target.open);
      }
    },
    true
  );

  root.addEventListener("input", (event) => {
    syncInputsFromDom();
    if (event.target?.id === "freshConfirmedHostInput") {
      const continueBtn = document.getElementById("wizardWifiContinueBtn");
      if (continueBtn) {
        continueBtn.disabled =
          wiz.busy || !wizardFlow?.isUnmaskedHost(wiz.confirmedHost);
      }
    }
  });

  root.addEventListener("change", (event) => {
    const prevIntent = wiz.intent;
    syncInputsFromDom();
    const id = event.target?.id || "";
    const name = event.target?.name || "";
    if (name === "wizardIntent") {
      if (wiz.intent !== prevIntent) {
        wiz.classifyResult = null;
        wiz.error = "";
      }
      render();
      return;
    }
    if (
      id === "wizardUseLocalZip" ||
      id === "wizardWifiEncSelect" ||
      id === "wizardAllowUnprovenPost" ||
      id === "wizardMaskIds"
    ) {
      render();
    }
  });

  root.addEventListener("click", async (event) => {
    const target = event.target;

    if (target.closest("#openWizardConnectBtn") && state.wizardDevAvailable) {
      syncInputsFromDom();
      wiz.open = true;
      wiz.returnMode = "connect";
      wiz.troubleshootingOpen = false;
      wiz.subScreen = null;
      render();
      return;
    }

    if (target.closest("#openWizardSettingsBtn") && state.wizardDevAvailable) {
      syncInputsFromDom();
      wiz.open = true;
      wiz.returnMode = "settings";
      wiz.troubleshootingOpen = false;
      wiz.subScreen = null;
      if (wiz.intent === "provisioned" && !wiz.hostInput && formHost) {
        wiz.hostInput = formHost;
        wiz.confirmedHost = formHost.trim();
      }
      render();
      return;
    }

    if (wiz.open && state.wizardDevAvailable) {
      if (target.closest("#wizardUseExistingConnectBtn")) {
        syncInputsFromDom();
        connectExistingChosen = true;
        wiz.open = false;
        wiz.error = "";
        wiz.showTechDetails = false;
        await bridge.openConnect();
        state.mode = "connect";
        render();
        runDiscovery();
        return;
      }
      if (target.closest("#wizardOpenTroubleshootingBtn")) {
        syncInputsFromDom();
        wiz.troubleshootingOpen = true;
        wiz.error = "";
        render();
        return;
      }
      if (target.closest("#wizardCloseTroubleshootingBtn")) {
        syncInputsFromDom();
        wiz.troubleshootingOpen = false;
        wiz.error = "";
        render();
        return;
      }
      if (target.closest("#wizardToggleTechDetailsBtn")) {
        syncInputsFromDom();
        wiz.showTechDetails = !wiz.showTechDetails;
        render();
        return;
      }
      if (target.closest("#wizardCopyLogBtn")) {
        const text = [wiz.error ? `Error: ${wiz.error}` : "", ...wiz.logLines]
          .filter(Boolean)
          .join("\n");
        if (text && navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(text).catch(() => {});
          showSnackbar("Copied diagnostic log.");
        }
        return;
      }
      if (target.closest("#wizardClearLogBtn")) {
        wiz.logLines = [];
        wiz.lastManualOutcome = null;
        render();
        return;
      }
      if (target.closest("#wizardDetectBtn") || target.closest("#wizardRecheckBtn")) {
        await runWizardDetect();
        return;
      }
      if (target.closest("#wizardKeepExistingBtn")) {
        syncInputsFromDom();
        wiz.intent = "provisioned";
        wiz.flowPath = "provisioned";
        render();
        await runWizardDetect();
        return;
      }
      const switchBtn = target.closest("#wizardSwitchIntentBtn");
      if (switchBtn) {
        syncInputsFromDom();
        const rec = switchBtn.dataset.recommendedIntent;
        if (rec === "fresh" || rec === "provisioned") {
          wiz.intent = rec;
          wiz.flowPath = rec;
          render();
          await runWizardDetect();
        }
        return;
      }
      if (
        target.closest("#wizardEraseAndStartFreshBtn") ||
        target.closest("#wizardStartFreshBtn")
      ) {
        syncInputsFromDom();
        wiz.subScreen = "factory-reset";
        wiz.factoryResetSent = false;
        wiz.error = "";
        wiz.showTechDetails = false;
        render();
        return;
      }
      if (target.closest("#wizardToFirmwareUpdateBtn")) {
        syncInputsFromDom();
        wiz.flowPath = wizardFlow.deriveRecommendedPath(wiz.classifyResult, wiz.intent);
        wiz.subScreen = "firmware-update";
        wiz.error = "";
        wiz.showTechDetails = false;
        render();
        return;
      }
      if (target.closest("#wizardSubScreenBackBtn")) {
        syncInputsFromDom();
        wiz.subScreen = null;
        wiz.error = "";
        wiz.showTechDetails = false;
        render();
        return;
      }
      if (target.closest("#wizardConfirmFactoryResetBtn")) {
        await handleFactoryReset();
        return;
      }
      if (target.closest("#wizardPostResetCheckBtn")) {
        wiz.subScreen = null;
        wiz.factoryResetSent = false;
        wiz.intent = "fresh";
        wiz.flowPath = "fresh";
        wiz.error = "";
        await runWizardDetect();
        return;
      }
      if (target.closest("#wizardUseUsbInsteadBtn")) {
        syncInputsFromDom();
        wiz.flowPath = "provisioned";
        wiz.provisionedTransport = "usb";
        const activeHost = (wiz.confirmedHost || wiz.hostInput).trim();
        if (wizardFlow.isUnmaskedHost(activeHost)) {
          enterStep3Install("provisioned", "usb");
        } else {
          wiz.step = 2;
          wiz.subScreen = null;
          wiz.error = "";
          render();
          if (!wiz.wifiScanned && !wiz.wifiConnected && !wiz.busy) {
            await handleWifiScan();
          }
        }
        return;
      }
      const toStep2Btn = target.closest("#wizardToStep2Btn");
      if (toStep2Btn) {
        syncInputsFromDom();
        const branch =
          toStep2Btn.dataset.nextBranch ||
          wizardFlow.deriveRecommendedPath(wiz.classifyResult, wiz.intent);
        if (branch === "provisioned") {
          const port5222 = Boolean(wiz.classifyResult?.signals?.lan?.ports?.["5222"]);
          const port22 = Boolean(wiz.classifyResult?.signals?.lan?.ports?.["22"]);
          enterStep3Install("provisioned", port5222 || port22 ? "lan" : "usb");
        } else {
          await enterStep2Wifi();
        }
        return;
      }
      if (target.closest("#wizardSkipToStep3Btn")) {
        syncInputsFromDom();
        const host =
          wizardFlow.extractDetectedHost(wiz.classifyResult) ||
          wiz.confirmedHost.trim() ||
          wiz.hostInput.trim();
        if (host) {
          const res = await bridge.connect({ host, port: 8080 });
          if (res?.ok) {
            await bridge.openShell();
            window.location.hash = "#remote";
            window.location.reload();
            return;
          }
        }
        await enterStep4Done(host);
        return;
      }
      if (target.closest("#wizardBackToStep1Btn")) {
        syncInputsFromDom();
        wiz.step = 1;
        wiz.subScreen = null;
        wiz.error = "";
        wiz.showTechDetails = false;
        render();
        return;
      }
      if (target.closest("#wizardWifiContinueBtn")) {
        syncInputsFromDom();
        enterStep3Install(wiz.flowPath, wiz.provisionedTransport);
        return;
      }
      if (target.closest("#wizardBackFromInstallBtn")) {
        syncInputsFromDom();
        wiz.step = wiz.flowPath === "fresh" ? 2 : 1;
        wiz.error = "";
        wiz.showTechDetails = false;
        render();
        return;
      }
      if (target.closest("#wizardInstallMelodiousBtn")) {
        await handleInstallMelodious();
        return;
      }
      if (target.closest("#wizardRetryHandoffBtn")) {
        await enterStep4Done(
          wiz.handoffHost || wiz.confirmedHost || wiz.hostInput,
          wiz.handoffPort || 8080
        );
        return;
      }
      if (target.closest("#wizardOpenHubBtn")) {
        const host = (wiz.handoffHost || wiz.confirmedHost || wiz.hostInput).trim();
        if (!wiz.handoffConnected && host) {
          const res = await bridge.connect({ host, port: wiz.handoffPort || 8080 });
          if (!res?.ok) {
            wiz.handoffError = res?.error || `Can't reach ${host} yet.`;
            render();
            return;
          }
        }
        await bridge.openShell();
        window.location.hash = "#remote";
        window.location.reload();
        return;
      }
      if (target.closest("#freshFlashFirmwareBtn")) {
        await handleFlashFirmware();
        return;
      }
      if (target.closest("#freshWifiScanBtn")) {
        await handleWifiScan();
        return;
      }
      const wifiRow = target.closest("[data-wifi-idx]");
      if (wifiRow) {
        syncInputsFromDom();
        const picked = wiz.wifiNetworks[Number(wifiRow.dataset.wifiIdx)];
        if (picked) {
          wiz.wifiSsid = String(picked.ssid || "");
          const rawEnc = String(picked.encryption || picked.security || "WPA2-PSK").toUpperCase();
          if (rawEnc === "NONE" || rawEnc === "OPEN") wiz.wifiEncryption = "OPEN";
          else if (rawEnc.includes("WPA2")) wiz.wifiEncryption = "WPA2-PSK";
          else if (rawEnc.includes("WPA")) wiz.wifiEncryption = "WPA-PSK";
          render();
        }
        return;
      }
      if (target.closest("#freshWifiConnectBtn")) {
        await handleWifiConnect();
        return;
      }
      if (target.closest("#freshVerifyLanBtn")) {
        await runWizardDetect();
        return;
      }
      if (target.closest("#wizardRunPreflightBtn")) {
        await handleTroubleshootingPreflightOnly();
        return;
      }
      const manualBtn = target.closest("[data-wizard-manual-action]");
      if (manualBtn) {
        await handleManualOverrideAction(manualBtn.dataset.wizardManualAction);
        return;
      }
    }

    const releaseBtn = target.closest("[data-release-url]");
    if (releaseBtn && updatesBridge) {
      await updatesBridge.openRelease(releaseBtn.dataset.releaseUrl);
      return;
    }
    if (target.closest("#updatesHubBtn") && updatesBridge && !updatesBusy) {
      updatesBusy = true;
      render();
      try {
        await updatesBridge.updateHub();
      } finally {
        updatesBusy = false;
        hubStep = "";
        await loadUpdates();
      }
      return;
    }
    if (target.closest("#updatesReinstallBtn") && updatesBridge && !updatesBusy) {
      updatesBusy = true;
      render();
      try {
        await updatesBridge.reinstallHub();
      } finally {
        updatesBusy = false;
        hubStep = "";
        await loadUpdates();
      }
      return;
    }
    if (target.closest("#updatesInstallBtn") && updatesBridge && !updatesBusy) {
      updatesBusy = true;
      render();
      showSnackbar("Downloading the update from GitHub…");
      try {
        await updatesBridge.install();
      } finally {
        updatesBusy = false;
        render();
      }
      return;
    }
    if (target.closest("#updatesCheckBtn") && updatesBridge && !updatesBusy) {
      updatesBusy = true;
      render();
      try {
        updates = await updatesBridge.check();
        if (updates.state === "rate-limited") {
          showSnackbar("GitHub is limiting requests from this network. Try again later.", true);
        } else if (updates.state === "error") {
          showSnackbar(updates.error || "Couldn't check for updates.", true);
        } else if (!updates.app) {
          showSnackbar("Melodious is up to date.");
        }
      } catch (err) {
        showSnackbar(err?.message || "Couldn't check for updates.", true);
      } finally {
        updatesBusy = false;
        render();
      }
      return;
    }
    if (target.closest("#updatesToggleBtn") && updatesBridge && updates) {
      await updatesBridge.setEnabled(!updates.checks);
      await loadUpdates();
      return;
    }
    if (target.closest("#toggleSignInBtn")) {
      syncInputsFromDom();
      showSignIn = true;
      render();
      document.getElementById("connectUsername")?.focus();
      return;
    }
    if (target.closest("#scanHubsBtn")) {
      syncInputsFromDom();
      runDiscovery();
      return;
    }
    if (target.closest("#retrySavedHubBtn") && state.hub) {
      await doConnect(state.hub.host, state.hub.port, formUser, formPass);
      return;
    }
    const row = target.closest("[data-discover-idx]");
    if (row) {
      syncInputsFromDom();
      const idx = Number(row.dataset.discoverIdx);
      const picked = discovered[idx];
      if (!picked) return;
      formHost = picked.host;
      formPort = String(picked.port || picked.webUiPort || 8080);
      if (picked.authRequired && !showSignIn) {
        showSignIn = true;
        statusError = false;
        statusMsg = `Enter the username and password for ${picked.host}.`;
        render();
        document.getElementById("connectUsername")?.focus();
        return;
      }
      await doConnect(formHost, formPort, formUser, formPass);
      return;
    }
    if (target.closest("#forgetHubBtn")) {
      await bridge.forgetHub();
      state = await bridge.getState();
      formHost = "";
      formPort = "8080";
      formUser = "";
      formPass = "";
      showSignIn = false;
      statusMsg = "";
      render();
      return;
    }
    if (target.closest("#clearHubAuthBtn")) {
      await bridge.clearHubAuth();
      state = await bridge.getState();
      formPass = "";
      showSnackbar("Removed saved hub sign-in.");
      render();
      return;
    }
    if (target.closest("#settingsLogitechSignOutBtn") && catalogBridge) {
      try {
        await catalogBridge.signOut();
        state = await bridge.getState();
        showSnackbar("Signed out of Logitech.");
        render();
      } catch (err) {
        showSnackbar(err?.message || "Sign-out failed.", true);
      }
      return;
    }
    if (target.closest("#settingsLogitechSignInBtn") && catalogBridge) {
      try {
        const res = await catalogBridge.signIn();
        state = await bridge.getState();
        if (res && res.signedIn) {
          showSnackbar("Signed in to Logitech.");
        }
        render();
      } catch (err) {
        showSnackbar(err?.message || "Sign-in failed.", true);
      }
    }
  });

  root.addEventListener("submit", async (event) => {
    event.preventDefault();
    syncInputsFromDom();
    const form = event.target;
    if (form.id === "connectForm") {
      await doConnect(formHost, formPort, formUser, formPass);
      return;
    }
    if (form.id === "hubAuthForm") {
      const u = document.getElementById("settingsAuthUser")?.value?.trim() || "";
      const p = document.getElementById("settingsAuthPass")?.value || "";
      if (!u || !p) {
        showSnackbar("Enter both a username and a password.", true);
        return;
      }
      const res = await bridge.saveHubAuth({ username: u, password: p });
      state = await bridge.getState();
      formUser = u;
      render();
      if (res && res.stored) {
        showSnackbar("Saved hub sign-in to Keychain.");
      } else {
        showSnackbar("Keychain encryption is unavailable; nothing was stored.", true);
      }
      return;
    }
    if (form.id === "clientIdForm") {
      const cid = document.getElementById("clientIdInput")?.value?.trim() || "";
      const res = await bridge.saveClientId({ clientId: cid });
      if (res && res.ok) {
        state = await bridge.getState();
        formClientId = state.clientId || "";
        showSnackbar(
          formClientId
            ? "Saved custom OAuth client_id."
            : "Reset to built-in OAuth client_id."
        );
        render();
      } else {
        showSnackbar(res?.error || "Invalid client_id.", true);
      }
    }
  });

  backBtn?.addEventListener("click", async () => {
    if (wiz.open) {
      syncInputsFromDom();
      if (wiz.troubleshootingOpen) {
        wiz.troubleshootingOpen = false;
        wiz.error = "";
        render();
        return;
      }
      if (wiz.subScreen) {
        wiz.subScreen = null;
        wiz.error = "";
        render();
        return;
      }
      wiz.open = false;
      wiz.error = "";
      if (wiz.returnMode === "settings") {
        await bridge.openSettings();
        state.mode = "settings";
      } else if (wiz.returnMode === "shell" && state.hub) {
        await bridge.openShell();
        window.location.hash = "#remote";
        window.location.reload();
        return;
      } else {
        connectExistingChosen = true;
        await bridge.openConnect();
        state.mode = "connect";
      }
      render();
      return;
    }
    if (!state.hub) return;
    await bridge.openShell();
    window.location.hash = "#remote";
    window.location.reload();
  });

  updatesBridge?.onHubStep?.((text) => {
    hubStep = text;
    render();
  });

  wizardBridge?.onEvent?.((evt) => {
    if (!evt || typeof evt !== "object") return;
    let shouldRender = Boolean(wiz.open && (wiz.troubleshootingOpen || wiz.showTechDetails));
    if (evt.type === "step" && evt.message) {
      wiz.stepText = String(evt.message);
      pushWizLog(`== ${evt.message} ==`);
      if (
        wiz.busy &&
        wiz.busyAction === "unified-install" &&
        wiz.installChecklistStep === 3 &&
        (evt.step === "probe-8080" ||
          evt.phase === "Restarting the hub" ||
          /Restarting the hub|Waiting for Melodious/i.test(String(evt.message)))
      ) {
        wiz.installChecklistStep = 4;
        shouldRender = Boolean(wiz.open);
      }
    } else if (evt.type === "progress" && evt.message) {
      pushWizLog(String(evt.message));
    } else if (evt.type === "error" && evt.message) {
      wiz.stepText = `Error: ${evt.message}`;
      pushWizLog(`ERROR: ${evt.message}`);
    }
    if (shouldRender) render();
  });

  async function init() {
    state = await bridge.getState();
    formHost = state.hub?.host || "";
    formPort = String(state.hub?.port || 8080);
    formUser = state.hubUsername || "";
    formClientId = state.clientId || "";
    showSignIn = Boolean(state.hasHubAuth);
    if (state.wizardDevAvailable && wizardBridge && wizardFlow) {
      if (state.mode === "wizard") {
        wiz.open = true;
        wiz.step = 1;
        wiz.subScreen = null;
        wiz.troubleshootingOpen = false;
        wiz.returnMode = state.hub ? "shell" : "connect";
      } else if (
        state.mode === "connect" &&
        !state.hub &&
        !state.unreachableError &&
        !connectExistingChosen
      ) {
        wiz.open = true;
        wiz.step = 1;
        wiz.subScreen = null;
        wiz.troubleshootingOpen = false;
        wiz.returnMode = "connect";
      }
    }
    render();
    if (state.mode === "settings") loadUpdates();
    runDiscovery();
  }

  init();
})();
