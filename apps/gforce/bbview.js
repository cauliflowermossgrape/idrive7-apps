'use strict';
/**
 * bbview.js - G-Force's recordings (the former Blackbox, #248): three pages, drawn from what background() keeps:
 *
 *   Live            the last 60 s in memory as two charts (speed and rpm, braking and accelerating in g, with the line
 *                   a hard stop saves at), and next to them what saves a recording, each with how close it is right now
 *   Recordings      the saved ones as a list; the chosen one as a summary (why it was saved, top speed, hardest braking,
 *                   most g, most power) and its charts, 0 s being the moment it was saved for
 *   Replay          the chosen recording played back at 0.25x, 1x or 4x: a cursor runs over its charts, a g circle with
 *                   the last second's trail and the values at that moment
 *   How it works    the same in words and a timeline, for whoever opens it the first time
 *
 *   draw(cv, t, page, s)   s = { v, rows, list, sel, detail, replay, busy, settings, kw, peakKw, powerStable, mph, on,
 *                          demo, now }; mph: speeds in mph (Settings > Speed unit), on: Save the last minute is on
 *   rowAt(rows, t)         the row nearest to time t (rows sorted by time)
 *   parseCsv(text)         the recorder's CSV back to [{ t, rpm, speed, gLong, gLat, torque }]
 *   summary(rows, at)      { vmax, brake, gMax, kwMax, secs } of a recording
 */
const G = require('./kit/gauges');
const { withAlpha } = require('./kit/canvas');

const GO = '#2fd27a';
const KIND = { brake: 'HARD STOP', power: 'FULL POWER', sport: 'SPORT STRETCH', mark: 'SAVED BY HAND' };
const MPH = 1.609344;
const isMph = (s) => !!(s && s.mph);
const spd = (s, kmh) => (typeof kmh === 'number' && isFinite(kmh) && isMph(s) ? kmh / MPH : kmh);
const unit = (s) => (isMph(s) ? 'mph' : 'km/h');
/* above 30 km/h (recorder.js BRAKE_KMH), in the unit chosen */
const above = (s) => 'above ' + Math.round(spd(s, 30)) + ' ' + unit(s);
const WHY = {
    brake: (s) => 'You braked harder than the hard stop setting for 0.2 s, ' + above(s) + '.',
    power: () => 'The engine gave 85 % of the most power it has shown, for a second.',
    sport: () => 'Sport mode was on: the whole stretch, from 60 s before it.',
    mark: () => 'You pressed Save last 60 s.',
};
const isNum = G.isNum || ((x) => typeof x === 'number' && isFinite(x));
const two = (n) => (n < 10 ? '0' : '') + n;
const when = (ms) => { const d = new Date(ms); return d.getDate() + '.' + two(d.getMonth() + 1) + '. ' + two(d.getHours()) + ':' + two(d.getMinutes()); };
const kindColor = (t, k) => (k === 'brake' ? t.crit : k === 'power' ? t.warn : k === 'sport' ? t.accent : GO);
const ceilTo = (v, s) => Math.max(s, Math.ceil(v / s) * s);

function rowAt(rows, tm) {
    if (!rows.length) return null;
    let lo = 0, hi = rows.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (rows[m].t <= tm) lo = m; else hi = m; }
    return Math.abs(rows[hi].t - tm) < Math.abs(rows[lo].t - tm) ? rows[hi] : rows[lo];
}

function parseCsv(text) {
    const lines = String(text || '').trim().split('\n'), head = (lines.shift() || '').split(',');
    const at = (k) => head.indexOf(k);
    const I = { t: at('time'), rpm: at('rpm'), speed: at('speed'), gLong: at('gLong'), gLat: at('gLat'), torque: at('torque') };
    const num = (c) => (c === undefined || c === '' ? null : Number(c));
    return lines.map((l) => {
        const c = l.split(',');
        return { t: Date.parse(c[I.t]), rpm: num(c[I.rpm]), speed: num(c[I.speed]), gLong: num(c[I.gLong]), gLat: num(c[I.gLat]), torque: num(c[I.torque]) };
    }).filter((r) => isNum(r.t));
}

