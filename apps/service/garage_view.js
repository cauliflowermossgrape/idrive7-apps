'use strict';
/**
 * garage_view.js - Service's Garage tab, three views:
 *
 *   Fuel           the tank and range now, a refuel waiting for its tap, consumption per tank and per station
 *   Parts          parts, mods and care noted (the kind chosen in Settings) on an odometer line, the latest as a table
 *   Milestones     every 10 000 km with its date, the pace in km a day and when the next comes, and the list
 *
 *   draw(cv, t, view, s)   view 'fuel' | 'parts' | 'milestones'
 *                          s = { g (Garage), live, now, brand, octane, partType, armed, note, spec, act }
 *   s.act = { save, drop, part }: the on-screen buttons where the kit runs the screen (cv.own);
 *   elsewhere the bar's buttons do the same (main.js). Taken from Garage Log; its parking timer is left out.
 */
const G = require('./kit/gauges');
const { withAlpha } = require('./kit/canvas');
const { consumption, byBrand, milestoneRate, STEP_KM, DAY } = require('./garage');

const GO = '#2fd27a';
const BRAND_COL = { usual: '#3ac8ff', second: '#ffa23a', third: '#c06bff', other: '#2fd27a', none: '#aaaaaa' };
const PART_COL = ['#3ac8ff', '#ffa23a', '#2fd27a', '#ff5a5a', '#c06bff', '#ffd84a', '#7d8bff', '#ff6fb5'];
const isNum = G.isNum;
const two = (n) => (n < 10 ? '0' : '') + n;
const date = (ms) => { const d = new Date(ms); return d.getDate() + '.' + two(d.getMonth() + 1) + '.' + d.getFullYear(); };
const sp = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
const ago = (ms, now) => { const d = Math.round((now - ms) / DAY); return d <= 0 ? 'today' : d === 1 ? 'yesterday' : d < 60 ? d + ' days ago' : Math.round(d / 30) + ' months ago'; };
const brandName = (spec, b) => { const st = (spec.settings || []).find((x) => x.key === 'fuelBrand'), o = st && st.options.find((x) => x[0] === b); return o ? o[1] : b || 'Not noted'; };

const lines = (cv, t, list, x, y, gap) => list.forEach((l, i) => cv.text(l, x, y + i * gap, i ? 18 : 20, i ? t.dim : t.text, { font: i ? 'label' : 'bold' }));

