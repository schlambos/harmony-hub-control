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
      // Published as a Harmony device (POST /api/bt-harmony-device).
      harmony: d?.harmony === true,
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

/**
 * Remedy when the FIFO text helper is not live.
 * Derived from codex_webui.c (bt-text-status / FIFO write) and init.sh:
 * exact typing needs codex_bthid_keyboard writing /tmp/bthid_status; init
 * starts it at boot when /data/codex/bin/codex_bthid_keyboard is present.
 */
export function textHelperRemedy(status) {
  const s = status && typeof status === "object" ? status : {};
  if (s.live) return "";
  const state = String(s.state ?? "");
  const err = String(s.error ?? "");
  if (/stale/i.test(state) || /stale|restart bthid/i.test(err)) {
    return (
      "The typing helper left a stale status file. Reboot the hub so init.sh " +
      "restarts codex_bthid_keyboard (or reinstall if that binary is missing under /data/codex/bin)."
    );
  }
  if (/no_target|waiting for a paired target/i.test(state) || /no live Bluetooth HID|paired target/i.test(err)) {
    return (
      "The helper is up but has no authenticated HID target. Connect the paired device " +
      "(Check link above), then try again."
    );
  }
  return (
    "Exact typing needs the codex_bthid_keyboard runtime on the hub. " +
    "Reboot so init.sh starts it, or re-run the host installer if /data/codex/bin/codex_bthid_keyboard is missing."
  );
}

/* -- On-screen keys ------------------------------------------------------ */

/** Explicit, user-triggered key buttons. Every code is accepted by the hub's
    bt_key_usage()/modifier parser (codex_webui.c), so each button maps to a
    valid HID report. Combo codes are the normalized forms the hub matches.

    The ac* keys are HID Consumer page (0x0C) usages.  They travel in report
    ID 3, which the stock btkeyboard descriptor already declares, so they need
    no re-pairing.  achome/acback are the two the Chromecast with Google TV
    remote sends; acvoice/acpanel are the verified Chromecast alternatives for
    search and settings.  The keyboard-page home/menu/escape keys stay for
    ordinary text entry and existing saved scripts. */
