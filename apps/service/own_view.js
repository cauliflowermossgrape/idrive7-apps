'use strict';
/**
 * own_view.js - Service's "My intervals" tab, three views (taken from Service Intervals):
 *
 *   Overview   a summary (how many are due, soon or fine, what is next) and a card per item: a ring of how much of
 *              its interval is used, what is left in big figures, when it was last done, and a small "wear" chip
 *   History    every service marked, newest first, and for the chosen item a chart of the km between its services
 *   Driving    how the car was driven since each item's last service and how much harder that was on it than the km
 *              say: an estimate from common guidance (own_wear.js); the km left on Overview do not change
 *
 *   draw(cv, t, view, s)   s = { l: [{ it, every, done, s }], sel, armed, note, odo, store, wearOf(it, done), act }
 *   s.act = { pick(i), done() }: the on-screen controls where the kit runs the screen (cv.own)
 */
const G = require('./kit/gauges');
const { withAlpha } = require('./kit/canvas');
const { ITEMS } = require('./own_items');
const Wear = require('./own_wear');

const GO = '#2fd27a', DAY = 86400000;
const two = (n) => (n < 10 ? '0' : '') + n;
const day = (ms) => { const d = new Date(ms); return two(d.getDate()) + '.' + two(d.getMonth() + 1) + '.' + d.getFullYear(); };
const km = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
const WORD = { due: 'DUE', soon: 'SOON', ok: 'FINE', unknown: 'NOT MARKED' };

/** An item's record: { km, at, history: [{ km, at }] } (an older file held only { km, at }). */
function record(store, key) {
    const r = store && store[key];
    if (!r) return null;
    if (!Array.isArray(r.history)) r.history = [{ km: r.km, at: r.at }];
    return r;
}
const colOf = (t, s) => (s.state === 'due' ? t.crit : s.state === 'soon' ? t.warn : s.state === 'ok' ? GO : t.dim);
const leftText = (x) => (x.it.unit === 'km' ? km(Math.abs(x.s.left)) : String(Math.abs(x.s.left)));
const leftUnit = (x) => (x.it.unit === 'km' ? 'km' : 'days');
/** One line for an item: "4 200 km left", "12 days overdue", "not marked yet". */
function leftLine(x) {
    if (x.s.state === 'unknown') return x.done ? 'needs the odometer' : 'not marked yet';
    return leftText(x) + ' ' + leftUnit(x) + (x.s.left > 0 ? ' left' : ' overdue');
}

