'use strict';
// Redline's shift timing pages (from Shift Lab, #253): an upshift under load is timed from the rpm peak to the new gear's
// ratio, with its rpm drop and g dip; a lift-off shift is not counted; the pull per gear; kickdowns per mode (from the
// torque jump: Redline does not read the pedal) and against the gearbox oil; the four pages drawn (demo and empty);
// main.js feeds it from live data only. No SDK or car needed (Node 8 compatible):
//   node kit/tools/test_redline_shiftlab.js
const fs = require('fs');
const path = require('path');
const TH = require('./redline_test_harness');
const ROOT = TH.ROOT, KIT = path.join(ROOT, 'kit', 'runtime'), APP = path.join(ROOT, 'apps', 'redline');
TH.hookKit();
const { Recorder } = require(path.join(KIT, 'record'));
const themes = require(path.join(KIT, 'themes'));
const { ShiftLog, perGear, pullCurves, MAX } = require(path.join(APP, 'shiftlab'));
const { KickLog, byMode, byBand, bandOf } = require(path.join(APP, 'kickdown'));
const Pages = require(path.join(APP, 'shiftpages'));
const shiftDemo = require(path.join(APP, 'shiftdemo'));

const tally = TH.counter(), ok = tally.ok;


// a pull: 2nd gear (k 77) to 6500 rpm, a 200 ms shift (rpm falls along a straight line), then 3rd (k 52)
const K = { 2: 77, 3: 52 };
function pull(lab, t0, load) {
    let t = t0, v = 40;
    const step = (rpm, gear, g, tq) => { lab.feed({ rpm, speed: v, gLong: g, torque: tq, gear }, t); t += 20; };
    while (v * K[2] < 6500) { step(v * K[2], 2, load ? 0.5 : 0.02, load ? 350 : 40); v += 0.25; }
    const r0 = v * K[2], r1 = v * K[3];
    for (let i = 1; i <= 10; i++) { step(r0 + (r1 - r0) * i / 10, i < 5 ? 2 : 3, load ? 0.1 : 0.0, load ? 200 : 40); v += 0.05; }
    for (let i = 0; i < 150; i++) { step(v * K[3], 3, load ? 0.4 : 0.02, load ? 380 : 40); v += 0.2; }
    return t;
}
const lab = new ShiftLog({ minTorque: 150 });
let t = pull(lab, 1000, true);
ok(lab.shifts.length === 1 && lab.shifts[0].from === 2 && lab.shifts[0].to === 3, 'an upshift under load is counted: 2 > 3');
const s = lab.shifts[0] || {};
ok(s.ms >= 180 && s.ms <= 220, 'it took about 200 ms (' + s.ms + ')');
ok(Math.abs(s.rpmBefore - 6500) < 30 && Math.abs(s.rpmAfter - 6500 * 52 / 77) < 120, 'rpm before and after (' + s.rpmBefore + ' > ' + s.rpmAfter + ')');
ok(Math.abs(s.gBefore - 0.5) < 0.02 && Math.abs(s.gDip - 0.1) < 0.02 && Math.abs(s.gAfter - 0.4) < 0.02, 'g before, the dip during, after');
ok(Math.abs(lab.ratios[2] - 77) < 1 && Math.abs(lab.ratios[3] - 52) < 1, 'both ratios learned');
const curves = lab.pullCurves();
ok(curves[2] && curves[2].length > 5 && Math.abs(curves[2][0][1] - 0.5) < 0.01, 'the pull in 2nd: 0.5 g per 250 rpm bin');
pull(lab, t + 5000, false);
ok(lab.shifts.length === 1, 'a shift without load is not counted');
const pg = perGear([{ from: 2, ms: 200, rpmBefore: 6500, rpmAfter: 4400 }, { from: 2, ms: 160, rpmBefore: 6400, rpmAfter: 4300 }]);
ok(pg.length === 1 && pg[0].avgMs === 180 && pg[0].bestMs === 160 && pg[0].avgDrop === 2100, 'per gear change: average, best, rpm drop');
const many = new ShiftLog();
many.load({ shifts: new Array(250).fill(0).map((x, i) => ({ ms: i, from: 1, to: 2 })) });
ok(many.shifts.length === MAX, 'at most ' + MAX + ' kept');
const back = new ShiftLog(); back.load(JSON.parse(JSON.stringify(lab.toJSON())));
ok(back.shifts.length === 1 && Math.abs(back.ratios[3] - 52) < 1 && back.pullCurves()[2], 'kept and read back');

