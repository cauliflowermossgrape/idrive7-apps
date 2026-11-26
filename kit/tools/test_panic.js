'use strict';
// Stop all (kit/runtime/panic.js, mgu.js onPanic): one app presses it, every other app sees it within 200 ms; the
// newest press of any app wins; mgu.js hands it to the app (at once if it is on already); apps that send to the car
// stop there: Service sends no reset, Live Adjustments hands the exhaust flap back (OEM) and sends nothing else.
// No SDK or car needed:
//   node kit/tools/test_panic.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

process.env.MGU_PANIC_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'panic-'));
process.env.MGU_SAFE_OK_MS = '30';
const ROOT = path.join(__dirname, '..', '..'), KIT = path.join(ROOT, 'kit', 'runtime');
const { Panic, POLL_MS } = require(path.join(KIT, 'panic'));
const { harness } = require('./kit_harness');

let n = 0;
const ok = (c, m) => { assert(c, m); n++; console.log('ok   ' + m); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const ticks = async (k) => { for (let i = 0; i < (k || 20); i++) await new Promise((r) => setImmediate(r)); };

(async () => {
    /* ---------- the flag between apps ---------- */
    {
        const a = new Panic('blackbox'), b = new Panic('ambient_config');
        const heard = [];
        b.watch((on, by) => heard.push([on, by]));
        ok(!a.on && !b.on, 'off at first');
        a.set(true);
        await wait(POLL_MS + 80);
        ok(b.on && b.by === 'blackbox' && heard.length === 1 && heard[0][0] === true, 'one app presses Stop all, the other sees it within 200 ms');
        b.set(false);
        a.poll();
        ok(!a.on && a.by === 'ambient_config', 'the newest press of any app wins: resumed from the other one');
        a.set(true);
        const late = [];
        new Panic('service').watch((on) => late.push(on));
        ok(late[0] === true, 'an app that starts while it is on hears it at once');
        a.set(false);
        ok(fs.readdirSync(process.env.MGU_PANIC_DIR).filter((f) => /^mgu-panic-/.test(f)).length === 2, 'each app writes only its own file');
        a.close(); b.close();
    }

    /* ---------- mgu.js: bg.onPanic ---------- */
    {
        const h = harness({ id: 'writer', settings: [] });
        const calls = [];
        await h.start({ background(bg) { bg.onPanic((on, by) => calls.push([on, by])); return {}; } });
        new Panic('other').set(true);
        await wait(POLL_MS + 80);
        ok(calls.length === 1 && calls[0][0] === true && calls[0][1] === 'other', 'the kit hands Stop all from another app to the app\'s onPanic');
        new Panic('other').set(false);
        await wait(POLL_MS + 80);
        ok(calls.length === 2 && calls[1][0] === false, 'and the resume');
        new Panic('other').set(true);
        const h2 = harness({ id: 'late', settings: [] });
        const c2 = [];
        await h2.start({ background(bg) { bg.onPanic((on) => c2.push(on)); return {}; } });
        ok(c2[0] === true, 'an app started while it is on is told at registration');
        new Panic('other').set(false);
        await wait(POLL_MS + 80);
    }

    /* ---------- the apps ---------- */
    let app = null;
    const sent = [];
    let uds = null;
    const realDiag = require(path.join(KIT, 'diag'));
    class FakeDiag {
        constructor() { this.p = null; this.error = 'TASU not available'; }
        async init() { if (uds) this.p = {}; }
        async physical(target, sid, data) { sent.push([target, sid].concat(data)); return uds(target, sid, data); }
    }
    const stubs = { './kit/mgu': { run(a) { app = a; } }, './kit/diag': Object.assign({}, realDiag, { Diag: FakeDiag }) };
    const load = Module._load;
    Module._load = function (req, parent, isMain) {
        if (stubs[req]) return stubs[req];
        if (req.startsWith('./kit/')) return load.call(this, path.join(KIT, req.slice(6)), parent, isMain);
        return load.call(this, req, parent, isMain);
    };
    const { Recorder } = require(path.join(KIT, 'record'));
    const themes = require(path.join(KIT, 'themes'));
    const ctxFor = (S, extra) => {
        let frame = null, watch = null, texts = [];
        const clicks = {}, panicFns = [];
        const ctx = Object.assign({
            ui: { image: async () => {}, onClick: (nm, fn) => { clicks[nm] = fn; }, onVisible() {}, onFocus() {}, isVisible: () => true },
            settings: { get: (k) => S[k], set: (k, v) => { S[k] = v; }, onChange() {} },
            log: { info() {}, warn() {}, error() {} },
            theme: () => themes.theme('m_tricolour'), loop: (name, fps, fn) => { frame = fn; return { kick() {}, stop() {} }; },
            canvas: (w, h) => { const cv = new Recorder(w, h), text = cv.text.bind(cv); texts = []; cv.text = (s, ...a) => { texts.push(String(s)); return text(s, ...a); }; return cv; },
            signals: { watch: async (iface, inst, hd) => { watch = hd; return { iface, available: true, proxy: {}, shutdown: async () => {} }; }, call: async () => null },
            display: {}, sheet: () => false, hideButton() {}, onLayout() {}, onTab() {},
            onPanic: (fn) => panicFns.push(fn), spec: { config: {} }, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'panic-app-')),
        }, extra || {});
        return { ctx, clicks, panic: (on) => panicFns.forEach((fn) => fn(on, 'test')), feed: (f, v) => watch[f](v), render: async () => { await frame(); return texts; } };
    };

    // Service: no CBS reset while Stop all is on
    {
        const MAIN = path.join(ROOT, 'apps', 'service', 'main.js');
        const SPEC = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps', 'service', 'app.json'), 'utf8'));
        const realInterval = global.setInterval;
        global.setInterval = () => 0;
        const start = async (panicOn) => {
            delete require.cache[MAIN];
            require(MAIN);
            const S = {};
            SPEC.settings.forEach((s) => { S[s.key] = s.default; });
            Object.assign(S, { demo: 'off', resetOn: true });
            const c = ctxFor(S);
            await app.start(c.ctx);
            await ticks();
            c.feed('cbsDataServiceList', [{ cBSDataServiceListEntry: { cBSIdentifier: 3, cBSColor: 'YELLOW', cBSServiceName: 'Brake fluid', cBSServiceWay: '', cBSServiceDate: '11/2026' } }]);
            await c.render();
            if (panicOn) c.panic(true);
            return c;
        };
        uds = (target, sid, data) => (sid === 0x22 && data[0] === 0x10 && data[1] === 0x02 ? [0x62, 0x10, 0x02, 0x03, 0x00, 0x00] : [0x7F, sid, 0x31]);
        let c = await start(false);
        sent.length = 0;
        await c.clicks.BTN_RESET(); await ticks();
        ok(sent.some((r) => r[1] === 0x22 && r[2] === 0x10 && r[3] === 0x02), 'Service: without Stop all, Reset asks the cluster (control)');
        c = await start(true);
        sent.length = 0;
        await c.clicks.BTN_RESET(); await ticks();
        await c.clicks.BTN_RESET(); await ticks();
        const t = await c.render();
        ok(sent.length === 0 && t.some((x) => /Stopped by Stop all/.test(x)), 'Service: with Stop all on, Reset sends nothing and says why');
        global.setInterval = realInterval;
        uds = null;
    }

    // Live Adjustments: the flap handed back (OEM), nothing else sent
    {
        const MAIN = path.join(ROOT, 'apps', 'live_adjustments', 'main.js');
        const SPEC = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps', 'live_adjustments', 'app.json'), 'utf8'));
        delete require.cache[MAIN];
        require(MAIN);
        const S = {};
        SPEC.settings.forEach((s) => { S[s.key] = s.default; });
        const c = ctxFor(S, { spec: SPEC });
        await app.start(c.ctx);
        await ticks(50);
        await c.clicks.BTN_OPEN(); await ticks(50);
        const before = (await c.render()).join(' ');
        c.panic(true);
        await ticks(50);
        const t = (await c.render()).join(' ');
        await c.clicks.BTN_OPEN(); await ticks(50);
        const after = (await c.render()).join(' ');
        // (the flap's state as the page shows it: the simulated flap, as with no car)
        ok(/FLAP SIM OPEN\b/.test(before) && /FLAP SIM OEM\b/.test(t), 'Live Adjustments: Stop all hands the flap back to the DME (OEM)');
        ok(/FLAP SIM OEM\b/.test(after), 'Live Adjustments: Open pressed while stopped sends nothing');
        c.panic(false);
    }

    console.log('panic: ' + n + ' checks pass');
    process.exit(0);
})().catch((e) => { console.log('FAIL ' + (e && e.stack || e)); process.exit(1); });
