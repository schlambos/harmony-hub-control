#!/usr/bin/env node
// capture-oob-screenshots.mjs — reproducible screenshots of the cross-platform
// first-run Setup Wizard (both paths) for docs/SETUP_GUIDE.md.
//
// Runs the desktop app from source with MELODIOUS_E2E=1 against the
// simulated hub (tools/webui-sim/server.mjs, bound to 127.0.0.1). Every
// wizard bridge call is answered by stubs installed through
// globalThis.__melodiousWizardOverrides, so nothing touches USB, the LAN or a
// real hub. The sim listens on loopback, so just before each capture the
// script swaps the loopback address for a documentation address
// (192.168.1.50) in visible text and input values.
//
// Usage (from desktop/):
//   sh scripts/bundle-shell.sh            # once, stages build/shell
//   node scripts/capture-oob-screenshots.mjs [outDir]
//
// Default outDir: docs/screenshots/desktop/wizard/. connect-1280.png is
// written one level up (docs/screenshots/desktop/).

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { _electron: electron } = require("playwright");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP_DIR = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(DESKTOP_DIR, "..");
const SIM_PORT = Number(process.env.SIM_PORT || 8833);
const OUT_DIR = path.resolve(
  process.argv[2] || path.join(REPO_ROOT, "docs/screenshots/desktop/wizard")
);
const CONNECT_SHOT = path.join(path.dirname(OUT_DIR), "connect-1280.png");
const FAKE_HOST = "192.168.1.50";
const FAKE_HUB_ID = 20264150;
const VIEWPORT = { width: 1280, height: 840 };

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

