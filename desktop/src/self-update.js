"use strict";

// The Mac app replaces itself with a newer release from the owner's GitHub:
// download the zip for this Mac's architecture, check it against the
// release's SHA256SUMS.txt, unpack it next to the running app, check the new
// bundle, swap the two by rename (rolling back on failure), then relaunch.
//
// Every byte comes from GitHub: redirects are followed by hand and each hop
// must be a GitHub URL. The app is ad-hoc signed, so macOS can't vouch for
// the new build; the checksum and GitHub are the trust. A self-downloaded
// file carries no quarantine flag, so relaunching doesn't trigger Gatekeeper.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { isGitHubUrl } = require("./updates");

const SUMS_NAME = "SHA256SUMS.txt";
const STAGE_PREFIX = ".melodious-update-";
const MAX_REDIRECTS = 5;

class SelfUpdateError extends Error {}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      if (err) reject(new SelfUpdateError(`${path.basename(cmd)} failed: ${String(stderr || err.message).trim()}`));
      else resolve(String(stdout));
    });
  });
}

/** `/…/Melodious.app/Contents/MacOS/Melodious` → `/…/Melodious.app`. */
function bundlePathFromExec(execPath) {
  const parts = String(execPath).split(path.sep);
  const i = parts.lastIndexOf("Contents");
  if (i < 1 || !parts[i - 1].endsWith(".app")) return null;
  return parts.slice(0, i).join(path.sep);
}

/** Why the running app can't replace itself, or null when it can. */
function installLocationProblem(appPath, { packaged = true, access = fs.accessSync } = {}) {
  if (!packaged || !appPath) return "Only an installed Melodious app can update itself.";
  if (appPath.startsWith("/Volumes/")) {
    return "Melodious is running from the disk image. Drag it to Applications, open it from there, then update.";
  }
  if (appPath.includes("/AppTranslocation/")) {
    return "macOS opened Melodious from a temporary location. Move it to Applications with Finder, open it again, then update.";
  }
  try {
    access(path.dirname(appPath), fs.constants.W_OK);
    access(appPath, fs.constants.W_OK);
  } catch {
    return `Your account can't replace apps in ${path.dirname(appPath)}. Download the update from the release page instead.`;
  }
  return null;
}

function parseSums(text) {
  const out = new Map();
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^([0-9a-fA-F]{64}) [ *](\S+)$/.exec(line.trimEnd());
    if (m) out.set(m[2], m[1].toLowerCase());
  }
  return out;
}

/** GET with hand-followed redirects; every URL on the way must be allowed. */
async function openGitHub(url, { fetchImpl, allowUrl, userAgent }) {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!allowUrl(current)) throw new SelfUpdateError(`Refusing to download from outside GitHub: ${current}`);
    let res;
    try {
      res = await fetchImpl(current, { redirect: "manual", headers: { "User-Agent": userAgent } });
    } catch {
      throw new SelfUpdateError("Couldn't reach GitHub.");
    }
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) throw new SelfUpdateError("GitHub redirected without saying where.");
      current = new URL(location, current).toString();
      continue;
    }
    if (!res.ok) throw new SelfUpdateError(`GitHub answered ${res.status} for the download.`);
    return res;
  }
  throw new SelfUpdateError("Too many redirects.");
}

