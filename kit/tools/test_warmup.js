'use strict';

// Warm-Up's turbo cool-down against a stubbed car (kit/car) and the head unit's clock jumping after start-up: the
// countdown counts a step back of the clock as no time, and "cooled" times its 20 s on the steady clock. No SDK or vehicle needed:
//   node kit/tools/test_warmup.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..', '..'), KIT = path.join(ROOT, 'kit', 'runtime');
const MAIN = path.join(ROOT, 'apps', 'warmup', 'main.js');
const SPEC = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps', 'warmup', 'app.json'), 'utf8'));
const { Recorder } = require(path.join(KIT, 'record'));        // what the kit draws into (display.js)
const themes = require(path.join(KIT, 'themes'));

// the steady clock (process.hrtime) and the head unit's wall clock, moved by hand
let mono = 5000, wall = Date.UTC(2026, 9, 1, 8);
process.hrtime = () => [Math.floor(mono / 1000), (mono % 1000) * 1e6];
Date.now = () => wall;

let app = null, car = null;
class FakeCar {
    constructor() { car = this; this.d = {}; }
    onSample(fn) { this.fn = fn; }
    data() { return this.d; }
    setRedline() {}   // the demo drive's rpm (engine.js profile)
}
// the gearbox oil (gearbox.js): set by hand here (gearC = null: the car has none); gearbox.js is tested on its own below
let gearC = null;
class FakeGearbox { start() { return this; } temp() { return gearC; } source() { return gearC === null ? null : 'EGS'; } }
const stubs = { './kit/mgu': { run(a) { app = a; } }, './kit/car': FakeCar, './gearbox': { Gearbox: FakeGearbox } };
const load = Module._load;
Module._load = function (req, parent, isMain) {
    if (stubs[req]) return stubs[req];
    if (req.startsWith('./kit/')) return load.call(this, path.join(KIT, req.slice(6)), parent, isMain);
    return load.call(this, req, parent, isMain);
};

