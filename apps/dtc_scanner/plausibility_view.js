'use strict';
/**
 * plausibility_view.js - the Fault Scanner's Plausibility tab, its three pages, drawn from a Sanity (plausibility.js):
 *
 *   Checks         a summary line, then one card per check: its state (OK / ODD / LATE / NO DATA), why in plain
 *                  words and a small chart of the two values it compares
 *   History        when a check went ODD or LATE, on one lane per check, and the latest as a list
 *   How it works   what it compares, and that it cannot tell which sensor is wrong
 *
 *   draw(cv, t, page, s, o)    s = the Sanity, o = { now, demo }
 */
const G = require('./kit/gauges');
const { withAlpha } = require('./kit/canvas');
const { IDS, NAMES } = require('./plausibility');

const GO = '#2fd27a';
const isNum = (v) => typeof v === 'number' && isFinite(v);
const two = (n) => (n < 10 ? '0' : '') + n;
const clock = (ms) => { const d = new Date(ms); return two(d.getHours()) + ':' + two(d.getMinutes()) + ':' + two(d.getSeconds()); };
const stateColor = (t, st) => (st === 'OK' ? GO : st === 'ODD' ? t.warn : st === 'LATE' ? t.crit : t.dim);

/* Words cut into lines that fit w px (at most n lines, the last one ends with "..." when cut). */
function wrap(cv, s, size, w, n) {
    const words = String(s || '').split(' '), out = [];
    let line = '';
    for (const word of words) {
        const next = line ? line + ' ' + word : word;
        if (cv.textWidth(next, size) <= w) { line = next; continue; }
        out.push(line); line = word;
        if (out.length === n) break;
    }
    if (out.length < n && line) out.push(line);
    if (out.length === n && words.join(' ') !== out.join(' ')) {
        let last = out[n - 1];
        while (last.length > 1 && cv.textWidth(last + '...', size) > w) last = last.slice(0, -1);
        out[n - 1] = last + '...';
    }
    return out;
}

/* A check's card: title, state pill, why, and its chart in the room below. */
function card(cv, t, x, y, w, h, id, c, chart) {
    G.panel(cv, t, x, y, w, h, NAMES[id]);
    const col = stateColor(t, c.state);
    G.pill(cv, t, x + w - 132, y + 14, 112, 28, c.state, { color: col, size: 15 });
    wrap(cv, c.reason, 16, w - 40, 2).forEach((l, i) => cv.text(l, x + 20, y + 64 + i * 19, 16, i === 0 && c.state !== 'OK' ? col : t.dim));
    chart(x + 12, y + 92, w - 28, h - 98);
}

function lineChart(cv, t, x, y, w, h, series, o) {
    const pts = [].concat.apply([], series.map((s) => s.pts.map((p) => p[1]))).filter(isNum);
    let lo = pts.length ? Math.min.apply(null, pts) : 0, hi = pts.length ? Math.max.apply(null, pts) : 1;
    if (o.lo !== undefined) lo = Math.min(lo, o.lo);
    if (o.hi !== undefined) hi = Math.max(hi, o.hi);
    const pad = Math.max(1, (hi - lo) * 0.2);
    const y0 = o.yMin !== undefined ? o.yMin : Math.floor(lo - pad), y1 = o.yMax !== undefined ? o.yMax : Math.ceil(hi + pad);
    return G.chart(cv, t, x, y, w, h, { xMin: o.x0, xMax: o.x1, yMin: y0, yMax: y1, yStep: o.yStep || G.niceStep(y1 - y0, 2), xStep: o.xStep,
        xFmt: o.xFmt, yFmt: o.yFmt, yUnit: o.yUnit, padLeft: o.padLeft || 46, padBottom: 22, series, marks: o.marks, empty: o.empty || 'No data yet' });
}

