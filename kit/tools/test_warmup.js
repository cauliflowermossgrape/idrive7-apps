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
const stubs = { './kit/mgu': { run(a) { app = a; } }, './kit/car': FakeCar };
const load = Module._load;
Module._load = function (req, parent, isMain) {
    if (stubs[req]) return stubs[req];
    if (req.startsWith('./kit/')) return load.call(this, path.join(KIT, req.slice(6)), parent, isMain);
    return load.call(this, req, parent, isMain);
};

/** A fresh Warm-Up (a new process); render() draws a frame and returns its texts in order. */
let render = null;
async function start() {
    delete require.cache[MAIN];
    require(MAIN);
    const S = {};
    SPEC.settings.forEach((s) => { S[s.key] = s.default; });
    let texts = [], frame = null;
    await app.start({
        ui: { image: async () => {} }, settings: { get: (k) => S[k], onChange() {} }, log: { info() {}, warn() {} },
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
];

(async () => {
    const failed = [];
    for (const [name, fn] of checks) {
        try { await fn(); } catch (e) { failed.push(name); console.error('FAIL ' + name + ': ' + e.message); }
    }
    if (failed.length) process.exit(1);
    console.log('Warm-Up checks passed (cool-down countdown and "cooled" across wall-clock jumps back and ahead).');
})().catch((e) => { console.error(e); process.exit(1); });
