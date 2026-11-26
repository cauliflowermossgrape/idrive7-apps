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

// with stats (Warm-Up's Drives tab): each drive sums itself up, its speed every 10 s, marks for before / after
const sdir = fs.mkdtempSync(path.join(os.tmpdir(), 'drivelog-stats-'));
const st2 = {};
const settings2 = { get: (k) => st2[k], set: (k, v) => { st2[k] = JSON.parse(JSON.stringify(v)); } };
const mk2 = () => new DriveLog({ settings: settings2, channels: ['oil'], dataDir: sdir, stats: true, keep: 30, warmAt: () => 80, now: () => t });
let s2 = mk2();
s2.value('oil', 20); s2.rpm(900);
for (let i = 0; i < 600; i++) {                     // 10 min at 60 km/h, 1 sample a second, the odometer counting
    t += 1000; s2.rpm(2000);
    s2.sample({ speed: 60, odo: 1000 + i / 60, gLong: i === 100 ? -0.6 : i === 101 ? -0.7 : i === 300 ? 0.3 : 0.05, gLat: i === 200 ? -0.4 : 0.1, kw: i === 300 ? 120 : 30 });
    s2.value('oil', 20 + i / 6);
}
let sr = s2.drives()[0].s;
ok(Math.abs(sr.km - 10) < 0.2 && sr.vAvg === 60 && sr.vMax === 60, 'km (under 10 km: the speed added up), average and top speed: ' + JSON.stringify(sr));
ok(sr.brakes === 1 && sr.gBrake === 0.7 && sr.gFwd === 0.3 && sr.gSide === 0.4 && sr.kwMax === 120, 'one hard stop counted once, the most g each way, the most power');
ok(sr.warm === 361, 'oil from cold to 80, timed from the engine start (1 s before the first sample): ' + sr.warm);
ok(s2.trace(s2.drives()[0].at).length === 61, 'a speed point every 10 s, 0 to 10 min: ' + s2.trace(s2.drives()[0].at).length);
ok(!st2.drives[0].x, 'only the summary is kept in the settings');
s2.mark('Service', 1010);
s2 = mk2();
ok(s2.marks().length === 1 && s2.marks()[0].label === 'Service' && s2.marks()[0].odo === 1010, 'a mark is kept over a restart');
ok(s2.trace(s2.drives()[0].at).length >= 55 && s2.drives()[0].s.km > 9, 'the summary and the speed points too (as of the last save, at most a minute old): ' + s2.trace(s2.drives()[0].at).length);
const s3 = new DriveLog({ settings: { get: () => undefined, set() {} }, channels: ['oil'], now: () => t });
s3.rpm(900); s3.sample({ speed: 50 });
ok(!s3.drives()[0].s, 'without stats nothing more is kept (as before)');
// the odometer counts whole km: a short drive takes the speed added up, a long one the odometer
const kmOf = (secs, kmh, odo0) => {
    const l = new DriveLog({ settings: { get: () => undefined, set() {} }, channels: ['oil'], stats: true, now: () => t });
    l.rpm(900);
    for (let i = 0; i < secs; i++) { t += 1000; l.rpm(2000); l.sample({ speed: kmh, odo: Math.floor(odo0 + i * kmh / 3600) }); }
    return l.drives()[0].s.km;
};
const short = kmOf(84, 60, 1000.7);              // 1.4 km, the odometer going 1000 to 1001
ok(Math.abs(short - 1.4) < 0.05, 'a 1.4 km drive is 1.4 km, not the odometer\'s 1.0: ' + short);
const long = kmOf(1800, 66, 2000.9);             // 33 km at a speed reading 10 % high: the odometer wins
ok(long === 33, 'a long drive: the odometer\'s km: ' + long);
console.log('drive log: ' + n + ' checks pass');
