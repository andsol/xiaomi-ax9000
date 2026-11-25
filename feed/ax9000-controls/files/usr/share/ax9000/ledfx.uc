// Pure helpers for the X-light: effect frames, color conversion, event
// resolution and night windows. No sysfs/ubus access; consumed by the LED
// service.

import { cos } from 'math';

const PI = 3.14159265358979323846;

export const EFFECTS = ["static", "breathing", "flashing", "cycle", "rainbow", "off"];

function clamp_byte(v) {
	let n = int(v + 0.5);
	return n < 0 ? 0 : (n > 255 ? 255 : n);
}

function is_num(v) {
	return type(v) == 'int' || type(v) == 'double';
}

function clamp_speed(speed) {
	if (!is_num(speed))
		return 1;
	return speed < 0.1 ? 0.1 : (speed > 10 ? 10 : speed);
}

function abs_(v) {
	return v < 0 ? -v : v;
}

export function hex_to_rgb(str) {
	let m = match(str, /^#?([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/);
	if (!m)
		return [0, 0, 0];
	return [hex(m[1]), hex(m[2]), hex(m[3])];
};

export function hsl_to_rgb(h, s, l) {
	h = h + 0.0;
	h = h - 360 * int(h / 360);
	if (h < 0)
		h += 360;
	s = s / 100.0;
	l = l / 100.0;
	let c = (1 - abs_(2 * l - 1)) * s;
	let hp = h / 60.0;
	let x = c * (1 - abs_(hp - 2 * int(hp / 2) - 1));
	let m = l - c / 2;
	let rgb;
	if (hp < 1) rgb = [c, x, 0];
	else if (hp < 2) rgb = [x, c, 0];
	else if (hp < 3) rgb = [0, c, x];
	else if (hp < 4) rgb = [0, x, c];
	else if (hp < 5) rgb = [x, 0, c];
	else rgb = [c, 0, x];
	return map(rgb, v => clamp_byte((v + m) * 255));
};

export function is_animated(effect) {
	return effect != 'static' && effect != 'off';
};

const PRIMARIES = [[255, 0, 0], [0, 255, 0], [0, 0, 255]];

// color: [r,g,b] (0-255), t_ms: elapsed ms, speed: multiplier (clamped 0.1..10).
// Always returns three ints in 0..255.
export function frame(effect, color, t_ms, speed) {
	speed = clamp_speed(speed) + 0.0; // force double: int / int truncates in ucode
	let t = (is_num(t_ms) && t_ms > 0 ? t_ms : 0) + 0.0;
	let c = map(color ?? [0, 0, 0], clamp_byte);

	switch (effect) {
	case 'static':
		return c;
	case 'breathing': {
		let p = 4000 / speed;
		let ph = (t - p * int(t / p)) / p;
		let k = 0.5 - 0.5 * cos(2 * PI * ph);
		return map(c, v => clamp_byte(v * k));
	}
	case 'flashing': {
		let p = 1000 / speed;
		let ph = t - p * int(t / p);
		return ph < p / 2 ? c : [0, 0, 0];
	}
	case 'cycle': {
		let p = 2000 / speed;
		let pos = t / p;
		let n = int(pos);
		let f = pos - n;
		let a = PRIMARIES[n % 3], b = PRIMARIES[(n + 1) % 3];
		return map([0, 1, 2], i => clamp_byte(a[i] + (b[i] - a[i]) * f));
	}
	case 'rainbow':
		return hsl_to_rgb(t * 0.036 * speed, 100, 50);
	}
	return [0, 0, 0];
};

// Picks the highest-priority active event (ties: first in events_cfg order),
// else base. Night "off" silences everything except an override_night event;
// night "dim" scales brightness to 0.2 (override_night events stay at 1).
// Returned color is an [r,g,b] array.
export function resolve(events_active, events_cfg, base, night, night_mode) {
	let chosen = null;

	for (let ev in events_cfg ?? []) {
		if (!events_active?.[ev.name])
			continue;
		if (chosen == null || (ev.priority ?? 0) > (chosen.priority ?? 0))
			chosen = ev;
	}

	let src = chosen ?? base;
	let out = {
		effect: src.effect ?? 'static',
		color: hex_to_rgb(src.color),
		speed: clamp_speed(src.speed),
		brightness_scale: 1
	};

	if (night && !(chosen && chosen.override_night)) {
		if (night_mode == 'off')
			out.effect = 'off';
		else if (night_mode == 'dim')
			out.brightness_scale = 0.2;
	}
	return out;
};

function to_minutes(s) {
	let m = match(s, /^([0-9]{1,2}):([0-9]{2})$/);
	return m ? int(m[1]) * 60 + int(m[2]) : null;
}

export function in_window(start, end, now_minutes) {
	let a = to_minutes(start), b = to_minutes(end);
	if (a == null || b == null || a == b)
		return false;
	return a < b ? (now_minutes >= a && now_minutes < b)
	             : (now_minutes >= a || now_minutes < b);
};
