'use strict';
/**
 * battery_view.js - Service's Battery tab, two views (the voltage is read while this page shows, battery_read.js):
 *
 *   Today          the three numbers of this wake (resting, lowest seen while starting, charging), each on its own
 *                  scale with good / weak / low bands, and this wake's voltage as a chart with the start marked
 *   History        resting and starting voltage over the last starts with a trend line, and a verdict in plain words
 *
 *   draw(cv, t, view, s)   view 'today' | 'history'   s = { live: { v, t, soc }, phase, cur, trace, startAt, entries, every, source, demo, now }
 *   verdict(entries)       { word, color: 'go' | 'warn' | 'crit' | 'dim', lines: [..] }
 *
 * The bands are general guidance for a 12 V lead-acid or AGM battery, not BMW's own limits.
 */
const G = require('./kit/gauges');
const { withAlpha } = require('./kit/canvas');
const { trend } = require('./battery_log');

const GO = '#2fd27a';
const isNum = (x) => typeof x === 'number' && isFinite(x);
const two = (n) => (n < 10 ? '0' : '') + n;
const dd = (ms) => { const d = new Date(ms); return two(d.getDate()) + '.' + two(d.getMonth() + 1) + '.'; };
const V = (v, d) => (isNum(v) ? v.toFixed(d == null ? 2 : d) : '--');

// [from, to, word, colour key]
const SCALES = {
    rest: { min: 11.6, max: 13.0, bands: [[11.6, 12.2, 'LOW', 'crit'], [12.2, 12.5, 'WEAK', 'warn'], [12.5, 13.0, 'GOOD', 'go']],
        say: { LOW: 'Low after standing: charge it or have it tested', WEAK: 'A little low after standing', GOOD: 'Holds its charge well while parked' } },
    crank: { min: 8.5, max: 12.0, bands: [[8.5, 9.6, 'LOW', 'crit'], [9.6, 10.0, 'WEAK', 'warn'], [10.0, 12.0, 'GOOD', 'go']],
        say: { LOW: 'Dips deep while starting: a weak battery or a cold one', WEAK: 'Dips quite far while starting', GOOD: 'Starts the engine without a deep dip' } },
    run: { min: 12.0, max: 15.5, bands: [[12.0, 12.4, 'LOW', 'crit'], [12.4, 13.2, 'RESTING', 'go'], [13.2, 15.0, 'CHARGING', 'go'], [15.0, 15.5, 'HIGH', 'crit']],
        say: { LOW: 'Not charging: have the alternator checked', RESTING: 'BMW lets the battery rest while cruising: normal', CHARGING: 'The alternator charges the battery', HIGH: 'Charging voltage high: have it checked' } },
};
const colorOf = (t, k) => (k === 'go' ? GO : k === 'warn' ? t.warn : k === 'crit' ? t.crit : t.dim);
const band = (sc, v) => (isNum(v) ? sc.bands.find((b) => v < b[1]) || sc.bands[sc.bands.length - 1] : null);

/* One number on its scale: the bands drawn, the value's marker, its word and a line. */
function tile(cv, t, x, y, w, h, title, key, v, sub) {
    const sc = SCALES[key], b = band(sc, v), c = b ? colorOf(t, b[3]) : t.dim;
    G.panel(cv, t, x, y, w, h, title);
    cv.text(V(v), x + 22, y + 116, 62, isNum(v) ? c : t.dim, { font: 'num' });
    cv.text('V', x + 26 + cv.textWidth(V(v), 62, { font: 'num' }), y + 116, 26, t.dim);
    if (b) G.pill(cv, t, x + w - 150, y + 66, 130, 32, b[2], { color: c, size: 16 });
    const bx = x + 22, bw = w - 44, by = y + 140, X = (q) => bx + (G.clamp(q, sc.min, sc.max) - sc.min) / (sc.max - sc.min) * bw;
    sc.bands.forEach((z) => cv.roundRect(X(z[0]), by, X(z[1]) - X(z[0]) - 2, 14, 4, withAlpha(colorOf(t, z[3]), 0.35)));
    sc.bands.forEach((z, i) => { if (i) cv.text(z[0].toFixed(1), X(z[0]), by + 34, 14, t.dim, { align: 'center' }); });
    if (isNum(v)) {
        const mx = X(v);
        cv.fillRect(Math.round(mx) - 2, by - 8, 5, 30, t.text);
        cv.circle(mx, by - 10, 6, t.text);
    }
    cv.text(b ? sc.say[b[2]] : 'Not read yet', x + 22, y + h - 20, 17, b ? t.text : t.dim);
    if (sub) cv.text(sub, x + w - 22, y + 50, 14, t.dim, { align: 'right' });
}

