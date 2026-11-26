'use strict';
/**
 * view.js - Garage Log's pages:
 *
 *   Fuel           the tank and range now, a refuel waiting for its tap, consumption per tank and per brand
 *   Parts          the parts and mods fitted on an odometer line, and the latest as a table
 *   Care           wash and paint care, each against its interval in weeks, the chosen one and what is due
 *   Parking        a countdown ring with the time left, the time steps, when it ends
 *   Ready?         one verdict before a trip and the cards it comes from
 *   Milestones     every 10 000 km with its date, the pace in km a day and when the next comes; the bookmarks
 *   How it works   the same in plain words
 *
 *   draw(cv, t, page, s)   s = { g (Garage), live, now, careSel, timer, parkMin, brand, octane, partType, armed, note, demo, spec }
 */
const G = require('./kit/gauges');
const { withAlpha } = require('./kit/canvas');
const { consumption, byBrand, careState, milestoneRate, CARE, STEP_KM, DAY } = require('./garage');

const GO = '#2fd27a';
const BRAND_COL = { omv: '#3ac8ff', nis: '#ff5a5a', mol: '#2fd27a', lukoil: '#ffa23a', eko: '#ffd84a', shell: '#c06bff', other: '#aaaaaa' };
const PART_COL = ['#3ac8ff', '#ffa23a', '#2fd27a', '#ff5a5a', '#c06bff', '#ffd84a', '#7d8bff', '#ff6fb5'];
const isNum = G.isNum;
const two = (n) => (n < 10 ? '0' : '') + n;
const date = (ms) => { const d = new Date(ms); return d.getDate() + '.' + two(d.getMonth() + 1) + '.' + d.getFullYear(); };
const hm = (ms) => { const d = new Date(ms); return two(d.getHours()) + ':' + two(d.getMinutes()); };
const sp = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
const ago = (ms, now) => { const d = Math.round((now - ms) / DAY); return d <= 0 ? 'today' : d === 1 ? 'yesterday' : d < 60 ? d + ' days ago' : Math.round(d / 30) + ' months ago'; };
const brandName = (spec, b) => { const st = (spec.settings || []).find((x) => x.key === 'fuelBrand'), o = st && st.options.find((x) => x[0] === b); return o ? o[1] : b || 'Other'; };

function steps(cv, t, list, y0, gap) {
    list.forEach((r, i) => {
        const y = y0 + i * gap;
        cv.circle(66, y - 8, 20, withAlpha(t.accent, 0.3));
        cv.text(String(i + 1), 66, y, 22, t.text, { align: 'center', font: 'bold' });
        cv.text(r[0], 104, y, 22, t.text, { font: 'bold' });
        cv.text(r[1], 104, y + 28, 16, t.dim);
    });
}
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
        cv.text('Mark: save it as ' + brandName(s.spec, s.brand) + ' ' + s.octane, 64, 326, 19, t.text, { font: 'bold' });
        cv.text(s.armed === 'drop' ? 'Press Next again: it was not a refuel' : 'Next twice: it was not a refuel. Brand: Settings.', 64, 356, 16, s.armed === 'drop' ? t.warn : t.dim);
    } else lines(cv, t, ['No refuel waiting.', 'After filling up while parked it shows here', 'by itself; one tap of Mark saves it.'], 48, 240, 30);
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
    cv.text('PER BRAND', 1240, 112, 14, t.dim, { font: 'bold', spacing: 1.5 });
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
    if (!list.length) lines(cv, t, ['Nothing noted yet.', 'Pick the part in Settings > Part fitted, then Mark twice on this page.'], 48, 130, 30);
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
    G.panel(cv, t, 1140, 280, 436, 232, 'Note a part');
    cv.text(s.partType, 1164, 360, 26, t.text, { font: 'bold' });
    cv.text('chosen in Settings > Part fitted', 1164, 388, 15, t.dim);
    cv.text(s.armed === 'part' ? 'Press Mark again to note it' : 'Mark twice: fitted today' + (isNum(odo) ? ' at ' + sp(odo) + ' km' : ''), 1164, 440, 17, s.armed === 'part' ? t.warn : t.text);
}

