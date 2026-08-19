import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  cloudPanelState,
  usernameError,
  passwordError,
  authFormError,
  authIsEnabled,
  authEnableConsequence,
  AUTH_ENABLE_WARNING,
  basicAuthorizationHeader,
  shouldProbeAuthCredentials,
  authProbeSuccessMessage,
  authProbeFailureMessage,
  authDisabledMessage,
  formatBytes,
  formatCheckedAt,
  updateCheckSummary,
} from "../public/js/views/system-model.js";

describe("cloudPanelState", () => {
  it("reports live/safe with no action when the blocker is on", () => {
    assert.deepEqual(cloudPanelState(true), { live: true, action: null });
  });

  it("reports not-live with a single enable action when the blocker is off", () => {
    assert.deepEqual(cloudPanelState(false), { live: false, action: "enable" });
  });
});

describe("usernameError", () => {
  it("accepts a normal username", () => {
    assert.equal(usernameError("admin"), null);
    assert.equal(usernameError("owner-1"), null);
  });

  it("rejects empty", () => {
    assert.equal(usernameError(""), "Username is required.");
    assert.equal(usernameError(null), "Username is required.");
    assert.equal(usernameError(undefined), "Username is required.");
  });

  it("rejects a colon", () => {
    assert.equal(usernameError("a:b"), "Username cannot contain a colon.");
  });

  it("rejects control characters", () => {
    assert.equal(usernameError("a\u0001b"), "Username cannot contain control characters.");
    assert.equal(usernameError("a\u007fb"), "Username cannot contain control characters.");
  });
});

describe("passwordError", () => {
  it("accepts any non-control-character string including empty", () => {
    assert.equal(passwordError(""), null);
    assert.equal(passwordError("secret"), null);
    assert.equal(passwordError("a:b"), null); // colon allowed in passwords
  });

  it("rejects control characters", () => {
    assert.equal(passwordError("a\u0001b"), "Password cannot contain control characters.");
    assert.equal(passwordError("a\u007fb"), "Password cannot contain control characters.");
    assert.equal(passwordError("\t"), "Password cannot contain control characters.");
  });
});

describe("authFormError", () => {
  it("requires username and password when enabling the first time", () => {
    assert.equal(authFormError({ enabling: true, username: "", password: "" }), "Username is required.");
    assert.equal(
      authFormError({ enabling: true, username: "admin", password: "", passwordConfirm: "" }),
      "Enter a password before enabling web UI sign-in.",
    );
    assert.equal(
      authFormError({
        enabling: true,
        username: "admin",
        password: "secret",
        passwordConfirm: "secret",
      }),
      null,
    );
  });

  it("rejects password / confirm mismatch", () => {
    assert.equal(
      authFormError({
        enabling: true,
        username: "admin",
        password: "secret",
        passwordConfirm: "secrat",
      }),
      "Password and confirmation do not match.",
    );
    assert.equal(
      authFormError({
        enabling: true,
        username: "admin",
        password: "secret",
        passwordConfirm: "",
      }),
      "Password and confirmation do not match.",
    );
  });

  it("allows blank password keep-current when auth is already enabled", () => {
    assert.equal(
      authFormError({
        enabling: true,
        username: "admin",
        password: "",
        passwordConfirm: "",
        authAlreadyEnabled: true,
      }),
      null,
    );
    assert.equal(
      authFormError({
        enabling: true,
        username: "admin",
        password: "",
        passwordConfirm: "nope",
        authAlreadyEnabled: true,
      }),
      "Leave confirm blank when keeping the current password, or enter the new password in both fields.",
    );
  });

  it("only checks password control chars when disabling", () => {
    assert.equal(authFormError({ enabling: false, username: "", password: "" }), null);
    assert.equal(authFormError({ enabling: false, username: "anything", password: "a\u0001" }), "Password cannot contain control characters.");
  });

  it("surfaces username errors before password errors when enabling", () => {
    assert.equal(
      authFormError({ enabling: true, username: "a:b", password: "a\u0001", passwordConfirm: "a\u0001" }),
      "Username cannot contain a colon.",
    );
  });
});

describe("authIsEnabled", () => {
  it("detects hub probe modes", () => {
    assert.equal(authIsEnabled("sign-in required"), true);
    assert.equal(authIsEnabled("open on local network"), false);
    assert.equal(authIsEnabled(""), false);
    assert.equal(authIsEnabled(null), false);
  });
});

