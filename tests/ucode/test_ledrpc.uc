import { assert_eq } from './assert.uc';
import { stat } from 'fs';

// Load the shipped rpcd plugin. Only invalid requests are issued, so
// nothing is written to /var/run.
const rel = 'feed/ax9000-controls/files/usr/share/rpcd/ucode/ax9000-led.uc';
const m = loadfile(stat('/src/' + rel) ? '/src/' + rel : rel)()['ax9000.led'];

function bad(args, arg) {
	let r = m.preview.call({ args });
	assert_eq(r.ok, false, 'rejects ' + sprintf('%J', args));
	assert_eq(r.error, 'invalid_argument');
	assert_eq(r.argument, arg);
}

bad({ effect: 'bogus' }, 'effect');
bad({ color: 'red' }, 'color');
bad({ color: '#12345' }, 'color');
bad({ speed: 'nan' }, 'speed');
bad({ speed: 'NaN' }, 'speed');
bad({ speed: 'abc' }, 'speed');
bad({ speed: '0' }, 'speed');
bad({ speed: '0.05' }, 'speed');
bad({ speed: '11' }, 'speed');
bad({ brightness: -1 }, 'brightness');
bad({ brightness: 256 }, 'brightness');
bad({ seconds: 0 }, 'seconds');
bad({ seconds: 301 }, 'seconds');

// no state file (or a stale/foreign one) -> not_running
let st = m.status.call();
assert_eq(st.error, 'not_running');
assert_eq(st.events_active, []);

print("test_ledrpc: ok\n");
