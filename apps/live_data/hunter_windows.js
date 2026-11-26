'use strict';
/**
 * windows.js - saved windows: a short stretch of everything the car sent (default 20 s before "Save window" and 10 s
 * after), one JSON file each in <dataDir>/windows/, the newest KEEP kept, so a moment can be stepped through later.
 *
 *   const w = new Windows(dir);
 *   w.save(win, label)     win from Hunter.window(); returns the entry { file, at, from, to, n, label }
 *   w.list()               newest first
 *   w.load(entry)          the window itself ({ from, to, start, changes })
 */
const fs = require('fs');
const path = require('path');

const KEEP = 20;
const two = (n) => (n < 10 ? '0' : '') + n;
const stamp = (ms) => { const d = new Date(ms); return d.getFullYear() + two(d.getMonth() + 1) + two(d.getDate()) + '-' + two(d.getHours()) + two(d.getMinutes()) + two(d.getSeconds()); };

class Windows {
    constructor(dir, opts) {
        this.dir = dir; this.mem = !dir; this.items = []; this.data = new Map(); this.keep = (opts && opts.keep) || KEEP;
        if (this.mem) return;
        try { fs.mkdirSync(dir); } catch (e) { /* there */ }
        try { this.items = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8')); } catch (e) { this.items = []; }
    }

    list() { return this.items; }

    save(win, mark) {
        const e = { file: stamp(mark || win.to) + '.json', at: mark || win.to, from: win.from, to: win.to, n: win.changes.length, error: null };
        this.data.set(e.file, win);
        this.items = [e].concat(this.items.filter((x) => x.file !== e.file));
        const gone = this.items.slice(this.keep);
        this.items = this.items.slice(0, this.keep);
        gone.forEach((x) => this.data.delete(x.file));
        if (!this.mem) {
            try {
                fs.writeFileSync(path.join(this.dir, e.file), JSON.stringify(win));
                gone.forEach((x) => { try { fs.unlinkSync(path.join(this.dir, x.file)); } catch (err) { /* gone */ } });
                fs.writeFileSync(path.join(this.dir, 'index.json'), JSON.stringify(this.items));
            } catch (err) { e.error = String(err && err.message || err); }
        }
        return e;
    }

    load(e) {
        if (!e) return null;
        if (this.data.has(e.file)) return this.data.get(e.file);
        if (this.mem) return null;
        try {
            const w = JSON.parse(fs.readFileSync(path.join(this.dir, e.file), 'utf8'));
            this.data.set(e.file, w);
            if (this.data.size > 4) this.data.delete(this.data.keys().next().value);
            return w;
        } catch (err) { return null; }
    }
}

module.exports = { Windows, KEEP };
