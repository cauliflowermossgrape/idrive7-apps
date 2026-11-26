'use strict';
// Service's own pages (more.js, extras.js): your own intervals next to the car's items, wheels, the 12 V battery at every
// start, refuels, parts, care and milestones. The arithmetic first, then the app against a stubbed head unit with one
// background for all of it (no SDK, no car):
//   node kit/tools/test_service_more.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const ROOT = path.resolve(__dirname, '..', '..'), KIT = path.join(ROOT, 'kit', 'runtime');
const APP = path.join(ROOT, 'apps', 'service');
const { Recorder } = require(path.join(KIT, 'record'));
const themes = require(path.join(KIT, 'themes'));

let checks = 0, fails = 0;
const ok = (c, m) => { checks++; if (!c) { fails++; console.log('FAIL ' + m); } else console.log('ok   ' + m); };
const D = 86400000;

/* the kit as the build puts it beside the app (./kit/...), the 12 V reads stubbed */
let impl = null, reads = 0;
const volts = { now: 12.48 };
const load = Module._load;
Module._load = function (req, parent, isMain) {
    if (req === './kit/mgu') return { run: (i) => { impl = i; } };
    if (req === './kit/diag') {
        const real = load.call(this, path.join(KIT, 'diag'), parent, isMain);
        return Object.assign({}, real, { Diag: class { constructor() { this.available = true; } init() {} on() {} } });
    }
    if (req === './kit/dids') {
        const real = load.call(this, path.join(KIT, 'dids'), parent, isMain);
        return Object.assign({}, real, { DidReader: class {
            async read(c) { reads++; return c.did === 'F442' && c.ecu === 18 ? volts.now : null; }
            key(c) { return c.ecu + ':' + (c.did || 'obd ' + c.obd); }
        } });
    }
    if (req.startsWith('./kit/')) return load.call(this, path.join(KIT, req.slice(6)), parent, isMain);
    return load.call(this, req, parent, isMain);
};

/* ---------- your own intervals: km and months left ---------- */
const { ITEMS, status } = require(path.join(APP, 'own_items'));
const oil = ITEMS[0], fluid = ITEMS.find((i) => i.key === 'brakeFluid'), now0 = Date.UTC(2026, 10, 26);
ok(status(oil, 7000, { km: 40000, at: now0 }, 45000, now0).left === 2000 && status(oil, 7000, { km: 40000, at: now0 }, 45000, now0).state === 'ok', '2000 km left: ok');
ok(status(oil, 7000, { km: 40000, at: now0 }, 46500, now0).state === 'soon', '500 km left: soon');
ok(status(oil, 7000, { km: 40000, at: now0 }, 47300, now0).left === -300 && status(oil, 7000, { km: 40000, at: now0 }, 47300, now0).state === 'due', '300 km over: due');
ok(status(oil, 0, null, 1, now0).off && status(oil, 7000, null, 1, now0).state === 'unknown', 'interval 0: off; never marked: unknown');
ok(status(oil, 7000, { km: 1, at: now0 }, null, now0).state === 'unknown', 'no odometer: unknown');
ok(status(fluid, 24, { at: now0 - 710 * D }, null, now0).state === 'soon' && status(fluid, 24, { at: now0 - 800 * D }, null, now0).state === 'due', 'brake fluid by months, no odometer needed');

