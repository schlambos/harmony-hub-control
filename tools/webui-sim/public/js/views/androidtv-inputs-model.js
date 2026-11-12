/* How a network TV switches inputs: the logic behind the Inputs section of a
   network TV's Settings page, without the DOM, so it can be tested in node.

   Three places hold a network TV's inputs:
   - the device's InputFeature (names, order, delay; each input's command is a
     slot, InputHdmi1-4 then Input5-Input32), written by codexactivity's
     CommitAndroidTvDevices;
   - codex_androidtv's profile for the TV (inputs-<id>.tsv): the method and,
     per slot, what it opens, plus the user's last Try result;
   - the brand presets file (androidtv-input-presets.json): suggestions.
   The page edits one draft that holds all of it; save() splits it again. */

import { MAX_INPUTS } from "./device-settings-model.js";

export const MAX_SLOTS = MAX_INPUTS;
export const MENU_GAP_MS = 500;
export const MENU_GAP_LIMITS = Object.freeze([100, 2000]);

/* The method choice, in the page's order. */
export const METHODS = Object.freeze([
  { value: "link", label: "Open each input directly" },
  { value: "keys", label: "Android input keys" },
  { value: "menu", label: "Input menu, then keys" },
  { value: "none", label: "Don't switch inputs" },
]);

/* What the keys method can open: Android's TV input keys. */
export const KEY_TARGETS = Object.freeze([
  { value: 243, label: "HDMI 1" }, { value: 244, label: "HDMI 2" },
  { value: 245, label: "HDMI 3" }, { value: 246, label: "HDMI 4" },
  { value: 247, label: "AV 1" }, { value: 248, label: "AV 2" },
  { value: 249, label: "Component 1" }, { value: 250, label: "Component 2" },
  { value: 251, label: "VGA" }, { value: 170, label: "Live TV" },
]);

export const STATUSES = Object.freeze(["untested", "works", "failed"]);

/* The link-per-input choice in the pattern picker. */
export const CUSTOM_LINKS = "custom";

/* A TV with nothing saved whose behaviour the page can't know (no preset for
   its manufacturer): the hub's built-in switching, until a method is chosen. */
export const BUILTIN = "builtin";

/* -- slots ------------------------------------------------------------------ */

export function slotCommand(n) {
  return n <= 4 ? `InputHdmi${n}` : `Input${n}`;
}

/* The slot a command is, or 0. */
export function slotOf(command) {
  const text = String(command ?? "").toLowerCase();
  let m = /^inputhdmi([1-4])$/.exec(text);
  if (m) return Number(m[1]);
  m = /^input(\d{1,2})$/.exec(text);
  const n = m ? Number(m[1]) : 0;
  return n >= 5 && n <= MAX_SLOTS ? n : 0;
}

/* The lowest slot no row uses, or 0 when all are taken. */
export function freeSlot(rows) {
  const used = new Set(rows.map((r) => r.slot));
  for (let n = 1; n <= MAX_SLOTS; n++) if (!used.has(n)) return n;
  return 0;
}

/* -- links ------------------------------------------------------------------ */

