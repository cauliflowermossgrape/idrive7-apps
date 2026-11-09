'use strict';
/**
 * Part of Redline's experimental features; README.md in this folder has the whole picture.
 *
 * The HUD drawn by the GPU (setting "hudRenderer": GPU). The Arc: GpuArc below, its own shader. Every other
 * layout: GpuGauge, further down. The Arc's moving parts - the 8 lights, the band, its ticks and zones, the peak line and the flash's blink - are a
 * cluster-render effect layer: a fragment shader the renderer runs every frame, fed a few numbers
 * (uniforms) only when they change. The text (gear, readouts, the shift grade) stays an image layer over
 * it, drawn by hud-draw.js with the lights and band switched off, so it changes only when a number does.
 * Compared with the picture path (a 400x130 RGBA image re-sent as the revs move) this sends a few dozen
 * bytes a frame. The shape is hud-m.js's Arc, in the same units (the 400x130 picture's pixels).
 *
 * Unknown on the car (see the test sheet): how the renderer blends an effect's alpha (straight or
 * premultiplied: setting "hudGpuAlpha"), and whether the GPU has highp floats in fragment shaders.
 */

/* The arc's geometry in units of 100 px of the 400x130 picture (mediump-safe: radii under 4, not 372). */
const ARC_FS = [
    '#ifdef GL_FRAGMENT_PRECISION_HIGH',
    'precision highp float;',
    '#else',
    'precision mediump float;',
    '#endif',
    'varying vec2 v_uv;',
    'uniform highp float u_time;',
    'uniform vec2 u_px;',                     // the layer's size on the target, px (edge smoothing)
    'uniform float u_rpm;',                    // revs as a fraction of the scale
    'uniform float u_warn;',                   // the yellow zone's start, the red zone's start (fractions)
    'uniform float u_red;',
    'uniform float u_tick;',                   // 1000 rpm as a fraction
    'uniform float u_peak;',                   // the peak line's fraction, < 0: none
    'uniform float u_lit;',                    // lights lit, 0..8
    'uniform float u_flash;',                  // 0 none, 1 the shift flash, 2 the limiter
    'uniform float u_dim;',                    // 1: unlit lights outlined, the unlit band grey
    'uniform float u_lights;',                 // 1: the lights shown
    'uniform float u_bar;',                    // 1: the band shown
    'uniform float u_premul;',                 // 1: output premultiplied alpha
    'uniform vec4 u_lc[8];',                   // each light's colour
    'uniform vec3 u_flashCol;',
    'const vec2 C = vec2(2.0, 3.72);',         // the circles' centre, far below the picture
    'const float SPAN = 27.0;',
    'vec4 acc;',                               // premultiplied colour so far, back to front
    'void over(vec3 c, float a) { acc = vec4(c * a, a) + acc * (1.0 - a); }',
    'float band(float r, float r0, float r1, float e) { return clamp(min(r - r0, r1 - r) / e + 0.5, 0.0, 1.0); }',
    // coverage of the sector a0..a1 (degrees) at radius r: by the distance to its sides in px-units
    'float sect(float ang, float a0, float a1, float r, float e) { return clamp(min(ang - a0, a1 - ang) * r * 0.0174533 / e + 0.5, 0.0, 1.0); }',
    'float A(float f) { return -SPAN + 2.0 * SPAN * clamp(f, 0.0, 1.0); }',
    'void main() {',
    '    vec2 p = v_uv * vec2(4.0, 1.3);',
    '    float e = 4.0 / max(u_px.x, 1.0);',   // one screen pixel, in units
    '    vec2 d = p - C;',
    '    float r = length(d);',
    '    float ang = degrees(atan(d.x, -d.y));',
    '    bool on = fract(u_time * 5.0) < 0.5;', // the 5 Hz flash: on for 100 ms of each 200
    '    acc = vec4(0.0);',
    '    if (u_bar > 0.5) {',
    '        float inB = band(r, 3.25, 3.43, e);',
    '        if (inB > 0.0) {',
    '            if (u_dim > 0.5) over(vec3(0.365, 0.420, 0.455), 0.9 * inB * sect(ang, A(0.0), A(u_warn), r, e));',
    '            over(vec3(0.949, 0.722, 0.114), 0.55 * inB * sect(ang, A(u_warn), A(u_red), r, e));',
    '            over(vec3(0.890, 0.149, 0.165), 0.55 * inB * sect(ang, A(u_red), A(1.0), r, e));',
    '            float top = clamp(u_rpm, 0.0, 1.0);',
    '            if (top > 0.00625) {',
    '                if (u_flash > 1.5) over(vec3(0.890, 0.149, 0.165), (on ? 1.0 : 0.4) * inB * sect(ang, A(0.0), A(top), r, e));',
    '                else {',
    '                    over(vec3(0.737, 0.839, 0.910), inB * sect(ang, A(0.0), A(min(top, u_warn)), r, e));',
    '                    if (top > u_warn) over(vec3(0.949, 0.722, 0.114), inB * sect(ang, A(u_warn), A(min(top, u_red)), r, e));',
    '                    if (top > u_red) over(vec3(0.890, 0.149, 0.165), inB * sect(ang, A(u_red), A(top), r, e));',
    '                }',
    '            }',
    '        }',
    // the white rim along the band's top, and a tick each 1000 rpm hanging from it
    '        over(vec3(0.957), band(r, 3.43, 3.46, e) * sect(ang, A(0.0) - 0.4, A(1.0) + 0.4, r, e));',
    '        float k = floor((clamp((ang + SPAN) / (2.0 * SPAN), 0.0, 1.0)) / u_tick + 0.5) * u_tick;',
    '        if (k > 0.0 && k < 1.0) over(vec3(0.957), band(r, 3.31, 3.43, e) * clamp(0.008 - abs(ang - A(k)) * r * 0.0174533, 0.0, e) / e);',
    '        if (u_peak >= 0.0) over(vec3(1.0), band(r, 3.25, 3.46, e) * clamp(0.012 - abs(ang - A(u_peak)) * r * 0.0174533, 0.0, e) / e);',
    '    }',
    '    if (u_lights > 0.5) {',
    '        float inL = band(r, 3.52, 3.68, e);',
    '        float stepA = 2.0 * SPAN / 8.0;',
    '        float i = floor((ang + SPAN) / stepA);',
    '        if (i >= 0.0 && i < 8.0 && r > 3.5 && r < 3.7) {',
    '            float a0 = -SPAN + i * stepA + 0.65, a1 = a0 + stepA - 1.3;',
    '            float cov = inL * sect(ang, a0, a1, r, e);',
    '            vec3 col = vec3(0.0);',
    '            for (int j = 0; j < 8; j++) { if (float(j) == i) col = u_lc[j].rgb; }',
    '            if (u_flash > 0.5) { if (on) over(u_flashCol, cov); }',
    '            else if (i < u_lit) over(col, cov);',
    '            else if (u_dim > 0.5) {',
    // the outline: inside the box but within 1.6 px of an edge
    '                float inner = band(r, 3.52 + 0.016, 3.68 - 0.016, e) * sect(ang, a0 + 0.016 / r * 57.29578, a1 - 0.016 / r * 57.29578, r, e);',
    '                over(col, 0.85 * max(cov - inner, 0.0));',
    '            }',
    '        }',
    '    }',
    '    gl_FragColor = u_premul > 0.5 ? acc : (acc.a > 0.0 ? vec4(acc.rgb / acc.a, acc.a) : vec4(0.0));',
    '}',
].join('\n');

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const isNum = (x) => typeof x === 'number' && isFinite(x);
const hex = (c) => { const n = parseInt(String(c).slice(1, 7), 16); return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255]; };

