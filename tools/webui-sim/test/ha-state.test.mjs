import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import {
  describeHaDeviceState,
  describeTheaterLink,
  fixItDevices,
  haDeviceKey,
  isHaCommandRedundant,
  isHaDevice,
  theaterPortLabel,
} from "../public/js/views/remote-model.js";
import { haStateStripMarkup } from "../public/js/views/remote-pad.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function makeHaDevice({
  id = "90000001",
  name = "Living Room TV",
  key = "media_player.living_room_tv",
  commands = ["PowerOn", "PowerOff", "Input HDMI 1", "Input HDMI 4", "Play", "Pause", "VolumeUp", "Mute"],
} = {}) {
  const entry = {
    Device: {
      "Id-": Number(id),
      Name: name,
      Manufacturer: "Home Assistant",
      Model: "Home Assistant device",
      Transport: 64,
      AutoDetectedDevice: { Id: `melodious-ha-${id}` },
      Tokens: { Parameters: [{ Key: "{d}", Value: key }] },
    },
    Commands: commands.map((c, i) => ({
      "Id-": 99000 + i,
      Name: c,
      TransportType: 64,
      Parameters: [{ Key: "{c}", Value: `${key}:${c}` }],
    })),
    DeviceFeatures: [
      {
        __type: "PowerFeature",
        PowerOnActions: [{ __type: "PowerAction", IRCommandName: "PowerOn" }],
        PowerOffActions: [{ __type: "PowerAction", IRCommandName: "PowerOff" }],
      },
      {
        __type: "InputFeature",
        Inputs: [
          { InputName: "HDMI 1", Actions: [{ IRCommandName: "Input HDMI 1" }] },
          { InputName: "HDMI 4", Actions: [{ IRCommandName: "Input HDMI 4" }] },
        ],
      },
    ],
  };
  return {
    id: String(id),
    name,
    manufacturer: "Home Assistant",
    model: "Home Assistant device",
    transport: 64,
    isBluetooth: false,
    isHa: true,
    haKey: key,
    entry,
    commands: entry.Commands.map((c) => ({ name: c.Name, functionId: null })),
  };
}

describe("describeHaDeviceState", () => {
  const tv = makeHaDevice();

  it("extracts the {d} token as haDeviceKey", () => {
    assert.equal(haDeviceKey(tv.entry), "media_player.living_room_tv");
    assert.equal(isHaDevice(tv), true);
  });

  it("returns null for non-HA devices", () => {
    const ir = { id: "1", name: "Amp", transport: 1, isHa: false, entry: { Device: { Transport: 1 } } };
    assert.equal(describeHaDeviceState(ir, { version: 1, stale: false, states: [] }), null);
  });

  it("renders State unknown (never Off) when haState is missing, stale, or unavailable", () => {
    for (const env of [
      null,
      { version: 0, stale: true, states: [] },
      {
        version: 3,
        stale: true,
        states: [{ key: "media_player.living_room_tv", available: true, power: "on", source: "HDMI 1" }],
      },
      {
        version: 4,
        stale: false,
        states: [{ key: "media_player.living_room_tv", available: false, power: "off" }],
      },
      {
        version: 5,
        stale: false,
        states: [{ key: "media_player.living_room_tv", available: true, power: "unknown" }],
      },
    ]) {
      const info = describeHaDeviceState(tv, env);
      assert.equal(info.known, false);
      assert.equal(info.power, "unknown");
      assert.equal(info.badge, "State unknown");
      assert.deepEqual(info.chips, [{ kind: "unknown", label: "State unknown" }]);
      assert.ok(!info.summary.toLowerCase().includes("off"));
    }
  });

  it("formats power, source, app, playing, volume and mute when fresh", () => {
    const info = describeHaDeviceState(tv, {
      version: 10,
      stale: false,
      states: [
        {
          key: "media_player.living_room_tv",
          available: true,
          power: "on",
          source: "HDMI 1",
          activity: "Netflix",
          playing: "playing",
          volume: 0.35,
          muted: false,
        },
      ],
    });
    assert.equal(info.known, true);
    assert.equal(info.power, "on");
    assert.equal(info.source, "HDMI 1");
    assert.equal(info.activity, "Netflix");
    assert.equal(info.playing, "playing");
    assert.equal(info.volume, 35);
    assert.equal(info.muted, false);
    assert.deepEqual(
      info.chips.map((c) => c.label),
      ["On", "HDMI 1", "Netflix", "Playing", "Vol 35%"],
    );
  });

  it("avoids repeating app when it matches source, and shows Muted when muted", () => {
    const info = describeHaDeviceState(tv, {
      version: 11,
      stale: false,
      states: [
        {
          key: "media_player.living_room_tv",
          available: true,
          power: "on",
          source: "YouTube",
          activity: "YouTube",
          playing: "paused",
          volume: 0.2,
          muted: true,
        },
      ],
    });
    assert.deepEqual(
      info.chips.map((c) => c.label),
      ["On", "YouTube", "Paused", "Muted (20%)"],
    );
  });
});