describe("basicAuthorizationHeader / probe helpers", () => {
  it("builds a Basic Authorization header without storing secrets", () => {
    const header = basicAuthorizationHeader("admin", "s3cret");
    assert.match(header, /^Basic /);
    const b64 = header.slice("Basic ".length);
    const decoded = Buffer.from(b64, "base64").toString("binary");
    assert.equal(decoded, "admin:s3cret");
  });

  it("probes only when a new password was supplied", () => {
    assert.equal(shouldProbeAuthCredentials("secret"), true);
    assert.equal(shouldProbeAuthCredentials(""), false);
    assert.equal(shouldProbeAuthCredentials(null), false);
  });

  it("probe-success copy names the user and confirms verification", () => {
    const msg = authProbeSuccessMessage("owner");
    assert.ok(msg.includes("verified"));
    assert.ok(msg.includes("owner"));
    assert.ok(!/s3cret|password=/i.test(msg));
  });

  it("probe-failure copy surfaces SSH recovery path and disable offer", () => {
    const msg = authProbeFailureMessage();
    assert.ok(msg.includes("/data/codex/webui_auth.conf"));
    assert.ok(/ssh/i.test(msg));
    assert.ok(/Disable sign-in/i.test(msg));
    assert.ok(msg.includes("verification probe failed"));
  });

  it("standing warning mentions 401, browser cache, and SSH recovery", () => {
    assert.ok(/401/.test(AUTH_ENABLE_WARNING));
    assert.ok(/cache/i.test(AUTH_ENABLE_WARNING));
    assert.ok(/webui_auth\.conf/.test(AUTH_ENABLE_WARNING));
    assert.ok(/SSH/i.test(AUTH_ENABLE_WARNING));
  });

  it("enable consequence names username only", () => {
    const text = authEnableConsequence("admin");
    assert.ok(text.includes('"admin"'));
    assert.ok(!/password/i.test(text) || /credentials/i.test(text));
    assert.ok(text.includes("webui_auth.conf"));
  });

  it("disabled message is plain", () => {
    assert.ok(authDisabledMessage().includes("disabled"));
  });
});

describe("formatBytes", () => {
  it("formats human sizes", () => {
    assert.equal(formatBytes(0), "—");
    assert.equal(formatBytes(-1), "—");
    assert.equal(formatBytes(NaN), "—");
    assert.equal(formatBytes(512), "512 B");
    assert.equal(formatBytes(1023), "1023 B");
    assert.equal(formatBytes(1024), "1.0 KB");
    assert.equal(formatBytes(1536), "1.5 KB");
    assert.equal(formatBytes(1048576), "1.00 MB");
  });
});

describe("formatCheckedAt", () => {
  it("returns never for missing or invalid epochs", () => {
    assert.equal(formatCheckedAt(0), "never");
    assert.equal(formatCheckedAt(-1), "never");
    assert.equal(formatCheckedAt(NaN), "never");
    assert.equal(formatCheckedAt(undefined), "never");
    assert.equal(formatCheckedAt(null), "never");
  });

  it("formats a valid epoch as a locale string", () => {
    const result = formatCheckedAt(1700000000);
    // The exact format depends on the locale, but it must not be "never".
    assert.notEqual(result, "never");
    assert.ok(result.length > 0);
  });
});

describe("updateCheckSummary", () => {
  it("returns empty for no state", () => {
    assert.equal(updateCheckSummary(null), "");
    assert.equal(updateCheckSummary(undefined), "");
  });

  it("reports when no check has been recorded", () => {
    assert.equal(
      updateCheckSummary({ checkedAt: 0 }),
      "No update check has been recorded on this hub yet.",
    );
    assert.equal(
      updateCheckSummary({}),
      "No update check has been recorded on this hub yet.",
    );
  });

  it("summarizes an available update with file count", () => {
    const s = updateCheckSummary({ checkedAt: 1700000000, available: true, changes: 3 });
    assert.ok(s.includes("Update available"));
    assert.ok(s.includes("3 files"));
  });

  it("uses singular '1 file' for a single change", () => {
    const s = updateCheckSummary({ checkedAt: 1700000000, available: true, changes: 1 });
    assert.ok(s.includes("1 file"));
    assert.ok(!s.includes("1 files"));
  });

  it("summarizes no available update", () => {
    const s = updateCheckSummary({ checkedAt: 1700000000, available: false, changes: 0 });
    assert.ok(s.includes("No update available"));
  });

  it("includes the source when present", () => {
    const s = updateCheckSummary({ checkedAt: 1700000000, available: false, source: "manual" });
    assert.ok(s.includes("via manual"));
  });
});