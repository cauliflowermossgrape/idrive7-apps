'use strict';
/**
 * Warm-Up - know when the engine is ready to be used, and when it has cooled.
 *
 *   - oil + coolant gauges (oil is what matters: it lags coolant by minutes)
 *   - warm-up calculator: minutes until oil / coolant are warm,
 *     from the measured warm-up rate (typical rates until enough is measured),
 *     projected on the trend graph; "engine off" when a hybrid drives electric
 *   - safe rev limit that climbs from the cold limit to the redline with oil temp
 *   - 20-minute temperature trend
 *   - turbo cool-down: hard driving (high rpm or high power) builds up a cool-down
 *     time (30 s - 3 min) that counts down while driving gently or idling
 *   - gearbox oil (gearbox.js, issue #164): a third gauge, its own "ready in" and trend line, and READY
 *     waits for it too, on a car that has it (the gearbox unit, else the car's signal)
 *   - Cold starts tab: the engine's starts, how many with cold oil and how many cold runs went past the safe rev
 *     limit (coldstarts.js, counted in the background: app.json autostart)
 *   - home-screen widget (app.json startWidget): the state, the oil, "ready in", coolant and gearbox oil at a glance
 *   - Drives tab (issue #235): the lowest and highest oil, coolant and gearbox oil of each of the latest drives,
 *     and on request a CSV of each drive (kit/runtime/drivelog.js, also counted in the background); from Trip Recap
 *     (#251) each drive also sums itself up (km, time, average and top speed, the most g each way, hard brakes, the
 *     most power, the oil's warm-up), shown as Drive, List, Compare and Before / After a marked change (drives.js)
 *   - Ready? tab (from Ready Check, #252): READY / NOT YET / TOO HOT for harder driving with the reason, cards for
 *     the oil, coolant, gearbox oil, 12 V battery, fuel range and tyre pressures with their bands, and this page's
 *     own turbo cool-down with rpm and power over the last 3 minutes (ready.js)
 */
const mgu = require('./kit/mgu');
const { withAlpha, ScaledCanvas } = require('./kit/canvas');
const G = require('./kit/gauges');
const Car = require('./kit/car');
const Engine = require('./kit/engine');
const { ColdStarts, COLD_C } = require('./coldstarts');
const { Gearbox } = require('./gearbox');
const { DriveLog } = require('./kit/drivelog');
const Ready = require('./ready');
const Drives = require('./drives');

const W = 1600, H = 520;
const GO = '#2fd27a';
const HARD_RPM = 3800, HARD_KW = 90;       // above either = hard use (heats the turbo)
const GENTLE_RPM = 2800, GENTLE_KW = 40;   // below both = cooling down
const COOL_MIN = 30, COOL_MAX = 180;       // s of cool-down, growing with the hard-use time
// typical warm-up rates (deg C / min) until enough has been measured
const TYPICAL = { oil: { drive: 4, idle: 1.5 }, coolant: { drive: 7, idle: 3 }, gearbox: { drive: 3, idle: 0.8 } };
const HIST = { oil: 1, coolant: 2, gearbox: 5 };   // a value's place in a hist entry
const GEAR_HOT = 125;                      // deg C: ease off
const GEAR_C = '#b98cff';                  // the gearbox's colour in the trend
const TABS = ['Warm-up', 'Ready?', 'Cold starts', 'Drives'];
const P = { warm: 0, ready: 1, cold: 2, drives: 3 };
const G0 = 9.80665, CONFIRM_MS = 5000;
const KOMBI = 'de.bmw.infotainment.KombiIF', TPMS = 'de.bmw.infotainment.vehicle.TPMS';
const ENV = 'de.bmw.infrastructure.EnvironmentalInformation', CDS = 'de.bmw.infotainment.vehicle.CDS';
const TYRES = [['FL', 'front left'], ['FR', 'front right'], ['RL', 'rear left'], ['RR', 'rear right']];
const RPM = { factor: 0.25, invalid: 65535 }, TEMP = { offset: -48, invalid: 255 };

/** The safe rev limit for the oil's temperature: the cold limit up to the redline, climbing from 30 deg C to warm. */
function limitFor(engine, settings, oil) {
    const warm = settings.get('warmOil'), red = engine.redline(), cold = Math.min(engine.value('coldLimit', { diesel: 3000, petrol: 3500 }), red);
    if (!G.isNum(oil)) return null;
    if (oil >= warm) return red;
    return Math.round((cold + (red - cold) * G.clamp((oil - 30) / (warm - 30), 0, 1)) / 100) * 100;
}

