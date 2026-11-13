"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { Readable } = require("node:stream");

const CONNECT_TIMEOUT_MS = 10_000;
const TOTAL_TIMEOUT_MS = 120_000;
const MAX_FORWARD_BODY_BYTES = 64 * 1024 * 1024;
const SCHEME_PREFIX = "melodious://app";

function computeInlineScriptSha256(html) {
  const source = String(html ?? "");
  const matches = [
    ...source.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi),
  ];
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly 1 inline <script> in shell HTML, found ${matches.length}`
    );
  }
  // The browser hashes the script as its HTML parser reads it, and the parser
  // turns CRLF and lone CR into LF (a Windows checkout may carry CRLF).
  const inlineCode = matches[0][1].replace(/\r\n?/g, "\n");
  return crypto.createHash("sha256").update(inlineCode, "utf8").digest("base64");
}

function buildCsp(html) {
  const hash = computeInlineScriptSha256(html);
  return [
    "default-src 'none'",
    `script-src 'self' 'sha256-${hash}'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self' https://cdn.jsdelivr.net https://data.jsdelivr.com",
    "form-action 'self'",
    "base-uri 'none'",
    "frame-src 'none'",
    "object-src 'none'",
  ].join("; ");
}

function validateForwardPath(rawTarget) {
  if (typeof rawTarget !== "string" || rawTarget.length === 0) {
    return { ok: false, error: "Empty request path" };
  }
  if (/[\r\n\u0000]/.test(rawTarget) || /%(?:0d|0a|00)/i.test(rawTarget)) {
    return { ok: false, error: "Control characters are not allowed in path" };
  }
  if (rawTarget.includes("\\") || /%5c/i.test(rawTarget)) {
    return { ok: false, error: "Backslashes are not allowed in path" };
  }
  if (!rawTarget.startsWith("/")) {
    return { ok: false, error: "Path must be relative and start with /" };
  }
  if (rawTarget.includes("//") || /%2f%2f/i.test(rawTarget) || rawTarget.includes("://")) {
    return { ok: false, error: "Double slashes and absolute URLs are not allowed" };
  }
  return { ok: true, path: rawTarget };
}

function getHeaderValue(headers, name) {
  if (!headers) return "";
  const lower = name.toLowerCase();
  if (typeof headers.get === "function") {
    return String(headers.get(name) ?? headers.get(lower) ?? "").trim();
  }
  if (typeof headers === "object") {
    for (const [k, v] of Object.entries(headers)) {
      if (k.toLowerCase() === lower && v != null) {
        return Array.isArray(v) ? v.join(", ").trim() : String(v).trim();
      }
    }
  }
  return "";
}

function isSafeHeaderValue(value) {
  return typeof value === "string" && !/[\r\n\u0000]/.test(value);
}

function buildForwardRequestHeaders(inHeaders, savedAuthHeader = null) {
  const out = {};
  const contentType = getHeaderValue(inHeaders, "content-type");
  if (contentType && isSafeHeaderValue(contentType)) {
    out["Content-Type"] = contentType;
  }
  const accept = getHeaderValue(inHeaders, "accept");
  if (accept && isSafeHeaderValue(accept)) {
    out.Accept = accept;
  }
  const pageAuth = getHeaderValue(inHeaders, "authorization");
  let hadExplicitAuth = false;
  if (pageAuth && isSafeHeaderValue(pageAuth)) {
    out.Authorization = pageAuth;
    hadExplicitAuth = true;
  } else if (savedAuthHeader && isSafeHeaderValue(savedAuthHeader)) {
    out.Authorization = savedAuthHeader;
  }
  return { headers: out, hadExplicitAuth };
}

