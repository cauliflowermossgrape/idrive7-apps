'use strict';
/**
 * Diagnose - finds what is off, not just what is: it learns how this car usually behaves in each condition (this gear,
 * these revs, this temperature) and shows the moments something left its usual line, what moved first, and how now
 * compares with the same conditions before. For the driver, for tuning, and for the talk with the workshop.
 *
 * Pages:
 *   Anomalies     a live strip of the checks (green fine, yellow learning, red off), cards "what is compared with what"
 *                 (torque against forward g per gear, engine speed against road speed, torque against boost per rev
 *                 band, oil against coolant, steering against sideways g), the anomalies found; Freeze keeps the last 30 s
 *   Timeline      one anomaly's 30 s: a lane per channel, causes on top and results below, what went off first, in order
 *   Compare       now against the same conditions before: a check's value with its usual line as a ghost and the
 *                 tolerance band, the delta table of every check, the biggest movers right now, drift from "healthy"
 *   Tests         garage tests: Start test / Stop test records the response against the input (a sweep or a step), one
 *                 value can be held steady (it warns when it moves), the last two tests of the same kind compared
 *   Mechanic      the findings in big plain words and as a QR code a phone camera reads, for the workshop
 *   How it works
 *
 * Reads only what the car sends anyway; nothing is asked of any control unit and nothing is written to one.
 * Every number it judges by is learned from this car, so the first drives are "learning". Estimates, not a diagnosis.
 */
const path = require('path');
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const Car = require('./kit/car');
const { Engine } = require('./engine');
const { Demo } = require('./demo');
const view = require('./view');

const W = 1600, H = 520, RATE_MS = 100, PRETRAIN_S = 400;
const TABS = ['Anomalies', 'Timeline', 'Compare', 'Tests', 'Mechanic', 'How it works'];
const STEER = 'de.bmw.chassis.SteeringAngle';