/* ---------- Care ---------- */
function care(cv, t, s) {
    const st = careState(s.g.care, s.now);
    G.panel(cv, t, 24, 44, 1000, 468, 'Wash and paint care');
    st.forEach((c, i) => {
        const y = 106 + i * 57, col = c.state === 'due' ? t.crit : c.state === 'soon' ? t.warn : c.state === 'ok' ? GO : t.dim;
        if (i === s.careSel) cv.strokeRoundRect(36, y - 6, 976, 52, 8, 2, s.armed === 'care' + c.key ? t.warn : t.accent);
        cv.text(c.name, 52, y + 18, 19, t.text, { font: 'bold' });
        cv.text('every ' + c.weeks + ' week' + (c.weeks > 1 ? 's' : ''), 52, y + 38, 14, t.dim);
        cv.roundRect(360, y + 14, 420, 12, 6, withAlpha(t.track, 0.9));
        if (isNum(c.frac)) cv.roundRect(360, y + 14, Math.max(8, 420 * Math.min(1, c.frac)), 12, 6, col);
        cv.text(c.state === 'never' ? 'not marked yet' : c.state === 'due' ? 'due: ' + Math.round(c.since) + ' weeks ago' : Math.round(c.weeks - c.since) + ' weeks left',
            996, y + 26, 16, col, { align: 'right', font: 'bold' });
    });
    G.panel(cv, t, 1040, 44, 536, 468, 'Chosen');
    const c = st[s.careSel], due = st.filter((x) => x.state === 'due');
    cv.text(c.name, 1064, 130, 26, t.text, { font: 'bold' });
    cv.text(c.last ? 'last ' + date(c.last) + ', ' + ago(c.last, s.now) : 'never marked', 1064, 160, 17, t.dim);
    G.readout(cv, t, 1064, 190, { label: 'weeks since', value: c.since, decimals: 0, size: 48, labelSize: 14 });
    G.readout(cv, t, 1300, 190, { label: 'every', value: c.weeks, unit: 'weeks', size: 48, labelSize: 14 });
    cv.text(s.armed === 'care' + c.key ? 'Press Mark again: done today' : 'Mark twice: done today. Next / Previous: choose.', 1064, 330, 17, s.armed === 'care' + c.key ? t.warn : t.text);
    cv.text('DUE NOW', 1064, 380, 14, t.dim, { font: 'bold', spacing: 1.5 });
    cv.text(due.length ? due.map((x) => x.name).join(', ') : 'nothing', 1064, 406, 18, due.length ? t.crit : GO);
    cv.text('Intervals are common care advice, not a rule.', 1064, 494, 14, t.dim);
}

