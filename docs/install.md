# Installing the AX9000 build

Build the image first ([build.md](build.md)). The image is a sysupgrade-compatible OpenWrt 25.12.6 image
for the Xiaomi AX9000 (same layout and `board_name` as stock OpenWrt 25.12). It runs on
the author's two AX9000 routers, but it is a community build, not an official OpenWrt
image: follow the cautious path below the first time you flash it.

## Risks to know about

* The kernel/device tree now builds the ADSS PWM driver in (it drives the X light). If
  its probe misbehaves on real hardware it can hang the boot. This is why the first flash
  of any new kernel/DT must go through the initramfs test below.
* The AX9000 OpenWrt layout has **no automatic fallback slot** unless someone verifies
  otherwise on the device. Treat a bad flash as needing manual recovery.
* The fan has a kernel-level failsafe (device tree trips), independent of the service.

## Pre-flight checklist

1. You are on stock OpenWrt 25.12.x (not the Xiaomi firmware); this guide does not
   cover the first conversion from the Xiaomi firmware.
2. Back up the configuration: `sysupgrade -b /tmp/backup-$(date +%F).tar.gz`, then copy
   it off the router.
3. Wireless: if the lower 5 GHz radio (QCN9074, path contains `20000000.pcie`) is set
   to a channel >= 100, change it to 36-64 or `auto` first. The image migrates this at
   first boot (`80-ax9000-radio-channel`), but check anyway.
4. Recovery readiness: UART adapter (1.8 V logic only, never 3.3 V) wired and tested,
   a TFTP server on your PC, and the stock OpenWrt sysupgrade/initramfs images for
   25.12.x downloaded locally.
5. Verify the image: `scripts/verify-image.sh all <sysupgrade.bin>` passes.

## Step 1: initramfs-first test (new kernel or device tree)

Boots the new kernel from RAM without touching flash, so a hang costs only a power cycle.

1. Serve `out/openwrt-qualcommax-ipq807x-xiaomi_ax9000-initramfs-uImage.itb` (the FIT
   initramfs kernel; not the `*-initramfs-factory.ubi`, which is a flash image) over TFTP
   (PC at 192.168.1.10, router LAN port connected).
2. Interrupt U-Boot on the UART, `tftpboot <loadaddr> openwrt-qualcommax-ipq807x-xiaomi_ax9000-initramfs-uImage.itb`,
   then boot the AX9000 FIT configuration with `bootm <loadaddr>#config@hk14`
   (the configuration name is `DEVICE_DTS_CONFIG` of the device in OpenWrt; choose a
   load address from the OpenWrt wiki page for the AX9000 or the `printenv` output of
   your device).
3. Check, without flashing: it boots to a shell; `dmesg | grep -i pwm`; `ls
   /sys/class/leds`; `cat /sys/class/hwmon/hwmon*/name` includes `emc2305`; radios up
   with `wifi status`.
4. Reboot (back to flash) only after all of that looks right.

## Step 2: flash

```sh
# on the router, image copied to /tmp
sysupgrade -v /tmp/openwrt-...-sysupgrade.bin     # keeps settings
```

Do not pass `-n` unless you want to drop the configuration. After the reboot, check
`logread -e ax9000`, `ubus call ax9000.fan status`, `ubus call ax9000.led status`.

## Upgrading to a newer build

Build the new image and flash it the same way: `sysupgrade -v <image>` on the router, or
LuCI *System → Backup / Flash Firmware → Flash new firmware image* with **Keep settings**
ticked. Here is what survives and what you have to redo.

**Kept automatically**

* Your configuration in `/etc/config`: network, Wi-Fi, firewall, DHCP, the fan, the X
  light, the status LEDs, and the settings of every package in the image.
  `sysupgrade -l` lists exactly which files are kept.
* Files you added to `/etc/sysupgrade.conf`.
* Older fan settings (Silent / Balanced / ... modes) are converted once at first boot to
  the Day / Night settings; a *Manual* speed becomes a fixed Day speed. Settings already
  in the new format are left alone.

**Not kept: packages you installed with `apk add`**

The new image contains only the packages it was built with. Anything you installed later
is gone after the upgrade. Its configuration in `/etc/config` is still there, so the
package works as before once it is installed again.

* Packages that contain kernel modules (`kmod-*`, and everything that needs them, such as
  `sqm-scripts`) cannot be installed with `apk` at all on this build, because it has its
  own kernel. Put them in `config/local.config` and rebuild
  ([build.md](build.md#add-your-own-packages)). They are then part of every future image.
* Userspace-only packages can be installed again from the official feeds.

To make this easy, keep a list before you upgrade:

```sh
# before the upgrade: backup with a package list, copy it off the router
sysupgrade -k -b /tmp/backup-$(date +%F).tar.gz
apk info > /tmp/packages-before.txt        # the same list as plain text

# after the upgrade: compare and install what is missing
apk update
apk info > /tmp/packages-after.txt
grep -vxFf /tmp/packages-after.txt /tmp/packages-before.txt   # missing packages
apk add <package> ...
```

Packages you install on every router are better added to `config/local.config`, so the
next image already has them.

**After the upgrade**

* If the LuCI *Fan* or *LED* page looks like the old version, reload it without the
  browser cache (Ctrl+F5).
* Check `logread -e ax9000`, `ubus call ax9000.fan status` and `ubus call ax9000.led status`.

## Rollback to stock OpenWrt

Flash the stock 25.12.x sysupgrade image: `sysupgrade -n /tmp/stock-sysupgrade.bin`
(or without `-n` to keep settings; the `ax9000` config is simply ignored by stock).
Restore a config backup with `sysupgrade -r backup.tar.gz` if needed.

## Recovery (router does not boot)

1. Open the case and attach the UART (1.8 V, 115200 8N1).
2. Interrupt U-Boot and load a known-good initramfs image via TFTP as in step 1, then
   flash the stock sysupgrade image from that RAM system.
3. Full procedure and U-Boot variables: the OpenWrt wiki / device page for the Xiaomi
   AX9000: https://openwrt.org/toh/xiaomi/ax9000
