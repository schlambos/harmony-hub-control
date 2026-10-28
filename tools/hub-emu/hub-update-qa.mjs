#!/usr/bin/env node
// QA for desktop/src/hub-update/hub_update.sh (the hub-side update the apps
// run over SSH), inside the running hub-emu container. PATH is limited to
// the command names the real hub's BusyBox 1.13 has, so a script that calls
// anything else fails here. The container's shell and tools are Debian's, not
// BusyBox: the constructs the script relies on were also checked read-only on
// the real hub.
//
//   tools/hub-emu/run.sh && node tools/hub-emu/hub-update-qa.mjs

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, "..", "..", "desktop", "src", "hub-update", "hub_update.sh");
const C = "hub-emu";
const CTRL = "http://127.0.0.1:8789";
const HUB_APPLETS = ["[", "awk", "cat", "chmod", "cp", "cut", "date", "dirname", "echo", "expr", "grep", "kill", "killall",
  "ln", "ls", "md5sum", "mkdir", "mv", "ps", "reboot", "rm", "sed", "sh", "sleep", "test", "touch", "tr", "uname"];

let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "  ok " : "FAIL "} ${name}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) failed++;
};
const dx = (cmd, env = "") =>
  execFileSync("docker", ["exec", C, "sh", "-c", `${env} PATH=/tmp/hubpath ${cmd}`], { encoding: "utf8" });
const root = (cmd) => execFileSync("docker", ["exec", C, "sh", "-c", cmd], { encoding: "utf8" });
const md5 = (b) => crypto.createHash("md5").update(b).digest("hex");

function setup() {
  const missing = root(`rm -rf /tmp/hubpath && mkdir -p /tmp/hubpath /tmp/qa && for a in ${HUB_APPLETS.map((a) => `'${a}'`).join(" ")}; do
    p=$(command -v "$a" 2>/dev/null)
    case "$p" in /*) ln -s "$p" "/tmp/hubpath/$a" ;; "$a") ;; *) echo "$a" ;; esac; done`).trim();
  execFileSync("docker", ["cp", SCRIPT, `${C}:/tmp/qa/hub_update.sh`]);
  return missing;
}

/** Build a stage on this Mac and copy it into the container. files: [{dest, mode, reboot, body, md5?}] */
function stage(name, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hubqa-"));
  fs.mkdirSync(path.join(dir, "files"));
  const plan = files.map((f, i) => {
    const n = `f${i}_${path.basename(f.dest)}`;
    fs.writeFileSync(path.join(dir, "files", n), f.body);
    return `${f.md5 ?? md5(f.body)} ${f.mode ?? "755"} ${f.reboot ? 1 : 0} ${n} ${f.dest}`;
  });
  fs.writeFileSync(path.join(dir, "plan"), plan.join("\n") + "\n");
  const remote = `/var/volatile/codex-update-${name}`;
  root(`rm -rf ${remote}; mkdir -p /var/volatile`);
  execFileSync("docker", ["cp", dir, `${C}:${remote}`]);
  fs.rmSync(dir, { recursive: true, force: true });
  return remote;
}

function apply(remote, env = "") {
  try {
    dx(`sh /tmp/qa/hub_update.sh apply ${remote}`, env);
  } catch {}
  const log = root(`cat ${remote}/log 2>/dev/null || true`);
  return { log, result: (log.match(/^RESULT .*$/m) || ["(none)"])[0] };
}

const fileMd5 = (p) => root(`md5sum ${p} 2>/dev/null | cut -d' ' -f1 || true`).trim();

const missing = setup();
// Shell builtins need no file. The container has no killall (the hub does);
// the script only uses it to stop processes, with errors silenced.
check("every hub command the script needs exists in the container (killall aside)",
  missing.split(/\s+/).filter((a) => a && a !== "killall").length === 0, `missing: ${missing}`);

console.log("\n== status");
const status = dx("sh /tmp/qa/hub_update.sh status /data/codex/bin/codex_hbus /data/codex/bin/nope");
check("status reports md5, absent, free memory and hub_id",
  /^file [0-9a-f]{32} \/data\/codex\/bin\/codex_hbus$/m.test(status) && /^file absent \/data\/codex\/bin\/nope$/m.test(status) &&
  /^memfree_kb \d+$/m.test(status) && /^hub_id yes$/m.test(status), status);

console.log("\n== binary update: restart + health on :8080");
const hbusBefore = fileMd5("/data/codex/bin/codex_hbus");
const newHbus = Buffer.from("#!/bin/sh\necho new-hbus\n");
root("mkdir -p /data/codex-backups && for s in 20261027-120000 20261026-120000 20261028-090000 20261025-120000; do mkdir -p /data/codex-backups/webui-handoff-$s; done");
let r = apply(stage("a", [{ dest: "/data/codex/bin/codex_hbus", body: newHbus }]));
check("RESULT ok restarted", r.result === "RESULT ok restarted", r.log);
check("codex_hbus replaced and executable", fileMd5("/data/codex/bin/codex_hbus") === md5(newHbus) &&
  root("[ -x /data/codex/bin/codex_hbus ] && echo x").trim() === "x");
