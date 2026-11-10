// /api/activity-restrictions: codex_webui.c (compiled for this machine, the
// files moved to a temp folder) and the simulator answer the same way, and
// the hub file is always written in the one shape netservicestarter.lua reads.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const SERVER = path.join(ROOT, "tools/webui-sim/server.mjs");

const SAT_SUN = { days: ["sun", "sat"], start: "06:00", end: "09:00" };
const SAT_SUN_FILE = { days: ["sat", "sun"], start: "06:00", end: "09:00" };

/* Runs codex_webui's request handler on raw HTTP requests, one per line of
   stdin ("METHOD<TAB>path<TAB>Content-Type<TAB>Origin<TAB>body"), and prints
   each response followed by the restrictions file ("<none>" when there is
   none). Automatic backups go to <dir>/backups. Engine calls run
   <dir>/codex_hbus, which prints <dir>/engine-reply.json. */
function buildHarness(dir) {
  const file = path.join(dir, "activity-restrictions.json");
  const source = path.join(dir, "harness.c");
  const bin = path.join(dir, "harness");
  const engineReply = path.join(dir, "engine-reply.json");
  fs.writeFileSync(path.join(dir, "hub_id"), "12345678\n");
  fs.writeFileSync(path.join(dir, "codex_hbus"), `#!/bin/sh\ncat '${engineReply}'\n`, { mode: 0o755 });
  fs.writeFileSync(source, `
#define ACTIVITY_RESTRICTIONS "${file}"
#define ACTIVITY_RESTRICTIONS_LOCK "${path.join(dir, "lock")}"
#define RESOURCE_BACKUP_DIR "${path.join(dir, "backups")}"
#define HUB_ID_FILE "${path.join(dir, "hub_id")}"
#define CODEX_HBUS_BIN "${path.join(dir, "codex_hbus")}"
#define CODEX_WEBUI_NO_MAIN 1
#include "codex_webui.c"

int main(void) {
    static char line[262144], req[270000];
    while (fgets(line, sizeof(line), stdin)) {
        char *method = strtok(line, "\\t"), *target = strtok(NULL, "\\t"), *type = strtok(NULL, "\\t"), *origin = strtok(NULL, "\\t"), *body = strtok(NULL, "\\n");
        int sv[2];
        size_t n = 0, cap = 1 << 16;
        ssize_t got;
        pid_t pid;
        char *data, *resp = malloc(cap);
        if (!body) body = "";
        snprintf(req, sizeof(req), "%s %s HTTP/1.1\\r\\nHost: hub.local\\r\\n%s%s%s%s%s%sContent-Length: %lu\\r\\n\\r\\n%s",
            method, target, strcmp(type, "-") ? "Content-Type: " : "", strcmp(type, "-") ? type : "", strcmp(type, "-") ? "\\r\\n" : "",
            strcmp(origin, "-") ? "Origin: " : "", strcmp(origin, "-") ? origin : "", strcmp(origin, "-") ? "\\r\\n" : "",
            (unsigned long)strlen(body), body);
        if (socketpair(AF_UNIX, SOCK_STREAM, 0, sv) != 0) return 2;
        /* The handler runs in a child (as on the hub), so a reply bigger
           than the socket buffer doesn't block it. */
        fflush(stdout);
        pid = fork();
        if (pid == 0) {
            close(sv[1]);
            handle_client(sv[0]);
            close(sv[0]);
            _exit(0);
        }
        close(sv[0]);
        send_all(sv[1], req, strlen(req));
        shutdown(sv[1], SHUT_WR);
        while ((got = read(sv[1], resp + n, cap - 1 - n)) > 0) {
            n += (size_t)got;
            if (cap - 1 - n == 0) resp = realloc(resp, cap *= 2);
        }
        resp[n] = 0;
        close(sv[1]);
        waitpid(pid, NULL, 0);
        printf("%s\\n---FILE---\\n", resp);
        free(resp);
        data = read_file_alloc(ACTIVITY_RESTRICTIONS, 1 << 20, NULL);
        printf("%s\\n===END===\\n", data ? data : "<none>");
        free(data);
    }
    return 0;
}
`);
  execFileSync("cc", ["-std=gnu99", "-O0", "-w", "-I", path.join(ROOT, "payload/source"), "-o", bin, source], { stdio: "pipe" });
  return { bin, file, engineReply };
}

/* Each request is [method, type, origin, body, path]; the path defaults to
   the API route, an object body is sent as JSON and a string as it is. */
