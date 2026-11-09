'use strict';
/**
 * Part of Redline's experimental features; README.md in this folder has the whole picture
 * (settings, learning, files, logs, rules for this code).
 *
 * Redline on the head-up display, through cluster-render (robertnisipeanu/idrive-apps,
 * native/cluster-render): one image layer on its 'hud' target, an 800x480 scene the KOMBI
 * lays over BMW's own HUD content (speed, limit sign, guidance stay in their own slots).
 *
 *   - What the glass shows (G21, 2026-11-07 test pattern): about x 120..680, y 120..360 of the
 *     scene, BMW's speed and limit sign along its bottom from y ~325. The tach is a 400x130
 *     image centred at y 150 (a 520 px sample was far too big on the glass); "HUD size" scales
 *     it about its top centre, "HUD position" moves it. Both only move the layer, so they show
 *     at once.
 *   - Dark pixels are see-through on the HUD glass: drawn on alpha 0, lit parts at full
 *     brightness; unlit segments optionally faint ("dim").
 *   - cluster-render gives way to BMW's HUD pop-ups by itself; this module logs the target's
 *     state, including 'disabled' from its mapping guard.
 *   - Only the changed rectangle of each frame is sent (the bar moving is a narrow strip), at
 *     most 10 a second, nothing when the frame is the same.
 *   - Never throws: an uncaught error exits the app, MainApp's CorruptAppsHandler wipes an
 *     app's data on its first crash and uninstalls it on the second.
 *
 * Settings: hud (off | on | test); groups "HUD style" (layout, colours, lights, grade, peak, shake,
 * unlit), "HUD readouts" (gear, boost, each temperature, the cold limit, smart temperatures, units),
 * "HUD position and size"; hudLead (also the screen's lights). README.md lists them.
 */
const fs = require('fs');
const path = require('path');
const { Canvas, withAlpha } = require('./kit/canvas');
// the drawing: layouts, palettes, readouts (hud-draw.js); this file decides what to show and when
const Draw = require('./hud-draw');
const { HudClaim } = require('./kit/hud_claim');
const { drawHud, drawDown, gearText } = Draw;
let ClusterRender = null;
try { ClusterRender = require('./cluster_render_client').ClusterRender; } catch (e) { /* logged at start */ }

const SCENE_W = 800, SCENE_H = 480;
// the tach image and where it sits at 100 %: centred in the visible area, clear of BMW's speed
const IW = 400, IH = 130, BASE_X = (SCENE_W - IW) / 2, BASE_Y = 140;
// frames a second: setting "hudFps" (10 / 20 / 30); the layer is made for the most, the timer paces it
const FPS_MAX = 30, FPS_DEFAULT = 20;
const READOUT_MS = 250;          // the readouts row is refreshed at most this often
const START_LOOK_MS = 30000;     // after a head-unit start: how long the standing HUD app is looked for
// the flash's on / off rhythm in ms (5 Hz), from the clock, so it looks the same at any frame rate
const BLINK_MS = 100;
// the redline shake: offsets (px) stepped every 100 ms while on the limiter. Each step moves the whole
// picture, so the whole frame goes out (~2 MB/s at 10 steps a second): off by default
const SHAKE = [[2, 1], [-2, -1], [1, -1], [-1, 1], [2, -1], [-2, 1]];
const WHITE = '#ffffff', GREEN = '#2fd27a', YELLOW = '#ffc21a', RED = '#ff2a2a', BLUE = '#2a7dff', COLD = '#3d8bff';
const CYAN = '#22e0ff', MAGENTA = '#ff3df0';
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const isNum = (x) => typeof x === 'number' && isFinite(x);

/** Write a small file whole or not at all (temp file, then rename): a power cut mid-write can't corrupt it. */
function writeAtomic(file, text, log) {
    try { fs.writeFileSync(file + '.tmp', text); fs.renameSync(file + '.tmp', file); } catch (e) { if (log) log.warn('save ' + path.basename(file) + ': ' + e); }
}

/** Canvas.d is a Uint8Array; the client copies from a Buffer (px.copy). Same memory, no copy. */
const asBuffer = (u8) => Buffer.from(u8.buffer, u8.byteOffset, u8.length);

/**
 * Shift cue: when the shift lights start counting and when they flash, from how fast the revs
 * climb. st = state kept between frames ({}); returns { from, at, shift, limiter, rate, fallSince }:
 *   at     = the rpm the lights flash at: the shift point minus what the revs climb in the
 *            driver's reaction time (leadMs), at most 800 rpm early;
 *   from   = where the count starts: ~1 s of climb before 'at' (800..2000 rpm), so the count-in
 *            takes about as long in every gear. The span and the lead are taken while the revs
 *            climb and kept when they stop (a lift, a steady hold), so the lights then follow the
 *            revs down one step at a time instead of jumping; back to 1500 / no lead once the
 *            count is empty. Never climbed: 1500 and no lead;
 *   shift  = flashing now. Held at the point it fired at, so a noisy climb rate doesn't make it
 *            flicker; it ends on a gear change (the upshift), when the revs fall 12 % under the
 *            highest they reached while flashing (an upshift without a gear signal) or have been
 *            falling for 300 ms (a lift; a traction dip is shorter);
 *   limiter= on the limiter (within 40 of the redline): everything flashes; shift points are
 *            held 150 under it, so a shift on the point never looks like the limiter;
 *   fallSince = since when the revs have been falling (ms), or null.
 * Rate: smoothed rpm per second from successive samples, rises only (a lift or a shift resets it).
 * rpmShow (optional): the rpm drawn, between samples moved on along the climb (the HUD smooths it);
 * the count, the flash and the limiter go by it, the climb rate only by the real samples (rpm).
 */
function shiftCue(st, rpm, tMs, shift, redline, leadMs, gear, rpmShow) {
    if (!isNum(rpm)) { st.rate = 0; st.on = false; st.fall = null; return { from: shift - 1500, at: shift, shift: false, limiter: false, rate: 0, fallSince: null }; }
    let rising = false;
    // the same reading again (a frame drawn between two rpm samples) is no news: the rate is only
    // updated on a new sample, measured over the time since the last one; a reading unchanged for
    // 500 ms is a real standstill of the revs
    const fresh = !isNum(st.rpm) || rpm !== st.rpm || tMs - st.t >= 500;
    if (isNum(st.rpm) && tMs > st.t && fresh) {
        const r = (rpm - st.rpm) * 1000 / (tMs - st.t);
        rising = r > 300;
        st.rate = r <= 0 ? (r < -500 ? 0 : (st.rate || 0) * 0.7) : (st.rate ? st.rate * 0.5 + r * 0.5 : r);
        // falling: more than 150 rpm/s down, sample after sample
        if (r < -150) { if (st.fall == null) st.fall = st.t; } else st.fall = null;
    }
    if (fresh) { st.rpm = rpm; st.t = tMs; }
    const rate = st.rate || 0, climbing = rate > 300;
    // span and lead from frames where the revs really rose: the smoothed rate decays over a hold
    // or a lift, and following it would shrink the count while the rpm stands still
    if (climbing && rising) { st.span = clamp(rate * 1.0, 800, 2000); st.lead = Math.min(800, rate * leadMs / 1000); }
    const at = shift - (st.lead || 0);
    const from = at - (st.span || 1500);
    const r = isNum(rpmShow) ? rpmShow : rpm;
    if (!climbing && r <= from) { st.span = 0; st.lead = 0; }          // count empty: back to the plain span
    // latch: the flash point is held from the moment it fires
    const lifted = st.fall != null && tMs - st.fall >= 300;
    // a new gear (the upshift itself) ends the flash and starts the next gear's count afresh: in the
    // upper gears an upshift drops the revs only ~20 %, then they climb again at once, so neither
    // the drop nor a lift would end it
    const changed = typeof gear === 'number' && typeof st.gear === 'number' && gear !== st.gear;
    if (typeof gear === 'number') st.gear = gear;
    if (changed) { st.on = false; st.span = 0; st.lead = 0; }
    // without a gear signal: the revs 12 % under the highest they reached while flashing (an upshift
    // drops 18 % or more on an 8-speed, from wherever it was made; a traction dip less)
    // the drop and the limiter go by the real rpm: the drawn one runs ahead along the climb
    if (!st.on && r >= at && !lifted && !changed) { st.on = true; st.at = at; st.peak = rpm; }
    else if (st.on) {
        st.peak = Math.max(st.peak || rpm, rpm);
        if (rpm < st.peak * 0.88 || lifted) st.on = false;
    }
    return { from: from, at: st.on ? st.at : at, shift: st.on, limiter: rpm >= redline - 40, rate: rate, fallSince: st.fall == null ? null : st.fall };
}

