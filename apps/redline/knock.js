'use strict';
/**
 * Part of Redline's experimental features; README.md in this folder has the whole picture.
 *
 * Knock, for the HUD's knock warning and readout: the engine unit (DME, 0x12) over read-only UDS 22, the
 * same values Live Data shows (apps/live_data/useful.js, "Ignition and knock"):
 *   554C  knock control's ignition retard, the mean of the cylinders' (s8 x 0.375 degrees crank angle)
 *   4A36  knock detected (u8, 0 = no)
 * Read twice a second while wanted (the HUD shows and the engine runs), on the gearbox reader's link.
 * An event: the retard reaching WARN_DEG, or the flag set. Never throws; value() is
 *   { retard (degrees or null), at (ms of the last event or 0) }.
 * The thresholds are from the catalogue's scaling, not yet checked on a car.
 */
const { DidReader } = require('./kit/dids');

const RETARD = [{ ecu: 0x12, did: '554C', bytes: 1, at: 0, signed: true, factor: 0.375, offset: 0, min: -48, max: 48 }];
const FLAG = [{ ecu: 0x12, did: '4A36', bytes: 1, at: 0, factor: 1, offset: 0, min: 0, max: 255 }];
const POLL_MS = 500, STALE_MS = 3000, FAIL_RETRY_MS = 60000;
const WARN_DEG = 2.25;            // 6 steps of 0.375: well past the odd single correction

class KnockWatch {
    /** linkOf: () => a ReadOnlyDiag (the gearbox reader's, shared). */
    constructor(ctx, linkOf) {
        this.ctx = ctx; this.log = ctx.log; this.linkOf = linkOf;
        this.rd = null; this.timer = null; this.busy = false;
        this.retard = null; this.t = 0; this.triedT = 0; this.fails = 0; this.at = 0; this.logged = false;
    }

    start() {
        if (this.timer) return;
        try {
            if (!this.rd) this.rd = new DidReader(this.linkOf(), { ecu: 0x12 });
            this.timer = setInterval(() => this._poll(), POLL_MS);
            this._poll();
        } catch (e) { this.log.warn('knock: ' + (e && e.message || e)); }
    }

    stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

    _poll() {
        if (this.busy || !this.rd) return;
        if (this.fails >= 3 && Date.now() - this.triedT < FAIL_RETRY_MS) return;     // not answering: once a minute
        this.busy = true;
        const now = () => Date.now();
        Promise.resolve().then(() => this.rd.value('knock', RETARD)).then((v) => {
            this.triedT = now();
            if (v === null) {
                if (++this.fails === 3) this.log.info('knock: the engine unit gives no knock retard (554C); no knock warning on this car');
                return null;
            }
            if (!this.logged) { this.logged = true; this.log.info('knock: retard read from the engine unit (554C), ' + v + ' deg'); }
            this.fails = 0; this.retard = v; this.t = this.triedT;
            if (v >= WARN_DEG) this._event('retard ' + v.toFixed(1) + ' deg');
            return this.rd.value('knockflag', FLAG);
        }).then((f) => { if (f) this._event('knock detected (4A36 = ' + f + ')'); })
            .catch((e) => { this.triedT = now(); this.fails++; this.log.warn('knock: ' + (e && e.message || e)); })
            .then(() => { this.busy = false; });
    }

    _event(why) {
        const now = Date.now();
        // logged at most every 10 s (a knocking engine reports it on every read)
        if (now - this.at > 10000) this.log.info('knock: ' + why);
        this.at = now;
    }

    value() {
        const fresh = this.retard !== null && Date.now() - this.t < STALE_MS;
        return { retard: fresh ? this.retard : null, at: this.at };
    }
}

KnockWatch.WARN_DEG = WARN_DEG;
module.exports = KnockWatch;
