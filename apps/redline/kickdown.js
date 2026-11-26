'use strict';
/**
 * kickdown.js - Redline's kickdown log (from Shift Lab, #253): how quickly the gearbox drops a gear when you floor it,
 * and when it holds the gear instead; and how the shift times change from a cold gearbox to a warm one.
 *
 *   const k = new KickLog({ fullTorque });   fullTorque(rpm) = the learned full-load torque there (Nm) or null
 *   k.feed(s, ratios, t)  s = { rpm, speed, gear, pedal (%), torque, mode, gb (gearbox oil C) }, ratios = shiftlab.js's
 *                         learned rpm per km/h of each gear, t = ms; on every sample
 *   k.kicks               the last MAX, newest first:
 *                         { at, kind: 'down' | 'held', est, from, to, startMs, doneMs, kmh, pedal, mode, gb }
 *   byMode(kicks), byBand(list, field) summaries for the pages
 *
 * A stab: the accelerator pedal rises by RISE % or more within STAB_MS to at least FLOOR %, above 15 km/h, in a gear.
 * Its start is the first sample where the pedal is 10 % above where it was. Then for up to WAIT_MS: the reaction
 * starts when the rpm rises 3 % above the gear's rpm for the speed, and is done when the rpm per km/h sits within
 * 3 % on a lower gear's learned ratio and stays there for SETTLE_MS (passing a gear on the way, as in a 5 > 3
 * kickdown, does not count). No lower gear by then: the gearbox held the gear ('held').
 * Without a pedal signal (Redline does not read it) a jump in engine torque of TQ_RISE Nm within STAB_MS stands in for
 * the pedal, and only when it reaches FULL of the learned full-load torque at that rpm (no curve learned yet: no kick),
 * not within GEAR_MS of a gear change (the torque coming back after an upshift), and a 'held' only counts once the revs
 * rose (else it was pressing on after a coast, not a kick). Such entries are marked est (an estimate: the torque follows
 * the pedal a little late). Times are rounded to 10 ms; 'best' is the 10th percentile (shiftlab.js).
 */
const { best, r10 } = require('./shiftlab');

const MAX = 120, SETTLE_MS = 100, HIST_MS = 3000, STAB_MS = 350, RISE = 30, FLOOR = 60, WAIT_MS = 2500, COOL_MS = 3000, TQ_RISE = 150;
const GEAR_MS = 1000, FULL = 0.85;
const BANDS = [['cold', -99, 40], ['cool', 40, 70], ['warm', 70, 90], ['hot', 90, 999]];
const isNum = (v) => typeof v === 'number' && isFinite(v);
const avg = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);

/** The gear whose learned ratio is within tol of k (rpm per km/h), else null. */
function gearFor(ratios, k, tol) {
    let best = null, err = tol || 0.03;
    Object.keys(ratios || {}).forEach((g) => {
        const r = ratios[g];
        if (!isNum(r) || !isNum(k)) return;
        const e = Math.abs(k - r) / r;
        if (e < err) { err = e; best = Number(g); }
    });
    return best;
}

const bandOf = (c) => (isNum(c) ? (BANDS.find((b) => c >= b[1] && c < b[2]) || [null])[0] : null);

class KickLog {
    constructor(o) {
        o = o || {};
        this.fullTorque = typeof o.fullTorque === 'function' ? o.fullTorque : () => null;
        this.kicks = []; this.hist = []; this.open = null; this.cool = 0; this.pedalSeen = false; this.changed = false;
        this.gear = null; this.gearAt = -Infinity;
    }

    feed(s, ratios, t) {
        if (!s || !isNum(s.rpm) || !isNum(s.speed)) return;
        if (isNum(s.pedal)) this.pedalSeen = true;
        const k = s.speed > 8 && s.rpm > 600 ? s.rpm / s.speed : null;
        // the last gear change: the gear the car reports, else the one the ratio sits on
        const gNow = isNum(s.gear) && s.gear >= 1 ? s.gear : k ? gearFor(ratios, k, 0.03) : null;
        if (gNow) { if (this.gear && gNow !== this.gear) this.gearAt = t; this.gear = gNow; }
        const h = { t, rpm: s.rpm, kmh: s.speed, k, pedal: isNum(s.pedal) ? s.pedal : null, tq: isNum(s.torque) ? s.torque : null };
        this.hist.push(h);
        while (this.hist.length && t - this.hist[0].t > HIST_MS) this.hist.shift();

        if (this.open) return this._watch(this.open, h, ratios, t);
        if (t < this.cool || s.speed < 15 || !k) return;
        const back = this.hist.filter((x) => t - x.t <= STAB_MS);
        if (back.length < 2) return;
        let start = null, est = false, base;
        if (this.pedalSeen) {
            base = back[0].pedal;
            if (!isNum(base) || !isNum(h.pedal) || h.pedal < FLOOR || h.pedal - base < RISE) return;
            start = back.find((x) => isNum(x.pedal) && x.pedal >= base + 10);
        } else {
            base = back[0].tq;
            if (!isNum(base) || !isNum(h.tq) || h.tq - base < TQ_RISE) return;
            // torque back after a gear change is no kick, nor is pressing on well short of full load
            if (t - this.gearAt < GEAR_MS) return;
            const full = this.fullTorque(s.rpm);
            if (!isNum(full) || full <= 0 || h.tq < full * FULL) return;
            start = back.find((x) => isNum(x.tq) && x.tq >= base + TQ_RISE / 3);
            est = true;
        }
        const pre = this.hist.filter((x) => start && x.t <= start.t && isNum(x.k)).pop();
        const from = (isNum(s.gear) && s.gear >= 1 ? s.gear : null) || (pre ? gearFor(ratios, pre.k, 0.05) : null);
        if (!start || !pre || !from) return;
        this.open = { t0: start.t, k0: pre.k, from, est, kmh: Math.round(s.speed), pedal: isNum(h.pedal) ? Math.round(h.pedal) : null,
            mode: s.mode || null, gb: isNum(s.gb) ? Math.round(s.gb) : null, rise: null };
    }

