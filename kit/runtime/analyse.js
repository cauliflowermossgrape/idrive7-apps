'use strict';
/**
 * analyse.js - live analysis for diagnostic apps: what is normal for this car right now, what left it, what moved first.
 * Plain numbers in, plain results out; no signals, no drawing, no files (the app does those), so it tests on its own.
 *
 *   const A = new Analyser({ channels, checks, bucket, window })
 *     channels  [{ id, name, unit, role: 'command' | 'result' | 'state', minSpread }]   role: drawn on top (what the
 *               driver or the car asked for) or below (what came of it) in a cause-and-effect view
 *     checks    [{ id, name, x: 'torque', y: 'gLong', bucket(v) -> key | null, when(v) -> bool, minSpread, hint }]
 *               "y should follow x": the analyser learns a straight line y = a + b x per bucket (for one gear, one rpm band ...)
 *               and how far y usually sits from that line; a sample far off the line is an anomaly
 *     window    ms of every channel kept (default 60 s)
 *   A.push(t, values)            once per sample (10 a second): values = { channelId: number | null }
 *   A.state(id)                  a check now: { learned, expected, actual, z, level: 'learning' | 'ok' | 'odd' | 'off' }
 *   A.events                     anomalies so far (newest last): { id, check, t0, t1, peakZ, bucket, repeat }
 *   A.firstMovers(t, back)       checks and channels in the order they went off before t (see the method)
 *   A.series(id, t0, t1)         [[t, v]] of a channel
 *   A.movers(now, ms)            channels by how fast they move against their usual spread, biggest first
 *   A.drift(healthy)             per check: how far its usual offset moved from a saved healthy baseline (in spreads)
 *   A.snapshot()/A.restore(s)    the learned baselines, for a file
 *
 * Learning: per check and bucket, a straight line y = a + b x from running sums with forgetting (each new sample weighs as one of the last ~600, about
 * a minute of that condition at 10 a second), so a baseline follows a car slowly but a sudden change stands out.
 * z = (y - the line at x) / max(spread around the line, minSpread): minSpread keeps a very steady value from calling every
 * tiny wobble an anomaly. An anomaly is |z| above Z_ODD for at least HOLD_MS; it ends once |z| is below Z_OK.
 * Transient or repeated: an anomaly of a check that already fired REPEAT_N times in the same bucket is "repeats".
 */
const Z_ODD = 4, Z_OK = 2.5, HOLD_MS = 400, LEARN_N = 60, FORGET = 600, REPEAT_N = 2;
const isNum = (v) => typeof v === 'number' && isFinite(v);

/** Ring of [t, v] for one channel. */
class Ring {
    constructor(ms) { this.ms = ms; this.a = []; }
    push(t, v) { this.a.push([t, v]); const lim = t - this.ms; let i = 0; while (i < this.a.length && this.a[i][0] < lim) i++; if (i) this.a.splice(0, i); }
    last() { return this.a.length ? this.a[this.a.length - 1][1] : null; }
    range(t0, t1) { return this.a.filter((p) => p[0] >= t0 && p[0] <= t1); }
}

/** y = a + b x (least squares), and the spread of what is left, with forgetting. */
class Line {
    constructor() { this.n = 0; this.mx = 0; this.my = 0; this.cxx = 0; this.cxy = 0; this.rv = 0; this.rm = 0; }
    b() { return this.cxx > 1e-9 ? this.cxy / this.cxx : 0; }
    at(x) { return this.my + this.b() * (x - this.mx); }
    learn(x, y) {
        const k = this.n < FORGET ? 1 / (this.n + 1) : 1 / FORGET;
        const r = this.n ? y - this.at(x) : 0;
        this.rv += (r * r - this.rv) * (this.n ? k : 1);
        const dx = x - this.mx, dy = y - this.my;
        this.mx += dx * k; this.my += dy * k;
        this.cxx += (dx * (x - this.mx) - this.cxx) * k; this.cxy += (dx * (y - this.my) - this.cxy) * k;
        this.n++;
    }
    sd() { return Math.sqrt(Math.max(0, this.rv)); }
    toJSON() { return [this.n, this.mx, this.my, this.cxx, this.cxy, this.rv]; }
    static from(a) { const l = new Line(); [l.n, l.mx, l.my, l.cxx, l.cxy, l.rv] = a; return l; }
}

class Analyser {
    constructor(o) {
        this.channels = o.channels; this.checks = o.checks; this.window = o.window || 60000;
        this.rings = {}; this.channels.forEach((c) => { this.rings[c.id] = new Ring(this.window); });
        this.lines = {};               // check id -> bucket -> Line
        this.now = {};                 // check id -> { bucket, expected, actual, z, level, t }
        this.events = []; this.open = {}; this.fired = {}; this.zr = {};   // fired: check|bucket -> count
        this.t = 0;
    }

    push(t, v) {
        this.t = t;
        this.channels.forEach((c) => { const x = v[c.id]; if (isNum(x)) this.rings[c.id].push(t, x); });
        this.checks.forEach((ck) => this._check(ck, t, v));
    }

