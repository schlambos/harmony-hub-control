#!/usr/bin/env node
/**
 * Canonical payload binary inventory — single source of truth is
 * payload/bin/MANIFEST.txt (md5 + filename lines).
 *
 * Roles derived from the manifest:
 *   install  — every MANIFEST name (uploaded by installers)
 *   update   — every MANIFEST name except dropbearmulti (C UPDATE_FILES /
 *              browser allow-list; dropbear is install-only plumbing)
 *   restart  — daemons init.sh / post-apply restart must relaunch
 *
 * Usage:
 *   node tools/payload_bin_inventory.mjs           # print inventory JSON
 *   node tools/payload_bin_inventory.mjs --check   # fail on consumer drift
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST_PATH = path.join(ROOT, "payload/bin/MANIFEST.txt");
const BIN_DIR = path.join(ROOT, "payload/bin");

/** Install-only: not part of the browser/C staged update allow-list. */
const INSTALL_ONLY = new Set(["dropbearmulti"]);

/** Daemons that must come back after update-apply restart (matches init.sh). */
const RESTART_SET = [
  "codex_bt_pair_agent",
  "codex_bthid_keyboard",
  "codex_webui",
];

export function parseManifest(text) {
  const entries = [];
  for (const line of String(text || "").replace(/\r/g, "").split("\n")) {
    const m = line.match(/^([0-9a-fA-F]{32})\s+(\S+)\s*$/);
    if (!m) continue;
    entries.push({ md5: m[1].toLowerCase(), name: m[2] });
  }
  return entries;
}

