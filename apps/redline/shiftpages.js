'use strict';
/**
 * shiftpages.js - Redline's shift timing pages (from Shift Lab, #253), next to Tach / Shift log / Learned / HUD looks:
 *
 *   Shift times    how long each gear change under load takes (average and best), how far the rpm drops, the last ones
 *   Pull           how hard the car pushes in each gear across the revs (g), one line per gear, and each gear's best
 *   Kickdown       how fast the gearbox drops a gear when you floor it, per driving mode; when it held the gear
 *                  instead; the newest one as a timeline; the last ones as a table
 *   Cold vs hot    upshift times against the gearbox oil temperature, and per temperature band with the kickdowns
 *
 *   draw(cv, t, which, s)   which = 'times' | 'pull' | 'kick' | 'cold';
 *                           s = { shifts, ratios, curves, perGear, minTorque, kicks, pedal, gb, armed }
 * Drawn on the kit's Recorder like the Learned page (record.js: quad, no convex). Times are shown to 10 ms (the car's
 * signals come 10 to 50 times a second); 'best' is the 10th percentile (shiftlab.js), not one lucky reading.
 */
const G = require('./kit/gauges');
const { withAlpha } = require('./kit/canvas');
const { byMode, byBand, BANDS } = require('./kickdown');

const GEAR_COL = ['#ff5a5a', '#ffa23a', '#ffd84a', '#2fd27a', '#3ac8ff', '#7d8bff', '#c06bff', '#ff6fb5', '#ffffff', '#aaaaaa'];
const gc = (g) => GEAR_COL[(g - 1) % GEAR_COL.length];
const isNum = G.isNum;
const two = (n) => (n < 10 ? '0' : '') + n;
const when = (ms) => { const d = new Date(ms); return d.getDate() + '.' + two(d.getMonth() + 1) + '. ' + two(d.getHours()) + ':' + two(d.getMinutes()); };
const sp = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
/** A time in ms as shown: to the nearest 10 ms. */
const ms10 = (v) => String(Math.round(v / 10) * 10);
const gears = (ratios) => Object.keys(ratios || {}).map(Number).filter((g) => g >= 1 && isNum(ratios[g])).sort((a, b) => a - b);

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
                cv.text(ms10(v), x0 + bw / 2, y0 - 6, 16, t.text, { align: 'center', font: 'num' });
            });
            cv.text(p.from + ' > ' + p.to, cx, c.py + c.ph + 22, 18, t.text, { align: 'center', font: 'bold' });
        });
        cv.roundRect(500, 76, 14, 14, 3, t.accent); cv.text('average', 520, 89, 16, t.dim);
        cv.roundRect(600, 76, 14, 14, 3, GO_COL); cv.text('best (fastest 10 %)', 620, 89, 16, t.dim);
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
    const rows = s.shifts.slice(0, 8).map((x) => [when(x.at), { text: x.from + ' > ' + x.to, color: gc(x.to) }, ms10(x.ms) + ' ms',
        sp(x.rpmBefore) + ' > ' + sp(x.rpmAfter), Math.round(x.kmh || 0) + ' km/h', isNum(x.gDip) ? x.gDip.toFixed(2) + ' g' : '--']);
    G.table(cv, t, 820, 104, 740, [{ label: 'When', w: 150 }, { label: 'Change', w: 90, font: 'bold' }, { label: 'Took', w: 100, align: 'right' },
        { label: 'rpm', w: 190, align: 'right' }, { label: 'Speed', w: 110, align: 'right' }, { label: 'Lowest g', w: 100, align: 'right' }], rows,
    { rowH: 40, size: 19, empty: 'None yet' });
    // counted: gear changes up while the engine pulls (more than the setting's Nm, or 0.08 g)
    cv.text('Counted: upshifts under load (over ' + s.minTorque + ' Nm or 0.08 g). Times from the car\'s signals: a guide.', 820, 496, 15, t.dim);
    // Clear (pressed twice) where the page has its own buttons (GPU renderer); the ratios stay
    if (s.clear) G.button(cv, t, 1396, 54, 164, 34, 'Clear', s.clear, { confirm: true, key: 'redline-lab-clear' });
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


