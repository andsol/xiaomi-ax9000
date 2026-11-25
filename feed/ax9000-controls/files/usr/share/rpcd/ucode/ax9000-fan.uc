#!/usr/bin/env ucode
'use strict';

// rpcd plugin: ubus object "ax9000.fan".
//   status         state published by ax9000-fand (no IPC, reads the json file)
//   profiles       effective day/night settings (UCI overriding the defaults)
//   reset_profile  { name } restores 'day' or 'night' to its defaults;
//                  other names -> ubus invalid argument

import { readfile } from 'fs';
import { cursor } from 'uci';

import * as fanctl from '/usr/share/ax9000/fanctl.uc';

// ubus status 2 (UBUS_STATUS_INVALID_ARGUMENT). rpcd also exposes it as a global,
// but a literal cannot throw a ReferenceError under 'use strict'.
const UBUS_STATUS_INVALID_ARGUMENT_ = 2;

const STATE_FILE = '/var/run/ax9000-fand.json';

function load_cfg() {
	let uci = cursor();
	let cfg = fanctl.parse_uci(uci.get_all('ax9000'));
	uci.unload();
	return cfg;
}

const methods = {
	status: {
		call: function() {
			let cfg = load_cfg();
			let st = null;
			try {
				st = json(readfile(STATE_FILE));
			}
			catch (e) {}

			// The service is considered down when the file is missing or older
			// than three intervals.
			let running = false;
			if (type(st) == 'object' && type(st.ts) == 'int')
				running = (clock(true)[0] - st.ts) <= 3 * (st.interval ?? cfg.interval) + 2;

			if (type(st) != 'object')
				st = {};

			return {
				running: running,
				active: st.active ?? fanctl.active_profile(cfg, localtime().hour * 60 + localtime().min),
				night_enabled: cfg.night_enabled,
				night_start: cfg.night_start,
				night_end: cfg.night_end,
				temp: st.temp ?? null,
				duty: st.duty ?? null,
				duty_applied: st.duty_applied ?? null,
				rpm: st.rpm ?? null,
				sensors: st.sensors ?? [],
				error: st.error ?? null
			};
		}
	},

	profiles: {
		call: function() {
			return { profiles: load_cfg().profiles };
		}
	},

	reset_profile: {
		args: { name: 'string' },
		call: function(req) {
			let name = req.args?.name;
			let v = fanctl.reset_values(name);
			if (v == null)
				return UBUS_STATUS_INVALID_ARGUMENT_; // ubus error, not a payload

			let uci = cursor();
			uci.delete('ax9000', name);
			uci.set('ax9000', name, 'fan_profile');
			uci.set('ax9000', name, 'mode', v.mode);
			uci.set('ax9000', name, 'fixed_duty', v.fixed_duty);
			uci.set('ax9000', name, 'hysteresis', v.hysteresis);
			uci.set('ax9000', name, 'point', v.point);
			uci.save('ax9000');
			uci.commit('ax9000');
			uci.unload();
			return { ok: true };
		}
	}
};

return { 'ax9000.fan': methods };
