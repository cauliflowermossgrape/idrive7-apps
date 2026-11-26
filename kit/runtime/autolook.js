'use strict';
/**
 * autolook.js - the "Auto" colour themes: the look follows the light and the speed, so the screen is easy to read in
 * bright sun and calm at night, without the driver picking a theme twice a day.
 *
 *   Day     more contrast: text and lines brighter, edges clearer
 *   Night   big areas darker, text softer, accents toned down; warnings (warn, crit) stay as bright as by day
 *   Fast    above FAST_ON km/h (back below FAST_OFF after FAST_HOLD_MS): secondary text and ticks quieter, so the
 *           numbers that matter stand out; combines with day or night
 *
 * Inputs, both read as other apps read them: the car's day / night (Vehicle statusDayNightChangeOver, as Ambient
 * config) and the speed (Vehicle2 statusCarSpeed2, as kit/car.js). The car's day / night must hold NIGHT_HOLD_MS
 * before the look follows it (no flicker in a tunnel or under a bridge); until the car has said anything the clock
 * decides (07:00 to 19:00 is day) and the Display look page says so. Changes blend over BLEND_MS.
 * No light sensor, display brightness, rain or fog signal is read by any app, so none is used here.
 *
 *   const look = attach({ settings, signals, log })   // once per app
 *   look.theme()     the theme for this frame (themes.js shape); a plain theme id passes straight through
 *   look.row()       the "Display look" settings row (null when the app has no theme setting)
 *   autolook.AUTO    the Auto choices, for build.py and the tests
 *   autolook.compose(base, nightBase, n, f)   the look at night share n and fast share f (0..1), for the tests
 */
const themes = require('./themes');

const AUTO = {
    auto: { label: 'Auto (by light)', base: 'm_tricolour', night: 'm_tricolour' },
    auto_amber: { label: 'Auto, amber at night', base: 'm_tricolour', night: 'amber' },
};
const NIGHT_HOLD_MS = 10000, BLEND_MS = 3000, FAST_ON = 100, FAST_OFF = 90, FAST_HOLD_MS = 3000, STEPS = 5;
const DAY_NIGHT = { KEINE_AENDERUNG: 0, TAG: 1, NACHT: 2, SIGNAL_UNGUELTIG: 3 };
const SPEED = { factor: 0.015625, invalid: 65535 };
// the colours a look leaves alone: warnings must read the same day and night
const KEEP = ['warn', 'crit', 'cold'];

/* ---- colours: '#rrggbb' or '#rrggbbaa' ---- */
const hex = (c) => (typeof c === 'string' && /^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(c));
function parse(c) { return [1, 3, 5, 7].map((i) => (i < c.length ? parseInt(c.slice(i, i + 2), 16) : 255)); }
function fmt(v, alpha) {
    const h = (x) => ('0' + Math.round(Math.max(0, Math.min(255, x))).toString(16)).slice(-2);
    return '#' + h(v[0]) + h(v[1]) + h(v[2]) + (alpha ? h(v[3]) : '');
}
/** a mixed f of the way to b (f 0..1); alpha kept when either has one. */
function mix(a, b, f) {
    if (!hex(a) || !hex(b)) return f < 0.5 ? a : b;
    const pa = parse(a), pb = parse(b);
    return fmt(pa.map((x, i) => x + (pb[i] - x) * f), a.length > 7 || b.length > 7);
}
/** a with its alpha times k. */
function fade(a, k) { if (!hex(a)) return a; const p = parse(a); p[3] *= k; return fmt(p, true); }

function blend(a, b, f) {
    const out = {};
    Object.keys(a).forEach((k) => {
        const x = a[k], y = b[k];
        if (y === undefined) out[k] = x;
        else if (Array.isArray(x) && Array.isArray(y)) out[k] = x.length === y.length ? x.map((c, i) => mix(c, y[i], f)) : (f < 0.5 ? x : y);
        else if (typeof x === 'string' && hex(x)) out[k] = mix(x, y, f);
        else out[k] = f < 0.5 ? x : y;
    });
    Object.keys(b).forEach((k) => { if (!(k in out)) out[k] = b[k]; });
    return out;
}

