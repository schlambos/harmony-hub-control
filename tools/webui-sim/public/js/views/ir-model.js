/* Pure data shaping and validation for the IR setup view.
   No DOM, no network — importable under node:test, mirroring the exact
   limits and parsers in payload/source/codex_webui.c so the client can
   pre-validate before the hub's byte-for-byte parsers get the request. */

/* Buffer sizes in codex_webui.c are declared one larger than the usable
   label length (form_value NUL-terminates), so the ceilings here are the
   declared size minus one. MAX_* constants are copied verbatim. */
export const LIMITS = Object.freeze({
  deviceId: 63, // char device_id[64]
  command: 127, // char command[128]
  name: 127, // char name[128]
  manufacturer: 127,
  model: 127,
  deviceType: 79, // char type[80]
  mode: 31, // char mode[32]
  protocol: 31, // char protocol[32]
  nec: 63, // char nec[64]
  keycode: 511, // char keycode[512]
  raw: 2047, // char raw[2048]
  runId: 96, // safe_run_id: 1..96
  rawImport: 4096, // safe_raw_import_value
  batchCommands: 1024, // MAX_IR_BATCH_COMMANDS
  storedCommands: 2048, // MAX_IR_STORED_COMMANDS
  devices: 32, // MAX_IR_DEVICES
  delayMin: 40, // render_ir_batch_send_json clamps
  delayMax: 10000,
});

/* harmony_device_type_id() recognises these (anything else falls back to the
   HomeAppliance id), so they are the honest options for a new device. */
export const DEVICE_TYPES = Object.freeze([
  "Television",
  "Amplifier",
  "Media Player",
  "Game Console",
  "Home Appliance",
]);

/* Mirror of safe_label(): non-empty, no control chars (<32 / 127), no '"' and
   no backslash, bounded by the destination buffer. */
export function isSafeLabel(value, max = LIMITS.name) {
  const s = String(value ?? "");
  if (!s || s.length > max) return false;
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c < 32 || c === 127 || c === 0x22 || c === 0x5c) return false;
  }
  return true;
}

/* Mirror of safe_run_id(): 1..96 chars of [A-Za-z0-9_.-]. */
export function isSafeRunId(value) {
  const s = String(value ?? "");
  return s.length > 0 && s.length <= LIMITS.runId && /^[A-Za-z0-9_.-]+$/.test(s);
}

export function clampDelay(ms) {
  const n = Number.parseInt(ms, 10);
  if (!Number.isFinite(n)) return LIMITS.delayMin;
  return Math.min(LIMITS.delayMax, Math.max(LIMITS.delayMin, n));
}

/* run ids only ever contain safe_run_id characters. */
export function makeRunId(prefix = "webui") {
  const rand = Math.floor(Math.random() * 1e9).toString(36);
  return `${prefix}_${Date.now().toString(36)}_${rand}`;
}

/* The hub answers ir.cap with the full hbus envelope. When nothing was heard
   the envelope's "data" is an empty object (the emulator always returns this;
   a real hub with no frame in the window does too). */
export function hbusDataIsEmpty(text) {
  try {
    const j = JSON.parse(String(text ?? "").trim());
    if (j && typeof j === "object" && Object.prototype.hasOwnProperty.call(j, "data")) {
      const d = j.data;
      return d == null || (typeof d === "object" && Object.keys(d).length === 0);
    }
  } catch (_) { /* not a JSON envelope */ }
  return false;
}

/* Mirror of the shell's captureLooksEmpty() plus the empty-envelope case. */
export function captureLooksEmpty(text) {
  const t = String(text ?? "").trim();
  return !t || /no payload|returned no|timeout/i.test(t) || hbusDataIsEmpty(t);
}

/* Normalise a /api/capture reply into the signal the learn forms consume.
   mode is "" when nothing usable arrived (no receiver / empty capture). */
export function analyzeCapture(capture) {
  const raw = String(capture?.raw ?? "").trim();
  const keycode = String(capture?.keycode ?? "").trim();
  const nec = String(capture?.nec ?? "").trim();
  const looksEmpty = captureLooksEmpty(raw);
  const mode = keycode ? "keycode" : nec ? "nec" : !looksEmpty && raw ? "raw" : "";
  const protocolId = Number.parseInt(capture?.protocolId, 10);
  return {
    empty: mode === "",
    mode,
    keycode,
    nec,
    raw,
    protocolId: Number.isFinite(protocolId) && protocolId > 0 ? protocolId : 2,
    analysis: String(capture?.analysis ?? "").trim(),
  };
}

/* Validate + normalise the signal fields shared by /ir/command,
   /ir/update-command and /api/ir-test-learned. Throws Error with the same
   wording the hub uses so a client rejection reads like a server one. */
