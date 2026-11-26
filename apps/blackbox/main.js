'use strict';
/**
 * Blackbox - the last minute of driving, saved when it matters, without pressing anything.
 *
 *   - always keeps the last 60 s in RAM (engine speed, speed, g forward and sideways, torque, oil, coolant, mode),
 *     ten samples a second (recorder.js)
 *   - saves them, plus 15 s after, as a CSV file on a hard stop (setting "brakeG"), at full power (85 % of the most power
 *     seen) or with "Save last 60 s"; and a whole Sport stretch from 60 s before it began (each its own setting)
 *   - runs with the car (app.json autostart): background() records, the page lists what was saved
 *   - Settings > Recordings as QR: the list as plain text for a phone camera; the files themselves are in the app's
 *     data folder, blackbox/ (over SSH)
 * Reads only what the car sends anyway (SOME/IP signals); nothing is asked of any control unit, nothing written to one.
 */
const fs = require('fs');
const path = require('path');
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const { qrLogSheet } = require('./kit/qrlog');
const { Recorder, RATE_MS } = require('./recorder');
const { draw, parseCsv, summary, KIND, when } = require('./view');

const TABS = ['Live', 'Recordings', 'How it works'];

const W = 1600;
const G0 = 9.80665;

/** The driving mode (FES actualValueModeDrivingExperience, a name or a wire number, as Redline reads it). */
function modeOf(raw) {
    if (raw === undefined || raw === null) return null;
    const n = Number(raw);
    if (!isNaN(n) && String(raw).trim() !== '') {
        return (n >= 1 && n <= 3) || n === 15 || n === 16 || n === 23 || n === 28 ? 'sport'
            : n >= 17 && n <= 22 ? 'hybrid' : (n >= 4 && n <= 6) || n === 10 ? 'comfort' : n >= 7 && n <= 9 ? 'eco' : null;
    }
    const s = String(raw).toUpperCase();
    return /SPORT|BOOST/.test(s) ? 'sport' : /HYBRID|ELECTRIC|BATTERY/.test(s) ? 'hybrid' : /ADAPTIV|COMFORT|TRAFFIC/.test(s) ? 'comfort' : /ECO/.test(s) ? 'eco' : null;
}

