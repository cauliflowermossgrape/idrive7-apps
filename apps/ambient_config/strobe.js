'use strict';
/**
 * strobe.js - the high beams flashed, and the light show, for use on private property only. Two ways to the lamps,
 * the first the car answers wins (reads only to tell):
 *
 * The headlight units (left 0x43, right 0x44): on LED headlights the high beam is theirs, the body controller's lamp
 * output does nothing. _LEUCHTEN_AUSSENLICHT_KANAL 31 01 3000 <current/10 mA, PWM %> for every LED channel sets the
 * whole headlight at once; the live channels are read first (the low beam stays as it is) and the high beam's
 * channels are added for "on". Leaving the extended session (10 01) gives the headlight back to the car.
 *   kind 'flm' (FLM01): channels read with 22 D667, 12 channels; high beam on channels 1 and 9 (seen on a car with
 *                       the stalk: 1 at 1000 mA 75 %, 9 at 1000 mA 41 %)
 *   kind 'fle' (FLE):   channels read with 22 D631, 7 channels; which are the high beam is learned (learn())
 *   Learn: the channels that light up while the high beam is switched on with the stalk.
 *
 * The body controller (BDC 0x40), on cars whose high beams hang on its lamp outputs:
 *   kind 'bdc' (BDC, BDC_G11): STATUS_LEUCHTENAUSGANG_DIGITAL  22 4500 -> 62 4500 <a spare byte, then one per output>
 *                              STEUERN_LEUCHTENAUSGANG_DIGITAL 2F 4501 <control> <element> <state>
 *   kind 'g05' (BDC_G05):      LICHT_AUSGANG_DIGITAL           22 E3B9 -> 62 E3B9 <a spare byte, then one per output>
 *                              LICHT_AUSGANG_DIGITAL_STEUERN   2F E3B5 <control> <element> <state>
 *   control 03 shortTermAdjustment (state 01 on, 00 off), 00 returnControlToECU (state 00: without it, NRC 13).
 *   Outputs 07 FL_L, 08 FL_R, the status in that order (AL_L AL_R TFL_L TFL_R SML_L SML_R FL_L FL_R ...).
 *   The first flash is checked against the status: outputs that do not follow (or a refusal) stop it all.
 *
 * Light show: BDC_G11 / BDC_G05 run their own (_LICHT_DISCO_PWM 2E 4530 <pwm 1 %> <pwm 2 %> <cycle> <mode> <ms hi>
 * <ms lo> 00 00, every discrete lamp output); on the headlight units every lit channel at full against all dark,
 * the two sides in turn.
 *
 * The head unit's transport takes one request at a time (~200 ms each), so a flash is as fast as two writes. The
 * session is kept with 3E 00 (with its reply: 3E 80 holds the transport for seconds waiting for one), and the units
 * drop it by themselves a few seconds after the last request, so an app that dies mid-flash leaves the lamps to the car.
 *
 *   const s = new Strobe({ diag, log, allowed, channels });  await s.find();   s.kind -> 'flm' | 'fle' | 'bdc' | 'g05' | null
 *   s.start({ pattern: 'both' | 'alternate', rate: 'fast' | 'normal' | 'slow' })   s.show()   s.learn()   s.stop()
 *   s.running -> 'strobe' | 'show' | 'learn' | null       s.note       s.on('change', fn)   s.on('learned', fn(channels))
 */
const EventEmitter = require('events');

const BDC = 0x40;
const SIDES = [0x43, 0x44];                         // left, right headlight unit
const HEAD = {
    flm: { name: 'FLM01 headlights', read: [0xD6, 0x67], n: 12, high: [{ ch: 1, cur: 0x64, pwm: 0x4B }, { ch: 9, cur: 0x64, pwm: 0x29 }] },
    fle: { name: 'FLE headlights', read: [0xD6, 0x31], n: 7, high: null },
};
const KINDS = {
    bdc: { name: 'BDC', status: [0x45, 0x00], control: [0x45, 0x01], first: 1 },
    g05: { name: 'BDC_G05', status: [0xE3, 0xB9], control: [0xE3, 0xB5], first: 1 },
};
const CHANNELS = [0x30, 0x00];
const FL_L = 0x07, FL_R = 0x08;
const STA = 0x03, RCTECU = 0x00;
const DISCO = [0x45, 0x30];
// at least this long for half a flash (on, or off), by rate; the writes take what they take (~200 ms each)
const HALF_MS = { fast: 0, normal: 200, slow: 500 };
const MAX_MS = 30000;            // one press: at most this long
const SHOW_MS = 15000;           // the light show's length
const KEEP_MS = 2000;            // 3E 00 this often when nothing else is sent
const LEARN_MS = 15000;          // how long learn() waits for the high beam
const statusIndex = (kind, el) => KINDS[kind].first + el - 1;   // the output's byte after 62 <did>

