'use strict';
/**
 * Part of Redline's experimental features; README.md in this folder has the whole picture.
 *
 * The engine unit's own gear, for a car that sends none (a manual: the head unit gets only "R" while reverse is in,
 * issue #209). The cluster shows the gear the engine unit works out; this asks for the same value:
 *   UDS 22 5881  STAT_BERECHNETER_GANG_WERT (Ist-Gang, "actual gear"), u8: 1..8 a gear, anything else none
 * on the gearbox reader's read-only link, every POLL_MS while start()ed (Redline's page or HUD in use, the engine
 * running, the car sending no gear of its own). value() is the gear while the last answer is fresh (STALE_MS),
 * else null, and kit/car then keeps its guess from the rpm and speed. Not answering 3 times: asked once a minute.
 */
const { DidReader } = require('./kit/dids');
const POLL_MS = 400, STALE_MS = 1500, FAIL_RETRY_MS = 60000;
const CAND = [{ ecu: 0x12, did: '5881', bytes: 1, at: 0, factor: 1, offset: 0, min: 0, max: 255 }];

class DmeGear {
    constructor(ctx, linkOf) {
        this.log = ctx.log; this.linkOf = linkOf;
        this.rd = null; this.timer = null; this.busy = false;
        this.gear = null; this.t = 0; this.fails = 0; this.triedT = 0; this.said = false;
    }

    start() {
        if (this.timer) return;
        try {
            if (!this.rd) this.rd = new DidReader(this.linkOf(), { ecu: 0x12 });
            const l = this.rd.diag;
            if (l && typeof l.wake === 'function') { try { l.wake(0x12); } catch (e) { /* never */ } }
            this.timer = setInterval(() => this._poll(), POLL_MS);
            this._poll();
        } catch (e) { this.log.warn('engine gear: ' + (e && e.message || e)); }
    }

    stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

    /** The engine unit's gear (1..8) while fresh, else null. */
    value() { return this.gear !== null && Date.now() - this.t < STALE_MS ? this.gear : null; }

    _poll() {
        if (this.busy || !this.rd) return;
        const link = this.rd.diag;
        if (link && (link.ready === false || link.available === false)) return;
        if (this.fails >= 3 && Date.now() - this.triedT < FAIL_RETRY_MS) return;
        this.busy = true;
        Promise.resolve().then(() => this.rd.value('gear', CAND)).then((v) => {
            this.triedT = Date.now();
            if (v === null) {
                if (++this.fails === 3) this.log.info('engine gear: the engine unit gives no gear (22 5881); the gear from the rpm and speed');
                return;
            }
            this.fails = 0;
            this.gear = v >= 1 && v <= 8 ? v : null;
            this.t = Date.now();
            if (!this.said) { this.said = true; this.log.info('engine gear: read from the engine unit (22 5881), now ' + v); }
        }).catch((e) => { this.log.warn('engine gear: ' + (e && e.message || e)); })
            .then(() => { this.busy = false; });
    }
}

module.exports = { DmeGear, POLL_MS, STALE_MS };
