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
Object.keys(declared).filter((k) => /^hud/.test(k)).forEach((k) => ok(used[k] || k === 'hudAll' || /hudLead|hudFps|hudSize|hudX|hudY|hudUnlit|hudStyle|hudPalette|hudChip|hudPeak|hudShake|hudLightStyle|hudTempsMode|hudTempUnit|hudBoostUnit|hudTorqueUnit|hudPowerUnit/.test(k) && src.indexOf("'" + k + "'") >= 0,
    'setting ' + k + ' is in app.json but never read'));

const settingsOf = (over) => ({
    get: (k) => (over && k in over ? over[k] : declared[k] ? declared[k].default : undefined),
});
const optsDefault = Hud.optsFrom(settingsOf());
ok(optsDefault.bar === true && optsDefault.rpm === true && optsDefault.lights === true, 'defaults: rev bar, rpm readout and lights on');
ok(optsDefault.torque === false && optsDefault.power === false && optsDefault.g === false && optsDefault.throttle === false && optsDefault.outside === false, 'defaults: the extra readouts are off');

/* ---------- drawing: every layout, palette and switch, both layers ---------- */
const LAYOUTS = ['standard', 'minimal', 'wings', 'digital', 'vfd', 'vector', 'arc', 'ramp', 'dial'];
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
// the Rev bar switch removes the bar (minimal has none to remove; on ramp and dial the band is the shift
// lights too, so it stays while they are on)
LAYOUTS.filter((s) => ['minimal', 'ramp', 'dial'].indexOf(s) < 0).forEach((style) => {
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
ok(Hud.calmFor('comfort', 'hide') === 'hide' && Hud.calmFor('eco', 'hide') === 'hide' && Hud.calmFor('comfort', 'own') === 'all' && Hud.calmFor('comfort', undefined) === 'all', 'Comfort / Eco Pro: hidden only when set so');

/* ---------- the Sport / Comfort profiles ---------- */
{
    const store = (over) => { const v = Object.assign({}, over); return { values: v, get: (k) => (k in v ? v[k] : declared[k] ? declared[k].default : undefined), set: (k, x) => { v[k] = x; } }; };
    // Sport is the settings themselves; Comfort follows it until it is changed
    let st = store({ hudStyle: 'arc', hudShowTorque: true });
    let sp = Hud.profileView(st, 'sport'), cf = Hud.profileView(st, 'comfort');
    ok(Hud.optsFrom(cf).style === 'arc' && Hud.optsFrom(st, 'comfort').style === 'arc' && Hud.comfortMode(st) === 'same', 'profiles: Comfort follows Sport by default');
    // a Comfort edit gives it its own copy (Sport's values), and changes only Comfort
    cf.set('hudStyle', 'dial');
    ok(Hud.comfortMode(st) === 'own' && Hud.optsFrom(cf).style === 'dial' && Hud.optsFrom(sp).style === 'arc', 'profiles: a Comfort edit makes it its own; Sport keeps its layout');
    ok(Hud.optsFrom(cf).torque === true, 'profiles: Comfort own starts as a copy of Sport (torque readout kept)');
    sp.set('hudShowTorque', false);
    ok(Hud.optsFrom(cf).torque === true && Hud.optsFrom(sp).torque === false, 'profiles: after that, Sport changes stay in Sport');
    // shared keys (place, units, light colours) are one for both, whichever profile changes them
    cf.set('hudSize', 120);
    ok(st.get('hudSize') === 120 && !('hudSize' in st.get('hudComfortSetup')), 'profiles: size is shared');
    // the driving mode picks the profile; Sport+ and an unknown mode use Sport
    ok(Hud.optsFrom(st, 'comfort').style === 'dial' && Hud.optsFrom(st, 'eco').style === 'dial' && Hud.optsFrom(st, 'sport').style === 'arc' && Hud.profileOf(null) === 'sport', 'profiles: the mode picks one');
    // Same as Sport again: Comfort's setup is kept (back with Its own), Sport shows
    Hud.setComfortMode(st, 'same');
    ok(Hud.optsFrom(st, 'comfort').style === 'arc', 'profiles: Same as Sport');
    Hud.setComfortMode(st, 'own');
    ok(Hud.optsFrom(st, 'comfort').style === 'dial', 'profiles: Its own again: its setup kept');
    // Its own from Settings with no setup yet: a copy of Sport's
    st = store({ hudStyle: 'ramp' }); Hud.setComfortMode(st, 'own');
    ok(Hud.optsFrom(st, 'comfort').style === 'ramp' && st.get('hudComfortSetup').hudStyle === 'ramp', 'profiles: Its own starts as Sport');
    // 1.14 / 1.15's "In Comfort": hide stays hidden; lights + gear becomes its own setup with no readouts; once
    st = store({ hudComfort: 'hide' });
    ok(Hud.migrateProfiles(st) === 'hide' && Hud.comfortMode(st) === 'hide' && Hud.migrateProfiles(st) === null, 'migration: hide, once');
    st = store({ hudComfort: 'lights', hudStyle: 'wings', hudShowOil: true, hudChip: 'burst' });
    const m = Hud.migrateProfiles(st), co = Hud.optsFrom(st, 'comfort');
    ok(m === 'lights' && Hud.comfortMode(st) === 'own' && co.style === 'wings' && !co.oil && !co.rpm && co.chip === 'off' && co.lights && co.gear, 'migration: lights + gear becomes Comfort without readouts');
    ok(Hud.optsFrom(st, 'sport').oil === true, 'migration: Sport untouched');
    st = store({});
    ok(Hud.migrateProfiles(st) === 'none' && Hud.comfortMode(st) === 'same', 'migration: nothing set, nothing changes');
}
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

/* ---------- the HUD looks page has every HUD setting (Settings shows them only with "All HUD options here") ---------- */
{
    const main = fs.readFileSync(path.join(APP, 'main.js'), 'utf8');
    const page = main.slice(main.indexOf('function drawLooks('), main.indexOf('function cycleRow('));
    const onPage = {};
    page.replace(/'([a-zA-Z]+)'/g, (m, k) => { onPage[k] = true; return m; });
    spec.settings.filter((s) => /^HUD: /.test(s.group || '') || s.key === 'hudStyle').forEach((s) => ok(onPage[s.key], 'setting ' + s.key + ' (' + s.group + ') is not on the HUD looks page'));
    // and Settings' top level is short: the HUD's details are behind "All HUD options here"
    const top = spec.settings.filter((s) => !s.group && !s.hidden);
    ok(top.length <= 6, 'Settings top level has ' + top.length + ' rows besides the groups: ' + top.map((s) => s.key).join(', '));
    spec.settings.filter((s) => /^HUD: /.test(s.group || '')).forEach((s) => ok(s.when && s.when.hudAll && s.when.hudAll[0] === true, s.key + ' shows in Settings without "All HUD options here"'));
}

/* ---------- 1.16: M layouts, gear font, placement, the reaction time, the test pattern ---------- */
{
    // the M layouts: every chip moment, the flash and the limiter, 0 to 4 readouts, clearer labels, both layers
    const items = [{ label: 'BOOST', value: '1.4', tone: 'text' }, { label: 'OIL', value: '104°', tone: 'hot' }, { label: 'WATER', value: '62°', tone: 'cold' }, { label: 'HP', value: '312', tone: 'text' }];
    Hud.M_STYLES.forEach((style) => [0, 150, 400, 1000, 1400].forEach((age) => [0, 1, 4].forEach((n) => [false, true].forEach((cl) => ['m', 'f1', 'mono'].forEach((ls) => {
        const o = Object.assign({}, optsDefault, { style: style, clearLabels: cl, lightStyle: ls, gearFont: 'gear_barlow' });
        ['bg', 'fg', 'both'].forEach((layer) => {
            const cv = new Canvas(Draw.IW, Draw.IH);
            try { Draw.drawLayer(cv, frame(o, { readouts: items.slice(0, n), chip: age ? { verdict: 'SPOT ON', age: age, burst: true } : null, cue: { from: 4050, at: 5550, shift: age === 400, limiter: age === 1000 } }), layer); }
            catch (e) { ok(false, style + ' age ' + age + ' readouts ' + n + ' ' + layer + ' threw: ' + e.message); }
        });
    })))));
    // the static layer of an M layout doesn't change with the rpm (it is cached by bgKey, which has no rpm)
    Hud.M_STYLES.forEach((style) => {
        const o = Object.assign({}, optsDefault, { style: style }), a = new Canvas(Draw.IW, Draw.IH), b = new Canvas(Draw.IW, Draw.IH);
        Draw.drawLayer(a, frame(o, { d: { rpm: 2000, gear: 2 }, cue: { from: 3000, at: 4000, shift: false, limiter: false } }), 'bg');
        Draw.drawLayer(b, frame(o, { d: { rpm: 6000, gear: 4 }, cue: { from: 5000, at: 6000, shift: false, limiter: false } }), 'bg');
        ok(Buffer.compare(Buffer.from(a.d), Buffer.from(b.d)) === 0, style + ': the static layer depends on something bgKey lacks');
    });
    // the Arc's right column: no label runs into its value, at either label size (the longest ones). The row is
    // drawn whole and with the value alone: the label is what the whole has and the value alone hasn't, and its
    // last column must be left of the value's first
    {
        const pairs = [['GEARBOX', '120°'], ['THROTTLE', '100%'], ['OUTSIDE', '-10°']];
        const draw = (cl, it) => {
            const o = Object.assign({}, optsDefault, { style: 'arc', clearLabels: cl }), cv = new Canvas(Draw.IW, Draw.IH);
            Draw.drawLayer(cv, frame(o, { chip: null, down: 0, mode: null, readouts: [{ label: '', value: '', tone: 'text' }, it] }), 'fg');
            return (x, y) => cv.d[(y * Draw.IW + x) * 4 + 3] > 40;
        };
        [false, true].forEach((cl) => pairs.forEach((p) => {
            const whole = draw(cl, { label: p[0], value: p[1], tone: 'text' }), alone = draw(cl, { label: '', value: p[1], tone: 'text' });
            let labEnd = -1, valStart = -1;
            for (let x = 300; x < Draw.IW; x++) for (let y = 88; y <= 107; y++) {
                if (alone(x, y) && valStart < 0) valStart = x;
                if (whole(x, y) && !alone(x, y)) labEnd = x;
            }
            ok(labEnd >= 0 && valStart >= 0 && labEnd < valStart, 'arc: ' + p[0] + ' ' + p[1] + (cl ? ' (clearer)' : '') + ' label reaches x ' + labEnd + ', value starts at ' + valStart);
        }));
    }
    // downshift arrows, "Best gear": the fewest drops into the power band (90 % of peak power on the curve)
    {
        const SM = require(path.join(APP, 'shiftmap'));
        const curve = [[2000, 300], [3000, 400], [4000, 400], [5000, 380], [6000, 330], [6500, 300]];   // power peaks ~6000
        const band = SM.prototype.bandStart.call({ curve: () => curve }, 0.9);
        ok(band === 5000, 'power band starts at 5000 on a curve peaking near 6000 (' + band + ')');
        ok(SM.prototype.bandStart.call({ curve: () => curve.slice(0, 3) }, 0.9) === null, 'no band from a short curve');
        const k = { 3: 35, 4: 27, 5: 22, 6: 18.5 }, rin = (g) => 150 * (k[g] || 0);      // 150 km/h: 6th 2775, 5th 3300, 4th 4050, 3rd 5250
        ok(SM.bestDrop(6, 3, rin, band) === 3 && SM.bestDrop(6, 2, rin, band) === 2, 'best: down to 3rd (5250, in the band); never past what is allowed');
        ok(SM.bestDrop(6, 3, rin, 2500) === 0 && SM.bestDrop(6, 3, rin, null) === 3 && SM.bestDrop(6, 0, rin, band) === 0, 'best: none when already in the band; all allowed without a band; none allowed');
    }
    // the knock warning shows on every layout (Minimal and Split wings, which show no grades: the gear goes red)
    LAYOUTS.forEach((style) => {
        const o = Object.assign({}, optsDefault, { style: style }), pic = (chip) => { const cv = new Canvas(Draw.IW, Draw.IH); Draw.drawLayer(cv, frame(o, { chip: chip, readouts: [] }), 'fg'); return Buffer.from(cv.d); };
        ok(Buffer.compare(pic(null), pic({ verdict: 'KNOCK', age: 800, burst: true })) !== 0, style + ': KNOCK changes nothing');
    });
    // the launch score: standing starts timed by the kit's run timer, against the best (kept in a file)
    {
        const LaunchScore = require(path.join(APP, 'launch'));
        const os = require('os'), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-launch-'));
        const quiet = { info() {}, warn() {} };
        let clock = 1e6;
        const realNow = Date.now; Date.now = () => clock;
        // stand 2 s, then a constant pull reaching 100 km/h in `secs`, on to 130, then slow down
        const run = (ls, secs) => {
            for (let t = 0; t <= 2000; t += 100) { clock += 100; ls.feed(clock, 0); ls.idle(clock); }
            const a = 100 / secs;
            for (let t = 50; t <= (130 / a) * 1000; t += 50) { clock += 50; ls.feed(clock, a * t / 1000); }
            for (let v = 130; v >= 90; v -= 5) { clock += 100; ls.feed(clock, v); }
        };
        let ls = new LaunchScore({ dataDir: dir, log: quiet });
        run(ls, 5.0);
        let l = ls.last(clock, false);
        ok(l && Math.abs(l.secs - 5.0) < 0.06 && l.delta === null && l.best && l.label === '0-100', 'launch: first run 0-100 in ~5.0 s, a best (' + JSON.stringify(l) + ')');
        run(ls, 4.8);
        l = ls.last(clock, false);
        ok(l && l.best && l.delta < -0.1 && l.delta > -0.3, 'launch: quicker run, a new best, its difference negative (' + (l && l.delta) + ')');
        run(ls, 5.4);
        l = ls.last(clock, false);
        ok(l && !l.best && l.delta > 0.4, 'launch: slower run, not a best (' + (l && l.delta) + ')');
        const m = ls.last(clock, true);
        ok(m && m.label === '0-60' && m.secs < l.secs, 'launch: the 0-60 mph time too');
        clock += 3100;
        ok(ls.last(clock, false) === null, 'launch: shown for 3 s');
        // the best is kept across a restart, and forgotten on reset
        ls = new LaunchScore({ dataDir: dir, log: quiet });
        ok(Math.abs(ls.bestOf(false) - 4.8) < 0.06, 'launch: best kept in the file (' + ls.bestOf(false) + ')');
        ls.forget();
        ok(ls.bestOf(false) === null && new LaunchScore({ dataDir: dir, log: quiet }).bestOf(false) === null, 'launch: Reset forgets it');
        Date.now = realNow;
    }
    // gear font: Auto is Barlow on the M layouts only; a missing atlas falls back to Ubuntu
    ok(Hud.gearFontOf('auto', 'arc') === 'gear_barlow' && Hud.gearFontOf('auto', 'standard') === 'gear' && Hud.gearFontOf(undefined, 'dial') === 'gear_barlow', 'gear font: Auto');
    ok(Hud.gearFontOf('ubuntu', 'ramp') === 'gear' && Hud.gearFontOf('barlow', 'wings') === 'gear_barlow', 'gear font: chosen');
    ok(Hud.optsFrom(settingsOf({ hudStyle: 'ramp' })).gearFont === 'gear_barlow' && Hud.optsFrom(settingsOf({ hudStyle: 'bogus' })).style === 'standard', 'optsFrom: M styles kept, unknown ones standard');
    ok(Draw.gearFont({ gearFont: 'gear_barlow' }) === 'gear_barlow' && Draw.gearFont({ gearFont: 'no_such_font' }) === 'gear' && Draw.gearFont({}) === 'gear', 'gear font falls back to Ubuntu');
    // placement and the windshield's window
    const at = (o) => Hud.placeOf(settingsOf(o));
    ok(JSON.stringify(at({})) === JSON.stringify({ x: 200, y: 140, w: 400, h: 130 }) && Object.keys(Hud.outsideGlass(at({}))).length === 0, 'place: default fully on the glass');
    ok(Hud.outsideGlass(at({ hudSize: 140 })).right === 75 && Hud.outsideGlass(at({ hudY: -60 })).top === 20, 'place: off the glass, per side');
    // reaction time: a slow climb takes the lead as asked; a fast one only the 800 rpm it really had
    ok(Hud.reactionMs({ rate: 1000, target: 6000, lead: 300 }, 6000) === 300, 'reaction: on time at 1000 rpm/s');
    ok(Hud.reactionMs({ rate: 4000, target: 6000, lead: 300 }, 6000) === 200 && Hud.reactionMs({ rate: 4000, target: 6000, lead: 300 }, 6200) === 250, 'reaction: capped lead on a fast climb');
    ok(Hud.reactionMs({ rate: 4000, target: 6000, lead: 300 }, 5000) === 0 && Hud.reactionMs({ rate: 500, target: 6000, lead: 300 }, 6500) === 600, 'reaction: clamped 0..600');
    // the test pattern at another size: the tach is blended over it (dim parts stay dim, empty stays empty)
    const cv = new Canvas(600, 300), bgc = [40, 40, 40, 255];
    cv.clear(bgc);
    Draw.drawLayer(Draw.scaled(cv, 1.2, 10, 10), frame(Object.assign({}, optsDefault, { dim: true }), { d: { rpm: 3000, gear: 3 }, chip: null, readouts: [], peak: 0, down: 0, cue: { from: 4400, at: 6200, shift: false, limiter: false } }));
    const px = (x, y) => Array.from(cv.d.slice((y * 600 + x) * 4, (y * 600 + x) * 4 + 4));
    const dim = px(10 + Math.round(390 * 1.2), 10 + Math.round(9 * 1.2)), empty = px(10 + Math.round(120 * 1.2), 10 + Math.round(110 * 1.2));
    ok(JSON.stringify(empty) === JSON.stringify(bgc) && dim[0] < 120 && dim[1] < 120 && dim[3] === 255 && (dim[0] !== 40 || dim[1] !== 40), 'test pattern: scaled tach blends (dim ' + dim + ', empty ' + empty + ')');
    // the gearbox: a temperature the gearbox stopped giving is not served as fresh
    const GearboxTemp = require(path.join(APP, 'gearbox'));
    const g = new GearboxTemp({ log: { info() {}, warn() {} } }), replies = [70, null, null];
    g.rd = { value: () => Promise.resolve(replies.length ? replies.shift() : null), raws: {}, key: () => '', pick: {} };
    const realNow = Date.now; let now = 1e6; Date.now = () => now;
    const poll = () => { g.busy = false; g._poll(); return new Promise((res) => setImmediate(res)); };
    poll().then(() => { ok(g.value() === 70, 'gearbox: a fresh reading is served');
        now += 15000; return poll(); }).then(() => { now += 6000; return poll(); }).then(() => {
        ok(g.value() !== 70, 'gearbox: 21 s after its last reading (two failed polls since) the old 70 is not served');
        Date.now = realNow;
        console.log(fails ? fails + ' of ' + checks + ' Redline HUD checks failed' : 'Redline HUD checks passed (' + checks + ').');
        process.exit(fails ? 1 : 0);
    });
}
