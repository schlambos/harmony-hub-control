import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  computeInlineScriptSha256,
  buildCsp,
  validateForwardPath,
  extractRawTargetFromUrl,
  buildForwardRequestHeaders,
  filterForwardResponseHeaders,
  createSchemeHandler,
} = require("../src/scheme.js");

function makeTempShellDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "melodious-shell-test-"));
  const inline = "window.HARMONY_SIM=false;window.HARMONY_PRODUCTION=true;";
  fs.writeFileSync(
    path.join(dir, "index.html"),
    `<!doctype html><html><head><script>${inline}</script><script src="/assets/harmony-shell.js" defer></script></head><body>ok</body></html>`
  );
  fs.writeFileSync(path.join(dir, "harmony-shell.js"), "console.log('shell');");
  fs.writeFileSync(path.join(dir, "harmony-shell.css"), "body{background:#0e1014}");
  fs.writeFileSync(path.join(dir, "activity-ui.js"), "console.log('editor');");
  fs.writeFileSync(path.join(dir, "activity-ui.css"), ".editor{}");
  return { dir, inline };
}

test("computeInlineScriptSha256 and buildCsp hash the single inline script", () => {
  const { dir, inline } = makeTempShellDir();
  try {
    const html = fs.readFileSync(path.join(dir, "index.html"), "utf8");
    const expectedHash = crypto.createHash("sha256").update(inline, "utf8").digest("base64");
    assert.equal(computeInlineScriptSha256(html), expectedHash);
    const lf = crypto.createHash("sha256").update("a();\nb();\n", "utf8").digest("base64");
    assert.equal(computeInlineScriptSha256("<script>a();\r\nb();\r</script>"), lf, "hashed as the HTML parser reads it");
    const csp = buildCsp(html);
    assert.equal(
      csp,
      `default-src 'none'; script-src 'self' 'sha256-${expectedHash}'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' https://cdn.jsdelivr.net https://data.jsdelivr.com; form-action 'self'; base-uri 'none'; frame-src 'none'; object-src 'none'`
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("validateForwardPath and extractRawTargetFromUrl refuse absolute URLs, //, \\, and CR/LF", () => {
  assert.deepEqual(validateForwardPath("/api/activity-config"), {
    ok: true,
    path: "/api/activity-config",
  });
  assert.deepEqual(validateForwardPath("/api/state?version=42"), {
    ok: true,
    path: "/api/state?version=42",
  });

  const rejected = [
    "",
    "api/state",
    "http://example.com/api/state",
    "https://example.com/api/state",
    "//example.com/api/state",
    "/api//state",
    "/api/%2f%2fstate",
    "/api\\state",
    "/api/%5cstate",
    "/api/%5Cstate",
    "/api/state\r\nX-Injected: 1",
    "/api/state\n",
    "/api/state\r",
    "/api/state%0d%0a",
    "/api/state%0a",
    "/api/state\u0000",
    "/api/state?next=http://evil.example",
  ];
  for (const bad of rejected) {
    assert.equal(
      validateForwardPath(bad).ok,
      false,
      `Expected path ${JSON.stringify(bad)} to be rejected`
    );
  }

  assert.equal(extractRawTargetFromUrl("melodious://app//evil").ok, false);
  assert.equal(extractRawTargetFromUrl("melodious://app/api\\evil").ok, false);
  assert.equal(extractRawTargetFromUrl("melodious://other/api/state").ok, false);
  assert.equal(extractRawTargetFromUrl("http://app/api/state").ok, false);
  assert.equal(extractRawTargetFromUrl("melodious://app/api/state\r\n").ok, false);
});

test("buildForwardRequestHeaders enforces allowlist and Authorization precedence", () => {
  const incoming = {
    "Content-Type": "application/json",
    Accept: "application/json",
    Cookie: "secret=1",
    Origin: "melodious://app",
    Referer: "melodious://app/",
    "User-Agent": "CustomUA",
    "X-Custom": "ignored",
  };

  const withSaved = buildForwardRequestHeaders(incoming, "Basic c2F2ZWQ6cGFzcw==");
  assert.equal(withSaved.hadExplicitAuth, false);
  assert.deepEqual(withSaved.headers, {
    "Content-Type": "application/json",
    Accept: "application/json",
    Authorization: "Basic c2F2ZWQ6cGFzcw==",
  });

  const withExplicit = buildForwardRequestHeaders(
    { ...incoming, Authorization: "Basic ZXhwbGljaXQ6cGFzcw==" },
    "Basic c2F2ZWQ6cGFzcw=="
  );
  assert.equal(withExplicit.hadExplicitAuth, true);
  assert.equal(withExplicit.headers.Authorization, "Basic ZXhwbGljaXQ6cGFzcw==");
});

test("filterForwardResponseHeaders strips WWW-Authenticate and Set-Cookie", () => {
  const filtered = filterForwardResponseHeaders({
    "content-type": "application/json; charset=utf-8",
    "content-disposition": 'attachment; filename="backup.json"',
    "cache-control": "no-store",
    "www-authenticate": 'Basic realm="Harmony Hub Control"',
    "set-cookie": ["a=1; HttpOnly", "b=2"],
    server: "codex_webui",
  });
  assert.deepEqual(filtered, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Disposition": 'attachment; filename="backup.json"',
    "Cache-Control": "no-store",
  });
  assert.equal("www-authenticate" in filtered, false);
  assert.equal("WWW-Authenticate" in filtered, false);
  assert.equal("set-cookie" in filtered, false);
  assert.equal("Set-Cookie" in filtered, false);
});

test("scheme handler serves the 5 bundle files and forwards other paths with 401/502 handling, Content-Length framing and abort", async () => {
  const { dir } = makeTempShellDir();
  let lastReq = null;
  let nextStatus = 200;
  let nextHeaders = {
    "Content-Type": "application/json; charset=utf-8",
    "WWW-Authenticate": 'Basic realm="Harmony Hub Control"',
    "Set-Cookie": "sid=123",
  };
  let nextBody = JSON.stringify({ ok: true });
  let holdOpenMs = 0;
  let upstreamAborted = false;

  const server = http.createServer((req, res) => {
    const declaredLength = Number(req.headers["content-length"] ?? 0);
    if (
      req.method !== "GET" &&
      req.method !== "HEAD" &&
      (!Number.isInteger(declaredLength) || req.headers["transfer-encoding"])
    ) {
      res.writeHead(411, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: "hub requires Content-Length" }));
      return;
    }
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("aborted", () => {
      upstreamAborted = true;
    });
    req.on("close", () => {
      if (!res.writableEnded) upstreamAborted = true;
    });
    req.on("end", async () => {
      const body = Buffer.concat(chunks).toString("utf8");
      lastReq = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body,
      };
      if (holdOpenMs > 0) {
        await new Promise((r) => setTimeout(r, holdOpenMs));
      }
      if (res.destroyed) return;

      if (declaredLength !== Buffer.byteLength(body)) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: "content-length mismatch" }));
        return;
      }
      if (req.method === "POST" && req.url === "/api/activity-run") {
        const params = new URLSearchParams(body);
        if (!/^-?\d+$/.test(params.get("activityId") ?? "")) {
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          res.end(
            JSON.stringify({
              ok: false,
              error: "activityId must be -1 or a non-negative integer",
            })
          );
          return;
        }
      }
      if (req.method === "POST" && req.url === "/api/ir-send") {
        const params = new URLSearchParams(body);
        if (!params.get("deviceId") || !params.get("command")) {
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          res.end(
            JSON.stringify({ ok: false, error: "invalid IR command request" })
          );
          return;
        }
      }

      res.writeHead(nextStatus, nextHeaders);
      if (nextStatus === 304 || nextStatus === 204) {
        res.end();
      } else {
        res.end(nextBody);
      }
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  let hubConfig = { host: "127.0.0.1", port };
  let savedAuth = "Basic c2F2ZWQ6b2s=";
  const authAlerts = [];
  const unreachableAlerts = [];

  const handler = createSchemeHandler({
    shellDir: dir,
    getHub: () => hubConfig,
    getSavedAuthHeader: () => savedAuth,
    connectTimeoutMs: 100,
    totalTimeoutMs: 150,
    onHubAuthRequired: (info) => authAlerts.push(info),
    onHubUnreachable: (info) => unreachableAlerts.push(info),
  });

  try {
    // 1. Serves the 5 bundle files with CSP on index.html
    for (const [p, expectedType] of [
      ["/", "text/html; charset=utf-8"],
      ["/index.html", "text/html; charset=utf-8"],
      ["/assets/harmony-shell.js", "application/javascript; charset=utf-8"],
      ["/assets/harmony-shell.css", "text/css; charset=utf-8"],
      ["/assets/activity-ui.js", "application/javascript; charset=utf-8"],
      ["/assets/activity-ui.css", "text/css; charset=utf-8"],
    ]) {
      const res = await handler.handle(new Request(`melodious://app${p}`));
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("content-type"), expectedType);
      assert.equal(res.headers.get("cache-control"), "no-store");
      if (p === "/" || p === "/index.html") {
        assert.equal(res.headers.get("content-security-policy"), handler.csp);
      }
    }

    // 2. Forwards GET and uses saved Basic auth, stripping WWW-Authenticate & Set-Cookie
    const apiRes = await handler.handle(
      new Request("melodious://app/api/activity-config", {
        headers: { Accept: "application/json", "X-Extra": "drop-me" },
      })
    );
    assert.equal(apiRes.status, 200);
    assert.equal(apiRes.headers.get("www-authenticate"), null);
    assert.equal(apiRes.headers.get("set-cookie"), null);
    assert.equal(lastReq.url, "/api/activity-config");
    assert.equal(lastReq.headers.authorization, "Basic c2F2ZWQ6b2s=");
    assert.equal(lastReq.headers["x-extra"], undefined);

    // 3. Explicit Authorization from page wins over saved Basic header
    await handler.handle(
      new Request("melodious://app/api/system-status", {
        headers: { Authorization: "Basic cGFnZTpwYXNz" },
      })
    );
    assert.equal(lastReq.headers.authorization, "Basic cGFnZTpwYXNz");

    // 4. 401 without explicit page Authorization triggers onHubAuthRequired
    nextStatus = 401;
    const res401 = await handler.handle(new Request("melodious://app/api/activity-config"));
    assert.equal(res401.status, 401);
    assert.equal(res401.headers.get("www-authenticate"), null);
    assert.equal(authAlerts.length, 1);

    // 4b. 401 WITH explicit page Authorization does NOT trigger onHubAuthRequired
    await handler.handle(
      new Request("melodious://app/api/system-status", {
        headers: { Authorization: "Basic d3Jvbmc6cGFzcw==" },
      })
    );
    assert.equal(authAlerts.length, 1);

    // 5. 304 Not Modified is handled cleanly with null body
    nextStatus = 304;
    const res304 = await handler.handle(new Request("melodious://app/api/state?version=1"));
    assert.equal(res304.status, 304);

    // 6. Forwards form POST bodies with an exact Content-Length and no chunked encoding
    nextStatus = 200;
    const activityBody = "activityId=123";
    const activityRes = await handler.handle(
      new Request("melodious://app/api/activity-run", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: activityBody,
      })
    );
    assert.equal(activityRes.status, 200);
    assert.equal(lastReq.method, "POST");
    assert.equal(lastReq.body, activityBody);
    assert.equal(lastReq.headers["content-length"], String(Buffer.byteLength(activityBody)));
    assert.equal(lastReq.headers["transfer-encoding"], undefined);

    const powerOffBody = "activityId=-1";
    const powerOffRes = await handler.handle(
      new Request("melodious://app/api/activity-run", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: powerOffBody,
      })
    );
    assert.equal(powerOffRes.status, 200);
    assert.equal(lastReq.body, powerOffBody);
    assert.equal(lastReq.headers["content-length"], String(Buffer.byteLength(powerOffBody)));
    assert.equal(lastReq.headers["transfer-encoding"], undefined);

    const irBody = "deviceId=42&command=PowerOff";
    const postRes = await handler.handle(
      new Request("melodious://app/api/ir-send", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: irBody,
      })
    );
    assert.equal(postRes.status, 200);
    assert.equal(lastReq.method, "POST");
    assert.equal(lastReq.body, irBody);
    assert.equal(lastReq.headers["content-length"], String(Buffer.byteLength(irBody)));
    assert.equal(lastReq.headers["transfer-encoding"], undefined);

    // 6a. An empty POST still carries Content-Length: 0
    const emptyRes = await handler.handle(
      new Request("melodious://app/api/ir-cancel", { method: "POST" })
    );
    assert.equal(emptyRes.status, 200);
    assert.equal(lastReq.body, "");
    assert.equal(lastReq.headers["content-length"], "0");
    assert.equal(lastReq.headers["transfer-encoding"], undefined);

    // 6b. Forwards JSON POST bodies with an exact Content-Length
    const jsonBody = '{"deviceId":"42","settings":{"powerType":"toggle"}}';
    const jsonRes = await handler.handle(
      new Request("melodious://app/api/device-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: jsonBody,
      })
    );
    assert.equal(jsonRes.status, 200);
    assert.equal(lastReq.body, jsonBody);
    assert.equal(lastReq.headers["content-type"], "application/json");
    assert.equal(lastReq.headers["content-length"], String(Buffer.byteLength(jsonBody)));
    assert.equal(lastReq.headers["transfer-encoding"], undefined);

    // 6c. Rejects bodies over the forwarding limit
    const tooBigBody = "x".repeat(64 * 1024 * 1024 + 1);
    const tooBigRes = await handler.handle(
      new Request("melodious://app/api/device-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: tooBigBody,
      })
    );
    assert.equal(tooBigRes.status, 413);
    assert.equal(lastReq.body, jsonBody);

    // 6d. A pre-aborted POST body settles as 499 instead of a body read error
    const acPre = new AbortController();
    acPre.abort();
    const preAbortedRes = await handler.handle(
      new Request("melodious://app/api/ir-send", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "deviceId=42&command=PowerOff",
        signal: acPre.signal,
      })
    );
    assert.equal(preAbortedRes.status, 499);

    // 7. Aborting page request aborts upstream request
    holdOpenMs = 500;
    upstreamAborted = false;
    const ac = new AbortController();
    const abortPromise = handler.handle(
      new Request("melodious://app/api/capture", { signal: ac.signal })
    );
    setTimeout(() => ac.abort(), 30);
    const abortedRes = await abortPromise;
    assert.equal(abortedRes.status, 499);
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(upstreamAborted, true);
    holdOpenMs = 0;

    // 8. Total timeout returns 502 and triggers onHubUnreachable
    holdOpenMs = 300;
    const beforeUnreachable = unreachableAlerts.length;
    const timeoutRes = await handler.handle(new Request("melodious://app/api/inventory"));
    assert.equal(timeoutRes.status, 502);
    assert.equal(unreachableAlerts.length, beforeUnreachable + 1);
    holdOpenMs = 0;

    // 9. Unreachable hub returns 502 and triggers onHubUnreachable
    hubConfig = { host: "127.0.0.1", port: 1 };
    const unreachRes = await handler.handle(new Request("melodious://app/api/state"));
    assert.equal(unreachRes.status, 502);
    assert.equal(unreachableAlerts.length, beforeUnreachable + 2);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
