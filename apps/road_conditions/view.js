'use strict';
/**
 * view.js - Road Conditions' four pages:
 *
 *   Now            the verdict in a word (ICE RISK, GUSTY, GETTING COLD, CLEAR) and why, the outside temperature, speed,
 *                  day or night; a card each for ice, side wind and the wet road (which the car cannot tell)
 *   Ice risk       the outside temperature on a scale with the freezing band, its last 30 min as a chart, where ice
 *                  forms first
 *   Side wind      how gusty it is on straight stretches at speed (an estimate from the steering corrections), the
 *                  last 30 min as a chart against the breezy and gusty lines
 *   How it works   the same in plain words
 *
 *   draw(cv, t, page, s)   s = { temp, speed, night, tracker, now, iceAt, ic, wd, ov, stats, trendC }
 */
const G = require('./kit/gauges');
const { withAlpha } = require('./kit/canvas');
const C = require('./conditions');

const GO = '#2fd27a';
const isNum = (x) => typeof x === 'number' && isFinite(x);
const one = (c) => (Math.round(c * 10) / 10).toFixed(1);
const colorOf = (t, c) => (c === 'crit' ? t.crit : c === 'warn' ? t.warn : c === 'go' ? GO : t.dim);
const ICE_COL = { ice: 'crit', watch: 'warn', clear: 'go', unknown: 'dim' }, WIND_COL = { gusty: 'warn', breezy: 'accent', calm: 'go', unknown: 'dim' };
const ago = (v) => (v === 0 ? 'now' : -v + ' min ago');
const WIND_WORD = { gusty: 'GUSTY', breezy: 'BREEZY', calm: 'CALM', unknown: 'NOT KNOWN' };

/** s broken into lines of at most w px; drawn from y, each line `step` lower. Returns the y after the last. */
function para(cv, s, x, y, w, size, color, step, opt) {
    const words = String(s).split(' ');
    let line = '';
    for (const wd of words) {
        const next = line ? line + ' ' + wd : wd;
        if (line && cv.textWidth(next, size, opt) > w) { cv.text(line, x, y, size, color, opt); y += step; line = wd; } else line = next;
    }
    if (line) { cv.text(line, x, y, size, color, opt); y += step; }
    return y;
}

/** A temperature scale from lo to hi with the ice band (0 to iceAt) and below freezing shaded, a marker at v. */
function scale(cv, t, x, y, w, v, iceAt, lo, hi, big) {
    const X = (c) => x + (G.clamp(c, lo, hi) - lo) / (hi - lo) * w, h = big ? 18 : 10;
    cv.roundRect(x, y, w, h, h / 2, t.track);
    cv.roundRect(X(lo), y, X(0) - X(lo), h, h / 2, withAlpha(t.crit, 0.55));
    cv.fillRect(X(0), y, X(iceAt) - X(0), h, withAlpha(t.warn, 0.55));
    if (big) {
        for (let c = lo; c <= hi; c += 5) cv.text(String(c), X(c), y + h + 26, 17, t.dim, { align: 'center' });
        cv.text('freezing', (X(lo) + X(0)) / 2, y - 10, 15, t.crit, { align: 'center', font: 'bold' });
        cv.text('ice risk', (X(0) + X(iceAt)) / 2, y - 10, 15, t.warn, { align: 'center', font: 'bold' });
    }
    if (isNum(v)) {
        const mx = X(v);
        cv.roundRect(mx - 3, y - (big ? 10 : 6), 6, h + (big ? 20 : 12), 3, t.text);
    }
}

