'use strict';
/**
 * Service Intervals - your own intervals next to BMW's: engine oil every 7 000 km instead of the car's 15 000 or more,
 * spark plugs, gearbox oil, brake pads front and rear, filters, brake fluid by months. Each interval is a setting
 * (0 = not followed); "Done now" marks an item serviced at today's odometer.
 *
 *   Overview       a summary (how many are due, soon or fine, what is next) and a card per item: a ring of how much of
 *                  its interval is used, what is left in big figures, when it was last done
 *   History        every service marked, newest first, and for the chosen item a chart of the km between its services
 *   Wheels         which set of wheels is on (summer, winter, all-season) since when, km per set this season and in
 *                  all, tread depth against the usual advice, and after a swap the bolts and pressures reminder (wheels.js)
 *   Driving        how the car was driven since each item's last service (short trips, cold engine, stop and go, hot
 *                  oil, hard braking, high load) and how much harder that was on it than the km say: an estimate
 *                  from common guidance (wear.js), shown as a small "wear" chip on Overview; the km stay the main number
 *   How it works   the same in plain words
 *
 *   - the odometer is what the cluster sends (KombiIF statusRangeTankStatus.mileageKilometre, as Live Data reads it)
 *   - nothing is changed in the car: BMW's own service display (the Service app) stays as it is
 *   - Next item picks an item, Done now marks it, pressed again within 5 s to confirm
 *   - kept in the app's data folder (intervals.json: per item the last service and its history; drives.json: the
 *     drives background() recorded from the car's own signals); the demo has its own, never saved
 *   - runs with the car (app.json autostart) so every drive is counted, also with the app closed
 */
const fs = require('fs');
const path = require('path');
const mgu = require('./kit/mgu');
const { withAlpha } = require('./kit/canvas');
const G = require('./kit/gauges');
const { ITEMS, status } = require('./items');
const Wheels = require('./wheels');
const Wear = require('./wear');

const W = 1600, H = 520, GO = '#2fd27a', CONFIRM_MS = 5000, DAY = 86400000;
const TABS = ['Overview', 'History', 'Wheels', 'Driving', 'How it works'];
const KEEP_DRIVES = 600, G0 = 9.80665;
const two = (n) => (n < 10 ? '0' : '') + n;
const day = (ms) => { const d = new Date(ms); return two(d.getDate()) + '.' + two(d.getMonth() + 1) + '.' + d.getFullYear(); };
const km = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
const WORD = { due: 'DUE', soon: 'SOON', ok: 'FINE', unknown: 'NOT MARKED' };

/** An item's record: { km, at, history: [{ km, at }] } (an older file held only { km, at }). */
function record(store, key) {
    const r = store[key];
    if (!r) return null;
    if (!Array.isArray(r.history)) r.history = [{ km: r.km, at: r.at }];
    return r;
}

function demoStore() {
    const now = Date.now(), d = (days) => now - days * DAY;
    const h = (list) => ({ km: list[list.length - 1][0], at: list[list.length - 1][1], history: list.map((x) => ({ km: x[0], at: x[1] })) });
    return {
        oil: h([[18200, d(1460)], [27900, d(1100)], [33600, d(760)], [40400, d(300)]]),
        plugs: h([[12000, d(1250)]]),
        padsFront: h([[9800, d(1300)], [46500, d(120)]]),
        padsRear: h([[11000, d(1280)]]),
        gearbox: h([[30500, d(900)]]),
        brakeFluid: h([[30000, d(760)]]),
        // the winter set went on 60 km ago: the bolts reminder shows
        wheels: { swaps: [['winter', 24000, 1110], ['summer', 30200, 950], ['winter', 36900, 580], ['summer', 43100, 220], ['winter', 49590, 4]]
            .map((x) => ({ set: x[0], km: x[1], at: d(x[2]) })) },
    };
}

