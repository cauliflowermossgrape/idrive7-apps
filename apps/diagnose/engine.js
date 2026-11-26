'use strict';
/**
 * engine.js - Diagnose's brain, without signals or drawing: the channels and the checks fed to kit/analyse.js, each
 * anomaly's 30 s captured with what moved first, Freeze, the garage tests (step / sweep with one value held), the
 * healthy baseline and the findings in plain words. main.js feeds it 10 samples a second; view.js draws what it keeps.
 *
 *   const E = new Engine({ dir, now, demo })
 *   E.sample(values)      values = { t, rpm, speed, gLong, gLat, torque, boost, kW, oil, coolant, outside, soc12, steer, gear }
 *   E.freeze(why)         the last 30 s of every channel as an anomaly of its own, saved to a file
 *   E.testStart(o)/E.testStop()   a garage test; o = { x, y, hold, band }
 *   E.findings()          [{ text, level }] for the Mechanic page
 */
const fs = require('fs');
const path = require('path');
const { Analyser, compareTests } = require('./kit/analyse');

const isNum = (v) => typeof v === 'number' && isFinite(v);
const CAPTURE_BACK = 25000, CAPTURE_AFTER = 5000;

/* Channels: only what the car already sends to the head unit (as other apps in this repo read it). role: command =
 * what the driver or the engine asked for, result = what came of it, state = the conditions around it. */
const CHANNELS = [
    { id: 'torque', name: 'Engine torque', unit: 'Nm', role: 'command', minSpread: 8, d: 0 },
    { id: 'boost', name: 'Boost', unit: 'bar', role: 'command', minSpread: 0.03, d: 2 },
    { id: 'steer', name: 'Steering wheel', unit: 'deg', role: 'command', minSpread: 3, d: 0 },
    { id: 'gear', name: 'Gear', unit: '', role: 'command', minSpread: 0.5, d: 0 },
    { id: 'gLong', name: 'Forward g', unit: 'g', role: 'result', minSpread: 0.03, d: 2 },
    { id: 'speed', name: 'Speed', unit: 'km/h', role: 'result', minSpread: 1.5, d: 0 },
    { id: 'rpm', name: 'Engine speed', unit: 'rpm', role: 'result', minSpread: 60, d: 0 },
    { id: 'gLat', name: 'Sideways g', unit: 'g', role: 'result', minSpread: 0.03, d: 2 },
    { id: 'kW', name: 'Power', unit: 'kW', role: 'result', minSpread: 4, d: 0 },
    { id: 'oil', name: 'Engine oil', unit: '°C', role: 'state', minSpread: 1, d: 0 },
    { id: 'coolant', name: 'Coolant', unit: '°C', role: 'state', minSpread: 1, d: 0 },
    { id: 'soc12', name: '12 V charge', unit: '%', role: 'state', minSpread: 1, d: 0 },
    { id: 'outside', name: 'Outside', unit: '°C', role: 'state', minSpread: 1, d: 1 },
];
const CH = {}; CHANNELS.forEach((c) => { CH[c.id] = c; });

const band = (v, w) => String(Math.floor(v / w) * w);
/* What is compared with what: y should follow x in one condition (bucket). */
const CHECKS = [
    { id: 'pull', name: 'Torque against forward g', x: 'torque', y: 'gLong', short: 'Pull',
        bucket: (v) => (v.gear >= 1 ? 'gear ' + v.gear : null), when: (v) => v.speed > 20 && v.torque > 80, minSpread: 0.03,
        hint: 'The car pulls less (or more) than the torque the engine reports, in this gear: wheelspin, a slipping clutch or gearbox, or a torque figure that is off.',
        check: ['Wheelspin or traction control at the time', 'Gearbox: slip, adaption, oil temperature', 'Torque reported vs real: a tune, the engine unit'] },
    { id: 'ratio', name: 'Engine speed against road speed', x: 'speed', y: 'rpm', short: 'Ratio',
        bucket: (v) => (v.gear >= 1 ? 'gear ' + v.gear : null), when: (v) => v.speed > 15, minSpread: 70,
        hint: 'The engine turns faster or slower than this gear usually gives at this speed: the converter or clutch slipping, or a shift caught half way.',
        check: ['Converter lock-up, clutch slip', 'A shift in progress (ignore if it was one)'] },
    { id: 'boost', name: 'Torque against boost', x: 'torque', y: 'boost', short: 'Boost',
        bucket: (v) => (v.rpm > 1500 ? band(v.rpm, 1000) + ' rpm' : null), when: (v) => v.torque > 60, minSpread: 0.05,
        hint: 'The boost does not match the torque asked for at these revs: a boost leak, a wastegate, a sensor, or a tune that runs it differently.',
        check: ['Boost leaks (hoses, intercooler)', 'Wastegate and its actuator', 'Intake air temperature (heat soak)'] },
    { id: 'warm', name: 'Oil against coolant', x: 'coolant', y: 'oil', short: 'Temps',
        bucket: (v) => band(v.coolant, 10) + ' °C coolant', when: (v) => v.rpm > 500 && v.coolant > 0, minSpread: 2,
        hint: 'The oil is warmer or cooler than it usually is at this coolant temperature: thermostat, oil cooler, or a hard drive just before.',
        check: ['Thermostat (coolant slow to warm)', 'Oil cooler and its thermostat', 'Oil level'] },
    { id: 'steer', name: 'Steering against sideways g', x: 'turn', y: 'gLat', short: 'Steering',
        bucket: (v) => (v.speed > 30 ? band(v.speed, 30) + ' km/h' : null), when: (v) => Math.abs(v.steer) < 120, minSpread: 0.03,
        hint: 'The car turns more or less than the steering says at this speed: tyre grip or pressure, alignment, or understeer and oversteer on a slippery road.',
        check: ['Tyre pressures left against right', 'Alignment', 'Road grip at the time (wet, cold)'] },
];

