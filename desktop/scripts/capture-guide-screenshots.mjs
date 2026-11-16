#!/usr/bin/env node
// Documentation only: fresh loopback simulator, no discovery, USB, or real hub.
// Run from desktop/: node scripts/capture-guide-screenshots.mjs
// Requires the usual desktop devDependencies and `npm run bundle:shell`.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, _electron as electron } from "playwright";

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repo = path.dirname(desktop);
const out = path.join(repo, "docs/screenshots/guides");
// Reserve an unused loopback port first, so an occupied SIM_PORT fails closed
// instead of seeding some other simulator that happens to be listening there.
const probe = net.createServer();
await new Promise((resolve, reject) => {
  probe.once("error", reject);
  probe.listen(Number(process.env.SIM_PORT || 0), "127.0.0.1", resolve);
});
const port = probe.address().port;
await new Promise((resolve) => probe.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const viewport = { width: 1280, height: 840 };
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "melodious-guide-shots-"));
const sim = spawn(process.execPath, [path.join(repo, "tools/webui-sim/server.mjs")], {
  env: { ...process.env, PORT: String(port) }, stdio: "ignore",
});
let browser, app;

async function api(route, body) {
  const response = await fetch(origin + route, body === undefined ? {} : {
    method: "POST", headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify(body),
  });
  assert.ok(response.ok, `${route}: ${response.status}${response.ok ? "" : ` ${await response.text()}`}`);
  return response.json();
}

// Only fixture display data is changed, through the simulator's normal APIs.
// No checked-in fixture or shipped app code is edited to get these pictures.
async function cleanFixture() {
  const config = await api("/api/activity-config");
  const specs = [
    ["Streaming Box", "Example", "Streamer", "Media Player"],
    ["Living Room TV", "LG", "Example TV", "Television"],
    ["Marantz AVR", "Marantz", "Example AVR", "Amplifier"],
    ["Spare Player", "Example", "Player", "Media Player"],
  ];
  for (const [i, entry] of config.deviceList.DevicesWithFeatures.entries()) {
    const [name, manufacturer, model, type] = specs[i];
    const response = await fetch(origin + "/ir/device", {
      method: "POST", body: new URLSearchParams({ deviceId: String(entry.Device["Id-"]), name, manufacturer, model, type }),
    });
    assert.ok(response.ok);
  }
  const latest = await api("/api/activity-config");
  const names = ["Watch TV", "Play a game", "Listen to music"];
  latest.activityList.Activities.forEach((a, i) => {
    if (String(a["Id-"]) !== "-1") a.Name = names[i % names.length];
  });
  // Activity labels may live in DisplayName and root shortcut labels too.
  const clean = (value) => {
    if (typeof value === "string") return value.replaceAll("Heather's PC", "Play a game").replaceAll("Matt's PC", "Listen to music");
    if (Array.isArray(value)) return value.map(clean);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clean(v)]));
    return value;
  };
  await api("/api/activity-save", { baseRevision: latest.revision, activityList: clean(latest.activityList), mapList: clean(latest.mapList), functionList: clean(latest.functionList) });
  return api("/api/activity-config");
}

