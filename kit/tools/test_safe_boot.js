'use strict';
// Safe boot and Settings history (kit/runtime/safeboot.js, mgu.js Settings, kitpages.js): two failed starts in a row
// make the next one safe mode (no background, the defaults in memory only, the saved file untouched), a start that
// gets through counts from 0 again; every settings change keeps the settings before it (newest 10, who made it), the
// app's repeated changes of one setting merge, going back restores them exactly and can itself be undone. No SDK or
// car needed:
//   node kit/tools/test_safe_boot.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.MGU_SAFE_OK_MS = '30';
process.env.MGU_PANIC_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'panic-'));
const KIT = path.join(__dirname, '..', 'runtime');
const { SafeBoot, settingNamed } = require(path.join(KIT, 'safeboot'));
const { Recorder } = require(path.join(KIT, 'record'));
const themes = require(path.join(KIT, 'themes'));
const kitpages = require(path.join(KIT, 'kitpages'));
const { harness, mkdirp } = require('./kit_harness');

let n = 0;
const ok = (c, m) => { assert(c, m); n++; console.log('ok   ' + m); };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'safeboot-'));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// the real Settings class, without the SDK (as hu-stub.js and test_runtime.js cut it from mgu.js)
const src = fs.readFileSync(path.join(KIT, 'mgu.js'), 'utf8').replace(/\r\n/g, '\n');
const cls = src.match(/class Settings[\s\S]*?\n}\n/)[0];
const SettingsIn = (dir) => new Function('fs', 'path', 'DATA_DIR', 'log', cls + '\nreturn Settings;')(fs, path, dir, { warn() {}, error() {}, info() {} });
const SCHEMA = [
    { key: 'theme', label: 'Colour theme', type: 'choice', default: 'm_red', options: [['m_red', 'M Red'], ['ice', 'Ice White'], ['amber', 'Night Amber']] },
    { key: 'units', label: 'Units', type: 'choice', default: 'km', options: [['km', 'km'], ['mi', 'miles']] },
    { key: 'peak', label: 'Most power seen', type: 'number', default: 0, unit: 'kW', hidden: true },
    { key: 'beep', label: 'Beep', type: 'bool', default: true },
];

