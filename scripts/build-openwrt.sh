#!/bin/bash
# Runs INSIDE the ax9000-builder container as user "builder".
# Layout: /src (repo, read-only), /out (outputs), /work/openwrt (volume),
#         /work/dl and /work/ccache (volumes, symlinked into the tree).
set -euo pipefail

JOBS="${JOBS:-$(nproc)}"
OEM_FW="${OEM_FW:-}"          # optional cross-check only; path inside container, e.g. /firmware/xxx.bin
FORCE_BDF="${FORCE_BDF:-0}"
OWRT=/work/openwrt
BDF_NAME=board-xiaomi_ax9000.qcn9074
REPO_BDF="/src/bdf/$BDF_NAME"
BOARD_TMP=/tmp/board

# shellcheck disable=SC1091
. /src/openwrt.version   # TAG, COMMIT

# --- BDF resolution first, so a missing BDF fails fast (before any clone) ---
# The shipped BDF is "R": linux-firmware's QCN9074 reference BDF with the operating
# range set to 5170/5330 MHz (see bdf/README.md). R is a modified Qualcomm file and is
# therefore never committed: it is generated here, on the builder's machine, from the
# unmodified upstream file in bdf/upstream. A git-ignored bdf/$BDF_NAME, if present,
# overrides it (experiments; any md5 other than R's needs --force-bdf).
# Xiaomi's own bdwlan.ba0 is RX-broken on firmware HK 2.9 and is never installed
# (see docs/radio.md); --oem-firmware is only a cross-check.
UPSTREAM_BDF=/src/bdf/upstream/linux-firmware-QCN9074-hw1.0-board-2.bin
UPSTREAM_MD5=668f53050a92db5b4281ae5f26c7e35d
EXPECTED_BDF_MD5=4095ab1701d9080bbffefe3ecf8ec0f0
if [ -f "$REPO_BDF" ]; then
    echo "==> Using local BDF override: bdf/$BDF_NAME"
    BDF_SRC="$REPO_BDF"
elif [ -f "$UPSTREAM_BDF" ]; then
    up_md5="$(md5sum "$UPSTREAM_BDF" | cut -d' ' -f1)"
    if [ "$up_md5" != "$UPSTREAM_MD5" ]; then
        echo "error: $UPSTREAM_BDF has md5 $up_md5, expected $UPSTREAM_MD5 (unmodified linux-firmware file)." >&2
        echo "Restore it with: git checkout -- bdf/upstream" >&2
        exit 3
    fi
    echo "==> Generating the QCN9074 BDF (R) from bdf/upstream"
    mkdir -p "$BOARD_TMP"
    (cd /src && PYTHONDONTWRITEBYTECODE=1 python3 -m tools.bdf.build_ax9000_bdf \
        --linux-firmware "$UPSTREAM_BDF" --out "$BOARD_TMP/$BDF_NAME")
    BDF_SRC="$BOARD_TMP/$BDF_NAME"
else
    cat >&2 <<MSG
error: no board data file (BDF) available for the AX9000's QCN9074 radio.

The generator input bdf/upstream/linux-firmware-QCN9074-hw1.0-board-2.bin is missing.
Restore it from git (git checkout -- bdf/upstream), or download it from linux-firmware:
    https://git.kernel.org/pub/scm/linux/kernel/git/firmware/linux-firmware.git/plain/ath11k/QCN9074/hw1.0/board-2.bin
(md5 $UPSTREAM_MD5). See bdf/README.md.
MSG
    exit 3
fi

got_md5="$(md5sum "$BDF_SRC" | cut -d' ' -f1)"
if [ "$got_md5" != "$EXPECTED_BDF_MD5" ]; then
    if [ "$FORCE_BDF" = 1 ] || [ "${AX9000_FORCE_BDF:-0}" = 1 ]; then
        echo "WARNING: BDF md5 is $got_md5, not BDF R ($EXPECTED_BDF_MD5); continuing (--force-bdf / AX9000_FORCE_BDF=1)." >&2
    else
        echo "error: BDF md5 is $got_md5, expected $EXPECTED_BDF_MD5 (BDF R)." >&2
        echo "Delete the override bdf/$BDF_NAME to use the generated R, or, for a" >&2
        echo "deliberate experiment, pass --force-bdf (or set AX9000_FORCE_BDF=1)." >&2
        exit 3
    fi
fi

if [ -n "$OEM_FW" ]; then
    # Cross-check only: any failure here warns and the build continues.
    echo "==> Cross-checking Xiaomi stock firmware: $OEM_FW (its BDF is NOT installed)"
    force=()
    [ "$FORCE_BDF" = 1 ] && force=(--force)
    rm -rf "$BOARD_TMP/oem"; mkdir -p "$BOARD_TMP/oem"
    oem_range=""
    if (cd /src && PYTHONDONTWRITEBYTECODE=1 python3 -m tools.bdf.extract_bdf \
            --oem-firmware "$OEM_FW" --out "$BOARD_TMP/oem/$BDF_NAME" "${force[@]}"); then
        oem_range="$(cd /src && PYTHONDONTWRITEBYTECODE=1 python3 -c '
