import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SIM_DIR = path.join(HERE, "..");

function startSim() {
  const port = 19100 + Math.floor(Math.random() * 200);
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

describe("LG webOS TV simulator end-to-end", () => {
  let sim;

  before(async () => {
    sim = await startSim();
  });

  after(() => {
    sim?.child?.kill();
  });

  it("supports pairing deny and accept, input/app refresh, commit, commands, edit, and delete", async () => {
    // 1. Pairing deny path
    const denyStart = await reqJson(sim.base, "/api/webos/pair-start", {
      method: "POST",
      body: { name: "Living Room LG", host: "192.168.1.40", mac: "AA:BB:CC:11:22:33", simulateDeny: true },
    });
    assert.equal(denyStart.status, 200);
    assert.equal(denyStart.json.state, "prompt");
    const denyStatus = await reqJson(sim.base, "/api/webos/pair-status");
    assert.equal(denyStatus.json.state, "denied");
    assert.equal(denyStatus.json.paired, false);

    // 2. Pairing accept path
    const acceptStart = await reqJson(sim.base, "/api/webos/pair-start", {
      method: "POST",
      body: { name: "Living Room LG", host: "192.168.1.40", mac: "aa-bb-cc-11-22-33" },
    });
    assert.equal(acceptStart.status, 200);
    assert.equal(acceptStart.json.state, "prompt");
    const pairStatus = await reqJson(sim.base, "/api/webos/pair-status");
    assert.equal(pairStatus.json.state, "paired");
    assert.equal(pairStatus.json.paired, true);
    const tvId = pairStatus.json.tvId;
    assert.match(tvId, /^webos[0-9a-f]+$/);

    // Client-key must NEVER appear in any status response
    const st = await reqJson(sim.base, "/api/webos/status");
    assert.equal(st.status, 200);
    assert.equal(st.json.tvs.length, 1);
    assert.equal(st.json.tvs[0].paired, true);
    assert.equal(JSON.stringify(st.json).includes("_key"), false);
    assert.equal(JSON.stringify(st.json).includes("sim-ephemeral"), false);

    // 3. Refresh inputs & apps
    const ref = await reqJson(sim.base, "/api/webos/refresh", {
      method: "POST",
      body: { id: tvId },
    });
    assert.equal(ref.json.ok, true);
    assert.equal(ref.json.tv.inputs.length, 4);
    assert.ok(ref.json.tv.apps.some((a) => a.command === "App Netflix"));

    // 4. Commit hub device (rejecting plaintext clientKey)
    const leak = await reqJson(sim.base, "/api/webos/devices", {
      method: "POST",
      body: { devices: [{ entity: tvId, name: "Living Room LG", host: "192.168.1.40", clientKey: "secret" }] },
    });
    assert.equal(leak.status, 422);

    const committed = await reqJson(sim.base, "/api/webos/devices", {
      method: "POST",
      body: {
        devices: [
          {
            entity: tvId,
            name: "Living Room LG",
            host: "192.168.1.40",
            mac: "AA:BB:CC:11:22:33",
            paired: true,
            inputs: ref.json.tv.inputs.map((i) => ({ name: i.label, command: `Input ${i.label}` })),
            apps: ref.json.tv.apps.map((a) => ({ name: a.command, id: a.id })),
          },
        ],
      },
    });
    assert.equal(committed.status, 200);
    assert.deepEqual(committed.json.added, ["Living Room LG"]);

    // Verify device entry in /api/activity-config has discrete PowerFeature + commands
    const cfg = await reqJson(sim.base, "/api/activity-config");
    const entry = cfg.json.deviceList.DevicesWithFeatures.find(
      (e) => String(e.Device?.AutoDetectedDevice?.Id ?? "").startsWith("melodious-webos-"),
    );
    assert.ok(entry, "webOS device should be in DeviceList");
    assert.ok(entry.Commands.some((c) => c.Name === "PowerOn"));
    assert.ok(entry.Commands.some((c) => c.Name === "PowerOff"));
    assert.ok(entry.Commands.some((c) => c.Name === "App Netflix"));
    const pf = entry.DeviceFeatures.find((f) => f.__type === "PowerFeature");
    assert.equal(pf.PowerTypeId, 1);

    // 5. Commands: VolumeUp succeeds, PowerOff turns TV off, subsequent VolumeUp fails (no silent success), PowerOn wakes via WoL
    const v1 = await reqJson(sim.base, "/api/webos/cmd", { method: "POST", body: { device: tvId, command: "VolumeUp" } });
    assert.equal(v1.json.ok, true);
    const off = await reqJson(sim.base, "/api/webos/cmd", { method: "POST", body: { device: tvId, command: "PowerOff" } });
    assert.equal(off.json.ok, true);
    const vFail = await reqJson(sim.base, "/api/webos/cmd", { method: "POST", body: { device: tvId, command: "VolumeUp" } });
    assert.equal(vFail.json.ok, false);
    assert.match(vFail.json.error, /not connected/i);
    const on = await reqJson(sim.base, "/api/webos/cmd", { method: "POST", body: { device: tvId, command: "PowerOn" } });
    assert.equal(on.json.ok, true);

    // 6. Edit without MAC switches to honest PowerToggle (no fake PowerOn)
    const edited = await reqJson(sim.base, "/api/webos/devices", {
      method: "POST",
      body: {
        devices: [
          {
            entity: tvId,
            name: "Theater LG",
            host: "192.168.1.40",
            mac: "",
            paired: true,
          },
        ],
      },
    });
    assert.equal(edited.status, 200);
    const cfg2 = await reqJson(sim.base, "/api/activity-config");
    const entry2 = cfg2.json.deviceList.DevicesWithFeatures.find(
      (e) => String(e.Device?.AutoDetectedDevice?.Id ?? "").startsWith("melodious-webos-"),
    );
    assert.equal(entry2.Device.Name, "Theater LG");
    assert.equal(entry2.Commands.some((c) => c.Name === "PowerOn"), false);
    const pf2 = entry2.DeviceFeatures.find((f) => f.__type === "PowerFeature");
    assert.equal(pf2.PowerTypeId, 2);

    // 7. Delete + forget removes device cleanly
    const del = await reqJson(sim.base, "/api/webos/devices", { method: "POST", body: { devices: [] } });
    assert.equal(del.status, 200);
    assert.deepEqual(del.json.removed, ["Theater LG"]);
    const fgt = await reqJson(sim.base, "/api/webos/forget", { method: "POST", body: { id: tvId } });
    assert.equal(fgt.json.ok, true);
    const stAfter = await reqJson(sim.base, "/api/webos/status");
    assert.deepEqual(stAfter.json.tvs, []);
  });
});
