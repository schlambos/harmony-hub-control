import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { DROPBEAR_BUILDS, HUB_FILES, HUB_INSTALLER_HELPERS, changedFiles, defaultSshPath, findHubKey, readHubPayload, readLocalHubZip, unzipCommand, updateHub } = require("../src/hub-update.js");
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const mac = process.platform === "darwin";
const win = process.platform === "win32";
const md5 = (b) => crypto.createHash("md5").update(b).digest("hex");
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "melodious-hubupdate-"));
}

/** A hub zip like the release's: melodious-hub-<v>/payload/... plus MANIFEST.txt. */
function makeHubZip(dir, version, { extra = {}, badManifest = false, folder = `melodious-hub-${version}` } = {}) {
  const top = path.join(dir, folder);
  const files = { ...Object.fromEntries(Object.keys(HUB_FILES).map((rel) => [rel, Buffer.from(`${rel} ${version}\n`)])), ...extra };
  let manifest = "";
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(top, rel)), { recursive: true });
    fs.writeFileSync(path.join(top, rel), body);
    if (rel.startsWith("payload/bin/")) manifest += `${badManifest ? "0".repeat(32) : md5(body)}  ${path.basename(rel)}\n`;
  }
  fs.writeFileSync(path.join(top, "payload/bin/MANIFEST.txt"), manifest);
  fs.writeFileSync(path.join(top, "install_webui.py"), "# installer\n");
  const zip = path.join(dir, `melodious-hub-${version}.zip`);
  if (win) execFileSync(unzipCommand(zip, dir)[0], ["-a", "-c", "-f", zip, "-C", dir, path.basename(top)]);
  else execFileSync("/usr/bin/ditto", ["-c", "-k", "--keepParent", top, zip]);
  return zip;
}

test("the destination map matches tools/releases/release.py", () => {
  const py = fs.readFileSync(path.join(ROOT, "tools/releases/release.py"), "utf8");
  const pyMap = Object.fromEntries([...py.matchAll(/^\s+"(payload\/[^"]+)": \("([^"]+)", "(\d+)", \d\),$/gm)].map((m) => [m[1], [m[2], m[3]]]));
  assert.deepEqual(
    Object.fromEntries(Object.entries(HUB_FILES).map(([rel, [dest, mode]]) => [rel, [dest, mode]])),
    pyMap,
  );
});

test("the installers' helpers are skipped, as in tools/releases/release.py", () => {
  const py = fs.readFileSync(path.join(ROOT, "tools/releases/release.py"), "utf8");
  const block = py.match(/^HUB_INSTALLER_HELPERS = \{([^}]*)\}/m)[1];
  assert.deepEqual([...HUB_INSTALLER_HELPERS].sort(), [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort());
  assert.ok(HUB_INSTALLER_HELPERS.size > 0);
  for (const rel of HUB_INSTALLER_HELPERS) assert.equal(HUB_FILES[rel], undefined, `${rel} is never installed`);
});

