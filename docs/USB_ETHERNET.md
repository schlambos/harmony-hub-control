# USB Ethernet (LAN over USB)

The Harmony Hub can use a **self-powered OTG micro-USB Ethernet adapter** for a
wired LAN connection alongside Wi-Fi. Melodious switches the AR9344 SoC's USB
controller into host mode, binds the stock kernel's dormant `ar7240-ehci`
platform device, loads the matching Linux kernel driver from
`/data/codex/modules/usb-net/`, disables hardware TX/RX checksum offload, and
starts `udhcpc` on the wired interface. The stock kernel and `/lib/modules/`
are never modified.

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
| `asix.ko` | ASIX AX88172 / AX88772 / AX88772A / AX88178 + clones (see payload README for the VID:PID list; incl. `05ac:1402` Apple USB Ethernet). **Not** AX88772B (`0b95:772b`) | Built + audited only; traffic test pending hardware |
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
   the wired path is **operational**. Enabled is not operational: while
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

- Status: `/data/codex/bin/codex_usbeth status` or `GET /api/usb-eth`
- Enable: `POST /api/usb-eth` with `{"enabled": true}` (same-origin JSON)
- Disable: `POST /api/usb-eth` with `{"enabled": false}` (same-origin JSON)

## Tradeoffs and notes

- **Micro-USB device mode is unavailable while host mode is active.** Switching
  the AR9344 USB controller to host mode disconnects the USB gadget path until
  USB Ethernet is turned off and the hub reboots.
- **DHCP only (first cut).** The wired interface acquires its IPv4 address via
  BusyBox `udhcpc` alongside `ath0` (Wi-Fi). Static IP configuration and
  automatic Wi-Fi failover are not part of this first cut.
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
  `degraded_routing` and `stopped`. A device that is already registered
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
  USB enumeration are the proof.
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
  No default route is ever added, so the cloud blocker keeps the
  internet unreachable while it is on. Replies to senders on other
  private subnets still follow the blocker's routes via Wi-Fi; that
  asymmetric case is a known limitation, not silently claimed fixed.
  All of these settings are recorded in a RAM state file, are owned by
  the service, and are undone on stop or carrier loss — pre-existing
  settings elsewhere are never touched.
- **Fail-closed kernel verification.** `codex_usbeth register-ehci` checks that
  `uname -r` is `2.6.31-g89d565c` and that `sys_call_table[148]` (phys
  `0x0000c990`) holds the exact stock `sys_sethostname` address (`0x8002fb4c`)
  before transiently invoking `platform_device_register` (`0x801267cc`) on the
  dormant `ar7240-ehci` device struct (`0x8023b808`) and restoring `0x8002fb4c`
  immediately after. Any mismatch aborts without writing to `/dev/mem`.

## Kernel module provenance and license

All modules in `payload/modules/usb-net/` are compiled from the Linux kernel
source tree (GPLv2; `cdc_ncm.ko` keeps its upstream Dual BSD/GPL license).
See [`payload/modules/usb-net/README.md`](../payload/modules/usb-net/README.md)
for the exact source versions, SHA-256 digests, validation status, and
reproducible build recipe. The per-symbol layout audit behind the checksum
adoption lives with the build scratch (`USBNET_LAYOUT_AUDIT.md`).
