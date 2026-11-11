#!/bin/sh
# BusyBox's CC for the hub: the pinned Zig 0.16.0 (from $BUSYBOX_ZIG) for
# mips-linux-musleabi. scripts/trylink passes a few GNU ld options that lld
# rejects or that only add a map file and log; drop just those.
for a do
  shift
  case $a in
    -Wl,--warn-common|-Wl,--sort-common|-Wl,--sort-section,*|-Wl,-Map,*|-Wl,--verbose) ;;
    *) set -- "$@" "$a" ;;
  esac
done
exec "$BUSYBOX_ZIG" cc -target mips-linux-musleabi "$@"
