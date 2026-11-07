'use strict';
/**
 * Redline on the head-up display, through cluster-render (robertnisipeanu/idrive-apps,
 * native/cluster-render): one image layer on its 'hud' target, an 800x480 scene the KOMBI
 * lays over BMW's own HUD content (speed, limit sign, guidance stay in their own slots).
 *
 *   - What the glass shows (G21, 2026-11-07 test pattern): about x 120..680, y 120..360 of the
 *     scene, BMW's speed and limit sign along its bottom from y ~325. The tach is a 400x130
 *     image centred at y 150 (a 520 px sample was far too big on the glass); "HUD size" scales
 *     it about its top centre, "HUD position" moves it. Both only move the layer, so they show
 *     at once.
 *   - Dark pixels are see-through on the HUD glass: drawn on alpha 0, lit parts at full
 *     brightness; unlit segments optionally faint ("dim").
 *   - cluster-render gives way to BMW's HUD pop-ups by itself; this module logs the target's
 *     state, including 'disabled' from its mapping guard.
 *   - Only the changed rectangle of each frame is sent (the bar moving is a narrow strip), at
 *     most 10 a second, nothing when the frame is the same.
 *   - Never throws: an uncaught error exits the app, MainApp's CorruptAppsHandler wipes an
 *     app's data on its first crash and uninstalls it on the second.
 *
 * Settings: hud (off | on | test), hudSize, hudX, hudY, hudGear, hudTemps, hudLights, hudUnlit.
 */
const { Canvas, withAlpha } = require('./kit/canvas');
let ClusterRender = null;
try { ClusterRender = require('./cluster_render_client').ClusterRender; } catch (e) { /* logged at start */ }

const SCENE_W = 800, SCENE_H = 480;
// the tach image and where it sits at 100 %: centred in the visible area, clear of BMW's speed
const IW = 400, IH = 130, BASE_X = (SCENE_W - IW) / 2, BASE_Y = 150;
const FPS = 10;
const WHITE = '#ffffff', GREEN = '#2fd27a', YELLOW = '#ffc21a', RED = '#ff2a2a', BLUE = '#2a7dff', COLD = '#3d8bff';
const CYAN = '#22e0ff', MAGENTA = '#ff3df0';
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const isNum = (x) => typeof x === 'number' && isFinite(x);

/** Canvas.d is a Uint8Array; the client copies from a Buffer (px.copy). Same memory, no copy. */
const asBuffer = (u8) => Buffer.from(u8.buffer, u8.byteOffset, u8.length);

/** Gear / selector text from car.data(): P R N while selected, else the gear, D while none is engaged. */
function gearText(d) {
    const g = d.gear, st = d.stage;
    return st === 'P' || st === 'R' || st === 'N' ? st : g === -1 ? 'R' : isNum(g) && g > 0 ? String(g) : st === 'D' ? 'D' : g === 0 ? 'N' : '-';
}

/**
 * The HUD tach in the box (x, y, w, h). s = { rpm, shift, redline, max, gear (text), red (shift
 * colour on), lights (bool), style ('m' | 'f1' | 'mono'), accent, dim (unlit segments faint) }.
 * Shift lights over the top fifth, the slanted bar under them in 500 rpm segments.
 */
function drawTach(cv, x, y, w, h, s) {
    const ledH = s.lights ? Math.round(h * 0.2) : 0, barY = y + (s.lights ? ledH + Math.round(h * 0.15) : 0), barH = y + h - barY;
    const rpm = s.rpm, shiftNow = isNum(rpm) && rpm >= s.shift;
    if (s.lights) {
        const n = 12, range = 2000, gap = 6, lw = (w - gap * (n - 1)) / n;
        const ledCol = (i) => {
            const f = i / (n - 1);
            if (s.style === 'mono') return s.accent || WHITE;
            if (s.style === 'f1') return f < 0.42 ? GREEN : f < 0.84 ? RED : BLUE;
            return f < 0.42 ? GREEN : f < 0.75 ? YELLOW : RED;
        };
        const lit = isNum(rpm) ? clamp((rpm - (s.shift - range)) / range, 0, 1) * n : 0;
        for (let i = 0; i < n; i++) {
            const c = shiftNow ? (s.red ? (s.style === 'f1' ? BLUE : RED) : null) : i < lit ? ledCol(i) : null;
            if (c) cv.roundRect(x + i * (lw + gap), y, lw, ledH, 4, c);
            else if (s.dim) cv.roundRect(x + i * (lw + gap), y, lw, ledH, 4, withAlpha(ledCol(i), 0.16));
        }
    }
    const slant = Math.round(barH * 0.32), X = (r) => x + clamp(r / s.max, 0, 1) * (w - slant);
    const seg = (a, b, c) => {
        const xa = X(a) + 2, xb = X(b) - 2;
        if (xb > xa) cv.quad([[xa + slant, barY], [xb + slant, barY], [xb, barY + barH], [xa, barY + barH]], c);
    };
    if (s.dim) for (let r = 0; r < s.redline; r += 500) seg(r, Math.min(s.redline, r + 500), withAlpha(WHITE, 0.12));
    for (let r = s.redline; r < s.max; r += 500) seg(r, Math.min(s.max, r + 500), withAlpha(RED, 0.4));
    if (isNum(rpm) && rpm > 50) {
        const top = Math.min(rpm, s.max);
        for (let r = 0; r < top; r += 500) {
            const f = (r + 250) / s.shift;
            seg(r, Math.min(top, r + 500), shiftNow ? (s.red ? RED : withAlpha(RED, 0.4)) : f >= 0.92 ? RED : f >= 0.7 ? YELLOW : GREEN);
        }
    }
    return shiftNow;
}