/* With or without the screen (autostart): the cold starts counted. */
async function background(bg) {
    const { settings, signals, log } = bg;
    const engine = new Engine({ settings, dataDir: bg.dataDir, log });
    const cs = new ColdStarts({ settings, limit: (oil) => limitFor(engine, settings, oil), warm: () => settings.get('warmOil') });
    // each drive's temperatures, and (#251) its own summary: kept for the latest 30 drives
    const drives = new DriveLog({ settings, key: 'drives', channels: ['oil', 'coolant', 'gearbox'], dataDir: bg.dataDir, csv: () => settings.get('driveCsv'),
        stats: true, keep: 30, warmAt: () => settings.get('warmOil') });
    const v = { speed: null, odo: null, gLong: null, gLat: null, torque: null, rpm: null };
    const sc = (raw, f, o, bad) => (typeof raw === 'number' && raw !== bad ? raw * f + o : null);
    const w = (iface, h) => (signals && signals.watch ? Promise.resolve(signals.watch(iface, '1', h, log)).catch((e) => log.warn('cold starts: ' + (e && e.message || e))) : null);
    w('de.bmw.infotainment.vehicle.CDS', {
        statusEngineSpeed2: (x) => { const r = x && x.actualValueRPMEngineCrankshaft; if (G.isNum(r) && r !== RPM.invalid) { v.rpm = r * RPM.factor; cs.rpm(r * RPM.factor); drives.rpm(r * RPM.factor); } },
        statusEngineTemperature: (x) => {
            const o = x && x.temperatureEngineOilDrive, c = x && x.temperatureEngineDrive;
            if (G.isNum(o) && o !== TEMP.invalid) { cs.oil(o + TEMP.offset); drives.value('oil', o + TEMP.offset); }
            if (G.isNum(c) && c !== TEMP.invalid) drives.value('coolant', c + TEMP.offset);
        },
    });
    w(Engine.SIGNAL[0], Object.assign({ statusCarSpeed2: (x) => { v.speed = sc(x && x.speedVehicleCentreOfGravity, 0.015625, 0, 65535); } }, engine.handlers()));
    // for each drive's summary (the scalings Blackbox and G-Force use)
    w('de.bmw.infotainment.vehicle.CDS2', {
        statusLongitudinalAccelerationMassCenter: (x) => { const a = sc(x && x.longitudinalAccelerationCentreOfGravity, 0.002, -65, 65535); v.gLong = a === null ? null : a / G0; },
        statusLateralAccelerationMassCenter: (x) => { const a = sc(x && x.lateralAccelerationCentreOfGravity, 0.002, -65, 65535); v.gLat = a === null ? null : a / G0; },
    });
    w('de.bmw.infotainment.drivingexcitement.FES', {
        statusActualValueTorque2: (x) => { const raw = x && x.actualValueTorqueCrankshaft; v.torque = typeof raw === 'number' && raw < 4095 ? raw * 0.5 - 1023.5 : null; },
    });
    w(KOMBI, { statusRangeTankStatus: (x) => { const m = x && x.mileageKilometre; if (typeof m === 'number' && m >= 0 && m < 16777215) v.odo = m; } });
    const timer = setInterval(() => {
        const kw = G.isNum(v.torque) && G.isNum(v.rpm) ? v.torque * v.rpm / 9549 : null;
        drives.sample({ speed: v.speed, odo: v.odo, gLong: v.gLong, gLat: v.gLat, kw });
    }, 1000);
    if (timer.unref) timer.unref();
    return { cs, drives, v };
}

