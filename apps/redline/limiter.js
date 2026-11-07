'use strict';
/**
 * Learns the engine's real rev limit from the rpm plateau it makes on the limiter, so the
 * redline (and the shift point from it) fits the car, a tuned one with a raised limiter too.
 *
 * A plateau: in gear and moving, rpm at least `floor`, for at least 500 ms the rpm stays within
 * a 200 rpm band and does not trend (the two halves' averages within 60 rpm: a pull in a tall
 * gear rises slowly but steadily, the limiter bounces about one level). Its top, rounded to 50,
 * counts when the rpm leaves the plateau, only while the oil is warm (the DME limits a cold
 * engine lower). The first value needs two plateaus within 100 rpm (a steady hold in gear looks
 * like one); after that the highest seen is kept in data/limiter.json, so a pull that stops
 * short of the cut never lowers it; "Learn redline" off forgets it.
 *
 *   const lim = new Limiter({ dataDir, log });
 *   lim.feed(tMs, { rpm, gear, speed, warm }, floor, ceil);   // every live sample
 *   lim.value()   -> rpm or null;  lim.onChange(fn);  lim.forget()
 */
const fs = require('fs');
const path = require('path');

// the plateau is judged on the last HOLD_MS only, so the end of the run up to it doesn't count
const HOLD_MS = 500, BAND = 200, TREND = 60, WINDOW_MS = HOLD_MS + 20;

class Limiter {
    constructor(opts) {
        this.log = opts.log;
        this.file = path.join(opts.dataDir, 'limiter.json');
        this.saved = null; this.at = 0;
        this.win = []; this.peak = null; this.listeners = [];
        try {
            const j = JSON.parse(fs.readFileSync(this.file, 'utf8'));
            if (typeof j.rpm === 'number' && j.rpm > 0) { this.saved = j.rpm; this.at = j.at || 0; }
        } catch (e) { /* none yet */ }
    }

    value() { return this.saved; }
    onChange(fn) { this.listeners.push(fn); }

    forget() {
        if (this.saved === null) return;
        this.saved = null;
        try { fs.unlinkSync(this.file); } catch (e) { /* gone */ }
        this.log.info('limiter: learned redline forgotten');
        this._emit();
    }

    /** One live sample; floor / ceil = the rpm range a limiter can be in for this engine. */
    feed(t, s, floor, ceil) {
        try {
            const ok = typeof s.rpm === 'number' && s.rpm >= floor && s.rpm <= ceil + 300 &&
                !(typeof s.gear === 'number' && s.gear <= 0) && !(typeof s.speed === 'number' && s.speed < 15) && s.warm;
            if (!ok) { this._end(); this.win.length = 0; return; }
            this.win.push([t, s.rpm]);
            while (this.win.length && t - this.win[0][0] > WINDOW_MS) this.win.shift();
            if (t - this.win[0][0] < HOLD_MS - 60) return;
            let lo = Infinity, hi = -Infinity;
            this.win.forEach((w) => { lo = Math.min(lo, w[1]); hi = Math.max(hi, w[1]); });
            if (hi - lo > BAND) return;
            const half = this.win.length >> 1;
            const avg = (a) => a.reduce((x, w) => x + w[1], 0) / a.length;
            if (half < 2 || Math.abs(avg(this.win.slice(0, half)) - avg(this.win.slice(half))) > TREND) return;
            this.peak = Math.max(this.peak || 0, hi);
            this.ceil = ceil;
        } catch (e) { this.log.warn('limiter: ' + e); }
    }

    _end() {
        if (this.peak === null) return;
        let rpm = Math.min(Math.round(this.peak / 50) * 50, this.ceil);
        this.peak = null;
        if (this.saved !== null && rpm <= this.saved) { this.log.info('limiter: plateau at ' + rpm + ' (kept ' + this.saved + ')'); return; }
        // the first value takes two plateaus within 100 rpm (a steady hold in gear looks like one);
        // after that one higher is enough: nothing holds steady above the real cut
        if (this.saved === null) {
            const p = this.pending;
            if (!p || Math.abs(p - rpm) > 100) { this.pending = rpm; this.log.info('limiter: plateau at ' + rpm + ', waiting for a second'); return; }
            rpm = Math.max(p, rpm); this.pending = null;
        }
        this.log.info('limiter: learned ' + rpm + ' rpm' + (this.saved !== null ? ' (was ' + this.saved + ')' : ''));
        this.saved = rpm; this.at = Date.now();
        try { fs.writeFileSync(this.file, JSON.stringify({ rpm: rpm, at: this.at })); } catch (e) { this.log.warn('limiter save: ' + e); }
        this._emit();
    }

    _emit() { this.listeners.forEach((fn) => { try { fn(this.saved); } catch (e) { this.log.error(e); } }); }
}

module.exports = Limiter;