function filterForwardResponseHeaders(upHeaders = {}) {
  const out = {
    "Cache-Control": "no-store",
  };
  const contentType = getHeaderValue(upHeaders, "content-type");
  if (contentType && isSafeHeaderValue(contentType)) {
    out["Content-Type"] = contentType;
  }
  const contentDisposition = getHeaderValue(upHeaders, "content-disposition");
  if (contentDisposition && isSafeHeaderValue(contentDisposition)) {
    out["Content-Disposition"] = contentDisposition;
  }
  const cacheControl = getHeaderValue(upHeaders, "cache-control");
  if (cacheControl && isSafeHeaderValue(cacheControl)) {
    out["Cache-Control"] = cacheControl;
  }
  return out;
}

function jsonResponse(status, payload, extraHeaders = {}) {
  return new Response(`${JSON.stringify(payload)}\n`, {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...extraHeaders,
    },
  });
}

function loadShellBundle(shellDir, connectDir = null) {
  const indexHtmlPath = path.join(shellDir, "index.html");
  const indexHtml = fs.readFileSync(indexHtmlPath, "utf8");
  if (indexHtml.includes("REMOTE_SKIN_SRC")) {
    throw new Error("unexpected photo seam in index.html; run bundle-shell.sh first");
  }
  const csp = buildCsp(indexHtml);

  const staticAssets = new Map([
    [
      "/assets/harmony-shell.js",
      {
        data: fs.readFileSync(path.join(shellDir, "harmony-shell.js")),
        contentType: "application/javascript; charset=utf-8",
      },
    ],
    [
      "/assets/harmony-shell.css",
      {
        data: fs.readFileSync(path.join(shellDir, "harmony-shell.css")),
        contentType: "text/css; charset=utf-8",
      },
    ],
    [
      "/assets/activity-ui.js",
      {
        data: fs.readFileSync(path.join(shellDir, "activity-ui.js")),
        contentType: "application/javascript; charset=utf-8",
      },
    ],
    [
      "/assets/activity-ui.css",
      {
        data: fs.readFileSync(path.join(shellDir, "activity-ui.css")),
        contentType: "text/css; charset=utf-8",
      },
    ],
  ]);

  let connectBundle = null;
  if (connectDir && fs.existsSync(path.join(connectDir, "index.html"))) {
    const connectHtmlRaw = fs.readFileSync(path.join(connectDir, "index.html"), "utf8");
    const connectJs = fs.readFileSync(path.join(connectDir, "connect.js"), "utf8");
    const connectHtml = connectHtmlRaw.replace(
      "<!-- CONNECT_SCRIPT -->",
      `<script>${connectJs}</script>`
    );
    const connectCsp = buildCsp(connectHtml);
    connectBundle = {
      html: Buffer.from(connectHtml, "utf8"),
      csp: connectCsp,
    };
  }

  return {
    indexBuffer: Buffer.from(indexHtml, "utf8"),
    csp,
    staticAssets,
    connectBundle,
  };
}

function extractRawTargetFromUrl(rawUrl) {
  const str = String(rawUrl ?? "");
  if (/[\r\n\u0000]/.test(str)) {
    return { ok: false, error: "Control characters in URL" };
  }
  if (!str.toLowerCase().startsWith(SCHEME_PREFIX)) {
    return { ok: false, error: "Invalid scheme or host" };
  }
  const rest = str.slice(SCHEME_PREFIX.length);
  if (rest && !rest.startsWith("/")) {
    return { ok: false, error: "Invalid scheme host" };
  }
  const withoutHash = rest.split("#")[0] || "/";
  return validateForwardPath(withoutHash);
}

async function readRequestBody(request, maxBytes = MAX_FORWARD_BODY_BYTES) {
  if (request.signal?.aborted) return Buffer.alloc(0);
  if (!request.body && typeof request.arrayBuffer !== "function") {
    return Buffer.alloc(0);
  }

  if (typeof request.arrayBuffer === "function") {
    const value = await request.arrayBuffer();
    const body = Buffer.from(value);
    if (body.length > maxBytes) {
      throw new Error("Request body is too large for this hub");
    }
    return body;
  }

  const chunks = [];
  let total = 0;
  for await (const chunk of request.body) {
    if (request.signal?.aborted) throw new Error("Request aborted");
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > maxBytes) throw new Error("Request body is too large for this hub");
    chunks.push(buf);
  }
  return Buffer.concat(chunks, total);
}

