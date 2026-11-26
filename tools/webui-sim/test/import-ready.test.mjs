// Restores wait until the hub is ready (GET /api/config-ready): the Backup
// view's model and the simulator's routes, which mirror codex_webui's
// render_config_ready_json and the 503 its /import answers before that.
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { READY_TARGETS, RESOURCES, importReadiness, readyPollDelay } from "../public/js/views/backup-model.js";

const OPEN = { locked: false, message: "", canOverride: false, force: false };

describe("importReadiness (Backup view model)", () => {
  it("guards exactly the bundle and the six resource lists", () => {
    const resources = RESOURCES.filter((r) => r.kind === "resource").map((r) => r.target);
    assert.deepEqual([...READY_TARGETS].sort(), ["bundle", ...resources].sort());
  });

  it("never locks a settings restore", () => {
    for (const target of ["mqtt", "wifi", "cloud", "bluetooth", "restrictions"]) {
      assert.deepEqual(importReadiness(target, { ready: false, message: "x" }), OPEN);
      assert.deepEqual(importReadiness(target, { ready: false, message: "x" }, { override: true }), OPEN);
    }
  });

  it("locks a resource restore while readiness is unknown or false", () => {
    assert.equal(importReadiness("bundle", null).locked, true);
    assert.equal(importReadiness("bundle", null).canOverride, false, "no override before the hub has answered");
    const waiting = importReadiness("devices", { ready: false, message: "The hub is still starting up." });
    assert.equal(waiting.locked, true);
    assert.match(waiting.message, /still starting up.*unlocks by itself/);
    assert.equal(waiting.canOverride, true);
    assert.equal(waiting.force, false);
  });

  it("restores without waiting only when asked, and then sends force", () => {
    const forced = importReadiness("devices", { ready: false, message: "Starting." }, { override: true });
    assert.equal(forced.locked, false);
    assert.equal(forced.force, true);
    assert.match(forced.message, /^Starting\. You chose to restore without waiting/);
    assert.deepEqual(importReadiness("devices", { ready: true }, { override: true }), OPEN, "a ready hub needs no force");
  });

  it("polls every 3 s for a minute, then every 10 s", () => {
    assert.equal(readyPollDelay(0), 3000);
    assert.equal(readyPollDelay(19), 3000);
    assert.equal(readyPollDelay(20), 10000);
  });

  it("unlocks when ready, and when the probe itself failed (the hub still refuses)", () => {
    assert.deepEqual(importReadiness("bundle", { ready: true }), OPEN);
    assert.deepEqual(importReadiness("bundle", new Error("HTTP 404")), OPEN);
  });
});

const SERVER = fileURLToPath(new URL("../server.mjs", import.meta.url));
const PORT = 19100 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;
let proc;

