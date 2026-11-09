'use strict';

// Redline's GPU-drawn Arc (setting "hudRenderer" GPU) against a stand-in cluster-render:
//   node kit/tools/test_redline_gpu.js
// - the Arc on GPU makes an effect layer (the shader) under the text's image layer; other layouts and
//   the Picture setting make the image layer alone;
// - uniforms go out once, then only when they change; the image then carries no lights or band;
// - switching the setting, the layout or the alpha re-makes the layers; a refused shader falls back to
//   the picture for the run.
// (Whether the shader draws the Arc as the canvas does is checked in a browser: see the README.)

const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-gpu-'));
const SHM = process.env.MGU_HUD_CLAIMS = path.join(TMP, 'shm');
const ROOT = path.join(__dirname, '..', '..');

// a stand-in cluster-render: ready at once; records layers, uniforms and pixels
let cr = null;
class FakeCr {
    constructor() { cr = this; this.ready = true; this.backend = 'test'; this.targets = 'hud'; this.n = 0; this.layers = {}; this.uniforms = []; this.frames = []; this.h = {}; }
    on(ev, fn) { this.h[ev] = fn; }
    connect() {} close() {} removeAllListeners() {} set() {}
    _add(kind, o) { this.n++; this.layers[this.n] = Object.assign({ kind: kind }, o); return this.n; }
    image(o) { return this._add('image', o); }
    effect(o) { return this._add('effect', o); }
    uniform(ref, name, v, o) { this.uniforms.push({ ref: ref, name: name, v: v.slice(), type: o && o.type }); }
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
    const v = Object.assign({}, def, { hud: 'on', hudStyle: 'arc', hudRenderer: 'gpu', hudFps: 30 }), fns = [];
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

    const eff = cr.of('effect'), img = cr.of('image');
    ok(eff.length === 1 && img.length === 1, 'Arc on GPU: one effect layer and one image layer (' + eff.length + ', ' + img.length + ')');
    const E = cr.layers[eff[0]] || {}, I = cr.layers[img[0]] || {};
    ok(E.target === 'hud' && E.klass === 'overlay' && E.z === 0 && E.time === true && /u_rpm/.test(E.fs) && /gl_FragColor/.test(E.fs), 'effect: on the HUD, under the text, the renderer\'s clock, the Arc shader');
    ok(I.z === 1 && I.x === E.x && I.y === E.y && I.w === E.w && I.h === E.h, 'the text image over it, same place and size');
    const names = cr.uniforms.filter((u) => u.ref === eff[0]).map((u) => u.name);
    ['u_premul', 'u_px', 'u_rpm', 'u_warn', 'u_red', 'u_tick', 'u_peak', 'u_lit', 'u_flash', 'u_dim', 'u_lights', 'u_bar', 'u_lc', 'u_flashCol'].forEach((n) => ok(names.indexOf(n) >= 0, 'uniform ' + n + ' sent'));
    const lc = cr.uniforms.find((u) => u.name === 'u_lc');
    ok(lc && lc.type === 'vec4' && lc.v.length === 32, 'u_lc: 8 colours as a vec4 array');
    ok(cr.uniforms.find((u) => u.name === 'u_premul').v[0] === 0, 'alpha straight by default');
    ok(cr.uniforms.filter((u) => u.name === 'u_lc').length === 1, 'unchanged uniforms are sent once');
    const rpmSends = () => cr.uniforms.filter((u) => u.name === 'u_rpm').length;
    const n0 = rpmSends();
    await sleep(150);
    ok(rpmSends() === n0, 'steady revs: u_rpm not sent again');
    rpm = 5200; await sleep(150);
    ok(rpmSends() === n0 + 1 && Math.abs(cr.uniforms.filter((u) => u.name === 'u_rpm').pop().v[0] - 0.65) < 0.001, 'new revs: u_rpm sent once, as a fraction');
    // the image carries the text only: no lights along the top rows (the picture path draws them there)
    const whole = cr.frames.filter((f) => f.ref === img[0] && !f.rects).pop();
    let top = 0;
    if (whole) for (let y = 0; y < 22; y++) for (let x = 40; x < 360; x++) if (whole.px[(y * 400 + x) * 4 + 3]) top++;
    ok(whole && top === 0, 'GPU: the image has no lights or band (' + top + ' px in the lights\' rows)');

    // with no readout showing the revs, moving revs send uniforms only: the text image isn't redrawn
    settings.set('hudShowRpm', false); await sleep(150);
    const framesBefore = cr.frames.length;
    for (let r = 5300; r <= 6000; r += 100) { rpm = r; await sleep(60); }
    ok(cr.frames.length === framesBefore, 'GPU: revs alone redraw no picture (' + (cr.frames.length - framesBefore) + ' frames)');
    settings.set('hudShowRpm', true); await sleep(150);