test("another build of the same Dropbear counts as current, as in install_webui.py", () => {
  const py = fs.readFileSync(path.join(ROOT, "install_webui.py"), "utf8");
  const block = py.match(/^DROPBEAR_BUILDS = \{([\s\S]*?)^\}/m)[1];
  const pyBuilds = new Map([...block.matchAll(/"([0-9a-f]{32})": "([^"]+)"/g)].map((m) => [m[1], m[2]]));
  assert.deepEqual([...DROPBEAR_BUILDS].sort(), [...pyBuilds].sort());

  const ours = md5(fs.readFileSync(path.join(ROOT, "payload/bin/dropbearmulti")));
  assert.ok(DROPBEAR_BUILDS.has(ours));
  const twin = [...DROPBEAR_BUILDS.keys()].find((m) => m !== ours && DROPBEAR_BUILDS.get(m) === DROPBEAR_BUILDS.get(ours));
  assert.ok(twin, "another build of our Dropbear version is listed");
  const dropbear = { dest: HUB_FILES["payload/bin/dropbearmulti"][0], md5: ours };
  const webui = { dest: HUB_FILES["payload/bin/codex_webui"][0], md5: "a".repeat(32) };
  const names = (current) => changedFiles([dropbear, webui], new Map(current)).map((f) => f.dest);
  // The hub has the other build of our Dropbear (the root tool's, linked): nothing to send.
  assert.deepEqual(names([[dropbear.dest, twin], [webui.dest, webui.md5]]), []);
  // Some other Dropbear, or none: send ours.
  assert.deepEqual(names([[dropbear.dest, "b".repeat(32)], [webui.dest, webui.md5]]), [dropbear.dest]);
  assert.deepEqual(names([[webui.dest, webui.md5]]), [dropbear.dest]);
  // Equivalence is only for Dropbear.
  assert.deepEqual(names([[dropbear.dest, ours], [webui.dest, twin]]), [webui.dest]);
});

test("finds the installer's key: newest harmony_owner_* that isn't .pub", () => {
  const home = tmp();
  try {
    assert.equal(findHubKey(home), null);
    fs.mkdirSync(path.join(home, ".ssh"));
    fs.writeFileSync(path.join(home, ".ssh", "harmony_owner_old"), "k");
    fs.utimesSync(path.join(home, ".ssh", "harmony_owner_old"), 1000, 1000);
    fs.writeFileSync(path.join(home, ".ssh", "harmony_owner_ed25519"), "k");
    fs.writeFileSync(path.join(home, ".ssh", "harmony_owner_ed25519.pub"), "k");
    fs.writeFileSync(path.join(home, ".ssh", "id_ed25519"), "k");
    assert.equal(findHubKey(home), path.join(home, ".ssh", "harmony_owner_ed25519"));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("each platform uses its own unzip and ssh", () => {
  assert.deepEqual(unzipCommand("/t/a.zip", "/t/out", "darwin"), ["/usr/bin/ditto", ["-x", "-k", "/t/a.zip", "/t/out"]]);
  assert.deepEqual(unzipCommand("C:\\t\\a.zip", "C:\\t\\out", "win32", { SystemRoot: "D:\\Windows" }),
    ["D:\\Windows\\System32\\tar.exe", ["-x", "-f", "C:\\t\\a.zip", "-C", "C:\\t\\out"]]);
  assert.equal(defaultSshPath("darwin"), "/usr/bin/ssh");
  assert.equal(defaultSshPath("win32", { SystemRoot: "D:\\Windows" }), "D:\\Windows\\System32\\OpenSSH\\ssh.exe");
  assert.equal(defaultSshPath("win32", {}), "C:\\Windows\\System32\\OpenSSH\\ssh.exe");
});

test("Windows has the OpenSSH client and bsdtar where the app looks for them", { skip: !win }, () => {
  const ssh = execFileSync(defaultSshPath(), ["-V"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  assert.ok(fs.existsSync(defaultSshPath()), ssh);
  assert.match(execFileSync(unzipCommand("", "")[0], ["--version"], { encoding: "utf8" }), /bsdtar/);
});

test("reads the payload: every mapped file, md5s, refuses unknown files and a wrong MANIFEST", { skip: !mac && !win }, async () => {
  const dir = tmp();
  try {
    const files = await readHubPayload(makeHubZip(dir, "9.0.0"), "9.0.0");
    assert.equal(files.length, Object.keys(HUB_FILES).length);
    const webui = files.find((f) => f.dest === "/data/codex/bin/codex_webui");
    assert.equal(webui.md5, md5(Buffer.from("payload/bin/codex_webui 9.0.0\n")));
    assert.equal(files.find((f) => f.dest.endsWith("codexactivity.lua")).reboot, 1);

    fs.rmSync(path.join(dir, "melodious-hub-9.0.0"), { recursive: true });
    const unknown = makeHubZip(dir, "9.0.1", { extra: { "payload/bin/codex_new": Buffer.from("x") } });
    await assert.rejects(readHubPayload(unknown, "9.0.1"), /doesn't know how to install/);
    const bad = makeHubZip(dir, "9.0.2", { badManifest: true });
    await assert.rejects(readHubPayload(bad, "9.0.2"), /MANIFEST\.txt doesn't match/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("reads a hub zip the user chose: version from its folder, helpers skipped, anything else refused", { skip: !mac && !win }, async () => {
  const dir = tmp();
  try {
    const helper = [...HUB_INSTALLER_HELPERS][0];
    // The file's name says nothing: the version is the folder's.
    const zip = makeHubZip(dir, "9.3.0", { extra: { [helper]: Buffer.from("probe") } });
    const renamed = path.join(dir, "from-my-build.zip");
    fs.renameSync(zip, renamed);
    const { version, files } = await readLocalHubZip(renamed);
    assert.equal(version, "9.3.0");
    assert.equal(files.length, Object.keys(HUB_FILES).length);
    assert.ok(!files.some((f) => f.rel === helper), "the helper is not installed");
    assert.equal((await readHubPayload(renamed, "9.3.0")).length, files.length);

    const other = makeHubZip(dir, "9.3.1", { folder: "something-else" });
    await assert.rejects(readLocalHubZip(other), /isn't a Melodious hub zip/);
    const unknown = makeHubZip(dir, "9.3.2", { extra: { "payload/helpers/other": Buffer.from("x") } });
    await assert.rejects(readLocalHubZip(unknown), /doesn't know how to install/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("refuses a hub zip with a link in its payload", { skip: !mac }, async () => {
  const dir = tmp();
  try {
    makeHubZip(dir, "9.4.0");
    const target = path.join(dir, "melodious-hub-9.4.0", "payload/scripts/init.sh");
    fs.rmSync(target);
    fs.symlinkSync("/etc/hosts", target);
    const zip = path.join(dir, "linked.zip");
    execFileSync("/usr/bin/ditto", ["-c", "-k", "--keepParent", path.join(dir, "melodious-hub-9.4.0"), zip]);
    await assert.rejects(readLocalHubZip(zip), /isn't a plain file/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** A stand-in ssh: the real hub_update.sh answers `status` from hubRoot; `apply` only records a result. */
function makeFakeHub(dir) {
  const hubRoot = path.join(dir, "hubroot");
  const realStage = path.join(dir, "volatile", "codex-update-1700000000");
  const fakeStage = "/var/volatile/codex-update-1700000000";
  const log = path.join(dir, "ssh.log");
  fs.mkdirSync(path.join(hubRoot, "data/codex"), { recursive: true });
  fs.mkdirSync(path.join(hubRoot, "proc"), { recursive: true });
  fs.writeFileSync(path.join(hubRoot, "data/codex/hub_id"), "1234\n");
  fs.writeFileSync(path.join(hubRoot, "proc/meminfo"), "MemFree: 16384 kB\n");
  const sshPath = path.join(dir, "fake-ssh.sh");
  fs.writeFileSync(sshPath, [
    "#!/bin/sh",
    "shift $(( $# - 1 ))",
    "cmd=$1",
    `printf '%s\\n' "$cmd" >> "${log}"`,
    "case \"$cmd\" in",
    `  S=/var/volatile/codex-update-*) mkdir -p "${realStage}/files" && echo "${fakeStage}" ;;`,
    `  "sh ${fakeStage}/hub_update.sh status "*) HUB_UPDATE_ROOT="${hubRoot}" /bin/sh "${realStage}/hub_update.sh" status \${cmd#* status } ;;`,
    `  "cat > ${fakeStage}/"*) cat > "${realStage}/\${cmd#cat > ${fakeStage}/}" ;;`,
    `  *"hub_update.sh apply ${fakeStage}"*) echo "RESULT ok restarted" > "${realStage}/log" ;;`,
    `  "cat ${fakeStage}/log "*) cat "${realStage}/log" ;;`,
    `  "rm -rf ${fakeStage}") rm -rf "${realStage}" ;;`,
    "  *) exit 99 ;;",
    "esac",
  ].join("\n"), { mode: 0o755 });
  const keyPath = path.join(dir, "key");
  fs.writeFileSync(keyPath, "fake-key\n");
  return {
    hubRoot, realStage, sshPath, keyPath,
    put(files) {
      for (const f of files) {
        fs.mkdirSync(path.dirname(path.join(hubRoot, f.dest)), { recursive: true });
        fs.writeFileSync(path.join(hubRoot, f.dest), f.body);
      }
    },
    commands: () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8") : ""),
  };
}

test("repairs from a chosen zip with no download: nothing to do, a declined change, and a full reinstall", { skip: !mac }, async () => {
  const dir = tmp();
  try {
    const payload = await readLocalHubZip(makeHubZip(dir, "9.2.0"));
    const total = payload.files.length;
    const hub = makeFakeHub(dir);
    hub.put(payload.files);
    const common = {
      payload,
      host: "127.0.0.1",
      keyPath: hub.keyPath,
      sshPath: hub.sshPath,
      fetchImpl: () => assert.fail("a chosen zip downloads nothing"),
      pollMs: 10,
      versionProbe: async () => ({ version: "9.2.0" }),
    };

    // The hub has these very files: a repair sends nothing.
    const asked = [];
    const same = await updateHub({ ...common, confirmChange: async (c) => { asked.push(c); return true; } });
    assert.deepEqual({ ok: same.ok, alreadyCurrent: same.alreadyCurrent, total: same.total }, { ok: true, alreadyCurrent: true, total });
    assert.equal(asked.length, 0);
    assert.ok(!hub.commands().includes("/files/"));
    assert.equal(fs.existsSync(hub.realStage), false);

    // One file on the hub differs and the user says no: nothing is sent.
    const webui = payload.files.find((f) => f.dest.endsWith("/codex_webui"));
    fs.writeFileSync(path.join(hub.hubRoot, webui.dest), "something else");
    const declined = await updateHub({ ...common, confirmChange: async (c) => { asked.push(c); return false; } });
    assert.deepEqual({ ok: declined.ok, cancelled: declined.cancelled }, { ok: false, cancelled: true });
    assert.deepEqual(asked.map((c) => [c.differing.map((f) => f.dest), c.total]), [[[webui.dest], total]]);
    assert.ok(!hub.commands().includes("/files/"));
    assert.ok(!hub.commands().includes("apply"));
    assert.equal(fs.existsSync(hub.realStage), false);

    // A repair sends only that file.
    const repaired = await updateHub(common);
    assert.deepEqual({ ok: repaired.ok, replaced: repaired.replaced, version: repaired.version }, { ok: true, replaced: 1, version: "9.2.0" });

    // Reinstall All Files sends every file, byte for byte, codex_webui last.
    hub.put(payload.files);
    const steps = [];
    const sent = [];
    const forced = await updateHub({
      ...common,
      force: true,
      onStep: (s) => {
        steps.push(s);
        if (s.startsWith("Installing")) {
          for (const f of payload.files) assert.ok(fs.readFileSync(path.join(hub.realStage, "files", f.name)).equals(f.body), f.name);
          sent.push(...fs.readFileSync(path.join(hub.realStage, "plan"), "utf8").trim().split("\n"));
        }
      },
    });
    assert.deepEqual({ ok: forced.ok, replaced: forced.replaced, total: forced.total }, { ok: true, replaced: total, total });
    assert.equal(sent.length, total);
    assert.match(sent[total - 1], / \/data\/codex\/bin\/codex_webui$/);
    assert.ok(!steps.some((s) => s.startsWith("Downloading")));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("refuses to update a hub where /etc/melodious-off is set and cleans up staging", { skip: !mac }, async () => {
  const dir = tmp();
  const server = http.createServer();
  try {
    const zip = makeHubZip(dir, "9.1.0");
    const zipBody = fs.readFileSync(zip);
    const sumsBody = `${sha(zipBody)}  melodious-hub-9.1.0.zip\n`;
    server.on("request", (req, res) => {
      if (req.url === "/zip") { res.writeHead(200, { "Content-Length": zipBody.length }); return res.end(zipBody); }
      if (req.url === "/sums") { res.writeHead(200); return res.end(sumsBody); }
      res.writeHead(404); res.end();
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${server.address().port}`;

    // 1. Direct hub_update.sh check (both /etc/melodious-off and legacy fallback).
    const script = path.join(ROOT, "desktop/src/hub-update/hub_update.sh");
    for (const relMarker of ["etc/melodious-off", "data/codex/melodious-off"]) {
      const fakeRoot = path.join(dir, relMarker.replace(/\//g, "_"));
      fs.mkdirSync(path.join(fakeRoot, "data/codex"), { recursive: true });
      fs.mkdirSync(path.join(fakeRoot, "etc"), { recursive: true });
      fs.mkdirSync(path.join(fakeRoot, "proc"), { recursive: true });
      fs.writeFileSync(path.join(fakeRoot, "data/codex/hub_id"), "1234\n");
      fs.writeFileSync(path.join(fakeRoot, "proc/meminfo"), "MemFree: 16384 kB\n");
      fs.writeFileSync(path.join(fakeRoot, relMarker), "off\n");
      const statusOut = execFileSync("/bin/sh", [script, "status"], {
        env: { ...process.env, HUB_UPDATE_ROOT: fakeRoot },
        encoding: "utf8",
      });
      assert.match(statusOut, /^hub_id yes$/m);
      assert.match(statusOut, /^melodious off$/m);

      const stage = path.join(fakeRoot, "stage");
      fs.mkdirSync(stage, { recursive: true });
      fs.writeFileSync(path.join(stage, "plan"), "");
      let applyCode = 0;
      try {
        execFileSync("/bin/sh", [script, "apply", stage], {
          env: { ...process.env, HUB_UPDATE_ROOT: fakeRoot },
        });
      } catch (e) {
        applyCode = e.status;
      }
      assert.equal(applyCode, 1);
      const log = fs.readFileSync(path.join(stage, "log"), "utf8");
      assert.match(log, /^RESULT refused Melodious is turned off on this hub\. Run with --turn-on to turn it back on first\.$/m);
    }

    // 2. Full updateHub() refusal over fake SSH running the real hub_update.sh.
    const hubRoot = path.join(dir, "hubroot");
    const stageParent = path.join(dir, "volatile");
    fs.mkdirSync(path.join(hubRoot, "data/codex"), { recursive: true });
    fs.mkdirSync(path.join(hubRoot, "etc"), { recursive: true });
    fs.mkdirSync(path.join(hubRoot, "proc"), { recursive: true });
    fs.mkdirSync(stageParent, { recursive: true });
    fs.writeFileSync(path.join(hubRoot, "data/codex/hub_id"), "1234\n");
    fs.writeFileSync(path.join(hubRoot, "etc/melodious-off"), "off\n");
    fs.writeFileSync(path.join(hubRoot, "proc/meminfo"), "MemFree: 16384 kB\n");

    const sshCommands = path.join(dir, "ssh.log");
    const fakeSsh = path.join(dir, "fake-ssh.sh");
    const fakeStage = "/var/volatile/codex-update-1700000000";
    const realStage = path.join(stageParent, "codex-update-1700000000");
    fs.writeFileSync(fakeSsh, [
      "#!/bin/sh",
      "shift $(( $# - 1 ))",
      "cmd=$1",
      `printf '%s\\n' "$cmd" >> "${sshCommands}"`,
      "case \"$cmd\" in",
      `  S=/var/volatile/codex-update-*) mkdir -p "${realStage}/files" && echo "${fakeStage}" ;;`,
      `  "cat > ${fakeStage}/hub_update.sh") cat > "${realStage}/hub_update.sh" ;;`,
      `  "sh ${fakeStage}/hub_update.sh status "*) HUB_UPDATE_ROOT="${hubRoot}" /bin/sh "${realStage}/hub_update.sh" status ;;`,
      `  "rm -rf ${fakeStage}") rm -rf "${realStage}" ;;`,
      "  *) exit 99 ;;",
      "esac",
    ].join("\n"), { mode: 0o755 });
    const keyFile = path.join(dir, "key");
    fs.writeFileSync(keyFile, "fake-key\n");

    await assert.rejects(
      updateHub({
        release: {
          version: "9.1.0",
          url: "x",
          assets: { "melodious-hub-9.1.0.zip": `${base}/zip`, "SHA256SUMS.txt": `${base}/sums` },
        },
        host: "127.0.0.1",
        keyPath: keyFile,
        sshPath: fakeSsh,
        allowUrl: (u) => u.startsWith(base),
      }),
      /Melodious is turned off on this hub\. Run with --turn-on to turn it back on first\./,
    );
    assert.equal(fs.existsSync(realStage), false, "staging folder must be cleaned up on refusal");
    const ran = fs.readFileSync(sshCommands, "utf8");
    assert.ok(!ran.includes("apply"), "apply must never run on a turned-off hub");
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// End to end against tools/hub-emu with Dropbear on 127.0.0.1:2222 and a test
// key (see the Auto-Update notes). Off by default.
test("updates hub-emu over SSH, then finds nothing left to do", { skip: !process.env.HUB_EMU_SSH }, async () => {
  const zipPath = process.env.HUB_ZIP;
  const version = process.env.HUB_ZIP_VERSION;
  const body = fs.readFileSync(zipPath);
  const name = `melodious-hub-${version}.zip`;
  const server = http.createServer((req, res) => {
    if (req.url === "/zip") { res.writeHead(200, { "Content-Length": body.length }); return res.end(body); }
    if (req.url === "/sums") { res.writeHead(200); return res.end(`${sha(body)}  ${name}\n`); }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const known = path.join(tmp(), "known_hosts");
  const common = {
    release: { version, url: "x", assets: { [name]: `${base}/zip`, "SHA256SUMS.txt": `${base}/sums` } },
    host: "127.0.0.1", httpPort: 8788, sshPort: 2222, knownHosts: known,
    keyPath: process.env.HUB_EMU_KEY, allowUrl: (u) => u.startsWith(base), pollMs: 500, rebootWaitMs: 1000,
  };
  try {
    const steps = [];
    const first = await updateHub({ ...common, onStep: (s) => steps.push(s) });
    console.log(steps.join("\n"), "\n", first);
    assert.equal(first.ok, true);
    assert.equal(first.rebooted, true, "boot scripts and plugins changed, so the hub restarts");
    const second = await updateHub(common);
    assert.equal(second.alreadyCurrent, true);
  } finally {
    server.close();
  }
});
