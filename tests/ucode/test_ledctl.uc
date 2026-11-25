import { assert_eq } from './assert.uc';
import { readfile } from 'fs';
import { parse_uci, decide, is_conn_error } from "ledctl";

// Load the shipped UCI defaults by parsing the `uci -q set` lines.
function defaults_sections() {
	const rel = 'feed/ax9000-controls/files/etc/uci-defaults/90-ax9000-led';
	let src = readfile('/src/' + rel) ?? readfile(rel);
	if (!src)
		die('cannot read ' + rel);
	let secs = {}, order = [];
	for (let line in split(src, '\n')) {
		let m = match(line, /^\s*uci -q set ax9000\.([a-z_]+)(\.([a-z_]+))?='?([^']*)'?\s*$/);
		if (!m) continue;
		if (!m[3]) {
			secs[m[1]] = { '.name': m[1], '.type': m[4] };
			push(order, m[1]);
		} else
			secs[m[1]][m[3]] = m[4];
	}
	return map(order, n => secs[n]);
}

const T0 = 100000;
const cfg0 = parse_uci(defaults_sections());
const none = {};

function with_led(c, over) {
	return { led: { ...c.led, ...over }, events: c.events };
}
function with_ev(c, name, over) {
	return { led: c.led, events: map(c.events, e => e.name == name ? { ...e, ...over } : e) };
}

// defaults -> static blue, not animated
let d = decide(cfg0, none, 600, T0, null);
assert_eq(d.intensity, [0, 0, 255]);
assert_eq(d.brightness, 255);
assert_eq(d.animated, false);
assert_eq(d.effect, 'static');
assert_eq(length(cfg0.events), 3);

// offline -> red flashing, animated; on/off phases at 0.5x speed (2 s period)
d = decide(cfg0, { offline: true }, 600, 500, null);
assert_eq(d.intensity, [255, 0, 0]);
assert_eq(d.animated, true);
assert_eq(d.events_active, ['offline']);
assert_eq(decide(cfg0, { offline: true }, 600, 1500, null).intensity, [0, 0, 0]);

// priorities: wps (80) beats offline (50); upgrade (90) beats both
d = decide(cfg0, { offline: true, wps: true }, 600, 0, null);
assert_eq(d.effect, 'breathing');
assert_eq(d.color, '#00ff00');
d = decide(cfg0, { offline: true, wps: true, upgrade: true }, 600, 0, null);
assert_eq(d.effect, 'static');
assert_eq(d.intensity, [255, 160, 0]);
// when the top one clears, the next shows, then the base
d = decide(cfg0, { offline: true }, 600, 0, null);
assert_eq(d.effect, 'flashing');
assert_eq(decide(cfg0, none, 600, 0, null).effect, 'static');

// disabled events are ignored
let c = with_ev(cfg0, 'offline', { enabled: false });
d = decide(c, { offline: true }, 600, 0, null);
assert_eq(d.effect, 'static');
assert_eq(d.intensity, [0, 0, 255]);
assert_eq(d.events_active, []);
c = with_ev(cfg0, 'wps', { enabled: false });
assert_eq(decide(c, { offline: true, wps: true }, 600, 0, null).effect, 'flashing');

// Review focus 1: brightness 0 -> off, even with an event active
c = with_led(cfg0, { brightness: '0' });
d = decide(c, none, 600, 0, null);
assert_eq(d.intensity, [0, 0, 0]);
assert_eq(d.brightness, 0);
assert_eq(d.animated, false);
d = decide(c, { offline: true }, 600, 0, null);
assert_eq(d.brightness, 0);
assert_eq(d.intensity, [0, 0, 0]);
assert_eq(d.animated, false);
d = decide(c, { offline: true, wps: true }, 600, 0, null);
assert_eq(d.brightness, 0);
// ... except an override_night event (upgrade)
d = decide(c, { offline: true, upgrade: true }, 600, 0, null);
assert_eq(d.intensity, [255, 160, 0]);
assert_eq(d.brightness, 255);
// off until reboot behaves like brightness 0
c = { led: cfg0.led, events: cfg0.events, off: true };
assert_eq(decide(c, none, 600, 0, null).brightness, 0);
assert_eq(decide(c, { upgrade: true }, 600, 0, null).brightness, 255);

