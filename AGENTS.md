# Notes for agents working on this repository

Custom OpenWrt 25.12 build for the Xiaomi AX9000 (`qualcommax/ipq807x`): QCN9074 board
data file, EMC2301 fan control, the RGB "X" light on hardware PWM, and the LuCI app
`luci-app-ax9000-controls`. Start with [README.md](README.md), then
[docs/build.md](docs/build.md) and [docs/install.md](docs/install.md).

## Ground rules

- Everything in the repository is written in English (code, comments, docs, commit
  messages). Talk to the maintainer in the language they use.
- The repository is meant to be public. Never commit `.env`, router passwords, IP
  addresses, firmware images or anything under `firmware/`, `out/`.
- Commit only when asked. Feature work goes on a `feat/*` branch, not on `master`.
- Patches in `patches/openwrt/` are `git format-patch` style and written as if for
  upstream. Do not hack around a problem in the build script when it belongs in a patch.
- Built images must not be redistributed (modified Qualcomm BDF, see `bdf/README.md`).

## Where things are

| What | Where |
|------|-------|
| OpenWrt release pin | `openwrt.version` (`TAG`, `COMMIT`); change it deliberately, patches may need a rebase |
| Build | `./build.sh` (Docker); `./build.sh --shell` for a shell in the tree; the real script is `scripts/build-openwrt.sh` |
| Image config | `config/ax9000.config`; personal packages in git-ignored `config/local.config` |
| Fan service | `feed/ax9000-controls/files/usr/sbin/ax9000-fand`, logic in `usr/share/ax9000/fancurve.uc` + `fanctl.uc`, rpcd object `ax9000.fan` |
| LED service | `usr/sbin/ax9000-ledd`, logic in `usr/share/ax9000/ledctl.uc` + `ledfx.uc`, rpcd object `ax9000.led` |
| UCI defaults / migration | `feed/ax9000-controls/files/etc/uci-defaults/90-ax9000-{fan,led}` |
| LuCI pages | `feed/luci-app-ax9000-controls/htdocs/luci-static/resources/view/ax9000/{fan,led}.js` |
| LED effect maths for the browser | `htdocs/.../resources/ax9000/ledfx.js`, a port of `ledfx.uc` kept in sync by `tests/js` |
| LuCI ACL | `feed/luci-app-ax9000-controls/root/usr/share/rpcd/acl.d/luci-app-ax9000-controls.json` |
| Translations | `feed/luci-app-ax9000-controls/po/` (template + `ru`), synced by `scripts/i18n-sync.js` |
| Design history | `docs/superpowers/` is git-ignored working material (specs, plans) |

## Configuration model (`/etc/config/ax9000`)

- `config fan 'fan'`: `interval`, `list sensor`, `night_enabled`, `night_start`, `night_end`.
- `config fan_profile 'day'` and `'night'`: `mode` (`curve` | `fixed`), `fixed_duty`,
  `hysteresis`, `list point 'TEMP:DUTY'` (4 points, temperatures strictly increasing).
  Below the first point the fan is stopped (0 %). Safety: the service forces 100 % at
  85 °C; the kernel trip points (60 % above 75 °C, 100 % above 85 °C) work without it.
- The old schema (`fan.mode` silent/balanced/aggressive/custom/manual, `fan_schedule`) is
  converted once by `90-ax9000-fan`; keep that script idempotent.
- `config led 'led'` (X light), `config led_event '<offline|wps|upgrade>'` (events).
- `config indicator 'top'|'bottom'`: front indicators, `color` (`white` | `yellow`),
  `action` (`off` | `on` | `heartbeat` | `blink` | `netdev`), `port` (`wan`, `lan1`..`lan4`).
  Top = Internet (`blue:wan`, `yellow:wan`), bottom = System (`blue:status`,
  `yellow:status`); the blue LED looks white. The page also writes the matching standard
  `config led` sections to `/etc/config/system`; the unused colour is set to off.

## Tests

- No ucode on a Windows host. Run `tests/ucode` either in the builder container
  (`./build.sh --shell`, then `sh /src/tests/ucode/run.sh`) or on a test router: copy
  `tests/ucode` and `feed/ax9000-controls/files` to `/tmp/axt` and run each test with
  `ucode -L "/tmp/axt/feed/ax9000-controls/files/usr/share/ax9000/*.uc" -L "/tmp/axt/tests/ucode/*.uc" <test>`
  (absolute `-L` paths; relative ones do not resolve).
- `test_ledrpc.uc` expects no running LED service, so it fails on a live router by design.
- `node tests/js/test_ledfx.js` checks the browser port of the effect maths.
- `node --check` every LuCI view you touch; `scripts/verify-image.sh all <sysupgrade.bin>`
  checks a built image.
