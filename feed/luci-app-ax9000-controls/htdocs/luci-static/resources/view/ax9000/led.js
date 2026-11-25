'use strict';
'require view';
'require form';
'require rpc';
'require uci';
'require poll';
'require fs';
'require dom';
'require ui';
'require ax9000.ledfx as ledfx';

var callStatus = rpc.declare({
	object: 'ax9000.led',
	method: 'status',
	expect: { '': {} }
});

var callPreview = rpc.declare({
	object: 'ax9000.led',
	method: 'preview',
	params: [ 'effect', 'color', 'speed', 'brightness', 'seconds' ],
	expect: { '': {} }
});

var callOff = rpc.declare({
	object: 'ax9000.led',
	method: 'off_until_reboot',
	params: [ 'off' ],
	expect: { '': {} }
});

var HEX_RE = /^#[0-9a-fA-F]{6}$/;
var SPEED_MIN = 0.1, SPEED_MAX = 10;
var PREVIEW_SECONDS = 10;
var SKIP_LED = 'rgb:indicator';
var ledsChanged = false;
var TRIGGER_RE = /^(none|default-on|heartbeat|netdev|timer|phy\d+tpt)$/;

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

function eventLabel(name) {
	return ({
		offline: _('No internet'),
		wps: _('WPS pairing'),
		upgrade: _('Firmware upgrade')
	})[name] || name;
}

function ledLabel(name) {
	return ({
		'blue:status': _('System, blue'),
		'yellow:status': _('System, yellow'),
		'blue:wan': _('Network, blue'),
		'yellow:wan': _('Network, yellow')
	})[name] || name;
}

/* ---- colour helpers ---- */

function hexToHsl(hex) {
	var r = parseInt(hex.substr(1, 2), 16) / 255,
	    g = parseInt(hex.substr(3, 2), 16) / 255,
	    b = parseInt(hex.substr(5, 2), 16) / 255,
	    max = Math.max(r, g, b), min = Math.min(r, g, b),
	    l = (max + min) / 2, d = max - min, h = 0, s = 0;

	if (d) {
		s = d / (1 - Math.abs(2 * l - 1));
		if (max == r) h = ((g - b) / d + 6) % 6;
		else if (max == g) h = (b - r) / d + 2;
		else h = (r - g) / d + 4;
		h *= 60;
	}
	return [ Math.round(h), Math.round(s * 100), Math.round(l * 100) ];
}

function hslToHex(h, s, l) {
	s /= 100; l /= 100;
	var a = s * Math.min(l, 1 - l);
	function ch(n) {
		var k = (n + h / 30) % 12,
		    v = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
		return ('0' + Math.round(v * 255).toString(16)).slice(-2);
	}
	return '#' + ch(0) + ch(8) + ch(4);
}

/* ---- styles (theme neutral: only currentColor and translucent greys) ---- */

