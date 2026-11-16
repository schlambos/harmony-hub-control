"use strict";

// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Matthew Gibbons (Melodious — LICENSE section 2)
//
// Guided 1-2-3 Hub Setup & Root Wizard UI model and renderer (Slice 3).
// Shared between connect/connect.js (via scheme.js inline bundle) and Node unit tests.

(function initMelodiousRootWizardFlow(globalScope) {
  const SETUP_ICON_SVG =
    '<svg class="ic" width="24" height="24" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.49.49 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.48.48 0 0 0-.48-.41h-3.84a.48.48 0 0 0-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96a.49.49 0 0 0-.59.22L2.74 8.87a.48.48 0 0 0 .12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6A3.6 3.6 0 1 1 12 8.4a3.6 3.6 0 0 1 0 7.2z"/></svg>';

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

  function createInitialWizardState(seedNumber) {
    const defaultRemoteId = suggestNumericRemoteId(seedNumber);
    return {
      open: false,
      returnMode: "connect",
      step: 1, // 1: Detect & Classify, 2: Guided Root & Install, 3: Handoff to Hub Web UI
      intent: "fresh", // "fresh" | "provisioned"
      flowPath: "fresh", // "fresh" | "provisioned"
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
      // Fresh-hub checklist progress
      firmwarePassed: false,
      wifiNetworks: [],
      wifiScanned: false,
      wifiSsid: "",
      wifiEncryption: "WPA2-PSK",
      wifiPassword: "",
      wifiConnected: false,
      remoteIdInput: defaultRemoteId,
      hubNameInput: "Harmony Hub",
      accountIdInput: "",
      tdeDone: false,
      provisionLocalDone: false,
      seedAutomationDone: false,
      // Shared Root & Install progress
      provHubIdInput: "",
      sshOpen: false,
      installSource: "latest", // "latest" | "local"
      installedVersion: "",
      preflightPassed: false,
      installDone: false,
      // Step 3 handoff state
      handoffConnected: false,
      handoffHost: "",
      handoffPort: 8080,
      handoffFirmware: "",
      handoffError: "",
      // Developer overrides
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

  function renderWizardConnectEntry({ disabled = false } = {}) {
    return `
      <button type="button" class="setup-entry-card" id="openWizardConnectBtn" ${disabled ? "disabled" : ""}>
        <span class="m-tile m-tile--hub" style="--tile:44px">${SETUP_ICON_SVG}</span>
        <span class="m-row-text">
          <span class="m-row-title">Set up a new or unrooted Harmony Hub</span>
          <span class="m-row-sub">Guided 1-2-3 setup to detect, root, and install Melodious over USB or LAN.</span>
        </span>
        ${CHEVRON_SVG}
      </button>
    `;
  }

  function renderWizardSettingsEntry({ disabled = false } = {}) {
    return `
      <h3 class="m-section">Hub setup &amp; root</h3>
      <div class="m-list">
        <button type="button" class="m-row" id="openWizardSettingsBtn" ${disabled ? "disabled" : ""}>
          <span class="m-tile m-tile--hub" style="--tile:40px">${SETUP_ICON_SVG}</span>
          <span class="m-row-text">
            <span class="m-row-title">Set up or re-root a hub</span>
            <span class="m-row-sub">Guided 1-2-3 wizard for factory-reset, unrooted, or replacement Harmony Hubs.</span>
          </span>
          ${CHEVRON_SVG}
        </button>
      </div>
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
    const detail =
      wiz.usbWedgeMessage ||
      wiz.classifyResult?.usbWedge?.message ||
      "USB HID 046D:C129 enumerated, but LTCP communication wedged.";
    return `
      <div class="notice notice-error" id="wizardUsbWedgeBanner" role="alert" style="margin-bottom:var(--space-3)">
        <div style="font-weight:600;margin-bottom:6px">USB link wedged — 15-second power-cycle required</div>
        <div style="margin-bottom:6px">${escapeHtml(detail)}</div>
        <ol style="padding-left:20px;list-style:decimal;display:grid;gap:4px;font-size:var(--fs-body-sm)">
          <li>Unplug the hub's USB power cable and wait <strong>15 seconds</strong>.</li>
          <li>Plug it back in and wait <strong>~5 minutes</strong> for boot to settle.</li>
          <li>Click <strong>Detect hub (LAN + USB)</strong> so read-only <code>usb-preflight</code> runs first.</li>
        </ol>
      </div>
    `;
  }

  function renderFactoryResetBanner(wiz) {
    if (!wiz.factoryResetSent) return "";
    return `
      <div class="notice notice-ok" id="wizardResetRecoveryNotice" role="status" style="margin-bottom:var(--space-3)">
        <div style="font-weight:600;margin-bottom:6px">Safe factory reset ("1" marker) sent — complete USB power-cycle</div>
        <ol style="padding-left:20px;list-style:decimal;display:grid;gap:4px;font-size:var(--fs-body-sm)">
          <li>Wait <strong>30–60 seconds</strong> while the hub fast-blinks red and wipes <code>/data</code> and <code>/cache</code>.</li>
          <li>Unplug the USB cable for <strong>15 seconds</strong> (the hub normally stays off USB after the wipe).</li>
          <li>Plug USB back in, wait <strong>~5 minutes</strong> for boot to settle, then click <strong>Re-check Hub</strong>.</li>
        </ol>
      </div>
    `;
  }

  function renderProgressHeader(step) {
    return `
      <div class="wiz-progress" aria-label="Setup progress" style="margin-top:var(--space-2)">
        <div class="wiz-seg ${step >= 1 ? "is-done" : ""}" data-wiz-step="1" title="Step 1: Detect & Classify"></div>
        <div class="wiz-seg ${step >= 2 ? "is-done" : ""}" data-wiz-step="2" title="Step 2: Root & Install"></div>
        <div class="wiz-seg ${step >= 3 ? "is-done" : ""}" data-wiz-step="3" title="Step 3: Open Hub"></div>
      </div>
    `;
  }

  function renderLiveProgressCard(wiz) {
    if (!wiz.busy && !wiz.error && wiz.logLines.length === 0 && !wiz.stepText) {
      return "";
    }
    return `
      <div class="m-card" id="wizardLiveProgressCard" style="margin-top:var(--space-3);display:grid;gap:var(--space-2)">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:var(--space-2)">
          <span style="display:inline-flex;align-items:center;gap:8px;font-weight:500">
            ${wiz.busy ? '<span class="m-spinner" aria-hidden="true"></span>' : ""}
            <span id="wizardStepStatus">${escapeHtml(wiz.stepText || (wiz.busy ? "Working…" : wiz.error ? "Stopped with an error" : "Last step output"))}</span>
          </span>
          ${wiz.busy ? renderPill("Running", "is-active") : ""}
        </div>
        ${
          wiz.error
            ? `<div class="notice notice-error" id="wizardErrorNotice" role="alert">${escapeHtml(wiz.error)}</div>`
            : ""
        }
        ${
          wiz.logLines.length > 0
            ? `<div class="setup-log" id="wizardProgressLog">${escapeHtml(wiz.logLines.slice(-40).join("\n"))}</div>`
            : ""
        }
      </div>
    `;
  }

  function renderStep1Detect(wiz) {
    const r = wiz.classifyResult;
    const mismatch = r?.mismatch;
    const usbSig = r?.signals?.usb;
    const lanSig = r?.signals?.lan;
    const ssdpSig = r?.signals?.ssdp;
    const fwGate = r?.firmwareGate;
    const ports = lanSig?.ports || {};

    let statusCardsHtml = "";
    if (r) {
      const verdictPill =
        r.verdict === "melodious-installed"
          ? renderPill("Melodious ready", "is-done")
          : r.verdict === "fresh"
            ? renderPill("Fresh / Unprovisioned", "is-active")
            : r.verdict === "provisioned-xmpp-on"
              ? renderPill("Provisioned · XMPP open", "is-done")
              : r.verdict === "provisioned-local"
                ? renderPill("Provisioned · XMPP closed", "is-warn")
                : renderPill("Not detected", "is-err");

      const fwPill =
        fwGate?.passes === true
          ? renderPill("4.15.600 · Pass", "is-done")
          : fwGate?.passes === false
            ? renderPill(`Update needed (${fwGate.currentFirmware || "?"})`, "is-warn")
            : renderPill("Not read yet", "");

      const usbPill =
        usbSig?.connected && usbSig?.preflightOk
          ? renderPill("Connected", "is-done")
          : usbSig?.connected
            ? renderPill("Needs attention", "is-warn")
            : renderPill("Not connected", "");

      const usbPlain = usbSig?.connected
        ? usbSig.sysinfoOk
          ? `Harmony Hub detected over USB (${usbSig.sysinfo?.ramSize || "?"} RAM, skin ${usbSig.sysinfo?.skinDecimal ?? usbSig.sysinfo?.skin ?? "?"}).`
          : usbSig.preflightOk
            ? "Harmony Hub responded to read-only USB preflight."
            : `USB device found, but preflight did not complete${usbSig.error ? ` (${usbSig.error})` : ""}.`
        : "No Harmony Hub found on USB. Use a data-capable micro-USB cable (many charging cables have no data wires).";

      const detectedHost = extractDetectedHost(r) || (lanSig?.host && lanSig.host !== "<ip-redacted>" ? lanSig.host : "");
      const lanPill =
        ports["8080"] || ports["8088"] || ports["5222"] || ports["22"]
          ? renderPill(detectedHost || lanSig?.host || "Reachable", "is-done")
          : ssdpSig?.candidateCount > 0
            ? renderPill(`${ssdpSig.candidateCount} via SSDP`, "is-active")
            : renderPill("Offline / Not on Wi-Fi", "");

      const portBadges = lanSig?.host
        ? `Web UI :8080 ${ports["8080"] ? "open" : "closed"} · HBus :8088 ${ports["8088"] ? "open" : "closed"} · XMPP :5222 ${ports["5222"] ? "open" : "closed"} · SSH :22 ${ports["22"] ? "open" : "closed"}`
        : "No LAN IP probed yet (normal for a factory-reset hub before Wi-Fi setup).";

      const nextBranch = deriveRecommendedPath(r, wiz.intent);
      const nextBranchLabel =
        nextBranch === "provisioned"
          ? "Continue with Provisioned Hub Setup"
          : "Continue with Fresh USB Setup";

      statusCardsHtml = `
        <div id="wizardResultCard" style="margin-top:var(--space-4);display:grid;gap:var(--space-3)">
          ${
            mismatch?.hasMismatch
              ? `<div class="notice ${mismatch.severity === "warning" ? "notice-error" : "notice-ok"}" id="wizardMismatchBanner" role="alert">
                   <div style="font-weight:600;margin-bottom:4px">${escapeHtml(mismatch.title)}</div>
                   <div>${escapeHtml(mismatch.message)}</div>
                   <div style="display:flex;gap:var(--space-2);flex-wrap:wrap;margin-top:var(--space-3)">
                     ${
                       mismatch.recommendedIntent
                         ? `<button type="button" class="btn btn-tonal btn-sm" id="wizardSwitchIntentBtn" data-recommended-intent="${escapeHtml(mismatch.recommendedIntent)}" ${wiz.busy ? "disabled" : ""}>
                              Switch to ${mismatch.recommendedIntent === "fresh" ? "Factory reset / starting fresh" : "Already set up with Logitech"}
                            </button>`
                         : ""
                     }
                     ${
                       r.verdict === "melodious-installed" && (detectedHost || wiz.hostInput.trim())
                         ? `<button type="button" class="btn btn-filled btn-sm" id="wizardAlreadyInstalledConnectBtn" ${wiz.busy ? "disabled" : ""}>
                              Connect &amp; Open Hub →
                            </button>`
                         : ""
                     }
                   </div>
                 </div>`
              : ""
          }

          <div class="m-list">
            <div class="m-row" id="wizardVerdictCard">
              <span class="m-row-text">
                <span class="m-row-title" id="wizardVerdictTitle">${escapeHtml(r.verdictLabel || r.verdict)}</span>
                <span class="m-row-sub" id="wizardVerdictSummary">${escapeHtml(r.verdictSummary || "")}</span>
              </span>
              ${verdictPill}
            </div>
            <div class="m-row" id="wizardUsbStatusCard">
              <span class="m-row-text">
                <span class="m-row-title">USB connection</span>
                <span class="m-row-sub" id="wizardUsbSummary">${escapeHtml(usbPlain)}</span>
              </span>
              ${usbPill}
            </div>
            <div class="m-row" id="wizardFirmwareCard">
              <span class="m-row-text">
                <span class="m-row-title" id="wizardFirmwareGateTitle">Firmware gate (4.15.600)</span>
                <span class="m-row-sub" id="wizardFirmwareSummary">${escapeHtml(fwGate?.message || "Connect over USB or LAN to read firmware version.")}</span>
              </span>
              ${fwPill}
            </div>
            <div class="m-row" id="wizardLanStatusCard">
              <span class="m-row-text">
                <span class="m-row-title">Local network &amp; ports</span>
                <span class="m-row-sub" id="wizardLanSummary">${escapeHtml(portBadges)}</span>
              </span>
              ${lanPill}
            </div>
          </div>

          <div style="display:flex;justify-content:flex-end;gap:var(--space-2);flex-wrap:wrap;margin-top:var(--space-2)">
            ${
              r.verdict === "melodious-installed" && (detectedHost || wiz.hostInput.trim())
                ? `<button type="button" class="btn btn-text btn-sm" id="wizardStartFreshBtn" ${wiz.busy ? "disabled" : ""}>
                     Start fresh / Factory reset…
                   </button>
                   <button type="button" class="btn btn-filled" id="wizardSkipToStep3Btn" ${wiz.busy ? "disabled" : ""}>
                     Connect &amp; Open Hub →
                   </button>`
                : `<button type="button" class="btn btn-filled" id="wizardToStep2Btn" data-next-branch="${escapeHtml(nextBranch)}" ${wiz.busy ? "disabled" : ""}>
                     ${escapeHtml(nextBranchLabel)} →
                   </button>`
            }
          </div>
        </div>
      `;
    }

    return `
      <div class="wiz-intro">
        <span class="eyebrow">Step 1 of 3 · Detect &amp; Classify</span>
        <h2>How is your Harmony Hub set up right now?</h2>
        <p>Melodious checks your hub over USB and your local network first (read-only — nothing is changed yet) and picks the safest setup path.</p>
      </div>

      ${renderWedgeBanner(wiz)}
      ${renderFactoryResetBanner(wiz)}

      <fieldset class="wiz-choices" style="margin-bottom:var(--space-4)">
        <legend class="sr-only" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)">Hub setup state</legend>
        <label class="setup-wiz-choice ${wiz.intent === "provisioned" ? "is-selected" : ""}" id="wizardIntentProvisionedLabel">
          <input type="radio" name="wizardIntent" id="wizardIntentProvisioned" value="provisioned" ${wiz.intent === "provisioned" ? "checked" : ""} ${wiz.busy ? "disabled" : ""}>
          <span class="wiz-choice-text">
            <strong style="display:block;font-size:var(--fs-body-lg)">Already set up with Logitech</strong>
            <span class="muted" style="font-size:var(--fs-body-sm)">Already on your Wi-Fi network from the Harmony app. Roots over LAN (XMPP) or USB and keeps your existing devices.</span>
          </span>
        </label>
        <label class="setup-wiz-choice ${wiz.intent === "fresh" ? "is-selected" : ""}" id="wizardIntentFreshLabel">
          <input type="radio" name="wizardIntent" id="wizardIntentFresh" value="fresh" ${wiz.intent === "fresh" ? "checked" : ""} ${wiz.busy ? "disabled" : ""}>
          <span class="wiz-choice-text">
            <strong style="display:block;font-size:var(--fs-body-lg)">Factory reset / starting fresh</strong>
            <span class="muted" style="font-size:var(--fs-body-sm)">Brand-new, freshly wiped, or second-hand hub. Activates and roots over a USB cable with zero Logitech cloud contact.</span>
          </span>
        </label>
      </fieldset>

      <div class="m-card m-form" id="wizardStep1Controls">
        <div class="setup-grid-2" style="align-items:end">
          <div class="m-field">
            <label for="wizardHostInput">Hub LAN IP address (optional)</label>
            <input id="wizardHostInput" type="text" autocomplete="off" spellcheck="false" placeholder="Auto-detect via SSDP or USB" value="${escapeHtml(wiz.hostInput)}" ${wiz.busy ? "disabled" : ""}>
          </div>
          <div style="display:flex;flex-direction:column;gap:8px;padding-bottom:6px">
            <label style="display:flex;align-items:center;gap:8px;font-size:var(--fs-body-sm);cursor:pointer">
              <input type="checkbox" id="wizardIncludeUsb" ${wiz.includeUsb ? "checked" : ""} ${wiz.busy ? "disabled" : ""}>
              <span>Check USB HID (046D:C129)</span>
            </label>
            <label style="display:flex;align-items:center;gap:8px;font-size:var(--fs-body-sm);cursor:pointer">
              <input type="checkbox" id="wizardMaskIds" ${wiz.maskIds ? "checked" : ""} ${wiz.busy ? "disabled" : ""}>
              <span>Redact IP &amp; Hub ID on screen</span>
            </label>
          </div>
        </div>

        <div style="display:flex;gap:var(--space-2);flex-wrap:wrap;align-items:center;justify-content:space-between">
          <button type="button" class="btn btn-filled" id="wizardDetectBtn" ${wiz.busy ? "disabled" : ""}>
            ${wiz.busy && wiz.busyAction === "detect" ? '<span class="m-spinner" style="border-color:var(--on-primary);border-right-color:transparent" aria-hidden="true"></span>' : ""}
            <span>${wiz.busy && wiz.busyAction === "detect" ? "Detecting hub…" : "Detect hub (LAN + USB)"}</span>
          </button>
          ${
            !r
              ? `<button type="button" class="btn btn-text btn-sm" id="wizardSkipDetectBtn" ${wiz.busy ? "disabled" : ""}>Skip to Step 2 checklist →</button>`
              : ""
          }
        </div>
      </div>

      ${renderLiveProgressCard(wiz)}
      ${statusCardsHtml}
      ${renderDevOverridesAccordion(wiz)}
    `;
  }

  function renderInstallSourceRadios(wiz) {
    return `
      <div style="display:flex;gap:var(--space-4);flex-wrap:wrap;margin:var(--space-1) 0">
        <label style="display:inline-flex;align-items:center;gap:8px;font-size:var(--fs-body-sm);cursor:pointer">
          <input type="radio" name="wizardInstallSource" id="wizardInstallSourceLatest" value="latest" ${wiz.installSource !== "local" ? "checked" : ""} ${wiz.busy ? "disabled" : ""}>
          <span>Latest GitHub Release (SHA-256 verified)</span>
        </label>
        <label style="display:inline-flex;align-items:center;gap:8px;font-size:var(--fs-body-sm);cursor:pointer">
          <input type="radio" name="wizardInstallSource" id="wizardInstallSourceLocal" value="local" ${wiz.installSource === "local" ? "checked" : ""} ${wiz.busy ? "disabled" : ""}>
          <span>Choose Hub Zip on this Mac…</span>
        </label>
      </div>
    `;
  }

  function renderStep2Provisioned(wiz) {
    const st = computeProvisionedChecklistStatus(wiz);
    const xmppClosedNeedsAction = !st.port5222 && !st.rootDone;

    return `
      <div id="wizardStep2Provisioned" style="display:grid;gap:var(--space-3)">
        <div class="m-card m-form">
          <div class="setup-grid-2">
            <div class="m-field">
              <label for="wizardProvHostInput">Hub LAN IP address</label>
              <input id="wizardProvHostInput" type="text" autocomplete="off" spellcheck="false" placeholder="192.168.0.235" value="${escapeHtml(wiz.confirmedHost || wiz.hostInput)}" ${wiz.busy ? "disabled" : ""}>
            </div>
            <div class="m-field">
              <label for="wizardProvHubIdInput">Numeric Hub ID (from hub provisioning)</label>
              <input id="wizardProvHubIdInput" type="text" inputmode="numeric" autocomplete="off" placeholder="e.g. 15984321" value="${escapeHtml(wiz.provHubIdInput)}" ${wiz.busy ? "disabled" : ""}>
            </div>
          </div>
          <p class="m-field-hint" style="margin:0">
            Detected automatically when unmasked. Must be a positive integer matching the hub's provisioned <code>activeRemoteId</code>.
          </p>
        </div>

        ${
          xmppClosedNeedsAction
            ? `<div class="setup-stage is-current" id="wizardXmppClosedCard">
                 <div class="setup-stage-head">
                   <div style="display:flex;align-items:center;gap:10px">
                     <span class="setup-stage-num">!</span>
                     <strong>XMPP port 5222 is closed on this hub</strong>
                   </div>
                   ${renderPill("XMPP closed", "is-warn")}
                 </div>
                 <p class="muted" style="font-size:var(--fs-body-sm)">
                   To root over your network, open the <strong>Harmony mobile app</strong> → <strong>Menu → Harmony Setup → Add/Edit Devices &amp; Activities → Remote &amp; Hub → Enable XMPP</strong>, then click <strong>Re-check Hub</strong>.
                 </p>
                 <p class="muted" style="font-size:var(--fs-body-sm)">
                   Or, if your hub is plugged into this Mac with a data USB cable, you can root it directly over USB (preserving your devices) or factory-reset it safely ("1" marker only) to start fresh.
                 </p>
                 <div style="display:flex;gap:var(--space-2);flex-wrap:wrap">
                   <button type="button" class="btn btn-tonal btn-sm" id="wizardRecheckBtn" ${wiz.busy ? "disabled" : ""}>Re-check Hub</button>
                   <button type="button" class="btn btn-filled btn-sm" id="wizardProvUsbRootBtn" ${wiz.busy ? "disabled" : ""}>Root over USB instead</button>
                   <button type="button" class="btn btn-danger btn-sm" id="wizardProvFactoryResetBtn" ${wiz.busy ? "disabled" : ""}>Factory reset ("1") &amp; start fresh…</button>
                 </div>
               </div>`
            : ""
        }

        <div class="setup-stage ${st.rootDone ? "is-done" : !xmppClosedNeedsAction ? "is-current" : ""}" id="provStageRoot">
          <div class="setup-stage-head">
            <div style="display:flex;align-items:center;gap:10px">
              <span class="setup-stage-num">1</span>
              <strong>Enable Root SSH (Dropbear on port 22)</strong>
            </div>
            ${st.rootDone ? renderPill("SSH :22 Open", "is-done") : renderPill("Pending", "")}
          </div>
          <p class="muted" style="font-size:var(--fs-body-sm)">
            Installs persistent key-only root SSH using <code>~/.ssh/harmony_owner_ed25519</code> without opening a terminal.
          </p>
          <div style="display:flex;gap:var(--space-2);flex-wrap:wrap">
            <button type="button" class="btn ${st.rootDone ? "btn-outlined" : "btn-tonal"} btn-sm" id="wizardRunLanRootBtn" ${wiz.busy ? "disabled" : ""}>
              ${st.rootDone ? "Re-run LAN Root (XMPP)" : "1. Root Hub (XMPP)"}
            </button>
          </div>
        </div>

        <div class="setup-stage ${st.installDone ? "is-done" : st.rootDone ? "is-current" : ""}" id="provStageInstall">
          <div class="setup-stage-head">
            <div style="display:flex;align-items:center;gap:10px">
              <span class="setup-stage-num">2</span>
              <strong>Install Melodious Web UI</strong>
            </div>
            ${
              st.installDone
                ? renderPill(`Installed ${wiz.installedVersion || ""}`.trim(), "is-done")
                : wiz.preflightPassed
                  ? renderPill("Preflight ALLOWED", "is-active")
                  : renderPill("Pending", "")
            }
          </div>
          <p class="muted" style="font-size:var(--fs-body-sm)">
            Stages all binaries and plugins in RAM, checks flash headroom, enables the Logitech cloud blocker, removes root-tool staging leftovers, and verifies port 8080 after reboot.
          </p>
          ${renderInstallSourceRadios(wiz)}
          <div style="display:flex;gap:var(--space-2);flex-wrap:wrap">
            ${
              !st.rootDone && st.port5222
                ? `<button type="button" class="btn btn-filled" id="wizardProvRunAllBtn" ${wiz.busy ? "disabled" : ""}>
                     Root &amp; Install Melodious
                   </button>`
                : ""
            }
            <button type="button" class="btn ${st.rootDone || !st.port5222 ? "btn-filled" : "btn-tonal"}" id="wizardInstallMelodiousBtn" ${wiz.busy ? "disabled" : ""}>
              ${wiz.installSource === "local" ? "Choose Hub Zip & Install…" : "2. Install Melodious"}
            </button>
            <button type="button" class="btn btn-outlined btn-sm" id="wizardRunPreflightBtn" ${wiz.busy ? "disabled" : ""}>
              Preflight Check Only
            </button>
          </div>
        </div>
      </div>
    `;
  }

  function renderStep2Fresh(wiz) {
    const st = computeFreshChecklistStatus(wiz);
    const fwGate = wiz.classifyResult?.firmwareGate;
    const currentFw = fwGate?.currentFirmware || "";

    const wifiRowsHtml =
      wiz.wifiNetworks.length > 0
        ? `<div class="setup-wifi-list" id="freshWifiNetworkList" role="listbox" aria-label="Visible Wi-Fi networks">
             ${wiz.wifiNetworks
               .map((net, idx) => {
                 const ssid = String(net.ssid || "");
                 const enc = String(net.encryption || net.security || "WPA2-PSK");
                 const sig = net.signal_strength ?? net.signalStrength ?? "";
                 const picked = ssid && ssid === wiz.wifiSsid;
                 return `<button type="button" class="setup-wifi-item ${picked ? "is-picked" : ""}" data-wifi-idx="${idx}" ${wiz.busy ? "disabled" : ""}>
                   <span style="font-weight:500">${escapeHtml(ssid || "(Hidden network)")}</span>
                   <span class="muted" style="font-size:var(--fs-caption)">${escapeHtml(enc)}${sig !== "" ? ` · signal ${escapeHtml(sig)}` : ""}</span>
                 </button>`;
               })
               .join("")}
           </div>`
        : wiz.wifiScanned
          ? `<p class="m-field-hint" style="margin:0">No visible 2.4 GHz networks returned. Enter your network SSID manually below (Harmony Hub supports 2.4 GHz Wi-Fi only).</p>`
          : "";

    return `
      <div id="wizardStep2Fresh" style="display:grid;gap:var(--space-3)">
        <!-- 1. Firmware Check (4.15.600) -->
        <div class="setup-stage ${st.fwDone ? "is-done" : st.currentStage === 1 ? "is-current" : ""}" id="freshStageFirmware">
          <div class="setup-stage-head">
            <div style="display:flex;align-items:center;gap:10px">
              <span class="setup-stage-num">1</span>
              <strong>Firmware Check (4.15.600)</strong>
            </div>
            ${
              st.fwDone
                ? renderPill("4.15.600 Ready", "is-done")
                : fwGate?.passes === false
                  ? renderPill(`Found ${currentFw} · Update required`, "is-warn")
                  : renderPill("Check / Update", "")
            }
          </div>
          <p class="muted" style="font-size:var(--fs-body-sm)">
            ${
              st.fwDone
                ? "Connected hub is running required firmware 4.15.600."
                : "Melodious requires official Logitech signed firmware 4.15.600 (the tool verifies your hub's skin against Description.xml before flashing)."
            }
          </p>
          <div style="display:flex;gap:var(--space-2);flex-wrap:wrap">
            ${
              !st.fwDone
                ? `<button type="button" class="btn btn-filled btn-sm" id="freshFlashFirmwareBtn" ${wiz.busy ? "disabled" : ""}>
                     Choose .hfw2 &amp; Update Firmware…
                   </button>`
                : `<button type="button" class="btn btn-outlined btn-sm" id="freshFlashFirmwareBtn" ${wiz.busy ? "disabled" : ""}>
                     Re-flash .hfw2 Firmware…
                   </button>`
            }
            <button type="button" class="btn btn-tonal btn-sm" id="wizardRecheckBtn" ${wiz.busy ? "disabled" : ""}>
              Re-check USB &amp; Firmware
            </button>
            <button type="button" class="btn btn-danger btn-sm" id="freshFactoryResetBtn" ${wiz.busy ? "disabled" : ""}>
              Factory Reset Hub ("1" only)…
            </button>
          </div>
        </div>

        <!-- 2. Connect Wi-Fi -->
        <div class="setup-stage ${st.wifiDone ? "is-done" : st.currentStage === 2 ? "is-current" : ""}" id="freshStageWifi">
          <div class="setup-stage-head">
            <div style="display:flex;align-items:center;gap:10px">
              <span class="setup-stage-num">2</span>
              <strong>Connect Wi-Fi (2.4 GHz)</strong>
            </div>
            ${
              st.wifiDone
                ? renderPill(`Connected · ${(wiz.confirmedHost || wiz.hostInput).trim()}`, "is-done")
                : wiz.wifiConnected
                  ? renderPill("Confirm Hub IP", "is-warn")
                  : renderPill("Pending", "")
            }
          </div>
          <p class="muted" style="font-size:var(--fs-body-sm)">
            Scan visible 2.4 GHz networks over USB and send your Wi-Fi credentials privately over local <code>stdin</code> (never command-line flags).
          </p>
          <div>
            <button type="button" class="btn btn-tonal btn-sm" id="freshWifiScanBtn" ${wiz.busy ? "disabled" : ""}>
              Scan Wi-Fi Networks
            </button>
          </div>
          ${wifiRowsHtml}
          <div class="setup-grid-2">
            <div class="m-field">
              <label for="wizardWifiSsidInput">Wi-Fi SSID</label>
              <input id="wizardWifiSsidInput" type="text" autocomplete="off" spellcheck="false" placeholder="2.4 GHz network name" value="${escapeHtml(wiz.wifiSsid)}" ${wiz.busy ? "disabled" : ""}>
            </div>
            <div class="m-field">
              <label for="wizardWifiEncSelect">Security</label>
              <select id="wizardWifiEncSelect" style="min-height:44px;padding:0 12px;border-radius:var(--shape-sm);background:var(--surface-lowest);color:var(--on-surface);border:1px solid var(--outline-variant)" ${wiz.busy ? "disabled" : ""}>
                <option value="WPA2-PSK" ${wiz.wifiEncryption === "WPA2-PSK" ? "selected" : ""}>WPA2-PSK</option>
                <option value="WPA-PSK" ${wiz.wifiEncryption === "WPA-PSK" ? "selected" : ""}>WPA-PSK</option>
                <option value="OPEN" ${wiz.wifiEncryption === "OPEN" ? "selected" : ""}>Open (no password)</option>
              </select>
            </div>
          </div>
          <div class="setup-grid-2" style="align-items:end">
            <div class="m-field">
              <label for="wizardWifiPassInput">Wi-Fi Password</label>
              <input id="wizardWifiPassInput" type="password" autocomplete="off" placeholder="${wiz.wifiEncryption === "OPEN" ? "None for open network" : "Sent via stdin pipe only"}" value="${escapeHtml(wiz.wifiPassword)}" ${wiz.busy || wiz.wifiEncryption === "OPEN" ? "disabled" : ""}>
            </div>
            <div>
              <button type="button" class="btn btn-filled btn-block" id="freshWifiConnectBtn" ${wiz.busy ? "disabled" : ""}>
                Connect Hub to Wi-Fi
              </button>
            </div>
          </div>
          <div class="setup-grid-2" style="align-items:end;padding-top:var(--space-1)">
            <div class="m-field">
              <label for="freshConfirmedHostInput">Hub LAN IP address (auto-detected or enter from router)</label>
              <input id="freshConfirmedHostInput" type="text" autocomplete="off" spellcheck="false" placeholder="e.g. 192.168.0.235" value="${escapeHtml(wiz.confirmedHost || wiz.hostInput)}" ${wiz.busy ? "disabled" : ""}>
            </div>
            <div>
              <button type="button" class="btn btn-outlined btn-block" id="freshVerifyLanBtn" ${wiz.busy ? "disabled" : ""}>
                Detect / Verify Hub IP
              </button>
            </div>
          </div>
        </div>

        <!-- 3. Unlock & Prepare Hub -->
        <div class="setup-stage ${st.prepDone ? "is-done" : st.currentStage === 3 ? "is-current" : ""}" id="freshStagePrepare">
          <div class="setup-stage-head">
            <div style="display:flex;align-items:center;gap:10px">
              <span class="setup-stage-num">3</span>
              <strong>Unlock &amp; Prepare Hub</strong>
            </div>
            ${st.prepDone ? renderPill("Prepared", "is-done") : renderPill("Pending", "")}
          </div>
          <p class="muted" style="font-size:var(--fs-body-sm)">
            Opens the TDE file gate (<code>/tde/enable</code>), writes offline mode-3 provisioning with a numeric Hub ID (rebooting the hub), and seeds <code>AutomationConfig</code>.
          </p>
          <div style="display:flex;gap:var(--space-2);flex-wrap:wrap">
            ${renderPill(`1. TDE Gate${wiz.tdeDone ? " ✓" : ""}`, wiz.tdeDone ? "is-done" : "")}
            ${renderPill(`2. Local Provision${wiz.provisionLocalDone ? " ✓" : ""}`, wiz.provisionLocalDone ? "is-done" : "")}
            ${renderPill(`3. Automation Seed${wiz.seedAutomationDone ? " ✓" : ""}`, wiz.seedAutomationDone ? "is-done" : "")}
          </div>
          <div class="setup-grid-2">
            <div class="m-field">
              <label for="wizardRemoteIdInput">Numeric Hub ID (positive integer, never a string)</label>
              <input id="wizardRemoteIdInput" type="text" inputmode="numeric" autocomplete="off" value="${escapeHtml(wiz.remoteIdInput)}" ${wiz.busy ? "disabled" : ""}>
            </div>
            <div class="m-field">
              <label for="wizardHubNameInput">Hub friendly name</label>
              <input id="wizardHubNameInput" type="text" autocomplete="off" value="${escapeHtml(wiz.hubNameInput)}" ${wiz.busy ? "disabled" : ""}>
            </div>
          </div>
          <div style="display:flex;gap:var(--space-2);flex-wrap:wrap">
            <button type="button" class="btn ${st.prepDone ? "btn-outlined" : "btn-filled"}" id="freshPrepareHubBtn" ${wiz.busy ? "disabled" : ""}>
              ${st.prepDone ? "Re-run Unlock & Prepare" : "Unlock & Prepare Hub"}
            </button>
          </div>
        </div>

        <!-- 4. Root & Install Melodious -->
        <div class="setup-stage ${st.installDone ? "is-done" : st.currentStage === 4 ? "is-current" : ""}" id="freshStageInstall">
          <div class="setup-stage-head">
            <div style="display:flex;align-items:center;gap:10px">
              <span class="setup-stage-num">4</span>
              <strong>Root &amp; Install Melodious</strong>
            </div>
            ${
              st.installDone
                ? renderPill(`Installed ${wiz.installedVersion || ""}`.trim(), "is-done")
                : wiz.sshOpen
                  ? renderPill("SSH :22 Open · Ready to install", "is-active")
                  : renderPill("Pending", "")
            }
          </div>
          <p class="muted" style="font-size:var(--fs-body-sm)">
            Stages Dropbear SSH over USB, verifies port 22 on LAN, runs first-time <code>install_webui.py</code>, and waits for the Melodious Web UI on port 8080.
          </p>
          <div style="display:flex;gap:var(--space-2);flex-wrap:wrap">
            ${renderPill(`USB Root (:22)${wiz.sshOpen ? " ✓" : ""}`, wiz.sshOpen ? "is-done" : "")}
            ${renderPill(`Melodious (:8080)${wiz.installDone ? " ✓" : ""}`, wiz.installDone ? "is-done" : "")}
          </div>
          ${renderInstallSourceRadios(wiz)}
          <div style="display:flex;gap:var(--space-2);flex-wrap:wrap">
            <button type="button" class="btn btn-filled" id="freshRootAndInstallBtn" ${wiz.busy ? "disabled" : ""}>
              ${
                wiz.sshOpen
                  ? wiz.installSource === "local"
                    ? "Choose Hub Zip & Install Melodious…"
                    : "Install Melodious"
                  : wiz.installSource === "local"
                    ? "Root & Choose Hub Zip to Install…"
                    : "Root & Install Melodious"
              }
            </button>
            <button type="button" class="btn btn-outlined btn-sm" id="wizardRunPreflightBtn" ${wiz.busy ? "disabled" : ""}>
              Preflight Check Only
            </button>
          </div>
        </div>
      </div>
    `;
  }

  function renderStep2(wiz) {
    const isProv = wiz.flowPath === "provisioned";
    return `
      <div class="wiz-intro">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:var(--space-2);flex-wrap:wrap">
          <span class="eyebrow">Step 2 of 3 · ${isProv ? "Provisioned Hub Root & Install" : "Fresh Hub USB Setup & Install"}</span>
          <div style="display:flex;gap:6px">
            <button type="button" class="btn ${!isProv ? "btn-tonal" : "btn-text"} btn-sm" id="wizardBranchFreshBtn" ${wiz.busy ? "disabled" : ""}>Fresh (USB)</button>
            <button type="button" class="btn ${isProv ? "btn-tonal" : "btn-text"} btn-sm" id="wizardBranchProvisionedBtn" ${wiz.busy ? "disabled" : ""}>Provisioned (LAN)</button>
          </div>
        </div>
        <h2>${isProv ? "Root & install Melodious on your hub" : "Prepare, root & install Melodious"}</h2>
        <p>${
          isProv
            ? "Keep the hub powered on and on the same network as this Mac."
            : "Follow the four steps in order with the hub plugged into this Mac via a data USB cable."
        }</p>
      </div>

      ${renderWedgeBanner(wiz)}
      ${renderFactoryResetBanner(wiz)}
      ${isProv ? renderStep2Provisioned(wiz) : renderStep2Fresh(wiz)}
      ${renderLiveProgressCard(wiz)}

      <div style="display:flex;align-items:center;justify-content:space-between;gap:var(--space-2);margin-top:var(--space-4)">
        <button type="button" class="btn btn-outlined" id="wizardBackToStep1Btn" ${wiz.busy ? "disabled" : ""}>
          ← Back to Step 1
        </button>
        ${
          wiz.installDone
            ? `<button type="button" class="btn btn-filled" id="wizardToStep3Btn" ${wiz.busy ? "disabled" : ""}>
                 Continue to Step 3 →
               </button>`
            : ""
        }
      </div>

      ${renderDevOverridesAccordion(wiz)}
    `;
  }

  function renderStep3Handoff(wiz) {
    const targetHost = wiz.handoffHost || wiz.confirmedHost || wiz.hostInput || "";
    const targetUrl = targetHost ? `http://${targetHost}:${wiz.handoffPort || 8080}` : "http://<hub-ip>:8080";

    return `
      <div class="wiz-intro">
        <span class="eyebrow">Step 3 of 3 · Ready to Use</span>
        <h2>Melodious is running on your hub</h2>
        <p>Your hub is rooted, cloud-blocked, and connected to Melodious on this Mac.</p>
      </div>

      <div class="m-card" id="wizardStep3ConnectedCard" style="display:grid;gap:var(--space-3);margin-bottom:var(--space-4)">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:var(--space-3);flex-wrap:wrap">
          <div style="display:flex;align-items:center;gap:12px">
            <span class="m-dot ${wiz.handoffConnected ? "is-live" : ""}" aria-hidden="true"></span>
            <div>
              <div style="font-weight:600;font-size:var(--fs-body-lg)" id="wizardHandoffAddress">${escapeHtml(targetUrl)}</div>
              <div class="muted" style="font-size:var(--fs-body-sm)">
                ${
                  wiz.handoffConnected
                    ? `Connected${wiz.installedVersion ? ` · Melodious ${wiz.installedVersion}` : ""}${wiz.handoffFirmware ? ` · Firmware ${wiz.handoffFirmware}` : ""}`
                    : wiz.handoffError
                      ? escapeHtml(wiz.handoffError)
                      : "Connecting desktop app to hub…"
                }
              </div>
            </div>
          </div>
          ${wiz.handoffConnected ? renderPill("Connected", "is-done") : renderPill("Pending", "is-warn")}
        </div>
        ${
          wiz.handoffError
            ? `<div style="display:flex;gap:var(--space-2)">
                 <button type="button" class="btn btn-tonal btn-sm" id="wizardRetryHandoffBtn" ${wiz.busy ? "disabled" : ""}>Retry connection</button>
               </div>`
            : ""
        }
      </div>

      <h3 class="m-section">What to do first in the hub web UI</h3>
      <div class="m-list" id="wizardPostInstallChecklist">
        <div class="m-row">
          <span class="setup-stage-num" style="background:var(--primary-container);color:var(--on-primary-container)">1</span>
          <span class="m-row-text">
            <span class="m-row-title">Add your first device</span>
            <span class="m-row-sub">Open <strong>Devices → Add device</strong> to import codes from the Logitech catalog, network/Bluetooth discovery, or IR learning.</span>
          </span>
        </div>
        <div class="m-row">
          <span class="setup-stage-num" style="background:var(--primary-container);color:var(--on-primary-container)">2</span>
          <span class="m-row-text">
            <span class="m-row-title">Create your first activity</span>
            <span class="m-row-sub">Open <strong>Activities → Add activity</strong> to set power order, inputs, and buttons — works immediately on a fresh hub with no extra reboot.</span>
          </span>
        </div>
        <div class="m-row">
          <span class="setup-stage-num" style="background:var(--primary-container);color:var(--on-primary-container)">3</span>
          <span class="m-row-text">
            <span class="m-row-title">Pair your remote</span>
            <span class="m-row-sub">Open <strong>Settings → Remotes</strong>, start pairing, and hold <strong>Menu + Mute</strong> on your Harmony remote for ~5 seconds.</span>
          </span>
        </div>
      </div>

      <div style="display:flex;align-items:center;justify-content:space-between;gap:var(--space-3);margin-top:var(--space-5)">
        <button type="button" class="btn btn-outlined" id="wizardBackToStep2Btn" ${wiz.busy ? "disabled" : ""}>
          ← Back to Step 2
        </button>
        <button type="button" class="btn btn-filled" id="wizardOpenHubBtn" ${wiz.busy ? "disabled" : ""}>
          Open Hub →
        </button>
      </div>
    `;
  }

  function renderDevOverridesAccordion(wiz) {
    return `
      <details class="setup-dev-accordion" id="wizardDevOverrides">
        <summary>Developer / Manual Step Overrides</summary>
        <div style="display:grid;gap:var(--space-3);margin-top:var(--space-3)">
          <p class="m-field-hint" style="margin:0">
            Individual troubleshooting actions for recovery or single-step diagnostics. Every write/reboot action asks for confirmation first.
          </p>
          <div style="display:flex;gap:var(--space-2);flex-wrap:wrap">
            <button type="button" class="btn btn-outlined btn-sm" data-wizard-manual-action="usb-preflight" ${wiz.busy ? "disabled" : ""}>USB Preflight</button>
            <button type="button" class="btn btn-outlined btn-sm" data-wizard-manual-action="usb-wifi-scan" ${wiz.busy ? "disabled" : ""}>USB Wi-Fi Scan</button>
            <button type="button" class="btn btn-outlined btn-sm" data-wizard-manual-action="usb-wifi-status" ${wiz.busy ? "disabled" : ""}>USB Wi-Fi Status</button>
            <button type="button" class="btn btn-tonal btn-sm" data-wizard-manual-action="usb-wifi-connect" ${wiz.busy ? "disabled" : ""}>USB Wi-Fi Connect</button>
            <button type="button" class="btn btn-tonal btn-sm" data-wizard-manual-action="usb-flash-firmware" ${wiz.busy ? "disabled" : ""}>USB Flash .hfw2…</button>
            <button type="button" class="btn btn-danger btn-sm" data-wizard-manual-action="usb-factory-reset" ${wiz.busy ? "disabled" : ""}>USB Factory Reset ("1")</button>
            <button type="button" class="btn btn-tonal btn-sm" data-wizard-manual-action="usb-tde-enable" ${wiz.busy ? "disabled" : ""}>USB TDE Enable</button>
            <button type="button" class="btn btn-tonal btn-sm" data-wizard-manual-action="usb-provision-local" ${wiz.busy ? "disabled" : ""}>USB Provision Local</button>
            <button type="button" class="btn btn-tonal btn-sm" data-wizard-manual-action="usb-seed-automation" ${wiz.busy ? "disabled" : ""}>USB Seed Automation</button>
            <button type="button" class="btn btn-tonal btn-sm" data-wizard-manual-action="usb-root" ${wiz.busy ? "disabled" : ""}>USB Root</button>
            <button type="button" class="btn btn-tonal btn-sm" data-wizard-manual-action="lan-root-xmpp" ${wiz.busy ? "disabled" : ""}>LAN Root (XMPP)</button>
          </div>
          <div style="padding-top:var(--space-2);border-top:1px solid var(--divider);display:grid;gap:var(--space-2)">
            <label style="display:flex;align-items:flex-start;gap:8px;font-size:var(--fs-caption);cursor:pointer">
              <input type="checkbox" id="wizardAllowUnprovenPost" ${wiz.allowUnprovenPost ? "checked" : ""} ${wiz.busy ? "disabled" : ""}>
              <span><strong>EXPERIMENTAL:</strong> Unlock unproven HTTP POST root transport (<code>post-root</code> on :8088 — smoke-tested only, prefer USB or XMPP).</span>
            </label>
            <div>
              <button type="button" class="btn btn-outlined btn-sm" data-wizard-manual-action="post-root" ${wiz.busy || !wiz.allowUnprovenPost ? "disabled" : ""}>
                Experimental POST Root (:8088)
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
        </div>
      </details>
    `;
  }

  function renderWizardPage(wiz) {
    return `
      <div class="wiz" id="hubSetupWizard" data-current-step="${escapeHtml(wiz.step)}">
        <div class="wiz-body">
          ${renderProgressHeader(wiz.step)}
          ${
            wiz.step === 1
              ? renderStep1Detect(wiz)
              : wiz.step === 2
                ? renderStep2(wiz)
                : renderStep3Handoff(wiz)
          }
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
    createInitialWizardState,
    computeFreshChecklistStatus,
    computeProvisionedChecklistStatus,
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
