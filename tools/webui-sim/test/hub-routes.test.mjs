import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/* The shell and the vendored activity editor call hub routes by literal path,
   and codex_webui.c must route every one of them: the System view called
   /api/system-status for two months while the hub answered 404. */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const PUBLIC = join(ROOT, "tools/webui-sim/public");
const SERVER = readFileSync(join(ROOT, "payload/source/codex_webui.c"), "utf8");

// A quoted literal that starts with a hub route, cut at the query string or
// at a template-literal placeholder.
const CALLED_ROUTE = /["'`](\/(?:api|ir|bt|export)\/[A-Za-z0-9_\-/]+|\/(?:system|import|mqtt|wifi))(?=["'`?$])/g;
// codex_webui.c routes with strcmp/strncmp on the path, or path_is().
const SERVED_ROUTE = /(?:strn?cmp|path_is)\(req(?:->|\.)path, "([^"]+)"/g;

function jsFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return jsFiles(path);
    return entry.name.endsWith(".js") ? [path] : [];
  });
}

function calledRoutes() {
  const routes = new Map();
  for (const file of [...jsFiles(join(PUBLIC, "js")), ...jsFiles(join(PUBLIC, "vendor"))]) {
    for (const [, route] of readFileSync(file, "utf8").matchAll(CALLED_ROUTE)) {
      if (!routes.has(route)) routes.set(route, file.slice(PUBLIC.length + 1));
    }
  }
  return routes;
}

describe("hub routes", () => {
  it("codex_webui routes every hub path the UI calls", () => {
    const served = new Set([...SERVER.matchAll(SERVED_ROUTE)].map((m) => m[1]));
    const missing = [...calledRoutes()]
      .filter(([route]) => !served.has(route))
      .map(([route, file]) => `${route} (${file})`);
    assert.deepEqual(missing, []);
  });

  it("sees query-string and template-literal calls", () => {
    const routes = calledRoutes();
    assert.ok(routes.has("/api/system-status"));
    assert.ok(routes.has("/api/state"));
    assert.ok(routes.has("/api/remotecentral-fetch"));
    assert.ok(routes.has("/ir/delete-device"));
  });
});
