'use strict';
const origWarn = console.warn;

// VMGauge poll cadence: with a simulated UDS transport (150 ms reply time), every metric
// shown on the active tab must refresh about 5x/s. Synthetic, no SDK or car needed:
//   node kit/tools/test_vmgauge_poll.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const EventEmitter = require('events');
const Module = require('module');

const ROOT = path.join(__dirname, '..', '..'), KIT = path.join(ROOT, 'kit', 'runtime');
const MAIN = path.join(ROOT, 'apps', 'vmgauge', 'main.js');
const SPEC = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps', 'vmgauge', 'app.json'), 'utf8'));
const { Recorder: Canvas } = require(path.join(KIT, 'record'));
const themes = require(path.join(KIT, 'themes'));

let app = null;
const reads = [];                       // { ecu, did, t }

// stand-in transport: one request in hand at a time (like TASU), replies after RTT_MS.
// Unknown DIDs answer NRC 31 instantly - a real ECU refuses a bad identifier fast, and the
// candidate search must not pay a full round trip per rejection.
const RTT_MS = Number(process.env.RTT || 40);      // DME answers a known DID in ~40 ms (K-CAN/WIFI tunnel)
const DME_ECU = SPEC.config.dme.ecu;
// every reply decodes inside the candidate's min..max so each metric locks onto its first
// candidate like on a well-configured car (values: boost idle, 2.7 bar oil, lambda 1.0, ...)
const REPLY = {                                   // did -> data bytes after '62 <did>'
    '4205': [0x32, 0x00],                         // 100 kPa manifold abs (boost ~ -1.3 bar vs 101.3 baro)
    '586F': [0x0A, 0x8B],                         // 2700 hPa = 2.7 bar abs oil pressure
    '5889': [0x10, 0x3C],                         // lambda 4156 * 1/4096 = 1.0146
    '5813': [0x30],                               // load 36 %
    'F433': [101],                                // barometric 101 kPa
    'F423': [0x0C, 0xD2],                         // 3280 * 0.1 = 328 bar rail pressure
    '580F': [0x58],                               // ITANS (raw-48)*0.75: 88 -> 15 degC
    '4A9D': [0x80, 0x00],                         // 32768 * 3.05e-5 = 1.0 mixture adaptation
    '5853': [0x3A, 0x98],                         // 15000 * 0.001 = 15.0 V
    '554C': [0xFF, 0xF6],                         // knock retard -1.5 deg (signed)
    '5896': [0x16, 0xE0],                         // 5856 * 0.1 - 273.14 = 312 degC EGT
};
const OBD_REPLY = {                               // pid -> A/B bytes after '41 <pid>'
    '0B': [0x64],                                 // manifold abs 100 kPa
    '0E': [0x80],                                 // timing advance 0 deg
    '0F': [0x58],                                 // IAT 40 degC
    '23': [0x10, 0x22],                           // rail 32800 kPa
    '24': [0x80, 0x00],                           // lambda 1.0
    '33': [101],                                  // baro 101 kPa
    '42': [0x36, 0xB0],                           // control voltage 14 V
};
function replyFor(ecu, sid, data) {
    if (sid === 0x01) {
        const pid = data[0].toString(16).toUpperCase().padStart(2, '0');
        const b = OBD_REPLY[pid];
        return b ? [0x41, data[0]].concat(b) : [0x7F, 0x01, 0x31];
    }
    if (sid === 0x06) {                            // misfire monitors: mid A2..A5, tid 0x0C
        const mid = data[0];
        if (mid >= 0xA2 && mid <= 0xA5) return [0x46, mid, mid, 0x0C, 0x00, 0x00, 0x0A, 0x00, 0x00, 0x00, 0x00];
        if (mid === 0xA0) return [0x46, 0xA0, 0xF0, 0x00, 0x00, 0x00];
        return [0x7F, 0x06, 0x31];
    }
    const did = ((data[0] << 8) | data[1]).toString(16).toUpperCase().padStart(4, '0');
    if (ecu !== DME_ECU) return [0x62, data[0], data[1], 0x01, 0x00];   // gearbox / xdrive: small value
    const b = REPLY[did];
    return b ? [0x62, data[0], data[1]].concat(b) : [0x7F, 0x22, 0x31];  // unknown DID: out of range
}

const stubs = {
    './kit/mgu': { run(a) { app = a; } },
    // real kit/diag (its serialization is part of what we test) with the TASU transport stubbed out
    './kit/diag': (() => {
        const d = require(path.join(KIT, 'diag'));
        class FakeDiag extends d.Diag {
            constructor() { super({ proxy: async () => ({}), on: async () => {}, onAvailable: async () => {} }, console); this.available = true; }
            init() { return Promise.resolve(this); }
            async send(ecu, sid, data) {                                 // one frame at a time, RTT_MS reply
                if (this._busy) throw new Error('transport overlap (serialization broken)');
                const self = this;
                this._busy = true;
                const t = Date.now();
                const didH = ((data[0] << 8) | data[1]).toString(16).toUpperCase().padStart(4, '0');
                const refusal = (sid === 0x22 && ecu === DME_ECU && !REPLY[didH]) || (sid === 0x06 && !(data[0] >= 0xA0 && data[0] <= 0xA5));
                await new Promise((r) => setTimeout(r, refusal ? 5 : RTT_MS));   // NRC 31 comes back instantly
                this._busy = false;
                if (process.env.DBG && sid === 0x22 && ((data[0] << 8) | data[1]) === 0xF6A2) origWarn('ASK F6A2 ecu=' + ecu.toString(16));
                if (sid === 0x01) reads.push({ ecu, did: 'OBD ' + data[0].toString(16).toUpperCase().padStart(2, '0'), t });
                else if (sid === 0x06) reads.push({ ecu, did: 'MID ' + data[0].toString(16).toUpperCase(), t });
                else reads.push({ ecu, did: ((data[0] << 8) | data[1]).toString(16).toUpperCase().padStart(4, '0'), t });
                this.emit('frame', { ecu, uds: replyFor(ecu, sid, data) });
                return 'NO_ERROR';
            }
        }
        return { Diag: FakeDiag, hex: d.hex };
    })(),
    './kit/dids': { DidReader: require(path.join(KIT, 'dids')).DidReader },
};
const load = Module._load;
Module._load = function (req, parent, isMain) {
    if (stubs[req]) return stubs[req];
    if (req.startsWith('./kit/')) return load.call(this, path.join(KIT, req.slice(6)), parent, isMain);
    return load.call(this, req, parent, isMain);
};

