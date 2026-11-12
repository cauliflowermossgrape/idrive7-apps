'use strict';

// eDrive's saved state against stubbed kit modules (mgu, the diagnostic link) and a clock moved by hand: the charge
// log across restarts (main.js) and what live.js learns and keeps. No SDK, vehicle or capture needed:
//   node kit/tools/test_edrive.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const EventEmitter = require('events');
const Module = require('module');

const ROOT = path.join(__dirname, '..', '..'), KIT = path.join(ROOT, 'kit', 'runtime');
const MAIN = path.join(ROOT, 'apps', 'edrive', 'main.js'), LIVE = path.join(ROOT, 'apps', 'edrive', 'live.js');
const SPEC = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps', 'edrive', 'app.json'), 'utf8'));
const { Recorder: Canvas } = require(path.join(KIT, 'record'));        // what the kit draws into (display.js)
const themes = require(path.join(KIT, 'themes'));

// the clock, and timers that only run when a test fires them
let now = Date.UTC(2026, 9, 1, 18);
Date.now = () => now;
let timers = [];
global.setTimeout = (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; };
global.clearTimeout = (t) => { timers = timers.filter((x) => x !== t); };
global.setInterval = () => 0;
const flush = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r)); };
const fire = async (pred) => {
    const t = timers.filter((x) => pred(x.ms)).pop();
    assert(t, 'timer scheduled');
    timers = timers.filter((x) => x !== t);
    t.fn(); await flush();
};

// the kit modules: './kit/x' from kit/runtime, the SDK-bound ones stubbed
let app = null, diag = null, reader = null, values = {};
class FakeDiag extends EventEmitter { constructor() { super(); this.available = false; diag = this; } init() {} }
// the battery unit's values by name; other units (the 48 V battery, the converter, the engine unit's 12 V
// sensor) answer `replies` by '<ecu>:<DID>' (the data after the DID, hex), through the real reader
let replies = {}, asked = [];
const RealReader = require(path.join(KIT, 'dids')).DidReader;
class FakeReader extends RealReader {
    constructor() {
        super({ physical: async (ecu, sid, req) => {
            asked.push({ ecu, sid, req: req.slice() });
            // OBD service 01 ('<ecu>:OBD <PID>'); 'NRC xx': the unit refuses
            if (sid === 0x01) {
                const o = replies[ecu + ':OBD ' + req[0].toString(16).toUpperCase().padStart(2, '0')];
                return !o ? null : /^NRC/.test(o) ? [0x7F, sid, parseInt(o.slice(4), 16)] : [0x41, req[0]].concat(o.split(' ').map((x) => parseInt(x, 16)));
            }
            const did = ((req[0] << 8) | req[1]).toString(16).toUpperCase().padStart(4, '0'), r = replies[ecu + ':' + did];
            if (r && /^NRC/.test(r)) return [0x7F, sid, parseInt(r.slice(4), 16)];
            if (r) return [0x62, req[0], req[1]].concat(r.split(' ').map((x) => parseInt(x, 16)));
            // the 12 V voltage (vals.v12): the engine unit's control module voltage (F442, 1 mV)
            if (ecu === 18 && did === 'F442' && typeof values.v12 === 'number') return [0x62, 0xF4, 0x42, Math.round(values.v12 * 1000) >> 8, Math.round(values.v12 * 1000) & 0xFF];
            // the battery unit (0x07) is there while the test gives it a charge value (null: no reading now)
            if (ecu === 7 && values.soc !== undefined) {
                return did === 'DDBC' && typeof values.soc === 'number' ? [0x62, req[0], req[1], (values.soc * 10) >> 8, (values.soc * 10) & 0xFF] : [0x7F, sid, 0x31];
            }
            return null;
        } }, { ecu: 7 });
        reader = this;
    }
    async value(key, list) {
        if (values[key] === undefined && (list || []).some((c) => c.ecu != null && c.ecu !== 7)) return super.value(key, list);
        if (values[key] === undefined) (list || []).forEach((c) => { this.raws[this.key(c)] = { why: 'no reply', bytes: '' }; });
        return values[key] === undefined ? null : values[key];
    }
}
const stubs = {
    './kit/mgu': { run(a) { app = a; } },
    './kit/diag': { Diag: FakeDiag, hex: require(path.join(KIT, 'diag')).hex },
    './kit/dids': { DidReader: FakeReader },
};
const load = Module._load;
Module._load = function (req, parent, isMain) {
    if (stubs[req]) return stubs[req];
    if (req.startsWith('./kit/')) return load.call(this, path.join(KIT, req.slice(6)), parent, isMain);
    return load.call(this, req, parent, isMain);
};

