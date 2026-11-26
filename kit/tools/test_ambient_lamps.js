'use strict';
// Ambient config's Sequencer and Stealth (apps/ambient_config/lamps.js, from Exterior Lights, PR #254): a sequence plays
// on the body controller's light functions and gives every used one back (time 0, session left); Stealth darkens both
// FLM01 headlight units and writes their channels back; both stop at once when the gate says no (the car moving),
// Stop stops them, nothing is written while the gate says no; FLM02 headlights can't do Stealth. Against a stubbed
// diagnostic transport that records every request:
//   node kit/tools/test_ambient_lamps.js
const path = require('path');
const APP = path.join(__dirname, '..', '..', 'apps', 'ambient_config');
const { Lamps, stealthWhy, playWhy } = require(path.join(APP, 'lamps'));
const Presets = require(path.join(APP, 'presets'));

let checks = 0, fails = 0;
const ok = (c, m) => { checks++; if (!c) { fails++; console.log('FAIL ' + m); } else console.log('ok   ' + m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = (c, ms) => new Promise((res) => { const end = Date.now() + ms; const poll = () => (c() || Date.now() > end ? res() : setTimeout(poll, 20)); poll(); });

/* The body controller has its light functions (22 D542), the headlight units are FLM01 (22 D667), or FLM02 (22 D6DB). */
let sent = [];
const diag = (head) => ({
    available: true,
    async physical(target, sid, data) {
        sent.push([target, sid].concat(data));
        if (sid === 0x10) return [0x50, data[0]];
        if (sid === 0x3E) return [0x7E, 0x00];
        if (sid === 0x2E) return [0x6E, data[0], data[1]];
        if (sid === 0x31) return [0x71].concat(data.slice(0, 3));
        if (sid === 0x22 && target === 0x40 && data[0] === 0xD5 && data[1] === 0x42) return [0x62, 0xD5, 0x42, 0, 0, 0, 0, 0, 0];
        if (sid === 0x22 && (target === 0x43 || target === 0x44) && head === 'flm' && data[0] === 0xD6 && data[1] === 0x67) {
            const r = [0x62, 0xD6, 0x67];
            for (let i = 0; i < 12; i++) r.push(i < 3 ? 50 : 0, i < 3 ? 80 : 0);
            return r;
        }
        if (sid === 0x22 && (target === 0x43 || target === 0x44) && head === 'flm2' && data[0] === 0xD6 && data[1] === 0xDB) {
            const r = [0x62, 0xD6, 0xDB];
            for (let i = 0; i < 15 * 5; i++) r.push(0);
            return r;
        }
        return null;
    },
});
const writes = () => sent.filter((r) => [0x2E, 0x31].indexOf(r[1]) >= 0);
const log = { info() {}, warn() {}, error() {} };

(async () => {
    let gateNo = null;
    const allowed = () => gateNo;
    const l = new Lamps({ diag: diag('flm'), log, allowed, sleep: (ms) => sleep(Math.min(ms, 5)) });
    await l.find();
    await l.findHeads();
    ok(l.kind === 'fn' && playWhy(l) === null, 'the body controller\'s light functions found: a sequence can play (' + l.kind + ')');
    ok(l.headKind === 'flm' && stealthWhy(l) === null, 'FLM01 headlight units found: Stealth possible');
    ok(writes().length === 0, 'finding writes nothing');

    // a sequence: flashes, then every used function back at time 0 and the session left
    const p = Presets.DEFAULTS[0];
    sent = [];
    await l.play(p.beats, { beatMs: 200, loops: 1 });
    const flashes = sent.filter((r) => r[1] === 0x2E && r[2] === 0xD5 && r[3] === 0x42 && r[r.length - 1] > 0);
    const back = sent.filter((r) => r[1] === 0x2E && r[2] === 0xD5 && r[3] === 0x42 && r[r.length - 1] === 0);
    ok(flashes.length > 0 && flashes.every((r) => r[r.length - 1] <= 15), 'sequence: flashes of at most 150 ms (' + flashes.length + ')');
    ok(back.length > 0 && sent[sent.length - 1][1] === 0x10 && sent[sent.length - 1][2] === 0x01, 'sequence: the used functions back at 0, the session left');
    ok(l.running === null, 'sequence: done');

    // the gate says no: nothing written
    gateNo = 'the car standing still (sequence): no';
    sent = [];
    await l.play(p.beats, { beatMs: 200 });
    await l.stealth({ ms: 60000 });
    ok(writes().length === 0 && /not started/.test(l.note), 'the gate says no: neither starts, nothing written (' + l.note + ')');
    gateNo = null;

    // Stealth: both headlights every channel at 0, kept, then written back as they were when the car moves
    sent = [];
    const run = l.stealth({ ms: 600000 });
    await until(() => l.running === 'stealth' && sent.filter((r) => r[1] === 0x31).length >= 2, 2000);
    const dark = sent.filter((r) => r[1] === 0x31);
    ok(dark.length === 2 && l.running === 'stealth', 'Stealth: both headlight units dark (' + dark.length + ')');
    gateNo = 'the car standing still (stealth): no';
    await run;
    const restore = sent.filter((r) => r[1] === 0x31).slice(2);
    ok(restore.length === 2 && l.running === null && /Stealth stopped: the car standing still/.test(l.note), 'the car moving: Stealth stops, both written back (' + l.note + ')');
    ok(sent.filter((r) => r[1] === 0x10 && r[2] === 0x01).length >= 2, 'Stealth: the sessions left');
    gateNo = null;

    // Stop stops it too
    sent = [];
    const run2 = l.stealth({ ms: 600000 });
    await until(() => l.running === 'stealth', 2000);
    l.stop();
    await run2;
    ok(l.running === null && sent.filter((r) => r[1] === 0x31).length === 4, 'Stop: Stealth ends, the channels written back');

    // FLM02 headlights (a G20's): no Stealth
    sent = [];
    const g20 = new Lamps({ diag: diag('flm2'), log, allowed: () => null, sleep: (ms) => sleep(Math.min(ms, 5)) });
    await g20.findHeads();
    ok(g20.headKind === 'flm2' && /cannot be held dark/.test(stealthWhy(g20)), 'FLM02: Stealth not possible, says why');
    await g20.stealth({ ms: 60000 });
    ok(writes().length === 0, 'FLM02: Stealth pressed, nothing written');

    console.log('ambient lamps: ' + checks + ' checks, ' + fails + ' failed');
    process.exit(fails ? 1 : 0);
})().catch((e) => { console.log('FAIL ' + (e && e.stack || e)); process.exit(1); });