class Engine {
    constructor(o) {
        this.dir = o.dir; this.demo = !!o.demo; this.log = o.log || { info() {}, warn() {} };
        this.A = new Analyser({ channels: CHANNELS, checks: CHECKS, window: 60000 });
        this.pending = []; this.caught = [];          // anomalies (and freezes) with their 30 s
        this.test = null; this.tests = []; this.healthyAt = null; this.healthy = null; this.lastT = 0;
        this.exp = {}; CHECKS.forEach((c) => { this.exp[c.id] = []; });
        if (!this.demo && this.dir) this._load();
    }

    _file(n) { return path.join(this.dir, n); }
    _load() {
        try { fs.mkdirSync(this.dir, { recursive: true }); } catch (e) { /* there */ }
        try { const s = JSON.parse(fs.readFileSync(this._file('baseline.json'), 'utf8')); this.A.restore(s.analyser); this.healthy = s.healthy || null; this.healthyAt = s.healthyAt || null; } catch (e) { /* first start */ }
        try { this.tests = JSON.parse(fs.readFileSync(this._file('tests.json'), 'utf8')); } catch (e) { this.tests = []; }
        try { this.caught = JSON.parse(fs.readFileSync(this._file('anomalies.json'), 'utf8')); } catch (e) { this.caught = []; }
    }
    save() {
        if (this.demo || !this.dir) return;
        const w = (n, o) => { try { fs.writeFileSync(this._file(n), JSON.stringify(o)); } catch (e) { this.log.warn('diagnose: ' + n + ': ' + e.message); } };
        w('baseline.json', { analyser: this.A.snapshot(), healthy: this.healthy, healthyAt: this.healthyAt });
        w('tests.json', this.tests);
        w('anomalies.json', this.caught);
    }

    sample(v) {
        const t = v.t;
        const s = Object.assign({}, v);
        if (isNum(v.steer) && isNum(v.speed)) s.turn = v.steer * v.speed * v.speed / 10000;   // what the steering asks for, at this speed
        const n0 = this.A.events.length;
        this.A.push(t, s);
        CHECKS.forEach((c) => {
            const st = this.A.state(c.id), e = this.exp[c.id];
            if (st.level !== 'off' && isNum(st.expected)) e.push([t, st.expected, st.spread]);
            while (e.length && e[0][0] < t - 60000) e.shift();
        });
        // a new anomaly: its 30 s are taken 5 s after it began (what moved first needs the time before it)
        for (let i = n0; i < this.A.events.length; i++) this.pending.push({ ev: this.A.events[i], due: this.A.events[i].t0 + CAPTURE_AFTER });
        this.pending = this.pending.filter((p) => { if (t < p.due) return true; this._capture(p.ev, t); return false; });
        if (this.test) this._testSample(s);
        this.lastT = t;
    }

    _capture(ev, now) {
        const t0 = ev.t0 - CAPTURE_BACK, t1 = Math.min(now, ev.t0 + CAPTURE_AFTER), data = {};
        CHANNELS.forEach((c) => { data[c.id] = this.A.series(c.id, t0, t1).filter((p, i) => i % 2 === 0).map((p) => [p[0] - ev.t0, Math.round(p[1] * 1000) / 1000]); });
        const movers = this.A.firstMovers(ev.t0 + 1000, CAPTURE_BACK).map((m) => ({ kind: m.kind, id: m.id, channel: m.channel, at: m.at === null ? null : m.at - ev.t0, mid: m.mid, band: m.band }));
        const ck = CHECKS.find((c) => c.id === ev.check);
        const item = { id: ev.id, check: ev.check, name: ck ? ck.name : 'Freeze', t: ev.t0, peakZ: ev.peakZ, bucket: ev.bucket, repeat: ev.repeat, times: ev.times, data, movers };
        this.caught.push(item);
        if (this.caught.length > 30) this.caught.shift();
        this.log.info('diagnose: anomaly ' + item.name + ' (' + item.bucket + ', ' + ev.peakZ.toFixed(1) + ' spreads)'
            + (movers.find((m) => m.kind === 'check' && m.at !== null) ? ', first off: ' + movers.find((m) => m.kind === 'check' && m.at !== null).id : '') + (ev.repeat ? ', repeats' : ''));
        this.save();
    }