const THEATER = {
  active_input: { id: "HDMI_1", label: "Living Room TV" },
  ports: [
    { id: "HDMI_1", label: "Living Room TV", connected: true, signal: true, cec_name: "Living Room TV", cec_type: 8, cec_vendor: 1877008 },
    { id: "HDMI_2", label: "Nakamichi Sound Bar", connected: true, signal: false, cec_name: "NAKAMICHI", cec_type: 5, cec_vendor: 9681 },
    { id: "HDMI_3", label: "Switch2 Game Console", connected: false, signal: false, cec_name: null, cec_type: null, cec_vendor: null },
    { id: "HDMI_4", label: "HDMI 4", connected: false, signal: false, cec_name: null, cec_type: null, cec_vendor: null },
  ],
  sound: { output: "external_arc", label: "Nakamichi Sound Bar", port: "HDMI_2", volume: 14, muted: false, external_control: true },
  foreground_app: "com.webos.app.hdmi1",
};
const theaterEnv = (extra = {}) => ({
  version: 20, stale: false,
  states: [{ key: "media_player.living_room_tv", available: true, power: "on",
    source: "Living Room TV", volume: 0.14, muted: false, theater: THEATER, ...extra }],
});

describe("LG theater state", () => {
  const tv = makeHaDevice();

  it("shows the live port, connected ports and TV-reported ARC volume (not %)", () => {
    const info = describeHaDeviceState(tv, theaterEnv());
    assert.equal(info.activeInputId, "HDMI 1");
    assert.equal(theaterPortLabel("HDMI_2"), "HDMI 2");
    const labels = info.chips.map((c) => c.label);
    assert.ok(labels.includes("Sound: Nakamichi Sound Bar (ARC) \u00b7 Vol 14"), labels.join("|"));
    assert.ok(!labels.some((l) => l.includes("%")), labels.join("|"));
    assert.ok(info.theater.portsText.includes("HDMI 1 Living Room TV (live)"));
    assert.ok(info.theater.portsText.includes("HDMI 2 Nakamichi Sound Bar (connected)"));
    assert.ok(info.theater.portsText.includes("HDMI 3 Switch2 Game Console (not connected)"));
  });

  it("marks Input HDMI 1 redundant from the port id, not the CEC label", () => {
    const info = describeHaDeviceState(tv, theaterEnv());
    assert.equal(isHaCommandRedundant("Input HDMI 1", info), true);
    assert.equal(isHaCommandRedundant("Input HDMI 4", info), false);
  });

  it("never invents theater state when stale, off or unavailable", () => {
    for (const env of [
      { version: 1, stale: true, states: theaterEnv().states },
      theaterEnv({ available: false }),
      theaterEnv({ theater: null }),
    ]) {
      const info = describeHaDeviceState(tv, env);
      assert.equal(info.theater, null);
      assert.equal(info.activeInputId, null);
    }
  });

  it("renders ports detail in the strip", () => {
    const html = haStateStripMarkup([tv], theaterEnv());
    assert.ok(html.includes("HDMI 2 Nakamichi Sound Bar (connected)"));
    assert.ok(html.includes("Sound: Nakamichi Sound Bar (ARC)"));
  });
});

