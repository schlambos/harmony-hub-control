"use strict";

const crypto = require("node:crypto");
const os = require("node:os");
const path = require("node:path");
const {
  app,
  BrowserWindow,
  Menu,
  dialog,
  ipcMain,
  protocol,
  safeStorage,
  session,
  shell,
} = require("electron");
const {
  DEFAULT_CLIENT_ID,
  basicAuthHeader,
  createSettingsStore,
  normalizeHost,
  normalizePort,
} = require("./settings");
const { discoverHubs, probeHub } = require("./discovery");
const { createSchemeHandler } = require("./scheme");
const {
  attachSessionSecurity,
  attachWindowSecurity,
  isTrustedIpcSender,
} = require("./security");
const { createCatalogService } = require("./catalog/client");
const { runSignInWindow } = require("./catalog/signin-window");
const { registerCatalogIpcHandlers } = require("./ipc");
const {
  createUpdateChecker,
  createUpdateStore,
  fetchHubVersion,
  isGitHubUrl,
} = require("./updates");
const {
  bundlePathFromExec,
  cleanupStages,
  installLocationProblem,
  prepareUpdate,
  swapInto,
} = require("./self-update");
const { findHubKey, updateHub } = require("./hub-update");

// Test hooks (stand-in safeStorage, stub catalog) exist only when running from
// source; a packaged app ignores MELODIOUS_E2E.
const E2E = process.env.MELODIOUS_E2E === "1" && !app.isPackaged;
// Test runs (packaged ones too) never ask about update checks or call GitHub.
const UPDATE_PROMPTS = process.env.MELODIOUS_E2E !== "1";
const UPDATE_SCHEDULE_MS = 60 * 60 * 1000;

if (process.env.MELODIOUS_USER_DATA_DIR) {
  app.setPath("userData", process.env.MELODIOUS_USER_DATA_DIR);
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: "melodious",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);

function createE2eSafeStorage() {
  const key = crypto
    .createHash("sha256")
    .update("melodious-e2e-safe-storage-key")
    .digest();
  return {
    isEncryptionAvailable() {
      return process.env.MELODIOUS_E2E_NO_SAFESTORAGE !== "1";
    },
    encryptString(plainText) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
      const enc = Buffer.concat([
        cipher.update(String(plainText), "utf8"),
        cipher.final(),
      ]);
      const tag = cipher.getAuthTag();
      return Buffer.concat([iv, tag, enc]);
    },
    decryptString(buffer) {
      const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
      const iv = buf.subarray(0, 12);
      const tag = buf.subarray(12, 28);
      const enc = buf.subarray(28);
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(enc), decipher.final()]).toString(
        "utf8"
      );
    },
  };
}

let mainWindow = null;
let settingsStore = null;
let catalogService = null;
let pageMode = "connect";
let lastUnreachableError = null;
let updateChecker = null;
let updateStore = null;
let installingUpdate = false;
let updatingHub = false;

function getActiveCatalogService() {
  return (E2E && globalThis.__melodiousCatalogService) || catalogService;
}

function openSettingsPage() {
  pageMode = "settings";
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.reloadIgnoringCache();
  }
}

function buildAppMenu() {
  const isMac = process.platform === "darwin";
  const template = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" },
              {
                label: "Check for Updates…",
                click: () => checkForUpdatesNow(),
              },
              { type: "separator" },
              {
                label: "Settings…",
                accelerator: "CmdOrCtrl+,",
                click: () => openSettingsPage(),
              },
              { type: "separator" },
              { role: "services" },
              { type: "separator" },
              { role: "hide" },
              { role: "hideOthers" },
              { role: "unhide" },
              { type: "separator" },
              { role: "quit" },
            ],
          },
        ]
      : []),
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
        { type: "separator" },
        {
          label: "Developer Tools",
          accelerator: isMac ? "Alt+Command+I" : "Ctrl+Shift+I",
          click: () => {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.toggleDevTools();
            }
          },
        },
      ],
    },
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        ...(isMac ? [{ type: "separator" }, { role: "front" }] : [{ role: "close" }]),
      ],
    },
  ];
  return Menu.buildFromTemplate(template);
}

