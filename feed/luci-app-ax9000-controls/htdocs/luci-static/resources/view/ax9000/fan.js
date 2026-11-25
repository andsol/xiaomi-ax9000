'use strict';
'require view';
'require rpc';
'require uci';
'require poll';
'require ui';

var callStatus = rpc.declare({ object: 'ax9000.fan', method: 'status' });
var callProfiles = rpc.declare({ object: 'ax9000.fan', method: 'profiles' });
var callReset = rpc.declare({ object: 'ax9000.fan', method: 'reset_profile', params: [ 'name' ] });
var callCommit = rpc.declare({ object: 'uci', method: 'commit', params: [ 'config' ] });

var MODE_IDS = [ 'silent', 'balanced', 'aggressive', 'custom', 'manual' ];
var BUILTIN_IDS = [ 'silent', 'balanced', 'aggressive' ];
var DEFAULT_SENSORS = [
	'cpu0-thermal', 'cpu1-thermal', 'cpu2-thermal', 'cpu3-thermal',
	'nss-top-thermal', 'nss0-thermal', 'nss1-thermal',
	'wcss-phya0-thermal', 'wcss-phya1-thermal', 'wcss-phyb0-thermal', 'wcss-phyb1-thermal',
	'ath11k_hwmon', 'ath10k_hwmon'
];

function modeInfo(id) {
	switch (id) {
	case 'silent':     return { label: _('Silent'),     hint: _('Quietest, runs warmer') };
	case 'balanced':   return { label: _('Balanced'),   hint: _('Recommended default') };
	case 'aggressive': return { label: _('Aggressive'), hint: _('Coolest, louder') };
	case 'custom':     return { label: _('Custom'),     hint: _('Your own curve') };
	case 'manual':     return { label: _('Manual'),     hint: _('Fixed fan speed') };
	}
	return { label: id || '-', hint: '' };
}

