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
  hubVersionSummary,
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

describe("hubVersionSummary", () => {
  it("names the version the hub reports", () => {
    assert.equal(hubVersionSummary({ ok: true, version: "1.3.0", api: 1 }, null), "Melodious 1.3.0 on this hub.");
  });

  it("explains a 404 as a hub from before /api/version", () => {
    const err = Object.assign(new Error("HTTP 404"), { status: 404 });
    assert.match(hubVersionSummary(null, err), /1\.2 or older/);
  });

  it("passes other errors through", () => {
    const err = Object.assign(new Error("HTTP 401"), { status: 401 });
    assert.equal(hubVersionSummary(null, err), "Could not read the hub's version: HTTP 401");
  });

  it("is empty before anything loaded", () => {
    assert.equal(hubVersionSummary(null, null), "");
  });
});
import {
  canonicalTimeZone,
  browserTimeZone,
  parseTimezoneConf,
  preferredTimeZone,
  timezoneFormFields,
  timezoneSummary,
} from "../public/js/views/system-model.js";
import { TZ_POSIX, TZ_ALIASES } from "../public/js/tz-posix.js";

describe("time zone table", () => {
  it("carries POSIX rules for well-known zones", () => {
    assert.equal(TZ_POSIX["America/New_York"], "EST5EDT,M3.2.0,M11.1.0");
    assert.equal(TZ_POSIX["Europe/London"], "GMT0BST,M3.5.0/1,M10.5.0");
    assert.equal(TZ_POSIX["Asia/Kolkata"], "IST-5:30");
    assert.equal(TZ_POSIX.UTC, "UTC0");
  });

  it("only holds names and rules the hub accepts (codex_webui safe_tz_value)", () => {
    for (const [zone, rule] of Object.entries(TZ_POSIX)) {
      assert.match(zone, /^[A-Za-z0-9_+\/-]{1,64}$/, zone);
      assert.match(rule, /^[A-Za-z0-9<>+,.:\/-]{1,80}$/, `${zone}: ${rule}`);
    }
  });

  it("maps every alias to a zone in the table", () => {
    for (const [alias, zone] of Object.entries(TZ_ALIASES)) {
      assert.ok(Object.hasOwn(TZ_POSIX, zone), `${alias} -> ${zone}`);
    }
  });
});

describe("canonicalTimeZone", () => {
  it("keeps canonical names and follows aliases", () => {
    assert.equal(canonicalTimeZone("America/New_York"), "America/New_York");
    assert.equal(canonicalTimeZone("Asia/Calcutta"), "Asia/Kolkata");
    assert.equal(canonicalTimeZone("US/Eastern"), "America/New_York");
  });

  it("rejects unknown or empty names", () => {
    assert.equal(canonicalTimeZone("Mars/Olympus_Mons"), null);
    assert.equal(canonicalTimeZone(""), null);
    assert.equal(canonicalTimeZone(undefined), null);
    assert.equal(canonicalTimeZone("toString"), null);
  });
});

describe("browserTimeZone", () => {
  const fakeIntl = (timeZone) => ({ DateTimeFormat: () => ({ resolvedOptions: () => ({ timeZone }) }) });

  it("returns the browser zone, canonicalised", () => {
    assert.equal(browserTimeZone(fakeIntl("Europe/Kiev")), "Europe/Kyiv");
    assert.equal(browserTimeZone(fakeIntl("America/Chicago")), "America/Chicago");
  });

  it("returns null when Intl is missing or the zone is unknown", () => {
    assert.equal(browserTimeZone(null), null);
    assert.equal(browserTimeZone({ DateTimeFormat: () => { throw new Error("no Intl"); } }), null);
    assert.equal(browserTimeZone(fakeIntl("Nowhere/Land")), null);
  });
});

describe("parseTimezoneConf", () => {
  it("reads zone and rule lines", () => {
    assert.deepEqual(parseTimezoneConf("America/New_York\nEST5EDT,M3.2.0,M11.1.0\n"), {
      zone: "America/New_York",
      posix: "EST5EDT,M3.2.0,M11.1.0",
    });
    assert.deepEqual(parseTimezoneConf("UTC\r\nUTC0\r\n"), { zone: "UTC", posix: "UTC0" });
  });

  it("treats an empty or partial file as unset", () => {
    assert.equal(parseTimezoneConf(""), null);
    assert.equal(parseTimezoneConf("America/New_York\n"), null);
    assert.equal(parseTimezoneConf(null), null);
  });
});

describe("preferredTimeZone", () => {
  it("prefers the saved zone, then the browser's, then UTC", () => {
    assert.equal(preferredTimeZone({ zone: "Europe/Paris", posix: "x" }, "America/Chicago"), "Europe/Paris");
    assert.equal(preferredTimeZone(null, "America/Chicago"), "America/Chicago");
    assert.equal(preferredTimeZone(null, null), "UTC");
    assert.equal(preferredTimeZone({ zone: "Gone/Zone", posix: "x" }, null), "UTC");
  });
});

describe("timezoneFormFields", () => {
  it("sends the zone with its rule from the table", () => {
    assert.deepEqual(timezoneFormFields("Australia/Sydney"), {
      action: "timezone",
      timezone: "Australia/Sydney",
      tzPosix: "AEST-10AEDT,M10.1.0,M4.1.0/3",
    });
  });

  it("refuses zones outside the table", () => {
    assert.equal(timezoneFormFields("Nowhere/Land"), null);
    assert.equal(timezoneFormFields("constructor"), null);
  });
});

