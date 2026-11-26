'use strict';
/**
 * view.js - Trip Recap's four pages:
 *
 *   Last drive     the drive going on now, or the last one: six big numbers, its speed over time, the most g each way
 *                  and how warm oil and coolant got
 *   Drives         km of each drive as bars, the list, the chosen one in numbers
 *   Compare        the chosen drive against the one before it (or the average of the last 10), side by side
 *   How it works   plain words
 *
 *   draw(cv, t, page, s)   s = { last, live, list, sel, compareWith, now }
 */
const G = require('./kit/gauges');
const { withAlpha } = require('./kit/canvas');

const GO = '#2fd27a', BAD = '#ff5a4f';
const isNum = (x) => typeof x === 'number' && isFinite(x);
const two = (n) => (n < 10 ? '0' : '') + n;
const hm = (ms) => { const d = new Date(ms); return two(d.getHours()) + ':' + two(d.getMinutes()); };
const day = (ms) => { const d = new Date(ms); return d.getDate() + '.' + (d.getMonth() + 1) + '.'; };
const dur = (s) => (isNum(s) ? (s >= 3600 ? Math.floor(s / 3600) + ' h ' + two(Math.floor(s % 3600 / 60)) : Math.round(s / 60)) : null);
const durUnit = (s) => (isNum(s) && s >= 3600 ? 'min' : 'min');
const ceilTo = (v, s) => Math.max(s, Math.ceil(v / s) * s);

/** A tile: a small panel with a label, a big number and a line under it. */
function tile(cv, t, x, y, w, h, label, value, unit, sub, opt) {
    G.panel(cv, t, x, y, w, h, null);
    cv.text(label, x + 18, y + 30, 15, t.dim, { font: 'bold', spacing: 2 });
    const s = typeof value === 'string' ? value : isNum(value) ? value.toFixed((opt && opt.d) || 0) : '--';
    const vw = cv.textWidth(s, 46, { font: 'num' });
    cv.text(s, x + 18, y + 80, 46, (opt && opt.color) || (s === '--' ? t.dim : t.text), { font: 'num' });
    if (unit) cv.text(unit, x + 26 + vw, y + 80, 20, t.dim);
    if (sub) cv.text(sub, x + 18, y + h - 12, 15, t.dim);
}

/** The most g each way, as a shape on two rings (0.5 g and 1 g). */
function gShape(cv, t, cx, cy, r, d) {
    [0.5, 1].forEach((g) => { cv.arc(cx, cy, r * g - 1, r * g + 1, 0, 360, withAlpha(t.tick, g === 1 ? 0.9 : 0.5)); });
    cv.line(cx - r, cy, cx + r, cy, 1, withAlpha(t.tick, 0.5));
    cv.line(cx, cy - r, cx, cy + r, 1, withAlpha(t.tick, 0.5));
    const f = isNum(d.gFwd) ? d.gFwd : 0, b = isNum(d.gBrake) ? d.gBrake : 0, s = isNum(d.gSide) ? d.gSide : 0;
    const k = (g) => r * Math.min(1.15, g);
    const pts = [[cx, cy - k(f)], [cx + k(s), cy], [cx, cy + k(b)], [cx - k(s), cy]];
    cv.fill(pts.concat([pts[0]]), withAlpha(t.accent, 0.25));
    cv.polyline(pts.concat([pts[0]]), 2.5, t.accent);
    pts.forEach((p) => cv.circle(p[0], p[1], 5, t.accent));
    cv.text('0.5', cx + r * 0.5 + 4, cy - 4, 13, t.dim);
    cv.text('1 g', cx + r + 4, cy - 4, 13, t.dim);
    return { f, b, s };
}

function speedChart(cv, t, x, y, w, h, d) {
    const tr = (d.trace || []).map((v, i) => [i * 10 / 60, v]);
    const mins = Math.max(1, (tr.length - 1) * 10 / 60);
    const top = ceilTo(Math.max(40, (d.vMax || 0) * 1.1), 40);
    G.chart(cv, t, x, y, w, h, { xMin: 0, xMax: mins, yMin: 0, yMax: top, xUnit: 'min', yUnit: 'km/h',
        marks: isNum(d.vAvg) ? [{ y: d.vAvg, color: GO, label: 'average while moving ' + Math.round(d.vAvg) + ' km/h' }] : [],
        series: [{ pts: tr, color: t.accent, width: 2.5, fill: 0.16 }], empty: 'The speed line appears after the first minute' });
}

