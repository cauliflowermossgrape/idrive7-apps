'use strict';
/**
 * Shift Lab - what the gearbox does when you push: every upshift under load timed, with its rpm drop and the dip in g
 * you feel; each gear's ratio learned; how hard the car pulls in each gear across the revs.
 *
 *   - pages: Live, Shifts, Pull, Kickdown, Cold vs hot, How it works (view.js); the measuring is in shifts.js and
 *     kickdown.js (how fast the gearbox drops a gear when the pedal is floored, and when it holds the gear)
 *   - kept in the app's data folder (shift_lab.json): the last 200 shifts, the ratios, the pull per gear, the last
 *     120 kickdowns
 *   - Clear shifts (pressed twice within 5 s) starts the shifts and the pull over; the ratios stay
 *   - demo data (demo.js) when no car answers, never saved
 * Reads only what the car sends anyway (SOME/IP signals); nothing is asked of any control unit, nothing written to one.
 */
const fs = require('fs');
const path = require('path');
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const Car = require('./kit/car');
const { ShiftLog, perGear, pullCurves } = require('./shifts');
const { KickLog } = require('./kickdown');
const { draw } = require('./view');
const demo = require('./demo');

const W = 1600, H = 520, TABS = ['Live', 'Shifts', 'Pull', 'Kickdown', 'Cold vs hot', 'How it works'], CONFIRM_MS = 5000;

/** The driving mode (FES actualValueModeDrivingExperience, a name or a wire number, as Redline reads it). */
function modeOf(raw) {
    if (raw === undefined || raw === null) return null;
    const n = Number(raw);
    if (!isNaN(n) && String(raw).trim() !== '') {
        return (n >= 1 && n <= 3) || n === 15 || n === 16 || n === 23 || n === 28 ? 'sport'
            : n >= 17 && n <= 22 ? 'hybrid' : (n >= 4 && n <= 6) || n === 10 ? 'comfort' : n >= 7 && n <= 9 ? 'eco' : null;
    }
    const str = String(raw).toUpperCase();
    return /SPORT|BOOST/.test(str) ? 'sport' : /HYBRID|ELECTRIC|BATTERY/.test(str) ? 'hybrid' : /ADAPTIV|COMFORT|TRAFFIC/.test(str) ? 'comfort' : /ECO/.test(str) ? 'eco' : null;
}

mgu.run({
    async start(ctx) {
        const { ui, settings, log } = ctx;
        // the pedal (as Live Data reads it), the driving mode, the gearbox oil from the car's signal (as Warm-Up reads it,
        // counted only once it has moved: some cars leave it at one number)
        const x = { pedal: null, mode: null, gb: null, gbFirst: null, gbMoved: false };
        const car = new Car(ctx, ['rpm', 'speed', 'accel', 'gear', 'torque'], {
            'de.bmw.powertrain.AcceleratorPedal': { AngleAcceleratorPedal: (v) => {
                const raw = v && v.actualValueAngleAcceleratorPedal, p = typeof raw === 'number' ? raw * 0.025 : null;
                x.pedal = p !== null && p >= -2 && p <= 102 ? Math.max(0, Math.min(100, p)) : null; } },
            'de.bmw.infotainment.drivingexcitement.FES': { statusFESVehicleDynamicSwitchHMI: (v) => { const m = modeOf(v && v.actualValueModeDrivingExperience); if (m) x.mode = m; } },
            'de.bmw.infrastructure.analytics.BasicDataSet': { basicDataSet: (v) => {
                const raw = v && v.valueTemperatureTransmissionOil;
                if (typeof raw !== 'number' || raw === 255 || raw - 48 < -40 || raw - 48 > 160) return;
                if (x.gbFirst === null) x.gbFirst = raw - 48;
                if (Math.abs(raw - 48 - x.gbFirst) >= 1) x.gbMoved = true;
                x.gb = x.gbMoved ? raw - 48 : null; } },
        });
        const FILE = path.join(ctx.dataDir, 'shift_lab.json');
        const lab = new ShiftLog({ minTorque: settings.get('minTorque') }), kick = new KickLog();
        try { const o = JSON.parse(fs.readFileSync(FILE, 'utf8')); lab.load(o); kick.load(o.kicks); } catch (e) { /* first start */ }
        const save = () => {
            if (!lab.changed && !kick.changed) return;
            lab.changed = false; kick.changed = false;
            try { fs.writeFileSync(FILE, JSON.stringify(Object.assign(lab.toJSON(), { kicks: kick.toJSON() }))); } catch (e) { log.warn('save: ' + e); }
        };
        const timer = setInterval(save, 30000);
        if (timer.unref) timer.unref();
        process.on('exit', save);
        lab.onShift = (sh) => log.info('shift ' + sh.from + '>' + sh.to + ' ' + sh.ms + ' ms, ' + sh.rpmBefore + '>' + sh.rpmAfter + ' rpm');
        kick.onKick = (k) => log.info('kickdown ' + k.kind + ' ' + k.from + '>' + k.to + (k.doneMs ? ' ' + k.doneMs + ' ms' : '') + (k.est ? ' (from torque)' : ''));
        car.onSample((d, t) => {
            if (d.demo) return;
            const s = Object.assign({}, d, { pedal: x.pedal, mode: x.mode, gb: x.gb });
            lab.minTorque = settings.get('minTorque'); lab.feed(s, t); kick.feed(s, lab.ratios, t);
        });

        let page = 0, armed = 0, demoData = null;
        const turn = (n) => { page = (page + n + TABS.length) % TABS.length; armed = 0; return render(); };
        ui.onClick('BTN_PAGE', () => turn(1));
        ui.onClick('BTN_PREV', () => turn(-1));
        if (ctx.onTab) ctx.onTab((i) => { page = i; return render(); });
        ui.onClick('BTN_CLEAR', () => {
            if (car.data().demo) return render();
            if (!armed || Date.now() - armed > CONFIRM_MS) { armed = Date.now(); return render(); }
            armed = 0; lab.clear(); kick.clear(); save(); log.info('shifts cleared');
            return render();
        });

        function render() {
            const t = ctx.theme(), cv = ctx.canvas(W, H).clear(t.bg), d = car.data();
            let src;
            if (d.demo) {
                demoData = demoData || demo.make(Date.now());
                src = { shifts: demoData.shifts, ratios: demoData.ratios, curves: pullCurves(demoData.pull), perGear: perGear(demoData.shifts),
                    kicks: demoData.kicks, pedal: true, gb: 82 };
            } else src = { shifts: lab.shifts, ratios: lab.ratios, curves: lab.pullCurves(), perGear: lab.perGear(), kicks: kick.kicks, pedal: kick.pedalSeen, gb: x.gb };
            draw(cv, t, page, Object.assign(src, { d, minTorque: settings.get('minTorque') }));
            const live = armed && Date.now() - armed < CONFIRM_MS;
            G.frame(cv, t, TABS, page, [d.demo && { text: 'DEMO' }, live && { text: 'PRESS CLEAR AGAIN', color: t.crit }]);
            return ui.image('MAIN_GFX', cv);
        }
        ctx.loop('MAIN', 10, render);
        render().then(() => log.info('first frame done')).catch((e) => log.warn('first render: ' + e));
    },
});
