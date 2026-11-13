"use strict";

// Update the hub from the desktop app, the way install_webui.py does it: over
// SSH with the owner's hub key. The app downloads the hub release from GitHub
// and checks it against the release's SHA256SUMS.txt; the hub only ever sees
// files from that zip. The hub gets no new HTTP route.
//
// On the hub, hub-update/hub_update.sh runs the installer's transaction from
// a private RAM staging folder (verify, rollback copies, .codex-new then
// rename, restart and health check, or reboot), so it finishes even if this
// computer drops off the network.

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile, spawn } = require("node:child_process");
const { downloadVerified } = require("./self-update");
const { fetchHubVersion } = require("./updates");

const SCRIPT_PATH = path.join(__dirname, "hub-update", "hub_update.sh");

// Where each hub payload file goes (as install_webui.py installs it) and
// whether it needs a reboot to take effect. Must match HUB_FILES in
// tools/releases/release.py (checked by a test).
const HUB_FILES = {
  "payload/bin/codex_webui": ["/data/codex/bin/codex_webui", "755", 0],
  "payload/bin/codex_hbus": ["/data/codex/bin/codex_hbus", "755", 0],
  "payload/bin/codex_hal_ltcp": ["/data/codex/bin/codex_hal_ltcp", "755", 0],
  "payload/bin/codex_bthid_keyboard": ["/data/codex/bin/codex_bthid_keyboard", "755", 0],
  "payload/bin/codex_bt_pair_agent": ["/data/codex/bin/codex_bt_pair_agent", "755", 0],
  "payload/bin/codex_androidtv": ["/data/codex/bin/codex_androidtv", "755", 0],
  "payload/bin/codex_usbeth": ["/data/codex/bin/codex_usbeth", "755", 0],
  "payload/activity/codexactivity.lua": ["/pkg/codexactivity/codexactivity.lua", "644", 1],
  "payload/mqtt/codexmqtt.lua": ["/pkg/codexmqtt/codexmqtt.lua", "644", 1],
  "payload/bin/codex_portal": ["/data/codex/bin/codex_portal", "755", 0],
  "payload/bin/codex_dhcpd": ["/data/codex/bin/codex_dhcpd", "755", 0],
  "payload/bin/dropbearmulti": ["/data/codex/bin/dropbearmulti", "755", 0],
  "payload/bin/busybox-extra": ["/data/codex/bin/busybox-extra", "755", 0],
  "payload/scripts/dropbear": ["/usr/sbin/dropbear", "755", 0],
  "payload/scripts/dropbearkey": ["/usr/sbin/dropbearkey", "755", 0],
  "payload/scripts/init.sh": ["/data/codex/init.sh", "755", 1],
  "payload/scripts/offline_egress_guard.sh": ["/data/codex/offline_egress_guard.sh", "755", 1],
  "payload/scripts/recovery_ap.sh": ["/data/codex/recovery_ap.sh", "755", 1],
  "payload/scripts/androidtv_service.sh": ["/data/codex/androidtv_service.sh", "755", 1],
  "payload/androidtv/input-presets.json": ["/data/codex/androidtv-input-presets.json", "644", 1],
  "payload/scripts/usb_eth_service.sh": ["/data/codex/usb_eth_service.sh", "755", 1],
  "payload/modules/usb-net/r8152.ko": ["/data/codex/modules/usb-net/r8152.ko", "644", 1],
  "payload/modules/usb-net/usbnet.ko": ["/data/codex/modules/usb-net/usbnet.ko", "644", 1],
  "payload/modules/usb-net/asix.ko": ["/data/codex/modules/usb-net/asix.ko", "644", 1],
  "payload/modules/usb-net/cdc_ether.ko": ["/data/codex/modules/usb-net/cdc_ether.ko", "644", 1],
  "payload/modules/usb-net/cdc_ncm.ko": ["/data/codex/modules/usb-net/cdc_ncm.ko", "644", 1],
  "payload/modules/usb-net/ax88179_178a.ko": ["/data/codex/modules/usb-net/ax88179_178a.ko", "644", 1],
  "payload/modules/usb-net/README.md": ["/data/codex/modules/usb-net/README.md", "644", 1],
  "payload/scripts/rcS.local": ["/etc/init.d/rcS.local", "755", 1],
  "payload/scripts/netservicestarter.lua": ["/opt/luaworks/tasks/connectserver/netservicestarter.lua", "644", 1],
};
const HUB_INVENTORY_FILES = new Set(["payload/bin/MANIFEST.txt", "payload/bin/FILES"]);
// Run by the installers from the hub's RAM staging folder; never installed
// and not used here. Must match HUB_INSTALLER_HELPERS in tools/releases/release.py.
const HUB_INSTALLER_HELPERS = new Set(["payload/helpers/codex_flash_free"]);
// Known builds of Dropbear, by MD5: version. Builds of one version are the
// same program (2025.89 with the unloaded MIPS .pdr section stripped, as
// built and as tools/hub-root ships it, and with only a plain strip, as older
// releases and harmony-hub-root ship it and the installer may have linked),
// so either counts as current. Must match DROPBEAR_BUILDS in install_webui.py.
const DROPBEAR_BUILDS = new Map([
  ["3733327fd04bca282dbf06f33da0bf6c", "2025.89"],
  ["ceabc15471be6f67f1e13fccd20a9508", "2025.89"],
]);

