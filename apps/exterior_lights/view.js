'use strict';
/**
 * view.js - Exterior Lights' pages, drawn from the state main.js hands over:
 *
 *   note       the safety note, until it is accepted (every tab shows it until then)
 *   Safety     the checks that let anything run (green / red cards), the lamps found, a big STOP
 *   Stealth    the headlights dark while parked: the car from above as it would look, what it covers, start / stop
 *   Show       six sequences: the beat grid (tap a cell to switch a light in that beat), the car from above playing
 *              the sequence, Play / STOP, the beat length
 *   Coding     turn signal flashes, daytime light brightness, both rear fogs: what they are and why they are coding
 *   How it works
 *
 *   draw(cv, t, page, s)   carView(cv, t, x, y, w, h, lit, o)
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

function note(cv, t, s) {
    G.panel(cv, t, 24, 44, 1552, 468, 'Before you use Exterior Lights');
    const lines = [
        ['For private ground and car meets only, with the car parked.', 'You, the driver, are responsible for what your local law allows.'],
        ['Nothing runs while the car moves.', 'Above 3 km/h everything stops at once and the lamps are BMW\'s again.'],
        ['It also stops when a door opens, the car is locked and left, or the app closes.', 'Each run gives the lamps back exactly as Ambient config\'s strobe does.'],
        ['The 12 V battery is watched.', 'Below ' + s.minBattery + ' % charge nothing starts and a running show or stealth stops.'],
        ['It writes no coding.', 'Show and Stealth only switch lamps for a moment through the car\'s own test functions.'],
        ['Use it at your own risk.', 'It talks to the body controller and the headlight units: try it first where it does not matter.'],
    ];
    lines.forEach((l, i) => {
        const y = 128 + i * 54;
        cv.circle(64, y - 8, 14, withAlpha(t.warn, 0.3));
        cv.text(String(i + 1), 64, y - 1, 18, t.text, { align: 'center', font: 'bold' });
        cv.text(l[0], 96, y - 2, 22, t.text, { font: 'bold' });
        cv.text(l[1], 96, y + 22, 17, t.dim);
    });
    G.button(cv, t, 1176, 440, 380, 56, 'I understand, accept', s.accept, { primary: true, key: 'accept' });
    cv.text('Or press Accept below. Nothing is sent to the car before you accept.', 48, 484, 18, t.warn);
}

function card(cv, t, x, y, w, h, title, value, ok, sub) {
    const c = ok === true ? GO : ok === false ? t.crit : t.warn;
    cv.roundRect(x, y, w, h, 12, withAlpha(c, 0.1));
    cv.strokeRoundRect(x, y, w, h, 12, 1.5, withAlpha(c, 0.6));
    cv.text(title, x + 18, y + 30, 18, t.dim, { font: 'bold', spacing: 1 });
    cv.text(value, x + 18, y + 68, 28, t.text, { font: 'bold' });
    G.pill(cv, t, x + w - 104, y + 14, 88, 26, ok === true ? 'OK' : ok === false ? 'STOP' : 'CHECK', { color: c, size: 14 });
    if (sub) cv.text(sub, x + 18, y + h - 14, 15, t.dim);
}

function safety(cv, t, s) {
    G.panel(cv, t, 24, 44, 1032, 468, 'What lets it run');
    const g = s.gates, cw = 324, chh = 130;
    g.forEach((x, i) => card(cv, t, 44 + (i % 3) * (cw + 14), 108 + Math.floor(i / 3) * (chh + 14), cw, chh, x.title, x.value, x.ok, x.sub));
    const allOk = g.every((x) => x.ok !== false);
    cv.text(allOk ? 'All checks pass: Show and Stealth may run.' : 'A red card blocks everything; a running show or stealth stops on it.', 48, 494, 19, allOk ? GO : t.crit, { font: 'bold' });
    const p = G.panel(cv, t, 1072, 44, 504, 468, 'Now');
    cv.text(s.running ? 'RUNNING: ' + s.running.toUpperCase() : 'NOTHING RUNNING', 1096, 128, 26, s.running ? t.warn : GO, { font: 'bold', spacing: 1.5 });
    cv.text(s.lampsText, 1096, 160, 18, t.dim);
    if (s.note) cv.text(s.note, 1096, 188, 17, s.noteType === 'warn' ? t.warn : t.dim);
    G.button(cv, t, 1096, 214, 456, 146, 'STOP', s.stop, { primary: true, color: t.crit, key: 'stop-big' });
    cv.text('Gives every lamp back to the car at once.', 1096, 392, 18, t.dim);
    cv.text('Also on the bar below: STOP.', 1096, 420, 18, t.dim);
    cv.text(s.demo ? 'Demo: nothing is sent to the car.' : 'Speed now: ' + (s.speed === null ? 'not read' : Math.round(s.speed) + ' km/h'), 1096, p.y + p.h - 24, 18, s.demo ? t.warn : t.text);
}

function stealth(cv, t, s) {
    G.panel(cv, t, 24, 44, 560, 468, s.stealthOn ? 'Stealth on' : 'Stealth preview');
    carView(cv, t, 40, 112, 528, 390, new Set(s.stealthOn || s.demoStealth ? ['brake'] : ['parkL', 'parkR', 'brake']), { front: !(s.stealthOn || s.demoStealth) });
    G.panel(cv, t, 600, 44, 976, 468, 'Stealth: headlights dark while parked');
    const why = s.stealthWhy;
    cv.text(why ? 'Not possible on this car yet' : s.demo ? 'Demo: how it looks' : 'Possible on this car', 624, 124, 26, why ? t.crit : s.demo ? t.warn : GO, { font: 'bold' });
    cv.text(why || (s.demo ? 'Works on FLM01 and FLE headlight units; FLM02 (G20) cannot be held dark' : 'Headlight units: ' + s.headName), 624, 154, 18, t.dim);
    [
        ['What goes dark', 'The front headlights: low beam, daytime lights and side lights inside them.'],
        ['What stays on', 'Tail lights: the body controller\'s functions can only switch a lamp on, not off.'],
        ['How long', 'Until you press STOP, at most ' + s.stealthMin + ' min (Settings), or until a check fails.'],
        ['Afterwards', 'The channels as they were are written back and the headlight is the car\'s again.'],
    ].forEach((r, i) => {
        const y = 200 + i * 56;
        cv.text(r[0], 624, y, 19, t.text, { font: 'bold' });
        cv.text(r[1], 624, y + 26, 17, t.dim);
    });
    if (!s.stealthOn && s.note && /Stealth/.test(s.note)) cv.text(s.note, 624, 446, 17, s.noteType === 'warn' ? t.warn : t.dim);
    if (s.stealthOn) {
        const left = Math.max(0, Math.round(s.stealthLeftMs / 1000));
        cv.text('Back in ' + Math.floor(left / 60) + ':' + String(left % 60).padStart(2, '0'), 624, 438, 24, t.warn, { font: 'num' });
    }
    G.button(cv, t, 1176, 420, 380, 64, s.stealthOn ? 'STOP' : 'Start Stealth', s.stealthOn ? s.stop : s.startStealth,
        { primary: true, color: s.stealthOn ? t.crit : null, busy: !s.stealthOn && !!(why || s.blocked), key: 'stealth' });
    if (!s.stealthOn && s.blocked) cv.text('Blocked: ' + s.blocked, 624, 494, 17, t.crit);
}

function show(cv, t, s) {
    const p = s.preset;
    G.panel(cv, t, 24, 44, 1112, 468, 'Show: ' + p.name + ', ' + p.beatMs + ' ms a beat');
    s.presets.forEach((q, i) => {
        const x = 44 + i * 178, on = i === s.slot;
        cv.roundRect(x, 102, 168, 32, 8, on ? withAlpha(t.accent, 0.35) : withAlpha('#ffffff', 0.06));
        cv.text((i + 1) + ' ' + q.name, x + 84, 124, 16, on ? t.text : t.dim, { align: 'center', font: 'bold' });
        if (cv.target && cv.own) cv.target(x, 102, 168, 32, () => s.pick(i), 'slot' + i, 8);
    });
    const gx = 220, gy = 146, cw = 52, rh = 27;
    LIGHTS.forEach((l, r) => {
        const y = gy + r * rh;
        cv.text(l[1], gx - 12, y + 19, 15, t.dim, { align: 'right' });
        for (let b = 0; b < BEATS; b++) {
            const x = gx + b * cw, on = p.beats[b].indexOf(l[0]) >= 0;
            cv.roundRect(x + 2, y + 3, cw - 4, rh - 6, 5, on ? COLOR[l[0]] : withAlpha('#ffffff', b % 4 === 0 ? 0.09 : 0.05));
            if (cv.target && cv.own) cv.target(x, y, cw, rh, () => s.toggle(b, l[0]), 'cell' + r + '-' + b, 5);
        }
    });
    const cur = s.beat;
    if (cur !== null && cur !== undefined) {
        const x = gx + cur * cw;
        cv.strokeRoundRect(x, gy - 4, cw, LIGHTS.length * rh + 8, 6, 2, s.playing ? t.warn : withAlpha('#ffffff', 0.7));
    }
    for (let b = 0; b < BEATS; b += 4) cv.text(String(b + 1), gx + b * cw + cw / 2, gy + LIGHTS.length * rh + 22, 14, t.dim, { align: 'center' });
    cv.text('Tap a cell to switch that light in that beat. Saved by itself.', 44, 494, 17, t.dim);
    G.panel(cv, t, 1152, 44, 424, 468, s.playing ? 'Playing on the car' : 'Preview');
    carView(cv, t, 1160, 112, 408, 290, s.lit, {});
    G.button(cv, t, 1172, 410, 186, 54, s.playing ? 'STOP' : 'Play', s.playing ? s.stop : s.play,
        { primary: true, color: s.playing ? t.crit : null, busy: !s.playing && !!s.playBlocked, key: 'play' });
    G.button(cv, t, 1370, 410, 186, 54, p.beatMs + ' ms', s.beatLen, { key: 'beat' });
    cv.text(s.playBlocked && !s.playing ? s.playBlocked : 'On the car only parked, 30 s at most.', 1172, 494, 15, s.playBlocked && !s.playing ? t.crit : t.dim);
}

function coding(cv, t) {
    G.panel(cv, t, 24, 44, 1552, 468, 'These are coding, not a switch');
    cv.text('Each of these stays in the car until it is coded back. This app writes no coding: use a coding tool (for example BimmerCode or E-Sys).', 48, 112, 18, t.dim);
    [
        ['One-touch turn signal flashes', 'How many times the indicator blinks on a short tap of the stalk (BMW: 3).',
            'In coding apps it is usually under the body controller as comfort turn signal / number of flashes.', 'Allowed almost everywhere; more flashes can confuse others.'],
        ['Daytime running light brightness', 'How bright the daytime lights are, and whether they stay on with the tail lights.',
            'In coding apps it is under the headlight or body controller as daytime running lights / brightness.', 'Brightness limits for daytime lights are set by law in many countries.'],
        ['Both rear fog lights', 'Most BMWs light only one rear fog; some markets light both.',
            'In coding apps it is under the body controller as rear fog light / both sides.', 'Check your local rules: some countries want only one.'],
    ].forEach((c, i) => {
        const x = 44 + i * 512, y = 132;
        cv.roundRect(x, y, 496, 356, 14, withAlpha('#ffffff', 0.05));
        cv.strokeRoundRect(x, y, 496, 356, 14, 1.5, withAlpha(t.accent, 0.4));
        cv.text(c[0], x + 20, y + 40, 22, t.text, { font: 'bold' });
        G.pill(cv, t, x + 20, y + 58, 150, 26, 'CODING', { color: t.warn, size: 14 });
        wrap(cv, c[1], x + 20, y + 120, 456, 18, t.text);
        wrap(cv, c[2], x + 20, y + 200, 456, 17, t.dim);
        cv.text('LAW', x + 20, y + 290, 14, t.warn, { font: 'bold', spacing: 2 });
        wrap(cv, c[3], x + 20, y + 316, 456, 17, t.dim);
    });
}

/* Words broken into lines of at most w px. */
function wrap(cv, s, x, y, w, size, c) {
    const words = String(s).split(' ');
    let line = '', yy = y;
    for (const word of words) {
        const next = line ? line + ' ' + word : word;
        if (cv.textWidth && cv.textWidth(next, size) > w && line) { cv.text(line, x, yy, size, c); line = word; yy += size + 8; } else line = next;
    }
    if (line) cv.text(line, x, yy, size, c);
}