function forwardToHub({
  request,
  targetPath,
  hub,
  savedAuthHeader = null,
  connectTimeoutMs = CONNECT_TIMEOUT_MS,
  totalTimeoutMs = TOTAL_TIMEOUT_MS,
  requestImpl = http.request,
  onHubAuthRequired,
  onHubUnreachable,
}) {
  return (async () => {
    if (!hub || !hub.host || !hub.port) {
      onHubUnreachable?.({ host: "", port: 0, path: targetPath });
      return jsonResponse(502, { ok: false, error: "No hub configured" });
    }

    const method = String(request.method || "GET").toUpperCase();
    const { headers, hadExplicitAuth } = buildForwardRequestHeaders(
      request.headers,
      savedAuthHeader
    );

    let body;
    if (method !== "GET" && method !== "HEAD") {
      if (request.signal?.aborted) {
        return jsonResponse(499, { ok: false, error: "Request aborted" });
      }
      try {
        body = await readRequestBody(request);
      } catch (err) {
        if (request.signal?.aborted || /aborted/i.test(err?.message || "")) {
          return jsonResponse(499, { ok: false, error: "Request aborted" });
        }
        return jsonResponse(413, { ok: false, error: err.message || "Request body is too large for this hub" });
      }
      if (request.signal?.aborted) {
        return jsonResponse(499, { ok: false, error: "Request aborted" });
      }
    } else {
      body = Buffer.alloc(0);
    }

    return new Promise((resolve) => {
      // codex_webui reads a body only by Content-Length (no chunked parsing),
      // so every non-GET request carries an explicit length, even 0.
      if (method !== "GET" && method !== "HEAD") {
        headers["Content-Length"] = String(body.length);
      }

      let settled = false;
      let headersReceived = false;
      let connectTimer = null;
      let totalTimer = null;

      const clearTimers = () => {
        if (connectTimer) {
          clearTimeout(connectTimer);
          connectTimer = null;
        }
        if (totalTimer) {
          clearTimeout(totalTimer);
          totalTimer = null;
        }
      };

      const failUpstream = (reason) => {
        if (settled) return;
        settled = true;
        clearTimers();
        if (!request.signal?.aborted) {
          onHubUnreachable?.({
            host: hub.host,
            port: hub.port,
            path: targetPath,
            error: reason,
          });
        }
        resolve(jsonResponse(502, { ok: false, error: "Hub not reachable" }));
      };

      const upReq = requestImpl(
        {
          host: hub.host,
          port: hub.port,
          path: targetPath,
          method,
          headers,
        },
        (upRes) => {
          headersReceived = true;
          if (connectTimer) {
            clearTimeout(connectTimer);
            connectTimer = null;
          }
          upRes.once("close", clearTimers);
          upRes.once("end", clearTimers);
          upRes.once("error", clearTimers);

          const status = upRes.statusCode || 502;
          if (status === 401 && !hadExplicitAuth) {
            onHubAuthRequired?.({
              host: hub.host,
              port: hub.port,
              path: targetPath,
            });
          }

          const outHeaders = filterForwardResponseHeaders(upRes.headers);
          settled = true;

          if (status === 204 || status === 205 || status === 304 || method === "HEAD") {
            upRes.resume();
            resolve(new Response(null, { status, headers: outHeaders }));
            return;
          }

          const webStream = Readable.toWeb(upRes);
          resolve(new Response(webStream, { status, headers: outHeaders }));
        }
      );

      upReq.once("socket", (socket) => {
        const onConnect = () => {
          if (connectTimer) {
            clearTimeout(connectTimer);
            connectTimer = null;
          }
        };
        if (socket && socket.connecting === false) {
          onConnect();
        } else if (socket && typeof socket.once === "function") {
          socket.once("connect", onConnect);
        }
      });

      connectTimer = setTimeout(() => {
        if (!headersReceived) {
          upReq.destroy(new Error("Connect timeout"));
          failUpstream("connect_timeout");
        }
      }, connectTimeoutMs);

      totalTimer = setTimeout(() => {
        upReq.destroy(new Error("Total request timeout"));
        failUpstream("total_timeout");
      }, totalTimeoutMs);

      upReq.on("error", (err) => {
        failUpstream(err?.message || "request_error");
      });

      if (request.signal) {
        if (request.signal.aborted) {
          clearTimers();
          upReq.destroy();
          settled = true;
          resolve(jsonResponse(499, { ok: false, error: "Request aborted" }));
          return;
        }
        request.signal.addEventListener(
          "abort",
          () => {
            clearTimers();
            upReq.destroy();
            if (!settled) {
              settled = true;
              resolve(jsonResponse(499, { ok: false, error: "Request aborted" }));
            }
          },
          { once: true }
        );
      }

      if (body.length > 0) {
        upReq.end(body);
      } else {
        upReq.end();
      }
    });
  })();
}

