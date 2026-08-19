import { chromium } from "playwright";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
// resolve playwright from NODE_PATH-style
let chromiumLauncher;
try {
  ({ chromium: chromiumLauncher } = await import("playwright"));
} catch {
  ({ chromium: chromiumLauncher } = await import("/Users/matt/Repos/democracy-manifest/node_modules/playwright/index.mjs"));
}

const BASE = "http://127.0.0.1:8787";
const results = {};

function classify(url) {
  try {
    const u = new URL(url);
    const p = u.pathname;
    if (p.startsWith("/api/")) return `API ${p}`;
    if (p.startsWith("/sim/")) return `SIM ${p}`;
    if (p.startsWith("/assets/")) return `ASSET ${p}`;
    if (p.endsWith(".js")) return `JS ${p}`;
    if (p.endsWith(".css")) return `CSS ${p}`;
    if (p.endsWith(".jpg") || p.endsWith(".png") || p.endsWith(".woff2")) return `MEDIA ${p}`;
    if (p === "/" || p.endsWith(".html")) return `HTML ${p}`;
    if (u.host.includes("fonts.google") || u.host.includes("fonts.gstatic")) return `FONT ${p.split("/").pop()}`;
    return `${u.host}${p}`;
  } catch {
    return url;
  }
}

async function freshContext(browser) {
  return browser.newContext({
    viewport: { width: 1280, height: 800 },
    bypassCSP: true,
    // disable cache
    serviceWorkers: "block",
  });
}

async function censusRoute(browser, name, hash, actions = async () => {}) {
  const context = await freshContext(browser);
  await context.route("**/*", (route) => route.continue());
  const page = await context.newPage();
  const reqs = [];
  page.on("request", (req) => {
    reqs.push({
      method: req.method(),
      url: req.url(),
      resourceType: req.resourceType(),
      postData: req.postData()?.length || 0,
    });
  });
  const resps = [];
  page.on("response", async (res) => {
    let size = 0;
    try {
      const buf = await res.body();
      size = buf.length;
    } catch {}
    resps.push({
      url: res.url(),
      status: res.status(),
      size,
      fromCache: res.fromServiceWorker(),
    });
  });

  const fresh = Date.now();
  await page.goto(`${BASE}/?fresh=${fresh}${hash}`, {
    waitUntil: "networkidle",
    timeout: 60000,
  });
  // settle
  await page.waitForTimeout(800);

  const afterLoad = reqs.length;
  const afterLoadResps = [...resps];

  await actions(page, context);

  // allow action traffic to finish
  await page.waitForTimeout(1200);

  const summary = summarize(reqs, resps);
  results[name] = {
    ...summary,
    afterLoadCount: afterLoad,
    totalCount: reqs.length,
    actionCount: reqs.length - afterLoad,
    requests: reqs.map((r) => ({
      method: r.method,
      class: classify(r.url),
      type: r.resourceType,
      postBytes: r.postData,
    })),
    responses: resps.map((r) => ({
      class: classify(r.url),
      status: r.status,
      size: r.size,
    })),
  };

  await context.close();
}

function summarize(reqs, resps) {
  const byClass = {};
  for (const r of reqs) {
    const c = classify(r.url);
    byClass[c] = byClass[c] || { count: 0, methods: {} };
    byClass[c].count++;
    byClass[c].methods[r.method] = (byClass[c].methods[r.method] || 0) + 1;
  }
  let bytesIn = 0;
  const api = [];
  for (const r of resps) {
    bytesIn += r.size;
    const c = classify(r.url);
    if (c.startsWith("API") || c.startsWith("SIM")) {
      api.push({ class: c, status: r.status, size: r.size });
    }
  }
  const forks = reqs.filter((r) => {
    try {
      const u = new URL(r.url);
      return u.port === "8787" || u.hostname === "127.0.0.1";
    } catch {
      return false;
    }
  }).length;
  // hub-bound = same origin non-font
  const hubReqs = reqs.filter((r) => r.url.startsWith(BASE));
  const hubApi = hubReqs.filter((r) => r.url.includes("/api/"));
  return {
    byClass,
    bytesIn,
    hubRequestCount: hubReqs.length,
    hubApiCount: hubApi.length,
    externalCount: reqs.length - hubReqs.length,
    apiResponses: api,
  };
}