/* A link the TV is asked to open, as codex_androidtv checks it. */
export function linkOk(uri, max = 199) {
  const u = String(uri ?? "");
  if (u.length < 3 || u.length > max) return false;
  if (!/^[A-Za-z][A-Za-z0-9+.-]*:/.test(u)) return false;
  return !/[\u0000-\u0020\u007f-\uffff"\\`]/.test(u);
}

export function patternOk(uri) {
  const u = String(uri ?? "");
  const at = u.indexOf("{n}");
  return at >= 0 && u.indexOf("{n}", at + 3) < 0 && linkOk(u, 191);
}

export function expandPattern(pattern, n) {
  return String(pattern).replace("{n}", String(n));
}

/* -- the presets file -------------------------------------------------------- */

const EMPTY_PRESETS = Object.freeze({ patterns: [], presets: [], fallback: null });

function presetInputs(raw, method) {
  const out = [];
  for (const input of Array.isArray(raw) ? raw : []) {
    const name = String(input?.name ?? "").trim();
    if (!name || name.length > 64 || /["\\\u0000-\u001f]/.test(name)) return null;
    let value;
    if (method === "keys") value = Number(input.key);
    else if (method === "menu") value = Number(input.position);
    else value = input.link !== undefined ? String(input.link) : Number(input.n);
    out.push({ name, value });
  }
  return out.length <= MAX_SLOTS ? out : null;
}

/* The presets file, checked. Entries that don't hold are left out (and a
   broken file is the same as none), so an edit to it can't break the page. */
export function readPresets(json) {
  if (!json || typeof json !== "object" || json.version !== 1) return EMPTY_PRESETS;
  const patterns = [];
  for (const p of Array.isArray(json.patterns) ? json.patterns : []) {
    const id = String(p?.id ?? "");
    if (!/^[a-z0-9-]{1,40}$/.test(id) || !patternOk(p?.uri) || patterns.some((q) => q.id === id)) continue;
    patterns.push({ id, label: String(p.label || id).slice(0, 60), uri: String(p.uri), untested: Boolean(p.untested) });
  }
  const one = (raw) => {
    const method = String(raw?.method ?? "");
    if (!["keys", "link", "menu", "none"].includes(method)) return null;
    const pattern = method === "link" && raw.pattern ? patterns.find((p) => p.id === raw.pattern) : null;
    if (method === "link" && raw.pattern && !pattern) return null;
    const inputs = presetInputs(raw.inputs, method);
    if (!inputs) return null;
    const valueOk = (v) => method === "keys" ? Number.isInteger(v) && v >= 1 && v <= 999
      : method === "menu" ? Number.isInteger(v) && v >= 1 && v <= MAX_SLOTS
        : pattern ? Number.isInteger(v) && v >= 0 && v <= 9999 : linkOk(v);
    if (method !== "none" && !inputs.every((i) => valueOk(i.value))) return null;
    const gap = Number(raw.gapMs);
    return {
      vendor: String(raw.vendor ?? ""),
      model: typeof raw.model === "string" ? raw.model : "",
      method,
      pattern: pattern ? pattern.id : "",
      // A suggestion built on an untested pattern is offered, never applied
      // on its own when a TV is added.
      untestedPattern: Boolean(pattern?.untested),
      gapMs: Number.isInteger(gap) && gap >= MENU_GAP_LIMITS[0] && gap <= MENU_GAP_LIMITS[1] ? gap : MENU_GAP_MS,
      inputs,
      checked: raw.checked && typeof raw.checked === "object"
        ? { model: String(raw.checked.model ?? ""), date: String(raw.checked.date ?? ""),
          inputs: Array.isArray(raw.checked.inputs) ? raw.checked.inputs.map(String) : [] }
        : null,
    };
  };
  const presets = (Array.isArray(json.presets) ? json.presets : []).map(one).filter((p) => p && p.vendor);
  return { patterns, presets, fallback: one(json.default) };
}

const BUILTIN_FALLBACK = Object.freeze({
  vendor: "", model: "", method: "keys", pattern: "", gapMs: MENU_GAP_MS, checked: null,
  inputs: [243, 244, 245, 246].map((value, i) => ({ name: `HDMI ${i + 1}`, value })),
});

/* The preset for a TV: vendor (case-insensitive prefix), then model (a
   regular expression, when the preset gives one); else the file's default,
   else the HDMI keys. */
export function matchPreset(presets, vendor, model) {
  const v = String(vendor ?? "").toLowerCase();
  for (const p of presets?.presets ?? []) {
    if (!v || !v.startsWith(p.vendor.toLowerCase())) continue;
    if (p.model) {
      let re = null;
      try { re = new RegExp(p.model, "i"); } catch { re = null; }
      if (!re || !re.test(String(model ?? ""))) continue;
    }
    return p;
  }
  return presets?.fallback ?? BUILTIN_FALLBACK;
}

/* -- the profile (codex_androidtv's inputs-<id>.tsv) -------------------------- */

/* The profile text as codex_androidtv stores it, read back. null for none or
   a text that doesn't parse (codex_androidtv refuses those anyway). */
export function parseProfile(text) {
  if (typeof text !== "string" || !text) return null;
  const out = { method: "", pattern: "", gapMs: MENU_GAP_MS, slots: new Map() };
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (!line || line.startsWith("#")) continue;
    const f = line.split("\t");
    if (f[0] === "method" && f.length === 2) out.method = f[1];
    else if (f[0] === "pattern" && f.length === 2) out.pattern = f[1];
    else if (f[0] === "gap" && f.length === 2) out.gapMs = Number(f[1]);
    else if (f[0] === "slot" && f.length === 5) {
      const n = Number(f[1]);
      const value = out.method === "link" && !out.pattern ? f[2] : Number(f[2]);
      out.slots.set(n, { value, status: STATUSES.includes(f[3]) ? f[3] : "untested", date: f[4] === "-" ? "" : f[4] });
    } else return null;
  }
  return ["keys", "link", "menu", "none"].includes(out.method) ? out : null;
}

/* The profile text for a draft. */
export function profileText(draft) {
  if (draft.method === BUILTIN) return "";   // nothing to save: the hub keeps its own
  const lines = [`method\t${draft.method}`];
  if (draft.method === "link" && draft.pattern !== CUSTOM_LINKS) lines.push(`pattern\t${patternUri(draft)}`);
  if (draft.method === "menu") lines.push(`gap\t${draft.gapMs}`);
  if (draft.method !== "none") {
    for (const row of [...draft.rows].sort((a, b) => a.slot - b.slot)) {
      lines.push(`slot\t${row.slot}\t${row.value}\t${row.status || "untested"}\t${row.date || "-"}`);
    }
  }
  return lines.join("\n") + "\n";
}

/* The draft's link pattern: a presets-file pattern by id, or the one a saved
   profile had that the file doesn't list. */
export function patternUri(draft) {
  if (draft.method !== "link" || draft.pattern === CUSTOM_LINKS) return "";
  return draft.patterns.find((p) => p.id === draft.pattern)?.uri ?? "";
}

/* -- the draft ----------------------------------------------------------------- */

/* The rows of a draft from a preset (names in order, each a fresh slot). */
function rowsFromPreset(preset) {
  return preset.inputs.map((input, i) => ({ name: input.name, slot: i + 1, value: input.value, status: "untested", date: "" }));
}

function draftPatterns(presets, savedPattern) {
  const patterns = [...(presets?.patterns ?? [])];
  if (savedPattern && !patterns.some((p) => p.uri === savedPattern)) {
    patterns.push({ id: "saved", label: "The link saved on the hub", uri: savedPattern, untested: false });
  }
  return patterns;
}

/**
 * The page's draft for a network TV.
 * entryInputs: the device's inputs in order, [{name, command}] (command a slot
 * command), or null when it has none ("don't switch").
 * profile: parseProfile()'s result, or null (codex_androidtv's built-in
 * behaviour, which the matching preset describes).
 */
export function readTvInputs({ entryInputs, delayMs = 0, profile, presets, vendor = "", model = "" }) {
  const preset = matchPreset(presets, vendor, model);
  const draft = {
    method: "keys", pattern: CUSTOM_LINKS, gapMs: MENU_GAP_MS, delayMs, rows: [],
    patterns: draftPatterns(presets, profile?.pattern), preset, fromProfile: Boolean(profile),
  };
  if (!profile) {
    // Built-in: what codex_androidtv does without a profile, which the
    // preset for this vendor describes, on the device's own inputs. With no
    // preset for the device's manufacturer (a TV paired before brands were
    // saved is "Android TV"), the page can't know what the hub does (it goes
    // by the brand the TV reports), so it says "built-in" rather than guess:
    // saving a guess would replace what works.
    draft.method = entryInputs === null ? "none" : preset.vendor ? preset.method : BUILTIN;
    draft.pattern = preset.method === "link" ? preset.pattern || CUSTOM_LINKS : CUSTOM_LINKS;
    draft.gapMs = preset.gapMs;
    const byName = new Map(preset.inputs.map((i) => [i.name.toLowerCase(), i.value]));
    const presetRows = rowsFromPreset(preset);
    draft.rows = slotted((entryInputs ?? []).map((input) => {
      const slot = slotOf(input.command);
      const fromName = byName.get(String(input.name).toLowerCase());
      const fromSlot = slot ? presetRows.find((r) => r.slot === slot)?.value : undefined;
      return { name: input.name, slot, value: slot ? fromName ?? fromSlot ?? "" : "", status: "untested", date: "", was: slot ? "" : input.command };
    }));
    return draft;
  }
  draft.method = entryInputs === null ? "none" : profile.method;
  draft.gapMs = profile.gapMs;
  if (profile.method === "link") {
    draft.pattern = profile.pattern ? draft.patterns.find((p) => p.uri === profile.pattern)?.id ?? CUSTOM_LINKS : CUSTOM_LINKS;
  }
  draft.rows = slotted((entryInputs ?? []).map((input) => {
    const slot = slotOf(input.command);
    const saved = slot ? profile.slots.get(slot) : null;
    return { name: input.name, slot, value: saved?.value ?? "", status: saved?.status ?? "untested", date: saved?.date ?? "", was: slot ? "" : input.command };
  }));
  return draft;
}

/* Inputs set up before slots (the generic editor could point one at any
   command, such as Home): each gets the lowest free slot, with nothing to open
   yet and `was` naming its old command, instead of vanishing from the page.
   Nothing changes on the hub until the inputs are saved. */
function slotted(rows) {
  for (const row of rows) {
    if (row.slot) continue;
    row.slot = freeSlot(rows.filter((r) => r.slot)) ?? null;
  }
  return rows.filter((r) => r.slot);
}

/* A new row: the lowest free slot, nothing to open yet. */
export function addRow(draft, name = "") {
  const slot = freeSlot(draft.rows);
  if (!slot) return null;
  const row = { name, slot, value: "", status: "untested", date: "" };
  draft.rows.push(row);
  return row;
}

/* Change the method: names, order and slots stay; each row keeps an
   equivalent target where the preset maps it, else none; all go untested. */
export function setMethod(draft, method) {
  if (draft.method === method) return;
  draft.method = method;
  const preset = draft.preset;
  const sameMethod = preset && preset.method === method;
  const byName = new Map((sameMethod ? preset.inputs : []).map((i) => [i.name.toLowerCase(), i.value]));
  const keyByName = new Map(KEY_TARGETS.map((k) => [k.label.toLowerCase(), k.value]));
  const bySlot = sameMethod ? rowsFromPreset(preset) : [];
  for (const row of draft.rows) {
    // By name, else (a renamed input) by its slot in the preset.
    let value = byName.get(row.name.trim().toLowerCase()) ?? bySlot.find((r) => r.slot === row.slot)?.value;
    if (value === undefined && method === "keys") value = keyByName.get(row.name.toLowerCase());
    if (value === undefined && method === "menu") value = draft.rows.indexOf(row) + 1;
    row.value = value ?? "";
    row.status = "untested";
    row.date = "";
  }
  if (method === "link") draft.pattern = sameMethod && preset.pattern ? preset.pattern : draft.patterns[0]?.id ?? CUSTOM_LINKS;
  if (method === "menu" && !(draft.gapMs >= MENU_GAP_LIMITS[0])) draft.gapMs = MENU_GAP_MS;
}

/* Change the link pattern: numbers stay (they mean the same input number in
   the new pattern), links per input clear; all go untested. */
export function setPattern(draft, pattern) {
  if (draft.pattern === pattern) return;
  const wasCustom = draft.pattern === CUSTOM_LINKS;
  draft.pattern = pattern;
  for (const row of draft.rows) {
    if (wasCustom || pattern === CUSTOM_LINKS) row.value = "";
    row.status = "untested";
    row.date = "";
  }
}

/* Use the suggested setup: the preset's inputs and method. Rows whose name
   the preset has keep their slot (activities keep working). */
export function applyPreset(draft) {
  const preset = draft.preset;
  const old = new Map(draft.rows.map((r) => [r.name.toLowerCase(), r.slot]));
  draft.method = preset.method;
  draft.pattern = preset.method === "link" ? preset.pattern || CUSTOM_LINKS : CUSTOM_LINKS;
  draft.gapMs = preset.gapMs;
  const rows = [];
  for (const input of preset.inputs) {
    const keep = old.get(input.name.toLowerCase());
    rows.push({ name: input.name, slot: keep ?? 0, value: input.value, status: "untested", date: "" });
  }
  for (const row of rows) if (!row.slot) row.slot = freeSlot(rows);
  draft.rows = rows;
}

/* Rows marked Works that applyPreset() would change. */
export function presetChangesWorkingRows(draft) {
  const preset = draft.preset;
  const want = new Map(preset.inputs.map((i) => [i.name.toLowerCase(), i.value]));
  return draft.rows.filter((r) => r.status === "works" &&
    (preset.method !== draft.method || (preset.method === "link" && (preset.pattern || CUSTOM_LINKS) !== draft.pattern) ||
      want.get(r.name.toLowerCase()) !== r.value));
}

/* -- checks ---------------------------------------------------------------------- */

function valueProblem(draft, value) {
  switch (draft.method) {
    case "keys": return Number.isInteger(value) && value >= 1 && value <= 999 ? "" : "a key";
    case "menu": return Number.isInteger(value) && value >= 1 && value <= MAX_SLOTS ? "" : "a position in the input menu";
    case "link":
      if (draft.pattern === CUSTOM_LINKS) return linkOk(value) ? "" : "a link";
      return Number.isInteger(value) && value >= 0 && value <= 9999 ? "" : "an input number";
    default: return "";
  }
}

/* What stops the draft from saving, in words, first problem first. */
export function tvInputProblems(draft, { appLinks = true } = {}) {
  const problems = [];
  if (draft.method === BUILTIN) {
    // Names and order can change; HDMI 1-4 are all the built-in behaviour has.
    const names = new Set();
    for (const row of draft.rows) {
      const name = String(row.name ?? "").trim();
      if (!name || name.length > 64 || /[\u0000-\u001f\u007f"\\]/.test(name)) problems.push("Input names must be 1–64 characters without quotes or backslashes.");
      else if (names.has(name.toLowerCase())) problems.push(`Input "${name}" is listed twice.`);
      names.add(name.toLowerCase());
    }
    if (draft.rows.some((r) => r.slot > 4 || r.was)) problems.push("Choose how the TV switches inputs to add inputs beyond HDMI 1–4.");
    return problems;
  }
  if (!METHODS.some((m) => m.value === draft.method)) return ["Choose how the TV switches inputs."];
  if (draft.method === "none") return problems;
  if (draft.method === "link" && draft.pattern !== CUSTOM_LINKS && !patternUri(draft)) problems.push("Choose the input links.");
  if (draft.method === "link" && appLinks === false) problems.push("This TV doesn't accept input links. Choose another way.");
  if (draft.method === "menu" && !(Number.isInteger(draft.gapMs) && draft.gapMs >= MENU_GAP_LIMITS[0] && draft.gapMs <= MENU_GAP_LIMITS[1])) {
    problems.push(`The gap between keys is ${MENU_GAP_LIMITS[0]}–${MENU_GAP_LIMITS[1]} ms.`);
  }
  if (!draft.rows.length) problems.push("List at least one input, or choose Don't switch inputs.");
  const names = new Set();
  const targets = new Map();
  for (const row of draft.rows) {
    const name = String(row.name ?? "").trim();
    if (!name || name.length > 64 || /[\u0000-\u001f\u007f"\\]/.test(name)) {
      problems.push("Input names must be 1–64 characters without quotes or backslashes.");
      continue;
    }
    if (names.has(name.toLowerCase())) problems.push(`Input "${name}" is listed twice.`);
    names.add(name.toLowerCase());
    if (row.value === "" || row.value === null || row.value === undefined) {
      problems.push(`Choose what ${name} opens.`);
      continue;
    }
    const bad = valueProblem(draft, row.value);
    if (bad) problems.push(`${name} needs ${bad}.`);
    const key = String(row.value);
    if (targets.has(key)) problems.push(`${targets.get(key)} and ${name} open the same thing.`);
    else targets.set(key, name);
  }
  return problems;
}

/* -- labels ------------------------------------------------------------------------ */

export function ordinal(n) {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
}

/* What a row opens, in words. */
export function targetLabel(draft, value) {
  if (draft.method === BUILTIN) return "Built-in";
  if (value === "" || value === null || value === undefined) return "Not set";
  switch (draft.method) {
    case "keys": return KEY_TARGETS.find((k) => k.value === value)?.label ?? `Key ${value}`;
    case "menu": return `${ordinal(value)} in the menu`;
    case "link":
      if (draft.pattern === CUSTOM_LINKS) {
        const text = String(value);
        return text.length > 28 ? `…${text.slice(-26)}` : text;
      }
      return `No. ${value}`;
    default: return "";
  }
}

/* What the Opens picker offers: [{value, label}]. Links per input take a typed
   link instead (empty list). */
export function targetOptions(draft) {
  switch (draft.method) {
    case "keys": return KEY_TARGETS.map((k) => ({ value: k.value, label: k.label }));
    case "menu": return Array.from({ length: 12 }, (_, i) => ({ value: i + 1, label: `${ordinal(i + 1)} in the menu` }));
    case "link":
      if (draft.pattern === CUSTOM_LINKS) return [];
      return Array.from({ length: 13 }, (_, i) => ({ value: i, label: `No. ${i}` }));
    default: return [];
  }
}

export function statusLabel(row) {
  if (row.was && (row.value === "" || row.value === null || row.value === undefined)) return `Was the ${row.was} command · choose what it opens`;
  if (row.status === "works") return row.date ? `Works · ${shortDate(row.date)}` : "Works";
  if (row.status === "failed") return "Didn't work";
  return "Untested";
}

function shortDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(m[2]) - 1];
  return `${month} ${Number(m[3])}`;
}

export function today(now = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/* The line about where the setup came from, under the method choice. */
export function presetNote(draft, vendor) {
  const p = draft.preset;
  if (!p?.vendor) return "";
  return vendor && p.vendor ? `Suggested for ${p.vendor}` : "Suggested";
}

/* For the device page's status line: a TV still on the hub's built-in input
   guess, with nothing saved yet ("builtin" in /api/androidtv/status). */
export function tvInputsHint(tv) {
  return tv?.connected && tv.inputs === "builtin" ? "Inputs not checked yet: Settings → Inputs" : "";
}

/* -- requests ------------------------------------------------------------------------ */

/* Body for /api/androidtv/try: one row's target, unsaved. */
export function tryRequest(tvId, draft, value, { home = true } = {}) {
  const body = { device: tvId, method: draft.method, value: String(value), home: home ? "1" : "0" };
  if (draft.method === "link" && draft.pattern !== CUSTOM_LINKS) body.pattern = patternUri(draft);
  if (draft.method === "menu") body.gap = String(draft.gapMs);
  return body;
}

/* The device's inputs for the network TV writer: names, order, slot commands
   (empty: don't switch), and the delay. */
export function writerInputs(draft) {
  return {
    inputs: draft.method === "none" ? [] : draft.rows.map((r) => ({ name: String(r.name).trim(), command: slotCommand(r.slot) })),
    inputDelay: draft.delayMs,
  };
}

/* -- Share this setup ----------------------------------------------------------------- */

/* A presets-file entry for this TV, to paste into a GitHub issue. */
export function shareEntry(draft, vendor, model) {
  const entry = { vendor: String(vendor || ""), method: draft.method };
  const custom = draft.method === "link" && draft.pattern === CUSTOM_LINKS;
  if (draft.method === "link" && !custom) entry.patternUri = patternUri(draft);
  if (draft.method === "menu") entry.gapMs = draft.gapMs;
  entry.inputs = draft.method === "none" ? [] : draft.rows.map((r) => {
    const key = draft.method === "keys" ? "key" : draft.method === "menu" ? "position" : custom ? "link" : "n";
    return { name: String(r.name).trim(), [key]: r.value };
  });
  const works = draft.rows.filter((r) => r.status === "works").map((r) => String(r.name).trim());
  entry.checked = { model: String(model || ""), date: today(), inputs: works };
  return entry;
}

/* -- Find my inputs ---------------------------------------------------------------------- */

/* What the finder tries, in order. Empty for links per input. */
export function finderCandidates(draft) {
  switch (draft.method) {
    case "keys": return KEY_TARGETS.map((k) => k.value);
    case "menu": return Array.from({ length: 8 }, (_, i) => i + 1);
    case "link": return draft.pattern === CUSTOM_LINKS ? [] : Array.from({ length: 10 }, (_, i) => i + 1);
    default: return [];
  }
}

export const FINDER_GIVE_UP = 3;

/* A new finder run. */
export function finderStart(draft) {
  return { candidates: finderCandidates(draft), index: 0, nothingInARow: 0, found: [], added: [], done: false };
}

/**
 * One answer to "What's on screen now?" for the current candidate:
 * {kind:"input", name} one of the list's inputs; {kind:"new", name} a new
 * input; {kind:"empty"} an input with no picture; {kind:"nothing"} nothing
 * changed. Returns the next state (done when every row is found, the
 * candidates run out, or FINDER_GIVE_UP "nothing" answers in a row).
 */
export function finderAnswer(state, draft, answer) {
  const value = state.candidates[state.index];
  const next = { ...state, found: [...state.found], added: [...state.added], index: state.index + 1 };
  if (answer.kind === "nothing") next.nothingInARow += 1;
  else next.nothingInARow = 0;
  // A typed name that is already an input counts as that input.
  const typed = answer.kind === "new" ? String(answer.name ?? "").trim() : "";
  const existing = typed ? draft.rows.find((r) => String(r.name).trim().toLowerCase() === typed.toLowerCase()) : null;
  if (answer.kind === "input" || existing) next.found.push({ name: existing ? existing.name : answer.name, value });
  else if (typed) next.added.push({ name: typed, value });
  const named = new Set([...next.found, ...next.added].map((f) => f.name.trim().toLowerCase()));
  const allFound = draft.rows.length > 0 && draft.rows.every((r) => named.has(String(r.name).trim().toLowerCase()));
  next.done = allFound || next.index >= next.candidates.length || next.nothingInARow >= FINDER_GIVE_UP;
  return next;
}

/* Put what the finder found into the draft's rows (new inputs become rows).
   The answers are the truth for what they tried: another row that claimed a
   target the finder gave to a different input loses it. */
export function finderApply(draft, state, date = today()) {
  const key = (name) => String(name).trim().toLowerCase();
  const assigned = [...state.found, ...state.added];
  const names = new Set(assigned.map((f) => key(f.name)));
  const values = new Set(assigned.map((f) => String(f.value)));
  for (const row of draft.rows) {
    if (!names.has(key(row.name)) && values.has(String(row.value))) {
      Object.assign(row, { value: "", status: "untested", date: "" });
    }
  }
  for (const f of state.found) {
    const row = draft.rows.find((r) => key(r.name) === key(f.name));
    if (row) Object.assign(row, { value: f.value, status: "works", date });
  }
  for (const f of state.added) {
    if (draft.rows.some((r) => key(r.name) === key(f.name))) continue;
    const row = addRow(draft, f.name);
    if (row) Object.assign(row, { value: f.value, status: "works", date });
  }
}
