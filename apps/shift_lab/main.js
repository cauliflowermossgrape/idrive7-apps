'use strict';
/**
 * Shift Lab - what the gearbox does when you push: every upshift under load timed, with its rpm drop and the dip in g
 * you feel; each gear's ratio learned; how hard the car pulls in each gear across the revs.
 *
 *   - pages: Live, Shifts, Pull, How it works (view.js); the measuring is in shifts.js
 *   - kept in the app's data folder (shift_lab.json): the last 200 shifts, the ratios, the pull per gear
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
const { draw } = require('./view');
const demo = require('./demo');

const W = 1600, H = 520, TABS = ['Live', 'Shifts', 'Pull', 'How it works'], CONFIRM_MS = 5000;

mgu.run({
    async start(ctx) {
        const { ui, settings, log } = ctx;
        const car = new Car(ctx, ['rpm', 'speed', 'accel', 'gear', 'torque']);
        const FILE = path.join(ctx.dataDir, 'shift_lab.json');
        const lab = new ShiftLog({ minTorque: settings.get('minTorque') });
        try { lab.load(JSON.parse(fs.readFileSync(FILE, 'utf8'))); } catch (e) { /* first start */ }
        const save = () => { if (!lab.changed) return; lab.changed = false; try { fs.writeFileSync(FILE, JSON.stringify(lab.toJSON())); } catch (e) { log.warn('save: ' + e); } };
        const timer = setInterval(save, 30000);
        if (timer.unref) timer.unref();
        process.on('exit', save);
        lab.onShift = (sh) => log.info('shift ' + sh.from + '>' + sh.to + ' ' + sh.ms + ' ms, ' + sh.rpmBefore + '>' + sh.rpmAfter + ' rpm');
        car.onSample((d, t) => { if (!d.demo) { lab.minTorque = settings.get('minTorque'); lab.feed(d, t); } });

        let page = 0, armed = 0, demoData = null;
        const turn = (n) => { page = (page + n + TABS.length) % TABS.length; armed = 0; return render(); };
        ui.onClick('BTN_PAGE', () => turn(1));
        ui.onClick('BTN_PREV', () => turn(-1));
        if (ctx.onTab) ctx.onTab((i) => { page = i; return render(); });
        ui.onClick('BTN_CLEAR', () => {
            if (car.data().demo) return render();
            if (!armed || Date.now() - armed > CONFIRM_MS) { armed = Date.now(); return render(); }
            armed = 0; lab.clear(); save(); log.info('shifts cleared');
            return render();
        });

        function render() {
            const t = ctx.theme(), cv = ctx.canvas(W, H).clear(t.bg), d = car.data();
            let src;
            if (d.demo) {
                demoData = demoData || demo.make(Date.now());
                src = { shifts: demoData.shifts, ratios: demoData.ratios, curves: pullCurves(demoData.pull), perGear: perGear(demoData.shifts) };
            } else src = { shifts: lab.shifts, ratios: lab.ratios, curves: lab.pullCurves(), perGear: lab.perGear() };
            draw(cv, t, page, Object.assign(src, { d, minTorque: settings.get('minTorque') }));
            const live = armed && Date.now() - armed < CONFIRM_MS;
            G.frame(cv, t, TABS, page, [d.demo && { text: 'DEMO' }, live && { text: 'PRESS CLEAR AGAIN', color: t.crit }]);
            return ui.image('MAIN_GFX', cv);
        }
        ctx.loop('MAIN', 10, render);
        render().then(() => log.info('first frame done')).catch((e) => log.warn('first render: ' + e));
    },
});
