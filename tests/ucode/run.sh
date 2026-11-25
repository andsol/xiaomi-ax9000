#!/bin/sh
# Runs every tests/ucode/test_*.uc with the host ucode and exits non-zero if
# any of them fails. Run it inside the builder container (see docs/development):
#   ./build.sh --shell   then   sh /src/tests/ucode/run.sh
# Override the interpreter with UCODE=/path/to/ucode.
UCODE="${UCODE:-/work/openwrt/staging_dir/hostpkg/bin/ucode}"
DIR="$(cd "$(dirname "$0")" && pwd)"
MODDIR="$DIR/../../feed/ax9000-controls/files/usr/share/ax9000"

if [ ! -x "$UCODE" ]; then
	echo "error: ucode not found at $UCODE (build once first, or set UCODE=)" >&2
	exit 2
fi

fail=0
n=0
for t in "$DIR"/test_*.uc; do
	[ -e "$t" ] || continue
	n=$((n + 1))
	echo "== $(basename "$t")"
	if ! "$UCODE" -L "$MODDIR/*.uc" -L "$DIR/*.uc" "$t"; then
		echo "FAILED: $(basename "$t")" >&2
		fail=$((fail + 1))
	fi
done

if [ "$n" -eq 0 ]; then
	echo "error: no tests found in $DIR" >&2
	exit 2
fi
for t in "$DIR"/../sh/test_*.sh; do
	[ -e "$t" ] || continue
	n=$((n + 1))
	echo "== $(basename "$t")"
	sh "$t" || { echo "FAILED: $(basename "$t")" >&2; fail=$((fail + 1)); }
done

echo "$n test file(s), $fail failed"
[ "$fail" -eq 0 ]
