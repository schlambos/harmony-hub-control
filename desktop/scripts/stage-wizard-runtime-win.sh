#!/bin/sh
# Stage official embeddable CPython (PSF-2.0, retains LICENSE.txt).
# Windows' ctypes winhid backend needs no pip, wheels or host Python.
# Run from Git Bash on Windows; staging also works on macOS/Linux.
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$SCRIPT_DIR/.."
node <<'NODE'
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

// 3.12.10 is the last official 3.12 Windows binary release. Digest published
// in python.org's adjacent .sigstore messageSignature.messageDigest.
const version = "3.12.10";
const name = `python-${version}-embed-amd64.zip`;
const url = `https://www.python.org/ftp/python/${version}/${name}`;
const sha256 = "4acbed6dd1c744b0376e3b1cf57ce906f9dc9e95e68824584c8099a63025a3c3";
const cache = path.resolve(process.env.MELODIOUS_WIZARD_CACHE_DIR || "build/wizard-cache");
const archive = path.join(cache, name);
const target = path.resolve("build/wizard-python/win-x64");
const digest = (body) => crypto.createHash("sha256").update(body).digest("hex");

async function main() {
  fs.mkdirSync(cache, { recursive: true });
  let body = fs.existsSync(archive) ? fs.readFileSync(archive) : null;
  if (!body || digest(body) !== sha256) {
    console.log(`stage-wizard-runtime-win: downloading ${name}`);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`);
    body = Buffer.from(await response.arrayBuffer());
    if (digest(body) !== sha256) throw new Error(`SHA-256 mismatch for ${name}`);
    fs.writeFileSync(archive, body);
  }
  console.log(`stage-wizard-runtime-win: SHA-256 verified ${name}`);
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });
  const unzip = process.platform === "win32"
    ? [path.win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe"), ["-xf", archive, "-C", target]]
    : ["unzip", ["-q", archive, "-d", target]];
  execFileSync(unzip[0], unzip[1], { stdio: "inherit" });
  // Keep isolation: no registry/user site/PYTHONPATH or cwd imports. The bridge
  // explicitly adds its own directory for sibling modules. The installer uses
  // only stdlib, including when copied into its private staging workspace.
  fs.writeFileSync(path.join(target, "python312._pth"), "python312.zip\n.\n");
  for (const file of ["python.exe", "python312.dll", "python312.zip", "_ctypes.pyd", "LICENSE.txt"]) {
    if (!fs.existsSync(path.join(target, file))) throw new Error(`Missing ${file}`);
  }
  if (process.platform === "win32") {
    const python = path.join(target, "python.exe");
    const env = { ...process.env, PYTHONDONTWRITEBYTECODE: "1" };
    for (const key of Object.keys(env)) {
      if (/^(PYTHON|VIRTUAL_ENV|__PYVENV_LAUNCHER__)/i.test(key)) delete env[key];
      if (/^path$/i.test(key)) env[key] = path.win32.join(env.SystemRoot || "C:\\Windows", "System32", "OpenSSH");
    }
    execFileSync(python, ["-I", "-B", "-c",
      "import ctypes, hashlib, json, pathlib, secrets, socket, ssl, subprocess, urllib.request, xml.etree.ElementTree, zipfile; import sys; assert sys.flags.isolated and sys.flags.no_site; assert sys.version_info[:3] == (3, 12, 10)"], { env, stdio: "inherit" });
    for (const script of ["../tools/hub-root/wizard_bridge.py", "../install_webui.py"]) {
      execFileSync(python, ["-B", path.resolve(script), "--help"], { env, stdio: "pipe" });
    }
    console.log("stage-wizard-runtime-win: isolated runtime and entry points passed (no host Python)");
  }
  console.log(`stage-wizard-runtime-win: ready in ${target}`);
}
main().catch((err) => { console.error(err); process.exitCode = 1; });
NODE
