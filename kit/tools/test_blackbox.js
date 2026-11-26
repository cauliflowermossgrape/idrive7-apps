'use strict';
/* apps/blackbox/recorder.js: the last 60 s kept, an event saves them plus 15 s, a Sport stretch saves whole, the oldest go. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Recorder, PRE_MS, POST_MS, SPORT_TAIL_MS } = require(path.join(__dirname, '..', '..', 'apps', 'blackbox', 'recorder.js'));

let n = 0;
const ok = (c, m) => { assert(c, m); n++; console.log('ok   ' + m); };
const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'blackbox-')), 'blackbox');
let t = Date.UTC(2026, 10, 26, 8, 0, 0);
const saved = [];
const r = new Recorder({ dir, keep: 3, now: () => t, onSaved: (e) => saved.push(e) });
const drive = (ms, v) => { for (let i = 0; i < ms / 100; i++) { t += 100; r.sample(v); } };

drive(90000, { rpm: 2000, speed: 80, gLong: 0.1, gLat: 0, torque: 150, oil: 95, coolant: 90, mode: 'comfort' });
ok(r.event('brake'), 'a hard stop opens a recording');
ok(!r.event('mark'), 'a second event while one is open adds to it');
drive(POST_MS + 200, { rpm: 1200, speed: 20, gLong: -0.9, gLat: 0.2 });
ok(saved.length === 1 && saved[0].kind === 'brake', 'saved after its 15 s');
const lines = fs.readFileSync(path.join(dir, saved[0].file), 'utf8').trim().split('\n');
ok(lines[0] === 'time,rpm,speed,gLong,gLat,torque,oil,coolant,mode', 'CSV header');
ok(Math.abs(saved[0].ms - (PRE_MS + POST_MS)) <= 300, 'the 60 s before and 15 s after (' + saved[0].ms + ' ms)');
ok(saved[0].vmax === 80 && Math.abs(saved[0].gMax - Math.sqrt(0.81 + 0.04)) < 0.01, 'top speed and peak g in the index');
r.sport(true); drive(120000, { rpm: 5000, speed: 140, gLong: 0.3, mode: 'sport' }); r.sport(false); drive(SPORT_TAIL_MS + 200, { rpm: 2000, speed: 90 });
ok(saved.length === 2 && saved[1].kind === 'sport' && saved[1].ms >= 120000, 'a Sport stretch saved whole');
r.event('power'); drive(POST_MS + 200, {}); r.event('mark'); drive(POST_MS + 200, {});
ok(r.list().length === 3 && !fs.existsSync(path.join(dir, saved[0].file)), 'only the newest 3 kept, the oldest file removed');
const again = new Recorder({ dir, keep: 3, now: () => t });
ok(again.list().length === 3 && again.list()[0].kind === 'mark', 'the list survives a restart, newest first');

// a 20 min Sport stretch at a steady 120 km/h with two pulls: full rate around the pulls, about one a second elsewhere
{
    const { thin } = require(path.join(__dirname, '..', '..', 'apps', 'blackbox', 'recorder.js'));
    const dir2 = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'blackbox-thin-')), 'blackbox');
    let t2 = Date.UTC(2026, 10, 26, 9, 0, 0);
    const got = [];
    const r2 = new Recorder({ dir: dir2, keep: 5, now: () => t2, onSaved: (e) => got.push(e) });
    const step = (v) => { t2 += 100; r2.sample(v); };
    for (let i = 0; i < 600; i++) step({ rpm: 2500, speed: 120, gLong: 0, gLat: 0, mode: 'comfort' });
    r2.sport(true);
    const start = t2, pulls = [5 * 60000, 14 * 60000];
    for (let i = 0; i < 12000; i++) {
        const el = t2 + 100 - start, inPull = pulls.some((p) => el >= p && el < p + 4000);
        step({ rpm: inPull ? 2500 + (el % 4000) : 2500, speed: inPull ? 120 + (el % 4000) / 100 : 120, gLong: inPull ? 0.45 : 0.02, gLat: 0, mode: 'sport' });
    }
    r2.sport(false);
    for (let i = 0; i < 120; i++) step({ rpm: 2500, speed: 120, gLong: 0, gLat: 0, mode: 'comfort' });
    const e = got[0];
    ok(e && e.kind === 'sport' && e.thinned && e.rowsAll > 12000, 'a long Sport stretch is thinned (' + (e && e.rows) + ' of ' + (e && e.rowsAll) + ' rows)');
    ok(e.rows < e.rowsAll / 5, 'far fewer rows kept: ' + e.rows);
    const ts = fs.readFileSync(path.join(dir2, e.file), 'utf8').trim().split('\n').slice(1).map((l) => Date.parse(l.split(',')[0]));
    const inWin = (a, b) => ts.filter((x) => x >= a && x < b).length;
    ok(inWin(start + pulls[0], start + pulls[0] + 4000) >= 39, 'full rate during the first pull: ' + inWin(start + pulls[0], start + pulls[0] + 4000));
    ok(inWin(start + pulls[1] - 4000, start + pulls[1]) >= 39, 'full rate in the 5 s before the second pull');
    const calm = inWin(start + 9 * 60000, start + 10 * 60000);
    ok(calm >= 58 && calm <= 62, 'calm driving kept about once a second: ' + calm + ' rows in a minute');
    ok(Array.isArray(again.list()) && thin([[1, 0]], []).length === 1, 'short input stays as it is');
    console.log('thinning: ' + e.rowsAll + ' rows to ' + e.rows);
}
console.log('blackbox: ' + n + ' checks pass');
