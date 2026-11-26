'use strict';
/**
 * own_wheels.js - Service's Wheels tab: which set of wheels is on the car (Summer, Winter, All-season), since when,
 * how far each set has gone this season and in all, its tread depth against the usual advice, and after a swap the
 * reminder to check the wheel bolts and the pressures once 50 to 100 km are driven.
 *
 *   SETS                      [{ key, name, tread: setting key, advice: mm }]
 *   setsOn(settings)          the sets in use (Settings > Wheel sets)
 *   stints(w, odo)            each swap's stretch: [{ set, from, to, at, now }] (to = the next swap, or the odometer now)
 *   perSet(w, odo)            { <set>: { season, total } }  season = its latest stretch
 *   reminder(w, odo)          null, or { km: driven since the swap, left: to 100 km }
 *   swap(w, set, odo, now)    a new swap on w (the file's `wheels`), kept to the last 40
 *   draw(cv, t, s)            the tab; s = { w, odo, sets, pick, armed, settings, note }
 *
 * The bolt torque is the car's own (the owner's manual or the wheel bolt cap): the app never names a figure.
 */
const G = require('./kit/gauges');
const { withAlpha } = require('./kit/canvas');

const SETS = [
    { key: 'summer', name: 'Summer', tread: 'treadSummer', advice: 3, color: '#ffb02e' },
    { key: 'winter', name: 'Winter', tread: 'treadWinter', advice: 4, color: '#4fb3ff' },
    { key: 'all', name: 'All-season', tread: 'treadAll', advice: 4, color: '#b07cff' },
];
const CHECK_FROM = 50, CHECK_TO = 100, GO = '#2fd27a';
const isNum = (x) => typeof x === 'number' && isFinite(x);
const two = (n) => (n < 10 ? '0' : '') + n;
const day = (ms) => { const d = new Date(ms); return two(d.getDate()) + '.' + two(d.getMonth() + 1) + '.' + d.getFullYear(); };
const km = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

const setsOn = (settings) => (settings.get('wheelSets') === 'three' ? SETS : SETS.slice(0, 2));
const byKey = (k) => SETS.find((s) => s.key === k) || SETS[0];

function stints(w, odo) {
    const l = (w && w.swaps) || [];
    return l.map((s, i) => {
        const next = l[i + 1], to = next ? next.km : odo;
        return { set: s.set, from: s.km, to: isNum(to) ? to : s.km, at: s.at, now: !next };
    });
}

function perSet(w, odo) {
    const out = {};
    SETS.forEach((s) => { out[s.key] = { season: 0, total: 0 }; });
    stints(w, odo).forEach((x) => {
        const d = Math.max(0, x.to - x.from), o = out[x.set];
        if (!o) return;
        o.total += d; o.season = d;
    });
    return out;
}

function reminder(w, odo) {
    const l = (w && w.swaps) || [], last = l[l.length - 1];
    if (!last || !isNum(odo) || !isNum(last.km)) return last && !isNum(odo) ? { km: null, left: null } : null;
    const d = odo - last.km;
    return d > CHECK_TO ? null : { km: Math.max(0, d), left: CHECK_TO - Math.max(0, d) };
}

function swap(w, set, odo, now) {
    const out = w || { swaps: [] };
    out.swaps = (out.swaps || []).concat([{ set, km: odo, at: now }]).slice(-40);
    return out;
}

