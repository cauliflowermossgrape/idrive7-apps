'use strict';
/**
 * drivelog.js - values over a drive, kept after it: the lowest and highest of each channel per drive (the
 * latest drives first), and on request a CSV of the drive, one row every few seconds. For any app that wants
 * "what did it reach today" (issue #235: Warm-Up's oil, coolant and gearbox oil).
 *
 * A drive is the engine's run as Warm-Up's cold starts count it (coldstarts.js): it starts when the engine runs
 * (rpm over RUN_RPM) after a stop of OFF_MS or more, so auto start-stop and a hybrid driving electric for a moment
 * stay one drive; it ends with the next such start, or when the app starts again. Values only count while the
 * engine runs. The summaries are kept in the settings (key), saved at most every SAVE_MS while a drive runs and
 * at once when one ends, so a head unit switched off mid-drive loses at most that much; the CSV rows go to
 * <dataDir>/<key>.csv (a second file, <key>.1.csv, once it passes MAX_CSV), only while settings csv is on.
 *
 *   const d = new DriveLog({ settings, key: 'drives', channels: ['oil', 'coolant'], dataDir, csv: () => bool, now });
 *   d.rpm(r); d.value('oil', degC);
 *   d.drives() -> [{ at, ms, live, ch: { oil: { min, max }, ... } }]   (newest first, the one running marked live)
 *   d.reset()
 *
 * With stats (option stats: true; Warm-Up's Drives tab), each drive also sums itself up from d.sample(v), called about
 * once a second with v = { speed (km/h), odo (km), gLong, gLat (g), kw }, all optional, counted while the engine runs:
 *   drive.s = { km, moving (s), vAvg (km/h while moving), vMax, gFwd, gBrake, gSide, brakes, kwMax, warm }
 *       km: the odometer's difference when the car sends it and the drive is SHORT_KM or longer (it counts whole km),
 *       else the speed added up; brakes: stops harder than
 *       HARD_BRAKE from over 20 km/h, each counted once; warm: seconds until the oil reached warmAt() on a drive that
 *       started with it under COLD_C (else null)
 *   d.trace(at) -> the drive's speed every TRACE_MS (km/h, null where none), kept in <dataDir>/<key>-trace.json
 *   d.mark(label, odo) / d.marks() -> a change noted now (a service, new tyres ...), oldest first, kept in the settings
 *   (<key>Marks, the newest MARKS_KEPT) for a before / after comparison
 */
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');

const RUN_RPM = 400, STOP_RPM = 300;
const OFF_MS = 30000;              // stopped this long: the next run is a new drive
const SAVE_MS = 60000;             // a running drive's summary saved at most this often (settings are on the eMMC)
const ROW_MS = 10000;              // a CSV row every 10 s
const MAX_CSV = 1024 * 1024;
const KEEP = 10;
const TRACE_MS = 10000;          // a speed point every 10 s for the drive's chart
const HARD_BRAKE = 0.5, REARM = 0.3, COLD_C = 60, MARKS_KEPT = 20;
const SHORT_KM = 10;               // under this the odometer's whole km are too coarse: the speed added up is used

const isNum = (v) => typeof v === 'number' && isFinite(v);
const round1 = (v) => Math.round(v * 10) / 10;
const mx2 = (a, b) => Math.round(Math.max(isNum(a) ? a : 0, b) * 100) / 100;

class DriveLog extends EventEmitter {
    constructor(o) {
        super();
        this.settings = o.settings;
        this.key = o.key || 'drives';
        this.channels = o.channels || [];
        this.dataDir = o.dataDir || null;
        this.csv = o.csv || (() => false);
        this.now = o.now || Date.now;
        this.keep = o.keep || KEEP;
        this.stats = !!o.stats;
        this.warmAt = o.warmAt || (() => 80);
        this.traces = {};           // drive start -> speeds (with stats)
        this.lastSample = 0;
        this.armed = true;
        if (this.stats) this._readTraces();
        this.running = false;
        this.stoppedAt = -Infinity;
        this.cur = null;            // the drive now (also list[0] while it runs)
        this.last = {};             // channel -> latest value
        this.savedAt = 0;
        this.rowAt = 0;
        const s = this.settings.get(this.key);
        this.list = Array.isArray(s) ? s.filter((d) => d && isNum(d.at)) : [];
        // a drive still marked running was cut off by a switch-off or a restart: it ended there
        let closed = false;
        this.list.forEach((d) => { if (d.live) { delete d.live; closed = true; } });
        if (closed) this._save();
    }