// Main-process stubs. `mode` picks which simulated hub the next detection sees.
function installWizardStubs(_electron, { simPort, fakeHubId }) {
  const classifyHubSignals = globalThis.__melodiousClassifyHubSignals;
  globalThis.__melodiousWizardAvailable = true;
  globalThis.__oobMode = "fresh";
  globalThis.__oobHoldAction = "";
  globalThis.__oobRelease = null;

  const lanHub = (ports, provisioned = true) => ({
    usb: { ok: false, connected: false, deviceCount: 0 },
    lan: {
      ok: true,
      host: "127.0.0.1",
      provisionInfo: {
        ok: true,
        provisioned,
        mode: 3,
        activeRemoteId: fakeHubId,
        hasActiveRemoteId: true,
        remoteIdType: "number",
      },
      ports,
    },
  });
  const usbHub = ({ fwVer = "4.15.600", provisioned = false } = {}) => ({
    usb: {
      ok: true,
      connected: true,
      deviceCount: 1,
      device: { backend: "hidapi", vendorId: "046D", productId: "C129" },
      preflight: { ok: true, hasHubId: provisioned, pairedDeviceCount: 0 },
      sysinfo: { ok: true, fwVer, skinDecimal: 106, ramSize: "64MB" },
      provisionInfo: provisioned
        ? { ok: true, provisioned: true, mode: 3, remoteIdType: "number" }
        : { ok: true, provisioned: false, mode: null },
      discoveryInfo: { ok: true, provisioned, currentFwVersion: fwVer },
      usbWedge: false,
    },
    lan: { ok: false, skipped: true, ports: {} },
  });

  const scenarios = {
    // Already set up in the Harmony app, XMPP on.
    "provisioned": () => ({
      ssdp: [{ host: "127.0.0.1", webUiPort: 8080, hbusPort: 8088 }],
      bridge: lanHub({ 8080: false, 8088: true, 5222: true, 22: false }),
    }),
    // Already set up in the Harmony app, XMPP still off.
    "provisioned-xmpp-off": () => ({
      ssdp: [{ host: "127.0.0.1", webUiPort: 8080, hbusPort: 8088 }],
      bridge: lanHub({ 8080: false, 8088: true, 5222: false, 22: false }),
    }),
    // Plugged in over USB, still carrying a previous owner's setup on older
    // firmware. (A 4.15.600 reading sticks for the session, so the older
    // firmware keeps the update screen reachable after the erase.)
    "usb-old-setup": () => ({ ssdp: [], bridge: usbHub({ provisioned: true, fwVer: "4.15.250" }) }),
    // Plugged in over USB, blank, older firmware.
    "fresh-old-firmware": () => ({ ssdp: [], bridge: usbHub({ fwVer: "4.15.250" }) }),
    // Plugged in over USB, blank, 4.15.600.
    "fresh": () => ({ ssdp: [], bridge: usbHub() }),
  };

  const hold = async (action) => {
    if (globalThis.__oobHoldAction !== action) return;
    globalThis.__oobHoldAction = "";
    await new Promise((resolve) => {
      globalThis.__oobRelease = resolve;
    });
  };

  globalThis.__melodiousWizardOverrides = {
    detectAndClassify: async (opts) => {
      const scenario = (scenarios[globalThis.__oobMode] || scenarios.fresh)();
      const classified = classifyHubSignals({
        userIntent: opts.userIntent,
        ssdpCandidates: scenario.ssdp,
        webUiProbe: null,
        bridgeResult: scenario.bridge,
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
      opts.onEvent?.({ type: "step", step: opts.action, message: `Simulated ${opts.action}` });
      await hold(opts.action);
      if (opts.action === "usb-wifi-scan") {
        return {
          ok: true,
          action: opts.action,
          result: {
            ok: true,
            wifiScan: {
              networkCount: 2,
              networks: [
                { ssid: "Home-WiFi", encryption: "WPA2-PSK", signal_strength: 205 },
                { ssid: "Guest-2.4G", encryption: "WPA2-PSK", signal_strength: 150 },
              ],
            },
          },
        };
      }
      if (opts.action === "usb-wifi-connect") {
        return { ok: true, action: opts.action, result: { ok: true, wifiConnect: { ok: true, ssid: opts.ssid } } };
      }
      if (opts.action === "usb-wifi-status") {
        return {
          ok: true,
          action: opts.action,
          result: { ok: true, wifiStatus: { ok: true, ipAddress: "127.0.0.1", ssid: "Home-WiFi" } },
        };
      }
      if (opts.action === "usb-root" || opts.action === "lan-root-xmpp") {
        return {
          ok: true,
          action: opts.action,
          result: {
            ok: true,
            root: {
              ok: true,
              action: opts.action,
              transport: opts.action === "usb-root" ? "usb" : "lan",
              host: opts.host,
              sshPort: 22,
              sshPortOpen: true,
            },
          },
        };
      }
      return { ok: true, action: opts.action, result: { ok: true } };
    },
    installFreshHub: async (opts) => {
      opts.onEvent?.({ type: "step", step: "install-webui", phase: "Checking SSH", message: "Checking SSH" });
      await hold("install-webui");
      return {
        ok: true,
        source: opts.source,
        version: "2.1.0",
        host: opts.host,
        port: simPort,
        hubId: opts.hubId,
        preflightOnly: false,
        exitCode: 0,
        verdict: "ALLOWED",
        webUiReachable: true,
      };
    },
  };
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  if (!fs.existsSync(path.join(DESKTOP_DIR, "build/shell/index.html"))) {
    throw new Error("desktop/build/shell is missing; run `sh scripts/bundle-shell.sh` first");
  }

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "melodious-oob-shots-"));
  const simProc = spawn(process.execPath, [path.join(REPO_ROOT, "tools/webui-sim/server.mjs")], {
    env: { ...process.env, PORT: String(SIM_PORT) },
    stdio: "ignore",
  });

  let app = null;
  try {
    await waitForHttp(`http://127.0.0.1:${SIM_PORT}/api/system-status`);
    app = await electron.launch({
      args: [DESKTOP_DIR],
      env: {
        ...process.env,
        MELODIOUS_E2E: "1",
        MELODIOUS_USER_DATA_DIR: userDataDir,
      },
    });
    await app.evaluate(({ nativeTheme }) => {
      nativeTheme.themeSource = "dark";
    });
    await app.evaluate(installWizardStubs, { simPort: SIM_PORT, fakeHubId: FAKE_HUB_ID });

    const page = await app.firstWindow();
    await page.setViewportSize(VIEWPORT);
    await page.emulateMedia({ colorScheme: "dark" });

    const setMode = (mode) => app.evaluate((_e, m) => { globalThis.__oobMode = m; }, mode);
    const holdNext = (action) => app.evaluate((_e, a) => { globalThis.__oobHoldAction = a; }, action);
    const release = async () => {
      await app.evaluate(() => {
        const r = globalThis.__oobRelease;
        globalThis.__oobRelease = null;
        r?.();
      });
    };

    // Swap loopback addresses for the documentation address, then capture.
    const shot = async (name, file = path.join(OUT_DIR, name), clip = undefined) => {
      await page.mouse.move(VIEWPORT.width - 2, VIEWPORT.height - 2);
      await page.evaluate(({ fake, simPort }) => {
        const swap = (s) =>
          s
            .replaceAll(`127.0.0.1:${simPort}`, `${fake}:8080`)
            .replaceAll(`localhost:${simPort}`, `${fake}:8080`)
            .replaceAll("127.0.0.1", fake);
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          if (n.nodeValue.includes("127.0.0.1") || n.nodeValue.includes("localhost:")) {
            n.nodeValue = swap(n.nodeValue);
          }
        }
        for (const input of document.querySelectorAll("input")) {
          if (input.value.includes("127.0.0.1")) input.value = swap(input.value);
          if (input.value === String(simPort)) input.value = "8080";
        }
        document.activeElement?.blur?.();
      }, { fake: FAKE_HOST, simPort: SIM_PORT });
      await wait(250);
      await page.screenshot({ path: file, clip });
      console.log(`captured ${path.relative(REPO_ROOT, file)}`);
    };

    const openWizardFromScratch = async () => {
      await page.evaluate(async () => {
        await window.melodiousDesktop.hub.forgetHub();
        await window.melodiousDesktop.hub.openConnect();
        window.location.reload();
      });
      await page.waitForSelector("#hubSetupWizard", { timeout: 10000 });
    };

    // --- Welcome (first run, no saved hub) ---
    await page.reload();
    await page.waitForSelector("#hubSetupWizard", { timeout: 10000 });
    await page.waitForSelector("text=Welcome to Melodious");
    await shot("01-welcome-oob.png");

    // --- Connect fallback ("My hub already runs Melodious") ---
    await page.click("#wizardUseExistingConnectBtn");
    await page.waitForSelector("#openWizardConnectBtn", { timeout: 10000 });
    await page.fill("#connectHost", FAKE_HOST).catch(() => {});
    await wait(3500); // let the discovery pass finish
    await shot("02-connect-fallback.png");
    await shot("connect-1280.png", CONNECT_SHOT);
    await page.click("#openWizardConnectBtn");
    await page.waitForSelector("#hubSetupWizard", { timeout: 10000 });

    // --- Path A: already set up in the Harmony app ---
    await page.click("#wizardIntentProvisionedLabel");
    await setMode("provisioned-xmpp-off");
    await page.click("#wizardDetectBtn");
    await page.waitForSelector("#wizardUseUsbInsteadBtn", { timeout: 10000 });
    await shot("05a-prov-xmpp-closed.png");

    await setMode("provisioned");
    await page.click("#wizardRecheckBtn");
    await page.waitForSelector('#wizardToStep2Btn[data-next-branch="provisioned"]:not([disabled])', { timeout: 10000 });
    await shot("04a-prov-detect-ready.png");

    await page.click("#wizardToStep2Btn");
    await page.waitForSelector("#wizardStep3Install", { timeout: 10000 });
    await shot("06a-prov-install-ready.png");

    await holdNext("lan-root-xmpp");
    await page.click("#wizardInstallMelodiousBtn");
    await page.waitForSelector('[data-install-step="2"].is-active', { timeout: 10000 });
    await shot("07a-prov-installing.png");
    await release();
    await page.waitForSelector("#wizardStep4DoneCard", { timeout: 15000 });
    await page.waitForSelector("#wizardStep3ConnectedCard .setup-pill.is-done", { timeout: 15000 });

    // --- Settings entry (a hub is saved now) ---
    await app.evaluate(({ Menu }) => {
      const sub = Menu.getApplicationMenu()?.items[0]?.submenu;
      sub?.items.find((i) => i.label === "Settings…")?.click();
    });
    await page.waitForSelector("#openWizardSettingsBtn", { timeout: 10000 });
    await shot("03-settings-top-entry.png");

    // --- Path B: brand new, factory reset, or bought used ---
    await openWizardFromScratch();
    await page.click("#wizardIntentFreshLabel");
    await setMode("usb-old-setup");
    await page.click("#wizardDetectBtn");
    await page.waitForSelector("#wizardEraseAndStartFreshBtn", { timeout: 10000 });
    await shot("05b-fresh-mismatch-erase.png");

    await page.click("#wizardEraseAndStartFreshBtn");
    await page.waitForSelector("#wizardConfirmFactoryResetBtn", { timeout: 10000 });
    await page.click("#wizardConfirmFactoryResetBtn");
    await page.waitForSelector("#wizardResetRecoveryNotice", { timeout: 10000 });
    await page.waitForSelector(".snackbar, [role=status]", { state: "detached", timeout: 8000 }).catch(() => {});
    await wait(4000); // let the "Hub erased" snackbar fade
    await shot("06b-fresh-factory-reset.png");

    await setMode("fresh-old-firmware");
    await page.click("#wizardPostResetCheckBtn");
    await page.waitForSelector("#wizardToFirmwareUpdateBtn", { timeout: 10000 });
    await page.click("#wizardToFirmwareUpdateBtn");
    await page.waitForSelector("#wizardFirmwareUpdateScreen", { timeout: 10000 });
    await shot("07b-fresh-firmware-update.png");

    await page.click("#wizardSubScreenBackBtn");
    await setMode("fresh");
    await page.click("#wizardDetectBtn");
    await page.waitForSelector('#wizardToStep2Btn[data-next-branch="fresh"]:not([disabled])', { timeout: 10000 });
    await shot("04b-fresh-detect-ready.png");

    await page.click("#wizardToStep2Btn");
    await page.waitForSelector('[data-wifi-idx="1"]', { timeout: 10000 });
    await page.click('[data-wifi-idx="0"]');
    await page.fill("#wizardWifiPassInput", "correct-horse-battery");
    await shot("08b-fresh-wifi.png");

    await page.click("#freshWifiConnectBtn");
    await page.waitForSelector("#wizardWifiContinueBtn:not([disabled])", { timeout: 15000 });
    await page.click("#wizardWifiContinueBtn");
    await page.waitForSelector("#wizardStep3Install", { timeout: 10000 });
    await wait(3500); // let the "Connected to Home-WiFi" snackbar fade
    await shot("09b-fresh-install-ready.png");

    await holdNext("usb-root");
    await page.click("#wizardInstallMelodiousBtn");
    await page.waitForSelector('[data-install-step="2"].is-active', { timeout: 10000 });
    await shot("10b-fresh-installing.png");
    await release();
    await page.waitForSelector("#wizardStep4DoneCard", { timeout: 15000 });
    await page.waitForSelector("#wizardStep3ConnectedCard .setup-pill.is-done", { timeout: 15000 });
    await wait(3500); // let the "Melodious installed" snackbar fade
    await shot("11-done-ready.png");

    // --- Hand-off to the hub's own UI ---
    await page.click("#wizardOpenHubBtn");
    await page.waitForSelector("#view-remote:not([hidden])", { timeout: 15000 });
    await page.evaluate(() => { location.hash = "#devices"; });
    await page.waitForSelector("[data-act='add-device']", { timeout: 15000 });
    await page.click("[data-act='add-device']");
    await page.waitForSelector("dialog[open]", { timeout: 10000 });
    await wait(600);
    await shot("12-hub-add-device.png");
    await page.keyboard.press("Escape");
    await page.evaluate(() => { location.hash = "#remotes"; });
    await page.waitForSelector("[data-act='pair']", { timeout: 15000 });
    await wait(600);
    // Crop above the per-remote notices, which name the sim fixture's activities.
    await shot("13-hub-pair-remote.png", undefined, { x: 0, y: 0, width: VIEWPORT.width, height: 680 });
  } catch (err) {
    const page = app && (await app.firstWindow().catch(() => null));
    if (page) {
      const failShot = path.join(os.tmpdir(), "melodious-oob-failure.png");
      await page.screenshot({ path: failShot }).catch(() => {});
      console.error(`failure screenshot: ${failShot}`);
    }
    throw err;
  } finally {
    if (app) await app.close().catch(() => {});
    simProc.kill();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
