'use strict';
/**
 * drives.js - Warm-Up's Drives tab (issue #235, and Trip Recap folded in, #251): each drive summed up, compared, and
 * what changed at a marked moment. Four views, chosen on the page (or with the Drives view button):
 *
 *   Drive          the drive going on now or the one chosen: six numbers, its speed over time, the most g each way,
 *                  and the lowest and highest oil, coolant and gearbox oil
 *   List           the latest drives in a table (start, length, km, average, the temperatures), km of each as bars
 *   Compare        the chosen drive against the one before it, or the average of the 10 drives before it (Settings;
 *                  a drive still going on is never part of it)
 *   Before / After the drives before a marked change (a service, a new part, tyres ...) against the drives after it,
 *                  each metric's change as a bar left or right of 0 over the band of normal variation, and the
 *                  biggest real changes in words on top (diff.js)
 *
 *   trip(record, trace) -> the drive as the views and diff.js use it (DriveLog keeps { at, ms, ch, s })
 *   draw(cv, t, s)   s = { view, list (trips, newest first), sel, compareWith, marks, markSel, kind, armed, now, T, tU,
 *                          csv, own, onView(i) }
 */
const G = require('./kit/gauges');
const { withAlpha } = require('./kit/canvas');
const D = require('./diff');

const VIEWS = ['Drive', 'List', 'Compare', 'Before / After'];
const GO = '#2fd27a', BAD = '#ff5a4f', GEAR_HOT = 125, Y0 = 104;
const isNum = (x) => typeof x === 'number' && isFinite(x);
const two = (n) => (n < 10 ? '0' : '') + n;
const hm = (ms) => { const d = new Date(ms); return two(d.getHours()) + ':' + two(d.getMinutes()); };
const day = (ms) => { const d = new Date(ms); return d.getDate() + '.' + (d.getMonth() + 1) + '.'; };
const dur = (s) => (isNum(s) ? (s >= 3600 ? Math.floor(s / 3600) + ' h ' + two(Math.floor(s % 3600 / 60)) : String(Math.round(s / 60))) : null);
const ceilTo = (v, s) => Math.max(s, Math.ceil(v / s) * s);

/** A DriveLog record as a trip: start, end, secs, km, speeds, g, power, the temperatures, warm-up, the speed trace. */
function trip(r, trace) {
    const s = r.s || {}, ch = r.ch || {}, c = (k, m) => (ch[k] && isNum(ch[k][m]) ? ch[k][m] : null);
    return { start: r.at, end: r.at + (r.ms || 0), secs: Math.round((r.ms || 0) / 1000), live: !!r.live, summed: !!r.s,
        km: isNum(s.km) ? s.km : null, moving: isNum(s.moving) ? s.moving : null, vAvg: isNum(s.vAvg) ? s.vAvg : null, vMax: isNum(s.vMax) ? s.vMax : null,
        gFwd: isNum(s.gFwd) ? s.gFwd : null, gBrake: isNum(s.gBrake) ? s.gBrake : null, gSide: isNum(s.gSide) ? s.gSide : null,
        brakes: isNum(s.brakes) ? s.brakes : null, kwMax: isNum(s.kwMax) ? s.kwMax : null, warm: isNum(s.warm) ? s.warm : null,
        oilMin: c('oil', 'min'), oilMax: c('oil', 'max'), coolMin: c('coolant', 'min'), coolMax: c('coolant', 'max'),
        gbMin: c('gearbox', 'min'), gbMax: c('gearbox', 'max'), trace: trace || [] };
}

/** The view switch at the top: a segment on the full-screen layout (tap), else the view's name and the button. */
function viewRow(cv, t, s) {
    if (s.own && G.segment(cv, t, 24, 52, 760, 42, VIEWS.map((v, i) => ({ label: v, on: i === s.view, key: 'dview' + i, run: () => s.onView(i) })))) return;
    cv.text(VIEWS[s.view].toUpperCase(), 32, 82, 20, t.text, { font: 'bold', spacing: 2 });
    cv.text('Drives view: ' + VIEWS.map((v, i) => (i === s.view ? '[' + v + ']' : v)).join('  '), 300, 82, 17, t.dim);
}