/* ---------- wheels and the wear estimate ---------- */
const Wh = require(path.join(APP, 'own_wheels'));
const ps = Wh.perSet({ swaps: [{ set: 'summer', km: 1000, at: 1 }, { set: 'winter', km: 6000, at: 2 }, { set: 'summer', km: 9000, at: 3 }, { set: 'winter', km: 15000, at: 4 }] }, 15500);
ok(ps.summer.total === 11000 && ps.summer.season === 6000 && ps.winter.total === 3500 && ps.winter.season === 500, 'wheels: km per set, this season and in all');
const Wear = require(path.join(APP, 'own_wear'));
let tt = 0, got = null;
const rec = new Wear.DriveRecorder({ now: () => tt, onDrive: (d) => { got = d; } });
const sec = (n, v) => { for (let i = 0; i < n; i++) { tt += 1000; rec.sample(v); } };
sec(600, { speed: 36, rpm: 1500, oil: 70, gLong: 0, kw: 20 });
sec(1, { speed: 50, rpm: 1500, oil: 70, gLong: -0.7, kw: 0 });
sec(2, { speed: 50, rpm: 1500, oil: 70, gLong: -0.7, kw: 0 });
sec(200, { speed: 0, rpm: 0, oil: 70 });
ok(got && Math.abs(got.km - 6.0) < 0.2 && got.maxOil === 70 && got.hardStops === 1, 'wear: a drive recorded (6 km, oil max 70, one hard stop)');
const shortCold = Array.from({ length: 20 }, (_, i) => ({ at: i, km: 4, maxOil: 60, movingS: 600, slowS: 300, hotS: 0, hardStops: 0, highS: 0 }));
const e = Wear.estimate(oil, shortCold);
ok(e.enough && e.extra > 30 && e.extra <= Wear.CAP, 'wear: short cold trips raise the engine oil estimate, capped: +' + e.extra.toFixed(1) + ' %');
ok(Wear.estimate(oil, Array.from({ length: 5 }, (_, i) => ({ at: i, km: 40, maxOil: 100, movingS: 1800, slowS: 60, hotS: 0, hardStops: 0, highS: 0 }))).extra === 0, 'wear: long warm drives add nothing');
ok(!Wear.estimate(fluid, shortCold).applies, 'wear: brake fluid has no driving factor');

/* ---------- the start log (Battery) on a made-up clock ---------- */
const { StartLog, trend } = require(path.join(APP, 'battery_log'));
let t = 1e12;
const entries = [];
const L = new StartLog({ now: () => t, onEntry: (x) => entries.push(x) });
const step = (ms, v, rpm) => { t += ms; if (rpm !== undefined) L.rpm(rpm, t); if (v !== undefined) L.volt(v, t); };
step(1000, 12.55, 0); step(1000, 12.40, 0);
ok(L.current().rest === 12.55 && L.phase() === 'rest', 'battery: resting, the first reading after the wake');
step(1000, 11.9, 0); step(500, undefined, 150);
ok(L.phase() === 'crank', 'battery: the engine turns: starting');
step(500, 10.1); step(300, undefined, 800); step(700, 10.6); step(1000, 13.9);
ok(L.phase() === 'run' && L.current().crank === 10.1, 'battery: the lowest seen while starting');
for (let i = 0; i < 700; i++) step(1000, i % 3 ? 14.4 : 12.7);
ok(entries.length === 1 && entries[0].rest === 12.55 && entries[0].crank === 10.1 && entries[0].run === 14.4, 'battery: after 10 minutes the start is in the diary');
ok(trend([12.6, 12.55, 12.5, 12.45, 12.4]).slope < -0.04 && trend([1, 2]) === null, 'battery: the trend line');

