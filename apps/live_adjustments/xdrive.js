'use strict';
/**
 * xdrive.js - EXPERIMENTAL: xDrive off (rear-wheel drive) until the next ignition cycle, over
 * the DSC's own diagnostic job LMV_FUNKTION (issue #28). Ships Off: the "xDrive (experimental)"
 * setting must be switched on, and then the xDrive tab appears. Off sends nothing at all.
 *
 * Research (ezl0l on issue #28, gist f5bd3677df04950ac232a1b50b6051f6, and IterioDev on a 2023
 * 230i xDrive): DSC, diagnostic address 0x29, DID 0xDBE1 = LMV_FUNKTION, "activation of the
 * longitudinal torque distribution for the current terminal-15 cycle", 1 = on, 0 = off.
 *   read  : 22 DB E1      -> 62 DB E1 01 | 00
 *   write : 2E DB E1 00   -> 6E DB E1         (xDrive off)
 * The DSC accepts the write only with the ignition on, the engine OFF, selector in P, parking
 * brake applied and the car stationary; with the engine running it answers an NRC. After the
 * engine is started in the SAME ignition cycle DBE1 stays 0 and the cluster shows an
 * informational all-wheel-drive notice. A full ignition cycle (terminal 15 off and on) brings
 * xDrive back - so the app sends no "on" command at all: DBE1 = 01 has no tested basis on G
 * cars and the known re-enable elsewhere is a DSC reset, which this app will not send.
 * With the engine off DBE1 reads 0 anyway, so the state is shown only with the engine running.
 *
 * Front-axle torque, to see the effect while driving (read only, engine running, tab shown):
 * LMV (transfer case), diagnostic address 0x19, DID 0xDB32 LMV_MOMENT:
 *   22 DB 32 -> 62 DB 32 <actual s16> <qualifier u16> <requested s16> <qualifier u16>, Nm = raw / 4
 * (BMW's LMV_G11 description; matches ezl0l's logs: 00 9E .. 00 98 = 39.5 / 38.0 Nm).
 *
 * Tested by others on a G22 M440i (DSC_G20, SGBD index 0F2510) and a G42 230i. Front-axle torque
 * dropped to 0 in their logs; ABS / DSC behaviour in motion was not measured. Experimental.
 */

const DSC = 0x29;                       // DSC (BMW diagnostic address)
const LMV = 0x19;                       // transfer case (BMW diagnostic address)
const DID_TORQUE = [0xDB, 0x32];        // LMV_MOMENT: front-axle torque actual / requested
const DID_SGBD_INDEX = [0xF1, 0x50];
const DID_LMV = [0xDB, 0xE1];           // LMV_FUNKTION
const TESTED_INDEX = ['0F2510'];        // DSC_G20, the variant the research ran on
const ENGINE_OFF_RPM = 50;              // below this the engine counts as stopped
const ENGINE_ON_RPM = 400;              // above this it runs (the DSC reports the mode then)
const POLL_MS = 4000;                   // DBE1 read while the tab is shown
const TORQUE_MS = 1000;                 // front-axle torque read while the tab is shown and the engine runs
const MOVING_KMH = 3;                   // the peak counts only while moving
const CONFIRM_MS = 6000;                // the second press must come within this

const hex2 = (b) => b.toString(16).padStart(2, '0').toUpperCase();
const NRC_TEXT = {
    0x22: 'conditions not met · ignition on, engine off, P, parking brake on, car stationary',
    0x31: 'not supported by this DSC',
    0x33: 'refused (security access) · switch the engine off first',
    0x7E: 'not allowed in the current diagnostic session',
    0x7F: 'not allowed in the current diagnostic session',
    0x13: 'not supported by this DSC',
};

class XDriveControl {
    /** car: { data() -> { rpm, speed, stage, demo } } (kit/car.js) */
    constructor(ctx, car, now) {
        this.ctx = ctx;
        this.car = car;
        this.log = ctx.log;
        this.now = now || (() => Date.now());
        this.link = null;
        this.requested = false;         // this app had the write accepted (until xDrive reads back 1)
        this._reset();
    }

