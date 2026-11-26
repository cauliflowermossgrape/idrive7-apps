'use strict';
/**
 * lamps.js - Ambient config's strobe.js with two more runs on the same documented requests (from Exterior Lights by
 * Paget96, PR #254): your own light sequence, and Stealth (behind its own setting). Nothing here writes coding; every request is one strobe.js
 * already sends, and every run gives the lamps back the way strobe.js does.
 *
 *   Sequence (play):  a timeline of beats, each beat the body controller's light functions to flash (LEUCHTEN_FUNKTION
 *                 2E D542 00 <function> <time in 10 ms>, kind 'fn'); the body controller switches each off by itself
 *                 after its time (at most 150 ms), so a lamp left alone goes dark. At the end every used function is
 *                 sent with time 0 and the session left (10 01), as strobe.js _runFn does.
 *   Stealth:      the headlight units dark while parked: every channel at 0 mA, 0 % in one request per side
 *                 (_LEUCHTEN_AUSSENLICHT_KANAL 31 01 3000, kinds 'flm' FLM01 and 'fle' FLE, the "all lights" strobe's
 *                 dark half), the extended session kept with 3E 00. At the end the channels as they were before are
 *                 written back and the session left (10 01): the headlight is the car's again. FLM02 headlights
 *                 (kind 'flm2', a G20's) take one channel per request for 2 s each, 15 channels a side: they cannot be
 *                 held dark, so Stealth says so there. The body controller's light functions only switch lamps on.
 *
 *   const l = new Lamps({ diag, log, allowed });   await l.find(); await l.findHeads();
 *   l.play(seq, { beatMs, loops })   seq = [[fn, ...], ...] one entry a beat (fn: a key of strobe.js F)
 *   l.stealth({ ms })   l.stop()   l.running -> 'sequence' | 'stealth' | (strobe.js's own) ...   l.headKind -> 'flm' | 'fle' | 'flm2' | null
 *   stealthWhy(l) -> null (possible) | why not;   playWhy(l) -> null | why not
 */
const { Strobe, HEAD, F, SIDES, flashTicks, MAX_MS } = require('./strobe');

const STEALTH_MS = 10 * 60000;      // at most this long a press
const KEEP_MS = 2000;
const STEP_MS = 200;
const PLAY_MS = MAX_MS;             // one press: at most 30 s, as the strobe
const FNS = ['high', 'cornL', 'cornR', 'fog', 'indL', 'indR', 'parkL', 'parkR', 'brake', 'reverse', 'rearFog'];

class Lamps extends Strobe {
    constructor(o) {
        super(o);
        this.headKind = null; this.headSides = [];
    }

    /** The headlight units (reads only): which kind answers, as strobe.js find() asks them. */
    async findHeads() {
        for (const kind of ['flm', 'fle', 'flm2']) {
            const sides = [];
            for (const a of SIDES) {
                const r = await this._probe(a, 0x22, HEAD[kind].read, 3000);
                if (r && r[0] === 0x62 && r.length >= 3 + (HEAD[kind].stride || 2) * HEAD[kind].n) sides.push(a);
            }
            if (sides.length === 2) {
                this.headKind = kind; this.headSides = sides;
                this.log.info('lamps: ' + HEAD[kind].name + ' for Stealth');
                this.emit('change');
                return kind;
            }
        }
        this.headKind = null; this.headSides = [];
        this.emit('change');
        return null;
    }

