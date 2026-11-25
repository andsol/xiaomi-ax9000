import { assert_eq } from './assert.uc';
import { DEFAULTS, validate, duty_for, apply_hysteresis, safety, in_window } from 'fancurve';

const D = DEFAULTS.day;

// --- defaults ---------------------------------------------------------------
assert_eq(D, { mode: 'curve', fixed: 40, hysteresis: 3, points: [[60, 25], [68, 40], [76, 65], [84, 100]] });
assert_eq(DEFAULTS.night, { mode: 'curve', fixed: 20, hysteresis: 3, points: [[65, 20], [72, 30], [80, 55], [86, 100]] });
assert_eq(validate(D), null, "day default valid");
assert_eq(validate(DEFAULTS.night), null, "night default valid");

// --- curve: stopped below the first point -----------------------------------
assert_eq(duty_for(D, 40), 0, "below first point -> stopped");
assert_eq(duty_for(D, 59), 0, "just below first point -> stopped");
assert_eq(duty_for(D, 60), 25, "first point exactly");
assert_eq(duty_for(D, 64), 33, "32.5 rounds half up");
assert_eq(duty_for(D, 76), 65, "on a point");
assert_eq(duty_for(D, 80), 83, "82.5 -> 83");
assert_eq(duty_for(D, 84), 100, "last point");
assert_eq(duty_for(D, 95), 100, "above last stays at last duty");
assert_eq(duty_for({ mode: 'curve', points: [[0, 30], [100, 30]] }, -5), 0, "below 0 C point still stops");
assert_eq(duty_for({ mode: 'curve', points: [[0, 30], [100, 60]] }, 0), 30, "point at 0 C");
assert_eq(duty_for({ mode: 'curve', points: [[40, 0], [90, 80]] }, 100), 80, "last duty below 100 is kept");
assert_eq(type(duty_for(D, 64)), 'int', "int result");
assert_eq(type(duty_for(D, 68)), 'int', "int result on a point");

// --- fixed ------------------------------------------------------------------
assert_eq(duty_for({ mode: 'fixed', fixed: 35, points: D.points }, 20), 35, "fixed ignores the curve");
assert_eq(duty_for({ mode: 'fixed', fixed: 0, points: D.points }, 80), 0, "fixed 0 allowed");

// --- validate ---------------------------------------------------------------
assert_eq(validate(null), "profile must be an object");
assert_eq(validate({ ...D, mode: 'turbo' }), "mode must be curve or fixed");
assert_eq(validate({ ...D, mode: 'fixed', fixed: 101 }), "fixed speed must be between 0 and 100");
assert_eq(validate({ ...D, mode: 'fixed', fixed: 'x' }), "fixed speed must be between 0 and 100");
assert_eq(validate({ ...D, mode: 'fixed', points: null }), null, "fixed needs no points");
assert_eq(validate({ ...D, mode: 'curve', fixed: 'x' }), null, "curve ignores fixed");
assert_eq(validate({ ...D, hysteresis: -1 }), "hysteresis must be a non-negative number");
assert_eq(validate({ ...D, points: [[60, 10]] }), "at least 2 points required");
assert_eq(validate({ ...D, points: null }), "at least 2 points required");
assert_eq(validate({ ...D, points: [[60, 'x'], [70, 10]] }), "points must be numeric");
assert_eq(validate({ ...D, points: [[60, 'min'], [70, 10]] }), "points must be numeric", "legacy min rejected");
assert_eq(validate({ ...D, points: [[70, 10], [60, 20]] }), "points must be sorted by temperature");
assert_eq(validate({ ...D, points: [[60, 10], [60, 20]] }), "points must be sorted by temperature");
assert_eq(validate({ ...D, points: [[60, 10], [70, 101]] }), "duty must be between 0 and 100");
assert_eq(validate({ ...D, points: [[60, -1], [70, 10]] }), "duty must be between 0 and 100");

// --- hysteresis / safety ------------------------------------------------------
assert_eq(apply_hysteresis(65, 70, 53, 68, 3), 65, "small drop keeps duty");
assert_eq(apply_hysteresis(65, 70, 40, 60, 3), 40, "big drop follows");
assert_eq(apply_hysteresis(65, 70, 80, 71, 3), 80, "rise never held");
assert_eq(apply_hysteresis(65, 70, 40, 67, 3), 40, "temp == prev-hyst releases");
assert_eq(apply_hysteresis(null, null, 40, 60, 3), 40, "no previous");
assert_eq(apply_hysteresis(25, 60, 0, 58, 3), 25, "does not stop right below the start point");
assert_eq(apply_hysteresis(25, 60, 0, 57, 3), 0, "stops 3 C below");

assert_eq(safety(85, 30), 100);
assert_eq(safety(90, 0), 100);
assert_eq(safety(84, 30), 30);

// --- night window -----------------------------------------------------------
assert_eq(in_window('23:00', '07:00', 23 * 60 + 30), true, "crosses midnight, late");
assert_eq(in_window('23:00', '07:00', 23 * 60), true, "start inclusive");
assert_eq(in_window('23:00', '07:00', 0), true);
assert_eq(in_window('23:00', '07:00', 6 * 60 + 59), true);
assert_eq(in_window('23:00', '07:00', 7 * 60), false, "end exclusive");
assert_eq(in_window('23:00', '07:00', 12 * 60), false);
assert_eq(in_window('01:00', '06:00', 3 * 60), true, "same-day window");
assert_eq(in_window('01:00', '06:00', 7 * 60), false);
assert_eq(in_window('7:00', '9:00', 8 * 60), true, "single-digit hour");
assert_eq(in_window('10:00', '10:00', 600), false, "equal start/end never matches");
assert_eq(in_window('bad', '07:00', 100), false, "malformed");
assert_eq(in_window(null, '07:00', 100), false, "missing");
assert_eq(in_window('24:00', '07:00', 100), false, "hour out of range");

print("test_fancurve: ok\n");
