// Regenerates tests/js/ledfx_vectors.json from the ucode ledfx.frame() (the
// reference the LuCI port in resources/ax9000/ledfx.js must match). In the
// builder container:
//   /work/openwrt/staging_dir/hostpkg/bin/ucode \
//     -L '/src/feed/ax9000-controls/files/usr/share/ax9000/*.uc' \
//     /src/tests/js/gen_ledfx_vectors.uc > ledfx_vectors.json
import { frame } from 'ledfx';

let colors = [[0, 0, 255], [255, 106, 0], [12, 200, 77]];
let speeds = [0.05, 0.1, 0.37, 1, 2.5, 10, 25];
let ts = [0, 1, 250, 999, 1500, 3333, 7777, 59999, 123456.5];

print('[\n');
let first = true;
for (let e in ['static', 'breathing', 'flashing', 'cycle', 'rainbow', 'off', 'bogus'])
	for (let c in colors)
		for (let s in speeds)
			for (let t in ts) {
				print((first ? '' : ',\n') + sprintf('%J', [e, c, t, s, frame(e, c, t, s)]));
				first = false;
			}
print('\n]\n');