/**
 * The Arc's uniforms for a frame (as hud-draw's drawLayer gets it), the layer drawn w px wide.
 * h: { P (palette), lightCol, RACE_BLUE } from hud-draw. Mirrors hud-m.js's drawArc.
 */
function arcUniforms(f, w, h) {
    const o = f.opts, d = f.d, cue = f.cue, n = 8;
    const fl = cue.shift || cue.limiter;
    const count = isNum(d.rpm) ? clamp((d.rpm - cue.from) / (cue.at - cue.from), 0, 1) : 0;
    const own = o.lightStyle === 'f1' || o.lightStyle === 'mono';
    const lc = [];
    for (let i = 0; i < n; i++) lc.push.apply(lc, hex(own ? h.lightCol(o.lightStyle, h.P, i / (n - 1)) : i >= n - 2 ? '#e3262a' : '#f2a81d').concat([1]));
    const peakOn = isNum(f.peak) && f.peak > 0 && !(isNum(d.rpm) && d.rpm >= f.peak - 50);
    return {
        u_px: [w, w * 130 / 400],
        u_rpm: [isNum(d.rpm) && d.rpm > 50 ? Math.min(d.rpm, f.max) / f.max : 0],
        u_warn: [Math.max(0, f.redline - 500) / f.max], u_red: [f.redline / f.max], u_tick: [1000 / f.max],
        u_peak: [peakOn ? Math.min(f.peak, f.max) / f.max : -1],
        u_lit: [fl ? n : Math.ceil(count * (n - 1))],
        u_flash: [cue.limiter ? 2 : cue.shift ? 1 : 0],
        u_dim: [o.dim ? 1 : 0], u_lights: [o.lights ? 1 : 0], u_bar: [o.bar !== false ? 1 : 0],
        u_lc: lc,
        u_flashCol: hex(cue.limiter ? '#e3262a' : o.lightStyle === 'f1' ? h.RACE_BLUE : '#e3262a'),
    };
}