async function steadyState(browser) {
  const context = await freshContext(browser);
  const page = await context.newPage();
  const reqs = [];
  page.on("request", (req) => {
    if (req.url().startsWith(BASE)) {
      reqs.push({ t: Date.now(), method: req.method(), url: req.url() });
    }
  });
  const fresh = Date.now();
  await page.goto(`${BASE}/?fresh=${fresh}#control`, {
    waitUntil: "networkidle",
    timeout: 60000,
  });
  await page.waitForTimeout(1500);
  const baseline = reqs.length;
  const t0 = Date.now();
  // 2 minutes
  await page.waitForTimeout(120000);
  const during = reqs.slice(baseline);
  results.steadyState_2min = {
    baselineHubReqs: baseline,
    backgroundHubReqs: during.length,
    background: during.map((r) => ({
      dtMs: r.t - t0,
      method: r.method,
      class: classify(r.url),
    })),
  };
  await context.close();
}

const browser = await chromiumLauncher.launch({ headless: true });

// Cold loads
await censusRoute(browser, "cold_control", "#control");
await censusRoute(browser, "cold_activities", "#activities");
await censusRoute(browser, "cold_wizard", "#wizard");
await censusRoute(browser, "cold_home", "#home");
await censusRoute(browser, "cold_editor", "#editor");

// Actions on control
await censusRoute(browser, "action_run", "#control", async (page) => {
  // click first Run button if present
  const run = page.locator('button:has-text("Run"), [data-act="run"]').first();
  if (await run.count()) {
    await run.click({ timeout: 5000 }).catch(() => {});
  } else {
    // try activity card run
    const alt = page.locator("button").filter({ hasText: /Run/i }).first();
    if (await alt.count()) await alt.click().catch(() => {});
  }
});

await censusRoute(browser, "action_keypress", "#control", async (page) => {
  // click a remote hotspot
  const hot = page.locator(".hotspot, [data-button-key], [data-key]").first();
  if (await hot.count()) {
    await hot.click({ timeout: 5000 }).catch(async () => {
      // force click center of remote
      const remote = page.locator(".remote-skin, img[data-remote-skin], .remote").first();
      if (await remote.count()) {
        const box = await remote.boundingBox();
        if (box) await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.35);
      }
    });
  } else {
    const remote = page.locator("img").first();
    const box = await remote.boundingBox();
    if (box) await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.3);
  }
});

await censusRoute(browser, "action_save_reorder", "#activities", async (page) => {
  // try reorder if buttons exist - may trigger save
  const up = page.locator('button:has-text("↑"), [data-act="up"], button[aria-label*="up" i]').first();
  if (await up.count()) {
    await up.click().catch(() => {});
  }
});

// Steady state 2 min
await steadyState(browser);

await browser.close();

// Write report
import { writeFileSync } from "fs";
writeFileSync(
  "tools/hub-emu/build/footprint-trial/request-census.json",
  JSON.stringify(results, null, 2)
);

// Print concise
for (const [k, v] of Object.entries(results)) {
  if (k.startsWith("steady")) {
    console.log(`\n=== ${k} ===`);
    console.log(JSON.stringify(v, null, 2));
    continue;
  }
  console.log(`\n=== ${k} ===`);
  console.log(`hubReqs=${v.hubRequestCount} hubApi=${v.hubApiCount} external=${v.externalCount} bytesIn=${v.bytesIn} afterLoad=${v.afterLoadCount} actionExtra=${v.actionCount}`);
  const entries = Object.entries(v.byClass).sort((a, b) => b[1].count - a[1].count);
  for (const [c, info] of entries) {
    console.log(`  ${info.count}x ${c} ${JSON.stringify(info.methods)}`);
  }
  if (v.apiResponses?.length) {
    console.log("  API responses:");
    for (const a of v.apiResponses) console.log(`    ${a.class} ${a.status} ${a.size}b`);
  }
}
