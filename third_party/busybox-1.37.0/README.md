# BusyBox 1.37.0 (`payload/bin/busybox-extra`)

A second BusyBox for the hub, with the commands its own BusyBox 1.13.4 lacks.
The hub's `/bin/busybox` is left alone: it is `init`, the shell for the boot
scripts and `udhcpc`, on the read-only firmware partition.

BusyBox is licensed under the GNU General Public License, version 2 only
([LICENSE](LICENSE), copied unchanged from the release tarball).

## Corresponding source

`payload/bin/busybox-extra` is built from exactly these, and nothing else:

| Part | Where |
| --- | --- |
| Upstream source | `https://busybox.net/downloads/busybox-1.37.0.tar.bz2`, SHA-256 `3311dff32e746499f4df0d5df04d7eb396382d7e108bb9250e7b519b837043a4` (matches busybox.net's `.sha256`) |
| Our changes | [`patches/`](patches): one patch, `0001-libbb-xpipe-only-a-negative-result-is-failure.patch` |
| Configuration | [`busybox.config`](busybox.config), the complete `.config` |
| Build scripts | the busybox section of `build/build_harmony_tools_kali.sh`, with `build/busybox-zig-cc.sh`, `build/busybox-zig-ar.sh` and `build/discard-mips-pdr.ld` |
| Compiler | the official Zig 0.16.0 (clang/LLD 21.1.0, musl), pinned by executable SHA-256 in the build script |

If you received the binary without the source, the files above are in this
repository at the same commit as the binary. Each Melodious release that ships
the binary also carries the upstream tarball, `busybox-1.37.0.tar.bz2`, as a
release asset (`tools/releases/release.py` checks it against the SHA-256
above). The BusyBox project publishes it at the address above too.

## The patch

Zig 0.16's libc returns the MIPS kernel's raw `pipe()` result: `fd[0]` on
success instead of 0, though both descriptors are right. BusyBox's `xpipe()`
treated anything non-zero as an error, so `tar z` and anything else built on
it died with "can't create pipe". The patch only treats a negative result as
a failure, which is all POSIX promises. `codex_webui.c` works around the same
quirk.

## Configuration

Built from `allnoconfig`, static, no shell, with these applets (63):

- **Text, files and processes:** `basename cmp dd df du egrep env false find
  flock free grep head hexdump md5sum mkfifo mktemp nohup od pgrep pidof pkill
  printf readlink realpath rmdir seq setsid sha256sum sort stat sync tail tee
  timeout true truncate uniq uptime usleep watch wc xargs yes`
- **Network and debugging:** `arp arping diff fuser gunzip gzip ip less
  logger lsof nc netstat nslookup ping strings sysctl tar traceroute wget`

`CONFIG_DESKTOP` is on, for the fuller option sets (`od -A` and so on);
`CONFIG_FEATURE_INSTALLER`, for the `--install -s` that `init.sh` runs; and
`--help` text for every applet (`SHOW_USAGE`, `FEATURE_VERBOSE_USAGE`,
compressed). The
numeric and string options of the applets that are built are at upstream's
defaults (`allnoconfig` zeroes them, and `FEATURE_LESS_MAXLINES=0` would make
`less` stop after one line). Options of applets that aren't built stay empty;
set them to their defaults when you turn those applets on. `nc` is the client only (`NC_SERVER` and `NC_EXTRA` off: no `-l`, no `-e`).
Left out on purpose: shells, servers (`httpd`, `telnetd`, `ftpd`, `tftpd`,
`udhcpd`), and system tools (`init`, `mount`, `mdev`), which stay the hub's own.

To change the applets, edit `busybox.config` in a BusyBox 1.37.0 tree
(`make menuconfig` with the file as `.config`), and copy the result back. The
build fails closed if `make oldconfig` would change the committed file.
Build with `SOURCE_DATE_EPOCH=1727395200 TZ=UTC` (the build script sets both)
so the header and the binary's banner match.
