'use strict';
/**
 * Part of Redline's experimental features; README.md in this folder has the whole picture.
 *
 * The HUD drawn by the GPU (setting "hudRenderer": GPU, experimental; the Arc layout for now). The
 * moving parts - the 8 lights, the band, its ticks and zones, the peak line and the flash's blink - are a
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
    constructor(cr, h, log) { this.cr = cr; this.h = h; this.log = log; this.ref = 0; this.sent = {}; this.w = 400; }
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

module.exports = { ARC_FS, arcUniforms, GpuArc };
