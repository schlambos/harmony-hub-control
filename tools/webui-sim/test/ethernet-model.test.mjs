// What the hub's /api/usb-eth answer means for a person (views/ethernet-model.js).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  addressChangeWarning, cableCarriesLan, canEnable, canRetry, ethernetDetails, ethernetState, formatLink, formatTraffic,
  pollDelay, staticFormValues, turnOffText, turnOnText, validateStatic, wifiOffText,
} from "../public/js/views/ethernet-model.js";

// Operational, carrying local traffic: the shape codex_webui's write_usb_eth_json() sends.
const base = {
  ok: true, enabled: true, supported: true, kernel: "2.6.31-g89d565c", ehciBound: true, driverLoaded: true, gadgetLoaded: false,
  usbDevice: "0b95:772a", usbProduct: "AX88772A", ifname: "eth0", carrier: true, ipv4: "192.168.1.77",
  platformRegistered: true, operational: true, state: "operational", reason: "", routeMode: "metric",
  speedMbps: 100, fullDuplex: true, netmask: "255.255.255.0", router: "192.168.1.1", dns: ["192.168.1.1"],
  ipMode: "dhcp", staticConfig: { address: "", netmask: "", gateway: "", dns: [] },
  separateNetwork: false, gatewayUnreachable: false, wifiIp: "192.168.1.50",
  wifiOff: false, wifiSuspended: false, wifiNeedsRestart: false, rxBytes: 1536, txBytes: 5 * 1024 * 1024, lanInterface: "eth0",
};
const notWorking = { operational: false, routeMode: "" };

// Every state the service or the helper can report, with a reason where it matters.
const STATES = [
  ["starting", "queued"], ["starting", "phy_wait"], ["starting", "controller_wait"], ["starting", "adapter_wait"],
  ["failed", "static_invalid"], ["failed", "phy_not_ready"], ["failed", "deps_timeout"], ["failed", "controller_registered_unbound"],
  ["failed", "kernel_or_slot_check_failed"], ["failed", "driver_load_failed"], ["failed", "no_network_interface"], ["failed", "something_new"],
  ["degraded_routing", "route_apply_failed"], ["degraded_routing", "prefix_mismatch"], ["failed", "worker_stopped"], ["adapter_absent", "no_usb_device"], ["adapter_absent", "interface_gone"],
  ["adapter_unsupported", "unsupported_chipset"], ["awaiting_carrier_dhcp", "no_carrier"], ["awaiting_carrier_dhcp", "no_ipv4_lease"],
  ["awaiting_carrier_dhcp", "dhcp_or_carrier"], ["awaiting_carrier_dhcp", "gateway_check"], ["gateway_unreachable", "gateway_lost"],
  ["stopped", "stopped_by_request"], ["platform_absent", ""], ["platform_unbound", ""], ["deps_unavailable", ""], ["bus_ready", ""],
  ["nic_not_bound", ""],
];

