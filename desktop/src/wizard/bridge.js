"use strict";

// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Matthew Gibbons (Melodious — LICENSE section 2)
//
// Main-process spawner for tools/hub-root/wizard_bridge.py.
// Enforces an explicit action allowlist, requires --confirm-action for all
// state-changing actions, pipes sensitive credentials (such as Wi-Fi
// passphrases) over stdin JSON rather than CLI argv, and parses NDJSON events.

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const HUB_ROOT_DIR = path.join(REPO_ROOT, "tools", "hub-root");
const DEFAULT_BRIDGE_SCRIPT = path.join(HUB_ROOT_DIR, "wizard_bridge.py");

const READONLY_BRIDGE_ACTIONS = new Set([
  "probe",
  "classify",
  "usb-enumerate",
  "usb-preflight",
  "usb-sysinfo",
  "usb-provision-info",
  "usb-discovery-info",
  "lan-provision-info",
  "usb-wifi-scan",
  "usb-wifi-status",
]);

const MUTATING_BRIDGE_ACTIONS = new Set([
  "usb-wifi-connect",
  "usb-factory-reset",
  "usb-flash-firmware",
  "usb-tde-enable",
  "usb-provision-local",
  "usb-seed-automation",
  "lan-root-xmpp",
  "usb-root",
  "post-root",
]);

const ALLOWED_BRIDGE_ACTIONS = new Set([
  ...READONLY_BRIDGE_ACTIONS,
  ...MUTATING_BRIDGE_ACTIONS,
]);

const ALLOWED_USB_BACKENDS = new Set(["auto", "hidapi", "hidraw", "winhid"]);

function resolvePythonExecutable({
  env = process.env,
  platform = process.platform,
  hubRootDir = HUB_ROOT_DIR,
  existsSync = fs.existsSync,
} = {}) {
  if (env.MELODIOUS_WIZARD_PYTHON && String(env.MELODIOUS_WIZARD_PYTHON).trim()) {
    return String(env.MELODIOUS_WIZARD_PYTHON).trim();
  }
  const pathMod = platform === "win32" ? path.win32 : path.posix;
  const venvCandidates =
    platform === "win32"
      ? [pathMod.join(hubRootDir, ".venv", "Scripts", "python.exe")]
      : [
          pathMod.join(hubRootDir, ".venv", "bin", "python"),
          pathMod.join(hubRootDir, ".venv", "bin", "python3"),
        ];
  for (const candidate of venvCandidates) {
    try {
      if (existsSync(candidate)) return candidate;
    } catch {}
  }
  return platform === "win32" ? "python" : "python3";
}

function validatePositiveRemoteId(remoteId) {
  if (typeof remoteId !== "number" || !Number.isSafeInteger(remoteId) || remoteId <= 0) {
    throw new Error("Invalid remoteId: must be a strictly positive integer (never a string)");
  }
  return remoteId;
}

function validateSafeCliValue(rawValue, label) {
  const s = String(rawValue ?? "");
  if (/[\r\n\u0000]/.test(s)) {
    throw new Error(`Invalid ${label}`);
  }
  const trimmed = s.trim();
  if (trimmed.startsWith("-")) {
    throw new Error(`Invalid ${label}`);
  }
  return trimmed;
}

function scrubSecretText(text, secret) {
  const s = String(text ?? "");
  const sec = String(secret ?? "");
  if (!s || !sec) return s;
  return s.split(sec).join("<redacted>");
}

