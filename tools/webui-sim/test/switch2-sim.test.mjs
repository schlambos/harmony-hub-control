import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveSkinPowerAction } from "../public/js/views/control-power.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SIM_DIR = path.join(HERE, "..");
const ROOT = path.join(SIM_DIR, "../..");

const POC_SWITCH2_MAC = "D8:6B:83:F0:42:FD";
const POC_CTRL_MAC = "BC:89:A6:1F:CA:5B";
const POC_PID = "66 20";
const POC_PAYLOAD_HEX =
  "0201061BFF53050100037E056620000181FD42F0836BD80F00000000000000";

function startSim() {
  const port = 18900 + Math.floor(Math.random() * 200);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(SIM_DIR, "server.mjs")], {
      env: { ...process.env, PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`sim did not start: ${out}`));
    }, 8000);
    child.stdout.on("data", (chunk) => {
      out += chunk.toString();
      if (out.includes("Listening")) {
        clearTimeout(timer);
        resolve({ child, base: `http://127.0.0.1:${port}` });
      }
    });
    child.stderr.on("data", (chunk) => {
      out += chunk.toString();
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`sim exited (${code}): ${out}`));
    });
  });
}

async function reqJson(base, p, { method = "GET", body } = {}) {
  const res = await fetch(`${base}${p}`, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json() };
}

