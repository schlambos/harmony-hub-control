# USB Ethernet kernel modules (`2.6.31-g89d565c`)

This directory contains Linux kernel modules compiled from GPLv2 Linux kernel
source for the Harmony Hub's stock kernel (`2.6.31-g89d565c`, AR9344 SoC,
MIPS32 rel2 big-endian, non-SMP, `mod_unload modversions MIPS32_R2 32BIT`).

They are installed under `/data/codex/modules/usb-net/` and loaded on demand by
`/data/codex/usb_eth_service.sh` when USB Ethernet is enabled. The stock kernel
and `/lib/modules/2.6.31-g89d565c/` are never modified.

## Shipped modules

| File | Size | SHA-256 | MD5 | Source & license |
| --- | --- | --- | --- | --- |
| `r8152.ko` | 45664 | `e4896b7f9e2ec1a952c5840e1fba4ef9fc0c6b2855163e5545f40fb7d9f98c58` | `2e38f4ab96ac07e91fc6673232e1debc` | Linux v3.14 `drivers/net/usb/r8152.c` + v4.4 `RTL_VER_06` (`0x5c30`) support (Realtek RTL8152/RTL8153, backported to 2.6.31), GPLv2 |
| `usbnet.ko` | 33388 | `d31b8c9413e80fc082a68fa21abfaaf0e3c50e7173bfc450edb4e7d3ae5efefb` | `8225a6661f8debe6874fe109894fbb41` | Linux v2.6.31 `drivers/net/usb/usbnet.c` (USB network driver framework), GPLv2 |
| `asix.ko` | 33096 | `abbd332d7b2df96c1d18f477ccbe04458ca62477591588fab1302cc4e86797da` | `5d7655595b5acfe1f15a596c6325397b` | Linux v2.6.31 `drivers/net/usb/asix.c` (ASIX AX88172/AX88772/AX88772A/AX88178), GPLv2 |
| `cdc_ether.ko` | 11916 | `c1d574d16bd9df3412b550eb1ad77dd2fd8fa367a2f3acfda40ae1cbc81a955c` | `7eeeaf966728a2c5e915c8ce42bec619` | Linux v2.6.31 `drivers/net/usb/cdc_ether.c` (CDC Ethernet / ECM, class-matched), GPLv2 |
| `cdc_ncm.ko` | 19216 | `ef32e97e692f6caa2b23114ced08c7f98b24cf76cd49d38ad4243c3f435e3f25` | `b53ea73aaf7e7f567f547a7551f0522d` | Linux v2.6.38 `drivers/net/usb/cdc_ncm.c` (CDC NCM, class-matched), Dual BSD/GPL (GPL-compatible) |
| `ax88179_178a.ko` | 30200 | `a80e278b2f009e633134986fa4421ffded32ff4f1c2fec8e25c63dee790cd05d` | `24f5ecf1433acf98db037fa552d76575` | Linux v3.14 `drivers/net/usb/ax88179_178a.c` (ASIX AX88179/AX88178A), GPLv2 |

**Validation status (read this):** only `r8152.ko` + `usbnet.ko` have been
traffic-tested on hub hardware (bound RTL8153 adapter, DHCP + ping + HTTP).
`asix.ko`, `cdc_ether.ko`, `cdc_ncm.ko` and `ax88179_178a.ko` are built from
GPL kernel source, fully import-audited against the hub kernel (every import
either exact genksyms-CRC-equal or proven field-identical against the hub's
own `usbcore.ko`/`athrs_gmac.ko`/kernel image), but they are **built and
audited only** — no ASIX or CDC adapter has been traffic-tested, and no
inert load test has been run yet for these four. See the layout audit
(`USBNET_LAYOUT_AUDIT.md`, Part 3) for the per-symbol evidence.

## Supported USB IDs (`r8152.ko`)

- `0bda:8152` — Realtek RTL8152B USB 2.0 10/100 Ethernet
- `0bda:8153` — Realtek RTL8153 USB 3.0 10/100/1000 Ethernet (operates at USB 2.0 High-Speed on the hub)
- `04e8:a101` — Samsung USB Ethernet adapter (RTL8153-based)

## Supported chipsets (usbnet minidrivers)

All four load `usbnet.ko` first. `codex_usbeth status` reports the driver to
load (`usb_driver=`) from the VID:PID map below, or from the CDC interface
class for CDC devices.

- **`asix.ko`** (Linux 2.6.31): ASIX AX88172 (`077b:2226`, `0846:1040`,
  `2001:1a00`, `0b95:1720`, `07b8:420a`, `08dd:90ff`, `0557:2009`,
  `0411:003d`, `6189:182d`, `07aa:0017`, `1189:0893`, `1631:6200`,
  `04f1:3008`), AX88772 (`0b95:7720`, `13b1:0018`, `1557:7720`, `07d1:3c05`,
  `2001:3c05`, `05ac:1402` Apple USB Ethernet, `0b95:772a`), AX88772A
  (`0db0:a877`), AX88178 (`0411:006e`, `0b95:1780`, `1737:0039`, `04bb:0930`,
  `050d:5055`, `14ea:ab11`). **Not** AX88772B (`0b95:772b`): its upstream
  bind/reset sequence changed after 2.6.31 and is not included.
- **`ax88179_178a.ko`** (Linux v3.14 backport): AX88179 (`0b95:1790`),
  AX88178A (`0b95:178a`), D-Link DUB-1312 (`2001:4a00`), Sitecom
  (`0df6:0072`), Samsung (`04e8:a100`), Lenovo OneLink (`17ef:304b`).
