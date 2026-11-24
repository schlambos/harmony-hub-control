"use strict";

// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Matthew Gibbons (Melodious — LICENSE section 2)
//
// Plain-English step-by-step Hub Setup Wizard UI model and renderer.
// Shared between connect/connect.js (via scheme.js inline bundle) and Node unit tests.

(function initMelodiousRootWizardFlow(globalScope) {
  const SETUP_ICON_SVG =
    '<svg class="ic" width="24" height="24" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.49.49 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.48.48 0 0 0-.48-.41h-3.84a.48.48 0 0 0-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96a.49.49 0 0 0-.59.22L2.74 8.87a.48.48 0 0 0 .12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6A3.6 3.6 0 1 1 12 8.4a3.6 3.6 0 0 1 0 7.2z"/></svg>';

  const CHECK_ICON_SVG =
    '<svg class="ic" width="24" height="24" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>';

  const CHEVRON_SVG =
    '<svg class="ic m-row-chevron" width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M10 6 8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/></svg>';

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
    );
  }

  function suggestNumericRemoteId(seedNumber) {
    if (
      typeof seedNumber === "number" &&
      Number.isSafeInteger(seedNumber) &&
      seedNumber >= 1000 &&
      seedNumber <= 9999
    ) {
      return String(20260000 + seedNumber);
    }
    const suffix = Math.floor(1000 + Math.random() * 8999);
    return String(20260000 + suffix);
  }

  function parsePositiveIntInput(rawValue) {
    const s = String(rawValue ?? "").trim();
    if (!/^[1-9]\d*$/.test(s)) return null;
    const n = Number(s);
    if (!Number.isSafeInteger(n) || n <= 0) return null;
    return n;
  }

  function isUnmaskedHost(rawHost) {
    const s = String(rawHost ?? "").trim();
    if (!s || s.startsWith("<") || s === "none" || /\s/.test(s)) return false;
    return true;
  }

  function extractDetectedHost(classifyResult) {
    if (!classifyResult || typeof classifyResult !== "object") return "";
    const lanHost = classifyResult.signals?.lan?.host;
    if (isUnmaskedHost(lanHost) && String(lanHost).trim() !== "0.0.0.0") {
      return String(lanHost).trim();
    }
    const usbIp = classifyResult.signals?.usb?.discoveryInfo?.ip;
    if (isUnmaskedHost(usbIp) && String(usbIp).trim() !== "0.0.0.0") {
      return String(usbIp).trim();
    }
    const usbConnected = Boolean(classifyResult.signals?.usb?.connected);
    const candidates = classifyResult.signals?.ssdp?.candidates;
    if (!usbConnected && Array.isArray(candidates) && candidates.length === 1) {
      const ssdpOnly = candidates[0]?.host;
      if (isUnmaskedHost(ssdpOnly)) return String(ssdpOnly).trim();
    }
    return "";
  }

  function extractDetectedNumericHubId(classifyResult) {
    if (!classifyResult || typeof classifyResult !== "object") return null;
    const lanProv = classifyResult.signals?.lan?.provisionInfo8088;
    const usbProv = classifyResult.signals?.usb?.provisionInfo;
    const usbPre = classifyResult.signals?.usb?.preflight;
    const candidates = [
      lanProv?.activeRemoteId,
      usbProv?.activeRemoteId,
      usbPre?.hubId,
    ];
    for (const cand of candidates) {
      if (typeof cand === "number" && Number.isSafeInteger(cand) && cand > 0) {
        return cand;
      }
      const parsed = parsePositiveIntInput(cand);
      if (parsed !== null) return parsed;
    }
    return null;
  }

  function deriveRecommendedPath(classifyResult, fallbackIntent = "fresh") {
    const fallback = fallbackIntent === "provisioned" ? "provisioned" : "fresh";
    if (!classifyResult || typeof classifyResult !== "object") return fallback;
    if (classifyResult.mismatch?.recommendedIntent === "fresh") return "fresh";
    if (classifyResult.mismatch?.recommendedIntent === "provisioned") return "provisioned";
    const v = classifyResult.verdict;
    if (v === "provisioned-xmpp-on" || v === "provisioned-local") return "provisioned";
    if (v === "fresh") return "fresh";
    return fallback;
  }

  function formatWifiSecurityLabel(rawEnc) {
    const upper = String(rawEnc || "WPA2-PSK").trim().toUpperCase();
    if (!upper || upper === "NONE" || upper === "OPEN") return "Open";
    if (upper.includes("WPA3")) return "WPA3";
    if (upper.includes("WPA2")) return "WPA2";
    if (upper.includes("WPA")) return "WPA";
    if (upper.includes("WEP")) return "WEP";
    return "Secured";
  }

  function formatWifiSignalLabel(rawSignal) {
    if (rawSignal === null || rawSignal === undefined || rawSignal === "") return "";
    const num = Number(rawSignal);
    if (!Number.isFinite(num)) {
      const lower = String(rawSignal).trim().toLowerCase();
      if (lower === "strong" || lower === "good" || lower === "fair") {
        return lower.charAt(0).toUpperCase() + lower.slice(1);
      }
      return "";
    }
    if (num < 0) {
      if (num >= -60) return "Strong";
      if (num >= -75) return "Good";
      return "Fair";
    }
    if (num <= 0) return "";
    if (num >= 180) return "Strong";
    if (num >= 120) return "Good";
    return "Fair";
  }

  function createInitialWizardState(seedNumber) {
    const defaultRemoteId = suggestNumericRemoteId(seedNumber);
    return {
      open: false,
      firstRunOob: false,
      returnMode: "connect",
      step: 1, // 1: Find Your Hub, 2: Connect Wi-Fi (Fresh), 3: Install Melodious, 4: Done
      subScreen: null, // null | "factory-reset" | "firmware-update"
      troubleshootingOpen: false,
      ipDisclosureOpen: false,
      advancedOpen: false,
      showTechDetails: false,
      intent: "fresh", // "fresh" | "provisioned"
      flowPath: "fresh", // "fresh" | "provisioned"
      provisionedTransport: "lan", // "lan" | "usb"
      hostInput: "",
      confirmedHost: "",
      maskIds: false,
      includeUsb: true,
      busy: false,
      busyAction: "",
      stepText: "",
      error: "",
      logLines: [],
      classifyResult: null,
      usbWedgeActive: false,
      usbWedgeMessage: "",
      factoryResetSent: false,
      factoryResetGuidance: "",
      // Fresh-hub progress
      firmwarePassed: false,
      wifiNetworks: [],
      wifiScanned: false,
      wifiSsid: "",
      wifiEncryption: "WPA2-PSK",
      wifiPassword: "",
      wifiConnected: false,
      wifiIpDetectFailed: false,
      remoteIdInput: defaultRemoteId,
      hubNameInput: "Harmony Hub",
      accountIdInput: "",
      tdeDone: false,
      provisionLocalDone: false,
      seedAutomationDone: false,
      // Shared Root & Install progress
      provHubIdInput: "",
      sshOpen: false,
      didRootInSession: false,
      installSource: "latest", // "latest" | "local"
      installedVersion: "",
      preflightPassed: false,
      installDone: false,
      installRunning: false,
      installChecklistStep: 0,
      installChecklistFailedStep: 0,
      // Screen 4 (Done) handoff state
      handoffConnected: false,
      handoffHost: "",
      handoffPort: 8080,
      handoffFirmware: "",
      handoffError: "",
      // Troubleshooting tools state
      allowUnprovenPost: false,
      lastManualOutcome: null,
    };
  }

  function computeFreshChecklistStatus(wiz) {
    const fwDone = Boolean(
      wiz.firmwarePassed || wiz.classifyResult?.firmwareGate?.passes === true
    );
    const activeHost = (wiz.confirmedHost || wiz.hostInput).trim();
    const wifiDone = Boolean(wiz.wifiConnected && isUnmaskedHost(activeHost));
    const prepDone = Boolean(
      wiz.tdeDone && wiz.provisionLocalDone && wiz.seedAutomationDone
    );
    const installDone = Boolean(wiz.installDone);

    let currentStage = 1;
    if (fwDone && !wifiDone) currentStage = 2;
    else if (fwDone && wifiDone && !prepDone) currentStage = 3;
    else if (fwDone && wifiDone && prepDone && !installDone) currentStage = 4;
    else if (fwDone && wifiDone && prepDone && installDone) currentStage = 5;

    return {
      fwDone,
      wifiDone,
      prepDone,
      installDone,
      currentStage,
    };
  }

  function computeProvisionedChecklistStatus(wiz) {
    const port22 = Boolean(
      wiz.sshOpen || wiz.classifyResult?.signals?.lan?.ports?.["22"]
    );
    const port5222 = Boolean(wiz.classifyResult?.signals?.lan?.ports?.["5222"]);
    const usbReady = Boolean(
      wiz.classifyResult?.signals?.usb?.connected &&
        wiz.classifyResult?.signals?.usb?.preflightOk
    );
    const installDone = Boolean(wiz.installDone);
    return {
      port22,
      port5222,
      usbReady,
      rootDone: port22,
      installDone,
    };
  }

  function computeInstallChecklistItems(wiz) {
    const isProv = wiz.flowPath === "provisioned";
    const prepDone = isProv
      ? wiz.installRunning || wiz.sshOpen || wiz.installDone || wiz.installChecklistStep > 1 || wiz.installChecklistFailedStep > 1
      : Boolean(wiz.tdeDone && wiz.provisionLocalDone && wiz.seedAutomationDone);
    const accessDone = Boolean(wiz.sshOpen || wiz.installDone);
    const installDone = Boolean(wiz.installDone);
    const handoffDone = Boolean(wiz.installDone && wiz.step >= 4);

    const activeStep = wiz.busy ? wiz.installChecklistStep : 0;
    const failedStep = !wiz.busy ? wiz.installChecklistFailedStep : 0;

    const defs = [
      { step: 1, label: "Preparing hub for offline use…", done: prepDone },
      { step: 2, label: "Setting up local hub access…", done: accessDone },
      { step: 3, label: "Downloading and installing Melodious…", done: installDone },
      { step: 4, label: "Restarting hub and checking connection…", done: handoffDone },
    ];

    return defs.map((item) => {
      let status = "pending";
      if (failedStep === item.step) status = "error";
      else if (activeStep === item.step) status = "active";
      else if (item.done || (activeStep > item.step && failedStep === 0)) status = "done";
      return {
        step: item.step,
        label: item.label,
        status,
      };
    });
  }

  function renderWizardConnectEntry({ disabled = false } = {}) {
    return `
      <button type="button" class="setup-entry-card" id="openWizardConnectBtn" ${disabled ? "disabled" : ""}>
        <span class="m-tile m-tile--hub" style="--tile:44px">${SETUP_ICON_SVG}</span>
        <span class="m-row-text">
          <span class="m-row-title">Set up a new or unrooted Harmony Hub</span>
          <span class="m-row-sub">Step-by-step setup over USB or Wi-Fi — no Logitech account needed.</span>
        </span>
        ${CHEVRON_SVG}
      </button>
    `;
  }

  function renderWizardSettingsEntry({ disabled = false } = {}) {
    return `
      <h3 class="m-section">Hub setup</h3>
      <button type="button" class="setup-entry-card" id="openWizardSettingsBtn" ${disabled ? "disabled" : ""}>
        <span class="m-tile m-tile--hub" style="--tile:44px">${SETUP_ICON_SVG}</span>
        <span class="m-row-text">
          <span class="m-row-title">Set up or re-root a hub</span>
          <span class="m-row-sub">Step-by-step setup for new, factory-reset, or replacement Harmony Hubs.</span>
        </span>
        ${CHEVRON_SVG}
      </button>
    `;
  }

  function renderPill(label, variant = "") {
    const cls = variant ? `setup-pill ${variant}` : "setup-pill";
    return `<span class="${cls}">${escapeHtml(label)}</span>`;
  }

  function renderWedgeBanner(wiz) {
    const wedged = Boolean(
      wiz.usbWedgeActive || wiz.classifyResult?.usbWedge?.wedged
    );
    if (!wedged) return "";
    return `
      <div class="notice notice-error" id="wizardUsbWedgeBanner" role="alert" style="margin-bottom:var(--space-3)">
        <div style="font-weight:600;margin-bottom:6px">Your hub needs a 15-second power reset</div>
        <div style="margin-bottom:6px">The USB connection stopped responding. Follow these quick steps to reset it:</div>
        <ol style="padding-left:20px;list-style:decimal;display:grid;gap:4px;font-size:var(--fs-body-sm)">
          <li>Unplug the USB cable from your computer and wait <strong>15 seconds</strong>.</li>
          <li>Plug it back in and wait <strong>about 3 minutes</strong> for the blinking light to settle.</li>
          <li>Click <strong>Try Again</strong> or <strong>Find My Hub</strong>.</li>
        </ol>
      </div>
    `;
  }

  function renderProgressHeader(step) {
    const items = [
      { num: 1, label: "Step 1" },
      { num: 2, label: "Step 2" },
      { num: 3, label: "Step 3" },
      { num: 4, label: "Done" },
    ];
    return `
      <div class="setup-progress-header" id="wizardProgressHeader" aria-label="Setup progress">
        ${items
          .map((item) => {
            const isDone = step > item.num || (item.num === 4 && step >= 4);
            const isCurrent = step === item.num && item.num < 4;
            const cls = isDone ? "is-done" : isCurrent ? "is-current" : "";
            return `
              <div class="setup-progress-step ${cls}" data-wiz-step="${item.num}">
                <div class="setup-progress-bar"></div>
                <span class="setup-progress-label">${escapeHtml(item.label)}</span>
              </div>
            `;
          })
          .join("")}
      </div>
    `;
  }

  function renderTechDetailsBlock(wiz) {
    const hasDetails = Boolean(wiz.error || wiz.logLines.length > 0);
    if (!hasDetails) return "";
    return `
      <div style="margin-top:var(--space-2)">
        <button type="button" class="setup-muted-link" id="wizardToggleTechDetailsBtn" style="padding-left:0">
          ${wiz.showTechDetails ? "Hide technical details" : "Show technical details"}
        </button>
        ${
          wiz.showTechDetails
            ? `<div id="wizardTechDetailsPanel" style="margin-top:var(--space-2);display:grid;gap:var(--space-2)">
                 <div class="setup-log" id="wizardProgressLog">${escapeHtml(
                   [wiz.error ? `Error: ${wiz.error}` : "", ...wiz.logLines.slice(-60)]
                     .filter(Boolean)
                     .join("\n")
                 )}</div>
                 <div>
                   <button type="button" class="btn btn-outlined btn-sm" id="wizardCopyLogBtn">Copy log</button>
                 </div>
               </div>`
            : ""
        }
      </div>
    `;
  }

  function renderFooterLink() {
    return `
      <div class="setup-footer-links">
        <button type="button" class="setup-muted-link" id="wizardOpenTroubleshootingBtn">
          Troubleshooting tools
        </button>
      </div>
    `;
  }

  function classifyScreen1Outcome(wiz) {
    const r = wiz.classifyResult;
    if (!r) return null;

    const detectedHost = extractDetectedHost(r) || wiz.confirmedHost.trim() || wiz.hostInput.trim();
    const usbReady = Boolean(r.signals?.usb?.connected && r.signals?.usb?.preflightOk);
    const port22 = Boolean(r.signals?.lan?.ports?.["22"]);
    const fwNeedsUpdate = r.firmwareGate?.passes === false && !wiz.firmwarePassed;

    // 1. Already running Melodious
    if (r.verdict === "melodious-installed") {
      return { kind: "melodious-installed", detectedHost };
    }

    // 2. Mismatch: user picked Fresh, hub still has an old setup
    if (
      wiz.intent === "fresh" &&
      (r.verdict === "provisioned-xmpp-on" || r.verdict === "provisioned-local")
    ) {
      return { kind: "mismatch-has-old-setup", detectedHost };
    }

    // 3. Mismatch: user picked Provisioned, hub is actually Fresh
    if (wiz.intent === "provisioned" && r.verdict === "fresh") {
      return { kind: "mismatch-is-fresh", detectedHost, usbReady, fwNeedsUpdate };
    }

    // 4. Older firmware (< 4.15.600) — ONLY shown when firmware is < 4.15.600
    if (fwNeedsUpdate) {
      return {
        kind: "firmware-needed",
        currentFirmware: r.firmwareGate?.currentFirmware || "",
      };
    }

    // 5. Fresh hub
    if (r.verdict === "fresh") {
      if (usbReady) {
        return { kind: "fresh-usb-ready", detectedHost };
      }
      return { kind: "fresh-needs-usb" };
    }

    // 6. Provisioned & XMPP open (or SSH already open)
    if (r.verdict === "provisioned-xmpp-on" || (r.verdict === "provisioned-local" && port22)) {
      return { kind: "provisioned-ready", detectedHost };
    }

    // 7. Provisioned, XMPP closed
    if (r.verdict === "provisioned-local") {
      // Special case: old setup has non-numeric ID that needs offline refresh
      if (r.mismatch?.recommendedIntent === "fresh") {
        return { kind: "mismatch-has-old-setup", detectedHost };
      }
      return { kind: "provisioned-xmpp-closed", detectedHost, usbReady };
    }

    // 8. Not found / unknown
    return { kind: "not-found" };
  }

  function renderScreen1StatusCard(wiz, outcome) {
    if (!outcome) return "";

    if (outcome.kind === "melodious-installed") {
      return `
        <div class="setup-status-card is-ready" id="wizardResultCard">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:var(--space-2)">
            <strong style="font-size:var(--fs-body-lg)" id="wizardVerdictTitle">Melodious is already installed on this hub</strong>
            ${renderPill("Ready", "is-done")}
          </div>
          <p class="muted" style="margin:0;font-size:var(--fs-body-sm)">
            Your hub is ready to use${outcome.detectedHost ? ` at ${escapeHtml(outcome.detectedHost)}` : ""} — no setup needed.
          </p>
          <div style="display:flex;align-items:center;justify-content:space-between;gap:var(--space-2);flex-wrap:wrap;margin-top:var(--space-1)">
            <button type="button" class="btn btn-text btn-sm" id="wizardStartFreshBtn" ${wiz.busy ? "disabled" : ""}>
              Erase &amp; set up from scratch…
            </button>
            <button type="button" class="btn btn-filled" id="wizardSkipToStep3Btn" ${wiz.busy ? "disabled" : ""}>
              Open Melodious →
            </button>
          </div>
        </div>
      `;
    }

    if (outcome.kind === "mismatch-has-old-setup") {
      return `
        <div class="setup-status-card is-warn" id="wizardResultCard">
          <div id="wizardMismatchBanner" style="display:grid;gap:var(--space-3)">
            <div style="display:flex;align-items:center;justify-content:space-between;gap:var(--space-2)">
              <strong style="font-size:var(--fs-body-lg)">Old setup found on this hub</strong>
              ${renderPill("Action needed", "is-warn")}
            </div>
            <p class="muted" style="margin:0;font-size:var(--fs-body-sm)">
              This hub still has an old setup on it. You can keep that setup or erase it to start fresh.
            </p>
            <div style="display:flex;gap:var(--space-2);flex-wrap:wrap;justify-content:flex-end">
              <button type="button" class="btn btn-outlined" id="wizardEraseAndStartFreshBtn" ${wiz.busy ? "disabled" : ""}>
                Erase Hub &amp; Start Fresh
              </button>
              <button type="button" class="btn btn-filled" id="wizardKeepExistingBtn" ${wiz.busy ? "disabled" : ""}>
                Keep Existing Setup
              </button>
            </div>
          </div>
        </div>
      `;
    }

    if (outcome.kind === "mismatch-is-fresh") {
      return `
        <div class="setup-status-card is-warn" id="wizardResultCard">
          <div id="wizardMismatchBanner" style="display:grid;gap:var(--space-3)">
            <div style="display:flex;align-items:center;justify-content:space-between;gap:var(--space-2)">
              <strong style="font-size:var(--fs-body-lg)">This hub doesn't have an existing setup</strong>
              ${renderPill("New / reset hub", "is-active")}
            </div>
            <p class="muted" style="margin:0;font-size:var(--fs-body-sm)">
              It looks like a brand-new or factory-reset hub. You can set it up offline over USB with no Logitech account.
            </p>
            <div style="display:flex;justify-content:flex-end">
              <button type="button" class="btn btn-filled" id="wizardSwitchIntentBtn" data-recommended-intent="fresh" ${wiz.busy ? "disabled" : ""}>
                Continue →
              </button>
            </div>
          </div>
        </div>
      `;
    }

    if (outcome.kind === "firmware-needed") {
      return `
        <div class="setup-status-card is-warn" id="wizardResultCard">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:var(--space-2)">
            <strong style="font-size:var(--fs-body-lg)" id="wizardVerdictTitle">Software update needed before setup</strong>
            ${renderPill("Update needed", "is-warn")}
          </div>
          <p class="muted" style="margin:0;font-size:var(--fs-body-sm)">
            Your hub${outcome.currentFirmware ? ` is on version ${escapeHtml(outcome.currentFirmware)} and` : ""} needs Harmony software 4.15.600 before Melodious can be installed.
          </p>
          <div style="display:flex;justify-content:flex-end">
            <button type="button" class="btn btn-filled" id="wizardToFirmwareUpdateBtn" ${wiz.busy ? "disabled" : ""}>
              Continue to Update →
            </button>
          </div>
        </div>
      `;
    }

    if (outcome.kind === "fresh-usb-ready") {
      return `
        <div class="setup-status-card is-ready" id="wizardResultCard">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:var(--space-2)">
            <strong style="font-size:var(--fs-body-lg)" id="wizardVerdictTitle">Harmony Hub found over USB and ready for setup</strong>
            ${renderPill("Ready", "is-done")}
          </div>
          <p class="muted" style="margin:0;font-size:var(--fs-body-sm)">
            Connected to this computer and ready to join your Wi-Fi.
          </p>
          <div style="display:flex;justify-content:flex-end">
            <button type="button" class="btn btn-filled" id="wizardToStep2Btn" data-next-branch="fresh" ${wiz.busy ? "disabled" : ""}>
              Continue →
            </button>
          </div>
        </div>
      `;
    }

    if (outcome.kind === "fresh-needs-usb") {
      return `
        <div class="setup-status-card is-warn" id="wizardResultCard">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:var(--space-2)">
            <strong style="font-size:var(--fs-body-lg)" id="wizardVerdictTitle">Plug your hub into this computer with a USB cable</strong>
            ${renderPill("USB cable needed", "is-warn")}
          </div>
          <p class="muted" style="margin:0;font-size:var(--fs-body-sm)">
            A new or factory-reset hub needs a micro-USB data cable for initial setup (many charging cables only carry power). Plug it into this computer, wait for the light to settle, and check again.
          </p>
          <div style="display:flex;justify-content:flex-end">
            <button type="button" class="btn btn-filled" id="wizardRecheckBtn" ${wiz.busy ? "disabled" : ""}>
              Check Again
            </button>
          </div>
        </div>
      `;
    }

    if (outcome.kind === "provisioned-ready") {
      return `
        <div class="setup-status-card is-ready" id="wizardResultCard">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:var(--space-2)">
            <strong style="font-size:var(--fs-body-lg)" id="wizardVerdictTitle">Harmony Hub found on Wi-Fi and ready</strong>
            ${renderPill("Ready", "is-done")}
          </div>
          <p class="muted" style="margin:0;font-size:var(--fs-body-sm)">
            Your existing devices and activities will be kept${outcome.detectedHost ? ` (${escapeHtml(outcome.detectedHost)})` : ""}.
          </p>
          <div style="display:flex;justify-content:flex-end">
            <button type="button" class="btn btn-filled" id="wizardToStep2Btn" data-next-branch="provisioned" ${wiz.busy ? "disabled" : ""}>
              Continue →
            </button>
          </div>
        </div>
      `;
    }

    if (outcome.kind === "provisioned-xmpp-closed") {
      return `
        <div class="setup-status-card is-warn" id="wizardResultCard">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:var(--space-2)">
            <strong style="font-size:var(--fs-body-lg)" id="wizardVerdictTitle">Turn on local access in the Harmony app</strong>
            ${renderPill("One step needed", "is-warn")}
          </div>
          <ol style="margin:0;padding-left:20px;list-style:decimal;display:grid;gap:6px;font-size:var(--fs-body-sm);color:var(--on-surface-variant)">
            <li>Open the <strong>Harmony app</strong> on your phone.</li>
            <li>Go to <strong>Menu → Harmony Setup → Remote &amp; Hub → Enable XMPP</strong>.</li>
            <li>Confirm in the app, then click <strong>Check Again</strong> below.</li>
          </ol>
          <div style="display:flex;gap:var(--space-2);flex-wrap:wrap;justify-content:flex-end;margin-top:var(--space-1)">
            <button type="button" class="btn btn-tonal" id="wizardUseUsbInsteadBtn" ${wiz.busy ? "disabled" : ""}>
              Set Up Over USB Instead
            </button>
            <button type="button" class="btn btn-filled" id="wizardRecheckBtn" ${wiz.busy ? "disabled" : ""}>
              Check Again
            </button>
          </div>
        </div>
      `;
    }

    return `
      <div class="setup-status-card" id="wizardResultCard">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:var(--space-2)">
          <strong style="font-size:var(--fs-body-lg)" id="wizardVerdictTitle">Couldn't find your Harmony Hub yet</strong>
          ${renderPill("Not found", "is-err")}
        </div>
        <ul style="margin:0;padding-left:20px;list-style:disc;display:grid;gap:6px;font-size:var(--fs-body-sm);color:var(--on-surface-variant)">
          <li>Make sure the hub has power and wait about 2–3 minutes if it just started up.</li>
          <li>If plugged into this computer, try another micro-USB cable (charging-only cables don't carry data).</li>
          <li>If your hub is already on Wi-Fi, open <strong>Can't find it? Enter IP address</strong> above.</li>
        </ul>
      </div>
    `;
  }

  function renderScreen1Detect(wiz) {
    const outcome = classifyScreen1Outcome(wiz);
    const hasActionableOutcome = Boolean(outcome && outcome.kind !== "not-found");
    const detectBtnClass = hasActionableOutcome ? "btn btn-tonal" : "btn btn-filled btn-block";
    const ipOpen = Boolean(wiz.ipDisclosureOpen || wiz.hostInput.trim());

    return `
      <div class="wiz-intro">
        <h2>${wiz.firstRunOob ? "Welcome to Melodious" : "Set up your Harmony Hub"}</h2>
          <p>${wiz.firstRunOob ? "Let's set up your Harmony Hub. Plug it into this computer with a USB cable, or make sure it's on your Wi-Fi." : "Plug your hub into this computer with a micro-USB data cable (or make sure it's on your Wi-Fi)."}</p>
      </div>

      ${renderWedgeBanner(wiz)}

      <div class="setup-focus-card" id="wizardStep1Controls">
        <fieldset class="wiz-choices">
          <legend class="sr-only" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)">How is your Harmony Hub set up?</legend>
          <label class="setup-wiz-choice ${wiz.intent === "provisioned" ? "is-selected" : ""}" id="wizardIntentProvisionedLabel">
            <input type="radio" name="wizardIntent" id="wizardIntentProvisioned" value="provisioned" ${wiz.intent === "provisioned" ? "checked" : ""} ${wiz.busy ? "disabled" : ""}>
            <span class="wiz-choice-text">
              <strong style="display:block;font-size:var(--fs-body-lg)">Already set up in the Harmony app</strong>
              <span class="muted" style="font-size:var(--fs-body-sm)">Keep your existing devices and activities.</span>
            </span>
          </label>
          <label class="setup-wiz-choice ${wiz.intent === "fresh" ? "is-selected" : ""}" id="wizardIntentFreshLabel">
            <input type="radio" name="wizardIntent" id="wizardIntentFresh" value="fresh" ${wiz.intent === "fresh" ? "checked" : ""} ${wiz.busy ? "disabled" : ""}>
            <span class="wiz-choice-text">
              <strong style="display:block;font-size:var(--fs-body-lg)">Brand new, factory reset, or bought used</strong>
              <span class="muted" style="font-size:var(--fs-body-sm)">Set it up offline with no Logitech account.</span>
            </span>
          </label>
        </fieldset>

        <details class="setup-disclosure" id="wizardIpDisclosure" ${ipOpen ? "open" : ""}>
          <summary>Can't find it? Enter IP address</summary>
          <div class="setup-disclosure-body">
            <div class="m-field">
              <label for="wizardHostInput">Hub IP address</label>
              <input id="wizardHostInput" type="text" autocomplete="off" spellcheck="false" placeholder="e.g. 192.168.1.50" value="${escapeHtml(wiz.hostInput)}" ${wiz.busy ? "disabled" : ""}>
            </div>
          </div>
        </details>

        ${
          wiz.error
            ? `<div class="notice notice-error" id="wizardErrorNotice" role="alert">
                 <div>Couldn't check your hub right now. Make sure it's powered on and try again.</div>
                 ${renderTechDetailsBlock(wiz)}
               </div>`
            : ""
        }

        <div style="display:flex;justify-content:flex-end">
          <button type="button" class="${detectBtnClass}" id="wizardDetectBtn" ${wiz.busy ? "disabled" : ""}>
            ${wiz.busy && wiz.busyAction === "detect" ? '<span class="m-spinner" style="border-color:currentColor;border-right-color:transparent" aria-hidden="true"></span>' : ""}
            <span>${wiz.busy && wiz.busyAction === "detect" ? "Finding your hub…" : "Find My Hub"}</span>
          </button>
        </div>

        ${
          wiz.firstRunOob
            ? `<button type="button" class="btn btn-outlined btn-block" id="wizardUseExistingConnectBtn" ${wiz.busy ? "disabled" : ""}>
                 My hub already runs Melodious — Connect →
               </button>`
            : ""
        }
      </div>

      ${renderScreen1StatusCard(wiz, outcome)}
    `;
  }

  function renderFactoryResetSubScreen(wiz) {
    if (wiz.factoryResetSent) {
      return `
        <div class="wiz-intro">
          <h2>Finish restarting your hub</h2>
          <p>Your hub has been erased. Complete these two steps so your computer can reconnect to it:</p>
        </div>

        <div class="setup-focus-card" id="wizardResetRecoveryNotice">
          <ol style="margin:0;padding-left:22px;list-style:decimal;display:grid;gap:var(--space-3);font-size:var(--fs-body)">
            <li><strong>Unplug the USB cable from your computer for 15 seconds.</strong> (Wait until the fast blinking red light stops first.)</li>
            <li><strong>Plug it back in, wait ~3 minutes for the blinking red light to settle, then click Check Hub.</strong></li>
          </ol>

          <div style="display:flex;justify-content:flex-end;margin-top:var(--space-2)">
            <button type="button" class="btn btn-filled" id="wizardPostResetCheckBtn" ${wiz.busy ? "disabled" : ""}>
              ${wiz.busy ? '<span class="m-spinner" style="border-color:var(--on-primary);border-right-color:transparent" aria-hidden="true"></span>' : ""}
              <span>${wiz.busy ? "Checking hub…" : "Check Hub"}</span>
            </button>
          </div>
        </div>
      `;
    }

    return `
      <div class="wiz-intro">
        <h2>Erase hub and start fresh</h2>
        <p>Keep your hub plugged into this computer with a micro-USB data cable.</p>
      </div>

      ${renderWedgeBanner(wiz)}

      <div class="setup-focus-card" id="wizardFactoryResetScreen">
        <div style="display:grid;gap:var(--space-2);font-size:var(--fs-body-sm);color:var(--on-surface-variant)">
          <p style="margin:0;color:var(--on-surface);font-size:var(--fs-body)">
            Erasing this hub removes its old Logitech account, saved devices, activities, and Wi-Fi settings so you can set it up from scratch.
          </p>
          <p style="margin:0">
            Your Harmony remote is safe — you can pair it again right after setup finishes.
          </p>
        </div>

        ${
          wiz.error
            ? `<div class="notice notice-error" id="wizardErrorNotice" role="alert">
                 <div>Couldn't erase the hub over USB. Check that a micro-USB data cable is connected to this computer and try again.</div>
                 ${renderTechDetailsBlock(wiz)}
               </div>`
            : ""
        }

        <div style="display:flex;align-items:center;justify-content:space-between;gap:var(--space-2);flex-wrap:wrap">
          <button type="button" class="btn btn-outlined" id="wizardSubScreenBackBtn" ${wiz.busy ? "disabled" : ""}>
            ← Back
          </button>
          <button type="button" class="btn btn-danger" id="wizardConfirmFactoryResetBtn" ${wiz.busy ? "disabled" : ""}>
            ${wiz.busy && wiz.busyAction === "usb-factory-reset" ? '<span class="m-spinner" aria-hidden="true"></span>' : ""}
            <span>${wiz.busy && wiz.busyAction === "usb-factory-reset" ? "Erasing hub…" : "Erase Hub"}</span>
          </button>
        </div>
      </div>
    `;
  }

  function renderFirmwareUpdateSubScreen(wiz) {
    const currentFw = wiz.classifyResult?.firmwareGate?.currentFirmware || "";
    return `
      <div class="wiz-intro">
        <h2>Software update needed before setup</h2>
        <p>Melodious needs Harmony Hub software version 4.15.600 so offline setup and local control work reliably.</p>
      </div>

      ${renderWedgeBanner(wiz)}

      <div class="setup-focus-card" id="wizardFirmwareUpdateScreen">
        <div style="display:grid;gap:var(--space-2);font-size:var(--fs-body-sm);color:var(--on-surface-variant)">
          <p style="margin:0;color:var(--on-surface);font-size:var(--fs-body)">
            ${currentFw ? `This hub currently has version ${escapeHtml(currentFw)}. ` : ""}Choose your official 4.15.600 update file (<code>.hfw2</code>) on this computer to update it over USB.
          </p>
          <p style="margin:0">
            The update takes about 2–3 minutes and restarts the hub automatically. Keep the USB cable plugged in until it finishes.
          </p>
        </div>

        ${
          wiz.error
            ? `<div class="notice notice-error" id="wizardErrorNotice" role="alert">
                 <div>The software update didn't finish. Make sure you chose a matching 4.15.600 .hfw2 file and keep the USB cable connected.</div>
                 ${renderTechDetailsBlock(wiz)}
               </div>`
            : ""
        }

        <div style="display:flex;align-items:center;justify-content:space-between;gap:var(--space-2);flex-wrap:wrap">
          <button type="button" class="btn btn-outlined" id="wizardSubScreenBackBtn" ${wiz.busy ? "disabled" : ""}>
            ← Back
          </button>
          <button type="button" class="btn btn-filled" id="freshFlashFirmwareBtn" ${wiz.busy ? "disabled" : ""}>
            ${wiz.busy && wiz.busyAction === "usb-flash-firmware" ? '<span class="m-spinner" style="border-color:var(--on-primary);border-right-color:transparent" aria-hidden="true"></span>' : ""}
            <span>${wiz.busy && wiz.busyAction === "usb-flash-firmware" ? "Updating hub software…" : "Choose Update File (.hfw2)…"}</span>
          </button>
        </div>
      </div>
    `;
  }

  function renderScreen2Wifi(wiz) {
    const activeHost = (wiz.confirmedHost || wiz.hostInput).trim();
    const hasConfirmedIp = isUnmaskedHost(activeHost);
    const connectedReady = Boolean(wiz.wifiConnected && hasConfirmedIp);
    const needsManualIp = Boolean(wiz.wifiConnected && !hasConfirmedIp);
    const isScanning = Boolean(wiz.busy && wiz.busyAction === "usb-wifi-scan");
    const isConnecting = Boolean(wiz.busy && wiz.busyAction === "usb-wifi-connect");

    const wifiRowsHtml =
      wiz.wifiNetworks.length > 0
        ? `<div class="setup-wifi-list" id="freshWifiNetworkList" role="listbox" aria-label="Visible Wi-Fi networks">
             ${wiz.wifiNetworks
               .map((net, idx) => {
                 const ssid = String(net.ssid || "");
                 const secLabel = formatWifiSecurityLabel(net.encryption || net.security);
                 const sigLabel = formatWifiSignalLabel(
                   net.signal_strength ?? net.signalStrength ?? ""
                 );
                 const badgeText = sigLabel ? `${secLabel} · ${sigLabel}` : secLabel;
                 const picked = ssid && ssid === wiz.wifiSsid;
                 return `<button type="button" class="setup-wifi-item ${picked ? "is-picked" : ""}" data-wifi-idx="${idx}" ${wiz.busy ? "disabled" : ""}>
                   <span style="font-weight:500">${escapeHtml(ssid || "(Hidden network)")}</span>
                   <span class="muted" style="font-size:var(--fs-caption)">${escapeHtml(badgeText)}</span>
                 </button>`;
               })
               .join("")}
           </div>`
        : isScanning
          ? `<p class="m-field-hint" style="margin:0">Scanning for nearby 2.4 GHz Wi-Fi networks…</p>`
          : wiz.wifiScanned
            ? `<p class="m-field-hint" style="margin:0">No 2.4 GHz networks appeared in the scan. Type your Wi-Fi network name below.</p>`
            : "";

    return `
      <div class="wiz-intro">
        <h2>Connect your hub to Wi-Fi</h2>
        <p>Harmony Hubs use 2.4 GHz Wi-Fi so your remotes, phone, and Home Assistant can talk to it.</p>
      </div>

      ${renderWedgeBanner(wiz)}

      <div class="setup-focus-card" id="wizardStep2Wifi">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:var(--space-2)">
          <span style="font-weight:500;font-size:var(--fs-body-sm)">Nearby 2.4 GHz networks</span>
          <button type="button" class="btn btn-tonal btn-sm" id="freshWifiScanBtn" ${wiz.busy ? "disabled" : ""}>
            ${isScanning ? '<span class="m-spinner" aria-hidden="true"></span>' : ""}
            <span>${isScanning ? "Scanning…" : "Scan Again"}</span>
          </button>
        </div>

        ${wifiRowsHtml}

        <div class="setup-grid-2">
          <div class="m-field">
            <label for="wizardWifiSsidInput">Wi-Fi network name</label>
            <input id="wizardWifiSsidInput" type="text" autocomplete="off" spellcheck="false" placeholder="2.4 GHz network name" value="${escapeHtml(wiz.wifiSsid)}" ${wiz.busy ? "disabled" : ""}>
          </div>
          <div class="m-field">
            <label for="wizardWifiPassInput">Wi-Fi password</label>
            <input id="wizardWifiPassInput" type="password" autocomplete="off" placeholder="${wiz.wifiEncryption === "OPEN" ? "No password needed" : "Enter Wi-Fi password"}" value="${escapeHtml(wiz.wifiPassword)}" ${wiz.busy || wiz.wifiEncryption === "OPEN" ? "disabled" : ""}>
          </div>
        </div>

        <details class="setup-disclosure" id="wizardWifiSecurityDisclosure" ${wiz.wifiEncryption === "OPEN" ? "open" : ""}>
          <summary>Network security options</summary>
          <div class="setup-disclosure-body">
            <div class="m-field">
              <label for="wizardWifiEncSelect">Security type</label>
              <select id="wizardWifiEncSelect" style="min-height:44px;padding:0 12px;border-radius:var(--shape-sm);background:var(--surface-lowest);color:var(--on-surface);border:1px solid var(--outline-variant)" ${wiz.busy ? "disabled" : ""}>
                <option value="WPA2-PSK" ${wiz.wifiEncryption === "WPA2-PSK" ? "selected" : ""}>WPA2 (most networks)</option>
                <option value="WPA-PSK" ${wiz.wifiEncryption === "WPA-PSK" ? "selected" : ""}>WPA</option>
                <option value="OPEN" ${wiz.wifiEncryption === "OPEN" ? "selected" : ""}>Open (no password)</option>
              </select>
            </div>
          </div>
        </details>

        ${
          connectedReady
            ? `<div class="notice notice-ok" id="wizardWifiConnectedNotice" role="status" style="display:flex;align-items:center;justify-content:space-between;gap:var(--space-2);flex-wrap:wrap">
                 <div>
                   <div style="font-weight:600">Connected to ${escapeHtml(wiz.wifiSsid || "Wi-Fi")}</div>
                   <div style="font-size:var(--fs-caption);opacity:0.86">Hub IP: ${escapeHtml(activeHost)}</div>
                 </div>
                 ${renderPill("Connected", "is-done")}
               </div>`
            : ""
        }

        ${
          needsManualIp
            ? `<div class="notice notice-ok" id="wizardWifiManualIpFallback" role="status" style="display:grid;gap:var(--space-3)">
                 <div>
                   <div style="font-weight:600">Connected to ${escapeHtml(wiz.wifiSsid || "Wi-Fi")}</div>
                   <div style="font-size:var(--fs-body-sm)">Couldn't detect the hub's IP address automatically yet. Check again or enter it from your router:</div>
                 </div>
                 <div class="setup-grid-2" style="align-items:end">
                   <div class="m-field">
                     <label for="freshConfirmedHostInput">Enter hub IP from your router</label>
                     <input id="freshConfirmedHostInput" type="text" autocomplete="off" spellcheck="false" placeholder="e.g. 192.168.1.50" value="${escapeHtml(activeHost)}" ${wiz.busy ? "disabled" : ""}>
                   </div>
                   <div>
                     <button type="button" class="btn btn-tonal btn-block" id="freshVerifyLanBtn" ${wiz.busy ? "disabled" : ""}>
                       Check Again
                     </button>
                   </div>
                 </div>
               </div>`
            : ""
        }

        ${
          wiz.error
            ? `<div class="notice notice-error" id="wizardErrorNotice" role="alert">
                 <div>${escapeHtml(wiz.error)}</div>
                 ${renderTechDetailsBlock(wiz)}
               </div>`
            : ""
        }

        <div style="display:flex;align-items:center;justify-content:space-between;gap:var(--space-2);flex-wrap:wrap">
          <button type="button" class="btn btn-outlined" id="wizardBackToStep1Btn" ${wiz.busy ? "disabled" : ""}>
            ← Back
          </button>
          <div style="display:flex;gap:var(--space-2);flex-wrap:wrap">
            ${
              connectedReady
                ? `<button type="button" class="btn btn-tonal" id="freshWifiConnectBtn" ${wiz.busy ? "disabled" : ""}>
                     Reconnect Wi-Fi
                   </button>
                   <button type="button" class="btn btn-filled" id="wizardWifiContinueBtn" ${wiz.busy ? "disabled" : ""}>
                     Continue →
                   </button>`
                : needsManualIp
                  ? `<button type="button" class="btn btn-tonal" id="freshWifiConnectBtn" ${wiz.busy ? "disabled" : ""}>
                       Reconnect Wi-Fi
                     </button>
                     <button type="button" class="btn btn-filled" id="wizardWifiContinueBtn" ${wiz.busy || !hasConfirmedIp ? "disabled" : ""}>
                       Continue →
                     </button>`
                  : `<button type="button" class="btn btn-filled" id="freshWifiConnectBtn" ${wiz.busy ? "disabled" : ""}>
                       ${isConnecting ? '<span class="m-spinner" style="border-color:var(--on-primary);border-right-color:transparent" aria-hidden="true"></span>' : ""}
                       <span>${isConnecting ? "Connecting to Wi-Fi…" : "Connect to Wi-Fi"}</span>
                     </button>`
            }
          </div>
        </div>
      </div>
    `;
  }

  function getInstallErrorHint(wiz) {
    const rawErr = String(wiz?.error || "").trim();
    const failedStep = Number(wiz?.installChecklistFailedStep) || 0;
    const wedged = Boolean(wiz?.usbWedgeActive || wiz?.classifyResult?.usbWedge?.wedged);
    const usesUsbForPrepOrRoot =
      wiz?.flowPath === "fresh" || wiz?.provisionedTransport === "usb";

    if (/Hub IP address is missing/i.test(rawErr)) {
      return "Your hub's IP address is missing. Go back to find your hub or connect it to Wi-Fi, then try again.";
    }
    if (/Custom Hub ID must be a positive/i.test(rawErr)) {
      return "Custom Hub ID must be a positive whole number (for example, 20264150). Update it under Advanced options, then click Try Again.";
    }

    // Step 3 (Downloading and installing Melodious) never uses USB:
    // it downloads/unpacks a hub zip on this computer and installs over LAN SSH.
    if (failedStep === 3) {
      if (
        /older than this app/i.test(rawErr) ||
        /hub zip is missing\b/i.test(rawErr) ||
        /missing files this (?:app|version) requires/i.test(rawErr)
      ) {
        return "This hub zip is older than this app and is missing files this version needs. Choose a matching hub zip under Advanced options → Use a local .zip file instead, then click Try Again.";
      }
      if (/doesn't know how to install|Update this app first/i.test(rawErr)) {
        return "This hub zip doesn't match this app (it contains files newer than this version). Update the Melodious app first, or choose a matching zip under Advanced options → Use a local .zip file instead.";
      }
      if (/checksum|SHA256SUMS/i.test(rawErr)) {
        return "The downloaded hub file didn't pass its checksum verification, so nothing was installed. Click Try Again to re-download it, or choose Advanced options → Use a local .zip file instead.";
      }
      if (
        /isn't a Melodious hub zip|no melodious-hub-|no payload folder|isn't a plain file|MANIFEST\.txt doesn't match|valid local Melodious hub \.zip|ditto|bsdtar|tar\.exe|unzip|PKZip|End-of-central-directory/i.test(
          rawErr
        )
      ) {
        return "Couldn't unpack or verify the hub .zip file — it may be incomplete, corrupted, or not a Melodious hub zip. Click Try Again, or choose a valid zip under Advanced options → Use a local .zip file instead.";
      }
      if (/rate-limit/i.test(rawErr)) {
        return "GitHub is rate-limiting downloads from this network right now. Wait a few minutes and click Try Again, or choose Advanced options → Use a local .zip file instead.";
      }
      if (
        /GitHub|download|outside GitHub|Too many redirects|published Melodious hub release|Release .+ has no /i.test(
          rawErr
        )
      ) {
        return "Couldn't download the Melodious hub package from GitHub. Check this computer's internet connection and click Try Again, or choose Advanced options → Use a local .zip file instead.";
      }
      if (
        /SSH host key changed|Host key verification failed|REMOTE HOST IDENTIFICATION|Installation canceled/i.test(
          rawErr
        )
      ) {
        return "Your hub's security key changed (which is normal after a reset) and wasn't trusted yet. Click Try Again and choose Trust & Continue if you reset this hub yourself.";
      }
      if (/BLOCKED_CAPACITY|not enough free|flash/i.test(rawErr)) {
        return "Your hub doesn't have enough free space to install Melodious right now. Open Show technical details to see what's using space on the hub.";
      }
      if (/Installer preflight blocked/i.test(rawErr)) {
        return "The installer paused at a safety check before changing your hub. Open Show technical details to see why, then click Try Again.";
      }
      if (/Failed to (?:spawn|run) Python|Missing installer script|OpenSSH client|no ssh program/i.test(rawErr)) {
        return "This computer couldn't start the installer helper. Open Show technical details to check what's missing, then click Try Again.";
      }
      return "Couldn't finish installing Melodious on your hub over your local network. Make sure your hub is powered on and on the same Wi-Fi network as this computer, then click Try Again.";
    }

    // Step 4 (Restarting hub and checking connection) also uses LAN/Wi-Fi only, never USB.
    if (failedStep === 4) {
      return "Melodious finished installing, but your hub hasn't answered on the local network yet. Wait a minute for it to finish restarting on Wi-Fi, then click Try Again.";
    }

    if (wedged) {
      return "Unplug the USB cable from your computer for 15 seconds, plug it back in, wait about 3 minutes for the light to settle, then click Try Again.";
    }
    // A timeout (the step ran long or stalled) is NOT evidence of a loose cable:
    // during the USB root upload the cable stays connected the whole time. Give
    // honest guidance and point at the on-disk log instead of blaming hardware.
    if (/timed out|no progress|no retry made|USB hbus timed out/i.test(rawErr)) {
      if (usesUsbForPrepOrRoot) {
        return "Setting up your hub over USB didn't finish in time. Unplug the hub's USB cable for 15 seconds, plug it back in, wait for the light to settle, then click Try Again. The full log for this run is saved on this computer — open Show technical details for its location.";
      }
      return "This step didn't finish in time. Give your hub a moment, then click Try Again. The full log for this run is saved on this computer — open Show technical details for its location.";
    }
    if (usesUsbForPrepOrRoot) {
      return "Make sure the USB cable is firmly connected to this computer and the hub has power, then click Try Again.";
    }
    return "Make sure your hub is powered on and connected to the same Wi-Fi network as this computer, then click Try Again.";
  }

  function renderInstallErrorCard(wiz) {
    if (!wiz.error) return "";
    const stepLabels = {
      1: "Setup paused while preparing your hub for offline use.",
      2: "Setup paused while setting up local hub access.",
      3: "Setup paused while installing Melodious.",
      4: "Setup paused while restarting your hub and checking the connection.",
    };
    const headline =
      stepLabels[wiz.installChecklistFailedStep] || "Setup paused before finishing.";
    const hint = getInstallErrorHint(wiz);

    return `
      <div class="notice notice-error" id="wizardErrorNotice" role="alert" style="display:grid;gap:6px">
        <div style="font-weight:600">${escapeHtml(headline)}</div>
        <div style="font-size:var(--fs-body-sm)">${escapeHtml(hint)}</div>
        ${renderTechDetailsBlock(wiz)}
      </div>
    `;
  }

  function renderScreen3Install(wiz) {
    const isProv = wiz.flowPath === "provisioned";
    const checklist = computeInstallChecklistItems(wiz);
    const hasFailed = Boolean(wiz.installChecklistFailedStep > 0 || wiz.error);
    const customHubIdVal = isProv
      ? wiz.provHubIdInput || wiz.remoteIdInput
      : wiz.remoteIdInput;

    const restartNote =
      !isProv || wiz.provisionedTransport === "usb"
        ? "Your hub will restart twice during setup — keep the USB cable plugged in until it finishes (about 2–3 minutes)."
        : "Your existing devices and activities will be kept. Keep your hub plugged into power until setup finishes (about 2 minutes).";

    return `
      <div class="wiz-intro">
        <h2>Install Melodious</h2>
        <p>Melodious will prepare your hub for offline use, set up local access, and install the latest release.</p>
      </div>

      ${wiz.installChecklistFailedStep >= 3 ? "" : renderWedgeBanner(wiz)}

      <div class="setup-focus-card" id="wizardStep3Install">
        <p class="muted" style="margin:0;font-size:var(--fs-body-sm)">
          ${escapeHtml(restartNote)}
        </p>

        <div class="setup-checklist" id="wizardInstallChecklist" aria-live="polite">
          ${checklist
            .map((item) => {
              const cls =
                item.status === "done"
                  ? "is-done"
                  : item.status === "active"
                    ? "is-active"
                    : item.status === "error"
                      ? "is-error"
                      : "";
              const badgeContent =
                item.status === "done"
                  ? "✓"
                  : item.status === "active"
                    ? '<span class="m-spinner" style="width:14px;height:14px;border-width:2px" aria-hidden="true"></span>'
                    : item.status === "error"
                      ? "!"
                      : String(item.step);
              return `
                <div class="setup-check-item ${cls}" data-install-step="${item.step}">
                  <span class="setup-stage-num">${badgeContent}</span>
                  <span>${escapeHtml(item.label)}</span>
                </div>
              `;
            })
            .join("")}
        </div>

        ${renderInstallErrorCard(wiz)}

        <details class="setup-disclosure" id="wizardAdvancedOptions" ${wiz.advancedOpen ? "open" : ""}>
          <summary>Advanced options</summary>
          <div class="setup-disclosure-body">
            ${
              !isProv
                ? `<div class="m-field">
                     <label for="wizardHubNameInput">Hub name</label>
                     <input id="wizardHubNameInput" type="text" autocomplete="off" value="${escapeHtml(wiz.hubNameInput)}" ${wiz.busy ? "disabled" : ""}>
                   </div>`
                : ""
            }
            <label style="display:flex;align-items:center;gap:8px;font-size:var(--fs-body-sm);cursor:pointer">
              <input type="checkbox" id="wizardUseLocalZip" ${wiz.installSource === "local" ? "checked" : ""} ${wiz.busy ? "disabled" : ""}>
              <span>Use a local .zip file instead</span>
            </label>
            <div class="m-field">
              <label for="wizardCustomHubIdInput">Custom Hub ID</label>
              <input id="wizardCustomHubIdInput" type="text" inputmode="numeric" autocomplete="off" value="${escapeHtml(customHubIdVal)}" ${wiz.busy ? "disabled" : ""}>
              <p class="m-field-hint" style="margin:4px 0 0">Leave as-is unless you need a specific Hub ID.</p>
            </div>
          </div>
        </details>

        <div style="display:flex;align-items:center;justify-content:space-between;gap:var(--space-2);flex-wrap:wrap">
          <button type="button" class="btn btn-outlined" id="wizardBackFromInstallBtn" ${wiz.busy ? "disabled" : ""}>
            ← Back
          </button>
          <button type="button" class="btn btn-filled" id="wizardInstallMelodiousBtn" ${wiz.busy ? "disabled" : ""}>
            ${wiz.busy ? '<span class="m-spinner" style="border-color:var(--on-primary);border-right-color:transparent" aria-hidden="true"></span>' : ""}
            <span>${wiz.busy ? "Installing Melodious…" : hasFailed ? "Try Again" : "Install Melodious"}</span>
          </button>
        </div>
      </div>
    `;
  }

  function renderScreen4Done(wiz) {
    const targetHost = wiz.handoffHost || wiz.confirmedHost || wiz.hostInput || "";

    return `
      <div class="wiz-intro">
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:4px">
          <span class="m-tile m-tile--hub" style="--tile:44px;color:var(--live)">${CHECK_ICON_SVG}</span>
          <h2 style="margin:0">Your Harmony Hub is ready!</h2>
        </div>
        <p>Melodious is installed, offline-protected, and ready to use on this computer.</p>
      </div>

      <div class="setup-focus-card" id="wizardStep4DoneCard">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:var(--space-3);flex-wrap:wrap" id="wizardStep3ConnectedCard">
          <div style="display:flex;align-items:center;gap:10px">
            <span class="m-dot ${wiz.handoffConnected ? "is-live" : ""}" aria-hidden="true"></span>
            <div>
              <div style="font-weight:600" id="wizardHandoffAddress">${escapeHtml(targetHost || "Harmony Hub")}</div>
              <div class="muted" style="font-size:var(--fs-body-sm)">
                ${
                  wiz.handoffConnected
                    ? `Connected${wiz.installedVersion ? ` · Melodious ${wiz.installedVersion}` : ""}`
                    : wiz.handoffError
                      ? "Your hub is finishing its startup — click Retry or Open Melodious."
                      : "Connecting to your hub…"
                }
              </div>
            </div>
          </div>
          ${wiz.handoffConnected ? renderPill("Connected", "is-done") : renderPill("Starting up", "is-active")}
        </div>

        ${
          wiz.handoffError
            ? `<div>
                 <button type="button" class="btn btn-tonal btn-sm" id="wizardRetryHandoffBtn" ${wiz.busy ? "disabled" : ""}>Retry connection</button>
               </div>`
            : ""
        }

        <div class="m-list" id="wizardPostInstallChecklist">
          <div class="m-row">
            <span class="setup-stage-num" style="background:var(--primary-container);color:var(--on-primary-container)">1</span>
            <span class="m-row-text">
              <span class="m-row-title">Add your TV and devices</span>
              <span class="m-row-sub">Open <strong>Devices → Add device</strong> to import codes by model, scan your network, or learn buttons.</span>
            </span>
          </div>
          <div class="m-row">
            <span class="setup-stage-num" style="background:var(--primary-container);color:var(--on-primary-container)">2</span>
            <span class="m-row-text">
              <span class="m-row-title">Create an activity</span>
              <span class="m-row-sub">Open <strong>Activities → Add activity</strong> to power on your devices and set inputs together.</span>
            </span>
          </div>
          <div class="m-row">
            <span class="setup-stage-num" style="background:var(--primary-container);color:var(--on-primary-container)">3</span>
            <span class="m-row-text">
              <span class="m-row-title">Pair your remote in Settings → Remotes</span>
              <span class="m-row-sub">Start pairing and hold <strong>Menu + Mute</strong> on your Harmony remote for about 5 seconds.</span>
            </span>
          </div>
        </div>

        <div style="display:flex;justify-content:flex-end;margin-top:var(--space-1)">
          <button type="button" class="btn btn-filled" id="wizardOpenHubBtn" ${wiz.busy ? "disabled" : ""}>
            Open Melodious →
          </button>
        </div>
      </div>
    `;
  }

  function renderTroubleshootingView(wiz) {
    const activeHost = (wiz.confirmedHost || wiz.hostInput).trim();
    const hubIdVal =
      wiz.flowPath === "provisioned"
        ? wiz.provHubIdInput || wiz.remoteIdInput
        : wiz.remoteIdInput;

    return `
      <div class="wiz-intro" style="padding-top:var(--space-4)">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:var(--space-2);flex-wrap:wrap">
          <h2 style="margin:0">Troubleshooting tools</h2>
          <button type="button" class="btn btn-outlined btn-sm" id="wizardCloseTroubleshootingBtn" ${wiz.busy ? "disabled" : ""}>
            ← Back to setup
          </button>
        </div>
        <p>Support and diagnostic actions for testing individual setup steps or copying logs.</p>
      </div>

      <div class="setup-focus-card" id="wizardTroubleshootingView">
        <div class="setup-grid-2">
          <div class="m-field">
            <label for="wizardTroubleshootHostInput">Target Hub IP</label>
            <input id="wizardTroubleshootHostInput" type="text" autocomplete="off" spellcheck="false" placeholder="e.g. 192.168.1.50" value="${escapeHtml(activeHost)}" ${wiz.busy ? "disabled" : ""}>
          </div>
          <div class="m-field">
            <label for="wizardTroubleshootHubIdInput">Hub ID</label>
            <input id="wizardTroubleshootHubIdInput" type="text" inputmode="numeric" autocomplete="off" value="${escapeHtml(hubIdVal)}" ${wiz.busy ? "disabled" : ""}>
          </div>
        </div>

        <label style="display:flex;align-items:center;gap:8px;font-size:var(--fs-body-sm);cursor:pointer">
          <input type="checkbox" id="wizardMaskIds" ${wiz.maskIds ? "checked" : ""} ${wiz.busy ? "disabled" : ""}>
          <span>Redact IDs (mask IP &amp; Hub ID in diagnostic output)</span>
        </label>

        <div style="display:flex;gap:var(--space-2);flex-wrap:wrap">
          <button type="button" class="btn btn-outlined btn-sm" data-wizard-manual-action="usb-preflight" ${wiz.busy ? "disabled" : ""}>USB Preflight</button>
          <button type="button" class="btn btn-outlined btn-sm" data-wizard-manual-action="usb-wifi-scan" ${wiz.busy ? "disabled" : ""}>USB Wi-Fi Scan</button>
          <button type="button" class="btn btn-outlined btn-sm" data-wizard-manual-action="usb-wifi-status" ${wiz.busy ? "disabled" : ""}>USB Wi-Fi Status</button>
          <button type="button" class="btn btn-tonal btn-sm" data-wizard-manual-action="usb-wifi-connect" ${wiz.busy ? "disabled" : ""}>USB Wi-Fi Connect</button>
          <button type="button" class="btn btn-tonal btn-sm" data-wizard-manual-action="usb-flash-firmware" ${wiz.busy ? "disabled" : ""}>USB Flash .hfw2…</button>
          <button type="button" class="btn btn-danger btn-sm" data-wizard-manual-action="usb-factory-reset" ${wiz.busy ? "disabled" : ""}>USB Factory Reset</button>
          <button type="button" class="btn btn-tonal btn-sm" data-wizard-manual-action="usb-tde-enable" ${wiz.busy ? "disabled" : ""}>USB TDE Enable</button>
          <button type="button" class="btn btn-tonal btn-sm" data-wizard-manual-action="usb-provision-local" ${wiz.busy ? "disabled" : ""}>USB Provision Local</button>
          <button type="button" class="btn btn-tonal btn-sm" data-wizard-manual-action="usb-seed-automation" ${wiz.busy ? "disabled" : ""}>USB Seed Automation</button>
          <button type="button" class="btn btn-tonal btn-sm" data-wizard-manual-action="usb-root" ${wiz.busy ? "disabled" : ""}>USB Root</button>
          <button type="button" class="btn btn-tonal btn-sm" data-wizard-manual-action="lan-root-xmpp" ${wiz.busy ? "disabled" : ""}>LAN Root</button>
          <button type="button" class="btn btn-outlined btn-sm" id="wizardRunPreflightBtn" ${wiz.busy ? "disabled" : ""}>Preflight Check Only</button>
        </div>

        <div style="padding-top:var(--space-3);border-top:1px solid var(--divider);display:grid;gap:var(--space-2)">
          <label style="display:flex;align-items:flex-start;gap:8px;font-size:var(--fs-caption);cursor:pointer">
            <input type="checkbox" id="wizardAllowUnprovenPost" ${wiz.allowUnprovenPost ? "checked" : ""} ${wiz.busy ? "disabled" : ""}>
            <span><strong>EXPERIMENTAL:</strong> Unlock unproven HTTP POST root transport (smoke-tested only; prefer USB or LAN Root).</span>
          </label>
          <div>
            <button type="button" class="btn btn-outlined btn-sm" data-wizard-manual-action="post-root" ${wiz.busy || !wiz.allowUnprovenPost ? "disabled" : ""}>
              Experimental POST Root
            </button>
          </div>
        </div>

        ${
          wiz.lastManualOutcome
            ? `<div class="notice ${wiz.lastManualOutcome.ok ? "notice-ok" : "notice-error"}" id="wizardManualOutcome" role="status">
                 <strong>${escapeHtml(wiz.lastManualOutcome.action)}:</strong> ${wiz.lastManualOutcome.ok ? "OK" : escapeHtml(wiz.lastManualOutcome.error || "Failed")}
               </div>`
            : ""
        }

        ${
          wiz.error
            ? `<div class="notice notice-error" id="wizardTroubleshootError" role="alert">${escapeHtml(wiz.error)}</div>`
            : ""
        }

        <div style="display:grid;gap:var(--space-2);padding-top:var(--space-2);border-top:1px solid var(--divider)">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:var(--space-2)">
            <span style="font-size:var(--fs-caption);font-weight:600;color:var(--on-surface-variant)">Raw diagnostic log</span>
            <div style="display:flex;gap:var(--space-2)">
              <button type="button" class="btn btn-outlined btn-sm" id="wizardCopyLogBtn" ${wiz.logLines.length === 0 ? "disabled" : ""}>Copy log</button>
              <button type="button" class="btn btn-text btn-sm" id="wizardClearLogBtn" ${wiz.logLines.length === 0 ? "disabled" : ""}>Clear</button>
            </div>
          </div>
          <div class="setup-log" id="wizardRawLogViewer">${escapeHtml(
            wiz.logLines.length > 0 ? wiz.logLines.join("\n") : "No diagnostic events recorded yet."
          )}</div>
        </div>
      </div>
    `;
  }

  function renderWizardPage(wiz) {
    if (wiz.troubleshootingOpen) {
      return `
        <div class="wiz setup-wiz-shell" id="hubSetupWizard" data-current-step="troubleshooting">
          <div class="wiz-body setup-wiz-main">
            ${renderTroubleshootingView(wiz)}
          </div>
        </div>
      `;
    }

    let stepContent = "";
    if (wiz.step === 1 && wiz.subScreen === "factory-reset") {
      stepContent = renderFactoryResetSubScreen(wiz);
    } else if (wiz.step === 1 && wiz.subScreen === "firmware-update") {
      stepContent = renderFirmwareUpdateSubScreen(wiz);
    } else if (wiz.step === 1) {
      stepContent = renderScreen1Detect(wiz);
    } else if (wiz.step === 2) {
      stepContent = renderScreen2Wifi(wiz);
    } else if (wiz.step === 3) {
      stepContent = renderScreen3Install(wiz);
    } else {
      stepContent = renderScreen4Done(wiz);
    }

    return `
      <div class="wiz setup-wiz-shell" id="hubSetupWizard" data-current-step="${escapeHtml(wiz.step)}">
        <div class="wiz-body setup-wiz-main">
          ${renderProgressHeader(wiz.step)}
          ${stepContent}
          ${renderFooterLink()}
        </div>
      </div>
    `;
  }

  function openWizardConfirmDialog(doc, {
    title,
    body,
    confirmLabel = "Continue",
    cancelLabel = "Cancel",
    danger = false,
  }) {
    return new Promise((resolve) => {
      if (!doc || !doc.body) {
        resolve(false);
        return;
      }
      doc.getElementById("wizardConfirmDialog")?.remove();
      const dialog = doc.createElement("dialog");
      dialog.className = "sheet";
      dialog.id = "wizardConfirmDialog";
      dialog.setAttribute("aria-label", title || "Confirm action");
      dialog.innerHTML = `
        <div class="sheet-body">
          <div class="sheet-handle" aria-hidden="true"></div>
          <div class="sheet-content">
            <h2 class="sheet-title">${escapeHtml(title)}</h2>
            <p class="sheet-text" style="white-space:pre-line">${escapeHtml(body)}</p>
            <div style="display:flex;justify-content:flex-end;gap:var(--space-2);margin-top:var(--space-4)">
              <button type="button" class="btn btn-text" id="wizardConfirmCancelBtn">${escapeHtml(cancelLabel)}</button>
              <button type="button" class="btn ${danger ? "btn-danger" : "btn-filled"}" id="wizardConfirmAcceptBtn">${escapeHtml(confirmLabel)}</button>
            </div>
          </div>
        </div>
      `;

      let settled = false;
      const finish = (accepted) => {
        if (settled) return;
        settled = true;
        if (dialog.open) dialog.close();
        dialog.remove();
        resolve(accepted);
      };

      dialog.addEventListener("cancel", (ev) => {
        ev.preventDefault();
        finish(false);
      });
      dialog.addEventListener("click", (ev) => {
        if (ev.target === dialog) finish(false);
      });
      dialog.querySelector("#wizardConfirmCancelBtn")?.addEventListener("click", () => finish(false));
      dialog.querySelector("#wizardConfirmAcceptBtn")?.addEventListener("click", () => finish(true));

      doc.body.appendChild(dialog);
      if (typeof dialog.showModal === "function") {
        dialog.showModal();
      } else {
        dialog.setAttribute("open", "");
      }
      dialog.querySelector("#wizardConfirmAcceptBtn")?.focus();
    });
  }

  const exported = {
    escapeHtml,
    suggestNumericRemoteId,
    parsePositiveIntInput,
    isUnmaskedHost,
    extractDetectedHost,
    extractDetectedNumericHubId,
    deriveRecommendedPath,
    formatWifiSecurityLabel,
    formatWifiSignalLabel,
    createInitialWizardState,
    computeFreshChecklistStatus,
    computeProvisionedChecklistStatus,
    computeInstallChecklistItems,
    classifyScreen1Outcome,
    getInstallErrorHint,
    renderWizardConnectEntry,
    renderWizardSettingsEntry,
    renderWizardPage,
    openWizardConfirmDialog,
  };

  if (typeof module === "object" && module && module.exports) {
    module.exports = exported;
  }
  if (globalScope && typeof globalScope === "object") {
    globalScope.MelodiousRootWizardFlow = exported;
  }
})(typeof window !== "undefined" ? window : globalThis);
