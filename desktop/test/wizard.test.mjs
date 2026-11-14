import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  WIZARD_CHANNELS,
  READONLY_BRIDGE_ACTIONS,
  MUTATING_BRIDGE_ACTIONS,
  isWizardDevAvailable,
  VERDICTS,
  resolvePythonExecutable,
  validatePositiveRemoteId,
  buildBridgeArgs,
  runWizardBridge,
  classifyHubSignals,
  detectAndClassify,
  runWizardAction,
  createWizardIpcHandlers,
} = require("../src/wizard/index.js");

test("isWizardDevAvailable gates the unfinished dev UI out of packaged and non-macOS builds", () => {
  assert.equal(isWizardDevAvailable({ isPackaged: false, platform: "darwin" }), true);
  assert.equal(isWizardDevAvailable({ isPackaged: true, platform: "darwin" }), false);
  assert.equal(isWizardDevAvailable({ isPackaged: false, platform: "win32" }), false);
  assert.equal(isWizardDevAvailable({ isPackaged: true, platform: "win32" }), false);
  assert.equal(isWizardDevAvailable({ isPackaged: false, platform: "linux" }), false);
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

test("resolvePythonExecutable prefers MELODIOUS_WIZARD_PYTHON then .venv/bin/python", () => {
  assert.equal(
    resolvePythonExecutable({
      env: { MELODIOUS_WIZARD_PYTHON: "/custom/python3" },
      existsSync: () => true,
    }),
    "/custom/python3"
  );
  assert.equal(
    resolvePythonExecutable({
      env: {},
      platform: "darwin",
      hubRootDir: "/repo/tools/hub-root",
      existsSync: (p) => p === "/repo/tools/hub-root/.venv/bin/python",
    }),
    "/repo/tools/hub-root/.venv/bin/python"
  );
  assert.equal(
    resolvePythonExecutable({
      env: {},
      platform: "win32",
      hubRootDir: "C:\\repo\\tools\\hub-root",
      existsSync: (p) => p === "C:\\repo\\tools\\hub-root\\.venv\\Scripts\\python.exe",
    }),
    "C:\\repo\\tools\\hub-root\\.venv\\Scripts\\python.exe"
  );
  assert.equal(
    resolvePythonExecutable({
      env: {},
      platform: "darwin",
      hubRootDir: "/repo/tools/hub-root",
      existsSync: () => false,
    }),
    "python3"
  );
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

  // 1. Test isWizardDevAvailable gating on IPC handlers (packaged / non-macOS disabled)
  const disabledHandlers = createWizardIpcHandlers({
    getMainWindow: () => mainWin,
    isWizardAvailable: () => isWizardDevAvailable({ isPackaged: true, platform: "darwin" }),
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
  assert.equal(capturedBridgeHost, "192.168.0.235");
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
