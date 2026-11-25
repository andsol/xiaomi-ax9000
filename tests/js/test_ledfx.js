#!/usr/bin/env node
// Unit tests for the LuCI helper module resources/ax9000/ledfx.js.
// Run on the host: node tests/js/test_ledfx.js
// frame() is checked against vectors produced by the ucode ledfx.uc original
// (tests/js/gen_ledfx_vectors.uc), so the virtual X matches the router.
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..', '..');
const SRC = path.join(ROOT, 'feed/luci-app-ax9000-controls/htdocs/luci-static/resources/ax9000/ledfx.js');

// Load the LuCI module with a minimal stand-in for `baseclass`: drop the
// 'use strict' / 'require' directives and run the body as a function.
function loadModule(file) {
	const body = fs.readFileSync(file, 'utf8')
		.replace(/^\s*'(use strict|require [^']+)';\s*$/mg, '');
	const baseclass = { extend: (o) => o };
	return new Function('baseclass', '"use strict";\n' + body)(baseclass);
}

const fx = loadModule(SRC);
let n = 0, failed = 0;

function test(name, fn) {
	n++;
	try { fn(); console.log('ok   ' + name); }
	catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + e.message); }
}

test('frame() matches the ucode vectors', () => {
	const vec = JSON.parse(fs.readFileSync(path.join(__dirname, 'ledfx_vectors.json'), 'utf8'));
	assert.ok(vec.length > 1000, 'vector file too small');
	const bad = [];
	for (const [e, c, t, s, want] of vec) {
		const got = fx.frame(e, c, t, s);
		if (got.join() != want.join())
			bad.push(`${e} ${c} t=${t} s=${s}: got ${got} want ${want}`);
	}
	assert.deepStrictEqual(bad, []);
});

test('clampSpeed', () => {
	assert.strictEqual(fx.clampSpeed(0.01), 0.1);
	assert.strictEqual(fx.clampSpeed(99), 10);
	assert.strictEqual(fx.clampSpeed(2), 2);
	assert.strictEqual(fx.clampSpeed('2'), 1);
	assert.strictEqual(fx.clampSpeed(NaN), 1);
});

test('hexToRgb', () => {
	assert.deepStrictEqual(fx.hexToRgb('#ff6A00'), [255, 106, 0]);
	assert.deepStrictEqual(fx.hexToRgb('0000ff'), [0, 0, 255]);
	assert.deepStrictEqual(fx.hexToRgb('blue'), [0, 0, 0]);
	assert.deepStrictEqual(fx.hexToRgb(null), [0, 0, 0]);
});

test('parseSpeed / parseBrightness fall back like the Preview button', () => {
	assert.strictEqual(fx.parseSpeed('0.5'), 0.5);
	assert.strictEqual(fx.parseSpeed(''), 1);
	assert.strictEqual(fx.parseSpeed('11'), 1);
	assert.strictEqual(fx.parseBrightness('0'), 0);
	assert.strictEqual(fx.parseBrightness('300'), 255);
	assert.strictEqual(fx.parseBrightness('x'), 255);
});

test('visual(): brightness scales level, 0 and off are dark', () => {
	let v = fx.visual('static', '#0000ff', 0, 1, '255');
	assert.deepStrictEqual(v.rgb, [0, 0, 255]);
	assert.strictEqual(v.level, 1);
	v = fx.visual('static', '#000080', 0, 1, '255');
	assert.deepStrictEqual(v.rgb, [0, 0, 255]);
	assert.ok(Math.abs(v.level - 128 / 255) < 1e-9);
	assert.ok(Math.abs(fx.visual('static', '#ffffff', 0, 1, '51').level - 0.2) < 1e-9);
	assert.strictEqual(fx.visual('static', '#ffffff', 0, 1, '0').level, 0);
	assert.strictEqual(fx.visual('off', '#ffffff', 0, 1, '255').level, 0);
	assert.strictEqual(fx.visual('flashing', '#ffffff', 600, 1, '255').level, 0);
	assert.strictEqual(fx.visual('breathing', '#ffffff', 0, 1, '255').level, 0);
	assert.strictEqual(fx.visual('breathing', '#ffffff', 2000, 1, '255').level, 1);
});

test('sameAsRunning()', () => {
	const st = { effect: 'static', color: '#0000ff', brightness: 255, events_active: [], night: false };
	const f = { effect: 'static', color: '#0000FF', speed: '3', brightness: '255' };
	assert.strictEqual(fx.sameAsRunning(f, st, '1'), true, 'static ignores speed, color case');
	assert.strictEqual(fx.sameAsRunning(Object.assign({}, f, { color: '#ff0000' }), st, '1'), false);
	assert.strictEqual(fx.sameAsRunning(Object.assign({}, f, { brightness: '100' }), st, '1'), false);
	assert.strictEqual(fx.sameAsRunning(Object.assign({}, f, { effect: 'breathing' }), st, '1'), false);

	const br = { effect: 'breathing', color: '#00ff00', brightness: 200 };
	const fb = { effect: 'breathing', color: '#00ff00', speed: '2', brightness: '200' };
	assert.strictEqual(fx.sameAsRunning(fb, br, '2'), true);
	assert.strictEqual(fx.sameAsRunning(fb, br, '1'), false, 'speed differs from saved');
	assert.strictEqual(fx.sameAsRunning(fb, Object.assign({ speed: 2 }, br), '1'), true, 'status speed wins');

	const cy = { effect: 'cycle', color: '#123456', brightness: 255 };
	assert.strictEqual(fx.sameAsRunning({ effect: 'cycle', color: '#ffffff', speed: '1', brightness: '255' }, cy, '1'), true,
		'cycle ignores color');

	const off = { effect: 'off', color: '#0000ff', brightness: 0 };
	assert.strictEqual(fx.sameAsRunning({ effect: 'off', color: '#0000ff', speed: '1', brightness: '255' }, off, '1'), true);
	assert.strictEqual(fx.sameAsRunning({ effect: 'static', color: '#0000ff', speed: '1', brightness: '0' }, off, '1'), true);
	assert.strictEqual(fx.sameAsRunning(f, off, '1'), false);

	assert.strictEqual(fx.sameAsRunning(f, null, '1'), false);
	assert.strictEqual(fx.sameAsRunning(f, { error: 'not_running', effect: null }, '1'), false);
});

console.log(`\n${n - failed}/${n} passed`);
process.exit(failed ? 1 : 0);
