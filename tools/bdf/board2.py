"""Parser and packer for the ath11k board-2.bin container format."""
import struct

MAGIC = b"QCA-ATH11K-BOARD\0"
# The stock files pad the magic to 4 bytes with 'm' (as ath11k's own tooling does).
MAGIC_PAD = b"mmm"
ATH11K_BD_IE_BOARD = 0
ATH11K_BD_IE_REGDB = 2
NAME = 0
DATA = 1
REGDB_PREFIX = "REGDB:"
AX9000_BOARD_NAME = "bus=pci,qmi-chip-id=0,qmi-board-id=255,variant=Xiaomi-AX9000"


def _pad(n):
    return -n % 4


def _read_ies(data, pos, end):
    while pos < end:
        if end - pos < 8:
            raise ValueError("truncated IE header")
        ie_id, length = struct.unpack_from("<II", data, pos)
        pos += 8
        if pos + length > end:
            raise ValueError("truncated IE body")
        yield ie_id, data[pos:pos + length]
        pos += length + _pad(length)


def parse_board2(data: bytes) -> dict[str, bytes]:
    if not data.startswith(MAGIC):
        raise ValueError("bad board-2.bin magic")
    pos = len(MAGIC) + _pad(len(MAGIC))
    entries = {}
    for ie_id, body in _read_ies(data, pos, len(data)):
        if ie_id not in (ATH11K_BD_IE_BOARD, ATH11K_BD_IE_REGDB):
            continue
        name = bdf = None
        for sub_id, sub in _read_ies(body, 0, len(body)):
            if sub_id == NAME:
                name = sub.decode("ascii")
            elif sub_id == DATA:
                bdf = sub
        if name is None or bdf is None:
            raise ValueError("entry missing name or data")
        if ie_id == ATH11K_BD_IE_REGDB:
            name = REGDB_PREFIX + name
        entries[name] = bdf
    return entries


def _ie(ie_id, body):
    return struct.pack("<II", ie_id, len(body)) + body + b"\0" * _pad(len(body))


def pack_board2(entries: dict[str, bytes]) -> bytes:
    out = bytearray(MAGIC + MAGIC_PAD[:_pad(len(MAGIC))])
    for name, bdf in entries.items():
        ie_id = ATH11K_BD_IE_BOARD
        if name.startswith(REGDB_PREFIX):
            ie_id = ATH11K_BD_IE_REGDB
            name = name[len(REGDB_PREFIX):]
        out += _ie(ie_id, _ie(NAME, name.encode("ascii")) + _ie(DATA, bdf))
    return bytes(out)
