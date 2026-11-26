'use strict';
/**
 * Battery Diary - the 12 V battery's voltage at every start: what it kept while the car stood (resting), how far it
 * dipped while the engine started, what the alternator gives once it runs. One entry per start, the last 60 kept,
 * with a trend: a resting voltage that keeps falling is the first sign of an aging battery, before winter finds it.
 *
 *   Today          this wake's three numbers on good / weak / low scales, and the voltage of the last 10 minutes
 *   History        resting and starting voltage over the starts, the trend, a verdict in plain words
 *   How it works   the same in words
 *
 * The voltage: read with UDS (22 F442 / OBD 01 42, the battery sensor's 402B / 5853) from the engine unit, else the
 * gearbox unit, the candidates and their scaling being eDrive's 12 V ones (config.battery.v12, copied as they are);
 * the first that answers is kept (starts.json pick). Asked about once a second from the wake until the start's charging
 * value is in (StartLog.RUN_MS), then only while the page is open; never once the car is locked and left. The engine
 * rpm is the car's own signal (CDS statusEngineSpeed2), the charge % the car's (CDS statusBattery2).
 * Read only: nothing is written to any unit.
 */
const fs = require('fs');
const path = require('path');
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const { Diag } = require('./kit/diag');
const { DidReader } = require('./kit/dids');
const Car = require('./kit/car');
const { StartLog, RUN_MS } = require('./startlog');
const { draw } = require('./view');

const W = 1600, H = 520, TABS = ['Today', 'History', 'How it works'];
const FAST_MS = 1000, SHOWN_MS = 4000, VOLT_TIMEOUT_MS = 1500, REST_WINDOW_MS = 15 * 60000;
const DIAG_OPTS = { retryBaseMs: 150, pendingTimeoutMs: 1500, callTimeoutMs: 2000 };

/* With the car (autostart): the readings and the diary, with or without the screen. */
function background(bg) {
    const { log } = bg;
    const FILE = path.join(bg.dataDir, 'starts.json');
    let st = {};
    try { st = JSON.parse(fs.readFileSync(FILE, 'utf8')) || {}; } catch (e) { /* first start */ }
    const save = () => { try { fs.writeFileSync(FILE, JSON.stringify({ entries: L.entries, pick: st.pick })); } catch (e) { log.warn('save: ' + e); } };
    const L = new StartLog({ entries: st.entries, onEntry: (e) => { log.info('battery diary: start ' + JSON.stringify(e)); save(); } });
    const live = { v: null, t: 0, soc: null, rpm: null, seen: false, left: false, every: null, shownT: 0, source: null };
    const wakeT = Date.now();
    const cands = ((bg.spec.config && bg.spec.config.battery && bg.spec.config.battery.v12) || [])
        .map((c) => Object.assign({ timeoutMs: VOLT_TIMEOUT_MS, diagOpts: DIAG_OPTS }, c));
    const watch = (iface, h) => (bg.signals && bg.signals.watch ? Promise.resolve(bg.signals.watch(iface, '1', h, log)).catch((e) => log.warn(iface + ': ' + (e && e.message || e))) : null);
    watch('de.bmw.infotainment.vehicle.CDS', {
        statusEngineSpeed2: (x) => {
            const raw = x && x.actualValueRPMEngineCrankshaft;
            if (typeof raw !== 'number' || raw === 65535) return;
            live.rpm = raw * 0.25; live.seen = true; L.rpm(live.rpm, Date.now());
        },
        statusBattery2: (x) => { const s = x && x.conditionBatteryChargingCondition; if (typeof s === 'number' && s <= 100) live.soc = s; },
    });
    watch('de.bmw.infrastructure.VehicleCondition', {
        VehicleCondition: (v) => { const n = Car.conditionOf(v && v.statusConditionVehicle); if (n !== undefined) live.left = n <= 3; },
    });

    let diag = null, reader = null, stopped = false, lastReadT = 0;
    if (cands.length && bg.signals) {
        diag = new Diag(bg.signals, log);
        diag.quiet = true;
        diag.init();
        reader = new DidReader(diag, { ecu: 18 });
    }
    /** One voltage: the source that answered last first, then the others in order. */
    async function readVolt() {
        const order = cands.map((c, i) => i);
        if (Number.isInteger(st.pick) && cands[st.pick]) { order.splice(order.indexOf(st.pick), 1); order.unshift(st.pick); }
        for (const i of order) {
            const v = await reader.read(cands[i]);
            if (v !== null) {
                if (st.pick !== i) { st.pick = i; log.info('battery diary: 12 V from ' + reader.key(cands[i])); save(); }
                live.source = reader.key(cands[i]);
                return v;
            }
            if (i === st.pick) return null;          // the known source missed once: no search over the others yet
        }
        return null;
    }
    // asked once a second from the wake until this start's charging value is in, then only with the page open
    const wanted = () => {
        if (live.left) return false;
        const ph = L.phase(), now = Date.now();
        if (now - live.shownT < SHOWN_MS) return true;
        if (ph === 'rest') return now - wakeT < REST_WINDOW_MS;
        return ph === 'crank' || ph === 'run';
    };
    async function tick() {
        if (stopped) return;
        let wait = FAST_MS;
        try {
            if (reader && diag.available && wanted()) {
                const v = await readVolt(), now = Date.now();
                if (v !== null) {
                    if (lastReadT) live.every = live.every === null ? now - lastReadT : live.every * 0.8 + (now - lastReadT) * 0.2;
                    lastReadT = now; live.v = v; live.t = now; L.volt(v, now);
                } else wait = 3000;
            } else if (!wanted()) wait = 2000;
        } catch (e) { log.warn('battery diary: ' + (e && e.message || e)); wait = 3000; }
        setTimeout(tick, wait);
    }
    setTimeout(tick, 500);
    process.on('exit', () => { L.finish(); });
    return { L, live, available: () => !!(reader && diag.available), stop() { stopped = true; L.finish(); } };
}

