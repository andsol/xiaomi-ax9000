#!/usr/bin/env python3
"""List device tree nodes of an OpenWrt image, one per line.

Usage: fdt_nodes.py <sysupgrade.bin | FIT kernel | .dtb>

Output (tab separated): <node path> <compatibles, space separated> <status>
Status is "okay" when the node has no status property. Only the standard
library is used, so this runs in the builder container and on the host.
"""
import gzip
import io
import lzma
import struct
import sys
import tarfile

FDT_MAGIC = 0xD00DFEED
FDT_BEGIN_NODE, FDT_END_NODE, FDT_PROP, FDT_NOP, FDT_END = 1, 2, 3, 4, 9


def parse_fdt(blob):
    """Return {path: {prop: bytes}} for a flattened device tree blob."""
    magic, totalsize, off_struct, off_strings = struct.unpack_from(">IIII", blob, 0)
    if magic != FDT_MAGIC:
        raise ValueError("not a flattened device tree")
    blob = blob[:totalsize]
    nodes, stack, pos = {}, [], off_struct
    while True:
        (token,) = struct.unpack_from(">I", blob, pos)
        pos += 4
        if token == FDT_BEGIN_NODE:
            end = blob.index(b"\0", pos)
            name = blob[pos:end].decode()
            pos = (end + 4) & ~3
            stack.append(name)
            path = "/" + "/".join(s for s in stack if s)
            nodes[path] = {}
        elif token == FDT_END_NODE:
            stack.pop()
        elif token == FDT_PROP:
            length, nameoff = struct.unpack_from(">II", blob, pos)
            pos += 8
            pname_end = blob.index(b"\0", off_strings + nameoff)
            pname = blob[off_strings + nameoff:pname_end].decode()
            nodes["/" + "/".join(s for s in stack if s)][pname] = blob[pos:pos + length]
            pos = (pos + length + 3) & ~3
        elif token == FDT_NOP:
            continue
        elif token == FDT_END:
            return nodes
        else:
            raise ValueError("bad FDT token %d at %#x" % (token, pos - 4))


def strings(value):
    return [s.decode() for s in value.split(b"\0") if s]


def dtbs_from_fit(fit):
    """Yield the flat_dt images embedded in a FIT (itself an FDT)."""
    nodes = parse_fdt(fit)
    for path, props in nodes.items():
        if not path.startswith("/images/") or path.count("/") != 2:
            continue
        if strings(props.get("type", b"")) != ["flat_dt"]:
            continue
        data = props.get("data")
        if data is None:
            continue
        comp = strings(props.get("compression", b"none"))
        comp = comp[0] if comp else "none"
        if comp == "gzip":
            data = gzip.decompress(data)
        elif comp == "lzma":
            data = lzma.decompress(data)
        elif comp != "none":
            raise ValueError("%s: unsupported compression %s" % (path, comp))
        yield data


def load_dtbs(path):
    with open(path, "rb") as f:
        raw = f.read()
    if tarfile.is_tarfile(path):
        with tarfile.open(fileobj=io.BytesIO(raw)) as tar:
            member = next((m for m in tar.getmembers()
                           if m.isfile() and m.name.endswith("/kernel")), None)
            if member is None:
                raise ValueError("no */kernel member in sysupgrade tar")
            raw = tar.extractfile(member).read()
    if struct.unpack_from(">I", raw, 0)[0] != FDT_MAGIC:
        raise ValueError("not a FIT image or DTB")
    fit_nodes = parse_fdt(raw)
    if "/images" in fit_nodes:
        dtbs = list(dtbs_from_fit(raw))
        if not dtbs:
            raise ValueError("FIT image contains no flat_dt image")
        return dtbs
    return [raw]


def main():
    if len(sys.argv) != 2:
        sys.stderr.write(__doc__)
        return 64
    try:
        dtbs = load_dtbs(sys.argv[1])
    except (OSError, ValueError, tarfile.TarError) as e:
        sys.stderr.write("fdt_nodes: %s: %s\n" % (sys.argv[1], e))
        return 1
    for dtb in dtbs:
        for path, props in parse_fdt(dtb).items():
            comp = " ".join(strings(props.get("compatible", b"")))
            status = strings(props.get("status", b"okay"))
            print("%s\t%s\t%s" % (path, comp, status[0] if status else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
