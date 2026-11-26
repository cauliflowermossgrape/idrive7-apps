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
const path = require('path');
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const { qrLogSheet } = require('./kit/qrlog');
const { Recorder, RATE_MS } = require('./recorder');

const W = 1600;
const GO = '#2fd27a';
const KIND = { brake: 'HARD STOP', power: 'FULL POWER', sport: 'SPORT', mark: 'SAVED BY HAND' };
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
    const timer = setInterval(() => {
        rec.sample(v);
        const now = Date.now();
        // a hard stop: braking harder than the setting from over 30 km/h
        if (settings.get('brake') && G.isNum(v.gLong) && v.gLong <= -settings.get('brakeG') && G.isNum(v.speed) && v.speed > 30) {
            if (rec.event('brake')) log.info('blackbox: hard stop ' + v.gLong.toFixed(2) + ' g');
        }
        // full power for a second: 85 % of the most power this car has shown (learned, kept in the settings)
        const kw = G.isNum(v.torque) && G.isNum(v.rpm) ? v.torque * v.rpm / 9549 : null;
        if (G.isNum(kw) && kw > peakKw + 1) { peakKw = kw; if (Math.round(kw) % 5 === 0) settings.set('peakKw', Math.round(peakKw)); }
        const full = G.isNum(kw) && peakKw >= 60 && kw >= 0.85 * peakKw;
        powerSince = full ? powerSince || now : 0;
        if (settings.get('power') && powerSince && now - powerSince >= 1000 && rec.event('power')) log.info('blackbox: full power ' + Math.round(kw) + ' kW');
        // a Sport stretch
        const sport = v.mode === 'sport';
        if (sport !== lastMode) { lastMode = sport; if (settings.get('sport')) rec.sport(sport); }
    }, RATE_MS);
    if (timer.unref) timer.unref();
    process.on('exit', () => rec.flush());
    return { rec, v };
}

mgu.run({
    background,
    async start(ctx) {
        const { ui, settings } = ctx;
        const bgd = ctx.background || await background(ctx);
        const rec = bgd.rec;
        const two = (n) => (n < 10 ? '0' : '') + n;
        const when = (ms) => { const d = new Date(ms); return d.getDate() + '.' + two(d.getMonth() + 1) + '. ' + two(d.getHours()) + ':' + two(d.getMinutes()) + ':' + two(d.getSeconds()); };

        ui.onClick('BTN_MARK', () => { rec.event('mark'); return render(); });

        function listText() {
            const l = rec.list(), out = ['Recordings: ' + l.length];
            l.forEach((e) => out.push(when(e.at) + '  ' + (KIND[e.kind] || e.kind) + ', ' + Math.round(e.ms / 1000) + ' s'
                + (G.isNum(e.vmax) ? ', top ' + Math.round(e.vmax) + ' km/h' : '') + (G.isNum(e.gMax) ? ', peak ' + e.gMax.toFixed(2) + ' g' : '') + '  ' + e.file));
            out.push('', 'The files: the app\'s data folder, blackbox/');
            return out.join('\n');
        }
        if (ctx.settingsRow) {
            ctx.settingsRow({ label: 'Recordings as QR', value: 'The list, for a phone camera',
                open: () => qrLogSheet({ title: 'Recordings', plain: true, text: listText, app: 'Blackbox', version: ctx.spec.version,
                    help: ['Point the phone camera at the code:', 'it reads as plain text, no app needed.', 'The CSV files stay in the car.'] }) });
        }

        function render() {
            const t = ctx.theme(), cv = ctx.canvas(W, 520).clear(t.bg), v = bgd.v;
            const busy = rec.busy();
            const p = G.panel(cv, t, 24, 44, 1552, 120, null);
            cv.text(busy ? 'RECORDING: ' + (KIND[busy] || busy) : 'KEEPING THE LAST 60 S', 48, 96, 26, busy ? t.crit : GO, { font: 'bold', spacing: 2 });
            const on = ['brake', 'power', 'sport'].filter((k) => settings.get(k)).map((k) => KIND[k].toLowerCase());
            cv.text(on.length ? 'Saves on: ' + on.join(', ') + ', and the button' : 'Saves only with the button', 48, 136, 22, t.dim);
            cv.text((G.isNum(v.speed) ? Math.round(v.speed) + ' km/h  ' : '') + (G.isNum(v.rpm) ? Math.round(v.rpm) + ' rpm  ' : '') + (G.isNum(v.gLong) ? v.gLong.toFixed(2) + ' g' : ''),
                p.x + p.w - 24, 96, 24, t.text, { align: 'right', font: 'bold' });
            const lp = G.panel(cv, t, 24, 180, 1552, 332, 'Saved recordings');
            const l = rec.list();
            if (!l.length) cv.text('Nothing saved yet', 48, 270, 24, t.dim);
            l.slice(0, 6).forEach((e, i) => {
                const y = 262 + i * 42;
                cv.text(when(e.at), 48, y, 24, t.text);
                cv.text(KIND[e.kind] || e.kind, 330, y, 24, e.kind === 'brake' ? t.crit : e.kind === 'power' ? t.warn : t.accent, { font: 'bold' });
                cv.text(Math.round(e.ms / 1000) + ' s', 640, y, 24, t.text);
                cv.text(G.isNum(e.vmax) ? 'top ' + Math.round(e.vmax) + ' km/h' : '', 780, y, 24, t.dim);
                cv.text(G.isNum(e.gMax) ? 'peak ' + e.gMax.toFixed(2) + ' g' : '', 1040, y, 24, t.dim);
                cv.text(e.error ? 'not saved: ' + e.error : '', 1552, y, 20, t.crit, { align: 'right' });
            });
            G.frame(cv, t, ['Blackbox'], 0, []);
            return ui.image('MAIN_GFX', cv);
        }
        ctx.loop('MAIN', 4, render);
        render().then(() => ctx.log.info('first frame done')).catch((e) => ctx.log.warn('first render: ' + e));
    },
});
