import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

/* Checks the built Windows app in dist/win-unpacked (run `npm run dist:win`
   first): its contents, then launches it against the webui-sim. It never
   signs in to Logitech and never contacts a real hub. */

const require = createRequire(import.meta.url);
const { _electron: electron } = require("playwright");
const asar = require("@electron/asar");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP_DIR = path.resolve(__dirname, "../..");
const REPO_ROOT = path.resolve(DESKTOP_DIR, "..");
const SHELL_DIR = path.join(DESKTOP_DIR, "build", "shell");
const APP_DIR = path.join(DESKTOP_DIR, "dist", "win-unpacked");
const EXE = path.join(APP_DIR, "Melodious.exe");
const SIM_PORT = Number(process.env.SIM_PORT || 8798);
const SHELL_FILES = ["index.html", "harmony-shell.js", "harmony-shell.css", "activity-ui.js", "activity-ui.css"];

async function waitForHttp(url, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

const skip = process.platform !== "win32" ? "Windows only" : !fs.existsSync(EXE) ? `${EXE} not built (npm run dist:win)` : false;

test("packaged Melodious for Windows: contents, launch against webui-sim, catalog bridge", { timeout: 120_000, skip }, async () => {
  const resources = path.join(APP_DIR, "resources");
  for (const file of [
    "wizard-python/python.exe", "wizard-python/python312.zip", "wizard-python/LICENSE.txt",
    "hub-root/wizard_bridge.py", "hub-root/dropbearmulti", "installer/install_webui.py",
    "installer/payload/helpers/codex_flash_free", "installer/payload/helpers/hal_multiremote_patch.json",
    "installer/payload/helpers/hal_remotes_patch.json",
  ]) assert.ok(fs.existsSync(path.join(resources, file)), `bundled ${file}`);
  for (const file of ["hub-root/.venv", "hub-root/tests", "hub-root/.github", "hub-root/__pycache__", "hub-root/harmony_hub_id.json"]) {
    assert.equal(fs.existsSync(path.join(resources, file)), false, `excluded ${file}`);
  }
  const cleanEnv = { ...process.env };
  for (const key of Object.keys(cleanEnv)) {
    if (/^path$/i.test(key)) cleanEnv[key] = path.win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "OpenSSH");
    if (/^(PYTHON|VIRTUAL_ENV|MELODIOUS_WIZARD_PYTHON)/i.test(key)) delete cleanEnv[key];
  }
  const python = path.join(resources, "wizard-python/python.exe");
  execFileSync(python, ["-B", path.join(resources, "installer/install_webui.py"), "--help"], { env: cleanEnv });
  assert.equal(fs.existsSync(path.join(resources, "app-update.yml")), false, "no auto-update config");
  const archive = path.join(resources, "app.asar");
  const files = asar.listPackage(archive).map((f) => f.split(path.sep).join("/").replace(/^\//, ""));
  assert.ok(files.includes("src/hub-update/hub_update.sh"));
  assert.ok(!asar.extractFile(archive, path.join("src", "hub-update", "hub_update.sh")).includes("\r\n"), "the hub's script keeps LF line endings");
  for (const f of SHELL_FILES) {
    const packed = asar.extractFile(archive, path.join("build", "shell", f));
    assert.ok(packed.equals(fs.readFileSync(path.join(SHELL_DIR, f))), `${f} matches build/shell`);
  }

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "melodious-dist-userdata-"));
  const simProc = spawn(process.execPath, [path.join(REPO_ROOT, "tools/webui-sim/server.mjs")], {
    env: { ...process.env, PORT: String(SIM_PORT) },
    stdio: "ignore",
  });
  let electronApp = null;
  try {
    await waitForHttp(`http://127.0.0.1:${SIM_PORT}/api/system-status`);
    electronApp = await electron.launch({
      executablePath: EXE,
      env: {
        ...cleanEnv,
        // A packaged app must ignore the source-only test hooks.
        MELODIOUS_E2E: "1",
        MELODIOUS_USER_DATA_DIR: userDataDir,
        MELODIOUS_INITIAL_HOST: "127.0.0.1",
        MELODIOUS_INITIAL_PORT: String(SIM_PORT),
      },
    });
    assert.equal(await electronApp.evaluate(({ app }) => app.isPackaged), true);
    // Hub and Logitech secrets rest on Windows data protection (DPAPI).
    assert.equal(await electronApp.evaluate(({ safeStorage }) => safeStorage.isEncryptionAvailable()), true);
    const menu = await electronApp.evaluate(({ Menu }) => Menu.getApplicationMenu().items.map((i) => i.label));
    assert.deepEqual(menu, ["File", "Edit", "View", "Window"]);
    assert.equal(await electronApp.evaluate(({ Menu }) =>
      Menu.getApplicationMenu().items[0].submenu.items.some((i) => i.label === "Set Up a New Harmony Hub…")
    ), true);

    const page = await electronApp.firstWindow();
    await page.waitForSelector("#view-remote:not([hidden])", { timeout: 20000 });
    assert.equal(await page.title(), "Remote · Melodious");
    assert.ok(page.url().startsWith("melodious://app/"), page.url());

    const bridge = await page.evaluate(() => ({
      version: window.melodiousDesktop?.version,
      catalog: Object.keys(window.melodiousDesktop?.catalog ?? {}).sort(),
      node: typeof window.require,
    }));
    assert.equal(bridge.version, 1);
    assert.deepEqual(bridge.catalog, ["checkModel", "download", "remoteImage", "search", "signIn", "signOut", "status"]);
    assert.equal(bridge.node, "undefined");
    assert.deepEqual(await page.evaluate(() => window.melodiousDesktop.catalog.status()), { signedIn: false });

    const state = await page.evaluate(() => window.melodiousDesktop.hub.getState());
    assert.equal(state.platform, "win32");
    assert.equal(state.encryptionAvailable, true);
    assert.equal(state.wizardDevAvailable, true);
    // Real packaged IPC + bundled CPython + native ctypes backend, no Python
    // on PATH and no injected test stubs. Enumeration never opens a USB device.
    const probe = await page.evaluate(() => window.melodiousDesktop.wizard.usbProbe({ action: "usb-enumerate", usbBackend: "winhid" }));
    assert.equal(probe.ok, true, JSON.stringify(probe));
    assert.equal(probe.exitCode, 0);
    assert.equal(probe.pythonPath, python);
    assert.equal(probe.usb?.ok, true);
    assert.ok(Array.isArray(probe.usb?.devices));
    assert.ok(probe.events.some((e) => e.step === "usb-enumerate" && e.status === "ok"), JSON.stringify(probe));
    assert.equal(probe.events.some((e) => e.status === "failed" || e.type === "error"), false, JSON.stringify(probe));
    assert.equal(fs.existsSync(path.join(resources, "hub-root/__pycache__")), false);

    // A fresh profile opens Welcome, including in the packaged app. Keep the
    // simulator connected until now; no detection/action is clicked here.
    await page.evaluate(async () => {
      await window.melodiousDesktop.hub.forgetHub();
      await window.melodiousDesktop.hub.openConnect();
      location.reload();
    });
    await page.waitForSelector("#hubSetupWizard", { timeout: 10000 });
    assert.match(await page.textContent("#hubSetupWizard"), /Welcome to Melodious/);
    assert.match(await page.textContent("#hubSetupWizard"), /this computer/);
    assert.doesNotMatch(await page.textContent("#hubSetupWizard"), /\bMac\b/);
    await page.click("#wizardUseExistingConnectBtn");
    await page.waitForSelector("#connectForm");
    await electronApp.evaluate(({ Menu }) => Menu.getApplicationMenu().items[0].submenu.items.find((i) => i.label === "Set Up a New Harmony Hub…").click());
    await page.waitForSelector("#hubSetupWizard");
  } finally {
    if (electronApp) await electronApp.close().catch(() => {});
    simProc.kill();
    fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
