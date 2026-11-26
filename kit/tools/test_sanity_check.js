'use strict';
// Sanity Check: each check against made-up streams (gears, oil vs coolant, g vs speed, outside jump, a quiet
// signal), events and saving; then the app against a stubbed head unit (demo on): every page draws. No SDK, no car:
//   node kit/tools/test_sanity_check.js
const path = require('path');
const fs = require('fs');
const os = require('os');
const Module = require('module');
const ROOT = path.join(__dirname, '..', '..'), KIT = path.join(ROOT, 'kit', 'runtime'), APP = path.join(ROOT, 'apps', 'sanity_check');
const load = Module._load;
let impl = null;
Module._load = function (req, parent, isMain) {
    if (req === './kit/mgu') return { run: (i) => { impl = i; } };
    if (req.startsWith('./kit/')) return load.call(this, path.join(KIT, req.slice(6)), parent, isMain);
    return load.call(this, req, parent, isMain);
};
const { Sanity } = require(path.join(APP, 'checks'));
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
let s = new Sanity({}), t = 1e6;
t = drive(s, t, 60000, (x) => ({ speed: 60, rpm: 60 * K[Math.floor(x / 10000) % 2], gLong: 0, oil: 90, coolant: 90, outside: 10 }));
ok(s.learned().length === 2, 'two gears learned from driving');
ok(s.checks.gear.state === 'OK', 'on a gear: OK');
t = drive(s, t, 5000, () => ({ speed: 60, rpm: 60 * 50, gLong: 0 }));
ok(s.checks.gear.state === 'ODD' && /no gear/.test(s.checks.gear.reason), 'steady off every gear 3 s after the ratio settled: ODD (' + s.checks.gear.reason + ')');
ok(s.events.some((e) => e.id === 'gear' && e.state === 'ODD'), 'the ODD is an event');

s = new Sanity({ runMs: 11 * 60000 }); t = 2e6;
t = drive(s, t, 3000, () => ({ speed: 50, rpm: 2000, oil: 60, coolant: 92, gLong: 0 }));
ok(s.checks.temps.state === 'ODD', 'oil 32 C under the coolant after 11 min: ODD');
s = new Sanity({ runMs: 0 }); t = 3e6;
t = drive(s, t, 3000, () => ({ speed: 50, rpm: 2000, oil: 60, coolant: 92 }));
ok(s.checks.temps.state === 'OK', 'the same while warming up: OK');
s.feed('oil', 90, t + 500); s.tick(t + 600);
ok(s.checks.temps.state === 'ODD' && /jumped/.test(s.checks.temps.reason), 'oil jumping 30 C in a second: ODD');

s = new Sanity({}); t = 4e6;
let v = 40;
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

// the app: every page draws in demo
(async () => {
    const { Recorder } = require(path.join(KIT, 'record'));
    const themes = require(path.join(KIT, 'themes'));
    const spec = JSON.parse(fs.readFileSync(path.join(APP, 'app.json'), 'utf8'));
    require(path.join(APP, 'main.js'));
    const S = { demo: 'on', theme: 'm_tricolour' }, clicks = {}, noop = () => {};
    let frame = null, tab = null, texts = [];
    await impl.start({
        log: { info: noop, warn: (e) => console.log('warn ' + e), error: noop }, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'sanity-')), spec,
        settings: { get: (k) => S[k], onChange: noop }, signals: { watch: async () => ({}) },
        ui: { image: async () => {}, onClick: (b, fn) => { clicks[b] = fn; } },
        theme: () => themes.theme('m_tricolour'), loop: (nm, f, fn) => { frame = fn; }, onTab: (fn) => { tab = fn; },
        canvas: (w, h) => { const cv = new Recorder(w, h), text = cv.text.bind(cv); texts = []; cv.text = (x, ...a) => { texts.push(String(x)); return text(x, ...a); }; return cv; },
    });
    await frame(); let all = texts.join(' | ');
    ok(/ODD/.test(all) && /LATE/.test(all) && /below the coolant/.test(all), 'demo Checks page: one ODD (oil), one LATE');
    await tab(1); all = texts.join(' | ');
    ok(/30 min ago/.test(all) && /\d\d:\d\d:\d\d/.test(all), 'History page draws its lanes and list');
    await tab(2); all = texts.join(' | ');
    ok(/cannot say which one is wrong/.test(all), 'How it works page');
    console.log('sanity check: ' + n + ' checks, ' + bad + ' failed');
    process.exit(bad ? 1 : 0);
})().catch((e) => { console.log('FAIL ' + (e && e.stack || e)); process.exit(1); });
