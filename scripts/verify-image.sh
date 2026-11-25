#!/usr/bin/env bash
# Static checks on a built Xiaomi AX9000 sysupgrade image (no router needed).
#
# Usage: scripts/verify-image.sh [check] [image] [expected-bdf]
#   check: radio     rootfs QCN9074 board-2.bin == expected BDF (sha256), and the
#                    QCN9074 wifi@0,0 node (pcie@20000000, Xiaomi-AX9000 variant)
#                    has ieee80211-freq-limit = <5150000 5350000>, no other node
#          fan       EMC2301 + fan_hot in the DTB, emc2305.ko with OF match
#          leds      enabled qcom,ipq8074-pwm + pwm-leds-multicolor, no gpio top-*
#          controls  ax9000-controls daemon + LuCI app files byte-identical to feed/ (md5)
#          perms     no world-writable path in the squashfs (symlinks excepted)
#          distfeeds /etc/apk/repositories.d/distfeeds.list has no ax9000 line
#          all       every check above (default)
#   image: sysupgrade .bin (default: newest /out/*xiaomi_ax9000*sysupgrade.bin,
#          else out/openwrt-qualcommax-ipq807x-xiaomi_ax9000-squashfs-sysupgrade.bin)
#   expected-bdf: default bdf/board-xiaomi_ax9000.qcn9074 if present, else BDF R
#          generated from bdf/upstream (only used by radio)
#   The pre-integration form "verify-image.sh <image> <expected-bdf>" runs "all".
#
# Runs inside the ax9000-builder container (tar, unsquashfs, dtc, python3), e.g.
#   MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd -W):/src:ro" -v "$(pwd -W)/out:/out:ro" \
#       --entrypoint bash ax9000-builder /src/scripts/verify-image.sh all \
#       /out/openwrt-qualcommax-ipq807x-xiaomi_ax9000-squashfs-sysupgrade.bin \
#       /src/bdf/board-xiaomi_ax9000.qcn9074
#
# Exit status: 0 = all requested checks PASS, 1 = a check FAILed,
#              2 = image/BDF unreadable or a tool is missing, 64 = usage error.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
CHECKS=(radio fan leds controls perms distfeeds)

usage() { sed -n 2,24p "$0" | sed 's/^# \{0,1\}//'; }

