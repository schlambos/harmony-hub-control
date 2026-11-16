import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { HUB_FILES, unzipCommand } = require("../src/hub-update.js");
const {
  WIZARD_CHANNELS,
  READONLY_BRIDGE_ACTIONS,
  MUTATING_BRIDGE_ACTIONS,
  hasBundledWizardResources,
  isWizardDevAvailable,
  VERDICTS,
  resolveHubRootDir,
  resolveBridgeScriptPath,
  resolveInstallerPaths,
  resolvePythonExecutable,
  buildIsolatedPythonEnv,
  validatePositiveRemoteId,
  validatePositiveHubId,
  buildBridgeArgs,
  buildInstallerArgs,
  detectHostKeyChanged,
  clearKnownHost,
  runWizardBridge,
  classifyHubSignals,
  detectAndClassify,
  runWizardAction,
  installFreshHub,
  createWizardIpcHandlers,
} = require("../src/wizard/index.js");
const wizardFlow = require("../src/wizard/flow.js");
const {
  isMachOHeader,
  isMachOFile,
  collectMachOFiles,
  signMachOFiles,
} = require("../scripts/after-pack.js");

test("isWizardDevAvailable enables macOS source & packaged builds (when resources exist) and keeps Windows/Linux disabled", () => {
  const macRes = "/Applications/Melodious.app/Contents/Resources";
  const bundledSet = new Set([
    `${macRes}/wizard-python/bin/python3`,
    `${macRes}/hub-root/wizard_bridge.py`,
    `${macRes}/hub-root/dropbearmulti`,
    `${macRes}/installer/install_webui.py`,
    `${macRes}/installer/payload/helpers/codex_flash_free`,
    `${macRes}/installer/payload/helpers/hal_multiremote_patch.json`,
    `${macRes}/installer/payload/helpers/hal_remotes_patch.json`,
  ]);

  assert.equal(isWizardDevAvailable({ isPackaged: false, platform: "darwin" }), true);
  assert.equal(
    isWizardDevAvailable({
      isPackaged: true,
      platform: "darwin",
      resourcesPath: macRes,
      existsSync: (p) => bundledSet.has(p),
    }),
    true
  );
  // Missing resourcesPath or any missing bundled file fails closed
  assert.equal(
    isWizardDevAvailable({ isPackaged: true, platform: "darwin", resourcesPath: "" }),
    false
  );
  assert.equal(
    isWizardDevAvailable({
      isPackaged: true,
      platform: "darwin",
      resourcesPath: macRes,
      existsSync: (p) => bundledSet.has(p) && !p.endsWith("dropbearmulti"),
    }),
    false
  );
  assert.equal(
    hasBundledWizardResources({
      resourcesPath: macRes,
      platform: "darwin",
      existsSync: (p) => bundledSet.has(p),
    }),
    true
  );

  // Windows and Linux stay strictly false even if resourcesPath is populated
  assert.equal(isWizardDevAvailable({ isPackaged: false, platform: "win32" }), false);
  assert.equal(
    isWizardDevAvailable({
      isPackaged: true,
      platform: "win32",
      resourcesPath: macRes,
      existsSync: () => true,
    }),
    false
  );
  assert.equal(isWizardDevAvailable({ isPackaged: false, platform: "linux" }), false);
  assert.equal(
    isWizardDevAvailable({
      isPackaged: true,
      platform: "linux",
      resourcesPath: macRes,
      existsSync: () => true,
    }),
    false
  );
});

test("buildBridgeArgs enforces action allowlist, confirmAction guards, numeric remoteId, and forbids passwords on argv", () => {
  for (const okAction of READONLY_BRIDGE_ACTIONS) {
    const args = buildBridgeArgs({ action: okAction, host: "192.168.0.235", mask: true });
    assert.ok(args.includes(okAction));
    assert.ok(args.includes("--mask"));
    assert.ok(!args.includes("--confirm-action"));
  }

  for (const mutAction of MUTATING_BRIDGE_ACTIONS) {
    assert.throws(
      () => buildBridgeArgs({ action: mutAction }),
      /requires confirmAction/
    );
    if (mutAction === "post-root") {
      assert.throws(
        () => buildBridgeArgs({ action: "post-root", confirmAction: "post-root" }),
        /allowUnprovenPost=true/
      );
      const postArgs = buildBridgeArgs({
        action: "post-root",
        confirmAction: "post-root",
        allowUnprovenPost: true,
        host: "192.168.0.235",
      });
      assert.ok(postArgs.includes("--confirm-action"));
      assert.ok(postArgs.includes("--allow-unproven-post"));
    } else {
      const mutArgs = buildBridgeArgs({
        action: mutAction,
        confirmAction: mutAction,
        host: "192.168.0.235",
      });
      assert.ok(mutArgs.includes("--confirm-action"));
      assert.ok(mutArgs.includes(mutAction));
    }
  }

  for (const forbidden of [
    "factory-reset",
    "flash-firmware",
    "lan-root",
    "provision-wifi",
    "enable-xmpp",
    "rm-rf",
  ]) {
    assert.throws(
      () => buildBridgeArgs({ action: forbidden }),
      /Disallowed wizard_bridge action/
    );
  }

  // Never allow Wi-Fi password on CLI argv
  assert.throws(
    () =>
      buildBridgeArgs({
        action: "usb-wifi-connect",
        confirmAction: "usb-wifi-connect",
        wifiPassword: "secret",
      }),
    /Wi-Fi password must never be passed on CLI argv/
  );
  assert.throws(
    () =>
      buildBridgeArgs({
        action: "usb-wifi-connect",
        confirmAction: "usb-wifi-connect",
        password: "secret",
      }),
    /Wi-Fi password must never be passed on CLI argv/
  );

  // Numeric remoteId validation
  assert.equal(validatePositiveRemoteId(20261111), 20261111);
  for (const badId of ["20261111", 0, -5, 3.14, NaN, null, undefined, true]) {
    assert.throws(() => validatePositiveRemoteId(badId), /strictly positive integer/);
    if (badId !== null && badId !== undefined && badId !== "") {
      assert.throws(
        () =>
          buildBridgeArgs({
            action: "usb-provision-local",
            confirmAction: "usb-provision-local",
            remoteId: badId,
          }),
        /strictly positive integer/
      );
    }
  }

  assert.throws(() => buildBridgeArgs({ usbBackend: "libusb-raw" }), /Invalid USB backend/);
  assert.throws(() => buildBridgeArgs({ timeoutMs: 0 }), /Invalid timeoutMs/);
  assert.throws(() => buildBridgeArgs({ host: "--option-inject" }), /Invalid hub host/);
  assert.throws(() => buildBridgeArgs({ host: "192.168.0.1\n" }), /Invalid hub host/);
  assert.throws(() => buildBridgeArgs({ usbDevicePath: "-bad" }), /Invalid USB device path/);
  assert.throws(
    () =>
      buildBridgeArgs({
        action: "usb-flash-firmware",
        confirmAction: "usb-flash-firmware",
        firmwareFile: "/tmp/not-a-bundle.zip",
      }),
    /must end with \.hfw2/
  );
});

test("resolvePythonExecutable, bridge/installer packaged resource resolvers, and isolated Python env work across packaged & source modes", () => {
  const macRes = "/Applications/Melodious.app/Contents/Resources";

  // 1. MELODIOUS_WIZARD_PYTHON always overrides both packaged and .venv Python
  assert.equal(
    resolvePythonExecutable({
      env: { MELODIOUS_WIZARD_PYTHON: "/custom/python3" },
      isPackaged: true,
      resourcesPath: macRes,
      existsSync: () => true,
    }),
    "/custom/python3"
  );

  // 2. Packaged macOS resolves Contents/Resources/wizard-python/bin/python3
  assert.equal(
    resolvePythonExecutable({
      env: {},
      platform: "darwin",
      isPackaged: true,
      resourcesPath: macRes,
      existsSync: (p) => p === `${macRes}/wizard-python/bin/python3`,
    }),
    `${macRes}/wizard-python/bin/python3`
  );

  // 3. Source checkout ignores resourcesPath when isPackaged=false and prefers .venv
  assert.equal(
    resolvePythonExecutable({
      env: {},
      platform: "darwin",
      isPackaged: false,
      resourcesPath: macRes,
      hubRootDir: "/repo/tools/hub-root",
      existsSync: (p) =>
        p === `${macRes}/wizard-python/bin/python3` ||
        p === "/repo/tools/hub-root/.venv/bin/python",
    }),
    "/repo/tools/hub-root/.venv/bin/python"
  );
  assert.equal(
    resolvePythonExecutable({
      env: {},
      platform: "win32",
      isPackaged: false,
      hubRootDir: "C:\\repo\\tools\\hub-root",
      existsSync: (p) => p === "C:\\repo\\tools\\hub-root\\.venv\\Scripts\\python.exe",
    }),
    "C:\\repo\\tools\\hub-root\\.venv\\Scripts\\python.exe"
  );
  assert.equal(
    resolvePythonExecutable({
      env: {},
      platform: "darwin",
      isPackaged: false,
      hubRootDir: "/repo/tools/hub-root",
      existsSync: () => false,
    }),
    "python3"
  );

  // 4. Bridge & installer paths resolve from resourcesPath when packaged and repoRoot in source mode
  assert.equal(
    resolveHubRootDir({
      isPackaged: true,
      platform: "darwin",
      resourcesPath: macRes,
      repoRoot: "/repo",
    }),
    `${macRes}/hub-root`
  );
  assert.equal(
    resolveBridgeScriptPath({
      isPackaged: true,
      platform: "darwin",
      resourcesPath: macRes,
      repoRoot: "/repo",
    }),
    `${macRes}/hub-root/wizard_bridge.py`
  );
  assert.equal(
    resolveBridgeScriptPath({
      isPackaged: false,
      platform: "darwin",
      resourcesPath: macRes,
      repoRoot: "/repo",
    }),
    "/repo/tools/hub-root/wizard_bridge.py"
  );

  assert.deepEqual(
    resolveInstallerPaths({
      isPackaged: true,
      platform: "darwin",
      resourcesPath: macRes,
      repoRoot: "/repo",
    }),
    {
      installerScriptPath: `${macRes}/installer/install_webui.py`,
      helpersDirPath: `${macRes}/installer/payload/helpers`,
    }
  );
  assert.deepEqual(
    resolveInstallerPaths({
      isPackaged: false,
      platform: "darwin",
      resourcesPath: macRes,
      repoRoot: "/repo",
    }),
    {
      installerScriptPath: "/repo/install_webui.py",
      helpersDirPath: "/repo/payload/helpers",
    }
  );

  // 5. Isolated Python env scrubs host Python variables and prevents .pyc writes in Resources
  const isolated = buildIsolatedPythonEnv(
    {
      PATH: "/usr/bin:/bin",
      PYTHONHOME: "/opt/homebrew/Cellar/python",
      PYTHONPATH: "/Users/test/custom-site",
      PYTHONUSERBASE: "/Users/test/.local",
      VIRTUAL_ENV: "/Users/test/.venv",
      __PYVENV_LAUNCHER__: "/Library/Frameworks/Python.framework/Versions/3.12/bin/python3",
    },
    { HARMONY_NO_PAUSE: "1" }
  );
  assert.equal(isolated.PATH, "/usr/bin:/bin");
  assert.equal(isolated.PYTHONHOME, undefined);
  assert.equal(isolated.PYTHONPATH, undefined);
  assert.equal(isolated.PYTHONUSERBASE, undefined);
  assert.equal(isolated.VIRTUAL_ENV, undefined);
  assert.equal(isolated.__PYVENV_LAUNCHER__, undefined);
  assert.equal(isolated.PYTHONNOUSERSITE, "1");
  assert.equal(isolated.PYTHONDONTWRITEBYTECODE, "1");
  assert.equal(isolated.PYTHONUNBUFFERED, "1");
  assert.equal(isolated.HARMONY_NO_PAUSE, "1");
});

