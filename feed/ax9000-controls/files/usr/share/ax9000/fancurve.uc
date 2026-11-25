// Pure fan-control logic: curves, hysteresis, safety floor and the night
// window. No sysfs/ubus/uci access, so it can be unit tested on the host.
//
// A profile is { mode, fixed, hysteresis, points }:
//   mode 'curve'  duty follows `points` ([[temp, duty], ...], temperatures
//                 strictly increasing). Below the first point the fan is
//                 stopped (0 %); above the last it stays at the last duty.
//   mode 'fixed'  duty is `fixed` whatever the temperature.

export const DEFAULTS = {
	day: {
		mode: 'curve',
		fixed: 40,
		hysteresis: 3,
		points: [[60, 25], [68, 40], [76, 65], [84, 100]]
	},
	night: {
		mode: 'curve',
		fixed: 20,
		hysteresis: 3,
		points: [[65, 20], [72, 30], [80, 55], [86, 100]]
	}
};

const SAFETY_TEMP = 85;

function is_num(v) {
	let t = type(v);
	return t == 'int' || t == 'double';
}

// Returns null when the profile is usable, otherwise an error string.
export function validate(profile) {
	if (type(profile) != 'object')
		return "profile must be an object";

	if (profile.mode != 'curve' && profile.mode != 'fixed')
		return "mode must be curve or fixed";

	let hy = profile.hysteresis;
	if (hy != null && (!is_num(hy) || hy < 0))
		return "hysteresis must be a non-negative number";

	if (profile.mode == 'fixed') {
		let f = profile.fixed;
		if (!is_num(f) || f < 0 || f > 100)
			return "fixed speed must be between 0 and 100";
		return null;
	}

	let pts = profile.points;
	if (type(pts) != 'array' || length(pts) < 2)
		return "at least 2 points required";

	for (let p in pts)
		if (type(p) != 'array' || length(p) != 2 || !is_num(p[0]) || !is_num(p[1]))
			return "points must be numeric";

	for (let i = 1; i < length(pts); i++)
		if (pts[i][0] <= pts[i - 1][0])
			return "points must be sorted by temperature";

	for (let p in pts)
		if (p[1] < 0 || p[1] > 100)
			return "duty must be between 0 and 100";

	return null;
};

// Duty (int percent) for a temperature; assumes a validated profile.
export function duty_for(profile, temp) {
	if (profile.mode == 'fixed')
		return int(profile.fixed + 0.5);

	let pts = profile.points;
	let n = length(pts);
	let d;

	if (temp < pts[0][0])
		return 0;
	if (temp >= pts[n - 1][0])
		d = pts[n - 1][1];
	else {
		for (let i = 1; i < n; i++) {
			if (temp <= pts[i][0]) {
				let t0 = pts[i - 1][0], d0 = pts[i - 1][1];
				let t1 = pts[i][0], d1 = pts[i][1];
				d = d0 + (d1 - d0) * (temp - t0) / (t1 - t0 + 0.0); // + 0.0: avoid integer division
				break;
			}
		}
	}

	d = int(d + 0.5); // round half up (duties are non-negative)
	return d > 100 ? 100 : d;
};

// Hold the previous duty only on the way down, until the temperature has
// dropped by at least `hyst` degrees from where that duty was set. This also
// keeps the fan running a little below the first point instead of toggling.
export function apply_hysteresis(prev_duty, prev_temp, new_duty, temp, hyst) {
	if (prev_duty == null || prev_temp == null)
		return new_duty;
	if (new_duty < prev_duty && temp > prev_temp - hyst)
		return prev_duty;
	return new_duty;
};

export function safety(temp, duty) {
	return temp >= SAFETY_TEMP ? 100 : duty;
};

function parse_hhmm(s) {
	let m = type(s) == 'string' ? match(s, /^([0-9]{1,2}):([0-9]{2})$/) : null;
	if (!m)
		return null;
	let h = int(m[1]), mi = int(m[2]);
	if (h > 23 || mi > 59)
		return null;
	return h * 60 + mi;
}

// True when `now_minutes` (since local midnight) lies in [start, end). The
// window may cross midnight; start == end or malformed times never match.
export function in_window(start, end, now_minutes) {
	let s = parse_hhmm(start), e = parse_hhmm(end);
	if (s == null || e == null || s == e)
		return false;
	return s < e
		? (now_minutes >= s && now_minutes < e)
		: (now_minutes >= s || now_minutes < e);
};
