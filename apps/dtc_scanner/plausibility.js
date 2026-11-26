'use strict';
/**
 * plausibility.js - the Fault Scanner's Plausibility tab, its logic: pairs of values the car sends that have to agree with each other, and each
 * signal's own rhythm. It cannot tell which sensor is wrong, only that two disagree or one went quiet.
 *
 *   const s = new Sanity({ gears });        gears = ratios learned before ([{ k, n }], rpm per km/h)
 *   s.feed(name, value, tMs)                name = rpm | speed | gLong | oil | coolant | outside
 *   s.tick(tMs)                             re-evaluates every check (call 5 to 10 times a second)
 *   s.pause()                               the watches stopped (page left): the last values are forgotten, so
 *                                           nothing reads as LATE or as a jump when they start again
 *   s.checks                                { id: { state: 'OK' | 'ODD' | 'LATE' | 'NO DATA', reason, since } }
 *   s.events                                newest last: [{ t, id, state, reason }] (at most MAX_EVENTS)
 *   s.hist[name]                            [[t, value], ...] for the charts (one point a second, 10 min)
 *
 * The checks:
 *   gear       rpm per km/h sits on one of the learned gears above 30 km/h; off every gear line for 3 s while
 *              the ratio is steady (not shifting) is ODD. Needs two gears learned first: a ratio counts as a gear
 *              after 20 s spent on it, and only seconds at a steady speed with a steady ratio count (low slip: a
 *              converter or clutch slipping while the car speeds up or slows down never becomes a gear).
 *   temps      once the coolant has been at 80 C or more for 10 min with the engine running, oil far below the
 *              coolant (25 C) is ODD (a cold or short winter drive never gets there); so is a jump of more than
 *              15 C in one second in either of them.
 *   gspeed     the forward g the car sends against the speed change over the same 2 s (an estimate: a hill
 *              adds g the speed does not show): 0.15 g apart in three windows in a row above 20 km/h is ODD.
 *   outside    the outside temperature jumping more than 5 C within 2 s is ODD (kept for a minute).
 *   late       rpm, speed and g are sent several times a second while driving; one quiet for 5x its usual
 *              gap (and at least 2 s) is LATE. Temperatures change slowly and are sent on change only, so not checked.
 */
const IDS = ['gear', 'temps', 'gspeed', 'outside', 'late'];
const NAMES = { gear: 'Speed against rpm', temps: 'Oil against coolant', gspeed: 'G against speed change', outside: 'Outside temperature', late: 'Signals on time' };
const MAX_EVENTS = 100, HIST_MS = 600000, G0 = 9.80665;
const WARM_C = 80, WARM_MS = 600000;          // the temperature check: coolant at 80 C or more for 10 min
const STEADY_RATIO = 0.02, STEADY_KMH_S = 1.5, STEADY_G = 0.05, LEARN_N = 20;
const isNum = (v) => typeof v === 'number' && isFinite(v);

class Sanity {
    constructor(o) {
        o = o || {};
        this.gears = (o.gears || []).filter((g) => g && g.k > 0).map((g) => ({ k: g.k, n: Math.max(31, g.n || 31) }));
        this.v = {}; this.at = {}; this.gap = {};          // last value, its time, usual gap (ms) per signal
        this.hist = {}; this.histAt = {};
        this.ratio = [];                                   // [[t, rpm per km/h]] for the last 2 s
        this.offSince = 0; this.gWin = []; this.gBad = 0; this.lastWin = 0;
        this.runMs = o.runMs || 0; this.warmMs = o.warmMs || 0; this.lastTick = 0; this.outsideOddUntil = 0; this.tempOddUntil = 0;
        this.checks = {}; IDS.forEach((id) => { this.checks[id] = { state: 'NO DATA', reason: 'Waiting for the car', since: 0 }; });
        this.events = (o.events || []).slice(-MAX_EVENTS);
    }

    /** The watches stopped: forget the last values (a stale speed would read as LATE, a stale oil as a jump). */
    pause() {
        this.v = {}; this.at = {}; this.ratio = []; this.gWin = []; this.offSince = 0; this.gBad = 0; this.lastWin = 0;
        this.lastTick = 0; this.ptAt = 0;
    }

