'use strict';
// Settings > Results as QR in Drag Timer, Virtual Dyno, Brake Test and G-Force: each app's saved results as plain-text
// codes a phone camera reads. Each app runs against a stubbed head unit with a saved results file. No SDK or car needed:
//   node kit/tools/test_results_qr.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const ROOT = path.resolve(__dirname, '..', '..'), KIT = path.join(ROOT, 'kit', 'runtime');
const { Recorder } = require(path.join(KIT, 'record'));
const themes = require(path.join(KIT, 'themes'));
const qr = require(path.join(KIT, 'qr'));
const { SIZES } = require(path.join(KIT, 'qrlog'));

let impl = null;
const load = Module._load;
Module._load = function (req, parent, isMain) {
    if (req === './kit/mgu') return { run: (i) => { impl = i; } };
    if (req.startsWith('./kit/')) return load.call(this, path.join(KIT, req.slice(6)), parent, isMain);
    return load.call(this, req, parent, isMain);
};

let checks = 0, fails = 0;
const ok = (c, m) => { checks++; if (!c) { fails++; console.log('FAIL ' + m); } else console.log('ok   ' + m); };
const AT = Date.UTC(2026, 10, 26, 7, 30);

const CASES = [
    ['draggy', 'draggy_runs.json', { best: { '0-100': { s: 5.12, at: AT, trap: 101 }, qm: { s: 13.4, at: AT, trap: 172 } }, bestStd: {},
        runs: [{ kind: 'stand', at: AT, result: { '0-100': 5.12, qm: 13.4 }, valid: true }] },
        [/^Drag Timer \d/, /Best times\n/, /0-100 km\/h: 5\.12 s, 2026-11-26/, /1\/4 mile: 13\.40 s, 172 km\/h, 2026-11-26/, /Latest runs\n2026-11-26 \d\d:30: 0-100 km\/h 5\.12 s, 1\/4 mile 13\.40 s/]],
    ['dyno', 'dyno_runs.json', { runs: [{ at: AT, peakP: 250000, peakPrpm: 5600, peakT: 480, peakTrpm: 2800 }], baseline: null },
        [/^Virtual Dyno \d/, /Dyno runs\n/, /2026-11-26 \d\d:30: \d+ (hp|kW|PS) @ 5600 rpm, 480 Nm @ 2800 rpm/]],
    ['brake_test', 'brake_runs.json', { best: { '100-0': { m: 34.2, s: 2.71, at: AT } }, runs: [{ at: AT, unit: 'kmh', result: { '100-0': { m: 34.2, s: 2.71 } }, peakG: -1.12 }] },
        [/^Brake Test \d/, /Best stops\n100-0 km\/h: 34\.2 m, 2\.71 s, 2026-11-26/, /Latest runs\n2026-11-26 \d\d:30: 100-0 km\/h 34\.2 m, peak 1\.12 g/]],
    ['gforce', 'gforce_records.json', { acc: { v: 0.61, at: AT }, brk: { v: 1.08, at: AT }, left: { v: 0.95, at: AT }, right: { v: 0.9, at: AT }, comb: { v: 1.1, at: AT }, vmax: { v: 212, at: AT } },
        [/^G-Force \d/, /Records\nAccelerating: 0\.61 g, 2026-11-26/, /Braking: 1\.08 g/, /Top speed: 212 km\/h/, /This session/]],
];

(async () => {
    for (const [app, file, data, want] of CASES) {
        const APP = path.join(ROOT, 'apps', app);
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'results-qr-'));
        fs.writeFileSync(path.join(dir, file), JSON.stringify(data));
        const spec = JSON.parse(fs.readFileSync(path.join(APP, 'app.json'), 'utf8'));
        const S = {}; spec.settings.forEach((s) => { if (s.key) S[s.key] = s.default; }); S.demo = 'off';
        const noop = () => {}, rows = [];
        const ui = new Proxy({}, { get: (o, k) => (k === 'isVisible' ? () => false : k === 'image' ? async () => {} : noop) });
        delete require.cache[path.join(APP, 'main.js')];
        impl = null;
        require(path.join(APP, 'main.js'));
        await impl.start({
            ui, spec, dataDir: dir, log: { info: noop, warn: noop, error: noop, debug: noop },
            settings: { get: (k) => S[k], set: (k, v) => { S[k] = v; }, onChange: noop },
            signals: { watch: async () => ({ shutdown: async () => {} }) },
            theme: () => themes.theme('m_tricolour'), canvas: (w, h) => new Recorder(w, h),
            loop: () => ({ kick: noop }), onTab: noop, onScroll: noop, onLayout: noop, onTap: noop, onTouch: noop, hideButton: noop,
            sheet: () => false, controller: { grab: noop, onInput: noop }, widget: { onTap: noop, ready: false, instances: () => [] },
            settingsRow: (r) => rows.push(r),
        });
        const row = rows.find((r) => r.label === 'Results as QR');
        ok(!!row, app + ': a Results as QR row in Settings');
        if (!row) continue;
        const pages = row.open().contents(), text = pages.map((b) => b.toString()).join('\n');
        want.forEach((re) => ok(re.test(text), app + ': ' + re + (re.test(text) ? '' : '\n' + text)));
        ok(pages.every((b) => !!qr.encode(b, { version: SIZES.medium.version, ecl: 'L' })), app + ': every page encodes');
    }
    console.log('results qr: ' + checks + ' checks, ' + fails + ' failed');
    process.exit(fails ? 1 : 0);
})().catch((e) => { console.log('FAIL ' + (e && e.stack || e)); process.exit(1); });
