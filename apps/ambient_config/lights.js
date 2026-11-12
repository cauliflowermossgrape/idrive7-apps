'use strict';
/**
 * lights.js - the ambient light modules driven with any colour, through the head unit's diagnostic link to the body
 * controller (lin.js has the bytes, scenes.js what each light shows).
 *
 * find() reads both LIN buses once (the BDC answers after a few seconds). show(scene) puts a scene on, frame by
 * frame (_next). Through the head unit's gateway one write takes ~200 ms and only one is taken at a time, so the
 * number of writes is what counts: NAD 0 reaches every light of a bus at once (car-tested, G20 BDC_G05), so a bus
 * gets one write for the colour most of its lights want, then single writes only for the lights that differ - a
 * whole-car colour is 2 writes instead of 19. The 6E answer does not prove a light took it: after a still colour the
 * buses are read back once and a light that missed it is written again. A still colour holds 60 s and is written
 * again every 40 s, a moving one holds 5 s. carColour() gives every light back to the car (NAD 0 off, read back).
 * flash(rgb, ms) lays a colour over everything for a moment; overlay(key, test, at) lays one over the lights test(light)
 * picks until overlay(key, null) - at(ms, on) with on flipping each frame, so a blink is as fast as the writes go (the turn signal's glow, an open door; the rest keep the scene, or the car's own
 * colour); dim(f) scales the brightness (night). Writes that fail
 * in a row (the car switched off, the BDC asleep) pause the writing for 10 s.
 *
 *   const l = new Lights({ diag, log }); await l.find();
 *   l.lights -> [{ bus, nad, name, part, x, y, ... }]   l.state -> 'finding' | 'none' | 'car' | 'ours'
 *   l.at(light) -> what the light shows now ({ rgb, bright })     l.rate -> writes a second
 */
const EventEmitter = require('events');
const { BDC, BUSES, parseStatus, writeFrame, releaseFrame } = require('./lin');
const S = require('./scenes');

const HOLD_S = 60, RENEW_MS = 40000, MOVE_HOLD_S = 5, MOVE_RENEW_MS = 3000;
const PAUSE_MS = 10000, FAILS = 4, RELEASE_TRIES = 3;
const ALL = 0;                 // NAD 0: every light of the bus
const CHECK_MS = 1500;         // a still colour's read-back, this long after its last write

const echo = (sid, did) => (u) => (u[0] === sid + 0x40 && u[1] === did[0] && u[2] === did[1]) || (u[0] === 0x7f && u[1] === sid);
const same = (a, b) => !!a && !!b && Math.abs(a.bright - b.bright) < 2 && a.rgb.every((x, i) => Math.abs(x - b.rgb[i]) < 3);

class Lights extends EventEmitter {
    constructor(o) {
        super();
        this.diag = o.diag; this.log = o.log; this.now = o.now || Date.now; this.checkMs = o.checkMs;
        this.lights = [];
        this.state = 'finding';
        this.error = null;
        this.scene = null; this.t0 = 0;
        this._flash = null;
        this._dim = 1;
        this._last = new Map();        // light -> { rgb, bright, at }
        this._release = [];            // [{ bus } (every light of it) | { light }] to give back to the car
        this._sent = new Map();        // light -> the rgb last written to it (the read-back after giving back)
        this._checkAt = 0; this._checks = 0; this._checkOff = false;
        this._running = false; this._timer = null; this._stopped = false;
        this._fails = 0; this._pauseTill = 0; this._frame = null; this._frames = [];
        this.writes = 0; this._times = [];
    }

    get rate() { const t = this.now(); this._times = this._times.filter((x) => t - x < 3000); return this._times.length / 3; }
    /** Whole frames a second (every light on the same moment of a moving scene). */
    get fps() { const t = this.now(); this._frames = this._frames.filter((x) => t - x < 5000); return this._frames.length / 5; }

