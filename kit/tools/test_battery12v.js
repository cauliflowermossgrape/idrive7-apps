'use strict';

// 12V Battery against a stand-in diagnostic link and a stand-in clock: what a G20 320i's engine unit gives
// (402B all FF, F442 refused, OBD 01 42 silent: the voltage from the gearbox unit's F442) and what a car with a
// working battery sensor gives (402B), decoded as on the car; only UDS 22 and OBD 01 are ever sent; the engine
// reads as off from the one "0 rpm" the car sends when it stops; parked, the reads stop so the car can sleep.
//   node kit/tools/test_battery12v.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const EventEmitter = require('events');
const Module = require('module');

const ROOT = path.join(__dirname, '..', '..'), KIT = path.join(ROOT, 'kit', 'runtime');
const MAIN = path.join(ROOT, 'apps', 'battery12v', 'main.js');
const SPEC = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps', 'battery12v', 'app.json'), 'utf8'));
const { Recorder: Canvas } = require(path.join(KIT, 'record'));
const themes = require(path.join(KIT, 'themes'));
const realDiag = require(path.join(KIT, 'diag'));

/* ---------- a clock and timers the test moves on ---------- */
let NOW = Date.UTC(2026, 10, 7, 9, 0, 0);
const realNow = Date.now;
Date.now = () => NOW;
let timers = [], seq = 0;
global.setTimeout = (fn, ms) => { const id = ++seq; timers.push({ id, at: NOW + (ms || 0), fn }); return id; };
global.clearTimeout = (id) => { timers = timers.filter((x) => x.id !== id); };
global.setInterval = (fn, ms) => { const id = ++seq; const tick = () => { timers.push({ id, at: NOW + ms, fn: () => { tick(); fn(); } }); }; tick(); return id; };
global.clearInterval = global.clearTimeout;
const flush = async () => { for (let i = 0; i < 60; i++) await new Promise((r) => setImmediate(r)); };
/** Moves the clock on by ms, running the timers that come due on the way. */
async function advance(ms) {
    const end = NOW + ms;
    for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const t = timers[0];
        if (!t || t.at > end) break;
        timers.shift();
        NOW = Math.max(NOW, t.at);
        t.fn();
        await flush();
    }
    NOW = end;
    await flush();
}

/* ---------- the car's replies ---------- */
const hex = (s) => s.split(' ').map((x) => parseInt(x, 16));
let CAR = null, sent = [];
const G20 = {
    0x12: {
        '402B': 'FF FF FF FF FF FF',                    // the engine unit has no battery sensor values
        'F442': null,                                   // refused (NRC 0x31)
        '40AD': '2E 00 2D 00 28 00 27 00 28 00 28 00 00 0A 00 64 00 1E 00 0A 00 05 00 01 00 00',
        '40A9': '5A 02 5A 84 02 E2',                    // 90 Ah registered, 90 Ah original
        '59AA': '55',                                   // state of health 85 %
    },
    0x18: { 'F442': '32 00' },                          // gearbox unit: 12.800 V
};
const IBS = {
    0x12: {
        // 20.0 °C, 12.600 V ((12.6 - 6) x 4000 = 26400), 5.04 A out of the battery ((5.04 + 200) / 0.08 = 2563)
        '402B': '00 C8 67 20 0A 03',
        '40AD': '50 00 4F 00 4E 00 4F 00 50 00 4F 00 00 00 00 05 00 0A 00 1E 00 3C 00 14 00 00',
        '40A9': '50 02 5A 84 02 E2',                    // 80 Ah registered, 90 Ah original
        '59AA': '48',                                   // 72 %
    },
};
class FakeDiag extends EventEmitter {
    constructor() { super(); this.available = true; }
    init() { return Promise.resolve(); }
    async physical(ecu, sid, req) {
        sent.push({ t: NOW, ecu, sid, req: req.slice() });
        if (sid === 0x01) return null;                  // OBD service 01: no reply on these cars
        const did = ((req[0] << 8) | req[1]).toString(16).toUpperCase().padStart(4, '0');
        const unit = CAR[ecu] || {};
        if (!(did in unit)) return null;
        if (unit[did] === null) return [0x7F, sid, 0x31];
        return [0x62, req[0], req[1]].concat(hex(unit[did]));
    }
}
const stubs = {
    './kit/mgu': { run(a) { apps.push(a); } },
    './kit/diag': Object.assign({}, realDiag, { Diag: FakeDiag }),
};
const apps = [];
const load = Module._load;
Module._load = function (req, parent, isMain) {
    if (stubs[req]) return stubs[req];
    if (req.startsWith('./kit/')) return load.call(this, path.join(KIT, req.slice(6)), parent, isMain);
    return load.call(this, req, parent, isMain);
};

