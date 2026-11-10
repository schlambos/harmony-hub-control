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

## Supported USB IDs (`r8152.ko`)

- `0bda:8152` — Realtek RTL8152B USB 2.0 10/100 Ethernet
- `0bda:8153` — Realtek RTL8153 USB 3.0 10/100/1000 Ethernet (operates at USB 2.0 High-Speed on the hub)
- `04e8:a101` — Samsung USB Ethernet adapter (RTL8153-based)

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
5. **Symbol versions (`__versions`):** linked with `KBUILD_EXTRA_SYMBOLS`
   pointing to the hub kernel + `usbcore.ko` `Module.symvers` table after
   verifying every imported symbol's binary struct/field layout against the
   hub's own `athrs_gmac.ko`, `usbcore.ko`, `ehci-hcd.ko`, and `vmlinux`.

## License

Both modules are derived from the Linux kernel and are licensed under the
**GNU General Public License version 2 (GPLv2)**.