/* ---- update notices ------------------------------------------------- */

function openReleasePage(url) {
  if (!isGitHubUrl(url)) return false;
  shell.openExternal(url);
  return true;
}

function updateDialogParent() {
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
}

async function showMessage(options) {
  const parent = updateDialogParent();
  return parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options);
}

async function askAboutUpdateChecks() {
  const { response } = await showMessage({
    type: "question",
    message: "Check for updates?",
    detail:
      "Melodious can ask GitHub once a day whether a newer version is out. " +
      "GitHub sees your IP address and this app's version; nothing about your hub or devices is sent. " +
      "Nothing downloads unless you choose to. You can change this in Settings.",
    buttons: ["Check daily", "Not now"],
    defaultId: 0,
    cancelId: 1,
  });
  updateChecker.setEnabled(response === 0);
}

/** Tell the user about a check. Scheduled checks speak only about versions
    they haven't dismissed; a manual check always answers. */
async function announceUpdate(result, { manual }) {
  const hubLine = result.hubNote ? `\n\n${result.hubNote}` : "";
  if (result.app && (manual || result.app.version !== result.dismissed)) {
    const { response } = await showMessage({
      type: "info",
      message: `Melodious ${result.app.version} is available`,
      detail:
        `You have ${result.appVersion}. Install and Restart downloads it from GitHub, checks it, ` +
        `replaces this app and opens the new version.${hubLine}`,
      buttons: ["Install and Restart", "Release Page", "Later"],
      defaultId: 0,
      cancelId: 2,
    });
    if (response === 0) await installAppUpdate(result.app);
    else if (response === 1) openReleasePage(result.app.url);
    else updateChecker.dismiss(result.app.version);
    return;
  }
  const hubVersion = result.latestHub?.version || "";
  if (result.hubNote && (manual || updateStore.read().dismissedHub !== hubVersion)) {
    const { response } = await showMessage({
      type: "info",
      message: `Hub software ${hubVersion} is available`,
      detail: `${result.hubNote} Melodious can update the hub for you over SSH, the way the installer does.`,
      buttons: ["Update Hub…", "Release Page", "Later"],
      defaultId: 0,
      cancelId: 2,
    });
    if (response === 0) await updateHubFlow(result.latestHub);
    else if (response === 1) openReleasePage(result.latestHub.url);
    else updateStore.write({ dismissedHub: hubVersion });
    return;
  }
  if (!manual) return;
  if (result.state === "rate-limited") {
    const when = new Date(result.until).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    await showMessage({ type: "warning", message: "Couldn't check for updates", detail: `GitHub is limiting requests from this network. Try again after ${when}.` });
  } else if (result.state === "error") {
    await showMessage({ type: "warning", message: "Couldn't check for updates", detail: result.error });
  } else {
    await showMessage({ type: "info", message: "Melodious is up to date", detail: `You have ${result.appVersion}, the newest version.` });
  }
}

function setDockProgress(value) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setProgressBar(value);
}

/** Replace this app with `release` from GitHub and relaunch; on any failure the app is unchanged. */
async function installAppUpdate(release) {
  if (installingUpdate || !release) return { ok: false };
  const appPath = bundlePathFromExec(process.execPath);
  const problem = installLocationProblem(appPath, { packaged: app.isPackaged });
  if (problem) {
    const { response } = await showMessage({
      type: "warning",
      message: "Melodious can't update itself here",
      detail: problem,
      buttons: ["Open Release Page", "OK"],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) openReleasePage(release.url);
    return { ok: false, error: problem };
  }
  installingUpdate = true;
  setDockProgress(2); // indeterminate until the size is known
  try {
    const { stageDir, newApp } = await prepareUpdate({
      release,
      arch: process.arch,
      appPath,
      userAgent: `Melodious/${app.getVersion()} (macOS)`,
      onProgress: (done, total) => {
        if (total > 0) setDockProgress(done / total);
      },
    });
    swapInto({ appPath, newApp, stageDir });
    app.relaunch();
    app.exit(0);
    return { ok: true };
  } catch (err) {
    setDockProgress(-1);
    await showMessage({
      type: "warning",
      message: "The update didn't install",
      detail: `${err?.message || err} Melodious is unchanged.`,
    });
    return { ok: false, error: err?.message || String(err) };
  } finally {
    installingUpdate = false;
  }
}

function sendHubStep(text) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("desktop:hub-update-step", { text });
}