mgu.run({
    background,
    async start(ctx) {
        const { ui, settings } = ctx;
        const bgd = ctx.background || await background(ctx), cs = bgd.cs, drives = bgd.drives;
        let page = 0, dview = 0, sel = 0, markSel = 0, armed = 0;
        // engine profile (diesel / petrol): the Auto redline and cold limit
        const engine = new Engine({ settings, dataDir: ctx.dataDir, log: ctx.log });
        // the Ready? tab's other checks: 12 V charge and range as Live Data reads them, the outside temperature
        const x = { soc12: null, range: null, fuel: null, outside: null, p: {}, pt: {} };
        const car = new Car(ctx, ['rpm', 'speed', 'temps', 'torque'], {
            [Engine.SIGNAL[0]]: engine.handlers(),
            [CDS]: { statusBattery2: (v) => { const c = v && v.conditionBatteryChargingCondition; if (G.isNum(c) && c >= 0 && c <= 100) x.soc12 = c; } },
            [KOMBI]: { statusRangeTankStatus: (v) => {
                if (v && G.isNum(v.range) && v.range < 4095) x.range = v.range;
                if (v && G.isNum(v.fluidLevelFuelTank) && v.fluidLevelFuelTank < 255) x.fuel = v.fluidLevelFuelTank;
            } },
            [ENV]: { ExteriorTemperature: (v) => { const r = v && v.temperatureExterior; if (G.isNum(r) && r !== 255) x.outside = r * 0.5 - 40; } },
        });
        // tyres as M Vitals reads them, also every 10 s (a car may not notify them), only while the page shows: the
        // watch and its re-read are shut down when it is hidden (as Service does with the cluster). Only their ratio
        // to the car's own target is used, so no unit is needed
        const tp = (o, pre, k) => { const r = o && o[pre + k + 'H']; return G.isNum(r) && r < 65532 && r > 0 ? r : null; };
        let tyreSub = null;
        function watchTyres(on) {
            if (on && !tyreSub && ctx.signals && ctx.signals.watch) {
                tyreSub = Promise.resolve(ctx.signals.watch(TPMS, '1', {
                    statusTyrePressure: (v) => TYRES.forEach(([k]) => { x.p[k] = tp(v, 'actualValuePressureTyre', k); }),
                    statusTargetTyrePressure: (v) => TYRES.forEach(([k]) => { x.pt[k] = tp(v, 'targetPressureTyre', k); }),
                }, ctx.log, { pollMs: 10000 })).catch((e) => { ctx.log.warn('tyres: ' + (e && e.message || e)); return null; });
            }
            if (!on && tyreSub) {
                const w = tyreSub; tyreSub = null;
                w.then((r) => r && r.shutdown && r.shutdown()).catch(() => {});
            }
        }
        if (ui.onVisible) ui.onVisible((name, on) => { if (name === 'MAIN') watchTyres(on); });
        if (!ui.isVisible || ui.isVisible('MAIN')) watchTyres(true);
        car.setRedline(engine.redline());
        engine.onChange(() => car.setRedline(engine.redline()));
        const gearbox = new Gearbox(ctx, ctx.log, () => ctx.ui.isVisible('MAIN')).start();
        // the gearbox oil: the unit's / the signal's, or in the demo one that follows the oil a little behind
        const gearT = (d) => (d.demo ? (G.isNum(d.oil) ? d.oil - 12 : null) : gearbox.temp());

        /* ---------- tracking ---------- */
        const hist = [];             // [t, oil, coolant, rpm, speed, gearbox] every 5 s, 20 min; t = steady clock (mono)
        const power = [];            // [wall t, rpm, kW] every second, 3 min: the Ready? tab's cool-down chart
        let lastPow = 0;
        // the head unit sets its clock after start-up: wall-clock times can jump by hours, which
        // threw the trend lines across the screen. A steady clock only ever moves forward.
        const mono = () => { const h = process.hrtime(); return h[0] * 1000 + h[1] / 1e6; };
        let lastHist = 0, lastT = 0;
        // cool-down: hardS = seconds of hard use; needS = cool-down it asks for; cool = gentle seconds done
        let hardS = 0, needS = 0, cool = 0, doneAt = 0;
        car.onSample((d, t) => {
            // sample times (the demo replays late steps with theirs) are wall-clock: a step back counts as no time,
            // and "cooled" times its 20 s on the steady clock
            const dt = lastT ? G.clamp(t - lastT, 0, 250) / 1000 : 0, m = mono(); lastT = t;
            if (G.isNum(d.rpm)) {
                const kw = G.isNum(d.torque) ? d.torque * d.rpm / 9549 : 0;
                const hard = d.rpm > HARD_RPM || kw > HARD_KW;
                const gentle = d.rpm < GENTLE_RPM && kw < GENTLE_KW;
                if (hard) {
                    hardS += dt; cool = 0; doneAt = 0;
                    if (hardS > 8) needS = G.clamp(COOL_MIN + hardS * 3, COOL_MIN, COOL_MAX);
                } else if (needS > 0 && gentle) {
                    cool += dt;
                    if (cool >= needS && !doneAt) doneAt = m;
                } else if (!needS) {
                    hardS = Math.max(0, hardS - dt * 0.2);      // short bursts fade away
                }
                // "cooled" message stays for 20 s, then all clear
                if (doneAt && m - doneAt > 20000) { hardS = 0; needS = 0; cool = 0; doneAt = 0; }
                if (m - lastPow > 1000) { lastPow = m; power.push([t, d.rpm, Math.max(0, kw)]); while (power.length > 190) power.shift(); }
            }
            if (drives && !d.demo) drives.value('gearbox', gearbox.temp());
            if (m - lastHist > 5000 && (G.isNum(d.oil) || G.isNum(d.coolant))) {
                lastHist = m; hist.push([m, d.oil, d.coolant, d.rpm, d.speed, gearT(d)]);
                while (hist.length > 240) hist.shift();
            }
        }, () => { hist.length = 0; power.length = 0; hardS = 0; needS = 0; cool = 0; doneAt = 0; });

        const F = () => settings.get('tempUnit') === 'f';
        const T = (c) => (G.isNum(c) ? (F() ? c * 9 / 5 + 32 : c) : null);
        const tU = () => (F() ? '°F' : '°C');

        const limit = (oil) => limitFor(engine, settings, oil);

        /** deg C per minute over the last ~3 min (least squares) and the time it covers (ms). */
        function measured(idx) {
            const last = hist.length ? hist[hist.length - 1][0] : 0;
            const pts = hist.filter((h) => G.isNum(h[idx]) && last - h[0] < 180000);
            if (pts.length < 4) return { rate: null, span: 0 };
            const n = pts.length, mx = pts.reduce((a, p) => a + p[0], 0) / n, my = pts.reduce((a, p) => a + p[idx], 0) / n;
            let num = 0, den = 0;
            pts.forEach((p) => { num += (p[0] - mx) * (p[idx] - my); den += (p[0] - mx) * (p[0] - mx); });
            return { rate: den ? num / den * 60000 : null, span: pts[n - 1][0] - pts[0][0] };
        }

        /**
         * Warm-up estimate for 'oil' / 'coolant': { state, min, rate, est }.
         * state: ready | warming | off (engine not running) | stalled (not getting warmer).
         * The typical rate is blended into the measured one over the first 2 minutes (est = mostly typical).
         */
        function eta(key, temp, target, d) {
            if (!G.isNum(temp)) return { state: 'none' };
            if (temp >= target) return { state: 'ready' };
            if (G.isNum(d.rpm) && d.rpm < 300) return { state: 'off' };
            const m = measured(HIST[key]);
            const typ = TYPICAL[key][G.isNum(d.speed) && d.speed > 10 ? 'drive' : 'idle'];
            const w = G.clamp(m.span / 120000, 0, 1);
            const rate = G.isNum(m.rate) ? w * m.rate + (1 - w) * typ : typ;
            if (w > 0.8 && rate < 0.15) return { state: 'stalled', rate };
            const min = (target - temp) / Math.max(0.15, rate);
            return { state: 'warming', min, rate, est: w < 0.5 };
        }

        /* ---------- drawing ---------- */
        /**
         * Temperature as a tach bar (Redline style), 0-150 deg C in 10 deg segments in the tach colours
         * (blue -> purple -> red at 120 deg C, solid red above); cold / warn / crit zones tint the
         * track, green mark where it counts as warm.
         */
        function gauge(cv, t, y, h, val, label, warm) {
            const st = F() ? 18 : 10;
            G.segBar(cv, t, 24, y, 880, h, {
                label, value: T(val), unit: tU(), decimals: 0, min: T(0), max: T(150), step: st, scale: { every: st * 2.5 },
                zones: [{ from: T(120), to: T(135), color: 'warn' }, { from: T(135), to: T(160), color: 'crit' }],
                ramp: 'hot', limit: T(120), marks: [{ value: T(warm), color: GO }],
            });
        }

        /** The same in a lower panel (three of them with the gearbox): a thinner bar, smaller scale and number. */
        function gaugeSmall(cv, t, y, h, val, label, warm) {
            const p = G.panel(cv, t, 24, y, 880, h, label), st = F() ? 18 : 10, v = T(val);
            const uw = cv.textWidth(' ' + tU(), 22);
            cv.text(G.isNum(v) ? String(Math.round(v)) : '--', 880 - uw, y + 48, 48, G.isNum(v) ? t.text : t.dim, { align: 'right', font: 'num' });
            cv.text(' ' + tU(), 880, y + 48, 22, t.dim, { align: 'right' });
            G.segBar(cv, t, 48, y + 66, 832, p.h - 66 - 44, {
                panel: false, value: v, min: T(0), max: T(150), step: st, scale: { every: st * 2.5, size: 20, labelY: 40, tick: 8 },
                zones: [{ from: T(120), to: T(135), color: 'warn' }, { from: T(135), to: T(160), color: 'crit' }],
                ramp: 'hot', limit: T(120), marks: [{ value: T(warm), color: GO }],
            });
        }

        /** One "ready in" row: label + target, big minutes (or the state), a reason on the right. */
        function etaRow(cv, t, y, label, e, target) {
            cv.text(label, 952, y, 22, t.dim, { font: 'bold', spacing: 1.5 });
            let big, col = t.text, right = '', unit = '';
            if (e.state === 'ready') { big = 'READY'; col = GO; }
            else if (e.state === 'off') { big = 'ENGINE OFF'; col = t.dim; right = 'electric driving'; }
            else if (e.state === 'stalled') { big = 'NOT WARMING'; col = t.warn; right = 'drive to warm up'; }
            else if (e.state === 'warming') { big = e.min > 60 ? '>60' : '~' + Math.max(1, Math.round(e.min)); unit = 'min'; }
            else { big = '--'; col = t.dim; }
            // the large number font has digits and a few letters only: words in bold, minutes in num + 'min'
            const bw = cv.text(big, 952, y + 50, unit ? 52 : 40, col, { font: unit || big === '--' ? 'num' : 'bold', spacing: unit ? 0 : 1 });
            if (unit) cv.text(unit, 960 + bw, y + 50, 26, t.dim);
            if (right) cv.text(right, 1552, y + 48, 24, t.dim, { align: 'right' });
            cv.text('target ' + Math.round(T(target)) + tU(), 1552, y, 22, t.dim, { align: 'right' });
        }

        /* The Cold starts tab: the three counts, the latest starts, Reset. */
        function renderCold(cv, t) {
            const st = cs.stats(), pct = (n) => (st.starts ? Math.round(n * 100 / st.starts) + ' %' : '');
            const since = new Date(st.since), two = (n) => (n < 10 ? '0' : '') + n;
            [['ENGINE STARTS', st.starts, '', t.text], ['WITH COLD OIL', st.cold, 'under ' + Math.round(T(COLD_C)) + tU() + '  ' + pct(st.cold), t.cold],
                ['COLD AND REVVED', st.revved, 'past the safe rev limit  ' + pct(st.revved), t.warn]].forEach(([label, n, note, col], i) => {
                const x = 24 + i * 523;
                G.panel(cv, t, x, 44, 506, 180, null);
                cv.text(label, x + 24, 86, 22, t.dim, { font: 'bold', spacing: 1.5 });
                cv.text(String(n), x + 24, 172, 72, n ? col : t.dim, { font: 'num' });
                cv.text(note, x + 24, 206, 20, t.dim);
            });
            const lp = G.panel(cv, t, 24, 240, 1552, 272, 'Latest starts');
            const rows = st.last || [];
            if (!rows.length) cv.text('Counted from the next engine start', 48, 330, 24, t.dim);
            rows.slice(0, 4).forEach((r, i) => {
                const at = new Date(r.at), y = 316 + i * 44;
                cv.text(at.getDate() + '.' + two(at.getMonth() + 1) + '.  ' + at.getHours() + ':' + two(at.getMinutes()), 48, y, 24, t.text);
                cv.text('oil ' + Math.round(T(r.oil)) + tU(), 360, y, 24, r.cold ? t.cold : t.text, { font: 'bold' });
                cv.text(r.revved ? 'revved cold' : r.cold ? 'cold start' : '', 560, y, 24, r.revved ? t.warn : t.dim);
            });
            cv.text('since ' + since.getDate() + '.' + two(since.getMonth() + 1) + '.' + since.getFullYear(), 1552, 300, 22, t.dim, { align: 'right' });
            G.button(cv, t, 1336, 240 + lp.h - 70, 216, 50, 'Reset', () => { cs.reset(); return render(); }, { key: 'reset', confirm: true });
        }

        /** The same, on one line (three of them with the gearbox): label and target left, minutes / state right. */
        function etaLine(cv, t, y, label, e, target) {
            cv.text(label, 952, y, 22, t.dim, { font: 'bold', spacing: 1.5 });
            cv.text('target ' + Math.round(T(target)) + tU(), 952, y + 26, 20, t.dim);
            let big, col = t.text, unit = '';
            if (e.state === 'ready') { big = 'READY'; col = GO; }
            else if (e.state === 'off') { big = 'ENGINE OFF'; col = t.dim; }
            else if (e.state === 'stalled') { big = 'NOT WARMING'; col = t.warn; }
            else if (e.state === 'warming') { big = e.min > 60 ? '>60' : '~' + Math.max(1, Math.round(e.min)); unit = 'min'; }
            else { big = '--'; col = t.dim; }
            const ux = unit ? 1552 - cv.textWidth(unit, 24) : 1552;
            cv.text(big, unit ? ux - 8 : 1552, y + 22, unit ? 44 : 32, col, { align: 'right', font: unit || big === '--' ? 'num' : 'bold', spacing: unit ? 0 : 1 });
            if (unit) cv.text(unit, 1552, y + 22, 24, t.dim, { align: 'right' });
        }

        function render() {
            const t = ctx.theme(), d = car.data(), now = Date.now();
            const cv = ctx.canvas(W, H).clear(t.bg);
            if (drives && page === P.drives) {
                renderDrives(cv, t, d);
                G.frame(cv, t, TABS, P.drives, [(d.demo && !drives.drives().length) && { text: 'DEMO' }, drives.drives()[0] && drives.drives()[0].live && { text: 'DRIVING', color: GO }]);
                return ui.image('MAIN_GFX', cv);
            }
            if (cs && page === P.cold) {
                renderCold(cv, t);
                G.frame(cv, t, TABS, P.cold, [d.demo && { text: 'DEMO' }]);
                return ui.image('MAIN_GFX', cv);
            }
            if (page === P.ready) {
                renderReady(cv, t, d, now);
                G.frame(cv, t, TABS, P.ready, [d.demo && { text: 'DEMO' }]);
                return ui.image('MAIN_GFX', cv);
            }
            const warm = settings.get('warmOil'), warmC = settings.get('warmCoolant');
            // the room below the page (on the car, with no bar under it): half to each gauge; the coolant
            // panel ends at the page's bottom, and G.panel adds the room back to it
            const room = G.pageBottom(cv) - G.BOTTOM, half = Math.round(room / 2);
            const gb = gearT(d), warmG = settings.get('warmGearbox'), hasGb = G.isNum(gb);
            if (hasGb) {
                // three gauges in the room of two: the oil (what matters most) gets the extra room below the page
                gaugeSmall(cv, t, G.TOP, 144 + half, d.oil, 'Oil', warm);
                gaugeSmall(cv, t, G.TOP + 161 + half, 144, d.coolant, 'Coolant', warmC);
                gaugeSmall(cv, t, G.TOP + 322 + half, 145 - half, gb, 'Gearbox oil', warmG);
            } else {
                gauge(cv, t, G.TOP, 225 + half, d.oil, 'Oil', warm);
                gauge(cv, t, G.TOP + 242 + half, 225 - half, d.coolant, 'Coolant', warmC);
            }

            // ---- status panel
            const sp = G.panel(cv, t, 928, 44, 648, 468, null);
            const lim = limit(d.oil);
            // ready: the oil warm, and the gearbox oil too where the car tells it
            const gbCold = hasGb && gb < warmG, gbHot = hasGb && gb > GEAR_HOT;
            const ready = G.isNum(d.oil) && d.oil >= warm && !gbCold;
            const hot = G.isNum(d.oil) && d.oil > 125;
            const cooling = settings.get('cooldown') && needS > 0;
            let st, col;
            if (!G.isNum(d.oil)) { st = 'NO OIL TEMP'; col = t.dim; }
            else if (hot) { st = 'OIL HOT - EASE OFF'; col = t.crit; }
            else if (gbHot) { st = 'GEARBOX HOT - EASE OFF'; col = t.crit; }
            else if (cooling) { st = doneAt ? 'COOLED - OK TO SWITCH OFF' : 'TURBO COOL-DOWN'; col = doneAt ? GO : t.warn; }
            else if (ready) { st = 'READY'; col = GO; }
            else if (d.oil >= warm && gbCold) { st = 'GEARBOX WARMING UP'; col = t.warn; }
            else if (d.oil >= warm - 20) { st = 'WARMING UP'; col = t.warn; }
            else { st = 'COLD'; col = t.cold; }
            cv.roundRect(952, 70, 600, 60, 10, withAlpha(col, 0.22));
            if (st === 'READY') cv.roundRect(952, 70, 600, 60, 10, withAlpha(col, 0.15 + 0.1 * Math.sin(now / 400)));
            cv.text(st, 1252, 114, st.length > 14 ? 30 : 38, col, { align: 'center', font: 'bold', spacing: 3 });

            if (cooling) {
                // big countdown: gentle driving / idling cools the turbo and oil
                const left = Math.max(0, needS - cool);
                const gentleNow = G.isNum(d.rpm) && d.rpm < GENTLE_RPM;
                // the oil warm-up stays visible as one line
                const eo = eta('oil', d.oil, warm, d);
                const line = eo.state === 'ready' ? 'Oil warm' : eo.state === 'warming' ? 'Oil ready in ~' + Math.max(1, Math.round(eo.min)) + ' min'
                    : eo.state === 'off' ? 'Engine off - oil not warming' : eo.state === 'stalled' ? 'Oil not warming' : '';
                cv.text(line, 952, 170, 24, eo.state === 'ready' ? GO : t.dim, { font: 'bold' });
                cv.text('COOL-DOWN LEFT', 952, 210, 22, t.dim, { font: 'bold', spacing: 1.5 });
                const lw = cv.text(left > 0 ? String(Math.ceil(left)) : '0', 952, 289, 80, left > 0 ? t.text : GO, { font: 'num' });
                cv.text('s', 962 + lw, 289, 30, t.dim);
                // no temperature is read for it: it grows with the time above HARD_RPM / HARD_KW (issue #235)
                cv.text('estimate from rpm and power', 1552, 210, 20, t.dim, { align: 'right' });
                cv.text(left > 0 ? (gentleNow ? 'keep it gentle' : 'paused - stay under ' + GENTLE_RPM + ' rpm') : 'done', 1552, 262, 24, left > 0 && !gentleNow ? t.warn : t.text, { align: 'right', font: 'bold' });
                const f = needS ? G.clamp(cool / needS, 0, 1) : 1;
                cv.roundRect(952, 303, 600, 12, 6, t.track);
                if (f > 0) cv.rampRect(952, 303, Math.max(12, 600 * f), 12, 6, [t.warn, GO], 952, 600);
            } else if (hasGb) {
                etaLine(cv, t, 166, 'OIL READY IN', eta('oil', d.oil, warm, d), warm);
                etaLine(cv, t, 226, 'COOLANT READY IN', eta('coolant', d.coolant, warmC, d), warmC);
                etaLine(cv, t, 286, 'GEARBOX READY IN', eta('gearbox', gb, warmG, d), warmG);
            } else {
                etaRow(cv, t, 170, 'OIL READY IN', eta('oil', d.oil, warm, d), warm);
                etaRow(cv, t, 255, 'COOLANT READY IN', eta('coolant', d.coolant, warmC, d), warmC);
            }

            // ---- safe rev limit (always) + trend
            const red = engine.redline(), fl = lim ? lim / red : 0;
            cv.text('SAFE REV LIMIT', 952, 350, 22, t.dim, { font: 'bold', spacing: 1.5 });
            cv.text(lim ? lim + ' rpm' : '---- rpm', 1552, 352, 26, ready ? GO : t.text, { align: 'right', font: 'bold' });
            cv.roundRect(1160, 340, 230, 8, 4, t.track);
            if (fl > 0) cv.roundRect(1160, 340, 230 * fl, 8, 4, ready ? GO : col);

            // trend: last minutes (steady clock, see mono) + up to 5 min projected; nothing is drawn outside the graph
            // (it grows with the status panel where that goes on down to the screen's bottom)
            const gx = 952, gy = 398, gw = 600, gh = 90 + sp.h - 468, nowX = gx + gw - 90;
            const now0 = hist.length ? hist[hist.length - 1][0] : mono();
            const span = G.clamp(hist.length ? now0 - hist[0][0] : 0, 300000, 1200000);
            const ahead = 300000;                                  // projection: up to 5 min ahead
            const lo = 0, hi = 140;
            const X = (ts) => nowX - ((now0 - ts) / span) * (gw - 90), Y = (c) => gy + gh - (G.clamp(c, lo, hi) - lo) / (hi - lo) * gh;
            cv.fillRect(gx, gy - 20, 22, 4, t.oil || t.accent); cv.text('OIL', gx + 30, gy - 11, 20, t.dim, { font: 'bold' });
            cv.fillRect(gx + 100, gy - 20, 22, 4, t.cold); cv.text('COOLANT', gx + 130, gy - 11, 20, t.dim, { font: 'bold' });
            if (hasGb) { cv.fillRect(gx + 250, gy - 20, 22, 4, GEAR_C); cv.text('GEARBOX', gx + 280, gy - 11, 20, t.dim, { font: 'bold' }); }
            cv.fillRect(gx, Y(warm), gw, 1, withAlpha(GO, 0.5));
            cv.text(String(Math.round(T(warm))), gx + gw + 4, Y(warm) + 7, 20, GO);
            cv.fillRect(nowX, gy, 1, gh, withAlpha(t.tick, 0.5));       // "now"
            [[1, t.oil || t.accent, 'oil', warm, d.oil], [2, t.cold, 'coolant', warmC, d.coolant]].concat(hasGb ? [[5, GEAR_C, 'gearbox', warmG, gb]] : []).forEach(([i, c, key, target, cur]) => {
                const pts = hist.filter((h) => G.isNum(h[i])).map((h) => [X(h[0]), Y(h[i])]).filter((p) => p[0] >= gx && p[0] <= nowX + 0.5);
                if (pts.length > 1) cv.polyline(pts, 3, c);
                // projection to the target, dashed
                const e = eta(key, cur, target, d);
                if (e.state === 'warming' && pts.length) {
                    const x0 = nowX, y0 = Y(cur), mins = Math.min(e.min, ahead / 60000);
                    const x1 = x0 + (mins * 60000 / ahead) * 90, y1 = Y(cur + e.rate * mins);
                    for (let k = 0; k < 6; k++) {
                        const a = k / 6, b = (k + 0.5) / 6;
                        cv.line(x0 + (x1 - x0) * a, y0 + (y1 - y0) * a, x0 + (x1 - x0) * b, y0 + (y1 - y0) * b, 2, withAlpha(c, 0.8));
                    }
                }
            });
            cv.fillRect(gx, gy + gh, gw, 1, withAlpha(t.tick, 0.5));
            G.frame(cv, t, cs ? TABS : ['Warm-up'], 0, [d.demo && { text: 'DEMO' }]);     // G20-style frame
            return ui.image('MAIN_GFX', cv);
        }

        /*
         * Home-screen widget, as eDrive's: the big one is a picture (the HMI crops a share of every edge and fades them:
         * startWidget.safe, and the setting widgetFit keeps everything further in), the small one shows the layout's text
         * lines and progress bar (it shows no picture at that size).
         */
        const WIDGET_FIT = { large: [0, 0, 0, 0], medium: [0.06, 0.04, 0.06, 0.02], small: [0.11, 0.09, 0.11, 0.05] };
        const wcan = {}, wtext = {};
        /** The state in a word or two and its colour, as the page's status line decides it (no gearbox-only states). */
        function widgetState(t, d) {
            const warm = settings.get('warmOil');
            if (!G.isNum(d.oil)) return ['NO OIL TEMP', t.dim];
            if (d.oil > 125) return ['OIL HOT', t.crit];
            if (settings.get('cooldown') && needS > 0) return doneAt ? ['COOLED', GO] : ['TURBO COOL-DOWN', t.warn];
            if (d.oil >= warm) return ['READY', GO];
            return d.oil >= warm - 20 ? ['WARMING UP', t.warn] : ['COLD', t.cold];
        }
        function readyText(d) {
            const e = eta('oil', d.oil, settings.get('warmOil'), d);
            return e.state === 'ready' ? 'oil warm' : e.state === 'warming' ? 'ready in ~' + Math.max(1, Math.round(e.min)) + ' min'
                : e.state === 'off' ? 'engine off' : e.state === 'stalled' ? 'not warming' : '';
        }
        function widgetCells(inst) {
            const t = ctx.theme(), d = car.data(), on = !inst.big, st = widgetState(t, d), warm = settings.get('warmOil');
            const deg = (c) => (G.isNum(c) ? Math.round(T(c)) + tU() : '--');
            const cells = {
                Title: [on ? 'Warm-Up' : '', 'Text'],
                TextRecordings: [on ? st[0] + '  oil ' + deg(d.oil) : '', 'Text'],
                TextCam: [on ? readyText(d) : '', 'Text'],
                ProgressbarVisible: [on, 'Bool'],
                Progress: [on && G.isNum(d.oil) ? Math.round(G.clamp((d.oil - 20) / Math.max(1, warm - 20), 0, 1) * 100) / 100 : 0, 'Float'],
                TimeElapsed: [on ? 'Coolant ' + deg(d.coolant) : '', 'Text'],
                TimeRemaining: [on && G.isNum(gearT(d)) ? 'Gearbox ' + deg(gearT(d)) : '', 'Text'],
            };
            const prev = wtext[inst.spawnId] || (wtext[inst.spawnId] = {});
            Object.keys(cells).forEach((k) => {
                const v = JSON.stringify(cells[k][0]);
                if (prev[k] === v) return;
                prev[k] = v;
                ctx.widget.set(inst.spawnId, k, cells[k][0], cells[k][1]);
            });
        }
        function renderWidget(inst) {
            if (inst) widgetCells(inst);
            const sw0 = ctx.spec.startWidget || {};
            const [w, h] = sw0.size || [384, 256], key = w + 'x' + h;
            const cv = (wcan[key] = wcan[key] || new ScaledCanvas(w, h, sw0.scale || 1)).clear([0, 0, 0, 0]);
            const t = ctx.theme(), d = car.data(), warm = settings.get('warmOil'), st = widgetState(t, d);
            const safe = sw0.safe || [0.09, 0.1], sf = safe.length === 4 ? safe : [safe[0], safe[1], safe[0], safe[1]];
            const f = WIDGET_FIT[settings.get('widgetFit')] || WIDGET_FIT.large;
            const x0 = Math.round(w * (sf[0] + f[0])), x1 = w - Math.round(w * (sf[2] + f[2]));
            const y0 = Math.round(h * (sf[1] + f[1])), y1 = h - Math.round(h * (sf[3] + f[3])), iw = x1 - x0;
            // the layout (314 x 168 at full size), scaled into the room and centred
            const s = Math.min(1, iw / 314, (y1 - y0) / 168), top = y0 + Math.round((y1 - y0 - 168 * s) / 2);
            const Y = (v) => top + v * s, F = (v) => v * s;
            cv.text(st[0], x0, Y(18), F(18), st[1], { font: 'bold', spacing: F(1.5) });
            if (d.demo) cv.text('DEMO', x1, Y(18), F(13), t.warn, { font: 'bold', spacing: F(1), align: 'right' });
            // the oil, large, and how long until it is warm
            const ky = Y(88), ov = G.isNum(d.oil) ? String(Math.round(T(d.oil))) : '--';
            const vw = cv.text(ov, x0, ky, F(66), G.isNum(d.oil) ? (d.oil >= warm ? GO : t.text) : t.dim, { font: 'num' });
            cv.text(tU() + ' OIL', x0 + F(8) + vw, ky, F(20), t.dim, { font: 'bold' });
            cv.text(readyText(d), x1, ky, F(20), t.text, { font: 'bold', align: 'right' });
            // a bar from 20 deg C to warm, the warm mark at its end
            const by = ky + F(14), bh = F(10);
            cv.roundRect(x0, by, iw, bh, bh / 2, t.track);
            if (G.isNum(d.oil)) cv.roundRect(x0, by, Math.max(bh, iw * G.clamp((d.oil - 20) / Math.max(1, warm - 20), 0, 1)), bh, bh / 2, d.oil >= warm ? GO : st[1]);
            // bottom row: coolant, gearbox oil (where the car has it), safe rev limit
            const yb = Y(168 - 26), gb = gearT(d), lim = limit(d.oil);
            const colm = (x, label, v, c, align) => {
                cv.text(label, x, yb, F(13), t.dim, { font: 'bold', spacing: F(1), align });
                cv.text(v, x, yb + F(24), F(21), c, { font: 'bold', align });
            };
            colm(x0, 'COOLANT', G.isNum(d.coolant) ? Math.round(T(d.coolant)) + tU() : '--', G.isNum(d.coolant) ? t.text : t.dim);
            if (G.isNum(gb)) colm((x0 + x1) / 2, 'GEARBOX', Math.round(T(gb)) + tU(), gb > GEAR_HOT ? t.crit : t.text, 'center');
            colm(x1, 'REV LIMIT', lim ? lim + ' rpm' : '--', t.text, 'right');
            return cv.canvas;
        }
        if (ctx.widget) {
            ctx.widget.loop(4, renderWidget);
            ctx.widget.onChange((why) => { if (why === 'resized' || why === 'placed') Object.keys(wtext).forEach((k) => delete wtext[k]); });
        }

        if (cs && ctx.onTab) ctx.onTab((i) => { page = i; return render(); });

        /* ---------- Drives (drives.js) ---------- */
        const demoDrives = makeDemo();
        // the car's own drives, as trips; in the demo (no car, nothing recorded yet) a made-up set, never saved
        function tripList(d) {
            const real = drives ? drives.drives() : [];
            if (!real.length && d.demo) return demoDrives.trips;
            return real.map((r) => Drives.trip(r, drives.trace(r.at)));
        }
        const markList = (d) => (drives && drives.drives().length || !d.demo ? (drives ? drives.marks() : []) : demoDrives.marks);
        function renderDrives(cv, t, d) {
            const list = tripList(d), mk = markList(d);
            if (sel >= list.length) sel = Math.max(0, list.length - 1);
            if (armed && Date.now() - armed > CONFIRM_MS) armed = 0;
            Drives.draw(cv, t, { view: dview, list, sel, compareWith: settings.get('compareWith'), kind: settings.get('compareKind') || 'all',
                marks: mk, markSel: mk.length ? mk.length - 1 - Math.min(markSel, mk.length - 1) : null, armed: !!armed, now: Date.now(),
                T, tU, csv: settings.get('driveCsv'), own: cv.own, onView: (i) => { dview = i; return render(); } });
            if (drives && dview === 1 && drives.drives().length) {
                G.button(cv, t, 1336, 438, 216, 50, 'Reset', () => { drives.reset(); return render(); }, { key: 'resetDrives', confirm: true });
            }
        }
        // Previous / Next: a drive, or on Before / After a mark (newest first); Drives view cycles the four views
        ui.onClick('BTN_PREV', () => {
            page = P.drives;
            if (dview === 3) markSel = Math.min(Math.max(0, markList(car.data()).length - 1), markSel + 1);
            else sel = Math.max(0, sel - 1);
            return render();
        });
        ui.onClick('BTN_NEXT', () => {
            page = P.drives;
            if (dview === 3) markSel = Math.max(0, markSel - 1);
            else sel = Math.min(Math.max(0, tripList(car.data()).length - 1), sel + 1);
            return render();
        });
        ui.onClick('BTN_VIEW', () => { page = P.drives; dview = (dview + 1) % Drives.VIEWS.length; return render(); });
        // Mark a change, pressed twice: noted now with the odometer, for Before / After
        ui.onClick('BTN_MARK', () => {
            page = P.drives; dview = 3;
            if (!armed || Date.now() - armed > CONFIRM_MS) { armed = Date.now(); return render(); }
            armed = 0;
            const label = settings.get('markLabel') || 'Other', d = car.data();
            if (!drives.drives().length && d.demo) demoDrives.marks.push({ at: Date.now(), label, odo: null });
            else { drives.mark(label, bgd.v ? bgd.v.odo : null); ctx.log.info('warm-up: marked ' + label); }
            markSel = 0;
            return render();
        });

        /* ---------- Ready? (ready.js) ---------- */
        function tyres() {
            let lowest = null, which = '';
            TYRES.forEach(([k, name]) => {
                if (!G.isNum(x.p[k]) || !G.isNum(x.pt[k])) return;
                const r = x.p[k] / x.pt[k];
                if (r < 0.3 || r > 1.6) return;                 // not a pair of real values
                if (lowest === null || r < lowest) { lowest = r; which = name; }
            });
            return { lowest, which };
        }
        function renderReady(cv, t, d, now) {
            const set = { warmOil: settings.get('warmOil'), warmCoolant: settings.get('warmCoolant'), warmGearbox: settings.get('warmGearbox') };
            const s = d.demo ? { oil: d.oil, coolant: d.coolant, gearbox: gearT(d), soc12: 66, range: 412, fuel: 38, tyres: { lowest: 0.96, which: 'rear left' } }
                : { oil: d.oil, coolant: d.coolant, gearbox: gearT(d), soc12: x.soc12, range: x.range, fuel: x.fuel, tyres: tyres() };
            const list = Ready.checks(s, set);
            // ready in: the slowest of the cold ones, each from this page's own warm-up estimate
            const keys = { oil: [d.oil, set.warmOil], coolant: [d.coolant, set.warmCoolant], gearbox: [gearT(d), set.warmGearbox] };
            const etas = list.filter((c) => c.temp && c.state === 'cold').map((c) => eta(c.key, keys[c.key][0], keys[c.key][1], d)).filter((e) => e.state === 'warming').map((e) => e.min);
            const cooling = settings.get('cooldown') && needS > 0;
            Ready.draw(cv, t, { list, verdict: Ready.verdict(list), eta: etas.length ? Math.max.apply(null, etas) : null,
                outside: d.demo ? 4 : x.outside, now, T, tU, power,
                cool: cooling ? { left: Math.max(0, needS - cool), need: needS, done: cool } : null });
        }
        // every screen refresh (60 fps) with the GPU renderer; 4 fps in software (PNG frames)
        ctx.loop('MAIN', 4, render);
        render().then(() => ctx.log.info('first frame done')).catch((e) => ctx.log.warn('first render: ' + e));
    },
});

