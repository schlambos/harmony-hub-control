"use strict";

// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Matthew Gibbons (Melodious — LICENSE section 2)
//
// Dual-signal hub state classifier for Melodious Root Wizard (Slice 1 + Slice 2).
// Combines SSDP + :8080 (/api/system-status) + :8088 (getProvisionInfo) +
// :5222 (XMPP) + :22 (SSH) + USB HID (preflight /rf/deviceinfo + hbus
// connect.sysinfo?get + setup.account?getProvisionInfo + connect.discoveryinfo?get)
// into one verdict and checks against user intent.

const VERDICTS = Object.freeze({
  FRESH: "fresh",
  PROVISIONED_XMPP_ON: "provisioned-xmpp-on",
  PROVISIONED_LOCAL: "provisioned-local",
  MELODIOUS_INSTALLED: "melodious-installed",
  UNKNOWN: "unknown",
});

const USER_INTENTS = Object.freeze({
  FRESH: "fresh",
  PROVISIONED: "provisioned",
});

const REQUIRED_FIRMWARE = "4.15.600";

function maskHostString(value, mask = true) {
  const s = String(value ?? "").trim();
  if (!s) return "";
  return mask ? "<ip-redacted>" : s;
}

function maskUrlString(value, mask = true) {
  const s = String(value ?? "").trim();
  if (!s || !mask) return s;
  return s.replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "<ip-redacted>");
}

function maskUsnString(value, mask = true) {
  const s = String(value ?? "").trim();
  if (!s || !mask) return s;
  return "<usn-redacted>";
}

function sanitizeSsdpCandidates(candidates, mask = true) {
  if (!Array.isArray(candidates)) return [];
  return candidates.map((c) => ({
    name: mask ? "Hub (<ip-redacted>)" : String(c?.name || `Hub (${c?.host || ""})`),
    host: maskHostString(c?.host, mask),
    webUiPort: Number(c?.webUiPort) || 8080,
    hbusPort: Number(c?.hbusPort) || 8088,
    location: maskUrlString(c?.location, mask),
    st: String(c?.st || ""),
    usn: maskUsnString(c?.usn, mask),
  }));
}

function sanitizeWebUiProbe(probed, mask = true) {
  if (!probed || typeof probed !== "object") {
    return {
      reachable: false,
      authRequired: false,
      firmware: "",
      isSimulated: false,
      host: "",
      port: 8080,
    };
  }
  return {
    reachable: true,
    authRequired: Boolean(probed.authRequired),
    firmware: String(probed.firmware || ""),
    isSimulated: Boolean(probed.isSimulated),
    host: maskHostString(probed.host, mask),
    port: Number(probed.port) || 8080,
  };
}

function evaluateFirmwareGate({ usbSysinfo, usbDiscoveryInfo, webUiProbe } = {}) {
  const fw =
    (usbSysinfo && typeof usbSysinfo.fwVer === "string" && usbSysinfo.fwVer.trim()) ||
    (usbDiscoveryInfo &&
      typeof usbDiscoveryInfo.currentFwVersion === "string" &&
      usbDiscoveryInfo.currentFwVersion.trim()) ||
    (webUiProbe && typeof webUiProbe.firmware === "string" && webUiProbe.firmware.trim()) ||
    "";
  if (!fw) {
    return {
      known: false,
      currentFirmware: "",
      requiredFirmware: REQUIRED_FIRMWARE,
      passes: null,
      message: "Firmware version not yet read (connect over USB or LAN to check for 4.15.600).",
    };
  }
  // Melodious /api/system-status may report "4.15.600 (Melodious 2.0.0)" or "4.15.600"
  const passes = fw === REQUIRED_FIRMWARE || fw.startsWith(`${REQUIRED_FIRMWARE} `);
  return {
    known: true,
    currentFirmware: fw,
    requiredFirmware: REQUIRED_FIRMWARE,
    passes,
    message: passes
      ? `Firmware is ${fw} (matches required ${REQUIRED_FIRMWARE} gate).`
      : `Firmware is ${fw}; the root & hal patch chain requires official signed bundle ${REQUIRED_FIRMWARE}.`,
  };
}

