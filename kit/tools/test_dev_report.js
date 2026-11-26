'use strict';
// Fault Scanner > Settings > Developer report as QR (#239, apps/dtc_scanner/devreport.js): every unit of the last scan
// with its SGBD index and 22 F1 89, the engine unit's identifiers from Live Data's built-in catalog with their answer
// or NRC, the faults, and a head line; packed as the QR log's compressed pages. Against a stubbed transport that records
// every request: only 22 is ever sent, never 14. No SDK or car needed:
//   node kit/tools/test_dev_report.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const Module = require('module');
const ROOT = path.resolve(__dirname, '..', '..'), KIT = path.join(ROOT, 'kit', 'runtime');
const APP = path.join(ROOT, 'apps', 'dtc_scanner');

const sent = [];
class FakeDiag {
    constructor() { this.available = true; }
    async init() { return this; }
    async send() { throw new Error('send not expected'); }
    async functional(sid, params) {
        sent.push([sid, 0xDF].concat(params));
        const m = new Map();
        if (sid === 0x19 && params[0] === 0x02) { m.set(0x12, [0x59, 0x02, 0xFF, 0x12, 0x03, 0x08, 0x2F]); m.set(0x40, [0x59, 0x02, 0xFF]); }
        return m;
    }
    async physical(addr, sid, data) {
        sent.push([sid, addr].concat(data));
        if (sid !== 0x22) return null;
        const id = (data[0] << 8) | data[1];
        if (id === 0xF150) return [0x62, 0xF1, 0x50, 0x0F, 0x26, 0xE8];
        if (id === 0xF189) return addr === 0x12 ? [0x62, 0xF1, 0x89].concat(Array.from(Buffer.from('DME 1.2.3'))) : [0x7F, 0x22, 0x31];
        if (id === 0x4035) return [0x62, 0x40, 0x35, 0x01, 0x02];
        if (id === 0x4201) return [0x62, 0x42, 0x01].concat(Array.from(Buffer.from('WBA12345678901234')));   // a VIN in an answer
        if (id === 0x4205) return [0x7F, 0x22, 0x31];
        return id % 3 ? [0x62, data[0], data[1], 0x00] : null;
    }
}
let impl = null;
const load = Module._load;
Module._load = function (req, parent, isMain) {
    if (req === './kit/mgu') return { run: (i) => { impl = i; } };
    if (req === './kit/diag') { const real = load.call(this, path.join(KIT, 'diag'), parent, isMain); return Object.assign({}, real, { Diag: FakeDiag }); }
    if (req.startsWith('./kit/')) return load.call(this, path.join(KIT, req.slice(6)), parent, isMain);
    return load.call(this, req, parent, isMain);
};
require(path.join(APP, 'main.js'));
const { DME_IDS, allowed } = require(path.join(APP, 'devreport.js'));

let checks = 0, fails = 0;
const ok = (c, m) => { checks++; if (!c) { fails++; console.log('FAIL ' + m); } else console.log('ok   ' + m); };
const tick = (ms) => new Promise((r) => setTimeout(r, ms || 20));
const unpack = (buf) => {
    const nl = buf.indexOf(10), head = buf.slice(0, nl).toString(), m = /^MGULOG2 d(\d+) /.exec(head);
    const dict = m && +m[1] ? fs.readFileSync(path.join(KIT, 'qrlog-dict-' + m[1] + '.txt')) : null;
    return { head, lines: zlib.inflateRawSync(buf.slice(nl + 1), dict ? { dictionary: dict } : {}).toString().split('\n') };
};