function runHarness(bin, requests) {
  const input = requests.map(([method, type, origin, body, target = "/api/activity-restrictions"]) =>
    `${method}\t${target}\t${type ?? "-"}\t${origin ?? "-"}\t${body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body)}\n`).join("");
  const out = execFileSync(bin, [], { input, encoding: "utf8" });
  return out.split("===END===\n").filter(Boolean).map((chunk) => {
    const [response, file] = chunk.split("\n---FILE---\n");
    const status = Number(/^HTTP\/1\.1 (\d+)/.exec(response)?.[1]);
    const text = response.slice(response.indexOf("\r\n\r\n") + 4).trim();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text; // an HTML page (the /import form)
    }
    return { status, headers: response.slice(0, response.indexOf("\r\n\r\n")), body, file: file.trim() };
  });
}

const importForm = (target, payload) => new URLSearchParams({ target, payload }).toString();
const FORM_TYPE = "application/x-www-form-urlencoded";

const haveCc = spawnSync("cc", ["--version"]).status === 0;

describe("codex_webui /api/activity-restrictions", { skip: !haveCc && "no C compiler" }, () => {
  let dir;
  let harness;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-restrictions-test-"));
    harness = buildHarness(dir);
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const JSON_TYPE = "application/json";

  it("saves, lists and lifts restrictions in the file's one shape", () => {
    const [empty, first, second, lifted, last] = runHarness(harness.bin, [
      ["GET"],
      ["POST", JSON_TYPE, "http://hub.local", { activityId: "100", windows: [SAT_SUN] }],
      ["POST", JSON_TYPE, null, { activityId: "200", windows: [{ days: ["fri"], start: "22:00", end: "02:00" }, { days: ["mon"], start: "20:00", end: "24:00" }] }],
      ["POST", JSON_TYPE, null, { activityId: "100", windows: [] }],
      ["POST", JSON_TYPE, null, { activityId: "200", windows: [] }],
    ]);
    assert.deepEqual([empty.status, empty.body, empty.file], [200, { ok: true, activities: {} }, "<none>"]);
    assert.equal(first.status, 200);
    assert.deepEqual(first.body, { ok: true, activities: { 100: [SAT_SUN_FILE] } });
    assert.equal(first.file, '{"version":1,"activities":{"100":[{"days":["sat","sun"],"start":"06:00","end":"09:00"}]}}');
    assert.deepEqual(Object.keys(second.body.activities), ["100", "200"]);
    assert.deepEqual(JSON.parse(second.file).activities["200"][1], { days: ["mon"], start: "20:00", end: "24:00" });
    assert.deepEqual(lifted.body.activities, { 200: JSON.parse(second.file).activities["200"] });
    assert.deepEqual([last.body.activities, last.file], [{}, "<none>"], "no restrictions left: no file");
  });

  it("refuses bad saves and leaves the file alone", () => {
    const tooMany = Array.from({ length: 9 }, () => SAT_SUN);
    const results = runHarness(harness.bin, [
      ["POST", JSON_TYPE, null, { activityId: "100", windows: [SAT_SUN] }],
      ["POST", JSON_TYPE, null, { activityId: "100", windows: [{ days: [], start: "06:00", end: "09:00" }] }],
      ["POST", JSON_TYPE, null, { activityId: "100", windows: [{ days: ["Sat"], start: "06:00", end: "09:00" }] }],
      ["POST", JSON_TYPE, null, { activityId: "100", windows: [{ days: ["sat"], start: "6:00", end: "09:00" }] }],
      ["POST", JSON_TYPE, null, { activityId: "100", windows: [{ days: ["sat"], start: "24:00", end: "09:00" }] }],
      ["POST", JSON_TYPE, null, { activityId: "100", windows: [{ days: ["sat"], start: "07:00", end: "07:00" }] }],
      ["POST", JSON_TYPE, null, { activityId: "100", windows: tooMany }],
      ["POST", JSON_TYPE, null, { activityId: "-1", windows: [SAT_SUN] }],
      ["POST", JSON_TYPE, null, { activityId: 100, windows: [SAT_SUN] }],
      ["POST", JSON_TYPE, null, { activityId: "100" }],
      ["POST", "text/plain", null, { activityId: "100", windows: [] }],
      ["POST", JSON_TYPE, "http://evil.example", { activityId: "100", windows: [] }],
    ]);
    const kept = results[0].file;
    assert.equal(results[0].status, 200);
    const expected = [
      [400, "Pick at least one day for time 1."],
      [400, "Time 1 has a day that isn't mon, tue, wed, thu, fri, sat or sun."],
      [400, "Time 1 needs a start and an end, as HH:MM."],
      [400, "Time 1 needs a start and an end, as HH:MM."],
      [400, "Time 1 starts and ends at the same time."],
      [400, "An activity can have up to 8 times."],
      [400, "Give the activity's id."],
      [400, "Give the activity's id."],
      [400, "Send the activity's times as a list."],
      [403, "This change takes a JSON request (Content-Type: application/json) from the hub's own web app."],
      [403, "This change takes a JSON request (Content-Type: application/json) from the hub's own web app."],
    ];
    results.slice(1).forEach((r, i) => {
      assert.deepEqual([r.status, r.body.error], expected[i], `request ${i + 2}`);
      assert.equal(r.file, kept, `request ${i + 2} left the file alone`);
    });
  });

  it("skips what it can't read in a hand-edited file", () => {
    fs.writeFileSync(harness.file, JSON.stringify({
      activities: {
        100: [SAT_SUN],
        abc: [SAT_SUN],
        200: [{ days: ["sat"], start: "25:00", end: "09:00" }],
        300: "nope",
      },
    }));
    const [listed] = runHarness(harness.bin, [["GET"]]);
    assert.deepEqual(listed.body, { ok: true, activities: { 100: [SAT_SUN_FILE] } });
    fs.writeFileSync(harness.file, "not json");
    const [broken] = runHarness(harness.bin, [["GET"]]);
    assert.deepEqual(broken.body, { ok: true, activities: {} });
    fs.rmSync(harness.file);
  });

  it("exports the restrictions on their own and in the bundle, always in full", () => {
    const [none, , saved, bundle] = runHarness(harness.bin, [
      ["GET", null, null, undefined, "/export/restrictions"],
      ["POST", JSON_TYPE, null, { activityId: "100", windows: [SAT_SUN] }],
      ["GET", null, null, undefined, "/export/restrictions"],
      ["GET", null, null, undefined, "/export/bundle"],
    ]);
    assert.deepEqual(none.body, { version: 1, activities: {} });
    assert.match(none.headers, /filename="activity-restrictions\.json"/);
    assert.deepEqual(saved.body, { version: 1, activities: { 100: [SAT_SUN_FILE] } });
    assert.equal(bundle.body.format, "harmony-owner-bundle-v2");
    assert.deepEqual(JSON.parse(bundle.body.files["activity-restrictions.json"]), saved.body);
    runHarness(harness.bin, [["POST", JSON_TYPE, null, { activityId: "100", windows: [] }]]);
  });

  it("imports a restrictions file all or nothing, rewritten and backed up first", () => {
    const backups = path.join(dir, "backups");
    const [first, imported] = runHarness(harness.bin, [
      ["POST", JSON_TYPE, null, { activityId: "100", windows: [SAT_SUN] }],
      ["POST", FORM_TYPE, null, importForm("restrictions", JSON.stringify({ activities: { 200: [{ days: ["fri", "mon"], start: "22:00", end: "02:00" }], 300: [] } }, null, 2)), "/import"],
    ]);
    assert.equal(first.status, 200);
    assert.match(imported.body, /Time restrictions imported/);
    assert.equal(imported.file, '{"version":1,"activities":{"200":[{"days":["mon","fri"],"start":"22:00","end":"02:00"}]}}');
    // The settings backup taken before the import holds the file it replaced
    // (checked now: backups are named by the second, so a later one would share it).
    const saves = fs.readdirSync(backups).filter((d) => d.startsWith("settings_"));
    assert.ok(saves.some((d) => fs.readFileSync(path.join(backups, d, "activity-restrictions.json"), "utf8").includes('"100"')));
    const [bad, cleared] = runHarness(harness.bin, [
      ["POST", FORM_TYPE, null, importForm("restrictions", JSON.stringify({ activities: { 200: [SAT_SUN], 400: [{ days: [], start: "06:00", end: "09:00" }] } })), "/import"],
      ["POST", FORM_TYPE, null, importForm("restrictions", JSON.stringify({ version: 1, activities: {} })), "/import"],
    ]);
    assert.match(bad.body, /Activity 400: Pick at least one day for time 1\./);
    assert.equal(bad.file, imported.file, "a bad import changes nothing");
    assert.match(cleared.body, /Time restrictions imported/);
    assert.equal(cleared.file, "<none>", "an empty import lifts every restriction");
  });

  it("answers a start the engine refused for time restrictions with 409 restricted", () => {
    const run = (reply) => {
      fs.writeFileSync(harness.engineReply, reply);
      return runHarness(harness.bin, [["POST", FORM_TYPE, null, "activityId=100", "/api/activity-run"]])[0];
    };
    for (const code of ['"568"', "568"]) {
      const refused = run(`{"cmd":"harmony.engine?startActivity","code":${code},"id":"codex-1","msg":"Activity is restricted at this time: Play a game","data":"activityId=-1"}`);
      assert.equal(refused.status, 409, `code ${code}`);
      assert.equal(refused.body.ok, false);
      assert.equal(refused.body.restricted, true);
      assert.equal(refused.body.error, "This activity can't be started now: it has time restrictions.");
      assert.equal(refused.body.activityId, "100");
      assert.match(refused.body.reply, /restricted at this time/);
    }
    const started = run('{"cmd":"harmony.engine?startActivity","code":200,"id":"codex-1","msg":"OK","data":"done=1:total=3"}');
    assert.deepEqual([started.status, started.body.ok, started.body.restricted], [200, true, undefined]);
    // A 568 nested inside data is not the engine's answer code.
    const nested = run('{"cmd":"harmony.engine?startActivity","code":200,"id":"codex-1","data":{"code":"568"}}');
    assert.equal(nested.status, 200);
  });

  it("checks a bundle's restrictions before writing anything", () => {
    const bundle = JSON.stringify({
      format: "harmony-owner-bundle-v2",
      files: {
        "DeviceList.json": '{"DevicesWithFeatures":[]}',
        "FunctionList.json": '{"FunctionMaps":[]}',
        "ProtocolList.json": '{"Protocols":[]}',
        "ActivityList.json": '{"Activities":[]}',
        "MapList.json": '{"ButtonMaps":[]}',
        "AutomationConfig.json": "{}",
        "mqtt-config.json": '{"broker":{},"baseTopic":"harmony"}',
        "wpa_supplicant.conf": 'network={\n ssid="x"\n}',
        "activity-restrictions.json": JSON.stringify({ version: 1, activities: { 100: [{ days: ["sat"], start: "07:00", end: "07:00" }] } }),
      },
    });
    const [refused] = runHarness(harness.bin, [["POST", FORM_TYPE, null, importForm("bundle", bundle), "/import"]]);
    assert.match(refused.body, /Activity 100: Time 1 starts and ends at the same time\./);
    assert.equal(refused.file, "<none>");
  });
});