/** One temperature: label over the value, coloured cold / warm-up / normal / hot. */
function drawTemp(cv, cx, y, label, v, limits) {
    const col = !isNum(v) ? null : v < limits.cold ? COLD : limits.warm && v < limits.warm ? YELLOW : v > limits.hot ? RED : WHITE;
    if (!col) return;
    cv.text(label, cx, y + 12, 12, withAlpha(WHITE, 0.75), { align: 'center', font: 'bold', spacing: 1.2 });
    cv.text(Math.round(v) + '°', cx, y + 40, 26, col, { align: 'center', font: 'bold' });
}

/**
 * The whole HUD image (IW x IH). f = { d (car.data()), shift, redline, max, gearbox, red, opts }
 * opts = { gear, temps, lights, dim, style, warmOil }.
 */
function drawHud(cv, f) {
    const o = f.opts, d = f.d;
    cv.clear();
    const tx = o.gear ? 70 : 0, tw = IW - tx;
    const shiftNow = drawTach(cv, tx, 2, tw, 50, { rpm: d.rpm, shift: f.shift, redline: f.redline, max: f.max, red: f.red, lights: o.lights, style: o.style, dim: o.dim });
    if (o.gear) cv.text(gearText(d), 30, 78, 72, shiftNow && f.red ? RED : WHITE, { align: 'center', font: 'gear' });
    if (o.temps) {
        const col = tw / 3, y = 70;
        drawTemp(cv, tx + col * 0.5, y, 'OIL', d.oil, { cold: 60, warm: o.warmOil, hot: 130 });
        drawTemp(cv, tx + col * 1.5, y, 'WATER', d.coolant, { cold: 60, hot: 112 });
        drawTemp(cv, tx + col * 2.5, y, 'GEARBOX', f.gearbox, { cold: 50, hot: 120 });
    }
}

/** 800x480 test pattern: border, rulers every 40 px with labels, inset frames at 40/80/120, the tach at its place. */
function drawTestPattern(cv) {
    cv.clear();
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
    cv.fillRect(SCENE_W / 2 - 20, SCENE_H / 2 - 1, 40, 2, WHITE);
    cv.fillRect(SCENE_W / 2 - 1, SCENE_H / 2 - 20, 2, 40, WHITE);
}

