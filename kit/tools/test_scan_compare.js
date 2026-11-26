'use strict';
// Fault Scanner: each scan is compared with the one before. Faults new since then are marked, faults gone are listed, the
// scan before is kept over a restart, and units silent in either scan don't count. No SDK or car needed:
//   node kit/tools/test_scan_compare.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const ROOT = path.resolve(__dirname, '..', '..'), KIT = path.join(ROOT, 'kit', 'runtime');
const APP = path.join(ROOT, 'apps', 'dtc_scanner');

// the car: what each unit answers to 19 02 (code bytes, status), changed between scans
let answers = {};
class FakeDiag {
    constructor() { this.available = true; }
    async init() { return this; }
    async functional(sid, params) {
        const m = new Map();
        if (params[0] !== 0x02) return m;
        Object.keys(answers).forEach((a) => m.set(Number(a), [0x59, 0x02, 0xFF].concat(...answers[a])));
        return m;
    }
    async physical() { return null; }
}
let impl = null;
const load = Module._load;
Module._load = function (req, parent, isMain) {
    if (req === './kit/mgu') return { run: (i) => { impl = i; } };
    if (req === './kit/diag') { const real = load.call(this, path.join(KIT, 'diag'), parent, isMain); return Object.assign({}, real, { Diag: FakeDiag }); }
    if (req.startsWith('./kit/')) return load.call(this, path.join(KIT, req.slice(6)), parent, isMain);
    return load.call(this, req, parent, isMain);
};

let checks = 0, fails = 0;
const ok = (c, m) => { checks++; if (!c) { fails++; console.log('FAIL ' + m); } else console.log('ok   ' + m); };
const tick = (ms) => new Promise((r) => setTimeout(r, ms || 20));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-compare-'));

async function app() {
    delete require.cache[path.join(APP, 'main.js')];
    impl = null;
    require(path.join(APP, 'main.js'));
    const spec = JSON.parse(fs.readFileSync(path.join(APP, 'app.json'), 'utf8'));
    const S = {}; spec.settings.forEach((s) => { if (s.key) S[s.key] = s.default; }); S.autoScan = false; S.demo = 'off';
    const noop = () => {}, rows = [], clicks = {}, vis = [];
    await impl.start({
        log: { info: noop, warn: noop, error: noop }, dataDir: dir, spec,
        settings: { get: (k) => S[k], onChange: noop },
        signals: { watch: async () => ({ shutdown: async () => {} }) },
        ui: { text: noop, image: async () => {}, onClick: (b, fn) => { clicks[b] = fn; }, onVisible: (fn) => vis.push(fn), onFocus: noop, isVisible: () => true },
        theme: () => { throw new Error('no drawing'); }, canvas: () => { throw new Error('no drawing'); },
        hideButton: noop, onLayout: noop, onTab: noop, onScroll: noop, loop: () => ({ kick: noop }),
        settingsRow: (r) => rows.push(r),
    });
    vis.forEach((f) => f('MAIN', true));
    await tick();
    return {
        scan: async () => { clicks.BTN_SCAN(); await tick(80); },
        text: () => rows.find((r) => r.label === 'Faults as QR').open().contents().map((b) => b.toString()).join('\n'),
    };
}

(async () => {
    const C = (hex, st) => [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16), st];
    let a = await app();
    answers = { 0x12: [C('120308', 0x2F)], 0x40: [C('804027', 0x08)] };
    await a.scan();
    ok(!/ NEW/.test(a.text()) && !/Gone since/.test(a.text()), 'the first scan: nothing to compare with');
    answers = { 0x12: [C('120308', 0x2F), C('1B2002', 0x2F)], 0x40: [], 0x44: [C('440021', 0x2F)] };
    await a.scan();
    let t = a.text();
    ok(/\n1B2002 ACTIVE NEW/.test(t), 'a fault new since the scan before is marked');
    ok(/\n120308 ACTIVE(?! NEW)/.test(t), 'one that was there before is not');
    ok(!/440021 ACTIVE NEW/.test(t), 'a unit that did not answer before: its faults are not called new');
    ok(/Gone since the scan of [^\n]+\n[^\n]*\(0x40\): 804027/.test(t), 'a fault gone since is listed with its unit');
    a = await app();
    t = a.text();
    ok(/1B2002 ACTIVE NEW/.test(t) && /804027/.test(t), 'after a restart the comparison is still there (scan before kept)');
    answers = { 0x12: [C('120308', 0x2F), C('1B2002', 0x2F)], 0x40: [], 0x44: [C('440021', 0x2F)] };
    await a.scan();
    t = a.text();
    ok(!/ NEW/.test(t) && !/Gone since/.test(t), 'the same faults again: nothing new, nothing gone');
    console.log('scan compare: ' + checks + ' checks, ' + fails + ' failed');
    process.exit(fails ? 1 : 0);
})().catch((e) => { console.log('FAIL ' + (e && e.stack || e)); process.exit(1); });
