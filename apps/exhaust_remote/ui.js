'use strict';
/**
 * ui.js - the Exhaust Remote screen, a PURE draw(cv, G, t, v, act) so it renders both on the car (main.js) and in the
 * PC preview / emulator.
 *
 * House style of the other apps: the "Exhaust Flap" tab up top, the rear silencer in the middle (one silencer, two
 * tailpipes; the flap is in the RIGHT one, as on the car, its butterfly turning in the bore), smoke out of the left
 * tailpipe always and out of the right one as far as the flap is open, the big state word, the status line, and the
 * four buttons (Open / Close / OEM / Drive mode) across the bottom, the selected one filled red (drawn with G.button;
 * the HMI bar is hidden in main.js). `act` carries the press callbacks.
 *
 * GPU-safe: the picture is a cached layer (muffler_img.js), the rest circles, convex quads, lines and text.
 */

const IMG = require('./muffler_img');
const L10N = require('./l10n');
const { Canvas } = require('./kit/canvas');
const { getLanguage } = require('./kit/i18n');

const W = 1600, H = 520;
const PAGES = ['Exhaust Flap'];
// fixed-language builds (build.py --language ko | zh-CN | ru): the status line and buttons come from l10n.js
const LANG = getLanguage();
const LOCAL = LANG !== 'en' && !!L10N.WORDS[LANG];

function draw(cv, G, t, v, act) {
    cv.clear(t.bg);
    G.frame(cv, t, PAGES, 0, [v.simulated ? { text: 'SIM', color: t.warn || '#d29922' } : null]);

    // the house content panel over the whole content area (it extends down by cv.extra to the screen's bottom)
    G.panel(cv, t, 24, G.TOP, W - 48, G.BOTTOM - G.TOP, null);
    // the panel's real bottom: the word and buttons sit on it, the picture takes the room above them; the buttons
    // (where the kit runs the screen) end G.MARGIN over it, as the other apps' last lines
    const bottom = G.pageBottom(cv) - (cv.own ? G.MARGIN : 0);

    drawMuffler(cv, G, t, 100, G.TOP + 12, W - 200, bottom - 142 - G.TOP, v);

    // the state word (big), centred below the picture
    const word = v.confirmed !== 'UNKNOWN' ? v.confirmed : v.requested;
    const col = word === 'OPEN' ? (t.accent2 || '#81c4ff') : word === 'CLOSED' ? (t.crit || '#ef2b2d') : t.text;
    cv.text(word, W / 2, bottom - 96, 48, col, { align: 'center', font: 'bold', spacing: 2 });

    // only a genuine safety block speaks up; a timeout / no answer (car asleep) shows nothing, nor "sending..."
    if (v.error) {
        cv.text('! ' + v.error, W / 2, bottom - 64, 14, t.crit, { align: 'center', font: 'label' });
    } else if (v.note) {
        // DRIVE MODE's driving mode, the Close rpm pause or the no-rpm fail-safe, hold: one line under the word
        cv.text(LOCAL ? L10N.note(LANG, v.note.text) : v.note.text, W / 2, bottom - 64, 17,
            v.note.warn ? (t.warn || '#d29922') : t.dim, { align: 'center', font: 'label', literal: LOCAL });
    }

    drawButtons(cv, G, t, v, act, bottom);
    return cv;
}

/** Open · Close · OEM · Drive mode across the bottom; the selected one (v.selected, else v.requested) filled red. */
function drawButtons(cv, G, t, v, act, bottom) {
    act = act || {};
    const modes = [
        { k: 'OPEN', label: 'Open', run: act.open },
        { k: 'CLOSED', label: 'Close', run: act.close },
        { k: 'OEM', label: 'OEM', run: act.oem },
        { k: 'DRIVE', label: 'Drive mode', run: act.drive },      // follow the driving mode (auto.js)
    ];
    const bw = 236, bh = 56, gap = 30, by = bottom - 56;
    let bx = (W - (modes.length * bw + (modes.length - 1) * gap)) / 2;
    for (const m of modes) {
        const on = m.k === (v.selected || v.requested);
        const busy = !!v.busy && m.k !== 'OEM';     // OEM stays pressable: it is queued, never dropped
        const opts = on
            ? { color: t.crit || '#ef2b2d', primary: true, key: 'er_' + m.k, busy }   // selected = red
            : { key: 'er_' + m.k, busy };                                             // others = outline
        G.button(cv, t, bx, by, bw, bh, LOCAL ? L10N.button(LANG, m.k, m.label) : m.label, m.run || (() => {}), opts);
        bx += bw + gap;
    }
}

/**
 * The silencer, cut out (the panel shows through), centred in x, y, w, h; the flap's butterfly in the RIGHT tailpipe,
 * smoke out of the left one always and out of the right one as far as the flap is open.
 * v.angle: 0 = shut .. 1 = open (eased in main.js).
 */
