'use strict';
/* kit/runtime/drivelog.js: each drive's lowest and highest values, start-stop stays one drive, kept over a restart, CSV. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DriveLog, OFF_MS, ROW_MS } = require(path.join(__dirname, '..', 'runtime', 'drivelog.js'));

let n = 0;
const ok = (c, m) => { assert(c, m); n++; console.log('ok   ' + m); };
const store = {};
const settings = { get: (k) => store[k], set: (k, v) => { store[k] = JSON.parse(JSON.stringify(v)); } };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drivelog-'));
let t = Date.UTC(2026, 10, 26, 8, 0, 0), csv = false;
const mk = () => new DriveLog({ settings, channels: ['oil', 'coolant'], dataDir: dir, csv: () => csv, now: () => t });
let d = mk();

d.value('oil', 14); d.rpm(0);
ok(d.drives().length === 0, 'nothing before the engine runs');
d.rpm(800);
ok(d.drives().length === 1 && d.drives()[0].live && d.drives()[0].ch.oil.min === 14, 'a drive starts with the engine, with the oil from just before');
t += 60000; d.value('oil', 62.34); d.value('coolant', 85); d.rpm(2500);
t += 60000; d.value('oil', 104); d.value('oil', 98);
let r = d.drives()[0];
ok(r.ch.oil.min === 14 && r.ch.oil.max === 104 && r.ch.coolant.max === 85, 'lowest and highest of each channel');
t += 1000; d.rpm(0); t += 5000; d.value('oil', 200); d.rpm(900);
ok(d.drives().length === 1 && d.drives()[0].ch.oil.max === 104, 'auto start-stop: the same drive, nothing counted while stopped');
ok(store.drives[0].ch.oil.max === 104, 'kept in the settings');
t += 1000; d.rpm(0); t += OFF_MS + 1; d.rpm(900);
ok(d.drives().length === 2 && !d.drives()[1].live && d.drives()[0].live, 'stopped for longer: a new drive, the old one ended');
ok(d.drives()[1].ms >= 120000, 'the drive has its length');
d = mk();
ok(d.drives().length === 2 && !d.drives().some((x) => x.live), 'after a restart the drives are kept, none running');
csv = true; d.value('oil', 70); d.rpm(900); t += ROW_MS; d.rpm(1500);
const f = fs.readFileSync(path.join(dir, 'drives.csv'), 'utf8').trim().split('\n');
ok(f[0] === 'time,drive,oil,coolant' && f.length === 3 && /,70,$/.test(f[2]), 'CSV: a header and a row every ' + ROW_MS / 1000 + ' s');
for (let i = 0; i < 12; i++) { t += OFF_MS + 1; d.rpm(0); t += OFF_MS + 1; d.rpm(900); }
ok(d.drives().length === 10, 'the latest 10 drives');
d.reset();
ok(d.drives().length === 0 && store.drives.length === 0, 'reset');
console.log('drive log: ' + n + ' checks pass');
