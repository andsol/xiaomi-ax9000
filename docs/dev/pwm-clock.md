# ADSS PWM clock on IPQ8074 (gcc-ipq8074)

Upstream Linux `gcc-ipq8074` (6.12, as used by OpenWrt 25.12.6) has no clock
for the PWM block. `patches/openwrt/0200-qualcommax-ipq8074-add-adss-pwm-clock.patch`
adds the kernel patch
`target/linux/qualcommax/patches-6.12/0142-clk-qcom-gcc-ipq8074-add-ADSS-PWM-clock.patch`,
which defines the clock pair below and two new DT binding indices.

## Values

GCC base address: `0x01800000` (`clock-controller@1800000`).

| Item | Value |
|---|---|
| RCG `adss_pwm_clk_src` CMD_RCGR | offset `0x1c008` (abs. `0x0181c008`) |
| RCG CFG_RCGR (CMD_RCGR + 4) | offset `0x1c00c` (abs. `0x0181c00c`) |
| RCG `hid_width` | 5 |
| RCG parents (`gcc_xo_gpll0_map`) | XO (src sel 0), GPLL0 (src sel 1) |
| Frequency table | 19.2 MHz = XO /1; 100 MHz = GPLL0 /8; 200 MHz = GPLL0 /4 |
| Branch `gcc_adss_pwm_clk` CBCR | offset `0x1c020` (abs. `0x0181c020`), enable `BIT(0)`, halt bit 31 |
| Branch flags | `CLK_SET_RATE_PARENT` |
| ADSS block reset (already upstream) | `GCC_ADSS_BCR` offset `0x1c000` |
| New bindings (`qcom,gcc-ipq8074.h`) | `ADSS_PWM_CLK_SRC` = 228, `GCC_ADSS_PWM_CLK` = 229 |

The binding numbers are the next free indices after `GCC_CRYPTO_PPE_CLK` (227),
the last clock index in the 6.12 header. They intentionally differ from the
QSDK numbering (see below); the DT in this repo uses the macro names only.

The 19.2 MHz and 200 MHz entries come verbatim from QSDK. The 100 MHz entry is
an addition: GPLL0 on IPQ8074 runs at 800 MHz and `F(100000000, P_GPLL0, 8, 0, 0)`
is used by other RCGs in the same upstream driver (e.g. `pcnoc_bfdcd_clk_src`,
`pcie0_rchng_clk_src`); it matches the upstream IPQ6018 PWM table and lets a
PWM node use `assigned-clock-rates = <100000000>` like the IPQ6018 node
(`patches-6.12/0138`). The stock Xiaomi firmware runs the clock at 200 MHz.

## Sources

1. Qualcomm QSDK 4.4 kernel (the generation the Xiaomi stock firmware is built
   from): `https://git.codelinaro.org/clo/qsdk/oss/kernel/linux-msm.git`,
   branch `NHSS.QSDK.11.3`, commit `1b21d38cb136111da61d9dac3b6024c9ca732a65`.
   - `drivers/clk/qcom/gcc-ipq807x.c`: `ftbl_adss_pwm_clk_src` = {19.2 MHz XO,
     200 MHz GPLL0/4}; `adss_pwm_clk_src.cmd_rcgr = 0x1c008`, `hid_width = 5`,
     `parent_map = gcc_xo_gpll0_map` ({P_XO,0},{P_GPLL0,1});
     `gcc_adss_pwm_clk.halt_reg = enable_reg = 0x1c020`, `halt_bit = 31`,
     `enable_mask = BIT(0)`, `CLK_SET_RATE_PARENT`.
   - `include/dt-bindings/clock/qcom,gcc-ipq807x.h`: `ADSS_PWM_CLK_SRC 239`,
     `GCC_ADSS_PWM_CLK 240` (= `0xf0`).
