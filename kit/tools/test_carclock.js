'use strict';
/* kit/runtime/carclock.js: the car's clock from the cluster (KombiIF.timeDateUTC and statusShowTimeDate, the gap
 * between the two) as the app's local time - set as the kit loads from the offset kept, read once per start and kept;
 * nothing without both times (the head unit's clock stays). Run: node kit/tools/test_carclock.js */
const assert = require('assert');
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CLOCK = path.join(__dirname, '..', 'runtime', 'carclock.js');
const c = require(CLOCK);

// the cluster's two times: UTC (day and month from 0, year from 2001) and the time it shows (day and month from 1)
const U = (h, mi, d, mo, y) => ({ hourUTC: h, minuteUTC: mi, secondUTC: 10, dateDayUTC: d - 1, dateMonthUTC: mo - 1, dateYearUTC: y - 2001 });
const S = (h, mi, d, mo, y) => ({ displayHour: h, displayMinute: mi, displaySecond: 10, displayDateDay: d, displayDateMonth: mo, displayDateYear: y });
assert.strictEqual(c.offsetFrom(U(15, 0, 27, 11, 2026), S(17, 0, 27, 11, 2026), 0), 120, 'Lithuania: UTC+2');
assert.strictEqual(c.offsetFrom(U(15, 0, 27, 7, 2026), S(16, 0, 27, 7, 2026), 0), 60, 'UTC+1');
assert.strictEqual(c.offsetFrom(U(2, 30, 28, 11, 2026), S(21, 30, 27, 11, 2026), 0), -300, 'US Eastern, the evening before');
assert.strictEqual(c.offsetFrom(U(23, 0, 27, 11, 2026), S(12, 0, 28, 11, 2026), 0), 780, 'New Zealand summer: UTC+13, the next day');
assert.strictEqual(c.offsetFrom(U(10, 0, 27, 11, 2026), S(15, 30, 27, 11, 2026), 0), 330, 'India: UTC+5:30');
assert.strictEqual(c.offsetFrom(U(10, 0, 27, 11, 2026), S(10, 0, 27, 11, 2026), 0), 0, 'UTC');
assert.strictEqual(c.offsetFrom(U(15, 0, 31, 12, 2026), S(1, 0, 1, 1, 2027), 0), 600, 'across the new year');
assert.strictEqual(c.offsetFrom(U(15, 0, 27, 11, 2026), S(16, 58, 27, 11, 2026), 0), 120, 'a clock set by hand two minutes off: to 15 min');
assert.strictEqual(c.offsetFrom(U(15, 0, 27, 11, 2026), S(16, 59, 50, 11, 2026), 15000), 120, 'shown came 15 s earlier, a bad date: the time of day');
assert.strictEqual(c.offsetFrom(U(255, 255, 255, 255, 255), S(17, 0, 27, 11, 2026), 0), null, 'UTC not valid: none');
assert.strictEqual(c.offsetFrom(U(15, 0, 27, 11, 2026), S(255, 255, 255, 15, 65535), 0), null, 'the shown time not valid: none');
assert.strictEqual(c.offsetFrom(null, null), null);
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
        setImmediate(() => { h.timeDateUTC(${JSON.stringify(U(15, 0, 27, 11, 2026))}); h.statusShowTimeDate(${JSON.stringify(S(17, 0, 27, 11, 2026))}); console.log(c.offset()); })`);
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'car-tz.json'), 'utf8')).offsetMin, 120, 'kept in the app\'s folder');
    assert.strictEqual(JSON.parse(fs.readFileSync(shared, 'utf8')).offsetMin, 120, 'kept for the other apps');
    // the next start: 17:00, the car's time, before any signal
    assert.strictEqual(run(dir, {}, `c.init(${JSON.stringify(dir)}); console.log(new Date(${at}).getHours() + ' ' + c.offset())`), '17 120',
        'the next start: the car\'s time from the first Date on');
    // another app with no zone of its own: the shared one
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'carclock-'));
    assert.strictEqual(run(other, {}, `c.init(${JSON.stringify(other)}); console.log(new Date(${at}).getHours())`), '17', 'the zone another app kept');
    // no usable pair changes nothing
    assert.strictEqual(run(dir, {}, `c.init(${JSON.stringify(dir)}); let h; c.start({ watch: (i, v, x) => { h = x; return Promise.resolve({}); } });
        setImmediate(() => { h.timeDateUTC(${JSON.stringify(U(255, 255, 255, 255, 255))}); h.statusShowTimeDate(${JSON.stringify(S(17, 0, 27, 11, 2026))}); console.log(c.offset()); })`), '120', 'no usable UTC: the kept offset stays');
    // read once: the watch let go as soon as the offset is in, and after giveUpMs without one
    assert.strictEqual(run(dir, {}, `c.init(${JSON.stringify(dir)}); let h, down = 0; c.start({ watch: (i, v, x) => { h = x; return Promise.resolve({ shutdown: () => { down++; } }); } });
        setTimeout(() => { h.timeDateUTC(${JSON.stringify(U(15, 0, 27, 11, 2026))}); h.statusShowTimeDate(${JSON.stringify(S(17, 0, 27, 11, 2026))}); setTimeout(() => console.log(down), 20); }, 20)`), '1', 'the watch let go once the offset is in');
    assert.strictEqual(run(dir, {}, `c.init(${JSON.stringify(dir)}); let down = 0; c.start({ watch: () => Promise.resolve({ shutdown: () => { down++; } }) }, null, { giveUpMs: 50 });
        setTimeout(() => console.log(down), 150)`), '1', 'no answer: the watch let go all the same');
    // a zone set on purpose (TZ in the environment) is left alone
    assert.strictEqual(run(dir, { TZ: 'UTC' }, `c.init(${JSON.stringify(dir)}); console.log(new Date(${at}).getHours() + ' ' + c.offset())`), '15 null',
        'TZ set on purpose: kept');
} finally {
    try { fs.unlinkSync(shared); } catch (e) { /* gone */ }
    if (sharedBefore) fs.writeFileSync(shared, sharedBefore);
}
console.log('carclock: all ok');
