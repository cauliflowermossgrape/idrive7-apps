'use strict';

// Redline HUD: the parts that run without a head unit or cluster-render.
//   node kit/tools/test_redline_hud.js
// - every layout, palette and switch combination draws both layers without throwing, and the Rev bar
//   switch really removes the bar;
// - the readouts row: units, the four-item cap (a cold / hot warning keeps its place), missing data;
// - the shift cue: counts in, flashes before the point by the lead, holds, ends on the upshift, a
//   lift or the drop after a shift without a gear signal, and flags the limiter;
// - the scripted demo drive stays in range; settings in the code exist in app.json and vice versa.

const fs = require('fs');
const path = require('path');
const Module = require('module');
const ROOT = path.join(__dirname, '..', '..');
const APP = path.join(ROOT, 'apps', 'redline');

// the app requires the kit as './kit/...' (where the build puts it)
const load = Module._load;
Module._load = function (req, parent, isMain) {
    if (req.startsWith('./kit/')) return load.call(this, path.join(ROOT, 'kit', 'runtime', req.slice(6)), parent, isMain);
    return load.call(this, req, parent, isMain);
};
const Hud = require(path.join(APP, 'hud'));
const Draw = require(path.join(APP, 'hud-draw'));
const { Canvas } = require(path.join(ROOT, 'kit', 'runtime', 'canvas'));

let fails = 0, checks = 0;
const ok = (cond, msg) => { checks++; if (!cond) { fails++; console.log('FAIL ' + msg); } };

