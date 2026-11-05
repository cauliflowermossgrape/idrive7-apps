'use strict';

// M Vitals' misfire counter Reset against stubbed kit modules (mgu, the diagnostic link) in demo mode: the button on
// the Fuel & ignition page (where the kit runs the screen), its confirm step, the counts from then on, kept across a
// restart, and given up when the engine unit starts a new driving cycle. Nothing is sent to the car.
//   node kit/tools/test_car_vitals.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const EventEmitter = require('events');
const Module = require('module');

const ROOT = path.join(__dirname, '..', '..'), KIT = path.join(ROOT, 'kit', 'runtime');
const MAIN = path.join(ROOT, 'apps', 'car_vitals', 'main.js');
const SPEC = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps', 'car_vitals', 'app.json'), 'utf8'));
const { Recorder: Canvas } = require(path.join(KIT, 'record'));
const themes = require(path.join(KIT, 'themes'));

global.setInterval = () => 0;
let app = null;
class FakeDiag extends EventEmitter { constructor() { super(); this.available = false; } init() {} }
class FakeReader { constructor() { this.raws = {}; this.pick = {}; } static label(c) { return c.did; } key(c) { return c.did; } async value() { return null; } }
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

/** One start of M Vitals in demo mode; draw() renders a frame, as the kit running the screen does (own). */
async function boot(dir) {
    delete require.cache[MAIN];
    require(MAIN);
    const S = {};
    SPEC.settings.forEach((s) => { S[s.key] = s.default; });
    S.demo = 'on';
    const texts = [];
    let frame = null, last = null;
    const ctx = {
        ui: { onClick() {}, text() {}, image: async () => {} },
        settings: { get: (k) => S[k], onChange() {} },
        log: { info() {}, warn() {}, error() {} }, spec: SPEC, dataDir: dir,
        signals: { watch: () => Promise.resolve({}) },
        onTab(fn) { this.tab = fn; }, hideButton() {}, onScroll() {}, onTap() {}, loop(n, fps, fn) { frame = fn; },
        theme: () => themes.theme('m_tricolour'),
        canvas: (w, h) => {
            const cv = new Canvas(w, h), text = cv.text.bind(cv);
            cv.own = true;
            cv.text = (str, ...rest) => { texts.push(String(str)); return text(str, ...rest); };
            last = cv;
            return cv;
        },
    };
    await app.start(ctx);
    return {
        page: async (i) => { texts.length = 0; await ctx.tab(i); return texts.slice(); },
        draw: async () => { texts.length = 0; await frame(); return texts.slice(); },
        press: async (key) => { const tg = last.targets.find((x) => x.key === key); assert(tg, 'a ' + key + ' target on the page'); await tg.run(); },
        targets: () => last.targets.map((x) => x.key),
    };
}

(async () => {
    const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'vitals-'));
    try {
        const fuel = ['engine', 'thermal', 'fuel', 'chassis'].indexOf('fuel');
        let b = await boot(dir);
        let t = await b.page(fuel);
        assert(t.includes('this drive') && b.targets().includes('misfire'), 'the Misfires tile with Reset: ' + t.join(' | '));
        // the first press asks (Confirm), the second resets: the counts from now on, kept in misfire.json
        await b.press('misfire');
        assert((await b.draw()).includes('CONFIRM'), 'Reset asks to confirm first');
        assert(!fs.existsSync(path.join(dir, 'misfire.json')), 'nothing reset on the first press');
        await b.press('misfire');
        const saved = JSON.parse(fs.readFileSync(path.join(dir, 'misfire.json'), 'utf8'));
        assert(Array.isArray(saved.counts) && saved.counts.length === 6 && saved.t > 0, JSON.stringify(saved));
        t = await b.draw();
        assert(t.some((x) => /^since reset \d\d:\d\d$/.test(x)) && t.includes('0'), 'the counts since the reset: ' + t.join(' | '));
        // kept across a restart of the app
        b = await boot(dir);
        t = await b.page(fuel);
        assert(t.some((x) => /^since reset/.test(x)), 'still since the reset after a restart');
        // a count lower than its base: the engine unit started a new driving cycle - the reset is done with
        fs.writeFileSync(path.join(dir, 'misfire.json'), JSON.stringify({ counts: [5, 5, 5, 5, 5, 5], t: Date.now() }));
        b = await boot(dir);
        t = await b.page(fuel);
        assert(t.includes('this drive') && !fs.existsSync(path.join(dir, 'misfire.json')), 'a new driving cycle: this drive again');
        console.log('M Vitals misfire reset checks passed (confirm, since reset, kept across a restart, a new driving cycle).');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
