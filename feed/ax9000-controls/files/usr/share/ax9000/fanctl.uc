// Pure decision logic of ax9000-fand: UCI -> config, and one control step.
// No sysfs/ubus/uci access, so it is unit tested on the host.
import { BUILTIN, validate, duty_for, apply_hysteresis, safety, active_mode } from './fancurve.uc';

export const DEFAULT_SENSORS = [
	'cpu0-thermal', 'cpu1-thermal', 'cpu2-thermal', 'cpu3-thermal',
	'nss-top-thermal', 'nss0-thermal', 'nss1-thermal',
	'wcss-phya0-thermal', 'wcss-phya1-thermal', 'wcss-phyb0-thermal', 'wcss-phyb1-thermal',
	'ath11k_hwmon', 'ath10k_hwmon'
];

const MODES = ['silent', 'balanced', 'aggressive', 'custom', 'manual'];
const TEMP_MIN = -40;
const TEMP_MAX = 150;

function clone(v) {
	return json(sprintf('%J', v));
}

function is_num(v) {
	let t = type(v);
	return t == 'int' || t == 'double';
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

// "T:DUTY" (DUTY may be "min") -> [T, DUTY]; malformed -> [null, null], which
// validate() reports as invalid.
function parse_point(s) {
	let m = type(s) == 'string' ? match(s, /^[ ]*(-?[0-9]+):(min|[0-9]+)[ ]*$/) : null;
	if (!m)
		return [null, null];
	return [int(m[1]), m[2] == 'min' ? 'min' : int(m[2])];
}

// Formats profile points as UCI list values ("50:min", "60:40").
export function format_points(points) {
	return map(points, p => sprintf('%s:%s', p[0], p[1]));
};

// `all` is the result of uci.get_all('ax9000'): sections keyed by name with
// ".type"/".index" meta fields and list options as arrays. Returns the
// effective configuration; UCI profiles override a deep copy of BUILTIN.
export function parse_uci(all) {
	all ??= {};
	let fan = all.fan ?? {};
	let cfg = {
		mode: fan.mode ?? 'balanced',
		manual_duty: to_int(fan.manual_duty, 50, 0, 100),
		interval: to_int(fan.interval, 5, 1, 60),
		sensors: length(as_list(fan.sensor)) ? as_list(fan.sensor) : [...DEFAULT_SENSORS],
		schedule_enabled: fan.schedule_enabled == '1',
		schedule: [],
		profiles: clone(BUILTIN)
	};
	cfg.profiles.custom = clone(BUILTIN.balanced);

	for (let name, sec in all) {
		if (sec['.type'] != 'fan_profile')
			continue;
		let p = cfg.profiles[name] ??= clone(BUILTIN.balanced);
		let pts = as_list(sec.point);
		if (length(pts))
			p.points = map(pts, parse_point);
		if (sec.min_duty != null)
			p.min_duty = to_num(sec.min_duty);
		if (sec.hysteresis != null)
			p.hysteresis = to_num(sec.hysteresis);
	}

	let wins = [];
	for (let name, sec in all)
		if (sec['.type'] == 'fan_schedule')
			push(wins, sec);
	wins = sort(wins, (a, b) => (a['.index'] ?? 0) - (b['.index'] ?? 0));
	cfg.schedule = map(wins, w => ({ start: w.start, end: w.end, mode: w.mode }));

	return cfg;
};

// Keeps only windows with a known mode; start/end validity is checked by
// active_mode() itself.
export function usable_schedule(schedule) {
	return filter(type(schedule) == 'array' ? schedule : [], w => type(w) == 'object' && w.mode in MODES);
};

// One control step.
//   state     { mode, duty, temp } carried between ticks (hysteresis), or null
//   readings  [{ id, label, temp }]; temp null/garbage = failed sensor, skipped
//   cfg       result of parse_uci()
// Returns { duty, mode, temp, error, state }; error is null, "sensor_error" or
// "profile_invalid". Every failure path ends at a safe duty.
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

	let mode = cfg.schedule_enabled
		? active_mode(usable_schedule(cfg.schedule), now_minutes, cfg.mode)
		: cfg.mode;

	let error = null;
	let profile = null;
	if (mode != 'manual') {
		profile = cfg.profiles?.[mode];
		if (!(mode in MODES) || profile == null || validate(profile) != null) {
			profile = BUILTIN.balanced;
			error = 'profile_invalid';
		}
	}

	// No usable sensor at all: run flat out.
	if (temp == null)
		return { duty: 100, mode, temp: null, error: 'sensor_error', state: { mode, duty: null, temp: null } };

	let duty, next;
	if (mode == 'manual') {
		duty = to_int(cfg.manual_duty, 50, 0, 100);
		next = { mode, duty: null, temp: null };
	}
	else {
		let prev = state.mode == mode ? state : {};
		let raw = duty_for(profile, temp);
		let hy = is_num(profile.hysteresis) ? profile.hysteresis : 3;
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

// UCI values for restoring a profile to its defaults, or null for an unknown
// name. "custom" resets to a copy of balanced.
export function reset_values(name) {
	if (type(name) != 'string')
		return null;
	let p = name == 'custom' ? BUILTIN.balanced : BUILTIN[name];
	if (type(p) != 'object')
		return null;
	return {
		min_duty: '' + p.min_duty,
		hysteresis: '' + p.hysteresis,
		point: format_points(p.points)
	};
};