/* ---------- the garage: refuels, consumption, care, milestones ---------- */
const { Garage, consumption, byBrand, careState, milestoneRate, WEEK } = require(path.join(APP, 'garage'));
const g = new Garage();
let gt = 1000;
for (let i = 0; i < 10; i++) { g.feed({ speed: 0, tank: 10, odo: 50000 }, gt); gt += 2000; }
for (let l = 12; l <= 50; l += 2) { g.feed({ speed: 0, tank: l, odo: 50000 }, gt); gt += 2000; }
ok(!g.pending, 'garage: no refuel until the level stayed up a minute');
for (let i = 0; i < 40; i++) { g.feed({ speed: 0, tank: 50, odo: 50000 }, gt); gt += 2000; }
ok(g.pending && g.pending.litres === 40 && g.pending.before === 10 && g.pending.after === 50, 'garage: refuel seen, 10 > 50 l');
const g2 = new Garage();
for (let i = 0; i < 50; i++) g2.feed({ speed: 40, tank: 10 + i, odo: 50000 + i }, gt + i * 2000);
ok(!g2.pending, 'garage: a level rising while driving is not a refuel');
const rows = consumption([{ at: 1, km: 1000, litres: 40, brand: 'omv' }, { at: 2, km: 1600, litres: 45, brand: 'nis' }, { at: 3, km: 2200, litres: 42, brand: 'omv' }]);
ok(rows[0].perHundred === null && rows[1].perHundred === 7.5 && rows[2].perHundred === 7 && byBrand(rows)[0].brand === 'omv', 'garage: per tank and per brand');
const cs = careState({ wash: { at: 0 }, wax: { at: 10 * WEEK } }, 11 * WEEK);
ok(cs[0].state === 'due' && cs.find((c) => c.key === 'wax').state === 'ok' && cs.find((c) => c.key === 'polish').state === 'never', 'garage: care due, ok, never marked');
const gm = new Garage();
gm.feed({ speed: 50, odo: 59990 }, 0); gm.feed({ speed: 50, odo: 60010 }, 1000); gm.feed({ speed: 50, odo: 75000 }, 2000);
ok(gm.milestones.length === 1 && gm.milestones[0].km === 60000, 'garage: 60 000 km noted, a jump is not a milestone');
const mr = milestoneRate([{ km: 10000, at: 0 }, { km: 20000, at: 200 * D }], 25000, 300 * D);
ok(Math.round(mr.perDay) === 50 && mr.nextKm === 30000, 'garage: pace 50 km a day, next 30 000 km');