/** Calm / breezy / gusty as three segments, a marker at the value. */
function windMeter(cv, t, x, y, w, wd, big) {
    const by = wd.by || 'steer', b = by === 'steer' ? C.STEER_BREEZY : C.LAT_BREEZY, g = by === 'steer' ? C.STEER_GUSTY : C.LAT_GUSTY, top = g * 1.7;
    const X = (v) => x + G.clamp(v / top, 0, 1) * w, h = big ? 18 : 10;
    cv.roundRect(x, y, X(b) - x - 2, h, h / 2, withAlpha(GO, 0.5));
    cv.fillRect(X(b), y, X(g) - X(b) - 2, h, withAlpha(t.accent, 0.5));
    cv.roundRect(X(g), y, x + w - X(g), h, h / 2, withAlpha(t.warn, 0.5));
    if (big) {
        cv.text('CALM', (x + X(b)) / 2, y + h + 24, 15, GO, { align: 'center', font: 'bold', spacing: 1.5 });
        cv.text('BREEZY', (X(b) + X(g)) / 2, y + h + 24, 15, t.accent, { align: 'center', font: 'bold', spacing: 1.5 });
        cv.text('GUSTY', (X(g) + x + w) / 2, y + h + 24, 15, t.warn, { align: 'center', font: 'bold', spacing: 1.5 });
    }
    if (isNum(wd.value)) cv.roundRect(X(wd.value) - 3, y - (big ? 10 : 6), 6, h + (big ? 20 : 12), 3, t.text);
}
const windText = (wd) => (!isNum(wd.value) ? '--' : wd.by === 'steer' ? 'steering corrections +/- ' + one(wd.value) + ' deg' : 'sideways wobble ' + wd.value.toFixed(3) + ' g');

/* Now: the verdict and the three cards. */
function now(cv, t, s) {
    G.panel(cv, t, 24, 44, 700, 468, 'Right now');
    const col = colorOf(t, s.ov.color);
    cv.roundRect(48, 104, 8, 112, 4, col);
    cv.text(s.ov.title, 76, 190, 92, col, { font: 'bold' });
    para(cv, s.ov.why, 48, 262, 650, 22, t.text, 32);
    const r = [['OUTSIDE', s.temp, '°C', 1], ['SPEED', s.speed, 'km/h', 0]];
    r.forEach((x, i) => G.readout(cv, t, 48 + i * 230, 378, { label: x[0], value: x[1], unit: x[2], decimals: x[3], size: 50, labelSize: 15 }));
    G.readout(cv, t, 508, 378, { label: 'LIGHT', text: s.night === null ? '--' : s.night ? 'night' : 'day', size: 50, labelSize: 15, font: 'bold' });

    const card = (y, title, word, wc, draw) => {
        G.panel(cv, t, 740, y, 836, 148, title);
        const pw = Math.max(130, cv.textWidth(word, 16, { font: 'bold', spacing: 2 }) + 36);
        G.pill(cv, t, 1556 - pw, y + 16, pw, 30, word, { color: wc, size: 16 });
        draw(y);
    };
    card(44, 'Ice', s.ic.title, colorOf(t, ICE_COL[s.ic.state]), (y) => {
        scale(cv, t, 764, y + 74, 520, s.temp, s.iceAt, -10, 15, false);
        cv.text(isNum(s.temp) ? one(s.temp) + ' °C' : '-- °C', 1556, y + 88, 30, t.text, { align: 'right', font: 'num' });
        cv.text(isNum(s.trendC) ? (s.trendC > 0.2 ? 'rising ' : s.trendC < -0.2 ? 'falling ' : 'steady, ') + (s.trendC >= 0 ? '+' : '') + one(s.trendC) + ' °C in 30 min' : 'trend after 10 min of readings', 764, y + 128, 18, t.dim);
    });
    card(204, 'Side wind (estimate)', WIND_WORD[s.wd.state], colorOf(t, WIND_COL[s.wd.state]) || t.accent, (y) => {
        windMeter(cv, t, 764, y + 74, 520, s.wd, false);
        cv.text(windText(s.wd), 1556, y + 88, 20, t.text, { align: 'right' });
        cv.text(s.wd.state === 'unknown' ? s.wd.why : 'straight stretches above 80 km/h, the last 2 minutes', 764, y + 128, 18, t.dim);
    });
    card(364, 'Wet road', 'NO SIGNAL', t.dim, (y) => {
        para(cv, 'This car sends no rain or wiper signal the app can read, so it cannot tell when the road is wet. In rain: leave twice the distance and brake earlier.', 764, y + 82, 790, 19, t.dim, 28);
    });
}

