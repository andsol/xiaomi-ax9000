import hashlib
import os
import subprocess
import sys
from pathlib import Path

import pytest

from tools.bdf.board2 import AX9000_BOARD_NAME, parse_board2
from tools.bdf.xiaomi_fw import find_ubi_offset

OEM = Path(os.environ.get("AX9000_OEM_FIRMWARE", "/firmware/miwifi_ra70_firmware_cc424_1.0.168.bin"))
REPO = Path(__file__).resolve().parents[3]


def md5(b):
    return hashlib.md5(b).hexdigest()


def run_cli(*args):
    return subprocess.run(
        [sys.executable, "-m", "tools.bdf.extract_bdf", *map(str, args)],
        capture_output=True, text=True, cwd=REPO, stdin=subprocess.DEVNULL,
    )


def test_find_ubi_offset():
    assert find_ubi_offset(b"HDR1" + b"\0" * 0x2b0 + b"UBI#rest") == 0x2b4


def test_find_ubi_offset_missing():
    with pytest.raises(ValueError):
        find_ubi_offset(b"HDR1" + b"\0" * 64)


def test_rejects_non_xiaomi_file(tmp_path):
    f = tmp_path / "x.bin"
    f.write_bytes(b"\0" * 4096)
    r = run_cli("--oem-firmware", f, "--out", tmp_path / "o")
    assert r.returncode == 2 and "not a Xiaomi HDR1 image" in r.stderr
    assert not (tmp_path / "o").exists()


def test_rejects_unknown_version(tmp_path):
    f = tmp_path / "x.bin"
    f.write_bytes(b"HDR1" + b"\0" * 0x2b0 + b"UBI#" + b"\0" * 64)
    r = run_cli("--oem-firmware", f, "--out", tmp_path / "o")
    assert r.returncode == 2
    assert "unknown firmware version " + md5(f.read_bytes()) in r.stderr
    assert "--force" in r.stderr
    assert not (tmp_path / "o").exists()


@pytest.mark.skipif(not OEM.exists(), reason="stock firmware not present")
def test_extract_known_firmware(tmp_path):
    out = tmp_path / "board"
    r = run_cli("--oem-firmware", OEM, "--out", out)
    assert r.returncode == 0, r.stderr
    e = parse_board2(out.read_bytes())
    assert md5(e[AX9000_BOARD_NAME]) == "ea8348db8af87a248e95a8cf50a212bf"
