'use strict';

// M Drive (apps/m_drive) staged as build.py --preview-only lays it out and run on the stubbed head unit
// (hu-stub.js) against a fake car: its signals, and a DME and gearbox unit behind the head unit's TASU transport.
// No SDK, renderer or car needed:
//   node kit/tools/test_m_drive.js            (M_DRIVE_OUT=dir keeps the frames drawn)

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { headUnit } = require('./hu-stub');

const ROOT = path.resolve(__dirname, '..', '..');
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'm-drive-')));
const STAGE = path.join(TMP, 'm_drive');
const JS = path.join(STAGE, 'source', 'javascript');
const OUT = process.env.M_DRIVE_OUT ? path.resolve(process.env.M_DRIVE_OUT) : path.join(TMP, 'frames');
const VIN = 'WBA00MDRIVETEST01';
const DEMO = { rpm: 840, oil: 102, coolant: 90, gearbox: 75, iat: 28, boost: 0, demo: true };
function removeTree(dir) {
    fs.readdirSync(dir).forEach((name) => {
        const file = path.join(dir, name);
        if (fs.lstatSync(file).isDirectory()) removeTree(file);
        else fs.unlinkSync(file);
    });
    fs.rmdirSync(dir);
}
function makeDir(dir) {
    if (fs.existsSync(dir)) return;
    makeDir(path.dirname(dir));
    fs.mkdirSync(dir);
}
process.on('exit', () => removeTree(TMP));

// AutoFlap holds Open / Close by sending it again every 15 s: 80 ms here
const realTimeout = global.setTimeout;
global.setTimeout = function (fn, ms) {
    const args = Array.prototype.slice.call(arguments);
    if (ms === 15000) args[1] = 80;
    return realTimeout.apply(this, args);
};

const sleep = (ms) => new Promise((r) => realTimeout(r, ms));
async function until(what, cond, ms) {
    const end = Date.now() + (ms || 4000);
    for (;;) {
        let ok = false;
        try { ok = cond(); } catch (e) { ok = false; }
        if (ok) return;
        if (Date.now() > end) throw new Error('timed out: ' + what);
        await sleep(20);
    }
}
const hex = (a) => a.map((b) => b.toString(16).padStart(2, '0')).join(' ');
const results = [];
let current = null;
async function t(name, fn) {
    try { await fn(); results.push('PASS  ' + name); } catch (e) {
        results.push('FAIL  ' + name + ' :: ' + (e && e.stack || e) + (current ? '\n      app log:\n        ' + current.logs.slice(-25).join('\n        ') : ''));
    }
}

const built = spawnSync('python3', ['-c', 'import sys; sys.path.insert(0, sys.argv[1]); import build; build.DIST = sys.argv[2]; build.build("m_drive", preview_only=True)',
    path.join(ROOT, 'kit', 'tools'), TMP], { encoding: 'utf8' });
if (built.status !== 0) { console.error(built.stdout + built.stderr); process.exit(1); }

function sharedSources(list) {
    const r = spawnSync('python3', ['-c', 'import sys, json; sys.path.insert(0, sys.argv[1]); import build; '
        + 'print(json.dumps(sorted(build.shared_sources({"id": "m_drive", "sharedSources": json.loads(sys.argv[2])}, sys.argv[3]))))',
    path.join(ROOT, 'kit', 'tools'), JSON.stringify(list), path.join(ROOT, 'apps', 'm_drive')], { encoding: 'utf8' });
    return r.status === 0 ? JSON.parse(r.stdout) : (r.stderr + r.stdout).trim().split('\n').pop();
}

const READ = { 0x22: 1, 0x01: 1, 0x06: 1, 0x19: 1 };