function range(cv, t, x, y, w, label, lo, hi, col) {
    cv.text(label, x, y, 16, t.dim, { font: 'bold', spacing: 1 });
    const bx = x + 110, bw = w - 110, X = (v) => bx + bw * G.clamp((v - 0) / 130, 0, 1);
    cv.roundRect(bx, y - 10, bw, 8, 4, t.track);
    if (isNum(lo) && isNum(hi)) {
        cv.roundRect(X(lo), y - 10, Math.max(8, X(hi) - X(lo)), 8, 4, col);
        cv.text(Math.round(lo) + ' to ' + Math.round(hi) + ' °C', bx + bw, y - 16, 15, t.text, { align: 'right' });
    } else cv.text('--', bx + bw, y - 16, 15, t.dim, { align: 'right' });
}

/* Last drive. */
function lastDrive(cv, t, s) {
    const d = s.live || s.last;
    const head = G.panel(cv, t, 24, 44, 1552, 64, null);
    if (!d) {
        cv.text('No drive yet', 48, 86, 26, t.text, { font: 'bold' });
        cv.text('Just drive: when you park, the drive shows up here with its numbers and charts.', 300, 86, 20, t.dim);
        return;
    }
    G.pill(cv, t, 44, 58, 168, 36, s.live ? 'DRIVING NOW' : 'LAST DRIVE', { color: s.live ? GO : t.accent, size: 16 });
    cv.text(day(d.start) + '  ' + hm(d.start) + ' to ' + (s.live ? 'now' : hm(d.end)), 232, 86, 24, t.text, { font: 'bold' });
    cv.text(s.live ? 'Updates as you drive. Saved when the car has stood still with the engine off for 3 minutes.'
        : 'Saved when you parked. The numbers below are for this drive only.', head.x + head.w - 24, 86, 17, t.dim, { align: 'right' });
    const tw = 250, gap = 10.4;
    const moving = isNum(d.moving) && d.secs ? Math.round(100 * d.moving / d.secs) : null;
    [
        ['DISTANCE', d.km, 'km', 'from the odometer', 1],
        ['TIME', dur(d.secs), durUnit(d.secs), isNum(moving) ? moving + ' % of it moving' : ''],
        ['AVERAGE', d.vAvg, 'km/h', 'while moving'],
        ['TOP SPEED', d.vMax, 'km/h', ''],
        ['MOST POWER', d.kwMax, 'kW', isNum(d.kwMax) ? Math.round(d.kwMax * 1.36) + ' hp' : 'needs the torque signal'],
        ['HARD BRAKES', d.brakes, '', 'stronger than 0.5 g', 0, d.brakes ? t.warn : GO],
    ].forEach((x, i) => tile(cv, t, 24 + i * (tw + gap), 118, tw, 118, x[0], x[1], x[2], x[3], { d: x[4], color: x[5] }));
    const sp = G.panel(cv, t, 24, 246, 1000, 266, 'Speed over the drive');
    speedChart(cv, t, 40, 318, 968, 184, d);
    const gp = G.panel(cv, t, 1040, 246, 536, 266, 'Most g, and temperatures');
    const g = gShape(cv, t, 1160, 404, 82, d);
    cv.text('ACCEL ' + g.f.toFixed(2) + ' g', 1160, 312, 14, t.dim, { align: 'center', font: 'bold' });
    cv.text('BRAKE ' + g.b.toFixed(2) + ' g', 1160, 504, 14, t.dim, { align: 'center', font: 'bold' });
    cv.text('SIDEWAYS', 1300, 330, 14, t.dim, { font: 'bold', spacing: 1 });
    cv.text(g.s.toFixed(2) + ' g', 1300, 360, 30, t.text, { font: 'num' });
    range(cv, t, 1300, 420, 260, 'OIL', d.oilMin, d.oilMax, t.warn);
    range(cv, t, 1300, 470, 260, 'COOLANT', d.coolMin, d.coolMax, t.cold || t.accent);
    void sp; void gp;
}