var CSS = [
	'.axl-color{display:flex;flex-direction:column;gap:.6em;max-width:28em}',
	'.axl-row{display:flex;flex-wrap:wrap;align-items:center;gap:.5em}',
	'.axl-picker{width:3em;height:2.2em;padding:0;border:1px solid rgba(128,128,128,.5);border-radius:4px;background:none;cursor:pointer;flex:none}',
	'.axl-swatches{display:flex;flex-wrap:wrap;gap:.35em}',
	'.axl-sw{width:1.7em;height:1.7em;padding:0;border-radius:50%;border:2px solid rgba(128,128,128,.5);cursor:pointer;box-sizing:border-box}',
	'.axl-sw.active{border-color:currentColor;box-shadow:0 0 0 2px rgba(128,128,128,.45)}',
	'.axl-hsl{display:grid;grid-template-columns:2.2em 1fr;gap:.35em .6em;align-items:center}',
	'.axl-hsl input[type=range]{-webkit-appearance:none;appearance:none;width:100%;height:10px;border-radius:5px;margin:0;border:1px solid rgba(128,128,128,.4)}',
	'.axl-hsl input[type=range]::-webkit-slider-runnable-track{background:transparent;height:10px}',
	'.axl-hsl input[type=range]::-moz-range-track{background:transparent;height:10px}',
	'.axl-hsl input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:18px;height:18px;margin-top:-4px;border-radius:50%;background:#fff;border:2px solid #555}',
	'.axl-hsl input[type=range]::-moz-range-thumb{width:14px;height:14px;border-radius:50%;background:#fff;border:2px solid #555}',
	'.axl-slider{display:flex;flex-wrap:wrap;align-items:center;gap:.5em;max-width:28em}',
	'.axl-slider input[type=range]{flex:1 1 10em;min-width:0}',
	'.axl-slider .cbi-input-text,.axl-color .cbi-input-text{width:7em;flex:none}',
	'.axl-badge{display:inline-flex;flex-wrap:wrap;align-items:center;gap:.5em;padding:.3em .8em;border-radius:1em;background:rgba(128,128,128,.18)}',
	'.axl-dot{width:1em;height:1em;border-radius:50%;border:1px solid rgba(128,128,128,.6);flex:none}',
	'.axl-badge.err{background:rgba(220,60,60,.2)}',
	'.axl-leds{display:flex;flex-direction:column;gap:.6em}',
	'.axl-led{display:flex;flex-wrap:wrap;align-items:center;gap:.5em 1em}',
	'.axl-led>label{flex:1 1 12em;min-width:0}',
	'.axl-led select,.axl-led input{flex:0 1 12em;min-width:0}',
	/* X light: virtual X on the left, controls on the right; stacked on phones */
	'.axl-split{display:flex;align-items:flex-start;gap:1.5em}',
	'.axl-split>.cbi-section-node{flex:1 1 auto;min-width:0}',
	'.axl-vx{flex:none;width:200px;max-width:100%;margin:0;text-align:center}',
	'.axl-vx svg{display:block;width:100%;height:auto;aspect-ratio:1;border-radius:14%;box-shadow:0 0 0 1px rgba(128,128,128,.35),0 4px 14px rgba(0,0,0,.25)}',
	'.axl-vx figcaption{margin-top:.5em;font-size:.85em;opacity:.7}',
	'@media (max-width:600px){.axl-split{flex-direction:column;align-items:stretch}.axl-vx{align-self:center;width:min(200px,60vw)}}'
].join('\n');

/* ---- virtual X: renders the current form values with the router's maths ---- */

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

/* read() returns { effect, color, speed, brightness } from the form (unsaved
 * values). The loop stops by itself once the widget leaves the document. */
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
	    node = E('figure', { 'class': 'axl-vx' }, [ svg, E('figcaption', {}, _('Preview of the X light')) ]),
	    vals = { effect: 'off', color: '#000000', speed: '1', brightness: '0' },
	    t0 = null, attached = false, born = Date.now(), lastKey = null;

	function tick(now) {
		if (svg.isConnected)
			attached = true;
		else if (attached || Date.now() - born > 30000)
			return;	/* view left or re-rendered (or never shown): stop, no leak */

		window.requestAnimationFrame(tick);
		if (!attached || document.hidden)
			return;

		var v = read() || vals;
		if (!HEX_RE.test(v.color || ''))
			v.color = vals.color;	/* keep the last valid color while typing */
		if (t0 == null || v.effect != vals.effect || v.speed != vals.speed)
			t0 = now;	/* restart the effect like a preview does */
		vals = v;

		var f = ledfx.visual(v.effect, v.color, now - t0, ledfx.parseSpeed(v.speed), v.brightness),
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
	return node;
}

/* Hex text field + native picker, preset swatches and H/S/L sliders.
 * The text field stays the real form widget, so formvalue() keeps working. */
