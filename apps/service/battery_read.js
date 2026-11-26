'use strict';
/**
 * battery_read.js - the 12 V voltage for Service's Battery page, read with UDS only while that page shows.
 *
 *   const r = new VoltReader({ link, cands, store, log })
 *       link    the page's read-only diagnostic link (kit/readonly-diag.js, main.js readLink(): a promise of it)
 *       cands   eDrive's candidates (app.json config.battery.v12), kit/dids.js style
 *       store   where the readings go: the background's state (volt(v, t), pick(), setPick(i, key)), or a stand-in
 *   r.want(on)  on while the Battery page shows (and Stop all is off, the setting is on, no demo); off stops the reads
 *   r.reading   true while it runs
 *
 * About once a second while wanted. The candidate that answered last is asked first and alone (a miss waits for the
 * next try); until one answered, they are asked in turn. A unit that does not answer is skipped by the link after a few misses
 * until the page is opened again (ReadOnlyDiag silent / wake), so a car where no candidate answers is not swept for
 * as long as the page stays open. Read only: 22 and OBD 01 requests, checked by the link.
 */
const { DidReader } = require('./kit/dids');

const EVERY_MS = 1000, MISS_MS = 3000, TIMEOUT_MS = 1500;

class VoltReader {
    constructor(o) {
        this.link = o.link;                 // () => Promise<ReadOnlyDiag>
        this.cands = (o.cands || []).map((c) => Object.assign({ timeoutMs: TIMEOUT_MS }, c));
        this.store = o.store; this.log = o.log || { info() {}, warn() {} };
        this.on = false; this.reading = false; this.reader = null; this.timer = null; this.woken = false;
    }

    want(on) {
        on = !!on && this.cands.length > 0;
        if (on === this.on) return;
        this.on = on;
        if (on) {
            this.woken = false;
            if (!this.reading) this._next(0);
        } else {
            if (this.timer) { clearTimeout(this.timer); this.timer = null; }     // the page left: no next read
        }
    }

    _next(ms) {
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => { this.timer = null; this._tick(); }, ms);
        if (this.timer.unref) this.timer.unref();
    }

    async _tick() {
        if (!this.on || this.reading) return;
        this.reading = true;
        let wait = EVERY_MS;
        try {
            const d = await this.link();
            if (!this.woken) { this.cands.forEach((c) => d.wake(c.ecu)); this.woken = true; }    // a new visit: ask them all again
            if (!this.reader) this.reader = new DidReader(d, { ecu: 18 });
            const x = this.on ? await this._read() : null;
            if (x !== null && this.on) this.store.volt(x, Date.now());
            else wait = MISS_MS;
        } catch (e) {
            this.log.warn('service: 12 V: ' + (e && e.message || e));
            wait = MISS_MS;
        }
        this.reading = false;
        if (this.on) this._next(wait);
    }

    async _read() {
        const pick = this.store.pick ? this.store.pick() : null;
        const order = this.cands.map((c, i) => i);
        if (Number.isInteger(pick) && this.cands[pick]) { order.splice(order.indexOf(pick), 1); order.unshift(pick); }
        for (const i of order) {
            if (!this.on) return null;
            const x = await this.reader.read(this.cands[i]);
            if (x !== null) {
                if (this.store.setPick) this.store.setPick(i, this.reader.key(this.cands[i]));
                return x;
            }
            if (i === pick) return null;          // the known source missed once: no search over the others yet
        }
        return null;
    }
}

module.exports = { VoltReader, EVERY_MS };