function checksPage(cv, t, s, o) {
    const now = o.now, n = { ODD: 0, LATE: 0, 'NO DATA': 0 };
    IDS.forEach((id) => { const st = s.checks[id].state; if (n[st] !== undefined) n[st]++; });
    const bad = n.ODD + n.LATE;
    G.panel(cv, t, 24, 44, 1552, 56, null);
    cv.text(bad ? (n.ODD ? n.ODD + ' ODD' : '') + (n.ODD && n.LATE ? ', ' : '') + (n.LATE ? n.LATE + ' LATE' : '') : n['NO DATA'] === IDS.length ? 'WAITING' : 'ALL IN AGREEMENT',
        48, 82, 26, bad ? (n.LATE ? t.crit : t.warn) : n['NO DATA'] === IDS.length ? t.dim : GO, { font: 'bold', spacing: 2 });
    cv.text(bad ? 'Two values disagree or one went quiet: look at the card for what and why.'
        : 'Every pair of values that has to agree does.' + (n['NO DATA'] ? ' ' + n['NO DATA'] + ' not checked yet.' : ''), 380, 80, 19, t.dim);
    cv.text(s.events.length + ' found so far: History (Plausibility again)', 1552, 80, 17, t.dim, { align: 'right' });

    const row1 = 108, row2 = 314, h = 198, w3 = 512, w2 = 772;
    const ten = { x0: -10, x1: 0, xStep: 2, xFmt: (v) => (v === 0 ? 'now' : v === -10 ? '10 min ago' : Math.round(-v) + '') };
    const since = (arr) => (arr || []).map((p) => [(p[0] - now) / 60000, p[1]]);

    // gear: rpm against speed, each learned gear a line
    card(cv, t, 24, row1, w3, h, 'gear', s.checks.gear, (x, y, w, hh) => {
        const gears = s.learned(), pts = s.pts || [], vmax = Math.max(120, ...pts.map((p) => p[0]));
        const top = Math.ceil(Math.max(4000, ...pts.map((p) => p[1])) / 1000) * 1000;
        const c = G.chart(cv, t, x, y, w, hh, { xMin: 0, xMax: Math.ceil(vmax / 40) * 40, yMin: 0, yMax: top, yStep: top / 2, xStep: 40,
            xFmt: (v) => (v ? v + '' : '0 km/h'), yFmt: (v) => (v / 1000) + 'k rpm', padLeft: 62, padBottom: 22,
            series: gears.map((g) => ({ pts: [[0, 0], [vmax, g.k * vmax]], color: withAlpha(t.dim, 0.6), width: 1.5 })) });
        pts.slice(-60).forEach((p, i, a) => cv.circle(c.X(p[0]), c.Y(Math.min(p[1], top)), i === a.length - 1 ? 6 : 3, withAlpha(i === a.length - 1 ? stateColor(t, s.checks.gear.state) : t.accent, i === a.length - 1 ? 1 : 0.35)));
    });
    // oil and coolant
    card(cv, t, 24 + w3 + 8, row1, w3, h, 'temps', s.checks.temps, (x, y, w, hh) => {
        lineChart(cv, t, x, y, w, hh, [{ pts: since(s.hist.coolant), color: t.accent2, width: 2 }, { pts: since(s.hist.oil), color: t.warn, width: 2.5 }], Object.assign({ yUnit: 'C' }, ten));
        cv.text('oil', x + w - 90, y + 14, 15, t.warn, { font: 'bold' });
        cv.text('coolant', x + w - 56, y + 14, 15, t.accent2, { font: 'bold' });
    });
    // g sent against g from the speed change
    card(cv, t, 24 + 2 * (w3 + 8), row1, w3, h, 'gspeed', s.checks.gspeed, (x, y, w, hh) => {
        const pr = (s.gPairs || []).map((p) => [(p[0] - now) / 1000, p[1], p[2]]);
        lineChart(cv, t, x, y, w, hh, [{ pts: pr.map((p) => [p[0], p[2]]), color: t.accent2, width: 2 }, { pts: pr.map((p) => [p[0], p[1]]), color: GO, width: 2.5 }],
            { x0: -120, x1: 0, xStep: 30, padLeft: 62, xFmt: (v) => (v === 0 ? 'now' : v === -120 ? '2 min ago' : Math.round(-v) + ' s'), yMin: -0.6, yMax: 0.6, yStep: 0.3, yFmt: (v) => v.toFixed(1) + ' g' });
        cv.text('sent', x + w - 132, y + 14, 15, GO, { font: 'bold' });
        cv.text('from speed', x + w - 90, y + 14, 15, t.accent2, { font: 'bold' });
    });
    // outside temperature
    card(cv, t, 24, row2, w2, h, 'outside', s.checks.outside, (x, y, w, hh) => {
        lineChart(cv, t, x, y, w, hh, [{ pts: since(s.hist.outside), color: t.accent, width: 2.5, fill: 0.12 }], Object.assign({ yUnit: 'C' }, ten));
    });
    // signals on time: how long each fast one has been quiet against 5x its usual gap
    card(cv, t, 24 + w2 + 8, row2, w2, h, 'late', s.checks.late, (x, y, w, hh) => {
        const ages = s.ages(now), bw = w - 190, rowH = 24;
        cv.text('QUIET FOR', x + w, y + 8, 13, t.dim, { align: 'right', font: 'bold', spacing: 1.5 });
        ages.forEach((a, i) => {
            const yy = y + 12 + i * rowH, lim = isNum(a.gap) ? Math.max(2000, 5 * a.gap) : null, f = lim && isNum(a.age) ? a.age / lim : null;
            cv.text(a.name, x + 8, yy + 15, 16, t.text);
            cv.roundRect(x + 110, yy + 5, bw, 12, 6, t.track);
            if (isNum(f)) cv.roundRect(x + 110, yy + 5, Math.max(12, bw * G.clamp(f, 0, 1)), 12, 6, f >= 1 ? t.crit : f > 0.5 ? t.warn : GO);
            cv.text(isNum(a.age) ? (a.age / 1000).toFixed(1) + ' s' : '--', x + w, yy + 15, 15, t.dim, { align: 'right' });
        });
        cv.text('a full bar: quiet 5 times longer than usual (at least 2 s)', x + 110, y + hh - 2, 14, t.dim);
    });
}

