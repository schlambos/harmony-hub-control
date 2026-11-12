/* The Wired Ethernet page's network overview (GET /api/network-overview):
   Wi-Fi, the adapter, the routing table and DNS, in words. Pure functions,
   so test/network-model.test.mjs can check them. */

import { formatTraffic } from "./ethernet-model.js";

// 2.4 GHz channels 1-14 and 5 GHz channels from the frequency in GHz.
export function wifiChannel(frequencyGhz) {
  const mhz = Math.round(Number(frequencyGhz) * 1000);
  if (!Number.isFinite(mhz) || mhz <= 0) return null;
  if (mhz === 2484) return 14;
  if (mhz >= 2412 && mhz <= 2472) return (mhz - 2407) / 5;
  if (mhz >= 5000 && mhz <= 5900) return (mhz - 5000) / 5;
  return null;
}

// The usual rules of thumb for Wi-Fi signal strength.
export function signalLabel(dbm) {
  if (typeof dbm !== "number") return "";
  if (dbm >= -55) return "excellent";
  if (dbm >= -67) return "good";
  if (dbm >= -75) return "fair";
  return "weak";
}

export function wifiStateLabel(wifi) {
  if (!wifi) return "Not available";
  if (wifi.suspended) return "Off while the cable works";
  switch (wifi.state) {
    case "COMPLETED": return "Connected";
    case "DISCONNECTED": return "Disconnected";
    case "INACTIVE": return "Not connecting";
    case "SCANNING": return "Looking for the network";
    case "AUTHENTICATING":
    case "ASSOCIATING":
    case "ASSOCIATED":
    case "4WAY_HANDSHAKE":
    case "GROUP_HANDSHAKE": return "Connecting";
    default: return wifi.state ? wifi.state : "Unknown";
  }
}

// 255.255.255.0 -> 24; null if it isn't a contiguous mask.
export function prefixLength(netmask) {
  const parts = String(netmask ?? "").split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return null;
  const bits = parts.map((p) => p.toString(2).padStart(8, "0")).join("");
  return /^1*0*$/.test(bits) ? bits.indexOf("0") === -1 ? 32 : bits.indexOf("0") : null;
}

export function routeTarget(route) {
  if (route.destination === "0.0.0.0" && route.netmask === "0.0.0.0") return "Default";
  const prefix = prefixLength(route.netmask);
  return prefix === null ? `${route.destination} / ${route.netmask}` : `${route.destination}/${prefix}`;
}

const PRIVATE = new Set(["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"]);

/* What a route is for, given the interfaces' own subnets. */
export function routeLabel(route, overview) {
  const target = routeTarget(route);
  if (target === "Default") return "Internet (default route)";
  if (target === "224.0.0.0/4") return "Multicast (device discovery)";
  if (route.netmask === "255.255.255.255") return "One host (e.g. a time server during a clock sync)";
  if (route.gateway === "0.0.0.0") {
    const own = [overview?.wifi, overview?.wired].find((i) => i?.interface === route.interface);
    return own ? "This network (directly connected)" : "Directly connected";
  }
  if (PRIVATE.has(target)) {
    return overview?.cloudBlocker
      ? "Other private networks, through the router (the cloud blocker keeps the internet out)"
      : "Other private networks, through the router";
  }
  return "Through the router";
}

/* Each route with its words and its standing: of routes to the same place,
   the lowest metric is the one used, the rest are fallbacks. */
export function routeRows(overview) {
  const routes = Array.isArray(overview?.routes) ? overview.routes : [];
  return routes.map((route) => {
    const same = routes.filter((r) => r.destination === route.destination && r.netmask === route.netmask);
    const best = Math.min(...same.map((r) => (typeof r.metric === "number" ? r.metric : 0)));
    const metric = typeof route.metric === "number" ? route.metric : 0;
    const standing = same.length < 2 ? "" : metric === best ? "used" : "fallback";
    const via = route.gateway && route.gateway !== "0.0.0.0" ? `via ${route.gateway}` : "on link";
    const kind = interfaceKind(route.interface, overview);
    return {
      title: routeTarget(route),
      subtitle: [routeLabel(route, overview), `${via} · ${route.interface}${kind ? ` (${kind})` : ""} · metric ${metric}${standing ? `, ${standing}` : ""}`].join("\n"),
      standing,
    };
  });
}

export function interfaceKind(name, overview) {
  if (overview?.wifi?.interface === name) return "Wi-Fi";
  if (overview?.wired?.interface === name) return "Ethernet";
  return "";
}

// The metric of an interface's own subnet route: lower is preferred.
function subnetMetric(iface, overview) {
  const route = (overview?.routes ?? []).find((r) => r.interface === iface?.interface && r.gateway === "0.0.0.0" && r.destination !== "224.0.0.0" && r.netmask !== "255.255.255.255");
  return typeof route?.metric === "number" ? route.metric : null;
}

