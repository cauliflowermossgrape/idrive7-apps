'use strict';
/**
 * strobe.js - the high beams flashed by the body controller (BDC 0x40), and the light show (every lamp output
 * flashing), only for use on private property. Both are BMW's own workshop lamp tests, as the BDC descriptions have them:
 *
 *   kind 'bdc' (BDC, BDC_G11): STATUS_LEUCHTENAUSGANG_DIGITAL  22 4500 -> 62 4500 <one byte per output>
 *                              STEUERN_LEUCHTENAUSGANG_DIGITAL 2F 4501 <control> <element> [<state>]
 *   kind 'g05' (BDC_G05):      LICHT_AUSGANG_DIGITAL           22 E3B9 -> 62 E3B9 <a spare byte, then one per output>
 *                              LICHT_AUSGANG_DIGITAL_STEUERN   2F E3B5 <control> <element> [<state>]
 *   light show (BDC_G11, BDC_G05): _LICHT_DISCO_PWM 2E 4530 <pwm 1 %> <pwm 2 %> <cycle> <mode> <ms hi> <ms lo> 00 00
 *     every discrete lamp output switches between the two PWM values every cycle (TAB_ZYKLUS_ZEIT: 0 = 10 ms,
 *     1 = 20, 2 = 30, 3 = 50, 4 = 100 ms) for ms milliseconds, then stops by itself.
 *
 * control: 03 shortTermAdjustment (state 01 on, 00 off), 00 returnControlToECU (UDS 2F, as STEUERN_IO sends it).
 * Outputs (TAB_AUSGANG_LEUCHTEN, the same in all three): 07 FL_L, 08 FL_R - the high beams; the status bytes follow
 * that order (AL_L AL_R TFL_L TFL_R SML_L SML_R FL_L FL_R ...), 1 on, 0 off, FF not fitted.
 * The kind is told by which status the BDC answers (reads only). The requests run in the extended session (10 03),
 * kept with 3E 80 while flashing; at the end every output is set off, handed back and the default session (10 01)
 * asked for, which drops any override left - and the BDC drops the session by itself a few seconds after the last
 * 3E, so an app that dies mid-flash leaves the lamps to the car.
 * The first flash is checked against the status: an output that does not follow (or a refusal) stops it all.
 *
 *   const s = new Strobe({ diag, log, allowed });  await s.find();   s.kind -> 'bdc' | 'g05' | null
 *   s.start({ pattern: 'both' | 'alternate', rate: 'fast' | 'normal' | 'slow' })   s.show()   s.stop()
 *   s.running -> 'strobe' | 'show' | null       s.note       s.on('change', fn)
 */
const EventEmitter = require('events');

const BDC = 0x40;
const KINDS = {
    bdc: { name: 'BDC', status: [0x45, 0x00], control: [0x45, 0x01], first: 0 },
    g05: { name: 'BDC_G05', status: [0xE3, 0xB9], control: [0xE3, 0xB5], first: 1 },
};
const FL_L = 0x07, FL_R = 0x08;
const STA = 0x03, RCTECU = 0x00;
const DISCO = [0x45, 0x30];
// half a flash (on, or off), by rate; the writes themselves take what they take, so this is the least
const HALF_MS = { fast: 60, normal: 120, slow: 300 };
const MAX_MS = 30000;            // one press: at most this long
const SHOW_MS = 15000;           // the light show's own length (the BDC stops it by itself)
const KEEP_MS = 2000;            // 3E 80 this often while flashing
const statusIndex = (kind, el) => KINDS[kind].first + el - 1;   // the output's byte after 62 <did>

const hex = (b) => (b || []).map((x) => (x < 16 ? '0' : '') + x.toString(16).toUpperCase()).join(' ');
const reply = (sid, did) => (u) => (u[0] === sid + 0x40 && (!did || (u[1] === did[0] && u[2] === did[1]))) || (u[0] === 0x7F && u[1] === sid);

class Strobe extends EventEmitter {
    constructor(o) {
        super();
        this.diag = o.diag; this.log = o.log;
        this.allowed = o.allowed || (() => 'not set up');        // null: may run; else why not
        this.now = o.now || Date.now;
        this.sleep = o.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
        this.kind = null;
        this.running = null; this.note = null; this.noteType = 'dim'; this._stop = false;
    }

    _say(note, type) { this.note = note; this.noteType = type || 'dim'; this.emit('change'); }

    async _ask(sid, data, timeoutMs) {
        try {
            return await this.diag.physical(BDC, sid, data, timeoutMs || 1500, reply(sid, sid === 0x10 ? null : data.slice(0, 2)), { retryBaseMs: 20, maxRetries: 6 });
        } catch (e) { return null; }
    }

    /** The BDC's kind, from the status it answers (reads only). */
    async find() {
        for (const kind of ['bdc', 'g05']) {
            const r = await this._ask(0x22, KINDS[kind].status, 4000);
            if (r && r[0] === 0x62) {
                this.kind = kind;
                this.log.info('strobe: body controller ' + KINDS[kind].name + ' (status ' + hex(r.slice(0, 3)) + ', high beam '
                    + this._lamp(r, FL_L) + ' / ' + this._lamp(r, FL_R) + ')');
                this.emit('change');
                return kind;
            }
        }
        this.kind = null;
        this.log.info('strobe: no lamp output status from the body controller');
        this.emit('change');
        return null;
    }

    _lamp(r, el) { const v = r && r[3 + statusIndex(this.kind, el)]; return v === undefined ? null : v; }

    async _status() { const r = await this._ask(0x22, KINDS[this.kind].status, 1500); return r && r[0] === 0x62 ? r : null; }

