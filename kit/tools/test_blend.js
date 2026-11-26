'use strict';
// M Vitals' Fuel mix page (apps/car_vitals/blend.js, issue #203): litres of E85 and pump fuel for a target ethanol
// share, the share reached, and why a target can't be reached:
//   node kit/tools/test_blend.js
const path = require('path');
const { blend } = require(path.join(__dirname, '..', '..', 'apps', 'car_vitals', 'blend'));

let checks = 0, fails = 0;
const ok = (c, m) => { checks++; if (!c) { fails++; console.log('FAIL ' + m); } else console.log('ok   ' + m); };
const near = (a, b, e) => Math.abs(a - b) <= (e || 0.15);

// 15 l of E10 in a 60 l tank, E30 wanted, E85 at 85 %, E10 pump fuel: 15*10 + x*85 + (45-x)*10 = 60*30
let r = blend({ tank: 60, now: 15, nowE: 10, target: 30, e85: 85, pump: 10 });
ok(r.ok && near(r.e85L, 16) && near(r.pumpL, 29) && near(r.result, 30), 'E30 from a quarter tank of E10: 16 l E85 + 29 l E10 (' + JSON.stringify(r) + ')');
ok(near(r.e85L + r.pumpL, 45), 'fills up to full');
// an empty tank: the plain mix
r = blend({ tank: 60, now: 0, nowE: 0, target: 85, e85: 85, pump: 10 });
ok(r.ok && near(r.e85L, 60) && near(r.pumpL, 0), 'E85 target from empty: all E85');
// too much ethanol already: pump fuel only, and says so
r = blend({ tank: 60, now: 50, nowE: 80, target: 30, e85: 85, pump: 10 });
ok(!r.ok && r.e85L === 0 && near(r.pumpL, 10) && r.result > 30 && /too much ethanol/.test(r.why), 'too rich to reach the target: pump fuel only (' + r.why + ')');
// not enough room for the E85
r = blend({ tank: 60, now: 55, nowE: 10, target: 50, e85: 85, pump: 10 });
ok(!r.ok && near(r.e85L, 5) && r.pumpL === 0 && r.result < 50 && /not enough room/.test(r.why), 'not enough room: E85 only (' + r.why + ')');
// full tank, a set fill, bad settings
r = blend({ tank: 60, now: 60, nowE: 30, target: 30, e85: 85, pump: 10 });
ok(r.fill === 0 && r.e85L === 0 && /full/.test(r.why), 'a full tank: nothing to put in');
r = blend({ tank: 60, now: 20, nowE: 10, target: 30, e85: 85, pump: 10, fill: 20 });
ok(r.ok && near(r.e85L + r.pumpL, 20) && near(r.result, 30), 'a set amount to fill (20 l)');
r = blend({ tank: 60, now: 20, nowE: 10, target: 30, e85: 10, pump: 10 });
ok(!r.ok && /settings/.test(r.why), 'E85 share not above the pump fuel\'s: says check the settings');
// winter E85 (70 %) needs more of it than summer E85 for the same target
const s = blend({ tank: 60, now: 15, nowE: 10, target: 30, e85: 85, pump: 10 }), w = blend({ tank: 60, now: 15, nowE: 10, target: 30, e85: 70, pump: 10 });
ok(w.e85L > s.e85L && near(w.result, 30), 'winter E85 (70 %): more of it for the same target (' + w.e85L + ' l vs ' + s.e85L + ' l)');

console.log('blend: ' + checks + ' checks, ' + fails + ' failed');
process.exit(fails ? 1 : 0);
