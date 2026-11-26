'use strict';
/**
 * Watchdog - rules that watch the car in the background, while navigation, music or any other screen is in front.
 *
 *   - up to 8 rules: a value (oil, coolant, gearbox oil, outside, speed, rpm, power, braking g, sideways g, 12 V charge,
 *     fuel range), above or below a threshold, for how long (0, 2, 5, 10 s); each fires once, then again only after the
 *     value came back and the cooldown (a setting) passed (rules.js)
 *   - runs with the car (app.json autostart): background() watches with or without the app's screen
 *   - what it can do when a rule fires: the kit gives apps no popup and no way to bring themselves in front of another
 *     screen, so a firing shows on the Watchdog home-screen widget (if one is placed) and in the app (a NEW badge,
 *     the Events page); every firing is kept in events.json
 *   - rules are edited on the Rules page with the menu buttons (Next rule, Change value, Above / below, Lower, Higher,
 *     Hold time, Rule on / off); they are kept in rules.json
 * Reads only what the car sends anyway (the signals kit/car.js and the other apps read); nothing is asked of a control
 * unit, nothing written to one.
 */
const fs = require('fs');
const path = require('path');
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const Car = require('./kit/car');
const { ScaledCanvas } = require('./kit/canvas');
const R = require('./rules');
const { draw } = require('./view');

const W = 1600, H = 520, TICK_MS = 250, KEEP = 200, GO = '#2fd27a';
const TABS = ['Rules', 'Events', 'How it works'];
const CDS = 'de.bmw.infotainment.vehicle.CDS', KOMBI = 'de.bmw.infotainment.KombiIF';
const ENV = 'de.bmw.infrastructure.EnvironmentalInformation', BDS = 'de.bmw.infrastructure.analytics.BasicDataSet';

/* The values the rules can watch, from the car (or the demo drive). */
function values(d, x) {
    const kw = G.isNum(d.torque) && G.isNum(d.rpm) ? Math.max(0, d.torque * d.rpm / 9549) : null;
    return {
        oil: d.oil, coolant: d.coolant, speed: d.speed, rpm: d.rpm, kw,
        brake: G.isNum(d.gLong) ? Math.max(0, -d.gLong) : null, side: G.isNum(d.gLat) ? Math.abs(d.gLat) : null,
        gearbox: x.gearbox, outside: x.outside, soc12: x.soc12, range: x.range,
    };
}

/* Demo: the values the car's demo drive does not have, and a made-up evening of firings. */
function demoExtra(now) {
    const s = now / 1000;
    return { gearbox: 88 + 6 * Math.sin(s / 40), outside: 2 + 1.5 * Math.sin(s / 90), soc12: 72 + 4 * Math.sin(s / 60), range: 64 - (s / 20) % 12 };
}
function demoEvents(now, rules) {
    const at = [[-38, 5], [-31, 6], [-26, 6], [-19, 1], [-14, 6], [-11, 7], [-6, 4], [-2, 7]];
    const val = { 5: 2, 6: 0.84, 1: 112, 4: 117, 7: 58 };
    return at.map(([m, i]) => ({ at: now + m * 60000, i, text: R.text(rules[i]), value: val[i] === undefined ? rules[i].thr : val[i], unit: R.byKey(rules[i].value).unit }))
        .reverse();
}

