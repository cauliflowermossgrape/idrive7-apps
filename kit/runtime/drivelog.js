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

const isNum = (v) => typeof v === 'number' && isFinite(v);
const round1 = (v) => Math.round(v * 10) / 10;

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

    reset() { this.list = []; this.cur = null; this._save(); }

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
        this._touch(this.now(), false);
    }

    _start(t) {
        if (this.cur) { delete this.cur.live; }
        this.cur = { at: t, ms: 0, live: true, ch: {} };
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
        this.settings.set(this.key, this.list);
        this.emit('change');
    }
}

module.exports = { DriveLog, OFF_MS, SAVE_MS, ROW_MS, RUN_RPM };
