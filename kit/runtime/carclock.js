'use strict';
/**
 * carclock.js - the app's local time as the car's clock shows it. The head unit's own clock runs in UTC, so
 * Date's hours were UTC (two hours early in Lithuania). The instrument cluster shows the time in the time zone and
 * summer time set in iDrive (KombiIF.statusShowTimeDate, its own setting, so cars without Connected Drive have it
 * too): the offset is that time of day less UTC's, rounded to a quarter hour, as the Store's clock reads it. The
 * offset sets process.env.TZ, so every Date of the app is in it. Node reads TZ when it first needs it (on the head
 * unit's Node 8 at the app's start only): the offset is kept in the app's data folder and in SHARED (any app that
 * read it), and set from there as the kit loads; an offset that changes applies at once on a newer Node, else at the
 * next start. The cluster is read once a start: the watch ends with the first time it shows, or after WATCH_MS
 * without one. Without a time from the cluster nothing changes: the app stays on the head unit's clock, as before.
 *
 *   carclock.init(dataDir, log)       as the kit loads: the offset kept
 *   carclock.start(signals, log)      the cluster's time read once
 *   carclock.offset()                 minutes east of UTC in use, or null
 */
const fs = require('fs');
const path = require('path');

const KOMBI = 'de.bmw.infotainment.KombiIF';
const SHARED = '/tmp/mgu-car-tz.json';
const WATCH_MS = 120000;
const DAY_MS = 86400000;
const QUARTER_MS = 900000;
// statusDisplayClockTimeDate: odd while the cluster shows the time, even while it shows --:--, 15 not filled in
const UNFILLED = 15;

let file = null, inUse = null;
const valid = (m) => typeof m === 'number' && isFinite(m) && m >= -720 && m <= 840 && m % 15 === 0;

/* POSIX TZ for minutes east of UTC: its offset is west-positive ("CAR-2" = UTC+2, "CAR5" = UTC-5, "CAR-5:30"). */
function tzOf(m) {
    const a = Math.abs(m), h = Math.floor(a / 60), mm = a % 60;
    return 'CAR' + (m > 0 ? '-' : '') + h + (mm ? ':' + (mm < 10 ? '0' : '') + mm : '');
}

/* Minutes east of UTC from the cluster's statusShowTimeDate at UTC time now (ms), or null: the time of day it shows
 * less UTC's, to the nearest quarter hour, between UTC-12 and UTC+14. */
function offsetOf(show, now) {
    const status = show && show.statusDisplayClockTimeDate;
    if (typeof status !== 'number' || status === UNFILLED || status % 2 !== 1) return null;
    if (!(show.displayHour < 24 && show.displayMinute < 60)) return null;
    const sec = show.displaySecond < 60 ? show.displaySecond : 0;
    const diff = ((((show.displayHour * 60 + show.displayMinute) * 60 + sec) * 1000 - now) % DAY_MS + DAY_MS) % DAY_MS;
    let m = Math.round(diff / QUARTER_MS) * 15 % 1440;
    if (m > 840) m -= 1440;
    return valid(m) ? m : null;
}

function read(f) {
    try { const m = JSON.parse(fs.readFileSync(f, 'utf8')).offsetMin; return valid(m) ? m : null; } catch (e) { return null; }
}

function apply(m) {
    inUse = m;
    process.env.TZ = tzOf(m);
}

function init(dataDir, log) {
    file = dataDir ? path.join(dataDir, 'car-tz.json') : null;
    if (process.env.TZ && process.env.TZ.indexOf('CAR') !== 0) return;   // a zone set on purpose stays
    let m = file ? read(file) : null;
    if (m === null) m = read(SHARED);
    if (m !== null) { apply(m); if (log) log.info('clock: UTC' + (m >= 0 ? '+' : '') + m / 60 + ' (the car\'s time, kept)'); }
}

function save(m) {
    const text = JSON.stringify({ offsetMin: m, at: Date.now() }) + '\n';
    [file, SHARED].filter(Boolean).forEach((f) => {
        try { fs.writeFileSync(f + '.tmp', text, { mode: 0o644 }); fs.renameSync(f + '.tmp', f); } catch (e) { /* a read-only place: kept in the other */ }
    });
}

function start(signals, log) {
    if (!signals || !signals.watch) return;
    if (process.env.TZ && process.env.TZ.indexOf('CAR') !== 0) return;
    let sub = null, done = false, timer = null;
    const end = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (sub && sub.shutdown) sub.shutdown();
    };
    timer = setTimeout(end, WATCH_MS);
    if (timer.unref) timer.unref();
    Promise.resolve(signals.watch(KOMBI, '1', {
        statusShowTimeDate: (v) => {
            if (done) return;
            const m = offsetOf(v, Date.now());
            if (m === null) return;
            const was = inUse;
            if (m !== inUse) {
                apply(m);
                save(m);
                if (log) log.info('clock: UTC' + (m >= 0 ? '+' : '') + m / 60 + ' from the cluster\'s time' + (was === null ? '' : ', was UTC' + (was >= 0 ? '+' : '') + was / 60));
            }
            end();
        },
    }, log)).then((s) => { sub = s; if (done && s && s.shutdown) s.shutdown(); }, (e) => { if (log) log.warn('clock: ' + (e && e.message || e)); end(); });
}

module.exports = { init, start, offset: () => inUse, offsetOf, tzOf };
