'use strict';
// Fault Scanner: a fault text that only the code knows (no text for this unit's address or type) is not shown
// as fact when the unit type is unknown, and a unit name shared by two addresses is marked as a guess (#234).
// Uses the committed dtc_db.pack; no SDK or car needed:
//   node kit/tools/test_dtc_texts.js
const path = require('path');
const Module = require('module');
const ROOT = path.resolve(__dirname, '..', '..');
const APP = path.join(ROOT, 'apps', 'dtc_scanner');

const load = Module._load;
Module._load = function (req, parent, isMain) {
    if (req === './kit/mgu') return { run: () => {} };
    if (req.startsWith('./kit/')) return load.call(this, path.join(ROOT, 'kit', 'runtime', req.slice(6)), parent, isMain);
    return load.call(this, req, parent, isMain);
};
const { describe, ecuName, setIds } = require(path.join(APP, 'main.js'));

let checks = 0, fails = 0;
const ok = (c, m) => { checks++; if (!c) { fails++; console.log('FAIL ' + m); } };
const OTHER = 'Other unit type: ';

// the report in #234: a G20 whose headlight (0x44) and BDC (0x40) were not identified
setIds({});
const t44 = describe(0x44, '440021'), t40 = describe(0x40, '804027');
// 440021 is known only as a code-only text (a DSM's): marked
ok(t44 && t44.startsWith(OTHER), '440021 at 0x44 shown as fact: ' + t44);
// 804027 has a text every unit type at 0x40 agrees on: that one is this address's own, so no marker
ok(t40 && !t40.startsWith(OTHER), '804027 at 0x40 lost its address text: ' + t40);
console.log('  0x44 440021 -> ' + t44);
console.log('  0x40 804027 -> ' + t40);

// a unit's own known texts still read the same, without the marker
const own = require(path.join(APP, 'known_texts.js'));
const k = Object.keys(own).find((x) => /^[0-9A-F]{2}:/.test(x));
if (k) {
    const [a, c] = k.split(':');
    const d = describe(parseInt(a, 16), c);
    ok(d && !d.startsWith(OTHER), 'own text marked: ' + k + ' -> ' + d);
}

// two addresses with the same table name: marked while unidentified, plain for a one-off name
ok(/\?\)$/.test(ecuName(0x43)) && /\?\)$/.test(ecuName(0x44)), 'shared name not marked: ' + ecuName(0x43) + ' / ' + ecuName(0x44));
ok(ecuName(0x40) === 'BDC body', 'unique name changed: ' + ecuName(0x40));

console.log('dtc texts: ' + checks + ' checks, ' + fails + ' failed');
process.exit(fails ? 1 : 0);
