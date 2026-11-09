'use strict';

const assert = require('assert');
const { Bm3Protocol, markerRom, addressBytes } = require('../../apps/live_adjustments/bm3_protocol');
const bundled = require('../../apps/live_adjustments/bm3_profiles');

function fixture(command) {
    const rom = 'TEST_ROM';
    const profile = { rom, mapSwActAddr: '60000000', burbleActAddr: '60000010', wmbaCmd: command,
        liveTuneTables: { KF_DZWMIN_SPORT_SOT: { address: '60000020', factor: 2 } } };
    const memory = { '60000000': [0, 1], '60000010': [0], '60000020': Array(24).fill(0) };
    const calls = [];
    let markerEntries = 4;                              // four accumulated marker ranges
    let inflight = 0;
    const diag = { available: true, maxInflight: 0, physical: async (target, sid, data, timeout, accept) => {
        calls.push({ target, sid, data });
        diag.maxInflight = Math.max(diag.maxInflight, ++inflight);
        await new Promise(setImmediate);                // the DME answers later; others may ask meanwhile
        inflight--;
        let reply;
        if (sid === 0x2C) {
            if (data[0] === 3) {
                assert.deepStrictEqual(data, [3, 0xF3, 1]);
                markerEntries = 0;
            } else {
                assert.strictEqual(data[0], 2);
                markerEntries++;
            }
            reply = [0x6C, data[0], 0xF3, 0x01];
        } else if (sid === 0x22) {
            const payload = Buffer.alloc(255);
            payload.write('BM3_R#' + rom);
            reply = [0x62, 0xF3, 0x01].concat(Array.from(Buffer.concat(Array(markerEntries).fill(payload))));
        } else if (sid === 0x23) {
            const address = Buffer.from(data.slice(1, 5)).toString('hex').toUpperCase();
            reply = [0x63].concat(memory[address].slice(0, data[5]));
        } else if (sid === 0x3D || sid === 0x3E) {
            const address = Buffer.from(data.slice(1, 5)).toString('hex').toUpperCase();
            assert.strictEqual(data[5], data.length - 6);
            memory[address] = data.slice(6);
            reply = sid === 0x3E ? [0x7E, 0x3D] : [0x7D];
        } else if (sid === 0x2F) reply = [0x6F].concat(data.slice(0, 3));
        else if (sid === 0x2E) reply = [0x6E].concat(data.slice(0, 2));
        else throw new Error('Unexpected service ' + sid);
        assert(accept(reply));
        return reply;
    } };
    return { protocol: new Bm3Protocol(diag, { [rom]: profile }, { bm3MarkerAddress: '60000100' }), calls, memory, profile, diag };
}

function binaryMarker(token) {
    // Captured binary block with synthetic padding.
    const binary = Buffer.from('1141F2144D88227FC9D6EBF6C0CEE74104BFF6652CF4A3F310CDC33BB4EF1387D7DA9' +
        '11E2F2C0A906D91D631DE69E83FB14CF2A22CEA7161831C7D085133B3CC', 'hex');
    assert.strictEqual(binary.length, 64);
    const payload = Buffer.alloc(255, 0xFF);
    Buffer.concat([Buffer.from('BM3_'), binary, Buffer.from('~|~' + '_'.repeat(30) + '#' + token + '\0')]).copy(payload);
    return [0x62, 0xF3, 1].concat(Array.from(payload));
}

