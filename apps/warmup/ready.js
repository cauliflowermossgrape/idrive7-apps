'use strict';
/**
 * ready.js - Warm-Up's Ready? tab (from Ready Check, #252): is the car ready for harder driving, and may I switch off
 * after it? Its judgement is kept apart from the drawing so it can be tested.
 *
 *   checks(s, set) -> [{ key, label, value, unit, text, state: 'ok' | 'cold' | 'check' | 'hot' | 'none', scale, zones }]
 *       s   = { oil, coolant, gearbox, soc12, range, fuel, tyres: { lowest, which } } (deg C, %, km, l, share of target)
 *       set = { warmOil, warmCoolant, warmGearbox }
 *   verdict(list) -> { word: 'READY' | 'NOT YET' | 'TOO HOT' | 'NO DATA', state, why, notes: [text] }
 *   draw(cv, t, s) the page: the verdict with its reason, "ready in about", what else to check, the turbo cool-down
 *       (Warm-Up's own estimate, the same countdown as on the Warm-up tab) with the last 3 minutes of rpm and power,
 *       and a card for each thing checked: its value, a bar with its bands (cold, ready, hot) and a marker
 *       s = { list, verdict, eta, outside, cool: { left, need, done, gentle } | null, power: [[t, rpm, kw]], now, T, tU }
 *
 * Temperatures decide the verdict (cold: NOT YET, too hot: TOO HOT). The 12 V battery, fuel and tyres never block
 * it: they are things to check, listed under it.
 */
const G = require('./kit/gauges');
const { withAlpha } = require('./kit/canvas');

const isNum = (v) => typeof v === 'number' && isFinite(v);
const GO = '#2fd27a';
// above these the value is no longer "fine" (check) and then too hot; the Warm-up tab eases off the gearbox at 125 deg C
const HOT = { oil: [120, 135], coolant: [110, 118], gearbox: [110, 125] };
const PILL = { ok: 'OK', cold: 'COLD', check: 'CHECK', hot: 'TOO HOT', none: 'NO DATA' };
const HARD_RPM = 3800, HARD_KW = 90, GENTLE_RPM = 2800;   // as the cool-down in main.js

function temp(key, label, v, warm) {
    const [check, hot] = HOT[key];
    const zones = [{ from: -40, to: warm, color: 'cold' }, { from: warm, to: check, color: 'go' }, { from: check, to: hot, color: 'warn' }, { from: hot, to: 160, color: 'crit' }];
    const base = { key, label, value: v, unit: 'C', scale: [0, 150], zones, temp: true, warm };
    if (!isNum(v)) return Object.assign(base, { state: 'none', text: 'not sent by this car yet' });
    if (v < warm) return Object.assign(base, { state: 'cold', text: 'warming up' });
    if (v >= hot) return Object.assign(base, { state: 'hot', text: 'too hot: drive gently' });
    if (v >= check) return Object.assign(base, { state: 'check', text: 'hot: keep an eye on it' });
    return Object.assign(base, { state: 'ok', text: 'warm, ready' });
}

function checks(s, set) {
    const out = [
        temp('oil', 'Engine oil', s.oil, set.warmOil),
        temp('coolant', 'Coolant', s.coolant, set.warmCoolant),
        temp('gearbox', 'Gearbox oil', s.gearbox, set.warmGearbox),
    ];
    const b = s.soc12;
    out.push({ key: 'battery', label: '12 V battery', value: b, unit: '%', scale: [0, 100],
        zones: [{ from: 0, to: 50, color: 'crit' }, { from: 50, to: 70, color: 'warn' }, { from: 70, to: 100, color: 'go' }],
        state: !isNum(b) ? 'none' : b < 70 ? 'check' : 'ok',
        text: !isNum(b) ? 'not sent by this car yet' : b < 50 ? 'low charge: a long drive charges it' : b < 70 ? 'charge is a little low' : 'charged' });
    const r = s.range;
    out.push({ key: 'fuel', label: 'Fuel', value: r, unit: 'km', scale: [0, 800],
        zones: [{ from: 0, to: 80, color: 'crit' }, { from: 80, to: 150, color: 'warn' }, { from: 150, to: 800, color: 'go' }],
        state: !isNum(r) ? 'none' : r < 150 ? 'check' : 'ok',
        text: !isNum(r) ? 'not sent by this car yet' : (r < 80 ? 'fill up soon' : r < 150 ? 'under 150 km left' : 'range left') + (isNum(s.fuel) ? ', ' + Math.round(s.fuel) + ' l in the tank' : '') });
    const ty = s.tyres || {}, lo = ty.lowest;
    out.push({ key: 'tyres', label: 'Tyre pressure', value: isNum(lo) ? Math.round(lo * 100) : null, unit: '%', scale: [70, 110],
        zones: [{ from: 70, to: 90, color: 'crit' }, { from: 90, to: 95, color: 'warn' }, { from: 95, to: 110, color: 'go' }],
        state: !isNum(lo) ? 'none' : lo < 0.95 ? 'check' : 'ok',
        text: !isNum(lo) ? 'not sent by this car yet' : (lo < 0.9 ? 'low: ' : lo < 0.95 ? 'a little low: ' : 'at target, lowest: ') + (ty.which || '') });
    return out;
}