export function normalizeSignal(input, { defaultMode = "auto" } = {}) {
  const mode = String(input?.mode ?? "").trim() || defaultMode;
  const protocol = String(input?.protocol ?? "").trim() || "2";
  const nec = String(input?.nec ?? "").trim();
  const keycode = String(input?.keycode ?? "").trim();
  const raw = String(input?.raw ?? "").trim();
  if (mode === "keycode" && !keycode) throw new Error("Harmony compact code is required.");
  if (mode === "nec") {
    if (!/^(0x)?[0-9a-fA-F]{1,8}$/.test(nec)) throw new Error("NEC value must be 1-8 hex digits.");
  }
  if (mode === "raw" && !raw) throw new Error("Raw command data is required.");
  if (mode === "auto" && !keycode && !nec && !raw) {
    throw new Error("Learn or enter a signal before testing");
  }
  if (raw.length > LIMITS.raw) throw new Error(`Raw data is longer than ${LIMITS.raw} characters.`);
  if (keycode.length > LIMITS.keycode) throw new Error(`KeyCode is longer than ${LIMITS.keycode} characters.`);
  return { mode, protocol, nec, keycode, raw };
}

/* Mirror of build_nec_keycode's accepted shape: optional 0x + 1..8 hex. */
export function isNecHex(value) {
  return /^(0x)?[0-9a-fA-F]{1,8}$/.test(String(value ?? "").trim());
}

/* Split command names into newline-joined chunks the hub will accept in one
   /api/ir-batch-send. Invalid labels are dropped up front (the hub would
   skip them anyway) and each chunk stays under MAX_IR_BATCH_COMMANDS. */
export function chunkCommands(names, chunkSize) {
  const clean = (Array.isArray(names) ? names : [])
    .map((n) => String(n ?? "").trim())
    .filter((n) => isSafeLabel(n, LIMITS.command));
  const requested = Number.parseInt(chunkSize, 10);
  const size = Number.isFinite(requested) && requested > 0
    ? Math.min(requested, LIMITS.batchCommands)
    : Math.max(1, Math.min(clean.length || 1, LIMITS.batchCommands));
  const chunks = [];
  for (let i = 0; i < clean.length; i += size) {
    chunks.push(clean.slice(i, i + size).join("\n"));
  }
  return { chunks, total: clean.length, dropped: (names?.length ?? 0) - clean.length };
}

/* Client preview of bulk_import_irdb_commands(): counts the rows the hub will
   stage from a pipe ("name|keycode" / "name|mode|code") or IRDB CSV payload.
   The hub re-validates everything; this only keeps the UI honest. */
export function parseIrdbLines(text) {
  const rows = [];
  let skipped = 0;
  for (const rawLine of String(text ?? "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.includes("|")) {
      const parts = line.split("|").map((p) => p.trim());
      const name = parts[0] ?? "";
      let mode = "keycode";
      let code = "";
      if (parts.length >= 3) {
        const m = (parts[1] ?? "").toLowerCase();
        if (m === "raw") { mode = "raw"; code = parts[2] ?? ""; }
        else if (m === "keycode") { mode = "keycode"; code = parts[2] ?? ""; }
        else { mode = "keycode"; code = parts[1] ?? ""; }
      } else if (parts.length >= 2) {
        code = parts[1] ?? "";
      }
      if (name && code && isSafeLabel(name, LIMITS.name)) rows.push({ name, mode, code });
      else skipped += 1;
    } else {
      const parts = line.split(",").map((p) => p.trim());
      if (parts.length >= 5 && (parts[0] ?? "").toLowerCase() !== "functionname") {
        rows.push({ name: parts[0], mode: "irdb", code: parts.slice(1, 5).join(",") });
      } else {
        skipped += 1;
      }
    }
  }
  return { rows, skipped };
}

/* --- RemoteCentral (outbound, offline by design) ----------------------- */

const NAMED_ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", copy: "©",
  reg: "®", hellip: "…", mdash: "—", ndash: "–", rsquo: "’", lsquo: "‘",
  rdquo: "”", ldquo: "“", trade: "™",
};

export function decodeEntities(text) {
  return String(text ?? "").replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, body) => {
    if (body[0] === "#") {
      const hex = body[1] === "x" || body[1] === "X";
      const code = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? m;
  });
}

/* Mirror of harmonyRawFromTimings(): F<freqHex> then P/S<pulseHex> pairs. */
export function harmonyRawFromTimings(freq, vals) {
  const f = Math.max(10000, Math.min(60000, Math.round(Number(freq) || 38000)));
  const timed = (vals || [])
    .map((v) => Math.max(1, Math.min(0xfffff, Math.round(Math.abs(Number(v) || 0)))))
    .filter(Boolean);
  if (timed.length === 3) timed.push(100000);
  if (timed.length < 4) return "";
  let raw = "F" + f.toString(16).toUpperCase();
  timed.forEach((v, i) => { raw += (i % 2 ? "S" : "P") + v.toString(16).toUpperCase(); });
  return raw.length <= LIMITS.rawImport ? raw : "";
}