    _check(ck, t, v) {
        const x = v[ck.x], y = v[ck.y];
        const ok = isNum(x) && isNum(y) && (!ck.when || ck.when(v));
        const b = ok ? ck.bucket ? ck.bucket(v) : 'all' : null;
        if (b === null || b === undefined) { this.now[ck.id] = { level: 'off', t }; this._end(ck, t); return; }
        const L = ((this.lines[ck.id] = this.lines[ck.id] || {})[b] = this.lines[ck.id][b] || new Line());
        const expected = L.at(x), sd = Math.max(L.sd(), ck.minSpread || 0), z = sd > 0 ? (y - expected) / sd : 0;
        const learned = L.n >= LEARN_N;
        let level = learned ? Math.abs(z) >= Z_ODD ? 'odd' : 'ok' : 'learning';
        const st = this.now[ck.id] = { bucket: b, expected, actual: y, x, z: learned ? z : null, level, t, n: L.n, spread: sd };
        if (learned) { const zr = (this.zr[ck.id] = this.zr[ck.id] || []); zr.push([t, z]); while (zr.length && zr[0][0] < t - this.window) zr.shift(); }
        // an odd sample is not learned (a fault must not become the new normal while it lasts); one in between counts
        // one time in ten, so a car that really changed still moves its baseline, slowly
        if (!learned || Math.abs(z) < Z_OK || (Math.abs(z) < Z_ODD && (L.skip = (L.skip || 0) + 1) % 10 === 0)) L.learn(x, y);
        if (!learned) return;
        const o = this.open[ck.id];
        if (Math.abs(z) >= Z_ODD) {
            if (!o) this.open[ck.id] = { since: t, peakZ: z, bucket: b };
            else if (Math.abs(z) > Math.abs(o.peakZ)) o.peakZ = z;
            const oo = this.open[ck.id];
            if (!oo.ev && t - oo.since >= HOLD_MS) {
                const key = ck.id + '|' + b, before = this.fired[key] || 0;
                this.fired[key] = before + 1;
                oo.ev = { id: this.events.length + 1, check: ck.id, t0: oo.since, t1: t, peakZ: oo.peakZ, bucket: b, repeat: before >= REPEAT_N, times: before + 1 };
                this.events.push(oo.ev);
                if (this.events.length > 200) this.events.shift();
            }
            if (oo.ev) { oo.ev.t1 = t; oo.ev.peakZ = oo.peakZ; }
            st.level = oo.ev ? 'odd' : 'ok';
        } else if (o && Math.abs(z) < Z_OK) this._end(ck, t);
        else if (o && o.ev) st.level = 'odd';
    }

    _end(ck) { delete this.open[ck.id]; }

    state(id) { return this.now[id] || { level: 'off' }; }
    series(id, t0, t1) { return this.rings[id] ? this.rings[id].range(t0, t1) : []; }
    last(id) { return this.rings[id] ? this.rings[id].last() : null; }

    /**
     * What moved first before t, two kinds, in time order:
     *   check    a check's own y went off its usual line (|z| at least Z_OK and staying there up to t): the strongest
     *            sign, it is "off for this condition", not just "changed"
     *   channel  a channel moved over 4 of its spreads away from where it sat 3 to 6 s before, and stayed away
     *            (a driver's input, a gear change: a cause, or just driving)
     * Each: { kind, id, channel, at (ms, null = did not move), mid, band }. back: how far back a check may start (ms).
     */
    firstMovers(t, back) {
        back = back || 30000;
        const out = [];
        this.checks.forEach((ck) => {
            const zs = (this.zr[ck.id] || []).filter((p) => p[0] >= t - back && p[0] <= t);
            let at = null;
            for (let i = zs.length - 1; i >= 0; i--) { if (Math.abs(zs[i][1]) >= Z_OK) at = zs[i][0]; else break; }
            out.push({ kind: 'check', id: ck.id, channel: ck.y, at });
        });
        this.channels.forEach((c) => {
            const base = this.series(c.id, t - 6000, t - 3000).map((p) => p[1]), pts = this.series(c.id, t - 3000, t);
            if (base.length < 5 || !pts.length) { out.push({ kind: 'channel', id: c.id, channel: c.id, at: null }); return; }
            const m = base.reduce((a, b) => a + b, 0) / base.length;
            const sd = Math.sqrt(base.reduce((a, b) => a + (b - m) * (b - m), 0) / base.length), lim = 4 * Math.max(sd, c.minSpread || 0);
            let at = null;
            for (let i = pts.length - 1; i >= 0; i--) { if (Math.abs(pts[i][1] - m) > lim) at = pts[i][0]; else break; }
            out.push({ kind: 'channel', id: c.id, channel: c.id, at, mid: m, band: lim });
        });
        return out.sort((a, b) => (a.at === null) - (b.at === null) || (a.at || 0) - (b.at || 0) || (a.kind === 'check' ? -1 : 1));
    }

