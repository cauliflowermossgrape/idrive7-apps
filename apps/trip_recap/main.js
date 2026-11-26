'use strict';
/**
 * Trip Recap - every drive noted by itself, and shown back: the last drive as six numbers and charts, all drives as
 * bars, any drive next to the one before it (or the average of the last 10).
 *
 *   - runs with the car (app.json autostart): background() samples once a second (trips.js), the page shows it
 *   - km from the odometer the cluster sends (KombiIF statusRangeTankStatus), else the speed added up
 *   - g from CDS2, power from FES torque x rpm, oil and coolant from CDS (the scalings Blackbox and Warm-Up use)
 *   - Previous / Next choose a drive (Drives, Compare), or a mark (Before / After); Settings > Compare with: the one
 *     before, or the last 10
 *   - Mark a change (pressed twice): a service, a new part, tyres ... (Settings > Change to mark) noted now with the
 *     odometer; Before / After sets the drives before it against the drives after it (diff.js)
 * Reads only what the car sends anyway (SOME/IP signals); nothing is asked of any control unit, nothing written to one.
 */
const path = require('path');
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const { Trips } = require('./trips');
const { draw } = require('./view');

const W = 1600, G0 = 9.80665;
const TABS = ['Last drive', 'Drives', 'Compare', 'Before / After', 'How it works'];
const CONFIRM_MS = 5000;

/* With or without the screen (autostart): the drives noted. */
async function background(bg) {
    const { signals, log } = bg;
    const v = { rpm: null, speed: null, odo: null, gLong: null, gLat: null, torque: null, oil: null, coolant: null };
    const sc = (raw, f, o, bad) => (typeof raw === 'number' && raw !== bad ? raw * f + o : null);
    const watch = (iface, h) => (signals && signals.watch ? Promise.resolve(signals.watch(iface, '1', h, log)).catch((e) => log.warn('trip recap: ' + iface + ': ' + (e && e.message || e))) : null);
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
    });
    watch('de.bmw.infotainment.KombiIF', {
        statusRangeTankStatus: (x) => { const m = x && x.mileageKilometre; if (typeof m === 'number' && m >= 0 && m < 16777215) v.odo = m; },
    });
    const trips = new Trips({ file: path.join(bg.dataDir, 'trips.json'),
        onSaved: (r) => log.info('trip recap: saved ' + r.km + ' km, ' + r.secs + ' s' + (r.error ? ', ' + r.error : '')) });
    const state = { seen: false };
    const timer = setInterval(() => {
        if (!state.seen && (G.isNum(v.speed) || G.isNum(v.rpm))) state.seen = true;
        const kw = G.isNum(v.torque) && G.isNum(v.rpm) ? v.torque * v.rpm / 9549 : null;
        trips.sample({ speed: v.speed, rpm: v.rpm, odo: v.odo, gLong: v.gLong, gLat: v.gLat, kw, oil: v.oil, coolant: v.coolant });
    }, 1000);
    if (timer.unref) timer.unref();
    process.on('exit', () => trips.flush());
    return { trips, state, v };
}

