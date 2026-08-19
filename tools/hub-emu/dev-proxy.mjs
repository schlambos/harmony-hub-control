#!/usr/bin/env node
// hub-emu dev proxy — serves the redesigned front-end (tools/webui-sim/public)
// and BYTE-FORWARDS /api/*, /export/* and the legacy setup-page POST routes
// (/system, /mqtt, /wifi, /import, /ir/*, /bt/*) to the real codex_webui
// binary in the hub-emu container. No request or response interpretation:
// what the box's parser sees is exactly what the browser sent.
//
//   front-end + API : http://127.0.0.1:8787         (this process)
//   real backend    : http://127.0.0.1:8788         (container, codex_webui)
//   control plane   : http://127.0.0.1:8789         (container, engine-emu)
//
// Emulator management is deliberately OUTSIDE the emulated surface:
//   POST /sim/reset  -> control /reset     GET /sim/events -> control /events
//   GET  /sim/status -> control /status
//
// SIMULATED HUB — binds 127.0.0.1 only, never contacts 192.168.0.123.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(HERE, "..", "webui-sim", "public");
// The shell lazy-loads the vendor editor from the hub's absolute routes;
// in emulation those map onto the vendored copies under public/vendor/.
const ASSET_ALIASES = {
  "/assets/activity-ui.js": "/vendor/activity-ui.js",
  "/assets/activity-ui.css": "/vendor/activity-ui.css"
};
const HOST = "127.0.0.1";
const PORT = Number(process.env.PORT || 8787);
const BACKEND_PORT = Number(process.env.BACKEND_PORT || 8788);
const CONTROL_PORT = Number(process.env.CONTROL_PORT || 8789);

// Legacy setup handlers on the box are POST-only form parsers answering
// compact result HTML. Forward exactly these routes — nothing else leaves
// the static UI.
const SETUP_POST_EXACT = new Set(["/system", "/mqtt", "/wifi", "/import"]);
const SETUP_POST_PREFIXES = ["/ir/", "/bt/"];

function isSetupPost(req, pathname) {
  return req.method === "POST" &&
    (SETUP_POST_EXACT.has(pathname) || SETUP_POST_PREFIXES.some((prefix) => pathname.startsWith(prefix)));
}

// State-changing setup POSTs are only accepted from the loopback browser
// surface itself: Host must be the proxy's own 127.0.0.1:PORT or localhost:PORT,
// and Origin (when the browser sends one) must not name a different host.
function isLocalHostPort(value) {
  return value === `127.0.0.1:${PORT}` || value === `localhost:${PORT}`;
}

function isCrossOrigin(originHeader) {
  if (!originHeader) return false;
  let host;
  try {
    host = new URL(originHeader).host;
  } catch {
    return true;
  }
  return !isLocalHostPort(host);
}

function rejectStateChange(req, res) {
  if (!isLocalHostPort(req.headers.host)) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" }).end("forbidden: host\n");
    return true;
  }
  if (isCrossOrigin(req.headers.origin)) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" }).end("forbidden: origin\n");
    return true;
  }
  return false;
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

function forward(req, res, port, pathOverride) {
  const upstream = http.request(
    {
      host: "127.0.0.1",
      port,
      method: req.method,
      path: pathOverride ?? req.url,
      headers: { ...req.headers, host: `127.0.0.1:${port}` },
    },
    (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    }
  );
  upstream.on("error", (error) => {
    res.writeHead(502, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, error: `hub-emu unreachable on :${port} (${error.code ?? error.message})` }));
  });
  req.pipe(upstream);
}

function serveStatic(res, pathname) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    res.writeHead(400).end("bad path");
    return;
  }
  if (rel === "/") rel = "/index.html";
  const target = path.normalize(path.join(PUBLIC_DIR, rel));
  const prefix = PUBLIC_DIR + path.sep;
  if (target !== PUBLIC_DIR && !target.startsWith(prefix)) {
    res.writeHead(403).end("forbidden");
    return;
  }
  fs.readFile(target, (error, data) => {
    if (error) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("not found\n");
      return;
    }
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(target).toLowerCase()] ?? "application/octet-stream",
      "Content-Length": data.length,
      "Cache-Control": "no-store",
    });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const pathname = new URL(req.url ?? "/", `http://${HOST}:${PORT}`).pathname;
  if (pathname.startsWith("/api/") || pathname.startsWith("/export/") || isSetupPost(req, pathname)) {
    if (isSetupPost(req, pathname) && rejectStateChange(req, res)) return;
    forward(req, res, BACKEND_PORT);
    return;
  }
  if (pathname.startsWith("/sim/")) {
    forward(req, res, CONTROL_PORT, pathname.slice("/sim".length));
    return;
  }
  serveStatic(res, ASSET_ALIASES[pathname] ?? pathname);
});

server.listen(PORT, HOST, () => {
  console.log("hub-emu dev proxy — SIMULATED HUB, no live device");
  console.log(`  UI + 1:1 API   http://${HOST}:${PORT}/#control`);
  console.log(`  real backend   http://127.0.0.1:${BACKEND_PORT} (codex_webui, MIPS)`);
  console.log(`  control plane  http://127.0.0.1:${CONTROL_PORT} (reset/events/status)`);
});