function evaluateMismatch(
  userIntent,
  verdict,
  { webUi8080, provisionInfo8088, usbProvisionInfo } = {}
) {
  const intent = String(userIntent || "").trim().toLowerCase();

  if (verdict === VERDICTS.MELODIOUS_INSTALLED) {
    const fwLabel = webUi8080?.firmware ? ` (${webUi8080.firmware})` : "";
    return {
      hasMismatch: intent === USER_INTENTS.FRESH || intent === USER_INTENTS.PROVISIONED,
      severity: "info",
      title: "Melodious is already installed on this hub",
      message: `Port 8080 responded to /api/system-status${fwLabel}. You do not need to root this hub — connect to it directly or use Settings → Updates to reinstall/update.`,
      recommendedIntent: null,
    };
  }

  const activeProv =
    provisionInfo8088 && provisionInfo8088.ok
      ? provisionInfo8088
      : usbProvisionInfo && usbProvisionInfo.ok
        ? usbProvisionInfo
        : null;

  if (
    activeProv?.ok &&
    activeProv.provisioned &&
    activeProv.remoteIdType === "string"
  ) {
    return {
      hasMismatch: true,
      severity: "warning",
      title: "Provisioned remoteId is a JSON string (WebSocket 401 trap)",
      message:
        "getProvisionInfo reports activeRemoteId as a string rather than a JSON number. The hub's 8088 WebSocket gate uses tonumber() and will reject every handshake with HTTP 401 until preferences are rewritten with a numeric remoteId.",
      recommendedIntent: USER_INTENTS.FRESH,
    };
  }

  if (intent === USER_INTENTS.PROVISIONED && verdict === VERDICTS.FRESH) {
    return {
      hasMismatch: true,
      severity: "warning",
      title: "Mismatch: Hub is unprovisioned / factory-reset",
      message:
        "You selected 'Already provisioned via Logitech cloud', but this hub has no account or Hub ID (mode is unset and XMPP port 5222 is closed). LAN/XMPP rooting cannot work on an unprovisioned hub — switch to the 'Factory-reset / unprovisioned (USB)' flow.",
      recommendedIntent: USER_INTENTS.FRESH,
    };
  }

  if (
    intent === USER_INTENTS.FRESH &&
    (verdict === VERDICTS.PROVISIONED_XMPP_ON || verdict === VERDICTS.PROVISIONED_LOCAL)
  ) {
    const viaLabel =
      verdict === VERDICTS.PROVISIONED_XMPP_ON
        ? "and has XMPP open on port 5222"
        : "with a saved account / Hub ID (mode 3)";
    return {
      hasMismatch: true,
      severity: "warning",
      title: "Mismatch: Hub is currently provisioned",
      message: `You selected 'Factory-reset / unprovisioned', but this hub is already provisioned ${viaLabel}. Continuing the fresh-hub flow will require a destructive factory reset that erases its existing devices, activities, and account binding. To keep its existing setup, switch to the 'Already provisioned' flow.`,
      recommendedIntent: USER_INTENTS.PROVISIONED,
    };
  }

  return {
    hasMismatch: false,
    severity: null,
    title: "",
    message: "",
    recommendedIntent: null,
  };
}

