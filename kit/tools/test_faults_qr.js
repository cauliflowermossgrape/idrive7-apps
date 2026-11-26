'use strict';
// Fault Scanner > Settings > Faults as QR: the last scan as plain text in QR codes a phone camera reads as they are, cut
// into whole lines in their order; and qrlog.js plainPages on its own. No SDK or car needed:
//   node kit/tools/test_faults_qr.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const ROOT = path.resolve(__dirname, '..', '..');
const APP = path.join(ROOT, 'apps', 'dtc_scanner');
const { plainPages, SIZES } = require(path.join(ROOT, 'kit', 'runtime', 'qrlog'));
const qr = require(path.join(ROOT, 'kit', 'runtime', 'qr'));

let checks = 0, fails = 0;
const ok = (c, m) => { checks++; if (!c) { fails++; console.log('FAIL ' + m); } else console.log('ok   ' + m); };

// plainPages: header, order, every page fits its code, nothing lost
const lines = []; for (let i = 0; i < 40; i++) lines.push('LINE ' + i + ' some fault text that is long enough to need pages');
const pg = plainPages(lines.join('\n'), 'medium', 'Test 1.0');
const cap = qr.capacity(SIZES.medium.version, 'L');
ok(pg.length > 1 && pg.every((b) => b.length <= cap), 'cut into pages, each fits a medium code (' + pg.length + ')');
ok(pg[0].toString().startsWith('Test 1.0 1/' + pg.length + '\n'), 'each page starts with its header');
const back = pg.map((b) => b.toString().split('\n').slice(1)).reduce((a, b) => a.concat(b), []);
ok(back.join('\n') === lines.join('\n'), 'the lines come back whole and in order');
ok(pg.every((b) => !!qr.encode(b, { version: SIZES.medium.version, ecl: 'L' })), 'every page encodes');
ok(plainPages('', 'large', 'x').length === 1, 'empty text: one page');
const many = []; for (let i = 0; i < 400; i++) many.push('LINE ' + i + ' some fault text that is long enough to need pages');
const mp = plainPages(many.join('\n'), 'medium', 'Test 1.0'), lastLine = mp[mp.length - 1].toString().split('\n').pop();
ok(mp.length === 8 && /^\(\d+ more lines not shown\)$/.test(lastLine) && mp.every((b) => b.length <= cap), 'too long: 8 pages, the last line says how many were left out (' + lastLine + ')');

// the Fault Scanner row: the last scan's faults
let impl = null;
const load = Module._load;
Module._load = function (req, parent, isMain) {
    if (req === './kit/mgu') return { run: (i) => { impl = i; } };
    if (req.startsWith('./kit/')) return load.call(this, path.join(ROOT, 'kit', 'runtime', req.slice(6)), parent, isMain);
    return load.call(this, req, parent, isMain);
};
require(path.join(APP, 'main.js'));

(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faults-qr-'));
    fs.writeFileSync(path.join(dir, 'last_scan.json'), JSON.stringify({
        at: Date.UTC(2026, 10, 26, 7, 30), demo: false,
        ecus: [{ addr: 0x44, dtcs: [{ code: '440021', status: 0x2F, mem: 'fault' }] }, { addr: 0x12, dtcs: [] },
            { addr: 0x40, dtcs: [{ code: '804027', status: 0x08, mem: 'fault' }] }],
    }));
    const spec = JSON.parse(fs.readFileSync(path.join(APP, 'app.json'), 'utf8'));
    const def = {}; spec.settings.forEach((s) => { if (s.key) def[s.key] = s.default; });
    def.autoScan = false; def.demo = 'off';
    const noop = () => {}, rows = [];
    await impl.start({
        log: { info: noop, warn: noop, error: noop }, dataDir: dir, spec,
        settings: { get: (k) => def[k], onChange: noop },
        signals: { watch: async () => ({ shutdown: async () => {} }) },
        ui: { text: noop, image: async () => {}, onClick: noop, onVisible: noop, onFocus: noop, isVisible: () => false },
        theme: () => { throw new Error('no drawing'); }, canvas: () => { throw new Error('no drawing'); },
        hideButton: noop, onLayout: noop, onTab: noop, onScroll: noop, loop: () => ({ kick: noop }),
        settingsRow: (r) => rows.push(r),
    });
    const row = rows.find((r) => r.label === 'Faults as QR');
    ok(!!row, 'a Faults as QR row in Settings');
    const text = row.open().contents().map((b) => b.toString()).join('\n');
    ok(/^Fault Scanner 2\.\d+\.\d+ 1\/1\nScan 2026-11-26 /.test(text), 'header and the scan time: ' + text.split('\n').slice(0, 2).join(' | '));
    ok(/2 faults in 2 units, 3 units answered/.test(text), 'counts');
    ok(text.indexOf('(0x40)') < text.indexOf('(0x44)') && /\n804027 /.test(text) && /\n440021 /.test(text), 'units by address, each fault on its line');
    ok(!/[A-HJ-NPR-Z0-9]{17}/.test(text), 'no VIN-like string');
    console.log(text.split('\n').map((l) => '     | ' + l).join('\n'));
    console.log('faults qr: ' + checks + ' checks, ' + fails + ' failed');
    process.exit(fails ? 1 : 0);
})().catch((e) => { console.log('FAIL ' + (e && e.stack || e)); process.exit(1); });