function summary(rows, at) {
    let vmax = null, brake = null, gMax = null, kwMax = null;
    rows.forEach((r) => {
        if (isNum(r.speed)) vmax = Math.max(vmax || 0, r.speed);
        if (isNum(r.gLong)) brake = Math.min(brake === null ? 0 : brake, r.gLong);
        if (isNum(r.gLong) || isNum(r.gLat)) gMax = Math.max(gMax || 0, Math.hypot(r.gLong || 0, r.gLat || 0));
        if (isNum(r.torque) && isNum(r.rpm)) kwMax = Math.max(kwMax || 0, r.torque * r.rpm / 9549);
    });
    const secs = rows.length > 1 ? (rows[rows.length - 1].t - rows[0].t) / 1000 : 0;
    return { vmax, brake, gMax, kwMax, secs, at };
}

/* Two charts over time: speed (and rpm, on its own scale, faint) and g forward / backward (and sideways). */
function charts(cv, t, x, y, w, h, rows, o) {
    const x0 = o.x0, x1 = o.x1, rel = (r) => (r.t - o.zero) / 1000;
    const vmax = rows.reduce((m, r) => (isNum(r.speed) ? Math.max(m, spd(o, r.speed)) : m), 0);
    const rmax = rows.reduce((m, r) => (isNum(r.rpm) ? Math.max(m, r.rpm) : m), 0);
    const ytop = ceilTo(vmax * 1.1, 40), step = Math.max(1, Math.floor(rows.length / 400));
    const pick = (f) => rows.filter((r, i) => i % step === 0).map((r) => [rel(r), f(r)]);
    const half = Math.floor((h - 16) / 2), gy = y + half + 16;
    const xf = (v) => (v === 0 ? '0' : (v > 0 ? '+' : '') + Math.round(v));
    const a = G.chart(cv, t, x, y, w, half, { xMin: x0, xMax: x1, yMin: 0, yMax: ytop, xFmt: xf, xUnit: 's', yUnit: unit(o),
        series: [
            rmax > 0 && { pts: pick((r) => (isNum(r.rpm) ? r.rpm / (ceilTo(rmax, 1000)) * ytop : null)), color: withAlpha(t.dim, 0.7), width: 1.5 },
            { pts: pick((r) => spd(o, r.speed)), color: t.accent, width: 3, fill: 0.14 },
        ].filter(Boolean), empty: o.empty });
    const lo = Math.min(-1, -(o.brakeG || 0) - 0.2), b = G.chart(cv, t, x, gy, w, half, { xMin: x0, xMax: x1, yMin: lo, yMax: 0.8, yStep: 0.4,
        yFmt: (v) => v.toFixed(1), xFmt: xf, xUnit: 's', yUnit: 'g',
        marks: [o.brakeG && { y: -o.brakeG, color: t.crit, label: 'hard stop saves here (' + o.brakeG.toFixed(1) + ' g)' }].filter(Boolean),
        series: [
            o.lat && { pts: pick((r) => r.gLat), color: t.warn, width: 1.5 },
            { pts: pick((r) => r.gLong), color: GO, width: 2.5 },
        ].filter(Boolean) });
    if (o.marker !== undefined && o.marker >= x0 && o.marker <= x1) {
        [a, b].forEach((c) => { const mx = Math.round(c.X(o.marker)); cv.fillRect(mx - 1, c.py, 3, c.ph, withAlpha(t.crit, 0.85)); });
        cv.text('SAVED FOR THIS', a.X(o.marker) + 8, a.py + 18, 15, t.crit, { font: 'bold', spacing: 1.5 });
    }
    if (isNum(o.cursor) && o.cursor >= x0 && o.cursor <= x1) {
        [a, b].forEach((c) => { const cx = Math.round(c.X(o.cursor)); cv.fillRect(cx - 1, c.py - 4, 3, c.ph + 8, t.text); cv.circle(cx, c.py - 4, 6, t.text); });
    }
    // what the lines are
    const lx = x + 52;
    cv.text('speed', lx, y - 6, 16, t.accent, { font: 'bold' });
    if (rmax > 0) cv.text('rpm (up to ' + ceilTo(rmax, 1000) + ')', lx + 70, y - 6, 16, t.dim);
    cv.text('braking  /  accelerating', lx, gy - 6, 16, GO, { font: 'bold' });
    if (o.lat) cv.text('sideways', lx + 220, gy - 6, 16, t.warn, { font: 'bold' });
    return { a, b };
}

