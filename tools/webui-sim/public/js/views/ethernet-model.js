/* Wired Ethernet through a self-powered OTG USB adapter (docs/USB_ETHERNET.md):
   what the hub's GET /api/usb-eth answer means for a person. Pure functions,
   so test/ethernet-model.test.mjs can check every state. The Settings row's
   one-line status is usbEthStatus() in remotes-model.js.

   `state` is the service's (starting, operational, failed + reason,
   degraded_routing, adapter_absent, adapter_unsupported,
   awaiting_carrier_dhcp + reason, gateway_unreachable, stopped), or, while
   the service hasn't written one, the helper's (platform_absent,
   platform_unbound, deps_unavailable, bus_ready, nic_not_bound, ...).
   "operational" with lanInterface === ifname: the cable carries local
   traffic; with separateNetwork: it's only an extra address. */

const SUPPORTED_KERNEL = "2.6.31-g89d565c";

function adapterName(status) {
  if (!status?.usbDevice) return "";
  return status.usbProduct ? `${status.usbProduct}, ${status.usbDevice}` : status.usbDevice;
}

// The cable carries the hub's local traffic now.
export function cableCarriesLan(status) {
  return Boolean(status?.operational && status.ifname && status.lanInterface === status.ifname);
}

/* Why a failed start failed, in words: a title and what to do. */
const FAILED = {
  static_invalid: ["Static address settings need fixing",
    "The cable has a link, but the saved static address settings aren't valid, so it has no address. Fix them below, or switch to automatic (DHCP)."],
  phy_not_ready: ["USB port didn't switch to host mode",
    "The hub couldn't switch its micro-USB port to host mode. Check that the adapter has its own power, then try again. If it keeps failing, unplug the hub's power and plug it back in."],
  deps_timeout: ["USB drivers didn't load",
    "The hub's USB drivers didn't load in time. Try again; if it keeps failing, restart the hub."],
  controller_registered_unbound: ["USB controller didn't start",
    "The hub's USB controller didn't start. Restart the hub, then try again."],
  kernel_or_slot_check_failed: ["Hub firmware check failed",
    "Before it changes the USB port, the hub checks that its kernel is exactly the build this was made for. That check failed, so nothing was changed."],
  driver_load_failed: ["Adapter driver didn't load",
    "The hub found the adapter but couldn't load its driver. Install Melodious again, then try again."],
  no_network_interface: ["No wired interface appeared",
    "The adapter's driver loaded, but no wired network interface appeared. Unplug the adapter, plug it back in, and try again."],
  worker_stopped: ["Stopped unexpectedly",
    "The part of the hub that watches the cable stopped, so the hub moved local traffic back to Wi-Fi and turned Wi-Fi back on. Try again; if it keeps happening, restart the hub."],
};

const STARTING = {
  phy_wait: "Switching the hub's micro-USB port to host mode.",
  controller_wait: "Starting the USB controller.",
  adapter_wait: "Looking for the adapter. If it isn't connected yet, connect it now: the hub looks for about a minute.",
};

/* The status card: a title, a sentence on what's going on or what to do,
   and a tone (live | warn | dim). */
