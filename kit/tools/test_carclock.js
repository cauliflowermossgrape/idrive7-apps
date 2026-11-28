'use strict';
/* kit/runtime/carclock.js: the car's time zone from the time the cluster shows (KombiIF.statusShowTimeDate) as the
 * app's local time - set as the kit loads from the offset kept, read from the cluster once a start and kept; nothing
 * without a time shown (a car whose cluster says none stays on the head unit's clock). Run: node kit/tools/test_carclock.js */
const assert = require('assert');
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CLOCK = path.join(__dirname, '..', 'runtime', 'carclock.js');
const c = require(CLOCK);

const at = Date.UTC(2026, 10, 27, 15, 0, 0);   // 15:00:00 UTC
const shown = (h, m, s, status) => ({ statusDisplayClockTimeDate: status === undefined ? 1 : status, displayHour: h, displayMinute: m, displaySecond: s || 0 });

// the time the cluster shows less UTC's, to a quarter hour
assert.strictEqual(c.offsetOf(shown(17, 0, 2), at + 1500), 120, 'Lithuania: UTC+2');
assert.strictEqual(c.offsetOf(shown(16, 0), at), 60, 'UTC+1');
assert.strictEqual(c.offsetOf(shown(11, 0), at), -240, 'US Eastern with summer time: UTC-4');
assert.strictEqual(c.offsetOf(shown(7, 0), at), -480, 'US Pacific: UTC-8');
assert.strictEqual(c.offsetOf(shown(20, 30), at), 330, 'India: UTC+5:30');
assert.strictEqual(c.offsetOf(shown(4, 0), at), 780, 'past midnight: UTC+13');
assert.strictEqual(c.offsetOf(shown(14, 59, 50), at), 0, 'a few seconds behind: UTC');
assert.strictEqual(c.offsetOf(shown(17, 0, 0, 2), at), null, 'the cluster shows --:--');
assert.strictEqual(c.offsetOf(shown(17, 0, 0, 15), at), null, 'not filled in');
assert.strictEqual(c.offsetOf(shown(25, 0), at), null, 'no hour');
assert.strictEqual(c.offsetOf(null, at), null);
assert.strictEqual(c.tzOf(120), 'CAR-2');
assert.strictEqual(c.tzOf(-300), 'CAR5');
assert.strictEqual(c.tzOf(330), 'CAR-5:30');
assert.strictEqual(c.tzOf(0), 'CAR0');

// a fresh process, as the app starts on the car: hours as the car's clock, UTC without a kept offset
const run = (dir, env, code) => cp.execFileSync(process.execPath, ['-e',
    `const c = require(${JSON.stringify(CLOCK)}); ${code}`], { env: Object.assign({}, process.env, { TZ: '' }, env), cwd: dir }).toString().trim();
// a cluster that shows UTC+2 now; the watch's handle counts its shutdowns
const watching = (h) => `let h, down = 0; c.start({ watch: (i, v, x) => { h = x; return Promise.resolve({ shutdown: () => { down++; } }); } });
    setImmediate(() => { const d = new Date(Date.now() + ${h} * 3600000); h.statusShowTimeDate({ statusDisplayClockTimeDate: 1,
    displayHour: d.getUTCHours(), displayMinute: d.getUTCMinutes(), displaySecond: d.getUTCSeconds() });`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carclock-'));
const shared = '/tmp/mgu-car-tz.json';
let sharedBefore = null;
try { sharedBefore = fs.readFileSync(shared); fs.unlinkSync(shared); } catch (e) { /* none */ }
try {
    assert.strictEqual(run(dir, {}, `c.init(${JSON.stringify(dir)}); console.log(new Date(${at}).getHours() + ' ' + c.offset())`), '15 null',
        'nothing kept: the head unit\'s clock (UTC), as before');
    // the cluster's time: the offset applied and kept in the app's folder and SHARED, the watch ended
    assert.strictEqual(run(dir, {}, `c.init(${JSON.stringify(dir)}); ${watching(2)}
        setImmediate(() => { h.statusShowTimeDate({ statusDisplayClockTimeDate: 1, displayHour: 3, displayMinute: 0 }); console.log(c.offset() + ' ' + down); }); })`),
    '120 1', 'read once: the watch ends with the first time shown, a later one is not taken');
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'car-tz.json'), 'utf8')).offsetMin, 120, 'kept in the app\'s folder');
    assert.strictEqual(JSON.parse(fs.readFileSync(shared, 'utf8')).offsetMin, 120, 'kept for the other apps');
    // the next start: 17:00, the car's time, before the cluster is read
    assert.strictEqual(run(dir, {}, `c.init(${JSON.stringify(dir)}); console.log(new Date(${at}).getHours() + ' ' + c.offset())`), '17 120',
        'the next start: the car\'s time from the first Date on');
    // another app with no offset of its own: the shared one
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'carclock-'));
    assert.strictEqual(run(other, {}, `c.init(${JSON.stringify(other)}); console.log(new Date(${at}).getHours())`), '17', 'the offset another app kept');
    // the cluster showing --:-- changes nothing and keeps watching
    assert.strictEqual(run(dir, {}, `c.init(${JSON.stringify(dir)}); let h, down = 0; c.start({ watch: (i, v, x) => { h = x; return Promise.resolve({ shutdown: () => { down++; } }); } });
        setImmediate(() => { h.statusShowTimeDate({ statusDisplayClockTimeDate: 2, displayHour: 9, displayMinute: 0 }); console.log(c.offset() + ' ' + down); process.exit(0); })`),
    '120 0', '--:--: the kept offset stays, the watch goes on');
    // the car's zone changed (now UTC-5): taken and kept
    assert.strictEqual(run(dir, {}, `c.init(${JSON.stringify(dir)}); ${watching(-5)} console.log(c.offset() + ' ' + down); })`), '-300 1', 'a changed zone');
    // a zone set on purpose (TZ in the environment) is left alone
    assert.strictEqual(run(dir, { TZ: 'UTC' }, `c.init(${JSON.stringify(dir)}); console.log(new Date(${at}).getHours() + ' ' + c.offset())`), '15 null',
        'TZ set on purpose: kept');
} finally {
    try { fs.unlinkSync(shared); } catch (e) { /* gone */ }
    if (sharedBefore) fs.writeFileSync(shared, sharedBefore);
}
console.log('carclock: all ok');
