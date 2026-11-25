// Decision logic of the X-light service: UCI parsing and the pure
// decide() step. No sysfs/ubus/uloop access, so it is unit-testable on a host.

import { resolve, frame, is_animated, in_window, hex_to_rgb } from 'ledfx';

const DEFAULT_LED = {
	effect: 'static', color: '#0000ff', speed: '1', brightness: '255',
	night_enabled: '0', night_start: '23:00', night_end: '07:00',
	night_mode: 'off', wan_iface: 'wan'
};

function num(v, dflt) {
	let n = (v == null || v == '') ? null : +v;
	return (type(n) == 'int' || type(n) == 'double') ? n : dflt;
}

function clamp_brightness(v) {
	let n = int(num(v, 255));
	return n < 0 ? 0 : (n > 255 ? 255 : n);
}

// sections: array of { '.name', '.type', ...options } in config order
// (what uci cursor foreach() yields). Returns { led, events }.
export function parse_uci(sections) {
	let led = { ...DEFAULT_LED };
	let events = [];

	for (let s in sections ?? []) {
		if (s['.type'] == 'led' && s['.name'] == 'led') {
			for (let k in keys(DEFAULT_LED))
				if (s[k] != null)
					led[k] = s[k];
		} else if (s['.type'] == 'led_event') {
			push(events, {
				name: s['.name'],
				enabled: s.enabled == '1',
				priority: int(num(s.priority, 0)),
				effect: s.effect ?? 'static',
				color: s.color ?? '#ffffff',
				speed: num(s.speed, 1),
				override_night: s.override_night == '1'
			});
		}
	}
	return { led, events };
};

function pick(events, active) {
	let chosen = null;
	for (let ev in events)
		if (active?.[ev.name] && (chosen == null || ev.priority > chosen.priority))
			chosen = ev;
	return chosen;
}

// cfg: parse_uci() result, optionally with cfg.off = true (off until reboot).
// events_active: { name: bool }. now_minutes: minutes since local midnight.
// t_ms: monotonic ms. preview: null or { effect, color, speed, brightness,
// start_ms, until_ms } on the t_ms clock; it applies while t_ms < until_ms
// and ignores night/brightness-0/off (it is an explicit user request).
// Returns { intensity:[r,g,b], brightness:int, animated:bool, effect, color
// ("#rrggbb" of the unscaled resolved color), events_active:[names], night,
// preview:bool }.
export function decide(cfg, events_active, now_minutes, t_ms, preview) {
	let led = cfg.led;
	let events = filter(cfg.events, ev => ev.enabled);
	let night = led.night_enabled == '1' &&
		in_window(led.night_start, led.night_end, now_minutes);
	let names = map(filter(events, ev => events_active?.[ev.name]), ev => ev.name);

	if (preview && t_ms < preview.until_ms) {
		let b = clamp_brightness(preview.brightness);
		let rgb = hex_to_rgb(preview.color);
		let eff = preview.effect ?? 'static';
		let t = t_ms - (preview.start_ms ?? t_ms);
		return {
			intensity: frame(eff, rgb, t, preview.speed),
			brightness: b,
			animated: is_animated(eff) && b > 0,
			effect: eff,
			color: sprintf('#%02x%02x%02x', ...rgb),
			events_active: names, night, preview: true
		};
	}

	let chosen = pick(events, events_active);
	let override = !!(chosen && chosen.override_night);
	let base = {
		effect: led.effect, color: led.color,
		speed: num(led.speed, 1)
	};
	let r = resolve(events_active, events, base, night, led.night_mode);
	let user_b = cfg.off ? 0 : clamp_brightness(led.brightness);

	let b;
	if (user_b == 0 && !override) {
		// The user turned the light off; nothing but an override_night
		// event may light it.
		r.effect = 'off';
		b = 0;
	} else {
		// An override_night event still shows when brightness is 0.
		b = int((user_b == 0 ? 255 : user_b) * r.brightness_scale);
	}
	if (r.effect == 'off')
		b = 0;

	return {
		intensity: frame(r.effect, r.color, t_ms, r.speed),
		brightness: b,
		animated: is_animated(r.effect),
		effect: r.effect,
		color: sprintf('#%02x%02x%02x', ...r.color),
		events_active: names, night, preview: false
	};
};

// ubus errors that mean the connection itself is unusable (libubus status
// strings). Method-level errors (Not found, Not supported, No data, Invalid
// argument, ...) are not connection errors and must not trigger a reconnect.
export function is_conn_error(err) {
	return type(err) == 'string' && !!match(lc(err), /connection|timeout|timed out/);
};
