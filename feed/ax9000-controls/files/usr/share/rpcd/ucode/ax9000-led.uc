#!/usr/bin/env ucode
// rpcd plugin `ax9000.led`. Stateless: it reads the status file published by
// ax9000-ledd and drops request files that the service picks up.

'use strict';

import { readfile, writefile, rename, unlink } from 'fs';

const ROOT = getenv('AX9000_LED_ROOT') ?? '';
const STATE_FILE = ROOT + '/var/run/ax9000-ledd.json';
const PREVIEW_FILE = ROOT + '/var/run/ax9000-ledd.preview';
const OFF_FILE = ROOT + '/var/run/ax9000-ledd.off';
const EFFECTS = ['static', 'breathing', 'flashing', 'cycle', 'rainbow', 'off'];

function invalid(name) {
	return { ok: false, error: 'invalid_argument', argument: name };
}

const STALE_S = 10;

function is_num(v) {
	return type(v) == 'int' || type(v) == 'double';
}

const methods = {
	status: {
		call: function() {
			let st = null;
			try { st = json(readfile(STATE_FILE) ?? 'null'); } catch (e) { }
			// ts is the service's monotonic seconds; stale means it stopped.
			if (type(st) != 'object' || !is_num(st.ts) || clock(true)[0] - st.ts > STALE_S)
				return { effect: null, color: null, brightness: 0,
				         events_active: [], night: false, error: 'not_running' };
			return st;
		}
	},

	// Argument types are fixed by rpcd's policy (an int never matches a
	// double), so speed is a string ("0.5"); seconds and brightness are ints.
	preview: {
		args: { effect: 'static', color: '#ffffff', speed: '1', brightness: 255, seconds: 10 },
		call: function(req) {
			let a = req.args ?? {};
			let effect = a.effect ?? 'static';
			let color = a.color ?? '#ffffff';
			let speed = a.speed != null ? +a.speed : 1;
			let brightness = a.brightness ?? 255;
			let seconds = a.seconds ?? 10;

			if (!(effect in EFFECTS))
				return invalid('effect');
			if (!match(color, /^#?[0-9a-fA-F]{6}$/))
				return invalid('color');
			if (!is_num(speed) || !(speed >= 0.1 && speed <= 10))
				return invalid('speed');
			if (!is_num(brightness) || !(brightness >= 0 && brightness <= 255))
				return invalid('brightness');
			if (!is_num(seconds) || !(seconds >= 1 && seconds <= 300))
				return invalid('seconds');

			// "id" makes identical consecutive previews distinct requests.
			let body = { id: sprintf('%d.%d', time(), clock()[1]), effect, color,
			             speed, brightness: int(brightness), seconds: int(seconds) };
			if (writefile(PREVIEW_FILE + '.tmp', sprintf('%J', body)) == null)
				return { ok: false, error: 'write_failed' };
			rename(PREVIEW_FILE + '.tmp', PREVIEW_FILE);
			return { ok: true, seconds: body.seconds };
		}
	},

	// off: true (default) turns the light off until the next reboot (the flag
	// lives on tmpfs); off: false clears it again.
	off_until_reboot: {
		args: { off: true },
		call: function(req) {
			let off = req.args?.off ?? true;
			if (off) {
				if (writefile(OFF_FILE, '1\n') == null)
					return { ok: false, error: 'write_failed' };
			} else
				unlink(OFF_FILE);
			return { ok: true, off: !!off };
		}
	}
};

return { 'ax9000.led': methods };
