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
const {
  SelfUpdateError,
  bundlePathFromExec,
  cleanupStages,
  downloadVerified,
  installLocationProblem,
  prepareUpdate,
  swapInto,
} = require("../src/self-update.js");

const mac = process.platform === "darwin";

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "melodious-selfupdate-"));
}

/** A minimal ad-hoc-signed app bundle (no Keychain involved). */
function makeApp(dir, { id = "app.melodious.desktop", version = "1.0.0" } = {}) {
  const app = path.join(dir, "Melodious.app");
  fs.mkdirSync(path.join(app, "Contents", "MacOS"), { recursive: true });
  fs.writeFileSync(path.join(app, "Contents", "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${id}</string>
<key>CFBundleShortVersionString</key><string>${version}</string>
<key>CFBundleExecutable</key><string>Melodious</string>
</dict></plist>`);
  fs.writeFileSync(path.join(app, "Contents", "MacOS", "Melodious"), `#!/bin/sh\necho ${version}\n`, { mode: 0o755 });
  execFileSync("/usr/bin/codesign", ["--force", "-s", "-", app]);
  return app;
}

function zipApp(app, zipPath) {
  execFileSync("/usr/bin/ditto", ["-c", "-k", "--keepParent", app, zipPath]);
  return fs.readFileSync(zipPath);
}

/** Local stand-in for GitHub: /dl/<name> redirects to /assets/<name>. */
async function serve(files) {
  const server = http.createServer((req, res) => {
    if (req.url.startsWith("/dl/")) {
      res.writeHead(302, { Location: `/assets/${req.url.slice(4)}` });
      return res.end();
    }
    if (req.url === "/dl-elsewhere") {
      res.writeHead(302, { Location: "http://evil.invalid/x.zip" });
      return res.end();
    }
    const body = files[req.url.replace("/assets/", "")];
    if (!body) {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, { "Content-Length": body.length });
    res.end(body);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, base, allowUrl: (u) => String(u).startsWith(base) };
}

const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

function release(base, version, zipName, extra = {}) {
  return {
    version,
    url: "https://github.com/schlambos/harmony-hub-control/releases/tag/v" + version,
    assets: { [zipName]: `${base}/dl/${zipName}`, "SHA256SUMS.txt": `${base}/dl/SHA256SUMS.txt`, ...extra },
  };
}

test("bundle path from the executable path", () => {
  assert.equal(bundlePathFromExec("/Applications/Melodious.app/Contents/MacOS/Melodious"), "/Applications/Melodious.app");
  assert.equal(bundlePathFromExec("/usr/local/bin/node"), null);
});

test("install location problems: dev run, disk image, translocation, unwritable folder", () => {
  const ok = () => {};
  const denied = () => { throw new Error("EACCES"); };
  assert.match(installLocationProblem("/Applications/Melodious.app", { packaged: false, access: ok }), /installed/);
  assert.match(installLocationProblem("/Volumes/Melodious 1.2.0/Melodious.app", { access: ok }), /disk image/);
  assert.match(installLocationProblem("/private/var/folders/x/AppTranslocation/ABC/d/Melodious.app", { access: ok }), /temporary location/);
  assert.match(installLocationProblem("/Applications/Melodious.app", { access: denied }), /can't replace apps in \/Applications/);
  assert.equal(installLocationProblem("/Applications/Melodious.app", { access: ok }), null);
});

test("download: follows allowed redirects, checks the sum, refuses other hosts and wrong sums", async () => {
  const body = Buffer.from("zip bytes ".repeat(5000));
  const files = { "M.zip": body, "SHA256SUMS.txt": Buffer.from(`${sha(body)}  M.zip\n`) };
  const { server, base, allowUrl } = await serve(files);
  const dir = tmp();
  try {
    let progress = 0;
    const file = await downloadVerified({ release: release(base, "9.0.0", "M.zip"), name: "M.zip", dir, allowUrl, onProgress: (d) => { progress = d; } });
    assert.deepEqual(fs.readFileSync(file), body);
    assert.equal(progress, body.length);

    const away = release(base, "9.0.0", "M.zip");
    away.assets["M.zip"] = `${base}/dl-elsewhere`;
    await assert.rejects(downloadVerified({ release: away, name: "M.zip", dir, allowUrl }), /outside GitHub/);

    files["SHA256SUMS.txt"] = Buffer.from(`${"0".repeat(64)}  M.zip\n`);
    await assert.rejects(downloadVerified({ release: release(base, "9.0.0", "M.zip"), name: "M.zip", dir, allowUrl }), /doesn't match the checksum/);
    assert.equal(fs.existsSync(path.join(dir, "M.zip")), false, "a bad download is deleted");

    await assert.rejects(downloadVerified({ release: { version: "9", assets: { "M.zip": `${base}/dl/M.zip` } }, name: "M.zip", dir, allowUrl }), /no SHA256SUMS/);
    await assert.rejects(downloadVerified({ release: release(base, "9.0.0", "M.zip"), name: "M.zip", dir }), /outside GitHub/, "default allow-list is GitHub only");
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("prepare + swap replaces the installed app; wrong bundle id and failed swap leave it unchanged", { skip: !mac }, async () => {
  const root = tmp();
  try {
    const appsDir = path.join(root, "Applications");
    fs.mkdirSync(appsDir);
    const installed = makeApp(appsDir, { version: "1.2.0" });

    const buildDir = path.join(root, "build");
    fs.mkdirSync(buildDir);
    const newZip = zipApp(makeApp(path.join(buildDir), { version: "1.3.0" }), path.join(root, "new.zip"));
    fs.rmSync(path.join(buildDir, "Melodious.app"), { recursive: true });
    const evilZip = zipApp(makeApp(buildDir, { id: "com.example.other", version: "1.3.0" }), path.join(root, "evil.zip"));
    const files = {
      "Melodious-1.3.0-arm64.zip": newZip,
      "SHA256SUMS.txt": Buffer.from(`${sha(newZip)}  Melodious-1.3.0-arm64.zip\n`),
    };
    const { server, base, allowUrl } = await serve(files);
    try {
      const rel = release(base, "1.3.0", "Melodious-1.3.0-arm64.zip");
      const version = () => execFileSync("/usr/bin/plutil", ["-extract", "CFBundleShortVersionString", "raw", "-o", "-", path.join(installed, "Contents", "Info.plist")]).toString().trim();

      // A swap whose second rename fails puts the old app back.
      const staged = await prepareUpdate({ release: rel, arch: "arm64", appPath: installed, allowUrl });
      let calls = 0;
      assert.throws(() => swapInto({
        appPath: installed, newApp: staged.newApp, stageDir: staged.stageDir,
        rename: (a, b) => { if (++calls === 2) throw new Error("disk full"); fs.renameSync(a, b); },
      }), SelfUpdateError);
      assert.equal(version(), "1.2.0");
      fs.rmSync(staged.stageDir, { recursive: true, force: true });

      // The real swap.
      const ready = await prepareUpdate({ release: rel, arch: "arm64", appPath: installed, allowUrl });
      const previous = swapInto({ appPath: installed, newApp: ready.newApp, stageDir: ready.stageDir });
      assert.equal(version(), "1.3.0");
      assert.ok(fs.existsSync(previous));
      assert.equal(cleanupStages(installed), 1);
      assert.deepEqual(fs.readdirSync(appsDir), ["Melodious.app"]);

      // A different app with a matching checksum is still refused.
      files["Melodious-1.3.0-arm64.zip"] = evilZip;
      files["SHA256SUMS.txt"] = Buffer.from(`${sha(evilZip)}  Melodious-1.3.0-arm64.zip\n`);
      await assert.rejects(prepareUpdate({ release: rel, arch: "arm64", appPath: installed, allowUrl }), /com\.example\.other/);
      assert.deepEqual(fs.readdirSync(appsDir), ["Melodious.app"], "a refused update leaves nothing behind");
    } finally {
      server.close();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
