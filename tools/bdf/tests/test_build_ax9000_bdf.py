import hashlib
import struct
from pathlib import Path

import pytest

from tools.bdf.board2 import AX9000_BOARD_NAME, parse_board2
from tools.bdf.build_ax9000_bdf import (
    FREQ_OFFSET,
    REFERENCE_ENTRY,
    build_r,
    fix_checksum,
    read_freq_range,
    verify_checksum,
)

UPSTREAM = (Path(__file__).parents[3] / "bdf" / "upstream"
            / "linux-firmware-QCN9074-hw1.0-board-2.bin")
R_MD5 = "4095ab1701d9080bbffefe3ecf8ec0f0"


@pytest.fixture(scope="module")
def reference():
    return UPSTREAM.read_bytes()


@pytest.fixture(scope="module")
def ref_bdf(reference):
    return parse_board2(reference)[REFERENCE_ENTRY]


def test_reference_checksum_is_valid(ref_bdf):
    assert verify_checksum(ref_bdf)


def test_verify_detects_corruption(ref_bdf):
    bad = bytearray(ref_bdf)
    bad[0x100] ^= 1
    assert not verify_checksum(bytes(bad))


def test_fix_checksum_repairs(ref_bdf):
    bad = bytearray(ref_bdf)
    bad[0x8ca] ^= 0x55
    assert not verify_checksum(bytes(bad))
    fix_checksum(bad)
    assert verify_checksum(bytes(bad))


def test_build_r_md5(reference):
    assert hashlib.md5(build_r(reference)).hexdigest() == R_MD5


def test_build_r_range_fields(reference):
    bdf = parse_board2(build_r(reference))[AX9000_BOARD_NAME]
    assert struct.unpack_from("<HH", bdf, FREQ_OFFSET) == (5170, 5330)
    assert verify_checksum(bdf)


def test_build_r_only_expected_bytes_differ(reference, ref_bdf):
    bdf = parse_board2(build_r(reference))[AX9000_BOARD_NAME]
    assert len(bdf) == len(ref_bdf)
    allowed = set(range(0x8ca, 0x8ce)) | {0x0a, 0x0b}
    diff = {i for i in range(len(bdf)) if bdf[i] != ref_bdf[i]}
    assert diff <= allowed
    assert {0x8ca, 0x8cb, 0x8cc, 0x8cd} & diff  # the range really changed


def test_read_freq_range(reference):
    assert read_freq_range(build_r(reference)) == (5170, 5330)


def test_missing_entry_raises():
    from tools.bdf.board2 import pack_board2
    with pytest.raises(ValueError, match="no entry"):
        build_r(pack_board2({"bus=pci,qmi-chip-id=0,qmi-board-id=1": bytes(131072)}))


def test_cli_writes_r(tmp_path):
    import subprocess
    import sys
    out = tmp_path / "r.bin"
    r = subprocess.run(
        [sys.executable, "-m", "tools.bdf.build_ax9000_bdf",
         "--linux-firmware", str(UPSTREAM), "--out", str(out)],
        capture_output=True, text=True, cwd=Path(__file__).parents[3],
        stdin=subprocess.DEVNULL)
    assert r.returncode == 0, r.stderr
    assert hashlib.md5(out.read_bytes()).hexdigest() == R_MD5


def test_cli_bad_input_fails(tmp_path):
    import subprocess
    import sys
    bad = tmp_path / "bad.bin"
    bad.write_bytes(b"nope")
    r = subprocess.run(
        [sys.executable, "-m", "tools.bdf.build_ax9000_bdf",
         "--linux-firmware", str(bad), "--out", str(tmp_path / "o")],
        capture_output=True, text=True, cwd=Path(__file__).parents[3],
        stdin=subprocess.DEVNULL)
    assert r.returncode == 1 and "error" in r.stderr
