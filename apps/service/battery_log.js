'use strict';
/**
 * battery_log.js - Service's Battery tab memory: from the engine's rpm, the charge the car reports and the 12 V readings,
 * one entry per start of the car. The rpm and the charge are broadcast (recorded in the background); the voltage is
 * read only while the Battery page shows, so a start without the page open has its time and charge, no voltages.
 *
 *   resting    the first reading after the car woke up (the app started), engine off: what the battery holds after
 *              standing. Only the first start after a wake counts; auto start / stop restarts are not starts here.
 *   cranking   the lowest reading from CRANK_BEFORE_MS before the engine turned until CRANK_AFTER_MS after it did.
 *              The car is asked about once a second, so this is the lowest SEEN: the real dip is usually lower.
 *   charge     the battery's charge the car reports (CDS statusBattery2, %), the last value before the engine turned
 *   charging   the middle (median) reading once the engine ran RUN_SETTLE_MS, until RUN_MS (BMW's energy management
 *              charges and rests the battery in turns, so the middle value says more than one reading).
 *
 *   const L = new StartLog({ keep, now, onEntry, entries })
 *   L.volt(v, t)              a reading (V) at time t
 *   L.rpm(rpm, t)             the engine's rpm (0 = off)
 *   L.soc(pct)                the charge the car reports
 *   L.phase()                 'rest' (engine off, waiting for the start), 'crank', 'run', 'done' (this wake's start done)
 *   L.current()               the entry being made: { at, rest, restAt, crank, crankN, runs: [] }
 *   L.finish(t)               close the entry now (the app is closing): kept if it has anything
 *   L.entries                 the kept ones, oldest first: [{ at, rest, crank, crankN, run, soc }]
 *   L.trace                   this wake's readings [{ t, v }] (the last TRACE_MS) and L.startAt (when the engine turned)
 */
const CRANK_BEFORE_MS = 3000, CRANK_AFTER_MS = 8000, RUN_SETTLE_MS = 60000, RUN_MS = 10 * 60000, TRACE_MS = 15 * 60000;
const ENGINE_RPM = 400;
const isNum = (x) => typeof x === 'number' && isFinite(x);
const median = (a) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

class StartLog {
    constructor(o) {
        o = o || {};
        this.keep = o.keep || 60; this.now = o.now || Date.now; this.onEntry = o.onEntry || (() => {});
        this.entries = Array.isArray(o.entries) ? o.entries.slice(-this.keep) : [];
        this.trace = []; this.startAt = null; this.runAt = null;
        this.state = 'rest'; this.lastRpm = null;
        this.cur = { at: null, rest: null, restAt: null, crank: null, crankN: 0, runs: [], soc: null };
    }

    phase() { return this.state; }
    current() { return this.cur; }

    volt(v, t) {
        if (!isNum(v)) return;
        t = isNum(t) ? t : this.now();
        this.trace.push({ t, v });
        while (this.trace.length && t - this.trace[0].t > TRACE_MS) this.trace.shift();
        const c = this.cur;
        if (this.state === 'rest' && c.rest === null && !(this.lastRpm > 0)) { c.rest = v; c.restAt = t; }
        if (this.state === 'crank' || (this.state === 'run' && t - this.startAt <= CRANK_AFTER_MS)) {
            c.crank = c.crank === null ? v : Math.min(c.crank, v); c.crankN++;
        }
        if (this.state === 'run' && t - this.runAt >= RUN_SETTLE_MS) c.runs.push(v);
        if (this.state === 'run' && t - this.runAt >= RUN_MS) this._close(t);
    }

    soc(p) {
        // until the engine turns: what the battery held at the start
        if (isNum(p) && (this.state === 'rest' || this.cur.soc === null)) this.cur.soc = p;
    }

    rpm(r, t) {
        t = isNum(t) ? t : this.now();
        if (!isNum(r)) return;
        const was = this.lastRpm;
        this.lastRpm = r;
        if (this.state === 'rest' && r > 0) {
            // the engine turns: the readings of the last seconds before it count for the dip too
            this.state = 'crank'; this.startAt = t; this.cur.at = t;
            this.trace.filter((x) => t - x.t <= CRANK_BEFORE_MS).forEach((x) => {
                this.cur.crank = this.cur.crank === null ? x.v : Math.min(this.cur.crank, x.v); this.cur.crankN++;
            });
        }
        if (this.state === 'crank' && r >= ENGINE_RPM) { this.state = 'run'; this.runAt = t; }
        if (this.state === 'crank' && r === 0 && was > 0 && t - this.startAt > CRANK_AFTER_MS) {
            // it did not start: this try is kept, and the next one counts as a start again
            this._close(t); this.state = 'rest';
        }
        if (this.state === 'run' && r === 0) this._close(t);
    }

    finish(t) { if (this.state !== 'done') this._close(isNum(t) ? t : this.now()); }

    _close(t) {
        const c = this.cur, run = median(c.runs);
        this.state = 'done';
        if (c.at === null && c.rest === null) return null;
        const e = { at: c.at || c.restAt || t, rest: c.rest, crank: c.crank, crankN: c.crankN, run: run === null ? null : Math.round(run * 100) / 100,
            soc: isNum(c.soc) ? Math.round(c.soc) : null };
        this.entries.push(e);
        this.entries = this.entries.slice(-this.keep);
        this.cur = { at: null, rest: null, restAt: null, crank: null, crankN: 0, runs: [], soc: null };
        this.onEntry(e);
        return e;
    }
}

/** A straight line through the points (least squares): { slope per point, at(i) } or null with fewer than 4. */
function trend(vals) {
    const p = vals.map((v, i) => [i, v]).filter((x) => isNum(x[1]));
    if (p.length < 4) return null;
    const n = p.length, sx = p.reduce((a, x) => a + x[0], 0), sy = p.reduce((a, x) => a + x[1], 0);
    const sxx = p.reduce((a, x) => a + x[0] * x[0], 0), sxy = p.reduce((a, x) => a + x[0] * x[1], 0);
    const d = n * sxx - sx * sx;
    if (!d) return null;
    const slope = (n * sxy - sx * sy) / d, b = (sy - slope * sx) / n;
    return { slope, at: (i) => b + slope * i };
}

module.exports = { StartLog, trend, median, CRANK_BEFORE_MS, CRANK_AFTER_MS, RUN_SETTLE_MS, RUN_MS, ENGINE_RPM };
