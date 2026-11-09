'use strict';
/**
 * Part of Redline's experimental features; README.md in this folder has the whole picture.
 *
 * The layouts after BMW M's own head-up displays (setting "hudStyle"), drawn by hud-draw.js's drawLayer()
 * for these styles. Their colours are the originals' (they take no palette); the readouts, the shift grade
 * and its burst, the peak, the downshift arrows and the limiter flash work as in the other layouts.
 * Draws on canvas.js Canvas (or hud-draw's scaled()); arc() angles are degrees clockwise from 12 o'clock.
 *   arc   after F80/F82 M3/M4 (2014-20): 8 curved lights (6 amber, 2 red) over a curved band, gear under it
 *   ramp  after G80/G82 M3/M4 (2021+): the band climbs from bottom left then runs flat; its fields turn
 *         yellow, then red, towards the shift; 0-8 scale; gear over a line, a readout under it
 *   dial  after E60 M5 (2005-10): a 3/4 dial round the gear, green / orange advance warning / red,
 *         a readout bottom right in the dial's orange-red
 */
const { withAlpha } = require('./kit/canvas');
const IW = 400;
const isNum = (x) => typeof x === 'number' && isFinite(x);
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const flashing = (cue) => cue.shift || cue.limiter;

/* ---------- shared: readouts, the shift grade, the burst ---------- */
const GRADE = { 'SPOT ON': 'low', EARLY: 'mid', LATE: 'high', LIMITER: 'limit', 'COLD REV': 'cold', KNOCK: 'limit' };
/** A chip's colour: its own tone (the launch time), else its grade's. */
const chipCol = (chip, P) => P[chip.tone || GRADE[chip.verdict]] || P.text;
const toneCol = (it, P, base) => (it.tone && it.tone !== 'text' ? P[it.tone] || base : base);
/**
 * A readout's label size and colour: Normal 13 px nearly full brightness, Clearer 16 px full (10 / 12 px
 * read as specks on the glass, 2026-11-09 drive).
 */
const labelOf = (o, base) => (o.clearLabels ? { s: 16, c: base } : { s: 13, c: withAlpha(base, 0.9) });
/** A label at (x, y), made smaller (down to 8 px) when it would be wider than room. */
function fitLabel(cv, text, x, y, size, col, room, opts) {
    const lo = Object.assign({ font: 'bold', spacing: 1 }, opts || {});
    let s = size;
    if (cv.textWidth && room) { const w = cv.textWidth(text, s, lo); if (w > room) s = Math.max(8, s * room / w); }
    cv.text(text, x, y, s, col, lo);
}
/** A small readout: label then value on one line (row) or label over value (stack); align 'left' | 'right' | 'center'. */
function small(cv, x, y, it, P, o, base, mode, align, vsize) {
    const vs = vsize || 19;
    const lab = labelOf(o, base);
    if (mode === 'row') {
        // label at x, value right-aligned at the row's right edge (x + w); a label too long for the room the
        // value leaves (GEARBOX 120°, BOOST in kPa) is drawn smaller, down to 7 px, rather than run into it
        const w = align, lo = { font: 'bold', spacing: 1 };
        let ls = lab.s;
        if (cv.textWidth) {
            const room = w - cv.textWidth(it.value, vs, { font: 'bold' }) - 4, lw = cv.textWidth(it.label, ls, lo);
            if (lw > room) ls = Math.max(8, ls * room / lw);
        }
        cv.text(it.label, x, y, ls, lab.c, lo);
        cv.text(it.value, x + w, y + 1, vs, toneCol(it, P, base), { align: 'right', font: 'bold' });
        return;
    }
    cv.text(it.label, x, y, lab.s, lab.c, { align: align, font: 'bold', spacing: 1 });
    cv.text(it.value, x, y + 21, 20, toneCol(it, P, base), { align: align, font: 'bold' });
}
/** The shift grade at (x, y): pops in (burst), holds, fades over its last 300 ms. */
function grade(cv, x, y, chip, P, size, align) {
    const a = chip.age || 0, c = chipCol(chip, P);
    const alpha = a > 1200 ? clamp(1 - (a - 1200) / 300, 0, 1) : 1;
    const s = chip.burst && a < 150 ? size * (1.3 - 0.3 * a / 150) : size;
    if (alpha > 0) cv.text(chip.text || chip.verdict, x, y, s, withAlpha(c, alpha), { align: align || 'center', font: 'bold', spacing: 1 });
}
/** Burst: a ring grows from (cx, cy) radius r0 to r1 over 500 ms and fades. */
function ring(cv, cx, cy, r0, r1, chip, P) {
    const a = chip.age || 0;
    if (!chip.burst || a >= 500) return;
    const k = a / 500, r = r0 + (r1 - r0) * k;
    cv.arc(cx, cy, r - 2.5, r, 0, 360, withAlpha(chipCol(chip, P), 0.85 * (1 - k)));
}
const burstOn = (chip, ms) => chip && chip.burst && (chip.age || 0) < ms;
/**
 * The band layouts' shift colours follow the app's "Shift light style" as the other layouts' lights do:
 * M (the originals' own colours: own() false), Race (green / red / blue) or one colour. With the HUD's
 * shift lights Off they don't count in or flash for the shift; the limiter still flashes.
 */
