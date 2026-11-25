'use strict';
// kit/signals: a watch's re-read (opts.pollMs) stops when the watch is shut down (it went on asking a proxy that was
// shut down; the Fault Scanner and Service now shut their cluster watches when their page is left). No SDK, fake
// native module; Node 8 too:
//   node kit/tools/test_signals_poll.js
const path = require('path');
const Module = require('module');
let gets = 0, shut = 0;
const fake = {
    buildProxy: async () => ({
        init: async () => {}, subscribeToAvailability: (fn) => fn(true), subscribe: () => {}, isAvailable: () => true,
        getValue: async () => { gets++; return {}; }, shutdown: () => { shut++; },
    }),
};
// the interface's config, as build.py puts it next to the app (a made-up interface: one field with a getter)
const fs = require('fs');
const readFile = fs.readFileSync;
fs.readFileSync = function (f) {
    if (/de_test_Poll\.json$/.test(String(f))) return JSON.stringify({ fields: { value: { getter: true } } });
    return readFile.apply(this, arguments);
};
const load = Module._load;
Module._load = function (req, parent, isMain) { return req === 'someip' ? fake : load.call(this, req, parent, isMain); };
const signals = require(path.join(__dirname, '..', 'runtime', 'signals'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log('FAIL ' + m); } };
(async () => {
    const w = await signals.watch('de.test.Poll', '1', { value: () => {} }, null, { pollMs: 20 });
    ok(!w.error, 'watched (' + w.error + ')');
    await sleep(120);
    const before = gets;
    ok(before >= 3, 'polled while watched (' + before + ')');
    await w.shutdown();
    await sleep(20); const at = gets;
    await sleep(150);
    ok(gets === at && shut === 1, 'shut down: no more reads (' + at + ' -> ' + gets + '), the proxy shut down (' + shut + ')');
    console.log('signals poll: ' + (fails ? fails + ' FAILED' : 'ok'));
    process.exit(fails ? 1 : 0);
})().catch((e) => { console.log('FAIL ' + (e && e.stack || e)); process.exit(1); });