const dirs = [];
const tmp = (name) => { const d = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'edrive-' + name + '-')); dirs.push(d); return d; };
const quiet = { info() {}, warn() {}, error() {} };
function context(dir, set) {
    const defaults = {};
    SPEC.settings.forEach((s) => { defaults[s.key] = s.default; });
    const S = Object.assign(defaults, { demo: 'off' }, set || {});
    const clicks = {}, texts = [], watchers = {};
    return {
        clicks, texts, watchers, ui: { onClick: (id, fn) => { clicks[id] = fn; }, text() {}, image: async () => {} },
        settings: { get: (k) => S[k], onChange() {} },
        log: quiet, spec: SPEC, dataDir: dir,
        signals: { watch: (iface, ver, handlers) => { Object.assign(watchers, handlers); return Promise.resolve({}); } },
        onTab() {}, hideButton() {}, onScroll() {}, loop(name, fps, fn) { this.frame = fn; },
        theme: () => themes.theme('m_tricolour'), canvas: (w, h) => {
            const cv = new Canvas(w, h), text = cv.text.bind(cv);
            cv.text = (str, x, y, size, color, opts) => {
                const width = text(str, x, y, size, color, opts);
                texts.push({ str: String(str), x, y, width });
                return width;
            };
            return cv;
        },
    };
}

/**
 * One start of eDrive (a fresh process): the battery unit answers `vals`; read() is one poll, readNow() the
 * "Read now" button (the health read too), exit() the process exiting (its exit handlers only: kept off this process's)
 */
async function boot(dir, vals, set) {
    [MAIN, LIVE, path.join(ROOT, 'apps', 'edrive', 'range.js'), path.join(ROOT, 'apps', 'edrive', 'battery12.js')].forEach((f) => { delete require.cache[f]; });
    require(MAIN);
    values = vals; timers = [];
    const ctx = context(dir, set), before = process.listeners('exit');
    await app.start(ctx);
    const onExit = process.listeners('exit').filter((f) => before.indexOf(f) < 0);
    onExit.forEach((f) => process.removeListener('exit', f));
    await flush();
    return {
        texts: ctx.texts, reader,
        page: async () => { await ctx.clicks.BTN_PAGE(); await flush(); },
        read: async () => { diag.available = true; diag.emit('available', true); await flush(); },
        readNow: async () => { diag.available = true; ctx.clicks.BTN_READ(); await flush(); },
        draw: async () => { ctx.texts.length = 0; await ctx.frame(); return ctx.texts.map((x) => x.str); },
        drive: (kmh) => ctx.watchers.statusCarSpeed2({ speedVehicleCentreOfGravity: kmh / 0.015625 }),
        signal: (name, v) => ctx.watchers[name](v),
        exit: () => onExit.forEach((f) => f(0)),
    };
}
const state = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'battery.json'), 'utf8'));

