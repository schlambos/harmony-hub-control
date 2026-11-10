# USB Ethernet (LAN over USB)

The Harmony Hub can use a **self-powered OTG micro-USB Ethernet adapter** for a
wired LAN connection alongside Wi-Fi. Melodious switches the AR9344 SoC's USB
controller into host mode, binds the stock kernel's dormant `ar7240-ehci`
platform device, loads the Linux kernel's `r8152` driver from
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

### Supported Ethernet chipsets (this release)

This release ships the Linux kernel's **`r8152`** driver (`r8152.ko`, backported
from Linux v3.14 under GPLv2, plus `usbnet.ko` from Linux v2.6.31):

| USB VID:PID | Chipset | Notes |
| --- | --- | --- |
| `0bda:8152` | Realtek RTL8152B (10/100 Mbps USB 2.0) | Recommended; standard chipset in OTG power-splitter Ethernet adapters |
| `0bda:8153` | Realtek RTL8153 (10/100/1000 Mbps USB 3.0) | Operates at USB 2.0 High-Speed on the hub |
| `04e8:a101` | Samsung USB Ethernet (RTL8153-based) | Supported by `r8152.ko` |

Other USB-Ethernet chipsets (ASIX, SMSC95xx, CDC-ECM) are not loaded in this
cut.

## How to enable or disable

### In the web UI

1. Connect the self-powered OTG Realtek Ethernet adapter and LAN cable.
2. Open **Settings** → **Experimental** → **Ethernet (USB OTG)** and turn the
   switch **on**.
3. The hub writes `/data/codex/usb_eth.conf` (`ENABLED=1`), switches the USB PHY
   to host mode, registers `ar7240-ehci`, loads `r8152.ko`, disables checksum
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
  hardware TX checksum offload can corrupt outgoing TCP/UDP checksums. Both the
  backported `r8152.ko` and `codex_usbeth eth-fix <ifname>` (`SIOCETHTOOL`
  `ETHTOOL_STXCSUM`/`ETHTOOL_SRXCSUM` = 0) keep checksum offload disabled so
  checksums are computed in software.
- **Fail-closed kernel verification.** `codex_usbeth register-ehci` checks that
  `uname -r` is `2.6.31-g89d565c` and that `sys_call_table[148]` (phys
  `0x0000c990`) holds the exact stock `sys_sethostname` address (`0x8002fb4c`)
  before transiently invoking `platform_device_register` (`0x801267cc`) on the
  dormant `ar7240-ehci` device struct (`0x8023b808`) and restoring `0x8002fb4c`
  immediately after. Any mismatch aborts without writing to `/dev/mem`.

## Kernel module provenance and license

`payload/modules/usb-net/r8152.ko` and `payload/modules/usb-net/usbnet.ko` are
compiled from the Linux kernel source tree (GPLv2). See
[`payload/modules/usb-net/README.md`](../payload/modules/usb-net/README.md) for
the exact source versions, SHA-256 digests, and reproducible build recipe.