const postJson = (path, body) => fetch(`${BASE}${path}`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
const postForm = (path, fields) => fetch(`${BASE}${path}`, {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(fields).toString(),
});
const msgOf = (html) => (html.match(/<div class='msg'>([\s\S]*?)<\/div>/) || [])[1] || "";
const BUNDLE_FILES = {
  "DeviceList.json": '{"DevicesWithFeatures":[]}', "FunctionList.json": '{"FunctionMaps":[]}',
  "ProtocolList.json": '{"Protocols":[]}', "ActivityList.json": '{"Activities":[]}',
  "MapList.json": '{"ButtonMaps":[]}', "AutomationConfig.json": "{}",
  "mqtt-config.json": '{"broker":{},"baseTopic":"harmony"}',
  "wpa_supplicant.conf": 'network={\n ssid="x"\n}',
};
const bundle = (extra = {}) => JSON.stringify({ format: "harmony-owner-bundle-v2", files: { ...BUNDLE_FILES, ...extra } });

describe("simulator import readiness", () => {
  before(async () => {
    proc = spawn(process.execPath, [SERVER], { env: { ...process.env, PORT: String(PORT) }, stdio: ["ignore", "pipe", "pipe"] });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("simulator didn't start")), 10000);
      proc.stdout.on("data", (chunk) => {
        if (String(chunk).includes("Listening")) {
          clearTimeout(timer);
          resolve();
        }
      });
      proc.on("exit", (code) => reject(new Error(`simulator exited (${code})`)));
    });
  });
  after(() => proc?.kill());
  beforeEach(() => postJson("/api/sim/reset", {}));

  it("reports ready by default", async () => {
    const reply = await (await fetch(`${BASE}/api/config-ready`)).json();
    assert.deepEqual(reply, { ok: true, ready: true, reason: "ready", message: "" });
  });

  it("refuses a bundle with 503 and the hub's message until ready", async () => {
    await postJson("/api/sim/config-ready", { ready: false, reason: "blank-hub-check", message: "Preparing the store." });
    const ready = await (await fetch(`${BASE}/api/config-ready`)).json();
    assert.equal(ready.ready, false);
    assert.equal(ready.reason, "blank-hub-check");
    const refused = await postForm("/import", { target: "bundle", payload: bundle() });
    assert.equal(refused.status, 503);
    assert.equal(msgOf(await refused.text()), "Preparing the store.");
    await postJson("/api/sim/config-ready", { ready: true });
    const accepted = await postForm("/import", { target: "bundle", payload: bundle() });
    assert.equal(accepted.status, 200);
  });

  it("checks the payload first, like the hub, and rejects unknown targets", async () => {
    await postJson("/api/sim/config-ready", { ready: false, message: "Preparing the store." });
    const bad = await postForm("/import", { target: "devices", payload: "not json" });
    assert.equal(bad.status, 200);
    assert.notEqual(msgOf(await bad.text()), "Preparing the store.");
    const unknown = await postForm("/import", { target: "nope", payload: "{}" });
    assert.equal(msgOf(await unknown.text()), "Unknown import target.");
  });

  it("restores anyway with force=1 and says the hub wasn't ready", async () => {
    await postJson("/api/sim/config-ready", { ready: false });
    const forced = await postForm("/import", { target: "devices", payload: '{"DevicesWithFeatures":[]}', force: "1" });
    assert.equal(forced.status, 200);
    assert.match(msgOf(await forced.text()), /not ready yet/);
  });

  it("lets settings restores through while not ready, like the hub", async () => {
    await postJson("/api/sim/config-ready", { ready: false });
    const wifi = await postForm("/import", { target: "wifi", payload: "network={}" });
    assert.equal(wifi.status, 200);
  });

  it("resets to ready", async () => {
    await postJson("/api/sim/config-ready", { ready: false });
    await postJson("/api/sim/reset", {});
    assert.equal((await (await fetch(`${BASE}/api/config-ready`)).json()).ready, true);
  });
});

/* codex_webui.c itself, compiled for this machine with the readiness report,
   /proc/uptime and every file an import writes moved into a temp dir. One
   request per run; nothing is written outside the temp dir. */
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const haveCc = spawnSync("cc", ["--version"]).status === 0;