/* ---------- the app ---------- */
const KOMBI = 'de.bmw.infotainment.KombiIF', CDS = 'de.bmw.infotainment.vehicle.CDS';
(async () => {
    const spec = JSON.parse(fs.readFileSync(path.join(APP, 'app.json'), 'utf8'));
    ok(spec.autostart === true && spec.config.battery.v12[0].did === 'F442' && !spec.settings.some((s) => s.key === 'parkMin'), 'app.json: autostart, eDrive\'s 12 V candidates, no parking timer');
    const runs = [];
    const run = async (opts) => {
        delete require.cache[path.join(APP, 'main.js')];
        require(path.join(APP, 'main.js'));
        const S = {}; spec.settings.forEach((s) => { if (s.key) S[s.key] = s.default; }); S.demo = opts.demo || 'off';
        const noop = () => {}, clicks = {}, h = {};
        let frame = null, tab = null, layout = null, texts = [], last = null;
        const ctx = {
            log: { info: noop, warn: noop, error: noop }, dataDir: opts.dir, spec,
            settings: { get: (k) => S[k], set: (k, v) => { S[k] = v; }, onChange: noop },
            signals: { watch: async (iface, inst, hh) => { h[iface] = Object.assign(h[iface] || {}, hh); return { shutdown: async () => {} }; } },
            ui: { image: async () => {}, onClick: (b, fn) => { clicks[b] = fn; }, isVisible: () => false, onVisible: noop },
            onTab: (fn) => { tab = fn; }, theme: () => themes.theme('m_tricolour'), loop: (n, fps, fn) => { frame = fn; },
            hideButton: noop, onLayout: (fn) => { layout = fn; }, sheet: () => true,
            canvas: (w, hh) => { const cv = new Recorder(w, hh), text = cv.text.bind(cv); cv.own = !!opts.own; last = cv; texts = []; cv.text = (s, ...a) => { texts.push(String(s)); return text(s, ...a); }; return cv; },
        };
        ctx.background = await impl.background(ctx);
        runs.push(ctx.background);
        await impl.start(ctx);
        const draw = async () => { layout(); await frame(); return texts.join(' | '); };
        return { S, clicks, h, bg: ctx.background, draw, page: async (i) => { tab(i); return draw(); }, targets: () => last.targets, dir: opts.dir };
    };
    const P = { Service: 0, Intervals: 2, Wheels: 3, Battery: 4, Fuel: 5, Garage: 6, Help: 7 };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'service-more-'));
    let a = await run({ dir });
    let x = await a.page(P.Service);
    ok(!/YOUR OWN/.test(x), 'Service page: no own rows until one is marked');
    a.h[KOMBI].statusRangeTankStatus({ mileageKilometre: 50000, fluidLevelFuelTank: 30, range: 400 });
    x = await a.page(P.Intervals);
    ok(/50 000 km/.test(x) && /not marked yet/.test(x) && !/DEMO/.test(x), 'Intervals: the odometer from the background, nothing marked yet');
    a.clicks.BTN_RESET();
    x = await a.draw();
    ok(!fs.existsSync(path.join(dir, 'own.json')) && /Press Reset service again/.test(x), 'Intervals: Reset service once only asks');
    a.clicks.BTN_RESET();
    x = await a.draw();
    ok(/LEFT \| 10 000 \|/.test(x) && /1 FINE/.test(x), 'Intervals: twice marks engine oil, 10 000 km left');
    x = await a.page(P.Service);
    ok(/Engine oil/.test(x) && /10 000 km left/.test(x) && /YOUR OWN, OK/.test(x), 'Service page: your own engine oil next to the car\'s items, marked YOUR OWN: ' + x);
    a.h[KOMBI].statusRangeTankStatus({ mileageKilometre: 59500 });
    x = await a.page(P.Intervals);
    ok(/LEFT \| 500 \|/.test(x) && /1 SOON/.test(x), 'Intervals: after 9 500 km, 500 km left, soon');
    runs.forEach((b) => b.stop());
    a = await run({ dir });
    a.h[KOMBI].statusRangeTankStatus({ mileageKilometre: 60200 });
    x = await a.page(P.Intervals);
    ok(/OVERDUE \| 200 \|/.test(x) && /1 DUE/.test(x), 'kept over a restart: 200 km overdue');
    x = await a.page(P.Service);
    ok(/\| 0 \| items \| 0 \| items \|/.test(x) && /YOUR OWN, DUE/.test(x), 'Service page: the car\'s tiles count the car\'s items only; the own row says due: ' + x);
    a.clicks.BTN_RESET(); a.clicks.BTN_RESET();
    a.h[KOMBI].statusRangeTankStatus({ mileageKilometre: 61000 });
    x = await a.page(P.Intervals);
    ok(/LEFT \| 9 200 \|/.test(x), 'Service page: Reset service twice on an own row marks it (not the car\'s reset)');
    a.clicks.BTN_DETAILS();
    x = await a.draw();
    ok(/your interval 10 000 km/.test(x) && /10 200/.test(x) && /HISTORY 2\/3/.test(x), 'Intervals > History (Details: next view): the km between services against the interval');
    const own = JSON.parse(fs.readFileSync(path.join(dir, 'own.json'), 'utf8'));
    ok(own.oil.history.length === 2 && own.oil.km === 60200, 'own.json keeps the last service and its history');

    x = await a.page(P.Wheels);
    ok(/No swap marked yet/.test(x), 'Wheels: nothing marked yet');
    a.clicks.BTN_SELECT(); a.clicks.BTN_RESET();
    x = await a.draw();
    ok(/Press again: Winter wheels/.test(x), 'Wheels: once only asks');
    a.clicks.BTN_RESET();
    x = await a.draw();
    ok(/WINTER WHEELS/.test(x) && /AFTER 50 TO 100 KM/.test(x) && !/\bNm\b/.test(x), 'Wheels: winter on, the bolts reminder, no torque figure invented');

    // the 12 V battery: read with UDS while the car rests after the wake
    a.h[CDS].statusEngineSpeed2({ actualValueRPMEngineCrankshaft: 0 });
    await new Promise((r) => setTimeout(r, 900));
    x = await a.page(P.Battery);
    ok(reads > 0 && /12\.48/.test(x) && /WEAK/.test(x) && !/DEMO/.test(x), 'Battery: the voltage read, the resting value on its scale');
    const before = reads;
    a.h['de.bmw.infrastructure.VehicleCondition'].VehicleCondition({ statusConditionVehicle: 1 });
    await new Promise((r) => setTimeout(r, 1300));
    ok(reads === before, 'Battery: locked and left, no more reads');

    // a refuel while parked, seen by the background's garage, saved with one press
    const gg = a.bg.garage;
    let ft = Date.now();
    for (let i = 0; i < 10; i++) { gg.feed({ speed: 0, tank: 12, odo: 61000 }, ft); ft += 2000; }
    for (let i = 0; i < 40; i++) { gg.feed({ speed: 0, tank: 52, odo: 61000 }, ft); ft += 2000; }
    x = await a.page(P.Fuel);
    ok(/REFUEL SEEN/.test(x) && /\+40/.test(x) && /Two refuels are needed/.test(x), 'Fuel: the refuel waiting, no fake consumption');
    a.clicks.BTN_RESET();
    x = await a.draw();
    ok(/Saved: 40 l/.test(x) && JSON.parse(fs.readFileSync(path.join(dir, 'garage.json'), 'utf8')).fuel.length === 1, 'Fuel: saved, garage.json written');
    x = await a.page(P.Garage);
    ok(/Nothing noted yet/.test(x) && /PARTS 1\/3/.test(x), 'Garage > Parts: empty, plain words');
    a.clicks.BTN_RESET(); a.clicks.BTN_RESET();
    x = await a.draw();
    ok(/Oil and filter noted at 61 000 km/.test(x), 'Garage > Parts: twice notes the part');
    a.clicks.BTN_DETAILS(); a.clicks.BTN_SELECT(); a.clicks.BTN_RESET(); a.clicks.BTN_RESET();
    x = await a.draw();
    ok(/CARE 2\/3/.test(x) && /Interior clean: done today/.test(x), 'Garage > Care: Next item chooses, twice marks it done');
    a.clicks.BTN_DETAILS();
    x = await a.draw();
    ok(/NEXT MILESTONE/.test(x) && /MILESTONES 3\/3/.test(x), 'Garage > Milestones');
    x = await a.page(P.Help);
    ok(/Your own intervals, next to BMW's/.test(x) && /Nothing is written to the car/.test(x), 'How it works: in plain words');
    runs.forEach((b) => b.stop());

    // where the kit runs the screen: tap a card, Done now, Confirm; the view switch on the page
    const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'service-more-'));
    a = await run({ dir: d2, own: true });
    a.h[KOMBI].statusRangeTankStatus({ mileageKilometre: 30000 });
    x = await a.page(P.Intervals);
    let tg = a.targets().find((q) => q.key === 'own-card-plugs');
    tg.run(); x = await a.draw();
    const done = () => a.targets().find((q) => q.key === 'own-done-plugs');
    ok(done(), 'own screen: the chosen card has Done now');
    done().run(); x = await a.draw();
    ok(/CONFIRM/i.test(x) && !fs.existsSync(path.join(d2, 'own.json')), 'own screen: Done now asks Confirm first');
    done().run(); x = await a.draw();
    ok(JSON.parse(fs.readFileSync(path.join(d2, 'own.json'), 'utf8')).plugs.km === 30000, 'own screen: Confirm marks the spark plugs');
    a.targets().find((q) => q.key === 'view-Intervals2').run();
    x = await a.draw();
    ok(/Bar: extra wear/.test(x), 'own screen: the view switch shows Driving');
    runs.forEach((b) => b.stop());

    // the demo: every page filled, never saved; no parking timer anywhere
    const d3 = fs.mkdtempSync(path.join(os.tmpdir(), 'service-more-'));
    a = await run({ dir: d3, demo: 'on' });
    let all = '';
    for (const p of [P.Intervals, P.Wheels, P.Battery, P.Fuel, P.Garage, P.Help]) { x = await a.page(p); all += x; ok(/DEMO/.test(x), 'demo: badge on tab ' + p); }
    ok(/REFUEL SEEN/.test(all) && /\+46/.test(all) && /WINTER WHEELS/.test(all) && /Engine running/.test(all), 'demo: refuel, wheels and the 12 V battery filled');
    ok(!/Parking|PARKING/.test(all) && !/Ready\?/.test(all), 'no parking timer, no Ready? page');
    ok(!fs.existsSync(path.join(d3, 'own.json')) && !fs.existsSync(path.join(d3, 'garage.json')), 'demo: nothing saved');
    runs.forEach((b) => b.stop());

    console.log('service more: ' + checks + ' checks, ' + fails + ' failed');
    process.exit(fails ? 1 : 0);
})().catch((err) => { console.log('FAIL ' + (err && err.stack || err)); process.exit(1); });
