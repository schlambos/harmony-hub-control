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

  it("says how the cable is used: Wi-Fi off, another network, router not answering", () => {
    const up = { supported: true, enabled: true, state: "operational", operational: true, ifname: "eth0", carrier: true, ipv4: "192.168.1.55", lanInterface: "eth0" };
    assert.equal(usbEthStatus(up), "Ethernet + Wi-Fi · eth0 · 192.168.1.55");
    assert.equal(usbEthStatus({ ...up, wifiOff: true, wifiSuspended: true }), "Ethernet · Wi-Fi off · eth0 · 192.168.1.55");
    assert.equal(usbEthStatus({ ...up, wifiOff: true }), "Ethernet + Wi-Fi · eth0 · 192.168.1.55");
    assert.equal(
      usbEthStatus({ ...up, separateNetwork: true, ipv4: "10.0.0.55", lanInterface: "ath0" }),
      "Wi-Fi · cable on another network · eth0 · 10.0.0.55",
    );
    assert.equal(
      usbEthStatus({ ...up, operational: false, state: "gateway_unreachable", reason: "gateway_lost", gatewayUnreachable: true, lanInterface: "ath0" }),
      "On · eth0 · Router not answering through the cable · using Wi-Fi",
    );
    assert.equal(
      usbEthStatus({ ...up, operational: false, state: "awaiting_carrier_dhcp", reason: "gateway_check" }),
      "On · eth0 · Checking the router…",
    );
    assert.equal(
      usbEthStatus({ ...up, operational: false, state: "awaiting_carrier_dhcp", reason: "no_ipv4_lease", ipv4: "", ipMode: "static" }),
      "On · eth0 · Setting the static address…",
    );
    assert.equal(
      usbEthStatus({ ...up, operational: false, state: "failed", reason: "static_invalid" }),
      "On, but not working: static address settings need fixing",
    );
    assert.equal(usbEthStatus({ ...up, operational: false, state: "adapter_absent", reason: "interface_gone", ifname: "" }), "On · Adapter disconnected");
    assert.equal(
      usbEthStatus({ ...up, operational: false, state: "degraded_routing", reason: "prefix_mismatch" }),
      "On · eth0 · Subnet mask differs from Wi-Fi's · using Wi-Fi",
    );
    assert.equal(
      usbEthStatus({ ...up, operational: false, state: "failed", reason: "worker_stopped" }),
      "On, but not working: stopped unexpectedly, back on Wi-Fi",
    );
    assert.equal(usbEthStatus({ supported: false, kernel: "unknown" }), "USB Ethernet files missing · install again");
    assert.equal(usbEthStatus({ supported: false, kernel: "2.6.31-other" }), "Not available on this hub's kernel");
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

  it("reports how the cable is used, with its link, address and counters", async () => {
    const off = await (await fetch(`${BASE}/api/usb-eth`)).json();
    assert.deepEqual(
      [off.ipMode, off.wifiOff, off.wifiSuspended, off.separateNetwork, off.gatewayUnreachable, off.lanInterface, off.speedMbps, off.netmask, off.rxBytes],
      ["dhcp", false, false, false, false, "ath0", null, null, null],
    );
    assert.deepEqual(off.staticConfig, { address: "", netmask: "", gateway: "", dns: [] });
    await post("/api/sim/usb-eth", { adapter: { vidPid: "0b95:772a", product: "AX88772A", carrier: true, ipv4: "192.168.1.77" } });
    const on = await (await post("/api/usb-eth", { enabled: true })).json();
    assert.deepEqual(
      [on.state, on.lanInterface, on.speedMbps, on.fullDuplex, on.netmask, on.router, on.wifiIp, on.separateNetwork],
      ["operational", "eth0", 100, true, "255.255.255.0", "192.168.1.1", "192.168.1.50", false],
    );
    assert.deepEqual(on.dns, ["192.168.1.1"]);
    assert.equal(typeof on.rxBytes, "number");
    assert.equal(typeof on.txBytes, "number");
  });

  it("keeps local traffic on Wi-Fi on another network, or when the router doesn't answer", async () => {
    await post("/api/sim/usb-eth", { adapter: { vidPid: "0b95:772a", carrier: true }, separate: true });
    const separate = await (await post("/api/usb-eth", { enabled: true })).json();
    assert.deepEqual(
      [separate.state, separate.operational, separate.separateNetwork, separate.ipv4, separate.lanInterface],
      ["operational", true, true, "10.0.0.55", "ath0"],
    );
    const lost = await (await post("/api/sim/usb-eth", { separate: false, gatewayLost: true })).json();
    assert.deepEqual(
      [lost.state, lost.reason, lost.operational, lost.gatewayUnreachable, lost.separateNetwork, lost.lanInterface],
      ["gateway_unreachable", "gateway_lost", false, true, false, "ath0"],
    );
    const back = await (await post("/api/sim/usb-eth", { gatewayLost: false })).json();
    assert.deepEqual([back.state, back.lanInterface], ["operational", "eth0"]);
  });

  it("turns Wi-Fi off while the cable works, set on its own", async () => {
    const set = await post("/api/usb-eth", { wifiOff: true });
    assert.equal(set.status, 200);
    const st = await set.json();
    assert.deepEqual([st.enabled, st.wifiOff, st.wifiSuspended], [false, true, false]);
    await post("/api/sim/usb-eth", { adapter: { vidPid: "0b95:772a", carrier: true } });
    const on = await (await post("/api/usb-eth", { enabled: true })).json();
    assert.deepEqual([on.state, on.wifiSuspended], ["operational", false]); // not before the cable has worked a while
    await new Promise((resolve) => setTimeout(resolve, 1700));
    const later = await (await fetch(`${BASE}/api/usb-eth`)).json();
    assert.equal(later.wifiSuspended, true);
    const overview = await (await fetch(`${BASE}/api/network-overview`)).json();
    assert.deepEqual([overview.wifi.suspended, overview.wifi.state], [true, "DISCONNECTED"]);
    const back = await (await post("/api/usb-eth", { wifiOff: false })).json();
    assert.deepEqual([back.wifiOff, back.wifiSuspended, back.enabled], [false, false, true]);
    // An egress guard without its watchdog: the option waits for a restart.
    await post("/api/sim/usb-eth", { wifiNeedsRestart: true });
    const waits = await (await post("/api/usb-eth", { wifiOff: true })).json();
    assert.deepEqual([waits.wifiOff, waits.wifiNeedsRestart, waits.wifiSuspended], [true, true, false]);
    for (const raw of ['{"wifiOff":"yes"}', '{"enabled":true,"wifiOff":1}', '{"other":true}', '{"ipMode":"manual"}', '{"ipMode":5}']) {
      assert.equal((await postRaw("/api/usb-eth", raw)).status, 400, raw);
    }
  });

  it("takes static address settings, checked like the hub", async () => {
    const bad = await post("/api/usb-eth", { ipMode: "static", address: "192.168.1.20", netmask: "255.255.0.255" });
    assert.equal(bad.status, 400);
    assert.deepEqual(await bad.json(), { ok: false, error: "That isn't a valid subnet mask.", field: "netmask" });
    const gw = await (await post("/api/usb-eth", { ipMode: "static", address: "192.168.1.20", netmask: "255.255.255.0", gateway: "192.168.2.1" })).json();
    assert.equal(gw.field, "gateway");
    const notString = await postRaw("/api/usb-eth", '{"ipMode":"static","address":20,"netmask":"255.255.255.0"}');
    assert.equal(notString.status, 400);
    assert.equal((await notString.json()).field, "address");
    assert.equal((await fetch(`${BASE}/api/usb-eth`).then((r) => r.json())).ipMode, "dhcp"); // nothing saved
    const set = await (await post("/api/usb-eth", {
      ipMode: "static", address: "192.168.1.20", netmask: "255.255.255.0", gateway: "192.168.1.1", dns1: "1.1.1.1", dns2: "",
    })).json();
    assert.equal(set.ipMode, "static");
    assert.deepEqual(set.staticConfig, { address: "192.168.1.20", netmask: "255.255.255.0", gateway: "192.168.1.1", dns: ["1.1.1.1"] });
    await post("/api/sim/usb-eth", { adapter: { vidPid: "0b95:772a", carrier: true, ipv4: "192.168.1.77" } });
    const up = await (await post("/api/usb-eth", { enabled: true })).json();
    assert.deepEqual([up.state, up.ipv4, up.netmask, up.router, up.dns], ["operational", "192.168.1.20", "255.255.255.0", "192.168.1.1", ["1.1.1.1"]]);
    // The overview's connected route is the address AND its mask, for any accepted mask.
    for (const [address, netmask, destination] of [["192.168.1.22", "255.255.255.252", "192.168.1.20"], ["192.168.1.20", "255.255.0.0", "192.168.0.0"]]) {
      await post("/api/usb-eth", { ipMode: "static", address, netmask });
      const routes = (await (await fetch(`${BASE}/api/network-overview`)).json()).routes;
      const wired = routes.find((r) => r.interface !== "ath0" && r.gateway === "0.0.0.0" && r.destination !== "224.0.0.0");
      assert.deepEqual([wired.destination, wired.netmask], [destination, netmask], `${address}/${netmask}`);
    }
    await post("/api/usb-eth", { ipMode: "static", address: "192.168.1.20", netmask: "255.255.255.0", gateway: "192.168.1.1", dns1: "1.1.1.1", dns2: "" });
    // Back to DHCP: the static values stay for the form.
    const dhcp = await (await post("/api/usb-eth", { ipMode: "dhcp" })).json();
    assert.deepEqual([dhcp.ipMode, dhcp.ipv4, dhcp.staticConfig.address], ["dhcp", "192.168.1.77", "192.168.1.20"]);
  });

  it("saves nothing when the kernel refuses on", async () => {
    await post("/api/sim/usb-eth", { supported: false });
    const res = await post("/api/usb-eth", { enabled: true, wifiOff: true });
    assert.equal(res.status, 409);
    const st = await (await fetch(`${BASE}/api/usb-eth`)).json();
    assert.deepEqual([st.enabled, st.wifiOff], [false, false]);
    // Settings that don't turn it on are still taken.
    assert.equal((await (await post("/api/usb-eth", { wifiOff: true })).json()).wifiOff, true);
  });

  it("gives a network overview that follows the cable", async () => {
    const before = await (await fetch(`${BASE}/api/network-overview`)).json();
    assert.deepEqual([before.ok, before.available, before.wired, before.lanInterface, before.cloudBlocker], [true, true, null, "ath0", true]);
    assert.equal(before.wifi.state, "COMPLETED");
    assert.ok(before.routes.every((r) => r.interface === "ath0"));
    await post("/api/sim/usb-eth", { adapter: { vidPid: "0b95:772a", carrier: true, ipv4: "192.168.1.77" } });
    await post("/api/usb-eth", { enabled: true });
    const after = await (await fetch(`${BASE}/api/network-overview`)).json();
    assert.equal(after.lanInterface, "eth0");
    assert.deepEqual([after.wired.interface, after.wired.ip, after.wired.up, after.wired.speedMbps, after.wired.mode], ["eth0", "192.168.1.77", true, 100, "dhcp"]);
    const subnet = after.routes.filter((r) => r.destination === "192.168.1.0");
    assert.deepEqual(subnet.map((r) => [r.interface, r.metric]), [["eth0", 0], ["ath0", 20]]);
  });
});
