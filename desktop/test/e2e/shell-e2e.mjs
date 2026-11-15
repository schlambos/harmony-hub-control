import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { _electron: electron } = require("playwright");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP_DIR = path.resolve(__dirname, "../..");
const REPO_ROOT = path.resolve(DESKTOP_DIR, "..");
const SIM_PORT = Number(process.env.SIM_PORT || 8799);

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForHttp(url, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {}
    await wait(100);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function startProdPreviewServer(simPort) {
  const shellDir = path.join(DESKTOP_DIR, "build", "shell");
  const page = fs.readFileSync(path.join(shellDir, "index.html"), "utf8");
  const files = {
    "/assets/harmony-shell.js": [
      path.join(shellDir, "harmony-shell.js"),
      "application/javascript; charset=utf-8",
    ],
    "/assets/harmony-shell.css": [
      path.join(shellDir, "harmony-shell.css"),
      "text/css; charset=utf-8",
    ],
    "/assets/activity-ui.js": [
      path.join(shellDir, "activity-ui.js"),
      "application/javascript; charset=utf-8",
    ],
    "/assets/activity-ui.css": [
      path.join(shellDir, "activity-ui.css"),
      "text/css; charset=utf-8",
    ],
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (
      req.method === "GET" &&
      (url.pathname === "/" || url.pathname === "/index.html")
    ) {
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(page);
      return;
    }
    const file = files[url.pathname];
    if (req.method === "GET" && file) {
      res.writeHead(200, {
        "Content-Type": file[1],
        "Cache-Control": "no-store",
      });
      res.end(fs.readFileSync(file[0]));
      return;
    }
    const proxied = http.request(
      {
        host: "127.0.0.1",
        port: simPort,
        path: req.url,
        method: req.method,
        headers: req.headers,
      },
      (up) => {
        res.writeHead(up.statusCode, up.headers);
        up.pipe(res);
      }
    );
    proxied.on("error", () => {
      res.writeHead(502);
      res.end();
    });
    req.pipe(proxied);
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        server,
        port: server.address().port,
      });
    });
  });
}

function startAuthProxyServer(simPort) {
  let requireAuth = false;
  const expectedHeader = `Basic ${Buffer.from("owner:hubpass", "utf8").toString("base64")}`;

  const server = http.createServer((req, res) => {
    // Frame bodies like codex_webui: it reads a body only by Content-Length
    // and never parses chunked encoding, so a chunked POST arrives empty.
    if (
      req.method !== "GET" &&
      req.method !== "HEAD" &&
      (req.headers["content-length"] == null || req.headers["transfer-encoding"])
    ) {
      res.writeHead(411, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: "hub requires Content-Length" }));
      return;
    }
    if (requireAuth && req.headers.authorization !== expectedHeader) {
      res.writeHead(401, {
        "Content-Type": "application/json; charset=utf-8",
        "WWW-Authenticate": 'Basic realm="Harmony Hub Control"',
        "Set-Cookie": "hub_session=secret",
      });
      res.end(JSON.stringify({ ok: false, error: "Authentication required" }));
      return;
    }
    const proxied = http.request(
      {
        host: "127.0.0.1",
        port: simPort,
        path: req.url,
        method: req.method,
        headers: req.headers,
      },
      (up) => {
        res.writeHead(up.statusCode, up.headers);
        up.pipe(res);
      }
    );
    proxied.on("error", () => {
      res.writeHead(502);
      res.end();
    });
    req.pipe(proxied);
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        server,
        port: server.address().port,
        setRequireAuth(val) {
          requireAuth = Boolean(val);
        },
      });
    });
  });
}