- **`cdc_ether.ko`** (CDC-ECM): matches by USB interface class
  (Communications 02 / ECM subclass 06 / protocol 00) after a small Zaurus
  blacklist, plus Ericsson/Toshiba/Dell MDLM IDs (`0bdb:1900/1902/1904/1906`,
  `0930:130b`, `413c:8147`). Any vendor's class-compliant ECM adapter binds
  without a VID:PID entry.
- **`cdc_ncm.ko`** (CDC-NCM, Linux v2.6.38 backport): matches by interface
  class (02 / NCM subclass 0d / protocol 00).

## Build recipe

1. **Kernel tree:** upstream Linux `v2.6.31` (`linux-2.6.31.tar.bz2`), prepared
   for modern host tools and GCC 5 (`compiler-gcc5.h` copied from
   `compiler-gcc4.h`, `CONFIG_CONSTRUCTORS` exposed as a configurable bool and
   disabled to match the hub's 284-byte `struct module`).
2. **Cross toolchain:** Bootlin `mips32--uclibc--stable-2017.05-toolchains-1-1`
   (`mips-buildroot-linux-uclibc-gcc` 5.4.0, big-endian MIPS32r2) inside an
   `amd64` Debian container (`HOSTCC=clang`, `KCFLAGS=-std=gnu89`).
3. **Kernel configuration:** big-endian MIPS32r2 (`CONFIG_CPU_BIG_ENDIAN=y`,
   `CONFIG_CPU_MIPS32_R2=y`, `CONFIG_32BIT=y`), UP (`# CONFIG_SMP is not set`),
   `CONFIG_PREEMPT_NONE=y`, `CONFIG_MODVERSIONS=y`, `CONFIG_MODULE_UNLOAD=y`,
   `CONFIG_SLAB=y`, `CONFIG_BASE_SMALL=1`, `CONFIG_LOCALVERSION="-g89d565c"`,
   `# CONFIG_CONSTRUCTORS is not set`, `# CONFIG_ENABLE_MUST_CHECK is not set`,
   `# CONFIG_MAC80211 is not set`.
4. **`r8152` 2.6.31 backport adaptations:**
   - Route `kmalloc` / `kzalloc` / `kmalloc_node` through out-of-line
     `__kmalloc` so the module does not index `malloc_sizes[]` inline (the hub
     kernel builds `struct cache_sizes` without `CONFIG_ZONE_DMA`, giving an
     8-byte stride vs upstream MIPS generic's 12-byte stride).
   - Omit `NETIF_F_IP_CSUM` from initial `netdev->features` on this big-endian
     2.6.31 kernel and wire `ethtool_op_get_tx_csum` / `ethtool_op_set_tx_csum`
     plus `get/set_rx_csum` into `ethtool_ops` so `SIOCETHTOOL` checksum-offload
     disable (`codex_usbeth eth-fix`) succeeds cleanly.
   - Adapt `netdev_for_each_mc_addr` to 2.6.31's `struct dev_mc_list`
     (`netdev->mc_list` / `netdev->mc_count` / `dmi_addr`) and provide thin
     2.6.31 compatibility macros for `netdev_alloc_skb_ip_align`,
     `module_usb_driver`, and `netif_*` logging helpers.
5. **usbnet minidriver adaptations (asix / cdc_ether / cdc_ncm / ax88179_178a):**
   - Route `kmalloc` / `kzalloc` through out-of-line `__kmalloc` (same
     `malloc_sizes[]` stride fix as `r8152`); no module indexes the
     config-sized kernel table directly.
   - Hardware checksum offload is off at probe on this big-endian kernel:
     no `NETIF_F_IP_CSUM`/`NETIF_F_RXCSUM`/SG/TSO anywhere; the AX88178
     `AX_MEDIUM_ENCK` chip-checksum enable is removed; AX88179
     `AX_RXCOE_CTL`/`AX_TXCOE_CTL` are written 0 at bind and reset and its
     RX-checksum marking is neutralized. `ethtool_op_get/set_tx_csum` plus
     no-op `get/set_rx_csum` are wired into every driver's `ethtool_ops`
     so `codex_usbeth eth-fix` succeeds.
   - `cdc_ncm` (v2.6.38): NCM descriptor structs embedded from the v2.6.38
     `cdc.h` (packed wire format); `FLAG_MULTI_PACKET` emulated against
     2.6.31 usbnet (RX aggregate drained, TX NTB padded inside
     `wBlockLength`); the 2.6.31-absent `.manage_power` hook dropped.
   - `ax88179_178a` (v3.14): static local `usbnet_read_cmd`/`write_cmd`
     helpers ported from GPL v3.14 `usbnet.c` (autopm omitted — a no-op in
     the hub's PM-less usbcore); `driver_info.stop` preserved as an
     `ndo_stop` wrapper; multicast via the 2.6.31 `mc_list` walk.
6. **Symbol versions (`__versions`):** linked with `KBUILD_EXTRA_SYMBOLS`
   pointing to the hub kernel + `usbcore.ko` `Module.symvers` table (plus
   the shipped `usbnet.ko`'s own export CRCs for the minidrivers) after
   verifying every imported symbol's binary struct/field layout against the
   hub's own `athrs_gmac.ko`, `usbcore.ko`, `ehci-hcd.ko`, and `vmlinux`.

## License

All modules are derived from the Linux kernel and are licensed under the
**GNU General Public License version 2 (GPLv2)**, except `cdc_ncm.ko`, which
keeps its upstream **Dual BSD/GPL** license (GPL-compatible). Full kernel
source is available from kernel.org at the versions listed above; the exact
backport edits are listed in this file and proven in the layout audit.
No third-party or vendor binaries are used.