/** Update the hub over SSH with the installer's key; explains every outcome in a dialog. */
async function updateHubFlow(release) {
  if (updatingHub || !release) return { ok: false };
  const hub = settingsStore.getHub();
  if (!hub) return { ok: false, error: "No hub is set up in this app." };
  const keyPath = findHubKey();
  if (!keyPath) {
    await showMessage({
      type: "warning",
      message: "Melodious needs your hub's SSH key",
      detail:
        "Updating the hub uses the same SSH key as the installer: ~/.ssh/harmony_owner_…, created when the hub was rooted. " +
        "Put it in ~/.ssh on this Mac, or run the installer from the release page instead.",
    });
    return { ok: false, error: "no key" };
  }
  const { response } = await showMessage({
    type: "question",
    message: `Update the hub to Melodious ${release.version}?`,
    detail:
      `Melodious downloads the hub software from GitHub, checks it, and installs it on ${hub.host} over SSH with ` +
      `${keyPath.replace(os.homedir(), "~")}, the way the installer does. Remotes and activities ` +
      "pause for about a minute while the hub restarts. If anything goes wrong, the hub keeps its current software. " +
      "Keep the hub plugged in.",
    buttons: ["Update Hub", "Cancel"],
    defaultId: 0,
    cancelId: 1,
  });
  if (response !== 0) return { ok: false, cancelled: true };
  updatingHub = true;
  setDockProgress(2);
  try {
    const result = await updateHub({
      release,
      host: hub.host,
      httpPort: hub.port,
      authHeader: settingsStore.getHubAuthHeader(),
      keyPath,
      userAgent: `Melodious/${app.getVersion()} (macOS)`,
      onStep: sendHubStep,
    });
    sendHubStep("");
    await showMessage({
      type: result.ok ? "info" : "warning",
      message: result.ok ? (result.alreadyCurrent ? "The hub is up to date" : "The hub was updated") : "Check the hub",
      detail: result.message,
    });
    return result;
  } catch (err) {
    sendHubStep("");
    await showMessage({ type: "warning", message: "The hub wasn't updated", detail: err?.message || String(err) });
    return { ok: false, error: err?.message || String(err) };
  } finally {
    updatingHub = false;
    setDockProgress(-1);
  }
}

async function checkForUpdatesNow() {
  const result = await updateChecker.check();
  await announceUpdate(result, { manual: true });
  return result;
}

async function runScheduledUpdateCheck() {
  if (!updateChecker.isDue()) return;
  const result = await updateChecker.check();
  await announceUpdate(result, { manual: false });
}

function startUpdateSchedule() {
  if (!UPDATE_PROMPTS) return;
  setTimeout(async () => {
    try {
      if (updateStore.read().checks === null) await askAboutUpdateChecks();
      await runScheduledUpdateCheck();
    } catch (err) {
      console.error("update check failed:", err?.message || err);
    }
  }, 4000);
  setInterval(() => {
    runScheduledUpdateCheck().catch((err) => console.error("update check failed:", err?.message || err));
  }, UPDATE_SCHEDULE_MS);
}