function draw(cv, t, s) {
    const w = s.w, odo = s.odo, l = (w && w.swaps) || [], last = l[l.length - 1], on = last && byKey(last.set);
    const ps = perSet(w, odo), rem = reminder(w, odo), sets = s.sets;

    /* left: what is on the car, the reminder, the next swap */
    G.panel(cv, t, 24, 44, 740, 468, 'On the car now');
    if (on) {
        cv.roundRect(48, 100, 12, 92, 6, on.color);
        cv.text(on.name.toUpperCase() + ' WHEELS', 78, 136, 40, t.text, { font: 'bold', spacing: 1 });
        cv.text('on since ' + day(last.at) + (isNum(last.km) ? ', at ' + km(last.km) + ' km' : ''), 78, 172, 19, t.dim);
        G.readout(cv, t, 520, 96, { label: 'DRIVEN ON THEM', text: isNum(odo) && isNum(last.km) ? km(odo - last.km) : '--', unit: 'km', size: 46, labelSize: 14, color: on.color });
    } else {
        cv.text('No swap marked yet', 48, 140, 34, t.text, { font: 'bold' });
        cv.text('Mark the set that is on now: it starts counting from today\'s odometer.', 48, 176, 19, t.dim);
    }
    // the reminder after a swap: bolts and pressures once 50 to 100 km are driven
    const ry = 214, rh = 140;
    if (rem) {
        const due = isNum(rem.km) && rem.km >= CHECK_FROM, c = due ? t.crit : t.warn;
        cv.roundRect(44, ry, 700, rh, 12, withAlpha(c, 0.16));
        cv.strokeRoundRect(44, ry, 700, rh, 12, 2, withAlpha(c, 0.7));
        cv.text(due ? 'CHECK THE WHEEL BOLTS AND PRESSURES NOW' : 'AFTER 50 TO 100 KM: CHECK THE WHEEL BOLTS', 64, ry + 34, 19, c, { font: 'bold', spacing: 1.2 });
        cv.text('Tighten them to the torque in your owner\'s manual, and set the', 64, ry + 62, 18, t.text);
        cv.text('pressures for these tyres. The note goes after 100 km.', 64, ry + 86, 18, t.text);
        const bx = 64, bw = 660, by = ry + 108, f = isNum(rem.km) ? G.clamp(rem.km / CHECK_TO, 0, 1) : 0;
        cv.roundRect(bx, by, bw, 12, 6, t.track);
        cv.roundRect(bx + bw * CHECK_FROM / CHECK_TO, by - 2, bw * (1 - CHECK_FROM / CHECK_TO), 16, 6, withAlpha(t.crit, 0.25));
        if (f > 0) cv.roundRect(bx, by, Math.max(12, bw * f), 12, 6, c);
        cv.text(isNum(rem.km) ? km(rem.km) + ' of 100 km since the swap' : 'waiting for the odometer', bx + bw, by - 8, 15, t.dim, { align: 'right' });
    } else {
        cv.roundRect(44, ry, 700, rh, 12, withAlpha(GO, 0.1));
        cv.text(last ? 'Bolts and pressures: nothing due' : 'After a swap, a reminder shows here', 64, ry + 40, 21, last ? GO : t.dim, { font: 'bold' });
        cv.text('After each swap you are reminded to check the wheel bolts', 64, ry + 74, 18, t.dim);
        cv.text('and the pressures between 50 and 100 km.', 64, ry + 98, 18, t.dim);
    }
    // the next swap: Next item picks the set, Done now twice marks it
    const pick = sets[s.pick % sets.length];
    cv.text('NEXT SWAP', 48, 392, 15, t.dim, { font: 'bold', spacing: 2 });
    sets.forEach((x, i) => {
        const bx = 48 + i * 236, chosen = x === pick;
        cv.roundRect(bx, 404, 224, 50, 10, chosen ? withAlpha(x.color, s.armed ? 0.55 : 0.3) : withAlpha('#ffffff', 0.04));
        cv.strokeRoundRect(bx, 404, 224, 50, 10, chosen ? 2.5 : 1, chosen ? x.color : withAlpha('#ffffff', 0.18));
        cv.text(x.name + (on === x ? ' (on)' : ''), bx + 112, 436, 19, chosen ? t.text : t.dim, { align: 'center', font: 'bold' });
    });
    cv.text(s.note || 'Next item picks the set, Done now twice marks it on the car today.', 48, 492, 16, s.note ? t.warn : t.dim);

    /* right: km per set (this season and in all), tread depth against the advice */
    G.panel(cv, t, 780, 44, 796, 468, 'Kilometres and tread');
    const cx = 860, cw = 690, cy = 104, ch = 176;
    const top = Math.max(1000, ...sets.map((x) => ps[x.key].total)) * 1.18, Y = (v) => cy + ch - v / top * ch, step = G.niceStep(top, 3);
    for (let v = 0; v <= top; v += step) {
        cv.fillRect(cx, Math.round(Y(v)), cw, 1, withAlpha(t.tick, v ? 0.25 : 0.6));
        cv.text(km(v), cx - 10, Y(v) + 6, 14, t.dim, { align: 'right' });
    }
    const slot = cw / sets.length, bw = Math.min(64, slot * 0.3);
    sets.forEach((x, i) => {
        const gx = cx + i * slot + slot / 2, p = ps[x.key];
        [[p.season, 0.95, 'this season'], [p.total, 0.4, 'in all']].forEach(([v, a], k) => {
            const bx = gx - bw - 4 + k * (bw + 8);
            if (v > 0) cv.roundRect(bx, Y(v), bw, cy + ch - Y(v), 5, withAlpha(x.color, a));
            cv.text(v > 0 ? km(v) : '0', bx + bw / 2, (v > 0 ? Y(v) : cy + ch) - 6, 14, t.text, { align: 'center', font: 'bold' });
        });
        cv.text(x.name, gx, cy + ch + 22, 17, t.text, { align: 'center', font: 'bold' });
    });
    cv.roundRect(cx + cw - 250, 70, 14, 14, 3, withAlpha(t.text, 0.9));
    cv.text('this season', cx + cw - 230, 83, 14, t.dim);
    cv.roundRect(cx + cw - 130, 70, 14, 14, 3, withAlpha(t.text, 0.35));
    cv.text('in all', cx + cw - 110, 83, 14, t.dim);

    // tread: one bar per set, 0 to 8 mm, the advice line
    cv.text('TREAD DEPTH', 804, 334, 15, t.dim, { font: 'bold', spacing: 2 });
    const tx = 960, tw = 460, MAX = 8, X = (mm) => tx + mm / MAX * tw;
    sets.forEach((x, i) => {
        const y = 352 + i * (sets.length > 2 ? 40 : 52), mm = s.settings.get(x.tread) || 0;
        cv.text(x.name, 804, y + 20, 18, t.text, { font: 'bold' });
        cv.roundRect(tx, y + 6, tw, 18, 6, t.track);
        const c = !mm ? t.dim : mm < x.advice ? t.crit : mm < x.advice + 1 ? t.warn : GO;
        if (mm) cv.roundRect(tx, y + 6, X(mm) - tx, 18, 6, c);
        cv.fillRect(Math.round(X(x.advice)) - 1, y, 3, 30, t.crit);
        cv.text(mm ? mm + ' mm' : 'not measured', tx + tw + 14, y + 21, 17, mm ? c : t.dim, { font: 'bold' });
    });
    cv.text('Red line: change below it (summer 3 mm, winter 4 mm, usual advice; the legal minimum is lower). Depth: Settings.', 804, 496, 14, t.dim);
}

module.exports = { SETS, setsOn, stints, perSet, reminder, swap, draw, CHECK_FROM, CHECK_TO };
