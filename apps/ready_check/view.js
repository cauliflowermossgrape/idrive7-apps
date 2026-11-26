'use strict';
/**
 * view.js - Ready Check's four pages:
 *
 *   Ready?           the verdict in one word and a sentence, and a card for each thing checked: its value, a bar with
 *                    its bands (cold, ready, hot) and a marker where it is now
 *   Trend            oil, coolant and gearbox oil over the last 10 minutes with the oil's ready band shaded, and how
 *                    fast each is warming
 *   After the drive  the turbo cool-down (Warm-Up's estimate): how long to drive gently before switching off, with
 *                    the last 3 minutes of rpm and power against the "hard" and "gentle" lines
 *   How it works     plain words
 *
 *   draw(cv, t, page, s)   s = { list, verdict, hist, now, outside, cool, power, set, T, tU, demo }
 */
const G = require('./kit/gauges');
const { withAlpha } = require('./kit/canvas');
const { HOT } = require('./checks');

const GO = '#2fd27a', GEAR_C = '#b98cff';
const isNum = (x) => typeof x === 'number' && isFinite(x);
const zoneCol = (t, c) => (c === 'go' ? GO : c === 'cold' ? t.cold || '#4aa8ff' : c === 'warn' ? t.warn : t.crit);
const stateCol = (t, st) => (st === 'ok' ? GO : st === 'cold' ? t.cold || '#4aa8ff' : st === 'check' ? t.warn : st === 'hot' ? t.crit : t.dim);
const PILL = { ok: 'OK', cold: 'COLD', check: 'CHECK', hot: 'TOO HOT', none: 'NO DATA' };

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

/** A bar from scale[0] to scale[1] in its bands, a marker at v, the ends and the band edges written under it. */
function band(cv, t, x, y, w, h, c, v, T) {
    const [lo, hi] = c.scale, X = (val) => x + G.clamp((val - lo) / (hi - lo), 0, 1) * w;
    cv.roundRect(x, y, w, h, h / 2, t.track);
    c.zones.forEach((z) => {
        const a = X(Math.max(z.from, lo)), b = X(Math.min(z.to, hi));
        if (b - a > 1) cv.fillRect(a, y + 2, b - a, h - 4, withAlpha(zoneCol(t, z.color), 0.45));
    });
    const edges = (c.edges || c.zones.map((z) => z.from)).filter((e) => e > lo && e < hi);
    edges.forEach((e) => cv.text(String(Math.round(T(e))), X(e), y + h + 20, 15, t.dim, { align: 'center' }));
    if (isNum(v)) {
        const mx = X(v);
        cv.fillRect(mx - 2, y - 8, 4, h + 16, t.text);
        cv.fill([[mx - 9, y - 16], [mx + 9, y - 16], [mx, y - 6]], t.text);
    }
}