function registerIpcHandlers() {
  const checkSender = (event) => {
    if (!isTrustedIpcSender(event, mainWindow)) {
      throw new Error("Untrusted IPC sender");
    }
  };

  ipcMain.handle("desktop:get-state", async (event) => {
    checkSender(event);
    const hub = settingsStore.getHub();
    const hubAuth = settingsStore.getHubAuth();
    const settings = settingsStore.getSettings();
    const catSvc = getActiveCatalogService();
    const catStatus = catSvc ? await catSvc.status() : { signedIn: false };
    return {
      mode: pageMode,
      hub,
      hasHubAuth: Boolean(hubAuth?.header),
      hubUsername: hubAuth?.username || "",
      logitechSignedIn: Boolean(catStatus?.signedIn),
      encryptionAvailable: settingsStore.isEncryptionAvailable(),
      clientId: settings.clientId,
      defaultClientId: DEFAULT_CLIENT_ID,
      unreachableError: lastUnreachableError,
    };
  });

  ipcMain.handle("desktop:discover-hubs", async (event) => {
    checkSender(event);
    return discoverHubs({
      authHeader: settingsStore.getHubAuthHeader(),
    });
  });

  ipcMain.handle("desktop:connect-hub", async (event, args = {}) => {
    checkSender(event);
    let host;
    let port;
    try {
      host = normalizeHost(args.host);
      port = normalizePort(args.port);
    } catch (err) {
      return {
        ok: false,
        authRequired: false,
        error: err?.message || "Invalid hub address.",
      };
    }
    if (!host) {
      return {
        ok: false,
        authRequired: false,
        error: "Enter your hub's IP address or hostname.",
      };
    }

    const username = String(args.username ?? "").trim();
    const password = String(args.password ?? "");
    let authHeader = null;
    if (username || password) {
      try {
        authHeader = basicAuthHeader(username, password);
      } catch (err) {
        return {
          ok: false,
          authRequired: true,
          error: err?.message || "Invalid username or password.",
        };
      }
    } else {
      const currentHub = settingsStore.getHub();
      if (currentHub && currentHub.host === host && currentHub.port === port) {
        authHeader = settingsStore.getHubAuthHeader();
      }
    }

    const probed = await probeHub({ host, port, authHeader });
    if (!probed) {
      return {
        ok: false,
        authRequired: false,
        error: `Can't reach a Melodious hub at ${host}:${port}.`,
      };
    }
    if (probed.authRequired) {
      return {
        ok: false,
        authRequired: true,
        host,
        port,
        error:
          username || password
            ? "The hub rejected that username or password."
            : "This hub requires a username and password.",
      };
    }

    settingsStore.setHub({ host, port });
    if (username && password) {
      settingsStore.setHubAuth({ username, password });
    }
    lastUnreachableError = null;
    pageMode = "shell";
    return {
      ok: true,
      connected: true,
      hub: { host, port },
      firmware: probed.firmware,
    };
  });

  ipcMain.handle("desktop:save-hub-auth", (event, args = {}) => {
    checkSender(event);
    try {
      const res = settingsStore.setHubAuth({
        username: args.username,
        password: args.password,
      });
      return { ok: true, stored: res.stored };
    } catch (err) {
      return { ok: false, error: err?.message || "Invalid username or password." };
    }
  });

  ipcMain.handle("desktop:clear-hub-auth", (event) => {
    checkSender(event);
    settingsStore.clearHubAuth();
    return { ok: true };
  });

  ipcMain.handle("desktop:forget-hub", (event) => {
    checkSender(event);
    settingsStore.clearHub();
    lastUnreachableError = null;
    pageMode = "connect";
    return { ok: true };
  });

  ipcMain.handle("desktop:save-client-id", async (event, args = {}) => {
    checkSender(event);
    try {
      const before = settingsStore.getSettings().effectiveClientId;
      const clientId = settingsStore.setClientId(args.clientId);
      if (before !== settingsStore.getSettings().effectiveClientId) await getActiveCatalogService().signOut();
      return { ok: true, clientId };
    } catch (err) {
      return { ok: false, error: err?.message || "Invalid client_id." };
    }
  });

  ipcMain.handle("desktop:open-shell", (event) => {
    checkSender(event);
    if (settingsStore.getHub()) {
      pageMode = "shell";
    }
    return { ok: true, mode: pageMode };
  });

  ipcMain.handle("desktop:open-connect", (event) => {
    checkSender(event);
    pageMode = "connect";
    return { ok: true, mode: pageMode };
  });

  ipcMain.handle("desktop:open-settings", (event) => {
    checkSender(event);
    pageMode = "settings";
    return { ok: true, mode: pageMode };
  });

  ipcMain.handle("desktop:updates-get", async (event) => {
    checkSender(event);
    return updateChecker.status();
  });

  ipcMain.handle("desktop:updates-set-enabled", (event, args = {}) => {
    checkSender(event);
    updateChecker.setEnabled(Boolean(args.enabled));
    return { ok: true };
  });

  ipcMain.handle("desktop:updates-check", async (event) => {
    checkSender(event);
    return updateChecker.check();
  });

  ipcMain.handle("desktop:updates-install", async (event) => {
    checkSender(event);
    const status = await updateChecker.status();
    return installAppUpdate(status.app);
  });

  ipcMain.handle("desktop:updates-update-hub", async (event) => {
    checkSender(event);
    const status = await updateChecker.status();
    return updateHubFlow(status.latestHub);
  });

  ipcMain.handle("desktop:updates-open-release", (event, args = {}) => {
    checkSender(event);
    return { ok: openReleasePage(args.url) };
  });

  registerCatalogIpcHandlers({
    ipcMain,
    getMainWindow: () => mainWindow,
    getCatalogService: () => getActiveCatalogService(),
  });
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 360,
    minHeight: 560,
    backgroundColor: "#0e1014",
    title: "Melodious",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  attachWindowSecurity({
    win: mainWindow,
    openExternal: (url) =>
      E2E && typeof globalThis.__melodiousOpenExternal === "function"
        ? globalThis.__melodiousOpenExternal(url)
        : shell.openExternal(url),
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  mainWindow.loadURL("melodious://app/");
  return mainWindow;
}

app.whenReady().then(() => {
  app.name = "Melodious";
  const storageBackend = E2E ? createE2eSafeStorage() : safeStorage;

  settingsStore = createSettingsStore({
    dir: app.getPath("userData"),
    safeStorage: storageBackend,
  });

  catalogService = createCatalogService({
    settingsStore,
    openSignInWindow: ({ client, clientId }) =>
      runSignInWindow({
        client,
        clientId,
        parentWindow: mainWindow,
      }),
  });

  // A relaunch after an update leaves the previous version next to the app.
  if (app.isPackaged) cleanupStages(bundlePathFromExec(process.execPath));
  updateStore = createUpdateStore({ dir: app.getPath("userData") });
  updateChecker = createUpdateChecker({
    store: updateStore,
    appVersion: app.getVersion(),
    arch: process.arch,
    getHubVersion: () => {
      const hub = settingsStore.getHub();
      return hub
        ? fetchHubVersion({ host: hub.host, port: hub.port, authHeader: settingsStore.getHubAuthHeader() })
        : Promise.resolve(null);
    },
  });

  if (process.env.MELODIOUS_INITIAL_HOST) {
    settingsStore.setHub({
      host: process.env.MELODIOUS_INITIAL_HOST,
      port: Number(process.env.MELODIOUS_INITIAL_PORT || 8080),
    });
  }

  pageMode = settingsStore.getHub() ? "shell" : "connect";

  const shellDir = path.join(__dirname, "..", "build", "shell");
  const connectDir = path.join(__dirname, "connect");

  const schemeHandler = createSchemeHandler({
    shellDir,
    connectDir,
    getHub: () => settingsStore.getHub(),
    getSavedAuthHeader: () => settingsStore.getHubAuthHeader(),
    getPageMode: () => pageMode,
    onHubAuthRequired: (info) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("desktop:hub-auth-required", info);
      }
    },
    onHubUnreachable: (info) => {
      lastUnreachableError = "Can't reach the hub";
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("desktop:hub-unreachable", info);
      }
    },
  });

  protocol.handle("melodious", (req) => schemeHandler.handle(req));

  attachSessionSecurity({
    ses: session.defaultSession,
    getMainWindow: () => mainWindow,
    showSaveDialog: (win, opts) =>
      E2E && typeof globalThis.__melodiousShowSaveDialog === "function"
        ? globalThis.__melodiousShowSaveDialog(win, opts)
        : dialog.showSaveDialogSync(win, opts),
  });

  registerIpcHandlers();
  Menu.setApplicationMenu(buildAppMenu());
  createMainWindow();
  startUpdateSchedule();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin" || E2E) {
    app.quit();
  }
});
