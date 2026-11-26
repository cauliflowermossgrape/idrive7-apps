'use strict';
/**
 * trips.js - Trip Recap's memory: one record per drive, the newest TRIPS_KEPT kept in a JSON file.
 *
 *   const t = new Trips({ file, now });
 *   t.sample(v)      once a second, v = { speed, rpm, odo, gLong, gLat, kw, oil, coolant } (any may be null)
 *   t.current()      the drive going on now (a record as below) or null
 *   t.list()         the saved drives, newest first
 *   t.flush()        ends the drive going on now (the app is shutting down)
 *   t.mark(label, odo)   a change marked now (Service, New part, Tyres ...), for Before / After
 *   t.marks()        the marks, oldest first: [{ at, label, odo }]
 *
 * A drive starts when the car moves or the engine runs, and ends when it has stood with the engine off for END_MS
 * (or at shut-down). Shorter than MIN_SECS and MIN_KM together: not kept. The distance is the odometer's difference
 * when the car sends it, otherwise the speed added up over time.
 *
 * Record: { start, end, km, secs, moving, vAvg, vMax, gFwd, gBrake, gSide, brakes, kwMax, oilMin, oilMax, coolMin,
 *           coolMax, warm, trace: [km/h every TRACE_MS], odo }
 *         warm: seconds until the oil reached WARM_C, for a drive that started with the oil below COLD_C (else null)
 * File: { trips: [...], marks: [...] } (a plain array of drives, as 0.1 wrote it, is still read).
 */
const fs = require('fs');

const END_MS = 180000, TRACE_MS = 10000, TRIPS_KEPT = 30, MIN_SECS = 60, MIN_KM = 0.2;
const HARD_BRAKE = 0.5, REARM = 0.3, WARM_C = 80, COLD_C = 60, MARKS_KEPT = 20;
const isNum = (v) => typeof v === 'number' && isFinite(v);
const r1 = (v) => (isNum(v) ? Math.round(v * 10) / 10 : null);
const r2 = (v) => (isNum(v) ? Math.round(v * 100) / 100 : null);
const mx = (a, b) => (isNum(b) ? (isNum(a) ? Math.max(a, b) : b) : a);
const mn = (a, b) => (isNum(b) ? (isNum(a) ? Math.min(a, b) : b) : a);

class Trips {
    constructor(o) {
        this.file = o.file; this.now = o.now || Date.now; this.onSaved = o.onSaved || (() => {});
        this.cur = null; this.last = 0;
        let j = null;
        try { j = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch (e) { j = null; }
        this.trips = Array.isArray(j) ? j : j && Array.isArray(j.trips) ? j.trips : [];
        this.mk = j && !Array.isArray(j) && Array.isArray(j.marks) ? j.marks : [];
    }

    list() { return this.trips; }
    marks() { return this.mk; }

    mark(label, odo) {
        const m = { at: this.now(), label: String(label || 'Other'), odo: isNum(odo) ? odo : null };
        this.mk = this.mk.concat([m]).slice(-MARKS_KEPT);
        return this._write() ? m : Object.assign(m, { error: this.err });
    }

    _write() {
        try { fs.writeFileSync(this.file, JSON.stringify({ trips: this.trips, marks: this.mk })); return true; } catch (e) { this.err = String(e && e.message || e); return false; }
    }
    current() { return this.cur ? this._record(this.cur, this.cur.lastActive) : null; }

    sample(v) {
        const t = this.now(), dt = this.last ? Math.min(5, (t - this.last) / 1000) : 1;
        this.last = t;
        const active = (isNum(v.speed) && v.speed > 0.5) || (isNum(v.rpm) && v.rpm > 300);
        let c = this.cur;
        if (!c) {
            if (!active) return;
            c = this.cur = { start: t, lastActive: t, odo0: isNum(v.odo) ? v.odo : null, odo1: null, dist: 0, moving: 0, vSum: 0, vMax: null,
                gFwd: null, gBrake: null, gSide: null, brakes: 0, armed: true, kwMax: null, oilMin: null, oilMax: null, coolMin: null, coolMax: null,
                oil0: null, warm: null, trace: [], nextTrace: t };
        }
        if (active) c.lastActive = t;
        if (isNum(v.odo)) { if (c.odo0 === null) c.odo0 = v.odo; c.odo1 = v.odo; }
        if (isNum(v.speed)) {
            c.dist += v.speed * dt / 3600;
            if (v.speed > 2) { c.moving += dt; c.vSum += v.speed * dt; }
            c.vMax = mx(c.vMax, v.speed);
        }
        if (isNum(v.gLong)) {
            if (v.gLong > 0) c.gFwd = mx(c.gFwd, v.gLong);
            else c.gBrake = mx(c.gBrake, -v.gLong);
            if (c.armed && v.gLong <= -HARD_BRAKE && isNum(v.speed) && v.speed > 20) { c.brakes++; c.armed = false; }
            if (v.gLong > -REARM) c.armed = true;
        }
        if (isNum(v.gLat)) c.gSide = mx(c.gSide, Math.abs(v.gLat));
        if (isNum(v.kw) && v.kw > 0) c.kwMax = mx(c.kwMax, v.kw);
        if (isNum(v.oil)) {
            c.oilMin = mn(c.oilMin, v.oil); c.oilMax = mx(c.oilMax, v.oil);
            if (c.oil0 === null) c.oil0 = v.oil;
            if (c.warm === null && c.oil0 < COLD_C && v.oil >= WARM_C) c.warm = Math.round((t - c.start) / 1000);
        }
        if (isNum(v.coolant)) { c.coolMin = mn(c.coolMin, v.coolant); c.coolMax = mx(c.coolMax, v.coolant); }
        if (t >= c.nextTrace) { c.trace.push(isNum(v.speed) ? Math.round(v.speed) : null); c.nextTrace += TRACE_MS; }
        if (!active && t - c.lastActive >= END_MS) this._end();
    }

    flush() { if (this.cur) this._end(); }

    _record(c, end) {
        const odoKm = isNum(c.odo0) && isNum(c.odo1) && c.odo1 >= c.odo0 && c.odo1 - c.odo0 < 3000 ? c.odo1 - c.odo0 : null;
        const km = odoKm !== null && (odoKm > 0 || c.dist < 1) ? odoKm : c.dist;
        return { start: c.start, end, km: r1(km), secs: Math.round((end - c.start) / 1000), moving: Math.round(c.moving),
            vAvg: c.moving > 0 ? r1(c.vSum / c.moving) : null, vMax: r1(c.vMax), gFwd: r2(c.gFwd), gBrake: r2(c.gBrake), gSide: r2(c.gSide),
            brakes: c.brakes, kwMax: isNum(c.kwMax) ? Math.round(c.kwMax) : null, oilMin: c.oilMin, oilMax: c.oilMax, coolMin: c.coolMin,
            coolMax: c.coolMax, warm: c.warm, trace: c.trace.slice(), odo: c.odo1 };
    }

    _end() {
        const c = this.cur;
        this.cur = null;
        const rec = this._record(c, c.lastActive);
        if (rec.secs < MIN_SECS && !(rec.km >= MIN_KM)) return null;
        this.trips = [rec].concat(this.trips).slice(0, TRIPS_KEPT);
        if (!this._write()) rec.error = this.err;
        this.onSaved(rec);
        return rec;
    }
}

module.exports = { Trips, END_MS, TRACE_MS, TRIPS_KEPT, HARD_BRAKE, WARM_C, MARKS_KEPT };
