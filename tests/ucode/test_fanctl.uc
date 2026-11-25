import { assert_eq } from './assert.uc';
import { DEFAULTS } from 'fancurve';
import { parse_uci, decide, format_points, pwm_step, reset_values, DEFAULT_SENSORS } from 'fanctl';

function rd(...temps) {
	return map(temps, (t, i) => ({ id: 's' + i, label: 's' + i, temp: t }));
}

const NOON = 12 * 60, MIDNIGHT = 0;

// --- parse_uci ----------------------------------------------------------------
let base = parse_uci({});
assert_eq(base.interval, 5);
assert_eq(base.sensors, DEFAULT_SENSORS);
assert_eq([base.night_enabled, base.night_start, base.night_end], [false, '23:00', '07:00'], "night defaults");
assert_eq(base.profiles, DEFAULTS, "defaults copied");

let c = parse_uci({
	fan: { '.type': 'fan', interval: '9', sensor: ['a', 'b'], night_enabled: '1', night_start: '22:30', night_end: '06:00' },
	day: { '.type': 'fan_profile', mode: 'curve', hysteresis: '2', point: ['50:20', '60:40', '70:70', '80:100'] },
	night: { '.type': 'fan_profile', mode: 'fixed', fixed_duty: '30' }
});
assert_eq([c.interval, c.sensors, c.night_enabled, c.night_start, c.night_end], [9, ['a', 'b'], true, '22:30', '06:00']);
assert_eq(c.profiles.day, { mode: 'curve', fixed: 40, hysteresis: 2, points: [[50, 20], [60, 40], [70, 70], [80, 100]] });
assert_eq(c.profiles.night, { mode: 'fixed', fixed: 30, hysteresis: 3, points: DEFAULTS.night.points }, "unset fields inherit");
assert_eq(DEFAULTS.day.points, [[60, 25], [68, 40], [76, 65], [84, 100]], "DEFAULTS untouched");

let legacy = parse_uci({ silent: { '.type': 'fan_profile', point: ['60:min'] }, day: { '.type': 'other', mode: 'fixed' } });
assert_eq(legacy.profiles, DEFAULTS, "unknown sections and wrong types ignored");

assert_eq(format_points(DEFAULTS.day.points), ['60:25', '68:40', '76:65', '84:100']);

// --- sensor failures -----------------------------------------------------------
let r = decide(null, rd(null, null), base, NOON);
assert_eq([r.duty, r.error, r.temp], [100, 'sensor_error', null], "all sensors failed");
r = decide(null, [], base, NOON);
assert_eq([r.duty, r.error], [100, 'sensor_error'], "no sensors at all");
r = decide(null, rd(999, -100, null, "x"), base, NOON);
assert_eq([r.duty, r.error], [100, 'sensor_error'], "only garbage -> sensor_error");
r = decide(null, rd(null, 999, 64), base, NOON);
assert_eq([r.duty, r.error, r.temp], [33, null, 64], "garbage and failures skipped, valid one used");
r = decide(null, rd(40, 64, 55), base, NOON);
assert_eq([r.temp, r.duty], [64, 33], "max of valid sensors");
r = decide(null, rd(50), base, NOON);
assert_eq([r.duty, r.error, r.mode], [0, null, 'day'], "below the first point the fan stops");
{
	let f = parse_uci({ day: { '.type': 'fan_profile', mode: 'fixed', fixed_duty: '30' } });
	r = decide(null, rd(null), f, NOON);
	assert_eq([r.duty, r.error], [100, 'sensor_error'], "fixed speed also fails safe");
}

// --- invalid profile -> that setting's defaults ----------------------------
let bad = parse_uci({ day: { '.type': 'fan_profile', point: ['70:50', '60:20'] } });
r = decide(null, rd(64), bad, NOON);
assert_eq([r.duty, r.error, r.mode], [33, 'profile_invalid', 'day'], "unsorted day -> default day curve");
for (let pts in [['60:101', '70:10'], ['60:20'], ['x:20', '70:30'], ['60:min', '70:30']]) {
	let b = parse_uci({ day: { '.type': 'fan_profile', point: pts } });
	r = decide(null, rd(64), b, NOON);
	assert_eq([r.duty, r.error], [33, 'profile_invalid'], "invalid day: " + join(',', pts));
}
r = decide(null, rd(64), parse_uci({ day: { '.type': 'fan_profile', mode: 'turbo' } }), NOON);
assert_eq([r.duty, r.error], [33, 'profile_invalid'], "unknown mode -> defaults");
r = decide(null, rd(70), parse_uci({ fan: { '.type': 'fan', night_enabled: '1' }, night: { '.type': 'fan_profile', mode: 'fixed', fixed_duty: 'x' } }), MIDNIGHT);
assert_eq([r.duty, r.error, r.mode], [27, "profile_invalid", "night"], "bad night -> default night curve");
r = decide(null, rd(null), bad, NOON);
assert_eq(r.error, 'sensor_error', "sensor_error wins over profile_invalid");