function answer(o, ecu, sid, data) {
    const did = (data[0] << 8) | data[1];
    if (ecu === 0x18) return sid === 0x22 && did === 0x6000 && o.egs !== null ? [0x62, 0x60, 0x00, o.egs] : [0x7F, sid, 0x31];
    if (ecu !== 0x12) return [0x7F, sid, 0x11];
    if (sid === 0x22) {
        if (did === 0xF190) return [0x62, 0xF1, 0x90].concat(Array.from(Buffer.from(VIN)));
        if (did === 0xF150) return [0x62, 0xF1, 0x50, 0x00, 0x0F, 0x25];
        if ((did === 0x62FD || did === 0x64FD) && o.flap) return [0x62, data[0], data[1], 0x00, 0x00];
        if (did === 0xF40F && o.iat !== null) return [0x62, 0xF4, 0x0F, o.iat];
        if (did === 0xF433 && o.baro !== null) return [0x62, 0xF4, 0x33, o.baro];
        if (did === 0xF470 && o.abs !== null) { const raw = Math.round(o.abs * 32); return [0x62, 0xF4, 0x70, 0x1F, 0, 0, raw >> 8, raw & 255]; }
        return [0x7F, 0x22, 0x31];
    }
    if (sid === 0x2F && data[0] === 0x60 && data[1] === 0xFD) return o.flap ? [0x6F].concat(data) : [0x7F, 0x2F, 0x31];
    if (sid === 0x2F && (data[0] === 0x01 || data[0] === 0x03)) return o.mhd === 'echo' ? [0x6F].concat(data) : o.mhd === 'refuse' ? [0x7F, 0x2F, 0x31] : null;
    return [0x7F, sid, 0x11];
}

function fakeCar(opts) {
    const o = Object.assign({ mhd: 'echo', flap: true, egs: 0x73, iat: 0x44, baro: 100, abs: 220, delay: 4 }, opts);
    const car = { o, sent: [], subs: {}, avail: [], link: true, inflight: 0, overlap: 0, rpm: null, temps: true, frames: null };
    car.signals = {
        async watch(iface, inst, handlers) {
            car.subs[iface] = handlers;
            return { iface, available: true, error: null, proxy: null, shutdown: () => Promise.resolve() };
        },
        async proxy() { return {}; },
        async on(p, name, fn) { car.frames = fn; },
        async onAvailable(p, fn) { car.avail.push(fn); fn(car.link); },
        async call(p, method, req) {
            const sid = req.serviceID, data = Array.from(req.udsData), ecu = req.targetAddress;
            car.sent.push(hex([ecu, sid].concat(data)));
            if (car.inflight) car.overlap++;
            const r = answer(car.o, ecu, sid, data);
            if (r) {
                car.inflight++;
                realTimeout(() => {
                    car.inflight--;
                    car.frames({ udsResponse: Buffer.from([0, 0, 0, 0, 0, 0, ecu, 0, 0].concat(r)) });
                }, car.o.delay);
            }
            return 'NO_ERROR';
        },
        set: () => Promise.resolve(), hasNative: () => true, loadConfig: () => ({}),
    };
    car.feed = (iface, field, v) => { const h = car.subs[iface]; if (h && h[field]) h[field](v); };
    car.setLink = (on) => { car.link = on; car.avail.forEach((fn) => fn(on)); };
    car.timer = setInterval(() => {
        if (car.rpm !== null) car.feed('de.bmw.infotainment.vehicle.CDS', 'statusEngineSpeed2', { actualValueRPMEngineCrankshaft: car.rpm * 4 });
        if (car.temps) car.feed('de.bmw.infotainment.vehicle.CDS', 'statusEngineTemperature', { temperatureEngineDrive: 90 + 48, temperatureEngineOilDrive: 102 + 48 });
    }, 100);
    car.writes = () => car.sent.filter((s) => !READ[parseInt(s.split(' ')[1], 16)]);
    return car;
}

let boots = 0;
async function boot(o) {
    o = o || {};
    Object.keys(require.cache).forEach((k) => { if (k.indexOf(STAGE) === 0) delete require.cache[k]; });
    if (o.gpu) { process.env.MGU_RENDERD_FILE = path.join(TMP, 'gpu-' + boots + '.bin'); delete process.env.MGU_RENDERER; } else {
        delete process.env.MGU_RENDERD_FILE;
        process.env.MGU_RENDERER = 'software';
    }
    const car = fakeCar(o.car);
    car.rpm = o.rpm === undefined ? 900 : o.rpm;
    const dataDir = path.join(TMP, 'data-' + (boots++));
    fs.mkdirSync(dataDir);
    const logs = [], frames = [], views = [];
    const line = (lvl) => function () { logs.push(lvl + ' ' + Array.prototype.map.call(arguments, (x) => (x && x.stack) || String(x)).join(' ')); };
    const log = { info: line('I'), warn: line('W'), error: line('E'), debug() {} };
    const hu = headUnit(STAGE, {
        live: true, dataDir, log, sets: Object.assign({ demo: 'auto', controls: 'off' }, o.sets),
        image: (name, cv) => { frames.splice(0, frames.length, cv); return Promise.resolve(); },
    });
    hu.ctx.signals = car.signals;
    const UI = require(path.join(JS, 'ui.js'));
    const draw = UI.draw;
    UI.draw = function (cv, G, th, v, act) { views.push({ v, act, own: !!cv.own, targets: cv.targets }); return draw.apply(this, arguments); };
    hu.start();
    await until('started and shown', () => logs.some((l) => /m_drive ready/.test(l)) && hu.ui.isVisible('MAIN') && views.length > 0);
    const app = current = {
        hu, car, logs, frames, views,
        view: () => views[views.length - 1].v,
        press: (btn) => hu.ui.comp(btn).emit('action', {}),
        settled: async (what, cond, ms) => { const n = views.length; await until(what, () => views.length > n && cond(app.view()), ms); },
        done: () => { clearInterval(car.timer); hu.ui.home(); },
    };
    return app;
}