/**
 * The effect layer: made with make(rect), then update(f) each frame sends the uniforms that changed
 * (the rpm to about a pixel of band). premul: the setting "hudGpuAlpha" (premultiplied output).
 */
class GpuArc {
    constructor(cr, h, log) { this.cr = cr; this.h = h; this.log = log; this.ref = 0; this.sent = {}; this.w = 400; this.style = 'arc'; this.under = true; }
    make(r, premul) {
        this.w = r.w;
        this.ref = this.cr.effect({ target: 'hud', klass: 'overlay', z: 0, x: r.x, y: r.y, w: r.w, h: r.h, fs: ARC_FS, time: true });
        this.sent = {};
        if (this.ref) this.cr.uniform(this.ref, 'u_premul', [premul ? 1 : 0]);
        return this.ref;
    }
    update(f) {
        if (!this.ref) return;
        const u = arcUniforms(f, this.w, this.h);
        // the rpm rounded to 1/1600 of the scale: ~a pixel of band on a 140 % HUD
        u.u_rpm = [Math.round(u.u_rpm[0] * 1600) / 1600];
        Object.keys(u).forEach((k) => {
            const v = u[k], key = v.join(',');
            if (this.sent[k] === key) return;
            this.sent[k] = key;
            this.cr.uniform(this.ref, k, v, v.length > 4 ? { type: 'vec4' } : undefined);
        });
    }
    drop() { if (this.ref) this.cr.drop(this.ref); this.ref = 0; this.sent = {}; }
}

/* ---------- every other layout: what moves, from the picture's own drawing code ----------
 *
 * hud-draw.js / hud-m.js draw with a "sink" in the options (o.gpuSink): the lit shift lights, the lit
 * bar / graph / ramp / dial segments and the 7-segment rpm then go to the sink instead of the picture,
 * which keeps what stands still (ghosts, tracks, the red zone, marks, ticks) and the text. GpuGauge runs
 * that drawing twice on a canvas that draws nothing: at the real revs (the lights and digits) and with the
 * revs at the scale's top (every segment's colour); the shader lights the segments below u_rpm. So the
 * colours and places are the picture's, and a frame sends the revs and, when they change, a few arrays.
 * Units: the 400x130 picture's pixels.
 */
const GAUGE_PARTS = { standard: ['LIGHTS', 'BAR'], vector: ['LIGHTS', 'BAR'], wings: ['LIGHTS', 'BAR'], minimal: ['LIGHTS'],
    digital: ['LIGHTS', 'GRAPH', 'DIGITS'], vfd: ['LIGHTS', 'GRAPH', 'DIGITS'], ramp: ['RAMP'], dial: ['DIAL'] };
const NSEG = 40;

