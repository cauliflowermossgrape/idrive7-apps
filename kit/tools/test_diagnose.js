'use strict';
// Diagnose: the made-up drive's fault is found (boost off its line first, then the pull), it repeats, its 30 s are kept
// and saved, Freeze keeps a moment, a garage test with a value held steady, findings in plain words; and every page
// draws in demo. Against a stubbed head unit; no SDK or car needed:
//   node kit/tools/test_diagnose.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const ROOT = path.resolve(__dirname, '..', '..'), KIT = path.join(ROOT, 'kit', 'runtime'), APP = path.join(ROOT, 'apps', 'diagnose');

let checks = 0, fails = 0;
const ok = (c, m) => { checks++; if (!c) { fails++; console.log('FAIL ' + m); } else console.log('ok   ' + m); };
let impl = null;
const load = Module._load;
Module._load = function (req, parent, isMain) {
    if (req === './kit/mgu') return { run: (i) => { impl = i; } };
    if (req.startsWith('./kit/')) return load.call(this, path.join(KIT, req.slice(6)), parent, isMain);
    return load.call(this, req, parent, isMain);
};
const { Engine } = require(path.join(APP, 'engine'));
const { Demo } = require(path.join(APP, 'demo'));

/* the engine on the made-up drive, as if it were a real car (files written) */
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diagnose-'));
process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
const t0 = 1.7e12, d = new Demo(t0), E = new Engine({ dir });
let t = t0;
for (; t < t0 + 300000; t += 100) E.sample(d.step(t));
const pull = E.caught.filter((c) => c.check === 'pull'), boost = E.caught.filter((c) => c.check === 'boost');
ok(pull.length >= 3 && boost.length >= 3, 'the fault found each time: pull ' + pull.length + ', boost ' + boost.length);
ok(E.caught.filter((c) => c.check !== 'pull' && c.check !== 'boost').length === 0, 'nothing else flagged on a normal drive');
const first = pull[0].movers.find((m) => m.kind === 'check' && m.at !== null);
ok(first && first.id === 'boost', 'what went off first: the boost (' + (first && first.id) + ')');
ok(pull[0].data.gLong.length > 100 && pull[0].data.gLong[0][0] < -20000, 'its 30 s kept, from 25 s before');
ok(E.A.events.some((e) => e.repeat), 'seen again in the same condition: repeats');
ok(fs.existsSync(path.join(dir, 'anomalies.json')) && JSON.parse(fs.readFileSync(path.join(dir, 'anomalies.json'), 'utf8')).length === E.caught.length, 'anomalies saved');
const fz = E.freeze(t);
ok(fz.name === 'Freeze' && fz.data.speed.length > 100, 'Freeze keeps the last 30 s');
// a garage test: rpm against boost, the oil held within 1 C (the made-up oil still warms: it breaks)
E.testStart({ x: 'rpm', y: 'boost', hold: 'oil', band: 0.01 });
for (let i = 0; i < 300; i++) E.sample(d.step(t += 100));
const T = E.testStop();
ok(T && T.points.length > 100 && T.hold.broke, 'a test kept, and the moved value caught: ' + (T && T.points.length));
E.testStart({ x: 'rpm', y: 'boost', hold: 'none' });
for (let i = 0; i < 300; i++) E.sample(d.step(t += 100));
E.testStop();
ok(E.lastTwo() && ['better', 'same', 'worse'].indexOf(E.lastTwo().cmp.verdict) >= 0, 'the last two tests compared: ' + E.lastTwo().cmp.verdict);
const f = E.findings();
ok(f.length >= 2 && /happened/.test(f[0].text) && f.some((x) => /First off its usual line: torque against boost/.test(x.text)), 'findings in plain words: ' + f[0].text);
ok(/Not a diagnosis/.test(E.findingsText('0.1.0')), 'the QR text says it is an estimate');
E.save();
const E2 = new Engine({ dir });
ok(E2.tests.length === 2 && E2.caught.length === E.caught.length && Object.keys(E2.A.lines).length >= 3, 'all of it read back after a restart');

/* the app in demo: every page draws */
(async () => {
    const spec = JSON.parse(fs.readFileSync(path.join(APP, 'app.json'), 'utf8'));
    const S = {}; spec.settings.forEach((s) => { S[s.key] = s.default; }); S.demo = 'on';
    const { Recorder } = require(path.join(KIT, 'record'));
    const themes = require(path.join(KIT, 'themes'));
    require(path.join(APP, 'main.js'));
    const clicks = {}; let tab = null, texts = [];
    const noop = () => {};
    await impl.start({
        log: { info: noop, warn: (m) => { if (!/ENOENT/.test(m)) console.log('warn ' + m); }, error: noop }, dataDir: dir, spec,
        settings: { get: (k) => S[k], set: (k, v) => { S[k] = v; }, onChange: noop },
        signals: { watch: async () => ({ shutdown: async () => {} }) },
        ui: { image: async () => {}, onClick: (b, fn) => { clicks[b] = fn; }, text: noop, isVisible: () => true },
        theme: () => themes.theme('m_tricolour'), loop: noop, onTab: (fn) => { tab = fn; }, hideButton: noop,
        canvas: (w, h) => { const cv = new Recorder(w, h), tx = cv.text.bind(cv); texts = []; cv.text = (s, ...a) => { texts.push(String(s)); return tx(s, ...a); }; return cv; },
    });
    const page = async (i) => { await tab(i); return texts.join(' | '); };
    ok(/CHECKS RIGHT NOW/.test(await page(0)) && /REPEATS/.test(texts.join(' ')) && /Torque against forward g/.test(texts.join(' ')), 'Anomalies: the checks and the found list, repeating ones marked');
    ok(/Boost off its line/.test(await page(1)) && /CAUSES/.test(texts.join(' ')), 'Timeline: what went off first, causes over results');
    ok(/DRIFT FROM HEALTHY/.test(await page(2)) && /Off by/.test(texts.join(' ')), 'Compare: the delta table and drift');
    ok(/BETTER/.test(await page(3)) && /CLEAN/.test(texts.join(' ')), 'Tests: before and after, the held value');
    ok(/Worth checking/.test(await page(4)) && /phone camera/.test(texts.join(' ')), 'Mechanic: findings and a QR code');
    ok(/It only reads/.test(await page(5)), 'How it works');
    await clicks.BTN_FREEZE();
    ok(/1 of \d+: Previous/.test(texts.join(' ')) && /FOUND/.test(texts.join(' ')), 'Freeze opens the Timeline on the frozen moment');
    console.log('diagnose: ' + checks + ' checks, ' + fails + ' failed');
    process.exit(fails ? 1 : 0);
})().catch((e) => { console.log('FAIL ' + (e && e.stack || e)); process.exit(1); });
