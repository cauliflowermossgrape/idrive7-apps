'use strict';

// Redline's HUD running against a stand-in cluster-render:
//   node kit/tools/test_redline_running.js
// - the HUD is one image layer (a picture) on every layout, never a shader (the cluster runs the HUD's
//   shaders, and a heavy one restarted it on the car: README "HUD drawing");
// - the Sport / Comfort profiles switch the running HUD with the driving mode, Don't show drops its layer;
// - the HUD slot's report is asked for, and BMW's content waiting there doesn't move Redline;
// - the knock warning and the launch time where the grade shows.

const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-running-'));
const SHM = process.env.MGU_HUD_CLAIMS = path.join(TMP, 'shm');
const ROOT = path.join(__dirname, '..', '..');

// a stand-in cluster-render: ready at once; records layers and pixels
let cr = null;
class FakeCr {
    constructor() { cr = this; this.ready = true; this.backend = 'test'; this.targets = 'hud'; this.n = 0; this.layers = {}; this.frames = []; this.h = {}; this.effects = 0; }
    on(ev, fn) { this.h[ev] = fn; }
    connect() {} close() {} removeAllListeners() {} set() {}
    _add(kind, o) { this.n++; this.layers[this.n] = Object.assign({ kind: kind }, o); return this.n; }
    image(o) { return this._add('image', o); }
    effect(o) { this.effects++; return this._add('effect', o); }
    uniform() {}
    pixels(ref, rects, px) { this.frames.push({ ref: ref, rects: rects, px: Buffer.from(px) }); return true; }
    drop(r) { delete this.layers[r]; }
    status() { this.asked = (this.asked || 0) + 1; }
    of(kind) { return Object.keys(this.layers).map(Number).filter((r) => this.layers[r].kind === kind); }
}
const load = Module._load;
Module._load = function (req, parent, isMain) {
    if (req.startsWith('./kit/')) return load.call(this, path.join(ROOT, 'kit', 'runtime', req.slice(6)), parent, isMain);
    if (req === './cluster_render_client') return { ClusterRender: FakeCr };
    return load.call(this, req, parent, isMain);
};
const Hud = require(path.join(ROOT, 'apps', 'redline', 'hud'));
const spec = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps', 'redline', 'app.json'), 'utf8'));
const def = {};
spec.settings.forEach((s) => { if (s.key) def[s.key] = s.default; });

let fails = 0, checks = 0;
const ok = (c, msg) => { checks++; if (!c) { fails++; console.log('FAIL ' + msg); } };
const log = { info() {}, warn() {}, error() {} };
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

