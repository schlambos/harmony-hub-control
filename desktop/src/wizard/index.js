"use strict";

// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Matthew Gibbons (Melodious — LICENSE section 2)
//
// Melodious Root Wizard Slice 1 + Slice 2: Detect & Classify + structured
// pre-root/root action orchestrator and IPC handlers.

const { isTrustedIpcSender } = require("../security");
const { normalizeHost } = require("../settings");
const { scanSsdp, probeHub } = require("../discovery");
const {
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
  runAction: "wizard:run-action",
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

function validateRequiredHost(rawHost, actionLabel = "action") {
  const host = validateOptionalHost(rawHost);
  if (!host) {
    throw new Error(`Hub IP address or hostname is required for ${actionLabel}`);
  }
  return host;
}

function validateUserIntent(rawIntent) {
  const s = String(rawIntent ?? "").trim().toLowerCase();
  if (!s) return "";
  if (s !== USER_INTENTS.FRESH && s !== USER_INTENTS.PROVISIONED) {
    throw new Error('Invalid userIntent: must be "fresh", "provisioned", or empty');
  }
  return s;
}

function validateWifiSsid(rawSsid) {
  const s = String(rawSsid ?? "");
  if (/[\r\n\u0000]/.test(s)) {
    throw new Error("Invalid Wi-Fi SSID: must not contain newlines or NUL bytes");
  }
  const trimmed = s.trim();
  const byteLen = Buffer.byteLength(trimmed, "utf8");
  if (!trimmed || byteLen < 1 || byteLen > 32) {
    throw new Error("Invalid Wi-Fi SSID: must be 1 to 32 UTF-8 bytes");
  }
  return trimmed;
}

function validateWifiPassword(rawPassword, encryption = "WPA2-PSK") {
  const pass = String(rawPassword ?? "");
  if (/[\r\n\u0000]/.test(pass)) {
    throw new Error("Invalid Wi-Fi password: must not contain newlines or NUL bytes");
  }
  const encUpper = String(encryption || "WPA2-PSK").trim().toUpperCase();
  if (encUpper !== "NONE" && encUpper !== "OPEN" && !pass) {
    throw new Error("Wi-Fi password is required unless encryption is NONE or OPEN");
  }
  return pass;
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

  // 3. Run Python wizard_bridge.py (USB preflight + sysinfo + USB getProvisionInfo/discoveryinfo + LAN :8088 + :5222/:22)
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
  if (
    ![
      "probe",
      "usb-enumerate",
      "usb-preflight",
      "usb-sysinfo",
      "usb-provision-info",
      "usb-discovery-info",
    ].includes(action)
  ) {
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

async function runWizardAction({
  action = "",
  confirmAction = "",
  allowUnprovenPost = false,
  host = "",
  usbBackend = "auto",
  usbDevicePath = "",
  mask = true,
  timeoutMs = 30000,
  processTimeoutMs = 180000,
  ssid = "",
  password = "",
  encryption = "WPA2-PSK",
  noSave = false,
  showSsids = true,
  firmwareFile = "",
  verifyTimeoutS = null,
  skipPostRebootVerify = false,
  remoteId = null,
  accountId = "",
  hubName = "Harmony Hub",
  email = "hub@local",
  noReboot = false,
  ignoreSavedHubId = false,
  resetPayload = "1",
  runBridgeImpl = runWizardBridge,
  onEvent = null,
} = {}) {
  const cleanAction = String(action || "").trim();
  if (!ALLOWED_BRIDGE_ACTIONS.has(cleanAction)) {
    throw new Error(`Disallowed wizard_bridge action "${cleanAction}"`);
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

  let stdinJson = null;
  let targetHost = "";
  let validRemoteId = null;

  if (cleanAction === "usb-factory-reset") {
    if (String(resetPayload ?? "1").trim() !== "1") {
      throw new Error('Factory reset payload must be "1" ONLY (never "all")');
    }
  } else if (cleanAction === "usb-wifi-connect") {
    const cleanSsid = validateWifiSsid(ssid);
    const cleanEnc = String(encryption || "WPA2-PSK").trim() || "WPA2-PSK";
    const cleanPass = validateWifiPassword(password, cleanEnc);
    stdinJson = {
      ssid: cleanSsid,
      password: cleanPass,
      encryption: cleanEnc,
      noSave: Boolean(noSave),
    };
  } else if (cleanAction === "usb-flash-firmware") {
    const cleanFw = String(firmwareFile ?? "").trim();
    if (!cleanFw || !cleanFw.toLowerCase().endsWith(".hfw2")) {
      throw new Error("A valid .hfw2 firmware file path is required for usb-flash-firmware");
    }
  } else if (cleanAction === "usb-provision-local") {
    validRemoteId = validatePositiveRemoteId(remoteId);
    stdinJson = {
      remoteId: validRemoteId,
      accountId: String(accountId || `hub-local-${validRemoteId}`).trim(),
      name: String(hubName || "Harmony Hub").trim(),
      email: String(email || "hub@local").trim(),
    };
  } else if (cleanAction === "usb-seed-automation") {
    if (remoteId !== null && remoteId !== undefined && remoteId !== "") {
      validRemoteId = validatePositiveRemoteId(remoteId);
    }
  } else if (
    cleanAction === "lan-root-xmpp" ||
    cleanAction === "usb-root" ||
    cleanAction === "post-root"
  ) {
    targetHost = validateRequiredHost(host, cleanAction);
    if (remoteId !== null && remoteId !== undefined && remoteId !== "") {
      validRemoteId = validatePositiveRemoteId(remoteId);
    }
  } else if (cleanAction === "lan-provision-info") {
    targetHost = validateRequiredHost(host, cleanAction);
  } else {
    targetHost = validateOptionalHost(host);
  }

  const outcome = await runBridgeImpl({
    action: cleanAction,
    confirmAction: MUTATING_BRIDGE_ACTIONS.has(cleanAction) ? cleanAction : "",
    allowUnprovenPost: cleanAction === "post-root" && allowUnprovenPost === true,
    host: targetHost,
    usbBackend,
    usbDevicePath,
    timeoutMs,
    processTimeoutMs,
    mask: mask !== false,
    showSsids: Boolean(showSsids),
    firmwareFile: cleanAction === "usb-flash-firmware" ? firmwareFile : "",
    verifyTimeoutS,
    skipPostRebootVerify: Boolean(skipPostRebootVerify),
    remoteId: validRemoteId,
    accountId: cleanAction === "usb-seed-automation" ? String(accountId || "").trim() : "",
    noReboot: Boolean(noReboot),
    ignoreSavedHubId: Boolean(ignoreSavedHubId),
    stdinJson,
    onEvent,
  });

  return {
    ok: outcome.ok,
    action: cleanAction,
    exitCode: outcome.exitCode,
    pythonPath: outcome.pythonPath,
    error: outcome.error || null,
    events: outcome.events,
    result: outcome.result || null,
  };
}

function createWizardIpcHandlers({
  getMainWindow,
  getSavedAuthHeader = () => null,
  isWizardAvailable = () => true,
  pickFirmwareFile = async () => null,
  detectAndClassifyImpl = detectAndClassify,
  runUsbProbeImpl = runUsbProbe,
  runWizardActionImpl = runWizardAction,
} = {}) {
  const ensureTrustedAndAvailable = (event) => {
    const win = typeof getMainWindow === "function" ? getMainWindow() : null;
    if (!isTrustedIpcSender(event, win)) {
      throw new Error("Untrusted IPC sender");
    }
    if (typeof isWizardAvailable === "function" && !isWizardAvailable()) {
      throw new Error("Root Wizard dev actions are not available in this build");
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
      const win = ensureTrustedAndAvailable(event);
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
      const win = ensureTrustedAndAvailable(event);
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
    [WIZARD_CHANNELS.runAction]: async (event, args = {}) => {
      const win = ensureTrustedAndAvailable(event);
      if (!args || typeof args !== "object" || Array.isArray(args)) {
        throw new Error("Invalid wizard action arguments");
      }
      if (Object.prototype.hasOwnProperty.call(args, "firmwareFile")) {
        throw new Error(
          "Renderer-supplied firmwareFile path is not permitted; firmware bundle must be chosen via native dialog"
        );
      }

      const cleanAction = String(args.action || "").trim();
      let selectedFirmwareFile = "";
      if (cleanAction === "usb-flash-firmware") {
        if (String(args.confirmAction || "").trim() !== "usb-flash-firmware") {
          throw new Error(
            'State-changing action "usb-flash-firmware" requires confirmAction="usb-flash-firmware"'
          );
        }
        const picked = await pickFirmwareFile(win);
        if (!picked) {
          return {
            ok: false,
            canceled: true,
            action: "usb-flash-firmware",
          };
        }
        selectedFirmwareFile = String(picked).trim();
      }

      return runWizardActionImpl({
        action: cleanAction,
        confirmAction: args.confirmAction ?? "",
        allowUnprovenPost: args.allowUnprovenPost === true,
        host: args.host ?? "",
        usbBackend: args.usbBackend ?? "auto",
        usbDevicePath: args.usbDevicePath ?? "",
        mask: args.mask !== false,
        ssid: args.ssid ?? "",
        password: args.password ?? "",
        encryption: args.encryption ?? "WPA2-PSK",
        noSave: Boolean(args.noSave),
        showSsids: args.showSsids !== false,
        firmwareFile: selectedFirmwareFile,
        verifyTimeoutS: args.verifyTimeoutS ?? null,
        skipPostRebootVerify: Boolean(args.skipPostRebootVerify),
        remoteId: args.remoteId ?? null,
        accountId: args.accountId ?? "",
        hubName: args.hubName ?? "Harmony Hub",
        email: args.email ?? "hub@local",
        noReboot: Boolean(args.noReboot),
        ignoreSavedHubId: Boolean(args.ignoreSavedHubId),
        resetPayload: args.resetPayload ?? "1",
        onEvent: forwardEventToWindow(win),
      });
    },
  };
}

function registerWizardIpcHandlers({
  ipcMain,
  getMainWindow,
  getSavedAuthHeader,
  isWizardAvailable,
  pickFirmwareFile,
  detectAndClassifyImpl,
  runUsbProbeImpl,
  runWizardActionImpl,
} = {}) {
  const handlers = createWizardIpcHandlers({
    getMainWindow,
    getSavedAuthHeader,
    isWizardAvailable,
    pickFirmwareFile,
    detectAndClassifyImpl,
    runUsbProbeImpl,
    runWizardActionImpl,
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
  READONLY_BRIDGE_ACTIONS,
  MUTATING_BRIDGE_ACTIONS,
  ALLOWED_BRIDGE_ACTIONS,
  ALLOWED_USB_BACKENDS,
  DEFAULT_BRIDGE_SCRIPT,
  HUB_ROOT_DIR,
  resolvePythonExecutable,
  validatePositiveRemoteId,
  validateWifiSsid,
  validateWifiPassword,
  scrubSecretText,
  buildBridgeArgs,
  runWizardBridge,
  evaluateFirmwareGate,
  evaluateMismatch,
  classifyHubSignals,
  detectAndClassify,
  runUsbProbe,
  runWizardAction,
  createWizardIpcHandlers,
  registerWizardIpcHandlers,
};