const numOf = (settings, k, d) => { const v = Number(settings.get(k)); return isFinite(v) ? v : d; };

/**
 * The driver's reaction time from one hand upshift: flash = { rate (rpm/s), target (rpm), lead (ms asked
 * for) }, rpm: where the shift came. The flash came at most 800 rpm early (shiftCue caps the lead), so on a
 * fast climb it had less lead than asked for: the reaction is the lead it really had plus how late the shift
 * was (0..600 ms).
 */
function reactionMs(flash, rpm) {
    const effLead = Math.min(flash.lead, 800 / flash.rate * 1000);
    return clamp(effLead + (rpm - flash.target) / flash.rate * 1000, 0, 600);
}

/** Where the tach image shows in the HUD's scene (800x480), from the size and position settings. */
function placeOf(settings) {
    const k = clamp(numOf(settings, 'hudSize', 100), 50, 140) / 100, w = Math.round(IW * k), h = Math.round(IH * k);
    const x = BASE_X + Math.round((IW - w) / 2) + clamp(numOf(settings, 'hudX', 0), -120, 120);
    const y = BASE_Y + clamp(numOf(settings, 'hudY', 0), -120, 120);
    return { x: clamp(x, 0, SCENE_W - w), y: clamp(y, 0, SCENE_H - h), w: w, h: h };
}

/**
 * The part of the HUD's 800x480 scene seen through the windshield, measured from car photos by bimmer-lab
 * (github.com/bimmer-lab/apps shared/visible.js, MIT, 2026-11-05; it moves with the driver's eye height).
 */
const HUD_WINDOW = { x: 120, y: 100, w: 485, h: 278 };
/** How far a place (placeOf) reaches outside HUD_WINDOW, in px per side ({} when it is all visible). */
function outsideGlass(r) {
    const W = HUD_WINDOW, o = {};
    if (r.x < W.x) o.left = W.x - r.x;
    if (r.x + r.w > W.x + W.w) o.right = r.x + r.w - (W.x + W.w);
    if (r.y < W.y) o.top = W.y - r.y;
    if (r.y + r.h > W.y + W.h) o.bottom = r.y + r.h - (W.y + W.h);
    return o;
}

/** The gear's font family for the setting "hudGearFont" (auto / ubuntu / barlow) on a layout. */
const M_STYLES = ['arc', 'ramp', 'dial'];
function gearFontOf(choice, style) {
    if (choice === 'barlow') return 'gear_barlow';
    if (choice === 'ubuntu') return 'gear';
    return M_STYLES.indexOf(style) >= 0 ? 'gear_barlow' : 'gear';
}

const STYLES = ['standard', 'minimal', 'wings', 'digital', 'vfd', 'vector', 'arc', 'ramp', 'dial'];
/*
 * The HUD's two setups ("profiles"): Sport, the HUD settings themselves (Sport / Sport+, and a mode not known),
 * and Comfort (Comfort / Eco Pro), which "hudComfortMode" makes the same as Sport, its own ("hudComfortSetup":
 * { key: value } over Sport's) or hidden (BMW's own HUD). The keys a profile has are PROFILE_KEYS; the rest is
 * the same in both: place and size, units, the light colours and the downshift arrows (the
 * centre screen uses those too).
 */
const PROFILE_KEYS = ['hudStyle', 'hudPalette', 'hudGearFont', 'hudLabels', 'hudRpmFormat', 'hudUnlit', 'hudLightStyle',
    'hudShowBar', 'hudShowGear', 'hudShowMode', 'hudShowRpm', 'hudBoost', 'hudShowTorque', 'hudShowPower', 'hudShowG', 'hudShowKnock',
    'hudShowOil', 'hudShowWater', 'hudShowGearbox', 'hudShowOutside', 'hudShowLimit', 'hudTempsMode',
    'hudChip', 'hudKnockWarn', 'hudLaunch', 'hudPeak', 'hudShake'];
/** The profile a driving mode uses ('sport', 'comfort', 'eco' or null). */
function profileOf(drive) { return drive === 'comfort' || drive === 'eco' ? 'comfort' : 'sport'; }
/** Comfort: 'same' (as Sport), 'own' or 'hide'. */
function comfortMode(settings) { const m = settings.get('hudComfortMode'); return m === 'own' || m === 'hide' ? m : 'same'; }
/** Sport's values of the profile keys (a copy: Comfort's own starts from it). */
function profileSnapshot(settings) { const o = {}; PROFILE_KEYS.forEach((k) => { o[k] = settings.get(k); }); return o; }
/**
 * One profile as settings: get(k) reads it (Comfort's own values over Sport's), set(k, v) writes it. A change to
 * Comfort while it follows Sport (or is hidden) gives it its own setup first, a copy of Sport's: so on the HUD
 * looks page nothing needs unlocking before it can be changed.
 */
function profileView(settings, which) {
    const comfort = which === 'comfort';
    const store = () => { const v = settings.get('hudComfortSetup'); return v && typeof v === 'object' ? v : {}; };
    // its own setup: while it is its own, and while hidden when it has one (so it shows as it will come back)
    const own = () => comfort && (comfortMode(settings) === 'own' || (comfortMode(settings) === 'hide' && Object.keys(store()).length > 0));
    return {
        profile: comfort ? 'comfort' : 'sport',
        get(k) {
            if (own() && PROFILE_KEYS.indexOf(k) >= 0) { const st = store(); if (Object.prototype.hasOwnProperty.call(st, k)) return st[k]; }
            return settings.get(k);
        },
        set(k, v) {
            if (!comfort || PROFILE_KEYS.indexOf(k) < 0) return settings.set(k, v);
            const st = Object.assign(profileSnapshot(settings), own() ? store() : {});
            st[k] = v;
            settings.set('hudComfortSetup', st);
            if (!own()) settings.set('hudComfortMode', 'own');
            return undefined;
        },
        item: (k) => (settings.item ? settings.item(k) : null),
    };
}
/** Comfort made its own (or back): its setup starts as Sport's when it has none. */
function setComfortMode(settings, mode) {
    const st = settings.get('hudComfortSetup');
    if (mode === 'own' && !(st && typeof st === 'object' && Object.keys(st).length)) settings.set('hudComfortSetup', profileSnapshot(settings));
    settings.set('hudComfortMode', mode);
}
/**
 * Once, from 1.14 / 1.15's "In Comfort / Eco Pro" (hudComfort: all, lights, hide): hide stays hidden; "shift lights
 * and gear only" becomes Comfort's own setup without readouts and alerts. Returns what it did, or null.
 */
function migrateProfiles(settings) {
    const v = settings.values || {};
    if (v._hudProfiles) return null;
    let did = 'none';
    if (v.hudComfort === 'hide') { settings.set('hudComfortMode', 'hide'); did = 'hide'; }
    else if (v.hudComfort === 'lights') {
        const st = profileSnapshot(settings);
        ['hudShowRpm', 'hudBoost', 'hudShowTorque', 'hudShowPower', 'hudShowG', 'hudShowKnock', 'hudShowOil', 'hudShowWater',
            'hudShowGearbox', 'hudShowOutside', 'hudShowLimit', 'hudPeak', 'hudShake', 'hudLaunch'].forEach((k) => { st[k] = false; });
        st.hudChip = 'off';
        settings.set('hudComfortSetup', st);
        settings.set('hudComfortMode', 'own');
        did = 'lights';
    }
    settings.set('_hudProfiles', 1);
    return did;
}