const DROPBEAR_DEST = HUB_FILES["payload/bin/dropbearmulti"][0];

/** The payload files whose copy on the hub (md5 by destination) differs. */
function changedFiles(files, current) {
  return files.filter((f) => {
    const have = current.get(f.dest);
    const version = DROPBEAR_BUILDS.get(have);
    return have !== f.md5 && !(f.dest === DROPBEAR_DEST && version !== undefined && version === DROPBEAR_BUILDS.get(f.md5));
  });
}

class HubUpdateError extends Error {}

const md5 = (buf) => crypto.createHash("md5").update(buf).digest("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The key install_webui.py uses: the newest ~/.ssh/harmony_owner_* that isn't a .pub. */
function findHubKey(home = os.homedir()) {
  const dir = path.join(home, ".ssh");
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const keys = names
    .filter((n) => n.startsWith("harmony_owner_") && !n.endsWith(".pub"))
    .map((n) => path.join(dir, n))
    .filter((p) => fs.statSync(p).isFile())
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return keys[0] || null;
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 1 << 20 }, (err, stdout, stderr) =>
      err ? reject(new HubUpdateError(String(stderr || err.message).trim())) : resolve(String(stdout)));
  });
}

/** The system's own unzip: ditto on macOS, bsdtar (tar.exe, part of Windows 10 1803 and later) on Windows. */
function unzipCommand(zipPath, dir, platform = process.platform, env = process.env) {
  if (platform === "win32") {
    return [path.win32.join(env.SystemRoot || "C:\\Windows", "System32", "tar.exe"), ["-x", "-f", zipPath, "-C", dir]];
  }
  return ["/usr/bin/ditto", ["-x", "-k", zipPath, dir]];
}

/** The system's own ssh: Windows 10 1809 and later ship OpenSSH as ssh.exe. */
function defaultSshPath(platform = process.platform, env = process.env) {
  if (platform === "win32") return path.win32.join(env.SystemRoot || "C:\\Windows", "System32", "OpenSSH", "ssh.exe");
  return "/usr/bin/ssh";
}

