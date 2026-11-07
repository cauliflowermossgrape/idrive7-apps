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
const fs = require('fs');
const path = require('path');
const { Canvas, withAlpha } = require('./kit/canvas');
let ClusterRender = null;
try { ClusterRender = require('./cluster_render_client').ClusterRender; } catch (e) { /* logged at start */ }

const SCENE_W = 800, SCENE_H = 480;
// the tach image and where it sits at 100 %: centred in the visible area, clear of BMW's speed
const IW = 400, IH = 130, BASE_X = (SCENE_W - IW) / 2, BASE_Y = 140;
const TEMP_X = 150;                                             // temperatures start here (image x)
const FPS = 10;
const WHITE = '#ffffff', GREEN = '#2fd27a', YELLOW = '#ffc21a', RED = '#ff2a2a', BLUE = '#2a7dff', COLD = '#3d8bff';
const CYAN = '#22e0ff', MAGENTA = '#ff3df0';
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const isNum = (x) => typeof x === 'number' && isFinite(x);

/** Write a small file whole or not at all (temp file, then rename): a power cut mid-write can't corrupt it. */
function writeAtomic(file, text, log) {
    try { fs.writeFileSync(file + '.tmp', text); fs.renameSync(file + '.tmp', file); } catch (e) { if (log) log.warn('save ' + path.basename(file) + ': ' + e); }
}

/** Canvas.d is a Uint8Array; the client copies from a Buffer (px.copy). Same memory, no copy. */
const asBuffer = (u8) => Buffer.from(u8.buffer, u8.byteOffset, u8.length);

/** Gear / selector text from car.data(): P R N while selected, else the gear, D while none is engaged. */
function gearText(d) {
    const g = d.gear, st = d.stage;
    return st === 'P' || st === 'R' || st === 'N' ? st : g === -1 ? 'R' : isNum(g) && g > 0 ? String(g) : st === 'D' ? 'D' : g === 0 ? 'N' : '-';
}

/**
 * Shift cue: when the shift lights start counting and when they flash, from how fast the revs
 * climb. st = state kept between frames ({}); returns { from, at, shift, limiter, rate, fallSince }:
 *   at     = the rpm the lights flash at: the shift point minus what the revs climb in the
 *            driver's reaction time (leadMs), at most 800 rpm early;
 *   from   = where the count starts: ~1 s of climb before 'at' (800..2000 rpm), so the count-in
 *            takes about as long in every gear. The span and the lead are taken while the revs
 *            climb and kept when they stop (a lift, a steady hold), so the lights then follow the
 *            revs down one step at a time instead of jumping; back to 1500 / no lead once the
 *            count is empty. Never climbed: 1500 and no lead;
 *   shift  = flashing now. Held at the point it fired at, so a noisy climb rate doesn't make it
 *            flicker; it ends when the revs fall 800 below that point (the upshift) or have
 *            been falling for 300 ms (a lift; a traction dip is shorter);
 *   limiter= at the redline (within 100): everything flashes;
 *   fallSince = since when the revs have been falling (ms), or null.
 * Rate: smoothed rpm per second from successive frames, rises only (a lift or a shift resets it).
 */
function shiftCue(st, rpm, tMs, shift, redline, leadMs) {
    if (!isNum(rpm)) { st.rate = 0; st.on = false; st.fall = null; return { from: shift - 1500, at: shift, shift: false, limiter: false, rate: 0, fallSince: null }; }
    let rising = false;
    if (isNum(st.rpm) && tMs > st.t) {
        const r = (rpm - st.rpm) * 1000 / (tMs - st.t);
        rising = r > 300;
        st.rate = r <= 0 ? (r < -500 ? 0 : (st.rate || 0) * 0.7) : (st.rate ? st.rate * 0.5 + r * 0.5 : r);
        // falling: more than 150 rpm/s down, frame after frame
        if (r < -150) { if (st.fall == null) st.fall = st.t; } else st.fall = null;
    }
    st.rpm = rpm; st.t = tMs;
    const rate = st.rate || 0, climbing = rate > 300;
    // span and lead from frames where the revs really rose: the smoothed rate decays over a hold
    // or a lift, and following it would shrink the count while the rpm stands still
    if (climbing && rising) { st.span = clamp(rate * 1.0, 800, 2000); st.lead = Math.min(800, rate * leadMs / 1000); }
    const at = shift - (st.lead || 0);
    const from = at - (st.span || 1500);
    if (!climbing && rpm <= from) { st.span = 0; st.lead = 0; }          // count empty: back to the plain span
    // latch: the flash point is held from the moment it fires
    const lifted = st.fall != null && tMs - st.fall >= 300;
    if (!st.on && rpm >= at && !lifted) { st.on = true; st.at = at; }
    else if (st.on && (rpm < st.at - 800 || lifted)) st.on = false;
    return { from: from, at: st.on ? st.at : at, shift: st.on, limiter: rpm >= redline - 100, rate: rate, fallSince: st.fall == null ? null : st.fall };
}

