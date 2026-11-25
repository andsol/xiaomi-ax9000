'use strict';
'require view';
'require rpc';
'require uci';
'require poll';
'require ui';
'require ax9000.ledfx as ledfx';

/*
 * LED page: the X light (effect, color, speed, brightness), its night mode,
 * event signals, and the small status LEDs. Everything is staged in UCI and
 * applied with the standard LuCI Save / Save & Apply buttons:
 *   - /etc/config/ax9000 (sections 'led' and 'led_event') -> ax9000-ledd reloads
 *   - /etc/config/system `config led` sections -> the ax9000-ledd init script
 *     restarts the stock led service on that config change.
 */

var callStatus = rpc.declare({ object: 'ax9000.led', method: 'status', expect: { '': {} } });
var callPreview = rpc.declare({
	object: 'ax9000.led', method: 'preview',
	params: [ 'effect', 'color', 'speed', 'brightness', 'seconds' ], expect: { '': {} }
});
var callOff = rpc.declare({ object: 'ax9000.led', method: 'off_until_reboot', params: [ 'off' ], expect: { '': {} } });
var callLeds = rpc.declare({ object: 'luci', method: 'getLEDs', expect: { '': {} } });

var HEX_RE = /^#[0-9a-fA-F]{6}$/;
var TIME_RE = /^([01]?[0-9]|2[0-3]):[0-5][0-9]$/;
var SPEED_MIN = 0.1, SPEED_MAX = 10;
var PREVIEW_SECONDS = 10;
var RECENT_KEY = 'ax9000-led-recent';
/* Front indicators: each a blue (looks white) and a yellow GPIO LED.
 * Network activity uses the kernel netdev trigger on one port. */
var INDICATORS = {
	top: { white: 'blue:wan', yellow: 'yellow:wan' },
	bottom: { white: 'blue:status', yellow: 'yellow:status' }
};
var PORTS = [ 'wan', 'lan1', 'lan2', 'lan3', 'lan4' ];

function effects() {
	return [
		[ 'static', _('Static') ],
		[ 'breathing', _('Breathing') ],
		[ 'flashing', _('Flashing') ],
		[ 'cycle', _('Color cycle') ],
		[ 'rainbow', _('Rainbow') ],
		[ 'off', _('Off') ]
	];
}

function effectLabel(name) {
	var hit = effects().filter(function(e) { return e[0] == name; })[0];
	return hit ? hit[1] : name;
}

function usesColor(effect) { return [ 'static', 'breathing', 'flashing' ].indexOf(effect) >= 0; }
function usesSpeed(effect) { return [ 'breathing', 'flashing', 'cycle', 'rainbow' ].indexOf(effect) >= 0; }

function eventInfo(name) {
	return ({
		offline: [ _('No internet'), _('The watched interface has no connection') ],
		wps: [ _('WPS pairing'), _('After the WPS button is pressed') ],
		upgrade: [ _('Firmware upgrade'), _('While a sysupgrade runs') ]
	})[name] || [ name, '' ];
}

function indicatorLabel(id) {
	return id == 'top' ? _('Top') : _('Bottom');
}

function indicatorHint(id) {
	return id == 'top' ? _('Internet') : _('System');
}

function indicatorActions() {
	return [
		[ 'off', _('Off') ],
		[ 'on', _('On') ],
		[ 'heartbeat', _('Heartbeat') ],
		[ 'blink', _('Blink') ],
		[ 'netdev', _('Network activity') ]
	];
}

