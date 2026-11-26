'use strict';
/**
 * hunter.js - Signal Hunter's memory: every value the car sends to the head unit on the fields it listens to, split
 * into single members ("Climate2.statusACFront.status"), and what each did:
 *
 *   const h = new Hunter({ now });
 *   h.update(key, value)      key = "<interface>.<field>"; value = the field's struct as the signal hands it
 *   h.mark()                  "Mark before": from now on changed() lists what moved
 *   h.changed()               [{ key, old, val, back, n, t, hist }] each member that moved since the mark, newest
 *                             change first (back: it is as it was again; n: how often since the mark, a running
 *                             count kept by update), noise left out (opt { noisy: true })
 *   h.recent(ms)              the members that changed in the last ms, newest first (the Live page)
 *   h.perSecond(n)            changes in each of the last n seconds (oldest first)
 *   h.busiest(ms, n)          [[interface, changes], ...] in the last ms
 *   h.buffer                  the last BUFFER_MS of changes: [t, key, old, new]
 *   h.stateAt(t)              every member as it was at t (t inside the buffer)
 *
 * Noise: a member that changes 3 or more times while the car is "quiet" (the first QUIET_MS after the first value
 * came) is noise, and so is one whose name says it is a counter, checksum, clock or timestamp. Noise is still kept,
 * only left out of the lists unless asked for.
 */
const BUFFER_MS = 30000, QUIET_MS = 10000, MAX_KEYS = 2500, MAX_BUFFER = 6000, HIST = 40, MAX_ARRAY = 16, MAX_DEPTH = 5;
const NOISY_NAME = /(counter|zaehler|alive|crc|checksum|chksum|timestamp|clock|seconds|milli|uptime|sequence|seqno|rolling)/i;

const isNum = (x) => typeof x === 'number' && isFinite(x);

/** A value split into its members: { 'a.b': 1, 'c[0]': 'X' }; a plain number or text is the member ''. */
function flatten(v, pre, out, depth) {
    out = out || {};
    pre = pre || '';
    depth = depth || 0;
    if (v === null || v === undefined || typeof v !== 'object') { out[pre] = v === undefined ? null : v; return out; }
    if (depth >= MAX_DEPTH) { out[pre] = '{...}'; return out; }
    if (Array.isArray(v)) {
        v.slice(0, MAX_ARRAY).forEach((x, i) => flatten(x, pre + '[' + i + ']', out, depth + 1));
        if (v.length > MAX_ARRAY) out[pre + '.length'] = v.length;
        return out;
    }
    if (Buffer.isBuffer && Buffer.isBuffer(v)) { out[pre] = v.toString('hex').slice(0, 32); return out; }
    for (const k of Object.keys(v)) flatten(v[k], pre ? pre + '.' + k : k, out, depth + 1);
    return out;
}

/** The interface's last word, the field and the member: "Climate2.statusACFront.status" (key "<interface>|<field>..."). */
function shortName(key) {
    const bar = key.indexOf('|');
    if (bar < 0) return key;
    return key.slice(0, bar).split('.').pop() + '.' + key.slice(bar + 1);
}

class Hunter {
    constructor(o) {
        o = o || {};
        this.now = o.now || Date.now;
        this.vals = new Map();          // member key -> { val, old, n, t, hist, base, iface, noisy, quietN }
        this.buffer = [];               // [t, key, old, new]
        this.firstAt = 0;
        this.markAt = 0;
        this.full = false;              // MAX_KEYS reached: new members are not followed
        this.total = 0;
    }

    /** key "<interface>|<field>" (the "|" keeps the dotted interface apart from the members). */
    update(key, value) {
        const t = this.now();
        if (!this.firstAt) this.firstAt = t;
        const flat = flatten(value);
        const iface = key.split('|')[0];
        for (const m of Object.keys(flat)) {
            const k = m ? key + '.' + m : key, v = flat[m];
            let e = this.vals.get(k);
            if (!e) {
                if (this.vals.size >= MAX_KEYS) { this.full = true; continue; }
                e = { val: v, old: undefined, n: 0, sinceN: 0, t: 0, hist: isNum(v) ? [v] : [], base: v, iface, quietN: 0,
                    noisy: NOISY_NAME.test(k.split('|')[1] || k) };
                this.vals.set(k, e);
                continue;
            }
            if (e.val === v) continue;
            this.buffer.push([t, k, e.val, v]);
            e.old = e.val; e.val = v; e.t = t; e.n++; e.sinceN++;
            this.total++;
            if (isNum(v)) { e.hist.push(v); if (e.hist.length > HIST) e.hist.shift(); }
            if (t - this.firstAt <= QUIET_MS && ++e.quietN >= 3) e.noisy = true;
        }
        this.trim(t);
    }

