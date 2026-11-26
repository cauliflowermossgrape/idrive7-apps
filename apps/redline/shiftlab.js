'use strict';
/**
 * shiftlab.js - Redline's shift timing (from Shift Lab, #253): every upshift under load timed, and how hard the car pulls
 * in each gear across the revs. Pages Shift times, Pull and Cold vs hot (shiftpages.js).
 *
 *   const s = new ShiftLog({ minTorque, known });   known(g) = the shift map's ratio of gear g (rpm per km/h) or null
 *   s.feed(d, t)          d = { rpm, speed, gLong, torque, gear, gb (gearbox oil C) } from Redline's own readings, t = ms
 *   s.shifts              the last MAX upshifts, newest first:
 *                         { at, from, to, ms, rpmBefore, rpmAfter, kmh, gBefore, gDip, gAfter, tqBefore, tqAfter, gb }
 *                         (gb: the gearbox oil in C when the car sends it)
 *   s.ratios              the rpm per km/h of each gear: { 1: 117.2, 2: 77.3, ... }: the shift map's (shiftmap.js) where it
 *                         knows the gear, else learned here, only under load with the gear held 600 ms and the ratio
 *                         steady, and only from readings within 3 % (a clutch-in or open-converter coast never moves it)
 *   s.changed             a new shift (or Clear): worth saving now; s.dirty: only the pull or a ratio moved (save later)
 *   s.pullCurves()        { gear: [[rpm, g], ...] } the average acceleration under load per 250 rpm, per gear
 *   s.perGear()           [{ from, to, n, avgMs, bestMs, avgDrop }] by gear change (best: the 10th percentile, not the
 *                         minimum of noisy readings; times rounded to 10 ms, as the samples come 10 to 50 times a second)
 *   s.toJSON() / s.load(o) what is kept in the app's data folder
 *
 * How a shift is measured (the car sends no shift time): the gear the car reports (or Car's learned guess) steps up
 * while the engine pulls. Two seconds later the history around that moment is read back: the shift starts at the
 * highest rpm just before it (the engine stops pulling up) and ends when the rpm per km/h reaches the new gear's ratio
 * (within 3 %), else at the lowest rpm after it. Under load = engine torque at least minTorque, or 0.08 g forward.
 */
const MAX = 200, HIST_MS = 4000, WAIT_MS = 2000, BIN = 250, RATIO_TOL = 0.03, RATIO_STEP = 0.02, RATIO_RESET = 100, MAX_GEAR = 10;
const isNum = (v) => typeof v === 'number' && isFinite(v);
const avg = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const r1 = (v, d) => (isNum(v) ? Math.round(v * Math.pow(10, d || 0)) / Math.pow(10, d || 0) : null);
/** ms to the nearest 10 (the samples are 10 to 50 Hz: finer digits would be noise). */
const r10 = (v) => (isNum(v) ? Math.round(v / 10) * 10 : null);
/** The p-th percentile (0..1) of the numbers in a, linear between ranks; null when empty. */
function pct(a, p) {
    const v = a.filter(isNum).sort((x, y) => x - y);
    if (!v.length) return null;
    const i = (v.length - 1) * p, lo = Math.floor(i);
    return lo + 1 < v.length ? v[lo] + (v[lo + 1] - v[lo]) * (i - lo) : v[lo];
}
/** 'Best' of noisy times: the 10th percentile, rounded to 10 ms. */
const best = (a) => r10(pct(a, 0.1));

class ShiftLog {
    constructor(o) {
        o = o || {};
        this.minTorque = o.minTorque || 100;
        this.known = typeof o.known === 'function' ? o.known : () => null;
        this.shifts = []; this.ratios = {}; this.pull = {};
        this.hist = []; this.pending = []; this.lastGear = null; this.gearSince = 0; this.changed = false; this.dirty = false;
        this.prevK = null; this.rej = {};
    }

    feed(d, t) {
        if (!d || !isNum(d.rpm) || !isNum(d.speed)) return;
        const gear = isNum(d.gear) && d.gear >= 1 ? d.gear : null;
        const k = d.speed > 8 && d.rpm > 800 ? d.rpm / d.speed : null;
        const s = { t, rpm: d.rpm, kmh: d.speed, g: isNum(d.gLong) ? d.gLong : null, tq: isNum(d.torque) ? d.torque : null, gear, k, gb: isNum(d.gb) ? d.gb : null };
        this.hist.push(s);
        while (this.hist.length && t - this.hist[0].t > HIST_MS) this.hist.shift();

        if (gear !== this.lastGear) {
            if (gear && this.lastGear && gear === this.lastGear + 1 && d.speed > 10 && this._loaded(t - 600, t)) this.pending.push({ from: this.lastGear, to: gear, tc: t });
            this.lastGear = gear; this.gearSince = t;
        }
        const steady = gear && k && t - this.gearSince > 600;
        this._syncKnown();
        // the gear's ratio: the shift map's when it knows it, else learned here under load only
        if (steady && this._load(s)) this._refine(gear, k);
        this.prevK = steady ? k : null;
        // the pull: acceleration under load per gear and 250 rpm (saved every few minutes, not on each sample)
        if (steady && isNum(s.g) && this._load(s)) {
            const b = Math.floor(d.rpm / BIN), p = (this.pull[gear] = this.pull[gear] || {}), c = (p[b] = p[b] || [0, 0]);
            if (c[1] < 400) { c[0] += s.g; c[1]++; } else { c[0] += s.g - c[0] / c[1]; }
            this.dirty = true;
        }
        while (this.pending.length && t - this.pending[0].tc >= WAIT_MS) this._finish(this.pending.shift());
    }