    _watch(o, h, ratios, t) {
        if (o.rise === null && isNum(h.k) && h.k > o.k0 * 1.03) o.rise = h.t;
        const g = isNum(h.k) ? gearFor(ratios, h.k, 0.03) : null;
        // a lower gear counts once the ratio has stayed on it for SETTLE_MS
        if (g && g < o.from) {
            if (!o.cand || o.cand.g !== g) o.cand = { g, t: h.t };
            else if (h.t - o.cand.t >= SETTLE_MS) return this._close(o, 'down', g, o.cand.t);
        } else o.cand = null;
        if (t - o.t0 > WAIT_MS) this._close(o, 'held', o.from, null);
    }

    _close(o, kind, to, tDone) {
        this.open = null; this.cool = (tDone || o.t0 + WAIT_MS) + COOL_MS;
        // from the torque alone, a 'held' with the revs never rising was no kick at all: not logged
        if (kind === 'held' && o.est && o.rise === null) return;
        const e = { at: o.t0, kind, est: o.est || undefined, from: o.from, to, startMs: o.rise ? r10(o.rise - o.t0) : null,
            doneMs: tDone ? r10(tDone - o.t0) : null, kmh: o.kmh, pedal: o.pedal, mode: o.mode, gb: o.gb };
        this.kicks.unshift(e);
        if (this.kicks.length > MAX) this.kicks.length = MAX;
        this.changed = true;
        if (this.onKick) this.onKick(e);
    }

    toJSON() { return this.kicks; }
    load(a) { if (Array.isArray(a)) this.kicks = a.filter((x) => x && (x.kind === 'down' || x.kind === 'held')).slice(0, MAX); }
    clear() { this.kicks = []; this.changed = true; }
}

/** [{ mode, n, held, avgMs, bestMs }] of the downshifts per driving mode (unknown mode as 'other'); best: 10th percentile. */
function byMode(kicks) {
    const by = {};
    kicks.forEach((k) => { const m = k.mode || 'other'; (by[m] = by[m] || []).push(k); });
    const order = ['sport', 'comfort', 'eco', 'hybrid', 'other'];
    return Object.keys(by).sort((a, b) => order.indexOf(a) - order.indexOf(b)).map((m) => {
        const d = by[m].filter((k) => k.kind === 'down' && isNum(k.doneMs)).map((k) => k.doneMs);
        return { mode: m, n: by[m].length, held: by[m].filter((k) => k.kind === 'held').length, avgMs: d.length ? r10(avg(d)) : null,
            bestMs: best(d) };
    });
}

/** [{ band, n, avgMs }] of a list's field (ms) by gearbox oil band; bands with nothing are left in with n 0. */
function byBand(list, field) {
    return BANDS.map((b) => {
        const v = list.filter((x) => bandOf(x.gb) === b[0] && isNum(x[field])).map((x) => x[field]);
        return { band: b[0], lo: b[1], hi: b[2], n: v.length, avgMs: v.length ? r10(avg(v)) : null };
    });
}

/**
 * Torque at rpm on a learned full-load curve [[rpm, Nm], ...] (sorted by rpm), linear between the points; null with
 * fewer than 2 points or more than a bin (250 rpm) past either end.
 */
function torqueAt(pts, rpm) {
    if (!Array.isArray(pts) || pts.length < 2 || !isNum(rpm)) return null;
    if (rpm < pts[0][0] - 250 || rpm > pts[pts.length - 1][0] + 250) return null;
    if (rpm <= pts[0][0]) return pts[0][1];
    for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1], b = pts[i];
        if (rpm <= b[0]) return a[1] + (b[1] - a[1]) * (rpm - a[0]) / (b[0] - a[0] || 1);
    }
    return pts[pts.length - 1][1];
}

module.exports = { KickLog, byMode, byBand, bandOf, gearFor, torqueAt, BANDS, MAX: MAX };