    _reset() {
        this.index = null;              // DSC SGBD index, hex like '0F2510'
        this.supported = null;          // true: DBE1 answered; false: the DSC refused the read
        this.lmv = null;                // last DBE1 value 0 | 1
        this.lmvRunning = false;        // DBE1 was read with the engine running (only then it means anything)
        this.lastRead = 0;
        this.torque = null;             // { actual, requested } Nm, last LMV read
        this.torqueOk = null;           // false: the LMV refused the read (stop asking)
        this.peakRequested = null;      // highest requested front torque seen while moving
        this.lastTorque = 0;
        this.reading = false;
        this.busy = false;
        this.confirmUntil = 0;
        this.note = null;
        this.noteType = 'dim';
    }

    get enabled() { return this.ctx.settings.get('xdrive') === 'on'; }

    async start(link) {
        this.link = link;
        await this.refresh();
    }

    /** The setting changed or the link came up: identify the DSC and read DBE1 (reads only). */
    async refresh() {
        this._reset();
        if (!this.enabled) return;
        if (!this._linkUp()) { this.note = 'Waiting for the diagnostic link'; this.noteType = 'warn'; return; }
        const sg = await this._read(DID_SGBD_INDEX);
        if (sg.ok) this.index = sg.data.map(hex2).join('').replace(/^0+(?=.{6})/, '');
        await this._readLmv();
        this.log.info('xdrive: DSC ' + (this.index || '?') + ' DBE1 ' + (this.supported === false ? 'refused' : this.lmv));
    }

    /** Called with each frame while the xDrive tab is shown: reads DBE1 now and then, and the
     * front-axle torque every second while the engine runs. One round of reads at a time. */
    tick() {
        if (!this.enabled || this.busy || this.reading || this.supported === false || !this._linkUp()) return null;
        const jobs = [];
        if (this.now() - this.lastRead >= POLL_MS) jobs.push(this._readLmv());
        if (this.supported === true && this.torqueOk !== false && this.engineRunning() && this.now() - this.lastTorque >= TORQUE_MS) {
            jobs.push(this._readTorque());
        }
        if (!jobs.length) return null;
        this.reading = true;
        return Promise.all(jobs).finally(() => { this.reading = false; });
    }

    _linkUp() { return !!(this.link && this.link.available && this.link.diag); }

    async _read(did, ecu) {
        try {
            const r = await this.link.diag.physical(ecu || DSC, 0x22, did, 2500,
                (u) => (u[0] === 0x62 && u[1] === did[0] && u[2] === did[1]) || (u[0] === 0x7F && u[1] === 0x22));
            if (!r || !r.length) return { ok: false, nrc: null };
            if (r[0] === 0x7F) return { ok: false, nrc: r[2] };
            return { ok: true, data: r.slice(3) };
        } catch (e) {
            return { ok: false, nrc: null, error: String(e && e.message || e) };
        }
    }

    async _readLmv() {
        this.lastRead = this.now();
        const running = this.engineRunning();
        const r = await this._read(DID_LMV);
        if (r.ok && r.data.length) {
            this.supported = true;
            this.lmv = r.data[0] ? 1 : 0;
            this.lmvRunning = running;
            if (running && this.lmv === 1) this.requested = false;     // xDrive is back (ignition cycled)
        } else if (r.nrc != null) {
            this.supported = false;
            this.note = 'The DSC does not offer LMV_FUNKTION (' + (NRC_TEXT[r.nrc] || 'NRC ' + hex2(r.nrc)) + ')';
            this.noteType = 'warn';
        }
    }

    async _readTorque() {
        this.lastTorque = this.now();
        const r = await this._read(DID_TORQUE, LMV);
        if (r.ok && r.data.length >= 8) {
            const s16 = (i) => ((r.data[i] << 8 | r.data[i + 1]) << 16 >> 16) / 4;
            this.torqueOk = true;
            this.torque = { actual: s16(0), requested: s16(4) };
            const d = this._live();
            if (!d.demo && d.speed !== null && d.speed >= MOVING_KMH) {
                this.peakRequested = Math.max(this.peakRequested === null ? -Infinity : this.peakRequested, this.torque.requested);
            }
        } else if (r.nrc != null) {
            this.torqueOk = false;
            this.torque = null;
        }
    }

    /** Live vehicle values; demo data never counts. */
    _live() {
        const d = (this.car && this.car.data()) || {};
        if (d.demo) return { demo: true };
        const num = (x) => (typeof x === 'number' && isFinite(x) ? x : null);
        return { demo: false, rpm: num(d.rpm), speed: num(d.speed), stage: d.stage };
    }
    engineRunning() { const d = this._live(); return !d.demo && d.rpm !== null && d.rpm > ENGINE_ON_RPM; }

