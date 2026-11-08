'use strict';
/**
 * Redline - full-screen rev display in the style of the G20 Live Cockpit (Sport):
 * a wide rev bar across the middle that fills left to right in slanted 500 rpm
 * segments (theme colour to red at the shift point), digital rpm above it, a big
 * gear below it, digital speed, angular frame lines. At the shift point the lights,
 * gear and a SHIFT prompt turn red (setting "flash": they blink and the screen flashes).
 *
 *   - 12 shift lights that count into the shift and strobe for it (the shift cue, below)
 *   - huge gear number (from the gearbox, or learned from rpm/speed ratios)
 *   - every upshift is scored against your shift point (EARLY / SPOT ON / LATE / LIMITER)
 *   - cold-engine rev guard: until the oil is warm the shift point is pulled down
 *     and climbs with the oil temperature
 *
 * Pages: tach / shift log / learned (what it learned from this car, with resets) / HUD looks (a live
 * preview of the HUD as set up, layouts to tap, an editor: look, items on / off, effects, place;
 * Play on HUD). The tach's
 * peak marker drops back after "Peak hold" seconds; BTN_RESET clears it and the session stats.
 *
 * Experimental parts (README.md in this folder has the whole story):
 *   hud.js       the head-up display through cluster-render, and the shift cue the HUD and this
 *                screen's lights share (count-in over ~1 s of climb, flash early by the reaction
 *                time, ended by the upshift or a lift; everything flashes on the limiter)
 *   hud-draw.js  draws the HUD image: layouts (standard, minimal, split wings), palettes, readouts
 *   limiter.js   learns the real rev limit from the rpm plateau on the limiter
 *   shiftmap.js  learns the full-load torque curve and the gear ratios, and from them the best
 *                upshift rpm for each gear
 *   gearbox.js   gearbox oil temperature for the HUD (EGS over read-only UDS, or BasicDataSet)
 *   cluster_render_client.js  vendored unchanged from robertnisipeanu/idrive-apps (MPL-2.0)
 *
 * The limits, first that has one:
 *   redline     the "Redline" setting > the learned limiter > the engine profile
 *   shift point the per-gear learned point (held 150 under the redline) > redline - "Shift point
 *               before redline"; then "Minimum shift point" as a floor; then the cold guard,
 *               which can lower it below the floor while the oil is cold
 *
 * Rules for this code (the head unit): Node 8 (no ?. ?? object spread, flat, fromEntries); never
 * let an error escape a timer, signal or render (an app that exits gets its data wiped by MainApp,
 * twice: uninstalled); the tach and Learned pages draw on the kit's Recorder (record.js), whose
 * methods differ from canvas.js (no convex/triangle: use quad), the HUD on a Canvas; nothing is
 * learned from the demo drive.
 */
const mgu = require('./kit/mgu');
const { withAlpha, ramp } = require('./kit/canvas');
const G = require('./kit/gauges');
const { plural } = require('./kit/i18n');
const Car = require('./kit/car');
const Engine = require('./kit/engine');
const Hud = require('./hud');
const HudDraw = require('./hud-draw');
const GearboxTemp = require('./gearbox');
const Limiter = require('./limiter');
const ShiftMap = require('./shiftmap');

const W = 1600, H = 520;
// rev bar (G20 style): left to right, slanted segments; top edge shifted right by 'slant'
const BAR = { x0: 400, x1: 1200, y0: 213, y1: 275, slant: 22 };
const GX = 800;                                     // centre column (rpm, bar, gear)
const MPH = 1.609344;
const GREEN = '#2fd27a', YELLOW = '#ffc21a', BLUE = '#2a7dff';
const N_LEDS = 12, LED_RANGE = 2000;
// MDrive.dataDisplayGearbox programmes (names or wire numbers), as in Car Vitals
const PROGRAMS = { S_MINUS_PROGRAMM: 'S', M_MINUS_PROGRAMM: 'M', 1: 'S', 2: 'M' };

/**
 * HUD settings renamed or split, carried over once (the old keys are then dropped from settings.json):
 *   1.18: "Gear on HUD" + "Temperatures on HUD" -> "Shows" (hudContent); "Shift lights on HUD" + its
 *         style -> "Shift lights" (hudLightStyle with 'off');
 *   1.23: "Shows" -> a switch each for the gear and every temperature and the cold limit.
 */
function migrateSettings(settings, log) {
    try {
        const v = settings.values || {};
        if ('hudGear' in v || 'hudTemps' in v || 'hudLights' in v) {
            const gear = v.hudGear !== 'off', temps = v.hudTemps !== false;
            v.hudContent = gear && temps ? 'all' : gear ? 'gear' : temps ? 'temps' : 'tach';
            settings.set('hudLightStyle', v.hudLights === false ? 'off' : v.hudLightStyle === 'bar' ? 'bar' : 'gt3');
            delete v.hudGear; delete v.hudTemps; delete v.hudLights;
        }
        if ('hudContent' in v) {
            const c = v.hudContent, gear = c !== 'temps' && c !== 'tach', temps = c !== 'gear' && c !== 'tach';
            delete v.hudContent;
            ['hudShowOil', 'hudShowWater', 'hudShowGearbox', 'hudShowLimit'].forEach((k) => { v[k] = temps; });
            settings.set('hudShowGear', gear);
            log.info('settings: HUD "Shows ' + c + '" carried over to the readout switches');
        }
    } catch (e) { log.warn('settings migration: ' + e); }
}