async function background(bg) {
    const { settings, log } = bg;
    const RULES = path.join(bg.dataDir, 'rules.json'), EVENTS = path.join(bg.dataDir, 'events.json');
    const read = (f, dflt) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return dflt; } };
    const st = { rules: R.normalize(read(RULES, null)), events: read(EVENTS, []), unseen: 0, engine: new R.Engine(), driveFrom: 0, offSince: 0 };
    if (!Array.isArray(st.events)) st.events = [];
    const x = { soc12: null, range: null, outside: null, gearbox: null };
    const gb = { first: null, moved: false, at: 0 };
    const extra = {
        [CDS]: { statusBattery2: (v) => { const c = v && v.conditionBatteryChargingCondition; if (G.isNum(c) && c >= 0 && c <= 100) x.soc12 = c; } },
        [KOMBI]: { statusRangeTankStatus: (v) => { if (v && G.isNum(v.range) && v.range < 4095) x.range = v.range; } },
        [ENV]: { ExteriorTemperature: (v) => { const r = v && v.temperatureExterior; if (G.isNum(r) && r !== 255) x.outside = r * 0.5 - 40; } },
        [BDS]: { basicDataSet: (v) => {
            // the gearbox oil counts once it has moved by a degree (as Warm-Up: a value that never moves is no reading)
            const r = v && v.valueTemperatureTransmissionOil;
            if (!G.isNum(r) || r === 255 || r - 48 < -40 || r - 48 > 160) return;
            const c = r - 48;
            if (gb.first === null) gb.first = c;
            if (Math.abs(c - gb.first) >= 1) gb.moved = true;
            x.gearbox = c; gb.at = Date.now();
        } },
    };
    const car = new Car(bg, ['rpm', 'speed', 'accel', 'temps', 'torque'], extra);
    st.car = car; st.x = x;
    st.live = () => Object.assign({}, x, { gearbox: gb.moved && Date.now() - gb.at < 20000 ? x.gearbox : null });
    st.saveRules = () => { try { fs.writeFileSync(RULES, JSON.stringify(st.rules)); } catch (e) { log.warn('rules: ' + e); } };
    const cooldown = () => (settings.get('cooldown') || 60) * 1000;
    st.cooldown = cooldown;
    st.onFire = [];

    const timer = setInterval(() => {
        const d = car.data(), now = Date.now();
        if (d.demo) return;                         // only the car's own values fire rules
        // a drive: from the engine starting after it was off for 5 minutes or more
        if (G.isNum(d.rpm) && d.rpm > 0) { if (!st.driveFrom || (st.offSince && now - st.offSince > 300000)) st.driveFrom = now; st.offSince = 0; }
        else if (!st.offSince) st.offSince = now;
        const fired = st.engine.step(st.rules, values(d, st.live()), now, cooldown());
        if (!fired.length) return;
        fired.forEach((f) => {
            const r = st.rules[f.i], e = { at: f.at, i: f.i, text: R.text(r), value: Math.round(f.value * 100) / 100, unit: R.byKey(r.value).unit };
            st.events.unshift(e);
            log.info('watchdog: rule ' + (f.i + 1) + ' fired: ' + e.text + ' (' + e.value + ')');
        });
        st.events = st.events.slice(0, KEEP);
        st.unseen += fired.length;
        try { fs.writeFileSync(EVENTS, JSON.stringify(st.events)); } catch (e) { log.warn('events: ' + e); }
        st.onFire.forEach((fn) => { try { fn(fired); } catch (e) { log.warn(String(e)); } });
    }, TICK_MS);
    if (timer.unref) timer.unref();
    return st;
}