    feed(name, value, t) {
        if (!isNum(value)) return;
        const prev = this.v[name], prevAt = this.at[name];
        if (prevAt !== undefined && t > prevAt) {
            const dt = t - prevAt, g = this.gap[name];
            if (dt < 10000) this.gap[name] = g === undefined ? dt : g + (dt - g) * 0.05;
            // a jump of more than 15 C in 1 s (oil or coolant) or 5 C in 2 s (outside)
            if ((name === 'oil' || name === 'coolant') && isNum(prev) && dt <= 1000 && Math.abs(value - prev) > 15) {
                this.tempOddUntil = t + 60000;
                this.tempWhy = (name === 'oil' ? 'Oil' : 'Coolant') + ' jumped ' + Math.round(Math.abs(value - prev)) + ' C in ' + (dt / 1000).toFixed(1) + ' s';
            }
            if (name === 'outside' && isNum(prev) && dt <= 2000 && Math.abs(value - prev) > 5) {
                this.outsideOddUntil = t + 60000;
                this.outsideWhy = 'Jumped from ' + prev.toFixed(1) + ' to ' + value.toFixed(1) + ' C in ' + (dt / 1000).toFixed(1) + ' s';
            }
        }
        this.v[name] = value; this.at[name] = t;
        const h = this.hist[name] = this.hist[name] || [];
        if (!this.histAt[name] || t - this.histAt[name] >= 1000) { h.push([t, value]); this.histAt[name] = t; }
        while (h.length && t - h[0][0] > HIST_MS) h.shift();
        if (name === 'rpm' || name === 'speed') this._ratio(t);
        if (name === 'speed') this.gWin.push([t, value, this.v.gLong]);
    }

    /* the gearbox learned from rpm per km/h, one cluster per gear (as kit/car.js GearGuess does) */
    _ratio(t) {
        const rpm = this.v.rpm, kmh = this.v.speed;
        if (!(rpm > 1100 && kmh > 8)) return;
        const k = rpm / kmh;
        this.ratio.push([t, k, kmh]);
        this.pts = this.pts || [];
        if (!this.ptAt || t - this.ptAt >= 1000) { this.pts.push([kmh, rpm]); this.ptAt = t; if (this.pts.length > 180) this.pts.shift(); }
        while (this.ratio.length && t - this.ratio[0][0] > 1500) this.ratio.shift();
        // learned only at low slip: the ratio and the speed steady over the last second or more, little forward g
        // (a torque converter slipping while the car speeds up holds an in-between ratio for many seconds)
        const r = this.ratio, a = r[0], span = (t - a[0]) / 1000, ks = r.map((x) => x[1]);
        const steady = r.length > 3 && span >= 1 && (Math.max.apply(null, ks) - Math.min.apply(null, ks)) / k < STEADY_RATIO
            && Math.abs(kmh - a[2]) / span < STEADY_KMH_S && !(Math.abs(this.v.gLong) > STEADY_G);
        if (!steady) return;
        let c = this.gears.find((x) => Math.abs(x.k - k) / x.k < 0.04);
        if (!c) { if (this.gears.length > 24) this.gears.sort((a, b) => b.n - a.n).pop(); c = { k, n: 0, at: 0 }; this.gears.push(c); }
        c.k += (k - c.k) / Math.min(c.n + 1, 50);
        // n counts seconds spent on this ratio, so a clutch slipping for a few seconds never becomes a gear
        if (t - (c.at || 0) >= 1000) {
            c.n++; c.at = t;
            if (c.n === LEARN_N + 1) this.dirty = true;     // a gear just learned: saved (plausibility.json)
        }
    }
    learned() { return this.gears.filter((x) => x.n > LEARN_N).sort((a, b) => b.k - a.k); }

    _set(id, state, reason, t) {
        const c = this.checks[id];
        if (c.state !== state) {
            if ((state === 'ODD' || state === 'LATE') && c.state !== state) {
                this.events.push({ t, id, state, reason });
                if (this.events.length > MAX_EVENTS) this.events.shift();
                this.dirty = true;
            }
            c.since = t;
        }
        c.state = state; c.reason = reason;
    }