    /** Channels by how much they changed over the last ms, measured in their own spread over the window. */
    movers(now, ms) {
        ms = ms || 2000;
        return this.channels.map((c) => {
            const all = this.series(c.id, now - this.window, now), recent = all.filter((p) => p[0] >= now - ms);
            if (all.length < 10 || recent.length < 2) return { id: c.id, score: 0 };
            const vals = all.map((p) => p[1]), m = vals.reduce((a, b) => a + b, 0) / vals.length;
            const sd = Math.max(Math.sqrt(vals.reduce((a, b) => a + (b - m) * (b - m), 0) / vals.length), c.minSpread || 1e-6);
            const d = recent[recent.length - 1][1] - recent[0][1];
            return { id: c.id, score: Math.abs(d) / sd, delta: d };
        }).sort((a, b) => b.score - a.score);
    }

    /** Learned baselines: the most-learned bucket of each check, for "this car when healthy". */
    healthy() {
        const out = {};
        Object.keys(this.lines).forEach((id) => {
            const bs = this.lines[id];
            out[id] = {};
            Object.keys(bs).forEach((b) => { if (bs[b].n >= LEARN_N) out[id][b] = { a: bs[b].at(0), b: bs[b].b(), sd: bs[b].sd(), n: bs[b].n }; });
        });
        return out;
    }

    /**
     * Drift against a saved healthy baseline: per check, the buckets both know, how far the line moved at a typical x
     * (the middle of what this bucket sees), in spreads of the healthy one. Small numbers are normal wander.
     */
    drift(healthy, typicalX) {
        const out = [];
        this.checks.forEach((ck) => {
            const h = healthy && healthy[ck.id], now = this.lines[ck.id];
            if (!h || !now) return;
            let sum = 0, n = 0;
            Object.keys(h).forEach((b) => {
                const L = now[b];
                if (!L || L.n < LEARN_N) return;
                const x = (typicalX && typicalX[ck.id]) || 1;
                const was = h[b].a + h[b].b * x, is = L.at(x), sd = Math.max(h[b].sd, ck.minSpread || 1e-6);
                sum += (is - was) / sd; n++;
            });
            if (n) out.push({ check: ck.id, spreads: sum / n, buckets: n });
        });
        return out;
    }

    snapshot() {
        const out = {};
        Object.keys(this.lines).forEach((id) => { out[id] = {}; Object.keys(this.lines[id]).forEach((b) => { out[id][b] = this.lines[id][b].toJSON(); }); });
        return { lines: out, fired: this.fired };
    }
    restore(s) {
        if (!s || !s.lines) return;
        Object.keys(s.lines).forEach((id) => { this.lines[id] = {}; Object.keys(s.lines[id]).forEach((b) => { this.lines[id][b] = Line.from(s.lines[id][b]); }); });
        this.fired = s.fired || {};
    }
}

/**
 * Two saved tests compared: each test's response averaged in bins of the input, the difference per bin, and whether it
 * is bigger than the spread inside the bins (smaller = "same": within what the car varies by itself).
 *   compareTests(a, b, bins) -> { rows: [{ x, before, after, delta, spread, verdict }], verdict }  higherIsBetter decides
 */
function binTest(pts, lo, hi, bins) {
    const w = (hi - lo) / bins, out = [];
    for (let i = 0; i < bins; i++) out.push({ x: lo + (i + 0.5) * w, v: [] });
    pts.forEach((p) => { const i = Math.floor((p[0] - lo) / w); if (i >= 0 && i < bins) out[i].v.push(p[1]); });
    return out.map((b) => {
        if (b.v.length < 2) return { x: b.x, m: null, sd: null };
        const m = b.v.reduce((a, c) => a + c, 0) / b.v.length;
        return { x: b.x, m, sd: Math.sqrt(b.v.reduce((a, c) => a + (c - m) * (c - m), 0) / b.v.length), n: b.v.length };
    });
}
function compareTests(a, b, bins, higherIsBetter) {
    bins = bins || 8;
    const all = a.points.concat(b.points).map((p) => p[0]);
    if (!all.length) return { rows: [], verdict: 'no data' };
    const lo = Math.min.apply(null, all), hi = Math.max.apply(null, all) + 1e-9;
    const A = binTest(a.points, lo, hi, bins), B = binTest(b.points, lo, hi, bins);
    let better = 0, worse = 0, same = 0;
    const rows = A.map((r, i) => {
        const s = B[i];
        if (r.m === null || s.m === null) return { x: r.x, before: r.m, after: s.m, delta: null, verdict: 'no data' };
        const delta = s.m - r.m, spread = Math.max(r.sd, s.sd, 1e-9);
        let verdict = Math.abs(delta) <= spread ? 'same' : (delta > 0) === (higherIsBetter !== false) ? 'better' : 'worse';
        if (verdict === 'same') same++; else if (verdict === 'better') better++; else worse++;
        return { x: r.x, before: r.m, after: s.m, delta, spread, verdict };
    });
    const n = better + worse + same;
    const verdict = !n ? 'no data' : better > worse && better >= n / 3 ? 'better' : worse > better && worse >= n / 3 ? 'worse' : 'same';
    return { rows, verdict, better, worse, same };
}

module.exports = { Analyser, Ring, Line, compareTests, binTest, Z_ODD, Z_OK, HOLD_MS, LEARN_N };
