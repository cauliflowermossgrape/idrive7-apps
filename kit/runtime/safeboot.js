'use strict';
/**
 * safeboot.js - an app that fails to start twice in a row comes up the third time in safe mode (mgu.js): no
 * background work, the settings' defaults in memory only (the saved file untouched), and a page saying what failed.
 *
 * A start leaves a marker in the app's data folder (safeboot.json) and clears it once it got through (ok()): the app's
 * start done and 30 s up without a crash. A marker still there at the next start is a start that crashed, hung or
 * was stopped on the way: one more failure if it left an error (a crash, an error at start; a start the car ended
 * leaves none). Two in a row: safe mode. A start that gets through counts from 0 again.
 *
 *   const sb = new SafeBoot(dataDir);
 *   const st = sb.begin();     // { safe, fails, last: { step, error, at } }
 *   sb.step('background');     // the step it is in, named on the safe page if it fails there
 *   sb.fail(err);              // an error the kit caught at start (or the uncaught one before the exit)
 *   sb.ok();                   // it got through
 *   sb.retry();                // "Try normal start again": the count back to 0, this start runs normally
 *   settingNamed(err, schema)  // the setting an error message names, if any
 */
const fs = require('fs');
const path = require('path');

const FAILS = 2;

class SafeBoot {
    constructor(dataDir, now) {
        this.file = path.join(dataDir, 'safeboot.json');
        this.now = now || Date.now;
        this.state = { fails: 0, last: null, starting: null };
    }

    _read() {
        try { const s = JSON.parse(fs.readFileSync(this.file, 'utf8')); if (s && typeof s === 'object') return s; } catch (e) { /* none yet */ }
        return { fails: 0, last: null, starting: null };
    }
    _write() {
        try {
            const tmp = this.file + '.' + process.pid + '.tmp';
            fs.writeFileSync(tmp, JSON.stringify(this.state));
            fs.renameSync(tmp, this.file);
        } catch (e) { /* data folder not writable (host preview) */ }
    }

    /** A start begins: the one before it counted if it never got through. */
    begin() {
        const s = this._read();
        s.fails = s.fails || 0;
        // only a start that left an error counts: a crash (the uncaught handler records it before the exit) or an error
        // the kit caught. A marker without one is a start the car ended (switched off or asleep again within the 30 s,
        // killed at power-down, MainApp's CONFIG_STATE start): on a car that is every other start, not a failure (#262)
        if (s.starting && s.starting.error) {
            s.fails++;
            s.last = { step: s.starting.step || 'start', error: s.starting.error, at: s.starting.at };
        }
        s.starting = { at: this.now(), step: 'start', error: null };
        this.state = s;
        this.safe = s.fails >= FAILS;
        this._write();
        return { safe: this.safe, fails: s.fails, last: s.last };
    }
    step(name) {
        if (!this.state.starting) return;
        this.state.starting.step = name;
        this._write();
    }
    /** An error at start: kept with the marker (the start does not count as through). */
    fail(err) {
        if (!this.state.starting) this.state.starting = { at: this.now(), step: 'running', error: null };
        const msg = String(err && err.message || err).split('\n')[0];
        // (the first error of a start is the one that says what went wrong)
        if (!this.state.starting.error) this.state.starting.error = msg;
        this.failed = true;
        this._write();
    }
    ok() {
        if (this.failed) return false;
        this.state = { fails: 0, last: null, starting: null };
        this.safe = false;
        this._write();
        return true;
    }
    /**
     * MainApp asked the app to stop (its shutdown): a start stopped on purpose is no failure, whenever it comes (a
     * CONFIG_STATE start without screens, the car asleep again within the 30 s). The marker goes, the count stays as
     * it was (a start before this one that failed still counts). An error caught in this start keeps it.
     */
    stopped() {
        if (this.failed || !this.state.starting) return false;
        this.state.starting = null;
        this._write();
        return true;
    }
    retry() {
        this.state = { fails: 0, last: null, starting: { at: this.now(), step: 'start', error: null } };
        this.safe = false;
        this.failed = false;
        this._write();
    }
}

/** The setting an error names (its key, or its label), if any: shown on the safe page. */
function settingNamed(err, schema) {
    const msg = String(err || '');
    const s = (schema || []).find((x) => x.key && (new RegExp('\\b' + x.key.replace(/[^\w]/g, '') + '\\b').test(msg) || (x.label && msg.indexOf(x.label) >= 0)));
    return s ? s.label || s.key : null;
}

module.exports = { SafeBoot, settingNamed, FAILS };
