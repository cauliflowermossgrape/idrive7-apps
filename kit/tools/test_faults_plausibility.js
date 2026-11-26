'use strict';
// Fault Scanner, Plausibility tab: each check against made-up streams (gears, oil vs coolant, g vs speed, outside
// jump, a quiet signal), events and saving; then the Fault Scanner against a stubbed head unit: the tab and its
// three pages draw (demo), its watches (the four passive interfaces) run only while the page shows and stop with the
// setting off, and the fault pages are untouched. No SDK, no car; Node 8 too:
//   node kit/tools/test_faults_plausibility.js
const path = require('path');
const fs = require('fs');
const os = require('os');
const Module = require('module');
const ROOT = path.join(__dirname, '..', '..'), KIT = path.join(ROOT, 'kit', 'runtime'), APP = path.join(ROOT, 'apps', 'dtc_scanner');
const load = Module._load;
let impl = null, diags = 0;
class FakeDiag { constructor() { this.available = false; } async init() { diags++; return this; } async functional() { return new Map(); } async physical() { return null; } }
Module._load = function (req, parent, isMain) {
    if (req === './kit/mgu') return { run: (i) => { impl = i; } };
    if (req === './kit/diag') { const real = load.call(this, path.join(KIT, 'diag'), parent, isMain); return Object.assign({}, real, { Diag: FakeDiag }); }
    if (req.startsWith('./kit/')) return load.call(this, path.join(KIT, req.slice(6)), parent, isMain);
    return load.call(this, req, parent, isMain);
};
const { Sanity } = require(path.join(APP, 'plausibility'));
let n = 0, bad = 0;
const ok = (c, m) => { n++; if (!c) { bad++; console.log('FAIL ' + m); } else console.log('ok   ' + m); };

// a drive on two gears at a steady 60 km/h, 10 Hz
const K = [60, 40];
function drive(s, t0, ms, f) {
    for (let t = t0; t < t0 + ms; t += 100) {
        const d = f(t);
        ['speed', 'rpm', 'gLong', 'oil', 'coolant', 'outside'].forEach((k) => { if (d[k] !== undefined) s.feed(k, d[k], t); });
        if (t % 200 === 0) s.tick(t);
    }
    return t0 + ms;
}
let s = new Sanity({}), t = 1e6, v = 0;
t = drive(s, t, 60000, (x) => ({ speed: 60, rpm: 60 * K[Math.floor(x / 10000) % 2], gLong: 0, oil: 90, coolant: 90, outside: 10 }));
ok(s.learned().length === 2, 'two gears learned from driving');
ok(s.checks.gear.state === 'OK', 'on a gear: OK');
t = drive(s, t, 5000, () => ({ speed: 60, rpm: 60 * 50, gLong: 0 }));
ok(s.checks.gear.state === 'ODD' && /no gear/.test(s.checks.gear.reason), 'steady off every gear 3 s after the ratio settled: ODD (' + s.checks.gear.reason + ')');
ok(s.events.some((e) => e.id === 'gear' && e.state === 'ODD'), 'the ODD is an event');

s = new Sanity({ runMs: 11 * 60000, warmMs: 11 * 60000 }); t = 2e6;
t = drive(s, t, 3000, () => ({ speed: 50, rpm: 2000, oil: 60, coolant: 92, gLong: 0 }));
ok(s.checks.temps.state === 'ODD', 'oil 32 C under the coolant after 11 min with the coolant warm: ODD');
s = new Sanity({ runMs: 0 }); t = 3e6;
t = drive(s, t, 3000, () => ({ speed: 50, rpm: 2000, oil: 60, coolant: 92 }));
ok(s.checks.temps.state === 'OK', 'the same while warming up: OK');
s.feed('oil', 90, t + 500); s.tick(t + 600);
ok(s.checks.temps.state === 'ODD' && /jumped/.test(s.checks.temps.reason), 'oil jumping 30 C in a second: ODD');
// a cold winter drive: 25 min running, the coolant never past 75 C, the oil far behind it
s = new Sanity({}); t = 3.5e6;
t = drive(s, t, 25 * 60000, (x) => ({ speed: 50, rpm: 2000, oil: 20 + (x - 3.5e6) / 60000, coolant: Math.min(75, 20 + 3 * (x - 3.5e6) / 60000) }));
ok(s.checks.temps.state === 'OK' && s.runMs > 20 * 60000 && !s.events.some((e) => e.id === 'temps'), 'cold winter drive, 25 min, coolant under 80 C: never ODD (' + s.checks.temps.reason + ')');
// the coolant at 90 C but only for 5 minutes: not yet compared
s = new Sanity({}); t = 3.7e6;
t = drive(s, t, 5 * 60000, () => ({ speed: 50, rpm: 2000, oil: 50, coolant: 90 }));
ok(s.checks.temps.state === 'OK' && /Warming up/.test(s.checks.temps.reason), 'coolant warm for 5 min only: still warming up');
t = drive(s, t, 6 * 60000, () => ({ speed: 50, rpm: 2000, oil: 50, coolant: 90 }));
ok(s.checks.temps.state === 'ODD', 'and ODD once it has been warm for 10 min');