const ownColours = (o) => o.lightStyle === 'f1' || o.lightStyle === 'mono';
const flashOn = (o, cue) => cue.limiter || (o.lights && cue.shift);
const flashColour = (o, cue, h, red) => (!cue.limiter && o.lightStyle === 'f1' ? h.RACE_BLUE : red);   // as drawLights: Race blue, else red

/* ---------- arc (F80) ---------- */
const A = { cx: 200, cy: 372, span: 27, l0: 352, l1: 368, b0: 325, b1: 343, rim: 3 };
const AC = { amber: '#f2a81d', red: '#e3262a', rim: '#f4f4f4', fill: '#bcd6e8', unlit: '#5d6b74', warn: '#f2b81d', zone: '#e3262a' };
const aAng = (f) => -A.span + 2 * A.span * clamp(f, 0, 1);
const aPt = (a, r) => [A.cx + r * Math.sin(a * Math.PI / 180), A.cy - r * Math.cos(a * Math.PI / 180)];
function cbox(cv, cx, cy, a0, a1, r0, r1, c, w) {
    if (!w) { cv.arc(cx, cy, r0, r1, a0, a1, c); return; }
    const da = (w / r1) * 180 / Math.PI;
    cv.arc(cx, cy, r1 - w, r1, a0, a1, c); cv.arc(cx, cy, r0, r0 + w, a0, a1, c);
    cv.arc(cx, cy, r0, r1, a0, a0 + da, c); cv.arc(cx, cy, r0, r1, a1 - da, a1, c);
}
function drawArc(cv, f, layer, h) {
    const o = f.opts, d = f.d, cue = f.cue, bg = layer !== 'fg', fg = layer !== 'bg', R = (r) => aAng(r / f.max);
    if (o.lights) {
        const n = 8, gap = 1.3, step = 2 * A.span / n, fl = flashing(cue);
        // "Shift light style": M is the F80's own amber and red; Race and one colour as the app's lights
        const own = o.lightStyle === 'f1' || o.lightStyle === 'mono';
        const flashCol = cue.limiter ? AC.red : o.lightStyle === 'f1' ? h.RACE_BLUE : AC.red;
        const lit = fl ? n : Math.ceil((isNum(d.rpm) ? clamp((d.rpm - cue.from) / (cue.at - cue.from), 0, 1) : 0) * (n - 1));
        for (let i = 0; i < n; i++) {
            const a0 = -A.span + i * step + gap / 2, a1 = a0 + step - gap, col = own ? h.lightCol(o.lightStyle, h.P, i / (n - 1)) : i >= n - 2 ? AC.red : AC.amber;
            if (bg && o.dim) cbox(cv, A.cx, A.cy, a0, a1, A.l0, A.l1, withAlpha(col, 0.85), 1.6);
            if (fg && i < lit && (!fl || f.blink)) cbox(cv, A.cx, A.cy, a0, a1, A.l0, A.l1, fl ? flashCol : col, 0);
        }
    }
    if (o.bar !== false) {
        const warn = Math.max(0, f.redline - 500);
        if (bg) {
            if (o.dim) cv.arc(A.cx, A.cy, A.b0, A.b1, R(0), R(warn), withAlpha(AC.unlit, 0.9));
            cv.arc(A.cx, A.cy, A.b0, A.b1, R(warn), R(f.redline), withAlpha(AC.warn, 0.55));
            cv.arc(A.cx, A.cy, A.b0, A.b1, R(f.redline), R(f.max), withAlpha(AC.zone, 0.55));
        }
        if (fg && isNum(d.rpm) && d.rpm > 50) {
            const top = Math.min(d.rpm, f.max), lim = cue.limiter, c = lim ? (f.blink ? AC.zone : withAlpha(AC.zone, 0.4)) : AC.fill;
            cv.arc(A.cx, A.cy, A.b0, A.b1, R(0), R(Math.min(top, warn)), c);
            if (top > warn) cv.arc(A.cx, A.cy, A.b0, A.b1, R(warn), R(Math.min(top, f.redline)), lim ? c : AC.warn);
            if (top > f.redline) cv.arc(A.cx, A.cy, A.b0, A.b1, R(f.redline), R(top), lim ? c : AC.zone);
        }
        if (bg) {
            cv.arc(A.cx, A.cy, A.b1, A.b1 + A.rim, R(0) - 0.4, R(f.max) + 0.4, AC.rim);
            for (let r = 1000; r < f.max; r += 1000) { const p = aPt(R(r), A.b1), q = aPt(R(r), A.b0 + 6); cv.line(p[0], p[1], q[0], q[1], 1.6, AC.rim); }
        }
        if (fg && isNum(f.peak) && f.peak > 0 && !(isNum(d.rpm) && d.rpm >= f.peak - 50)) {
            const p = aPt(R(Math.min(f.peak, f.max)), A.b1 + A.rim), q = aPt(R(Math.min(f.peak, f.max)), A.b0);
            cv.line(p[0], p[1], q[0], q[1], 2.4, '#ffffff');
        }
    }
    if (!fg) return;
    const W = '#f4f4f4', P = h.P, items = f.readouts || [];
    if (f.chip) ring(cv, A.cx, 102, 28, 70, f.chip, P);
    if (o.gear) cv.text(h.gearText(d), A.cx, 124, 62, cue.limiter && f.blink ? AC.red : W, { align: 'center', font: h.gearFont(o) });
    if (f.mode && o.gear) cv.text(f.mode, A.cx + 30, 86, 16, withAlpha(W, 0.85), { font: 'bold' });
    h.drawDown(cv, A.cx - 40, 112, f.down || 0, 0.8, P.arrow);
    // left, under the band and kept high (BMW's assistance graphic sits bottom left): readout 4
    if (items[3]) small(cv, 132, 82, items[3], P, o, W, 'stack', 'center');
    // right: readout 1 big beside the gear, 2 and 3 stacked at the far right; the grade takes them over
    if (f.chip) grade(cv, 312, 122, f.chip, P, 24);
    else {
        if (items[0]) {
            const lb = labelOf(o, W);
            fitLabel(cv, items[0].label, 288, 100, lb.s, lb.c, 48, { align: 'center' });
            cv.text(items[0].value, 288, 125, 26, toneCol(items[0], P, W), { align: 'center', font: o.valFont || 'bold' });
        }
        // from just right of the first readout (it ends by x 313) to the edge, values a size smaller
        if (items[1]) small(cv, 318, 104, items[1], P, o, W, 'row', 80, 17);
        if (items[2]) small(cv, 318, 126, items[2], P, o, W, 'row', 80, 17);
    }
}

