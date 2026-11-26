'use strict';
// Live Data's Signal Hunter tab (Settings > Advanced settings): values split into members, noise learned and hidden,
// Mark before / what changed, the 30 s buffer and the state at a moment, saved windows (kept 20), labels, every page
// drawn in the demo (bar layout and with its own buttons), listening only while turned on, and gen_signal_hunter's
// --check. No SDK or car needed:
//   node kit/tools/test_signal_hunter.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const ROOT = path.join(__dirname, '..', '..'), KIT = path.join(ROOT, 'kit', 'runtime'), APP = path.join(ROOT, 'apps', 'live_data');

let checks = 0, fails = 0;
const ok = (c, m) => { checks++; if (!c) { fails++; console.log('FAIL ' + m); } else console.log('ok   ' + m); };

// a clock of our own for everything that asks Date.now()
let T = Date.UTC(2026, 10, 26, 8, 0, 0);
const realNow = Date.now;
Date.now = () => T;

const load = Module._load;
Module._load = function (req, parent, isMain) {
    if (req.startsWith('./kit/')) return load.call(this, path.join(KIT, req.slice(6)), parent, isMain);
    return load.call(this, req, parent, isMain);
};
const { Hunter, flatten, stateAtStep } = require(path.join(APP, 'hunter'));
const { Windows } = require(path.join(APP, 'hunter_windows'));

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

// running counts: since the mark, also past the 30 s buffer and its 6000 entries
let TC = T;
const hc = new Hunter({ now: () => TC });
hc.update('de.bmw.x.Iface|statusC', { v: 0 });
TC += 20000; hc.mark();
for (let i = 1; i <= 7000; i++) { TC += 10; hc.update('de.bmw.x.Iface|statusC', { v: i }); }
ok(hc.buffer.length <= 6000 && hc.changed()[0].n === 7000, 'What changed counts since the mark with a running count (' + hc.changed()[0].n + ', buffer ' + hc.buffer.length + ')');
hc.mark(); TC += 10; hc.update('de.bmw.x.Iface|statusC', { v: -1 });
ok(hc.changed()[0].n === 1, 'Mark before starts the count again');
const ps = hc.perSecond(60), bz = hc.busiest(30000, 5);
ok(ps.reduce((a, b) => a + b, 0) === hc.buffer.length && bz[0][0] === 'de.bmw.x.Iface' && bz[0][1] === hc.buffer.length, 'changes a second and the busiest interfaces from the newest end of the buffer');

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

