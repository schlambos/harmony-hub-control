#!/usr/bin/env node
/* Packaging + contract smoke for the production harmony shell embed.
 *
 * Runs tools/package_harmony_shell.sh, then asserts the flash-safe contract:
 *   - production HTML references exactly one shell JS and one shell CSS
 *   - production HTML/CSS carry zero absolute external URLs
 *   - simulation/dev public/index.html also carries zero absolute external
 *     URLs (no Google Fonts preconnect/stylesheet on the Playwright surface)
 *   - production shell JS may declare only the explicit B6/IRDB browser-egress
 *     allowlist (HTTPS path-prefixed IRDB CDN + exact doc/dead-metadata URLs);
 *     analytics beacons, webfonts, ws(s), protocol-relative hosts, encoded
 *     path escapes, and any other host/path fail closed
 *   - callable extraction is lexically aware (strings/templates/comments/regex)
 *     and fail-closed on unterminated constructs; synthetic regressions pin this
 *   - IRDB network fetches are confined to loadLibraryIndex/fetchLibraryFile
 *     and those helpers are reachable only from explicit Search/Preview clicks
 *   - the click-only guarantee is enforced by fail-closed reference budgets:
 *     each guarded name may appear in views/ir.js only in its pinned roles, so
 *     indirect scheduling, aliasing and programmatic clicks fail closed
 *   - no alternate automatic network primitives (sendBeacon/XHR/EventSource/
 *     WebSocket/external dynamic import) in production shell JS
 *   - no routable /sim/ URL in the production bundle (sim-only API)
 *   - vendor editor is NOT copied into the shell bundle or its header;
 *     it stays lazy-loaded from the existing /assets/activity-ui.* routes
 *   - the remote skin JPEG is embedded nowhere; production defines
 *     REMOTE_SKIN_SRC from the pre-existing REMOTE_SKIN_JPG_B64 in C
 *   - generated C arrays exist and are non-empty
 *   - tools/webui-sim/public/vendor/* stay byte-identical to payload/web/*
 *   - packaging is deterministic (two runs produce identical bytes)
 *
 * Run:  node tools/harmony_shell_smoke.mjs
 */

import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";

const REPO = new URL("..", import.meta.url).pathname;
const at = (rel) => new URL(rel, import.meta.url).pathname;

let failures = 0;
function check(name, ok, detail = "") {
  if (ok) {
    console.log(`ok   ${name}`);
  } else {
    failures += 1;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function read(rel) {
  return fs.readFileSync(at(rel), "utf8");
}

// data:image/svg+xml often embeds the inert XML namespace http://www.w3.org/2000/svg
// (not a network request). Neutralize ONLY that token so a real external URL
// smuggled inside the same data URI is still detected by egress scans.
function neutralizeInertSvgNamespace(text) {
  return String(text).replace(/https?:\/\/www\.w3\.org\/2000\/svg/gi, "");
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(at(file))).digest("hex");
}

/* Explicit browser-egress allowlist for production shell JS.
 * Derived from tools/webui-sim/public/js/ir-library.js declarations — NOT
 * from whatever URLs happen to appear in the bundle. Host-only permission
 * is intentionally rejected; undeclared paths (analytics, webfonts, …) fail.
 * Approved production egress is HTTPS-only. */
const IRDB_FILE_BASE = "https://cdn.jsdelivr.net/gh/probonopd/irdb@master/codes/";
const IRDB_INDEX_URL = `${IRDB_FILE_BASE}index`;
const APPROVED_EXACT_URLS = Object.freeze([
  IRDB_INDEX_URL,
  IRDB_FILE_BASE,
  "https://github.com/probonopd/irdb",
  "https://github.com/Lucaslhm/Flipper-IRDB",
  "https://github.com/probonopd/lirc-remotes",
  "https://data.jsdelivr.com/v1/package/gh/Lucaslhm/Flipper-IRDB@main/flat",
  "https://data.jsdelivr.com/v1/package/gh/smartHomeHub/SmartIR@master/flat",
]);
const APPROVED_EXACT_URL_SET = new Set(APPROVED_EXACT_URLS);

function trimUrlToken(token) {
  return token.replace(/[.,;:]+$/u, "");
}

/** Absolute http(s)/ws(s) URLs plus quoted protocol-relative public hosts. */
function extractAbsoluteUrls(text) {
  const found = [];
  const abs = /(?:https?|wss?):\/\/[^\s"'`\\)<>]+/gi;
  let m;
  while ((m = abs.exec(text))) {
    found.push(trimUrlToken(m[0]));
  }
  // Quoted protocol-relative hosts only (`"//evil.example/x"`). Skips JS
  // line comments (`// note`) and root-relative paths (`"/assets/x"`).
  const protoRel = /(['"`])\/\/(?!\/)([A-Za-z0-9][A-Za-z0-9.-]*(?::\d+)?\/[^\s"'`\\)<>]*)\1/g;
  while ((m = protoRel.exec(text))) {
    found.push(trimUrlToken(`//${m[2]}`));
  }
  return found;
}

function irdbSuffixIsSafe(rest) {
  if (!rest || rest.startsWith("//") || rest.includes("://") || rest.includes("..")) {
    return false;
  }
  /* The path arm names code files the browser may actually fetch, so it holds
     the same ground as the runtime gate in ir-library.js — expressed as bans
     rather than that gate's character allowlist, so the two stay independent
     implementations of one policy (see the cross-check corpus below). */
  if (!rest.endsWith(".csv")) return false;
  if (/[\\?#]/.test(rest)) return false; // backslash, query, fragment
  if (/[\u0000-\u001f\u007f]/.test(rest)) return false; // control bytes
  // No empty or dot-leading segment: bans a leading "/", "." and ".." rungs,
  // and dotfiles, without turning this into a character allowlist.
  if (rest.split("/").some((segment) => segment === "" || segment.startsWith("."))) {
    return false;
  }
  let decoded;
  try {
    decoded = decodeURIComponent(rest);
  } catch {
    return false; // fail closed on malformed percent-encoding
  }
  if (
    decoded !== rest &&
    (decoded.includes("..") ||
      decoded.includes("://") ||
      decoded.includes("//") ||
      decoded.startsWith("/") ||
      /[\\]/.test(decoded))
  ) {
    return false;
  }
  if (decoded.includes("..") || decoded.includes("://") || decoded.includes("//")) {
    return false;
  }
  // Reject encoded separators/traversal even when decode is a no-op edge case.
  if (/%2e|%2f|%5c|%00/i.test(rest)) return false;
  return decoded.length > 0;
}

function isApprovedBrowserEgressUrl(url) {
  // Production allowlist is HTTPS-only (ws/http/protocol-relative never approved).
  if (typeof url !== "string" || !url.startsWith("https://")) return false;
  if (APPROVED_EXACT_URL_SET.has(url)) return true;
  if (!url.startsWith(IRDB_FILE_BASE)) return false;
  return irdbSuffixIsSafe(url.slice(IRDB_FILE_BASE.length));
}

/** Previous non-whitespace char index, or -1. */
function prevNonWs(src, index) {
  let j = index - 1;
  while (j >= 0 && /\s/.test(src[j])) j -= 1;
  return j;
}

/**
 * Heuristic: at `/`, is this a RegExp literal rather than division?
 * Fail closed toward treating ambiguous `/` as division (brace scan still
 * safe); regex bodies with `{`/`}` are skipped only when clearly a literal.
 */
function isRegexLiteralStart(src, slashIndex) {
  const j = prevNonWs(src, slashIndex);
  if (j < 0) return true;
  const prev = src[j];
  if ("(,=:[!&|?{};~+-*%^<>\n\r?:".includes(prev)) return true;
  // Keyword before /  e.g. return /x/, typeof /x/
  if (/\w/.test(prev)) {
    let k = j;
    while (k >= 0 && /\w/.test(src[k])) k -= 1;
    const word = src.slice(k + 1, j + 1);
    return /^(?:return|typeof|case|throw|delete|void|in|of|new|await|yield)$/.test(word);
  }
  return false;
}

/**
 * Match a balanced `(`/`{`/`[` starting at openIndex, ignoring braces inside
 * strings, template literals (with `${…}` recursion), line/block comments,
 * and regex literals. Returns index of the matching closer, or -1 if
 * unterminated (fail closed).
 */
function matchBalanced(src, openIndex) {
  const open = src[openIndex];
  const close = open === "(" ? ")" : open === "{" ? "}" : open === "[" ? "]" : "";
  if (!close) return -1;

  let depth = 0;
  let i = openIndex;
  /** @type {"code"|"squote"|"dquote"|"template"|"linecomment"|"blockcomment"|"regex"|"regexclass"} */
  let state = "code";

  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];

    if (state === "code") {
      if (ch === "/" && next === "/") {
        state = "linecomment";
        i += 2;
        continue;
      }
      if (ch === "/" && next === "*") {
        state = "blockcomment";
        i += 2;
        continue;
      }
      if (ch === "'") {
        state = "squote";
        i += 1;
        continue;
      }
      if (ch === '"') {
        state = "dquote";
        i += 1;
        continue;
      }
      if (ch === "`") {
        state = "template";
        i += 1;
        continue;
      }
      if (ch === "/" && isRegexLiteralStart(src, i)) {
        state = "regex";
        i += 1;
        continue;
      }
      if (ch === open) {
        depth += 1;
        i += 1;
        continue;
      }
      if (ch === close) {
        depth -= 1;
        if (depth === 0) return i;
        i += 1;
        continue;
      }
      i += 1;
      continue;
    }

    if (state === "squote" || state === "dquote") {
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === "\n" || ch === "\r") return -1; // unterminated string
      if (ch === (state === "squote" ? "'" : '"')) state = "code";
      i += 1;
      continue;
    }

    if (state === "template") {
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === "`") {
        state = "code";
        i += 1;
        continue;
      }
      if (ch === "$" && next === "{") {
        const interpClose = matchBalanced(src, i + 1);
        if (interpClose < 0) return -1;
        i = interpClose + 1;
        continue;
      }
      i += 1;
      continue;
    }

    if (state === "linecomment") {
      if (ch === "\n") state = "code";
      i += 1;
      continue;
    }

    if (state === "blockcomment") {
      if (ch === "*" && next === "/") {
        state = "code";
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }

    if (state === "regex") {
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === "[") {
        state = "regexclass";
        i += 1;
        continue;
      }
      if (ch === "\n" || ch === "\r") return -1;
      if (ch === "/") {
        state = "code";
        i += 1;
        while (i < src.length && /[a-z]/i.test(src[i])) i += 1; // flags
        continue;
      }
      i += 1;
      continue;
    }

    if (state === "regexclass") {
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === "]") state = "regex";
      i += 1;
      continue;
    }

    return -1;
  }
  return -1;
}

