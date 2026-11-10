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
const Theme = require('./hud-theme');
const isNum = (x) => typeof x === 'number' && isFinite(x);
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const flashing = (cue) => cue.shift || cue.limiter;

/* ---------- shared: readouts, the shift grade, the burst ---------- */
const chipCol = Theme.chipCol;
const toneCol = (it, P, base) => Theme.toneCol(it.tone, P, base);
/**
 * A readout's label size and colour: Normal 13 px nearly full brightness, Clearer 16 px full (10 / 12 px
 * read as specks on the glass, 2026-11-09 drive).
 */
const labelOf = (o, base) => (o.clearLabels ? { s: 16, c: base } : { s: 13, c: withAlpha(base, 0.9) });
/** A label at (x, y), made smaller (down to 8 px) when it would be wider than room. */
function fitLabel(cv, text, x, y, size, col, room, opts) {
    const lo = Object.assign({ font: 'bold', spacing: 1 }, opts || {});
    cv.text(text, x, y, room ? Theme.fitSize(cv, text, size, room, lo) : size, col, lo);
}
/** A small readout: label then value on one line (row) or label over value (stack); align 'left' | 'right' | 'center'. */
function small(cv, x, y, it, P, o, base, mode, align, vsize) {
    const vs = vsize || 19;
    const lab = labelOf(o, base);
    if (mode === 'row') {
        // label at x, value right-aligned at the row's right edge (x + w); a label too long for the room the
        // value leaves (GEARBOX 120°, BOOST in kPa) is drawn smaller, down to 8 px, rather than run into it
        const w = align, lo = { font: 'bold', spacing: 1 };
        const ls = cv.textWidth ? Theme.fitSize(cv, it.label, lab.s, w - cv.textWidth(it.value, vs, { font: 'bold' }) - 4, lo) : lab.s;
        cv.text(it.label, x, y, ls, lab.c, lo);
        cv.text(it.value, x + w, y + 1, vs, toneCol(it, P, base), { align: 'right', font: 'bold' });
        return;
    }
    cv.text(it.label, x, y, lab.s, lab.c, { align: align, font: 'bold', spacing: 1 });
    cv.text(it.value, x, y + 21, 20, toneCol(it, P, base), { align: align, font: 'bold' });
}
/*
 * The Recovery / Power meter as a ring segment (arc and dial; a readout with .bar, hud.js): not in the list but a thin
 * band concentric with the layout's own, from angle a0 to a1 (degrees clockwise from 12 o'clock), radii r0..r1. Zero
 * where lo..hi maps 0; recovery fills anticlockwise from it in c.low, power clockwise in c.fill (c.warm from 85 % of
 * bar.hi). layer 'bg': the outline (c.line) and the zero tick (c.tick, radii t0..t1); 'fg': the fill; neither: both.
 * v beyond lo / hi fills to the end; v 0 (or not a number) fills nothing.
 */