var ColorValue = form.Value.extend({
	compact: false,

	validate: function(section_id, value) {
		return HEX_RE.test(value) ? true : _('Enter a color as #rrggbb, for example #0000ff.');
	},

	write: function(section_id, value) {
		return form.Value.prototype.write.call(this, section_id, String(value).toLowerCase());
	},

	renderWidget: function(section_id, option_index, cfgvalue) {
		var self = this;

		return Promise.resolve(form.Value.prototype.renderWidget.apply(this, arguments)).then(function(node) {
			var inst = dom.findClassInstance(node),
			    text = node.querySelector('input'),
			    start = HEX_RE.test(cfgvalue || '') ? cfgvalue.toLowerCase() : '#0000ff',
			    hsl = hexToHsl(start),
			    picker = E('input', { 'type': 'color', 'class': 'axl-picker', 'value': start,
			                          'aria-label': _('Pick a color') }),
			    swatches = [], sliders = {};

			function paint() {
				var h = hsl[0], s = hsl[1], l = hsl[2];
				if (!sliders.h) return;
				sliders.h.style.background = 'linear-gradient(to right,#f00,#ff0,#0f0,#0ff,#00f,#f0f,#f00)';
				sliders.s.style.background = 'linear-gradient(to right,hsl(' + h + ',0%,' + l + '%),hsl(' + h + ',100%,' + l + '%))';
				sliders.l.style.background = 'linear-gradient(to right,#000,hsl(' + h + ',' + s + '%,50%),#fff)';
			}

			function apply(hex, from) {
				hex = hex.toLowerCase();
				if (from != 'text' && from != 'init') {
					inst.setValue(hex);
					inst.triggerValidation();
				}
				if (from != 'picker')
					picker.value = hex;
				if (from != 'hsl') {
					var n = hexToHsl(hex);
					if (n[1] == 0 || n[2] == 0 || n[2] == 100)
						n[0] = hsl[0];	/* hue is undefined here: keep the slider where it was */
					hsl = n;
					if (sliders.h) {
						sliders.h.value = hsl[0];
						sliders.s.value = hsl[1];
						sliders.l.value = hsl[2];
					}
				}
				swatches.forEach(function(sw) {
					sw.classList.toggle('active', sw.dataset.color == hex);
				});
				paint();
			}

			picker.addEventListener('input', function() { apply(picker.value, 'picker'); });
			text.addEventListener('input', function() {
				if (HEX_RE.test(text.value)) apply(text.value, 'text');
			});

			var top = E('div', { 'class': 'axl-row' }, [ picker, node ]);

			if (self.compact)
				return top;

			var presets = [
				[ '#ff0000', _('Red') ], [ '#ff6a00', _('Orange') ], [ '#ffa000', _('Amber') ],
				[ '#ffff00', _('Yellow') ], [ '#00ff00', _('Green') ], [ '#00ffff', _('Cyan') ],
				[ '#0000ff', _('Blue') ], [ '#8000ff', _('Purple') ], [ '#ff00ff', _('Magenta') ],
				[ '#ffffff', _('White') ]
			];

			var swRow = E('div', { 'class': 'axl-swatches' }, presets.map(function(p) {
				var b = E('button', { 'type': 'button', 'class': 'axl-sw', 'title': p[1],
				                      'aria-label': p[1], 'data-color': p[0],
				                      'style': 'background:' + p[0] });
				b.addEventListener('click', function(ev) { ev.preventDefault(); apply(p[0], 'swatch'); });
				swatches.push(b);
				return b;
			}));

			var grid = E('div', { 'class': 'axl-hsl' });
			[ [ 'h', _('H'), 360, _('Hue') ], [ 's', _('S'), 100, _('Saturation') ],
			  [ 'l', _('L'), 100, _('Lightness') ] ].forEach(function(d, i) {
				var r = E('input', { 'type': 'range', 'min': 0, 'max': d[2], 'step': 1,
				                     'value': hsl[i], 'aria-label': d[3], 'title': d[3] });
				r.addEventListener('input', function() {
					hsl[i] = +r.value;
					apply(hslToHex(hsl[0], hsl[1], hsl[2]), 'hsl');
				});
				sliders[d[0]] = r;
				grid.appendChild(E('span', {}, d[1]));
				grid.appendChild(r);
			});

			apply(start, 'init');

			return E('div', { 'class': 'axl-color' }, [ top, swRow, grid ]);
		});
	}
});