function overview(cv, t, s) {
    const l = s.l, o = s.odo;
    const p = G.panel(cv, t, 24, 44, 1552, 84, null);
    cv.text('ODOMETER', 48, 78, 15, t.dim, { font: 'bold', spacing: 2 });
    cv.text(G.isNum(o) ? km(o) + ' km' : 'waiting for the car', 48, 112, 30, G.isNum(o) ? t.text : t.dim, { font: 'num' });
    const n = { due: 0, soon: 0, ok: 0, unknown: 0 };
    l.forEach((x) => { n[x.s.state] = (n[x.s.state] || 0) + 1; });
    let px = 330;
    [['due', t.crit], ['soon', t.warn], ['ok', GO], ['unknown', t.dim]].forEach(([k, c]) => {
        if (!n[k] && k === 'unknown') return;
        G.pill(cv, t, px, 70, 150, 40, n[k] + ' ' + WORD[k], { color: c, size: 17, filled: n[k] ? 0.25 : 0.08 });
        px += 166;
    });
    const next = l.filter((x) => G.isNum(x.s.left)).sort((a, b) => (a.s.frac > b.s.frac ? -1 : 1))[0];
    const right = s.note ? s.note : next ? 'Next: ' + next.it.name + (next.s.left > 0 ? ' in ' + leftText(next) + ' ' + leftUnit(next) : ', ' + leftText(next) + ' ' + leftUnit(next) + ' overdue') : 'Mark what was done with Mark done';
    cv.text(right, p.x + p.w - 24, 112, s.note ? 19 : 22, s.note ? t.warn : t.text, { align: 'right', font: 'bold' });
    if (!l.length) { G.panel(cv, t, 24, 140, 1552, 372, null); cv.text('No interval set: choose them in Settings', 48, 200, 26, t.dim); return; }
    const cols = 4, gap = 12, cw = (1552 - gap * (cols - 1)) / cols, rows = Math.ceil(l.length / cols), ch = Math.floor((372 - gap * (rows - 1)) / rows);
    l.forEach((x, i) => {
        const cx = 24 + (i % cols) * (cw + gap), cy = 140 + Math.floor(i / cols) * (ch + gap), c = colOf(t, x.s);
        G.panel(cv, t, cx, cy, cw, ch, x.it.name);
        if (i === s.sel) cv.strokeRoundRect(cx, cy, cw, ch, 14, s.armed ? 4 : 3, s.armed ? t.warn : t.accent);
        if (cv.own && s.act) cv.target(cx, cy, cw, ch, () => s.act.pick(i), 'own-card-' + x.it.key, 14);
        const r = Math.min(48, ch * 0.28), rx2 = cx + 22 + r, ry = cy + ch * 0.56;
        cv.arc(rx2, ry, r - 9, r, 0, 360, t.track);
        if (G.isNum(x.s.frac)) cv.arc(rx2, ry, r - 9, r, 0, 360 * G.clamp(x.s.frac, 0, 1), c);
        cv.text(G.isNum(x.s.frac) ? Math.round(Math.min(x.s.frac, 9.99) * 100) + '%' : '--', rx2, ry + 8, 22, c, { align: 'center', font: 'bold' });
        const tx = rx2 + r + 22;
        if (x.s.state === 'unknown') {
            cv.text(x.done ? 'needs the odometer' : 'not marked yet', tx, ry - 6, 22, t.dim, { font: 'bold' });
            cv.text(x.done ? '' : (cv.own ? 'tap it, Mark done' : 'pick it, Reset service'), tx, ry + 22, 17, t.dim);
        } else {
            G.readout(cv, t, tx, ry - r - 6, { label: x.s.left > 0 ? 'LEFT' : 'OVERDUE', text: leftText(x), unit: leftUnit(x), size: 40, labelSize: 14, color: c });
        }
        cv.text('every ' + (x.it.unit === 'km' ? km(x.every) + ' km' : x.every + ' months'), cx + 22, cy + ch - 18, 16, t.dim);
        // the chosen card has Mark done (where the kit runs the screen) in place of its last date
        if (cv.own && s.act && i === s.sel) G.button(cv, t, cx + cw - 156, cy + ch - 62, 140, 42, 'Mark done', s.act.done, { confirm: true, primary: true, key: 'own-done-' + x.it.key });
        else cv.text(x.done ? 'last ' + day(x.done.at) : '', cx + cw - 20, cy + ch - 18, 16, t.dim, { align: 'right' });
        G.pill(cv, t, cx + cw - 128, cy + 12, 110, 26, WORD[x.s.state] || '', { color: c, size: 13 });
        // the wear chip: how much harder the driving since the last service was than the km say (an estimate)
        const w = s.wearOf(x.it, x.done);
        if (w.applies && w.enough && x.s.state !== 'unknown') {
            const wc = w.extra >= 20 ? t.warn : w.extra >= 5 ? t.accent : GO;
            G.pill(cv, t, cx + cw - 128, cy + 44, 110, 22, w.extra >= 1 ? 'WEAR +' + Math.round(w.extra) + '%' : 'WEAR NORMAL', { color: wc, size: 11, spacing: 1, filled: 0.15 });
        }
    });
}