    drives() { return this.list; }

    reset() { this.list = []; this.cur = null; this.traces = {}; this._save(); }

    trace(at) { return this.traces[at] || []; }

    marks() { const m = this.settings.get(this.key + 'Marks'); return Array.isArray(m) ? m : []; }

    mark(label, odo) {
        const m = { at: this.now(), label: String(label || 'Other'), odo: isNum(odo) ? odo : null };
        this.settings.set(this.key + 'Marks', this.marks().concat([m]).slice(-MARKS_KEPT));
        this.emit('change');
        return m;
    }

    /** About once a second, with stats on: { speed, odo, gLong, gLat, kw } (any may be missing). */
    sample(v) {
        const t = this.now(), dt = this.lastSample ? Math.min(5, Math.max(0, (t - this.lastSample) / 1000)) : 0;
        this.lastSample = t;
        const d = this.cur;
        if (!this.stats || !d || !this.running || !v) return;
        const s = d.s || (d.s = { km: 0, moving: 0, vAvg: null, vMax: null, gFwd: null, gBrake: null, gSide: null, brakes: 0, kwMax: null, warm: null });
        const x = d.x || (d.x = { dist: 0, vSum: 0, odo0: null, odo1: null, next: d.at });
        if (isNum(v.odo) && v.odo >= 0) { if (x.odo0 === null) x.odo0 = v.odo; x.odo1 = v.odo; }
        if (isNum(v.speed)) {
            x.dist += v.speed * dt / 3600;
            if (v.speed > 2) { s.moving = Math.round(s.moving + dt); x.vSum += v.speed * dt; }
            s.vMax = isNum(s.vMax) ? Math.max(s.vMax, round1(v.speed)) : round1(v.speed);
        }
        if (isNum(v.gLong)) {
            if (v.gLong > 0) s.gFwd = mx2(s.gFwd, v.gLong); else s.gBrake = mx2(s.gBrake, -v.gLong);
            if (this.armed && v.gLong <= -HARD_BRAKE && isNum(v.speed) && v.speed > 20) { s.brakes++; this.armed = false; }
            if (v.gLong > -REARM) this.armed = true;
        }
        if (isNum(v.gLat)) s.gSide = mx2(s.gSide, Math.abs(v.gLat));
        if (isNum(v.kw) && v.kw > 0) s.kwMax = isNum(s.kwMax) ? Math.max(s.kwMax, Math.round(v.kw)) : Math.round(v.kw);
        // the odometer counts whole km (a 1.4 km drive reads 1 km): on a short drive the speed added up is closer
        const odoKm = isNum(x.odo0) && isNum(x.odo1) && x.odo1 >= x.odo0 && x.odo1 - x.odo0 < 3000 ? x.odo1 - x.odo0 : null;
        s.km = round1(odoKm !== null && (odoKm >= SHORT_KM || x.dist <= 0) ? odoKm : x.dist);
        s.vAvg = s.moving > 0 ? round1(x.vSum / s.moving) : null;
        if (t >= x.next) {
            const tr = this.traces[d.at] || (this.traces[d.at] = []);
            tr.push(isNum(v.speed) ? Math.round(v.speed) : null);
            x.next += TRACE_MS;
        }
        this._touch(t, false);
    }

    rpm(r) {
        if (!isNum(r)) return;
        const t = this.now();
        if (!this.running && r > RUN_RPM) {
            this.running = true;
            if (!this.cur || t - this.stoppedAt >= OFF_MS) this._start(t);
        } else if (this.running && r < STOP_RPM) {
            this.running = false;
            this.stoppedAt = t;
            this._touch(t, true);
        }
        if (this.running) this._touch(t, false);
    }