// --- fixed speed and the safety floor ----------------------------------------
let fx = parse_uci({ day: { '.type': 'fan_profile', mode: 'fixed', fixed_duty: '30' } });
r = decide(null, rd(50), fx, NOON);
assert_eq([r.duty, r.error, r.mode], [30, null, 'day'], "fixed duty");
assert_eq(decide(null, rd(84), fx, NOON).duty, 30, "below floor");
assert_eq(decide(null, rd(85), fx, NOON).duty, 100, "85 C floor with a fixed speed");
assert_eq(decide(null, rd(90, 40), fx, NOON).duty, 100, "floor uses the hottest sensor");
let zero = parse_uci({ day: { '.type': 'fan_profile', point: ['80:0', '95:0'] } });
assert_eq(decide(null, rd(86), zero, NOON).duty, 100, "floor overrides a zero curve");

// --- day / night selection -----------------------------------------------------
let dn = parse_uci({
	fan: { '.type': 'fan', night_enabled: '1', night_start: '23:00', night_end: '07:00' },
	night: { '.type': 'fan_profile', mode: 'fixed', fixed_duty: '20' }
});
assert_eq(decide(null, rd(70), dn, 23 * 60 + 30).mode, 'night', "night, late");
assert_eq(decide(null, rd(70), dn, 3 * 60).duty, 20, "night fixed speed");
assert_eq(decide(null, rd(70), dn, 7 * 60).mode, 'day', "end exclusive");
assert_eq(decide(null, rd(70), dn, NOON).duty, 46, "day curve at noon");
dn.night_enabled = false;
assert_eq(decide(null, rd(70), dn, 3 * 60).mode, 'day', "night disabled -> day all the time");

// --- hysteresis across ticks -----------------------------------------------------
let st = null;
r = decide(st, rd(72), base, NOON); st = r.state;
assert_eq(r.duty, 53);
r = decide(st, rd(71), base, NOON); st = r.state;
assert_eq(r.duty, 53, "held within hysteresis");
r = decide(st, rd(70), base, NOON); st = r.state;
assert_eq(r.duty, 53, "still held (70 > 69)");
r = decide(st, rd(69), base, NOON); st = r.state;
assert_eq(r.duty, 43, "released at 3 C below");
r = decide(st, rd(73), base, NOON); st = r.state;
assert_eq(r.duty, 56, "rising applies immediately");
r = decide(st, rd(null), base, NOON); st = r.state;
assert_eq(r.duty, 100, "sensor loss mid-run");
r = decide(st, rd(50), base, NOON); st = r.state;
assert_eq(r.duty, 0, "recovery has no stale hold");

// stop/start around the first point
st = null;
r = decide(st, rd(60), base, NOON); st = r.state;
assert_eq(r.duty, 25, "starts at the first point");
r = decide(st, rd(58), base, NOON); st = r.state;
assert_eq(r.duty, 25, "keeps running 2 C below");
r = decide(st, rd(57), base, NOON); st = r.state;
assert_eq(r.duty, 0, "stops 3 C below");

// switching day -> night drops the hold
let sw = parse_uci({ fan: { '.type': 'fan', night_enabled: '1' } });
r = decide(null, rd(72), sw, NOON);
r = decide(r.state, rd(71), sw, MIDNIGHT);
assert_eq([r.mode, r.duty], ["night", 29], "night curve at 71 C, no hold from day");

// --- pwm quantisation: round up to the driver's 10 % steps ---------------
assert_eq(pwm_step(55), { pct: 60, pwm: 153 }, "55 -> 60 %");
assert_eq(pwm_step(50), { pct: 50, pwm: 128 }, "exact step stays (127.5 rounds up)");
assert_eq(pwm_step(0), { pct: 0, pwm: 0 }, "0 stops the fan");
assert_eq(pwm_step(1), { pct: 10, pwm: 26 }, "1 -> 10 %");
assert_eq(pwm_step(25), { pct: 30, pwm: 77 }, "25 -> 30 %");
assert_eq(pwm_step(100), { pct: 100, pwm: 255 }, "100");
for (let d = 0; d <= 100; d += 0.5)
	if (pwm_step(d).pct < d)
		assert_eq(d, null, "applied never below requested");

// --- reset values -------------------------------------------------------------
assert_eq(reset_values('day'), { mode: 'curve', fixed_duty: '40', hysteresis: '3', point: ['60:25', '68:40', '76:65', '84:100'] });
assert_eq(reset_values('night'), { mode: 'curve', fixed_duty: '20', hysteresis: '3', point: ['65:20', '72:30', '80:55', '86:100'] });
assert_eq(reset_values('balanced'), null, "old preset names are gone");
assert_eq(reset_values(null), null, "non-string");
assert_eq(reset_values({}), null, "object");

print("test_fanctl: ok\n");
