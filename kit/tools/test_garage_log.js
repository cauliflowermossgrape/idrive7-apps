'use strict';
// Garage Log: a refuel is seen by itself while parked and saved with one tap; consumption per tank and per brand;
// care by weeks; odometer milestones; parts and bookmarks kept over a restart; and the app draws its seven pages
// (demo and empty) against a stubbed head unit. No SDK or car needed:
//   node kit/tools/test_garage_log.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const ROOT = path.resolve(__dirname, '..', '..'), KIT = path.join(ROOT, 'kit', 'runtime');
const APP = path.join(ROOT, 'apps', 'garage_log');
const { Recorder } = require(path.join(KIT, 'record'));
const themes = require(path.join(KIT, 'themes'));
const { Garage, consumption, byBrand, careState, milestoneRate, SETTLE_MS, WEEK, DAY } = require(path.join(APP, 'garage'));

let checks = 0, fails = 0;
const ok = (c, m) => { checks++; if (!c) { fails++; console.log('FAIL ' + m); } else console.log('ok   ' + m); };

// parked, 10 l in the tank, the pump adds 40 l over a minute, then it stays
const g = new Garage();
let t = 1000;
for (let i = 0; i < 10; i++) { g.feed({ speed: 0, tank: 10, odo: 50000 }, t); t += 2000; }
for (let l = 12; l <= 50; l += 2) { g.feed({ speed: 0, tank: l, odo: 50000 }, t); t += 2000; }
ok(!g.pending, 'no refuel until the level has stayed up a minute');
for (let i = 0; i < 40; i++) { g.feed({ speed: 0, tank: 50, odo: 50000 }, t); t += 2000; }
ok(g.pending && g.pending.litres === 40 && g.pending.before === 10 && g.pending.after === 50 && g.pending.km === 50000, 'refuel seen: 10 > 50 l at 50 000 km');
const saved = g.saveRefuel('omv', 98);
ok(saved && saved.brand === 'omv' && saved.octane === 98 && g.fuel.length === 1 && !g.pending, 'one tap saves it with brand and octane');
const g2 = new Garage();
for (let i = 0; i < 50; i++) { g2.feed({ speed: 40, tank: 10 + i, odo: 50000 + i }, t + i * 2000); }
ok(!g2.pending, 'a level rising while driving (sloshing, a slope) is not a refuel');
const rows = consumption([{ at: 1, km: 1000, litres: 40, brand: 'omv' }, { at: 2, km: 1600, litres: 45, brand: 'nis' }, { at: 3, km: 2200, litres: 42, brand: 'omv' }]);
ok(rows[0].perHundred === null && rows[1].perHundred === 7.5 && rows[2].perHundred === 7, 'per tank: litres against the km since the refuel before');
const bb = byBrand(rows);
ok(bb[0].brand === 'omv' && bb[0].avg === 7 && bb[1].avg === 7.5, 'per brand, lowest first');
const cs = careState({ wash: { at: 0 }, wax: { at: 10 * WEEK } }, 11 * WEEK);
ok(cs[0].key === 'wash' && cs[0].state === 'due' && cs.find((c) => c.key === 'wax').state === 'ok' && cs.find((c) => c.key === 'polish').state === 'never', 'care: due, ok, never marked');
const gm = new Garage();
gm.feed({ speed: 50, odo: 59990 }, 0); gm.feed({ speed: 50, odo: 60010 }, 1000);
ok(gm.milestones.length === 1 && gm.milestones[0].km === 60000, 'odometer passing 60 000 km noted');
gm.feed({ speed: 50, odo: 75000 }, 2000);
ok(gm.milestones.length === 1, 'a jump (a new car or a corrected reading) is not a milestone');
const mr = milestoneRate([{ km: 10000, at: 0 }, { km: 20000, at: 200 * DAY }], 25000, 300 * DAY);
ok(Math.round(mr.perDay) === 50 && mr.nextKm === 30000 && Math.round((mr.nextAt - 300 * DAY) / DAY) === 100, 'pace 50 km a day, next 30 000 km in 100 days');
g.markPart('Brake pads', 50000, 5); g.bookmark({ km: 50010, tank: 49 }, 6);
const back = new Garage(JSON.parse(JSON.stringify(g.toJSON())));
ok(back.fuel.length === 1 && back.parts[0].type === 'Brake pads' && back.marks[0].tank === 49, 'kept over a restart');

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
        const noop = () => {}, clicks = {}, dir = fs.mkdtempSync(path.join(os.tmpdir(), 'garage-'));
        let frame = null, tab = null, texts = [];
        await impl.start({
            log: { info: noop, warn: noop, error: noop }, dataDir: dir, spec,
            settings: { get: (k) => S[k], set: (k, v) => { S[k] = v; }, onChange: noop }, signals: { watch: async () => ({ shutdown: async () => {} }) },
            ui: { image: async () => {}, onClick: (b, fn) => { clicks[b] = fn; }, isVisible: () => true }, onTab: (fn) => { tab = fn; },
            theme: () => themes.theme('m_tricolour'), loop: (n, fps, fn) => { frame = fn; },
            canvas: (w, h) => { const cv = new Recorder(w, h), text = cv.text.bind(cv); texts = []; cv.text = (x, ...a) => { texts.push(String(x)); return text(x, ...a); }; return cv; },
        });
        const page = async (i) => { await tab(i); await frame(); return texts.join(' | '); };
        const again = async () => { await frame(); return texts.join(' | '); };
        return { page, again, clicks, S, dir };
    };
    const d = await run('on');
    let p = await d.page(0);
    ok(/REFUEL SEEN/.test(p) && /\+46 l/.test(p) && /Mark: save it as OMV 95/.test(p) && /PER BRAND/.test(p) && /white line: average/.test(p), 'demo Fuel: the waiting refuel, per tank and per brand');
    p = await d.page(1);
    ok(/Tune \/ map/.test(p) && /km ago/.test(p) && /Mark twice: fitted today/.test(p), 'demo Parts: the odometer line and the table');
    p = await d.page(2);
    ok(/due: \d+ weeks ago/.test(p) && /DUE NOW/.test(p) && /not marked yet/.test(p), 'demo Care: intervals, due and never');
    p = await d.page(3);
    ok(/\d+:\d\d/.test(p) && /LEFT/.test(p) && /Started/.test(p), 'demo Parking: the countdown');
    p = await d.page(4);
    ok(/GOOD TO GO|CHECK FIRST/.test(p) && /Fuel and range/.test(p) || /690 km/.test(p), 'demo Ready?: the verdict and the cards');
    p = await d.page(5);
    ok(/NEXT MILESTONE/.test(p) && /50 000 km around/.test(p) && /km a day/.test(p), 'demo Milestones: the pace and the next one');
    p = await d.page(6);
    ok(/Refuels save themselves/.test(p) && /no keyboard/.test(p), 'How it works');

    const e = await run('off');
    p = await e.page(0);
    ok(/No refuel waiting/.test(p) && /Two refuels are needed/.test(p), 'empty Fuel: plain words, no fake numbers');
    await e.page(1); await e.clicks.BTN_MARK(); p = await e.again();
    ok(/Press Mark again to note it/.test(p), 'Parts: Mark once only asks');
    await e.clicks.BTN_MARK(); p = await e.again();
    ok(/Oil and filter/.test(p) && /noted/.test(p), 'Parts: Mark twice notes the part');
    await e.page(3); await e.clicks.BTN_NEXT(); ok(e.S.parkMin === 120, 'Parking: Next steps the time');
    await e.clicks.BTN_MARK(); p = await e.again();
    ok(/Started/.test(p) && /LEFT/.test(p), 'Parking: Mark starts the countdown');
    await e.clicks.BTN_BOOKMARK(); p = await e.again();
    ok(/Bookmarked/.test(p), 'Bookmark now from any page');
    await new Promise((r) => setTimeout(r, 50));
    process.emit('exit');
    const file = JSON.parse(fs.readFileSync(path.join(e.dir, 'garage.json'), 'utf8'));
    ok(file.parts.length === 1 && file.marks.length === 1, 'saved to garage.json');
    console.log('garage_log: ' + checks + ' checks, ' + fails + ' failed');
    process.exit(fails ? 1 : 0);
})().catch((err) => { console.log('FAIL ' + (err && err.stack || err)); process.exit(1); });