/* ---------- Parking ---------- */
function parking(cv, t, s) {
    const tm = s.timer, now = s.now;
    G.panel(cv, t, 24, 44, 760, 468, 'Parking timer');
    const cx = 404, cy = 286, R = 150;
    cv.arc(cx, cy, R - 16, R, 0, 360, withAlpha(t.track, 0.9));
    if (tm) {
        const left = tm.until - now, frac = Math.max(0, Math.min(1, left / (tm.min * 60000))), col = left <= 0 ? t.crit : left < 5 * 60000 ? t.warn : GO;
        if (frac > 0) cv.arc(cx, cy, R - 16, R, 0, 360 * frac, col);
        const m = Math.floor(Math.abs(left) / 60000), sec = Math.floor(Math.abs(left) / 1000) % 60;
        cv.text((left < 0 ? '+' : '') + m + ':' + two(sec), cx, cy + 24, 72, col, { align: 'center', font: 'num' });
        cv.text(left <= 0 ? 'TIME IS UP' : 'LEFT', cx, cy + 62, 16, left <= 0 ? t.crit : t.dim, { align: 'center', font: 'bold', spacing: 2 });
    } else {
        cv.text(String(s.parkMin), cx, cy + 20, 72, t.dim, { align: 'center', font: 'num' });
        cv.text('MIN, NOT RUNNING', cx, cy + 58, 16, t.dim, { align: 'center', font: 'bold', spacing: 2 });
    }
    G.panel(cv, t, 800, 44, 776, 468, 'Time');
    [15, 30, 60, 120].forEach((m, i) => {
        const x = 824 + i * 180, on = m === s.parkMin;
        cv.roundRect(x, 104, 160, 64, 12, on ? withAlpha(t.accent, 0.3) : withAlpha(t.track, 0.6));
        if (on) cv.strokeRoundRect(x, 104, 160, 64, 12, 2, t.accent);
        cv.text(m + ' min', x + 80, 146, 24, on ? t.text : t.dim, { align: 'center', font: 'bold' });
    });
    if (tm) {
        cv.text('Started ' + hm(tm.from) + ', ends ' + hm(tm.until), 824, 230, 24, t.text, { font: 'bold' });
        cv.text('Mark: stop it', 824, 264, 18, t.dim);
    } else lines(cv, t, ['Next: change the time.', 'Mark: start the countdown.'], 824, 230, 30);
    cv.text('It counts on this screen and in the badge on top; it does not wake the car or send anything.', 824, 494, 15, t.dim);
}

/* ---------- Ready? ---------- */
function ready(cv, t, s) {
    const l = s.live, g = s.g, now = s.now, due = careState(g.care, now).filter((c) => c.state === 'due');
    const cards = [
        ['Fuel and range', isNum(l.range) ? sp(l.range) + ' km' : '--', isNum(l.tank) ? Math.round(l.tank) + ' l in the tank' : 'no tank level yet',
            !isNum(l.range) ? 'none' : l.range < 60 ? 'bad' : l.range < 150 ? 'warn' : 'ok'],
        ['12 V battery', isNum(l.soc) ? Math.round(l.soc) + ' %' : '--', 'charge the car reports', !isNum(l.soc) ? 'none' : l.soc < 50 ? 'bad' : l.soc < 70 ? 'warn' : 'ok'],
        ['Care due', due.length ? String(due.length) : 'none', due.length ? due.map((c) => c.name).slice(0, 2).join(', ') : 'nothing due', due.length ? 'warn' : 'ok'],
        ['Refuel waiting', g.pending ? '+' + g.pending.litres + ' l' : 'none', g.pending ? 'save it on Fuel' : 'nothing to save', g.pending ? 'warn' : 'ok'],
    ];
    const bad = cards.filter((c) => c[3] === 'bad'), warn = cards.filter((c) => c[3] === 'warn');
    G.panel(cv, t, 24, 44, 560, 468, 'Before you go');
    const v = bad.length ? ['CHECK FIRST', t.crit] : warn.length ? ['GOOD TO GO', t.warn] : ['GOOD TO GO', GO];
    cv.roundRect(44, 100, 520, 110, 14, withAlpha(v[1], 0.16));
    cv.text(v[0], 304, 176, 54, v[1], { align: 'center', font: 'bold' });
    const why = bad.length ? bad.map((c) => c[0] + ': ' + c[1]).join('. ') : warn.length ? 'Worth a look: ' + warn.map((c) => c[0].toLowerCase()).join(', ') : 'Fuel, battery and care all fine.';
    cv.text(why, 48, 254, 18, t.text);
    const col0 = (st) => (st === 'bad' ? t.crit : st === 'warn' ? t.warn : st === 'ok' ? GO : t.dim);
    cards.forEach((c, i) => {
        const y = 300 + i * 40;
        cv.circle(60, y - 6, 8, col0(c[3]));
        cv.text(c[0], 80, y, 18, t.text, { font: 'bold' });
        cv.text(c[1], 560, y, 18, col0(c[3]), { align: 'right' });
    });
    cv.text('Oil level and service items: the Service and Fault Scanner apps read them from the car.', 48, 494, 14, t.dim);
    const col = (st) => (st === 'bad' ? t.crit : st === 'warn' ? t.warn : st === 'ok' ? GO : t.dim);
    cards.forEach((c, i) => {
        const x = 600 + (i % 2) * 496, y = 44 + Math.floor(i / 2) * 242;
        G.panel(cv, t, x, y, 480, 226, c[0]);
        cv.text(c[1], x + 24, y + 140, 54, col(c[3]), { font: 'num' });
        cv.text(c[2], x + 24, y + 190, 17, t.dim);
        G.pill(cv, t, x + 344, y + 22, 112, 30, c[3] === 'bad' ? 'LOW' : c[3] === 'warn' ? 'CHECK' : c[3] === 'ok' ? 'OK' : 'NO DATA', { color: col(c[3]), size: 15 });
    });
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
    G.panel(cv, t, 24, 330, 1552, 182, 'Bookmarks: Bookmark now saves the moment');
    const rows = g.marks.slice(-3).reverse().map((m) => [date(m.at) + ' ' + hm(m.at), isNum(m.km) ? sp(m.km) + ' km' : '--', isNum(m.speed) ? m.speed + ' km/h' : '--',
        isNum(m.tank) ? m.tank + ' l' : '--', isNum(m.soc) ? m.soc + ' %' : '--']);
    G.table(cv, t, 48, 378, 1500, [{ label: 'When', w: 340 }, { label: 'Odometer', w: 280, align: 'right' }, { label: 'Speed', w: 280, align: 'right' },
        { label: 'Tank', w: 280, align: 'right' }, { label: '12 V charge', w: 300, align: 'right' }], rows, { rowH: 36, size: 18, empty: 'None yet: press Bookmark now on any page' });
}

