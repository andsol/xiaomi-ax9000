import { assert_eq } from './assert.uc';
import { BUILTIN } from 'fancurve';
import { parse_uci, decide, usable_schedule, format_points, pwm_step, reset_values, DEFAULT_SENSORS } from 'fanctl';

function rd(...temps) {
	return map(temps, (t, i) => ({ id: 's' + i, label: 's' + i, temp: t }));
}

let base = parse_uci({});
assert_eq(base.mode, 'balanced', "default mode");
assert_eq(base.manual_duty, 50);
assert_eq(base.interval, 5);
assert_eq(base.sensors, DEFAULT_SENSORS);
assert_eq(base.profiles.balanced, BUILTIN.balanced, "builtin copied");
assert_eq(base.profiles.custom, BUILTIN.balanced, "custom defaults to balanced");

// Merging UCI must not mutate BUILTIN (deep copy).
let ov = parse_uci({
	silent: { '.type': 'fan_profile', point: ['60:min', '90:100'], min_duty: '25' }
});
assert_eq(ov.profiles.silent.points, [[60, 'min'], [90, 100]]);
assert_eq(ov.profiles.silent.min_duty, 25);
assert_eq(ov.profiles.silent.hysteresis, 3, "inherits untouched fields");
assert_eq(BUILTIN.silent.points, [[60, "min"], [70, 35], [80, 60], [85, 100]], "BUILTIN untouched");
assert_eq(BUILTIN.silent.min_duty, 20);

assert_eq(format_points(BUILTIN.balanced.points), ['50:min', '60:40', '70:65', '78:100']);

let c = parse_uci({
	fan: { '.type': 'fan', mode: 'custom', manual_duty: '70', interval: '9', sensor: ['a', 'b'], schedule_enabled: '1' },
	w2: { '.type': 'fan_schedule', '.index': 2, start: '08:00', end: '09:00', mode: 'silent' },
	w1: { '.type': 'fan_schedule', '.index': 1, start: '23:00', end: '07:00', mode: 'aggressive' }
});
assert_eq([c.mode, c.manual_duty, c.interval, c.sensors, c.schedule_enabled], ['custom', 70, 9, ['a', 'b'], true]);
assert_eq(map(c.schedule, w => w.start), ['23:00', '08:00'], "schedule ordered by index");

// --- Review focus 1: sensor failures -------------------------------------
let r = decide(null, rd(null, null), base, 600);
assert_eq([r.duty, r.error, r.temp], [100, 'sensor_error', null], "all sensors failed");
r = decide(null, [], base, 600);
assert_eq([r.duty, r.error], [100, 'sensor_error'], "no sensors at all");
r = decide(null, rd(999, -100, null, "x"), base, 600);
assert_eq([r.duty, r.error], [100, 'sensor_error'], "only garbage -> sensor_error");
r = decide(null, rd(null, 999, 40), base, 600);
assert_eq([r.duty, r.error, r.temp], [20, null, 40], "garbage and failures skipped, valid one used");
r = decide(null, rd(40, 60, 55), base, 600);
assert_eq(r.temp, 60, "max of valid sensors");
assert_eq(r.duty, 40);
{
	let m = parse_uci({ fan: { '.type': 'fan', mode: 'manual', manual_duty: '30' } });
	r = decide(null, rd(null), m, 0);
	assert_eq([r.duty, r.error], [100, 'sensor_error'], "manual mode also fails safe");
}

// --- Review focus 2: invalid profile -> balanced -------------------------
let bad = parse_uci({
	fan: { '.type': 'fan', mode: 'custom' },
	custom: { '.type': 'fan_profile', point: ['70:50', '60:20'] }
});
r = decide(null, rd(65), bad, 0);
assert_eq([r.duty, r.error, r.mode], [53, 'profile_invalid', 'custom'], "unsorted custom -> balanced curve");
for (let pts in [['60:101', '70:10'], ['60:20'], ['x:20', '70:30']]) {
	let b = parse_uci({
		fan: { '.type': 'fan', mode: 'custom' },
		custom: { '.type': 'fan_profile', point: pts }
	});
	r = decide(null, rd(65), b, 0);
	assert_eq([r.duty, r.error], [53, 'profile_invalid'], "invalid custom: " + join(',', pts));
}
r = decide(null, rd(65), parse_uci({ fan: { '.type': 'fan', mode: 'turbo' } }), 0);
assert_eq([r.duty, r.error], [53, 'profile_invalid'], "unknown mode falls back to balanced");
r = decide(null, rd(65), base, 0);
assert_eq([r.duty, r.error], [53, null], "valid builtin has no error");
r = decide(null, rd(null), bad, 0);
assert_eq(r.error, 'sensor_error', "sensor_error wins over profile_invalid");

// --- Safety floor and manual mode ---------------------------------------
let man = parse_uci({ fan: { '.type': 'fan', mode: 'manual', manual_duty: '30' } });
r = decide(null, rd(50), man, 0);
assert_eq([r.duty, r.error, r.mode], [30, null, 'manual'], "manual duty");
r = decide(null, rd(84), man, 0);
assert_eq(r.duty, 30, "below floor");
r = decide(null, rd(85), man, 0);
assert_eq(r.duty, 100, "85 C floor in manual mode");
r = decide(null, rd(90, 40), man, 0);
assert_eq(r.duty, 100, "floor uses the hottest sensor");
let sil = parse_uci({ fan: { '.type': 'fan', mode: 'silent' } });
assert_eq(decide(null, rd(85), sil, 0).duty, 100, "floor in silent");
let flat = parse_uci({
	fan: { '.type': 'fan', mode: 'custom' },
	custom: { '.type': 'fan_profile', point: ['50:10', '90:10'], min_duty: '10' }
});
assert_eq(decide(null, rd(86), flat, 0).duty, 100, "floor overrides a flat custom curve");