const hex = (b) => (b || []).map((x) => (x < 16 ? '0' : '') + x.toString(16).toUpperCase()).join(' ');

class Strobe extends EventEmitter {
    constructor(o) {
        super();
        this.diag = o.diag; this.log = o.log;
        this.allowed = o.allowed || (() => 'not set up');        // null: may run; else why not
        this.now = o.now || Date.now;
        this.sleep = o.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
        this.learned = Array.isArray(o.channels) && o.channels.length ? o.channels : null;   // [{ ch, cur, pwm }]
        this.kind = null; this.sides = [];
        this.running = null; this.note = null; this.noteType = 'dim'; this._stop = false;
    }

    _say(note, type) { this.note = note; this.noteType = type || 'dim'; this.emit('change'); }

    async _ask(target, sid, data, timeoutMs) {
        try {
            const did = sid === 0x10 || sid === 0x3E ? null : sid === 0x31 ? data.slice(0, 3) : data.slice(0, 2);
            const ok = (u) => (u[0] === sid + 0x40 && (!did || did.every((b, i) => u[i + 1] === b))) || (u[0] === 0x7F && u[1] === sid);
            this.failed = null;
            return await this.diag.physical(target, sid, data, timeoutMs || 1500, ok, { retryBaseMs: 20, maxRetries: 6 });
        } catch (e) { this.failed = String(e && e.message || e); return null; }
    }

    /** A read for find(): the transport refusing (busy at the head unit's start) is asked again, no answer is not. */
    async _probe(target, sid, data, timeoutMs) {
        for (let i = 0; i < 12; i++) {
            const r = await this._ask(target, sid, data, timeoutMs);
            if (r || !this.failed) return r;
            await this.sleep(500);
        }
        this.log.info('strobe: ' + hex([target]) + ' not asked (' + this.failed + ')');
        return null;
    }

    get head() { return HEAD[this.kind] || null; }
    /** The high beam's channels on the headlight units: learned, or the kind's own. */
    get high() { return this.head ? this.learned || this.head.high : null; }
    get kindName() { return this.head ? this.head.name : this.kind ? KINDS[this.kind].name : null; }

    /** Which way to the lamps (reads only): the headlight units first, then the body controller. */
    async find() {
        // at the head unit's start the transport is not there yet: every read would fail and the body controller,
        // asked last, would win on a car whose headlights do the high beam
        if (this.diag.available === false && typeof this.diag.on === 'function') {
            await new Promise((resolve) => {
                const done = () => { clearTimeout(tm); this.diag.removeListener('available', onA); resolve(); };
                const onA = (a) => { if (a) done(); };
                const tm = setTimeout(done, 20000);
                this.diag.on('available', onA);
            });
        }
        for (const kind of ['flm', 'fle']) {
            const sides = [];
            for (const a of SIDES) {
                const r = await this._probe(a, 0x22, HEAD[kind].read, 3000);
                if (r && r[0] === 0x62 && r.length >= 3 + 2 * HEAD[kind].n) sides.push(a);
            }
            if (sides.length) {
                this.kind = kind; this.sides = sides;
                this.log.info('strobe: ' + HEAD[kind].name + ' at ' + sides.map((a) => hex([a])).join(', ')
                    + (this.high ? ', high beam on channels ' + this.high.map((c) => c.ch).join(', ') : ', high beam channels to learn'));
                this.emit('change');
                return kind;
            }
        }
        for (const kind of ['bdc', 'g05']) {
            const r = await this._probe(BDC, 0x22, KINDS[kind].status, 4000);
            if (r && r[0] === 0x62) {
                this.kind = kind; this.sides = [BDC];
                this.log.info('strobe: body controller ' + KINDS[kind].name + ' (high beam ' + this._lamp(r, FL_L) + ' / ' + this._lamp(r, FL_R) + ')');
                this.emit('change');
                return kind;
            }
        }
        this.kind = null; this.sides = [];
        this.log.info('strobe: no headlight or lamp output control found');
        this.emit('change');
        return null;
    }