async function shot(page, name, clip) {
  await page.mouse.move(1278, 838);
  await page.evaluate(() => document.activeElement?.blur());
  // Allow the actual sheet/route transition to settle; never hide warnings.
  await page.waitForTimeout(350);
  const text = await page.locator("body").innerText();
  assert.doesNotMatch(text, /Heather|Matt's|192\.168\.(?:0|86)\.|[\w.+-]+@[\w.-]+\.[a-z]{2,}/i);
  await page.screenshot({ path: path.join(out, `${name}.png`), clip });
  console.log(`captured ${name}.png`);
}

try {
  fs.mkdirSync(out, { recursive: true });
  for (let i = 0; ; i++) {
    if (sim.exitCode !== null) throw new Error("Simulator exited (port already in use?)");
    try { await api("/api/system-status"); break; } catch (error) {
      if (i > 100) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  const config = await cleanFixture();
  const entries = config.deviceList.DevicesWithFeatures;
  const tv = String(entries[1].Device["Id-"]);
  const avr = String(entries[2].Device["Id-"]);
  const player = String(entries[0].Device["Id-"]);
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport, colorScheme: "dark" });
  page.setDefaultTimeout(10000);
  page.on("dialog", (dialog) => dialog.accept());
  // Browser-side IRDB and other external fetches are forbidden in this run.
  await page.route("**/*", (route) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  let navigation = 0;
  const go = async (hash, selector) => {
    // A new query forces a document navigation, not the SPA's dirty-route guard.
    await page.goto(`${origin}/?guide=${++navigation}#${hash}`);
    await page.locator(selector).first().waitFor();
  };
  const commands = async () => {
    await go(`devices/${tv}`, '[role="tab"]');
    await page.getByRole("tab", { name: /^Commands/ }).click();
  };
  await go("devices", '[data-act="add-device"]');
  await page.getByRole("button", { name: "Add a device", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("Living Room TV");
  await shot(page, "add-device-1280");
  await page.keyboard.press("Escape");
  await commands();
  await shot(page, "device-commands-1280");
  await page.getByRole("tab", { name: "Remote", exact: true }).click();
  await shot(page, "device-remote-1280");
  await page.getByRole("tab", { name: /^Commands/ }).click();
  await page.getByRole("button", { name: "Import codes", exact: true }).click();
  await shot(page, "import-find-1280");
  await page.getByRole("tab", { name: "Paste", exact: true }).click();
  await shot(page, "import-paste-1280");
  await page.getByRole("tab", { name: "Type a code", exact: true }).click();
  await page.getByLabel("Command name", { exact: true }).fill("PowerToggle");
  await page.getByRole("button", { name: "NEC", exact: true }).click();
  await shot(page, "import-type-1280");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Learn a button", exact: true }).click();
  await shot(page, "learn-1280");
  await api("/api/sim/capture-next", {});
  await page.getByRole("button", { name: "Start listening", exact: true }).click();
  await page.getByRole("button", { name: "Test", exact: true }).waitFor();
  await shot(page, "learn-test-1280");
  await page.keyboard.press("Escape");
  await go(`devices/${tv}/settings`, '[data-radio="power"]');
  await shot(page, "device-power-1280");
  await page.getByText("Inputs, in the device's order", { exact: true }).scrollIntoViewIfNeeded();
  await shot(page, "device-inputs-1280");
  await page.locator('[data-radio="inputs"][value="cycle"]').check();
  await page.locator('[data-pick="afterPowerOn"]').scrollIntoViewIfNeeded();
  await shot(page, "device-cycle-timing-1280");
  // Full navigation discards only this browser's unsaved draft.
  await go(`devices/${tv}/sweep`, '[data-act="dry"]');
  await page.getByRole("button", { name: "Dry run", exact: true }).click();
  await page.getByText(/Dry run done/).first().waitFor();
  await shot(page, "send-all-1280");
  await go("devices/lab", '[data-act="lab-target"]');
  await shot(page, "ir-lab-1280");

  await go("wizard", "#wizName");
  await page.locator("#wizName").fill("Watch a movie");
  await page.getByText("Watch a movie", { exact: true }).click();
  await shot(page, "wizard-name-1280");
  await page.getByRole("button", { name: "Next: devices", exact: true }).click();
  await page.getByRole("button", { name: "Add another job", exact: true }).click();
  await page.locator('[data-pick-job="PlayMovieActivityRole"]').click();
  await page.locator(`[data-pick-device="${player}"]`).click();
  await shot(page, "wizard-devices-1280");
  await page.getByRole("button", { name: "Next: inputs", exact: true }).click();
  await page.locator(`[data-input-device="${tv}"][data-input="HDMI 2"]`).click();
  await page.locator(`[data-input-device="${avr}"][data-input="HDMI 2"]`).click();
  await shot(page, "wizard-inputs-1280");
  await page.getByRole("button", { name: "Next: buttons", exact: true }).click();
  await shot(page, "wizard-buttons-1280");
  await page.locator('[data-key="Guide"]').click();
  await page.locator(`[data-pick-device="${tv}"]`).click();
  await page.locator(".pick-row").filter({ hasText: /^Guide$/ }).click();
  await page.locator('[data-key="Guide"]').click();
  await page.getByRole("tab", { name: "Hold", exact: true }).click();
  await page.locator(`[data-pick-device="${player}"]`).click();
  await page.getByRole("searchbox", { name: "Search commands", exact: true }).fill("Home");
  await shot(page, "wizard-hold-1280");
  await page.locator(".pick-row").filter({ hasText: /^Home$/ }).click();
  await page.getByRole("button", { name: "Next: review", exact: true }).click();
  await shot(page, "wizard-review-1280");
  await page.getByRole("button", { name: "Save activity", exact: true }).click();
  await page.waitForURL(/#activities$/);
  const saved = await api("/api/activity-config");
  const activity = String(saved.activityList.Activities.find((a) => a.Name === "Watch a movie")["Id-"]);
  await go(`touch/${activity}`, "#touchRoot .seg-tabs");
  await shot(page, "onscreen-buttons-1280");
  await page.getByRole("tab", { name: /^Gestures/ }).click();
  await shot(page, "gestures-1280");
  await go("homebuttons/screen", "#homeButtonsRoot");
  await shot(page, "home-control-1280");
  await page.locator('#homeButtonsRoot [data-key="HomeControl1"]').click();
  await shot(page, "home-control-picker-1280");
  await page.keyboard.press("Escape");
  // The stock demo contains older activities whose devices are absent. Keep
  // only the new, complete activity for the advanced walkthrough; otherwise
  // its whole-graph validator correctly refuses those unrelated demo roles.
  const advancedConfig = await api("/api/activity-config");
  advancedConfig.activityList.Activities = advancedConfig.activityList.Activities.filter((a) => String(a["Id-"]) === activity);
  advancedConfig.mapList.ButtonMaps = advancedConfig.mapList.ButtonMaps.filter((m) => {
    const identifier = String(m.ButtonMapIdentifier || "");
    return identifier.endsWith("Root") || identifier.endsWith(`Activity${activity}`);
  });
  await api("/api/activity-save", {
    baseRevision: advancedConfig.revision, activityList: advancedConfig.activityList,
    mapList: advancedConfig.mapList, functionList: { FunctionMaps: [] },
  });
  await go("editor", "[data-activity-select]");
  await page.locator(`[data-activity-select="${activity}"]`).click();
  // The legacy fixture needs the editor's normal reconciliation once. Save
  // that simulated working copy instead of hiding its genuine repair notice.
  await page.locator("#activitySave").click();
  await page.locator("#activitySave:not([disabled])").waitFor();
  const advancedNotice = await page.locator("#activityNotice").innerText();
  assert.match(advancedNotice, /The Hub persisted/, advancedNotice);
  await page.locator("#activityRoleList").evaluate((el) => el.scrollIntoView({ block: "start" }));
  await page.evaluate(() => window.scrollBy(0, -70));
  await shot(page, "advanced-power-order-1280");
  await page.evaluate(() => window.scrollTo(0, 0));
  await shot(page, "advanced-editor-1280");
  await api("/api/activity-run", { activityId: activity });
  await go("remote", '[data-act="fixit"]');
  await page.locator('[data-act="fixit"]').click();
  await shot(page, "fix-it-1280");

  // Actual Desktop preload/IPC, with synthetic catalog service responses.
  // MELODIOUS_E2E disables network hub discovery; sign-in never opens online.
  const added = await fetch(origin + "/ir/new-device", { method: "POST", body: new URLSearchParams({
    name: "Sony Receiver", manufacturer: "Sony", model: "STR-DG720", type: "Amplifier",
  }) });
  assert.ok(added.ok);
  const catalogDevice = String((await api("/api/activity-config")).deviceList.DevicesWithFeatures.find((e) => e.Device.Name === "Sony Receiver").Device["Id-"]);
  app = await electron.launch({ args: [desktop], env: {
    ...process.env, MELODIOUS_E2E: "1", MELODIOUS_USER_DATA_DIR: temp,
  } });
  await app.evaluate(({ nativeTheme }) => { nativeTheme.themeSource = "dark"; });
  const wire = JSON.parse(fs.readFileSync(path.join(desktop, "test/fixtures/catalog-fixtures.json"), "utf8"));
  await app.evaluate((_electron, fixture) => {
    let signedIn = false;
    globalThis.__melodiousCatalogService = {
      status: async () => ({ signedIn }),
      signIn: async () => { signedIn = true; return { signedIn }; },
      signOut: async () => { signedIn = false; return { signedIn }; },
      checkModel: async () => ({ found: true, model: "STR-DG720" }),
      search: async () => [{ id: 167856, manufacturer: "Sony", model: "STR-DG720", displayText: "Sony STR-DG720", deviceType: "Receiver", description: "Simulated catalog example" }],
      download: async () => ({ schema_version: "0.2.0", source: "logitech-catalog-via-melodious-desktop", resources: { global_language_commands: fixture.getGlobalLanguageCommands.GetGlobalLanguageCommandsResult } }),
    };
  }, wire);
  const window = await app.firstWindow();
  await window.setViewportSize(viewport);
  await window.emulateMedia({ colorScheme: "dark" });
  await window.locator("#wizardUseExistingConnectBtn").click();
  await window.locator("#connectHost").fill("127.0.0.1");
  await window.locator("#connectPort").fill(String(port));
  await window.locator("#connectBtn").click();
  await window.locator("#view-remote:not([hidden])").waitFor();
  await window.evaluate((id) => { location.hash = `#devices/${id}`; }, catalogDevice);
  await window.getByRole("tab", { name: /^Commands/ }).click();
  await window.getByRole("button", { name: "Import codes", exact: true }).click();
  await window.getByRole("tab", { name: "Logitech catalog", exact: true }).click();
  const panel = window.locator('[role="tabpanel"][id$="panel-catalog"]');
  await panel.getByLabel("Brand", { exact: true }).fill("Sony");
  await panel.getByLabel("Model", { exact: true }).fill("STR-DG7");
  await shot(window, "catalog-signin-1280");
  await panel.getByRole("button", { name: "Sign in", exact: true }).click();
  await panel.getByRole("button", { name: "Search Logitech catalog", exact: true }).click();
  // Focus the search capture below the account row. Keep the actual UI copy
  // unchanged, including the app's older platform-specific account hint.
  await panel.getByRole("button", { name: "Download", exact: true }).scrollIntoViewIfNeeded();
  const brandBox = await panel.getByLabel("Brand", { exact: true }).locator("..").boundingBox();
  const dialogBox = await window.locator("dialog[open]").boundingBox();
  const resultsBox = await panel.locator(".import-results").boundingBox();
  const searchTop = Math.floor(brandBox.y - 4);
  await shot(window, "catalog-search-1280", { x: dialogBox.x, y: searchTop, width: dialogBox.width, height: Math.ceil(resultsBox.y + resultsBox.height + 12 - searchTop) });
  await panel.getByRole("button", { name: "Download", exact: true }).click();
  await panel.getByRole("button", { name: /^Import 4 commands/ }).scrollIntoViewIfNeeded();
  await shot(window, "catalog-preview-1280");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await app?.close();
  await browser?.close();
  sim.kill();
  fs.rmSync(temp, { recursive: true, force: true });
}
