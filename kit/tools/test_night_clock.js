'use strict';
// Night Clock: the time (24 h, 12 h with AM / PM, a blinking colon or seconds), dim figures, the outside temperature and
// speed under it as set. Against a stubbed head unit; no SDK or car needed:
//   node kit/tools/test_night_clock.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const ROOT = path.resolve(__dirname, '..', '..'), KIT = path.join(ROOT, 'kit', 'runtime');
const APP = path.join(ROOT, 'apps', 'night_clock');
const { Recorder } = require(path.join(KIT, 'record'));

let impl = null;
const load = Module._load;
Module._load = function (req, parent, isMain) {
    if (req === './kit/mgu') return { run: (i) => { impl = i; } };
    if (req.startsWith('./kit/')) return load.call(this, path.join(KIT, req.slice(6)), parent, isMain);
    return load.call(this, req, parent, isMain);
};
require(path.join(APP, 'main.js'));

let checks = 0, fails = 0;
const ok = (c, m) => { checks++; if (!c) { fails++; console.log('FAIL ' + m); } else console.log('ok   ' + m); };

const at = (h, m, s) => new Date(2026, 10, 26, h, m, s);
ok(impl.clockText(at(4, 7, 9), false).hm === '04:07', '24 h with a leading zero');
ok(impl.clockText(at(16, 7, 9), true).hm === '4:07' && impl.clockText(at(16, 7, 9), true).ampm === 'PM', '12 h: 4:07 PM');
ok(impl.clockText(at(0, 30, 0), true).hm === '12:30' && impl.clockText(at(0, 30, 0), true).ampm === 'AM', '12 h: midnight is 12 AM');

(async () => {
    const spec = JSON.parse(fs.readFileSync(path.join(APP, 'app.json'), 'utf8'));
    const S = {}; spec.settings.forEach((s) => { if (s.key) S[s.key] = s.default; }); S.demo = 'off'; S.speed = true;
    const noop = () => {}, handlers = {};
    let frame = null, texts = [];
    await impl.start({
        log: { info: noop, warn: noop, error: noop }, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'nc-')), spec,
        settings: { get: (k) => S[k], onChange: noop },
        signals: { watch: async (iface, inst, h) => { handlers[iface] = Object.assign(handlers[iface] || {}, h); return { shutdown: async () => {} }; } },
        ui: { image: async () => {}, isVisible: () => true },
        theme: () => ({}), loop: (n, fps, fn) => { frame = fn; },
        canvas: (w, h) => { const cv = new Recorder(w, h), text = cv.text.bind(cv); texts = []; cv.text = (s, ...a) => { texts.push(String(s)); return text(s, ...a); }; return cv; },
    });
    await new Promise((r) => setTimeout(r, 20));
    const env = handlers['de.bmw.infrastructure.EnvironmentalInformation'];
    ok(!!env && !!env.ExteriorTemperature, 'watches the outside temperature');
    env.ExteriorTemperature({ temperatureExterior: (7 + 40) * 2 });
    const veh = handlers['de.bmw.infotainment.vehicle.Vehicle2'];
    if (veh && veh.statusCarSpeed2) veh.statusCarSpeed2({ speedVehicleCentreOfGravity: Math.round(88 / 0.015625) });
    await frame();
    const all = texts.join(' | ');
    ok(texts.some((x) => /^\d\d[: ]\d\d$/.test(x)), 'the time drawn: ' + all);
    ok(texts.some((x) => /^7 °C {5}88 km\/h$/.test(x)), 'outside temperature and speed under it: ' + all);
    S.outside = false; S.speed = false;
    await frame();
    ok(!texts.some((x) => /°C|km\/h/.test(x)), 'both off: only the time');
    console.log('night clock: ' + checks + ' checks, ' + fails + ' failed');
    process.exit(fails ? 1 : 0);
})().catch((e) => { console.log('FAIL ' + (e && e.stack || e)); process.exit(1); });
