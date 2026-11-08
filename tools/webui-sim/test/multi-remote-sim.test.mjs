// The simulator's multiple-remotes routes behave like codex_webui's.
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const SERVER = fileURLToPath(new URL("../server.mjs", import.meta.url));
const PORT = 18900 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;
let proc;

const post = (path, body) => fetch(`${BASE}${path}`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
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
beforeEach(() => post("/api/sim/reset", {}));

describe("simulator multiple remotes", () => {
  it("refuses off while a pairing window is open, like the hub", async () => {
    await post("/api/sim/multi-remote", { on: true });
    const pairing = post("/api/remote-pair", { seconds: 10 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const off = await post("/api/multi-remote", { enabled: false });
    assert.equal(off.status, 409);
    assert.match((await off.json()).error, /pairing window is open/);
    await (await pairing).json();
  });

  it("refuses to pair while the hub is about to restart to turn it off", async () => {
    await post("/api/sim/multi-remote", { on: true });
    const off = await (await post("/api/multi-remote", { enabled: false })).json();
    assert.equal(off.rebooting, true);
    const pair = await post("/api/remote-pair", { seconds: 10 });
    assert.equal(pair.status, 409);
    const reply = await pair.json();
    assert.equal(reply.restarting, true);
    assert.match(reply.error, /about to restart/);
  });

  it("unpairs only a JSON integer slot", async () => {
    for (const slot of ["2", 1.5, 10, 0]) {
      const res = await post("/api/remote-unpair", { slot });
      assert.equal(res.status, 400, `slot ${JSON.stringify(slot)}`);
    }
    const ok = await post("/api/remote-unpair", { slot: 2 });
    assert.equal(ok.status, 200);
  });
});
