'use strict';
'require baseclass';

/* Browser port of the X-light effect maths in
 * /usr/share/ax9000/ledfx.uc (frame(), hsl_to_rgb(), clamp_speed()), so the
 * LED page can show what the router will show. Keep the two in sync:
 * tests/js/test_ledfx.js checks this port against vectors produced by the
 * ucode original. No DOM access here. */

var PRIMARIES = [ [ 255, 0, 0 ], [ 0, 255, 0 ], [ 0, 0, 255 ] ];
var EFFECTS = [ 'static', 'breathing', 'flashing', 'cycle', 'rainbow', 'off' ];
var HEX_RE = /^#?([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/;

/* ucode int() truncates toward zero */
function int(v) { return Math.trunc(v); }

function isNum(v) { return typeof v == 'number' && isFinite(v); }

function clampByte(v) {
	var n = int(v + 0.5);
	return n < 0 ? 0 : (n > 255 ? 255 : n);
}

function clampSpeed(speed) {
	if (!isNum(speed))
		return 1;
	return speed < 0.1 ? 0.1 : (speed > 10 ? 10 : speed);
}

function hexToRgb(str) {
	var m = HEX_RE.exec(String(str == null ? '' : str));
	if (!m)
		return [ 0, 0, 0 ];
	return [ parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16) ];
}

function hslToRgb(h, s, l) {
	h = h - 360 * int(h / 360);
	if (h < 0)
		h += 360;
	s = s / 100;
	l = l / 100;
	var c = (1 - Math.abs(2 * l - 1)) * s,
	    hp = h / 60,
	    x = c * (1 - Math.abs(hp - 2 * int(hp / 2) - 1)),
	    m = l - c / 2, rgb;
	if (hp < 1) rgb = [ c, x, 0 ];
	else if (hp < 2) rgb = [ x, c, 0 ];
	else if (hp < 3) rgb = [ 0, c, x ];
	else if (hp < 4) rgb = [ 0, x, c ];
	else if (hp < 5) rgb = [ x, 0, c ];
	else rgb = [ c, 0, x ];
	return rgb.map(function(v) { return clampByte((v + m) * 255); });
}

/* color: [r,g,b] 0-255, tMs: elapsed ms, speed: multiplier (clamped 0.1..10).
 * Returns three ints in 0..255, exactly like ledfx.uc frame(). */
function frame(effect, color, tMs, speed) {
	speed = clampSpeed(speed);
	var t = isNum(tMs) && tMs > 0 ? tMs : 0,
	    c = (color || [ 0, 0, 0 ]).map(clampByte), p, ph;

	switch (effect) {
	case 'static':
		return c;
	case 'breathing':
		p = 4000 / speed;
		ph = (t - p * int(t / p)) / p;
		var k = 0.5 - 0.5 * Math.cos(2 * Math.PI * ph);
		return c.map(function(v) { return clampByte(v * k); });
	case 'flashing':
		p = 1000 / speed;
		ph = t - p * int(t / p);
		return ph < p / 2 ? c : [ 0, 0, 0 ];
	case 'cycle':
		p = 2000 / speed;
		var pos = t / p, n = int(pos), f = pos - n,
		    a = PRIMARIES[n % 3], b = PRIMARIES[(n + 1) % 3];
		return [ 0, 1, 2 ].map(function(i) { return clampByte(a[i] + (b[i] - a[i]) * f); });
	case 'rainbow':
		return hslToRgb(t * 0.036 * speed, 100, 50);
	}
	return [ 0, 0, 0 ];
}

/* Form value parsing, same fallbacks as the Preview button. */
function parseSpeed(v) {
	var n = parseFloat(v);
	return (n >= 0.1 && n <= 10) ? n : 1;
}

function parseBrightness(v) {
	var n = parseInt(v, 10);
	return (n >= 0 && n <= 255) ? n : 255;
}

/* Visual state for one frame of the virtual X: `rgb` is the hue at full
 * level, `level` (0..1) combines the frame intensity and the brightness. */
function visual(effect, hex, tMs, speed, brightness) {
	var rgb = frame(effect, hexToRgb(hex), tMs, speed),
	    max = Math.max(rgb[0], rgb[1], rgb[2]),
	    b = parseBrightness(brightness);

	if (!max || !b)
		return { rgb: [ 0, 0, 0 ], level: 0 };
	return {
		rgb: rgb.map(function(v) { return Math.round(v * 255 / max); }),
		level: (max / 255) * (b / 255)
	};
}

/* Does the form (`f`: effect, color, speed, brightness) match what the light
 * runs now? `st` is the ax9000.led status (it carries no speed: `savedSpeed`,
 * the stored UCI speed, stands in for it unless st.speed is present). */
function sameAsRunning(f, st, savedSpeed) {
	if (!st || st.error || !st.effect)
		return false;

	var fb = parseBrightness(f.brightness),
	    sb = parseInt(st.brightness, 10) || 0,
	    fOff = f.effect == 'off' || fb == 0,
	    sOff = st.effect == 'off' || sb == 0;

	if (fOff || sOff)
		return fOff && sOff;
	if (f.effect != st.effect || fb != sb)
		return false;
	if ([ 'static', 'breathing', 'flashing' ].indexOf(f.effect) >= 0 &&
	    String(f.color || '').toLowerCase() != String(st.color || '').toLowerCase())
		return false;
	if (f.effect != 'static') {
		var ss = parseSpeed(st.speed != null ? st.speed : savedSpeed);
		if (Math.abs(parseSpeed(f.speed) - ss) > 1e-9)
			return false;
	}
	return true;
}

return baseclass.extend({
	id: 'ax9000.ledfx',
	EFFECTS: EFFECTS,
	clampSpeed: clampSpeed,
	hexToRgb: hexToRgb,
	hslToRgb: hslToRgb,
	frame: frame,
	parseSpeed: parseSpeed,
	parseBrightness: parseBrightness,
	visual: visual,
	sameAsRunning: sameAsRunning
});