/* ---------- ramp (G80) ---------- */
// the band's lower edge: from bottom left up to the knee, then flat; rpm runs along it by length
const RP = { x0: 34, y0: 74, kx: 104, ky: 30, x1: 372, t: 11, slant: 4 };
const RC = { line: '#f4f1e6', fill: '#f4f1e6', yellow: '#ffc21a', red: '#ff2b1c', text: '#f4f1e6' };
const rLen = (() => { const a = Math.hypot(RP.kx - RP.x0, RP.ky - RP.y0); return { a: a, all: a + (RP.x1 - RP.kx) }; })();
function rAt(rpm, max) {
    const s = clamp(rpm / max, 0, 1) * rLen.all;
    if (s <= rLen.a) { const k = s / rLen.a; return [RP.x0 + (RP.kx - RP.x0) * k, RP.y0 + (RP.ky - RP.y0) * k]; }
    return [RP.kx + (s - rLen.a), RP.ky];
}
/** The band between rpm a and b (gaps g px at each end), as quads split at the knee. */
function rSeg(cv, a, b, max, c, g, outline) {
    const kneeR = rLen.a / rLen.all * max, parts = a < kneeR && b > kneeR ? [[a, kneeR], [kneeR, b]] : [[a, b]];
    parts.forEach((p, i) => {
        const pa = rAt(p[0], max), pb = rAt(p[1], max);
        const ga = i === 0 ? g : 0, gb = i === parts.length - 1 ? g : 0;
        const L = Math.hypot(pb[0] - pa[0], pb[1] - pa[1]) || 1, ux = (pb[0] - pa[0]) / L, uy = (pb[1] - pa[1]) / L;
        const A0 = [pa[0] + ux * ga, pa[1] + uy * ga], B0 = [pb[0] - ux * gb, pb[1] - uy * gb];
        const sl = RP.slant;
        const q = [[A0[0] + sl, A0[1] - RP.t], [B0[0] + sl, B0[1] - RP.t], B0, A0];
        if (outline) cv.polyline(q.concat([q[0]]), outline, c); else cv.quad(q, c);
    });
}
function drawRamp(cv, f, layer, h) {
    const o = f.opts, d = f.d, cue = f.cue, BG = layer !== 'fg', fg = layer !== 'bg', max = f.max;
    const step = 500, fl = flashOn(o, cue), flashCol = flashColour(o, cue, h, RC.red);
    // what colour the field from r..r+step is when lit
    const fieldCol = (r) => {
        const m = r + step / 2;
        if (!o.lights || m < cue.from) return RC.fill;
        if (!ownColours(o)) return m >= cue.at ? RC.red : RC.yellow;
        // Race / one colour: the count-in as the app's lights, the last field the flash's colour
        return m >= cue.at ? flashColour(o, { limiter: false }, h, RC.red) : h.lightCol(o.lightStyle, h.P, clamp((m - cue.from) / (cue.at - cue.from), 0, 1));
    };
    if (o.bar !== false || o.lights) {
        if (BG) {
            for (let r = 0; r < max; r += step) {
                if (o.dim) rSeg(cv, r, Math.min(max, r + step), max, withAlpha(RC.line, 0.12), 1.2);
                rSeg(cv, r, Math.min(max, r + step), max, withAlpha(RC.line, 0.75), 1.2, 1.3);
            }
            // red zone: a strip over the band from the redline
            const a = rAt(f.redline, max), b = rAt(max, max);
            cv.fillRect(a[0] + RP.slant, a[1] - RP.t - 4, b[0] - a[0], 2.5, RC.red);
            // ticks and the scale under the band
            const lab = max <= 9000 ? 2000 : 3000;
            for (let r = 0; r <= max; r += 1000) {
                const p = rAt(r, max), big = r % lab === 0;
                cv.line(p[0], p[1] + 1, p[0], p[1] + (big ? 5 : 3), 1.4, RC.line);
                if (big) cv.text(String(r / 1000), p[0], p[1] + 17, 12, RC.text, { align: 'center', font: 'bold' });
            }
        }
        if (fg && isNum(d.rpm) && d.rpm > 50) {
            const top = Math.min(d.rpm, max);
            // burst: the lit fields pop in the grade's colour for 300 ms
            const pop = burstOn(f.chip, 300) ? chipCol(f.chip, h.P) : null;
            for (let r = 0; r < top; r += step) {
                const c = fl ? (f.blink ? flashCol : null) : pop || fieldCol(r);
                if (c) rSeg(cv, r, Math.min(top, r + step), max, c, 1.2);
            }
        }
        if (fg && isNum(f.peak) && f.peak > 0 && !(isNum(d.rpm) && d.rpm >= f.peak - 50)) {
            const p = rAt(Math.min(f.peak, max), max), sl = RP.slant;
            cv.line(p[0], p[1], p[0] + sl, p[1] - RP.t, 2.2, '#ffffff');
        }
    }
    if (!fg) return;
    const gx = 222, items = f.readouts || [];
    if (f.chip) ring(cv, gx, 74, 22, 58, f.chip, h.P);
    // readouts 2-4: a list on the right, label left and value right
    [1, 2, 3].forEach((i, k) => { if (items[i]) small(cv, 284, 66 + k * 26, items[i], h.P, o, RC.text, 'row', 112); });
    if (o.gear) cv.text(h.gearText(d), gx, 90, 44, cue.limiter && f.blink ? RC.red : RC.text, { align: 'center', font: h.gearFont(o) });
    if (f.mode && o.gear) cv.text(f.mode, gx + 22, 66, 14, withAlpha(RC.text, 0.85), { font: 'bold' });
    cv.fillRect(gx - 30, 96, 60, 1.6, RC.text);
    h.drawDown(cv, gx - 50, 62, f.down || 0, 1, h.P.arrow);
    if (f.chip) grade(cv, gx, 124, f.chip, h.P, 22);
    else {
        const it = items[0];
        if (it) {
            cv.text(it.value, gx, 124, 24, it.tone && it.tone !== 'text' ? h.P[it.tone] : RC.text, { align: 'center', font: o.valFont || 'bold' });
            fitLabel(cv, it.label.toLowerCase(), gx + 32, 102, labelOf(o, RC.text).s, RC.text, 284 - gx - 36, { spacing: 0 });
        }
    }
}

