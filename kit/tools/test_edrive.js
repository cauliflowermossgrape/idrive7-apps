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
class FakeReader {
    constructor() { this.raws = {}; this.pick = {}; reader = this; }
    static label(c) { return c.did; }
    key(c) { return c.did; }
    async value(key) { return values[key] === undefined ? null : values[key]; }
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
    const clicks = {}, texts = [];
    return {
        clicks, texts, ui: { onClick: (id, fn) => { clicks[id] = fn; }, text() {}, image: async () => {} },
        settings: { get: (k) => S[k], onChange() {} },
        log: quiet, spec: SPEC, dataDir: dir,
        signals: { watch: () => Promise.resolve({}) },
        onTab() {}, hideButton() {}, onScroll() {}, loop() {},
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
    [MAIN, LIVE, path.join(ROOT, 'apps', 'edrive', 'range.js')].forEach((f) => { delete require.cache[f]; });
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
        // a charge done while the head unit slept is logged once: the start that logs it also keeps the charge it
        // read, even when the head unit goes off within 2 min (before the next timed save)
        const dir = tmp('charge');
        let b = await boot(dir, { soc: 20, soh: 90, v12: 12.5 });
        await b.read();
        assert.strictEqual(state(dir).lastSoc, 20);
        now += 10 * 3600000;                                     // overnight on the charger
        b = await boot(dir, { soc: 90, soh: 90, v12: 12.5 });
        await b.read();
        assert.strictEqual(state(dir).log.length, 1, 'the charge is logged');
        assert.strictEqual(state(dir).lastSoc, 90, 'battery.json keeps the charge that closed the session');
        now += 3600000;                                          // switched off a minute later, on again an hour on
        b = await boot(dir, { soc: 90, soh: 90, v12: 12.5 });
        await b.read();
        assert.strictEqual(state(dir).log.length, 1, 'the same charge is not logged again at the next start');
        // the diagnostic link back after 10 min while charging, a save (the health read) just before: the charge
        // logged by the next reading is saved with it, not left to the 2 min timer
        values.soc = null; now += 10 * 60000;
        await b.readNow();                                       // no charge reading, health read and saved
        values.soc = 97; now += 30000;
        await b.read();
        assert.strictEqual(state(dir).log.length, 2, 'the second charge is logged');
        assert.strictEqual(state(dir).lastSoc, 97, 'and saved with its reading');
        // the head unit switched off: the reading the 2 min timer has not saved yet goes with the exit
        values.soc = 96.5; now += 30000;
        await b.read();
        assert.strictEqual(state(dir).lastSoc, 97);
        b.exit();
        assert.strictEqual(state(dir).lastSoc, 96.5, 'saved on exit');
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
        b.reader.raws[SPEC.config.battery.soc[0].did] = { why: 'WWWWWWWWWWWWWWWWWWWWWWWWWW', t: now };
        for (let i = 0; i < 3; i++) await b.page();
        b.texts.length = 0;
        await b.page();
        const status = b.texts.find((x) => x.x === 1000 && x.y > 178), read = b.texts.find((x) => x.x === 1290 && x.y > 178);
        assert(status && read, 'diagnostic status and read cells drawn');
        assert.strictEqual(status.str, 'W'.repeat(23) + '…', 'English status cut at 24 characters as before');
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
    console.log('eDrive checks passed (charge logged once across restarts / baseline without seat heating / kWh without SOH / use + otherKw saved).');
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
