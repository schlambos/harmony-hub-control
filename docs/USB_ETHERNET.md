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
stated plainly below:** only Realtek has passed a live traffic test on hub
hardware. The ASIX and CDC drivers are built from GPL kernel source and
fully import-audited against the hub kernel, but they have not been
traffic-tested (the maintainer's only adapter is Realtek), and no inert
load test has been run for them yet.

| Driver | Chipsets / match | Validation |
| --- | --- | --- |
| `r8152.ko` | Realtek RTL8152B (`0bda:8152`), RTL8153 (`0bda:8153`, USB 2.0 High-Speed on the hub), Samsung (`04e8:a101`) | **Hardware traffic-tested** (DHCP, ping, HTTP) |
| `asix.ko` | ASIX AX88172 / AX88772 / AX88772A / AX88178 + clones (see payload README for the VID:PID list; incl. `05ac:1402` Apple USB Ethernet). **Not** AX88772B (`0b95:772b`) | Built + audited only; traffic test pending hardware |
| `ax88179_178a.ko` | ASIX AX88179 (`0b95:1790`), AX88178A (`0b95:178a`), D-Link DUB-1312, Sitecom, Samsung, Lenovo (VID:PID list in payload README) | Built + audited only; traffic test pending hardware |
| `cdc_ether.ko` | CDC-ECM: matched by USB class (Communications 02 / subclass 06), any vendor; plus Ericsson/Toshiba/Dell IDs | Built + audited only; traffic test pending hardware |
| `cdc_ncm.ko` | CDC-NCM: matched by USB class (02 / subclass 0d), any vendor | Built + audited only; traffic test pending hardware |

The class-based CDC match is the broad-coverage path: a CDC-ECM/NCM
class-compliant dongle binds even when its VID:PID is not listed anywhere.
SMSC95xx and other chipsets remain unsupported.

## How to enable or disable

### In the web UI

1. Connect the self-powered OTG Ethernet adapter and LAN cable.
2. Open **Settings** → **Experimental** → **Ethernet (USB OTG)** and turn the
   switch **on**.
3. The hub writes `/data/codex/usb_eth.conf` (`ENABLED=1`), switches the USB PHY
   to host mode, registers `ar7240-ehci`, loads the adapter's driver, disables checksum
   offload, and starts `udhcpc`.
4. Once `udhcpc` acquires a lease, the row shows
   `Ethernet + Wi-Fi · eth0 · <ipv4> · <adapter>`.
5. When `ENABLED=1`, `/etc/init.d/rcS.local` starts `/data/codex/usb_eth_service.sh`
   automatically on every boot.

To disable, turn **Ethernet (USB OTG)** **off** in Settings. The hub writes
`ENABLED=0`, stops `udhcpc` on the wired interface, and brings the interface
down.

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