describe("Switch 2 wake simulator end-to-end", () => {
  let sim;

  before(async () => {
    sim = await startSim();
  });

  after(() => {
    sim?.child?.kill();
  });

  it("creates, validates, edits, runs in an activity power-on sequence, and deletes a Switch 2 wake device", async () => {
    // Version advertises switch2-wake
    const ver = await reqJson(sim.base, "/api/version");
    assert.equal(ver.status, 200);
    assert.ok(ver.json.features.includes("switch2-wake"));

    // Invalid MAC rejected before storage
    const bad = await reqJson(sim.base, "/api/switch2/devices", {
      method: "POST",
      body: {
        devices: [
          {
            entity: "switch2deadbeef",
            name: "Bad Switch 2",
            switch2Mac: "not-a-mac",
            controllerMac: POC_CTRL_MAC,
            pid: POC_PID,
          },
        ],
      },
    });
    assert.equal(bad.status, 422);
    assert.equal(bad.json.ok, false);

    // Add valid Switch 2 wake device
    const add = await reqJson(sim.base, "/api/switch2/devices", {
      method: "POST",
      body: {
        devices: [
          {
            entity: "switch2deadbeef",
            name: "Nintendo Switch 2",
            switch2Mac: POC_SWITCH2_MAC,
            controllerMac: POC_CTRL_MAC,
            pid: POC_PID,
          },
        ],
      },
    });
    assert.equal(add.status, 200);
    assert.equal(add.json.ok, true);
    assert.deepEqual(add.json.added, ["Nintendo Switch 2"]);
    const deviceId = add.json.devices[0].deviceId;
    assert.ok(deviceId);

    // Verify stored DeviceList entry
    const cfg = await reqJson(sim.base, "/api/activity-config");
    const entry = cfg.json.deviceList.DevicesWithFeatures.find((e) => String(e.Device["Id-"]) === deviceId);
    assert.ok(entry);
    assert.equal(entry.Device.Transport, 64);
    assert.equal(entry.Device.AutoDetectedDevice.Id, `melodious-switch2-${deviceId}`);
    assert.deepEqual(entry.Commands.map((c) => c.Name), ["Wake"]);
    const pf = entry.DeviceFeatures.find((f) => f.__type === "PowerFeature");
    assert.equal(pf.PowerTypeId, 1);
    assert.equal(pf.PowerOnActions[0].IRCommandName, "Wake");
    assert.deepEqual(pf.PowerOffActions, []);

    // Device-page header power button resolves Wake from PowerFeature.PowerOnActions
    const headerPower = resolveSkinPowerAction({
      mode: "devices",
      currentActivityId: "-1",
      selectedDeviceId: deviceId,
      deviceCommands: entry.Commands.map((c) => ({ name: c.Name, functionId: c["FunctionId-"] ?? 0 })),
      deviceEntry: entry,
    });
    assert.equal(headerPower.kind, "device-power");
    assert.equal(headerPower.deviceId, deviceId);
    assert.equal(headerPower.command, "Wake");

    // Edit in place preserves DeviceId
    const edit = await reqJson(sim.base, "/api/switch2/devices", {
      method: "POST",
      body: {
        devices: [
          {
            entity: "switch2deadbeef",
            name: "Nintendo Switch 2 Dock",
            switch2Mac: POC_SWITCH2_MAC,
            controllerMac: POC_CTRL_MAC,
            pid: "66 20",
          },
        ],
      },
    });
    assert.equal(edit.status, 200);
    assert.equal(edit.json.devices[0].deviceId, deviceId);

    // Direct /api/switch2/cmd produces exact 31-byte PoC payload
    const cmd = await reqJson(sim.base, "/api/switch2/cmd", {
      method: "POST",
      body: {
        device: "switch2deadbeef",
        command: "Wake",
        switch2Mac: POC_SWITCH2_MAC,
        controllerMac: POC_CTRL_MAC,
        pid: "6620",
      },
    });
    assert.equal(cmd.status, 200);
    assert.equal(cmd.json.payloadHex, POC_PAYLOAD_HEX);

    // Add device to an activity and run the activity -> fires Switch 2 wake burst
    const cfgAfterEdit = await reqJson(sim.base, "/api/activity-config");
    const nextActs = structuredClone(cfgAfterEdit.json.activityList);
    nextActs.Activities.push({
      "Id-": 99911122,
      Name: "Play Switch 2",
      Type: 3,
      Roles: [
        {
          "Id-": 99911123,
          "DeviceId-": Number(deviceId),
          __type: "PlayGameActivityRole",
          PowerOnOrder: 1,
          PowerOffOrder: 1,
          SelectedInput: null,
          NextDevicePowerOnDelay: null,
        },
      ],
    });
    const saved = await reqJson(sim.base, "/api/activity-save", {
      method: "POST",
      body: {
        baseRevision: cfgAfterEdit.json.revision,
        activityList: nextActs,
        mapList: cfgAfterEdit.json.mapList,
        functionList: cfgAfterEdit.json.functionList,
      },
    });
    assert.equal(saved.status, 200);

    const run = await reqJson(sim.base, "/api/activity-run", {
      method: "POST",
      body: { activityId: "99911122" },
    });
    assert.equal(run.status, 200);

    const events = await reqJson(sim.base, "/api/sim/events");
    const wakeEv = events.json.events.find((e) => e.type === "switch2-wake" && e.source === "activity-start");
    assert.ok(wakeEv, "expected activity-start switch2-wake event");
    assert.equal(wakeEv.payloadHex, POC_PAYLOAD_HEX);

    // Deleting while referenced by activity is refused
    const delBlocked = await reqJson(sim.base, "/api/switch2/devices", {
      method: "POST",
      body: { devices: [] },
    });
    assert.equal(delBlocked.status, 422);

    // Remove activity then delete device cleanly
    const cfg2 = await reqJson(sim.base, "/api/activity-config");
    const prunedActs = {
      ...cfg2.json.activityList,
      Activities: cfg2.json.activityList.Activities.filter((a) => String(a["Id-"]) !== "99911122"),
    };
    const saved2 = await reqJson(sim.base, "/api/activity-save", {
      method: "POST",
      body: {
        baseRevision: cfg2.json.revision,
        activityList: prunedActs,
        mapList: cfg2.json.mapList,
        functionList: cfg2.json.functionList,
      },
    });
    assert.equal(saved2.status, 200);

    const delOk = await reqJson(sim.base, "/api/switch2/devices", {
      method: "POST",
      body: { devices: [] },
    });
    assert.equal(delOk.status, 200);
    assert.deepEqual(delOk.json.removed, ["Nintendo Switch 2 Dock"]);
  });
});