const BUTTONS = ['BTN_MAP1', 'BTN_MAP2', 'BTN_MAP3', 'BTN_MAP4', 'BTN_FLAP_OEM', 'BTN_FLAP_OPEN', 'BTN_FLAP_CLOSED', 'BTN_COOL_ON', 'BTN_COOL_OFF'];
const OFF = 'Car controls are off · turn them on in Settings';
const selected = (v) => [v.commands.map.selected, v.commands.flap.selected, v.commands.cooling.selected];

async function packaging() {
    await t('build: the shared Engine Config modules staged byte for byte beside the app', async () => {
        const spec = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps', 'm_drive', 'app.json'), 'utf8'));
        assert.deepStrictEqual(spec.sharedSources.map((f) => path.basename(f)).sort(),
            ['adapters.js', 'auto.js', 'bm3_profiles.js', 'bm3_protocol.js', 'controller.js', 'diaglink.js', 'real_adapters.js', 'tune.js']);
        spec.sharedSources.forEach((f) => assert.ok(fs.readFileSync(path.join(JS, path.basename(f))).equals(fs.readFileSync(path.join(ROOT, f))), f));
        assert.ok(!fs.existsSync(path.join(STAGE, 'source', 'node_modules', 'oap-sdk', 'index.js')), 'a preview build carries no SDK');
    });
    await t('build: sharedSources outside the repository, not .js, or colliding with a staged name are refused', async () => {
        const outside = path.join(TMP, 'outside.js');
        fs.writeFileSync(outside, '');
        assert.deepStrictEqual(sharedSources(['apps/live_adjustments/tune.js']), ['tune.js']);
        assert.ok(/not a \.js file inside the repository/.test(sharedSources([path.relative(ROOT, outside)])));
        assert.ok(/not a \.js file inside the repository/.test(sharedSources([outside])));
        assert.ok(/not a \.js file inside the repository/.test(sharedSources(['apps/live_adjustments/app.json'])));
        assert.ok(/collides with the staged ui\.js/.test(sharedSources(['apps/live_adjustments/ui.js'])));
        assert.ok(/collides with the staged tune\.js/.test(sharedSources(['apps/live_adjustments/tune.js', 'apps/live_adjustments/tune.js'])));
    });
    await t('app.json: a bar button for each of the nine controls plus Settings; telemetry candidates as M Vitals has them', async () => {
        const spec = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps', 'm_drive', 'app.json'), 'utf8'));
        const M = require(path.join(JS, 'model.js'));
        assert.deepStrictEqual(spec.screens[0].buttons.map((b) => b[0]), M.ACTIONS.map((a) => a.button).concat('BTN_SETTINGS'));
        assert.deepStrictEqual(M.ACTIONS.map((a) => a.button), BUTTONS);
        const vitals = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps', 'car_vitals', 'app.json'), 'utf8')).config.dme;
        ['iat', 'boost', 'baro'].forEach((k) => assert.deepStrictEqual(spec.config.dme[k], vitals[k], k));
        assert.deepStrictEqual(spec.config.dme.egs, vitals.egs.filter((c) => c.did === '6000'));
        assert.strictEqual(spec.settings.find((s) => s.key === 'controls').default, 'off');
    });
}