function help(cv, t, s) {
    G.panel(cv, t, 24, 44, 1552, 468, 'How Exterior Lights works');
    [
        ['1', 'It finds the lamps (reads only).', 'It asks the body controller for its light functions and the headlight units for their channels, as Ambient config does.'],
        ['2', 'Show plays a sequence for a moment.', 'Each beat asks the body controller to flash its lights for at most 150 ms; the car switches each off by itself.'],
        ['3', 'Stealth darkens the headlights.', 'Both headlight units get every channel at zero; the channels as they were go back when it ends.'],
        ['4', 'Everything checks the car each step.', 'Parked, doors closed, someone in the car, the battery above ' + s.minBattery + ' %, the note accepted. One fails: it stops.'],
        ['5', 'If the app stops, the car takes over.', 'The units leave the test session by themselves a few seconds after the last request.'],
    ].forEach((r, i) => {
        const y = 128 + i * 70;
        cv.circle(68, y - 8, 20, withAlpha(t.accent, 0.3));
        cv.text(r[0], 68, y, 22, t.text, { align: 'center', font: 'bold' });
        cv.text(r[1], 106, y, 22, t.text, { font: 'bold' });
        cv.text(r[2], 106, y + 28, 17, t.dim);
    });
    cv.text('Ambient config\'s strobe uses the same lamps: use one app at a time.', 48, 494, 17, t.warn);
}

function draw(cv, t, page, s) {
    if (!s.accepted && page !== 4) return note(cv, t, s);
    if (page === 1) stealth(cv, t, s);
    else if (page === 2) show(cv, t, s);
    else if (page === 3) coding(cv, t, s);
    else if (page === 4) help(cv, t, s);
    else safety(cv, t, s);
}

module.exports = { draw, carView, COLOR };