function drawMuffler(cv, G, t, x, y, w, h, v) {
    const open = v.angle == null ? (v.confirmed === 'OPEN' ? 1 : 0) : Math.max(0, Math.min(1, v.angle));
    // the picture: a cached layer (drawn once into a texture, one blit a frame), at its own size
    const ix = Math.round(x + (w - IMG.LW) / 2), iy = Math.round(y + Math.max(0, (h - IMG.LH) / 2));
    const pic = G.layer('exhaust_remote_muffler', IMG.LW, IMG.LH, (c) => IMG.draw(c), cv.textScale);
    // the software renderer would play the layer's shaded triangles in flat colours: it gets the picture as pixels
    // instead (made the first time it asks; the GPU never reads pic.soft)
    if (!pic.mufflerSoft) {
        let px = null;
        Object.defineProperty(pic, 'soft', {
            configurable: true, enumerable: true,
            get() { if (!px) px = IMG.soft(new Canvas(pic.w, pic.h)); return px; },
            set(s) { px = s; },
        });
        pic.mufflerSoft = true;
    }
    cv.blit(pic, ix, iy);
    const L = IMG.BORES.left, R = IMG.BORES.right;
    const rx = ix + R.c[0], ry = iy + R.c[1], lx = ix + L.c[0], ly = iy + L.c[1];
    flapPlate(cv, G, rx, ry, R.a, R.b, R.rot, open);
    const ts = Date.now() / 1000;
    smoke(cv, G, lx, ly, -1, 1, ts, 0.0);
    smoke(cv, G, rx, ry, 1, open, ts, 0.37);
}

/** The butterfly in an elliptic bore (centre cx, cy; semi-axes a along, b across; tilt rot deg): shut it fills the
 * bore, opening it turns about the shaft across the bore and narrows to a sliver. Convex quads only (GPU-safe). */
function flapPlate(cv, G, cx, cy, a, b, rot, open) {
    const ws = Math.max(0.07, Math.cos(open * Math.PI / 2));
    const cr = Math.cos(rot * Math.PI / 180), sr = Math.sin(rot * Math.PI / 180);
    const P = (u, w) => [cx + u * cr - w * sr, cy + u * sr + w * cr];
    const N = 24, ea = a * 0.94 * ws, eb = b * 0.94;
    // the wedges overlap by half a step: no seam where two meet (software draws each edge soft)
    const ell = (sa, sb, ox, oy, col) => {
        for (let i = 0; i < N; i++) {
            const t0 = i * 2 * Math.PI / N, t1 = t0 + 1.5 * Math.PI / N, t2 = t0 + 3 * Math.PI / N;
            cv.quad([P(ox, oy), P(ox + Math.cos(t0) * sa, oy + Math.sin(t0) * sb), P(ox + Math.cos(t1) * sa, oy + Math.sin(t1) * sb),
                P(ox + Math.cos(t2) * sa, oy + Math.sin(t2) * sb)], col);
        }
    };
    ell(ea, eb, 0, 0, '#8e959e');                                         // the plate
    ell(ea * 0.55, eb * 0.45, -ea * 0.18, -eb * 0.32, '#a7acb3');            // sheen (the plate + 22 % white, opaque)
    const s0 = P(0, -b * 0.97), s1 = P(0, b * 0.97);
    cv.line(s0[0], s0[1], s1[0], s1[1], 2.5, G.withAlpha('#20242b', 0.9));           // the shaft
    const c0 = P(0, 0);
    cv.circle(c0[0], c0[1], 3.2, '#1a1e24');
}

/** Exhaust smoke out of a tailpipe at ox, oy: puffs that drift outward (dir -1 left / 1 right), rise, grow and fade.
 * amt 0..1 = how much; a function of the time only, so every frame of the loop moves it on. */
function smoke(cv, G, ox, oy, dir, amt, ts, seed) {
    if (amt < 0.04) return;
    const N = 10, period = 2.4;
    for (let i = 0; i < N; i++) {
        const p = ((ts / period + i / N + seed) % 1 + 1) % 1;
        const x = ox + dir * (24 + p * 150) + Math.sin(ts * 1.7 + i * 1.3) * 7 * p;
        const y = oy + (p * 18 - p * p * 95);
        const r = 7 + p * 40;
        const al = amt * 0.42 * (1 - p) * Math.min(1, p * 5);
        if (al < 0.004) continue;
        cv.circle(x, y, r, G.withAlpha('#d8dce2', al * 0.45));
        cv.circle(x - r * 0.12, y - r * 0.1, r * 0.66, G.withAlpha('#e6e9ee', al * 0.55));
        cv.circle(x - r * 0.18, y - r * 0.16, r * 0.36, G.withAlpha('#f2f4f7', al * 0.6));
    }
}

module.exports = { draw, W, H };