/** A tile: a small panel with a label, a big number and a line under it. */
function tile(cv, t, x, y, w, h, label, value, unit, sub, opt) {
    G.panel(cv, t, x, y, w, h, null);
    cv.text(label, x + 16, y + 26, 14, t.dim, { font: 'bold', spacing: 2 });
    const str = typeof value === 'string' ? value : isNum(value) ? value.toFixed((opt && opt.d) || 0) : '--';
    const vw = cv.textWidth(str, 40, { font: 'num' });
    cv.text(str, x + 16, y + 68, 40, (opt && opt.color) || (str === '--' ? t.dim : t.text), { font: 'num' });
    if (unit) cv.text(unit, x + 24 + vw, y + 68, 18, t.dim);
    if (sub) cv.text(sub, x + 16, y + h - 10, 14, t.dim);
}

/** The most g each way, as a shape on two rings (0.5 g and 1 g). */
function gShape(cv, t, cx, cy, r, d) {
    [0.5, 1].forEach((g) => { cv.arc(cx, cy, r * g - 1, r * g + 1, 0, 360, withAlpha(t.tick, g === 1 ? 0.9 : 0.5)); });
    cv.line(cx - r, cy, cx + r, cy, 1, withAlpha(t.tick, 0.5));
    cv.line(cx, cy - r, cx, cy + r, 1, withAlpha(t.tick, 0.5));
    const f = isNum(d.gFwd) ? d.gFwd : 0, b = isNum(d.gBrake) ? d.gBrake : 0, sd = isNum(d.gSide) ? d.gSide : 0;
    const k = (g) => r * Math.min(1.15, g);
    const pts = [[cx, cy - k(f)], [cx + k(sd), cy], [cx, cy + k(b)], [cx - k(sd), cy]];
    cv.fill(pts.concat([pts[0]]), withAlpha(t.accent, 0.25));
    cv.polyline(pts.concat([pts[0]]), 2.5, t.accent);
    pts.forEach((p) => cv.circle(p[0], p[1], 4, t.accent));
    cv.text('1 g', cx + r + 4, cy - 4, 13, t.dim);
    return { f, b, s: sd };
}

/** The lowest to highest of a temperature on a 0 to 150 deg C bar, hot ends red. */
function range(cv, t, s, x, y, w, label, lo, hi, col, hotAt) {
    cv.text(label, x, y, 15, t.dim, { font: 'bold', spacing: 1 });
    const bx = x + 118, bw = w - 118, X = (v) => bx + bw * G.clamp(v / 150, 0, 1);
    cv.roundRect(bx, y - 9, bw, 8, 4, t.track);
    if (isNum(lo) && isNum(hi)) {
        cv.roundRect(X(lo), y - 9, Math.max(8, X(hi) - X(lo)), 8, 4, hi > hotAt ? t.crit : col);
        cv.text(Math.round(s.T(lo)) + ' - ' + Math.round(s.T(hi)) + s.tU(), bx + bw, y - 15, 15, hi > hotAt ? t.crit : t.text, { align: 'right', font: 'bold' });
    } else cv.text('--', bx + bw, y - 15, 15, t.dim, { align: 'right' });
}