(async () => {
    /* ---------- the marker ---------- */
    {
        const d = tmp();
        let t = 1000;
        const sb = () => new SafeBoot(d, () => t);
        let s = sb(), st = s.begin();
        ok(!st.safe && st.fails === 0, 'first start: normal');
        s.step('background'); s.fail(new Error('Cannot read property "x" of undefined in theme'));
        t += 1000;
        st = sb().begin();
        ok(!st.safe && st.fails === 1 && st.last.step === 'background' && /Cannot read/.test(st.last.error), 'a start that failed counts, with its step and error');
        t += 1000;
        s = sb(); st = s.begin();     // (the one before failed: counted above)
        t += 1000;
        st = sb().begin();       // the one before left no error: the car switched off or asleep within the 30 s
        ok(!st.safe && st.fails === 1, 'a start the car ended (no error) is no failure: no safe mode after a quick sleep');
        s = sb(); st = s.begin(); s.stopped();
        ok(sb().begin().fails === 1, 'a start MainApp stopped (shutdown) is no failure either');
        s = sb(); s.begin(); s.fail(new Error('boom again'));
        t += 1000;
        st = sb().begin();
        ok(st.safe && st.fails === 2 && /boom again/.test(st.last.error), 'two failed starts in a row: safe mode');
        s = sb(); s.begin(); s.fail('x');
        ok(!s.stopped(), 'a start with an error keeps its marker at shutdown');
        s = sb(); st = s.begin(); s.retry();
        ok(!s.safe && JSON.parse(fs.readFileSync(path.join(d, 'safeboot.json'), 'utf8')).fails === 0, 'Try normal start again: back to 0');
        ok(s.ok() && sb().begin().fails === 0, 'a start that got through resets the count');
        s = sb(); s.begin(); s.fail('boom');
        ok(!s.ok(), 'a start with an error is not through');
        ok(settingNamed('bad value for setting "theme"', SCHEMA) === 'Colour theme' && settingNamed('ENOENT', SCHEMA) === null, 'the setting an error names');
    }

    /* ---------- mgu.js: two failed starts, then safe mode ---------- */
    {
        const h = harness({ id: 'test', settings: SCHEMA });
        fs.writeFileSync(path.join(h.dataDir, 'settings.json'), JSON.stringify({ theme: 'ice', units: 'mi', _themeV: 2 }));
        let calls = 0, fail = true, seen = null;
        const impl = { background(bg) { calls++; seen = bg.settings.get('theme'); if (fail) throw new Error('background broke'); return {}; } };
        await h.start(impl); await h.start(impl);
        ok(calls === 2, 'two starts whose background throws');
        await h.start(impl);
        ok(calls === 2, 'the third start is safe mode: the background is not run');
        ok(/safe mode: 2 failed starts/.test(h.log()), 'safe mode says why in the log');
        const saved = JSON.parse(fs.readFileSync(path.join(h.dataDir, 'settings.json'), 'utf8'));
        ok(saved.theme === 'ice' && saved.units === 'mi', 'the saved settings untouched in safe mode');
        // the next start is still safe mode (the user has not chosen); then he tries again
        await h.start(impl);
        ok(calls === 2, 'safe mode stays until the user chooses');
        const sb = new SafeBoot(h.dataDir); sb.begin(); sb.retry();
        fail = false;
        await h.start(impl);
        ok(calls === 3 && seen === 'ice', 'Try normal start again: the background runs with the saved settings');
        await wait(80);
        ok(JSON.parse(fs.readFileSync(path.join(h.dataDir, 'safeboot.json'), 'utf8')).fails === 0, 'that start got through: the count is 0 again');
    }

    /* ---------- Settings: memory only ---------- */
    {
        const d = tmp(), Settings = SettingsIn(d);
        fs.writeFileSync(path.join(d, 'settings.json'), JSON.stringify({ theme: 'ice' }));
        const m = new Settings(SCHEMA, { memoryOnly: true });
        m.set('theme', 'amber', 'user');
        ok(m.get('theme') === 'amber' && JSON.parse(fs.readFileSync(path.join(d, 'settings.json'), 'utf8')).theme === 'ice' && !fs.existsSync(path.join(d, 'settings-history.json')),
            'memory only: defaults, nothing read or written');
        m.load();
        ok(m.get('theme') === 'ice' && !m.memoryOnly, 'load(): the saved settings back');
    }

    /* ---------- Settings history ---------- */
    {
        const d = tmp(), Settings = SettingsIn(d);
        const s = new Settings(SCHEMA);
        s.set('theme', 'ice', 'user');
        s.set('peak', 120); s.set('peak', 135); s.set('peak', 151);     // the app learning
        s.set('units', 'mi', 'user');
        let h = s.history();
        ok(h.length === 3 && h[0].by === 'user' && h[1].by === 'app' && h[1].changes[0].from === 0 && h[1].changes[0].to === 151, 'the app\'s changes of one setting within 10 min merge into one entry');
        ok(h[2].changes[0].key === 'theme' && h[2].before.theme === 'm_red', 'each entry keeps the settings before it');
        const again = new Settings(SCHEMA);
        ok(again.history().length === 3, 'the history is kept in the data folder');
        for (let i = 0; i < 12; i++) s.set('units', i % 2 ? 'mi' : 'km', 'user');
        ok(s.history().length === 10, 'the newest 10 kept');
        // go back to before the theme change: find it
        const s2 = new Settings(SCHEMA);
        s2.resetDefaults('reset');
        s2.set('theme', 'amber', 'user');
        s2.set('beep', false, 'user');
        const before = JSON.stringify(s2.values);
        const iTheme = s2.history().findIndex((e) => e.changes[0].key === 'theme' && e.by === 'user');
        const changes = s2.restore(iTheme);
        ok(s2.get('theme') === 'm_red' && s2.get('beep') === true && changes.length === 2, 'going back restores every setting as it was before that change');
        ok(s2.history()[0].by === 'rollback', 'the going back is in the history itself');
        s2.restore(0);
        ok(JSON.stringify(s2.values) === before, 'and can be undone exactly');
        const marks = new Settings(SCHEMA);
        marks.values._themeV = 2;
        marks.set('theme', 'ice', 'user');
        marks.resetDefaults();
        ok(marks.get('theme') === 'm_red' && marks.values._themeV === 2 && marks.history()[0].by === 'reset', 'reset to defaults keeps the kit\'s own marks, its entry says Reset');
        const heard = [];
        marks.onChange((k) => heard.push(k));
        marks.restore(0);
        ok(heard.indexOf('theme') >= 0, 'listeners hear each setting a rollback changed');
    }

    /* ---------- the pages ---------- */
    {
        const t = themes.theme('m_tricolour'), out = path.join(os.tmpdir(), 'kit-pages');
        mkdirp(out);
        const draw = (fn) => { const r = new Recorder(1600, 520), texts = [], text = r.text.bind(r); r.text = (s, ...a) => { texts.push(String(s)); return text(s, ...a); }; const tg = fn(r); return { r, texts, tg }; };
        let tried = 0, resets = 0;
        const sh = kitpages.safeSheet({ title: 'Warm-Up', fails: 2, last: { step: 'background', error: 'TypeError: Cannot read property \'temp\' of undefined', at: Date.now() }, setting: 'Colour theme',
            tryAgain: () => { tried++; }, reset: () => { resets++; return 3; }, qr: () => null });
        let p = draw((r) => { const tg = sh.draw(r, t); kitpages.safeFrame(r, t, 'Warm-Up'); return tg; });
        ok(p.texts.indexOf('SAFE MODE') >= 0 && p.texts.some((x) => /in its background work/.test(x)) && p.texts.some((x) => /Cannot read property/.test(x)) && p.texts.indexOf('Colour theme') >= 0,
            'the safe page: what failed, where, the error, the setting it names');
        p.tg[1].act();
        ok(resets === 0, 'Reset settings to defaults asks first');
        p.tg[1].act();
        ok(resets === 1, 'pressed again: reset');
        p.tg[0].act();
        ok(tried === 1, 'Try normal start again');
        sh.save = p.r;
        const d = tmp(), Settings = SettingsIn(d), s = new Settings(SCHEMA);
        s.set('theme', 'ice', 'user'); s.set('peak', 150); s.set('units', 'mi', 'user');
        const hs = kitpages.historySheet(s);
        p = draw((r) => hs.draw(r, t));
        ok(p.texts.some((x) => /You:\s+Units: km > miles/.test(x)) && p.texts.some((x) => /The app:\s+Most power seen: 0 kW > 150 kW/.test(x)), 'Settings history: who changed what, old > new');
        hs.focus = 0; hs.choose();
        p = draw((r) => hs.draw(r, t));
        ok(!p.texts.some((x) => /The app:/.test(x)), 'Only my changes');
        hs.focus = 2; hs.choose();
        ok(s.get('theme') === 'ice', 'Go back asks first');
        hs.choose();
        ok(s.get('theme') === 'm_red' && s.get('units') === 'km', 'pressed again: back to before the theme change');
        const hist = draw((r) => kitpages.historySheet(s).draw(r, t));
        const ban = draw((r) => { r.clear(t.bg); kitpages.banner(r, t, { by: 'blackbox', resume() {} }); });
        ok(ban.texts.some((x) => /STOPPED BY STOP ALL/.test(x)), 'the Stop all banner');
        // PNGs to look at
        try {
            const { Canvas } = require(path.join(KIT, 'canvas')), { play } = require(path.join(KIT, 'record'));
            [['safe', sh.save], ['history', hist.r], ['banner', ban.r]].forEach((x) => { const c = new Canvas(1600, 520); play(x[1].words(), c); fs.writeFileSync(path.join(out, 'sb_' + x[0] + '.png'), c.png()); });
        } catch (e) { console.log('(no PNGs: ' + e.message + ')'); }
    }

    console.log('safe boot: ' + n + ' checks pass');
    process.exit(0);
})().catch((e) => { console.log('FAIL ' + (e && e.stack || e)); process.exit(1); });