/* ---------------- Ready? ---------------- */
function ready(cv, t, s) {
    const vd = s.verdict, col = stateCol(t, vd.state);
    G.panel(cv, t, 24, 44, 440, 468, 'The verdict');
    cv.roundRect(44, 100, 400, 104, 14, withAlpha(col, 0.16));
    cv.text(vd.word, 244, 172, vd.word.length > 7 ? 54 : 64, col, { align: 'center', font: 'bold', spacing: 2 });
    let y = 240;
    wrap(cv, vd.why, 20, 392).forEach((l) => { cv.text(l, 48, y, 20, t.text); y += 28; });
    if (isNum(s.eta) && vd.state === 'cold') {
        y += 8;
        cv.text('READY IN ABOUT', 48, y, 15, t.dim, { font: 'bold', spacing: 1.5 });
        const bw = cv.text(String(Math.max(1, Math.round(s.eta))), 48, y + 44, 44, t.text, { font: 'num' });
        cv.text('min', 56 + (bw || 30), y + 44, 22, t.dim);
        y += 58;
    }
    if (vd.notes.length) {
        y += 24;
        cv.text('ALSO CHECK', 48, y, 15, t.warn, { font: 'bold', spacing: 1.5 });
        vd.notes.slice(0, 3).forEach((n) => { wrap(cv, n, 17, 392).forEach((l) => { y += 24; cv.text(l, 48, y, 17, t.text); }); });
    }
    if (isNum(s.outside)) {
        const o = Math.round(s.T(s.outside)) + s.tU();
        cv.text('Outside ' + o + (s.outside < 5 ? ': a cold day, warming takes longer' : s.outside > 30 ? ': a hot day, watch the temperatures' : ''), 48, 494, 16, t.dim);
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

/* ---------------- Trend ---------------- */
const LINES = [['oil', 'Engine oil', 1, 'accent'], ['coolant', 'Coolant', 2, 'cold'], ['gearbox', 'Gearbox oil', 3, GEAR_C]];
function trend(cv, t, s) {
    G.panel(cv, t, 24, 44, 1100, 468, 'The last 10 minutes');
    const x = 40, y = 104, w = 1068, h = 360, pad = { l: 44, b: 26, t: 26 };
    const yMin = s.T(0), yMax = s.T(140), px = x + pad.l, pw = w - pad.l - 8, py = y + pad.t, ph = h - pad.t - pad.b;
    const Y = (v) => py + ph - (v - yMin) / (yMax - yMin) * ph;
    // the oil's ready band, under the lines
    const a = Y(s.T(HOT.oil[0])), b = Y(s.T(s.set.warmOil));
    cv.fillRect(px, a, pw, b - a, withAlpha(GO, 0.1));
    cv.text('oil ready band: ' + Math.round(s.T(s.set.warmOil)) + ' to ' + Math.round(s.T(HOT.oil[0])) + s.tU(), px + 10, a + 20, 15, GO, { font: 'bold' });
    const col = (c) => (c === 'accent' ? t.accent : c === 'cold' ? t.cold || '#4aa8ff' : c);
    G.chart(cv, t, x, y, w, h, { padTop: pad.t, xMin: -10, xMax: 0, xStep: 2, yMin, yMax, yStep: s.set.unitF ? 50 : 20, yFmt: (v) => Math.round(v) + '\u00b0',
        xFmt: (v) => (v === 0 ? 'now' : v + ' min'),
        marks: [{ y: s.T(s.set.warmOil), color: GO }],
        series: LINES.map(([k, , idx, c]) => ({ pts: s.hist.map((p) => [(p[0] - s.now) / 60000, s.T(p[idx])]), color: col(c), width: k === 'oil' ? 3.5 : 2.5 })),
        empty: 'Collecting: a point every 5 seconds' });
    let lx = 64;
    LINES.forEach(([, name, , c]) => { cv.fillRect(lx, 488, 22, 5, col(c)); lx += 30; cv.text(name, lx, 495, 17, t.text); lx += cv.textWidth(name, 17) + 34; });
    cv.text('temperatures in ' + s.tU() + ', a point every 5 s', 1104, 495, 15, t.dim, { align: 'right' });

    G.panel(cv, t, 1140, 44, 436, 468, 'Warming per minute');
    LINES.forEach(([k, name, , c], i) => {
        const yy = 136 + i * 126, item = s.list.find((it) => it.key === k), r = s.rates[k];
        cv.fillRect(1160, yy - 22, 5, 108, col(c));
        cv.text(name, 1180, yy, 21, t.text, { font: 'bold' });
        cv.text(isNum(item.value) ? Math.round(s.T(item.value)) + s.tU() : 'not sent', 1556, yy, 21, isNum(item.value) ? t.text : t.dim, { align: 'right', font: 'bold' });
        const rs = isNum(r) ? (r >= 0 ? '+' : '') + (s.set.unitF ? r * 1.8 : r).toFixed(1) + ' ' + s.tU() + ' a minute' : 'not enough points yet';
        cv.text(rs, 1180, yy + 32, 18, t.dim);
        let eta = '';
        if (item.state === 'cold' && isNum(r) && r > 0.15) eta = 'ready in about ' + Math.max(1, Math.round((item.warm - item.value) / r)) + ' min';
        else if (item.state === 'cold') eta = 'warms faster when driving';
        else if (item.state === 'ok') eta = 'warm';
        else if (item.state === 'check' || item.state === 'hot') eta = item.text;
        cv.text(eta, 1180, yy + 60, 18, stateCol(t, item.state), { font: 'bold' });
        const frac = isNum(item.value) ? G.clamp(item.value / item.warm, 0, 1) : 0;
        cv.roundRect(1180, yy + 74, 376, 8, 4, t.track);
        if (isNum(item.value)) cv.roundRect(1180, yy + 74, Math.max(8, 376 * frac), 8, 4, stateCol(t, item.state));
    });
}

/* ---------------- After the drive ---------------- */
function after(cv, t, s) {
    const c = s.cool, p = G.panel(cv, t, 24, 44, 560, 468, 'Turbo cool-down (an estimate)');
    const cx = 170, cy = 236, r = 108, left = c.need > 0 ? Math.max(0, Math.ceil(c.need - c.done)) : 0;
    const frac = c.need > 0 ? G.clamp(c.done / c.need, 0, 1) : 1;
    const col = !c.need ? GO : left <= 0 ? GO : c.hardNow ? t.crit : t.warn;
    cv.arc(cx, cy, r - 14, r, 0, 360, t.track);
    if (frac > 0) cv.arc(cx, cy, r - 14, r, 0, 360 * frac, col);
    const big = !c.need ? 'OK' : left > 0 ? String(left) : 'OK';
    const bw = cv.textWidth(big, 64, { font: big === 'OK' ? 'bold' : 'num' });
    cv.text(big, cx - (left > 0 && c.need ? 12 : 0), cy + 20, 64, col, { align: 'center', font: big === 'OK' ? 'bold' : 'num' });
    if (left > 0 && c.need) cv.text('s', cx + bw / 2 - 4, cy + 20, 24, t.dim);
    const head = !c.need ? 'Nothing to cool down' : left <= 0 ? 'Cooled down' : c.hardNow ? 'Still driving hard' : 'Drive gently';
    const lines = !c.need ? ['No hard driving yet on this drive.', 'You can switch off when you like.']
        : left <= 0 ? ['The turbo had its gentle minutes.', 'You can switch off now.']
            : ['Keep under 2800 rpm and 40 kW for', left + ' s more before you switch off.', 'Idling counts, but driving cools faster.'];
    cv.text(head, 312, 160, 24, col, { font: 'bold' });
    lines.forEach((l, i) => cv.text(l, 312, 196 + i * 26, 17, t.text));
    cv.text('HARD DRIVING THIS DRIVE', 312, 300, 14, t.dim, { font: 'bold', spacing: 1.5 });
    cv.text(Math.round(c.hard) + ' s', 312, 336, 30, t.text, { font: 'num' });
    cv.text('asks for ' + Math.round(c.need) + ' s gently', 430, 336, 17, t.dim);
    ['How it is worked out: 30 s, plus 3 s for each second of hard', 'driving (over 3800 rpm or 90 kW), at most 3 minutes.', 'The car does not send the turbo\'s temperature: this is an estimate.']
        .forEach((l, i) => cv.text(l, 48, 410 + i * 26, 16, t.dim));
    void p;

    G.panel(cv, t, 600, 44, 976, 468, 'The last 3 minutes');
    const pts = (f) => s.power.map((q) => [(q[0] - s.now) / 1000, f(q)]);
    const xf = (v) => (v === 0 ? 'now' : v + ' s');
    G.chart(cv, t, 616, 104, 944, 182, { padTop: 22, xMin: -180, xMax: 0, xStep: 30, xFmt: xf, yMin: 0, yMax: 7000, yStep: 2000, padLeft: 76,
        yFmt: (v) => (v ? (v / 1000) + 'k rpm' : '0'),
        marks: [{ y: 3800, color: t.crit, label: 'hard over 3800' }, { y: 2800, color: GO, label: 'gentle under 2800' }],
        series: [{ pts: pts((q) => q[1]), color: t.accent, width: 2.5, fill: 0.12 }], empty: 'Waiting for the engine' });
    G.chart(cv, t, 616, 294, 944, 182, { padTop: 22, xMin: -180, xMax: 0, xStep: 30, xFmt: xf, yMin: 0, yMax: 250, yStep: 50, padLeft: 76, yFmt: (v) => (v ? v + ' kW' : '0'),
        marks: [{ y: 90, color: t.crit, label: 'hard over 90 kW' }, { y: 40, color: GO, label: 'gentle under 40 kW' }],
        series: [{ pts: pts((q) => q[2]), color: t.warn, width: 2.5, fill: 0.12 }] });
    cv.text('Heat soak: after hard driving the engine bay and intake stay hot. Drive the last minutes gently rather than idling.', 624, 500, 15, t.dim);
}

/* ---------------- How it works ---------------- */
function help(cv, t, s) {
    G.panel(cv, t, 24, 44, 1552, 468, 'How Ready Check works');
    [
        ['1', 'It watches what the car sends.', 'Engine oil, coolant and gearbox oil temperatures, the 12 V battery charge, the fuel range and the tyre pressures.'],
        ['2', 'Temperatures decide the verdict.', 'Cold oil: NOT YET, drive gently. All warm: READY for harder driving. Too hot: TOO HOT, ease off. The ready temperatures are in Settings.'],
        ['3', 'The rest is a reminder.', 'A low 12 V battery, under 150 km of fuel or a tyre under 95 % of its target pressure is listed under the verdict, without blocking it.'],
        ['4', 'After hard driving it tells you when to switch off.', 'Hard driving builds up a cool-down time; drive gently until it runs out. It is an estimate: the car does not send the turbo\'s temperature.'],
    ].forEach((r, i) => {
        const y = 118 + i * 88;
        cv.circle(64, y - 8, 20, withAlpha(t.accent, 0.3));
        cv.text(r[0], 64, y, 22, t.text, { align: 'center', font: 'bold' });
        cv.text(r[1], 104, y, 23, t.text, { font: 'bold' });
        cv.text(r[2], 104, y + 30, 18, t.dim);
    });
    cv.text('It only reads signals the car sends anyway; nothing is asked of or written to any control unit. A value this car does not send shows "not sent".', 48, 496, 16, t.dim);
    void s;
}

function draw(cv, t, page, s) {
    if (page === 1) trend(cv, t, s);
    else if (page === 2) after(cv, t, s);
    else if (page === 3) help(cv, t, s);
    else ready(cv, t, s);
}

module.exports = { draw, wrap };
