"use strict";

// Update the hub from the Mac app, the way install_webui.py does it: over
// SSH with the owner's hub key. The app downloads the hub release from GitHub
// and checks it against the release's SHA256SUMS.txt; the hub only ever sees
// files from that zip. The hub gets no new HTTP route.
//
// On the hub, hub-update/hub_update.sh runs the installer's transaction from
// a private RAM staging folder (verify, rollback copies, .codex-new then
// rename, restart and health check, or reboot), so it finishes even if this
// Mac drops off the network.

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
  "payload/activity/codexactivity.lua": ["/pkg/codexactivity/codexactivity.lua", "644", 1],
  "payload/mqtt/codexmqtt.lua": ["/pkg/codexmqtt/codexmqtt.lua", "644", 1],
  "payload/bin/codex_portal": ["/data/codex/bin/codex_portal", "755", 0],
  "payload/bin/codex_dhcpd": ["/data/codex/bin/codex_dhcpd", "755", 0],
  "payload/bin/dropbearmulti": ["/data/codex/bin/dropbearmulti", "755", 0],
  "payload/scripts/dropbear": ["/usr/sbin/dropbear", "755", 0],
  "payload/scripts/dropbearkey": ["/usr/sbin/dropbearkey", "755", 0],
  "payload/scripts/init.sh": ["/data/codex/init.sh", "755", 1],
  "payload/scripts/offline_egress_guard.sh": ["/data/codex/offline_egress_guard.sh", "755", 1],
  "payload/scripts/recovery_ap.sh": ["/data/codex/recovery_ap.sh", "755", 1],
  "payload/scripts/rcS.local": ["/etc/init.d/rcS.local", "755", 1],
  "payload/scripts/netservicestarter.lua": ["/opt/luaworks/tasks/connectserver/netservicestarter.lua", "644", 1],
};
const HUB_INVENTORY_FILES = new Set(["payload/bin/MANIFEST.txt", "payload/bin/FILES"]);

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

/** Read every hub payload file from the release zip (unpacked with ditto). */
async function readHubPayload(zipPath, version) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "melodious-hub-"));
  try {
    await run("/usr/bin/ditto", ["-x", "-k", zipPath, dir]);
    const top = path.join(dir, `melodious-hub-${version}`);
    if (!fs.existsSync(top)) throw new HubUpdateError(`The hub zip has no melodious-hub-${version} folder.`);
    const files = [];
    const walk = (rel) => {
      for (const name of fs.readdirSync(path.join(top, rel))) {
        const r = rel ? `${rel}/${name}` : name;
        const full = path.join(top, r);
        if (fs.statSync(full).isDirectory()) walk(r);
        else if (r.startsWith("payload/")) files.push(r);
      }
    };
    walk("payload");
    const contents = {};
    for (const rel of files) contents[rel] = fs.readFileSync(path.join(top, rel));
    for (const rel of files) {
      if (!HUB_FILES[rel] && !HUB_INVENTORY_FILES.has(rel)) {
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
    return Object.keys(HUB_FILES).map((rel) => {
      const [dest, mode, reboot] = HUB_FILES[rel];
      return { rel, dest, mode, reboot, body: contents[rel], md5: md5(contents[rel]), name: rel.replace(/\//g, "_") };
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** One SSH command, as install_webui.py runs them; `input` goes to its stdin. */
function createSsh({ host, keyPath, port = 22, sshPath = "/usr/bin/ssh", knownHosts = null }) {
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
  if (/Permission denied/i.test(msg)) return "The hub refused the SSH key. Use the key the installer uses (~/.ssh/harmony_owner_…).";
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(msg)) return "The hub's SSH identity changed since the last connection; not updating. Check ~/.ssh/known_hosts.";
  if (/timed out|No route|Connection refused|Could not resolve/i.test(msg)) return "Couldn't reach the hub over SSH (port 22).";
  return msg;
}

/**
 * Update the hub to `release`. onStep(text) reports progress. Returns
 * { ok, alreadyCurrent?, rebooted?, version?, message }.
 */
async function updateHub({
  release,
  host,
  httpPort = 8080,
  authHeader = null,
  keyPath,
  sshPort = 22,
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
  const zipName = `melodious-hub-${release.version}.zip`;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "melodious-hubzip-"));
  const ssh = createSsh({ host, keyPath, port: sshPort, knownHosts });
  try {
    onStep("Downloading the hub software from GitHub…");
    const zip = await downloadVerified({ release, name: zipName, dir: work, fetchImpl, allowUrl, userAgent });
    const files = await readHubPayload(zip, release.version);

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
    const current = new Map();
    for (const m of status.matchAll(/^file (\S+) (\S+)$/gm)) current.set(m[2], m[1]);
    const changed = files.filter((f) => current.get(f.dest) !== f.md5);
    if (!changed.length) {
      await ssh(`rm -rf ${stage}`).catch(() => {});
      return { ok: true, alreadyCurrent: true, message: `The hub already has Melodious ${release.version}'s software.` };
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
      return { ok: false, rebooted, message: "The update was installed, but the hub hasn't answered since. Give it a minute, then check it." };
    }
    const runs = version.version || "1.2 or older";
    return {
      ok: true,
      rebooted,
      version: version.version || null,
      message: `The hub was updated${rebooted ? " and restarted" : ""}. It reports Melodious ${runs}.`,
    };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

module.exports = { HUB_FILES, HubUpdateError, findHubKey, readHubPayload, updateHub };