/** eDrive Live (live.js) on its own, with eDrive's live values L; the battery unit answers `vals` by DID. */
function startLive(dir, L, vals, config) {
    delete require.cache[LIVE];
    timers = [];
    const raws = {};
    const reader = {
        raws, key: (p) => p.did,
        async read(p) {
            const v = vals[p.did];
            if (v === undefined) return null;
            raws[p.did] = { bytes: '62 ' + p.did.slice(0, 2) + ' ' + p.did.slice(2) + ' 00 00' };
            return v;
        },
    };
    const ctx = context(dir);
    ctx.spec = { config: Object.assign({ battery: { fast: { hvV: [{ did: 'DD68', fields: { v: {} } }], hvI: [{ did: 'DD69', fields: { a: {} } }] }, slow: {} } }, config || {}) };
    const exclusive = (fn) => fn();
    return require(LIVE)(ctx, { diag: { available: true, on() {}, physical: async () => null }, reader, exclusive, live: L, page: () => 'main', climateKw: () => 0 });
}
const power = () => fire((ms) => ms === 60 || ms === 2000);
const liveState = (dir) => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'live.json'), 'utf8')); } catch (e) { return {}; } };
const L0 = () => ({ speed: 0, rpm: 0, rpmT: 0, climate: false, seats: {}, wheel: false, standSince: now - 60000, blower: 0, blowerTop: 8, ambient: 10 });