2. Qualcomm QSDK 5.4 kernel:
   `https://git.codelinaro.org/clo/qsdk/oss/kernel/linux-ipq-5.4.git`,
   branch `NHSS.QSDK.12.2.r10`, commit `a07b6a415d21f82bd83f69d54d9985581322d633`
   (also checked `NHSS.QSDK.11.4.1.r1`).
   - `drivers/clk/qcom/gcc-ipq8074.c`: identical RCG/branch definitions
     (`0x1c008`, `0x1c020`, XO/GPLL0, 19.2/200 MHz).
   - `include/dt-bindings/clock/qcom,gcc-ipq8074.h`: `ADSS_PWM_CLK_SRC 231`,
     `GCC_ADSS_PWM_CLK 232`.
3. Upstream Linux 6.12.112 `drivers/clk/qcom/gcc-ipq6018.c`: `adss_pwm_clk_src`
   `cmd_rcgr = 0x1c008`, `hid_width = 5`, `gcc_xo_gpll0_map`;
   `gcc_adss_pwm_clk` `halt_reg = enable_reg = 0x1c020`, `BIT(0)`,
   `CLK_SET_RATE_PARENT`; table 24 MHz XO / 100 MHz GPLL0/8 (IPQ6018 XO is
   24 MHz, IPQ8074 XO is 19.2 MHz). Same offsets and structure as QSDK IPQ807x.
4. Xiaomi AX9000 stock DT (`AP-HK14`, firmware 1.0.168): the `pwm` node
   (`compatible = "qca,ipq4019-pwm"`) has `clocks = <&gcc 0xf0>`, and the GCC
   node is `compatible = "qcom,gcc-ipq807x"`; `0xf0` = 240 =
   `GCC_ADSS_PWM_CLK` in the QSDK 4.4 binding (source 1). This confirms the
   stock kernel drives the PWM from exactly this clock.
5. Stock PWM driver (QSDK 4.4 `drivers/pwm/pwm-ipq4019.c`, source 1):
   `SRC_FREQ = 200 MHz`; probe does `clk_set_rate(clk, 200 MHz)` then
   `clk_prepare_enable(clk)`. Hence the expected register values on stock
   firmware below.

## Hardware check (read-only, coordinator)

Run on the **second** AP. These are reads only; never write these addresses.
If `devmem` is missing, ask the user before installing anything (stock:
`busybox devmem`; OpenWrt: `busybox` with `CONFIG_BUSYBOX_CONFIG_DEVMEM`).

```sh
devmem 0x0181c020 32   # gcc_adss_pwm_clk CBCR
devmem 0x0181c008 32   # adss_pwm_clk_src CMD_RCGR
devmem 0x0181c00c 32   # adss_pwm_clk_src CFG_RCGR
devmem 0x0181c000 32   # GCC_ADSS_BCR (block reset)
```

Expected on stock firmware (PWM driver probed, clock set to 200 MHz and
enabled):

| Register | Expected | Meaning |
|---|---|---|
| CBCR `0x0181c020` | bit 0 = 1, bit 31 = 0 (typically `0x00000001`; other mid bits may be set) | branch enabled, `CLK_OFF` clear = clock running |
| CMD_RCGR `0x0181c008` | bit 31 = 0, bit 0 = 0 (typically `0x00000000`) | `ROOT_OFF` clear, no update pending |
| CFG_RCGR `0x0181c00c` | `0x00000107` | `SRC_SEL` [10:8] = 1 (GPLL0), `SRC_DIV` [4:0] = 7 (divide by 4) → 200 MHz |
| ADSS_BCR `0x0181c000` | `0x00000000` | block not held in reset |

Expected on OpenWrt with the PWM node from `0201` (`assigned-clock-rates =
<200000000>`, see `leds.md`): CBCR bit 0 = 1 / bit 31 = 0 while the PWM device
is bound, CFG_RCGR `0x00000107` (GPLL0, divide by 4), same as stock. Without any
consumer, `clk_disable_unused` normally clears the enable bit at late init, so
CBCR bit 0 is expected to read 0; bit 31 (`CLK_OFF`) then usually reads 1, but
that is not guaranteed (the hardware may still report the clock as on if
something else votes for it), so do not treat a particular full value such as
`0x80000000` as the expected reading in that case.

