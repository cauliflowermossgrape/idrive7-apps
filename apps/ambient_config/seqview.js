'use strict';
/**
 * seqview.js - the Sequencer and Stealth tabs (from Exterior Lights by Paget96, PR #254), drawn from the state main.js
 * hands over.
 *
 *   Sequencer  six sequences: the beat grid (tap a cell to switch a light in that beat), the car from above playing it,
 *              Play / Stop and the beat length. The body controller's light functions, parked, 30 s at most a press.
 *   Stealth    (its own setting) the headlight units dark while parked: the car as it would look, what it covers,
 *              start / stop, how long.
 *
 *   drawSequencer(cv, t, s)   drawStealth(cv, t, s)   carView(cv, t, x, y, w, h, lit, o)
 */
const G = require('./kit/gauges');
const { withAlpha } = require('./kit/canvas');
const { LIGHTS, BEATS } = require('./presets');

const GO = '#2fd27a', AMBER = '#ffb020', RED = '#ff3b3b', WHITE = '#f4f6ff';
const COLOR = { high: WHITE, cornL: WHITE, cornR: WHITE, fog: '#fff4c8', indL: AMBER, indR: AMBER, parkL: '#dfe8ff', parkR: '#dfe8ff',
    brake: RED, reverse: WHITE, rearFog: '#ff6060' };

/* The car from above, front up; lit = Set of light functions on; o.front: false draws the headlights dark (Stealth). */
function carView(cv, t, x, y, w, h, lit, o) {
    o = o || {};
    const cw = Math.min(w * 0.62, h * 0.46), ch = h - 40, cx = x + w / 2, top = y + 20, l = cx - cw / 2, r = cx + cw / 2, bot = top + ch;
    cv.roundRect(l, top, cw, ch, cw * 0.28, withAlpha('#ffffff', 0.06));
    cv.strokeRoundRect(l, top, cw, ch, cw * 0.28, 2, withAlpha('#ffffff', 0.35));
    cv.roundRect(l + cw * 0.14, top + ch * 0.24, cw * 0.72, ch * 0.2, 14, withAlpha('#9ab8ff', 0.12));   // windscreen
    cv.roundRect(l + cw * 0.16, top + ch * 0.48, cw * 0.68, ch * 0.24, 10, withAlpha('#ffffff', 0.04));  // roof
    cv.roundRect(l + cw * 0.18, top + ch * 0.76, cw * 0.64, ch * 0.1, 10, withAlpha('#9ab8ff', 0.1));    // rear window
    const lamp = (fn, lx, ly, lw, lh, glow) => {
        const on = lit.has(fn) && !(o.front === false && glow === 'front'), c = COLOR[fn];
        if (on) {
            cv.roundRect(lx - 8, ly - 8, lw + 16, lh + 16, 10, withAlpha(c, 0.22));
            if (glow === 'front' || glow === 'rear') {
                const dy = glow === 'front' ? -1 : 1, by = glow === 'front' ? ly - 4 : ly + lh + 4;
                cv.fill([[lx + lw / 2, by], [lx + lw / 2 - 20, by + dy * 30], [lx + lw / 2 + 20, by + dy * 30]], withAlpha(c, 0.12));
            }
        }
        cv.roundRect(lx, ly, lw, lh, 5, on ? c : withAlpha('#ffffff', 0.14));
    };
    const fw = cw * 0.2, fy = top + 14;
    // front: headlight (high beam inner, parking ring outer), cornering at the corner, indicator, fog low on the bumper
    lamp('parkL', l + cw * 0.08, fy, fw, 12, 'front'); lamp('parkR', r - cw * 0.08 - fw, fy, fw, 12, 'front');
    lamp('high', l + cw * 0.3, fy + 2, fw * 0.6, 12, 'front'); lamp('high', r - cw * 0.3 - fw * 0.6, fy + 2, fw * 0.6, 12, 'front');
    lamp('cornL', l + 4, fy + 22, 14, 22, 'front'); lamp('cornR', r - 18, fy + 22, 14, 22, 'front');
    lamp('indL', l + cw * 0.1, fy + 24, fw * 0.7, 8); lamp('indR', r - cw * 0.1 - fw * 0.7, fy + 24, fw * 0.7, 8);
    lamp('fog', l + cw * 0.22, top - 6, cw * 0.14, 8, 'front'); lamp('fog', r - cw * 0.22 - cw * 0.14, top - 6, cw * 0.14, 8, 'front');
    // rear: brake / tail outer, indicators, reverse, rear fog
    const ry = bot - 26;
    lamp('brake', l + cw * 0.06, ry, fw, 14, 'rear'); lamp('brake', r - cw * 0.06 - fw, ry, fw, 14, 'rear');
    lamp('indL', l + cw * 0.06, ry - 14, fw * 0.6, 8); lamp('indR', r - cw * 0.06 - fw * 0.6, ry - 14, fw * 0.6, 8);
    lamp('reverse', cx - cw * 0.18, bot - 8, cw * 0.1, 8, 'rear'); lamp('rearFog', cx + cw * 0.08, bot - 8, cw * 0.1, 8, 'rear');
    cv.text('FRONT', cx, top - 14, 14, t.dim, { align: 'center', font: 'bold', spacing: 2 });
    if (o.front === false) cv.text('HEADLIGHTS DARK', cx, top + ch * 0.53, 16, GO, { align: 'center', font: 'bold', spacing: 1.5 });
}

/*
 * s: { presets, slot, preset, beat (null when not playing), playing, lit (Set), blocked (why Play can't start, or
 * null), note, noteType, pick(i), toggle(beat, fn), play(), stop(), beatLen() }
 */