/* Demo (no car, or Settings > Demo data): sixty made-up starts over four months, slowly weakening, and a made-up wake. */
function demoEntries(now) {
    const out = [];
    for (let i = 0; i < 60; i++) {
        const k = i / 59, cold = Math.max(0, Math.sin(i / 9)) * 0.12;
        out.push({ at: now - (60 - i) * 2 * 86400000 + 7.5 * 3600000, rest: 12.66 - 0.2 * k - cold * 0.6 + 0.03 * Math.sin(i * 1.7),
            crank: 10.55 - 0.45 * k - cold + 0.08 * Math.sin(i * 2.3), crankN: 6, run: 13.9 + 0.5 * Math.sin(i * 0.8) });
    }
    return out;
}
function demoWake(now) {
    const t0 = now - 8 * 60000, start = t0 + 70000, trace = [];
    for (let t = t0; t <= now; t += 1000) {
        const s = (t - start) / 1000;
        const v = s < 0 ? 12.46 + 0.01 * Math.sin(t / 7000) : s < 2 ? 10.25 + 0.6 * s : s < 120 ? 14.6 - 0.3 * (s / 120) : (Math.floor(s / 40) % 3 === 2 ? 12.75 : 14.25) + 0.03 * Math.sin(t / 3000);
        trace.push({ t, v });
    }
    const runs = trace.filter((q) => q.t - start > 60000).map((q) => q.v);
    return { trace, startAt: start, cur: { rest: 12.46, crank: 10.25, crankN: 7, runs, at: start }, v: trace[trace.length - 1].v };
}

mgu.run({
    background,
    async start(ctx) {
        const { ui, settings, log } = ctx;
        const bgd = ctx.background && ctx.background.L ? ctx.background : background(ctx);
        let page = 0;
        const demoOn = () => settings.get('demo') === 'on' || (settings.get('demo') !== 'off' && !bgd.live.seen && !bgd.live.source);
        if (ctx.onTab) ctx.onTab((i) => { page = i; return render(); });
        function render() {
            const t = ctx.theme(), cv = ctx.canvas(W, H).clear(t.bg), now = Date.now(), demo = demoOn();
            bgd.live.shownT = now;
            let s;
            if (demo) {
                const w = demoWake(now);
                s = { live: { v: w.v, soc: 81 }, phase: 'run', cur: w.cur, trace: w.trace, startAt: w.startAt, entries: demoEntries(now), source: null, now };
            } else {
                const L = bgd.L;
                s = { live: bgd.live, phase: L.phase(), cur: L.current(), trace: L.trace, startAt: L.startAt, entries: L.entries, source: bgd.live.source, now };
            }
            draw(cv, t, page, s);
            G.frame(cv, t, TABS, page, [demo && { text: 'DEMO' }]);
            return ui.image('MAIN_GFX', cv);
        }
        ctx.loop('MAIN', 2, render);
        render().then(() => log.info('first frame done')).catch((e) => log.warn('first render: ' + e));
    },
});

module.exports = { demoEntries, demoWake, RUN_MS };