async function guards() {
    await t('opened with Car controls off: telemetry read, the nine controls answer with a note, nothing sent', async () => {
        const app = await boot();
        try {
            app.car.feed('de.bmw.infrastructure.analytics.BasicDataSet', 'basicDataSet', { valueTemperatureTransmissionOil: 0 });
            await app.settled('live readings', (v) => v.mode === 'disarmed' && v.telemetry.iat === 28 && v.telemetry.gearbox === 75 && v.telemetry.boost !== null);
            const d = app.view().telemetry;
            assert.deepStrictEqual([d.rpm, d.oil, d.coolant, d.gearbox, d.iat, Math.round(d.boost * 100) / 100], [900, 102, 90, 75, 28, 1.2]);
            BUTTONS.forEach((b) => app.press(b));
            await app.settled('the off note', (v) => v.commands.status && v.commands.status.text === OFF);
            assert.deepStrictEqual(selected(app.view()), [null, null, null]);
            await sleep(300);
            assert.deepStrictEqual(app.car.writes(), []);
            const dids = new Set(app.car.sent.map((s) => s.split(' ').slice(0, 4).join(' ')));
            assert.deepStrictEqual([...dids].filter((s) => ['12 22 f4 0f', '18 22 60 00', '12 22 f4 33', '12 22 f4 70'].indexOf(s) < 0), [], 'only telemetry reads');
        } finally { app.done(); }
    });

    await t('demo with Car controls switched on during it: simulated selections, nothing sent, nothing carried into live', async () => {
        const app = await boot({ sets: { demo: 'on' } });
        try {
            await app.settled('demo', (v) => v.mode === 'demo');
            app.hu.settings.set('controls', 'on');
            app.press('BTN_MAP2'); app.press('BTN_FLAP_OPEN'); app.press('BTN_COOL_ON');
            await app.settled('simulated', (v) => v.commands.cooling.selected === 'ON');
            const v = app.view();
            assert.deepStrictEqual(selected(v), [2, 'OPEN', 'ON']);
            assert.deepStrictEqual([v.commands.map.lit, v.commands.flap.lit, v.commands.cooling.lit], ['demo', 'demo', 'demo']);
            assert.ok(/Simulated · nothing is sent/.test(v.commands.status.text));
            assert.deepStrictEqual(v.telemetry, DEMO);
            assert.deepStrictEqual(app.car.sent, [], 'demo sends nothing, not even reads');
            app.hu.settings.set('demo', 'auto');
            await app.settled('live', (x) => x.mode === 'live' && x.link);
            await sleep(400);
            assert.deepStrictEqual(selected(app.view()), [null, null, null]);
            assert.strictEqual(app.view().commands.status, null);
            assert.deepStrictEqual(app.car.writes(), []);
        } finally { app.done(); }
    });

    await t('MHD map: exact bytes, selected only on the DME\'s echo; a refusal and silence are shown, the selection kept', async () => {
        const app = await boot({ sets: { controls: 'on' } });
        try {
            await app.settled('live', (v) => v.mode === 'live' && v.link);
            assert.deepStrictEqual(selected(app.view()), [null, null, null], 'nothing known at start');
            app.press('BTN_MAP3');
            await app.settled('map 3', (v) => v.commands.map.selected === 3);
            assert.deepStrictEqual(app.car.writes(), ['12 2f 01 02']);
            assert.deepStrictEqual(app.view().commands.status, { group: 'map', text: 'Map 3 · accepted by the DME', tone: 'go' });
            app.car.o.mhd = 'refuse';
            app.press('BTN_MAP1');
            await app.settled('refused', (v) => v.commands.status.text === 'Not available on this car');
            assert.strictEqual(app.view().commands.map.selected, 3);
            assert.strictEqual(app.view().commands.status.tone, 'warn');
            app.car.o.mhd = 'silent';
            app.press('BTN_MAP4');
            await app.settled('no answer', (v) => v.commands.status.text === 'No answer from the DME', 5000);
            assert.strictEqual(app.view().commands.map.selected, 3);
            assert.deepStrictEqual(app.car.writes(), ['12 2f 01 02', '12 2f 01 00', '12 2f 01 03']);
            assert.ok(app.car.sent.indexOf('12 22 f1 90') >= 0, 'the DME identified');
            assert.ok(!app.logs.some((l) => l.indexOf(VIN) >= 0), 'the VIN is not logged');
            assert.strictEqual(app.car.overlap, 0, 'one request at a time');
        } finally { app.done(); }
    });

    await t('pressed while the DME is still identified: the flap waits for the real adapter, an accepted map stays', async () => {
        const app = await boot({ sets: { controls: 'on' }, car: { delay: 150 } });
        try {
            await app.settled('live', (v) => v.mode === 'live' && v.link);
            await sleep(200);
            app.press('BTN_MAP2');
            app.press('BTN_FLAP_OPEN');
            await app.settled('map 2', (v) => v.commands.map.selected === 2);
            await until('flap open', () => app.view().commands.flap.selected === 'OPEN', 6000);
            assert.ok(app.car.writes().indexOf('12 2f 60 fd 03 03 e8') >= 0, 'Open accepted only after it was sent');
            await sleep(300);
            assert.strictEqual(app.view().commands.map.selected, 2, 'the identification did not wipe the accepted map');
        } finally { app.done(); }
    });

    await t('Max Cooling: On only with a fresh live engine speed over 500 rpm (temperatures do not count), Off always', async () => {
        const app = await boot({ sets: { controls: 'on' }, rpm: 300 });
        try {
            await app.settled('live', (v) => v.mode === 'live' && v.link);
            app.press('BTN_COOL_ON');
            await app.settled('engine off', (v) => /Start the engine first/.test(v.commands.status.text));
            app.car.rpm = 900;
            await sleep(300);
            app.press('BTN_COOL_ON');
            await app.settled('on', (v) => v.commands.cooling.selected === 'ON');
            app.car.rpm = null;
            await sleep(3300);
            app.press('BTN_COOL_OFF');
            await app.settled('off', (v) => v.commands.cooling.selected === 'OFF');
            app.press('BTN_COOL_ON');
            await app.settled('stale rpm', (v) => /Start the engine first/.test(v.commands.status.text));
            await sleep(200);
            assert.deepStrictEqual(app.car.writes(), ['12 2f 03 01', '12 2f 03 00']);
            assert.strictEqual(app.view().commands.cooling.selected, 'OFF');
        } finally { app.done(); }
    });

    await t('exhaust flap: BMW 60FD bytes, held, Close handed back above 4,000 rpm and without a live engine speed', async () => {
        const app = await boot({ sets: { controls: 'on' } });
        try {
            await app.settled('live', (v) => v.mode === 'live' && v.link);
            app.press('BTN_FLAP_OPEN');
            await app.settled('open', (v) => v.commands.flap.selected === 'OPEN');
            await sleep(300);
            const opens = app.car.writes().filter((w) => w === '12 2f 60 fd 03 03 e8').length;
            assert.ok(opens >= 3, 'Open held: sent ' + opens + ' times');
            app.press('BTN_FLAP_CLOSED');
            await app.settled('closed', (v) => v.commands.flap.selected === 'CLOSED');
            app.car.rpm = 4500;
            await app.settled('paused', (v) => v.commands.flap.selected === 'OEM' && /Close paused above 4,000 rpm/.test(v.commands.status.text));
            app.car.rpm = 3000;
            await app.settled('resumed', (v) => v.commands.flap.selected === 'CLOSED');
            app.press('BTN_FLAP_OEM');
            await app.settled('oem', (v) => v.commands.flap.selected === 'OEM' && !v.commands.flap.busy);
            app.car.rpm = null;
            await sleep(3300);
            app.press('BTN_FLAP_CLOSED');
            await app.settled('no rpm', (v) => /RPM signal lost · OEM requested/.test(v.commands.status.text));
            const flap = app.car.writes().filter((w) => w.indexOf('12 2f 60 fd') === 0);
            const distinct = flap.filter((w, i) => w !== flap[i - 1]);
            assert.deepStrictEqual(distinct, ['12 2f 60 fd 03 03 e8', '12 2f 60 fd 03 23 28', '12 2f 60 fd 00', '12 2f 60 fd 03 23 28', '12 2f 60 fd 00']);
            assert.strictEqual(app.car.overlap, 0, 'one request at a time');
        } finally { app.done(); }
    });

    await t('link lost and back: map, cooling and flap shown unknown, nothing sent again (no hold, no resend)', async () => {
        const app = await boot({ sets: { controls: 'on' } });
        try {
            await app.settled('live', (v) => v.mode === 'live' && v.link);
            app.press('BTN_MAP2');
            await app.settled('map 2', (v) => v.commands.map.selected === 2);
            app.press('BTN_COOL_ON');
            await app.settled('cooling', (v) => v.commands.cooling.selected === 'ON');
            app.press('BTN_FLAP_OPEN');
            await app.settled('open', (v) => v.commands.flap.selected === 'OPEN');
            app.car.setLink(false);
            await app.settled('link down', (v) => !v.link);
            const n = app.car.writes().length;
            app.car.setLink(true);
            await app.settled('link back', (v) => v.link);
            await sleep(500);
            assert.deepStrictEqual(selected(app.view()), [null, null, null]);
            assert.strictEqual(app.car.writes().length, n, 'sent after the link came back: ' + app.car.writes().slice(n));
        } finally { app.done(); }
    });

    await t('a command waiting behind a read is not sent once the screen is left; the held flap stops', async () => {
        const app = await boot({ sets: { controls: 'on' }, car: { delay: 250 } });
        try {
            await app.settled('live', (v) => v.mode === 'live' && v.link);
            await until('a read in flight', () => app.car.inflight > 0);
            app.press('BTN_MAP2');
            await sleep(5);
            app.hu.ui.home();
            await sleep(1200);
            assert.deepStrictEqual(app.car.writes(), []);
            app.hu.ui.open('MAIN');
            app.car.o.delay = 4;
            await app.settled('shown', (v) => v.mode === 'live');
            app.press('BTN_FLAP_OPEN');
            await app.settled('open', (v) => v.commands.flap.selected === 'OPEN');
            app.hu.ui.home();
            await sleep(50);
            const n = app.car.writes().length;
            await sleep(400);
            assert.strictEqual(app.car.writes().length, n, 'held after the screen was left');
            assert.ok(app.logs.some((l) => /tune map 2: Not sent · M Drive/.test(l)), 'the map press logged why it was not sent');
        } finally { app.done(); }
    });
}

