# USB Ethernet (LAN over USB)

The Harmony Hub can use a **self-powered OTG micro-USB Ethernet adapter** for a
wired LAN connection alongside Wi-Fi. Melodious switches the AR9330 (Hornet) SoC's USB
controller into host mode, binds the stock kernel's dormant `ar7240-ehci`
platform device, loads the matching Linux kernel driver from
`/data/codex/modules/usb-net/`, disables hardware TX/RX checksum offload, and
starts `udhcpc` on the wired interface (or applies a static address). Once the
LAN's router answers through the cable, the cable carries the hub's local
traffic, and Wi-Fi stays connected as the fallback, or can be turned off while
the cable works. The stock kernel and `/lib/modules/` are never modified.

## Hardware requirement: self-powered OTG adapter (critical)

**The Harmony Hub's micro-USB port cannot supply 5 V VBUS power to an adapter.**
A plain passive micro-USB-to-Ethernet dongle will not power up.

You must use an **OTG micro-USB Ethernet adapter with an external power leg**
(often sold as a "Micro-USB OTG Ethernet adapter with power" for Fire TV Sticks
or Chromecast):

1. **Micro-USB male plug** → into the Harmony Hub's micro-USB port.
2. **USB-A power input cable / micro-USB power port on the splitter** → into a
   5 V USB power brick (this powers both the hub and the Ethernet adapter).
3. **RJ-45 Ethernet jack** → into your LAN switch or router.

### Supported Ethernet chipsets