mgu.run({
    background,
    async start(ctx) {
        const { ui, settings, log } = ctx;
        const st = ctx.background || await background(ctx);
        const demoEngine = new R.Engine();
        let page = 0, sel = 0;
        const demo = () => st.car.data().demo;
        const vals = (now) => {
            const d = st.car.data();
            return values(d, d.demo ? demoExtra(now) : st.live());
        };
        const edit = (fn) => () => {
            const r = st.rules[sel];
            fn(r, R.byKey(r.value));
            st.rules = R.normalize(st.rules);
            st.engine.reset(sel); demoEngine.reset(sel);
            st.saveRules();
            page = 0;
            return render();
        };
        const stepThr = (dir) => edit((r, v) => { const k = v.steps.indexOf(R.snap(v.steps, r.thr)); r.thr = v.steps[Math.max(0, Math.min(v.steps.length - 1, k + dir))]; });
        ui.onClick('BTN_RULE', () => { sel = (sel + 1) % 8; page = 0; return render(); });
        ui.onClick('BTN_VALUE', edit((r) => {
            const k = R.VALUES.findIndex((v) => v.key === r.value), nv = R.VALUES[(k + 1) % R.VALUES.length];
            r.value = nv.key; r.thr = nv.steps[Math.floor(nv.steps.length * 0.7)];
        }));
        ui.onClick('BTN_CMP', edit((r) => { r.cmp = r.cmp === 'above' ? 'below' : 'above'; }));
        ui.onClick('BTN_LESS', stepThr(-1));
        ui.onClick('BTN_MORE', stepThr(1));
        ui.onClick('BTN_HOLD', edit((r) => { r.hold = R.HOLDS[(R.HOLDS.indexOf(r.hold) + 1) % R.HOLDS.length]; }));
        ui.onClick('BTN_ONOFF', edit((r) => { r.on = !r.on; }));
        if (ctx.onTab) ctx.onTab((i) => { page = i; if (i === 1) st.unseen = 0; return render(); });

        function state(now) {
            const dm = demo(), v = vals(now), eng = dm ? demoEngine : st.engine, cd = st.cooldown();
            if (dm) demoEngine.step(st.rules, v, now, cd);
            const cards = st.rules.map((r, i) => Object.assign({ rule: r, def: R.byKey(r.value), value: v[r.value], count: eng.s[i].count }, eng.state(i, r, v, now, cd)));
            const events = dm ? demoEvents(now, st.rules) : st.events;
            const from = dm ? now - 45 * 60000 : st.driveFrom || now - 60 * 60000;
            return { cards, events, from, now, sel, demo: dm, unseen: dm ? 2 : st.unseen, cooldown: cd / 1000, widget: !!(ctx.widget && ctx.widget.instances && ctx.widget.instances().length) };
        }

        function render() {
            const t = ctx.theme(), cv = ctx.canvas(W, H).clear(t.bg), now = Date.now(), s = state(now);
            if (page === 1) st.unseen = 0;
            draw(cv, t, page, s);
            G.frame(cv, t, TABS, page, [s.demo && { text: 'DEMO' }, page !== 1 && s.unseen > 0 && { text: s.unseen + ' NEW', color: t.crit }]);
            return ui.image('MAIN_GFX', cv);
        }

        /* The home-screen widget: what the rules saw last. The big one is a picture, the small one text lines. */
        const wcan = {}, wtext = {};
        function last(now) {
            const s = state(now), e = s.events[0], fresh = e && now - e.at < 10 * 60000;
            return { s, e, fresh, on: s.cards.filter((c) => c.rule.on).length, firing: s.cards.filter((c) => c.state === 'firing').length };
        }
        const ago = (ms) => (ms < 60000 ? 'just now' : ms < 3600000 ? Math.round(ms / 60000) + ' min ago' : Math.round(ms / 3600000) + ' h ago');
        function widgetCells(inst, L, now) {
            const on = !inst.big;
            const cells = {
                Title: [on ? 'Watchdog' : '', 'Text'],
                TextRecordings: [on ? (L.firing ? L.firing + ' rule(s) firing' : L.on + ' rules watching') : '', 'Text'],
                TextCam: [on && L.e ? L.e.text : '', 'Text'],
                ProgressbarVisible: [false, 'Bool'],
                TimeElapsed: [on && L.e ? ago(now - L.e.at) : '', 'Text'],
            };
            const prev = wtext[inst.spawnId] || (wtext[inst.spawnId] = {});
            Object.keys(cells).forEach((k) => { const v = JSON.stringify(cells[k][0]); if (prev[k] !== v) { prev[k] = v; ctx.widget.set(inst.spawnId, k, cells[k][0], cells[k][1]); } });
        }
        function renderWidget(inst) {
            const now = Date.now(), L = last(now);
            if (inst) widgetCells(inst, L, now);
            const sw = ctx.spec.startWidget || {}, [w, h] = sw.size || [384, 256], key = w + 'x' + h;
            const cv = (wcan[key] = wcan[key] || new ScaledCanvas(w, h, sw.scale || 1)).clear([0, 0, 0, 0]);
            const t = ctx.theme(), safe = sw.safe || [0.09, 0.17];
            const x0 = Math.round(w * safe[0]), x1 = w - x0, y0 = Math.round(h * safe[1]), y1 = h - y0;
            const alert = L.firing || L.fresh;
            cv.text(L.firing ? 'RULE FIRING' : L.fresh ? 'RULE FIRED' : 'ALL QUIET', x0, y0 + 16, 16, alert ? t.crit : GO, { font: 'bold', spacing: 1.5 });
            if (L.s.demo) cv.text('DEMO', x1, y0 + 16, 12, t.warn, { font: 'bold', align: 'right' });
            if (L.e) {
                cv.text(L.e.text, x0, y0 + 52, 17, alert ? t.text : t.dim, { font: 'bold' });
                cv.text('was ' + L.e.value + ' ' + L.e.unit + ', ' + ago(now - L.e.at), x0, y0 + 76, 14, t.dim);
            } else cv.text('Nothing has fired yet', x0, y0 + 52, 17, t.dim);
            // the 8 rules as dots: green watching, yellow waiting, red firing, grey off
            L.s.cards.forEach((c, i) => {
                const col = c.state === 'firing' ? t.crit : c.state === 'waiting' || c.state === 'cooldown' ? t.warn : c.state === 'off' || c.state === 'no value' ? t.track : GO;
                cv.circle(x0 + 9 + i * 26, y1 - 40, 8, col);
            });
            cv.text(L.on + ' of 8 rules watching', x0, y1 - 6, 14, t.dim);
            return cv.canvas;
        }
        if (ctx.widget) {
            ctx.widget.loop(2, renderWidget);
            ctx.widget.onChange((why) => { if (why === 'resized' || why === 'placed') Object.keys(wtext).forEach((k) => delete wtext[k]); });
        }
        st.onFire.push(() => render().catch(() => {}));
        ctx.loop('MAIN', 4, render);
        render().then(() => log.info('first frame done')).catch((e) => log.warn('first render: ' + e));
    },
});

module.exports = { values, demoEvents };
