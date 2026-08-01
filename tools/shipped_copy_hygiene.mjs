#!/usr/bin/env node
/**
 * Fail when personal / fixture-specific identifiers leak into shipped code.
 *
 * Token set is DERIVED from activity + device inventory in fixtures/seeds —
 * not a hand-maintained denylist — so the next fixture refresh is covered.
 * Command names, button keys, and other non-inventory strings are ignored.
 *
 * Usage:
 *   node tools/shipped_copy_hygiene.mjs --check
 *   node tools/shipped_copy_hygiene.mjs --list-tokens
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const SHIPPED_ROOTS = [
  "tools/webui-sim/public",
  "payload/source",
  "payload/web",
  "payload/scripts",
  "payload/mqtt",
];

/**
 * Platform / firmware profile names that legitimately appear in shipped UI.
 * Keep short — if this list grows, tighten derivation instead.
 */
const ALLOWED_PHRASES = [
  {
    phrase: "SHIELD",
    reason: "Bluetooth HID profile label for Android TV / NVIDIA SHIELD (btkeyboard).",
  },
  {
    phrase: "Android TV",
    reason: "Bluetooth HID profile family name offered to every user.",
  },
  {
    phrase: "Nexus Player",
    reason: "Bluetooth HID profile variant btkeyboard-nexus.",
  },
  {
    phrase: "Fire TV",
    reason: "Bluetooth HID profile variant fire.",
  },
  {
    phrase: "PlayStation 3",
    reason: "Bluetooth HID profile variant ps3.",
  },
  {
    phrase: "Nintendo Wii",
    reason: "Bluetooth HID profile variant wii.",
  },
  {
    phrase: "Google TV",
    reason: "Pairing guidance for the standard keyboard profile family.",
  },
  {
    phrase: "NVIDIA SHIELD",
    reason: "Common marketing name for the SHIELD Android TV profile family.",
  },
];

/** Fixture type labels that are ordinary English, not household inventory. */
const GENERIC_NAME_ALLOW = new Set(
  [
    "television",
    "amplifier",
    "media player",
    "android tv",
    "music",
    "smart tv",
    "gameconsolewithdvd",
    "watch tv",
    "watch a movie",
    "play a game",
    "listen to music",
  ].map((s) => s.toLowerCase()),
);

const FIXTURE_PATHS = [
  "tools/webui-sim/fixtures/activity-config.json",
  "tools/hub-emu/seed/resources/ActivityList.json",
  "tools/hub-emu/seed/resources/DeviceList.json",
];

const TEXT_EXT = new Set([
  ".js", ".mjs", ".c", ".h", ".css", ".html", ".lua", ".sh", ".txt", ".md",
]);

function walkFiles(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === "node_modules" || ent.name.startsWith(".")) continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walkFiles(full, out);
    else if (TEXT_EXT.has(path.extname(ent.name).toLowerCase())) out.push(full);
  }
  return out;
}

function loadJson(rel) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function addId(set, value) {
  const s = String(value ?? "");
  if (/^\d{5,}$/.test(s)) set.add(s);
}

function addName(set, value) {
  const s = String(value ?? "").trim();
  if (s.length >= 4) set.add(s);
}

/** Only activity + device inventory — never command/function/button names. */
function collectInventory(data, into) {
  if (!data || typeof data !== "object") return;

  const activities =
    data.activityList?.Activities ||
    data.Activities ||
    (Array.isArray(data) ? null : null);
  const acts = data.activityList?.Activities || data.Activities;
  if (Array.isArray(acts)) {
    for (const a of acts) {
      addId(into.ids, a?.["Id-"] ?? a?.Id);
      addName(into.names, a?.Name);
      addName(into.names, a?.ActivityDisplayName);
    }
  }

  const dwf =
    data.deviceList?.DevicesWithFeatures ||
    data.DevicesWithFeatures;
  if (Array.isArray(dwf)) {
    for (const entry of dwf) {
      const d = entry?.Device || entry;
      addId(into.ids, d?.["Id-"] ?? d?.Id ?? entry?.id);
      addName(into.names, d?.Label);
      addName(into.names, d?.manufacturer);
      addName(into.names, d?.Manufacturer);
      addName(into.names, d?.Model);
      addName(into.names, d?.model);
      addName(into.names, d?.DeviceTypeDisplayName);
      addName(into.names, d?.deviceTypeDisplayName);
    }
  }
}