    /** Play a timeline on the body controller's light functions until stop, PLAY_MS, a refusal or allowed() saying no. */
    play(seq, o) { return this._held(() => this._play(seq, o || {})); }
    async _play(seq, o) {
        if (this.running) return;
        const why = playWhy(this) || this._resting() || this.allowed('sequence');
        if (why) { this._say('Sequence not started: ' + why, 'warn'); return; }
        const beatMs = Math.max(150, Math.min(1000, +o.beatMs || 250)), ticks = flashTicks(Math.min(150, beatMs));
        const loops = Math.max(1, Math.min(10, +o.loops || 1));
        this.running = 'sequence'; this._stop = false; this._say('Sequence starting...');
        const t0 = this.now(), used = {};
        let end = null, beats = 0;
        try {
            const r = await this._ask(0x40, 0x10, [0x03]);
            if (!r || r[0] !== 0x50) { end = ['Sequence: the body controller refused the diagnostic session', 'warn']; return; }
            this._say('Sequence on');
            for (let k = 0; k < loops * seq.length && !this._stop; k++) {
                const stopWhy = this.allowed(this.running);
                if (stopWhy) { end = ['Sequence stopped: ' + stopWhy, 'warn']; break; }
                if (this.now() - t0 > PLAY_MS) { end = ['Sequence done (' + PLAY_MS / 1000 + ' s at most)', 'dim']; break; }
                const at = this.now();
                for (const name of seq[k % seq.length] || []) {
                    if (F[name] === undefined) continue;
                    const res = await this._fn(name, ticks);
                    used[name] = true;
                    if (res !== true) { end = ['Sequence stopped: refused (' + res + ')', 'warn']; break; }
                }
                if (end) break;
                beats++;
                this.beat = k % seq.length;
                this.emit('beat', this.beat);
                const left = beatMs - (this.now() - at);
                if (left > 0) await this.sleep(left);
            }
            if (!end) end = [this._stop ? 'Sequence stopped' : 'Sequence done', 'dim'];
        } finally {
            for (const name of Object.keys(used)) await this._fn(name, 0);
            await this._ask(0x40, 0x10, [0x01]);
            this.running = null; this.beat = null;
            if (beats > 0) this._rest(t0);
            if (!end) end = ['Sequence stopped', 'warn'];
            this.log.info('lamps: ' + end[0] + ' after ' + beats + ' beats');
            this._say(end[0], end[1]);
        }
    }

    /** The headlight units dark until stop, o.ms (at most STEALTH_MS) or allowed() saying no. */
    stealth(o) { return this._held(() => this._stealth(o || {})); }
    async _stealth(o) {
        if (this.running) return;
        const why = stealthWhy(this) || this.allowed('stealth');
        if (why) { this._say('Stealth not started: ' + why, 'warn'); return; }
        const ms = Math.max(10000, Math.min(STEALTH_MS, +o.ms || STEALTH_MS));
        const keep = { kind: this.kind, sides: this.sides };
        this.kind = this.headKind; this.sides = this.headSides;
        this.running = 'stealth'; this._stop = false; this._say('Stealth starting...');
        const t0 = this.now(), before = {};
        let end = null, dark = false;
        try {
            if (!(await this._sessions(0x03))) { end = ['Stealth: the headlights refused the diagnostic session', 'warn']; return; }
            for (const a of this.sides) {
                before[a] = await this._channels(a);
                if (!before[a]) { end = ['Stealth: no channel reading from the headlight ' + a.toString(16).toUpperCase(), 'warn']; return; }
            }
            for (const a of this.sides) {
                const r = await this._setChannels(a, before[a].map(() => ({ cur: 0, pwm: 0 })));
                if (r !== true) { end = ['Stealth stopped: refused (' + r + ')', 'warn']; return; }
            }
            dark = true;
            this._say('Stealth on: headlights dark');
            const t = { keep: this.now() };
            while (!this._stop) {
                const stopWhy = this.allowed(this.running);
                if (stopWhy) { end = ['Stealth stopped: ' + stopWhy, 'warn']; break; }
                if (this.now() - t0 > ms) { end = ['Stealth done (' + Math.round(ms / 60000) + ' min)', 'dim']; break; }
                await this._keep(t);
                await this.sleep(STEP_MS);
            }
            if (!end) end = ['Stealth stopped', 'dim'];
        } finally {
            if (dark) for (const a of this.sides) if (before[a]) await this._setChannels(a, before[a]);
            await this._sessions(0x01);
            this.running = null;
            this.kind = keep.kind; this.sides = keep.sides;
            this.log.info('lamps: ' + (end ? end[0] : 'stealth ended'));
            this._say(end ? end[0] : 'Stealth stopped', end ? end[1] : 'dim');
        }
    }
}

/** Why Stealth cannot run on this car (null: it can). */
function stealthWhy(l) {
    if (!l || !l.headKind) return 'no headlight unit answered (Stealth needs LED headlights with their own unit)';
    if (l.headKind === 'flm2') return 'FLM02 headlights give a channel back after 2 s and take one channel a request, so they cannot be held dark';
    return null;
}
/** Why a sequence cannot play on this car (null: it can). */
function playWhy(l) {
    if (!l || !l.kind) return 'no lamp control found yet';
    if (l.kind !== 'fn') return 'a sequence needs the body controller\'s light functions; this car has ' + l.kindName + ' (the Strobe tab\'s light show works there)';
    return null;
}

module.exports = { Lamps, stealthWhy, playWhy, FNS, STEALTH_MS, PLAY_MS, F };
