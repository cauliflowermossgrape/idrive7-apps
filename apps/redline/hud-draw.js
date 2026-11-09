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
 *     digital   80s digital dash: square lights, an LCD bar graph of 40 segments, 7-segment gear
 *               and rpm digits
 *     vfd       the same as a teal vacuum-fluorescent display, unlit segments always faintly lit
 *     vector    the standard layout in outline only (rings, outlined segments, outlined digits)
 *     arc       after the F80/F82 M3/M4's HUD: 8 curved lights over a curved band, the gear under it
 *     ramp      after the G80/G82 M3/M4's: a band climbing then flat, fields going yellow then red
 *     dial      after the E60 M5's: a 3/4 dial round the gear, green / orange / red
 *               (these three: hud-m.js, in the originals' colours)
 *   Palettes (setting "hudPalette"): colour (green / yellow / red), amber (night), ice (white / blue);
 *   vfd and the M layouts have their own.
 *   Gear font (setting "hudGearFont"): Ubuntu, or Barlow (Auto: Barlow on the M layouts); a font whose
 *   atlas is missing falls back to Ubuntu.
 *   Effects: the shift grade as a "burst" (pops, a ring grows, fades), the redline shake (on the
 *   limiter the whole image jitters a few px).
 *
 * drawHud() draws what stays put (unlit lights, dim track, red zone, readout labels) once per layout
 * into a cached Canvas and copies it in, then draws only what moves on top (layer 'bg' / 'fg').
 * Everything here draws on canvas.js Canvas; drawDown() also on the screen's Recorder (quads only).
 */
const { Canvas, withAlpha } = require('./kit/canvas');
const fonts = require('./kit/fonts');
const M = require('./hud-m');

const IW = 400, IH = 130;
const TEMP_X = 150;          // the readouts start here: BMW draws its assistance graphic under the left of the bar
const isNum = (x) => typeof x === 'number' && isFinite(x);
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

/** Colours per palette. low/mid/high: the lights' and bar's three steps; flash: the shift flash. */
const PALETTES = {
    colour: { low: '#2fd27a', mid: '#ffc21a', high: '#ff2a2a', flash: '#ff2a2a', limit: '#ff2a2a', text: '#ffffff', cold: '#3d8bff', warm: '#ffc21a', hot: '#ff2a2a', arrow: '#22e0ff', peak: '#ffffff' },
    amber: { low: '#c27400', mid: '#ffa000', high: '#ff5a1a', flash: '#ff5a1a', limit: '#ff3a1a', text: '#ffbe55', cold: '#b07a20', warm: '#ffa000', hot: '#ff3a1a', arrow: '#ffbe55', peak: '#ffbe55' },
    vfd: { low: '#3ef0d0', mid: '#a8fff0', high: '#ff6a3a', flash: '#ff6a3a', limit: '#ff4a2a', text: '#5ff6dc', cold: '#46b4ff', warm: '#ffd34a', hot: '#ff5a3a', arrow: '#5ff6dc', peak: '#d8fff8' },
    ice: { low: '#8fcfff', mid: '#e6f4ff', high: '#ff3a3a', flash: '#ff3a3a', limit: '#ff3a3a', text: '#ffffff', cold: '#5aa8ff', warm: '#e6f4ff', hot: '#ff3a3a', arrow: '#8fcfff', peak: '#ffffff' },
};
const VERDICT = { 'SPOT ON': 'low', EARLY: 'mid', LATE: 'high', LIMITER: 'limit', 'COLD REV': 'cold', KNOCK: 'limit' };
const palette = (name) => PALETTES[name] || PALETTES.colour;
const VERDICT_TEXT = { 'SPOT ON': 'PERFECT SHIFT', EARLY: 'EARLY', LATE: 'LATE', LIMITER: 'LIMITER', 'COLD REV': 'COLD REV', KNOCK: 'KNOCK' };

/*
 * 7-segment characters: segments a (top), b (top right), c (bottom right), d (bottom), e (bottom
 * left), f (top left), g (middle). Letters as an 80s dash would show them (r, n, d lower case).
 */
const SEG7 = { 0: 'abcdef', 1: 'bc', 2: 'abged', 3: 'abgcd', 4: 'fgbc', 5: 'afgcd', 6: 'afgedc', 7: 'abc', 8: 'abcdefg', 9: 'abcdfg',
    P: 'abefg', R: 'eg', N: 'ceg', D: 'bcdeg', '-': 'g', ' ': '' };
/**
 * One 7-segment character in (x, y, w, h), segments t thick: lit ones in c, unlit in ghost (or not at
 * all); outline: drawn as outlines (vector). layer: 'bg' ghosts only, 'fg' lit only, neither both.
 */
function seg7(cv, ch, x, y, w, h, t, c, ghost, outline, layer) {
    const on = SEG7[ch] !== undefined ? SEG7[ch] : '';
    const hh = h / 2, g = 1;
    const R = {
        a: [x + t, y, w - 2 * t, t], g: [x + t, y + hh - t / 2, w - 2 * t, t], d: [x + t, y + h - t, w - 2 * t, t],
        f: [x, y + t - g, t, hh - t - g], b: [x + w - t, y + t - g, t, hh - t - g],
        e: [x, y + hh + g, t, hh - t - g], c: [x + w - t, y + hh + g, t, hh - t - g],
    };
    'abcdefg'.split('').forEach((k) => {
        const r = R[k], lit = on.indexOf(k) >= 0;
        // bg: every segment's ghost whatever the character (the cached layer must not depend on it);
        // fg: the lit ones over it; neither: both
        const col = layer === 'bg' ? ghost : layer === 'fg' ? (lit ? c : null) : (lit ? c : ghost);
        if (!col) return;
        if (outline) cv.polyline([[r[0], r[1]], [r[0] + r[2], r[1]], [r[0] + r[2], r[1] + r[3]], [r[0], r[1] + r[3]], [r[0], r[1]]], 1.6, col);
        else cv.fillRect(r[0], r[1], r[2], r[3], col);
    });
}
/** A string of 7-segment characters from x, each w wide with gap between. */
function seg7text(cv, str, x, y, w, h, t, gap, c, ghost, outline, layer) {
    for (let i = 0; i < str.length; i++) seg7(cv, str[i], x + i * (w + gap), y, w, h, t, c, ghost, outline, layer);
}

/** Gear / selector text from car.data(): P R N while selected, else the gear, D while none is engaged. */
function gearText(d) {
    const g = d.gear, st = d.stage;
    return st === 'P' || st === 'R' || st === 'N' ? st : g === -1 ? 'R' : isNum(g) && g > 0 ? String(g) : st === 'D' ? 'D' : g === 0 ? 'N' : '-';
}

const RACE_BLUE = '#2a7dff';
/** The gear's font family: the option's, or Ubuntu's ('gear') when that atlas isn't in the app. */
const gearFont = (o) => (o.gearFont && o.gearFont !== 'gear' && fonts.has(o.gearFont) ? o.gearFont : 'gear');
/**
 * A shift light's colour at f (0 first .. 1 last) for the app's "Shift light style" (setting "lights"),
 * as the app's own lights: m green / yellow / red, f1 (Race) green / red / blue, mono one colour.
 */
function lightCol(style, P, f) {
    if (style === 'mono') return P.text;
    if (style === 'f1') return f < 0.42 ? P.low : f < 0.84 ? P.high : RACE_BLUE;
    return f < 0.34 ? P.low : f < 0.67 ? P.mid : P.high;
}
/**
 * Shift lights at the points pts ([[x, y]]), radius rad. pos[i]: the step light i belongs to (0 lights
 * first); steps: how many steps. They count from cue.from to cue.at (the last step lights only with
 * the flash) and all flash while cue.shift or cue.limiter. s = { rpm, cue, blink, dim, style, P, layer }.
 */
function drawLights(cv, pts, pos, steps, rad, s) {
    const bg = s.layer !== 'fg', fg = s.layer !== 'bg', P = s.P, cue = s.cue;
    const flash = cue.shift || cue.limiter;
    const flashCol = cue.limiter ? P.limit : s.style === 'f1' ? RACE_BLUE : P.flash;
    const count = isNum(s.rpm) ? clamp((s.rpm - cue.from) / (cue.at - cue.from), 0, 1) : 0;
    const lit = Math.ceil(count * (steps - 1));
    const col = (k) => lightCol(s.style, P, k / (steps - 1));
    // shape: 'dot' (filled), 'rect' (an LCD block), 'ring' (vector: outline, lit ones with a core)
    const shape = s.shape || 'dot';
    const put = (p, c, lit) => {
        if (shape === 'rect') cv.fillRect(p[0] - rad * 1.2, p[1] - rad * 0.7, rad * 2.4, rad * 1.4, c);
        else if (shape === 'ring') { cv.arc(p[0], p[1], rad - 1.8, rad, 0, 360, c); if (lit) cv.circle(p[0], p[1], rad * 0.45, c); }
        else cv.circle(p[0], p[1], rad, c);
    };
    for (let i = 0; i < pts.length; i++) {
        const k = pos[i];
        if (bg && (s.dim || s.ghost)) put(pts[i], withAlpha(flash ? flashCol : col(k), s.ghost ? 0.14 : 0.16), false);
        const c = flash ? (s.blink ? flashCol : null) : k < lit ? col(k) : null;
        if (fg && c) put(pts[i], c, true);
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
    // vector: segments as outlines; a lit one also gets a faint fill
    const seg = (a, b, c) => {
        const xa = X(a) + 2, xb = X(b) - 2;
        if (!(xb > xa)) return;
        const q = [[xa + slant, barY], [xb + slant, barY], [xb, barY + barH], [xa, barY + barH]];
        if (s.outline) { cv.polyline(q.concat([q[0]]), 1.6, c); if (c !== s.trackCol) cv.quad(q, withAlpha(c, 0.22)); } else cv.quad(q, c);
    };
    const mark = (r, c) => cv.fillRect(Math.round(X(r) + slant) - 1, y, 3, markH, c);
    s.trackCol = withAlpha(P.text, s.outline ? 0.3 : 0.12);
    if (fg && isNum(s.shift) && s.shift < s.redline) mark(s.shift, P.mid);
    if (fg) mark(s.redline, P.limit);
    if (bg && (s.dim || s.outline)) for (let r = 0; r < s.redline; r += 500) seg(r, Math.min(s.redline, r + 500), s.trackCol);
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
 * The LCD bar graph in (x, y, w, h): 40 rectangular segments, lit up to the rpm (low below the shift
 * point, mid past it, high into the redline; all flashing on the limiter), unlit ones as faint
 * ghosts (vfd) or dim (setting), the red zone tinted; shift and redline marks over it, the peak as one
 * bright segment outline.
 */
function drawGraph(cv, x, y, w, h, s, vfd) {
    const bg = s.layer !== 'fg', fg = s.layer !== 'bg', P = s.P, cue = s.cue, rpm = s.rpm;
    const n = 40, gap = 2, sw = (w - gap * (n - 1)) / n, top = y + 6, sh = h - 6;
    const rpmOf = (i) => (i + 0.5) * s.max / n;
    const sx = (i) => x + i * (sw + gap);
    const at = (r) => clamp(Math.floor(r / s.max * n), 0, n - 1);
    if (fg && isNum(s.shift) && s.shift < s.redline) cv.fillRect(sx(at(s.shift)) + sw / 2 - 1, y, 3, 4, P.mid);
    if (fg) cv.fillRect(sx(at(s.redline)) + sw / 2 - 1, y, 3, 4, P.limit);
    for (let i = 0; i < n; i++) {
        const r = rpmOf(i), zone = r >= s.redline;
        if (bg && (vfd || s.dim || zone)) cv.fillRect(sx(i), top, sw, sh, withAlpha(zone ? P.limit : P.text, zone ? 0.3 : vfd ? 0.1 : 0.12));
        if (fg && isNum(rpm) && r <= rpm) {
            const c = cue.limiter ? (s.blink ? P.limit : withAlpha(P.limit, 0.35)) : zone ? P.high : r >= s.shift ? P.mid : P.low;
            cv.fillRect(sx(i), top, sw, sh, c);
        }
    }
    if (fg && isNum(s.peak) && s.peak > 0 && !(isNum(rpm) && rpm >= s.peak - 50)) {
        const i = at(s.peak);
        cv.polyline([[sx(i), top], [sx(i) + sw, top], [sx(i) + sw, top + sh], [sx(i), top + sh], [sx(i), top]], 1.5, P.peak);
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
function drawReadouts(cv, x0, x1, y, items, P, layer, clear) {
    if (!items.length) return;
    const n = items.length, colw = (x1 - x0) / Math.max(3, n), k = Math.min(1, colw / 70);
    items.forEach((it, i) => {
        const cx = x0 + colw * (i + 0.5);
        // labels: Normal 14 px nearly full brightness, Clearer 18 px full (12 px at 75 % read as specks on the
        // glass); either made smaller to fit its column, so four readouts never run into each other
        if (layer !== 'fg') {
            const lo = { align: 'center', font: 'bold', spacing: (clear ? 1.5 : 1.2) * k };
            let s = (clear ? 18 : 14) * k;
            if (cv.textWidth) { const w = cv.textWidth(it.label, s, lo); if (w > colw - 14) s = Math.max(8, s * (colw - 14) / w); }
            cv.text(it.label, cx, y + (clear ? 15 : 13), s, clear ? P.text : withAlpha(P.text, 0.9), lo);
        }
        if (layer !== 'bg') cv.text(it.value, cx, y + 40, 26 * Math.max(0.8, k), P[it.tone] || P.text, { align: 'center', font: 'bold' });
    });
}

/**
 * After an upshift: its grade across the readouts row. chip = { verdict, age (ms), burst }. Burst: the
 * word (PERFECT SHIFT for spot on) pops in big and settles in 150 ms, a ring grows from it over 500 ms
 * and fades, and the word fades over the last 300 ms of its 1.5 s.
 */
function drawChip(cv, x0, x1, y, chip, P) {
    // a chip may carry its own text and colour (the launch time: { text, tone }); the grades go by the verdict
    const c = P[chip.tone || VERDICT[chip.verdict] || 'text'] || P.text, cx = (x0 + x1) / 2;
    if (!chip.burst) { cv.text(chip.text || chip.verdict, cx, y + 36, 28, c, { align: 'center', font: 'bold', spacing: 2 }); return; }
    const a = chip.age || 0;
    const size = a < 150 ? 34 - 8 * (a / 150) : 26, alpha = a > 1200 ? clamp(1 - (a - 1200) / 300, 0, 1) : 1;
    if (a < 500) {
        // round the word, inside the image (the screen's 2x preview doesn't clip)
        const rr = Math.min(30 + 36 * (a / 500), IH - (y + 26) - 2);
        cv.arc(cx, y + 26, rr - 2, rr, 0, 360, withAlpha(c, 0.8 * (1 - a / 500)));
    }
    if (alpha > 0) cv.text(chip.text || VERDICT_TEXT[chip.verdict] || chip.verdict, cx, y + 36, size, withAlpha(c, alpha), { align: 'center', font: 'bold', spacing: 1.5 });
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
    const o = f.opts, d = f.d, P = palette(o.style === 'vfd' ? 'vfd' : o.palette), cue = f.cue;
    if (o.style === 'arc' || o.style === 'ramp' || o.style === 'dial') {
        M.drawM(cv, f, layer, { P: P, gearText: gearText, drawDown: drawDown, lightCol: lightCol, RACE_BLUE: RACE_BLUE, gearFont: gearFont });
        return;
    }
    // the gearbox mode (D / S / M) as a small letter by the gear
    if (layer !== 'bg' && f.mode && o.gear) {
        const at = o.style === 'wings' ? [IW / 2 + 34, 24] : o.style === 'digital' || o.style === 'vfd' ? [58, 22] : [56, 24];
        cv.text(f.mode, at[0], at[1], 18, withAlpha(P.text, 0.85), { font: 'bold' });
    }
    const s = { rpm: d.rpm, cue: cue, shift: f.shift, redline: f.redline, max: f.max, blink: f.blink, dim: o.dim, style: o.lightStyle, P: P, layer: layer, peak: f.peak };
    // knock on the layouts with no place for the warning (Minimal, Split wings): the gear goes red as well
    const knock = f.chip && f.chip.verdict === 'KNOCK';
    const gearCol = (cue.limiter && f.blink) || (knock && (o.style === 'minimal' || o.style === 'wings')) ? P.limit : P.text;
    const fg = layer !== 'bg';

    if (o.style === 'digital' || o.style === 'vfd') {
        // 80s digital dash / VFD: 7-segment gear on the left, square lights, a 40-segment bar graph,
        // 7-segment rpm under it, then the readouts (or the grade)
        const ghost = o.style === 'vfd' || o.dim ? withAlpha(P.text, 0.1) : null;
        if (o.lights) {
            const pts = [], n = 12, x0 = 76, w0 = IW - x0, pitch = w0 / n;
            for (let i = 0; i < n; i++) pts.push([x0 + pitch * (i + 0.5), 8]);
            drawLights(cv, pts, pts.map((p, i) => (o.gt3 ? Math.min(i, 11 - i) : i)), o.gt3 ? 6 : 12, 6, Object.assign({}, s, { shape: 'rect', ghost: o.style === 'vfd' }));
        }
        if (o.bar !== false) drawGraph(cv, 76, 18, IW - 76, 36, s, o.style === 'vfd');
        if (o.gear) seg7(cv, gearText(d).slice(0, 1), 4, 10, 50, 86, 9, gearCol, ghost, false, layer);
        if (fg) drawDown(cv, 29, 106, f.down || 0, 1, P.arrow);
        const rpmTxt = isNum(d.rpm) && d.rpm < 9995 ? String(Math.max(0, Math.round(d.rpm / 10) * 10)).padStart(4, ' ') : '----';
        if (o.rpm !== false) seg7text(cv, rpmTxt, 76, 64, 16, 30, 4, 5, P.text, ghost, false, layer);
        if (f.chip) { if (fg) drawChip(cv, 166, IW, 62, f.chip, P); } else drawReadouts(cv, 166, IW, 62, f.readouts || [], P, layer, o.clearLabels);
        return;
    }

    if (o.style === 'wings') {
        // gear centred, 6 lights each side filling towards it (outermost first), the bar underneath
        if (o.lights) {
            const pts = [], pos = [], d0 = 16;
            for (let i = 0; i < 6; i++) { pts.push([14 + i * 26, 30]); pos.push(i); }
            for (let i = 0; i < 6; i++) { pts.push([IW - 14 - i * 26, 30]); pos.push(i); }
            drawLights(cv, pts, pos, 6, d0 / 2, s);
        }
        if (o.bar !== false) drawBar(cv, 0, 84, IW, 40, s);
        if (fg) {
            if (o.gear) cv.text(gearText(d), IW / 2, 70, 72, gearCol, { align: 'center', font: gearFont(o) });
            drawDown(cv, IW / 2 + 52, 34, f.down || 0, 1, P.arrow);
        }
        return;
    }

    const tx = o.gear ? 70 : 0, tw = IW - tx;
    if (o.style === 'vector') {
        // the standard layout in outline: rings, outlined segments, an outlined 7-segment gear
        s.outline = true; s.shape = 'ring';
        if (o.gear) seg7(cv, gearText(d).slice(0, 1), 8, 12, 44, 72, 8, gearCol, withAlpha(P.text, 0.12), true, layer);
        if (fg) drawDown(cv, 30, 92, f.down || 0, 1, P.arrow);
    } else if (fg && o.gear) {
        cv.text(gearText(d), 30, 78, 72, gearCol, { align: 'center', font: gearFont(o) });
        drawDown(cv, 30, 90, f.down || 0, 1, P.arrow);
    }
    if (o.style === 'minimal') {
        // bigger lights only, centred on the gear's height
        if (o.lights) {
            const r = lightsRow(tx, 26, tw, 22);
            drawLights(cv, r.pts, r.pts.map((p, i) => (o.gt3 ? Math.min(i, 11 - i) : i)), o.gt3 ? 6 : 12, r.rad, s);
        }
        // the knock warning in the room under the lights (Minimal shows no grades)
        if (fg && knock) cv.text('KNOCK', tx + tw / 2, 100, 26, P.limit, { align: 'center', font: 'bold', spacing: 2 });
        return;
    }

    // standard (and vector): lights, bar, readouts or a shift grade
    if (o.lights) {
        const r = lightsRow(tx, 2, tw, 14);
        drawLights(cv, r.pts, r.pts.map((p, i) => (o.gt3 ? Math.min(i, 11 - i) : i)), o.gt3 ? 6 : 12, r.rad, s);
    }
    if (o.bar !== false) drawBar(cv, tx, o.lights ? 20 : 2, tw, o.lights ? 38 : 56, s);
    if (f.chip) { if (fg) drawChip(cv, TEMP_X, IW, 66, f.chip, P); } else drawReadouts(cv, TEMP_X, IW, 66, f.readouts || [], P, layer, o.clearLabels);
}

/** The key of the static ('bg') layer: what it depends on. */
function bgKey(f) {
    const o = f.opts, c = f.cue;
    return [o.style, o.style === 'vfd' ? 'vfd' : o.palette, o.gear, o.rpm, o.bar, o.lights, o.gt3, o.dim, o.lightStyle, o.clearLabels, f.redline, f.max, c.shift || c.limiter, c.limiter,
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
    // redline shake: f.shake = [dx, dy] moves the whole picture a few px (on the limiter)
    if (f.shake && (f.shake[0] || f.shake[1]) && cv.d) {
        if (!shakeBuf || shakeBuf.d.length !== cv.d.length) shakeBuf = new Canvas(IW, IH);
        shakeBuf.d.set(cv.d);
        cv.clear();
        cv.blit(shakeBuf, f.shake[0], f.shake[1]);
    }
}
let shakeBuf = null;

/**
 * A drawing surface that scales by k and moves by (ox, oy) on the way to r: the HUD's drawing at
 * another size on the screen (the software renderer doesn't do the Recorder's xf transform).
 */
function scaled(r, k, ox, oy) {
    const X = (x) => ox + x * k, Y = (y) => oy + y * k, P = (pts) => pts.map((p) => [X(p[0]), Y(p[1])]);
    return {
        circle: (cx, cy, rad, c) => r.circle(X(cx), Y(cy), rad * k, c),
        arc: (cx, cy, r0, r1, a0, a1, c) => r.arc(X(cx), Y(cy), r0 * k, r1 * k, a0, a1, c),
        fillRect: (x, y, w, h, c) => r.fillRect(X(x), Y(y), w * k, h * k, c),
        quad: (pts, c) => r.quad(P(pts), c),
        polyline: (pts, w, c) => r.polyline(P(pts), w * k, c),
        line: (xa, ya, xb, yb, w, c) => r.line(X(xa), Y(ya), X(xb), Y(yb), w * k, c),
        text: (s, x, y, size, c, o) => r.text(s, X(x), Y(y), size * k, c, o && o.spacing ? Object.assign({}, o, { spacing: o.spacing * k }) : o),
        textWidth: (s, size, o) => r.textWidth(s, size * k, o && o.spacing ? Object.assign({}, o, { spacing: o.spacing * k }) : o) / k,
    };
}

module.exports = { scaled, lightCol, gearFont, drawHud, drawLayer, drawLights, drawBar, drawGraph, drawDown, drawReadouts, drawChip, seg7, gearText, PALETTES, IW, IH, TEMP_X };
