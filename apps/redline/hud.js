'use strict';
/**
 * Redline on the head-up display, through cluster-render (robertnisipeanu/idrive-apps,
 * native/cluster-render): one image layer on its 'hud' target, an 800x480 scene the KOMBI
 * lays over BMW's own HUD content (speed, limit sign, guidance stay in their own slots).
 *
 *   - Dark pixels are see-through on the HUD glass: everything is drawn on black (alpha 0),
 *     lit things at full brightness; mid-tones glow as smudges.
 *   - cluster-render gives way to BMW's HUD pop-ups by itself; this module only logs the
 *     target's state, including 'disabled' from its mapping guard.
 *   - Never throws: an uncaught error exits the app, MainApp's CorruptAppsHandler wipes an
 *     app's data on its first crash and uninstalls it on the second.
 *
 * Setting "hud": off | test (an 800x480 test pattern: rulers, inset frames and a sample bar,
 * to see how much of the scene the glass shows).
 */
const { Canvas, withAlpha } = require('./kit/canvas');
let ClusterRender = null;
try { ClusterRender = require('./cluster_render_client').ClusterRender; } catch (e) { /* logged at start */ }

const SCENE_W = 800, SCENE_H = 480;
const WHITE = '#ffffff', GREEN = '#2fd27a', YELLOW = '#ffc21a', RED = '#ff2a2a', CYAN = '#22e0ff', MAGENTA = '#ff3df0';
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const isNum = (x) => typeof x === 'number' && isFinite(x);

/** Canvas.d is a Uint8Array; the client copies from a Buffer (px.copy). Same memory, no copy. */
const asBuffer = (u8) => Buffer.from(u8.buffer, u8.byteOffset, u8.length);

/**
 * The HUD tach in the box (x, y, w, h): 12 shift lights over the bar, the bar in 500 rpm
 * segments green -> yellow -> red up to the shift point (all red past it), the red zone from
 * the redline dimmed, and the gear at the right end. s = { rpm, shift, redline, max, gear }
 * (gear: a string such as '3', 'D', 'N', 'R', 'P').
 */
function drawTach(cv, x, y, w, h, s) {
    const gw = Math.round(h * 0.8), bw = w - gw - 16;            // gear box at the right end
    const ledH = Math.round(h * 0.2), barY = y + ledH + Math.round(h * 0.12), barH = h - (barY - y);
    const n = 12, range = 2000, gap = 6, lw = (bw - gap * (n - 1)) / n;
    const rpm = s.rpm, shiftNow = isNum(rpm) && rpm >= s.shift;
    const ledCol = (i) => { const f = i / (n - 1); return f < 0.42 ? GREEN : f < 0.75 ? YELLOW : RED; };
    const lit = isNum(rpm) ? clamp((rpm - (s.shift - range)) / range, 0, 1) * n : 0;
    for (let i = 0; i < n; i++) {
        const c = shiftNow ? RED : i < lit ? ledCol(i) : null;
        if (c) cv.roundRect(x + i * (lw + gap), y, lw, ledH, 4, c);
    }
    // bar: 500 rpm segments, slanted like Redline's
    const slant = Math.round(barH * 0.35), X = (r) => x + clamp(r / s.max, 0, 1) * (bw - slant);
    const seg = (a, b, c) => {
        const xa = X(a) + 2, xb = X(b) - 2;
        if (xb > xa) cv.quad([[xa + slant, barY], [xb + slant, barY], [xb, barY + barH], [xa, barY + barH]], c);
    };
    for (let r = s.redline; r < s.max; r += 500) seg(r, Math.min(s.max, r + 500), withAlpha(RED, 0.45));
    if (isNum(rpm)) {
        const top = Math.min(rpm, s.max);
        for (let r = 0; r < top; r += 500) {
            const f = (r + 250) / s.shift;
            seg(r, Math.min(top, r + 500), shiftNow || f >= 0.92 ? RED : f >= 0.7 ? YELLOW : GREEN);
        }
    }
    cv.text(s.gear, x + w - gw / 2, y + h, Math.round(h * 1.05), shiftNow ? RED : WHITE, { align: 'center', font: 'gear' });
}

