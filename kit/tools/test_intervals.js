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
    await a.tab(2);
    t = await a.draw();
    ok(/is not changed/.test(t) && /Done now again within 5 s/.test(t), 'How it works: in plain words');
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'intervals.json'), 'utf8'));
    ok(saved.oil.history.length === 2 && saved.oil.km === 60200, 'the file keeps the last service and its history');
    console.log('intervals: ' + checks + ' checks, ' + fails + ' failed');
    process.exit(fails ? 1 : 0);
})().catch((e) => { console.log('FAIL ' + (e && e.stack || e)); process.exit(1); });
