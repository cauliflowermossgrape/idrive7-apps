'use strict';
/**
 * Part of Redline's experimental features; README.md in this folder has the whole picture.
 *
 * The electrical readouts on the HUD, read from the car itself, the way eDrive reads them
 * (apps/edrive/app.json config.battery, main.js, battery12.js, live.js):
 *
 *   every car
 *     12 V charge    CDS.statusBattery2.conditionBatteryChargingCondition (%), sent by the car
 *     12 V voltage   UDS 22 F442 (OBD "control module voltage") from the engine unit (0x12), OBD 01 42,
 *                    a second engine unit (0x13), the gearbox unit (0x18), the battery sensor (402B, 5853);
 *                    the one that answered keeps being asked, as battery12.js does
 *   plug-in hybrids only
 *     HV charge      UDS 22 DDBC from the battery unit (SME, 0x07), 0.1 %
 *     HV power       pack voltage (DDB4 / DD68 / DD66 / DDEF) x current (DD69) from the SME, in kW:
 *                    + the battery drives, - it is charged (regen)
 *     HV temperature Efficiencytainment2.statusBatteryTemperature (raw - 50 °C, 255 = none)
 *     pack voltage   LSCDataSink.statusHighVoltageStorage (V, or 0.1 V above 1500)
 *   (left out: KombiIF's power distribution, whose scale nobody knows yet; eDrive doesn't show it either)
 *
 * Petrol and diesel cars: hybrid() stays false, so nothing hybrid shows anywhere (HUD, HUD looks page,
 * Settings). It turns true, and is kept (setting hudHybridSeen), once the car shows a high-voltage battery:
 * a pack voltage (150-500 V) in its signals, or the SME answering DDBC. A battery temperature alone is not
 * enough (a 48 V mild hybrid, or a petrol car, may send one for another battery). That one read is asked
 * once per start while the HUD shows, and only until it is known; what found it is logged with its raw value.
 *
 * The UDS reads are read-only (UDS 22 / OBD 01) on the gearbox reader's link (one link to the car), only while
 * the HUD shows a readout that needs them, and only once that link is up (a read before then fails at once and
 * would count as the unit not answering). Each waits at most ~1 s for an answer, so a unit that doesn't answer
 * doesn't hold up knock and gearbox reads on the same link; one that doesn't answer three times is asked once
 * a minute. Never throws; value() is { soc12, v12, hvSoc, hvKw, hvTemp, hvVolt } (each a number or null).
 */
const { DidReader } = require('./kit/dids');

const VOLT = { bytes: 2, at: 0, factor: 0.001, offset: 0, min: 5, max: 18 };
// the same candidates, in the same order, as eDrive's config.battery.v12 (test_redline_hud.js checks it)
const V12 = [
    Object.assign({ ecu: 0x12, did: 'F442' }, VOLT),
    Object.assign({ ecu: 0x07, did: 'F442' }, VOLT),
    Object.assign({ ecu: 0x12, obd: '42' }, VOLT),
    Object.assign({ ecu: 0x13, did: 'F442' }, VOLT),
    Object.assign({ ecu: 0x13, obd: '42' }, VOLT),
    Object.assign({ ecu: 0x18, did: 'F442' }, VOLT),
    Object.assign({ ecu: 0x18, obd: '42' }, VOLT),
    { ecu: 0x12, did: '402B', bytes: 2, at: 2, factor: 0.00025, offset: 6, min: 5, max: 18 },
    Object.assign({ ecu: 0x12, did: '5853' }, VOLT),
];
const SME = 0x07;
// every read has its own short wait: the link is shared with knock (twice a second) and the gearbox, and the
// default 4 s per unanswered identifier could hold them up for ~12 s a turn on a hybrid whose SME differs
const HV_SOC = [{ ecu: SME, did: 'DDBC', bytes: 2, at: 0, factor: 0.1, offset: 0, min: 0, max: 100, timeoutMs: 1000 }];
const HV_V = [
    { ecu: SME, did: 'DDB4', bytes: 2, factor: 0.01, min: 150, max: 500, timeoutMs: 600 },
    { ecu: SME, did: 'DD68', bytes: 2, factor: 0.01, min: 150, max: 500, timeoutMs: 800 },
    { ecu: SME, did: 'DD66', bytes: 2, factor: 0.01, min: 150, max: 500, timeoutMs: 800 },
    { ecu: SME, did: 'DDEF', bytes: 2, factor: 1, min: 150, max: 500, timeoutMs: 800 },
];
const HV_A = [{ ecu: SME, did: 'DD69', bytes: 4, factor: 0.01, signed: true, min: -800, max: 800, timeoutMs: 600 }];
const POWER_SIGN = -1;                // eDrive's powerSign: kW = V x A / 1000 x -1 (+ = the battery gives power)
const VOLT_TIMEOUT_MS = 1500, PROBE_TIMEOUT_MS = 1500;
const POLL_MS = 500;                  // HV power; the charge and the 12 V every SLOW_MS
const SLOW_MS = 5000, V12_MS = 2000, FAIL_RETRY_MS = 60000;
const STALE_MS = 3000, SLOW_STALE_MS = 20000, SIGNAL_STALE_MS = 120000, RANK = { ok: 0, new: 1, nrc: 2, bad: 2, none: 3 };