const SECONDS = Number(process.env.SECS || 12);

(async () => {
    delete require.cache[MAIN];
    require(MAIN);
    const S = {};
    SPEC.settings.forEach((s) => { S[s.key] = s.default; });
    let frame = null;
    const ctx = {
        ui: { onClick() {}, text() {}, image: async () => {} },
        settings: { get: (k) => S[k], onChange() {} },
        log: { info(...a) { if (process.env.V) console.log('INFO', ...a); }, warn(...a) { console.log('WARN', ...a); }, debug() {} }, spec: SPEC,
        dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'vmgp-')),
        signals: { watch: () => Promise.resolve({}) },
        onTab(fn) { this.tab = fn; }, hideButton() {}, onScroll() {}, onTap() {}, loop(n, fps, fn) { frame = fn; },
        theme: () => themes.theme('m_tricolour'),
        canvas: (w, h) => new Canvas(w, h),
    };
    await app.start(ctx);
    await ctx.tab(0);                                   // Main
    const t0 = Date.now();
    while (Date.now() - t0 < SECONDS * 1000) { await frame(); await new Promise((r) => setTimeout(r, 100)); }

    // group the reads by metric label and measure each metric's average refresh rate
    const byLabel = {};
    reads.forEach((r) => { if (r.t > t0 + 1000) (byLabel[r.did] = byLabel[r.did] || []).push(r.t); });
    // misfire cylinders poll round-robin; count them as one logical metric
    reads.forEach((r) => {
        if (/^MID A[2-5]$/.test(r.did)) { (byLabel['MID A2+A3+A4+A5'] = byLabel['MID A2+A3+A4+A5'] || []).push(r.t); }
    });
    const hzOf = (label) => {
        const ts = byLabel[label] || [], n = ts.length;
        return n > 1 ? (n - 1) / ((ts[n - 1] - ts[0]) / 1000) : 0;
    };
    // label -> metric name (first candidate of each tiered metric; all candidates here answer
    // or are refused, so the app locks onto candidate 0 like on a well-configured car)
    const want = {};
    const add = (m) => {
        const list = m === 'tcase' ? SPEC.config.xdrive.front : SPEC.config.dme[m];
        const c = list[0];
        want[c.obd ? 'OBD ' + String(c.obd).toUpperCase() : c.did] = m;
    };
    ['boost', 'mixtureAdapt', 'oilPressAbs', 'fuelPresAct', 'loadDirect'].forEach(add);   // FAST_SET (boost reads F433 for baro too)
    ['iat', 'egt', 'voltage', 'lambda', 'gearbox'].forEach(add);                           // MED_SET on Main (gearbox: DID 6000, ECU 24)
    want['MID A2+A3+A4+A5'] = 'misfire';                                                   // SLOW_SET: 4 cylinders round-robin
    let fails = 0;
    const check = (label, min) => {
        const hz = hzOf(label), m = want[label];
        const ok = hz >= min;
        if (!ok) fails++;
        console.log(m + ' (' + label + '): ' + (byLabel[label] || []).length + ' reads, ~' + hz.toFixed(2) + '/s  ' + (ok ? 'OK' : 'TOO SLOW (want >=' + min + ')'));
    };
    // channel limit: 1000/RTT plus free slots from the instant NRC-31 refusals during warm-up.
    // Main shows 5 fast + 5 medium + knock + 4 misfire cylinders; at RTT 40 ms the pipe is
    // saturated, so fast metrics get ~15% of slots (>=3.7/s), medium ~5% (~0.6/s by design:
    // MED_GAP 1.5 s), and the misfire sweep runs every ~2 s across its 4 mids.
    const cap = Number(process.env.CAP || (1000 / RTT_MS));
    check('4205', cap * 0.14); check('4A9D', cap * 0.14); check('586F', cap * 0.14);
    check('F423', cap * 0.14); check('5813', cap * 0.13);
    check('580F', cap * 0.022); check('5896', cap * 0.022); check('5853', cap * 0.022);
    check('5889', cap * 0.022); check('6000', cap * 0.022);
    check('MID A2+A3+A4+A5', 0.30);                                               // slow tier: full sweep ~2 s
    const total = reads.filter((r) => r.t > t0 + 1000).length;
    console.log('total reads: ' + total + ' over ' + (SECONDS - 1) + ' s (~' + (total / (SECONDS - 1)).toFixed(1) + ' requests/s, transport limit ' + cap.toFixed(1) + '/s)');
    if (fails) { console.error(fails + ' metrics below cadence'); process.exit(1); }
    console.log('poll cadence test passed.');
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
