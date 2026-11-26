'use strict';
// Fault Scanner > Settings > Health report as QR: faults, Check Control, 12 V charge, oil and coolant, service items and
// then the fault list, as plain text for a phone camera. The car's values come from the watches (stubbed here). No SDK
// or car needed:
//   node kit/tools/test_health_report.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const ROOT = path.resolve(__dirname, '..', '..'), KIT = path.join(ROOT, 'kit', 'runtime');
const APP = path.join(ROOT, 'apps', 'dtc_scanner');

class FakeDiag {
    constructor() { this.available = true; }
    async init() { return this; }
    async functional(sid, params) { const m = new Map(); if (params[0] === 0x02) m.set(0x12, [0x59, 0x02, 0xFF, 0x12, 0x03, 0x08, 0x2F]); return m; }
    async physical() { return null; }
}
let impl = null;
const load = Module._load;
Module._load = function (req, parent, isMain) {
    if (req === './kit/mgu') return { run: (i) => { impl = i; } };
    if (req === './kit/diag') { const real = load.call(this, path.join(KIT, 'diag'), parent, isMain); return Object.assign({}, real, { Diag: FakeDiag }); }
    if (req.startsWith('./kit/')) return load.call(this, path.join(KIT, req.slice(6)), parent, isMain);
    return load.call(this, req, parent, isMain);
};
require(path.join(APP, 'main.js'));

let checks = 0, fails = 0;
const ok = (c, m) => { checks++; if (!c) { fails++; console.log('FAIL ' + m); } else console.log('ok   ' + m); };
const tick = (ms) => new Promise((r) => setTimeout(r, ms || 20));

(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'health-'));
    const spec = JSON.parse(fs.readFileSync(path.join(APP, 'app.json'), 'utf8'));
    const S = {}; spec.settings.forEach((s) => { if (s.key) S[s.key] = s.default; }); S.autoScan = false; S.demo = 'off';
    const noop = () => {}, rows = [], clicks = {}, vis = [], handlers = {}, watchers = {};
    await impl.start({
        log: { info: noop, warn: noop, error: noop }, dataDir: dir, spec,
        settings: { get: (k) => S[k], onChange: noop },
        // (several watches of one interface, as the head unit allows: the health report's CDS and the Plausibility tab's)
        signals: { watch: async (iface, inst, h) => {
            const all = (watchers[iface] = watchers[iface] || []); all.push(h);
            const fan = handlers[iface] = {};
            all.forEach((x) => Object.keys(x).forEach((k) => { fan[k] = (v) => all.forEach((y) => y[k] && y[k](v)); }));
            return { shutdown: async () => {} };
        } },
        ui: { text: noop, image: async () => {}, onClick: (b, fn) => { clicks[b] = fn; }, onVisible: (fn) => vis.push(fn), onFocus: noop, isVisible: () => true },
        theme: () => { throw new Error('no drawing'); }, canvas: () => { throw new Error('no drawing'); },
        hideButton: noop, onLayout: noop, onTab: noop, onScroll: noop, loop: () => ({ kick: noop }),
        settingsRow: (r) => rows.push(r),
    });
    const row = rows.find((r) => r.label === 'Health report as QR');
    ok(!!row, 'a Health report as QR row in Settings');
    const text = () => row.open().contents().map((b) => b.toString()).join('\n');
    let t = text();
    ok(/Faults: no scan yet/.test(t) && /12 V battery: not sent yet/.test(t) && /Service: not sent yet/.test(t), 'before anything: says what is missing');
    vis.forEach((f) => f('MAIN', true)); await tick();
    const cds = handlers['de.bmw.infotainment.vehicle.CDS'], kombi = handlers['de.bmw.infotainment.KombiInterface_2'];
    ok(!!cds && !!kombi && !!kombi.cbsDataServiceList, 'the page watches the CDS and the cluster\'s service list');
    cds.statusBattery2({ conditionBatteryChargingCondition: 78 });
    cds.statusEngineTemperature({ temperatureEngineOilDrive: 48 + 92, temperatureEngineDrive: 48 + 88 });
    kombi.cbsDataServiceList([{ cBSIdentifier: 1, cBSColor: 'GREEN', cBSServcieName: 'Engine oil', cBSServiceWay: '12 300 km', cBSServiceDate: '09/2027' },
        { cBSIdentifier: 3, cBSColor: 'YELLOW', cBSServiceName: 'Brake fluid', cBSServiceDate: '03/2027' }]);
    clicks.BTN_SCAN(); await tick(80);
    t = text();
    ok(/^Fault Scanner [\d.]+ 1\/\d+\nHealth report \d{4}-\d\d-\d\d \d\d:\d\d\n/.test(t), 'header and the date');
    ok(/Faults: 1 stored, 1 active, in 1 of 1 units/.test(t), 'the faults summed up');
    ok(/12 V battery: 78 % charged/.test(t), '12 V charge');
    ok(/Engine: oil 92 C, coolant 88 C/.test(t), 'oil and coolant');
    ok(/Service:\n  Engine oil: OK, 12 300 km, 09\/2027\n  Brake fluid: due soon, 03\/2027/.test(t), 'service items with their state, distance and date');
    ok(/\n120308 ACTIVE/.test(t), 'the fault list follows');
    console.log('health report: ' + checks + ' checks, ' + fails + ' failed');
    process.exit(fails ? 1 : 0);
})().catch((e) => { console.log('FAIL ' + (e && e.stack || e)); process.exit(1); });
