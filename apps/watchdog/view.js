'use strict';
/**
 * view.js - Watchdog's pages:
 *
 *   Rules          the 8 rules as cards: what each watches, the value now against its threshold as a bar (the side
 *                  that fires shaded), its state (watching, waiting n of m s, firing, cooldown, off), how often it fired
 *   Events         when the rules fired this drive, one lane per rule on a timeline, and the latest firings as a list
 *   How it works   the same in plain words, and what a firing can and cannot do
 *
 *   draw(cv, t, page, s)   s = { cards, events, from, now, sel, demo, unseen, cooldown, widget }
 */
const G = require('./kit/gauges');
const { withAlpha } = require('./kit/canvas');
const R = require('./rules');

const GO = '#2fd27a';
const LANE = ['#ff5a4f', '#ffb020', '#2fd27a', '#36b3ff', '#b383ff', '#ff7ac6', '#ffe14d', '#7fe0d0'];
const two = (n) => (n < 10 ? '0' : '') + n;
const hm = (ms) => { const d = new Date(ms); return two(d.getHours()) + ':' + two(d.getMinutes()); };
const PILL = { off: ['OFF', 'dim'], 'no value': ['NO VALUE', 'dim'], armed: ['WATCHING', GO], waiting: ['WAITING', 'warn'], firing: ['FIRING', 'crit'], cooldown: ['COOLDOWN', 'accent'] };

function card(cv, t, x, y, w, h, i, c, selected) {
    const r = c.rule, def = c.def, off = c.state === 'off';
    G.panel(cv, t, x, y, w, h, null);
    if (selected) cv.strokeRoundRect(x + 2, y + 2, w - 4, h - 4, 10, 3, t.accent);
    if (c.state === 'firing') cv.roundRect(x + 2, y + 2, w - 4, h - 4, 10, withAlpha(t.crit, 0.14));
    cv.circle(x + 30, y + 34, 15, withAlpha(LANE[i], off ? 0.25 : 0.9));
    cv.text(String(i + 1), x + 30, y + 41, 19, '#000000', { align: 'center', font: 'bold' });
    const p = PILL[c.state] || PILL.armed;
    G.pill(cv, t, x + w - 150, y + 20, 132, 28, p[0], { color: t[p[1]] || p[1], size: 15 });
    cv.text(R.text(r).replace(' for ', ', for '), x + 18, y + 82, 18, off ? t.dim : t.text, { font: 'bold' });
    // the value now
    const vs = R.fmt(c.value, def.decimals);
    const vw = cv.textWidth(vs, 46, { font: 'num' });
    cv.text(vs, x + 18, y + 134, 46, off || !G.isNum(c.value) ? t.dim : c.state === 'firing' ? t.crit : t.text, { font: 'num' });
    cv.text(def.unit + ' now', x + 26 + vw, y + 134, 18, t.dim);
    // the bar: the whole range of the value, the side that fires shaded, the threshold as a line
    const bx = x + 18, bw = w - 36, by = y + 152, lo = def.steps[0], hi = def.steps[def.steps.length - 1];
    const X = (v) => bx + G.clamp((v - lo) / (hi - lo), 0, 1) * bw, tx = X(r.thr);
    cv.roundRect(bx, by, bw, 12, 6, t.track);
    if (r.cmp === 'above') cv.roundRect(tx, by, bx + bw - tx, 12, 6, withAlpha(t.crit, off ? 0.12 : 0.35));
    else cv.roundRect(bx, by, tx - bx, 12, 6, withAlpha(t.crit, off ? 0.12 : 0.35));
    if (G.isNum(c.value) && !off) cv.circle(X(c.value), by + 6, 9, c.state === 'firing' ? t.crit : t.text);
    cv.fillRect(Math.round(tx) - 1, by - 8, 3, 28, t.warn);
    cv.text(R.fmt(lo, def.decimals), bx, by + 34, 14, t.dim);
    cv.text(R.fmt(hi, def.decimals), bx + bw, by + 34, 14, t.dim, { align: 'right' });
    // what is going on, in words
    const line = off ? 'switched off' : c.state === 'no value' ? 'the car does not send this value now'
        : c.state === 'waiting' ? 'past it for ' + c.held.toFixed(1) + ' of ' + r.hold + ' s'
            : c.state === 'cooldown' ? 'past it again, quiet for ' + Math.ceil(c.left) + ' s more'
                : c.state === 'firing' ? 'fired, until the value comes back'
                    : c.count ? 'fired ' + c.count + (c.count === 1 ? ' time' : ' times') + ' since the start' : 'watching';
    cv.text(line, x + 18, y + h - 16, 16, c.state === 'firing' ? t.crit : t.dim);
}

function rules(cv, t, s) {
    const w = 380, h = 228;
    s.cards.forEach((c, i) => card(cv, t, 24 + (i % 4) * (w + 4), 44 + Math.floor(i / 4) * (h + 12), w, h, i, c, i === s.sel));
}