    // --- headlight units ---

    /** A side's channels now: [{ cur, pwm }] x n, or null. */
    async _channels(a) {
        const r = await this._ask(a, 0x22, this.head.read, 1500);
        if (!r || r[0] !== 0x62 || r.length < 3 + 2 * this.head.n) return null;
        const out = [];
        for (let i = 0; i < this.head.n; i++) out.push({ cur: r[3 + 2 * i], pwm: r[4 + 2 * i] });
        return out;
    }

    async _setChannels(a, chans) {
        const data = CHANNELS.slice();
        chans.forEach((c) => data.push(c.cur & 0xFF, c.pwm & 0xFF));
        const r = await this._ask(a, 0x31, [0x01].concat(data));
        return r && r[0] === 0x71 ? true : r ? 'NRC ' + hex([r[2]]) : 'no answer';
    }

    /** off: the channels as they are, the high beam's dark; on: the high beam's added. */
    _states(now) {
        const off = now.map((c) => ({ cur: c.cur, pwm: c.pwm })), on = now.map((c) => ({ cur: c.cur, pwm: c.pwm }));
        for (const h of this.high) {
            if (h.ch < 1 || h.ch > now.length) continue;
            off[h.ch - 1] = { cur: 0, pwm: 0 };
            on[h.ch - 1] = { cur: h.cur, pwm: h.pwm };
        }
        return { on, off };
    }

    async _sessions(n) {
        let ok = true;
        for (const a of this.sides) {
            const r = await this._ask(a, 0x10, [n]);
            ok = ok && !!(r && r[0] === 0x50);
        }
        return ok;
    }

    async _keep(t) {
        if (this.now() - t.keep < KEEP_MS) return;
        for (const a of this.sides) await this._ask(a, 0x3E, [0x00]);
        t.keep = this.now();
    }

    // --- body controller ---

    _lamp(r, el) { const v = r && r[3 + statusIndex(this.kind, el)]; return v === undefined ? null : v; }

    async _status() { const r = await this._ask(BDC, 0x22, KINDS[this.kind].status, 1500); return r && r[0] === 0x62 ? r : null; }

    async _set(el, on) {
        const r = await this._ask(BDC, 0x2F, KINDS[this.kind].control.concat([STA, el, on ? 1 : 0]));
        return r && r[0] === 0x6F ? true : r ? 'NRC ' + hex([r[2]]) : 'no answer';
    }

    /** Every output back to the car, whatever happened before. */
    async _giveBack(els) {
        for (const el of els) {
            await this._set(el, false);
            await this._ask(BDC, 0x2F, KINDS[this.kind].control.concat([RCTECU, el, 0x00]));
        }
        await this._ask(BDC, 0x10, [0x01]);
    }

    _why() {
        if (!this.kind) return 'no headlight or lamp output control found';
        if (this.head && !this.high) return 'the high beam\'s channels are not known yet (Learn)';
        return this.allowed();
    }