/* Drives: bars, list, the chosen one. */
function drives(cv, t, s) {
    const l = s.list;
    G.panel(cv, t, 24, 44, 900, 468, 'Km per drive (newest on the right)');
    if (!l.length) {
        ['No drives saved yet.', '', 'Each drive appears here once you park:', 'its km as a bar, and its numbers.'].forEach((x, i) =>
            cv.text(x, 48, 120 + i * 32, 21, i ? t.dim : t.text, { font: i ? 'label' : 'bold' }));
    } else {
        const shown = l.slice(0, 15).reverse(), selAt = shown.indexOf(l[s.sel]);
        const top = ceilTo(Math.max.apply(null, shown.map((d) => d.km || 0)) * 1.1, 10);
        const x = 90, y = 126, w = 810, h = 226, bw = w / shown.length;
        for (let v = 0; v <= top + 1e-9; v += top / 4) {
            const yy = y + h - v / top * h;
            cv.fillRect(x, Math.round(yy), w, 1, withAlpha(t.tick, v ? 0.25 : 0.6));
            cv.text(String(Math.round(v)), x - 8, yy + 5, 15, t.dim, { align: 'right' });
        }
        cv.text('km', x - 8, y - 18, 14, t.dim, { align: 'right', font: 'bold' });
        shown.forEach((d, i) => {
            const bh = Math.max(3, (d.km || 0) / top * h), bx = x + i * bw + bw * 0.15, on = i === selAt;
            cv.roundRect(bx, y + h - bh, bw * 0.7, bh, 4, on ? t.accent : withAlpha(t.accent, 0.4));
            if (on || shown.length <= 10) cv.text(String(Math.round(d.km || 0)), bx + bw * 0.35, y + h - bh - 8, 15, on ? t.text : t.dim, { align: 'center', font: 'bold' });
            if (shown.length <= 10 || i % 2 === 0 || on) cv.text(day(d.start), bx + bw * 0.35, y + h + 20, 14, on ? t.text : t.dim, { align: 'center' });
        });
        const total = l.slice(0, 15).reduce((a, d) => a + (d.km || 0), 0);
        cv.text('These ' + shown.length + ' drives: ' + Math.round(total) + ' km, on average ' + Math.round(total / shown.length) + ' km each', 48, 408, 19, t.text);
        const d = l[s.sel];
        if (d) {
            cv.text('Chosen: ' + day(d.start) + ' ' + hm(d.start) + ' to ' + hm(d.end), 48, 442, 19, t.accent, { font: 'bold' });
            cv.text(Math.round(d.km || 0) + ' km in ' + dur(d.secs) + ' min, average ' + (isNum(d.vAvg) ? Math.round(d.vAvg) : '--') + ' km/h, top '
                + (isNum(d.vMax) ? Math.round(d.vMax) : '--') + ' km/h, ' + d.brakes + ' hard brake' + (d.brakes === 1 ? '' : 's'), 48, 470, 19, t.text);
            cv.text('Previous / Next choose a drive. Compare puts it next to the one before.', 48, 498, 15, t.dim);
        }
    }
    G.panel(cv, t, 940, 44, 636, 468, 'Saved drives (' + l.length + ')');
    const cols = [{ label: 'Day', w: 150 }, { label: 'Km', w: 110, align: 'right' }, { label: 'Time', w: 130, align: 'right' }, { label: 'Average', w: 190, align: 'right' }];
    const per = 8, first = Math.max(0, Math.min(s.sel - per + 1, l.length - per));
    G.table(cv, t, 964, 104, 590, cols, l.slice(first, first + per).map((d) => [day(d.start) + ' ' + hm(d.start), (d.km || 0).toFixed(1),
        dur(d.secs) + ' min', isNum(d.vAvg) ? Math.round(d.vAvg) + ' km/h' : '--']), { rowH: 42, size: 20, empty: 'Nothing yet' });
    if (l.length) { const ry = 104 + 30 + (s.sel - first) * 42; cv.strokeRoundRect(956, ry, 606, 42, 8, 2, t.accent); }
}

const METRICS = [
    ['Distance', 'km', (d) => d.km, 1, 0],
    ['Time', 'min', (d) => (isNum(d.secs) ? d.secs / 60 : null), 0, 0],
    ['Average speed', 'km/h', (d) => d.vAvg, 0, 0],
    ['Top speed', 'km/h', (d) => d.vMax, 0, 0],
    ['Hard brakes', '', (d) => d.brakes, 0, -1],
    ['Hardest braking', 'g', (d) => d.gBrake, 2, -1],
    ['Most power', 'kW', (d) => d.kwMax, 0, 0],
    ['Hottest oil', '°C', (d) => d.oilMax, 0, -1],
];

function average(list) {
    const out = {};
    METRICS.forEach((m) => {
        const v = list.map(m[2]).filter(isNum);
        out[m[0]] = v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
    });
    return out;
}

