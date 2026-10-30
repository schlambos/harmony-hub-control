"use strict";

const { contextBridge, ipcRenderer } = require("electron");

async function invokeCatalog(channel, args) {
  try {
    return await (args === undefined
      ? ipcRenderer.invoke(channel)
      : ipcRenderer.invoke(channel, args));
  } catch (err) {
    const raw = String(err?.message || err || "Catalog request failed");
    const clean = raw
      .replace(
        /^Error invoking remote method '[^']+':\s*(?:[A-Za-z0-9_]*Error:\s*)?/,
        ""
      )
      .trim();
    throw new Error(clean || "Catalog request failed");
  }
}

contextBridge.exposeInMainWorld("melodiousDesktop", {
  version: 1,
  hub: {
    getState: () => ipcRenderer.invoke("desktop:get-state"),
    discover: () => ipcRenderer.invoke("desktop:discover-hubs"),
    connect: (args) => ipcRenderer.invoke("desktop:connect-hub", args),
    saveHubAuth: (args) => ipcRenderer.invoke("desktop:save-hub-auth", args),
    clearHubAuth: () => ipcRenderer.invoke("desktop:clear-hub-auth"),
    forgetHub: () => ipcRenderer.invoke("desktop:forget-hub"),
    saveClientId: (args) => ipcRenderer.invoke("desktop:save-client-id", args),
    openShell: () => ipcRenderer.invoke("desktop:open-shell"),
    openConnect: () => ipcRenderer.invoke("desktop:open-connect"),
    openSettings: () => ipcRenderer.invoke("desktop:open-settings"),
  },
  updates: {
    get: () => ipcRenderer.invoke("desktop:updates-get"),
    setEnabled: (enabled) => ipcRenderer.invoke("desktop:updates-set-enabled", { enabled }),
    check: () => ipcRenderer.invoke("desktop:updates-check"),
    install: () => ipcRenderer.invoke("desktop:updates-install"),
    updateHub: () => ipcRenderer.invoke("desktop:updates-update-hub"),
    onHubStep: (callback) => {
      if (typeof callback !== "function") return;
      ipcRenderer.on("desktop:hub-update-step", (_event, info) => callback(String(info?.text ?? "")));
    },
    openRelease: (url) => ipcRenderer.invoke("desktop:updates-open-release", { url }),
  },
  catalog: {
    status: () => invokeCatalog("catalog:status"),
    signIn: () => invokeCatalog("catalog:sign-in"),
    signOut: () => invokeCatalog("catalog:sign-out"),
    checkModel: (args) => invokeCatalog("catalog:check-model", args),
    search: (args) => invokeCatalog("catalog:search", args),
    download: (args) => invokeCatalog("catalog:download", args),
  },
});

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );
}

