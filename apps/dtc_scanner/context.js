'use strict';
/**
 * context.js - what a control unit kept about one fault, and how fast the units answer us.
 *
 * Fault context (read when a fault is opened, for that fault only, so the bus sees a few requests, not a sweep):
 *   19 03                 the unit's snapshot records: which faults have one, and their record numbers
 *   19 04 <code> <rec>    one snapshot record (what was measured when the fault was stored), one request per record
 *   19 06 <code> FF       the extended data records (counters and the like), all in one reply
 * All three are ReadDTCInformation: reads. The only requests this module makes are checked by allowed() below; a
 * clear (14) or anything else throws before it reaches the transport.
 *
 * What the bytes mean is the unit's own definition (BMW's tables, not in this repo): a record shows its identifier
 * and its bytes as the unit sent them, and a value of up to 4 bytes also as a plain number. Nothing is named by guess.
 * The status byte is standard (ISO 14229), so its bits are explained in words.
 *
 * Response times: Timing watches our own requests (diag.send) and the replies to them (diag 'frame' events): per
 * unit the time from a request to its answer, NRC 78 "pending" waits included and counted, and how many requests a
 * second we send. True bus load is not visible to apps: this is only how fast the units answer us.
 */
const { hex } = require('./kit/diag');

const SID = 0x19, MAX_RECORDS = 8;

/** Only these leave this module: ReadDTCInformation 03 / 04 / 06. Throws for anything else (a clear above all). */
function allowed(sid, data) {
    if (sid !== SID) throw new Error('fault context: service ' + hex(sid) + ' is not a read');
    const sub = data && data[0];
    if (sub !== 0x03 && sub !== 0x04 && sub !== 0x06) throw new Error('fault context: 19 ' + hex(sub || 0) + ' is not used here');
    return true;
}

const codeBytes = (code) => { const n = parseInt(code, 16); return [(n >> 16) & 0xFF, (n >> 8) & 0xFF, n & 0xFF]; };
const sameCode = (u, at, code) => { const b = codeBytes(code); return u[at] === b[0] && u[at + 1] === b[1] && u[at + 2] === b[2]; };

/** 59 03 [code(3) record(1)]...: this fault's snapshot record numbers. */
function parseIds(uds, code) {
    if (!uds || uds[0] !== 0x59 || uds[1] !== 0x03) return null;
    const out = [];
    for (let i = 2; i + 4 <= uds.length; i += 4) if (sameCode(uds, i, code)) out.push(uds[i + 3]);
    return out;
}

/**
 * 59 04 <code(3)> <status> [<record> <count> <identifier(2)> <data...>]: one record (asked for by number, so its data
 * runs to the end of the reply). With more than one identifier in it, where the first one's data ends is the unit's
 * own definition: the identifier is shown, the rest stays one block of bytes.
 */
function parseSnapshot(uds, code) {
    if (!uds || uds[0] !== 0x59 || uds[1] !== 0x04 || uds.length < 6 || !sameCode(uds, 2, code)) return null;
    const out = { status: uds[5], record: null, count: null, did: null, data: [] };
    if (uds.length >= 10) {
        out.record = uds[6]; out.count = uds[7]; out.did = (uds[8] << 8) | uds[9];
        out.data = uds.slice(10);
    }
    return out;
}

/** 59 06 <code(3)> <status> <record data...>: kept as the unit sent it (which bytes belong to which record is its own). */
function parseExtended(uds, code) {
    if (!uds || uds[0] !== 0x59 || uds[1] !== 0x06 || uds.length < 6 || !sameCode(uds, 2, code)) return null;
    return { status: uds[5], data: uds.slice(6) };
}

/** A value of 1 to 4 bytes as an unsigned number (big-endian, as UDS sends them), else null. */
function asNumber(bytes) {
    if (!bytes || !bytes.length || bytes.length > 4) return null;
    return bytes.reduce((n, b) => n * 256 + b, 0);
}