async function markerDetectionChecks() {
    const captured = binaryMarker('R4C9H5V02OKLX0');
    assert.strictEqual(markerRom(captured, bundled), 'R4C9H5V02');
    const calls = [];
    let response = captured;
    let clearReply = [0x6C, 3, 0xF3, 1];
    const p = new Bm3Protocol({ available: true, physical: async (target, sid, data) => {
        assert.strictEqual(target, 0x12);
        calls.push([sid].concat(data));
        if (sid === 0x2C) return data[0] === 3 ? clearReply : [0x6C, 2, 0xF3, 1];
        if (sid === 0x23) return [0x63, 0];
        return response;
    } }, bundled, { bm3MarkerAddress: '807FFE50' });
    assert.deepStrictEqual(await p.identify(), { rom: 'R4C9H5V02' });
    assert.strictEqual(p.profile.mapSwActAddr, '60038006');
    assert.strictEqual(p.profile.wmbaCmd, '3e');
    assert.strictEqual(await p.currentMap(), 0);
    assert.deepStrictEqual(calls, [
        [0x2C, 3, 0xF3, 1],
        [0x2C, 2, 0xF3, 1, 0x24, 0x80, 0x7F, 0xFE, 0x50, 0, 255],
        [0x22, 0xF3, 1], [0x23, 0x14, 0x60, 3, 0x80, 6, 1]
    ]);
    const damagedPrefix = captured.slice(); damagedPrefix[3] = 0;
    const damagedDelimiter = captured.slice(); damagedDelimiter[3 + 68] = 0;
    const noTerminator = captured.slice(); noTerminator[noTerminator.indexOf(0, 3 + 71)] = 0x5F;
    for (const bad of [damagedPrefix, damagedDelimiter, noTerminator,
        binaryMarker('UNKNOWN123OKLX0'), binaryMarker('R4C9H5V02'),
        binaryMarker('R4C9H5V02OKLX0EXTRA'), captured.slice(0, -1),
        [0x62, 0xF3, 1].concat(captured.slice(3), captured.slice(3), captured.slice(3), captured.slice(3)),
        [0x62, 0xF3, 1].concat(Array(255).fill(0))]) {
        response = bad;
        await assert.rejects(() => p.identify());
        assert.strictEqual(p.profile, null);
        assert.strictEqual(p.rom, null);
        const before = calls.length;
        await assert.rejects(() => p.setMap(0), /not verified/);
        assert.strictEqual(calls.length, before, 'invalid marker allowed an actuator request');
    }
    response = captured;
    for (const rejected of [[0x7F, 0x2C, 0x31], null, [0x6C, 3, 0xF3, 2]]) {
        clearReply = rejected;
        const before = calls.length;
        await assert.rejects(() => p.identify());
        assert.strictEqual(calls.length, before + 1, 'clear failure must stop before defining/reading');
        assert.deepStrictEqual(calls[before], [0x2C, 3, 0xF3, 1]);
        assert.strictEqual(p.profile, null);
    }
    clearReply = [0x6C, 3, 0xF3, 1];
    await p.identify(); // A rejected request must not stall later attempts.
    assert.strictEqual(p.rom, 'R4C9H5V02');
    assert(calls.every(call => [0x2C, 0x22, 0x23].includes(call[0])));
}