// night mode off: dark inside the window (23:00-07:00), normal outside
c = with_led(cfg0, { night_enabled: '1', night_mode: 'off' });
d = decide(c, none, 23 * 60 + 30, 0, null);
assert_eq(d.intensity, [0, 0, 0]);
assert_eq(d.brightness, 0);
assert_eq(d.night, true);
d = decide(c, { offline: true }, 3 * 60, 0, null);
assert_eq(d.brightness, 0);
assert_eq(d.animated, false);
d = decide(c, none, 12 * 60, 0, null);
assert_eq(d.intensity, [0, 0, 255]);
assert_eq(d.night, false);
// override_night event shows through night off
d = decide(c, { upgrade: true }, 3 * 60, 0, null);
assert_eq(d.intensity, [255, 160, 0]);
assert_eq(d.brightness, 255);
// night disabled -> window ignored
d = decide(with_led(cfg0, { night_mode: 'off' }), none, 3 * 60, 0, null);
assert_eq(d.intensity, [0, 0, 255]);

// night dim: brightness x 0.2, override event stays full
c = with_led(cfg0, { night_enabled: '1', night_mode: 'dim', brightness: '200' });
assert_eq(decide(c, none, 3 * 60, 0, null).brightness, 40);
assert_eq(decide(c, { upgrade: true }, 3 * 60, 0, null).brightness, 200);
assert_eq(decide(c, none, 12 * 60, 0, null).brightness, 200);

// Review focus 4: preview active, then expired -> configured effect returns
let pv = { effect: 'rainbow', color: '#000000', speed: 1, brightness: 128,
	start_ms: T0, until_ms: T0 + 5000 };
d = decide(cfg0, none, 600, T0 + 1000, pv);
assert_eq(d.preview, true);
assert_eq(d.effect, 'rainbow');
assert_eq(d.animated, true);
assert_eq(d.brightness, 128);
d = decide(cfg0, { offline: true }, 600, T0 + 4999, pv);
assert_eq(d.effect, 'rainbow');
d = decide(cfg0, none, 600, T0 + 5000, pv);
assert_eq(d.preview, false);
assert_eq(d.effect, 'static');
assert_eq(d.intensity, [0, 0, 255]);
assert_eq(d.animated, false);
d = decide(cfg0, { offline: true }, 600, T0 + 60000, pv);
assert_eq(d.effect, 'flashing');
// preview shows even at night / brightness 0 config
c = with_led(cfg0, { brightness: '0', night_enabled: '1' });
d = decide(c, none, 3 * 60, T0 + 1, { ...pv, effect: 'static', color: '#ff0000' });
assert_eq(d.intensity, [255, 0, 0]);
assert_eq(d.brightness, 128);

// speed extremes through decide stay in range and never divide by zero
for (let sp in [0, 0.1, 10, 1000]) {
	c = with_led(cfg0, { effect: 'rainbow', speed: '' + sp });
	d = decide(c, none, 0, 12345, null);
	for (let v in d.intensity)
		assert_eq(v >= 0 && v <= 255, true, 'range at speed ' + sp);
}

// ubus error classification: only connection-level errors force a reconnect
for (let e in ['Connection failed', 'Timeout', 'Request timed out'])
	assert_eq(is_conn_error(e), true, e);
for (let e in ['Not found', 'Method not found', 'Operation not supported', 'Not supported',
               'No data', 'Invalid argument', 'Permission denied', 'Unknown error', null, ''])
	assert_eq(is_conn_error(e), false, '' + e);

print("test_ledctl: ok\n");