function drawSequencer(cv, t, s) {
    const p = s.preset;
    G.panel(cv, t, 24, 44, 1112, 468, 'Sequence: ' + p.name + ', ' + p.beatMs + ' ms a beat');
    s.presets.forEach((q, i) => {
        const x = 44 + i * 178, on = i === s.slot;
        cv.roundRect(x, 102, 168, 32, 8, on ? withAlpha(t.accent, 0.35) : withAlpha('#ffffff', 0.06));
        cv.text((i + 1) + ' ' + q.name, x + 84, 124, 16, on ? t.text : t.dim, { align: 'center', font: 'bold' });
        if (cv.target && cv.own) cv.target(x, 102, 168, 32, () => s.pick(i), 'seq-slot' + i, 8);
    });
    const gx = 220, gy = 146, cw = 52, rh = 27;
    LIGHTS.forEach((l, r) => {
        const y = gy + r * rh;
        cv.text(l[1], gx - 12, y + 19, 15, t.dim, { align: 'right' });
        for (let b = 0; b < BEATS; b++) {
            const x = gx + b * cw, on = p.beats[b].indexOf(l[0]) >= 0;
            cv.roundRect(x + 2, y + 3, cw - 4, rh - 6, 5, on ? COLOR[l[0]] : withAlpha('#ffffff', b % 4 === 0 ? 0.09 : 0.05));
            if (cv.target && cv.own) cv.target(x, y, cw, rh, () => s.toggle(b, l[0]), 'seq-cell' + r + '-' + b, 5);
        }
    });
    if (s.beat !== null && s.beat !== undefined) {
        cv.strokeRoundRect(gx + s.beat * cw, gy - 4, cw, LIGHTS.length * rh + 8, 6, 2, s.playing ? t.warn : withAlpha('#ffffff', 0.7));
    }
    for (let b = 0; b < BEATS; b += 4) cv.text(String(b + 1), gx + b * cw + cw / 2, gy + LIGHTS.length * rh + 22, 14, t.dim, { align: 'center' });
    cv.text('Tap a cell to switch that light in that beat. Saved by itself.', 44, 494, 17, t.dim);
    G.panel(cv, t, 1152, 44, 424, 468, s.playing ? 'Playing on the car' : 'Preview');
    carView(cv, t, 1160, 100, 408, 290, s.lit, {});
    cv.text('Only for use on private property.', 1172, 404, 16, t.warn, { font: 'bold' });
    G.button(cv, t, 1172, 414, 186, 50, s.playing ? 'Stop' : 'Play', s.playing ? s.stop : s.play,
        { primary: true, color: s.playing ? t.crit : null, confirm: !s.playing, busy: !s.playing && !!s.blocked, key: 'seq-play' });
    G.button(cv, t, 1370, 414, 186, 50, p.beatMs + ' ms', s.beatLen, { key: 'seq-beat' });
    const line = !s.playing && s.blocked ? s.blocked : s.note && /Sequence/.test(s.note) ? s.note : 'Parked only, 30 s at most a press.';
    cv.text(line, 1172, 494, 15, !s.playing && s.blocked ? t.crit : s.noteType === 'warn' ? t.warn : t.dim);
}

/*
 * s: { on, why (the car can't: null when it can), blocked (a check says no, or null), headName, minutes, leftMs, note,
 * noteType, start(), stop(), cycleMinutes() }
 */
function drawStealth(cv, t, s) {
    G.panel(cv, t, 24, 44, 560, 468, s.on ? 'Stealth on' : 'Stealth preview');
    carView(cv, t, 40, 112, 528, 390, new Set(s.on ? ['brake'] : ['parkL', 'parkR', 'brake']), { front: !s.on ? undefined : false });
    G.panel(cv, t, 600, 44, 976, 468, 'Stealth: headlights dark while parked');
    cv.text(s.why ? 'Not possible on this car' : 'Possible on this car', 624, 124, 26, s.why ? t.crit : GO, { font: 'bold' });
    cv.text(s.why || 'Headlight units: ' + s.headName, 624, 154, 18, t.dim);
    [
        ['What goes dark', 'The front headlights: low beam, daytime lights and side lights inside them.'],
        ['What stays on', 'Tail lights: the body controller\'s functions can only switch a lamp on, not off.'],
        ['When it ends', 'Stop, after ' + s.minutes + ' min, or at once when the car moves or is locked and left.'],
        ['Afterwards', 'The channels are written back as they were and the headlights are the car\'s again.'],
    ].forEach((r, i) => {
        const y = 200 + i * 52;
        cv.text(r[0], 624, y, 19, t.text, { font: 'bold' });
        cv.text(r[1], 624, y + 24, 17, t.dim);
    });
    cv.text('Only for use on private property, parked. Driving without headlights is illegal and dangerous.', 624, 412, 17, t.warn, { font: 'bold' });
    if (s.on) {
        const left = Math.max(0, Math.round(s.leftMs / 1000));
        cv.text('Back in ' + Math.floor(left / 60) + ':' + String(left % 60).padStart(2, '0'), 624, 458, 24, t.warn, { font: 'num' });
    } else if (s.blocked) cv.text('Not now: ' + s.blocked, 624, 458, 17, t.crit);
    else if (s.note && /Stealth/.test(s.note)) cv.text(s.note, 624, 458, 17, s.noteType === 'warn' ? t.warn : t.dim);
    G.button(cv, t, 1176, 432, 186, 56, s.minutes + ' min', s.cycleMinutes, { key: 'stealth-min', busy: s.on });
    G.button(cv, t, 1376, 432, 180, 56, s.on ? 'Stop' : 'Start', s.on ? s.stop : s.start,
        { primary: true, color: s.on ? t.crit : null, confirm: !s.on, busy: !s.on && !!(s.why || s.blocked), key: 'stealth-go' });
}

module.exports = { drawSequencer, drawStealth, carView };