/** The status byte's eight standard bits (ISO 14229-1), in words; on = set in this fault's byte. */
const STATUS_BITS = [
    ['Failing at this moment', 'the last test of it failed'],
    ['Failed this drive', 'since the ignition was switched on'],
    ['Pending', 'failed, not yet confirmed'],
    ['Confirmed', 'stored as a fault'],
    ['Not tested since cleared', 'the unit has not checked it yet'],
    ['Failed since cleared', 'at least once since the memory was cleared'],
    ['Not tested this drive', 'not checked yet since the ignition was on'],
    ['Warning lamp asked for', 'the unit asks for a warning light'],
];
const statusBits = (b) => STATUS_BITS.map((s, i) => ({ name: s[0], words: s[1], on: !!(b & (1 << i)) }));

/**
 * Read one fault's context from its unit. diag: kit Diag (physical()); returns
 * { at, ids: [record numbers] | null, snapshots: [parseSnapshot], extended: parseExtended | null, refused: { what: nrc } }.
 */
async function readContext(diag, addr, code, opts) {
    const timeout = (opts && opts.timeoutMs) || 3000;
    const ask = (data, accept) => { allowed(SID, data); return diag.physical(addr, SID, data, timeout, accept); };
    const acc = (sub) => (u) => (u[0] === 0x59 && u[1] === sub) || (u[0] === 0x7F && u[1] === SID);
    const out = { at: Date.now(), ids: null, snapshots: [], extended: null, refused: {}, silent: [] };
    const nrcOf = (u) => (u && u[0] === 0x7F ? u[2] : null);
    const r3 = await ask([0x03], acc(0x03));
    if (!r3) out.silent.push('snapshot list');
    else if (nrcOf(r3) !== null) out.refused.snapshots = nrcOf(r3);
    else out.ids = parseIds(r3, code);
    for (const rec of (out.ids || []).slice(0, MAX_RECORDS)) {
        const r4 = await ask([0x04].concat(codeBytes(code), [rec]), (u) => (u[0] === 0x59 && u[1] === 0x04 && sameCode(u, 2, code)) || (u[0] === 0x7F && u[1] === SID));
        if (!r4) { out.silent.push('snapshot ' + rec); continue; }
        if (nrcOf(r4) !== null) { out.refused['snapshot ' + rec] = nrcOf(r4); continue; }
        const s = parseSnapshot(r4, code);
        if (s) out.snapshots.push(s);
    }
    const r6 = await ask([0x06].concat(codeBytes(code), [0xFF]), (u) => (u[0] === 0x59 && u[1] === 0x06 && sameCode(u, 2, code)) || (u[0] === 0x7F && u[1] === SID));
    if (!r6) out.silent.push('extended data');
    else if (nrcOf(r6) !== null) out.refused.extended = nrcOf(r6);
    else out.extended = parseExtended(r6, code);
    return out;
}

/**
 * Snapshots that can be drawn as a line: two or more records whose identifier and length match and whose value is a
 * number (up to 4 bytes). Returns { did, points: [[record, value]] } or null.
 */
function chartable(snapshots) {
    const by = {};
    (snapshots || []).forEach((s) => {
        const v = asNumber(s.data);
        if (s.did === null || v === null) return;
        const k = s.did + ':' + s.data.length;
        (by[k] = by[k] || { did: s.did, points: [] }).points.push([s.record, v]);
    });
    const best = Object.keys(by).map((k) => by[k]).filter((x) => x.points.length >= 2).sort((a, b) => b.points.length - a.points.length)[0];
    return best || null;
}

/* ---------------- response times ---------------- */
const OPEN_MS = 30000, WINDOW_S = 60;
class Timing {
    constructor(now) {
        this.now = now || Date.now;
        this.units = new Map();        // addr -> { n, sum, max, last, pending, at }
        this.open = [];                // our requests waiting: { t0, sid, target, done: Set }
        this.sent = [];                // when each request went (ms), the last 60 s
        this.total = 0;
    }

    /** diag.send and its 'frame' events watched (once per Diag). */
    watch(diag) {
        // (a link without the transport's send / frame events, as the tests' stand-in: nothing to time)
        if (!diag || diag._timed || typeof diag.send !== 'function' || typeof diag.on !== 'function') return diag;
        diag._timed = true;
        const send = diag.send.bind(diag);
        diag.send = (target, sid, data, opts) => { this.request(target, sid); return send(target, sid, data, opts); };
        diag.on('frame', (f) => this.frame(f.ecu, f.uds));
        return diag;
    }