test("after-pack.js detects Mach-O binaries/dylibs/.so and skips ELF MIPS binaries (dropbearmulti, codex_flash_free), scripts, and symlinks", () => {
  // Thin 64-bit LE (arm64 / x86_64) & BE, thin 32-bit LE & BE, fat Mach-O
  assert.equal(isMachOHeader(Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 0])), true);
  assert.equal(isMachOHeader(Buffer.from([0xfe, 0xed, 0xfa, 0xcf, 0, 0, 0, 0])), true);
  assert.equal(isMachOHeader(Buffer.from([0xce, 0xfa, 0xed, 0xfe, 0, 0, 0, 0])), true);
  assert.equal(isMachOHeader(Buffer.from([0xfe, 0xed, 0xfa, 0xce, 0, 0, 0, 0])), true);
  assert.equal(isMachOHeader(Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 2])), true);

  // ELF (\x7fELF), Java .class (0xcafebabe major=52), shebang, JSON, short buffer
  assert.equal(isMachOHeader(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 1, 2, 1, 0])), false);
  assert.equal(isMachOHeader(Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 52])), false);
  assert.equal(isMachOHeader(Buffer.from("#!/usr/bin/env python3\n", "utf8")), false);
  assert.equal(isMachOHeader(Buffer.from('{"ok":true}\n', "utf8")), false);
  assert.equal(isMachOHeader(Buffer.from([0xcf, 0xfa])), false);

  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const realDropbear = path.join(repoRoot, "tools", "hub-root", "dropbearmulti");
  const realFlashFree = path.join(repoRoot, "payload", "helpers", "codex_flash_free");
  assert.equal(isMachOFile(realDropbear), false, "MIPS ELF dropbearmulti must not be detected as Mach-O");
  assert.equal(isMachOFile(realFlashFree), false, "MIPS ELF codex_flash_free must not be detected as Mach-O");

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "melodious-afterpack-test-"));
  try {
    const pyBinDir = path.join(tmpDir, "wizard-python", "bin");
    const pyLibDir = path.join(tmpDir, "wizard-python", "lib");
    const siteDir = path.join(pyLibDir, "python3.12", "site-packages");
    const hubRootDir = path.join(tmpDir, "hub-root");
    const helpersDir = path.join(tmpDir, "installer", "payload", "helpers");
    fs.mkdirSync(pyBinDir, { recursive: true });
    fs.mkdirSync(siteDir, { recursive: true });
    fs.mkdirSync(hubRootDir, { recursive: true });
    fs.mkdirSync(helpersDir, { recursive: true });

    const fakeMachO64 = Buffer.alloc(32);
    fakeMachO64.writeUInt32LE(0xfeedfacf, 0);

    const pyExe = path.join(pyBinDir, "python3.12");
    const libPy = path.join(pyLibDir, "libpython3.12.dylib");
    const hidSo = path.join(siteDir, "hid.cpython-312-darwin.so");
    fs.writeFileSync(pyExe, fakeMachO64);
    fs.writeFileSync(libPy, fakeMachO64);
    fs.writeFileSync(hidSo, fakeMachO64);

    if (process.platform !== "win32") {
      fs.symlinkSync("python3.12", path.join(pyBinDir, "python3"));
    }

    // Copy real MIPS ELF binaries + Python/JSON files into the resource tree
    fs.copyFileSync(realDropbear, path.join(hubRootDir, "dropbearmulti"));
    fs.writeFileSync(path.join(hubRootDir, "wizard_bridge.py"), "#!/usr/bin/env python3\n");
    fs.copyFileSync(realFlashFree, path.join(helpersDir, "codex_flash_free"));
    fs.writeFileSync(path.join(helpersDir, "hal_remotes_patch.json"), "{}\n");

    const collected = collectMachOFiles([
      path.join(tmpDir, "wizard-python"),
      hubRootDir,
      path.join(tmpDir, "installer"),
    ]);
    assert.deepEqual(collected, [libPy, hidSo, pyExe], "libraries/extensions signed before executable; ELF/symlinks/scripts skipped");

    const signedCalls = [];
    signMachOFiles([tmpDir], {
      execFileSyncImpl: (cmd, args) => {
        signedCalls.push([cmd, args]);
      },
    });
    assert.deepEqual(signedCalls, [
      ["codesign", ["--force", "--sign", "-", libPy]],
      ["codesign", ["--force", "--sign", "-", hidSo]],
      ["codesign", ["--force", "--sign", "-", pyExe]],
    ]);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("runWizardBridge parses fragmented NDJSON chunks, pipes stdinJson without leaking secrets to argv, and spawns real wizard_bridge.py", async () => {
  const seen = [];
  let capturedSpawnArgs = null;
  let capturedStdio = null;
  let capturedStdinText = "";

  const fakeSpawn = (_cmd, args, opts) => {
    capturedSpawnArgs = args;
    capturedStdio = opts.stdio;
    const child = new EventEmitter();
    child.stdin = {
      on() {},
      write(chunk) {
        capturedStdinText += String(chunk);
      },
      end() {},
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    setImmediate(() => {
      child.stdout.emit("data", Buffer.from('{"type":"step","step":"usb-wifi-con'));
      child.stdout.emit(
        "data",
        Buffer.from(
          'nect","message":"Writing Wi-Fi credentials (TopSecretPass99)"}\n{"type":"result","action":"usb-wifi-connect","ok":true,"wifiConnect":{"ok":true}}\n'
        )
      );
      child.emit("close", 0);
    });
    return child;
  };

  const out = await runWizardBridge({
    action: "usb-wifi-connect",
    confirmAction: "usb-wifi-connect",
    stdinJson: { ssid: "MyHomeWiFi", password: "TopSecretPass99" },
    spawnImpl: fakeSpawn,
    onEvent: (e) => seen.push(e),
  });
  assert.equal(out.ok, true);
  assert.deepEqual(capturedStdio, ["pipe", "pipe", "pipe"]);
  assert.equal(capturedSpawnArgs.join(" ").includes("TopSecretPass99"), false);
  assert.equal(JSON.parse(capturedStdinText.trim()).password, "TopSecretPass99");
  // Secret is scrubbed even if echoed in stdout
  assert.equal(JSON.stringify(seen).includes("TopSecretPass99"), false);
  assert.match(seen[0].message, /<redacted>/);

  // Spawn the real tools/hub-root/wizard_bridge.py with --skip-usb (pure offline run)
  const realOut = await runWizardBridge({
    action: "classify",
    skipUsb: true,
    mask: true,
  });
  assert.equal(realOut.exitCode, 1);
  assert.equal(realOut.result?.type, "result");
  assert.equal(realOut.result?.classification?.verdict, "unknown");
});

test("classifyHubSignals covers all five verdicts, offline USB getProvisionInfo classification, warn-on-mismatch, firmware gate, USB wedge, and masking", () => {
  // 1. Fresh hub + user picked "provisioned" -> mismatch warning
  const freshWithWrongIntent = classifyHubSignals({
    userIntent: "provisioned",
    ssdpCandidates: [{ host: "192.168.0.235", location: "http://192.168.0.235:8088/description.xml", usn: "uuid:1234" }],
    webUiProbe: null,
    bridgeResult: {
      usb: {
        ok: true,
        connected: true,
        deviceCount: 1,
        device: { backend: "hidapi", vendorId: "046D", productId: "C129" },
        preflight: { ok: true, hasHubId: false, pairedDeviceCount: 0 },
        sysinfo: { ok: true, fwVer: "4.15.600", skinDecimal: 106, ramSize: "64MB" },
        provisionInfo: { ok: true, provisioned: false, mode: null },
        discoveryInfo: { ok: true, provisioned: false, currentFwVersion: "4.15.600" },
        usbWedge: false,
      },
      lan: {
        ok: true,
        host: "<ip-redacted>",
        provisionInfo: { ok: true, provisioned: false, mode: null, keys: ["discoveryServer", "se"] },
        ports: { 8080: false, 8088: true, 5222: false, 22: false },
      },
    },
    mask: true,
  });
  assert.equal(freshWithWrongIntent.verdict, VERDICTS.FRESH);
  assert.equal(freshWithWrongIntent.mismatch.hasMismatch, true);
  assert.equal(freshWithWrongIntent.mismatch.recommendedIntent, "fresh");
  assert.equal(freshWithWrongIntent.firmwareGate.passes, true);
  assert.equal(JSON.stringify(freshWithWrongIntent).includes("192.168.0.235"), false);

  // 2. Wi-Fi-less hub over USB ONLY that is still provisioned to an account (preflight hasHubId=false, USB getProvisionInfo provisioned=true)
  const usbOnlyProvisioned = classifyHubSignals({
    userIntent: "fresh",
    ssdpCandidates: [],
    webUiProbe: null,
    bridgeResult: {
      usb: {
        ok: true,
        connected: true,
        deviceCount: 1,
        device: { backend: "hidapi", vendorId: "046D", productId: "C129" },
        preflight: { ok: true, hasHubId: false, pairedDeviceCount: 1 },
        sysinfo: { ok: true, fwVer: "4.15.600", skinDecimal: 106, ramSize: "64MB" },
        provisionInfo: {
          ok: true,
          provisioned: true,
          mode: 3,
          hasActiveRemoteId: true,
          remoteIdType: "number",
          hasAccountId: true,
          isLocalAccountHint: false,
        },
        discoveryInfo: {
          ok: true,
          provisioned: true,
          mode: 3,
          hasRemoteId: true,
          currentFwVersion: "4.15.600",
        },
        usbWedge: false,
      },
      lan: { ok: false, skipped: true },
    },
    mask: true,
  });
  assert.equal(usbOnlyProvisioned.verdict, VERDICTS.PROVISIONED_LOCAL);
  assert.equal(usbOnlyProvisioned.signals.usb.provisioned, true);
  assert.equal(usbOnlyProvisioned.mismatch.hasMismatch, true);
  assert.equal(usbOnlyProvisioned.mismatch.recommendedIntent, "provisioned");

  // 3. Provisioned XMPP-on hub + user picked "fresh" -> destructive-reset mismatch warning + firmware gate fail
  const xmppOnWithFreshIntent = classifyHubSignals({
    userIntent: "fresh",
    bridgeResult: {
      usb: {
        ok: true,
        connected: true,
        deviceCount: 1,
        preflight: { ok: true, hasHubId: true },
        sysinfo: { ok: true, fwVer: "4.15.330", skinDecimal: 106, ramSize: "32MB" },
        usbWedge: false,
      },
      lan: {
        ok: true,
        host: "<ip-redacted>",
        provisionInfo: { ok: true, provisioned: true, mode: 3, hasActiveRemoteId: true, remoteIdType: "number" },
        ports: { 8080: false, 8088: true, 5222: true, 22: false },
      },
    },
    mask: true,
  });
  assert.equal(xmppOnWithFreshIntent.verdict, VERDICTS.PROVISIONED_XMPP_ON);
  assert.equal(xmppOnWithFreshIntent.mismatch.hasMismatch, true);
  assert.equal(xmppOnWithFreshIntent.mismatch.recommendedIntent, "provisioned");
  assert.equal(xmppOnWithFreshIntent.firmwareGate.passes, false);

  // 4. Provisioned local hub over USB with string remoteId trap
  const localStringTrap = classifyHubSignals({
    userIntent: "provisioned",
    bridgeResult: {
      usb: {
        ok: true,
        connected: true,
        preflight: { ok: true, hasHubId: false },
        provisionInfo: {
          ok: true,
          provisioned: true,
          mode: 3,
          hasActiveRemoteId: true,
          remoteIdType: "string",
          isLocalAccountHint: true,
        },
        usbWedge: true,
        error: "LTCP hbus error frame",
      },
      lan: { ok: false, skipped: true },
    },
    mask: true,
  });
  assert.equal(localStringTrap.verdict, VERDICTS.PROVISIONED_LOCAL);
  assert.equal(localStringTrap.mismatch.hasMismatch, true);
  assert.match(localStringTrap.mismatch.title, /JSON string/);
  assert.equal(localStringTrap.usbWedge.wedged, true);

  // 5. Melodious already installed (:8080 responds)
  const melodiousInstalled = classifyHubSignals({
    userIntent: "fresh",
    webUiProbe: { host: "192.168.0.100", port: 8080, firmware: "4.15.600", authRequired: false },
    bridgeResult: {
      usb: { ok: false, connected: false },
      lan: {
        ok: true,
        ports: { 8080: true, 8088: true, 5222: false, 22: true },
      },
    },
    mask: true,
  });
  assert.equal(melodiousInstalled.verdict, VERDICTS.MELODIOUS_INSTALLED);
  assert.equal(melodiousInstalled.mismatch.hasMismatch, true);
  assert.equal(melodiousInstalled.firmwareGate.passes, true);
});

test("detectAndClassify, runWizardAction, and wizard:* IPC handlers enforce sender security, isWizardDevAvailable gating, stdin piping, and native .hfw2 dialog", async () => {
  const sentEvents = [];
  const mainFrame = { url: "melodious://app/" };
  const mainWin = {
    isDestroyed: () => false,
    webContents: {
      mainFrame,
      send(channel, payload) {
        sentEvents.push([channel, payload]);
      },
    },
  };
  const trustedEvent = { sender: mainWin.webContents, senderFrame: mainFrame };
  const untrustedEvent = { sender: {}, senderFrame: mainFrame };

  // 1. Test isWizardDevAvailable gating on IPC handlers (non-macOS or missing resources disabled)
  const disabledHandlers = createWizardIpcHandlers({
    getMainWindow: () => mainWin,
    isWizardAvailable: () => isWizardDevAvailable({ isPackaged: true, platform: "win32" }),
  });
  await assert.rejects(
    () => disabledHandlers[WIZARD_CHANNELS.detectClassify](trustedEvent, {}),
    /Root Wizard dev actions are not available/
  );
  await assert.rejects(
    () =>
      disabledHandlers[WIZARD_CHANNELS.runAction](trustedEvent, {
        action: "usb-wifi-scan",
      }),
    /Root Wizard dev actions are not available/
  );

  // 2. Test active IPC handlers
  let capturedBridgeHost = null;
  let lastActionBridgeOpts = null;
  let dialogPickedPath = "/Users/owner/Downloads/4.15.600.2987731.hfw2";

  const handlers = createWizardIpcHandlers({
    getMainWindow: () => mainWin,
    isWizardAvailable: () => isWizardDevAvailable({ isPackaged: false, platform: "darwin" }),
    pickFirmwareFile: async () => dialogPickedPath,
    detectAndClassifyImpl: (opts) =>
      detectAndClassify({
        ...opts,
        scanSsdpImpl: async () => [{ host: "192.168.0.235", webUiPort: 8080, hbusPort: 8088 }],
        probeHubImpl: async () => null,
        runBridgeImpl: async (bOpts) => {
          capturedBridgeHost = bOpts.host;
          bOpts.onEvent?.({ type: "step", step: "usb-preflight", message: "Reading /rf/deviceinfo" });
          return {
            ok: true,
            exitCode: 0,
            pythonPath: "python3",
            events: [],
            result: {
              type: "result",
              ok: true,
              usb: {
                ok: true,
                connected: true,
                deviceCount: 1,
                preflight: { ok: true, hasHubId: false },
                sysinfo: { ok: true, fwVer: "4.15.600" },
                provisionInfo: { ok: true, provisioned: false },
              },
              lan: {
                ok: true,
                host: "<ip-redacted>",
                provisionInfo: { ok: true, provisioned: false },
                ports: { 8080: false, 8088: true, 5222: false, 22: false },
              },
            },
          };
        },
      }),
    runWizardActionImpl: (opts) =>
      runWizardAction({
        ...opts,
        runBridgeImpl: async (bOpts) => {
          lastActionBridgeOpts = bOpts;
          return {
            ok: true,
            exitCode: 0,
            pythonPath: "python3",
            events: [],
            result: { type: "result", action: bOpts.action, ok: true },
          };
        },
      }),
  });

  await assert.rejects(
    () => handlers[WIZARD_CHANNELS.detectClassify](untrustedEvent, {}),
    /Untrusted IPC sender/
  );
  await assert.rejects(
    () => handlers[WIZARD_CHANNELS.runAction](untrustedEvent, { action: "usb-wifi-scan" }),
    /Untrusted IPC sender/
  );

  const res = await handlers[WIZARD_CHANNELS.detectClassify](trustedEvent, {
    userIntent: "fresh",
    host: "",
    mask: true,
  });
  // USB connected with no unmasked discoveryInfo.ip: must NOT merge another hub's SSDP host
  assert.equal(capturedBridgeHost, "");
  assert.equal(res.verdict, "fresh");
  assert.equal(res.mismatch.hasMismatch, false);
  assert.ok(sentEvents.some(([ch, evt]) => ch === WIZARD_CHANNELS.event && evt.step === "usb-preflight"));

  // 3. Renderer-supplied firmwareFile path is rejected; native dialog path is used instead
  await assert.rejects(
    () =>
      handlers[WIZARD_CHANNELS.runAction](trustedEvent, {
        action: "usb-flash-firmware",
        confirmAction: "usb-flash-firmware",
        firmwareFile: "/etc/passwd",
      }),
    /Renderer-supplied firmwareFile path is not permitted/
  );

  const flashRes = await handlers[WIZARD_CHANNELS.runAction](trustedEvent, {
    action: "usb-flash-firmware",
    confirmAction: "usb-flash-firmware",
  });
  assert.equal(flashRes.ok, true);
  assert.equal(lastActionBridgeOpts.firmwareFile, "/Users/owner/Downloads/4.15.600.2987731.hfw2");

  // Canceled native dialog returns canceled=true without running bridge
  dialogPickedPath = null;
  const canceledRes = await handlers[WIZARD_CHANNELS.runAction](trustedEvent, {
    action: "usb-flash-firmware",
    confirmAction: "usb-flash-firmware",
  });
  assert.equal(canceledRes.ok, false);
  assert.equal(canceledRes.canceled, true);

  // 4. Wi-Fi connect validates SSID and passes password via stdinJson
  await assert.rejects(
    () =>
      handlers[WIZARD_CHANNELS.runAction](trustedEvent, {
        action: "usb-wifi-connect",
        confirmAction: "usb-wifi-connect",
        ssid: "",
        password: "secret",
      }),
    /Invalid Wi-Fi SSID/
  );
  await handlers[WIZARD_CHANNELS.runAction](trustedEvent, {
    action: "usb-wifi-connect",
    confirmAction: "usb-wifi-connect",
    ssid: "HomeWiFi",
    password: "MySecretPassword",
  });
  assert.deepEqual(lastActionBridgeOpts.stdinJson, {
    ssid: "HomeWiFi",
    password: "MySecretPassword",
    encryption: "WPA2-PSK",
    noSave: false,
  });

  // 5. Provision local rejects string remoteId and accepts positive integer
  await assert.rejects(
    () =>
      handlers[WIZARD_CHANNELS.runAction](trustedEvent, {
        action: "usb-provision-local",
        confirmAction: "usb-provision-local",
        remoteId: "20261111",
      }),
    /strictly positive integer/
  );
  await handlers[WIZARD_CHANNELS.runAction](trustedEvent, {
    action: "usb-provision-local",
    confirmAction: "usb-provision-local",
    remoteId: 20261111,
  });
  assert.equal(lastActionBridgeOpts.remoteId, 20261111);
  assert.equal(lastActionBridgeOpts.stdinJson.remoteId, 20261111);
});

function makeSyntheticVerifiedPayload(version = "2.1.0") {
  const md5 = (buf) => crypto.createHash("md5").update(buf).digest("hex");
  return {
    version,
    files: Object.entries(HUB_FILES).map(([rel, [dest, mode, reboot]]) => {
      const body = Buffer.from(`${rel} ${version}\n`, "utf8");
      return {
        rel,
        dest,
        mode,
        reboot,
        body,
        md5: md5(body),
        name: rel.replace(/\//g, "_"),
      };
    }),
  };
}

test("installFreshHub stages verified payload + install_webui.py, enforces CLI flags and verdict=ALLOWED, probes :8080, and always cleans up temp dirs", async () => {
  for (const badHubId of ["20264150", 0, -9, 1.5, NaN, null, undefined, false]) {
    assert.throws(() => validatePositiveHubId(badHubId), /strictly positive integer/);
  }
  const defaultArgs = buildInstallerArgs({
    installerPath: "/tmp/stage/install_webui.py",
    host: "192.168.0.235",
    hubId: 20264150,
  });
  assert.deepEqual(defaultArgs, [
    "/tmp/stage/install_webui.py",
    "--hub-host",
    "192.168.0.235",
    "--hub-id",
    "20264150",
    "--no-prompt",
    "--mqtt-disabled",
    "--remove-root-tool-leftovers",
  ]);
  const preflightNoCleanupArgs = buildInstallerArgs({
    installerPath: "/tmp/stage/install_webui.py",
    host: "192.168.0.235",
    hubId: 20264150,
    keyPath: "/Users/owner/.ssh/harmony_owner_ed25519",
    sshPort: 2222,
    removeRootToolLeftovers: false,
    preflightOnly: true,
  });
  assert.ok(!preflightNoCleanupArgs.includes("--remove-root-tool-leftovers"));
  assert.ok(preflightNoCleanupArgs.includes("--preflight-only"));
  assert.ok(preflightNoCleanupArgs.includes("--port"));
  assert.ok(preflightNoCleanupArgs.includes("2222"));

  const tmpRootDir = fs.mkdtempSync(path.join(os.tmpdir(), "melodious-wiz-inst-test-"));
  const server = http.createServer();
  try {
    const fakeZipBytes = Buffer.from("PK-synthetic-hub-zip", "utf8");
    const fakeZipSha = crypto.createHash("sha256").update(fakeZipBytes).digest("hex");
    const sumsBody = `${fakeZipSha}  melodious-hub-2.1.0.zip\n`;

    server.on("request", (req, res) => {
      if (req.url === "/repos/schlambos/harmony-hub-control/releases") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify([
            {
              tag_name: "v2.1.0",
              draft: false,
              prerelease: false,
              published_at: "2026-11-15T00:00:00Z",
              html_url: "https://github.com/schlambos/harmony-hub-control/releases/tag/v2.1.0",
              assets: [
                {
                  name: "melodious-hub-2.1.0.zip",
                  browser_download_url: `http://127.0.0.1:${server.address().port}/assets/melodious-hub-2.1.0.zip`,
                },
                {
                  name: "SHA256SUMS.txt",
                  browser_download_url: `http://127.0.0.1:${server.address().port}/assets/SHA256SUMS.txt`,
                },
              ],
            },
          ])
        );
        return;
      }
      if (req.url === "/assets/SHA256SUMS.txt") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end(sumsBody);
        return;
      }
      if (req.url === "/assets/melodious-hub-2.1.0.zip") {
        res.writeHead(200, { "Content-Length": String(fakeZipBytes.length) });
        res.end(fakeZipBytes);
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;

    // 1. Successful "latest" install: stages payload + helpers + install_webui.py, streams events, verifies ALLOWED + :8080, cleans up temp dir
    let inspectedWorkspace = null;
    let capturedArgs = null;
    const events = [];
    let probeCalls = 0;

    const latestRes = await installFreshHub({
      source: "latest",
      host: "192.168.0.235",
      hubId: 20264150,
      releasesUrl: `${baseUrl}/repos/schlambos/harmony-hub-control/releases`,
      allowUrl: (u) => u.startsWith(baseUrl) || u.startsWith("https://github.com/schlambos/harmony-hub-control/"),
      readLocalHubZipImpl: async (zipPath) => {
        assert.ok(fs.existsSync(zipPath), "downloaded zip exists before unpack");
        return makeSyntheticVerifiedPayload("2.1.0");
      },
      spawnImpl: (_py, args, opts) => {
        capturedArgs = args;
        inspectedWorkspace = {
          hasInstaller: fs.existsSync(path.join(opts.cwd, "install_webui.py")),
          hasWebuiBin: fs.existsSync(path.join(opts.cwd, "payload", "bin", "codex_webui")),
          hasManifest: fs.existsSync(path.join(opts.cwd, "payload", "bin", "MANIFEST.txt")),
          hasFlashFree: fs.existsSync(path.join(opts.cwd, "payload", "helpers", "codex_flash_free")),
          hasMultiPatch: fs.existsSync(path.join(opts.cwd, "payload", "helpers", "hal_multiremote_patch.json")),
          hasRemotesPatch: fs.existsSync(path.join(opts.cwd, "payload", "helpers", "hal_remotes_patch.json")),
        };
        const child = new EventEmitter();
        child.stdin = { on() {}, end() {} };
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.kill = () => {};
        setImmediate(() => {
          child.stdout.emit("data", Buffer.from("== Checking SSH ==\n  uid=0(root)\n== Building candidate inventory ==\n"));
          child.stdout.emit("data", Buffer.from("verdict=ALLOWED\n== Restarting the hub ==\n== Done ==\n"));
          child.emit("close", 0);
        });
        return child;
      },
      probeHubImpl: async ({ host, port }) => {
        probeCalls += 1;
        assert.equal(host, "192.168.0.235");
        assert.equal(port, 8080);
        return probeCalls >= 2
          ? { host, port, firmware: "4.15.600", authRequired: false }
          : null;
      },
      probePollMs: 10,
      probeWaitMs: 500,
      tmpRootDir,
      onEvent: (evt) => events.push(evt),
    });

    assert.equal(latestRes.ok, true);
    assert.equal(latestRes.version, "2.1.0");
    assert.equal(latestRes.verdict, "ALLOWED");
    assert.equal(latestRes.webUiReachable, true);
    assert.equal(probeCalls, 2);
    assert.deepEqual(inspectedWorkspace, {
      hasInstaller: true,
      hasWebuiBin: true,
      hasManifest: true,
      hasFlashFree: true,
      hasMultiPatch: true,
      hasRemotesPatch: true,
    });
    assert.ok(capturedArgs.includes("--no-prompt"));
    assert.ok(capturedArgs.includes("--mqtt-disabled"));
    assert.ok(capturedArgs.includes("--remove-root-tool-leftovers"));
    assert.ok(!capturedArgs.includes("--preflight-only"));
    assert.ok(events.some((e) => e.type === "step" && e.phase === "Checking SSH"));
    assert.ok(events.some((e) => e.type === "progress" && e.verdict === "ALLOWED"));
    assert.deepEqual(fs.readdirSync(tmpRootDir), [], "temp dir must be cleaned up on success");

    // 2. Local preflight-only run passes --preflight-only, skips :8080 requirement, and cleans up temp dir
    const localZipPlaceholder = path.join(os.tmpdir(), `fake-local-${process.pid}.zip`);
    fs.writeFileSync(localZipPlaceholder, fakeZipBytes);
    try {
      let preflightArgs = null;
      const preRes = await installFreshHub({
        source: "local",
        hubZipPath: localZipPlaceholder,
        host: "192.168.0.235",
        hubId: 20264150,
        preflightOnly: true,
        removeRootToolLeftovers: false,
        readLocalHubZipImpl: async () => makeSyntheticVerifiedPayload("2.1.0"),
        spawnImpl: (_py, args) => {
          preflightArgs = args;
          const child = new EventEmitter();
          child.stdin = { on() {}, end() {} };
          child.stdout = new EventEmitter();
          child.stderr = new EventEmitter();
          child.kill = () => {};
          setImmediate(() => {
            child.stdout.emit("data", Buffer.from("verdict=ALLOWED\n"));
            child.emit("close", 0);
          });
          return child;
        },
        probeHubImpl: async () => assert.fail("preflight-only must not require :8080 probe"),
        tmpRootDir,
      });
      assert.equal(preRes.ok, true);
      assert.equal(preRes.preflightOnly, true);
      assert.ok(preflightArgs.includes("--preflight-only"));
      assert.ok(!preflightArgs.includes("--remove-root-tool-leftovers"));
      assert.deepEqual(fs.readdirSync(tmpRootDir), [], "temp dir cleaned up after preflight-only");

      // 3. Blocked verdict / non-zero exit cleans up temp dir and reports verdict_reason
      const blockedRes = await installFreshHub({
        source: "local",
        hubZipPath: localZipPlaceholder,
        host: "192.168.0.235",
        hubId: 20264150,
        readLocalHubZipImpl: async () => makeSyntheticVerifiedPayload("2.1.0"),
        spawnImpl: () => {
          const child = new EventEmitter();
          child.stdin = { on() {}, end() {} };
          child.stdout = new EventEmitter();
          child.stderr = new EventEmitter();
          child.kill = () => {};
          setImmediate(() => {
            child.stdout.emit(
              "data",
              Buffer.from("verdict_reason=free flash 100000 < needed 900000\nverdict=BLOCKED_CAPACITY\n")
            );
            child.emit("close", 2);
          });
          return child;
        },
        tmpRootDir,
      });
      assert.equal(blockedRes.ok, false);
      assert.equal(blockedRes.verdict, "BLOCKED_CAPACITY");
      assert.match(blockedRes.error, /BLOCKED_CAPACITY.*free flash/);
      assert.deepEqual(fs.readdirSync(tmpRootDir), [], "temp dir cleaned up on blocked verdict");

      // 4. Unreachable :8080 after install returns ok=false and cleans up temp dir
      const noWebRes = await installFreshHub({
        source: "local",
        hubZipPath: localZipPlaceholder,
        host: "192.168.0.235",
        hubId: 20264150,
        readLocalHubZipImpl: async () => makeSyntheticVerifiedPayload("2.1.0"),
        spawnImpl: () => {
          const child = new EventEmitter();
          child.stdin = { on() {}, end() {} };
          child.stdout = new EventEmitter();
          child.stderr = new EventEmitter();
          child.kill = () => {};
          setImmediate(() => {
            child.stdout.emit("data", Buffer.from("verdict=ALLOWED\n"));
            child.emit("close", 0);
          });
          return child;
        },
        probeHubImpl: async () => null,
        probeWaitMs: 0,
        tmpRootDir,
      });
      assert.equal(noWebRes.ok, false);
      assert.equal(noWebRes.webUiReachable, false);
      assert.deepEqual(fs.readdirSync(tmpRootDir), [], "temp dir cleaned up when :8080 fails");

      // 5. Thrown error during zip verification still cleans up temp dir
      await assert.rejects(
        () =>
          installFreshHub({
            source: "local",
            hubZipPath: localZipPlaceholder,
            host: "192.168.0.235",
            hubId: 20264150,
            readLocalHubZipImpl: async () => {
              throw new Error("That isn't a Melodious hub zip");
            },
            tmpRootDir,
          }),
        /isn't a Melodious hub zip/
      );
      assert.deepEqual(fs.readdirSync(tmpRootDir), [], "temp dir cleaned up on thrown zip error");

      // 6. Real .zip archive unpacked by default readLocalHubZip on macOS and Windows
      if (process.platform === "darwin" || process.platform === "win32") {
        const zipBuildDir = fs.mkdtempSync(path.join(os.tmpdir(), "melodious-real-zip-"));
        try {
          const top = path.join(zipBuildDir, "melodious-hub-2.2.0");
          const synth = makeSyntheticVerifiedPayload("2.2.0");
          let manifest = "";
          for (const f of synth.files) {
            fs.mkdirSync(path.dirname(path.join(top, f.rel)), { recursive: true });
            fs.writeFileSync(path.join(top, f.rel), f.body);
            if (f.rel.startsWith("payload/bin/")) {
              manifest += `${f.md5}  ${path.posix.basename(f.rel)}\n`;
            }
          }
          fs.writeFileSync(path.join(top, "payload/bin/MANIFEST.txt"), manifest);
          const realZip = path.join(zipBuildDir, "melodious-hub-2.2.0.zip");
          if (process.platform === "win32") {
            execFileSync(unzipCommand(realZip, zipBuildDir)[0], ["-a", "-c", "-f", realZip, "-C", zipBuildDir, "melodious-hub-2.2.0"]);
          } else {
            execFileSync("/usr/bin/ditto", ["-c", "-k", "--keepParent", top, realZip]);
          }
          const realZipRes = await installFreshHub({
            source: "local",
            hubZipPath: realZip,
            host: "192.168.0.235",
            hubId: 20264150,
            preflightOnly: true,
            spawnImpl: () => {
              const child = new EventEmitter();
              child.stdin = { on() {}, end() {} };
              child.stdout = new EventEmitter();
              child.stderr = new EventEmitter();
              child.kill = () => {};
              setImmediate(() => {
                child.stdout.emit("data", Buffer.from("verdict=ALLOWED\n"));
                child.emit("close", 0);
              });
              return child;
            },
            tmpRootDir,
          });
          assert.equal(realZipRes.ok, true);
          assert.equal(realZipRes.version, "2.2.0");
          assert.deepEqual(fs.readdirSync(tmpRootDir), []);
        } finally {
          fs.rmSync(zipBuildDir, { recursive: true, force: true });
        }
      }
    } finally {
      fs.rmSync(localZipPlaceholder, { force: true });
    }
  } finally {
    server.close();
    fs.rmSync(tmpRootDir, { recursive: true, force: true });
  }
});

test("wizard:install-hub IPC enforces sender check, isWizardAvailable, native zip dialog, and numeric hubId", async () => {
  const mainFrame = { url: "melodious://app/" };
  const mainWin = {
    isDestroyed: () => false,
    webContents: { mainFrame, send() {} },
  };
  const trustedEvent = { sender: mainWin.webContents, senderFrame: mainFrame };
  const untrustedEvent = { sender: {}, senderFrame: mainFrame };

  const gatedHandlers = createWizardIpcHandlers({
    getMainWindow: () => mainWin,
    isWizardAvailable: () => isWizardDevAvailable({ isPackaged: true, platform: "win32" }),
  });
  await assert.rejects(
    () =>
      gatedHandlers[WIZARD_CHANNELS.installHub](trustedEvent, {
        source: "latest",
        host: "192.168.0.235",
        hubId: 20264150,
      }),
    /Root Wizard dev actions are not available/
  );

  let pickedZipPath = "/Users/owner/Downloads/melodious-hub-2.1.0.zip";
  let lastInstallOpts = null;
  const handlers = createWizardIpcHandlers({
    getMainWindow: () => mainWin,
    isWizardAvailable: () => true,
    pickHubZip: async () => pickedZipPath,
    installFreshHubImpl: async (opts) => {
      lastInstallOpts = opts;
      return {
        ok: true,
        source: opts.source,
        version: "2.1.0",
        host: opts.host,
        port: 8080,
        hubId: opts.hubId,
        verdict: "ALLOWED",
        webUiReachable: true,
      };
    },
  });

  await assert.rejects(
    () =>
      handlers[WIZARD_CHANNELS.installHub](untrustedEvent, {
        source: "latest",
        host: "192.168.0.235",
        hubId: 20264150,
      }),
    /Untrusted IPC sender/
  );

  // Renderer-supplied hubZipPath and keyPath MUST be rejected
  await assert.rejects(
    () =>
      handlers[WIZARD_CHANNELS.installHub](trustedEvent, {
        source: "local",
        host: "192.168.0.235",
        hubId: 20264150,
        hubZipPath: "/etc/passwd",
      }),
    /Renderer-supplied hubZipPath is not permitted/
  );
  await assert.rejects(
    () =>
      handlers[WIZARD_CHANNELS.installHub](trustedEvent, {
        source: "latest",
        host: "192.168.0.235",
        hubId: 20264150,
        keyPath: "/etc/shadow",
      }),
    /Renderer-supplied keyPath is not permitted/
  );

  // Non-numeric / zero / negative hubId MUST be rejected
  for (const badId of ["20264150", 0, -5, null, undefined]) {
    await assert.rejects(
      () =>
        handlers[WIZARD_CHANNELS.installHub](trustedEvent, {
          source: "latest",
          host: "192.168.0.235",
          hubId: badId,
        }),
      /strictly positive integer/
    );
  }

  // Missing or invalid host MUST be rejected
  await assert.rejects(
    () =>
      handlers[WIZARD_CHANNELS.installHub](trustedEvent, {
        source: "latest",
        host: "",
        hubId: 20264150,
      }),
    /Hub IP address or hostname is required/
  );

  // Valid local install picks zip from native dialog
  const okLocal = await handlers[WIZARD_CHANNELS.installHub](trustedEvent, {
    source: "local",
    host: "192.168.0.235",
    hubId: 20264150,
  });
  assert.equal(okLocal.ok, true);
  assert.equal(lastInstallOpts.hubZipPath, "/Users/owner/Downloads/melodious-hub-2.1.0.zip");
  assert.equal(lastInstallOpts.hubId, 20264150);

  // Canceled native zip dialog returns canceled: true without calling installFreshHubImpl
  pickedZipPath = null;
  lastInstallOpts = null;
  const canceledLocal = await handlers[WIZARD_CHANNELS.installHub](trustedEvent, {
    source: "local",
    host: "192.168.0.235",
    hubId: 20264150,
  });
  assert.equal(canceledLocal.ok, false);
  assert.equal(canceledLocal.canceled, true);
  assert.equal(lastInstallOpts, null);
});

test("wizard/flow.js renders jargon-free 4-screen consumer flow, optional sub-screens, and isolated troubleshooting tools", () => {
  assert.equal(wizardFlow.parsePositiveIntInput("20264150"), 20264150);
  assert.equal(wizardFlow.parsePositiveIntInput("0"), null);
  assert.equal(wizardFlow.parsePositiveIntInput("-12"), null);
  assert.equal(wizardFlow.parsePositiveIntInput("2026abc"), null);

  assert.equal(wizardFlow.formatWifiSignalLabel(224), "Strong");
  assert.equal(wizardFlow.formatWifiSignalLabel(150), "Good");
  assert.equal(wizardFlow.formatWifiSignalLabel(80), "Fair");
  assert.equal(wizardFlow.formatWifiSecurityLabel("WPA2-PSK"), "WPA2");
  assert.equal(wizardFlow.formatWifiSecurityLabel("OPEN"), "Open");

  const forbiddenJargon = [
    /046D:C129/i,
    /\bSSDP\b/,
    /\/tde\/enable/i,
    /AutomationConfig/,
    /Dropbear/i,
    /positive integer, never a string/i,
    /stdin pipe only/i,
    /HBus :8088/i,
    /XMPP :5222/i,
    /Developer \/ Manual Step Overrides/,
    /data-wizard-manual-action=/,
    /Preflight Check Only/,
  ];
  const assertCleanConsumerHtml = (html, contextLabel) => {
    for (const pattern of forbiddenJargon) {
      assert.doesNotMatch(
        html,
        pattern,
        `Unexpected engineering jargon/control ${pattern} on ${contextLabel}`
      );
    }
  };

  const st = wizardFlow.createInitialWizardState(4150);
  assert.equal(st.remoteIdInput, "20264150");
  assert.equal(st.includeUsb, true);
  assert.equal(st.troubleshootingOpen, false);
  assert.equal(wizardFlow.computeFreshChecklistStatus(st).currentStage, 1);

  // Screen 1 initial state
  const step1Html = wizardFlow.renderWizardPage(st);
  assert.match(step1Html, /Set up your Harmony Hub/);
  assert.match(step1Html, /Already set up in the Harmony app/);
  assert.match(step1Html, /Brand new, factory reset, or bought used/);
  assert.match(step1Html, /Find My Hub/);
  assert.match(step1Html, /Can't find it\? Enter IP address/);
  assert.doesNotMatch(step1Html, /<details[^>]*id="wizardIpDisclosure"[^>]*open/);
  assert.match(step1Html, /Troubleshooting tools/);
  assertCleanConsumerHtml(step1Html, "Screen 1 initial");

  // Screen 1: Fresh hub found over USB on 4.15.600 -> never shows firmware card
  st.classifyResult = {
    verdict: "fresh",
    signals: {
      usb: { connected: true, preflightOk: true },
      lan: { host: "", ports: {} },
      ssdp: {},
    },
    firmwareGate: { passes: true, currentFirmware: "4.15.600" },
    mismatch: { hasMismatch: false },
  };
  const freshReadyHtml = wizardFlow.renderWizardPage(st);
  assert.match(freshReadyHtml, /Harmony Hub found over USB and ready for setup/);
  assert.match(freshReadyHtml, /Continue →/);
  assert.doesNotMatch(freshReadyHtml, /4\.15\.600/);
  assert.doesNotMatch(freshReadyHtml, /Software update needed/);
  assertCleanConsumerHtml(freshReadyHtml, "Screen 1 fresh ready");

  // Screen 1: Older firmware (< 4.15.600) -> routes to Firmware Update sub-screen
  st.classifyResult.firmwareGate = { passes: false, currentFirmware: "4.15.330" };
  const fwNeededHtml = wizardFlow.renderWizardPage(st);
  assert.match(fwNeededHtml, /Software update needed before setup/);
  assert.match(fwNeededHtml, /Continue to Update →/);
  assertCleanConsumerHtml(fwNeededHtml, "Screen 1 firmware needed");

  st.subScreen = "firmware-update";
  const fwSubHtml = wizardFlow.renderWizardPage(st);
  assert.match(fwSubHtml, /Choose Update File \(\.hfw2\)…/);
  assertCleanConsumerHtml(fwSubHtml, "Firmware Update sub-screen");
  st.subScreen = null;
  st.firmwarePassed = true;

  // Screen 1: Mismatch (picked Fresh, hub still has old setup) -> Factory Reset sub-screen
  st.intent = "fresh";
  st.classifyResult = {
    verdict: "provisioned-local",
    signals: {
      usb: { connected: true, preflightOk: true },
      lan: { host: "192.168.0.235", ports: { 5222: false, 22: false } },
      ssdp: {},
    },
    firmwareGate: { passes: true, currentFirmware: "4.15.600" },
    mismatch: { hasMismatch: true, recommendedIntent: "provisioned" },
  };
  const mismatchHtml = wizardFlow.renderWizardPage(st);
  assert.match(
    mismatchHtml,
    /This hub still has an old setup on it\. You can keep that setup or erase it to start fresh\./
  );
  assert.match(mismatchHtml, /Keep Existing Setup/);
  assert.match(mismatchHtml, /Erase Hub &amp; Start Fresh/);
  assertCleanConsumerHtml(mismatchHtml, "Screen 1 mismatch");

  st.subScreen = "factory-reset";
  const resetBeforeHtml = wizardFlow.renderWizardPage(st);
  assert.match(resetBeforeHtml, /Erase Hub/);
  assertCleanConsumerHtml(resetBeforeHtml, "Factory Reset sub-screen");

  st.factoryResetSent = true;
  const resetAfterHtml = wizardFlow.renderWizardPage(st);
  assert.match(resetAfterHtml, /Unplug the USB cable from your Mac for 15 seconds\./);
  assert.match(resetAfterHtml, /Check Hub/);
  assertCleanConsumerHtml(resetAfterHtml, "Factory Reset post-erase walkthrough");
  st.subScreen = null;
  st.factoryResetSent = false;

  // Screen 1: Provisioned with XMPP closed vs XMPP open
  st.intent = "provisioned";
  const xmppClosedHtml = wizardFlow.renderWizardPage(st);
  assert.match(xmppClosedHtml, /Enable XMPP/);
  assert.match(xmppClosedHtml, /Check Again/);
  assert.match(xmppClosedHtml, /Set Up Over USB Instead/);
  assertCleanConsumerHtml(xmppClosedHtml, "Screen 1 XMPP closed");

  st.classifyResult.verdict = "provisioned-xmpp-on";
  st.classifyResult.signals.lan.ports["5222"] = true;
  const xmppOpenHtml = wizardFlow.renderWizardPage(st);
  assert.match(xmppOpenHtml, /Harmony Hub found on Wi-Fi and ready/);
  assert.match(xmppOpenHtml, /Continue →/);
  assertCleanConsumerHtml(xmppOpenHtml, "Screen 1 Provisioned ready");

  // Screen 2: Connect Wi-Fi (friendly signal labels, no raw signal numbers)
  st.step = 2;
  st.flowPath = "fresh";
  st.wifiScanned = true;
  st.wifiNetworks = [{ ssid: "LivingRoom24", encryption: "WPA2-PSK", signal_strength: 224 }];
  const step2WifiHtml = wizardFlow.renderWizardPage(st);
  assert.match(step2WifiHtml, /Connect your hub to Wi-Fi/);
  assert.match(step2WifiHtml, /WPA2 · Strong/);
  assert.doesNotMatch(step2WifiHtml, /signal 224/i);
  assert.match(step2WifiHtml, /Connect to Wi-Fi/);
  assert.doesNotMatch(step2WifiHtml, /Enter hub IP from your router/);
  assertCleanConsumerHtml(step2WifiHtml, "Screen 2 Wi-Fi");

  st.wifiConnected = true;
  st.confirmedHost = "";
  const step2ManualIpHtml = wizardFlow.renderWizardPage(st);
  assert.match(step2ManualIpHtml, /Enter hub IP from your router/);
  st.confirmedHost = "192.168.0.235";
  const step2ConnectedHtml = wizardFlow.renderWizardPage(st);
  assert.match(step2ConnectedHtml, /Connected to/);
  assert.match(step2ConnectedHtml, /Continue →/);
  assert.doesNotMatch(step2ConnectedHtml, /Enter hub IP from your router/);
  assertCleanConsumerHtml(step2ConnectedHtml, "Screen 2 Wi-Fi connected");

  // Screen 3: Unified 1-click Install Melodious + 4-item checklist + collapsed Advanced options
  st.step = 3;
  const step3InstallHtml = wizardFlow.renderWizardPage(st);
  assert.match(step3InstallHtml, /Install Melodious/);
  assert.match(step3InstallHtml, /Preparing hub for offline use…/);
  assert.match(step3InstallHtml, /Setting up local hub access…/);
  assert.match(step3InstallHtml, /Downloading and installing Melodious…/);
  assert.match(step3InstallHtml, /Restarting hub and checking connection…/);
  assert.match(step3InstallHtml, /Advanced options/);
  assert.doesNotMatch(step3InstallHtml, /<details[^>]*id="wizardAdvancedOptions"[^>]*open/);
  assertCleanConsumerHtml(step3InstallHtml, "Screen 3 Install");

  // Screen 3 error state pauses cleanly with Try Again + Show technical details toggle
  st.installChecklistFailedStep = 2;
  st.error = "Simulated USB timeout";
  st.logLines = ["== step =="];
  const step3ErrHtml = wizardFlow.renderWizardPage(st);
  assert.match(step3ErrHtml, /Try Again/);
  assert.match(step3ErrHtml, /Show technical details/);
  assert.doesNotMatch(step3ErrHtml, /Simulated USB timeout/);
  assertCleanConsumerHtml(step3ErrHtml, "Screen 3 paused error");
  st.error = "";
  st.installChecklistFailedStep = 0;

  // Screen 4: Done
  st.step = 4;
  st.installDone = true;
  st.handoffConnected = true;
  st.handoffHost = "192.168.0.235";
  const step4DoneHtml = wizardFlow.renderWizardPage(st);
  assert.match(step4DoneHtml, /Your Harmony Hub is ready!/);
  assert.match(step4DoneHtml, /Add your TV and devices/);
  assert.match(step4DoneHtml, /Create an activity/);
  assert.match(step4DoneHtml, /Pair your remote in Settings → Remotes/);
  assert.match(step4DoneHtml, /Open Melodious →/);
  assertCleanConsumerHtml(step4DoneHtml, "Screen 4 Done");

  // Troubleshooting view renders manual overrides ONLY when troubleshootingOpen=true
  st.troubleshootingOpen = true;
  const tsHtml = wizardFlow.renderWizardPage(st);
  assert.match(tsHtml, /data-wizard-manual-action="usb-tde-enable"/);
  assert.match(tsHtml, /data-wizard-manual-action="post-root"/);
  assert.match(tsHtml, /Preflight Check Only/);
  assert.match(tsHtml, /Redact IDs/);
  assert.match(tsHtml, /id="wizardRawLogViewer"/);
});

test("runWizardBridge surfaces nested result/progress errors without a type:error event", async () => {
  const fakeSpawn = (_cmd, _args, _opts) => {
    const child = new EventEmitter();
    child.stdin = { on() {}, write() {}, end() {} };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    setImmediate(() => {
      child.stdout.emit(
        "data",
        Buffer.from(
          '{"type":"progress","step":"usb-provision-verify","status":"failed","error":"getProvisionInfo verification did not report mode 3"}\n' +
            '{"type":"result","action":"usb-provision-local","ok":false,"provisionLocal":{"ok":false,"error":"getProvisionInfo verification did not report mode 3"}}\n'
        )
      );
      child.emit("close", 1);
    });
    return child;
  };
  const out = await runWizardBridge({
    action: "usb-provision-local",
    confirmAction: "usb-provision-local",
    spawnImpl: fakeSpawn,
  });
  assert.equal(out.ok, false);
  assert.match(out.error, /did not report mode 3/);

  const fakeSpawn2 = (_cmd, _args, _opts) => {
    const child = new EventEmitter();
    child.stdin = { on() {}, write() {}, end() {} };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    setImmediate(() => {
      child.stdout.emit(
        "data",
        Buffer.from(
          '{"type":"result","action":"usb-flash-firmware","ok":false,"firmwareFlash":{"ok":false,"error":"skin mismatch 65 not in [106]"}}\n'
        )
      );
      child.emit("close", 1);
    });
    return child;
  };
  const out2 = await runWizardBridge({
    action: "usb-flash-firmware",
    confirmAction: "usb-flash-firmware",
    spawnImpl: fakeSpawn2,
  });
  assert.equal(out2.ok, false);
  assert.match(out2.error, /skin mismatch/);
});

test("runWizardAction gives usb-provision-local/usb-flash-firmware >=240000ms headroom and verifyTimeoutS 180 default", async () => {
  const captured = {};
  const fakeBridge = async (opts) => {
    captured[opts.action] = opts;
    return { ok: true, exitCode: 0, pythonPath: "python3", events: [], result: { ok: true } };
  };

  await runWizardAction({
    action: "usb-provision-local",
    confirmAction: "usb-provision-local",
    remoteId: 20261111,
    runBridgeImpl: fakeBridge,
  });
  assert.equal(captured["usb-provision-local"].verifyTimeoutS, 180);
  assert.ok(captured["usb-provision-local"].processTimeoutMs >= 240000);

  await runWizardAction({
    action: "usb-flash-firmware",
    confirmAction: "usb-flash-firmware",
    firmwareFile: "/tmp/4.15.600.hfw2",
    runBridgeImpl: fakeBridge,
  });
  assert.equal(captured["usb-flash-firmware"].verifyTimeoutS, 180);
  assert.ok(captured["usb-flash-firmware"].processTimeoutMs >= 240000);

  // Explicit overrides (including 0 to skip verify) are preserved
  await runWizardAction({
    action: "usb-provision-local",
    confirmAction: "usb-provision-local",
    remoteId: 20261111,
    verifyTimeoutS: 0,
    processTimeoutMs: 180000,
    runBridgeImpl: fakeBridge,
  });
  assert.equal(captured["usb-provision-local"].verifyTimeoutS, 0);

  // Melodious-installed Screen 1 keeps primary Open Melodious button plus subtle Erase & set up from scratch link
  const freshState = wizardFlow.createInitialWizardState(4150);
  freshState.classifyResult = {
    verdict: "melodious-installed",
    verdictLabel: "Melodious ready",
    verdictSummary: "ok",
    signals: { lan: { host: "192.168.0.100", ports: { 8080: true } }, usb: {}, ssdp: {} },
    firmwareGate: { passes: true },
    mismatch: {},
  };
  freshState.hostInput = "192.168.0.100";
  const step1Html = wizardFlow.renderWizardPage(freshState);
  assert.match(step1Html, /Melodious is already installed on this hub/);
  assert.match(step1Html, /Open Melodious →/);
  assert.match(step1Html, /Erase &amp; set up from scratch…/);
});

test("detectAndClassify isolates multi-hub SSDP from USB hub and strictly honors explicit host", async () => {
  // 1. Explicit host ("192.168.0.235") ALWAYS overrides SSDP ("192.168.0.234")
  const explicitWebUiHosts = [];
  const explicitBridgeCalls = [];
  const explicitRes = await detectAndClassify({
    userIntent: "fresh",
    host: "192.168.0.235",
    skipUsb: false,
    mask: false,
    scanSsdpImpl: async () => [{ host: "192.168.0.234", webUiPort: 8080, hbusPort: 8088 }],
    probeHubImpl: async ({ host }) => {
      explicitWebUiHosts.push(host);
      return null;
    },
    runBridgeImpl: async (opts) => {
      explicitBridgeCalls.push({ host: opts.host, skipUsb: opts.skipUsb });
      return {
        ok: true,
        exitCode: 0,
        pythonPath: "python3",
        events: [],
        result: {
          ok: true,
          usb: {
            ok: true,
            connected: true,
            deviceCount: 1,
            preflight: { ok: true, hasHubId: false },
            sysinfo: { ok: true, fwVer: "4.15.600", skinDecimal: 106 },
            provisionInfo: { ok: true, provisioned: false },
            discoveryInfo: { ok: true, provisioned: false, hasIp: true, ip: "192.168.0.235" },
          },
          lan: {
            ok: true,
            host: "192.168.0.235",
            provisionInfo: { ok: true, provisioned: false },
            ports: { 8080: false, 8088: true, 5222: false, 22: false },
          },
        },
      };
    },
  });
  assert.deepEqual(explicitWebUiHosts, ["192.168.0.235"]);
  assert.deepEqual(explicitBridgeCalls, [{ host: "192.168.0.235", skipUsb: false }]);
  assert.equal(explicitRes.verdict, "fresh");
  assert.equal(wizardFlow.extractDetectedHost(explicitRes), "192.168.0.235");

  // 2. Blank host + USB connected with NO IP (fresh hub before Wi-Fi) while Hub 1 (.234) is on SSDP:
  //    MUST NOT probe .234 or merge .234's Melodious :8080/:22 into Hub 2's verdict!
  const freshUsbWebUiHosts = [];
  const freshUsbBridgeCalls = [];
  const freshUsbRes = await detectAndClassify({
    userIntent: "fresh",
    host: "",
    skipUsb: false,
    mask: false,
    scanSsdpImpl: async () => [{ host: "192.168.0.234", webUiPort: 8080, hbusPort: 8088 }],
    probeHubImpl: async ({ host }) => {
      freshUsbWebUiHosts.push(host);
      return { host, port: 8080, firmware: "4.15.600 (Melodious 2.0.0)" };
    },
    runBridgeImpl: async (opts) => {
      freshUsbBridgeCalls.push({ host: opts.host, skipUsb: opts.skipUsb });
      return {
        ok: true,
        exitCode: 0,
        pythonPath: "python3",
        events: [],
        result: {
          ok: true,
          usb: {
            ok: true,
            connected: true,
            deviceCount: 1,
            preflight: { ok: true, hasHubId: false },
            sysinfo: { ok: true, fwVer: "4.15.600", skinDecimal: 106 },
            provisionInfo: { ok: true, provisioned: false },
            discoveryInfo: { ok: true, provisioned: false, hasIp: false, ip: "" },
          },
          lan: { ok: false, skipped: true },
        },
      };
    },
  });
  assert.deepEqual(freshUsbWebUiHosts, []);
  assert.deepEqual(freshUsbBridgeCalls, [{ host: "", skipUsb: false }]);
  assert.equal(freshUsbRes.verdict, "fresh");
  assert.equal(freshUsbRes.signals.lan.host, "");
  assert.equal(wizardFlow.extractDetectedHost(freshUsbRes), "");

  // 3. Blank host + USB connected WITH discoveryInfo.ip = "192.168.0.235" while Hub 1 (.234) is on SSDP:
  //    probes USB first, then probes :8080 and LAN ports on "192.168.0.235" (never .234!)
  const usbWithIpWebUiHosts = [];
  const usbWithIpBridgeCalls = [];
  const usbWithIpRes = await detectAndClassify({
    userIntent: "fresh",
    host: "",
    skipUsb: false,
    mask: false,
    scanSsdpImpl: async () => [{ host: "192.168.0.234", webUiPort: 8080, hbusPort: 8088 }],
    probeHubImpl: async ({ host }) => {
      usbWithIpWebUiHosts.push(host);
      return null;
    },
    runBridgeImpl: async (opts) => {
      usbWithIpBridgeCalls.push({ host: opts.host, skipUsb: opts.skipUsb });
      if (!opts.skipUsb) {
        return {
          ok: true,
          exitCode: 0,
          pythonPath: "python3",
          events: [{ type: "step", step: "usb-preflight" }],
          result: {
            ok: true,
            usb: {
              ok: true,
              connected: true,
              deviceCount: 1,
              preflight: { ok: true, hasHubId: false },
              sysinfo: { ok: true, fwVer: "4.15.600", skinDecimal: 106 },
              provisionInfo: { ok: true, provisioned: false },
              discoveryInfo: { ok: true, provisioned: false, hasIp: true, ip: "192.168.0.235" },
            },
            lan: { ok: false, skipped: true },
          },
        };
      }
      return {
        ok: true,
        exitCode: 0,
        pythonPath: "python3",
        events: [{ type: "step", step: "lan-ports" }],
        result: {
          ok: true,
          usb: { ok: false, skipped: true, connected: false },
          lan: {
            ok: true,
            host: "192.168.0.235",
            provisionInfo: { ok: true, provisioned: false },
            ports: { 8080: false, 8088: true, 5222: false, 22: false },
          },
        },
      };
    },
  });
  assert.deepEqual(usbWithIpWebUiHosts, ["192.168.0.235"]);
  assert.deepEqual(usbWithIpBridgeCalls, [
    { host: "", skipUsb: false },
    { host: "192.168.0.235", skipUsb: true },
  ]);
  assert.equal(usbWithIpRes.verdict, "fresh");
  assert.equal(wizardFlow.extractDetectedHost(usbWithIpRes), "192.168.0.235");

  // 4. Blank host + USB NOT connected + single SSDP candidate ("192.168.0.234"): auto-picks .234
  const noUsbWebUiHosts = [];
  const noUsbBridgeCalls = [];
  const noUsbRes = await detectAndClassify({
    userIntent: "provisioned",
    host: "",
    skipUsb: false,
    mask: false,
    scanSsdpImpl: async () => [{ host: "192.168.0.234", webUiPort: 8080, hbusPort: 8088 }],
    probeHubImpl: async ({ host }) => {
      noUsbWebUiHosts.push(host);
      return { host, port: 8080, firmware: "4.15.600" };
    },
    runBridgeImpl: async (opts) => {
      noUsbBridgeCalls.push({ host: opts.host, skipUsb: opts.skipUsb });
      if (!opts.skipUsb) {
        return {
          ok: false,
          exitCode: 1,
          pythonPath: "python3",
          events: [],
          result: { ok: false, usb: { ok: false, connected: false, deviceCount: 0 } },
        };
      }
      return {
        ok: true,
        exitCode: 0,
        pythonPath: "python3",
        events: [],
        result: {
          ok: true,
          usb: { ok: false, skipped: true, connected: false },
          lan: {
            ok: true,
            host: "192.168.0.234",
            ports: { 8080: true, 8088: true, 5222: false, 22: true },
          },
        },
      };
    },
  });
  assert.deepEqual(noUsbWebUiHosts, ["192.168.0.234"]);
  assert.deepEqual(noUsbBridgeCalls, [
    { host: "", skipUsb: false },
    { host: "192.168.0.234", skipUsb: true },
  ]);
  assert.equal(noUsbRes.verdict, "melodious-installed");
  assert.equal(wizardFlow.extractDetectedHost(noUsbRes), "192.168.0.234");
});

test("detectHostKeyChanged, clearKnownHost, installFreshHub, and wizard:install-hub handle stale SSH known_hosts safely", async () => {
  // 1. detectHostKeyChanged extracts SHA256:... on SSH exit 255 host-key mismatch and returns false on normal errors
  const mismatchLines = [
    "== Checking SSH ==",
    "ERROR: ssh failed with exit 255",
    "stderr=@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@",
    "@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @",
    "@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@",
    "The fingerprint for the ED25519 key sent by the remote host is",
    "SHA256:iBUS0y/T7zckz4UB4K5mj8w55uLM3KczRAGKleMWb9I.",
    "Offending ED25519 key in /Users/matt/.ssh/known_hosts:45",
    "Host key verification failed.",
    "ERROR: Host key verification failed.",
  ];
  assert.deepEqual(detectHostKeyChanged(mismatchLines), {
    hostKeyChanged: true,
    fingerprint: "SHA256:iBUS0y/T7zckz4UB4K5mj8w55uLM3KczRAGKleMWb9I",
  });
  assert.deepEqual(detectHostKeyChanged(["ERROR: Host key verification failed."]), {
    hostKeyChanged: true,
    fingerprint: "",
  });
  assert.deepEqual(
    detectHostKeyChanged([
      "== Checking SSH ==",
      "ERROR: ssh: connect to host 192.168.0.235 port 22: Connection refused",
    ]),
    {
      hostKeyChanged: false,
      fingerprint: "",
    }
  );
  assert.deepEqual(detectHostKeyChanged([]), {
    hostKeyChanged: false,
    fingerprint: "",
  });

  // 2. clearKnownHost invokes /usr/bin/ssh-keygen -R <host> (and [host]:port for non-22) with safe argv
  const execCalls = [];
  const cleared22 = await clearKnownHost({
    host: "192.168.0.235",
    execFileImpl: (bin, args, cb) => {
      execCalls.push({ bin, args });
      cb(null, "# Host 192.168.0.235 found: line 45\n", "/Users/owner/.ssh/known_hosts updated.\n");
    },
  });
  assert.deepEqual(cleared22, { ok: true, target: "192.168.0.235", removed: true });

  const cleared2222 = await clearKnownHost({
    host: "192.168.0.235",
    sshPort: 2222,
    execFileImpl: (bin, args, cb) => {
      execCalls.push({ bin, args });
      cb(new Error("exit 1"), "", "Host [192.168.0.235]:2222 not found in /Users/owner/.ssh/known_hosts\n");
    },
  });
  assert.deepEqual(cleared2222, { ok: true, target: "[192.168.0.235]:2222", removed: false });

  const missingKnownHosts = await clearKnownHost({
    host: "192.168.0.235",
    execFileImpl: (_bin, _args, cb) => {
      cb(new Error("exit 255"), "", "Cannot stat /Users/owner/.ssh/known_hosts: No such file or directory\n");
    },
  });
  assert.deepEqual(missingKnownHosts, { ok: true, target: "192.168.0.235", removed: false });

  assert.deepEqual(execCalls, [
    { bin: "/usr/bin/ssh-keygen", args: ["-R", "192.168.0.235"] },
    { bin: "/usr/bin/ssh-keygen", args: ["-R", "[192.168.0.235]:2222"] },
  ]);

  await assert.rejects(
    () => clearKnownHost({ host: "--option-inject", execFileImpl: () => {} }),
    /Invalid hub host/
  );
  await assert.rejects(
    () => clearKnownHost({ host: "192.168.0.235; rm -rf /", execFileImpl: () => {} }),
    /Invalid hub host/
  );

  // 3. installFreshHub default replaceStaleHostKey=false does NOT call clearKnownHost and surfaces hostKeyChanged + fingerprint
  const tmpRootDir = fs.mkdtempSync(path.join(os.tmpdir(), "melodious-wiz-kh-test-"));
  const localZip = path.join(tmpRootDir, "fake-hub.zip");
  fs.writeFileSync(localZip, Buffer.from("PK-fake", "utf8"));
  try {
    let clearCalls = 0;
    const mismatchRes = await installFreshHub({
      source: "local",
      hubZipPath: localZip,
      host: "192.168.0.235",
      hubId: 20266868,
      readLocalHubZipImpl: async () => makeSyntheticVerifiedPayload("2.0.0"),
      clearKnownHostImpl: async () => {
        clearCalls += 1;
        return { ok: true };
      },
      spawnImpl: () => {
        const child = new EventEmitter();
        child.stdin = { on() {}, end() {} };
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.kill = () => {};
        setImmediate(() => {
          child.stdout.emit("data", Buffer.from("== Checking SSH ==\n"));
          child.stderr.emit(
            "data",
            Buffer.from(`${mismatchLines.slice(1).join("\n")}\n`)
          );
          child.emit("close", 1);
        });
        return child;
      },
      tmpRootDir,
    });
    assert.equal(clearCalls, 0, "must not clear known_hosts by default");
    assert.equal(mismatchRes.ok, false);
    assert.equal(mismatchRes.hostKeyChanged, true);
    assert.equal(
      mismatchRes.hostKeyFingerprint,
      "SHA256:iBUS0y/T7zckz4UB4K5mj8w55uLM3KczRAGKleMWb9I"
    );
    assert.match(mismatchRes.error, /SSH host key changed on 192\.168\.0\.235/);

    // When replaceStaleHostKey=true, clearKnownHost runs BEFORE install_webui.py and emits step event
    const order = [];
    const events = [];
    const refreshedRes = await installFreshHub({
      source: "local",
      hubZipPath: localZip,
      host: "192.168.0.235",
      hubId: 20266868,
      replaceStaleHostKey: true,
      preflightOnly: true,
      readLocalHubZipImpl: async () => makeSyntheticVerifiedPayload("2.0.0"),
      clearKnownHostImpl: async ({ host, sshPort }) => {
        order.push(`clear:${host}:${sshPort}`);
        return { ok: true, target: host, removed: true };
      },
      spawnImpl: () => {
        order.push("spawn:install_webui.py");
        const child = new EventEmitter();
        child.stdin = { on() {}, end() {} };
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.kill = () => {};
        setImmediate(() => {
          child.stdout.emit("data", Buffer.from("verdict=ALLOWED\n"));
          child.emit("close", 0);
        });
        return child;
      },
      onEvent: (evt) => events.push(evt),
      tmpRootDir,
    });
    assert.equal(refreshedRes.ok, true);
    assert.deepEqual(order, ["clear:192.168.0.235:22", "spawn:install_webui.py"]);
    assert.ok(
      events.some(
        (e) =>
          e.type === "step" &&
          e.step === "install-refresh-known-host" &&
          /Refreshing saved SSH host key for 192\.168\.0\.235/.test(e.message)
      )
    );
  } finally {
    fs.rmSync(tmpRootDir, { recursive: true, force: true });
  }

  // 4. wizard:install-hub IPC forwards replaceStaleHostKey strictly as boolean
  const mainFrame = { url: "melodious://app/" };
  const mainWin = { isDestroyed: () => false, webContents: { mainFrame, send() {} } };
  const trustedEvent = { sender: mainWin.webContents, senderFrame: mainFrame };
  const forwarded = [];
  const handlers = createWizardIpcHandlers({
    getMainWindow: () => mainWin,
    isWizardAvailable: () => true,
    installFreshHubImpl: async (opts) => {
      forwarded.push(opts.replaceStaleHostKey);
      return { ok: true, version: "2.0.0" };
    },
  });
  await handlers[WIZARD_CHANNELS.installHub](trustedEvent, {
    source: "latest",
    host: "192.168.0.235",
    hubId: 20266868,
  });
  await handlers[WIZARD_CHANNELS.installHub](trustedEvent, {
    source: "latest",
    host: "192.168.0.235",
    hubId: 20266868,
    replaceStaleHostKey: true,
  });
  assert.deepEqual(forwarded, [false, true]);
});
