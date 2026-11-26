'use strict';
/**
 * devreport.js - Settings > Developer report as QR (issue #239): what this car really answers, for whoever adds
 * support for it. One JSON object a line, packed into the QR log's codes (qrlog.js pages(), compressed), so
 * kit/tools/qrlog_decode.py turns the photos back into these lines.
 *
 *   {"t":"did","u":"12","id":"4035","ans":"0A1B..."} or {"t":"did","u":"12","id":"4205","nrc":"31"} or "none":true
 *                 the engine unit (0x12), each identifier Live Data's built-in catalog lists (dme_ids.js, the keys of
 *                 apps/live_data/builtin/DME8FF_R.json; kit/tools/test_dev_report.js keeps the two the same)
 *   {"t":"unit","a":"12","idx":"0F26E8","var":"DME8FF_R","name":"Engine","sw":"..."}
 *                 every unit that answered the last scan: its SGBD index and type (the scan's 22 F1 50) and, read here,
 *                 22 F1 89 (ISO 14229's ECU software version number: as hex, and as text when it is printable)
 *   {"t":"fault","a":"12","code":"123456","st":"2F","mem":"fault"}      the last scan's faults, as in Faults as QR
 *   {"t":"head","app":"Fault Scanner","ver":"2.15.0","at":"...","units":31,"dids":123,"faults":4,"demo":false}
 *                 last, so the codes always keep it (they keep the end of the text when it does not fit)
 *
 * Reads only, and only while the sheet is open (a sheet not drawn for 3 s stops the reading after the request under way):
 * every request goes through allowed(), which takes 22 alone; anything else (a clear above all) throws before it is
 * sent. Read once on request (Refresh reads nothing again, it shows how far the reading got; reading starts over when
 * the sheet is opened again after a new scan). A VIN in an answer is masked. Demo data: nothing is sent.
 */
const { hex } = require('./kit/diag');

const DME = 0x12;
let DME_IDS = [];
try { DME_IDS = require('./dme_ids'); } catch (e) { DME_IDS = []; }

/** Only 22 (ReadDataByIdentifier) leaves this module. Throws for anything else. */
function allowed(sid) {
    if (sid !== 0x22) throw new Error('developer report: service ' + hex(sid) + ' is not a read');
    return true;
}

const VIN = /[A-HJ-NPR-Z0-9]{17}/;
const toHex = (bytes) => Array.from(bytes || []).map((b) => (b < 16 ? '0' : '') + b.toString(16).toUpperCase()).join('');
const printable = (bytes) => (bytes.length && Array.from(bytes).every((b) => b >= 0x20 && b < 0x7F) ? String.fromCharCode.apply(null, bytes) : null);
/** An answer's data bytes as hex, a VIN inside them (as ASCII) masked to its first 3 and last 0 characters. */
function maskedHex(bytes) {
    const txt = Array.from(bytes).map((b) => (b >= 0x20 && b < 0x7F ? String.fromCharCode(b) : '\u0000')).join('');
    const m = VIN.exec(txt);
    if (!m) return { ans: toHex(bytes) };
    const copy = Array.from(bytes);
    for (let i = m.index + 3; i < m.index + 17; i++) copy[i] = 0x2A;      // '*'
    return { ans: toHex(copy), vin: 'masked' };
}

/** One 22 request: { ans } / { nrc } / { none: true } for that identifier. */
async function readDid(diag, addr, id) {
    const hi = (id >> 8) & 0xFF, lo = id & 0xFF;
    allowed(0x22);
    const r = await diag.physical(addr, 0x22, [hi, lo], 3000,
        (u) => (u[0] === 0x62 && u[1] === hi && u[2] === lo) || (u[0] === 0x7F && u[1] === 0x22));
    if (!r) return { none: true };
    if (r[0] === 0x7F) return { nrc: hex(r[2] || 0) };
    return maskedHex(r.slice(3));
}

/**
 * The report's reader: start(scan) reads in the background (one request at a time), lines() gives the JSON lines as far
 * as it got, progress() says where it is. o = { getDiag (resolves with the diag), ids (addr hex -> SGBD index),
 * variant(addr), name(addr), app, version, open() (true while the sheet shows), log }.
 */