/* ---------- settings: every key the HUD code reads is declared, with the default it expects ---------- */
const spec = JSON.parse(fs.readFileSync(path.join(APP, 'app.json'), 'utf8'));
const declared = {};
spec.settings.forEach((s) => { if (s.key) declared[s.key] = s; });
const src = ['hud.js', 'hud-draw.js', 'main.js'].map((f) => fs.readFileSync(path.join(APP, f), 'utf8')).join('\n');
const used = {};
src.replace(/settings\.(?:get|set)\('(hud[A-Za-z]*)'/g, (m, k) => { used[k] = true; return m; });
src.replace(/on\('(hud[A-Za-z]*)'\)/g, (m, k) => { used[k] = true; return m; });
Object.keys(used).forEach((k) => ok(declared[k], 'setting ' + k + ' is used but not in app.json'));
Object.keys(declared).filter((k) => /^hud/.test(k)).forEach((k) => ok(used[k] || /hudLead|hudFps|hudSize|hudX|hudY|hudUnlit|hudStyle|hudPalette|hudChip|hudPeak|hudShake|hudLightStyle|hudTempsMode|hudTempUnit|hudBoostUnit|hudTorqueUnit|hudPowerUnit/.test(k) && src.indexOf("'" + k + "'") >= 0,
    'setting ' + k + ' is in app.json but never read'));

const settingsOf = (over) => ({
    get: (k) => (over && k in over ? over[k] : declared[k] ? declared[k].default : undefined),
});
const optsDefault = Hud.optsFrom(settingsOf());
ok(optsDefault.bar === true && optsDefault.rpm === true && optsDefault.lights === true, 'defaults: rev bar, rpm readout and lights on');
ok(optsDefault.torque === false && optsDefault.power === false && optsDefault.g === false && optsDefault.throttle === false && optsDefault.outside === false, 'defaults: the extra readouts are off');

/* ---------- drawing: every layout, palette and switch, both layers ---------- */
const LAYOUTS = ['standard', 'minimal', 'wings', 'digital', 'vfd', 'vector'];
const lit = (cv) => { let n = 0; for (let i = 3; i < cv.d.length; i += 4) if (cv.d[i]) n++; return n; };
function frame(o, extra) {
    return Object.assign({
        d: { rpm: 5200, gear: 3, stage: 'D' }, shift: 5550, redline: 6550, max: 8000, blink: true, down: 2, peak: 6100,
        chip: { verdict: 'LATE', age: 300, burst: true }, cue: { from: 4050, at: 5550, shift: false, limiter: false },
        readouts: [{ label: 'BOOST', value: '1.2', tone: 'text' }, { label: 'OIL', value: '41°', tone: 'cold' }], mode: 'M', opts: o,
    }, extra || {});
}
LAYOUTS.forEach((style) => ['colour', 'amber', 'ice'].forEach((palette) => [true, false].forEach((on) => {
    const o = Object.assign({}, optsDefault, { style: style, palette: palette, bar: on, lights: on, gt3: on, rpm: on, gear: on, mode: on, peak: on });
    ['bg', 'fg', 'both'].forEach((layer) => {
        const cv = new Canvas(Draw.IW, Draw.IH);
        try { Draw.drawLayer(cv, frame(o, { cue: { from: 4050, at: 5550, shift: on, limiter: !on } }), layer); }
        catch (e) { ok(false, style + '/' + palette + '/' + layer + ' threw: ' + e.message); }
    });
})));
// the Rev bar switch removes the bar (minimal has none to remove)
LAYOUTS.filter((s) => s !== 'minimal').forEach((style) => {
    const px = (bar) => { const cv = new Canvas(Draw.IW, Draw.IH); Draw.drawLayer(cv, frame(Object.assign({}, optsDefault, { style: style, bar: bar }), { readouts: [], chip: null }), 'both'); return lit(cv); };
    ok(px(false) < px(true) * 0.6, style + ': Rev bar off still draws most of the bar');
});
// only the shift lights (everything else off) still draws something
{
    const o = Object.assign({}, optsDefault, { style: 'vfd', bar: false, rpm: false, gear: false, mode: false });
    const cv = new Canvas(Draw.IW, Draw.IH);
    Draw.drawLayer(cv, frame(o, { readouts: [], chip: null, down: 0 }), 'both');
    ok(lit(cv) > 200, 'VFD with only the shift lights draws them');
}

/* ---------- readouts ---------- */
const o = Object.assign({}, optsDefault, { rpm: true, boost: true, torque: true, power: true, throttle: true, g: true, outside: true,
    boostUnit: 'psi', torqueUnit: 'lbft', powerUnit: 'hp', smartTemps: true });
const x = { torque: 420, pedal: 97, gLat: 0.6, gLong: -0.8, outside: 2 };
let r = Hud.readoutsFor({ rpm: 5500, oil: 40, coolant: 90 }, 70, 1.2, { rpm: 4500, cold: true }, o, x);
ok(r.length === Hud.MAX_READOUTS, 'at most ' + Hud.MAX_READOUTS + ' readouts: ' + r.length);
ok(r.some((it) => it.label === 'OIL' && it.tone === 'cold'), 'a cold oil temperature keeps its place');
ok(r.some((it) => it.label === 'LIMIT'), 'the cold limit keeps its place');
ok(!r.some((it) => it.label === 'WATER'), 'water at operating temperature is hidden (smart temps)');
r = Hud.readoutsFor({ rpm: 5500 }, null, null, null, Object.assign({}, o, { rpm: false, boost: false, oil: false, coolant: false, gearbox: false, outside: false, throttle: false, g: false, powerUnit: 'kw', torqueUnit: 'nm' }), { torque: 400 });
ok(JSON.stringify(r) === JSON.stringify([{ label: 'TORQUE', value: '400', tone: 'text' }, { label: 'KW', value: '230', tone: 'text' }]), 'torque Nm and power kW: ' + JSON.stringify(r));
r = Hud.readoutsFor({ rpm: 3000 }, null, null, null, Object.assign({}, o, { rpm: false, boost: false, torque: false, power: false, oil: false, coolant: false, gearbox: false, outside: false }), { pedal: 101.7, gLat: 0.31, gLong: 0.4 });
ok(r[0] && r[0].value === '100%' && r[1] && r[1].label === 'G' && r[1].value === '0.50', 'throttle clamps to 100 %, g combined: ' + JSON.stringify(r));
r = Hud.readoutsFor({ rpm: 5500, oil: 100, coolant: 90 }, 80, 1.0, { rpm: 5500, cold: false }, o, null);
ok(r.every((it) => typeof it.value === 'string'), 'no extras (null): no crash, no NaN');
ok(!r.some((it) => /NaN|undefined/.test(it.value)), 'no NaN or undefined in a value');
r = Hud.readoutsFor({ rpm: 5500 }, null, null, null, Object.assign({}, o, { rpm: false, boost: false, torque: false, power: false, throttle: false, g: false, oil: false, coolant: false, gearbox: false, fahrenheit: true }), { outside: -5 });
ok(r[0] && r[0].value === '23°' && r[0].tone === 'cold', 'outside in °F, blue near freezing: ' + JSON.stringify(r));
r = Hud.readoutsFor({ rpm: 5500 }, null, null, null, Object.assign({}, o, { style: 'vfd', boost: false, torque: false, power: false, throttle: false, g: false, outside: false }), {});
ok(!r.some((it) => it.label === 'RPM'), 'the VFD layout has its own rpm digits, no RPM readout');

/* ---------- shift cue ---------- */
function drive(samples, shift, lead) {
    const st = {}, out = [];
    samples.forEach((s) => out.push(Hud.shiftCue(st, s[1], s[0], shift, 6550, lead, s[2])));
    return out;
}
// a steady 1000 rpm/s climb in 3rd from 3800, 20 samples a second
const climb = [];
for (let t = 0; t <= 2500; t += 50) climb.push([t, 3800 + t, 3]);
let c = drive(climb, 5550, 200);
const first = c.findIndex((q) => q.shift);
ok(first > 0 && climb[first][1] >= 5550 - 260 && climb[first][1] <= 5550, 'flashes before the point by about the lead: at ' + (first >= 0 ? climb[first][1] : 'never'));
ok(c.slice(first).every((q) => q.shift), 'the flash holds while the revs keep climbing');
// the upshift ends it
const up = climb.slice(0, first + 5).concat([[climb[first + 5][0] + 50, 4300, 4], [climb[first + 5][0] + 100, 4350, 4]]);
c = drive(up, 5550, 200);
ok(!c[c.length - 1].shift, 'the gear change ends the flash');
// a lift ends it after 300 ms of falling
const lift = climb.slice(0, first + 3), t0 = lift[lift.length - 1][0], r0 = lift[lift.length - 1][1];
for (let i = 1; i <= 10; i++) lift.push([t0 + i * 50, r0 - i * 40, 3]);
c = drive(lift, 5550, 200);
ok(c[first + 4].shift && !c[c.length - 1].shift, 'a short dip keeps it, a lift ends it');
// an upshift with no gear signal: the drop ends it
const nogear = climb.slice(0, first + 3).map((s) => [s[0], s[1], undefined]);
nogear.push([nogear[nogear.length - 1][0] + 50, 4200, undefined]);
c = drive(nogear, 5550, 200);
ok(!c[c.length - 1].shift, 'a 12 % drop ends it without a gear signal');
// the limiter, and no data
c = drive([[0, 6000, 3], [50, 6200, 3], [100, 6400, 3], [150, 6515, 3]], 5550, 200);
ok(c[c.length - 1].limiter && !c[1].limiter, 'limiter within 40 of the redline only');
// the drawn rpm runs ahead of the samples on a climb: it must not light the limiter on its own
{ const st = {}; let q; [[0, 6000], [50, 6200], [100, 6400], [150, 6400]].forEach((s) => { q = Hud.shiftCue(st, s[1], s[0], 6400, 6550, 0, 3, s[1] + 250); });
    ok(!q.limiter, 'a drawn rpm ahead of the real one does not flash the limiter'); }
c = drive([[0, null, 3], [50, undefined, 3]], 5550, 200);
ok(c.every((q) => !q.shift && !q.limiter), 'no rpm: nothing lit');

/* ---------- driving mode (Comfort / Eco Pro) ---------- */
[[1, 'sport'], [2, 'sport'], [3, 'sport'], [4, 'comfort'], [5, 'comfort'], [6, 'comfort'], [7, 'eco'], [9, 'eco'], [10, null], [0, null], [63, null],
    ['SPORT_DYNAMIC', 'sport'], ['SPORT_EXPERT', 'sport'], ['ECO_PRO_EFFICIENT', 'eco'], ['COMFORT', 'comfort'], ['ADAPTIVE', null], [null, null], [undefined, null], ['', null]]
    .forEach((c) => ok(Hud.driveModeOf(c[0]) === c[1], 'driving mode ' + JSON.stringify(c[0]) + ' -> ' + Hud.driveModeOf(c[0]) + ', not ' + c[1]));
ok(Hud.calmFor('sport', 'hide') === 'all' && Hud.calmFor(null, 'hide') === 'all', 'Sport and an unknown mode show everything');
ok(Hud.calmFor('comfort', 'hide') === 'hide' && Hud.calmFor('eco', 'lights') === 'lights' && Hud.calmFor('comfort', undefined) === 'all', 'Comfort / Eco Pro follow the setting');
{
    const c = Hud.calmOpts(Object.assign({}, optsDefault, { torque: true, g: true }));
    ok(c.lights && c.bar && c.gear && !c.rpm && !c.oil && !c.torque && !c.g && c.chip === 'off' && !c.peak, 'lights + gear only: readouts, grade and peak off');
    ok(Hud.readoutsFor({ rpm: 5000, oil: 30, coolant: 30 }, 30, 1.2, { rpm: 4000, cold: true }, c, { torque: 300 }).length === 0, 'lights + gear only: no readouts, not even cold temps');
}

/* ---------- RPM readout format, refresh, clearer labels ---------- */
ok(Hud.rpmItem(4537, '10').value === '4540' && Hud.rpmItem(4537, '50').value === '4550' && Hud.rpmItem(4537, 'k').value === '4.5', 'rpm to 10, to 50, in thousands');
ok(Hud.rpmItem(-20, 'k').value === '0.0' && Hud.rpmItem(6960, 'k').value === '7.0', 'thousands: clamped, rounded');
ok(optsDefault.rpmFormat === '10' && optsDefault.readoutMs === 250 && !optsDefault.clearLabels, 'defaults: to 10, 4 a second, normal labels');
{ const o = Hud.optsFrom(settingsOf({ hudRpmFormat: 'k', hudReadoutRate: 10, hudLabels: 'clear' }));
    ok(o.rpmFormat === 'k' && o.readoutMs === 100 && o.clearLabels, 'thousands, 10 a second, clearer labels');
    ok(Hud.readoutsFor({ rpm: 3260 }, null, null, null, Object.assign({}, optsDefault, o, { boost: false, oil: false, coolant: false, gearbox: false }), {})[0].value === '3.3', 'readouts row uses the format'); }

/* ---------- shift light colours follow the app's "Shift light style" ---------- */
{
    const P = Draw.PALETTES.colour, at = (st, n) => Array.from({ length: n }, (_, i) => Draw.lightCol(st, P, i / (n - 1)));
    const m = at('m', 12), f1 = at('f1', 12);
    ok(m[0] === P.low && m.indexOf(P.mid) > 0 && m[11] === P.high, 'M: green, yellow, red');
    ok(f1[0] === P.low && f1.indexOf(P.mid) < 0 && f1[6] === P.high && f1[11] !== P.high && f1[11] !== P.low, 'Race: green, red, blue (no yellow)');
    ok(at('f1', 6).slice(0, 5).indexOf(P.high) > 0, 'Race on 6 GT3 steps: red before the flash');
    ok(at('mono', 12).every((c) => c === P.text), 'Theme colour: one colour');
}

/* ---------- the demo drive ---------- */
for (let t = 0; t < Hud.DEMO_MS * 3; t += 37) {
    const d = Hud.demoAt(t);
    if (!(d.rpm >= 0 && d.rpm <= 8000 && d.gear >= 1 && d.gear <= 8 && d.pedal >= 0 && d.pedal <= 100)) { ok(false, 'demo out of range at ' + t + ': ' + JSON.stringify(d)); break; }
}

console.log(fails ? fails + ' of ' + checks + ' Redline HUD checks failed' : 'Redline HUD checks passed (' + checks + ').');
process.exit(fails ? 1 : 0);