function history(cv, t, s) {
    const l = s.l, all = [];
    ITEMS.forEach((it) => { const r = record(s.store, it.key); if (r) r.history.forEach((h) => all.push({ it, h })); });
    all.sort((a, b) => b.h.at - a.h.at);
    G.panel(cv, t, 24, 44, 640, 468, 'Every service marked (' + all.length + ')');
    G.table(cv, t, 48, 92, 592, [{ label: 'Date', w: 170 }, { label: 'Item', w: 260 }, { label: 'Odometer', w: 162, align: 'right' }],
        all.slice(0, 9).map((x) => [day(x.h.at), { text: x.it.name, color: x.it === (l[s.sel] && l[s.sel].it) ? 'accent' : null }, G.isNum(x.h.km) ? km(x.h.km) + ' km' : '']),
        { rowH: 40, size: 20, empty: 'Nothing marked yet: Mark done' });
    const x = l[s.sel], it = x && x.it, r = it && record(s.store, it.key), hist = r ? r.history : [];
    G.panel(cv, t, 680, 44, 896, 468, it ? it.name + ': between services' : 'Between services');
    if (!it) return;
    const gaps = [];
    for (let i = 1; i < hist.length; i++) {
        gaps.push({ v: it.unit === 'km' ? hist[i].km - hist[i - 1].km : (hist[i].at - hist[i - 1].at) / DAY / 30.44, at: hist[i].at });
    }
    if (G.isNum(x.s.left) && x.done) gaps.push({ v: it.unit === 'km' ? x.every - x.s.left : x.s.frac * x.every, at: s.now, now: true });
    const unit = it.unit === 'km' ? 'km' : 'months';
    if (gaps.length < 2) {
        cv.text('Two or more services of ' + it.name.toLowerCase() + ' give a chart here:', 704, 140, 21, t.dim);
        cv.text('how far you drove between them, against your interval.', 704, 172, 21, t.dim);
        cv.text(cv.own ? 'Choose another item on Overview.' : 'Next item chooses another item.', 704, 220, 18, t.dim);
        return;
    }
    const bx = 760, bw = 780, by = 110, bh = 330, top = Math.max(x.every, ...gaps.map((g) => g.v)) * 1.15;
    const Y = (v) => by + bh - v / top * bh, step = G.niceStep(top, 4);
    for (let v = 0; v <= top; v += step) {
        cv.fillRect(bx, Math.round(Y(v)), bw, 1, withAlpha(t.tick, v ? 0.25 : 0.6));
        cv.text(it.unit === 'km' ? km(v) : String(Math.round(v)), bx - 10, Y(v) + 6, 15, t.dim, { align: 'right' });
    }
    const n = gaps.length, slot = bw / n, w = Math.min(90, slot * 0.6);
    gaps.forEach((g, i) => {
        const gx = bx + i * slot + (slot - w) / 2, c = g.now ? t.accent : g.v > x.every ? t.warn : GO;
        cv.roundRect(gx, Y(g.v), w, by + bh - Y(g.v), 6, withAlpha(c, g.now ? 0.45 : 0.85));
        cv.text(it.unit === 'km' ? km(g.v) : g.v.toFixed(0), gx + w / 2, Y(g.v) - 8, 16, t.text, { align: 'center', font: 'bold' });
        cv.text(g.now ? 'so far' : day(g.at).slice(3), gx + w / 2, by + bh + 22, 15, t.dim, { align: 'center' });
    });
    cv.fillRect(bx, Math.round(Y(x.every)), bw, 2, t.crit);
    cv.text('your interval ' + (it.unit === 'km' ? km(x.every) : x.every) + ' ' + unit, bx + bw, Y(x.every) - 8, 16, t.crit, { align: 'right', font: 'bold' });
    cv.text('Green: done in time. Yellow: later than the interval. The last bar: since the last service.', 704, 496, 16, t.dim);
}