function speedChart(cv, t, x, y, w, h, d) {
    const tr = (d.trace || []).map((v, i) => [i * 10 / 60, v]);
    const mins = Math.max(1, (tr.length - 1) * 10 / 60);
    const top = ceilTo(Math.max(40, (d.vMax || 0) * 1.1), 40);
    G.chart(cv, t, x, y, w, h, { xMin: 0, xMax: mins, yMin: 0, yMax: top, xUnit: 'min', padTop: 20,
        marks: isNum(d.vAvg) ? [{ y: d.vAvg, color: GO }] : [],
        series: [{ pts: tr, color: t.accent, width: 2.5, fill: 0.16 }],
        empty: d.summed ? 'The speed line appears after the first minute' : 'Recorded before Warm-Up 1.12: temperatures only' });
    cv.text('km/h', x + 36, y + 8, 14, t.dim, { align: 'right', font: 'bold' });
}

/* Drive: the one going on now or the one chosen. */
function drive(cv, t, s) {
    const d = s.list[s.sel];
    if (!d) {
        G.panel(cv, t, 24, Y0, 1552, 408, null);
        cv.text(s.empty || 'Recorded from the next engine start', 48, Y0 + 60, 24, t.text, { font: 'bold' });
        cv.text('Each drive shows up here with its numbers, its speed over time and its temperatures.', 48, Y0 + 96, 19, t.dim);
        return;
    }
    cv.text((d.live ? 'NOW: ' : '') + day(d.start) + '  ' + hm(d.start) + ' to ' + (d.live ? 'now' : hm(d.end)), 1576, 82, 20, d.live ? GO : t.text, { align: 'right', font: 'bold' });
    const tw = 250, gap = 10.4, moving = isNum(d.moving) && d.secs ? Math.round(100 * d.moving / d.secs) : null;
    [
        ['DISTANCE', d.km, 'km', 'odometer; short drives: speed added up', 1],
        ['TIME', dur(d.secs), 'min', isNum(moving) ? moving + ' % of it moving' : ''],
        ['AVERAGE', d.vAvg, 'km/h', 'while moving'],
        ['TOP SPEED', d.vMax, 'km/h', ''],
        ['MOST POWER', d.kwMax, 'kW', isNum(d.kwMax) ? Math.round(d.kwMax * 1.36) + ' hp' : ''],
        ['HARD BRAKES', d.brakes, '', 'stronger than 0.5 g', 0, d.brakes ? t.warn : GO],
    ].forEach((x, i) => tile(cv, t, 24 + i * (tw + gap), Y0, tw, 100, x[0], x[1], x[2], x[3], { d: x[4], color: x[5] }));
    const sp = G.panel(cv, t, 24, Y0 + 110, 880, 298, 'Speed over the drive');
    speedChart(cv, t, 40, Y0 + 176, 848, 222, d);
    if (isNum(d.vAvg)) cv.text('green line: average while moving, ' + Math.round(d.vAvg) + ' km/h', sp.x + sp.w - 24, Y0 + 140, 14, GO, { align: 'right' });
    G.panel(cv, t, 920, Y0 + 110, 656, 298, 'Most g, and temperatures');
    const g = gShape(cv, t, 1030, Y0 + 268, 74, d);
    cv.text('ACCEL ' + g.f.toFixed(2) + ' g', 1030, Y0 + 182, 13, t.dim, { align: 'center', font: 'bold' });
    cv.text('BRAKE ' + g.b.toFixed(2) + ' g', 1030, Y0 + 364, 13, t.dim, { align: 'center', font: 'bold' });
    cv.text('SIDEWAYS ' + g.s.toFixed(2) + ' g', 1030, Y0 + 388, 13, t.dim, { align: 'center', font: 'bold' });
    range(cv, t, s, 1140, Y0 + 200, 412, 'OIL', d.oilMin, d.oilMax, t.oil || t.accent, 125);
    range(cv, t, s, 1140, Y0 + 260, 412, 'COOLANT', d.coolMin, d.coolMax, t.cold || t.accent, 118);
    range(cv, t, s, 1140, Y0 + 320, 412, 'GEARBOX OIL', d.gbMin, d.gbMax, '#b98cff', GEAR_HOT);
    cv.text(isNum(d.warm) ? 'Oil warm after ' + Math.round(d.warm / 60) + ' min (a cold start)' : 'lowest and highest of this drive', 1140, Y0 + 380, 15, t.dim);
}

