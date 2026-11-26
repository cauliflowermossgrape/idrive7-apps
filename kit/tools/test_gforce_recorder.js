'use strict';
/* apps/gforce/recorder.js (G-Force's recordings, the former Blackbox): the last 60 s kept, an event saves them plus 15 s, a Sport stretch saves whole, the oldest go. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Recorder, PRE_MS, POST_MS, SPORT_TAIL_MS } = require(path.join(__dirname, '..', '..', 'apps', 'gforce', 'recorder.js'));

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
    const { thin } = require(path.join(__dirname, '..', '..', 'apps', 'gforce', 'recorder.js'));
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

// nothing is written before the first recording (Save the last minute is off by default; the folder too)
{
    const d = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gf-none-')), 'recordings');
    let tt = 0;
    const r0 = new Recorder({ dir: d, keep: 3, now: () => tt });
    for (let i = 0; i < 700; i++) { tt += 100; r0.sample({ speed: 50 }); }
    ok(!fs.existsSync(d), 'samples alone write nothing, not even the folder');
}

// "Recordings kept" read at each save: lowered while running, the next save removes the extra ones
{
    const d = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gf-keep-')), 'recordings');
    let tt = Date.UTC(2026, 10, 26, 10, 0, 0), keep = 5;
    const rk = new Recorder({ dir: d, keep: () => keep, now: () => tt });
    const run = (ms) => { for (let i = 0; i < ms / 100; i++) { tt += 100; rk.sample({ speed: 50 }); } };
    for (let i = 0; i < 4; i++) { rk.event('mark'); run(POST_MS + 1000); }
    ok(rk.list().length === 4, 'four kept with the setting at 5');
    keep = 2; rk.event('mark'); run(POST_MS + 1000);
    ok(rk.list().length === 2 && fs.readdirSync(d).filter((f) => /\.csv$/.test(f)).length === 2, 'setting lowered to 2: the next save keeps 2 (files too)');
    keep = undefined; ok(rk.kept() === 30, 'no setting: 30');
}

// the triggers, as background() runs them (Triggers): a fake settings store
const { Triggers, BrakeWatch, PowerWatch, STABLE_MS, POWER_GAP_MS } = require(path.join(__dirname, '..', '..', 'apps', 'gforce', 'recorder.js'));
function rig(over) {
    const S = Object.assign({ bbBrake: true, bbBrakeG: 0.7, bbPower: false, bbSport: true, bbKeep: 30, bbPeakKw: 0 }, over || {});
    const d = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gf-trig-')), 'recordings');
    const k = { t: Date.UTC(2026, 10, 26, 11, 0, 0), saved: [], S, sets: [] };
    k.rec = new Recorder({ dir: d, keep: () => S.bbKeep, now: () => k.t, onSaved: (e) => k.saved.push(e) });
    const settings = { get: (x) => S[x], set: (x, v) => { S[x] = v; k.sets.push([x, v]); } };
    k.tr = new Triggers({ rec: k.rec, settings, now: k.t });
    k.run = (ms, v) => { const out = []; for (let i = 0; i < ms / 100; i++) { k.t += 100; const o = k.tr.step(typeof v === 'function' ? v(k.t) : v, k.t); if (o.brake !== undefined || o.power !== undefined) out.push(o); } return out; };
    return k;
}

// 1. a Sport stretch ends when Sport ends, even with "Record every Sport stretch" switched off in the middle of it
{
    const k = rig();
    k.run(5000, { speed: 80, mode: 'comfort' });
    k.run(60000, { speed: 120, mode: 'sport' });
    ok(k.rec.busy() === 'sport', 'Sport chosen: a stretch is being recorded');
    k.S.bbSport = false;
    k.run(30000, { speed: 120, mode: 'sport' });
    k.run(SPORT_TAIL_MS + 500, { speed: 80, mode: 'comfort' });
    ok(k.saved.length === 1 && k.saved[0].kind === 'sport' && k.saved[0].ms < 120000, 'setting off mid-Sport: the stretch still closes when Sport ends (' + Math.round((k.saved[0] || {}).ms / 1000) + ' s)');
    k.run(60000, { speed: 120, mode: 'sport' });
    ok(!k.rec.busy(), 'with the setting off, the next Sport stretch is not started');
    // a hard stop after Sport ended is its own recording again (not just a mark in a stretch left open)
    k.S.bbSport = true;
    k.run(2000, { speed: 80, mode: 'comfort' });
    const out = k.run(300, { speed: 80, gLong: -0.9, mode: 'comfort' });
    ok(out.length === 1 && k.rec.busy() === 'brake', 'a hard stop after it: a recording of its own');
}

// 3. a hard stop needs two readings in a row: a pothole spike saves nothing
{
    const b = new BrakeWatch();
    const seq = [-0.1, -1.4, -0.1, -0.1, -1.6, 0.0];
    ok(seq.every((g) => !b.step(g, 80, 0.7)), 'single spikes of 1.4 and 1.6 g: no hard stop');
    ok(!b.step(-0.8, 80, 0.7) && b.step(-0.8, 80, 0.7), 'two readings in a row at 0.8 g: a hard stop, on the second');
    ok(!b.step(-0.9, 80, 0.7) && !b.step(-0.9, 80, 0.7), 'still braking: once per stop');
    b.step(0, 80, 0.7);
    ok(!b.step(-0.9, 20, 0.7) && !b.step(-0.9, 20, 0.7), 'at 20 km/h: none');
    const k = rig();
    k.run(1000, { speed: 80 });
    k.run(100, { speed: 80, gLong: -1.5 });
    k.run(5000, { speed: 80, gLong: 0 });
    ok(!k.rec.busy() && !k.saved.length, 'a pothole spike while driving: nothing saved');
}

// 2. full power: nothing while the peak is being learned, one bad sample does not raise it, then at most once in POWER_GAP_MS
{
    const k = rig({ bbPower: true, bbBrake: false });
    const pull = (kw, ms) => k.run(ms, { rpm: 6000, torque: kw * 9549 / 6000, speed: 100 });
    const cruise = (ms) => k.run(ms, { rpm: 2000, torque: 50, speed: 100 });
    cruise(2000);
    let fired = pull(150, 6000).length + pull(200, 6000).length + pull(250, 8000).length;
    ok(fired === 0 && !k.rec.busy(), 'learning from 0 (150, 200, 250 kW pulls): no full power recording');
    ok(Math.abs(k.tr.power.peak - 250) < 1, 'learned peak 250 kW (' + Math.round(k.tr.power.peak) + ')');
    ok(!k.sets.length, 'not saved to the settings while it still climbs');
    cruise(STABLE_MS + 1000);
    ok(k.tr.power.stable(k.t) && k.S.bbPeakKw === 250 && k.sets.length === 1, 'a minute without a new peak: stable, saved once (' + k.S.bbPeakKw + ')');
    // one bad sample of 900 kW
    k.run(100, { rpm: 6000, torque: 900 * 9549 / 6000, speed: 100 });
    cruise(1000);
    ok(Math.abs(k.tr.power.peak - 250) < 1 && k.tr.power.stable(k.t), 'one bad 900 kW sample: the peak stays 250 kW and stable');
    fired = pull(240, 3000);
    ok(fired.length === 1 && k.rec.busy() === 'power', 'a 240 kW pull once stable: one full power recording');
    cruise(POST_MS + 1000);
    fired = pull(240, 3000).length;
    cruise(60000);
    fired += pull(240, 3000).length;
    ok(fired === 0 && k.saved.filter((e) => e.kind === 'power').length === 1, 'more pulls within ' + POWER_GAP_MS / 60000 + ' min: no more recordings');
    cruise(POWER_GAP_MS);
    ok(pull(240, 3000).length === 1, 'after that: the next pull saves again');
    const p2 = new PowerWatch(5000, 0);
    ok(p2.peak === 0 && !p2.stable(100000), 'an impossible saved peak (5000 kW) is not used');
    const p3 = new PowerWatch(250, 0);
    ok(p3.stable(0), 'a peak saved earlier counts as stable at once');
    const k3 = rig({ bbPeakKw: 250 });
    ok(k3.run(3000, { rpm: 6000, torque: 240 * 9549 / 6000, speed: 100 }).length === 0, 'Save at full power off (the default): nothing');
}
console.log('gforce recorder: ' + n + ' checks pass');