### Unexpected results

- CBCR bit 0 = 1 but bit 31 = 1, or every address reads
  `0x00000000`/`0xffffffff` regardless: unexpected — stop and report the raw
  values; do not try other addresses.
- CBCR bit 0 = 0 on **stock** firmware: the PWM driver may not have probed or
  may have released the clock. Before drawing conclusions, check the kernel's
  view: `cat /sys/kernel/debug/clk/clk_summary | grep -i pwm` (if debugfs is
  mounted; otherwise `mount -t debugfs none /sys/kernel/debug`, ask the user
  first) and `ls /sys/class/pwm/` (a `pwmchip*` entry means the driver
  probed). Report what was found; do not proceed to the ADSS reads below.

### ADSS PWM block (optional, informational)

> **Warning: these reads can hang the router.** On Qualcomm SoCs, reading a
> peripheral register whose clock is gated can stall the bus or raise an
> SError and lock up the SoC (needs a power cycle). Read `0x077000xx` **only
> after** CBCR `0x0181c020` was just read with bit 0 = 1 **and** bit 31 = 0
> (clock running) — in practice only on stock firmware with the PWM driver
> probed. **Never** read these addresses on OpenWrt unless a PWM consumer is
> bound to `GCC_ADSS_PWM_CLK` (otherwise the clock is gated by
> `clk_disable_unused`).

On stock, the PWM channels live in the ADSS block at `0x07700000` (QSDK 5.4
`ipq8074.dtsi`: `pwm { compatible = "qti,ipq-pwm"; reg = <0x7700000 0x30>; }`),
one control register per channel at `0x07700020/24/28/2c`
(`ADSS_GLB_PWMn_CTRL_REG`, bit 31 enable):

```sh
# ONLY if 0x0181c020 reads bit0=1, bit31=0 right before (see warning above)
devmem 0x07700020 32; devmem 0x07700024 32; devmem 0x07700028 32
```

## Stock AX9000 DT: PWM node (v1 vs v2)

From the stock DT (`AP-HK14`, firmware 1.0.168, dtb `8_49e39c`):

```dts
pwm {
	compatible = "qca,ipq4019-pwm";
	clocks = <&gcc 0xf0>;          /* GCC_ADSS_PWM_CLK (QSDK 4.4 numbering) */
	clock-names = "core";
	pwm-base-index = <0x00>;
	used-pwm-indices = <0x01 0x01 0x01 0x00>;
	status = "ok";
	pinctrl-0 = <&pwm_pinmux>;      /* gpio63 pwm01, gpio64 pwm11, gpio66 pwm21 */
	pinctrl-names = "default";
};

audio@7700000 {
	compatible = "qca,ipq8074-audio-adss";
	reg = <0x7700000 0x34>;
	resets = <&gcc 0x1a>;
	reset-names = "blk_rst";
};
```

The `pwm` node has **no `reg`** and `status = "ok"`. In the stock driver
(`pwm-ipq4019.c`), `qca,ipq4019-pwm` selects `ops_v1`, which accesses
`ADSS_GLB_PWMn_CTRL_REG` (0x20–0x2c) through the audio ADSS driver's mapping
of `0x7700000` — not the IPQ6018 "v2" layout in TCSR (`0x1937000 + 0xa010`,
two registers per channel) that `pwm-ipq` (`patches-6.12/0141`) implements.
So the AX9000 PWM is the v1 block in ADSS. `patches/openwrt/0201` adds a v1
variant to `pwm-ipq`; details are in `leds.md`.

## Result of the hardware check

_Pending (Task 1 Step 2, done by the coordinator)._