function verdict(list) {
    const temps = list.filter((c) => c.temp), seen = temps.filter((c) => c.state !== 'none');
    const notes = list.filter((c) => !c.temp && c.state === 'check').map((c) => c.label + ': ' + c.text);
    const hot = temps.filter((c) => c.state === 'hot'), cold = temps.filter((c) => c.state === 'cold');
    const names = (l) => l.map((c) => c.label.toLowerCase()).join(' and ');
    const be = (l) => (l.length > 1 ? ' are' : ' is');
    if (!seen.length) return { word: 'NO DATA', state: 'none', why: 'The car has not sent any temperature yet.', notes };
    if (hot.length) return { word: 'TOO HOT', state: 'hot', why: 'The ' + names(hot) + be(hot) + ' too hot. Drive gently until it comes down.', notes };
    if (cold.length) return { word: 'NOT YET', state: 'cold', why: 'The ' + names(cold) + be(cold) + ' still cold. Keep it gentle: no full throttle, no high revs.', notes };
    return { word: 'READY', state: 'ok', why: 'Everything the car sends is warm. It is ready for harder driving.', notes };
}

/* ---------------- drawing ---------------- */
const zoneCol = (t, c) => (c === 'go' ? GO : c === 'cold' ? t.cold || '#4aa8ff' : c === 'warn' ? t.warn : t.crit);
const stateCol = (t, st) => (st === 'ok' ? GO : st === 'cold' ? t.cold || '#4aa8ff' : st === 'check' ? t.warn : st === 'hot' ? t.crit : t.dim);

/** Words wrapped into lines no wider than w. */
function wrap(cv, text, size, w) {
    const out = [];
    let line = '';
    String(text).split(' ').forEach((word) => {
        const next = line ? line + ' ' + word : word;
        if (line && cv.textWidth(next, size) > w) { out.push(line); line = word; } else line = next;
    });
    if (line) out.push(line);
    return out;
}

/** A bar from scale[0] to scale[1] in its bands, a marker at v, the band edges written under it. */
function band(cv, t, x, y, w, h, c, v, T) {
    const [lo, hi] = c.scale, X = (val) => x + G.clamp((val - lo) / (hi - lo), 0, 1) * w;
    cv.roundRect(x, y, w, h, h / 2, t.track);
    c.zones.forEach((z) => {
        const a = X(Math.max(z.from, lo)), b = X(Math.min(z.to, hi));
        if (b - a > 1) cv.fillRect(a, y + 2, b - a, h - 4, withAlpha(zoneCol(t, z.color), 0.45));
    });
    const edges = (c.edges || c.zones.map((z) => z.from)).filter((e) => e > lo && e < hi);
    edges.forEach((e) => cv.text(String(Math.round(T(e))), X(e), y + h + 18, 14, t.dim, { align: 'center' }));
    if (isNum(v)) {
        const mx = X(v);
        cv.fillRect(mx - 2, y - 7, 4, h + 14, t.text);
        cv.fill([[mx - 8, y - 14], [mx + 8, y - 14], [mx, y - 5]], t.text);
    }
}

