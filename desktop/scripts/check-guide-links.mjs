#!/usr/bin/env node
// Local links/images and GitHub-style heading anchors in the README and the docs it routes to.
// No HTTP requests: in particular, never probe example hub addresses in docs.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const files = [
  "README.md", "docs/SETUP_GUIDE.md", "docs/DEVICES_AND_CODES_GUIDE.md", "docs/ACTIVITIES_GUIDE.md",
  "docs/COMPATIBILITY.md", "docs/BLUETOOTH_KEYBOARD.md", "docs/ARCHITECTURE.md", "docs/MELODIOUS_WEB_UI.md",
  "docs/SECURITY.md", "docs/HOME_ASSISTANT.md", "docs/INSTALL.md", "docs/DESKTOP_APP.md",
  "docs/REMOTE_BACKGROUNDS.md", "Android/README.md", "desktop/README.md",
];
const withoutCode = (s) => s.replace(/^```[^\n]*\n[\s\S]*?^```\s*$/gm, "");
const slug = (s) => s.toLowerCase()
  .replace(/<[^>]+>/g, "").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
  .replace(/[^\p{L}\p{N}\p{M}_\-\s]/gu, "").replace(/ /g, "-");
function anchors(file) {
  const text = withoutCode(fs.readFileSync(file, "utf8"));
  const found = new Set([...text.matchAll(/\b(?:id|name)=["']([^"']+)["']/g)].map((m) => m[1]));
  const counts = new Map();
  for (const m of text.matchAll(/^#{1,6}\s+(.+?)(?:\s+#+)?\s*$/gm)) {
    const id = slug(m[1]);
    const n = counts.get(id) || 0;
    counts.set(id, n + 1);
    found.add(n ? `${id}-${n}` : id);
  }
  return found;
}
let local = 0, external = 0;
const failures = [];
for (const relative of files) {
  const file = path.join(repo, relative);
  const text = withoutCode(fs.readFileSync(file, "utf8"));
  const links = [
    ...[...text.matchAll(/!?\[[^\]]*\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g)].map((m) => m[1]),
    ...[...text.matchAll(/\b(?:href|src)=["']([^"']+)["']/g)].map((m) => m[1]),
  ];
  for (const href of links) {
    if (/^[a-z][a-z\d+.-]*:/i.test(href)) {
      // Check URL syntax only. Online availability is not a local link check.
      try { new URL(href); external++; } catch { failures.push(`${relative}: invalid URL ${href}`); }
      continue;
    }
    local++;
    const [pathname, hash] = href.split("#");
    const target = pathname ? path.resolve(path.dirname(file), decodeURIComponent(pathname.split("?")[0])) : file;
    if (!fs.existsSync(target)) failures.push(`${relative}: missing ${href}`);
    else if (hash && /\.md$/i.test(target) && !anchors(target).has(decodeURIComponent(hash))) failures.push(`${relative}: missing anchor ${href}`);
  }
}
for (const failure of failures) console.error(failure);
assert.equal(failures.length, 0, "Broken guide links");
console.log(`${local} local links/images/anchors resolve; ${external} external URLs have valid syntax (not fetched).`);