mgu.run({
    async start(ctx) {
        const { ui, settings, log } = ctx;
        migrateSettings(settings, log);
        // engine profile (diesel / petrol): rev scale top and the Auto redline / cold limit
        const engine = new Engine({ settings, dataDir: ctx.dataDir, log });
        // gearbox oil temperature for the HUD (EGS over UDS, or BasicDataSet); polled only while the HUD is on
        const gearbox = new GearboxTemp(ctx);
        // engine torque for the shift map, with its time: put() keeps the last value when the signal
        // goes invalid, so a stale torque would be paired with new rpm and inflate the curve
        const torque = { v: null, t: 0 };
        // boost from the iDrive sport display (bar, raw x 0.01, 255 = none), for the HUD; shown only once
        // it has moved (some cars send a constant), as Car Vitals does
        const boost = { v: null, t: 0, first: null, moved: false };
        const gearMode = { v: null, seen: [] };
        const driveMode = { v: null, seen: [] };
        /** 'M' (shifting by hand), 'S', 'D', or null when the car hasn't said (then nothing is held back). */
        const modeNow = () => (gearMode.v && !car.data().demo ? gearMode.v : null);
        // the HUD's extra readouts, as Live Data scales them: g sideways and forward, outside
        // temperature (°C); each { v, t }, used while under 2 s old (outside: 10 min). (The accelerator
        // pedal is left out until its scaling is checked: Live Data's guess read 60-96 % at a light touch.)
        const extra = { gLat: { v: null, t: 0 }, gLong: { v: null, t: 0 }, outside: { v: null, t: 0 } };
        const keep = (e, v) => { e.v = v; e.t = Date.now(); };
        const fresh = (e, ms) => (e.v !== null && Date.now() - e.t < ms ? e.v : null);
        const G0 = 9.80665;
        const torqueWatch = { 'de.bmw.infotainment.drivingexcitement.FES': {
            statusActualValueTorque2: (v) => {
                const raw = v && v.actualValueTorqueCrankshaft;
                if (typeof raw === 'number' && raw < 4095) { torque.v = Math.max(0, raw * 0.5 - 1023.5); torque.t = Date.now(); }
            },
            // the driving mode (Sport / Comfort / Eco Pro), for "In Comfort / Eco Pro" on the HUD
            statusFESVehicleDynamicSwitchHMI: (v) => {
                const raw = v && v.actualValueModeDrivingExperience;
                driveMode.v = Hud.driveModeOf(raw);
                if (driveMode.seen.indexOf(String(raw)) < 0 && driveMode.seen.length < 16) { driveMode.seen.push(String(raw)); log.info('driving mode: ' + JSON.stringify(raw) + ' -> ' + driveMode.v); }
            },
            statusSwitchDriveDynamicSport2: (v) => {
                const raw = v && v.displayBoostPressure;
                if (typeof raw !== 'number' || raw === 255 || raw < 0) return;
                if (boost.first === null) boost.first = raw; else if (raw !== boost.first) boost.moved = true;
                boost.v = raw * 0.01; boost.t = Date.now();
            },
        },
        'de.bmw.infotainment.vehicle.CDS2': {
            statusLateralAccelerationMassCenter: (v) => { const raw = v && v.lateralAccelerationCentreOfGravity; if (typeof raw === 'number' && raw !== 65535) keep(extra.gLat, (raw * 0.002 - 65) / G0); },
            statusLongitudinalAccelerationMassCenter: (v) => { const raw = v && v.longitudinalAccelerationCentreOfGravity; if (typeof raw === 'number' && raw !== 65535) keep(extra.gLong, (raw * 0.002 - 65) / G0); },
        },
        'de.bmw.infrastructure.EnvironmentalInformation': {
            ExteriorTemperature: (v) => { const raw = v && v.temperatureExterior; if (typeof raw === 'number' && raw !== 255) keep(extra.outside, raw * 0.5 - 40); },
        },
        // the gearbox programme the cluster shows by the gear (S / M, else D), as Car Vitals reads it
        'de.bmw.infotainment.misc.MDrive': {
            dataDisplayGearbox: (v) => {
                const raw = v && v.displayProgramGearbox;
                // S / M as Car Vitals reads them; D only from a value that says so (0 or a D... name);
                // anything else is unknown, which holds nothing back
                gearMode.v = PROGRAMS[raw] || (raw === 0 || /^D/i.test(String(raw)) ? 'D' : null);
                if (gearMode.seen.indexOf(String(raw)) < 0 && gearMode.seen.length < 12) { gearMode.seen.push(String(raw)); log.info('gearbox programme: ' + JSON.stringify(raw) + ' -> ' + gearMode.v); }
            },
        } };
        const car = new Car(ctx, ['rpm', 'speed', 'temps', 'gear', 'condition'], Object.assign({ [Engine.SIGNAL[0]]: engine.handlers() }, gearbox.handlers(), torqueWatch));

        /* ---------- derived limits ----------
         * Redline, first that has one: the "Redline" setting, the limit learned from the limiter
         * (limiter.js, setting "learnRedline"), the engine profile. The scale's top follows it. */
        const limiter = new Limiter({ dataDir: ctx.dataDir, log });
        // setting "learn": off freezes all learning (redline, torque curve and ratios, reaction time);
        // what was learned is kept and still used
        const learning = () => settings.get('learn') !== false;
        const manualRedline = () => { const v = settings.get('redline'); return typeof v === 'number' && v > 0 ? v : 0; };
        const learned = () => (settings.get('learnRedline') !== false ? limiter.value() : null);
        const profileRedline = () => Engine.PROFILES[engine.profile()].redline;
        const redlineSource = () => (manualRedline() ? 'manual' : learned() ? 'learned' : 'profile');
        const baseRedline = () => manualRedline() || learned() || engine.redline();
        const maxRpm = () => {
            const s = settings.get('rpmScale');
            return typeof s === 'number' && s > 0 ? s : Math.ceil((baseRedline() + 800) / 1000) * 1000;
        };
        const redline = () => Math.min(baseRedline(), maxRpm());
        settings.onChange((key, v) => { if (key === 'learnRedline' && v === false) limiter.forget(); });
        log.info('redline ' + redline() + ' (' + redlineSource() + ')');
        /* Shift point: per gear from the engine's own torque curve and the gear ratios (shiftmap.js,
         * setting "shiftMode" = learned) once it knows that gear, held 150 under the redline so the
         * shift never meets the limiter; else (and with "fixed") the redline minus "shiftBefore".
         * Never below 2500: shifts under that are not scored. */
        const shiftMap = new ShiftMap({ dataDir: ctx.dataDir, log });
        shiftMap.setRedline(redline());
        const learnedShift = (gear) => {
            if (settings.get('shiftMode') === 'fixed' || !G.isNum(gear) || gear < 1) return null;
            const r = shiftMap.shiftFor(gear);
            return G.isNum(r) ? Math.min(r, redline() - 150) : null;     // clear of the limiter flash (redline - 40)
        };
        const minShift = () => { const v = settings.get('minShift'); return typeof v === 'number' && v > 0 ? Math.min(v, redline() - 150) : 0; };
        const normalShift = (gear) => Math.max(2500, minShift(), learnedShift(gear) || redline() - settings.get('shiftBefore'));
        const shiftSource = (gear) => (learnedShift(gear) ? 'learned' : 'fixed');
        const limitsChanged = () => { car.setRedline(redline()); shiftMap.setRedline(redline()); };
        limitsChanged();
        engine.onChange(limitsChanged);
        limiter.onChange(limitsChanged);
        /** shift point right now for that gear (lowered while the oil is cold). */
        function shiftPoint(oil, gear) {
            const n = normalShift(gear);
            if (!settings.get('coldGuard') || !G.isNum(oil)) return { rpm: n, cold: false };
            const warm = settings.get('warmOil'), cold = Math.min(engine.value('coldLimit', { diesel: 3000, petrol: 4500 }), n);
            if (oil >= warm) return { rpm: n, cold: false };
            const f = G.clamp((oil - 30) / (warm - 30), 0, 1);
            return { rpm: Math.round((cold + (n - cold) * f) / 50) * 50, cold: true };
        }

        /* ---------- session state ---------- */
        // peakRpm = the tach's peak marker: drops back to the current rpm "peakHold" s after the last
        // new peak (0 = until Reset); the shift log's session peaks stay until Reset
        let peakRpm = 0, peakRpmT = 0, sessionRpm = 0, peakSpeed = 0, limiterHits = 0;
        let shifts = [];                    // { at, from, to, rpm, target, verdict }
        const recent = [];                  // [t, rpm, speed] last ~1 s
        let lastGear = null, onLimiter = false, lastShift = null, hud = null;
        const cueState = {};
        let screenCue = null, slowingUntil = 0, lastRpmVal = null, lastRpmChange = 0;

        /*
         * Downshift cue: how many gears (0..3) you can drop now without the revs passing that gear's
         * shift point (300 rpm margin): the rpm after a downshift is the speed times that gear's
         * learned rpm per km/h. Setting "downCue": while slowing (default), always, off.
         */
        function downshift() {
            const mode = settings.get('downCue') || 'slowing', d = car.data();
            if (mode === 'off' || d.demo || !G.isNum(d.gear) || d.gear < 2 || !(d.speed > 10)) return 0;
            if (mode === 'slowing' && Date.now() > slowingUntil) return 0;
            const gm = modeNow();
            if (mode === 'slowing' && (gm === 'D' || gm === 'S')) return 0;
            if (!shiftMap.ratio(d.gear)) return 0;
            let n = 0;
            for (let g = d.gear - 1; g >= 1 && n < 3; g--) {
                const k = shiftMap.ratio(g);
                if (!k || d.speed * k > shiftPoint(d.oil, g).rpm - 300) break;
                n++;
            }
            return n;
        }
        // LIMITER: on the cut itself (25 rpm): shift points sit 150 under the redline, so the old 60 caught
        // shifts on the point
        const verdict = (rpm, target, cold) => (rpm >= redline() - 25 ? 'LIMITER' : rpm < target - 250 ? 'EARLY' : rpm > target + 200 ? (cold ? 'COLD REV' : 'LATE') : 'SPOT ON');
        // only shifts aimed at the shift point are graded: the revs within GRADE_FROM of it (where the
        // shift lights count in) and shifted by hand; the rest are logged as CRUISE (an everyday shift
        // well below the point) or AUTO (the gearbox shifted, in D or S) and left out of the accuracy
        const GRADE_FROM = 1500;
        const gradeOf = (rpm, sp, mode) => (mode === 'D' || mode === 'S' ? 'AUTO' : rpm < sp.rpm - GRADE_FROM ? 'CRUISE' : verdict(rpm, sp.rpm, sp.cold));
        const graded = (s) => s.verdict !== 'CRUISE' && s.verdict !== 'AUTO';
        const VCOL = { 'SPOT ON': GREEN, EARLY: YELLOW, LATE: '#ff8a1a', LIMITER: '#ff2a2a', 'COLD REV': '#3d8bff', CRUISE: '#8a8f98', AUTO: '#8a8f98' };

        function recordShift(t, from, to) {
            const win = recent.filter((r) => t - r[0] < 600);
            const rpm = Math.max.apply(null, win.map((r) => r[1]));
            if (!(rpm > 2500)) return;
            const sp = shiftPoint(car.data().oil, from);
            const gm = modeNow();
            lastShift = { at: Date.now(), from, to, rpm: Math.round(rpm), target: sp.rpm, verdict: gradeOf(rpm, sp, gm), mode: gm };
            if (hud && learning() && !car.data().demo) hud.upshift(rpm);         // never learn from the demo drive
            shifts.unshift(lastShift);
            shifts = shifts.slice(0, 60);
            log.info('shift ' + from + '->' + to + ' @' + lastShift.rpm + ' ' + lastShift.verdict);
        }

        car.onSample((d, t) => {
            if (!G.isNum(d.rpm)) { screenCue = null; Hud.shiftCue(cueState, null, t, 0, 0, 0); return; }
            recent.push([t, d.rpm, d.speed]);
            while (recent.length && t - recent[0][0] > 1200) recent.shift();
            // the screen's shift cue, the same as the HUD's (count-in by climb rate, early flash,
            // lift handling), updated on each sample so a fast screen doesn't see repeated readings
            screenCue = Hud.shiftCue(cueState, d.rpm, t, shiftPoint(d.oil, d.gear).rpm, redline(), hud ? hud.lead() : 200, d.gear);
            // slowing (for the downshift cue): braking, down at least 6 km/h per second (~0.17 g) over
            // the last 0.5 s; coasting off the throttle stays under it
            const back = recent.find((r) => t - r[0] <= 500);
            if (back && G.isNum(back[2]) && G.isNum(d.speed) && t - back[0] >= 300 && (back[2] - d.speed) * 1000 / (t - back[0]) >= 6) slowingUntil = Date.now() + 800;
            const now = Date.now(), hold = settings.get('peakHold') * 1000;
            if (d.rpm >= peakRpm || (hold > 0 && now - peakRpmT > hold)) { peakRpm = d.rpm; peakRpmT = now; }
            sessionRpm = Math.max(sessionRpm, d.rpm);
            if (G.isNum(d.speed)) peakSpeed = Math.max(peakSpeed, d.speed);
            const lim = d.rpm >= redline() - 60;
            if (lim && !onLimiter) limiterHits++;
            onLimiter = lim;
            // learn the real limit (live data only, warm oil): plateaus from 1000 below the profile's redline
            if (!car.data().demo) {
                const tq = Date.now() - torque.t < 300 ? torque.v : null;
                if (learning()) shiftMap.feed(t, { rpm: d.rpm, speed: d.speed, gear: d.gear, torque: tq });
                const pr = profileRedline();
                if (d.rpm !== lastRpmVal) { lastRpmVal = d.rpm; lastRpmChange = Date.now(); }
                const rpmFresh = Date.now() - lastRpmChange < 300;
                if (rpmFresh && learning() && settings.get('learnRedline') !== false) limiter.feed(t, { rpm: d.rpm, gear: d.gear, speed: d.speed, warm: G.isNum(d.oil) && d.oil >= settings.get('warmOil') }, pr - 1000, pr + 1500);
            }

            // upshift: gear number goes up, or (no gear signal) rpm falls >18 % within 0.4 s while still moving
            const g = d.gear;
            if (G.isNum(g) && g > 0 && G.isNum(lastGear) && lastGear > 0 && g === lastGear + 1) recordShift(t, lastGear, g);
            else if (!G.isNum(g) && recent.length > 4 && d.speed > 10) {
                const back = recent.filter((r) => t - r[0] < 400);
                const hi = Math.max.apply(null, back.map((r) => r[1]));
                if (hi > 3000 && d.rpm < hi * 0.82 && (!lastShift || Date.now() - lastShift.at > 800)) recordShift(t, '?', '?');
            }
            if (G.isNum(g)) lastGear = g;
        }, () => { recent.length = 0; lastGear = null; screenCue = null; Object.keys(cueState).forEach((k) => { delete cueState[k]; }); });

        /* ---------- rev bar geometry + static background (cached) ---------- */
        const BW = BAR.x1 - BAR.x0 - BAR.slant, BH = BAR.y1 - BAR.y0;
        const barX = (rpm) => G.clamp(rpm / maxRpm(), 0, 1) * BW;                          // along the bar
        const off = (y) => BAR.slant * (BAR.y1 - y) / BH;                                   // slant at height y
        /** Fill the slanted band between rpm a and b (one anti-aliased quad). */
        function band(cv, a, b, col, pad) {
            pad = pad || 0;
            const xa = BAR.x0 + barX(a), xb = BAR.x0 + barX(b), y0 = BAR.y0 - pad, y1 = BAR.y1 + pad;
            if (xb - xa <= 0) return;
            cv.quad([[xa + off(BAR.y0) - pad, y0], [xb + off(BAR.y0) + pad, y0], [xb + off(BAR.y1) + pad, y1], [xa + off(BAR.y1) - pad, y1]], col);
        }
        /** Slanted 3 px gap at rpm r (segment separator). */
        function gapAt(cv, r, col) {
            const x = BAR.x0 + barX(r);
            cv.quad([[x + off(BAR.y0) - 1.5, BAR.y0], [x + off(BAR.y0) + 1.5, BAR.y0], [x + off(BAR.y1) + 1.5, BAR.y1], [x + off(BAR.y1) - 1.5, BAR.y1]], col);
        }
        /** Static part of the tach page (cached layer; redrawn when the theme / limits change). */
        function background(cv, t, sp) {
            // the shift mark is drawn over it (per gear and cold-oil step: a key each would fill the cache)
            const key = ['redline-bg', settings.get('theme'), maxRpm(), redline()].join('|');
            cv.blit(G.layer(key, W, H, (c) => drawBackground(c, t, sp), cv.textScale), 0, 0);
        }
        function drawBackground(cv, t, sp) {
            cv.clear(t.bg);
            // angular frame lines (the G20's outline) around the centre
            const fl = withAlpha(t.tick, 0.55);
            cv.polyline([[24, 92], [330, 92], [370, 122], [1230, 122], [1270, 92], [1576, 92]], 2, fl);
            cv.polyline([[370, 122], [1230, 122]], 3, withAlpha(t.accent, 0.5));
            cv.polyline([[24, 512], [330, 512], [370, 486], [1230, 486], [1270, 512], [1576, 512]], 2, fl);
            // track, redline part tinted, segment gaps
            band(cv, 0, redline(), t.track);
            band(cv, redline(), maxRpm(), withAlpha(t.crit, 0.3));
            for (let r = 500; r < maxRpm(); r += 500) gapAt(cv, r, t.bg);
            // scale under the bar: ticks every 500, numbers every 1000; shift point + redline marks
            for (let rpm = 0; rpm <= maxRpm(); rpm += 500) {
                const x = BAR.x0 + barX(rpm), major = rpm % 1000 === 0, red = rpm >= redline();
                cv.fillRect(x - (major ? 1.5 : 1), BAR.y1 + 8, major ? 3 : 2, major ? 14 : 8, red ? t.crit : major ? t.text : t.tick);
                if (major) cv.text(String(rpm / 1000), x, BAR.y1 + 46, 26, red ? t.crit : t.text, { align: 'center', font: 'bold' });
            }
            const rx = BAR.x0 + barX(redline());
            cv.fillRect(rx + BAR.slant - 2, BAR.y0 - 14, 4, 12, t.crit);
        }

        /* ---------- drawing ---------- */
        const mph = () => settings.get('speedUnit') === 'mph';
        // temperatures and torque in the units chosen in Settings (the HUD uses the same settings)
        const temp = (c) => (G.isNum(c) && settings.get('hudTempUnit') === 'f' ? c * 9 / 5 + 32 : c);
        const lbft = () => settings.get('hudTorqueUnit') === 'lbft';
        let page = 0;

        function ledColors(t) {
            const st = settings.get('lights');
            return Array.from({ length: N_LEDS }, (_, i) => {
                const f = i / (N_LEDS - 1);
                if (st === 'mono') return t.accent;
                if (st === 'f1') return f < 0.42 ? GREEN : f < 0.84 ? '#ff2a2a' : BLUE;
                return f < 0.42 ? GREEN : f < 0.75 ? YELLOW : '#ff2a2a';
            });
        }

        /** The 12 lights: they count from cue.from to cue.at and strobe while cue.shift (the HUD's cue). */
        function shiftLights(cv, t, rpm, cue, on) {
            const cols = ledColors(t);
            const x0 = GX - 330, w = 660, gap = 10, lw = (w - gap * (N_LEDS - 1)) / N_LEDS, y = 48, h = 30;
            const lit = G.isNum(rpm) && !cue.shift ? Math.ceil(G.clamp((rpm - cue.from) / (cue.at - cue.from), 0, 1) * (N_LEDS - 1)) : 0;
            const strobe = cue.shift;
            for (let i = 0; i < N_LEDS; i++) {
                const x = x0 + i * (lw + gap);
                let c = withAlpha(cols[i], 0.12);
                if (strobe) c = on ? (settings.get('lights') === 'f1' ? BLUE : '#ff2a2a') : withAlpha('#ff2a2a', 0.15);
                else if (i < lit) c = cols[i];
                if ((strobe && on) || (!strobe && i < lit)) cv.roundRect(x - 4, y - 4, lw + 8, h + 8, 10, withAlpha(c, 0.25));
                cv.roundRect(x, y, lw, h, 7, c);
            }
            return strobe;
        }

        // shift blink (setting "flash"): in software it alternates every frame, so it always
        // shows (a clock-based phase could land on 'off' frame after frame)
        let blink = false;

        function drawTach(cv, t, d, now) {
            const sp = shiftPoint(d.oil, d.gear);
            background(cv, t, sp);
            const sx = BAR.x0 + barX(sp.rpm);                                                   // shift point mark
            cv.fillRect(sx + BAR.slant - 2, BAR.y0 - 14, 4, 12, t.warn);
            const rpm = d.rpm;
            // the cue from the last sample; before any sample, the plain shift point
            const cue = screenCue || Hud.shiftCue({}, rpm, now, sp.rpm, redline(), 0);
            const shiftNow = G.isNum(rpm) && cue.shift;
            // setting "flash" on: lights, gear and SHIFT blink (GPU renderer: 8 Hz clock phase;
            // software, few fps: alternate every frame) and the screen flashes red. Off: they
            // just turn solid red at the shift point, nothing blinks.
            const flash = settings.get('flash');
            blink = shiftNow && flash ? (ctx.display.active() ? Math.floor(now / 62) % 2 === 0 : !blink) : false;
            const redNow = shiftNow && (!flash || blink);
            shiftLights(cv, t, rpm, cue, redNow);
            if (shiftNow && flash && blink) {
                cv.gradientRect(0, 0, W, H, [[0, withAlpha(t.crit, 0.55)], [0.5, withAlpha(t.crit, 0.22)], [1, withAlpha(t.crit, 0.5)]]);
                const fr = withAlpha('#ff2a2a', 0.9);                                            // red frame
                cv.fillRect(0, 0, W, 8, fr); cv.fillRect(0, H - 8, W, 8, fr); cv.fillRect(0, 8, 8, H - 16, fr); cv.fillRect(W - 8, 8, 8, H - 16, fr);
            }

            // ---- rev bar: left to right; theme colour -> red at the shift point, solid red above.
            // Each 500 rpm segment takes the colour of its position (stepped like the G20).
            const hot = t.hotRamp || t.ramp;
            if (G.isNum(rpm) && rpm > 50) {
                const colOf = (r) => (shiftNow ? '#ff2a2a' : ramp(hot, G.clamp(r / sp.rpm, 0, 1)));
                band(cv, 0, rpm, withAlpha(colOf(rpm), 0.14), 7);                               // glow
                const top = Math.min(rpm, maxRpm());                                           // a garbage rpm stays one bar
                for (let r = 0; r < top; r += 500) band(cv, r, Math.min(top, r + 500), colOf(r + 250));
                for (let r = 500; r < top; r += 500) gapAt(cv, r, t.bg);
                const x = BAR.x0 + barX(rpm);
                cv.line(x, BAR.y1 + 4, x + BAR.slant, BAR.y0 - 4, 6, '#ffffff');               // bright leading edge
            }
            // peak: a slanted line across the bar at the highest rpm (no line along the top on the tach)
            if (peakRpm > 0 && !(G.isNum(rpm) && rpm >= peakRpm)) {
                const pk = Math.min(peakRpm, maxRpm()), px = BAR.x0 + barX(pk);
                const pc = t.hang || (pk >= sp.rpm ? '#ff2a2a' : ramp(hot, G.clamp(pk / sp.rpm, 0, 1)));
                cv.line(px + BAR.slant, BAR.y0, px, BAR.y1, 3, pc);
            }

            // ---- centre: digital rpm above the bar, gear below it
            const rw = cv.text(G.isNum(rpm) ? String(Math.round(rpm / 10) * 10) : '----', GX - 30, 198, 80, G.isNum(rpm) ? (shiftNow ? '#ff4a4a' : t.text) : t.dim, { align: 'center', font: 'num' });
            cv.text('RPM', GX - 30 + rw / 2 + 12, 198, 22, t.dim, { font: 'bold', spacing: 2 });
            // gear number when driving; the selector position (P / R / N, D while no gear is engaged)
            // otherwise - the gear field alone reads "N" in park too
            const g = d.gear, st = d.stage;
            const gs = st === 'P' || st === 'R' || st === 'N' ? st : g === -1 ? 'R' : G.isNum(g) && g > 0 ? String(g) : st === 'D' ? 'D' : g === 0 ? 'N' : '-';
            cv.text(gs, GX, 500, 200, redNow ? '#ff2a2a' : t.text, { align: 'center', font: 'gear' });
            Hud.drawDown(cv, GX + 120, 470, downshift(), 2);                                // downshift cue
            if (d.gearGuessed && G.isNum(g) && g > 0) cv.text('EST.', GX + 90, 352, 22, t.dim, { font: 'bold', spacing: 1 });
            if (shiftNow) cv.text('SHIFT', GX + 150, 436, 30, redNow ? '#ff2a2a' : withAlpha('#ff2a2a', 0.5), { font: 'bold', spacing: 3 });

            // ---- left: digital speed, temperatures, cold oil, stats
            const spd = G.hold('speed', d.speed, 1000 / settings.get('speedRate'));     // setting: 10/s by default, 5 like the cluster .. 60
            const v = G.isNum(spd) ? (mph() ? spd / MPH : spd) : null;
            cv.text('SPEED', 40, 156, 22, t.dim, { font: 'bold', spacing: 1.5 });
            const vw = cv.text(G.fmt(v, 0), 36, 276, 116, G.isNum(v) ? t.text : t.dim, { font: 'num' });
            cv.text(mph() ? 'mph' : 'km/h', 46 + vw, 276, 26, t.dim);
            cv.fillRect(40, 298, 300, 1, withAlpha(t.tick, 0.6));
            const warm = settings.get('warmOil'), coldOil = G.isNum(d.oil) && d.oil < warm;
            const oilCol = !G.isNum(d.oil) ? t.dim : d.oil < 60 ? t.cold : coldOil ? YELLOW : d.oil > 130 ? t.crit : t.text;
            cv.text('OIL', 40, 334, 22, t.dim, { font: 'bold', spacing: 1.5 });
            cv.text(G.fmt(temp(d.oil), 0) + (G.isNum(d.oil) ? '°' : ''), 40, 376, 40, oilCol, { font: 'bold' });
            cv.text('WATER', 190, 334, 22, t.dim, { font: 'bold', spacing: 1.5 });
            cv.text(G.fmt(temp(d.coolant), 0) + (G.isNum(d.coolant) ? '°' : ''), 190, 376, 40, t.text, { font: 'bold' });
            // cold oil is always shown: with the guard on it also lowers the shift point
            if (coldOil) {
                cv.roundRect(40, 392, 300, 36, 8, withAlpha(t.cold, 0.2));
                cv.text(sp.cold ? 'COLD  ·  LIMIT ' + sp.rpm : 'OIL COLD  ·  GO EASY', 190, 418, 22, t.cold, { align: 'center', font: 'bold', spacing: 0.5 });
            }
            cv.text('PEAK ' + (peakRpm ? Math.round(peakRpm) : '--') + '  ·  LIMITER ' + limiterHits + 'x', 40, 476, 22, t.dim, { font: 'bold', spacing: 0.5 });

            // ---- right: shift point + last shift
            const rx = W - 40;
            cv.text('SHIFT AT', rx, 156, 22, t.dim, { align: 'right', font: 'bold', spacing: 1.5 });
            cv.text(String(sp.rpm), rx, 222, 64, sp.cold ? t.cold : t.text, { align: 'right', font: 'num' });
            cv.fillRect(W - 340, 298, 300, 1, withAlpha(t.tick, 0.6));
            cv.text('LAST SHIFT', rx, 334, 22, t.dim, { align: 'right', font: 'bold', spacing: 1.5 });
            if (lastShift) {
                const age = now - lastShift.at, vc = VCOL[lastShift.verdict];
                const lw2 = cv.text(String(lastShift.rpm), rx, 386, 52, t.text, { align: 'right', font: 'num' });
                if (lastShift.from !== '?') cv.text(lastShift.from + ' > ' + lastShift.to, rx - lw2 - 14, 386, 22, t.dim, { align: 'right', font: 'bold' });
                cv.roundRect(rx - 200, 404, 200, 38, 8, withAlpha(vc, age < 2500 ? 0.45 : 0.18));
                cv.text(lastShift.verdict, rx - 100, 431, 22, age < 2500 ? t.text : vc, { align: 'center', font: 'bold', spacing: 1 });
            } else cv.text('--', rx, 386, 52, t.dim, { align: 'right', font: 'num' });
        }

        function drawLog(cv, t) {
            const lp = G.panel(cv, t, 24, 44, 760, 468, 'Recent upshifts');
            G.button(cv, t, 784 - 20 - 180, 56, 180, 40, 'Reset max', resetMax, { key: 'reset', confirm: true });
            // room below the page (where the kit gives it): another row where one fits whole
            const up = shifts.slice(0, 9 + Math.floor((lp.y + lp.h - G.BOTTOM) / 41));
            if (!up.length) cv.text('No shifts yet - go and use the rev range.', 48, 189, 26, t.dim);
            up.forEach((s, i) => {
                const y = 135 + i * 41;
                const d = new Date(s.at), p = (n) => String(n).padStart(2, '0');
                cv.text(p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()), 48, y, 22, t.dim);
                cv.text(s.from === '?' ? 'upshift' : s.from + ' > ' + s.to, 200, y, 26, t.text, { font: 'bold' });
                cv.text(String(s.rpm), 470, y, 28, t.text, { align: 'right', font: 'num' });
                cv.text('/ ' + s.target, 480, y, 22, t.dim);
                cv.roundRect(590, y - 26, 170, 34, 7, withAlpha(VCOL[s.verdict], 0.25));
                cv.text(s.verdict, 675, y - 1, 22, VCOL[s.verdict], { align: 'center', font: 'bold', spacing: 0.5 });
            });

            const ap = G.panel(cv, t, 808, 44, 768, 468, 'Shift accuracy');
            const pitch = 46 + (ap.y + ap.h - G.BOTTOM) / 4;          // the bars spread over a taller panel
            // accuracy from the graded shifts only (CRUISE / AUTO are in the log, not in the score)
            const aimed = shifts.filter(graded), n = aimed.length;
            const cnt = (v) => aimed.filter((s) => s.verdict === v).length;
            const spot = cnt('SPOT ON');
            cv.text(n ? Math.round(spot / n * 100) + '%' : '--', 832, 199, 96, n ? GREEN : t.dim, { font: 'num' });
            cv.text('SPOT ON  (' + n + ' graded)', 836, 235, 22, t.dim, { font: 'bold', spacing: 1 });
            ['EARLY', 'SPOT ON', 'LATE', 'COLD REV', 'LIMITER'].forEach((v, i) => {
                const y = 276 + Math.round(i * pitch), c = cnt(v), f = n ? c / n : 0;
                cv.text(v, 836, y + 22, 22, VCOL[v], { font: 'bold', spacing: 1 });
                cv.roundRect(990, y + 2, 460, 26, 6, t.track);
                if (f > 0) cv.roundRect(990, y + 2, Math.max(12, 460 * f), 26, 6, VCOL[v]);
                cv.text(String(c), 1540, y + 24, 26, t.text, { align: 'right', font: 'num' });
            });
            // scatter: shift rpm vs target
            if (n) {
                const ys = aimed.slice(0, 30).map((s) => s.rpm - s.target);
                const avg = ys.reduce((a, b) => a + b, 0) / ys.length;
                cv.text('AVG ' + (avg >= 0 ? '+' : '') + Math.round(avg) + ' rpm vs shift point', 1240, 199, 24, t.text, { align: 'center', font: 'bold' });
                cv.text('PEAK ' + Math.round(sessionRpm) + ' RPM  ·  ' + G.fmt(mph() ? peakSpeed / MPH : peakSpeed, 0) + (mph() ? ' MPH' : ' KM/H'), 1240, 235, 22, t.dim, { align: 'center', font: 'bold', spacing: 0.5 });
            }
        }

        /* ---------- Learned page: what Redline has learned from this car, each with a reset ---------- */
        /* ---------- HUD looks page: a live preview of the HUD as set up, and every look to pick by picture ----------
         * Left: the HUD at twice its size playing the scripted drive (hud.js demoAt: count-in, flash, a
         * shift graded in turn spot on / early / late, the limiter, braking with the downshift cue),
         * drawn by the HUD's own code with the current settings, so a change shows in it at once.
         * Right: the six layouts, small; tap one to use it. Under them: colours, shift lights, the grade,
         * peak and shake, each a row of buttons. "Play on HUD" runs the same drive on the glass. */
        const LOOKS = [['standard', 'Standard'], ['minimal', 'Minimal'], ['wings', 'Split wings'],
            ['digital', '80s digital dash'], ['vfd', 'VFD glow'], ['vector', 'Vector arcade']];
        const studio = { cue: {}, t0: Date.now(), panel: 'readouts' };
        /** The preview's frame at now: what frameData would give the HUD for the scripted drive. */
        function studioFrame(now) {
            const o = Hud.optsFrom(settings), t = now - studio.t0, dm = Hud.demoAt(t);
            const d = { rpm: dm.rpm, gear: dm.gear, stage: dm.stage, oil: dm.oil, coolant: dm.coolant };
            const cue = Hud.shiftCue(studio.cue, dm.rpm, now, dm.shift, 6550, hud ? hud.lead() : 200, dm.gear);
            const blink = cue.shift || cue.limiter ? Math.floor(now / 100) % 2 === 0 : true;
            return {
                d: d, shift: dm.shift, redline: 6550, max: 8000, blink: blink, cue: cue, down: dm.down,
                peak: o.peak ? dm.peak : 0,
                chip: dm.chip && o.chip !== 'off' && dm.chipAge < 1500 ? { verdict: dm.chip.verdict, age: dm.chipAge, burst: o.chip === 'burst' } : null,
                shake: o.shake && cue.limiter ? [[2, 1], [-2, -1], [1, -1], [-1, 1]][Math.floor(now / 100) % 4] : null,
                readouts: Hud.readoutsFor(d, dm.gearbox, dm.boost, { rpm: dm.shift, cold: false }, o, dm),
                mode: o.mode ? dm.mode : null, opts: o,
            };
        }
        /** A small still of a layout for its tile (cached per look and the settings that change it). */
        function lookLayer(style) {
            const o = Hud.optsFrom(settings);
            const key = ['hudlook2', style, o.palette, o.lights, o.gt3, o.dim, o.lightStyle, o.gear, o.peak, o.bar, o.rpm].join('|');
            return G.layer(key, HudDraw.IW / 2, HudDraw.IH / 2, (r) => {
                r.fillRect(0, 0, HudDraw.IW / 2, HudDraw.IH / 2, '#000000');
                HudDraw.drawLayer(HudDraw.scaled(r, 0.5, 0, 0), {
                    d: { rpm: 5000, gear: 3, stage: 'D' }, shift: 5550, redline: 6550, max: 8000, blink: true, down: 0, peak: o.peak ? 6100 : 0, chip: null,
                    cue: { from: 4050, at: 5550, shift: false, limiter: false }, readouts: [{ label: 'BOOST', value: '1.2', tone: 'text' }],
                    opts: Object.assign({}, o, { style: style }),
                });
            });
        }
        /** One row of choice buttons: label, then [value, text] options; the current one filled. */
        function choiceRow(cv, t, y, label, key, cur, options, disabled, x0) {
            cv.text(label, x0 ? x0 : 40, y + 27, 18, t.dim, { font: 'bold', spacing: 1 });
            let x = x0 ? x0 + 120 : 200;
            options.forEach((op) => {
                const w = G.button(cv, t, x, y, 0, 40, op[1], () => { settings.set(key, op[0]); return render(); },
                    { key: 'studio_' + key + '_' + op[0], primary: op[0] === cur, busy: disabled });
                x += (w || 160) + 12;
            });
        }
        function drawLooks(cv, t) {
            const now = Date.now(), o = Hud.optsFrom(settings);
            const on = settings.get('hud') === 'on' || settings.get('hud') === 'test';
            // the live preview, twice the HUD's size, on black like the glass
            const px = 32, py = 56, f = studioFrame(now), sh = f.shake ? f.shake : [0, 0];
            cv.roundRect(24, 48, 816, 276, 12, '#000000');
            HudDraw.drawLayer(HudDraw.scaled(cv, 2, px + sh[0] * 2, py + sh[1] * 2), f);
            const playing = hud && hud.playing();
            // switched on but cluster-render isn't there: say where to get it
            const missing = on && hud && /not running/.test(hud.status());
            cv.text(missing ? 'The HUD needs cluster-render: install Cluster renderer from the MGU Store' : on ? (playing ? 'Playing on the HUD...' : 'Your HUD as set up: change it below') : 'Show on HUD is off (Settings): the preview still shows your setup',
                40, 344, 18, on && !missing ? t.dim : t.warn, { font: 'bold' });
            // only while the HUD shows and the car stands still (it replaces the real lights on the glass)
            const still = !(car.data().speed > 3);
            if (hud && (playing || (hud.status() === 'HUD: on' && still))) {
                G.button(cv, t, 600, 316 + 8, 220, 40, playing ? 'Stop' : 'Play on HUD', () => { if (playing) hud.stopPlay(); else if (!(car.data().speed > 3)) hud.play(); return render(); }, { key: 'studio_play', primary: !playing });
            } else if (hud && hud.status() === 'HUD: on') cv.text('Stop the car to play it on the HUD', 820, 344, 16, t.dim, { align: 'right' });
            // the six layouts, small, to tap
            LOOKS.forEach((l, i) => {
                const x = 864 + (i % 2) * 360, y = 48 + Math.floor(i / 2) * 94, w = 348, h = 86, sel = l[0] === o.style;
                cv.roundRect(x, y, w, h, 10, withAlpha('#ffffff', 0.05));
                if (sel) cv.strokeRoundRect(x, y, w, h, 10, 3, t.accent);
                cv.blit(lookLayer(l[0]), x + 8, y + 10);
                cv.text(l[1], x + 218, y + 38, 18, sel ? t.text : t.dim, { font: 'bold' });
                if (sel) cv.text('in use', x + 218, y + 62, 16, t.accent, { font: 'bold' });
                cv.target(x, y, w, h, () => { settings.set('hudStyle', l[0]); return render(); }, 'look_' + l[0]);
            });
            // the editor under the preview: tabs, then that panel's buttons
            // category tabs: text with an underline on a divider (like the page tabs), not pills, so they
            // read as categories and the pills below as the things you change
            const panels = [['look', 'LOOK'], ['gauge', 'GAUGE'], ['readouts', 'READOUTS'], ['effects', 'EFFECTS'], ['place', 'PLACE']];
            cv.fillRect(24, 398, 1552, 1, withAlpha(t.tick, 0.6));
            let tx = 40;
            panels.forEach((pn) => {
                const sel = studio.panel === pn[0], w = cv.textWidth(pn[1], 20, { font: 'bold', spacing: 2 });
                cv.text(pn[1], tx, 388, 20, sel ? t.text : t.dim, { font: 'bold', spacing: 2 });
                if (sel) cv.fillRect(tx - 4, 395, w + 8, 4, t.accent);
                cv.target(tx - 16, 356, w + 32, 46, () => { studio.panel = pn[0]; return render(); }, 'studio_tab_' + pn[0]);
                tx += w + 56;
            });
            const nOn = [o.rpm && o.style !== 'digital' && o.style !== 'vfd', o.boost, o.torque, o.power, o.g, o.oil, o.coolant, o.gearbox, o.outside].filter(Boolean).length;
            const over = studio.panel === 'readouts' && nOn > Hud.MAX_READOUTS;
            cv.text(over ? nOn + ' on: the first ' + Hud.MAX_READOUTS + ' that have a value show (temperatures only when cold or hot)' : STUDIO_HINT[studio.panel], 1576, 388, 16, over ? t.warn : t.dim, { align: 'right' });
            if (studio.panel === 'look') {
                choiceRow(cv, t, 414, 'COLOURS', 'hudPalette', o.palette, [['colour', 'Colour'], ['amber', 'Night amber'], ['ice', 'Ice white']], o.style === 'vfd');
                // temperatures only while cold, warming or hot (invisible at operating temperature), or always
                // what the HUD does in Comfort and Eco Pro (Sport always shows all of it)
                choiceRow(cv, t, 414, 'COMFORT', 'hudComfort', settings.get('hudComfort') || 'all', [['all', 'Show all'], ['lights', 'Lights + gear'], ['hide', 'Hide']], false, 720);
                choiceRow(cv, t, 462, 'TEMPS', 'hudTempsMode', o.smartTemps ? 'smart' : 'always', [['smart', 'Hide at operating temp'], ['always', 'Always show']]);
                choiceRow(cv, t, 462, 'LABELS', 'hudLabels', o.clearLabels ? 'clear' : 'normal', [['normal', 'Normal'], ['clear', 'Clearer']], false, 720);
            } else if (studio.panel === 'gauge') {
                // the gauge's parts; tap to add or remove
                switches(cv, t, 414, 'GAUGE', [
                    ['Rev bar', o.bar, () => settings.set('hudShowBar', !o.bar)],
                    ['Shift lights', o.lights, () => settings.set('hudLightStyle', o.lights ? 'off' : 'gt3')],
                    ['Gear', o.gear, () => settings.set('hudShowGear', !o.gear)],
                    ['Gear mode (D/S/M)', o.mode, () => settings.set('hudShowMode', !o.mode)],
                ]);
                choiceRow(cv, t, 462, 'LIGHTS', 'hudLightStyle', o.lights ? (o.gt3 ? 'gt3' : 'bar') : 'off', [['gt3', 'GT3 (outside in)'], ['bar', 'Left to right']], !o.lights);
            } else if (studio.panel === 'readouts') {
                // the numbers under the bar, in this order; up to four show
                switches(cv, t, 414, 'ENGINE', [
                    ['RPM readout', o.rpm, () => settings.set('hudShowRpm', !o.rpm)],
                    ['Boost', o.boost, () => settings.set('hudBoost', !o.boost)],
                    ['Torque', o.torque, () => settings.set('hudShowTorque', !o.torque)],
                    ['Power', o.power, () => settings.set('hudShowPower', !o.power)],
                    ['G-force', o.g, () => settings.set('hudShowG', !o.g)],
                ]);
                switches(cv, t, 462, 'TEMPS', [
                    ['Oil temp', o.oil, () => settings.set('hudShowOil', !o.oil)],
                    ['Water temp', o.coolant, () => settings.set('hudShowWater', !o.coolant)],
                    ['Gearbox temp', o.gearbox, () => settings.set('hudShowGearbox', !o.gearbox)],
                    ['Outside temp', o.outside, () => settings.set('hudShowOutside', !o.outside)],
                    ['Cold-engine limit', o.limit, () => settings.set('hudShowLimit', !o.limit)],
                ]);
            } else if (studio.panel === 'effects') {
                // what happens on the HUD around a shift: the grade, the peak line, the arrows, the shake
                choiceRow(cv, t, 414, 'GRADE', 'hudChip', o.chip, [['burst', 'Burst'], ['simple', 'Simple'], ['off', 'Off']]);
                choiceRow(cv, t, 414, 'ARROWS', 'downCue', settings.get('downCue') || 'slowing', [['slowing', 'When braking'], ['always', 'Always'], ['off', 'Off']], false, 720);
                switches(cv, t, 462, 'MORE', [
                    ['Peak marker', o.peak, () => settings.set('hudPeak', !o.peak)],
                    ['Limiter shake', o.shake, () => settings.set('hudShake', !o.shake)],
                ]);
            } else {
                // size and position, a step at a time through each setting's own steps (live on the glass)
                cv.text('SIZE', 40, 414 + 27, 18, t.dim, { font: 'bold', spacing: 1 });
                stepButtons(cv, t, 200, 414, 'hudSize', [['Smaller', -1], ['Bigger', 1]], (v) => v + ' %');
                cv.text('MOVE', 40, 462 + 27, 18, t.dim, { font: 'bold', spacing: 1 });
                stepButtons(cv, t, 200, 462, 'hudX', [['Left', -1], ['Right', 1]], (v) => (v === 0 ? 'centre' : (v > 0 ? '+' : '') + v + ' px'));
                stepButtons(cv, t, 700, 462, 'hudY', [['Up', -1], ['Down', 1]], (v) => (v === 0 ? 'default' : (v > 0 ? '+' : '') + v + ' px'));
                G.button(cv, t, 1200, 462, 160, 40, 'Reset', () => { settings.set('hudSize', 100); settings.set('hudX', 0); settings.set('hudY', 0); return render(); }, { key: 'studio_place_reset' });
            }
        }
        const STUDIO_HINT = {
            look: 'Comfort / Eco Pro: all, only lights + gear, or hidden; Sport always shows all',
            gauge: 'Tap to add or remove; turn everything else off for just the lights',
            readouts: 'Up to four show, in this order; a cold or hot one keeps its place. Units: Settings',
            effects: 'Grade after an upshift, downshift arrows, peak line, limiter shake',
            place: 'Moves the HUD on the glass at once',
        };
        /**
         * On / off switches at y, after a section label: [label, on, flip]. Drawn as switches, not like
         * the choice buttons: a green LED dot lit when on (an empty ring when off), the chip tinted and
         * outlined bright when on, dim when off, so on / off reads at a glance.
         */
        const SWITCH_ON = '#2ee66b';
        function switches(cv, t, y, label, list) {
            cv.text(label, 40, y + 27, 18, t.dim, { font: 'bold', spacing: 1 });
            let x = 200;
            list.forEach((c, i) => {
                const on = !!c[1], txt = c[0], w = cv.textWidth(txt, 18, { font: 'bold' }) + 64, h = 40;
                if (on) cv.roundRect(x, y, w, h, h / 2, withAlpha(t.accent, 0.16));
                cv.strokeRoundRect(x, y, w, h, h / 2, 2, on ? t.accent : withAlpha('#ffffff', 0.3));
                // the dot is a little LED: lit green when on, an empty ring when off
                if (on) { cv.circle(x + 22, y + h / 2, 11, withAlpha(SWITCH_ON, 0.25)); cv.circle(x + 22, y + h / 2, 7, SWITCH_ON); } else cv.arc(x + 22, y + h / 2, 5.5, 7.5, 0, 360, withAlpha('#ffffff', 0.45));
                cv.text(txt, x + 40, y + 27, 18, on ? t.text : t.dim, { font: 'bold' });
                cv.target(x, y, w, h, () => { c[2](); return render(); }, 'studio_sw_' + y + '_' + i);
                x += w + 12;
            });
        }
        /** Buttons that step a number setting through its "steps" (−1 / +1), with the value between. */
        function stepButtons(cv, t, x, y, key, buttons, fmt) {
            const it = settings.item(key), steps = (it && it.steps) || [], cur = settings.get(key);
            const i = Math.max(0, steps.indexOf(cur));
            const go = (d) => { const j = Math.max(0, Math.min(steps.length - 1, i + d)); settings.set(key, steps[j]); return render(); };
            const w0 = G.button(cv, t, x, y, 0, 40, buttons[0][0], () => go(buttons[0][1]), { key: 'studio_step_' + key + '_a', busy: i <= 0 });
            cv.text(fmt(steps.length ? steps[i] : cur), x + (w0 || 120) + 70, y + 27, 18, t.text, { align: 'center', font: 'bold' });
            G.button(cv, t, x + (w0 || 120) + 140, y, 0, 40, buttons[1][0], () => go(buttons[1][1]), { key: 'studio_step_' + key + '_b', busy: i >= steps.length - 1 });
        }

        let learnedView = null;
        function drawLearned(cv, t) {
            // torque curve (full load), from the car's torque signal
            const cp = G.panel(cv, t, 24, 44, 760, 468, 'Torque curve (full load)');
            G.button(cv, t, 784 - 20 - 150, 56, 150, 40, 'Reset', () => { shiftMap.forget(); learnedView = null; return render(); }, { key: 'resetMap', confirm: true, color: t.warn });
            // the learned data changes every few seconds at most: read it once a second, not per frame
            if (!learnedView || Date.now() - learnedView.t > 1000) learnedView = { t: Date.now(), pts: shiftMap.curve(), table: shiftMap.table() };
            const tk = lbft() ? 0.737562 : 1;
            const pts = learnedView.pts.filter((p) => p[0] >= 1000 && p[0] <= maxRpm()).map((p) => [p[0], p[1] * tk]), top = pts.reduce((m, p) => Math.max(m, p[1]), 0);
            G.chart(cv, t, 44, 116, 720, Math.max(200, cp.y + cp.h - 136), {
                xMin: 1000, xMax: maxRpm(), xStep: 1000, xFmt: (v) => String(v / 1000), xUnit: 'x1000 rpm',
                yMin: 0, yMax: Math.max(100, Math.ceil(top / 100) * 100 + 50), yUnit: lbft() ? 'lb-ft' : 'Nm', padTop: 22,
                series: pts.length ? [{ pts: pts, color: t.accent, width: 3 }] : [],
                empty: 'Nothing yet: full-throttle pulls, a few from low rpm, fill it in',
            });

            // shift points and gear ratios, the redline and the reaction time
            G.panel(cv, t, 808, 44, 768, 468, 'Shift points');
            G.button(cv, t, 1576 - 20 - 170, 56, 170, 40, 'Reset all', () => { shiftMap.forget(); limiter.forget(); if (hud) hud.resetLead(); learnedView = null; return render(); }, { key: 'resetAll', confirm: true, color: t.warn });
            const table = learnedView.table;
            let y = 130;
            cv.text('GEAR', 836, y, 18, t.dim, { font: 'bold', spacing: 1 });
            cv.text('SHIFT AT', 1080, y, 18, t.dim, { align: 'right', font: 'bold', spacing: 1 });
            cv.text('RPM PER KM/H', 1300, y, 18, t.dim, { align: 'right', font: 'bold', spacing: 1 });
            for (let g = 1; g <= 7; g++) {
                y += 32;
                const k = shiftMap.ratio(g), pr = shiftMap.ratioProgress(g), at = table[g];
                cv.text(g + ' > ' + (g + 1), 836, y, 22, t.text, { font: 'bold' });
                // the point in use: learned, held under the redline and over the minimum (warm oil)
                cv.text(G.isNum(at) ? String(normalShift(g)) : '--', 1080, y, 24, G.isNum(at) ? t.text : t.dim, { align: 'right', font: 'num' });
                cv.text(k ? k.toFixed(1) : pr.n ? 'learning ' + pr.n + '/' + pr.of : '--', 1300, y, k ? 22 : 18, k ? t.text : t.dim, { align: 'right', font: k ? 'num' : 'bold' });
            }
            // no shift point yet though ratios are known: the curve has to reach the redline
            if (!Object.keys(table).length && shiftMap.ratio(1)) { cv.text('Shift points need full-throttle pulls up to the redline (' + redline() + ')', 836, y + 26, 15, t.dim); y += 18; }
            const lim = limiter.value(), lead = hud ? hud.learned() : null;
            y += 46;
            cv.fillRect(836, y - 30, 712, 1, withAlpha(t.tick, 0.6));
            cv.text('REDLINE', 836, y, 20, t.dim, { font: 'bold', spacing: 1 });
            cv.text(redline() + ' rpm  ·  ' + redlineSource(), 990, y, 20, t.text, { font: 'bold' });
            if (!lim && !manualRedline() && settings.get('learnRedline') !== false) {
                const p = limiter.waiting();
                cv.text(p ? '1 of 2 limiter hits seen (' + p + ' rpm): one more, held half a second, oil warm'
                    : 'learns after two hits of the limiter, each held half a second, oil warm', 990, y + 20, 15, p ? t.text : t.dim);
            }
            G.button(cv, t, 1576 - 20 - 120, y - 28, 120, 36, 'Reset', () => { limiter.forget(); return render(); }, { key: 'resetRedline', confirm: true, color: t.warn });
            y += 46;
            cv.text('REACTION', 836, y, 20, t.dim, { font: 'bold', spacing: 1 });
            cv.text(lead ? lead.ms + ' ms early  ·  ' + (lead.auto ? 'learned from ' + lead.shifts + ' shifts' : 'set by hand') : '--', 990, y, 20, t.text, { font: 'bold' });

            G.button(cv, t, 1576 - 20 - 120, y - 28, 120, 36, 'Reset', () => { if (hud) hud.resetLead(); return render(); }, { key: 'resetLead', confirm: true, color: t.warn });
            // what the head-up display is doing (while it is switched on), and frozen learning
            const hs = hud ? hud.status() : '';
            // one line under the rows: a pressed bar reset, the HUD, frozen learning
            const notes = [resetArmed() ? 'Press Reset learned again to forget it all' : '', hs, learning() ? '' : 'Learning off: values kept'].filter(Boolean);
            if (notes.length) cv.text(notes.join('   ·   '), 836, Math.min(500, y + 32), 16, notes.some((n) => /off|not|again/i.test(n)) ? t.warn : t.dim, { font: 'bold' });
        }

        /** G20-style frame: tab bar with the page names along the top. */
        function header(cv, t, d) {
            G.frame(cv, t, ['Tach', 'Shift log', 'Learned', 'HUD looks'], page, [d.demo && { text: 'DEMO' }]);
        }

        async function render() {
            const t = ctx.theme(), d = car.data(), now = Date.now();
            let cv;
            cv = ctx.canvas(W, H).clear(t.bg);
            if (page === 0) drawTach(cv, t, d, now); else if (page === 1) drawLog(cv, t); else if (page === 2) drawLearned(cv, t); else drawLooks(cv, t);
            header(cv, t, d);
            await ui.image('MAIN_GFX', cv);
        }

        /* ---------- buttons ---------- */
        const PAGES = 4;
        const flip = () => { page = (page + 1) % PAGES; return render(); };
        const flipBack = () => { page = (page + PAGES - 1) % PAGES; return render(); };
        ui.onClick('BTN_PAGE', flip);
        ui.onClick('BTN_PREV', flipBack);
        ctx.onTab((i) => { if (i !== page && i >= 0 && i < PAGES) { page = i; return render(); } return null; });
        // Reset max: on the Shift log page, or the bar's button
        function resetMax() {
            peakRpm = 0; peakRpmT = 0; sessionRpm = 0; peakSpeed = 0; limiterHits = 0; shifts = []; lastShift = null;
            log.info('peaks reset'); return render();
        }
        ui.onClick('BTN_RESET', resetMax);
        // where the HMI draws the bar (software renderer) the Learned page has no buttons: this bar
        // button forgets everything learned, on a second press within 5 s
        let resetLearnAt = 0;
        const resetArmed = () => Date.now() - resetLearnAt < 5000;
        ui.onClick('BTN_RESET_LEARNED', () => {
            if (!resetArmed()) { resetLearnAt = Date.now(); page = 2; return render(); }
            resetLearnAt = 0; shiftMap.forget(); limiter.forget(); if (hud) hud.resetLead(); learnedView = null;
            log.info('learned data reset from the bar button');
            return render();
        });
        ctx.hideButton('BTN_RESET_LEARNED');
        ctx.hideButton('BTN_RESET');
        // every screen refresh (60 fps) with the GPU renderer; 15 fps in software (PNG frames)
        ctx.loop('MAIN', 15, render);
        // head-up display through cluster-render (setting "hud"); the centre screen is unchanged
        hud = Hud.start(ctx, {
            data: () => car.data(), shiftPoint, redline, maxRpm, gearbox, downshift,
            // the tach's peak marker (drops back after "Peak hold"), the last upshift's grade for 1.5 s,
            // boost once it has moved and is under 2 s old (none from the demo drive)
            peak: () => peakRpm,
            chip: () => (lastShift && graded(lastShift) && Date.now() - lastShift.at < 1500 ? { verdict: lastShift.verdict, at: lastShift.at } : null),
            mode: modeNow,
            // 'sport', 'comfort', 'eco' or null (unknown, Adaptive, the demo data): the HUD shows as set up
            driveMode: () => (car.data().demo ? null : driveMode.v),
            boost: () => (boost.moved && Date.now() - boost.t < 2000 && !car.data().demo ? boost.v : null),
            // torque, pedal, g, outside for the extra readouts (none from the demo data)
            extras: () => (car.data().demo ? null : {
                torque: Date.now() - torque.t < 2000 ? torque.v : null,
                gLat: fresh(extra.gLat, 2000), gLong: fresh(extra.gLong, 2000),
                outside: fresh(extra.outside, 600000),
            }),
        });
        render().then(() => log.info('first frame done')).catch((e) => log.warn('first render: ' + e));
    },
});