/* Driving: since each item's last service, how it was driven and what that means for it (an estimate). */
function driving(cv, t, s) {
    const l = s.l, items = l.filter((x) => Wear.ITEM_RULES[x.it.key]);
    const x = l[s.sel], w = x ? s.wearOf(x.it, x.done) : null;
    G.panel(cv, t, 24, 44, 600, 468, 'Extra wear since each service');
    if (!items.length) cv.text('No item with a driving factor is followed: Settings', 48, 130, 20, t.dim);
    items.slice(0, 6).forEach((y, i) => {
        const e = s.wearOf(y.it, y.done), yy = 104 + i * 62, on = y === x;
        if (on) cv.roundRect(36, yy - 8, 576, 56, 8, withAlpha(t.accent, 0.16));
        if (cv.own && s.act) cv.target(36, yy - 8, 576, 56, () => s.act.pick(l.indexOf(y)), 'own-wear-' + y.it.key, 8);
        cv.text(y.it.name, 52, yy + 14, 20, on ? t.text : t.dim, { font: 'bold' });
        cv.text(e.enough ? km(e.km) + ' km recorded' : 'not enough driving yet', 596, yy + 14, 15, t.dim, { align: 'right' });
        cv.roundRect(52, yy + 26, 540, 10, 5, t.track);
        if (e.enough) cv.roundRect(52, yy + 26, Math.max(8, 540 * e.extra / Wear.CAP), 10, 5, e.extra >= 20 ? t.warn : e.extra >= 5 ? t.accent : GO);
        if (e.enough) cv.text('+' + Math.round(e.extra) + ' %', 52 + Math.max(8, 540 * e.extra / Wear.CAP) + 8, yy + 36, 15, t.text, { font: 'bold' });
    });
    cv.text('Bar: extra wear, up to +' + Wear.CAP + ' %. ' + (cv.own ? 'Tap one to see why.' : 'Next item picks one.'), 48, 496, 16, t.dim);

    const p = G.panel(cv, t, 640, 44, 936, 468, x ? x.it.name + ': since ' + (x.done ? day(x.done.at) : 'recording began') : 'How it was driven');
    if (!x) return;
    if (!w.applies) {
        cv.text(x.it.name + ' wears with time and km, not with how you drive:', 664, 130, 21, t.text);
        cv.text('the plain interval is the whole story for it.', 664, 162, 21, t.dim);
        return;
    }
    if (!w.enough) {
        cv.text('Not enough driving recorded since the last service yet (' + Math.round(w.km) + ' of ' + Wear.MIN_KM + ' km).', 664, 130, 21, t.text);
        cv.text('Service counts every drive in the background, also with this screen closed.', 664, 162, 20, t.dim);
        return;
    }
    G.readout(cv, t, 664, 94, { label: 'DRIVEN, RECORDED', text: km(w.km), unit: 'km', size: 40, labelSize: 14 });
    G.readout(cv, t, 920, 94, { label: 'COUNTS AS ABOUT', text: km(w.wearKm), unit: 'km', size: 40, labelSize: 14, color: w.extra >= 20 ? t.warn : t.accent });
    G.readout(cv, t, 1200, 94, { label: 'EXTRA WEAR', text: '+' + Math.round(w.extra), unit: '%', size: 40, labelSize: 14, color: w.extra >= 20 ? t.warn : w.extra >= 5 ? t.accent : GO });
    G.readout(cv, t, 1420, 94, { label: 'DRIVES', text: String(w.drives), size: 40, labelSize: 14 });
    const rh = Math.min(52, Math.floor(260 / w.parts.length));
    w.parts.forEach((q, i) => {
        const y = 180 + i * rh, bx = 880, bw = 560, c = q.extra >= q.rule.cap * 0.6 ? t.warn : q.extra > 0 ? t.accent : GO;
        cv.text(q.rule.name, 664, y + 22, 20, q.extra > 0.5 ? t.text : t.dim, { font: 'bold' });
        cv.roundRect(bx, y + 8, bw, 12, 6, t.track);
        cv.roundRect(bx, y + 8, Math.max(10, bw * q.frac), 12, 6, c);
        cv.fillRect(Math.round(bx + bw * q.normalFrac), y + 2, 2, 24, t.text);
        cv.text(q.rule.fmt(q.value), bx, y + 40, 15, t.dim);
        cv.text(q.extra > 0.5 ? '+' + Math.round(q.extra) + ' %' : 'normal', p.x + p.w - 24, y + 22, 20, c, { align: 'right', font: 'bold' });
    });
    const why = w.parts.filter((q) => q.extra > 0.5).sort((a, b) => b.extra - a.extra).slice(0, 2);
    cv.text(why.length ? why.map((q) => q.rule.text).join(' ') : 'Nothing unusual: this driving is easy on it.', 664, 462, 17, why.length ? t.text : GO);
    cv.text('White tick: what counts as normal. An estimate from common maintenance guidance, not BMW data.', 664, 496, 15, t.dim);
}

function draw(cv, t, view, s) {
    if (view === 'history') history(cv, t, s);
    else if (view === 'driving') driving(cv, t, s);
    else overview(cv, t, s);
}

module.exports = { draw, record, leftLine, colOf, WORD, km, day };
