import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  CHECK_INTERVAL_MS,
  RELEASES_URL,
  compareVersions,
  createUpdateChecker,
  createUpdateStore,
  fetchHubVersion,
  hubUpdateNote,
  isGitHubUrl,
  latestHubRelease,
  latestAppRelease,
  latestMacRelease,
} = require("../src/updates.js");

const REPO_URL = "https://github.com/schlambos/harmony-hub-control";

function release(tag, assets, extra = {}) {
  return {
    tag_name: tag,
    draft: false,
    prerelease: false,
    html_url: `${REPO_URL}/releases/tag/${tag}`,
    published_at: "2026-10-28T00:00:00Z",
    assets: assets.map((name) => ({
      name,
      browser_download_url: `${REPO_URL}/releases/download/${tag}/${name}`,
    })),
    ...extra,
  };
}

function fullRelease(v) {
  return release(`v${v}`, [
    `melodious-hub-${v}.zip`,
    `melodious-${v}.apk`,
    `Melodious-${v}-arm64.zip`,
    `Melodious-${v}-x64.zip`,
    "SHA256SUMS.txt",
  ]);
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "melodious-updates-test-"));
}

function fakeResponse(status, body, headers = {}) {
  const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (k) => h.get(k.toLowerCase()) ?? null },
    json: async () => body,
  };
}

test("versions compare numerically", () => {
  assert.ok(compareVersions("1.10.0", "1.9.9") > 0);
  assert.equal(compareVersions("1.2.0", "1.2.0"), 0);
  assert.ok(compareVersions("1.2.0", "1.3.0") < 0);
  assert.throws(() => compareVersions("1.2", "1.2.0"));
});

test("only HTTPS GitHub URLs inside this repository count", () => {
  assert.ok(isGitHubUrl(`${REPO_URL}/releases/tag/v1.3.0`));
  assert.ok(isGitHubUrl("https://api.github.com/repos/schlambos/harmony-hub-control/releases"));
  assert.ok(isGitHubUrl("https://release-assets.githubusercontent.com/x/y"));
  assert.ok(!isGitHubUrl("http://github.com/schlambos/harmony-hub-control/releases"));
  assert.ok(!isGitHubUrl("https://github.com/someone-else/harmony-hub-control/releases"));
  assert.ok(!isGitHubUrl("https://github.com.evil.example/schlambos/harmony-hub-control/"));
  assert.ok(!isGitHubUrl("https://user:pw@github.com/schlambos/harmony-hub-control/"));
  assert.ok(!isGitHubUrl("not a url"));
});

test("the Mac picks the newest v* or desktop-v* release with its arch, ignoring drafts and prereleases", () => {
  const releases = [
    release("v1.4.0", ["Melodious-1.4.0-arm64.zip"], { prerelease: true }),
    release("v1.5.0", ["Melodious-1.5.0-arm64.zip"], { draft: true }),
    release("desktop-v1.3.1", ["Melodious-1.3.1-arm64.zip"]),
    fullRelease("1.3.0"),
    fullRelease("1.2.0"),
  ];
  assert.equal(latestMacRelease(releases, "arm64").version, "1.3.1");
  assert.equal(latestMacRelease(releases, "x64").version, "1.3.0");
  assert.equal(latestHubRelease(releases).version, "1.3.0", "desktop-v releases carry no hub");
});

test("Windows picks the newest release with its installer, never the Mac zip", () => {
  const releases = [
    release("desktop-v1.4.0", ["Melodious-1.4.0-x64.zip", "Melodious-1.4.0-arm64.zip"]),
    release("desktop-v1.3.1", ["Melodious-1.3.1-x64.zip", "Melodious-1.3.1-win-x64-setup.exe"]),
  ];
  assert.equal(latestAppRelease(releases, "x64", "win32").version, "1.3.1");
  assert.equal(latestAppRelease(releases, "x64", "darwin").version, "1.4.0");
  assert.equal(latestAppRelease(releases, "arm64", "win32"), null);
});

test("releases whose links leave the repository are ignored", () => {
  const evil = release("v9.0.0", ["Melodious-9.0.0-arm64.zip", "melodious-hub-9.0.0.zip"], {
    html_url: "https://github.com/someone-else/harmony-hub-control/releases/tag/v9.0.0",
  });
  const evilAsset = fullRelease("8.0.0");
  evilAsset.assets[0].browser_download_url = "https://downloads.evil.example/melodious-hub-8.0.0.zip";
  const releases = [evil, evilAsset, fullRelease("1.3.0")];
  assert.equal(latestMacRelease(releases, "arm64").version, "8.0.0", "8.0.0's Mac zip is still on GitHub");
  assert.equal(latestHubRelease(releases).version, "1.3.0");
});