/* ---------- Fuel ---------- */
function fuel(cv, t, s) {
    const g = s.g, l = s.live, now = s.now;
    G.panel(cv, t, 24, 44, 560, 468, 'Tank now');
    G.readout(cv, t, 48, 96, { label: 'in the tank', value: l.tank, unit: 'l', size: 56, labelSize: 14 });
    G.readout(cv, t, 300, 96, { label: 'range', value: l.range, unit: 'km', size: 56, labelSize: 14 });
    const p = g.pending;
    if (p) {
        cv.roundRect(44, 200, 520, 186, 12, withAlpha(GO, 0.12));
        cv.strokeRoundRect(44, 200, 520, 186, 12, 2, withAlpha(GO, 0.8));
        cv.text('REFUEL SEEN', 64, 230, 15, GO, { font: 'bold', spacing: 2 });
        cv.text('+' + p.litres + ' l', 64, 284, 48, t.text, { font: 'num' });
        cv.text(p.before + ' l > ' + p.after + ' l, ' + ago(p.at, now) + (isNum(p.km) ? ', at ' + sp(p.km) + ' km' : ''), 220, 274, 17, t.dim);
        cv.text('Saved as ' + [s.brand && s.brand !== 'none' ? brandName(s.spec, s.brand) : '', s.octane > 0 ? s.octane + ' octane' : ''].filter(Boolean).concat(['refuel']).join(' ')
            + ' (station and octane: Settings)', 64, 318, 17, t.text, { font: 'bold' });
        if (cv.own && s.act) {
            G.button(cv, t, 64, 334, 230, 44, 'Save refuel', s.act.save, { primary: true, key: 'gl-save' });
            G.button(cv, t, 310, 334, 230, 44, 'Not a refuel', s.act.drop, { confirm: true, key: 'gl-drop' });
        } else cv.text(s.armed === 'drop' ? 'Press Next item again: it was not a refuel' : 'Reset service saves it. Next item twice: it was not a refuel.', 64, 356, 16, s.armed === 'drop' ? t.warn : t.dim);
    } else lines(cv, t, ['No refuel waiting.', 'After filling up while parked it shows here', 'by itself; one tap saves it.'], 48, 240, 30);
    const last = g.fuel[g.fuel.length - 1];
    cv.text(g.fuel.length + ' refuels saved' + (last ? ', the last ' + ago(last.at, now) : ''), 48, 494, 16, t.dim);

    const rows = consumption(g.fuel), shown = rows.filter((r) => isNum(r.perHundred)).slice(-12), brands = byBrand(rows);
    G.panel(cv, t, 600, 44, 976, 468, 'Consumption per tank');
    if (!shown.length) { lines(cv, t, ['Two refuels are needed for the first number.', 'Each tank: litres put in against the km since the refuel before.'], 624, 140, 32); return; }
    const top = Math.max(10, Math.ceil(Math.max.apply(null, shown.map((r) => r.perHundred)) + 1));
    const c = G.chart(cv, t, 616, 100, 600, 300, { padTop: 22, xMin: 0, xMax: shown.length, xStep: shown.length, xFmt: () => '', yMin: 0, yMax: top, yStep: 2, series: [] });
    cv.text('l/100 km', c.px - 8, c.py - 12, 14, t.dim, { align: 'right', font: 'bold' });
    const slot = c.pw / shown.length, bw = Math.min(30, slot * 0.6), mean = shown.reduce((a, r) => a + r.perHundred, 0) / shown.length;
    shown.forEach((r, i) => {
        const x = c.px + slot * (i + 0.5) - bw / 2, y = c.Y(r.perHundred);
        cv.roundRect(x, y, bw, c.py + c.ph - y, 4, BRAND_COL[r.brand] || BRAND_COL.other);
        cv.text(r.perHundred.toFixed(1), x + bw / 2, y - 6, 13, t.text, { align: 'center', font: 'num' });
        cv.text(new Date(r.at).getDate() + '.' + (new Date(r.at).getMonth() + 1) + '.', x + bw / 2, c.py + c.ph + 18, 12, t.dim, { align: 'center' });
    });
    cv.fillRect(c.px, Math.round(c.Y(mean)), c.pw, 2, withAlpha(t.text, 0.6));
    cv.text('white line: average ' + mean.toFixed(1) + ' l/100 km', c.px + c.pw, 92, 15, t.text, { align: 'right' });
    cv.text('PER STATION', 1240, 112, 14, t.dim, { font: 'bold', spacing: 1.5 });
    const bmax = Math.max.apply(null, brands.map((b) => b.avg));
    brands.slice(0, 6).forEach((b, i) => {
        const y = 128 + i * 52, w = Math.max(8, 200 * b.avg / bmax);
        cv.text(brandName(s.spec, b.brand), 1240, y + 16, 16, t.text, { font: 'bold' });
        cv.roundRect(1240, y + 24, w, 14, 4, BRAND_COL[b.brand] || BRAND_COL.other);
        cv.text(b.avg.toFixed(1) + ' (' + b.n + ')', 1248 + w, y + 36, 14, t.text);
    });
    if (brands.length > 1) cv.text(brandName(s.spec, brands[0].brand) + ': ' + (brands[brands.length - 1].avg - brands[0].avg).toFixed(1) + ' l/100 km less than ' + brandName(s.spec, brands[brands.length - 1].brand), 1240, 148 + Math.min(6, brands.length) * 52, 15, GO);
    cv.text('Litres put in against the km since the refuel before: right when you fill up the same way each time.', 624, 494, 15, t.dim);
}

/* ---------- Parts ---------- */
function parts(cv, t, s) {
    const g = s.g, odo = s.live.odo, list = g.parts.slice().sort((a, b) => a.at - b.at);
    G.panel(cv, t, 24, 44, 1552, 220, 'Parts and mods on the odometer');
    const kms = list.map((p) => p.km).filter(isNum).concat(isNum(odo) ? [odo] : []);
    if (!list.length) lines(cv, t, ['Nothing noted yet.', 'Pick the part or care in Settings > Noted in Garage, then Note it (twice) on this page.'], 48, 130, 30);
    else if (kms.length) {
        const lo = Math.floor((Math.min.apply(null, kms) - 500) / 1000) * 1000, hi = Math.ceil((Math.max.apply(null, kms) + 500) / 1000) * 1000;
        const x0 = 64, x1 = 1536, X = (k) => x0 + (x1 - x0) * (k - lo) / (hi - lo), y = 190;
        cv.roundRect(x0, y - 3, x1 - x0, 6, 3, withAlpha(t.track, 0.9));
        const types = [];
        list.forEach((p, i) => {
            if (!isNum(p.km)) return;
            if (types.indexOf(p.type) < 0) types.push(p.type);
            const c = PART_COL[types.indexOf(p.type) % PART_COL.length], x = X(p.km), up = i % 2 === 0, ty = up ? y - 52 : y - 22;
            cv.fillRect(x - 1, ty + 6, 2, y - ty - 6, withAlpha(c, 0.7));
            cv.circle(x, y, 8, c);
            cv.text(p.type, x, ty, 15, t.text, { align: 'center', font: 'bold' });
        });
        cv.text(sp(lo) + ' km', x0, y + 28, 14, t.dim);
        cv.text(sp(hi) + ' km', x1, y + 28, 14, t.dim, { align: 'right' });
        if (isNum(odo)) { cv.fillRect(X(odo) - 1, y - 16, 3, 32, t.text); cv.text('now', X(odo), y + 28, 14, t.text, { align: 'center', font: 'bold' }); }
    }
    G.panel(cv, t, 24, 280, 1100, 232, 'Latest');
    const rows = list.slice(-4).reverse().map((p) => [date(p.at), p.type, isNum(p.km) ? sp(p.km) + ' km' : '--', isNum(p.km) && isNum(odo) ? sp(odo - p.km) + ' km ago' : ago(p.at, s.now)]);
    G.table(cv, t, 48, 330, 1060, [{ label: 'Date', w: 200 }, { label: 'Part', w: 400, font: 'bold' }, { label: 'Odometer', w: 220, align: 'right' }, { label: 'Since', w: 240, align: 'right' }], rows, { rowH: 38, size: 19, empty: 'None yet' });
    G.panel(cv, t, 1140, 280, 436, 232, 'Note a part or care');
    cv.text(s.partType, 1164, 360, 26, t.text, { font: 'bold' });
    cv.text('chosen in Settings > Noted in Garage', 1164, 388, 15, t.dim);
    cv.text('done today' + (isNum(odo) ? ' at ' + sp(odo) + ' km' : ''), 1164, 418, 17, t.text);
    if (cv.own && s.act) G.button(cv, t, 1164, 436, 388, 48, 'Note it', s.act.part, { confirm: true, primary: true, key: 'gl-part' });
    else cv.text(s.armed === 'part' ? 'Press Reset service again to note it' : 'Reset service twice: note it', 1164, 470, 17, s.armed === 'part' ? t.warn : t.dim);
}