    /** Freeze: the last 30 s as an item of its own (a moment the driver noticed, not one the app found). */
    freeze(t) {
        const ev = { id: 'F' + (this.caught.length + 1), check: 'freeze', t0: t - 1000, peakZ: 0, bucket: 'you pressed Freeze', repeat: false, times: 1 };
        this._capture(ev, t);
        const it = this.caught[this.caught.length - 1];
        it.name = 'Freeze';
        return it;
    }

    /* ---------- garage tests ---------- */
    testStart(o) {
        const hold = o.hold && o.hold !== 'none' ? { id: o.hold, start: this.A.last(o.hold), band: o.band, broke: null } : null;
        this.test = { x: o.x, y: o.y, hold, points: [], t0: this.lastT, name: 'Test ' + (this.tests.length + 1) };
    }
    _testSample(v) {
        const T = this.test, x = v[T.x], y = v[T.y];
        if (isNum(x) && isNum(y) && T.points.length < 3000) T.points.push([Math.round(x * 100) / 100, Math.round(y * 1000) / 1000]);
        if (T.hold && isNum(T.hold.start) && isNum(v[T.hold.id]) && Math.abs(v[T.hold.id] - T.hold.start) > T.hold.band && !T.hold.broke) {
            T.hold.broke = { at: v.t - T.t0, value: v[T.hold.id] };
            this.log.info('diagnose: test hold broken: ' + T.hold.id + ' ' + v[T.hold.id]);
        }
    }
    testStop() {
        const T = this.test;
        this.test = null;
        if (!T || T.points.length < 10) return null;
        T.ms = this.lastT - T.t0; T.at = Date.now();
        this.tests.push(T);
        if (this.tests.length > 10) this.tests.shift();
        this.save();
        return T;
    }
    /** The last two tests of the same input and response, compared. */
    lastTwo() {
        const l = this.tests;
        if (l.length < 2) return null;
        const b = l[l.length - 1], a = l.slice(0, -1).reverse().find((x) => x.x === b.x && x.y === b.y);
        if (!a) return null;
        return { a, b, cmp: compareTests(a, b, 8, true) };
    }

    /* ---------- healthy baseline and drift ---------- */
    saveHealthy(now) { this.healthy = this.A.healthy(); this.healthyAt = now; this.save(); }
    drift() {
        if (!this.healthy) return [];
        const typical = { pull: 250, ratio: 80, boost: 250, warm: 85, steer: 1 };
        return this.A.drift(this.healthy, typical);
    }

    /** What the Mechanic page says, most important first. */
    findings() {
        const out = [], seen = {};
        this.caught.slice().reverse().forEach((c) => {
            const key = c.check + '|' + c.bucket;
            if (c.check === 'freeze' || seen[key]) return;
            seen[key] = true;
            const ck = CHECKS.find((x) => x.id === c.check), m = c.movers && c.movers.find((x) => x.at !== null && x.kind === 'check');
            const n = this.caught.filter((x) => x.check === c.check && x.bucket === c.bucket).length;
            out.push({ level: n >= 3 ? 'crit' : 'warn', check: c.check, repeat: n >= 3,
                text: (ck ? ck.name : c.check) + ', ' + c.bucket + ': ' + (n >= 3 ? 'happened ' + n + ' times' : n === 2 ? 'happened twice' : 'happened once')
                    + (m ? '. First off its usual line: ' + CHECKS.find((x) => x.id === m.id).name.toLowerCase() : '') + '.' });
        });
        this.drift().filter((d) => Math.abs(d.spreads) >= 2).forEach((d) => {
            const ck = CHECKS.find((x) => x.id === d.check);
            out.push({ level: 'warn', check: d.check, text: ck.name + ' has moved ' + Math.abs(d.spreads).toFixed(1) + ' spreads from the healthy baseline (slow drift).' });
        });
        const lt = this.lastTwo();
        if (lt) out.push({ level: lt.cmp.verdict === 'worse' ? 'warn' : 'ok', text: lt.b.name + ' against ' + lt.a.name + ' (' + CH[lt.b.y].name.toLowerCase() + ' by ' + CH[lt.b.x].name.toLowerCase() + '): ' + lt.cmp.verdict + '.' });
        return out.sort((a, b) => (a.level === 'crit' ? 0 : a.level === 'warn' ? 1 : 2) - (b.level === 'crit' ? 0 : b.level === 'warn' ? 1 : 2));
    }

    findingsText(app) {
        const f = this.findings(), d = new Date(), two = (n) => (n < 10 ? '0' : '') + n;
        const lines = ['Diagnose ' + app + ', ' + d.getFullYear() + '-' + two(d.getMonth() + 1) + '-' + two(d.getDate()) + ' ' + two(d.getHours()) + ':' + two(d.getMinutes())];
        if (!f.length) lines.push('Nothing out of the ordinary found.');
        f.slice(0, 8).forEach((x, i) => lines.push((i + 1) + '. ' + x.text));
        lines.push('Estimates from the car\'s own signals, compared with how this car usually behaves. Not a diagnosis.');
        return lines.join('\n');
    }
}

module.exports = { Engine, CHANNELS, CHECKS, CH };
