"use strict";

// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Matthew Gibbons (Melodious — LICENSE section 2)
//
// First-time Melodious installer integration for the Root & Setup Wizard (Slice 3).
//
// Why desktop/src/hub-update.js (hub_update.sh) cannot be used for initial install:
//   1. hub_update.sh explicitly checks `/data/codex/hub_id` (`hub_id no`) and refuses
//      uninstalled hubs ("This hub has no Melodious setup yet. Install it once with the installer.").
//   2. hub_update.sh only replaces an already-installed subset of files and does NOT write
//      initial configuration or boot/blocker/manifest files (`/data/codex/hub_id`,
//      `/data/codex/cloud_blocker.conf`, `/data/codexmqtt/config.json`,
//      `/pkg/codexactivity/manifest.json`, `/pkg/codexmqtt/manifest.json`), Dropbear
//      symlinks, handoff backups, or initial `codex_hbus ... harmony.automation?discover`
//      registration.
//
// Instead, installFreshHub() verifies a Melodious hub release zip (`latest` from GitHub
// checked against SHA256SUMS.txt, or a `local` zip chosen via native main-process dialog
// and verified via readLocalHubZip()), stages the verified `payload/` directory alongside
// a copy of `install_webui.py` in a private temporary directory, runs `install_webui.py`
// non-interactively, streams progress over `desktop:wizard-event`, verifies `verdict=ALLOWED`
// and exit code 0, checks `:8080` reachability via `probeHub`, and removes the temp
// directory in `finally`.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { normalizeHost } = require("../settings");
const { probeHub } = require("../discovery");
const { RELEASES_URL, isGitHubUrl, latestHubRelease } = require("../updates");
const { downloadVerified } = require("../self-update");
const { readLocalHubZip } = require("../hub-update");
const { resolvePythonExecutable } = require("./bridge");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const DEFAULT_INSTALLER_SCRIPT = path.join(REPO_ROOT, "install_webui.py");
const DEFAULT_HELPERS_DIR = path.join(REPO_ROOT, "payload", "helpers");
const INSTALLER_HELPER_NAMES = Object.freeze([
  "codex_flash_free",
  "hal_multiremote_patch.json",
  "hal_remotes_patch.json",
]);

const ALLOWED_INSTALL_SOURCES = new Set(["latest", "local"]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function validatePositiveHubId(hubId) {
  if (typeof hubId !== "number" || !Number.isSafeInteger(hubId) || hubId <= 0) {
    throw new Error("Invalid hubId: must be a strictly positive integer (never a string)");
  }
  return hubId;
}

function validateInstallerHost(rawHost) {
  const s = String(rawHost ?? "");
  if (/[\r\n\u0000]/.test(s)) {
    throw new Error("Invalid hub host");
  }
  const trimmed = s.trim();
  if (!trimmed) {
    throw new Error("Hub IP address or hostname is required for Melodious installation");
  }
  if (/\s/.test(trimmed) || trimmed.startsWith("-")) {
    throw new Error("Invalid hub host");
  }
  const normalized = normalizeHost(trimmed);
  if (!normalized || normalized.startsWith("-")) {
    throw new Error("Invalid hub host");
  }
  return normalized;
}

function validateSafeOptionalPath(rawPath, label) {
  const s = String(rawPath ?? "");
  if (/[\r\n\u0000]/.test(s)) {
    throw new Error(`Invalid ${label}`);
  }
  const trimmed = s.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("-")) {
    throw new Error(`Invalid ${label}`);
  }
  return trimmed;
}

