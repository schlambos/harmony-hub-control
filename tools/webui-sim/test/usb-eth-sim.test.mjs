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
      "Wi-Fi only · Self-powered OTG Ethernet adapter",
    );
    assert.equal(
      usbEthStatus({ supported: true, enabled: false, usbProduct: "USB 10/100 LAN" }),
      "Wi-Fi only · USB 10/100 LAN detected",
    );
    assert.equal(
      usbEthStatus({ supported: true, enabled: true, ifname: "" }),
      "On · Waiting for self-powered OTG Ethernet adapter",
    );
    assert.equal(
      usbEthStatus({ supported: true, enabled: true, ifname: "eth0", carrier: true, ipv4: "192.168.1.55", usbProduct: "USB 10/100 LAN" }),
      "Ethernet + Wi-Fi · eth0 · 192.168.1.55 · USB 10/100 LAN",
    );
    assert.equal(
      usbEthStatus({ supported: true, enabled: true, ifname: "eth0", carrier: false }),
      "On · eth0 · No link",
    );
    // Enabled is not operational: startup progress and failures read as such.
    assert.equal(
      usbEthStatus({ supported: true, enabled: true, state: "starting", reason: "phy_wait" }),
      "Turning on… waiting for the USB controller",
    );
    assert.equal(
      usbEthStatus({ supported: true, enabled: true, state: "failed", reason: "phy_not_ready" }),
      "On, but not working: USB PHY not ready",
    );
    assert.equal(
      usbEthStatus({ supported: true, enabled: true, state: "failed", reason: "controller_registered_unbound" }),
      "On, but not working: USB controller did not start",
    );
    assert.equal(
      usbEthStatus({ supported: true, enabled: true, state: "degraded_routing", reason: "route_apply_failed", ifname: "eth2", carrier: true, ipv4: "192.168.0.234" }),
      "On, but wired replies are not confirmed on the cable: routing could not be applied",
    );
    assert.equal(
      usbEthStatus({ supported: true, enabled: true, state: "awaiting_carrier_dhcp", ifname: "eth2", carrier: true, ipv4: "" }),
      "On · eth2 · Waiting for DHCP…",
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
    assert.equal(on.operational, true);
    assert.equal(on.state, "operational");
    assert.equal(on.routeMode, "metric");
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

  it("binds ASIX and class-matched CDC adapters like the hub service", async () => {
    // ASIX AX88772 by VID:PID (usb_driver=asix on the hub).
    await post("/api/sim/usb-eth", {
      adapter: { vidPid: "0b95:7720", product: "ASIX AX88772", carrier: true, ipv4: "192.168.1.88" },
    });
    const asix = await (await post("/api/usb-eth", { enabled: true })).json();
    assert.equal(asix.ifname, "eth0");
    assert.equal(asix.driverLoaded, true);
    assert.equal(asix.ipv4, "192.168.1.88");

    // CDC-ECM with an unlisted VID:PID: binds by interface class (02/06).
    await post("/api/sim/usb-eth", {
      adapter: { vidPid: "1234:5678", product: "Generic CDC Ethernet", carrier: true, ipv4: "192.168.1.99" },
    });
    const cdc = await (await fetch(`${BASE}/api/usb-eth`)).json();
    assert.equal(cdc.ifname, "eth0");
    assert.equal(cdc.driverLoaded, true);
    assert.equal(cdc.usbDevice, "1234:5678");

    // A chipset with no shipped driver never pretends to bind.
    await post("/api/sim/usb-eth", {
      adapter: { vidPid: "0424:ec00", product: "SMSC LAN9500", supportedChip: false },
    });
    const other = await (await fetch(`${BASE}/api/usb-eth`)).json();
    assert.equal(other.ifname, "");
    assert.equal(other.driverLoaded, false);
  });

  it("reports a failed startup distinctly from operational", async () => {
    await post("/api/sim/usb-eth", {
      adapter: { vidPid: "0bda:8153", product: "USB 10/100/1000 LAN", carrier: true, ipv4: "192.168.1.90" },
    });
    await post("/api/usb-eth", { enabled: true });
    await post("/api/sim/usb-eth", { state: "failed", reason: "phy_not_ready" });
    const failed = await (await fetch(`${BASE}/api/usb-eth`)).json();
    assert.equal(failed.enabled, true);
    assert.equal(failed.operational, false);
    assert.equal(failed.state, "failed");
    assert.equal(failed.reason, "phy_not_ready");
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