    tick(t) {
        const v = this.v, driving = v.speed > 5;
        if (this.lastTick && v.rpm > 400) {
            const dt = Math.min(2000, t - this.lastTick);
            this.runMs += dt;
            if (v.coolant >= WARM_C) this.warmMs += dt;
        }
        this.lastTick = t;

        // gear: on a learned line, or shifting
        const gears = this.learned();
        if (gears.length < 2) this._set('gear', 'NO DATA', 'Learning the gears: ' + gears.length + ' of at least 2 so far', t);
        else if (!(v.speed > 30 && v.rpm > 1100)) { this.offSince = 0; this._set('gear', 'OK', gears.length + ' gears learned; checked above 30 km/h', t); }
        else {
            const k = v.rpm / v.speed, near = gears.find((x) => Math.abs(x.k - k) / x.k < 0.04);
            const ks = this.ratio.map((r) => r[1]), steady = ks.length > 3 && (Math.max.apply(null, ks) - Math.min.apply(null, ks)) / k < 0.03;
            if (near || !steady) { this.offSince = 0; this._set('gear', 'OK', near ? 'On gear ' + (gears.indexOf(near) + 1) + ': ' + k.toFixed(1) + ' rpm per km/h' : 'Shifting', t); }
            else {
                if (!this.offSince) this.offSince = t;
                if (t - this.offSince >= 3000) this._set('gear', 'ODD', k.toFixed(1) + ' rpm per km/h is on no gear for ' + Math.round((t - this.offSince) / 1000) + ' s: a slipping clutch or converter, or a wrong rpm or speed', t);
            }
        }

        // temps
        if (!isNum(v.oil) || !isNum(v.coolant)) this._set('temps', 'NO DATA', 'Waiting for oil and coolant', t);
        else if (t < this.tempOddUntil) this._set('temps', 'ODD', this.tempWhy, t);
        else if (this.warmMs >= WARM_MS && v.coolant >= WARM_C && v.oil < v.coolant - 25) this._set('temps', 'ODD', 'Oil ' + Math.round(v.oil) + ' C is ' + Math.round(v.coolant - v.oil) + ' C below the coolant after ' + Math.round(this.warmMs / 60000) + ' min with the coolant warm', t);
        else this._set('temps', 'OK', this.warmMs < WARM_MS || v.coolant < WARM_C ? 'Warming up: compared after 10 min with the coolant at 80 C or more (' + Math.round(this.warmMs / 60000) + ' so far)' : 'Oil ' + Math.round(v.oil) + ' C, coolant ' + Math.round(v.coolant) + ' C', t);

        // g against speed change, 2 s windows
        while (this.gWin.length && t - this.gWin[0][0] > 2000) this.gWin.shift();
        if (!isNum(v.gLong)) this._set('gspeed', 'NO DATA', 'Waiting for forward g', t);
        else if (!(v.speed > 20)) { this.gBad = 0; this._set('gspeed', 'OK', 'Compared above 20 km/h', t); }
        else if (this.gWin.length > 4 && t - this.lastWin >= 2000) {
            this.lastWin = t;
            const a = this.gWin[0], b = this.gWin[this.gWin.length - 1], dt = (b[0] - a[0]) / 1000;
            const fromSpeed = dt > 1 ? (b[1] - a[1]) / 3.6 / dt / G0 : null;
            const gs = this.gWin.map((x) => x[2]).filter(isNum), sent = gs.length ? gs.reduce((s, x) => s + x, 0) / gs.length : null;
            if (isNum(fromSpeed) && isNum(sent)) {
                this.gDiff = sent - fromSpeed;
                (this.gPairs = this.gPairs || []).push([t, sent, fromSpeed]);
                while (this.gPairs.length && t - this.gPairs[0][0] > 120000) this.gPairs.shift();
                this.gBad = Math.abs(this.gDiff) > 0.15 ? this.gBad + 1 : 0;
                if (this.gBad >= 3) this._set('gspeed', 'ODD', 'Sent ' + sent.toFixed(2) + ' g, the speed change says ' + fromSpeed.toFixed(2) + ' g, three times in a row (a steep hill does this too)', t);
                else this._set('gspeed', 'OK', 'Sent ' + sent.toFixed(2) + ' g, from the speed ' + fromSpeed.toFixed(2) + ' g', t);
            }
        }

        // outside
        if (!isNum(v.outside)) this._set('outside', 'NO DATA', 'Waiting for the outside temperature', t);
        else if (t < this.outsideOddUntil) this._set('outside', 'ODD', this.outsideWhy, t);
        else this._set('outside', 'OK', v.outside.toFixed(1) + ' C, no sudden jumps', t);

        // late: the fast signals while driving
        const late = ['rpm', 'speed', 'gLong'].filter((n) => this.at[n] !== undefined && this.gap[n] && driving
            && t - this.at[n] > Math.max(2000, 5 * this.gap[n]));
        if (!driving) this._set('late', 'OK', 'Checked while driving', t);
        else if (late.length) this._set('late', 'LATE', late.map((n) => LABEL[n] + ' quiet ' + ((t - this.at[n]) / 1000).toFixed(1) + ' s (usually every ' + Math.round(this.gap[n]) + ' ms)').join(', '), t);
        else this._set('late', 'OK', 'rpm, speed and g arrive on time', t);
    }

    /** Each fast signal: its usual gap and how long it has been quiet, for the chart. */
    ages(t) { return ['rpm', 'speed', 'gLong'].map((n) => ({ name: LABEL[n], gap: this.gap[n], age: this.at[n] === undefined ? null : t - this.at[n] })); }

    save() { return { gears: this.learned().map((x) => ({ k: Math.round(x.k * 1e3) / 1e3, n: Math.min(x.n, 1000) })), events: this.events }; }
}
const LABEL = { rpm: 'rpm', speed: 'speed', gLong: 'forward g' };

module.exports = { Sanity, IDS, NAMES, MAX_EVENTS };
