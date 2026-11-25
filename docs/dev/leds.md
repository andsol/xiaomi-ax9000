# AX9000 LEDs: hardware PWM for the X light

The RGB "X" light on top of the AX9000 is wired to GPIO 63 (red), 64 (green)
and 66 (blue). The stock firmware muxes these pins to `pwm0/pwm1/pwm2` and
drives them from the IPQ8074 PWM block. This build does the same and exposes
the three channels as one multicolor LED, `rgb:indicator`.

| Patch (`patches/openwrt/`) | What it adds |
|---|---|
| `0200-…adss-pwm-clock` | `GCC_ADSS_PWM_CLK` in `gcc-ipq8074` (see `pwm-clock.md`) |
| `0201-…IPQ8074-v1-PWM-support` | kernel patches 0307–0309 (binding, `pwm-ipq` v1 variant, `ipq8074.dtsi` node) and the kernel config |
| `0202-…drive-the-X-light…` | AX9000 DTS: pin state, `&pwm` enabled, `pwm-leds-multicolor` LED, LED functions |

## The PWM block is "v1", in ADSS

IPQ8074 has the older Qualcomm PWM block. It is not the IPQ6018 ("v2") block in
TCSR that the OpenWrt `pwm-ipq` driver (`patches-6.12/0141`) was written for.
Sources:

- Stock AX9000 DT (`AP-HK14`, firmware 1.0.168): `pwm { compatible =
  "qca,ipq4019-pwm"; clocks = <&gcc 0xf0>; … }` with no `reg`. Its pins are
  `gpio63 pwm01`, `gpio64 pwm11`, `gpio66 pwm21`, each with
  `drive-strength = <8>` and no bias. The registers belong to
  `audio@7700000 { reg = <0x7700000 0x34>; }`.
- QSDK 4.4 `drivers/pwm/pwm-ipq4019.c` (linux-msm, `NHSS.QSDK.11.3`,
  `1b21d38c`): `qca,ipq4019-pwm` selects `ops_v1`. These ops access
  `ADSS_GLB_PWMn_CTRL_REG` through the ADSS audio driver.
- QSDK 5.4 `drivers/pwm/pwm-ipq.c` (linux-ipq-5.4, `NHSS.QSDK.12.2.r10`,
  `a07b6a41`): the same `ops_v1` (`qti,ipq-pwm`). This version defines
  `ADSS_GLB_PWM0..3_CTRL_REG = 0x20/0x24/0x28/0x2c` and maps
  `reg = <0x7700000 0x30>` itself when the audio driver is absent
  (`ipq8074.dtsi`). Its `ipq-adss.c` probe only maps the block. The block reset
  is left alone ("brought out of reset by hardware by default").

### Register layout (one 32-bit register per channel)

| Channel | Address | Bits |
|---|---|---|
| PWM0 (red) | `0x07700020` | see below |
| PWM1 (green) | `0x07700024` | |
| PWM2 (blue) | `0x07700028` | |
| PWM3 (unused) | `0x0770002c` | |

| Bits | Field | Meaning |
|---|---|---|
| 31 | `ENABLE` | output toggling enabled |
| 30 | `UPDATE` | latch new divider/high-duration values; cleared by hardware |
| 29:22 | `PRE_DIV` (8 bits) | pre-divider |
| 21 | — | unused |
| 20:10 | `HI_DUR` (11 bits) | high time, in units of `(PRE_DIV+1)` clocks |
| 9:0 | `PWM_DIV` (10 bits) | divider |

- `period = (PRE_DIV + 1) * (PWM_DIV + 1) / f_clk`
- `HI_DUR = duty / period * (PWM_DIV + 1)`, where `HI_DUR = PWM_DIV + 1` means 100 %

Programming sequence (QSDK `ipq_pwm_config` + `ipq_pwm_enable`): first write
the new fields with `ENABLE` clear, then write the same value with
`ENABLE | UPDATE` set.

The PWM node claims only `0x07700020..0x0770002f` (`reg = <0x07700020 0x10>`).
The OpenWrt DT has no other node in ADSS today. Claiming the sub-range keeps
the rest of the block free for a future audio driver.

### Driver choice

The v1 support is a variant of the existing `pwm-ipq` driver, selected by
`qcom,ipq8074-pwm`. It is not a separate driver, for these reasons:

- The divider search, `get_state` math, clock handling and probe are the same
  for both blocks. Only the field widths and the register packing differ.
- The QSDK driver also covers both blocks in one file (`ops_v1` / `ops_v2`).

The v2 path is unchanged: its limits (`0xffff` for every field and a 1 s
maximum period) produce exactly the same values as before.

Differences from the QSDK driver:

- It uses the atomic `.apply`/`.get_state` API.
- It does not reprogram the channel to a 10 ns default on request.
- An out-of-range period is clamped to the longest achievable one, instead of
  the 10 ns default.
- **Disabled state = 0 % duty.** The idle level of a v1 channel with `ENABLE`
  clear is not documented. So `enabled = false` (which `leds-pwm-multicolor`
  uses for brightness 0) is programmed as `HI_DUR = 0` with the channel
  running. QSDK itself produces this state for a 0 % duty cycle.
  `get_state` reports such a channel as disabled.

### Clock rate and resolution

`assigned-clock-rates = <200000000>`, the stock and QSDK rate (GPLL0 / 4).