    // Picture: the effect goes, one image layer draws everything
    settings.set('hudRenderer', 'image'); await sleep(150);
    ok(cr.of('effect').length === 0 && cr.of('image').length === 1 && cr.layers[cr.of('image')[0]].z === 0, 'Picture: the image layer alone');
    // GPU again, then another layout: the GPU only draws the Arc
    settings.set('hudRenderer', 'gpu'); await sleep(150);
    ok(cr.of('effect').length === 1, 'GPU again: the effect layer back');
    settings.set('hudStyle', 'standard'); await sleep(150);
    ok(cr.of('effect').length === 0 && cr.of('image').length === 1, 'Standard with GPU set: the picture (GPU is the Arc only)');
    settings.set('hudStyle', 'arc'); await sleep(150);
    // the Sport / Comfort profiles in the running HUD: Comfort follows Sport, then its own (a mode switching the
    // GPU Arc off makes the layers again, and back), then BMW's (the layers dropped while in Comfort)
    ok(h.frame().opts.style === 'arc' && cr.of('effect').length === 1, 'Sport: the Arc, on the GPU');
    drive = 'comfort'; await sleep(200);
    ok(h.frame().opts.style === 'arc' && cr.of('effect').length === 1, 'Comfort, same as Sport: the Arc too');
    Hud.profileView(settings, 'comfort').set('hudStyle', 'standard'); await sleep(200);
    ok(h.frame().opts.style === 'standard' && cr.of('effect').length === 0 && cr.of('image').length === 1, 'Comfort, its own: Standard, the GPU layer gone');
    drive = 'sport'; await sleep(200);
    ok(h.frame().opts.style === 'arc' && cr.of('effect').length === 1, 'back in Sport: the Arc, the GPU layer made again');
    Hud.setComfortMode(settings, 'hide'); drive = 'comfort'; await sleep(200);
    ok(cr.of('image').length === 0 && cr.of('effect').length === 0, "Comfort, Don't show: Redline's layers gone");
    drive = 'sport'; Hud.setComfortMode(settings, 'same'); await sleep(250);
    ok(cr.of('effect').length === 1 && cr.of('image').length === 1, 'back in Sport: shown again');

    // BMW's content in the HUD slot (CarPlay directions): Redline steps aside, back after two reports without it
    const slot = (rows) => cr.h.status('targets: hud\nslot 0x323 status 2: ' + rows);
    settings.set('hudGiveWay', 'aside'); await sleep(2700);
    ok(cr.asked > 0, 'the HUD slot report is asked for while the tach is on');
    slot('0x1000400 class 0 map 1, 0x1000250 class 0 map 3'); await sleep(200);
    ok(cr.of('image').length === 0 && cr.of('effect').length === 0 && /stepped aside/.test(h.status()), "BMW's content waiting in the slot: Redline steps aside");
    slot('0x1000250 class 0 map 1'); await sleep(150);
    ok(cr.of('image').length === 0, 'still there: still aside');
    slot(''); await sleep(100); slot(''); await sleep(200);
    ok(cr.of('image').length === 1 && cr.of('effect').length === 1, 'two reports without it: back on');
    settings.set('hudGiveWay', 'keep'); slot('0x1000400 class 0 map 1, 0x1000250 class 0 map 3'); await sleep(200);
    ok(cr.of('image').length === 1, 'Keep Redline (the default): stays on');
    settings.set('hudGiveWay', 'keep'); await sleep(100);

    // the alpha setting re-makes it with the new output
    settings.set('hudGpuAlpha', 'premul'); await sleep(150);
    const e2 = cr.of('effect')[0];
    ok(e2 && cr.uniforms.filter((u) => u.ref === e2 && u.name === 'u_premul').pop().v[0] === 1, 'premultiplied: the layer made again with u_premul 1');
    // the renderer refuses the shader: the picture for the rest of the run
    cr.h.layer(e2, 'error', 'shader compile failed'); await sleep(150);
    ok(cr.of('effect').length === 0 && cr.of('image').length === 1, 'a refused shader: back to the picture');
    settings.set('hudStyle', 'arc'); await sleep(150);
    ok(cr.of('effect').length === 0, 'and it stays the picture for this run');

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
    let lf = h.frame();
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
    console.log('redline gpu: ' + checks + ' checks, ' + fails + ' failed');
    process.exit(fails ? 1 : 0);
})().catch((e) => { console.log('FAIL ' + (e && e.stack || e)); process.exit(1); });