function openHubSignInSheet({ host = "", port = 8080 } = {}) {
  if (!document.body) return;
  if (document.getElementById("connectRoot")) return;
  if (document.getElementById("hubSignInSheet")) return;

  const dialog = document.createElement("dialog");
  dialog.className = "sheet";
  dialog.id = "hubSignInSheet";
  dialog.setAttribute("aria-label", "Sign in to the hub");
  const targetLabel = host ? `${host}${Number(port) && Number(port) !== 8080 ? `:${port}` : ""}` : "your hub";

  dialog.innerHTML = `
    <div class="sheet-body">
      <div class="sheet-handle" aria-hidden="true"></div>
      <div class="sheet-content">
        <form id="hubSignInForm" class="m-form" novalidate>
          <h2 class="sheet-title">Sign in to the hub</h2>
          <p class="sheet-text">Enter the username and password for ${escapeHtml(targetLabel)}.</p>
          <div class="m-form-fields">
            <div class="m-field">
              <label for="hubSignInUser">Username</label>
              <input id="hubSignInUser" name="username" type="text" autocomplete="off" spellcheck="false" required>
            </div>
            <div class="m-field">
              <label for="hubSignInPass">Password</label>
              <input id="hubSignInPass" name="password" type="password" autocomplete="off" required>
            </div>
          </div>
          <p class="form-msg" id="hubSignInError" role="alert" hidden></p>
          <div style="display:flex;justify-content:flex-end;gap:var(--space-2);margin-top:var(--space-2)">
            <button type="button" class="btn btn-text" id="hubSignInCancel">Cancel</button>
            <button type="submit" class="btn btn-filled" id="hubSignInSubmit">Sign in</button>
          </div>
        </form>
      </div>
    </div>
  `;

  const close = () => {
    if (dialog.open) dialog.close();
  };

  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) close();
  });
  dialog.addEventListener("close", () => {
    dialog.remove();
  });

  dialog.querySelector("#hubSignInCancel")?.addEventListener("click", close);

  dialog.querySelector("#hubSignInForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const username = dialog.querySelector("#hubSignInUser")?.value?.trim() || "";
    const password = dialog.querySelector("#hubSignInPass")?.value || "";
    const errEl = dialog.querySelector("#hubSignInError");
    const submitBtn = dialog.querySelector("#hubSignInSubmit");
    if (!username || !password) {
      if (errEl) {
        errEl.textContent = "Enter both a username and a password.";
        errEl.hidden = false;
      }
      return;
    }
    if (submitBtn) submitBtn.disabled = true;
    try {
      const res = await ipcRenderer.invoke("desktop:save-hub-auth", {
        username,
        password,
      });
      if (!res || !res.ok) {
        if (errEl) {
          errEl.textContent = res?.error || "Could not save hub sign-in.";
          errEl.hidden = false;
        }
        if (submitBtn) submitBtn.disabled = false;
        return;
      }
      close();
      window.location.reload();
    } catch (err) {
      if (errEl) {
        errEl.textContent = err?.message || "Could not save hub sign-in.";
        errEl.hidden = false;
      }
      if (submitBtn) submitBtn.disabled = false;
    }
  });

  document.body.appendChild(dialog);
  dialog.showModal();
  dialog.querySelector("#hubSignInUser")?.focus();
}

function offerConnectScreen({ host = "", port = 8080 } = {}) {
  if (!document.body) return;
  if (document.getElementById("connectRoot")) return;
  if (document.getElementById("openConnectScreenBtn")) return;

  const target = host ? `${host}:${port}` : "your hub";
  const bar = document.createElement("div");
  bar.className = "banner";
  bar.id = "desktopUnreachableBar";
  bar.style.cssText =
    "display:flex;align-items:center;justify-content:space-between;gap:12px;padding:8px 16px;background:var(--power-container);color:var(--on-power-container);font-size:var(--fs-label)";
  bar.innerHTML = `
    <span>Can't reach ${escapeHtml(target)}</span>
    <button type="button" class="btn btn-tonal btn-sm" id="openConnectScreenBtn">Connect screen…</button>
  `;
  bar.querySelector("#openConnectScreenBtn")?.addEventListener("click", async () => {
    await ipcRenderer.invoke("desktop:open-connect");
    window.location.reload();
  });
  const mainEl = document.getElementById("main");
  if (mainEl && mainEl.parentNode) {
    mainEl.parentNode.insertBefore(bar, mainEl);
  } else {
    document.body.prepend(bar);
  }
}

ipcRenderer.on("desktop:hub-auth-required", (_event, info) => {
  if (document.readyState === "loading") {
    window.addEventListener(
      "DOMContentLoaded",
      () => openHubSignInSheet(info),
      { once: true }
    );
  } else {
    openHubSignInSheet(info);
  }
});

ipcRenderer.on("desktop:hub-unreachable", (_event, info) => {
  if (document.readyState === "loading") {
    window.addEventListener(
      "DOMContentLoaded",
      () => offerConnectScreen(info),
      { once: true }
    );
  } else {
    offerConnectScreen(info);
  }
});