/** Download `name` from the release into `dir`, checked against the release's SHA256SUMS.txt. */
async function downloadVerified({ release, name, dir, fetchImpl = globalThis.fetch, allowUrl = isGitHubUrl, userAgent = "Melodious", onProgress = () => {} }) {
  const sumsUrl = release.assets?.[SUMS_NAME];
  const fileUrl = release.assets?.[name];
  if (!sumsUrl) throw new SelfUpdateError(`Release ${release.version} has no ${SUMS_NAME}, so the download can't be checked.`);
  if (!fileUrl) throw new SelfUpdateError(`Release ${release.version} has no ${name}.`);
  const sumsRes = await openGitHub(sumsUrl, { fetchImpl, allowUrl, userAgent });
  const sumsText = await sumsRes.text();
  if (sumsText.length > 65536) throw new SelfUpdateError(`${SUMS_NAME} is unexpectedly large.`);
  const expected = parseSums(sumsText).get(name);
  if (!expected) throw new SelfUpdateError(`${SUMS_NAME} in release ${release.version} doesn't list ${name}.`);

  const res = await openGitHub(fileUrl, { fetchImpl, allowUrl, userAgent });
  const total = Number(res.headers.get("content-length")) || 0;
  const target = path.join(dir, name);
  const hash = crypto.createHash("sha256");
  const out = fs.createWriteStream(target, { mode: 0o600 });
  let done = 0;
  try {
    for await (const chunk of res.body) {
      hash.update(chunk);
      done += chunk.length;
      if (!out.write(chunk)) await new Promise((r) => out.once("drain", r));
      onProgress(done, total);
    }
  } finally {
    await new Promise((r) => out.end(r));
  }
  if (hash.digest("hex") !== expected) {
    fs.rmSync(target, { force: true });
    throw new SelfUpdateError("The download doesn't match the checksum GitHub published for it. Nothing was changed.");
  }
  return target;
}

async function readPlistValue(appPath, key) {
  return (await run("/usr/bin/plutil", ["-extract", key, "raw", "-o", "-", path.join(appPath, "Contents", "Info.plist")])).trim();
}

/**
 * Download and unpack the release next to `appPath` and check the new bundle.
 * Returns { stageDir, newApp }; nothing in place has changed yet.
 */
async function prepareUpdate({ release, arch, appPath, fetchImpl, allowUrl, userAgent, onProgress }) {
  const name = `Melodious-${release.version}-${arch}.zip`;
  const stageDir = fs.mkdtempSync(path.join(path.dirname(appPath), STAGE_PREFIX));
  try {
    const zip = await downloadVerified({ release, name, dir: stageDir, fetchImpl, allowUrl, userAgent, onProgress });
    const unpacked = path.join(stageDir, "unpacked");
    fs.mkdirSync(unpacked);
    await run("/usr/bin/ditto", ["-x", "-k", zip, unpacked]);
    fs.rmSync(zip, { force: true });
    const apps = fs.readdirSync(unpacked).filter((n) => n.endsWith(".app"));
    if (apps.length !== 1) throw new SelfUpdateError("The download doesn't contain exactly one app.");
    const newApp = path.join(unpacked, apps[0]);
    const [oldId, newId, newVersion] = await Promise.all([
      readPlistValue(appPath, "CFBundleIdentifier"),
      readPlistValue(newApp, "CFBundleIdentifier"),
      readPlistValue(newApp, "CFBundleShortVersionString"),
    ]);
    if (newId !== oldId) throw new SelfUpdateError(`The download is ${newId}, not ${oldId}.`);
    if (newVersion !== release.version) throw new SelfUpdateError(`The download says it is ${newVersion}, not ${release.version}.`);
    await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", newApp]);
    return { stageDir, newApp };
  } catch (err) {
    fs.rmSync(stageDir, { recursive: true, force: true });
    throw err;
  }
}

/** Put `newApp` where `appPath` is; the old app goes to the stage dir. Rolls back on failure. */
function swapInto({ appPath, newApp, stageDir, rename = fs.renameSync }) {
  const previous = path.join(stageDir, "previous.app");
  rename(appPath, previous);
  try {
    rename(newApp, appPath);
  } catch (err) {
    rename(previous, appPath);
    throw new SelfUpdateError(`Couldn't put the new version in place, so nothing changed: ${err.message}`);
  }
  return previous;
}

/** After a successful relaunch: remove leftovers of earlier updates next to the app. */
function cleanupStages(appPath) {
  if (!appPath) return 0;
  let removed = 0;
  let entries = [];
  try {
    entries = fs.readdirSync(path.dirname(appPath));
  } catch {
    return 0;
  }
  for (const name of entries) {
    if (!name.startsWith(STAGE_PREFIX)) continue;
    try {
      fs.rmSync(path.join(path.dirname(appPath), name), { recursive: true, force: true });
      removed++;
    } catch {}
  }
  return removed;
}

module.exports = {
  SelfUpdateError,
  bundlePathFromExec,
  cleanupStages,
  downloadVerified,
  installLocationProblem,
  parseSums,
  prepareUpdate,
  swapInto,
};
