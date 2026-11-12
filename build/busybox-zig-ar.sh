#!/bin/sh
# BusyBox's AR for the hub: the pinned Zig 0.16.0's archiver (from $BUSYBOX_ZIG).
exec "$BUSYBOX_ZIG" ar "$@"
