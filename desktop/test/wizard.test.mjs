import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { HUB_FILES, unzipCommand } = require("../src/hub-update.js");
const {
  WIZARD_CHANNELS,
  READONLY_BRIDGE_ACTIONS,
  MUTATING_BRIDGE_ACTIONS,
  isWizardDevAvailable,
  VERDICTS,
  resolvePythonExecutable,
  validatePositiveRemoteId,
  validatePositiveHubId,
  buildBridgeArgs,
  buildInstallerArgs,
  runWizardBridge,
  classifyHubSignals,
  detectAndClassify,
  runWizardAction,
  installFreshHub,
  createWizardIpcHandlers,
} = require("../src/wizard/index.js");
const wizardFlow = require("../src/wizard/flow.js");

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
    isWizardAvailable: () => isWizardDevAvailable({ isPackaged: true, platform: "darwin" }),
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

test("wizard/flow.js pure model computes Fresh & Provisioned step states and renders Steps 1-3 cleanly", () => {
  assert.equal(wizardFlow.parsePositiveIntInput("20264150"), 20264150);
  assert.equal(wizardFlow.parsePositiveIntInput("0"), null);
  assert.equal(wizardFlow.parsePositiveIntInput("-12"), null);
  assert.equal(wizardFlow.parsePositiveIntInput("2026abc"), null);

  const st = wizardFlow.createInitialWizardState(4150);
  assert.equal(st.remoteIdInput, "20264150");
  assert.equal(wizardFlow.computeFreshChecklistStatus(st).currentStage, 1);

  const step1Html = wizardFlow.renderWizardPage(st);
  assert.match(step1Html, /Step 1 of 3/);
  assert.match(step1Html, /Already set up with Logitech/);
  assert.match(step1Html, /Factory reset \/ starting fresh/);
  assert.match(step1Html, /Developer \/ Manual Step Overrides/);

  st.firmwarePassed = true;
  assert.equal(wizardFlow.computeFreshChecklistStatus(st).currentStage, 2);
  st.wifiConnected = true;
  st.confirmedHost = "192.168.0.235";
  assert.equal(wizardFlow.computeFreshChecklistStatus(st).currentStage, 3);
  st.tdeDone = true;
  st.provisionLocalDone = true;
  st.seedAutomationDone = true;
  assert.equal(wizardFlow.computeFreshChecklistStatus(st).currentStage, 4);
  st.step = 2;
  st.flowPath = "fresh";
  const step2FreshHtml = wizardFlow.renderWizardPage(st);
  assert.match(step2FreshHtml, /Root &amp; Install Melodious/);

  st.step = 3;
  st.handoffConnected = true;
  st.handoffHost = "192.168.0.235";
  const step3Html = wizardFlow.renderWizardPage(st);
  assert.match(step3Html, /Add your first device/);
  assert.match(step3Html, /Create your first activity/);
  assert.match(step3Html, /Pair your remote/);
  assert.match(step3Html, /Open Hub/);
});
