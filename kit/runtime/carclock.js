'use strict';
/**
 * carclock.js - the app's local time as the car's clock shows it. The head unit's own clock runs in UTC, so
 * Date's hours were UTC (two hours early in Lithuania). The instrument cluster sends both the UTC time
 * (KombiIF.timeDateUTC) and the time it shows the driver (KombiIF.statusShowTimeDate, what BMW's own apps read): the
 * gap between the two, to 15 min, is the offset. No time zone table: it covers every region and summer time, and a
 * clock the driver set by hand too. The offset sets process.env.TZ, so every Date of the app is in it. Node reads TZ
 * when it first needs it (on the head unit's Node 8 at the app's start only): the offset is kept in the app's data
 * folder and in SHARED (any app that learned it), and set from there as the kit loads; a changed one applies at once
 * on a newer Node, else at the next start. So the cluster is read once per start and the watch let go after.
 * Without both times from the cluster nothing changes: the app stays on the head unit's clock, as before.
 *
 *   carclock.init(dataDir, log)       as the kit loads: the offset kept
 *   carclock.start(signals, log)      the cluster read once (then let go, or after GIVE_UP_MS without an answer)
 *   carclock.offset()                 minutes east of UTC in use, or null
 */
const fs = require('fs');
const path = require('path');

const KOMBI = 'de.bmw.infotainment.KombiIF';
const SHARED = '/tmp/mgu-car-tz.json';
const GIVE_UP_MS = 120000;           // no usable pair of times by then: the watch is let go all the same
const PAIR_MS = 10000;               // the two times count as a pair when they came this close together

let file = null, inUse = null;
const valid = (m) => typeof m === 'number' && isFinite(m) && m >= -720 && m <= 840 && m % 15 === 0;
const n = (x, lo, hi) => typeof x === 'number' && isFinite(x) && x >= lo && x <= hi;

/* POSIX TZ for minutes east of UTC: its offset is west-positive ("CAR-2" = UTC+2, "CAR5" = UTC-5, "CAR-5:30"). */
function tzOf(m) {
    const a = Math.abs(m), h = Math.floor(a / 60), mm = a % 60;
    return 'CAR' + (m > 0 ? '-' : '') + h + (mm ? ':' + (mm < 10 ? '0' : '') + mm : '');
}

/**
 * Minutes east of UTC from the cluster's two times, or null. utc: timeDateUTC (day and month from 0, year from
 * 2001, as BMW's own apps read it), shown: statusShowTimeDate (day and month from 1, the full year); lagMs: how much
 * later utc came than shown (shown is moved on by it). The time of day gives the offset, the dates the day it falls on.
 */
function offsetFrom(utc, shown, lagMs) {
    if (!utc || !shown) return null;
    if (!n(utc.hourUTC, 0, 23) || !n(utc.minuteUTC, 0, 59) || !n(shown.displayHour, 0, 23) || !n(shown.displayMinute, 0, 59)) return null;
    const us = n(utc.secondUTC, 0, 59) ? utc.secondUTC : 0, ss = n(shown.displaySecond, 0, 59) ? shown.displaySecond : 0;
    let s = (shown.displayHour * 3600 + shown.displayMinute * 60 + ss + (lagMs || 0) / 1000) - (utc.hourUTC * 3600 + utc.minuteUTC * 60 + us);
    let m = s / 60, day = null;
    if (n(utc.dateDayUTC, 0, 30) && n(utc.dateMonthUTC, 0, 11) && n(utc.dateYearUTC, 0, 250)
        && n(shown.displayDateDay, 1, 31) && n(shown.displayDateMonth, 1, 12) && n(shown.displayDateYear, 2001, 2251)) {
        const d = (Date.UTC(shown.displayDateYear, shown.displayDateMonth - 1, shown.displayDateDay)
            - Date.UTC(utc.dateYearUTC + 2001, utc.dateMonthUTC, utc.dateDayUTC + 1)) / 86400000;
        if (d === -1 || d === 0 || d === 1) day = d;
    }
    if (day !== null) m += day * 1440;
    else { while (m > 720) m -= 1440; while (m <= -720) m += 1440; }      // the dates no help: the nearer day
    m = Math.round(m / 15) * 15;
    if (m === 0) m = 0;                                                      // (no -0)
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
    if (m !== null) { apply(m); if (log) log.info('clock: UTC' + (m >= 0 ? '+' : '') + m / 60 + ' (the car\'s clock, kept)'); }
}

function save(m) {
    const text = JSON.stringify({ offsetMin: m, at: Date.now() }) + '\n';
    [file, SHARED].filter(Boolean).forEach((f) => {
        try { fs.writeFileSync(f + '.tmp', text, { mode: 0o644 }); fs.renameSync(f + '.tmp', f); } catch (e) { /* a read-only place: kept in the other */ }
    });
}

function start(signals, log, o) {
    if (!signals || !signals.watch) return;
    if (process.env.TZ && process.env.TZ.indexOf('CAR') !== 0) return;
    const giveUp = (o && o.giveUpMs) || GIVE_UP_MS;
    let utc = null, shown = null, sub = null, done = false, timer = null;
    const stop = () => {
        done = true;
        if (timer) { clearTimeout(timer); timer = null; }
        if (sub && sub.shutdown) { const s = sub; sub = null; Promise.resolve().then(() => s.shutdown()).catch(() => {}); }
    };
    const check = () => {
        if (done || !utc || !shown || Math.abs(utc.t - shown.t) > PAIR_MS) return;
        const m = offsetFrom(utc.v, shown.v, utc.t - shown.t);
        if (m === null) return;
        stop();
        if (m === inUse) return;
        const was = inUse;
        apply(m);
        save(m);
        if (log) log.info('clock: UTC' + (m >= 0 ? '+' : '') + m / 60 + ' from the cluster' + (was === null ? '' : ', was UTC' + (was >= 0 ? '+' : '') + was / 60));
    };
    timer = setTimeout(stop, giveUp);
    if (timer.unref) timer.unref();
    Promise.resolve(signals.watch(KOMBI, '1', {
        timeDateUTC: (v) => { utc = { v, t: Date.now() }; check(); },
        statusShowTimeDate: (v) => { shown = { v, t: Date.now() }; check(); },
    }, log)).then((s) => {
        if (done) { if (s && s.shutdown) Promise.resolve().then(() => s.shutdown()).catch(() => {}); } else sub = s;
    }).catch((e) => { stop(); if (log) log.warn('clock: ' + (e && e.message || e)); });
}

module.exports = { init, start, offset: () => inUse, offsetFrom, tzOf };
