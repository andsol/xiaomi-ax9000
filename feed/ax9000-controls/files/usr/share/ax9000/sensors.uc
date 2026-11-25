// Temperature sensor helpers: parsing of sysfs values and discovery of the
// thermal zones / hwmon devices. All filesystem access goes through the `fs`
// object passed in, so the logic can be unit tested with a fake.

const TEMP_MIN = -40;
const TEMP_MAX = 150;

// Millidegrees (sysfs string) -> whole degrees Celsius, or null when the value
// is empty, not an integer, or outside the plausible range -40..150 C.
export function parse_temp(raw) {
	if (type(raw) != 'string')
		return null;
	let m = match(raw, /^[ \t\r\n]*(-?[0-9]+)[ \t\r\n]*$/);
	if (!m)
		return null;
	let milli = int(m[1]);
	let c = int(milli / 1000.0 + (milli < 0 ? -0.5 : 0.5));
	if (c < TEMP_MIN || c > TEMP_MAX)
		return null;
	return c;
};

function trim(s) {
	return type(s) == 'string' ? replace(s, /^[ \t\r\n]+|[ \t\r\n]+$/g, '') : null;
}

function basename(p) {
	let m = match(p ?? '', /([^\/]+)\/*$/);
	return m ? m[1] : null;
}

// Lists the temperature sources below `sysroot` (default "/sys"):
//   thermal zones      id = zone type (e.g. "cpu0-thermal"), file = temp
//   hwmon ath1?k_hwmon id = "<hwmon name>:<phy>" (e.g. "ath11k_hwmon:phy2"; the
//                      phy comes from device/ieee80211, else the device name,
//                      else the hwmonN directory), name = plain hwmon name,
//                      file = temp1_input
// Ids are unique and stable. read_all() also accepts the plain hwmon name
// ("ath11k_hwmon") and then selects every sensor of that kind.
export function discover(fs, sysroot) {
	sysroot ??= '/sys';
	let out = [];

	let zones = sort(fs.lsdir(sysroot + '/class/thermal') ?? []);
	for (let z in zones) {
		if (!match(z, /^thermal_zone[0-9]+$/))
			continue;
		let base = sysroot + '/class/thermal/' + z;
		let t = trim(fs.readfile(base + '/type'));
		if (t)
			push(out, { id: t, label: t, path: base + '/temp' });
	}

	let hw = sort(fs.lsdir(sysroot + '/class/hwmon') ?? []);
	for (let h in hw) {
		if (!match(h, /^hwmon[0-9]+$/))
			continue;
		let base = sysroot + '/class/hwmon/' + h;
		let n = trim(fs.readfile(base + '/name'));
		if (!n || !match(n, /^ath1[01]k_hwmon$/))
			continue;
		let dev = basename(fs.readlink(base + '/device'));
		let phys = filter(sort(fs.lsdir(base + '/device/ieee80211') ?? []), (p) => match(p, /^phy[0-9]+$/));
		let uniq = phys[0] ?? dev ?? h;
		push(out, {
			id: n + ':' + uniq,
			name: n,
			label: n + ' (' + (dev && uniq != dev ? uniq + ', ' + dev : uniq) + ')',
			path: base + '/temp1_input'
		});
	}

	return out;
};

// Reads the wanted sensor ids. Returns one entry per source that matched a
// wanted id (several for a plain hwmon name) plus an entry with temp null for ids that
// matched nothing. A source that cannot be read or parsed has temp null.
export function read_all(fs, found, wanted) {
	let out = [], seen = {};
	for (let id in wanted) {
		let hit = false;
		for (let s in found) {
			if (s.id != id && s.name != id)
				continue;
			hit = true;
			if (seen[s.path])
				continue;
			seen[s.path] = true;
			push(out, { id: s.id, label: s.label, temp: parse_temp(fs.readfile(s.path)) });
		}
		if (!hit)
			push(out, { id: id, label: id, temp: null });
	}
	return out;
};
