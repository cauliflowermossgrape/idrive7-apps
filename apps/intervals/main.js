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
 *   How it works   the same in plain words
 *
 *   - the odometer is what the cluster sends (KombiIF statusRangeTankStatus.mileageKilometre, as Live Data reads it)
 *   - nothing is changed in the car: BMW's own service display (the Service app) stays as it is
 *   - Next item picks an item, Done now marks it, pressed again within 5 s to confirm
 *   - kept in the app's data folder (intervals.json: per item the last service and its history); the demo has its own,
 *     never saved
 */
const fs = require('fs');
const path = require('path');
const mgu = require('./kit/mgu');
const { withAlpha } = require('./kit/canvas');
const G = require('./kit/gauges');
const { ITEMS, status } = require('./items');
const Wheels = require('./wheels');

const W = 1600, H = 520, GO = '#2fd27a', CONFIRM_MS = 5000, DAY = 86400000;
const TABS = ['Overview', 'History', 'Wheels', 'How it works'];
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

mgu.run({
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
        const DEMO_ODO = 49650, demoDone = demoStore();
        const demo = () => settings.get('demo') === 'on' || (settings.get('demo') === 'auto' && odo.v === null);
        const store = () => (demo() ? demoDone : saved);
        const odoNow = () => (demo() ? DEMO_ODO : odo.v);
        const shown = () => ITEMS.filter((it) => settings.get(it.setting) > 0);
        let sel = 0, armed = 0, note = '', noteUntil = 0, page = 0, wheelPick = 0;
        const WHEELS = 2;
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

        function help(cv, t) {
            G.panel(cv, t, 24, 44, 1552, 468, 'How Service Intervals works');
            [
                ['1', 'Set your own intervals.', 'In Settings, how often you want each item done: engine oil every 7 000 km, brake fluid every 24 months. 0 turns an item off.'],
                ['2', 'Mark what was done.', 'Pick the item with Next item, press Done now, then Done now again within 5 s. It is saved with today\'s date and odometer.'],
                ['3', 'Watch what is left.', 'Overview shows each item\'s ring and the km or days left: green fine, yellow soon (1 000 km or 30 days), red due.'],
                ['4', 'See your habits.', 'History lists every service and charts how far you drove between them, against your interval.'],
                ['5', 'Swap wheels.', 'On Wheels, Next item picks the set and Done now twice marks it on: km per set, tread depth, and a reminder to check the bolts and pressures after 50 to 100 km.'],
            ].forEach((r, i) => {
                const yy = 134 + i * 72;
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
            else if (page === 3) help(cv, t);
            else overview(cv, t, now, o, l);
            G.frame(cv, t, TABS, page, [demo() && { text: 'DEMO' }]);
            return ui.image('MAIN_GFX', cv);
        }
        ctx.loop('MAIN', 2, render);
        render().then(() => log.info('first frame done')).catch((e) => log.warn('first render: ' + e));
    },
});