const isNum = (v) => typeof v === 'number' && isFinite(v);
/** every entry holding key, however the list arrives (plain, wrapped in the field's name, single) - as eDrive */
function entries(v, key, out) {
    out = out || [];
    if (v && typeof v === 'object') {
        if (key in v) out.push(v);
        else Object.keys(v).forEach((k) => entries(v[k], key, out));
    }
    return out;
}
const one = (v, key) => { const e = entries(v, key)[0]; return e ? e[key] : undefined; };

/** Raw decoders, exported for the tests: each returns a value or null. */
const decode = {
    soc12: (v) => { const c = v && v.conditionBatteryChargingCondition; return isNum(c) && c >= 0 && c <= 100 ? c : null; },
    hvTemp: (v) => {
        const raw = one(v, 'actualValueTemperatureHighVoltageStorage');
        if (!isNum(raw) || raw === 255) return null;
        const t = raw - 50;
        return t > -30 && t < 70 ? t : null;
    },
    hvVolt: (v) => {
        const x = one(v, 'actualValueVoltageHighVoltageStorage');
        if (!isNum(x)) return null;
        const volts = x > 1500 ? x / 10 : x;           // 0.1 V on the X5 45e
        return volts > 150 && volts < 500 ? volts : null;
    },
    /** the raw field, for the log line that says what found the battery */
    rawVolt: (v) => one(v, 'actualValueVoltageHighVoltageStorage'),
    hvKw: (volts, amps) => (isNum(volts) && isNum(amps) ? volts * amps / 1000 * POWER_SIGN : null),
};

class Electrical {
    /**
     * linkOf: () => a ReadOnlyDiag (the gearbox reader's, shared); settings (hudHybridSeen is kept there).
     */
    constructor(ctx, linkOf) {
        this.ctx = ctx; this.log = ctx.log; this.linkOf = linkOf; this.settings = ctx.settings;
        this.rd = null; this.timer = null; this.busy = false; this.want = {};
        this.s = {};                  // name -> { v, t } from the signals and the reads
        this.fails = { hv: 0, v12: 0 }; this.tried = { hv: 0, v12: 0 }; this.slowT = 0; this.v12T = 0;
        this.vs = { pick: null, miss: 0, res: {} };
        this.probed = false;
    }

    /** true once this car has shown a high-voltage battery (kept across restarts). */
    hybrid() { return !!(this.settings && this.settings.get('hudHybridSeen')); }

    _seen(why) {
        if (this.hybrid() || !this.settings) return;
        this.settings.set('hudHybridSeen', true);
        this.log.info('electrical: high-voltage battery found (' + why + '): hybrid readouts offered');
    }

    _put(name, v) { if (v !== null && v !== undefined) this.s[name] = { v: v, t: Date.now() }; }

    /** Signal handlers for Car's extra watches (each field on its interface's one watch). */
    handlers() {
        const guard = (fn) => (v) => { try { fn(v); } catch (e) { /* never throw from a signal */ } };
        return {
            'de.bmw.infotainment.vehicle.CDS': {
                statusBattery2: guard((v) => this._put('soc12', decode.soc12(v))),
            },
            // kept, but shown only once the car is known to be a hybrid (value()): never proof of one by itself
            'de.bmw.infotainment.drivingexcitement.Efficiencytainment2': {
                statusBatteryTemperature: guard((v) => this._put('hvTemp', decode.hvTemp(v))),
            },
            'de.bmw.infotainment.lsc.LSCDataSink': {
                statusHighVoltageStorage: guard((v) => {
                    const x = decode.hvVolt(v);
                    if (x !== null) { this._put('hvVolt', x); this._seen('pack voltage signal, raw ' + JSON.stringify(decode.rawVolt(v))); }
                }),
            },
        };
    }

    /**
     * Read what the HUD shows: want = { hv (HV charge or power), v12 (the 12 V voltage) }. Not yet known to be a
     * hybrid: the SME is asked once (DDBC), so the hybrid readouts can be offered; never on a known petrol car again.
     */
    start(want) {
        this.want = want || {};
        const any = this.want.v12 || (this.want.hv && this.hybrid()) || (!this.hybrid() && !this.probed);
        if (!any) return this.stop();
        if (this.timer) return;
        try {
            if (!this.rd) this.rd = new DidReader(this.linkOf(), { ecu: SME });
            this.timer = setInterval(() => this._poll(), POLL_MS);
            this._poll();
        } catch (e) { this.log.warn('electrical: ' + (e && e.message || e)); }
    }

    stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