describe("codex_webui import readiness (native)", { skip: !haveCc && "no C compiler" }, () => {
  let dir;
  let bin;
  const at = (name) => path.join(dir, name);
  const readyFile = () => at("ready.json");
  const read = (name) => (fs.existsSync(at(name)) ? fs.readFileSync(at(name), "utf8").trim() : null);
  const setUptime = (seconds) => fs.writeFileSync(at("uptime"), `${seconds}.00 1.00\n`);
  const report = (fields) => fs.writeFileSync(readyFile(), JSON.stringify(fields));
  const requestLine = (method, target, body, type) => `${method}\t${target}\t${type}\t${body}\n`;
  const parse = (raw) => ({
    status: Number(/^HTTP\/1\.1 (\d+)/.exec(raw)?.[1]),
    text: raw.slice(raw.indexOf("\r\n\r\n") + 4).trim(),
  });
  const run = (method, target, body = "", type = "application/x-www-form-urlencoded") =>
    parse(execFileSync(bin, [], { input: requestLine(method, target, body, type), encoding: "utf8" }));
  // For a request that waits: the test changes the report while it runs.
  const runAsync = (method, target, body = "", type = "application/x-www-form-urlencoded") =>
    new Promise((resolve, reject) => {
      const child = spawn(bin, [], { stdio: ["pipe", "pipe", "ignore"] });
      let out = "";
      child.stdout.on("data", (chunk) => { out += chunk; });
      child.on("error", reject);
      child.on("close", () => resolve(parse(out)));
      child.stdin.end(requestLine(method, target, body, type));
    });
  const form = (target, payload, extra = {}) => new URLSearchParams({ target, payload, ...extra }).toString();
  const RESOURCE_FILES = ["DeviceList.json", "FunctionList.json", "ProtocolList.json", "ActivityList.json",
    "MapList.json", "AutomationConfig.json"];
  const PATHS = {
    CONFIG_READY_FILE: "ready.json", CONFIG_READY_UPTIME_FILE: "uptime", RESOURCE_BACKUP_DIR: "backups",
    MQTT_CONFIG: "mqtt.json", WPA_CONFIG: "wpa_supplicant.conf", CLOUD_BLOCKER_CONFIG: "cloud_blocker.conf",
    DEVICE_LIST: "DeviceList.json", FUNCTION_LIST: "FunctionList.json", PROTOCOL_LIST: "ProtocolList.json",
    ACTIVITY_LIST: "ActivityList.json", MAP_LIST: "MapList.json", AUTOMATION_CONFIG: "AutomationConfig.json",
    RESOURCE_RELOAD_FLAG: "reload_resources", HOSTS_FILE: "hosts", OFFLINE_EGRESS_GUARD: "egress_guard.sh",
    HUB_ID_FILE: "hub_id", BT_DEVICE_STORE: "bt-devices.json",
    ACTIVITY_RESTRICTIONS: "restrictions.json", ACTIVITY_RESTRICTIONS_LOCK: "restrictions.lock",
  };

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "import-ready-"));
    bin = at("harness");
    const source = at("harness.c");
    const defines = Object.entries(PATHS).map(([name, file]) => `#define ${name} "${at(file)}"`).join("\n");
    fs.writeFileSync(source, `
${defines}
#define CONFIG_READY_MODE_WAIT_S 1
#define CODEX_WEBUI_NO_MAIN 1
#include "codex_webui.c"

int main(void) {
    static char line[65536], req[70000];
    int sv[2];
    char resp[65536];
    ssize_t got;
    size_t n = 0;
    pid_t pid;
    char *method, *target, *type, *body;
    if (!fgets(line, sizeof(line), stdin)) return 2;
    method = strtok(line, "\\t"); target = strtok(NULL, "\\t"); type = strtok(NULL, "\\t"); body = strtok(NULL, "\\n");
    if (!body) body = "";
    snprintf(req, sizeof(req), "%s %s HTTP/1.1\\r\\nHost: hub.local\\r\\nContent-Type: %s\\r\\nContent-Length: %lu\\r\\n\\r\\n%s",
        method, target, type, (unsigned long)strlen(body), body);
    if (socketpair(AF_UNIX, SOCK_STREAM, 0, sv) != 0) return 2;
    pid = fork();
    if (pid == 0) { close(sv[1]); handle_client(sv[0]); close(sv[0]); _exit(0); }
    close(sv[0]);
    send_all(sv[1], req, strlen(req));
    shutdown(sv[1], SHUT_WR);
    while ((got = read(sv[1], resp + n, sizeof(resp) - 1 - n)) > 0) n += (size_t)got;
    resp[n] = 0;
    waitpid(pid, NULL, 0);
    fputs(resp, stdout);
    return 0;
}
`);
    execFileSync("cc", ["-std=gnu99", "-O0", "-w", "-I", path.join(ROOT, "payload/source"), "-o", bin, source], { stdio: "pipe" });
  });
  after(() => dir && fs.rmSync(dir, { recursive: true, force: true }));
  // Every test starts from a hub with nothing restored yet.
  beforeEach(() => {
    for (const file of [...RESOURCE_FILES, "backups", "wpa_supplicant.conf", "mqtt.json", "cloud_blocker.conf",
      "reload_resources", "hosts", "ready.json"]) {
      fs.rmSync(at(file), { recursive: true, force: true });
    }
  });

  const BUNDLE = (extra = {}) => JSON.stringify({ format: "harmony-owner-bundle-v2", files: {
    "DeviceList.json": '{"DevicesWithFeatures":[]}', "FunctionList.json": '{"FunctionMaps":[]}',
    "ProtocolList.json": '{"Protocols":[]}', "ActivityList.json": '{"Activities":[]}',
    "MapList.json": '{"ButtonMaps":[]}', "AutomationConfig.json": "{}",
    "mqtt-config.json": '{"broker":{},"baseTopic":"harmony"}',
    "wpa_supplicant.conf": 'network={\n ssid="x"\n}', ...extra } });

  it("reports starting before the plugin's first report, and refuses a bundle with 503", () => {
    setUptime(40);
    const ready = JSON.parse(run("GET", "/api/config-ready", "", "-").text);
    assert.deepEqual([ready.ready, ready.reason], [false, "starting"]);
    const refused = run("POST", "/import", form("bundle", BUNDLE()));
    assert.equal(refused.status, 503);
    assert.match(refused.text, /still starting up/);
    assert.equal(fs.existsSync(at("backups")), false, "nothing was backed up");
    assert.equal(read("DeviceList.json"), null, "nothing was written");
  });

  it("checks the payload before readiness, so a malformed file gets its own error", () => {
    setUptime(40);
    const bad = run("POST", "/import", form("automation", "not json"));
    assert.notEqual(bad.status, 503);
    assert.doesNotMatch(bad.text, /still starting up/);
  });

  it("names the reason the plugin reports, and a stale or missing report", () => {
    setUptime(900);
    report({ ready: false, reason: "blank-hub-check", uptime: 899 });
    let reply = JSON.parse(run("GET", "/api/config-ready", "", "-").text);
    assert.deepEqual([reply.ready, reply.reason], [false, "blank-hub-check"]);
    const refused = run("POST", "/import", form("devices", '{"DevicesWithFeatures":[]}'));
    assert.equal(refused.status, 503);
    assert.match(refused.text, /preparing its configuration store/);
    assert.equal(fs.existsSync(at("backups")), false, "a refused list is not backed up either");
    report({ ready: false, reason: "store-setup-failed", uptime: 899 });
    reply = JSON.parse(run("GET", "/api/config-ready", "", "-").text);
    assert.equal(reply.reason, "store-setup-failed");
    assert.match(reply.message, /could not prepare its configuration store/);
    report({ ready: true, reason: "ready", uptime: 600 });
    reply = JSON.parse(run("GET", "/api/config-ready", "", "-").text);
    assert.deepEqual([reply.ready, reply.reason], [false, "plugin-not-responding"]);
    fs.rmSync(readyFile(), { force: true });
    reply = JSON.parse(run("GET", "/api/config-ready", "", "-").text);
    assert.deepEqual([reply.ready, reply.reason], [false, "plugin-not-running"]);
  });

  it("is ready when the plugin's report is fresh, in any key order", () => {
    setUptime(900);
    // The hub's JSON encoder orders keys freely: this is what it wrote on
    // hardware, with "ready" appearing first as the value of "reason".
    for (const text of ['{"ready":true,"reason":"ready","uptime":898}', '{"reason":"ready","uptime":898,"ready":true}']) {
      fs.writeFileSync(readyFile(), text);
      const reply = JSON.parse(run("GET", "/api/config-ready", "", "-").text);
      assert.deepEqual(reply, { ok: true, ready: true, reason: "ready", message: "" }, text);
    }
    fs.writeFileSync(readyFile(), '{"reason":"ready","ready":false,"uptime":898}');
    const reply = JSON.parse(run("GET", "/api/config-ready", "", "-").text);
    assert.deepEqual([reply.ready, reply.reason], [false, "starting"], "never ready:false with reason ready");
  });

  it("lets settings restores through while not ready", () => {
    setUptime(40);
    const wifi = run("POST", "/import", form("wifi", 'network={\n ssid="x"\n}'));
    assert.equal(wifi.status, 200);
    assert.match(read("wpa_supplicant.conf"), /ssid="x"/);
  });

  it("restores a list anyway with force=1, and says the hub wasn't ready", () => {
    setUptime(900);
    report({ ready: false, reason: "engine-starting", uptime: 899 });
    const forced = run("POST", "/import", form("devices", '{"DevicesWithFeatures":[]}', { force: "1" }));
    assert.equal(forced.status, 200);
    assert.match(forced.text, /requested a Harmony resource reload\. The hub was not ready yet/);
    assert.equal(read("DeviceList.json"), '{"DevicesWithFeatures":[]}');
    assert.notEqual(read("reload_resources"), null);
    const notForce = run("POST", "/import", form("devices", '{"DevicesWithFeatures":[]}', { force: "0" }));
    assert.equal(notForce.status, 503, "only force=1 counts");
  });

  it("restores a bundle anyway with force=1", () => {
    setUptime(900);
    report({ ready: false, reason: "reload-pending", uptime: 899, localMode: true });
    const forced = run("POST", "/import", form("bundle", BUNDLE(), { force: "1" }));
    assert.equal(forced.status, 200);
    assert.match(forced.text, /Backup bundle imported\..*The hub was not ready yet/);
    assert.equal(read("FunctionList.json"), '{"FunctionMaps":[]}');
  });

  it("turns cloud blocking on before a bundle's resources, and waits for the blank-hub check", () => {
    setUptime(900);
    fs.writeFileSync(at("cloud_blocker.conf"), "0");
    report({ ready: true, reason: "ready", uptime: 899, localMode: false });
    const refused = run("POST", "/import", form("bundle", BUNDLE({ "cloud-blocker.conf": "1" })));
    assert.equal(refused.status, 503);
    assert.match(refused.text, /Cloud blocking is now on.*Nothing else was restored/);
    assert.equal(read("cloud_blocker.conf"), "1");
    assert.equal(read("DeviceList.json"), null, "no resource lands before the check");
    assert.equal(fs.existsSync(at("backups")), false);
  });

  it("restores the bundle once the plugin reports local mode and ready", async () => {
    setUptime(900);
    fs.writeFileSync(at("cloud_blocker.conf"), "0");
    report({ ready: true, reason: "ready", uptime: 899, localMode: false });
    const pending = runAsync("POST", "/import", form("bundle", BUNDLE({ "cloud-blocker.conf": "1" })));
    setTimeout(() => report({ ready: false, reason: "reload-pending", uptime: 899, localMode: true }), 200);
    setTimeout(() => report({ ready: true, reason: "ready", uptime: 899, localMode: true }), 500);
    const done = await pending;
    assert.equal(done.status, 200);
    assert.match(done.text, /Backup bundle imported\./);
    assert.doesNotMatch(done.text, /not ready yet/);
    assert.equal(read("cloud_blocker.conf"), "1");
    assert.equal(read("DeviceList.json"), '{"DevicesWithFeatures":[]}');
  });

  it("doesn't wait when the hub is already in local mode", () => {
    setUptime(900);
    fs.writeFileSync(at("cloud_blocker.conf"), "1");
    report({ ready: true, reason: "ready", uptime: 899, localMode: true });
    const started = Date.now();
    const done = run("POST", "/import", form("bundle", BUNDLE({ "cloud-blocker.conf": "1" })));
    assert.equal(done.status, 200);
    assert.ok(Date.now() - started < 900, "no wait");
  });
});