(async () => {
    for (const command of ['3d', '3e']) {
        const f = fixture(command), p = f.protocol;
        await assert.rejects(() => p.setMap(0), /not verified/);
        assert.strictEqual(f.calls.length, 0);
        await p.identify();
        assert.strictEqual(p.rom, 'TEST_ROM');
        assert.deepStrictEqual(f.calls[0].data, [3, 0xF3, 1]);
        assert.deepStrictEqual(f.calls[1].data.slice(0, 4), [2, 0xF3, 1, 0x24]);
        for (let retry = 0; retry < 3; retry++) await p.identify();
        assert.strictEqual(await p.setMap(3), 3);
        assert.deepStrictEqual(f.memory['60000000'], [3, 1]);
        const before = f.calls.length;
        for (const invalid of [-1, 4, 0.5]) await assert.rejects(() => p.setMap(invalid), /invalid map/);
        assert.strictEqual(f.calls.length, before);
        assert.strictEqual(await p.setBurbles(2.5), 2.5);
        assert.deepStrictEqual(f.memory['60000020'], Array(24).fill(0xFB));
        assert.strictEqual((await p.readBurbles()).aggression, 2.5);
        await p.setBurbles(null);
        assert.deepStrictEqual(f.memory['60000010'], [0]);
        assert.deepStrictEqual(f.memory['60000020'], Array(24).fill(0));
        for (const invalid of [-0.5, 12.5, 1.1, NaN]) await assert.rejects(() => p.setBurbles(invalid), /aggression/);
        for (const mode of ['open', 'close', 'auto']) assert.strictEqual(await p.setFlap(mode), mode);
        assert.strictEqual(await p.setAsd(false), false);
        assert.strictEqual(await p.setAsd(true), true);
        assert(f.calls.every((r) => r.target === 0x12));
        const currentMap = p.currentMap.bind(p);
        p.currentMap = async () => 0;
        await assert.rejects(() => p.setMap(2), /readback differs/);
        p.currentMap = currentMap;
        // 0x63 replies carry no address: two reads in flight would take each other's answers
        f.diag.maxInflight = 0;
        const [slot, burbles] = await Promise.all([p.currentMap(), p.readBurbles(), p.setAsd(true), p.currentMap()]);
        assert.strictEqual(slot, 2);
        assert.strictEqual(burbles.enabled, false);
        assert.strictEqual(f.diag.maxInflight, 1, 'BM3 requests overlapped');
        f.diag.available = false;
        await assert.rejects(() => p.currentMap(), /unavailable/);
        f.diag.available = true;
        assert.strictEqual(await p.currentMap(), 2);             // a failed request does not stall the next
        f.profile.wmbaCmd = '27';
        await assert.rejects(() => p.setMap(1), /unsupported/);
    }
    const invalid = fixture('3d');
    invalid.protocol.profiles = {};
    await assert.rejects(() => invalid.protocol.identify(), /not uniquely matched/);
    assert.strictEqual(invalid.protocol.profile, null);
    assert.throws(() => addressBytes('not-an-address'), /invalid/);
    assert.throws(() => markerRom([0x62, 0xF3, 1, 0], {}), /marker length/);
    await markerDetectionChecks();
    assert.strictEqual(Object.keys(bundled).length, 150);
    const relocated = ['F4C9G5705', 'F4C9G5905', 'F4C9G5F05', 'F4C9G5H05',
        'F4C9L8A05', 'F4C9L8C05', 'F4C9L8E05', 'F4C9L8G05', 'F4C9L8J05',
        'F4C9L8N05', 'F4C9L8R06', 'F4C9L8R07', 'F4C9L8Y04', 'F4C9L8Y05'];
    for (const rom of relocated) {
        const p = bundled[rom];
        assert.strictEqual(p.mapSwActAddr, '50038006', rom);
        assert.strictEqual(p.burbleActAddr, '50038099', rom);
        assert.deepStrictEqual(p.liveTuneTables.KF_DZWMIN_SPORT_SOT, { address: '50038100', factor: 2 }, rom);
        assert.strictEqual(p.wmbaCmd, '3e', rom);
    }
    assert.strictEqual(bundled.F4C9L8G06.mapSwActAddr, '60038006');
    assert.strictEqual(bundled.F4C9L8G06.burbleActAddr, '60038099');
    assert.deepStrictEqual(bundled.F4C9L8G06.liveTuneTables.KF_DZWMIN_SPORT_SOT, { address: '60038100', factor: 2 });
    assert.strictEqual(bundled.F4C9L8G06.wmbaCmd, '3e');
    for (const [rom, p] of Object.entries(bundled)) {
        assert.strictEqual(p.rom, rom);
        const legacy = Buffer.alloc(255);
        legacy.write('BM3_R#' + rom + '#');
        assert.strictEqual(markerRom([0x62, 0xF3, 1].concat(Array.from(legacy)), bundled), rom);
        assert.strictEqual(markerRom(binaryMarker(rom + 'OKLX0'), bundled), rom);
        addressBytes(p.mapSwActAddr); addressBytes(p.burbleActAddr);
        addressBytes(p.liveTuneTables.KF_DZWMIN_SPORT_SOT.address);
        assert(['3d', '3e'].includes(p.wmbaCmd));
        assert(Number.isFinite(p.liveTuneTables.KF_DZWMIN_SPORT_SOT.factor));
        assert(!('ethOverActAddr' in p) && !('baseAddr' in p));
    }
    console.log('BM3 synthetic protocol/readback checks passed; profile metadata validated.');
})().catch((e) => { console.error(e); process.exit(1); });
