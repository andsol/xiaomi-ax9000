'use strict';
'require view';
'require rpc';
'require uci';
'require poll';
'require ui';

/*
 * Fan page: a day and a night setting, each a 4-point curve or a fixed speed,
 * plus the night hours and the sensor selection. Changes are staged in UCI and
 * applied with the standard LuCI Save / Save & Apply buttons; procd reloads
 * ax9000-fand when /etc/config/ax9000 changes.
 */

var callStatus = rpc.declare({ object: 'ax9000.fan', method: 'status' });

var PROFILES = [ 'day', 'night' ];
var NPOINTS = 4;
var SAFETY_TEMP = 85;
var T_MIN = 0, T_MAX = 100;

/* Mirrors DEFAULTS in /usr/share/ax9000/fancurve.uc. */
var DEFAULTS = {
	day:   { mode: 'curve', fixed: 40, hysteresis: 3, points: [ [ 60, 25 ], [ 68, 40 ], [ 76, 65 ], [ 84, 100 ] ] },
	night: { mode: 'curve', fixed: 20, hysteresis: 3, points: [ [ 65, 20 ], [ 72, 30 ], [ 80, 55 ], [ 86, 100 ] ] }
};

var DEFAULT_SENSORS = [
	'cpu0-thermal', 'cpu1-thermal', 'cpu2-thermal', 'cpu3-thermal',
	'nss-top-thermal', 'nss0-thermal', 'nss1-thermal',
	'wcss-phya0-thermal', 'wcss-phya1-thermal', 'wcss-phyb0-thermal', 'wcss-phyb1-thermal',
	'ath11k_hwmon', 'ath10k_hwmon'
];

var TIME_RE = /^([01]?[0-9]|2[0-3]):[0-5][0-9]$/;

function profileLabel(id) {
	return id == 'night' ? _('Night') : _('Day');
}

function errorText(code) {
	switch (code) {
	case 'sensor_error':    return _('No temperature sensor can be read; the fan is forced to 100 %.');
	case 'profile_invalid': return _('The saved setting is invalid; its default curve is used instead.');
	case 'no_fan':          return _('The fan controller was not found; the fan speed cannot be set.');
	case 'internal':        return _('The fan service hit an internal error; the fan runs at full speed.');
	}
	return _('Fan service error: %s').format(code);
}

function esc(s) {
	return String(s).replace(/[&<>"]/g, function(c) {
		return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
	});
}

function isNum(v) {
	return typeof(v) == 'number' && isFinite(v);
}

function clamp(v, lo, hi) {
	return Math.max(lo, Math.min(hi, v));
}

function asList(v) {
	return v == null ? [] : (Array.isArray(v) ? v.slice() : [ v ]);
}

function copy(o) {
	return JSON.parse(JSON.stringify(o));
}

function padTime(v) {
	var m = /^([0-9]{1,2}):([0-9]{2})$/.exec(String(v || '').trim());
	return m ? (m[1].length < 2 ? '0' : '') + m[1] + ':' + m[2] : String(v || '');
}

/* Same maths as duty_for() in fancurve.uc: 0 below the first point. */
function dutyOf(p, t) {
	if (p.mode == 'fixed')
		return Math.round(p.fixed);
	var pts = p.points, i;
	if (t < pts[0][0])
		return 0;
	for (i = 1; i < pts.length; i++)
		if (t <= pts[i][0])
			return Math.round(pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * (t - pts[i - 1][0]) / (pts[i][0] - pts[i - 1][0]));
	return pts[pts.length - 1][1];
}

function intOr(v, dflt) {
	return /^-?[0-9]+$/.test(String(v == null ? '' : v).trim()) ? parseInt(v, 10) : dflt;
}

/* A setting as the editor uses it, read from UCI (staged changes included) over
 * the defaults. The editor always has exactly NPOINTS increasing points; a
 * stored curve that is not like that is replaced by the default curve. */
function readProfile(id) {
	var d = DEFAULTS[id], sec = uci.get('ax9000', id) || {};
	var pts = asList(sec.point).map(function(v) {
		var m = /^\s*(-?[0-9]+):([0-9]+)\s*$/.exec(v);
		return m ? [ +m[1], +m[2] ] : null;
	});
	var ok = pts.length == NPOINTS && pts.every(function(q, i) {
		return q && q[0] >= T_MIN && q[0] <= T_MAX && q[1] <= 100 && (i == 0 || q[0] > pts[i - 1][0]);
	});
	return {
		mode: sec.mode == 'fixed' ? 'fixed' : 'curve',
		fixed: clamp(intOr(sec.fixed_duty, d.fixed), 0, 100),
		hysteresis: clamp(intOr(sec.hysteresis, d.hysteresis), 0, 20),
		points: copy(ok ? pts : d.points)
	};
}

