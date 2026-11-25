import { assert_eq } from './assert.uc';
import { BUILTIN, validate, duty_for, apply_hysteresis, safety, active_mode } from 'fancurve';

assert_eq(duty_for(BUILTIN.balanced, 40), 20, "below first point -> min");
assert_eq(duty_for(BUILTIN.balanced, 65), 53, "52.5 rounds to 53");
assert_eq(duty_for(BUILTIN.aggressive, 90), 100, "above last");
assert_eq(duty_for(BUILTIN.silent, 75), 48, "47.5 -> 48");
assert_eq(duty_for(BUILTIN.silent, 60), 20, "min point resolves to min_duty");
assert_eq(duty_for(BUILTIN.aggressive, 10), 40, "below first -> first duty");
assert_eq(type(duty_for(BUILTIN.balanced, 65)), 'int', "int result");
assert_eq(type(duty_for(BUILTIN.balanced, 60)), 'int', "int result on exact point");
assert_eq(duty_for({ points: [[50, 5], [60, 5]], min_duty: 20, hysteresis: 3 }, 55), 20, "clamped to min_duty");
assert_eq(duty_for({ points: [[50, 0], [60, 0]], min_duty: 0, hysteresis: 3 }, 55), 0, "zero allowed when min_duty 0");

for (let k in ['silent', 'balanced', 'aggressive'])
	assert_eq(validate(BUILTIN[k]), null, k + " builtin valid");
assert_eq(BUILTIN.balanced.min_duty, 20);
assert_eq(BUILTIN.balanced.hysteresis, 3);
assert_eq(BUILTIN.silent.points, [[60, "min"], [70, 35], [80, 60], [85, 100]]);
assert_eq(BUILTIN.balanced.points, [[50, "min"], [60, 40], [70, 65], [78, 100]]);
assert_eq(BUILTIN.aggressive.points, [[45, 40], [55, 60], [65, 85], [72, 100]]);

assert_eq(validate({ points: [[70,10],[60,20]], min_duty: 20, hysteresis: 3 }), "points must be sorted by temperature");
assert_eq(validate({ points: [[60,10],[70,101]], min_duty: 20, hysteresis: 3 }), "duty must be between 0 and 100");
assert_eq(validate({ points: [[60,-1],[70,10]], min_duty: 20, hysteresis: 3 }), "duty must be between 0 and 100");
assert_eq(validate({ points: [[60,10]], min_duty: 20, hysteresis: 3 }), "at least 2 points required");
assert_eq(validate({ points: [], min_duty: 20, hysteresis: 3 }), "at least 2 points required");
assert_eq(validate({ min_duty: 20, hysteresis: 3 }), "at least 2 points required");
assert_eq(validate(null), "at least 2 points required");
assert_eq(validate({ points: [[60,"x"],[70,10]], min_duty: 20, hysteresis: 3 }), "points must be numeric");
assert_eq(validate({ points: [["a",10],[70,10]], min_duty: 20, hysteresis: 3 }), "points must be numeric");
assert_eq(validate({ points: [[60,10],[60,20]], min_duty: 20, hysteresis: 3 }), "points must be sorted by temperature");

assert_eq(apply_hysteresis(65, 70, 53, 68, 3), 65, "small drop keeps duty");
assert_eq(apply_hysteresis(65, 70, 40, 60, 3), 40, "big drop follows");
assert_eq(apply_hysteresis(65, 70, 80, 71, 3), 80, "rise never held");
assert_eq(apply_hysteresis(65, 70, 80, 69, 3), 80, "rise never held even if temp fell");
assert_eq(apply_hysteresis(65, 70, 65, 70, 3), 65, "equal");
assert_eq(apply_hysteresis(65, 70, 40, 67, 3), 40, "temp == prev-hyst releases");
assert_eq(apply_hysteresis(null, null, 40, 60, 3), 40, "no previous");

assert_eq(safety(85, 30), 100);
assert_eq(safety(90, 30), 100);
assert_eq(safety(84, 30), 30);

let night = [{ start: "23:00", end: "07:00", mode: "silent" }];
assert_eq(active_mode(night, 23*60+30, "balanced"), "silent");
assert_eq(active_mode(night, 23*60, "balanced"), "silent", "start inclusive");
assert_eq(active_mode(night, 6*60+59, "balanced"), "silent");
assert_eq(active_mode(night, 0, "balanced"), "silent");
assert_eq(active_mode(night, 7*60, "balanced"), "balanced", "end exclusive");
assert_eq(active_mode(night, 12*60, "balanced"), "balanced");
assert_eq(active_mode([{ start: "10:00", end: "10:00", mode: "silent" }], 600, "balanced"), "balanced");
let day = [{ start: "08:00", end: "18:00", mode: "aggressive" }, { start: "09:00", end: "10:00", mode: "silent" }];
assert_eq(active_mode(day, 9*60, "balanced"), "aggressive", "first match wins");
assert_eq(active_mode(day, 18*60, "balanced"), "balanced");
assert_eq(active_mode([], 100, "balanced"), "balanced");
assert_eq(active_mode(null, 100, "balanced"), "balanced");
assert_eq(active_mode([{ start: "bad", end: "07:00", mode: "silent" }], 100, "balanced"), "balanced", "malformed skipped");

print("test_fancurve: ok\n");
