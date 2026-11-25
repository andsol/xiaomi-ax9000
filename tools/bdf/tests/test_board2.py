import hashlib
from pathlib import Path

import pytest

from tools.bdf.board2 import AX9000_BOARD_NAME, pack_board2, parse_board2

FIXTURE = Path(__file__).parent / "fixtures" / "stock-openwrt-qcn9074-board-2.bin"


def md5(b):
    return hashlib.md5(b).hexdigest()


def test_parse_stock_fixture():
    e = parse_board2(FIXTURE.read_bytes())
    assert list(e) == [AX9000_BOARD_NAME]
    assert md5(e[AX9000_BOARD_NAME]) == "c7304445d977b69a98ed2ff4e6955bbf"


def test_roundtrip_is_byte_exact():
    raw = FIXTURE.read_bytes()
    assert pack_board2(parse_board2(raw)) == raw


def test_pack_single_bdf_size():
    out = pack_board2({AX9000_BOARD_NAME: b"\x01" * 131072})
    assert len(out) == 131176


def test_parse_rejects_bad_magic():
    with pytest.raises(ValueError, match="magic"):
        parse_board2(b"NOT-A-BOARD-FILE")


def test_regdb_and_odd_lengths_roundtrip():
    entries = {"a,b": b"abcde", "REGDB:bus=pci": b"xyz", AX9000_BOARD_NAME: b"\x02" * 8}
    assert parse_board2(pack_board2(entries)) == entries


def test_parse_rejects_truncated():
    raw = FIXTURE.read_bytes()
    with pytest.raises(ValueError):
        parse_board2(raw[:-10])
