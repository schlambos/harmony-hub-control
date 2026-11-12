// The Wired Ethernet page's network overview, in words (views/network-model.js).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  prefixLength, routeLabel, routeRows, routeTarget, signalLabel, summaryRows, wifiChannel, wifiRows, wifiStateLabel, wiredRows,
} from "../public/js/views/network-model.js";

// The shape a hub answers with: Wi-Fi as a 4.15.600 hub reported it, plus an adapter carrying local traffic.
const overview = {
  ok: true, available: true,
  wifi: {
    interface: "ath0", ip: "192.168.1.50", netmask: "255.255.255.0", mac: "00:04:20:00:00:01", up: true,
    rxBytes: 18247694, txBytes: 6943236, rxErrors: 0, txErrors: 0, ssid: "Home", state: "COMPLETED",
    bssid: "00:11:22:aa:bb:cc", security: "WPA2-PSK", cipher: "CCMP", standard: "802.11ng", frequencyGhz: "2.412",
    bitRate: "72.2 Mb/s", quality: "82/94", signalDbm: -66, noiseDbm: -95, txPowerDbm: 11, suspended: false,
  },
  wired: {
    interface: "eth2", ip: "192.168.1.77", netmask: "255.255.255.0", mac: "02:00:00:aa:bb:cc", up: true,
    rxBytes: 1234, txBytes: 5678, rxErrors: 0, txErrors: 1, speedMbps: 100, fullDuplex: true, mode: "dhcp",
  },
  routes: [
    { destination: "192.168.1.0", gateway: "0.0.0.0", netmask: "255.255.255.0", flags: "U", metric: 0, interface: "eth2" },
    { destination: "192.168.1.0", gateway: "0.0.0.0", netmask: "255.255.255.0", flags: "U", metric: 10, interface: "ath0" },
    { destination: "10.0.0.0", gateway: "192.168.1.1", netmask: "255.0.0.0", flags: "UG", metric: 0, interface: "eth2" },
    { destination: "224.0.0.0", gateway: "0.0.0.0", netmask: "240.0.0.0", flags: "U", metric: 0, interface: "eth2" },
    { destination: "0.0.0.0", gateway: "192.168.1.1", netmask: "0.0.0.0", flags: "UG", metric: 0, interface: "eth2" },
    { destination: "142.250.1.1", gateway: "192.168.1.1", netmask: "255.255.255.255", flags: "UGH", metric: 0, interface: "eth2" },
  ],
  dns: ["192.168.1.1"], lanInterface: "eth2", gateway: "192.168.1.1", cloudBlocker: true,
};

describe("network overview model", () => {
  it("reads channels, signal and prefixes", () => {
    assert.equal(wifiChannel("2.412"), 1);
    assert.equal(wifiChannel("2.437"), 6);
    assert.equal(wifiChannel("2.484"), 14);
    assert.equal(wifiChannel("5.18"), 36);
    assert.equal(wifiChannel(""), null);
    assert.deepEqual([-50, -60, -70, -80].map(signalLabel), ["excellent", "good", "fair", "weak"]);
    assert.equal(prefixLength("255.255.255.0"), 24);
    assert.equal(prefixLength("255.240.0.0"), 12);
    assert.equal(prefixLength("255.255.255.255"), 32);
    assert.equal(prefixLength("255.0.255.0"), null);
  });

  it("names routes and says which of two is used", () => {
    assert.equal(routeTarget(overview.routes[4]), "Default");
    assert.equal(routeTarget(overview.routes[2]), "10.0.0.0/8");
    assert.match(routeLabel(overview.routes[0], overview), /This network/);
    assert.match(routeLabel(overview.routes[2], overview), /private networks.*cloud blocker/);
    assert.match(routeLabel(overview.routes[3], overview), /Multicast/);
    assert.match(routeLabel(overview.routes[4], overview), /default route/);
    assert.match(routeLabel(overview.routes[5], overview), /One host/);
    const rows = routeRows(overview);
    assert.equal(rows[0].standing, "used");
    assert.equal(rows[1].standing, "fallback");
    assert.equal(rows[2].standing, "");
    assert.match(rows[0].subtitle, /on link · eth2 \(Ethernet\) · metric 0, used/);
    assert.match(rows[1].subtitle, /ath0 \(Wi-Fi\) · metric 10, fallback/);
    assert.match(rows[2].subtitle, /via 192\.168\.1\.1/);
  });

  it("describes Wi-Fi like the hub reports it", () => {
    const rows = Object.fromEntries(wifiRows(overview));
    assert.equal(rows.State, "Connected");
    assert.equal(rows["Network (SSID)"], "Home");
    assert.equal(rows["Access point"], "00:11:22:AA:BB:CC");
    assert.equal(rows.Signal, "-66 dBm (good) · quality 87%");
    assert.equal(rows.Noise, "-95 dBm · signal-to-noise 29 dB");
    assert.equal(rows.Rate, "72.2 Mb/s");
    assert.equal(rows.Channel, "1 (2.412 GHz) · 802.11ng");
    assert.equal(rows.Security, "WPA2-PSK (CCMP)");
    assert.equal(rows["Transmit power"], "11 dBm");
    assert.equal(rows.Address, "192.168.1.50/24 (mask 255.255.255.0)");
    assert.equal(rows.Priority, "Fallback (metric 10)");
    assert.equal(rows.Traffic, "17 MB in · 6.6 MB out");
    // Off while the cable works: no radio details for a disconnected Wi-Fi.
    const off = Object.fromEntries(wifiRows({ ...overview, wifi: { ...overview.wifi, state: "DISCONNECTED", suspended: true } }));
    assert.equal(off.State, "Off while the cable works");
    assert.equal(off.Signal, undefined);
    assert.equal(wifiStateLabel({ state: "SCANNING" }), "Looking for the network");
    assert.deepEqual(wifiRows({}), [["Wi-Fi", "Not available"]]);
  });

  it("describes the adapter and what ties them together", () => {
    const rows = Object.fromEntries(wiredRows(overview));
    assert.equal(rows.Link, "100 Mb/s, full duplex");
    // Unplugged: the interface stays up, and a retained speed isn't a link.
    const unplugged = Object.fromEntries(wiredRows({ ...overview, wired: { ...overview.wired, carrier: false } }));
    assert.equal(unplugged.Link, "No link (check the cable)");
    assert.equal(Object.fromEntries(wiredRows({ ...overview, wired: { ...overview.wired, up: false } })).Link, "Down");
    assert.equal(rows.Address, "192.168.1.77/24 (mask 255.255.255.0) · DHCP");
    assert.equal(rows.Priority, "Preferred: carries local traffic (metric 0)");
    assert.equal(rows["MAC address"], "02:00:00:AA:BB:CC");
    assert.equal(rows.Traffic, "1.2 KB in · 5.5 KB out · 1 error");
    assert.deepEqual(wiredRows({ wired: null }), [["Ethernet", "No adapter"]]);
    const summary = Object.fromEntries(summaryRows(overview));
    assert.equal(summary["Local traffic goes through"], "Ethernet (eth2)");
    assert.equal(summary["DNS servers"], "192.168.1.1");
    assert.match(summary.Internet, /Blocked by the cloud blocker/);
    assert.match(Object.fromEntries(summaryRows({ ...overview, cloudBlocker: false })).Internet, /Allowed/);
  });
});
