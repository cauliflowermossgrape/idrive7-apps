'use strict';
// Trip Recap: a drive starts when the car moves, ends 3 min after it stops, km from the odometer (or the speed added
// up), hard brakes counted once each, short stops not kept, 30 kept and read back, marks kept; Before / After's
// arithmetic (diff.js: the change, the noise rule, similar drives); and the app's five pages in the
// demo (panel titles are drawn as cached pictures, so the checks read the other texts). Against a stubbed head unit; no SDK or car needed:
//   node kit/tools/test_trip_recap.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const ROOT = path.resolve(__dirname, '..', '..'), KIT = path.join(ROOT, 'kit', 'runtime');
const APP = path.join(ROOT, 'apps', 'trip_recap');
const { Recorder } = require(path.join(KIT, 'record'));
const themes = require(path.join(KIT, 'themes'));
const { Trips, END_MS, TRIPS_KEPT } = require(path.join(APP, 'trips'));
const D = require(path.join(APP, 'diff'));

let checks = 0, fails = 0;
const ok = (c, m) => { checks++; if (!c) { fails++; console.log('FAIL ' + m); } else console.log('ok   ' + m); };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trip-')), file = path.join(dir, 'trips.json');
let t = Date.UTC(2026, 10, 26, 8, 0, 0);
const tr = new Trips({ file, now: () => t });
const run = (secs, v) => { for (let i = 0; i < secs; i++) { t += 1000; tr.sample(Object.assign({}, v, typeof v.odo === 'function' ? { odo: v.odo(i) } : {})); } };

run(30, { speed: 0, rpm: 0 });
ok(!tr.current(), 'parked with the engine off: no drive');
run(600, { speed: 60, rpm: 2000, odo: (i) => 1000 + Math.floor(i / 60), gLong: 0.1, gLat: 0.2, kw: 40, oil: 80, coolant: 85 });
ok(tr.current() && tr.current().vMax === 60, 'driving: a drive going on');
run(3, { speed: 50, rpm: 1500, gLong: -0.7 }); run(3, { speed: 40, rpm: 1500, gLong: -0.6 }); run(2, { speed: 40, rpm: 1500, gLong: 0 });
run(2, { speed: 30, rpm: 1500, gLong: -0.8 });
ok(tr.current().brakes === 2, 'two hard brakes, each counted once: ' + tr.current().brakes);
run(120, { speed: 0, rpm: 0 });
ok(tr.current() && !tr.list().length, '2 min parked: still the same drive');
run(END_MS / 1000, { speed: 0, rpm: 0 });
const d = tr.list()[0];
ok(!tr.current() && tr.list().length === 1, '3 min parked: the drive saved');
ok(d && d.km === 9, 'km from the odometer: ' + (d && d.km));
ok(d && Math.abs(d.vAvg - 59.5) < 1 && d.gBrake === 0.8 && d.kwMax === 40 && d.oilMax === 80, 'average, hardest braking, power, oil');
ok(d && d.trace.length >= 60, 'a speed point every 10 s: ' + (d && d.trace.length));
run(20, { speed: 0, rpm: 900 }); run(END_MS / 1000 + 5, { speed: 0, rpm: 0 });
ok(tr.list().length === 1, 'a short idle with no km: not kept');
run(120, { speed: 36, rpm: 1500 }); run(END_MS / 1000 + 5, { speed: 0, rpm: 0 });
ok(Math.abs(tr.list()[0].km - 1.2) < 0.05, 'no odometer: the speed added up, 1.2 km');
for (let k = 0; k < TRIPS_KEPT + 5; k++) { run(90, { speed: 40, rpm: 1500 }); run(END_MS / 1000 + 5, { speed: 0, rpm: 0 }); }
ok(tr.list().length === TRIPS_KEPT, 'only the newest ' + TRIPS_KEPT + ' kept');
ok(new Trips({ file }).list().length === TRIPS_KEPT, 'read back after a restart');

// marks: kept with the odometer, read back; a 0.1 file (a plain array of drives) still read
const mk = tr.mark('Service', 48200);
const again = new Trips({ file });
ok(again.marks().length === 1 && again.marks()[0].label === 'Service' && again.marks()[0].odo === 48200 && again.marks()[0].at === mk.at, 'a mark kept with its odometer, read back');
ok(again.list().length === TRIPS_KEPT, 'the drives kept next to the marks');
const old = path.join(dir, 'old.json');
fs.writeFileSync(old, JSON.stringify([{ start: 1, km: 3 }]));
ok(new Trips({ file: old }).list().length === 1 && new Trips({ file: old }).marks().length === 0, 'a 0.1 file (drives only) still read');

// warm-up: a cold start counts the seconds until the oil reaches 80
const wf = path.join(dir, 'warm.json'), tw = new Trips({ file: wf, now: () => t });
for (let i = 0; i < 400; i++) { t += 1000; tw.sample({ speed: 50, rpm: 2000, oil: 20 + i / 5 }); }
tw.flush();
ok(tw.list()[0] && tw.list()[0].warm === 300, 'oil warm-up from cold to 80: ' + (tw.list()[0] && tw.list()[0].warm) + ' s');

