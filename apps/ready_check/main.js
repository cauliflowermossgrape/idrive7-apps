'use strict';
/**
 * Ready Check - is the car ready for harder driving, and may I switch off after it?
 *
 *   - Ready?: a verdict (READY / NOT YET / TOO HOT) from the engine oil, coolant and gearbox oil temperatures, and
 *     cards for those and the 12 V battery, fuel range and tyre pressures, each with its bands and a marker
 *   - Trend: the temperatures over 10 minutes, the oil's ready band, how fast each warms
 *   - After the drive: Warm-Up's turbo cool-down estimate as a countdown, with rpm and power over 3 minutes
 *   - How it works: in plain words
 * Signals only, read as the other apps read them (kit/car.js; gearbox oil from BasicDataSet as Warm-Up's fallback;
 * 12 V charge and range as Live Data; tyres as M Vitals, compared with the car's own target pressure, so no unit
 * is needed). Nothing is asked of a control unit, nothing written. Demo data until the car answers.
 */
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const Car = require('./kit/car');
const { checks, verdict, rate } = require('./checks');
const { draw } = require('./view');

const W = 1600, H = 520;
const TABS = ['Ready?', 'Trend', 'After the drive', 'How it works'];
const HARD_RPM = 3800, HARD_KW = 90, GENTLE_RPM = 2800, GENTLE_KW = 40, COOL_MIN = 30, COOL_MAX = 180;   // as Warm-Up
const KOMBI = 'de.bmw.infotainment.KombiIF', CDS = 'de.bmw.infotainment.vehicle.CDS', TPMS = 'de.bmw.infotainment.vehicle.TPMS';
const ENV = 'de.bmw.infrastructure.EnvironmentalInformation', BDS = 'de.bmw.infrastructure.analytics.BasicDataSet';
const TYRES = [['FL', 'front left'], ['FR', 'front right'], ['RL', 'rear left'], ['RR', 'rear right']];
const mono = () => { const h = process.hrtime(); return h[0] * 1000 + h[1] / 1e6; };

