'use strict';
/**
 * VMGauge — boost, temperatures, oil pressure, lambda, knock, fuel, electrical,
 * transfer case and lap timer, drawn in the M Vitals style (kit/gauges).
 */
const mgu = require('./kit/mgu');
const Car = require('./kit/car');
const G = require('./kit/gauges');
const { Diag } = require('./kit/diag');
const { DidReader } = require('./kit/dids');
const fs = require('fs');
const path = require('path');

const W = 1600, H = 520;
const num = G.isNum;
const clamp = G.clamp;

mgu.run({
    async start(ctx) {
        const { ui, log, settings } = ctx;

        /* ---------------- state ---------------- */
        const TABS = [
            { id: 'main', label: 'Main' }, { id: 'power', label: 'Power' }, { id: 'hpfp', label: 'HPFP' },
            { id: 'ign', label: 'Ign' }, { id: 'fuelcool', label: 'Fuel/Cool' }, { id: 'elec', label: 'Elec' },
            { id: 'tcase', label: 'TCase' }, { id: 'lap', label: 'Lap' }, { id: 'more', label: 'More' },
        ];
        let gTab = 'main';
        const v = {};                          // live DID values
        const counters = { knock: 0, misfire: 0 };
        const power = { hp: null, nm: null, peakHp: null, peakNm: null, peakAt: 0, stamp: 0, hist: [], lastPush: 0 };
        const fuelHist = [], fuelPush = { last: 0 };
        const ignHist = [], ignPush = { last: 0 };
        const tcHist = [], tcPush = { last: 0 };   // transfer-case lockup % history (TCASE chart)
        let prevKnock = false;
        const boostPeak = { peak: null, peakAt: 0 };

        // lap timer: disarmed by default; ARM arms it, then it starts the moment the car moves
        const lap = { state: 'idle', startedAt: 0, crossed: {}, t100_200: null, maxes: {}, btnRect: null };
        let lapEma = null;
        const LAP_TARGETS = [100, 200];
        const LAP_METRICS = ['boost', 'fuelPres', 'iat', 'egt', 'speed'];

        // CSV logging
        const logState = { active: false, rows: 0, lastRowAt: 0, btnRect: null };

        /* ---------------- signals (Car) ---------------- */
        // extra watch: BasicDataSet's rear-axle torque share (0.01 % per bit, as live_data /
        // M Vitals read it) - used to compute the xDrive lockup % when DID DB43 is unavailable
        const car = new Car(ctx, ['rpm', 'speed', 'temps', 'torque'], {
            'de.bmw.infrastructure.analytics.BasicDataSet': {
                basicDataSet: (bd) => {
                    const raw = bd && bd.valueDistributionLongitudinalTorqueRearAxisFrontAxis;
                    const q = bd && bd.qualifierValueDistributionLongitudinalTorqueRearAxisFrontAxis;
                    const okQ = q === undefined || q === null || q === 2 || q === 10 ||
                        q === 'SIGNALWERT_IST_GUELTIG' || q === 'SIGNALWERT_IST_GUELTIG__REKALIBRIERUNGSBEDARF';
                    if (!okQ || typeof raw !== 'number' || raw === 0 || raw === 65535) return;
                    const rear = raw * 0.01;
                    if (rear < 0 || rear > 100) return;
                    v.rearShare = rear;
                },
            },
        });
        const d = () => car.data();

        /* ---------------- DME over UDS ---------------- */
        const spec = ctx.spec.config || {};
        const dme = Object.assign({ ecu: 18 }, spec.dme || {});
        const xcfg = Object.assign({ front: [], lockup: [] }, spec.xdrive || {});
        const link = new Diag(ctx.signals, log);
        link.quiet = true;
        const rd = new DidReader(link, { ecu: dme.ecu, timeoutMs: 1200, maxConcurrent: 6 });
        link.init().catch((e) => log.warn('diag init: ' + e));

        let baro = 101.3, baroT = 0, baroBusy = false;
        function freshBaro() {                                   // never blocks a poll tick
            if (baroBusy || Date.now() - baroT <= 60000) return Promise.resolve();
            baroBusy = true; baroT = Date.now();
            return rd.value('baro', dme.baro)
                .then((b) => { if (b !== null) baro = b; })
                .catch(() => {})
                .then(() => { baroBusy = false; });
        }

        // Every DID metric; 'tcase' reads the transfer case (xcfg.front), not the DME.
        // 'baro' and 'temps' are refreshed by their own schedulers (freshBaro / Car signals),
        // so they are deliberately not in this list.
        const ALL = ['oilPressAbs', 'boost', 'iat', 'egt', 'lambda', 'mixtureAdapt', 'knockRetard',
            'loadDirect', 'fuelPresAct', 'fuelPresReq', 'ignAdv', 'fuelTemp', 'misfire',
            'radTemp', 'gearbox', 'voltage', 'battCurrent', 'aluIst', 'aluTemp', 'tcase', 'lockup'];
        // Poll tiers (Main re-layout): fast ~5/s, medium ~1/s, slow ~1/8s. A metric listed in a
        // tier keeps that cadence on every tab; anything else refreshes at STALE_BG.
        const FAST_SET = ['boost', 'mixtureAdapt', 'oilPressAbs', 'fuelPresAct', 'loadDirect'];
        const MED_SET = ['iat', 'egt', 'gearbox', 'voltage', 'lambda'];
        const SLOW_SET = ['knockRetard', 'misfire'];
        // Metrics the current tab draws but that have no explicit tier above: these poll at
        // MIN_GAP while their tab is open (per-tab fast set).
        const TAB_METRICS = {
            power: ['loadDirect', 'boost'],
            hpfp: ['fuelPresAct', 'fuelPresReq'],
            ign: ['ignAdv', 'knockRetard', 'lambda', 'mixtureAdapt'],
            fuelcool: ['iat', 'egt', 'gearbox', 'fuelTemp', 'radTemp'],
            elec: ['voltage', 'aluIst', 'aluTemp', 'battCurrent'],
            tcase: ['tcase', 'lockup'],
            lap: ['boost', 'fuelPresAct', 'iat', 'egt'],
            more: ['boost', 'lambda'],
        };

        const fail = {}, tried = {}, rawLog = {}, rawCount = {};
        let tickNo = 0;
        // misfire reads count as one logical metric (4 cylinders round-robin): the fail/cooldown
        // bookkeeping is shared across mids, so a refused cylinder doesn't mute the others.
        function misGated() { return (fail.misfire || 0) >= 3 && Date.now() - (tried.misfire || 0) < 30000; }

        // ---- fast polling -------------------------------------------------
        // The TASU transport takes one UDS request at a time (physical() is serialized in
        // kit/diag), and each request costs ~150 ms round trip. So instead of waiting for a
        // reply before sending the next one, every FAST_HZ ticks we dispatch a read without
        // awaiting it; replies land as they come. Metrics that are due go through first, so
        // the tiles on the active tab refresh about 5x/s.
        const FAST_HZ = 12;                  // dispatch rate (~83 ms)
        const MIN_GAP = 90;                  // fast metrics: don't re-send sooner than this
        const MED_GAP = 1500;                // medium metrics: ~0.7 update/s (Main's 5 med tiles
                                             // plus the shared pipe stay under the channel limit)
        const SLOW_GAP = 8000;               // slow counters (knock): ~1/8 s
        const MIS_GAP = 2000;                // each misfire cylinder: full sweep of 1-4 every ~2 s
        const STALE_BG = 4000;               // off-tab metrics: fresh enough for 4 s
        const bgLast = {};                   // metric -> ts of last completed read
        const inflight = new Set();          // metrics with a read in flight
        let qRot = 0;

        function fastSet() {
            const base = TAB_METRICS[gTab] || [];
            const extra = [];
            if ((gTab === 'power' || gTab === 'ign' || gTab === 'lap')) extra.push('loadDirect');
            if (gTab === 'hpfp') extra.push('boost');
            // the active tab's tiered metrics go through the same priority queue
            FAST_SET.concat(MED_SET).concat(SLOW_SET).forEach((m) => {
                if (ALL.indexOf(m) >= 0 && extra.indexOf(m) < 0 && base.indexOf(m) < 0) extra.push(m);
            });
            if (extra.indexOf('misfire') >= 0) extra.splice(extra.indexOf('misfire'), 1);   // handled per cylinder below
            const seen = {}, out = [];
            base.concat(extra).forEach((m) => { if (!seen[m]) { seen[m] = true; out.push(m); } });
            return out;
        }

        // Poll gap for a metric: explicit tier first (fast/medium/slow on every tab), then
        // whatever the active tab shows (fast), else background.
        function gapFor(metric) {
            if (metric.indexOf('misfire') === 0) return MIS_GAP;    // per cylinder
            if (FAST_SET.indexOf(metric) >= 0) return MIN_GAP;
            if (MED_SET.indexOf(metric) >= 0) return MED_GAP;
            if (SLOW_SET.indexOf(metric) >= 0) return SLOW_GAP;
            return fastSet().indexOf(metric) >= 0 ? MIN_GAP : STALE_BG;
        }

        function due(metric, now) {
            const key = metric.indexOf('misfire') === 0 ? metric : null;   // 'misfire0'..'misfire3'
            const m = key ? fail.misfire : fail[metric], t = key ? (tried[key] || 0) : (tried[metric] || 0), b = key ? (bgLast[key] || 0) : (bgLast[metric] || 0);
            if (key ? inflight.has(key) : inflight.has(metric)) return false;
            if ((m || 0) >= 3 && now - t < 30000) return false;
            return now - b >= gapFor(metric);
        }

        // Pipeline instead of a request/reply loop: kit/diag serializes physical() onto one
        // transport, so we keep up to MAX_INFLIGHT reads in flight and refill as replies land.
        // The pipe is always full; the queue order decides who gets each free slot, so fast
        // metrics (tier MIN_GAP) claim most slots and slow ones only what is left over.
        const MAX_INFLIGHT = 5;
        let fastRot = 0;
        function fillPipes() {
            const now = Date.now();
            if (inflight.size >= MAX_INFLIGHT) return;
            const fast = fastSet();
            const rest = ALL.filter((m) => fast.indexOf(m) < 0);
            const expand = (list) => {                       // misfire polls as 4 cylinders
                const out = [];
                list.forEach((m) => { if (m === 'misfire') for (let c = 0; c < MIS_MIDS.length; c++) out.push('misfire' + c); else out.push(m); });
                return out;
            };
            const fastE = expand(fast), restE = expand(rest);
            const lists = [fastE, restE], rots = [fastRot, qRot];
            for (let p = 0; p < 2 && inflight.size < MAX_INFLIGHT; p++) {
                const L = lists[p];
                let r = rots[p];
                for (let k = 0; k < L.length && inflight.size < MAX_INFLIGHT; k++) {
                    const i = (r + k) % L.length, m = L[i];
                    if (!due(m, now)) continue;
                    r = (i + 1) % L.length;
                    readMetric(m);
                }
                rots[p] = r;
            }
            fastRot = rots[0]; qRot = rots[1];
        }

        function readMetric(metric) {
            if (metric.indexOf('misfire') === 0) {          // dispatched per cylinder: one slow
                const c = +metric.slice(7);                 // or refused cylinder must not gate the rest
                if (inflight.has(metric)) return;
                inflight.add(metric); tried[metric] = Date.now();
                readMisfires(c).catch((e) => log.warn('poll misfire: ' + e))
                    .then(() => { inflight.delete(metric); bgLast[metric] = Date.now(); });
                return;
            }
            if (inflight.has(metric)) return;                                  // never double-dispatch
            inflight.add(metric);
            tried[metric] = Date.now();
            readMetricNow(metric)
                .catch((e) => log.warn('poll ' + metric + ': ' + e))
                .then(() => { inflight.delete(metric); bgLast[metric] = Date.now(); });   // pollTick refills
        }

        async function readMetricNow(metric) {
            const list = metric === 'tcase' || metric === 'lockup' ? xcfg[metric] : dme[metric];
            if (!Array.isArray(list) || !list.length) return;
            let val;
            if (metric === 'boost') { freshBaro(); val = await rd.value('boost', dme.boost); if (val !== null) val = (val - baro) / 100; }
            else if (metric === 'tcase' || metric === 'lockup') val = await rd.value(metric, list);
            else val = await rd.value(metric, list);
            // log each candidate's raw reply, at most a few distinct shapes each (for calibration)
            const chosen = rd.pick[metric] || 0;
            list.forEach((c, i) => {
                const r = rd.raws[rd.key(c)];
                if (!r || (!r.bytes && !r.why)) return;
                const shape = (c.obd ? 'OBD ' + c.obd : c.did) + '|' + (r.bytes || r.why);
                const k = metric + '|' + i + '|' + shape;
                if (rawLog[k]) return;
                rawLog[k] = true;
                rawCount[metric + '|' + i] = (rawCount[metric + '|' + i] || 0) + 1;
                if (rawCount[metric + '|' + i] <= 6) {
                    const lbl = c.obd ? 'OBD ' + String(c.obd).toUpperCase() : c.did;
                    log.info('DID ' + metric + ' [' + lbl + ']' + (i === chosen ? ' *' : '') + ': ' + (r.bytes || r.why) + (r.value !== null && r.value !== undefined ? ' = ' + r.value : ''));
                }
            });
            if (val === null) { fail[metric] = (fail[metric] || 0) + 1; return; }
            fail[metric] = 0;
            v[metric] = val;
            if (metric === 'oilPressAbs') v.oilPress = num(val) && num(baro) ? val - baro / 100 : null;
        }

        // Misfires: OBD service 06, mids A2..A5 (cylinders 1-4), tid 0x0C = misfire count.
        // Like the knock counter it only counts while boosting over 0.5 bar; we watch the
        // rolling per-revolution ratio (value/min vs value/max) and add every new excess.
        const MIS_MIDS = [0xA2, 0xA3, 0xA4, 0xA5];
        const misPrev = {};                    // mid -> last positive { v, min, max }
        let misFirst = true;
        async function readMisfires(cyl) {
            if (misGated()) return;                        // shared cooldown: don't spam a unit that refuses 06
            const mid = MIS_MIDS[cyl % MIS_MIDS.length];
            const recs = await rd.monitor(dme.ecu, mid);
            const r = rd.raws[rd.monitorKey(dme.ecu, mid)];
            if (r && !r.ok && r.why) log.info('MID ' + mid.toString(16).toUpperCase() + ': ' + r.bytes + ' | ' + r.why);
            const rec = Array.isArray(recs) ? recs.filter((x) => x.tid === 0x0C)[0] : null;
            if (!rec) { fail.misfire = (fail.misfire || 0) + 1; return; }
            fail.misfire = 0;
            const prev = misPrev[mid];
            misPrev[mid] = { v: rec.value, min: rec.min, max: rec.max };
            if (misFirst) misFirst = false;                    // first read only sets the baseline
            else if (prev && prev.v < rec.value) {             // window advanced since the last read
                const lo = prev.v - prev.min, hi = rec.value - rec.max;
                const inc = Math.max(0, hi - Math.max(0, lo));
                if (num(boostBar()) && boostBar() > 0.5) counters.misfire += inc;
            }
            v.misfireOk = true;
        }

        function pollTick() {
            if (!link.available) return;
            tickNo++;
            fillPipes();                                                     // fire and forget
        }
        setInterval(pollTick, Math.round(1000 / FAST_HZ));

        /* ---------------- derived values ---------------- */
        const F = () => settings.get('unitsTemp') === 'F';
        const T = (c) => (num(c) ? (F() ? c * 9 / 5 + 32 : c) : null);
        const tU = () => (F() ? '°F' : '°C');
        const mph = () => settings.get('speedUnits') === 'mph';
        const spd = (k) => (num(k) ? (mph() ? k * 0.621371 : k) : null);
        const sU = () => (mph() ? 'mph' : 'km/h');

        const boostBar = () => num(v.boost) ? v.boost : null;
        const currentLambda = () => {
            if (!num(v.lambda)) return null;
            let l = v.lambda;
            if (num(v.mixtureAdapt)) l *= v.mixtureAdapt;
            return l;
        };
        // air/fuel ratio: lambda x 14.7 (stoichiometric for petrol)
        const afr = () => {
            const l = currentLambda();
            return num(l) ? l * 14.7 : null;
        };
        const oilPress = () => num(v.oilPress) ? v.oilPress : null;
        const fuelPresAct = () => num(v.fuelPresAct) ? v.fuelPresAct : null;
        const fuelPresReq = () => num(v.fuelPresReq) ? v.fuelPresReq : null;
        const loadPct = () => num(v.loadDirect) ? clamp(v.loadDirect, 0, 191.25) : null;
        const alternatorLoadPct = () => {
            if (!num(v.aluIst)) return null;
            const nom = (spec.elec && spec.elec.alternatorMaxA) || 170;
            return clamp(v.aluIst / nom * 100, 0, 100);
        };
        const alternatorOutputA = () => {
            if (num(v.aluIst)) return v.aluIst;
            if (num(v.battCurrent) && v.battCurrent > 0) return v.battCurrent;
            return null;
        };
        // xDrive lockup: the LMV's own torque split in % of the total axle torque.
        // Primary source: DID DB43 (LMV_MOMENT.momentsollverteilung, 0.5 % per bit - the value
        // the transfer case requests as front share; raw bytes are logged for calibration).
        // Fallback: computed from the DB32 front torque and the BDS rear-axle share signal.
        function bdsRearPct() { return num(v.rearShare) ? v.rearShare : null; }
        function lockupPct() {
            if (num(v.lockup)) return clamp(v.lockup, 0, 100);
            const ft = num(v.tcase) ? Math.abs(v.tcase) : null;
            const rear = bdsRearPct();
            if (ft === null || ft <= 0 || rear === null) return null;
            const et = num(lastDd && lastDd.torque) && lastDd.torque > 0 ? lastDd.torque : null;
            if (et === null) return null;
            return clamp(ft / (ft + et * (1 - rear / 100)) * 100, 0, 100);
        }

        function computePower(dd) {
            if (!num(dd.rpm) || dd.rpm < 400) return;
            let nm = num(dd.torque) ? dd.torque : null;
            if (nm === null) {
                const load = num(v.loadDirect) ? v.loadDirect / 100 : null;
                if (!num(load)) return;
                nm = peakTorqueNm(dd.rpm) * load;
            }
            if (!num(nm) || nm < 0) return;
            const kw = nm * dd.rpm * 2 * Math.PI / 60 / 1000;
            power.nm = nm;
            power.hp = kw * 1.35962;         // metric PS
            power.stamp = Date.now();
            // peak reset: the 'peakResetMs' setting stores seconds (the number stepper's unit
            // label was changed from ms to s in 0.1.5; old saves hold ms - treat >1000 as ms)
            const raw = Number(settings.get('peakResetSec'));
            const ttl = (!isNaN(raw) && raw > 0) ? (raw > 1000 ? raw : raw * 1000) : 6000;
            if (num(power.peakHp) && now - power.peakAt > ttl) { power.peakHp = null; power.peakNm = null; }
            if (!num(power.peakHp) || power.hp > power.peakHp) { power.peakHp = power.hp; power.peakNm = power.nm; power.peakAt = now; }
            if (now - power.lastPush > 200) {
                power.lastPush = now;
                power.hist.push({ t: now, hp: power.hp, nm: power.nm });
                const cutoff = now - 30000;
                while (power.hist.length && power.hist[0].t < cutoff) power.hist.shift();
                if (power.hist.length > 600) power.hist.splice(0, power.hist.length - 600);
            }
            const fp = fuelPresAct();
            if (num(fp) && now - fuelPush.last > 200) {
                fuelPush.last = now;
                fuelHist.push({ t: now, bar: fp });
                const fc = now - 30000;
                while (fuelHist.length && fuelHist[0].t < fc) fuelHist.shift();
                if (fuelHist.length > 600) fuelHist.splice(0, fuelHist.length - 600);
            }
        }
        function peakTorqueNm(rpm) {
            const m = [[600, 100], [1300, 450], [5000, 450], [7000, 380]];
            if (rpm <= m[0][0]) return m[0][1];
            const last = m[m.length - 1];
            if (rpm >= last[0]) return last[1];
            for (let i = 1; i < m.length; i++) {
                if (rpm <= m[i][0]) {
                    const x0 = m[i - 1][0], y0 = m[i - 1][1], x1 = m[i][0], y1 = m[i][1];
                    return y0 + (y1 - y0) * (rpm - x0) / (x1 - x0);
                }
            }
            return last[1];
        }
        function handleKnock() {
            const ret = v.knockRetard;
            const active = num(ret) && ret < -0.5;
            if (active && !prevKnock && num(boostBar()) && boostBar() > 0.5) counters.knock++;
            prevKnock = active;
        }

        function boostGaugeStep() {
            const now = Date.now(), b = boostBar();
            if (num(b) && (!num(boostPeak.peak) || b > boostPeak.peak)) { boostPeak.peak = b; boostPeak.peakAt = now; }
            if (num(boostPeak.peak) && now - boostPeak.peakAt > 8000) boostPeak.peak = null;
        }

        /* ---------------- "why is this tile empty" ---------------- */
        function fuelWhy(k) {
            if (!link.p) return 'no diagnostic link';
            if (!link.available) return 'diagnostic link down';
            if (k === 'misfire') {
                const r = MIS_MIDS.map((mid) => rd.raws[rd.monitorKey(dme.ecu, mid)]).filter(Boolean);
                if (!r.length) return 'reading misfire counters...';
                if (r.every((x) => /NRC 31|NRC 11|NRC 12/.test(x.why))) return 'not available on this car';
                return (r[0].why || 'no data');
            }
            const list = (k === 'tcase' || k === 'lockup') ? xcfg[k] : dme[k];
            const r = (list || []).map((c) => rd.raws[rd.key(c)]).filter(Boolean);
            if (!r.length) return 'reading...';
            if (r.every((x) => /NRC 31|NRC 11|NRC 12/.test(x.why))) return 'not available on this car';
            return /NRC|refused|reply/.test((r[0] || {}).why || '') ? 'no reading from the engine unit' : (r[0] || {}).why || 'no data';
        }

        /* ---------------- layout helpers ---------------- */
        function header(cv, t) { G.frame(cv, t, TABS.map((x) => x.label), TABS.findIndex((x) => x.id === gTab), []); }
        function grid(n) {
            const per = n <= 2 ? Math.max(1, n) : n <= 4 ? 2 : n <= 6 ? 3 : 4, rows = Math.ceil(n / per), gap = 16;
            const h = (G.BOTTOM - G.TOP - gap * (rows - 1)) / rows, out = [];
            for (let r = 0; r < rows; r++) {
                const k = Math.min(per, n - r * per), w = (1552 - 24 * (k - 1)) / k;
                for (let c = 0; c < k; c++) out.push({ x: 24 + c * (w + 24), y: G.TOP + r * (h + gap), w, h });
            }
            return out;
        }
        /** Centred stat tile: G.stat with center:true (value + unit mid-tile). */
        function statC(cv, t, x, y, w, h, g) {
            G.stat(cv, t, x, y, w, h, Object.assign({ center: true }, g));
        }
        function drawTiles(cv, t, tiles) {
            grid(tiles.length).forEach((b, i) => {
                const g = tiles[i];
                if (g && g.draw) g.draw(cv, t, b.x, b.y, b.w, b.h);
                else if (g) statC(cv, t, b.x, b.y, b.w, b.h, Object.assign({ size: b.h > 200 ? 96 : 64 }, g));
            });
        }
        function drawRowedTiles(cv, t, rows) {
            const gap = 16, rh = (G.BOTTOM - G.TOP - gap * (rows.length - 1)) / rows.length;
            rows.forEach((row, r) => {
                const k = row.length || 1, w = (1552 - 24 * (k - 1)) / k;
                const x0 = 24 + (1552 - (w * k + 24 * (k - 1))) / 2;
                const y = G.TOP + r * (rh + gap);
                // size: value baseline sits at y + 52 + size*0.78 + unit; centre it in the tile
                const size = Math.max(36, Math.min(64, Math.round((rh - 52 - 28) / 0.78)));
                row.forEach((g, c) => statC(cv, t, x0 + c * (w + 24), y, w, rh, Object.assign({ size }, g)));
            });
        }

        /* ---------------- tabs ---------------- */
        // Main, three rows of four (fast / medium+slow / mixed cadences — see FAST/MED/SLOW_SET):
        //  1. boost, AFR (mixture), oil pressure [fast] · knock events [slow]
        //  2. intake air, EGT [medium] · gearbox oil (SOME/IP) · misfire events [slow]
        //  3. coolant, engine oil (SOME/IP) · battery voltage [medium] · HPFP rail pressure [fast]
        function drawMain(cv, t, dd) {
            drawRowedTiles(cv, t, [
                [
                    { label: 'Boost', value: boostBar(), unit: 'bar', decimals: 2, zones: [{ from: 0.05, to: 99, color: 'ok' }] },
                    { label: 'Mixture AFR', value: afr(), decimals: 1 },
                    { label: 'Oil pressure', value: oilPress(), unit: 'bar', decimals: 1, zones: [{ from: -99, to: 1.2, color: 'crit' }] },
                    { label: 'Knock events', value: counters.knock, decimals: 0, zones: [{ from: 1, to: 9e9, color: 'crit' }] },
                ],
                [
                    { label: 'Intake air', value: T(v.iat), unit: tU(), decimals: 0, zones: [{ from: T(65), to: 999, color: 'crit' }] },
                    { label: 'EGT', value: T(v.egt), unit: tU(), decimals: 0, zones: [{ from: T(950), to: 999, color: 'crit' }] },
                    { label: 'Gearbox oil', value: T(v.gearbox), unit: tU(), decimals: 0, zones: [{ from: T(120), to: 999, color: 'warn' }] },
                    { label: 'Misfires', value: v.misfireOk ? counters.misfire : null, decimals: 0, zones: [{ from: 1, to: 9e9, color: 'crit' }], sub: v.misfireOk ? undefined : fuelWhy('misfire') },
                ],
                [
                    { label: 'Coolant', value: T(dd.coolant), unit: tU(), decimals: 0, zones: [{ from: T(112), to: 999, color: 'crit' }, { from: -99, to: T(60), color: 'cold' }] },
                    { label: 'Engine oil', value: T(dd.oil), unit: tU(), decimals: 0, color: 'oil', zones: [{ from: T(125), to: 999, color: 'crit' }] },
                    { label: 'Voltage', value: v.voltage, unit: 'V', decimals: 1, zones: [{ from: -99, to: 12, color: 'warn' }, { from: 15.5, to: 99, color: 'warn' }] },
                    { label: 'Rail HPFP', value: fuelPresAct(), unit: 'bar', decimals: 0, zones: [{ from: -99, to: 20, color: 'crit' }] },
                ],
            ]);
        }

        function drawPower(cv, t, dd) {
            const fresh = num(power.hp) && Date.now() - power.stamp < 3000;
            const hp = fresh ? power.hp : null, nm = fresh ? power.nm : null;
            const barH = 110, gap = 12;
            G.bar(cv, t, 24, G.TOP, 1552, barH, { label: 'Power', value: hp, unit: 'hp', decimals: 0, min: 0, max: 600, ramp: 'hot', peak: power.peakHp });
            G.bar(cv, t, 24, G.TOP + barH + gap, 1552, barH, { label: 'Torque', value: nm, unit: 'Nm', decimals: 0, min: 0, max: 600, peak: power.peakNm });
            const y = G.TOP + 2 * (barH + gap), h = G.BOTTOM - y;
            const now = Date.now(), t0 = now - 30000;
            const hs = power.hist.filter((p) => p.t >= t0);
            // fixed scale to 600 (hp / Nm), chart compressed to ~2/3 of the width, centered
            const cw = Math.round(1552 * 0.66), cx = 24 + Math.round((1552 - cw) / 2);
            G.chart(cv, t, cx, y, cw, h, {
                xMin: t0, xMax: now, yMin: 0, yMax: 600, yStep: 100,
                xStep: 10000, xFmt: (xx) => Math.round((xx - now) / 1000) + 's',
                yUnit: 'hp · Nm', yFmt: (yy) => String(Math.round(yy)),
                series: [
                    { pts: hs.map((p) => [p.t, p.hp]), color: 'accent', width: 2.5, fill: 0.12 },
                    { pts: hs.map((p) => [p.t, p.nm]), color: '#3aa0ff', width: 2 },
                ],
                empty: 'no power data — drive the car',
            });
        }

        function chartFuel(cv, t, y, h) {
            const now = Date.now(), t0 = now - 30000;
            const hs = fuelHist.filter((p) => p.t >= t0);
            G.chart(cv, t, 24, y, 1552, h, {
                xMin: t0, xMax: now, yMin: 0, yMax: 300,
                xStep: 10000, xFmt: (xx) => Math.round((xx - now) / 1000) + 's',
                yUnit: 'bar', yFmt: (yy) => String(Math.round(yy)),
                series: [{ pts: hs.map((p) => [p.t, p.bar]), color: 'accent', width: 2.5, fill: 0.14 }],
                empty: 'no rail pressure data',
            });
        }
        function drawHpfp(cv, t, dd) {
            const act = fuelPresAct(), req = fuelPresReq();
            const th = Math.round((G.BOTTOM - G.TOP) * 0.42);
            const w2 = Math.round((1552 - 24) / 2);
            G.stat(cv, t, 24, G.TOP, w2, th, { label: 'Rail pressure', value: act, unit: 'bar', decimals: 0, zones: [{ from: -99, to: 20, color: 'crit' }], sub: num(act) ? 'high-pressure fuel (actual)' : fuelWhy('fuelPresAct') });
            G.stat(cv, t, 24 + w2 + 24, G.TOP, w2, th, { label: 'Rail requested', value: req, unit: 'bar', decimals: 0, sub: num(req) ? 'target rail pressure' : fuelWhy('fuelPresReq') });
            chartFuel(cv, t, G.TOP + th + 16, G.BOTTOM - G.TOP - th - 16);
        }

        function drawIgn(cv, t, dd) {
            // top: the two live values
            const th = Math.round((G.BOTTOM - G.TOP) * 0.34);
            const w2 = Math.round((1552 - 24) / 2);
            G.stat(cv, t, 24, G.TOP, w2, th, { label: 'Ignition timing', value: num(v.ignAdv) ? v.ignAdv : null, unit: '°', decimals: 1, sub: num(v.ignAdv) ? 'before TDC, cyl 1' : fuelWhy('ignAdv') });
            G.stat(cv, t, 24 + w2 + 24, G.TOP, w2, th, { label: 'Knock retard', value: num(v.knockRetard) ? v.knockRetard : null, unit: '°', decimals: 1, zones: [{ from: -99, to: -0.5, color: 'warn' }] });
            // bottom: ignition angle (0-45) and rpm (0-7500, scaled to the same axis)
            const y = G.TOP + th + 16, h = G.BOTTOM - y;
            const now = Date.now(), t0 = now - 30000;
            const hs = ignHist.filter((p) => p.t >= t0);
            cv.text('IGNITION ° (0-45)  ·  RPM (0-7500, scaled)', 40, y + 18, 18, t.dim, { font: 'bold', spacing: 1 });
            G.chart(cv, t, 24, y + 24, 1552, h - 24, {
                xMin: t0, xMax: now, yMin: 0, yMax: 45,
                xStep: 10000, xFmt: (xx) => Math.round((xx - now) / 1000) + 's',
                yUnit: '°', yFmt: (yy) => String(Math.round(yy)),
                series: [
                    { pts: hs.map((p) => [p.t, p.ign]), color: 'accent', width: 2.5, fill: 0.12 },
                    { pts: hs.map((p) => [p.t, p.rpm * 45 / 7500]), color: '#3aa0ff', width: 2, dash: true },
                ],
                empty: 'no ignition data',
            });
        }

        function drawFuelCool(cv, t, dd) {
            drawTiles(cv, t, [
                { label: 'Coolant', value: T(dd.coolant), unit: tU(), decimals: 0, zones: [{ from: T(112), to: 999, color: 'crit' }, { from: -99, to: T(60), color: 'cold' }] },
                { label: 'Intake air', value: T(v.iat), unit: tU(), decimals: 0, zones: [{ from: T(65), to: 999, color: 'crit' }] },
                { label: 'EGT', value: T(v.egt), unit: tU(), decimals: 0, zones: [{ from: T(950), to: 999, color: 'crit' }] },
                { label: 'Gearbox oil', value: T(v.gearbox), unit: tU(), decimals: 0, zones: [{ from: T(120), to: 999, color: 'warn' }] },
                { label: 'Fuel temp', value: T(v.fuelTemp), unit: tU(), decimals: 0, sub: num(v.fuelTemp) ? undefined : fuelWhy('fuelTemp') },
                { label: 'Radiator', value: T(v.radTemp), unit: tU(), decimals: 0, sub: num(v.radTemp) ? undefined : fuelWhy('radTemp') },
            ]);
        }

        function drawElec(cv, t, dd) {
            drawTiles(cv, t, [
                { label: 'Voltage', value: v.voltage, unit: 'V', decimals: 1, zones: [{ from: -99, to: 12, color: 'warn' }, { from: 15.5, to: 99, color: 'warn' }] },
                { label: 'Alt load', value: alternatorLoadPct(), unit: '%', decimals: 0, sub: num(alternatorLoadPct()) ? 'alternator output' : fuelWhy('aluIst') },
                { label: 'Output', value: alternatorOutputA(), unit: 'A', decimals: 0, sub: num(alternatorOutputA()) ? 'generator current' : fuelWhy('aluIst') },
                { label: 'Batt temp', value: T(v.aluTemp), unit: tU(), decimals: 0, sub: num(v.aluTemp) ? 'battery (IBS)' : fuelWhy('aluTemp') },
            ]);
        }

        function drawTcase(cv, t, dd) {
            const ft = num(v.tcase) ? v.tcase : null;
            const lk = lockupPct();
            const th = Math.round((G.BOTTOM - G.TOP) * 0.34);
            const w2 = Math.round((1552 - 24) / 2);
            G.stat(cv, t, 24, G.TOP, w2, th, { label: 'Lockup', value: lk, unit: '%', decimals: 0, center: true, sub: num(lk) ? 'front-axle torque share' : fuelWhy('lockup') });
            G.stat(cv, t, 24 + w2 + 24, G.TOP, w2, th, { label: 'Front axle torque', value: ft, unit: 'Nm', decimals: 0, center: true, sub: num(ft) ? 'transfer case (LMV)' : fuelWhy('tcase') });
            // bottom: lockup % over time, same placement as the power chart (2/3 width, centered)
            const y = G.TOP + th + 16, h = G.BOTTOM - y;
            const now = Date.now(), t0 = now - 30000;
            const hs = tcHist.filter((p) => p.t >= t0);
            const cw = Math.round(1552 * 0.66), cx = 24 + Math.round((1552 - cw) / 2);
            G.chart(cv, t, cx, y, cw, h, {
                xMin: t0, xMax: now, yMin: 0, yMax: 100, yStep: 20,
                xStep: 10000, xFmt: (xx) => Math.round((xx - now) / 1000) + 's',
                yUnit: '%', yFmt: (yy) => String(Math.round(yy)),
                series: [{ pts: hs.map((p) => [p.t, p.pct]), color: 'accent', width: 2.5, fill: 0.14 }],
                empty: 'no lockup data — drive the car',
            });
        }

        /* ---------------- LAP ---------------- */
        function lapStep(dd) {
            const s = num(dd.speed) ? dd.speed : null;
            if (num(s)) lapEma = lapEma === null ? s : lapEma + (s - lapEma) * 0.5;
            lap.curSpeed = lapEma;
            if (lap.state === 'armed' && num(lapEma) && lapEma >= 3) {
                lap.state = 'running'; lap.startedAt = Date.now();
                lap.crossed = {}; lap.t100_200 = null; lap.maxes = {}; lapEma = null;
                log.info('lap started');
            }
            if (lap.state !== 'running') return;
            const el = (Date.now() - lap.startedAt) / 1000;
            const cur = num(lapEma) ? lapEma : 0;
            for (const tgt of LAP_TARGETS) if (!num(lap.crossed[tgt]) && cur >= tgt) { lap.crossed[tgt] = el; log.info('lap: 0-' + tgt + ' in ' + el.toFixed(2) + ' s'); }
            if (num(lap.crossed[100]) && num(lap.crossed[200])) lap.t100_200 = lap.crossed[200] - lap.crossed[100];
            const vals = { boost: boostBar(), fuelPres: fuelPresAct(), iat: num(v.iat) ? v.iat : null, egt: num(v.egt) ? v.egt : null, speed: num(dd.speed) ? dd.speed : null };
            for (const key of LAP_METRICS) { const val = vals[key]; if (num(val) && (!num(lap.maxes[key]) || val > lap.maxes[key])) lap.maxes[key] = val; }
        }
        function lapToggle() {
            if (lap.state === 'running') { lap.state = 'done'; log.info('lap stopped'); return; }
            if (lap.state === 'armed') { lap.state = 'idle'; lapEma = null; log.info('lap disarmed'); return; }
            // idle / done -> arm (results cleared, starts on the next movement)
            lap.state = 'armed'; lap.crossed = {}; lap.t100_200 = null; lap.maxes = {}; lapEma = null; lap.startedAt = 0;
            log.info('lap armed (starts when the car moves)');
        }
        function drawLap(cv, t, dd) {
            const sp = num(dd.speed) ? dd.speed : null;
            const running = lap.state === 'running';
            const el = running ? (Date.now() - lap.startedAt) / 1000 : (lap.state === 'done' && lap.startedAt ? (Date.now() - lap.startedAt) / 1000 : 0);
            // big speed
            const speedY = G.TOP + 60;
            cv.text(sp !== null ? String(Math.round(sp)) : '--', 800, speedY, 120, running ? t.accent : t.text, { align: 'center', font: 'num' });
            cv.text(sU(), 800, speedY + 40, 30, t.dim, { align: 'center' });
            // times (right)
            const rx = 1000;
            const lt = (tgt) => num(lap.crossed[tgt]) ? lap.crossed[tgt].toFixed(2) : (running ? el.toFixed(2) : '0.00');
            const rows = [
                ['0-100 km/h', lt(100), num(lap.crossed[100])],
                ['0-200 km/h', lt(200), num(lap.crossed[200])],
                ['100-200 km/h', num(lap.t100_200) ? lap.t100_200.toFixed(2) : (running && num(lap.crossed[100]) ? (el - lap.crossed[100]).toFixed(2) : '0.00'), num(lap.t100_200)],
            ];
            let ry = G.TOP + 30;
            rows.forEach(([label, txt, got]) => {
                cv.text(label, rx, ry, 22, t.dim, { font: 'bold' });
                cv.text(txt + ' s', rx, ry + 30, 40, got ? t.accent : t.text, { font: 'num' });
                ry += 92;
            });
            // live metrics (left)
            let ly = G.TOP + 30;
            const live = { boost: boostBar(), fuelPres: fuelPresAct(), iat: num(v.iat) ? v.iat : null, egt: num(v.egt) ? v.egt : null, speed: sp };
            LAP_METRICS.forEach((key) => {
                const showMax = lap.state === 'done' && num(lap.maxes[key]);
                const val = showMax ? lap.maxes[key] : live[key];
                cv.text((showMax ? 'MAX ' : '') + key.toUpperCase(), 40, ly, 22, t.dim, { font: 'bold' });
                cv.text(num(val) ? val.toFixed(key === 'boost' ? 2 : 0) : '--', 40, ly + 30, 40, showMax ? t.accent : (num(val) ? t.text : t.dim), { font: 'num' });
                ly += 92;
            });
            // arm / stop button
            const btnW = 260, btnH = 64, bx = 800 - btnW / 2, by = G.BOTTOM - btnH - 20;
            lap.btnRect = [bx, by, btnW, btnH];
            const btnLabel = running ? 'STOP' : lap.state === 'armed' ? 'CANCEL' : lap.state === 'done' ? 'RESET' : 'ARM';
            const btnCol = running ? t.crit : lap.state === 'armed' ? '#e8a020' : '#1aa05a';
            cv.roundRect(bx, by, btnW, btnH, 14, btnCol);
            cv.text(btnLabel, bx + btnW / 2, by + btnH / 2 + 9, 28, '#ffffff', { align: 'center', font: 'bold' });
            const status = running ? 'REC ' + el.toFixed(1) + ' s'
                : lap.state === 'done' ? 'run complete'
                : lap.state === 'armed' ? 'armed — will start when the car moves'
                : 'press ARM, then drive off';
            cv.text(status, bx + btnW / 2, by - 18, 20, t.dim, { align: 'center' });
        }

        /* ---------------- MORE (boost gauge + logging) ---------------- */
        function drawMore(cv, t, dd) {
            // radial boost gauge
            const area = G.BOTTOM - G.TOP;
            const cx = 800, cy = G.TOP + area * 0.56;
            const R = Math.min(Math.round(area * 0.34), 200);
            const maxB = 2.5;
            G.radial(cv, t, cx, cy, R, {
                label: 'Boost', unit: 'bar', decimals: 2, min: 0, max: maxB, ticks: 10, majorEvery: 2, tickDiv: 1, tickDecimals: 1,
                value: boostBar(), peak: boostPeak.peak, color: 'accent',
                zones: [{ from: maxB * 0.85, to: maxB, color: 'crit' }], limit: maxB * 0.85,
            });
            // REC button
            const btnW = 240, btnH = 60, bx = 40, by = G.BOTTOM - btnH - 20;
            logState.btnRect = [bx, by, btnW, btnH];
            cv.roundRect(bx, by, btnW, btnH, 12, logState.active ? t.crit : '#1aa05a');
            cv.text(logState.active ? 'STOP' : 'REC', bx + btnW / 2, by + btnH / 2 + 8, 26, '#ffffff', { align: 'center', font: 'bold' });
            cv.text('rows: ' + logState.rows + '  →  vmgauge_log.csv', bx, by + btnH + 24, 20, t.dim);
        }

        /* ---------------- CSV logging ---------------- */
        function loggingStep(dd) {
            if (!logState.active) return;
            const now = Date.now();
            if (now - logState.lastRowAt < 500) return;
            logState.lastRowAt = now;
            const dt = new Date();
            const pad2 = (n) => (n < 10 ? '0' : '') + n;
            const iso = dt.getFullYear() + '-' + pad2(dt.getMonth() + 1) + '-' + pad2(dt.getDate()) + ' ' + pad2(dt.getHours()) + ':' + pad2(dt.getMinutes()) + ':' + pad2(dt.getSeconds());
            const line = [iso, num(dd.rpm) ? Math.round(dd.rpm) : '', num(dd.speed) ? Math.round(dd.speed) : '', num(boostBar()) ? boostBar().toFixed(2) : '',
                num(oilPress()) ? oilPress().toFixed(1) : '', num(currentLambda()) ? currentLambda().toFixed(2) : '', num(dd.oil) ? Math.round(dd.oil) : '',
                num(dd.coolant) ? Math.round(dd.coolant) : '', num(v.egt) ? Math.round(v.egt) : '', num(v.iat) ? Math.round(v.iat) : '',
                num(fuelPresAct()) ? fuelPresAct().toFixed(1) : '', num(v.ignAdv) ? v.ignAdv.toFixed(1) : '', num(v.knockRetard) ? v.knockRetard.toFixed(1) : '',
                num(v.voltage) ? v.voltage.toFixed(1) : '', num(alternatorLoadPct()) ? Math.round(alternatorLoadPct()) : '', num(v.tcase) ? Math.round(v.tcase) : '',
                counters.knock].join(',');
            try {
                const f = path.join(ctx.dataDir, 'vmgauge_log.csv');
                const head = 't_iso,rpm,speed,boost,oil_press,lambda,oil_temp,coolant,egt,iat,rail_act,ign_adv,knock_ret,voltage,alt_load,tc_front,knock_ev\n';
                if (!fs.existsSync(f)) fs.writeFileSync(f, head);
                fs.appendFileSync(f, line + '\n');
                logState.rows++;
            } catch (e) { log.warn('log write: ' + e); }
        }

        /* ---------------- render ---------------- */
        let lastDd = null;
        async function render() {
            const t = ctx.theme();
            const dd = d();
            lastDd = dd;
            v.rpm = dd.rpm; v.coolant = dd.coolant; v.oilTemp = dd.oil; v.speed = dd.speed;
            computePower(dd);
            handleKnock();
            lapStep(dd);
            boostGaugeStep();
            loggingStep(dd);
            // lockup % history for the TCASE chart
            {
                const nowL = Date.now(), lk = lockupPct();
                if (num(lk) && nowL - tcPush.last > 200) {
                    tcPush.last = nowL;
                    tcHist.push({ t: nowL, pct: lk });
                    const cut = nowL - 30000;
                    while (tcHist.length && tcHist[0].t < cut) tcHist.shift();
                    if (tcHist.length > 600) tcHist.splice(0, tcHist.length - 600);
                }
            }
            // ignition angle + rpm history for the IGN chart
            {
                const now = Date.now();
                if (now - ignPush.last > 200 && (num(v.ignAdv) || num(dd.rpm))) {
                    ignPush.last = now;
                    ignHist.push({ t: now, ign: num(v.ignAdv) ? v.ignAdv : 0, rpm: num(dd.rpm) ? dd.rpm : 0 });
                    const cutoff = now - 30000;
                    while (ignHist.length && ignHist[0].t < cutoff) ignHist.shift();
                    if (ignHist.length > 600) ignHist.splice(0, ignHist.length - 600);
                }
            }
            const cv = ctx.canvas(W, H).clear(t.bg);
            switch (gTab) {
                case 'main': drawMain(cv, t, dd); break;
                case 'power': drawPower(cv, t, dd); break;
                case 'hpfp': drawHpfp(cv, t, dd); break;
                case 'ign': drawIgn(cv, t, dd); break;
                case 'fuelcool': drawFuelCool(cv, t, dd); break;
                case 'elec': drawElec(cv, t, dd); break;
                case 'tcase': drawTcase(cv, t, dd); break;
                case 'lap': drawLap(cv, t, dd); break;
                case 'more': drawMore(cv, t, dd); break;
            }
            header(cv, t);
            await ui.image('MAIN_GFX', cv);
        }
        ctx.loop('MAIN', 10, render);

        ctx.onTab((i) => { if (i >= 0 && i < TABS.length) gTab = TABS[i].id; });
        const inRect = (r, x, y) => r && x >= r[0] && x <= r[0] + r[2] && y >= r[1] && y <= r[1] + r[3];
        let lastBtnTap = 0;
        ctx.onTap((x, y) => {
            if (gTab === 'lap' && inRect(lap.btnRect, x, y)) {
                const now = Date.now();
                if (now - lastBtnTap < 300) return;   // ignore repeated taps from a held finger
                lastBtnTap = now;
                lapToggle();
                return;
            }
            if (gTab === 'more' && inRect(logState.btnRect, x, y)) {
                const now = Date.now();
                if (now - lastBtnTap < 300) return;
                lastBtnTap = now;
                logState.active = !logState.active;
                logState.rows = 0;
                log.info(logState.active ? 'logging on' : 'logging off');
            }
        });

        render().then(() => log.info('first frame done')).catch((e) => log.warn('first render: ' + e));
    },
});