/* Mirror of prontoToHarmonyRaw(): only learned (0000) frames convert. */
export function prontoToHarmonyRaw(hex) {
  const words = String(hex || "").trim().split(/\s+/).filter(Boolean).map((x) => Number.parseInt(x, 16));
  if (words.length < 8 || words.some((x) => !Number.isFinite(x))) return "";
  if (words[0] !== 0) return "";
  const unit = (words[1] || 1) * 0.241246;
  const frequency = Math.round(1000000 / unit);
  const pairs = (words[2] || 0) + (words[3] || 0);
  const vals = words.slice(4, 4 + pairs * 2).map((w) => Math.round(w * unit));
  return harmonyRawFromTimings(frequency, vals);
}

const PRONTO_RE = /((?:0000|0100|5000|6000|7000)(?:\s+[0-9a-fA-F]{4}){10,})/g;

function rcCleanName(s) {
  const t = decodeEntities(s)
    .replace(/\(\s*Copy\s+to\s+Clipboard\s*\)/gi, "")
    .replace(/[|"\\]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!t || /^(Image|Return|Remote Model|Infrared Hex|This model|Features|Hex Codes|Page:|Copyright|Home|News|Reviews|Files|Forums)$/i.test(t)) {
    return "";
  }
  return t.slice(0, 96);
}

function rcCommandName(lines, i, prefix) {
  const direct = rcCleanName(prefix);
  if (direct) return direct;
  for (let j = i - 1; j >= 0 && j >= i - 8; j -= 1) {
    const n = rcCleanName(lines[j]);
    if (n && !/^[0-9a-f]{4}\s/i.test(n)) return n;
  }
  return `Command ${i + 1}`;
}

/* Mirror of remoteCentralCommandEntries(): pull Pronto hex runs out of a
   RemoteCentral page and convert them to Harmony raw where possible. */
export function remoteCentralCommands(html) {
  const text = String(html ?? "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<\/(td|tr|p|div|li)>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  const lines = decodeEntities(text)
    .replace(/\(Copy to Clipboard\)/gi, "\n")
    .replace(/\r/g, "")
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const rows = [];
  lines.forEach((line, i) => {
    let m;
    PRONTO_RE.lastIndex = 0;
    while ((m = PRONTO_RE.exec(line))) {
      const hex = m[1].replace(/\s+/g, " ").trim();
      const raw = prontoToHarmonyRaw(hex);
      rows.push({ name: rcCommandName(lines, i, line.slice(0, m.index)), hex, raw });
    }
  });
  return rows;
}

/* A RemoteCentral path must stay inside /cgi-bin/codes/ for the hub's
   safe_remotecentral_path(); normalise a pasted URL or relative link. */
export function normalizeRemoteCentralPath(input) {
  let path = String(input ?? "").trim();
  try {
    if (/^https?:/i.test(path)) path = new URL(path).pathname + new URL(input).search;
  } catch (_) { /* keep raw */ }
  path = path.replace(/^https?:\/\/(?:www\.)?remotecentral\.com/i, "");
  if (!path || path[0] === "#" || path[0] === "?") return "";
  if (path[0] !== "/") path = `/cgi-bin/codes/${path.replace(/^\.\//, "")}`;
  return path;
}

/* Inventory shaping for the overview panel. */
export function describeInventory(inv) {
  const devices = Array.isArray(inv?.devices) ? inv.devices : [];
  return {
    ok: Boolean(inv?.ok),
    deviceCount: Number(inv?.deviceCount ?? devices.length),
    totalCommandCount: Number(inv?.totalCommandCount ?? 0),
    displayDeviceLimit: Number(inv?.displayDeviceLimit ?? LIMITS.devices),
    displayCommandLimit: Number(inv?.displayCommandLimit ?? 160),
    storageCommandLimit: Number(inv?.storageCommandLimit ?? LIMITS.storedCommands),
    batchCommandLimit: Number(inv?.batchCommandLimit ?? LIMITS.batchCommands),
    devices: devices.map((d) => ({
      id: String(d?.id ?? ""),
      name: String(d?.name ?? ""),
      manufacturer: String(d?.manufacturer ?? ""),
      model: String(d?.model ?? ""),
      type: String(d?.type ?? ""),
      controlPort: Number(d?.controlPort ?? 7),
      transport: Number(d?.transport ?? 1),
      commands: Array.isArray(d?.commands) ? d.commands.map((c) => ({
        id: String(c?.id ?? ""),
        name: String(c?.name ?? ""),
        keycode: String(c?.keycode ?? ""),
        protocolId: Number(c?.protocolId ?? 0),
        learned: Boolean(c?.learned),
        raw: Boolean(c?.raw),
      })) : [],
    })),
  };
}