mgu.run({
    async start(ctx) {
        const { ui, settings, log } = ctx;
        const x = { soc12: null, range: null, fuel: null, outside: null, gearbox: null, p: {}, pt: {} };
        // the gearbox oil from the car's signal counts once it has moved by a degree (as Warm-Up: a fixed value is no reading)
        const gb = { first: null, moved: false, at: 0 };
        const extra = {
            [CDS]: { statusBattery2: (v) => { const c = v && v.conditionBatteryChargingCondition; if (G.isNum(c) && c >= 0 && c <= 100) x.soc12 = c; } },
            [KOMBI]: { statusRangeTankStatus: (v) => {
                if (v && G.isNum(v.range) && v.range < 4095) x.range = v.range;
                if (v && G.isNum(v.fluidLevelFuelTank) && v.fluidLevelFuelTank < 255) x.fuel = v.fluidLevelFuelTank;
            } },
            [ENV]: { ExteriorTemperature: (v) => { const r = v && v.temperatureExterior; if (G.isNum(r) && r !== 255) x.outside = r * 0.5 - 40; } },
            [BDS]: { basicDataSet: (v) => {
                const r = v && v.valueTemperatureTransmissionOil;
                if (!G.isNum(r) || r === 255 || r - 48 < -40 || r - 48 > 160) return;
                const c = r - 48;
                if (gb.first === null) gb.first = c;
                if (Math.abs(c - gb.first) >= 1) gb.moved = true;
                x.gearbox = c; gb.at = Date.now();
            } },
        };
        const car = new Car(ctx, ['rpm', 'speed', 'temps', 'torque'], extra);
        if (ctx.signals && ctx.signals.watch) {
            // tyre values: also read every 10 s, as M Vitals (a car may not notify them); 0.1 x raw in the car's unit,
            // the target in the same unit: only their ratio is used
            const tp = (o, pre, k) => { const r = o && o[pre + k + 'H']; return G.isNum(r) && r < 65532 && r > 0 ? r : null; };
            Promise.resolve(ctx.signals.watch(TPMS, '1', {
                statusTyrePressure: (v) => TYRES.forEach(([k]) => { x.p[k] = tp(v, 'actualValuePressureTyre', k); }),
                statusTargetTyrePressure: (v) => TYRES.forEach(([k]) => { x.pt[k] = tp(v, 'targetPressureTyre', k); }),
            }, log, { pollMs: 10000 })).catch((e) => log.warn('tyres: ' + (e && e.message || e)));
        }

        /* tracking: temperatures every 5 s for 10 min, rpm and power every second for 3 min, the cool-down */
        const hist = [], power = [];
        let lastHist = 0, lastPow = 0, lastT = 0, hard = 0, need = 0, done = 0, doneAt = 0, hardNow = false;
        car.onSample((d, t) => {
            const dt = lastT ? G.clamp(t - lastT, 0, 250) / 1000 : 0, m = mono(); lastT = t;
            if (G.isNum(d.rpm)) {
                const kw = G.isNum(d.torque) ? Math.max(0, d.torque * d.rpm / 9549) : 0;
                hardNow = d.rpm > HARD_RPM || kw > HARD_KW;
                const gentle = d.rpm < GENTLE_RPM && kw < GENTLE_KW;
                if (hardNow) { hard += dt; done = 0; doneAt = 0; if (hard > 8) need = G.clamp(COOL_MIN + hard * 3, COOL_MIN, COOL_MAX); }
                else if (need > 0 && gentle) { done += dt; if (done >= need && !doneAt) doneAt = m; }
                else if (!need) hard = Math.max(0, hard - dt * 0.2);
                if (doneAt && m - doneAt > 60000) { hard = 0; need = 0; done = 0; doneAt = 0; }
                if (m - lastPow > 1000) { lastPow = m; power.push([Date.now(), d.rpm, kw]); while (power.length > 200) power.shift(); }
            }
            if (m - lastHist > 5000 && (G.isNum(d.oil) || G.isNum(d.coolant))) {
                lastHist = m; hist.push([Date.now(), d.oil, d.coolant, gearbox()]);
                while (hist.length > 130) hist.shift();
            }
        }, () => { hist.length = 0; power.length = 0; hard = 0; need = 0; done = 0; doneAt = 0; });
        const gearbox = () => (gb.moved && Date.now() - gb.at < 20000 ? x.gearbox : null);

        let page = 0;
        if (ctx.onTab) ctx.onTab((i) => { page = i; return render(); });
        const F = () => settings.get('tempUnit') === 'f';
        const T = (c) => (G.isNum(c) ? (F() ? c * 9 / 5 + 32 : c) : null);
        const tU = () => (F() ? '°F' : '°C');

        function tyres(p, pt) {
            let lowest = null, which = '';
            TYRES.forEach(([k, name]) => {
                if (!G.isNum(p[k]) || !G.isNum(pt[k])) return;
                const r = p[k] / pt[k];
                if (r < 0.3 || r > 1.6) return;                 // not a pair of real values
                if (lowest === null || r < lowest) { lowest = r; which = name; }
            });
            return { lowest, which };
        }

        function state(now) {
            const d = car.data(), set = { warmOil: settings.get('warmOil'), warmCoolant: settings.get('warmCoolant'), warmGearbox: settings.get('warmGearbox'), unitF: F() };
            if (d.demo || settings.get('demo') === 'on') return demoState(now, set);
            const s = { oil: d.oil, coolant: d.coolant, gearbox: gearbox(), soc12: x.soc12, range: x.range, fuel: x.fuel, tyres: tyres(x.p, x.pt) };
            return { s, set, hist, power, outside: x.outside, cool: { hard, need, done, hardNow }, demo: false };
        }

        function render() {
            const t = ctx.theme(), cv = ctx.canvas(W, H).clear(t.bg), now = Date.now();
            const st = state(now), list = checks(st.s, st.set);
            const rates = { oil: rate(st.hist, 1, now), coolant: rate(st.hist, 2, now), gearbox: rate(st.hist, 3, now) };
            // ready in: the slowest of the cold ones, each at its own pace
            const etas = list.filter((c) => c.temp && c.state === 'cold' && G.isNum(rates[c.key]) && rates[c.key] > 0.15).map((c) => (c.warm - c.value) / rates[c.key]);
            const eta = etas.length ? Math.max.apply(null, etas) : null;
            draw(cv, t, page, { list, verdict: verdict(list), hist: st.hist, power: st.power, rates, eta, now, outside: st.outside, cool: st.cool, set: st.set, T, tU });
            G.frame(cv, t, TABS, page, [st.demo && { text: 'DEMO' }]);
            return ui.image('MAIN_GFX', cv);
        }
        ctx.loop('MAIN', 2, render);
        render().then(() => log.info('first frame done')).catch((e) => log.warn('first render: ' + e));
    },
});

/* Demo: a car 9 minutes into a cold morning drive (oil and coolant warm, the gearbox oil not yet), a low-ish 12 V
 * battery, after a short hard pull; never saved. */
function demoState(now, set) {
    const hist = [], power = [];
    for (let i = 120; i >= 0; i--) {
        const m = (600 - i * 5) / 60;                          // minutes into the drive
        hist.push([now - i * 5000, 20 + 72 * (1 - Math.exp(-m / 3.6)), 18 + 74 * (1 - Math.exp(-m / 2.2)), 12 + 52 * (1 - Math.exp(-m / 6.5))]);
    }
    const last = hist[hist.length - 1];
    for (let i = 180; i >= 0; i--) {
        const s = (now / 1000) - i, k = i > 96 && i < 124 ? Math.sin(Math.PI * (124 - i) / 28) : 0;   // a 28 s pull
        const rpm = 1500 + 600 * Math.sin(s / 7) + 250 * Math.sin(s / 2.3) + k * 4200;
        power.push([now - i * 1000, rpm, Math.max(4, 22 + 12 * Math.sin(s / 5)) + k * 190]);
    }
    const need = COOL_MIN + 32 * 3;
    return {
        s: { oil: last[1], coolant: last[2], gearbox: last[3], soc12: 66, range: 412, fuel: 38, tyres: { lowest: 0.96, which: 'rear left' } },
        set, hist, power, outside: 4, demo: true,
        cool: { hard: 32, need, done: 30 + (now / 1000) % (need - 40), hardNow: false },
    };
}
