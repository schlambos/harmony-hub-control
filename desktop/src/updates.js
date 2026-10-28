"use strict";

// Update notices: once a day (only after the user says yes) ask GitHub for
// this project's releases, and say when a newer Melodious for this Mac or a
// newer hub release exists. Nothing is downloaded or installed here.
//
// Trust is "it came from the owner's GitHub": only HTTPS to this repository's
// release API, and release links only on github.com under this repository.

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const REPO = "schlambos/harmony-hub-control";
const RELEASES_URL = `https://api.github.com/repos/${REPO}/releases?per_page=20`;
const RELEASE_PAGE_PREFIX = `https://github.com/${REPO}/releases/`;
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const UPDATES_FILE = "updates.json";
// Release downloads leave api.github.com for GitHub's own download hosts.
const GITHUB_HOSTS = new Set([
  "api.github.com",
  "github.com",
  "release-assets.githubusercontent.com",
  "objects.githubusercontent.com",
]);

function parseVersion(value) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(value ?? "").trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) throw new Error(`not a version: ${!x ? a : b}`);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

/** True only for HTTPS URLs on GitHub's hosts; github.com and the API must
    also be inside this repository. */
function isGitHubUrl(rawUrl) {
  let u;
  try {
    u = new URL(String(rawUrl ?? ""));
  } catch {
    return false;
  }
  if (u.protocol !== "https:" || u.username || u.password || u.port) return false;
  if (!GITHUB_HOSTS.has(u.hostname)) return false;
  if (u.hostname === "github.com") return u.pathname.startsWith(`/${REPO}/`);
  if (u.hostname === "api.github.com") return u.pathname.startsWith(`/repos/${REPO}/`);
  return true;
}

/**
 * Newest published release whose tag is `<prefix><x.y.z>` for one of the
 * prefixes and which carries the asset `assetFor(version)` names. Drafts and
 * prereleases never count.
 */
function latestRelease(releases, { prefixes, assetFor, allowUrl = isGitHubUrl }) {
  let best = null;
  for (const rel of Array.isArray(releases) ? releases : []) {
    if (!rel || rel.draft || rel.prerelease) continue;
    const tag = String(rel.tag_name ?? "");
    const prefix = prefixes.find((p) => tag.startsWith(p));
    if (prefix === undefined) continue;
    const version = tag.slice(prefix.length);
    if (!parseVersion(version)) continue;
    const assets = {};
    for (const a of rel.assets ?? []) {
      if (a && typeof a.name === "string" && allowUrl(a.browser_download_url)) assets[a.name] = a.browser_download_url;
    }
    if (!assets[assetFor(version)]) continue;
    const url = String(rel.html_url ?? "");
    if (!url.startsWith(RELEASE_PAGE_PREFIX) || !isGitHubUrl(url)) continue;
    if (best && compareVersions(version, best.version) <= 0) continue;
    best = { version, tag, url, publishedAt: String(rel.published_at ?? ""), assets };
  }
  return best;
}

/** The Mac app's newest release: a full `v*` release or a Mac-only `desktop-v*`. */
function latestMacRelease(releases, arch, allowUrl = isGitHubUrl) {
  return latestRelease(releases, {
    prefixes: ["desktop-v", "v"],
    assetFor: (v) => `Melodious-${v}-${arch}.zip`,
    allowUrl,
  });
}

/** The hub's newest release: only full `v*` releases carry the hub zip. */
function latestHubRelease(releases, allowUrl = isGitHubUrl) {
  return latestRelease(releases, {
    prefixes: ["v"],
    assetFor: (v) => `melodious-hub-${v}.zip`,
    allowUrl,
  });
}

/** One line about the hub, or "" when there is nothing to say. `hub` is
    { version } from GET /api/version, { legacy: true } for a hub that answers
    404 there (1.2.x or older), or null when unknown. */
function hubUpdateNote(hub, latestHub) {
  if (!hub || !latestHub) return "";
  if (hub.legacy) {
    return `Your hub runs Melodious 1.2 or older. Hub ${latestHub.version} is out; update it with the installer from the release page.`;
  }
  if (parseVersion(hub.version) && compareVersions(latestHub.version, hub.version) > 0) {
    return `Your hub runs Melodious ${hub.version}. Hub ${latestHub.version} is out; update it with the installer from the release page.`;
  }
  return "";
}

