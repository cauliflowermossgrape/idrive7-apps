'use strict';
// Exterior Lights: nothing is sent before the safety note is accepted, then only reads; nothing is written while the
// car moves; a door opening or a low 12 V battery stops a running show / stealth and the lamps are given back (the used
// functions at 0, the channels as they were, the session left); the demo sends nothing. Against a stubbed head unit
// and a stubbed diagnostic transport that records every request; no SDK or car needed:
//   node kit/tools/test_exterior_lights.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const EventEmitter = require('events');
const ROOT = path.resolve(__dirname, '..', '..'), KIT = path.join(ROOT, 'kit', 'runtime');
const APP = path.join(ROOT, 'apps', 'exterior_lights');
const { Recorder } = require(path.join(KIT, 'record'));
const themes = require(path.join(KIT, 'themes'));

let checks = 0, fails = 0;
const ok = (c, m) => { checks++; if (!c) { fails++; console.log('FAIL ' + m); } else console.log('ok   ' + m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = (b) => b.map((x) => (x < 16 ? '0' : '') + x.toString(16).toUpperCase()).join(' ');

/* The transport: the body controller has its light functions (22 D542), the headlight units are FLM01 (22 D667). */
let sent = [];
class FakeDiag extends EventEmitter {
    constructor() { super(); this.available = true; }
    async init() { return this; }
    async physical(target, sid, data) {
        sent.push([target, sid].concat(data));
        if (sid === 0x10) return [0x50, data[0]];
        if (sid === 0x3E) return [0x7E, 0x00];
        if (sid === 0x2E) return [0x6E, data[0], data[1]];
        if (sid === 0x31) return [0x71].concat(data.slice(0, 3));
        if (sid === 0x22 && target === 0x40 && data[0] === 0xD5 && data[1] === 0x42) return [0x62, 0xD5, 0x42, 0, 0, 0, 0, 0, 0];
        if (sid === 0x22 && (target === 0x43 || target === 0x44) && data[0] === 0xD6 && data[1] === 0x67) {
            const r = [0x62, 0xD6, 0x67];
            for (let i = 0; i < 12; i++) r.push(i < 3 ? 50 : 0, i < 3 ? 80 : 0);
            return r;
        }
        return null;
    }
}
const writes = () => sent.filter((r) => [0x10, 0x2E, 0x31, 0x2F, 0x3E].indexOf(r[1]) >= 0);

let impl = null;
const load = Module._load;
Module._load = function (req, parent, isMain) {
    if (req === './kit/mgu') return { run: (i) => { impl = i; } };
    if (req === './kit/diag') return { Diag: FakeDiag };
    if (req.startsWith('./kit/')) return load.call(this, path.join(KIT, req.slice(6)), parent, isMain);
    return load.call(this, req, parent, isMain);
};

async function run(demo) {
    delete require.cache[path.join(APP, 'main.js')];
    require(path.join(APP, 'main.js'));
    const spec = JSON.parse(fs.readFileSync(path.join(APP, 'app.json'), 'utf8'));
    const S = {}; spec.settings.forEach((s) => { if (s.key) S[s.key] = s.default; }); S.demo = demo;
    const noop = () => {}, clicks = {}, h = {};
    let frame = null, texts = [], tab = null;
    await impl.start({
        log: { info: noop, warn: noop, error: noop }, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'xl-')), spec,
        settings: { get: (k) => S[k], set: (k, v) => { S[k] = v; }, onChange: noop },
        signals: { watch: async (iface, inst, hh) => { h[iface] = Object.assign(h[iface] || {}, hh); return { shutdown: async () => {} }; } },
        ui: { image: async () => {}, onClick: (b, fn) => { clicks[b] = fn; }, isVisible: () => true },
        theme: () => themes.theme('m_tricolour'), loop: (n, fps, fn) => { frame = fn; }, onTab: (fn) => { tab = fn; },
        canvas: (w, hh) => { const cv = new Recorder(w, hh), text = cv.text.bind(cv); texts = []; cv.text = (s, ...a) => { texts.push(String(s)); return text(s, ...a); }; return cv; },
    });
    await sleep(30);
    const speed = (k) => h['de.bmw.infotainment.vehicle.Vehicle2'].statusCarSpeed2({ speedVehicleCentreOfGravity: k / 0.015625 });
    const door = (open) => h['de.bmw.body.DoorsWindowsRoofMirrors'].CentralLockingSystemAndPanelStatus({ statusDoorSwitchDRD: open ? 1 : 0 });
    const battery = (p) => h['de.bmw.infotainment.vehicle.CDS'].statusBattery2({ conditionBatteryChargingCondition: p });
    return { S, clicks, h, speed, door, battery, tab, draw: async (p) => { if (p !== undefined) await tab(p); await frame(); return texts.join(' | '); } };
}

