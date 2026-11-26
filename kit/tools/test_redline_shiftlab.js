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
const { ShiftLog, perGear, pullCurves, pct, MAX } = require(path.join(APP, 'shiftlab'));
const { KickLog, byMode, byBand, bandOf, torqueAt } = require(path.join(APP, 'kickdown'));
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
ok(s.ms >= 180 && s.ms <= 220 && s.ms % 10 === 0, 'it took about 200 ms, to 10 ms (' + s.ms + ')');
ok(lab.changed === true, 'a new shift is worth saving now');
ok(Math.abs(s.rpmBefore - 6500) < 30 && Math.abs(s.rpmAfter - 6500 * 52 / 77) < 120, 'rpm before and after (' + s.rpmBefore + ' > ' + s.rpmAfter + ')');
ok(Math.abs(s.gBefore - 0.5) < 0.02 && Math.abs(s.gDip - 0.1) < 0.02 && Math.abs(s.gAfter - 0.4) < 0.02, 'g before, the dip during, after');
ok(Math.abs(lab.ratios[2] - 77) < 1 && Math.abs(lab.ratios[3] - 52) < 1, 'both ratios learned');
const curves = lab.pullCurves();
ok(curves[2] && curves[2].length > 5 && Math.abs(curves[2][0][1] - 0.5) < 0.01, 'the pull in 2nd: 0.5 g per 250 rpm bin');
const r2 = lab.ratios[2];
pull(lab, t + 5000, false);
ok(lab.shifts.length === 1, 'a shift without load is not counted');
ok(lab.ratios[2] === r2, 'no load: the ratio is not touched');

// the ratios (#268 review 2): the shift map's when it knows the gear; else refined under load only, within 3 %
(function () {
    let tt = 1000;
    const feed = (L, k, tq, g, n) => { for (let i = 0; i < n; i++) { L.feed({ rpm: 60 * k, speed: 60, gLong: g, torque: tq, gear: 3 }, tt); tt += 20; } };
    const own = new ShiftLog({ minTorque: 150 });
    feed(own, 52, 300, 0.3, 60);
    ok(Math.abs(own.ratios[3] - 52) < 0.01, 'learned under load: 52');
    feed(own, 60, 20, -0.05, 400);
    ok(Math.abs(own.ratios[3] - 52) < 0.01, 'a coast with the clutch in or the converter open (k 60, no load) leaves it (' + own.ratios[3].toFixed(2) + ')');
    feed(own, 56.2, 300, 0.3, 80);
    ok(Math.abs(own.ratios[3] - 52) < 0.01, 'under load but 8 % off: does not pull it (' + own.ratios[3].toFixed(2) + ')');
    feed(own, 53, 300, 0.3, 200);
    ok(own.ratios[3] > 52.3 && own.ratios[3] < 53, 'under load within 3 %: refined (' + own.ratios[3].toFixed(2) + ')');
    feed(own, 70, 300, 0.3, 120);
    ok(Math.abs(own.ratios[3] - 70) < 0.01, 'a wrong first reading: 100 steady loaded readings in a row elsewhere start the gear again');
    const known = new ShiftLog({ minTorque: 150, known: (g) => (g === 3 ? 51.5 : null) });
    feed(known, 53, 300, 0.3, 200);
    ok(known.ratios[3] === 51.5, 'a gear the shift map knows: its ratio, not refined here');
    // flash (#268 review 3): the pull and the ratios mark the file for later, only a shift for now
    known.saved();
    feed(known, 51.5, 300, 0.3, 100);
    ok(!known.changed && known.dirty && known.unsaved(), 'pull samples: saved later (dirty), not now (changed)');
})();
const pg = perGear([{ from: 2, ms: 200, rpmBefore: 6500, rpmAfter: 4400 }, { from: 2, ms: 160, rpmBefore: 6400, rpmAfter: 4300 }]);
ok(pg.length === 1 && pg[0].avgMs === 180 && pg[0].bestMs === 160 && pg[0].avgDrop === 2100, 'per gear change: average, best, rpm drop');
const noisy = [300, 310, 320, 330, 340, 350, 360, 370, 380, 390, 120];
const pn = perGear(noisy.map((ms) => ({ from: 3, ms, rpmBefore: 6000, rpmAfter: 4500 })))[0];
ok(pn.bestMs === 300 && pn.avgMs === 320, 'best is the 10th percentile, one noisy 120 ms reading does not make it (' + pn.bestMs + ')');
ok(pct([1, 2, 3, 4, 5], 0.5) === 3 && pct([], 0.1) === null && Math.abs(pct([160, 200], 0.1) - 164) < 1e-9, 'percentile');
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
ok(kl.kicks.every((x) => x.doneMs === null || x.doneMs % 10 === 0), 'kickdown times to 10 ms');
const kt = new KickLog({ fullTorque: () => 400 });
kickRun(kt, 1000, { pedal: false, gear: true });
ok(kt.kicks.length === 1 && kt.kicks[0].est === true && kt.kicks[0].kind === 'down', 'no pedal signal: the torque rise near full load stands in, marked an estimate');
const kn = new KickLog();
kickRun(kn, 1000, { pedal: false, gear: true });
ok(kn.kicks.length === 0, 'no pedal and no full-load curve learned yet: no kick');

