// Pure decision logic of ax9000-fand: UCI -> config, and one control step.
// No sysfs/ubus/uci access, so it is unit tested on the host.
import { DEFAULTS, validate, duty_for, apply_hysteresis, safety, in_window } from './fancurve.uc';

export const DEFAULT_SENSORS = [
	'cpu0-thermal', 'cpu1-thermal', 'cpu2-thermal', 'cpu3-thermal',
	'nss-top-thermal', 'nss0-thermal', 'nss1-thermal',
	'wcss-phya0-thermal', 'wcss-phya1-thermal', 'wcss-phyb0-thermal', 'wcss-phyb1-thermal',
	'ath11k_hwmon', 'ath10k_hwmon'
];

export const PROFILES = ['day', 'night'];
const TEMP_MIN = -40;
const TEMP_MAX = 150;

function clone(v) {
	return json(sprintf('%J', v));
}

function to_num(v) {
	if (type(v) == 'string' && match(v, /^-?[0-9]+(\.[0-9]+)?$/))
		return +v;
	return v; // null stays null; garbage stays garbage so validate() rejects it
}

function to_int(v, def, lo, hi) {
	let n = to_num(v);
	if (type(n) != 'int')
		return def;
	return n < lo ? lo : (n > hi ? hi : n);
}

function as_list(v) {
	return type(v) == 'array' ? v : (v == null ? [] : [v]);
}

// "T:DUTY" -> [T, DUTY]; malformed -> [null, null], which validate() reports.
function parse_point(s) {
	let m = type(s) == 'string' ? match(s, /^[ ]*(-?[0-9]+):([0-9]+)[ ]*$/) : null;
	if (!m)
		return [null, null];
	return [int(m[1]), int(m[2])];
}

// Formats profile points as UCI list values ("60:25", "68:40").
export function format_points(points) {
	return map(points, p => sprintf('%s:%s', p[0], p[1]));
};

// `all` is the result of uci.get_all('ax9000'): sections keyed by name with
// ".type" meta fields and list options as arrays. Returns the effective
// configuration; UCI values override a deep copy of DEFAULTS.
export function parse_uci(all) {
	all ??= {};
	let fan = all.fan ?? {};
	let cfg = {
		interval: to_int(fan.interval, 5, 1, 60),
		sensors: length(as_list(fan.sensor)) ? as_list(fan.sensor) : [...DEFAULT_SENSORS],
		night_enabled: fan.night_enabled == '1',
		night_start: fan.night_start ?? '23:00',
		night_end: fan.night_end ?? '07:00',
		profiles: clone(DEFAULTS)
	};

	for (let name in PROFILES) {
		let sec = all[name];
		if (type(sec) != 'object' || sec['.type'] != 'fan_profile')
			continue;
		let p = cfg.profiles[name];
		if (sec.mode != null)
			p.mode = sec.mode;
		if (sec.fixed_duty != null)
			p.fixed = to_num(sec.fixed_duty);
		if (sec.hysteresis != null)
			p.hysteresis = to_num(sec.hysteresis);
		let pts = as_list(sec.point);
		if (length(pts))
			p.points = map(pts, parse_point);
	}

	return cfg;
};

// The setting in force at `now_minutes` (minutes since local midnight).
export function active_profile(cfg, now_minutes) {
	return cfg.night_enabled && in_window(cfg.night_start, cfg.night_end, now_minutes) ? 'night' : 'day';
};

// One control step.
//   state     { mode, duty, temp } carried between ticks (hysteresis), or null
//   readings  [{ id, label, temp }]; temp null/garbage = failed sensor, skipped
//   cfg       result of parse_uci()
// Returns { duty, mode, temp, error, state }; mode is 'day' or 'night'; error
// is null, "sensor_error" or "profile_invalid". Every failure path ends at a
// safe duty.
export function decide(state, readings, cfg, now_minutes) {
	state ??= {};

	let temp = null;
	for (let r in (type(readings) == 'array' ? readings : [])) {
		let t = r?.temp;
		if (type(t) != 'int' || t < TEMP_MIN || t > TEMP_MAX)
			continue;
		if (temp == null || t > temp)
			temp = t;
	}

	let mode = active_profile(cfg, now_minutes);
	let error = null;
	let profile = cfg.profiles?.[mode];
	if (profile == null || validate(profile) != null) {
		profile = DEFAULTS[mode];
		error = 'profile_invalid';
	}

	// No usable sensor at all: run flat out.
	if (temp == null)
		return { duty: 100, mode, temp: null, error: 'sensor_error', state: { mode, duty: null, temp: null } };

	let duty, next;
	if (profile.mode == 'fixed') {
		duty = duty_for(profile, temp);
		next = { mode, duty: null, temp: null };
	}
	else {
		let prev = state.mode == mode ? state : {};
		let raw = duty_for(profile, temp);
		let hy = profile.hysteresis ?? 3;
		duty = apply_hysteresis(prev.duty, prev.temp, raw, temp, hy);
		// The reference temperature only stays put while hysteresis holds the duty.
		next = { mode, duty, temp: duty != raw ? prev.temp : temp };
	}

	return { duty: safety(temp, duty), mode, temp, error, state: next };
};

// The emc2305 driver has cooling states 0..10 (10 % steps, closest rounding).
// Round the wanted duty UP to the next step so the fan never runs slower than
// the curve asks. Returns { pct: applied percent, pwm: value for pwm1 (0..255) }.
export function pwm_step(duty) {
	let st = int(duty / 10);
	if (st * 10 < duty)
		st++;
	if (st > 10)
		st = 10;
	if (st < 0)
		st = 0;
	return { pct: st * 10, pwm: int(st * 255 / 10.0 + 0.5) };
};

// UCI values that restore a setting ('day' or 'night') to its defaults, or
// null for an unknown name.
export function reset_values(name) {
	if (type(name) != 'string' || !(name in PROFILES))
		return null;
	let p = DEFAULTS[name];
	return {
		mode: p.mode,
		fixed_duty: '' + p.fixed,
		hysteresis: '' + p.hysteresis,
		point: format_points(p.points)
	};
};