describe("describeTheaterLink (display-only CEC links)", () => {
  const amp = { id: "81897247", name: "Nakamichi Amp", transport: 1, isHa: false, entry: { Device: { Transport: 1 } }, commands: [] };
  const box = { id: "91684097", name: "Living Room TV box", transport: 1, isHa: false, entry: { Device: { Transport: 1 } }, commands: [] };
  const linkedEnv = (extra = {}) => ({
    version: 21, stale: false,
    states: [{ key: "media_player.living_room_tv", available: true, power: "on", theater: THEATER,
      theater_links: [{ port: "HDMI_2", device_id: "81897247" }, { port: "HDMI_1", device_id: "91684097" }], ...extra }],
  });

  it("shows ARC and TV-reported volume for the soundbar link, never power", () => {
    const info = describeTheaterLink(amp, linkedEnv());
    assert.equal(info.known, true);
    assert.equal(info.power, "unknown");
    const labels = info.chips.map((c) => c.label);
    assert.ok(labels.some((l) => l.startsWith("On ARC")), labels.join("|"));
    assert.ok(labels.some((l) => l.includes("Vol 14")), labels.join("|"));
    assert.ok(!labels.some((l) => /^(On|Off)$/.test(l)), labels.join("|"));
  });

  it("shows live + signal for a linked playback device", () => {
    const info = describeTheaterLink(box, linkedEnv());
    const labels = info.chips.map((c) => c.label);
    assert.ok(labels.includes("HDMI 1 \u00b7 live on the TV"), labels.join("|"));
    assert.ok(labels.includes("Signal present"), labels.join("|"));
  });

  it("is unknown when stale/off-theater, and null when unlinked", () => {
    assert.equal(describeTheaterLink(amp, { version: 1, stale: true, states: linkedEnv().states }).known, false);
    assert.equal(describeTheaterLink(amp, linkedEnv({ theater: null })).known, false);
    assert.equal(describeTheaterLink({ id: "1", name: "Other", commands: [] }, linkedEnv()), null);
    assert.equal(describeTheaterLink(amp, null), null, "no envelope yet: link not known, nothing invented");
  });

  it("renders a linked IR device in the strip", () => {
    const html = haStateStripMarkup([amp], linkedEnv());
    assert.ok(html.includes("Nakamichi Amp"));
    assert.ok(html.includes("On ARC"));
  });
});

describe("isHaCommandRedundant and fixItDevices hints", () => {
  const tv = makeHaDevice();

  it("marks PowerOn, Play and the current Input redundant when fresh and matching", () => {
    const onInfo = describeHaDeviceState(tv, {
      version: 1,
      stale: false,
      states: [
        {
          key: "media_player.living_room_tv",
          available: true,
          power: "on",
          source: "HDMI 1",
          playing: "playing",
        },
      ],
    });
    assert.equal(isHaCommandRedundant("PowerOn", onInfo), true);
    assert.equal(isHaCommandRedundant("PowerOff", onInfo), false);
    assert.equal(isHaCommandRedundant("Input HDMI 1", onInfo), true);
    assert.equal(isHaCommandRedundant("Input HDMI 4", onInfo), false);
    assert.equal(isHaCommandRedundant("Play", onInfo), true);
    assert.equal(isHaCommandRedundant("Pause", onInfo), false);
  });

  it("never marks commands redundant when state is unknown or stale", () => {
    const unknownInfo = describeHaDeviceState(tv, { version: 1, stale: true, states: [] });
    assert.equal(isHaCommandRedundant("PowerOn", unknownInfo), false);
    assert.equal(isHaCommandRedundant("PowerOff", unknownInfo), false);
  });

  it("adds Fix It hints from fresh or stale HA state", () => {
    const activity = {
      "Id-": 100,
      Name: "Watch TV",
      Roles: [
        {
          "DeviceId-": 90000001,
          __type: "DisplayActivityRole",
          PowerOnOrder: 1,
          SelectedInput: { Name: "HDMI 1" },
        },
      ],
    };
    const fresh = fixItDevices(activity, [tv], {
      version: 2,
      stale: false,
      states: [{ key: "media_player.living_room_tv", available: true, power: "on", source: "HDMI 1" }],
    });
    assert.equal(fresh[0].haHint, "Living Room TV is already on · on HDMI 1");

    const off = fixItDevices(activity, [tv], {
      version: 3,
      stale: false,
      states: [{ key: "media_player.living_room_tv", available: true, power: "off" }],
    });
    assert.equal(off[0].haHint, "Living Room TV is off");

    const stale = fixItDevices(activity, [tv], { version: 3, stale: true, states: [] });
    assert.equal(stale[0].haHint, "State unknown");
  });
});