var CSS = [
	'.axf{--axf-accent:#2f7bf6;--axf-warm:#e8962b;--axf-bad:#d64545;--axf-ok:#2e9e5b;--axf-line:rgba(128,128,128,.3);--axf-card:rgba(128,128,128,.07);--axf-well:rgba(128,128,128,.1)}',
	'.axf *{box-sizing:border-box}',
	'.axf [hidden]{display:none !important}',
	'.axf-stack{display:grid;gap:1rem}',
	'.axf-grid2{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:1rem}',
	'@media (max-width:900px){.axf-grid2{grid-template-columns:1fr}}',
	'.axf-card{border:1px solid var(--axf-line);background:var(--axf-card);border-radius:.5rem;padding:1rem 1.1rem;display:grid;gap:.9rem;min-width:0}',
	'.axf-head{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:.5rem 1rem}',
	'.axf-head h3{margin:0;font-size:1.05rem;padding:0;border:0}',
	'.axf-head p{margin:.15rem 0 0;font-size:.85rem;opacity:.7}',
	'.axf-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(9rem,1fr));gap:.75rem}',
	'.axf-stat{background:var(--axf-well);border-radius:.4rem;padding:.6rem .75rem;min-width:0}',
	'.axf-stat .k{font-size:.8rem;opacity:.7}',
	'.axf-stat .v{font-size:1.5rem;font-weight:600;line-height:1.3;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}',
	'.axf-stat .s{font-size:.8rem;opacity:.7}',
	'.axf-chip{display:inline-flex;align-items:center;gap:.4rem;border-radius:1rem;padding:.15rem .7rem;font-size:.85rem;background:var(--axf-well)}',
	'.axf-chip i{width:.6rem;height:.6rem;border-radius:50%;background:var(--axf-ok)}',
	'.axf-chip.err i{background:var(--axf-bad)}',
	'.axf-alert{padding:.5rem .75rem;border-radius:.4rem;border-left:4px solid var(--axf-bad);background:rgba(214,69,69,.14)}',
	'.axf-field{display:grid;grid-template-columns:9rem minmax(0,1fr);align-items:center;gap:.5rem 1rem}',
	'.axf-field>.l{opacity:.75}',
	'@media (max-width:560px){.axf-field{grid-template-columns:1fr}}',
	'.axf-seg{justify-self:start;display:inline-flex;flex-wrap:wrap;border:1px solid var(--axf-line);border-radius:.4rem;overflow:hidden}',
	'.axf-seg button{margin:0;border:0;border-right:1px solid var(--axf-line);border-radius:0;background:transparent;color:inherit;padding:.4rem .8rem;cursor:pointer;font:inherit;line-height:1.3}',
	'.axf-seg button:last-child{border-right:0}',
	'.axf-seg button[aria-pressed=true]{background:var(--axf-accent);color:#fff}',
	'.axf-seg button[disabled]{opacity:.4;cursor:not-allowed}',
	'.axf-seg button:focus-visible{outline:2px solid var(--axf-accent);outline-offset:-2px}',
	'.axf-editor{display:grid;grid-template-columns:minmax(0,1fr) 18rem;gap:1.25rem;align-items:start}',
	'@media (max-width:980px){.axf-editor{grid-template-columns:1fr}}',
	'.axf-chart{background:var(--axf-well);border-radius:.4rem;padding:.4rem;overflow-x:auto}',
	'.axf-chart svg{display:block;width:100%;height:auto;min-width:26rem;touch-action:none;user-select:none}',
	'.axf-chart .pt{cursor:grab}',
	'.axf-chart .pt:focus{outline:none}',
	'.axf-chart .pt:focus-visible circle.h{stroke:var(--axf-warm);stroke-width:4}',
	'.axf-legend{display:flex;flex-wrap:wrap;gap:.3rem 1rem;font-size:.8rem;opacity:.8;margin-top:.4rem}',
	'.axf-legend i{display:inline-block;width:.7rem;height:.7rem;border-radius:50%;margin-right:.3rem;vertical-align:-.05rem}',
	'.axf-pts{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}',
	'.axf-pts th{font-size:.8rem;font-weight:500;text-align:left;opacity:.7;padding:.2rem .3rem}',
	'.axf-pts td{padding:.25rem .3rem;border-top:1px solid var(--axf-line)}',
	'.axf-pts td:first-child{opacity:.7;white-space:nowrap}',
	'.axf-pts input{width:5rem;min-width:0;margin:0}',
	'.axf-num{width:5rem !important;margin:0}',
	'.axf-help{font-size:.85rem;opacity:.75;margin:0}',
	'.axf-row{display:flex;flex-wrap:wrap;align-items:center;gap:.5rem}',
	'.axf-row input,.axf-row button{margin:0}',
	'.axf-slider{display:flex;align-items:center;gap:1rem;max-width:36rem}',
	'.axf-slider input[type=range]{flex:1;min-width:0}',
	'.axf-slider output{min-width:3.5rem;font-size:1.3rem;font-weight:600;text-align:right;font-variant-numeric:tabular-nums}',
	'.axf-switch{display:inline-flex;align-items:center;gap:.5rem;cursor:pointer;margin:0}',
	'.axf-switch input{position:absolute;opacity:0;width:1px;height:1px}',
	'.axf-switch .tr{position:relative;flex:none;width:2.6rem;height:1.45rem;border-radius:1rem;background:var(--axf-line);transition:background .15s}',
	'.axf-switch .tr::after{content:"";position:absolute;top:.17rem;left:.17rem;width:1.1rem;height:1.1rem;border-radius:50%;background:#fff;transition:transform .15s}',
	'.axf-switch input:checked+.tr{background:var(--axf-accent)}',
	'.axf-switch input:checked+.tr::after{transform:translateX(1.15rem)}',
	'.axf-switch input:focus-visible+.tr{outline:2px solid var(--axf-accent);outline-offset:2px}',
	'.axf-time{width:auto !important;margin:0}',
	'.axf-sensors{display:grid;grid-template-columns:repeat(auto-fill,minmax(14rem,1fr));gap:.2rem 1rem}',
	'.axf-sensors label{display:flex;align-items:center;gap:.5rem;min-width:0;margin:0;padding:.25rem 0}',
	'.axf-sensors input{margin:0;flex:none}',
	'.axf-sensors span{overflow-wrap:anywhere}',
	'.axf-sensors em{margin-left:auto;font-style:normal;opacity:.7;font-variant-numeric:tabular-nums}',
	'@media (prefers-reduced-motion:reduce){.axf *{transition:none !important}}'
].join('\n');

