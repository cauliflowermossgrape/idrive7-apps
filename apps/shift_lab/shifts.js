'use strict';
/**
 * shifts.js - Shift Lab's measuring: every upshift under load, and how hard the car pulls in each gear across the revs.
 *
 *   const s = new ShiftLog({ minTorque });
 *   s.feed(d, t)          d = car.data() ({ rpm, speed, gLong, torque, gear }), t = ms; on every sample
 *   s.shifts              the last MAX upshifts, newest first:
 *                         { at, from, to, ms, rpmBefore, rpmAfter, kmh, gBefore, gDip, gAfter, tqBefore, tqAfter }
 *   s.ratios              the learned rpm per km/h of each gear: { 1: 117.2, 2: 77.3, ... }
 *   s.pullCurves()        { gear: [[rpm, g], ...] } the average acceleration under load per 250 rpm, per gear
 *   s.perGear()           [{ from, to, n, avgMs, bestMs, avgDrop }] by gear change
 *   s.toJSON() / s.load(o) what is kept in the app's data folder
 *
 * How a shift is measured (the car sends no shift time): the gear the car reports (or Car's learned guess) steps up
 * while the engine pulls. Two seconds later the history around that moment is read back: the shift starts at the
 * highest rpm just before it (the engine stops pulling up) and ends when the rpm per km/h reaches the new gear's ratio
 * (within 3 %), else at the lowest rpm after it. Under load = engine torque at least minTorque, or 0.08 g forward.
 */
const MAX = 200, HIST_MS = 4000, WAIT_MS = 2000, BIN = 250;
const isNum = (v) => typeof v === 'number' && isFinite(v);
const avg = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const r1 = (v, d) => (isNum(v) ? Math.round(v * Math.pow(10, d || 0)) / Math.pow(10, d || 0) : null);

class ShiftLog {
    constructor(o) {
        o = o || {};
        this.minTorque = o.minTorque || 100;
        this.shifts = []; this.ratios = {}; this.pull = {};
        this.hist = []; this.pending = []; this.lastGear = null; this.gearSince = 0; this.changed = false;
    }

    feed(d, t) {
        if (!d || !isNum(d.rpm) || !isNum(d.speed)) return;
        const gear = isNum(d.gear) && d.gear >= 1 ? d.gear : null;
        const k = d.speed > 8 && d.rpm > 800 ? d.rpm / d.speed : null;
        const s = { t, rpm: d.rpm, kmh: d.speed, g: isNum(d.gLong) ? d.gLong : null, tq: isNum(d.torque) ? d.torque : null, gear, k };
        this.hist.push(s);
        while (this.hist.length && t - this.hist[0].t > HIST_MS) this.hist.shift();

        if (gear !== this.lastGear) {
            if (gear && this.lastGear && gear === this.lastGear + 1 && d.speed > 10 && this._loaded(t - 600, t)) this.pending.push({ from: this.lastGear, to: gear, tc: t });
            this.lastGear = gear; this.gearSince = t;
        }
        const steady = gear && k && t - this.gearSince > 600;
        // the gear's ratio, learned while it is held
        if (steady) {
            const r = this.ratios[gear];
            this.ratios[gear] = isNum(r) && Math.abs(r - k) / r < 0.08 ? r + (k - r) * 0.02 : isNum(r) ? r + (k - r) * 0.002 : k;
        }
        // the pull: acceleration under load per gear and 250 rpm
        if (steady && isNum(s.g) && this._load(s)) {
            const b = Math.floor(d.rpm / BIN), p = (this.pull[gear] = this.pull[gear] || {}), c = (p[b] = p[b] || [0, 0]);
            if (c[1] < 400) { c[0] += s.g; c[1]++; } else { c[0] += s.g - c[0] / c[1]; }
            this.changed = true;
        }
        while (this.pending.length && t - this.pending[0].tc >= WAIT_MS) this._finish(this.pending.shift());
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
            at: start.t, from: p.from, to: p.to, ms: Math.max(10, Math.round(end.t - start.t)),
            rpmBefore: Math.round(start.rpm), rpmAfter: Math.round(end.rpm), kmh: r1(start.kmh),
            gBefore: r1(avg(num(before, (s) => s.g)), 3), gDip: dip.length ? r1(Math.min.apply(null, dip), 3) : null,
            gAfter: r1(avg(num(after, (s) => s.g)), 3), tqBefore: r1(avg(num(before, (s) => s.tq))), tqAfter: r1(avg(num(after, (s) => s.tq))),
        };
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
        return { from: f, to: f + 1, n: l.length, avgMs: Math.round(avg(l.map((s) => s.ms))), bestMs: Math.min.apply(null, l.map((s) => s.ms)),
            avgDrop: Math.round(avg(l.map((s) => s.rpmBefore - s.rpmAfter))) };
    });
}

module.exports = { ShiftLog, perGear, pullCurves, MAX, BIN };