// the tab: demo, every page, Mark / Label / Save window / Playback, listening only while turned on and shown
(async () => {
    const spec = JSON.parse(fs.readFileSync(path.join(APP, 'app.json'), 'utf8'));
    const S = {}; spec.settings.forEach((s) => { S[s.key] = s.default; }); S.demo = 'on';
    ok(S.hunter === false && JSON.stringify(spec.settings.find((s) => s.key === 'hunter').when) === '{"advanced":true}', 'the tab is off by default and its setting shows only with Advanced settings');
    const { Recorder } = require(path.join(KIT, 'record'));
    const themes = require(path.join(KIT, 'themes'));
    const noop = () => {};
    let watched = 0, shut = 0, texts = [];
    const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hunter-app-'));
    const tab = require(path.join(APP, 'hunter_tab')).create({
        log: { info: noop, warn: noop, error: noop }, dataDir: appDir, spec,
        settings: { get: (k) => S[k], set: (k, v) => { S[k] = v; } },
        signals: { watch: async () => { watched++; return { shutdown: async () => { shut++; } }; } },
    }, { native: () => false });
    tab.sync(true);
    ok(!tab.on() && watched === 0, 'off: nothing watched');
    S.advanced = true; S.hunter = true; tab.sync(false);
    await new Promise((r) => setImmediate(r));
    ok(tab.on() && watched === 0 && !tab._state().listening, 'on, but no Hunter page shown (the app in the background, another tab): nothing watched');
    tab.sync(true);
    await new Promise((r) => setImmediate(r));
    const fields = require(path.join(APP, 'hunter_fields')).fields;
    ok(tab.on() && watched === Object.keys(fields).length, 'on and a Hunter page shown: one read-only watch per interface (' + watched + ')');
    tab.sync(false);
    await new Promise((r) => setImmediate(r));
    ok(shut === watched && tab._state().subs === 0, 'the page left or the screen hidden: every watch let go (' + shut + ')');
    tab.sync(true);
    await new Promise((r) => setImmediate(r));
    ok(watched === 2 * Object.keys(fields).length && tab._state().subs === Object.keys(fields).length, 'shown again: watched again');
    const t = themes.theme('m_tricolour');
    const canvas = (own) => { const cv = new Recorder(1600, 520), text = cv.text.bind(cv); texts = []; cv.text = (s, ...a) => { texts.push(String(s)); return text(s, ...a); }; if (own) cv.own = true; return cv; };
    const demoH = tab._state().demoH;
    const T0 = T;
    const feed = (sec) => { for (let i = 0; i < sec * 10; i++) { T += 100; require(path.join(APP, 'hunter_demo')).demoAt(T - T0).forEach((kv) => demoH.update(kv[0], kv[1])); } };
    const page = (p, own) => { T += 200; tab.draw(canvas(own), t, p); return texts.join(' | '); };
    // What changed is worked out at most 4 times a second, and only on its own page
    let lists = 0;
    const changed0 = demoH.changed.bind(demoH);
    demoH.changed = (o) => { lists++; return changed0(o); };
    for (let i = 0; i < 60; i++) { T += 16; tab.draw(canvas(false), t, 4); }
    ok(lists === 0, 'How it works: 60 frames, What changed never worked out');
    for (let i = 0; i < 60; i++) { T += 16; tab.draw(canvas(false), t, 1); }
    ok(lists === 0, 'Live: 60 frames, What changed never worked out');
    for (let i = 0; i < 125; i++) { T += 16; tab.draw(canvas(false), t, 0); }
    ok(lists >= 1 && lists <= 9, 'What changed: 125 frames in 2 s, the list worked out ' + lists + ' times (at most 4 a second)');
    ok(!tab.animated(4) && !tab.animated(2) && tab.animated(0) && tab.animated(1), 'How it works and Found are not redrawn every frame');
    demoH.changed = changed0;
    feed(12);                                      // the quiet start: noise learned; the door opened and shut
    ok(tab.actionLabel(0) === 'Mark before', 'the bar button on What changed: Mark before');
    tab.action(0);
    feed(16);                                      // blink, A/C, seat heating
    let txt = page(0);
    ok(/values moved/.test(txt) && /statusACFront\.status/.test(txt) && !/aliveCounter/.test(txt), 'What changed: the A/C among the changes, the counter hidden');
    tab.press(0);                                  // the controller pressed: Label it
    txt = page(2);
    ok(/the label Label it uses now/.test(txt) && /DOOR|CLIMATE/.test(txt), 'Found: the labelled value counted');
    txt = page(1);
    ok(/a row lights up as it changes/.test(txt) && /in the last minute/.test(txt), 'Live: moving values and the busiest interfaces');
    tab.action(1);                                 // Save window
    ok(tab.actionLabel(1) === 'Saving...', 'Save window: waiting for its after part');
    T += 11000;
    await new Promise((r) => setTimeout(r, 400));   // the save timer looks four times a second
    txt = page(3);
    ok(/changes/.test(txt) && /step 0 of \d+/.test(txt), 'Playback: the saved window, at its start');
    tab.move(3, 1); tab.move(3, 1);
    ok(/step 2 of/.test(page(3)), 'the controller steps through the changes');
    txt = page(4);
    ok(/Not raw CAN/.test(txt) && /Nothing is sent to the car/.test(txt), 'How it works says what it can and cannot see');
    // where the kit runs the screen: the page's buttons on it, the hints left out
    txt = page(0, true);
    ok(/MARK BEFORE/.test(txt) && /LABEL IT/.test(txt) && !/Previous \/ Next picks a row/.test(txt), 'own screen: What changed has its buttons, the hint goes');
    txt = page(3, true);
    ok(/PLAY|PAUSE/.test(txt) && /NEXT WINDOW/.test(txt), 'own screen: Playback has Play and Next window');
    ok(!fs.existsSync(path.join(appDir, 'hunter', 'found.json')) && (!fs.existsSync(path.join(appDir, 'hunter', 'windows')) || fs.readdirSync(path.join(appDir, 'hunter', 'windows')).length === 0), 'the demo saves nothing');
    S.hunter = false; tab.sync(true);
    await new Promise((r) => setImmediate(r));
    ok(!tab.on() && shut === watched, 'turned off: every watch let go (' + shut + ')');

    // off and on quickly while the watches are still being set up: the first start's watches are let go, not kept
    const waiting = [];
    let shut2 = 0, got = 0;
    const S2 = Object.assign({}, S, { advanced: true, hunter: true, demo: 'off' });
    const tab2 = require(path.join(APP, 'hunter_tab')).create({
        log: { info: noop, warn: noop, error: noop }, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'hunter-race-')), spec,
        settings: { get: (k) => S2[k], set: (k, v) => { S2[k] = v; } },
        signals: { watch: (iface, inst, h) => new Promise((r) => waiting.push(() => r({ h, shutdown: () => { shut2++; } }))) },
    }, { native: () => true });
    const nI = Object.keys(fields).length;
    tab2.sync(true); tab2.sync(false); tab2.sync(true);
    ok(waiting.length === 2 * nI, 'off and on quickly: two starts\' watches being set up (' + waiting.length + ')');
    const first = waiting.splice(0, nI);
    first.forEach((go) => go());
    await new Promise((r) => setImmediate(r));
    ok(shut2 === nI && tab2._state().subs === 0, 'the first start\'s watches, resolved late: all let go, none in the new list');
    waiting.forEach((go) => go());
    await new Promise((r) => setImmediate(r));
    ok(tab2._state().subs === nI && shut2 === nI, 'the second start\'s watches kept (' + tab2._state().subs + ')');
    tab2.sync(false);
    await new Promise((r) => setImmediate(r));
    ok(shut2 === 2 * nI && tab2._state().subs === 0, 'and let go when the page is left');

    // gen_signal_hunter --check: only an inconsistent or stale list fails; a field another app adds is only reported
    const gen = require(path.join(ROOT, 'kit', 'tools', 'gen_signal_hunter.js'));
    const ld = JSON.parse(fs.readFileSync(path.join(APP, 'app.json'), 'utf8')), listed = require(path.join(APP, 'hunter_fields'));
    let r = gen.check(ld, listed);
    ok(!r.problems.length, 'check: the committed list is consistent with Live Data\'s app.json (' + r.problems.join('; ') + ')');
    const ld2 = JSON.parse(JSON.stringify(ld)), i0 = Object.keys(listed.fields).find((i) => ld2.signals[i] && !ld2.signals[i]._instances);
    delete ld2.signals[i0][listed.fields[i0][0]];
    r = gen.check(ld2, listed);
    ok(r.problems.some((m) => /does not declare/.test(m)), 'check: a listed field Live Data does not declare fails');
    const lst3 = JSON.parse(JSON.stringify(listed)); lst3.added = lst3.added.concat(['de.bmw.none.Gone.statusNothing']);
    r = gen.check(ld, lst3);
    ok(!r.problems.length && r.gone.indexOf('de.bmw.none.Gone.statusNothing') >= 0, 'check: a field another app dropped (added for the hunter) is only a warning, CI stays green');
    const lst4 = JSON.parse(JSON.stringify(listed)), i4 = Object.keys(lst4.fields)[0]; lst4.fields[i4] = lst4.fields[i4].slice(1);
    r = gen.check(ld, lst4);
    ok(!r.problems.length && r.added.length >= 1, 'check: a field another app declares that is not listed yet is only reported');
    r = gen.check(ld, null);
    ok(r.problems.some((m) => /hunter_fields.js is missing/.test(m)), 'check: a missing hunter_fields.js fails');
    const text = '{\n  "id": "x",\n  "signals": {\n    "a": { "b": "rs" }\n  },\n  "settings": [{"key": "k"}]\n}\n';
    const out = gen.replaceSignals(text, { a: { b: 'rs', c: 's' } });
    ok(JSON.parse(out).signals.a.c === 's' && /\[\{"key": "k"\}\]/.test(out), 'the signals block is replaced, the rest of app.json keeps its layout');
    Date.now = realNow;
    console.log('signal hunter: ' + checks + ' checks, ' + fails + ' failed');
    process.exit(fails ? 1 : 0);
})().catch((e) => { console.log('FAIL ' + (e && e.stack || e)); process.exit(1); });
