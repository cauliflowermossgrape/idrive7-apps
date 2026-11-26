'use strict';
/**
 * view.js - Shift Lab's four pages:
 *
 *   Live           the gear now (big), each learned gear as a line of rpm against speed with the car as a dot on it,
 *                  and the last shift measured: how long it took, the rpm drop, the g before, during and after
 *   Shifts         how long each gear change takes (average and best) and how far the rpm drops, the last shifts
 *   Pull           how hard the car pushes in each gear across the revs (g), one line per gear, and each gear's best
 *   How it works   the same in plain words
 *
 *   draw(cv, t, page, s)   s = { d (car.data()), shifts, ratios, curves, perGear, minTorque, armed }
 */
const G = require('./kit/gauges');
const { withAlpha } = require('./kit/canvas');

const GEAR_COL = ['#ff5a5a', '#ffa23a', '#ffd84a', '#2fd27a', '#3ac8ff', '#7d8bff', '#c06bff', '#ff6fb5', '#ffffff', '#aaaaaa'];
const gc = (g) => GEAR_COL[(g - 1) % GEAR_COL.length];
const isNum = G.isNum;
const two = (n) => (n < 10 ? '0' : '') + n;
const when = (ms) => { const d = new Date(ms); return d.getDate() + '.' + two(d.getMonth() + 1) + '. ' + two(d.getHours()) + ':' + two(d.getMinutes()); };
const sp = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
const gears = (ratios) => Object.keys(ratios || {}).map(Number).filter((g) => g >= 1 && isNum(ratios[g])).sort((a, b) => a - b);

/* ---------- Live ---------- */
function live(cv, t, s) {
    const d = s.d || {}, ratios = s.ratios, gl = gears(ratios);
    G.panel(cv, t, 24, 44, 340, 468, 'In gear');
    const g = isNum(d.gear) && d.gear >= 1 ? d.gear : null;
    cv.text(g ? String(g) : '-', 194, 270, 190, g ? gc(g) : t.dim, { align: 'center', font: 'gear' });
    if (g && d.gearGuessed) cv.text('FROM RPM AND SPEED', 194, 300, 14, t.dim, { align: 'center', font: 'bold', spacing: 1.5 });
    G.readout(cv, t, 48, 318, { label: 'rpm', value: d.rpm, size: 40, labelSize: 14 });
    G.readout(cv, t, 200, 318, { label: 'speed', value: d.speed, unit: 'km/h', size: 40, labelSize: 14 });
    const k = isNum(d.rpm) && isNum(d.speed) && d.speed > 8 ? d.rpm / d.speed : null;
    G.readout(cv, t, 48, 404, { label: 'rpm per km/h now', value: k, decimals: 1, size: 34, labelSize: 14 });
    cv.text(gl.length ? gl.length + ' gears learned' : 'gears not learned yet', 48, 496, 17, t.dim);

    // each gear a line of rpm against speed
    G.panel(cv, t, 380, 44, 720, 468, 'Each gear is a line: rpm against speed');
    const vmax = 260, rmax = 8000;
    const series = gl.map((n) => ({ pts: [[0, 0], [Math.min(vmax, (rmax - 200) / ratios[n]), Math.min(vmax, (rmax - 200) / ratios[n]) * ratios[n]]], color: withAlpha(gc(n), n === g ? 1 : 0.55), width: n === g ? 4 : 2.5 }));
    const c = G.chart(cv, t, 396, 100, 688, 336, { padTop: 26, xMin: 0, xMax: vmax, xStep: 50, yMin: 0, yMax: rmax, yStep: 2000, xUnit: 'km/h',
        yFmt: (v) => (v ? v / 1000 + 'k' : '0'), series, empty: 'Drive a little in each gear: the lines appear as they are learned' });
    cv.text('rpm', c.px - 8, c.py - 16, 14, t.dim, { align: 'right', font: 'bold' });
    gl.forEach((n) => {
        const x = Math.min(vmax, (rmax - 200) / ratios[n]), y = x * ratios[n];
        cv.circle(c.X(x), c.Y(y), 13, withAlpha(gc(n), 0.9));
        cv.text(String(n), c.X(x), c.Y(y) + 6, 17, '#000000', { align: 'center', font: 'bold' });
    });
    if (isNum(d.speed) && isNum(d.rpm) && d.speed <= vmax) {
        const x = c.X(d.speed), y = c.Y(Math.min(rmax, d.rpm));
        cv.circle(x, y, 16, withAlpha(t.text, 0.25)); cv.circle(x, y, 8, t.text);
    }
    cv.text('The white dot is the car now. On a line: in that gear. Between lines: shifting.', 400, 496, 17, t.dim);

    lastShift(cv, t, s.shifts[0], 1116, 44, 460, 468, s.minTorque);
}