export const QUICK_KEYS = [
  { code: "directionup", label: "Up" },
  { code: "directiondown", label: "Down" },
  { code: "directionleft", label: "Left" },
  { code: "directionright", label: "Right" },
  { code: "enter", label: "Enter" },
  { code: "escape", label: "Back" },
  { code: "menu", label: "Menu" },
  { code: "home", label: "Home" },
  { code: "achome", label: "Home (TV)" },
  { code: "acback", label: "Back (TV)" },
  { code: "acmenu", label: "Menu (TV)" },
  { code: "acsearch", label: "Search (TV)" },
  { code: "acguide", label: "Guide (TV)" },
  { code: "acinfo", label: "Info (TV)" },
  { code: "acsettings", label: "Settings (TV)" },
  { code: "acexit", label: "Exit (TV)" },
  { code: "acvoice", label: "Voice (TV)" },
  { code: "acpanel", label: "Quick settings (TV)" },
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

/** OK and the media keys: more Consumer page (0x0C) usages the hub sends in
    report 3 (bt_consumer_usage() in codex_webui.c), next to the ac* keys
    above. Android maps them through Generic.kl, so they work on a box
    without its own key layout. Standard keyboard profile. */
export const TV_KEYS = [
  { code: "select", label: "OK" },
  { code: "playpause", label: "Play/Pause" },
  { code: "stop", label: "Stop" },
  { code: "rewind", label: "Rewind" },
  { code: "fastforward", label: "Fast forward" },
  { code: "previoustrack", label: "Previous" },
  { code: "nexttrack", label: "Next" },
  { code: "channelup", label: "Channel +" },
  { code: "channeldown", label: "Channel -" },
  { code: "mute", label: "Mute" },
  { code: "volumedown", label: "Volume -" },
  { code: "volumeup", label: "Volume +" },
  { code: "tvsleep", label: "Sleep" },
  { code: "tvpower", label: "Power" },
];

/** A Harmony device the hub made from a saved Bluetooth target (codexactivity
    CommitBtDevices): tagged "melodious-bt-", its {d} token is the saved
    device's id. */
export const HUB_BT_TAG = "melodious-bt-";

export function isHubBtEntry(entry) {
  return String(entry?.Device?.AutoDetectedDevice?.Id ?? "").startsWith(HUB_BT_TAG);
}

/** The saved Bluetooth device id ({d} token) behind a hub Bluetooth device. */
export function hubBtIdOf(entryOrDevice) {
  const entry = entryOrDevice?.entry ?? entryOrDevice;
  const params = entry?.Device?.Tokens?.Parameters;
  const token = Array.isArray(params) ? params.find((p) => p?.Key === "{d}") : null;
  return token ? String(token.Value ?? "") : "";
}

/** Only the Standard keyboard (Android TV / SHIELD) profile can become a
    Harmony device: its commands are the TV keys above plus saved scripts. */
export function canBeHarmonyDevice(device) {
  return String(device?.type ?? "") === "btkeyboard";
}

/** Fixed Harmony commands for a published Standard-keyboard Bluetooth target
    (must stay in sync with BT_HARMONY_COMMANDS in payload/source/codex_webui.c). */
export const BT_HARMONY_FIXED_NAMES = [
  "PowerOn", "PowerOff", "PowerToggle",
  "DirectionUp", "DirectionDown", "DirectionLeft", "DirectionRight",
  "Select", "Back", "Home", "Menu",
  "PlayPause", "Play", "Pause",
  "Stop", "NextTrack", "PreviousTrack",
  "FastForward", "Rewind",
  "ChannelUp", "ChannelDown",
  "Mute", "VolumeUp", "VolumeDown",
  "0", "1", "2", "3", "4", "5", "6", "7", "8", "9",
];

const BT_HARMONY_MAX_COMMANDS = 128;

const LATIN1_TABLE = [
  "A", "A", "A", "A", "A", "A", "AE", "C",
  "E", "E", "E", "E", "I", "I", "I", "I",
  "D", "N", "O", "O", "O", "O", "O", " ",
  "O", "U", "U", "U", "U", "Y", "TH", "ss",
  "a", "a", "a", "a", "a", "a", "ae", "c",
  "e", "e", "e", "e", "i", "i", "i", "i",
  "d", "n", "o", "o", "o", "o", "o", " ",
  "o", "u", "u", "u", "u", "y", "th", "y",
];

const LATIN_EXT_A_TABLE = [
  "A", "a", "A", "a", "A", "a", "C", "c",
  "C", "c", "C", "c", "C", "c", "D", "d",
  "D", "d", "E", "e", "E", "e", "E", "e",
  "E", "e", "E", "e", "G", "g", "G", "g",
  "G", "g", "G", "g", "H", "h", "H", "h",
  "I", "i", "I", "i", "I", "i", "I", "i",
  "I", "i", "IJ", "ij", "J", "j", "K", "k",
  "k", "L", "l", "L", "l", "L", "l", "L",
  "l", "L", "l", "N", "n", "N", "n", "N",
  "n", "n", "N", "n", "O", "o", "O", "o",
  "O", "o", "OE", "oe", "R", "r", "R", "r",
  "R", "r", "S", "s", "S", "s", "S", "s",
  "S", "s", "T", "t", "T", "t", "T", "t",
  "U", "u", "U", "u", "U", "u", "U", "u",
  "U", "u", "U", "u", "W", "w", "Y", "y",
  "Y", "Z", "z", "Z", "z", "Z", "z", "s",
];

/** Transliterate UTF-8 Latin letters to ASCII, mirroring bt_transliterate_utf8()
    in payload/source/codex_webui.c. */
export function transliterateLatin(value) {
  const s = String(value ?? "");
  let out = "";
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (cp < 0x80) out += ch;
    else if (cp === 0x00a0) out += " ";
    else if (cp >= 0x00c0 && cp <= 0x00ff) out += LATIN1_TABLE[cp - 0x00c0];
    else if (cp >= 0x0100 && cp <= 0x017f) out += LATIN_EXT_A_TABLE[cp - 0x0100];
    else if (cp >= 0x0300 && cp <= 0x036f) out += "";
    else if (cp >= 0x2010 && cp <= 0x2015) out += "-";
    else out += " ";
  }
  return out;
}

/** Alphanumeric {c} token for a saved Bluetooth script command, mirroring
    bt_harmony_encode_saved_value() in payload/source/codex_webui.c. */