describe("ethernet model", () => {
  it("explains each state with a next step", () => {
    for (const [state, reason] of STATES) {
      const s = ethernetState({ ...base, ...notWorking, state, reason });
      assert.ok(s.title && s.detail && ["live", "warn", "dim"].includes(s.tone), `${state}/${reason}`);
      assert.notEqual(s.title, "Unknown state", `${state}/${reason}`);
    }
    assert.equal(ethernetState({ ...base, ...notWorking, state: "something" }).title, "Unknown state");
    assert.equal(ethernetState(null).tone, "warn");
    const failed = (reason) => ethernetState({ ...base, ...notWorking, state: "failed", reason });
    assert.match(failed("phy_not_ready").detail, /its own power/);
    assert.match(failed("controller_registered_unbound").detail, /Restart the hub/);
    assert.match(failed("something_new").detail, /something new/);
    assert.equal(failed("static_invalid").title, "Static address settings need fixing");
    // The worker died and the egress guard handed everything back to Wi-Fi: say so, and offer to try again.
    assert.match(failed("worker_stopped").detail, /back to Wi-Fi/);
    assert.equal(canRetry({ ...base, ...notWorking, state: "failed", reason: "worker_stopped" }), true);
    // The cable on Wi-Fi's network with another mask: it never takes local traffic, and the fix is named.
    const mask = ethernetState({ ...base, ...notWorking, state: "degraded_routing", reason: "prefix_mismatch", netmask: "255.255.0.0" });
    assert.match(mask.title, /subnet mask/);
    assert.match(mask.detail, /255\.255\.0\.0/);
    assert.match(mask.detail, /same subnet mask/);
    const absent = ethernetState({ ...base, ...notWorking, state: "adapter_absent", reason: "no_usb_device", ifname: "", carrier: false });
    assert.match(absent.detail, /self-powered/);
    assert.match(ethernetState({ ...base, ...notWorking, state: "adapter_absent", reason: "interface_gone" }).title, /disconnected/);
    const other = ethernetState({ ...base, ...notWorking, state: "adapter_unsupported", usbDevice: "0424:ec00", usbProduct: "LAN9500", ifname: "" });
    assert.match(other.detail, /0424:ec00/);
    assert.match(other.detail, /docs\/USB_ETHERNET\.md/);
  });

  it("tells the waiting steps apart", () => {
    const waiting = (fields) => ethernetState({ ...base, ...notWorking, state: "awaiting_carrier_dhcp", ...fields });
    assert.equal(waiting({ reason: "no_carrier", carrier: false, ipv4: "" }).title, "No cable link");
    assert.equal(waiting({ reason: "no_ipv4_lease", ipv4: "" }).title, "Getting an address");
    assert.equal(waiting({ reason: "dhcp_or_carrier", carrier: false, ipv4: "" }).title, "No cable link");
    assert.equal(waiting({ reason: "no_ipv4_lease", ipv4: "", ipMode: "static" }).title, "Setting the address");
    const checking = waiting({ reason: "gateway_check" });
    assert.equal(checking.title, "Checking the router");
    assert.match(checking.detail, /192\.168\.1\.77/);
    assert.match(ethernetState({ ...base, ...notWorking, state: "starting", reason: "adapter_wait" }).detail, /about a minute/);
  });

  it("says when it's off, unsupported or not installed", () => {
    assert.deepEqual(ethernetState({ ...base, enabled: false, ...notWorking, state: "bus_ready", ifname: "", usbDevice: "" }),
      { tone: "dim", title: "Off", detail: "The hub uses Wi-Fi only." });
    assert.match(ethernetState({ ...base, enabled: false, ...notWorking, state: "bus_ready" }).detail, /AX88772A, 0b95:772a/);
    const kernel = ethernetState({ ...base, supported: false, kernel: "2.6.31-gabc" });
    assert.equal(kernel.title, "Not available on this hub");
    assert.match(kernel.detail, /4\.15\.600.*2\.6\.31-g89d565c.*2\.6\.31-gabc/);
    assert.equal(ethernetState({ ...base, supported: false, kernel: "unknown" }).title, "USB Ethernet files missing");
  });

  it("explains a working cable, and where local traffic goes", () => {
    const s = ethernetState(base);
    assert.deepEqual([s.tone, s.title], ["live", "Connected by cable"]);
    assert.match(s.detail, /192\.168\.1\.77.*sends local traffic through it/);
    assert.equal(cableCarriesLan(base), true);
    assert.equal(cableCarriesLan({ ...base, lanInterface: "ath0", separateNetwork: true }), false);
    assert.equal(cableCarriesLan({ ...base, ...notWorking }), false);
  });

  it("explains a cable whose router isn't answering through it", () => {
    const s = ethernetState({ ...base, ...notWorking, state: "gateway_unreachable", reason: "gateway_lost", gatewayUnreachable: true, lanInterface: "ath0" });
    assert.equal(s.tone, "warn");
    assert.match(s.title, /router not answering/);
    assert.match(s.detail, /stays on Wi-Fi.*10 minutes/);
  });

  it("explains a cable on another network", () => {
    const st = { ...base, separateNetwork: true, ipv4: "10.0.0.77", lanInterface: "ath0" };
    const s = ethernetState(st);
    assert.equal(s.tone, "live");
    assert.match(s.title, /another network/);
    assert.match(s.detail, /10\.0\.0\.77.*stays on Wi-Fi/);
    const rows = Object.fromEntries(ethernetDetails(st));
    assert.equal(rows["Local traffic goes through"], "Wi-Fi");
    assert.equal(rows["Wi-Fi address"], "192.168.1.50");
  });

  it("shows Wi-Fi off while the cable works", () => {
    const off = { ...base, wifiOff: true, wifiSuspended: true };
    assert.match(ethernetState(off).title, /Wi-Fi off/);
    assert.match(ethernetState(off).detail, /comes back by itself/);
    assert.match(ethernetState({ ...base, wifiOff: true }).detail, /turns off once the cable has worked for a minute/);
    assert.match(ethernetState({ ...base, wifiOff: true, wifiNeedsRestart: true }).detail, /once the hub has restarted/);
    // Blocker off and no router on the cable: Wi-Fi can't go off by waiting, so say so and don't poll.
    const blocked = { ...base, wifiOff: true, wifiOffBlocked: "noRouter" };
    assert.match(ethernetState(blocked).detail, /stays on: with the cloud blocker off/);
    assert.doesNotMatch(ethernetState(blocked).detail, /worked for a minute/);
    assert.match(Object.fromEntries(ethernetDetails(blocked))["Wi-Fi"], /no router for the internet/);
    assert.equal(pollDelay(blocked), 0);
    assert.equal(Object.fromEntries(ethernetDetails(off))["Wi-Fi"], "Off while the cable works");
    assert.equal(Object.fromEntries(ethernetDetails({ ...base, wifiOff: true }))["Wi-Fi"], "On (turns off while the cable works)");
    assert.match(Object.fromEntries(ethernetDetails({ ...base, wifiOff: true, wifiNeedsRestart: true }))["Wi-Fi"], /after the hub restarts/);
    assert.equal(Object.fromEntries(ethernetDetails(base))["Wi-Fi"], "On");
    assert.equal(Object.fromEntries(ethernetDetails({ ...base, enabled: false }))["Wi-Fi"], undefined);
  });

  it("explains turning on and off, and warns a page opened through the cable", () => {
    assert.match(turnOnText(), /self-powered/);
    assert.match(turnOnText(), /docs\/USB_ETHERNET\.md/);
    assert.doesNotMatch(turnOnText(), /Realtek|RTL815/);
    assert.match(turnOffText(base, "192.168.1.77"), /stop answering\. Open it again at 192\.168\.1\.50:8080/);
    assert.match(turnOffText({ ...base, wifiIp: null }, "192.168.1.77"), /at the hub's Wi-Fi address/);
    assert.match(turnOffText({ ...base, wifiSuspended: true }, "192.168.1.50"), /reconnecting Wi-Fi first/);
    const fromWifi = turnOffText(base, "192.168.1.50");
    assert.doesNotMatch(fromWifi, /stop answering/);
    assert.match(fromWifi, /Home Assistant/);
    assert.doesNotMatch(turnOffText(null, "hub.local"), /stop answering/);
  });

  it("explains turning Wi-Fi off, and warns a page opened over Wi-Fi", () => {
    const on = wifiOffText(base, true, "192.168.1.77");
    assert.match(on, /reachable only at its wired address/);
    assert.match(on, /always comes back after a restart/);
    assert.doesNotMatch(on, /stop answering/);
    assert.match(wifiOffText(base, true, "192.168.1.50"), /stop answering when Wi-Fi turns off\. Open it again at 192\.168\.1\.77:8080/);
    assert.match(wifiOffText({ ...base, ipv4: "" }, true, "192.168.1.50"), /at the hub's wired address/);
    assert.match(wifiOffText(base, false, "192.168.1.50"), /reconnects now/);
  });

  it("checks static settings like the hub (usb_eth_static_ok)", () => {
    const ok = (address, netmask, gateway = "", dns1 = "", dns2 = "") => validateStatic({ address, netmask, gateway, dns1, dns2 });
    assert.equal(ok("192.168.1.20", "255.255.255.0", "192.168.1.1", "1.1.1.1", "8.8.8.8"), null);
    assert.equal(ok("10.0.5.9", "255.0.0.0"), null);
    assert.equal(ok("192.168.1.2", "255.255.255.252", "192.168.1.1"), null);
    for (const [args, field, message] of [
      [["192.168.1.256", "255.255.255.0"], "address", "The address must be four numbers 0-255, like 192.168.1.20."],
      [["192.168.01.2", "255.255.255.0"], "address"],
      [["192.168.1.2 ", "255.255.255.0"], "address"],
      [["", "255.255.255.0"], "address"],
      [["192.168.1.0", "255.255.255.0"], "address", "That's the subnet's network or broadcast address; pick another."],
      [["192.168.1.255", "255.255.255.0"], "address"],
      [["127.0.0.5", "255.0.0.0"], "address", "That address can't be used on a network."],
      [["224.1.1.1", "255.255.255.0"], "address"],
      [["192.168.1.2", ""], "netmask", "The subnet mask must be four numbers 0-255, like 255.255.255.0."],
      [["192.168.1.2", "255.255.0.255"], "netmask", "That isn't a valid subnet mask."],
      [["192.168.1.2", "255.255.255.254"], "netmask", "Use a subnet mask from 255.0.0.0 (/8) to 255.255.255.252 (/30)."],
      [["192.168.1.2", "254.0.0.0"], "netmask"],
      [["192.168.1.2", "0.0.0.0"], "netmask"],
      [["192.168.1.2", "255.255.255.0", "192.168.1.300"], "gateway", "The router address must be four numbers 0-255."],
      [["192.168.1.2", "255.255.255.0", "192.168.2.1"], "gateway", "The router must be on the same subnet as the address."],
      [["192.168.1.2", "255.255.255.0", "192.168.1.2"], "gateway", "The router can't have the hub's own address."],
      [["192.168.1.2", "255.255.255.0", "192.168.1.1", "1.1.1"], "dns1", "A DNS server must be four numbers 0-255."],
      [["192.168.1.2", "255.255.255.0", "192.168.1.1", "", "0.0.0.0"], "dns2"],
    ]) {
      const problem = ok(...args);
      assert.equal(problem?.field, field, JSON.stringify(args));
      if (message) assert.equal(problem.message, message, JSON.stringify(args));
    }
  });

  it("prefills the static form and lists the address details", () => {
    assert.deepEqual(staticFormValues({ ...base, staticConfig: { address: "192.168.1.20", netmask: "255.255.255.0", gateway: "192.168.1.1", dns: ["1.1.1.1"] } }),
      { address: "192.168.1.20", netmask: "255.255.255.0", gateway: "192.168.1.1", dns1: "1.1.1.1", dns2: "" });
    // Nothing saved yet: start from what DHCP gave the cable.
    assert.deepEqual(staticFormValues(base),
      { address: "192.168.1.77", netmask: "255.255.255.0", gateway: "192.168.1.1", dns1: "192.168.1.1", dns2: "" });
    assert.deepEqual(staticFormValues({ ...base, ...notWorking, ipv4: "", netmask: null, router: null, dns: [] }),
      { address: "", netmask: "255.255.255.0", gateway: "", dns1: "", dns2: "" });
    const rows = Object.fromEntries(ethernetDetails({ ...base, ipMode: "static", dns: ["1.1.1.1", "8.8.8.8"] }));
    assert.equal(rows.Address, "192.168.1.77 / 255.255.255.0 (static)");
    assert.equal(rows.DNS, "1.1.1.1, 8.8.8.8");
    assert.match(Object.fromEntries(ethernetDetails(base)).Address, /\(DHCP\)$/);
  });

  it("warns before changing the address a page is open at", () => {
    const v = { address: "192.168.1.30", netmask: "255.255.255.0", gateway: "", dns1: "", dns2: "" };
    assert.match(addressChangeWarning(base, v, "static", "192.168.1.77"), /Open it again at 192\.168\.1\.30:8080/);
    assert.equal(addressChangeWarning(base, { ...v, address: "192.168.1.77" }, "static", "192.168.1.77"), "");
    assert.match(addressChangeWarning(base, v, "dhcp", "192.168.1.77"), /192\.168\.1\.50:8080 \(Wi-Fi\)/);
    assert.equal(addressChangeWarning(base, v, "static", "192.168.1.50"), "");
  });

  it("formats link and traffic", () => {
    assert.equal(formatLink(base), "100 Mb/s, full duplex");
    assert.equal(formatLink({ ...base, fullDuplex: false, speedMbps: 10 }), "10 Mb/s, half duplex");
    assert.equal(formatLink({ ...base, speedMbps: null, fullDuplex: null }), "Link up");
    assert.equal(formatLink({ ...base, carrier: false }), "No link");
    assert.equal(formatTraffic(512), "512 B");
    assert.equal(formatTraffic(1536), "1.5 KB");
    assert.equal(formatTraffic(5 * 1024 * 1024), "5.0 MB");
    assert.equal(formatTraffic(300 * 1024 * 1024), "300 MB");
    assert.equal(formatTraffic(null), "—");
  });

  it("lists only known details", () => {
    const rows = Object.fromEntries(ethernetDetails(base));
    assert.equal(rows.Adapter, "AX88772A (0b95:772a)");
    assert.equal(rows.Interface, "eth0");
    assert.equal(rows.Link, "100 Mb/s, full duplex");
    assert.equal(rows.Address, "192.168.1.77 / 255.255.255.0 (DHCP)");
    assert.equal(rows.Router, "192.168.1.1");
    assert.equal(rows.Traffic, "1.5 KB in · 5.0 MB out");
    assert.equal(rows["Local traffic goes through"], "Ethernet");
    const waiting = Object.fromEntries(ethernetDetails({ ...base, ...notWorking, state: "awaiting_carrier_dhcp", ipv4: "", netmask: null, router: null, lanInterface: "ath0" }));
    assert.equal(waiting.Address, undefined);
    assert.equal(waiting.Router, undefined);
    assert.equal(waiting["Local traffic goes through"], "Wi-Fi");
    assert.deepEqual(ethernetDetails(null), []);
  });

  it("polls only while coming up or waiting for Wi-Fi to go off", () => {
    assert.equal(pollDelay(base), 0);
    assert.equal(pollDelay({ ...base, ...notWorking, state: "starting", reason: "phy_wait" }), 4000);
    assert.equal(pollDelay({ ...base, ...notWorking, state: "awaiting_carrier_dhcp", reason: "no_carrier" }), 4000);
    assert.equal(pollDelay({ ...base, ...notWorking, state: "awaiting_carrier_dhcp", reason: "gateway_check" }), 4000);
    assert.equal(pollDelay({ ...base, wifiOff: true }), 15000);
    assert.equal(pollDelay({ ...base, wifiOff: true, wifiSuspended: true }), 0);
    assert.equal(pollDelay({ ...base, wifiOff: true, wifiNeedsRestart: true }), 0);
    assert.equal(pollDelay({ ...base, ...notWorking, state: "adapter_absent" }), 0); // the service stopped looking
    assert.equal(pollDelay({ ...base, ...notWorking, state: "failed", reason: "static_invalid" }), 0);
    assert.equal(pollDelay({ ...base, enabled: false }), 0);
    assert.equal(pollDelay(null), 0);
  });

  it("offers Try again where the service stopped, and on only where it can run", () => {
    for (const [state, reason] of [["failed", "phy_not_ready"], ["adapter_absent", "no_usb_device"], ["adapter_unsupported", ""], ["stopped", ""], ["bus_ready", ""]]) {
      assert.equal(canRetry({ ...base, ...notWorking, state, reason }), true, state);
    }
    for (const [state, reason] of [["failed", "static_invalid"], ["starting", "phy_wait"], ["awaiting_carrier_dhcp", "no_carrier"], ["gateway_unreachable", "gateway_lost"]]) {
      assert.equal(canRetry({ ...base, ...notWorking, state, reason }), false, state);
    }
    assert.equal(canRetry(base), false);
    assert.equal(canRetry({ ...base, ...notWorking, enabled: false, state: "bus_ready" }), false);
    assert.equal(canEnable(base), true);
    assert.equal(canEnable({ ...base, supported: false }), false);
    assert.equal(canEnable(null), false);
  });
});