/* With or without the screen (autostart): the recording. */
async function background(bg) {
    const { settings, signals, log } = bg;
    const v = { rpm: null, speed: null, gLong: null, gLat: null, torque: null, oil: null, coolant: null, mode: null };
    const sc = (raw, f, o, bad) => (typeof raw === 'number' && raw !== bad ? raw * f + o : null);
    const watch = (iface, h) => (signals && signals.watch ? Promise.resolve(signals.watch(iface, '1', h, log)).catch((e) => log.warn('blackbox: ' + iface + ': ' + (e && e.message || e))) : null);
    watch('de.bmw.infotainment.vehicle.CDS', {
        statusEngineSpeed2: (x) => { v.rpm = sc(x && x.actualValueRPMEngineCrankshaft, 0.25, 0, 65535); },
        statusEngineTemperature: (x) => { v.oil = sc(x && x.temperatureEngineOilDrive, 1, -48, 255); v.coolant = sc(x && x.temperatureEngineDrive, 1, -48, 255); },
    });
    watch('de.bmw.infotainment.vehicle.Vehicle2', { statusCarSpeed2: (x) => { v.speed = sc(x && x.speedVehicleCentreOfGravity, 0.015625, 0, 65535); } });
    watch('de.bmw.infotainment.vehicle.CDS2', {
        statusLongitudinalAccelerationMassCenter: (x) => { const a = sc(x && x.longitudinalAccelerationCentreOfGravity, 0.002, -65, 65535); v.gLong = a === null ? null : a / G0; },
        statusLateralAccelerationMassCenter: (x) => { const a = sc(x && x.lateralAccelerationCentreOfGravity, 0.002, -65, 65535); v.gLat = a === null ? null : a / G0; },
    });
    watch('de.bmw.infotainment.drivingexcitement.FES', {
        statusActualValueTorque2: (x) => { const raw = x && x.actualValueTorqueCrankshaft; v.torque = typeof raw === 'number' && raw < 4095 ? raw * 0.5 - 1023.5 : null; },
        statusFESVehicleDynamicSwitchHMI: (x) => { const m = modeOf(x && x.actualValueModeDrivingExperience); if (m) v.mode = m; },
    });

    const rec = new Recorder({ dir: path.join(bg.dataDir, 'blackbox'), keep: settings.get('keep'),
        onSaved: (e) => log.info('blackbox: saved ' + e.file + ' (' + Math.round(e.ms / 1000) + ' s' + (e.error ? ', ' + e.error : '') + ')') });
    let peakKw = settings.get('peakKw') || 0, powerSince = 0, lastMode = null;
    const state = { seen: false, kw: null, peakKw };
    const timer = setInterval(() => {
        if (!state.seen && (G.isNum(v.speed) || G.isNum(v.rpm))) state.seen = true;
        rec.sample(v);
        const now = Date.now();
        // a hard stop: braking harder than the setting from over 30 km/h
        if (settings.get('brake') && G.isNum(v.gLong) && v.gLong <= -settings.get('brakeG') && G.isNum(v.speed) && v.speed > 30) {
            if (rec.event('brake')) log.info('blackbox: hard stop ' + v.gLong.toFixed(2) + ' g');
        }
        // full power for a second: 85 % of the most power this car has shown (learned, kept in the settings)
        const kw = G.isNum(v.torque) && G.isNum(v.rpm) ? v.torque * v.rpm / 9549 : null;
        if (G.isNum(kw) && kw > peakKw + 1) { peakKw = kw; if (Math.round(kw) % 5 === 0) settings.set('peakKw', Math.round(peakKw)); }
        state.kw = kw; state.peakKw = peakKw;
        const full = G.isNum(kw) && peakKw >= 60 && kw >= 0.85 * peakKw;
        powerSince = full ? powerSince || now : 0;
        if (settings.get('power') && powerSince && now - powerSince >= 1000 && rec.event('power')) log.info('blackbox: full power ' + Math.round(kw) + ' kW');
        // a Sport stretch
        const sport = v.mode === 'sport';
        if (sport !== lastMode) { lastMode = sport; if (settings.get('sport')) rec.sport(sport); }
    }, RATE_MS);
    if (timer.unref) timer.unref();
    process.on('exit', () => rec.flush());
    return { rec, v, state };
}

