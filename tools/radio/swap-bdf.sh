#!/bin/sh
# Swap the QCN9074 board data file on a running router, reboot, and report.
#
# Usage: tools/radio/swap-bdf.sh <host> <board-2.bin>
#   <host>  ssh destination of the router, e.g. root@192.0.2.1 (anything ssh accepts;
#           set SSH_OPTS for extra options such as "-i ~/.ssh/key")
#
# Installs <board-2.bin> as /lib/firmware/ath11k/QCN9074/hw1.0/board-2.bin. The first
# time, the file that was there is kept as board-2.bin_stock (never overwritten later).
# The file is streamed through "ssh ... cat >" because dropbear has no sftp/scp -O.
# Then reboots, waits for ssh, and prints the md5 of the active file and `iw dev`.
# Restore the previous file with: swap-bdf.sh <host> <a saved copy>, or on the router:
#   cp /lib/firmware/ath11k/QCN9074/hw1.0/board-2.bin_stock <same dir>/board-2.bin
set -eu

[ $# -eq 2 ] || { sed -n 2,14p "$0" >&2; exit 64; }
HOST="$1"; FILE="$2"
[ -f "$FILE" ] || { echo "error: file not found: $FILE" >&2; exit 2; }
DIR=/lib/firmware/ath11k/QCN9074/hw1.0
# shellcheck disable=SC2086
SSH="ssh -o BatchMode=yes -o ConnectTimeout=5 ${SSH_OPTS:-}"

echo "==> local md5: $(md5sum "$FILE" | cut -d' ' -f1)"
$SSH "$HOST" "[ -f $DIR/board-2.bin_stock ] || cp $DIR/board-2.bin $DIR/board-2.bin_stock; if cat > $DIR/board-2.bin.new; then mv $DIR/board-2.bin.new $DIR/board-2.bin && sync; else rm -f $DIR/board-2.bin.new; exit 1; fi" < "$FILE"
echo "==> installed; rebooting"
$SSH "$HOST" reboot || true

sleep 15
echo "==> waiting for ssh"
i=0
until $SSH "$HOST" true 2>/dev/null; do
    i=$((i + 1))
    [ "$i" -le 60 ] || { echo "error: $HOST did not come back within ~5 minutes" >&2; exit 1; }
    sleep 5
done
sleep 10   # let wifi finish coming up

echo "==> active board-2.bin md5:"
$SSH "$HOST" "md5sum $DIR/board-2.bin"
echo "==> iw dev:"
$SSH "$HOST" "iw dev"
