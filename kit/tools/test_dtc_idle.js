'use strict';
// Fault Scanner: nothing on the car's buses while nobody is on its page. The diagnostic link opens when the page is
// first shown, the Check Control watches (CheckControlMaster, the cluster's KombiInterface_2) and the Plausibility
// tab's watches and checks (with its setting at the default, on) run only while it shows, and a scan left half way
// skips what comes after the request under way. No SDK or car needed; Node 8 too:
//   node kit/tools/test_dtc_idle.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const ROOT = path.resolve(__dirname, '..', '..');
const APP = path.join(ROOT, 'apps', 'dtc_scanner');

let impl = null, diags = 0;
const sent = [];
let fnHold = null;                                           // a functional request held until released
class FakeDiag {
    constructor() { this.available = true; }
    async init() { diags++; return this; }
    async functional(sid, params) {
        sent.push('functional ' + sid.toString(16) + ' ' + params.join(','));
        if (fnHold) await new Promise((r) => { fnHold.push(r); });
        const m = new Map(); m.set(0x12, [0x59, 0x02, 0xFF]); return m;
    }
    async physical(a, sid, data) { sent.push('physical ' + a.toString(16) + ' ' + sid.toString(16)); return null; }
}
const load = Module._load;
Module._load = function (req, parent, isMain) {
    if (req === './kit/mgu') return { run: (i) => { impl = i; } };
    if (req === './kit/diag') { const real = load.call(this, path.join(ROOT, 'kit', 'runtime', 'diag'), parent, isMain); return Object.assign({}, real, { Diag: FakeDiag }); }
    if (req.startsWith('./kit/')) return load.call(this, path.join(ROOT, 'kit', 'runtime', req.slice(6)), parent, isMain);
    return load.call(this, req, parent, isMain);
};
require(path.join(APP, 'main.js'));

let checks = 0, fails = 0;
const ok = (c, m) => { checks++; if (!c) { fails++; console.log('FAIL ' + m); } };
const tick = (ms) => new Promise((r) => setTimeout(r, ms || 5));

(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dtc-idle-'));
    const counts = new Map(), watched = [];
    const watching = { has: (i) => (counts.get(i) || 0) > 0, get size() { return Array.from(counts.values()).filter((n) => n > 0).length; },
        total: () => Array.from(counts.values()).reduce((a, n) => a + n, 0) };
    const timers = new Set(), setI = global.setInterval, clearI = global.clearInterval;
    global.setInterval = function () { const h = setI.apply(this, arguments); timers.add(h); return h; };
    global.clearInterval = function (h) { timers.delete(h); return clearI.apply(this, arguments); };
    const vis = [], clicks = {};
    let visible = false;
    const spec = JSON.parse(fs.readFileSync(path.join(APP, 'app.json'), 'utf8'));
    const def = {}; spec.settings.forEach((s) => { if (s.key) def[s.key] = s.default; });
    def.autoScan = false; def.demo = 'off'; def.info = true;
    const noop = () => {};
    const ctx = {
        log: { info: noop, warn: noop, error: noop }, dataDir: dir,
        settings: { get: (k) => def[k], onChange: noop },
        signals: {
            watch: async (iface) => { counts.set(iface, (counts.get(iface) || 0) + 1); watched.push(iface); return { shutdown: async () => { counts.set(iface, counts.get(iface) - 1); } }; },
        },
        ui: {
            text: noop, image: async () => {}, onClick: (b, fn) => { clicks[b] = fn; }, onVisible: (fn) => vis.push(fn), onFocus: noop,
            isVisible: () => visible,
        },
        theme: () => { throw new Error('no drawing in this test'); }, canvas: () => { throw new Error('no drawing'); },
        hideButton: noop, onLayout: noop, onTab: noop, onScroll: noop, loop: () => ({ kick: noop }),
    };
    const show = async (on) => { visible = on; vis.forEach((f) => f('MAIN', on)); await tick(20); };

    await impl.start(ctx);
    await tick(20);
    ok(def.plausibility === true, 'Plausibility checks at their default: on');
    ok(watching.size === 0 && diags === 0 && sent.length === 0, 'started without its page: no watch, no diagnostic link, nothing sent');
    ok(timers.size === 0, 'started without its page: no Plausibility timer (' + timers.size + ')');

    await show(true);
    ok(watching.has('de.bmw.infotainment.KombiInterface_2') && watching.has('de.bmw.infotainment.checkcontrol.CheckControlMaster') && watching.has('de.bmw.infotainment.vehicle.CDS'), 'page shown: Check Control and the health report values watched');
    ok(diags === 1, 'page shown: the diagnostic link opened');
    const PL = ['de.bmw.infotainment.vehicle.Vehicle2', 'de.bmw.infotainment.vehicle.CDS2', 'de.bmw.infrastructure.EnvironmentalInformation'];
    ok(PL.every((i) => watching.has(i)) && timers.size === 1, 'page shown: the Plausibility watches and its timer too (' + timers.size + ')');

    await show(false);
    ok(watching.size === 0 && watching.total() === 0, 'page left: the watches shut down (the cluster\'s interface and Plausibility\'s too)');
    ok(timers.size === 0, 'page left: the Plausibility timer stopped');
    await show(true); await show(false); await show(true);
    ok(watching.size === 6 && watching.total() === 7 && timers.size === 1 && diags === 1, 'shown again: watched again (Check Control, the cluster, CDS for the health report and Plausibility, its other three), one timer, the link opened once (' + watching.size + ', ' + watching.total() + ', ' + timers.size + ', ' + diags + ')');

    // a scan, the page left during the fault memory read: no info memory, no identifying
    sent.length = 0; fnHold = [];
    clicks.BTN_SCAN();
    await tick(20);
    await show(false);
    fnHold.forEach((r) => r()); fnHold = null;
    await tick(50);
    ok(sent.length === 1 && /functional 19 2,/.test(sent[0]), 'page left mid-scan: only the request under way, no info memory, no identifying (' + sent.join(' | ') + ')');

    // and with the page showing the whole scan runs
    await show(true);
    sent.length = 0;
    clicks.BTN_SCAN();
    await tick(80);
    ok(sent.some((x) => /functional 19 23,/.test(x)) && sent.some((x) => /physical 12 22/.test(x)), 'page showing: info memory and identifying too (' + sent.join(' | ') + ')');
    await show(false);
    ok(watching.total() === 0 && timers.size === 0, 'left at the end: nothing watched, no timer');

    const rm = (p) => { try { fs.readdirSync(p).forEach((f) => rm(path.join(p, f))); fs.rmdirSync(p); } catch (e) { try { fs.unlinkSync(p); } catch (e2) { /* gone */ } } };
    rm(dir);
    console.log('dtc idle: ' + checks + ' checks, ' + fails + ' failed');
    process.exit(fails ? 1 : 0);
})().catch((e) => { console.log('FAIL ' + (e && e.stack || e)); process.exit(1); });