    /** The high beams flashing until stop(), MAX_MS, a refusal or allowed() saying no. */
    async start(o) {
        if (this.running) return;
        const why = this._why();
        if (why) { this._say('Strobe not started: ' + why, 'warn'); return; }
        const pattern = o && o.pattern === 'alternate' ? 'alternate' : 'both';
        const half = o && HALF_MS[o.rate] !== undefined ? HALF_MS[o.rate] : HALF_MS.normal;
        const head = !!this.head;
        this.running = 'strobe'; this._stop = false; this._say('Strobe starting...');
        const t0 = this.now(), t = { keep: this.now() };
        let step = 0, end = null, states = null;
        try {
            if (head) {
                if (!(await this._sessions(0x03))) { end = ['Strobe: the headlights refused the diagnostic session', 'warn']; return; }
                states = {};
                for (const a of this.sides) {
                    const now = await this._channels(a);
                    if (!now) { states = null; end = ['Strobe: no channel reading from the headlight ' + hex([a]), 'warn']; return; }
                    states[a] = this._states(now);
                }
            } else {
                const r = await this._ask(BDC, 0x10, [0x03]);
                if (!r || r[0] !== 0x50) { end = ['Strobe: the body controller refused the diagnostic session', 'warn']; return; }
            }
            t.keep = this.now();
            const targets = head ? this.sides : [FL_L, FL_R];
            while (!this._stop) {
                const stopWhy = this.allowed();
                if (stopWhy) { end = ['Strobe stopped: ' + stopWhy, 'warn']; break; }
                if (this.now() - t0 > MAX_MS) { end = ['Strobe done (' + MAX_MS / 1000 + ' s)', 'dim']; break; }
                const on = step % 2 === 0, at = this.now();
                // both: both on, both off; alternate: left on right off, then the other way round
                for (let i = 0; i < targets.length; i++) {
                    const want = pattern === 'both' ? on : (i === 0) === on;
                    const r = head ? await this._setChannels(targets[i], states[targets[i]][want ? 'on' : 'off']) : await this._set(targets[i], want);
                    if (r !== true) { end = ['Strobe stopped: refused (' + r + ')', 'warn']; break; }
                }
                if (end) break;
                if (step === 0) {
                    // the first flash: the reading must say the high beams followed
                    let ok, seen = '';
                    if (head) {
                        const now = await this._channels(this.sides[0]);
                        ok = !!now && this.high.some((h) => now[h.ch - 1] && now[h.ch - 1].cur > 0);
                    } else {
                        const st = await this._status();
                        const v = targets.map((el) => this._lamp(st, el));
                        ok = !!st && v.every((x, i) => x === (pattern === 'both' || i === 0 ? 1 : 0));
                        seen = ' (status ' + v.join(' / ') + ')';
                    }
                    if (!ok) { end = ['Strobe stopped: the high beams did not follow' + seen, 'warn']; break; }
                    this._say('Strobe on · ' + (pattern === 'both' ? 'both together' : 'left and right in turn'));
                }
                step++;
                if (half - (this.now() - at) > 0) {
                    await this._keep(t);
                    const left = half - (this.now() - at);
                    if (left > 0) await this.sleep(left);
                }
            }
            if (!end) end = ['Strobe stopped', 'dim'];
        } finally {
            if (head) {
                if (states) for (const a of this.sides) await this._setChannels(a, states[a].off);
                await this._sessions(0x01);
            } else {
                await this._giveBack([FL_L, FL_R]);
            }
            this.running = null;
            this.log.info('strobe: ' + (end ? end[0] : 'ended') + ' after ' + step + ' steps');
            this._say(end ? end[0] : 'Strobe stopped', end ? end[1] : 'dim');
        }
    }

