"use strict";

// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Matthew Gibbons (Melodious — LICENSE section 2)
//
// Melodious Root Wizard Slice 1 + Slice 2: Detect & Classify + structured
// pre-root/root action orchestrator and IPC handlers.

const fs = require("node:fs");
const path = require("node:path");
const { isTrustedIpcSender } = require("../security");
const { normalizeHost } = require("../settings");
const { scanSsdp, probeHub } = require("../discovery");
const {
  READONLY_BRIDGE_ACTIONS,
  MUTATING_BRIDGE_ACTIONS,
  ALLOWED_BRIDGE_ACTIONS,
  ALLOWED_USB_BACKENDS,
  DEFAULT_RESOURCES_PATH,
  DEFAULT_BRIDGE_SCRIPT,
  HUB_ROOT_DIR,
  resolveHubRootDir,
  resolveBridgeScriptPath,
  resolvePythonExecutable,
  buildIsolatedPythonEnv,
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
const {
  ALLOWED_INSTALL_SOURCES,
  DEFAULT_INSTALLER_SCRIPT,
  DEFAULT_HELPERS_DIR,
  INSTALLER_HELPER_NAMES,
  resolveInstallerPaths,
  validatePositiveHubId,
  validateInstallerHost,
  buildInstallerArgs,
  stageInstallerWorkspace,
  detectHostKeyChanged,
  clearKnownHost,
  installFreshHub,
} = require("./installer");

const WIZARD_CHANNELS = Object.freeze({
  detectClassify: "wizard:detect-classify",
  usbProbe: "wizard:usb-probe",
  runAction: "wizard:run-action",
  installHub: "wizard:install-hub",
  event: "desktop:wizard-event",
});

function hasBundledWizardResources({
  resourcesPath = DEFAULT_RESOURCES_PATH,
  platform = process.platform,
  existsSync = fs.existsSync,
} = {}) {
  if (platform !== "darwin") return false;
  const cleanResources = String(resourcesPath ?? "").trim();
  if (!cleanResources) return false;
  const requiredPaths = [
    path.posix.join(cleanResources, "wizard-python", "bin", "python3"),
    path.posix.join(cleanResources, "hub-root", "wizard_bridge.py"),
    path.posix.join(cleanResources, "hub-root", "dropbearmulti"),
    path.posix.join(cleanResources, "installer", "install_webui.py"),
    ...INSTALLER_HELPER_NAMES.map((helperName) =>
      path.posix.join(cleanResources, "installer", "payload", "helpers", helperName)
    ),
  ];
  for (const target of requiredPaths) {
    try {
      if (!existsSync(target)) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function isWizardDevAvailable({
  isPackaged = false,
  platform = process.platform,
  resourcesPath = DEFAULT_RESOURCES_PATH,
  existsSync = fs.existsSync,
} = {}) {
  if (platform !== "darwin") return false;
  if (!isPackaged) return true;
  return hasBundledWizardResources({ resourcesPath, platform, existsSync });
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

function extractUnmaskedUsbHost(usbResult) {
  const raw = String(usbResult?.discoveryInfo?.ip ?? "").trim();
  if (!raw || raw === "0.0.0.0" || raw === "none" || raw.startsWith("<")) {
    return "";
  }
  try {
    return normalizeHost(raw);
  } catch {
    return "";
  }
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
  const explicitHost = validateOptionalHost(host);
  let targetHost = explicitHost;

  const emit = (evt) => {
    if (typeof onEvent === "function") {
      try {
        onEvent(evt);
      } catch {}
    }
  };

  const runWebUiProbe = async (hostToProbe) => {
    if (!hostToProbe) return null;
    emit({
      type: "step",
      step: "webui-8080",
      message: "Checking /api/system-status on port 8080",
    });
    let probed = null;
    try {
      probed = await probeHubImpl({
        host: hostToProbe,
        port: Number(webUiPort) || 8080,
        authHeader,
        timeoutMs: probeTimeoutMs,
      });
    } catch {
      probed = null;
    }
    emit({
      type: "progress",
      step: "webui-8080",
      status: probed ? "ok" : "unreachable",
      reachable: Boolean(probed),
    });
    return probed;
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
  emit({
    type: "progress",
    step: "ssdp-scan",
    status: "ok",
    candidateCount: ssdpCandidates.length,
  });

  let webUiProbe = null;
  let bridgeOutcome = null;

  if (explicitHost) {
    // Explicit caller host: ONLY probe that host — never substitute or fall back to SSDP.
    webUiProbe = await runWebUiProbe(explicitHost);
    bridgeOutcome = await runBridgeImpl({
      action: "classify",
      host: explicitHost,
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
  } else if (!skipUsb) {
    // Blank host with USB enabled: probe USB FIRST without assuming an SSDP host
    // so a different hub on the LAN can never merge into the USB hub's verdict.
    const usbFirstOutcome = await runBridgeImpl({
      action: "classify",
      host: "",
      usbBackend,
      usbDevicePath,
      timeoutMs: bridgeTimeoutMs,
      hbusPort,
      xmppPort,
      sshPort,
      webUiPort,
      skipUsb: false,
      mask: mask !== false,
      onEvent: emit,
    });
    const usbConnected = Boolean(usbFirstOutcome.result?.usb?.connected);
    if (usbConnected) {
      const usbIp = extractUnmaskedUsbHost(usbFirstOutcome.result?.usb);
      if (usbIp) {
        targetHost = usbIp;
        webUiProbe = await runWebUiProbe(usbIp);
        const lanOutcome = await runBridgeImpl({
          action: "classify",
          host: usbIp,
          usbBackend,
          usbDevicePath,
          timeoutMs: bridgeTimeoutMs,
          hbusPort,
          xmppPort,
          sshPort,
          webUiPort,
          skipUsb: true,
          mask: mask !== false,
          onEvent: emit,
        });
        bridgeOutcome = {
          ...usbFirstOutcome,
          ok: Boolean(usbFirstOutcome.ok || lanOutcome.ok),
          events: [...(usbFirstOutcome.events || []), ...(lanOutcome.events || [])],
          result: {
            ...(usbFirstOutcome.result || {}),
            usb: usbFirstOutcome.result?.usb,
            lan: lanOutcome.result?.lan || { ok: false, skipped: true },
          },
        };
      } else {
        // USB connected with no IP (e.g. fresh hub before Wi-Fi, or masked):
        // do NOT merge another hub's SSDP :8080/:22 into the USB hub's verdict.
        bridgeOutcome = usbFirstOutcome;
      }
    } else {
      // USB not connected: only auto-pick when there is a single unambiguous SSDP candidate.
      if (ssdpCandidates.length === 1 && ssdpCandidates[0]?.host) {
        try {
          targetHost = normalizeHost(ssdpCandidates[0].host);
        } catch {
          targetHost = "";
        }
      }
      if (targetHost) {
        webUiProbe = await runWebUiProbe(targetHost);
        const lanOutcome = await runBridgeImpl({
          action: "classify",
          host: targetHost,
          usbBackend,
          usbDevicePath,
          timeoutMs: bridgeTimeoutMs,
          hbusPort,
          xmppPort,
          sshPort,
          webUiPort,
          skipUsb: true,
          mask: mask !== false,
          onEvent: emit,
        });
        bridgeOutcome = {
          ...lanOutcome,
          events: [...(usbFirstOutcome.events || []), ...(lanOutcome.events || [])],
          result: {
            ...(lanOutcome.result || {}),
            usb: usbFirstOutcome.result?.usb || lanOutcome.result?.usb,
          },
        };
      } else {
        bridgeOutcome = usbFirstOutcome;
      }
    }
  } else {
    // Blank host with skipUsb=true: auto-pick single SSDP candidate if unambiguous.
    if (ssdpCandidates.length === 1 && ssdpCandidates[0]?.host) {
      try {
        targetHost = normalizeHost(ssdpCandidates[0].host);
      } catch {
        targetHost = "";
      }
    }
    webUiProbe = await runWebUiProbe(targetHost);
    bridgeOutcome = await runBridgeImpl({
      action: "classify",
      host: targetHost,
      usbBackend,
      usbDevicePath,
      timeoutMs: bridgeTimeoutMs,
      hbusPort,
      xmppPort,
      sshPort,
      webUiPort,
      skipUsb: true,
      mask: mask !== false,
      onEvent: emit,
    });
  }

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

  const LONG_VERIFY_ACTIONS = new Set(["usb-provision-local", "usb-flash-firmware"]);
  let effectiveVerifyTimeoutS = verifyTimeoutS;
  if (
    LONG_VERIFY_ACTIONS.has(cleanAction) &&
    (effectiveVerifyTimeoutS === null || effectiveVerifyTimeoutS === undefined)
  ) {
    // Default to 180s so post-reboot luaworks (~2 min) has room; explicit
    // caller overrides (including 0 to skip verify) are preserved.
    effectiveVerifyTimeoutS = 180;
  }
  let effectiveProcessTimeoutMs = Number(processTimeoutMs) || 180000;
  if (LONG_VERIFY_ACTIONS.has(cleanAction)) {
    const verifyForHeadroom = Number(effectiveVerifyTimeoutS ?? 180) || 0;
    if (verifyForHeadroom > 0) {
      // Keep Node from SIGKILLing Python mid-reboot poll: verify window + 60s
      // margin, with a 5-minute floor for the slow post-reboot path.
      effectiveProcessTimeoutMs = Math.max(
        effectiveProcessTimeoutMs,
        verifyForHeadroom * 1000 + 60000,
        300000
      );
    } else {
      effectiveProcessTimeoutMs = Math.max(effectiveProcessTimeoutMs, 60000);
    }
  }

  const outcome = await runBridgeImpl({
    action: cleanAction,
    confirmAction: MUTATING_BRIDGE_ACTIONS.has(cleanAction) ? cleanAction : "",
    allowUnprovenPost: cleanAction === "post-root" && allowUnprovenPost === true,
    host: targetHost,
    usbBackend,
    usbDevicePath,
    timeoutMs,
    processTimeoutMs: effectiveProcessTimeoutMs,
    mask: mask !== false,
    showSsids: Boolean(showSsids),
    firmwareFile: cleanAction === "usb-flash-firmware" ? firmwareFile : "",
    verifyTimeoutS: effectiveVerifyTimeoutS,
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
  pickHubZip = async () => null,
  userAgent = "Melodious",
  detectAndClassifyImpl = detectAndClassify,
  runUsbProbeImpl = runUsbProbe,
  runWizardActionImpl = runWizardAction,
  installFreshHubImpl = installFreshHub,
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
    [WIZARD_CHANNELS.installHub]: async (event, args = {}) => {
      const win = ensureTrustedAndAvailable(event);
      if (!args || typeof args !== "object" || Array.isArray(args)) {
        throw new Error("Invalid wizard install arguments");
      }
      if (Object.prototype.hasOwnProperty.call(args, "hubZipPath")) {
        throw new Error(
          "Renderer-supplied hubZipPath is not permitted; local hub zip must be chosen via native dialog"
        );
      }
      if (Object.prototype.hasOwnProperty.call(args, "keyPath")) {
        throw new Error("Renderer-supplied keyPath is not permitted");
      }

      const cleanSource = String(args.source ?? "latest").trim().toLowerCase();
      if (!ALLOWED_INSTALL_SOURCES.has(cleanSource)) {
        throw new Error('Invalid install source: must be "latest" or "local"');
      }
      const targetHost = validateRequiredHost(args.host, "wizard:install-hub");
      const validHubId = validatePositiveHubId(args.hubId);

      let selectedHubZip = "";
      if (cleanSource === "local") {
        const picked = await pickHubZip(win);
        if (!picked) {
          return {
            ok: false,
            canceled: true,
            source: "local",
          };
        }
        selectedHubZip = String(picked).trim();
      }

      return installFreshHubImpl({
        source: cleanSource,
        hubZipPath: selectedHubZip,
        host: targetHost,
        hubId: validHubId,
        preflightOnly: args.preflightOnly === true,
        removeRootToolLeftovers: args.removeRootToolLeftovers !== false,
        replaceStaleHostKey: args.replaceStaleHostKey === true,
        authHeader: getSavedAuthHeader(),
        userAgent,
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
  pickHubZip,
  userAgent,
  detectAndClassifyImpl,
  runUsbProbeImpl,
  runWizardActionImpl,
  installFreshHubImpl,
} = {}) {
  const handlers = createWizardIpcHandlers({
    getMainWindow,
    getSavedAuthHeader,
    isWizardAvailable,
    pickFirmwareFile,
    pickHubZip,
    userAgent,
    detectAndClassifyImpl,
    runUsbProbeImpl,
    runWizardActionImpl,
    installFreshHubImpl,
  });
  for (const [channel, handler] of Object.entries(handlers)) {
    ipcMain.handle(channel, handler);
  }
  return handlers;
}

module.exports = {
  WIZARD_CHANNELS,
  hasBundledWizardResources,
  isWizardDevAvailable,
  VERDICTS,
  USER_INTENTS,
  REQUIRED_FIRMWARE,
  READONLY_BRIDGE_ACTIONS,
  MUTATING_BRIDGE_ACTIONS,
  ALLOWED_BRIDGE_ACTIONS,
  ALLOWED_USB_BACKENDS,
  ALLOWED_INSTALL_SOURCES,
  DEFAULT_BRIDGE_SCRIPT,
  DEFAULT_INSTALLER_SCRIPT,
  DEFAULT_HELPERS_DIR,
  HUB_ROOT_DIR,
  resolveHubRootDir,
  resolveBridgeScriptPath,
  resolveInstallerPaths,
  resolvePythonExecutable,
  buildIsolatedPythonEnv,
  validatePositiveRemoteId,
  validatePositiveHubId,
  validateInstallerHost,
  validateWifiSsid,
  validateWifiPassword,
  scrubSecretText,
  buildBridgeArgs,
  buildInstallerArgs,
  stageInstallerWorkspace,
  detectHostKeyChanged,
  clearKnownHost,
  runWizardBridge,
  evaluateFirmwareGate,
  evaluateMismatch,
  classifyHubSignals,
  detectAndClassify,
  runUsbProbe,
  runWizardAction,
  installFreshHub,
  createWizardIpcHandlers,
  registerWizardIpcHandlers,
};