/* List: the table and km of each as bars. */
function list(cv, t, s) {
    const l = s.list;
    const p = G.panel(cv, t, 24, Y0, 1552, 408, null);
    if (!l.length) { cv.text(s.empty || 'Recorded from the next engine start', 48, Y0 + 60, 24, t.dim); return; }
    const cols = [[48, 'START'], [250, 'LENGTH'], [380, 'KM'], [480, 'AVERAGE'], [640, 'OIL'], [870, 'COOLANT'], [1100, 'GEARBOX OIL']];
    cols.forEach(([x, lab]) => cv.text(lab, x, Y0 + 34, 16, t.dim, { font: 'bold', spacing: 1.5 }));
    const rg = (lo, hi) => (isNum(lo) ? Math.round(s.T(lo)) + ' - ' + Math.round(s.T(hi)) + s.tU() : '--');
    const per = 7, first = Math.max(0, Math.min(s.sel - per + 1, l.length - per));
    l.slice(first, first + per).forEach((d, k) => {
        const i = first + k, y = Y0 + 72 + k * 40;
        if (i === s.sel) cv.roundRect(36, y - 28, 1328, 38, 8, withAlpha(t.accent, 0.18));
        cv.text(day(d.start) + '  ' + hm(d.start), 48, y, 20, t.text);
        cv.text(d.live ? 'now, ' + dur(d.secs) + ' min' : dur(d.secs) + ' min', 250, y, 20, d.live ? GO : t.text);
        cv.text(isNum(d.km) ? d.km.toFixed(1) : '--', 380, y, 20, t.text);
        cv.text(isNum(d.vAvg) ? Math.round(d.vAvg) + ' km/h' : '--', 480, y, 20, t.text);
        cv.text(rg(d.oilMin, d.oilMax), 640, y, 20, d.oilMax > 125 ? t.crit : t.text, { font: 'bold' });
        cv.text(rg(d.coolMin, d.coolMax), 870, y, 20, t.text);
        cv.text(rg(d.gbMin, d.gbMax), 1100, y, 20, d.gbMax > GEAR_HOT ? t.crit : t.text);
    });
    // km of each drive (newest on the right)
    const shown = l.slice(0, 12).reverse(), bx = 1384, bw = 176, top = Math.max(1, ...shown.map((d) => d.km || 0));
    cv.text('KM PER DRIVE', bx, Y0 + 34, 16, t.dim, { font: 'bold', spacing: 1.5 });
    shown.forEach((d, i) => {
        const h = Math.max(2, (d.km || 0) / top * 240), x = bx + i * (bw / shown.length);
        cv.roundRect(x, Y0 + 300 - h, bw / shown.length - 4, h, 3, d === l[s.sel] ? t.accent : withAlpha(t.accent, 0.4));
    });
    const tot = shown.reduce((a, d) => a + (d.km || 0), 0);
    cv.text(Math.round(tot) + ' km in ' + shown.length + ' drives', bx, Y0 + 326, 15, t.text);
    cv.text(s.csv ? 'CSV: drives.csv in the app\'s data folder' : 'A CSV of each drive: Settings', 48, Y0 + p.h - 20, 16, t.dim);
    cv.text('Previous / Next choose a drive', 1576, Y0 + p.h - 20, 16, t.dim, { align: 'right' });
}

const CMP = [
    ['Distance', 'km', (d) => d.km, 1, 0],
    ['Time', 'min', (d) => (isNum(d.secs) ? d.secs / 60 : null), 0, 0],
    ['Average speed', 'km/h', (d) => d.vAvg, 0, 0],
    ['Top speed', 'km/h', (d) => d.vMax, 0, 0],
    ['Hard brakes', '', (d) => d.brakes, 0, -1],
    ['Most power', 'kW', (d) => d.kwMax, 0, 0],
    ['Hottest oil', '°C', (d) => d.oilMax, 0, -1],
];