/** A fresh Warm-Up (a new process); render() draws a frame and returns its texts in order. */
let render = null, tab = null, widgetDraw = null, clicks = {}, S = null, visible = null, extra = {};
const cells = {};
async function start(saved) {
    delete require.cache[MAIN];
    require(MAIN);
    S = {}; clicks = {};
    SPEC.settings.forEach((s) => { S[s.key] = s.default; });
    Object.assign(S, saved || {});
    let texts = [], frame = null;
    await app.start({
        ui: { image: async () => {}, isVisible: () => true, onVisible: (fn) => { visible = fn; }, onClick: (b, fn) => { clicks[b] = fn; } }, signals: extra.signals, settings: { get: (k) => S[k], set: (k, v) => { S[k] = v; }, onChange() {} }, onTab: (fn) => { tab = fn; }, spec: SPEC,
        widget: { loop: (fps, fn) => { widgetDraw = fn; }, onChange() {}, set: (id, k, v) => { cells[k] = v; } }, log: { info() {}, warn() {} },
        dataDir: fs.mkdtempSync(path.join(require('os').tmpdir(), 'warmup-')),   // engine.js keeps its profile here
        theme: () => themes.theme('m_tricolour'), loop: (name, fps, fn) => { frame = fn; },
        canvas: (w, h) => {
            const cv = new Recorder(w, h), text = cv.text.bind(cv);
            texts = [];
            cv.text = (str, ...a) => { texts.push(String(str)); return text(str, ...a); };
            return cv;
        },
    });
    render = async () => { await frame(); return texts; };
}
/** s seconds of samples 100 ms apart, both clocks running */
function drive(d, s) {
    for (let i = 0; i < s * 10; i++) { mono += 100; wall += 100; car.d = d; car.fn(d, wall); }
}
const HARD = { rpm: 5000, torque: 300, oil: 95, coolant: 90, speed: 120 };
const GENTLE = { rpm: 1500, torque: 50, oil: 95, coolant: 90, speed: 50 };
const checks = [
    ['countdown after the clock jumps back', async () => {
        await start();
        drive(HARD, 20);                          // 20 s hard: 90 s of cool-down
        drive(GENTLE, 10);
        wall -= 3 * 3600000;                      // the head unit sets its clock
        drive(GENTLE, 1);
        const t = await render();
        const i = t.indexOf('COOL-DOWN LEFT');
        assert(i >= 0 && t.indexOf('TURBO COOL-DOWN') >= 0, 'cooling down: ' + t.join(' | '));
        assert.strictEqual(t[i + 1], '79', 'cool-down left after 11 s gentle of 90 s');
    }],
    ['"cooled" clears 20 s on after the clock jumps back', async () => {
        await start();
        drive(HARD, 20);
        drive(GENTLE, 91);                        // cooled
        assert((await render()).indexOf('COOLED - OK TO SWITCH OFF') >= 0);
        wall -= 3 * 3600000;
        drive(GENTLE, 25);
        const t = await render();
        assert(t.indexOf('COOLED - OK TO SWITCH OFF') < 0 && t.indexOf('READY') >= 0, 'all clear: ' + t.join(' | '));
    }],
    ['"cooled" stays its 20 s after the clock jumps ahead', async () => {
        await start();
        drive(HARD, 20);
        drive(GENTLE, 91);                        // cooled
        wall += 3 * 3600000;
        drive(GENTLE, 5);
        assert((await render()).indexOf('COOLED - OK TO SWITCH OFF') >= 0, 'still cooled 5 s on');
        drive(GENTLE, 20);
        const t = await render();
        assert(t.indexOf('COOLED - OK TO SWITCH OFF') < 0 && t.indexOf('READY') >= 0, 'all clear: ' + t.join(' | '));
    }],
    ['gearbox oil: a third gauge, its own "ready in", and READY waits for it', async () => {
        gearC = 35;
        await start();
        drive(GENTLE, 5);                         // oil 95: warm
        // the status line: the text just before the first "ready in" row
        const status = (t) => t[t.findIndex((x) => / READY IN$/.test(x)) - 1];
        let t = await render();
        assert(t.indexOf('GEARBOX READY IN') >= 0 && t.indexOf('GEARBOX') >= 0, 'gearbox row and trend: ' + t.join(' | '));
        assert.strictEqual(status(t), 'GEARBOX WARMING UP', 'oil warm, gearbox cold');
        gearC = 65;
        drive(GENTLE, 5);
        t = await render();
        assert.strictEqual(status(t), 'READY', 'both warm');
        gearC = 130;
        t = await render();
        assert.strictEqual(status(t), 'GEARBOX HOT - EASE OFF', 'gearbox hot');
        gearC = null;
        t = await render();
        assert(t.indexOf('GEARBOX READY IN') < 0 && t.indexOf('COOLANT READY IN') >= 0 && status(t) === 'READY', 'no gearbox: as before: ' + t.join(' | '));
    }],
    ['Drives tab: each drive, its lowest and highest temperatures (issue #235)', async () => {
        gearC = null;
        const at = Date.UTC(2026, 10, 26, 7, 5);
        await start({ drives: [{ at, ms: 25 * 60000, ch: { oil: { min: 18, max: 104 }, coolant: { min: 20, max: 92 }, gearbox: { min: 15, max: 131 } } }] });
        await tab(3);
        let t = await render();
        assert(t.indexOf('GEARBOX OIL') >= 0 && t.indexOf('18 - 104°C') >= 0 && t.indexOf('20 - 92°C') >= 0 && t.indexOf('15 - 131°C') >= 0, 'Drive view: lowest - highest: ' + t.join(' | '));
        assert(t.indexOf('Recorded before Warm-Up 1.12: temperatures only') >= 0, 'a drive recorded before the summaries says so: ' + t.join(' | '));
        await clicks.BTN_VIEW();
        t = await render();
        assert(t.indexOf('LIST') >= 0 || t.indexOf('25 min') >= 0, 'List view: ' + t.join(' | '));
        assert(t.indexOf('25 min') >= 0 && t.indexOf('18 - 104°C') >= 0 && t.indexOf('15 - 131°C') >= 0, 'List view: the drive and its length: ' + t.join(' | '));
        await tab(0);
        assert((await render()).indexOf('GEARBOX OIL') < 0, 'back on the Warm-up tab');
        await start();
        await tab(3);
        assert((await render()).indexOf('Recorded from the next engine start') >= 0, 'none yet: says from when');
    }],
    ['Drives tab (#251): a drive summed up, compared, and before / after a marked change', async () => {
        gearC = null;
        const H = 3600000, base = Date.UTC(2026, 10, 1, 8);
        const drv = (i, kw, oilMax) => ({ at: base + i * 24 * H, ms: 30 * 60000, ch: { oil: { min: 20, max: oilMax }, coolant: { min: 20, max: 90 } },
            s: { km: 30 + (i % 3), moving: 1600, vAvg: 60 + (i % 2), vMax: 120, gFwd: 0.3, gBrake: 0.5, gSide: 0.4, brakes: 1, kwMax: kw, warm: 420 } });
        const list = [];
        for (let i = 0; i < 12; i++) list.unshift(drv(i, i < 6 ? 150 + (i % 2) : 165 + (i % 2), i < 6 ? 104 + (i % 2) : 98 + (i % 2)));
        await start({ drives: list, drivesMarks: [{ at: base + 5.5 * 24 * H, label: 'Service', odo: 50000 }] });
        await tab(3);
        let t = await render();
        assert(t.indexOf('DISTANCE') >= 0 && t.indexOf('MOST POWER') >= 0 && t.indexOf('HARD BRAKES') >= 0, 'Drive view: the six tiles: ' + t.join(' | '));
        assert(t.some((x) => /^green line: average while moving, 6[01] km\/h$/.test(x)), 'the average on the speed chart');
        await clicks.BTN_VIEW(); await clicks.BTN_VIEW();
        t = await render();
        assert(t.some((x) => /^This drive \(.*\) against the one before/.test(x)) && t.indexOf('Most power') >= 0, 'Compare view: ' + t.join(' | '));
        // the average: the 10 drives before the chosen one, not the newest 10 with the chosen one in them
        S.compareWith = 'avg10';
        await clicks.BTN_NEXT(); await clicks.BTN_NEXT();          // the third newest: 9 drives before it
        t = await render();
        assert(t.some((x) => /^This drive \(.*\) against the average of the 9 drives before it$/.test(x)), 'Compare: the average of the drives before it: ' + t.join(' | '));
        // drives 0 to 8 before it: 150, 151, ... (0 to 5) and 165, 166, 165 (6 to 8): 1399 / 9 = 155 kW
        assert(t.indexOf('155 kW') >= 0, 'Compare: the most power averaged over those 9: ' + t.join(' | '));
        for (let i = 0; i < 12; i++) await clicks.BTN_NEXT();     // the oldest: none before it
        t = await render();
        assert(t.some((x) => /^Needs two drives: there is none before this one/.test(x)), 'Compare: the oldest drive has none to compare with: ' + t.join(' | '));
        for (let i = 0; i < 12; i++) await clicks.BTN_PREV();
        S.compareWith = 'prev';
        await clicks.BTN_VIEW();
        t = await render();
        // power, average speed and time follow traffic and the right foot: changed, never better or worse, not in words
        assert(!t.some((x) => /^Most power /.test(x)) && t.some((x) => /^\+1\d %  changed$/.test(x)), 'Before / After: power only "changed": ' + t.join(' | '));
        assert(t.some((x) => /^Oil runs [56] °C cooler/.test(x)), 'Before / After: the oil cooler: ' + t.join(' | '));
        assert(t.indexOf('within normal variation') >= 0, 'what did not change is grey: ' + t.join(' | '));
        await clicks.BTN_MARK();
        t = await render();
        assert(t.some((x) => /Press Mark a change again/.test(x)), 'Mark a change asks again first');
        await clicks.BTN_MARK();
        assert(S.drivesMarks.length === 2 && S.drivesMarks[1].label === 'Service', 'pressed twice: marked');
    }],
    ['Drives: the reference for Compare, and diff.js\'s verdicts (review of #267)', async () => {
        const Drives = require(path.join(ROOT, 'apps', 'warmup', 'drives'));
        const D = require(path.join(ROOT, 'apps', 'warmup', 'diff'));
        const l = [{ start: 13, live: true }];
        for (let i = 12; i >= 0; i--) l.push({ start: i });
        const ref = Drives.reference(l, 2, true);
        assert(ref.length === 10 && ref[0].start === 10 && ref[9].start === 1, 'the 10 before the chosen one: ' + ref.map((d) => d.start));
        assert(Drives.reference(l, 0, true).every((d) => !d.live) && Drives.reference(l, 0, true)[0].start === 12, 'a live drive is never in it');
        assert(Drives.reference(l, 13, true).length === 0 && Drives.reference(l, 13, false).length === 0, 'the oldest: none');
        assert(Drives.reference(l, 1, false)[0].start === 11, 'the one before');
        // average speed, time per 10 km and the most power: changed only; hottest oil still better / worse
        const mk = (v, kw, oil) => ({ vAvg: v, km: 20, secs: 20 / v * 3600, kwMax: kw, oilMax: oil });
        const rs = D.rows([mk(50, 150, 104), mk(51, 151, 105), mk(50, 150, 104)], [mk(70, 170, 96), mk(71, 171, 97), mk(70, 170, 96)]);
        const st = (k) => rs.filter((r) => r.key === k)[0].state;
        assert(st('avgSpeed') === 'changed' && st('pace') === 'changed' && st('kw') === 'changed' && st('oil') === 'better', 'verdicts: ' + rs.map((r) => r.key + ' ' + r.state).join(', '));
        const hl = D.headline(rs, 'Service');
        assert(hl.length === 1 && /^Oil runs 8 °C cooler after Service$/.test(hl[0].text), 'in words only what got better or worse: ' + JSON.stringify(hl));
    }],
    ['Ready? tab: the tyre watch (polled) runs only while the page shows', async () => {
        const calls = [];
        extra = { signals: { watch: (iface, inst, h, log, opts) => { const w = { iface, opts, down: 0, shutdown: () => { w.down++; return Promise.resolve(); } }; calls.push(w); return Promise.resolve(w); } } };
        await start();
        extra = {};
        const tyres = () => calls.filter((c) => /\.TPMS$/.test(c.iface));
        assert(tyres().length === 1 && tyres()[0].opts.pollMs === 10000, 'watched with its re-read while shown');
        visible('MAIN', false);
        await new Promise((r) => setImmediate(r));
        assert(tyres()[0].down === 1, 'hidden: the watch and its re-read shut down');
        visible('MAIN', false);
        visible('MAIN', true);
        await new Promise((r) => setImmediate(r));
        assert(tyres().length === 2 && tyres()[0].down === 1 && tyres()[1].down === 0, 'shown again: one new watch');
        visible('MAIN', true);
        assert(tyres().length === 2, 'no second watch while one runs');
    }],
    ['Ready? tab (#252): the verdict, the cards, the cool-down next to them', async () => {
        gearC = null;
        await start();
        drive({ rpm: 1500, torque: 50, oil: 45, coolant: 70, speed: 40 }, 5);
        await tab(1);
        let t = await render();
        assert(t.indexOf('NOT YET') >= 0 && t.some((x) => /^The engine oil and coolant are still cold/.test(x)), 'cold: NOT YET and why: ' + t.join(' | '));
        // six cards (their titles are drawn as panel headers): the two temperatures, and four the stub car does not send
        assert(t.filter((x) => x === 'COLD').length === 2 && t.filter((x) => x === 'NO DATA').length === 4, 'the cards: ' + t.join(' | '));
        assert(t.some((x) => /^READY IN ABOUT \d+ MIN$/.test(x)), 'ready in about: ' + t.join(' | '));
        drive(HARD, 20); drive(GENTLE, 5);
        t = await render();
        assert(t.indexOf('READY') >= 0 && t.indexOf('AFTER A HARD DRIVE') >= 0, 'warm, and the cool-down after the pull: ' + t.join(' | '));
        assert(t.indexOf('s of gentle driving before switching off') >= 0, 'the countdown in words');
    }],
    ['home-screen widget: the big picture and the small one\'s text lines', async () => {
        gearC = null;
        await start();
        drive({ rpm: 1500, torque: 50, oil: 65, coolant: 75, speed: 40 }, 5);
        const big = widgetDraw({ spawnId: 1, big: true });
        assert(big && big.w > 0 && big.d.some((x) => x > 0), 'the big widget draws a picture');
        if (process.env.WIDGET_PNG) require('fs').writeFileSync(process.env.WIDGET_PNG, big.png());
        assert.strictEqual(cells.Title, '', 'big: the layout\'s title left empty');
        widgetDraw({ spawnId: 2, big: false });
        assert.strictEqual(cells.Title, 'Warm-Up');
        assert(/^WARMING UP  oil 65°C$/.test(cells.TextRecordings), 'small: state and oil: ' + cells.TextRecordings);
        assert(/^ready in ~\d+ min$/.test(cells.TextCam), 'small: ready in: ' + cells.TextCam);
        assert(cells.ProgressbarVisible === true && cells.Progress > 0 && cells.Progress < 1, 'small: the bar part way: ' + cells.Progress);
        assert.strictEqual(cells.TimeElapsed, 'Coolant 75°C');
    }],
    ['gearbox.js: the unit\'s 6000, else DA12 or the signal once they moved', async () => {
        const { Gearbox, Moving } = require(path.join(__dirname, '..', '..', 'apps', 'warmup', 'gearbox'));
        const m = new Moving(false);
        m.put(20, wall); m.put(20, wall); assert.strictEqual(m.get(wall), null, 'a value that never moved counts as none');
        m.put(-60, wall); assert.strictEqual(m.get(wall), null, 'out of range is ignored');
        m.put(22, wall); assert.strictEqual(m.get(wall), 22, 'once it moved it counts');
        assert.strictEqual(m.get(wall + 30000), null, 'an old value counts as none');
        const quiet = { info() {}, warn() {} };
        // the gearbox unit: 22 6000 answered (deg C + 40)
        let asked = [];
        const g = new Gearbox({}, quiet, () => true);
        g.link = { read: async (a, did) => { asked.push([a, did]); return did === 0x6000 ? [0x62, 0x60, 0x00, 40 + 72] : [0x7F, 0x22, 0x31]; } };
        await g._poll(); g.stop();
        assert.deepStrictEqual(asked, [[0x18, 0x6000]], 'asks the gearbox unit for 6000');
        assert.strictEqual(g.temp(), 72); assert.strictEqual(g.source(), 'EGS');
        // no 6000: DA12, counted once it moved; the signal meanwhile
        asked = [];
        const h = new Gearbox({}, quiet, () => true);
        let raw = 48 + 50;
        h.link = { read: async (a, did) => { asked.push(did); return did === 0xDA12 ? [0x62, 0xDA, 0x12, raw] : [0x7F, 0x22, 0x31]; } };
        await h._poll(); await h._poll();
        assert.deepStrictEqual(asked, [0x6000, 0xDA12], '6000 refused as missing: DA12 next');
        assert.strictEqual(h.temp(), null, 'DA12 not moved yet');
        h.sig.put(40, wall); h.sig.put(42, wall);
        assert.strictEqual(h.temp(), 42); assert.strictEqual(h.source(), 'signal');
        raw += 3; await h._poll(); h.stop();
        await h._poll();
        assert.strictEqual(h.timer, null, 'stopped: no more polls');
        assert.strictEqual(h.temp(), 53, 'DA12 moved: the unit before the signal');
    }],
];

(async () => {
    const failed = [];
    for (const [name, fn] of checks) {
        try { await fn(); } catch (e) { failed.push(name); console.error('FAIL ' + name + ': ' + e.message); }
    }
    if (failed.length) process.exit(1);
    console.log('Warm-Up checks passed (cool-down countdown and "cooled" across wall-clock jumps back and ahead; gearbox oil).');
})().catch((e) => { console.error(e); process.exit(1); });