function buildInstallerArgs({
  installerPath,
  host,
  hubId,
  keyPath = "",
  sshPort = 22,
  preflightOnly = false,
  removeRootToolLeftovers = true,
} = {}) {
  const cleanInstallerPath = validateSafeOptionalPath(installerPath, "installer script path");
  if (!cleanInstallerPath) {
    throw new Error("Installer script path is required");
  }
  const cleanHost = validateInstallerHost(host);
  const validHubId = validatePositiveHubId(hubId);
  const cleanKeyPath = validateSafeOptionalPath(keyPath, "SSH key path");
  const numericPort = Number(sshPort ?? 22);
  if (!Number.isInteger(numericPort) || numericPort < 1 || numericPort > 65535) {
    throw new Error("Invalid SSH port");
  }

  const args = [
    cleanInstallerPath,
    "--hub-host",
    cleanHost,
    "--hub-id",
    String(validHubId),
    "--no-prompt",
    "--mqtt-disabled",
  ];

  if (numericPort !== 22) {
    args.push("--port", String(numericPort));
  }
  if (cleanKeyPath) {
    args.push("--key-path", cleanKeyPath);
  }
  if (removeRootToolLeftovers !== false) {
    args.push("--remove-root-tool-leftovers");
  }
  if (preflightOnly === true) {
    args.push("--preflight-only");
  }
  return args;
}

function stageInstallerWorkspace({
  tempDir,
  verifiedPayload,
  installerScriptPath = DEFAULT_INSTALLER_SCRIPT,
  helpersDirPath = DEFAULT_HELPERS_DIR,
}) {
  if (!verifiedPayload || !Array.isArray(verifiedPayload.files) || verifiedPayload.files.length === 0) {
    throw new Error("Verified hub payload contains no files");
  }
  if (!fs.existsSync(installerScriptPath)) {
    throw new Error(`Missing installer script at ${installerScriptPath}`);
  }

  const payloadRoot = path.resolve(tempDir, "payload");
  fs.mkdirSync(payloadRoot, { recursive: true });

  const binEntries = [];
  for (const file of verifiedPayload.files) {
    const rel = String(file?.rel || "");
    const parts = rel.split("/");
    if (!rel.startsWith("payload/") || parts.some((seg) => !seg || seg === "." || seg === "..")) {
      throw new Error(`Unsafe payload relative path: ${rel}`);
    }
    const targetPath = path.resolve(tempDir, ...parts);
    if (!targetPath.startsWith(payloadRoot + path.sep)) {
      throw new Error(`Payload path escapes staging directory: ${rel}`);
    }
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    const mode = Number.parseInt(String(file.mode || "644"), 8) || 0o644;
    const body = Buffer.isBuffer(file.body) ? file.body : Buffer.from(file.body ?? "");
    fs.writeFileSync(targetPath, body, { mode });
    if (rel.startsWith("payload/bin/")) {
      binEntries.push({ name: path.posix.basename(rel), md5: String(file.md5 || "") });
    }
  }

  if (binEntries.length === 0) {
    throw new Error("Verified hub payload has no payload/bin binaries");
  }

  const manifestText =
    binEntries.map((entry) => `${entry.md5}  ${entry.name}`).join("\n") + "\n";
  const manifestPath = path.join(payloadRoot, "bin", "MANIFEST.txt");
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, manifestText, { encoding: "utf8", mode: 0o644 });

  const stagedHelpersDir = path.join(payloadRoot, "helpers");
  fs.mkdirSync(stagedHelpersDir, { recursive: true });
  for (const helperName of INSTALLER_HELPER_NAMES) {
    const srcHelper = path.join(helpersDirPath, helperName);
    if (fs.existsSync(srcHelper)) {
      const dstHelper = path.join(stagedHelpersDir, helperName);
      const mode = helperName === "codex_flash_free" ? 0o755 : 0o644;
      fs.copyFileSync(srcHelper, dstHelper);
      fs.chmodSync(dstHelper, mode);
    }
  }

  const stagedInstallerPath = path.join(tempDir, "install_webui.py");
  fs.copyFileSync(installerScriptPath, stagedInstallerPath);
  fs.chmodSync(stagedInstallerPath, 0o755);

  return { stagedInstallerPath, payloadRoot };
}

