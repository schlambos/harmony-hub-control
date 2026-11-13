import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  WIZARD_CHANNELS,
  isWizardDevAvailable,
  VERDICTS,
  resolvePythonExecutable,
  buildBridgeArgs,
  runWizardBridge,
  classifyHubSignals,
  detectAndClassify,
  createWizardIpcHandlers,
} = require("../src/wizard/index.js");

test("isWizardDevAvailable gates the unfinished dev UI out of packaged and non-macOS builds", () => {
  assert.equal(isWizardDevAvailable({ isPackaged: false, platform: "darwin" }), true);
  assert.equal(isWizardDevAvailable({ isPackaged: true, platform: "darwin" }), false);
  assert.equal(isWizardDevAvailable({ isPackaged: false, platform: "win32" }), false);
  assert.equal(isWizardDevAvailable({ isPackaged: true, platform: "win32" }), false);
  assert.equal(isWizardDevAvailable({ isPackaged: false, platform: "linux" }), false);
});

test("buildBridgeArgs permits only read-only actions and validates host/backend/timeout", () => {
  for (const okAction of [
    "probe",
    "classify",
    "usb-enumerate",
    "usb-preflight",
    "usb-sysinfo",
    "lan-provision-info",
  ]) {
    const args = buildBridgeArgs({ action: okAction, host: "192.168.0.235", mask: true });
    assert.ok(args.includes(okAction));
    assert.ok(args.includes("--mask"));
  }

  for (const forbidden of [
    "factory-reset",
    "usb-factory-reset",
    "flash-firmware",
    "usb-flash-firmware",
    "lan-root",
    "provision-wifi",
    "enable-xmpp",
  ]) {
    assert.throws(
      () => buildBridgeArgs({ action: forbidden }),
      /Disallowed wizard_bridge action/
    );
  }

  assert.throws(() => buildBridgeArgs({ usbBackend: "libusb-raw" }), /Invalid USB backend/);
  assert.throws(() => buildBridgeArgs({ timeoutMs: 0 }), /Invalid timeoutMs/);
  assert.throws(() => buildBridgeArgs({ host: "--option-inject" }), /Invalid hub host/);
  assert.throws(() => buildBridgeArgs({ host: "192.168.0.1\n" }), /Invalid hub host/);
  assert.throws(() => buildBridgeArgs({ usbDevicePath: "-bad" }), /Invalid USB device path/);
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

test("runWizardBridge parses fragmented NDJSON chunks and spawns real wizard_bridge.py", async () => {
  // 1. Test fragmented NDJSON line reassembly with a fake child process
  const seen = [];
  const fakeSpawn = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    setImmediate(() => {
      child.stdout.emit("data", Buffer.from('{"type":"step","step":"usb-enu'));
      child.stdout.emit(
        "data",
        Buffer.from(
          'merate","message":"Enumerating"}\n{"type":"result","action":"probe","ok":true,"usb":{"ok":true,"connected":true}}\n'
        )
      );
      child.emit("close", 0);
    });
    return child;
  };

  const out = await runWizardBridge({
    action: "probe",
    spawnImpl: fakeSpawn,
    onEvent: (e) => seen.push(e),
  });
  assert.equal(out.ok, true);
  assert.equal(seen.length, 2);
  assert.equal(seen[0].step, "usb-enumerate");
  assert.equal(out.result.usb.connected, true);

  // 2. Spawn the real tools/hub-root/wizard_bridge.py with --skip-usb (pure offline run)
  const realOut = await runWizardBridge({
    action: "classify",
    skipUsb: true,
    mask: true,
  });
  assert.equal(realOut.exitCode, 1); // neither USB nor LAN host provided -> ok=false, classification=unknown
  assert.equal(realOut.result?.type, "result");
  assert.equal(realOut.result?.classification?.verdict, "unknown");
});

test("classifyHubSignals covers all five verdicts, warn-on-mismatch, firmware gate, USB wedge, and masking", () => {
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

  // 2. Provisioned XMPP-on hub + user picked "fresh" -> destructive-reset mismatch warning + firmware gate fail
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

  // 3. Provisioned local hub (5222 closed, mode 3, string remoteId trap)
  const localStringTrap = classifyHubSignals({
    userIntent: "provisioned",
    bridgeResult: {
      usb: { ok: false, connected: false, usbWedge: true, error: "LTCP hbus error frame" },
      lan: {
        ok: true,
        host: "<ip-redacted>",
        provisionInfo: {
          ok: true,
          provisioned: true,
          mode: 3,
          hasActiveRemoteId: true,
          remoteIdType: "string",
          isLocalAccountHint: true,
        },
        ports: { 8080: false, 8088: true, 5222: false, 22: true },
      },
    },
    mask: true,
  });
  assert.equal(localStringTrap.verdict, VERDICTS.PROVISIONED_LOCAL);
  assert.equal(localStringTrap.mismatch.hasMismatch, true);
  assert.match(localStringTrap.mismatch.title, /JSON string/);
  assert.equal(localStringTrap.usbWedge.wedged, true);

  // 4. Melodious already installed (:8080 responds)
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

test("detectAndClassify and wizard:* IPC handlers enforce sender security and auto-select SSDP host", async () => {
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

  let capturedBridgeHost = null;
  const handlers = createWizardIpcHandlers({
    getMainWindow: () => mainWin,
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
              usb: { ok: true, connected: true, deviceCount: 1, preflight: { ok: true, hasHubId: false }, sysinfo: { ok: true, fwVer: "4.15.600" } },
              lan: { ok: true, host: "<ip-redacted>", provisionInfo: { ok: true, provisioned: false }, ports: { 8080: false, 8088: true, 5222: false, 22: false } },
            },
          };
        },
      }),
  });

  await assert.rejects(
    () => handlers[WIZARD_CHANNELS.detectClassify](untrustedEvent, {}),
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
});