/**
 * Brace-balanced slice of a function/method starting at its declaration.
 * Skips the parameter list first so default-value objects like
 * `{ fetchImpl = fetch } = {}` are not mistaken for the body. String /
 * comment / regex / template contents do not affect brace depth.
 */
function extractCallableSource(src, name, { requireFunctionKeyword = false } = {}) {
  const re = requireFunctionKeyword
    ? new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`)
    : new RegExp(`(?:async\\s+)?(?:function\\s+)?${name}\\s*\\(`);
  const m = re.exec(src);
  if (!m) return null;
  const paramOpen = m.index + m[0].length - 1; // '('
  if (src[paramOpen] !== "(") return null;
  const paramClose = matchBalanced(src, paramOpen);
  if (paramClose < 0) return null;
  let j = paramClose + 1;
  while (j < src.length && /\s/.test(src[j])) j += 1;
  if (src[j] !== "{") return null;
  const bodyClose = matchBalanced(src, j);
  if (bodyClose < 0) return null;
  return src.slice(m.index, bodyClose + 1);
}

function extractFunctionSource(src, name) {
  return extractCallableSource(src, name, { requireFunctionKeyword: true });
}

function extractMethodSource(src, name) {
  return extractCallableSource(src, name, { requireFunctionKeyword: false });
}

/* -- run the packager, then again for determinism ----------------------- */

const PACKAGER = at("package_harmony_shell.sh");
execFileSync("sh", [PACKAGER], { cwd: REPO, stdio: "pipe" });

const ARTIFACTS = [
  "webui-sim/build/index.html",
  "webui-sim/build/harmony-shell.js",
  "webui-sim/build/harmony-shell.css",
  "../payload/source/harmony_shell_assets.h",
];
const firstPass = Object.fromEntries(ARTIFACTS.map((a) => [a, sha256(`./${a}`)]));

execFileSync("sh", [PACKAGER], { cwd: REPO, stdio: "pipe" });
for (const artifact of ARTIFACTS) {
  check(
    `deterministic: ${artifact} identical across two packaging runs`,
    sha256(`./${artifact}`) === firstPass[artifact]
  );
}

const html = read("./webui-sim/build/index.html");
const shellJs = read("./webui-sim/build/harmony-shell.js");
const shellCss = read("./webui-sim/build/harmony-shell.css");
const header = read("../payload/source/harmony_shell_assets.h");
const webuiC = read("../payload/source/codex_webui.c");
const simIndex = read("./webui-sim/public/index.html");
const irView = read("./webui-sim/public/js/views/ir.js");
const irLibrary = read("./webui-sim/public/js/ir-library.js");

/* -- production HTML: single shell JS + single shell CSS ---------------- */

const stylesheetLinks = html.match(/<link[^>]*rel="stylesheet"[^>]*>/g) ?? [];
check(
  "index.html: exactly one stylesheet link",
  stylesheetLinks.length === 1,
  `found ${stylesheetLinks.length}`
);
check(
  "index.html: stylesheet is /assets/harmony-shell.css",
  stylesheetLinks.length === 1 && stylesheetLinks[0].includes('href="/assets/harmony-shell.css"')
);

const scriptSrcs = html.match(/<script[^>]*src="[^"]*"[^>]*>/g) ?? [];
check("index.html: exactly one external script", scriptSrcs.length === 1, `found ${scriptSrcs.length}`);
check(
  "index.html: script is /assets/harmony-shell.js (classic + defer, not module)",
  scriptSrcs.length === 1 &&
    scriptSrcs[0].includes('src="/assets/harmony-shell.js"') &&
    scriptSrcs[0].includes("defer") &&
    !scriptSrcs[0].includes("module")
);


/* -- extractor regression (synthetic; proves string/comment/regex safety) - */

const EXTRACTOR_SYNTHETIC = `
function targetFn(x = { a: 1 }) {
  const single = '{';
  const double = "}";
  const tmpl = \`open \${"}"} close {\`;
  // unbalanced { in line comment
  /* unbalanced } in block comment */
  const re = /{/;
  const re2 = /a{2,}/;
  return single + double + tmpl + re + re2 + x;
}
function sentinelFn() {
  return "sentinel-alive";
}
`;

{
  const extracted = extractFunctionSource(EXTRACTOR_SYNTHETIC, "targetFn");
  const remainder = EXTRACTOR_SYNTHETIC.replace(extracted ?? "\0", "");
  check(
    "extractor: synthetic targetFn closes before sentinel (string/comment/regex braces)",
    Boolean(extracted) &&
      extracted.startsWith("function targetFn") &&
      extracted.trimEnd().endsWith("}") &&
      !extracted.includes("sentinelFn") &&
      !extracted.includes("sentinel-alive") &&
      /return single \+ double/.test(extracted),
    extracted
      ? `len=${extracted.length} tail=${JSON.stringify(extracted.slice(-40))}`
      : "extract returned null"
  );
  check(
    "extractor: synthetic remainder retains sentinelFn intact",
    /function\s+sentinelFn\s*\(/.test(remainder) && remainder.includes("sentinel-alive"),
    remainder.includes("sentinelFn") ? "" : "sentinel missing from remainder"
  );
  check(
    "extractor: fails closed on unterminated string in body",
    extractFunctionSource(`function bad() {\n  const x = "{";\n`, "bad") === null
  );
}

/* -- browser egress: HTML/CSS sealed; JS on explicit IRDB allowlist -------- */

const htmlExternalUrls = extractAbsoluteUrls(neutralizeInertSvgNamespace(html));
const cssExternalUrls = extractAbsoluteUrls(neutralizeInertSvgNamespace(shellCss));
const shellJsUrls = extractAbsoluteUrls(shellJs);
const unapprovedShellJsUrls = shellJsUrls.filter((u) => !isApprovedBrowserEgressUrl(u));

check(
  "index.html: zero absolute external URLs",
  htmlExternalUrls.length === 0,
  `found ${htmlExternalUrls.join(", ") || "none"}`
);
// Dev-proxy / simulation HTML is the Playwright surface — same no-automatic
// public-egress contract as production. Only the inert SVG namespace token is
// neutralized; other URLs inside data: URIs still fail this gate.
const simIndexExternalUrls = extractAbsoluteUrls(neutralizeInertSvgNamespace(simIndex));
check(
  "sim index.html: zero absolute external URLs (no Google Fonts / public CDN)",
  simIndexExternalUrls.length === 0,
  `found ${simIndexExternalUrls.join(", ") || "none"}`
);
check(
  "shell.css: no @import and zero absolute external URLs",
  !/@import/.test(shellCss) && cssExternalUrls.length === 0,
  `urls=${cssExternalUrls.join(", ") || "none"}`
);
check(
  "shell.js: every absolute URL is on the B6/IRDB browser-egress allowlist",
  unapprovedShellJsUrls.length === 0 && shellJsUrls.length > 0,
  unapprovedShellJsUrls.length
    ? `unapproved: ${[...new Set(unapprovedShellJsUrls)].join(", ")}`
    : shellJsUrls.length === 0
      ? "no approved IRDB/doc URLs present in bundle"
      : ""
);
check(
  "shell.js: declares IRDB index URL exactly",
  shellJs.includes(IRDB_INDEX_URL)
);
check(
  "shell.js: declares IRDB fileBase path prefix exactly",
  shellJs.includes(IRDB_FILE_BASE)
);
check(
  "shell.js: declares approved documentation github URLs",
  shellJs.includes("https://github.com/probonopd/irdb") &&
    shellJs.includes("https://github.com/Lucaslhm/Flipper-IRDB") &&
    shellJs.includes("https://github.com/probonopd/lirc-remotes")
);
check(
  "shell.js: declares known-dead jsDelivr package-index metadata URLs",
  shellJs.includes("https://data.jsdelivr.com/v1/package/gh/Lucaslhm/Flipper-IRDB@main/flat") &&
    shellJs.includes("https://data.jsdelivr.com/v1/package/gh/smartHomeHub/SmartIR@master/flat")
);
check(
  "shell.js: rejects undeclared hosts (no analytics/webfont CDN markers)",
  !/fonts\.googleapis\.com|fonts\.gstatic\.com|google-analytics\.com|googletagmanager\.com|facebook\.net|hotjar\.com|segment\.io|sentry\.io/i.test(
    shellJs
  )
);

/* Scanner / allowlist detector regressions (synthetic; current bundle is clean). */
{
  const scanSample = [
    'const a = "https://evil.example/x";',
    "const b = 'http://evil.example/y';",
    "const c = `ws://evil.example/z`;",
    'const d = "wss://evil.example/w";',
    'const e = "//evil.example/proto";',
    "const f = '/assets/local.js';", // root-relative — must NOT match
    "const g = // not-a-host.com", // line comment — must NOT match
    'const h = "data:image/svg+xml," + "http://www.w3.org/2000/svg" + "https://evil.example/in-svg";',
  ].join("\n");
  const scanned = extractAbsoluteUrls(neutralizeInertSvgNamespace(scanSample));
  check(
    "egress scan: detects http(s)/ws(s) and quoted protocol-relative hosts",
    scanned.includes("https://evil.example/x") &&
      scanned.includes("http://evil.example/y") &&
      scanned.includes("ws://evil.example/z") &&
      scanned.includes("wss://evil.example/w") &&
      scanned.includes("//evil.example/proto"),
    `found ${scanned.join(", ")}`
  );
  check(
    "egress scan: ignores JS // comments and root-relative paths",
    !scanned.some((u) => u.includes("not-a-host")) &&
      !scanned.some((u) => u.includes("/assets/local")),
    `found ${scanned.join(", ")}`
  );
  check(
    "egress scan: inert SVG namespace neutralized but sibling external URL remains",
    !scanned.some((u) => /w3\.org\/2000\/svg/i.test(u)) &&
      scanned.includes("https://evil.example/in-svg"),
    `found ${scanned.join(", ")}`
  );
  check(
    "allowlist: HTTPS-only; rejects ws/http/protocol-relative and encoded traversal",
    isApprovedBrowserEgressUrl(IRDB_INDEX_URL) &&
      isApprovedBrowserEgressUrl(`${IRDB_FILE_BASE}Samsung/TV.csv`) &&
      !isApprovedBrowserEgressUrl("http://cdn.jsdelivr.net/gh/probonopd/irdb@master/codes/index") &&
      !isApprovedBrowserEgressUrl("ws://cdn.jsdelivr.net/gh/probonopd/irdb@master/codes/index") &&
      !isApprovedBrowserEgressUrl("//cdn.jsdelivr.net/gh/probonopd/irdb@master/codes/index") &&
      !isApprovedBrowserEgressUrl(`${IRDB_FILE_BASE}%2e%2e/secret`) &&
      !isApprovedBrowserEgressUrl(`${IRDB_FILE_BASE}foo/../../etc/passwd`) &&
      !isApprovedBrowserEgressUrl(`${IRDB_FILE_BASE}x%2f%2e%2e%2fy`)
  );
}

/* -- runtime vs build-time IRDB path policy (anti-drift) ------------------- */

/* Two independent implementations guard the same boundary: irdbFileUrl() in
 * ir-library.js decides at runtime which index rows become fetchable URLs, and
 * isApprovedBrowserEgressUrl() above decides at build time which URLs the
 * bundle may reach. If they drift apart, one of them is wrong and the smoke
 * stops meaning anything. Pin them to a shared safe/adversarial corpus.
 *
 * Only the path arm is comparable: the exact-URL arm covers the index endpoint,
 * the bare fileBase and the documentation links — endpoints irdbFileUrl can
 * never produce, since none of them name a .csv code file. */
const { irdbFileUrl } = await import(
  new URL("./webui-sim/public/js/ir-library.js", import.meta.url).href
);

function buildTimeApprovesIrdbPath(path) {
  const url = IRDB_FILE_BASE + path;
  return isApprovedBrowserEgressUrl(url) && !APPROVED_EXACT_URL_SET.has(url);
}

/** [label, path, expected verdict] — accepted rows also pin the exact URL. */
const IRDB_PATH_CORPUS = Object.freeze([
  ["accepted plain code file", "Samsung/TV.csv", true],
  ["accepted spaced code file", "LG/Air Conditioner.csv", true],
  // IRDB really publishes -1,-1.csv sentinel rows: a leading dash is data, not
  // traversal, and must survive both policies.
  ["accepted leading-dash sentinel", "Yamaha/Amp/-1,-1.csv", true],
  ["accepted bare leading-dash sentinel", "-1,-1.csv", true],
  ["accepted dash inside segment", "Denon/AVR/1,-1.csv", true],
  ["empty path", "", false],
  ["non-csv file", "Samsung/TV.txt", false],
  ["dot traversal", "../secret.csv", false],
  ["nested traversal", "Samsung/../../etc/passwd.csv", false],
  // Admitting a leading dash must not admit dot segments beside it.
  ["dash then parent traversal", "-1/../A.csv", false],
  ["dash then current-dir segment", "-1/./A.csv", false],
  ["dot before leading dash", ".-1,-1.csv", false],
  ["leading slash", "/Samsung/TV.csv", false],
  ["protocol-relative host", "//evil.example/TV.csv", false],
  ["absolute url", "https://evil.example/TV.csv", false],
  ["encoded dot traversal", "%2e%2e/secret.csv", false],
  ["encoded separator", "Samsung%2fTV.csv", false],
  ["encoded NUL", "Samsung%00/TV.csv", false],
  ["backslash separator", "Samsung\\TV.csv", false],
  ["malformed percent escape", "Samsung/%zz.csv", false],
  ["query string", "Samsung/TV.csv?x=1", false],
  ["fragment", "Samsung/TV.csv#frag", false],
  // csv-terminated so the verdict turns on the query/fragment ban itself
  // rather than on the code-file suffix rule.
  ["embedded query string", "Samsung/TV?x=1.csv", false],
  ["embedded fragment", "Samsung/TV#frag.csv", false],
  ["empty segment", "Samsung//TV.csv", false],
  ["dot-leading segment", "Samsung/.csv", false],
]);

for (const [label, path, expected] of IRDB_PATH_CORPUS) {
  const runtimeUrl = irdbFileUrl(path);
  const runtime = Boolean(runtimeUrl);
  const buildTime = buildTimeApprovesIrdbPath(path);
  const exactUrl = IRDB_FILE_BASE + path;
  const agree = runtime === buildTime;
  const expectedHeld = runtime === expected;
  const urlPinned = !expected || runtimeUrl === exactUrl;
  const problems = [
    agree
      ? ""
      : `policies disagree — irdbFileUrl=${runtime} vs isApprovedBrowserEgressUrl=${buildTime}`,
    expectedHeld ? "" : `expected ${expected ? "accept" : "reject"}, runtime returned ${runtime}`,
    urlPinned ? "" : `url mismatch — got ${JSON.stringify(runtimeUrl)} want ${JSON.stringify(exactUrl)}`,
  ].filter(Boolean);
  check(
    `irdb path policy: runtime and build-time agree on ${label} (${JSON.stringify(path)})`,
    agree && expectedHeld && urlPinned,
    problems.join(" | ")
  );
}

/* Identifier names do not survive bundling, but string and regex literals do:
 * assert the runtime gate itself (the per-segment allowlist) and the refusal
 * a user would see are both present in the generated bundle. */
check(
  "shell.js: carries the runtime IRDB path gate (segment allowlist + user-facing refusal)",
  shellJs.includes("[A-Za-z0-9_-][A-Za-z0-9 ()+,&'!~=@$_.-]*") &&
    shellJs.includes("Refusing to fetch unsafe library path:"),
  `segmentAllowlist=${shellJs.includes("[A-Za-z0-9_-][A-Za-z0-9 ()+,&'!~=@$_.-]*")} refusal=${shellJs.includes(
    "Refusing to fetch unsafe library path:"
  )}`
);

check(
  "shell.js: no alternate automatic network primitives (beacon/XHR/EventSource/WebSocket/external import)",
  !/\bnavigator\s*\.\s*sendBeacon\b/.test(shellJs) &&
    !/\bXMLHttpRequest\b/.test(shellJs) &&
    !/\bEventSource\b/.test(shellJs) &&
    !/\bWebSocket\b/.test(shellJs) &&
    !/\bimport\s*\(\s*['"`](?:https?:|\/\/)/.test(shellJs)
);

/* Source-level: IRDB fetch helpers are the only network egress seams, and
 * they are wired only to explicit Search / Preview user actions. */
const loadLibraryIndexSrc = extractFunctionSource(irLibrary, "loadLibraryIndex");
const fetchLibraryFileSrc = extractFunctionSource(irLibrary, "fetchLibraryFile");
const irLibraryWithoutFetchHelpers = irLibrary
  .replace(loadLibraryIndexSrc ?? "\0", "")
  .replace(fetchLibraryFileSrc ?? "\0", "");
const doFindSearchSrc = extractFunctionSource(irView, "doFindSearch");
const previewLibraryEntrySrc = extractFunctionSource(irView, "previewLibraryEntry");
const irViewWithoutUserFetchHandlers = irView
  .replace(doFindSearchSrc ?? "\0", "")
  .replace(previewLibraryEntrySrc ?? "\0", "");
const onShowSrc = extractMethodSource(irView, "onShow");
const mountSrc = extractFunctionSource(irView, "mount");
const renderFindResultsSrc = extractFunctionSource(irView, "renderFindResults");

check(
  "ir-library.js: loadLibraryIndex and fetchLibraryFile are defined",
  Boolean(loadLibraryIndexSrc) && Boolean(fetchLibraryFileSrc)
);
check(
  "extractor sentinel: loadLibraryIndex does not swallow fetchLibraryFile/planImport",
  Boolean(loadLibraryIndexSrc) &&
    !/\bfunction\s+fetchLibraryFile\b/.test(loadLibraryIndexSrc) &&
    !/\bfunction\s+planImport\b/.test(loadLibraryIndexSrc) &&
    !/\bexport\s+async\s+function\s+fetchLibraryFile\b/.test(loadLibraryIndexSrc) &&
    !loadLibraryIndexSrc.includes("export function planImport") &&
    !loadLibraryIndexSrc.includes("export async function fetchLibraryFile")
);
check(
  "extractor sentinel: doFindSearch does not swallow previewLibraryEntry/mount/onShow",
  Boolean(doFindSearchSrc) &&
    !/\bfunction\s+previewLibraryEntry\b/.test(doFindSearchSrc) &&
    !/\bfunction\s+mount\b/.test(doFindSearchSrc) &&
    !/\basync\s+onShow\s*\(/.test(doFindSearchSrc) &&
    !doFindSearchSrc.includes("async function previewLibraryEntry")
);
check(
  "extractor sentinel: previewLibraryEntry does not swallow mount/onShow",
  Boolean(previewLibraryEntrySrc) &&
    !/\bfunction\s+mount\b/.test(previewLibraryEntrySrc) &&
    !/\basync\s+onShow\s*\(/.test(previewLibraryEntrySrc)
);
check(
  "ir-library.js: fetchImpl calls live only inside loadLibraryIndex + fetchLibraryFile",
  Boolean(loadLibraryIndexSrc) &&
    Boolean(fetchLibraryFileSrc) &&
    /\bfetchImpl\s*\(/.test(loadLibraryIndexSrc) &&
    /\bfetchImpl\s*\(/.test(fetchLibraryFileSrc) &&
    !/\bfetchImpl\s*\(/.test(irLibraryWithoutFetchHelpers) &&
    !/\bfetch\s*\(/.test(irLibraryWithoutFetchHelpers)
);
check(
  "ir-library.js: declares the same IRDB index/fileBase allowlist strings",
  irLibrary.includes(`indexUrl: "${IRDB_INDEX_URL}"`) &&
    irLibrary.includes(`fileBase: "${IRDB_FILE_BASE}"`)
);
check(
  "ir.js: loadLibraryIndex is invoked only from doFindSearch",
  Boolean(doFindSearchSrc) &&
    /\bloadLibraryIndex\s*\(/.test(doFindSearchSrc) &&
    (irView.match(/\bloadLibraryIndex\s*\(/g) ?? []).length === 1 &&
    !/\bloadLibraryIndex\s*\(/.test(irViewWithoutUserFetchHandlers)
);
check(
  "ir.js: fetchLibraryFile is invoked only from previewLibraryEntry",
  Boolean(previewLibraryEntrySrc) &&
    /\bfetchLibraryFile\s*\(/.test(previewLibraryEntrySrc) &&
    (irView.match(/\bfetchLibraryFile\s*\(/g) ?? []).length === 1 &&
    !/\bfetchLibraryFile\s*\(/.test(irViewWithoutUserFetchHandlers)
);
// Handler identity is the contract; CSS class names and loop identifiers are not.
check(
  "ir.js: Search button wires doFindSearch (explicit user action)",
  Boolean(mountSrc) &&
    /button\(\s*["']Search IRDB["']\s*,\s*["'][^"']*["']\s*,\s*doFindSearch\s*\)/.test(mountSrc)
);
check(
  "ir.js: Preview button wires previewLibraryEntry (explicit user action)",
  Boolean(renderFindResultsSrc) &&
    /button\(\s*["']Preview["']\s*,\s*["'][^"']*["']\s*,\s*\(\s*\)\s*=>\s*previewLibraryEntry\s*\(\s*\w+\s*\)\s*\)/.test(
      renderFindResultsSrc
    )
);
check(
  "ir.js: onShow does not call loadLibraryIndex or fetchLibraryFile",
  Boolean(onShowSrc) &&
    !/\bloadLibraryIndex\s*\(/.test(onShowSrc) &&
    !/\bfetchLibraryFile\s*\(/.test(onShowSrc)
);
check(
  "ir.js: mount does not call loadLibraryIndex or fetchLibraryFile",
  Boolean(mountSrc) &&
    !/\bloadLibraryIndex\s*\(/.test(mountSrc) &&
    !/\bfetchLibraryFile\s*\(/.test(mountSrc)
);
check(
  "ir.js: no automatic startup path invokes IRDB fetch helpers",
  // After stripping the two user-action handlers, fetch helpers must not remain
  // as call sites. previewLibraryEntry( may still appear once as the Preview
  // click arrow inside renderFindResults — that is the intentional click seam.
  !/\bloadLibraryIndex\s*\(/.test(irViewWithoutUserFetchHandlers) &&
    !/\bfetchLibraryFile\s*\(/.test(irViewWithoutUserFetchHandlers) &&
    !/\bdoFindSearch\s*\(/.test(irViewWithoutUserFetchHandlers) &&
    (irViewWithoutUserFetchHandlers.match(/\bpreviewLibraryEntry\s*\(/g) ?? []).length === 1 &&
    Boolean(renderFindResultsSrc) &&
    /\bpreviewLibraryEntry\s*\(\s*\w+\s*\)/.test(renderFindResultsSrc) &&
    !/\bloadLibraryIndex\s*\(|\bfetchLibraryFile\s*\(/.test(onShowSrc ?? "") &&
    !/\bloadLibraryIndex\s*\(|\bfetchLibraryFile\s*\(/.test(mountSrc ?? "")
);

/* -- IRDB click-only guarantee: fail-closed reference budgets -------------- */

/* Counting direct call sites is not enough: a reference can be handed to a
 * scheduler, stored in an alias, bound, or applied without ever looking like
 * `name(`. These budgets invert the test — every textual occurrence of a
 * guarded identifier in views/ir.js must be accounted for by an explicitly
 * pinned role (its declaration / import specifier, plus the one Search or
 * Preview click seam). Anything else is an unapproved reference and fails,
 * with no need to enumerate bypass shapes. Programmatic activation
 * (`el.click()`, `dispatchEvent`) carries no identifier reference at all, so
 * it is banned separately. */

function lineOf(src, index) {
  return src.slice(0, index).split("\n").length;
}

/** Start indices of every whole-word occurrence of `name`. */
function identifierIndices(src, name) {
  const re = new RegExp(`\\b${name}\\b`, "g");
  const out = [];
  let m;
  while ((m = re.exec(src))) out.push(m.index);
  return out;
}

/** Span of an extracted slice inside its source, or null if absent/ambiguous. */
function spanOf(src, extracted) {
  if (!extracted) return null;
  const start = src.indexOf(extracted);
  if (start < 0 || src.indexOf(extracted, start + 1) >= 0) return null;
  return { start, end: start + extracted.length };
}

/** Span of the single `import { … } from "../ir-library.js";` statement. */
function irLibraryImportSpan(src) {
  const re = /import\s*\{[^{}]*\}\s*from\s*["']\.\.\/ir-library\.js["'];/g;
  const matches = [];
  let m;
  while ((m = re.exec(src))) matches.push(m);
  if (matches.length !== 1) return null;
  return { start: matches[0].index, end: matches[0].index + matches[0][0].length };
}

/**
 * Index of the identifier occurrence that belongs to one approved role.
 * The role pattern must match exactly once inside its region and hold the
 * identifier exactly once; a missing region, a duplicate match, or an
 * ambiguous match all fail closed (null).
 */
function approvedRoleIndex(src, name, role) {
  if (role.within === null) return null; // required enclosing callable missing
  const start = role.within ? role.within.start : 0;
  const end = role.within ? role.within.end : src.length;
  const region = src.slice(start, end);
  const re = new RegExp(role.pattern.source, "g");
  const matches = [];
  let m;
  while ((m = re.exec(region))) matches.push(m);
  if (matches.length !== 1) return null;
  const inner = identifierIndices(matches[0][0], name);
  if (inner.length !== 1) return null;
  return start + matches[0].index + inner[0];
}

function referenceBudget(src, name, roles) {
  const approved = new Map();
  const unpinned = [];
  for (const role of roles) {
    const index = approvedRoleIndex(src, name, role);
    if (index === null || approved.has(index)) {
      unpinned.push(role.role);
      continue;
    }
    approved.set(index, role.role);
  }
  const extras = identifierIndices(src, name).filter((index) => !approved.has(index));
  const ok = unpinned.length === 0 && extras.length === 0;
  const detail = [
    unpinned.length ? `unpinned role(s): ${unpinned.join("; ")}` : "",
    extras.length
      ? `unapproved ${name} reference(s) at line ${extras.map((i) => lineOf(src, i)).join(", ")}`
      : "",
  ]
    .filter(Boolean)
    .join(" | ");
  return { ok, extras, detail };
}

/** Approved roles, recomputed from whatever source is under test. */
function irdbReferenceBudgets(src) {
  const importSpan = irLibraryImportSpan(src);
  const doFindSearchSpan = spanOf(src, extractFunctionSource(src, "doFindSearch"));
  const previewSpan = spanOf(src, extractFunctionSource(src, "previewLibraryEntry"));
  const mountSpan = spanOf(src, extractFunctionSource(src, "mount"));
  const findResultsSpan = spanOf(src, extractFunctionSource(src, "renderFindResults"));
  return [
    {
      name: "doFindSearch",
      roles: [
        { role: "declaration", pattern: /\basync\s+function\s+doFindSearch\s*\(/ },
        {
          role: "Search IRDB button callback in mount",
          pattern: /\bbutton\(\s*["']Search IRDB["']\s*,\s*["'][^"']*["']\s*,\s*doFindSearch\s*\)/,
          within: mountSpan,
        },
      ],
    },
    {
      name: "previewLibraryEntry",
      roles: [
        { role: "declaration", pattern: /\basync\s+function\s+previewLibraryEntry\s*\(/ },
        {
          role: "Preview button callback in renderFindResults",
          pattern:
            /\bbutton\(\s*["']Preview["']\s*,\s*["'][^"']*["']\s*,\s*\(\s*\)\s*=>\s*previewLibraryEntry\s*\(\s*\w+\s*\)\s*\)/,
          within: findResultsSpan,
        },
      ],
    },
    {
      name: "loadLibraryIndex",
      roles: [
        { role: "ir-library.js import specifier", pattern: /\bloadLibraryIndex\b/, within: importSpan },
        {
          role: "awaited call inside doFindSearch",
          pattern: /\bawait\s+loadLibraryIndex\s*\(/,
          within: doFindSearchSpan,
        },
      ],
    },
    {
      name: "fetchLibraryFile",
      roles: [
        { role: "ir-library.js import specifier", pattern: /\bfetchLibraryFile\b/, within: importSpan },
        {
          role: "awaited call inside previewLibraryEntry",
          pattern: /\bawait\s+fetchLibraryFile\s*\(/,
          within: previewSpan,
        },
      ],
    },
  ];
}

function budgetReport(src, name) {
  const budget = irdbReferenceBudgets(src).find((entry) => entry.name === name);
  return budget
    ? referenceBudget(src, name, budget.roles)
    : { ok: false, extras: [], detail: `no reference budget declared for ${name}` };
}

/** Programmatic activation: `el.click()` / `el?.click()` / `dispatchEvent(…)`. */
function findSyntheticActivation(src) {
  const re = /(?:\?\.|\.)\s*click\s*\(|\bdispatchEvent\s*\(/g;
  const out = [];
  let m;
  while ((m = re.exec(src))) out.push(`line ${lineOf(src, m.index)}: ${m[0]}`);
  return out;
}

for (const budget of irdbReferenceBudgets(irView)) {
  const report = referenceBudget(irView, budget.name, budget.roles);
  check(
    `ir.js: ${budget.name} reference budget — only ${budget.roles.map((r) => r.role).join(" + ")}`,
    report.ok,
    report.detail
  );
}

const syntheticActivation = findSyntheticActivation(irView);
check(
  "ir.js: no programmatic .click() / dispatchEvent() (clicks originate from the user)",
  syntheticActivation.length === 0,
  syntheticActivation.join(", ")
);

const buttonSrc = extractFunctionSource(irView, "button");
const buttonListeners = buttonSrc?.match(/\.addEventListener\(\s*["'`][^"'`]*["'`]/g) ?? [];
check(
  "ir.js: button() binds exactly one listener and it is 'click'",
  Boolean(buttonSrc) &&
    buttonListeners.length === 1 &&
    /\.addEventListener\(\s*["']click["']\s*,\s*onClick\s*\)/.test(buttonSrc) &&
    findSyntheticActivation(buttonSrc).length === 0,
  buttonSrc ? `listeners=${buttonListeners.join(", ") || "none"}` : "button() not found"
);

const PUBLIC_JS_DIR = at("./webui-sim/public/js");
function listJsFiles(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory()
        ? listJsFiles(`${dir}/${entry.name}`)
        : entry.name.endsWith(".js")
          ? [`${dir}/${entry.name}`]
          : []
    );
}
const irLibraryImporters = listJsFiles(PUBLIC_JS_DIR)
  .filter(
    (file) =>
      file !== `${PUBLIC_JS_DIR}/ir-library.js` &&
      fs.readFileSync(file, "utf8").includes("ir-library.js")
  )
  .map((file) => file.slice(PUBLIC_JS_DIR.length + 1));
check(
  "public js: views/ir.js is the only module referencing ir-library.js",
  irLibraryImporters.length === 1 && irLibraryImporters[0] === "views/ir.js",
  `referencing modules: ${irLibraryImporters.join(", ") || "none"}`
);

/* Mutation self-tests: inject each known bypass at the real Search-button
 * wiring site and prove the analyzer rejects it. The clean source above is the
 * negative control (no false positives). */
const MUTATION_ANCHOR = 'refs.findSearchBtn = button("Search IRDB", "btn-secondary", doFindSearch);';
function mutateIrView(snippet) {
  return irView.replace(MUTATION_ANCHOR, `${MUTATION_ANCHOR}\n    ${snippet}`);
}

function checkBudgetRejects(label, name, snippet) {
  const mutated = mutateIrView(snippet);
  const report = budgetReport(mutated, name);
  check(
    `ir.js budget rejects: ${label}`,
    mutated !== irView && !report.ok && report.extras.length > 0,
    mutated === irView ? "mutation anchor not found in ir.js" : report.ok ? "mutation passed the budget" : ""
  );
}

function checkActivationRejects(label, snippet) {
  const mutated = mutateIrView(snippet);
  const hits = findSyntheticActivation(mutated);
  check(
    `ir.js activation ban rejects: ${label}`,
    mutated !== irView && hits.length > 0,
    mutated === irView ? "mutation anchor not found in ir.js" : "synthetic activation went undetected"
  );
}

checkBudgetRejects("setTimeout(doFindSearch, 0)", "doFindSearch", "setTimeout(doFindSearch, 0);");
checkBudgetRejects("queueMicrotask(doFindSearch)", "doFindSearch", "queueMicrotask(doFindSearch);");
checkBudgetRejects(
  "requestAnimationFrame(() => doFindSearch())",
  "doFindSearch",
  "requestAnimationFrame(() => doFindSearch());"
);
checkBudgetRejects(
  'window.addEventListener("load", doFindSearch)',
  "doFindSearch",
  'window.addEventListener("load", doFindSearch);'
);
checkBudgetRejects(
  "alias const auto = doFindSearch; auto()",
  "doFindSearch",
  "const auto = doFindSearch;\n    auto();"
);
checkBudgetRejects(
  "Promise.resolve().then(previewLibraryEntry)",
  "previewLibraryEntry",
  "Promise.resolve().then(previewLibraryEntry);"
);
checkBudgetRejects(
  "previewLibraryEntry.bind(null, entry)",
  "previewLibraryEntry",
  "const boundPreview = previewLibraryEntry.bind(null, findState.matches[0]);"
);
checkBudgetRejects(
  "Reflect.apply(previewLibraryEntry, null, [entry])",
  "previewLibraryEntry",
  "Reflect.apply(previewLibraryEntry, null, [findState.matches[0]]);"
);
checkBudgetRejects("queueMicrotask(loadLibraryIndex)", "loadLibraryIndex", "queueMicrotask(loadLibraryIndex);");
checkBudgetRejects("setTimeout(fetchLibraryFile, 0)", "fetchLibraryFile", "setTimeout(fetchLibraryFile, 0);");
checkActivationRejects(
  "queueMicrotask(() => findSearchBtn?.click())",
  "queueMicrotask(() => refs.findSearchBtn?.click());"
);
checkActivationRejects(
  'dispatchEvent(new MouseEvent("click"))',
  'refs.findSearchBtn.dispatchEvent(new MouseEvent("click"));'
);

check("index.html: no /sim/ URLs", !/\/sim\//.test(html));
check("shell.js: no routable /sim/ URLs", !/\/sim\//.test(shellJs));
check("index.html: no simulated-hub wording left", !/simulated/i.test(html));

/* -- runtime flags + skin injection seam --------------------------------- */

check("sim index.html: explicit simulation flag window.HARMONY_SIM = true", /window\.HARMONY_SIM\s*=\s*true/.test(simIndex));
check("index.html: production flag HARMONY_SIM=false + HARMONY_PRODUCTION=true",
  html.includes("window.HARMONY_SIM=false") && html.includes("window.HARMONY_PRODUCTION=true"));
check(
  "index.html: ends the head seam at globalThis.REMOTE_SKIN_SRC base64 marker (C injects REMOTE_SKIN_JPG_B64 here)",
  html.includes("<script>globalThis.REMOTE_SKIN_SRC='data:image/jpeg;base64,")
);
check("shell.js: remote skin resolved from globalThis.REMOTE_SKIN_SRC with local fallback",
  shellJs.includes("REMOTE_SKIN_SRC") && shellJs.includes("/assets/remote-skin.jpg"));
check("shell.js: simulation behavior gated on HARMONY_SIM",
  shellJs.includes("HARMONY_SIM"));
check("IR view: lab danger guard remains in factory scope for route teardown",
  irView.includes("let labGuard;") &&
  irView.includes("labGuard = dangerGuard(labClearBtn, {") &&
  !irView.includes("const labGuard = dangerGuard(labClearBtn, {"));

/* -- vendor editor dedup --------------------------------------------------- */

check("shell.js: lazy-loads vendor editor from absolute /assets/activity-ui.js",
  shellJs.includes("/assets/activity-ui.js"));
check("shell.js: lazy-loads vendor stylesheet from absolute /assets/activity-ui.css",
  shellJs.includes("/assets/activity-ui.css"));
check("shell.js: vendor source NOT bundled in",
  !shellJs.includes("__HARMONY_ACTIVITY_TEST__") && !shellJs.includes("pruneActionlessButtons"));
check("harmony_shell_assets.h: no duplicate vendor arrays",
  !header.includes("activity_ui_js") && !header.includes("activity_ui_css"));
const vendorRoutes = webuiC.match(/strcmp\(req\.path, "\/assets\/activity-ui\.(?:js|css)"\)/g) ?? [];
check("codex_webui.c: exactly one route each for /assets/activity-ui.js and .css",
  vendorRoutes.length === 2, `found ${vendorRoutes.length}`);

/* -- skin JPEG embedded nowhere ------------------------------------------- */

function arraysFromHeader(text) {
  const out = {};
  const re = /static const unsigned char (\w+)\[\] = \{([\s\S]*?)\};/g;
  let m;
  while ((m = re.exec(text))) {
    out[m[1]] = m[2]
      .split(",")
      .map((b) => b.trim())
      .filter(Boolean)
      .map((b) => parseInt(b, 16));
  }
  return out;
}

const arrays = arraysFromHeader(header);
check("harmony_shell_assets.h: generated arrays present and non-empty",
  ["harmony_index_head", "harmony_index_tail", "harmony_shell_js", "harmony_shell_css"]
    .every((name) => Array.isArray(arrays[name]) && arrays[name].length > 0),
  `found ${Object.keys(arrays).join(", ") || "none"}`);

{
  // Arrays are NUL-terminated for fputs(); drop the terminator before text checks.
  const toText = (bytes) => Buffer.from(bytes.filter((b) => b !== 0)).toString("utf8");
  const headText = toText(arrays.harmony_index_head ?? []);
  const tailText = toText(arrays.harmony_index_tail ?? []);
  // No newline may sit between "base64," and the injected B64, or between
  // the B64 and the closing quote — a newline inside the single-quoted
  // REMOTE_SKIN_SRC literal is a JS syntax error in the served page.
  check("harmony_index_head ends exactly at the base64 seam (no trailing newline)",
    headText.endsWith("data:image/jpeg;base64,"));
  check("harmony_index_tail opens with the closing quote of the skin literal",
    tailText.startsWith("';"));
}

/* The r.jina.ai reader fallback is legacy form-response UI only. The
 * redesigned shell must carry none of it — and the header stores its payload
 * as hex bytes, so the arrays are decoded before scanning rather than grepped
 * as source text (which would pass vacuously). */
{
  const decoded = Object.entries(arrays).map(
    ([name, bytes]) => [name, Buffer.from(bytes.filter((b) => b !== 0)).toString("utf8")]
  );
  const jinaArrays = decoded.filter(([, text]) => /jina/i.test(text)).map(([name]) => name);
  const jinaInShellJs = /jina/i.test(shellJs);
  check(
    "no r.jina.ai reader fallback in the redesigned shell (shell.js + decoded header arrays)",
    !jinaInShellJs && jinaArrays.length === 0,
    `shell.js=${jinaInShellJs ? "present" : "clean"} headerArrays=${jinaArrays.join(", ") || "clean"}`
  );
}

for (const [name, bytes] of Object.entries(arrays)) {
  let jpeg = false;
  for (let i = 0; i + 2 < bytes.length; i += 1) {
    if (bytes[i] === 0xff && bytes[i + 1] === 0xd8 && bytes[i + 2] === 0xff) {
      jpeg = true;
      break;
    }
  }
  check(`harmony_shell_assets.h: ${name} embeds no raw JPEG (skin only via REMOTE_SKIN_JPG_B64)`, !jpeg);
}

for (const name of ["harmony_index_head", "harmony_index_tail", "harmony_shell_js", "harmony_shell_css"]) {
  const lenMatch = header.match(new RegExp(`static const unsigned int ${name}_len = (\\d+);`));
  check(`harmony_shell_assets.h: ${name}_len declared and > 0`,
    Boolean(lenMatch) && Number(lenMatch?.[1]) > 0);
}

/* -- C wiring contract ------------------------------------------------------ */

check('codex_webui.c: includes harmony_shell_assets.h', webuiC.includes('#include "harmony_shell_assets.h"'));
check("codex_webui.c: defines render_harmony_shell", /static void render_harmony_shell\(int fd\)/.test(webuiC));
check("codex_webui.c: routes / and /index.html to the shell",
  /render_harmony_shell\(client\)/.test(webuiC));
check("codex_webui.c: routes /assets/harmony-shell.css",
  webuiC.includes('strcmp(req.path, "/assets/harmony-shell.css")'));
check("codex_webui.c: routes /assets/harmony-shell.js",
  webuiC.includes('strcmp(req.path, "/assets/harmony-shell.js")'));
check("codex_webui.c: injects REMOTE_SKIN_JPG_B64 between the head and tail arrays",
  /fputs\(\(const char \*\)harmony_index_head, f\);\s*fputs\(REMOTE_SKIN_JPG_B64, f\);\s*fputs\(\(const char \*\)harmony_index_tail, f\);/.test(webuiC));

/* -- shell content is the validated design, fully concatenated -------------- */

check("shell.css: design tokens present", shellCss.includes("--surface-canvas") && shellCss.includes("--accent-primary"));
check("shell.css: remote skin styles present", shellCss.includes(".ir-remote-skin"));
check("shell.css: wizard styles present", shellCss.includes(".wiz-rail"));
check("shell.css: activity-overrides baked in", shellCss.includes("#view-activities .activity-hero"));

/* -- vendor sources untouched and still identical --------------------------- */

check("vendor activity-ui.js identical between webui-sim and payload/web",
  sha256("./webui-sim/public/vendor/activity-ui.js") === sha256("../payload/web/activity-ui.js"));
check("vendor activity-ui.css identical between webui-sim and payload/web",
  sha256("./webui-sim/public/vendor/activity-ui.css") === sha256("../payload/web/activity-ui.css"));
check("payload/source/activity_ui_assets.h still carries the vendor arrays",
  read("../payload/source/activity_ui_assets.h").includes("activity_ui_js"));

/* --------------------------------------------------------------------------- */

if (failures) {
  console.error(`\n${failures} harmony shell smoke check(s) failed`);
  process.exit(1);
}
console.log("\nharmony shell smoke: all checks passed");
