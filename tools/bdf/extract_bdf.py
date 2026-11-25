"""CLI: extract the QCN9074 BDF from Xiaomi stock firmware into a board-2.bin."""
import argparse
import json
import sys
import tempfile
from pathlib import Path

from tools.bdf.board2 import AX9000_BOARD_NAME, pack_board2
from tools.bdf.xiaomi_fw import (BDF_SIZE, extract_qcn9000_bdf, is_xiaomi_image,
                                 md5_hex)

KNOWN = Path(__file__).with_name("known_firmware.json")


def fail(msg):
    print(f"error: {msg}", file=sys.stderr)
    return 2


def main(argv=None):
    ap = argparse.ArgumentParser(prog="extract_bdf")
    ap.add_argument("--oem-firmware", required=True, type=Path)
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--force", action="store_true",
                    help="allow an unknown firmware version of the same model")
    args = ap.parse_args(argv)

    fw = args.oem_firmware
    if not fw.is_file():
        return fail(f"{fw}: file not found")
    with open(fw, "rb") as f:
        head = f.read(4)
    if not is_xiaomi_image(head):
        return fail(f"{fw}: not a Xiaomi HDR1 image")
    md5 = md5_hex(fw.read_bytes())
    known = json.loads(KNOWN.read_text()).get(md5)
    if known is None:
        if not args.force:
            return fail(f"{fw}: unknown firmware version {md5}, rerun with --force")
        print(f"warning: {fw}: unknown firmware version {md5}, continuing (--force)",
              file=sys.stderr)

    try:
        with tempfile.TemporaryDirectory(prefix="ax9000-bdf-") as tmp:
            bdf = extract_qcn9000_bdf(fw, Path(tmp))
    except (RuntimeError, ValueError) as e:
        return fail(f"{fw}: {e}")

    if len(bdf) != BDF_SIZE:
        return fail(f"{fw}: unexpected BDF size {len(bdf)} (expected {BDF_SIZE})")
    if known is not None and md5_hex(bdf) != known["bdwlan_ba0_md5"]:
        return fail(f"{fw}: BDF md5 {md5_hex(bdf)} does not match expected "
                    f"{known['bdwlan_ba0_md5']}")
    if known is None:
        print(f"warning: BDF md5 is {md5_hex(bdf)}", file=sys.stderr)

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_bytes(pack_board2({AX9000_BOARD_NAME: bdf}))
    print(f"wrote {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