/* Text field plus range slider. `log` maps the slider logarithmically. */
var SliderValue = form.Value.extend({
	min: 0, max: 100, log: false, unit: '',

	toPos: function(v) {
		return this.log ? Math.log(v / this.min) / Math.log(this.max / this.min) * 1000
		                : (v - this.min) / (this.max - this.min) * 1000;
	},

	fromPos: function(p) {
		var v = this.log ? this.min * Math.pow(this.max / this.min, p / 1000)
		                 : this.min + (this.max - this.min) * p / 1000;
		return this.log ? +v.toPrecision(2) : Math.round(v);
	},

	renderWidget: function(section_id, option_index, cfgvalue) {
		var self = this;

		return Promise.resolve(form.Value.prototype.renderWidget.apply(this, arguments)).then(function(node) {
			var inst = dom.findClassInstance(node),
			    text = node.querySelector('input'),
			    v = parseFloat(cfgvalue),
			    range = E('input', { 'type': 'range', 'min': 0, 'max': 1000, 'step': 1,
			                         'aria-label': self.title });

			function place(val) {
				if (isFinite(val))
					range.value = Math.max(0, Math.min(1000, self.toPos(Math.min(self.max, Math.max(self.min, val)))));
			}

			place(isFinite(v) ? v : self.min);
			range.addEventListener('input', function() {
				inst.setValue(String(self.fromPos(+range.value)));
				inst.triggerValidation();
			});
			text.addEventListener('input', function() { place(parseFloat(text.value)); });

			return E('div', { 'class': 'axl-slider' }, [ range, node, self.unit ? E('span', {}, self.unit) : '' ]);
		});
	}
});

/* Status badge + preview buttons, kept outside of UCI (DummyValue never saves). */
var StatusValue = form.DummyValue.extend({
	badge: null,

	renderWidget: function() {
		this.badge = E('span', { 'class': 'axl-badge' });
		this.update(this.initial);
		return this.badge;
	},

	update: function(st) {
		var b = this.badge;
		this.initial = st;
		if (!b) return;
		dom.content(b, []);
		b.classList.remove('err');

		if (!st || st.error) {
			b.classList.add('err');
			b.appendChild(E('span', {}, st && st.error == 'no_rgb_led'
				? _('X light not found: the PWM LED device is missing in this image.')
				: _('The LED service is not running.')));
			return;
		}

		var color = /^#?[0-9a-fA-F]{6}$/.test(st.color || '') ? st.color.replace(/^#?/, '#') : null,
		    parts = [ effectLabel(st.effect) ];

		if (st.night) parts.push(_('night mode'));
		(st.events_active || []).forEach(function(e) { parts.push(eventLabel(e)); });

		if (color && st.effect != 'off' && st.brightness > 0)
			b.appendChild(E('span', { 'class': 'axl-dot', 'style': 'background:' + color }));
		b.appendChild(E('span', {}, parts.join(' · ')));
	}
});