/** Unpack a hub zip and read its payload. `version` null takes it from the zip's one melodious-hub-<x.y.z> folder. */
async function unpackHubZip(zipPath, version) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "melodious-hub-"));
  try {
    await run(...unzipCommand(zipPath, dir));
    if (version === null) {
      const tops = fs.readdirSync(dir).filter((n) => /^melodious-hub-\d+\.\d+\.\d+$/.test(n) && fs.statSync(path.join(dir, n)).isDirectory());
      if (tops.length !== 1) throw new HubUpdateError("That isn't a Melodious hub zip: it has no melodious-hub-<version> folder.");
      version = tops[0].slice("melodious-hub-".length);
    }
    const top = path.join(dir, `melodious-hub-${version}`);
    if (!fs.existsSync(top)) throw new HubUpdateError(`The hub zip has no melodious-hub-${version} folder.`);
    if (!fs.existsSync(path.join(top, "payload"))) throw new HubUpdateError("The hub zip has no payload folder.");
    const files = [];
    const walk = (rel) => {
      for (const name of fs.readdirSync(path.join(top, rel))) {
        const r = rel ? `${rel}/${name}` : name;
        const stat = fs.lstatSync(path.join(top, r));
        if (stat.isDirectory()) walk(r);
        else if (!stat.isFile()) throw new HubUpdateError(`The hub zip's ${r} isn't a plain file.`);
        else if (r.startsWith("payload/")) files.push(r);
      }
    };
    walk("payload");
    const contents = {};
    for (const rel of files) contents[rel] = fs.readFileSync(path.join(top, rel));
    for (const rel of files) {
      if (!HUB_FILES[rel] && !HUB_INVENTORY_FILES.has(rel) && !HUB_INSTALLER_HELPERS.has(rel)) {
        throw new HubUpdateError(`The hub zip has ${rel}, which this app doesn't know how to install. Update this app first.`);
      }
    }
    const missing = Object.keys(HUB_FILES).filter((rel) => !contents[rel]);
    if (missing.length) throw new HubUpdateError(`The hub zip is missing ${missing.join(", ")}.`);
    const manifest = contents["payload/bin/MANIFEST.txt"]?.toString("utf8") ?? "";
    for (const line of manifest.split(/\r?\n/)) {
      const m = /^([0-9a-f]{32})\s+(\S+)$/.exec(line);
      if (m && (!contents[`payload/bin/${m[2]}`] || md5(contents[`payload/bin/${m[2]}`]) !== m[1])) {
        throw new HubUpdateError(`The hub zip's MANIFEST.txt doesn't match ${m[2]}.`);
      }
    }
    return {
      version,
      files: Object.keys(HUB_FILES).map((rel) => {
        const [dest, mode, reboot] = HUB_FILES[rel];
        return { rel, dest, mode, reboot, body: contents[rel], md5: md5(contents[rel]), name: rel.replace(/\//g, "_") };
      }),
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Read every hub payload file from the release zip (unpacked with the system's unzip). */
async function readHubPayload(zipPath, version) {
  return (await unpackHubZip(zipPath, version)).files;
}

/** A hub zip the user chose: { version, files }, the version read from the zip's folder name. */
function readLocalHubZip(zipPath) {
  return unpackHubZip(zipPath, null);
}

/** One SSH command, as install_webui.py runs them; `input` goes to its stdin. */
function createSsh({ host, keyPath, port = 22, sshPath = defaultSshPath(), knownHosts = null }) {
  const base = ["-p", String(port), "-i", keyPath, "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=accept-new", "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=10"];
  if (knownHosts) base.push("-o", `UserKnownHostsFile=${knownHosts}`);
  return (command, { input = null, timeoutMs = 120000 } = {}) =>
    new Promise((resolve, reject) => {
      const child = spawn(sshPath, [...base, `root@${host}`, command], { stdio: ["pipe", "pipe", "pipe"] });
      let out = "";
      let err = "";
      const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
      child.stdout.on("data", (d) => { out += d; });
      child.stderr.on("data", (d) => { err += d; });
      child.on("error", (e) => { clearTimeout(timer); reject(new HubUpdateError(`ssh: ${e.message}`)); });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(out);
        else reject(new HubUpdateError(err.trim() || `ssh exited with ${code}`));
      });
      child.stdin.end(input ?? undefined);
    });
}

function friendlySshError(err) {
  const msg = String(err?.message || err);
  if (/ENOENT/.test(msg)) {
    return process.platform === "win32"
      ? "This PC has no OpenSSH client. Add it in Windows Settings under Optional features (OpenSSH Client), then try again."
      : "This computer has no ssh program.";
  }
  if (/Permission denied/i.test(msg)) return "The hub refused the SSH key. Use the key the installer uses (~/.ssh/harmony_owner_…).";
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(msg)) return "The hub's SSH identity changed since the last connection; not updating. Check ~/.ssh/known_hosts.";
  if (/timed out|No route|Connection refused|Could not resolve/i.test(msg)) return "Couldn't reach the hub over SSH (port 22).";
  return msg;
}

/**
 * Update the hub to `release`, or to `payload` ({ version, files } from
 * readLocalHubZip) with nothing downloaded. onStep(text) reports progress.
 * `force` sends every file, not only the ones that differ. confirmChange({
 * differing, total }), asked before anything is sent, may answer false to
 * leave the hub as it is. Returns { ok, alreadyCurrent?, cancelled?,
 * rebooted?, version?, total, replaced?, message }.
 */
async function updateHub({
  release,
  payload = null,
  force = false,
  confirmChange = null,
  host,
  httpPort = 8080,
  authHeader = null,
  keyPath,
  sshPort = 22,
  sshPath = defaultSshPath(),
  knownHosts = null,
  fetchImpl,
  allowUrl,
  userAgent = "Melodious",
  onStep = () => {},
  pollMs = 2000,
  rebootWaitMs = 20000,
  versionProbe = () => fetchHubVersion({ host, port: httpPort, authHeader }),
}) {
  if (!keyPath) throw new HubUpdateError("No hub SSH key found. Melodious uses the installer's key, ~/.ssh/harmony_owner_….");
  const target = payload ? payload.version : release.version;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "melodious-hubzip-"));
  const ssh = createSsh({ host, keyPath, port: sshPort, sshPath, knownHosts });
  try {
    let files;
    if (payload) {
      files = payload.files;
    } else {
      onStep("Downloading the hub software from GitHub…");
      const zip = await downloadVerified({ release, name: `melodious-hub-${target}.zip`, dir: work, fetchImpl, allowUrl, userAgent });
      files = await readHubPayload(zip, target);
    }

    onStep("Connecting to the hub…");
    let stage;
    try {
      stage = (await ssh("S=/var/volatile/codex-update-$(date +%s); mkdir -p /var/volatile && mkdir \"$S\" && chmod 700 \"$S\" && mkdir \"$S/files\" && echo \"$S\"")).trim();
    } catch (err) {
      throw new HubUpdateError(friendlySshError(err));
    }
    if (!/^\/var\/volatile\/codex-update-\d+$/.test(stage)) throw new HubUpdateError(`Unexpected staging folder: ${stage}`);
    await ssh(`cat > ${stage}/hub_update.sh`, { input: fs.readFileSync(SCRIPT_PATH) });
    const status = await ssh(`sh ${stage}/hub_update.sh status ${files.map((f) => f.dest).join(" ")}`);
    if (!/^hub_id yes$/m.test(status)) {
      await ssh(`rm -rf ${stage}`).catch(() => {});
      throw new HubUpdateError("This hub has no Melodious setup yet. Install it once with the installer.");
    }
    if (/^melodious off$/m.test(status)) {
      await ssh(`rm -rf ${stage}`).catch(() => {});
      throw new HubUpdateError("Melodious is turned off on this hub. Run with --turn-on to turn it back on first.");
    }
    const current = new Map();
    for (const m of status.matchAll(/^file (\S+) (\S+)$/gm)) current.set(m[2], m[1]);
    const differing = changedFiles(files, current);
    const changed = force ? [...files] : differing;
    if (!changed.length) {
      await ssh(`rm -rf ${stage}`).catch(() => {});
      return { ok: true, alreadyCurrent: true, total: files.length, message: `The hub already has Melodious ${target}'s software.` };
    }
    if (confirmChange && !(await confirmChange({ differing, total: files.length }))) {
      await ssh(`rm -rf ${stage}`).catch(() => {});
      return { ok: false, cancelled: true, total: files.length, message: "Nothing was changed on the hub." };
    }
    // codex_webui goes last, as with the installer.
    changed.sort((a, b) => (a.dest.endsWith("/codex_webui") ? 1 : 0) - (b.dest.endsWith("/codex_webui") ? 1 : 0));

    onStep(`Sending ${changed.length} file${changed.length === 1 ? "" : "s"} to the hub…`);
    for (const f of changed) await ssh(`cat > ${stage}/files/${f.name}`, { input: f.body });
    const plan = changed.map((f) => `${f.md5} ${f.mode} ${f.reboot} ${f.name} ${f.dest}`).join("\n") + "\n";
    await ssh(`cat > ${stage}/plan`, { input: Buffer.from(plan) });

    onStep("Installing on the hub…");
    await ssh(`sh -c "trap '' HUP; sh ${stage}/hub_update.sh apply ${stage}" </dev/null >/dev/null 2>&1 &`);
    let result = null;
    let lastStep = "";
    const deadline = Date.now() + 6 * 60 * 1000;
    while (!result && Date.now() < deadline) {
      await sleep(pollMs);
      let log = "";
      try {
        log = await ssh(`cat ${stage}/log 2>/dev/null || true`, { timeoutMs: 20000 });
      } catch {
        continue; // the hub keeps going on its own; try again
      }
      const step = [...log.matchAll(/^STEP (\S+)/gm)].pop()?.[1];
      if (step && step !== lastStep) {
        lastStep = step;
        if (step === "restarting") onStep("Restarting the hub's services…");
      }
      const m = /^RESULT (\S+) ?(.*)$/m.exec(log);
      if (m) result = { code: m[1], text: m[2] };
    }
    if (!result) throw new HubUpdateError("The hub didn't finish the update in 6 minutes. Check it with the installer.");
    if (result.code !== "ok") throw new HubUpdateError(result.text || `The hub update ended with ${result.code}.`);

    const rebooted = result.text === "reboot";
    if (rebooted) {
      onStep("The hub is restarting…");
      await sleep(rebootWaitMs);
    } else {
      await ssh(`rm -rf ${stage}`).catch(() => {});
    }
    onStep("Waiting for the hub…");
    const until = Date.now() + (rebooted ? 4 * 60 * 1000 : 60 * 1000);
    let version = null;
    while (Date.now() < until) {
      version = await versionProbe().catch(() => null);
      if (version) break;
      await sleep(pollMs);
    }
    if (!version) {
      return { ok: false, rebooted, total: files.length, replaced: changed.length, message: "The update was installed, but the hub hasn't answered since. Give it a minute, then check it." };
    }
    const runs = version.version || "1.2 or older";
    return {
      ok: true,
      rebooted,
      version: version.version || null,
      total: files.length,
      replaced: changed.length,
      message: `The hub was updated${rebooted ? " and restarted" : ""}. It reports Melodious ${runs}.`,
    };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

module.exports = { DROPBEAR_BUILDS, HUB_FILES, HUB_INSTALLER_HELPERS, HubUpdateError, changedFiles, defaultSshPath, findHubKey, readHubPayload, readLocalHubZip, unzipCommand, updateHub };