export function buildInventory(manifestText) {
  const entries = parseManifest(manifestText);
  const install = entries.map((e) => e.name);
  const update = install.filter((n) => !INSTALL_ONLY.has(n));
  return {
    source: "payload/bin/MANIFEST.txt",
    entries,
    install,
    update,
    restart: RESTART_SET.slice(),
    installOnly: [...INSTALL_ONLY],
  };
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

function extractCUpdateFiles(src) {
  const block = src.match(
    /static const char \*UPDATE_FILES\[\] = \{([\s\S]*?)\};/,
  );
  if (!block) return null;
  return [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

function extractEmbeddedUpdateNames(src) {
  const m = src.match(/const UPDATE_NAMES=\[([^\]]+)\]/);
  if (!m) return null;
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

function extractPyUploadNames(src) {
  const names = [];
  const re =
    /upload_bytes\(\s*PAYLOAD\s*\/\s*"bin"\s*\/\s*"([^"]+)"/g;
  let m;
  while ((m = re.exec(src))) names.push(m[1]);
  return names;
}

function extractPs1UploadNames(src) {
  const names = [];
  const re =
    /Upload-Bytes\s+\(Join-Path\s+\$Payload\s+"bin\\([^"]+)"\)/g;
  let m;
  while ((m = re.exec(src))) names.push(m[1]);
  return names;
}

function sameSet(a, b) {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

export function checkDrift(inventory = buildInventory(fs.readFileSync(MANIFEST_PATH, "utf8"))) {
  const problems = [];

  for (const name of inventory.install) {
    const p = path.join(BIN_DIR, name);
    if (!fs.existsSync(p)) {
      problems.push(`MANIFEST lists ${name} but payload/bin/${name} is missing`);
    }
  }

  const cSrc = read("payload/source/codex_webui.c");
  const cUpdate = extractCUpdateFiles(cSrc);
  if (!cUpdate) {
    problems.push("could not parse UPDATE_FILES[] from codex_webui.c");
  } else if (!sameSet(cUpdate, inventory.update)) {
    problems.push(
      `UPDATE_FILES[] drift: C=[${cUpdate.join(",")}] inventory.update=[${inventory.update.join(",")}]`,
    );
  }

  const embedded = extractEmbeddedUpdateNames(cSrc);
  if (!embedded) {
    problems.push("could not parse embedded UPDATE_NAMES from codex_webui.c");
  } else if (!sameSet(embedded, inventory.update)) {
    problems.push(
      `embedded UPDATE_NAMES drift: js=[${embedded.join(",")}] inventory.update=[${inventory.update.join(",")}]`,
    );
  }

  /* Restart must relaunch pair agent the way init.sh does (BT_PAIR_AGENT_BIN + flags). */
  const restartBlock = cSrc.match(
    /if \(restart\) \{[\s\S]*?execl\("\/bin\/sh"[\s\S]*?_exit\(127\);/,
  );
  if (!restartBlock) {
    problems.push("could not locate update-apply restart execl block");
  } else {
    const block = restartBlock[0];
    if (!/killall codex_bt_pair_agent/.test(block)) {
      problems.push("update-apply restart does not stop codex_bt_pair_agent");
    }
    if (!/BT_PAIR_AGENT_BIN/.test(block) || !/--hid-control-daemon/.test(block)) {
      problems.push(
        "update-apply restart does not relaunch pair agent with init.sh --hid-control-daemon flags",
      );
    }
    if (/killall codex_bt_pair_agent/.test(block) && !/--hid-control-daemon/.test(block)) {
      problems.push("update-apply kills pair agent without relaunch");
    }
  }

  /* Hardcoded upstream self-update must not be the default. */
  if (/UPDATE_DEFAULT_RAW='https:\/\//.test(cSrc)) {
    problems.push("embedded UPDATE_DEFAULT_RAW still points at a public URL");
  }
  if (/value='https:\/\/raw\.githubusercontent\.com\//.test(cSrc)) {
    problems.push("legacy system page pre-fills a public updateRepo URL");
  }
  if (/"repo":"https:\/\/github\.com\//.test(cSrc) ||
      /\\"repo\\":\\"https:\/\/github\.com\//.test(cSrc) ||
      /"repo":"https:\/\/github\.com\/Ripthulhu/.test(cSrc) ||
      /repo\\":\\"https:\/\/github\.com\/Ripthulhu/.test(cSrc)) {
    problems.push("update-status JSON still advertises a public github repo URL");
  }
  /* Direct string form used by fputs in render_update_status_json */
  if (/fputs\("\{\\"ok\\":true,\\"repo\\":\\"https:\/\//.test(cSrc) ||
      /"repo":"https:\/\/github\.com\/Ripthulhu\/harmony-hub-control"/.test(cSrc)) {
    problems.push("render_update_status_json still embeds a public repo URL");
  }

  const py = read("install_webui.py");
  const pyNames = extractPyUploadNames(py);
  const pyReadsManifest =
    /MANIFEST\.txt/.test(py) && /bin_manifest_names|manifest_names|MANIFEST/.test(py);
  if (pyReadsManifest) {
    /* Preferred: installer derives uploads from MANIFEST. */
  } else if (!pyNames.length) {
    problems.push("install_webui.py does not upload bin/* and does not read MANIFEST.txt");
  } else if (!sameSet(pyNames, inventory.install)) {
    problems.push(
      `install_webui.py upload drift: py=[${pyNames.join(",")}] inventory.install=[${inventory.install.join(",")}]`,
    );
  }
  if (!py.includes("codex_bt_pair_agent") && !pyReadsManifest) {
    problems.push("install_webui.py omits codex_bt_pair_agent");
  }

  const ps1 = read("install_webui.ps1");
  const psNames = extractPs1UploadNames(ps1);
  const psReadsManifest = /MANIFEST\.txt/.test(ps1);
  if (psReadsManifest) {
    /* Preferred: installer derives uploads from MANIFEST. */
  } else if (!psNames.length) {
    problems.push("install_webui.ps1 does not upload bin/* and does not read MANIFEST.txt");
  } else if (!sameSet(psNames, inventory.install)) {
    problems.push(
      `install_webui.ps1 upload drift: ps1=[${psNames.join(",")}] inventory.install=[${inventory.install.join(",")}]`,
    );
  }

  for (const name of inventory.restart) {
    if (!inventory.update.includes(name)) {
      problems.push(`restart set member ${name} is not in update inventory`);
    }
  }

  return { ok: problems.length === 0, problems, inventory };
}

function main() {
  const check = process.argv.includes("--check");
  const inv = buildInventory(fs.readFileSync(MANIFEST_PATH, "utf8"));
  if (!check) {
    console.log(JSON.stringify(inv, null, 2));
    return;
  }
  const result = checkDrift(inv);
  if (result.ok) {
    console.log("payload_bin_inventory: ok");
    console.log(
      `install=${inv.install.length} update=${inv.update.length} restart=${inv.restart.join(",")}`,
    );
    process.exit(0);
  }
  console.error("payload_bin_inventory: DRIFT DETECTED");
  for (const p of result.problems) console.error(`  - ${p}`);
  process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}` ||
    process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