describe("timezoneSummary", () => {
  it("names the saved zone or explains what is missing", () => {
    assert.equal(timezoneSummary({ zone: "UTC", posix: "UTC0" }), "Hub time zone: UTC");
    assert.match(timezoneSummary(null), /schedules and sunrise\/sunset/);
  });
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function extractCStringMacro(src, name) {
  const re = new RegExp(`#define\\s+${name}\\s*\\\\?\\n?((?:\\s*"(?:[^"\\\\]|\\\\.)*"\\s*\\\\?\\n?)+)`);
  const match = src.match(re);
  if (!match) return null;
  const parts = [];
  for (const m of match[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)) {
    parts.push(m[1].replace(/\\\\/g, "\\").replace(/\\"/g, '"'));
  }
  return parts.join("");
}

describe("system status syslog filter (#194)", () => {
  it("drops noisy connect.statedigest?get 304 poll lines while keeping real codex/mqtt logs", () => {
    const cSrc = fs.readFileSync(path.join(REPO_ROOT, "payload/source/codex_webui.c"), "utf8");
    const tailCmd = extractCStringMacro(cSrc, "SYSTEM_LOG_TAIL");
    assert.ok(tailCmd, "SYSTEM_LOG_TAIL macro exists");

    // Extract the syslog pipeline from render_system_status_json.
    const fnMatch = cSrc.match(/static void render_system_status_json[\s\S]*?^}/m);
    assert.ok(fnMatch, "render_system_status_json exists");
    const syslogMacro = extractCStringMacro(cSrc, "SYSTEM_SYSLOG_FILTER");
    let pipeline;
    if (syslogMacro) {
      assert.ok(fnMatch[0].includes("SYSTEM_SYSLOG_FILTER"), "render_system_status_json uses SYSTEM_SYSLOG_FILTER");
      pipeline = `${syslogMacro} | ${tailCmd}`;
    } else {
      const m = fnMatch[0].match(/"(logread[^"]+)"\s*SYSTEM_LOG_TAIL/);
      assert.ok(m, "found logread pipeline in render_system_status_json");
      pipeline = m[1].replace(/\\\\/g, "\\") + tailCmd;
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "melodious-194-"));
    try {
      const sampleLines = [
        "Nov 18 15:18:01.000 pimentoblue user.notice luaworks[247]: codexactivity: committed ActivityList",
        "Nov 18 15:18:05.000 pimentoblue user.notice luaworks[247]: codexmqtt: connected to broker 192.168.1.10",
        "Nov 18 15:18:10.000 pimentoblue user.notice luaworks[247]: cs.c.engine [2300]: processMessage(res): [ transport: websocket ] [ id: codex-1795015090-1-1 ] [ cmd: harmony.engine?startactivity ] [ errorCode: 200 ] [ errorString: OK ]",
      ];
      for (let i = 0; i < 12; i++) {
        sampleLines.push(
          `Nov 18 15:20:${String(10 + i).padStart(2, "0")}.360 pimentoblue user.notice luaworks[247]: cs.c.engine [${2300 + i}]: processMessage(req): [ transport: websocket ] [ id: codex-1795015244-272185-${i} ] [ cmd: connect.statedigest?get ]`,
          `Nov 18 15:20:${String(10 + i).padStart(2, "0")}.363 pimentoblue user.notice luaworks[247]: cs.c.engine [${2300 + i}]: processMessage(res): [ transport: websocket ] [ id: codex-1795015244-272185-${i} ] [ cmd: connect.statedigest?get ] [ errorCode: 304 ] [ errorString: OK ]`,
          `Nov 18 15:20:${String(10 + i).padStart(2, "0")}.365 pimentoblue user.notice luaworks[247]: cs.c.websocketconnection [${2300 + i}]: sendResponse: [ clientId: 002a209c ] [ size: 91 ] [ id: codex-1795015244-272185-${i} ] [ code: 304 ] [ cmd: connect.statedigest?get ]`,
        );
      }
      const logFile = path.join(tmpDir, "syslog.txt");
      fs.writeFileSync(logFile, sampleLines.join("\n") + "\n");
      const stub = path.join(tmpDir, "logread");
      fs.writeFileSync(stub, `#!/bin/sh\ncat "${logFile}"\n`, { mode: 0o755 });

      const out = execFileSync("/bin/sh", ["-c", pipeline], {
        env: { ...process.env, PATH: `${tmpDir}:${process.env.PATH}` },
        encoding: "utf8",
      });
      assert.doesNotMatch(out, /connect\.statedigest\?get/, "304 state-digest poll noise must be filtered out");
      assert.match(out, /codexactivity: committed ActivityList/);
      assert.match(out, /codexmqtt: connected to broker/);
      assert.match(out, /harmony\.engine\?startactivity/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("notes in the System view Logs section that hub syslog timestamps are UTC", () => {
    const viewSrc = fs.readFileSync(
      path.join(REPO_ROOT, "tools/webui-sim/public/js/views/system.js"),
      "utf8",
    );
    assert.match(viewSrc, /syslog timestamps are.*UTC/i);
  });
});
