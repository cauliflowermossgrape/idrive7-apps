'use strict';
// Battery Diary: one entry per start (resting before, the lowest seen while starting, the charging middle value), auto
// start / stop not counted, the verdict; and the app against a stubbed head unit and a stubbed UDS reader (no car):
//   node kit/tools/test_battery_diary.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const ROOT = path.resolve(__dirname, '..', '..'), KIT = path.join(ROOT, 'kit', 'runtime');
const APP = path.join(ROOT, 'apps', 'battery_diary');
const { Recorder } = require(path.join(KIT, 'record'));
const themes = require(path.join(KIT, 'themes'));
const { StartLog, trend } = require(path.join(APP, 'startlog'));

let checks = 0, fails = 0;
const ok = (c, m) => { checks++; if (!c) { fails++; console.log('FAIL ' + m); } else console.log('ok   ' + m); };

/* the start log, on a made-up clock */
let t = 1e12;
const saved = [];
const L = new StartLog({ now: () => t, onEntry: (e) => saved.push(e) });
const step = (ms, v, rpm) => { t += ms; if (rpm !== undefined) L.rpm(rpm, t); if (v !== undefined) L.volt(v, t); };
step(1000, 12.55, 0);
step(1000, 12.40, 0);
ok(L.current().rest === 12.55 && L.phase() === 'rest', 'resting: the first reading after the wake, engine off');
step(1000, 11.9, 0);
step(500, undefined, 150);
ok(L.phase() === 'crank', 'the engine turns: starting');
step(500, 10.1);
step(300, undefined, 800);
step(700, 10.6);
step(1000, 13.9);
ok(L.phase() === 'run' && L.current().crank === 10.1, 'the lowest seen while starting: ' + L.current().crank);
for (let i = 0; i < 700; i++) step(1000, i % 3 ? 14.4 : 12.7);
ok(saved.length === 1 && saved[0].rest === 12.55 && saved[0].crank === 10.1 && saved[0].run === 14.4, 'after 10 minutes the start is in the diary: ' + JSON.stringify(saved[0]));
step(1000, undefined, 0); step(1000, 12.6); step(1000, undefined, 800); step(1000, 11.0);
ok(saved.length === 1 && L.phase() === 'done', 'auto start / stop after it: not another start');
const L2 = new StartLog({ now: () => t });
L2.rpm(0, t); L2.volt(12.5, t); L2.rpm(900, t + 1000); L2.volt(10.4, t + 1500); L2.rpm(0, t + 30000);
ok(L2.entries.length === 1 && L2.entries[0].crank === 10.4 && L2.entries[0].run === null, 'a short run is kept without a charging value');
ok(trend([12.6, 12.55, 12.5, 12.45, 12.4]).slope < -0.04 && trend([1, 2]) === null, 'the trend line');

let impl = null, bgStop = null, reads = 0;
const volts = { now: 12.48 };
const load = Module._load;
Module._load = function (req, parent, isMain) {
    if (req === './kit/mgu') return { run: (i) => { impl = i; } };
    if (req === './kit/diag') {
        return { Diag: class { constructor() { this.available = true; } init() {} on() {} } };
    }
    if (req === './kit/dids') {
        return { DidReader: class {
            async read(c) { reads++; return c.did === 'F442' && c.ecu === 18 ? volts.now : null; }
            key(c) { return c.ecu + ':' + (c.did || 'obd ' + c.obd); }
        } };
    }
    if (req.startsWith('./kit/')) return load.call(this, path.join(KIT, req.slice(6)), parent, isMain);
    return load.call(this, req, parent, isMain);
};
(async () => {
    const { verdict } = require(path.join(APP, 'view'));
    const good = Array.from({ length: 10 }, () => ({ rest: 12.65, crank: 10.6 })), weak = Array.from({ length: 10 }, () => ({ rest: 12.1, crank: 9.4 }));
    ok(verdict(good).word === 'HEALTHY' && verdict(weak).word === 'HAVE IT TESTED' && verdict([]).word === 'NOT ENOUGH STARTS YET', 'the verdict in words');

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'battery-diary-'));
    const spec = JSON.parse(fs.readFileSync(path.join(APP, 'app.json'), 'utf8'));
    ok(spec.config.battery.v12.length >= 5 && spec.config.battery.v12[0].did === 'F442', 'the voltage candidates are eDrive\'s');
    require(path.join(APP, 'main.js'));
    const S = {}; spec.settings.forEach((s) => { S[s.key] = s.default; });
    const noop = () => {}, h = {};
    let frame = null, tab = null, texts = [];
    const ctx = {
        log: { info: noop, warn: noop, error: noop }, dataDir: dir, spec,
        settings: { get: (k) => S[k], onChange: noop },
        signals: { watch: async (iface, inst, hh) => { h[iface] = hh; return { shutdown: async () => {} }; } },
        ui: { image: async () => {}, onClick: noop, isVisible: () => true },
        onTab: (fn) => { tab = fn; }, theme: () => themes.theme('m_tricolour'), loop: (n, fps, fn) => { frame = fn; },
        canvas: (w, hh) => { const cv = new Recorder(w, hh), text = cv.text.bind(cv); texts = []; cv.text = (s, ...a) => { texts.push(String(s)); return text(s, ...a); }; return cv; },
    };
    ctx.background = impl.background(ctx);
    bgStop = ctx.background.stop;
    await impl.start(ctx);
    let txt = (await frame(), texts.join(' | '));
    ok(/DEMO/.test(txt) && /WATCH IT|HEALTHY/.test(await (async () => { await tab(1); await frame(); return texts.join(' | '); })()), 'no car yet: demo, History has a verdict');
    await tab(0);
    h['de.bmw.infotainment.vehicle.CDS'].statusEngineSpeed2({ actualValueRPMEngineCrankshaft: 0 });
    await new Promise((r) => setTimeout(r, 800));
    await frame(); txt = texts.join(' | ');
    ok(reads > 0 && !/DEMO/.test(txt) && /12\.48/.test(txt) && /WEAK/.test(txt), 'the car: the voltage read, the resting value on its scale: ' + txt);
    ok(ctx.background.L.current().rest === 12.48, 'resting voltage noted');
    const before = reads;
    h['de.bmw.infrastructure.VehicleCondition'].VehicleCondition({ statusConditionVehicle: 1 });
    await new Promise((r) => setTimeout(r, 1300));
    ok(reads === before, 'locked and left: no more reads');
    await tab(2); await frame(); txt = texts.join(' | ');
    ok(/once a second/.test(txt) && /Nothing is written to the car/.test(txt) && /18:F442/.test(txt), 'How it works: in plain words, with the voltage source');
    bgStop();
    console.log('battery diary: ' + checks + ' checks, ' + fails + ' failed');
    process.exit(fails ? 1 : 0);
})().catch((e) => { console.log('FAIL ' + (e && e.stack || e)); if (bgStop) bgStop(); process.exit(1); });
