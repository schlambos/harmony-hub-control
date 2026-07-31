/* Bluetooth view model: pure parsing and validation for the #bluetooth page.
   No DOM, no network — every export is unit-testable under node:test.

   Every validator mirrors a guard in payload/source/codex_webui.c so the page
   can reject doomed input client-side with the same rules the hub enforces:

     safe_bt_addr        -> isValidBtAddr      (17 chars, XX:XX:XX:XX:XX:XX, hex)
     safe_bt_pin         -> isValidBtPin       (<=16 digits, may be empty)
     safe_bt_name        -> isValidBtName      (1..48 of [A-Za-z0-9 ._ -])
     bt_type_allowed     -> isAllowedBtType    (fire|btkeyboard|btkeyboard-nexus|ps3|wii)
     safe_bt_store_id    -> isValidStoreId     (1..36 of [A-Za-z0-9_-])
     safe_label          -> isValidLabel       (non-empty, no ctl chars, no " or \)
     safe_bt_script_text -> isValidScript      (1..2047, printable + \n \r \t)
     timeout clamp 1..20 (default 2)  -> clampScanTimeout
     gapMs clamp 15..5000 (default 35) -> clampGapMs

   Response shaping is honest about the two backends this shell runs against:
   the real hub (codex_webui) answers /api/bt-call with `responseRaw`, while
   the sim stub answers with `reply`; both are surfaced, never papered over. */

/* -- Keyboard HID profiles (bt_type_allowed / bt_type_label) ------------- */

export const BT_TYPES = [
  { value: "btkeyboard", label: "Standard keyboard (Android TV / SHIELD)" },
  { value: "btkeyboard-nexus", label: "Nexus Player keyboard" },
  { value: "fire", label: "Fire TV / media keys" },
  { value: "ps3", label: "PlayStation 3" },
  { value: "wii", label: "Nintendo Wii" },
];

export function btTypeLabel(value) {
  return BT_TYPES.find((t) => t.value === value)?.label ?? value;
}

export function isAllowedBtType(value) {
  return BT_TYPES.some((t) => t.value === value);
}

/* -- Field validators (mirror the C guards) ------------------------------ */

const HEX = /^[0-9a-fA-F]$/;

/** Bluetooth MAC: exactly 17 chars, colons at positions 2,5,8,11,14, hex elsewhere. */
export function isValidBtAddr(value) {
  const s = typeof value === "string" ? value : "";
  if (s.length !== 17) return false;
  for (let i = 0; i < 17; i++) {
    const ch = s[i];
    if (i === 2 || i === 5 || i === 8 || i === 11 || i === 14) {
      if (ch !== ":") return false;
    } else if (!HEX.test(ch)) {
      return false;
    }
  }
  return true;
}

/** Trim and upper-case a MAC for display/submission (the hub compares case-insensitively). */
export function normalizeBtAddr(value) {
  return String(value ?? "").trim().toUpperCase();
}

/** Legacy pairing PIN: optional, at most 16 digits. */
export function isValidBtPin(value) {
  const s = String(value ?? "");
  return s.length <= 16 && /^\d*$/.test(s);
}

/** Adapter display name shown while pairing (safe_bt_name). */
export function isValidBtName(value) {
  const s = String(value ?? "");
  return s.length >= 1 && s.length <= 48 && /^[A-Za-z0-9 ._\-]+$/.test(s);
}

/** Inventory device id (safe_bt_store_id). Empty is allowed when creating a new device. */
export function isValidStoreId(value) {
  const s = String(value ?? "");
  return s.length >= 1 && s.length <= 36 && /^[A-Za-z0-9_\-]+$/.test(s);
}

/** Device / command display name (safe_label): non-empty, no control chars, no quote or backslash. */
export function isValidLabel(value) {
  const s = String(value ?? "");
  if (!s) return false;
  for (const ch of s) {
    const code = ch.codePointAt(0);
    if (code < 32 || code === 127) return false;
    if (ch === '"' || ch === "\\") return false;
  }
  return true;
}

/** Keyboard script body (safe_bt_script_text): 1..2047 chars, printable plus \n \r \t. */
export function isValidScript(value) {
  const s = String(value ?? "");
  if (s.length === 0 || s.length >= 2048) return false;
  for (const ch of s) {
    const code = ch.codePointAt(0);
    if (code === 127) return false;
    if (code < 32 && ch !== "\n" && ch !== "\r" && ch !== "\t") return false;
  }
  return true;
}

/* -- Numeric clamps (mirror the C defaults) ------------------------------ */

