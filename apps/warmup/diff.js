'use strict';
/**
 * diff.js - Warm-Up's Drives > Before / After (from Trip Recap, #251): what changed at a marked moment (a service, a new part, tyres ...), as the
 * average of the drives before it against the average of the drives after it, metric by metric.
 *
 *   sides(list, marks, k, kind) -> { mark, before, after, kind }
 *       list: the drives, newest first; marks: oldest first; k: which mark. Before: up to SIDE drives from the previous
 *       mark (or the start) up to this one, newest first; after: up to SIDE drives from this mark up to the next one,
 *       oldest first. kind 'all' | 'length' (km within +-50 % of the median of both sides) | 'speed' (average speed
 *       within +-20 %), so a long motorway drive is not compared with a short trip to the shop.
 *   rows(before, after) -> [{ key, name, unit, d, b, a, change, pct, spread, spreadPct, state, nb, na }]
 *       state 'better' | 'worse' | 'changed' (no better or worse for it) | 'same' (within the spread of the before
 *       drives: normal variation; with a single drive on either side twice that, as one drive can be off by itself)
 *       | 'none' (not recorded on one side)
 *   headline(rows, label) -> up to 3 plain sentences about the biggest better or worse changes (a metric that is only
 *       'changed' is not put down to the mark in words: it stays in the table)
 */
const SIDE = 10;
const isNum = (x) => typeof x === 'number' && isFinite(x);
const DEG = '°C';

/* [key, name, unit, value of a drive, decimals, better: +1 more is better, -1 less is better, 0 neither, short name]
   Average speed, time per 10 km and the most power mostly follow the traffic and the right foot, not the part that
   changed: they are shown as changed only, never better or worse (as the Compare view does). */
const METRICS = [
    ['avgSpeed', 'Average speed', 'km/h', (d) => d.vAvg, 0, 0],
    ['pace', 'Time per 10 km', 'min', (d) => (isNum(d.km) && d.km >= 1 && isNum(d.secs) ? d.secs / 60 / d.km * 10 : null), 1, 0],
    ['brakeG', 'Hardest braking', 'g', (d) => d.gBrake, 2, -1],
    ['brakes100', 'Hard brakes per 100 km', '', (d) => (isNum(d.km) && d.km >= 1 && isNum(d.brakes) ? d.brakes / d.km * 100 : null), 1, -1],
    ['kw', 'Most power', 'kW', (d) => d.kwMax, 0, 0],
    ['peakG', 'Peak g, any way', 'g', (d) => { const v = [d.gFwd, d.gBrake, d.gSide].filter(isNum); return v.length ? Math.max.apply(null, v) : null; }, 2, 0],
    ['oil', 'Hottest oil', DEG, (d) => d.oilMax, 0, -1, 'Oil'],
    ['cool', 'Hottest coolant', DEG, (d) => d.coolMax, 0, -1, 'Coolant'],
    ['warm', 'Oil warm-up from cold', 'min', (d) => (isNum(d.warm) ? d.warm / 60 : null), 1, -1],
];

function median(v) {
    if (!v.length) return null;
    const s = v.slice().sort((a, b) => a - b), m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function sides(list, marks, k, kind) {
    const mark = marks[k];
    if (!mark) return { mark: null, before: [], after: [], kind };
    const from = k > 0 ? marks[k - 1].at : -Infinity, to = k + 1 < marks.length ? marks[k + 1].at : Infinity;
    let before = list.filter((d) => d.start < mark.at && d.start >= from);
    let after = list.filter((d) => d.start >= mark.at && d.start < to).reverse();
    const pick = kind === 'length' ? (d) => d.km : kind === 'speed' ? (d) => d.vAvg : null;
    if (pick) {
        const ref = median(before.slice(0, SIDE).concat(after.slice(0, SIDE)).map(pick).filter(isNum));
        const w = kind === 'length' ? 0.5 : 0.2;
        if (isNum(ref) && ref > 0) {
            const keep = (d) => isNum(pick(d)) && Math.abs(pick(d) - ref) <= w * ref;
            before = before.filter(keep); after = after.filter(keep);
        }
    }
    return { mark, before: before.slice(0, SIDE), after: after.slice(0, SIDE), kind };
}

function stats(v) {
    const n = v.length;
    if (!n) return { n, mean: null, sd: null };
    const mean = v.reduce((a, b) => a + b, 0) / n;
    const sd = n >= 2 ? Math.sqrt(v.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (n - 1)) : null;
    return { n, mean, sd };
}

function rows(before, after) {
    return METRICS.map((m) => {
        const b = stats(before.map(m[3]).filter(isNum)), a = stats(after.map(m[3]).filter(isNum));
        const r = { key: m[0], name: m[1], unit: m[2], d: m[4], better: m[5], short: m[6], b: b.mean, a: a.mean, nb: b.n, na: a.n,
            change: null, pct: null, spread: b.sd, spreadPct: null, state: 'none' };
        if (!b.n || !a.n) return r;
        r.change = a.mean - b.mean;
        r.pct = b.mean ? 100 * r.change / Math.abs(b.mean) : null;
        // the spread of the before drives is the normal variation; with one drive before, 10 % of it stands in for it
        const noise = (isNum(b.sd) ? b.sd : 0.1 * Math.abs(b.mean)) * (b.n < 2 || a.n < 2 ? 2 : 1);
        r.spreadPct = b.mean ? 100 * noise / Math.abs(b.mean) : null;
        const tiny = Math.abs(r.change) < Math.pow(10, -r.d) / 2;
        if (tiny || Math.abs(r.change) <= noise) r.state = 'same';
        else r.state = m[5] === 0 ? 'changed' : r.change * m[5] > 0 ? 'better' : 'worse';
        return r;
    });
}

const fmt = (v, d) => (v > 0 ? '+' : '') + v.toFixed(d);

function sentence(r, label) {
    const after = label ? ' after ' + label : '';
    if (r.unit === DEG) return r.short + ' runs ' + Math.abs(r.change).toFixed(0) + ' ' + DEG + ' ' + (r.change < 0 ? 'cooler' : 'warmer') + after;
    if (isNum(r.pct) && Math.abs(r.pct) < 1000) return r.name + ' ' + fmt(r.pct, 0) + ' %' + after;
    return r.name + ' ' + fmt(r.change, r.d) + (r.unit ? ' ' + r.unit : '') + after;
}

function headline(rs, label) {
    return rs.filter((r) => r.state === 'better' || r.state === 'worse')
        .sort((x, y) => Math.abs(isNum(y.pct) ? y.pct : 0) - Math.abs(isNum(x.pct) ? x.pct : 0))
        .slice(0, 3).map((r) => ({ text: sentence(r, label), state: r.state }));
}

module.exports = { METRICS, SIDE, sides, rows, headline, stats, median };
