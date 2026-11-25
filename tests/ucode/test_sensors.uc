import { assert_eq } from './assert.uc';
import { parse_temp, discover, read_all } from 'sensors';

assert_eq(parse_temp("56200\n"), 56, "millidegrees to degrees");
assert_eq(parse_temp("56500"), 57, "rounds to nearest");
assert_eq(parse_temp("-5000"), -5, "negative ok");
assert_eq(parse_temp(""), null, "empty");
assert_eq(parse_temp("\n"), null, "blank");
assert_eq(parse_temp("999999"), null, "too hot");
assert_eq(parse_temp("151000"), null, "just above range");
assert_eq(parse_temp("150000"), 150, "upper bound inclusive");
assert_eq(parse_temp("-41000"), null, "below range");
assert_eq(parse_temp("-40000"), -40, "lower bound inclusive");
assert_eq(parse_temp("abc"), null, "non numeric");
assert_eq(parse_temp("56.2"), null, "not an integer");
assert_eq(parse_temp("56200abc"), null, "trailing garbage");
assert_eq(parse_temp(null), null, "null input");
assert_eq(parse_temp(56200), null, "non-string input");

// Fake fs over a flat path -> content map.
function fake_fs(files, dirs, links) {
	return {
		readfile: (p) => files[p],
		lsdir: (p) => dirs[p],
		readlink: (p) => links?.[p]
	};
}

let files = {
	'/s/class/thermal/thermal_zone0/type': "cpu0-thermal\n",
	'/s/class/thermal/thermal_zone0/temp': "56200\n",
	'/s/class/thermal/thermal_zone1/type': "nss-top-thermal\n",
	'/s/class/thermal/thermal_zone1/temp': "999999\n",
	'/s/class/thermal/thermal_zone2/type': "wcss-phya0-thermal\n",
	// zone2 has no temp file at all (-ENODATA)
	'/s/class/hwmon/hwmon0/name': "emc2305\n",
	'/s/class/hwmon/hwmon1/name': "ath11k_hwmon\n",
	'/s/class/hwmon/hwmon1/temp1_input': "61000\n",
	'/s/class/hwmon/hwmon2/name': "ath11k_hwmon\n",
	'/s/class/hwmon/hwmon2/temp1_input': "bad\n",
	'/s/class/hwmon/hwmon3/name': "ath10k_hwmon\n"
};
let dirs = {
	'/s/class/thermal': ['thermal_zone2', 'cooling_device0', 'thermal_zone0', 'thermal_zone1'],
	'/s/class/hwmon': ['hwmon3', 'hwmon0', 'hwmon1', 'hwmon2']
};
dirs['/s/class/hwmon/hwmon1/device/ieee80211'] = ['phy2'];
dirs['/s/class/hwmon/hwmon2/device/ieee80211'] = ['phy1'];
let links = {
	'/s/class/hwmon/hwmon1/device': '../../../0000:01:00.0',
	'/s/class/hwmon/hwmon2/device': '../../../c000000.wifi'
};
let fs = fake_fs(files, dirs, links);

let found = discover(fs, '/s');
assert_eq(map(found, s => s.id), [
	'cpu0-thermal', 'nss-top-thermal', 'wcss-phya0-thermal',
	'ath11k_hwmon:phy2', 'ath11k_hwmon:phy1', 'ath10k_hwmon:hwmon3'
], "discovered ids unique, sorted by hwmon, non-zone and non-ath hwmon ignored");
assert_eq(found[0].path, '/s/class/thermal/thermal_zone0/temp');
assert_eq(found[3].path, '/s/class/hwmon/hwmon1/temp1_input');
assert_eq(found[3].name, 'ath11k_hwmon');
assert_eq(found[3].label, 'ath11k_hwmon (phy2, 0000:01:00.0)');
assert_eq(found[5].label, 'ath10k_hwmon (hwmon3)', "no phy/device link -> hwmon dir");

let r = read_all(fs, found, ['cpu0-thermal', 'nss-top-thermal', 'wcss-phya0-thermal', 'ath11k_hwmon', 'missing-zone']);
assert_eq(map(r, x => x.temp), [56, null, null, 61, null, null],
	"garbage, missing file and unknown id all give null; shared id read twice");
assert_eq(r[5].id, 'missing-zone');
assert_eq(slice(map(r, x => x.id), 3, 5), ['ath11k_hwmon:phy2', 'ath11k_hwmon:phy1'], "plain name selects all of that kind");

let r2 = read_all(fs, found, ['ath11k_hwmon:phy2', 'ath11k_hwmon', 'ath10k_hwmon:hwmon3']);
assert_eq(map(r2, x => x.id), ['ath11k_hwmon:phy2', 'ath11k_hwmon:phy1', 'ath10k_hwmon:hwmon3'],
	"unique id and plain name overlap is read once");
assert_eq(map(r2, x => x.temp), [61, null, null]);

assert_eq(discover(fake_fs({}, {}), '/s'), [], "empty sysfs");
print("test_sensors: ok\n");