test("hub note: older hub, legacy hub, current hub, unknown", () => {
  const latest = { version: "1.3.0" };
  assert.match(hubUpdateNote({ version: "1.2.5" }, latest), /runs Melodious 1\.2\.5\. Hub 1\.3\.0 is out/);
  assert.match(hubUpdateNote({ legacy: true }, latest), /1\.2 or older/);
  assert.equal(hubUpdateNote({ version: "1.3.0" }, latest), "");
  assert.equal(hubUpdateNote(null, latest), "");
  assert.equal(hubUpdateNote({ version: "1.3.0" }, null), "");
});

test("checker: one GitHub call, saves picks, reuses them on 304, and is due again after a day", async () => {
  const dir = tmpDir();
  let clock = 1_800_000_000_000;
  const calls = [];
  const responses = [
    fakeResponse(200, [fullRelease("1.3.0"), fullRelease("1.2.0")], { etag: 'W/"abc"' }),
    fakeResponse(304, null),
  ];
  const store = createUpdateStore({ dir });
  const checker = createUpdateChecker({
    store,
    appVersion: "1.2.0",
    arch: "arm64",
    platform: "darwin",
    now: () => clock,
    fetchImpl: async (url, opts) => {
      calls.push({ url, headers: opts.headers });
      return responses.shift();
    },
    getHubVersion: async () => ({ legacy: true }),
  });

  assert.equal(checker.isDue(), false, "never checks before the user says yes");
  checker.setEnabled(true);
  assert.equal(checker.isDue(), true);

  const first = await checker.check();
  assert.equal(calls[0].url, RELEASES_URL);
  assert.match(calls[0].headers["User-Agent"], /^Melodious\/1\.2\.0/);
  assert.equal(calls[0].headers["If-None-Match"], undefined);
  assert.equal(first.state, "checked");
  assert.equal(first.app.version, "1.3.0");
  assert.match(first.hubNote, /1\.2 or older/);
  assert.equal(checker.isDue(), false);

  clock += CHECK_INTERVAL_MS;
  assert.equal(checker.isDue(), true);
  const second = await checker.check();
  assert.equal(calls[1].headers["If-None-Match"], 'W/"abc"');
  assert.equal(second.app.version, "1.3.0", "304 keeps the saved pick");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("checker: up to date, rate limited, offline", async () => {
  const dir = tmpDir();
  const store = createUpdateStore({ dir });
  store.write({ checks: true });
  const make = (fetchImpl) => createUpdateChecker({ store, appVersion: "1.3.0", arch: "arm64", platform: "darwin", fetchImpl });

  const current = await make(async () => fakeResponse(200, [fullRelease("1.3.0")])).check();
  assert.equal(current.app, null);

  const limited = await make(async () =>
    fakeResponse(403, {}, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1900000000" })).check();
  assert.equal(limited.state, "rate-limited");
  assert.equal(limited.until, 1_900_000_000_000);

  const offline = await make(async () => { throw new Error("ENOTFOUND"); }).check();
  assert.equal(offline.state, "error");
  assert.match(offline.error, /Couldn't reach GitHub/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("store: the user's choice and the dismissed version survive a restart", () => {
  const dir = tmpDir();
  createUpdateStore({ dir }).write({ checks: false, dismissed: "1.3.0" });
  const again = createUpdateStore({ dir }).read();
  assert.equal(again.checks, false);
  assert.equal(again.dismissed, "1.3.0");
  fs.writeFileSync(path.join(dir, "updates.json"), "{broken");
  assert.equal(createUpdateStore({ dir }).read().checks, null, "a broken file means: ask again");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("hub version: 200, 404 (older hub) and no hub", async () => {
  let reply = { status: 200, body: '{"ok":true,"version":"1.3.0"}' };
  let seenAuth = null;
  const server = http.createServer((req, res) => {
    seenAuth = req.headers.authorization ?? null;
    assert.equal(req.url, "/api/version");
    res.writeHead(reply.status, { "Content-Type": "application/json" });
    res.end(reply.body);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  try {
    assert.deepEqual(await fetchHubVersion({ host: "127.0.0.1", port, authHeader: "Basic eDp5" }), { version: "1.3.0" });
    assert.equal(seenAuth, "Basic eDp5");
    reply = { status: 404, body: '{"ok":false}' };
    assert.deepEqual(await fetchHubVersion({ host: "127.0.0.1", port }), { legacy: true });
    reply = { status: 401, body: "" };
    assert.equal(await fetchHubVersion({ host: "127.0.0.1", port }), null);
  } finally {
    server.close();
  }
  assert.equal(await fetchHubVersion({ host: "" }), null);
});