/* Ice risk: the scale, the last 30 min, where it freezes first. */
function icePage(cv, t, s) {
    G.panel(cv, t, 24, 44, 560, 468, 'Outside temperature');
    const col = colorOf(t, ICE_COL[s.ic.state]);
    G.readout(cv, t, 48, 96, { value: s.temp, unit: '°C', decimals: 1, size: 84, color: col });
    cv.text(s.ic.title, 556, 150, 26, col, { align: 'right', font: 'bold', spacing: 1.5 });
    cv.text(isNum(s.trendC) ? (s.trendC >= 0 ? '+' : '') + one(s.trendC) + ' °C in the last 30 min' : 'The trend shows after 10 min', 556, 182, 18, t.dim, { align: 'right' });
    scale(cv, t, 56, 240, 496, s.temp, s.iceAt, -10, 15, true);
    let y = 334;
    ['Bridges and overpasses lose heat from above and below: they freeze first.',
        'Shaded stretches, forest roads and the north side of hills stay icy longer.',
        'The road can be colder than the air, mostly on clear, still nights.'].forEach((x) => {
        cv.circle(56, y - 7, 5, t.warn);
        y = para(cv, x, 72, y, 490, 18, t.text, 26) + 10;
    });

    const p = G.panel(cv, t, 600, 44, 976, 468, 'The last 30 minutes');
    const pts = s.tracker.temps.map((x) => [(x.t - s.now) / 60000, x.c]);
    const cs = pts.map((x) => x[1]), even = (x, up) => 2 * (up ? Math.ceil(x / 2) : Math.floor(x / 2));
    const lo = Math.min(-2, even((cs.length ? Math.min.apply(null, cs) : 0) - 2, false)), hi = Math.max(even(s.iceAt + 4, true), even((cs.length ? Math.max.apply(null, cs) : 0) + 2, true));
    const c = G.chart(cv, t, 616, 96, 944, 372, { xMin: -30, xMax: 0, xStep: 5, yMin: lo, yMax: hi, yStep: hi - lo > 12 ? 4 : 2, yFmt: (v) => Math.round(v) + '°', xFmt: ago, padTop: 24,
        series: [{ pts, color: t.accent, width: 3 }], marks: [{ y: s.iceAt, color: t.warn, label: 'ice risk below ' + s.iceAt + ' °C' }, { y: 0, color: t.crit, label: 'freezing' }],
        empty: 'Collecting: one reading every 30 s' });
    const yi = c.Y(Math.min(s.iceAt, hi)), y0 = c.Y(Math.max(0, lo)), yb = c.py + c.ph;
    cv.fillRect(c.px, yi, c.pw, y0 - yi, withAlpha(t.warn, 0.1));
    if (lo < 0) cv.fillRect(c.px, y0, c.pw, yb - y0, withAlpha(t.crit, 0.1));
    if (pts.length) { const l = pts[pts.length - 1]; cv.circle(c.X(l[0]), c.Y(l[1]), 7, t.accent); }
    cv.text('Shaded: where ice can form. The line is the car\'s outside temperature.', p.x + 24, 500, 16, t.dim);
}

