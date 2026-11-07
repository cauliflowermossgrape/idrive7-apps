'use strict';
/**
 * Part of Redline's experimental features; README.md in this folder has the whole picture.
 *
 * Drawing the HUD image (400x130, straight-alpha RGBA on black: black is see-through on the glass).
 * hud.js decides what to show and when; this file only draws it.
 *
 *   Layouts (setting "hudStyle"):
 *     standard  gear on the left (downshift arrows under it), 12 round shift lights over the slanted
 *               rev bar, and under the bar a readouts row (boost, cold limit, temperatures), which
 *               a shift grade replaces for a moment after an upshift
 *     minimal   gear and larger shift lights only
 *     wings     gear in the centre, 6 lights each side filling towards it, the bar underneath
 *   Palettes (setting "hudPalette"): colour (green / yellow / red), amber (night), ice (white / blue).
 *
 * drawHud() draws what stays put (unlit lights, dim track, red zone, readout labels) once per layout
 * into a cached Canvas and copies it in, then draws only what moves on top (layer 'bg' / 'fg').
 * Everything here draws on canvas.js Canvas; drawDown() also on the screen's Recorder (quads only).
 */
const { Canvas, withAlpha } = require('./kit/canvas');

const IW = 400, IH = 130;
const TEMP_X = 150;          // the readouts start here: BMW draws its assistance graphic under the left of the bar
const isNum = (x) => typeof x === 'number' && isFinite(x);
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

/** Colours per palette. low/mid/high: the lights' and bar's three steps; flash: the shift flash. */
const PALETTES = {
    colour: { low: '#2fd27a', mid: '#ffc21a', high: '#ff2a2a', flash: '#ff2a2a', limit: '#ff2a2a', text: '#ffffff', cold: '#3d8bff', warm: '#ffc21a', hot: '#ff2a2a', arrow: '#22e0ff', peak: '#ffffff' },
    amber: { low: '#c27400', mid: '#ffa000', high: '#ff5a1a', flash: '#ff5a1a', limit: '#ff3a1a', text: '#ffbe55', cold: '#b07a20', warm: '#ffa000', hot: '#ff3a1a', arrow: '#ffbe55', peak: '#ffbe55' },
    ice: { low: '#8fcfff', mid: '#e6f4ff', high: '#ff3a3a', flash: '#ff3a3a', limit: '#ff3a3a', text: '#ffffff', cold: '#5aa8ff', warm: '#e6f4ff', hot: '#ff3a3a', arrow: '#8fcfff', peak: '#ffffff' },
};
const VERDICT = { 'SPOT ON': 'low', EARLY: 'mid', LATE: 'high', LIMITER: 'limit', 'COLD REV': 'cold' };
const palette = (name) => PALETTES[name] || PALETTES.colour;

/** Gear / selector text from car.data(): P R N while selected, else the gear, D while none is engaged. */
function gearText(d) {
    const g = d.gear, st = d.stage;
    return st === 'P' || st === 'R' || st === 'N' ? st : g === -1 ? 'R' : isNum(g) && g > 0 ? String(g) : st === 'D' ? 'D' : g === 0 ? 'N' : '-';
}

/**
 * Shift lights at the points pts ([[x, y]]), radius rad. pos[i]: the step light i belongs to (0 lights
 * first); steps: how many steps. They count from cue.from to cue.at (the last step lights only with
 * the flash) and all flash while cue.shift or cue.limiter. s = { rpm, cue, blink, dim, style, P, layer }.
 */
function drawLights(cv, pts, pos, steps, rad, s) {
    const bg = s.layer !== 'fg', fg = s.layer !== 'bg', P = s.P, cue = s.cue;
    const flash = cue.shift || cue.limiter;
    const flashCol = cue.limiter ? P.limit : s.style === 'f1' ? '#2a7dff' : P.flash;
    const count = isNum(s.rpm) ? clamp((s.rpm - cue.from) / (cue.at - cue.from), 0, 1) : 0;
    const lit = Math.ceil(count * (steps - 1));
    const col = (k) => {
        if (s.style === 'mono') return P.text;
        const f = k / (steps - 1);
        return f < 0.34 ? P.low : f < 0.67 ? P.mid : P.high;
    };
    for (let i = 0; i < pts.length; i++) {
        const k = pos[i];
        if (bg && s.dim) cv.circle(pts[i][0], pts[i][1], rad, withAlpha(flash ? flashCol : col(k), 0.16));
        const c = flash ? (s.blink ? flashCol : null) : k < lit ? col(k) : null;
        if (fg && c) cv.circle(pts[i][0], pts[i][1], rad, c);
    }
}