return view.extend({
	load: function() {
		return Promise.all([
			uci.load('ax9000'),
			L.resolveDefault(callStatus(), null)
		]);
	},

	render: function(data) {
		var self = this;

		this.status = data[1] || {};
		this.readConfig();
		this.root = E('div', { 'class': 'axf' });
		this.build();

		poll.add(function() {
			return L.resolveDefault(callStatus(), null).then(function(st) {
				self.status = st || { running: false };
				self.updateStatus();
				self.drawChart();
			});
		}, 5);

		return this.root;
	},

	/* ---------- state ---------- */

	readConfig: function() {
		var self = this;

		this.prof = {};
		PROFILES.forEach(function(id) {
			self.prof[id] = readProfile(id);
		});
		this.night = {
			enabled: uci.get('ax9000', 'fan', 'night_enabled') == '1',
			start: padTime(uci.get('ax9000', 'fan', 'night_start') || '23:00'),
			end: padTime(uci.get('ax9000', 'fan', 'night_end') || '07:00')
		};
		this.sensors = asList(uci.get('ax9000', 'fan', 'sensor'));
		if (!this.sensors.length)
			this.sensors = DEFAULT_SENSORS.slice();
		if (!this.cur || (this.cur == 'night' && !this.night.enabled))
			this.cur = 'day';
	},

	/* ---------- layout ---------- */

	build: function() {
		this.refs = {};
		var kids = [
			E('style', {}, CSS),
			E('h2', { 'name': 'content' }, _('Fan')),
			E('div', { 'class': 'cbi-map-descr' }, _('A day and a night setting, each a curve you shape yourself or a fixed speed.')),
			E('div', { 'class': 'axf-stack' }, [
				this.buildStatus(),
				this.buildControl(),
				E('div', { 'class': 'axf-grid2' }, [ this.buildNight(), this.buildSensors() ])
			])
		];
		this.root.textContent = '';
		kids.forEach(function(k) { this.root.appendChild(k); }, this);
		this.showProfile();
		this.updateStatus();
	},

	card: function(title, descr, extra, kids) {
		return E('div', { 'class': 'axf-card' }, [
			E('div', { 'class': 'axf-head' }, [
				E('div', {}, [ E('h3', {}, title), descr ? E('p', {}, descr) : '' ]),
				extra || ''
			])
		].concat(kids));
	},

	seg: function(label, items, onpick) {
		var group = E('div', { 'class': 'axf-seg', 'role': 'group', 'aria-label': label });
		var btns = {};

		items.forEach(function(it) {
			var b = E('button', {
				'type': 'button', 'aria-pressed': 'false',
				'click': function(ev) {
					ev.preventDefault();
					if (!b.disabled)
						onpick(it[0]);
				}
			}, it[1]);
			btns[it[0]] = b;
			group.appendChild(b);
		});

		group.select = function(v) {
			Object.keys(btns).forEach(function(k) { btns[k].setAttribute('aria-pressed', String(k == v)); });
		};
		group.btns = btns;
		return group;
	},

	stat: function(key, label) {
		var v = E('div', { 'class': 'v' }, '-');
		var s = E('div', { 'class': 's' }, ' ');
		this.refs[key] = { v: v, s: s };
		return E('div', { 'class': 'axf-stat' }, [ E('div', { 'class': 'k' }, label), v, s ]);
	},

	/* ---------- status ---------- */

	buildStatus: function() {
		this.refs.chip = E('span', { 'class': 'axf-chip' }, [ E('i'), E('span') ]);
		this.refs.alert = E('div', { 'class': 'axf-alert', 'role': 'alert' });
		this.refs.alert.hidden = true;

		return this.card(_('Status'), null, this.refs.chip, [
			E('div', { 'class': 'axf-stats' }, [
				this.stat('temp', _('Temperature')),
				this.stat('duty', _('Fan speed')),
				this.stat('rpm', _('Fan RPM')),
				this.stat('active', _('Active setting'))
			]),
			this.refs.alert
		]);
	},

	updateStatus: function() {
		var st = this.status || {}, r = this.refs;
		if (!r.temp)
			return;

		var running = st.running !== false;
		var act = PROFILES.indexOf(st.active) >= 0 ? st.active : 'day';

		r.temp.v.textContent = isNum(st.temp) && running ? st.temp + ' °C' : '-';
		r.temp.s.textContent = _('hottest selected sensor');
		r.duty.v.textContent = running && isNum(st.duty_applied) ? st.duty_applied + ' %' : '-';
		r.duty.s.textContent = !running ? ' '
			: st.duty_applied === 0 ? _('stopped')
			: isNum(st.duty) && st.duty != st.duty_applied ? _('curve %d %%, applied in 10 %% steps').format(st.duty)
			: ' ';
		r.rpm.v.textContent = running && isNum(st.rpm) ? String(st.rpm) : '-';
		r.rpm.s.textContent = _('revolutions per minute');
		r.active.v.textContent = profileLabel(act);
		r.active.s.textContent = st.night_enabled
			? _('night %s–%s').format(padTime(st.night_start), padTime(st.night_end))
			: _('night mode is off');

		var text, alert = null, err = false;
		if (!running) {
			text = _('Service stopped'); err = true;
			alert = _('The fan service is not running. Only the kernel failsafe controls the fan (60 % above 75 °C, 100 % above 85 °C).');
		}
		else if (st.error) {
			text = _('Error'); err = true;
			alert = errorText(st.error);
		}
		else {
			text = _('OK');
		}
		r.chip.className = 'axf-chip' + (err ? ' err' : '');
		r.chip.lastChild.textContent = text;
		r.alert.hidden = !alert;
		r.alert.textContent = alert || '';
	},

	/* ---------- day / night editor ---------- */

	buildControl: function() {
		var self = this;

		this.refs.profSeg = this.seg(_('Setting to edit'),
			PROFILES.map(function(id) { return [ id, profileLabel(id) ]; }),
			function(id) { self.cur = id; self.showProfile(); });

		this.refs.modeSeg = this.seg(_('Fan runs on'),
			[ [ 'curve', _('Curve') ], [ 'fixed', _('Fixed speed') ] ],
			function(m) { self.prof[self.cur].mode = m; self.showProfile(); });

		/* curve */
		this.refs.chart = E('div', { 'class': 'axf-chart' });
		this.refs.otherLegend = E('span');
		this.refs.tbody = E('tbody');
		this.refs.summary = E('p', { 'class': 'axf-help', 'aria-live': 'polite' });
		this.refs.hyst = E('input', {
			'class': 'cbi-input-text axf-num', 'type': 'number', 'min': '0', 'max': '20', 'step': '1',
			'id': 'axf-hyst',
			'input': function() {
				var v = parseInt(self.refs.hyst.value, 10);
				if (v >= 0 && v <= 20) {
					self.prof[self.cur].hysteresis = v;
					self.drawChart();
				}
			}
		});

		this.refs.curve = E('div', { 'class': 'axf-editor' }, [
			E('div', {}, [
				this.refs.chart,
				E('div', { 'class': 'axf-legend' }, [
					E('span', {}, [ E('i', { 'style': 'background:var(--axf-accent)' }), _('Curve') ]),
					E('span', {}, [ E('i', { 'style': 'background:none;border:2px dashed currentColor;border-radius:2px;opacity:.6' }), this.refs.otherLegend ]),
					E('span', {}, [ E('i', { 'style': 'background:var(--axf-warm)' }), _('Now') ]),
					E('span', {}, [ E('i', { 'style': 'background:var(--axf-well);border:1px solid var(--axf-line);border-radius:2px' }), _('Fan stopped') ]),
					E('span', {}, [ E('i', { 'style': 'background:var(--axf-bad)' }), _('Safety: 100 % at 85 °C') ])
				])
			]),
			E('div', { 'class': 'axf-stack', 'style': 'gap:.75rem' }, [
				E('table', { 'class': 'axf-pts' }, [
					E('thead', {}, E('tr', {}, [ E('th', {}, _('Point')), E('th', {}, _('Temp, °C')), E('th', {}, _('Speed, %')) ])),
					this.refs.tbody
				]),
				E('div', { 'class': 'axf-row' }, [ E('label', { 'for': 'axf-hyst' }, _('Hysteresis')), this.refs.hyst, '°C' ]),
				this.refs.summary,
				E('div', { 'class': 'axf-row' }, E('button', {
					'class': 'cbi-button cbi-button-neutral', 'type': 'button',
					'click': function(ev) {
						ev.preventDefault();
						var p = self.prof[self.cur];
						p.points = copy(DEFAULTS[self.cur].points);
						p.hysteresis = DEFAULTS[self.cur].hysteresis;
						self.showProfile();
					}
				}, _('Restore default curve')))
			])
		]);

		/* fixed */
		this.refs.fixedOut = E('output', {}, '');
		this.refs.fixed = E('input', {
			'type': 'range', 'min': '0', 'max': '100', 'step': '1', 'aria-label': _('Fixed fan speed'),
			'input': function() {
				self.prof[self.cur].fixed = Number(self.refs.fixed.value);
				self.refs.fixedOut.textContent = self.refs.fixed.value + ' %';
			}
		});
		this.refs.fixedBox = E('div', { 'class': 'axf-stack', 'style': 'gap:.4rem' }, [
			E('div', { 'class': 'axf-slider' }, [ this.refs.fixed, this.refs.fixedOut ]),
			E('p', { 'class': 'axf-help' }, _('Applied in 10 % steps. 0 % stops the fan. Safety limits still apply: 100 % at 85 °C, and the kernel failsafe keeps at least 60 % above 75 °C.'))
		]);

		this.bindChart();

		return this.card(_('Fan control'),
			_('Pick the setting to edit. Drag the points on the chart or type the values; temperatures rise from left to right.'),
			this.refs.profSeg, [
				E('div', { 'class': 'axf-field' }, [ E('span', { 'class': 'l' }, _('Fan runs on')), this.refs.modeSeg ]),
				this.refs.curve,
				this.refs.fixedBox
			]);
	},

	showProfile: function() {
		var p = this.prof[this.cur], r = this.refs;

		r.profSeg.select(this.cur);
		r.profSeg.btns.night.disabled = !this.night.enabled;
		r.profSeg.btns.night.textContent = _('Night') + ' · ' + this.night.start + '–' + this.night.end;
		r.profSeg.btns.night.title = this.night.enabled ? '' : _('Turn on night mode below to use a night setting.');
		r.modeSeg.select(p.mode);
		r.curve.hidden = p.mode != 'curve';
		r.fixedBox.hidden = p.mode != 'fixed';
		r.fixed.value = String(p.fixed);
		r.fixedOut.textContent = p.fixed + ' %';
		r.hyst.value = String(p.hysteresis);
		this.drawTable(true);
		this.drawChart();
	},

	/* Move point i, keeping temperatures strictly increasing inside 0..100 °C. */
	setPoint: function(i, t, d) {
		var pts = this.prof[this.cur].points;
		var lo = i > 0 ? pts[i - 1][0] + 1 : T_MIN;
		var hi = i < pts.length - 1 ? pts[i + 1][0] - 1 : T_MAX;
		if (isNum(t))
			pts[i][0] = clamp(Math.round(t), lo, hi);
		if (isNum(d))
			pts[i][1] = clamp(Math.round(d), 0, 100);
	},

	geom: { W: 640, H: 320, L: 48, R: 16, T: 16, B: 42 },

	X: function(t) { var g = this.geom; return g.L + (t - T_MIN) / (T_MAX - T_MIN) * (g.W - g.L - g.R); },
	Y: function(d) { var g = this.geom; return g.T + (1 - d / 100) * (g.H - g.T - g.B); },

	bindChart: function() {
		var self = this, chart = this.refs.chart, drag = null;

		var toData = function(ev) {
			var svg = chart.querySelector('svg'), g = self.geom;
			var r = svg.getBoundingClientRect(), k = g.W / r.width;
			var px = (ev.clientX - r.left) * k, py = (ev.clientY - r.top) * k;
			return [
				T_MIN + (px - g.L) / (g.W - g.L - g.R) * (T_MAX - T_MIN),
				(1 - (py - g.T) / (g.H - g.T - g.B)) * 100
			];
		};

		chart.addEventListener('pointerdown', function(ev) {
			var pt = ev.target.closest && ev.target.closest('.pt');
			if (!pt)
				return;
			ev.preventDefault();
			drag = +pt.getAttribute('data-i');
			chart.setPointerCapture(ev.pointerId);
		});
		chart.addEventListener('pointermove', function(ev) {
			if (drag == null)
				return;
			var v = toData(ev);
			/* speeds snap to 5 % while dragging; type exact values in the table */
			self.setPoint(drag, v[0], Math.round(v[1] / 5) * 5);
			self.drawChart();
			self.drawTable(false);
		});
		var end = function() { drag = null; };
		chart.addEventListener('pointerup', end);
		chart.addEventListener('pointercancel', end);

		chart.addEventListener('keydown', function(ev) {
			var pt = ev.target.closest && ev.target.closest('.pt');
			if (!pt)
				return;
			var i = +pt.getAttribute('data-i'), p = self.prof[self.cur].points[i];
			switch (ev.key) {
			case 'ArrowLeft':  self.setPoint(i, p[0] - 1, null); break;
			case 'ArrowRight': self.setPoint(i, p[0] + 1, null); break;
			case 'ArrowUp':    self.setPoint(i, null, p[1] + 5); break;
			case 'ArrowDown':  self.setPoint(i, null, p[1] - 5); break;
			default: return;
			}
			ev.preventDefault();
			self.drawChart();
			self.drawTable(false);
			var again = chart.querySelector('.pt[data-i="' + i + '"]');
			if (again)
				again.focus();
		});
	},

	drawTable: function(force) {
		var self = this, tb = this.refs.tbody, pts = this.prof[this.cur].points;

		/* typing in a field must not lose focus: update values in place */
		if (!force && tb.rows.length == pts.length) {
			pts.forEach(function(p, i) {
				var ins = tb.rows[i].querySelectorAll('input');
				if (document.activeElement !== ins[0]) ins[0].value = p[0];
				if (document.activeElement !== ins[1]) ins[1].value = p[1];
			});
			return;
		}

		tb.textContent = '';
		pts.forEach(function(p, i) {
			var mk = function(k, label) {
				var inp = E('input', {
					'class': 'cbi-input-text', 'type': 'number', 'step': '1', 'inputmode': 'numeric',
					'min': k ? '0' : String(T_MIN), 'max': k ? '100' : String(T_MAX),
					'value': String(p[k]), 'aria-label': label,
					'change': function() {
						var v = parseInt(inp.value, 10);
						if (!isNaN(v))
							self.setPoint(i, k ? null : v, k ? v : null);
						inp.value = self.prof[self.cur].points[i][k];
						self.drawChart();
					}
				});
				return inp;
			};
			tb.appendChild(E('tr', {}, [
				E('td', {}, i == 0 ? _('%d · start').format(i + 1) : String(i + 1)),
				E('td', {}, mk(0, _('Point %d temperature').format(i + 1))),
				E('td', {}, mk(1, _('Point %d speed').format(i + 1)))
			]));
		});
	},

	drawChart: function() {
		if (!this.refs || !this.refs.chart || !this.prof)
			return;

		var self = this, g = this.geom, st = this.status || {};
		var p = this.prof[this.cur], pts = p.points;
		var other = this.cur == 'day' ? 'night' : 'day', o = this.prof[other];
		var X = function(t) { return self.X(t).toFixed(1); }, Y = function(d) { return self.Y(d).toFixed(1); };
		var grid = 'stroke="currentColor" stroke-opacity=".12"';
		var txt = 'fill="currentColor" fill-opacity=".7" font-size="12"';
		var s = '', i, t;

		var poly = function(q) {
			return [ [ T_MIN, 0 ], [ q[0][0], 0 ] ].concat(q, [ [ T_MAX, q[q.length - 1][1] ] ])
				.map(function(x) { return X(x[0]) + ',' + Y(x[1]); }).join(' ');
		};

		for (i = 0; i <= 100; i += 25)
			s += '<line x1="' + g.L + '" x2="' + (g.W - g.R) + '" y1="' + Y(i) + '" y2="' + Y(i) + '" ' + grid + '/>' +
				'<text x="' + (g.L - 8) + '" y="' + (self.Y(i) + 4) + '" text-anchor="end" ' + txt + '>' + i + '</text>';
		for (t = T_MIN; t <= T_MAX; t += 10)
			s += '<line x1="' + X(t) + '" x2="' + X(t) + '" y1="' + g.T + '" y2="' + (g.H - g.B) + '" ' + grid + '/>' +
				'<text x="' + X(t) + '" y="' + (g.H - g.B + 18) + '" text-anchor="middle" ' + txt + '>' + t + '</text>';
		s += '<text x="' + ((g.L + g.W - g.R) / 2) + '" y="' + (g.H - 6) + '" text-anchor="middle" ' + txt + '>' + esc(_('Temperature, °C')) + '</text>';
		s += '<text transform="translate(14 ' + ((g.T + g.H - g.B) / 2) + ') rotate(-90)" text-anchor="middle" ' + txt + '>' + esc(_('Fan speed, %')) + '</text>';

		/* stopped zone left of the first point */
		var zw = self.X(pts[0][0]) - g.L;
		s += '<rect x="' + g.L + '" y="' + g.T + '" width="' + zw.toFixed(1) + '" height="' + (g.H - g.T - g.B) + '" fill="currentColor" fill-opacity=".05"/>';
		if (zw > 80)
			s += '<text x="' + (g.L + zw / 2).toFixed(1) + '" y="' + (g.T + 18) + '" text-anchor="middle" ' + txt + '>' + esc(_('Fan stopped')) + '</text>';

		/* safety floor */
		s += '<line x1="' + X(SAFETY_TEMP) + '" x2="' + X(SAFETY_TEMP) + '" y1="' + g.T + '" y2="' + (g.H - g.B) + '" stroke="var(--axf-bad)" stroke-width="1.5" stroke-dasharray="5 4"/>';

		/* the other setting, dashed */
		if (other != 'night' || this.night.enabled) {
			var op = o.mode == 'fixed' ? X(T_MIN) + ',' + Y(o.fixed) + ' ' + X(T_MAX) + ',' + Y(o.fixed) : poly(o.points);
			s += '<polyline points="' + op + '" fill="none" stroke="currentColor" stroke-opacity=".45" stroke-width="2" stroke-dasharray="6 5"/>';
			this.refs.otherLegend.textContent = _('%s, for comparison').format(profileLabel(other));
			this.refs.otherLegend.parentNode.hidden = false;
		}
		else {
			this.refs.otherLegend.parentNode.hidden = true;
		}

		/* this setting */
		var path = poly(pts);
		s += '<polygon points="' + X(T_MIN) + ',' + Y(0) + ' ' + path + ' ' + X(T_MAX) + ',' + Y(0) + '" fill="var(--axf-accent)" fill-opacity=".14"/>' +
			'<polyline points="' + path + '" fill="none" stroke="var(--axf-accent)" stroke-width="3" stroke-linejoin="round"/>';

		/* current temperature on this curve */
		if (isNum(st.temp) && st.running !== false && st.temp >= T_MIN && st.temp <= T_MAX) {
			var nd = dutyOf(p, st.temp);
			s += '<line x1="' + X(st.temp) + '" x2="' + X(st.temp) + '" y1="' + g.T + '" y2="' + (g.H - g.B) + '" stroke="var(--axf-warm)" stroke-opacity=".5"/>' +
				'<circle cx="' + X(st.temp) + '" cy="' + Y(nd) + '" r="6" fill="var(--axf-warm)"/>' +
				'<text x="' + (self.X(st.temp) + (st.temp > 80 ? -6 : 6)).toFixed(1) + '" y="' + (g.H - g.B - 6) + '" text-anchor="' + (st.temp > 80 ? 'end' : 'start') + '" font-size="12" fill="var(--axf-warm)">' +
				esc(st.temp + ' °C · ' + nd + ' %') + '</text>';
		}

		/* handles */
		pts.forEach(function(q, i) {
			var anchor = q[0] < 8 ? 'start' : (q[0] > 92 ? 'end' : 'middle');
			var ly = q[1] > 85 ? self.Y(q[1]) + 24 : self.Y(q[1]) - 14;
			s += '<g class="pt" data-i="' + i + '" tabindex="0" role="slider" aria-valuetext="' +
				esc(_('%d °C, %d %%').format(q[0], q[1])) + '" aria-label="' + esc(_('Point %d').format(i + 1)) + '">' +
				'<circle cx="' + X(q[0]) + '" cy="' + Y(q[1]) + '" r="16" fill="transparent"/>' +
				'<circle class="h" cx="' + X(q[0]) + '" cy="' + Y(q[1]) + '" r="8" fill="var(--axf-accent)" stroke="#fff" stroke-width="2.5"/>' +
				'<text x="' + X(q[0]) + '" y="' + ly.toFixed(1) + '" text-anchor="' + anchor + '" font-size="11" fill="currentColor">' + q[0] + '°/' + q[1] + '%</text></g>';
		});

		this.refs.chart.innerHTML = '<svg viewBox="0 0 ' + g.W + ' ' + g.H + '" role="group" aria-label="' +
			esc(_('Fan speed against temperature, %s setting').format(profileLabel(this.cur))) + '">' + s + '</svg>';

		var off = pts[0][0] - p.hysteresis;
		this.refs.summary.textContent = _('%s: the fan is off below %d °C and stops again under %d °C. It starts at %d %% and reaches %d %% at %d °C.')
			.format(profileLabel(this.cur), pts[0][0], off, pts[0][1], pts[pts.length - 1][1], pts[pts.length - 1][0]);
	},

	/* ---------- night ---------- */

	buildNight: function() {
		var self = this, n = this.night;

		var sw = E('input', { 'type': 'checkbox', 'id': 'axf-night' });
		sw.checked = n.enabled;
		var start = E('input', { 'class': 'cbi-input-text axf-time', 'type': 'time', 'value': n.start, 'aria-label': _('Night starts') });
		var end = E('input', { 'class': 'cbi-input-text axf-time', 'type': 'time', 'value': n.end, 'aria-label': _('Night ends') });
		var body = E('div', { 'class': 'axf-field' }, [
			E('span', { 'class': 'l' }, _('Hours')),
			E('div', { 'class': 'axf-row' }, [ start, '–', end ])
		]);
		body.hidden = !n.enabled;
		this.refs.nightStart = start;
		this.refs.nightEnd = end;

		var sync = function() {
			n.enabled = sw.checked;
			if (TIME_RE.test(start.value)) n.start = padTime(start.value);
			if (TIME_RE.test(end.value)) n.end = padTime(end.value);
			body.hidden = !n.enabled;
			if (!n.enabled && self.cur == 'night')
				self.cur = 'day';
			self.showProfile();
		};
		sw.addEventListener('change', sync);
		start.addEventListener('change', sync);
		end.addEventListener('change', sync);

		return this.card(_('Night mode'), _('Use the Night setting during these hours. When it is off, the Day setting runs around the clock.'),
			E('label', { 'class': 'axf-switch' }, [ sw, E('span', { 'class': 'tr' }), E('span', {}, _('On')) ]),
			[ body ]);
	},

	/* ---------- sensors ---------- */

	buildSensors: function() {
		var self = this;
		var live = {}, ids = [], kinds = {};
		var grid = E('div', { 'class': 'axf-sensors' });

		asList((this.status || {}).sensors).forEach(function(s) { live[s.id] = s; });
		/* plain hwmon names ("ath11k_hwmon") select every sensor of that kind;
		 * show the individual "name:phy" rows instead when the device reports them */
		Object.keys(live).forEach(function(id) {
			if (id.indexOf(':') > 0)
				kinds[id.split(':')[0]] = true;
		});
		[].concat(DEFAULT_SENSORS, Object.keys(live), this.sensors).forEach(function(id) {
			if (!kinds[id] && ids.indexOf(id) < 0)
				ids.push(id);
		});

		this.refs.sensorBoxes = {};
		ids.forEach(function(id) {
			var s = live[id];
			var cb = E('input', { 'type': 'checkbox', 'id': 'axf-sn-' + id.replace(/[^A-Za-z0-9_-]/g, '_') });
			cb.checked = self.sensors.indexOf(id) >= 0 ||
				(id.indexOf(':') > 0 && self.sensors.indexOf(id.split(':')[0]) >= 0);
			self.refs.sensorBoxes[id] = cb;
			grid.appendChild(E('label', {}, [
				cb,
				E('span', {}, (s && s.label) || id),
				s && isNum(s.temp) ? E('em', {}, s.temp + ' °C') : ''
			]));
		});

		return this.card(_('Temperature sensors'), _('The fan follows the hottest selected sensor. Sensors that cannot be read are ignored.'), null, [ grid ]);
	},

	/* ---------- save ---------- */

	stage: function() {
		var self = this, n = this.night;
		var boxes = this.refs.sensorBoxes;
		var sel = Object.keys(boxes).filter(function(id) { return boxes[id].checked; });

		if (!sel.length)
			throw new Error(_('Select at least one temperature sensor.'));
		if (n.enabled && (!TIME_RE.test(this.refs.nightStart.value) || !TIME_RE.test(this.refs.nightEnd.value)))
			throw new Error(_('Enter the night start and end as HH:MM.'));
		if (n.enabled && n.start == n.end)
			throw new Error(_('Night start and end must differ.'));

		var set = function(sid, opt, val) {
			if (JSON.stringify(uci.get('ax9000', sid, opt)) !== JSON.stringify(val))
				uci.set('ax9000', sid, opt, val);
		};

		set('fan', 'night_enabled', n.enabled ? '1' : '0');
		set('fan', 'night_start', n.start);
		set('fan', 'night_end', n.end);
		set('fan', 'sensor', sel);

		PROFILES.forEach(function(id) {
			var p = self.prof[id];
			if (!uci.get('ax9000', id))
				uci.add('ax9000', 'fan_profile', id);
			set(id, 'mode', p.mode);
			set(id, 'fixed_duty', String(p.fixed));
			set(id, 'hysteresis', String(p.hysteresis));
			set(id, 'point', p.points.map(function(q) { return q[0] + ':' + q[1]; }));
		});
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
		uci.unload('ax9000');
		return uci.load('ax9000').then(function() {
			self.readConfig();
			self.build();
		});
	}
});
