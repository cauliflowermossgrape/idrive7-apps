'use strict';

// Redline HUD: the Recovery / Power meter (a readout with .bar = { v, lo, hi }, kW: + the battery drives, - it recovers).
//   node kit/tools/test_redline_powerbar.js
// - the fill: recovery left of the zero (in the palette's low colour), drive right of it (text colour, warm near hi),
//   nothing at 0, held at the ends beyond lo / hi; the zero a third of the way across for -40..80;
// - the layers: outline, zero tick, label and REC on bg (the same whatever v), the fill and value on fg; the cached
//   static layer is redrawn when the bar appears, goes or changes width;
// - wide: two columns while the row has room, one in a full row;
// - standard, digital and the M layouts (a thin bar under a row readout; the big readout falls back to label + value);
// - the other readouts draw as before.

const path = require('path');
const TH = require('./redline_test_harness');
const ROOT = TH.ROOT;
TH.hookKit();
const Draw = require(path.join(ROOT, 'apps', 'redline', 'hud-draw'));
const { Canvas, rgba } = require(path.join(ROOT, 'kit', 'runtime', 'canvas'));

const tally = TH.counter(), ok = tally.ok;
const P = Draw.PALETTES.colour;

const pw = (v, wide, value) => ({ label: 'POWER', value: value || '+12', tone: 'text', bar: { v: v, lo: -40, hi: 80 }, wide: wide !== false });
const OIL = { label: 'OIL', value: '95°', tone: 'text' }, WAT = { label: 'WATER', value: '90°', tone: 'text' }, BO = { label: 'BOOST', value: '1.2', tone: 'text' };
const opts = (style, over) => Object.assign({ style: style, palette: 'colour', gear: true, rpm: true, bar: true, lights: true, gt3: true, dim: false,
    lightStyle: 'm', clearLabels: false, gearFont: 'ubuntu' }, over || {});
const frame = (style, readouts, over) => ({
    d: { rpm: 4200, gear: 3, stage: 'D' }, shift: 5550, redline: 6550, max: 8000, blink: true, down: 0, peak: 0, chip: null,
    cue: { from: 4400, at: 5550, shift: false, limiter: false }, readouts: readouts, mode: null, opts: opts(style, over),
});
function layer(f, l) { const cv = new Canvas(Draw.IW, Draw.IH); Draw.drawLayer(cv, f, l); return cv; }
function hud(f, before) { const cv = new Canvas(Draw.IW, Draw.IH); if (before) Draw.drawHud(cv, before); Draw.drawHud(cv, f); return cv; }
const same = (a, b) => Buffer.from(a.d).equals(Buffer.from(b.d));
const px = (cv, x, y) => { const i = (Math.round(y) * cv.w + Math.round(x)) * 4; return [cv.d[i], cv.d[i + 1], cv.d[i + 2], cv.d[i + 3]]; };
/** The pixels that differ between a and b (in rows y0..y1): { n, minX, maxX, cols: colours at those pixels in a }. */
function diff(a, b, y0, y1) {
    const r = { n: 0, minX: 1e9, maxX: -1, cols: [] };
    for (let y = y0; y <= y1; y++) for (let x = 0; x < a.w; x++) {
        const i = (y * a.w + x) * 4;
        if (a.d[i] !== b.d[i] || a.d[i + 1] !== b.d[i + 1] || a.d[i + 2] !== b.d[i + 2] || a.d[i + 3] !== b.d[i + 3]) {
            r.n++; r.minX = Math.min(r.minX, x); r.maxX = Math.max(r.maxX, x); r.cols.push([a.d[i], a.d[i + 1], a.d[i + 2], a.d[i + 3]]);
        }
    }
    return r;
}
/** Is colour c (a full pixel) the colour col? */
const isCol = (c, col) => { const v = rgba(col); return c[3] === 255 && Math.abs(c[0] - v[0]) <= 2 && Math.abs(c[1] - v[1]) <= 2 && Math.abs(c[2] - v[2]) <= 2; };
const mostly = (cols, col) => cols.length > 0 && cols.filter((c) => isCol(c, col)).length >= cols.length * 0.6;