    trim(t) {
        let i = 0;
        while (i < this.buffer.length && (t - this.buffer[i][0] > BUFFER_MS || this.buffer.length - i > MAX_BUFFER)) i++;
        if (i) this.buffer.splice(0, i);
    }

    learning() { return !!this.firstAt && this.now() - this.firstAt < QUIET_MS; }

    /** "Mark before": what each member is now is the "before"; the counts start again. */
    mark() {
        this.markAt = this.now();
        this.vals.forEach((e) => { e.base = e.val; e.sinceN = 0; });
    }

    /** Since the mark (or since the start): the members that moved, newest change first. */
    changed(opt) {
        opt = opt || {};
        const out = [];
        const from = this.markAt || this.firstAt;
        this.vals.forEach((e, k) => {
            if (e.t < from || e.t === 0) return;
            if (e.noisy && !opt.noisy) return;
            // a value that moved and came back (a button pressed and let go) is listed too, marked "back"
            out.push({ key: k, name: shortName(k), old: e.base, val: e.val, back: e.val === e.base, n: this.markAt ? e.sinceN : e.n, t: e.t, hist: e.hist, noisy: e.noisy });
        });
        out.sort((a, b) => b.t - a.t);
        return out;
    }

    recent(ms, opt) {
        const t = this.now(), seen = new Set(), out = [];
        for (let i = this.buffer.length - 1; i >= 0; i--) {
            const c = this.buffer[i];
            if (t - c[0] > ms) break;
            if (seen.has(c[1])) continue;
            seen.add(c[1]);
            const e = this.vals.get(c[1]);
            if (!e || (e.noisy && !(opt && opt.noisy))) continue;
            out.push({ key: c[1], name: shortName(c[1]), old: c[2], val: e.val, t: c[0], n: e.n, hist: e.hist });
        }
        return out;
    }

    perSecond(n) {
        // newest first, stopping at the first change older than n seconds (the buffer is in time order)
        const t = this.now(), out = new Array(n).fill(0);
        for (let i = this.buffer.length - 1; i >= 0; i--) {
            const s = Math.floor((t - this.buffer[i][0]) / 1000);
            if (s >= n) break;
            if (s >= 0) out[n - 1 - s]++;
        }
        return out;
    }

    busiest(ms, n) {
        const t = this.now(), by = {};
        for (let k = this.buffer.length - 1; k >= 0 && t - this.buffer[k][0] <= ms; k--) {
            const e = this.vals.get(this.buffer[k][1]), i = e ? e.iface : this.buffer[k][1].split('|')[0];
            by[i] = (by[i] || 0) + 1;
        }
        return Object.keys(by).map((i) => [i, by[i]]).sort((a, b) => b[1] - a[1]).slice(0, n);
    }

    /** Every member as it was at t: now, with the buffer's later changes undone, newest first. */
    stateAt(t) {
        const s = {};
        this.vals.forEach((e, k) => { s[k] = e.val; });
        for (let i = this.buffer.length - 1; i >= 0 && this.buffer[i][0] > t; i--) s[this.buffer[i][1]] = this.buffer[i][2];
        return s;
    }

    /** A saved window: the members' values at `from` and every change from `from` to `to`, noise left out of both. */
    window(from, to) {
        const quiet = (k) => { const e = this.vals.get(k); return !!e && !e.noisy; };
        const changes = this.buffer.filter((c) => c[0] >= from && c[0] <= to && quiet(c[1]));
        const start = this.stateAt(from), keep = {};
        Object.keys(start).forEach((k) => { if (quiet(k)) keep[k] = start[k]; });
        return { from, to, start: keep, changes };
    }

    size() { return this.vals.size; }
    noisyCount() { let n = 0; this.vals.forEach((e) => { if (e.noisy) n++; }); return n; }
    ifaceCount() { const s = new Set(); this.vals.forEach((e) => s.add(e.iface)); return s.size; }
}

/** Play a saved window: the state at step i (0 = before the first change) and which change is step i. */
function stateAtStep(win, i) {
    const s = Object.assign({}, win.start);
    for (let k = 0; k < i && k < win.changes.length; k++) s[win.changes[k][1]] = win.changes[k][3];
    return s;
}

module.exports = { Hunter, flatten, shortName, stateAtStep, BUFFER_MS, QUIET_MS, MAX_KEYS, NOISY_NAME };