// kickdowns: cruising in 5th (k 36) at part pedal, the pedal floored in 100 ms; the gearbox drops to 3rd (k 61)
const RAT = { 3: 61, 4: 46, 5: 36 };
function kickRun(kl, t0, opt) {
    let t = t0; const v = 80;
    const step = (rpm, pedal, tq, gear) => { kl.feed({ rpm, speed: v, gear: opt.gear ? gear : null, pedal: opt.pedal ? pedal : undefined, torque: tq, mode: 'sport', gb: 85 }, RAT, t); t += 20; };
    for (let i = 0; i < 50; i++) step(v * RAT[5], 25, 120, 5);                     // 1 s cruising
    for (let i = 1; i <= 5; i++) step(v * RAT[5], 25 + i * 15, 120 + i * 50, 5);    // floored in 100 ms
    for (let i = 0; i < 10; i++) step(v * RAT[5], 100, 380, 5);                     // 200 ms: nothing yet
    if (opt.held) { for (let i = 0; i < 150; i++) step(v * RAT[5], 100, 400, 5); return t; }
    for (let i = 1; i <= 10; i++) step(v * (RAT[5] + (RAT[3] - RAT[5]) * i / 10), 100, 380, i < 6 ? 5 : 3);   // 200 ms to 3rd
    for (let i = 0; i < 100; i++) step(v * RAT[3], 100, 420, 3);
    return t;
}
let kl = new KickLog();
let tk = kickRun(kl, 1000, { pedal: true, gear: false });
const kk = kl.kicks[0] || {};
ok(kl.kicks.length === 1 && kk.kind === 'down' && kk.from === 5 && kk.to === 3, 'a floored pedal: kickdown 5 > 3 seen from the ratios (' + kk.from + ' > ' + kk.to + ')');
ok(kk.doneMs >= 460 && kk.doneMs <= 500 && kk.startMs >= 280 && kk.startMs <= 320, 'revs start rising 300 ms after the pedal, the lower gear in at 480 ms (' + kk.startMs + ', ' + kk.doneMs + ')');
ok(kk.mode === 'sport' && kk.gb === 85 && !kk.est, 'mode and gearbox oil kept, not an estimate');
tk = kickRun(kl, tk + 5000, { pedal: true, gear: true, held: true });
ok(kl.kicks.length === 2 && kl.kicks[0].kind === 'held' && kl.kicks[0].doneMs === null, 'no lower gear within 2.5 s: held the gear');
const kt = new KickLog();
kickRun(kt, 1000, { pedal: false, gear: true });
ok(kt.kicks.length === 1 && kt.kicks[0].est === true && kt.kicks[0].kind === 'down', 'no pedal signal: the torque rise stands in, marked an estimate');
const bm = byMode([{ kind: 'down', mode: 'sport', doneMs: 300 }, { kind: 'down', mode: 'sport', doneMs: 400 }, { kind: 'held', mode: 'eco' }]);
ok(bm[0].mode === 'sport' && bm[0].avgMs === 350 && bm[0].bestMs === 300 && bm[1].held === 1 && bm[1].avgMs === null, 'per mode: average, best, held');
const bb = byBand([{ gb: 30, ms: 400 }, { gb: 35, ms: 300 }, { gb: 80, ms: 200 }], 'ms');
ok(bandOf(39) === 'cold' && bandOf(70) === 'warm' && bb[0].avgMs === 350 && bb[0].n === 2 && bb[2].avgMs === 200 && bb[1].n === 0, 'gearbox oil bands');
const shg = new ShiftLog({ minTorque: 150 });
(function () { let t2 = 1000, v = 40; const st = (rpm, gear, g, tq) => { shg.feed({ rpm, speed: v, gLong: g, torque: tq, gear, gb: 55 }, t2); t2 += 20; };
    while (v * 77 < 6500) { st(v * 77, 2, 0.5, 350); v += 0.25; } const r0 = v * 77, r1 = v * 52;
    for (let i = 1; i <= 10; i++) { st(r0 + (r1 - r0) * i / 10, i < 5 ? 2 : 3, 0.1, 200); v += 0.05; }
    for (let i = 0; i < 150; i++) { st(v * 52, 3, 0.4, 380); v += 0.2; } })();
