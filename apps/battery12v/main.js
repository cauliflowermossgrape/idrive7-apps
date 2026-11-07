'use strict';
/**
 * 12V Battery - the starter battery as the engine unit (DME) sees it.
 *
 * Every BMW without a high-voltage battery manages its 12 V battery in the engine unit: the
 * intelligent battery sensor (IBS) on the minus terminal measures voltage, current and
 * temperature, and the DME's energy management keeps the state of charge, the registered
 * capacity, the battery's state of health and a short history. This app reads them with UDS
 * ReadDataByIdentifier (0x22) and OBD-II service 01 over the head unit's diagnostic link
 * (kit/diag.js), and sends nothing else:
 *
 *   - Battery page: state of charge (DME, 40AD) with the Ah left and the last five recorded, the
 *     voltage and its state, current and power (402B, where the DME gives them; else the last two
 *     minutes' voltage), outside temperature, registered capacity (40A9), state of health (59AA),
 *     the engine, this drive's REGEN / charging time (or the Ah in and out with a current)
 *   - History page: voltage and current (or the DME's state of charge) over the last hour, the
 *     DME's last five recorded states of charge and how long the battery spent in each charge band
 *
 * Some DMEs (e.g. a G20 320i's) answer 402B with all FF: the voltage then comes from the first of
 * the "volt" candidates that answers (that unit's F442, OBD 01 42, the gearbox unit's F442, 5853),
 * kept and asked first from then on.
 *
 * Brake energy regeneration: BMW's energy management lets the battery feed the car while cruising
 * (alternator resting) and charges it when the driver lifts off or brakes. The app sees the charging
 * (current, or voltage >= 13.2 V when the DME gives no current) and the deceleration (car speed
 * falling): both together are REGEN. With a low charge the DME charges all the time until it recovers.
 *
 * Every request goes through the car's gateway and keeps the car awake, so parked the reads stop
 * (IDLE_AFTER_USER after the app was opened, IDLE_AFTER_MOVE after driving): "Read now" asks again.
 *
 * Where the kit runs the screen (GPU renderer, full screen) "Read now" leaves the bar (values are read
 * on their own) and this drive's Reset is a button on the page; elsewhere the bar button reads now.
 *
 * The DIDs and scalings live in app.json "config.battery" so they can be adjusted per car.
 * When the DME gives no state of charge, it is estimated from the resting voltage.
 */
const fs = require('fs');
const path = require('path');
const mgu = require('./kit/mgu');
const { withAlpha } = require('./kit/canvas');
const G = require('./kit/gauges');
// the package's language (Korean / Russian / Chinese builds: build.py --language). Drawn text is translated by
// the kit itself; only what is put together from a number and a word here asks. Kits before it: English
const LANG = (() => { try { return require('./kit/i18n').getLanguage(); } catch (e) { return 'en'; } })();
/** "23x" (times), in the package's language. */
const times = (n) => (LANG === 'ko' ? n + '회' : LANG === 'zh-CN' ? n + '次' : LANG === 'ru' ? n + ' раз' : n + 'x');
const { Diag, hex, NRC } = require('./kit/diag');

const W = 1600, H = 520;
const GO = '#2fd27a';
const SLOW_MS = 30000;            // poll period while the screen is not shown (history keeps going)
const SOC_MS = 30000;             // state of charge: changes slowly
const CAP_MS = 30 * 60000;        // capacity: practically fixed
const RETRY_MS = 5 * 60000;       // a group that failed 3 times in a row: only every 5 minutes ...
const RETRY_VOLT_MS = 15000;      // ... the voltage (what the page is about) with no source found yet: every 15 s
const HIST_MS = 60 * 60000;       // history kept: 1 hour
const HIST_STEP = 5000;           // one history sample per 5 s at most
const SAVE_MS = 5 * 60000;        // the last state of charge reading's time: saved at most this often (flash)
const TREND_MS = 2 * 60000;       // the voltage trend in place of the current (DMEs without a current): last 2 min, every reading
const DECEL_KMH = 1.5;            // slowing down by this much ...
const DECEL_MS = 2000;            // ... within this long (and above DECEL_MIN_KMH) = decelerating
const DECEL_MIN_KMH = 8;
const REGEN_HOLD_MS = 3000;       // REGEN shows this long after the last sign of slowing down
const READ_TIMEOUT_MS = 1500;     // waiting for a unit's reply (they answer in well under 0.2 s)
const VOLT_KEEP_MS = 10000;       // a voltage reading stays on screen this long: a source that misses a reply or two doesn't blank it
const MISS_LIMIT = 3;             // misses in a row of the source that worked before the others are tried
// short waits (as eDrive 2.7): a busy unit is asked again after 150 ms, a "response pending" waits 1.5 s, the
// transport call 2 s (the kit's defaults, 1-4 s / 10 s / 8 s, are for one-off reads; old kits ignore these)
const DIAG_OPTS = { retryBaseMs: 150, pendingTimeoutMs: 1500, callTimeoutMs: 2000 };
// every diagnostic request goes through the car's gateway and keeps the car awake (and draws on the battery):
// the reads run while the car is driven (moving or engine on, and IDLE_AFTER_MOVE after), with the screen
// open also IDLE_AFTER_USER after it was opened or a button pressed. Parked longer they stop: the car can sleep
const IDLE_AFTER_MOVE = 3 * 60000;
const IDLE_AFTER_USER = 10 * 60000;
const CHARGE_V = 13.2;            // at or above: the alternator charges (without a current reading)
const LOW_SOC = 70;               // below: the DME charges all the time until the battery recovers
const BANDS = [['b0_40', '0-40'], ['b40_60', '40-60'], ['b60_70', '60-70'], ['b70_80', '70-80'], ['b80_90', '80-90'], ['b90_100', '90-100']];

/** Open-circuit voltage -> state of charge (%), resting battery at ~20 °C. */
const OCV = {
    agm: [[11.8, 0], [12.0, 10], [12.2, 25], [12.35, 40], [12.5, 55], [12.6, 70], [12.7, 85], [12.8, 95], [12.85, 100]],
    flooded: [[11.8, 0], [11.95, 10], [12.1, 25], [12.25, 40], [12.4, 60], [12.5, 75], [12.6, 90], [12.7, 100]],
};
function ocvSoc(v, type) {
    const c = OCV[type] || OCV.agm;
    if (!G.isNum(v)) return null;
    if (v <= c[0][0]) return 0;
    if (v >= c[c.length - 1][0]) return 100;
    let i = 0;
    while (v > c[i + 1][0]) i++;
    return c[i][1] + (c[i + 1][1] - c[i][1]) * (v - c[i][0]) / (c[i + 1][0] - c[i][0]);
}

/* ---------- UDS: one DID, several fields on the reply ---------- */
class Reader {
    constructor(diag, ecu) {
        this.diag = diag; this.ecu = ecu; this.raws = {}; this.pick = {};
        this.miss = {};          // group -> misses in a row of the candidate that worked last
        this.refused = {};       // candidate key -> true: the unit refused it (NRC), tried last when searching
    }

