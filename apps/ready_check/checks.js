'use strict';
/**
 * checks.js - Ready Check's judgement, kept apart from the drawing so it can be tested:
 *
 *   checks(s, set) -> [{ key, label, value, unit, text, state: 'ok' | 'cold' | 'check' | 'hot' | 'none', scale, zones }]
 *       s   = { oil, coolant, gearbox, soc12, range, fuel, tyres: { lowest, which } } (deg C, %, km, l, share of target)
 *       set = { warmOil, warmCoolant, warmGearbox }
 *   verdict(list) -> { word: 'READY' | 'NOT YET' | 'TOO HOT' | 'NO DATA', state, why, notes: [text] }
 *   rate(hist, idx, now) -> deg C a minute over the last 3 minutes (least squares), or null
 *
 * Temperatures decide the verdict (cold: NOT YET, too hot: TOO HOT). The 12 V battery, fuel and tyres never block
 * it: they are things to check, listed under it.
 */
const isNum = (v) => typeof v === 'number' && isFinite(v);
// above these the value is no longer "fine" (check) and then too hot; Warm-Up eases off the gearbox at 125 deg C
const HOT = { oil: [120, 135], coolant: [110, 118], gearbox: [110, 125] };

function temp(key, label, v, warm) {
    const [check, hot] = HOT[key];
    const zones = [{ from: -40, to: warm, color: 'cold' }, { from: warm, to: check, color: 'go' }, { from: check, to: hot, color: 'warn' }, { from: hot, to: 160, color: 'crit' }];
    const base = { key, label, value: v, unit: 'C', scale: [0, 150], zones, temp: true, warm };
    if (!isNum(v)) return Object.assign(base, { state: 'none', text: 'not sent by this car yet' });
    if (v < warm) return Object.assign(base, { state: 'cold', text: 'warming up' });
    if (v >= hot) return Object.assign(base, { state: 'hot', text: 'too hot: drive gently' });
    if (v >= check) return Object.assign(base, { state: 'check', text: 'hot: keep an eye on it' });
    return Object.assign(base, { state: 'ok', text: 'warm, ready' });
}

function checks(s, set) {
    const out = [
        temp('oil', 'Engine oil', s.oil, set.warmOil),
        temp('coolant', 'Coolant', s.coolant, set.warmCoolant),
        temp('gearbox', 'Gearbox oil', s.gearbox, set.warmGearbox),
    ];
    const b = s.soc12;
    out.push({ key: 'battery', label: '12 V battery', value: b, unit: '%', scale: [0, 100],
        zones: [{ from: 0, to: 50, color: 'crit' }, { from: 50, to: 70, color: 'warn' }, { from: 70, to: 100, color: 'go' }],
        state: !isNum(b) ? 'none' : b < 70 ? 'check' : 'ok',
        text: !isNum(b) ? 'not sent by this car yet' : b < 50 ? 'low charge: a long drive charges it' : b < 70 ? 'charge is a little low' : 'charged' });
    const r = s.range;
    out.push({ key: 'fuel', label: 'Fuel', value: r, unit: 'km', scale: [0, 800],
        zones: [{ from: 0, to: 80, color: 'crit' }, { from: 80, to: 150, color: 'warn' }, { from: 150, to: 800, color: 'go' }],
        state: !isNum(r) ? 'none' : r < 150 ? 'check' : 'ok',
        text: !isNum(r) ? 'not sent by this car yet' : (r < 80 ? 'fill up soon' : r < 150 ? 'under 150 km left' : 'range left') + (isNum(s.fuel) ? ', ' + Math.round(s.fuel) + ' l in the tank' : '') });
    const ty = s.tyres || {}, lo = ty.lowest;
    out.push({ key: 'tyres', label: 'Tyre pressure', value: isNum(lo) ? Math.round(lo * 100) : null, unit: '%', scale: [70, 110],
        zones: [{ from: 70, to: 90, color: 'crit' }, { from: 90, to: 95, color: 'warn' }, { from: 95, to: 110, color: 'go' }],
        state: !isNum(lo) ? 'none' : lo < 0.95 ? 'check' : 'ok',
        text: !isNum(lo) ? 'not sent by this car yet' : (lo < 0.9 ? 'low: ' : lo < 0.95 ? 'a little low: ' : 'at target, lowest: ') + (ty.which || '') });
    return out;
}

function verdict(list) {
    const temps = list.filter((c) => c.temp), seen = temps.filter((c) => c.state !== 'none');
    const notes = list.filter((c) => !c.temp && c.state === 'check').map((c) => c.label + ': ' + c.text);
    const hot = temps.filter((c) => c.state === 'hot'), cold = temps.filter((c) => c.state === 'cold');
    const names = (l) => l.map((c) => c.label.toLowerCase()).join(' and ');
    const be = (l) => (l.length > 1 ? ' are' : ' is');
    if (!seen.length) return { word: 'NO DATA', state: 'none', why: 'The car has not sent any temperature yet.', notes };
    if (hot.length) return { word: 'TOO HOT', state: 'hot', why: 'The ' + names(hot) + be(hot) + ' too hot. Drive gently until it comes down.', notes };
    if (cold.length) return { word: 'NOT YET', state: 'cold', why: 'The ' + names(cold) + be(cold) + ' still cold. Keep it gentle: no full throttle, no high revs.', notes };
    return { word: 'READY', state: 'ok', why: 'Everything the car sends is warm. It is ready for harder driving.', notes };
}

function rate(hist, idx, now) {
    const pts = hist.filter((h) => isNum(h[idx]) && now - h[0] < 180000);
    if (pts.length < 4) return null;
    const n = pts.length, mx = pts.reduce((a, p) => a + p[0], 0) / n, my = pts.reduce((a, p) => a + p[idx], 0) / n;
    let num = 0, den = 0;
    pts.forEach((p) => { num += (p[0] - mx) * (p[idx] - my); den += (p[0] - mx) * (p[0] - mx); });
    return den ? num / den * 60000 : null;
}

module.exports = { checks, verdict, rate, HOT };