    request(target, sid) {
        const t = this.now();
        this.total++;
        this.sent.push(t);
        this.trim(t);
        this.open.push({ t0: t, sid, target, done: new Set() });
    }

    frame(ecu, uds) {
        if (!uds || !uds.length) return;
        const t = this.now();
        this.trim(t);
        const sid = uds[0] === 0x7F ? uds[1] : uds[0] - 0x40;
        // the newest of our requests this frame answers (the head unit's address 0xDF: every unit answers it)
        for (let i = this.open.length - 1; i >= 0; i--) {
            const o = this.open[i];
            if (o.sid !== sid || o.done.has(ecu) || (o.target !== 0xDF && o.target !== ecu)) continue;
            const u = this.unit(ecu);
            if (uds[0] === 0x7F && uds[2] === 0x78) { u.pending++; return; }    // waiting: the time keeps running
            const ms = t - o.t0;
            u.n++; u.sum += ms; u.max = Math.max(u.max, ms); u.last = ms; u.at = t;
            o.done.add(ecu);
            if (o.target !== 0xDF) this.open.splice(i, 1);
            return;
        }
    }

    unit(ecu) {
        if (!this.units.has(ecu)) this.units.set(ecu, { n: 0, sum: 0, max: 0, last: null, pending: 0, at: 0 });
        return this.units.get(ecu);
    }

    trim(t) {
        while (this.sent.length && t - this.sent[0] > WINDOW_S * 1000) this.sent.shift();
        this.open = this.open.filter((o) => t - o.t0 < OPEN_MS);
    }

    /** Requests a second over the last 60 s: [60 counts], the newest last. */
    perSecond() {
        const t = this.now(), out = new Array(WINDOW_S).fill(0);
        this.sent.forEach((s) => { const k = WINDOW_S - 1 - Math.floor((t - s) / 1000); if (k >= 0 && k < WINDOW_S) out[k]++; });
        return out;
    }

    /** Per unit: [{ addr, n, avg, max, last, pending }], slowest average first. */
    list() {
        return Array.from(this.units.entries()).filter(([, u]) => u.n).map(([addr, u]) => ({ addr, n: u.n, avg: u.sum / u.n, max: u.max, last: u.last, pending: u.pending }))
            .sort((a, b) => b.avg - a.avg);
    }
}

/** Demo context for a demo fault (made up, shown with the DEMO badge). */
function demoContext(code) {
    const n = parseInt(code, 16) || 1;
    const base = 900 + (n % 400);
    return {
        at: Date.now(), demo: true, ids: [1, 2, 3], refused: {}, silent: [],
        snapshots: [1, 2, 3].map((rec, i) => ({ status: 0x09, record: rec, count: 1, did: 0x1700, data: [((base + i * 37) >> 8) & 0xFF, (base + i * 37) & 0xFF] })),
        extended: { status: 0x09, data: [0x01, 0x05, 0x02, 0x00, 0x2A, 0x10] },
    };
}

/** Demo response times: the units of the demo scan answering in 20 to 400 ms. */
function demoTiming(addrs) {
    const tm = new Timing();
    const t = Date.now();
    addrs.forEach((a, i) => {
        const h = ((a + 1) * 2654435761) >>> 0, avg = 18 + (h % 340) * (a === 0x12 ? 2 : 1), u = tm.unit(a);
        u.n = 3 + (i % 4); u.sum = u.n * avg; u.max = Math.round(avg * (1.3 + (h % 7) / 5)); u.last = Math.round(avg * (0.7 + (h % 5) / 10));
        u.pending = a === 0x12 ? 2 : 0; u.at = t;
    });
    for (let s = 0; s < 60; s++) { const k = s % 17 < 4 ? 6 + (s % 3) : s % 5 === 0 ? 1 : 0; for (let j = 0; j < k; j++) tm.sent.push(t - (59 - s) * 1000 + j * 50); }
    tm.total = tm.sent.length;
    return tm;
}

module.exports = { allowed, parseIds, parseSnapshot, parseExtended, asNumber, statusBits, readContext, chartable, Timing, demoContext, demoTiming, codeBytes, MAX_RECORDS };