function createSchemeHandler({
  shellDir,
  connectDir = null,
  getHub,
  getSavedAuthHeader,
  getPageMode = () => "shell",
  connectTimeoutMs = CONNECT_TIMEOUT_MS,
  totalTimeoutMs = TOTAL_TIMEOUT_MS,
  requestImpl = http.request,
  onHubAuthRequired,
  onHubUnreachable,
} = {}) {
  const bundle = loadShellBundle(shellDir, connectDir);

  async function handle(request) {
    const extracted = extractRawTargetFromUrl(request.url);
    if (!extracted.ok) {
      return jsonResponse(400, { ok: false, error: extracted.error });
    }

    const rawTarget = extracted.path;
    const qIndex = rawTarget.indexOf("?");
    const pathname = qIndex >= 0 ? rawTarget.slice(0, qIndex) : rawTarget;
    const method = String(request.method || "GET").toUpperCase();

    const mode = getPageMode();
    const useConnectBundle =
      bundle.connectBundle && (mode === "connect" || mode === "settings");

    if (
      (method === "GET" || method === "HEAD") &&
      (pathname === "/" || pathname === "/index.html")
    ) {
      const body = useConnectBundle
        ? bundle.connectBundle.html
        : bundle.indexBuffer;
      const csp = useConnectBundle ? bundle.connectBundle.csp : bundle.csp;
      return new Response(method === "HEAD" ? null : body, {
        status: 200,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "Content-Security-Policy": csp,
        },
      });
    }

    if (method === "GET" || method === "HEAD") {
      const asset = bundle.staticAssets.get(pathname);
      if (asset) {
        return new Response(method === "HEAD" ? null : asset.data, {
          status: 200,
          headers: {
            "Content-Type": asset.contentType,
            "Cache-Control": "no-store",
          },
        });
      }
    }

    return forwardToHub({
      request,
      targetPath: rawTarget,
      hub: typeof getHub === "function" ? getHub() : null,
      savedAuthHeader:
        typeof getSavedAuthHeader === "function" ? getSavedAuthHeader() : null,
      connectTimeoutMs,
      totalTimeoutMs,
      requestImpl,
      onHubAuthRequired,
      onHubUnreachable,
    });
  }

  return {
    handle,
    csp: bundle.csp,
  };
}

module.exports = {
  CONNECT_TIMEOUT_MS,
  TOTAL_TIMEOUT_MS,
  MAX_FORWARD_BODY_BYTES,
  computeInlineScriptSha256,
  buildCsp,
  validateForwardPath,
  extractRawTargetFromUrl,
  buildForwardRequestHeaders,
  filterForwardResponseHeaders,
  createSchemeHandler,
};
