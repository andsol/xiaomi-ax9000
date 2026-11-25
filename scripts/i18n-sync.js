#!/usr/bin/env node
// Sync the LuCI app translations with the strings used in its views.
//
//   node scripts/i18n-sync.js check            list strings without a Russian translation
//   node scripts/i18n-sync.js write [add.json] rewrite the .pot and ru .po from the views;
//                                             add.json ({ "msgid": "перевод" }) supplies
//                                             new translations; fails if any are missing
//
// Strings are collected from _('...') calls (single-quoted literals) in the view
// files, in order of first use. Translations of strings no longer used are dropped;
// existing headers of both files are kept. Remember that a literal % inside a string
// passed to .format() must be written %%.
'use strict';
const fs = require('fs');
const path = require('path');

const APP = path.join(__dirname, '..', 'feed', 'luci-app-ax9000-controls');
const VIEWS = [
	'htdocs/luci-static/resources/view/ax9000/fan.js',
	'htdocs/luci-static/resources/view/ax9000/led.js'
];
const PO = path.join(APP, 'po/ru/ax9000-controls.po');
const POT = path.join(APP, 'po/templates/ax9000-controls.pot');

const [, , mode, addFile] = process.argv;
if (mode !== 'check' && mode !== 'write') {
	console.error('usage: i18n-sync.js check | write [additions.json]');
	process.exit(64);
}

const ids = [];
const where = {};
for (const f of VIEWS) {
	const src = fs.readFileSync(path.join(APP, f), 'utf8');
	const re = /_\('((?:[^'\\]|\\.)*)'\)/g;
	let m;
	while ((m = re.exec(src))) {
		const id = m[1].replace(/\\'/g, "'").replace(/\\\\/g, '\\');
		if (!ids.includes(id)) {
			ids.push(id);
			where[id] = f;
		}
	}
}

const unquote = (s) => JSON.parse('"' + s + '"');
const quote = (s) => JSON.stringify(s); // gettext and JSON escapes agree for these strings
const header = (text) => text.slice(0, text.indexOf('\n\n') + 2);

const po = fs.readFileSync(PO, 'utf8');
const tr = {};
const pre = /msgid "((?:[^"\\]|\\.)*)"\nmsgstr "((?:[^"\\]|\\.)*)"/g;
let m;
while ((m = pre.exec(po)))
	if (m[1]) tr[unquote(m[1])] = unquote(m[2]);

if (addFile)
	Object.assign(tr, JSON.parse(fs.readFileSync(addFile, 'utf8')));

const missing = ids.filter((id) => !tr[id]);

if (mode === 'check') {
	missing.forEach((id) => console.log(quote(id) + ': "",'));
	console.error(ids.length + ' strings, ' + missing.length + ' untranslated');
	process.exit(missing.length ? 1 : 0);
}

if (missing.length) {
	console.error('untranslated (add them to the JSON file):\n' + missing.map(quote).join('\n'));
	process.exit(1);
}

let outPo = header(po);
let outPot = header(fs.readFileSync(POT, 'utf8'));
for (const id of ids) {
	outPo += 'msgid ' + quote(id) + '\nmsgstr ' + quote(tr[id]) + '\n\n';
	outPot += '#: ' + where[id] + '\nmsgid ' + quote(id) + '\nmsgstr ""\n\n';
}
fs.writeFileSync(PO, outPo.replace(/\n+$/, '\n'));
fs.writeFileSync(POT, outPot.replace(/\n+$/, '\n'));
console.log('wrote ' + ids.length + ' strings');