const GAUGE_FS = [
    '#ifdef GL_FRAGMENT_PRECISION_HIGH',
    'precision highp float;',
    '#else',
    'precision mediump float;',
    '#endif',
    'varying vec2 v_uv;',
    'uniform vec2 u_px;',                       // the layer's size on the target, px
    'uniform float u_premul;',
    'uniform float u_rpm;',                     // the revs (0: none)
    'uniform float u_max;',                     // the scale's top
    'vec4 acc;',
    'float E;',                                 // one screen pixel, in picture px
    'void over(vec3 c, float a) { acc = vec4(c * a, a) + acc * (1.0 - a); }',
    'void put(vec4 c, float cov) { if (cov > 0.0) over(c.rgb, c.a * cov); }',
    'float cover(float d) { return clamp(0.5 - d / E, 0.0, 1.0); }',      // d: signed distance, < 0 inside
    'float boxD(vec2 p, vec2 c, vec2 h) { vec2 q = abs(p - c) - h; return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0); }',
    '#if defined(BAR) || defined(GRAPH) || defined(RAMP) || defined(DIAL)',
    'uniform vec4 u_sc[' + NSEG + '];',         // each segment's colour when lit (a 0: never lit)
    'vec4 segCol(float i) { vec4 c = vec4(0.0); for (int j = 0; j < ' + NSEG + '; j++) { if (float(j) == i) c = u_sc[j]; } return c; }',
    '#endif',
    '#ifdef LIGHTS',
    'uniform vec4 u_lp[12];',                   // x, y, radius, shape (0 dot, 1 block, 2 ring)
    'uniform vec4 u_lc[12];',                   // colour (a 0: not lit)
    'void lights(vec2 p) {',
    '    for (int i = 0; i < 12; i++) {',
    '        vec4 c = u_lc[i], l = u_lp[i];',
    '        if (c.a > 0.0) {',
    '            float r = length(p - l.xy);',
    '            if (l.w < 0.5) put(c, cover(r - l.z));',
    '            else if (l.w < 1.5) put(c, cover(boxD(p, l.xy, vec2(l.z * 1.2, l.z * 0.7))));',
    '            else { put(c, cover(max(r - l.z, l.z - 1.8 - r))); put(c, cover(r - l.z * 0.45)); }',
    '        }',
    '    }',
    '}',
    '#endif',
    '#ifdef BAR',
    'uniform vec4 u_bar;',                      // x, the band\'s top, width, height
    'uniform vec2 u_bar2;',                     // slant, outline (1: segments as outlines with a faint fill)
    'float bx(float r) { return u_bar.x + clamp(r / u_max, 0.0, 1.0) * (u_bar.z - u_bar2.x); }',
    'void bar(vec2 p) {',
    '    float t = (p.y - u_bar.y) / u_bar.w;',
    '    if (t < -0.2 || t > 1.2) return;',
    '    float q = p.x - u_bar2.x * (1.0 - t);',  // the x the point has on the bottom edge
    '    float r = (q - u_bar.x) / (u_bar.z - u_bar2.x) * u_max;',
    '    float top = min(u_rpm, u_max), k = u_bar.w / sqrt(u_bar.w * u_bar.w + u_bar2.x * u_bar2.x);',
    '    float i0 = floor(r / 500.0 + 0.5) - 1.0;',
    '    for (int n = 0; n < 2; n++) {',
    '        float i = i0 + float(n), a = i * 500.0;',
    '        if (i >= 0.0 && a < top) {',
    '            float xa = bx(a) + 2.0, xb = bx(min(top, a + 500.0)) - 2.0;',
    '            vec4 c = segCol(i);',
    '            if (xb > xa && c.a > 0.0) {',
    '                float d = max(max(xa - q, q - xb) * k, max(u_bar.y - p.y, p.y - u_bar.y - u_bar.w));',
    '                if (u_bar2.y > 0.5) { put(vec4(c.rgb, c.a * 0.22), cover(d)); put(c, cover(abs(d) - 0.8)); }',
    '                else put(c, cover(d));',
    '            }',
    '        }',
    '    }',
    '}',
    '#endif',
    '#ifdef GRAPH',
    'uniform vec4 u_gr;',                       // x, top, a segment\'s width, height (40 of them, 2 px apart)
    'void graph(vec2 p) {',
    '    float i0 = floor((p.x - u_gr.x) / (u_gr.z + 2.0) + 0.5) - 1.0;',
    '    for (int n = 0; n < 2; n++) {',
    '        float i = i0 + float(n);',
    '        if (i >= 0.0 && i < 40.0 && (i + 0.5) * u_max / 40.0 <= u_rpm) {',
    '            vec4 c = segCol(i);',
    '            float x = u_gr.x + i * (u_gr.z + 2.0);',
    '            if (c.a > 0.0) put(c, cover(boxD(p, vec2(x + u_gr.z * 0.5, u_gr.y + u_gr.w * 0.5), vec2(u_gr.z, u_gr.w) * 0.5)));',
    '        }',
    '    }',
    '}',
    '#endif',
    '#ifdef DIGITS',
    'uniform vec4 u_dig;',                      // four characters as segment bits (a 1, b 2, c 4, d 8, e 16, f 32, g 64)
    'uniform vec4 u_dcol;',
    'float bit(float m, float k) { return mod(floor(m / k), 2.0); }',
    'float seg(vec2 p, vec2 o, vec2 s) { return cover(boxD(p, o + s * 0.5, s * 0.5)); }',
    'void digit(vec2 p, float x, float m) {',
    '    if (m <= 0.0 || p.x < x - 2.0 || p.x > x + 18.0) return;',
    '    float y = 64.0, w = 16.0, h = 30.0, t = 4.0, hh = 15.0, g = 1.0, cov = 0.0;',
    '    if (bit(m, 1.0) > 0.5) cov = max(cov, seg(p, vec2(x + t, y), vec2(w - 2.0 * t, t)));',
    '    if (bit(m, 2.0) > 0.5) cov = max(cov, seg(p, vec2(x + w - t, y + t - g), vec2(t, hh - t - g)));',
    '    if (bit(m, 4.0) > 0.5) cov = max(cov, seg(p, vec2(x + w - t, y + hh + g), vec2(t, hh - t - g)));',
    '    if (bit(m, 8.0) > 0.5) cov = max(cov, seg(p, vec2(x + t, y + h - t), vec2(w - 2.0 * t, t)));',
    '    if (bit(m, 16.0) > 0.5) cov = max(cov, seg(p, vec2(x, y + hh + g), vec2(t, hh - t - g)));',
    '    if (bit(m, 32.0) > 0.5) cov = max(cov, seg(p, vec2(x, y + t - g), vec2(t, hh - t - g)));',
    '    if (bit(m, 64.0) > 0.5) cov = max(cov, seg(p, vec2(x + t, y + hh - t * 0.5), vec2(w - 2.0 * t, t)));',
    '    put(u_dcol, cov);',
    '}',
    'void digits(vec2 p) {',
    '    if (p.y < 62.0 || p.y > 96.0) return;',
    '    digit(p, 76.0, u_dig.x); digit(p, 97.0, u_dig.y); digit(p, 118.0, u_dig.z); digit(p, 139.0, u_dig.w);',
    '}',
    '#endif',
    '#ifdef RAMP',
    // the G80 band: its lower edge climbs from (34, 74) to the knee (104, 30), then runs flat to x 372; fields
    // 11 px high, their tops 4 px to the right; the revs run along the lower edge by length
    'void ramp(vec2 p) {',
    '    vec2 A = vec2(34.0, 74.0), K = vec2(104.0, 30.0), sl = vec2(4.0, -11.0);',
    '    float aL = length(K - A), all = aL + 268.0;',
    '    vec2 u = (K - A) / aL, d = p - A;',
    '    float det = u.x * sl.y - sl.x * u.y;',
    '    float s = (d.x * sl.y - sl.x * d.y) / det, v = (u.x * d.y - u.y * d.x) / det;',
    '    if (s > aL) { v = (K.y - p.y) / 11.0; s = p.x - 4.0 * v - K.x + aL; }',
    '    float r = s / all * u_max, top = min(u_rpm, u_max);',
    '    float i0 = floor(r / 500.0 + 0.5) - 1.0;',
    '    for (int n = 0; n < 2; n++) {',
    '        float i = i0 + float(n), a = i * 500.0;',
    '        if (i >= 0.0 && a < top) {',
    '            float sa = a / u_max * all + 1.2, sb = min(top, a + 500.0) / u_max * all - 1.2;',
    '            vec4 c = segCol(i);',
    '            if (sb > sa && c.a > 0.0) put(c, cover(max(max(sa - s, s - sb), max(-v, v - 1.0) * 11.0)));',
    '        }',
    '    }',
    '}',
    '#endif',
    '#ifdef DIAL',
    // the E60 dial: round (200, 70), radii 50..60, from -125 to 110 degrees (0 up, clockwise), 250 rpm a
    // segment with a 0.9 degree gap after each full 1000
    'void dial(vec2 p) {',
    '    vec2 d = p - vec2(200.0, 70.0);',
    '    float rr = length(d);',
    '    if (rr < 48.0 || rr > 62.0) return;',
    '    float ang = degrees(atan(d.x, -d.y)), span = 235.0;',
    '    float r = (ang + 125.0) / span * u_max, top = min(u_rpm, u_max), px = rr * 0.0174533;',
    '    float i0 = floor(r / 250.0 + 0.5) - 1.0;',
    '    for (int n = 0; n < 2; n++) {',
    '        float i = i0 + float(n), a = i * 250.0;',
    '        if (i >= 0.0 && a < top) {',
    '            float b = min(top, a + 250.0);',
    '            float g = (a + 250.0 <= top && mod(a + 250.0, 1000.0) < 0.5) ? 0.9 : 0.0;',
    '            float a0 = -125.0 + a / u_max * span, a1 = -125.0 + b / u_max * span - g;',
    '            vec4 c = segCol(i);',
    '            if (a1 > a0 && c.a > 0.0) put(c, cover(max(max(a0 - ang, ang - a1) * px, max(50.0 - rr, rr - 60.0))));',
    '        }',
    '    }',
    '}',
    '#endif',
    'void main() {',
    '    vec2 p = v_uv * vec2(400.0, 130.0);',
    '    E = 400.0 / max(u_px.x, 1.0);',
    '    acc = vec4(0.0);',
    '#ifdef BAR',
    '    bar(p);',
    '#endif',
    '#ifdef GRAPH',
    '    graph(p);',
    '#endif',
    '#ifdef DIGITS',
    '    digits(p);',
    '#endif',
    '#ifdef RAMP',
    '    ramp(p);',
    '#endif',
    '#ifdef DIAL',
    '    dial(p);',
    '#endif',
    '#ifdef LIGHTS',
    '    lights(p);',
    '#endif',
    '    gl_FragColor = u_premul > 0.5 ? acc : (acc.a > 0.0 ? vec4(acc.rgb / acc.a, acc.a) : vec4(0.0));',
    '}',
].join('\n');