function average(l) {
    const out = {};
    CMP.forEach((m) => { const v = l.map(m[2]).filter(isNum); out[m[0]] = v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; });
    return out;
}

/**
 * What the chosen drive (l[sel], newest first) is compared with: the drive before it, or with avg the up to AVG_N
 * drives before it. Never the chosen drive itself, never one still going on.
 */
const AVG_N = 10;
function reference(l, sel, avg) {
    const before = l.slice(sel + 1).filter((d) => !d.live);
    return avg ? before.slice(0, AVG_N) : before.slice(0, 1);
}

/* Compare: the chosen drive and the one before it, or the average of the 10 before it. */
function compare(cv, t, s) {
    const l = s.list, d = l[s.sel], avg = s.compareWith === 'avg10';
    const refList = d ? reference(l, s.sel, avg) : [];
    const p = G.panel(cv, t, 24, Y0, 1552, 408, null);
    if (!d) { cv.text(l.length < 2 ? 'Needs two drives: after the next one they are compared here side by side.' : 'Choose a drive with Previous / Next.', 48, Y0 + 60, 21, t.dim); return; }
    if (!refList.length) {
        cv.text('Needs two drives: ' + (l.length < 2 ? 'after the next one they are compared here side by side.' : 'there is none before this one. Choose a newer one with Previous / Next.'), 48, Y0 + 60, 21, t.dim);
        return;
    }
    const ref = avg ? average(refList) : null;
    cv.text('This drive (' + day(d.start) + ' ' + hm(d.start) + ') against ' + (avg ? 'the average of the ' + (refList.length > 1 ? refList.length + ' drives' : 'drive') + ' before it'
        : 'the one before (' + day(refList[0].start) + ' ' + hm(refList[0].start) + ')'), 48, Y0 + 34, 19, t.text, { font: 'bold' });
    cv.text('green: calmer or cooler, red: harder on the car. Settings > Compare with', p.x + p.w - 24, Y0 + 34, 15, t.dim, { align: 'right' });
    CMP.forEach((m, i) => {
        const y = Y0 + 54 + i * 49, a = m[2](d), b = ref ? ref[m[0]] : m[2](refList[0]);
        const top = Math.max(isNum(a) ? Math.abs(a) : 0, isNum(b) ? Math.abs(b) : 0) || 1, bx = 340, bw = 760;
        cv.text(m[0], 48, y + 26, 20, t.text, { font: 'bold' });
        cv.roundRect(bx, y + 6, bw, 14, 5, t.track); cv.roundRect(bx, y + 24, bw, 14, 5, t.track);
        if (isNum(a)) cv.roundRect(bx, y + 6, Math.max(6, bw * Math.abs(a) / top), 14, 5, t.accent);
        if (isNum(b)) cv.roundRect(bx, y + 24, Math.max(6, bw * Math.abs(b) / top), 14, 5, withAlpha(t.dim, 0.7));
        const dec = ref && m[3] === 0 && isNum(b) && Math.abs(b) < 10 ? 1 : m[3];
        const unit = m[1] === '°C' ? s.tU() : m[1], cv1 = (v) => (m[1] === '°C' ? s.T(v) : v);
        const f = (v, k) => (isNum(v) ? cv1(v).toFixed(k) + (unit ? ' ' + unit : '') : '--');
        cv.text(f(a, m[3]), 1260, y + 20, 18, t.text, { align: 'right', font: 'bold' });
        cv.text(f(b, dec), 1260, y + 40, 15, t.dim, { align: 'right' });
        if (isNum(a) && isNum(b)) {
            const diff = a - b, small = Math.abs(diff) < Math.pow(10, -dec) / 2, good = m[4] === 0 ? null : diff * m[4] > 0;
            const c = small || good === null ? t.text : good ? GO : BAD, pct = b ? Math.round(100 * diff / Math.abs(b)) : null;
            const shown = m[1] === '°C' && s.tU() !== '°C' ? diff * 1.8 : diff;     // a difference in deg F is 1.8 times the one in deg C
            cv.text(small ? 'same' : (shown > 0 ? '+' : '') + shown.toFixed(dec) + (unit ? ' ' + unit : '') + (isNum(pct) && Math.abs(pct) < 1000 ? '  (' + (pct > 0 ? '+' : '') + pct + ' %)' : ''),
                1552, y + 30, 18, c, { align: 'right', font: 'bold' });
        }
    });
}

