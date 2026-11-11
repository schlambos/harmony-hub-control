#!/bin/sh
# Build payload/modules/usb-net/asix.ko (docs/USB_ETHERNET.md) from published
# source only:
#
#  - Logitech's GPL kernel tree for the Harmony Hub (firmware 4.3.48, Atheros
#    LSDK 9.2.0, Linux 2.6.31), the closest tree Logitech has published to the
#    hub's running kernel, 2.6.31-g89d565c (firmware 4.15.600);
#  - third_party/linux-2.6.31-harmony/harmony-hub-4.15.600.config, that tree's
#    pimentoblue_defconfig with LBDAF, USB_MON and USB_DEVICE_CLASS off: with
#    it, the symbol versions (CONFIG_MODVERSIONS) of the kernel and usbcore
#    match the running kernel's, so no CRC needs to be supplied by hand;
#  - two upstream asix.c changes from Linux 3.1 for the AX88772B/C
#    (third_party/linux-2.6.31-harmony/patches/).
#
# asix.ko also imports usbnet's exports. It's linked against the CRCs of the
# usbnet.ko this repo ships (read from payload/modules/usb-net/usbnet.ko), so
# it loads next to that usbnet.ko and the other minidrivers built on it. Both
# trees' usbnet.c and include/linux/usb/usbnet.h are identical to Linux
# v2.6.31's.
#
# Needs Linux, perl, patch, unzip, a host C compiler, and curl or wget. It
# checks every download against a pinned SHA-256, and asix.ko against the pin
# below; ASIX_UPDATE_PIN=1 prints the new pin instead of failing after an
# intended change.
set -eu

# CDPATH= : with CDPATH set, cd prints the directory and SCRIPT_DIR would
# capture it twice.
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
TOOLS="$SCRIPT_DIR/toolchains"
WORK="$SCRIPT_DIR/tmp/usb-eth-asix"
THIRD="$REPO_DIR/third_party/linux-2.6.31-harmony"
MODDIR="$REPO_DIR/payload/modules/usb-net"

# The toolchain build_harmony_tools_kali.sh uses for Dropbear.
TOOLCHAIN_NAME=mips32--uclibc--stable-2017.05-toolchains-1-1
TOOLCHAIN_URL="https://toolchains.bootlin.com/downloads/releases/toolchains/mips32/tarballs/$TOOLCHAIN_NAME.tar.bz2"
TOOLCHAIN_SHA256=a75aeb0f82eaeaf1989a7dfdf80219486b5ed1470c29c6f253fbcf824922c29f
TOOLCHAIN_DIR="$TOOLS/mips32--uclibc--stable"
CROSS=mips-buildroot-linux-uclibc-

# https://opensource.logitech.com/wiki/Logitech_Harmony_Hubs links this file.
KERNEL_ZIP=Harmony.hub.4.3.48.mips-linux-2.6.31.tar.zip
KERNEL_URL="https://opensource.logitech.com/wiki/harmony/$KERNEL_ZIP"
KERNEL_SHA256=e2a0bed81faaa459934bae21da0794e570a40aefc391fb0b76703935ad328113

# payload/modules/usb-net/README.md lists it too.
ASIX_EXPECT_SHA256=64b59b465dda22bdd414a15863b301462fea9004c5bafa381b8d72d5788dab07

sha256() {
  sha256sum "$1" | awk '{print $1}'
}

fetch() { # url file sha256
  if [ ! -f "$2" ]; then
    mkdir -p "$(dirname "$2")"
    if command -v curl >/dev/null 2>&1; then curl -fL -o "$2.part" "$1"; else wget -O "$2.part" "$1"; fi
    mv "$2.part" "$2"
  fi
  if [ "$(sha256 "$2")" != "$3" ]; then
    echo "error: $2 has SHA-256 $(sha256 "$2"), expected $3" >&2
    exit 1
  fi
}

fetch "$TOOLCHAIN_URL" "$TOOLS/$TOOLCHAIN_NAME.tar.bz2" "$TOOLCHAIN_SHA256"
if [ ! -x "$TOOLCHAIN_DIR/bin/${CROSS}gcc" ]; then
  tar -C "$TOOLS" -xjf "$TOOLS/$TOOLCHAIN_NAME.tar.bz2"
fi
fetch "$KERNEL_URL" "$TOOLS/$KERNEL_ZIP" "$KERNEL_SHA256"
export PATH="$TOOLCHAIN_DIR/bin:$PATH"

# A fresh tree every time: the result must not depend on earlier builds.
rm -rf "$WORK"
mkdir -p "$WORK"
unzip -q "$TOOLS/$KERNEL_ZIP" mips-linux-2.6.31.tar -d "$WORK"
tar -C "$WORK" -xf "$WORK/mips-linux-2.6.31.tar"
rm -f "$WORK/mips-linux-2.6.31.tar"
KDIR="$WORK/mips-linux-2.6.31"
cd "$KDIR"