function buildBridgeArgs(options = {}) {
  if (
    Object.prototype.hasOwnProperty.call(options, "wifiPassword") ||
    Object.prototype.hasOwnProperty.call(options, "password")
  ) {
    throw new Error("Wi-Fi password must never be passed on CLI argv; use stdinJson");
  }

  const {
    action = "probe",
    confirmAction = "",
    allowUnprovenPost = false,
    host = "",
    usbBackend = "auto",
    usbDevicePath = "",
    timeoutMs = 12000,
    hbusPort = 8088,
    xmppPort = 5222,
    sshPort = 22,
    webUiPort = 8080,
    sshWait = 120,
    skipUsb = false,
    mask = true,
    ssid = "",
    encryption = "",
    noSave = false,
    showSsids = null,
    firmwareFile = "",
    verifyTimeoutS = null,
    skipPostRebootVerify = false,
    remoteId = null,
    accountId = "",
    hubName = "",
    email = "",
    noReboot = false,
    ignoreSavedHubId = false,
  } = options;

  const cleanAction = String(action || "probe").trim();
  if (!ALLOWED_BRIDGE_ACTIONS.has(cleanAction)) {
    throw new Error(
      `Disallowed wizard_bridge action "${cleanAction}": action is not in ALLOWED_BRIDGE_ACTIONS`
    );
  }

  if (MUTATING_BRIDGE_ACTIONS.has(cleanAction)) {
    if (String(confirmAction || "").trim() !== cleanAction) {
      throw new Error(
        `State-changing action "${cleanAction}" requires confirmAction="${cleanAction}"`
      );
    }
    if (cleanAction === "post-root" && allowUnprovenPost !== true) {
      throw new Error(
        'Action "post-root" is experimental/unproven and requires allowUnprovenPost=true'
      );
    }
  }

  const cleanBackend = String(usbBackend || "auto").trim();
  if (!ALLOWED_USB_BACKENDS.has(cleanBackend)) {
    throw new Error(`Invalid USB backend "${cleanBackend}"`);
  }
  const numericTimeout = Number(timeoutMs);
  if (!Number.isFinite(numericTimeout) || numericTimeout <= 0 || numericTimeout > 900000) {
    throw new Error("Invalid timeoutMs: must be between 1 and 900000");
  }

  const args = [
    "--action",
    cleanAction,
    "--usb-backend",
    cleanBackend,
    "--timeout-ms",
    String(Math.trunc(numericTimeout)),
    "--hbus-port",
    String(Number(hbusPort) || 8088),
    "--xmpp-port",
    String(Number(xmppPort) || 5222),
    "--ssh-port",
    String(Number(sshPort) || 22),
    "--webui-port",
    String(Number(webUiPort) || 8080),
  ];

  if (MUTATING_BRIDGE_ACTIONS.has(cleanAction)) {
    args.push("--confirm-action", cleanAction);
    if (cleanAction === "post-root" && allowUnprovenPost === true) {
      args.push("--allow-unproven-post");
    }
  }

  const rawHost = String(host ?? "");
  if (/[\r\n\u0000]/.test(rawHost)) {
    throw new Error("Invalid hub host");
  }
  const cleanHost = rawHost.trim();
  if (cleanHost) {
    if (/\s/.test(cleanHost) || cleanHost.startsWith("-")) {
      throw new Error("Invalid hub host");
    }
    args.push("--hub-host", cleanHost);
  }

  const cleanDevicePath = validateSafeCliValue(usbDevicePath, "USB device path");
  if (cleanDevicePath) {
    args.push("--usb-device-path", cleanDevicePath);
  }

  if (ssid !== undefined && ssid !== null && String(ssid) !== "") {
    const cleanSsid = validateSafeCliValue(ssid, "SSID");
    const ssidBytes = Buffer.byteLength(cleanSsid, "utf8");
    if (ssidBytes < 1 || ssidBytes > 32) {
      throw new Error("Invalid SSID: must be between 1 and 32 UTF-8 bytes");
    }
    args.push("--ssid", cleanSsid);
  }

  if (encryption) {
    const cleanEnc = validateSafeCliValue(encryption, "Wi-Fi encryption");
    if (cleanEnc) args.push("--encryption", cleanEnc);
  }

  if (noSave) {
    args.push("--no-save");
  }

  if (showSsids === true) {
    args.push("--show-ssids");
  } else if (showSsids === false) {
    args.push("--hide-ssids");
  }

  if (firmwareFile !== undefined && firmwareFile !== null && String(firmwareFile) !== "") {
    const cleanFw = validateSafeCliValue(firmwareFile, "firmware file path");
    if (!cleanFw.toLowerCase().endsWith(".hfw2")) {
      throw new Error("Invalid firmware file path: must end with .hfw2");
    }
    args.push("--firmware-file", cleanFw);
  }

  if (verifyTimeoutS !== null && verifyTimeoutS !== undefined) {
    const numVerify = Number(verifyTimeoutS);
    if (!Number.isFinite(numVerify) || numVerify < 0 || numVerify > 900) {
      throw new Error("Invalid verifyTimeoutS");
    }
    args.push("--verify-timeout-s", String(Math.trunc(numVerify)));
  }

  if (skipPostRebootVerify) {
    args.push("--skip-post-reboot-verify");
  }

  if (remoteId !== null && remoteId !== undefined && remoteId !== "") {
    const validRemoteId = validatePositiveRemoteId(remoteId);
    args.push("--remote-id", String(validRemoteId));
  }

  if (accountId) {
    const cleanAccount = validateSafeCliValue(accountId, "accountId");
    if (cleanAccount) args.push("--account-id", cleanAccount);
  }

  if (hubName) {
    const cleanName = validateSafeCliValue(hubName, "hubName");
    if (cleanName) args.push("--hub-name", cleanName);
  }

  if (email) {
    const cleanEmail = validateSafeCliValue(email, "email");
    if (cleanEmail) args.push("--email", cleanEmail);
  }

  if (noReboot) {
    args.push("--no-reboot");
  }

  if (ignoreSavedHubId) {
    args.push("--ignore-saved-hub-id");
  }

  if (sshWait !== undefined && sshWait !== null && Number(sshWait) !== 120) {
    const numSshWait = Number(sshWait);
    if (!Number.isFinite(numSshWait) || numSshWait < 5 || numSshWait > 600) {
      throw new Error("Invalid sshWait");
    }
    args.push("--ssh-wait", String(Math.trunc(numSshWait)));
  }

  if (skipUsb) {
    args.push("--skip-usb");
  }

  args.push(mask === false ? "--no-mask" : "--mask");
  return args;
}