/* ---------- Milestones ---------- */
function milestones(cv, t, s) {
    const g = s.g, odo = s.live.odo, ms = g.milestones.slice().sort((a, b) => a.km - b.km), r = milestoneRate(ms, odo, s.now);
    G.panel(cv, t, 24, 44, 1552, 270, 'Every ' + sp(STEP_KM) + ' km');
    G.readout(cv, t, 48, 96, { label: 'odometer', value: odo, text: isNum(odo) ? sp(odo) : null, unit: 'km', size: 44, labelSize: 14 });
    G.readout(cv, t, 420, 96, { label: 'pace', value: r.perDay, decimals: 0, unit: 'km a day', size: 44, labelSize: 14 });
    cv.text(r.nextAt ? sp(r.nextKm) + ' km around ' + date(r.nextAt) : isNum(r.nextKm) ? sp(r.nextKm) + ' km next' : 'waiting for the odometer', 800, 140, 22, t.text, { font: 'bold' });
    cv.text('NEXT MILESTONE', 800, 112, 14, t.dim, { font: 'bold', spacing: 1.5 });
    const all = ms.map((m) => m.km).concat(isNum(r.nextKm) ? [r.nextKm] : []);
    if (all.length) {
        const lo = Math.min.apply(null, all) - STEP_KM / 2, hi = Math.max.apply(null, all) + STEP_KM / 2, x0 = 64, x1 = 1536, X = (k) => x0 + (x1 - x0) * (k - lo) / (hi - lo), y = 250;
        cv.roundRect(x0, y - 3, x1 - x0, 6, 3, withAlpha(t.track, 0.9));
        if (isNum(odo)) cv.roundRect(x0, y - 3, X(odo) - x0, 6, 3, t.accent);
        ms.forEach((m) => { cv.circle(X(m.km), y, 9, GO); cv.text(sp(m.km / 1000) + 'k', X(m.km), y - 18, 15, t.text, { align: 'center', font: 'bold' }); cv.text(date(m.at), X(m.km), y + 30, 13, t.dim, { align: 'center' }); });
        if (isNum(r.nextKm)) { cv.arc(X(r.nextKm), y, 6, 9, 0, 360, t.dim); cv.text(sp(r.nextKm / 1000) + 'k', X(r.nextKm), y - 18, 15, t.dim, { align: 'center', font: 'bold' }); }
    } else cv.text('Milestones are noted as the odometer passes them.', 48, 250, 18, t.dim);
    G.panel(cv, t, 24, 330, 1552, 182, 'Passed');
    const rows = ms.slice(-3).reverse().map((m, i, a) => {
        const prev = ms[ms.indexOf(m) - 1], days = prev ? Math.round((m.at - prev.at) / DAY) : null;
        return [sp(m.km) + ' km', date(m.at), ago(m.at, s.now), isNum(days) && days > 0 ? days + ' days, ' + Math.round(STEP_KM / days) + ' km a day' : '--'];
    });
    G.table(cv, t, 48, 378, 1500, [{ label: 'Milestone', w: 300, font: 'bold' }, { label: 'Date', w: 300 }, { label: 'When', w: 300 },
        { label: 'Since the one before', w: 600, align: 'right' }], rows, { rowH: 36, size: 18, empty: 'None yet: noted as the odometer passes them' });
}

const VIEWS = { fuel, parts, milestones };
function draw(cv, t, view, s) {
    (VIEWS[view] || fuel)(cv, t, s);
    if (s.note) {
        const w = Math.min(900, cv.textWidth(s.note, 18) + 48), x = 800 - w / 2;
        cv.roundRect(x, 462, w, 40, 10, withAlpha('#000000', 0.8));
        cv.strokeRoundRect(x, 462, w, 40, 10, 1.5, t.accent);
        cv.text(s.note, 800, 488, 18, t.text, { align: 'center', font: 'bold' });
    }
}

module.exports = { draw, brandName };