/** Scan/search seconds: hub clamps to 1..20, default 2. */
export function clampScanTimeout(value) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return 2;
  return Math.min(20, Math.max(1, n));
}

/** Inter-key gap ms: the hub resets below 15 to the default 35 and caps at 5000
    (`if (gap_ms < 15) gap_ms = 35; if (gap_ms > 5000) gap_ms = 5000;`). */
export function clampGapMs(value) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return 35;
  if (n < 15) return 35;
  if (n > 5000) return 5000;
  return n;
}

/* -- Response parsing ---------------------------------------------------- */

/** GET /export/bluetooth -> normalized saved device inventory.
    Tolerant of a missing/empty store (the hub seeds `{"version":1,"devices":[]}`). */
export function parseBtInventory(jsonText) {
  let cfg;
  try {
    cfg = JSON.parse(jsonText);
  } catch (_) {
    cfg = {};
  }
  if (!cfg || typeof cfg !== "object") cfg = {};
  const devices = Array.isArray(cfg.devices) ? cfg.devices : [];
  return devices
    .map((d) => ({
      id: String(d?.id ?? ""),
      name: String(d?.name ?? ""),
      type: String(d?.type ?? "btkeyboard"),
      bdaddr: String(d?.bdaddr ?? ""),
      commands: (Array.isArray(d?.commands) ? d.commands : [])
        .map((c) => ({
          name: String(c?.name ?? ""),
          delayMs: clampGapMs(c?.delayMs),
          script: String(c?.script ?? ""),
        }))
        .filter((c) => c.name && c.script),
    }))
    .filter((d) => d.id && d.name);
}

/** Normalize a successful POST /api/bt-call response. The real hub uses
    `responseRaw`; the sim stub uses `reply` — surface whichever exists and
    treat `connected` strictly (only a true value counts as a live link). */
export function normalizeBtCall(json) {
  const j = json && typeof json === "object" ? json : {};
  return {
    action: String(j.action ?? ""),
    cmd: String(j.cmd ?? ""),
    connected: j.connected === true,
    detectedAddress: String(j.detectedAddress ?? ""),
    nativeCode: Number.isFinite(j.nativeCode) ? j.nativeCode : null,
    error: String(j.error ?? ""),
    raw: String(j.responseRaw ?? j.reply ?? ""),
  };
}

/** Normalize GET /api/bt-text-status. The real hub passes through the FIFO
    runtime's status JSON (runtime/state/target/sent/skipped); the sim answers
    with a plain state. `live` is true only for a running runtime in the
    listening state — never assumed. */
export function parseTextStatus(json) {
  const j = json && typeof json === "object" ? json : {};
  const runtime = j.runtime === true;
  const state = String(j.state ?? "unknown");
  return {
    runtime,
    state,
    target: String(j.target ?? ""),
    sent: Number.isFinite(j.sent) ? j.sent : 0,
    skipped: Number.isFinite(j.skipped) ? j.skipped : 0,
    error: String(j.error ?? j.detail ?? ""),
    live: runtime && state === "listening",
  };
}

/* -- On-screen keys ------------------------------------------------------ */

/** Explicit, user-triggered key buttons. Every code is accepted by the hub's
    bt_key_usage()/modifier parser (codex_webui.c), so each button maps to a
    valid HID report. Combo codes are the normalized forms the hub matches. */
export const QUICK_KEYS = [
  { code: "directionup", label: "Up" },
  { code: "directiondown", label: "Down" },
  { code: "directionleft", label: "Left" },
  { code: "directionright", label: "Right" },
  { code: "enter", label: "Enter" },
  { code: "escape", label: "Back" },
  { code: "menu", label: "Menu" },
  { code: "home", label: "Home" },
  { code: "backspace", label: "Backspace" },
  { code: "space", label: "Space" },
  { code: "tab", label: "Tab" },
  { code: "delete", label: "Delete" },
  { code: "pageup", label: "Page Up" },
  { code: "pagedown", label: "Page Down" },
  { code: "insert", label: "Insert" },
  { code: "end", label: "End" },
  { code: "number1", label: "1" },
  { code: "number2", label: "2" },
  { code: "number3", label: "3" },
  { code: "number4", label: "4" },
  { code: "number5", label: "5" },
  { code: "number6", label: "6" },
  { code: "number7", label: "7" },
  { code: "number8", label: "8" },
  { code: "number9", label: "9" },
  { code: "number0", label: "0" },
  { code: "ctrll", label: "Ctrl+L" },
  { code: "alttab", label: "Alt+Tab" },
  { code: "altf4", label: "Alt+F4" },
  { code: "ctrlaltdelete", label: "Ctrl+Alt+Del" },
];