export function ethernetState(status) {
  if (status === null) {
    return { tone: "warn", title: "Couldn't read the wired network status", detail: "Check that the hub is reachable, then refresh." };
  }
  if (!status.supported) {
    if (!status.kernel || status.kernel === "unknown") {
      return { tone: "warn", title: "USB Ethernet files missing", detail: "The hub couldn't run its USB Ethernet helper. Install this version of Melodious on it again." };
    }
    return {
      tone: "dim",
      title: "Not available on this hub",
      detail: `Wired Ethernet is built for hub firmware 4.15.600 (kernel ${SUPPORTED_KERNEL}). This hub runs kernel ${status.kernel}.`,
    };
  }
  if (!status.enabled) {
    const dev = adapterName(status);
    return { tone: "dim", title: "Off", detail: dev ? `The hub uses Wi-Fi only. It sees a USB device (${dev}).` : "The hub uses Wi-Fi only." };
  }
  const ip = status.ipv4 || "";
  if (status.operational) {
    if (status.separateNetwork) {
      return {
        tone: "live",
        title: "Connected by cable, on another network",
        detail: `The hub is also at ${ip}, but that network isn't the one its gateway is on, so local traffic stays on Wi-Fi. Connect the cable to the same network as Wi-Fi to use it for everything.`,
      };
    }
    if (status.wifiSuspended) {
      return {
        tone: "live",
        title: "Connected by cable · Wi-Fi off",
        detail: `The hub is at ${ip} on the wired network, and Wi-Fi is off. If the cable stops working, Wi-Fi comes back by itself within about a minute; it also comes back after any restart.`,
      };
    }
    const later = !status.wifiOff ? ""
      : status.wifiOffBlocked === "noRouter" ? ". It stays on: with the cloud blocker off, Wi-Fi turns off only once the cable has a router for the internet (set one in the address settings, or get one from DHCP)"
        : status.wifiNeedsRestart ? ", and will turn off while the cable works once the hub has restarted"
          : ", and turns off once the cable has worked for a minute";
    return {
      tone: "live",
      title: "Connected by cable",
      detail: `The hub is at ${ip} on the wired network and sends local traffic through it. Wi-Fi stays connected as a fallback${later}.`,
    };
  }
  switch (status.state) {
    case "gateway_unreachable":
      return {
        tone: "warn",
        title: "Connected by cable · router not answering",
        detail: `The cable has a link${ip ? ` and the address ${ip}` : ""}, but your router isn't answering through it, so local traffic stays on Wi-Fi. The hub tries the cable again in about 10 minutes. Many receive errors under Network overview point to the adapter or its driver.`,
      };
    case "awaiting_carrier_dhcp":
      if (status.reason === "gateway_check") {
        return { tone: "dim", title: "Checking the router", detail: `The cable has the address ${ip || "it was given"}. The hub checks that your router answers through it before sending local traffic there.` };
      }
      if (!status.carrier) {
        return { tone: "warn", title: "No cable link", detail: "The adapter is working, but there's no Ethernet link. Check the cable and the switch or router port." };
      }
      return status.ipMode === "static"
        ? { tone: "dim", title: "Setting the address", detail: "The cable has a link. The hub is setting its static address." }
        : { tone: "warn", title: "Getting an address", detail: "The cable has a link. The hub is asking your router for an address." };
    case "starting":
      return { tone: "dim", title: "Starting", detail: STARTING[status.reason] ?? "Loading the drivers." };
    case "failed": {
      const [title, detail] = FAILED[status.reason] ?? [
        "Not working",
        `The hub stopped trying${status.reason ? ` (${status.reason.replaceAll("_", " ")})` : ""}. Try again; if it keeps failing, restart the hub.`,
      ];
      return { tone: "warn", title, detail };
    }
    case "degraded_routing":
      if (status.reason === "prefix_mismatch") {
        return {
          tone: "warn",
          title: "Connected by cable · subnet mask differs from Wi-Fi's",
          detail: `The cable's address ${ip || ""}${status.netmask ? ` (mask ${status.netmask})` : ""} is on Wi-Fi's network, but with a different subnet mask. The hub can't move local traffic to the cable then, so it stays on Wi-Fi, and Wi-Fi stays on. Give the cable the same subnet mask as Wi-Fi.`,
        };
      }
      return {
        tone: "warn",
        title: "Connected, but routing isn't set up",
        detail: `The cable has the address ${ip || "it was given"}, but the hub couldn't set up its routes, so replies may not go out through the cable. Turn this off and on again.`,
      };
    case "adapter_absent":
      if (status.reason === "interface_gone") {
        return { tone: "warn", title: "Adapter disconnected", detail: "The wired interface went away: the adapter was unplugged or lost its power. Plug it back in, then try again." };
      }
      return { tone: "warn", title: "No adapter found", detail: "The hub looked for about a minute and found no adapter. Connect a self-powered OTG Ethernet adapter, with its power plugged in, then try again." };
    case "bus_ready":
      return { tone: "warn", title: "No adapter found", detail: "The USB port is in host mode, but no adapter is connected. Connect one, with its power plugged in, then try again." };
    case "adapter_unsupported":
      return {
        tone: "warn",
        title: "Adapter not supported",
        detail: `The hub sees a USB device (${adapterName(status) || "unknown"}) but has no driver for it. docs/USB_ETHERNET.md lists the supported chipsets.`,
      };
    case "nic_not_bound":
      return { tone: "dim", title: "Adapter found", detail: "Loading its driver." };
    case "stopped":
      return { tone: "dim", title: "Stopped", detail: "The switch is on, but the hub isn't running USB Ethernet now. Try again to start it." };
    case "platform_absent":
    case "platform_unbound":
    case "deps_unavailable":
      return { tone: "dim", title: "Not started yet", detail: "The hub hasn't switched its micro-USB port to host mode yet. If this doesn't change within a minute, try again." };
    default:
      return { tone: "warn", title: "Unknown state", detail: `The hub reported "${status.state || "nothing"}".` };
  }
}

/* States where the hub has stopped trying and starting again (POST
   { enabled: true }) may help: the "Try again" button. */
