"use strict";

// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Matthew Gibbons (Melodious — LICENSE section 2)
//
// Melodious Root Wizard Slice 1: read-only Detect & Classify orchestrator
// and IPC handlers.

const { isTrustedIpcSender } = require("../security");
const { normalizeHost } = require("../settings");
const { scanSsdp, probeHub } = require("../discovery");
const {
  ALLOWED_BRIDGE_ACTIONS,
  ALLOWED_USB_BACKENDS,
  DEFAULT_BRIDGE_SCRIPT,
  HUB_ROOT_DIR,
  resolvePythonExecutable,
  buildBridgeArgs,
  runWizardBridge,
} = require("./bridge");
const {
  VERDICTS,
  USER_INTENTS,
  REQUIRED_FIRMWARE,
  evaluateFirmwareGate,
  evaluateMismatch,
  classifyHubSignals,
} = require("./classifier");

const WIZARD_CHANNELS = Object.freeze({
  detectClassify: "wizard:detect-classify",
  usbProbe: "wizard:usb-probe",
  event: "desktop:wizard-event",
});

function isWizardDevAvailable({
  isPackaged = false,
  platform = process.platform,
} = {}) {
  return !isPackaged && platform === "darwin";
}

function validateOptionalHost(rawHost) {
  const s = String(rawHost ?? "").trim();
  if (!s) return "";
  return normalizeHost(s);
}

function validateUserIntent(rawIntent) {
  const s = String(rawIntent ?? "").trim().toLowerCase();
  if (!s) return "";
  if (s !== USER_INTENTS.FRESH && s !== USER_INTENTS.PROVISIONED) {
    throw new Error('Invalid userIntent: must be "fresh", "provisioned", or empty');
  }
  return s;
}

async function detectAndClassify({
  userIntent = "",
  host = "",
  webUiPort = 8080,
  hbusPort = 8088,
  xmppPort = 5222,
  sshPort = 22,
  usbBackend = "auto",
  usbDevicePath = "",
  skipUsb = false,
  mask = true,
  authHeader = null,
  ssdpTimeoutMs = 1500,
  probeTimeoutMs = 2000,
  bridgeTimeoutMs = 12000,
  scanSsdpImpl = scanSsdp,
  probeHubImpl = probeHub,
  runBridgeImpl = runWizardBridge,
  onEvent = null,
} = {}) {
  const cleanIntent = validateUserIntent(userIntent);
  let targetHost = validateOptionalHost(host);

  const emit = (evt) => {
    if (typeof onEvent === "function") {
      try {
        onEvent(evt);
      } catch {}
    }
  };

  // 1. SSDP discovery on LAN (239.255.255.250:1900)
  emit({
    type: "step",
    step: "ssdp-scan",
    message: "Scanning local network via SSDP for Harmony Hubs",
  });
  let ssdpCandidates = [];
  try {
    ssdpCandidates = await scanSsdpImpl({ timeoutMs: ssdpTimeoutMs });
  } catch {
    ssdpCandidates = [];
  }
  if (!targetHost && ssdpCandidates.length === 1 && ssdpCandidates[0]?.host) {
    try {
      targetHost = normalizeHost(ssdpCandidates[0].host);
    } catch {
      targetHost = "";
    }
  }
  emit({
    type: "progress",
    step: "ssdp-scan",
    status: "ok",
    candidateCount: ssdpCandidates.length,
  });

  // 2. Probe :8080 /api/system-status if we have a target host
  let webUiProbe = null;
  if (targetHost) {
    emit({
      type: "step",
      step: "webui-8080",
      message: "Checking /api/system-status on port 8080",
    });
    try {
      webUiProbe = await probeHubImpl({
        host: targetHost,
        port: Number(webUiPort) || 8080,
        authHeader,
        timeoutMs: probeTimeoutMs,
      });
    } catch {
      webUiProbe = null;
    }
    emit({
      type: "progress",
      step: "webui-8080",
      status: webUiProbe ? "ok" : "unreachable",
      reachable: Boolean(webUiProbe),
    });
  }

  // 3. Run Python wizard_bridge.py (USB preflight + sysinfo + LAN :8088 getProvisionInfo + :5222/:22 TCP checks)
  const bridgeOutcome = await runBridgeImpl({
    action: "classify",
    host: targetHost,
    usbBackend,
    usbDevicePath,
    timeoutMs: bridgeTimeoutMs,
    hbusPort,
    xmppPort,
    sshPort,
    webUiPort,
    skipUsb: Boolean(skipUsb),
    mask: mask !== false,
    onEvent: emit,
  });

  const classified = classifyHubSignals({
    userIntent: cleanIntent,
    ssdpCandidates,
    webUiProbe,
    bridgeResult: bridgeOutcome.result,
    mask: mask !== false,
  });

  return {
    ok: true,
    bridgeOk: bridgeOutcome.ok,
    bridgeExitCode: bridgeOutcome.exitCode,
    pythonPath: bridgeOutcome.pythonPath,
    bridgeError: bridgeOutcome.error || null,
    events: bridgeOutcome.events,
    ...classified,
  };
}