// a torque converter slipping while the car speeds up: an in-between ratio for 40 s is never learned as a gear
s = new Sanity({}); t = 3.9e6; v = 20;
t = drive(s, t, 30000, () => { v += 0.2; return { speed: v, rpm: v * 75, gLong: 0.2 / 3.6 / 0.1 / 9.80665 }; });
ok(s.learned().length === 0 && s.gears.every((g) => g.n < 3), 'one ratio held while speeding up 2 km/h a second for 30 s: no gear learned (' + s.gears.map((g) => g.k.toFixed(0) + 'x' + g.n).join(' ') + ')');
// a gear learned is saved: dirty set the moment it counts
s = new Sanity({}); t = 3.95e6;
t = drive(s, t, 19000, () => ({ speed: 60, rpm: 2400, gLong: 0 }));
ok(!s.dirty && s.learned().length === 0, 'not yet a gear after 19 s: nothing to save');
t = drive(s, t, 4000, () => ({ speed: 60, rpm: 2400, gLong: 0 }));
ok(s.learned().length === 1 && s.dirty === true && s.save().gears.length === 1, 'learned at 21 s: marked to save, and save() has it');
// pause: no stale values when the watches start again
s.pause(); s.tick(t + 60000);
ok(s.checks.late.state === 'OK', 'after pause() (the page left): nothing LATE from before');
s.feed('oil', 90, t + 60000); s.feed('oil', 20, t + 60500); s.pause(); s.feed('oil', 90, t + 61000); s.tick(t + 61000);
ok(s.checks.temps.state !== 'ODD', 'and no jump across a pause');

s = new Sanity({}); t = 4e6;
v = 40;
t = drive(s, t, 10000, () => { v += 0.2; return { speed: v, rpm: 2000, gLong: 0.2 / 3.6 / 0.1 / 9.80665 }; });
ok(s.checks.gspeed.state === 'OK', 'g sent matches the speed change: OK');
t = drive(s, t, 8000, () => { v += 0.2; return { speed: v, rpm: 2000, gLong: 0.6 }; });
ok(s.checks.gspeed.state === 'ODD', 'g sent 0.5 g off the speed change, three windows: ODD');

s = new Sanity({}); t = 5e6;
s.feed('outside', 5, t); s.tick(t); s.feed('outside', 12, t + 1000); s.tick(t + 1000);
ok(s.checks.outside.state === 'ODD', 'outside 7 C up in a second: ODD');
s.feed('outside', 12, t + 70000); s.tick(t + 70000);
ok(s.checks.outside.state === 'OK', 'and OK a minute later');

s = new Sanity({}); t = 6e6;
t = drive(s, t, 5000, () => ({ speed: 60, rpm: 2000, gLong: 0 }));
t = drive(s, t, 3000, () => ({ speed: 60, rpm: 2000 }));
ok(s.checks.late.state === 'LATE' && /forward g quiet/.test(s.checks.late.reason), 'g quiet 3 s while driving: LATE');
t = drive(s, t, 1000, () => ({ speed: 0, rpm: 800 }));
ok(s.checks.late.state === 'OK', 'parked: not checked');

const saved = s.save();
ok(Array.isArray(saved.events) && saved.events.length >= 1 && Array.isArray(saved.gears), 'save() keeps events and gears');
ok(new Sanity(saved).events.length === saved.events.length, 'and they load back');