(async () => {
    // a claim from this boot, so the HUD stays on at start
    fs.mkdirSync(SHM);
    fs.writeFileSync(path.join(SHM, 'redline'), JSON.stringify({ held: false, at: Date.now() }) + '\n');
    // an old setting from 1.16.0-1.16.6 asking for the GPU: ignored
    // (In Comfort / Eco Pro: Same as Sport, the OG default; this fork's own is Don't show, checked in test_redline_hud.js)
    const v = Object.assign({}, def, { hud: 'on', hudStyle: 'arc', hudRenderer: 'gpu', hudFps: 30, hudComfortMode: 'same' }), fns = [];
    const settings = { get: (k) => v[k], set: (k, x) => { v[k] = x; fns.forEach((f) => f(k, x)); }, onChange: (f) => fns.push(f) };
    let rpm = 3000, drive = 'sport';
    const src = { data: () => ({ rpm: rpm, gear: 3, stage: 'D', speed: 80, oil: 95, coolant: 92 }), shiftPoint: () => ({ rpm: 6200, cold: false }), redline: () => 6550,
        maxRpm: () => 8000, driveMode: () => drive,
        // a stand-in knock reader: started / stopped by the HUD, its last event's time set by the test
        knock: { on: false, at: 0, start() { this.on = true; }, stop() { this.on = false; }, value() { return { retard: null, at: this.at }; } },
        // a stand-in launch score: a run that finished `at`
        launch: (now, mph) => (launchRun && now - launchRun.at < 3000 ? Object.assign({ label: mph ? '0-60' : '0-100' }, launchRun) : null) };
    let launchRun = null;
    const h = Hud.start({ settings: settings, log: log, dataDir: TMP }, src);
    await sleep(250);

    // every layout: one image layer, no shader
    const img = cr.of('image');
    ok(img.length === 1 && cr.of('effect').length === 0, 'Arc (an old GPU setting set): one image layer, no shader');
    const I = cr.layers[img[0]] || {};
    ok(I.target === 'hud' && I.klass === 'overlay' && I.z === 0, 'the image: on the HUD, overlay');
    for (const st of ['standard', 'minimal', 'wings', 'digital', 'vfd', 'vector', 'ramp', 'dial', 'arc']) {
        settings.set('hudStyle', st); rpm = 6400; await sleep(120);
        ok(cr.of('image').length === 1 && cr.of('effect').length === 0, st + ': the picture, no shader');
    }
    // the revs move the picture
    const before = cr.frames.length;
    for (let r = 4000; r <= 6000; r += 400) { rpm = r; await sleep(60); }
    ok(cr.frames.length > before, 'moving revs redraw the picture (' + (cr.frames.length - before) + ' frames)');

    // the Sport / Comfort profiles in the running HUD: Comfort follows Sport, then its own, then Don't show
    // (the layer dropped while in Comfort)
    ok(h.frame().opts.style === 'arc', 'Sport: the Arc');
    drive = 'comfort'; await sleep(200);
    ok(h.frame().opts.style === 'arc' && cr.of('image').length === 1, 'Comfort, same as Sport: the Arc too');
    Hud.profileView(settings, 'comfort').set('hudStyle', 'standard'); await sleep(200);
    ok(h.frame().opts.style === 'standard' && cr.of('image').length === 1, 'Comfort, its own: Standard');
    drive = 'sport'; await sleep(200);
    ok(h.frame().opts.style === 'arc' && cr.of('image').length === 1, 'back in Sport: the Arc');
    Hud.setComfortMode(settings, 'hide'); drive = 'comfort'; await sleep(200);
    ok(cr.of('image').length === 0, "Comfort, Don't show: Redline's layer gone");
    drive = 'sport'; Hud.setComfortMode(settings, 'same'); await sleep(250);
    ok(cr.of('image').length === 1, 'back in Sport: shown again');
    ok(cr.effects === 0, 'no shader made in the whole run (' + cr.effects + ')');

    // the HUD slot's report is asked for while the tach is on, and BMW's content waiting there doesn't move Redline
    const slot = (rows) => cr.h.status('targets: hud\nslot 0x323 status 2: ' + rows);
    await sleep(2700);
    ok(cr.asked > 0, 'the HUD slot report is asked for while the tach is on');
    slot('0x1000400 class 0 map 1, 0x1000250 class 0 map 3'); await sleep(200);
    ok(cr.of('image').length === 1, "BMW's content waiting in the slot: Redline stays");

    // the knock warning: the reader runs while the HUD shows (warning on by default); an event shows KNOCK
    // where the grade goes, for 1.5 s; switched off, the reader stops and nothing shows
    ok(src.knock.on, 'knock: the engine unit is read while the HUD shows');
    src.knock.at = Date.now();
    const kf = h.frame();
    ok(kf.chip && kf.chip.verdict === 'KNOCK', 'knock: KNOCK shows after an event (' + JSON.stringify(kf.chip) + ')');
    src.knock.at = Date.now() - 2000;
    ok(!h.frame().chip, 'knock: gone 1.5 s after the last event');
    settings.set('hudKnockWarn', false); src.knock.at = Date.now(); await sleep(150);
    ok(!h.frame().chip && !src.knock.on, 'knock warning off: no KNOCK, the reader stopped');
    settings.set('hudShowKnock', true); await sleep(150);
    ok(src.knock.on, 'knock readout on: the reader runs again');
    rpm = 0; await sleep(150);
    ok(!src.knock.on, 'engine off: the reader stops');

    // the launch time where the grade shows: the time and its difference, green for a best; knock goes first
    settings.set('hudKnockWarn', true); src.knock.at = 0; await sleep(100);
    launchRun = { secs: 4.92, delta: -0.08, best: true, at: Date.now() };
    const lf = h.frame();
    ok(lf.chip && lf.chip.verdict === 'LAUNCH' && lf.chip.text === '4.92  -0.08' && lf.chip.tone === 'low', 'launch: 4.92  -0.08 in green (' + JSON.stringify(lf.chip) + ')');
    launchRun = { secs: 5.31, delta: 0.31, best: false, at: Date.now() };
    ok(h.frame().chip.tone === 'high' && h.frame().chip.text === '5.31  +0.31', 'launch: slower in red');
    rpm = 3000; await sleep(150); src.knock.at = Date.now();
    ok(h.frame().chip.verdict === 'KNOCK', 'knock goes before the launch time');
    src.knock.at = 0;
    settings.set('hudLaunch', false);
    ok(!h.frame().chip, 'launch time off: nothing');

    h.stop();
    fs.rmdirSync && (function rm(p) { if (fs.statSync(p).isDirectory()) { fs.readdirSync(p).forEach((n) => rm(path.join(p, n))); fs.rmdirSync(p); } else fs.unlinkSync(p); })(TMP);
    console.log('redline running: ' + checks + ' checks, ' + fails + ' failed');
    process.exit(fails ? 1 : 0);
})().catch((e) => { console.log('FAIL ' + (e && e.stack || e)); process.exit(1); });
