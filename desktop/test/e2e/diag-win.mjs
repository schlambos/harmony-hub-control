// TEMPORARY spike diagnostics: what the source app shows on first launch.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { _electron: electron } = require("playwright");
const DESKTOP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "melodious-diag-"));
const t0 = Date.now();
const log = (...a) => console.log(`[${Date.now() - t0}ms]`, ...a);
const app = await electron.launch({ args: [DESKTOP_DIR], env: { ...process.env, MELODIOUS_E2E: "1", MELODIOUS_USER_DATA_DIR: userDataDir } });
app.process().stderr.on("data", (d) => log("main stderr:", String(d).trim()));
app.process().stdout.on("data", (d) => log("main stdout:", String(d).trim()));
log("launched");
const page = await app.firstWindow();
log("first window", page.url());
page.on("console", (m) => log("console", m.type(), m.text()));
page.on("pageerror", (e) => log("pageerror", e.message));
page.on("requestfailed", (r) => log("requestfailed", r.url(), r.failure()?.errorText));
page.on("response", (r) => log("response", r.status(), r.url()));
try {
  await page.waitForSelector("#connectForm", { timeout: 45000 });
  log("connectForm visible");
} catch (e) {
  log("no connectForm:", e.message.split("\n")[0]);
}
log("title", await page.title().catch((e) => e.message), "url", page.url());
log("windows", app.windows().map((w) => w.url()));
log("html", (await page.content().catch((e) => e.message)).slice(0, 1500));
await page.reload().catch((e) => log("reload failed", e.message));
await new Promise((r) => setTimeout(r, 5000));
log("after reload: title", await page.title().catch((e) => e.message));
log("html", (await page.content().catch((e) => e.message)).slice(0, 3000));
await app.close().catch(() => {});