/* Compare: the chosen drive and the one before it, or the average of the last 10. */
function compare(cv, t, s) {
    const l = s.list, d = l[s.sel];
    const avg = s.compareWith === 'avg10';
    const refList = avg ? l.slice(0, 10) : [l[s.sel + 1]].filter(Boolean);
    const p = G.panel(cv, t, 24, 44, 1552, 468, d ? 'This drive (' + day(d.start) + ' ' + hm(d.start) + ') against '
        + (avg ? 'the average of the last ' + refList.length : refList[0] ? 'the one before (' + day(refList[0].start) + ' ' + hm(refList[0].start) + ')' : 'the one before') : 'Compare');
    if (!d || !refList.length) {
        cv.text(l.length < 2 ? 'Needs two saved drives. After your next drive, they are compared here side by side.' : 'Choose a drive on Drives.', 48, 130, 21, t.dim);
        return;
    }
    const ref = avg ? average(refList) : null;
    cv.roundRect(820, 74, 18, 12, 3, t.accent); cv.text('this drive', 846, 86, 16, t.text);
    cv.roundRect(970, 74, 18, 12, 3, withAlpha(t.dim, 0.7)); cv.text(avg ? 'average' : 'the one before', 996, 86, 16, t.text);
    cv.text('green: calmer or quicker, red: harder on the car', p.x + p.w - 24, 86, 15, t.dim, { align: 'right' });
    METRICS.forEach((m, i) => {
        const y = 110 + i * 49, a = m[2](d), b = ref ? ref[m[0]] : m[2](refList[0]);
        const top = Math.max(isNum(a) ? a : 0, isNum(b) ? b : 0) || 1, bx = 340, bw = 760;
        cv.text(m[0], 48, y + 26, 21, t.text, { font: 'bold' });
        cv.roundRect(bx, y + 6, bw, 14, 5, t.track); cv.roundRect(bx, y + 24, bw, 14, 5, t.track);
        if (isNum(a)) cv.roundRect(bx, y + 6, Math.max(6, bw * a / top), 14, 5, t.accent);
        if (isNum(b)) cv.roundRect(bx, y + 24, Math.max(6, bw * b / top), 14, 5, withAlpha(t.dim, 0.7));
        // an average of whole numbers (hard brakes) keeps one decimal, so 1.5 is not shown as 2
        const dec = ref && m[3] === 0 && isNum(b) && Math.abs(b) < 10 ? 1 : m[3];
        const f = (v, k) => (isNum(v) ? v.toFixed(k) + (m[1] ? ' ' + m[1] : '') : '--');
        cv.text(f(a, m[3]), 1260, y + 20, 19, t.text, { align: 'right', font: 'bold' });
        cv.text(f(b, dec), 1260, y + 40, 16, t.dim, { align: 'right' });
        if (isNum(a) && isNum(b)) {
            const diff = a - b, small = Math.abs(diff) < Math.pow(10, -dec) / 2;
            const good = m[4] === 0 ? null : diff * m[4] > 0;
            const c = small || good === null ? t.text : good ? GO : BAD;
            const pct = b ? Math.round(100 * diff / Math.abs(b)) : null;
            cv.text(small ? 'same' : (diff > 0 ? '+' : '') + diff.toFixed(dec) + (m[1] ? ' ' + m[1] : '') + (isNum(pct) && Math.abs(pct) < 1000 ? '  (' + (pct > 0 ? '+' : '') + pct + ' %)' : ''),
                1552, y + 30, 19, c, { align: 'right', font: 'bold' });
        }
    });
}

function help(cv, t, s) {
    G.panel(cv, t, 24, 44, 1552, 468, 'How Trip Recap works');
    [
        ['1', 'It notes every drive by itself.', 'From the moment the car moves or the engine runs, until it has stood still with the engine off for 3 minutes.'],
        ['2', 'It keeps the numbers that matter.', 'Km (from the odometer), time, average and top speed, the most g each way, hard brakes (over 0.5 g), the most power, oil and coolant.'],
        ['3', 'Last drive shows the one just driven.', 'Six numbers on top, the speed over the whole drive as a chart, and the most g each way as a shape: the bigger it is, the harder the drive.'],
        ['4', 'Drives and Compare look back.', 'Km of each drive as bars, and any drive next to the one before it, or the average of the last 10 (Settings > Compare with).'],
    ].forEach((r, i) => {
        const y = 140 + i * 84;
        cv.circle(80, y - 8, 22, withAlpha(t.accent, 0.3));
        cv.text(r[0], 80, y, 22, t.text, { align: 'center', font: 'bold' });
        cv.text(r[1], 124, y, 24, t.text, { font: 'bold' });
        cv.text(r[2], 124, y + 32, 18, t.dim);
    });
    cv.text('It only reads what the car sends anyway, nothing is asked of a control unit. The last ' + (s.keep || 30) + ' drives are kept in the app\'s data folder (trips.json).', 56, 494, 17, t.dim);
}

function draw(cv, t, page, s) {
    if (page === 1) drives(cv, t, s);
    else if (page === 2) compare(cv, t, s);
    else if (page === 3) help(cv, t, s);
    else lastDrive(cv, t, s);
}

module.exports = { draw, METRICS, average, day, hm, dur };