function priorityText(iface, overview) {
  if (!iface?.ip) return "";
  const metric = subnetMetric(iface, overview);
  const carries = overview?.lanInterface === iface.interface;
  if (metric === null) return carries ? "Carries local traffic" : "";
  return `${carries ? "Preferred: carries local traffic" : "Fallback"} (metric ${metric})`;
}

function addressText(iface) {
  if (!iface?.ip) return "No address";
  const prefix = prefixLength(iface.netmask);
  return prefix === null ? iface.ip : `${iface.ip}/${prefix} (mask ${iface.netmask})`;
}

function trafficText(iface) {
  const errors = (iface.rxErrors ?? 0) + (iface.txErrors ?? 0);
  return `${formatTraffic(iface.rxBytes)} in · ${formatTraffic(iface.txBytes)} out${errors ? ` · ${errors} error${errors === 1 ? "" : "s"}` : ""}`;
}

/* [label, value] rows for the Wi-Fi card. */
export function wifiRows(overview) {
  const w = overview?.wifi;
  if (!w) return [["Wi-Fi", "Not available"]];
  const rows = [["State", wifiStateLabel(w)]];
  if (w.ssid) rows.push(["Network (SSID)", w.ssid]);
  if (w.bssid) rows.push(["Access point", w.bssid.toUpperCase()]);
  if (w.state === "COMPLETED") {
    if (typeof w.signalDbm === "number") {
      const quality = /^(\d+)\/(\d+)$/.exec(w.quality ?? "");
      const pct = quality && Number(quality[2]) > 0 ? ` · quality ${Math.round((100 * Number(quality[1])) / Number(quality[2]))}%` : "";
      rows.push(["Signal", `${w.signalDbm} dBm (${signalLabel(w.signalDbm)})${pct}`]);
    }
    if (typeof w.noiseDbm === "number") {
      const snr = typeof w.signalDbm === "number" ? ` · signal-to-noise ${w.signalDbm - w.noiseDbm} dB` : "";
      rows.push(["Noise", `${w.noiseDbm} dBm${snr}`]);
    }
    if (w.bitRate) rows.push(["Rate", w.bitRate]);
    const channel = wifiChannel(w.frequencyGhz);
    if (w.frequencyGhz) rows.push(["Channel", `${channel ?? "?"} (${w.frequencyGhz} GHz)${w.standard ? ` · ${w.standard}` : ""}`]);
  }
  if (w.security) rows.push(["Security", w.cipher ? `${w.security} (${w.cipher})` : w.security]);
  if (typeof w.txPowerDbm === "number") rows.push(["Transmit power", `${w.txPowerDbm} dBm`]);
  rows.push(["Address", addressText(w)]);
  const priority = priorityText(w, overview);
  if (priority) rows.push(["Priority", priority]);
  if (w.mac) rows.push(["MAC address", w.mac.toUpperCase()]);
  rows.push(["Traffic", trafficText(w)]);
  return rows;
}

/* [label, value] rows for the Ethernet card. */
export function wiredRows(overview) {
  const e = overview?.wired;
  if (!e) return [["Ethernet", "No adapter"]];
  const rows = [["Interface", e.interface]];
  // carrier: the cable's link ("up" is only the interface's flag). Hubs
  // that don't report it show the flag, as before.
  rows.push(["Link", !e.up ? "Down" : e.carrier === false ? "No link (check the cable)" : e.speedMbps ? `${e.speedMbps} Mb/s${e.fullDuplex ? ", full duplex" : e.fullDuplex === false ? ", half duplex" : ""}` : "Up"]);
  rows.push(["Address", `${addressText(e)}${e.ip ? ` · ${e.mode === "static" ? "static" : "DHCP"}` : ""}`]);
  const priority = priorityText(e, overview);
  if (priority) rows.push(["Priority", priority]);
  if (e.mac) rows.push(["MAC address", e.mac.toUpperCase()]);
  rows.push(["Traffic", trafficText(e)]);
  return rows;
}

/* [label, value] rows for what ties them together. */
export function summaryRows(overview) {
  if (!overview) return [];
  const lan = overview.lanInterface;
  const kind = interfaceKind(lan, overview);
  return [
    ["Local traffic goes through", lan ? `${kind || lan}${kind ? ` (${lan})` : ""}` : "—"],
    ["Router (gateway)", overview.gateway || "Unknown"],
    ["DNS servers", overview.dns?.length ? overview.dns.join(", ") : "None"],
    ["Internet", overview.cloudBlocker ? "Blocked by the cloud blocker (no default route)" : "Allowed (default route through the router)"],
  ];
}