export function btHarmonyCommandValue(rawName) {
  const bytes = new TextEncoder().encode(String(rawName ?? ""));
  if (bytes.length === 0) return "";
  if (bytes.length <= 45) {
    let hex = "saved";
    for (const b of bytes) hex += b.toString(16).padStart(2, "0");
    return hex;
  }
  let h = 0xcbf29ce484222325n;
  for (const b of bytes) {
    h ^= BigInt(b);
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return `savedh${h.toString(16).padStart(16, "0")}${(bytes.length & 0xffff).toString(16).padStart(4, "0")}`;
}

function withHarmonySuffix(base, suffix) {
  const maxBase = Math.max(0, 48 - suffix.length);
  return base.slice(0, maxBase).replace(/ +$/, "") + suffix;
}

/** Predict and reconcile how each saved keyboard script on a published
    Bluetooth target maps onto its Harmony device commands.
    Mirrors bt_harmony_resolve_name() / bt_harmony_set_json() in codex_webui.c. */
export function planBtHarmonyCommands(device, harmonyEntry = null) {
  const fixedByLower = new Map(BT_HARMONY_FIXED_NAMES.map((n) => [n.toLowerCase(), n]));
  const used = new Set(fixedByLower.keys());
  const liveCommands = Array.isArray(harmonyEntry?.Commands) ? harmonyEntry.Commands : null;
  const liveByLower = liveCommands
    ? new Map(liveCommands.map((c) => [String(c?.Name ?? "").toLowerCase(), c]))
    : null;
  const plannedNamesLower = new Set();
  const items = [];
  const commands = Array.isArray(device?.commands) ? device.commands : [];

  for (const cmd of commands) {
    const rawName = String(cmd?.name ?? "");
    if (used.size >= BT_HARMONY_MAX_COMMANDS) {
      items.push({
        name: rawName,
        status: "unpublished",
        harmonyName: null,
        value: null,
        renamed: false,
        changeKind: "limit",
        reason: "Not published to Harmony: 128-command device limit reached.",
      });
      continue;
    }
    const trans = transliterateLatin(rawName);
    let clean = "";
    let lastSpace = false;
    for (const ch of trans) {
      if (/[A-Za-z0-9_.+\-]/.test(ch)) {
        clean += ch;
        lastSpace = false;
      } else if (!lastSpace) {
        clean += " ";
        lastSpace = true;
      }
    }
    clean = clean.replace(/^[^A-Za-z0-9]+/, "").replace(/ +$/, "");
    const truncated = clean.length > 48;
    const base = clean.slice(0, 48).replace(/ +$/, "");
    if (!base) {
      items.push({
        name: rawName,
        status: "unpublished",
        harmonyName: null,
        value: null,
        renamed: false,
        changeKind: "unpublishable",
        reason: "Not published to Harmony: name has no ASCII letters or digits Harmony accepts.",
      });
      continue;
    }
    let harmonyName = null;
    let clashedFixed = null;
    let clashedDuplicate = false;
    if (!used.has(base.toLowerCase())) {
      harmonyName = base;
    } else if (fixedByLower.has(base.toLowerCase())) {
      clashedFixed = fixedByLower.get(base.toLowerCase());
      const first = withHarmonySuffix(base, " Saved");
      if (first && !used.has(first.toLowerCase())) {
        harmonyName = first;
      } else {
        for (let n = 2; n <= 99; n++) {
          const cand = withHarmonySuffix(base, ` Saved ${n}`);
          if (cand && !used.has(cand.toLowerCase())) {
            harmonyName = cand;
            break;
          }
        }
      }
    } else {
      clashedDuplicate = true;
      for (let n = 2; n <= 99; n++) {
        const cand = withHarmonySuffix(base, ` ${n}`);
        if (cand && !used.has(cand.toLowerCase())) {
          harmonyName = cand;
          break;
        }
      }
    }
    if (!harmonyName) {
      items.push({
        name: rawName,
        status: "unpublished",
        harmonyName: null,
        value: null,
        renamed: false,
        changeKind: "unpublishable",
        reason: "Not published to Harmony: could not form a unique Harmony command name.",
      });
      continue;
    }
    used.add(harmonyName.toLowerCase());
    plannedNamesLower.add(harmonyName.toLowerCase());
    const value = btHarmonyCommandValue(rawName);
    const renamed = harmonyName !== rawName;
    let changeKind = "exact";
    let reason = `On Harmony as “${harmonyName}”.`;
    if (clashedFixed) {
      changeKind = "clashed";
      reason = `On Harmony as “${harmonyName}” (renamed to avoid built-in ${clashedFixed}).`;
    } else if (clashedDuplicate) {
      changeKind = "clashed";
      reason = `On Harmony as “${harmonyName}” (renamed to avoid a duplicate command name).`;
    } else if (truncated) {
      changeKind = "truncated";
      reason = `On Harmony as “${harmonyName}” (shortened to 48 characters).`;
    } else if (renamed) {
      changeKind = "sanitised";
      reason = `On Harmony as “${harmonyName}” (adjusted for Harmony naming rules).`;
    }
    const isPending = liveByLower !== null && !liveByLower.has(harmonyName.toLowerCase());
    items.push({
      name: rawName,
      status: isPending ? "pending" : "published",
      harmonyName,
      value,
      renamed,
      changeKind,
      reason: isPending
        ? `Not on the Harmony device yet — click Update Harmony device to publish as “${harmonyName}”.`
        : reason,
    });
  }

  const retainedCommands = [];
  if (liveCommands) {
    for (const c of liveCommands) {
      const cname = String(c?.Name ?? "");
      const params = Array.isArray(c?.Parameters) ? c.Parameters : [];
      const valParam = params.find((p) => p?.Key === "{c}");
      const val = String(valParam?.Value ?? "");
      if (val.startsWith("saved") && !plannedNamesLower.has(cname.toLowerCase())) {
        retainedCommands.push(cname);
      }
    }
  }

  return {
    items,
    published: items.filter((i) => i.status === "published"),
    pending: items.filter((i) => i.status === "pending"),
    unpublished: items.filter((i) => i.status === "unpublished"),
    retainedCommands,
  };
}