/**
 * The HUD's drawing options from the settings (also used by the HUD looks page): settings, or a profile of them
 * (profileView); drive ('sport', 'comfort', 'eco' or none): that mode's profile.
 */
function optsFrom(settings, drive) {
    if (drive) settings = profileView(settings, profileOf(drive));
    const lights = settings.get('hudLightStyle') || 'gt3', on = (k) => settings.get(k) !== false;
    const layout = settings.get('hudStyle');
    const style = STYLES.indexOf(layout) > 0 ? layout : 'standard';
    return {
        style: style,
        // the gear's font: Auto is Barlow on the BMW-M-inspired layouts (arc, ramp, dial), Ubuntu on the rest
        // (hud-draw falls back to Ubuntu if a font's atlas is missing)
        gearFont: gearFontOf(settings.get('hudGearFont'), style),
        palette: settings.get('hudPalette') || 'colour',
        // readouts, each on its own switch
        gear: on('hudShowGear'), rpm: on('hudShowRpm'), bar: on('hudShowBar'), boost: on('hudBoost'), limit: on('hudShowLimit'),
        oil: on('hudShowOil'), coolant: on('hudShowWater'), gearbox: on('hudShowGearbox'),
        // the extra readouts are off unless switched on
        torque: settings.get('hudShowTorque') === true, power: settings.get('hudShowPower') === true,
        // throttle: off until the accelerator pedal's scaling is checked on a car (readoutsFor keeps it)
        throttle: false, g: settings.get('hudShowG') === true,
        outside: settings.get('hudShowOutside') === true,
        torqueUnit: settings.get('hudTorqueUnit') === 'lbft' ? 'lbft' : 'nm',
        powerUnit: ['kw', 'ps'].indexOf(settings.get('hudPowerUnit')) >= 0 ? settings.get('hudPowerUnit') : 'hp',
        smartTemps: settings.get('hudTempsMode') !== 'always',
        boostUnit: settings.get('hudBoostUnit') || 'bar', fahrenheit: settings.get('hudTempUnit') === 'f',
        rpmFormat: ['50', 'k'].indexOf(String(settings.get('hudRpmFormat'))) >= 0 ? String(settings.get('hudRpmFormat')) : '10',
        readoutMs: Math.round(1000 / clamp(Number(settings.get('hudReadoutRate')) || 4, 1, 30)),
        clearLabels: settings.get('hudLabels') === 'clear',
        peak: on('hudPeak'),
        chip: (() => { const c = settings.get('hudChip'); return c === false || c === 'off' ? 'off' : c === 'simple' ? 'simple' : 'burst'; })(),
        shake: settings.get('hudShake') === true,
        lights: lights !== 'off', gt3: lights === 'gt3', dim: settings.get('hudUnlit') === 'dim',
        lightStyle: settings.get('lights'), warmOil: numOf(settings, 'warmOil', 80),
        mode: on('hudShowMode'),
        // knock (the engine unit's ignition retard): the warning on by default, the readout off
        knock: settings.get('hudShowKnock') === true, knockWarn: settings.get('hudKnockWarn') !== false,
        // the launch time (0-100 km/h or 0-60 mph) and its difference to the best, after a standing start
        launch: settings.get('hudLaunch') !== false, mph: settings.get('speedUnit') === 'mph',
    };
}

/**
 * The car's driving mode (FES statusFESVehicleDynamicSwitchHMI.actualValueModeDrivingExperience, a
 * name or a number, as Live Data and Live Adjustments read it) -> 'sport', 'comfort', 'eco' or null.
 * Adaptive, initialising and anything unknown are null: the HUD then shows as set up.
 */
function driveModeOf(raw) {
    if (raw === undefined || raw === null) return null;
    // a plug-in hybrid's modes and Adaptive count as Comfort (only Sport and XtraBoost are Sport): wire numbers
    // 10 Adaptive, 15/16/23 PHEV Sport, 17-22 PHEV Hybrid / Electric / battery control, 28 Boost
    const n = Number(raw);
    if (!isNaN(n) && String(raw).trim() !== '') {
        return (n >= 1 && n <= 3) || n === 15 || n === 16 || n === 23 || n === 28 ? 'sport'
            : (n >= 4 && n <= 6) || n === 10 || (n >= 17 && n <= 22) ? 'comfort' : n >= 7 && n <= 9 ? 'eco' : null;
    }
    const s = String(raw).toUpperCase();
    return /SPORT|BOOST/.test(s) ? 'sport' : /HYBRID|ELECTRIC|BATTERY|ADAPTIV/.test(s) ? 'comfort' : /ECO/.test(s) ? 'eco'
        : /COMFORT|TRAFFIC/.test(s) ? 'comfort' : null;
}
/**
 * What the HUD does in this driving mode (setting hudComfort): 'all', 'lights' (shift lights, rev
 * bar and gear only) or 'hide'. Sport and an unknown mode always 'all'.
 */
function calmFor(drive, mode) {
    if (drive !== 'comfort' && drive !== 'eco') return 'all';
    return mode === 'hide' ? 'hide' : 'all';
}
/** o (optsFrom) with only the shift lights, rev bar and gear left on (Comfort / Eco Pro on "lights"). */
function calmOpts(o) {
    return Object.assign({}, o, { rpm: false, boost: false, torque: false, power: false, throttle: false, g: false, limit: false,
        oil: false, coolant: false, gearbox: false, outside: false, chip: 'off', peak: false, shake: false });
}

const TEMPS = [['OIL', 'oil', { cold: 60, hot: 130, warmOil: true }], ['WATER', 'coolant', { cold: 60, hot: 112 }], ['GEARBOX', 'gearbox', { cold: 50, hot: 120 }]];
// boost in the unit chosen: bar (1 decimal), psi or kPa (whole numbers); temperatures in °C or °F
const BOOST_UNITS = { bar: [1, 1, 'BOOST'], psi: [14.5038, 0, 'BOOST PSI'], kpa: [100, 0, 'BOOST KPA'] };
// torque from Nm, power from kW: [factor, label]
const TORQUE_UNITS = { nm: [1, 'TORQUE'], lbft: [0.737562, 'LB-FT'] };
const POWER_UNITS = { hp: [1.34102, 'HP'], kw: [1, 'KW'], ps: [1.35962, 'PS'] };
const MAX_READOUTS = 4;
/** The RPM readout for format f: '10' (to 10, the default), '50', or 'k' (thousands, 4.5). */
function rpmItem(rpm, f) {
    const r = Math.max(0, rpm), step = f === '50' ? 50 : 10;
    if (f === 'k') return { label: 'KRPM', value: (Math.round(r / 100) / 10).toFixed(1), tone: 'text' };
    return { label: 'RPM', value: String(Math.round(r / step) * step), tone: 'text' };
}
const roundTo = (v, step) => Math.round(v / step) * step;
/**
 * The readouts row for o (optsFrom): d (rpm, oil, coolant), gearbox temperature, boost (bar), sp
 * ({ rpm, cold }), x (the extras: torque Nm, pedal %, gLat / gLong g, outside °C; any may be null).
 * In the order of the switches; at most four. When more are on, the last plain ones give way first:
 * a cold, warming or hot temperature (and the cold limit) keeps its place.
 * Fast values are rounded (torque to 5, throttle to 5 %, g to 0.05) so the row doesn't flicker.
 */
