# Board data file (BDF) for the QCN9074 radio

The build generates `board-xiaomi_ax9000.qcn9074` ("R", below) from the unmodified
upstream file in `upstream/` and installs it as
`/lib/firmware/ath11k/QCN9074/hw1.0/board-2.bin` through the OpenWrt
`ipq-wifi-xiaomi_ax9000` package (see `patches/openwrt/0001-*`). R itself is **not**
in this repository (see [Redistribution](#redistribution-status-of-r-important)).

## What it is ("R")

R is the Qualcomm reference BDF for the QCN9074 from linux-firmware
(`ath11k/QCN9074/hw1.0/board-2.bin`, entry `bus=pci,qmi-chip-id=0,qmi-board-id=160`,
BDF template 3.1.1), with exactly two changes:

1. the operating-frequency range (u16 little-endian pair at BDF offsets `0x8ca`/`0x8cc`)
   is set to **5170 / 5330 MHz**, the range found in Xiaomi's own `bdwlan.ba0`;
2. the checksum (u16 at offset `0x0a`) is recomputed so that the XOR of all
   little-endian 16-bit words is `0xFFFF`.

The result is packed under the AX9000 board name
`bus=pci,qmi-chip-id=0,qmi-board-id=255,variant=Xiaomi-AX9000`.
Expected md5 of the generated file: `4095ab1701d9080bbffefe3ecf8ec0f0`.

Why this and not Xiaomi's own file: see [docs/radio.md](../docs/radio.md). In short,
Xiaomi's BDF (template 1.0.3, written for firmware HK 2.3) leaves the radio unable to
receive on firmware HK 2.9, while R works on real hardware and restricts the radio to
channels 36-64 at firmware level.

## Generating

The build does this on every run (`scripts/build-openwrt.sh`). By hand:

```sh
python3 -m tools.bdf.build_ax9000_bdf \
    --linux-firmware bdf/upstream/linux-firmware-QCN9074-hw1.0-board-2.bin \
    --out bdf/board-xiaomi_ax9000.qcn9074
md5sum bdf/board-xiaomi_ax9000.qcn9074   # 4095ab1701d9080bbffefe3ecf8ec0f0
```

A file at `bdf/board-xiaomi_ax9000.qcn9074` is git-ignored and, if present, overrides
the generated one (the build rejects it unless its md5 is R's or `--force-bdf` is given).
Tests: `python3 -m pytest tools/bdf`.

## Upstream input

`upstream/linux-firmware-QCN9074-hw1.0-board-2.bin` (md5 `668f53050a92db5b4281ae5f26c7e35d`) is an
unmodified copy of

    https://git.kernel.org/pub/scm/linux/kernel/git/firmware/linux-firmware.git/plain/ath11k/QCN9074/hw1.0/board-2.bin

Last commit touching that file: `f56505fe2e45d02a15b2a2308199291e66ee3494`
("ath11k: QCN9074 hw1.0: add board-2.bin", 2022-04-23); linux-firmware `main` was at
`a1ebb5ad7eae3caca60b8b3db5792cf43339ba58` when it was fetched (2026-11-22).

License: linux-firmware's `WHENCE` lists `ath11k/QCN9074/hw1.0/board-2.bin` in the
"Driver: ath11k" block marked "Licence: Redistributable. See LICENSE.QualcommAtheros_ath10k
for details" (`SPDX-License-Identifier: LicenseRef-LICENSE.QualcommAtheros_ath10k`). (A
different block of the same driver section, for the WCN6750 qcm6490 `wpss.mbn`, uses
`LICENSE.qcom`/`NOTICE.qcom`; that is not this file.) A copy of the license text, taken
from `LICENSES/LICENSE.QualcommAtheros_ath10k` in linux-firmware, is kept at
`upstream/LICENSE.QualcommAtheros_ath10k`. Its grant reads:

> Redistribution. Reproduction and redistribution in binary form, without
> modification, for use solely in conjunction with a Qualcomm Atheros, Inc.
> chipset, is permitted provided that the following conditions are met: ...

(conditions: reproduce the copyright notice and disclaimer; do not use Qualcomm's name
to endorse products; no reverse engineering, decompilation or disassembly.)

## Redistribution status of R (important)

The upstream file is redistributable **only unmodified**. R is a modified copy (the
operating-range field and the checksum are changed, and the board entry is renamed), so:

* this repository ships only the unmodified upstream file and the script that applies
  the change; R is generated on the builder's own machine at build time;
* R is git-ignored and must not be committed;
* images built from this repository contain R and **must not be redistributed**.

## Experiments with other BDFs

Drop any ready-made `board-2.bin` onto a router with `tools/radio/swap-bdf.sh` (see
docs/radio.md). To build an image with a different BDF, put it at
`bdf/board-xiaomi_ax9000.qcn9074` (git-ignored) and pass `--force-bdf` (or set `AX9000_FORCE_BDF=1`); without it the
build refuses any file whose md5 is not R's (it warns loudly and continues when forced). Xiaomi's proprietary files are never committed.