    /** The shift map's ratios win wherever it knows the gear. */
    _syncKnown() {
        for (let g = 1; g <= MAX_GEAR; g++) {
            const k = this.known(g);
            if (isNum(k) && k > 0 && this.ratios[g] !== k) { this.ratios[g] = k; this.dirty = true; }
        }
    }

    /**
     * Refine gear g's own ratio from k (under load, the gear held): only when k is steady since the last sample (2 %) and
     * within 3 % of what is learned. A gear the shift map knows is left alone. RATIO_RESET steady readings in a row that
     * disagree under load mean the first reading was wrong: the gear starts again from k.
     */
    _refine(g, k) {
        if (isNum(this.known(g))) return;
        if (!isNum(this.prevK) || Math.abs(k - this.prevK) / this.prevK > RATIO_STEP) return;
        const r = this.ratios[g];
        if (!isNum(r)) { this.ratios[g] = k; this.dirty = true; return; }
        if (Math.abs(k - r) / r > RATIO_TOL) {
            this.rej[g] = (this.rej[g] || 0) + 1;
            if (this.rej[g] >= RATIO_RESET) { this.ratios[g] = k; this.rej[g] = 0; this.dirty = true; }
            return;
        }
        this.rej[g] = 0;
        const n = r + (k - r) * 0.02;
        if (Math.abs(n - r) / r > 0.0005) this.dirty = true;
        this.ratios[g] = n;
    }

    _load(s) { return (isNum(s.tq) && s.tq >= this.minTorque) || (isNum(s.g) && s.g >= 0.08); }
    _loaded(a, b) { const l = this.hist.filter((s) => s.t >= a && s.t <= b); return l.length > 0 && l.filter((s) => this._load(s)).length >= l.length / 2; }

    _finish(p) {
        const H = this.hist, inR = (a, b) => H.filter((s) => s.t >= a && s.t <= b);
        const pre = inR(p.tc - 1200, p.tc);
        if (!pre.length) return;
        const start = pre.reduce((m, s) => (s.rpm >= m.rpm ? s : m), pre[0]);
        const post = inR(start.t, start.t + 1500).slice(1);
        if (!post.length) return;
        const later = inR(p.tc + 1000, p.tc + WAIT_MS).map((s) => s.k).filter(isNum).sort((a, b) => a - b);
        const kTo = isNum(this.ratios[p.to]) ? this.ratios[p.to] : later.length ? later[Math.floor(later.length / 2)] : null;
        let end = kTo ? post.find((s) => isNum(s.k) && Math.abs(s.k - kTo) / kTo < 0.03) : null;
        if (!end) end = post.reduce((m, s) => (s.rpm <= m.rpm ? s : m), post[0]);
        const before = inR(start.t - 500, start.t), during = inR(start.t, end.t), after = inR(end.t, end.t + 500);
        const num = (l, f) => l.map(f).filter(isNum);
        const dip = num(during, (s) => s.g);
        const sh = {
            at: start.t, from: p.from, to: p.to, ms: Math.max(10, r10(end.t - start.t)),
            rpmBefore: Math.round(start.rpm), rpmAfter: Math.round(end.rpm), kmh: r1(start.kmh),
            gBefore: r1(avg(num(before, (s) => s.g)), 3), gDip: dip.length ? r1(Math.min.apply(null, dip), 3) : null,
            gAfter: r1(avg(num(after, (s) => s.g)), 3), tqBefore: r1(avg(num(before, (s) => s.tq))), tqAfter: r1(avg(num(after, (s) => s.tq))),
        };
        if (isNum(start.gb)) sh.gb = Math.round(start.gb);          // the gearbox oil then (Cold vs hot page)
        this.shifts.unshift(sh);
        if (this.shifts.length > MAX) this.shifts.length = MAX;
        this.changed = true;
        if (this.onShift) this.onShift(sh);
    }

    pullCurves() { return pullCurves(this.pull); }
    perGear() { return perGear(this.shifts); }

    toJSON() {
        const ratios = {}; Object.keys(this.ratios).forEach((g) => { ratios[g] = r1(this.ratios[g], 3); });
        return { shifts: this.shifts, ratios, pull: this.pull };
    }

    load(o) {
        if (!o) return;
        if (Array.isArray(o.shifts)) this.shifts = o.shifts.filter((x) => x && isNum(x.ms)).slice(0, MAX);
        if (o.ratios) Object.keys(o.ratios).forEach((g) => { if (isNum(o.ratios[g])) this.ratios[g] = o.ratios[g]; });
        if (o.pull && typeof o.pull === 'object') this.pull = o.pull;
    }

    clear() { this.shifts = []; this.pull = {}; this.changed = true; }
    /** Something to save (a new shift, or only the pull and ratios). */
    unsaved() { return this.changed || this.dirty; }
    saved() { this.changed = false; this.dirty = false; }
}

function pullCurves(pull) {
    const out = {};
    Object.keys(pull || {}).forEach((g) => {
        out[g] = Object.keys(pull[g]).map(Number).sort((a, b) => a - b)
            .filter((b) => pull[g][b][1] >= 3).map((b) => [b * BIN + BIN / 2, pull[g][b][0] / pull[g][b][1]]);
    });
    return out;
}

function perGear(shifts) {
    const by = {};
    shifts.forEach((s) => { (by[s.from] = by[s.from] || []).push(s); });
    return Object.keys(by).map(Number).sort((a, b) => a - b).map((f) => {
        const l = by[f];
        return { from: f, to: f + 1, n: l.length, avgMs: r10(avg(l.map((s) => s.ms))), bestMs: best(l.map((s) => s.ms)),
            avgDrop: Math.round(avg(l.map((s) => s.rpmBefore - s.rpmAfter))) };
    });
}

module.exports = { ShiftLog, perGear, pullCurves, pct, best, r10, MAX, BIN };