async function queued() {
    await t('the real native signal queue checks control permission at callMethod execution', async () => {
        const { Lane } = require(path.join(JS, 'lane.js'));
        const signals = require('../runtime/signals');
        let enabled = true, calls = 0;
        const lane = new Lane(() => enabled ? null : 'Car controls are off');
        const guarded = lane.signals(signals);
        const proxy = { callMethod() { calls++; return Promise.resolve('NO_ERROR'); } };
        const request = { serviceID: 0x2F, udsData: Buffer.from([0x01, 0x01]) };
        const pending = guarded.call(proxy, 'sendTasuRequest', request);
        enabled = false;
        let error = null;
        try { await pending; } catch (e) { error = e; }
        assert.ok(error && error.blocked);
        assert.strictEqual(calls, 0);
        enabled = true;
        assert.strictEqual(await guarded.call(proxy, 'sendTasuRequest', request), 'NO_ERROR');
        assert.strictEqual(calls, 1);
    });

    await t('a press revoked before the tune microtask runs cannot enter the reopened session', async () => {
        const app = await boot({ sets: { controls: 'on' } });
        try {
            await app.settled('live', (v) => v.mode === 'live' && v.link && !v.commands.map.busy);
            app.views[app.views.length - 1].act.map2();
            app.hu.ui.home();
            app.hu.ui.open('MAIN');
            await sleep(800);
            assert.deepStrictEqual(app.car.writes(), []);
            assert.deepStrictEqual(selected(app.view()), [null, null, null]);
        } finally { app.done(); }
    });

    await t('a late map or cooling echo belongs only to the session that sent it', async () => {
        for (const id of ['map2', 'coolingOn']) {
            const app = await boot({ sets: { controls: 'on' } });
            try {
                await app.settled('live', (v) => v.mode === 'live' && v.link && !v.commands.map.busy);
                app.car.o.delay = 500;
                app.views[app.views.length - 1].act[id]();
                await until('command sent', () => app.car.writes().length === 1);
                app.hu.ui.home();
                app.hu.ui.open('MAIN');
                await sleep(800);
                assert.strictEqual(app.car.writes().length, 1);
                assert.deepStrictEqual(selected(app.view()), [null, null, null]);
            } finally { app.done(); }
        }
    });

    await t('a telemetry poll stops sending when the screen hides or demo begins', async () => {
        for (const leave of [true, false]) {
            const app = await boot({ car: { delay: 250 } });
            try {
                await until('intake read sent', () => app.car.sent.indexOf('12 22 f4 0f') >= 0);
                const n = app.car.sent.length;
                if (leave) app.hu.ui.home();
                else app.hu.settings.set('demo', 'on');
                await sleep(1800);
                assert.deepStrictEqual(app.car.sent.slice(n), []);
            } finally { app.done(); }
        }
    });

    await t('a command queued before the screen was left is not sent after it is shown again', async () => {
        const app = await boot({ sets: { controls: 'on' }, car: { delay: 250 } });
        try {
            await app.settled('live', (v) => v.mode === 'live' && v.link);
            await until('a read in flight', () => app.car.inflight > 0);
            app.press('BTN_MAP2');
            await sleep(5);
            app.hu.ui.home();
            app.hu.ui.open('MAIN');
            await sleep(1200);
            assert.deepStrictEqual(app.car.writes(), []);
        } finally { app.done(); }
    });

    await t('Max Cooling On queued while the engine stops is not sent', async () => {
        const app = await boot({ sets: { controls: 'on' }, car: { delay: 250 } });
        try {
            await app.settled('live', (v) => v.mode === 'live' && v.link);
            await until('a read in flight', () => app.car.inflight > 0);
            app.press('BTN_COOL_ON');
            await sleep(5);
            app.car.rpm = 300;
            app.car.feed('de.bmw.infotainment.vehicle.CDS', 'statusEngineSpeed2', { actualValueRPMEngineCrankshaft: 1200 });
            await app.settled('refused', (v) => /Start the engine first/.test(v.commands.status.text), 3000);
            assert.deepStrictEqual(app.car.writes(), []);
            assert.strictEqual(app.view().commands.cooling.selected, null);
        } finally { app.done(); }
    });
}