/**
 * The slanted rev bar in (x, y, w, h): yellow mark at the shift point and red at the redline over its
 * top edge, the dim track and the red zone (bg), the lit segments and the peak line (fg).
 * s = { rpm, cue, shift, redline, max, blink, dim, peak, P, layer }.
 */
function drawBar(cv, x, y, w, h, s) {
    const bg = s.layer !== 'fg', fg = s.layer !== 'bg', P = s.P, cue = s.cue, rpm = s.rpm;
    const markH = 6, barY = y + markH + 2, barH = h - markH - 2;
    const slant = Math.round(barH * 0.32), X = (r) => x + clamp(r / s.max, 0, 1) * (w - slant);
    const seg = (a, b, c) => {
        const xa = X(a) + 2, xb = X(b) - 2;
        if (xb > xa) cv.quad([[xa + slant, barY], [xb + slant, barY], [xb, barY + barH], [xa, barY + barH]], c);
    };
    const mark = (r, c) => cv.fillRect(Math.round(X(r) + slant) - 1, y, 3, markH, c);
    if (fg && isNum(s.shift) && s.shift < s.redline) mark(s.shift, P.mid);
    if (fg) mark(s.redline, P.limit);
    if (bg && s.dim) for (let r = 0; r < s.redline; r += 500) seg(r, Math.min(s.redline, r + 500), withAlpha(P.text, 0.12));
    if (bg) for (let r = s.redline; r < s.max; r += 500) seg(r, Math.min(s.max, r + 500), withAlpha(P.limit, 0.4));
    if (fg && isNum(rpm) && rpm > 50) {
        // low below the shift point, mid past it, high into the redline; all flashing on the limiter
        const top = Math.min(rpm, s.max);
        for (let r = 0; r < top; r += 500) {
            const mid = r + 250;
            const c = cue.limiter ? (s.blink ? P.limit : withAlpha(P.limit, 0.35)) : mid >= s.redline ? P.high : mid >= s.shift ? P.mid : P.low;
            seg(r, Math.min(top, r + 500), c);
        }
    }
    // peak: a thin slanted line where the revs peaked, while they are below it
    if (fg && isNum(s.peak) && s.peak > 0 && !(isNum(rpm) && rpm >= s.peak - 50)) {
        const px = X(Math.min(s.peak, s.max));
        cv.line(px + slant, barY, px, barY + barH, 2, P.peak);
    }
}

/**
 * Downshift cue: n chevrons (1..3) centred at cx from y down; k scales them. Quads with two corners at
 * the tip: the screen's Recorder has quad() but no convex(). col: the colour (default cyan).
 */
function drawDown(cv, cx, y, n, k, col) {
    if (!(n > 0)) return;
    const w = 14 * k, h = 9 * k, gap = 4 * k, x0 = cx - (n * w + (n - 1) * gap) / 2;
    for (let i = 0; i < n; i++) {
        const x = x0 + i * (w + gap);
        cv.quad([[x, y], [x + w, y], [x + w / 2, y + h], [x + w / 2, y + h]], col || '#22e0ff');
    }
}

/**
 * The readouts row from x0 to x1 at y: items [{ label, value, tone }] (tone: 'text' | 'cold' | 'warm' |
 * 'hot'), as many columns as items (4 at most: hud.js keeps it there), slightly smaller beyond 3. Labels
 * are bg, values fg.
 */
function drawReadouts(cv, x0, x1, y, items, P, layer) {
    if (!items.length) return;
    const n = items.length, colw = (x1 - x0) / Math.max(3, n), k = Math.min(1, colw / 70);
    items.forEach((it, i) => {
        const cx = x0 + colw * (i + 0.5);
        if (layer !== 'fg') cv.text(it.label, cx, y + 12, 12 * k, withAlpha(P.text, 0.75), { align: 'center', font: 'bold', spacing: 1.2 * k });
        if (layer !== 'bg') cv.text(it.value, cx, y + 40, 26 * Math.max(0.8, k), P[it.tone] || P.text, { align: 'center', font: 'bold' });
    });
}

/** After an upshift: its grade (SPOT ON / EARLY / LATE / LIMITER / COLD REV) across the readouts row. */
function drawChip(cv, x0, x1, y, verdict, P) {
    const c = P[VERDICT[verdict] || 'text'] || P.text;
    cv.text(verdict, (x0 + x1) / 2, y + 36, 28, c, { align: 'center', font: 'bold', spacing: 2 });
}

