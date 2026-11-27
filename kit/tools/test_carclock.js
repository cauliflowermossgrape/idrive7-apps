'use strict';
/* kit/runtime/carclock.js: the car's time zone from the cluster (KombiIF.timeDateUTC) as the app's local time - set
 * as the kit loads from the zone kept, learned from the signal and kept; nothing without a zone (a car whose cluster
 * says none stays on the head unit's clock). Run: node kit/tools/test_carclock.js */
const assert = require('assert');
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CLOCK = path.join(__dirname, '..', 'runtime', 'carclock.js');
const c = require(CLOCK);

// the zone ids the cars send: 47 (Lithuania, UTC+2), 39 (UTC+1), US Eastern (-5) with summer time
assert.strictEqual(c.offsetOf({ statusTimeZonesId: 47, offsetWintertimeSummertimeUTC: 13 }), 120);
assert.strictEqual(c.offsetOf({ statusTimeZonesId: 39, offsetWintertimeSummertimeUTC: 0 }), 60);
assert.strictEqual(c.offsetOf({ statusTimeZonesId: 16, offsetWintertimeSummertimeUTC: 1 }), -240);
assert.strictEqual(c.offsetOf({ statusTimeZonesId: 0 }), null, 'zone 0: none');
assert.strictEqual(c.offsetOf({ statusTimeZonesId: 255 }), null, 'an id past the list: none');
assert.strictEqual(c.offsetOf(null), null);
assert.strictEqual(c.tzOf(120), 'CAR-2');
assert.strictEqual(c.tzOf(-300), 'CAR5');
assert.strictEqual(c.tzOf(330), 'CAR-5:30');
assert.strictEqual(c.tzOf(0), 'CAR0');

// a fresh process, as the app starts on the car: hours as the car's clock, UTC without a kept zone
const run = (dir, env, code) => cp.execFileSync(process.execPath, ['-e',
    `const c = require(${JSON.stringify(CLOCK)}); ${code}`], { env: Object.assign({}, process.env, { TZ: '' }, env), cwd: dir }).toString().trim();
const at = Date.UTC(2026, 10, 27, 15, 0, 0);   // 15:00 UTC
const hours = `c.init(${'process.argv[1] || "."'}); console.log(new Date(${at}).getHours() + ' ' + c.offset())`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carclock-'));
const shared = '/tmp/mgu-car-tz.json';
let sharedBefore = null;
try { sharedBefore = fs.readFileSync(shared); fs.unlinkSync(shared); } catch (e) { /* none */ }
try {
    assert.strictEqual(run(dir, {}, `c.init(${JSON.stringify(dir)}); console.log(new Date(${at}).getHours() + ' ' + c.offset())`), '15 null',
        'no zone kept: the head unit\'s clock (UTC), as before');
    // the signal: the zone applied and kept in the app's folder and SHARED
    run(dir, {}, `c.init(${JSON.stringify(dir)}); let h; c.start({ watch: (i, v, x) => { h = x; return Promise.resolve({}); } });
        setImmediate(() => { h.timeDateUTC({ statusTimeZonesId: 47, offsetWintertimeSummertimeUTC: 0 }); console.log(c.offset()); })`);
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'car-tz.json'), 'utf8')).offsetMin, 120, 'kept in the app\'s folder');
    assert.strictEqual(JSON.parse(fs.readFileSync(shared, 'utf8')).offsetMin, 120, 'kept for the other apps');
    // the next start: 17:00, the car's time, before any signal
    assert.strictEqual(run(dir, {}, `c.init(${JSON.stringify(dir)}); console.log(new Date(${at}).getHours() + ' ' + c.offset())`), '17 120',
        'the next start: the car\'s time from the first Date on');
    // another app with no zone of its own: the shared one
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'carclock-'));
    assert.strictEqual(run(other, {}, `c.init(${JSON.stringify(other)}); console.log(new Date(${at}).getHours())`), '17', 'the zone another app kept');
    // a signal with no usable zone changes nothing
    assert.strictEqual(run(dir, {}, `c.init(${JSON.stringify(dir)}); let h; c.start({ watch: (i, v, x) => { h = x; return Promise.resolve({}); } });
        setImmediate(() => { h.timeDateUTC({ statusTimeZonesId: 0 }); console.log(c.offset()); })`), '120', 'an unknown zone: the kept one stays');
    // a zone set on purpose (TZ in the environment) is left alone
    assert.strictEqual(run(dir, { TZ: 'UTC' }, `c.init(${JSON.stringify(dir)}); console.log(new Date(${at}).getHours() + ' ' + c.offset())`), '15 null',
        'TZ set on purpose: kept');
} finally {
    try { fs.unlinkSync(shared); } catch (e) { /* gone */ }
    if (sharedBefore) fs.writeFileSync(shared, sharedBefore);
}
console.log('carclock: all ok');