mgu.run({
    background,
    async start(ctx) {
        const { ui, settings } = ctx;
        const bgd = ctx.background || await background(ctx);
        const trips = bgd.trips, st = bgd.state || { seen: true };
        let page = 0, sel = 0, markSel = 0, armed = 0;    // markSel: 0 the newest mark, 1 the one before ...
        const demoOn = () => settings.get('demo') === 'on' || (settings.get('demo') !== 'off' && !st.seen && !trips.list().length);
        const demo = makeDemo();
        const list = () => (demoOn() ? demo.trips : trips.list());
        const marks = () => (demoOn() ? demo.marks : trips.marks());
        const lastMark = () => Math.max(0, marks().length - 1);

        // on Before / After, Previous and Next choose a mark (newest first), elsewhere a drive
        ui.onClick('BTN_PREV', () => {
            if (page === 3) { markSel = Math.min(lastMark(), markSel + 1); return render(); }
            sel = Math.max(0, sel - 1); if (page === 0 || page === 4) page = 1; return render();
        });
        ui.onClick('BTN_NEXT', () => {
            if (page === 3) { markSel = Math.max(0, markSel - 1); return render(); }
            sel = Math.min(Math.max(0, list().length - 1), sel + 1); if (page === 0 || page === 4) page = 1; return render();
        });
        ui.onClick('BTN_MARK', () => {
            page = 3;
            if (!armed || Date.now() - armed > CONFIRM_MS) { armed = Date.now(); return render(); }
            armed = 0;
            const label = settings.get('markLabel') || 'Other';
            if (demoOn()) demo.marks.push({ at: Date.now(), label, odo: demo.trips[0] ? demo.trips[0].odo : null });
            else { const m = trips.mark(label, bgd.v ? bgd.v.odo : null); ctx.log.info('trip recap: marked ' + label + (m.error ? ', ' + m.error : '')); }
            markSel = 0;
            return render();
        });
        if (ctx.onTab) ctx.onTab((i) => { page = i; return render(); });

        function render() {
            const t = ctx.theme(), cv = ctx.canvas(W, 520).clear(t.bg), d = demoOn(), l = list();
            if (sel >= l.length) sel = Math.max(0, l.length - 1);
            const live = d ? null : trips.current();
            const mk = marks();
            if (armed && Date.now() - armed > CONFIRM_MS) armed = 0;
            // markSel counts from the newest; the page wants the index in the marks, oldest first
            draw(cv, t, page, { last: l[0], live, list: l, sel, compareWith: settings.get('compareWith'), keep: 30, now: Date.now(),
                marks: mk, markSel: mk.length ? mk.length - 1 - Math.min(markSel, mk.length - 1) : null,
                kind: settings.get('compareKind') || 'all', armed: !!armed });
            G.frame(cv, t, TABS, page, [d && { text: 'DEMO' }, live && { text: 'DRIVING', color: '#2fd27a' }]);
            return ui.image('MAIN_GFX', cv);
        }
        ctx.loop('MAIN', 1, render);
        render().then(() => ctx.log.info('first frame done')).catch((e) => ctx.log.warn('first render: ' + e));
    },
});

/* Demo (no car yet, or Settings > Demo data): twenty made-up drives and two marks, never saved. After the Service
   mark the engine gives a little more power and the oil runs cooler; after the Tyres mark the car corners harder. */
function makeDemo() {
    const out = [], H = 3600000, now = Date.now();
    const base = new Date(now); base.setHours(18, 10, 0, 0);
    if (base.getTime() > now - H) base.setTime(base.getTime() - 24 * H);     // the newest drive is always in the past
    const kms = [23.4, 8.1, 41.7, 12.9, 6.3, 87.2, 15.5, 9.8, 33.1, 18.6, 5.2, 27.0, 21.3, 11.4, 36.8, 14.2, 25.5, 9.1, 19.7, 30.4];
    kms.forEach((km, i) => {
        const fast = km > 30, vAvg = fast ? 74 + (i % 3) * 6 : 38 + (i % 4) * 5, secs = Math.round(km / vAvg * 3600 * 1.12);
        const start = base.getTime() - i * 19 * H - (i % 3) * 2 * H, n = Math.max(3, Math.round(secs / 10)), trace = [];
        for (let k = 0; k < n; k++) {
            const p = k / n, s = Math.min(1, p * 8, (1 - p) * 8);
            trace.push(Math.max(0, Math.round(s * (vAvg * 1.1 + (fast ? 28 : 14) * Math.sin(k / 7 + i) + 6 * Math.sin(k / 2.3)))));
        }
        const serviced = i <= 7, newTyres = i <= 15;
        out.push({ start, end: start + secs * 1000, km, secs, moving: Math.round(secs * 0.88), vAvg, vMax: Math.max.apply(null, trace),
            gFwd: 0.28 + (i % 4) * 0.02, gBrake: 0.5 + (i % 5) * 0.03, gSide: (newTyres ? 0.68 : 0.33) + (i % 3) * 0.02, brakes: (i * 7) % 3,
            kwMax: Math.round((150 + ((i * 7) % 9) - 4) * (serviced ? 1.07 : 1)), oilMin: 18 + (i % 6), oilMax: (serviced ? 100 : 104) + (i % 3) - 1,
            coolMin: 20 + (i % 6), coolMax: 91 + (i % 2), warm: 400 + (i * 13) % 50, trace, odo: Math.round(49650 - i * 22.5) });
    });
    const between = (a, b) => Math.round((out[a].start + out[b].end) / 2);
    return { trips: out, marks: [{ at: between(15, 16), label: 'Tyres', odo: out[16].odo + 10 }, { at: between(7, 8), label: 'Service', odo: out[8].odo + 10 }] };
}