/*
 * Where the bar is: the readouts row from x0 at y (standard 150 / 66, digital 166 / 62, both to 400); the power
 * column's track 6 px in from its edges, y + 47 .. y + 57; the zero a third of the way along for -40..80.
 * M layouts: a row readout at (x, y), w wide, the bar y + 4 .. y + 10.
 */
function geo(x0, y, cellX, cellW) { const bx = cellX + 6, bw = cellW - 12; return { bx: bx, bw: bw, z: bx + bw / 3, t0: y + 47, t1: y + 57 }; }
const CASES = [
    // [name, style, readouts(v), geometry, layered (bg / fg split)]
    ['standard wide', 'standard', (v) => [pw(v), OIL, WAT], geo(150, 66, 150, 125), true],
    ['standard narrow', 'standard', (v) => [pw(v, false), OIL, WAT], geo(150, 66, 150, 250 / 3), true],
    ['standard 4 items (wide kept to one column)', 'standard', (v) => [OIL, pw(v), WAT, BO], geo(150, 66, 150 + 62.5, 62.5), true],
    ['digital wide', 'digital', (v) => [pw(v), OIL], geo(166, 62, 166, 2 * 234 / 3), true],
    ['vfd wide', 'vfd', (v) => [pw(v), OIL, WAT], geo(166, 62, 166, 117), true],
    ['ramp row', 'ramp', (v) => [BO, pw(v), OIL, WAT], { bx: 284, bw: 112, z: 284 + 112 / 3, t0: 70, t1: 76 }, false],
    ['dial row', 'dial', (v) => [OIL, pw(v), WAT], { bx: 284, bw: 112, z: 284 + 112 / 3, t0: 34, t1: 40 }, false],
];