    /** The conditions the DSC wants, as far as the head unit can see them. ok: true / false / null (cannot tell). */
    checks() {
        const d = this._live();
        return [
            { label: 'Live car data', ok: !d.demo },
            { label: 'Engine off', ok: d.demo ? false : d.rpm === null ? false : d.rpm < ENGINE_OFF_RPM },
            { label: 'Stationary', ok: d.demo ? false : d.speed === null ? false : d.speed < 0.5 },
            { label: 'Selector in P', ok: d.demo ? false : d.stage === 'P' ? true : d.stage ? false : null },
            { label: 'Parking brake on', ok: null },
        ];
    }

    /** Why a press would not send, or null when it may. */
    blocker() {
        if (!this.enabled) return 'Switch on xDrive (experimental) in Settings';
        if (this.busy) return 'Busy';
        if (!this._linkUp()) return 'Waiting for the diagnostic link';
        if (this.supported !== true) return this.supported === false ? 'Not available on this car' : 'DSC not answering yet';
        const bad = this.checks().find((c) => c.ok === false);
        return bad ? (bad.label === 'Live car data' ? 'No live car data' : 'Needs: ' + bad.label.toLowerCase()) : null;
    }

    /** "xDrive off": the first press asks, the second (within CONFIRM_MS) sends the one write. */
    async requestOff() {
        if (this.busy) return;
        const why = this.blocker();
        if (why) { this.confirmUntil = 0; this.note = why; this.noteType = 'warn'; return; }
        if (this.now() > this.confirmUntil) {
            this.confirmUntil = this.now() + CONFIRM_MS;
            this.note = 'Press again to switch xDrive off until the ignition is switched off';
            this.noteType = 'warn';
            return;
        }
        this.confirmUntil = 0;
        this.busy = true;
        this.note = 'Sending to the DSC…'; this.noteType = 'dim';
        try {
            this.log.info('UDS -> DSC 2E DB E1 00 (xDrive off, experimental)');
            const r = await this.link.diag.physical(DSC, 0x2E, [0xDB, 0xE1, 0x00], 3000,
                (u) => (u[0] === 0x6E && u[1] === 0xDB && u[2] === 0xE1) || (u[0] === 0x7F && u[1] === 0x2E));
            this.log.info('UDS <- DSC ' + (r ? r.map(hex2).join(' ') : 'no answer'));
            if (r && r[0] === 0x6E) {
                this.requested = true;
                this.note = 'Accepted by the DSC · start the engine without switching the ignition off';
                this.noteType = 'go';
            } else if (r && r[0] === 0x7F) {
                this.note = 'DSC refused: ' + (NRC_TEXT[r[2]] || 'NRC ' + hex2(r[2]));
                this.noteType = 'warn';
            } else {
                this.note = 'No answer from the DSC';
                this.noteType = 'warn';
            }
        } catch (e) {
            this.note = String(e && e.message || e);
            this.noteType = 'warn';
            this.log.warn('xdrive: ' + this.note);
        } finally {
            this.busy = false;
            this.lastRead = 0;              // read DBE1 again on the next frame
        }
    }

    /** What the screen shows: mode 'AWD' | 'RWD' | 'REQUESTED' | 'UNKNOWN'. */
    view() {
        const running = this.engineRunning();
        let mode = 'UNKNOWN';
        if (running && this.lmvRunning && this.lmv !== null) mode = this.lmv ? 'AWD' : 'RWD';
        else if (this.requested) mode = 'REQUESTED';
        return {
            enabled: this.enabled,
            mode,
            running,
            index: this.index,
            tested: !!this.index && TESTED_INDEX.indexOf(this.index) >= 0,
            supported: this.supported,
            torque: running ? this.torque : null,
            torqueOk: this.torqueOk,
            peakRequested: this.peakRequested,
            checks: this.checks(),
            blocker: this.blocker(),
            confirming: this.now() <= this.confirmUntil,
            busy: this.busy,
            note: this.note,
            noteType: this.noteType,
        };
    }
}

module.exports = { XDriveControl, DSC, LMV, TESTED_INDEX, ENGINE_OFF_RPM, ENGINE_ON_RPM };