/* ---------- How it works ---------- */
function help(cv, t) {
    G.panel(cv, t, 24, 44, 1552, 468, 'How Garage Log works');
    steps(cv, t, [
        ['Refuels save themselves, almost.', 'When the tank level rises while parked, Fuel shows the refuel; one tap of Mark saves it with the brand and octane set in Settings.'],
        ['Consumption per tank and per brand.', 'The litres put in against the km since the refuel before. Right when you fill up the same way each time, so it is a guide.'],
        ['Parts, care and milestones keep the dates.', 'Parts and care are noted with Mark (twice), with today\'s odometer. Care reminds by weeks; milestones note every 10 000 km.'],
        ['A parking timer and a check before you go.', 'Parking counts down 15 to 120 min on screen. Ready? sums up fuel, the 12 V battery, care due and a refuel waiting.'],
        ['Bookmark now saves any moment.', 'Time, odometer, speed, tank and 12 V charge, listed on Milestones, to find that moment later in other logs.'],
    ], 124, 72);
    cv.text('It only reads what the car sends anyway (tank, range, odometer, speed, 12 V charge). The head unit has no keyboard, so lists in Settings stand in for typing.', 48, 496, 15, t.dim);
}

function draw(cv, t, page, s) {
    [fuel, parts, care, parking, ready, milestones, help][page] ? [fuel, parts, care, parking, ready, milestones, help][page](cv, t, s) : fuel(cv, t, s);
    if (s.note) {
        const w = Math.min(900, cv.textWidth(s.note, 18) + 48), x = 800 - w / 2;
        cv.roundRect(x, 462, w, 40, 10, withAlpha('#000000', 0.8));
        cv.strokeRoundRect(x, 462, w, 40, 10, 1.5, t.accent);
        cv.text(s.note, 800, 488, 18, t.text, { align: 'center', font: 'bold' });
    }
}

module.exports = { draw };