const KIND_WORDS = { all: 'all drives', length: 'drives of a similar length', speed: 'drives of a similar average speed' };
/* Before / After: what changed at a mark. */
function beforeAfter(cv, t, s) {
    const marks = s.marks || [], k = s.markSel, mk = isNum(k) ? marks[k] : null;
    if (!mk) {
        G.panel(cv, t, 24, Y0, 1552, 408, null);
        cv.text(s.armed ? 'Press Mark a change again to mark it now' : 'Nothing marked yet', 48, Y0 + 50, 24, s.armed ? t.warn : t.text, { font: 'bold' });
        ['After a service, a new part, new tyres or a changed setting, press Mark a change twice.',
            'Pick what it was in Settings > Change to mark. Then drive: this view shows what changed.',
            'Each value gets a bar: right of 0 more than before, left less. Green is better, red is worse,',
            'grey is within the normal variation of your drives. Speed, time and power only show as changed:',
            'they follow the traffic and the right foot more than the part that changed.']
            .forEach((x, i) => cv.text(x, 48, Y0 + 96 + i * 32, 19, t.dim));
        return;
    }
    const sd = D.sides(s.list.filter((d) => !d.live && d.summed), marks, k, s.kind || 'all'), rs = D.rows(sd.before, sd.after), hl = D.headline(rs, mk.label);
    const head = G.panel(cv, t, 24, Y0, 1552, 84, null);
    const kmTxt = isNum(mk.odo) ? ', at ' + String(Math.round(mk.odo)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ' km' : '';
    cv.text('Before and after: ' + mk.label + ', marked ' + day(mk.at) + ' ' + hm(mk.at) + kmTxt, 48, Y0 + 30, 20, t.text, { font: 'bold' });
    cv.text((s.armed ? 'Press Mark a change again to mark it now  |  ' : '') + 'Mark ' + (k + 1) + ' of ' + marks.length + ': Previous / Next', head.x + head.w - 24, Y0 + 30, 15, s.armed ? t.warn : t.dim, { align: 'right' });
    const col = (st) => (st === 'better' ? GO : st === 'worse' ? BAD : st === 'changed' ? t.accent : t.dim);
    if (!sd.after.length || !sd.before.length) {
        cv.text(!sd.before.length ? 'No ' + KIND_WORDS[sd.kind] + ' before this mark to compare with.'
            : 'No ' + KIND_WORDS[sd.kind] + ' after this mark yet: drive a few times and the change shows here.', 48, Y0 + 62, 18, t.warn);
    } else if (!hl.length) {
        const moved = rs.filter((r) => r.state === 'changed').map((r) => r.name.toLowerCase());
        cv.text(moved.length ? 'Nothing better or worse beyond the normal variation. Changed: ' + moved.join(', ') + ' (traffic and driving, see below).'
            : 'Nothing changed beyond the normal variation of your drives.', 48, Y0 + 62, 18, t.text);
    } else {
        hl.forEach((h, i) => { const x = 48 + i * 512; cv.circle(x + 7, Y0 + 56, 7, col(h.state)); cv.text(h.text, x + 22, Y0 + 62, 17, t.text, { font: 'bold' }); });
    }
    G.panel(cv, t, 24, Y0 + 94, 1552, 314, null);
    const cx = 900, half = 300, rowH = 28, y0 = Y0 + 136;
    const real = rs.filter((r) => isNum(r.pct)).map((r) => Math.abs(r.pct));
    const scale = Math.max(20, Math.ceil(Math.max.apply(null, real.concat([0])) / 10) * 10);
    const X = (pct) => cx + G.clamp(pct / scale, -1, 1) * half;
    const few = Math.min(sd.before.length, sd.after.length) < 3;
    [['WHAT', 48, 'left'], ['BEFORE', 470, 'right'], ['AFTER', 570, 'right'], ['CHANGE, % OF BEFORE (GREY: NORMAL VARIATION)', cx, 'center']]
        .forEach((h) => cv.text(h[0], h[1], Y0 + 118, 13, t.dim, { align: h[2], font: 'bold', spacing: 1.5 }));
    cv.text(sd.before.length + ' before, ' + sd.after.length + ' after (' + KIND_WORDS[sd.kind] + ')' + (few ? ': few, clearer with more' : ''), 1552, Y0 + 118, 13, few ? t.warn : t.dim, { align: 'right' });
    for (let p = -scale; p <= scale + 1e-9; p += scale / 2) {
        cv.fillRect(Math.round(X(p)), y0 - 8, 1, rs.length * rowH, withAlpha(t.tick, p === 0 ? 0.8 : 0.25));
        cv.text((p > 0 ? '+' : '') + p + ' %', X(p), y0 + rs.length * rowH + 8, 13, t.dim, { align: 'center' });
    }
    const f = (v, r) => (isNum(v) ? (r.unit === '°C' ? s.T(v) : v).toFixed(r.d) + (r.unit ? ' ' + (r.unit === '°C' ? s.tU() : r.unit) : '') : '--');
    rs.forEach((r, i) => {
        const y = y0 + i * rowH, mid = y + 8;
        if (i % 2) cv.fillRect(36, y - 8, 1528, rowH, withAlpha('#ffffff', 0.03));
        cv.text(r.name, 48, y + 14, 16, r.state === 'none' ? t.dim : t.text, { font: 'bold' });
        cv.text(f(r.b, r), 470, y + 14, 15, t.dim, { align: 'right' });
        cv.text(f(r.a, r), 570, y + 14, 15, t.text, { align: 'right', font: 'bold' });
        if (isNum(r.spreadPct)) { const sw = Math.min(half, r.spreadPct / scale * half); cv.roundRect(cx - sw, mid - 9, sw * 2, 18, 4, withAlpha(t.dim, 0.22)); }
        if (isNum(r.pct)) { const x1 = X(r.pct); cv.roundRect(Math.min(cx, x1), mid - 5, Math.max(4, Math.abs(x1 - cx)), 10, 4, r.state === 'same' ? withAlpha(t.dim, 0.7) : col(r.state)); }
        const word = r.state === 'none' ? 'not recorded on both sides' : r.state === 'same' ? 'within normal variation'
            : (isNum(r.pct) && Math.abs(r.pct) < 1000 ? (r.pct > 0 ? '+' : '') + Math.round(r.pct) + ' %' : (r.change > 0 ? '+' : '') + r.change.toFixed(r.d))
              + (r.state === 'better' ? '  better' : r.state === 'worse' ? '  worse' : '  changed');
        cv.text(word, 1552, y + 14, 15, r.state === 'same' || r.state === 'none' ? t.dim : col(r.state), { align: 'right', font: r.state === 'same' || r.state === 'none' ? 'label' : 'bold' });
    });
}

function draw(cv, t, s) {
    viewRow(cv, t, s);
    if (s.view === 1) list(cv, t, s);
    else if (s.view === 2) compare(cv, t, s);
    else if (s.view === 3) beforeAfter(cv, t, s);
    else drive(cv, t, s);
}

module.exports = { VIEWS, trip, draw, average, reference, AVG_N };