async function runUsbProbe({
  action = "probe",
  usbBackend = "auto",
  usbDevicePath = "",
  mask = true,
  timeoutMs = 12000,
  runBridgeImpl = runWizardBridge,
  onEvent = null,
} = {}) {
  if (!["probe", "usb-enumerate", "usb-preflight", "usb-sysinfo"].includes(action)) {
    throw new Error(`Invalid USB probe action: ${action}`);
  }
  const outcome = await runBridgeImpl({
    action,
    usbBackend,
    usbDevicePath,
    timeoutMs,
    skipUsb: false,
    mask: mask !== false,
    onEvent,
  });
  return {
    ok: outcome.ok,
    exitCode: outcome.exitCode,
    pythonPath: outcome.pythonPath,
    error: outcome.error || null,
    events: outcome.events,
    usb: outcome.result?.usb || null,
  };
}

function createWizardIpcHandlers({
  getMainWindow,
  getSavedAuthHeader = () => null,
  detectAndClassifyImpl = detectAndClassify,
  runUsbProbeImpl = runUsbProbe,
} = {}) {
  const ensureTrusted = (event) => {
    const win = typeof getMainWindow === "function" ? getMainWindow() : null;
    if (!isTrustedIpcSender(event, win)) {
      throw new Error("Untrusted IPC sender");
    }
    return win;
  };

  const forwardEventToWindow = (win) => (evt) => {
    if (win && !win.isDestroyed?.() && win.webContents) {
      win.webContents.send(WIZARD_CHANNELS.event, evt);
    }
  };

  return {
    [WIZARD_CHANNELS.detectClassify]: async (event, args = {}) => {
      const win = ensureTrusted(event);
      if (args !== undefined && (!args || typeof args !== "object" || Array.isArray(args))) {
        throw new Error("Invalid wizard arguments");
      }
      return detectAndClassifyImpl({
        userIntent: args.userIntent ?? "",
        host: args.host ?? "",
        usbBackend: args.usbBackend ?? "auto",
        usbDevicePath: args.usbDevicePath ?? "",
        skipUsb: Boolean(args.skipUsb),
        mask: args.mask !== false,
        authHeader: getSavedAuthHeader(),
        onEvent: forwardEventToWindow(win),
      });
    },
    [WIZARD_CHANNELS.usbProbe]: async (event, args = {}) => {
      const win = ensureTrusted(event);
      if (args !== undefined && (!args || typeof args !== "object" || Array.isArray(args))) {
        throw new Error("Invalid wizard USB probe arguments");
      }
      return runUsbProbeImpl({
        action: args.action ?? "probe",
        usbBackend: args.usbBackend ?? "auto",
        usbDevicePath: args.usbDevicePath ?? "",
        mask: args.mask !== false,
        onEvent: forwardEventToWindow(win),
      });
    },
  };
}

function registerWizardIpcHandlers({
  ipcMain,
  getMainWindow,
  getSavedAuthHeader,
  detectAndClassifyImpl,
  runUsbProbeImpl,
} = {}) {
  const handlers = createWizardIpcHandlers({
    getMainWindow,
    getSavedAuthHeader,
    detectAndClassifyImpl,
    runUsbProbeImpl,
  });
  for (const [channel, handler] of Object.entries(handlers)) {
    ipcMain.handle(channel, handler);
  }
  return handlers;
}

module.exports = {
  WIZARD_CHANNELS,
  isWizardDevAvailable,
  VERDICTS,
  USER_INTENTS,
  REQUIRED_FIRMWARE,
  ALLOWED_BRIDGE_ACTIONS,
  ALLOWED_USB_BACKENDS,
  DEFAULT_BRIDGE_SCRIPT,
  HUB_ROOT_DIR,
  resolvePythonExecutable,
  buildBridgeArgs,
  runWizardBridge,
  evaluateFirmwareGate,
  evaluateMismatch,
  classifyHubSignals,
  detectAndClassify,
  runUsbProbe,
  createWizardIpcHandlers,
  registerWizardIpcHandlers,
};
