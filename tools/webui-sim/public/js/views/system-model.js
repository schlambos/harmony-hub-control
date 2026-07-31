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
     required the first time sign-in is enabled. The password value itself is
     never returned, formatted, or described by anything in this module. */

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

/** Full client preflight for POST /system action=auth, mirroring the hub's
    order of checks (codex_webui.c:6001-6012). Enabling requires a password;
    disabling does not (the stored credentials are kept). Returns an error
    string or null when the form is safe to send. */
export function authFormError({ enabling, username, password }) {
  if (enabling) {
    const userError = usernameError(username);
    if (userError) return userError;
    if (!String(password ?? "")) return "Enter a password before enabling web UI sign-in.";
    return passwordError(password);
  }
  return passwordError(password);
}

/** Format a byte count from /api/update-status without locale surprises. */
export function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

/** Human label for the saved update-check epoch (seconds). */
export function formatCheckedAt(epochSeconds) {
  const n = Number(epochSeconds);
  if (!Number.isFinite(n) || n <= 0) return "never";
  const d = new Date(n * 1000);
  return Number.isNaN(d.getTime()) ? "never" : d.toLocaleString();
}

/** One-line summary of the saved /api/update-check-state payload. The check
    itself is outbound network work this page never performs — this only
    describes what was last recorded on the hub. */
export function updateCheckSummary(checkState) {
  if (!checkState) return "";
  if (!checkState.checkedAt) return "No update check has been recorded on this hub yet.";
  const when = formatCheckedAt(checkState.checkedAt);
  const via = checkState.source ? ` via ${checkState.source}` : "";
  if (checkState.available) {
    const files = checkState.changes === 1 ? "1 file" : `${checkState.changes ?? 0} files`;
    return `Update available (${files}) — last checked ${when}${via}.`;
  }
  return `No update available — last checked ${when}${via}.`;
}
