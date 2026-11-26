'use strict';
// kit/runtime/analyse.js: a line is learned per condition, a sample far off it is an anomaly only after it lasts,
// the same anomaly a third time is "repeats", what went off first comes first, saved tests compare with the noise
// rule, and the learned baselines survive a save. No head unit needed:
//   node kit/tools/test_analyse.js
const path = require('path');
const { Analyser, compareTests, LEARN_N } = require(path.join(__dirname, '..', 'runtime', 'analyse'));

let checks = 0, fails = 0;
const ok = (c, m) => { checks++; if (!c) { fails++; console.log('FAIL ' + m); } else console.log('ok   ' + m); };
const channels = [{ id: 'x', minSpread: 1 }, { id: 'y', minSpread: 0.05 }, { id: 'z', minSpread: 1 }];
const mk = () => new Analyser({ channels, checks: [{ id: 'xy', x: 'x', y: 'y', bucket: (v) => (v.z > 50 ? 'high' : 'low'), minSpread: 0.05 }] });
const noise = (i) => 0.01 * Math.sin(i * 1.7);

let A = mk(), t = 0;
for (let i = 0; i < 300; i++) { t += 100; A.push(t, { x: 100 + (i % 50), y: 0.002 * (100 + (i % 50)) + noise(i), z: 10 }); }
let st = A.state('xy');
ok(st.level === 'ok' && st.n >= LEARN_N && Math.abs(st.expected - st.actual) < 0.03, 'a line learned: ' + st.expected.toFixed(3) + ' vs ' + st.actual.toFixed(3));
ok(A.events.length === 0, 'normal wander is no anomaly');
A.push(t += 100, { x: 120, y: 0.0, z: 10 });
ok(A.events.length === 0, 'one sample far off is not yet an anomaly (must last)');
for (let i = 0; i < 6; i++) A.push(t += 100, { x: 120, y: 0.0, z: 10 });
ok(A.events.length === 1 && A.events[0].bucket === 'low' && A.events[0].peakZ < -4, 'lasting off the line: an anomaly in its condition');
ok(A.state('xy').level === 'odd', 'the check reads OFF while it lasts');
A.push(t += 100, { x: 120, y: 0.0, z: 80 });
ok(A.state('xy').level === 'learning', 'another condition learns on its own');
const back = () => { for (let i = 0; i < 40; i++) A.push(t += 100, { x: 100 + (i % 50), y: 0.002 * (100 + (i % 50)), z: 10 }); };
back();
for (let k = 0; k < 2; k++) { for (let i = 0; i < 8; i++) A.push(t += 100, { x: 120, y: 0.0, z: 10 }); back(); }
ok(A.events.length === 3 && !A.events[1].repeat && A.events[2].repeat, 'the third time in the same condition: repeats');

// what went off first: y leaves its line 1 s before z jumps
A = mk(); t = 0;
for (let i = 0; i < 300; i++) { t += 100; A.push(t, { x: 100 + (i % 50), y: 0.002 * (100 + (i % 50)) + noise(i), z: 10 + noise(i) }); }
for (let i = 0; i < 10; i++) A.push(t += 100, { x: 120, y: 0.0, z: 10 });
for (let i = 0; i < 10; i++) A.push(t += 100, { x: 120, y: 0.0, z: 40 });
const fm = A.firstMovers(t, 30000).filter((m) => m.at !== null);
ok(fm[0].kind === 'check' && fm[0].id === 'xy' && fm.some((m) => m.id === 'z' && m.at > fm[0].at), 'what went off first: the check, then z: ' + fm.map((m) => m.id + '@' + (m.at - t)).join(' '));
const mv = A.movers(t, 2000);
ok(mv[0].id === 'z', 'the biggest mover right now: z');

// baselines saved and back
const snap = JSON.parse(JSON.stringify(A.snapshot())), B = mk();
B.restore(snap);
B.push(t += 100, { x: 120, y: 0.24, z: 10 });
ok(B.state('xy').level === 'ok', 'a restored baseline judges at once');
const H = A.healthy();
ok(H.xy && H.xy.low && H.xy.low.n >= LEARN_N, 'a healthy baseline per condition');
ok(Math.abs(A.drift(H, { xy: 120 })[0].spreads) < 1e-6, 'no drift against itself');

// tests: the noise rule
const pts = (f, n) => { const o = []; for (let r = 1000; r < 6000; r += 20) o.push([r, f(r) + (n || 0) * Math.sin(r)]); return o; };
let c = compareTests({ points: pts((r) => r / 1000, 0.2) }, { points: pts((r) => r / 1000 + 0.05, 0.2) }, 8, true);
ok(c.verdict === 'same' && c.same === 8, 'a change smaller than the spread is the same');
c = compareTests({ points: pts((r) => r / 1000, 0.05) }, { points: pts((r) => r / 1000 + 0.5, 0.05) }, 8, true);
ok(c.verdict === 'better' && c.better === 8, 'a clear rise is better');
c = compareTests({ points: pts((r) => r / 1000, 0.05) }, { points: pts((r) => r / 1000 - 0.5, 0.05) }, 8, true);
ok(c.verdict === 'worse', 'a clear fall is worse');

console.log('analyse: ' + checks + ' checks, ' + fails + ' failed');
process.exit(fails ? 1 : 0);
