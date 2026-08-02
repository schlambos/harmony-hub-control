/* Browser-side IR code library: index search, format detection, and parse
   preview. Fetches run in the browser (hub stays offline). Import still goes
   through POST /api/irdb-import. Parsers align with tools/ir_database_smoke_test.mjs
   and the hub's bulk_import_irdb_commands line shapes. */

import { LIMITS, parseIrdbLines, prontoToHarmonyRaw, isSafeLabel } from "./views/ir-model.js";

/**
 * Browser-searchable sources only. Flipper-IRDB is intentionally absent:
 * jsDelivr package flat-index returns permanent 403 ("Package size exceeded
 * the configured limit of 50 MB"), and GitHub git/trees is CORS-ok but capped
 * at 60 unauthenticated requests/hour — not a reliable default. Users drop
 * downloaded .ir files instead (parseFlipper still works).
 */
export const LIBRARY_SOURCES = Object.freeze({
  irdb: {
    id: "irdb",
    label: "IRDB (probonopd/irdb)",
    indexUrl: "https://cdn.jsdelivr.net/gh/probonopd/irdb@master/codes/index",
    fileBase: "https://cdn.jsdelivr.net/gh/probonopd/irdb@master/codes/",
  },
});

export const DOC_LINKS = Object.freeze([
  { label: "IRDB codes", href: "https://github.com/probonopd/irdb" },
  {
    label: "Flipper-IRDB (download .ir, drop below)",
    href: "https://github.com/Lucaslhm/Flipper-IRDB",
  },
  { label: "LIRC remotes", href: "https://github.com/probonopd/lirc-remotes" },
]);

/** Verified 2026-08: jsDelivr /flat is dead for these oversized packages. */
export const KNOWN_DEAD_PACKAGE_INDEXES = Object.freeze([
  {
    repo: "Lucaslhm/Flipper-IRDB",
    url: "https://data.jsdelivr.com/v1/package/gh/Lucaslhm/Flipper-IRDB@main/flat",
    status: 403,
    reason: "Package size exceeded the configured limit of 50 MB.",
  },
  {
    repo: "smartHomeHub/SmartIR",
    url: "https://data.jsdelivr.com/v1/package/gh/smartHomeHub/SmartIR@master/flat",
    status: 403,
    reason: "Package size exceeded the configured limit of 50 MB.",
  },
]);

function rev8(v) {
  v = ((v & 240) >> 4) | ((v & 15) << 4);
  v = ((v & 204) >> 2) | ((v & 51) << 2);
  v = ((v & 170) >> 1) | ((v & 85) << 1);
  return v & 255;
}

/** NEC-family compact keycode used by IRDB CSV rows (same shape as hub/smoke). */
export function keyFromParts(proto, d, s, f) {
  if (!/^(NEC|Samsung32|Pioneer)/i.test(proto || "")) return "";
  d = Number(d);
  const ss = String(s === undefined ? "" : s).trim();
  s = ss === "" || ss === "-1" ? (d ^ 255) : Number(s);
  f = Number(f);
  if ([d, s, f].some((x) => !Number.isFinite(x) || x < 0 || x > 255)) return "";
  if (/^Samsung32/i.test(proto)) s = d;
  const val = ((rev8(d) << 24) | (rev8(s) << 16) | (rev8(f) << 8) | rev8((~f) & 255)) >>> 0;
  return `G:Toshiba 32 Bit:(0x${val.toString(16).toUpperCase().padStart(8, "0")})(Repeat)():3`;
}

