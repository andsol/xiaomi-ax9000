#!/bin/sh
# Runs as root only long enough to fix ownership of the mounted volumes
# (Docker creates named volumes root-owned), then drops to the unprivileged
# "builder" user. OpenWrt refuses to build as root, so this is preferable to
# FORCE_UNSAFE_CONFIGURE=1.
set -e
for d in /work /work/openwrt /work/dl /work/ccache /out; do
    [ -d "$d" ] && chown builder:builder "$d" 2>/dev/null || true
done
exec gosu builder "$@"