/* Live: the memory and what saves it. */
function live(cv, t, s) {
    const v = s.v, set = s.settings, brakeG = set.get('bbBrakeG') || 0.7;
    const p = G.panel(cv, t, 24, 44, 1000, 468, 'The last 60 seconds, kept in memory');
    const now = s.now;
    charts(cv, t, 40, 112, 968, 320, s.rows, { x0: -60, x1: 0, zero: now, brakeG, mph: isMph(s), empty: s.on === false ? 'Recording is off' : 'Waiting for the car' });
    cv.text(isNum(v.speed) ? Math.round(spd(s, v.speed)) + ' ' + unit(s) : '-- ' + unit(s), p.x + p.w - 24, 82, 26, t.text, { align: 'right', font: 'num' });
    cv.text(isNum(v.gLong) ? (v.gLong >= 0 ? '+' : '') + v.gLong.toFixed(2) + ' g' : '-- g', p.x + p.w - 180, 82, 26, GO, { align: 'right', font: 'num' });
    cv.text(s.on === false ? 'Off until you switch it on in Settings. Then nothing is written to a file until one of the things on the right happens.'
        : 'Nothing is written to a file until one of the things on the right happens.', 48, 496, 19, t.dim);

    const q = G.panel(cv, t, 1040, 44, 536, 468, 'A recording is saved when');
    const kw = s.kw, peak = s.peakKw || 0, rowY = [100, 194, 288, 382];
    const row = (i, title, on, text, frac, now_, col) => {
        const y = rowY[i];
        cv.text(title, 1064, y + 22, 23, on ? t.text : t.dim, { font: 'bold' });
        G.pill(cv, t, 1462, y + 2, 94, 28, on ? 'ON' : 'OFF', { color: on ? GO : t.dim, size: 16 });
        cv.text(text, 1064, y + 50, 17, t.dim);
        if (frac !== null) {
            cv.roundRect(1064, y + 64, 492, 10, 5, t.track);
            if (isNum(frac)) cv.roundRect(1064, y + 64, Math.max(10, 492 * G.clamp(frac, 0, 1)), 10, 5, frac >= 1 ? t.crit : col || t.accent);
            cv.text(now_, 1556, y + 50, 17, t.text, { align: 'right' });
        }
    };
    const braking = isNum(v.gLong) ? Math.max(0, -v.gLong) : null;
    const on = s.on !== false;
    row(0, 'You brake hard', on && !!set.get('bbBrake'), 'harder than ' + brakeG.toFixed(1) + ' g for 0.2 s, ' + above(s),
        isNum(braking) ? braking / brakeG : undefined, isNum(braking) ? 'now ' + braking.toFixed(2) + ' g' : 'now --', t.crit);
    const learned = peak >= 60 && s.powerStable !== false;
    row(1, 'Full power', on && !!set.get('bbPower'), learned ? '85 % of ' + Math.round(peak) + ' kW, for a second' : 'learns your car\'s power first',
        isNum(kw) && learned ? kw / (0.85 * peak) : undefined, isNum(kw) ? 'now ' + Math.round(Math.max(0, kw)) + ' kW' : 'now --', t.warn);
    row(2, 'Sport mode', on && !!set.get('bbSport'), 'the whole stretch, while Sport is on', null);
    cv.text(v.mode === 'sport' ? 'Sport is on now' : 'not in Sport now', 1556, rowY[2] + 50, 17, v.mode === 'sport' ? t.accent : t.text, { align: 'right' });
    row(3, 'You press the button', on, 'Save last 60 s: any time, for anything', null);
    if (s.busy) {
        cv.roundRect(1056, 470, 504, 34, 8, withAlpha(t.crit, 0.2));
        cv.text('SAVING NOW: ' + (KIND[s.busy] || s.busy), 1308, 494, 19, t.crit, { align: 'center', font: 'bold', spacing: 1.5 });
    } else cv.text('Saved: the 60 s before, and 15 s after', 1064, 494, 17, t.dim);
}

