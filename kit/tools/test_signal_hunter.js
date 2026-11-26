'use strict';
// Signal Hunter: values split into members, noise learned and hidden, Mark before / what changed, the 30 s buffer
// and the state at a moment, saved windows (kept 20), labels, and every page drawn in the demo. No SDK or car needed:
//   node kit/tools/test_signal_hunter.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const ROOT = path.join(__dirname, '..', '..'), KIT = path.join(ROOT, 'kit', 'runtime'), APP = path.join(ROOT, 'apps', 'signal_hunter');

let checks = 0, fails = 0;
const ok = (c, m) => { checks++; if (!c) { fails++; console.log('FAIL ' + m); } else console.log('ok   ' + m); };

// a clock of our own for everything that asks Date.now()
let T = Date.UTC(2026, 10, 26, 8, 0, 0);
const realNow = Date.now;
Date.now = () => T;

const load = Module._load;
let impl = null;
Module._load = function (req, parent, isMain) {
    if (req === './kit/mgu') return { run: (i) => { impl = i; } };
    if (req.startsWith('./kit/')) return load.call(this, path.join(KIT, req.slice(6)), parent, isMain);
    return load.call(this, req, parent, isMain);
};
const { Hunter, flatten, stateAtStep } = require(path.join(APP, 'hunter'));
const { Windows } = require(path.join(APP, 'windows'));

// members
const f = flatten({ a: 1, b: { c: 'X', d: [1, 2] } });
ok(f.a === 1 && f['b.c'] === 'X' && f['b.d[1]'] === 2, 'a struct split into members');

// noise: 3 changes in the first 10 quiet seconds, and counters by name
const h = new Hunter({ now: () => T });
h.update('de.bmw.x.Iface|statusA', { level: 0, aliveCounter: 0 });
h.update('de.bmw.x.Iface|statusB', { v: 1 });
for (let i = 1; i <= 4; i++) { T += 1000; h.update('de.bmw.x.Iface|statusB', { v: 1 + (i % 2) }); h.update('de.bmw.x.Iface|statusA', { level: 0, aliveCounter: i }); }
T += 20000;
h.mark();
T += 1000; h.update('de.bmw.x.Iface|statusA', { level: 2, aliveCounter: 9 });
T += 500; h.update('de.bmw.x.Iface|statusB', { v: 7 });
let ch = h.changed();
ok(ch.length === 1 && ch[0].key === 'de.bmw.x.Iface|statusA.level' && ch[0].old === 0 && ch[0].val === 2, 'after Mark before: the one real change, before and now (' + JSON.stringify(ch.map((c) => c.key)) + ')');
ok(h.changed({ noisy: true }).length === 3, 'the noise (a flapping value, a counter by name) is kept, only hidden');
ok(ch[0].name === 'Iface.statusA.level', 'short name: interface, field, member');
T += 1000; h.update('de.bmw.x.Iface|statusA', { level: 0, aliveCounter: 10 });
ok(h.changed().length === 1 && h.changed()[0].back === true, 'moved and came back (a button let go): still listed, marked back');

// the buffer: 30 s, and the state at a moment
const t0 = T;
T += 2000; h.update('de.bmw.x.Iface|statusA', { level: 5, aliveCounter: 11 });
T += 2000; h.update('de.bmw.x.Iface|statusA', { level: 6, aliveCounter: 12 });
ok(h.stateAt(t0 + 1000)['de.bmw.x.Iface|statusA.level'] === 0 && h.stateAt(t0 + 3000)['de.bmw.x.Iface|statusA.level'] === 5, 'the state at a moment, from the buffer');
T += 40000; h.update('de.bmw.x.Iface|statusA', { level: 1, aliveCounter: 13 });
ok(h.buffer.every((c) => T - c[0] <= 30000) && h.buffer.length > 0, 'the buffer keeps only the last 30 s');

// a window and stepping through it
const w = h.window(T - 20000, T);
ok(w.changes.length === 1 && w.start['de.bmw.x.Iface|statusA.level'] === 6, 'a window: the values at its start and its changes');
ok(stateAtStep(w, 0)['de.bmw.x.Iface|statusA.level'] === 6 && stateAtStep(w, 1)['de.bmw.x.Iface|statusA.level'] === 1, 'stepping: before the first change and after the last');
ok(!('de.bmw.x.Iface|statusA.aliveCounter' in w.start) && !w.changes.some((c) => c[1].endsWith('aliveCounter')), 'noise left out of the window');

// saved windows: files, the newest 20
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hunter-'));
const ws = new Windows(path.join(dir, 'windows'), { keep: 20 });
for (let i = 0; i < 22; i++) { T += 1000; ws.save({ from: T - 30000, to: T, start: {}, changes: [] }, T); }
const files = fs.readdirSync(path.join(dir, 'windows')).filter((x) => x !== 'index.json');
ok(ws.list().length === 20 && files.length === 20, 'saved windows: the newest 20 kept, the older files removed');
ok(new Windows(path.join(dir, 'windows')).list()[0].at === T && ws.load(ws.list()[0]).to === T, 'the list and a window read back after a restart');