    static label(c) { return c.obd ? 'OBD ' + String(c.obd).toUpperCase() : String(c.did).toUpperCase(); }
    ecuOf(c) { return c.ecu == null ? this.ecu : c.ecu; }
    key(c) { return this.ecuOf(c) + ':' + Reader.label(c); }

    /** Decode the fields of one reply (uds = the positive reply, data from `base`). */
    static decode(uds, base, fields) {
        const out = {};
        Object.keys(fields || {}).forEach((name) => {
            const f = fields[name], at = base + (f.at || 0), n = f.bytes || 1;
            let v = null;
            if (uds.length >= at + n) {
                let raw = 0, allFF = true;
                for (let i = 0; i < n; i++) { raw = raw * 256 + uds[at + i]; if (uds[at + i] !== 0xFF) allFF = false; }
                if (!allFF) {
                    if (f.signed && raw >= Math.pow(2, 8 * n - 1)) raw -= Math.pow(2, 8 * n);
                    v = raw * (f.factor == null ? 1 : f.factor) + (f.offset || 0);
                    if ((f.min != null && v < f.min) || (f.max != null && v > f.max)) v = null;
                }
            }
            out[name] = v;
        });
        return out;
    }

    /** Read one candidate: { field: value|null } when its first field is plausible, else null (reason in raws). */
    async read(c) {
        const ecu = this.ecuOf(c), obd = c.obd ? parseInt(c.obd, 16) : null, did = obd === null ? parseInt(c.did, 16) : null;
        const r = { t: Date.now(), ok: false, bytes: '', why: '', fields: null };
        this.raws[this.key(c)] = r;
        const sid = obd === null ? 0x22 : 0x01;
        const accept = (u) => (obd === null ? u[0] === 0x62 && ((u[1] << 8) | u[2]) === did : u[0] === 0x41 && u[1] === obd) || (u[0] === 0x7F && u[1] === sid);
        let uds;
        // a unit answers in well under 0.2 s; one that doesn't answer costs this long (a "pending" reply extends it)
        try { uds = await this.diag.physical(ecu, sid, obd === null ? [did >> 8, did & 0xFF] : [obd], c.timeoutMs || READ_TIMEOUT_MS, accept, c.diagOpts || DIAG_OPTS); } catch (e) { r.why = String(e.message || e); return null; }
        if (!uds) { r.why = 'no reply'; return null; }
        r.bytes = uds.map((x) => hex(x)).join(' ');
        if (uds[0] === 0x7F) { r.why = 'NRC ' + hex(uds[2]) + (NRC[uds[2]] ? ' ' + NRC[uds[2]] : ''); this.refused[this.key(c)] = true; return null; }
        const out = Reader.decode(uds, obd === null ? 3 : 2, c.fields);
        r.fields = out;
        const first = Object.keys(c.fields || {})[0];
        if (!first || out[first] === null) { r.why = uds.length <= 3 ? 'reply too short' : 'no value (FF) / out of range'; return null; }
        r.ok = true;
        delete this.refused[this.key(c)];
        return out;
    }

    /**
     * Read a group: the candidate that worked last; while it misses only once or twice (a busy link, a
     * unit waking up) it is simply asked again next time, rather than the others being tried (each that
     * doesn't answer costs READ_TIMEOUT_MS: the value would go blank meanwhile). After MISS_LIMIT misses in a
     * row, or with none known, all are tried: those not refused first.
     */
    async group(name, list) {
        list = list || [];
        const p = this.pick[name];
        if (p != null && list[p]) {
            const v = await this.read(list[p]);
            if (v) { this.miss[name] = 0; return v; }
            this.miss[name] = (this.miss[name] || 0) + 1;
            if (this.miss[name] < MISS_LIMIT) return null;
        }
        const order = list.map((c, i) => i).filter((i) => i !== p)
            .sort((a, b) => (this.refused[this.key(list[a])] ? 1 : 0) - (this.refused[this.key(list[b])] ? 1 : 0) || a - b);
        if (p != null && list[p]) order.push(p);
        for (const i of order) {
            const v = await this.read(list[i]);
            if (v) { this.pick[name] = i; this.miss[name] = 0; return v; }
        }
        return null;
    }
}

/* ---------- demo: a short drive loop ---------- */
/**
 * Demo data: a car like the G20 320i, whose DME gives no current (the page then shows the voltage trend and
 * the DME's state of charge, as on that car). A 90 s loop: charging after the start, cruising with lift-offs
 * (REGEN), standing with the engine off. sample(at): the values at time at (default now).
 */
class Demo {
    constructor() { this.t0 = Date.now(); }
    sample(at) {
        const s = ((at || Date.now()) - this.t0) / 1000, ph = ((s % 90) + 90) % 90;
        let v, i, engine, regen = false;
        if (ph < 30) { engine = true; i = 4 + 18 * Math.exp(-ph / 8); v = 14.1 + 0.5 * Math.exp(-ph / 10); }          // charging after the start
        else if (ph < 60 && ph % 10 >= 6 && ph % 10 < 9) { engine = true; i = 16; v = 14.7; regen = true; }          // lifting off: regeneration
        else if (ph < 60) { engine = true; i = -6 - 3 * Math.sin(ph / 3); v = 12.75 + 0.05 * Math.sin(ph / 4); }     // cruising: alternator resting
        else { engine = false; i = -11 - 2 * Math.sin(ph); v = 12.45 + 0.03 * Math.sin(ph / 2); }                    // stopped, consumers on
        void i;                          // (the current a car with a battery sensor would give: not on this car)
        return {
            v, i: null, temp: 19.5, soc: 78 + 2 * Math.sin(s / 40), socHist: [77, 79, 80, 77, 75],
            bands: { b0_40: 0, b40_60: 1, b60_70: 3, b70_80: 41, b80_90: 152, b90_100: 37 }, bInvalid: 2,
            cap: 90, capNew: 90, soh: 92, engine, regen, ambient: 12,
        };
    }
}