/* Recordings: the list and the chosen one. */
function recordings(cv, t, s) {
    const l = s.list;
    G.panel(cv, t, 24, 44, 560, 468, 'Saved recordings (' + l.length + ')');
    if (!l.length) {
        (s.on === false ? ['Nothing saved yet.', '', 'Recording is off until you switch it on:', 'Settings > Save the last minute.', 'Until then nothing is read or saved.']
            : ['Nothing saved yet.', '', 'Just drive: when you brake hard,', 'drive in Sport (or at full power,', 'when that is on) or press Save last 60 s,', 'the recording shows up here.'])
            .forEach((x, i) => cv.text(x, 48, 120 + i * 32, 21, i ? t.dim : t.text, { font: i ? 'label' : 'bold' }));
    }
    const per = 8, first = Math.max(0, Math.min(s.sel - per + 1, l.length - per)), shown = l.slice(Math.max(0, first), Math.max(0, first) + per);
    shown.forEach((e, k) => {
        const i = Math.max(0, first) + k, y = 96 + k * 50;
        if (i === s.sel) { cv.roundRect(36, y, 536, 44, 8, withAlpha(t.accent, 0.2)); cv.roundRect(36, y, 5, 44, 2, t.accent); }
        cv.text(when(e.at), 52, y + 29, 19, t.text);
        cv.text(KIND[e.kind] || e.kind, 230, y + 29, 18, kindColor(t, e.kind), { font: 'bold', spacing: 1 });
        cv.text(Math.round(e.ms / 1000) + ' s', 560, y + 29, 18, t.dim, { align: 'right' });
    });
    cv.text(l.length > per ? (s.sel + 1) + ' of ' + l.length + ': Next recording (menu) picks another. Replay plays it back.' : l.length ? 'Replay tab: the chosen one in slow motion' : '', 48, 500, 16, t.dim);

    const e = l[s.sel];
    const p = G.panel(cv, t, 600, 44, 976, 468, e ? (KIND[e.kind] || e.kind) + ', ' + when(e.at) : 'The chosen recording');
    if (!e) { cv.text('The chosen one is shown here: why it was saved, its top speed and g, as charts.', 624, 130, 20, t.dim); return; }
    if (e.error) { cv.text('This one could not be saved: ' + e.error, 624, 130, 20, t.crit); return; }
    const d = s.detail, rows = d ? d.rows : [];
    cv.text(WHY[e.kind] ? WHY[e.kind](s) : '', 624, 104, 18, t.dim);
    const sm = d ? d.sum : summary([], e.at);
    const tiles = [
        ['TOP SPEED', spd(s, sm.vmax), unit(s), 0], ['HARDEST BRAKING', isNum(sm.brake) ? -sm.brake : null, 'g', 2],
        ['MOST G', sm.gMax, 'g', 2], ['MOST POWER', sm.kwMax, 'kW', 0], ['LENGTH', sm.secs || e.ms / 1000, 's', 0],
    ];
    tiles.forEach((x, i) => G.readout(cv, t, 624 + i * 188, 118, { label: x[0], value: x[1], unit: x[2], decimals: x[3], size: 38, labelSize: 14 }));
    const x0 = rows.length ? Math.floor((rows[0].t - e.at) / 1000) : -60, x1 = rows.length ? Math.ceil((rows[rows.length - 1].t - e.at) / 1000) : 15;
    charts(cv, t, 616, 214, 944, 262, rows, { x0, x1: Math.max(x1, x0 + 1), zero: e.at, brakeG: s.settings.get('bbBrakeG') || 0.7, lat: true, mph: isMph(s),
        marker: e.kind === 'sport' ? undefined : 0, empty: d && d.error ? 'Could not read the file: ' + d.error : 'Reading the file' });
    cv.text(e.kind === 'sport' ? '0 s: when Sport was chosen' + (e.thinned ? '. Calm stretches kept once a second, the busy moments in full ('
        + e.rows + ' of ' + e.rowsAll + ' rows)' : '') : '0 s: the moment it was saved for. Left of it: the 60 s before', p.x + 24, 500, 16, t.dim);
}

