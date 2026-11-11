# Linux 2.6.31 for the Harmony Hub: config and patches for `asix.ko`

These files, with Logitech's published kernel archive and the Bootlin toolchain,
are the complete source of `payload/modules/usb-net/asix.ko` (GPL-2.0).
`build/build_usb_eth_asix.sh` builds it from scratch and checks the result
against a pinned SHA-256. [docs/USB_ETHERNET.md](../../docs/USB_ETHERNET.md)
explains the feature.

## Inputs

| Input | Where from | SHA-256 |
| --- | --- | --- |
| Kernel tree | `Harmony.hub.4.3.48.mips-linux-2.6.31.tar.zip`, linked from <https://opensource.logitech.com/wiki/Logitech_Harmony_Hubs> (downloaded from `https://opensource.logitech.com/wiki/harmony/`) | `e2a0bed81faaa459934bae21da0794e570a40aefc391fb0b76703935ad328113` |
| Toolchain | Bootlin `mips32--uclibc--stable-2017.05-toolchains-1-1` (GCC 5.4.0, binutils 2.27), the one `build_harmony_tools_kali.sh` uses for Dropbear | `a75aeb0f82eaeaf1989a7dfdf80219486b5ed1470c29c6f253fbcf824922c29f` |
| Config | `harmony-hub-4.15.600.config` (this directory) | |
| Patches | `patches/0001-*.patch`, `patches/0002-*.patch` (this directory) | |
| usbnet CRCs | the `__crc_*` symbols of `payload/modules/usb-net/usbnet.ko` | |

The kernel archive is the Atheros LSDK 9.2.0_U10.5.13 tree that Logitech
published for hub firmware 4.3.48 (2015). Hubs today run firmware 4.15.600,
kernel `2.6.31-g89d565c`; Logitech hasn't published that tree.

## The config: matching 4.15.600's symbol versions

The hub's kernel has `CONFIG_MODVERSIONS`: a module loads only if the CRC of
every symbol it imports matches the running kernel's. Built with the archive's
own `arch/mips/configs/pimentoblue_defconfig`, the CRCs don't match (74 of 251
kernel symbols and 67 of 85 `usbcore` exports differed, including
`module_layout`), and the hub refuses the module
(`disagrees about version of symbol module_layout`).

Three options explain every difference:

| Option | Hub | How it was found |
| --- | --- | --- |
| `CONFIG_LBDAF` | **off** | The hub's `/proc/slabinfo` shows `buffer_head` at 52 bytes, i.e. a 4-byte `sector_t`. `sector_t` and `blkcnt_t` sit inside `inode`, `super_block` and friends, which every network, USB and module symbol reaches through pointers (`module_layout` → `task_struct` → files). Turning it off fixed 284 of 336 CRCs at once. |
| `CONFIG_USB_DEVICE_CLASS` | **off** | The hub's `usbcore.ko` has no `usb_classdev_class`. |
| `CONFIG_USB_MON` | **off** | The hub's `usbcore.ko` has no `usb_mon_register`. |

With them, **all 336 comparable CRCs match**: the hub's kernel exports (the
`__versions` tables of the hub's own modules) and `usbcore`'s (the hub's
`/proc/kallsyms` `__crc_*`). No CRC is supplied by hand, and struct layouts follow
from the same config, so they are the hub's too.

The kernel image on flash (`/dev/mtdblock1`) has no embedded config
(`CONFIG_IKCONFIG` is off). A sweep of single options reachable from the VFS,
scheduler and module headers had found nothing, because `LBDAF` lives in
`types.h`, outside the headers swept.

The complete list of changes to `pimentoblue_defconfig`:

- `LBDAF`, `USB_DEVICE_CLASS` and `USB_MON` off (above);
- `LOCALVERSION="-g89d565c"` and `LOCALVERSION_AUTO` off, so `vermagic` is the
  hub's `2.6.31-g89d565c mod_unload modversions MIPS32_R2 32BIT`;
- `INITRAMFS_SOURCE=""` (the defconfig names an `initramfs.txt` that isn't in
  the archive);
- the USB host and USB network drivers as modules: `USB=m`, `USB_DEVICEFS`,
  `USB_EHCI_HCD=m` with `USB_EHCI_AR9130`, `USB_USBNET=m`, `USB_NET_AX8817X=m`,
  `USB_NET_CDCETHER=m`;
- what `make oldconfig` derives. Some of that comes from the archive alone:
  its Bluetooth `Kconfig` has no `BT_L2CAP` symbol and selects `CRC16`,
  `CRYPTO_BLKCIPHER` and `CRYPTO_ECB`, so `oldconfig` changes those even for
  the unmodified defconfig.

`MII`, `CRC32` and `BITREVERSE` are built into the hub's kernel, so `asix.ko`
needs no `mii.ko`.

## The patches

Both are upstream Linux 3.1 changes, the release that added the AX88772B:

- **`0001-asix-add-ax88772b-id.patch`:** `0b95:772b` with `ax88772_info`,
  the same way Linux 3.1 added it.
- **`0002-asix-use-11-bits-of-rx-header.patch`:** upstream commit
  `bca0beb9363f` ("ASIX: Use only 11 bits of header for data size"). The
  AX88772B/C uses only the low 11 bits of each received packet's header for
  the length and sets some of the others (`0x803c` for a 60-byte frame). 2.6.31
  reads all 16 bits, logs `asix_rx_fixup() Bad Header Length` and
  `Bad RX Length 32828`, and drops the whole transfer: on hardware, 42 packets
  arrived against 1,045 errors. Applied to 2.6.31's form of the check
  (`bc466e678d0a` simplified it first upstream).

The archive's `drivers/net/usb/asix.c`, `usbnet.c` and
`include/linux/usb/usbnet.h` are byte-identical to Linux v2.6.31's.

## Build-system changes

The tree predates GCC 5 and modern perl. None of these touch code that ends up
in `asix.ko`:

- `include/linux/compiler-gcc5.h`, copied from `compiler-gcc4.h`;
- `kernel/timeconst.pl`: `defined(@array)` (an error since perl 5.22) → `(@array)`;
- `-Werror` removed from `arch/mips` makefiles (GCC 5 warns where GCC 4.5 didn't);
- `arch/mips/mm/page.c`: the `clear_page`/`copy_page` function-to-array
  aliases, which GCC 5 rejects, become asm `.set` aliases. `vmlinux` is built
  only for its symbol versions and never runs;
- `KCFLAGS="-std=gnu89 -Wno-error"` and `KAFLAGS="-Wa,-mhard-float"` (the FPU asm).

## Linking against the shipped `usbnet.ko`

`usbnet.ko` and the other minidrivers in `payload/modules/usb-net/` were built
another way (Linux v2.6.31 with the hub's CRCs supplied through
`KBUILD_EXTRA_SYMBOLS`), so `usbnet.ko`'s own export CRCs differ from the ones
this tree computes. To load next to it, `asix.ko` is built a second time as an
external module, with `usbnet`'s entries in `Module.symvers` replaced by the
`__crc_*` values read from the shipped `usbnet.ko`. The script then checks that
every `usbnet_*` import carries that CRC.

That's sound because both sides use the same `usbnet` source (above), and the
layouts both depend on are the hub's: the config reproduces the hub's CRCs, and
the shipped `usbnet.ko` was layout-audited against the hub.