function events(cv, t, s) {
    const p = G.panel(cv, t, 24, 44, 1000, 468, 'When the rules fired' + (s.demo ? ' (demo)' : ', this drive'));
    const x0 = 290, x1 = 996, top = 104, lh = 44, from = s.from, to = s.now;
    const X = (ms) => x0 + G.clamp((ms - from) / Math.max(1, to - from), 0, 1) * (x1 - x0);
    const mins = (to - from) / 60000, step = mins > 120 ? 30 : mins > 60 ? 15 : mins > 20 ? 10 : 5;
    for (let m = 0; m <= mins; m += step) {
        const xx = X(from + m * 60000);
        cv.fillRect(Math.round(xx), top - 6, 1, lh * 8 + 4, withAlpha(t.tick, 0.25));
        cv.text(m + ' min', xx, top + lh * 8 + 18, 14, t.dim, { align: 'center' });
    }
    cv.fillRect(Math.round(X(to)) - 1, top - 6, 3, lh * 8 + 4, withAlpha(t.accent, 0.7));
    cv.text('now', X(to), top - 12, 14, t.accent, { align: 'right', font: 'bold' });
    s.cards.forEach((c, i) => {
        const y = top + i * lh, n = s.events.filter((e) => e.i === i && e.at >= from).length;
        if (i % 2 === 0) cv.fillRect(36, y - 4, 976, lh - 4, withAlpha('#ffffff', 0.025));
        cv.circle(52, y + 16, 11, withAlpha(LANE[i], c.rule.on ? 0.9 : 0.25));
        cv.text(String(i + 1), 52, y + 21, 14, '#000000', { align: 'center', font: 'bold' });
        cv.text(c.def.name, 72, y + 22, 17, c.rule.on ? t.text : t.dim, { font: 'bold' });
        cv.text(n ? n + 'x' : '', 270, y + 22, 16, n ? t.text : t.dim, { align: 'right', font: 'bold' });
        cv.fillRect(x0, y + 15, x1 - x0, 2, withAlpha(LANE[i], 0.25));
    });
    s.events.filter((e) => e.at >= from && e.at <= to).forEach((e) => {
        const y = top + e.i * lh + 16;
        cv.circle(X(e.at), y, 9, withAlpha(LANE[e.i], 0.35));
        cv.circle(X(e.at), y, 6, LANE[e.i]);
    });
    cv.text('Each dot is one firing. A rule fires once, then again only after its value came back and the cooldown (' + s.cooldown + ' s) passed.', 48, 500, 15, t.dim);

    const q = G.panel(cv, t, 1040, 44, 536, 468, 'Latest');
    const list = s.events.slice(0, 7);
    if (!list.length) ['Nothing has fired yet.', '', 'When a rule fires it shows here,', 'with the time and the value', 'it had at that moment.']
        .forEach((l, k) => cv.text(l, 1064, 112 + k * 30, 19, k ? t.dim : t.text, { font: k ? 'label' : 'bold' }));
    list.forEach((e, k) => {
        const y = 104 + k * 52;
        cv.roundRect(1056, y - 4, 4, 42, 2, LANE[e.i]);
        cv.text(hm(e.at), 1072, y + 16, 17, t.text, { font: 'bold' });
        cv.text('rule ' + (e.i + 1), 1140, y + 16, 15, LANE[e.i], { font: 'bold' });
        cv.text(e.value + ' ' + e.unit, 1556, y + 16, 17, t.crit, { align: 'right', font: 'bold' });
        cv.text(e.text, 1072, y + 36, 15, t.dim);
    });
    cv.text(s.widget ? 'Shown on the home-screen widget too.' : 'Place the Watchdog widget on the home screen to see firings there.', 1064, 494, 15, t.dim);
}

function help(cv, t, s) {
    G.panel(cv, t, 24, 44, 1552, 468, 'How Watchdog works');
    [
        ['1', 'It watches in the background.', 'It starts with the car and keeps watching while navigation, music or any other screen is in front.'],
        ['2', 'You choose what it watches.', 'Up to 8 rules: a value, above or below a level, for how long. Rules page: Next rule, then Change value, Above / below, Lower, Higher, Hold time, Rule on / off.'],
        ['3', 'A rule fires once.', 'When the value stays past the level for the hold time. Again only after the value came back and the cooldown (Settings) passed.'],
        ['4', 'It only reads.', 'It uses what the car already sends to the head unit. Nothing is asked of a control unit or changed in the car.'],
    ].forEach((r, i) => {
        const y = 138 + i * 66;
        cv.circle(62, y - 8, 20, withAlpha(t.accent, 0.3));
        cv.text(r[0], 62, y, 22, t.text, { align: 'center', font: 'bold' });
        cv.text(r[1], 100, y, 22, t.text, { font: 'bold' });
        cv.text(r[2], 100, y + 28, 17, t.dim);
    });
    const by = 410;
    cv.roundRect(40, by, 1520, 94, 12, withAlpha(t.warn, 0.12));
    cv.text('WHAT A FIRING DOES', 64, by + 30, 16, t.warn, { font: 'bold', spacing: 2 });
    cv.text('The app cannot pop up over another screen: the head unit does not give apps a way to do that. A firing shows on the', 64, by + 58, 17, t.text);
    cv.text('Watchdog home-screen widget (if you placed one), as a NEW badge here and on the Events page, and is kept for later.', 64, by + 82, 17, t.text);
}

function draw(cv, t, page, s) {
    if (page === 1) events(cv, t, s);
    else if (page === 2) help(cv, t, s);
    else rules(cv, t, s);
}

module.exports = { draw, LANE };