CASES.forEach((c) => {
    const name = c[0], style = c[1], ro = c[2], g = c[3], split = c[4];
    const pal = style === 'vfd' ? Draw.PALETTES.vfd : P;
    const fgL = split ? 'fg' : 'both';
    const at = (v) => layer(frame(style, ro(v)), fgL), mid0 = Math.ceil(g.t0 + 2), mid1 = Math.floor(g.t1 - 2.5);
    const zero = at(0);
    // v 0: nothing in the track (fg; on the M layouts where all is fg, the same as the bar's static parts alone)
    if (split) {
        let lit = 0;
        for (let y = mid0; y <= mid1; y++) for (let x = Math.ceil(g.bx + 2); x < g.bx + g.bw - 2; x++) if (px(zero, x, y)[3]) lit++;
        ok(lit === 0, name + ': v 0 fills nothing (' + lit + ' px lit in the track)');
    } else {
        const nan = layer(frame(style, ro(NaN)), fgL);
        ok(same(zero, nan), name + ': v 0 fills nothing (the same as no reading)');
    }
    // recovery: left of the zero, in the palette's low colour, as far as -20 maps (half way to lo)
    const rec = diff(at(-20), zero, mid0, mid1);
    ok(rec.n > 0 && rec.maxX < g.z && mostly(rec.cols, pal.low), name + ': -20 kW fills left of the zero in low (' + rec.n + ' px, x ' + rec.minX + '..' + rec.maxX + ', zero ' + g.z.toFixed(1) + ')');
    ok(Math.abs(rec.minX - (g.z - (g.z - g.bx) / 2)) <= 2, name + ': -20 kW reaches half way to lo (x ' + rec.minX + ', expected ' + (g.z - (g.z - g.bx) / 2).toFixed(1) + ')');
    // drive: right of the zero in the text colour, to where +40 maps (half way to hi)
    const drv = diff(at(40), zero, mid0, mid1);
    ok(drv.n > 0 && drv.minX > g.z && mostly(drv.cols, style === 'ramp' ? '#f4f1e6' : style === 'dial' ? '#ff5a2e' : pal.text), name + ': +40 kW fills right of the zero in the text colour (' + drv.n + ' px, x ' + drv.minX + '..' + drv.maxX + ')');
    ok(Math.abs(drv.maxX - (g.z + (g.bx + g.bw - g.z) / 2)) <= 2, name + ': +40 kW reaches half way to hi (x ' + drv.maxX + ', expected ' + (g.z + (g.bx + g.bw - g.z) / 2).toFixed(1) + ')');
    // near hi: warm
    const top = diff(at(78), zero, mid0, mid1);
    ok(mostly(top.cols, pal.warm), name + ': +78 kW (near hi) fills in warm');
    // beyond the ends: held there, inside the track
    ok(same(at(-100), at(-40)), name + ': -100 kW draws as lo (-40)');
    ok(same(at(500), at(80)), name + ': 500 kW draws as hi (80)');
    const full = diff(at(80), zero, mid0, mid1), empty = diff(at(-40), zero, mid0, mid1);
    ok(full.maxX <= g.bx + g.bw && empty.minX >= g.bx, name + ': the fill stays inside the track at the ends (' + empty.minX + '..' + full.maxX + ' in ' + g.bx.toFixed(1) + '..' + (g.bx + g.bw).toFixed(1) + ')');
    // the static parts: zero tick (over and under the track) and the outline
    const st = split ? layer(frame(style, ro(-20)), 'bg') : zero;
    ok(px(st, g.z, g.t0 - 1)[3] > 0 && px(st, g.z, g.t1 + 1)[3] > 0, name + ': the zero tick shows over and under the track');
    ok(px(st, g.bx + g.bw * 0.8, g.t0 + 0.5)[3] > 0 && (px(st, Math.floor(g.bx), (g.t0 + g.t1) / 2)[3] > 0 || px(st, Math.floor(g.bx) + 1, (g.t0 + g.t1) / 2)[3] > 0), name + ': the track is outlined');
    if (split) {
        ok(same(layer(frame(style, ro(-20)), 'bg'), layer(frame(style, ro(65)), 'bg')), name + ': the bg layer is the same whatever v');
        ok(px(layer(frame(style, ro(-20)), 'fg'), g.z, g.t0 - 1)[3] === 0, name + ': the zero tick is not on the fg layer');
        // the whole picture as the app draws it: bg cached, fg over it
        const h = hud(frame(style, ro(-20)));
        ok(diff(h, hud(frame(style, ro(0))), mid0, mid1).maxX < g.z && px(h, g.z, g.t0 - 1)[3] > 0, name + ': drawHud: fill and zero tick');
    }
});

/* ---------- wide ---------- */
{
    // [POWER wide, OIL, WATER] takes 4 columns' room: OIL and WATER where a 4-item row has its last two
    const wide = layer(frame('standard', [pw(-20), OIL, WAT]), 'both'), four = layer(frame('standard', [BO, BO, OIL, WAT]), 'both');
    ok(diff(wide, four, 66, 129).minX >= 150 && diff(wide, four, 66, 129).maxX < 275, 'wide: OIL and WATER as in a four-item row, the bar in the first two columns');
    // not wide: OIL and WATER where a 3-item row has them
    const narrow = layer(frame('standard', [pw(-20, false), OIL, WAT]), 'both'), three = layer(frame('standard', [BO, OIL, WAT]), 'both');
    ok(diff(narrow, three, 66, 129).maxX < 150 + 250 / 3, 'not wide: OIL and WATER as in a three-item row');
    // a full row: wide is ignored
    ok(same(layer(frame('standard', [OIL, pw(5), WAT, BO]), 'both'), layer(frame('standard', [OIL, pw(5, false), WAT, BO]), 'both')), 'wide: a full row keeps the bar in one column');
    // two items: the bar two columns wide, OIL in the third
    const two = layer(frame('standard', [pw(-20), OIL]), 'both'), twoN = layer(frame('standard', [BO, BO, OIL]), 'both');
    ok(diff(two, twoN, 66, 129).maxX < 150 + 2 * 250 / 3, 'wide: with two items OIL in the third column');
}