function today(cv, t, s) {
    const live = s.live, c = s.cur || {}, last = s.entries[s.entries.length - 1];
    const p = G.panel(cv, t, 24, 44, 1552, 84, null);
    const PH = { rest: 'Engine off: resting voltage ' + (isNum(c.rest) ? 'taken, waiting for the start' : 'being read'), crank: 'Starting: watching the dip',
        run: 'Engine running: reading the charging voltage', done: 'This start is in the diary' };
    cv.text('NOW', 48, 78, 15, t.dim, { font: 'bold', spacing: 2 });
    cv.text(PH[s.phase] || '', 48, 112, 24, t.text, { font: 'bold' });
    if (isNum(live.soc)) cv.text('charge the car reports ' + Math.round(live.soc) + ' %', p.x + p.w - 250, 108, 17, t.dim, { align: 'right' });
    cv.text(isNum(live.v) ? V(live.v) + ' V' : (s.source ? '-- V' : 'looking for the voltage'), p.x + p.w - 24, 112, 34, isNum(live.v) ? t.text : t.dim, { align: 'right', font: 'num' });

    // this wake's values, else the last start's (dimmed by the sub line)
    const from = isNum(c.rest) || isNum(c.crank) || c.runs && c.runs.length ? null : last;
    const sub = from ? 'last start ' + dd(from.at) : 'this start';
    const runNow = c.runs && c.runs.length ? c.runs.slice().sort((a, b) => a - b)[c.runs.length >> 1] : null;
    tile(cv, t, 24, 140, 510, 220, 'Resting (after standing)', 'rest', from ? from.rest : c.rest, sub);
    tile(cv, t, 545, 140, 510, 220, 'Lowest seen while starting', 'crank', from ? from.crank : c.crank, sub);
    tile(cv, t, 1066, 140, 510, 220, 'Engine running', 'run', from ? from.run : runNow, sub);

    // this wake's voltage
    G.panel(cv, t, 24, 372, 1552, 140, null);
    const tr = s.trace || [], now = s.now, span = 10 * 60;
    cv.text('THIS WAKE, LAST 10 MINUTES', 48, 396, 14, t.dim, { font: 'bold', spacing: 2 });
    const ch = G.chart(cv, t, 40, 408, 1520, 100, { xMin: -span, xMax: 0, yMin: 9, yMax: 15, yStep: 3, xStep: 120,
        xFmt: (x) => (x === 0 ? 'now' : Math.round(x / 60) + ' min'), yFmt: (y) => y.toFixed(0) + ' V', padLeft: 56,
        marks: [{ y: 12.5, color: withAlpha(GO, 0.7) }],
        series: [{ pts: tr.map((q) => [(q.t - now) / 1000, q.v]), color: t.accent, width: 2.5, fill: 0.12 }], empty: 'No readings yet' });
    if (isNum(s.startAt) && now - s.startAt < span * 1000) {
        const mx = Math.round(ch.X((s.startAt - now) / 1000));
        cv.fillRect(mx - 1, ch.py, 3, ch.ph, t.crit);
        cv.text('ENGINE START', mx + 6, ch.py + ch.ph - 6, 13, t.crit, { font: 'bold', spacing: 1 });
    }
}

