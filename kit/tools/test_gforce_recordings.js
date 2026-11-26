'use strict';
// G-Force's recording pages (the former Blackbox, #248) against a stubbed head unit (demo data, no car, no SDK): the six
// tabs draw, and Replay plays the chosen recording: Play moves the cursor at the chosen speed (0.25x, 1x, 4x), Back to
// start returns it, the values follow, the bar's action button picks the next recording.
//   node kit/tools/test_gforce_recordings.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const ROOT = path.resolve(__dirname, '..', '..'), KIT = path.join(ROOT, 'kit', 'runtime');
const APP = path.join(ROOT, 'apps', 'gforce');
const { Recorder } = require(path.join(KIT, 'record'));
const themes = require(path.join(KIT, 'themes'));

let checks = 0, fails = 0, rowAt = null;
const ok = (c, m) => { checks++; if (!c) { fails++; console.log('FAIL ' + m); } else console.log('ok   ' + m); };

let impl = null;
const load = Module._load;
Module._load = function (req, parent, isMain) {
    if (req === './kit/mgu') return { run: (i) => { impl = i; } };
    if (req === './kit/car') return class FakeCar { onSample() {} data() { return { demo: true }; } };
    if (req.startsWith('./kit/')) return load.call(this, path.join(KIT, req.slice(6)), parent, isMain);
    return load.call(this, req, parent, isMain);
};
require(path.join(APP, 'main.js'));
rowAt = require(path.join(APP, 'bbview')).rowAt;
ok(rowAt([{ t: 0 }, { t: 100 }, { t: 200 }], 140).t === 100 && rowAt([{ t: 0 }, { t: 100 }, { t: 200 }], 160).t === 200, 'rowAt: the nearest row');

let clock = Date.UTC(2026, 10, 26, 9, 0, 0);
const realNow = Date.now;
Date.now = () => clock;

(async () => {
    const spec = JSON.parse(fs.readFileSync(path.join(APP, 'app.json'), 'utf8'));
    const S = {}; spec.settings.forEach((s) => { if (s.key) S[s.key] = s.default; }); S.demo = 'on';
    const noop = () => {}, clicks = {}, theme = themes.theme('m_tricolour');
    let frame = null, tab = null, texts = [], cursors = [];
    await impl.start({
        log: { info: noop, warn: (m) => console.log('warn ' + m), error: (m) => console.log('error ' + m) },
        dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'gfrec-')), spec,
        settings: { get: (k) => S[k], set: (k, v) => { S[k] = v; }, onChange: noop },
        signals: { watch: async () => ({ shutdown: async () => {} }) },
        ui: { image: async () => {}, text: noop, onClick: (b, fn) => { clicks[b] = fn; }, isVisible: () => true },
        hideButton: noop,
        theme: () => theme, onTab: (fn) => { tab = fn; },
        loop: (n, fps, fn) => { frame = fn; return { kick: noop, stop: noop }; },
        canvas: (w, h) => {
            const cv = new Recorder(w, h), text = cv.text.bind(cv), rect = cv.fillRect.bind(cv);
            texts = []; cursors = [];
            cv.text = (s, ...a) => { texts.push(String(s)); return text(s, ...a); };
            cv.fillRect = (x, y, ww, hh, c) => { if (ww === 3 && c === theme.text) cursors.push(x); return rect(x, y, ww, hh, c); };
            return cv;
        },
    });
    const draw = async () => { await frame(); return texts.join(' | '); };

    for (const [i, want] of [[0, /ACCEL/], [1, /ALL-TIME RECORDS|Hardest launch|HARDEST LAUNCH/i], [2, /Nothing is written to a file/], [3, /FULL POWER/], [4, /PAUSED/], [5, /It records all the time/]]) {
        await tab(i);
        ok(want.test(await draw()), 'tab ' + i + ' draws (' + want + ')');
    }
    await tab(4);
    let t = await draw();
    ok(/PAUSED/.test(t) && /-60\.0 s/.test(t), 'Replay opens paused at the start, -60.0 s');
    ok(/SPEED/.test(t) && /ENGINE/.test(t) && /POWER/.test(t) && /TORQUE/.test(t) && /SIDEWAYS/.test(t), 'the values at the cursor are shown');
    const x0 = cursors[0];
    ok(cursors.length === 2, 'a cursor on both charts');

    await clicks.BTN_PLAY();
    clock += 4000;
    t = await draw();
    ok(/PLAYING 0\.25x/.test(t) && /-59\.0 s/.test(t), '4 s of playing at 0.25x: one second further, -59.0 s');
    ok(cursors[0] > x0, 'the cursor moved right (' + x0 + ' to ' + cursors[0] + ')');

    await clicks.BTN_RATE();
    clock += 2000;
    t = await draw();
    ok(/PLAYING 1x/.test(t) && /-57\.0 s/.test(t), 'Speed: 1x, two seconds later -57.0 s');
    await clicks.BTN_RATE();
    clock += 10000;
    t = await draw();
    ok(/PLAYING 4x/.test(t) && /-17\.0 s/.test(t), 'Speed again: 4x, ten seconds later -17.0 s');
    clock += 60000;
    t = await draw();
    ok(/PAUSED/.test(t) && /\+15\.0 s/.test(t), 'it stops at the end, +15.0 s');

    await clicks.BTN_START();
    t = await draw();
    ok(/-60\.0 s/.test(t), 'Back to start: -60.0 s');
    await clicks.BTN_PLAY();
    clock += 1000;
    await clicks.BTN_PLAY();
    t = await draw();
    ok(/PAUSED/.test(t) && /-56\.0 s/.test(t), 'Play at 4x, a second, Pause: -56.0 s (counted at the speed it played)');
    clock += 5000;
    ok(/-56\.0 s/.test(await draw()), 'paused: the cursor stays');

    await clicks.BTN_ACTION();
    t = await draw();
    ok(/PAUSED/.test(t) && /-60\.0 s/.test(t), 'Next recording (the bar\'s action button): the next one, from its start');

    await tab(2);
    await clicks.BTN_ACTION();
    t = await draw();
    ok(/SAVED BY HAND/.test(t), 'Save last 60 s on the Last minute page: a recording by hand, shown on Recordings');
    S.bbRecord = false;
    await tab(2);
    ok(/Saving the last minute is off/.test(await draw()), 'Save the last minute off: the page says so');

    Date.now = realNow;
    console.log('gforce recordings: ' + checks + ' checks, ' + fails + ' failed');
    process.exit(fails ? 1 : 0);
})().catch((e) => { console.log('FAIL ' + (e && e.stack || e)); process.exit(1); });