/**
 * The HUD tach in the box (x, y, w, h). s = { rpm, cue (shiftCue()), shift, redline, max,
 * blink (flash phase on), lights (bool), gt3 (bool), style ('m' | 'f1' | 'mono'), accent, dim }.
 * Round shift lights along the top: they count into the shift and flash for it. Under them a
 * thin yellow mark at the shift point and a red one at the redline, then the slanted bar, which
 * runs on to the redline; on the limiter everything flashes red.
 */
function drawTach(cv, x, y, w, h, s) {
    const ledD = s.lights ? 14 : 0, markH = 6, barY = y + ledD + (s.lights ? 4 : 0) + markH + 2, barH = y + h - barY;
    const rpm = s.rpm, cue = s.cue, flash = cue.shift || cue.limiter;
    const flashCol = cue.limiter ? RED : s.style === 'f1' ? BLUE : RED;
    const count = isNum(rpm) ? clamp((rpm - cue.from) / (cue.at - cue.from), 0, 1) : 0;
    if (s.lights) {
        const n = 12, pitch = w / n, rad = Math.min(ledD / 2, pitch * 0.36), cy = y + ledD / 2;
        const dot = (i, c) => cv.circle(x + pitch * (i + 0.5), cy, rad, c);
        // GT3: pairs from both ends inwards (k = 0 outermost), outer green, then yellow, inner red;
        // left to right: the screen's sequence
        const pos = (i) => (s.gt3 ? Math.min(i, n - 1 - i) : i);
        const steps = s.gt3 ? n / 2 : n;
        const col = (i) => {
            const f = pos(i) / (steps - 1);
            if (s.style === 'mono') return s.accent || WHITE;
            if (s.style === 'f1' && !s.gt3) return f < 0.42 ? GREEN : f < 0.84 ? RED : BLUE;
            return f < 0.34 ? GREEN : f < 0.67 ? YELLOW : RED;
        };
        // the last step (the inner pair) lights only with the flash: the count runs up to it
        const lit = Math.ceil(count * (steps - 1));
        for (let i = 0; i < n; i++) {
            const c = flash ? (s.blink ? flashCol : null) : pos(i) < lit ? col(i) : null;
            if (c) dot(i, c);
            else if (s.dim) dot(i, withAlpha(flash ? flashCol : col(i), 0.16));
        }
    }
    const slant = Math.round(barH * 0.32), X = (r) => x + clamp(r / s.max, 0, 1) * (w - slant);
    const seg = (a, b, c) => {
        const xa = X(a) + 2, xb = X(b) - 2;
        if (xb > xa) cv.quad([[xa + slant, barY], [xb + slant, barY], [xb, barY + barH], [xa, barY + barH]], c);
    };
    // marks over the bar's top edge (like the screen's): yellow at the shift point, red at the redline
    const mark = (r, c) => cv.fillRect(Math.round(X(r) + slant) - 1, barY - markH - 2, 3, markH, c);
    if (isNum(s.shift) && s.shift < s.redline) mark(s.shift, YELLOW);
    mark(s.redline, RED);
    if (s.dim) for (let r = 0; r < s.redline; r += 500) seg(r, Math.min(s.redline, r + 500), withAlpha(WHITE, 0.12));
    for (let r = s.redline; r < s.max; r += 500) seg(r, Math.min(s.max, r + 500), withAlpha(RED, 0.4));
    if (isNum(rpm) && rpm > 50) {
        // green below the shift point, amber past it, red into the redline; all red flashing on the limiter
        const top = Math.min(rpm, s.max);
        for (let r = 0; r < top; r += 500) {
            const mid = r + 250;
            const c = cue.limiter ? (s.blink ? RED : withAlpha(RED, 0.35)) : mid >= s.redline ? RED : mid >= s.shift ? YELLOW : GREEN;
            seg(r, Math.min(top, r + 500), c);
        }
    }
    return cue;
}