    async _set(el, on) {
        const r = await this._ask(0x2F, KINDS[this.kind].control.concat([STA, el, on ? 1 : 0]));
        return r && r[0] === 0x6F ? true : r ? 'NRC ' + hex([r[2]]) : 'no answer';
    }

    async _session(n) { const r = await this._ask(0x10, [n]); return !!(r && r[0] === 0x50); }

    /** Every output back to the car, whatever happened before. */
    async _giveBack(els) {
        for (const el of els) {
            await this._set(el, false);
            await this._ask(0x2F, KINDS[this.kind].control.concat([RCTECU, el]));
        }
        await this._session(0x01);
    }

    /** The high beams flashing until stop(), MAX_MS, a refusal or allowed() saying no. */
    async start(o) {
        if (this.running) return;
        const why = !this.kind ? 'this body controller has no lamp output control' : this.allowed();
        if (why) { this._say('Strobe not started: ' + why, 'warn'); return; }
        const pattern = o && o.pattern === 'alternate' ? 'alternate' : 'both', half = HALF_MS[o && o.rate] || HALF_MS.normal;
        const els = [FL_L, FL_R];
        this.running = 'strobe'; this._stop = false; this._say('Strobe starting...');
        const t0 = this.now();
        let keepT = 0, step = 0, end = null;
        try {
            if (!(await this._session(0x03))) { end = ['the body controller refused the diagnostic session', 'warn']; return; }
            keepT = this.now();
            while (!this._stop) {
                const stopWhy = this.allowed();
                if (stopWhy) { end = ['Strobe stopped: ' + stopWhy, 'warn']; break; }
                if (this.now() - t0 > MAX_MS) { end = ['Strobe done (' + MAX_MS / 1000 + ' s)', 'dim']; break; }
                const on = step % 2 === 0, at = this.now();
                // both: both on, both off; alternate: left on right off, then the other way round
                for (const el of els) {
                    const want = pattern === 'both' ? on : (el === FL_L) === on;
                    const r = await this._set(el, want);
                    if (r !== true) { end = ['Strobe stopped: the body controller refused (' + r + ')', 'warn']; break; }
                }
                if (end) break;
                if (step === 0) {
                    // the first flash: the status must say the high beams followed
                    const st = await this._status();
                    const seen = els.map((el) => this._lamp(st, el));
                    const wantSeen = els.map((el) => (pattern === 'both' || el === FL_L ? 1 : 0));
                    if (!st || seen.some((v, i) => v !== wantSeen[i])) {
                        end = ['Strobe stopped: the high beams did not follow (status ' + seen.join(' / ') + ')', 'warn']; break;
                    }
                    this._say('Strobe on · ' + (pattern === 'both' ? 'both together' : 'left and right in turn'));
                }
                if (this.now() - keepT > KEEP_MS) { this.diag.send(BDC, 0x3E, [0x80]).catch(() => {}); keepT = this.now(); }
                step++;
                const left = half - (this.now() - at);
                if (left > 0) await this.sleep(left);
            }
            if (!end) end = ['Strobe stopped', 'dim'];
        } finally {
            await this._giveBack(els);
            this.running = null;
            this.log.info('strobe: ' + (end ? end[0] : 'ended') + ' after ' + step + ' steps');
            this._say(end ? end[0] : 'Strobe stopped', end ? end[1] : 'dim');
        }
    }

    /** The light show: every lamp output flashing for SHOW_MS, run by the BDC itself (BDC_G11, BDC_G05). */
    async show(o) {
        if (this.running) return;
        const why = !this.kind ? 'this body controller has no lamp output control' : this.allowed();
        if (why) { this._say('Light show not started: ' + why, 'warn'); return; }
        const cycle = o && o.rate === 'fast' ? 0x03 : 0x04;            // 50 or 100 ms between the two PWM values
        const ms = Math.min(SHOW_MS, o && o.ms || SHOW_MS);
        this.running = 'show'; this._stop = false; this._say('Light show starting...');
        let end = null;
        try {
            if (!(await this._session(0x03))) { end = ['the body controller refused the diagnostic session', 'warn']; return; }
            const r = await this._ask(0x2E, DISCO.concat([100, 0, cycle, 0, (ms >> 8) & 0xFF, ms & 0xFF, 0, 0]));
            if (!r || r[0] !== 0x6E) { end = ['Light show: the body controller refused (' + (r ? 'NRC ' + hex([r[2]]) : 'no answer') + ')', 'warn']; return; }
            this._say('Light show on');
            const t0 = this.now();
            let keepT = this.now();
            while (!this._stop && this.now() - t0 < ms) {
                const stopWhy = this.allowed();
                if (stopWhy) { end = ['Light show stopped: ' + stopWhy, 'warn']; break; }
                if (this.now() - keepT > KEEP_MS) { this.diag.send(BDC, 0x3E, [0x80]).catch(() => {}); keepT = this.now(); }
                await this.sleep(200);
            }
            if (!end) end = [this._stop ? 'Light show stopped' : 'Light show done', 'dim'];
        } finally {
            // the show stopped early: a zero-length show ends it, and the default session drops it anyway
            if (end && !/done/.test(end[0])) await this._ask(0x2E, DISCO.concat([0, 0, cycle, 0, 0, 0, 0, 0]));
            await this._session(0x01);
            this.running = null;
            this.log.info('strobe: ' + (end ? end[0] : 'light show ended'));
            this._say(end ? end[0] : 'Light show stopped', end ? end[1] : 'dim');
        }
    }

    stop() { this._stop = true; }
}

module.exports = { Strobe, KINDS, FL_L, FL_R, HALF_MS, MAX_MS, SHOW_MS, statusIndex };