/** Bounding box of the pixels that differ between a and b (Uint8Arrays of w x h RGBA), or null. */
function changedBox(a, b, w, h) {
    const A = new Uint32Array(a.buffer, a.byteOffset, w * h), B = new Uint32Array(b.buffer, b.byteOffset, w * h);
    let x0 = w, x1 = -1, y0 = h, y1 = -1;
    for (let y = 0; y < h; y++) {
        const row = y * w;
        let l = -1, r = -1;
        for (let x = 0; x < w; x++) if (A[row + x] !== B[row + x]) { l = x; break; }
        if (l < 0) continue;
        for (let x = w - 1; x >= l; x--) if (A[row + x] !== B[row + x]) { r = x; break; }
        if (y < y0) y0 = y;
        y1 = y;
        if (l < x0) x0 = l;
        if (r > x1) x1 = r;
    }
    return y1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/** The rows of rect r of a w-wide RGBA image, packed tight (what cr.pixels takes). */
function packRect(d, w, r) {
    const out = Buffer.alloc(r.w * r.h * 4), src = asBuffer(d);
    for (let y = 0; y < r.h; y++) src.copy(out, y * r.w * 4, ((r.y + y) * w + r.x) * 4, ((r.y + y) * w + r.x + r.w) * 4);
    return out;
}

/**
 * Start the HUD output. src = { data() (car.data()), shiftPoint(oil) -> { rpm }, redline(),
 * maxRpm(), gearbox (a GearboxTemp, optional) }. Returns { stop }.
 */
function start(ctx, src) {
    const settings = ctx.settings, log = ctx.log;
    let cr = null, layer = 0, shown = '', lastTarget = '', timer = null, blink = false;
    let cur = null, prev = null, first = true, lastErr = 0;

    const safe = (name, fn) => function () {
        try { return fn.apply(null, arguments); } catch (e) {
            if (Date.now() - lastErr > 10000) { lastErr = Date.now(); log.error('hud ' + name + ': ' + (e && e.stack || e)); }
        }
    };
    const mode = () => settings.get('hud') || 'off';
    const num = (k, dflt) => { const v = Number(settings.get(k)); return isFinite(v) ? v : dflt; };

    /** Where the tach image shows in the scene, from the size and position settings. */
    function rect() {
        const k = clamp(num('hudSize', 100), 50, 140) / 100, w = Math.round(IW * k), h = Math.round(IH * k);
        const x = BASE_X + Math.round((IW - w) / 2) + clamp(num('hudX', 0), -120, 120);
        const y = BASE_Y + clamp(num('hudY', 0), -120, 120);
        return { x: clamp(x, 0, SCENE_W - w), y: clamp(y, 0, SCENE_H - h), w: w, h: h };
    }

    const connect = safe('connect', () => {
        if (cr) return;
        if (!ClusterRender) { log.warn('hud: cluster_render_client.js is missing from the app'); return; }
        cr = new ClusterRender('redline');
        cr.on('ready', safe('ready', () => { first = true; log.info('hud: connected to cluster-render (' + cr.backend + ', targets ' + cr.targets + ')'); }));
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

    const stopTimer = () => { if (timer) clearInterval(timer); timer = null; if (src.gearbox) src.gearbox.stop(); };

    const dropLayer = safe('drop', () => { stopTimer(); if (cr && layer) cr.drop(layer); layer = 0; shown = ''; });

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
        const t = new Canvas(IW, IH);
        drawHud(t, sample());
        cv.blit(t, BASE_X, BASE_Y);
        if (!cr.pixels(layer, null, asBuffer(cv.d))) log.warn('hud: test pattern pixels refused');
        shown = 'test';
        log.info('hud: test pattern up');
    });

    /** What drawHud needs, now. */
    function frameData() {
        const d = src.data(), sp = src.shiftPoint(d.oil);
        if (settings.get('flash') && isNum(d.rpm) && d.rpm >= sp.rpm) blink = !blink; else blink = true;
        return {
            d: d, shift: sp.rpm, redline: src.redline(), max: src.maxRpm(), red: blink,
            gearbox: src.gearbox ? src.gearbox.value() : null,
            opts: {
                gear: settings.get('hudGear') !== 'off', temps: settings.get('hudTemps') !== false,
                lights: settings.get('hudLights') !== false, dim: settings.get('hudUnlit') === 'dim',
                style: settings.get('lights'), warmOil: num('warmOil', 80),
            },
        };
    }

    /** Demo frame for the test pattern: 6300 rpm in 3rd, warm. */
    function sample() {
        const f = frameData();
        f.d = { rpm: 6300, gear: 3, stage: 'D', oil: 96, coolant: 97 };
        f.shift = 6700; f.redline = 7000; f.max = 8000; f.gearbox = 74; f.red = true;
        return f;
    }

    const tick = safe('tick', () => {
        if (!cr || !layer || !cr.ready) return;
        drawHud(cur, frameData());
        if (first) {
            if (cr.pixels(layer, null, asBuffer(cur.d))) first = false;
        } else {
            const r = changedBox(cur.d, prev.d, IW, IH);
            if (!r) return;
            cr.pixels(layer, [r], packRect(cur.d, IW, r));
        }
        const t = prev; prev = cur; cur = t;
    });

    const showTach = safe('tach', () => {
        const r = rect();
        if (shown === 'tach') { cr.set(layer, r); return; }
        dropLayer();
        layer = cr.image({ target: 'hud', klass: 'overlay', x: r.x, y: r.y, w: r.w, h: r.h, iw: IW, ih: IH, fps: FPS, sampling: 'bilinear' });
        if (!layer) { log.warn('hud: tach layer refused by the client'); return; }
        cur = new Canvas(IW, IH); prev = new Canvas(IW, IH); first = true;
        shown = 'tach';
        if (src.gearbox) src.gearbox.start();
        timer = setInterval(tick, Math.round(1000 / FPS));
        log.info('hud: tach on at ' + r.x + ',' + r.y + ' ' + r.w + 'x' + r.h);
    });

    const apply = safe('apply', () => {
        const m = mode();
        if (m === 'off') { disconnect(); return; }
        connect();
        if (!cr) return;
        if (m === 'test') showTestPattern(); else showTach();
    });

    const HUD_KEYS = ['hud', 'hudSize', 'hudX', 'hudY'];
    settings.onChange(safe('setting', (key) => { if (HUD_KEYS.indexOf(key) >= 0) apply(); else first = true; }));
    apply();
    return { stop: disconnect };
}

module.exports = { start, drawHud, drawTach, drawTestPattern, changedBox, packRect, IW, IH, BASE_X, BASE_Y, SCENE_W, SCENE_H };