function runWizardBridge({
  action = "probe",
  confirmAction = "",
  allowUnprovenPost = false,
  host = "",
  usbBackend = "auto",
  usbDevicePath = "",
  timeoutMs = 12000,
  processTimeoutMs = 35000,
  hbusPort = 8088,
  xmppPort = 5222,
  sshPort = 22,
  webUiPort = 8080,
  sshWait = 120,
  skipUsb = false,
  mask = true,
  ssid = "",
  encryption = "",
  noSave = false,
  showSsids = null,
  firmwareFile = "",
  verifyTimeoutS = null,
  skipPostRebootVerify = false,
  remoteId = null,
  accountId = "",
  hubName = "",
  email = "",
  noReboot = false,
  ignoreSavedHubId = false,
  stdinJson = null,
  pythonPath = resolvePythonExecutable(),
  bridgePath = DEFAULT_BRIDGE_SCRIPT,
  spawnImpl = spawn,
  onEvent = null,
} = {}) {
  return new Promise((resolve, reject) => {
    let bridgeArgs;
    try {
      bridgeArgs = buildBridgeArgs({
        action,
        confirmAction,
        allowUnprovenPost,
        host,
        usbBackend,
        usbDevicePath,
        timeoutMs,
        hbusPort,
        xmppPort,
        sshPort,
        webUiPort,
        sshWait,
        skipUsb,
        mask,
        ssid,
        encryption,
        noSave,
        showSsids,
        firmwareFile,
        verifyTimeoutS,
        skipPostRebootVerify,
        remoteId,
        accountId,
        hubName,
        email,
        noReboot,
        ignoreSavedHubId,
      });
    } catch (err) {
      reject(err);
      return;
    }

    if (stdinJson !== null && (typeof stdinJson !== "object" || Array.isArray(stdinJson))) {
      reject(new Error("Invalid stdinJson: must be a plain object or null"));
      return;
    }

    const secretToScrub =
      stdinJson && typeof stdinJson.password === "string" && stdinJson.password.length > 0
        ? stdinJson.password
        : "";

    const events = [];
    let resultEvent = null;
    let stdoutRemainder = "";
    let stderrText = "";
    let settled = false;
    let timedOut = false;

    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };

    const handleLine = (line) => {
      const trimmed = scrubSecretText(line.trim(), secretToScrub);
      if (!trimmed) return;
      let parsed;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        parsed = {
          type: "error",
          step: "ndjson",
          code: "invalid_ndjson_line",
          message: `Non-JSON stdout line from wizard_bridge: ${trimmed.slice(0, 200)}`,
        };
      }
      events.push(parsed);
      if (parsed && parsed.type === "result") {
        resultEvent = parsed;
      }
      if (typeof onEvent === "function") {
        try {
          onEvent(parsed);
        } catch {}
      }
    };

    let child;
    try {
      child = spawnImpl(pythonPath, [bridgePath, ...bridgeArgs], {
        cwd: path.dirname(bridgePath),
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          PYTHONUNBUFFERED: "1",
          HARMONY_NO_PAUSE: "1",
        },
      });
    } catch (err) {
      const cleanErr = scrubSecretText(String(err?.message || err), secretToScrub);
      finish({
        ok: false,
        exitCode: -1,
        timedOut: false,
        pythonPath,
        bridgePath,
        events,
        result: null,
        stderr: cleanErr,
        error: `Failed to spawn Python (${pythonPath}): ${cleanErr}`,
      });
      return;
    }

    if (child.stdin) {
      child.stdin.on?.("error", () => {});
      if (stdinJson !== null) {
        try {
          child.stdin.write(`${JSON.stringify(stdinJson)}\n`);
        } catch {}
      }
      try {
        child.stdin.end?.();
      } catch {}
    }

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {}
    }, Math.max(1000, Number(processTimeoutMs) || 35000));

    child.stdout?.on("data", (chunk) => {
      stdoutRemainder += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      let newlineIdx = stdoutRemainder.indexOf("\n");
      while (newlineIdx >= 0) {
        const line = stdoutRemainder.slice(0, newlineIdx);
        stdoutRemainder = stdoutRemainder.slice(newlineIdx + 1);
        handleLine(line);
        newlineIdx = stdoutRemainder.indexOf("\n");
      }
    });

    child.stderr?.on("data", (chunk) => {
      if (stderrText.length < 65536) {
        stderrText += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      }
    });

    child.on("error", (err) => {
      const cleanErr = scrubSecretText(String(err?.message || err), secretToScrub);
      const cleanStderr = scrubSecretText(stderrText.trim(), secretToScrub);
      finish({
        ok: false,
        exitCode: -1,
        timedOut,
        pythonPath,
        bridgePath,
        events,
        result: resultEvent,
        stderr: cleanStderr,
        error: `Failed to run Python (${pythonPath}): ${cleanErr}`,
      });
    });

    child.on("close", (code) => {
      if (stdoutRemainder.trim()) {
        handleLine(stdoutRemainder);
        stdoutRemainder = "";
      }
      const exitCode = typeof code === "number" ? code : -1;
      const errorEvent = [...events].reverse().find((e) => e && e.type === "error");
      const ok = Boolean(!timedOut && exitCode === 0 && resultEvent && resultEvent.ok);
      const cleanStderr = scrubSecretText(stderrText.trim(), secretToScrub);
      const rawFallbackErr =
        errorEvent?.message || (ok ? null : cleanStderr || resultEvent?.usb?.error || null);
      finish({
        ok,
        exitCode,
        timedOut,
        pythonPath,
        bridgePath,
        events,
        result: resultEvent,
        stderr: cleanStderr,
        error: timedOut
          ? `wizard_bridge timed out after ${processTimeoutMs} ms`
          : rawFallbackErr
            ? scrubSecretText(rawFallbackErr, secretToScrub)
            : null,
      });
    });
  });
}

module.exports = {
  READONLY_BRIDGE_ACTIONS,
  MUTATING_BRIDGE_ACTIONS,
  ALLOWED_BRIDGE_ACTIONS,
  ALLOWED_USB_BACKENDS,
  DEFAULT_BRIDGE_SCRIPT,
  HUB_ROOT_DIR,
  resolvePythonExecutable,
  validatePositiveRemoteId,
  scrubSecretText,
  buildBridgeArgs,
  runWizardBridge,
};
