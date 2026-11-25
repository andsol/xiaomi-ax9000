"""Helpers for pulling the QCN9074 BDF out of a Xiaomi AX9000 stock image."""
import hashlib
import shutil
import subprocess
from pathlib import Path

HDR_MAGIC = b"HDR1"
UBI_MAGIC = b"UBI#"
BDF_PATH = "lib/firmware/IPQ8074/WIFI_FW/qcn9000/bdwlan.ba0"
BDF_SIZE = 131072


def is_xiaomi_image(data: bytes) -> bool:
    return data.startswith(HDR_MAGIC)


def md5_hex(data: bytes) -> str:
    return hashlib.md5(data).hexdigest()


def find_ubi_offset(data: bytes) -> int:
    off = data.find(UBI_MAGIC)
    if off < 0:
        raise ValueError("no UBI image found in firmware")
    return off


def _run(cmd):
    if shutil.which(cmd[0]) is None:
        raise RuntimeError(f"required tool '{cmd[0]}' not found in PATH "
                           "(pip install ubi_reader; apt install squashfs-tools)")
    r = subprocess.run(cmd, capture_output=True, text=True, stdin=subprocess.DEVNULL)
    if r.returncode != 0:
        raise RuntimeError(f"{cmd[0]} failed ({r.returncode}): {r.stderr.strip() or r.stdout.strip()}")


def extract_qcn9000_bdf(fw_path: Path, workdir: Path) -> bytes:
    workdir = Path(workdir)
    workdir.mkdir(parents=True, exist_ok=True)
    data = Path(fw_path).read_bytes()
    ubi = workdir / "firmware.ubi"
    ubi.write_bytes(data[find_ubi_offset(data):])
    del data
    images = workdir / "images"
    _run(["ubireader_extract_images", "-o", str(images), str(ubi)])
    vols = sorted(images.glob("*/*_vol-ubi_rootfs.ubifs"))
    if not vols:
        raise RuntimeError("no ubi_rootfs volume found in UBI image")
    root = workdir / "rootfs"
    _run(["unsquashfs", "-d", str(root), str(vols[0]), BDF_PATH])  # only the BDF: avoids device nodes (needs root)
    bdf = root / BDF_PATH
    if not bdf.is_file():
        raise RuntimeError(f"{BDF_PATH} not found in rootfs")
    return bdf.read_bytes()