/** The cool-down: seconds left as a big number, a bar, and rpm and power over the last 3 minutes. */
function cooldown(cv, t, x, y, w, s) {
    const c = s.cool, left = Math.max(0, Math.ceil(c.left));
    cv.text('AFTER A HARD DRIVE', x, y, 15, t.warn, { font: 'bold', spacing: 1.5 });
    const lw = cv.text(String(left), x, y + 46, 40, left ? t.text : GO, { font: 'num' }) || 40;
    cv.text(left ? 's of gentle driving before switching off' : 's: cooled, ok to switch off', x + 8 + lw, y + 46, 16, t.dim);
    const f = c.need ? G.clamp(c.done / c.need, 0, 1) : 1;
    cv.roundRect(x, y + 58, w, 8, 4, t.track);
    if (f > 0) cv.roundRect(x, y + 58, Math.max(8, w * f), 8, 4, GO);
    const pts = s.power || [], top = Math.max(7000, ...pts.map((p) => p[1] || 0));
    G.chart(cv, t, x - 36, y + 74, w + 36, 78, { padLeft: 36, padBottom: 18, xMin: -3, xMax: 0, xStep: 1, yMin: 0, yMax: top, yStep: top / 2,
        yFmt: (v) => (v ? Math.round(v / 1000) + 'k' : '0'), xFmt: (v) => (v === 0 ? 'now' : v + ' min'),
        marks: [{ y: HARD_RPM, color: t.crit }, { y: GENTLE_RPM, color: GO }],
        series: [{ pts: pts.map((p) => [(p[0] - s.now) / 60000, p[1]]), color: t.accent, width: 2 },
            { pts: pts.map((p) => [(p[0] - s.now) / 60000, (p[2] || 0) / HARD_KW * HARD_RPM]), color: t.warn, width: 1.5 }] });
    cv.text('rpm (red: hard, green: gentle), power in amber', x + w, y + 74, 13, t.dim, { align: 'right' });
}

function draw(cv, t, s) {
    const vd = s.verdict, col = stateCol(t, vd.state);
    G.panel(cv, t, 24, 44, 440, 468, null);
    cv.roundRect(44, 60, 400, 84, 14, withAlpha(col, 0.16));
    cv.text(vd.word, 244, 120, vd.word.length > 7 ? 46 : 54, col, { align: 'center', font: 'bold', spacing: 2 });
    let y = 172;
    wrap(cv, vd.why, 18, 392).forEach((l) => { cv.text(l, 48, y, 18, t.text); y += 24; });
    if (isNum(s.eta) && vd.state === 'cold') {
        cv.text('READY IN ABOUT ' + Math.max(1, Math.round(s.eta)) + ' MIN', 48, y + 8, 16, t.text, { font: 'bold', spacing: 1 });
        y += 30;
    }
    if (vd.notes.length) {
        y += 10;
        cv.text('ALSO CHECK', 48, y, 14, t.warn, { font: 'bold', spacing: 1.5 });
        vd.notes.slice(0, 2).forEach((n) => { wrap(cv, n, 16, 392).forEach((l) => { y += 22; cv.text(l, 48, y, 16, t.text); }); });
    }
    if (s.cool) cooldown(cv, t, 48, Math.max(y + 34, 328), 392, s);
    else if (isNum(s.outside)) {
        const o = Math.round(s.T(s.outside)) + s.tU();
        cv.text('Outside ' + o + (s.outside < 5 ? ': a cold day, warming takes longer' : s.outside > 30 ? ': a hot day, watch the temperatures' : ''), 48, 494, 15, t.dim);
    }
    const W0 = 480, cw = 354, gap = 17, ch = 226;
    s.list.forEach((c, i) => {
        const x = W0 + (i % 3) * (cw + gap), yy = 44 + Math.floor(i / 3) * (ch + 16), sc = stateCol(t, c.state);
        G.panel(cv, t, x, yy, cw, ch, c.label);
        const word = c.temp && c.state === 'ok' ? 'READY' : c.temp && c.state === 'check' ? 'HOT' : PILL[c.state];
        G.pill(cv, t, x + cw - 120, yy + 14, 104, 28, word, { color: sc, size: 15, spacing: 1 });
        const val = c.temp ? s.T(c.value) : c.value, unit = c.temp ? s.tU() : c.unit;
        const vw = cv.text(isNum(val) ? String(Math.round(val)) : '--', x + 20, yy + 104, 52, isNum(val) ? t.text : t.dim, { font: 'num' }) || 60;
        cv.text(unit + (c.key === 'tyres' && isNum(val) ? ' of target' : ''), x + 28 + vw, yy + 104, 20, t.dim);
        cv.text(c.text + (c.temp && c.state === 'cold' ? ': ready at ' + Math.round(s.T(c.warm)) + s.tU() : ''), x + 20, yy + 134, 16, c.state === 'none' ? t.dim : t.text);
        const scale = c.temp ? { scale: [0, 150], zones: c.zones, edges: [c.warm, c.zones[3].from] } : c;
        band(cv, t, x + 20, yy + 166, cw - 40, 14, scale, c.value, c.temp ? s.T : (v) => v);
    });
}

module.exports = { checks, verdict, draw, HOT };