ok(shg.shifts[0] && shg.shifts[0].gb === 55, 'an upshift keeps the gearbox oil temperature');


// the pages, drawn as main.js draws them
const TH_THEME = themes.theme('m_tricolour');
function page(which, s) {
    const cv = new Recorder(1600, 520), text = cv.text.bind(cv), texts = [];
    cv.text = function (x) { texts.push(String(x)); return text.apply(null, arguments); };
    Pages.draw(cv, TH_THEME, which, Object.assign({ minTorque: 150 }, s));
    return texts.join(' | ');
}
const dm = shiftDemo.make(Date.now());
const demo = { shifts: dm.shifts, ratios: dm.ratios, curves: pullCurves(dm.pull), perGear: perGear(dm.shifts), kicks: dm.kicks, gb: 82 };
let p = page('times', demo);
ok(/RPM DROP AT EACH CHANGE/.test(p) && /1 > 2/.test(p) && /average/.test(p) && /Counted: upshifts under load \(over 150 Nm/.test(p), 'demo Shift times: the bars, the table, what is counted');
p = page('pull', demo);
ok(/Higher line: the car pushes you harder/.test(p) && /gear 6/.test(p) && /117\.2/.test(p), 'demo Pull: one line per gear and the best of each');
p = page('kick', demo);
ok(/drops a gear in \d+ ms on average/.test(p) && /held the gear/.test(p) && /NEWEST: /.test(p) && /kick/.test(p) && /REVS UP/.test(p), 'demo Kickdown: per mode, the newest as a timeline, the table');
p = page('cold', demo);
ok(/Each dot is an upshift under load/.test(p) && /upshifts take \d+ % longer than warm/.test(p) && /kickdown \(/.test(p), 'demo Cold vs hot: the scatter and the bands');
const none = { shifts: [], ratios: {}, curves: {}, perGear: [], kicks: [], gb: null };
ok(/No shifts measured yet/.test(page('times', none)), 'Shift times empty: says what to do');
ok(/No kickdown seen yet/.test(page('kick', none)), 'Kickdown empty: says what to do');
ok(/has not sent a gearbox oil temperature/.test(page('cold', none)), 'Cold vs hot empty: plain words');
ok(Pages.PAGES.length === 4 && Pages.WHICH.length === 4, 'four pages after HUD looks');

// main.js: fed in the live branch of the sample loop (never the demo drive), the tabs and the setting
const src = fs.readFileSync(path.join(APP, 'main.js'), 'utf8');
ok(/if \(!car\.data\(\)\.demo\) \{[\s\S]{0,800}feedLab\(d, t, tq\);/.test(src), 'main.js feeds the shift timing from live data only');
ok(/concat\(ShiftPages\.PAGES\)/.test(src) && /const PAGES = 4 \+ ShiftPages\.PAGES\.length;/.test(src), 'main.js: the four tabs after HUD looks');
ok(/writeAtomic\(LAB_FILE/.test(src), 'main.js: shiftlab.json written whole (temp file and rename)');
const spec = JSON.parse(fs.readFileSync(path.join(APP, 'app.json'), 'utf8'));
ok(spec.settings.some((x) => x.key === 'labMinTorque' && x.default === 150), 'setting: Shift times: under load from (150 Nm)');

console.log('redline shift timing: ' + tally.checks + ' checks, ' + tally.fails + ' failed');
process.exit(tally.fails ? 1 : 0);