function ringMeter(cv, cx, cy, r0, r1, a0, a1, t0, t1, bar, c, layer) {
    const lo = isNum(bar.lo) && bar.lo < 0 ? bar.lo : -1, hi = isNum(bar.hi) && bar.hi > 0 ? bar.hi : 1;
    const az = a0 + (a1 - a0) * (-lo) / (hi - lo);
    if (layer !== 'fg') {
        cbox(cv, cx, cy, a0, a1, r0, r1, c.line, 1.1);
        // the zero: bold (about 3 px wide), so it reads at a glance where recovery ends and power starts
        cv.arc(cx, cy, t0, t1, az - 1.5 * 60 / r1, az + 1.5 * 60 / r1, c.tick);
    }
    if (layer === 'bg' || !isNum(bar.v)) return;
    if (bar.v < 0) { const k = clamp(bar.v / lo, 0, 1); if (k > 0.01) cv.arc(cx, cy, r0, r1, az - (az - a0) * k, az, c.low); }
    else if (bar.v > 0) { const k = clamp(bar.v / hi, 0, 1); if (k > 0.01) cv.arc(cx, cy, r0, r1, az, az + (a1 - az) * k, bar.v >= 0.85 * hi ? c.warm : c.fill); }
}
/** The shift grade at (x, y): pops in (burst), holds, fades over its last 300 ms. */
function grade(cv, x, y, chip, P, size, align) {
    const a = chip.age || 0, c = chipCol(chip, P);
    const alpha = Theme.burstAlpha(a);
    const s = chip.burst && a < Theme.BURST.pop ? size * (1.3 - 0.3 * a / Theme.BURST.pop) : size;
    if (alpha > 0) cv.text(chip.text || chip.verdict, x, y, s, withAlpha(c, alpha), { align: align || 'center', font: 'bold', spacing: 1 });
}
/** Burst: a ring grows from (cx, cy) radius r0 to r1 over 500 ms and fades. */
function ring(cv, cx, cy, r0, r1, chip, P) {
    const k = Theme.burstRing(chip.age || 0);
    if (!chip.burst || k < 0) return;
    const r = r0 + (r1 - r0) * k;
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
// the power meter: a 6 px ring inside the rpm band (b0) with a gap, a little shorter than it (clear of the readouts)
const AM = { r0: 314, r1: 320, span: 25, dn: 4 };
const AC = { amber: '#f2a81d', red: '#e3262a', rim: '#f4f4f4', fill: '#bcd6e8', unlit: '#5d6b74', warn: '#f2b81d', zone: '#e3262a' };
const aAng = (f) => -A.span + 2 * A.span * clamp(f, 0, 1);
const aPt = (a, r) => [A.cx + r * Math.sin(a * Math.PI / 180), A.cy - r * Math.cos(a * Math.PI / 180)];
function cbox(cv, cx, cy, a0, a1, r0, r1, c, w) {
    if (!w) { cv.arc(cx, cy, r0, r1, a0, a1, c); return; }
    const da = (w / r1) * 180 / Math.PI;
    cv.arc(cx, cy, r1 - w, r1, a0, a1, c); cv.arc(cx, cy, r0, r0 + w, a0, a1, c);
    cv.arc(cx, cy, r0, r1, a0, a0 + da, c); cv.arc(cx, cy, r0, r1, a1 - da, a1, c);
}
const arcBands = [];
/**
 * Where drawArc may copy the lit band in, per row: spans of the band's own ring (a pixel either side: the lights
 * over it share these rows), 3 px clear of its start and colour joins (a piece's start edge shades a hair
 * differently with where the piece ends) and of the lit end (angle aDeg). null when there's nothing to copy or no
 * static layer to copy over. The ring and joins part is worked out once per scale (kept in bandRows).
 */
let bandRows = { key: '', rows: null };
function band(cv, base, seams, aDeg) {
    if (!base || !cv.d || cv.w !== base.w || cv.h !== base.h) return null;
    const key = seams.join('|') + '|' + cv.h;
    if (bandRows.key !== key) {
        const sp = A.span * Math.PI / 180, ts = seams.map((a) => Math.tan(a * Math.PI / 180));
        const x0 = Math.max(0, Math.floor(A.cx - (A.b1 + 2) * Math.sin(sp)) - 2);
        const y0 = Math.max(0, Math.floor(A.cy - A.b1 - 2)), y1 = Math.min(cv.h - 1, Math.ceil(A.cy - A.b0 * Math.cos(sp) + 2));
        const rA = A.b0 - 1, rB = A.b1 + 1, rows = [];
        for (let py = y0; py <= y1; py++) {
            const dy = py + 0.5 - A.cy;
            if (Math.abs(dy) > rB) continue;
            const xl = Math.max(x0, Math.floor(A.cx - Math.sqrt(rB * rB - dy * dy)) - 1);
            const xr = Math.abs(dy) < rA ? Math.ceil(A.cx - Math.sqrt(rA * rA - dy * dy)) + 1 : Math.ceil(A.cx + Math.sqrt(rB * rB - dy * dy)) + 1;
            let spans = [[xl, xr]];
            ts.forEach((t) => {
                const xs = A.cx - dy * t, a = Math.floor(xs - 3), b = Math.ceil(xs + 3);
                spans = [].concat.apply([], spans.map((q) => [[q[0], Math.min(q[1], a)], [Math.max(q[0], b), q[1]]]));
            });
            spans = spans.filter((q) => q[1] > q[0]).sort((p, q) => p[0] - q[0]);
            if (spans.length) rows.push({ py: py, dy: dy, spans: spans });
        }
        bandRows = { key: key, rows: rows };
    }
    // this frame: each span up to 3 px short of where the lit end's radial line crosses its row
    const ta = Math.tan(aDeg * Math.PI / 180), copy = [];
    let any = false;
    bandRows.rows.forEach((r) => {
        const cut = Math.min(cv.w, Math.floor(A.cx - r.dy * ta - 3)), out = [];
        for (let i = 0; i < r.spans.length; i++) {
            const q = r.spans[i];
            if (q[0] >= cut) break;
            out.push(q[1] <= cut ? q : [q[0], cut]);
        }
        if (out.length) { any = true; copy[r.py] = out; }
    });
    return any ? { copy: copy } : null;
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
            const fill = (t, on, opts) => {
                on.arc(A.cx, A.cy, A.b0, A.b1, R(0), R(Math.min(t, warn)), c, opts);
                if (t > warn) on.arc(A.cx, A.cy, A.b0, A.b1, R(warn), R(Math.min(t, f.redline)), lim ? c : AC.warn, opts);
                if (t > f.redline) on.arc(A.cx, A.cy, A.b0, A.b1, R(f.redline), R(t), lim ? c : AC.zone, opts);
            };
            // drawHud's frames (h.base: the static layer under them): the band drawn lit to the end once over that
            // layer, its pixels left of the lit end copied in, only the rest drawn (the band was over half a frame)
            const base = layer === 'fg' && h.base, B = band(cv, base, [R(0), R(warn), R(f.redline)], R(top));
            if (!B) fill(top, cv);
            else {
                const key = [lim, lim && f.blink, f.redline, f.max].join('|');
                let lit = arcBands.filter((e) => e.key === key && e.base === base)[0];
                if (!lit) {
                    lit = { key: key, base: base, cv: new base.constructor(base.w, base.h) };
                    lit.cv.d.set(base.d);
                    fill(f.max, lit.cv);
                    arcBands.unshift(lit); arcBands.length = Math.min(arcBands.length, 4);
                }
                const W4 = cv.w * 4;
                B.copy.forEach((spans, py) => { if (spans) spans.forEach((c) => cv.d.set(lit.cv.d.subarray(py * W4 + c[0] * 4, py * W4 + c[1] * 4), py * W4 + c[0] * 4)); });
                // the rest: all but what was copied
                fill(top, cv, { skip: (py) => B.copy[py] || null });
            }
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
    // the power meter inside the band, along its curve (not in the list)
    const meter = (f.readouts || []).filter((it) => it.bar)[0];
    if (meter) ringMeter(cv, A.cx, A.cy, AM.r0, AM.r1, -AM.span, AM.span, AM.r0 - 3, AM.r1 + 2, meter.bar,
        { line: withAlpha(AC.rim, 0.6), tick: AC.rim, low: h.P.low, fill: AC.fill, warm: AC.amber }, layer);
    if (!fg) return;
    const W = '#f4f4f4', P = h.P, items = (f.readouts || []).filter((it) => !it.bar);
    if (f.chip) ring(cv, A.cx, 102, 28, 70, f.chip, P);
    if (o.gear) cv.text(h.gearText(d), A.cx, 124, 62, cue.limiter && f.blink ? AC.red : W, { align: 'center', font: h.gearFont(o) });
    if (f.mode && o.gear) cv.text(f.mode, A.cx + 30, 86, 16, withAlpha(W, 0.85), { font: 'bold' });
    h.drawDown(cv, A.cx - 40, 112, f.down || 0, 0.8, P.arrow);
    // left, under the band and kept high (BMW's assistance graphic sits bottom left): readout 4
    // (with the meter over it, 4 px lower to keep a gap)
    if (items[3]) small(cv, 132, 82 + (meter ? AM.dn : 0), items[3], P, o, W, 'stack', 'center');
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
const RP = { x0: 34, y0: 74, kx: 104, ky: 30, x1: 372, t: 11, t0: 3, slant: 4 };
const RC = { line: '#f4f1e6', fill: '#f4f1e6', yellow: '#ffc21a', red: '#ff2b1c', text: '#f4f1e6' };
const rLen = (() => { const a = Math.hypot(RP.kx - RP.x0, RP.ky - RP.y0); return { a: a, all: a + (RP.x1 - RP.kx) }; })();
function rAt(rpm, max) {
    const s = clamp(rpm / max, 0, 1) * rLen.all;
    if (s <= rLen.a) { const k = s / rLen.a; return [RP.x0 + (RP.kx - RP.x0) * k, RP.y0 + (RP.ky - RP.y0) * k]; }
    return [RP.kx + (s - rLen.a), RP.ky];
}
/**
 * The band's thickness at rpm: thin at the start (t0), widening up the climb to t at the knee, then the same along
 * the flat (2026-11-10: like a ramp that grows). Its slant grows with it, so the fields keep their angle.
 */
function rT(rpm, max) {
    const s = clamp(rpm / max, 0, 1) * rLen.all;
    return s >= rLen.a ? RP.t : RP.t0 + (RP.t - RP.t0) * s / rLen.a;
}
/** The band between rpm a and b (gaps g px at each end), as quads split at the knee. */
function rSeg(cv, a, b, max, c, g, outline) {
    const kneeR = rLen.a / rLen.all * max, parts = a < kneeR && b > kneeR ? [[a, kneeR], [kneeR, b]] : [[a, b]];
    parts.forEach((p, i) => {
        const pa = rAt(p[0], max), pb = rAt(p[1], max);
        const ga = i === 0 ? g : 0, gb = i === parts.length - 1 ? g : 0;
        const L = Math.hypot(pb[0] - pa[0], pb[1] - pa[1]) || 1, ux = (pb[0] - pa[0]) / L, uy = (pb[1] - pa[1]) / L;
        const A0 = [pa[0] + ux * ga, pa[1] + uy * ga], B0 = [pb[0] - ux * gb, pb[1] - uy * gb];
        const ta = rT(p[0], max), tb = rT(p[1], max), sa = RP.slant * ta / RP.t, sb = RP.slant * tb / RP.t;
        const q = [[A0[0] + sa, A0[1] - ta], [B0[0] + sb, B0[1] - tb], B0, A0];
        if (outline) cv.polyline(q.concat([q[0]]), outline, c); else cv.quad(q, c);
    });
}
/*
 * The ramp's Recovery / Power meter (a readout with .bar, hud.js): not in the list but a thin second band under
 * the ramp's scale, the same shape and length (2026-11-10, a 330e owner's sketch: like BMW's hybrid power meter).
 * Zero at the knee; recovery fills down the climb towards 0, power along the flat towards the end (yellow from
 * 85 % of bar.hi). Track bg (no zero tick: the knee is the zero), fill fg.
 */
// t: the thickness, the climb (recovery) the same as the flat (power), clear of the scale's numbers and the gear;
// start: where the climb begins, clear of the 0
const RM = { dy: 25, t: 6, slant: 2, start: 0.14 };
function rampMeter(cv, bar, P, layer) {
    const along = (a, b, k) => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];
    const A0 = [RP.x0, RP.y0 + RM.dy], K = [RP.kx, RP.ky + RM.dy], B = [RP.x1, RP.ky + RM.dy], A = along(A0, K, RM.start);
    const quad = (a, b, c, line, ta, tb) => {
        ta = ta || RM.t; tb = tb || ta;
        const q = [[a[0] + RM.slant * ta / RM.t, a[1] - ta], [b[0] + RM.slant * tb / RM.t, b[1] - tb], b, a];
        if (line) cv.polyline(q.concat([q[0]]), line, c); else cv.quad(q, c);
    };
    if (layer !== 'fg') {
        quad(A, K, withAlpha(RC.line, 0.6), 1.1); quad(K, B, withAlpha(RC.line, 0.6), 1.1);
        // no zero tick: the knee itself shows where recovery ends and power starts (a tick there met the scale's 2)
    }
    if (layer === 'bg' || !isNum(bar.v)) return;
    const lo = isNum(bar.lo) && bar.lo < 0 ? bar.lo : -1, hi = isNum(bar.hi) && bar.hi > 0 ? bar.hi : 1;
    if (bar.v < 0) { const k = clamp(bar.v / lo, 0, 1); if (k > 0.01) quad(along(K, A, k), K, P.low); }
    else if (bar.v > 0) { const k = clamp(bar.v / hi, 0, 1); if (k > 0.01) quad(K, along(K, B, k), bar.v >= 0.85 * hi ? RC.yellow : RC.fill); }
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
            const pk = Math.min(f.peak, max), p = rAt(pk, max), t = rT(pk, max);
            cv.line(p[0], p[1], p[0] + RP.slant * t / RP.t, p[1] - t, 2.2, '#ffffff');
        }
    }
    // the power meter under the ramp (not in the list)
    const meter = (f.readouts || []).filter((it) => it.bar)[0];
    if (meter) rampMeter(cv, meter.bar, h.P, layer);
    if (!fg) return;
    const gx = 222, items = (f.readouts || []).filter((it) => !it.bar);
    // with the meter under the band, everything below it 4 px lower (and the list's rows 1 px closer) so the gear,
    // its mode letter and the list's first row keep a gap to it
    const dn = meter ? 4 : 0, pitch = meter ? 25 : 26;
    if (f.chip) ring(cv, gx, 74 + dn, 22, 58, f.chip, h.P);
    // readouts 2-4: a list on the right, label left and value right
    [1, 2, 3].forEach((i, k) => { if (items[i]) small(cv, 284, 66 + dn + k * pitch, items[i], h.P, o, RC.text, 'row', 112); });
    if (o.gear) cv.text(h.gearText(d), gx, 90 + dn, 44, cue.limiter && f.blink ? RC.red : RC.text, { align: 'center', font: h.gearFont(o) });
    if (f.mode && o.gear) cv.text(f.mode, gx + 22, 66 + dn, 14, withAlpha(RC.text, 0.85), { font: 'bold' });
    cv.fillRect(gx - 30, 96 + dn, 60, 1.6, RC.text);
    h.drawDown(cv, gx - 50, 62 + dn, f.down || 0, 1, h.P.arrow);
    if (f.chip) grade(cv, gx, 124 + Math.min(dn, 3), f.chip, h.P, 22);
    else {
        const it = items[0];
        if (it) {
            cv.text(it.value, gx, 124 + Math.min(dn, 3), 24, toneCol(it, h.P, RC.text), { align: 'center', font: o.valFont || 'bold' });
            fitLabel(cv, it.label.toLowerCase(), gx + 32, 102 + dn, labelOf(o, RC.text).s, RC.text, 284 - gx - 36, { spacing: 0 });
        }
    }
}