(async () => {
    // the identifier list is Live Data's catalog's
    const cat = Object.keys(JSON.parse(fs.readFileSync(path.join(ROOT, 'apps', 'live_data', 'builtin', 'DME8FF_R.json'), 'utf8')));
    ok(JSON.stringify(cat.slice().sort()) === JSON.stringify(DME_IDS.slice().sort()) && DME_IDS.length > 50, 'dme_ids.json lists the ' + cat.length + ' identifiers of Live Data\'s DME8FF_R catalog');
    let threw = false; try { allowed(0x14); } catch (e) { threw = true; }
    ok(threw && allowed(0x22), 'only 22 passes allowed(); 14 throws');

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devrep-'));
    const spec = JSON.parse(fs.readFileSync(path.join(APP, 'app.json'), 'utf8'));
    const S = {}; spec.settings.forEach((s) => { if (s.key) S[s.key] = s.default; }); S.autoScan = false; S.demo = 'off'; S.plausibility = false;
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
    const row = rows.find((r) => r.label === 'Developer report as QR');
    ok(!!row, 'a Developer report as QR row in Settings');
    let sheet = row.open();
    let lines = sheet.contents().map(unpack).reduce((a, p) => p.lines.concat(a), []);
    ok(/no scan yet/.test(lines.join('\n')), 'before a scan: the report says so');
    vis.forEach((f) => f('MAIN', true)); await tick();
    clicks.BTN_SCAN(); await tick(150);
    const before = sent.length;
    sheet = row.open();
    // the sheet keeps being drawn while open: stand in for the frames
    const fakeR = { clear: noop, fillRect: noop, text: noop, textScale: 1, extra: 0 }, fakeT = { bg: '#000', text: '#fff', dim: '#888' };
    for (let i = 0; i < 40; i++) { try { sheet.draw(fakeR, fakeT); } catch (e) { /* drawing needs more of a canvas: the time stamp is set first */ } await tick(10); }
    const reqs = sent.slice(before);
    ok(reqs.length > 0 && reqs.every((r) => r[0] === 0x22), 'opening the sheet sends 22 requests only (' + reqs.length + ')');
    ok(!sent.some((r) => r[0] === 0x14), 'no 14 (clear) ever');
    ok(reqs.filter((r) => r[2] === 0xF1 && r[3] === 0x89).length === 2, '22 F1 89 once for each unit that answered the scan');
    ok(reqs.filter((r) => r[1] === 0x12 && !(r[2] === 0xF1)).length === DME_IDS.length, 'each catalog identifier asked of the engine unit once');
    // Refresh: the codes as far as the reading got
    sheet = row.open();
    const pages = sheet.contents();
    ok(pages.every((b) => /^MGULOG2 d\d+ Fault Scanner /.test(b.toString('latin1'))), 'pages carry the QR log header that qrlog_decode.py reads');
    lines = pages.map(unpack).reduce((a, p) => p.lines.concat(a), []);
    const js = lines.map((l) => JSON.parse(l));
    const head = js[js.length - 1];
    ok(head.t === 'head' && head.units === 2 && head.dids === DME_IDS.length && head.done === true, 'head last: 2 units, ' + DME_IDS.length + ' identifiers, done');
    const u12 = js.find((x) => x.t === 'unit' && x.a === '12'), u40 = js.find((x) => x.t === 'unit' && x.a === '40');
    ok(u12 && u12.idx === '0F26E8' && u12.swText === 'DME 1.2.3', 'the engine unit: SGBD index and software version as text');
    ok(u40 && u40.swNrc === '31', 'a unit that refuses F1 89: its NRC');
    const d = (id) => js.find((x) => x.t === 'did' && x.id === id);
    ok(d('4035').ans === '0102' && d('4205').nrc === '31', 'an answer as hex, a refusal as its NRC');
    ok(d('4201').vin === 'masked' && !/WBA12345678901234/.test(Buffer.from(d('4201').ans, 'hex').toString()) && /^WBA\*{14}$/.test(Buffer.from(d('4201').ans, 'hex').toString()), 'a VIN in an answer is masked');
    ok(js.some((x) => x.t === 'fault' && x.a === '12' && x.code === '120308' && x.st === '2F'), 'the faults of the scan');
    // a second open after a finished read sends nothing more
    const n = sent.length; row.open(); await tick(50);
    ok(sent.length === n, 'read once: opening it again for the same scan sends nothing');
    console.log('dev report: ' + checks + ' checks, ' + fails + ' failed');
    process.exit(fails ? 1 : 0);
})().catch((e) => { console.log('FAIL ' + (e && e.stack || e)); process.exit(1); });
