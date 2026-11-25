// Pure fan-control logic: curves, hysteresis, safety floor and mode
// schedules. No sysfs/ubus/uci access, so it can be unit tested on the host.

export const BUILTIN = {
	silent: {
		points: [[60, "min"], [70, 35], [80, 60], [85, 100]],
		min_duty: 20,
		hysteresis: 3
	},
	balanced: {
		points: [[50, "min"], [60, 40], [70, 65], [78, 100]],
		min_duty: 20,
		hysteresis: 3
	},
	aggressive: {
		points: [[45, 40], [55, 60], [65, 85], [72, 100]],
		min_duty: 20,
		hysteresis: 3
	}
};

const SAFETY_TEMP = 85;

function is_num(v) {
	let t = type(v);
	return t == 'int' || t == 'double';
}

// Returns null when the profile is usable, otherwise an error string.
export function validate(profile) {
	if (type(profile) != 'object' || type(profile.points) != 'array' || length(profile.points) < 2)
		return "at least 2 points required";

	let md = profile.min_duty;
	if (md != null && (!is_num(md) || md < 0 || md > 100))
		return "min_duty must be between 0 and 100";

	let hy = profile.hysteresis;
	if (hy != null && (!is_num(hy) || hy < 0))
		return "hysteresis must be a non-negative number";

	for (let p in profile.points)
		if (type(p) != 'array' || length(p) != 2 || !is_num(p[0]) ||
		    !(is_num(p[1]) || p[1] == "min"))
			return "points must be numeric";

	for (let i = 1; i < length(profile.points); i++)
		if (profile.points[i][0] <= profile.points[i - 1][0])
			return "points must be sorted by temperature";

	for (let p in profile.points)
		if (p[1] != "min" && (p[1] < 0 || p[1] > 100))
			return "duty must be between 0 and 100";

	return null;
};

// Duty (int percent) for a temperature; assumes a validated profile.
export function duty_for(profile, temp) {
	let min_duty = is_num(profile.min_duty) ? profile.min_duty : 20;
	let pts = map(profile.points, p => [p[0], p[1] == "min" ? min_duty : p[1]]);
	let n = length(pts);
	let d;

	if (temp <= pts[0][0])
		d = pts[0][1];
	else if (temp >= pts[n - 1][0])
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
	if (d < min_duty)
		d = int(min_duty);
	if (d > 100)
		d = 100;
	return d;
};

// Hold the previous duty only on the way down, until the temperature has
// dropped by at least `hyst` degrees from where that duty was set.
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

// First matching window wins. Windows may cross midnight; start == end never
// matches. Start is inclusive, end exclusive. Malformed windows are skipped.
export function active_mode(schedule, now_minutes, default_mode) {
	for (let w in (type(schedule) == 'array' ? schedule : [])) {
		let s = parse_hhmm(w?.start), e = parse_hhmm(w?.end);
		if (s == null || e == null || s == e)
			continue;
		let hit = s < e
			? (now_minutes >= s && now_minutes < e)
			: (now_minutes >= s || now_minutes < e);
		if (hit)
			return w.mode;
	}
	return default_mode;
};