/** The fragment shader for a layout: GAUGE_FS with its parts switched on. */
function gaugeFs(style) { return (GAUGE_PARTS[style] || []).map((p) => '#define ' + p + ' 1\n').join('') + GAUGE_FS; }

/** A colour from the drawing code ('#rrggbb', '#rrggbbaa' or withAlpha's [r, g, b, a 0..255]) as 0..1 rgba. */
function rgba(c) {
    if (Array.isArray(c)) return [c[0] / 255, c[1] / 255, c[2] / 255, (c.length > 3 ? c[3] : 255) / 255];
    const s = String(c || '').replace('#', ''), n = (i) => parseInt(s.slice(i, i + 2), 16) / 255;
    return s.length >= 6 ? [n(0), n(2), n(4), s.length >= 8 ? n(6) : 1] : [0, 0, 0, 0];
}
const SEG_BITS = { a: 1, b: 2, c: 4, d: 8, e: 16, f: 32, g: 64 };

/** What a drawing pass hands over instead of drawing. */
function newSink() {
    return {
        lights: [], segs: {}, bar: null, graph: null, digits: null, band: null,
        light(x, y, r, shape, c) { this.lights.push([x, y, r, shape === 'rect' ? 1 : shape === 'ring' ? 2 : 0, c]); },
        seg(i, c) { this.segs[Math.round(i)] = c; },
        bar(x, y, w, h, slant, max, outline) { this.bar = [x, y, w, h, slant, outline ? 1 : 0]; },
        graph(x, top, sw, sh) { this.graph = [x, top, sw, sh]; },
        digits(str, c) { this.digits = [str, c]; },
        band(kind) { this.band = kind; },
    };
}
// a canvas that draws nothing (text widths unknown: labels keep their size)
const NULL_CV = { w: 400, h: 130 };
['text', 'fillRect', 'circle', 'arc', 'quad', 'polyline', 'line', 'roundRect', 'strokeRoundRect', 'blit', 'clear', 'convex'].forEach((k) => { NULL_CV[k] = () => {}; });

