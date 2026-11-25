"""Build the shipped AX9000 QCN9074 board data file ("R").

R is the linux-firmware QCN9074 BDF for qmi-board-id=160 (template 3.1.1) with the
operating-frequency range (u16 LE pair at 0x8ca/0x8cc) set to Xiaomi's 5170-5330 MHz,
the checksum recomputed, packed under the AX9000 board name. See docs/radio.md.

    python3 -m tools.bdf.build_ax9000_bdf --linux-firmware <board-2.bin> --out <file>
"""
import argparse
import struct
import sys

from tools.bdf.board2 import AX9000_BOARD_NAME, pack_board2, parse_board2

REFERENCE_ENTRY = "bus=pci,qmi-chip-id=0,qmi-board-id=160"
CHECKSUM_OFFSET = 0x0A
FREQ_OFFSET = 0x8CA
FREQ_RANGE = (5170, 5330)  # MHz, from Xiaomi's bdwlan.ba0


def _xor_words(bdf: bytes) -> int:
    if len(bdf) % 2:
        raise ValueError("BDF length must be even")
    x = 0
    for (w,) in struct.iter_unpack("<H", bdf):
        x ^= w
    return x


def verify_checksum(bdf: bytes) -> bool:
    """True if the XOR of all little-endian 16-bit words equals 0xFFFF."""
    return _xor_words(bdf) == 0xFFFF


def fix_checksum(bdf: bytearray) -> None:
    """Recompute the u16 at 0x0a in place so that verify_checksum() holds."""
    struct.pack_into("<H", bdf, CHECKSUM_OFFSET, 0)
    struct.pack_into("<H", bdf, CHECKSUM_OFFSET, _xor_words(bytes(bdf)) ^ 0xFFFF)


def build_r(reference_board2: bytes) -> bytes:
    """Return the packed board-2.bin for R, given linux-firmware's QCN9074 board-2.bin."""
    entries = parse_board2(reference_board2)
    if REFERENCE_ENTRY not in entries:
        raise ValueError(f"reference board-2.bin has no entry {REFERENCE_ENTRY!r}")
    bdf = bytearray(entries[REFERENCE_ENTRY])
    struct.pack_into("<HH", bdf, FREQ_OFFSET, *FREQ_RANGE)
    fix_checksum(bdf)
    assert verify_checksum(bytes(bdf))
    return pack_board2({AX9000_BOARD_NAME: bytes(bdf)})


def read_freq_range(board2: bytes) -> tuple[int, int]:
    """Operating-frequency range (MHz) of the single BDF inside a packed board-2.bin."""
    bdf = next(iter(parse_board2(board2).values()))
    return struct.unpack_from("<HH", bdf, FREQ_OFFSET)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--linux-firmware", required=True,
                    help="linux-firmware ath11k/QCN9074/hw1.0/board-2.bin")
    ap.add_argument("--out", required=True, help="output file")
    args = ap.parse_args(argv)
    try:
        with open(args.linux_firmware, "rb") as f:
            out = build_r(f.read())
    except (OSError, ValueError) as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
    with open(args.out, "wb") as f:
        f.write(out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