/** 800x480 test pattern: border, rulers every 40 px with labels, inset frames at 40/80/120, a sample bar. */
function drawTestPattern(cv) {
    cv.clear([0, 0, 0, 0]);
    const frame = (i, c) => {
        const w = SCENE_W - 2 * i, h = SCENE_H - 2 * i;
        cv.fillRect(i, i, w, 2, c); cv.fillRect(i, i + h - 2, w, 2, c);
        cv.fillRect(i, i, 2, h, c); cv.fillRect(i + w - 2, i, 2, h, c);
    };
    frame(0, WHITE);
    [[40, CYAN], [80, MAGENTA], [120, YELLOW]].forEach((f) => {
        frame(f[0], f[1]);
        cv.text(String(f[0]), f[0] + 6, f[0] + 22, 18, f[1], { font: 'bold' });
    });
    // rulers: x along the top and bottom, y down both sides
    for (let x = 0; x <= SCENE_W; x += 40) {
        const major = x % 200 === 0, len = major ? 24 : 12;
        cv.fillRect(clamp(x - 1, 0, SCENE_W - 2), 0, 2, len, WHITE);
        cv.fillRect(clamp(x - 1, 0, SCENE_W - 2), SCENE_H - len, 2, len, WHITE);
        if (major && x > 0 && x < SCENE_W) cv.text(String(x), x, 44, 16, WHITE, { align: 'center', font: 'bold' });
    }
    for (let y = 0; y <= SCENE_H; y += 40) {
        const major = y % 120 === 0, len = major ? 24 : 12;
        cv.fillRect(0, clamp(y - 1, 0, SCENE_H - 2), len, 2, WHITE);
        cv.fillRect(SCENE_W - len, clamp(y - 1, 0, SCENE_H - 2), len, 2, WHITE);
        if (major && y > 0 && y < SCENE_H) cv.text(String(y), 30, y + 6, 16, WHITE, { font: 'bold' });
    }
    // centre cross
    cv.fillRect(SCENE_W / 2 - 20, SCENE_H / 2 - 1, 40, 2, WHITE);
    cv.fillRect(SCENE_W / 2 - 1, SCENE_H / 2 - 20, 2, 40, WHITE);
    // sample tach just under the 120 frame: 6300 rpm in 3rd, petrol profile (shift 6700, red 7000, scale 8000)
    drawTach(cv, 140, 140, 520, 90, { rpm: 6300, shift: 6700, redline: 7000, max: 8000, gear: '3' });
}

/**
 * Start the HUD output. Returns { stop }. ctx: the app's ctx (settings, log).
 */
function start(ctx) {
    const settings = ctx.settings, log = ctx.log;
    let cr = null, layer = 0, shown = '', lastTarget = '';

    const safe = (name, fn) => function () {
        try { return fn.apply(null, arguments); } catch (e) { log.error('hud ' + name + ': ' + (e && e.stack || e)); }
    };
    const mode = () => settings.get('hud') || 'off';

    const connect = safe('connect', () => {
        if (cr) return;
        if (!ClusterRender) { log.warn('hud: cluster_render_client.js is missing from the app'); return; }
        cr = new ClusterRender('redline');
        cr.on('ready', safe('ready', () => log.info('hud: connected to cluster-render (' + cr.backend + ', targets ' + cr.targets + ')')));
        cr.on('disconnected', safe('disconnected', () => log.warn('hud: cluster-render went away, reconnecting')));
        cr.on('target', safe('target', (name, state, holder, reason, guideDisabled, disabled) => {
            if (name !== 'hud') return;
            const s = disabled ? 'disabled by the mapping guard (as root: cluster-render guard-reset)'
                : state + (holder ? ' behind ' + holder : '') + (reason ? ' (' + reason + ')' : '');
            if (s !== lastTarget) { lastTarget = s; log.info('hud: target ' + s); }
        }));
        cr.on('layer', safe('layer', (ref, state, reason) => {
            if (ref === layer) log.info('hud: layer ' + state + (reason ? ' (' + reason + ')' : ''));
        }));
        cr.on('refused', safe('refused', (op, ref, reason) => log.warn('hud: refused ' + op + ' ' + ref + ': ' + reason)));
        cr.connect();
        log.info('hud: connecting to cluster-render');
    });

    const dropLayer = safe('drop', () => { if (cr && layer) cr.drop(layer); layer = 0; shown = ''; });

    const disconnect = safe('disconnect', () => {
        dropLayer();
        if (cr) { cr.removeAllListeners(); cr.close(); cr = null; log.info('hud: off'); }
        lastTarget = '';
    });

    const showTestPattern = safe('test', () => {
        if (shown === 'test') return;
        dropLayer();
        layer = cr.image({ target: 'hud', klass: 'overlay', x: 0, y: 0, w: SCENE_W, h: SCENE_H, fps: 1 });
        if (!layer) { log.warn('hud: test layer refused by the client'); return; }
        const cv = new Canvas(SCENE_W, SCENE_H);
        drawTestPattern(cv);
        if (!cr.pixels(layer, null, asBuffer(cv.d))) log.warn('hud: test pattern pixels refused');
        shown = 'test';
        log.info('hud: test pattern up');
    });

    const apply = safe('apply', () => {
        const m = mode();
        if (m === 'off') { disconnect(); return; }
        connect();
        if (!cr) return;
        if (m === 'test') showTestPattern();
    });

    settings.onChange(safe('setting', (key) => { if (key === 'hud') apply(); }));
    apply();
    return { stop: disconnect };
}

module.exports = { start, drawTach, drawTestPattern, SCENE_W, SCENE_H };
