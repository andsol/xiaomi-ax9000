# Radio notes: the QCN9074 board data file and the 5 GHz channel split

This page explains why the AX9000's lower 5 GHz radio needs a custom board data
file (BDF), how that file is built, what was tested on real hardware, and how to
experiment with other files. It is written for both users (see
[Troubleshooting](#troubleshooting)) and developers.

## 1. Hardware split

| phy | chip | band | usable channels |
|---|---|---|---|
| phy0 | IPQ8074 (internal) | 2.4 GHz | 1-13 |
| phy1 | IPQ8074 (internal) | **upper** 5 GHz | 149-165 only |
| phy3 | QCN9074 (PCIe) | **lower** 5 GHz | 36-64 only |

* The IPQ8074's integrated 5 GHz radio has an RF path built for the upper part of the
  band: it serves channels 149-165 and nothing below.
* The QCN9074 on PCIe carries the lower part of the band. Its RF path (filters/FEM) is
  likely limited by its filters/FEM to roughly **5150-5350 MHz**. Observed on hardware: no
  TX above 5350 MHz. With channel 100 set, hostapd reports the AP as enabled but clients
  never see it (no beacon seen by a phone, zero stations join). The cause (RF hardware
  versus firmware) was not isolated.

So the build restricts phy3 to 5150-5350 MHz in two independent places: the device tree
(`ieee80211-freq-limit = <5150000 5350000>;` on the `wifi@0,0` node under `&pcie0`; ath11k
reads it through `wiphy_read_of_freq_limits()`, so no driver patch is needed) and the
BDF's operating-frequency range (section 3). LuCI then only offers channels 36-64 for
phy3.

## 2. Probable cause of the original "radio is up but receives nothing" problem

Symptoms with the BDF OpenWrt shipped for this board, and with Xiaomi's own
`bdwlan.ba0` extracted from stock firmware: phy3 appears and beacons are visible, TX
looks fine, but no authentication/association frame ever reaches hostapd, so nothing
can connect (the RX path is dead). A Qualcomm reference BDF from linux-firmware worked.

The mechanism below is a hypothesis of Medium/Low confidence. What the evidence supports
is the **template/section layout**: cand-B, which carries Xiaomi's sections 2-18 inside
the 3.x layout, works, while the raw 1.0.3-layout files do not. The exact field that kills
RX has not been identified.

Findings from a static comparison of 45 BDF images (Xiaomi OEM, linux-firmware board ids
160-164, 18 OpenWrt qca-wireless boards) plus hardware tests:

* Xiaomi's BDF uses **template version 1.0.3**, written for the stock firmware
  **HK 2.3**. OpenWrt uses firmware **HK 2.9**, which expects template >= 2.x/3.x.
  Template-2 fields that are zero in 1.0.3 (feature bytes in section 7, tables in
  section 14) are a plausible, unconfirmed, reason for "TX works, RX dead".
* In 1.0.3 files the section chain is numbered differently from section 11 onward, ten
  sections carry different length words, and sections 25-28 are absent.
* The old OpenWrt file for this board is Xiaomi's ba0 with a generic 10 KB regdb pasted
  over bytes `0x12de8..0x155ef`; that also destroyed the original sections 20-24
  (per-channel RX reference levels).
* Not the cause: chain masks, CTL tables (Xiaomi == Qualcomm byte for byte), the
  five-pier calibration.

## 3. BDF format summary

Each board-2.bin entry holds a 128 KiB (131072 byte) BDF image. Confidence: H(igh),
M(edium), L(ow).

Header fields:

| offset | meaning | conf |
|---|---|---|
| `0x0a` | u16 checksum: XOR of all LE16 words of the file == `0xFFFF` (holds on all 45 files) | H |
| `0x0e..0x13` | MAC address (placeholder `00:03:7f:12:34:56` in BDFs; the real one is in ART) | H |
| `0x3a` | board id | H |
| `0x3b` | DataRev, a vendor counter (not the template version) | H |
| `0x21c`, `0x22b..0x22d` | template generation and TemplateVer: 1.0.3 Xiaomi/OpenWrt; 2.2.1 this unit's ART; 3.1.x Qualcomm reference; 4.x AX6000/AX5400 | H |

Sections (header `<u16 id><u16 len><u32 0>`; offsets are for template 3.1.1, identical
in 1.0.3/2.2.1 up to section 19):

| sec | offset / span | content | conf |
|---|---|---|---|
| 1 | 0x0 / 0x408 | file header | H |
| 4 | 0x790 / 0x420 | base config; **`0x8ca`/`0x8cc` = operating frequency low/high MHz** (Xiaomi 5170/5330, JDCloud RE-CS-02 5150/5330, Qualcomm reference 0 = unrestricted) | H |
| 5 | 0xbb0 / 0x134 | chain masks (`00 0f 00 0f`) | M |
| 7 | 0xf50 / 0x11c | feature bytes; `0xf6d`, `0xf9b..c` non-zero in every template >= 2, zero in 1.0.3 | H diff / L meaning |
| 8 | 0x106c / 0x44b8 | TX power calibration; 5 GHz cal piers at `0x255c` | M-H |
| 9 | 0x5524 / 0x72c | gain/power-index tables | M |
| 11 | 0x6458 / 0xfb8 | target power (u8, ~0.25 dB); 5 GHz at `0x6666..0x6b5a` | H / M units |
| 12 | 0x7410 / 0x8cd4 | CTL tables (Xiaomi == Qualcomm) | H |
| 13 | 0x100e4 / 0x420 | noise-floor calibration | M |
| 14 | 0x10504 / 0x1808 | template-2 tables, zero in 1.0.3 | H diff / L meaning |
| 19 | 0x12de8 / 0x2808 | regdb (7 KB vs 10 KB; newer firmware wants the 10 KB one) | H |
| 20-24 | 0x155f0.. | includes per-pier/chain RX reference levels (s16) in section 22 | M |
| 25-28 | 0x15b0c.. | per-chain cal, near-constant block, 6 GHz CTL-like block, 3.x addition | M |

These notes are observations from comparing public and personally owned files. The linux-firmware license forbids reverse engineering, decompilation
and disassembly of the firmware; the format notes do not come from disassembling it
(the firmware parser was not examined), but they should not be read as a license to do so.

Limitations: the firmware's BDF parser was not reverse engineered, units are inferred,
and the meaning of `0xbc1`, `0x5db0`, section 14 and section 17 is unknown.

## 4. Candidates and hardware results

Base for the candidates: the linux-firmware QCN9074 BDF for `qmi-board-id=160`
(template 3.1.1, called "wiki" below; it is also the reference that works).

* **stock**: the file OpenWrt shipped (ba0 + pasted regdb).
* **xiaomi (ba0)**: Xiaomi's raw `bdwlan.ba0`.
* **wiki**: the unmodified reference BDF.
* **cand-A**: wiki + Xiaomi's section-11 target-power payload + range 5170/5330.
* **cand-B** ("ba0 fixed"): Xiaomi sections 2-18 and old 22-26 placed in the 3.x layout,
  all template-2 fields kept from wiki.
* **cand-R (shipped)**: wiki + range 5170/5330 only, checksum recomputed.

Measured with a phone/laptop near the AP unless marked FAR ROOM (same spot, through
walls, where TX-power tuning would show). Each cell is a single session/sample.
**R itself was only tested in the far room** (connected fine, 12-14 Mbit/s). Near range,
channels 52/64 and HE160 were tested with wiki and cand-B, which share R's 3.1.1 RF tuning;
R differs from wiki only in the range field, so these results are expected to carry over
but R was not fully characterised. With R loaded, phy3 listed exactly 8 enabled channels
(36-64).

| BDF | Channel | Visible | Connect + internet | Signal | Peak TX/RX bitrate | fast.com | Noise |
|---|---|---|---|---|---|---|---|
| wiki | 36/HE80 | yes | yes | -36..-46 dBm | 1200.9/1200.9 HE-MCS11 NSS2 | 500 Mbit/s | -107 |
| wiki | 52/HE80 DFS | yes | yes | -46..-49 dBm | 1200.9/1200.9 | 590 Mbit/s | -107 |
| wiki | 64/HE80 DFS | yes | yes | -46..-49 dBm | 1200.9/864.8 | 490-520 Mbit/s | -108 |
| wiki | 36/HE160 | yes | yes | -50 dBm | 2401.9 peak | 560 Mbit/s | n/a |
| wiki | 100/HE80 DFS | **no** | no (0 stations, AP "ENABLED") | - | - | - | n/a |
| stock | 36/HE80 | yes | **no** (no auth/assoc frames reach hostapd: RX broken) | - | - | - | -107 |
| xiaomi (ba0) | 36/HE80 | yes (after ~1 min) | **no** (same as stock) | - | - | - | -107 |
| cand-B | 36/HE80 | yes | yes | -37 dBm | 1200.9/1200.9 | 540 Mbit/s | -107 |
| cand-B | 36/HE160 | yes | yes | -46 dBm | 2401.9/2401.9 | 600 Mbit/s | - |
| cand-B | 36/HE80 FAR ROOM | yes | yes | -44 dBm reported (suspicious) | tx 12 Mbit/s, 18 failed | **14 Mbit/s** | - |
| wiki | 36/HE80 FAR ROOM | yes | yes | -91 dBm | tx 34-36 Mbit/s | **16-24 Mbit/s** | - |
| cand-A | 36/HE80 FAR ROOM | yes | yes, 1 disconnect | -73..-85 dBm | tx 24-216 | **11 Mbit/s** | - |
| cand-R | 36/HE80 FAR ROOM | yes | yes | -88..-91 dBm | - | **12-14 Mbit/s** | - |

The remaining stock/ba0 rows were skipped after they failed at 36/HE80. cand-B offered
only channels 36-64, confirming that the BDF range field is honored by the firmware.

## 5. Why R was chosen

* wiki, cand-B and cand-R give working RX; the stock-style files do not. Of the working
  ones, R is the smallest change from a known-good, redistributable file: **one**
  proven RF/RX tuning (Qualcomm's), plus a firmware-level restriction to channels
  36-64 from Xiaomi's range field.
* The far-range numbers for wiki, A, B and R (11-24 Mbit/s, one sample each, RSSI
  readings that disagree between runs) cannot be told apart with this data; no Xiaomi
  power-tuning variant showed an advantage that would justify shipping a more complex,
  harder-to-reproduce file.
* R is reproducible from public data (`tools/bdf/build_ax9000_bdf.py` and
  linux-firmware's file) and contains no Xiaomi proprietary bytes except the two range
  numbers. Note that R is a modified copy of a file that is redistributable only
  unmodified, so it is generated at build time and never committed or distributed (see
  [bdf/README.md](../bdf/README.md)).

See [bdf/README.md](../bdf/README.md) for provenance, license and regeneration.

## Troubleshooting

* **phy3 is down after upgrading** (`wifi status` shows the radio not up): a saved
  configuration with phy3 on a channel >= 100 cannot start because the radio is limited
  to 5150-5350 MHz. Pick a channel from 36-64 (in LuCI, or `uci set
  wireless.radio3.channel=36; uci commit wireless; wifi`) and clients will reconnect.
  Use phy1 (149-165) for the upper channels. The image ships a one-shot first-boot
  migration (`/etc/uci-defaults/80-ax9000-radio-channel`) that sets the QCN9074 radio
  (the wifi-device whose path contains `20000000.pcie`) to `auto` when a kept config has a
  numeric channel >= 100, and logs it with `logger -t ax9000`; check `logread -e ax9000`.
* Channels 52-64 are DFS: after selecting one, the AP waits about 60 s (CAC) before it
  becomes `ENABLED`.
* Weak range on phy3: it is the only radio covering the lower channels; try 36/HE80
  first and compare with phy1 at the same spot.

## Swapping BDFs for experiments

```sh
tools/radio/swap-bdf.sh root@<router> path/to/board-2.bin
```

The script streams the file to `/lib/firmware/ath11k/QCN9074/hw1.0/board-2.bin` with
`ssh ... cat >` (dropbear has no sftp), keeps the previous file once as
`board-2.bin_stock`, reboots, waits for SSH, and prints the md5 of the active file and
`iw dev`. Set `SSH_OPTS` for extra ssh options (for example `-i ~/.ssh/key`). Generate
candidate files with `python3 -m tools.bdf.build_ax9000_bdf` or the helpers in
`tools/bdf/`. Experiment on a spare unit and compare the printed md5 with the file you
meant to install. To go back, run the script with a copy of the old file, or on the
router copy `board-2.bin_stock` over `board-2.bin` in the same directory and reboot.