    /** The light show for SHOW_MS: the body controller's own (BDC_G11, BDC_G05), or the headlights in turn. */
    async show(o) {
        if (this.running) return;
        const why = !this.kind ? 'no headlight or lamp output control found' : this.allowed();
        if (why) { this._say('Light show not started: ' + why, 'warn'); return; }
        const ms = Math.min(SHOW_MS, o && o.ms || SHOW_MS);
        const head = !!this.head;
        const cycle = o && o.rate === 'fast' ? 0x03 : 0x04;            // BDC: 50 or 100 ms between the two PWM values
        this.running = 'show'; this._stop = false; this._say('Light show starting...');
        let end = null, base = null;
        try {
            if (head) {
                if (!(await this._sessions(0x03))) { end = ['Light show: the headlights refused the diagnostic session', 'warn']; return; }
                base = {};
                for (const a of this.sides) {
                    const now = await this._channels(a);
                    if (!now) { base = null; end = ['Light show: no channel reading from the headlight ' + hex([a]), 'warn']; return; }
                    const lit = now.map((c, i) => {
                        const h = (this.high || []).find((x) => x.ch === i + 1);
                        return c.cur > 0 ? { cur: c.cur, pwm: 100 } : h ? { cur: h.cur, pwm: 100 } : { cur: 0, pwm: 0 };
                    });
                    base[a] = { now, lit, dark: now.map(() => ({ cur: 0, pwm: 0 })) };
                }
                this._say('Light show on');
                const t0 = this.now(), half = o && o.rate === 'fast' ? 0 : 200;
                let step = 0;
                while (!this._stop && this.now() - t0 < ms) {
                    const stopWhy = this.allowed();
                    if (stopWhy) { end = ['Light show stopped: ' + stopWhy, 'warn']; break; }
                    const at = this.now();
                    for (let i = 0; i < this.sides.length; i++) {
                        const a = this.sides[i];
                        const r = await this._setChannels(a, base[a][(step + i) % 2 === 0 ? 'lit' : 'dark']);
                        if (r !== true) { end = ['Light show stopped: refused (' + r + ')', 'warn']; break; }
                    }
                    if (end) break;
                    step++;
                    const left = half - (this.now() - at);
                    if (left > 0) await this.sleep(left);
                }
            } else {
                const s = await this._ask(BDC, 0x10, [0x03]);
                if (!s || s[0] !== 0x50) { end = ['Light show: the body controller refused the diagnostic session', 'warn']; return; }
                const r = await this._ask(BDC, 0x2E, DISCO.concat([100, 0, cycle, 0, (ms >> 8) & 0xFF, ms & 0xFF, 0, 0]));
                if (!r || r[0] !== 0x6E) { end = ['Light show: the body controller refused (' + (r ? 'NRC ' + hex([r[2]]) : 'no answer') + ')', 'warn']; return; }
                this._say('Light show on');
                const t0 = this.now(), t = { keep: this.now() };
                while (!this._stop && this.now() - t0 < ms) {
                    const stopWhy = this.allowed();
                    if (stopWhy) { end = ['Light show stopped: ' + stopWhy, 'warn']; break; }
                    await this._keep(t);
                    await this.sleep(200);
                }
            }
            if (!end) end = [this._stop ? 'Light show stopped' : 'Light show done', 'dim'];
        } finally {
            if (head) {
                if (base) for (const a of this.sides) await this._setChannels(a, base[a].now);
                await this._sessions(0x01);
            } else {
                // stopped early: a zero-length show ends it, and the default session drops it anyway
                if (end && !/done/.test(end[0])) await this._ask(BDC, 0x2E, DISCO.concat([0, 0, cycle, 0, 0, 0, 0, 0]));
                await this._ask(BDC, 0x10, [0x01]);
            }
            this.running = null;
            this.log.info('strobe: ' + (end ? end[0] : 'light show ended'));
            this._say(end ? end[0] : 'Light show stopped', end ? end[1] : 'dim');
        }
    }

    /** The high beam's channels: what lights up on the first headlight while the high beam is switched on (reads only). */
    async learn() {
        if (this.running || !this.head) return null;
        this.running = 'learn'; this._stop = false;
        this._say('Learning: switch the high beam on with the stalk now (' + LEARN_MS / 1000 + ' s)', 'warn');
        const a = this.sides[0], t0 = this.now();
        let found = null, before = null;
        try {
            before = await this._channels(a);
            while (before && !this._stop && this.now() - t0 < LEARN_MS) {
                await this.sleep(300);
                const now = await this._channels(a);
                if (!now) continue;
                const lit = [];
                now.forEach((c, i) => { if (c.cur > 0 && c.pwm > 0 && before[i].cur === 0) lit.push(i); });
                if (lit.length) {
                    // a moment more for the channels to settle, then the brighter reading
                    await this.sleep(600);
                    const again = await this._channels(a) || now;
                    found = lit.map((i) => ({ ch: i + 1, cur: Math.max(now[i].cur, again[i].cur), pwm: Math.max(now[i].pwm, again[i].pwm) }));
                    break;
                }
            }
        } finally {
            this.running = null;
        }
        if (found) {
            this.learned = found;
            this.log.info('strobe: high beam learned on channels ' + found.map((c) => c.ch + ' (' + c.cur * 10 + ' mA ' + c.pwm + ' %)').join(', '));
            this.emit('learned', found);
            this._say('High beam learned: channel ' + found.map((c) => c.ch).join(', ') + '. Switch it off again.');
        } else {
            this._say(!before ? 'Learn: no channel reading from the headlight' : this._stop ? 'Learn stopped' : 'Learn: no high beam seen (was it on already?)', 'warn');
        }
        return found;
    }

    stop() { this._stop = true; }
}

module.exports = { Strobe, KINDS, HEAD, SIDES, FL_L, FL_R, HALF_MS, MAX_MS, SHOW_MS, statusIndex };
