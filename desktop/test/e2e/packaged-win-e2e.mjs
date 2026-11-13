import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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
  assert.equal(fs.existsSync(path.join(resources, "app-update.yml")), false, "no auto-update config");
  const archive = path.join(resources, "app.asar");
  const files = asar.listPackage(archive).map((f) => f.split(path.sep).join("/").replace(/^\//, ""));
  assert.ok(files.includes("src/hub-update/hub_update.sh"));
  assert.ok(!asar.extractFile(archive, "src/hub-update/hub_update.sh").includes("\r\n"), "the hub's script keeps LF line endings");
  for (const f of SHELL_FILES) {
    const packed = asar.extractFile(archive, `build/shell/${f}`);
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
        ...process.env,
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
    assert.deepEqual(bridge.catalog, ["checkModel", "download", "search", "signIn", "signOut", "status"]);
    assert.equal(bridge.node, "undefined");
    assert.deepEqual(await page.evaluate(() => window.melodiousDesktop.catalog.status()), { signedIn: false });

    const state = await page.evaluate(() => window.melodiousDesktop.hub.getState());
    assert.equal(state.platform, "win32");
    assert.equal(state.encryptionAvailable, true);
  } finally {
    if (electronApp) await electronApp.close().catch(() => {});
    simProc.kill();
    fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