test("Playwright _electron end-to-end shell suite against webui-sim", { timeout: 150_000 }, async () => {
  const userDataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "melodious-e2e-userdata-")
  );
  const shotsDir =
    process.env.MELODIOUS_E2E_SCREENSHOT_DIR ||
    fs.mkdtempSync(path.join(os.tmpdir(), "melodious-e2e-shots-"));
  fs.mkdirSync(shotsDir, { recursive: true });

  const simProc = spawn(
    process.execPath,
    [path.join(REPO_ROOT, "tools/webui-sim/server.mjs")],
    {
      env: { ...process.env, PORT: String(SIM_PORT) },
      stdio: "ignore",
    }
  );

  const preview = await startProdPreviewServer(SIM_PORT);
  const authProxy = await startAuthProxyServer(SIM_PORT);
  let electronApp = null;

  try {
    await waitForHttp(`http://127.0.0.1:${SIM_PORT}/api/system-status`);
    await waitForHttp(`http://127.0.0.1:${preview.port}/api/system-status`);

    electronApp = await electron.launch({
      args: [DESKTOP_DIR],
      env: {
        ...process.env,
        MELODIOUS_E2E: "1",
        MELODIOUS_USER_DATA_DIR: userDataDir,
      },
    });

    const page = await electronApp.firstWindow();
    await page.setViewportSize({ width: 1280, height: 800 });

    // 1. First run shows the Connect screen; connect by address to SIM_PORT
    await page.waitForSelector("#connectForm", { timeout: 10000 });
    assert.equal(await page.title(), "Connect · Melodious");

    await page.fill("#connectHost", "127.0.0.1");
    await page.fill("#connectPort", String(SIM_PORT));

    // Take masked connect screenshot before submitting
    await page.evaluate(() => {
      const h = document.getElementById("connectHost");
      if (h) h.value = "hub.local";
      const p = document.getElementById("connectPort");
      if (p) p.value = "8080";
      document.activeElement?.blur();
    });
    await page.screenshot({ path: path.join(shotsDir, "connect-1280.png") });
    await page.fill("#connectHost", "127.0.0.1");
    await page.fill("#connectPort", String(SIM_PORT));

    await page.click("#connectBtn");

    // Lands on the shell's Remote tab
    await page.waitForSelector("#view-remote:not([hidden])", { timeout: 10000 });
    assert.equal(await page.title(), "Remote · Melodious");

    // Find first device ID from sim config for device sub-page checks
    const configRes = await fetch(`http://127.0.0.1:${SIM_PORT}/api/activity-config`);
    const configJson = await configRes.json();
    const firstDeviceId = String(
      configJson.deviceList.DevicesWithFeatures[0].Device["Id-"]
    );

    // 2. Open a reference BrowserWindow against prod-preview at 1280x800 and compare every tab & sub-page
    await electronApp.evaluate(async ({ BrowserWindow }, previewPort) => {
      const refWin = new BrowserWindow({
        width: 1280,
        height: 800,
        show: false,
        webPreferences: {
          contextIsolation: true,
          sandbox: true,
        },
      });
      refWin.webContents.on("will-prevent-unload", (ev) => ev.preventDefault());
      globalThis.__refWin = refWin;
      await refWin.loadURL(`http://127.0.0.1:${previewPort}/#remote`);
    }, preview.port);

    const allWindows = electronApp.windows();
    const refPage = allWindows.find((w) => w !== page);
    assert.ok(refPage, "Reference prod-preview window should be open");
    await refPage.setViewportSize({ width: 1280, height: 800 });

    const routesToVerify = [
      { hash: "#remote", section: "#view-remote", title: "Remote · Melodious", shot: "remote-1280.png" },
      { hash: "#activities", section: "#view-activities-home", title: "Activities · Melodious", shot: "activities-1280.png" },
      { hash: "#wizard", section: "#view-wizard", title: "Activity setup · Melodious", shot: "wizard-1280.png" },
      { hash: "#editor", section: "#view-activities", title: "Advanced editor · Melodious", shot: "editor-1280.png" },
      { hash: "#devices", section: "#view-devices", title: "Devices · Melodious", shot: "devices-1280.png" },
      { hash: `#devices/${firstDeviceId}`, section: "#view-devices", title: "Devices · Melodious", shot: "device-detail-1280.png" },
      { hash: `#devices/${firstDeviceId}/settings`, section: "#view-devices", title: "Devices · Melodious", shot: "device-settings-1280.png" },
      { hash: `#devices/${firstDeviceId}/sweep`, section: "#view-devices", title: "Devices · Melodious", shot: "device-sweep-1280.png" },
      { hash: "#devices/lab", section: "#view-devices", title: "Devices · Melodious", shot: "ir-lab-1280.png" },
      { hash: "#settings", section: "#view-settings", title: "Settings · Melodious", shot: "settings-1280.png" },
      { hash: "#bluetooth", section: "#view-bluetooth", title: "Bluetooth · Melodious", shot: "bluetooth-1280.png" },
      { hash: "#mqtt", section: "#view-mqtt", title: "MQTT · Melodious", shot: "mqtt-1280.png" },
      { hash: "#wifi", section: "#view-wifi", title: "Wi-Fi · Melodious", shot: "wifi-1280.png" },
      { hash: "#backup", section: "#view-backup", title: "Backup · Melodious", shot: "backup-1280.png" },
      { hash: "#system", section: "#view-system", title: "System · Melodious", shot: "system-1280.png" },
    ];

    for (const r of routesToVerify) {
      await Promise.all([
        page.evaluate((h) => {
          window.location.hash = h;
        }, r.hash),
        refPage.evaluate((h) => {
          window.location.hash = h;
        }, r.hash),
      ]);

      await page.waitForSelector(`${r.section}:not([hidden])`, { timeout: 10000 });
      await refPage.waitForSelector(`${r.section}:not([hidden])`, { timeout: 10000 });
      await wait(350);

      assert.equal(await page.title(), r.title, `Title mismatch on ${r.hash}`);
      assert.equal(await refPage.title(), r.title, `Ref title mismatch on ${r.hash}`);

      // Compare rendered structure and layout metrics at 1280 px between desktop shell and prod-preview
      const [appSnapshot, refSnapshot] = await Promise.all([
        page.evaluate((sel) => {
          const el = document.querySelector(sel);
          const rect = el.getBoundingClientRect();
          const headings = [...el.querySelectorAll("h1,h2,h3")].map((h) =>
            h.textContent.trim()
          );
          const buttons = [...el.querySelectorAll("button,a.btn,a.m-row")].map(
            (b) => b.textContent.trim()
          );
          return {
            width: Math.round(rect.width),
            headings,
            buttonCount: buttons.length,
          };
        }, r.section),
        refPage.evaluate((sel) => {
          const el = document.querySelector(sel);
          const rect = el.getBoundingClientRect();
          const headings = [...el.querySelectorAll("h1,h2,h3")].map((h) =>
            h.textContent.trim()
          );
          const buttons = [...el.querySelectorAll("button,a.btn,a.m-row")].map(
            (b) => b.textContent.trim()
          );
          return {
            width: Math.round(rect.width),
            headings,
            buttonCount: buttons.length,
          };
        }, r.section),
      ]);

      assert.deepEqual(
        appSnapshot,
        refSnapshot,
        `Desktop shell vs prod-preview layout mismatch on ${r.hash}`
      );

      await page.screenshot({ path: path.join(shotsDir, r.shot) });
    }

    await electronApp.evaluate(() => {
      if (globalThis.__refWin && !globalThis.__refWin.isDestroyed()) {
        globalThis.__refWin.close();
      }
    });

    // 3. Download shows the Save dialog (will-download -> showSaveDialog)
    const downloadSavedPath = path.join(userDataDir, "downloaded-bundle.json");
    await electronApp.evaluate((_electron, targetPath) => {
      globalThis.__saveDialogCalls = [];
      globalThis.__melodiousShowSaveDialog = (_win, opts) => {
        globalThis.__saveDialogCalls.push(opts);
        return targetPath;
      };
    }, downloadSavedPath);

    await page.evaluate(() => {
      window.location.hash = "#backup";
    });
    await page.waitForSelector("#view-backup:not([hidden])");
    await page.evaluate(() => {
      document.querySelector('a[href="/export/bundle"]')?.click();
    });

    // The file exists before the download finishes (Windows writes it in
    // place), so wait until it holds the whole bundle.
    const readBundle = () => {
      try {
        return JSON.parse(fs.readFileSync(downloadSavedPath, "utf8"));
      } catch {
        return null;
      }
    };
    const deadline = Date.now() + 5000;
    let saveCalls = [];
    let bundleData = null;
    while (Date.now() < deadline) {
      saveCalls = await electronApp.evaluate(() => globalThis.__saveDialogCalls || []);
      bundleData = saveCalls.length > 0 ? readBundle() : null;
      if (bundleData) break;
      await wait(100);
    }
    assert.equal(saveCalls.length, 1, "Download should trigger showSaveDialogSync");
    assert.equal(saveCalls[0].defaultPath, "harmony-owner-bundle.json");
    assert.ok(bundleData, "the download is saved whole");
    assert.equal(bundleData.format, "harmony-owner-bundle-v2");

    // 4. Desktop Settings (⌘, / Menu -> Settings…)
    await electronApp.evaluate(({ Menu }) => {
      const menu = Menu.getApplicationMenu();
      const appSubmenu = menu.items[0]?.submenu;
      const settingsItem = appSubmenu?.items.find((i) => i.label === "Settings…");
      settingsItem?.click();
    });
    await page.waitForSelector("#connectRoot", { timeout: 10000 });
    assert.equal(await page.title(), "Settings · Melodious");
    assert.ok(await page.isVisible("#forgetHubBtn"));
    assert.ok(await page.isVisible("#clientIdInput"));

    // Reinstall / repair is offered whatever version the hub reports: in Settings → Updates and next to Check for Updates… in the menu.
    await page.waitForSelector("#updatesReinstallBtn:not([disabled])", { timeout: 10000 });
    assert.equal((await page.textContent("#updatesReinstallBtn")).trim(), "Reinstall / repair hub software…");
    const updateMenuLabels = await electronApp.evaluate(({ Menu }) =>
      Menu.getApplicationMenu().items[0].submenu.items.map((i) => i.label).filter((l) => /Updates|Hub Software/.test(l)));
    assert.deepEqual(updateMenuLabels.sort(), ["Check for Updates…", "Reinstall / Repair Hub Software…"]);

    // Mask address on settings page before screenshot
    await page.evaluate(() => {
      const addr = document.getElementById("currentHubAddress");
      if (addr) addr.textContent = "hub.local:8080";
      const host = document.getElementById("connectHost");
      if (host) host.value = "hub.local";
    });
    await page.screenshot({ path: path.join(shotsDir, "desktop-settings-1280.png") });

    // Point at authProxy port from Settings, then enable auth on authProxy to test 401 in the shell
    await page.fill("#connectHost", "127.0.0.1");
    await page.fill("#connectPort", String(authProxy.port));
    await page.click("#connectBtn");
    await page.waitForSelector("#view-remote:not([hidden])", { timeout: 10000 });

    // 5. A 401 from the hub opens the hub sign-in sheet; saving credentials authenticates and reloads
    authProxy.setRequireAuth(true);
    await page.evaluate(() => {
      fetch("/api/activity-config").catch(() => {});
    });

    await page.waitForSelector("dialog#hubSignInSheet[open]", { timeout: 10000 });
    await wait(450);
    await page.evaluate(() => {
      const p = document.querySelector("#hubSignInSheet .sheet-text");
      if (p) p.textContent = "Enter the username and password for hub.local.";
    });
    await page.screenshot({ path: path.join(shotsDir, "hub-signin-sheet-1280.png") });
    await page.fill("#hubSignInUser", "owner");
    await page.fill("#hubSignInPass", "hubpass");
    await page.click("#hubSignInSubmit");

    await page.waitForSelector("#view-remote:not([hidden])", { timeout: 10000 });
    await wait(300);
    assert.equal(await page.locator("dialog#hubSignInSheet").count(), 0);

    // Verify subsequent requests succeed with the saved Basic auth header
    const statusAfterAuth = await page.evaluate(async () => {
      const res = await fetch("/api/system-status");
      return res.status;
    });
    assert.equal(statusAfterAuth, 200);

    // Form POSTs from the page reach the hub with a Content-Length body
    // (activity start and power off, as js/api.js sends them).
    const runReplies = await page.evaluate(async () => {
      const config = await (await fetch("/api/activity-config")).json();
      const first = (config.activityList?.Activities || []).find(
        (a) => String(a["Id-"] ?? a.Id) !== "-1"
      );
      const out = [];
      for (const id of ["-1", String(first["Id-"] ?? first.Id)]) {
        const res = await fetch("/api/activity-run", {
          method: "POST",
          cache: "no-store",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ activityId: id }).toString(),
        });
        out.push({ status: res.status, body: await res.json() });
      }
      return out;
    });
    for (const reply of runReplies) {
      assert.equal(reply.status, 200, JSON.stringify(reply.body));
      assert.equal(reply.body.ok, true, JSON.stringify(reply.body));
    }

    // Catalog client stub stays in main; preload, IPC, bundled tab, preview,
    // Content-Length forwarder and simulator persistence are all real.
    const fixture = JSON.parse(fs.readFileSync(path.join(DESKTOP_DIR, "test/fixtures/catalog-fixtures.json"), "utf8"));
    await electronApp.evaluate((_electron, wire) => {
      let signedIn = false;
      globalThis.__catalogCalls = [];
      globalThis.__melodiousCatalogService = {
        status: async () => ({ signedIn }),
        signIn: async () => { globalThis.__catalogCalls.push("signIn"); signedIn = true; return { signedIn }; },
        signOut: async () => { signedIn = false; return { signedIn }; },
        checkModel: async () => ({ found: true, manufacturer: "Sony", model: "STR-DG720" }),
        search: async () => {
          globalThis.__catalogCalls.push("search");
          return [{ id: 167856, manufacturer: "Sony", model: "STR-DG720", displayText: "Sony STR-DG720", deviceType: "Receiver", description: "Catalog fixture" }];
        },
        download: async () => {
          globalThis.__catalogCalls.push("download");
          return { schema_version: "0.2.0", source: "logitech-catalog-via-melodious-desktop", resources: { global_language_commands: wire.getGlobalLanguageCommands.GetGlobalLanguageCommandsResult } };
        },
      };
    }, fixture);
    const labId = await page.evaluate(async () => {
      const r = await fetch("/api/ir-lab-target", { method: "POST", body: "" });
      return (await r.json()).deviceId;
    });
    assert.ok(labId);
    await page.evaluate((id) => { window.location.hash = `#devices/${id}`; }, labId);
    await page.reload(); // The lab was created outside the view's config cache.
    await page.getByRole("tab", { name: /^Commands/ }).click();
    await page.getByRole("button", { name: "Import codes", exact: true }).click();
    assert.deepEqual(await electronApp.evaluate(() => globalThis.__catalogCalls), []);
    await page.getByRole("tab", { name: "Logitech catalog" }).click();
    const catalogPanel = page.locator('[role="tabpanel"][id$="panel-catalog"]');
    await catalogPanel.getByRole("button", { name: "Sign in", exact: true }).click();
    await catalogPanel.getByText("Signed in to Logitech", { exact: true }).waitFor();
    await catalogPanel.getByLabel("Brand", { exact: true }).fill("Sony");
    await catalogPanel.getByLabel("Model", { exact: true }).fill("STR-DG7");
    await catalogPanel.getByRole("button", { name: "Search Logitech catalog" }).click();
    await catalogPanel.getByRole("button", { name: "Download", exact: true }).click();
    await catalogPanel.getByRole("button", { name: "Import 4 commands to Temporary IR Test", exact: true }).waitFor();
    assert.match(await catalogPanel.innerText(), /SmartKey — protocol “RC6 Mode 0” is not on this hub/);
    assert.match(await catalogPanel.innerText(), /missing on hub: RC6 Mode 0/);
    assert.deepEqual(await electronApp.evaluate(() => globalThis.__catalogCalls), ["signIn", "search", "download"]);
    // Only synthetic fixtures are on this screen. Mask the target label too.
    await page.evaluate(() => {
      document.querySelectorAll(".sheet-title, .import-sheet button").forEach((el) => {
        if (el.textContent.includes("Temporary IR Test")) el.textContent = el.textContent.replace("Temporary IR Test", "Scratch device");
      });
    });
    await page.screenshot({ path: path.join(shotsDir, "catalog-search-1280.png") });
    await catalogPanel.getByRole("button", { name: "Import 4 commands to Scratch device", exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(shotsDir, "catalog-preview-1280.png") });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(450); // Let the sheet's breakpoint animation finish.
    await catalogPanel.getByRole("button", { name: "Import 4 commands to Scratch device", exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(shotsDir, "catalog-preview-390.png") });
    await page.setViewportSize({ width: 1280, height: 800 });
    const importReply = page.waitForResponse((r) => r.url().endsWith("/api/catalog-import") && r.request().method() === "POST");
    await catalogPanel.getByRole("button", { name: "Import 4 commands to Scratch device", exact: true }).click();
    assert.equal((await importReply).status(), 200);
    await page.waitForSelector("dialog.import-sheet", { state: "detached" });
    const savedCommands = await page.evaluate(async (id) => {
      const config = await (await fetch("/api/activity-config")).json();
      return config.deviceList.DevicesWithFeatures.find((e) => String(e.Device["Id-"]) === id).Commands;
    }, String(labId));
    assert.equal(savedCommands.length, 4);
    for (const row of savedCommands) {
      const original = fixture.getGlobalLanguageCommands.GetGlobalLanguageCommandsResult.find((c) => c.Name === row.Name);
      assert.equal(row.KeyCode, original.KeyCode);
      assert.equal(row.ProtocolId, original.ProtocolId);
    }
    console.log("catalog e2e: search → download → preview (4 importable, 1 skipped with reason) → import/read-back: OK");

    // 6. Navigation to another origin is cancelled; https: window.open goes to shell.openExternal
    await electronApp.evaluate(() => {
      globalThis.__externalOpened = [];
      globalThis.__melodiousOpenExternal = async (url) => {
        globalThis.__externalOpened.push(url);
      };
    });

    await page.evaluate(() => {
      window.open("https://example.com/docs", "_blank");
      window.open("http://example.com/insecure", "_blank");
    });
    await wait(200);
    const externalOpened = await electronApp.evaluate(
      () => globalThis.__externalOpened || []
    );
    assert.deepEqual(externalOpened, ["https://example.com/docs"]);
    assert.equal(electronApp.windows().length, 1);

    await page.evaluate(() => {
      window.location.href = "https://example.com/should-be-cancelled";
    });
    await wait(300);
    assert.ok(page.url().startsWith("melodious://app/"));

    // 7. Unreachable hub returns 502 and offers the connect screen
    authProxy.server.closeAllConnections?.();
    await new Promise((r) => authProxy.server.close(r));
    const status502 = await page.evaluate(async () => {
      const res = await fetch("/api/system-status");
      return res.status;
    });
    assert.equal(status502, 502);
    const hasConnectBtn = await page.evaluate(() =>
      Boolean(document.getElementById("openConnectScreenBtn"))
    );
    assert.equal(hasConnectBtn, true);
    await page.evaluate(() => {
      document.getElementById("openConnectScreenBtn")?.click();
    });
    await page.waitForSelector("#connectForm", { timeout: 10000 });
    assert.equal(await page.title(), "Connect · Melodious");
  } finally {
    if (electronApp) {
      await electronApp.close();
    }
    simProc.kill();
    preview.server.closeAllConnections?.();
    authProxy.server.closeAllConnections?.();
    await new Promise((r) => preview.server.close(() => r()));
    await new Promise((r) => authProxy.server.close(() => r()));
    fs.rmSync(userDataDir, { recursive: true, force: true });
    if (!process.env.MELODIOUS_E2E_SCREENSHOT_DIR) {
      fs.rmSync(shotsDir, { recursive: true, force: true });
    }
  }
});