function historyPage(cv, t, s, o) {
    const now = o.now, ev = s.events, span = 30 * 60000, x0 = 230, x1 = 1540;
    G.panel(cv, t, 24, 44, 1552, 228, 'When a check disagreed: the last 30 minutes');
    const X = (ms) => x0 + (1 - (now - ms) / span) * (x1 - x0);
    IDS.forEach((id, i) => {
        const y = 118 + i * 27;
        cv.text(NAMES[id], 48, y + 6, 16, t.text);
        cv.fillRect(x0, y, x1 - x0, 2, withAlpha(t.tick, 0.5));
        ev.filter((e) => e.id === id && now - e.t <= span).forEach((e) => cv.roundRect(X(e.t) - 4, y - 9, 8, 20, 3, stateColor(t, e.state)));
    });
    [30, 20, 10, 0].forEach((m) => cv.text(m ? m + ' min ago' : 'now', X(now - m * 60000), 262, 14, t.dim, { align: m ? 'center' : 'right' }));
    G.panel(cv, t, 24, 280, 1552, 232, 'Found (' + ev.length + ', newest first)');
    const rows = ev.slice().reverse().slice(0, 4);
    if (!rows.length) cv.text('Nothing found yet: every pair has agreed so far.', 48, 372, 20, t.dim);
    rows.forEach((e, i) => {
        const y = 362 + i * 36;
        if (i % 2) cv.fillRect(36, y - 22, 1528, 32, withAlpha('#ffffff', 0.03));
        cv.text(clock(e.t), 48, y, 18, t.text);
        G.pill(cv, t, 150, y - 18, 84, 24, e.state, { color: stateColor(t, e.state), size: 13 });
        cv.text(NAMES[e.id], 254, y, 18, t.text, { font: 'bold' });
        cv.text(wrap(cv, e.reason, 16, 1050, 1)[0], 500, y, 16, t.dim);
    });
}

function helpPage(cv, t, s) {
    G.panel(cv, t, 24, 44, 1552, 468, 'How the Plausibility tab works');
    [
        ['It compares values that have to agree.', 'Speed and rpm must sit on one of your gears; oil and coolant must stay close once warm; the forward g the car sends must match how fast the speed changes; the outside temperature cannot jump.'],
        ['It watches each signal\'s rhythm.', 'rpm, speed and g arrive many times a second while driving. One that goes quiet for five times its usual gap is LATE.'],
        ['It cannot say which one is wrong.', 'ODD means two values disagree: one of the sensors, a wiring fault, a slipping clutch, a steep hill. Use it as a pointer for a closer look next to the faults, not as a verdict.'],
        ['It learns your car first.', 'The gears are learned from steady driving (kept between drives); oil and coolant are compared after 10 min with the coolant at 80 C; nothing while parked. It checks while the Fault Scanner is on screen.'],
    ].forEach((r, i) => {
        const y = 134 + i * 86;
        cv.circle(70, y - 8, 20, withAlpha(t.accent2, 0.3));
        cv.text(String(i + 1), 70, y, 22, t.text, { align: 'center', font: 'bold' });
        cv.text(r[0], 108, y, 23, t.text, { font: 'bold' });
        wrap(cv, r[1], 18, 1420, 2).forEach((l, k) => cv.text(l, 108, y + 28 + k * 22, 18, t.dim));
    });
    cv.text('Read only: it uses what the car sends the head unit anyway and asks nothing of any control unit. Settings > Plausibility checks turns it off.', 48, 496, 17, t.dim);
}

function draw(cv, t, page, s, o) {
    if (page === 1) historyPage(cv, t, s, o);
    else if (page === 2) helpPage(cv, t, s, o);
    else checksPage(cv, t, s, o);
}

module.exports = { draw, wrap };
