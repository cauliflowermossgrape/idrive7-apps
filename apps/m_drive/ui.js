'use strict';
const { t: translate } = require('./kit/i18n');
const { ACTIONS, GROUPS, REDLINE } = require('./model');

const W = 1600, H = 520, L = 48, CW = 1504;
const R = 86, BW = 146, BH = 56, GAP = 12, GGAP = 56;
const CX = [0, 1, 2, 3, 4].map((i) => Math.round(L + (CW / 5) * (i + 0.5)));

const DIALS = [
    { key: 'oil', label: 'Engine oil', unit: '°C', min: 40, max: 160, warn: 130, crit: 140, cold: 70 },
    { key: 'coolant', label: 'Coolant', unit: '°C', min: 40, max: 140, warn: 112, crit: 120, cold: 60 },
    { key: 'gearbox', label: 'Gearbox oil', unit: '°C', min: 40, max: 160, warn: 110, crit: 120, cold: 50 },
    { key: 'iat', label: 'Intake air', unit: '°C', min: -20, max: 120, warn: 55, crit: 65 },
    { key: 'boost', label: 'Boost', unit: 'bar', min: 0, max: 3, decimals: 2 },
];

const RECTS = (() => {
    const out = {};
    let x = L + Math.round((CW - (ACTIONS.length * BW + (ACTIONS.length - GROUPS.length) * GAP + (GROUPS.length - 1) * GGAP)) / 2);
    GROUPS.forEach((g) => {
        const ids = ACTIONS.filter((a) => a.group === g.id).map((a) => a.id);
        const xs = ids.map((id, i) => x + i * (BW + GAP));
        out[g.id] = { ids, xs, x: xs[0], right: xs[xs.length - 1] + BW };
        x = out[g.id].right + GGAP;
    });
    return out;
})();

const caps = (s) => translate(s).toUpperCase();
const tone = (t, k) => (k === 'warn' ? t.warn : k === 'go' ? t.accent2 : t.dim);

function badge(v) {
    if (v.mode === 'demo') return { text: 'DEMO' };
    if (v.mode === 'disarmed') return { text: 'CONTROLS OFF', color: 'dim' };
    return v.link ? { text: 'LIVE', color: 'accent2' } : { text: 'NO LINK' };
}

function draw(cv, G, t, v, act) {
    cv.clear(t.bg);
    G.frame(cv, t, ['M Drive'], 0, [badge(v)]);
    const P = G.panel(cv, t, 24, G.TOP, W - 48, G.BOTTOM - G.TOP, null);
    const B = P.y + P.h;
    drawRpm(cv, G, t, v.telemetry.rpm);
    drawDials(cv, G, t, v.telemetry, 261 + Math.round((B - G.BOTTOM) * 0.6));
    drawControls(cv, G, t, v.commands, act || {}, B);
    return cv;
}

function drawRpm(cv, G, t, rpm) {
    cv.text(caps('Engine speed'), L, 78, 22, t.dim, { font: 'bold', spacing: 2, literal: true });
    const uw = cv.textWidth(' rpm', 24);
    const shown = G.isNum(rpm) ? Math.round(G.hold('m_drive_rpm', rpm) / 10) * 10 : null;
    cv.text(G.fmt(shown), L + CW - uw, 90, 52, !G.isNum(rpm) ? t.dim : rpm >= REDLINE ? t.crit : t.text, { align: 'right', font: 'num' });
    cv.text(' rpm', L + CW, 90, 24, t.dim, { align: 'right' });
    G.segBar(cv, t, L, 98, CW, 26, {
        panel: false, value: rpm, min: 0, max: 8000, step: 500, ramp: 'hot', limit: REDLINE,
        scale: { every: 1000, div: 1000, tick: 8, labelY: 34, size: 20 }, marks: [{ value: REDLINE, color: 'crit' }],
    });
}

function drawDials(cv, G, t, d, cy) {
    DIALS.forEach((s, i) => {
        const cx = CX[i];
        const zones = s.warn == null ? [] : [{ from: s.warn, to: s.crit, color: 'warn' }, { from: s.crit, to: s.max, color: 'crit' }];
        if (s.cold != null) zones.push({ from: s.min, to: s.cold, color: 'cold', tintOnly: true });
        G.radial(cv, t, cx, cy, R, {
            value: d[s.key], min: s.min, max: s.max, unit: s.unit, decimals: s.decimals || 0, ticks: 10, majorEvery: 2,
            tickLabels: false, zones, limit: s.crit == null ? s.max : s.crit,
        });
        cv.text(G.fmt(s.min), cx - 78, cy + 76, 18, t.dim, { align: 'right' });
        cv.text(G.fmt(s.max), cx + 78, cy + 76, 18, t.dim, { align: 'left' });
        cv.text(caps(s.label), cx, cy + 97, 22, t.text, { align: 'center', font: 'bold', spacing: 1.5, literal: true });
    });
}

function drawControls(cv, G, t, c, act, B) {
    const gl = B - 116, by = B - 108, sb = B - 28;
    GROUPS.forEach((g, gi) => {
        const r = RECTS[g.id], chip = c[g.id].chip;
        cv.text(caps(g.title), r.x, gl, 18, t.dim, { font: 'bold', spacing: 2, literal: true });
        if (chip) cv.text(chip.text, r.right, gl, 16, tone(t, chip.tone), { align: 'right' });
        if (gi < GROUPS.length - 1) cv.fillRect(r.right + GGAP / 2, gl - 16, 1, by + BH - gl + 16, G.withAlpha('#ffffff', 0.12));
    });
    ACTIONS.forEach((a) => {
        const r = RECTS[a.group], g = c[a.group];
        pill(cv, G, t, r.xs[r.ids.indexOf(a.id)], by, a, g.selected === a.value ? g.lit : null, g.busy, act[a.id]);
    });
    if (c.status) {
        const r = RECTS[c.status.group], g = c.status.group;
        const x = g === 'map' ? r.x : g === 'cooling' ? r.right : (r.x + r.right) / 2;
        cv.text(c.status.text, x, sb, 18, tone(t, c.status.tone), { align: g === 'map' ? 'left' : g === 'cooling' ? 'right' : 'center' });
    }
}

// G.button draws only where the kit runs the screen; elsewhere the HMI's bar has the buttons and the page shows
// the same pills as state
function pill(cv, G, t, x, y, a, lit, busy, run) {
    const o = lit === 'live' ? { color: t.crit, primary: true } : lit === 'demo' ? { color: t.warn } : {};
    o.key = 'm_drive_' + a.id;
    o.busy = !!busy && !(a.group === 'flap' && a.value === 'OEM');
    if (cv.own) {
        G.button(cv, t, x, y, BW, BH, a.label, run, o);
        if (o.busy && run) cv.target(x, y, BW, BH, () => {}, o.key);
        return;
    }
    cv.roundRect(x, y, BW, BH, BH / 2, o.primary ? G.withAlpha(o.color, o.busy ? 0.35 : 0.85) : G.withAlpha('#ffffff', 0.07));
    if (!o.primary) cv.strokeRoundRect(x, y, BW, BH, BH / 2, 1.5, G.withAlpha(o.color || '#ffffff', o.busy ? 0.25 : o.color ? 0.75 : 0.3));
    cv.text(String(a.label).toUpperCase(), x + BW / 2, y + BH / 2 + BH * 0.15, BH * 0.4, o.primary ? '#ffffff' : o.busy ? t.dim : o.color || t.text,
        { align: 'center', font: 'bold', spacing: 1.5 });
}

module.exports = { draw, W, H, DIALS, RECTS };