// the Fault Scanner: the Plausibility tab next to the faults
(async () => {
    const { Recorder } = require(path.join(KIT, 'record'));
    const themes = require(path.join(KIT, 'themes'));
    const spec = JSON.parse(fs.readFileSync(path.join(APP, 'app.json'), 'utf8'));
    ok(spec.settings.some((x) => x.key === 'plausibility' && x.default === true), 'Settings: Plausibility checks, on by default');
    ['de.bmw.infotainment.vehicle.Vehicle2', 'de.bmw.infotainment.vehicle.CDS2', 'de.bmw.infrastructure.EnvironmentalInformation'].forEach((i) =>
        ok(spec.signals[i] && spec.signals[i]._optional, i.split('.').pop() + ' declared, optional'));
    ok(spec.signals['de.bmw.infotainment.vehicle.CDS'].statusEngineSpeed2 === 'rs', 'CDS rpm declared');
    require(path.join(APP, 'main.js'));
    const S = {}; spec.settings.forEach((x) => { S[x.key] = x.default; });
    S.demo = 'on'; S.autoScan = false;
    const noop = () => {}, watching = new Map(), onChange = [], vis = [];
    let frame = null, tab = null, texts = [], frameSel = null, frameTabs = null;
    const G = require(path.join(KIT, 'gauges')), gFrame = G.frame;
    G.frame = function (cv, t, tabs, sel) { frameTabs = tabs; frameSel = sel; return gFrame.apply(this, arguments); };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faults-pl-'));
    await impl.start({
        log: { info: noop, warn: (e) => console.log('warn ' + e), error: noop }, dataDir: dir, spec,
        settings: { get: (k) => S[k], onChange: (f) => onChange.push(f) },
        signals: { watch: async (iface) => { watching.set(iface, (watching.get(iface) || 0) + 1); return { shutdown: async () => { watching.set(iface, watching.get(iface) - 1); } }; } },
        ui: { text: noop, image: async () => {}, onClick: noop, onVisible: (f) => vis.push(f), onFocus: noop, isVisible: () => false },
        theme: () => themes.theme('m_tricolour'), hideButton: noop, onLayout: noop, onScroll: noop,
        loop: (nm, f, fn) => { frame = fn; return { kick: noop }; }, onTab: (fn) => { tab = fn; },
        canvas: (w, h) => { const cv = new Recorder(w, h), text = cv.text.bind(cv); texts = []; cv.text = (x, ...a) => { texts.push(String(x)); return text(x, ...a); }; return cv; },
    });
    await new Promise((r) => setTimeout(r, 30));
    const on = () => Array.from(watching.keys()).filter((k) => watching.get(k) > 0).sort();
    const PL = ['de.bmw.infotainment.vehicle.CDS', 'de.bmw.infotainment.vehicle.CDS2', 'de.bmw.infotainment.vehicle.Vehicle2', 'de.bmw.infrastructure.EnvironmentalInformation'];
    const CC = ['de.bmw.infotainment.KombiInterface_2', 'de.bmw.infotainment.checkcontrol.CheckControlMaster', 'de.bmw.infotainment.vehicle.CDS'];
    ok(on().length === 0 && diags === 0, 'app running, page not shown: nothing watched, no diagnostic link (' + on().join(', ') + ')');
    vis.forEach((f) => f('MAIN', true));
    await new Promise((r) => setTimeout(r, 30));
    ok(PL.every((i) => on().indexOf(i) >= 0) && watching.get('de.bmw.infotainment.vehicle.CDS') === 2, 'page shown: the four passive Plausibility watches, beside Check Control\'s (' + on().join(', ') + ')');
    await frame(); let all = texts.join(' | ');
    ok(frameTabs && frameTabs.length === 5 && /^Plausibility/.test(frameTabs[4]) && frameTabs[0].indexOf('Faults') === 0, 'five tabs, Plausibility last (' + frameTabs + ')');
    ok(frameSel === 0, 'opens on the faults');
    await tab(4); await frame(); all = texts.join(' | ');
    ok(frameSel === 4 && /1\/3/.test(frameTabs[4]), 'Plausibility tab: its first page (' + frameTabs[4] + ')');
    ok(/ODD/.test(all) && /LATE/.test(all) && /below the coolant/.test(all), 'demo Checks page: one ODD (oil), one LATE');
    await tab(4); await frame(); all = texts.join(' | ');
    ok(/30 min ago/.test(all) && /\d\d:\d\d:\d\d/.test(all) && /2\/3/.test(frameTabs[4]), 'tab again: History, its lanes and list');
    await tab(4); await frame(); all = texts.join(' | ');
    ok(/cannot say which one is wrong/.test(all), 'tab again: How it works');
    await tab(4); await frame();
    ok(/1\/3/.test(frameTabs[4]), 'and round to Checks');
    await tab(3); await frame();
    ok(frameSel === 3, 'Bus tab still the Bus page');
    await tab(1); await frame();
    ok(frameSel === 1, 'Check Control tab still Check Control');
    await tab(0); await frame();
    ok(frameSel === 0, 'back to the faults');
    S.plausibility = false; onChange.forEach((f) => f());
    await new Promise((r) => setTimeout(r, 30));
    ok(JSON.stringify(on()) === JSON.stringify(CC) && watching.get('de.bmw.infotainment.vehicle.CDS') === 1, 'Plausibility checks off: its watches shut down, Check Control\'s stay (' + on().join(', ') + ')');
    S.plausibility = true; onChange.forEach((f) => f());
    await new Promise((r) => setTimeout(r, 30));
    ok(PL.every((i) => on().indexOf(i) >= 0), 'on again: watched again');
    vis.forEach((f) => f('MAIN', false));
    await new Promise((r) => setTimeout(r, 30));
    ok(on().length === 0, 'page left: every watch shut down (' + on().join(', ') + ')');
    const words = fs.readFileSync(path.join(APP, 'plausibility_view.js'), 'utf8') + fs.readFileSync(path.join(APP, 'plausibility.js'), 'utf8');
    ok(!/[\u2013\u2014]/.test(words), 'no long dashes');
    console.log('faults plausibility: ' + n + ' checks, ' + bad + ' failed');
    process.exit(bad ? 1 : 0);
})().catch((e) => { console.log('FAIL ' + (e && e.stack || e)); process.exit(1); });