describe("simulator /api/activity-restrictions", () => {
  // A range of its own: the other simulator tests use 18700-18899 and 18900-18989.
  const PORT = 19000 + Math.floor(Math.random() * 90);
  const BASE = `http://127.0.0.1:${PORT}`;
  let proc;
  const post = (body, headers = {}) => fetch(`${BASE}/api/activity-restrictions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

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

  it("answers like the hub", async () => {
    assert.deepEqual(await (await fetch(`${BASE}/api/activity-restrictions`)).json(), { ok: true, activities: {} });
    let res = await post({ activityId: "100", windows: [SAT_SUN] });
    assert.deepEqual([res.status, await res.json()], [200, { ok: true, activities: { 100: [SAT_SUN_FILE] } }]);
    assert.deepEqual(await (await fetch(`${BASE}/export/restrictions`)).json(), { version: 1, activities: { 100: [SAT_SUN_FILE] } });
    res = await post({ activityId: "100", windows: [{ days: [], start: "06:00", end: "09:00" }] });
    assert.deepEqual([res.status, (await res.json()).error], [400, "Pick at least one day for time 1."]);
    res = await post({ activityId: "-1", windows: [] });
    assert.equal(res.status, 400);
    res = await post({ activityId: "100", windows: [] }, { Origin: "http://evil.example" });
    assert.equal(res.status, 403);
    res = await post({ activityId: "100", windows: [] });
    assert.deepEqual(await res.json(), { ok: true, activities: {} });
  });

  it("refuses a start inside a restriction, like the hub, but never the running activity", async () => {
    const config = await (await fetch(`${BASE}/api/activity-config`)).json();
    const [first, second] = config.activityList.Activities.map((a) => String(a["Id-"]));
    const run = (id) => fetch(`${BASE}/api/activity-run`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `activityId=${id}`,
    });
    const allDay = [{ days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"], start: "00:00", end: "24:00" }];
    assert.equal((await run(first)).status, 200);
    await post({ activityId: first, windows: allDay });
    await post({ activityId: second, windows: allDay });
    assert.equal((await run(first)).status, 200, "pressing the running activity again still works");
    const refused = await run(second);
    assert.equal(refused.status, 409);
    assert.deepEqual(Object.fromEntries(Object.entries(await refused.json()).filter(([k]) => ["ok", "restricted"].includes(k))),
      { ok: false, restricted: true });
    assert.equal((await run("-1")).status, 200, "PowerOff is never refused");
    await post({ activityId: first, windows: [] });
    await post({ activityId: second, windows: [] });
    assert.equal((await run(second)).status, 200);
    await run("-1");
  });
});