    /** Reads which lights the car has. */
    async find() {
        this.state = 'finding'; this.emit('change');
        const found = [];
        for (let bus = 0; bus < BUSES.length; bus++) {
            const did = BUSES[bus].read;
            let reply = null;
            try { reply = await this.diag.physical(BDC, 0x22, did, 15000, echo(0x22, did), { pendingTimeoutMs: 15000 }); } catch (e) { this.error = String(e && e.message || e); }
            const got = reply ? parseStatus(bus, reply) : null;
            if (got) found.push.apply(found, got);
            else if (reply) this.log.info('lights: bus ' + (bus + 1) + ' refused (' + reply.map((x) => x.toString(16)).join(' ') + ')');
        }
        this.lights = found;
        this.state = found.length ? (this.scene ? 'ours' : 'car') : 'none';
        if (found.length) { this.error = null; this.log.info('lights: ' + found.length + ' found (' + found.map((l) => l.name).join(', ') + ')'); } else this.log.warn('lights: none found' + (this.error ? ': ' + this.error : ''));
        this.emit('change');
        this._kick();
        return found;
    }

    /** What a light shows now. */
    at(light, scene, t) {
        const now = this.now();
        if (this._flash && now < this._flash.until) return { rgb: this._flash.rgb, bright: 100 };
        // the overlay set last wins
        const ov = this._overs ? Array.from(this._overs.values()).reverse().find((o) => o.test(light)) : null;
        if (ov) { const v = ov.at(now - ov.t0, !!this._phase); return { rgb: v.rgb, bright: Math.round(v.bright * this._dim) }; }
        const sc = scene || this.scene;
        if (!sc) return null;
        const v = S.lightAt(sc, light, t == null ? now - this.t0 : t);
        return { rgb: v.rgb, bright: Math.round(v.bright * this._dim) };
    }

    show(scene) {
        const once = S.lasts(scene);
        this.scene = scene; this.t0 = this.now(); this._frame = null;
        clearTimeout(this._onceTimer);
        // a once-only scene (welcome, pulse) runs, then its "then" (null: the car's colour), else its still colour
        if (once) {
            this._onceTimer = setTimeout(() => {
                if (this.scene !== scene) return;
                if (scene.then === null) this.carColour();
                else this.show(scene.then || Object.assign({}, scene, { kind: 'solid' }));
            }, once);
        }
        this._release = [];
        this._checks = S.moves(scene) ? 0 : 2; this._checkAt = 0; this._checkOff = false;
        if (this.lights.length) this.state = 'ours';
        this.emit('change');
        this._kick();
    }

    carColour() {
        clearTimeout(this._onceTimer);
        this.scene = null;
        this._frame = null;
        this._giveBack();
        if (this.lights.length) this.state = 'car';
        this.emit('change');
        this._kick();
    }

    flash(rgb, ms) {
        this._flash = { rgb, until: this.now() + (ms || 600) };
        this._frame = null;
        this._kick();
        setTimeout(() => {
            // with no colour of ours on, the lights go back to the car's
            if (!this.scene) this._giveBack();
            this._kick();
        }, (ms || 600) + 20);
    }

    /** A colour over the lights test(light) picks: at(ms since it began) -> { rgb, bright }; test null: taken off. */
    overlay(key, test, at) {
        if (!this._overs) this._overs = new Map();
        if (!test) {
            if (!this._overs.delete(key)) return;
            // with no colour of ours on, those lights go back to the car's
            if (!this.scene && !this._overs.size) this._giveBack();
        } else {
            this._overs.delete(key);
            this._overs.set(key, { test, at, t0: this.now() });
        }
        this._frame = null;
        this._kick();
    }

    dim(f) { if (f !== this._dim) { this._dim = f; this._frame = null; this._kick(); } }

    stop() { this._stopped = true; clearTimeout(this._timer); clearTimeout(this._onceTimer); }