// Before / After arithmetic
const drv = (o) => Object.assign({ km: 20, secs: 1500, vAvg: 50, gBrake: 0.5, brakes: 1, kwMax: 100, oilMax: 100, coolMax: 90 }, o);
const row = (rs, k) => rs.filter((r) => r.key === k)[0];
let rs = D.rows([100, 102, 98, 100].map((k) => drv({ kwMax: k, oilMax: 100 + (k % 3) })), [110, 111, 109].map((k) => drv({ kwMax: k, oilMax: 100.5 })));
ok(row(rs, 'kw').state === 'better' && Math.abs(row(rs, 'kw').pct - 10) < 0.5, 'more power after: better, +10 %');
ok(row(rs, 'oil').state === 'same', 'oil within the spread of the drives before: within normal variation');
ok(row(rs, 'warm').state === 'none', 'warm-up not recorded: shown as such');
rs = D.rows([drv({ oilMax: 100 })], [drv({ oilMax: 115 })]);
ok(row(rs, 'oil').state === 'same', 'one drive each side: twice 10 % of it stands in for the spread, +15 % is within');
rs = D.rows([drv({ oilMax: 100 })], [drv({ oilMax: 125 })]);
ok(row(rs, 'oil').state === 'worse', 'one drive each side, oil 25 % hotter after: worse');
rs = D.rows([100, 102, 98, 100].map((k) => drv({ kwMax: k })), [drv({ kwMax: 103 })]);
ok(row(rs, 'kw').state === 'same', 'one drive after, +3 % against a spread of 1.6: within (twice the spread)');
rs = D.rows([90, 92, 91].map((o) => drv({ oilMax: o, kwMax: 150 })), [86, 87].map((o) => drv({ oilMax: o, kwMax: 162 })));
const hl = D.headline(rs, 'Service').map((h) => h.text);
ok(hl.length === 2 && /^Most power \+8 % after Service$/.test(hl[0]) && /^Oil runs 5 \u00b0C cooler after Service$/.test(hl[1]), 'the biggest changes in words: ' + hl.join('; '));
const L = [];
for (let i = 0; i < 16; i++) L.push(drv({ start: 1000 - i * 10, km: i % 4 === 0 ? 80 : 20 }));      // newest first
const sd = D.sides(L, [{ at: 925, label: 'Tyres' }], 0, 'all');
ok(sd.before.length === 8 && sd.after.length === 8 && sd.after[0].start === 930, 'before and after the mark, after in order from the mark');
const sl = D.sides(L, [{ at: 925, label: 'Tyres' }], 0, 'length');
ok(sl.before.every((d) => d.km === 20) && sl.after.every((d) => d.km === 20), 'similar length: the 80 km drives left out');


let impl = null;
const load = Module._load;
Module._load = function (req, parent, isMain) {
    if (req === './kit/mgu') return { run: (i) => { impl = i; } };
    if (req.startsWith('./kit/')) return load.call(this, path.join(KIT, req.slice(6)), parent, isMain);
    return load.call(this, req, parent, isMain);
};
(async () => {
    require(path.join(APP, 'main.js'));
    const spec = JSON.parse(fs.readFileSync(path.join(APP, 'app.json'), 'utf8'));
    const S = {}; spec.settings.forEach((s) => { if (s.key) S[s.key] = s.default; });
    const noop = () => {}, clicks = {};
    let frame = null, tab = null, texts = [];
    await impl.start({
        log: { info: noop, warn: noop, error: noop }, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'trip-app-')), spec,
        settings: { get: (k) => S[k], onChange: noop },
        signals: { watch: async () => ({ shutdown: async () => {} }) },
        ui: { image: async () => {}, onClick: (b, fn) => { clicks[b] = fn; }, isVisible: () => true },
        theme: () => themes.theme('m_tricolour'), loop: (n, fps, fn) => { frame = fn; }, onTab: (fn) => { tab = fn; },
        canvas: (w, h) => { const cv = new Recorder(w, h), text = cv.text.bind(cv); texts = []; cv.text = (s, ...a) => { texts.push(String(s)); return text(s, ...a); }; return cv; },
    });
    const page = async (i) => { await tab(i); await frame(); return texts.join(' | '); };
    let s = await page(0);
    ok(/LAST DRIVE/.test(s) && /DISTANCE/.test(s) && /HARD BRAKES/.test(s) && /DEMO/.test(s), 'Last drive: the tiles, in the demo');
    await clicks.BTN_NEXT();
    s = await page(1);
    ok(/These 15 drives/.test(s) && /Chosen:/.test(s), 'Drives: the newest 15 demo drives, one chosen');
    s = await page(2);
    ok(/\| the one before \|/.test(s) && /Hard brakes/.test(s) && /%\)/.test(s), 'Compare: with the one before, the differences');
    S.compareWith = 'avg10';
    s = await page(2);
    ok(/\| average \|/.test(s), 'Compare: with the average of the last 10');
    s = await page(3);
    ok(/Before and after: Service/.test(s) && /Most power \+\d+ % after Service/.test(s) && /Oil runs \d \u00b0C cooler after Service/.test(s)
        && /within normal variation/.test(s) && /Mark 2 of 2/.test(s), 'Before / After: the Service mark, its changes in words and bars');
    await clicks.BTN_PREV();
    s = await page(3);
    ok(/Before and after: Tyres/.test(s) && /Peak g, any way \+\d+ %/.test(s) && /Mark 1 of 2/.test(s), 'Previous: the older mark, Tyres, peak g up');
    await clicks.BTN_MARK();
    s = await page(3);
    ok(/Press Mark a change again/.test(s), 'Mark a change once: asks again');
    await clicks.BTN_MARK();
    s = await page(3);
    ok(/Mark 3 of 3/.test(s) && /Before and after: Service/.test(s) && /No all drives after this mark yet|after this mark yet/.test(s), 'Mark a change twice: a new mark, nothing after it yet');
    s = await page(4);
    ok(/It notes every drive by itself/.test(s) && /Before \/ After shows what a change did/.test(s), 'How it works');
    console.log('trip recap: ' + checks + ' checks, ' + fails + ' failed');
    process.exit(fails ? 1 : 0);
})().catch((e) => { console.log('FAIL ' + (e && e.stack || e)); process.exit(1); });