/* ---------- dial (E60) ---------- */
const D = { cx: 200, cy: 70, r0: 50, r1: 60, a0: -125, a1: 110 };
// the power meter: a 6 px ring round the dial (r1) with a gap, up to the image's top edge
const DM = { r0: 64, r1: 70 };
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
    const step = 250, meter = (f.readouts || []).filter((it) => it.bar)[0];
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
        // (with the meter round the dial, the peak stops short of it)
        if (fg && isNum(f.peak) && f.peak > 0 && !(isNum(d.rpm) && d.rpm >= f.peak - 50)) cv.arc(D.cx, D.cy, D.r0 - 3, meter ? D.r1 : D.r1 + 3, ang(f.peak) - 0.8, ang(f.peak) + 0.8, '#ffffff');
    }
    // the power meter: a ring round the dial over its sweep (not in the list)
    if (meter) ringMeter(cv, D.cx, D.cy, DM.r0, DM.r1, D.a0, D.a1, DM.r0, DM.r1 + 3, meter.bar,
        { line: withAlpha(DC.text, 0.6), tick: DC.text, low: h.P.low, fill: DC.orange, warm: DC.red }, layer);
    if (!fg) return;
    const items = (f.readouts || []).filter((it) => !it.bar);
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
            cv.text(it.value, 300, 122, 26, toneCol(it, h.P, DC.speed), { align: 'right', font: o.valFont || 'bold' });
            fitLabel(cv, it.label.toLowerCase(), 304, 122, labelOf(o, DC.speed).s, DC.speed, 94, { spacing: 0 });
        }
    }
}