async function fetchLatestHubRelease({
  releasesUrl = RELEASES_URL,
  fetchImpl = globalThis.fetch,
  allowUrl = isGitHubUrl,
  latestHubReleaseImpl = latestHubRelease,
  userAgent = "Melodious",
} = {}) {
  if (!allowUrl(releasesUrl)) {
    throw new Error(`Refusing to fetch releases outside GitHub: ${releasesUrl}`);
  }
  let res;
  try {
    res = await fetchImpl(releasesUrl, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": userAgent,
      },
      redirect: "error",
    });
  } catch {
    throw new Error("Couldn't reach GitHub to look up the latest Melodious hub release.");
  }
  if (res.status === 403 || res.status === 429) {
    throw new Error("GitHub is rate-limiting requests from this network. Try again later or choose a local hub zip.");
  }
  if (!res.ok) {
    throw new Error(`GitHub answered HTTP ${res.status} when looking up hub releases.`);
  }
  let releases;
  try {
    releases = await res.json();
  } catch {
    throw new Error("GitHub returned invalid release metadata.");
  }
  const latest = latestHubReleaseImpl(releases, allowUrl);
  if (!latest) {
    throw new Error("No published Melodious hub release (melodious-hub-<version>.zip) was found on GitHub.");
  }
  return latest;
}

function runStagedInstaller({
  pythonPath,
  installerArgs,
  cwd,
  processTimeoutMs = 900000,
  spawnImpl = spawn,
  onEvent = null,
}) {
  return new Promise((resolve) => {
    const emit = (evt) => {
      if (typeof onEvent === "function") {
        try {
          onEvent(evt);
        } catch {}
      }
    };

    const lines = [];
    const stderrLines = [];
    const verdictReasons = [];
    let verdict = "";
    let stdoutRem = "";
    let stderrRem = "";
    let settled = false;
    let timedOut = false;

    const pushLine = (arr, text) => {
      if (arr.length < 500) arr.push(text);
    };

    const handleStdoutLine = (rawLine) => {
      const trimmed = String(rawLine ?? "").replace(/\r$/, "").trim();
      if (!trimmed) return;
      pushLine(lines, trimmed);

      const stepMatch = /^==\s*(.+?)\s*==$/.exec(trimmed);
      if (stepMatch) {
        const phase = stepMatch[1];
        emit({
          type: "step",
          step: "install-webui",
          phase,
          message: phase,
        });
        return;
      }

      const verdictMatch = /^verdict=([A-Z0-9_]+)$/.exec(trimmed);
      if (verdictMatch) {
        verdict = verdictMatch[1];
        emit({
          type: "progress",
          step: "install-webui",
          status: verdict === "ALLOWED" ? "ok" : "blocked",
          verdict,
          message: `Preflight verdict: ${verdict}`,
        });
        return;
      }

      const reasonMatch = /^verdict_reason=(.+)$/.exec(trimmed);
      if (reasonMatch) {
        const reason = reasonMatch[1].trim();
        if (reason) verdictReasons.push(reason);
        emit({
          type: "progress",
          step: "install-webui",
          status: "reason",
          reason,
          message: reason,
        });
        return;
      }

      emit({
        type: "progress",
        step: "install-webui",
        stream: "stdout",
        line: trimmed,
        message: trimmed,
      });
    };

    const handleStderrLine = (rawLine) => {
      const trimmed = String(rawLine ?? "").replace(/\r$/, "").trim();
      if (!trimmed) return;
      pushLine(stderrLines, trimmed);
      pushLine(lines, trimmed);
      emit({
        type: "progress",
        step: "install-webui",
        stream: "stderr",
        line: trimmed,
        message: trimmed,
      });
    };

    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };

    let child;
    try {
      child = spawnImpl(pythonPath, installerArgs, {
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          PYTHONUNBUFFERED: "1",
        },
      });
    } catch (err) {
      finish({
        exitCode: -1,
        timedOut: false,
        verdict: "",
        verdictReasons,
        lines,
        stderrLines,
        spawnError: `Failed to spawn Python (${pythonPath}): ${err?.message || String(err)}`,
      });
      return;
    }

    if (child.stdin) {
      child.stdin.on?.("error", () => {});
      try {
        child.stdin.end?.();
      } catch {}
    }

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {}
    }, Math.max(1000, Number(processTimeoutMs) || 900000));

    child.stdout?.on("data", (chunk) => {
      stdoutRem += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      let idx = stdoutRem.indexOf("\n");
      while (idx >= 0) {
        const line = stdoutRem.slice(0, idx);
        stdoutRem = stdoutRem.slice(idx + 1);
        handleStdoutLine(line);
        idx = stdoutRem.indexOf("\n");
      }
    });

    child.stderr?.on("data", (chunk) => {
      stderrRem += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      let idx = stderrRem.indexOf("\n");
      while (idx >= 0) {
        const line = stderrRem.slice(0, idx);
        stderrRem = stderrRem.slice(idx + 1);
        handleStderrLine(line);
        idx = stderrRem.indexOf("\n");
      }
    });

    child.on("error", (err) => {
      finish({
        exitCode: -1,
        timedOut,
        verdict,
        verdictReasons,
        lines,
        stderrLines,
        spawnError: `Failed to run Python (${pythonPath}): ${err?.message || String(err)}`,
      });
    });

    child.on("close", (code) => {
      if (stdoutRem.trim()) {
        handleStdoutLine(stdoutRem);
        stdoutRem = "";
      }
      if (stderrRem.trim()) {
        handleStderrLine(stderrRem);
        stderrRem = "";
      }
      finish({
        exitCode: typeof code === "number" ? code : -1,
        timedOut,
        verdict,
        verdictReasons,
        lines,
        stderrLines,
        spawnError: null,
      });
    });
  });
}