var PreviewValue = form.DummyValue.extend({
	renderWidget: function() {
		var self = this,
		    btn = E('button', { 'class': 'cbi-button cbi-button-action', 'type': 'button' }, _('Preview')),
		    off = E('button', { 'class': 'cbi-button', 'type': 'button' }, _('Off until reboot')),
		    on = E('button', { 'class': 'cbi-button', 'type': 'button' }, _('Turn back on'));

		btn.addEventListener('click', function(ev) {
			ev.preventDefault();
			var v = self.collect();
			if (!v) return;
			/* Same as what the light already runs: the preview would look like
			 * nothing happened, so say so (the call is still sent). */
			var same = ledfx.sameAsRunning(v, self.running && self.running(), uci.get('ax9000', 'led', 'speed'));
			if (same)
				ui.addTimeLimitedNotification(null, E('p', {},
					_('The light already shows these settings — change the color or effect to see a preview.')),
					6000, 'info');
			btn.disabled = true;
			callPreview(v.effect, v.color, String(v.speed), v.brightness, PREVIEW_SECONDS).then(function(res) {
				if (res && res.ok && same)
					return;
				if (res && res.ok)
					ui.addTimeLimitedNotification(null, E('p', {},
						_('Previewing the current, unsaved settings for %d seconds.').format(PREVIEW_SECONDS)),
						4000, 'info');
				else
					ui.addNotification(null, E('p', {},
						_('Preview failed: %s').format((res && res.error || 'unknown') +
							(res && res.argument ? ' (' + res.argument + ')' : ''))), 'danger');
			}).catch(function(e) {
				ui.addNotification(null, E('p', {}, _('Preview failed: %s').format(e.message)), 'danger');
			}).finally(function() { btn.disabled = false; });
		});

		function toggle(state) {
			return function(ev) {
				ev.preventDefault();
				callOff(state).catch(function(e) {
					ui.addNotification(null, E('p', {}, e.message), 'danger');
				});
			};
		}
		off.addEventListener('click', toggle(true));
		on.addEventListener('click', toggle(false));

		return E('div', { 'class': 'axl-row' }, [ btn, off, on ]);
	}
});

/* Flag that never removes its option (the daemon reads a missing `enabled`
 * as disabled) and only stages a write when the value really changed. The
 * stock Flag removes the option whenever the box equals its default, which
 * staged uci/delete calls on every save. */
var StoredFlag = form.Flag.extend({
	rmempty: false,

	parse: function(section_id) {
		if (!this.isActive(section_id))
			return Promise.resolve();	/* hidden: keep the stored value */

		var fval = this.formvalue(section_id), cval = this.cfgvalue(section_id);
		if (cval != null && String(cval) == String(fval))
			return Promise.resolve();
		return Promise.resolve(this.write(section_id, fval));
	}
});

/* Stage `opt=val` in /etc/config/system only if it differs from what is stored. */
function setChanged(sid, opt, val) {
	if (uci.get('system', sid, opt) !== val)
		uci.set('system', sid, opt, val);
}

/* Other LEDs: one trigger select per sysfs LED, written as standard
 * `config led` sections of /etc/config/system (staged like any other change;
 * "Save & Apply" reloads the led service). It lives in the main Map (which
 * also loads `system`), so one Save runs one uci.save(): two Maps on a page
 * each replayed the same staged deletes and the second uci/delete failed
 * with "Resource not found". It never unsets or removes anything. */