export function deriveForbiddenTokens() {
  const ids = new Set();
  const names = new Set();
  for (const rel of FIXTURE_PATHS) {
    collectInventory(loadJson(rel), { ids, names });
  }

  const allowedLower = new Set(
    ALLOWED_PHRASES.flatMap((a) => {
      const p = a.phrase.toLowerCase();
      return [p, ...p.split(/[\s/]+/).filter((w) => w.length >= 4)];
    }),
  );

  const nameTokens = [...names].filter((n) => {
    const low = n.toLowerCase();
    if (GENERIC_NAME_ALLOW.has(low)) return false;
    if (allowedLower.has(low)) return false;
    if (low === "shield" || low === "shield tv") return false;
    return true;
  });

  return {
    ids: [...ids].sort(),
    names: nameTokens.sort(),
    allowlist: ALLOWED_PHRASES,
  };
}

function isAllowedContext(snippet, token) {
  const lower = snippet.toLowerCase();
  const tok = String(token).toLowerCase();
  for (const { phrase } of ALLOWED_PHRASES) {
    const p = phrase.toLowerCase();
    if (p.includes(tok) && lower.includes(p)) return true;
  }
  if (
    tok === "shield" &&
    /android tv\s*\/\s*shield|nvidia shield|standard keyboard\s*\(android tv/.test(lower)
  ) {
    return true;
  }
  return false;
}

function findLeaks(filePath, text, tokens) {
  const hits = [];
  const rel = path.relative(ROOT, filePath);
  for (const id of tokens.ids) {
    const re = new RegExp(`(?<![0-9A-Za-z_])${id}(?![0-9A-Za-z_])`);
    if (re.test(text)) hits.push({ file: rel, token: id, kind: "id" });
  }
  for (const name of tokens.names) {
    const idx = text.toLowerCase().indexOf(name.toLowerCase());
    if (idx === -1) continue;
    const snippet = text.slice(Math.max(0, idx - 48), idx + name.length + 48);
    if (isAllowedContext(snippet, name)) continue;
    hits.push({ file: rel, token: name, kind: "name" });
  }
  return hits;
}

export function checkShippedCopyHygiene() {
  const tokens = deriveForbiddenTokens();
  const files = SHIPPED_ROOTS.flatMap((rel) => walkFiles(path.join(ROOT, rel)));
  const problems = [];
  for (const file of files) {
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    if (text.length > 12_000_000) continue;
    problems.push(...findLeaks(file, text, tokens));
  }
  const seen = new Set();
  const unique = [];
  for (const p of problems) {
    const k = `${p.file}|${p.kind}|${p.token}`;
    if (seen.has(k)) continue;
    seen.add(k);
    unique.push(p);
  }
  return { ok: unique.length === 0, problems: unique, tokens };
}

function main() {
  if (process.argv.includes("--list-tokens")) {
    console.log(JSON.stringify(deriveForbiddenTokens(), null, 2));
    return;
  }
  const result = checkShippedCopyHygiene();
  if (result.ok) {
    console.log("shipped_copy_hygiene: ok");
    console.log(
      `tokens: ${result.tokens.ids.length} ids, ${result.tokens.names.length} names; allowlist ${result.tokens.allowlist.length}`,
    );
    process.exit(0);
  }
  console.error("shipped_copy_hygiene: LEAK DETECTED");
  for (const p of result.problems) {
    console.error(`  - ${p.file}: ${p.kind} ${JSON.stringify(p.token)}`);
  }
  process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