describe("codex_webui /api/ha-state C handlers", () => {
  it("validates limits, rate-limits, persists in volatile tmpfs and marks stale after 90 s", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-ha-state-test-"));
    const stateFile = path.join(tmpDir, "ha-state.json");
    const lockFile = path.join(tmpDir, "ha-state.lock");
    const dataDir = path.join(tmpDir, "data");
    fs.mkdirSync(dataDir);
    const harnessC = path.join(tmpDir, "harness.c");
    const harnessBin = path.join(tmpDir, "harness");

    fs.writeFileSync(
      harnessC,
      `
#define HA_STATE_FILE "${stateFile.replace(/\\/g, "\\\\")}"
#define HA_STATE_LOCK_FILE "${lockFile.replace(/\\/g, "\\\\")}"
#define CODEX_WEBUI_NO_MAIN 1
#include "codex_webui.c"

static void run_post(const char *body, size_t len, char *out, size_t outlen) {
    int sv[2];
    struct request req;
    memset(&req, 0, sizeof(req));
    strcpy(req.method, "POST");
    strcpy(req.path, "/api/ha-state");
    req.body = (char *)body;
    req.body_len = len;
    if (socketpair(AF_UNIX, SOCK_STREAM, 0, sv) != 0) _exit(2);
    render_ha_state_post_json(sv[0], &req);
    close(sv[0]);
    ssize_t n = read(sv[1], out, outlen - 1);
    out[n > 0 ? n : 0] = 0;
    close(sv[1]);
}

static void run_get(const char *path, char *out, size_t outlen) {
    int sv[2];
    struct request req;
    memset(&req, 0, sizeof(req));
    strcpy(req.method, "GET");
    snprintf(req.path, sizeof(req.path), "%s", path);
    if (socketpair(AF_UNIX, SOCK_STREAM, 0, sv) != 0) _exit(2);
    render_ha_state_get_json(sv[0], &req);
    close(sv[0]);
    ssize_t n = read(sv[1], out, outlen - 1);
    out[n > 0 ? n : 0] = 0;
    close(sv[1]);
}

int main(void) {
    char resp[131072];

    /* 1. Initial GET before any push: version 0, stale true */
    run_get("/api/ha-state", resp, sizeof(resp));
    if (!strstr(resp, "\\"version\\":0") || !strstr(resp, "\\"stale\\":true")) return 10;

    /* 2. Oversized body (> 64 KiB) -> 413 */
    char *big = (char *)malloc(70000);
    memset(big, ' ', 69999);
    big[69999] = 0;
    run_post(big, 69999, resp, sizeof(resp));
    free(big);
    if (!strstr(resp, "413 Payload Too Large")) return 11;

    /* 3. > 64 states -> 400 */
    char many[4096];
    size_t pos = (size_t)snprintf(many, sizeof(many), "{\\"states\\":[");
    for (int i = 0; i < 65; i++) {
        pos += (size_t)snprintf(many + pos, sizeof(many) - pos, "%s{\\"key\\":\\"k%d\\"}", i ? "," : "", i);
    }
    snprintf(many + pos, sizeof(many) - pos, "]}");
    run_post(many, strlen(many), resp, sizeof(resp));
    if (!strstr(resp, "400 Bad Request")) return 12;

    /* 4. Valid push -> 200, version 1, stored 1 */
    const char *good = "{\\"states\\":[{\\"key\\":\\"media_player.tv\\",\\"power\\":\\"on\\"}]}";
    run_post(good, strlen(good), resp, sizeof(resp));
    if (!strstr(resp, "200 OK") || !strstr(resp, "\\"version\\":1") || !strstr(resp, "\\"stored\\":1")) return 13;

    /* 5. Immediate second push -> 429 + Retry-After: 2 */
    run_post(good, strlen(good), resp, sizeof(resp));
    if (!strstr(resp, "429 Too Many Requests") || !strstr(resp, "Retry-After: 2")) return 14;

    /* 6. GET ?since=1 -> changed:false, code:304, stale:false */
    run_get("/api/ha-state?since=1", resp, sizeof(resp));
    if (!strstr(resp, "\\"code\\":304") || !strstr(resp, "\\"changed\\":false") || !strstr(resp, "\\"stale\\":false")) return 15;

    /* 7. GET ?since=0 -> changed:true, code:200 */
    run_get("/api/ha-state?since=0", resp, sizeof(resp));
    if (!strstr(resp, "\\"code\\":200") || !strstr(resp, "\\"changed\\":true")) return 16;

    /* 8. Backdate received by 95 s -> stale:true even when since=1 */
    long old_ts = (long)time(NULL) - 95;
    char aged[512];
    snprintf(aged, sizeof(aged),
        "{\\"version\\":1,\\"received\\":%ld,\\"rates\\":[],\\"states\\":[{\\"key\\":\\"media_player.tv\\",\\"power\\":\\"on\\"}]}",
        old_ts);
    write_file_atomic(HA_STATE_FILE, aged, strlen(aged));
    run_get("/api/ha-state?since=1", resp, sizeof(resp));
    if (!strstr(resp, "\\"stale\\":true") || !strstr(resp, "\\"changed\\":true")) return 17;

    /* 9. Second push after rate window -> version 2 */
    run_post(good, strlen(good), resp, sizeof(resp));
    if (!strstr(resp, "\\"version\\":2")) return 18;

    return 0;
}
`,
    );

    try {
      execFileSync(
        "cc",
        ["-std=c99", "-O2", "-I", path.join(ROOT, "payload/source"), "-o", harnessBin, harnessC],
        { stdio: "pipe" },
      );
      execFileSync(harnessBin, [], { stdio: "pipe" });
      assert.deepEqual(fs.readdirSync(dataDir), [], "nothing written outside volatile state file");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