/* ---------- pill (a sim-racing telemetry overlay's look) ---------- */
/*
 * One rounded panel across the picture: at its left the gear in a ring that fills round with the revs (the low
 * colour, the mid colour through the count-in, red at the shift point), shift lights as a row of small dots
 * along its top, and up to three readouts as a small label over big 7-segment digits. Through the count-in the panel
 * reddens; from the shift point and on the limiter it flashes (bright red alone, then grey with the ring and dots
 * red), back to grey after the upshift (2026-11-10, from the user's video). The power meter runs along the panel's bottom (not in the list).
 */
// (the dots and the readouts stop where the panel's rounded right end starts closing in)
const PL = { x: 4, y: 20, w: 392, h: 100, gx: 54, gy: 70, r0: 33, r1: 41, dx0: 112, dx1: 352, dy: 34, rad: 4.2,
    vx: 112, slots: [0, 96, 180], room: [90, 78, 78], ly: 58, vy: 64, vh: 28, cw: 14, ct: 3.6, cg: 4, mx0: 112, mx1: 352, my: 106, mh: 5 };
const PC = { panel: '#2e3238', red: '#d42a26', ring: '#ffffff' };
/** Colour a..b at k (0..1), both '#rrggbb'. */
function mixHex(a, b, k) {
    const c = (x, i) => parseInt(x.slice(1 + 2 * i, 3 + 2 * i), 16), t = clamp(k, 0, 1);
    return '#' + [0, 1, 2].map((i) => ('0' + Math.round(c(a, i) + (c(b, i) - c(a, i)) * t).toString(16)).slice(-2)).join('');
}
/** A readout's value as 7-segment digits (with a decimal point) from x, a suffix such as ° or % after it as text. */
function segValue(cv, str, x, y, c, h) {
    const m = /^(-?[0-9][0-9.]*)(.*)$/.exec(String(str));
    if (!m) { cv.text(String(str), x, y + PL.vh, 26, c, { font: 'bold' }); return; }
    let px = x;
    for (const ch of m[1]) {
        if (ch === '.') { cv.fillRect(px - 1, y + PL.vh - PL.ct, PL.ct, PL.ct, c); px += PL.ct + PL.cg - 1; continue; }
        h.seg7(cv, ch, px, y, PL.cw, PL.vh, PL.ct, c, null, false, 'fg');
        px += PL.cw + PL.cg;
    }
    if (m[2]) cv.text(m[2].trim(), px, y + 13, 14, c, { font: 'bold' });
}
/** The power meter along the panel's bottom: a centre-zero track, recovery left in the low colour, drive right. */
function pillMeter(cv, bar, P, layer) {
    const lo = isNum(bar.lo) && bar.lo < 0 ? bar.lo : -1, hi = isNum(bar.hi) && bar.hi > 0 ? bar.hi : 1;
    const X = (v) => PL.mx0 + (PL.mx1 - PL.mx0) * clamp((v - lo) / (hi - lo), 0, 1), z = X(0);
    if (layer !== 'fg') {
        cv.roundRect(PL.mx0, PL.my, PL.mx1 - PL.mx0, PL.mh, PL.mh / 2, withAlpha(P.text, 0.16));
        cv.fillRect(z - 1, PL.my - 2, 2, PL.mh + 4, P.text);
    }
    if (layer === 'bg' || !isNum(bar.v)) return;
    const vx = X(bar.v);
    if (vx < z - 1.5) cv.roundRect(vx, PL.my, z - 1 - vx, PL.mh, PL.mh / 2, P.low);
    else if (vx > z + 1.5) cv.roundRect(z + 1, PL.my, vx - z - 1, PL.mh, PL.mh / 2, bar.v >= 0.85 * hi ? P.warm || P.mid : P.text);
}
function drawPill(cv, f, layer, h) {
    // all of it on the moving layer: the panel's colour follows the revs (the static layer would cover nothing)
    if (layer === 'bg') return;
    const o = f.opts, d = f.d, cue = f.cue, P = h.P, fl = flashOn(o, cue);
    const flashCol = cue.limiter ? P.limit : o.lightStyle === 'f1' ? h.RACE_BLUE : P.limit;
    const meter = (f.readouts || []).filter((it) => it.bar)[0];
    // the count-in (shift lights on): the panel reddens from grey as the shift point nears. From the shift point and on
    // the limiter it flashes: solid bright red with no ring or dots, then grey with the ring and the dots in red
    const count = o.lights && isNum(d.rpm) ? clamp((d.rpm - cue.from) / Math.max(1, cue.at - cue.from), 0, 1) : 0;
    const solid = fl && f.blink;
    const panel = solid ? withAlpha(PC.red, 0.92) : fl ? withAlpha(PC.panel, 0.7) : withAlpha(mixHex(PC.panel, PC.red, count), 0.7 + 0.15 * count);
    cv.roundRect(PL.x, PL.y, PL.w, PL.h, PL.h / 2, panel);
    // the ring round the gear: a faint track, filled round from the top with the revs to the redline
    // (the light style's first colour, its middle one through the count-in, the flash's at the shift point)
    const ringCol = fl ? flashCol : isNum(d.rpm) && d.rpm >= cue.from ? h.lightCol(o.lightStyle, P, 0.5) : h.lightCol(o.lightStyle, P, 0);
    if (o.bar !== false && !solid) {
        cv.arc(PL.gx, PL.gy, PL.r0, PL.r1, 0, 360, withAlpha(PC.ring, o.dim ? 0.18 : 0.1));
        if (isNum(d.rpm) && d.rpm > 50) {
            const a = 360 * clamp(d.rpm / Math.max(1, f.redline), 0, 1);
            const pop = burstOn(f.chip, 300) ? chipCol(f.chip, P) : null;
            if (a > 0.5) cv.arc(PL.gx, PL.gy, PL.r0, PL.r1, 0, a, fl ? flashCol : pop || ringCol, { round: true });
        }
        if (isNum(f.peak) && f.peak > 0 && !(isNum(d.rpm) && d.rpm >= f.peak - 50)) {
            const pa = 360 * clamp(f.peak / Math.max(1, f.redline), 0, 1);
            cv.arc(PL.gx, PL.gy, PL.r0 - 2, PL.r1 + 2, pa - 1.5, pa + 1.5, '#ffffff');
        }
    }
    // the shift lights: small dots along the top, in the app's light fill (GT3 or left to right) and colours; in the
    // flash's grey half all in the flash colour, in its red half none
    if (o.lights && !solid) {
        const n = 14, pts = [], pitch = (PL.dx1 - PL.dx0) / (n - 1);
        for (let i = 0; i < n; i++) pts.push([PL.dx0 + i * pitch, PL.dy]);
        h.drawLights(cv, pts, pts.map((p, i) => (o.gt3 ? Math.min(i, n - 1 - i) : i)), o.gt3 ? n / 2 : n, PL.rad,
            { rpm: d.rpm, cue: cue, blink: true, dim: o.dim, style: o.lightStyle, P: P, layer: 'both' });
    }
    if (meter) pillMeter(cv, meter.bar, P, 'both');
    if (f.chip) ring(cv, PL.gx, PL.gy, PL.r1 + 2, PL.r1 + 30, f.chip, P);
    // (white throughout: the panel itself flashes red)
    if (o.gear) cv.text(h.gearText(d), PL.gx, PL.gy + 15, 52, P.text, { align: 'center', font: h.gearFont(o) });
    // the gearbox mode under the ring's right side, clear of the dots
    if (f.mode && o.gear) cv.text(f.mode, PL.gx + 38, PL.gy + 44, 14, withAlpha(P.text, 0.85), { font: 'bold' });
    // the downshift arrows inside the ring, under the gear (clear of the ring and of the panel's edge)
    h.drawDown(cv, PL.gx, PL.gy + 21, f.down || 0, 0.6, P.arrow);
    // the readouts: a small label over big digits, three slots; the shift grade takes them over
    if (f.chip) { grade(cv, (PL.vx + PL.dx1) / 2, PL.vy + PL.vh, f.chip, P, 28); return; }
    const items = (f.readouts || []).filter((it) => !it.bar);
    items.slice(0, 3).forEach((it, k) => {
        const x = PL.vx + PL.slots[k], lab = labelOf(o, P.text);
        fitLabel(cv, it.label, x, PL.ly, lab.s, lab.c, PL.room[k], { font: 'bold', spacing: 1 });
        segValue(cv, it.value, x, PL.vy, toneCol(it, P, P.text), h);
    });
}
function drawM(cv, f, layer, h) {
    const st = f.opts.style;
    if (st === 'arc') drawArc(cv, f, layer, h); else if (st === 'ramp') drawRamp(cv, f, layer, h); else if (st === 'pill') drawPill(cv, f, layer, h); else drawDial(cv, f, layer, h);
}
module.exports = { drawM };