mgu.run({
    background,
    async start(ctx) {
        const { ui, settings } = ctx;
        const bgd = ctx.background || await background(ctx);
        const rec = bgd.rec, st = bgd.state || { seen: true };
        let page = 0, sel = 0;
        const cache = new Map();
        const demoOn = () => settings.get('demo') === 'on' || (settings.get('demo') !== 'off' && !st.seen);
        const demoList = makeDemo();

        ui.onClick('BTN_MARK', () => {
            if (demoOn()) demoList.unshift(demoEntry('mark', Date.now() - 15000));
            else rec.event('mark');
            page = 1; sel = 0;
            return render();
        });
        ui.onClick('BTN_PREV', () => { sel = Math.max(0, sel - 1); page = 1; return render(); });
        ui.onClick('BTN_NEXT', () => { sel = Math.min(Math.max(0, list().length - 1), sel + 1); page = 1; return render(); });
        if (ctx.onTab) ctx.onTab((i) => { page = i; return render(); });

        function list() { return demoOn() ? demoList : rec.list(); }
        function detail(e) {
            if (!e) return null;
            if (e.data) return { rows: e.data, sum: summary(e.data, e.at) };
            if (cache.has(e.file)) return cache.get(e.file);
            let d;
            try { const rows = parseCsv(fs.readFileSync(path.join(rec.dir, e.file), 'utf8')); d = { rows, sum: summary(rows, e.at) }; }
            catch (err) { d = { rows: [], sum: summary([], e.at), error: String(err && err.message || err) }; }
            cache.set(e.file, d);
            if (cache.size > 6) cache.delete(cache.keys().next().value);
            return d;
        }
        function liveRows(now) {
            if (demoOn()) { const out = []; for (let ms = now - 60000; ms <= now; ms += 200) out.push(demoAt(ms)); return out; }
            return rec.ring.map((r) => ({ t: r[0], rpm: r[1], speed: r[2], gLong: r[3], gLat: r[4], torque: r[5] }));
        }
        function listText() {
            const l = list(), out = ['Recordings: ' + l.length];
            l.forEach((e) => out.push(when(e.at) + '  ' + (KIND[e.kind] || e.kind) + ', ' + Math.round(e.ms / 1000) + ' s'
                + (G.isNum(e.vmax) ? ', top ' + Math.round(e.vmax) + ' km/h' : '') + (G.isNum(e.gMax) ? ', peak ' + e.gMax.toFixed(2) + ' g' : '') + '  ' + (e.file || 'demo')));
            out.push('', 'The files: the app\'s data folder, blackbox/');
            return out.join('\n');
        }
        if (ctx.settingsRow) {
            ctx.settingsRow({ label: 'Recordings as QR', value: 'The list, for a phone camera',
                open: () => qrLogSheet({ title: 'Recordings', plain: true, text: listText, app: 'Blackbox', version: ctx.spec.version,
                    help: ['Point the phone camera at the code:', 'it reads as plain text, no app needed.', 'The CSV files stay in the car.'] }) });
        }

        function render() {
            const t = ctx.theme(), cv = ctx.canvas(W, 520).clear(t.bg), now = Date.now(), demo = demoOn();
            const l = list();
            if (sel >= l.length) sel = Math.max(0, l.length - 1);
            const v = demo ? demoAt(now) : bgd.v;
            if (demo) v.mode = 'comfort';
            const kw = demo ? (v.torque * v.rpm / 9549) : st.kw;
            draw(cv, t, page, { v, rows: page === 0 ? liveRows(now) : [], list: l, sel, detail: page === 1 ? detail(l[sel]) : null,
                busy: demo ? null : rec.busy(), settings, kw, peakKw: demo ? 250 : st.peakKw, demo, now });
            const busy = !demo && rec.busy();
            G.frame(cv, t, TABS, page, [demo && { text: 'DEMO' }, busy && { text: 'SAVING', color: t.crit }]);
            return ui.image('MAIN_GFX', cv);
        }
        ctx.loop('MAIN', 4, render);
        render().then(() => ctx.log.info('first frame done')).catch((e) => ctx.log.warn('first render: ' + e));
    },
});

/* Demo (no car, or Settings > Demo data): a made-up drive and three made-up recordings, never saved. */
function demoAt(ms) {
    const s = ms / 1000, p = s % 45;
    let speed = 72 + 30 * Math.sin(s / 11) + 8 * Math.sin(s / 3.7), gLong = 0.12 * Math.cos(s / 11) + 0.06 * Math.cos(s / 3.7);
    // a hard stop from about 20 s into every 45: speed falls by up to 40 km/h and comes back by 40 s
    if (p > 20 && p < 40) speed -= 40 * (p < 25 ? (1 - Math.cos(Math.PI * (p - 20) / 5)) / 2 : (1 + Math.cos(Math.PI * (p - 25) / 15)) / 2);
    if (p > 20 && p < 25) gLong = -0.85 * Math.sin(Math.PI * (p - 20) / 5);
    if (p > 32 && p < 36) gLong = 0.45 * Math.sin(Math.PI * (p - 32) / 4);
    speed = Math.max(0, speed);
    return { t: ms, speed, gLong, gLat: 0.3 * Math.sin(s / 5), rpm: 900 + speed * 27 + Math.max(0, gLong) * 2500, torque: 90 + Math.max(0, gLong) * 420, oil: 98, coolant: 92 };
}
function demoEntry(kind, at) {
    const data = [];
    for (let ms = at - 60000; ms <= at + 15000; ms += 100) data.push(demoAt(ms));
    const sum = summary(data, at);
    return { kind, at, ms: 75000, rows: data.length, vmax: sum.vmax, gMax: sum.gMax, data };
}
function makeDemo() {
    const now = Date.now(), base = now - (now / 1000 % 45) * 1000;
    return [demoEntry('brake', base - 3600000 * 2 + 22000), demoEntry('power', base - 86400000 + 34000), demoEntry('mark', base - 86400000 * 3)];
}