/** One temperature: label over the value, coloured cold / warm-up / normal / hot. */
function drawTemp(cv, cx, y, label, v, limits) {
    const col = !isNum(v) ? null : v < limits.cold ? COLD : limits.warm && v < limits.warm ? YELLOW : v > limits.hot ? RED : WHITE;
    if (!col) return;
    cv.text(label, cx, y + 12, 12, withAlpha(WHITE, 0.75), { align: 'center', font: 'bold', spacing: 1.2 });
    cv.text(Math.round(v) + '°', cx, y + 40, 26, col, { align: 'center', font: 'bold' });
}

/**
 * The whole HUD image (IW x IH). f = { d (car.data()), shift, redline, max, gearbox, blink, cue
 * (shiftCue(); without one: no climb, count over the last 1500 rpm), opts }
 * opts = { gear, temps, lights, gt3, dim, style, warmOil }.
 */
function drawHud(cv, f) {
    const o = f.opts, d = f.d;
    cv.clear();
    const tx = o.gear ? 70 : 0, tw = IW - tx;
    const cue = f.cue || shiftCue({}, d.rpm, 0, f.shift, f.redline, 0);
    drawTach(cv, tx, 2, tw, 56, { rpm: d.rpm, cue: cue, shift: f.shift, redline: f.redline, max: f.max, blink: f.blink, lights: o.lights, gt3: o.gt3, style: o.style, dim: o.dim });
    // the gear turns red only on the limiter; the shift itself is the lights' job
    if (o.gear) cv.text(gearText(d), 30, 78, 72, cue.limiter && f.blink ? RED : WHITE, { align: 'center', font: 'gear' });
    if (o.temps) {
        // right of TEMP_X only: BMW draws its driver-assistance graphic (lanes, steering wheel,
        // ACC distance) under the left of the bar, above its speed (G21, 2026-11-07)
        const col = (IW - TEMP_X) / 3, y = 66;
        drawTemp(cv, TEMP_X + col * 0.5, y, 'OIL', d.oil, { cold: 60, warm: o.warmOil, hot: 130 });
        drawTemp(cv, TEMP_X + col * 1.5, y, 'WATER', d.coolant, { cold: 60, hot: 112 });
        drawTemp(cv, TEMP_X + col * 2.5, y, 'GEARBOX', f.gearbox, { cold: 50, hot: 120 });
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
 * Start the HUD output. src = { data() (car.data()), shiftPoint(oil, gear) -> { rpm }, redline(),
 * maxRpm(), gearbox (a GearboxTemp, optional) }.
 * Returns { stop, status() (a line for the screen, '' while off), upshift(rpm) (each upshift's
 * rpm: calibrates the reaction time), lead() (ms in use) }.
 */
function start(ctx, src) {
    const settings = ctx.settings, log = ctx.log;
    let cr = null, layer = 0, shown = '', lastTarget = '', timer = null, blink = false;
    let target = null;                                           // { state, holder, disabled } of 'hud'
    const cueState = {};
    /*
     * Reaction time, learned ("HUD shift light early by" on Auto): each upshift after a flash
     * says how late it came: (shift rpm - shift point) / climb rate. The lead moves 30 % of the
     * way to the lead that would have hit it, within 0..600 ms; kept in data/hudlead.json.
     */
    const leadFile = path.join(ctx.dataDir || '.', 'hudlead.json');
    let learnedLead = 200, leadShifts = 0, flashInfo = null;
    try { const j = JSON.parse(fs.readFileSync(leadFile, 'utf8')); if (isNum(j.ms)) { learnedLead = j.ms; leadShifts = j.n || 0; } } catch (e) { /* none yet */ }
    let cur = null, prev = null, first = true, lastErr = 0;

    const safe = (name, fn) => function () {
        try { return fn.apply(null, arguments); } catch (e) {
            if (Date.now() - lastErr > 10000) { lastErr = Date.now(); log.error('hud ' + name + ': ' + (e && e.stack || e)); }
        }
    };
    const mode = () => settings.get('hud') || 'off';
    const num = (k, dflt) => { const v = Number(settings.get(k)); return isFinite(v) ? v : dflt; };
    const leadMs = () => { const v = num('hudLead', -1); return v < 0 ? learnedLead : v; };

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
            target = { state: state, holder: holder, disabled: disabled };
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
        lastTarget = ''; target = null;
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
        const d = src.data(), sp = src.shiftPoint(d.oil, d.gear), redline = src.redline();
        const gt3 = settings.get('hudLightStyle') !== 'bar';
        // the lights count into the shift and flash for it, early by the reaction time; 5 Hz flash
        const was = cueState.on, lead = leadMs();
        const cue = shiftCue(cueState, d.rpm, Date.now(), sp.rpm, redline, lead);
        // the reaction time is learned only from flashes the driver could see: lights on, HUD shown
        if (cue.shift && !was) {
            const seen = settings.get('hudLights') !== false && target && target.state === 'shown';
            flashInfo = seen ? { t: Date.now(), rate: cue.rate, target: sp.rpm, lead: lead, fall: null } : null;
        }
        // first moment the revs fell after the flash: a real upshift reports its new gear within
        // ~0.7 s of that; later, the driver lifted first and the shift says nothing about reaction
        if (flashInfo && flashInfo.fall === null && cue.fallSince !== null) flashInfo.fall = cue.fallSince;
        blink = cue.shift || cue.limiter ? !blink : true;
        return {
            d: d, shift: sp.rpm, redline: redline, max: src.maxRpm(), blink: blink, cue: cue,
            gearbox: src.gearbox ? src.gearbox.value() : null,
            opts: {
                gear: settings.get('hudGear') !== 'off', temps: settings.get('hudTemps') !== false,
                lights: settings.get('hudLights') !== false, gt3: gt3, dim: settings.get('hudUnlit') === 'dim',
                style: settings.get('lights'), warmOil: num('warmOil', 80),
            },
        };
    }

    /** Demo frame for the test pattern: 6300 rpm in 3rd, warm. */
    function sample() {
        const f = frameData();
        f.d = { rpm: 6300, gear: 3, stage: 'D', oil: 96, coolant: 97 };
        f.shift = 6700; f.redline = 7000; f.max = 8000; f.gearbox = 74; f.blink = true; f.cue = null;
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

    /** An upshift at rpm (its peak): if it followed a flash on a climb, learn the reaction time. */
    const upshift = safe('upshift', (rpm) => {
        const f = flashInfo;
        flashInfo = null;
        if (!f || !isNum(rpm) || Date.now() - f.t > 2000 || f.rate < 300) return;
        if (f.fall !== null && Date.now() - f.fall > 700) { log.info('hud: shift after a lift, not used for the reaction time'); return; }
        const lateMs = (rpm - f.target) / f.rate * 1000;
        const ideal = clamp(f.lead + lateMs, 0, 600);
        const before = learnedLead;
        learnedLead = Math.round(clamp(learnedLead + (ideal - learnedLead) * 0.3, 0, 600) / 10) * 10;
        leadShifts++;
        log.info('hud: shift at ' + Math.round(rpm) + ' for ' + f.target + ' (' + (lateMs >= 0 ? Math.round(lateMs) + ' ms late' : Math.round(-lateMs) + ' ms early') +
            '), reaction lead now ' + learnedLead + ' ms after ' + leadShifts + ' shifts');
        // written only when the lead moves (once settled, seldom)
        if (learnedLead !== before) writeAtomic(leadFile, JSON.stringify({ ms: learnedLead, n: leadShifts }), log);
    });

    /** One line for Redline's screen: what the HUD is doing. */
    function status() {
        const m = mode();
        if (m === 'off') return '';
        if (!cr || !cr.ready) return 'HUD: cluster-render not running';
        if (target && target.disabled) return 'HUD: off after display errors';
        if (m === 'test') return 'HUD: test pattern';
        const st = target ? target.state : '';
        if (st === 'shown') return 'HUD: on';
        if (st === 'parked' || st === 'waiting') return 'HUD: giving way to BMW';
        if (st === 'unavailable') return 'HUD: not available';
        return 'HUD: starting';
    }

    // frame: one frame's data without drawing (for tests)
    return { stop: disconnect, status: status, upshift: upshift, lead: leadMs, frame: frameData };
}

module.exports = { start, shiftCue, writeAtomic, drawHud, drawTach, drawTestPattern, changedBox, packRect, IW, IH, BASE_X, BASE_Y, SCENE_W, SCENE_H };
