'use strict';
/**
 * Road Conditions - ice risk from the outside temperature and its last 30 minutes, and how gusty the side wind is on
 * straight roads at speed (an estimate from the steering corrections). Says plainly what the car cannot tell: a wet road.
 *
 *   - runs with the car (app.json autostart): background() samples once a second, so the trend and the wind history
 *     are there when the screen opens
 *   - signals (all read only, as other apps read them):
 *       outside temperature   EnvironmentalInformation.ExteriorTemperature, raw x 0.5 - 40 (Live Data, Drag Timer)
 *       speed                 Vehicle2.statusCarSpeed2, x 0.015625
 *       sideways g            CDS2.statusLateralAccelerationMassCenter, x 0.002 - 65 m/s2 (Blackbox, Live Data)
 *       steering wheel angle  chassis.SteeringAngle, signed 16 bit x 0.04395 deg (Live Adjustments' xDrive page)
 *       day or night          Vehicle.statusDayNightChangeOver (Ambient config)
 *   - no rain sensor, wiper or humidity signal is known for the apps (Drag Timer's weather.js: "The car tells no
 *     humidity"), so the app shows no wet-road guess
 * Pages and arithmetic: view.js, conditions.js.
 */
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const C = require('./conditions');
const { draw } = require('./view');

const W = 1600, G0 = 9.80665;
const TABS = ['Now', 'Ice risk', 'Side wind', 'How it works'];
const DAY_NIGHT = { KEINE_AENDERUNG: 0, TAG: 1, NACHT: 2, SIGNAL_UNGUELTIG: 3 };

async function background(bg) {
    const { signals, log } = bg;
    const v = { temp: null, speed: null, gLat: null, steer: null, night: null };
    const state = { seen: false };
    const sc = (raw, f, o, bad) => (typeof raw === 'number' && raw !== bad ? raw * f + o : null);
    const watch = (iface, h) => (signals && signals.watch ? Promise.resolve(signals.watch(iface, '1', h, log)).catch((e) => log.warn('road conditions: ' + iface + ': ' + (e && e.message || e))) : null);
    watch('de.bmw.infrastructure.EnvironmentalInformation', { ExteriorTemperature: (x) => { v.temp = sc(x && x.temperatureExterior, 0.5, -40, 255); } });
    watch('de.bmw.infotainment.vehicle.Vehicle2', { statusCarSpeed2: (x) => { v.speed = sc(x && x.speedVehicleCentreOfGravity, 0.015625, 0, 65535); } });
    watch('de.bmw.infotainment.vehicle.CDS2', {
        statusLateralAccelerationMassCenter: (x) => { const a = sc(x && x.lateralAccelerationCentreOfGravity, 0.002, -65, 65535); v.gLat = a === null ? null : a / G0; },
    });
    const steer = (x) => { const r = x && x.actualValueSteeringAngleDriver; v.steer = typeof r === 'number' && r !== 65535 ? (r >= 32768 ? r - 65536 : r) * 0.04395 : null; };
    watch('de.bmw.chassis.SteeringAngle', { ActualSteeringAngleDriver: steer, actualSteeringAngleDriverNoCRC: steer });
    watch('de.bmw.infotainment.vehicle.Vehicle', {
        statusDayNightChangeOver: (x) => { const d = x && typeof x === 'object' ? x.dayNightChangeOver : x, c = typeof d === 'string' ? DAY_NIGHT[d] : d; if (c === 1 || c === 2) v.night = c === 2; },
    });
    const tracker = new C.Tracker();
    const timer = setInterval(() => {
        if (!state.seen && (G.isNum(v.temp) || G.isNum(v.speed))) state.seen = true;
        tracker.sample(v, Date.now());
    }, 1000);
    if (timer.unref) timer.unref();
    return { v, state, tracker };
}

/* Demo (no car, or Settings > Demo data): a cold evening on the motorway, from the time of day so it moves smoothly. */
const wob = (n) => { const x = Math.sin(n * 12.9898) * 43758.5453; return x - Math.floor(x); };
function demoCurve(m) { return 2.6 + 1.05 * Math.cos(m / 19) + 0.12 * Math.sin(m * 1.7); }
function demoPoint(t) {
    const m = t / 60000, k = Math.floor(t / 10000), cycle = m % 30;
    const curve = (cycle > 10 && cycle < 12.5) || (cycle > 25 && cycle < 26);
    const gust = (cycle > 7 && cycle < 10) ? 2.4 + 1.6 * Math.sin((cycle - 7) / 3 * Math.PI) : (cycle > 18 && cycle < 20) ? 2.1 : (cycle > 28.2) ? 3.3 : 0;
    const steerSd = 0.75 + 0.45 * wob(k) + gust * (0.75 + 0.4 * wob(k + 7));
    return { t, fast: !curve, straight: !curve, speed: curve ? 72 : 112 + 8 * wob(k + 3), steerSd, latSd: steerSd * 0.012 };
}
function demoTracker(now) {
    const tr = { temps: [], points: [] };
    for (let t = Math.floor(now / 30000) * 30000 - 30 * 60000 + 30000; t <= now; t += 30000) tr.temps.push({ t, c: demoCurve(t / 60000) });
    for (let t = Math.floor(now / 10000) * 10000 - 30 * 60000 + 10000; t <= now; t += 10000) tr.points.push(demoPoint(t));
    return tr;
}

mgu.run({
    background,
    async start(ctx) {
        const { ui, settings } = ctx;
        const bgd = ctx.background || await background(ctx);
        let page = 0;
        const demoOn = () => settings.get('demo') === 'on' || (settings.get('demo') !== 'off' && !bgd.state.seen);
        if (ctx.onTab) ctx.onTab((i) => { page = i; return render(); });
        ui.onClick('BTN_NEXT', () => { page = (page + 1) % TABS.length; return render(); });

        function render() {
            const t = ctx.theme(), cv = ctx.canvas(W, 520).clear(t.bg), now = Date.now(), demo = demoOn();
            const tracker = demo ? demoTracker(now) : bgd.tracker;
            const last = tracker.temps[tracker.temps.length - 1];
            const v = demo ? { temp: last ? last.c : null, speed: 112 + 6 * Math.sin(now / 7000), night: true } : bgd.v;
            const iceAt = settings.get('iceAt') || C.ICE_AT, trendC = C.trend(tracker.temps, now);
            const ic = C.ice(v.temp, trendC, iceAt), wd = C.wind(tracker.points, now);
            draw(cv, t, page, { temp: v.temp, speed: v.speed, night: v.night === undefined ? null : v.night, tracker, now, iceAt, trendC,
                ic, wd, ov: C.overall(ic, wd), stats: C.windStats(tracker.points) });
            G.frame(cv, t, TABS, page, [demo && { text: 'DEMO' }]);
            return ui.image('MAIN_GFX', cv);
        }
        ctx.loop('MAIN', 2, render);
        render().then(() => ctx.log.info('first frame done')).catch((e) => ctx.log.warn('first render: ' + e));
    },
});

module.exports = { demoTracker };