var OtherLeds = form.AbstractSection.extend({
	leds: [],

	/* AbstractSection's cfgsections() throws; this section has no UCI sections of its own. */
	cfgsections: function() { return []; },
	checkDepends: function() { return false; },
	load: function() { return Promise.resolve(); },

	findSection: function(name) {
		return uci.sections('system', 'led').filter(function(s) { return s.sysfs == name; })[0];
	},

	render: function() {
		var self = this;

		this.rows = this.leds.map(function(led) {
			var sec = self.findSection(led.name),
			    cur = (sec && sec.trigger) || led.active || 'none',
			    list = led.triggers.filter(function(t) { return TRIGGER_RE.test(t) || t == cur; }),
			    sel = E('select', { 'class': 'cbi-input-select', 'id': 'axl-trig-' + led.name }),
			    dev = E('input', { 'type': 'text', 'class': 'cbi-input-text', 'placeholder': _('Network device'),
			                       'value': (sec && sec.dev) || 'wan', 'aria-label': _('Network device') });

			if (list.indexOf(cur) < 0) list.unshift(cur);
			list.forEach(function(t) {
				sel.appendChild(E('option', { 'value': t, 'selected': t == cur }, t));
			});

			function sync() { dev.style.display = sel.value == 'netdev' ? '' : 'none'; }
			sel.addEventListener('change', sync);
			sync();

			return { name: led.name, sel: sel, dev: dev, trigger: cur, devval: dev.value,
			         node: E('div', { 'class': 'axl-led' }, [
			             E('label', { 'for': sel.id }, ledLabel(led.name)), sel, dev ]) };
		});

		return E('div', { 'class': 'cbi-section' }, [
			E('h3', {}, _('Other LEDs')),
			E('div', { 'class': 'cbi-section-descr' },
				_('Choose what drives each of the other LEDs. Changes only take effect after you click Save & Apply on this page. The X light is controlled above.')),
			this.rows.length
				? E('div', { 'class': 'axl-leds' }, this.rows.map(function(r) { return r.node; }))
				: E('em', {}, _('No other controllable LEDs were found.'))
		]);
	},

	parse: function() {
		var self = this;

		(this.rows || []).forEach(function(r) {
			var trig = r.sel.value, dev = r.dev.value.trim() || 'wan';

			if (trig == r.trigger && (trig != 'netdev' || dev == r.devval))
				return;

			/* Reuse the stock section (led_wan_port_link, ...) or one added
			 * earlier; create ours only when no section drives this LED. */
			var sec = self.findSection(r.name), sid;

			if (sec) {
				sid = sec['.name'];
			} else {
				sid = 'ax9000_' + r.name.replace(/[^A-Za-z0-9]/g, '_');
				if (uci.get('system', sid) == null)
					uci.add('system', 'led', sid);
				setChanged(sid, 'name', r.name);
				setChanged(sid, 'sysfs', r.name);
			}

			setChanged(sid, 'trigger', trig);
			if (trig == 'netdev') {
				setChanged(sid, 'dev', dev);
				if (!uci.get('system', sid, 'mode')) uci.set('system', sid, 'mode', 'link tx rx');
			}

			ledsChanged = true;
			r.trigger = trig;
			r.devval = dev;
		});

		return Promise.resolve();
	}
});

function parseTriggers(raw) {
	var active = null, list = String(raw || '').trim().split(/\s+/).filter(Boolean).map(function(t) {
		var m = t.match(/^\[(.+)\]$/);
		if (m) { active = m[1]; return m[1]; }
		return t;
	});
	return { list: list, active: active };
}

