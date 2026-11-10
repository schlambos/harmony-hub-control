// USB Ethernet (/api/usb-eth) simulator and status model tests.
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { usbEthStatus } from "../public/js/views/remotes-model.js";

const SERVER = fileURLToPath(new URL("../server.mjs", import.meta.url));
const PORT = 18990 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;
let proc;

const post = (path, body) => fetch(`${BASE}${path}`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

const postRaw = (path, raw, headers = { "Content-Type": "application/json" }) =>
  fetch(`${BASE}${path}`, { method: "POST", headers, body: raw });

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

describe("usbEthStatus model", () => {
  it("reports loading, error, unsupported, and Wi-Fi/Ethernet states", () => {
    assert.equal(usbEthStatus(undefined), "Checking…");
    assert.equal(usbEthStatus(null), "Couldn't check USB Ethernet");
    assert.equal(usbEthStatus({}, "saving"), "Applying…");
    assert.equal(usbEthStatus({ supported: false }), "Not available on this hub's kernel");
    assert.equal(
      usbEthStatus({ supported: true, enabled: false }),
      "Wi-Fi only · Self-powered OTG Realtek adapter",
    );
    assert.equal(
      usbEthStatus({ supported: true, enabled: false, usbProduct: "USB 10/100 LAN" }),
      "Wi-Fi only · USB 10/100 LAN detected",
    );
    assert.equal(
      usbEthStatus({ supported: true, enabled: true, ifname: "" }),
      "On · Waiting for self-powered OTG Realtek adapter",
    );
    assert.equal(
      usbEthStatus({ supported: true, enabled: true, ifname: "eth0", carrier: true, ipv4: "192.168.1.55", usbProduct: "USB 10/100 LAN" }),
      "Ethernet + Wi-Fi · eth0 · 192.168.1.55 · USB 10/100 LAN",
    );
    assert.equal(
      usbEthStatus({ supported: true, enabled: true, ifname: "eth0", carrier: false }),
      "Ethernet + Wi-Fi · eth0 · No link",
    );
  });
});

describe("simulator /api/usb-eth", () => {
  it("starts disabled on a compatible kernel and enables/disables cleanly", async () => {
    const initial = await (await fetch(`${BASE}/api/usb-eth`)).json();
    assert.equal(initial.ok, true);
    assert.equal(initial.enabled, false);
    assert.equal(initial.supported, true);
    assert.equal(initial.kernel, "2.6.31-g89d565c");
    assert.equal(initial.ehciBound, false);

    await post("/api/sim/usb-eth", {
      adapter: { vidPid: "0bda:8152", product: "USB 10/100 LAN", carrier: true, ipv4: "192.168.1.77" },
    });

    const on = await (await post("/api/usb-eth", { enabled: true })).json();
    assert.equal(on.ok, true);
    assert.equal(on.enabled, true);
    assert.equal(on.ehciBound, true);
    assert.equal(on.ifname, "eth0");
    assert.equal(on.carrier, true);
    assert.equal(on.ipv4, "192.168.1.77");

    // Stopping brings the interface down but leaves EHCI registered, like the hub.
    const off = await (await post("/api/usb-eth", { enabled: false })).json();
    assert.equal(off.ok, true);
    assert.equal(off.enabled, false);
    assert.equal(off.ehciBound, true);
    assert.equal(off.ifname, "");
  });

  it("enforces same-origin JSON and top-level boolean enabled token", async () => {
    const crossSite = await postRaw("/api/usb-eth", '{"enabled":true}', {
      "Content-Type": "application/json",
      Origin: "http://evil.example",
    });
    assert.equal(crossSite.status, 403);

    const formPost = await postRaw("/api/usb-eth", "enabled=true", {
      "Content-Type": "application/x-www-form-urlencoded",
    });
    assert.equal(formPost.status, 403);

    for (const raw of ['{"enabled":"true"}', '{"enabled":1}', '{"nested":{"enabled":true}}']) {
      const bad = await postRaw("/api/usb-eth", raw);
      assert.equal(bad.status, 400, raw);
    }
  });

  it("refuses to enable on an incompatible kernel build", async () => {
    await post("/api/sim/usb-eth", { supported: false });
    const res = await post("/api/usb-eth", { enabled: true });
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.match(body.error, /2\.6\.31-g89d565c/);
  });
});