    /** Every bus with a light of ours on it given back (one write each), then read back once. */
    _giveBack() {
        const buses = [];
        this.lights.forEach((l) => { if (this._last.has(l) && buses.indexOf(l.bus) < 0) buses.push(l.bus); });
        this._release = buses.map((bus) => ({ bus }));
        this._checks = buses.length ? 1 : 0; this._checkAt = 0; this._checkOff = true;
    }

    /**
     * The next write: something to give back, else the next of the frame. Every scene goes frame by frame: every light
     * the colour of the same moment (the frame's), front to back; then the next frame from the time it is then. Lights
     * that show that colour already (and are not due for their renewal) are skipped.
     */
    _next() {
        if (this._release.length) {
            const r = this._release.shift();
            return r.light ? { r, lights: [r.light], frame: releaseFrame(r.light.bus, r.light.nad), off: true }
                : { r, lights: this.lights.filter((l) => l.bus === r.bus), frame: releaseFrame(r.bus, ALL), off: true };
        }
        const now = this.now(), flashing = !!(this._flash && now < this._flash.until + 50), over = !!(this._overs && this._overs.size);
        if (!this.scene && !flashing && !over) return null;
        const moving = S.moves(this.scene) || flashing || over, renew = moving ? MOVE_RENEW_MS : RENEW_MS, hold = moving ? MOVE_HOLD_S : HOLD_S;
        for (let tries = 0; tries < 2; tries++) {
            if (!this._frame || !this._frame.todo.length) {
                if (this._frame && this._frame.wrote) this._frames.push(now);
                this._phase = !this._phase;             // (overlays that blink: on one frame, off the next)
                this._frame = { t: now - this.t0, todo: this._plan(now - this.t0), wrote: false };
            }
            while (this._frame.todo.length) {
                const it = this._frame.todo.shift();
                const due = it.need.some((l) => { const had = this._last.get(l); return !same(it.want, had) || now - had.at > renew; });
                if (!due) continue;
                this._frame.wrote = true;
                return { lights: it.lights, want: it.want, frame: writeFrame(it.lights[0].bus, it.nad, it.want.rgb, it.want.bright, hold) };
            }
        }
        return null;
    }

    /**
     * One frame's writes: for each bus the colour most of its lights want, as one write to all of them (NAD 0), then
     * a write for each light that wants another. [{ lights (written), need (the lights it is for), want, nad }]
     */
    _plan(t) {
        const items = [];
        for (let bus = 0; bus < BUSES.length; bus++) {
            // (no scene: only the lights an overlay or a flash colours; the others keep the car's own colour)
            const all = this.lights.filter((l) => l.bus === bus).sort((a, b) => a.y - b.y);
            const at = all.map((l) => this.at(l, null, t)), on = all.filter((l, i) => at[i]), wants = at.filter((w) => w);
            if (!on.length) continue;
            const key = (w) => w.rgb.join() + '/' + w.bright, count = {};
            wants.forEach((w) => { count[key(w)] = (count[key(w)] || 0) + 1; });
            const top = Object.keys(count).sort((a, b) => count[b] - count[a])[0];
            // (NAD 0 reaches every light of the bus: only when all of them take a colour of ours)
            const most = on.length === all.length && count[top] > 1 ? wants.find((w) => key(w) === top) : null;
            if (most) items.push({ lights: on, need: on.filter((l, i) => key(wants[i]) === top), want: most, nad: ALL });
            on.forEach((l, i) => { if (!most || key(wants[i]) !== top) items.push({ lights: [l], need: [l], want: wants[i], nad: l.nad }); });
        }
        return items;
    }