function lastShift(cv, t, sh, x, y, w, h, minTq) {
    G.panel(cv, t, x, y, w, h, 'Last shift');
    if (!sh) {
        ['No shift measured yet.', '', 'Pull through a gear with more', 'than ' + minTq + ' Nm (or 0.08 g), let the', 'gearbox shift up: it shows here.']
            .forEach((l, i) => cv.text(l, x + 24, y + 96 + i * 32, 20, i ? t.dim : t.text, { font: i ? 'label' : 'bold' }));
        return;
    }
    cv.text(sh.from + '  to  ' + sh.to, x + 24, y + 110, 50, t.text, { font: 'bold' });
    cv.text(sh.ms + ' ms', x + w - 24, y + 112, 56, t.accent, { align: 'right', font: 'num' });
    cv.text('GEAR CHANGE', x + 24, y + 134, 14, t.dim, { font: 'bold', spacing: 1.5 });
    cv.text('TOOK', x + w - 24, y + 134, 14, t.dim, { align: 'right', font: 'bold', spacing: 1.5 });
    cv.text('rpm ' + sp(sh.rpmBefore) + ' > ' + sp(sh.rpmAfter) + ' (drop ' + sp(sh.rpmBefore - sh.rpmAfter) + ')', x + 24, y + 172, 19, t.text);
    cv.text('at ' + Math.round(sh.kmh || 0) + ' km/h, ' + when(sh.at), x + 24, y + 200, 19, t.dim);
    // the push in g: before, the lowest during, after
    const bars = [['before', sh.gBefore, GO_COL], ['during', sh.gDip, t.warn], ['after', sh.gAfter, GO_COL]];
    const top = Math.max(0.2, Math.ceil(Math.max.apply(null, bars.map((b) => (isNum(b[1]) ? b[1] : 0))) * 10 + 1) / 10);
    const bx = x + 36, by = y + 392, bh = 140, bw = 100, gap = (w - 72 - 3 * bw) / 2;
    cv.text('HOW HARD IT PUSHED YOU (g)', x + 24, y + 232, 14, t.dim, { font: 'bold', spacing: 1.5 });
    bars.forEach((b, i) => {
        const v = isNum(b[1]) ? Math.max(0, b[1]) : 0, hh = Math.max(3, bh * v / top), xx = bx + i * (bw + gap);
        cv.roundRect(xx, by - bh, bw, bh, 6, withAlpha(t.track, 0.6));
        cv.roundRect(xx, by - hh, bw, hh, 6, b[2]);
        cv.text(isNum(b[1]) ? b[1].toFixed(2) : '--', xx + bw / 2, by - hh - 8, 20, t.text, { align: 'center', font: 'num' });
        cv.text(b[0], xx + bw / 2, by + 22, 17, t.dim, { align: 'center' });
    });
    cv.text('torque ' + (isNum(sh.tqBefore) ? Math.round(sh.tqBefore) : '--') + ' > ' + (isNum(sh.tqAfter) ? Math.round(sh.tqAfter) : '--') + ' Nm', x + 24, y + h - 12, 17, t.dim);
}
const GO_COL = '#2fd27a';