import sys
from tools.bdf.build_ax9000_bdf import read_freq_range
print("%d/%d" % read_freq_range(open(sys.argv[1], "rb").read()))' "$BOARD_TMP/oem/$BDF_NAME")" || oem_range=""
    fi
    if [ "$oem_range" = "5170/5330" ]; then
        echo "==> Xiaomi BDF operating range 5170/5330 MHz matches the shipped BDF"
    else
        echo "WARNING ##########################################################" >&2
        echo "WARNING: could not confirm the Xiaomi BDF operating range (got '${oem_range:-extraction failed}'," >&2
        echo "WARNING: expected 5170/5330 MHz). The range in the shipped BDF (R) may not" >&2
        echo "WARNING: match this firmware; see docs/radio.md. Continuing with R." >&2
        echo "WARNING ##########################################################" >&2
    fi
fi

# --- 1. OpenWrt tree pinned to $COMMIT ---------------------------------------
cd /work
git config --global --replace-all safe.directory '*'
git config --global user.name "ax9000-build"
git config --global user.email "build@ax9000.invalid"
git config --global advice.detachedHead false

if [ ! -d "$OWRT/.git" ]; then
    echo "==> Cloning OpenWrt"
    git clone https://github.com/openwrt/openwrt.git "$OWRT"
fi
cd "$OWRT"
git am --abort 2>/dev/null || true
if ! git cat-file -e "$COMMIT^{commit}" 2>/dev/null; then
    echo "==> Fetching $COMMIT"
    git fetch --tags origin
fi
git checkout -f -B ax9000 "$COMMIT"
git reset --hard "$COMMIT"
# keep download/build caches (and feeds) between runs
git clean -fdx -e dl -e .ccache -e bin -e build_dir -e staging_dir -e tmp -e feeds -e package/feeds -e logs
[ "$(git rev-parse HEAD)" = "$COMMIT" ] || { echo "error: HEAD != $COMMIT" >&2; exit 1; }
ln -sfn /work/dl dl
ln -sfn /work/ccache .ccache

# --- 2. Patches --------------------------------------------------------------
shopt -s nullglob
patches=(/src/patches/openwrt/*.patch)
if [ ${#patches[@]} -gt 0 ]; then
    echo "==> Applying ${#patches[@]} patch(es)"
    git am "${patches[@]}"
else
    echo "==> No patches to apply"
fi

# --- 3. BDF ------------------------------------------------------------------
install -D -m 0644 "$BDF_SRC" "package/firmware/ipq-wifi/src/$BDF_NAME"
echo "==> BDF sha256: $(sha256sum "package/firmware/ipq-wifi/src/$BDF_NAME" | cut -d' ' -f1)"

# --- 4. Feeds ----------------------------------------------------------------
# feeds.conf is untracked (wiped by the clean above), so recreate it each run.
cp feeds.conf.default feeds.conf
echo "src-link ax9000 /src/feed" >> feeds.conf
# The src-link feed is cheap; drop its cached package index so added/changed
# packages (scan.mk caches by file list/mtime on a bind mount) are always seen.
rm -rf feeds/ax9000 feeds/ax9000.* package/feeds/ax9000
# Same for the build-time package metadata (po/ dirs added later change the
# generated luci-i18n-* packages without touching the Makefile mtime).
rm -f tmp/info/.packageinfo-feeds_ax9000_* tmp/info/.targetinfo-feeds_ax9000_* tmp/.packageinfo tmp/.config-package.in
./scripts/feeds update -a
./scripts/feeds install -a

# --- 5. Config ---------------------------------------------------------------
cp /src/config/ax9000.config .config
# Optional personal package set (git-ignored): extra CONFIG_PACKAGE_* lines.
if [ -f /src/config/local.config ]; then
    echo "==> Appending config/local.config"
    cat /src/config/local.config >> .config
fi
make defconfig
# OpenWrt does not track files/ of our feed packages: always rebuild them, or
# edited scripts silently keep the old copy from the cached build_dir/apk.
make package/feeds/ax9000/ax9000-controls/clean package/feeds/ax9000/luci-app-ax9000-controls/clean

# --- 6. Build ----------------------------------------------------------------
make download -j8
make -j"$JOBS" || make -j1 V=s

# --- 7. Collect --------------------------------------------------------------
T=bin/targets/qualcommax/ipq807x
mkdir -p /out
rm -f /out/*.ubi /out/*.itb /out/*.bin /out/sha256sums /out/*.manifest /out/manifest
cp "$T"/*xiaomi_ax9000*.ubi "$T"/*xiaomi_ax9000*sysupgrade.bin /out/
cp "$T"/*xiaomi_ax9000*initramfs-uImage.itb /out/
cp "$T/sha256sums" /out/sha256sums
cp "$T"/*.manifest /out/
cp "$T"/*.manifest /out/manifest 2>/dev/null || true
echo "==> Done. Outputs:"
ls -l /out