/* ---------- the cached static layer follows the bar ---------- */
{
    const plain = frame('standard', [{ label: 'POWER', value: '+12', tone: 'text' }, OIL, WAT]);
    const withBar = frame('standard', [pw(-20), OIL, WAT]), narrow = frame('standard', [pw(-20, false), OIL, WAT]);
    const lo50 = frame('standard', [{ label: 'POWER', value: '+12', tone: 'text', bar: { v: -20, lo: -50, hi: 80 }, wide: true }, OIL, WAT]);
    const other = frame('standard', [BO]);
    ok(same(hud(withBar, plain), hud(withBar, other)), 'drawHud: the bar appearing redraws the static layer');
    ok(same(hud(plain, withBar), hud(plain, other)), 'drawHud: the bar going redraws the static layer');
    ok(same(hud(narrow, withBar), hud(narrow, other)) && same(hud(withBar, narrow), hud(withBar, other)), 'drawHud: wide changing redraws the static layer');
    ok(same(hud(lo50, withBar), hud(lo50, other)), 'drawHud: the range changing (the zero moves) redraws the static layer');
    ok(!same(hud(withBar, other), hud(narrow, other)), 'drawHud: wide and not wide differ');
}

/* ---------- M layouts: the big readout falls back to label + value; arc's bottom row has no room ---------- */
['arc', 'ramp', 'dial'].forEach((st) => {
    const a = layer(frame(st, [pw(-20), OIL, WAT]), 'both'), b = layer(frame(st, [{ label: 'POWER', value: '+12', tone: 'text' }, OIL, WAT]), 'both');
    ok(same(a, b), st + ': the first (big) readout shows label + value only');
});
ok(same(layer(frame('arc', [OIL, BO, pw(-20)]), 'both'), layer(frame('arc', [OIL, BO, { label: 'POWER', value: '+12', tone: 'text' }]), 'both')), 'arc: no bar under the bottom row (no room)');
ok(!same(layer(frame('arc', [OIL, pw(-20), BO]), 'both'), layer(frame('arc', [OIL, { label: 'POWER', value: '+12', tone: 'text' }, BO]), 'both')), 'arc: a bar under the upper row');
ok(!same(layer(frame('arc', [OIL, BO, WAT, pw(-20)]), 'both'), layer(frame('arc', [OIL, BO, WAT, { label: 'POWER', value: '+12', tone: 'text' }]), 'both')), 'arc: a bar under the stacked readout');

/* ---------- the other readouts: as before ---------- */
['standard', 'digital', 'vector', 'vfd'].forEach((st) => ['bg', 'fg'].forEach((l) => {
    // the columns after a (narrow) power readout are where they'd be after any other readout
    const a = layer(frame(st, [pw(-20, false), OIL, WAT]), l), b = layer(frame(st, [BO, OIL, WAT]), l);
    const x0 = st === 'digital' || st === 'vfd' ? 166 : 150, colw = (400 - x0) / 3;
    ok(diff(a, b, 0, 129).maxX < x0 + colw, st + ' ' + l + ': the readouts beside the bar draw as before');
    // wide on an item without a bar means nothing
    ok(same(layer(frame(st, [Object.assign({ wide: true }, BO), OIL]), l), layer(frame(st, [BO, OIL]), l)), st + ' ' + l + ': wide without a bar changes nothing');
}));
['arc', 'ramp', 'dial'].forEach((st) => {
    const a = layer(frame(st, [OIL, pw(-20), WAT, BO]), 'both'), b = layer(frame(st, [OIL, { label: 'POWER', value: '+12', tone: 'text' }, WAT, BO]), 'both');
    const d = diff(a, b, 0, 129);
    ok(d.n > 0 && d.minX >= 280, st + ': only the bar under its row differs (x ' + d.minX + '..' + d.maxX + ')');
});

console.log(tally.checks + ' checks, ' + tally.fails + ' failed');
process.exit(tally.fails ? 1 : 0);