async function waitForHubWebUi({
  host,
  port = 8080,
  authHeader = null,
  probeTimeoutMs = 3000,
  probeWaitMs = 90000,
  probePollMs = 2000,
  probeHubImpl = probeHub,
} = {}) {
  const deadline = Date.now() + Math.max(0, Number(probeWaitMs) || 0);
  while (true) {
    let probed = null;
    try {
      probed = await probeHubImpl({
        host,
        port,
        authHeader,
        timeoutMs: probeTimeoutMs,
      });
    } catch {
      probed = null;
    }
    if (probed) return probed;
    if (Date.now() >= deadline) return null;
    await sleep(Math.max(25, Number(probePollMs) || 2000));
  }
}

async function installFreshHub({
  source = "latest",
  hubZipPath = "",
  host = "",
  hubId = null,
  keyPath = "",
  sshPort = 22,
  webUiPort = 8080,
  authHeader = null,
  preflightOnly = false,
  removeRootToolLeftovers = true,
  processTimeoutMs = 900000,
  probeTimeoutMs = 3000,
  probeWaitMs = 90000,
  probePollMs = 2000,
  release = null,
  releasesUrl = RELEASES_URL,
  fetchImpl = globalThis.fetch,
  allowUrl = isGitHubUrl,
  userAgent = "Melodious",
  latestHubReleaseImpl = latestHubRelease,
  downloadVerifiedImpl = downloadVerified,
  readLocalHubZipImpl = readLocalHubZip,
  probeHubImpl = probeHub,
  pythonPath = resolvePythonExecutable(),
  installerScriptPath = DEFAULT_INSTALLER_SCRIPT,
  helpersDirPath = DEFAULT_HELPERS_DIR,
  spawnImpl = spawn,
  tmpRootDir = os.tmpdir(),
  onEvent = null,
} = {}) {
  const cleanSource = String(source ?? "latest").trim().toLowerCase();
  if (!ALLOWED_INSTALL_SOURCES.has(cleanSource)) {
    throw new Error('Invalid install source: must be "latest" or "local"');
  }

  const cleanHost = validateInstallerHost(host);
  const validHubId = validatePositiveHubId(hubId);
  const cleanKeyPath = validateSafeOptionalPath(keyPath, "SSH key path");
  const targetWebPort = Number(webUiPort) || 8080;

  let cleanZipPath = "";
  if (cleanSource === "local") {
    cleanZipPath = validateSafeOptionalPath(hubZipPath, "local hub zip path");
    if (!cleanZipPath || !cleanZipPath.toLowerCase().endsWith(".zip")) {
      throw new Error("A valid local Melodious hub .zip file path is required when source is \"local\"");
    }
  }

  const emit = (evt) => {
    if (typeof onEvent === "function") {
      try {
        onEvent(evt);
      } catch {}
    }
  };

  const tempDir = fs.mkdtempSync(path.join(tmpRootDir, "melodious-fresh-install-"));
  try {
    let zipToUnpack = cleanZipPath;
    if (cleanSource === "latest") {
      let resolvedRelease = release;
      if (!resolvedRelease) {
        emit({
          type: "step",
          step: "install-fetch-release",
          message: "Checking GitHub for the latest Melodious hub release…",
        });
        resolvedRelease = await fetchLatestHubRelease({
          releasesUrl,
          fetchImpl,
          allowUrl,
          latestHubReleaseImpl,
          userAgent,
        });
      }
      const assetName = `melodious-hub-${resolvedRelease.version}.zip`;
      emit({
        type: "step",
        step: "install-download",
        version: resolvedRelease.version,
        message: `Downloading and verifying ${assetName}…`,
      });
      const downloadDir = path.join(tempDir, "download");
      fs.mkdirSync(downloadDir, { recursive: true });
      zipToUnpack = await downloadVerifiedImpl({
        release: resolvedRelease,
        name: assetName,
        dir: downloadDir,
        fetchImpl,
        allowUrl,
        userAgent,
        onProgress: (done, total) =>
          emit({
            type: "progress",
            step: "install-download",
            status: "downloading",
            bytesDone: done,
            bytesTotal: total,
          }),
      });
    } else {
      emit({
        type: "step",
        step: "install-verify-zip",
        message: `Verifying local hub zip (${path.basename(cleanZipPath)})…`,
      });
    }

    const verifiedPayload = await readLocalHubZipImpl(zipToUnpack);
    const stageDir = path.join(tempDir, "workspace");
    fs.mkdirSync(stageDir, { recursive: true });

    const { stagedInstallerPath } = stageInstallerWorkspace({
      tempDir: stageDir,
      verifiedPayload,
      installerScriptPath,
      helpersDirPath,
    });

    const installerArgs = buildInstallerArgs({
      installerPath: stagedInstallerPath,
      host: cleanHost,
      hubId: validHubId,
      keyPath: cleanKeyPath,
      sshPort,
      preflightOnly,
      removeRootToolLeftovers,
    });

    emit({
      type: "step",
      step: "install-webui",
      version: verifiedPayload.version,
      message: preflightOnly
        ? `Running Melodious ${verifiedPayload.version} preflight check over SSH…`
        : `Installing Melodious ${verifiedPayload.version} on ${cleanHost}…`,
    });

    const runOutcome = await runStagedInstaller({
      pythonPath,
      installerArgs,
      cwd: stageDir,
      processTimeoutMs,
      spawnImpl,
      onEvent: emit,
    });

    const allowedAndZero =
      !runOutcome.spawnError &&
      !runOutcome.timedOut &&
      runOutcome.exitCode === 0 &&
      runOutcome.verdict === "ALLOWED";

    if (!allowedAndZero) {
      const lastErrLine = [...runOutcome.stderrLines]
        .reverse()
        .find((l) => l.startsWith("ERROR:") || Boolean(l));
      let errMsg;
      if (runOutcome.spawnError) {
        errMsg = runOutcome.spawnError;
      } else if (runOutcome.timedOut) {
        errMsg = `install_webui.py timed out after ${processTimeoutMs} ms`;
      } else if (runOutcome.verdict && runOutcome.verdict !== "ALLOWED") {
        const detail = runOutcome.verdictReasons.length
          ? `: ${runOutcome.verdictReasons.join("; ")}`
          : "";
        errMsg = `Installer preflight blocked (${runOutcome.verdict})${detail}`;
      } else if (lastErrLine) {
        errMsg = lastErrLine.replace(/^ERROR:\s*/, "");
      } else if (runOutcome.exitCode === 0 && !runOutcome.verdict) {
        errMsg = "install_webui.py exited 0 without reporting verdict=ALLOWED";
      } else {
        errMsg = `install_webui.py failed with exit code ${runOutcome.exitCode}`;
      }

      emit({
        type: "error",
        step: "install-webui",
        verdict: runOutcome.verdict || null,
        message: errMsg,
      });

      return {
        ok: false,
        source: cleanSource,
        version: verifiedPayload.version,
        host: cleanHost,
        port: targetWebPort,
        hubId: validHubId,
        preflightOnly: Boolean(preflightOnly),
        pythonPath,
        exitCode: runOutcome.exitCode,
        timedOut: runOutcome.timedOut,
        verdict: runOutcome.verdict || null,
        verdictReasons: runOutcome.verdictReasons,
        webUiReachable: false,
        webUi: null,
        lines: runOutcome.lines,
        error: errMsg,
      };
    }

    if (preflightOnly === true) {
      emit({
        type: "step",
        step: "install-preflight-complete",
        message: `Preflight passed (verdict=ALLOWED) for Melodious ${verifiedPayload.version}.`,
      });
      return {
        ok: true,
        source: cleanSource,
        version: verifiedPayload.version,
        host: cleanHost,
        port: targetWebPort,
        hubId: validHubId,
        preflightOnly: true,
        pythonPath,
        exitCode: 0,
        timedOut: false,
        verdict: "ALLOWED",
        verdictReasons: runOutcome.verdictReasons,
        webUiReachable: false,
        webUi: null,
        lines: runOutcome.lines,
        error: null,
      };
    }

    emit({
      type: "step",
      step: "install-verify-webui",
      message: `Checking Melodious web UI on http://${cleanHost}:${targetWebPort}…`,
    });

    const probed = await waitForHubWebUi({
      host: cleanHost,
      port: targetWebPort,
      authHeader,
      probeTimeoutMs,
      probeWaitMs,
      probePollMs,
      probeHubImpl,
    });

    if (!probed) {
      const unreachableMsg = `Melodious ${verifiedPayload.version} finished installing, but http://${cleanHost}:${targetWebPort} did not answer /api/system-status.`;
      emit({
        type: "error",
        step: "install-verify-webui",
        message: unreachableMsg,
      });
      return {
        ok: false,
        source: cleanSource,
        version: verifiedPayload.version,
        host: cleanHost,
        port: targetWebPort,
        hubId: validHubId,
        preflightOnly: false,
        pythonPath,
        exitCode: 0,
        timedOut: false,
        verdict: "ALLOWED",
        verdictReasons: runOutcome.verdictReasons,
        webUiReachable: false,
        webUi: null,
        lines: runOutcome.lines,
        error: unreachableMsg,
      };
    }

    emit({
      type: "step",
      step: "install-complete",
      version: verifiedPayload.version,
      message: `Melodious ${verifiedPayload.version} is live on http://${cleanHost}:${targetWebPort}/`,
    });

    return {
      ok: true,
      source: cleanSource,
      version: verifiedPayload.version,
      host: cleanHost,
      port: targetWebPort,
      hubId: validHubId,
      preflightOnly: false,
      pythonPath,
      exitCode: 0,
      timedOut: false,
      verdict: "ALLOWED",
      verdictReasons: runOutcome.verdictReasons,
      webUiReachable: true,
      webUi: probed,
      lines: runOutcome.lines,
      error: null,
    };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

module.exports = {
  ALLOWED_INSTALL_SOURCES,
  DEFAULT_INSTALLER_SCRIPT,
  DEFAULT_HELPERS_DIR,
  INSTALLER_HELPER_NAMES,
  validatePositiveHubId,
  validateInstallerHost,
  buildInstallerArgs,
  stageInstallerWorkspace,
  fetchLatestHubRelease,
  installFreshHub,
};