return view.extend({
	/* The led init script has no reload trigger, so restart it once the system config is applied. */
	refreshStatus: function() {
		var o = this.oStatus;
		return L.resolveDefault(callStatus(), null).then(function(st) { if (o) o.update(st); });
	},

	/* Save the Map(s) one after another: every Map.save() ends in the shared
	 * uci.save(), and two concurrent ones replay the same staged changes. */
	handleSave: function(ev) {
		var self = this, maps = Array.prototype.slice.call(
			document.getElementById('maincontent').querySelectorAll('.cbi-map'));

		return maps.reduce(function(p, map) {
			return p.then(function() { return dom.callClassMethod(map, 'save'); });
		}, Promise.resolve()).then(function() { return self.refreshStatus(); });
	},

	handleSaveApply: function(ev, mode) {
		var self = this;
		return this.handleSave(ev).then(function() {
			return Promise.resolve(ui.changes.apply(mode == '0'));
		}).then(function() {
			if (!ledsChanged) return;
			ledsChanged = false;
			return new Promise(function(r) { setTimeout(r, 1500); }).then(function() {
				return fs.exec('/etc/init.d/led', [ 'restart' ]);
			});
		}).then(function() { return new Promise(function(r) { setTimeout(r, 1500); }); })
		.then(function() { return self.refreshStatus(); });
	},

	load: function() {
		return Promise.all([
			L.resolveDefault(fs.list('/sys/class/leds'), []),
			L.resolveDefault(callStatus(), null)
		]).then(function(r) {
			var names = r[0].map(function(e) { return e.name; })
				.filter(function(n) { return n != SKIP_LED; }).sort();

			return Promise.all(names.map(function(n) {
				return L.resolveDefault(fs.read('/sys/class/leds/' + n + '/trigger'), '').then(function(raw) {
					var t = parseTriggers(raw);
					return t.list.length ? { name: n, triggers: t.list, active: t.active } : null;
				});
			})).then(function(leds) {
				return { leds: leds.filter(Boolean), status: r[1] };
			});
		});
	},

	render: function(data) {
		var m, s, o, oEffect, oColor, oSpeed, oBright, oStatus, oPrev;

		m = new form.Map('ax9000', _('LED'),
			_('Control the X light on top of the router and the other status LEDs.'));
		/* Other LEDs are `config led` sections of /etc/config/system: load it
		 * in this Map too, so a single Map (one uci.save()) covers the page. */
		m.parsechain = [ 'ax9000', 'system' ];

		/* ---- X light ---- */
		s = m.section(form.NamedSection, 'led', 'led', _('X light'));

		/* virtual X to the left of the controls (re-created on every render) */
		s.render = function() {
			return Promise.resolve(form.NamedSection.prototype.render.apply(this, arguments)).then(function(node) {
				var body = node && node.querySelector('.cbi-section-node');
				if (!body) return node;
				var split = E('div', { 'class': 'axl-split' });
				body.parentNode.insertBefore(split, body);
				split.appendChild(virtualX(function() {
					return {
						effect: oEffect.formvalue('led'), color: oColor.formvalue('led'),
						speed: oSpeed.formvalue('led'), brightness: oBright.formvalue('led')
					};
				}));
				split.appendChild(body);
				return node;
			});
		};

		oStatus = s.option(StatusValue, '_status', _('Current state'));
		oStatus.initial = data.status;
		this.oStatus = oStatus;

		oEffect = s.option(form.ListValue, 'effect', _('Effect'));
		effects().forEach(function(e) { oEffect.value(e[0], e[1]); });
		oEffect.default = 'static';

		oColor = s.option(ColorValue, 'color', _('Color'));
		oColor.default = '#0000ff';
		oColor.rmempty = false;
		oColor.retain = true;
		[ 'static', 'breathing', 'flashing', 'cycle' ].forEach(function(e) { oColor.depends('effect', e); });

		oSpeed = s.option(SliderValue, 'speed', _('Speed'),
			_('Effect speed from 0.1 (slow) to 10 (fast).'));
		oSpeed.min = SPEED_MIN; oSpeed.max = SPEED_MAX; oSpeed.log = true; oSpeed.unit = '×';
		oSpeed.datatype = 'range(0.1,10)';
		oSpeed.default = '1';
		oSpeed.rmempty = false;
		oSpeed.retain = true;
		[ 'breathing', 'flashing', 'cycle', 'rainbow' ].forEach(function(e) { oSpeed.depends('effect', e); });

		oBright = s.option(SliderValue, 'brightness', _('Brightness'),
			_('0 turns the light off, 255 is full brightness.'));
		oBright.min = 0; oBright.max = 255;
		oBright.datatype = 'and(uinteger,range(0,255))';
		oBright.default = '255';
		oBright.rmempty = false;

		oPrev = s.option(PreviewValue, '_preview', _('Preview'),
			_('Shows the current, unsaved settings on the light for %d seconds, then the saved setup returns.').format(PREVIEW_SECONDS));
		oPrev.collect = function() {
			var color = oColor.formvalue('led'), speed = parseFloat(oSpeed.formvalue('led')),
			    bright = parseInt(oBright.formvalue('led'), 10), effect = oEffect.formvalue('led');

			if (!HEX_RE.test(color || '')) {
				ui.addNotification(null, E('p', {}, _('Enter a color as #rrggbb, for example #0000ff.')), 'danger');
				return null;
			}
			if (!(speed >= SPEED_MIN && speed <= SPEED_MAX)) speed = 1;
			if (!(bright >= 0 && bright <= 255)) bright = 255;
			return { effect: effect, color: color.toLowerCase(), speed: speed, brightness: bright };
		};
		oPrev.running = function() { return oStatus.initial; };

		/* ---- Night mode ---- */
		s = m.section(form.NamedSection, 'led', 'led', _('Night mode'),
			_('Dim or switch off the X light during the night. Events marked "Override night" still show.'));

		o = s.option(StoredFlag, 'night_enabled', _('Enable'));
		o.default = '0';
		o.rmempty = false;

		[ [ 'night_start', _('Start'), '23:00' ], [ 'night_end', _('End'), '07:00' ] ].forEach(function(d) {
			o = s.option(form.Value, d[0], d[1]);
			o.default = d[2];
			o.datatype = 'timehhmm';
			o.rmempty = false;
			o.retain = true;
			o.depends('night_enabled', '1');
			o.renderWidget = function() {
				return Promise.resolve(form.Value.prototype.renderWidget.apply(this, arguments)).then(function(node) {
					var i = node.querySelector('input');
					if (i) i.type = 'time';
					return node;
				});
			};
		});

		o = s.option(form.ListValue, 'night_mode', _('At night'));
		o.value('off', _('Light off'));
		o.value('dim', _('Dimmed'));
		o.default = 'off';
		o.retain = true;
		o.depends('night_enabled', '1');

		/* ---- Events ---- */
		s = m.section(form.NamedSection, 'led', 'led', _('Events'),
			_('Events temporarily replace the X light. When several are active, the highest priority wins.'));

		o = s.option(form.Value, 'wan_iface', _('WAN interface'),
			_('Network interface watched for the "No internet" event.'));
		o.default = 'wan';
		o.datatype = 'uciname';
		o.rmempty = false;

		s = m.section(form.TableSection, 'led_event');
		s.anonymous = true;
		s.addremove = false;
		s.sortable = false;

		o = s.option(form.DummyValue, '_name', _('Event'));
		o.cfgvalue = function(section_id) { return eventLabel(section_id); };

		o = s.option(StoredFlag, 'enabled', _('Enabled'));
		o.default = '1';
		o.editable = true;

		o = s.option(form.Value, 'priority', _('Priority'));
		o.datatype = 'and(uinteger,range(0,999))';
		o.default = '50';
		o.rmempty = false;

		o = s.option(form.ListValue, 'effect', _('Effect'));
		effects().forEach(function(e) { o.value(e[0], e[1]); });
		o.default = 'static';

		o = s.option(ColorValue, 'color', _('Color'));
		o.compact = true;
		o.default = '#ff0000';
		o.rmempty = false;

		o = s.option(form.Value, 'speed', _('Speed'));
		o.datatype = 'range(0.1,10)';
		o.default = '1';
		o.rmempty = false;

		o = s.option(StoredFlag, 'override_night', _('Override night'));
		o.default = '0';
		o.editable = true;

		/* ---- Other LEDs (system config, same Map: see OtherLeds) ---- */
		var other = m.section(OtherLeds);
		other.leds = data.leds;

		poll.add(function() {
			return callStatus().then(function(st) { oStatus.update(st); }).catch(function() {});
		}, 3);
		if (!poll.active()) poll.start();

		return m.render().then(function(node) {
			return E('div', {}, [ E('style', {}, CSS), node ]);
		});
	}
});