mgu.run({
    async start(ctx) {
        const { ui, settings, log } = ctx;
        const cfg = Object.assign({ ecu: 18, currentSign: -1, ibs: [], volt: [], soc: [], cap: [] },
            (ctx.spec.config && ctx.spec.config.battery) || {});

        /* ---------- persisted: the last DME values (shown at once after a restart) ---------- */
        const STATE = path.join(ctx.dataDir, 'battery12v.json');
        let st = {};
        try { st = JSON.parse(fs.readFileSync(STATE, 'utf8')) || {}; } catch (e) { /* first run */ }
        // fewer flash writes (as eDrive 2.7.2): written when a value worth keeping changed, the reading's time
        // at most every SAVE_MS, and what changed since at MainApp's shutdown
        let savedAt = 0, saved = JSON.stringify(st);
        const save = () => { savedAt = Date.now(); saved = JSON.stringify(st); try { fs.writeFileSync(STATE, saved); } catch (e) { log.warn('save: ' + e); } };
        /** Save if more than the reading's time changed, or the last save is SAVE_MS old. */
        const saveIf = () => {
            const now = JSON.stringify(Object.assign({}, st, { socT: 0 })), was = JSON.parse(saved);
            if (now !== JSON.stringify(Object.assign({}, was, { socT: 0 })) || Date.now() - savedAt > SAVE_MS) save();
        };
        process.on('exit', () => { if (JSON.stringify(st) !== saved) save(); });

        const live = {
            v: null, vT: 0, vSrc: '', i: null, iT: 0, temp: null, tempT: 0,
            soc: null, socT: 0, socHist: st.socHist || null, bands: st.bands || null, bInvalid: st.bInvalid,
            cap: G.isNum(st.cap) ? st.cap : null, capNew: G.isNum(st.capNew) ? st.capNew : null, capT: 0,
            soh: G.isNum(st.soh) ? st.soh : null,
            rpm: null, rpmT: 0, speed: null, ambient: null,
        };
        const trip = { ahIn: 0, ahOut: 0, lastT: 0, minV: null, maxV: null, regenS: 0, regenN: 0, chargeS: 0, wasRegen: false };
        /** This drive's totals from now on (the page's Reset button). */
        const resetTrip = () => { Object.assign(trip, { ahIn: 0, ahOut: 0, lastT: 0, minV: null, maxV: null, regenS: 0, regenN: 0, chargeS: 0, wasRegen: false }); log.info('this drive: reset'); };
        const hist = [];                 // { t, v, i }
        const trend = [];                // { t, v }: every voltage reading of the last TREND_MS
        let lastFrame = 0;
        // demo (setting "auto"), as in the other apps: only while nothing from the car has arrived
        // in the first 5 s after start; once the car answered, the app stays on live data
        const startT = Date.now(), subs = [];
        let lastCar = 0;
        const seen = () => { lastCar = Date.now(); };
        const watched = (what) => (s) => { if (!s.error) subs.push(s); log.info(what + ' ' + (s.error ? 'error: ' + s.error : 'subscribed')); };
        let restSince = null;
        const REST_MS = 5 * 60000; // require five minutes of confirmed engine-off, low-current readings

        /* ---------- slowing down (lift-off / braking): speed falling by DECEL_KMH within DECEL_MS ---------- */
        const speeds = [];               // { t, v } of the last DECEL_MS
        live.decelT = 0;
        function onSpeed(kmh) {
            const now = Date.now();
            speeds.push({ t: now, v: kmh });
            while (speeds.length && now - speeds[0].t > DECEL_MS) speeds.shift();
            const top = Math.max.apply(null, speeds.map((x) => x.v));
            if (kmh >= DECEL_MIN_KMH && top - kmh >= DECEL_KMH) live.decelT = now;
        }

        /* ---------- talking to the car only while it is in use (see IDLE_AFTER_MOVE) ---------- */
        let lastUserT = Date.now(), lastActiveT = 0;
        const engineOn = () => G.isNum(live.rpm) && live.rpm > 400 && Date.now() - live.rpmT < 5000;
        const driving = () => {
            const now = Date.now();
            if ((G.isNum(live.speed) && live.speed > 1) || engineOn()) {
                if (now - lastActiveT >= IDLE_AFTER_MOVE) log.info('in use again (driving)');
                lastActiveT = now;
            }
            return now - lastActiveT < IDLE_AFTER_MOVE;
        };
        const inUse = () => driving() || Date.now() - lastUserT < IDLE_AFTER_USER;
        /** The app was opened or a button pressed: reads (again) for IDLE_AFTER_USER. */
        const touched = () => {
            const was = inUse();
            lastUserT = Date.now();
            if (!was) { log.info('in use again (user)'); clearTimeout(pollTimer); poll(true).then(schedule, schedule); }
        };

        /* ---------- car signals: engine running, speed, outside temperature ---------- */
        ctx.signals.watch('de.bmw.infotainment.vehicle.CDS', '1', {
            statusEngineSpeed2: (v) => {
                const raw = v && v.actualValueRPMEngineCrankshaft;
                // 0xFFFF (no value): the engine isn't running (ignition on, engine off)
                if (G.isNum(raw)) { live.rpm = raw === 65535 ? 0 : raw * 0.25; live.rpmT = Date.now(); seen(); }
            },
        }, log).then(watched('rpm'));
        ctx.signals.watch('de.bmw.infotainment.vehicle.Vehicle2', '1', {
            statusCarSpeed2: (v) => {
                const k = v && v.speedVehicleCentreOfGravity;
                live.speed = k === 65535 || k == null ? null : k * 0.015625;
                if (live.speed !== null) { seen(); onSpeed(live.speed); }
            },
        }, log).then(watched('speed'));
        ctx.signals.watch('de.bmw.infrastructure.EnvironmentalInformation', '1', {
            ExteriorTemperature: (v) => { const r = v && v.temperatureExterior; if (G.isNum(r) && r !== 255) { live.ambient = r * 0.5 - 40; seen(); } },
        }, log).then(watched('ambient'));

        /* ---------- diagnostic link ---------- */
        const diag = new Diag(ctx.signals, log);
        diag.quiet = true;
        diag.init();
        const reader = new Reader(diag, cfg.ecu);
        // the candidate that answered last time first (e.g. a G20 320i: the gearbox unit's F442 for the voltage)
        if (st.pick && typeof st.pick === 'object') Object.assign(reader.pick, st.pick);
        const keepPick = (name) => { if (!st.pick || st.pick[name] !== reader.pick[name]) { st.pick = Object.assign({}, reader.pick); save(); } };
        const demo = new Demo();
        const carPresent = () => lastCar > 0 || diag.available || subs.some((s) => s.available);
        const usingDemo = () => settings.get('demo') === 'on' || (settings.get('demo') === 'auto' && !carPresent() && Date.now() - startT > 5000);

        // one request at a time on the link; reads queue up
        const queue = [];
        let pumping = false;
        async function pump() {
            if (pumping) return;
            pumping = true;
            while (queue.length) {
                const j = queue.shift();
                try { j.res(await j.fn()); } catch (e) { j.rej(e); }
            }
            pumping = false;
        }
        const exclusive = (fn) => new Promise((res, rej) => { queue.push({ fn, res, rej }); pump(); });
        const readGroup = (name) => exclusive(() => reader.group(name, cfg[name]));

        /* ---------- polling ---------- */
        const fails = { ibs: 0, volt: 0, soc: 0, cap: 0, soh: 0 }, tried = { ibs: 0, volt: 0, soc: 0, cap: 0, soh: 0 };
        // the voltage, once a source answered, is read at the full rate however often it misses (a miss of
        // that source costs one READ_TIMEOUT_MS; backing off would blank the page)
        const due = (g, every, force) => force || (fails[g] < 3 || (g === 'volt' && reader.pick.volt != null) ? Date.now() - tried[g] >= every
            : Date.now() - tried[g] >= Math.max(every, g === 'volt' ? RETRY_VOLT_MS : RETRY_MS));
        const sign = () => (cfg.currentSign || -1) * (settings.get('flipCurrent') ? -1 : 1);
        const visible = () => Date.now() - lastFrame < 3000;
        // how long a reading stays valid: 2.5 read intervals (at least 5 s), at the cadence it was read at
        const keepMs = () => Math.max(5000, (visible() ? settings.get('poll') * 1000 : SLOW_MS) * 2.5);

        function onVolt(v, src) {
            const now = Date.now();
            live.v = v; live.vT = now; live.vSrc = src; live.vKeep = Math.max(VOLT_KEEP_MS, keepMs()); seen();
            trend.push({ t: now, v });
            while (trend.length && now - trend[0].t > TREND_MS) trend.shift();
            trip.minV = trip.minV === null ? v : Math.min(trip.minV, v);
            trip.maxV = trip.maxV === null ? v : Math.max(trip.maxV, v);
        }
        function onCurrent(a) {
            const now = Date.now();
            // charge in / out: integrate between readings close enough together. The gap allowed is the
            // previous reading's validity too (iKeep), so the first fast read after reopening the app still
            // counts the stretch since the last 30 s background read
            const interval = visible() ? settings.get('poll') * 1000 : SLOW_MS;
            if (G.isNum(live.i) && trip.lastT && now > trip.lastT && now - trip.lastT <= Math.max(5000, interval * 2.5, live.iKeep || 0)) {
                const ah = live.i * (now - trip.lastT) / 3600000;
                if (ah > 0) trip.ahIn += ah; else trip.ahOut -= ah;
            }
            trip.lastT = now;
            live.i = a; live.iT = now; live.iKeep = keepMs();
        }
        function sampleHist() {
            const now = Date.now(), d = data();
            // only real readings go into the history: demo values would stay in the chart after the car answers
            if (d.demo) return;
            if (hist.length && now - hist[hist.length - 1].t < HIST_STEP) return;
            if (!G.isNum(d.v) && !G.isNum(d.i)) return;
            // (the DME's state of charge too: the chart in place of the current on DMEs without one)
            hist.push({ t: now, v: d.v, i: d.i, soc: d.socSrc === 'dme' ? d.soc : null });
            while (hist.length && now - hist[0].t > HIST_MS) hist.shift();
        }

        // this drive: time charging, time and count of REGEN (what the screen shows, every second). Only while
        // the screen is open: in the background the voltage is read every 30 s, too seldom for a lift-off
        setInterval(() => {
            if (!visible()) { trip.wasRegen = false; return; }
            const d = data();
            if (d.demo || !G.isNum(d.v)) { trip.wasRegen = false; return; }
            const ch = charging(d);
            if (ch) trip.chargeS += 1;
            const rg = ch && d.regen;
            if (rg) { trip.regenS += 1; if (!trip.wasRegen) trip.regenN += 1; }
            trip.wasRegen = rg;
        }, 1000);

        let busy = false, pollTimer = null, paused = false;
        async function poll(force) {
            if (busy) return;
            busy = true;
            try {
                // screen open: while in use; in the background (history, this drive): only while driving
                const allowed = force || (visible() ? inUse() : driving());
                if (!allowed && !paused) log.info('parked: reads paused, the car can sleep');
                paused = !allowed;
                if (diag.available && allowed) {
                    const fast = visible() || force ? settings.get('poll') * 1000 : SLOW_MS;
                    // IBS block: voltage, current, temperature
                    let gotV = false;
                    if (due('ibs', fast, force)) {
                        tried.ibs = Date.now();
                        const r = await readGroup('ibs');
                        if (r) {
                            fails.ibs = 0;
                            onVolt(r.volt, 'IBS ' + Reader.label(cfg.ibs[reader.pick.ibs || 0]));
                            gotV = true;
                            if (G.isNum(r.amp)) onCurrent(r.amp * sign());
                            else { live.iT = 0; trip.lastT = 0; restSince = null; }
                            if (G.isNum(r.temp)) { live.temp = r.temp; live.tempT = Date.now(); }
                        } else { fails.ibs++; live.iT = 0; trip.lastT = 0; restSince = null; }
                    }
                    // no voltage from the IBS block: the other voltage sources
                    if (!gotV && (fails.ibs > 0 || Date.now() - live.vT > fast * 2) && due('volt', fast, force)) {
                        tried.volt = Date.now();
                        const r = await readGroup('volt');
                        if (r) { fails.volt = 0; keepPick('volt'); onVolt(r.volt, Reader.label(cfg.volt[reader.pick.volt || 0]) + ' (0x' + hex(reader.ecuOf(cfg.volt[reader.pick.volt || 0])) + ')'); }
                        else fails.volt++;
                    }
                    if (due('soc', SOC_MS, force)) {
                        tried.soc = Date.now();
                        const r = await readGroup('soc');
                        if (r) {
                            fails.soc = 0;
                            live.soc = r.soc; live.socT = Date.now(); seen();
                            const h = ['h1', 'h2', 'h3', 'h4', 'h5'].map((k) => r[k]);
                            if (h.some(G.isNum)) live.socHist = h;
                            const b = {};
                            BANDS.forEach(([k]) => { b[k] = r[k]; });
                            if (BANDS.some(([k]) => G.isNum(b[k]))) { live.bands = b; live.bInvalid = r.bInvalid; }
                            Object.assign(st, { socHist: live.socHist, bands: live.bands, bInvalid: live.bInvalid, soc: live.soc, socT: live.socT });
                            saveIf();
                        } else fails.soc++;
                    }
                    if (due('cap', CAP_MS, force)) {
                        tried.cap = Date.now();
                        const r = await readGroup('cap');
                        if (r) {
                            fails.cap = 0;
                            live.cap = r.cap; live.capNew = r.capNew; live.capT = Date.now();
                            Object.assign(st, { cap: live.cap, capNew: live.capNew });
                            saveIf();
                        } else fails.cap++;
                    }
                    // the battery's state of health as the DME's energy management rates it (59AA VALSOH, as Live
                    // Data reads it): changes over months, read with the capacity
                    if (cfg.soh && due('soh', CAP_MS, force)) {
                        tried.soh = Date.now();
                        const r = await readGroup('soh');
                        if (r) {
                            fails.soh = 0;
                            live.soh = r.soh;
                            st.soh = live.soh;
                            saveIf();
                        } else fails.soh++;
                    }
                }
                sampleHist();
            } catch (e) { log.warn('poll: ' + e); }
            busy = false;
        }
        function schedule() {
            clearTimeout(pollTimer);
            const ms = visible() ? settings.get('poll') * 1000 : 5000;     // hidden: wake every 5 s, read every 30 s
            pollTimer = setTimeout(() => poll(false).then(schedule, schedule), ms);
        }
        diag.on('available', (a) => {
            if (a) poll(false);
            else { live.vT = 0; live.iT = 0; trip.lastT = 0; restSince = null; }
        });
        poll(false).then(schedule, schedule);


        /* ---------- what to show ---------- */
        function data() {
            if (usingDemo()) {
                const s = demo.sample();
                return Object.assign(s, { demo: true, socSrc: 'dme', socAge: 0, vAge: 0, vSrc: 'demo', iOk: false, tempOk: true, engine: s.engine, trip: { ahIn: 0, ahOut: 0, regenS: 95, regenN: 23, chargeS: 412 } });
            }
            const now = Date.now();
            const interval = visible() ? settings.get('poll') * 1000 : SLOW_MS;
            const maxAge = Math.max(5000, interval * 2.5);
            // a reading taken while the screen was hidden (every 30 s) keeps its longer validity, so
            // reopening the app doesn't blank values until the next fast read
            const vOk = !!live.vT && now - live.vT < Math.max(maxAge, live.vKeep || 0);
            const iOk = !!live.iT && now - live.iT < Math.max(maxAge, live.iKeep || 0);
            // the car sends a signal only when it changes: a running engine's rpm keeps coming, a stopped one's
            // 0 comes once (2026-11-01, G20: "ENGINE n/a" after the engine was switched off). So an old reading
            // of a stopped engine still says off; an old one of a running engine says nothing
            const engine = !G.isNum(live.rpm) || !live.rpmT ? null : now - live.rpmT < 5000 ? live.rpm > 400 : live.rpm <= 400 ? false : null;
            // slowing down with the engine running (lift-off / braking): where the DME regenerates
            const regen = engine !== false && G.isNum(live.speed) && live.decelT > 0 && now - live.decelT < REGEN_HOLD_MS;
            let soc = live.socT && now - live.socT < 5 * 60000 ? live.soc : null, socSrc = soc === null ? null : 'dme';
            // Estimate only after sustained, confirmed engine-off and low-current measurements.
            const resting = vOk && iOk && engine === false && Math.abs(live.i) < 2 && live.v < 13.0;
            if (!resting) restSince = null;
            else if (restSince === null) restSince = now;
            if (soc === null && resting && now - restSince >= REST_MS) {
                soc = ocvSoc(live.v, settings.get('batteryType')); socSrc = 'voltage';
            }
            if (soc === null && G.isNum(st.soc)) { soc = st.soc; socSrc = 'saved'; }
            return {
                demo: false, v: vOk ? live.v : null, vAge: live.vT ? now - live.vT : null, vSrc: live.vSrc,
                i: iOk ? live.i : null, iOk, iAge: live.iT ? now - live.iT : null, temp: live.tempT && now - live.tempT < 10 * 60000 ? live.temp : null,
                soc, socSrc, socAge: socSrc === 'dme' ? now - live.socT : socSrc === 'saved' ? now - (st.socT || 0) : null,
                socHist: live.socHist, bands: live.bands, bInvalid: live.bInvalid,
                cap: live.cap, capNew: live.capNew, soh: live.soh, engine, regen, ambient: live.ambient, trip,
                // parked, reads stopped: the last voltage read (shown dimmed, with its age)
                paused: !inUse(), lastV: live.vT ? live.v : null,
            };
        }

        /* ---------- units, text ---------- */
        const F = () => settings.get('tempUnit') === 'f';
        const T = (c) => (G.isNum(c) ? (F() ? c * 9 / 5 + 32 : c) : null);
        const tU = () => (F() ? '°F' : '°C');
        const ago = (ms) => (ms == null ? 'not read yet' : ms < 60000 ? Math.max(0, Math.round(ms / 1000)) + ' s ago' : ms < 3600000 ? Math.round(ms / 60000) + ' min ago'
            : ms < 172800000 ? Math.round(ms / 3600000) + ' h ago' : Math.round(ms / 86400000) + ' days ago');

        /** The battery is being charged now: current in, or (no current reading) the charging voltage. */
        const charging = (d) => (G.isNum(d.i) ? d.i > 1 : G.isNum(d.v) && d.v >= CHARGE_V);
        const lowSoc = (d) => G.isNum(d.soc) && d.socSrc === 'dme' && d.soc < LOW_SOC;

        /** What the battery is doing: { text, color, note }. */
        function state(t, d) {
            const v = d.v, i = d.i;
            if (!G.isNum(v) && d.paused) return { text: 'PAUSED', color: t.dim, note: 'parked: reads stopped so the car can sleep' };
            if (!G.isNum(v)) return { text: 'NO READING', color: t.dim, note: 'waiting for the engine unit' };
            if (charging(d)) {
                // lift-off / braking: brake energy regeneration
                if (d.regen) return { text: 'REGEN', color: t.cold || t.accent, note: 'slowing down: braking energy charges the battery' };
                if (lowSoc(d)) return { text: 'CHARGING', color: GO, note: 'charge low: charged all the time until it recovers' };
                if (G.isNum(i)) return { text: 'CHARGING', color: GO, note: v >= 14.6 ? 'strong charge after a start or a deep drain' : 'the alternator charges the battery' };
                return { text: 'CHARGING', color: GO, note: 'voltage says: alternator charging' };
            }
            if (G.isNum(i)) {
                if (i < -1) {
                    if (d.engine) return { text: 'SUPPLYING', color: t.warn, note: 'alternator resting, battery feeds the car (normal)' };
                    return { text: 'DISCHARGING', color: t.warn, note: 'engine off: the battery feeds the car' };
                }
                if (v < 12.2) return { text: 'LOW', color: t.crit, note: 'resting, but low: charge or drive soon' };
                return { text: 'RESTING', color: t.text, note: 'hardly any current' };
            }
            // no current reading, below the charging voltage: from the voltage alone
            if (d.engine && v >= 12.0) return { text: 'SUPPLYING', color: t.warn, note: 'alternator resting, battery feeds the car (normal)' };
            // engine off: while the app is on the screen the car is awake and draws 10-30 A (head unit, control units,
            // fan, lights), so the voltage reads ~0.2-0.3 V below a rested battery's (12.6 V full, 12.3 V half)
            const awake = 'engine off, car awake: ';
            if (v >= 12.4) return { text: 'GOOD', color: GO, note: awake + 'well charged' };
            if (v >= 12.1) return { text: 'OK', color: t.text, note: awake + 'about half charged or more' };
            if (v >= 11.8) return { text: 'LOW', color: t.warn, note: awake + 'low - drive or charge soon' };
            return { text: 'VERY LOW', color: t.crit, note: awake + 'charge the battery' };
        }

        /* ---------- drawing ---------- */
        const pages = () => ['main', 'history'];
        const NAMES = { main: 'Battery', history: 'History' };
        let page = 0;
        const turn = (n) => { touched(); page = n; return render(); };
        ui.onClick('BTN_PAGE', () => turn((page + 1) % pages().length));
        ui.onClick('BTN_PREV', () => { const n = pages().length; return turn((page + n - 1) % n); });
        ctx.onTab((i) => turn(i));
        ui.onClick('BTN_READ', () => { touched(); return poll(true).then(render); });
        // where the kit runs the screen the values are read on their own and the Reset is on the page
        // (kits before eDrive 2.6 have neither: the bar button then stays)
        if (typeof ctx.hideButton === 'function') ctx.hideButton('BTN_READ');
        /** An in-page button (drawn only where the kit runs the screen; kits without G.button: none). */
        const button = (cv, t, x, y, w, h, label, run, opts) => (typeof G.button === 'function' ? G.button(cv, t, x, y, w, h, label, run, opts) : 0);

        function batteryIcon(cv, t, x, y, w, h, soc) {
            const f = G.isNum(soc) ? G.clamp(soc / 100, 0, 1) : 0;
            const c = !G.isNum(soc) ? t.tick : soc < 40 ? t.crit : soc < 65 ? t.warn : GO;
            cv.strokeRoundRect(x, y, w, h, 14, 5, t.tick);
            cv.roundRect(x + w + 2, y + h * 0.3, 16, h * 0.4, 4, t.tick);
            const iw = w - 24, ih = h - 24, seg = iw / 10;
            for (let k = 0; k < 10; k++) cv.roundRect(x + 12 + k * seg, y + 12, seg - 6, ih, 5, f * 10 > k + 0.05 ? c : t.track);
            const k = Math.floor(f * 10), part = f * 10 - k;
            if (k < 10 && part > 0.05) cv.roundRect(x + 12 + k * seg, y + 12, (seg - 6) * part, ih, 5, withAlpha(c, 0.55));
        }
        const big = (cv, t, s, x, y, size, color, unit, unitSize) => {
            const w = cv.text(s, x, y, size, color, { font: 'num' });
            if (unit) cv.text(unit, x + w + 10, y, unitSize || 32, t.dim, { font: 'bold' });
            return w;
        };
        const kv = (cv, t, label, value, x, y, w, color) => {
            cv.text(label, x, y, 21, t.dim, { font: 'bold', spacing: 1.5 });
            cv.text(value, x + w, y, 28, color || t.text, { font: 'bold', align: 'right' });
        };

        /**
         * Where the screen has room below the page (no bar under it: the panels reach down, G.panel), the
         * panels' contents spread over it: Y(y) moves a line laid out for the 468 px panel down in proportion.
         * Kits before the room was readable (G.pageBottom): as laid out.
         */
        const spread = (cv) => {
            const ex = typeof G.pageBottom === 'function' && G.isNum(G.BOTTOM) ? Math.max(0, G.pageBottom(cv) - G.BOTTOM) : 0;
            return { ex, Y: (y) => y + Math.round(ex * (y - 44) / 468) };
        };

        function renderMain(cv, t, d) {
            const { Y } = spread(cv);
            /* ---- state of charge ---- */
            G.panel(cv, t, 24, 44, 500, 468, 'State of charge');
            batteryIcon(cv, t, 48, Y(108), 420, 120, d.soc);
            const has = G.isNum(d.soc);
            const sw = big(cv, t, has ? G.fmt(d.soc, 0) : '--', 48, Y(352), 110, has ? t.text : t.dim);
            cv.text('%', 60 + sw, Y(352), 44, t.dim, { font: 'bold' });
            const src = d.socSrc === 'dme' ? 'engine unit (IBS)  ·  ' + ago(d.socAge) : d.socSrc === 'voltage' ? 'voltage estimate (5 min low load)'
                : d.socSrc === 'saved' ? 'last reading, ' + ago(d.socAge) : 'not available';
            cv.text(src, 500, Y(300), 21, d.socSrc === 'dme' ? t.dim : t.warn, { align: 'right' });
            // Ah left: the DME's state of charge is a share of the capacity registered in it (battery registration / coding)
            if (has && G.isNum(d.cap)) cv.text('~' + G.fmt(d.cap * d.soc / 100, 0) + ' of ' + G.fmt(d.cap, 0) + ' Ah', 500, Y(348), 28, t.text, { font: 'bold', align: 'right' });
            cv.fillRect(48, Y(380), 452, 1, t.tick);
            // the DME keeps the charge below full on purpose (room for braking energy): 65-85 % is normal
            const lvl = !has ? ['-', t.dim] : d.soc >= 85 ? ['well charged', GO] : d.soc >= 65 ? ['normal', t.text]
                : d.soc >= 50 ? ['lowish - a longer drive helps', t.warn] : ['low - use a battery charger', t.crit];
            cv.text('STATUS', 48, Y(418), 21, t.dim, { font: 'bold', spacing: 1.5 });
            cv.text(lvl[0], 500, Y(418), 24, lvl[1], { font: 'bold', align: 'right' });
            const sh = (d.socHist || []).filter(G.isNum);
            cv.text('EARLIER', 48, Y(470), 21, t.dim, { font: 'bold', spacing: 1.5 });
            cv.text(sh.length ? sh.map((x) => Math.round(x)).join('  ') + ' %' : '-', 500, Y(470), 26, sh.length ? t.text : t.dim, { font: 'bold', align: 'right' });

            /* ---- voltage, current ---- */
            const s = state(t, d);
            // this DME gives no current: the voltage trend in its place
            const trendMode = !G.isNum(d.i) && (d.demo || (fails.ibs > 0 && diag.available));
            G.panel(cv, t, 548, 44, 520, 468, trendMode ? 'Voltage' : 'Voltage & current');
            const v = d.v, vcol = !G.isNum(v) ? t.dim : v < 11.8 ? t.crit : v < 12.2 || v > 15.0 ? t.warn : t.text;
            // parked, reads stopped: the last voltage read, dimmed
            const vShow = G.isNum(v) ? v.toFixed(2) : d.paused && G.isNum(d.lastV) ? d.lastV.toFixed(2) : '--.--';
            const vw = big(cv, t, vShow, 572, Y(210), 110, vcol);
            cv.text('V', 584 + vw, Y(210), 44, t.dim, { font: 'bold' });
            // parked: a Read now button in place of the state (where the kit runs the screen; else the bar's)
            if (!(d.paused && !G.isNum(v) && button(cv, t, 828, 64, 216, 40, 'Read now', () => { touched(); return poll(true).then(render); }, { key: 'read', primary: true }))) {
                G.pill(cv, t, 828, 64, 216, 40, s.text, { color: s.color, size: 20 });
            }
            // voltage scale 11-15.5 V: low / resting / charging zones under the track
            const sx = 572, sy = Y(244), sw2 = 472, sh2 = 24, vmin = 11, vmax = 15.5;
            const SX = (val) => sx + G.clamp((val - vmin) / (vmax - vmin), 0, 1) * sw2;
            cv.roundRect(sx, sy, sw2, sh2, 6, withAlpha(t.track, 0.7));
            const sv = G.smooth('v12bar', v);
            if (G.isNum(sv)) {
                const fc = sv >= 13.2 ? GO : sv < 12.2 ? t.crit : sv < 12.4 ? t.warn : t.cold || t.accent;
                cv.roundRect(sx, sy, Math.max(12, SX(sv) - sx), sh2, 6, withAlpha(fc, 0.85));
                cv.fillRect(SX(sv) - 2, sy - 4, 4, sh2 + 8, '#ffffff');
            }
            [[11, 12.2, t.crit], [12.2, 12.4, t.warn], [12.4, 13.2, t.dim], [13.2, 15.5, GO]].forEach(([a, b, c]) => cv.fillRect(SX(a), sy + sh2 + 5, SX(b) - SX(a) - 2, 5, c));
            [11, 12, 13, 14, 15].forEach((m) => cv.text(String(m), SX(m), sy + sh2 + 34, 18, t.dim, { align: 'center', font: 'bold' }));
            cv.text('low', SX(11.6), sy + sh2 + 56, 16, t.dim, { align: 'center' });
            cv.text('resting', SX(12.8), sy + sh2 + 56, 16, t.dim, { align: 'center' });
            cv.text('charging', SX(14.35), sy + sh2 + 56, 16, t.dim, { align: 'center' });
            cv.fillRect(572, Y(330), 472, 1, t.tick);
            const i = d.i;
            if (!trendMode) cv.text('CURRENT', 572, Y(372), 21, t.dim, { font: 'bold', spacing: 1.5 });
            if (G.isNum(i)) {
                const txt = (i > 0.05 ? '+' : '') + G.fmt(i, Math.abs(i) < 10 ? 1 : 0);
                const iw = cv.text(txt, 1044 - cv.textWidth(' A', 30), Y(380), 52, i > 1 ? GO : i < -1 ? t.warn : t.text, { font: 'num', align: 'right' });
                void iw;
                cv.text(' A', 1044, Y(380), 30, t.dim, { align: 'right' });
                const direction = i > 1 ? 'into the battery' : i < -1 ? 'out of the battery' : 'little current';
                cv.text(direction + (d.demo ? '' : ' · ' + ago(d.iAge)), 572, Y(404), 20, t.dim);
                kv(cv, t, 'POWER', G.isNum(v) ? G.fmt(Math.abs(v * i), 0) + ' W' : '--', 572, Y(440), 472);
            } else if (trendMode) {
                // this DME gives no current (e.g. G20 320i: 402B all FF): the voltage of the last minutes in its
                // place - the jumps to ~14.7 V are the lift-offs and braking (REGEN), the rest the battery feeding
                cv.text('VOLTAGE, LAST 2 MIN', 572, Y(366), 21, t.dim, { font: 'bold', spacing: 1.5 });
                const now = Date.now(), pts = d.demo ? Array.from({ length: 61 }, (x, k) => [-k / 30, demo.sample(now - k * 2000).v]).reverse()
                    : trend.map((p) => [(p.t - now) / 60000, p.v]);
                // 12-15 V (12, 13.5, 15), or 11-15 V (11, 13, 15) when it went below 12 V
                const lo = pts.some((p) => p[1] < 12) ? 11 : 12;
                G.chart(cv, t, 572, Y(376), 472, Y(456) - Y(376), {
                    xMin: -2, xMax: 0, xStep: 0.5, xFmt: (x) => (x % 1 ? '' : String(x)), yMin: lo, yMax: 15, yStep: (15 - lo) / 2, yFmt: (y) => y.toFixed(1), xUnit: 'min',
                    padBottom: 22, series: [{ pts, color: t.accent, fill: 0.12 }],
                    marks: [{ y: CHARGE_V, color: GO }], empty: 'collecting...',
                });
            } else {
                cv.text('n/a', 1044, Y(380), 30, t.dim, { font: 'bold', align: 'right' });
                cv.text(d.demo ? '' : !diag.available ? 'diagnostic link down' : fails.ibs > 0 ? 'this DME gives no current' : 'not read yet', 572, Y(410), 20, t.dim);
            }
            const note = s.note.length > 52 ? s.note.slice(0, 51) + '…' : s.note;
            cv.text(note, 572, Y(490), 20, s.color === t.dim ? t.dim : t.text);

            /* ---- battery facts ---- */
            G.panel(cv, t, 1092, 44, 484, 468, 'Battery');
            const x = 1116, w = 436;
            // the outside temperature from the car (the battery sensor's own temperature isn't given by every DME)
            const tc = !G.isNum(d.ambient) ? t.dim : d.ambient < 0 || d.ambient > 45 ? t.warn : t.text;
            kv(cv, t, 'OUTSIDE TEMP', G.isNum(d.ambient) ? G.fmt(T(d.ambient), 1) + ' ' + tU() : 'n/a', x, Y(116), w, tc);
            // the capacity registered in the DME (follows battery registration / FA and DME coding)
            // (the original battery's capacity beside it when the registered one differs)
            const capTxt = !G.isNum(d.cap) ? 'n/a' : G.fmt(d.cap, 0) + ' Ah'
                + (G.isNum(d.capNew) && Math.abs(d.cap - d.capNew) >= 1 ? '  (orig. ' + G.fmt(d.capNew, 0) + ')' : '');
            kv(cv, t, 'CAPACITY', capTxt, x, Y(166), w, G.isNum(d.cap) ? t.text : t.dim);
            // state of health: the DME's own rating of the battery (100 % = as new)
            const hc = !G.isNum(d.soh) ? t.dim : d.soh < 60 ? t.crit : d.soh < 80 ? t.warn : GO;
            kv(cv, t, 'HEALTH (SOH)', G.isNum(d.soh) ? G.fmt(d.soh, 0) + ' %' : 'n/a', x, Y(216), w, hc);
            kv(cv, t, 'ENGINE', d.engine === null || d.engine === undefined ? 'n/a' : d.engine ? 'running' : 'off', x, Y(266), w);
            cv.fillRect(x, Y(292), w, 1, t.tick);
            cv.text('THIS DRIVE', x, Y(330), 21, t.dim, { font: 'bold', spacing: 1.5 });
            // this drive's totals and voltage range from zero, on its own row (a reset: the first press asks)
            button(cv, t, x + w - 110, Y(304), 110, 36, 'Reset', () => { touched(); resetTrip(); return render(); }, { key: 'trip', confirm: true });
            const tr = d.trip || trip;
            if (d.iOk) {
                kv(cv, t, 'CHARGED', '+' + G.fmt(tr.ahIn, 2) + ' Ah', x, Y(372), w, GO);
                kv(cv, t, 'USED', '-' + G.fmt(tr.ahOut, 2) + ' Ah', x, Y(414), w, t.warn);
            } else {
                // no current reading: how often and how long the battery got braking energy, and charged at all
                const mmss = (sec) => Math.floor(sec / 60) + ':' + String(Math.floor(sec % 60)).padStart(2, '0');
                kv(cv, t, 'REGEN', mmss(tr.regenS) + '  ·  ' + times(tr.regenN), x, Y(372), w, t.cold || t.accent);
                kv(cv, t, 'CHARGING', mmss(tr.chargeS), x, Y(414), w, GO);
            }
            const range = G.isNum(trip.minV) ? G.fmt(trip.minV, 2) + ' - ' + G.fmt(trip.maxV, 2) + ' V' : d.demo ? '12.41 - 14.62 V' : '--';
            kv(cv, t, 'VOLTAGE RANGE', range, x, Y(466), w, t.text);
            cv.text(d.demo ? '' : 'voltage: ' + (d.vSrc || '-') + (G.isNum(d.vAge) ? ', ' + ago(d.vAge) : ''), x + w, Y(500), 17, t.dim, { align: 'right' });
        }

        function renderHistory(cv, t, d) {
            const { ex, Y } = spread(cv), half = Math.round(ex / 2);
            G.panel(cv, t, 24, 44, 1040, 468, 'Last hour');
            let pts = hist;
            if (d.demo) {
                // a made-up hour for the preview
                const now = Date.now();
                pts = [];
                // a drive: charging after the start, then cruising with lift-offs; the charge climbing from 66 %
                for (let k = 0; k <= 720; k++) {
                    const m = k / 12;
                    const vv = m < 12 ? 14.6 - 0.4 * m / 12 : k % 19 === 0 ? 14.7 : 12.78 + 0.04 * Math.sin(k / 3);
                    pts.push({ t: now - HIST_MS + m * 60000, v: vv, i: null, soc: Math.round(66 + 12 * (1 - Math.exp(-m / 25))) });
                }
            }
            const now = Date.now(), X = (p) => (p.t - now) / 60000;
            const vs = pts.map((p) => p.v).filter(G.isNum), is = pts.map((p) => p.i).filter(G.isNum);
            const vMin = vs.length ? Math.min(11.5, Math.floor(Math.min.apply(null, vs) * 2) / 2) : 11.5;
            const vMax = vs.length ? Math.max(15, Math.ceil(Math.max.apply(null, vs) * 2) / 2) : 15;
            cv.text('VOLTAGE  (V)', 1040, 86, 20, t.dim, { font: 'bold', spacing: 1.5, align: 'right' });
            G.chart(cv, t, 48, 112, 992, 172 + half, {
                xMin: -60, xMax: 0, xStep: 10, yMin: vMin, yMax: vMax, yStep: 0.5, yFmt: (y) => y.toFixed(1), padBottom: 8,
                xFmt: () => '', series: [{ pts: pts.map((p) => [X(p), p.v]), color: t.accent, fill: 0.12 }],
                marks: [{ y: 12.4, color: 'warn', label: '12.4 V' }], empty: 'no voltage readings yet',
            });
            const iMax = is.length ? Math.max(10, Math.ceil(Math.max.apply(null, is.map(Math.abs)) / 10) * 10) : 30;
            if (d.demo || (!d.iOk && fails.ibs > 0)) {
                // this DME gives no current (e.g. G20 320i): its state of charge over the hour in place of the current
                const ss = pts.map((p) => p.soc).filter(G.isNum);
                const sLo = ss.length ? Math.max(0, Math.min(Math.floor((Math.min.apply(null, ss) - 5) / 10) * 10, 60)) : 0;
                const sHi = ss.length ? Math.min(100, Math.max(Math.ceil((Math.max.apply(null, ss) + 5) / 10) * 10, sLo + 40)) : 100;
                cv.text('STATE OF CHARGE  (%, FROM THE DME)', 1040, 312 + half, 20, t.dim, { font: 'bold', spacing: 1.5, align: 'right' });
                G.chart(cv, t, 48, 322 + half, 992, 182 + ex - half, {
                    xMin: -60, xMax: 0, xStep: 10, yMin: sLo, yMax: sHi, yStep: (sHi - sLo) / 4, yFmt: (y) => String(Math.round(y)), xUnit: 'min',
                    series: [{ pts: pts.filter((p) => G.isNum(p.soc)).map((p) => [X(p), p.soc]), color: GO, fill: 0.1 }],
                    marks: [{ y: LOW_SOC, color: 'warn', label: LOW_SOC + ' %' }], empty: 'collecting...',
                });
            } else {
                cv.text('CURRENT  (A, + = INTO THE BATTERY)', 1040, 312 + half, 20, t.dim, { font: 'bold', spacing: 1.5, align: 'right' });
                G.chart(cv, t, 48, 322 + half, 992, 182 + ex - half, {
                    xMin: -60, xMax: 0, xStep: 10, yMin: -iMax, yMax: iMax, yStep: iMax / 2, xUnit: 'min',
                    series: [{ pts: pts.map((p) => [X(p), p.i]), color: GO, fill: 0.1 }],
                    marks: [{ y: 0, color: 'tick' }], empty: d.demo || d.iOk ? 'collecting...' : 'no current from this DME',
                });
            }

            /* ---- the DME's own records ---- */
            G.panel(cv, t, 1088, 44, 488, 468, 'Recorded by the car');
            const x = 1112, w = 440;
            cv.text('STATE OF CHARGE, LAST 5', x, Y(110), 20, t.dim, { font: 'bold', spacing: 1.5 });
            const sh = d.socHist || [];
            const bw = w / 6;
            const vals = [sh[4], sh[3], sh[2], sh[1], sh[0], d.socSrc === 'dme' ? d.soc : null];
            vals.forEach((s, k) => {
                const bx = x + k * bw + 6, top = Y(128), hh = 120, bh = G.isNum(s) ? Math.max(4, hh * s / 100) : 0;
                cv.roundRect(bx, top, bw - 12, hh, 4, withAlpha(t.track, 0.6));
                if (bh) cv.roundRect(bx, top + hh - bh, bw - 12, bh, 4, k === 5 ? GO : withAlpha(GO, 0.55));
                cv.text(G.isNum(s) ? String(Math.round(s)) : '-', bx + (bw - 12) / 2, top + hh + 26, 20, G.isNum(s) ? t.text : t.dim, { font: 'bold', align: 'center' });
            });
            cv.text('older', x + 6, Y(300), 17, t.dim);
            cv.text('now', x + w - 6, Y(300), 17, t.dim, { align: 'right' });
            cv.fillRect(x, Y(316), w, 1, t.tick);
            cv.text('TIME SPENT PER CHARGE BAND', x, Y(352), 20, t.dim, { font: 'bold', spacing: 1.5 });
            const b = d.bands;
            const tot = b ? BANDS.reduce((a, [k]) => a + (G.isNum(b[k]) ? b[k] : 0), 0) : 0;
            if (tot > 0) {
                const cols = [t.crit, t.crit, t.warn, t.text, GO, GO];
                let bx = x;
                BANDS.forEach(([k], j) => {
                    const f = (G.isNum(b[k]) ? b[k] : 0) / tot, ww = f * w;
                    if (ww >= 1) cv.fillRect(bx, Y(370), ww - (ww > 3 ? 2 : 0), 34, withAlpha(cols[j], j === 3 ? 0.5 : 0.85));
                    bx += ww;
                });
                // the bands with a share worth showing, as text
                const parts = BANDS.map(([k, name], j) => [name, (G.isNum(b[k]) ? b[k] : 0) / tot, j]).filter(([, f]) => f >= 0.005);
                parts.slice(0, 6).forEach(([name, f, j0], j) => {
                    const cx = x + (j % 3) * (w / 3), cy = Y(438) + Math.floor(j / 3) * 30;
                    cv.fillRect(cx, cy - 12, 10, 10, withAlpha(cols[j0], j0 === 3 ? 0.5 : 0.85));
                    cv.text(name + '%', cx + 16, cy, 18, t.dim);
                    cv.text(G.fmt(f * 100, 0) + '%', cx + w / 3 - 14, cy, 20, t.text, { font: 'bold', align: 'right' });
                });
            } else cv.text('not available', x, Y(400), 22, t.dim);
        }


        function render() {
            const wasHidden = Date.now() - lastFrame >= 3000;
            lastFrame = Date.now();
            // screen just opened: read now instead of waiting for the hidden-mode timer (up to 5 s)
            if (wasHidden) { lastUserT = Date.now(); clearTimeout(pollTimer); poll(false).then(schedule, schedule); }
            const t = ctx.theme(), d = data();
            const cv = ctx.canvas(W, H).clear(t.bg);
            const pg = pages();
            if (page >= pg.length) page = 0;
            const p = pg[page];
            if (p === 'history') renderHistory(cv, t, d);
            else renderMain(cv, t, d);
            G.frame(cv, t, pg.map((x) => NAMES[x]), page, [d.demo && { text: 'DEMO' }]);
            return ui.image('MAIN_GFX', cv);
        }

        ctx.loop('MAIN', 2, render);
        settings.onChange((k) => {
            if (k === 'poll') schedule();
        });
        render().then(() => log.info('first frame done')).catch((e) => log.warn('first render: ' + e));
    },
});