// the torque-only false positives (#268 review 1)
function tqRun(kl2, opt) {
    let t2 = 1000; const v = 80;
    const step = (gear, tq) => { kl2.feed({ rpm: v * RAT[gear], speed: v, gear, torque: tq, mode: 'comfort', gb: 85 }, RAT, t2); t2 += 20; };
    for (let i = 0; i < 50; i++) step(opt.upshift ? 4 : 5, opt.base);
    if (opt.upshift) step(5, opt.base);                                          // the upshift 4 > 5, then torque comes back
    for (let i = 1; i <= 5; i++) step(5, opt.base + i * (opt.top - opt.base) / 5);
    for (let i = 0; i < 150; i++) step(5, opt.top);                              // the revs never rise, no lower gear
    return kl2;
}
ok(tqRun(new KickLog({ fullTorque: () => 400 }), { upshift: true, base: 100, top: 380 }).kicks.length === 0, 'torque coming back within 1 s of an upshift: no kick');
ok(tqRun(new KickLog({ fullTorque: () => 450 }), { base: 100, top: 300 }).kicks.length === 0, 'pressing on to well short of full-load torque: no kick');
ok(tqRun(new KickLog({ fullTorque: () => 400 }), { base: 100, top: 380 }).kicks.length === 0, 'a torque jump with the revs never rising and no lower gear: no "held" entry');
ok(torqueAt([[2000, 300], [3000, 400]], 2500) === 350 && torqueAt([[2000, 300], [3000, 400]], 4000) === null && torqueAt([], 2500) === null, 'full-load torque at an rpm');
const bm = byMode([{ kind: 'down', mode: 'sport', doneMs: 300 }, { kind: 'down', mode: 'sport', doneMs: 400 }, { kind: 'held', mode: 'eco' }]);
ok(bm[0].mode === 'sport' && bm[0].avgMs === 350 && bm[0].bestMs === 310 && bm[1].held === 1 && bm[1].avgMs === null, 'per mode: average, best (10th percentile), held');
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
const emptyKick = page('kick', none);
ok(/No kickdown seen yet/.test(emptyKick) && !/pedal/.test(emptyKick), 'Kickdown empty: says what to do, without the pedal Redline does not read');
ok(/has not sent a gearbox oil temperature/.test(page('cold', none)), 'Cold vs hot empty: plain words');
ok(Pages.PAGES.length === 4 && Pages.WHICH.length === 4, 'four pages after HUD looks');

// main.js: fed in the live branch of the sample loop (never the demo drive), the tabs and the setting
const src = fs.readFileSync(path.join(APP, 'main.js'), 'utf8');
ok(/if \(!car\.data\(\)\.demo\) \{[\s\S]{0,800}feedLab\(d, t, tq\);/.test(src), 'main.js feeds the shift timing from live data only');
ok(/concat\(ShiftPages\.PAGES\)/.test(src) && /const PAGES = 4 \+ ShiftPages\.PAGES\.length;/.test(src), 'main.js: the four tabs after HUD looks');
ok(/writeAtomic\(LAB_FILE/.test(src), 'main.js: shiftlab.json written whole (temp file and rename)');
ok(/!lab\.changed && !kick\.changed && Date\.now\(\) - labSavedAt < LAB_PULL_MS/.test(src) && /LAB_PULL_MS = 5 \* 60000/.test(src), 'main.js: the pull alone saved every 5 minutes, a shift or kick within 30 s');
ok(/known: \(g\) => shiftMap\.ratio\(g\)/.test(src) && /new KickLog\(\{ fullTorque \}\)/.test(src), 'main.js: the shift map\'s ratios and full-load torque');
const spec = JSON.parse(fs.readFileSync(path.join(APP, 'app.json'), 'utf8'));
ok(spec.settings.some((x) => x.key === 'labMinTorque' && x.default === 150), 'setting: Shift times: under load from (150 Nm)');

console.log('redline shift timing: ' + tally.checks + ' checks, ' + tally.fails + ' failed');
process.exit(tally.fails ? 1 : 0);
