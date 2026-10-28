"use strict";

(() => {
  const bridge = window.melodiousDesktop?.hub;
  const catalogBridge = window.melodiousDesktop?.catalog;
  const updatesBridge = window.melodiousDesktop?.updates;
  const root = document.getElementById("connectRoot");
  const appbar = document.getElementById("connectAppbar");
  const backBtn = document.getElementById("settingsBackBtn");
  const snackHost = document.getElementById("snackbars");

  if (!root || !bridge) return;

  const ROUTER_SVG =
    '<svg class="ic" width="24" height="24" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M16 4.2c1.5 0 3 .6 4.2 1.7l.8-.8C19.6 3.7 17.8 3 16 3s-3.6.7-5 2.1l.8.8C13 4.8 14.5 4.2 16 4.2zm-3.3 2.5.8.8c.7-.7 1.6-1 2.5-1s1.8.3 2.5 1l.8-.8c-.9-.9-2.1-1.4-3.3-1.4s-2.4.5-3.3 1.4zM19 13h-2V9h-2v4H5c-1.1 0-2 .9-2 2v4c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2v-4c0-1.1-.9-2-2-2zM8 18H6v-2h2v2zm3.5 0h-2v-2h2v2zm3.5 0h-2v-2h2v2z"/></svg>';

  let state = {
    mode: "connect",
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
  let updates = null; // desktop:updates-get / -check result
  let updatesBusy = false;

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

  function renderConnectAndAddressSection() {
    return `
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
                ? '<p class="m-field-hint">Keychain encryption is unavailable on this Mac; password will not be stored on disk.</p>'
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

  function renderSettingsSections() {
    const savedHubText = state.hub
      ? `${state.hub.host}:${state.hub.port}`
      : "Not connected";
    const authStatusText = !state.encryptionAvailable
      ? "Keychain encryption unavailable (nothing stored)"
      : state.hasHubAuth
        ? `Saved${state.hubUsername ? ` for ${state.hubUsername}` : ""}`
        : "Not set";

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

      ${renderConnectAndAddressSection()}

      <h3 class="m-section">Hub sign-in</h3>
      <form id="hubAuthForm" class="m-card m-form" novalidate>
        <p class="m-field-hint" style="margin-top:0">
          Used when your hub has HTTP Basic sign-in enabled. Stored encrypted in your macOS Keychain.
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
      const hubSub = u.hubNote || (u.latestHub ? "Up to date" : "");
      hubRow = `
        <div class="m-row">
          <span class="m-row-text">
            <span class="m-row-title" id="updatesHubTitle">${escapeHtml(hubTitle)}</span>
            <span class="m-row-sub">${escapeHtml(hubSub)}</span>
          </span>
          ${
            u.hubNote && u.latestHub
              ? `<button type="button" class="btn btn-tonal btn-sm" data-release-url="${escapeHtml(u.latestHub.url)}">Release page</button>`
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
      </div>
      <p class="m-field-hint">Checks ask GitHub (api.github.com) for Melodious's releases. GitHub sees your IP address and this app's version; nothing about your hub or devices is sent. Nothing downloads unless you open the release page.</p>
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
    const isSettings = state.mode === "settings";
    document.title = `${isSettings ? "Settings" : "Connect"} · Melodious`;
    if (appbar) {
      appbar.hidden = !isSettings;
      if (backBtn) {
        backBtn.hidden = !state.hub;
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
        ? "Make sure this Mac is on the same network as the hub and the hub is powered on."
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
        ${renderConnectAndAddressSection()}
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
  }

  root.addEventListener("input", () => {
    syncInputsFromDom();
  });

  root.addEventListener("click", async (event) => {
    const target = event.target;
    const releaseBtn = target.closest("[data-release-url]");
    if (releaseBtn && updatesBridge) {
      await updatesBridge.openRelease(releaseBtn.dataset.releaseUrl);
      return;
    }
    if (target.closest("#updatesInstallBtn") && updatesBridge && !updatesBusy) {
      updatesBusy = true;
      render();
      showSnackbar("Downloading the update from GitHub…");
      try {
        // On success the app relaunches; on failure the main process explains in a dialog.
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
    if (!state.hub) return;
    await bridge.openShell();
    window.location.hash = "#remote";
    window.location.reload();
  });

  async function init() {
    state = await bridge.getState();
    formHost = state.hub?.host || "";
    formPort = String(state.hub?.port || 8080);
    formUser = state.hubUsername || "";
    formClientId = state.clientId || "";
    showSignIn = Boolean(state.hasHubAuth);
    render();
    if (state.mode === "settings") loadUpdates();
    runDiscovery();
  }

  init();
})();
