'use strict';

// Kit DID reader (kit/runtime/dids.js) against a stand-in diagnostics link: the value decode
// (bytes, at, factor / offset, signed, bit), the OBD form and the plausibility range. Synthetic
// replies only, no SDK or car needed:
//   node kit/tools/test_dids.js

const assert = require('assert');
const { DidReader } = require('../runtime/dids');

// A diagnostics link that answers every request with one fixed reply.
const link = (reply) => ({ physical: async () => reply });

const cases = [];
const test = (name, fn) => cases.push([name, fn]);

test('bytes from at, big-endian, then factor and offset', async () => {
    const rd = new DidReader(link([0x62, 0xF4, 0x0F, 0x01, 0x02, 0x03]), { ecu: 0x12 });
    assert.strictEqual(await rd.read({ did: 'F40F', bytes: 1, at: 0, offset: -40 }), 1 - 40);
    assert.strictEqual(await rd.read({ did: 'F40F', bytes: 2, at: 1, factor: 0.5 }), 0x0203 * 0.5);
});

test('signed: two\'s complement', async () => {
    const rd = new DidReader(link([0x62, 0xF4, 0x0F, 0xFF, 0xFE]), { ecu: 0x12 });
    assert.strictEqual(await rd.read({ did: 'F40F', bytes: 2, signed: true }), -2);
    assert.strictEqual(await rd.read({ did: 'F40F', bytes: 2 }), 0xFFFE);
});

test('bit: one bit of the value, before factor and offset', async () => {
    // 62 F4 8B, then A = 0x1F, B = 0x05
    const rd = new DidReader(link([0x62, 0xF4, 0x8B, 0x1F, 0x05]), { ecu: 0x12 });
    assert.strictEqual(await rd.read({ did: 'F48B', bytes: 1, at: 1, bit: 0 }), 1);
    assert.strictEqual(await rd.read({ did: 'F48B', bytes: 1, at: 1, bit: 1 }), 0);
    assert.strictEqual(await rd.read({ did: 'F48B', bytes: 1, at: 1, bit: 2 }), 1);
    assert.strictEqual(await rd.read({ did: 'F48B', bytes: 1, at: 1 }), 5);
    assert.strictEqual(await rd.read({ did: 'F48B', bytes: 2, at: 0, bit: 12 }), 1);    // 0x1F05: bit 12 set
    assert.strictEqual(await rd.read({ did: 'F48B', bytes: 1, at: 1, bit: 2, factor: 10, offset: 1 }), 11);
});

test('bit on an OBD PID', async () => {
    // 41 03, fuel system status A = 0x02
    const rd = new DidReader(link([0x41, 0x03, 0x02, 0x00]), { ecu: 0x12 });
    assert.strictEqual(await rd.read({ obd: '03', bytes: 1, bit: 1 }), 1);
    assert.strictEqual(await rd.read({ obd: '03', bytes: 1, bit: 0 }), 0);
});

test('outside min..max: null, with the reason kept', async () => {
    const rd = new DidReader(link([0x62, 0xF4, 0x0F, 0xFF]), { ecu: 0x12 });
    const c = { did: 'F40F', bytes: 1, max: 200 };
    assert.strictEqual(await rd.read(c), null);
    assert.strictEqual(rd.raws[rd.key(c)].why, 'out of range');
});

test('nonZero: an all-zero reply is no value; the next candidate answers (iX3 G08: DDBC zeros, E5CE)', async () => {
    const replies = { DDBC: [0x62, 0xDD, 0xBC, 0, 0, 0, 0, 0, 0], E5CE: [0x62, 0xE5, 0xCE, 0x20, 0x6E, 0x20, 0x59, 0x20, 0x81] };
    const rd = new DidReader({ physical: async (ecu, sid, req) => replies[((req[0] << 8) | req[1]).toString(16).toUpperCase()] }, { ecu: 7 });
    const ddbc = { did: 'DDBC', bytes: 2, factor: 0.1, min: 0, max: 100, nonZero: true };
    const list = [ddbc, { did: 'E5CE', bytes: 2, factor: 0.01, min: 0, max: 100, nonZero: true }];
    assert.strictEqual(await rd.value('soc', list), 83.02);
    assert.strictEqual(rd.raws[rd.key(ddbc)].why, 'all zero');
    assert.strictEqual(rd.pick.soc, 1);
    // without nonZero the zeros are a value (0 %), as before
    assert.strictEqual(await rd.read(Object.assign({}, ddbc, { nonZero: false })), 0);
});

(async () => {
    let failed = 0;
    for (const [name, fn] of cases) {
        try { await fn(); console.log('ok   ' + name); } catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + (e && e.stack || e)); }
    }
    console.log(failed ? failed + ' of ' + cases.length + ' failed' : 'DID reader checks passed (' + cases.length + ').');
    process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