// --- Review focus 4: hysteresis across ticks -----------------------------
let st = null;
r = decide(st, rd(65), base, 0); st = r.state;
assert_eq(r.duty, 53);
r = decide(st, rd(64), base, 0); st = r.state;
assert_eq(r.duty, 53, "held within hysteresis");
r = decide(st, rd(63), base, 0); st = r.state;
assert_eq(r.duty, 53, "still held (63 > 62)");
r = decide(st, rd(62), base, 0); st = r.state;
assert_eq(r.duty, 45, "released at 3 C below");
r = decide(st, rd(66), base, 0); st = r.state;
assert_eq(r.duty, 55, "rising applies immediately");
r = decide(st, rd(65), base, 0); st = r.state;
assert_eq(r.duty, 55, "held again after rise (ref temp updated)");
r = decide(st, rd(null), base, 0); st = r.state;
assert_eq(r.duty, 100, "sensor loss mid-run");
r = decide(st, rd(50), base, 0); st = r.state;
assert_eq(r.duty, 20, "recovery has no stale hold");

// --- Mode change resets hysteresis --------------------------------------
let cb = parse_uci({ fan: { '.type': 'fan', mode: 'aggressive' } });
r = decide(null, rd(70), base, 0);
let s2 = r.state;
r = decide(s2, rd(70), cb, 0);
assert_eq(r.duty, 96, "aggressive at 70 C, no hold from balanced state");

// --- Review focus 3 + carry-over: schedule ------------------------------
let sc = parse_uci({
	fan: { '.type': 'fan', mode: 'balanced', schedule_enabled: '1' },
	a: { '.type': 'fan_schedule', '.index': 1, start: '23:00', end: '07:00', mode: 'silent' },
	b: { '.type': 'fan_schedule', '.index': 2, start: '12:00', end: '12:00', mode: 'aggressive' },
	c: { '.type': 'fan_schedule', '.index': 3, start: '08:00', end: '09:00' },
	d: { '.type': 'fan_schedule', '.index': 4, start: '09:00', end: '10:00', mode: 'bogus' }
});
assert_eq(decide(null, rd(40), sc, 23 * 60 + 30).mode, 'silent', "crosses midnight, late");
assert_eq(decide(null, rd(40), sc, 3 * 60).mode, 'silent', "crosses midnight, early");
assert_eq(decide(null, rd(40), sc, 12 * 60).mode, 'balanced', "equal start/end never active");
assert_eq(decide(null, rd(40), sc, 8 * 60 + 30).mode, 'balanced', "window without mode skipped");
assert_eq(decide(null, rd(40), sc, 9 * 60 + 30).mode, 'balanced', "window with unknown mode skipped");
assert_eq(length(usable_schedule(sc.schedule)), 2, "only windows with known modes kept");
sc.schedule_enabled = false;
assert_eq(decide(null, rd(40), sc, 23 * 60 + 30).mode, 'balanced', "schedule disabled");
// --- pwm quantisation: round up to the driver's 10 % steps ---------------
assert_eq(pwm_step(55), { pct: 60, pwm: 153 }, "55 -> 60 %");
assert_eq(pwm_step(50), { pct: 50, pwm: 128 }, "exact step stays (127.5 rounds up)");
assert_eq(pwm_step(51), { pct: 60, pwm: 153 }, "51 -> 60 %");
assert_eq(pwm_step(0), { pct: 0, pwm: 0 }, "0");
assert_eq(pwm_step(1), { pct: 10, pwm: 26 }, "1 -> 10 %");
assert_eq(pwm_step(20), { pct: 20, pwm: 51 }, "20");
assert_eq(pwm_step(100), { pct: 100, pwm: 255 }, "100");
assert_eq(pwm_step(99), { pct: 100, pwm: 255 }, "99 -> 100");
for (let d = 0; d <= 100; d++)
	if (pwm_step(d).pct < d)
		assert_eq(d, null, "applied never below requested");

for (let d = 0; d <= 100; d += 0.5)
	if (pwm_step(d).pct < d)
		assert_eq(d, null, "applied never below requested (fractional)");
assert_eq(pwm_step(50.5), { pct: 60, pwm: 153 }, "50.5 -> 60 %");
assert_eq(pwm_step(50.0), { pct: 50, pwm: 128 }, "50.0 stays");
assert_eq(pwm_step(0.5), { pct: 10, pwm: 26 }, "0.5 -> 10 %");
assert_eq(pwm_step(100.0), { pct: 100, pwm: 255 }, "100.0");

// --- reset_profile values ---------------------------------------------------
assert_eq(reset_values('silent'), { min_duty: '20', hysteresis: '3', point: ['60:min', '70:35', '80:60', '85:100'] });
assert_eq(reset_values('custom'), reset_values('balanced'), "custom resets to balanced copy");
assert_eq(reset_values('turbo'), null, "unknown name");
assert_eq(reset_values('manual'), null, "manual is not a profile");
assert_eq(reset_values(null), null, "non-string");
assert_eq(reset_values({}), null, "object");

print("test_fanctl: ok\n");