function readoutsFor(d, gb, boost, sp, o, x) {
    const items = [];
    x = x || {};
    // the rpm as a number (the 7-segment layouts have their own digits): to 10, to 50, or in
    // thousands with one decimal (4.5), which reads at a glance like the tach's own numbers
    if (o.rpm && o.style !== 'digital' && o.style !== 'vfd' && isNum(d.rpm)) items.push(rpmItem(d.rpm, o.rpmFormat));
    if (o.boost) {
        const b = boost, u = BOOST_UNITS[o.boostUnit] || BOOST_UNITS.bar;
        if (isNum(b)) items.push({ label: u[2], value: (Math.max(0, b) * u[0]).toFixed(u[1]), tone: 'text' });
    }
    if (o.torque && isNum(x.torque)) {
        const u = TORQUE_UNITS[o.torqueUnit] || TORQUE_UNITS.nm;
        items.push({ label: u[1], value: String(roundTo(Math.max(0, x.torque) * u[0], 5)), tone: 'text' });
    }
    // power from torque x rpm (kW = Nm x rpm / 9549)
    if (o.power && isNum(x.torque) && isNum(d.rpm)) {
        const u = POWER_UNITS[o.powerUnit] || POWER_UNITS.hp;
        items.push({ label: u[1], value: String(Math.round(Math.max(0, x.torque) * Math.max(0, d.rpm) / 9549 * u[0])), tone: 'text' });
    }
    if (o.throttle && isNum(x.pedal)) items.push({ label: 'THROTTLE', value: roundTo(clamp(x.pedal, 0, 100), 5) + '%', tone: 'text' });
    // combined g (sideways and forward / braking together)
    if (o.g && (isNum(x.gLat) || isNum(x.gLong))) {
        const g = Math.sqrt(Math.pow(x.gLat || 0, 2) + Math.pow(x.gLong || 0, 2));
        items.push({ label: 'G', value: roundTo(g, 0.05).toFixed(2), tone: 'text' });
    }
    if (o.limit && sp && sp.cold) items.push({ label: 'LIMIT', value: String(sp.rpm), tone: 'cold' });
    // knock: the ignition retard knock control takes, only while it takes some (0.75 degrees and up)
    if (o.knock && isNum(x.knock) && x.knock >= 0.75) items.push({ label: 'KNOCK', value: x.knock.toFixed(1) + '°', tone: x.knock >= 2.25 ? 'hot' : 'warm' });
    TEMPS.forEach((t) => {
        if (!o[t[1]]) return;
        const v = t[1] === 'gearbox' ? gb : d[t[1]];
        if (!isNum(v)) return;
        const lim = t[2];
        // the bands are in °C whatever is shown
        const tone = v < lim.cold ? 'cold' : lim.warmOil && v < o.warmOil ? 'warm' : v > lim.hot ? 'hot' : 'text';
        if (o.smartTemps && tone === 'text') return;
        items.push({ label: t[0], value: Math.round(o.fahrenheit ? v * 9 / 5 + 32 : v) + '°', tone: tone });
    });
    // outside: blue at 3 °C and below (ice is possible)
    if (o.outside && isNum(x.outside)) items.push({ label: 'OUTSIDE', value: Math.round(o.fahrenheit ? x.outside * 9 / 5 + 32 : x.outside) + '°', tone: x.outside <= 3 ? 'cold' : 'text' });
    // four fit the row legibly: the last plain readout gives way first, so a warning keeps its place
    // (on a cold start with boost, limit, oil, water and gearbox on, the gearbox goes)
    while (items.length > MAX_READOUTS) {
        let i = items.length - 1;
        while (i >= 0 && items[i].tone !== 'text') i--;
        items.splice(i >= 0 ? i : items.length - 1, 1);
    }
    return items;
}

/*
 * A scripted 10 s drive for previews (the HUD looks page and "Play on HUD"): 3rd gear counting in
 * and flashing, an upshift (graded spot on, early or late in turn, by the loop), 4th onto the
 * limiter, braking with the downshift cue counting up, two downshifts, then cruising.
 * Returns what the HUD needs at t ms into it.
 */
const DEMO_MS = 10000;
function demoAt(tMs) {
    const loop = Math.floor(tMs / DEMO_MS), t = (tMs % DEMO_MS) / 1000;
    const lerp = (a, b, f) => a + (b - a) * clamp(f, 0, 1);
    const grades = ['SPOT ON', 'EARLY', 'LATE'], g = grades[loop % 3];
    const upAt = g === 'EARLY' ? 4800 : g === 'LATE' ? 6150 : 5650;       // the 3rd-gear shift rpm
    const climb3 = 3800, rate3 = 1000, tUp = (upAt - climb3) / rate3;
    let r = { rpm: 0, gear: 3, stage: 'D', shift: 5550, down: 0, chip: null, oil: 98, coolant: 92, gearbox: 81, boost: 0, mode: 'M', peak: 0 };
    if (t < tUp) { r.rpm = climb3 + rate3 * t; r.boost = lerp(0.4, 1.3, t / tUp); }
    else if (t < 4.8) {
        r.gear = 4; r.shift = 5750; r.chip = { verdict: g, at: tUp * 1000 };
        r.rpm = Math.min(6540, upAt * 0.79 + 800 * (t - tUp)); r.boost = 1.3; r.peak = upAt;
    } else if (t < 5.6) { r.gear = 4; r.shift = 5750; r.rpm = 6500 + (Math.floor(t * 20) % 2) * 40; r.boost = 1.3; r.peak = 6540; }
    else if (t < 7.6) {
        r.gear = 4; r.shift = 5750; r.rpm = lerp(6400, 2700, (t - 5.6) / 2); r.down = Math.min(3, Math.floor((t - 5.6) / 0.55)); r.peak = 6540;
    } else if (t < 8.6) { r.gear = t < 8.1 ? 3 : 2; r.shift = r.gear === 3 ? 5550 : 6400; r.rpm = r.gear === 3 ? 3500 : 4400; r.down = r.gear === 3 ? 2 : 1; }
    else { r.gear = 2; r.shift = 6400; r.rpm = lerp(4400, 3000, (t - 8.6) / 1.4); r.boost = 0.2; }
    r.chipAge = r.chip ? tMs % DEMO_MS - r.chip.at : 0;
    // the extras: full throttle while climbing, off while braking
    const pull = r.down || t >= 8.6 ? 0 : t >= 7.6 ? 0.3 : 1;
    r.pedal = pull * 100; r.torque = pull ? 180 + 220 * clamp(r.boost / 1.3, 0, 1) : 0;
    r.gLong = r.down ? -0.85 : pull * 0.45; r.gLat = 0.1; r.outside = 14;
    return r;
}

/** 800x480 test pattern: border, rulers every 40 px with labels, inset frames at 40/80/120, the tach at its place. */
function drawTestPattern(cv) {
    cv.clear();
    const frame = (i, c) => {
        const w = SCENE_W - 2 * i, h = SCENE_H - 2 * i;
        cv.fillRect(i, i, w, 2, c); cv.fillRect(i, i + h - 2, w, 2, c);
        cv.fillRect(i, i, 2, h, c); cv.fillRect(i + w - 2, i, 2, h, c);
    };
    frame(0, WHITE);
    [[40, CYAN], [80, MAGENTA], [120, YELLOW]].forEach((f) => {
        frame(f[0], f[1]);
        cv.text(String(f[0]), f[0] + 6, f[0] + 22, 18, f[1], { font: 'bold' });
    });
    for (let x = 0; x <= SCENE_W; x += 40) {
        const major = x % 200 === 0, len = major ? 24 : 12;
        cv.fillRect(clamp(x - 1, 0, SCENE_W - 2), 0, 2, len, WHITE);
        cv.fillRect(clamp(x - 1, 0, SCENE_W - 2), SCENE_H - len, 2, len, WHITE);
        if (major && x > 0 && x < SCENE_W) cv.text(String(x), x, 44, 16, WHITE, { align: 'center', font: 'bold' });
    }
    for (let y = 0; y <= SCENE_H; y += 40) {
        const major = y % 120 === 0, len = major ? 24 : 12;
        cv.fillRect(0, clamp(y - 1, 0, SCENE_H - 2), len, 2, WHITE);
        cv.fillRect(SCENE_W - len, clamp(y - 1, 0, SCENE_H - 2), len, 2, WHITE);
        if (major && y > 0 && y < SCENE_H) cv.text(String(y), 30, y + 6, 16, WHITE, { font: 'bold' });
    }
    cv.fillRect(SCENE_W / 2 - 20, SCENE_H / 2 - 1, 40, 2, WHITE);
    cv.fillRect(SCENE_W / 2 - 1, SCENE_H / 2 - 20, 2, 40, WHITE);
}