/* ---------- dial (E60) ---------- */
const D = { cx: 200, cy: 70, r0: 50, r1: 60, a0: -125, a1: 110 };
const DC = { green: '#a6d64a', orange: '#ff8a2e', red: '#f0313a', text: '#ff8a2e', speed: '#ff5a2e' };
function drawDial(cv, f, layer, h) {
    const o = f.opts, d = f.d, cue = f.cue, BG = layer !== 'fg', fg = layer !== 'bg', max = f.max, fl = flashOn(o, cue);
    const flashCol = flashColour(o, cue, h, DC.red);
    const ang = (r) => D.a0 + (D.a1 - D.a0) * clamp(r / max, 0, 1);
    // the E60's advance warning field: the last 1000 rpm before the redline (fixed, so the cached static
    // layer stays right; the count-in itself is the shift cue's flash)
    const warn = Math.max(0, f.redline - 1000);
    // the zones in the E60's colours, or the app's light style's: Race green / red / blue, one colour throughout
    const Z = o.lightStyle === 'f1' ? [h.P.low, h.P.high, h.RACE_BLUE] : o.lightStyle === 'mono' ? [h.P.text, h.P.text, h.P.text] : [DC.green, DC.orange, DC.red];
    const zone = (r) => (r >= f.redline ? Z[2] : r >= warn ? Z[1] : Z[0]);
    const step = 250;
    if (o.bar !== false || o.lights) {
        if (BG) for (let r = 0; r < max; r += step) {
            // the zones always faintly there; a hairline gap every 1000 rpm
            const g = (r + step) % 1000 === 0 ? 0.9 : 0;
            cv.arc(D.cx, D.cy, D.r0, D.r1, ang(r), ang(r + step) - g, withAlpha(zone(r), o.dim ? 0.22 : r >= warn ? 0.22 : 0));
        }
        if (fg && isNum(d.rpm) && d.rpm > 50) {
            const top = Math.min(d.rpm, max);
            // burst: the lit dial flashes the grade's colour for 300 ms
            const pop = burstOn(f.chip, 300) ? chipCol(f.chip, h.P) : null;
            for (let r = 0; r < top; r += step) {
                const c = fl ? (f.blink ? flashCol : null) : pop || zone(r);
                const g = (r + step) % 1000 === 0 ? 0.9 : 0;
                if (c) cv.arc(D.cx, D.cy, D.r0, D.r1, ang(r), ang(Math.min(top, r + step)) - (r + step <= top ? g : 0), c);
            }
        }
        if (fg && isNum(f.peak) && f.peak > 0 && !(isNum(d.rpm) && d.rpm >= f.peak - 50)) cv.arc(D.cx, D.cy, D.r0 - 3, D.r1 + 3, ang(f.peak) - 0.8, ang(f.peak) + 0.8, '#ffffff');
    }
    if (!fg) return;
    const items = f.readouts || [];
    if (f.chip) ring(cv, D.cx, D.cy, D.r1 + 2, D.r1 + 34, f.chip, h.P);
    // readouts 2 and 3: a list on the right; 4: top left (kept high, clear of BMW's assistance graphic)
    [1, 2].forEach((i, k) => { if (items[i]) small(cv, 284, 30 + k * 28, items[i], h.P, o, DC.speed, 'row', 112); });
    if (items[3]) small(cv, 70, 30, items[3], h.P, o, DC.speed, 'stack', 'center');
    if (o.gear) cv.text(h.gearText(d), D.cx, D.cy + 20, 56, cue.limiter && f.blink ? DC.red : DC.text, { align: 'center', font: h.gearFont(o) });
    if (f.mode && o.gear) cv.text(f.mode, D.cx + 24, D.cy - 14, 14, withAlpha(DC.text, 0.85), { font: 'bold' });
    h.drawDown(cv, D.cx, D.cy + 30, f.down || 0, 0.9, h.P.arrow);
    // bottom right, where the E60 shows the speed: the first readout, or the shift grade
    if (f.chip) grade(cv, 330, 122, f.chip, h.P, 22);
    else {
        const it = items[0];
        if (it) {
            cv.text(it.value, 300, 122, 26, it.tone && it.tone !== 'text' ? h.P[it.tone] : DC.speed, { align: 'right', font: o.valFont || 'bold' });
            fitLabel(cv, it.label.toLowerCase(), 304, 122, labelOf(o, DC.speed).s, DC.speed, 94, { spacing: 0 });
        }
    }
}

function drawM(cv, f, layer, h) {
    const st = f.opts.style;
    if (st === 'arc') drawArc(cv, f, layer, h); else if (st === 'ramp') drawRamp(cv, f, layer, h); else drawDial(cv, f, layer, h);
}
module.exports = { drawM };
