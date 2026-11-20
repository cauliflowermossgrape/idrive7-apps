'use strict';
const Car = require('./kit/car');
const { DidReader } = require('./kit/dids');
const M = require('./model');

const FES = 'de.bmw.infotainment.drivingexcitement.FES';
const BDS = 'de.bmw.infrastructure.analytics.BasicDataSet';
const DID_FRESH_MS = 10000;
const BARO_MS = 60000;
const FAILS = 3, RETRY_MS = 30000;
// a poll holds the shared link for one short request: no busy retries, a short timeout
const POLL = { timeoutMs: 1500, diagOpts: { maxRetries: 0 } };

const num = (x) => (typeof x === 'number' && isFinite(x) ? x : null);
const first = (a, b) => (a !== null ? a : b);

// Cars without the sport display or the data set's gearbox value send a constant placeholder: a value counts
// once it has moved from the first one seen.
function moving(step) {
    return {
        start: null, moved: false, v: null,
        put(x) {
            if (x === null) return;
            if (this.start === null) this.start = x;
            else if (Math.abs(x - this.start) >= step) this.moved = true;
            this.v = x;
        },
        value() { return this.moved ? this.v : null; },
    };
}

function boostOf(v) {
    const raw = v && v.displayBoostPressure;
    return typeof raw === 'number' && raw >= 0 && raw !== 255 ? raw * 0.01 : null;
}

function gearboxOf(v) {
    const raw = v && v.valueTemperatureTransmissionOil;
    if (typeof raw !== 'number' || raw === 0 || raw === 255) return null;
    return raw - 48 >= -40 && raw - 48 <= 160 ? raw - 48 : null;
}

class Telemetry {
    constructor(ctx) {
        const dme = (ctx.spec.config && ctx.spec.config.dme) || {};
        this.settings = ctx.settings;
        this.ecu = dme.ecu;
        this.cands = {};
        ['iat', 'boost', 'baro', 'egs'].forEach((k) => { this.cands[k] = (dme[k] || []).map((c) => Object.assign({}, POLL, c)); });
        this.fes = moving(0.03);
        this.bds = moving(1);
        this.polled = {};
        this.fails = {};
        this.tried = {};
        this.baro = null;
        this.baroAt = 0;
        this.rpmAt = 0;
        this.reader = null;
        this.switched = [];
        const extra = {};
        extra[FES] = { statusSwitchDriveDynamicSport2: (v) => this.fes.put(boostOf(v)) };
        extra[BDS] = { basicDataSet: (v) => this.bds.put(gearboxOf(v)) };
        this.car = new Car(ctx, ['rpm', 'temps'], extra);
        // Car.lastCar moves with the temperatures too: the engine speed keeps its own time
        this.car.onSample((d) => { if (!d.demo) this.rpmAt = Date.now(); }, () => {
            this.rpmAt = 0;
            this.switched.forEach((fn) => fn());
        });
    }

    onSwitch(fn) { this.switched.push(fn); }

    demo() { return !!this.car.demoActive || this.settings.get('demo') === 'on'; }

    rpm() {
        if (this.demo()) return null;
        const d = this.car.data();
        return num(d.rpm) !== null && Date.now() - this.rpmAt <= M.RPM_FRESH_MS ? d.rpm : null;
    }

    snapshot() {
        if (this.demo()) return M.DEMO;
        const d = this.car.data(), now = Date.now();
        const fresh = (k) => { const p = this.polled[k]; return p && now - p.t <= DID_FRESH_MS ? p.v : null; };
        return {
            rpm: num(d.rpm), oil: num(d.oil), coolant: num(d.coolant),
            gearbox: first(this.bds.value(), fresh('egs')),
            iat: fresh('iat'),
            boost: first(this.fes.value(), fresh('boost')),
            demo: false,
        };
    }

    async poll(diag) {
        if (!this.reader || this.reader.diag !== diag) this.reader = new DidReader(diag, { ecu: this.ecu });
        await this._keep('iat');
        if (this.bds.value() === null) await this._keep('egs');
        if (this.fes.value() !== null) return;
        if (this.baro === null || Date.now() - this.baroAt > BARO_MS) {
            const b = await this._ask('baro');
            if (b !== null) { this.baro = b; this.baroAt = Date.now(); }
        }
        // an absolute pressure is boost only against the outside air pressure read from the car
        if (this.baro === null) return;
        const abs = await this._ask('boost');
        if (abs !== null) this.polled.boost = { v: (abs - this.baro) / 100, t: Date.now() };
    }

    async _keep(k) {
        const v = await this._ask(k);
        if (v !== null) this.polled[k] = { v, t: Date.now() };
    }

    async _ask(k) {
        const list = this.cands[k];
        if (!list.length || ((this.fails[k] || 0) >= FAILS && Date.now() - this.tried[k] < RETRY_MS)) return null;
        this.tried[k] = Date.now();
        const v = await this.reader.value(k, list);
        this.fails[k] = v === null ? (this.fails[k] || 0) + 1 : 0;
        return v;
    }
}

module.exports = { Telemetry, boostOf, gearboxOf };