/** By day: a little more contrast than the base theme. */
function dayLook(base) {
    const t = Object.assign({}, base);
    t.text = mix(base.text, '#ffffff', 0.6);
    t.dim = mix(base.dim, base.text, 0.45);
    t.tick = mix(base.tick, base.text, 0.35);
    t.panelEdge = mix(base.panelEdge, base.text, 0.25);
    t.track = mix(base.track, base.text, 0.06);
    return t;
}
/** At night: big areas darker, text softer, accents toned down; warnings untouched. */
function nightLook(base) {
    const t = Object.assign({}, base), soft = (c, f) => mix(c, base.bg, f);
    t.bg = mix(base.bg, '#000000', 0.7);
    t.panelTop = mix(base.panelTop, '#000000', 0.65);
    t.panelBottom = mix(base.panelBottom, '#000000', 0.7);
    t.panelEdge = soft(base.panelEdge, 0.35);
    t.track = soft(base.track, 0.3);
    t.text = mix(base.text, base.dim, 0.45);
    t.dim = soft(base.dim, 0.35);
    t.tick = soft(base.tick, 0.4);
    ['accent', 'accent2', 'ok', 'bar', 'hang', 'sel', 'marker', 'oil', 'tab'].forEach((k) => { if (hex(base[k])) t[k] = soft(base[k], 0.35); });
    ['stripes', 'ramp', 'hotRamp'].forEach((k) => { if (Array.isArray(base[k])) t[k] = base[k].map((c) => soft(c, 0.35)); });
    if (hex(base.glow)) t.glow = fade(base.glow, 0.5);
    KEEP.forEach((k) => { t[k] = base[k]; });
    return t;
}
/** Fast: what is not the number itself quieter. */
function fastLook(t, f) {
    const o = Object.assign({}, t);
    o.dim = mix(t.dim, t.bg, 0.5 * f);
    o.tick = mix(t.tick, t.bg, 0.45 * f);
    o.panelEdge = mix(t.panelEdge, t.bg, 0.3 * f);
    return o;
}
/** The look at night share n and fast share f (0..1): day of base blended into night of nightBase. */
function compose(base, nightBase, n, f) {
    const b = themes.theme(base), nb = themes.theme(nightBase);
    let t = blend(dayLook(b), nightLook(nb), n);
    if (f > 0) t = fastLook(t, f);
    return t;
}

/**
 * The state behind the look: night and fast, each a held decision and a share that moves toward it over BLEND_MS.
 * now() injectable for the tests.
 */