function portChoices() {
	return [
		[ 'wan', _('WAN') ], [ 'lan1', _('LAN 1') ], [ 'lan2', _('LAN 2') ],
		[ 'lan3', _('LAN 3') ], [ 'lan4', _('LAN 4') ]
	];
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function padTime(v) {
	var m = /^([0-9]{1,2}):([0-9]{2})$/.exec(String(v || '').trim());
	return m ? (m[1].length < 2 ? '0' : '') + m[1] + ':' + m[2] : String(v || '');
}

/* ---- colour maths: hue/saturation at full value; brightness is separate ---- */

function hsToHex(h, s) {
	s /= 100;
	var f = function(n) {
		var k = (n + h / 60) % 6;
		return Math.round(255 * (1 - s * Math.max(0, Math.min(k, 4 - k, 1))));
	};
	return '#' + [ f(5), f(3), f(1) ].map(function(v) { return ('0' + v.toString(16)).slice(-2); }).join('');
}

function hexToHs(hex) {
	var r = parseInt(hex.substr(1, 2), 16) / 255, g = parseInt(hex.substr(3, 2), 16) / 255,
	    b = parseInt(hex.substr(5, 2), 16) / 255, mx = Math.max(r, g, b), mn = Math.min(r, g, b),
	    d = mx - mn, h = 0;
	if (d) {
		if (mx == r) h = ((g - b) / d + 6) % 6;
		else if (mx == g) h = (b - r) / d + 2;
		else h = (r - g) / d + 4;
		h *= 60;
	}
	return [ Math.round(h), mx ? Math.round(d / mx * 100) : 0 ];
}

function readRecent() {
	try {
		var v = JSON.parse(window.localStorage.getItem(RECENT_KEY) || '[]');
		return Array.isArray(v) ? v.filter(function(c) { return HEX_RE.test(c); }).slice(0, 6) : [];
	}
	catch (e) { return []; }
}

function pushRecent(hex) {
	try {
		var v = readRecent().filter(function(c) { return c != hex; });
		v.unshift(hex);
		window.localStorage.setItem(RECENT_KEY, JSON.stringify(v.slice(0, 6)));
	}
	catch (e) {}
}

/* speed slider: logarithmic 0.1x .. 10x over 0..1000 */
function speedToPos(v) { return Math.round(Math.log(clamp(v, SPEED_MIN, SPEED_MAX) / SPEED_MIN) / Math.log(SPEED_MAX / SPEED_MIN) * 1000); }
function posToSpeed(p) { return +(SPEED_MIN * Math.pow(SPEED_MAX / SPEED_MIN, p / 1000)).toPrecision(2); }

/* ---- styles: theme neutral (currentColor and translucent greys) ---- */

var CSS = [
	'.axl{--axl-accent:#2f7bf6;--axl-line:rgba(128,128,128,.3);--axl-card:rgba(128,128,128,.07);--axl-well:rgba(128,128,128,.1);--axl-bad:#d64545}',
	'.axl *{box-sizing:border-box}',
	'.axl [hidden]{display:none !important}',
	'.axl-stack{display:grid;gap:1rem}',
	'.axl-grid2{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:1rem;align-items:start}',
	'@media (max-width:900px){.axl-grid2{grid-template-columns:1fr}}',
	'.axl-card{border:1px solid var(--axl-line);background:var(--axl-card);border-radius:.5rem;padding:1rem 1.1rem;display:grid;gap:.9rem;min-width:0}',
	'.axl-head{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:.5rem 1rem}',
	'.axl-head h3{margin:0;font-size:1.05rem;padding:0;border:0}',
	'.axl-head p{margin:.15rem 0 0;font-size:.85rem;opacity:.7}',
	'.axl-field{display:grid;grid-template-columns:8rem minmax(0,1fr);align-items:center;gap:.5rem 1rem}',
	'.axl-field>.l{opacity:.75}',
	'.axl-field.top{align-items:start}.axl-field.top>.l{padding-top:.3rem}',
	'@media (max-width:560px){.axl-field{grid-template-columns:1fr}}',
	'.axl-help{font-size:.85rem;opacity:.7;margin:0}',
	'.axl-row{display:flex;flex-wrap:wrap;align-items:center;gap:.5rem}',
	'.axl-row input,.axl-row button,.axl-row select{margin:0}',
	'.axl-seg{justify-self:start;display:inline-flex;flex-wrap:wrap;border:1px solid var(--axl-line);border-radius:.4rem;overflow:hidden}',
	'.axl-seg button{margin:0;border:0;border-right:1px solid var(--axl-line);border-radius:0;background:transparent;color:inherit;padding:.4rem .8rem;cursor:pointer;font:inherit;line-height:1.3}',
	'.axl-seg button:last-child{border-right:0}',
	'.axl-seg button[aria-pressed=true]{background:var(--axl-accent);color:#fff}',
	'.axl-seg button:focus-visible{outline:2px solid var(--axl-accent);outline-offset:-2px}',
	'.axl-chip{display:inline-flex;align-items:center;gap:.4rem;border-radius:1rem;padding:.15rem .7rem;font-size:.85rem;background:var(--axl-well)}',
	'.axl-chip.err{background:rgba(214,69,69,.2)}',
	'.axl-dot{width:.65rem;height:.65rem;border-radius:50%;flex:none;border:1px solid rgba(128,128,128,.5)}',
	'.axl-switch{display:inline-flex;align-items:center;gap:.5rem;cursor:pointer;margin:0}',
	'.axl-switch input{position:absolute;opacity:0;width:1px;height:1px}',
	'.axl-switch .tr{position:relative;flex:none;width:2.6rem;height:1.45rem;border-radius:1rem;background:var(--axl-line);transition:background .15s}',
	'.axl-switch .tr::after{content:"";position:absolute;top:.17rem;left:.17rem;width:1.1rem;height:1.1rem;border-radius:50%;background:#fff;transition:transform .15s}',
	'.axl-switch input:checked+.tr{background:var(--axl-accent)}',
	'.axl-switch input:checked+.tr::after{transform:translateX(1.15rem)}',
	'.axl-switch input:focus-visible+.tr{outline:2px solid var(--axl-accent);outline-offset:2px}',
	'.axl-slider{display:flex;align-items:center;gap:1rem;max-width:30rem}',
	'.axl-slider input[type=range]{flex:1;min-width:0}',
	'.axl-slider output{min-width:3.5rem;text-align:right;font-weight:600;font-variant-numeric:tabular-nums}',
	/* X light: preview on the left, controls on the right */
	'.axl-xl{display:grid;grid-template-columns:13rem minmax(0,1fr);gap:1.5rem;align-items:start}',
	'@media (max-width:720px){.axl-xl{grid-template-columns:1fr}.axl-vx{max-width:13rem;margin:0 auto}}',
	'.axl-vx{display:grid;gap:.6rem;justify-items:center}',
	'.axl-vx svg{display:block;width:100%;height:auto;aspect-ratio:1;border-radius:14%;box-shadow:0 0 0 1px var(--axl-line),0 4px 14px rgba(0,0,0,.25)}',
	'.axl-vx .cap{font-size:.8rem;opacity:.7;text-align:center}',
	'.axl-vx .cbi-button{margin:0}',
	/* colour picker */
	'.axl-picker{display:grid;grid-template-columns:auto minmax(0,1fr);gap:1rem;align-items:start}',
	'@media (max-width:520px){.axl-picker{grid-template-columns:1fr}}',
	'.axl-wheel{width:10.5rem;height:10.5rem;border-radius:50%;position:relative;cursor:crosshair;touch-action:none;box-shadow:0 0 0 1px var(--axl-line);',
	'  background:radial-gradient(circle closest-side,#fff 0%,rgba(255,255,255,0) 100%),conic-gradient(from 90deg,#f00,#f0f,#00f,#0ff,#0f0,#ff0,#f00)}',
	'.axl-wheel:focus-visible{outline:2px solid var(--axl-accent);outline-offset:3px}',
	'.axl-knob{position:absolute;width:1.25rem;height:1.25rem;margin:-.625rem 0 0 -.625rem;border-radius:50%;border:3px solid #fff;box-shadow:0 0 0 1px rgba(0,0,0,.6),0 2px 6px rgba(0,0,0,.5);pointer-events:none}',
	'.axl-pside{display:grid;gap:.75rem;align-content:start;min-width:0}',
	'.axl-hex{display:flex;align-items:center;gap:.5rem}',
	'.axl-hex .big{width:2.4rem;height:2rem;border-radius:.35rem;border:1px solid var(--axl-line);flex:none}',
	'.axl-hex input{width:7rem !important;margin:0;font-family:monospace}',
	'.axl-sws{display:grid;grid-template-columns:repeat(auto-fill,1.9rem);gap:.5rem}',
	'.axl-sw{width:1.9rem;height:1.9rem;border-radius:.4rem;border:1px solid rgba(0,0,0,.35);cursor:pointer;padding:0;margin:0;position:relative}',
	'.axl-sw[aria-pressed=true]::after{content:"";position:absolute;inset:-.25rem;border:2px solid currentColor;border-radius:.55rem}',
	'.axl-sw:focus-visible{outline:2px solid var(--axl-accent);outline-offset:2px}',
	'.axl-recent{display:flex;flex-wrap:wrap;align-items:center;gap:.4rem;font-size:.8rem;opacity:.85}',
	'.axl-recent .axl-sw{width:1.4rem;height:1.4rem;border-radius:.3rem}',
	/* events */
	'.axl-evts{display:grid;grid-template-columns:auto minmax(9rem,1.3fr) minmax(8rem,1fr) auto minmax(6.5rem,.8fr) 5.5rem;gap:0 .9rem;align-items:center}',
	'.axl-evt{display:contents}',
	'.axl-evt>*{padding:.6rem 0;border-top:1px solid var(--axl-line);align-self:stretch;display:flex;align-items:center;min-width:0}',
	'.axl-evt.head>*{border-top:0;padding-top:0;font-size:.8rem;opacity:.7}',
	'.axl-evt .nm{flex-direction:column;align-items:flex-start;justify-content:center;gap:.1rem}',
	'.axl-evt .nm small{opacity:.7}',
	'.axl-evt .nm label{display:flex;align-items:center;gap:.35rem;font-size:.8rem;margin:0;opacity:.85}',
	'.axl-evt .nm label input{margin:0}',
	'.axl-evt select,.axl-evt input[type=number]{width:100%;margin:0;min-width:0}',
	'.axl-cbtn{width:2.4rem;height:1.9rem;border-radius:.35rem;border:1px solid var(--axl-line);cursor:pointer;padding:0;margin:0}',
	'.axl-cbtn[disabled]{opacity:.3;cursor:not-allowed}',
	'@media (max-width:820px){.axl-evts{grid-template-columns:auto minmax(0,1fr) minmax(0,1fr)}.axl-evt.head{display:none}',
	'  .axl-evt>*{border-top:0;padding:.3rem 0}.axl-evt>.sw{border-top:1px solid var(--axl-line);padding-top:.6rem}.axl-evt>.nm{grid-column:2 / 4;border-top:1px solid var(--axl-line);padding-top:.6rem}',
	'  .axl-evt>.ef,.axl-evt>.sp{grid-column:2 / 4}.axl-evt>.co,.axl-evt>.pr{grid-column:auto}}',
	/* front indicators: lamp | name | colour | action | port */
	'.axl-inds{display:grid;grid-template-columns:1.65rem minmax(4.5rem,1fr) auto minmax(8rem,10rem) minmax(6.5rem,8rem);gap:0;align-items:center}',
	'.axl-ind{display:contents}',
	'.axl-ind>*{padding:.6rem .75rem .6rem 0;border-top:1px solid var(--axl-line);align-self:stretch;display:flex;align-items:center;min-width:0}',
	'.axl-ind>*:last-child{padding-right:0}',
	'.axl-ind:first-child>*{border-top:0}',
	'.axl-ind .nm{flex-direction:column;align-items:flex-start;justify-content:center}',
	'.axl-ind .nm small{opacity:.7}',
	'.axl-ind .lamp{width:.85rem;height:.85rem;border-radius:50%;box-shadow:0 0 0 1px rgba(128,128,128,.5);transition:opacity .15s}',
	'.axl-ind select{width:100%;margin:0;min-width:0}',
	'.axl-ind .port.off>*{visibility:hidden}',
	'@media (max-width:1100px){.axl-inds{grid-template-columns:1.65rem minmax(0,1fr) minmax(0,1fr)}',
	'  .axl-ind>*{border-top:0;padding-top:.3rem;padding-bottom:.3rem}.axl-ind>:first-child,.axl-ind>.nm{border-top:1px solid var(--axl-line);padding-top:.7rem}',
	'  .axl-ind>.nm{grid-column:2 / 4}.axl-ind>:nth-child(3){grid-column:2 / 4}.axl-ind>:nth-child(4){grid-column:2}.axl-ind .port.off{visibility:hidden}}',
	'@media (prefers-reduced-motion:reduce){.axl *{transition:none !important}}'
].join('\n');

/* ---- virtual X: renders the unsaved values with the router's maths ---- */

var SVG_NS = 'http://www.w3.org/2000/svg', vxSeq = 0;

function S(tag, attrs, kids) {
	var n = document.createElementNS(SVG_NS, tag);
	Object.keys(attrs || {}).forEach(function(k) { n.setAttribute(k, attrs[k]); });
	(kids || []).forEach(function(c) { n.appendChild(c); });
	return n;
}

/* Two diagonal strokes, each split in two bars with a gap at the centre. */
var VX_BARS = [ [ 50, 50, 89, 89 ], [ 111, 111, 150, 150 ], [ 150, 50, 111, 89 ], [ 89, 111, 50, 150 ] ];

function vxBars(attrs) {
	return S('g', attrs, VX_BARS.map(function(b) {
		return S('line', { 'x1': b[0], 'y1': b[1], 'x2': b[2], 'y2': b[3] });
	}));
}

/* read() returns { effect, color, speed, brightness } (brightness 0..255).
 * The loop stops by itself once the widget leaves the document. */
function virtualX(read) {
	var fid = 'axl-vx-glow-' + (++vxSeq),
	    glow = vxBars({ 'stroke-width': 14, 'stroke-linecap': 'round', 'filter': 'url(#' + fid + ')', 'opacity': 0 }),
	    core = vxBars({ 'stroke-width': 5, 'stroke-linecap': 'round', 'opacity': 0 }),
	    svg = S('svg', { 'viewBox': '0 0 200 200', 'role': 'img', 'aria-label': _('Preview of the X light') }, [
	        S('defs', {}, [
	            S('filter', { 'id': fid, 'filterUnits': 'userSpaceOnUse', 'x': 0, 'y': 0, 'width': 200, 'height': 200 }, [
	                S('feGaussianBlur', { 'in': 'SourceGraphic', 'stdDeviation': 7, 'result': 'halo' }),
	                S('feMerge', {}, [
	                    S('feMergeNode', { 'in': 'halo' }),
	                    S('feMergeNode', { 'in': 'halo' }),
	                    S('feMergeNode', { 'in': 'SourceGraphic' })
	                ])
	            ])
	        ]),
	        S('rect', { 'x': 0, 'y': 0, 'width': 200, 'height': 200, 'rx': 28, 'fill': '#121418' }),
	        vxBars({ 'stroke': '#2c3038', 'stroke-width': 14, 'stroke-linecap': 'round' }),
	        glow, core
	    ]),
	    vals = {}, t0 = null, attached = false, born = Date.now(), lastKey = null;

	function tick(now) {
		if (svg.isConnected)
			attached = true;
		else if (attached || Date.now() - born > 30000)
			return;	/* view left or re-rendered (or never shown): stop, no leak */

		window.requestAnimationFrame(tick);
		if (!attached || document.hidden)
			return;

		var v = read();
		if (t0 == null || v.effect != vals.effect || v.speed != vals.speed)
			t0 = now;	/* restart the effect like a preview does */
		vals = v;

		var f = ledfx.visual(v.effect, v.color, now - t0, v.speed, v.brightness),
		    col = 'rgb(' + f.rgb.join(',') + ')',
		    hot = 'rgb(' + f.rgb.map(function(c) { return Math.round(c + (255 - c) * 0.55); }).join(',') + ')',
		    key = col + '/' + f.level.toFixed(3);

		if (key == lastKey)
			return;
		lastKey = key;
		glow.setAttribute('stroke', col);
		glow.setAttribute('opacity', f.level.toFixed(3));
		core.setAttribute('stroke', hot);
		core.setAttribute('opacity', (f.level * 0.9).toFixed(3));
	}

	window.requestAnimationFrame(tick);
	return svg;
}

/* ---- colour picker: hue/saturation wheel, swatches, hex, recent ---- */

function colorPicker(start, onchange) {
	var hs = hexToHs(start), cur = start;
	var knob = E('div', { 'class': 'axl-knob' });
	var wheel = E('div', { 'class': 'axl-wheel', 'tabindex': '0', 'role': 'slider',
		'aria-label': _('Hue and saturation: arrow keys change the hue (left/right) and saturation (up/down)') }, knob);
	var big = E('span', { 'class': 'big' });
	var hex = E('input', { 'class': 'cbi-input-text', 'type': 'text', 'spellcheck': 'false', 'maxlength': '7',
		'aria-label': _('Color as #rrggbb') });
	var swatches = [];
	var presets = [
		[ '#ff0000', _('Red') ], [ '#ff5a00', _('Orange') ], [ '#ffa000', _('Amber') ],
		[ '#ffff00', _('Yellow') ], [ '#00ff00', _('Green') ], [ '#00ffff', _('Cyan') ],
		[ '#0000ff', _('Blue') ], [ '#8000ff', _('Purple') ], [ '#ff00ff', _('Magenta') ],
		[ '#ffffff', _('White') ]
	];

	var mkSw = function(c, label) {
		var b = E('button', { 'type': 'button', 'class': 'axl-sw', 'style': 'background:' + c,
			'title': label, 'aria-label': label, 'data-c': c, 'aria-pressed': 'false',
			'click': function(ev) { ev.preventDefault(); set(c, true); } });
		swatches.push(b);
		return b;
	};

	var swRow = E('div', { 'class': 'axl-sws' }, presets.map(function(p) { return mkSw(p[0], p[1]); }));
	var recent = readRecent();
	var recentRow = recent.length
		? E('div', { 'class': 'axl-recent' }, [ _('Recent') ].concat(recent.map(function(c) { return mkSw(c, c); })))
		: '';

	function paint() {
		var a = hs[0] * Math.PI / 180, r = hs[1] / 100 * 50;
		knob.style.left = (50 + Math.cos(-a) * r) + '%';
		knob.style.top = (50 + Math.sin(-a) * r) + '%';
		knob.style.background = cur;
		big.style.background = cur;
		if (document.activeElement !== hex)
			hex.value = cur;
		hex.classList.remove('cbi-input-invalid');
		swatches.forEach(function(b) { b.setAttribute('aria-pressed', String(b.getAttribute('data-c') == cur)); });
		wheel.setAttribute('aria-valuetext', cur);
	}

	function set(c, fire) {
		cur = c.toLowerCase();
		var n = hexToHs(cur);
		if (n[1] == 0)
			n[0] = hs[0];	/* hue undefined for white: keep the knob's angle */
		hs = n;
		paint();
		if (fire) onchange(cur);
	}

	function fromHs(fire) {
		cur = hsToHex(hs[0], hs[1]);
		paint();
		if (fire) onchange(cur);
	}

	function pick(ev) {
		var r = wheel.getBoundingClientRect(),
		    x = ev.clientX - r.left - r.width / 2, y = ev.clientY - r.top - r.height / 2;
		hs = [ Math.round((Math.atan2(-y, x) * 180 / Math.PI + 360) % 360),
		       Math.round(Math.min(1, Math.hypot(x, y) / (r.width / 2)) * 100) ];
		fromHs(true);
	}

	wheel.addEventListener('pointerdown', function(ev) { ev.preventDefault(); wheel.focus(); wheel.setPointerCapture(ev.pointerId); pick(ev); });
	wheel.addEventListener('pointermove', function(ev) { if (ev.buttons) pick(ev); });
	wheel.addEventListener('keydown', function(ev) {
		switch (ev.key) {
		case 'ArrowLeft':  hs[0] = (hs[0] + 355) % 360; break;
		case 'ArrowRight': hs[0] = (hs[0] + 5) % 360; break;
		case 'ArrowUp':    hs[1] = Math.min(100, hs[1] + 5); break;
		case 'ArrowDown':  hs[1] = Math.max(0, hs[1] - 5); break;
		default: return;
		}
		ev.preventDefault();
		fromHs(true);
	});
	hex.addEventListener('input', function() {
		var v = hex.value.trim();
		if (/^[0-9a-fA-F]{6}$/.test(v)) v = '#' + v;
		if (HEX_RE.test(v)) set(v, true);
		else hex.classList.add('cbi-input-invalid');
	});
	hex.addEventListener('blur', function() { hex.value = cur; hex.classList.remove('cbi-input-invalid'); });

	var node = E('div', { 'class': 'axl-picker' }, [
		wheel,
		E('div', { 'class': 'axl-pside' }, [
			E('div', { 'class': 'axl-hex' }, [ big, hex ]),
			swRow,
			recentRow,
			E('p', { 'class': 'axl-help' }, _('Around the wheel picks the hue; towards the center makes it paler.'))
		])
	]);

	set(HEX_RE.test(start) ? start : '#0000ff', false);
	node.getValue = function() { return cur; };
	return node;
}

return view.extend({
	load: function() {
		return Promise.all([
			uci.load('ax9000'),
			uci.load('system'),
			L.resolveDefault(uci.load('network'), null),
			L.resolveDefault(callStatus(), null),
			L.resolveDefault(callLeds(), {})
		]);
	},

	render: function(data) {
		var self = this;

		this.status = data[3];
		this.leds = data[4] || {};
		this.readConfig();
		this.root = E('div', { 'class': 'axl' });
		this.build();

		poll.add(function() {
			return L.resolveDefault(callStatus(), null).then(function(st) {
				self.status = st;
				self.updateStatus();
			});
		}, 3);

		return this.root;
	},

	/* ---------- state (unsaved values) ---------- */

	readConfig: function() {
		var g = function(o, d) { var v = uci.get('ax9000', 'led', o); return v == null || v === '' ? d : v; };
		var sp = parseFloat(g('speed', '1')), br = parseInt(g('brightness', '255'), 10);

		this.x = {
			effect: ledfx.EFFECTS.indexOf(g('effect', 'static')) >= 0 ? g('effect', 'static') : 'static',
			color: HEX_RE.test(g('color', '')) ? g('color').toLowerCase() : '#0000ff',
			speed: sp >= SPEED_MIN && sp <= SPEED_MAX ? sp : 1,
			brightness: br >= 0 && br <= 255 ? br : 255
		};
		this.nightCfg = {
			enabled: g('night_enabled', '0') == '1',
			start: padTime(g('night_start', '23:00')),
			end: padTime(g('night_end', '07:00')),
			mode: g('night_mode', 'off') == 'dim' ? 'dim' : 'off'
		};
		this.wan = g('wan_iface', 'wan');
		this.events = uci.sections('ax9000', 'led_event').map(function(s) {
			var spd = parseFloat(s.speed);
			return {
				name: s['.name'],
				enabled: s.enabled == '1',
				priority: parseInt(s.priority, 10) || 0,
				effect: ledfx.EFFECTS.indexOf(s.effect) >= 0 ? s.effect : 'static',
				color: HEX_RE.test(s.color || '') ? s.color.toLowerCase() : '#ffffff',
				speed: spd >= SPEED_MIN && spd <= SPEED_MAX ? spd : 1,
				override_night: s.override_night == '1'
			};
		});
	},

	/* ---------- layout ---------- */

	build: function() {
		this.refs = {};
		var kids = [
			E('style', {}, CSS),
			E('h2', { 'name': 'content' }, _('LED')),
			E('div', { 'class': 'cbi-map-descr' }, _('The X light on top of the router, its night mode, event signals and the small status LEDs.')),
			E('div', { 'class': 'axl-stack' }, [
				this.buildX(),
				E('div', { 'class': 'axl-grid2' }, [ this.buildNight(), this.buildIndicators() ]),
				this.buildEvents()
			])
		];
		this.root.textContent = '';
		kids.forEach(function(k) { this.root.appendChild(k); }, this);
		this.syncX();
		this.updateStatus();
	},

	card: function(title, descr, extra, kids) {
		return E('div', { 'class': 'axl-card' }, [
			E('div', { 'class': 'axl-head' }, [
				E('div', {}, [ E('h3', {}, title), descr ? E('p', {}, descr) : '' ]),
				extra || ''
			])
		].concat(kids));
	},

	seg: function(label, items, value, onpick) {
		var group = E('div', { 'class': 'axl-seg', 'role': 'group', 'aria-label': label });
		var btns = items.map(function(it) {
			var b = E('button', {
				'type': 'button', 'aria-pressed': String(it[0] == value), 'data-v': it[0],
				'click': function(ev) {
					ev.preventDefault();
					btns.forEach(function(x) { x.setAttribute('aria-pressed', String(x === b)); });
					onpick(it[0]);
				}
			}, it[1]);
			return b;
		});
		btns.forEach(function(b) { group.appendChild(b); });
		return group;
	},

	field: function(label, widget, cls) {
		return E('div', { 'class': 'axl-field' + (cls ? ' ' + cls : '') }, [ E('span', { 'class': 'l' }, label), widget ]);
	},

	switchEl: function(id, checked, text, onchange) {
		var cb = E('input', { 'type': 'checkbox', 'id': id, 'change': function() { onchange(cb.checked); } });
		cb.checked = checked;
		return E('label', { 'class': 'axl-switch' }, [ cb, E('span', { 'class': 'tr' }), text ? E('span', {}, text) : '' ]);
	},

	/* ---------- X light ---------- */

	buildX: function() {
		var self = this, x = this.x;

		this.refs.chip = E('span', { 'class': 'axl-chip', 'role': 'status' });

		var tryBtn = E('button', {
			'class': 'cbi-button cbi-button-action', 'type': 'button',
			'click': function(ev) { ev.preventDefault(); self.preview(tryBtn); }
		}, _('Try on router · %d s').format(PREVIEW_SECONDS));

		this.refs.offSw = this.switchEl('axl-off', false, _('Off until reboot'), function(on) {
			callOff(on).then(function() { return self.refreshStatus(); }).catch(function(e) {
				ui.addNotification(null, E('p', {}, e.message), 'danger');
			});
		});

		var vx = E('div', { 'class': 'axl-vx' }, [
			virtualX(function() { return x; }),
			E('div', { 'class': 'cap' }, _('Live preview of the unsaved settings')),
			tryBtn,
			this.refs.offSw
		]);

		var effect = this.seg(_('Effect'), effects(), x.effect, function(v) { x.effect = v; self.syncX(); });

		this.refs.colorField = this.field(_('Color'),
			colorPicker(x.color, function(c) { x.color = c; }), 'top');

		var spOut = E('output', {}, x.speed + '×');
		var sp = E('input', { 'type': 'range', 'min': '0', 'max': '1000', 'step': '1', 'value': String(speedToPos(x.speed)),
			'aria-label': _('Speed'),
			'input': function() { x.speed = posToSpeed(+sp.value); spOut.textContent = x.speed + '×'; } });
		this.refs.speedField = this.field(_('Speed'), E('div', {}, [
			E('div', { 'class': 'axl-slider' }, [ sp, spOut ]),
			E('p', { 'class': 'axl-help' }, _('Slow 0.1× … fast 10×'))
		]));

		var brOut = E('output', {}, Math.round(x.brightness / 2.55) + ' %');
		var br = E('input', { 'type': 'range', 'min': '0', 'max': '100', 'step': '1', 'value': String(Math.round(x.brightness / 2.55)),
			'aria-label': _('Brightness'),
			'input': function() { x.brightness = Math.round(+br.value * 2.55); brOut.textContent = br.value + ' %'; } });
		this.refs.brightField = this.field(_('Brightness'), E('div', { 'class': 'axl-slider' }, [ br, brOut ]));

		return this.card(_('X light'), _('Changes show in the preview at once and on the router after Save & Apply.'), this.refs.chip, [
			E('div', { 'class': 'axl-xl' }, [
				vx,
				E('div', { 'class': 'axl-stack', 'style': 'gap:1.1rem' }, [
					this.field(_('Effect'), effect),
					this.refs.colorField,
					this.refs.speedField,
					this.refs.brightField
				])
			])
		]);
	},

	syncX: function() {
		var e = this.x.effect;
		this.refs.colorField.hidden = !usesColor(e);
		this.refs.speedField.hidden = !usesSpeed(e);
		this.refs.brightField.hidden = e == 'off';
	},

	preview: function(btn) {
		var self = this, x = this.x;
		var same = ledfx.sameAsRunning(x, this.status, uci.get('ax9000', 'led', 'speed'));

		if (same)
			ui.addTimeLimitedNotification(null, E('p', {},
				_('The light already shows these settings. Change the color or effect to see a preview.')), 6000, 'info');

		btn.disabled = true;
		callPreview(x.effect, x.color, String(x.speed), x.brightness, PREVIEW_SECONDS).then(function(res) {
			if (res && res.ok && !same)
				ui.addTimeLimitedNotification(null, E('p', {},
					_('The router shows the unsaved settings for %d seconds, then the saved ones return.').format(PREVIEW_SECONDS)), 4000, 'info');
			else if (!(res && res.ok))
				ui.addNotification(null, E('p', {}, _('Preview failed: %s').format((res && res.error || 'unknown') +
					(res && res.argument ? ' (' + res.argument + ')' : ''))), 'danger');
			return self.refreshStatus();
		}).catch(function(e) {
			ui.addNotification(null, E('p', {}, _('Preview failed: %s').format(e.message)), 'danger');
		}).finally(function() { btn.disabled = false; });
	},

	refreshStatus: function() {
		var self = this;
		return L.resolveDefault(callStatus(), null).then(function(st) {
			self.status = st;
			self.updateStatus();
		});
	},

	updateStatus: function() {
		var st = this.status, chip = this.refs.chip;
		if (!chip)
			return;

		chip.textContent = '';
		chip.className = 'axl-chip';

		if (!st || st.error) {
			chip.classList.add('err');
			chip.appendChild(E('span', {}, st && st.error == 'no_rgb_led'
				? _('X light not found: the PWM LED device is missing in this image.')
				: _('The LED service is not running.')));
			return;
		}

		var parts = [ _('Running: %s').format(effectLabel(st.effect)) ];
		if (st.preview) parts = [ _('Preview') ];
		if (st.off) parts = [ _('Off until reboot') ];
		if (st.night) parts.push(_('night mode'));
		(st.events_active || []).forEach(function(e) { parts.push(eventInfo(e)[0]); });

		if (HEX_RE.test(st.color || '') && st.effect != 'off' && st.brightness > 0 && !st.off)
			chip.appendChild(E('span', { 'class': 'axl-dot', 'style': 'background:' + st.color }));
		chip.appendChild(E('span', {}, parts.join(' · ')));

		var cb = this.refs.offSw.querySelector('input');
		if (document.activeElement !== cb)
			cb.checked = !!st.off;
	},

	/* ---------- night ---------- */

	buildNight: function() {
		var n = this.nightCfg;
		var start = E('input', { 'class': 'cbi-input-text', 'type': 'time', 'value': n.start, 'aria-label': _('Night starts'),
			'change': function() { n.start = start.value; } });
		var end = E('input', { 'class': 'cbi-input-text', 'type': 'time', 'value': n.end, 'aria-label': _('Night ends'),
			'change': function() { n.end = end.value; } });
		var body = E('div', { 'class': 'axl-stack', 'style': 'gap:.75rem' }, [
			this.field(_('Hours'), E('div', { 'class': 'axl-row' }, [ start, '–', end ])),
			this.field(_('At night'), this.seg(_('At night'), [ [ 'off', _('Light off') ], [ 'dim', _('Dimmed') ] ], n.mode,
				function(v) { n.mode = v; })),
			E('p', { 'class': 'axl-help' }, _('Events marked "Show at night" still appear.'))
		]);
		body.hidden = !n.enabled;
		this.refs.nightStart = start;
		this.refs.nightEnd = end;

		return this.card(_('Night mode'), _('Dim or turn off the X light at night.'),
			this.switchEl('axl-night', n.enabled, _('On'), function(on) { n.enabled = on; body.hidden = !on; }),
			[ body ]);
	},

	/* ---------- front indicators (top / bottom) ---------- */

	findLedSection: function(name) {
		return uci.sections('system', 'led').filter(function(s) { return s.sysfs == name; })[0];
	},

	/* What one LED does now: its `config led` section if there is one, else
	 * what the kernel runs. Returns { action, port } or { action: 'other:x' }. */
	ledAction: function(name) {
		var sec = this.findLedSection(name), info = this.leds[name] || {};
		var trig = sec ? (sec.trigger || 'none') : (info.active_trigger || 'none');
		var on = sec ? sec['default'] == '1' : (info.brightness > 0);

		switch (trig) {
		case 'none':       return { action: on ? 'on' : 'off' };
		case 'default-on': return { action: 'on' };
		case 'heartbeat':  return { action: 'heartbeat' };
		case 'timer':      return { action: 'blink' };
		case 'netdev':     return { action: 'netdev', port: PORTS.indexOf(sec && sec.dev) >= 0 ? sec.dev : 'wan' };
		}
		return { action: 'other:' + trig };
	},

	/* The indicator as the page shows it: the stored choice in
	 * /etc/config/ax9000, else derived from the two LEDs (white wins). */
	readIndicator: function(id) {
		var s = uci.get('ax9000', id);
		if (s && s['.type'] == 'indicator')
			return {
				color: s.color == 'yellow' ? 'yellow' : 'white',
				action: indicatorActions().some(function(a) { return a[0] == s.action; }) ? s.action : 'off',
				port: PORTS.indexOf(s.port) >= 0 ? s.port : 'wan'
			};

		var w = this.ledAction(INDICATORS[id].white), y = this.ledAction(INDICATORS[id].yellow);
		var pick = w.action != 'off' ? [ 'white', w ] : (y.action != 'off' ? [ 'yellow', y ] : [ 'white', w ]);
		return { color: pick[0], action: pick[1].action, port: pick[1].port || 'wan' };
	},

	buildIndicators: function() {
		var self = this;
		var ids = Object.keys(INDICATORS).filter(function(id) {
			return self.leds[INDICATORS[id].white] && self.leds[INDICATORS[id].yellow];
		});

		this.indRows = ids.map(function(id) {
			var cur = self.readIndicator(id), st = Object.assign({}, cur);
			var lamp = E('span', { 'class': 'lamp' });

			var actions = indicatorActions();
			if (cur.action.indexOf('other:') == 0)
				actions.unshift([ cur.action, _('Other: %s').format(cur.action.substr(6)) ]);
			var act = E('select', { 'class': 'cbi-input-select', 'id': 'axl-ind-' + id, 'aria-label': _('%s: action').format(indicatorLabel(id)) },
				actions.map(function(a) { return E('option', { 'value': a[0] }, a[1]); }));
			act.value = cur.action;

			var port = E('select', { 'class': 'cbi-input-select', 'aria-label': _('%s: port').format(indicatorLabel(id)) },
				portChoices().map(function(p) { return E('option', { 'value': p[0] }, p[1]); }));
			port.value = cur.port;
			var portCell = E('span', { 'class': 'port' }, port);

			var sync = function() {
				portCell.classList.toggle('off', st.action != 'netdev');
				port.disabled = st.action != 'netdev';
				lamp.style.background = st.color == 'yellow' ? '#f0b400' : '#f2f2f2';
				lamp.style.opacity = st.action == 'off' ? '.25' : '1';
			};

			var color = self.seg(_('%s: color').format(indicatorLabel(id)),
				[ [ 'white', _('White') ], [ 'yellow', _('Yellow') ] ], cur.color,
				function(v) { st.color = v; sync(); });

			act.addEventListener('change', function() { st.action = act.value; sync(); });
			port.addEventListener('change', function() { st.port = port.value; });
			sync();

			return { id: id, initial: cur, st: st,
				node: E('div', { 'class': 'axl-ind' }, [
					E('span', {}, lamp),
					E('span', { 'class': 'nm' }, [ E('b', {}, indicatorLabel(id)), E('small', {}, indicatorHint(id)) ]),
					E('span', {}, color),
					E('span', {}, act),
					portCell
				]) };
		});

		return this.card(_('Status LEDs'), _('The two indicators on the front panel. Each has a white and a yellow light.'), null, [
			this.indRows.length
				? E('div', { 'class': 'axl-inds' }, this.indRows.map(function(r) { return r.node; }))
				: E('p', { 'class': 'axl-help' }, _('No status LEDs were found.'))
		]);
	},

	stageIndicators: function() {
		var self = this;
		var sset = function(sid, opt, val) {
			if (val == null) {
				if (uci.get('system', sid, opt) != null) uci.unset('system', sid, opt);
			}
			else if (uci.get('system', sid, opt) !== val) {
				uci.set('system', sid, opt, val);
			}
		};

		/* one LED as a standard `config led` section; reuses an existing one */
		var setLed = function(name, action, port) {
			var sec = self.findLedSection(name), sid;
			if (sec) {
				sid = sec['.name'];
			}
			else {
				sid = 'ax9000_' + name.replace(/[^A-Za-z0-9]/g, '_');
				if (uci.get('system', sid) == null)
					uci.add('system', 'led', sid);
				sset(sid, 'name', name);
				sset(sid, 'sysfs', name);
			}
			var single = action == 'netdev';
			var trig = { on: 'default-on', heartbeat: 'heartbeat', blink: 'timer', netdev: 'netdev' }[action] || 'none';
			sset(sid, 'trigger', trig);
			sset(sid, 'default', trig == 'none' ? '0' : (trig == 'default-on' ? '1' : null));
			sset(sid, 'delayon', trig == 'timer' ? '500' : null);
			sset(sid, 'delayoff', trig == 'timer' ? '500' : null);
			sset(sid, 'dev', single ? port : null);
			sset(sid, 'mode', single ? 'link tx rx' : null);
		};

		(this.indRows || []).forEach(function(r) {
			var st = r.st, init = r.initial;
			if (st.action.indexOf('other:') == 0)
				return;
			if (uci.get('ax9000', r.id) && st.color == init.color && st.action == init.action && st.port == init.port)
				return;

			if (!uci.get('ax9000', r.id))
				uci.add('ax9000', 'indicator', r.id);
			[ [ 'color', st.color ], [ 'action', st.action ], [ 'port', st.port ] ].forEach(function(kv) {
				if (uci.get('ax9000', r.id, kv[0]) !== kv[1])
					uci.set('ax9000', r.id, kv[0], kv[1]);
			});

			var pair = INDICATORS[r.id];
			setLed(pair[st.color], st.action, st.port);
			setLed(pair[st.color == 'white' ? 'yellow' : 'white'], 'off', null);
		});
	},

	/* ---------- events ---------- */

	buildEvents: function() {
		var self = this;

		var ifaces = (uci.sections('network', 'interface') || []).map(function(s) { return s['.name']; })
			.filter(function(n) { return n != 'loopback'; });
		if (ifaces.indexOf(this.wan) < 0)
			ifaces.unshift(this.wan);
		var wan = E('select', { 'class': 'cbi-input-select', 'id': 'axl-wan', 'style': 'width:auto',
			'change': function() { self.wan = wan.value; } },
			ifaces.map(function(n) { return E('option', { 'value': n }, n); }));
		wan.value = this.wan;

		var speeds = [ [ 0.5, _('Slow') ], [ 1, _('Normal') ], [ 2, _('Fast') ] ];

		var rows = this.events.map(function(ev) {
			var info = eventInfo(ev.name);
			var cbtn = E('button', { 'class': 'axl-cbtn', 'type': 'button', 'style': 'background:' + ev.color,
				'title': ev.color, 'aria-label': _('%s: color %s').format(info[0], ev.color),
				'click': function(e) { e.preventDefault(); self.pickEventColor(ev, cbtn, info[0]); } });

			var eff = E('select', { 'class': 'cbi-input-select', 'aria-label': _('%s: effect').format(info[0]),
				'change': function() { ev.effect = eff.value; sync(); } },
				effects().map(function(e) { return E('option', { 'value': e[0] }, e[1]); }));
			eff.value = ev.effect;

			var opts = speeds.slice();
			if (!speeds.some(function(s) { return s[0] == ev.speed; }))
				opts.push([ ev.speed, ev.speed + '×' ]);
			var spd = E('select', { 'class': 'cbi-input-select', 'aria-label': _('%s: speed').format(info[0]),
				'change': function() { ev.speed = parseFloat(spd.value); } },
				opts.map(function(s) { return E('option', { 'value': String(s[0]) }, s[1]); }));
			spd.value = String(ev.speed);

			var prio = E('input', { 'class': 'cbi-input-text', 'type': 'number', 'min': '0', 'max': '999', 'step': '1',
				'value': String(ev.priority), 'aria-label': _('%s: priority').format(info[0]),
				'input': function() { ev.priority = prio.value; } });

			var night = E('input', { 'type': 'checkbox', 'change': function() { ev.override_night = night.checked; } });
			night.checked = ev.override_night;

			var sync = function() {
				cbtn.disabled = !usesColor(ev.effect);
				spd.disabled = !usesSpeed(ev.effect);
			};
			sync();

			return E('div', { 'class': 'axl-evt' }, [
				E('span', { 'class': 'sw' }, self.switchEl('axl-ev-' + ev.name, ev.enabled, null, function(on) { ev.enabled = on; })),
				E('span', { 'class': 'nm' }, [
					E('b', {}, info[0]),
					info[1] ? E('small', {}, info[1]) : '',
					E('label', {}, [ night, _('Show at night') ])
				]),
				E('span', { 'class': 'ef' }, eff),
				E('span', { 'class': 'co' }, cbtn),
				E('span', { 'class': 'sp' }, spd),
				E('span', { 'class': 'pr' }, prio)
			]);
		});

		return this.card(_('Events'), _('While an event is active it replaces the X light. The highest priority wins.'),
			E('div', { 'class': 'axl-row' }, [ E('label', { 'for': 'axl-wan' }, _('Watch interface')), wan ]), [
				E('div', { 'class': 'axl-evts' }, [
					E('div', { 'class': 'axl-evt head' }, [
						E('span', {}, _('On')), E('span', {}, _('Event')), E('span', {}, _('Effect')),
						E('span', {}, _('Color')), E('span', {}, _('Speed')), E('span', {}, _('Priority'))
					])
				].concat(rows)),
				E('p', { 'class': 'axl-help' }, _('"Watch interface" is the network interface checked for the "No internet" event.'))
			]);
	},

	pickEventColor: function(ev, btn, label) {
		var picked = ev.color;
		var picker = colorPicker(ev.color, function(c) { picked = c; });

		ui.showModal(_('%s: color').format(label), [
			picker,
			E('div', { 'class': 'right' }, [
				E('button', { 'class': 'btn', 'click': ui.hideModal }, _('Cancel')), ' ',
				E('button', { 'class': 'btn cbi-button-action important', 'click': function() {
					ev.color = picked;
					btn.style.background = picked;
					btn.title = picked;
					btn.setAttribute('aria-label', _('%s: color %s').format(label, picked));
					ui.hideModal();
				} }, _('Use this color'))
			])
		]);
	},

	/* ---------- save ---------- */

	stage: function() {
		var self = this, x = this.x, n = this.nightCfg;

		if (n.enabled && (!TIME_RE.test(this.refs.nightStart.value) || !TIME_RE.test(this.refs.nightEnd.value)))
			throw new Error(_('Enter the night start and end as HH:MM.'));
		this.events.forEach(function(ev) {
			var p = String(ev.priority).trim();
			if (!/^[0-9]+$/.test(p) || +p > 999)
				throw new Error(_('%s: priority must be a whole number from 0 to 999.').format(eventInfo(ev.name)[0]));
		});

		var set = function(sid, opt, val) {
			if (uci.get('ax9000', sid, opt) !== val)
				uci.set('ax9000', sid, opt, val);
		};

		if (!uci.get('ax9000', 'led'))
			uci.add('ax9000', 'led', 'led');
		set('led', 'effect', x.effect);
		set('led', 'color', x.color);
		set('led', 'speed', String(x.speed));
		set('led', 'brightness', String(x.brightness));
		set('led', 'night_enabled', n.enabled ? '1' : '0');
		if (TIME_RE.test(n.start)) set('led', 'night_start', padTime(n.start));
		if (TIME_RE.test(n.end)) set('led', 'night_end', padTime(n.end));
		set('led', 'night_mode', n.mode);
		set('led', 'wan_iface', this.wan);

		this.events.forEach(function(ev) {
			set(ev.name, 'enabled', ev.enabled ? '1' : '0');
			set(ev.name, 'priority', String(+String(ev.priority).trim()));
			set(ev.name, 'effect', ev.effect);
			set(ev.name, 'color', ev.color);
			set(ev.name, 'speed', String(ev.speed));
			set(ev.name, 'override_night', ev.override_night ? '1' : '0');
		});

		this.stageIndicators();

		if (usesColor(x.effect))
			pushRecent(x.color);
	},

	handleSave: function(ev) {
		try {
			this.stage();
		}
		catch (e) {
			ui.addNotification(null, E('p', {}, e.message), 'danger');
			return Promise.reject(e);
		}
		return uci.save();
	},

	handleSaveApply: function(ev, mode) {
		return this.handleSave(ev).then(function() {
			ui.changes.apply(mode == '0');
		}).catch(function() {});
	},

	handleReset: function(ev) {
		var self = this;
		[ 'ax9000', 'system', 'network' ].forEach(function(c) { uci.unload(c); });
		return Promise.all([
			uci.load('ax9000'), uci.load('system'), L.resolveDefault(uci.load('network'), null),
			L.resolveDefault(callLeds(), {})
		]).then(function(r) {
			self.leds = r[3] || {};
			self.readConfig();
			self.build();
		});
	}
});