# --- arguments -----------------------------------------------------------------
check="${1:-all}"
if [ $# -ge 1 ] && [ -f "$1" ]; then
    # legacy form: <image> [expected-bdf]
    check=all; IMG="$1"; EXPECTED="${2:-}"
    [ $# -le 2 ] || { usage >&2; exit 64; }
else
    IMG="${2:-}"; EXPECTED="${3:-}"
    [ $# -le 3 ] || { usage >&2; exit 64; }
fi
case "$check" in
    -h|--help) usage; exit 0 ;;
    all) selected=("${CHECKS[@]}") ;;
    *)
        selected=()
        for c in "${CHECKS[@]}"; do [ "$c" = "$check" ] && selected=("$c"); done
        [ ${#selected[@]} -gt 0 ] || { echo "error: unknown check: $check (known: ${CHECKS[*]} all)" >&2; exit 64; }
        ;;
esac
if [ -z "$IMG" ]; then
    for f in /out/*xiaomi_ax9000*sysupgrade.bin; do [ -f "$f" ] && IMG="$f"; done
    [ -n "$IMG" ] || IMG="$REPO/out/openwrt-qualcommax-ipq807x-xiaomi_ax9000-squashfs-sysupgrade.bin"
fi
[ -f "$IMG" ] || { echo "error: image not found: $IMG" >&2; exit 2; }

need() {
    local t
    for t in "$@"; do
        command -v "$t" >/dev/null || { echo "error: missing tool: $t (run inside the ax9000-builder container)" >&2; exit 2; }
    done
}
PY="$(command -v python3 || command -v python || true)"
[ -n "$PY" ] || { echo "error: missing tool: python3" >&2; exit 2; }
need tar

# --- shared helpers ------------------------------------------------------------
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

FAILS=0
pass() { echo "PASS: $*"; }
fail() { echo "FAIL: $*"; FAILS=$((FAILS + 1)); }

# Count occurrences of a literal string in a file without piping into grep -q.
count_in_file() { grep -a -c -F -- "$1" "$2" || true; }

# Unpack the sysupgrade tarball once (kernel = FIT with raw DTBs, root = squashfs).
KERNEL="$WORK/sysupgrade/kernel"
ROOT="$WORK/sysupgrade/root"
unpack() {
    [ -d "$WORK/sysupgrade" ] && return 0
    mkdir -p "$WORK/sysupgrade"
    tar -xf "$IMG" -C "$WORK/sysupgrade" --strip-components=1 \
        || { echo "error: cannot unpack $IMG as tar" >&2; exit 2; }
    [ -f "$KERNEL" ] && [ -f "$ROOT" ] || { echo "error: no kernel/root member in $IMG" >&2; exit 2; }
}

# Extract the whole squashfs rootfs once to $WORK/rootfs (non-root cannot create
# device nodes, so unsquashfs may exit non-zero; callers check the files they need).
ROOTFS="$WORK/rootfs"
extract_rootfs() {
    [ -d "$ROOTFS" ] && return 0
    unpack
    need unsquashfs
    unsquashfs -n -d "$ROOTFS" "$ROOT" >/dev/null 2>&1 || true
    [ -d "$ROOTFS" ] || { echo "error: cannot extract squashfs rootfs" >&2; exit 2; }
}

# --- radio: QCN9074 BDF and 5 GHz frequency limit ----------------------------
check_radio() {
    need dtc sha256sum
    if [ -z "$EXPECTED" ] && [ -f "$REPO/bdf/board-xiaomi_ax9000.qcn9074" ]; then
        EXPECTED="$REPO/bdf/board-xiaomi_ax9000.qcn9074"
    elif [ -z "$EXPECTED" ]; then
        # R is never committed (license); generate it the same way the build does.
        EXPECTED="$WORK/board-xiaomi_ax9000.qcn9074"
        (cd "$REPO" && PYTHONDONTWRITEBYTECODE=1 "$PY" -m tools.bdf.build_ax9000_bdf \
            --linux-firmware bdf/upstream/linux-firmware-QCN9074-hw1.0-board-2.bin \
            --out "$EXPECTED") >/dev/null || { echo "error: could not generate BDF R from bdf/upstream" >&2; exit 2; }
    fi
    [ -f "$EXPECTED" ] || { echo "error: expected BDF not found: $EXPECTED" >&2; exit 2; }
    extract_rootfs

    # 1. BDF in rootfs (the expected BDF is "R", see bdf/README.md and docs/radio.md)
    local bdf_path=lib/firmware/ath11k/QCN9074/hw1.0/board-2.bin got want
    if [ -f "$ROOTFS/$bdf_path" ]; then
        got="$(sha256sum "$ROOTFS/$bdf_path" | cut -d' ' -f1)"
        want="$(sha256sum "$EXPECTED" | cut -d' ' -f1)"
        if [ "$got" = "$want" ]; then
            pass "radio: rootfs $bdf_path == expected BDF ($got)"
        else
            fail "radio: rootfs $bdf_path sha256 $got != expected $want"
        fi
    else
        fail "radio: $bdf_path not found in rootfs"
    fi

    # 2. frequency limit in the DTB inside the kernel FIT
    mkdir -p "$WORK/radio"
    "$PY" -I - "$KERNEL" "$WORK/radio" <<'PY'
import struct, sys
data = open(sys.argv[1], 'rb').read()
out = sys.argv[2]
magic = b'\xd0\x0d\xfe\xed'
i = n = 0
while True:
    i = data.find(magic, i)
    if i < 0:
        break
    total = struct.unpack('>I', data[i+4:i+8])[0]
    if 0x28 <= total <= len(data) - i:
        open('%s/cand%d.dtb' % (out, n), 'wb').write(data[i:i+total])
        n += 1
    i += 4
PY
    # awk program: counts wifi@0,0 nodes that sit under pcie@20000000 (pcie0, the
    # QCN9074), carry the AX9000 ath11k calibration variant and have the limit.
    local awk_prog='
/pcie@[0-9a-f][0-9a-f][0-9a-f][0-9a-f]+ *\{/ { match($0, /pcie@[0-9a-f][0-9a-f][0-9a-f][0-9a-f]+/); parent = substr($0, RSTART, RLENGTH) }
/wifi@0,0 *\{/ { inwifi = 1; hasvar = 0; haslim = 0 }
inwifi && /qcom,ath11k-calibration-variant = "Xiaomi-AX9000"/ { hasvar = 1 }
inwifi && /ieee80211-freq-limit = <0x4e9530 0x51a270>;/ { haslim = 1 }
inwifi && /^[ 	]*};/ { if (hasvar && haslim && parent == "pcie@20000000") good++; inwifi = 0 }
END { print good + 0 }'
    local found=0 checked=0 dtb good total
    for dtb in "$WORK"/radio/cand*.dtb; do
        [ -f "$dtb" ] || continue
        dtc -q -I dtb -O dts -o "$WORK/radio/cur.dts" "$dtb" 2>/dev/null || continue
        [ "$(count_in_file 'qcom,ath11k-calibration-variant = "Xiaomi-AX9000"' "$WORK/radio/cur.dts")" -gt 0 ] || continue
        checked=$((checked + 1))
        good="$(awk "$awk_prog" "$WORK/radio/cur.dts")"
        total="$(count_in_file 'ieee80211-freq-limit' "$WORK/radio/cur.dts")"
        # exactly one limit in the whole DTB, and it is on the QCN9074 node
        if [ "$good" = 1 ] && [ "$total" = 1 ]; then found=1; fi
    done
    if [ "$found" = 1 ]; then
        pass "radio: QCN9074 wifi@0,0 (pcie@20000000) has ieee80211-freq-limit = <5150000 5350000>, and no other node has one"
    elif [ "$checked" = 0 ]; then
        fail "radio: no AX9000 DTB found in kernel image"
    else
        fail "radio: ieee80211-freq-limit = <5150000 5350000> missing on the QCN9074 node, or present on another node"
    fi
}

# --- fan: EMC2301 fan controller -------------------------------------------------
check_fan() {
    unpack
    need unsquashfs
    local s n ko=""
    for s in microchip,emc2301 fan_hot; do
        n="$(count_in_file "$s" "$KERNEL")"
        if [ "${n:-0}" -gt 0 ]; then pass "fan: DTB contains '$s'"; else fail "fan: DTB lacks '$s'"; fi
    done
    unsquashfs -ll "$ROOT" > "$WORK/root.list" 2>/dev/null || true
    n="$(count_in_file "emc2305.ko" "$WORK/root.list")"
    if [ "${n:-0}" -gt 0 ]; then pass "fan: rootfs contains emc2305.ko"; else fail "fan: rootfs lacks emc2305.ko"; fi

    # The stock 6.12 driver has no OF match table; the backported one embeds
    # the "microchip,emc2305" compatible string.
    extract_rootfs
    for s in "$ROOTFS"/lib/modules/*/emc2305.ko; do ko="$s"; done
    if [ -f "$ko" ]; then
        n="$(count_in_file "microchip,emc2305" "$ko")"
        if [ "${n:-0}" -gt 0 ]; then pass "fan: emc2305.ko has OF match (microchip,emc2305)"; else fail "fan: emc2305.ko lacks OF support"; fi
    else
        fail "fan: could not extract emc2305.ko from rootfs"
    fi
}

# --- leds: hardware-PWM RGB X light --------------------------------------------
NODES="$WORK/fdt_nodes.tsv"   # <path>\t<compatibles>\t<status>, filled by load_nodes
load_nodes() {
    [ -f "$NODES" ] && return 0
    "$PY" -I "$HERE/fdt_nodes.py" "$IMG" > "$NODES" || { rm -f "$NODES"; exit 2; }
}

# Node paths whose compatible list contains $1 and whose status is okay/ok.
enabled_with_compatible() {
    awk -F'\t' -v c="$1" '
        ($3 == "okay" || $3 == "ok") {
            n = split($2, list, " ")
            for (i = 1; i <= n; i++) if (list[i] == c) { print $1; break }
        }' "$NODES"
}

# Enabled nodes whose path is exactly $1.
enabled_path() {
    awk -F'\t' -v p="$1" '$1 == p && ($3 == "okay" || $3 == "ok")' "$NODES"
}

check_leds() {
    load_nodes
    local found
    found="$(enabled_with_compatible qcom,ipq8074-pwm)"
    if [ -n "$found" ]; then
        pass "leds: PWM controller qcom,ipq8074-pwm enabled at ${found//$'\n'/ }"
    else
        fail "leds: no enabled node with compatible qcom,ipq8074-pwm"
    fi

    found="$(enabled_with_compatible pwm-leds-multicolor)"
    if [ -n "$found" ]; then
        pass "leds: pwm-leds-multicolor at ${found//$'\n'/ }"
    else
        fail "leds: no enabled node with compatible pwm-leds-multicolor"
    fi

    # The X light GPIOs must not also be claimed by gpio-leds.
    local stale=0 n
    for n in /leds/top-red /leds/top-green /leds/top-blue; do
        if [ -n "$(enabled_path "$n")" ]; then
            fail "leds: stale gpio-leds node $n still present"
            stale=1
        fi
    done
    [ "$stale" = 1 ] || pass "leds: no gpio-leds node for GPIO 63/64/66 (top-*)"
}

# --- controls: shipped ax9000-controls files == repo ------------------------------
# Guards against a stale cached package build.
check_controls() {
    extract_rootfs
    local files="$REPO/feed/ax9000-controls/files" want rel checked=0
    for want in "$files"/usr/sbin/ax9000-* "$files"/etc/init.d/ax9000-* \
                "$files"/etc/uci-defaults/*-ax9000-* "$files"/usr/share/rpcd/ucode/ax9000-*.uc \
                "$files"/usr/share/ax9000/*.uc; do
        [ -f "$want" ] || continue
        checked=$((checked + 1))
        rel="${want#"$files"/}"
        if [ ! -f "$ROOTFS/$rel" ]; then fail "controls: rootfs lacks /$rel"; continue; fi
        if [ "$(md5sum < "$ROOTFS/$rel")" = "$(md5sum < "$want")" ]; then
            pass "controls: /$rel matches repo"
        else
            fail "controls: /$rel differs from repo (stale build?)"
        fi
    done
    [ "$checked" -gt 0 ] || fail "controls: no daemon files found under $files"

    # LuCI app files (separate package, same stale-cache risk)
    local luci="$REPO/feed/luci-app-ax9000-controls" lchecked=0
    for want in "$luci"/htdocs/luci-static/resources/view/ax9000/*.js "$luci"/htdocs/luci-static/resources/ax9000/*.js                 "$luci"/root/usr/share/rpcd/acl.d/*.json "$luci"/root/usr/share/luci/menu.d/*.json; do
        [ -f "$want" ] || continue
        lchecked=$((lchecked + 1))
        case "$want" in
            */htdocs/*) rel="www/${want#"$luci"/htdocs/}" ;;
            *) rel="${want#"$luci"/root/}" ;;
        esac
        if [ ! -f "$ROOTFS/$rel" ]; then fail "controls: rootfs lacks /$rel"; continue; fi
        case "$want" in
            *.js)   # luci.mk minifies JS, so only presence and a few sentinel strings can be checked
                if [ -s "$ROOTFS/$rel" ] && grep -q "ax9000" "$ROOTFS/$rel"; then
                    pass "controls: /$rel present (minified, not byte-compared)"
                else
                    fail "controls: /$rel missing content"
                fi ;;
            *)
                if [ "$(md5sum < "$ROOTFS/$rel")" = "$(md5sum < "$want")" ]; then
                    pass "controls: /$rel matches repo"
                else
                    fail "controls: /$rel differs from repo (stale build?)"
                fi ;;
        esac
    done
    [ "$lchecked" -gt 0 ] || fail "controls: no LuCI files found under $luci"
}

# --- perms: nothing in the rootfs is world-writable ---------------------------------
# NTFS bind mounts make every source file 0777; rpcd then refuses its ucode plugins.
# Reads modes from the squashfs itself (unsquashfs -lln), so it needs no root.
check_perms() {
    unpack
    need unsquashfs
    local listing="$WORK/rootfs.lln" bad n
    unsquashfs -n -lln "$ROOT" > "$listing" 2>/dev/null         || { echo "error: cannot list squashfs $ROOT" >&2; exit 2; }
    n="$(grep -c '^[-dlcbps][rwxsStT-]\{9\} ' "$listing" || true)"
    [ "$n" -gt 100 ] || { fail "perms: squashfs listing looks empty ($n entries)"; return; }
    # mode column: 2nd char onward is rwx for user/group/other; "other" write = 9th char.
    # Symlinks (l) are always 0777 and are skipped; /tmp-like dirs are sticky (t/T).
    bad="$(awk '$1 ~ /^[-dcbps][rwxsStT-]{9}$/ && substr($1,9,1) == "w" {
                 if (substr($1,1,1) == "d" && substr($1,10,1) ~ /[tT]/) next
                 print }' "$listing")"
    if [ -z "$bad" ]; then
        pass "perms: no world-writable file or directory in the rootfs ($n entries)"
    else
        fail "perms: world-writable paths in the rootfs:"
        echo "$bad" | sed 's/^/    /'
    fi
    # the package directories must be exactly 0755 / data files 0644
    local p
    for p in usr/share usr/share/rpcd usr/share/rpcd/ucode usr/share/ax9000; do
        if awk -v p="squashfs-root/$p" '$NF == p && $1 == "drwxr-xr-x" { f = 1 } END { exit !f }' "$listing"; then
            pass "perms: /$p is drwxr-xr-x"
        else
            fail "perms: /$p is not drwxr-xr-x"
        fi
    done
}

# --- distfeeds: the local ax9000 feed must not be advertised to apk ----------------
check_distfeeds() {
    extract_rootfs
    local f="$ROOTFS/etc/apk/repositories.d/distfeeds.list"
    if [ ! -f "$f" ]; then fail "distfeeds: /etc/apk/repositories.d/distfeeds.list missing"; return; fi
    if grep -q "ax9000" "$f"; then
        fail "distfeeds: ax9000 feed listed (downloads.openwrt.org has none):"
        grep "ax9000" "$f" | sed 's/^/    /'
    else
        pass "distfeeds: no ax9000 line ($(grep -c . "$f") feed lines)"
    fi
}

# --- main --------------------------------------------------------------------
echo "image: $IMG"
for c in "${selected[@]}"; do "check_$c"; done

if [ "$FAILS" -gt 0 ]; then
    echo "RESULT: FAIL ($FAILS)"
    exit 1
fi
echo "RESULT: PASS"