/* Demo drives (no car, nothing recorded yet): twenty made-up drives and two marks, never saved. After the Service
   mark the oil runs cooler (better) and the most power is a little up (shown as changed only); after the Tyres mark
   the car corners harder. */
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
        out.push({ start, end: start + secs * 1000, km, secs, moving: Math.round(secs * 0.88), vAvg, vMax: Math.max.apply(null, trace), summed: true,
            gFwd: 0.28 + (i % 4) * 0.02, gBrake: 0.5 + (i % 5) * 0.03, gSide: (newTyres ? 0.68 : 0.33) + (i % 3) * 0.02, brakes: (i * 7) % 3,
            kwMax: Math.round((150 + ((i * 7) % 9) - 4) * (serviced ? 1.07 : 1)), oilMin: 18 + (i % 6), oilMax: (serviced ? 100 : 104) + (i % 3) - 1,
            coolMin: 20 + (i % 6), coolMax: 91 + (i % 2), gbMin: 14 + (i % 5), gbMax: 78 + (i % 4), warm: 400 + (i * 13) % 50, trace });
    });
    const between = (a, b) => Math.round((out[a].start + out[b].end) / 2);
    return { trips: out, marks: [{ at: between(15, 16), label: 'Tyres', odo: 49280 }, { at: between(7, 8), label: 'Service', odo: 49470 }] };
}