// the app: demo, every page, Mark / Label / Save window / Playback
(async () => {
    const spec = JSON.parse(fs.readFileSync(path.join(APP, 'app.json'), 'utf8'));
    const S = {}; spec.settings.forEach((s) => { S[s.key] = s.default; }); S.demo = 'on';
    const { Recorder } = require(path.join(KIT, 'record'));
    const themes = require(path.join(KIT, 'themes'));
    const noop = () => {}, clicks = {};
    let frame = null, tab = null, texts = [], watched = 0, logged = [];
    require(path.join(APP, 'main.js'));
    const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hunter-app-'));
    const out = await impl.start({
        log: { info: (m) => logged.push(m), warn: noop, error: noop }, dataDir: appDir, spec,
        settings: { get: (k) => S[k], set: (k, v) => { S[k] = v; }, onChange: noop },
        signals: { watch: async () => { watched++; return { shutdown: async () => {} }; } },
        ui: { image: async () => {}, onClick: (b, fn) => { clicks[b] = fn; }, isVisible: () => true },
        theme: () => themes.theme('m_tricolour'), loop: (n, fps, fn) => { frame = fn; }, onTab: (fn) => { tab = fn; },
        canvas: (w2, h2) => { const cv = new Recorder(w2, h2), text = cv.text.bind(cv); texts = []; cv.text = (s, ...a) => { texts.push(String(s)); return text(s, ...a); }; return cv; },
    });
    ok(watched === Object.keys(spec.signals).length, 'one read-only watch per interface (' + watched + ')');
    const feed = (sec) => { for (let i = 0; i < sec * 10; i++) { T += 100; require(path.join(APP, 'demo')).demoAt(T - T0).forEach((kv) => out.demoH.update(kv[0], kv[1])); } };
    const T0 = T;
    const draw = async () => { T += 200; await frame(); };
    feed(12);                                      // the quiet start: noise learned; the door opened and shut
    await clicks.BTN_MARK();
    feed(16);                                      // blink, A/C, seat heating
    await tab(0); await draw();
    let txt = texts.join(' | ');
    ok(/values moved/.test(txt) && /statusACFront\.status/.test(txt) && !/aliveCounter/.test(txt), 'What changed: the A/C among the changes, the counter hidden');
    await clicks.BTN_LABEL();
    await tab(2); await draw();
    ok(/the label Label it uses now/.test(texts.join(' | ')) && /DOOR|CLIMATE/.test(texts.join(' | ')), 'Found: the labelled value counted');
    await tab(1); await draw();
    ok(/a row lights up as it changes/.test(texts.join(' | ')) && /in the last minute/.test(texts.join(' | ')), 'Live: moving values and the busiest interfaces');
    await clicks.BTN_SAVE();
    T += 11000;
    await new Promise((r) => setTimeout(r, 400));   // the save timer looks four times a second
    await tab(3); await draw();
    txt = texts.join(' | ');
    ok(/changes/.test(txt) && /step 0 of \d+/.test(txt), 'Playback: the saved window, at its start');
    await clicks.BTN_NEXT(); await clicks.BTN_NEXT(); await draw();
    ok(/step 2 of/.test(texts.join(' | ')), 'Next steps through the changes');
    await tab(4); await draw();
    ok(/Not raw CAN/.test(texts.join(' | ')) && /Nothing is sent to the car/.test(texts.join(' | ')), 'How it works says what it can and cannot see');
    ok(!fs.existsSync(path.join(appDir, 'found.json')) && !fs.existsSync(path.join(appDir, 'windows', 'index.json')) || fs.readdirSync(path.join(appDir, 'windows')).length === 0, 'the demo saves nothing');
    // gen_signal_hunter --check: only an inconsistent or stale list fails; a field another app adds is only reported
    const gen = require(path.join(ROOT, 'kit', 'tools', 'gen_signal_hunter.js'));
    const sig = { 'a.I': { _optional: 'x', f1: 'rs', f2: 's' } }, lst = { 'a.I': ['f1', 'f2'] };
    let r = gen.check(sig, lst, { 'a.I': { f1: 'rs', f2: 's' } });
    ok(!r.problems.length && !r.added.length, 'check: list up to date');
    r = gen.check(sig, lst, { 'a.I': { f1: 'rs', f2: 's', f3: 'rs' }, 'b.J': { g: 's' } });
    ok(!r.problems.length && r.added.length === 2, 'check: fields another app added are reported, not a failure');
    r = gen.check(sig, lst, { 'a.I': { f1: 'rs' } });
    ok(r.problems.length === 1 && /no app declares/.test(r.problems[0]), 'check: a listed field no app declares any more fails');
    r = gen.check(sig, { 'a.I': ['f1'] }, { 'a.I': { f1: 'rs', f2: 's' } });
    ok(r.problems.some((m) => /list different fields/.test(m)), 'check: app.json and fields.js disagreeing fails');
    r = gen.check(sig, null, { 'a.I': { f1: 'rs', f2: 's' } });
    ok(r.problems.some((m) => /fields.js is missing/.test(m)), 'check: a missing fields.js fails');
    Date.now = realNow;
    console.log('signal hunter: ' + checks + ' checks, ' + fails + ' failed');
    process.exit(fails ? 1 : 0);
})().catch((e) => { console.log('FAIL ' + (e && e.stack || e)); process.exit(1); });