class LookState {
    constructor(now) {
        this.now = now || Date.now;
        this.carNight = null;       // what the car last said: true night, false day, null not yet
        this.carSince = 0;          // since when it says so
        this.night = null;          // the decision (null: by the clock)
        this.fast = false;
        this.slowSince = 0;
        this.speed = null;
        this.n = null; this.f = 0; this.atN = 0; this.atF = 0;
    }
    /** the car's day / night (1 day, 2 night, or the names) */
    dayNight(v) {
        const x = v && typeof v === 'object' ? v.dayNightChangeOver : v, c = typeof x === 'string' ? DAY_NIGHT[x] : x;
        if (c !== 1 && c !== 2) return;
        const isNight = c === 2;
        if (isNight !== this.carNight) { this.carNight = isNight; this.carSince = this.now(); }
    }
    speedKmh(kmh) {
        if (typeof kmh !== 'number' || !isFinite(kmh)) return;
        this.speed = kmh;
    }
    /** true while the clock decides (the car has not said day or night yet). */
    byClock() { return this.night === null && this.carNight === null; }
    clockNight() { const h = new Date(this.now()).getHours(); return h < 7 || h >= 19; }
    /** advances the decisions and the shares; returns { n, f } (0..1). */
    tick() {
        const t = this.now();
        // the car's word, once it held NIGHT_HOLD_MS (either way: a tunnel does not flip the screen)
        if (this.carNight !== null && t - this.carSince >= NIGHT_HOLD_MS && this.night !== this.carNight) {
            this.night = this.carNight;
            // the blend starts when the car's word had held long enough, not at the last frame before
            this.atN = Math.max(this.atN, this.carSince + NIGHT_HOLD_MS);
        }
        const wantN = this.night === null ? (this.carNight === null ? (this.clockNight() ? 1 : 0) : (this.n === null ? 0 : this.n >= 0.5 ? 1 : 0)) : (this.night ? 1 : 0);
        if (typeof this.speed === 'number') {
            if (this.speed > FAST_ON) { this.fast = true; this.slowSince = 0; }
            else if (this.speed < FAST_OFF) {
                if (!this.slowSince) this.slowSince = t;
                if (this.fast && t - this.slowSince >= FAST_HOLD_MS) this.fast = false;
            } else this.slowSince = 0;
        }
        const wantF = this.fast ? 1 : 0;
        if (this.n === null) { this.n = wantN; this.f = wantF; this.atN = this.atF = t; return { n: this.n, f: this.f }; }
        const toward = (x, w, from) => { const step = Math.max(0, t - from) / BLEND_MS; return x < w ? Math.min(w, x + step) : Math.max(w, x - step); };
        this.n = toward(this.n, wantN, this.atN);
        this.f = toward(this.f, wantF, this.atF);
        this.atN = this.atF = t;
        return { n: this.n, f: this.f };
    }
}

/* ---- the settings row's page ---- */
function lookSheet(look) {
    return {
        title: 'Display look',
        draw(r, t) {
            r.clear(t.bg);
            const st = look.state, id = look.id(), a = AUTO[id], targets = [];
            r.text('Display look', 40, 88, 34, t.text, { font: 'bold' });
            r.text(a ? a.label + ': the colours follow the light and the speed.' : 'Pick an Auto colour theme in Settings to have the look follow the light.', 40, 126, 22, t.text);
            // what the look goes by
            const src = st.byClock() ? 'the clock (07:00 to 19:00 is day): the car has not said day or night yet'
                : 'the car: ' + (st.carNight ? 'night' : 'day') + (st.night !== st.carNight && ((st.n || 0) >= 0.5) !== st.carNight ? ' (waiting ' + Math.max(0, Math.ceil((NIGHT_HOLD_MS - (look.state.now() - st.carSince)) / 1000)) + ' s, no flicker)' : '');
            r.text('Goes by ' + src, 40, 170, 22, t.text);
            r.text('Speed: ' + (typeof st.speed === 'number' ? Math.round(st.speed) + ' km/h' : 'not known') + (st.fast ? ', fast look on (above ' + FAST_ON + ' km/h)' : ''), 40, 204, 22, t.text);
            const bar = (y, label, v) => {
                r.text(label, 40, y + 18, 20, t.dim, { font: 'bold' });
                r.roundRect(200, y + 4, 520, 16, 8, t.track);
                r.roundRect(200, y + 4, Math.max(16, 520 * v), 16, 8, t.accent);
                r.text(Math.round(v * 100) + ' %', 740, y + 18, 20, t.text);
            };
            bar(232, 'NIGHT', st.n || 0);
            bar(266, 'FAST', st.f || 0);
            // the three looks side by side, the active one outlined
            const base = a ? a.base : 'm_tricolour', nb = a ? a.night : 'm_tricolour';
            const looks = [['Day', compose(base, nb, 0, 0), (st.n || 0) < 0.5 && !st.fast], ['Night', compose(base, nb, 1, 0), (st.n || 0) >= 0.5 && !st.fast], ['Fast', compose(base, nb, st.n >= 0.5 ? 1 : 0, 1), st.fast]];
            looks.forEach(([name, lt, on], i) => {
                const x = 40 + i * 340, y = 308, w = 320, h = 190;
                r.roundRect(x, y, w, h, 12, lt.bg);
                r.roundRect(x + 10, y + 10, w - 20, h - 20, 10, lt.panelTop);
                if (on && a) r.strokeRoundRect(x - 4, y - 4, w + 8, h + 8, 14, 3, t.sel || t.accent);
                r.text(name.toUpperCase(), x + 24, y + 40, 18, lt.dim, { font: 'bold', spacing: 2 });
                r.text('96', x + 24, y + 110, 64, lt.text, { font: 'num' });
                r.text('km/h', x + 110, y + 110, 22, lt.dim);
                r.roundRect(x + 24, y + 132, w - 48, 10, 5, lt.track);
                r.roundRect(x + 24, y + 132, (w - 48) * 0.6, 10, 5, lt.accent);
                r.text('oil hot', x + 24, y + 168, 18, lt.crit, { font: 'bold' });
            });
            const bx = 1100, by = 410, bw = 460;
            r.roundRect(bx, by, bw, 60, 12, t.sel || t.accent);
            r.text('Back', bx + bw / 2, by + 39, 24, t.selText || t.bg, { align: 'center', font: 'bold' });
            targets.push({ x: bx, y: by, w: bw, h: 60, act: () => 'close' });
            ['No light sensor, rain or fog signal', 'reaches the apps, so the look goes by', 'day, night and speed. Warnings keep', 'their colour day and night.']
                .forEach((line, i) => r.text(line, 1100, 318 + i * 24, 18, t.text));
            return targets;
        },
        press() { return 'close'; },
        back() { return 'close'; },
    };
}