function verdict(entries) {
    const rest = entries.map((e) => e.rest).filter(isNum), crank = entries.map((e) => e.crank).filter(isNum);
    if (rest.length < 3 && crank.length < 3) return { word: 'NOT ENOUGH STARTS YET', color: 'dim', lines: ['A few starts with this page open give a first picture, ten a good one.'] };
    const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length, last = (a) => a.slice(-5);
    const r = rest.length ? avg(last(rest)) : null, k = crank.length ? avg(last(crank)) : null;
    const tr = trend(entries.map((e) => e.rest)), per10 = tr ? tr.slope * 10 : 0;
    const lines = [];
    if (isNum(r)) lines.push('Resting, the last 5 starts: ' + r.toFixed(2) + ' V on average.');
    if (isNum(k)) lines.push('Lowest seen while starting: ' + k.toFixed(2) + ' V on average.');
    if (tr) lines.push(Math.abs(per10) < 0.02 ? 'Resting voltage steady over the starts.' : 'Resting voltage ' + (per10 < 0 ? 'falls' : 'rises') + ' about ' + Math.abs(per10 * 1000).toFixed(0) + ' mV every 10 starts.');
    let word = 'HEALTHY', color = 'go';
    if ((isNum(r) && r < 12.2) || (isNum(k) && k < 9.6)) { word = 'HAVE IT TESTED'; color = 'crit'; lines.push('Before winter or a long trip, have the battery tested.'); }
    else if ((isNum(r) && r < 12.5) || (isNum(k) && k < 10.0) || per10 < -0.05) { word = 'WATCH IT'; color = 'warn'; lines.push('Fine for now. Short trips and long standing drain it: a long drive or a charger helps.'); }
    else lines.push('Nothing to do. Cold weather lowers every number a little.');
    const soc = entries.map((e) => e.soc).filter(isNum);
    if (soc.length) lines.push('Charge the car reported at the last start: ' + soc[soc.length - 1] + ' %.');
    return { word, color, lines };
}

function history(cv, t, s) {
    const l = s.entries.slice(-60);
    G.panel(cv, t, 24, 44, 1000, 468, 'The last starts (' + l.length + ')');
    const n = Math.max(2, l.length), xf = (x) => { const e = l[Math.round(x)]; return e ? dd(e.at) : ''; };
    const step = Math.max(1, Math.ceil(n / 6));
    const draw = (y, h, key, label, lo, hi, color) => {
        const vals = l.map((e) => e[key]), tr = trend(vals), sc = SCALES[key];
        cv.text(label, 48, y - 8, 16, color, { font: 'bold' });
        G.chart(cv, t, 40, y, 968, h, { xMin: 0, xMax: n - 1, yMin: lo, yMax: hi, xStep: step, xFmt: xf, yFmt: (v) => v.toFixed(1) + ' V', padLeft: 60,
            marks: sc.bands.slice(1).map((b) => ({ y: b[0], color: colorOf(t, sc.bands[sc.bands.indexOf(b) - 1][3]), label: b[0].toFixed(1) + ' V' })),
            series: [
                { pts: vals.map((v, i) => [i, v]), color, width: 2.5 },
                tr && { pts: [[0, tr.at(0)], [n - 1, tr.at(n - 1)]], color: t.text, width: 2, dash: true },
            ].filter(Boolean), empty: 'The first starts show up here' });
    };
    draw(124, 160, 'rest', 'Resting, after standing', 11.6, 13.0, t.accent);
    draw(330, 160, 'crank', 'Lowest seen while starting', 8.5, 12.0, t.warn);
    cv.text('dashed line: the trend', 1008, 116, 14, t.dim, { align: 'right' });

    const v = verdict(l), c = colorOf(t, v.color);
    G.panel(cv, t, 1040, 44, 536, 468, 'What it says');
    cv.roundRect(1060, 96, 496, 70, 12, withAlpha(c, 0.18));
    cv.text(v.word, 1308, 142, 28, c, { align: 'center', font: 'bold', spacing: 1.5 });
    let y = 204;
    v.lines.forEach((line) => {
        // wrap at about 44 characters
        const words = line.split(' '); let row = '';
        words.forEach((wd) => { if ((row + ' ' + wd).length > 50) { cv.text(row, 1064, y, 18, t.text); y += 26; row = wd; } else row = row ? row + ' ' + wd : wd; });
        if (row) { cv.text(row, 1064, y, 18, t.text); y += 26; }
        y += 10;
    });
    cv.text('General guidance for a 12 V battery,', 1064, 472, 14, t.dim);
    cv.text('not BMW\'s own limits.', 1064, 492, 14, t.dim);
}

function draw(cv, t, view, s) {
    if (view === 'history') history(cv, t, s);
    else today(cv, t, s);
}

module.exports = { draw, verdict, SCALES, band };
