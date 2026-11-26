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
console.log('blackbox: ' + n + ' checks pass');
