'use strict';
/**
 * Part of Redline's experimental features; README.md in this folder has the whole picture.
 *
 * The tyre widget: a 200 x 76 picture in the directions' corner of the glass (the same image layer and place,
 * hud.js; the directions come first while they have a turn to show). The car from above in the middle with the
 * unit inside it, a tyre at each corner, and beside each its pressure (big, coloured against its target:
 * tyres.js toneOf) with "/2.5" (the target) small after it, then the tyre's temperature under it.
 *
 *        2.4 ▮┌──┐▮ 2.4          (with Target on: 2.4/2.5)
 *        59°  │bar│  61°
 *        2.5 ▮└──┘▮ 2.1
 *        69°         70°
 *
 * The target is off by default (the colour already says how each tyre is against it); the car and the
 * temperatures can be switched off too, and without temperatures the pressures are drawn bigger. Text is fitted to its room, so kPa and Clearer labels never run into the car. A picture, never a
 * shader. Black is see-through on the glass.
 */
const { withAlpha } = require('./kit/canvas');
const { PALETTES } = require('./hud-draw');
const Theme = require('./hud-theme');
const Tyres = require('./tyres');

const TW = 200, TH = 76;
const CX = TW / 2, BODY_W = 26, BODY_H = 72, BODY_Y = 2, TYRE_W = 6, TYRE_H = 17;
const isNum = (v) => typeof v === 'number' && isFinite(v);

/** A temperature's colour: blue when cold (under 20 °C), orange over 90, red over 105 (as Car Vitals' card). */
function tempTone(c) { return !isNum(c) ? null : c < 20 ? 'cold' : c > 105 ? 'hot' : c > 90 ? 'warm' : 'text'; }

/**
 * The widget's options from the settings: { show ('low' | 'always' | 'off'), car, target, temp, unit, fahrenheit }.
 * show 'low': only while a tyre is well under its target (red).
 */
function widgetOf(settings) {
    const s = settings.get('hudTyreWidget');
    return {
        show: s === 'always' || s === 'off' ? s : 'low',
        car: settings.get('hudTyreCar') !== false, target: settings.get('hudTyreTarget') === true, temp: settings.get('hudTyreTemp') !== false,
        unit: ['psi', 'kpa'].indexOf(settings.get('hudTyreUnit')) >= 0 ? settings.get('hudTyreUnit') : 'bar',
        fahrenheit: settings.get('hudTempUnit') === 'f', clear: settings.get('hudLabels') === 'clear',
    };
}

/** Whether the widget shows for these tyres (null: no data, never). */
function widgetShows(w, ty) {
    if (!ty || w.show === 'off') return false;
    return w.show === 'always' || Tyres.lowCorners(ty).length > 0;
}

/** Everything the picture depends on (the numbers as drawn). */
function widgetKey(ty, w, palette) {
    const T = Tyres.CORNERS.map((c) => [Tyres.fmtP(ty.p[c], w.unit), Tyres.fmtP(ty.tgt[c], w.unit), isNum(ty.t[c]) ? Math.round(ty.t[c]) : '-'].join('/'));
    return ['tyres', T.join(','), w.car, w.target, w.temp, w.unit, w.fahrenheit, w.clear, palette].join('|');
}

/** Draws the widget into cv (TW x TH) for ty (tyres.js value()), w (widgetOf), palette name. */
function drawWidget(cv, ty, w, palette) {
    if (cv.clear) cv.clear();
    if (!ty) return;
    const P = PALETTES[palette] || PALETTES.colour;
    const x0 = CX - BODY_W / 2, x1 = CX + BODY_W / 2;
    const tw = (s, size) => (cv.textWidth ? cv.textWidth(s, size, { font: 'bold' }) : s.length * size * 0.55);
    const uName = (Tyres.UNITS[w.unit] || Tyres.UNITS.bar)[2];
    // the car: a rounded body, windscreen and rear window, a tyre at each corner; the unit inside
    if (w.car) {
        cv.roundRect(x0, BODY_Y, BODY_W, BODY_H, 10, withAlpha(P.text, 0.08));
        cv.strokeRoundRect(x0, BODY_Y, BODY_W, BODY_H, 10, 1.5, withAlpha(P.text, 0.5));
        cv.roundRect(x0 + 4, BODY_Y + 14, BODY_W - 8, 7, 3, withAlpha(P.text, 0.3));
        cv.roundRect(x0 + 5, BODY_Y + BODY_H - 18, BODY_W - 10, 5, 2, withAlpha(P.text, 0.22));
        [[6, -1], [6, 1], [TH - 6 - TYRE_H, -1], [TH - 6 - TYRE_H, 1]].forEach((t) => {
            const tx = t[1] < 0 ? x0 - 2 - TYRE_W : x1 + 2;
            cv.roundRect(tx, t[0], TYRE_W, TYRE_H, 2, withAlpha(P.text, 0.85));
        });
    }
    const us = w.clear ? 13 : 11;
    cv.text(uName, CX, TH / 2 + us / 2 - 1, us, w.clear ? P.text : withAlpha(P.text, 0.8), { align: 'center', font: 'bold' });
    // the numbers: right-aligned against the car on the left, left-aligned on the right
    const gap = w.car ? BODY_W / 2 + 2 + TYRE_W + 5 : 20;
    const room = CX - gap - 2;
    const sub = w.clear ? 15 : 13, two = w.temp;
    const big = two ? 24 : 30;
    const rows = two ? { F: [24, 37], R: [62, 75] } : { F: [30, 0], R: [68, 0] };
    Tyres.CORNERS.forEach((c) => {
        const left = c[1] === 'L', r = rows[c[0]], edge = left ? CX - gap : CX + gap;
        const p = ty.p[c], tgt = ty.tgt[c], temp = ty.t[c];
        const ps = Tyres.fmtP(p, w.unit), ts = w.target && isNum(tgt) ? '/' + Tyres.fmtP(tgt, w.unit) : '';
        // made smaller together when pressure and target don't fit their room (kPa at Clearer)
        const need = tw(ps, big) + (ts ? tw(ts, sub) + 1 : 0), k = need > room ? room / need : 1;
        const bs = big * k, ss = sub * k, pw = tw(ps, bs), tsw = ts ? tw(ts, ss) + 1 : 0;
        const pc = P[Tyres.toneOf(p, tgt)] || withAlpha(P.text, isNum(p) ? 1 : 0.5);
        const px = left ? edge - tsw - pw : edge;
        cv.text(ps, px, r[0], bs, pc, { align: 'left', font: 'bold' });
        if (ts) cv.text(ts, px + pw + 1, r[0], ss, w.clear ? P.text : withAlpha(P.text, 0.75), { align: 'left', font: 'bold' });
        if (two && isNum(temp)) {
            const s = Math.round(w.fahrenheit ? temp * 9 / 5 + 32 : temp) + '°';
            cv.text(s, edge, r[1], sub, Theme.toneCol(tempTone(temp), P, P.text), { align: left ? 'right' : 'left', font: 'bold' });
        }
    });
}

/** Sample tyres for the previews (one a little under its target, one well under). */
const SAMPLE = { p: { FL: 2.4, FR: 2.4, RL: 2.5, RR: 2.1 }, tgt: { FL: 2.5, FR: 2.5, RL: 2.7, RR: 2.7 }, t: { FL: 59, FR: 61, RL: 69, RR: 70 } };

module.exports = { drawWidget, widgetKey, widgetOf, widgetShows, tempTone, SAMPLE, TW, TH };