test(
  "Playwright _electron Root & Setup Wizard 1-2-3 guided flow and packaged gating",
  { timeout: 120_000 },
  async () => {
    const userDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "melodious-wiz-e2e-userdata-")
    );
    const wizSimPort = SIM_PORT + 11;
    const simProc = spawn(
      process.execPath,
      [path.join(REPO_ROOT, "tools/webui-sim/server.mjs")],
      {
        env: { ...process.env, PORT: String(wizSimPort) },
        stdio: "ignore",
      }
    );

    let electronApp = null;
    try {
      await waitForHttp(`http://127.0.0.1:${wizSimPort}/api/system-status`);

      electronApp = await electron.launch({
        args: [DESKTOP_DIR],
        env: {
          ...process.env,
          MELODIOUS_E2E: "1",
          MELODIOUS_USER_DATA_DIR: userDataDir,
        },
      });

      const page = await electronApp.firstWindow();
      await page.setViewportSize({ width: 1280, height: 840 });
      await page.waitForSelector("#connectForm", { timeout: 10000 });

      // 1. Packaged / gated-off check (isWizardAvailable = false): hides all wizard UI & rejects IPC
      await electronApp.evaluate(() => {
        globalThis.__melodiousWizardAvailable = false;
      });
      await page.reload();
      await page.waitForSelector("#connectForm", { timeout: 10000 });
      assert.equal(await page.locator("#openWizardConnectBtn").count(), 0);
      assert.equal(await page.locator("#hubSetupWizard").count(), 0);

      await electronApp.evaluate(({ Menu }) => {
        const menu = Menu.getApplicationMenu();
        const sub = menu.items[0]?.submenu;
        sub?.items.find((i) => i.label === "Settings…")?.click();
      });
      await page.waitForSelector("#clientIdInput", { timeout: 10000 });
      assert.equal(await page.locator("#openWizardSettingsBtn").count(), 0);

      const gatedErr = await page.evaluate(async () => {
        try {
          await window.melodiousDesktop.wizard.detectAndClassify({});
          return "";
        } catch (err) {
          return String(err?.message || err);
        }
      });
      assert.match(gatedErr, /Root Wizard dev actions are not available/);

      // 2. Enable source-mode wizard availability + install deterministic offline wizard stubs
      await electronApp.evaluate((_electron, { simPort }) => {
        const classifyHubSignals = globalThis.__melodiousClassifyHubSignals;
        globalThis.__melodiousWizardAvailable = true;
        globalThis.__wizardActionCalls = [];
        globalThis.__wizardInstallCalls = [];
        globalThis.__wizardDetectHosts = [];

        globalThis.__melodiousWizardOverrides = {
          detectAndClassify: async (opts) => {
            globalThis.__wizardDetectHosts.push(opts.host || "");
            opts.onEvent?.({
              type: "step",
              step: "usb-preflight",
              message: "Reading /rf/deviceinfo over USB HID",
            });
            const classified = classifyHubSignals({
              userIntent: opts.userIntent,
              ssdpCandidates: [],
              webUiProbe: null,
              bridgeResult: {
                usb: {
                  ok: true,
                  connected: true,
                  deviceCount: 1,
                  device: { backend: "hidapi", vendorId: "046D", productId: "C129" },
                  preflight: { ok: true, hasHubId: false, pairedDeviceCount: 0 },
                  sysinfo: { ok: true, fwVer: "4.15.600", skinDecimal: 106, ramSize: "64MB" },
                  provisionInfo: { ok: true, provisioned: false, mode: null },
                  discoveryInfo: { ok: true, provisioned: false, currentFwVersion: "4.15.600" },
                  usbWedge: false,
                },
                lan: { ok: false, skipped: true, ports: {} },
              },
              mask: opts.mask,
            });
            return {
              ok: true,
              bridgeOk: true,
              bridgeExitCode: 0,
              pythonPath: "python3",
              bridgeError: null,
              events: [],
              ...classified,
            };
          },
          runWizardAction: async (opts) => {
            globalThis.__wizardActionCalls.push({
              action: opts.action,
              confirmAction: opts.confirmAction,
              host: opts.host,
              ssid: opts.ssid,
              hasPassword: Boolean(opts.password),
              passwordValue: opts.password,
              remoteId: opts.remoteId,
              remoteIdType: typeof opts.remoteId,
            });
            opts.onEvent?.({
              type: "step",
              step: opts.action,
              message: `Simulated ${opts.action}`,
            });
            if (opts.action === "usb-wifi-scan") {
              return {
                ok: true,
                action: opts.action,
                result: {
                  ok: true,
                  wifiScan: {
                    networkCount: 1,
                    networks: [
                      { ssid: "Home24GHz", encryption: "WPA2-PSK", signal_strength: 192 },
                    ],
                  },
                },
              };
            }
            if (opts.action === "usb-wifi-connect") {
              return {
                ok: true,
                action: opts.action,
                result: { ok: true, wifiConnect: { ok: true, ssid: opts.ssid } },
              };
            }
            if (opts.action === "usb-wifi-status") {
              return {
                ok: true,
                action: opts.action,
                result: {
                  ok: true,
                  wifiStatus: { ok: true, ipAddress: "127.0.0.1", ssid: "Home24GHz" },
                },
              };
            }
            if (opts.action === "usb-root") {
              return {
                ok: true,
                action: opts.action,
                result: {
                  ok: true,
                  root: {
                    ok: true,
                    action: "usb-root",
                    transport: "usb",
                    host: opts.host,
                    sshPort: 22,
                    sshPortOpen: true,
                  },
                },
              };
            }
            return {
              ok: true,
              action: opts.action,
              result: { ok: true },
            };
          },
          installFreshHub: async (opts) => {
            globalThis.__wizardInstallCalls.push({
              source: opts.source,
              host: opts.host,
              hubId: opts.hubId,
              hubIdType: typeof opts.hubId,
              preflightOnly: opts.preflightOnly,
              removeRootToolLeftovers: opts.removeRootToolLeftovers,
            });
            opts.onEvent?.({
              type: "step",
              step: "install-webui",
              phase: "Checking SSH",
              message: "Checking SSH",
            });
            opts.onEvent?.({
              type: "progress",
              step: "install-webui",
              status: "ok",
              verdict: "ALLOWED",
              message: "Preflight verdict: ALLOWED",
            });
            return {
              ok: true,
              source: opts.source,
              version: "2.1.0",
              host: opts.host,
              port: simPort,
              hubId: opts.hubId,
              preflightOnly: Boolean(opts.preflightOnly),
              exitCode: 0,
              verdict: "ALLOWED",
              webUiReachable: true,
            };
          },
        };
      }, { simPort: wizSimPort });

      // 3. Settings entry ("Set up or re-root a hub") opens wizard and Back returns to Settings
      await page.reload();
      await page.waitForSelector("#openWizardSettingsBtn", { timeout: 10000 });
      assert.match(await page.textContent("#openWizardSettingsBtn"), /Set up or re-root a hub/);
      await page.click("#openWizardSettingsBtn");
      await page.waitForSelector("#hubSetupWizard", { timeout: 10000 });
      assert.equal(await page.title(), "Hub Setup · Melodious");
      assert.equal((await page.textContent("#connectAppbarStepNote")).trim(), "Step 1 of 3");

      await page.click("#settingsBackBtn");
      await page.waitForSelector("#openWizardSettingsBtn", { timeout: 10000 });
      assert.equal(await page.title(), "Settings · Melodious");

      // 4. OOB Connect entry ("Set up a new or unrooted Harmony Hub") below discovered hubs
      await page.evaluate(async () => {
        await window.melodiousDesktop.hub.openConnect();
        window.location.reload();
      });
      await page.waitForSelector("#openWizardConnectBtn", { timeout: 10000 });
      assert.match(
        await page.textContent("#openWizardConnectBtn"),
        /Set up a new or unrooted Harmony Hub/
      );
      // Even though saved settings already hold a connected host (127.0.0.1),
      // opening Fresh OOB wizard must leave #wizardHostInput blank!
      await page.click("#openWizardConnectBtn");
      await page.waitForSelector("#hubSetupWizard", { timeout: 10000 });
      assert.equal(await page.inputValue("#wizardHostInput"), "");

      // Typing an explicit IP on Step 1 always takes precedence, and clearing it resets confirmedHost
      await page.fill("#wizardHostInput", "192.168.0.235");
      await page.click("#wizardDetectBtn");
      await page.waitForSelector("#wizardResultCard", { timeout: 10000 });
      assert.equal(await page.inputValue("#wizardHostInput"), "192.168.0.235");
      await page.fill("#wizardHostInput", "");

      // Developer overrides accordion stays collapsed by default (no wall of buttons)
      assert.equal(
        await page.evaluate(() => document.getElementById("wizardDevOverrides")?.open),
        false
      );

      // 5. Step 1: Select "Already set up with Logitech" against a fresh hub -> prominent mismatch banner -> switch to Fresh
      await page.click("#wizardIntentProvisionedLabel");
      await page.click("#wizardDetectBtn");
      await page.waitForSelector("#wizardMismatchBanner", { timeout: 10000 });
      assert.match(
        await page.textContent("#wizardMismatchBanner"),
        /Mismatch: Hub is unprovisioned \/ factory-reset/
      );
      assert.match(await page.textContent("#wizardFirmwareCard"), /4\.15\.600 · Pass/);

      await page.click("#wizardSwitchIntentBtn");
      await page.waitForSelector("#wizardMismatchBanner", {
        state: "detached",
        timeout: 10000,
      });
      await page.waitForSelector("#wizardToStep2Btn:not([disabled])", { timeout: 10000 });
      assert.equal(await page.locator("#wizardMismatchBanner").count(), 0);

      // 6. Step 2: Guided Fresh progression (Wi-Fi -> TDE/Provision/Seed -> USB Root & Install)
      await page.click("#wizardToStep2Btn");
      await page.waitForSelector("#wizardStep2Fresh", { timeout: 10000 });
      assert.equal((await page.textContent("#connectAppbarStepNote")).trim(), "Step 2 of 3");

      // 6a. Scan Wi-Fi, pick network, enter password, connect -> auto-detects 127.0.0.1
      await page.click("#freshWifiScanBtn");
      await page.waitForSelector('[data-wifi-idx="0"]', { timeout: 10000 });
      await page.click('[data-wifi-idx="0"]');
      assert.equal(await page.inputValue("#wizardWifiSsidInput"), "Home24GHz");
      await page.fill("#wizardWifiPassInput", "TestPassphrase123");
      await page.click("#freshWifiConnectBtn");
      await page.waitForFunction(
        () => document.getElementById("freshConfirmedHostInput")?.value === "127.0.0.1",
        null,
        { timeout: 10000 }
      );

      // 6b. Unlock & Prepare Hub (TDE -> Provision Local with numeric remoteId -> Seed AutomationConfig)
      await page.fill("#wizardRemoteIdInput", "20264150");
      await page.click("#freshPrepareHubBtn");
      await page.waitForSelector("dialog#wizardConfirmDialog[open]", { timeout: 10000 });
      await page.click("#wizardConfirmAcceptBtn");
      await page.waitForSelector("#freshStagePrepare.is-done", { timeout: 10000 });

      // 6c. Root & Install Melodious -> advances automatically to Step 3 Handoff
      await page.click("#freshRootAndInstallBtn");
      await page.waitForSelector("dialog#wizardConfirmDialog[open]", { timeout: 10000 });
      await page.click("#wizardConfirmAcceptBtn");

      // 7. Step 3: Verify desktop connected to hub, post-install checklist rendered, and "Open Hub" opens web UI
      await page.waitForSelector("#wizardStep3ConnectedCard", { timeout: 10000 });
      assert.equal((await page.textContent("#connectAppbarStepNote")).trim(), "Step 3 of 3");
      assert.match(await page.textContent("#wizardStep3ConnectedCard"), /Connected · Melodious 2\.1\.0/);
      const checklistText = await page.textContent("#wizardPostInstallChecklist");
      assert.match(checklistText, /Add your first device/);
      assert.match(checklistText, /Create your first activity/);
      assert.match(checklistText, /Pair your remote/);

      const recorded = await electronApp.evaluate(() => ({
        detectHosts: globalThis.__wizardDetectHosts,
        actions: globalThis.__wizardActionCalls,
        installs: globalThis.__wizardInstallCalls,
      }));
      assert.deepEqual(recorded.detectHosts, ["192.168.0.235", "", ""]);
      assert.deepEqual(
        recorded.actions.map((a) => a.action),
        [
          "usb-wifi-scan",
          "usb-wifi-connect",
          "usb-wifi-status",
          "usb-tde-enable",
          "usb-provision-local",
          "usb-seed-automation",
          "usb-root",
        ]
      );
      const wifiCall = recorded.actions.find((a) => a.action === "usb-wifi-connect");
      assert.equal(wifiCall.passwordValue, "TestPassphrase123");
      const provCall = recorded.actions.find((a) => a.action === "usb-provision-local");
      assert.equal(provCall.remoteId, 20264150);
      assert.equal(provCall.remoteIdType, "number");
      assert.deepEqual(recorded.installs, [
        {
          source: "latest",
          host: "127.0.0.1",
          hubId: 20264150,
          hubIdType: "number",
          preflightOnly: false,
          removeRootToolLeftovers: true,
        },
      ]);

      await page.click("#wizardOpenHubBtn");
      await page.waitForSelector("#view-remote:not([hidden])", { timeout: 10000 });
      assert.equal(await page.title(), "Remote · Melodious");
    } finally {
      if (electronApp) {
        await electronApp.close();
      }
      simProc.kill();
      fs.rmSync(userDataDir, { recursive: true, force: true });
    }
  }
);