/** Bounding box of the pixels that differ between a and b (Uint8Arrays of w x h RGBA), or null. */
function changedBox(a, b, w, h) {
    const A = new Uint32Array(a.buffer, a.byteOffset, w * h), B = new Uint32Array(b.buffer, b.byteOffset, w * h);
    let x0 = w, x1 = -1, y0 = h, y1 = -1;
    for (let y = 0; y < h; y++) {
        const row = y * w;
        let l = -1, r = -1;
        for (let x = 0; x < w; x++) if (A[row + x] !== B[row + x]) { l = x; break; }
        if (l < 0) continue;
        for (let x = w - 1; x >= l; x--) if (A[row + x] !== B[row + x]) { r = x; break; }
        if (y < y0) y0 = y;
        y1 = y;
        if (l < x0) x0 = l;
        if (r > x1) x1 = r;
    }
    return y1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/**
 * The rows of rects rs of a w-wide RGBA image, packed tight one after another (what cr.pixels
 * takes), in a buffer reused between frames: cr.pixels copies it before returning.
 */
let packBuf = null;
function packRect(d, w, r) { return packRects(d, w, [r]); }
function packRects(d, w, rs) {
    let n = 0;
    rs.forEach((r) => { n += r.w * r.h * 4; });
    if (!packBuf || packBuf.length < n) packBuf = Buffer.alloc(Math.max(n, IW * IH * 4));
    const src = asBuffer(d);
    let off = 0;
    rs.forEach((r) => {
        for (let y = 0; y < r.h; y++) { src.copy(packBuf, off, ((r.y + y) * w + r.x) * 4, ((r.y + y) * w + r.x + r.w) * 4); off += r.w * 4; }
    });
    return packBuf.slice(0, n);
}

/** The changed boxes of a and b per horizontal band (lights, bar, text): a flash or a count at
 * both ends plus the bar's end make three small boxes, not one that spans them all. */
const BANDS = [[0, 20], [20, 60], [60, IH]];
function changedBoxes(a, b, w) {
    const out = [];
    BANDS.forEach((band) => {
        const y0 = band[0], h = band[1] - band[0];
        const r = changedBox(a.subarray(y0 * w * 4, (y0 + h) * w * 4), b.subarray(y0 * w * 4, (y0 + h) * w * 4), w, h);
        if (r) { r.y += y0; out.push(r); }
    });
    return out;
}

/**
 * Start the HUD output. src = { data() (car.data()), shiftPoint(oil, gear) -> { rpm }, redline(),
 * maxRpm(), gearbox (a GearboxTemp, optional) }.
 * Returns { stop, status() (a line for the screen, '' while off), upshift(rpm) (each upshift's
 * rpm: calibrates the reaction time), lead() (ms in use) }.
 */
function start(ctx, src) {
    const settings = ctx.settings, log = ctx.log;
    let cr = null, layer = 0, shown = '', lastTarget = '', timer = null, blink = false;
    let target = null;                                           // { state, holder, disabled } of 'hud'
    const cueState = {};
    let lastDemo = null;
    /*
     * Reaction time, learned ("HUD shift light early by" on Auto): each upshift after a flash
     * says how late it came: (shift rpm - shift point) / climb rate. The lead moves 30 % of the
     * way to the lead that would have hit it, within 0..600 ms; kept in data/hudlead.json.
     */
    const leadFile = path.join(ctx.dataDir || '.', 'hudlead.json');
    let learnedLead = 200, leadShifts = 0, flashInfo = null;
    try {
        const j = JSON.parse(fs.readFileSync(leadFile, 'utf8'));
        if (isNum(j.ms)) { learnedLead = clamp(Math.round(j.ms), 0, 600); leadShifts = isNum(j.n) && j.n > 0 ? Math.floor(j.n) : 0; }
    } catch (e) { /* none yet */ }
    let cur = null, prev = null, first = true, lastErr = 0;
    let hiddenLogged = false;     // the HUD is hidden by the driving mode (logged once each way)

    const safe = (name, fn) => function () {
        try { return fn.apply(null, arguments); } catch (e) {
            if (Date.now() - lastErr > 10000) { lastErr = Date.now(); log.error('hud ' + name + ': ' + (e && e.stack || e)); }
        }
    };
    const mode = () => settings.get('hud') || 'off';
    const num = (k, dflt) => { const v = Number(settings.get(k)); return isFinite(v) ? v : dflt; };
    const leadMs = () => { const v = num('hudLead', -1); return v < 0 ? learnedLead : v; };

    const rect = () => placeOf(settings);

    /*
     * BMW's own content in the HUD's slot (0x323). With CarPlay directions on (2026-11-09 drive, Apple Maps:
     * "Proceed to the route", the line, the arrow and the distance) they didn't show while Redline held the slot:
     * the KOMBI shows the first content in a slot and parks the rest behind it. BMW shows them for the whole
     * route, so stepping aside would mean no Redline while navigating: Redline keeps the slot and only logs
     * the slot's rows from cluster-render's status (each change), to know what BMW puts there (for drawing
     * directions of its own).
     */
    let lastSlot = '';
    function onSlots(text) {
        const rows = String(text || '').split(/\r?\n/).filter((l) => /0x323\b/i.test(l)).map((l) => l.trim());
        const s = rows.length ? rows.join(' | ') : 'slot 0x323 not in the report';
        if (s !== lastSlot) { lastSlot = s; log.info('hud: ' + s); }
    }
    // the slot report, while the tach is on
    const slotTimer = setInterval(safe('slots', () => { if (cr && cr.ready && cr.status && shown === 'tach') cr.status(); }), 2500);
    if (slotTimer.unref) slotTimer.unref();

    const connect = safe('connect', () => {
        if (cr) return;
        if (!ClusterRender) { log.warn('hud: cluster_render_client.js is missing from the app'); return; }
        cr = new ClusterRender('redline');
        cr.on('ready', safe('ready', () => { first = true; log.info('hud: connected to cluster-render (' + cr.backend + ', targets ' + cr.targets + ')'); }));
        cr.on('disconnected', safe('disconnected', () => log.warn('hud: cluster-render went away, reconnecting')));
        cr.on('target', safe('target', (name, state, holder, reason, guideDisabled, disabled) => {
            if (name !== 'hud') return;
            const s = disabled ? 'disabled by the mapping guard (as root: cluster-render guard-reset)'
                : state + (holder ? ' behind ' + holder : '') + (reason ? ' (' + reason + ')' : '');
            target = { state: state, holder: holder, disabled: disabled };
            if (s !== lastTarget) { lastTarget = s; log.info('hud: target ' + s); }
        }));
        cr.on('layer', safe('layer', (ref, state, reason) => {
            if (ref === layer) log.info('hud: layer ' + state + (reason ? ' (' + reason + ')' : ''));
        }));
        cr.on('refused', safe('refused', (op, ref, reason) => log.warn('hud: refused ' + op + ' ' + ref + ': ' + reason)));
        cr.on('status', safe('status', onSlots));
        cr.connect();
        log.info('hud: connecting to cluster-render');
    });

    const stopTimer = () => { if (timer) clearInterval(timer); timer = null; if (src.gearbox) src.gearbox.stop(); if (src.knock) src.knock.stop(); };

    const dropLayer = safe('drop', () => { stopTimer(); if (cr && layer) cr.drop(layer); layer = 0; shown = ''; hiddenLogged = false; });

    const disconnect = safe('disconnect', () => {
        dropLayer();
        if (cr) { cr.removeAllListeners(); cr.close(); cr = null; log.info('hud: off'); }
        lastTarget = ''; target = null;
    });

    const showTestPattern = safe('test', () => {
        if (shown === 'test') return;
        dropLayer();
        layer = cr.image({ target: 'hud', klass: 'overlay', x: 0, y: 0, w: SCENE_W, h: SCENE_H, fps: 1 });
        if (!layer) { log.warn('hud: test layer refused by the client'); return; }
        const cv = new Canvas(SCENE_W, SCENE_H);
        drawTestPattern(cv);
        const r = rect();
        // where the size and position settings put the tach: drawn there at that size, blended over the pattern
        // (a scaled copy of the 400x130 picture would lose its see-through and dim parts: drawImage is opaque)
        if (r.w === IW && r.h === IH) { const t = new Canvas(IW, IH); drawHud(t, sample()); cv.blit(t, r.x, r.y); }
        else Draw.drawLayer(Draw.scaled(cv, r.w / IW, r.x, r.y), sample());
        if (!cr.pixels(layer, null, asBuffer(cv.d))) log.warn('hud: test pattern pixels refused');
        shown = 'test';
        log.info('hud: test pattern up');
    });

    /** What drawHud needs, now. */
    function frameData() {
        let now = Date.now();
        // the demo stops by itself once the car moves (it replaces the real lights on the glass)
        if (now < demoUntil && src.data().speed > 5) { demoUntil = 0; log.info('hud: demo stopped, the car moved'); }
        const playing = now < demoUntil, dm = playing ? demoAt(now - demoStart) : null;
        // "Play on HUD": the scripted drive instead of the car, for a few seconds (nothing is learned)
        const d = dm ? { rpm: dm.rpm, gear: dm.gear, stage: dm.stage, oil: dm.oil, coolant: dm.coolant, demo: true } : src.data();
        const sp = dm ? { rpm: dm.shift, cold: false } : src.shiftPoint(d.oil, d.gear), redline = dm ? 6550 : src.redline();
        const demoKey = dm ? 'play' : !!d.demo;
        if (demoKey !== lastDemo) { lastDemo = demoKey; Object.keys(cueState).forEach((k) => { delete cueState[k]; }); flashInfo = null; }
        const o = optsNow(), lights = o.lights;
        // the lights count into the shift and flash for it, early by the reaction time; 5 Hz flash
        const was = cueState.on, lead = leadMs();
        const show = dm ? d.rpm : smooth(d.rpm, now, Math.min(redline - 50, src.maxRpm()));
        const cue = shiftCue(cueState, d.rpm, now, sp.rpm, redline, lead, d.gear, show);
        // the reaction time is learned only from flashes the driver could see: lights on, HUD shown
        if (cue.shift && !was) {
            const seen = lights && target && target.state === 'shown' && !dm;
            flashInfo = seen ? { t: Date.now(), rate: cue.rate, target: sp.rpm, lead: lead, fall: null } : null;
        }
        // first moment the revs fell after the flash: a real upshift reports its new gear within
        // ~0.7 s of that; later, the driver lifted first and the shift says nothing about reaction
        if (flashInfo && flashInfo.fall === null && cue.fallSince !== null) flashInfo.fall = cue.fallSince;
        blink = cue.shift || cue.limiter ? Math.floor(now / BLINK_MS) % 2 === 0 : true;
        const gb = dm ? dm.gearbox : src.gearbox ? src.gearbox.value() : null;
        const mode = dm ? dm.mode : src.mode ? src.mode() : null;
        return {
            d: isNum(show) && show !== d.rpm ? Object.assign({}, d, { rpm: show }) : d, shift: sp.rpm, redline: redline, max: dm ? 8000 : src.maxRpm(), blink: blink, cue: cue,
            down: dm ? dm.down : src.downshift ? src.downshift() : 0,
            peak: o.peak ? (dm ? dm.peak : src.peak ? src.peak() : 0) : 0,
            chip: dm ? (dm.chip && o.chip !== 'off' && dm.chipAge < 1500 ? { verdict: dm.chip.verdict, age: dm.chipAge, burst: o.chip === 'burst' } : null) : chipNow(o, now),
            shake: o.shake && cue.limiter ? SHAKE[Math.floor(now / 100) % SHAKE.length] : null,
            readouts: dm ? readoutsFor(d, gb, dm.boost, sp, o, dm) : readouts(d, gb, sp, o),
            mode: o.mode && (mode === 'M' || mode === 'S' || mode === 'D') ? mode : null,
            opts: o,
        };
    }
    let demoStart = 0, demoUntil = 0;

    /*
     * The readouts row, left to right: rpm, boost (once the car has sent a moving value), torque,
     * power, throttle, g, the cold-engine shift limit (while the cold guard holds the shift point
     * down), then oil, water, gearbox and outside (readoutsFor).
     * Temperatures "smart": only one that is cold, warming (oil under "Oil warm at") or hot. Four at most.
     */
    const ro = { t: 0, v: [], o: null };
    function readouts(d, gb, sp, o) {
        // 4 times a second by default (setting "Readouts refresh"): power, torque and g change with
        // every sample; faster means more frames sent to the HUD (an options change shows at once)
        const now = Date.now();
        const ok = JSON.stringify(o);
        if (ok !== ro.o || now - ro.t >= (o.readoutMs || READOUT_MS) || now < ro.t) {
            ro.v = readoutsFor(d, gb, o.boost && src.boost ? src.boost() : null, sp, o, src.extras ? src.extras() : null);
            ro.t = now; ro.o = ok;
        }
        return ro.v;
    }

    /*
     * The car sends rpm 10-20 times a second; the HUD draws up to 30. Between two samples the bar is
     * moved on along the last climb (or fall), for at most 1.2 sample intervals and 150 ms, so it
     * moves smoothly instead of in steps; a new sample replaces the estimate. A gap over 300 ms is
     * no climb, nor is a jump faster than 8000 rpm/s (a glitch, not a climb); after the window the
     * real reading is drawn (revs held on the point must not run on into the limiter), and the
     * estimate never goes past the redline. Also measured: how often samples come (logged once, then every 10 minutes).
     */
    const sm = { r: null, t: 0, rate: 0, dt: 0, n: 0, logged: 0 };
    function smooth(rpm, now, max) {
        // max: the redline (the estimate stops there; the real reading may be above it)
        if (!isNum(rpm)) { sm.r = null; return rpm; }
        if (rpm !== sm.r || now - sm.t >= 500) {
            const dt = now - sm.t;
            sm.rate = sm.r !== null && dt > 15 && dt < 300 ? (rpm - sm.r) * 1000 / dt : 0;
            if (Math.abs(sm.rate) > 8000) sm.rate = 0;
            if (sm.r !== null && dt > 15 && dt < 300) { sm.dt = sm.dt ? sm.dt * 0.95 + dt * 0.05 : dt; sm.n++; }
            sm.r = rpm; sm.t = now;
            if (sm.n >= 200 && now - sm.logged > 600000) {
                sm.logged = now;
                log.info('hud: rpm samples every ' + Math.round(sm.dt) + ' ms (' + Math.round(1000 / sm.dt) + ' a second), drawn at ' + fps() + ' fps');
            }
            return rpm;
        }
        const win = Math.min(sm.dt ? sm.dt * 1.2 : 100, 150);
        if (Math.abs(sm.rate) < 200 || now - sm.t > win) return rpm;
        const est = clamp(Math.round(rpm + sm.rate * (now - sm.t) / 1000), 0, Math.max(rpm, max || 9000));
        return sm.rate > 0 ? Math.max(rpm, Math.min(est, max || 9000)) : est;
    }
    const fps = () => { const v = num('hudFps', FPS_DEFAULT); return v >= 30 ? 30 : v >= 20 ? 20 : 10; };

    /** The last upshift's grade while it shows: { verdict, age, burst } (src.chip(): { verdict, at }). */
    // where the grade shows, first that has one: knock (it can save the engine), the shift grade, the launch time
    function chipNow(o, now) {
        const k = knockChip(o, now);
        if (k) return k;
        const c = o.chip !== 'off' && src.chip ? src.chip() : null;
        if (c) return { verdict: c.verdict, age: now - c.at, burst: o.chip === 'burst' };
        return launchChip(o, now);
    }
    /*
     * The launch time for 3 s after a standing start: the time and its difference to the best before it,
     * green for a new best, yellow within 0.1 s, red further off. Held for 2.6 s (the grade's timeline holds 1.1 s),
     * then fades as a grade does.
     */
    function launchChip(o, now) {
        if (!o.launch || !src.launch) return null;
        const l = src.launch(now, o.mph);
        if (!l) return null;
        const a = now - l.at, sign = (x) => (x < 0 ? '-' : '+') + Math.abs(x).toFixed(2);
        return { verdict: 'LAUNCH', text: l.secs.toFixed(2) + (l.delta === null ? ' s' : '  ' + sign(l.delta)), tone: l.best ? 'low' : l.delta !== null && l.delta <= 0.1 ? 'mid' : 'high',
            age: a < 2600 ? Math.min(a, 1100) : a - 1500, burst: o.chip !== 'simple' };
    }
    /*
     * The knock warning: KNOCK where the grade shows, for 1.5 s after the engine last reported knock (it does
     * on every read while it knocks, so it stays up). Its burst plays once per spell, not on every read.
     */
    const kn = { start: 0, last: 0 };
    function knockChip(o, now) {
        if (!o.knockWarn || !src.knock) return null;
        const at = src.knock.value().at;
        if (!at || now - at > 1500) return null;
        if (at - kn.last > 1500 || !kn.start) kn.start = at;
        kn.last = at;
        return { verdict: 'KNOCK', age: now - kn.start, burst: o.chip !== 'simple' };
    }

    /** The drawing options from the settings. */
    // the profile of the driving mode; "Play on HUD" plays the one it was asked for
    let playProfile = 'sport';
    function optsNow() {
        if (Date.now() < demoUntil) return optsFrom(profileView(settings, playProfile));
        return optsFrom(settings, src.driveMode ? src.driveMode() || 'sport' : 'sport');
    }
    /** What the driving mode asks of the HUD now ('all', 'lights', 'hide'); "Play on HUD" always shows all. */
    function calm(playing) { return playing ? 'all' : calmFor(src.driveMode ? src.driveMode() : null, comfortMode(settings)); }

    /** Demo frame for the test pattern: 6300 rpm in 3rd, warm. */
    function sample() {
        const o = optsNow(), d = { rpm: 6300, gear: 3, stage: 'D', oil: 96, coolant: 97 };
        return { d: d, shift: 6700, redline: 7000, max: 8000, blink: true, cue: shiftCue({}, 6300, 0, 6700, 7000, 0), down: 0, peak: 0, chip: null,
            readouts: [{ label: 'BOOST', value: '1.1', tone: 'text' }, { label: 'OIL', value: '96°', tone: 'text' }, { label: 'WATER', value: '97°', tone: 'text' }], opts: o };
    }

    let lastKey = '';
    /**
     * Not drawn while the HUD can't show it: parked behind BMW's content, waiting to retry,
     * unavailable or disabled by the guard. Drawn in every other state: cluster-render only asks
     * for the target once the layer has content, so idle / acquiring must draw.
     */
    const paused = () => !!target && (target.disabled || target.state === 'parked' || target.state === 'waiting' || target.state === 'unavailable');
    const tick = safe('tick', () => {
        if (!cr || !cr.ready) return;
        // Comfort / Eco Pro on "Hide": the image is dropped (BMW's own HUD shows), the timer keeps
        // running to bring it back when the mode changes
        if (shown === 'tach') {
            const playing = Date.now() < demoUntil;
            if (calm(playing) === 'hide') {
                if (layer) {
                    cr.drop(layer); layer = 0;
                    // the old layer's target state isn't the new one's: forget it (keeping a guard
                    // stop), so a layer made again isn't held back waiting for a target event
                    if (target) target = { state: '', holder: '', disabled: target.disabled };
                }
                if (src.gearbox) src.gearbox.stop();
                if (src.knock) src.knock.stop();
                claim.hold(false);          // nothing of Redline's on the HUD: the standing app may show
                if (!hiddenLogged) { hiddenLogged = true; log.info('hud: hidden in ' + (src.driveMode ? src.driveMode() : '?') + ' mode'); }
                return;
            }
            if (!layer) { makeLayer(); if (!layer) return; }
            claim.hold(true);
            if (hiddenLogged) { hiddenLogged = false; log.info('hud: back on'); }
        }
        if (!layer) return;
        // nothing to draw while the HUD isn't showing (behind BMW's content, disabled, unavailable):
        // the first frame after it is sent whole. No target event yet: draw (it may never come).
        if (paused()) {
            first = true; lastKey = '';
            if (src.gearbox) src.gearbox.stop();
            if (src.knock) src.knock.stop();
            return;
        }
        // the gearbox unit is asked only while its readout is on
        // (with the options it draws with: "lights only" in Comfort / Eco Pro has no gearbox readout)
        const oNow = optsNow();
        if (src.gearbox) { if (oNow.gearbox) src.gearbox.start(); else src.gearbox.stop(); }
        // the engine unit's knock values only while wanted and the engine runs
        if (src.knock) { const run = isNum(src.data().rpm) && src.data().rpm > 400; if ((oNow.knock || oNow.knockWarn) && run) src.knock.start(); else src.knock.stop(); }
        const f = frameData();
        // the same inputs draw the same frame: skip it (idle, a steady cruise, no rpm)
        const key = frameKey(f);
        if (!first && key === lastKey) return;
        lastKey = key;
        drawHud(cur, f);
        if (first) {
            if (cr.pixels(layer, null, asBuffer(cur.d))) first = false;
        } else {
            const rs = changedBoxes(cur.d, prev.d, IW);
            if (!rs.length) return;
            cr.pixels(layer, rs, packRects(cur.d, IW, rs));
        }
        const t = prev; prev = cur; cur = t;
    });

    /** Everything drawHud's picture depends on, rounded to what shows (25 rpm ~ a pixel of bar). */
    function frameKey(f) {
        const d = f.d, c = f.cue, o = f.opts;
        const t = (v) => (isNum(v) ? Math.round(v) : '-');
        // the 7-segment layouts show the rpm to 10, the others draw a bar pixel per ~25 rpm
        const step = o.style === 'digital' || o.style === 'vfd' ? 10 : 25;
        // the burst moves until 500 ms and fades after 1200 ms; in between the picture stands still
        const age = f.chip && f.chip.burst ? (f.chip.age < 500 || f.chip.age > 1200 ? Math.floor(f.chip.age / 40) : 'h') : '';
        // the revs, the count-in and the peak only move the lights, the bar and the 7-segment digits: without them
        // (both switched off) the picture is the text, keyed by the readouts' values
        const moving = o.lights || o.bar !== false || o.style === 'digital' || o.style === 'vfd';
        return [moving && isNum(d.rpm) ? Math.round(d.rpm / step) : '-', gearText(d), f.down || 0, c.shift, c.limiter, (c.shift || c.limiter) ? f.blink : '',
            moving ? Math.round(c.from / 25) : '', moving ? Math.round(c.at / 25) : '', f.shift, f.redline, f.max, moving ? Math.round((f.peak || 0) / 25) : '',
            f.chip ? f.chip.verdict + (f.chip.text || '') + age : '', f.shake ? f.shake.join(',') : '', f.mode || '',
            f.readouts.map((r) => r.label + r.value + r.tone).join(','),
            o.style, o.palette, o.gear, o.rpm, o.bar, o.lights, o.gt3, o.dim, o.lightStyle, o.clearLabels, o.gearFont].join('|');
    }

    /** The tach's image layer at the current place and size, with fresh canvases (the next frame is sent whole). */
    function makeLayer() {
        const r = rect();
        // a picture, never a shader: the instrument cluster's renderer runs the HUD's shaders, and a heavy one
        // restarted the cluster on the car (1.16.1; README "HUD drawing")
        layer = cr.image({ target: 'hud', klass: 'overlay', z: 0, x: r.x, y: r.y, w: r.w, h: r.h, iw: IW, ih: IH, fps: FPS_MAX, sampling: 'bilinear' });
        if (!layer) { log.warn('hud: tach layer refused by the client'); return; }
        cur = new Canvas(IW, IH); prev = new Canvas(IW, IH); first = true; lastKey = '';
    }

    const showTach = safe('tach', () => {
        const r = rect();
        if (shown === 'tach') { if (layer) cr.set(layer, r); return; }
        dropLayer();
        // hidden by the driving mode: no layer yet, the timer makes it when the mode allows
        const hidden = calm(Date.now() < demoUntil) === 'hide';
        if (!hidden) { makeLayer(); if (!layer) return; }
        claim.hold(!hidden);
        shown = 'tach';
        // (the gearbox unit is started by the tick, only while its readout shows)
        timer = setInterval(tick, Math.round(1000 / fps()));
        log.info('hud: tach on at ' + r.x + ',' + r.y + ' ' + r.w + 'x' + r.h);
    });

    /*
     * Shared with a standing HUD app (Cluster functions, kit/hud_claim.js): while Redline draws on the HUD it holds
     * it and the other gives way (not while its tach is hidden in Comfort / Eco Pro). With one there and setting
     * hudHandBack on, Redline's HUD lasts until the car is switched off (vehicle state from drive or ignition back to
     * parked) or the head unit starts again; off (the default), it stays on.
     */
    const claim = new HudClaim('redline', log);
    // With In Comfort / Eco Pro on Don't show, Redline already gives the HUD back outside Sport (a drive starts in
    // Comfort: the standing app's HUD first, Redline's in Sport), so its HUD stays on and nothing is handed back.
    const handBack = (why) => {
        if (mode() === 'off' || !settings.get('hudHandBack') || comfortMode(settings) === 'hide' || !HudClaim.standingOn('redline')) return false;
        log.info('hud: ' + why + ': off, the HUD back to the app that stands on it');
        settings.set('hud', 'off');
        return true;
    };
    // a new start: the standing app may start after Redline, so it is looked for during START_LOOK_MS
    if (mode() !== 'off' && !claim.thisBoot()) {
        const t0 = Date.now();
        const look = setInterval(safe('start', () => {
            if (handBack('the head unit started again') || mode() === 'off' || Date.now() - t0 > START_LOOK_MS) clearInterval(look);
        }), 2000);
        if (look.unref) look.unref();
        handBack('the head unit started again');
    }
    let ignition = false;
    const condTimer = setInterval(safe('condition', () => {
        const c = src.data && src.data().condition;
        if (!isNum(c)) return;
        if (c >= 7) ignition = true;
        else if (c <= 5 && ignition) { ignition = false; handBack('the car was switched off'); }
    }), 2000);
    if (condTimer.unref) condTimer.unref();

    const apply = safe('apply', () => {
        const m = mode();
        claim.hold(m !== 'off');
        if (m === 'off') { disconnect(); return; }
        connect();
        if (!cr) return;
        if (m === 'test') showTestPattern(); else showTach();
    });

    const HUD_KEYS = ['hud', 'hudSize', 'hudX', 'hudY'];
    settings.onChange(safe('setting', (key) => {
        if (key === 'hudFps' && timer) { clearInterval(timer); timer = setInterval(tick, Math.round(1000 / fps())); log.info('hud: ' + fps() + ' fps'); return; }
        if (HUD_KEYS.indexOf(key) < 0 && shown !== 'test') { first = true; return; }
        if (shown === 'test' && key !== 'hud') shown = '';         // redraw the pattern with the tach moved
        apply();
    }));
    apply();

    /** An upshift at rpm (its peak): if it followed a flash on a climb, learn the reaction time. */
    const upshift = safe('upshift', (rpm) => {
        const f = flashInfo;
        flashInfo = null;
        if (!f || !isNum(rpm) || Date.now() - f.t > 2000 || f.rate < 300) return;
        if (f.fall !== null && Date.now() - f.fall > 700) { log.info('hud: shift after a lift, not used for the reaction time'); return; }
        // in D or S the gearbox picks the moment: only shifts made by hand (M) say anything about you
        const m = src.mode ? src.mode() : null;
        if (m === 'D' || m === 'S') return;
        const lateMs = (rpm - f.target) / f.rate * 1000;
        const ideal = reactionMs(f, rpm);
        const before = learnedLead;
        learnedLead = Math.round(clamp(learnedLead + (ideal - learnedLead) * 0.3, 0, 600) / 10) * 10;
        leadShifts++;
        log.info('hud: shift at ' + Math.round(rpm) + ' for ' + f.target + ' (' + (lateMs >= 0 ? Math.round(lateMs) + ' ms late' : Math.round(-lateMs) + ' ms early') +
            '), reaction lead now ' + learnedLead + ' ms after ' + leadShifts + ' shifts');
        // written only when the lead moves (once settled, seldom)
        if (learnedLead !== before) writeAtomic(leadFile, JSON.stringify({ ms: learnedLead, n: leadShifts }), log);
    });

    // cluster-render is a separate install: the MGU Store's Cluster renderer
    const NOT_RUNNING = 'HUD: cluster-render not running · install Cluster renderer from the MGU Store';
    /** One line for Redline's screen: what the HUD is doing. */
    function status() {
        const m = mode();
        if (m === 'off') return '';
        if (!cr || !cr.ready) return NOT_RUNNING;
        if (target && target.disabled) return 'HUD: off after display errors';
        if (m === 'test') return 'HUD: test pattern';
        if (shown === 'tach' && !layer) return 'HUD: hidden in Comfort / Eco Pro';
        const st = target ? target.state : '';
        if (st === 'shown') return 'HUD: on';
        if (st === 'parked' || st === 'waiting') return 'HUD: giving way to BMW';
        if (st === 'unavailable') return 'HUD: not available';
        return 'HUD: starting';
    }

    // frame: one frame's data without drawing (for tests)
    /** The learned reaction time for the Learned page: { ms, shifts, auto } (auto: the setting is on Auto). */
    function learned() { return { ms: leadMs(), shifts: leadShifts, auto: num('hudLead', -1) < 0 }; }
    /** Forget the learned reaction time (back to 200 ms). */
    function resetLead() {
        learnedLead = 200; leadShifts = 0;
        try { fs.unlinkSync(leadFile); } catch (e) { /* gone */ }
        log.info('hud: reaction time reset');
    }

    /** "Play on HUD": the scripted drive (demoAt) on the HUD for ms (two loops by default). */
    // profile: which setup plays ('sport' / 'comfort': the HUD looks page's)
    const play = safe('play', (ms, profile) => { playProfile = profile === 'comfort' ? 'comfort' : 'sport'; demoStart = Date.now(); demoUntil = demoStart + (ms || 2 * DEMO_MS); first = true; log.info('hud: playing the demo (' + playProfile + ')'); });
    const stopPlay = () => { demoUntil = 0; first = true; };

    return { stop: () => { clearInterval(slotTimer); disconnect(); }, status: status, upshift: upshift, lead: leadMs, learned: learned, resetLead: resetLead, frame: frameData,
        play: play, stopPlay: stopPlay, playing: () => Date.now() < demoUntil };
}

module.exports = { start, optsFrom, PROFILE_KEYS, profileOf, comfortMode, profileView, profileSnapshot, setComfortMode, migrateProfiles, reactionMs, gearFontOf, M_STYLES, placeOf, outsideGlass, HUD_WINDOW, readoutsFor, rpmItem, MAX_READOUTS, driveModeOf, calmFor, calmOpts, demoAt, DEMO_MS, shiftCue, drawDown, writeAtomic, changedBoxes, packRects, drawHud, drawTestPattern, changedBox, packRect, IW, IH, BASE_X, BASE_Y, SCENE_W, SCENE_H, Draw };