/**
 * The effect layer for the other layouts. h: { drawLayer, SEG7 } from hud-draw (passed in: hud-draw requires
 * this file's caller, not the other way round). update(f) sends what changed.
 */
class GpuGauge {
    constructor(cr, style, h, log) { this.cr = cr; this.style = style; this.h = h; this.log = log; this.ref = 0; this.sent = {}; this.w = 400; }
    make(r, premul) {
        this.w = r.w;
        // over the picture: the lit parts cover the ghosts and tracks under them
        this.ref = this.cr.effect({ target: 'hud', klass: 'overlay', z: 1, x: r.x, y: r.y, w: r.w, h: r.h, fs: gaugeFs(this.style) });
        this.sent = {};
        if (this.ref) this.cr.uniform(this.ref, 'u_premul', [premul ? 1 : 0]);
        return this.ref;
    }
    /** The two drawing passes for frame f: { now (the real revs), all (the revs at the top) }. */
    collect(f) {
        const pass = (rpm) => {
            const sink = newSink();
            const g = Object.assign({}, f, { d: Object.assign({}, f.d, { rpm: rpm }), opts: Object.assign({}, f.opts, { gpuSink: sink }) });
            this.h.drawLayer(NULL_CV, g, 'fg');
            return sink;
        };
        return { now: pass(f.d.rpm), all: pass(f.max) };
    }
    uniforms(f) {
        const s = this.collect(f), u = {};
        const rpm = typeof f.d.rpm === 'number' && isFinite(f.d.rpm) && f.d.rpm > 50 ? Math.min(f.d.rpm, f.max) : 0;
        u.u_px = [this.w, this.w * 130 / 400];
        // the revs to 1/1600 of the scale: about a pixel on a 140 % HUD
        u.u_rpm = [Math.round(rpm / f.max * 1600) / 1600 * f.max];
        u.u_max = [f.max];
        const parts = GAUGE_PARTS[this.style] || [];
        if (parts.indexOf('LIGHTS') >= 0) {
            const lp = [], lc = [];
            for (let i = 0; i < 12; i++) {
                const l = s.now.lights[i];
                lp.push.apply(lp, l ? [l[0], l[1], l[2], l[3]] : [0, 0, 0, 0]);
                lc.push.apply(lc, l ? rgba(l[4]) : [0, 0, 0, 0]);
            }
            u.u_lp = lp; u.u_lc = lc;
        }
        if (parts.some((p) => p === 'BAR' || p === 'GRAPH' || p === 'RAMP' || p === 'DIAL')) {
            const sc = [];
            for (let i = 0; i < NSEG; i++) sc.push.apply(sc, s.all.segs[i] !== undefined ? rgba(s.all.segs[i]) : [0, 0, 0, 0]);
            u.u_sc = sc;
        }
        if (parts.indexOf('BAR') >= 0) {
            const b = s.all.bar || s.now.bar || [0, 0, 0, 1, 0, 0];
            u.u_bar = [b[0], b[1], b[2], b[3]]; u.u_bar2 = [b[4], b[5]];
        }
        if (parts.indexOf('GRAPH') >= 0) u.u_gr = (s.all.graph || s.now.graph || [0, 0, 1, 1]).slice(0, 4);
        if (parts.indexOf('DIGITS') >= 0) {
            const dg = s.now.digits, str = dg ? dg[0] : '', segs = this.h.SEG7 || {};
            u.u_dig = [0, 1, 2, 3].map((i) => (segs[str[i]] || '').split('').reduce((m, k) => m + (SEG_BITS[k] || 0), 0));
            u.u_dcol = dg ? rgba(dg[1]) : [0, 0, 0, 0];
        }
        return u;
    }
    update(f) {
        if (!this.ref) return;
        const u = this.uniforms(f);
        Object.keys(u).forEach((k) => {
            const v = u[k], key = v.map((x) => Math.round(x * 1000) / 1000).join(',');
            if (this.sent[k] === key) return;
            this.sent[k] = key;
            const type = k === 'u_bar2' || k === 'u_px' ? 'vec2' : v.length >= 4 ? 'vec4' : undefined;
            this.cr.uniform(this.ref, k, v, type ? { type: type } : undefined);
        });
    }
    drop() { if (this.ref) this.cr.drop(this.ref); this.ref = 0; this.sent = {}; }
}
// what the picture's drawing hands the GPU while the GPU draws: nothing kept
const DROP_SINK = { light() {}, seg() {}, bar() {}, graph() {}, digits() {}, band() {} };

module.exports = { ARC_FS, arcUniforms, GpuArc, GAUGE_PARTS, GAUGE_FS, gaugeFs, GpuGauge, newSink, rgba, DROP_SINK };
