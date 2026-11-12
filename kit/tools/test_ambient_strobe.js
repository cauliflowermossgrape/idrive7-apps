'use strict';
// Ambient config's high beam strobe and light show (apps/ambient_config/strobe.js) against a fake body controller of
// each kind: which one it is (reads only), the exact requests, the first flash checked against the status, and every
// output handed back with the default session asked for, however it ends.
//   node kit/tools/test_ambient_strobe.js
const path = require('path');
const { Strobe, MAX_MS } = require(path.join(__dirname, '..', '..', 'apps', 'ambient_config', 'strobe'));

let fails = 0, checks = 0;
const ok = (c, msg) => { checks++; if (!c) { fails++; console.log('FAIL ' + msg); } };
const hex = (b) => b.map((x) => (x < 16 ? '0' : '') + x.toString(16).toUpperCase()).join(' ');

/** A BDC of kind 'bdc' (22 4500 / 2F 4501), 'g05' (22 E3B9 / 2F E3B5, the light show) or 'none'. */
function fakeBdc(kind, o) {
    const opt = o || {};
    const out = {};                    // element -> 0 / 1 as forced, undefined: the car's own (0)
    const sent = [];
    const status = (first) => { const b = new Array(first + 30).fill(0); [7, 8].forEach((el) => { b[first + el - 1] = opt.deaf ? 0 : out[el] || 0; }); return b; };
    return {
        sent,
        out,
        async send(target, sid, data) { sent.push(hex([sid].concat(data))); return { ok: true }; },
        async physical(target, sid, data) {
            sent.push(hex([sid].concat(data)));
            if (target !== 0x40) return null;
            if (sid === 0x10) return opt.noSession ? [0x7F, 0x10, 0x22] : [0x50, data[0], 0, 0x32, 0x01, 0xF4];
            if (sid === 0x22) {
                if (kind === 'bdc' && data[0] === 0x45 && data[1] === 0x00) return [0x62, 0x45, 0x00].concat(status(0));
                if (kind === 'g05' && data[0] === 0xE3 && data[1] === 0xB9) return [0x62, 0xE3, 0xB9].concat(status(1));
                return [0x7F, 0x22, 0x31];
            }
            if (sid === 0x2F) {
                const did = kind === 'bdc' ? [0x45, 0x01] : [0xE3, 0xB5];
                if (data[0] !== did[0] || data[1] !== did[1]) return [0x7F, 0x2F, 0x31];
                if (opt.refuseAfter != null && sent.filter((x) => x.indexOf('2F') === 0).length > opt.refuseAfter && data[2] === 0x03 && data[4] === 1) return [0x7F, 0x2F, 0x22];
                if (data[2] === 0x03) out[data[3]] = data[4];
                else if (data[2] === 0x00) delete out[data[3]];
                return [0x6F].concat(data.slice(0, 3));
            }
            if (sid === 0x2E) return kind === 'g05' && data[0] === 0x45 && data[1] === 0x30 ? [0x6E, 0x45, 0x30] : [0x7F, 0x2E, 0x31];
            return null;
        },
    };
}
const log = { info() {}, warn() {} };
function make(kind, o) {
    const diag = fakeBdc(kind, o);
    let t = 0;
    const s = new Strobe({ diag, log, allowed: (o && o.allowed) || (() => null), now: () => t, sleep: (ms) => new Promise((r) => { t += Math.max(ms, 1); setImmediate(r); }) });
    s._tick = (ms) => { t += ms; };
    return { s, diag };
}
const backOf = (did) => ['2F ' + did + ' 03 07 00', '2F ' + did + ' 00 07', '2F ' + did + ' 03 08 00', '2F ' + did + ' 00 08', '10 01'];
const endsWithBack = (sent, did) => JSON.stringify(sent.slice(-5)) === JSON.stringify(backOf(did));

