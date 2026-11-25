# Building the firmware yourself

This guide takes you from a clean computer to flashable OpenWrt images for the
Xiaomi AX9000. The whole build runs inside a Docker container, so the steps are the
same on Windows, Linux and macOS, and you do not need to install a toolchain or know
the OpenWrt build system.

Ready-made images are not published, because the radio's board data file cannot be
redistributed in modified form (see [Why there are no downloadable images](#why-there-are-no-downloadable-images)).
Building takes about an hour of unattended work the first time.

**Contents**

1. [What you get](#1-what-you-get)
2. [Requirements](#2-requirements)
3. [Install Docker and Git](#3-install-docker-and-git)
4. [Get the source](#4-get-the-source)
5. [Build](#5-build)
6. [Check the result](#6-check-the-result)
7. [Customise the image](#7-customise-the-image)
8. [Rebuilding and updating](#8-rebuilding-and-updating)
9. [Troubleshooting](#9-troubleshooting)
10. [What the build does, step by step](#10-what-the-build-does-step-by-step)
11. [Building without Docker](#11-building-without-docker)
12. [Why there are no downloadable images](#why-there-are-no-downloadable-images)

---

## 1. What you get

The build writes these files to `out/`:

| File | What it is for |
|------|----------------|
| `openwrt-qualcommax-ipq807x-xiaomi_ax9000-squashfs-sysupgrade.bin` | Upgrade from OpenWrt 25.12.x (LuCI *Flash new firmware image* or `sysupgrade`). **This is the file most people need.** |
| `openwrt-qualcommax-ipq807x-xiaomi_ax9000-initramfs-uImage.itb` | Kernel + rootfs that boots from RAM over TFTP without touching flash. Used for the safe first test, see [install.md](install.md). |
| `openwrt-qualcommax-ipq807x-xiaomi_ax9000-squashfs-factory.ubi` | Raw UBI image for flashing from U-Boot or from the Xiaomi firmware conversion procedure. |
| `openwrt-qualcommax-ipq807x-xiaomi_ax9000-initramfs-factory.ubi` | Initramfs as a UBI image (the first step of the OpenWrt wiki's conversion procedure). |
| `sha256sums`, `*.manifest` | Checksums and the list of packages in the image. |

The image is stock OpenWrt (the exact release is pinned in [`openwrt.version`](../openwrt.version))
plus:

* the QCN9074 radio fix (working board data file, channels 36-64 only);
* fan control (EMC2301 driver, kernel failsafe, `ax9000-fand` service);
* the top X light as one hardware-PWM RGB LED (`ax9000-ledd` service);
* the LuCI app *System → AX9000 Controls* (Fan and LED pages, English and Russian);
* `luci-ssl`, i.e. the web interface over HTTPS.

## 2. Requirements

| | Minimum | Recommended |
|---|---|---|
| CPU | any 64-bit x86-64 or ARM64 | 8+ cores (build time scales almost linearly) |
| RAM available to Docker | 4 GB | 8 GB or more |
| Free disk space | 25 GB | 40 GB (more if you add many packages) |
| Internet | needed for the first build (about 1.5 GB of sources) | |
| OS | Windows 10/11, Linux, macOS | |

Where the space goes: the OpenWrt tree with its toolchain and build files (about 15 GB),
the source download cache (about 1.5 GB) and the builder image (about 1.5 GB). All of
it lives in Docker volumes, not in the repository folder.

Build time on a modern 8-16 core machine: roughly 40-90 minutes the first time, and
5-15 minutes for later builds, which reuse the toolchain. On Apple Silicon and other
ARM64 hosts the build runs natively; this has not been tested yet, so please report results.

You do **not** need the Xiaomi stock firmware, a Qualcomm SDK, or any file that is not in
this repository: everything else is downloaded from OpenWrt's official sources.

## 3. Install Docker and Git

### Windows 10/11

1. Install [Docker Desktop](https://docs.docker.com/desktop/setup/install/windows-install/)
   with the **WSL 2 backend** (the installer default). Reboot if asked, start Docker
   Desktop and wait until it shows *Engine running*.
2. In Docker Desktop → *Settings → Resources*, give it at least 4 GB of memory
   (8 GB+ if you can) and check that the disk image location has 25+ GB free.
   With the WSL 2 backend, memory is limited in `%UserProfile%\.wslconfig`
   (`[wsl2]` section, `memory=8GB`) instead of in Docker Desktop.
3. Install [Git for Windows](https://git-scm.com/download/win). It also gives you
   *Git Bash*, which can run `build.sh`; PowerShell users have `build.ps1`.

### Linux

1. Install Docker Engine: <https://docs.docker.com/engine/install/> (or your
   distribution's `docker.io`/`docker` package) and Git (`sudo apt install git`, etc.).
2. Allow your user to run Docker without `sudo`, then log out and back in:
   ```sh
   sudo usermod -aG docker "$USER"
   ```
3. Check: `docker run --rm hello-world`.

Podman with the Docker CLI shim should work too, but is untested.

### macOS

1. Install [Docker Desktop for Mac](https://docs.docker.com/desktop/setup/install/mac-install/)
   (or OrbStack/Colima) and give it 8 GB of memory and 40+ GB of disk under *Settings → Resources*.
2. Git comes with the Xcode command-line tools: `xcode-select --install`.

Check that Docker works before you continue:

```sh
docker version          # must show both "Client" and "Server"
```

## 4. Get the source

```sh
git clone <URL of this repository> xiaomi-ax9000-openwrt
cd xiaomi-ax9000-openwrt
```

On Windows clone into a short path without spaces (for example `C:\src\`) to stay clear
of path-length and quoting problems. Line endings are handled by `.gitattributes`:
shell scripts are always checked out with LF, so `core.autocrlf` does not matter.

## 5. Build

### Linux, macOS, Git Bash on Windows

```sh
./build.sh
```

### Windows PowerShell

```powershell
.\build.ps1
```

If PowerShell refuses to run the script, allow local scripts for this session:
`Set-ExecutionPolicy -Scope Process RemoteSigned`.

### What you should see

1. `docker build` creates the `ax9000-builder` image (Debian with the OpenWrt build
   dependencies). Only the first run does real work here.
2. `==> Generating the QCN9074 BDF (R) from bdf/upstream`: the radio's board data
   file is created on your machine (see [bdf/README.md](../bdf/README.md)).
3. `==> Cloning OpenWrt`, then `Applying 7 patch(es)`: the pinned OpenWrt release is
   checked out and this project's patches are applied.
4. Feeds update, `make download`, then a long `make` phase with lines like
   `make[3] -C package/... compile`.
5. `==> Done. Outputs:` and a listing of `out/`.

The build stops with an error on purpose if a patch no longer applies or the board data
file does not match its expected checksum, instead of producing a half-working image.

### Options

| `build.sh` | `build.ps1` | Meaning |
|---|---|---|
| `--jobs N` | `-Jobs N` | Parallel jobs (default: number of CPUs Docker sees). Lower it if the machine runs out of memory. |
| `--shell` | `-Shell` | Open a shell in the build tree instead of building (for `make menuconfig`, debugging, tests). |
| `--oem-firmware FILE` | `-OemFirmware FILE` | Optional. Cross-checks the frequency range of the BDF inside a Xiaomi stock firmware `.bin` against the one this build ships. Nothing from that file goes into the image. |
| `--force-bdf` | `-ForceBdf` | Accept a board data file other than the reference one (see [Experimenting with other BDFs](#experimenting-with-another-board-data-file)). |

Environment variable `AX9000_TREE_VOLUME` changes the Docker volume used for the OpenWrt
tree (default `ax9000-openwrt`), for example to build two branches side by side.

## 6. Check the result

Static checks, no router needed: they unpack the sysupgrade image and verify the board
data file, the device tree (frequency limit, fan, PWM LEDs), the fan driver, the
LuCI/daemon files, file permissions and package feeds:

```sh
# Linux / macOS
docker run --rm -v "$PWD:/src:ro" -v "$PWD/out:/out:ro" \
    --entrypoint bash ax9000-builder /src/scripts/verify-image.sh all

# Git Bash on Windows
MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd -W):/src:ro" -v "$(pwd -W)/out:/out:ro" \
    --entrypoint bash ax9000-builder /src/scripts/verify-image.sh all
```

```powershell
# PowerShell
docker run --rm -v "${PWD}:/src:ro" -v "${PWD}/out:/out:ro" `
    --entrypoint bash ax9000-builder /src/scripts/verify-image.sh all
```

Every line must start with `PASS:`; the exit status is 0 on success. Compare the
image checksum with `out/sha256sums` before you copy it to the router.

Then follow **[install.md](install.md)**: pre-flight checklist, the initramfs test boot
for a new kernel, flashing, rollback and recovery.

## 7. Customise the image

### Add your own packages

Packages that contain kernel modules (`kmod-*`, and anything that depends on them, such
as `sqm-scripts`) **must be built into the image**: this build has its own kernel, so
`apk add` from the official OpenWrt repositories cannot install matching kernel modules
afterwards. Userspace-only packages can still be installed from the official feeds.

```sh
cp config/local.config.example config/local.config
```

Add one line per package to `config/local.config` (the file is git-ignored):

```
CONFIG_PACKAGE_luci-app-sqm=y
CONFIG_PACKAGE_usteer=y
CONFIG_PACKAGE_tcpdump=y
CONFIG_PACKAGE_luci-app-ddns=y
```

Dependencies are selected automatically. Then run `./build.sh` again. To find package
names, browse the OpenWrt package index or use `make menuconfig` (below).

### Interactive configuration (menuconfig)

```sh
./build.sh --shell                 # opens a shell in /work/openwrt, as user "builder"
make menuconfig                    # pick packages, save
./scripts/diffconfig.sh | grep CONFIG_PACKAGE_   # copy the lines you added
exit
```

`build.sh` regenerates `.config` from `config/ax9000.config` and `config/local.config` on
every run, so changes made only in menuconfig are lost: paste the `CONFIG_PACKAGE_*`
lines you want to keep into `config/local.config`.

### Files in the image (`files/` overlay)

Not supported by the wrapper yet. Use a `uci-defaults` script in a small package
or run your settings after the first boot.

### Experimenting with another board data file

Put a `board-2.bin`-format file at `bdf/board-xiaomi_ax9000.qcn9074` (git-ignored) and
build with `--force-bdf`. The build warns loudly and installs it instead of the
generated one. For quick tests without rebuilding, swap the file on a running router with
`tools/radio/swap-bdf.sh` (see [radio.md](radio.md)). Delete the file to return to the
default.

## 8. Rebuilding and updating

* **After `git pull`:** just run `./build.sh` again. The tree is reset to the pinned
  OpenWrt commit and all patches are re-applied each time; compiled objects, downloads
  and the toolchain are kept, so only what changed is rebuilt.
* **New OpenWrt release:** this project pins an exact commit in `openwrt.version` and is
  updated deliberately; do not change it yourself unless you are ready to fix patches
  that no longer apply (`git am` fails with a clear message in that case).
* **Clean build from scratch** (after strange errors or to free space):
  ```sh
  docker volume rm ax9000-openwrt            # the OpenWrt tree, ~15 GB
  docker volume rm ax9000-dl ax9000-ccache   # source downloads and compiler cache (optional)
  docker image rm ax9000-builder             # the builder image (optional)
  ```
* **Remove everything** after you are done: the three commands above remove all disk space
  used by the build.

## 9. Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `Cannot connect to the Docker daemon` / `error during connect` | Docker Desktop is not running, or (Linux) your user is not in the `docker` group yet. Start it / log out and in. |
| Build dies with `Killed`, `signal 9` or `internal compiler error` | Out of memory. Give Docker more RAM or use `--jobs 2`. The build already retries once with `-j1 V=s` to show the real error. |
| `No space left on device` | The Docker disk is full. Free space or enlarge Docker Desktop's disk; `docker system df` shows usage. |
| `git am` / `Patch failed at ...` | The OpenWrt tree is not at the pinned commit with clean files. Run again; if it repeats, `docker volume rm ax9000-openwrt`. |
| `error: BDF md5 is ..., expected 4095ab17...` | A file `bdf/board-xiaomi_ax9000.qcn9074` exists and differs from the reference. Delete it, or pass `--force-bdf` if it is your experiment. |
| `bdf/upstream/... has md5 ..., expected 668f5305...` | The upstream file was modified or converted (for example a line-ending conversion). `git checkout -- bdf/upstream`. |
| Download errors (`make download` fails, hash mismatch) | A mirror was temporarily unavailable. Run the build again; OpenWrt tries several mirrors. |
| Windows: `/src/scripts/build-openwrt.sh: No such file or directory` or `$'\r': command not found` | The files were checked out with CRLF by an old Git or an archive tool. Re-clone with Git so `.gitattributes` is applied. |
| Windows: Docker cannot mount the folder | Docker Desktop → *Settings → Resources → File sharing* must allow the drive (Hyper-V backend), or use the WSL 2 backend. |
| Error while compiling a package you added in `local.config` | The package may not build for this target. Remove it, or run with `--shell` and `make package/<name>/compile V=s` to see why. |

To report a problem, include the last ~100 lines of the build output, your OS, the
Docker version, and `git rev-parse HEAD`.

## 10. What the build does, step by step

`build.sh`/`build.ps1` builds the `docker/Dockerfile` image and runs
[`scripts/build-openwrt.sh`](../scripts/build-openwrt.sh) inside it with:

| Mount | Content |
|---|---|
| `/src` (read-only) | this repository |
| `/out` | `out/` in the repository, receives the images |
| `/work/openwrt` (volume `ax9000-openwrt`) | the OpenWrt source/build tree |
| `/work/dl`, `/work/ccache` (volumes) | download cache and compiler cache |

`build-openwrt.sh` then:

1. **Board data file.** Generates `R` from `bdf/upstream/` (an unmodified Qualcomm file
   from linux-firmware) with [`tools/bdf/build_ax9000_bdf.py`](../tools/bdf/build_ax9000_bdf.py):
   sets the operating range to 5170/5330 MHz, fixes the checksum, renames the board entry
   for the AX9000. The result must have md5 `4095ab1701d9080bbffefe3ecf8ec0f0`.
2. **OpenWrt.** Clones `https://github.com/openwrt/openwrt.git` (first time only) and
   resets it to the commit in `openwrt.version`.
3. **Patches.** Applies `patches/openwrt/*.patch` with `git am`:

   | Patch | Change |
   |---|---|
   | `0001` | `ipq-wifi`: allow a local board file override |
   | `0002` | DTS: limit the QCN9074 to 5150-5350 MHz |
   | `0100` | kernel: backport device tree support for the EMC2305 fan driver |
   | `0101` | DTS: EMC2301 fan with thermal trips (kernel failsafe) |
   | `0200` | IPQ8074 clock driver: ADSS PWM clock |
   | `0201` | IPQ8074 PWM driver support |
   | `0202` | DTS: drive the X light with hardware PWM as one RGB LED |

4. **BDF into the tree.** Installs R as `package/firmware/ipq-wifi/src/board-xiaomi_ax9000.qcn9074`.
5. **Feeds.** Standard OpenWrt feeds plus this repository's `feed/` (packages
   `ax9000-controls` and `luci-app-ax9000-controls`).
6. **Config.** `config/ax9000.config` (+ `config/local.config`) → `make defconfig`.
7. **Build.** `make download`, then `make -j$JOBS`.
8. **Collect.** Copies the AX9000 images, checksums and manifests to `out/`.

Tests of the project's own code (no router needed):

```sh
docker run --rm -v "$PWD:/src:ro" --entrypoint bash ax9000-builder \
    -c 'cd /src && PYTHONDONTWRITEBYTECODE=1 python3 -m pytest -p no:cacheprovider tools/bdf'
sh tests/sh/test_radio_migration.sh
node tests/js/test_ledfx.js
./build.sh --shell   # then: sh /src/tests/ucode/run.sh   (needs one finished build)
```

## 11. Building without Docker

On a Linux machine prepared for OpenWrt builds (see the
[OpenWrt build system setup](https://openwrt.org/docs/guide-developer/toolchain/install-buildsystem)),
you can do the same steps by hand:

```sh
. ./openwrt.version                       # TAG, COMMIT
python3 -m tools.bdf.build_ax9000_bdf \
    --linux-firmware bdf/upstream/linux-firmware-QCN9074-hw1.0-board-2.bin \
    --out /tmp/board-xiaomi_ax9000.qcn9074
md5sum /tmp/board-xiaomi_ax9000.qcn9074   # 4095ab1701d9080bbffefe3ecf8ec0f0

git clone https://github.com/openwrt/openwrt.git ../openwrt
REPO="$PWD"; cd ../openwrt
git checkout -B ax9000 "$COMMIT"
git am "$REPO"/patches/openwrt/*.patch
install -D -m 0644 /tmp/board-xiaomi_ax9000.qcn9074 \
    package/firmware/ipq-wifi/src/board-xiaomi_ax9000.qcn9074
cp feeds.conf.default feeds.conf
echo "src-link ax9000 $REPO/feed" >> feeds.conf
./scripts/feeds update -a && ./scripts/feeds install -a
cp "$REPO"/config/ax9000.config .config   # plus your local.config lines, if any
make defconfig
make download && make -j"$(nproc)"
ls bin/targets/qualcommax/ipq807x/
```

The Docker build is the supported path; use this only if you know the OpenWrt build system.

## Why there are no downloadable images

The QCN9074 radio needs a board data file (BDF). The one this build installs ("R") is
Qualcomm's reference BDF from linux-firmware with two 16-bit fields changed. The
linux-firmware license allows that file to be redistributed **only unmodified**. So this
repository contains only the unmodified upstream file and the small script that applies
the change, and the change happens on your machine during the build. A built image contains
the modified file, so **do not publish your built images either**. Details: [bdf/README.md](../bdf/README.md).