function errorText(code) {
	switch (code) {
	case 'sensor_error':    return _('No temperature sensor can be read; the fan is forced to 100 %.');
	case 'profile_invalid': return _('The selected fan curve is invalid; the Balanced curve is used instead.');
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

function parseNum(s) {
	s = String(s == null ? '' : s).trim();
	return /^-?[0-9]+(\.[0-9]+)?$/.test(s) ? Number(s) : null;
}

/* Point fields use the service's parse_point(): whole numbers only. */
function parseInteger(s) {
	s = String(s == null ? '' : s).trim();
	return /^-?[0-9]+$/.test(s) ? Number(s) : null;
}

function padTime(v) {
	var m = /^([0-9]{1,2}):([0-9]{2})$/.exec(String(v || '').trim());
	return m ? (m[1].length < 2 ? '0' : '') + m[1] + ':' + m[2] : String(v || '');
}

/*
 * Mirrors validate() in /usr/share/ax9000/fancurve.uc, same checks in the same
 * order. `pts` is [{ t: '60', d: 'min' | '35' }] (raw field text).
 * Returns null when valid, else { msg, row } (row = offending index or -1).
 */
function validateCurve(pts, minDuty, hyst) {
	if (pts.length < 2)
		return { msg: _('At least 2 points are required.'), row: -1 };

	var md = parseNum(minDuty);
	if (md == null || md < 0 || md > 100)
		return { msg: _('Minimum duty must be a number between 0 and 100.'), row: -1 };

	var hy = parseNum(hyst);
	if (hy == null || hy < 0)
		return { msg: _('Hysteresis must be a non-negative number.'), row: -1 };

	var i, t, d, nums = [];
	for (i = 0; i < pts.length; i++) {
		t = parseInteger(pts[i].t);
		d = String(pts[i].d).trim() == 'min' ? 'min' : parseInteger(pts[i].d);
		if ((t == null && parseNum(pts[i].t) != null) || (d == null && d !== 'min' && parseNum(pts[i].d) != null))
			return { msg: _('Use whole numbers.'), row: i };
		if (t == null || d == null)
			return { msg: _('Every point needs a numeric temperature and a duty (a number or "min").'), row: i };
		nums.push([ t, d ]);
	}

	for (i = 1; i < nums.length; i++)
		if (nums[i][0] <= nums[i - 1][0])
			return { msg: _('Temperatures must be strictly increasing.'), row: i };

	for (i = 0; i < nums.length; i++)
		if (nums[i][1] != 'min' && (nums[i][1] < 0 || nums[i][1] > 100))
			return { msg: _('Duty must be between 0 and 100 %.'), row: i };

	return null;
}

function toDraft(profile) {
	profile = profile || {};
	return {
		points: (profile.points || []).map(function(p) {
			return { t: String(p[0]), d: String(p[1]) };
		}),
		min_duty: String(profile.min_duty != null ? profile.min_duty : 20),
		hysteresis: String(profile.hysteresis != null ? profile.hysteresis : 3)
	};
}

/* A raw draft as a chart/profile object; null when it does not validate. */
function draftProfile(dr) {
	if (validateCurve(dr.points, dr.min_duty, dr.hysteresis))
		return null;
	return {
		min_duty: Number(dr.min_duty),
		hysteresis: Number(dr.hysteresis),
		points: dr.points.map(function(p) {
			var d = String(p.d).trim();
			return [ Number(p.t), d == 'min' ? 'min' : Number(d) ];
		})
	};
}

function serializePoint(p) {
	var d = String(p.d).trim();
	return Number(p.t) + ':' + (d == 'min' ? 'min' : Number(d));
}

function asList(v) {
	return v == null ? [] : (Array.isArray(v) ? v.slice() : [ v ]);
}

var CSS = [
	'.axf{--axf-accent:#2f7bf6;--axf-warm:#f08a1c;--axf-bad:#d64545;--axf-ok:#2e9e5b;--axf-line:rgba(128,128,128,.35);--axf-card:rgba(128,128,128,.08);max-width:62rem}',
	'.axf *{box-sizing:border-box}',
	'.axf-card{border:1px solid var(--axf-line);background:var(--axf-card);border-radius:.6rem;padding:1rem;margin:0 0 1rem}',
	'.axf-card>h3{margin:0 0 .75rem;font-size:1.05rem}',
	'.axf-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(8.5rem,1fr));gap:.75rem}',
	'.axf-stat{min-width:0}',
	'.axf-stat .k{font-size:.8rem;opacity:.7}',
	'.axf-stat .v{font-size:1.5rem;font-weight:600;line-height:1.3;overflow-wrap:anywhere}',
	'.axf-stat .s{font-size:.8rem;opacity:.75}',
	'.axf-badge{display:inline-block;border-radius:1rem;padding:.15rem .7rem;font-size:.85rem;font-weight:600;color:#fff;background:var(--axf-ok)}',
	'.axf-badge.err{background:var(--axf-bad)}',
	'.axf-badge.warn{background:var(--axf-warm)}',
	'.axf-alert{margin:.75rem 0 0;padding:.5rem .75rem;border-radius:.4rem;border-left:4px solid var(--axf-bad);background:rgba(214,69,69,.14)}',
	'.axf-modes{display:grid;grid-template-columns:repeat(auto-fit,minmax(7.5rem,1fr));gap:.6rem}',
	'.axf-mode{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:.2rem;min-height:4.5rem;padding:.6rem .4rem;margin:0;border-radius:.6rem;border:2px solid var(--axf-line);background:transparent;color:inherit;cursor:pointer;font:inherit;text-align:center;transition:background .15s,border-color .15s,transform .1s}',
	'.axf-mode:hover{border-color:var(--axf-accent)}',
	'.axf-mode:active{transform:scale(.97)}',
	'.axf-mode:focus-visible{outline:3px solid var(--axf-accent);outline-offset:2px}',
	'.axf-mode b{font-size:1.05rem}',
	'.axf-mode small{font-size:.75rem;opacity:.75}',
	'.axf-mode[aria-checked=true]{background:var(--axf-accent);border-color:var(--axf-accent);color:#fff}',
	'.axf-mode[aria-checked=true] small{opacity:.9}',
	'.axf-mode[disabled]{opacity:.6;cursor:progress}',
	'.axf-muted{margin:0 0 .6rem;font-size:.85rem;opacity:.7}',
	'.axf-note{min-height:1.3rem;margin:.6rem 0 0;font-size:.9rem}',
	'.axf-note.ok{color:var(--axf-ok)}',
	'.axf-note.bad{color:var(--axf-bad)}',
	'.axf-chart svg{display:block;width:100%;height:auto;max-height:22rem}',
	'.axf-legend{display:flex;flex-wrap:wrap;gap:.4rem 1.2rem;margin-top:.5rem;font-size:.85rem}',
	'.axf-legend i{display:inline-block;width:.8rem;height:.8rem;margin-right:.3rem;border-radius:50%;vertical-align:-.1rem}',
	'.axf-slider{display:flex;align-items:center;gap:1rem}',
	'.axf-slider input[type=range]{flex:1;min-width:0;height:2rem}',
	'.axf-slider output{min-width:3.5rem;font-size:1.4rem;font-weight:600;text-align:right}',
	'.axf-pts{width:100%;border-collapse:collapse}',
	'.axf-pts th{font-size:.8rem;font-weight:600;text-align:left;opacity:.75;padding:.2rem .3rem}',
	'.axf-pts td{padding:.25rem .3rem}',
	'.axf-pts input{width:100%;min-width:0;margin:0}',
	'.axf-pts tr.bad input{border-color:var(--axf-bad);box-shadow:0 0 0 1px var(--axf-bad)}',
	'.axf-row{display:flex;flex-wrap:wrap;gap:.75rem 1.5rem;margin:.75rem 0}',
	'.axf-row label{display:flex;flex-direction:column;gap:.2rem;font-size:.85rem}',
	'.axf-row input{width:7rem;margin:0}',
	'.axf-actions{display:flex;flex-wrap:wrap;gap:.5rem;margin-top:.75rem}',
	'.axf-actions button{margin:0}',
	'.axf-sensors{display:grid;grid-template-columns:repeat(auto-fill,minmax(13rem,1fr));gap:.4rem .75rem}',
	'.axf-sensors label{display:flex;align-items:center;gap:.5rem;min-width:0;margin:0;padding:.3rem 0}',
	'.axf-sensors input{margin:0;flex:none}',
	'.axf-sensors span{overflow-wrap:anywhere}',
	'.axf-sensors em{opacity:.7;font-style:normal;margin-left:.3rem}',
	'.axf-sched{display:flex;flex-wrap:wrap;align-items:center;gap:.5rem;margin:.4rem 0}',
	'.axf-sched input,.axf-sched select{margin:0;width:auto;min-width:0}',
	'.axf-sched .sep{opacity:.7}',
	'.axf-switch{display:inline-flex;align-items:center;gap:.6rem;cursor:pointer;margin:0 0 .75rem}',
	'.axf-switch input{position:absolute;opacity:0;width:1px;height:1px}',
	'.axf-switch .tr{position:relative;flex:none;width:2.8rem;height:1.5rem;border-radius:1rem;background:var(--axf-line);transition:background .15s}',
	'.axf-switch .tr::after{content:"";position:absolute;top:.15rem;left:.15rem;width:1.2rem;height:1.2rem;border-radius:50%;background:#fff;transition:transform .15s}',
	'.axf-switch input:checked+.tr{background:var(--axf-accent)}',
	'.axf-switch input:checked+.tr::after{transform:translateX(1.3rem)}',
	'.axf-switch input:focus-visible+.tr{outline:3px solid var(--axf-accent);outline-offset:2px}',
	'.axf-help{font-size:.85rem;opacity:.8;margin:.5rem 0 0}',
	'.axf-resets{display:flex;flex-wrap:wrap;gap:.5rem}',
	'.axf-resets button{margin:0}',
	'@media (max-width:480px){.axf-card{padding:.75rem}.axf-stat .v{font-size:1.3rem}.axf-actions button{flex:1 1 auto}}'
].join('\n');

return view.extend({
	load: function() {
		return Promise.all([
			uci.load('ax9000'),
			callStatus().catch(function() { return null; }),
			callProfiles().catch(function() { return null; })
		]);
	},

	render: function(data) {
		var self = this;

		this.status = data[1] || {};
		this.profiles = (data[2] && data[2].profiles) || {};
		this.readConfig();
		this.root = E('div', { 'class': 'axf' });
		this.build();

		poll.add(function() {
			return callStatus().then(function(st) {
				self.status = st || {};
				self.updateStatus();
				self.drawChart();
			}).catch(function() {});
		}, 5);

		return this.root;
	},

	/* ---------- state ---------- */

	readConfig: function() {
		var m = uci.get('ax9000', 'fan', 'mode');
		var md = parseInt(uci.get('ax9000', 'fan', 'manual_duty'), 10);

		this.mode = MODE_IDS.indexOf(m) >= 0 ? m : 'balanced';
		this.manual = isNaN(md) ? 50 : Math.max(0, Math.min(100, md));
		this.sensors = asList(uci.get('ax9000', 'fan', 'sensor'));
		if (!this.sensors.length)
			this.sensors = DEFAULT_SENSORS.slice();
		this.schedEnabled = uci.get('ax9000', 'fan', 'schedule_enabled') == '1';
		this.schedule = uci.sections('ax9000', 'fan_schedule').map(function(s) {
			return { start: padTime(s.start), end: padTime(s.end), mode: s.mode || 'balanced' };
		});
		this.draft = toDraft(this.profiles.custom);
	},

	/* Write UCI changes to the flash and let rpcd/procd notify the service. */
	persist: function() {
		return uci.save().then(function() {
			return callCommit('ax9000');
		}).then(function() {
			uci.unload('ax9000');
			return uci.load('ax9000');
		});
	},

	flash: function(node, text, kind) {
		node.textContent = text;
		node.className = 'axf-note' + (kind ? ' ' + kind : '');
		clearTimeout(node._t);
		if (kind == 'ok')
			node._t = setTimeout(function() { node.textContent = ''; }, 5000);
	},

	reload: function() {
		var self = this;

		return Promise.all([ uci.load('ax9000'), callProfiles() ]).then(function(r) {
			self.profiles = (r[1] && r[1].profiles) || {};
			self.readConfig();
			self.build();
		});
	},

	/* ---------- layout ---------- */

	build: function() {
		this.refs = {};
		var kids = [
			E('style', {}, CSS),
			this.buildStatus(),
			this.buildModes(),
			this.buildChart(),
			this.buildManual(),
			this.buildCustom(),
			this.buildResets(),
			this.buildSensors(),
			this.buildSchedule()
		];
		this.root.textContent = '';
		kids.forEach(function(k) { this.root.appendChild(k); }, this);
		this.updateStatus();
		this.drawChart();
		this.updateManualVisibility();
	},

	card: function(title, kids) {
		return E('div', { 'class': 'axf-card' }, [ E('h3', {}, title) ].concat(kids));
	},

	stat: function(key, label) {
		var v = E('div', { 'class': 'v' }, '-');
		var s = E('div', { 'class': 's' });
		this.refs[key] = { v: v, s: s };
		return E('div', { 'class': 'axf-stat' }, [ E('div', { 'class': 'k' }, label), v, s ]);
	},

	buildStatus: function() {
		this.refs.badge = E('span', { 'class': 'axf-badge' });
		this.refs.alert = E('div', { 'class': 'axf-alert', 'role': 'alert' });
		this.refs.alert.hidden = true;

		return this.card(_('Status'), [
			E('div', { 'class': 'axf-stats' }, [
				this.stat('temp', _('Temperature')),
				this.stat('duty', _('Fan speed')),
				this.stat('rpm', _('Fan RPM')),
				this.stat('active', _('Active mode')),
				E('div', { 'class': 'axf-stat' }, [
					E('div', { 'class': 'k' }, _('State')),
					E('div', { 'class': 'v' }, this.refs.badge)
				])
			]),
			this.refs.alert
		]);
	},

	updateStatus: function() {
		var st = this.status || {}, r = this.refs;
		if (!r.temp)
			return;

		var pct = function(v) { return v == null ? '-' : v + ' %'; };
		var running = st.running !== false;

		r.temp.v.textContent = st.temp == null || !running ? '-' : st.temp + ' °C';
		r.temp.s.textContent = _('hottest selected sensor');
		r.duty.v.textContent = running ? pct(st.duty_applied) : '-';
		r.duty.s.textContent = running ? _('curve %s, applied %s').format(pct(st.duty), pct(st.duty_applied)) : '';
		r.rpm.v.textContent = st.rpm == null || !running ? '-' : String(st.rpm);
		r.rpm.s.textContent = _('revolutions per minute');

		var am = st.active_mode || this.mode;
		r.active.v.textContent = modeInfo(am).label;
		r.active.s.textContent = am != this.mode
			? _('schedule override (set: %s)').format(modeInfo(this.mode).label) : '';

		var text, cls = 'axf-badge', alert = null;
		if (!running) {
			text = _('Service stopped'); cls += ' err';
			alert = _('The fan service is not running. Only the kernel failsafe controls the fan (60 % above 75 °C, 100 % above 85 °C).');
		}
		else if (st.error) {
			text = _('Error'); cls += ' err';
			alert = errorText(st.error);
		}
		else {
			text = _('OK');
		}
		r.badge.className = cls;
		r.badge.textContent = text;
		r.alert.hidden = !alert;
		r.alert.textContent = alert || '';
	},

	buildModes: function() {
		var self = this, group = E('div', { 'class': 'axf-modes', 'role': 'radiogroup', 'aria-label': _('Fan mode') });

		this.refs.modeBtns = {};
		this.refs.modeNote = E('div', { 'class': 'axf-note', 'role': 'status', 'aria-live': 'polite' });

		MODE_IDS.forEach(function(id) {
			var info = modeInfo(id);
			var b = E('button', {
				'class': 'axf-mode', 'type': 'button', 'role': 'radio',
				'aria-checked': String(id == self.mode),
				'click': function() { self.setMode(id); }
			}, [ E('b', {}, info.label), E('small', {}, info.hint) ]);
			self.refs.modeBtns[id] = b;
			group.appendChild(b);
		});

		return this.card(_('Mode'), [
			E('p', { 'class': 'axf-muted' }, _('Mode changes are saved immediately.')),
			group, this.refs.modeNote
		]);
	},

	setMode: function(id) {
		var self = this, prev = this.mode, note = this.refs.modeNote;

		if (id == prev)
			return;

		this.mode = id;
		this.markMode(true);
		this.updateManualVisibility();
		this.updateStatus();
		this.drawChart();
		this.flash(note, _('Saving...'));
		uci.set('ax9000', 'fan', 'mode', id);

		this.persist().then(function() {
			self.markMode(false);
			self.flash(note, _('Saved. %s mode applies within a few seconds.').format(modeInfo(id).label), 'ok');
		}).catch(function(e) {
			self.mode = prev;
			uci.set('ax9000', 'fan', 'mode', prev);
			self.markMode(false);
			self.updateManualVisibility();
			self.updateStatus();
			self.drawChart();
			self.flash(note, _('Could not save the mode: %s').format(e && e.message || e), 'bad');
		});
	},

	markMode: function(busy) {
		var self = this;
		MODE_IDS.forEach(function(id) {
			var b = self.refs.modeBtns[id];
			b.setAttribute('aria-checked', String(id == self.mode));
			b.disabled = !!busy;
		});
	},

	/* ---------- chart ---------- */

	buildChart: function() {
		this.refs.chart = E('div', { 'class': 'axf-chart' });
		return this.card(_('Fan curve'), [
			this.refs.chart,
			E('div', { 'class': 'axf-legend' }, [
				E('span', {}, [ E('i', { 'style': 'background:var(--axf-accent)' }), _('Curve') ]),
				E('span', {}, [ E('i', { 'style': 'background:var(--axf-warm)' }), _('Now (curve)') ]),
				E('span', {}, [ E('i', { 'style': 'border:2px solid var(--axf-warm)' }), _('Now (applied, 10 % steps)') ])
			])
		]);
	},

	chartMode: function() {
		var st = this.status || {};
		if (this.schedEnabled && st.active_mode && st.mode == this.mode)
			return st.active_mode;
		return this.mode;
	},

	drawChart: function() {
		if (!this.refs.chart)
			return;

		var st = this.status || {}, mode = this.chartMode();
		var prof = null, flat = null;

		if (mode == 'manual')
			flat = this.manual;
		else if (mode == 'custom')
			prof = draftProfile(this.draft) || draftProfile(toDraft(this.profiles.custom));
		else
			prof = this.profiles[mode];

		if (!prof && flat == null)
			prof = this.profiles.balanced || { points: [], min_duty: 20 };

		var md = prof && isNum(prof.min_duty) ? prof.min_duty : 20;
		var pts = prof ? prof.points.map(function(p) {
			return [ p[0], p[1] == 'min' ? md : p[1] ];
		}) : [];

		var W = 480, H = 280, L = 42, R = 14, T = 14, B = 38;
		var x0 = 30, x1 = 90;
		if (pts.length) {
			x0 = Math.min(x0, pts[0][0] - 5);
			x1 = Math.max(x1, pts[pts.length - 1][0] + 5);
		}
		if (isNum(st.temp)) {
			x0 = Math.min(x0, st.temp - 3);
			x1 = Math.max(x1, st.temp + 3);
		}
		x0 = Math.floor(x0 / 10) * 10;
		x1 = Math.ceil(x1 / 10) * 10;

		var X = function(t) { return (L + (t - x0) / (x1 - x0) * (W - L - R)).toFixed(1); };
		var Y = function(d) { return (T + (1 - d / 100) * (H - T - B)).toFixed(1); };
		var s = '';
		var grid = 'stroke="currentColor" stroke-opacity=".18"';
		var txt = 'fill="currentColor" fill-opacity=".75" font-size="13"';
		var i;

		for (i = 0; i <= 100; i += 25)
			s += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + Y(i) + '" y2="' + Y(i) + '" ' + grid + '/>' +
				'<text x="' + (L - 6) + '" y="' + (Number(Y(i)) + 4) + '" text-anchor="end" ' + txt + '>' + i + '</text>';
		for (i = x0; i <= x1; i += 10)
			s += '<line x1="' + X(i) + '" x2="' + X(i) + '" y1="' + T + '" y2="' + (H - B) + '" ' + grid + '/>' +
				'<text x="' + X(i) + '" y="' + (H - B + 18) + '" text-anchor="middle" ' + txt + '>' + i + '</text>';
		s += '<text x="' + ((L + W - R) / 2) + '" y="' + (H - 4) + '" text-anchor="middle" ' + txt + '>' + esc(_('Temperature, °C')) + '</text>';
		s += '<text transform="translate(12 ' + ((T + H - B) / 2) + ') rotate(-90)" text-anchor="middle" ' + txt + '>' + esc(_('Fan speed, %')) + '</text>';

		/* safety floor */
		s += '<line x1="' + X(85) + '" x2="' + X(85) + '" y1="' + T + '" y2="' + (H - B) + '" stroke="var(--axf-bad)" stroke-width="1.5" stroke-dasharray="5 4"/>' +
			'<text x="' + (Number(X(85)) - 4) + '" y="' + (Number(Y(100)) + 14) + '" text-anchor="end" font-size="12" fill="var(--axf-bad)">' + esc(_('100 % at 85 °C')) + '</text>';

		/* curve */
		var line = [];
		if (flat != null) {
			line = [ [ x0, flat ], [ x1, flat ] ];
		}
		else if (pts.length) {
			line = [ [ x0, pts[0][1] ] ].concat(pts, [ [ x1, pts[pts.length - 1][1] ] ]);
		}
		if (line.length) {
			var path = line.map(function(p) { return X(p[0]) + ',' + Y(p[1]); }).join(' ');
			s += '<polygon points="' + X(x0) + ',' + Y(0) + ' ' + path + ' ' + X(x1) + ',' + Y(0) + '" fill="var(--axf-accent)" fill-opacity=".14"/>' +
				'<polyline points="' + path + '" fill="none" stroke="var(--axf-accent)" stroke-width="3" stroke-linejoin="round"/>';
			if (flat == null)
				pts.forEach(function(p) {
					s += '<circle cx="' + X(p[0]) + '" cy="' + Y(p[1]) + '" r="4" fill="var(--axf-accent)"/>';
				});
		}

		/* operating point */
		if (isNum(st.temp) && st.running !== false) {
			if (isNum(st.duty_applied))
				s += '<circle cx="' + X(st.temp) + '" cy="' + Y(st.duty_applied) + '" r="10" fill="none" stroke="var(--axf-warm)" stroke-width="2.5"/>';
			if (isNum(st.duty))
				s += '<circle cx="' + X(st.temp) + '" cy="' + Y(st.duty) + '" r="5.5" fill="var(--axf-warm)"/>';
		}

		this.refs.chart.innerHTML = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' +
			esc(_('Fan speed against temperature for the %s mode').format(modeInfo(mode).label)) + '">' + s + '</svg>';
	},

	/* ---------- manual ---------- */

	buildManual: function() {
		var self = this;
		var out = E('output', {}, this.manual + ' %');
		var range = E('input', {
			'type': 'range', 'min': '0', 'max': '100', 'step': '1', 'value': String(this.manual),
			'aria-label': _('Manual fan speed'),
			'input': function() {
				self.manual = Number(range.value);
				out.textContent = self.manual + ' %';
				self.drawChart();
			},
			'change': function() {
				uci.set('ax9000', 'fan', 'manual_duty', String(self.manual));
				self.flash(note, _('Saving...'));
				self.persist().then(function() {
					self.flash(note, _('Saved. The fan follows the new speed within a few seconds.'), 'ok');
				}).catch(function(e) {
					self.flash(note, _('Could not save: %s').format(e && e.message || e), 'bad');
				});
			}
		});
		var note = E('div', { 'class': 'axf-note', 'role': 'status', 'aria-live': 'polite' });

		this.refs.manual = this.card(_('Manual fan speed'), [
			E('div', { 'class': 'axf-slider' }, [ range, out ]),
			note,
			E('p', { 'class': 'axf-help' }, _('The fan service holds this speed (applied in 10 % steps). Safety limits still apply: the service forces 100 % at 85 °C, and the kernel failsafe raises the fan to at least 60 % above 75 °C even if the service is stopped.'))
		]);
		return this.refs.manual;
	},

	updateManualVisibility: function() {
		if (this.refs.manual)
			this.refs.manual.hidden = this.mode != 'manual';
		if (this.refs.custom)
			this.refs.custom.hidden = this.mode != 'custom';
	},

	/* ---------- custom curve editor ---------- */

	buildCustom: function() {
		var self = this, dr = this.draft;
		var tbody = E('tbody');
		var msg = E('div', { 'class': 'axf-note', 'role': 'status', 'aria-live': 'polite' });
		var save = E('button', { 'class': 'cbi-button cbi-button-save', 'type': 'button' }, _('Save curve'));
		var rows = [];

		var check = function() {
			var err = validateCurve(dr.points, dr.min_duty, dr.hysteresis);
			rows.forEach(function(tr, i) {
				tr.className = err && err.row == i ? 'bad' : '';
			});
			save.disabled = !!err;
			if (err) {
				self.flash(msg, err.msg + ' ' + _('The curve cannot be saved until this is fixed.'), 'bad');
			}
			else if (msg.className.indexOf('bad') >= 0) {
				self.flash(msg, '');
			}
			self.drawChart();
		};

		var field = function(p, key, attrs) {
			var i = E('input', Object.assign({
				'class': 'cbi-input-text', 'value': p[key],
				'input': function() { p[key] = i.value; check(); }
			}, attrs));
			return i;
		};

		var addRow = function(p) {
			var tr = E('tr', {}, [
				E('td', {}, field(p, 't', { 'type': 'number', 'step': '1', 'aria-label': _('Temperature, °C'), 'inputmode': 'numeric' })),
				E('td', {}, field(p, 'd', { 'type': 'text', 'inputmode': 'numeric', 'placeholder': _('0-100 or min'), 'aria-label': _('Duty, %') })),
				E('td', { 'style': 'width:1%;white-space:nowrap' }, E('button', {
					'class': 'cbi-button cbi-button-remove', 'type': 'button', 'aria-label': _('Remove point'),
					'click': function() {
						if (dr.points.length <= 2)
							return check();
						var idx = dr.points.indexOf(p);
						dr.points.splice(idx, 1);
						rows.splice(idx, 1);
						tbody.removeChild(tr);
						check();
					}
				}, '×'))
			]);
			rows.push(tr);
			tbody.appendChild(tr);
		};

		dr.points.forEach(addRow);

		var mdIn = E('input', {
			'class': 'cbi-input-text', 'type': 'number', 'step': '1', 'min': '0', 'max': '100', 'value': dr.min_duty,
			'input': function() { dr.min_duty = mdIn.value; check(); }
		});
		var hyIn = E('input', {
			'class': 'cbi-input-text', 'type': 'number', 'step': '1', 'min': '0', 'value': dr.hysteresis,
			'input': function() { dr.hysteresis = hyIn.value; check(); }
		});

		save.addEventListener('click', function() {
			var prof = draftProfile(dr);
			if (!prof)
				return check();

			if (!uci.get('ax9000', 'custom'))
				uci.add('ax9000', 'fan_profile', 'custom');
			uci.set('ax9000', 'custom', 'min_duty', String(prof.min_duty));
			uci.set('ax9000', 'custom', 'hysteresis', String(prof.hysteresis));
			uci.set('ax9000', 'custom', 'point', dr.points.map(serializePoint));

			save.disabled = true;
			self.flash(msg, _('Saving...'));
			self.persist().then(function() {
				self.profiles.custom = prof;
				self.flash(msg, _('Custom curve saved.'), 'ok');
				self.drawChart();
				save.disabled = false;
			}).catch(function(e) {
				save.disabled = false;
				self.flash(msg, _('Could not save: %s').format(e && e.message || e), 'bad');
			});
		});

		this.refs.custom = this.card(_('Custom curve'), [
			E('table', { 'class': 'axf-pts' }, [
				E('thead', {}, E('tr', {}, [
					E('th', {}, _('Temperature, °C')), E('th', {}, _('Duty, %')), E('th')
				])),
				tbody
			]),
			E('div', { 'class': 'axf-actions' }, E('button', {
				'class': 'cbi-button cbi-button-add', 'type': 'button',
				'click': function() {
					var last = dr.points[dr.points.length - 1];
					var lt = last ? parseNum(last.t) : null;
					var np = { t: String(lt == null ? 50 : lt + 5), d: last ? last.d : '100' };
					dr.points.push(np);
					addRow(np);
					check();
				}
			}, _('Add point'))),
			E('div', { 'class': 'axf-row' }, [
				E('label', {}, [ _('Minimum duty, % (value of "min")'), mdIn ]),
				E('label', {}, [ _('Hysteresis, °C'), hyIn ])
			]),
			msg,
			E('div', { 'class': 'axf-actions' }, [ save ]),
			E('p', { 'class': 'axf-help' }, _('Temperatures must be strictly increasing; duty is 0-100 or "min". Between points the speed is interpolated; outside them it stays flat. Hysteresis only delays slowing down.'))
		]);
		check();
		return this.refs.custom;
	},

	/* ---------- resets ---------- */

	buildResets: function() {
		var self = this, kids = [];

		BUILTIN_IDS.concat([ 'custom' ]).forEach(function(id) {
			var label = id == 'custom'
				? _('Reset Custom (copy of Balanced)')
				: _('Reset %s to defaults').format(modeInfo(id).label);
			kids.push(E('button', {
				'class': 'cbi-button cbi-button-reset', 'type': 'button',
				'click': function() { self.confirmReset(id, label); }
			}, label));
		});

		this.refs.resetNote = E('div', { 'class': 'axf-note', 'role': 'status', 'aria-live': 'polite' });
		return this.card(_('Reset curves'), [
			E('div', { 'class': 'axf-resets' }, kids),
			this.refs.resetNote
		]);
	},

	confirmReset: function(id, label) {
		var self = this;
		var saved = uci.sections('ax9000', 'fan_schedule').map(function(w) {
			return { start: padTime(w.start), end: padTime(w.end), mode: w.mode || 'balanced' };
		});
		var dirty = JSON.stringify(this.draft) != JSON.stringify(toDraft(this.profiles.custom)) ||
			JSON.stringify(this.schedule) != JSON.stringify(saved);

		ui.showModal(label, [
			E('p', {}, _('This replaces the stored %s curve with the factory default.').format(modeInfo(id).label)),
			dirty ? E('p', { 'class': 'axf-alert' }, _('You have unsaved changes in the custom curve or the schedule; they will be discarded.')) : '',
			E('div', { 'class': 'right' }, [
				E('button', { 'class': 'btn', 'click': ui.hideModal }, _('Cancel')), ' ',
				E('button', {
					'class': 'btn cbi-button-negative important',
					'click': function() {
						ui.hideModal();
						callReset(id).then(function() {
							return self.reload();
						}).then(function() {
							self.flash(self.refs.resetNote, _('%s curve restored to defaults.').format(modeInfo(id).label), 'ok');
						}).catch(function(e) {
							self.flash(self.refs.resetNote, _('Reset failed: %s').format(e && e.message || e), 'bad');
						});
					}
				}, _('Reset'))
			])
		]);
	},

	/* ---------- sensors ---------- */

	buildSensors: function() {
		var self = this;
		var live = {}, ids = [], boxes = {};
		var note = E('div', { 'class': 'axf-note', 'role': 'status', 'aria-live': 'polite' });
		var grid = E('div', { 'class': 'axf-sensors' });

		asList((this.status || {}).sensors).forEach(function(s) { live[s.id] = s; });
		/* plain hwmon names ("ath11k_hwmon") select every sensor of that kind;
		 * show the individual "name:phy" rows instead when the device reports them */
		var kinds = {};
		Object.keys(live).forEach(function(id) {
			if (id.indexOf(':') > 0)
				kinds[id.split(':')[0]] = true;
		});
		[].concat(DEFAULT_SENSORS, Object.keys(live), this.sensors).forEach(function(id) {
			if (kinds[id] || ids.indexOf(id) >= 0)
				return;
			ids.push(id);
		});

		ids.forEach(function(id) {
			var s = live[id];
			var cb = E('input', { 'type': 'checkbox' });
			cb.checked = self.sensors.indexOf(id) >= 0 ||
				(id.indexOf(':') > 0 && self.sensors.indexOf(id.split(':')[0]) >= 0);
			boxes[id] = cb;
			grid.appendChild(E('label', {}, [
				cb,
				E('span', {}, [ (s && s.label) || id, s && isNum(s.temp) ? E('em', {}, s.temp + ' °C') : '' ])
			]));
		});

		var save = E('button', {
			'class': 'cbi-button cbi-button-save', 'type': 'button',
			'click': function() {
				var sel = ids.filter(function(id) { return boxes[id].checked; });
				if (!sel.length)
					return self.flash(note, _('Select at least one sensor.'), 'bad');
				uci.set('ax9000', 'fan', 'sensor', sel);
				self.flash(note, _('Saving...'));
				self.persist().then(function() {
					self.sensors = sel;
					self.flash(note, _('Sensors saved.'), 'ok');
				}).catch(function(e) {
					self.flash(note, _('Could not save: %s').format(e && e.message || e), 'bad');
				});
			}
		}, _('Save sensors'));

		return this.card(_('Temperature sensors'), [
			E('p', { 'class': 'axf-help', 'style': 'margin:0 0 .75rem' }, _('The fan follows the hottest of the selected sensors. Sensors that cannot be read are ignored.')),
			grid,
			note,
			E('div', { 'class': 'axf-actions' }, [ save ])
		]);
	},

	/* ---------- schedule ---------- */

	buildSchedule: function() {
		var self = this, list = E('div');
		var note = E('div', { 'class': 'axf-note', 'role': 'status', 'aria-live': 'polite' });
		var rows = this.schedule;

		var toggle = E('input', {
			'type': 'checkbox',
			'change': function() {
				var prev = self.schedEnabled;
				self.schedEnabled = toggle.checked;
				uci.set('ax9000', 'fan', 'schedule_enabled', toggle.checked ? '1' : '0');
				self.persist().then(function() {
					self.flash(note, toggle.checked ? _('Schedule enabled.') : _('Schedule disabled.'), 'ok');
					self.drawChart();
				}).catch(function(e) {
					self.schedEnabled = prev;
					toggle.checked = prev;
					uci.set('ax9000', 'fan', 'schedule_enabled', prev ? '1' : '0');
					self.flash(note, _('Could not save: %s').format(e && e.message || e), 'bad');
				});
			}
		});

		var draw = function() {
			list.textContent = '';
			if (!rows.length)
				list.appendChild(E('p', { 'class': 'axf-help' }, _('No time windows yet.')));
			rows.forEach(function(w, i) {
				var sel = E('select', { 'class': 'cbi-input-select', 'change': function() { w.mode = sel.value; } },
					MODE_IDS.map(function(id) {
						return E('option', { 'value': id }, modeInfo(id).label);
					}));
				sel.value = w.mode;
				list.appendChild(E('div', { 'class': 'axf-sched' }, [
					E('input', { 'class': 'cbi-input-text', 'type': 'time', 'value': w.start, 'aria-label': _('Start'), 'input': function(ev) { w.start = ev.target.value; } }),
					E('span', { 'class': 'sep' }, '–'),
					E('input', { 'class': 'cbi-input-text', 'type': 'time', 'value': w.end, 'aria-label': _('End'), 'input': function(ev) { w.end = ev.target.value; } }),
					E('span', { 'class': 'sep' }, '→'),
					sel,
					E('button', {
						'class': 'cbi-button cbi-button-remove', 'type': 'button', 'aria-label': _('Remove window'),
						'click': function() { rows.splice(i, 1); draw(); }
					}, '×')
				]));
			});
		};
		toggle.checked = this.schedEnabled;
		draw();

		var save = E('button', {
			'class': 'cbi-button cbi-button-save', 'type': 'button',
			'click': function() {
				var re = /^([01]?[0-9]|2[0-3]):[0-5][0-9]$/, i, w, never = 0;
				for (i = 0; i < rows.length; i++) {
					w = rows[i];
					if (!re.test(w.start) || !re.test(w.end))
						return self.flash(note, _('Row %d: enter a start and an end time.').format(i + 1), 'bad');
					if (w.start == w.end)
						never++;
				}

				uci.sections('ax9000', 'fan_schedule').forEach(function(s) { uci.remove('ax9000', s['.name']); });
				rows.forEach(function(w) {
					var sid = uci.add('ax9000', 'fan_schedule');
					uci.set('ax9000', sid, 'start', w.start);
					uci.set('ax9000', sid, 'end', w.end);
					uci.set('ax9000', sid, 'mode', w.mode);
				});

				self.flash(note, _('Saving...'));
				self.persist().then(function() {
					self.flash(note, never
						? _('Schedule saved. %d window(s) with equal start and end are never active.').format(never)
						: _('Schedule saved.'), 'ok');
				}).catch(function(e) {
					self.flash(note, _('Could not save: %s').format(e && e.message || e), 'bad');
				});
			}
		}, _('Save schedule'));

		return this.card(_('Schedule'), [
			E('label', { 'class': 'axf-switch' }, [
				toggle, E('span', { 'class': 'tr' }), E('span', {}, _('Switch modes by time of day'))
			]),
			list,
			E('div', { 'class': 'axf-actions' }, [
				E('button', {
					'class': 'cbi-button cbi-button-add', 'type': 'button',
					'click': function() { rows.push({ start: '22:00', end: '07:00', mode: 'silent' }); draw(); }
				}, _('Add window')),
				save
			]),
			note,
			E('p', { 'class': 'axf-help' }, _('The first matching window wins. A window may cross midnight (for example 23:00 to 07:00); equal start and end never match. Outside all windows the mode selected above is used.'))
		]);
	},

	handleSave: null,
	handleSaveApply: null,
	handleReset: null
});
