import { assert_eq, assert_near } from './assert.uc';
import { hex_to_rgb, hsl_to_rgb, EFFECTS, frame, is_animated, resolve, in_window } from 'ledfx';

function check(cond, msg) {
	assert_eq(!!cond, true, msg);
}

// colors
assert_eq(hex_to_rgb("#0080ff"), [0, 128, 255]);
assert_eq(hsl_to_rgb(0, 100, 50), [255, 0, 0]);
assert_eq(hsl_to_rgb(120, 100, 50), [0, 255, 0]);
assert_eq(hsl_to_rgb(240, 100, 50), [0, 0, 255]);
assert_eq(EFFECTS, ["static", "breathing", "flashing", "cycle", "rainbow", "off"]);

// frames
assert_eq(frame("static", [1, 2, 3], 5, 1), [1, 2, 3]);
assert_eq(frame("off", [1, 2, 3], 5, 1), [0, 0, 0]);
assert_eq(frame("breathing", [0, 0, 255], 0, 1), [0, 0, 0]);
assert_eq(frame("breathing", [0, 0, 255], 2000, 1), [0, 0, 255]);
assert_eq(frame("breathing", [0, 0, 255], 1000, 2), [0, 0, 255]);
assert_eq(frame("flashing", [255, 0, 0], 250, 1), [255, 0, 0]);
assert_eq(frame("flashing", [255, 0, 0], 750, 1), [0, 0, 0]);
assert_eq(frame("flashing", [255, 0, 0], 1250, 1), [255, 0, 0]);
assert_eq(frame("cycle", [0, 0, 0], 0, 1), [255, 0, 0]);
assert_eq(frame("cycle", [0, 0, 0], 1000, 1), [128, 128, 0]);
assert_eq(frame("cycle", [0, 0, 0], 2000, 1), [0, 255, 0]);
assert_eq(frame("cycle", [0, 0, 0], 6000, 1), [255, 0, 0]);
assert_eq(frame("rainbow", [0, 0, 0], 0, 1), [255, 0, 0]);
assert_eq(frame("rainbow", [0, 0, 0], 3333, 1), hsl_to_rgb(3333 * 0.036, 100, 50));
assert_eq(is_animated("static"), false);
assert_eq(is_animated("off"), false);
assert_eq(is_animated("breathing"), true);
assert_eq(is_animated("rainbow"), true);

// speed extremes: all effects, ints in 0..255, no crash
for (let e in EFFECTS)
	for (let s in [0, -5, 0.1, 10, 50])
		for (let t in [0, 1, 999999, 123456789]) {
			let f = frame(e, [10, 200, 255], t, s);
			assert_eq(length(f), 3);
			for (let c in f) {
				assert_eq(type(c), "int");
				check(c >= 0 && c <= 255, "frame value in range");
			}
		}
// speed 0 is clamped to 0.1: flashing period 10 s, on for the first 5 s
assert_eq(frame("flashing", [255, 0, 0], 4000, 0), [255, 0, 0]);
assert_eq(frame("flashing", [255, 0, 0], 6000, 0), [0, 0, 0]);

// resolve
let ev = [{ name: "offline", priority: 50, effect: "flashing", color: "#ff0000", speed: 1 },
          { name: "wps", priority: 80, effect: "breathing", color: "#00ff00", speed: 2 }];
let base = { effect: "static", color: "#0000ff", speed: 1 };
assert_eq(resolve({ offline: true, wps: true }, ev, base, false, "off").effect, "breathing");
assert_eq(resolve({ offline: true }, ev, base, false, "off").effect, "flashing");
assert_eq(resolve({ offline: true, wps: false }, ev, base, false, "off").effect, "flashing");
assert_eq(resolve({}, ev, base, false, "off").effect, "static");
assert_eq(resolve({}, ev, base, false, "off"), { effect: "static", color: [0, 0, 255], speed: 1, brightness_scale: 1 });
assert_eq(resolve({ wps: true }, ev, base, false, "off").color, [0, 255, 0]);
assert_eq(resolve({}, ev, base, true, "off").effect, "off");
assert_eq(resolve({}, ev, base, true, "dim").brightness_scale, 0.2);
assert_eq(resolve({}, ev, base, true, "dim").effect, "static");
assert_eq(resolve({}, ev, base, false, "dim").brightness_scale, 1);

// night off: an active event is also silenced unless override_night
assert_eq(resolve({ wps: true }, ev, base, true, "off").effect, "off");
let ev2 = [{ name: "wps", priority: 80, effect: "breathing", color: "#00ff00", speed: 2, override_night: true },
           { name: "offline", priority: 50, effect: "flashing", color: "#ff0000", speed: 1 }];
let r = resolve({ wps: true }, ev2, base, true, "off");
assert_eq(r.effect, "breathing");
assert_eq(r.brightness_scale, 1);
assert_eq(resolve({ wps: true }, ev2, base, true, "dim").brightness_scale, 1);
// override_night on a lower-priority event does not rescue a higher non-override one
let ev3 = [{ name: "a", priority: 90, effect: "flashing", color: "#ffffff", speed: 1 },
           { name: "b", priority: 10, effect: "flashing", color: "#ffffff", speed: 1, override_night: true }];
assert_eq(resolve({ a: true, b: true }, ev3, base, true, "off").effect, "off");
// daytime: event untouched
assert_eq(resolve({ wps: true }, ev2, base, false, "off").effect, "breathing");

// equal priorities: first in configuration order wins (deterministic)
let eq = [{ name: "x", priority: 5, effect: "flashing", color: "#111111", speed: 1 },
          { name: "y", priority: 5, effect: "breathing", color: "#222222", speed: 1 }];
assert_eq(resolve({ x: true, y: true }, eq, base, false, "off").effect, "flashing");
assert_eq(resolve({ y: true, x: true }, eq, base, false, "off").effect, "flashing");

// in_window
assert_eq(in_window("23:00", "07:00", 60), true);
assert_eq(in_window("23:00", "07:00", 23 * 60), true);
assert_eq(in_window("23:00", "07:00", 7 * 60), false);
assert_eq(in_window("23:00", "07:00", 12 * 60), false);
assert_eq(in_window("08:00", "18:00", 12 * 60), true);
assert_eq(in_window("08:00", "18:00", 18 * 60), false);
assert_eq(in_window("08:00", "08:00", 480), false);
assert_eq(in_window("bad", "08:00", 480), false);

print("test_ledfx: ok\n");
