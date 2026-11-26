'use strict';
/**
 * recorder.js - Blackbox's memory: the last PRE_MS of driving kept in RAM, ten samples a second, and saved to a CSV file
 * when something happens (a hard stop, full power, the button), with POST_MS more after it; or a whole Sport stretch,
 * from PRE_MS before Sport was chosen until a little after it was left.
 *
 *   const r = new Recorder({ dir, keep, now, onSaved });
 *   r.sample(values)          values = { rpm, speed, gLong, gLat, torque, oil, coolant, mode }: once every 100 ms
 *   r.event(kind)             'brake', 'power', 'mark': saves PRE_MS before and POST_MS after (one at a time)
 *   r.sport(on)               a Sport stretch starts / ends (saved as one file, at most SPORT_MAX_MS)
 *   r.list()                  the saved recordings, newest first: [{ file, kind, at, ms, rows, rowsAll, thinned, vmax, gMax }]
 *                             (a Sport stretch is thinned when saved: see thin())
 *
 * Files: <dir>/<YYYYMMDD-HHMMSS>-<kind>.csv, header "time,rpm,speed,gLong,gLat,torque,oil,coolant,mode"; the index in
 * <dir>/index.json; the oldest beyond `keep` are removed (files this app wrote, in its own folder).
 */
const fs = require('fs');
const path = require('path');

const RATE_MS = 100, PRE_MS = 60000, POST_MS = 15000, SPORT_TAIL_MS = 10000, SPORT_MAX_MS = 30 * 60000;
const COLS = ['rpm', 'speed', 'gLong', 'gLat', 'torque', 'oil', 'coolant', 'mode'];
const isNum = (v) => typeof v === 'number' && isFinite(v);
const two = (n) => (n < 10 ? '0' : '') + n;
const stamp = (ms) => { const d = new Date(ms); return d.getFullYear() + two(d.getMonth() + 1) + two(d.getDate()) + '-' + two(d.getHours()) + two(d.getMinutes()) + two(d.getSeconds()); };
const cell = (v) => (isNum(v) ? String(Math.round(v * 100) / 100) : v === undefined || v === null ? '' : String(v));

/**
 * Thins a long recording: every row within KEEP_MS of an interesting moment stays, elsewhere one row a second.
 * Interesting: |g forward| or |g sideways| above G_BUSY, speed changing faster than 2 km/h per s, rpm faster than
 * 800 per s, the driving mode changing, or a mark (an event pressed during the stretch). rows: [t, ...COLS].
 */
const KEEP_MS = 5000, G_BUSY = 0.3, DV_BUSY = 2, DRPM_BUSY = 800;
function thin(rows, marks) {
    if (rows.length < 3) return rows;
    const busy = [];
    rows.forEach((r, i) => {
        const p = rows[Math.max(0, i - 10)], dt = (r[0] - p[0]) / 1000;
        const rate = (k) => (dt > 0 && isNum(r[k]) && isNum(p[k]) ? Math.abs(r[k] - p[k]) / dt : 0);
        if ((isNum(r[3]) && Math.abs(r[3]) > G_BUSY) || (isNum(r[4]) && Math.abs(r[4]) > G_BUSY)
            || rate(2) > DV_BUSY || rate(1) > DRPM_BUSY || (i > 0 && r[8] !== rows[i - 1][8])) busy.push(r[0]);
    });
    const near = busy.concat(marks).sort((a, b) => a - b);
    let j = 0, lastKept = -Infinity;
    return rows.filter((r, i) => {
        while (j < near.length && near[j] < r[0] - KEEP_MS) j++;
        const keep = i === 0 || i === rows.length - 1 || (j < near.length && near[j] <= r[0] + KEEP_MS) || r[0] - lastKept >= 1000;
        if (keep) lastKept = r[0];
        return keep;
    });
}

