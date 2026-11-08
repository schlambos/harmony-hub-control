// The simulator's /api/androidtv/devices writer, through the real server.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const SERVER = fileURLToPath(new URL("../server.mjs", import.meta.url));
const PORT = 18700 + Math.floor(Math.random() * 200);
const BASE = `http://127.0.0.1:${PORT}`;
let proc;

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

describe("simulator network TV writer", () => {
  it("gives two TVs added in one request their own device and command ids", async () => {
    const res = await fetch(`${BASE}/api/androidtv/devices`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ devices: [
        { entity: "androidtv11111111", name: "Den TV" },
        { entity: "androidtv22222222", name: "Bedroom TV" },
      ] }),
    });
    const reply = await res.json();
    assert.equal(reply.ok, true, JSON.stringify(reply));
    const [a, b] = reply.devices.map((d) => d.deviceId);
    assert.notEqual(a, b);

    const config = await (await fetch(`${BASE}/api/activity-config`)).json();
    const tvs = config.deviceList.DevicesWithFeatures.filter((e) =>
      String(e.Device?.AutoDetectedDevice?.Id ?? "").startsWith("melodious-androidtv-"));
    assert.equal(tvs.length, 2);
    assert.equal(new Set(tvs.map((e) => e.Device.AutoDetectedDevice.Id)).size, 2);
    const commandIds = tvs.flatMap((e) => e.Commands.map((c) => c["Id-"]));
    assert.equal(new Set(commandIds).size, commandIds.length);
  });
});