    /**
     * Reads the buses back: a light that does not show what was written to it is written again (after giving back:
     * one still showing ours is given back on its own).
     */
    async _check() {
        for (let bus = 0; bus < BUSES.length; bus++) {
            const on = this.lights.filter((l) => l.bus === bus);
            if (!on.length) continue;
            let st = null;
            try { st = await this.diag.physical(BDC, 0x22, BUSES[bus].read, 15000, echo(0x22, BUSES[bus].read), { pendingTimeoutMs: 15000 }); } catch (e) { /* the next one */ }
            const mods = st ? parseStatus(bus, st) : null;
            if (!mods) continue;
            mods.forEach((m) => {
                const l = on.find((x) => x.nad === m.nad);
                if (!l) return;
                const close = (rgb) => !!rgb && rgb.every((v, i) => Math.abs(Math.min(254, v) - m.rgb[i]) < 3);
                if (this._checkOff) {
                    if (close(this._sent.get(l))) { this.log.info('lights: ' + l.name + ' still ours, giving it back'); this._release.push({ light: l }); }
                } else if (this._last.has(l) && !close(this._last.get(l).rgb)) {
                    this.log.info('lights: ' + l.name + ' missed its colour, writing it again');
                    this._last.delete(l);
                }
            });
        }
        this._frame = null;
    }

    _kick() {
        if (this._running || this._stopped || !this.lights.length) return;
        clearTimeout(this._timer); this._timer = null;
        this._run().catch((e) => this.log.warn('lights: ' + e));
    }

    async _run() {
        this._running = true;
        try {
            for (;;) {
                if (this._stopped) return;
                const wait = this._pauseTill - this.now();
                if (wait > 0) { this._timer = setTimeout(() => this._kick(), wait); return; }
                if (this._checkAt && this.now() >= this._checkAt && !this._release.length) { this._checkAt = 0; await this._check(); continue; }
                const w = this._next();
                if (!w) {
                    // all written: a still colour (or giving back) read back once a little later
                    if (this._checks > 0 && !this._checkAt) { this._checks--; this._checkAt = this.now() + (this.checkMs || CHECK_MS); }
                    // nothing due: a moving scene looks again soon, a still one when its next renewal is due
                    const moving = S.moves(this.scene) || !!(this._flash && this.now() < this._flash.until);
                    const next = this._checkAt ? Math.max(20, this._checkAt - this.now()) : moving ? 40 : 1000;
                    if (this.scene || moving || this._checkAt) this._timer = setTimeout(() => this._kick(), next);
                    return;
                }
                let reply = null;
                // one write at a time (the gateway takes no second); a busy gateway is asked again soon, not after 1 s
                try { reply = await this.diag.physical(BDC, 0x2e, w.frame, 1500, echo(0x2e, w.frame), { retryBaseMs: 20, maxRetries: 10 }); } catch (e) { this.error = String(e && e.message || e); }
                if (reply && reply[0] === 0x6e) {
                    this._fails = 0; this.writes++; this._times.push(this.now());
                    w.lights.forEach((l) => {
                        if (w.off) { this._last.delete(l); return; }
                        this._last.set(l, { rgb: w.want.rgb, bright: w.want.bright, at: this.now() });
                        this._sent.set(l, w.want.rgb);
                    });
                    if (this.error) { this.error = null; this.emit('change'); }
                } else {
                    // a give-back not taken: tried RELEASE_TRIES times, then left (the light's colour runs out by itself
                    // within its hold), so a body module that has gone to sleep is not asked again and again
                    if (w.off && (w.r.tries || 0) + 1 < RELEASE_TRIES) this._release.push(Object.assign({}, w.r, { tries: (w.r.tries || 0) + 1 }));
                    this.error = reply ? 'the body module refused (' + (reply[2] || 0).toString(16) + ')' : this.error || 'no answer from the body module';
                    if (++this._fails >= FAILS) {
                        this.log.warn('lights: ' + this.error + ', pausing');
                        this._fails = 0; this._pauseTill = this.now() + PAUSE_MS;
                        this._last.clear();
                        this.emit('change');
                    }
                }
            }
        } finally { this._running = false; }
    }
}

module.exports = { Lights, HOLD_S, RENEW_MS, MOVE_HOLD_S };