/** Starts a fresh copy of the app on `car`: { draw, rpm(raw), speed(kmh), texts }. */
async function start(car, name) {
    CAR = car; sent = [];
    delete require.cache[require.resolve(MAIN)];
    require(MAIN);
    const app = apps[apps.length - 1];
    const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'battery12v-' + name + '-'));
    const S = {};
    SPEC.settings.forEach((s) => { S[s.key] = s.default; });
    S.demo = 'off';
    const texts = [], handlers = {};
    let frame = null;
    const ctx = {
        ui: { onClick() {}, text() {}, image: async () => {}, onVisible() {}, onFocus() {} },
        settings: { get: (k) => S[k], onChange() {} },
        log: { info() {}, warn() {}, error() {}, debug() {} }, spec: SPEC, dataDir: dir,
        signals: { watch: (iface, inst, h) => { Object.assign(handlers, h); return Promise.resolve({ available: true }); }, call: () => Promise.reject(new Error('no')) },
        onTab() {}, hideButton() {}, onScroll() {}, onTap() {}, onLayout() {}, loop(n, fps, fn) { frame = fn; },
        theme: () => themes.theme('m_tricolour'),
        canvas: (w, h) => {
            const cv = new Canvas(w, h), text = cv.text.bind(cv);
            texts.length = 0;
            cv.text = (str, ...rest) => { texts.push(String(str)); return text(str, ...rest); };
            return cv;
        },
    };
    await app.start(ctx);
    await flush();
    return {
        dir,
        draw: async () => { await frame(); await flush(); return texts.slice(); },
        rpm: (raw) => handlers.statusEngineSpeed2({ actualValueRPMEngineCrankshaft: raw }),
        speed: (kmh) => handlers.statusCarSpeed2({ speedVehicleCentreOfGravity: Math.round(kmh / 0.015625) }),
    };
}
/** The value drawn right after a label (the kv rows draw the label, then the value). */
const after = (texts, label) => { const i = texts.indexOf(label); return i < 0 ? undefined : texts[i + 1]; };
const has = (texts, s) => texts.some((x) => x.indexOf(s) >= 0);

(async () => {
    /* ---- a G20 320i: no battery sensor values in 402B ---- */
    let a = await start(G20, 'g20');
    a.rpm(800 * 4); a.speed(50);
    let tx = await a.draw();
    await advance(4000);
    tx = await a.draw();
    assert(has(tx, '12.80'), 'G20: the voltage from the gearbox unit (12.80 V): ' + tx.join(' | '));
    assert(has(tx, '46'), 'G20: state of charge 46 %');
    assert(has(tx, 'F442 (0x18)'), 'G20: the voltage source named (gearbox unit)');
    assert.strictEqual(after(tx, 'HEALTH (SOH)'), '85 %', 'G20: state of health 85 %');
    assert.strictEqual(after(tx, 'CAPACITY'), '90 Ah', 'G20: capacity 90 Ah, the original the same');
    assert(has(tx, 'VOLTAGE, LAST 2 MIN'), 'G20: no current, so the voltage trend in its place');
    assert(!tx.includes('CURRENT'), 'G20: no CURRENT row');
    assert(sent.every((r) => r.sid === 0x22 || r.sid === 0x01), 'only UDS 22 / OBD 01 sent: ' + JSON.stringify(sent.filter((r) => r.sid !== 0x22 && r.sid !== 0x01)));
    console.log('ok   G20: 12.80 V from the gearbox unit, 46 %, SOH 85 %, 90 Ah, the voltage trend, read-only');

    // the next reads ask the gearbox unit straight away (no detour over the refused / silent candidates)
    sent = [];
    await advance(10000);
    await a.draw();
    const volt = sent.filter((r) => r.sid === 0x01 || (r.req[0] === 0xF4 && r.req[1] === 0x42));
    assert(volt.length > 0 && volt.every((r) => r.ecu === 0x18), 'G20: the voltage read from the gearbox unit only: ' + JSON.stringify(volt));
    console.log('ok   G20: the source that answered is asked first (' + volt.length + ' reads, all 0x18)');

    // the engine stops: the car sends 0 rpm once, then nothing; it still reads as off later
    a.rpm(0);
    await advance(8000);
    tx = await a.draw();
    assert.strictEqual(after(tx, 'ENGINE'), 'off', 'engine off after the one 0 rpm: ' + after(tx, 'ENGINE'));
    console.log('ok   the engine reads off from the single 0 rpm (8 s later)');

    // parked with the screen on: reads stop once the use window is over, so the car can sleep
    a.speed(0);
    // (the screen stays open: drawn every 2 s; a gap of 3 s or more would count as opening it again)
    for (let k = 0; k < 330; k++) { await advance(2000); await a.draw(); }   // 11 min
    sent = [];
    for (let k = 0; k < 30; k++) { await advance(2000); await a.draw(); }    // one more minute
    tx = await a.draw();
    assert.strictEqual(sent.length, 0, 'parked 12 min: no requests, got ' + sent.length);
    assert(tx.includes('READ NOW') || tx.includes('PAUSED'), 'parked: Read now / PAUSED in place of the state');
    console.log('ok   parked: no requests after the use window (the car can sleep)');

    /* ---- a car whose engine unit gives the battery sensor values ---- */
    a = await start(IBS, 'ibs');
    a.rpm(800 * 4); a.speed(30);
    await a.draw();
    await advance(4000);
    tx = await a.draw();
    assert(has(tx, '12.60'), 'IBS: 12.60 V from 402B');
    assert(tx.includes('CURRENT') && !has(tx, 'VOLTAGE, LAST 2 MIN'), 'IBS: the current shown, no trend in its place');
    assert(has(tx, '-5.0'), 'IBS: 5.0 A out of the battery shown as -5.0 (+ = charging): ' + tx.join(' | '));
    assert.strictEqual(after(tx, 'HEALTH (SOH)'), '72 %', 'IBS: state of health 72 %');
    const cap = after(tx, 'CAPACITY') || '';
    assert(cap.indexOf('80 Ah') >= 0 && cap.indexOf('orig. 90') >= 0, 'IBS: 80 Ah with the original 90 beside it: ' + cap);
    console.log('ok   battery sensor: 12.60 V, -5.0 A, SOH 72 %, 80 Ah (orig. 90)');

    Date.now = realNow;
    console.log('battery12v checks passed (G20 voltage source / read-only / engine off / parked / battery sensor).');
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