const RETRY_STATES = ["failed", "adapter_absent", "adapter_unsupported", "bus_ready", "stopped", "platform_absent", "platform_unbound", "deps_unavailable"];

export function canRetry(status) {
  if (!status?.enabled || !status.supported || status.operational) return false;
  if (status.state === "failed" && status.reason === "static_invalid") return false; // fix the form instead
  return RETRY_STATES.includes(status.state);
}

export function formatLink(status) {
  if (!status?.carrier) return "No link";
  if (!status.speedMbps) return "Link up";
  return `${status.speedMbps} Mb/s${status.fullDuplex === true ? ", full duplex" : status.fullDuplex === false ? ", half duplex" : ""}`;
}

export function formatTraffic(bytes) {
  if (typeof bytes !== "number" || !Number.isFinite(bytes)) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/* Detail rows for the card: [label, value], only what's known. */
export function ethernetDetails(status) {
  if (!status) return [];
  const rows = [];
  if (status.usbDevice) rows.push(["Adapter", `${status.usbProduct || "USB device"} (${status.usbDevice})`]);
  if (status.ifname) {
    rows.push(["Interface", status.ifname]);
    rows.push(["Link", formatLink(status)]);
  }
  if (status.ipv4) {
    const how = status.ipMode === "static" ? " (static)" : " (DHCP)";
    rows.push(["Address", `${status.netmask ? `${status.ipv4} / ${status.netmask}` : status.ipv4}${how}`]);
    if (status.router) rows.push(["Router", status.router]);
    if (Array.isArray(status.dns) && status.dns.length) rows.push(["DNS", status.dns.join(", ")]);
  }
  if (status.wifiIp) rows.push(["Wi-Fi address", status.wifiIp]);
  if (status.enabled) {
    rows.push(["Wi-Fi", status.wifiSuspended ? "Off while the cable works"
      : status.wifiOff && status.wifiOffBlocked === "noRouter" ? "On (stays on: the cable has no router for the internet)"
      : status.wifiOff && status.wifiNeedsRestart ? "On (turns off while the cable works after the hub restarts)"
        : status.wifiOff ? "On (turns off while the cable works)" : "On"]);
  }
  if (typeof status.rxBytes === "number" || typeof status.txBytes === "number") {
    rows.push(["Traffic", `${formatTraffic(status.rxBytes)} in · ${formatTraffic(status.txBytes)} out`]);
  }
  if (status.lanInterface) {
    rows.push(["Local traffic goes through", status.ifname && status.lanInterface === status.ifname ? "Ethernet" : "Wi-Fi"]);
  }
  return rows;
}

/* While on and not yet working, the page re-reads the status so the person
   sees each step (controller, adapter, link, address) without refreshing,
   and, with Wi-Fi off chosen, until Wi-Fi has gone off. 0 means don't poll
   (each read runs a script on the hub); the network overview has its own,
   slower timer. */
export function pollDelay(status) {
  if (!status?.enabled || !status.supported) return 0;
  if (["starting", "awaiting_carrier_dhcp", "nic_not_bound"].includes(status.state)) return 4000;
  if (cableCarriesLan(status) && status.wifiOff && !status.wifiSuspended && !status.wifiNeedsRestart && !status.wifiOffBlocked) return 15000;
  return 0;
}

/* Text for the "turn on" dialog (here and in Settings). */
export function turnOnText() {
  return "Experimental. Needs a self-powered OTG micro-USB Ethernet adapter with a supported chipset (see docs/USB_ETHERNET.md): the hub's micro-USB port can't power it. The hub switches that port to host mode, loads the adapter's driver and gets a wired address (DHCP, or a static address set on the Wired Ethernet page). Once your router answers through the cable, local traffic goes through it; Wi-Fi stays connected. While host mode is active, the micro-USB port can't be used as a USB device port until the hub restarts with Ethernet off. The hub doesn't restart now.";
}

/* Text for the "turn off" dialog. A browser connected through the cable
   loses the page when the wired address goes, so say where to reopen it. */
export function turnOffText(status, pageHost) {
  const base = `The hub releases the wired address and goes back to Wi-Fi only${status?.wifiSuspended ? ", reconnecting Wi-Fi first" : ""}. The hub doesn't restart.`;
  if (status?.ipv4 && pageHost === status.ipv4) {
    const where = status.wifiIp ? ` Open it again at ${status.wifiIp}:8080 afterwards.` : " Open it again at the hub's Wi-Fi address afterwards.";
    return `${base} You're connected through the cable, so this page will stop answering.${where}`;
  }
  return `${base} Anything that reaches the hub at its wired address, such as Home Assistant, will need its Wi-Fi address instead.`;
}

/* Text for the "Wi-Fi off while the cable works" dialogs. Turning it on from
   a page opened over Wi-Fi loses the page once Wi-Fi goes, so say where to
   reopen it. */
export function wifiOffText(status, turningOn, pageHost) {
  if (!turningOn) {
    return "Wi-Fi reconnects now and stays on next to the cable. The hub doesn't restart.";
  }
  const base = "Once the cable has worked for a minute and your router answers through it, the hub turns Wi-Fi off. While it's off the hub is reachable only at its wired address, so point Home Assistant and anything else there first. If the cable stops working, Wi-Fi comes back by itself within about a minute, and it always comes back after a restart.";
  if (pageHost && status?.wifiIp && pageHost === status.wifiIp) {
    const where = status.ipv4 ? ` Open it again at ${status.ipv4}:8080.` : " Open it again at the hub's wired address.";
    return `${base} You're connected over Wi-Fi, so this page will stop answering when Wi-Fi turns off.${where}`;
  }
  return base;
}

/* Static address settings, checked the way the hub checks them
   (codex_webui's usb_eth_static_ok, with the same messages): null if
   fine, else { field, message }. */
function ipv4(text) {
  const s = String(text ?? "");
  if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(s)) return null;
  const parts = s.split(".");
  if (parts.some((p) => (p.length > 1 && p[0] === "0") || Number(p) > 255)) return null;
  return parts.reduce((v, p) => v * 256 + Number(p), 0);
}