/* ---------- Kickdown ---------- */
const MODE_NAME = { sport: 'Sport', comfort: 'Comfort', eco: 'Eco Pro', hybrid: 'Hybrid', other: 'Mode not sent' };
const MODE_COL = { sport: '#ff5a5a', comfort: '#3ac8ff', eco: '#2fd27a', hybrid: '#c06bff', other: '#aaaaaa' };
const gearsOf = (k) => (k.kind === 'held' ? 'held ' + k.from : k.from + ' > ' + k.to);

function kickPage(cv, t, s) {
    const kicks = s.kicks || [], modes = byMode(kicks), est = kicks.some((k) => k.est);
    G.panel(cv, t, 24, 44, 760, 468, 'How fast it kicks down when you floor it');
    if (!kicks.length) {
        ['No kickdown seen yet.', '',
            'Floor it from part throttle above 15 km/h:', 'the time from the kick to the lower gear shows here,',
            'per driving mode, and when the gearbox kept the gear.']
            .forEach((l, i) => cv.text(l, 48, 140 + i * 32, 21, i ? t.dim : t.text, { font: i ? 'label' : 'bold' }));
    } else {
        const done = modes.filter((m) => isNum(m.avgMs));
        const fast = done.slice().sort((a, b) => a.avgMs - b.avgMs);
        const line = fast.length > 1 ? MODE_NAME[fast[0].mode] + ' drops a gear in ' + fast[0].avgMs + ' ms on average, ' + MODE_NAME[fast[fast.length - 1].mode] + ' in ' + fast[fast.length - 1].avgMs + ' ms.'
            : fast.length ? MODE_NAME[fast[0].mode] + ': ' + fast[0].avgMs + ' ms from the kick to the lower gear.' : 'Every kickdown so far kept its gear.';
        cv.text(line, 48, 126, 20, t.text, { font: 'bold' });
        const held = kicks.filter((k) => k.kind === 'held').length;
        cv.text(kicks.length + ' kickdowns, ' + held + ' held the gear' + (est ? '. Timed from the jump in engine torque: an estimate' : ''), 48, 150, 16, est ? t.warn : t.dim);
        // average and best per mode
        const n = modes.length, ymax = Math.max(400, Math.ceil(Math.max.apply(null, done.map((m) => m.avgMs).concat([0])) / 100) * 100 + 100);
        const c = G.chart(cv, t, 40, 166, 728, 180, { padTop: 22, xMin: 0, xMax: n, xStep: n, xFmt: () => '', yMin: 0, yMax: ymax, series: [] });
        cv.text('ms', c.px - 8, c.py - 12, 14, t.dim, { align: 'right', font: 'bold' });
        const slot = c.pw / n, bw = Math.min(46, slot * 0.3);
        modes.forEach((m, i) => {
            const cx = c.px + slot * (i + 0.5);
            [[m.avgMs, MODE_COL[m.mode], -1], [m.bestMs, withAlpha(MODE_COL[m.mode], 0.5), 1]].forEach(([v, col, side]) => {
                if (!isNum(v)) return;
                const x0 = cx + (side < 0 ? -bw - 3 : 3), y0 = c.Y(v);
                cv.roundRect(x0, y0, bw, c.py + c.ph - y0, 4, col);
                cv.text(ms10(v), x0 + bw / 2, y0 - 6, 15, t.text, { align: 'center', font: 'num' });
            });
            cv.text(MODE_NAME[m.mode], cx, c.py + c.ph + 20, 17, t.text, { align: 'center', font: 'bold' });
            if (m.held) cv.text(m.held + 'x held', cx, c.py + c.ph + 40, 14, t.warn, { align: 'center' });
        });
        cv.text('full: average   faded: best (fastest 10 %)', 768, 190, 14, t.dim, { align: 'right' });
        // the newest downshift as a timeline: the kick, rpm starts to rise, the lower gear
        const k = kicks.find((x) => x.kind === 'down' && isNum(x.doneMs));
        if (k) {
            const x0 = 64, w = 680, y = 448, full = Math.max(600, Math.ceil(k.doneMs / 200) * 200 + 200), X = (ms) => x0 + w * ms / full;
            cv.text('NEWEST: ' + (MODE_NAME[k.mode] || '').toUpperCase() + ', ' + gearsOf(k) + ' AT ' + k.kmh + ' KM/H', 48, 410, 14, t.dim, { font: 'bold', spacing: 1.5 });
            cv.roundRect(x0, y - 6, w, 12, 6, withAlpha(t.track, 0.7));
            if (isNum(k.startMs)) cv.roundRect(x0, y - 6, X(k.startMs) - x0, 12, 6, withAlpha(t.warn, 0.7));
            cv.roundRect(isNum(k.startMs) ? X(k.startMs) : x0, y - 6, X(k.doneMs) - (isNum(k.startMs) ? X(k.startMs) : x0), 12, 6, MODE_COL[k.mode] || t.accent);
            [[0, 'kick'], [k.startMs, 'revs start rising'], [k.doneMs, 'in gear ' + k.to + ': ' + ms10(k.doneMs) + ' ms']].forEach(([ms, l], i) => {
                if (!isNum(ms)) return;
                cv.fillRect(X(ms) - 1, y - 14, 3, 28, t.text);
                cv.text(l, X(ms), y + 34, 15, i === 2 ? t.text : t.dim, { align: i === 0 ? 'left' : i === 2 ? 'right' : 'center' });
            });
        }
    }
    G.panel(cv, t, 800, 44, 776, 468, 'Last kickdowns (' + kicks.length + ')');
    const rows = kicks.slice(0, 8).map((k) => [when(k.at), { text: MODE_NAME[k.mode || 'other'], color: MODE_COL[k.mode || 'other'] },
        { text: gearsOf(k), color: k.kind === 'held' ? t.warn : t.text }, isNum(k.startMs) ? ms10(k.startMs) + ' ms' : '--', isNum(k.doneMs) ? ms10(k.doneMs) + ' ms' : '--',
        k.kmh + ' km/h', isNum(k.gb) ? k.gb + ' °C' : '--']);
    G.table(cv, t, 820, 104, 740, [{ label: 'When', w: 130 }, { label: 'Mode', w: 120, font: 'bold' }, { label: 'Gears', w: 90 }, { label: 'Revs up', w: 90, align: 'right' },
        { label: 'New gear', w: 100, align: 'right' }, { label: 'Speed', w: 100, align: 'right' }, { label: 'Gearbox', w: 110, align: 'right' }], rows,
    { rowH: 40, size: 18, empty: 'None yet' });
    cv.text('Revs up: kick (torque jump) to the revs rising. New gear: kick to the lower gear engaged.', 820, 496, 15, t.dim);
}