/* Demo drives since 1 300 days ago: mostly town, short cold trips in winter, a few motorway runs (never saved). */
function demoDrives() {
    const now = Date.now(), out = [];
    let seed = 7;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    for (let d = 1300; d > 0; d -= 1 + Math.floor(rnd() * 2)) {
        const kind = rnd(), km = kind < 0.45 ? 2 + rnd() * 6 : kind < 0.85 ? 8 + rnd() * 25 : 60 + rnd() * 140;
        const movingS = km / (kind < 0.45 ? 24 : kind < 0.85 ? 40 : 95) * 3600;
        out.push({ at: now - d * 86400000, km: Math.round(km * 10) / 10, maxOil: kind < 0.45 ? 55 + rnd() * 40 : 92 + rnd() * 20,
            movingS: Math.round(movingS), slowS: Math.round(movingS * (kind < 0.85 ? 0.3 + rnd() * 0.25 : 0.04)),
            hotS: kind > 0.95 ? Math.round(rnd() * 240) : 0, hardStops: rnd() < 0.18 ? 1 + Math.floor(rnd() * 2) : 0,
            highS: kind > 0.85 ? Math.round(movingS * rnd() * 0.12) : Math.round(movingS * rnd() * 0.02) });
    }
    return out;
}

/* With or without the screen (autostart): every drive, from the car's own signals only, never the demo. */
async function background(bg) {
    const { signals, log } = bg;
    const FILE = path.join(bg.dataDir, 'drives.json');
    let drives = [];
    try { drives = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { /* none yet */ }
    const v = { rpm: null, speed: null, oil: null, gLong: null, torque: null, seen: false };
    const sc = (raw, f, o, bad) => (typeof raw === 'number' && raw !== bad ? raw * f + o : null);
    const watch = (iface, h) => (signals && signals.watch ? Promise.resolve(signals.watch(iface, '1', h, log)).catch((e) => log.warn('intervals: ' + iface + ': ' + (e && e.message || e))) : null);
    watch('de.bmw.infotainment.vehicle.CDS', {
        statusEngineSpeed2: (x) => { v.rpm = sc(x && x.actualValueRPMEngineCrankshaft, 0.25, 0, 65535); v.seen = true; },
        statusEngineTemperature: (x) => { v.oil = sc(x && x.temperatureEngineOilDrive, 1, -48, 255); },
    });
    watch('de.bmw.infotainment.vehicle.Vehicle2', { statusCarSpeed2: (x) => { v.speed = sc(x && x.speedVehicleCentreOfGravity, 0.015625, 0, 65535); v.seen = true; } });
    watch('de.bmw.infotainment.vehicle.CDS2', {
        statusLongitudinalAccelerationMassCenter: (x) => { const a = sc(x && x.longitudinalAccelerationCentreOfGravity, 0.002, -65, 65535); v.gLong = a === null ? null : a / G0; },
    });
    watch('de.bmw.infotainment.drivingexcitement.FES', {
        statusActualValueTorque2: (x) => { const raw = x && x.actualValueTorqueCrankshaft; v.torque = typeof raw === 'number' && raw < 4095 ? raw * 0.5 - 1023.5 : null; },
    });
    const rec = new Wear.DriveRecorder({ peakKw: drives.peakKw });
    const state = { drives, rec, v };
    rec.onDrive = (d) => {
        state.drives = state.drives.concat([d]).slice(-KEEP_DRIVES);
        try { fs.writeFileSync(FILE, JSON.stringify(state.drives)); } catch (e) { log.warn('intervals: drives: ' + e); }
        log.info('intervals: drive ' + d.km + ' km, oil max ' + d.maxOil);
    };
    const tick = () => {
        if (!v.seen) return;
        const kw = G.isNum(v.torque) && G.isNum(v.rpm) ? v.torque * v.rpm / 9549 : null;
        rec.sample({ speed: v.speed, rpm: v.rpm, oil: v.oil, gLong: v.gLong, kw });
    };
    const timer = setInterval(tick, 1000);
    if (timer.unref) timer.unref();
    process.on('exit', () => rec.flush());
    state.tick = tick;
    return state;
}

mgu.run({
    background,
    async start(ctx) {
        const { ui, settings, log } = ctx;
        const FILE = path.join(ctx.dataDir, 'intervals.json');
        let saved = {};
        try { saved = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { /* first start */ }
        const odo = { v: null, t: 0 };
        if (ctx.signals && ctx.signals.watch) {
            Promise.resolve(ctx.signals.watch('de.bmw.infotainment.KombiIF', '1', {
                statusRangeTankStatus: (v) => { const m = v && v.mileageKilometre; if (typeof m === 'number' && m >= 0 && m < 16777215) { odo.v = m; odo.t = Date.now(); } },
            }, log)).catch((e) => log.warn('odometer: ' + (e && e.message || e)));
        }
        const bgd = ctx.background || await background(ctx);
        const DEMO_ODO = 49650, demoDone = demoStore(), demoDr = demoDrives();
        const demo = () => settings.get('demo') === 'on' || (settings.get('demo') === 'auto' && odo.v === null);
        const store = () => (demo() ? demoDone : saved);
        const odoNow = () => (demo() ? DEMO_ODO : odo.v);
        const shown = () => ITEMS.filter((it) => settings.get(it.setting) > 0);
        let sel = 0, armed = 0, note = '', noteUntil = 0, page = 0, wheelPick = 0;
        const WHEELS = 2, DRIVING = 3, HELP = 4;
        const drivesNow = () => (demo() ? demoDr : bgd.drives || []);
        /* The drives since an item's last service (all recorded ones when it was never marked). */
        const wearOf = (it, done) => Wear.estimate(it, drivesNow().filter((d) => !done || d.at > done.at));
        const say = (s) => { note = s; noteUntil = Date.now() + 4000; };

        ui.onClick('BTN_NEXT', () => {
            armed = 0;
            if (page === WHEELS) { wheelPick = (wheelPick + 1) % Wheels.setsOn(settings).length; return render(); }
            const l = shown(); if (l.length) sel = (sel + 1) % l.length; return render();
        });
        ui.onClick('BTN_DONE', () => {
            if (page === WHEELS) return wheelSwap();
            const it = shown()[sel];
            if (!it) return render();
            if (it.unit === 'km' && !G.isNum(odoNow())) { say('Waiting for the odometer from the car'); return render(); }
            if (!armed || Date.now() - armed > CONFIRM_MS) { armed = Date.now(); say('Press Done now again to mark ' + it.name + ' serviced today'); return render(); }
            armed = 0;
            const st = store(), r = record(st, it.key) || { history: [] }, entry = { km: odoNow(), at: Date.now() };
            r.km = entry.km; r.at = entry.at; r.history = r.history.concat([entry]).slice(-30);
            st[it.key] = r;
            if (!demo()) { try { fs.writeFileSync(FILE, JSON.stringify(saved)); } catch (e) { log.warn('save: ' + e); } }
            log.info('intervals: ' + it.key + ' done at ' + odoNow() + ' km' + (demo() ? ' (demo)' : ''));
            say(it.name + ' marked serviced at ' + (G.isNum(odoNow()) ? km(odoNow()) + ' km' : 'today'));
            return render();
        });
        if (ctx.onTab) ctx.onTab((i) => { page = i; armed = 0; return render(); });

        /* Wheels: Done now twice puts the picked set on the car at today's odometer. */
        function wheelSwap() {
            const set = Wheels.setsOn(settings)[wheelPick % Wheels.setsOn(settings).length];
            if (!G.isNum(odoNow())) { say('Waiting for the odometer from the car'); return render(); }
            if (!armed || Date.now() - armed > CONFIRM_MS) { armed = Date.now(); say('Press Done now again: ' + set.name + ' wheels on the car today'); return render(); }
            armed = 0;
            const st = store();
            st.wheels = Wheels.swap(st.wheels, set.key, odoNow(), Date.now());
            if (!demo()) { try { fs.writeFileSync(FILE, JSON.stringify(saved)); } catch (e) { log.warn('save: ' + e); } }
            log.info('intervals: ' + set.key + ' wheels on at ' + odoNow() + ' km' + (demo() ? ' (demo)' : ''));
            say(set.name + ' wheels marked on at ' + km(odoNow()) + ' km');
            return render();
        }

        function states(now, o) {
            return shown().map((it) => {
                const every = settings.get(it.setting), done = record(store(), it.key);
                return { it, every, done, s: status(it, every, done, o, now) };
            });
        }
        const colOf = (t, s) => (s.state === 'due' ? t.crit : s.state === 'soon' ? t.warn : s.state === 'ok' ? GO : t.dim);
        const leftText = (x) => (x.it.unit === 'km' ? km(Math.abs(x.s.left)) : String(Math.abs(x.s.left)));
        const leftUnit = (x) => (x.it.unit === 'km' ? 'km' : 'days');

        function overview(cv, t, now, o, l) {
            const p = G.panel(cv, t, 24, 44, 1552, 84, null);
            cv.text('ODOMETER', 48, 78, 15, t.dim, { font: 'bold', spacing: 2 });
            cv.text(G.isNum(o) ? km(o) + ' km' : 'waiting for the car', 48, 112, 30, G.isNum(o) ? t.text : t.dim, { font: 'num' });
            const n = { due: 0, soon: 0, ok: 0, unknown: 0 };
            l.forEach((x) => { n[x.s.state] = (n[x.s.state] || 0) + 1; });
            let px = 330;
            [['due', t.crit], ['soon', t.warn], ['ok', GO], ['unknown', t.dim]].forEach(([k, c]) => {
                if (!n[k] && k === 'unknown') return;
                G.pill(cv, t, px, 70, 150, 40, n[k] + ' ' + WORD[k], { color: c, size: 17, filled: n[k] ? 0.25 : 0.08 });
                px += 166;
            });
            const next = l.filter((x) => G.isNum(x.s.left)).sort((a, b) => (a.s.frac > b.s.frac ? -1 : 1))[0];
            const right = now < noteUntil ? note : next ? 'Next: ' + next.it.name + (next.s.left > 0 ? ' in ' + leftText(next) + ' ' + leftUnit(next) : ', ' + leftText(next) + ' ' + leftUnit(next) + ' overdue') : 'Mark what was done with Done now';
            cv.text(right, p.x + p.w - 24, 100, 22, now < noteUntil ? t.warn : t.text, { align: 'right', font: 'bold' });
            if (!l.length) { G.panel(cv, t, 24, 140, 1552, 372, null); cv.text('No interval set: choose them in Settings', 48, 200, 26, t.dim); return; }
            const cols = 4, gap = 12, cw = (1552 - gap * (cols - 1)) / cols, rows = Math.ceil(l.length / cols), ch = Math.floor((372 - gap * (rows - 1)) / rows);
            l.forEach((x, i) => {
                const cx = 24 + (i % cols) * (cw + gap), cy = 140 + Math.floor(i / cols) * (ch + gap), c = colOf(t, x.s);
                G.panel(cv, t, cx, cy, cw, ch, x.it.name);
                if (i === sel) cv.strokeRoundRect(cx, cy, cw, ch, 14, armed ? 4 : 3, armed ? t.warn : t.accent);
                const r = Math.min(48, ch * 0.28), rx = cx + 22 + r, ry = cy + ch * 0.56;
                cv.arc(rx, ry, r - 9, r, 0, 360, t.track);
                if (G.isNum(x.s.frac)) cv.arc(rx, ry, r - 9, r, 0, 360 * G.clamp(x.s.frac, 0, 1), c);
                cv.text(G.isNum(x.s.frac) ? Math.round(Math.min(x.s.frac, 9.99) * 100) + '%' : '--', rx, ry + 8, 22, c, { align: 'center', font: 'bold' });
                const tx = rx + r + 22;
                if (x.s.state === 'unknown') {
                    cv.text(x.done ? 'needs the odometer' : 'not marked yet', tx, ry - 6, 22, t.dim, { font: 'bold' });
                    cv.text(x.done ? '' : 'pick it, Done now', tx, ry + 22, 17, t.dim);
                } else {
                    G.readout(cv, t, tx, ry - r - 6, { label: x.s.left > 0 ? 'LEFT' : 'OVERDUE', text: leftText(x), unit: leftUnit(x), size: 40, labelSize: 14, color: c });
                }
                cv.text('every ' + (x.it.unit === 'km' ? km(x.every) + ' km' : x.every + ' months'), cx + 22, cy + ch - 18, 16, t.dim);
                cv.text(x.done ? 'last ' + day(x.done.at) : '', cx + cw - 20, cy + ch - 18, 16, t.dim, { align: 'right' });
                G.pill(cv, t, cx + cw - 128, cy + 12, 110, 26, WORD[x.s.state] || '', { color: c, size: 13 });
                // the wear chip: how much harder the driving since the last service was than the km say (an estimate)
                const w = wearOf(x.it, x.done);
                if (w.applies && w.enough && x.s.state !== 'unknown') {
                    const wc = w.extra >= 20 ? t.warn : w.extra >= 5 ? t.accent : GO;
                    G.pill(cv, t, cx + cw - 128, cy + 44, 110, 22, w.extra >= 1 ? 'WEAR +' + Math.round(w.extra) + '%' : 'WEAR NORMAL', { color: wc, size: 11, spacing: 1, filled: 0.15 });
                }
            });
        }

        function history(cv, t, l) {
            const all = [];
            ITEMS.forEach((it) => { const r = record(store(), it.key); if (r) r.history.forEach((h) => all.push({ it, h })); });
            all.sort((a, b) => b.h.at - a.h.at);
            G.panel(cv, t, 24, 44, 640, 468, 'Every service marked (' + all.length + ')');
            G.table(cv, t, 48, 92, 592, [{ label: 'Date', w: 170 }, { label: 'Item', w: 260 }, { label: 'Odometer', w: 162, align: 'right' }],
                all.slice(0, 9).map((x) => [day(x.h.at), { text: x.it.name, color: x.it === (l[sel] && l[sel].it) ? 'accent' : null }, G.isNum(x.h.km) ? km(x.h.km) + ' km' : '']),
                { rowH: 40, size: 20, empty: 'Nothing marked yet: Done now' });
            const x = l[sel], it = x && x.it, r = it && record(store(), it.key), hist = r ? r.history : [];
            G.panel(cv, t, 680, 44, 896, 468, it ? it.name + ': between services' : 'Between services');
            if (!it) return;
            const gaps = [];
            for (let i = 1; i < hist.length; i++) {
                gaps.push({ v: it.unit === 'km' ? hist[i].km - hist[i - 1].km : (hist[i].at - hist[i - 1].at) / DAY / 30.44, at: hist[i].at });
            }
            if (G.isNum(x.s.left) && x.done) gaps.push({ v: it.unit === 'km' ? x.every - x.s.left : x.s.frac * x.every, at: Date.now(), now: true });
            const unit = it.unit === 'km' ? 'km' : 'months';
            if (gaps.length < 2) {
                cv.text('Two or more services of ' + it.name.toLowerCase() + ' give a chart here:', 704, 140, 21, t.dim);
                cv.text('how far you drove between them, against your interval.', 704, 172, 21, t.dim);
                return;
            }
            const bx = 760, bw = 780, by = 110, bh = 330, top = Math.max(x.every, ...gaps.map((g) => g.v)) * 1.15;
            const Y = (v) => by + bh - v / top * bh, step = G.niceStep(top, 4);
            for (let v = 0; v <= top; v += step) {
                cv.fillRect(bx, Math.round(Y(v)), bw, 1, withAlpha(t.tick, v ? 0.25 : 0.6));
                cv.text(it.unit === 'km' ? km(v) : String(Math.round(v)), bx - 10, Y(v) + 6, 15, t.dim, { align: 'right' });
            }
            const n = gaps.length, slot = bw / n, w = Math.min(90, slot * 0.6);
            gaps.forEach((g, i) => {
                const gx = bx + i * slot + (slot - w) / 2, c = g.now ? t.accent : g.v > x.every ? t.warn : GO;
                cv.roundRect(gx, Y(g.v), w, by + bh - Y(g.v), 6, withAlpha(c, g.now ? 0.45 : 0.85));
                cv.text(it.unit === 'km' ? km(g.v) : g.v.toFixed(0), gx + w / 2, Y(g.v) - 8, 16, t.text, { align: 'center', font: 'bold' });
                cv.text(g.now ? 'so far' : day(g.at).slice(3), gx + w / 2, by + bh + 22, 15, t.dim, { align: 'center' });
            });
            cv.fillRect(bx, Math.round(Y(x.every)), bw, 2, t.crit);
            cv.text('your interval ' + (it.unit === 'km' ? km(x.every) : x.every) + ' ' + unit, bx + bw, Y(x.every) - 8, 16, t.crit, { align: 'right', font: 'bold' });
            cv.text('Green: done in time. Yellow: later than the interval. The last bar: since the last service.', 704, 496, 16, t.dim);
        }

        /* Driving: since each item's last service, how it was driven and what that means for it (an estimate). */
        function driving(cv, t, l) {
            const items = l.filter((x) => Wear.ITEM_RULES[x.it.key]);
            const x = l[sel], w = x ? wearOf(x.it, x.done) : null;
            // left: every item's extra wear as a bar, the chosen one outlined
            G.panel(cv, t, 24, 44, 600, 468, 'Extra wear since each service');
            if (!items.length) cv.text('No item with a driving factor is followed: Settings', 48, 130, 20, t.dim);
            items.slice(0, 6).forEach((y, i) => {
                const e = wearOf(y.it, y.done), yy = 104 + i * 62, on = y === x;
                if (on) cv.roundRect(36, yy - 8, 576, 56, 8, withAlpha(t.accent, 0.16));
                cv.text(y.it.name, 52, yy + 14, 20, on ? t.text : t.dim, { font: 'bold' });
                cv.text(e.enough ? km(e.km) + ' km recorded' : 'not enough driving yet', 596, yy + 14, 15, t.dim, { align: 'right' });
                cv.roundRect(52, yy + 26, 540, 10, 5, t.track);
                if (e.enough) cv.roundRect(52, yy + 26, Math.max(8, 540 * e.extra / Wear.CAP), 10, 5, e.extra >= 20 ? t.warn : e.extra >= 5 ? t.accent : GO);
                if (e.enough) cv.text('+' + Math.round(e.extra) + ' %', 52 + Math.max(8, 540 * e.extra / Wear.CAP) + 8, yy + 36, 15, t.text, { font: 'bold' });
            });
            cv.text('Bar: extra wear, up to +' + Wear.CAP + ' %. Next item picks one.', 48, 496, 16, t.dim);

            const p = G.panel(cv, t, 640, 44, 936, 468, x ? x.it.name + ': how it was driven since ' + (x.done ? day(x.done.at) : 'recording began') : 'How it was driven');
            if (!x) return;
            if (!w.applies) {
                cv.text(x.it.name + ' wears with time and km, not with how you drive:', 664, 130, 21, t.text);
                cv.text('the plain interval is the whole story for it.', 664, 162, 21, t.dim);
                return;
            }
            if (!w.enough) {
                cv.text('Not enough driving recorded since the last service yet (' + Math.round(w.km) + ' of ' + Wear.MIN_KM + ' km).', 664, 130, 21, t.text);
                cv.text('The app counts every drive in the background, also with this screen closed.', 664, 162, 20, t.dim);
                return;
            }
            G.readout(cv, t, 664, 94, { label: 'DRIVEN, RECORDED', text: km(w.km), unit: 'km', size: 40, labelSize: 14 });
            G.readout(cv, t, 920, 94, { label: 'COUNTS AS ABOUT', text: km(w.wearKm), unit: 'km', size: 40, labelSize: 14, color: w.extra >= 20 ? t.warn : t.accent });
            G.readout(cv, t, 1200, 94, { label: 'EXTRA WEAR', text: '+' + Math.round(w.extra), unit: '%', size: 40, labelSize: 14, color: w.extra >= 20 ? t.warn : w.extra >= 5 ? t.accent : GO });
            G.readout(cv, t, 1420, 94, { label: 'DRIVES', text: String(w.drives), size: 40, labelSize: 14 });
            const rh = Math.min(52, Math.floor(260 / w.parts.length));
            w.parts.forEach((q, i) => {
                const y = 180 + i * rh, bx = 880, bw = 560, c = q.extra >= q.rule.cap * 0.6 ? t.warn : q.extra > 0 ? t.accent : GO;
                cv.text(q.rule.name, 664, y + 22, 20, q.extra > 0.5 ? t.text : t.dim, { font: 'bold' });
                cv.roundRect(bx, y + 8, bw, 12, 6, t.track);
                cv.roundRect(bx, y + 8, Math.max(10, bw * q.frac), 12, 6, c);
                cv.fillRect(Math.round(bx + bw * q.normalFrac), y + 2, 2, 24, t.text);
                cv.text(q.rule.fmt(q.value), bx, y + 40, 15, t.dim);
                cv.text(q.extra > 0.5 ? '+' + Math.round(q.extra) + ' %' : 'normal', p.x + p.w - 24, y + 22, 20, c, { align: 'right', font: 'bold' });
            });
            // why, in words: the factors that raised it most
            const why = w.parts.filter((q) => q.extra > 0.5).sort((a, b) => b.extra - a.extra).slice(0, 2);
            cv.text(why.length ? why.map((q) => q.rule.text).join(' ') : 'Nothing unusual: this driving is easy on it.', 664, 462, 17, why.length ? t.text : GO);
            cv.text('White tick: what counts as normal. An estimate from common maintenance guidance, not BMW data; the km left on Overview do not change.', 664, 496, 15, t.dim);
        }

        function help(cv, t) {
            G.panel(cv, t, 24, 44, 1552, 468, 'How Service Intervals works');
            [
                ['1', 'Set your own intervals.', 'In Settings, how often you want each item done: engine oil every 7 000 km, brake fluid every 24 months. 0 turns an item off.'],
                ['2', 'Mark what was done.', 'Pick the item with Next item, press Done now, then Done now again within 5 s. It is saved with today\'s date and odometer.'],
                ['3', 'Watch what is left.', 'Overview shows each item\'s ring and the km or days left: green fine, yellow soon (1 000 km or 30 days), red due.'],
                ['4', 'See your habits.', 'History lists every service and charts how far you drove between them, against your interval.'],
                ['5', 'Swap wheels.', 'On Wheels, Next item picks the set and Done now twice marks it on: km per set, tread depth, and a reminder to check the bolts and pressures after 50 to 100 km.'],
                ['6', 'See how hard your driving was on it.', 'Driving counts every drive in the background: short cold trips, stop and go, hot oil, hard braking and high load add an estimated extra wear to the km.'],
            ].forEach((r, i) => {
                const yy = 124 + i * 62;
                cv.circle(70, yy - 8, 20, withAlpha(t.accent, 0.3));
                cv.text(r[0], 70, yy, 22, t.text, { align: 'center', font: 'bold' });
                cv.text(r[1], 108, yy, 23, t.text, { font: 'bold' });
                cv.text(r[2], 108, yy + 30, 18, t.dim);
            });
            cv.text('BMW\'s own service display is not changed: this app only reads the odometer and keeps its own list in the car.', 48, 496, 17, t.dim);
        }

        function render() {
            const t = ctx.theme(), cv = ctx.canvas(W, H).clear(t.bg), now = Date.now(), o = odoNow(), l = states(now, o);
            if (sel >= l.length) sel = 0;
            if (page === 1) history(cv, t, l);
            else if (page === WHEELS) Wheels.draw(cv, t, { w: store().wheels, odo: o, sets: Wheels.setsOn(settings), pick: wheelPick, armed: !!armed && now - armed < CONFIRM_MS, settings, note: now < noteUntil ? note : '' });
            else if (page === DRIVING) driving(cv, t, l);
            else if (page === HELP) help(cv, t);
            else overview(cv, t, now, o, l);
            G.frame(cv, t, TABS, page, [demo() && { text: 'DEMO' }]);
            return ui.image('MAIN_GFX', cv);
        }
        ctx.loop('MAIN', 2, render);
        render().then(() => log.info('first frame done')).catch((e) => log.warn('first render: ' + e));
    },
});
