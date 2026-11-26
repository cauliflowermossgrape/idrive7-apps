'use strict';
// Shift Lab: an upshift under load is timed from the rpm peak to the new gear's ratio, with its rpm drop and g dip;
// a lift-off shift is not counted; the pull per gear and 250 rpm; the last 200 kept; and the app draws its four pages
// (demo and live) against a stubbed head unit (panel titles are drawn as layers, not read here). No SDK or car needed:
//   node kit/tools/test_shift_lab.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const ROOT = path.resolve(__dirname, '..', '..'), KIT = path.join(ROOT, 'kit', 'runtime');
const APP = path.join(ROOT, 'apps', 'shift_lab');
const { Recorder } = require(path.join(KIT, 'record'));
const themes = require(path.join(KIT, 'themes'));
const { ShiftLog, perGear, MAX } = require(path.join(APP, 'shifts'));
const { KickLog, byMode, byBand, bandOf } = require(path.join(APP, 'kickdown'));

let checks = 0, fails = 0;
const ok = (c, m) => { checks++; if (!c) { fails++; console.log('FAIL ' + m); } else console.log('ok   ' + m); };

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

// the app's pages
let impl = null;
const load = Module._load;
Module._load = function (req, parent, isMain) {
    if (req === './kit/mgu') return { run: (i) => { impl = i; } };
    if (req.startsWith('./kit/')) return load.call(this, path.join(KIT, req.slice(6)), parent, isMain);
    return load.call(this, req, parent, isMain);
};
(async () => {
    const spec = JSON.parse(fs.readFileSync(path.join(APP, 'app.json'), 'utf8'));
    const run = async (demo) => {
        delete require.cache[path.join(APP, 'main.js')];
        require(path.join(APP, 'main.js'));
        const S = {}; spec.settings.forEach((x) => { if (x.key) S[x.key] = x.default; }); S.demo = demo;
        const noop = () => {}, clicks = {};
        let frame = null, tab = null, texts = [];
        await impl.start({
            log: { info: noop, warn: noop, error: noop }, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'shiftlab-')), spec,
            settings: { get: (k) => S[k], onChange: noop }, signals: { watch: async () => ({ shutdown: async () => {} }) },
            ui: { image: async () => {}, onClick: (b, fn) => { clicks[b] = fn; }, isVisible: () => true }, onTab: (fn) => { tab = fn; },
            theme: () => themes.theme('m_tricolour'), loop: (n, fps, fn) => { frame = fn; },
            canvas: (w, h) => { const cv = new Recorder(w, h), text = cv.text.bind(cv); texts = []; cv.text = (x, ...a) => { texts.push(String(x)); return text(x, ...a); }; return cv; },
        });
        await new Promise((r) => setTimeout(r, 200));
        const page = async (i) => { await tab(i); await frame(); return texts.join(' | '); };
        return { page, clicks };
    };
    const d = await run('on');
    let p = await d.page(0);
    ok(/The white dot is the car now/.test(p) && /1 {2}to {2}2/.test(p) && /187 ms/.test(p) && /HOW HARD IT PUSHED YOU/.test(p), 'demo Live: the gear lines and the last shift');
    p = await d.page(1);
    ok(/RPM DROP AT EACH CHANGE/.test(p) && /1 > 2/.test(p) && /average/.test(p) && /6 350 > 4 188/.test(p), 'demo Shifts: the bars and the table');
    p = await d.page(2);
    ok(/Higher line: the car pushes you harder/.test(p) && /gear 6/.test(p) && /117\.2/.test(p), 'demo Pull: one line per gear and the best of each');
    p = await d.page(3);
    ok(/drops a gear in \d+ ms on average/.test(p) && /held the gear/.test(p) && /NEWEST: /.test(p) && /pedal down/.test(p) && /REVS UP/.test(p), 'demo Kickdown: per mode, the newest as a timeline, the table');
    p = await d.page(4);
    ok(/Each dot is an upshift under load/.test(p) && /upshifts take \d+ % longer than warm/.test(p) && /kickdown \(/.test(p), 'demo Cold vs hot: the scatter and the bands');
    p = await d.page(5);
    ok(/It times every upshift under load/.test(p) && /It times kickdowns/.test(p), 'How it works');
    const l = await run('off');
    p = await l.page(0);
    ok(/No shift measured yet/.test(p) && /gears not learned yet/.test(p), 'no car data yet: plain words, no fake numbers');
    p = await l.page(1);
    ok(/No shifts measured yet/.test(p), 'Shifts empty: says what to do');
    p = await l.page(3);
    ok(/No kickdown seen yet/.test(p) && /None yet/.test(p), 'Kickdown empty: says what to do');
    p = await l.page(4);
    ok(/No shift with a gearbox oil temperature yet/.test(p) && /has not sent a gearbox oil temperature/.test(p), 'Cold vs hot empty: plain words');
    console.log('shift_lab: ' + checks + ' checks, ' + fails + ' failed');
    process.exit(fails ? 1 : 0);
})().catch((e) => { console.log('FAIL ' + (e && e.stack || e)); process.exit(1); });