(async () => {
    sent = [];
    const a = await run('off');
    a.speed(0); a.battery(80);
    let t = await a.draw(0);
    ok(/For private ground/.test(t) && /Nothing runs while the car moves/.test(t), 'the safety note first');
    await sleep(100);
    ok(sent.length === 0, 'nothing sent before the note is accepted (' + sent.length + ')');
    await a.clicks.BTN_PLAY(); await a.clicks.BTN_STEALTH(); await sleep(200);
    ok(writes().length === 0, 'Play and Stealth before the note: nothing written');

    await a.clicks.BTN_ACCEPT();
    for (let i = 0; i < 50 && !/Found/.test(await a.draw(0)); i++) await sleep(50);
    t = await a.draw(0);
    ok(/Found/.test(t) && sent.length > 0 && sent.every((r) => r[1] === 0x22), 'after accepting: the lamps found by reading only (' + sent.length + ' reads)');
    ok(/All checks pass/.test(t), 'every check green when parked, doors closed, battery 80 %');

    // moving: Play writes nothing
    sent = [];
    a.speed(40);
    t = await a.draw(0);
    ok(/the car is moving|STOP/.test(t), 'moving: the speed card red');
    await a.clicks.BTN_PLAY(); await sleep(300);
    ok(writes().length === 0, 'Play while moving: nothing written');

    // parked: the show plays, a door opens, it stops and gives back
    a.speed(0); sent = [];
    await a.clicks.BTN_PLAY(); await sleep(700);
    const flashes = sent.filter((r) => r[1] === 0x2E && r[r.length - 1] > 0);
    ok(flashes.length > 0 && sent.some((r) => r[0] === 0x40 && r[1] === 0x10 && r[2] === 0x03), 'parked: the show flashes (' + flashes.length + ' flashes)');
    a.door(true); await sleep(700);
    const after = sent.slice(sent.findIndex((r) => r === flashes[flashes.length - 1]) + 1);
    ok(after.some((r) => r[1] === 0x2E && r[r.length - 1] === 0 && r[r.length - 2] === 0) && after.some((r) => r[1] === 0x10 && r[2] === 0x01),
        'a door opens: the used functions at 0 and the session left (' + after.map(hex).join(' / ') + ')');
    t = await a.draw(0);
    ok(/a door is open/.test(t), 'the note says why: ' + (t.match(/Show stopped[^|]*/) || [''])[0]);
    a.door(false);

    // stealth: low battery blocks it; then it runs and a low battery stops it with the channels back
    sent = []; a.battery(30);
    await a.clicks.BTN_STEALTH(); await sleep(300);
    ok(writes().length === 0, 'battery at 30 %: Stealth not started');
    a.battery(80); sent = [];
    await a.clicks.BTN_STEALTH(); await sleep(800);
    const dark = sent.filter((r) => r[1] === 0x31 && r[3] === 0x30 && r.slice(5).every((x) => x === 0));
    ok(dark.length === 2, 'Stealth: both headlights every channel at 0 (' + dark.length + ')');
    a.battery(30); await sleep(800);
    const back = sent.filter((r) => r[1] === 0x31 && r[3] === 0x30 && r[5] === 50);
    ok(back.length === 2 && sent.filter((r) => r[1] === 0x10 && r[2] === 0x01).length >= 2, 'battery low: the channels written back as they were, the session left');
    t = await a.draw(1);
    ok(/Stealth stopped: the 12 V battery is at 30 %/.test(t), 'Stealth page says why it stopped');

    // pages draw
    for (const p of [2, 3, 4]) { t = await a.draw(p); ok(t.length > 200, 'page ' + p + ' draws'); }
    ok(/Both rear fog lights/.test(await a.draw(3)) && /writes no coding/.test(await a.draw(3)), 'Coding page explains the coding options');

    // demo: everything drawn, nothing sent
    sent = [];
    const d = await run('on');
    d.speed(0); d.battery(80);
    await d.clicks.BTN_ACCEPT(); await d.clicks.BTN_PLAY(); await sleep(300); await d.clicks.BTN_STOP(); await d.clicks.BTN_STEALTH(); await sleep(300);
    t = await d.draw(1);
    ok(sent.length === 0 && /Demo/.test(t), 'demo: accepted, Play and Stealth pressed, nothing sent');
    console.log('exterior lights: ' + checks + ' checks, ' + fails + ' failed');
    process.exit(fails ? 1 : 0);
})().catch((e) => { console.log('FAIL ' + (e && e.stack || e)); process.exit(1); });