| Rate | Max period | 1 ms period → (`PRE_DIV`, `PWM_DIV`) | Duty steps at 1 ms |
|---|---|---|---|
| **200 MHz** (used) | 1.311 ms (256 × 1024 / 200 MHz) | (199, 999), exact | 1000 (+ off), 1 µs each |
| 100 MHz | 2.621 ms | (99, 999), exact | 1000 |
| 19.2 MHz | 13.65 ms | (19, 959), exact | 960 |

With `max-brightness = 255`, all 256 brightness values map to distinct
`HI_DUR` values: 0, 3, 7, … 1000. This was checked by simulating the driver's
arithmetic.

## LED names after this change

| LED | sysfs name | Notes |
|---|---|---|
| X light (PWM) | `rgb:indicator` | `multi_index` = `red green blue`, `max_brightness` 255 |
| system blue (GPIO 48) | `blue:status` | alias `led-running` |
| system yellow (GPIO 52) | `yellow:status` | aliases `led-boot`, `led-failsafe`, `led-upgrade` |
| network blue (GPIO 51) | `blue:wan` | |
| network yellow (GPIO 50) | `yellow:wan` | |

Before this change, the gpio-leds had no `function`, so their names were
colors only, with numeric suffixes on duplicates. The X light was three on/off
GPIO LEDs.

## Post-flash verification (coordinator, second AP)

Run these steps in this order. Steps 1–4 are read-only and touch only
kernel/sysfs state. **Do not do step 6 unless steps 1 and 2 pass.**

### 1. PWM driver bound

```sh
dmesg | grep -iE 'pwm|ipq-pwm|leds'          # expect no errors
ls /sys/bus/platform/drivers/ipq-pwm/         # expect: 7700020.pwm
ls /sys/class/pwm/                            # expect: pwmchip0
cat /sys/class/pwm/pwmchip0/npwm              # expect: 4
```

If `7700020.pwm` is missing, stop. Report `dmesg` and do **not** read any
`0x077000xx` address.

### 2. Clock running

```sh
mount | grep -q debugfs || echo "debugfs not mounted"   # OpenWrt mounts it by default
grep -i pwm /sys/kernel/debug/clk/clk_summary
# expect: adss_pwm_clk_src and gcc_adss_pwm_clk, enable count >= 1, rate 200000000
cat /sys/kernel/debug/pwm
# expect pwm-0..2 "requested enabled" (or disabled while dark), period: 1000000 ns
grep -E 'pin (63|64|66) ' /sys/kernel/debug/pinctrl/*/pinmux-pins
# expect: function pwm0 / pwm1 / pwm2, owned by 7700020.pwm
```

### 3. LED class

```sh
ls /sys/class/leds/
# expect: rgb:indicator blue:status yellow:status blue:wan yellow:wan (+ PHY LEDs)
cat /sys/class/leds/rgb:indicator/multi_index        # red green blue
cat /sys/class/leds/rgb:indicator/max_brightness     # 255
```

### 4. Visual check

```sh
L=/sys/class/leds/rgb:indicator
echo "255 0 0" > $L/multi_intensity; echo 255 > $L/brightness   # X is red
echo 30 > $L/brightness                                          # visibly dimmer, no flicker
echo "0 255 0" > $L/multi_intensity; echo 255 > $L/brightness   # green
echo "0 0 255" > $L/multi_intensity                              # blue
echo "255 255 255" > $L/multi_intensity                          # white-ish
echo 0 > $L/brightness                                           # all three OFF
```

If the light stays on at brightness 0, the 0 %-duty programming does not hold
the output low. Report this; it is a driver issue, not a wiring issue. The
system LEDs should still show the boot and running states (`blue:status` on
after boot).

### 5. Duty cycle in debugfs (optional)

`cat /sys/kernel/debug/pwm` after the red/30 step should show pwm-0 with
`duty: 117647 ns` (30/255 × 1 ms).

### 6. Register read-back (optional, only after steps 1 and 2 passed)

> Reading ADSS registers while their clock is gated can hang the SoC. Read
> them only if `7700020.pwm` is bound (step 1) **and** CBCR shows the clock
> running right before the read.

```sh
devmem 0x0181c020 32     # gcc_adss_pwm_clk CBCR: bit 0 = 1 and bit 31 = 0, else STOP
devmem 0x0181c00c 32     # CFG_RCGR: 0x00000107 (GPLL0 / 4 = 200 MHz)
devmem 0x07700020 32     # PWM0
devmem 0x07700024 32     # PWM1
devmem 0x07700028 32     # PWM2
```

Expected values with `multi_intensity` = `255 0 0`, `PRE_DIV` = 199 (`0xc7`)
and `PWM_DIV` = 999 (`0x3e7`):

| State | PWM0 | PWM1 / PWM2 |
|---|---|---|
| brightness 255 (`HI_DUR` 1000) | `0xb1cfa3e7` | `0xb1c003e7` (`HI_DUR` 0) |
| brightness 30 (`HI_DUR` 117) | `0xb1c1d7e7` | `0xb1c003e7` |

If bit 30 (`UPDATE`) still reads 1 (for example `0xf1cfa3e7`), the hardware
does not clear it on its own. Note this in the report; it does no harm.

## Operational notes

* **Access point without a WAN uplink:** the "offline" event watches `ax9000.led.wan_iface`
  (default `wan`). On a dumb AP with no WAN, either set it to the interface that carries
  your uplink (`uci set ax9000.led.wan_iface='lan'; uci commit ax9000`) or disable the
  event (`uci set ax9000.offline.enabled='0'; uci commit ax9000`), otherwise the X light
  shows the offline state permanently.
* **Any change to `/etc/config/ax9000` briefly restarts the LED daemon** (procd config
  trigger), so the X light may flicker for a moment, including when the fan page saves.