(async () => {
    // which body controller (reads only)
    for (const [kind, want] of [['bdc', 'bdc'], ['g05', 'g05'], ['none', null]]) {
        const { s, diag } = make(kind);
        ok(await s.find() === want && diag.sent.every((x) => x.indexOf('22 ') === 0), kind + ': found as ' + want + ' with reads only (' + diag.sent.join(', ') + ')');
    }

    // not allowed: nothing written
    {
        const { s, diag } = make('bdc', { allowed: () => 'the car is moving' });
        await s.find(); diag.sent.length = 0;
        await s.start({});
        ok(diag.sent.length === 0 && /the car is moving/.test(s.note), 'not allowed: nothing sent, and why said');
    }
    // no lamp control: nothing written
    {
        const { s, diag } = make('none');
        await s.find(); diag.sent.length = 0;
        await s.start({}); await s.show({});
        ok(diag.sent.length === 0, 'a body controller without lamp control: nothing sent');
    }

    // both together on a BDC / BDC_G11: the exact requests, stopped after a few flashes
    {
        const { s, diag } = make('bdc');
        await s.find(); diag.sent.length = 0;
        const run = s.start({ pattern: 'both', rate: 'normal' });
        setImmediate(() => s.stop());
        await run;
        ok(diag.sent[0] === '10 03', 'the extended session first');
        ok(diag.sent[1] === '2F 45 01 03 07 01' && diag.sent[2] === '2F 45 01 03 08 01', 'both on: 2F 4501 03 07 01, 03 08 01 (' + diag.sent.slice(1, 3).join(', ') + ')');
        ok(diag.sent[3] === '22 45 00', 'the first flash checked against the status');
        ok(diag.sent.indexOf('2F 45 01 03 07 00') > 3, 'then off');
        ok(endsWithBack(diag.sent, '45 01'), 'stopped: both off, handed back (2F 4501 00 ..), default session (' + diag.sent.slice(-5).join(', ') + ')');
        ok(!diag.out[7] && !diag.out[8] && s.running === null, 'the high beams are the car\'s again');
    }

    // left and right in turn on a BDC_G05
    {
        const { s, diag } = make('g05');
        await s.find(); diag.sent.length = 0;
        const run = s.start({ pattern: 'alternate', rate: 'fast' });
        setImmediate(() => s.stop());
        await run;
        ok(diag.sent[1] === '2F E3 B5 03 07 01' && diag.sent[2] === '2F E3 B5 03 08 00' && diag.sent[3] === '22 E3 B9',
            'BDC_G05, in turn: left on, right off, then the status (' + diag.sent.slice(1, 4).join(', ') + ')');
        ok(endsWithBack(diag.sent, 'E3 B5'), 'BDC_G05: handed back the same way');
    }

    // the high beams do not follow: stopped at the first flash, handed back
    {
        const { s, diag } = make('bdc', { deaf: true });
        await s.find(); diag.sent.length = 0;
        await s.start({});
        ok(/did not follow/.test(s.note) && diag.sent.filter((x) => /03 0[78] 01$/.test(x)).length === 2 && endsWithBack(diag.sent, '45 01'),
            'the status says no: one flash only, then handed back (' + s.note + ')');
    }
    // a refusal mid-run
    {
        const { s, diag } = make('bdc', { refuseAfter: 4 });
        await s.find(); diag.sent.length = 0;
        await s.start({});
        ok(/refused \(NRC 22\)/.test(s.note) && endsWithBack(diag.sent, '45 01'), 'refused mid-run: stopped and handed back (' + s.note + ')');
    }
    // no session
    {
        const { s, diag } = make('bdc', { noSession: true });
        await s.find(); diag.sent.length = 0;
        await s.start({});
        ok(!diag.sent.some((x) => /03 0[78] 01$/.test(x)) && /refused the diagnostic session/.test(s.note) && endsWithBack(diag.sent, '45 01'),
            'the session refused: no flash, and handed back anyway');
    }
    // the car starts moving: stopped
    {
        let moving = false;
        const { s, diag } = make('bdc', { allowed: () => (moving ? 'the car is moving' : null) });
        await s.find(); diag.sent.length = 0;
        const run = s.start({});
        setImmediate(() => { moving = true; });
        await run;
        ok(/the car is moving/.test(s.note) && endsWithBack(diag.sent, '45 01'), 'moving: stopped and handed back');
    }
    // at most MAX_MS a press
    {
        const { s, diag } = make('bdc');
        await s.find(); diag.sent.length = 0;
        await s.start({ rate: 'slow' });
        ok(/done/.test(s.note) && endsWithBack(diag.sent, '45 01'), 'stops by itself after ' + MAX_MS / 1000 + ' s (' + s.note + ')');
        ok(diag.sent.some((x) => x === '3E 80'), 'the session kept with 3E 80 meanwhile');
    }

    // the light show: BDC_G05 runs it itself; stopped early it is ended and the session dropped
    {
        const { s, diag } = make('g05');
        await s.find(); diag.sent.length = 0;
        const run = s.show({ rate: 'normal' });
        setImmediate(() => s.stop());
        await run;
        ok(diag.sent[0] === '10 03' && diag.sent[1] === '2E 45 30 64 00 04 00 3A 98 00 00', 'light show: 2E 4530 100 % / 0 %, 100 ms, 15 s (' + diag.sent[1] + ')');
        ok(diag.sent.slice(-2).join() === '2E 45 30 00 00 04 00 00 00 00 00,10 01', 'stopped early: a zero-length show, then the default session');
    }
    {
        const { s, diag } = make('bdc');
        await s.find(); diag.sent.length = 0;
        await s.show({});
        ok(/refused \(NRC 31\)/.test(s.note) && diag.sent[diag.sent.length - 1] === '10 01', 'a BDC without the light show: refused, the session dropped');
    }

    console.log('ambient strobe: ' + checks + ' checks, ' + fails + ' failed');
    process.exit(fails ? 1 : 0);
})().catch((e) => { console.log('FAIL ' + (e && e.stack || e)); process.exit(1); });
