# Extra shell commands (BusyBox 1.37.0)

The hub's own BusyBox is 1.13.4 from 2017, built with few commands: no `head`,
`tail`, `wc`, `timeout`, `flock`, `df`, `free`, `find`, `tar`, `sha256sum`,
`ip`, `netstat` or `grep -E`, and a `ping` without options. That makes
debugging over SSH slow, and pushes Melodious's scripts into workarounds.

Melodious installs a second BusyBox, `/data/codex/bin/busybox-extra`, with 63 of
the commands the stock one lacks. The hub's own `/bin/busybox` isn't touched:
it is `init`, the shell for the boot scripts and `udhcpc`, on the read-only
firmware partition, and replacing it risks a hub that doesn't boot.

## Using it

At boot, `init.sh` runs `busybox-extra --install -s /var/volatile/codex-bb`,
which links every command into that directory. The
links live in RAM, so they cost no flash and nothing is left behind if the
binary goes. Nothing uses them by default. In an SSH session:

```sh
export PATH=$PATH:/var/volatile/codex-bb
logread | tail -n 50
/data/codex/bin/busybox-extra ping -c 3 -W 1 192.168.1.1
timeout 10 wget -q -O - http://127.0.0.1:8080/api/system-status
df /                       # the data partition (the union hides /mnt/data)
ip route; ip neigh
netstat -tlnp
lsof | grep codex_webui     # every open file, filtered
```

The directory goes at the end of `PATH`, so wherever the stock BusyBox has a
command (`grep`, `ping`, `md5sum`, ...) it still wins, and nothing that works
today changes. For the newer version of one of those, give the full path:
`/data/codex/bin/busybox-extra grep -E`, or `/data/codex/bin/busybox-extra ping -c 3`
(plain `busybox` is still the stock `/bin/busybox`, even where
`/data/codex/bin` comes first on `PATH`). Commands that run other
commands (`timeout`, `xargs`, `nohup`, `find -exec`) look them up on `PATH`
too, so `timeout 5 ping -c 1 ...` would run the stock `ping`.

The links are made at boot, so after an install (or an update that changes
the set of commands) they catch up at the next reboot; until then
`/data/codex/bin/busybox-extra <command>` works.

## What's in it

- **Text, files and processes:** `basename cmp dd df du egrep env false find
  flock free grep head hexdump md5sum mkfifo mktemp nohup od pgrep pidof pkill
  printf readlink realpath rmdir seq setsid sha256sum sort stat sync tail tee
  timeout true truncate uniq uptime usleep watch wc xargs yes`
- **Network and debugging:** `arp arping diff fuser gunzip gzip ip less
  logger lsof nc netstat nslookup ping strings sysctl tar traceroute wget`

No shell, and no servers (`httpd`, `telnetd`, `ftpd`, `tftpd`, `udhcpd`); `nc`
only connects out (no `-l`, no `-e`). It is 419 KB, about 243 KB on the hub's
compressed flash. The first update that brings it writes those 243 KB once, on
top of the usual web app update.

On this kernel, `ip rule` answers "Not supported": the hub has no policy
routing.

## Source and licence

BusyBox is GPL-2.0. The binary is built reproducibly from the upstream
1.37.0 release with one small patch and a committed configuration; see
[`third_party/busybox-1.37.0/`](../third_party/busybox-1.37.0/README.md) and
[BUILD.md](BUILD.md#busybox-extra-busybox-1370-official-zig-gpl-20).
