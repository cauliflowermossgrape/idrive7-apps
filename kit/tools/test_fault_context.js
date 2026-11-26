'use strict';
// Fault Scanner > a fault's details and the Bus page (apps/dtc_scanner/context.js): the snapshot list (19 03), each
// snapshot record (19 04) and the extended data (19 06) parsed as the unit sent them, a value nobody names kept raw, the
// response times per unit with NRC 78 waits counted, and no request but these reads ever sent (never a clear, 14). The
// app against a stubbed head unit; no SDK or car needed:
//   node kit/tools/test_fault_context.js            (PNG_DIR=<folder> also draws the pages to PNG files)
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const ROOT = path.resolve(__dirname, '..', '..'), KIT = path.join(ROOT, 'kit', 'runtime');
const APP = path.join(ROOT, 'apps', 'dtc_scanner');

let checks = 0, fails = 0;
const ok = (c, m) => { checks++; if (!c) { fails++; console.log('FAIL ' + m); } else console.log('ok   ' + m); };
const tick = (ms) => new Promise((r) => setTimeout(r, ms || 20));

// every request the app sends, in order: [target, sid, data]
const sent = [];
const CODE = [0x10, 0x2A, 0x5A];               // 102A5A at the engine unit (0x12)
function answer(target, sid, data) {
    if (sid === 0x19 && data[0] === 0x02) return null;                                  // (functional, below)
    if (sid === 0x19 && data[0] === 0x03) return [0x59, 0x03].concat(CODE, [0x01], CODE, [0x02], [0x48, 0x01, 0x02, 0x01]);
    if (sid === 0x19 && data[0] === 0x04) {
        const rec = data[4];
        return [0x59, 0x04].concat(CODE, [0x09, rec, 0x01, 0x17, 0x00, 0x03, rec === 1 ? 0x84 : 0xA0]);     // ID 1700, 2 bytes
    }
    if (sid === 0x19 && data[0] === 0x06) return [0x59, 0x06].concat(CODE, [0x09, 0x01, 0x05, 0x02, 0x00, 0x2A]);
    if (sid === 0x22) return [0x7F, 0x22, 0x31];
    return [0x7F, sid, 0x11];
}
class FakeDiag {
    constructor() { this.available = true; this.l = {}; }
    async init() { return this; }
    on(ev, fn) { (this.l[ev] = this.l[ev] || []).push(fn); return this; }
    emit(ev, v) { (this.l[ev] || []).forEach((f) => f(v)); }
    async send(target, sid, data) { sent.push([target, sid, (data || []).slice()]); return 'NO_ERROR'; }
    async functional(sid, params) {
        await this.send(0xDF, sid, params);
        const m = new Map();
        if (params[0] === 0x02) { const r = [0x59, 0x02, 0xFF].concat(CODE, [0x09]); m.set(0x12, r); this.emit('frame', { ecu: 0x12, uds: r }); }
        return m;
    }
    async physical(target, sid, data, ms, accept) {
        await this.send(target, sid, data);
        if (target === 0x12 && sid === 0x19 && data[0] === 0x04) this.emit('frame', { ecu: 0x12, uds: [0x7F, 0x19, 0x78] });   // a wait first
        const r = answer(target, sid, data);
        if (r) this.emit('frame', { ecu: target, uds: r });
        return r && (!accept || accept(r)) ? r : null;
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
const CTX = require(path.join(APP, 'context.js'));

/* ---------- parsing ---------- */
ok(JSON.stringify(CTX.parseIds([0x59, 0x03, 0x10, 0x2A, 0x5A, 0x01, 0x48, 0x01, 0x02, 0x01, 0x10, 0x2A, 0x5A, 0x02], '102A5A')) === '[1,2]',
    '19 03: this fault\'s snapshot record numbers, the other fault\'s left out');
const s1 = CTX.parseSnapshot([0x59, 0x04, 0x10, 0x2A, 0x5A, 0x09, 0x01, 0x01, 0x17, 0x00, 0x03, 0x84], '102A5A');
ok(s1 && s1.status === 0x09 && s1.record === 1 && s1.count === 1 && s1.did === 0x1700 && s1.data.join() === '3,132', '19 04: a standard record (record, count, identifier, data)');
ok(CTX.asNumber(s1.data) === 900, 'a value of up to 4 bytes also as a plain number (900)');
const s2 = CTX.parseSnapshot([0x59, 0x04, 0x10, 0x2A, 0x5A, 0x09, 0x02, 0x02, 0x40, 0x01, 1, 2, 3, 4, 5, 6], '102A5A');
ok(s2.count === 2 && s2.did === 0x4001 && s2.data.length === 6 && CTX.asNumber(s2.data) === null, 'two identifiers in a record: the first named, the rest kept raw, no number guessed');
ok(CTX.parseSnapshot([0x59, 0x04, 0x99, 0x99, 0x99, 0x09], '102A5A') === null, 'another fault\'s reply is not this one\'s');
ok(CTX.parseExtended([0x59, 0x06, 0x10, 0x2A, 0x5A, 0x09, 0x01, 0x05], '102A5A').data.join() === '1,5', '19 06: the extended data kept as sent');
const bits = CTX.statusBits(0x09);
ok(bits[0].on && bits[3].on && !bits[2].on && bits.length === 8, 'the status byte in words (09: failing now, confirmed)');
let threw = 0;
[[0x14, [0xFF, 0xFF, 0xFF]], [0x19, [0x02, 0xFF]], [0x2E, [0x01]], [0x31, [0x01]]].forEach(([sid, d]) => { try { CTX.allowed(sid, d); } catch (e) { threw++; } });
ok(threw === 4 && CTX.allowed(0x19, [0x04, 1, 2, 3, 1]), 'only 19 03 / 04 / 06 may leave the context reader (a clear throws)');
const chart = CTX.chartable([s1, CTX.parseSnapshot([0x59, 0x04, 0x10, 0x2A, 0x5A, 0x09, 0x02, 0x01, 0x17, 0x00, 0x03, 0xA0], '102A5A')]);
ok(chart && chart.did === 0x1700 && chart.points.join(';') === '1,900;2,928', 'two records of the same identifier: a line, record by record');

/* ---------- timing ---------- */
let now = 1000;
const tm = new CTX.Timing(() => now);
tm.request(0x12, 0x22); now += 40; tm.frame(0x12, [0x7F, 0x22, 0x78]); now += 300; tm.frame(0x12, [0x62, 0x44, 0x02, 1]);
tm.request(0x12, 0x22); now += 60; tm.frame(0x12, [0x62, 0x44, 0x02, 1]);
tm.request(0xDF, 0x19); now += 100; tm.frame(0x40, [0x59, 0x02, 0xFF]); now += 50; tm.frame(0x12, [0x59, 0x02, 0xFF]);
tm.frame(0x40, [0x62, 0x10, 0x00]);                                              // nobody asked 0x40 that
const L = tm.list(), dme = L.find((u) => u.addr === 0x12), bdc = L.find((u) => u.addr === 0x40);
ok(dme.n === 3 && dme.max === 340 && dme.pending === 1 && dme.last === 150, 'per unit: answers, the slowest (a wait counted in), the waits, the last');
ok(bdc.n === 1 && bdc.avg === 100, 'a request to every unit: each unit\'s first answer timed; a reply nobody asked for is not');
ok(tm.perSecond().reduce((a, b) => a + b, 0) === 3 && tm.perSecond().length === 60, 'requests a second over the last minute');

/* ---------- the app ---------- */
require(path.join(APP, 'main.js'));
const { Recorder, play } = require(path.join(KIT, 'record'));
const { Canvas } = require(path.join(KIT, 'canvas'));
const themes = require(path.join(KIT, 'themes'));

async function run(demo) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faultctx-'));
    const spec = JSON.parse(fs.readFileSync(path.join(APP, 'app.json'), 'utf8'));
    const S = {}; spec.settings.forEach((s) => { if (s.key) S[s.key] = s.default; }); S.autoScan = false; S.demo = demo ? 'on' : 'off';
    const noop = () => {}, clicks = {}, vis = [];
    let loopFn = null, tab = null, last = null, texts = [];
    await impl.start({
        log: { info: noop, warn: noop, error: noop }, dataDir: dir, spec,
        settings: { get: (k) => S[k], onChange: noop },
        signals: { watch: async () => ({ shutdown: async () => {} }) },
        ui: { text: noop, image: async (n, cv) => { last = cv; }, onClick: (b, fn) => { clicks[b] = fn; }, onVisible: (fn) => vis.push(fn), onFocus: noop, isVisible: () => true },
        theme: () => themes.theme('m_tricolour'),
        canvas: (w, h) => { const cv = new Recorder(w, h); cv.own = true; const tx = cv.text.bind(cv); texts = []; cv.text = (s, ...a) => { texts.push(String(s)); return tx(s, ...a); }; return cv; },
        hideButton: noop, onLayout: noop, onTab: (fn) => { tab = fn; }, onScroll: noop, loop: (n, f, fn) => { loopFn = fn; return { kick: noop }; },
        settingsRow: noop,
    });
    vis.forEach((f) => f('MAIN', true));
    const draw = async () => { await loopFn(); return texts.join(' | '); };
    const png = (name) => {
        if (!process.env.PNG_DIR || !last) return;
        const c = new Canvas(last.w, last.h); play(last.words(), c);
        fs.writeFileSync(path.join(process.env.PNG_DIR, name), c.png());
    };
    return { clicks, tab, draw, png };
}

(async () => {
    const a = await run(false);
    a.clicks.BTN_SCAN(); await tick(80);
    const before = sent.length;
    a.clicks.BTN_DETAIL(); await tick(80);
    let t = await a.draw();
    const mine = sent.slice(before);
    ok(mine.length === 4 && mine.every((r) => r[0] === 0x12 && r[1] === 0x19 && [0x03, 0x04, 0x06].indexOf(r[2][0]) >= 0),
        'opening a fault asks only its unit, only 19 03 / 04 / 06 (4 requests: list, 2 records, extended)');
    ok(/Failing at this moment/.test(t) && /Record 1/.test(t) && /ID 1700/.test(t) && /= 900/.test(t) && /= 928/.test(t), 'the details page: status in words, both records, raw and as a number');
    ok(/5 bytes/.test(t) && /01 05 02 00 2A/.test(t), 'the extended data as the unit sent it');
    a.png('fc_detail.png');
    const n = sent.length;
    a.clicks.BTN_DETAIL(); await tick(40); await a.draw();
    ok(sent.length === n, 'opened again (the same fault, it is the only one): read from memory, not asked again');
    a.tab(3); t = await a.draw();
    ok(/AVERAGE/.test(t) && /DME|engine|ECU/i.test(t) && /in the last minute/.test(t) && /not visible to apps/.test(t), 'the Bus page: the units, our requests a second, what it cannot show');
    ok(/wait/.test(t), 'the engine unit\'s NRC 78 wait is counted on the Bus page');
    a.png('fc_bus.png');
    ok(!sent.some((r) => r[1] === 0x14), 'never a clear (14) in all of this');

    const d = await run(true);
    d.clicks.BTN_SCAN(); await tick(6800);         // (the demo scan answers unit by unit, 180 ms each)
    const nd = sent.length;
    d.clicks.BTN_DETAIL(); await tick(40);
    t = await d.draw();
    ok(sent.length === nd && /Record 3/.test(t) && /DEMO/.test(t), 'demo: made-up records, nothing sent to the car');
    d.png('fc_detail_demo.png');
    d.tab(3); t = await d.draw();
    ok(/ms/.test(t) && /in the last minute/.test(t), 'demo: the Bus page with made-up times');
    d.png('fc_bus_demo.png');
    d.tab(0); t = await d.draw();
    ok(/SCAN AGAIN/i.test(t) && !/Failing at this moment/.test(t), 'the Faults tab again: back to the list');
    d.png('fc_faults_demo.png');

    console.log('fault context: ' + checks + ' checks, ' + fails + ' failed');
    process.exit(fails ? 1 : 0);
})().catch((e) => { console.log('FAIL ' + (e && e.stack || e)); process.exit(1); });