# The tree predates GCC 5 and modern perl. These build-system changes don't
# touch any code that ends up in asix.ko:
#  - the compiler-gcc5.h header the kernel looks for (same as the GCC 4 one);
#  - kernel/timeconst.pl's `defined(@array)`, an error in perl 5.22+;
#  - -Werror in arch/mips (GCC 5 warns where GCC 4.5 didn't);
#  - arch/mips/mm/page.c aliases two functions to arrays, which GCC 5
#    refuses. vmlinux is built only for its symbol versions and never runs.
cp include/linux/compiler-gcc4.h include/linux/compiler-gcc5.h
sed -i 's/defined(@\([a-z_]*\))/(@\1)/g' kernel/timeconst.pl
find arch/mips \( -name Makefile -o -name Kbuild \) -exec sed -i 's/-Werror//g' {} +
sed -i \
  -e 's|^void clear_page(void \*page) __attribute__((alias("clear_page_array")));|asm(".globl clear_page\\n.set clear_page, clear_page_array");|' \
  -e 's|^void copy_page(void \*to, void \*from) __attribute__((alias("copy_page_array")));|asm(".globl copy_page\\n.set copy_page, copy_page_array");|' \
  arch/mips/mm/page.c
grep -q 'asm(".globl clear_page' arch/mips/mm/page.c
grep -q 'asm(".globl copy_page' arch/mips/mm/page.c

for p in "$THIRD"/patches/*.patch; do
  patch -p1 -s < "$p"
done

cp "$THIRD/harmony-hub-4.15.600.config" .config
set -- ARCH=mips CROSS_COMPILE="$CROSS" EXTRAVERSION= KCFLAGS="-std=gnu89 -Wno-error" KAFLAGS="-Wa,-mhard-float"
yes "" | make "$@" oldconfig > "$WORK/oldconfig.log" 2>&1 || true
grep -q '^# CONFIG_LBDAF is not set' .config
grep -q '^CONFIG_LOCALVERSION="-g89d565c"' .config
# vmlinux and the modules, for Module.symvers: the CRCs of the kernel's and
# usbcore's exports.
make "$@" -j"$(nproc 2>/dev/null || echo 4)" vmlinux modules > "$WORK/build.log" 2>&1 || {
  tail -40 "$WORK/build.log" >&2
  exit 1
}

# asix.ko again as an external module, with usbnet's exports taken from the
# shipped usbnet.ko instead of the one built here.
EXT="$WORK/asix"
mkdir -p "$EXT"
cp drivers/net/usb/asix.c "$EXT/asix.c"
echo 'obj-m := asix.o' > "$EXT/Kbuild"
"${CROSS}nm" "$MODDIR/usbnet.ko" |
  awk '$3 ~ /^__crc_/ { c = substr($1, length($1) - 7); sub(/^__crc_/, "", $3);
         printf "0x%s\t%s\tdrivers/net/usb/usbnet\tEXPORT_SYMBOL_GPL\n", c, $3 }' > "$EXT/usbnet.symvers"
[ -s "$EXT/usbnet.symvers" ]
grep -v '	drivers/net/usb/usbnet	' Module.symvers > "$WORK/Module.symvers.nousbnet"
cp "$WORK/Module.symvers.nousbnet" Module.symvers
make "$@" M="$EXT" KBUILD_EXTRA_SYMBOLS="$EXT/usbnet.symvers" modules > "$WORK/asix.log" 2>&1 || {
  tail -40 "$WORK/asix.log" >&2
  exit 1
}
built="$EXT/asix.ko"

# Every usbnet symbol asix.ko imports must carry the shipped usbnet.ko's CRC.
"${CROSS}objcopy" -O binary --only-section=__versions "$built" "$WORK/versions.bin"
python3 - "$WORK/versions.bin" "$EXT/usbnet.symvers" <<'PY'
import struct, sys
data = open(sys.argv[1], "rb").read()
want = {}
for line in open(sys.argv[2]):
    crc, name = line.split("\t")[:2]
    want[name] = int(crc, 16)
used = 0
for off in range(0, len(data), 64):  # struct modversion_info: u32 crc + 60-byte name (32-bit)
    crc, = struct.unpack(">I", data[off:off + 4])
    name = data[off + 4:off + 64].split(b"\0", 1)[0].decode()
    if name in want:
        used += 1
        if crc != want[name]:
            sys.exit(f"error: asix.ko imports {name} with CRC {crc:#010x}, usbnet.ko exports {want[name]:#010x}")
if used == 0:
    sys.exit("error: asix.ko imports nothing from usbnet.ko")
print(f"asix.ko: {used} usbnet imports match usbnet.ko")
PY

got=$(sha256 "$built")
md5=$(md5sum "$built" | awk '{print $1}')
size=$(wc -c < "$built" | tr -d ' ')
if [ "$got" = "$ASIX_EXPECT_SHA256" ]; then
  echo "OK    asix.ko $size sha256 $got md5 $md5"
elif [ "${ASIX_UPDATE_PIN:-0}" = "1" ]; then
  echo "NEW   asix.ko $size sha256 $got md5 $md5"
  echo "Update ASIX_EXPECT_SHA256 in this script and the asix.ko row in payload/modules/usb-net/README.md."
else
  echo "error: asix.ko is not exact (sha256 $got, expected $ASIX_EXPECT_SHA256); $MODDIR left as it was" >&2
  exit 1
fi
cp "$built" "$MODDIR/asix.ko"