check("no .codex-new left", root("ls /data/codex/bin | grep -c codex-new || true").trim() === "0");
const handoffs = root("ls /data/codex-backups").trim().split(/\s+/).filter((n) => n.startsWith("webui-handoff-")).sort();
check("handoff written in the installer's format and pruned to the newest 3",
  handoffs.length === 3 && handoffs[0] === "webui-handoff-20261027-120000" && handoffs[1] === "webui-handoff-20261028-090000" &&
  r.log.includes(`STEP handoff /data/codex-backups/${handoffs[2]}`), handoffs.join(" "));
check("staged files and RAM copies removed after success", root("ls /var/volatile/codex-update-a").trim().split(/\s+/).sort().join(" ") === "done log plan");

console.log("\n== damaged staged file");
const before = fileMd5("/data/codex/bin/codex_hbus");
r = apply(stage("b", [{ dest: "/data/codex/bin/codex_hbus", body: Buffer.from("x"), md5: "0".repeat(32) }]));
check("RESULT nothing-changed", r.result.startsWith("RESULT nothing-changed"), r.log);
check("codex_hbus untouched", fileMd5("/data/codex/bin/codex_hbus") === before);

console.log("\n== flash write fails half way (phase 1)");
root("rm -rf /data/codex/notadir; : > /data/codex/notadir");
r = apply(stage("c", [
  { dest: "/data/codex/bin/codex_hbus", body: Buffer.from("#!/bin/sh\necho c\n") },
  { dest: "/data/codex/notadir/x", body: Buffer.from("y") },
]));
check("RESULT nothing-changed", r.result.startsWith("RESULT nothing-changed"), r.log);
check("first file untouched and its .codex-new removed",
  fileMd5("/data/codex/bin/codex_hbus") === before && root("ls /data/codex/bin | grep -c codex-new || true").trim() === "0");
root("rm -f /data/codex/notadir");

console.log("\n== new software doesn't come up: roll back");
r = apply(stage("d", [
  { dest: "/data/codex/bin/codex_hbus", body: Buffer.from("#!/bin/sh\necho broken\n") },
  { dest: "/data/codex/bin/codex_brand_new", body: Buffer.from("#!/bin/sh\n") },
]), "HEALTH_PORT_HEX=FFFF HEALTH_WAIT=2");
check("RESULT rolled-back", r.result.startsWith("RESULT rolled-back"), r.log);
check("codex_hbus restored, the new file removed",
  fileMd5("/data/codex/bin/codex_hbus") === before && root("[ -e /data/codex/bin/codex_brand_new ] && echo y || echo n").trim() === "n");

console.log("\n== plugin change: reboot instead of restart");
const rebootsBefore = JSON.parse(execFileSync("curl", ["-s", `${CTRL}/status`], { encoding: "utf8" })).rebootCount ?? 0;
r = apply(stage("e", [{ dest: "/pkg/codexactivity/codexactivity.lua", mode: "644", reboot: true, body: Buffer.from("-- plugin\n") }]));
check("RESULT ok reboot", r.result === "RESULT ok reboot", r.log);
let rebootsAfter = rebootsBefore;
for (let i = 0; i < 10 && rebootsAfter === rebootsBefore; i++) {
  execFileSync("sleep", ["1"]);
  rebootsAfter = JSON.parse(execFileSync("curl", ["-s", `${CTRL}/status`], { encoding: "utf8" })).rebootCount ?? 0;
}
check("the reboot was requested", rebootsAfter === rebootsBefore + 1, `${rebootsBefore} -> ${rebootsAfter}`);
check("plugin installed with mode 644", root("ls -l /pkg/codexactivity/codexactivity.lua | cut -c1-10").trim() === "-rw-r--r--");

console.log("\n== hub without a Melodious setup");
root("mv /data/codex/hub_id /data/codex/hub_id.qa");
r = apply(stage("f", [{ dest: "/data/codex/bin/codex_hbus", body: newHbus }]));
root("mv /data/codex/hub_id.qa /data/codex/hub_id");
check("RESULT refused", r.result.startsWith("RESULT refused"), r.log);

execFileSync("curl", ["-s", "-X", "POST", `${CTRL}/reset`]);
root("rm -rf /var/volatile/codex-update-* /data/codex-backups/webui-handoff-* /pkg/codexactivity /tmp/qa /tmp/hubpath");
console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
