# xiaomi-ax9000-openwrt

Custom OpenWrt firmware for the **Xiaomi AX9000** (`qualcommax/ipq807x`), based on
OpenWrt 25.12. You build the image yourself: one command in Docker, on Windows, Linux or
macOS.

On stock OpenWrt 25.12 this router has three known problems:

1. the lower 5 GHz radio (QCN9074 on PCIe) is up and beaconing, but clients cannot
   connect: its receive path does not work with the board data file OpenWrt ships;
2. the fan (EMC2301) is not controlled at all;
3. the top X-shaped light can only be switched on/off in 7 colours.

This project fixes them in the device tree and kernel drivers rather than with register
hacks, and adds a LuCI app for the new controls.

## Features

- **Radio:** a working board data file for the QCN9074 (Qualcomm's reference file,
  restricted to the AX9000's real frequency range), and LuCI offers only the channels
  the hardware supports (36-64 on that radio). Background: [docs/radio.md](docs/radio.md).
- **Fan:** EMC2301 driver with a kernel-level thermal failsafe, plus the `ax9000-fand`
  service with a *Day* and a *Night* setting: each a 4-point curve you drag in LuCI (the
  fan stops below the first point) or a fixed speed.
- **LEDs:** the X light as one RGB LED on hardware PWM: any colour, smooth brightness,
  effects, night mode and event signals; the front status LEDs can be set too. Details: [docs/dev/leds.md](docs/dev/leds.md).
- **LuCI:** *System → AX9000 Controls*, with *Fan* and *LED* pages (English, Russian).
- Everything else is plain OpenWrt 25.12 for the AX9000, with `luci-ssl` included.

## Quick start

You need Docker (Docker Desktop on Windows/macOS), Git, about 25 GB of free disk space and
about an hour for the first build.

```sh
git clone <URL of this repository> xiaomi-ax9000-openwrt
cd xiaomi-ax9000-openwrt
./build.sh            # Windows PowerShell: .\build.ps1
```

The images appear in `out/`. Before flashing, read:

- **[docs/build.md](docs/build.md):** full build guide: requirements, Docker setup per
  OS, options, adding your own packages, verifying the image, troubleshooting.
- **[docs/install.md](docs/install.md):** flashing: pre-flight checklist, safe
  initramfs test boot, rollback and UART recovery.

## Status

Images built from this tree run on the author's two AX9000 routers. It is a
community project, not an official OpenWrt build: flash at your own risk and keep
a way to recover (see [docs/install.md](docs/install.md)).

| Feature | Software | Notes |
|---------|----------|-------|
| Radio (QCN9074 BDF, 5150-5350 MHz limit) | done | far-range performance not fully characterised, see [docs/radio.md](docs/radio.md) |
| Fan (EMC2301 driver, failsafe, `ax9000-fand`, LuCI) | done | |
| LEDs (hardware PWM, RGB X light, `ax9000-ledd`, LuCI) | done | |

## Repository layout

| Path | Content |
|------|---------|
| `build.sh`, `build.ps1` | Build entry points (run the Docker build) |
| `docker/` | Builder image: Debian + OpenWrt build dependencies |
| `scripts/build-openwrt.sh` | The build itself, runs inside the container |
| `scripts/verify-image.sh` | Static checks of a built image |
| `openwrt.version` | Pinned OpenWrt release tag and commit |
| `patches/openwrt/` | Patches against OpenWrt (device tree, kernel, `ipq-wifi`), `git format-patch` style |
| `feed/` | OpenWrt feed: `ax9000-controls` (fan/LED services) and `luci-app-ax9000-controls` |
| `config/` | Build configuration; `local.config` (git-ignored) for your own packages |
| `bdf/` | Unmodified upstream QCN9074 board file + license; the AX9000 file is generated at build time |
| `tools/bdf/`, `tools/radio/` | Board data file generator/extractor, on-router BDF swap helper |
| `tests/` | Tests for the services, LuCI helpers and the BDF tools |
| `docs/` | Build, install, radio and developer notes |

## Licensing and redistribution

- The project's own code and patches: GPL-2.0, see [LICENSE](LICENSE) (the same license
  as OpenWrt).
- `bdf/upstream/` holds an **unmodified** Qualcomm board data file from linux-firmware,
  redistributed under its own license ([bdf/upstream/LICENSE.QualcommAtheros_ath10k](bdf/upstream/LICENSE.QualcommAtheros_ath10k)).
- That license does not allow redistribution of modified copies. The build therefore
  creates the AX9000 version on your machine, and **built images must not be
  redistributed**, because they contain the modified file. See [bdf/README.md](bdf/README.md).
- No Xiaomi firmware or other proprietary Xiaomi file is included or needed.
