'use strict';
/**
 * Sanity Check - values that have to agree, watched while you drive: speed against rpm on your gears, oil against
 * coolant, the forward g against the speed change, the outside temperature, and whether rpm, speed and g keep
 * arriving on time. Each check says OK, ODD (two values disagree), LATE (a signal went quiet) or NO DATA, with
 * why in plain words and a small chart; History lists when it happened.
 *
 * It cannot tell which sensor is wrong, only that two disagree (checks.js). Read only: the signals the car sends
 * the head unit anyway, nothing asked of any control unit. The learned gears and the found events are kept in the
 * app's data folder (sanity.json). Demo data (a drive with an oil sensor reading low and the g signal stalling)
 * when there is no car.
 */
const fs = require('fs');
const path = require('path');
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const { Sanity } = require('./checks');
const { draw } = require('./view');

const W = 1600, H = 520;
const TABS = ['Checks', 'History', 'How it works'];

mgu.run({
    async start(ctx) {
        const { ui, settings, log } = ctx;
        const FILE = path.join(ctx.dataDir, 'sanity.json');
        let saved = {};
        try { saved = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { /* first start */ }
        const live = new Sanity({ gears: saved.gears, events: saved.events });
        let demo = null, seenAt = 0;
        const t0 = Date.now();

        // the car's signals, timed as they arrive (the time is what the LATE check needs)
        const put = (name, v) => { seenAt = Date.now(); live.feed(name, v, seenAt); };
        const sc = (raw, f, o, bad) => (typeof raw === 'number' && raw !== bad ? raw * f + o : null);
        const watch = (iface, h) => (ctx.signals && ctx.signals.watch
            ? Promise.resolve(ctx.signals.watch(iface, '1', h, log)).catch((e) => log.warn('sanity: ' + iface + ': ' + (e && e.message || e))) : null);
        watch('de.bmw.infotainment.vehicle.CDS', {
            statusEngineSpeed2: (x) => put('rpm', sc(x && x.actualValueRPMEngineCrankshaft, 0.25, 0, 65535)),
            statusEngineTemperature: (x) => { put('oil', sc(x && x.temperatureEngineOilDrive, 1, -48, 255)); put('coolant', sc(x && x.temperatureEngineDrive, 1, -48, 255)); },
        });
        watch('de.bmw.infotainment.vehicle.Vehicle2', { statusCarSpeed2: (x) => put('speed', sc(x && x.speedVehicleCentreOfGravity, 0.015625, 0, 65535)) });
        watch('de.bmw.infotainment.vehicle.CDS2', {
            statusLongitudinalAccelerationMassCenter: (x) => { const a = sc(x && x.longitudinalAccelerationCentreOfGravity, 0.002, -65, 65535); put('gLong', a === null ? null : a / 9.80665); },
        });
        watch('de.bmw.infrastructure.EnvironmentalInformation', { ExteriorTemperature: (x) => put('outside', sc(x && x.temperatureExterior, 0.5, -40, 255)) });

        const demoOn = () => settings.get('demo') === 'on' || (settings.get('demo') !== 'off' && !seenAt && Date.now() - t0 > 3000);
        const current = () => (demoOn() ? (demo = demo || makeDemo(Date.now())) : live);

        // the checks run 5 times a second with or without the page (the page only draws)
        const timer = setInterval(() => {
            const now = Date.now();
            if (demoOn()) { demo = demo || makeDemo(now); demo.advance(now); return; }
            live.tick(now);
            if (live.dirty && (!live.savedAt || now - live.savedAt > 30000)) {
                live.dirty = false; live.savedAt = now;
                try { fs.writeFileSync(FILE, JSON.stringify(live.save())); } catch (e) { log.warn('save: ' + e); }
            }
        }, 200);
        if (timer.unref) timer.unref();

        let page = 0;
        const flip = () => { page = (page + 1) % TABS.length; return render(); };
        ui.onClick('BTN_PAGE', flip);
        ui.onClick('BTN_CLEAR', () => { const s = current(); s.events.length = 0; s.dirty = true; return render(); });
        if (ctx.onTab) ctx.onTab((i) => { page = i; return render(); });

        function render() {
            const t = ctx.theme(), cv = ctx.canvas(W, H).clear(t.bg), s = current(), isDemo = demoOn();
            draw(cv, t, page, s, { now: isDemo ? s.now : Date.now(), demo: isDemo });
            G.frame(cv, t, TABS, page, [isDemo && { text: 'DEMO' }]);
            return ui.image('MAIN_GFX', cv);
        }
        ctx.loop('MAIN', 4, render);
        render().then(() => log.info('first frame done')).catch((e) => log.warn('first render: ' + e));
    },
});

/* Demo: 12 minutes of a made-up drive, replayed into a Sanity of its own: six gears, the oil sensor reading 40 C
 * low (ODD), the forward g going quiet for half of every minute (LATE) and one outside temperature jump. Never saved. */
function makeDemo(now) {
    const s = new Sanity({});
    s.runMs = 0;
    const K = [118, 72, 50, 38, 30, 25];
    const base = now - 50000;                                           // so that now falls in a quiet part
    let gear = 2, last = null;
    const at = (ms) => {
        const x = ms / 1000;
        const speed = Math.max(0, 75 + 35 * Math.sin(x / 23) + 12 * Math.sin(x / 7));
        while (gear < 5 && speed * K[gear] > 2600) gear++;
        while (gear > 0 && speed * K[gear] < 1300) gear--;
        return { speed, rpm: Math.max(800, speed * K[gear]) };
    };
    const step = (ms) => {
        const d = at(ms), x = ms / 1000;
        s.feed('speed', d.speed, ms);
        s.feed('rpm', d.rpm, ms);
        if (last) {
            const g = (d.speed - last.speed) / 3.6 / ((ms - last.t) / 1000) / 9.80665;
            if ((((ms - base) % 60000) + 60000) % 60000 < 32000) s.feed('gLong', g, ms);        // quiet the rest of each minute
        }
        last = { t: ms, speed: d.speed };
        if (ms % 1000 < 100) {
            s.feed('coolant', 90 + Math.sin(x / 90), ms);
            s.feed('oil', 52 + Math.sin(x / 70), ms);
            // one bad reading 6 minutes ago: the outside temperature jumps 7 C for a second
            s.feed('outside', 4.5 + 0.3 * Math.sin(x / 300) + (Math.abs(ms - (now - 360000)) < 600 ? 7 : 0), ms);
        }
        if (ms % 200 < 100) s.tick(ms);
    };
    let t = now - 12 * 60000;
    t -= t % 100;
    for (; t <= now; t += 100) step(t);
    s.now = now;
    s.advance = (n) => { for (; t <= n; t += 100) step(t); s.now = n; };
    return s;
}