async function screen() {
    await t('owned busy controls keep their rotary stops and OEM can queue a hand-back', async () => {
        const app = await boot({ gpu: true, sets: { controls: 'on' } });
        try {
            await app.settled('live', (v) => v.mode === 'live' && v.link && !v.commands.map.busy);
            app.car.o.delay = 500;
            app.views[app.views.length - 1].act.flapOpen();
            await until('open sent', () => app.car.writes().indexOf('12 2f 60 fd 03 03 e8') >= 0);
            await app.settled('flap busy', (v) => v.commands.flap.busy);
            const targets = app.views[app.views.length - 1].targets;
            assert.strictEqual(targets.length, 9);
            assert.strictEqual(app.hu.display._ring().filter((p) => p.k.indexOf('tgt:') === 0).length, 9);
            app.car.o.delay = 4;
            targets.find((q) => q.key === 'm_drive_flapOem').run();
            await app.settled('OEM accepted', (v) => v.commands.flap.selected === 'OEM');
            const writes = app.car.writes().filter((w) => w.indexOf('12 2f 60 fd') === 0);
            assert.deepStrictEqual(writes, ['12 2f 60 fd 03 03 e8', '12 2f 60 fd 00']);
            assert.strictEqual(app.car.overlap, 0);
        } finally { app.done(); }
    });

    await t('owned screen: the nine controls are page buttons the knob and a tap reach, Settings a tab; the bar keeps none', async () => {
        const app = await boot({ gpu: true, sets: { demo: 'on' } });
        try {
            await until('owned frame', () => app.views.some((x) => x.own && x.targets.length === 9));
            const d = app.hu.display;
            assert.deepStrictEqual(d.buttons(), [], 'no bar buttons where the kit runs the screen');
            assert.ok(d._tabList().tabs.indexOf('Settings') >= 0);
            const keys = d._ring().map((p) => p.k);
            assert.deepStrictEqual(keys.filter((k) => k.indexOf('tgt:') === 0), ['map1', 'map2', 'map3', 'map4', 'flapOem', 'flapOpen', 'flapClosed', 'coolingOn', 'coolingOff']
                .map((id) => 'tgt:m_drive_' + id));
            const knob = { k: 100 };
            const ccu = (turn, press) => { knob.k += turn; d._ccu({ frontRotaryEncoderOperation: knob.k, frontRotaryEncoderPushButton: press ? 1 : 0, frontRotaryEncoderDeflection: 0 }); };
            ccu(0, false);
            const seen = [];
            for (let i = 0; i < keys.length; i++) {
                ccu(1, false);
                if (d.focusKey.indexOf('tgt:') !== 0) continue;
                ccu(0, true); ccu(0, false);
                await app.settled('pressed ' + d.focusKey, () => true);
                const v = app.view();
                seen.push(selected(v).map(String).join('/'));
            }
            assert.deepStrictEqual(seen, ['1/null/null', '2/null/null', '3/null/null', '4/null/null', '4/OEM/null', '4/OPEN/null', '4/CLOSED/null', '4/CLOSED/ON', '4/CLOSED/OFF']);
            const t1 = app.views[app.views.length - 1].targets.find((q) => q.key === 'm_drive_map2');
            d._touch(1, t1.x + t1.w / 2, t1.y + t1.h / 2); d._touch(3, t1.x + t1.w / 2, t1.y + t1.h / 2);
            await app.settled('tapped', (v) => v.commands.map.selected === 2);
            d._openTab(d._tabList().settings);
            await until('Settings opens from its tab', () => d.sheet && d.sheet.settings);
            d.closeSheet();
            assert.deepStrictEqual(app.car.sent, []);
        } finally { app.done(); }
    });

    await t('software path: every control is an HMI bar button; frames drawn in software and recorded for the renderer', async () => {
        const app = await boot({ sets: { demo: 'on' } });
        try {
            await app.settled('demo', (v) => v.mode === 'demo');
            assert.deepStrictEqual(app.hu.display.buttons().map((b) => b.id), BUTTONS.concat('BTN_SETTINGS'));
            BUTTONS.forEach((b) => app.press(b));
            await app.settled('last press', (v) => v.commands.cooling.selected === 'OFF');
            assert.deepStrictEqual(selected(app.view()), [4, 'CLOSED', 'OFF']);
            await app.settled('frame', () => app.frames.length > 0);
            const soft = app.frames[app.frames.length - 1];
            const px = (c, x, y) => Array.from(c.d.slice((y * c.w + x) * 4, (y * c.w + x) * 4 + 4));
            assert.strictEqual(soft.w, 1600);
            assert.notDeepStrictEqual(px(soft, 198, 175), px(soft, 10, 515), 'the oil dial is drawn');
            makeDir(OUT);
            fs.writeFileSync(path.join(OUT, 'm_drive_software.png'), soft.png());
            const { Recorder, play } = require(path.join(JS, 'kit', 'record.js'));
            const { Canvas } = require(path.join(JS, 'kit', 'canvas.js'));
            const G = require(path.join(JS, 'kit', 'gauges.js'));
            const UI = require(path.join(JS, 'ui.js'));
            const themes = require(path.join(JS, 'kit', 'themes.js'));
            const r = new Recorder(UI.W, UI.H, { textScale: 1.164 });
            r.own = true; r.extra = 49; r.chrome = { tabs: null };
            UI.draw(r, G, themes.theme('m_tricolour'), app.view(), app.views[app.views.length - 1].act);
            assert.deepStrictEqual(r.targets.map((q) => q.key.replace('m_drive_', '')),
                ['map1', 'map2', 'map3', 'map4', 'flapOem', 'flapOpen', 'flapClosed', 'coolingOn', 'coolingOff']);
            assert.ok(r.targets.every((q) => q.y + q.h <= UI.H + 49 && q.x >= 24 && q.x + q.w <= UI.W - 24), 'buttons inside the panel');
            const c = new Canvas(UI.W, UI.H + 49);
            play(r.words(), c);
            fs.writeFileSync(path.join(OUT, 'm_drive_recorded.png'), c.png());
        } finally { app.done(); }
    });

    await t('missing readings stay "--": no temperatures, no unit answering, placeholders not taken', async () => {
        const app = await boot({ car: { iat: null, egs: null, baro: null }, rpm: null });
        try {
            app.car.temps = false;
            app.car.feed('de.bmw.infotainment.drivingexcitement.FES', 'statusSwitchDriveDynamicSport2', { displayBoostPressure: 0 });
            app.car.feed('de.bmw.infrastructure.analytics.BasicDataSet', 'basicDataSet', { valueTemperatureTransmissionOil: 0 });
            await sleep(1500);
            const d = app.view().telemetry;
            assert.deepStrictEqual([d.rpm, d.oil, d.coolant, d.gearbox, d.iat, d.boost], [null, null, null, null, null, null]);
            app.car.feed('de.bmw.infotainment.drivingexcitement.FES', 'statusSwitchDriveDynamicSport2', { displayBoostPressure: 85 });
            app.car.feed('de.bmw.infrastructure.analytics.BasicDataSet', 'basicDataSet', { valueTemperatureTransmissionOil: 130 });
            app.car.feed('de.bmw.infrastructure.analytics.BasicDataSet', 'basicDataSet', { valueTemperatureTransmissionOil: 132 });
            await app.settled('moved', (v) => v.telemetry.boost !== null && v.telemetry.gearbox !== null);
            assert.deepStrictEqual([app.view().telemetry.boost, app.view().telemetry.gearbox], [0.85, 84]);
        } finally { app.done(); }
    });
}

(async () => {
    await packaging();
    await guards();
    await queued();
    await screen();
    results.forEach((l) => console.log(l));
    const failed = results.filter((l) => l.startsWith('FAIL')).length;
    if (process.env.M_DRIVE_OUT) console.log('frames: ' + OUT);
    console.log(failed ? failed + ' of ' + results.length + ' failed' : 'M Drive checks: all ' + results.length + ' passed');
    process.exit(failed ? 1 : 0);
})();
