'use strict';
// Ready Check: the verdict (cold / ready / too hot), the reminders that never block it, the tyres as a share of the
// car's own target, the gearbox signal only once it moves, and every page drawn from live values and from the demo.
// Against a stubbed head unit; no SDK or car needed:
//   node kit/tools/test_ready_check.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const ROOT = path.resolve(__dirname, '..', '..'), KIT = path.join(ROOT, 'kit', 'runtime');
const APP = path.join(ROOT, 'apps', 'ready_check');
const { Recorder } = require(path.join(KIT, 'record'));
const themes = require(path.join(KIT, 'themes'));
const { checks, verdict, rate } = require(path.join(APP, 'checks'));

let n = 0, fails = 0;
const ok = (c, m) => { n++; if (!c) { fails++; console.log('FAIL ' + m); } else console.log('ok   ' + m); };
const set = { warmOil: 80, warmCoolant: 80, warmGearbox: 60 };
const v = (s) => verdict(checks(s, set));

ok(v({}).word === 'NO DATA', 'nothing sent: NO DATA');
ok(v({ oil: 50, coolant: 85 }).word === 'NOT YET' && /engine oil/.test(v({ oil: 50, coolant: 85 }).why), 'cold oil: NOT YET, and says which');
ok(v({ oil: 95, coolant: 90, gearbox: 70 }).word === 'READY', 'all warm: READY');
ok(v({ oil: 95, coolant: 90 }).word === 'READY', 'a car without the gearbox signal can still be READY');
ok(v({ oil: 140, coolant: 90 }).word === 'TOO HOT', 'oil over 135: TOO HOT');
ok(v({ oil: 125, coolant: 90 }).word === 'READY' && checks({ oil: 125 }, set)[0].state === 'check', 'oil at 125: still ready, the card says hot');
const low = v({ oil: 95, coolant: 90, soc12: 45, range: 60, tyres: { lowest: 0.85, which: 'front left' } });
ok(low.word === 'READY' && low.notes.length === 3, 'battery, fuel and tyres are reminders, they never block: ' + low.notes.join('; '));
ok(/front left/.test(low.notes[2]), 'the low tyre is named');
const pts = [];
for (let i = 0; i < 20; i++) pts.push([i * 10000, 40 + i * 0.5]);
ok(Math.abs(rate(pts, 1, 190000) - 3) < 0.01, 'warming rate: 0.5 deg C in 10 s is 3 a minute');

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
        const S = {}; spec.settings.forEach((s) => { if (s.key) S[s.key] = s.default; }); S.demo = demo;
        const noop = () => {}, h = {};
        let frame = null, tab = null, texts = [];
        await impl.start({
            log: { info: noop, warn: noop, error: noop }, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'rc-')), spec,
            settings: { get: (k) => S[k], onChange: noop },
            signals: { watch: async (iface, inst, hh) => { h[iface] = Object.assign(h[iface] || {}, hh); return { shutdown: async () => {} }; } },
            ui: { image: async () => {}, onClick: noop, isVisible: () => true }, onTab: (fn) => { tab = fn; },
            theme: () => themes.theme('m_tricolour'), loop: (nm, fps, fn) => { frame = fn; },
            canvas: (w, hh) => { const cv = new Recorder(w, hh), text = cv.text.bind(cv); texts = []; cv.text = (s, ...a) => { texts.push(String(s)); return text(s, ...a); }; return cv; },
        });
        await new Promise((r) => setTimeout(r, 20));
        return { h, page: async (i) => { await tab(i); await frame(); return texts.join(' | '); } };
    };
    const a = await run('off');
    const CDS = 'de.bmw.infotainment.vehicle.CDS';
    ok(a.h[CDS] && a.h[CDS].statusBattery2 && a.h['de.bmw.infotainment.KombiIF'] && a.h['de.bmw.infotainment.vehicle.TPMS'], 'watches the battery, the range and the tyres');
    a.h[CDS].statusEngineTemperature({ temperatureEngineOilDrive: 48 + 92, temperatureEngineDrive: 48 + 88 });
    a.h[CDS].statusEngineSpeed2({ actualValueRPMEngineCrankshaft: 900 * 4 });
    a.h[CDS].statusBattery2({ conditionBatteryChargingCondition: 81 });
    a.h['de.bmw.infotainment.KombiIF'].statusRangeTankStatus({ range: 4095, fluidLevelFuelTank: 30 });
    const bds = a.h['de.bmw.infrastructure.analytics.BasicDataSet'].basicDataSet;
    bds({ valueTemperatureTransmissionOil: 48 + 40 });
    let t = await a.page(0);
    ok(/READY/.test(t) && /92/.test(t) && /81/.test(t), 'live: oil 92, battery 81, READY');
    ok(/-- \| \u00b0C \| not sent by this car yet \| 60/.test(t), 'a gearbox value that has not moved is no reading yet');
    ok(/-- \| km \| not sent by this car yet/.test(t), 'range 4095 is "no value"');
    bds({ valueTemperatureTransmissionOil: 48 + 42 });
    t = await a.page(0);
    ok(/NOT YET/.test(t) && /gearbox oil is still cold/.test(t), 'once it moves the gearbox oil counts: 42 deg C, NOT YET');
    const tp = a.h['de.bmw.infotainment.vehicle.TPMS'];
    tp.statusTargetTyrePressure({ targetPressureTyreFLH: 240, targetPressureTyreFRH: 240, targetPressureTyreRLH: 260, targetPressureTyreRRH: 260 });
    tp.statusTyrePressure({ actualValuePressureTyreFLH: 238, actualValuePressureTyreFRH: 236, actualValuePressureTyreRLH: 221, actualValuePressureTyreRRH: 65535 });
    t = await a.page(0);
    ok(/85/.test(t) && /low: rear left/.test(t) && /ALSO CHECK/.test(t), 'tyres: rear left at 85 % of its target, listed under the verdict');
    t = await a.page(1);
    ok(/oil ready band/.test(t) && /Engine oil \| 92/.test(t), 'Trend drawn');
    t = await a.page(2);
    ok(/Nothing to cool down/.test(t), 'After the drive: no hard driving yet');
    t = await a.page(3);
    ok(/It watches what the car sends/.test(t) && /estimate/.test(t), 'How it works drawn');
    const d = await run('on');
    t = await d.page(0);
    ok(/DEMO/.test(t) && /NOT YET/.test(t) && /READY IN ABOUT/.test(t), 'demo: a cold gearbox, ready in a few minutes');
    t = await d.page(2);
    ok(/Drive gently/.test(t) && /asks for 126 s/.test(t), 'demo: a cool-down counting down');
    console.log('ready_check: ' + n + ' checks, ' + fails + ' failed');
    process.exit(fails ? 1 : 0);
})().catch((e) => { console.log('FAIL ' + (e && e.stack || e)); process.exit(1); });
