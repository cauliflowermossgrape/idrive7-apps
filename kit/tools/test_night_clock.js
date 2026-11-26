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
    let frame = null, texts = [], pos = [];
    await impl.start({
        log: { info: noop, warn: noop, error: noop }, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'nc-')), spec,
        settings: { get: (k) => S[k], onChange: noop },
        signals: { watch: async (iface, inst, h) => { handlers[iface] = Object.assign(handlers[iface] || {}, h); return { shutdown: async () => {} }; } },
        ui: { image: async () => {}, isVisible: () => true },
        theme: () => ({}), loop: (n, fps, fn) => { frame = fn; },
        canvas: (w, h) => { const cv = new Recorder(w, h), text = cv.text.bind(cv); texts = []; pos = []; cv.text = (s, ...a) => { texts.push(String(s)); pos.push([String(s), a[0], a[3]]); return text(s, ...a); }; return cv; },
    });
    await new Promise((r) => setTimeout(r, 20));
    const env = handlers['de.bmw.infrastructure.EnvironmentalInformation'];
    ok(!!env && !!env.ExteriorTemperature, 'watches the outside temperature');
    env.ExteriorTemperature({ temperatureExterior: (7 + 40) * 2 });
    const veh = handlers['de.bmw.infotainment.vehicle.Vehicle2'];
    if (veh && veh.statusCarSpeed2) veh.statusCarSpeed2({ speedVehicleCentreOfGravity: Math.round(88 / 0.015625) });
    await frame();
    const all = texts.join(' | ');
    ok(/^\d\d \| : \| \d\d \|/.test(all), 'the time drawn as hours, colon, minutes: ' + all);
    ok(texts.some((x) => /^7 °C {5}88 km\/h$/.test(x)), 'outside temperature and speed under it: ' + all);
    // the standby row: outside, 12 V charge and range from the car, '--' for what it has not sent
    ok(texts.includes('12 V BATTERY') && texts.includes('RANGE') && texts.includes('7 °C') && texts.filter((x) => x === '--').length === 2, 'status row: outside known, battery and range not yet: ' + all);
    const cds = handlers['de.bmw.infotainment.vehicle.CDS'], kombi = handlers['de.bmw.infotainment.KombiIF'];
    ok(!!cds && !!cds.statusBattery2 && !!kombi && !!kombi.statusRangeTankStatus, 'watches the 12 V charge and the range');
    cds.statusBattery2({ conditionBatteryChargingCondition: 81 });
    kombi.statusRangeTankStatus({ range: 47 });
    await frame();
    ok(texts.includes('81 %') && texts.includes('47 km'), 'status row: 81 % and 47 km');
    kombi.statusRangeTankStatus({ range: 4095 });
    S.status = false;
    await frame();
    ok(!texts.includes('RANGE'), 'status row off: not drawn');
    S.outside = false; S.speed = false;
    const RealDate = Date, place = async (sec) => {
        global.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [2026, 10, 26, 21, 47, sec])); } static now() { return new RealDate(2026, 10, 26, 21, 47, sec).getTime(); } };
        await frame();
        global.Date = RealDate;
        return pos.filter((p) => /^\d+$|^:$/.test(p[0]) && p[0] !== '').map((p) => p[0] + '@' + Math.round(p[1])).join(' ');
    };
    const on = await place(10), off = await place(11);
    ok(on === off && /^21@\S+ :@\S+ 47@\S+$/.test(on), 'the colon blinks in place, the figures do not move: ' + on + ' / ' + off);
    const colour = async (sec) => { await place(sec); return pos.find((p) => p[0] === ':')[2]; };
    ok((await colour(10)) !== (await colour(11)), 'the colon fades by colour, it is never taken away');
    await frame();
    ok(!texts.some((x) => /°C|km\/h/.test(x)), 'both off: only the time');
    console.log('night clock: ' + checks + ' checks, ' + fails + ' failed');
    process.exit(fails ? 1 : 0);
})().catch((e) => { console.log('FAIL ' + (e && e.stack || e)); process.exit(1); });
