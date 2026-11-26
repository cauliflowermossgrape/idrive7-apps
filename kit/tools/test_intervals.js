'use strict';
// Service Intervals: km left / overdue, soon within 1000 km, brake fluid by months, off and unknown; and the app: Done now
// asks again, then marks the item at the odometer and keeps it. Against a stubbed head unit; no SDK or car needed:
//   node kit/tools/test_intervals.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const ROOT = path.resolve(__dirname, '..', '..'), KIT = path.join(ROOT, 'kit', 'runtime');
const APP = path.join(ROOT, 'apps', 'intervals');
const { Recorder } = require(path.join(KIT, 'record'));
const themes = require(path.join(KIT, 'themes'));
const { ITEMS, status } = require(path.join(APP, 'items'));

let checks = 0, fails = 0;
const ok = (c, m) => { checks++; if (!c) { fails++; console.log('FAIL ' + m); } else console.log('ok   ' + m); };
const oil = ITEMS[0], fluid = ITEMS.find((i) => i.key === 'brakeFluid'), D = 86400000, now = Date.UTC(2026, 10, 26);

ok(status(oil, 7000, { km: 40000, at: now }, 45000, now).left === 2000 && status(oil, 7000, { km: 40000, at: now }, 45000, now).state === 'ok', '2000 km left: ok');
ok(status(oil, 7000, { km: 40000, at: now }, 46500, now).state === 'soon', '500 km left: soon');
ok(status(oil, 7000, { km: 40000, at: now }, 47300, now).left === -300 && status(oil, 7000, { km: 40000, at: now }, 47300, now).state === 'due', '300 km over: due');
ok(status(oil, 0, null, 1, now).off, 'interval 0: off');
ok(status(oil, 7000, null, 1, now).state === 'unknown', 'never marked: unknown');
ok(status(oil, 7000, { km: 1, at: now }, null, now).state === 'unknown', 'no odometer: unknown');
ok(status(fluid, 24, { at: now - 710 * D }, null, now).state === 'soon', 'brake fluid 710 days into 24 months: soon, no odometer needed');
ok(status(fluid, 24, { at: now - 800 * D }, null, now).state === 'due', '800 days: due');

