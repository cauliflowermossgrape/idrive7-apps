'use strict';
/**
 * panic.js - "Stop all": one press in any app's settings and every app of the kit stops what it does to the car and
 * gives it back, within 200 ms, until someone resumes.
 *
 * Each app writes only its own file, /tmp/mgu-panic-<app id>.json ({ on, at, by }), so no app ever has to write a
 * file another app (another user on the head unit) owns; the newest file of any app is the state. /tmp is one
 * tmpfs for every process, so all apps see it, and a restart of the head unit clears it. MGU_PANIC_DIR overrides
 * the folder (tests, the emulator).
 *
 *   const p = new Panic(appId);
 *   p.set(true)              // Stop all (false: resume)
 *   p.on                     // stopped now?
 *   p.watch(fn)              // fn(on, by) on every change, polled every 200 ms (and at once if stopped already)
 */
const fs = require('fs');
const path = require('path');

const POLL_MS = 200, PREFIX = 'mgu-panic-';
const dir = () => process.env.MGU_PANIC_DIR || '/tmp';

/** The newest flag of any app: { on, at, by } (off when there is none). */
function read() {
    let best = { on: false, at: 0, by: null };
    let names = [];
    try { names = fs.readdirSync(dir()); } catch (e) { return best; }
    names.forEach((n) => {
        if (n.indexOf(PREFIX) !== 0 || !/\.json$/.test(n)) return;
        try {
            const s = JSON.parse(fs.readFileSync(path.join(dir(), n), 'utf8'));
            if (s && typeof s.at === 'number' && s.at > best.at) best = { on: !!s.on, at: s.at, by: s.by || null };
        } catch (e) { /* half written or not ours */ }
    });
    return best;
}

class Panic {
    constructor(appId, now) {
        this.id = String(appId || 'app').replace(/[^\w.-]/g, '_');
        this.now = now || Date.now;
        this.state = read();
        this.fns = [];
        this.timer = null;
    }
    get on() { return this.state.on; }
    get by() { return this.state.by; }
    set(on) {
        // (at: at least one past the newest, so this press wins even within the same millisecond)
        const at = Math.max(this.now(), read().at + 1);
        const file = path.join(dir(), PREFIX + this.id + '.json');
        try {
            fs.writeFileSync(file + '.tmp', JSON.stringify({ on: !!on, at, by: this.id }));
            try { fs.chmodSync(file + '.tmp', 0o644); } catch (e) { /* not on this file system */ }
            fs.renameSync(file + '.tmp', file);
        } catch (e) { return false; }
        this.poll();
        return true;
    }
    /** Look at the flags now; handlers run on a change. */
    poll() {
        const s = read();
        const was = this.state.on;
        this.state = s;
        if (s.on !== was) this.fns.forEach((fn) => { try { fn(s.on, s.by); } catch (e) { /* the app's handler */ } });
        return s.on;
    }
    watch(fn) {
        this.fns.push(fn);
        if (this.state.on) { try { fn(true, this.state.by); } catch (e) { /* the app's handler */ } }
        if (!this.timer) {
            this.timer = setInterval(() => this.poll(), POLL_MS);
            if (this.timer.unref) this.timer.unref();
        }
    }
    close() { if (this.timer) clearInterval(this.timer); this.timer = null; }
}

module.exports = { Panic, read, POLL_MS };