    value(name, v) {
        if (!isNum(v) || this.channels.indexOf(name) < 0) return;
        this.last[name] = v;
        const d = this.cur;
        if (!d || !this.running) return;
        const c = d.ch[name] || (d.ch[name] = { min: round1(v), max: round1(v) });
        if (v < c.min) c.min = round1(v);
        if (v > c.max) c.max = round1(v);
        if (this.stats && name === 'oil') {
            const s = d.s || (d.s = { km: 0, moving: 0, vAvg: null, vMax: null, gFwd: null, gBrake: null, gSide: null, brakes: 0, kwMax: null, warm: null });
            if (d.oil0 === undefined) d.oil0 = c.min;
            if (s.warm === null && d.oil0 < COLD_C && v >= this.warmAt()) s.warm = Math.round((this.now() - d.at) / 1000);
        }
        this._touch(this.now(), false);
    }

    _start(t) {
        if (this.cur) { delete this.cur.live; }
        this.cur = { at: t, ms: 0, live: true, ch: {} };
        this.armed = true;
        // a value from just before the start: the temperatures do not change in that moment
        this.channels.forEach((n) => { if (isNum(this.last[n])) this.cur.ch[n] = { min: round1(this.last[n]), max: round1(this.last[n]) }; });
        this.list = [this.cur].concat(this.list).slice(0, this.keep);
        this.rowAt = 0;
        this._save();
        this._row(t, true);
    }

    _touch(t, force) {
        const d = this.cur;
        if (!d) return;
        d.ms = Math.max(d.ms, t - d.at);
        if (force || t - this.savedAt >= SAVE_MS) this._save();
        if (this.running && t - this.rowAt >= ROW_MS) this._row(t, false);
    }

    /** One CSV row: the time and each channel's latest value (empty when none yet). */
    _row(t, first) {
        if (!this.dataDir || !this.csv()) return;
        this.rowAt = t;
        const file = path.join(this.dataDir, this.key + '.csv');
        try {
            let size = -1;
            try { size = fs.statSync(file).size; } catch (e) { /* no file yet */ }
            if (size > MAX_CSV) { fs.renameSync(file, path.join(this.dataDir, this.key + '.1.csv')); size = -1; }
            const head = size < 0 ? 'time,drive,' + this.channels.join(',') + '\n' : '';
            const vals = this.channels.map((n) => (isNum(this.last[n]) ? round1(this.last[n]) : ''));
            fs.appendFileSync(file, head + new Date(t).toISOString() + ',' + new Date(this.cur.at).toISOString() + ',' + vals.join(',') + '\n');
        } catch (e) { /* a read-only data folder: no CSV, the summaries still work */ }
        if (first) this.emit('drive', this.cur);
    }

    _save() {
        this.savedAt = this.now();
        // the working values (x) stay in memory: only the summary is kept
        this.settings.set(this.key, this.list.map((d) => { const c = Object.assign({}, d); delete c.x; return c; }));
        if (this.stats) this._writeTraces();
        this.emit('change');
    }

    _traceFile() { return this.dataDir ? path.join(this.dataDir, this.key + '-trace.json') : null; }

    _readTraces() {
        const f = this._traceFile();
        if (!f) return;
        try { const j = JSON.parse(fs.readFileSync(f, 'utf8')); if (j && typeof j === 'object') this.traces = j; } catch (e) { this.traces = {}; }
    }

    _writeTraces() {
        const f = this._traceFile();
        if (!f) return;
        const keep = {};
        this.list.forEach((d) => { if (this.traces[d.at]) keep[d.at] = this.traces[d.at]; });
        this.traces = keep;
        try { fs.writeFileSync(f, JSON.stringify(keep)); } catch (e) { /* a read-only data folder: the summaries still work */ }
    }
}

module.exports = { DriveLog, OFF_MS, SAVE_MS, ROW_MS, RUN_RPM, TRACE_MS, HARD_BRAKE, COLD_C, MARKS_KEPT };