/* Replay: the chosen recording played back. */
const sec = (v) => (v >= 0 ? '+' : '-') + Math.abs(v).toFixed(1) + ' s';
const rateText = (r) => (r === 0.25 ? '0.25x' : r + 'x');
function replay(cv, t, s) {
    const r = s.replay, e = r && r.e;
    const p = G.panel(cv, t, 24, 44, 1000, 468, e ? 'Replay: ' + (KIND[e.kind] || e.kind) + ', ' + when(e.at) : 'Replay');
    const q = G.panel(cv, t, 1040, 44, 536, 468, 'At this moment');
    if (!e || !r.rows.length) {
        const msg = !e ? ['Nothing to replay yet.', 'Saved recordings play here: slowed down to 0.25x,', 'at real speed or four times faster.']
            : [r.d && r.d.error ? 'Could not read the file: ' + r.d.error : 'Reading the file'];
        msg.forEach((x, i) => cv.text(x, 48, 130 + i * 34, 22, i ? t.dim : t.text, { font: i ? 'label' : 'bold' }));
        cv.text('The values at the cursor show here while it plays.', 1064, 130, 18, t.dim);
        return;
    }
    const rows = r.rows, tc = e.at + r.pos * 1000, now = rowAt(rows, tc);
    charts(cv, t, 40, 112, 968, 292, rows, { x0: Math.floor(r.x0), x1: Math.max(Math.ceil(r.x1), Math.floor(r.x0) + 1), zero: e.at,
        brakeG: s.settings.get('bbBrakeG') || 0.7, lat: true, mph: isMph(s), marker: e.kind === 'sport' ? undefined : 0, cursor: r.pos });
    // where it is: the time, how far, and the controls
    const frac = r.x1 > r.x0 ? (r.pos - r.x0) / (r.x1 - r.x0) : 0;
    cv.roundRect(84, 420, 924, 6, 3, t.track);
    cv.roundRect(84, 420, Math.max(6, 924 * G.clamp(frac, 0, 1)), 6, 3, t.text);
    cv.text(sec(r.pos), 48, 474, 36, t.text, { font: 'num' });
    G.pill(cv, t, 200, 446, 150, 34, r.playing ? 'PLAYING ' + rateText(r.rate) : 'PAUSED', { color: r.playing ? GO : t.dim, size: 16 });
    let bx = 380;
    if (cv.own) {
        bx += G.button(cv, t, bx, 440, 150, 46, r.playing ? 'Pause' : 'Play', r.play, { primary: true, key: 'bb-play' }) + 12;
        bx += G.segment(cv, t, bx, 440, 270, 46, r.rates.map((x) => ({ label: rateText(x), on: x === r.rate, run: () => r.setRate(x), key: 'bb-rate-' + x }))) + 12;
        G.button(cv, t, bx, 440, 170, 46, 'To start', r.start, { key: 'bb-start' });
    } else cv.text('Play, Speed and Back to start: in the menu. Now at ' + rateText(r.rate) + '.', bx, 470, 18, t.dim);
    cv.text(e.kind === 'sport' ? '0 s: when Sport was chosen. The white line is where the replay is.'
        : '0 s: the moment it was saved for (red). The white line is where the replay is.', p.x + 24, 504, 16, t.dim);

    // the g circle with the last second, and the values at the cursor
    const trail = rows.filter((x) => x.t > tc - 1000 && x.t <= tc).map((x) => [x.gLat, x.gLong]);
    G.gmeter(cv, t, 1308, 196, 92, { lat: now.gLat, long: now.gLong, trail, max: 1.5, smooth: false });
    const kw = isNum(now.torque) && isNum(now.rpm) ? now.torque * now.rpm / 9549 : null;
    const items = [
        ['SPEED', spd(s, now.speed), unit(s), 0], ['ENGINE', now.rpm, 'rpm', 0], ['POWER', isNum(kw) ? Math.max(0, kw) : null, 'kW', 0],
        ['TORQUE', now.torque, 'Nm', 0], [isNum(now.gLong) && now.gLong < 0 ? 'BRAKING' : 'ACCELERATING', isNum(now.gLong) ? Math.abs(now.gLong) : null, 'g', 2],
        ['SIDEWAYS', isNum(now.gLat) ? Math.abs(now.gLat) : null, 'g', 2],
    ];
    items.forEach((x, i) => G.readout(cv, t, 1064 + (i % 3) * 172, 364 + Math.floor(i / 3) * 72,
        { label: x[0], value: x[1], unit: x[2], decimals: x[3], size: 32, labelSize: 13, color: i === 4 && isNum(now.gLong) && now.gLong < 0 ? t.crit : undefined }));
    cv.text('dots: the last second', q.x + q.w - 24, 82, 15, t.dim, { align: 'right' });
}