/** The parts every layout draws the same way. */
function lightsRow(x, y, w, d) {
    const n = 12, pitch = w / n, pts = [];
    for (let i = 0; i < n; i++) pts.push([x + pitch * (i + 0.5), y + d / 2]);
    return { pts: pts, rad: Math.min(d / 2, pitch * 0.36) };
}

/**
 * Draws one layer ('bg' or 'fg') of the HUD image for f = { d, shift, redline, max, blink, cue, down,
 * peak, readouts: [items], chip (verdict or null), opts: { style, palette, lights, gt3, dim, gear,
 * lightStyle } }.
 */
function drawLayer(cv, f, layer) {
    const o = f.opts, d = f.d, P = palette(o.palette), cue = f.cue;
    const s = { rpm: d.rpm, cue: cue, shift: f.shift, redline: f.redline, max: f.max, blink: f.blink, dim: o.dim, style: o.lightStyle, P: P, layer: layer, peak: f.peak };
    const gearCol = cue.limiter && f.blink ? P.limit : P.text;
    const fg = layer !== 'bg';

    if (o.style === 'wings') {
        // gear centred, 6 lights each side filling towards it (outermost first), the bar underneath
        if (o.lights) {
            const pts = [], pos = [], d0 = 16;
            for (let i = 0; i < 6; i++) { pts.push([14 + i * 26, 30]); pos.push(i); }
            for (let i = 0; i < 6; i++) { pts.push([IW - 14 - i * 26, 30]); pos.push(i); }
            drawLights(cv, pts, pos, 6, d0 / 2, s);
        }
        drawBar(cv, 0, 84, IW, 40, s);
        if (fg) {
            if (o.gear) cv.text(gearText(d), IW / 2, 70, 72, gearCol, { align: 'center', font: 'gear' });
            drawDown(cv, IW / 2 + 52, 34, f.down || 0, 1, P.arrow);
        }
        return;
    }

    const tx = o.gear ? 70 : 0, tw = IW - tx;
    if (fg && o.gear) {
        cv.text(gearText(d), 30, 78, 72, gearCol, { align: 'center', font: 'gear' });
        drawDown(cv, 30, 90, f.down || 0, 1, P.arrow);
    }
    if (o.style === 'minimal') {
        // bigger lights only, centred on the gear's height
        if (o.lights) {
            const r = lightsRow(tx, 26, tw, 22);
            drawLights(cv, r.pts, r.pts.map((p, i) => (o.gt3 ? Math.min(i, 11 - i) : i)), o.gt3 ? 6 : 12, r.rad, s);
        }
        return;
    }

    // standard: lights, bar, readouts or a shift grade
    if (o.lights) {
        const r = lightsRow(tx, 2, tw, 14);
        drawLights(cv, r.pts, r.pts.map((p, i) => (o.gt3 ? Math.min(i, 11 - i) : i)), o.gt3 ? 6 : 12, r.rad, s);
    }
    drawBar(cv, tx, o.lights ? 20 : 2, tw, o.lights ? 38 : 56, s);
    if (f.chip) { if (fg) drawChip(cv, TEMP_X, IW, 66, f.chip, P); } else drawReadouts(cv, TEMP_X, IW, 66, f.readouts || [], P, layer);
}

/** The key of the static ('bg') layer: what it depends on. */
function bgKey(f) {
    const o = f.opts, c = f.cue;
    return [o.style, o.palette, o.gear, o.lights, o.gt3, o.dim, o.lightStyle, f.redline, f.max, c.shift || c.limiter, c.limiter,
        f.chip ? 'chip' : (f.readouts || []).map((r) => r.label).join(',')].join('|');
}

const bgCache = { key: '', cv: null };
/** The whole HUD image into cv (IW x IH): the cached static part, then what moves. */
function drawHud(cv, f) {
    const key = bgKey(f);
    if (bgCache.key !== key || !bgCache.cv) {
        const b = new Canvas(IW, IH);
        drawLayer(b, f, 'bg');
        bgCache.key = key; bgCache.cv = b;
    }
    if (cv.d && cv.d.length === bgCache.cv.d.length) cv.d.set(bgCache.cv.d); else { cv.clear(); cv.blit(bgCache.cv, 0, 0); }
    drawLayer(cv, f, 'fg');
}

module.exports = { drawHud, drawLayer, drawLights, drawBar, drawDown, drawReadouts, drawChip, gearText, PALETTES, IW, IH, TEMP_X };
