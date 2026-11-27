'use strict';
/**
 * carclock.js - the app's local time as the car's clock shows it. The head unit's own clock runs in UTC, so
 * Date's hours were UTC (two hours early in Lithuania). The instrument cluster tells the time zone set in iDrive's
 * time settings and summer time (KombiIF.timeDateUTC: statusTimeZonesId, a CommonTypes.TimeZone, and
 * offsetWintertimeSummertimeUTC 1); it is the cluster's own setting, so cars without Connected Drive have it too.
 * The zone sets process.env.TZ, so every Date of the app is in it. Node reads TZ when it first needs it (on the
 * head unit's Node 8 at the app's start only): the zone is kept in the app's data folder and in SHARED (any app
 * that learned it), and set from there as the kit loads; a zone that changes applies at once on a newer Node, else
 * at the next start. Without a zone from the cluster (no signal, an unknown id) nothing changes: the app stays on
 * the head unit's clock, as before.
 *
 *   carclock.init(dataDir, log)       as the kit loads: the zone kept
 *   carclock.start(signals, log)      the cluster's zone watched
 *   carclock.offset()                 minutes east of UTC in use, or null
 */
const fs = require('fs');
const path = require('path');

const KOMBI = 'de.bmw.infotainment.KombiIF';
const SHARED = '/tmp/mgu-car-tz.json';
// CommonTypes.TimeZone id -> minutes east of UTC (Cluster functions' more_data.js, from the cluster's list)
const ZONES = [null, -660, -600, -540, -480, -480, -480, -420, -420, -420, -420, -360, -360, -360, -360, -360, -300, -300, -300, -300,
    -270, -240, -240, -240, -240, -240, -240, -240, -210, -180, -180, -180, -180, -180, -60, -60, 0, 0, 0, 60, 60, 60, 60,
    120, 120, 120, 120, 120, 120, 120, 120, 120, 120, 180, 180, 210, 240, 240, 240, 240, 240, 300, 300, 300, 330, 345, 360, 360,
    390, 420, 420, 480, 480, 480, 540, 540, 570, 570, 600, 600, 600, 600, 600, 660, 660, 720, 720, 720];

let file = null, inUse = null;
const valid = (m) => typeof m === 'number' && isFinite(m) && m >= -720 && m <= 840 && m % 15 === 0;

/* POSIX TZ for minutes east of UTC: its offset is west-positive ("CAR-2" = UTC+2, "CAR5" = UTC-5, "CAR-5:30"). */
function tzOf(m) {
    const a = Math.abs(m), h = Math.floor(a / 60), mm = a % 60;
    return 'CAR' + (m > 0 ? '-' : '') + h + (mm ? ':' + (mm < 10 ? '0' : '') + mm : '');
}

/* Minutes east of UTC from the cluster's timeDateUTC, or null. */
function offsetOf(v) {
    const id = v && v.statusTimeZonesId, base = typeof id === 'number' ? ZONES[id] : null;
    if (!valid(base)) return null;
    return base + (v.offsetWintertimeSummertimeUTC === 1 ? 60 : 0);
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
    if (m !== null) { apply(m); if (log) log.info('clock: UTC' + (m >= 0 ? '+' : '') + m / 60 + ' (the car\'s time zone, kept)'); }
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
    Promise.resolve(signals.watch(KOMBI, '1', {
        timeDateUTC: (v) => {
            const m = offsetOf(v);
            if (m === null || m === inUse) return;
            const was = inUse;
            apply(m);
            save(m);
            if (log) log.info('clock: UTC' + (m >= 0 ? '+' : '') + m / 60 + ' from the cluster (zone ' + v.statusTimeZonesId +
                ', summer ' + v.offsetWintertimeSummertimeUTC + ')' + (was === null ? '' : ', was UTC' + (was >= 0 ? '+' : '') + was / 60));
        },
    }, log)).catch((e) => { if (log) log.warn('clock: ' + (e && e.message || e)); });
}

module.exports = { init, start, offset: () => inUse, offsetOf, tzOf, ZONES };