describe("codex_webui.c Switch 2 BLE wake execution (host C harness)", () => {
  it("runs exact PoC HCI sequence, enforces advertise-off on failure, rejects bad input, and serializes bursts", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-switch2-c-test-"));
    const mockHcitool = path.join(tmpDir, "mock-hcitool.sh");
    const logFile = path.join(tmpDir, "hci.log");
    const failFile = path.join(tmpDir, "fail-ocf");
    const lockFile = path.join(tmpDir, "switch2.lock");
    const harnessC = path.join(tmpDir, "harness.c");
    const harnessBin = path.join(tmpDir, "harness");

    // Mock hcitool: records every invocation verbatim; optionally simulates
    // either non-zero exit ("exit:<ocf>") or non-zero HCI CC status ("hci:<ocf>:<hex>").
    fs.writeFileSync(
      mockHcitool,
      `#!/bin/sh
LOG="${logFile}"
FAIL="${failFile}"
echo "CALL $*" >> "$LOG"
OCF="$5"
if [ -f "$FAIL" ]; then
  SPEC=$(cat "$FAIL")
  case "$SPEC" in
    "exit:$OCF")
      echo "simulated hcitool failure on $OCF" >&2
      exit 1
      ;;
    "hci:$OCF:"*)
      CODE=\${SPEC#hci:$OCF:}
      echo "< HCI Command: ogf 0x08, ocf $OCF"
      echo "> HCI Event: 0x0e plen 4"
      echo "  01 0A 20 $CODE"
      exit 0
      ;;
  esac
fi
echo "< HCI Command: ogf 0x08, ocf $OCF"
echo "> HCI Event: 0x0e plen 4"
echo "  01 05 20 00"
exit 0
`,
      { mode: 0o755 },
    );

    fs.writeFileSync(
      harnessC,
      `
#define SWITCH2_HCITOOL_PATH "${mockHcitool.replace(/\\/g, "\\\\")}"
#define SWITCH2_LOCK_FILE "${lockFile.replace(/\\/g, "\\\\")}"
#define SWITCH2_BURST_MS 120
#define CODEX_WEBUI_NO_MAIN 1
#include "codex_webui.c"

static void call_cmd(const char *body, char *out, size_t outlen) {
    int sv[2];
    struct request req;
    memset(&req, 0, sizeof(req));
    strcpy(req.method, "POST");
    strcpy(req.path, "/api/switch2/cmd");
    req.body = (char *)body;
    req.body_len = strlen(body);
    if (socketpair(AF_UNIX, SOCK_STREAM, 0, sv) != 0) _exit(2);
    render_switch2_cmd_json(sv[0], &req);
    close(sv[0]);
    ssize_t n = read(sv[1], out, outlen - 1);
    out[n > 0 ? n : 0] = 0;
    close(sv[1]);
}

static void write_text(const char *p, const char *s) {
    FILE *f = fopen(p, "w");
    if (!f) _exit(3);
    fputs(s, f);
    fclose(f);
}

int main(void) {
    char resp[4096];
    const char *valid =
        "{\\"device\\":\\"switch2a1b2c3d4\\",\\"command\\":\\"Wake\\","
        "\\"switch2Mac\\":\\"D8:6B:83:F0:42:FD\\",\\"controllerMac\\":\\"BC:89:A6:1F:CA:5B\\",\\"pid\\":\\"66 20\\"}";

    /* 1. Exact payload byte check */
    unsigned char s2[6], ctrl[6], pid[2], payload[31];
    static const unsigned char expected[31] = {
        0x02, 0x01, 0x06, 0x1B, 0xFF, 0x53, 0x05, 0x01, 0x00, 0x03, 0x7E, 0x05,
        0x66, 0x20, 0x00, 0x01, 0x81,
        0xFD, 0x42, 0xF0, 0x83, 0x6B, 0xD8,
        0x0F, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00
    };
    if (switch2_parse_mac("D8:6B:83:F0:42:FD", s2) != 0) return 10;
    if (switch2_parse_mac("BC:89:A6:1F:CA:5B", ctrl) != 0) return 11;
    if (switch2_parse_pid("66 20", pid) != 0) return 12;
    switch2_build_payload(s2, pid, payload);
    if (memcmp(payload, expected, 31) != 0) return 13;

    /* 2. Reject invalid inputs / injection without calling hcitool */
    call_cmd("{\\"command\\":\\"Wake\\",\\"switch2Mac\\":\\"$(id)\\",\\"controllerMac\\":\\"BC:89:A6:1F:CA:5B\\",\\"pid\\":\\"6620\\"}", resp, sizeof(resp));
    if (!strstr(resp, "400 Bad Request")) return 20;
    call_cmd("{\\"command\\":\\"Wake\\",\\"switch2Mac\\":\\"D8:6B:83:F0:42:FD\\",\\"controllerMac\\":\\"BC:89:A6:1F:CA:5B\\",\\"pid\\":\\"66;id\\"}", resp, sizeof(resp));
    if (!strstr(resp, "400 Bad Request")) return 21;
    call_cmd("{\\"command\\":\\"PowerOff\\",\\"switch2Mac\\":\\"D8:6B:83:F0:42:FD\\",\\"controllerMac\\":\\"BC:89:A6:1F:CA:5B\\",\\"pid\\":\\"6620\\"}", resp, sizeof(resp));
    if (!strstr(resp, "400 Bad Request")) return 22;
    call_cmd("{\\"command\\":\\"Wake\\",\\"switch2Mac\\":\\"D8:6B:83:F0:42:FD\\",\\"controllerMac\\":\\"D8:6B:83:F0:42:FD\\",\\"pid\\":\\"6620\\"}", resp, sizeof(resp));
    if (!strstr(resp, "400 Bad Request")) return 23;
    if (access("${logFile.replace(/\\/g, "\\\\")}", F_OK) == 0) return 24;

    /* 3. Happy path: exact 5 PoC hcitool commands */
    call_cmd(valid, resp, sizeof(resp));
    if (!strstr(resp, "200 OK") || !strstr(resp, "\\"ok\\":true")) return 30;

    /* 4. Simulated failure on step 3 (LE_Set_Advertising_Data): advertise-off MUST still run and caller gets 500 */
    write_text("${failFile.replace(/\\/g, "\\\\")}", "exit:0x0008");
    call_cmd(valid, resp, sizeof(resp));
    if (!strstr(resp, "500 Internal Server Error") || !strstr(resp, "\\"ok\\":false")) return 40;

    /* 5. Simulated HCI Command Complete non-zero status on step 4 (enable): advertise-off MUST still run and caller gets 500 */
    write_text("${failFile.replace(/\\/g, "\\\\")}", "hci:0x000A:12");
    call_cmd(valid, resp, sizeof(resp));
    if (!strstr(resp, "500 Internal Server Error") || !strstr(resp, "0x12")) return 50;

    /* 6. Burst serialization: two concurrent bursts must not overlap */
    unlink("${failFile.replace(/\\/g, "\\\\")}");
    write_text("${logFile.replace(/\\/g, "\\\\")}", "");
    pid_t p1 = fork();
    if (p1 == 0) {
        call_cmd(valid, resp, sizeof(resp));
        _exit(strstr(resp, "200 OK") ? 0 : 61);
    }
    pid_t p2 = fork();
    if (p2 == 0) {
        call_cmd(valid, resp, sizeof(resp));
        _exit(strstr(resp, "200 OK") ? 0 : 62);
    }
    int st1 = 0, st2 = 0;
    waitpid(p1, &st1, 0);
    waitpid(p2, &st2, 0);
    if (!WIFEXITED(st1) || WEXITSTATUS(st1) != 0) return 63;
    if (!WIFEXITED(st2) || WEXITSTATUS(st2) != 0) return 64;

    return 0;
}
`,
    );

    try {
      execFileSync(
        process.env.CC || "cc",
        ["-O2", "-I", path.join(ROOT, "payload/source"), harnessC, "-o", harnessBin],
        { stdio: "pipe" },
      );
      execFileSync(harnessBin, [], { stdio: "pipe" });

      // Check step 6 serialized log: 10 lines total = exact 5-step burst followed by exact 5-step burst
      const lines = fs.readFileSync(logFile, "utf8").trim().split("\n");
      assert.equal(lines.length, 10, `expected 10 serialized hcitool lines, got ${lines.length}:\n${lines.join("\n")}`);

      const expectedBurst = [
        "CALL -i hci0 cmd 0x08 0x0005 0x5B 0xCA 0x1F 0xA6 0x89 0xBC",
        "CALL -i hci0 cmd 0x08 0x0006 0x20 0x00 0x40 0x00 0x00 0x01 0x00 0x00 0x00 0x00 0x00 0x00 0x00 0x07 0x00",
        "CALL -i hci0 cmd 0x08 0x0008 0x1F 0x02 0x01 0x06 0x1B 0xFF 0x53 0x05 0x01 0x00 0x03 0x7E 0x05 0x66 0x20 0x00 0x01 0x81 0xFD 0x42 0xF0 0x83 0x6B 0xD8 0x0F 0x00 0x00 0x00 0x00 0x00 0x00 0x00",
        "CALL -i hci0 cmd 0x08 0x000A 0x01",
        "CALL -i hci0 cmd 0x08 0x000A 0x00",
      ];
      assert.deepEqual(lines.slice(0, 5), expectedBurst, "burst 1 must match PoC HCI sequence verbatim");
      assert.deepEqual(lines.slice(5, 10), expectedBurst, "burst 2 must run strictly after burst 1 finishes");

      // Also verify advertise-off ran on failure in an isolated check
      fs.writeFileSync(logFile, "");
      fs.writeFileSync(failFile, "exit:0x0006");
      const failHarnessC = path.join(tmpDir, "fail_harness.c");
      const failHarnessBin = path.join(tmpDir, "fail_harness");
      fs.writeFileSync(
        failHarnessC,
        `
#define SWITCH2_HCITOOL_PATH "${mockHcitool.replace(/\\/g, "\\\\")}"
#define SWITCH2_LOCK_FILE "${lockFile.replace(/\\/g, "\\\\")}"
#define SWITCH2_BURST_MS 20
#define CODEX_WEBUI_NO_MAIN 1
#include "codex_webui.c"
int main(void) {
    unsigned char s2[6] = {0xD8,0x6B,0x83,0xF0,0x42,0xFD};
    unsigned char ctrl[6] = {0xBC,0x89,0xA6,0x1F,0xCA,0x5B};
    unsigned char pid[2] = {0x66,0x20};
    char err[256];
    int rc = switch2_execute_wake_burst(s2, ctrl, pid, err, sizeof(err));
    return (rc != 0 && strstr(err, "LE_Set_Advertising_Parameters")) ? 0 : 1;
}
`,
      );
      execFileSync(
        process.env.CC || "cc",
        ["-O2", "-I", path.join(ROOT, "payload/source"), failHarnessC, "-o", failHarnessBin],
        { stdio: "pipe" },
      );
      execFileSync(failHarnessBin, [], { stdio: "pipe" });
      const failLines = fs.readFileSync(logFile, "utf8").trim().split("\n");
      assert.deepEqual(failLines, [
        expectedBurst[0],
        expectedBurst[1],
        expectedBurst[4], // advertise-off MUST execute in cleanup!
      ]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("completes full 5-step PoC wake burst with main()'s WNOHANG SIGCHLD reaper installed", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-switch2-sigchld-test-"));
    const mockHcitool = path.join(tmpDir, "mock-hcitool.sh");
    const logFile = path.join(tmpDir, "hci.log");
    const failFile = path.join(tmpDir, "fail-ocf");
    const lockFile = path.join(tmpDir, "switch2.lock");
    const harnessC = path.join(tmpDir, "sigchld_harness.c");
    const harnessBin = path.join(tmpDir, "sigchld_harness");

    fs.writeFileSync(
      mockHcitool,
      `#!/bin/sh
LOG="${logFile}"
FAIL="${failFile}"
echo "CALL $*" >> "$LOG"
OCF="$5"
if [ -f "$FAIL" ]; then
  SPEC=$(cat "$FAIL")
  case "$SPEC" in
    "exit:$OCF")
      echo "simulated hcitool failure on $OCF" >&2
      exit 1
      ;;
    "hci:$OCF:"*)
      CODE=\${SPEC#hci:$OCF:}
      echo "< HCI Command: ogf 0x08, ocf $OCF"
      echo "> HCI Event: 0x0e plen 4"
      echo "  01 0A 20 $CODE"
      exit 0
      ;;
  esac
fi
echo "< HCI Command: ogf 0x08, ocf $OCF"
echo "> HCI Event: 0x0e plen 4"
echo "  01 05 20 00"
exit 0
`,
      { mode: 0o755 },
    );

    const expectedBurst = [
      "CALL -i hci0 cmd 0x08 0x0005 0x5B 0xCA 0x1F 0xA6 0x89 0xBC",
      "CALL -i hci0 cmd 0x08 0x0006 0x20 0x00 0x40 0x00 0x00 0x01 0x00 0x00 0x00 0x00 0x00 0x00 0x00 0x07 0x00",
      "CALL -i hci0 cmd 0x08 0x0008 0x1F 0x02 0x01 0x06 0x1B 0xFF 0x53 0x05 0x01 0x00 0x03 0x7E 0x05 0x66 0x20 0x00 0x01 0x81 0xFD 0x42 0xF0 0x83 0x6B 0xD8 0x0F 0x00 0x00 0x00 0x00 0x00 0x00 0x00",
      "CALL -i hci0 cmd 0x08 0x000A 0x01",
      "CALL -i hci0 cmd 0x08 0x000A 0x00",
    ];

    fs.writeFileSync(
      harnessC,
      `
#define SWITCH2_HCITOOL_PATH "${mockHcitool.replace(/\\/g, "\\\\")}"
#define SWITCH2_LOCK_FILE "${lockFile.replace(/\\/g, "\\\\")}"
#define SWITCH2_BURST_MS 20
#define CODEX_WEBUI_NO_MAIN 1
#include "codex_webui.c"

static int verify_sigchld_handler(void) {
    struct sigaction cur;
    if (sigaction(SIGCHLD, NULL, &cur) != 0) return -1;
    return cur.sa_handler == handle_sigchld ? 0 : -1;
}

static void write_text(const char *p, const char *s) {
    FILE *f = fopen(p, "w");
    if (!f) _exit(3);
    fputs(s, f);
    fclose(f);
}

int main(void) {
    struct sigaction sa;
    unsigned char s2[6] = {0xD8, 0x6B, 0x83, 0xF0, 0x42, 0xFD};
    unsigned char ctrl[6] = {0xBC, 0x89, 0xA6, 0x1F, 0xCA, 0x5B};
    unsigned char pid[2] = {0x66, 0x20};
    char err[512];
    char out[512];
    int hci_st = -1;
    char *argv_rand[] = {
        "hcitool", "-i", "hci0", "cmd", "0x08", "0x0005",
        "0x5B", "0xCA", "0x1F", "0xA6", "0x89", "0xBC", NULL
    };

    /* Install main()'s exact WNOHANG SIGCHLD reaper (codex_webui.c main()). */
    memset(&sa, 0, sizeof(sa));
    sa.sa_handler = handle_sigchld;
    sigemptyset(&sa.sa_mask);
    sa.sa_flags = SA_RESTART;
    if (sigaction(SIGCHLD, &sa, NULL) != 0) return 10;

    /* 1. Direct switch2_run_hcitool() must not lose child to SIGCHLD reaper. */
    if (switch2_run_hcitool(argv_rand, out, sizeof(out), &hci_st) != 0) {
        fprintf(stderr, "step 1 failed: hci_st=%d out=%s\\n", hci_st, out);
        return 11;
    }
    if (hci_st != 0) return 12;
    if (verify_sigchld_handler() != 0) return 13;

    /* 2. Full 5-step PoC wake burst completes and reaches Advertise Enable(On). */
    write_text("${logFile.replace(/\\/g, "\\\\")}", "");
    if (switch2_execute_wake_burst(s2, ctrl, pid, err, sizeof(err)) != 0) {
        fprintf(stderr, "step 2 failed: %s\\n", err);
        return 20;
    }
    if (verify_sigchld_handler() != 0) return 21;

    /* 3. Mid-sequence failure on LE_Set_Advertising_Data still runs advertise-off
          and restores SIGCHLD disposition. */
    write_text("${logFile.replace(/\\/g, "\\\\")}.midfail", "");
    write_text("${failFile.replace(/\\/g, "\\\\")}", "exit:0x0008");
    /* Redirect log checks via separate section marker */
    write_text("${logFile.replace(/\\/g, "\\\\")}", "");
    if (switch2_execute_wake_burst(s2, ctrl, pid, err, sizeof(err)) == 0) {
        fprintf(stderr, "step 3 unexpectedly succeeded\\n");
        return 30;
    }
    if (!strstr(err, "LE_Set_Advertising_Data")) {
        fprintf(stderr, "step 3 unexpected err: %s\\n", err);
        return 31;
    }
    if (verify_sigchld_handler() != 0) return 32;
    /* Copy log before next step */
    {
        FILE *in = fopen("${logFile.replace(/\\/g, "\\\\")}", "r");
        FILE *copy = fopen("${logFile.replace(/\\/g, "\\\\")}.midfail", "w");
        int ch;
        if (!in || !copy) return 33;
        while ((ch = fgetc(in)) != EOF) fputc(ch, copy);
        fclose(in);
        fclose(copy);
    }

    /* 4. HCI Command Complete non-zero status on step 4 reports 0x12 and still runs advertise-off. */
    write_text("${failFile.replace(/\\/g, "\\\\")}", "hci:0x000A:12");
    write_text("${logFile.replace(/\\/g, "\\\\")}", "");
    if (switch2_execute_wake_burst(s2, ctrl, pid, err, sizeof(err)) == 0) {
        fprintf(stderr, "step 4 unexpectedly succeeded\\n");
        return 40;
    }
    if (!strstr(err, "LE_Set_Advertise_Enable(on) rejected (HCI status 0x12)")) {
        fprintf(stderr, "step 4 unexpected err: %s\\n", err);
        return 41;
    }
    if (verify_sigchld_handler() != 0) return 42;
    {
        FILE *in = fopen("${logFile.replace(/\\/g, "\\\\")}", "r");
        FILE *copy = fopen("${logFile.replace(/\\/g, "\\\\")}.hcifail", "w");
        int ch;
        if (!in || !copy) return 43;
        while ((ch = fgetc(in)) != EOF) fputc(ch, copy);
        fclose(in);
        fclose(copy);
    }

    /* 5. Re-run clean full 5-step burst to leave exact 5-line happy log in logFile. */
    unlink("${failFile.replace(/\\/g, "\\\\")}");
    write_text("${logFile.replace(/\\/g, "\\\\")}", "");
    if (switch2_execute_wake_burst(s2, ctrl, pid, err, sizeof(err)) != 0) {
        fprintf(stderr, "step 5 failed: %s\\n", err);
        return 50;
    }
    if (verify_sigchld_handler() != 0) return 51;

    return 0;
}
`,
    );

    try {
      execFileSync(
        process.env.CC || "cc",
        ["-O2", "-I", path.join(ROOT, "payload/source"), harnessC, "-o", harnessBin],
        { stdio: "pipe" },
      );
      execFileSync(harnessBin, [], { stdio: "pipe" });

      // Happy path: all 5 PoC steps ran in exact order, including exact 31-byte payload and Advertise Enable(On)
      const happyLines = fs.readFileSync(logFile, "utf8").trim().split("\n");
      assert.deepEqual(
        happyLines,
        expectedBurst,
        "full 5-step PoC sequence must complete under WNOHANG SIGCHLD reaper",
      );

      // Mid-sequence failure on step 3 (LE_Set_Advertising_Data): steps 1-3 + advertise-off cleanup (step 5), no step 4
      const midFailLines = fs.readFileSync(`${logFile}.midfail`, "utf8").trim().split("\n");
      assert.deepEqual(
        midFailLines,
        [expectedBurst[0], expectedBurst[1], expectedBurst[2], expectedBurst[4]],
        "advertise-off must still run on mid-sequence failure under WNOHANG SIGCHLD reaper",
      );

      // HCI status 0x12 error on step 4 (LE_Set_Advertise_Enable on): steps 1-4 + advertise-off cleanup (step 5)
      const hciFailLines = fs.readFileSync(`${logFile}.hcifail`, "utf8").trim().split("\n");
      assert.deepEqual(
        hciFailLines,
        expectedBurst,
        "advertise-off must still run after HCI status error on step 4 under WNOHANG SIGCHLD reaper",
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