function createUpdateStore({ dir }) {
  const file = path.join(dir, UPDATES_FILE);
  const empty = () => ({
    checks: null,
    lastCheckedAt: 0,
    etag: "",
    latestApp: null,
    latestHub: null,
    dismissed: "",
    dismissedHub: "",
  });
  function read() {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!parsed || typeof parsed !== "object") return empty();
      return {
        ...empty(),
        checks: typeof parsed.checks === "boolean" ? parsed.checks : null,
        lastCheckedAt: Number(parsed.lastCheckedAt) || 0,
        etag: typeof parsed.etag === "string" ? parsed.etag : "",
        latestApp: parsed.latestApp && typeof parsed.latestApp === "object" ? parsed.latestApp : null,
        latestHub: parsed.latestHub && typeof parsed.latestHub === "object" ? parsed.latestHub : null,
        dismissed: typeof parsed.dismissed === "string" ? parsed.dismissed : "",
        dismissedHub: typeof parsed.dismissedHub === "string" ? parsed.dismissedHub : "",
      };
    } catch {
      return empty();
    }
  }
  function write(patch) {
    const next = { ...read(), ...patch };
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, file);
    return next;
  }
  return { read, write };
}

/** GET /api/version from the hub: { version } or { legacy: true } on 404;
    null when the hub can't be asked. */
function fetchHubVersion({ host, port, authHeader = null, timeoutMs = 5000, request = http.request }) {
  return new Promise((resolve) => {
    if (!host) return resolve(null);
    const headers = { Accept: "application/json" };
    if (authHeader) headers.Authorization = authHeader;
    const req = request({ host, port, path: "/api/version", method: "GET", headers, timeout: timeoutMs }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        if (body.length < 16384) body += chunk;
      });
      res.on("end", () => {
        if (res.statusCode === 404) return resolve({ legacy: true });
        if (res.statusCode !== 200) return resolve(null);
        try {
          const json = JSON.parse(body);
          resolve(parseVersion(json?.version) ? { version: json.version } : null);
        } catch {
          resolve(null);
        }
      });
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(null));
    req.end();
  });
}

function createUpdateChecker({
  store,
  appVersion,
  arch,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  getHubVersion = async () => null,
  releasesUrl = RELEASES_URL,
  allowUrl = isGitHubUrl,
}) {
  let checking = null;

  function isDue() {
    const s = store.read();
    return s.checks === true && now() - s.lastCheckedAt >= CHECK_INTERVAL_MS;
  }

  function summarize(s, hub, extra = {}) {
    const app = s.latestApp && parseVersion(s.latestApp.version) && compareVersions(s.latestApp.version, appVersion) > 0
      ? s.latestApp
      : null;
    return {
      checks: s.checks,
      lastCheckedAt: s.lastCheckedAt,
      appVersion,
      app,
      latestHub: s.latestHub,
      hub,
      hubNote: hubUpdateNote(hub, s.latestHub),
      dismissed: s.dismissed,
      ...extra,
    };
  }

  async function runCheck() {
    const before = store.read();
    const headers = {
      Accept: "application/vnd.github+json",
      "User-Agent": `Melodious/${appVersion} (macOS)`,
    };
    // A 304 reuses the release picks saved with this ETag.
    if (before.etag && before.lastCheckedAt) headers["If-None-Match"] = before.etag;
    const hub = await getHubVersion();
    let res;
    try {
      res = await fetchImpl(releasesUrl, { headers, redirect: "error" });
    } catch (err) {
      return summarize(before, hub, { state: "error", error: "Couldn't reach GitHub." });
    }
    if (res.status === 304) {
      const s = store.write({ lastCheckedAt: now() });
      return summarize(s, hub, { state: "checked" });
    }
    if (res.status === 403 || res.status === 429) {
      const reset = Number(res.headers.get("x-ratelimit-reset")) * 1000;
      const retry = Number(res.headers.get("retry-after")) * 1000;
      const until = reset > 0 ? reset : now() + (retry > 0 ? retry : 60 * 60 * 1000);
      return summarize(before, hub, { state: "rate-limited", until });
    }
    if (!res.ok) {
      return summarize(before, hub, { state: "error", error: `GitHub answered ${res.status}.` });
    }
    let releases;
    try {
      releases = await res.json();
    } catch {
      return summarize(before, hub, { state: "error", error: "GitHub sent something that isn't a release list." });
    }
    const s = store.write({
      lastCheckedAt: now(),
      etag: res.headers.get("etag") || "",
      latestApp: latestMacRelease(releases, arch, allowUrl),
      latestHub: latestHubRelease(releases, allowUrl),
    });
    return summarize(s, hub, { state: "checked" });
  }

  return {
    isDue,
    status: async () => summarize(store.read(), await getHubVersion(), { state: "idle" }),
    setEnabled(enabled) {
      return store.write({ checks: Boolean(enabled) });
    },
    dismiss(version) {
      store.write({ dismissed: String(version ?? "") });
    },
    /** One check at a time; a second caller shares the first one's result. */
    check() {
      if (!checking) checking = runCheck().finally(() => { checking = null; });
      return checking;
    },
  };
}

module.exports = {
  CHECK_INTERVAL_MS,
  RELEASES_URL,
  compareVersions,
  createUpdateChecker,
  createUpdateStore,
  fetchHubVersion,
  hubUpdateNote,
  isGitHubUrl,
  latestHubRelease,
  latestMacRelease,
  parseVersion,
};