/**
 * attach({ settings, signals, log, now }): one per app. The signals are watched only once an Auto theme is chosen,
 * so apps that keep a fixed theme ask the car for nothing more.
 */
function attach(o) {
    const settings = o.settings, log = o.log;
    const state = new LookState(o.now);
    let watching = false, cacheKey = null, cache = null;
    const id = () => settings.get('theme');
    const watch = () => {
        if (watching || !o.signals || !o.signals.watch) return;
        watching = true;
        const w = (iface, h) => Promise.resolve(o.signals.watch(iface, '1', h, log)).catch((e) => log && log.warn && log.warn('display look: ' + iface + ': ' + (e && e.message || e)));
        w('de.bmw.infotainment.vehicle.Vehicle', { statusDayNightChangeOver: (v) => state.dayNight(v) });
        w('de.bmw.infotainment.vehicle.Vehicle2', {
            statusCarSpeed2: (v) => { const raw = v && v.speedVehicleCentreOfGravity; if (typeof raw === 'number' && raw !== SPEED.invalid) state.speedKmh(raw * SPEED.factor); },
        });
    };
    const look = {
        state, id,
        theme() {
            const a = AUTO[id()];
            if (!a) return themes.theme(id());
            watch();
            const s = state.tick();
            // the share in STEPS steps: a theme object (and the layers cached under its name) changes a few times per
            // blend, not every frame
            const n = Math.round(s.n * STEPS) / STEPS, f = Math.round(s.f * STEPS) / STEPS, key = id() + n + '|' + f;
            if (key !== cacheKey) {
                cacheKey = key;
                cache = compose(a.base, a.night, n, f);
                cache.name = a.label + ' ' + n + ' ' + f;
                cache.lookKey = key;
            }
            return cache;
        },
        row() {
            const s = settings.item ? settings.item('theme') : null;
            if (!s) return null;
            return {
                label: 'Display look',
                value: () => (AUTO[id()] ? (state.fast ? 'fast' : (state.n || 0) >= 0.5 ? 'night' : 'day') + (state.byClock() ? ', by the clock' : ', by the car') : 'fixed theme: choose an Auto one'),
                open: () => lookSheet(look),
            };
        },
    };
    return look;
}

module.exports = { attach, compose, LookState, AUTO, NIGHT_HOLD_MS, BLEND_MS, FAST_ON, FAST_OFF, FAST_HOLD_MS, mix };