class Recorder {
    constructor(o) {
        this.dir = o.dir; this.keep = o.keep || 30; this.now = o.now || Date.now; this.onSaved = o.onSaved || (() => {});
        this.ring = [];                 // [t, ...COLS]
        this.open = null;               // a recording being taken: { kind, at, until, rows: [] }
        this.index = [];
        try { fs.mkdirSync(this.dir); } catch (e) { /* there */ }
        try { this.index = JSON.parse(fs.readFileSync(path.join(this.dir, 'index.json'), 'utf8')); } catch (e) { this.index = []; }
    }

    list() { return this.index; }
    busy() { return this.open ? this.open.kind : null; }

    sample(v) {
        const t = this.now(), row = [t].concat(COLS.map((k) => v[k]));
        this.ring.push(row);
        while (this.ring.length && t - this.ring[0][0] > PRE_MS) this.ring.shift();
        const o = this.open;
        if (!o) return;
        o.rows.push(row);
        if ((o.until && t >= o.until) || t - o.rows[0][0] > SPORT_MAX_MS + PRE_MS) this._save();
    }

    event(kind) {
        const t = this.now();
        if (this.open) {
            // a second event in an open recording: it just goes on for POST_MS more (not for a Sport stretch: it has its own end);
            // in a Sport stretch it is remembered, so thinning keeps the seconds around it whole
            if (this.open.until) this.open.until = Math.max(this.open.until, t + POST_MS);
            (this.open.marks = this.open.marks || []).push(t);
            return false;
        }
        this.open = { kind, at: t, until: t + POST_MS, rows: this.ring.slice() };
        return true;
    }

    sport(on) {
        const t = this.now();
        if (on) {
            if (this.open && this.open.kind === 'sport') { this.open.until = 0; return; }
            if (this.open) this._save();
            this.open = { kind: 'sport', at: t, until: 0, rows: this.ring.slice() };
        } else if (this.open && this.open.kind === 'sport' && !this.open.until) {
            this.open.until = t + SPORT_TAIL_MS;
        }
    }

    _save() {
        const o = this.open;
        this.open = null;
        if (!o || !o.rows.length) return;
        const file = stamp(o.at) + '-' + o.kind + '.csv';
        const rowsAll = o.rows.length;
        // a Sport stretch can run 30 min (18 000 rows): calm driving is kept once a second, the moments around anything
        // happening at full rate. Event recordings (75 s) stay whole.
        if (o.kind === 'sport') o.rows = thin(o.rows, o.marks || []);
        const thinned = o.rows.length < rowsAll;
        const lines = ['time,' + COLS.join(',')].concat(o.rows.map((r) => [new Date(r[0]).toISOString()].concat(r.slice(1).map(cell)).join(',')));
        let vmax = null, gMax = null;
        o.rows.forEach((r) => {
            if (isNum(r[2])) vmax = Math.max(vmax || 0, r[2]);
            if (isNum(r[3]) || isNum(r[4])) gMax = Math.max(gMax || 0, Math.sqrt(Math.pow(r[3] || 0, 2) + Math.pow(r[4] || 0, 2)));
        });
        const entry = { file, kind: o.kind, at: o.at, ms: o.rows[o.rows.length - 1][0] - o.rows[0][0], rows: o.rows.length, rowsAll, thinned, vmax, gMax };
        try {
            fs.writeFileSync(path.join(this.dir, file), lines.join('\n') + '\n');
            this.index = [entry].concat(this.index);
            this.index.slice(this.keep).forEach((e) => { try { fs.unlinkSync(path.join(this.dir, e.file)); } catch (err) { /* gone */ } });
            this.index = this.index.slice(0, this.keep);
            fs.writeFileSync(path.join(this.dir, 'index.json'), JSON.stringify(this.index));
        } catch (e) { entry.error = String(e && e.message || e); }
        this.onSaved(entry);
    }

    /** Save what is open now (the app is shutting down). */
    flush() { if (this.open) this._save(); }
}

module.exports = { Recorder, thin, RATE_MS, PRE_MS, POST_MS, SPORT_TAIL_MS, COLS };
