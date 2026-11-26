'use strict';
// Watchdog: a rule fires once past its threshold for its hold time, again only after it came back and the cooldown;
// background() runs with no screen, fires from the car's signals and keeps the firing; the pages draw. No SDK or car:
//   node kit/tools/test_watchdog.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const ROOT = path.resolve(__dirname, '..', '..'), KIT = path.join(ROOT, 'kit', 'runtime'), APP = path.join(ROOT, 'apps', 'watchdog');
const { Recorder } = require(path.join(KIT, 'record'));
const themes = require(path.join(KIT, 'themes'));
const R = require(path.join(APP, 'rules'));

let checks = 0, fails = 0;
const ok = (c, m) => { checks++; if (!c) { fails++; console.log('FAIL ' + m); } else console.log('ok   ' + m); };

// rule logic
const rules = R.normalize([{ on: true, value: 'oil', cmp: 'above', thr: 120, hold: 5 }, { on: true, value: 'soc12', cmp: 'below', thr: 60, hold: 0 }]);
ok(rules.length === 8 && rules[2].value === R.DEFAULTS[2].value, 'a short saved list is filled up to 8 rules');
ok(R.normalize([{ value: 'oil', thr: 123 }])[0].thr === 125, 'a threshold snaps to its value\'s steps');
ok(R.text(rules[0]) === 'Engine oil above 120 °C for 5 s', 'rule in words: ' + R.text(rules[0]));
const e = new R.Engine(), CD = 60000;
let t = 1000000;
const run = (v, ms) => { let f = []; for (let k = 0; k < ms / 250; k++) { t += 250; f = f.concat(e.step(rules, v, t, CD)); } return f; };
ok(run({ oil: 118 }, 10000).length === 0, 'below the threshold: nothing fires');
ok(run({ oil: 125 }, 4000).length === 0 && e.state(0, rules[0], { oil: 125 }, t, CD).state === 'waiting', 'past it for 4 of 5 s: waiting');
ok(run({ oil: 125 }, 2000).length === 1, 'past it for 5 s: fires once');
ok(run({ oil: 126 }, 20000).length === 0 && e.state(0, rules[0], { oil: 126 }, t, CD).state === 'firing', 'staying past it: no second firing');
run({ oil: 100 }, 1000);
ok(run({ oil: 125 }, 10000).length === 0 && e.state(0, rules[0], { oil: 125 }, t, CD).state === 'cooldown', 'back past it within the cooldown: quiet');
run({ oil: 100 }, 60000);
ok(run({ oil: 125 }, 6000).length === 1, 'after the cooldown: fires again');
ok(run({ soc12: 55 }, 250).length === 1, 'hold 0: fires at once');
ok(e.state(3, rules[3], {}, t, CD).state === 'off' || rules[3].on, 'a rule switched off stays off');
ok(e.state(4, rules[4], {}, t, CD).state === 'no value', 'no value from the car: says so');

let impl = null;
const load = Module._load;
Module._load = function (req, parent, isMain) {
    if (req === './kit/mgu') return { run: (i) => { impl = i; } };
    if (req.startsWith('./kit/')) return load.call(this, path.join(KIT, req.slice(6)), parent, isMain);
    return load.call(this, req, parent, isMain);
};
(async () => {
    require(path.join(APP, 'main.js'));
    const spec = JSON.parse(fs.readFileSync(path.join(APP, 'app.json'), 'utf8'));
    const S = {}; spec.settings.forEach((s) => { if (s.key) S[s.key] = s.default; }); S.demo = 'off';
    const noop = () => {}, h = {};
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchdog-'));
    fs.writeFileSync(path.join(dir, 'rules.json'), JSON.stringify([{ on: true, value: 'oil', cmp: 'above', thr: 120, hold: 0 }]));
    // background only: no ui, no screen
    const bg = { log: { info: noop, warn: noop, error: noop }, dataDir: dir, spec,
        settings: { get: (k) => S[k], set: (k, v) => { S[k] = v; }, onChange: noop },
        signals: { watch: async (iface, inst, hh) => { h[iface] = Object.assign(h[iface] || {}, hh); return { shutdown: async () => {} }; } } };
    const st = await impl.background(bg);
    await new Promise((r) => setTimeout(r, 50));
    const temps = h['de.bmw.infotainment.vehicle.CDS'].statusEngineTemperature;
    temps({ temperatureEngineOilDrive: 100 + 48, temperatureEngineDrive: 90 + 48 });
    await new Promise((r) => setTimeout(r, 600));
    ok(st.events.length === 0, 'background, oil 100: nothing fired');
    temps({ temperatureEngineOilDrive: 130 + 48, temperatureEngineDrive: 90 + 48 });
    await new Promise((r) => setTimeout(r, 600));
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'events.json'), 'utf8'));
    ok(st.events.length === 1 && saved.length === 1 && saved[0].value === 130 && st.unseen === 1, 'background, no screen, oil 130: fired once and kept in events.json');

    // the pages, in demo
    S.demo = 'on';
    let frame = null, tab = null, texts = [];
    const clicks = {};
    await impl.start({ log: bg.log, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'watchdog-')), spec, settings: bg.settings, signals: bg.signals,
        ui: { image: async () => {}, onClick: (b, fn) => { clicks[b] = fn; }, isVisible: () => true },
        onTab: (fn) => { tab = fn; }, theme: () => themes.theme('m_tricolour'), loop: (n, fps, fn) => { frame = fn; },
        canvas: (w, hh) => { const cv = new Recorder(w, hh), text = cv.text.bind(cv); texts = []; cv.text = (s, ...a) => { texts.push(String(s)); return text(s, ...a); }; return cv; } });
    await new Promise((r) => setTimeout(r, 300));
    await frame();
    let all = texts.join(' | ');
    ok(/Engine oil above 120/.test(all) && /WATCHING|WAITING|FIRING/.test(all), 'Rules page: the rules and their state');
    await clicks.BTN_VALUE();
    all = texts.join(' | ');
    ok((all.match(/Coolant above/g) || []).length === 2 && !/Engine oil above/.test(all), 'Change value: rule 1 watches the next value (coolant)');
    await tab(1); all = texts.join(' | ');
    ok(/Each dot is one firing/.test(all) && /\d+ min/.test(all) && /rule \d/.test(all), 'Events page: the timeline and the latest');
    await tab(2); all = texts.join(' | ');
    ok(/cannot pop up over another screen/.test(all), 'How it works: says what a firing can and cannot do');
    console.log('watchdog: ' + checks + ' checks, ' + fails + ' failed');
    process.exit(fails ? 1 : 0);
})().catch((err) => { console.log('FAIL ' + (err && err.stack || err)); process.exit(1); });
