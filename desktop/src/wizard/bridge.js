"use strict";

// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Matthew Gibbons (Melodious — LICENSE section 2)
//
// Main-process spawner for tools/hub-root/wizard_bridge.py.
// Strictly read-only: only permits probe/classify/usb-enumerate/usb-preflight/
// usb-sysinfo/lan-provision-info actions and parses line-delimited NDJSON events.

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const HUB_ROOT_DIR = path.join(REPO_ROOT, "tools", "hub-root");
const DEFAULT_BRIDGE_SCRIPT = path.join(HUB_ROOT_DIR, "wizard_bridge.py");

const ALLOWED_BRIDGE_ACTIONS = new Set([
  "probe",
  "classify",
  "usb-enumerate",
  "usb-preflight",
  "usb-sysinfo",
  "lan-provision-info",
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

function buildBridgeArgs({
  action = "probe",
  host = "",
  usbBackend = "auto",
  usbDevicePath = "",
  timeoutMs = 12000,
  hbusPort = 8088,
  xmppPort = 5222,
  sshPort = 22,
  webUiPort = 8080,
  skipUsb = false,
  mask = true,
} = {}) {
  const cleanAction = String(action || "probe").trim();
  if (!ALLOWED_BRIDGE_ACTIONS.has(cleanAction)) {
    throw new Error(
      `Disallowed wizard_bridge action "${cleanAction}": only read-only actions are permitted`
    );
  }
  const cleanBackend = String(usbBackend || "auto").trim();
  if (!ALLOWED_USB_BACKENDS.has(cleanBackend)) {
    throw new Error(`Invalid USB backend "${cleanBackend}"`);
  }
  const numericTimeout = Number(timeoutMs);
  if (!Number.isFinite(numericTimeout) || numericTimeout <= 0 || numericTimeout > 120000) {
    throw new Error("Invalid timeoutMs: must be between 1 and 120000");
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

  const rawDevicePath = String(usbDevicePath ?? "");
  if (/[\r\n\u0000]/.test(rawDevicePath)) {
    throw new Error("Invalid USB device path");
  }
  const cleanDevicePath = rawDevicePath.trim();
  if (cleanDevicePath) {
    if (cleanDevicePath.startsWith("-")) {
      throw new Error("Invalid USB device path");
    }
    args.push("--usb-device-path", cleanDevicePath);
  }

  if (skipUsb) {
    args.push("--skip-usb");
  }

  args.push(mask === false ? "--no-mask" : "--mask");
  return args;
}

function runWizardBridge({
  action = "probe",
  host = "",
  usbBackend = "auto",
  usbDevicePath = "",
  timeoutMs = 12000,
  processTimeoutMs = 35000,
  hbusPort = 8088,
  xmppPort = 5222,
  sshPort = 22,
  webUiPort = 8080,
  skipUsb = false,
  mask = true,
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
        host,
        usbBackend,
        usbDevicePath,
        timeoutMs,
        hbusPort,
        xmppPort,
        sshPort,
        webUiPort,
        skipUsb,
        mask,
      });
    } catch (err) {
      reject(err);
      return;
    }

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
      const trimmed = line.trim();
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
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          PYTHONUNBUFFERED: "1",
          HARMONY_NO_PAUSE: "1",
        },
      });
    } catch (err) {
      finish({
        ok: false,
        exitCode: -1,
        timedOut: false,
        pythonPath,
        bridgePath,
        events,
        result: null,
        stderr: String(err?.message || err),
        error: `Failed to spawn Python (${pythonPath}): ${err?.message || err}`,
      });
      return;
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
      finish({
        ok: false,
        exitCode: -1,
        timedOut,
        pythonPath,
        bridgePath,
        events,
        result: resultEvent,
        stderr: stderrText.trim(),
        error: `Failed to run Python (${pythonPath}): ${err?.message || err}`,
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
      finish({
        ok,
        exitCode,
        timedOut,
        pythonPath,
        bridgePath,
        events,
        result: resultEvent,
        stderr: stderrText.trim(),
        error: timedOut
          ? `wizard_bridge timed out after ${processTimeoutMs} ms`
          : errorEvent?.message || (ok ? null : stderrText.trim() || resultEvent?.usb?.error || null),
      });
    });
  });
}

module.exports = {
  ALLOWED_BRIDGE_ACTIONS,
  ALLOWED_USB_BACKENDS,
  DEFAULT_BRIDGE_SCRIPT,
  HUB_ROOT_DIR,
  resolvePythonExecutable,
  buildBridgeArgs,
  runWizardBridge,
};