- Write or update a unit test with every change to `fancurve.uc`, `fanctl.uc`,
  `ledctl.uc` or `ledfx.uc`, and work out expected numbers by hand (rounding is half up).

## Working on the routers

- Connection details are in `.env` (`SSH_MAIN_*`, `SSH_SECOND_*`). Use key-based SSH
  (the maintainer's key is `~/.ssh/id_ed25519_ax9000`); **never use the passwords** in
  `.env`, and never type a password into LuCI. If a browser shows the LuCI login page,
  ask the maintainer to log in.
- There are two routers: the main one and a second access point. **Try every change on
  the second AP first**, and ask before touching the main router or flashing anything.
- Hot deploy without rebuilding: there is no `sftp-server`, so `scp` fails. Copy with
  `ssh host 'cat > /path' < file` or pipe a `tar` over ssh. Map
  `feed/ax9000-controls/files/*` to `/`, LuCI `htdocs/*` to `/www/`, `root/*` to `/`.
  Then restart what changed: `/etc/init.d/rpcd restart` (ACL or rpcd plugin),
  `/etc/init.d/ax9000-fand restart`, `/etc/init.d/ax9000-ledd restart`, and
  `rm -rf /tmp/luci-indexcache* /tmp/luci-modulecache`. Hot-deployed files are replaced
  by the next image flash; the package database keeps the old version until then.
- Translations (`.lmo`) are compiled at build time; a hot deploy shows new strings in
  English until the next image.
- BusyBox userland: no `comm`, no `usleep`, `sleep` takes whole seconds. Use `ucode -e`
  for anything fancier (it has `sleep(ms)` and `fs`).
- Make a backup of the files and `/etc/config` you are about to change, and remove it
  when the maintainer confirms the result.

## LuCI pitfalls (learned the hard way)

- The browser caches view JS: the URL carries the `luci-base` version, not ours. After
  a deploy, reload without cache (Ctrl+F5, or `fetch(url, {cache:'reload'})`) or you test
  the old page.
- `ui.changes.apply()` returns immediately; the config is committed seconds later.
  Never chain service restarts after it. Use procd config triggers instead (the
  `ax9000-ledd` init script restarts `/etc/init.d/led` on `/etc/config/system` changes,
  because the stock led script has no trigger).
- rpcd resolves `/sys/class/leds/<name>` symlinks before its file ACL check, so
  `fs.read('/sys/class/leds/*/trigger')` is always denied. Use `luci.getLEDs`.
- `String.format()`: a literal `%` in a formatted string must be written `%%`, or
  the following text is eaten as a format spec.
- An element with `display:grid`/`flex` ignores the `hidden` attribute; the pages
  include `[hidden]{display:none !important}` scoped to `.axf` / `.axl`.
- Set `<select>` values with `.value` after creating the options; do not rely on
  `E()` dropping a `null` attribute.
- The pages stage changes in UCI (`uci.set` + `uci.save()` in `handleSave`) and use the
  standard Save / Save & Apply / Reset buttons. Read state from `uci` (it includes
  staged changes), not from rpcd, which only sees committed config.
- Styles must work in both bootstrap themes (it follows the OS dark mode): use
  `currentColor` and translucent greys, no fixed light or dark backgrounds.

## Translations

```sh
node scripts/i18n-sync.js check                 # lists strings without a Russian translation
node scripts/i18n-sync.js write ru-add.json     # ru-add.json: { "English": "Русский", ... }
```

Run `write` after changing any `_('...')` string; it drops strings no longer used and
keeps the file headers.

## Upgrading the routers to a new build

The user-facing procedure is in [docs/install.md](docs/install.md#upgrading-to-a-newer-build).
For the maintainer's routers:

1. If the OpenWrt release changes: update `openwrt.version`, rebuild, fix patches that
   no longer apply, run all tests and `scripts/verify-image.sh`.
2. On each router, list packages installed on top of the image:
   `for p in $(cat /etc/apk/world); do grep -qw "$p" /rom/etc/apk/world || echo "$p"; done`.
   Anything wanted permanently goes into `config/local.config` (kernel-module packages
   can only come from there: the custom kernel does not match the official kmods).
3. Back up with the package list: `sysupgrade -k -b /tmp/backup-$(date +%F).tar.gz`,
   copy it off the router. `sysupgrade -l` must list `/etc/config/ax9000` and
   `/etc/config/system`.
4. Flash the second AP first, check it, then the main router: `sysupgrade -v <image>`
   (never `-n`). Ask the maintainer before each flash.
5. After the flash: `logread -e ax9000`, `ubus call ax9000.fan status`,
   `ubus call ax9000.led status`; reinstall missing userspace packages; reload the
   LuCI pages without cache.

`luci-app-attendedsysupgrade` is deliberately not in the image: it would flash a stock
build and drop the patches.