class DevReport {
    constructor(o) { this.o = o; this.reset(null); }

    reset(scan) {
        this.scan = scan; this.dids = []; this.sw = {}; this.done = false; this.busy = false; this.stopped = '';
        this.at = new Date().toISOString().slice(0, 16).replace('T', ' ');
    }

    /** Read for this scan, unless it was already read for it (or is being read). */
    start(scan) {
        if (this.scan !== scan || this.stopped) this.reset(scan);
        if (this.busy || this.done || !scan) return;
        if (scan.demo) { this.done = true; return; }                  // demo data: nothing is sent
        this.busy = true;
        this.run().catch((e) => { this.stopped = String(e && e.message || e); if (this.o.log) this.o.log.warn('developer report: ' + this.stopped); })
            .then(() => { this.busy = false; });
    }

    async run() {
        const diag = await this.o.getDiag();
        if (!diag) { this.stopped = 'no diagnostic link'; return; }
        const go = () => { if (!this.o.open()) { this.stopped = 'sheet closed before the end: open it again to read the rest'; return false; } return true; };
        for (const e of this.scan.ecus) {
            if (!go()) return;
            const r = await readDid(diag, e.addr, 0xF189);
            this.sw[e.addr] = r;
        }
        if (!this.scan.ecus.some((e) => e.addr === DME)) { this.done = true; return; }
        for (const id of DME_IDS) {
            if (!go()) return;
            this.dids.push(Object.assign({ t: 'did', u: hex(DME), id }, await readDid(diag, DME, parseInt(id, 16))));
        }
        this.done = true;
    }

    progress() {
        if (!this.scan) return 'No scan yet: scan first, then open this again.';
        if (this.scan.demo) return 'Demo data: nothing was read from a car.';
        if (this.stopped) return 'Stopped: ' + this.stopped + '.';
        const hasDme = this.scan.ecus.some((e) => e.addr === DME);
        const total = this.scan.ecus.length + (hasDme ? DME_IDS.length : 0), got = Object.keys(this.sw).length + this.dids.length;
        return this.done ? 'Read: ' + this.scan.ecus.length + ' units' + (hasDme ? ', ' + DME_IDS.length + ' engine identifiers' : ', no engine unit in the scan')
            : 'Reading ' + got + ' of ' + total + ': keep this open, then Refresh.';
    }

    /** The JSON lines, head last. */
    lines() {
        const s = this.scan, out = [];
        if (!s) return [JSON.stringify({ t: 'head', app: this.o.app, ver: this.o.version, note: 'no scan yet' })];
        this.dids.forEach((d) => out.push(JSON.stringify(d)));
        s.ecus.slice().sort((a, b) => a.addr - b.addr).forEach((e) => {
            const a = hex(e.addr), sw = this.sw[e.addr], line = { t: 'unit', a, idx: this.o.ids[a] || '', var: this.o.variant(e.addr) || '', name: this.o.name(e.addr) };
            if (sw && sw.ans !== undefined) {
                line.sw = sw.ans;
                const txt = printable(Buffer.from(sw.ans, 'hex'));
                if (txt) line.swText = txt.trim();
            } else if (sw && sw.nrc) line.swNrc = sw.nrc;
            out.push(JSON.stringify(line));
        });
        let faults = 0;
        s.ecus.forEach((e) => e.dtcs.forEach((f) => { faults++; out.push(JSON.stringify({ t: 'fault', a: hex(e.addr), code: String(f.code).toUpperCase(), st: hex(f.status || 0), mem: f.mem || 'fault' })); }));
        out.push(JSON.stringify({ t: 'head', app: this.o.app, ver: this.o.version, at: this.at, scan: new Date(s.at).toISOString().slice(0, 16).replace('T', ' '),
            units: s.ecus.length, dids: this.dids.length, faults, done: this.done, demo: !!s.demo, note: this.stopped || undefined }));
        return out;
    }
}

module.exports = { DevReport, allowed, maskedHex, readDid, DME_IDS };