/* ---------- Shifts ---------- */
function shiftsPage(cv, t, s) {
    const pg = s.perGear;
    G.panel(cv, t, 24, 44, 760, 468, 'How long each gear change takes');
    if (!pg.length) cv.text('No shifts measured yet: pull through the gears.', 48, 140, 21, t.dim);
    else {
        const n = pg.length, ymax = Math.max(300, Math.ceil(Math.max.apply(null, pg.map((p) => p.avgMs)) / 100) * 100 + 100);
        const c = G.chart(cv, t, 40, 100, 728, 218, { padTop: 26, xMin: 0, xMax: n, xStep: n, xFmt: () => '', yMin: 0, yMax: ymax, series: [] });
        cv.text('ms', c.px - 8, c.py - 16, 14, t.dim, { align: 'right', font: 'bold' });
        const slot = c.pw / n, bw = Math.min(46, slot * 0.32);
        pg.forEach((p, i) => {
            const cx = c.px + slot * (i + 0.5);
            [[p.avgMs, t.accent, -1], [p.bestMs, GO_COL, 1]].forEach(([v, col, side]) => {
                const x0 = cx + (side < 0 ? -bw - 3 : 3), y0 = c.Y(v);
                cv.roundRect(x0, y0, bw, c.py + c.ph - y0, 4, col);
                cv.text(String(v), x0 + bw / 2, y0 - 6, 16, t.text, { align: 'center', font: 'num' });
            });
            cv.text(p.from + ' > ' + p.to, cx, c.py + c.ph + 22, 18, t.text, { align: 'center', font: 'bold' });
        });
        cv.roundRect(560, 76, 14, 14, 3, t.accent); cv.text('average', 580, 89, 16, t.dim);
        cv.roundRect(660, 76, 14, 14, 3, GO_COL); cv.text('best', 680, 89, 16, t.dim);
        // the rpm drop per change
        cv.text('RPM DROP AT EACH CHANGE', 48, 372, 14, t.dim, { font: 'bold', spacing: 1.5 });
        const dmax = Math.max.apply(null, pg.map((p) => p.avgDrop)) || 1;
        pg.forEach((p, i) => {
            const y = 386 + i * Math.min(22, 100 / n), w = 520 * p.avgDrop / dmax;
            cv.text(p.from + ' > ' + p.to, 48, y + 14, 15, t.dim);
            cv.roundRect(110, y + 2, Math.max(4, w), 14, 4, withAlpha(gc(p.to), 0.85));
            cv.text(sp(p.avgDrop) + ' rpm, ' + p.n + 'x', 120 + w, y + 14, 15, t.text);
        });
    }
    G.panel(cv, t, 800, 44, 776, 468, 'Last shifts (' + s.shifts.length + ')');
    const rows = s.shifts.slice(0, 9).map((x) => [when(x.at), { text: x.from + ' > ' + x.to, color: gc(x.to) }, x.ms + ' ms',
        sp(x.rpmBefore) + ' > ' + sp(x.rpmAfter), Math.round(x.kmh || 0) + ' km/h', isNum(x.gDip) ? x.gDip.toFixed(2) + ' g' : '--']);
    G.table(cv, t, 820, 104, 740, [{ label: 'When', w: 150 }, { label: 'Change', w: 90, font: 'bold' }, { label: 'Took', w: 100, align: 'right' },
        { label: 'rpm', w: 190, align: 'right' }, { label: 'Speed', w: 110, align: 'right' }, { label: 'Lowest g', w: 100, align: 'right' }], rows,
    { rowH: 40, size: 19, empty: 'None yet' });
}

