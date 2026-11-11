import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { DROPBEAR_BUILDS, HUB_FILES, changedFiles, findHubKey, readHubPayload, updateHub } = require("../src/hub-update.js");
const ROOT = new URL("../..", import.meta.url).pathname;
const mac = process.platform === "darwin";
const md5 = (b) => crypto.createHash("md5").update(b).digest("hex");
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "melodious-hubupdate-"));
}

/** A hub zip like the release's: melodious-hub-<v>/payload/... plus MANIFEST.txt. */
function makeHubZip(dir, version, { extra = {}, badManifest = false } = {}) {
  const top = path.join(dir, `melodious-hub-${version}`);
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
  execFileSync("/usr/bin/ditto", ["-c", "-k", "--keepParent", top, zip]);
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

test("reads the payload: every mapped file, md5s, refuses unknown files and a wrong MANIFEST", { skip: !mac }, async () => {
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