/* ---------- Cold vs hot ---------- */
const BAND_COL = { cold: '#3ac8ff', cool: '#7d8bff', warm: '#2fd27a', hot: '#ffa23a' };
const BAND_TXT = { cold: 'under 40 °C', cool: '40 to 70 °C', warm: '70 to 90 °C', hot: 'over 90 °C' };

function coldPage(cv, t, s) {
    const shifts = (s.shifts || []).filter((x) => isNum(x.gb) && isNum(x.ms));
    G.panel(cv, t, 24, 44, 1000, 468, 'Upshift time against the gearbox oil temperature');
    const tmin = 0, tmax = 120, ymax = Math.max(300, Math.ceil(Math.max.apply(null, shifts.map((x) => x.ms).concat([0])) / 100) * 100 + 100);
    const c = G.chart(cv, t, 40, 100, 968, 350, { padTop: 22, xMin: tmin, xMax: tmax, xStep: 20, xUnit: '°C', yMin: 0, yMax: ymax, series: [],
        empty: shifts.length ? null : 'No shift with a gearbox oil temperature yet' });
    cv.text('ms', c.px - 8, c.py - 12, 14, t.dim, { align: 'right', font: 'bold' });
    BANDS.forEach((b) => {
        const a = c.X(Math.max(tmin, b[1])), z = c.X(Math.min(tmax, b[2]));
        cv.fillRect(a, c.py, z - a, c.ph, withAlpha(BAND_COL[b[0]], 0.07));
        cv.text(b[0].toUpperCase(), (a + z) / 2, c.py + 14, 13, withAlpha(BAND_COL[b[0]], 0.9), { align: 'center', font: 'bold', spacing: 1.5 });
    });
    const bands = byBand(shifts, 'ms');
    bands.forEach((b) => { if (isNum(b.avgMs)) { const a = c.X(Math.max(tmin, b.lo)), z = c.X(Math.min(tmax, b.hi)); cv.fillRect(a + 4, Math.round(c.Y(b.avgMs)), z - a - 8, 3, BAND_COL[b.band]); } });
    shifts.forEach((x) => { cv.circle(c.X(Math.max(tmin, Math.min(tmax, x.gb))), c.Y(x.ms), 6, withAlpha(gc(x.to), 0.85)); });
    cv.text('Each dot is an upshift under load; the line in each band is its average. Colder oil: thicker, slower shifts.', 48, 496, 16, t.dim);

    G.panel(cv, t, 1040, 44, 536, 468, 'Per temperature band');
    G.readout(cv, t, 1064, 96, { label: 'gearbox oil now', value: s.gb, unit: '°C', size: 40, labelSize: 14 });
    const kb = byBand((s.kicks || []).filter((k) => k.kind === 'down'), 'doneMs'), warm = bands.find((b) => b.band === 'warm' && isNum(b.avgMs));
    const cold = bands.find((b) => (b.band === 'cold' || b.band === 'cool') && isNum(b.avgMs));
    const say = warm && cold ? (BAND_TXT[cold.band] + ': upshifts take ' + Math.round((cold.avgMs / warm.avgMs - 1) * 100) + ' % longer than warm.')
        : isNum(s.gb) || shifts.length ? 'Needs shifts in more than one band to compare.' : 'The car has not sent a gearbox oil temperature.';
    cv.text(say, 1064, 192, 17, t.text);
    const top = Math.max(300, Math.max.apply(null, bands.concat(kb).map((b) => b.avgMs || 0)));
    BANDS.forEach((b, i) => {
        const y = 230 + i * 66, u = bands[i], k = kb[i];
        cv.text(b[0].toUpperCase(), 1064, y + 16, 15, BAND_COL[b[0]], { font: 'bold', spacing: 1.5 });
        cv.text(BAND_TXT[b[0]], 1064, y + 36, 13, t.dim);
        [[u, 'up', BAND_COL[b[0]], 0], [k, 'kickdown', withAlpha(BAND_COL[b[0]], 0.5), 22]].forEach(([v, l, col, dy]) => {
            const w = isNum(v.avgMs) ? Math.max(6, 250 * v.avgMs / top) : 0;
            if (w) cv.roundRect(1180, y + 4 + dy, w, 16, 4, col);
            cv.text(isNum(v.avgMs) ? ms10(v.avgMs) + ' ms ' + l + ' (' + v.n + ')' : l + ': none', 1180 + w + 8, y + 17 + dy, 14, isNum(v.avgMs) ? t.text : t.dim);
        });
    });
}

function draw(cv, t, which, s) {
    if (which === 'pull') pullPage(cv, t, s);
    else if (which === 'kick') kickPage(cv, t, s);
    else if (which === 'cold') coldPage(cv, t, s);
    else shiftsPage(cv, t, s);
}

module.exports = { draw, gc, when, PAGES: ['Shift times', 'Pull', 'Kickdown', 'Cold vs hot'], WHICH: ['times', 'pull', 'kick', 'cold'] };