/* Side wind: the meter, the stats, the last 30 min. */
function windPage(cv, t, s) {
    G.panel(cv, t, 24, 44, 560, 468, 'Side wind now (estimate)');
    const col = colorOf(t, WIND_COL[s.wd.state]) || t.accent;
    cv.text(WIND_WORD[s.wd.state], 48, 168, 72, s.wd.state === 'breezy' ? t.accent : col, { font: 'bold' });
    cv.text(windText(s.wd), 48, 206, 20, t.text);
    windMeter(cv, t, 56, 240, 496, s.wd, true);
    const st = s.stats;
    const tiles = [['STRAIGHT ABOVE 80', st.fastMin, 'min', 0], ['GUSTY', st.gustyMin, 'min', 1], ['STRONGEST', st.worst, st.by === 'steer' ? 'deg' : 'g', st.by === 'steer' ? 1 : 3]];
    tiles.forEach((x, i) => G.readout(cv, t, 48 + i * 180, 312, { label: x[0], value: x[1], unit: x[2], decimals: x[3], size: 40, labelSize: 13 }));
    para(cv, s.wd.why, 48, 420, 510, 18, t.dim, 26);

    const p = G.panel(cv, t, 600, 44, 976, 468, 'Steering corrections, the last 30 minutes');
    const by = st.by, val = (x) => (by === 'steer' ? x.steerSd : x.latSd);
    const top = by === 'steer' ? Math.max(5, Math.ceil(((st.worst || 0) + 1))) : Math.max(0.08, (st.worst || 0) * 1.2);
    const runs = [];
    let run = null, prev = null;
    s.tracker.points.forEach((x) => {
        const v = val(x);
        if (!x.straight || !isNum(v)) { run = null; prev = null; return; }
        if (!run || (prev && x.t - prev.t > C.WIN_MS * 1.6)) { run = []; runs.push(run); }
        run.push([(x.t - s.now) / 60000, v]); prev = x;
    });
    const c = G.chart(cv, t, 616, 96, 944, 372, { xMin: -30, xMax: 0, xStep: 5, yMin: 0, yMax: top, xFmt: ago, padTop: 24,
        yUnit: by === 'steer' ? 'deg' : 'g', yFmt: (v) => (by === 'steer' ? String(Math.round(v)) : v.toFixed(2)),
        series: runs.map((r) => ({ pts: r.length === 1 ? [r[0], [r[0][0] + 0.15, r[0][1]]] : r, color: t.accent, width: 2.5, fill: 0.12 })),
        marks: [{ y: by === 'steer' ? C.STEER_BREEZY : C.LAT_BREEZY, color: t.accent, label: 'breezy' }, { y: by === 'steer' ? C.STEER_GUSTY : C.LAT_GUSTY, color: t.warn, label: 'gusty' }],
        empty: 'Only straight stretches above 80 km/h count: none yet' });
    const g = by === 'steer' ? C.STEER_GUSTY : C.LAT_GUSTY;
    if (top > g) cv.fillRect(c.px, c.Y(top), c.pw, c.Y(g) - c.Y(top), withAlpha(t.warn, 0.08));
    cv.text('Gaps: curves, town or slower than 80 km/h, left out. The car has no wind sensor: this is an estimate.', p.x + 24, 500, 16, t.dim);
}

/* How it works. */
function help(cv, t, s) {
    G.panel(cv, t, 24, 44, 1552, 468, 'How Road Conditions works');
    [
        ['1', 'Ice risk from the outside temperature.', 'At ' + s.iceAt + ' °C and below the app says ICE RISK (the line is a setting). It keeps the last 30 minutes, so it can also say when it is getting colder fast.'],
        ['2', 'Side wind from your own steering.', 'On straight roads above 80 km/h, gusts make you correct the wheel a little, again and again. The app measures that. It is an estimate: the car has no wind sensor.'],
        ['3', 'Wet road: not possible on this car.', 'No rain sensor or wiper signal reaches the apps, so the app cannot tell when the road is wet. It does not guess.'],
    ].forEach((r, i) => {
        const y = 128 + i * 112;
        cv.circle(80, y - 8, 22, withAlpha(t.accent, 0.3));
        cv.text(r[0], 80, y, 24, t.text, { align: 'center', font: 'bold' });
        cv.text(r[1], 124, y, 25, t.text, { font: 'bold' });
        para(cv, r[2], 124, y + 34, 1400, 19, t.dim, 28);
    });
    cv.text('It only reads what the car sends anyway. Nothing is asked of or written to any control unit. Nothing is saved.', 80, 496, 17, t.dim);
}

function draw(cv, t, page, s) {
    if (page === 1) icePage(cv, t, s);
    else if (page === 2) windPage(cv, t, s);
    else if (page === 3) help(cv, t, s);
    else now(cv, t, s);
}

module.exports = { draw, para };