    _poll() {
        if (this.busy || !this.rd) return;
        this.busy = true;
        Promise.resolve().then(() => this._turn()).catch((e) => this.log.warn('electrical: ' + (e && e.message || e)))
            .then(() => { this.busy = false; });
    }

    /** One turn: the probe (once), HV power (each turn), HV charge (every SLOW_MS), 12 V (every V12_MS). */
    async _turn() {
        const now = Date.now();
        // the link is made on the HUD's first tick and comes up a moment later: until then every read fails at
        // once, which would use up the one look for a hybrid battery and start the minute-long back-off
        const link = this.rd.diag;
        if (link && link.ready === false) return;
        if (!this.hybrid() && !this.probed) {
            this.probed = true;
            const v = await this.rd.read(Object.assign({}, HV_SOC[0], { timeoutMs: PROBE_TIMEOUT_MS }));
            if (v !== null) { this._put('hvSoc', v); this._seen('battery unit DDBC, ' + ((this.rd.raws[this.rd.key(HV_SOC[0])] || {}).bytes || '')); }
            else this.log.info('electrical: no high-voltage battery unit (' + ((this.rd.raws[this.rd.key(HV_SOC[0])] || {}).why || '?') + ')');
            if (!this.want.v12 && !(this.want.hv && this.hybrid())) this.stop();
            return;
        }
        if (this.want.hv && this.hybrid() && this._may('hv', now)) {
            const volts = await this.rd.value('hvV', HV_V);
            const amps = volts === null ? null : await this.rd.value('hvA', HV_A);
            const kw = decode.hvKw(volts, amps);
            if (kw !== null) { this._put('hvKw', kw); this._put('hvVolt', volts); }
            if (now - this.slowT >= SLOW_MS) {
                this.slowT = now;
                this._put('hvSoc', await this.rd.value('hvSoc', HV_SOC));
            }
            this._result('hv', kw !== null || (this.s.hvSoc && this.s.hvSoc.t >= now), 'the battery unit (SME 0x07) gives no power or charge');
        }
        if (this.want.v12 && now - this.v12T >= V12_MS && this._may('v12', now)) {
            this.v12T = now;
            const v = await this._volt();
            this._put('v12', v);
            this._result('v12', v !== null, 'no unit gives the 12 V voltage (F442 / OBD 42)');
        }
    }

    _may(k, now) { return this.fails[k] < 3 || now - this.tried[k] >= FAIL_RETRY_MS; }
    _result(k, ok, why) {
        this.tried[k] = Date.now();
        if (ok) { this.fails[k] = 0; return; }
        if (++this.fails[k] === 3) this.log.info('electrical: ' + why + '; asked once a minute');
    }

    /** The 12 V voltage: the candidate that answered keeps being asked (two misses before a search), as battery12.js. */
    async _volt() {
        const list = V12.map((c) => Object.assign({ timeoutMs: VOLT_TIMEOUT_MS }, c)), vs = this.vs, rd = this.rd;
        const ask = async (i) => {
            const v = await rd.read(list[i]);
            const why = (rd.raws[rd.key(list[i])] || {}).why || '';
            vs.res[i] = v !== null ? 'ok' : /^NRC/.test(why) ? 'nrc' : /no reply/.test(why) ? 'none' : 'bad';
            return v;
        };
        const p = vs.pick;
        if (p !== null) {
            const v = await ask(p);
            if (v !== null) { vs.miss = 0; return v; }
            if (++vs.miss < 2) return null;
        }
        const order = list.map((c, i) => i).filter((i) => i !== p).sort((a, b) => RANK[vs.res[a] || 'new'] - RANK[vs.res[b] || 'new'] || a - b);
        if (p !== null) order.push(p);
        for (let k = 0; k < order.length; k++) {
            const v = await ask(order[k]);
            if (v !== null) {
                if (vs.pick !== order[k]) this.log.info('electrical: 12 V from ' + rd.key(list[order[k]]));
                vs.pick = order[k]; vs.miss = 0;
                return v;
            }
        }
        return null;
    }

    /** What the HUD shows; the hybrid values only on a hybrid. */
    value() {
        const now = Date.now(), hy = this.hybrid();
        const get = (k, ms) => (this.s[k] && now - this.s[k].t < ms ? this.s[k].v : null);
        return {
            soc12: get('soc12', SIGNAL_STALE_MS), v12: get('v12', V12_MS * 4),
            hvSoc: hy ? get('hvSoc', SLOW_STALE_MS) : null, hvKw: hy ? get('hvKw', STALE_MS) : null,
            hvTemp: hy ? get('hvTemp', SIGNAL_STALE_MS) : null, hvVolt: hy ? get('hvVolt', SLOW_STALE_MS) : null,
        };
    }
}

Electrical.V12 = V12; Electrical.HV_SOC = HV_SOC; Electrical.HV_V = HV_V; Electrical.HV_A = HV_A;
Electrical.decode = decode;
module.exports = Electrical;