/* ---------- Pull ---------- */
function pullPage(cv, t, s) {
    const cur = s.curves, gl = Object.keys(cur).map(Number).filter((g) => cur[g].length > 1).sort((a, b) => a - b);
    G.panel(cv, t, 24, 44, 1100, 468, 'How hard the car pulls in each gear');
    let top = 0.2; gl.forEach((g) => cur[g].forEach((p) => { top = Math.max(top, p[1]); }));
    top = Math.ceil(top * 10 + 0.5) / 10;
    G.chart(cv, t, 40, 100, 1068, 350, { padTop: 26, xMin: 1000, xMax: 7500, xStep: 1000, xFmt: (v) => v / 1000 + 'k', xUnit: 'rpm', yMin: 0, yMax: top, yStep: top > 0.6 ? 0.2 : 0.1,
        yFmt: (v) => v.toFixed(1), yUnit: 'g', series: gl.map((g) => ({ pts: cur[g], color: gc(g), width: 3 })),
        empty: 'Pull through the gears under load: one line per gear appears' });
    gl.forEach((g, i) => { cv.roundRect(560 + i * 90, 76, 16, 16, 4, gc(g)); cv.text('gear ' + g, 582 + i * 90, 90, 16, t.text); });
    cv.text('Higher line: the car pushes you harder. A gear\'s line ends where the gearbox shifted up.', 48, 494, 17, t.dim);

    G.panel(cv, t, 1140, 44, 436, 468, 'Strongest pull');
    const rows = gl.map((g) => {
        const best = cur[g].reduce((m, p) => (p[1] > m[1] ? p : m), cur[g][0]);
        return [{ text: String(g), color: gc(g) }, best[1].toFixed(2) + ' g', sp(best[0]) + ' rpm', isNum(s.ratios[g]) ? s.ratios[g].toFixed(1) : '--'];
    });
    G.table(cv, t, 1160, 104, 396, [{ label: 'Gear', w: 70, font: 'bold' }, { label: 'Most g', w: 100, align: 'right' }, { label: 'At', w: 120, align: 'right' },
        { label: 'rpm/kmh', w: 106, align: 'right' }], rows, { rowH: 40, size: 20, empty: 'None yet' });
    cv.text('rpm/kmh: the gear\'s ratio as the car', 1160, 470, 15, t.dim);
    cv.text('drives it (bigger = shorter gear)', 1160, 492, 15, t.dim);
}

/* ---------- How it works ---------- */
function help(cv, t, s) {
    G.panel(cv, t, 24, 44, 1552, 468, 'How Shift Lab works');
    [
        ['1', 'It learns your gearbox.', 'Every gear turns the engine a set number of rpm per km/h. Driving a little in each gear is enough; the lines on Live are those gears.'],
        ['2', 'It times every upshift under load.', 'When the gear steps up while the engine pulls (more than ' + s.minTorque + ' Nm or 0.08 g), it looks at the seconds around it: the shift starts at the highest rpm and ends when the rpm matches the new gear.'],
        ['3', 'It shows what you felt.', 'The push in g before the shift, the lowest during it (the dip you feel) and after it; and the rpm drop. Shifts compares every gear change.'],
        ['4', 'It draws your car\'s pull.', 'Under load it notes the g in each gear for every 250 rpm. Pull shows the curves: where the engine is strongest and how much each gear gives.'],
    ].forEach((r, i) => {
        const y = 136 + i * 84;
        cv.circle(66, y - 8, 20, withAlpha(t.accent, 0.3));
        cv.text(r[0], 66, y, 22, t.text, { align: 'center', font: 'bold' });
        cv.text(r[1], 104, y, 23, t.text, { font: 'bold' });
        cv.text(r[2], 104, y + 30, 17, t.dim);
    });
    cv.text('It only reads what the car sends anyway (rpm, speed, g, torque, gear). Times are measured from those signals, ten to fifty a second: a guide, not a lab figure.', 48, 496, 16, t.dim);
}

function draw(cv, t, page, s) {
    if (page === 1) shiftsPage(cv, t, s);
    else if (page === 2) pullPage(cv, t, s);
    else if (page === 3) help(cv, t, s);
    else live(cv, t, s);
}

module.exports = { draw, gc, when };
