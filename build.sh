#!/usr/bin/env bash
# Build OpenWrt for the Xiaomi AX9000 inside Docker.
# Usage: ./build.sh [--oem-firmware <file>] [--force-bdf] [--jobs N] [--shell]
# The QCN9074 BDF is generated from bdf/upstream at build time (a git-ignored
# bdf/board-xiaomi_ax9000.qcn9074 overrides it). --oem-firmware is optional: it only cross-checks the stock
# BDF frequency range (Xiaomi's BDF is never installed); --force-bdf (or
# AX9000_FORCE_BDF=1) accepts an unknown stock version and a BDF other than R.
set -euo pipefail
cd "$(dirname "$0")"

OEM=""; FORCE=0; JOBS=""; SHELL_MODE=0
while [ $# -gt 0 ]; do
    case "$1" in
        --oem-firmware) OEM="${2:?--oem-firmware needs a file}"; shift 2 ;;
        --force-bdf)    FORCE=1; shift ;;
        --jobs)         JOBS="${2:?--jobs needs a number}"; shift 2 ;;
        --shell)        SHELL_MODE=1; shift ;;
        -h|--help)      sed -n 2,7p "$0"; exit 0 ;;
        *) echo "unknown option: $1" >&2; exit 64 ;;
    esac
done

# Git Bash (MSYS) rewrites /paths in arguments; turn that off and use
# Windows-style host paths (D:/x/y) which Docker Desktop understands.
export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'
hostpath() {
    if (cd "$1" && pwd -W) >/dev/null 2>&1; then (cd "$1" && pwd -W); else (cd "$1" && pwd); fi
}
REPO="$(hostpath .)"
mkdir -p out
OUT="$(hostpath out)"

if [ -n "$JOBS" ]; then
    case "$JOBS" in
        ''|*[!0-9]*|0|0[0-9]*) echo "error: --jobs must be a positive integer (got '$JOBS')" >&2; exit 64 ;;
    esac
else
    JOBS="$(docker info --format '{{.NCPU}}' 2>/dev/null || nproc 2>/dev/null || echo 4)"
fi

# Parallel worktrees use separate trees by setting AX9000_TREE_VOLUME.
TREE_VOLUME="${AX9000_TREE_VOLUME:-ax9000-openwrt}"

docker build -q -t ax9000-builder docker/ >/dev/null

args=(--rm -v "$REPO:/src:ro" -v "$OUT:/out"
      -v "$TREE_VOLUME:/work/openwrt" -v ax9000-dl:/work/dl -v ax9000-ccache:/work/ccache
      -e "JOBS=$JOBS" -e "FORCE_BDF=$FORCE" -e "AX9000_FORCE_BDF=${AX9000_FORCE_BDF:-0}")
if [ -n "$OEM" ]; then
    [ -f "$OEM" ] || { echo "error: firmware file not found: $OEM" >&2; exit 1; }
    args+=(-v "$(hostpath "$(dirname "$OEM")"):/firmware:ro" -e "OEM_FW=/firmware/$(basename "$OEM")")
fi

if [ "$SHELL_MODE" = 1 ]; then
    exec docker run -it "${args[@]}" -w /work/openwrt ax9000-builder bash
fi
exec docker run "${args[@]}" ax9000-builder bash /src/scripts/build-openwrt.sh
