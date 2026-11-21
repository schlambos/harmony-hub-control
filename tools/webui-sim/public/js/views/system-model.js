/* System page model: pure state shaping for the #system view. No DOM, no
   network — every export is unit-testable under node:test.

   Two rules from the binding review (R2) and the hub source are encoded here
   as data so the view cannot drift from them:
   - the cloud blocker is ONE-WAY. Enabled = LAN-only and safe (no action
     offered). Disabled = the only affordance is re-enabling the block. A
     disable control never exists and the combined cloud-plus-reboot action
     is never produced.
   - sign-in mirrors safe_auth_field() (codex_webui.c:354): username required
     and colon-free; a password may not carry control characters and is
     required the first time sign-in is enabled. Blank password keeps the
     stored password when auth is already on (codex_webui.c:6006-6007). The
     password value itself is never returned, formatted, or described by
     anything in this module. */

import { TZ_POSIX, TZ_ALIASES } from "../tz-posix.js";

/** R2 as data. blockerOn=true → live/safe, nothing to do. blockerOn=false →
    warn, and the single offered action is to turn the block back on. */
export function cloudPanelState(blockerOn) {
  return blockerOn ? { live: true, action: null } : { live: false, action: "enable" };
}

/* Mirrors the byte walk in safe_auth_field(): reject NUL..US and DEL. */
function hasControlChar(value) {
  for (const ch of String(value)) {
    const code = ch.codePointAt(0);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

/** Mirror of safe_auth_field(username, 0) + the hub's own rejection copy
    (codex_webui.c:6001). Returns an error string or null. */
export function usernameError(username) {
  const s = String(username ?? "");
  if (!s) return "Username is required.";
  if (s.includes(":")) return "Username cannot contain a colon.";
  if (hasControlChar(s)) return "Username cannot contain control characters.";
  return null;
}

/** Mirror of safe_auth_field(password, 1) (codex_webui.c:6009). Blank is
    allowed — the hub keeps the stored password when none is supplied — so
    only control characters are rejected here. */
export function passwordError(password) {
  return hasControlChar(password ?? "") ? "Password cannot contain control characters." : null;
}

/** True when the hub HTML probe reports sign-in already required. */
export function authIsEnabled(authMode) {
  return /sign-in required/i.test(String(authMode ?? ""));
}

/**
 * Full client preflight for POST /system action=auth.
 * Enabling: username + (password required unless already enabled with blank
 * keep-current) + passwordConfirm must match when a new password is set.
 * Disabling: only password control-char check (password is not sent).
 */
export function authFormError({
  enabling,
  username,
  password,
  passwordConfirm,
  authAlreadyEnabled = false,
}) {
  if (enabling) {
    const userError = usernameError(username);
    if (userError) return userError;
    const pass = String(password ?? "");
    const confirm = String(passwordConfirm ?? "");
    if (!pass) {
      if (!authAlreadyEnabled) {
        return "Enter a password before enabling web UI sign-in.";
      }
      if (confirm) {
        return "Leave confirm blank when keeping the current password, or enter the new password in both fields.";
      }
      return null;
    }
    const pe = passwordError(pass);
    if (pe) return pe;
    if (pass !== confirm) return "Password and confirmation do not match.";
    return null;
  }
  return passwordError(password);
}

/** Standing pre-flight warning shown above the enable control. */
export const AUTH_ENABLE_WARNING =
  "Enabling sign-in makes every request return 401 until the browser supplies credentials. " +
  "Browsers often cache Basic credentials after the first prompt. " +
  "Recovery is SSH-only: edit or delete /data/codex/webui_auth.conf on the hub, then restart codex_webui.";

/** Two-step confirm consequence; names the username only — never the password. */
export function authEnableConsequence(username) {
  const who = String(username ?? "").trim() || "this user";
  return (
    `Enabling sign-in as "${who}". After this, every request — including this page — returns 401 until ` +
    "the browser supplies these credentials. Browsers may cache Basic credentials. Recovery if something " +
    "goes wrong is SSH-only: delete or edit /data/codex/webui_auth.conf on the hub."
  );
}

/** Build Authorization: Basic … for an explicit probe (never store the result). */
export function basicAuthorizationHeader(username, password) {
  const raw = `${String(username ?? "")}:${String(password ?? "")}`;
  let b64;
  if (typeof globalThis.btoa === "function") {
    /* Basic auth is latin1; control chars are already rejected by passwordError. */
    b64 = globalThis.btoa(raw);
  } else if (typeof Buffer !== "undefined") {
    b64 = Buffer.from(raw, "binary").toString("base64");
  } else {
    throw new Error("No base64 encoder available for Basic auth probe.");
  }
  return `Basic ${b64}`;
}

/** Whether a successful enable should run the credential probe.
    Blank-password keep-current cannot be probed — the shell never held the old secret. */
export function shouldProbeAuthCredentials(password) {
  return String(password ?? "").length > 0;
}

export function authProbeSuccessMessage(username) {
  const who = String(username ?? "").trim() || "the configured user";
  return (
    `Web UI sign-in is active and verified for "${who}". ` +
    "Every request now requires these credentials."
  );
}

export function authProbeFailureMessage() {
  return (
    "Sign-in was saved on the hub, but the verification probe failed — the credentials you entered " +
    "did not authenticate. The hub may now reject every unauthenticated request. " +
    "Recovery is SSH-only: ssh into the hub and delete or edit /data/codex/webui_auth.conf " +
    "(set enabled=0 or remove the file), then restart codex_webui. " +
    "If this page can still reach the hub, use Disable sign-in below (it will send the credentials " +
    "you just entered so the disable request can pass the auth gate)."
  );
}

export function authDisabledMessage() {
  return "Web UI sign-in disabled. The UI is open again on the local network.";
}

/** Format a byte count from /api/update-status without locale surprises. */
export function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

/** One line for the System page from GET /api/version. Hubs before 1.3.0
    have no such route and answer 404. */
export function hubVersionSummary(version, error) {
  if (version && typeof version.version === "string" && version.version) {
    return `Melodious ${version.version} on this hub.`;
  }
  if (error && error.status === 404) {
    return "Melodious 1.2 or older on this hub (it does not report its version).";
  }
  if (error) return `Could not read the hub's version: ${error.message}`;
  return "";
}

/**
 * Remedy when /api/update-status reports files missing under /data/codex/bin.
 * That path is what render_update_status_json / update_dest_path check; the
 * installers upload every payload/bin/MANIFEST.txt entry there.
 */
export function missingBinariesRemedy(files) {
  const list = Array.isArray(files) ? files : [];
  const missing = list.filter((f) => f && f.present === false).map((f) => f.name).filter(Boolean);
  if (!missing.length) return "";
  const names = missing.length <= 4
    ? missing.join(", ")
    : `${missing.slice(0, 3).join(", ")} and ${missing.length - 3} more`;
  return (
    `${names} ${missing.length === 1 ? "is" : "are"} not on the hub under /data/codex/bin. ` +
    "Re-run the host installer (install_webui.py / install_webui.ps1) so every MANIFEST.txt binary is uploaded."
  );
}

/* ---- time zone ---------------------------------------------------------
   The hub has no zoneinfo, so the page sends the chosen zone's POSIX rule
   with its name (action=timezone). codex_webui stores both in
   /data/codex/timezone.conf; netservicestarter.lua turns the rule into the
   offsets the stock activity engine uses for schedules and sunrise/sunset. */

/** Canonical zone for a name, following legacy aliases; null if unknown. */
export function canonicalTimeZone(zone, table = TZ_POSIX, aliases = TZ_ALIASES) {
  if (typeof zone !== "string" || !zone) return null;
  if (Object.prototype.hasOwnProperty.call(table, zone)) return zone;
  const target = aliases[zone];
  return target && Object.prototype.hasOwnProperty.call(table, target) ? target : null;
}

/** The browser's own zone, canonicalised; null when unknown or unsupported. */
export function browserTimeZone(intl = globalThis.Intl, table = TZ_POSIX, aliases = TZ_ALIASES) {
  let zone = null;
  try {
    zone = intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return null;
  }
  return canonicalTimeZone(zone, table, aliases);
}

/** Parse GET /export/timezone ("zone\nrule\n"); null when unset. */
export function parseTimezoneConf(text) {
  const [zone = "", posix = ""] = String(text ?? "").replace(/\r/g, "").split("\n").map((s) => s.trim());
  return zone && posix ? { zone, posix } : null;
}

/** Zone to preselect: the saved one, else this browser's, else UTC. */
export function preferredTimeZone(saved, browserZone, table = TZ_POSIX, aliases = TZ_ALIASES) {
  return canonicalTimeZone(saved?.zone, table, aliases) || browserZone || "UTC";
}

/** Form fields for POST /system; null when the zone is not in the table. */
export function timezoneFormFields(zone, table = TZ_POSIX) {
  if (!Object.prototype.hasOwnProperty.call(table, zone)) return null;
  return { action: "timezone", timezone: zone, tzPosix: table[zone] };
}

/** One-line description of the saved setting. */
export function timezoneSummary(saved) {
  return saved
    ? `Hub time zone: ${saved.zone}`
    : "No time zone set: schedules and sunrise/sunset triggers cannot run until one is saved.";
}

/* ---- custom NTP server --------------------------------------------------------
   codex_webui stores the list (action=ntp) in /data/codex/ntp_servers.conf,
   one per line; netservicestarter.lua asks only those servers when the list
   has any, and the public ones otherwise. Same rules on both sides. */

export const NTP_SERVERS_MAX = 3;
const NTP_HOST = /^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/;

/** Split a typed or stored list (commas, spaces or new lines between). */
export function splitNtpServers(text) {
  return String(text ?? "")
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Parse GET /export/ntp; [] when unset (the public servers). */
export function parseNtpConf(text) {
  return splitNtpServers(text).filter((host) => NTP_HOST.test(host)).slice(0, NTP_SERVERS_MAX);
}

/** Why the typed list can't be saved, or null when it can (empty clears). */
export function ntpServersError(text) {
  const hosts = splitNtpServers(text);
  if (hosts.length > NTP_SERVERS_MAX) return `Use at most ${NTP_SERVERS_MAX} NTP servers.`;
  const bad = hosts.find((host) => !NTP_HOST.test(host));
  return bad ? `"${bad}" is not a host name or IPv4 address.` : null;
}

/** Form fields for POST /system; null when the list isn't valid. */
export function ntpFormFields(text) {
  if (ntpServersError(text)) return null;
  return { action: "ntp", ntpServers: splitNtpServers(text).join(",") };
}

/** One-line description of the saved setting. */
export function ntpSummary(servers) {
  return servers && servers.length
    ? `Custom NTP server in use: ${servers.join(", ")}. The default public servers are not asked.`
    : "No custom NTP server set: the hub sets its clock from the default public servers (pool.ntp.org, Google, Cloudflare).";
}