The service detects the attached adapter (`codex_usbeth status` →
`usb_driver=`) and loads either the standalone `r8152` driver or `usbnet.ko`
plus the matching minidriver. **Validation levels differ per chipset and are
stated plainly below.** No chipset is currently claimed traffic-tested:
the Realtek adapter binds on hub hardware, but the traffic evidence
behind the earlier claim was retracted (see the note under the table).
The ASIX and CDC drivers are built from GPL kernel source and fully
import-audited against the hub kernel, but they have not been
traffic-tested (the maintainer's only adapter is Realtek), and no inert
load test has been run for them yet.

| Driver | Chipsets / match | Validation |
| --- | --- | --- |
| `r8152.ko` | Realtek RTL8152B (`0bda:8152`), RTL8153 (`0bda:8153`, USB 2.0 High-Speed on the hub), Samsung (`04e8:a101`) | Driver loads and binds on hardware; **wired-traffic validation pending** (see below) |
| `asix.ko` | ASIX AX88172 / AX88772 / AX88772A / AX88772B/C (`0b95:772b`) / AX88178 + clones (see payload README for the VID:PID list; incl. `05ac:1402` Apple USB Ethernet) | AX88772C (TRENDnet TU2-ET100): **traffic-tested** on hardware with this repo's `usbnet.ko` (counter-verified both directions). Other chipsets built + audited only |
| `ax88179_178a.ko` | ASIX AX88179 (`0b95:1790`), AX88178A (`0b95:178a`), D-Link DUB-1312, Sitecom, Samsung, Lenovo (VID:PID list in payload README) | Built + audited only; traffic test pending hardware |
| `cdc_ether.ko` | CDC-ECM: matched by USB class (Communications 02 / subclass 06), any vendor; plus Ericsson/Toshiba/Dell IDs | Built + audited only; traffic test pending hardware |
| `cdc_ncm.ko` | CDC-NCM: matched by USB class (02 / subclass 0d), any vendor | Built + audited only; traffic test pending hardware |

The class-based CDC match is the broad-coverage path: a CDC-ECM/NCM
class-compliant dongle binds even when its VID:PID is not listed anywhere.
SMSC95xx and other chipsets remain unsupported.

> **Retraction (2026-11-10 health check).** Earlier notes claimed the
> Realtek path was traffic-tested (DHCP, ping, HTTP). Those results do
> not prove wired traffic: both hub addresses ARP-mapped to the Wi-Fi
> MAC, the wired interface's TX counters did not move, and the replies
> travelled over Wi-Fi. They also prove nothing about wired checksum
> correctness, and an idle interface with no packet errors does not
> establish a healthy driver under load. Wired bidirectional traffic
> (counter-verified, both directions) plus a clean boot auto-start are
> the acceptance bar; until that live run passes, no chipset is claimed
> traffic-tested.

## How to enable or disable

### In the web UI

1. Connect the self-powered OTG Ethernet adapter and LAN cable.
2. Open **Settings** → **Experimental** → **Ethernet (USB OTG)** and turn the
   switch **on**.
3. The hub writes `/data/codex/usb_eth.conf` (`ENABLED=1`) and starts the
   USB Ethernet worker, which switches the USB PHY to host mode, loads
   the EHCI driver, binds `ar7240-ehci`, loads the adapter's driver,
   disables checksum offload, and starts `udhcpc`. Starting never blocks
   the web UI or boot: readiness (USB core loaded, a readable PHY
   register, a bound controller, an adapter, a DHCP lease) is awaited
   with bounded retries in the background.
4. The row says `Ethernet + Wi-Fi · eth2 · <ipv4> · <adapter>` only once
   the wired path is **operational** (`Ethernet · Wi-Fi off …` while Wi-Fi is
   off). Its text opens the **Wired Ethernet** page: status, the Wi-Fi-off
   switch, the address settings and a network overview. Enabled is not operational: while
   starting, absent, unsupported, or failed, the row says so, with the
   failure reason (`On, but not working: …`). The same distinction is in
   `GET /api/usb-eth` (`enabled` vs `operational`, plus `state` and
   `reason`).
5. When `ENABLED=1`, `/etc/init.d/rcS.local` starts the same worker
   automatically on every boot.

To disable, turn **Ethernet (USB OTG)** **off** in Settings. The hub writes
`ENABLED=0`, cancels any pending startup worker, stops `udhcpc` on the
wired interface, restores the route/ARP settings the worker changed,
and brings the interface down.

### From the command line or HTTP API

- Status: `/data/codex/usb_eth_service.sh status` (the helper's
  `codex_usbeth status` plus how the cable is used) or `GET /api/usb-eth`
- Enable: `POST /api/usb-eth` with `{"enabled": true}` (same-origin JSON)
- Disable: `POST /api/usb-eth` with `{"enabled": false}` (same-origin JSON)
- Wi-Fi off while the cable works: `{"wifiOff": true}` or `false`
- Address: `{"ipMode": "dhcp"}`, or `{"ipMode": "static", "address": …,
  "netmask": …, "gateway": …, "dns1": …, "dns2": …}`
- Network overview: `/data/codex/usb_eth_service.sh overview` or
  `GET /api/network-overview`

All of these settings live in `/data/codex/usb_eth.conf` as `KEY=value`
lines: `ENABLED`, `WIFI_OFF`, `IP_MODE` (`dhcp`/`static`), `IP_ADDRESS`,
`IP_NETMASK`, `IP_GATEWAY`, `IP_DNS` (up to two, space-separated). The web
app validates what it writes; the worker reads them on every pass (5 s),
so only switching the feature on or off restarts anything.

## Using the cable

While the wired interface has an address on the same network as the hub's
gateway (the router the egress guard saved with the cloud blocker on, or the
default route's with it off), the worker gives it the hub's local traffic.
Only a default route through Wi-Fi, or through the cable once it carries local
traffic, counts for that: the adapter's own DHCP adds one for whatever network
it's plugged into, and with the blocker on the guard removes that too. (On a
hub with no Wi-Fi address at all, the cable's own default route counts.)

1. **Gateway check first.** The gateway must answer a ping sent through the
   cable: a host route for the ping's few seconds, with ARP already strict on
   both interfaces, so the reply can't come back over Wi-Fi. Two misses a pass
   apart keep local traffic on Wi-Fi for 10 minutes (state
   `gateway_unreachable`), then the cable gets another try; a new link tries
   at once. This catches an adapter that sends but hardly receives, which would
   otherwise take the LAN away from a working Wi-Fi. (BusyBox's `ping` accepts
   any echo reply, so another ping running at that moment could pass it; the
   30-second checks below catch a cable that doesn't really work.)
2. **Routes.** `codex_usbeth net-apply` demotes Wi-Fi's subnet route to
   metric 20 (see "Two interfaces, one subnet" below), and the worker writes
   the interface's name to `/var/run/codex-lan-dev`. The egress guard then
   routes the private ranges (other VLANs behind the router) and multicast
   (device discovery) through the cable, and the clock sync's temporary NTP
   host route goes the same way. The guard checks first that the interface
   still has a route on the gateway's subnet, the clock sync that it still has
   a route, and both use Wi-Fi otherwise.
   **Discovery** follows too (`netservicestarter.lua`, every 5 s and on each
   address change): the cable joins the SSDP group 239.255.255.250, and the
   hub's address (the SSDP reply's `LOCATION`, `getNetworkAttribute("ipaddr")`
   and the session address) becomes the cable's. Stock firmware joins the
   group only on the interface its route named at boot (Wi-Fi) and always
   advertises Wi-Fi's address, which Wi-Fi keeps while disconnected. Home
   Assistant's Harmony integration takes a known hub's address from SSDP, so
   without this it followed the Wi-Fi address and lost the hub whenever
   Wi-Fi was off. With it, Home Assistant moves to the wired address at its
   next SSDP scan (a few minutes) and stays there. The MAC address that's
   reported stays Wi-Fi's.
3. **The internet, with the cloud blocker off.** Once the cable has a default
   route of its own (from DHCP, or the static settings' gateway), Wi-Fi's
   default route moves to metric 20 as well. With the blocker on, the guard
   keeps removing every default route, as before.
4. **Keeps checking.** The gateway is pinged every 30 s along those routes,
   with Wi-Fi on or off. Two misses in a row hand local traffic back to Wi-Fi
   (10 minutes, as above).

On another network than the gateway's, the cable is only an extra address and
Wi-Fi keeps carrying everything else. On Wi-Fi's network but with another
subnet mask (say Wi-Fi `/24`, the cable a static `/16`), the cable doesn't take
local traffic either: the hand-over moves only a subnet both share with the
same prefix, and Wi-Fi's more specific route would keep the traffic anyway.
The state is then `degraded_routing` with reason `prefix_mismatch`, Wi-Fi stays
on, and the page asks for the same mask; a cable already carrying local
traffic hands it back if its mask changes like that. With the cloud blocker off, the default
route the cable's own DHCP adds then moves to metric 30, behind Wi-Fi's, so the
internet stays on Wi-Fi too; the same while its gateway isn't answering. Losing the link, the address or the
adapter, or switching the feature off, puts everything back at once: routes,
ARP settings, `/var/run/codex-lan-dev`, and Wi-Fi if it was off.

DHCP asks every 2 s for 40 s before pausing (`udhcpc -t20 -T2 -A10`): a switch
port running spanning tree that doesn't treat the adapter as an edge port
forwards nothing for about 30 s after link-up, and the lease follows within a
retry of that.

## Turning Wi-Fi off while the cable works

The second switch on the Wired Ethernet page (off by default) has the hub
disconnect from Wi-Fi while the cable works, and reconnect as soon as it
doesn't. Wi-Fi goes off only when all of these hold:

- the cable carries local traffic (it passed the gateway check);
- it has done so for a minute (counted again after any outage);
- the latest 30-second gateway check passed;
- the egress guard is running with its Wi-Fi watchdog (below);
- with the cloud blocker off, the cable has a default route of its own (from
  DHCP, or a router in the static settings), so the internet doesn't need
  Wi-Fi. Without one Wi-Fi stays on, and the page says why
  (`wifiOffBlocked: "noRouter"` in the API).

It uses `wpa_cli disconnect` and `reconnect`. `wpa_supplicant` keeps running
and keeps the hub's Wi-Fi settings, so any restart brings Wi-Fi back. A
reconnect that `wpa_supplicant` refuses is tried again on the next pass.

While Wi-Fi is off the hub answers only at its wired address: point Home
Assistant and anything else there first (a DHCP reservation for the adapter's
MAC address helps). If the cable fails, Wi-Fi comes back on its own address.

**Safety net.** The worker is what watches the cable. If it dies (crashes, is
killed) while the cable carries local traffic or Wi-Fi is off, the egress guard
(`offline_egress_guard.sh`, which runs every couple of seconds and which
`init.sh` respawns) notices `/var/run/codex-lan-dev` or
`/var/run/codex-usb-eth-wifi-off` without a live worker:

- it stops routing the private ranges and multicast through the cable at once;
- it runs `usb_eth_service.sh recover`, which takes the service lock (without
  waiting: a start, stop or restart holding it sorts things out itself),
  checks again that no worker runs, and hands everything back the way losing
  the gateway does: Wi-Fi reconnected, `codex-lan-dev` removed, the routes
  (`net-remove`, default routes) and ARP settings as they were, the LED out
  of extender mode, state `failed` with reason `worker_stopped`;
- if `recover` can't run or finish, it reconnects Wi-Fi itself, and asks again
  on its next pass until nothing is left.

The cable keeps its address (nothing watches it any more, so it no longer
carries local traffic), and the page offers "Try again". This covers a cable
that keeps its link but stops passing traffic after the worker died. It
doesn't cover the guard dying at the same time; then a reboot brings Wi-Fi back,
since nothing persists the disconnect. The guard announces the watchdog in
`/var/run/codex-offline-egress.caps`; a guard from before an upgrade keeps
running until the hub restarts, and until then Wi-Fi stays on
(`wifiNeedsRestart` in the API).

## Static address

The address can come from DHCP (the default) or static settings: an address, a
subnet mask (/8 to /30), and optionally a router and up to two DNS servers. In
static mode no DHCP client runs. Changed settings are applied from scratch, and
settings that aren't valid (a hand-edited file) leave the cable without an
address (state `failed`, reason `static_invalid`). The DNS servers go into
`/etc/resolv.conf` only if it's empty: Wi-Fi's DHCP owns that file. Without a
router, the hub reaches only that subnet over the cable.

## The hub's light

Stock firmware shows the front LED green while the hub's Wi-Fi is connected
and red while it isn't, which with Wi-Fi off would mean red on a working
cable. So while the cable carries local traffic, the worker puts the hub's
hardware daemon (`hal`) in its stock *extender mode*, a state meant for a hub
that reaches the network some other way, which `hal` reads only for the LED.
The LED then stays green on the cable alone, and red means neither works.

`hal` re-reads that state only when the LED changes, so each switch is
followed by one short blink (`sys.led` `extender_mode` or
`non_extender_mode`, then `fire_command`). The worker compares the wanted
state with what `hal` last accepted after every pass, retries a refusal 30 s
later, sends it again 2 s after Wi-Fi goes off (`hal`'s Wi-Fi-down handler
writes red regardless), and repeats extender mode every 5 minutes without a
blink in case `hal` restarted.

## Network overview

The bottom of the Wired Ethernet page shows the whole picture: Wi-Fi (network,
signal, channel, address), the wired interface (link speed, address, traffic
and errors), every route explained in words (which of two routes to the same
place is used, which is the fallback), DNS, the gateway, and whether the cloud
blocker keeps the internet out. It is read-only (`GET /api/network-overview`)
and refreshes while the page is open.

## Tradeoffs and notes

- **Micro-USB device mode is unavailable while host mode is active.** Switching
  the AR9330 USB controller to host mode disconnects the USB gadget path until
  USB Ethernet is turned off and the hub reboots.
- **Keep `ar7240-ehci` bound until reboot.** Stopping the service downs the
  network interface and kills its `udhcpc` process, but deliberately leaves the
  `ar7240-ehci` platform device registered for the rest of the boot to avoid
  kernel platform re-registration crashes.
- **Big-endian TX checksum offload fix.** On this big-endian MIPS 2.6.31 kernel,
  hardware TX checksum offload can corrupt outgoing TCP/UDP checksums. Every
  shipped driver keeps hardware checksum offload off at probe (the ASIX
  drivers' chip checksum engines are explicitly disabled, not merely
  reported off), and `codex_usbeth eth-fix <ifname>` (`SIOCETHTOOL`
  `ETHTOOL_STXCSUM`/`ETHTOOL_SRXCSUM` = 0) disables it via ethtool as well,
  so checksums are computed in software.
- **Startup states are distinct end to end** (helper `status`, the
  service state file, `/api/usb-eth`, Settings): `deps_unavailable`,
  `platform_absent`, `platform_unbound`, `bus_ready`, `adapter_absent`,
  `adapter_unsupported`, `nic_not_bound`, `awaiting_carrier_dhcp`,
  `operational`, plus service-only `starting`, `failed` (with `reason`),
  `degraded_routing`, `gateway_unreachable` (the gateway didn't answer
  through the cable; local traffic is on Wi-Fi for now) and `stopped`. A device that is already registered
  is never re-registered (an early version did, and the kernel answered
  with duplicate-sysfs warnings); a registered-but-unbound controller
  is recovered only by loading its driver, a sysfs driver bind where
  that file exists (this kernel does not provide one), or exactly one
  guarded `ehci_hcd` reload on an empty bus after the PHY validates —
  never a reload loop.
- **The PHY read is validated before it is written.** `usbctrlr1` values
  `0xdeadbeef`/`0xffffffff`, or a value that changes between two reads,
  mean the register is not accessible yet: nothing is written and the
  worker retries within its bound. The one healthy value observed on
  the hub (`0x84000085`) is evidence, not a required constant; unrelated
  bits are preserved and the exact readback is verified. Passing this
  check does not by itself prove the PHY is usable — EHCI probing and
  USB enumeration are the proof. The register reads `0xdeadbeef` while
  Wi-Fi is disconnected (with "Wi-Fi off" on), although the bus keeps
  working, so a worker that finds the controller already bound (a
  restart, or a start after a stop) skips the probe. Not yet handled: a
  hub that boots while its Wi-Fi network is unavailable may never read
  the register at boot, and then the worker gives up (`phy_not_ready`)
  until it's started again.
- **Two interfaces, one subnet.** Wi-Fi (`ath0`) and the wired NIC both
  take DHCP addresses on the same LAN, where a stock Linux stack would
  answer ARP for either address on either interface and route replies
  by destination only — replies to the wired address left over Wi-Fi.
  The worker therefore (a) sets `arp_ignore=1`/`arp_announce=2` on just
  the two interfaces, and (b) probes for source-rule routing over
  rtnetlink: this hub's kernel has no policy-routing symbols, so the
  expected path is the fallback — the Wi-Fi connected route for the
  shared subnet is demoted to metric 20 in the main table, leaving the
  wired connected route preferred for that subnet. That is a deliberate,
  disclosed tradeoff: while the cable is operational, hub traffic to
  the shared subnet (including replies to the Wi-Fi address) may leave
  over the wire; Wi-Fi management still answers at its own address, and
  carrier loss or stop restores the original route and sysctls at once.
  With the cloud blocker on, the guard keeps every default route
  removed, so the internet stays unreachable. Replies to senders on
  other private subnets follow the cable too: the egress guard routes
  the private ranges through `/var/run/codex-lan-dev` (see "Using the
  cable"). All of these settings are recorded in a RAM state file, are owned by
  the service, and are undone on stop or carrier loss — pre-existing
  settings elsewhere are never touched.
- **Fail-closed kernel verification.** `codex_usbeth register-ehci` checks that
  `uname -r` is `2.6.31-g89d565c` and that `sys_call_table[148]` (phys
  `0x0000c990`) holds the exact stock `sys_sethostname` address (`0x8002fb4c`)
  before transiently invoking `platform_device_register` (`0x801267cc`) on the
  dormant `ar7240-ehci` device struct (`0x8023b808`) and restoring `0x8002fb4c`
  immediately after. Any mismatch aborts without writing to `/dev/mem`.

## Troubleshooting

`GET /api/usb-eth` (or `usb_eth_service.sh status` over SSH) gives the state
and reason; `/cache/codex-init.log` has the worker's lines (`codex usb-eth:`).

- **`gateway_unreachable`**: the cable has a link and an address, but the
  router doesn't answer through it. If it stays that way, look at the wired
  interface's counters on the Wired Ethernet page (or `ifconfig eth2`): many
  receive errors with few packets received point to the adapter or its driver.
- **About 30 s to get an address after plugging in**: the switch port is
  probably running spanning tree without treating the adapter as an edge port.
  Marking the port as an edge port (or turning spanning tree off on it, if
  nothing could loop through it) makes it near-instant.
- **Wi-Fi doesn't turn off**: the cable must have worked for a minute with a
  passing gateway check, and after an upgrade the hub must restart once
  (`wifiNeedsRestart`) so the egress guard has its watchdog.

## Kernel module provenance and license

All modules in `payload/modules/usb-net/` are compiled from the Linux kernel
source tree (GPLv2; `cdc_ncm.ko` keeps its upstream Dual BSD/GPL license).
See [`payload/modules/usb-net/README.md`](../payload/modules/usb-net/README.md)
for the exact source versions, SHA-256 digests, validation status, and
reproducible build recipe. The per-symbol layout audit behind the checksum
adoption lives with the build scratch (`USBNET_LAYOUT_AUDIT.md`).

USB host mode on this hub was first demonstrated by
[iranl/harmony-ng](https://github.com/iranl/harmony-ng) (MIT). The
EHCI-registration mechanism (a transient `sys_call_table` slot write
invoking `platform_device_register` on the dormant `ar7240-ehci`
device), the AR9330 `usbctrlr1` host-mode PHY setting, and the
big-endian checksum-offload workaround used here derive from that
project's published research. The implementation in
`payload/source/codex_usbeth.c` and the service around it are
Melodious's own; mechanism credit belongs to harmony-ng (see
`LICENSE`, section 3).