function classifyHubSignals({
  userIntent = "",
  ssdpCandidates = [],
  webUiProbe = null,
  bridgeResult = null,
  mask = true,
} = {}) {
  const ssdpList = sanitizeSsdpCandidates(ssdpCandidates, mask);
  const webUi8080 = sanitizeWebUiProbe(webUiProbe, mask);

  const usb = bridgeResult?.usb || {
    ok: false,
    connected: false,
    deviceCount: 0,
    devices: [],
    device: null,
    preflight: null,
    sysinfo: null,
    provisionInfo: null,
    discoveryInfo: null,
    usbWedge: false,
  };
  const lan = bridgeResult?.lan || {
    ok: false,
    skipped: true,
    provisionInfo: null,
    ports: {},
  };

  const ports = lan.ports && typeof lan.ports === "object" ? lan.ports : {};
  const port8080Open = Boolean(webUi8080.reachable || ports["8080"]);
  const port8088Open = Boolean(lan.provisionInfo?.ok || ports["8088"]);
  const port5222Open = Boolean(ports["5222"]);
  const port22Open = Boolean(ports["22"]);

  const provisionInfo8088 = lan.provisionInfo || null;
  const lanProvisioned =
    provisionInfo8088 && provisionInfo8088.ok ? Boolean(provisionInfo8088.provisioned) : null;

  const usbConnected = Boolean(usb.connected);
  const usbPreflightOk = Boolean(usb.preflight && usb.preflight.ok);
  const usbSysinfoOk = Boolean(usb.sysinfo && usb.sysinfo.ok);
  const usbProvisionInfo = usb.provisionInfo || null;
  const usbDiscoveryInfo = usb.discoveryInfo || null;
  const usbProvisionInfoOk = Boolean(usbProvisionInfo && usbProvisionInfo.ok);
  const usbDiscoveryInfoOk = Boolean(usbDiscoveryInfo && usbDiscoveryInfo.ok);
  const usbHasHubId = Boolean(usb.preflight && usb.preflight.hasHubId);
  const usbWedged = Boolean(usb.usbWedge);

  let usbProvisioned = null;
  if (
    (usbProvisionInfoOk && Boolean(usbProvisionInfo.provisioned)) ||
    (usbDiscoveryInfoOk && Boolean(usbDiscoveryInfo.provisioned)) ||
    usbHasHubId
  ) {
    usbProvisioned = true;
  } else if (
    (usbProvisionInfoOk && !usbProvisionInfo.provisioned) ||
    (usbDiscoveryInfoOk && !usbDiscoveryInfo.provisioned) ||
    (usbConnected && usbPreflightOk && !usbHasHubId)
  ) {
    usbProvisioned = false;
  }

  const effectiveProv =
    provisionInfo8088 && provisionInfo8088.ok
      ? provisionInfo8088
      : usbProvisionInfoOk
        ? usbProvisionInfo
        : usbDiscoveryInfoOk
          ? usbDiscoveryInfo
          : null;

  let verdict = VERDICTS.UNKNOWN;
  let verdictLabel = "Unknown / Unreachable";
  let verdictSummary =
    "Could not gather enough LAN or USB signals to classify this hub. Check that the hub is powered on, settled (~5 minutes after boot), and connected via a data USB cable or on the same LAN.";
  let recommendedNextStep =
    "Connect the hub to this Mac with a data-capable USB cable (or enter its LAN IP address) and run Detect & Classify again.";

  if (port8080Open) {
    verdict = VERDICTS.MELODIOUS_INSTALLED;
    verdictLabel = "Melodious Installed";
    verdictSummary =
      "Melodious web UI is active on port 8080" +
      (port22Open ? " and Dropbear SSH is open on port 22." : ".");
    recommendedNextStep =
      "No root needed. Connect to this hub directly from the Connect screen, or use Settings → Updates to reinstall/repair.";
  } else if (port5222Open && lanProvisioned !== false && usbProvisioned !== false) {
    verdict = VERDICTS.PROVISIONED_XMPP_ON;
    verdictLabel = "Provisioned (XMPP On)";
    verdictSummary =
      "Hub is provisioned and XMPP port 5222 is open on the LAN" +
      (port22Open ? " (SSH port 22 is also already open)." : ".");
    recommendedNextStep = port22Open
      ? "Root SSH (port 22) is already open. Ready for Melodious web UI installation."
      : "Eligible for standard LAN root over XMPP (--action lan-root-xmpp).";
  } else if (lanProvisioned === true || usbProvisioned === true) {
    verdict = VERDICTS.PROVISIONED_LOCAL;
    const isLocal = Boolean(effectiveProv?.isLocalAccountHint);
    const detectedOverUsbOnly = usbProvisioned === true && lanProvisioned !== true;
    verdictLabel = isLocal
      ? "Provisioned (Local Account, XMPP Off)"
      : detectedOverUsbOnly
        ? "Provisioned (Detected over USB, Offline / XMPP Off)"
        : "Provisioned (XMPP Off / Port 5222 Closed)";
    const modeNote = effectiveProv?.mode ? ` (mode ${effectiveProv.mode})` : "";
    verdictSummary =
      `Hub is provisioned${modeNote}` +
      (detectedOverUsbOnly
        ? " (confirmed over USB hbus without LAN/Wi-Fi)"
        : ", but XMPP port 5222 is closed") +
      (port22Open ? " and SSH port 22 is open." : ".");
    if (port22Open) {
      recommendedNextStep =
        "Root SSH (port 22) is already open and the hub has a Hub ID. Ready for Melodious web UI installation.";
    } else if (usbConnected && usbPreflightOk) {
      recommendedNextStep = detectedOverUsbOnly
        ? "Hub is provisioned to an account over USB. Connect it to Wi-Fi (usb-wifi-connect) to root and preserve its setup, or run usb-factory-reset ('1' only) if starting fresh."
        : "XMPP is closed on 5222, but USB HID is connected and responsive. Root over USB (--action usb-root) or enable XMPP on 8088 if cloud-provisioned.";
    } else {
      recommendedNextStep =
        "Connect the hub over USB to root via --action usb-root (locally provisioned hubs keep port 5222 closed), or if cloud-provisioned, enable XMPP in the Harmony app.";
    }
  } else if (lanProvisioned === false || usbProvisioned === false) {
    verdict = VERDICTS.FRESH;
    verdictLabel = "Factory-Reset / Unprovisioned (Fresh Hub)";
    verdictSummary =
      "Hub has no account binding or Hub ID (unprovisioned)" +
      (port8088Open ? ", confirmed on LAN :8088" : "") +
      (usbConnected && usbPreflightOk ? ", confirmed over USB HID." : ".");
    recommendedNextStep = usbConnected && usbPreflightOk
      ? "Ready for the fresh-hub USB activation chain: verify 4.15.600 firmware gate → open TDE gate (usb-tde-enable) → write local mode-3 provisioning (usb-provision-local, numeric remoteId) → seed AutomationConfig (usb-seed-automation) → root over USB (usb-root) → install Melodious."
      : "Connect the hub to this Mac with a data-capable USB cable so the fresh-hub USB activation chain can run.";
  }

  const firmwareGate = evaluateFirmwareGate({
    usbSysinfo: usb.sysinfo,
    usbDiscoveryInfo,
    webUiProbe: webUi8080,
  });

  const usbWedge = {
    wedged: usbWedged,
    message: usbWedged
      ? "USB HID device 046D:C129 enumerated, but LTCP file/hbus communication failed or wedged. Recovery: unplug the hub's USB power cable for 15 seconds, plug it back in, wait ~5 minutes for boot to settle, and run usb-preflight first."
      : "",
  };

  const mismatch = evaluateMismatch(userIntent, verdict, {
    webUi8080,
    provisionInfo8088,
    usbProvisionInfo,
    usbDiscoveryInfo,
  });

  return {
    verdict,
    verdictLabel,
    verdictSummary,
    userIntent: String(userIntent || ""),
    mismatch,
    firmwareGate,
    usbWedge,
    recommendedNextStep,
    masked: Boolean(mask),
    signals: {
      ssdp: {
        found: ssdpList.length > 0,
        candidateCount: ssdpList.length,
        candidates: ssdpList,
      },
      lan: {
        host: lan.host || webUi8080.host || (ssdpList[0]?.host ?? ""),
        ports: {
          8080: port8080Open,
          8088: port8088Open,
          5222: port5222Open,
          22: port22Open,
        },
        webUi8080,
        provisionInfo8088,
      },
      usb: {
        connected: usbConnected,
        deviceCount: Number(usb.deviceCount) || 0,
        device: usb.device || null,
        preflightOk: usbPreflightOk,
        preflight: usb.preflight || null,
        sysinfoOk: usbSysinfoOk,
        sysinfo: usb.sysinfo || null,
        provisionInfoOk: usbProvisionInfoOk,
        provisionInfo: usbProvisionInfo,
        discoveryInfoOk: usbDiscoveryInfoOk,
        discoveryInfo: usbDiscoveryInfo,
        provisioned: usbProvisioned,
        usbWedge: usbWedged,
        error: usb.error || null,
      },
    },
  };
}

module.exports = {
  VERDICTS,
  USER_INTENTS,
  REQUIRED_FIRMWARE,
  evaluateFirmwareGate,
  evaluateMismatch,
  classifyHubSignals,
};