mgu.run({
    async start(ctx) {
        const { ui, settings, log } = ctx;
        // what Car does not read: 12 V charge, boost (the car's sport display: 0.01 a step, 255 none), outside, steering
        const x = { soc12: null, boost: null, outside: null, steer: null };
        const steer = (v) => {
            let raw = v && v.actualValueSteeringAngleDriver;
            if (typeof raw !== 'number') return;
            if (raw >= 32768) raw -= 65536;
            const deg = raw * 0.04395;
            if (deg >= -900 && deg <= 900) x.steer = deg;
        };
        const car = new Car(ctx, ['rpm', 'speed', 'accel', 'temps', 'gear', 'torque'], {
            'de.bmw.infotainment.vehicle.CDS': { statusBattery2: (v) => { const c = v && v.conditionBatteryChargingCondition; if (G.isNum(c) && c >= 0 && c <= 100) x.soc12 = c; } },
            'de.bmw.infotainment.drivingexcitement.FES': { statusSwitchDriveDynamicSport2: (v) => { const r = v && v.displayBoostPressure; if (G.isNum(r) && r >= 0 && r !== 255) x.boost = r * 0.01; } },
            'de.bmw.infrastructure.EnvironmentalInformation': { ExteriorTemperature: (v) => { const r = v && v.temperatureExterior; if (G.isNum(r) && r !== 255) x.outside = r * 0.5 - 40; } },
            [STEER]: { ActualSteeringAngleDriver: steer, actualSteeringAngleDriverNoCRC: steer },
        });

        const real = new Engine({ dir: path.join(ctx.dataDir, 'diagnose'), log });
        let demoEngine = null, demoSim = null;
        const demoOn = () => settings.get('demo') === 'on' || (settings.get('demo') !== 'off' && !!car.data().demo);
        /* The demo learns 400 s of its made-up drive at once, so its pages are full from the first frame. */
        function demoNow() {
            if (demoEngine) return demoEngine;
            const now = Date.now(), t0 = now - PRETRAIN_S * 1000;
            demoSim = new Demo(t0); demoEngine = new Engine({ demo: true, log });
            for (let t = t0; t < now; t += RATE_MS) {
                demoEngine.sample(demoSim.step(t));
                if (t - t0 === 120000) demoEngine.saveHealthy(t);
            }
            const mk = (name, f) => { const T = { x: 'rpm', y: 'boost', name, points: [], ms: 20000, at: now - f * 3600000, hold: { id: 'oil', start: 96, band: 5, broke: null } };
                for (let r = 1500; r <= 6000; r += 25) T.points.push([r, Math.max(0, Math.min(1.3, (r - 1300) / 2600 * 1.25 * f) + 0.04 * Math.sin(r / 97))]); return T; };
            demoEngine.tests = [mk('Test 1', 0.86), mk('Test 2', 1)];
            demoEngine.tests[0].at = now - 3 * 86400000;
            return demoEngine;
        }
        const E = () => (demoOn() ? demoNow() : real);

        // 10 samples a second, drawing reads what this leaves
        const timer = setInterval(() => {
            const now = Date.now();
            if (demoOn()) { const e = demoNow(); e.sample(demoSim.step(now)); return; }
            const d = car.data();
            if (!G.isNum(d.rpm) && !G.isNum(d.speed)) return;
            const kW = G.isNum(d.torque) && G.isNum(d.rpm) ? d.torque * d.rpm / 9549 : null;
            real.sample({ t: now, rpm: d.rpm, speed: d.speed, gLong: d.gLong, gLat: d.gLat, torque: d.torque, boost: x.boost, kW,
                oil: d.oil, coolant: d.coolant, outside: x.outside, soc12: x.soc12, steer: x.steer, gear: d.gear });
        }, RATE_MS);
        if (timer.unref) timer.unref();
        const saver = setInterval(() => real.save(), 60000);
        if (saver.unref) saver.unref();
        process.on('exit', () => real.save());

        let page = 0, sel = 0, note = '', noteUntil = 0;
        const say = (s) => { note = s; noteUntil = Date.now() + 5000; };
        const items = () => E().caught.slice().reverse();          // newest first
        const go = (p) => { page = p; return render(); };
        if (ctx.onTab) ctx.onTab((i) => go(i));
        ui.onClick('BTN_PAGE', () => go((page + 1) % TABS.length));
        ui.onClick('BTN_PREV', () => { sel = Math.max(0, sel - 1); if (page !== 1) page = 1; return render(); });
        ui.onClick('BTN_NEXT', () => { sel = Math.min(Math.max(0, items().length - 1), sel + 1); if (page !== 1) page = 1; return render(); });
        const freeze = () => { const it = E().freeze(Date.now()); sel = 0; page = 1; say('Frozen: the last 30 s are kept' + (demoOn() ? ' (demo, not saved)' : '')); log.info('diagnose: freeze ' + it.id); return render(); };
        ui.onClick('BTN_FREEZE', freeze);
        const test = () => {
            const e = E();
            if (e.test) { const T = e.testStop(); say(T ? T.name + ' saved: ' + T.points.length + ' points' : 'Too short to keep: drive the test a little longer'); }
            else { e.testStart({ x: settings.get('testX'), y: settings.get('testY'), hold: settings.get('hold'), band: settings.get('holdBand') }); say('Test running: do the sweep or step, then Stop test'); }
            ui.text('BTN_TEST', e.test ? 'Stop test' : 'Start test');
            page = 3; return render();
        };
        ui.onClick('BTN_TEST', test);
        const healthy = () => { E().saveHealthy(Date.now()); say('Saved: this is how the car behaves when healthy. Compare shows the drift from it.'); return render(); };
        ui.onClick('BTN_HEALTHY', healthy);

        async function render() {
            const t = ctx.theme(), cv = ctx.canvas(W, H).clear(t.bg), e = E(), now = demoOn() ? e.lastT : Date.now();
            const its = items();
            if (sel >= its.length) sel = Math.max(0, its.length - 1);
            if (page === 4 && !render.logged) { render.logged = true; log.info('diagnose findings:\n' + e.findingsText(ctx.spec.version)); }
            view.draw(cv, t, page, { e, now, items: its, sel, settings, note: Date.now() < noteUntil ? note : '', demo: demoOn(),
                version: ctx.spec.version, act: { freeze, test, healthy } });
            G.frame(cv, t, TABS, page, [demoOn() && { text: 'DEMO' }, e.test && { text: 'TEST', color: t.warn }]);
            await ui.image('MAIN_GFX', cv);
        }
        ctx.loop('MAIN', 10, render);
        render().then(() => log.info('first frame done')).catch((err) => log.warn('first render: ' + (err && err.stack || err)));
    },
});