const checks = [
    ['1. charge logged once across restarts', async () => {
        // a charge done while the head unit slept stays open until the car drives off, then is logged once: each
        // start keeps the charge it read, even when the head unit goes off within 2 min (before the next timed save)
        const dir = tmp('charge');
        let b = await boot(dir, { soc: 20, soh: 90, v12: 12.5 });
        await b.read();
        assert.strictEqual(state(dir).lastSoc, 20);
        now += 10 * 3600000;                                     // overnight on the charger
        b = await boot(dir, { soc: 90, soh: 90, v12: 12.5 });
        await b.read();
        assert.deepStrictEqual([state(dir).log, state(dir).session.from, state(dir).session.to], [undefined, 20, 90],
            'the charge is open until the car drives off');
        assert.strictEqual(state(dir).lastSoc, 90, 'battery.json keeps the charge read');
        now += 3600000;                                          // switched off a minute later, on again an hour on
        b = await boot(dir, { soc: 90, soh: 90, v12: 12.5 });
        await b.read();
        b.drive(30); values.soc = 89.8; now += 30000;
        await b.read();
        assert.deepStrictEqual(state(dir).log.map((c) => [c.from, c.to]), [[20, 90]], 'driving off logs the charge once');
        // the diagnostic link back after 10 min while charging, a save (the health read) just before: the charge
        // read by the next reading is saved with it, not left to the 2 min timer
        b.drive(0); values.soc = null; now += 10 * 60000;
        await b.readNow();                                       // no charge reading, health read and saved
        values.soc = 97; now += 30000;
        await b.read();
        assert.deepStrictEqual([state(dir).session.from, state(dir).session.to, state(dir).lastSoc], [89.8, 97, 97],
            'the second charge is saved with its reading');
        b.drive(30); values.soc = 96.5; now += 30000;
        await b.read();
        assert.strictEqual(state(dir).log.length, 2, 'the second charge is logged');
        // the head unit switched off: the reading the 2 min timer has not saved yet goes with the exit
        values.soc = 96.3; now += 30000;
        await b.read();
        assert.strictEqual(state(dir).lastSoc, 96.5);
        b.exit();
        assert.strictEqual(state(dir).lastSoc, 96.3, 'saved on exit');
    }],
    ['1c. one charge across the car waking during it', async () => {
        // plugged in at 7 %, the car wakes now and then while it charges (24 %, 70 %, 100 %): one charge, 7 % to 100 %
        const dir = tmp('wakes');
        let b = await boot(dir, { soc: 7, soh: 90, v12: 12.5 });
        await b.read();
        for (const soc of [24, 24.6, 70, 100]) {
            now += soc === 24.6 ? 30000 : 2 * 3600000;           // 24.6: read while still awake
            if (soc !== 24.6) b = await boot(dir, { soc, soh: 90, v12: 12.5 });
            values.soc = soc;
            await b.read();
        }
        assert.strictEqual(state(dir).log, undefined, 'nothing logged while parked');
        now += 3600000;
        b = await boot(dir, { soc: 100, soh: 90, v12: 12.5 });
        b.drive(40);
        await b.read();
        assert.deepStrictEqual(state(dir).log.map((c) => [c.from, c.to]), [[7, 100]], 'one charge, 7 % to 100 %');
    }],
    ['1b. nothing to save: no file on exit', async () => {
        // demo / no hybrid system: nothing read, so the exit writes nothing (no battery.json on a first run)
        const dir = tmp('idle');
        const b = await boot(dir, {});
        b.exit();
        assert(!fs.existsSync(path.join(dir, 'battery.json')), 'no battery.json written');
    }],
    ['2. baseline without seat / wheel heating', async () => {
        // the on-board baseline is learned only with seat and steering-wheel heating off (eDrive's values, L)
        const dir = tmp('base');
        startLive(dir, Object.assign(L0(), { seats: { DR: 3 }, wheel: true }), { DD68: 350, DD69: -3 });   // 1.05 kW, heating on
        for (let i = 0; i < 3; i++) { now += 2000; await power(); }
        assert.strictEqual(liveState(dir).baseKw, undefined, 'seat / wheel heating kept out of the baseline');
        startLive(dir, L0(), { DD68: 350, DD69: -1 });                                                    // 0.35 kW, all off
        for (let i = 0; i < 3; i++) { now += 2000; await power(); }
        assert(Math.abs(liveState(dir).baseKw - 0.35) < 1e-9, 'baseline learned with everything off');
    }],
    ['3. kWh without a health reading', async () => {
        // no health reading yet (first run, or a car whose SOH read fails): the charge still has its energy, at
        // 100 % health as the range uses (kwhPerPct)
        const dir = tmp('nosoh');
        let b = await boot(dir, { soc: 30, soh: null, v12: 12.5 });
        await b.read();
        now += 8 * 3600000;
        b = await boot(dir, { soc: 80, soh: null, v12: 12.5 });
        b.drive(30);
        await b.read();
        const c = state(dir).log[0];
        assert(c && typeof c.kwh === 'number', 'logged charge has kWh: ' + JSON.stringify(c));
        assert(Math.abs(c.kwh - 50 / 100 * SPEC.settings.find((s) => s.key === 'designKwh').default) < 1e-9);
    }],
    ['4. use and otherKw saved on their own', async () => {
        // measured consumption (st.use) is kept across restarts: driving, climate on, so the baseline never learns
        let dir = tmp('use');
        const L = Object.assign(L0(), { speed: 50, climate: 'ac', standSince: 0 });
        let lv = startLive(dir, L, { DD68: 350, DD69: -30 });      // 10.5 kW at 50 km/h
        for (let i = 0; i < 5; i++) { now += 2000; await power(); }
        assert(lv.consumption().km > 0);
        assert(liveState(dir).use && liveState(dir).use.km > 0, 'st.use saved: ' + JSON.stringify(liveState(dir)));
        lv = startLive(dir, L, { DD68: 350, DD69: -30 });
        assert(lv.consumption().km > 0, 'st.use back after a restart');
        // the climate's other draw (st.otherKw): standing, climate on, the climate unit's compressor figure
        dir = tmp('other');
        const probes = [{ name: 'ac', ecu: 120, did: 'D8D2', factor: 0.001 }];
        lv = startLive(dir, Object.assign(L0(), { climate: 'ac' }), { DD68: 400, DD69: -5, D8D2: 1000 }, { probes });   // 2 kW, compressor 1 kW
        now += 2000; await power();
        lv.draw('battery', new Canvas(1600, 520), themes.theme('m_tricolour'));    // the page shown: the slow reads run
        await fire((ms) => ms === 5000);
        // 2 kW - the 0.35 kW baseline - 1 kW compressor
        assert(Math.abs(liveState(dir).otherKw - 0.65) < 1e-9, 'st.otherKw saved: ' + JSON.stringify(liveState(dir)));
    }],
    ['4b. driving saves live.json every 5 min (flash), the rest at shutdown', async () => {
        const dir = tmp('use5'), L = Object.assign(L0(), { speed: 50, climate: 'ac', standSince: 0 });
        const before = process.listeners('exit').length;
        startLive(dir, L, { DD68: 350, DD69: -30 });
        const atExit = process.listeners('exit').slice(before);
        for (let i = 0; i < 5; i++) { now += 2000; await power(); }
        const km0 = (liveState(dir).use || {}).km;
        assert(km0 > 0, 'the first measurement saved');
        for (let i = 0; i < 120; i++) { now += 2000; await power(); }        // 4 min more
        assert.strictEqual(liveState(dir).use.km, km0, 'live.json written more often than every 5 min');
        atExit.forEach((fn) => fn());                                       // MainApp's shutdown
        assert(liveState(dir).use.km > km0, 'the last minutes lost at shutdown');
        process.removeListener('exit', atExit[0]);
    }],
    ['5. plural forms come from the locale catalogs', async () => {
        const { plural, PLURAL_RULES } = require(path.join(KIT, 'i18n'));
        const ru = require(path.join(KIT, 'locales', 'ru.json'));
        const form = (catalog, lang, n, one, other) => catalog[one + '|' + other].split('|')[PLURAL_RULES[lang](n)];
        const cases = [[0, 2], [1, 0], [2, 1], [4, 1], [5, 2], [11, 2], [12, 2], [13, 2], [14, 2],
            [21, 0], [22, 1], [24, 1], [25, 2], [101, 0], [102, 1], [105, 2], [111, 2], [114, 2]];
        const faults = ['ошибка', 'ошибки', 'ошибок'], charges = ['зарядка', 'зарядки', 'зарядок'];
        cases.forEach(([n, i]) => {
            assert.strictEqual(form(ru, 'ru', n, 'fault', 'faults'), faults[i], n + ' faults');
            assert.strictEqual(form(ru, 'ru', n, 'charge', 'charges'), charges[i], n + ' charges');
        });
        [0, 1, 2, 11, 21].forEach((n) => {
            assert.strictEqual(plural(n, 'fault', 'faults'), n === 1 ? 'fault' : 'faults');
            assert.strictEqual(plural(n, 'not', 'in catalog', 'ru'), n === 1 ? 'not' : 'in catalog', 'missing row falls back to English');
        });
    }],
    ['6. English diagnostic status keeps its layout (Russian alone moves and fits the column)', async () => {
        const b = await boot(tmp('status-width'), {}, { diagPage: true });
        b.reader.raws[b.reader.key(SPEC.config.battery.soc[0])] = { why: 'WWWWWWWWWWWWWWWWWWWWWWWWWW', t: now };
        for (let i = 0; i < 3; i++) await b.page();
        b.texts.length = 0;
        await b.page();
        const status = b.texts.find((x) => x.x === 1000 && x.y > 178), read = b.texts.find((x) => x.x === 1290 && x.y > 178);
        assert(status && read, 'diagnostic status and read cells drawn');
        assert.strictEqual(status.str, 'W'.repeat(23) + '…', 'English status cut at 24 characters as before');
    }],
    ['8. a 48 V mild hybrid: found by itself, its own page only', async () => {
        // no high-voltage battery (the battery unit never answers), the 48 V battery and its converter do
        const dir = tmp('mild');
        replies = {
            '2:AA56': '12 84 FF 88 00 30 08 0F C3 50 C2 EC 00 00 3E 5A 12 82 6E 25 2E 00 6A 68 00 00 60 58',
            '84:DA90': '37 14 B9 28 01 54 FF 97 01 E0 FE 0E 09',
            '18:5852': '27 88', '18:56F0': '54', '18:59AA': '5C', '18:5854': '59', '18:4604': '01 40',
        };
        const b = await boot(dir, { v12: 12.6 }, { demo: 'off' });
        for (let i = 0; i < 4; i++) { now += 20000; await b.read(); }
        assert.deepStrictEqual([state(dir).noHybrid, state(dir).mild48], [true, true], JSON.stringify(state(dir)));
        const t = await b.draw();
        assert(t.includes('48 V SYSTEM') && !t.includes('RANGE') && !t.includes('CHARGE LOG'), t.join(' | '));
        ['62', '47.4 V', '-0.57 kW', '96 %', 'CHARGING', 'Charging 12 V', '14.1 V   +34.0 A   +480 W', '47.4 V   -10.5 A   -498 W']
            .forEach((s) => assert(t.some((x) => x.includes(s)), s + ' in ' + t.join(' | ')));
        // Details: what the battery reports about its life
        await b.page();
        const det = await b.draw();
        ['412.6 kWh', '5000.0 Ah', '4990.0 Ah', '47.38 V', '11.0 Ah', '10.6 Ah', '10.4 Ah', '11.50 mOhm', '9.25 mOhm', '90 % · 88 %']
            .forEach((x) => assert(det.includes(x), x + ' in ' + det.join(' | ')));
        assert(det.includes('DETAILS'), 'the Details tab');
        // remembered: the next start shows the 48 V page before anything is read
        const b2 = await boot(dir, {}, { demo: 'off' });
        assert((await b2.draw()).includes('48 V SYSTEM'));
        replies = {};
    }],
    ['9b. the 12 V charge from the car signal when the battery sensor does not answer', async () => {
        const dir = tmp('signal');
        replies = {};
        const b = await boot(dir, { v12: 12.5 }, { demo: 'off', hybrid: 'no' });
        b.signal('statusBattery2', { conditionBatteryChargingCondition: 77 });
        now += 20000; await b.read();
        const t = await b.draw();
        assert(t.includes('77') && t.includes('the car\'s signal'), 'the car signal\'s charge: ' + t.join(' | '));
    }],
    ['9. no hybrid system: the 12 V battery with the battery sensor\'s values', async () => {
        const dir = tmp('none');
        replies = { '18:5852': '27 88', '18:56F0': '54', '18:59AA': '5C', '18:5854': '59', '18:4604': '01 40' };
        const b = await boot(dir, { v12: 12.5 }, { demo: 'off' });
        for (let i = 0; i < 7; i++) { now += 20000; await b.read(); }
        assert.deepStrictEqual([state(dir).noHybrid, state(dir).no48, !!state(dir).mild48], [true, true, false], JSON.stringify(state(dir)));
        const t = await b.draw();
        assert(t.includes('12 V BATTERY') && t.includes('CURRENT') && !t.includes('48 V SYSTEM'), t.join(' | '));
        ['+2.4 A', '84', '92 %', '40 A', 'CHARGING', 'Hybrid car? Settings > Hybrid system'].forEach((s) => assert(t.includes(s), s + ' in ' + t.join(' | ')));
        assert(t.includes('HISTORY'), 'the History tab');
        replies = {};
    }],
    ['11. a G20 320i (no hybrid system): 402B all FF, F442 refused - the voltage from OBD 42, kept; charge and capacity, History, regen, parked', async () => {
        const dir = tmp('g20');
        const v = (x) => { const m = Math.round(x * 1000); return [m >> 8, m & 0xFF].map((n) => n.toString(16).padStart(2, '0')).join(' '); };
        replies = {
            '18:402B': 'FF FF FF FF FF FF', '18:F442': 'NRC 31', '18:OBD 42': v(12.65), '24:F442': v(12.6),
            // 40AD: 48 % now, 50 52 49 47 51 before; time per band 0-40 .. 90-100 %
            '18:40AD': '30 00 32 00 34 00 31 00 2F 00 33 00 00 0A 01 F4 00 64 00 32 00 0A 00 00 FF FF',
            '18:40A9': '5A 00 50', '18:59AA': '5C',             // (no 5854 / 4604: the battery's temperature, the alternator)
        };
        asked = [];
        const b = await boot(dir, {}, { demo: 'off', hybrid: 'no' });
        await b.read();
        for (let k = 0; k < 3; k++) { now += 11000; await b.read(); }
        let t = await b.draw();
        assert(t.includes('12.65'), 'the voltage from OBD 42: ' + t.join(' | '));
        assert.strictEqual(state(dir).v12Pick, SPEC.config.battery.v12.findIndex((c) => c.ecu === 18 && c.obd === '42'), 'the source kept');
        assert(t.includes('VOLTAGE, LAST 2 MIN') && !t.includes('POWER'), 'no current from this engine unit: the voltage trend in its place');
        ['48', '~43 / 90 Ah', '90 Ah  (orig. 80)', '50  52  49  47  51 %', '92 %', 'HEALTH (SOH)', 'low - use a battery charger']
            .forEach((x) => assert(t.includes(x), x + ' in ' + t.join(' | ')));
        // the temperature and the alternator this engine unit does not give: the engine and the voltage's source in their place
        assert(!t.includes('TEMPERATURE') && !t.includes('ALTERNATOR') && t.includes('OUTSIDE') && t.includes('ENGINE') && t.includes('VOLTAGE FROM')
            && t.includes('DME  ·  OBD 42'), 'rows: ' + t.join(' | '));
        assert(asked.every((q) => q.sid === 0x22 || q.sid === 0x01), 'read-only: UDS 22 / OBD 01 only');
        // the next reads ask the source that answered first (no time lost on the refusing / FF ones)
        asked = []; now += 2000; await b.read();
        const volt = asked.filter((q) => q.ecu === 18 && (q.sid === 0x01 || [0xF442, 0x5853].indexOf((q.req[0] << 8) | q.req[1]) >= 0));
        assert.deepStrictEqual(volt.map((q) => q.sid), [0x01], 'only OBD 42 asked for the voltage');
        // a read or two missed (the engine unit busy): the last voltage stays up, dimmed, not a blank
        delete replies['18:OBD 42'];
        now += 15000; await b.read();
        t = await b.draw();
        assert(t.includes('12.65') && !t.includes('--.--'), 'the last voltage kept: ' + t.join(' | '));
        // charging while the car slows down: REGEN
        replies['18:OBD 42'] = v(14.6);
        now += 2000; await b.read();
        b.drive(60); now += 1000; b.drive(57);
        t = await b.draw();
        assert(t.includes('slowing down: braking energy charges the battery') && t.includes('14.60'), 'regen: ' + t.join(' | '));
        // History: the charge the car recorded, time per charge band
        await b.page();
        t = await b.draw();
        assert(t.includes('HISTORY') && t.includes('TIME SPENT PER CHARGE BAND') && t.includes('40-60%') && t.includes('75%'), t.join(' | '));
        // parked: nothing is read, so the car can sleep; Read now asks again
        // (the page left open: drawn every few seconds - a gap counts as opening it again, and opening it reads)
        b.drive(0); await b.page();                  // back to the 12 V battery page
        for (let k = 0; k < 11 * 15; k++) { now += 4000; await b.draw(); }
        asked = [];
        await b.read();
        assert.deepStrictEqual(asked.filter((q) => q.ecu === 18 || q.ecu === 24), [], 'no reads parked');
        t = await b.draw();
        assert(t.includes('PAUSED') && t.includes('14.60'), 'paused, the last voltage: ' + t.join(' | '));
        await b.readNow();
        assert(asked.some((q) => q.ecu === 18), 'Read now reads');
        replies = {};
    }],
    ['10. a plug-in hybrid stays as it is; the setting picks the system', async () => {
        const dir = tmp('phev');
        const b = await boot(dir, { soc: 55, soh: 90, v12: 12.5 }, { demo: 'off' });
        for (let i = 0; i < 3; i++) { now += 20000; await b.read(); }
        assert(!state(dir).noHybrid && !state(dir).mild48, JSON.stringify(state(dir)));
        assert((await b.draw()).includes('RANGE'));
        assert((await (await boot(dir, {}, { demo: 'off', hybrid: '48v' })).draw()).includes('48 V SYSTEM'));
        assert((await (await boot(dir, {}, { demo: 'off', hybrid: 'no' })).draw()).includes('ALTERNATOR'));
    }],
    ['12. the car locked and left (VehicleCondition: parked, nobody in it): nothing is read, so it can sleep; the charge done meanwhile is logged from the level before it', async () => {
        const dir = tmp('left');
        const b = await boot(dir, { soc: 6, soh: 90, v12: 12.5 }, { demo: 'off' });
        const reads = [], value = reader.value.bind(reader);
        reader.value = (k, l) => { reads.push(k); return value(k, l); };
        now += 20000; await b.read();
        assert(reads.indexOf('soc') >= 0, 'in use: the charge is read');
        b.signal('VehicleCondition', { statusConditionVehicle: 'PARKEN_BN_IO' });
        reads.length = 0; asked = [];
        values.soc = 72; for (let i = 0; i < 3; i++) { now += 20000; await b.read(); }
        values.soc = 100; now += 3 * 3600000; await b.read();
        assert.deepStrictEqual([reads, asked], [[], []], 'locked and left: nothing read');
        b.signal('VehicleCondition', { statusConditionVehicle: 'WOHNEN' });
        now += 20000; await b.read();
        assert(reads.indexOf('soc') >= 0, 'someone in the car again: read');
        const s = state(dir).session || state(dir).lastCharge;
        assert(s && s.from === 6 && s.to === 100, 'the charge from 6 %: ' + JSON.stringify(s));
    }],
    ['13. a charge jump right after the head unit wakes, its clock not yet set and a speed sent: logged from the level before it', async () => {
        const dir = tmp('jump');
        let b = await boot(dir, { soc: 6, soh: 90, v12: 12.5 }, { demo: 'off' });
        now += 20000; await b.read();
        b.exit();
        // the next start: the clock as at switch-off (2 min later), the car already rolling, 71 %
        now += 120000;
        b = await boot(dir, { soc: 71, soh: 90, v12: 12.5 }, { demo: 'off' });
        b.drive(8); await b.read();
        const c = state(dir).lastCharge;
        assert(c && c.from === 6 && c.to === 71, 'the charge 6 -> 71: ' + JSON.stringify(c));
    }],
    ['7. charge totals keep English singular and plural', async () => {
        const dir = tmp('charge-counts'), today = new Date(), current = today.getTime();
        const previous = new Date(today.getFullYear(), today.getMonth() - 1, 1).getTime();
        const log = Array.from({ length: 21 }, (_, i) => ({ from: 10, to: 20, fromT: current - 3600000, toT: i ? previous - i * 1000 : current, kwh: 1 }));
        fs.writeFileSync(path.join(dir, 'battery.json'), JSON.stringify({ log }));
        const b = await boot(dir, {});
        assert.strictEqual(state(dir).log.length, 21, 'saved charge log loaded');
        for (let i = 0; i < 2; i++) await b.page();
        b.texts.length = 0;
        await b.page();
        const month = b.texts.find((x) => x.x === 1552 && x.y === 116), all = b.texts.find((x) => x.x === 1552 && x.y === 208);
        assert(month && /^1 charge  ·  \+/.test(month.str), month && month.str);
        assert(all && /^21 charges  ·  \+/.test(all.str), all && all.str);
    }],
];

(async () => {
    const failed = [];
    for (const [name, fn] of checks) {
        try { await fn(); } catch (e) { failed.push(name); console.error('FAIL ' + name + ': ' + e.message); }
    }
    dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
    if (failed.length) process.exit(1);
    console.log('eDrive system checks passed (48 V mild hybrid / none / G20 12 V: voltage source kept, charge, History, regen, parked / setting).');
    console.log('eDrive checks passed (charge logged once across restarts / baseline without seat heating / kWh without SOH / use + otherKw saved).');
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