export function validateStatic({ address = "", netmask = "", gateway = "", dns1 = "", dns2 = "" } = {}) {
  const a = ipv4(address);
  if (a === null) return { field: "address", message: "The address must be four numbers 0-255, like 192.168.1.20." };
  const m = ipv4(netmask);
  if (m === null) return { field: "netmask", message: "The subnet mask must be four numbers 0-255, like 255.255.255.0." };
  const host = 4294967295 - m;
  const bits = Math.round(Math.log2(host + 1));
  if (2 ** bits !== host + 1) return { field: "netmask", message: "That isn't a valid subnet mask." };
  if (bits < 2 || bits > 24) return { field: "netmask", message: "Use a subnet mask from 255.0.0.0 (/8) to 255.255.255.252 (/30)." };
  const net = a - (a % (host + 1));
  const first = Math.floor(a / 16777216);
  if (first === 0 || first === 127 || first >= 224) return { field: "address", message: "That address can't be used on a network." };
  if (a === net || a === net + host) return { field: "address", message: "That's the subnet's network or broadcast address; pick another." };
  if (gateway) {
    const g = ipv4(gateway);
    if (g === null) return { field: "gateway", message: "The router address must be four numbers 0-255." };
    if (g - (g % (host + 1)) !== net || g === net || g === net + host) return { field: "gateway", message: "The router must be on the same subnet as the address." };
    if (g === a) return { field: "gateway", message: "The router can't have the hub's own address." };
  }
  for (const [field, value] of [["dns1", dns1], ["dns2", dns2]]) {
    if (!value) continue;
    const d = ipv4(value);
    if (d === null || d === 0) return { field, message: "A DNS server must be four numbers 0-255." };
  }
  return null;
}

/* What the static form starts with: the saved static settings, or else the
   address the cable has now (from DHCP), as a starting point. */
export function staticFormValues(status) {
  const saved = status?.staticConfig ?? {};
  if (saved.address) {
    return { address: saved.address, netmask: saved.netmask ?? "", gateway: saved.gateway ?? "",
      dns1: saved.dns?.[0] ?? "", dns2: saved.dns?.[1] ?? "" };
  }
  return { address: status?.ipv4 || "", netmask: status?.netmask || "255.255.255.0", gateway: status?.router || "",
    dns1: status?.dns?.[0] ?? "", dns2: status?.dns?.[1] ?? "" };
}

/* A warning for saving new address settings from a page opened at the
   cable's current address, which goes away. Empty when there's nothing to say. */
export function addressChangeWarning(status, values, mode, pageHost) {
  if (!status?.ipv4 || pageHost !== status.ipv4) return "";
  if (mode === "static" && values.address === status.ipv4) return "";
  const where = mode === "static" ? `${values.address}:8080` : status.wifiIp ? `${status.wifiIp}:8080 (Wi-Fi) or the cable's new address` : "the cable's new address";
  return `You're connected through the cable's current address, which changes now, so this page will stop answering. Open it again at ${where}.`;
}

// The switch can be turned on only on the kernel the drivers were built for.
export function canEnable(status) {
  return Boolean(status?.supported);
}