/* How it works: a timeline and plain words. */
function help(cv, t, s) {
    G.panel(cv, t, 24, 44, 1552, 468, 'How the recordings work');
    const x = 80, w = 1440, y = 120, mem = w * 0.8;
    cv.roundRect(x, y, mem, 46, 10, withAlpha(t.accent, 0.25));
    cv.roundRect(x + mem, y, w - mem, 46, 10, withAlpha(GO, 0.25));
    cv.fillRect(x + mem - 2, y - 14, 4, 74, t.crit);
    cv.text('60 seconds always kept in memory, overwritten as you drive', x + mem / 2, y + 30, 20, t.text, { align: 'center', font: 'bold' });
    cv.text('+15 s after', x + mem + (w - mem) / 2, y + 30, 20, t.text, { align: 'center', font: 'bold' });
    cv.text('something happens', x + mem, y - 20, 17, t.crit, { align: 'center', font: 'bold' });
    cv.text('the 75 s become one file', x + w / 2, y + 74, 17, t.dim, { align: 'center' });
    [
        ['1', 'It is off until you switch it on.', 'Settings > Save the last minute. Then it records all the time: speed, rpm, g, torque and temperatures, ten times a second. Only the last minute is kept, in memory.'],
        ['2', 'It saves only when it matters.', 'A hard stop, a Sport stretch, full power (each on or off in Settings; full power starts off) or the Save last 60 s button.'],
        ['3', 'You look at it here or on your phone.', 'Recordings shows each one as charts, Replay plays it back in slow motion. Settings > Recordings as QR gives the list to a phone camera.'],
    ].forEach((r, i) => {
        const yy = 250 + i * 82;
        cv.circle(98, yy - 8, 20, withAlpha(t.accent, 0.3));
        cv.text(r[0], 98, yy, 22, t.text, { align: 'center', font: 'bold' });
        cv.text(r[1], 136, yy, 23, t.text, { font: 'bold' });
        cv.text(r[2], 136, yy + 30, 18, t.dim);
    });
    cv.text('It only reads what the car sends anyway. Nothing is asked of or written to any control unit. Kept: ' + (s.settings.get('bbKeep') || 30) + ' recordings, the oldest go first.', 80, 496, 17, t.dim);
}

function draw(cv, t, page, s) {
    if (page === 1) recordings(cv, t, s);
    else if (page === 2) replay(cv, t, s);
    else if (page === 3) help(cv, t, s);
    else live(cv, t, s);
}

module.exports = { draw, parseCsv, summary, rowAt, KIND, WHY, when };
