'use strict';
// Redline's engine-unit gear (#209): 22 5881 from the engine unit (0x12), 1..8 a gear, else none; stale after
// 1.5 s; a unit that doesn't answer asked once a minute; nothing asked unless started. No SDK; Node 8 too:
//   node kit/tools/test_redline_dmegear.js
const path = require('path');
const Module = require('module');
const ROOT = path.resolve(__dirname, '..', '..');
const load = Module._load;
Module._load = function (req, parent, isMain) {
    if (req.startsWith('./kit/')) return load.call(this, path.join(ROOT, 'kit', 'runtime', req.slice(6)), parent, isMain);
    return load.call(this, req, parent, isMain);
};
const { DmeGear, STALE_MS } = require(path.join(ROOT, 'apps', 'redline', 'dmegear'));
let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log('FAIL ' + m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const quiet = { info() {}, warn() {} };
(async () => {
    const asked = [];
    let answer = [0x62, 0x58, 0x81, 3];
    const link = { physical: async (ecu, sid, data) => { asked.push([ecu, sid].concat(data).map((x) => x.toString(16)).join(' ')); return answer; } };
    const g = new DmeGear({ log: quiet }, () => link);
    await sleep(50);
    ok(asked.length === 0 && g.value() === null, 'not started: nothing asked, no gear');
    g.start(); await sleep(30);
    ok(asked[0] === '12 22 58 81' && g.value() === 3, 'started: 22 5881 to the engine unit, gear 3 (' + asked[0] + ', ' + g.value() + ')');
    answer = [0x62, 0x58, 0x81, 0]; await sleep(450);
    ok(g.value() === null, 'neutral (0): no gear, the guess stays');
    answer = [0x62, 0x58, 0x81, 6]; await sleep(450);
    ok(g.value() === 6, 'sixth: 6');
    g.stop(); const n = asked.length; await sleep(STALE_MS + 200);
    ok(asked.length === n && g.value() === null, 'stopped: nothing asked, the gear stale after 1.5 s');
    const h = new DmeGear({ log: quiet }, () => ({ physical: async (e, s, d) => { asked.push('x'); return [0x7F, 0x22, 0x31]; } }));
    asked.length = 0; h.start(); await sleep(1500); h.stop();
    ok(asked.length === 3 && h.value() === null, 'refused (7F 22 31): asked 3 times, then left for a minute (' + asked.length + ')');
    console.log('redline engine gear: ' + (fails ? fails + ' FAILED' : 'ok'));
    process.exit(fails ? 1 : 0);
})().catch((e) => { console.log('FAIL ' + (e && e.stack || e)); process.exit(1); });