let impl = null;
const load = Module._load;
Module._load = function (req, parent, isMain) {
    if (req === './kit/mgu') return { run: (i) => { impl = i; } };
    if (req.startsWith('./kit/')) return load.call(this, path.join(KIT, req.slice(6)), parent, isMain);
    return load.call(this, req, parent, isMain);
};
(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'intervals-'));
    const spec = JSON.parse(fs.readFileSync(path.join(APP, 'app.json'), 'utf8'));
    const run = async () => {
        delete require.cache[path.join(APP, 'main.js')];
        require(path.join(APP, 'main.js'));
        const S = {}; spec.settings.forEach((s) => { if (s.key) S[s.key] = s.default; }); S.demo = 'off';
        const noop = () => {}, clicks = {}, h = {};
        let tab = null;
        let frame = null, texts = [];
        await impl.start({
            log: { info: noop, warn: noop, error: noop }, dataDir: dir, spec,
            settings: { get: (k) => S[k], onChange: noop },
            signals: { watch: async (iface, inst, hh) => { h[iface] = hh; return { shutdown: async () => {} }; } },
            ui: { image: async () => {}, onClick: (b, fn) => { clicks[b] = fn; }, isVisible: () => true },
            onTab: (fn) => { tab = fn; }, theme: () => themes.theme('m_tricolour'), loop: (n, fps, fn) => { frame = fn; },
            canvas: (w, hh) => { const cv = new Recorder(w, hh), text = cv.text.bind(cv); texts = []; cv.text = (s, ...a) => { texts.push(String(s)); return text(s, ...a); }; return cv; },
        });
        await new Promise((r) => setTimeout(r, 20));
        return { clicks, h, tab: (i) => tab(i), draw: async () => { await frame(); return texts.join(' | '); } };
    };
    let a = await run();
    a.h['de.bmw.infotainment.KombiIF'].statusRangeTankStatus({ mileageKilometre: 50000 });
    let t = await a.draw();
    ok(/50 000 km/.test(t) && /not marked yet/.test(t), 'the odometer shown, nothing marked yet');
    await a.clicks.BTN_DONE();
    ok(!fs.existsSync(path.join(dir, 'intervals.json')), 'Done now once: only asks');
    await a.clicks.BTN_DONE();
    t = await a.draw();
    ok(/LEFT \| 10 000 \|/.test(t) && /1 FINE/.test(t), 'Done now twice: engine oil marked, 10 000 km left, counted fine: ' + t);
    a.h['de.bmw.infotainment.KombiIF'].statusRangeTankStatus({ mileageKilometre: 59500 });
    t = await a.draw();
    ok(/LEFT \| 500 \|/.test(t) && /1 SOON/.test(t), 'after 9 500 km: 500 km left, counted soon');
    a = await run();
    a.h['de.bmw.infotainment.KombiIF'].statusRangeTankStatus({ mileageKilometre: 60200 });
    t = await a.draw();
    ok(/OVERDUE \| 200 \|/.test(t) && /1 DUE/.test(t), 'kept over a restart: 200 km overdue');
    await a.clicks.BTN_DONE(); await a.clicks.BTN_DONE();
    a.h['de.bmw.infotainment.KombiIF'].statusRangeTankStatus({ mileageKilometre: 61000 });
    await a.tab(1);
    t = await a.draw();
    ok(/Engine oil \| 60 200 km \| 26\.11\.2026 \| Engine oil \| 50 000 km/.test(t) && /60 200 km/.test(t), 'History: both services listed: ' + t);
    ok(/your interval 10 000 km/.test(t) && /10 200/.test(t), 'History: the km between them charted against the interval');
    await a.tab(4);
    t = await a.draw();
    ok(/See how hard your driving was on it/.test(t), 'How it works: the Driving tab explained');
    ok(/is not changed/.test(t) && /Done now again within 5 s/.test(t) && /Swap wheels/.test(t), 'How it works: in plain words, wheels included');
    // Wheels: nothing marked, then Winter picked and put on with Done now twice
    await a.tab(2);
    t = await a.draw();
    ok(/No swap marked yet/.test(t) && /After a swap, a reminder shows here/.test(t), 'Wheels: nothing marked yet');
    await a.clicks.BTN_NEXT();
    await a.clicks.BTN_DONE();
    t = await a.draw();
    ok(/Press Done now again: Winter wheels/.test(t), 'Wheels: Done now once only asks');
    await a.clicks.BTN_DONE();
    t = await a.draw();
    ok(/WINTER WHEELS/.test(t) && /AFTER 50 TO 100 KM: CHECK THE WHEEL BOLTS/.test(t) && /owner\'s manual|owner's manual/.test(t), 'Wheels: winter on, the bolts reminder from the swap');
    a.h['de.bmw.infotainment.KombiIF'].statusRangeTankStatus({ mileageKilometre: 61070 });
    t = await a.draw();
    ok(/CHECK THE WHEEL BOLTS AND PRESSURES NOW/.test(t) && /70 of 100 km since the swap/.test(t), 'Wheels: past 50 km the reminder says now');
    a.h['de.bmw.infotainment.KombiIF'].statusRangeTankStatus({ mileageKilometre: 61200 });
    t = await a.draw();
    ok(/Bolts and pressures: nothing due/.test(t) && /DRIVEN ON THEM \| 200/.test(t), 'Wheels: after 100 km the reminder goes, 200 km on the set: ' + t);
    ok(!/\bNm\b/.test(t), 'Wheels: no torque figure invented');
    const W = require(path.join(APP, 'wheels'));
    const w = { swaps: [{ set: 'summer', km: 1000, at: 1 }, { set: 'winter', km: 6000, at: 2 }, { set: 'summer', km: 9000, at: 3 }, { set: 'winter', km: 15000, at: 4 }] };
    const ps = W.perSet(w, 15500);
    ok(ps.summer.total === 11000 && ps.summer.season === 6000 && ps.winter.total === 3500 && ps.winter.season === 500, 'Wheels: km per set, this season and in all');
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'intervals.json'), 'utf8'));
    ok(saved.oil.history.length === 2 && saved.oil.km === 60200, 'the file keeps the last service and its history');
    ok(saved.wheels && saved.wheels.swaps.length === 1 && saved.wheels.swaps[0].set === 'winter' && saved.wheels.swaps[0].km === 61000, 'the file keeps the wheel swap');
    // the wear estimate: a drive recorder fed once a second, the rules, and the Driving tab from drives.json
    const Wear = require(path.join(APP, 'wear'));
    let tt = 0, got = null;
    const rec = new Wear.DriveRecorder({ now: () => tt, onDrive: (d) => { got = d; } });
    const sec = (n, v) => { for (let i = 0; i < n; i++) { tt += 1000; rec.sample(v); } };
    sec(600, { speed: 36, rpm: 1500, oil: 70, gLong: 0, kw: 20 });       // 10 min at 36 km/h: 6 km, oil stays cold
    sec(1, { speed: 50, rpm: 1500, oil: 70, gLong: -0.7, kw: 0 });        // one hard stop
    sec(2, { speed: 50, rpm: 1500, oil: 70, gLong: -0.7, kw: 0 });        // the same stop, not counted again
    sec(200, { speed: 0, rpm: 0, oil: 70 });                              // parked, engine off: the drive ends after 3 min
    ok(got && Math.abs(got.km - 6.0) < 0.2 && got.maxOil === 70 && got.hardStops === 1, 'wear: a drive recorded (6 km, oil max 70, one hard stop): ' + JSON.stringify(got));
    const shortCold = Array.from({ length: 20 }, (_, i) => ({ at: i, km: 4, maxOil: 60, movingS: 600, slowS: 300, hotS: 0, hardStops: 0, highS: 0 }));
    const e = Wear.estimate(ITEMS[0], shortCold);
    ok(e.enough && e.extra > 30 && e.extra <= Wear.CAP && Math.abs(e.wearKm - 80 * (1 + e.extra / 100)) < 1e-6, 'wear: short cold town trips raise the engine oil estimate, capped: +' + e.extra.toFixed(1) + ' %');
    const easy = Array.from({ length: 5 }, (_, i) => ({ at: i, km: 40, maxOil: 100, movingS: 1800, slowS: 60, hotS: 0, hardStops: 0, highS: 0 }));
    ok(Wear.estimate(ITEMS[0], easy).extra === 0, 'wear: long warm drives add nothing');
    ok(!Wear.estimate(fluid, shortCold).applies, 'wear: brake fluid has no driving factor');
    fs.writeFileSync(path.join(dir, 'drives.json'), JSON.stringify(shortCold.map((d, i) => Object.assign({}, d, { at: Date.now() + i }))));
    a = await run();
    a.h['de.bmw.infotainment.KombiIF'].statusRangeTankStatus({ mileageKilometre: 61300 });
    await a.tab(0);
    t = await a.draw();
    ok(/WEAR \+\d+%/.test(t), 'Overview: the engine oil card shows its wear chip');
    await a.tab(3);
    t = await a.draw();
    ok(/COUNTS AS ABOUT/.test(t) && /Short trips/.test(t) && /Cold engine/.test(t) && /not BMW data/.test(t), 'Driving: the factors and the estimate, labelled as such');
    console.log('intervals: ' + checks + ' checks, ' + fails + ' failed');
    process.exit(fails ? 1 : 0);
})().catch((e) => { console.log('FAIL ' + (e && e.stack || e)); process.exit(1); });