export function detectFormat(text, filename = "") {
  const t = String(text ?? "");
  const low = String(filename ?? "").toLowerCase();
  if (low.endsWith(".ir") || /^Filetype:\s*IR/im.test(t)) return "flipper";
  if (low.endsWith(".csv") || /^functionname\s*,/im.test(t.trim())) return "irdb-csv";
  if (/begin\s+remote/i.test(t) || low.endsWith(".lirc") || low.endsWith(".lircd") || low.endsWith(".conf")) {
    return "lirc";
  }
  if (/<html|Infrared Hex|Copy to Clipboard/i.test(t)) return "remotecentral";
  if ((t.includes("|") && /\|(raw|keycode)\|/i.test(t)) || /^\s*\S+\|[^\n]+$/m.test(t)) return "pipe";
  if (/(?:0000|0100)\s+[0-9a-fA-F]{4}\s+/i.test(t)) return "pronto";
  if (low.endsWith(".json") || /^\s*[\[{]/.test(t.trim())) return "json";
  return "unknown";
}

function csvCells(line) {
  const out = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (q && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else q = !q;
    } else if (ch === "," && !q) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out.map((x) => x.trim());
}

function safeName(s) {
  return String(s || "Command").replace(/[|"\r\n\\]/g, " ").replace(/\s+/g, " ").trim().slice(0, 96) || "Command";
}

function parseIrdbCsv(text) {
  const rows = [];
  for (const line of String(text).replace(/\r/g, "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const p = csvCells(trimmed);
    if (!p[0] || /^functionname$/i.test(p[0])) continue;
    const proto = p[1] || "";
    const keycode = keyFromParts(proto, p[2] || "", p[3] || "", p[4] || "");
    rows.push({
      name: safeName(p[0]),
      mode: keycode ? "keycode" : "skip",
      code: keycode,
      meta: `${proto} ${p[2] || ""},${p[3] || ""},${p[4] || ""}`,
      supported: Boolean(keycode),
    });
  }
  return rows;
}

function parseFlipper(text) {
  const out = [];
  let cur = {};
  const push = () => {
    if (!cur.name) {
      cur = {};
      return;
    }
    let keycode = "";
    let raw = "";
    const protocol = cur.protocol || "";
    if (cur.type === "parsed") {
      const a = String(cur.address || "").trim().split(/\s+/).map((x) => parseInt(x, 16) || 0);
      const c = String(cur.command || "").trim().split(/\s+/).map((x) => parseInt(x, 16) || 0);
      if (/^Samsung32/i.test(protocol)) keycode = keyFromParts(protocol, a[0], a[0], c[0]);
      else if (/^NECext/i.test(protocol)) keycode = keyFromParts(protocol, a[0], a[1], c[0]);
      else if (/^NEC/i.test(protocol)) keycode = keyFromParts(protocol, a[0], a[0] ^ 255, c[0]);
      else if (/^Pioneer/i.test(protocol)) keycode = keyFromParts(protocol, a[0], a[0] ^ 255, c[0]);
    } else if (cur.type === "raw") {
      const vals = String(cur.data || "").trim().split(/\s+/).filter(Boolean).map(Number);
      const freq = Math.max(10000, Math.min(60000, Math.round(Number(cur.frequency) || 38000)));
      if (vals.length >= 4) {
        let r = `F${freq.toString(16).toUpperCase()}`;
        vals.forEach((v, i) => {
          const n = Math.max(1, Math.min(0xfffff, Math.round(Math.abs(v || 0))));
          r += `${i % 2 ? "S" : "P"}${n.toString(16).toUpperCase()}`;
        });
        if (r.length <= LIMITS.rawImport) raw = r;
      }
    }
    out.push({
      name: safeName(cur.name),
      mode: keycode ? "keycode" : raw ? "raw" : "skip",
      code: keycode || raw,
      meta: protocol || cur.type || "flipper",
      supported: Boolean(keycode || raw),
    });
    cur = {};
  };
  for (const line of String(text).replace(/\r/g, "").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    if (t[0] === "#") {
      push();
      continue;
    }
    const i = t.indexOf(":");
    if (i < 0) continue;
    const k = t.slice(0, i).trim();
    const v = t.slice(i + 1).trim();
    if (k === "name" && cur.name) push();
    cur[k] = cur[k] && k === "data" ? `${cur[k]} ${v}` : v;
  }
  push();
  return out;
}

function parsePronto(text) {
  const re = /((?:0000|0100|5000|6000|7000)(?:\s+[0-9a-fA-F]{4}){10,})/g;
  const rows = [];
  let m;
  let n = 0;
  while ((m = re.exec(String(text)))) {
    n += 1;
    const hex = m[1].replace(/\s+/g, " ").trim();
    const raw = prontoToHarmonyRaw(hex);
    rows.push({
      name: safeName(`Command ${n}`),
      mode: raw ? "raw" : "skip",
      code: raw,
      meta: "Pronto hex",
      supported: Boolean(raw),
    });
  }
  return rows;
}

function parsePipe(text) {
  const { rows } = parseIrdbLines(text);
  return rows.map((r) => ({
    name: safeName(r.name),
    mode: r.mode === "irdb" ? "keycode" : r.mode,
    code: r.mode === "irdb"
      ? (() => {
          const p = String(r.code).split(",");
          return keyFromParts(p[0], p[1], p[2], p[3]);
        })()
      : r.code,
    meta: r.mode,
    supported: true,
  })).map((r) => ({
    ...r,
    supported: Boolean(r.code) && r.mode !== "skip",
    mode: r.code ? r.mode : "skip",
  }));
}

/**
 * Parse library text into command rows for preview/import.
 * @returns {{ format: string, rows: Array, supported: number, skipped: number }}
 */
export function parseLibraryText(text, { filename = "", formatHint = "" } = {}) {
  const format = formatHint || detectFormat(text, filename);
  let rows = [];
  if (format === "irdb-csv") rows = parseIrdbCsv(text);
  else if (format === "flipper") rows = parseFlipper(text);
  else if (format === "pipe") rows = parsePipe(text);
  else if (format === "pronto") rows = parsePronto(text);
  else if (format === "unknown" || format === "lirc" || format === "json") {
    /* Best-effort: try pipe/csv/flipper/pronto in order. */
    rows = parseIrdbCsv(text);
    if (!rows.length) rows = parseFlipper(text);
    if (!rows.length) rows = parsePipe(text);
    if (!rows.length) rows = parsePronto(text);
  }
  const supported = rows.filter((r) => r.supported && r.code).length;
  return {
    format,
    rows,
    supported,
    skipped: rows.length - supported,
  };
}

/** Score a library path against free-text manufacturer/model query. */
export function scoreLibraryPath(path, query) {
  const p = String(path || "").toLowerCase().replace(/[\\/_-]+/g, " ");
  const tokens = String(query || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2);
  if (!tokens.length) return 0;
  let score = 0;
  let hits = 0;
  for (const t of tokens) {
    if (p.includes(t)) {
      hits += 1;
      score += t.length >= 4 ? 12 : 6;
      if (p.split(/\s+/).includes(t)) score += 4;
    }
  }
  if (hits === 0) return -1;
  if (hits === tokens.length) score += 20;
  return score;
}

export function filterLibraryIndex(entries, query, { limit = 40, sourceErrors = [] } = {}) {
  const q = String(query || "").trim();
  const incomplete = formatSourceErrors(sourceErrors);
  if (!q) {
    return {
      matches: [],
      totalMatches: 0,
      message: "Enter a manufacturer and model (or either one) to search the code libraries.",
      incomplete,
      sourceErrors: sourceErrors.slice(),
    };
  }
  const scored = [];
  for (const e of entries) {
    const score = scoreLibraryPath(e.path, q);
    if (score < 0) continue;
    scored.push({ ...e, score });
  }
  scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  if (!scored.length) {
    return {
      matches: [],
      totalMatches: 0,
      message:
        `No library files matched “${q}”. Spelling in open databases varies — try fewer words, ` +
        "a different manufacturer spelling, or drop a code file instead." +
        (incomplete ? ` ${incomplete}` : ""),
      incomplete,
      sourceErrors: sourceErrors.slice(),
    };
  }
  const shown = scored.slice(0, limit);
  let message =
    `Showing ${shown.length} of ${scored.length} match${scored.length === 1 ? "" : "es"}.`;
  if (incomplete) message = `${message} ${incomplete}`;
  return {
    matches: shown,
    totalMatches: scored.length,
    message,
    incomplete,
    sourceErrors: sourceErrors.slice(),
  };
}

/** Human partial-failure copy when some sources load and others do not. */
export function formatSourceErrors(sourceErrors) {
  const list = Array.isArray(sourceErrors) ? sourceErrors.filter(Boolean) : [];
  if (!list.length) return "";
  return (
    `Results are incomplete — failed source${list.length === 1 ? "" : "s"}: ${list.join("; ")}. ` +
    "Matches below cover only the libraries that loaded."
  );
}

/* Allowlist, not sanitiser: index rows are attacker-influenced, so one bad
   segment drops the row. The first char excludes "." (which rejects "." and
   "..") but allows "-", because IRDB really publishes -1,-1.csv sentinels and a
   dash has no traversal meaning. "%", ":", "\", "?", "#", control bytes and
   empty segments stay unspellable — encoded separators, NULs and bad escapes
   cannot get through. */
const IRDB_SAFE_SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9 ()+,&'!~=@$_.-]*$/;

/**
 * Resolve an IRDB index path against the one approved base.
 * @returns {string} exactly `LIBRARY_SOURCES.irdb.fileBase + path` for a safe
 * relative .csv path, or "" when the path is unsafe or not a code file.
 */
export function irdbFileUrl(path) {
  if (typeof path !== "string" || !path.endsWith(".csv")) return "";
  for (const segment of path.split("/")) {
    if (!IRDB_SAFE_SEGMENT.test(segment)) return "";
  }
  const url = LIBRARY_SOURCES.irdb.fileBase + path;
  /* Belt and braces: whatever the allowlist passed must still normalise back
     under the exact /codes/ prefix. */
  try {
    if (!new URL(url).href.startsWith(LIBRARY_SOURCES.irdb.fileBase)) return "";
  } catch {
    return "";
  }
  return url;
}

let cachedIndex = null;

/**
 * Load searchable indexes. `skipped` counts index rows refused by the path
 * boundary — an index note, not a source failure, so it stays out of `errors`.
 * @returns {Promise<{ entries: object[], errors: string[], loaded: string[], skipped: number }>}
 */
export async function loadLibraryIndex({ sources = ["irdb"], fetchImpl = fetch } = {}) {
  const wanted = (sources || []).filter((s) => s === "irdb");
  const key = wanted.slice().sort().join(",") || "none";
  if (cachedIndex && cachedIndex.key === key) {
    return {
      entries: cachedIndex.entries,
      errors: cachedIndex.errors.slice(),
      loaded: cachedIndex.loaded.slice(),
      skipped: cachedIndex.skipped,
    };
  }

  const entries = [];
  const errors = [];
  const loaded = [];
  let skipped = 0;

  if (wanted.includes("irdb")) {
    try {
      const r = await fetchImpl(LIBRARY_SOURCES.irdb.indexUrl, { cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const text = await r.text();
      let n = 0;
      for (const line of text.replace(/\r/g, "").split("\n")) {
        const path = line.trim();
        if (!path) continue;
        const url = irdbFileUrl(path);
        if (!url) {
          skipped += 1;
          continue;
        }
        entries.push({ source: "irdb", path, url });
        n += 1;
      }
      if (!n) {
        throw new Error(
          skipped
            ? `no usable code files in the index (${skipped} skipped by the path safety check)`
            : "index was empty",
        );
      }
      loaded.push("irdb");
    } catch (e) {
      errors.push(`IRDB: ${e.message || e}`);
    }
  }

  /* Reject unknown/removed sources so callers cannot silently enable Flipper. */
  for (const s of sources || []) {
    if (s && s !== "irdb") {
      errors.push(
        `${s}: browser search is not available for this library (use a downloaded file instead)`,
      );
    }
  }

  if (!entries.length) {
    throw new Error(
      errors.length
        ? `Could not load code libraries (${errors.join("; ")}). Check network access from this browser.`
        : "No library sources selected.",
    );
  }

  cachedIndex = { key, entries, errors: errors.slice(), loaded: loaded.slice(), skipped };
  return { entries, errors, loaded, skipped };
}

/** Fetch a library file, from the approved IRDB base only — never from a URL
    the entry carries, which a forged index row could have chosen. */
export async function fetchLibraryFile(entry, { fetchImpl = fetch } = {}) {
  if (entry?.source !== "irdb") {
    throw new Error("Refusing to fetch: only IRDB entries can be fetched from the browser.");
  }
  const path = typeof entry.path === "string" ? entry.path : "";
  if (!path) throw new Error("Refusing to fetch: library entry has no path.");
  const url = irdbFileUrl(path);
  if (!url) throw new Error(`Refusing to fetch unsafe library path: ${safeName(path)}`);
  if (entry.url !== undefined && entry.url !== url) {
    throw new Error(`Refusing to fetch: entry URL does not match its path (${safeName(path)}).`);
  }
  const r = await fetchImpl(url, { cache: "no-store" });
  if (!r.ok) throw new Error(`Fetch failed HTTP ${r.status} for ${path}`);
  return r.text();
}

/**
 * Account for every row: found → supported → importable (safe name) → willImport.
 * Callers must show these numbers so preview and post-import inventory reconcile.
 */
export function planImport(rows, existingCount = 0) {
  const list = Array.isArray(rows) ? rows : [];
  const found = list.length;
  let unsupported = 0;
  let unsafeName = 0;
  const importableRows = [];
  for (const row of list) {
    if (!row?.supported || !row.code) {
      unsupported += 1;
      continue;
    }
    if (!isSafeLabel(row.name, LIMITS.name)) {
      unsafeName += 1;
      continue;
    }
    importableRows.push(row);
  }
  const supported = found - unsupported;
  const importable = importableRows.length;
  const room = Math.max(0, LIMITS.storedCommands - (Number(existingCount) || 0));
  const batchCap = LIMITS.batchCommands;
  const willImport = Math.min(importable, room, batchCap);
  const truncated = Math.max(0, importable - willImport);
  const notes = [];
  notes.push(
    `${found} found · ${supported} supported · ${unsupported} unsupported` +
      (unsafeName ? ` · ${unsafeName} unsafe name${unsafeName === 1 ? "" : "s"}` : "") +
      ` · ${willImport} will import` +
      (truncated ? ` · ${truncated} held back by hub limits` : "") +
      ".",
  );
  notes.push(`Hub keeps at most ${LIMITS.storedCommands} commands per device (${room} free on this one).`);
  notes.push(`One import request stages at most ${batchCap} commands.`);
  if (truncated) {
    notes.push(
      `Only the first ${willImport} of ${importable} importable command${importable === 1 ? "" : "s"} fit this request.`,
    );
  }
  return {
    found,
    supported,
    unsupported,
    unsafeName,
    importable,
    willImport,
    truncated,
    room,
    batchCap,
    notes,
    summary: notes[0],
  };
}

/** @deprecated use planImport — kept for call sites that only need caps. */
export function describeImportLimits(existingCount, importCount) {
  const plan = planImport(
    Array.from({ length: importCount }, (_, i) => ({
      name: `Cmd${i}`,
      code: "x",
      supported: true,
    })),
    existingCount,
  );
  return {
    room: plan.room,
    batchCap: plan.batchCap,
    willImport: plan.willImport,
    notes: plan.notes.slice(1),
  };
}

/** Build pipe payload lines the hub's /api/irdb-import accepts. */
export function rowsToImportPayload(rows, { max = LIMITS.batchCommands } = {}) {
  const lines = [];
  for (const row of rows) {
    if (!row?.supported || !row.code) continue;
    if (!isSafeLabel(row.name, LIMITS.name)) continue;
    if (row.mode === "raw") lines.push(`${row.name}|raw|${row.code}`);
    else lines.push(`${row.name}|keycode|${row.code}`);
    if (lines.length >= max) break;
  }
  return lines.join("\n");
}

/** Clear cached indexes (tests). */
export function resetLibraryCache() {
  cachedIndex = null;
}
