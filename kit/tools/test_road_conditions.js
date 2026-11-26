'use strict';
// Road Conditions: ice risk from the outside temperature and its trend, side wind from the steering corrections on
// straight roads at speed (sideways g without steering), what wins on the Now page; and the app's pages against a
// stubbed head unit. No SDK or car needed:
//   node kit/tools/test_road_conditions.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const ROOT = path.resolve(__dirname, '..', '..'), KIT = path.join(ROOT, 'kit', 'runtime');
const APP = path.join(ROOT, 'apps', 'road_conditions');
const { Recorder } = require(path.join(KIT, 'record'));
const themes = require(path.join(KIT, 'themes'));
const C = require(path.join(APP, 'conditions'));

let checks = 0, fails = 0;
const ok = (c, m) => { checks++; if (!c) { fails++; console.log('FAIL ' + m); } else console.log('ok   ' + m); };
const T0 = Date.UTC(2026, 10, 26, 18, 0, 0);

/* 60 s of driving: f(i) gives the values each second. */
function drive(f, secs) {
    const tr = new C.Tracker();
    for (let i = 0; i <= (secs || 60); i++) tr.sample(f(i), T0 + i * 1000);
    return { tr, now: T0 + (secs || 60) * 1000 };
}
let d = drive((i) => ({ speed: 110, gLat: 0.01 * Math.sin(i), steer: 0.5 * Math.sin(i * 1.3), temp: 10 }));
ok(d.tr.points.length >= 5 && d.tr.points.every((p) => p.fast && p.straight), 'steady 110 km/h on a straight road: fast and straight points');
ok(C.wind(d.tr.points, d.now).state === 'calm' && C.wind(d.tr.points, d.now).by === 'steer', 'small corrections: calm, read from the steering');
d = drive((i) => ({ speed: 120, gLat: 0.03 * Math.sin(i), steer: i % 2 ? 4.5 : -4.5, temp: 10 }));
ok(C.wind(d.tr.points, d.now).state === 'gusty', 'steering +/- 4.5 deg again and again on a straight road: gusty');
d = drive((i) => ({ speed: 120, gLat: 0.25, steer: 30 + (i % 2 ? 4 : -4), temp: 10 }));
ok(C.wind(d.tr.points, d.now).state === 'unknown', 'a long curve: not counted (not straight)');
d = drive((i) => ({ speed: 50, gLat: 0, steer: i % 2 ? 5 : -5, temp: 10 }));
ok(C.wind(d.tr.points, d.now).state === 'unknown' && !d.tr.points[0].fast, 'in town at 50 km/h: not counted');
d = drive((i) => ({ speed: 110, gLat: i % 2 ? 0.05 : -0.05, steer: null, temp: 10 }));
ok(C.wind(d.tr.points, d.now).by === 'lat' && C.wind(d.tr.points, d.now).state === 'gusty', 'no steering signal: the sideways g is used');
const st = C.windStats(d.tr.points);
ok(st.fastMin === 1 && st.gustyMin === 1, 'stats: a minute straight above 80, a minute of it gusty');

const temps = [];
for (let m = 0; m <= 20; m++) temps.push({ t: T0 + m * 60000, c: 6 - 0.075 * m });
ok(Math.abs(C.trend(temps, T0 + 20 * 60000) + 1.5) < 1e-9, 'trend over 20 min: -1.5 deg');
ok(C.trend(temps.slice(0, 5), T0 + 4 * 60000) === null, 'under 10 min of readings: no trend');
d = drive(() => ({ temp: 3 }), 120);
ok(d.tr.temps.length === 5, 'the outside temperature kept every 30 s (0, 30, 60, 90, 120 s)');
ok(C.ice(-1, null).state === 'ice' && /freeze/.test(C.ice(-1, null).why), '-1 deg: ICE RISK, water can freeze');
ok(C.ice(3, null).state === 'ice', '3 deg: ICE RISK (at 4 and below)');
ok(C.ice(3, null, 2).state === 'clear', 'the line set to 2 deg: 3 deg is clear');
ok(C.ice(6, -1.5).state === 'watch' && C.ice(6, 0).state === 'clear', '6 deg falling fast: GETTING COLD; steady: clear');
ok(C.ice(null, null).state === 'unknown', 'no reading: waiting');
const calm = { state: 'calm' }, gusty = { state: 'gusty', why: 'g' }, none = { state: 'unknown' };
ok(C.overall(C.ice(2, null), gusty).title === 'ICE RISK', 'ice risk comes before gusts');
ok(C.overall(C.ice(10, null), gusty).title === 'GUSTY' && C.overall(C.ice(10, null), calm).title === 'CLEAR', 'gusty, else clear');
ok(C.overall(C.ice(null, null), none).title === 'WAITING', 'nothing from the car: waiting');

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
        let tab = null, frame = null, texts = [];
        await impl.start({
            log: { info: noop, warn: noop, error: noop }, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'rd-')), spec,
            settings: { get: (k) => S[k], onChange: noop },
            signals: { watch: async (iface, inst, hh) => { h[iface] = hh; return { shutdown: async () => {} }; } },
            ui: { image: async () => {}, onClick: noop, isVisible: () => true },
            onTab: (fn) => { tab = fn; }, theme: () => themes.theme('m_tricolour'), loop: (n, fps, fn) => { frame = fn; },
            canvas: (w, hh) => { const cv = new Recorder(w, hh), text = cv.text.bind(cv); texts = []; cv.text = (s, ...a) => { texts.push(String(s)); return text(s, ...a); }; return cv; },
        });
        await new Promise((r) => setTimeout(r, 20));
        return { h, tab: (i) => tab(i), draw: async () => { await frame(); return texts.join(' | '); } };
    };
    const a = await run('off');
    a.h['de.bmw.infrastructure.EnvironmentalInformation'].ExteriorTemperature({ temperatureExterior: 84 });
    a.h['de.bmw.infotainment.vehicle.Vehicle2'].statusCarSpeed2({ speedVehicleCentreOfGravity: 64 * 100 });
    let t = await a.draw();
    ok(/ICE RISK/.test(t) && /2\.0 °C outside/.test(t), 'Now: 2.0 deg from the car, ICE RISK and why: ' + t.slice(0, 200));
    ok(/NO SIGNAL/.test(t) && /no rain or wiper signal/.test(t), 'Now: the wet road said plainly, not guessed');
    ok(!/DEMO/.test(t), 'with the car: no DEMO badge');
    await a.tab(1); t = await a.draw();
    ok(/ice risk below 4 °C/.test(t) && /Bridges and overpasses/.test(t), 'Ice risk: the line on the chart and where ice forms first');
    await a.tab(2); t = await a.draw();
    ok(/estimate/.test(t) && /Not enough straight driving/.test(t), 'Side wind: an estimate, and says when it cannot tell yet');
    await a.tab(3); t = await a.draw();
    ok(/not possible on this car/.test(t) && /Nothing is asked of or written/.test(t), 'How it works: in plain words');
    const b = await run('on');
    t = await b.draw();
    ok(/DEMO/.test(t) && /ICE RISK/.test(t), 'demo: a cold evening, ICE RISK');
    await b.tab(2); t = await b.draw();
    ok(/STRAIGHT ABOVE 80/.test(t) && /breezy/.test(t) && /gusty/.test(t), 'demo: the side wind chart with its lines');
    console.log('road conditions: ' + checks + ' checks, ' + fails + ' failed');
    process.exit(fails ? 1 : 0);
})().catch((e) => { console.log('FAIL ' + (e && e.stack || e)); process.exit(1); });
